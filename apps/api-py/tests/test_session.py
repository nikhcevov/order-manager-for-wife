"""Step 1 contract: health and Telegram-authenticated sessions."""

from __future__ import annotations

import hashlib
import time
from urllib.parse import urlencode

from .helpers import ALICE, SELLER, Env, signed_init_data


async def test_health_is_public_and_hardened(env: Env) -> None:
    response = await env.client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["cache-control"] == "no-store"


async def test_unknown_api_route_returns_the_json_error_contract(env: Env) -> None:
    response = await env.client.get("/api/nope")
    assert response.status_code == 404
    assert response.json() == {"error": "not_found", "message": "Endpoint not found"}


async def test_signed_launch_creates_session_and_stores_only_a_hash(env: Env) -> None:
    response = await env.client.post("/api/session", json={"initData": signed_init_data(ALICE)})
    assert response.status_code == 200
    body = response.json()
    assert body["user"] == {
        "id": "2001",
        "first_name": "Alice",
        "username": "alice",
        "isSeller": False,
    }
    assert body["currency"] == "USD"
    assert body["paymentInstructions"] == "Transfer externally; include the order reference."
    assert body["holdMinutes"] == 30
    token = body["token"]
    assert len(token) == 43

    stored = await env.pool.fetchrow("SELECT token_hash,user_id FROM sessions")
    assert stored["user_id"] == "2001"
    assert stored["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert stored["token_hash"] != token


async def test_seller_id_grants_the_seller_flag(env: Env) -> None:
    response = await env.client.post("/api/session", json={"initData": signed_init_data(SELLER)})
    assert response.status_code == 200
    assert response.json()["user"]["isSeller"] is True


async def test_relaunch_updates_the_customer_instead_of_duplicating_it(env: Env) -> None:
    first = await env.client.post("/api/session", json={"initData": signed_init_data(ALICE)})
    renamed = {**ALICE, "first_name": "Alice Cooper"}
    second = await env.client.post("/api/session", json={"initData": signed_init_data(renamed)})
    assert first.status_code == second.status_code == 200
    assert await env.pool.fetchval("SELECT count(*) FROM customers") == 1
    assert await env.pool.fetchval("SELECT first_name FROM customers WHERE id='2001'") == "Alice Cooper"
    assert await env.pool.fetchval("SELECT count(*) FROM sessions") == 2


async def test_forged_signature_is_rejected_without_creating_anything(env: Env) -> None:
    # Build the launch and replace only the hash value.
    launch = dict(pair.split("=", 1) for pair in signed_init_data(ALICE).split("&"))
    launch["hash"] = "0" * 64
    response = await env.client.post(
        "/api/session", json={"initData": urlencode(launch)}
    )
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_launch"
    assert await env.pool.fetchval("SELECT count(*) FROM sessions") == 0
    assert await env.pool.fetchval("SELECT count(*) FROM customers") == 0


async def test_stale_and_future_launches_are_rejected(env: Env) -> None:
    now = int(time.time())
    for auth_date in (now - 3601, now + 60):
        response = await env.client.post(
            "/api/session", json={"initData": signed_init_data(ALICE, auth_date=auth_date)}
        )
        assert response.status_code == 401
        assert response.json()["error"] == "invalid_launch"


async def test_launch_signed_with_another_bot_token_is_rejected(env: Env) -> None:
    other = "654321:another_bot_token_abcdefghijklmnopqrstuvwxyz"
    response = await env.client.post("/api/session", json={"initData": signed_init_data(ALICE, token=other)})
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_launch"


async def test_duplicate_fields_and_extra_body_fields_are_rejected(env: Env) -> None:
    launch = signed_init_data(ALICE)
    duplicated = await env.client.post(
        "/api/session", json={"initData": f"{launch}&auth_date=1"}
    )
    assert duplicated.status_code == 401
    assert duplicated.json()["error"] == "invalid_launch"

    extra = await env.client.post(
        "/api/session", json={"initData": signed_init_data(ALICE), "admin": True}
    )
    assert extra.status_code == 400
    assert extra.json()["error"] == "invalid_input"
