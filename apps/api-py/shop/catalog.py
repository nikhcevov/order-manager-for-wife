"""Product catalog: private drafts and atomic publication with derived inventory."""

from __future__ import annotations

import uuid
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import Depends, FastAPI
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import authenticate
from .config import Settings
from .db import transaction
from .http import ApiError, User, check_version, seller
from .media import validate_stored_product_image

INT_MAX = 2_147_483_647

PRODUCT_SELECT = """WITH shop_clock AS MATERIALIZED(SELECT clock_timestamp() AS now)
  SELECT p.id,p.name,p.comment,p.price,p.remaining_unsold,p.published,p.version,
  COALESCE((SELECT array_agg(pi.media_id::text ORDER BY pi.position)
            FROM product_images pi WHERE pi.product_id=p.id),'{}'::text[]) AS images,
  COALESCE(q.reserved,0)::bigint AS reserved,
  (p.remaining_unsold-COALESCE(q.reserved,0))::bigint AS available,
  COALESCE(q.bought,0)::bigint AS bought
  FROM products p CROSS JOIN shop_clock t LEFT JOIN LATERAL (
    SELECT SUM(l.quantity) FILTER(WHERE o.status='payment_review'
             OR (o.status='awaiting_payment' AND o.deadline>t.now)) AS reserved,
           SUM(l.quantity) FILTER(WHERE o.status='paid') AS bought
    FROM order_lines l JOIN orders o ON o.current_revision=l.revision_id WHERE l.product_id=p.id
  ) q ON true"""


def _dedupe(values: list[UUID]) -> list[UUID]:
    seen: set[UUID] = set()
    for value in values:
        if value in seen:
            raise ValueError("Select each image only once.")
        seen.add(value)
    return values


