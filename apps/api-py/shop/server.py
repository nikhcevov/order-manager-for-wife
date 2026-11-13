"""Process entrypoint: config, migrations, HTTP server, graceful shutdown."""

from __future__ import annotations

import asyncio

import uvicorn

from .app import create_app
from .config import Settings
from .db import create_pool, migrate


async def run() -> None:
    config = Settings()
    pool = await create_pool(config.database_url)
    try:
        await migrate(pool)
        app = create_app(pool, config)
        server = uvicorn.Server(
            uvicorn.Config(app, host=config.host, port=config.port, log_level="info")
        )
        await server.serve()
    finally:
        await pool.close()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
