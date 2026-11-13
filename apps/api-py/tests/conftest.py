"""Per-test private schema, migrated and wired to the ASGI app."""

from __future__ import annotations

import os
import secrets
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
import httpx
import pytest

from shop.app import create_app
from shop.config import Settings
from shop.db import migrate

from .helpers import BOT_TOKEN, Env


@pytest.fixture
async def env(tmp_path: Path) -> AsyncIterator[Env]:
    url = os.environ.get("TEST_DATABASE_URL")
    assert url, "TEST_DATABASE_URL must point to a caller-supplied PostgreSQL test database"

    admin = await asyncpg.connect(url)
    schema = f"test_{secrets.token_hex(8)}"
    await admin.execute(f'CREATE SCHEMA "{schema}"')
    pool = await asyncpg.create_pool(url, min_size=1, max_size=4, server_settings={"search_path": schema})
    try:
        await migrate(pool)
        config = Settings(
            database_url=url,
            bot_token=BOT_TOKEN,
            seller_ids="1001",
            shop_currency="USD",
            payment_instructions="Transfer externally; include the order reference.",
            public_origin="https://shop.example.test",
            media_dir=tmp_path,
            hold_minutes=30,
            port=3000,
            host="127.0.0.1",
        )
        app = create_app(pool, config)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            yield Env(client=client, pool=pool, config=config)
    finally:
        await pool.close()
        await admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        await admin.close()