class ProductFields(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str = Field(min_length=1, max_length=200)
    comment: str = Field(default="", max_length=4000)
    price: int = Field(ge=0, le=INT_MAX)
    stock: int = Field(ge=0, le=INT_MAX)
    image_ids: list[UUID] = Field(alias="imageIds", min_length=1, max_length=20)

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("image_ids")
    @classmethod
    def _unique(cls, value: list[UUID]) -> list[UUID]:
        return _dedupe(value)


class EditProduct(ProductFields):
    version: int = Field(ge=1, le=INT_MAX)


class PublishProducts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[UUID] = Field(min_length=1, max_length=100)

    @field_validator("ids")
    @classmethod
    def _unique(cls, value: list[UUID]) -> list[UUID]:
        return _dedupe(value)


def _product(row: Any) -> dict[str, Any]:
    return {**dict(row), "id": str(row["id"])}


async def _read_products(
    db: Any,
    ids: list[UUID] | None = None,
    *,
    published_only: bool = False,
) -> list[dict[str, Any]]:
    conditions = ["p.published" if published_only else "true"]
    params: list[Any] = []
    if ids is not None:
        params.append(ids)
        conditions.append(f"p.id=ANY(${len(params)}::uuid[])")
    rows = await db.fetch(
        f"{PRODUCT_SELECT} WHERE {' AND '.join(conditions)} ORDER BY p.created_at,p.id",
        *params,
    )
    return [_product(row) for row in rows]


async def _validate_images(
    connection: asyncpg.Connection,
    config: Settings,
    ids: list[UUID],
    user_id: str | None = None,
    existing: set[UUID] | frozenset[UUID] = frozenset(),
) -> None:
    rows = await connection.fetch(
        "SELECT id,user_id,kind,storage_key,mime FROM media WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE",
        ids,
    )
    selected = {row["id"]: row for row in rows}
    for media_id in ids:
        media = selected.get(media_id)
        if (
            media is None
            or media["kind"] != "product"
            or (user_id is not None and media["user_id"] != user_id and media_id not in existing)
        ):
            raise ApiError(
                400,
                "invalid_image",
                "Select successfully uploaded product images belonging to you.",
                {"mediaId": str(media_id)},
            )
        await validate_stored_product_image(media, config)


def register_catalog(app: FastAPI, pool: asyncpg.Pool, config: Settings) -> None:
    @app.get("/api/products")
    async def list_products(user: User = Depends(authenticate)) -> list[dict[str, Any]]:
        return await _read_products(pool, published_only=True)

    @app.get("/api/seller/products")
    async def list_seller_products(user: User = Depends(authenticate)) -> list[dict[str, Any]]:
        seller(user)
        return await _read_products(pool)

    @app.get("/api/products/{product_id}")
    async def product_detail(
        product_id: UUID, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        product = (await _read_products(pool, [product_id], published_only=not user.is_seller))
        if not product:
            raise ApiError(404, "not_found", "Product not found")
        return product[0]

    @app.post("/api/seller/products")
    async def create_product(
        body: ProductFields, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        seller(user)
        async with transaction(pool) as connection:
            product_id = uuid.uuid4()
            await _validate_images(connection, config, body.image_ids, user.id)
            await connection.execute(
                "INSERT INTO products(id,name,comment,price,remaining_unsold) VALUES($1,$2,$3,$4,$5)",
                product_id,
                body.name,
                body.comment,
                body.price,
                body.stock,
            )
            for position, media_id in enumerate(body.image_ids):
                await connection.execute(
                    "INSERT INTO product_images(product_id,media_id,position) VALUES($1,$2,$3)",
                    product_id,
                    media_id,
                    position,
                )
            return (await _read_products(connection, [product_id]))[0]

    @app.patch("/api/seller/products/{product_id}")
    async def edit_product(
        product_id: UUID, body: EditProduct, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        seller(user)
        async with transaction(pool) as connection:
            current = await connection.fetchrow(
                "SELECT version FROM products WHERE id=$1 FOR UPDATE", product_id
            )
            if current is None:
                raise ApiError(404, "not_found", "Product not found")
            check_version(current["version"], body.version)
            # Sample wall-clock time only after waiting for the product lock.
            now = await connection.fetchval("SELECT clock_timestamp()::text")
            reserved = await connection.fetchval(
                """SELECT COALESCE(SUM(l.quantity),0)::bigint AS reserved
                   FROM order_lines l JOIN orders o ON o.current_revision=l.revision_id
                   WHERE l.product_id=$1 AND (o.status='payment_review'
                     OR (o.status='awaiting_payment' AND o.deadline>$2::text::timestamptz))""",
                product_id,
                now,
            )
            if body.stock < reserved:
                raise ApiError(
                    409,
                    "stock_reserved",
                    "Stock cannot be lower than active reserved units.",
                    {"reserved": reserved, "stock": body.stock},
                )
            existing = {
                row["media_id"]
                for row in await connection.fetch(
                    "SELECT media_id FROM product_images WHERE product_id=$1", product_id
                )
            }
            await _validate_images(connection, config, body.image_ids, user.id, existing)
            await connection.execute(
                """UPDATE products SET name=$2,comment=$3,price=$4,remaining_unsold=$5,
                   version=version+1 WHERE id=$1""",
                product_id,
                body.name,
                body.comment,
                body.price,
                body.stock,
            )
            await connection.execute(
                "DELETE FROM product_images WHERE product_id=$1", product_id
            )
            for position, media_id in enumerate(body.image_ids):
                await connection.execute(
                    "INSERT INTO product_images(product_id,media_id,position) VALUES($1,$2,$3)",
                    product_id,
                    media_id,
                    position,
                )
            return (await _read_products(connection, [product_id]))[0]

    @app.post("/api/seller/products/publish")
    async def publish_products(
        body: PublishProducts, user: User = Depends(authenticate)
    ) -> list[dict[str, Any]]:
        seller(user)
        async with transaction(pool) as connection:
            products = await connection.fetch(
                """SELECT id,name,comment,price,remaining_unsold FROM products
                   WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE""",
                body.ids,
            )
            if len(products) != len(body.ids):
                raise ApiError(404, "not_found", "One of the selected products no longer exists.")
            images = await connection.fetch(
                """SELECT product_id,media_id FROM product_images
                   WHERE product_id=ANY($1::uuid[]) ORDER BY product_id,position""",
                body.ids,
            )
            for product in products:
                if (
                    not product["name"].strip()
                    or product["price"] < 0
                    or product["remaining_unsold"] < 0
                    or not any(image["product_id"] == product["id"] for image in images)
                ):
                    raise ApiError(
                        400,
                        "invalid_product",
                        "Each published product needs a name, valid price and stock, and an image.",
                        {"productId": str(product["id"])},
                    )
            unique = list(dict.fromkeys(image["media_id"] for image in images))
            await _validate_images(connection, config, unique)
            await connection.execute(
                "UPDATE products SET published=true,version=version+1 WHERE id=ANY($1::uuid[]) AND NOT published",
                body.ids,
            )
            return await _read_products(connection, body.ids)
