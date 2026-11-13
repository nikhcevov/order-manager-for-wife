"""Runtime configuration: read once, validate strictly, fail startup on mistakes."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]
DATABASE_URL = re.compile(r"^postgres(ql)?://")
BOT_TOKEN = re.compile(r"^\d+:[A-Za-z0-9_-]{20,}$")
SELLER_IDS = re.compile(r"^\d+(,\d+)*$")
CURRENCY = re.compile(r"^[A-Z]{3}$")


class Settings(BaseSettings):
    # Environment variables win over .env; explicit constructor arguments win over both.
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    database_url: str
    bot_token: str = Field(pattern=BOT_TOKEN.pattern)
    seller_ids: str = Field(pattern=SELLER_IDS.pattern)
    shop_currency: str = Field(pattern=CURRENCY.pattern)
    payment_instructions: str
    public_origin: str
    media_dir: Path
    hold_minutes: int = Field(default=30, ge=1, le=1440)
    port: int = Field(default=3000, ge=1, le=65535)
    host: str = "127.0.0.1"

    @field_validator("database_url")
    @classmethod
    def _postgres_url(cls, value: str) -> str:
        if not DATABASE_URL.match(value):
            raise ValueError("Use a PostgreSQL URL")
        return value

    @field_validator("payment_instructions")
    @classmethod
    def _instructions(cls, value: str) -> str:
        value = value.strip()
        if not 1 <= len(value) <= 4000:
            raise ValueError("Use 1 to 4000 characters of payment instructions")
        return value

    @field_validator("public_origin")
    @classmethod
    def _origin(cls, value: str) -> str:
        url = urlsplit(value)
        if url.path not in ("", "/") or url.query or url.fragment:
            raise ValueError("Use an origin without a path, query, or fragment")
        local = url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1"}
        if url.scheme != "https" and not local:
            raise ValueError("Use HTTPS, or localhost HTTP for development")
        return value

    @field_validator("media_dir")
    @classmethod
    def _media_dir(cls, value: Path) -> Path:
        return value.expanduser().resolve()

    @property
    def seller_id_set(self) -> frozenset[str]:
        return frozenset(self.seller_ids.split(","))

    @property
    def origin(self) -> str:
        url = urlsplit(self.public_origin)
        return f"{url.scheme}://{url.netloc}"
