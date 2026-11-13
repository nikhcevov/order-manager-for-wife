"""Shop helpers shared by order and fulfillment tests."""

from __future__ import annotations

import uuid
from typing import Any

from .helpers import Env
from .uploads import bearer, upload


def selection(product_id: str, quantity: int = 1) -> list[dict[str, Any]]:
    return [{"productId": product_id, "quantity": quantity}]


async def published_product(
    env: Env,
    token: str,
    price: int = 100,
    stock: int = 10,
    name: str = "Fixture product",
) -> dict[str, Any]:
    image = (await upload(env, token, b"product")).json()["id"]
    created = await env.client.post(
        "/api/seller/products",
        headers=bearer(token),
        json={"name": name, "comment": "", "price": price, "stock": stock, "imageIds": [image]},
    )
    assert created.status_code == 200, created.text
    published = await env.client.post(
        "/api/seller/products/publish",
        headers=bearer(token),
        json={"ids": [created.json()["id"]]},
    )
    assert published.status_code == 200, published.text
    return published.json()[0]


async def preview(
    env: Env, token: str, items: list[dict[str, Any]], order_id: str | None = None
) -> dict[str, Any]:
    response = await env.client.post(
        "/api/orders/preview",
        headers=bearer(token),
        json={"items": items, **({"orderId": order_id} if order_id else {})},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def checkout(
    env: Env,
    token: str,
    items: list[dict[str, Any]],
    *,
    expected_total: int | None = None,
    key: str | None = None,
):
    if expected_total is None:
        expected_total = (await preview(env, token, items))["total"]
    return await env.client.post(
        "/api/orders",
        headers=bearer(token),
        json={
            "items": items,
            "expectedTotal": expected_total,
            "key": key or f"checkout-{uuid.uuid4()}",
        },
    )


async def order_of(env: Env, token: str, order_id: str) -> dict[str, Any]:
    response = await env.client.get(f"/api/orders/{order_id}", headers=bearer(token))
    assert response.status_code == 200, response.text
    return response.json()


async def product_detail(env: Env, token: str, product_id: str) -> dict[str, Any]:
    response = await env.client.get(f"/api/products/{product_id}", headers=bearer(token))
    assert response.status_code == 200, response.text
    return response.json()


async def review(
    env: Env,
    token: str,
    order: dict[str, Any],
    media_ids: list[str] | None = None,
):
    if media_ids is None:
        media_ids = [(await upload(env, token, b"evidence")).json()["id"]]
    return await env.client.post(
        f"/api/orders/{order['id']}/evidence",
        headers=bearer(token),
        json={"version": order["version"], "mediaIds": media_ids},
    )


async def pay(
    env: Env,
    token: str,
    order: dict[str, Any],
    decision: str = "confirmed",
    reason: str | None = None,
):
    payload: dict[str, Any] = {"version": order["version"], "decision": decision}
    if reason is not None:
        payload["reason"] = reason
    return await env.client.post(
        f"/api/seller/orders/{order['id']}/payment",
        headers=bearer(token),
        json=payload,
    )


async def request_change(
    env: Env,
    token: str,
    order: dict[str, Any],
    items: list[dict[str, Any]],
    note: str = "Please change selection",
):
    quoted = await preview(env, token, items, order_id=order["id"])
    return await env.client.post(
        f"/api/orders/{order['id']}/changes",
        headers=bearer(token),
        json={
            "version": order["version"],
            "items": items,
            "expectedTotal": quoted["total"],
            "note": note,
        },
    )


async def withdraw(
    env: Env,
    token: str,
    order: dict[str, Any],
    change_id: str,
    version: int | None = None,
):
    return await env.client.post(
        f"/api/orders/{order['id']}/changes/{change_id}/withdraw",
        headers=bearer(token),
        json={"version": order["version"] if version is None else version},
    )


def pending_change(order: dict[str, Any]) -> dict[str, Any]:
    return next(change for change in order["changes"] if change["state"] == "pending")


async def resolve(
    env: Env,
    token: str,
    order: dict[str, Any],
    change_id: str,
    decision: str,
    settlement: str | None = None,
    reason: str | None = None,
):
    payload: dict[str, Any] = {
        "version": order["version"],
        "decision": decision,
        "reason": reason or "",
    }
    if settlement is not None:
        payload["settlementNote"] = settlement
    return await env.client.post(
        f"/api/seller/orders/{order['id']}/changes/{change_id}/resolve",
        headers=bearer(token),
        json=payload,
    )
