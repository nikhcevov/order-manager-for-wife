"""Telegram Mini App launch verification and opaque bearer sessions."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time
from urllib.parse import parse_qsl

import asyncpg
from fastapi import FastAPI, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import Settings
from .db import transaction
from .http import ApiError, User

MAX_TELEGRAM_ID = 9_007_199_254_740_991
BEARER = re.compile(r"Bearer ([A-Za-z0-9_-]{43})")
HEX_SHA256 = re.compile(r"[a-fA-F0-9]{64}")
DIGITS = re.compile(r"\d+")


class Launch(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    init_data: str = Field(alias="initData", min_length=1, max_length=16384)


class TelegramUser(BaseModel):
    id: int = Field(gt=0, le=MAX_TELEGRAM_ID)
    first_name: str = Field(min_length=1, max_length=256)
    username: str | None = Field(default=None, min_length=1, max_length=64)
    is_bot: bool = False


def invalid_launch() -> ApiError:
    return ApiError(401, "invalid_launch", "Open the shop again from Telegram to sign in.")


def validate_launch(init_data: str, config: Settings) -> User:
    """Verify Telegram's two-stage HMAC and return the authenticated customer."""
    fields: dict[str, str] = {}
    for key, value in parse_qsl(init_data, keep_blank_values=True):
        # Duplicate keys would make the signed check string ambiguous.
        if not key or key in fields or any(ch in key for ch in "\r\n=") or "\r" in value or "\n" in value:
            raise invalid_launch()
        fields[key] = value

    received_hash = fields.get("hash")
    auth_date = fields.get("auth_date")
    if not received_hash or not HEX_SHA256.fullmatch(received_hash) or not auth_date or not DIGITS.fullmatch(auth_date):
        raise invalid_launch()

    timestamp = int(auth_date)
    now = int(time.time())
    if timestamp > now or now - timestamp > 3600:
        raise invalid_launch()

    check_string = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()) if key != "hash")
    secret = hmac.new(b"WebAppData", config.bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check_string.encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(expected, bytes.fromhex(received_hash)):
        raise invalid_launch()

    try:
        parsed = TelegramUser.model_validate_json(fields.get("user", "null"))
    except ValidationError:
        raise invalid_launch() from None
    if parsed.is_bot:
        raise invalid_launch()

    user_id = str(parsed.id)
    return User(
        id=user_id,
        first_name=parsed.first_name,
        username=parsed.username,
        is_seller=user_id in config.seller_id_set,
    )


async def authenticate(request: Request) -> User:
    """Resolve the bearer token against a live session, or reject the request."""
    match = BEARER.fullmatch(request.headers.get("authorization", ""))
    if not match:
        raise ApiError(401, "unauthorized", "Open the shop from Telegram to sign in.")

    pool: asyncpg.Pool = request.app.state.pool
    config: Settings = request.app.state.config
    token_hash = hashlib.sha256(match.group(1).encode()).hexdigest()
    row = await pool.fetchrow(
        """SELECT c.id,c.first_name,c.username FROM sessions s
           JOIN customers c ON c.id=s.user_id
           WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()""",
        token_hash,
    )
    if row is None:
        raise ApiError(401, "session_expired", "Your session expired. Reopen the shop in Telegram.")

    user = User(
        id=row["id"],
        first_name=row["first_name"],
        username=row["username"],
        is_seller=row["id"] in config.seller_id_set,
    )
    request.state.user = user
    return user


def register_auth(app: FastAPI, pool: asyncpg.Pool, config: Settings) -> None:
    @app.post("/api/session")
    async def create_session(body: Launch) -> dict[str, object]:
        user = validate_launch(body.init_data, config)
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        async with transaction(pool) as connection:
            await connection.execute(
                """INSERT INTO customers(id,first_name,username) VALUES($1,$2,$3)
                   ON CONFLICT(id) DO UPDATE SET first_name=EXCLUDED.first_name,username=EXCLUDED.username""",
                user.id,
                user.first_name,
                user.username,
            )
            await connection.execute(
                """INSERT INTO sessions(token_hash,user_id,expires_at)
                   VALUES($1,$2,clock_timestamp()+interval '24 hours')""",
                token_hash,
                user.id,
            )
            await connection.execute(
                """DELETE FROM sessions WHERE token_hash IN (
                     SELECT token_hash FROM sessions WHERE expires_at<=clock_timestamp()
                     ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)"""
            )
        return {
            "token": token,
            "user": {
                "id": user.id,
                "first_name": user.first_name,
                "username": user.username,
                "isSeller": user.is_seller,
            },
            "currency": config.shop_currency,
            "paymentInstructions": config.payment_instructions,
            "holdMinutes": config.hold_minutes,
        }
