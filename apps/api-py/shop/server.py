"""Process entrypoint: config, migrations, HTTP server, graceful shutdown."""

from __future__ import annotations

import asyncio
import contextlib
import logging

import uvicorn

from .app import create_app
from .config import Settings
from .db import create_pool, migrate
from .media import cleanup_media
from .orders import expire_orders

logger = logging.getLogger("shop")


async def _housekeeping(pool, config: Settings) -> None:
    while True:
        try:
            await expire_orders(pool)
            await cleanup_media(pool, config)
        except Exception:
            logger.exception("Housekeeping failed")
        await asyncio.sleep(30)


async def run() -> None:
    config = Settings()
    pool = await create_pool(config.database_url)
    try:
        await migrate(pool)
        await expire_orders(pool)
        await cleanup_media(pool, config)
        app = create_app(pool, config)
        server = uvicorn.Server(
            uvicorn.Config(app, host=config.host, port=config.port, log_level="info")
        )
        housekeeping = asyncio.create_task(_housekeeping(pool, config))
        try:
            await server.serve()
        finally:
            housekeeping.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await housekeeping
    finally:
        await pool.close()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
