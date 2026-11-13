"""Fixtures shared by the tests: Telegram-signed launches and demo users."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import asyncpg
import httpx

from shop.config import Settings


@dataclass(slots=True)
class Env:
    client: httpx.AsyncClient
    pool: asyncpg.Pool
    config: Settings


BOT_TOKEN = "123456:isolated_test_bot_token_abcdefghijklmnopqrstuvwxyz"
SELLER = {"id": 1001, "first_name": "Seller", "username": "shop_seller"}
ALICE = {"id": 2001, "first_name": "Alice", "username": "alice"}
BOB = {"id": 2002, "first_name": "Bob", "username": "bob"}


def signed_init_data(
    user: dict[str, object] = ALICE,
    *,
    auth_date: int | None = None,
    token: str = BOT_TOKEN,
) -> str:
    """Telegram's real two-stage HMAC, usable without an authentication bypass."""
    fields = {
        "auth_date": str(int(time.time()) if auth_date is None else auth_date),
        "query_id": "isolated-test-launch",
        "user": json.dumps(user, separators=(",", ":")),
    }
    check_string = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)
