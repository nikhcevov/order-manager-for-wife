"""Catalog contract: private drafts, ordered images, atomic publication, versions."""

from __future__ import annotations

import io
import uuid
from typing import Any
from uuid import UUID

from PIL import Image

from .helpers import ALICE, SELLER, Env, session
from .uploads import bearer, upload


async def draft(
    env: Env,
    token: str,
    image_id: str,
    price: int = 100,
    stock: int = 10,
    name: str = "Fixture product",
) -> dict[str, Any]:
    response = await env.client.post(
        "/api/seller/products",
        headers=bearer(token),
        json={
            "name": name,
            "comment": "Prepared privately",
            "price": price,
            "stock": stock,
            "imageIds": [image_id],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_drafts_stay_private_and_publish_as_one_atomic_batch(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)

    first_image = (await upload(env, seller, b"product")).json()["id"]
    first = await draft(env, seller, first_image, 125, 3, "First")
    second_image = (await upload(env, seller, b"product")).json()["id"]
    second = await draft(env, seller, second_image, 225, 4, "Second")
    extra = (await upload(env, seller, b"product")).json()["id"]

    edited = await env.client.patch(
        f"/api/seller/products/{first['id']}",
        headers=bearer(seller),
        json={
            "version": first["version"],
            "name": first["name"],
            "comment": "Two ordered images",
            "price": first["price"],
            "stock": first["remaining_unsold"],
            "imageIds": [extra, first_image],
        },
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["images"] == [extra, first_image]

    assert (await env.client.get("/api/products", headers=bearer(alice))).json() == []
    assert (await env.client.get(f"/api/products/{first['id']}", headers=bearer(alice))).status_code == 404
    assert (await env.client.get(f"/api/public-media/{first_image}")).status_code == 404
    assert (await env.client.get(f"/api/media/{first_image}", headers=bearer(alice))).status_code == 404
    assert (await env.client.get(f"/api/media/{first_image}", headers=bearer(seller))).status_code == 200

    missing = await env.client.post(
        "/api/seller/products/publish",
        headers=bearer(seller),
        json={"ids": [first["id"], str(uuid.uuid4())]},
    )
    assert missing.status_code == 404
    assert (await env.client.get("/api/products", headers=bearer(alice))).json() == []

    row = await env.pool.fetchrow("SELECT storage_key FROM media WHERE id=$1", UUID(second["images"][0]))
    image_path = env.config.media_dir / row["storage_key"]
    valid = image_path.read_bytes()
    image_path.write_bytes(b"corrupted stored image")
    try:
        corrupt = await env.client.post(
            "/api/seller/products/publish",
            headers=bearer(seller),
            json={"ids": [first["id"], second["id"]]},
        )
        assert corrupt.status_code == 400, corrupt.text
        assert corrupt.json()["error"] == "invalid_image"
        assert (await env.client.get("/api/products", headers=bearer(alice))).json() == []
        listed = (await env.client.get("/api/seller/products", headers=bearer(seller))).json()
        assert all(not product["published"] for product in listed)
    finally:
        image_path.write_bytes(valid)

    published = await env.client.post(
        "/api/seller/products/publish",
        headers=bearer(seller),
        json={"ids": [first["id"], second["id"]]},
    )
    assert published.status_code == 200, published.text
    assert len(published.json()) == 2
    assert all(product["published"] for product in published.json())

    catalog = (await env.client.get("/api/products", headers=bearer(alice))).json()
    assert {product["id"] for product in catalog} == {first["id"], second["id"]}

    detail = (await env.client.get(f"/api/products/{first['id']}", headers=bearer(alice))).json()
    assert detail["comment"] == "Two ordered images"
    assert detail["available"] == 3
    assert detail["images"] == [extra, first_image]

    public_image = await env.client.get(f"/api/public-media/{extra}")
    assert public_image.status_code == 200
    assert Image.open(io.BytesIO(public_image.content)).width == 64


async def test_invalid_fields_and_foreign_or_evidence_images_are_rejected(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)

    seller_image = (await upload(env, seller, b"product")).json()["id"]
    evidence = (await upload(env, alice, b"evidence")).json()["id"]
    seller_evidence = (await upload(env, seller, b"evidence")).json()["id"]
    base = {"name": "Valid", "comment": "", "price": 100, "stock": 2, "imageIds": [seller_image]}
    patches = [
        {"name": ""},
        {"name": "   "},
        {"price": -1},
        {"price": 1.5},
        {"price": 2_147_483_648},
        {"stock": -1},
        {"stock": 1.5},
        {"stock": 2_147_483_648},
        {"imageIds": []},
        {"imageIds": [evidence]},
        {"imageIds": [seller_evidence]},
        {"imageIds": [str(uuid.uuid4())]},
        {"imageIds": [seller_image, seller_image]},
    ]
    for patch in patches:
        response = await env.client.post(
            "/api/seller/products", headers=bearer(seller), json={**base, **patch}
        )
        assert response.status_code in {400, 403, 404, 409}, (patch, response.text)
    assert (await env.client.get("/api/seller/products", headers=bearer(seller))).json() == []


async def test_versions_permissions_and_detail_visibility(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)

    image = (await upload(env, seller, b"product")).json()["id"]
    created = await draft(env, seller, image, 100, 5, "  Trimmed  ")
    assert created["name"] == "Trimmed"
    assert created["comment"] == "Prepared privately"
    assert (created["reserved"], created["available"], created["bought"]) == (0, 5, 0)
    assert created["version"] == 1

    for method, url, body in [
        ("post", "/api/seller/products", {"name": "X", "price": 1, "stock": 1, "imageIds": [image]}),
        ("patch", f"/api/seller/products/{created['id']}", {"version": 1, "name": "X", "price": 1, "stock": 1, "imageIds": [image]}),
        ("post", "/api/seller/products/publish", {"ids": [created["id"]]}),
        ("get", "/api/seller/products", None),
    ]:
        response = await env.client.request(
            method.upper(), url, headers=bearer(alice), json=body
        )
        assert response.status_code == 403

    stale = await env.client.patch(
        f"/api/seller/products/{created['id']}",
        headers=bearer(seller),
        json={
            "version": 999,
            "name": "Renamed",
            "comment": "",
            "price": 150,
            "stock": 5,
            "imageIds": [image],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["error"] == "stale_version"
    assert stale.json()["details"]["version"] == 1

    renamed = await env.client.patch(
        f"/api/seller/products/{created['id']}",
        headers=bearer(seller),
        json={
            "version": 1,
            "name": "Renamed",
            "comment": "",
            "price": 150,
            "stock": 5,
            "imageIds": [image],
        },
    )
    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["name"], renamed.json()["price"], renamed.json()["version"]) == (
        "Renamed",
        150,
        2,
    )

    published = await env.client.post(
        "/api/seller/products/publish", headers=bearer(seller), json={"ids": [created["id"]]}
    )
    assert published.status_code == 200
    assert published.json()[0]["version"] == 3
    again = await env.client.post(
        "/api/seller/products/publish", headers=bearer(seller), json={"ids": [created["id"]]}
    )
    assert again.status_code == 200
    assert again.json()[0]["version"] == 3

    visible = await env.client.get(f"/api/products/{created['id']}", headers=bearer(alice))
    assert visible.status_code == 200
    assert visible.json()["name"] == "Renamed"


async def test_publish_rejects_products_without_images_and_missing_records(env: Env) -> None:
    seller = await session(env, SELLER)
    product_id = uuid.uuid4()
    await env.pool.execute(
        """INSERT INTO products(id,name,comment,price,remaining_unsold)
           VALUES($1,'No image','',100,1)""",
        product_id,
    )

    invalid = await env.client.post(
        "/api/seller/products/publish", headers=bearer(seller), json={"ids": [str(product_id)]}
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "invalid_product"
    assert invalid.json()["details"]["productId"] == str(product_id)

    missing = await env.client.post(
        "/api/seller/products/publish",
        headers=bearer(seller),
        json={"ids": [str(uuid.uuid4())]},
    )
    assert missing.status_code == 404

    empty = await env.client.post(
        "/api/seller/products/publish", headers=bearer(seller), json={"ids": []}
    )
    assert empty.status_code == 400

    duplicate = await env.client.post(
        "/api/seller/products/publish",
        headers=bearer(seller),
        json={"ids": [str(product_id), str(product_id)]},
    )
    assert duplicate.status_code == 400
    assert await env.pool.fetchval("SELECT count(*) FROM products WHERE published") == 0


async def test_catalog_requires_authentication(env: Env) -> None:
    for url in ("/api/products", "/api/seller/products"):
        response = await env.client.get(url)
        assert response.status_code == 401
        assert response.json()["error"] == "unauthorized"
