"""PostgreSQL pool, transactions, and the versioned migration runner."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import asyncpg

# The Node service owns these migrations for now; both runners share the same
# schema_migrations table so either one can start against the same database.
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "api" / "migrations"
MIGRATION_NAME = re.compile(r"^\d+.*\.sql$")


async def init_connection(connection: asyncpg.Connection) -> None:
    # pg returns parsed JSON; asyncpg returns strings unless we install codecs.
    for name in ("json", "jsonb"):
        await connection.set_type_codec(
            name,
            schema="pg_catalog",
            encoder=json.dumps,
            decoder=json.loads,
        )


async def create_pool(database_url: str, **options: object) -> asyncpg.Pool:
    options.setdefault("min_size", 1)
    options.setdefault("max_size", 15)
    options.setdefault("init", init_connection)
    return await asyncpg.create_pool(database_url, **options)


@asynccontextmanager
async def transaction(pool: asyncpg.Pool) -> AsyncIterator[asyncpg.Connection]:
    """One connection, one transaction, rollback on any exception."""
    async with pool.acquire() as connection:
        async with connection.transaction():
            yield connection


async def migrate(pool: asyncpg.Pool, directory: Path = MIGRATIONS_DIR) -> None:
    async with transaction(pool) as connection:
        # Serialize concurrent starts; the lock disappears with the transaction.
        await connection.execute("SELECT pg_advisory_xact_lock(48173620)")
        await connection.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
                 name text PRIMARY KEY,
                 applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
               )"""
        )
        names = sorted(path.name for path in directory.iterdir() if MIGRATION_NAME.match(path.name))
        for name in names:
            applied = await connection.fetchval("SELECT 1 FROM schema_migrations WHERE name=$1", name)
            if applied:
                continue
            await connection.execute((directory / name).read_text(encoding="utf-8"))
            await connection.execute("INSERT INTO schema_migrations(name) VALUES($1)", name)
