"""Static frontend serving and the API 404 boundary."""

from __future__ import annotations

import re

import pytest

from shop.app import WEB_DIST

from .helpers import ALICE, Env, session
from .uploads import bearer

INDEX = WEB_DIST / "index.html"
pytestmark = pytest.mark.skipif(not INDEX.is_file(), reason="apps/web/dist is not built")


async def test_built_frontend_is_served_with_spa_fallback(env: Env) -> None:
    index = INDEX.read_text(encoding="utf-8")
    page = await env.client.get("/")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert 'id="root"' in page.text
    assert page.headers["x-content-type-options"] == "nosniff"

    assets = re.findall(r'(?:src|href)="(/assets/[^"]+)"', index)
    assert any(asset.endswith(".js") for asset in assets)
    for asset in assets:
        response = await env.client.get(asset)
        assert response.status_code == 200, asset
        assert response.content

    deep_link = await env.client.get("/seller/orders")
    assert deep_link.status_code == 200
    assert 'id="root"' in deep_link.text

    alice = await session(env, ALICE)
    missing = await env.client.get("/api/nope", headers=bearer(alice))
    assert missing.status_code == 404
    assert missing.json() == {"error": "not_found", "message": "Endpoint not found"}
