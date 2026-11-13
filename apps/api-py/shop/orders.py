"""Orders: atomic checkout, unpaid revisions, evidence, payments, and corrections."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated, Any, Literal
from uuid import UUID

import asyncpg
from fastapi import Depends, FastAPI
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)
from .auth import authenticate
from .config import Settings
from .db import transaction
from .http import ApiError, User, check_version, owner, seller

MAX_INT = 2_147_483_647
MAX_SAFE_INTEGER = 9_007_199_254_740_991
NOTE = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]
PURCHASE_KEY = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
VERSION = Annotated[int, Field(ge=1, le=MAX_INT)]
AMOUNT = Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]


class SelectionItem(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    product_id: UUID = Field(alias="productId")
    quantity: int = Field(ge=1, le=MAX_INT)


def _unique_selection(items: list[SelectionItem]) -> list[SelectionItem]:
    seen: set[UUID] = set()
    for item in items:
        if item.product_id in seen:
            raise ValueError("Select each product only once.")
        seen.add(item.product_id)
    return items


Selection = Annotated[list[SelectionItem], Field(max_length=200), AfterValidator(_unique_selection)]
NonEmptySelection = Annotated[
    list[SelectionItem], Field(min_length=1, max_length=200), AfterValidator(_unique_selection)
]


class PreviewBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    items: Selection
    order_id: UUID | None = Field(default=None, alias="orderId")


class CheckoutBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    items: NonEmptySelection
    expected_total: AMOUNT = Field(alias="expectedTotal")
    key: PURCHASE_KEY


class EditBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: VERSION
    items: Selection
    expected_total: AMOUNT = Field(alias="expectedTotal")


class CancelBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: VERSION


class EvidenceBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: VERSION
    media_ids: list[UUID] = Field(alias="mediaIds", min_length=1, max_length=20)

    @field_validator("media_ids")
    @classmethod
    def _unique(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Submit each screenshot only once.")
        return value


class PaymentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: VERSION
    decision: Literal["confirmed", "rejected"]
    reason: NOTE | None = None


class ChangeBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: VERSION
    items: Selection
    expected_total: AMOUNT = Field(alias="expectedTotal")
    note: NOTE | None = None


class ResolveBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: VERSION
    decision: Literal["approved", "rejected"]
    settlement_note: NOTE | None = Field(default=None, alias="settlementNote")
    reason: NOTE | None = None


ORDER_VIEW_SQL = """
 SELECT o.*, CASE WHEN o.status='awaiting_payment' AND o.deadline<=clock_timestamp()
   THEN 'expired' ELSE o.status END AS effective_status, r.total,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id',l.product_id,'name',l.name,
     'unit_price',l.unit_price,'quantity',l.quantity) ORDER BY l.position)
     FROM order_lines l WHERE l.revision_id=o.current_revision),'[]'::jsonb) AS lines,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'number',v.number,'total',v.total,
     'author_id',v.author_id,'created_at',v.created_at,'lines',COALESCE((SELECT jsonb_agg(
       jsonb_build_object('product_id',l.product_id,'name',l.name,'unit_price',l.unit_price,
       'quantity',l.quantity) ORDER BY l.position) FROM order_lines l WHERE l.revision_id=v.id),'[]'::jsonb))
     ORDER BY v.number) FROM order_revisions v WHERE v.order_id=o.id),'[]'::jsonb) AS revisions,
   COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at,e.id)
     FROM payment_evidence e WHERE e.order_id=o.id),'[]'::jsonb) AS evidence,
   (SELECT to_jsonb(d) FROM payment_decisions d WHERE d.order_id=o.id) AS decision,
   COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at,c.id)
     FROM change_requests c WHERE c.order_id=o.id),'[]'::jsonb) AS changes,
   jsonb_build_object('first_name',u.first_name,'username',u.username) AS customer,
   to_jsonb(g) AS "group"
 FROM orders o JOIN order_revisions r ON r.id=o.current_revision
 JOIN customers u ON u.id=o.user_id JOIN fulfillment_groups g ON g.id=o.group_id"""


def _view(row: Any) -> dict[str, Any]:
    data = dict(row)
    data["status"] = data.pop("effective_status")
    return data


async def read_order(db: Any, order_id: UUID) -> dict[str, Any]:
    row = await db.fetchrow(f"{ORDER_VIEW_SQL} WHERE o.id=$1", order_id)
    if row is None:
        raise ApiError(404, "not_found", "Order not found.")
    return _view(row)


async def read_orders(db: Any, user_id: str | None = None) -> list[dict[str, Any]]:
    rows = await db.fetch(
        f"{ORDER_VIEW_SQL} WHERE ($1::text IS NULL OR o.user_id=$1) ORDER BY o.created_at DESC,o.id",
        user_id,
    )
    return [_view(row) for row in rows]


async def _check_version(
    connection: asyncpg.Connection, order: Any, expected: int
) -> None:
    try:
        check_version(order["version"], expected)
    except ApiError as error:
        error.details = {
            "version": order["version"],
            "order": await read_order(connection, order["id"]),
        }
        raise


async def _locked_order(
    pool: asyncpg.Pool,
    user: User,
    order_id: UUID,
    action: Callable[[asyncpg.Connection, Any, Any], Awaitable[Any]],
) -> Any:
    async with transaction(pool) as connection:
        initial = await connection.fetchrow(
            "SELECT group_id,user_id FROM orders WHERE id=$1", order_id
        )
        if initial is None:
            raise ApiError(404, "not_found", "Order not found.")
        owner(user, initial["user_id"])
        group = await connection.fetchrow(
            "SELECT * FROM fulfillment_groups WHERE id=$1 FOR UPDATE", initial["group_id"]
        )
        order = await connection.fetchrow("SELECT * FROM orders WHERE id=$1 FOR UPDATE", order_id)
        if group is None or order is None:
            raise ApiError(404, "not_found", "Order not found.")
        owner(user, order["user_id"])
        # Shipping can move a whole order between packages while our first read waits.
        # Never acquire the new group after an order lock (the global order forbids it).
        if order["group_id"] != group["id"]:
            raise ApiError(
                409,
                "group_changed",
                "This order moved to another fulfillment group. Refresh and try again.",
            )
        return await action(connection, order, group)


def _open_package(group: Any) -> None:
    if group["state"] != "open":
        raise ApiError(
            409,
            "package_completed",
            "This package has already been shipped. Shipped packages cannot be changed.",
        )


async def _lines_for(connection: Any, revision_id: UUID) -> list[dict[str, Any]]:
    rows = await connection.fetch(
        """SELECT product_id::text AS product_id,name,unit_price,quantity
           FROM order_lines WHERE revision_id=$1 ORDER BY position""",
        revision_id,
    )
    return [dict(row) for row in rows]


def _quantities(lines: list[dict[str, Any]]) -> dict[str, int]:
    result: dict[str, int] = {}
    for line in lines:
        result[line["product_id"]] = result.get(line["product_id"], 0) + line["quantity"]
    return result


async def _products_for(
    connection: Any,
    items: list[SelectionItem],
    old: list[dict[str, Any]],
    lock: bool,
) -> dict[str, Any]:
    ids = sorted({str(item.product_id) for item in items} | {line["product_id"] for line in old})
    if not ids:
        return {}
    rows = await connection.fetch(
        f"""SELECT id,name,price,remaining_unsold,published FROM products
            WHERE id=ANY($1::uuid[]) ORDER BY id {"FOR UPDATE" if lock else ""}""",
        [UUID(product_id) for product_id in ids],
    )
    products = {str(row["id"]): row for row in rows}
    for product_id in ids:
        if product_id not in products:
            raise ApiError(
                409,
                "product_unavailable",
                "A selected product is no longer available.",
                {"productId": product_id},
            )
    return products


def _quote(
    items: list[SelectionItem],
    old: list[dict[str, Any]],
    products: dict[str, Any],
) -> dict[str, Any]:
    wanted = {str(item.product_id): item.quantity for item in items}
    lines: list[dict[str, Any]] = []
    # Retain the oldest accepted price lots first. Removing quantities never reprices the rest.
    for line in old:
        remaining = wanted.get(line["product_id"], 0)
        retained = min(line["quantity"], remaining)
        if retained:
            lines.append({**line, "quantity": retained})
        wanted[line["product_id"]] = remaining - retained
    for item in sorted(items, key=lambda entry: str(entry.product_id)):
        product_id = str(item.product_id)
        added = wanted.get(product_id, 0)
        if not added:
            continue
        product = products[product_id]
        if not product["published"]:
            raise ApiError(
                409,
                "product_unavailable",
                "A selected product is not published.",
                {"productId": product_id},
            )
        lines.append(
            {
                "product_id": product_id,
                "name": product["name"],
                "unit_price": product["price"],
                "quantity": added,
            }
        )
    total = 0
    for line in lines:
        subtotal = line["unit_price"] * line["quantity"]
        if subtotal > MAX_SAFE_INTEGER or total + subtotal > MAX_SAFE_INTEGER:
            raise ApiError(400, "invalid_total", "This selection exceeds the supported monetary total.")
        total += subtotal
    return {"lines": lines, "total": total}


def _accepted_total(
    actual: int,
    expected: int,
    lines: list[dict[str, Any]],
    code: str = "price_changed",
) -> None:
    if actual != expected:
        raise ApiError(
            409,
            code,
            "Prices changed. Review and accept the current total before continuing.",
            {"total": actual, "lines": lines},
        )


async def _database_time(connection: Any) -> str:
    # Keep PostgreSQL's microsecond precision instead of truncating through a datetime.
    return await connection.fetchval("SELECT clock_timestamp()::text AS now")


async def _awaiting(connection: Any, order: Any, now: str) -> None:
    elapsed = order["status"] == "awaiting_payment" and await connection.fetchval(
        "SELECT deadline<=$2::text::timestamptz AS elapsed FROM orders WHERE id=$1",
        order["id"],
        now,
    )
    if order["status"] == "expired" or elapsed:
        raise ApiError(
            409,
            "order_expired",
            "The payment deadline passed. Create a new order.",
            {"order": await read_order(connection, order["id"])},
        )
    if order["status"] != "awaiting_payment":
        raise ApiError(
            409,
            "invalid_order_state",
            "Only an awaiting-payment order can be edited, cancelled, or submitted for review.",
            {"order": await read_order(connection, order["id"])},
        )


async def _check_stock(
    connection: Any,
    products: dict[str, Any],
    desired: list[dict[str, Any]],
    old: list[dict[str, Any]],
    own_order: UUID | None,
    paid: bool,
    now: str,
) -> None:
    if not products:
        return
    held = await connection.fetch(
        """SELECT l.product_id,SUM(l.quantity)::bigint AS quantity
           FROM order_lines l JOIN orders o ON o.current_revision=l.revision_id
           WHERE l.product_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR o.id<>$2)
             AND (o.status='payment_review' OR (o.status='awaiting_payment' AND o.deadline>$3::text::timestamptz))
           GROUP BY l.product_id""",
        [UUID(product_id) for product_id in products],
        own_order,
        now,
    )
    reserved = {str(row["product_id"]): row["quantity"] for row in held}
    before = _quantities(old)
    after = _quantities(desired)
    shortages: list[dict[str, Any]] = []
    for product in products.values():
        product_id = str(product["id"])
        requested = after.get(product_id, 0)
        restored = before.get(product_id, 0) if paid else 0
        available = product["remaining_unsold"] - reserved.get(product_id, 0) + restored
        if requested > available:
            shortages.append(
                {
                    "productId": product_id,
                    "requested": requested,
                    "available": max(0, available),
                }
            )
        if paid and product["remaining_unsold"] + restored - requested > MAX_INT:
            raise ApiError(
                409,
                "stock_limit",
                "Returning these units would exceed the stock limit. Adjust unsold stock before approving.",
                {"productId": product_id},
            )
    if shortages:
        raise ApiError(
            409,
            "stock_conflict",
            "Some selected quantities are unavailable. The original order is unchanged.",
            {"shortages": shortages},
        )


def _lines_payload(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "product_id": str(line["product_id"]),
            "name": line["name"],
            "unit_price": line["unit_price"],
            "quantity": line["quantity"],
        }
        for line in lines
    ]


async def _append_revision(
    connection: Any,
    order_id: UUID,
    author_id: str,
    lines: list[dict[str, Any]],
    total: int,
) -> UUID:
    revision_id = uuid.uuid4()
    await connection.execute(
        """INSERT INTO order_revisions(id,order_id,number,total,author_id)
           SELECT $1,$2,COALESCE(MAX(number),0)+1,$3,$4 FROM order_revisions WHERE order_id=$2""",
        revision_id,
        order_id,
        total,
        author_id,
    )
    if lines:
        await connection.execute(
            """INSERT INTO order_lines(revision_id,position,product_id,name,unit_price,quantity)
               SELECT $1,(entry.ordinality-1)::integer,(entry.value->>'product_id')::uuid,
                 entry.value->>'name',(entry.value->>'unit_price')::integer,
                 (entry.value->>'quantity')::integer
               FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(value,ordinality)""",
            revision_id,
            _lines_payload(lines),
        )
    return revision_id


async def _bump_group(connection: Any, group_id: UUID) -> None:
    await connection.execute(
        "UPDATE fulfillment_groups SET version=version+1 WHERE id=$1", group_id
    )


async def _open_package_id(connection: Any, user_id: str) -> UUID:
    """Every customer has at most one open package; a confirmed order joins it."""

    async def find() -> Any:
        return await connection.fetchrow(
            "SELECT id FROM fulfillment_groups WHERE user_id=$1 AND state='open' FOR UPDATE",
            user_id,
        )

    existing = await find()
    if existing is not None:
        return existing["id"]
    inserted = await connection.fetchrow(
        """INSERT INTO fulfillment_groups(id,user_id) VALUES($1,$2)
           ON CONFLICT (user_id) WHERE state='open' DO NOTHING RETURNING id""",
        uuid.uuid4(),
        user_id,
    )
    if inserted is not None:
        return inserted["id"]
    return (await find())["id"]


async def _adjust_paid_stock(
    connection: Any,
    products: dict[str, Any],
    old: list[dict[str, Any]],
    desired: list[dict[str, Any]],
) -> None:
    before = _quantities(old)
    after = _quantities(desired)
    for product_id in sorted(products):
        delta = before.get(product_id, 0) - after.get(product_id, 0)
        if delta:
            await connection.execute(
                "UPDATE products SET remaining_unsold=remaining_unsold+$2,version=version+1 WHERE id=$1",
                UUID(product_id),
                delta,
            )


async def _requested_change(connection: Any, order_id: UUID, change_id: UUID) -> dict[str, Any]:
    change = await connection.fetchrow(
        "SELECT * FROM change_requests WHERE id=$1 AND order_id=$2", change_id, order_id
    )
    if change is None:
        raise ApiError(404, "not_found", "Change request not found.")
    return dict(change)


async def _parse_selection(value: Any) -> list[SelectionItem]:
    model = PreviewBody.model_validate({"items": value})
    return model.items


def register_orders(app: FastAPI, pool: asyncpg.Pool, config: Settings) -> None:
    @app.get("/api/orders")
    async def list_orders(user: User = Depends(authenticate)) -> list[dict[str, Any]]:
        return await read_orders(pool, user.id)

    @app.get("/api/seller/orders")
    async def list_all_orders(user: User = Depends(authenticate)) -> list[dict[str, Any]]:
        seller(user)
        return await read_orders(pool)

    @app.get("/api/orders/{order_id}")
    async def order_detail(
        order_id: UUID, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        order = await read_order(pool, order_id)
        owner(user, order["user_id"])
        return order

    @app.post("/api/orders/preview")
    async def preview(body: PreviewBody, user: User = Depends(authenticate)) -> dict[str, Any]:
        old: list[dict[str, Any]] = []
        if body.order_id is not None:
            order = await read_order(pool, body.order_id)
            owner(user, order["user_id"])
            old = order["lines"]
        products = await _products_for(pool, body.items, old, lock=False)
        return _quote(body.items, old, products)

    @app.post("/api/orders")
    async def checkout(body: CheckoutBody, user: User = Depends(authenticate)) -> dict[str, Any]:
        canonical = {
            "items": [
                {"productId": str(item.product_id), "quantity": item.quantity}
                for item in sorted(body.items, key=lambda entry: str(entry.product_id))
            ],
            "expectedTotal": body.expected_total,
            "key": body.key,
        }
        digest = hashlib.sha256(
            # Match JSON.stringify: no spaces, no ASCII escaping.
            json.dumps(canonical, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
        async with transaction(pool) as connection:
            # Serialize customer/key pairs even before a submission row exists.
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
                f"checkout:{user.id}:{body.key}",
            )
            previous = await connection.fetchrow(
                "SELECT payload_hash,order_id FROM checkout_submissions WHERE user_id=$1 AND key=$2",
                user.id,
                body.key,
            )
            if previous is not None:
                if previous["payload_hash"] != digest:
                    raise ApiError(
                        409,
                        "idempotency_conflict",
                        "This checkout key was already used for a different selection.",
                    )
                return await read_order(connection, previous["order_id"])

            group_id = await _open_package_id(connection, user.id)
            products = await _products_for(connection, body.items, [], lock=True)
            now = await _database_time(connection)
            proposed = _quote(body.items, [], products)
            _accepted_total(proposed["total"], body.expected_total, proposed["lines"])
            await _check_stock(connection, products, proposed["lines"], [], None, False, now)

            order_id = uuid.uuid4()
            revision_id = uuid.uuid4()
            await connection.execute(
                """INSERT INTO orders(id,user_id,group_id,deadline,current_revision,currency)
                   VALUES($1,$2,$3,$4::text::timestamptz+($7::integer*interval '1 minute'),$5,$6)""",
                order_id,
                user.id,
                group_id,
                now,
                revision_id,
                config.shop_currency,
                config.hold_minutes,
            )
            await connection.execute(
                "INSERT INTO order_revisions(id,order_id,number,total,author_id) VALUES($1,$2,1,$3,$4)",
                revision_id,
                order_id,
                proposed["total"],
                user.id,
            )
            await connection.execute(
                """INSERT INTO order_lines(revision_id,position,product_id,name,unit_price,quantity)
                   SELECT $1,(entry.ordinality-1)::integer,(entry.value->>'product_id')::uuid,
                     entry.value->>'name',(entry.value->>'unit_price')::integer,
                     (entry.value->>'quantity')::integer
                   FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(value,ordinality)""",
                revision_id,
                _lines_payload(proposed["lines"]),
            )
            await connection.execute(
                "INSERT INTO checkout_submissions(user_id,key,payload_hash,order_id) VALUES($1,$2,$3,$4)",
                user.id,
                body.key,
                digest,
                order_id,
            )
            await _bump_group(connection, group_id)
            return await read_order(connection, order_id)

    @app.patch("/api/orders/{order_id}")
    async def edit_order(
        order_id: UUID, body: EditBody, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        async def action(connection: Any, order: Any, group: Any) -> dict[str, Any]:
            _open_package(group)
            await _check_version(connection, order, body.version)
            old = await _lines_for(connection, order["current_revision"])
            products = await _products_for(connection, body.items, old, lock=True)
            now = await _database_time(connection)
            await _awaiting(connection, order, now)
            proposed = _quote(body.items, old, products)
            _accepted_total(proposed["total"], body.expected_total, proposed["lines"])
            await _check_stock(
                connection, products, proposed["lines"], old, order_id, False, now
            )
            revision = await _append_revision(
                connection, order_id, user.id, proposed["lines"], proposed["total"]
            )
            await connection.execute(
                "UPDATE orders SET current_revision=$2,status=$3,version=version+1 WHERE id=$1",
                order_id,
                revision,
                "awaiting_payment" if proposed["lines"] else "cancelled",
            )
            await _bump_group(connection, group["id"])
            return await read_order(connection, order_id)

        return await _locked_order(pool, user, order_id, action)

    @app.post("/api/orders/{order_id}/cancel")
    async def cancel_order(
        order_id: UUID, body: CancelBody, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        async def action(connection: Any, order: Any, group: Any) -> dict[str, Any]:
            if order["status"] == "cancelled":
                return await read_order(connection, order_id)
            _open_package(group)
            await _check_version(connection, order, body.version)
            old = await _lines_for(connection, order["current_revision"])
            await _products_for(connection, [], old, lock=True)
            await _awaiting(connection, order, await _database_time(connection))
            await connection.execute(
                "UPDATE orders SET status='cancelled',version=version+1 WHERE id=$1", order_id
            )
            await _bump_group(connection, group["id"])
            return await read_order(connection, order_id)

        return await _locked_order(pool, user, order_id, action)

    @app.post("/api/orders/{order_id}/evidence")
    async def submit_evidence(
        order_id: UUID, body: EvidenceBody, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        async def action(connection: Any, order: Any, group: Any) -> dict[str, Any]:
            existing = await connection.fetch(
                "SELECT media_id FROM payment_evidence WHERE order_id=$1 ORDER BY media_id", order_id
            )
            submitted = sorted(body.media_ids)
            if existing and [row["media_id"] for row in existing] == submitted:
                return await read_order(connection, order_id)
            _open_package(group)
            await _check_version(connection, order, body.version)
            old = await _lines_for(connection, order["current_revision"])
            products = await _products_for(connection, [], old, lock=True)
            now = await _database_time(connection)
            await _awaiting(connection, order, now)
            # Lock uploads against abandoned-media cleanup until they have durable references.
            media = await connection.fetch(
                "SELECT id,user_id,kind FROM media WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
                submitted,
            )
            by_id = {row["id"]: row for row in media}
            if len(media) != len(submitted) or any(
                by_id.get(media_id) is None
                or by_id[media_id]["user_id"] != order["user_id"]
                or by_id[media_id]["kind"] != "evidence"
                for media_id in submitted
            ):
                raise ApiError(
                    400,
                    "invalid_evidence",
                    "Select successfully uploaded screenshots belonging to this order owner.",
                )
            used = await connection.fetchval(
                "SELECT 1 FROM payment_evidence WHERE media_id=ANY($1::uuid[])", submitted
            )
            if used:
                raise ApiError(
                    409, "evidence_used", "A screenshot is already attached to another submission."
                )
            # Media waits can cross the deadline: sample once more immediately before accepting.
            submitted_at = await _database_time(connection)
            await _awaiting(connection, order, submitted_at)
            await _check_stock(connection, products, old, old, order_id, False, submitted_at)
            for media_id in submitted:
                await connection.execute(
                    """INSERT INTO payment_evidence(id,order_id,revision_id,media_id,created_at)
                       VALUES($1,$2,$3,$4,$5::text::timestamptz)""",
                    uuid.uuid4(),
                    order_id,
                    order["current_revision"],
                    media_id,
                    submitted_at,
                )
            await connection.execute(
                "UPDATE orders SET status='payment_review',version=version+1 WHERE id=$1", order_id
            )
            await _bump_group(connection, group["id"])
            return await read_order(connection, order_id)

        return await _locked_order(pool, user, order_id, action)

    @app.post("/api/seller/orders/{order_id}/payment")
    async def decide_payment(
        order_id: UUID, body: PaymentBody, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        seller(user)
        if body.decision == "rejected" and not body.reason:
            raise ApiError(
                400,
                "invalid_input",
                "Check the submitted fields.",
                [{"field": "reason", "message": "Explain why payment was rejected."}],
            )

        async def action(connection: Any, order: Any, group: Any) -> dict[str, Any]:
            existing = await connection.fetchrow(
                "SELECT decision FROM payment_decisions WHERE order_id=$1", order_id
            )
            if existing is not None:
                if existing["decision"] == body.decision:
                    return await read_order(connection, order_id)
                raise ApiError(
                    409,
                    "payment_already_decided",
                    "This payment already has a final decision.",
                    {"order": await read_order(connection, order_id)},
                )
            _open_package(group)
            await _check_version(connection, order, body.version)
            if order["status"] != "payment_review":
                raise ApiError(
                    409,
                    "invalid_order_state",
                    "Only submitted evidence can receive a payment decision.",
                )
            old = await _lines_for(connection, order["current_revision"])
            products = await _products_for(connection, [], old, lock=True)
            now = await _database_time(connection)
            if body.decision == "confirmed":
                await _check_stock(connection, products, old, old, order_id, False, now)
                await _adjust_paid_stock(connection, products, [], old)
            await connection.execute(
                """INSERT INTO payment_decisions(id,order_id,revision_id,seller_id,decision,reason)
                   VALUES($1,$2,$3,$4,$5,$6)""",
                uuid.uuid4(),
                order_id,
                order["current_revision"],
                user.id,
                body.decision,
                body.reason or "",
            )
            await connection.execute(
                "UPDATE orders SET status=$2,version=version+1 WHERE id=$1",
                order_id,
                "paid" if body.decision == "confirmed" else "payment_rejected",
            )
            await _bump_group(connection, group["id"])
            return await read_order(connection, order_id)

        return await _locked_order(pool, user, order_id, action)

    @app.post("/api/orders/{order_id}/changes")
    async def request_change(
        order_id: UUID, body: ChangeBody, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        async def action(connection: Any, order: Any, group: Any) -> dict[str, Any]:
            _open_package(group)
            await _check_version(connection, order, body.version)
            if order["status"] not in {"payment_review", "paid"}:
                raise ApiError(
                    409,
                    "invalid_order_state",
                    "Reviewed changes require submitted evidence or a paid order.",
                )
            pending = await connection.fetchval(
                "SELECT 1 FROM change_requests WHERE order_id=$1 AND state='pending'", order_id
            )
            if pending:
                raise ApiError(
                    409,
                    "change_pending",
                    "Withdraw or resolve the existing change request first.",
                )
            old = await _lines_for(connection, order["current_revision"])
            products = await _products_for(connection, body.items, old, lock=False)
            proposed = _quote(body.items, old, products)
            _accepted_total(proposed["total"], body.expected_total, proposed["lines"])
            await connection.execute(
                """INSERT INTO change_requests(id,order_id,base_revision,selection,requested_total,note)
                   VALUES($1,$2,$3,$4::jsonb,$5,$6)""",
                uuid.uuid4(),
                order_id,
                order["current_revision"],
                [
                    {"productId": str(item.product_id), "quantity": item.quantity}
                    for item in body.items
                ],
                proposed["total"],
                body.note or "",
            )
            await connection.execute(
                "UPDATE orders SET version=version+1 WHERE id=$1", order_id
            )
            await _bump_group(connection, group["id"])
            return await read_order(connection, order_id)

        return await _locked_order(pool, user, order_id, action)

    @app.post("/api/orders/{order_id}/changes/{change_id}/withdraw")
    async def withdraw_change(
        order_id: UUID,
        change_id: UUID,
        body: CancelBody,
        user: User = Depends(authenticate),
    ) -> dict[str, Any]:
        async def action(connection: Any, order: Any, group: Any) -> dict[str, Any]:
            change = await _requested_change(connection, order_id, change_id)
            if change["state"] == "withdrawn":
                return await read_order(connection, order_id)
            _open_package(group)
            await _check_version(connection, order, body.version)
            if change["state"] != "pending":
                raise ApiError(
                    409, "change_resolved", "This change request is already resolved."
                )
            await connection.execute(
                "UPDATE change_requests SET state='withdrawn',resolved_at=clock_timestamp() WHERE id=$1",
                change_id,
            )
            await connection.execute(
                "UPDATE orders SET version=version+1 WHERE id=$1", order_id
            )
            await _bump_group(connection, group["id"])
            return await read_order(connection, order_id)

        return await _locked_order(pool, user, order_id, action)

    @app.post("/api/seller/orders/{order_id}/changes/{change_id}/resolve")
    async def resolve_change(
        order_id: UUID,
        change_id: UUID,
        body: ResolveBody,
        user: User = Depends(authenticate),
    ) -> dict[str, Any]:
        seller(user)

        async def action(connection: Any, order: Any, group: Any) -> dict[str, Any]:
            change = await _requested_change(connection, order_id, change_id)
            if change["state"] == body.decision:
                return await read_order(connection, order_id)
            _open_package(group)
            await _check_version(connection, order, body.version)
            if change["state"] != "pending":
                raise ApiError(
                    409, "change_resolved", "This change request is already resolved."
                )
            if body.decision == "rejected":
                await connection.execute(
                    """UPDATE change_requests SET state='rejected',seller_id=$2,reason=$3,
                       resolved_at=clock_timestamp() WHERE id=$1""",
                    change_id,
                    user.id,
                    body.reason or "",
                )
            else:
                if order["status"] not in {"payment_review", "paid"}:
                    raise ApiError(
                        409,
                        "invalid_order_state",
                        "This order no longer permits correction approval. Reject the request instead.",
                    )
                if change["base_revision"] != order["current_revision"]:
                    raise ApiError(
                        409,
                        "stale_change",
                        "The accepted selection changed since this request was made.",
                    )
                old = await _lines_for(connection, order["current_revision"])
                items = await _parse_selection(change["selection"])
                products = await _products_for(connection, items, old, lock=True)
                now = await _database_time(connection)
                proposed = _quote(items, old, products)
                _accepted_total(
                    proposed["total"],
                    change["requested_total"],
                    proposed["lines"],
                    "requested_price_changed",
                )
                previous_total = await connection.fetchval(
                    "SELECT total FROM order_revisions WHERE id=$1", order["current_revision"]
                )
                difference = proposed["total"] - previous_total
                if difference != 0 and not body.settlement_note:
                    raise ApiError(
                        409,
                        "settlement_required",
                        "Record the externally settled additional payment or refund before approving.",
                        {"difference": difference},
                    )
                await _check_stock(
                    connection,
                    products,
                    proposed["lines"],
                    old,
                    order_id,
                    order["status"] == "paid",
                    now,
                )
                if order["status"] == "paid":
                    await _adjust_paid_stock(connection, products, old, proposed["lines"])
                revision = await _append_revision(
                    connection, order_id, user.id, proposed["lines"], proposed["total"]
                )
                await connection.execute(
                    "UPDATE orders SET current_revision=$2 WHERE id=$1", order_id, revision
                )
                await connection.execute(
                    """UPDATE change_requests SET state='approved',resolved_revision=$2,seller_id=$3,
                       difference=$4,settlement_note=$5,reason=$6,resolved_at=clock_timestamp()
                       WHERE id=$1""",
                    change_id,
                    revision,
                    user.id,
                    difference,
                    body.settlement_note or "",
                    body.reason or "",
                )
            await connection.execute(
                "UPDATE orders SET version=version+1 WHERE id=$1", order_id
            )
            await _bump_group(connection, group["id"])
            return await read_order(connection, order_id)

        return await _locked_order(pool, user, order_id, action)


async def expire_orders(pool: asyncpg.Pool) -> int:
    total = 0
    while True:
        async with transaction(pool) as connection:
            candidates = await connection.fetch(
                """SELECT id,group_id FROM orders
                   WHERE status='awaiting_payment' AND deadline<=clock_timestamp()
                   ORDER BY id LIMIT 100"""
            )
            if not candidates:
                return total
            groups = sorted({row["group_id"] for row in candidates})
            await connection.fetch(
                "SELECT id FROM fulfillment_groups WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
                groups,
            )
            orders = await connection.fetch(
                """SELECT * FROM orders
                   WHERE id=ANY($1::uuid[]) AND group_id=ANY($2::uuid[])
                     AND status='awaiting_payment' ORDER BY id FOR UPDATE""",
                [row["id"] for row in candidates],
                groups,
            )
            product_ids = await connection.fetch(
                """SELECT DISTINCT l.product_id FROM order_lines l
                   JOIN orders o ON o.current_revision=l.revision_id
                   WHERE o.id=ANY($1::uuid[]) ORDER BY l.product_id""",
                [row["id"] for row in orders],
            )
            if product_ids:
                await connection.fetch(
                    "SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
                    [row["product_id"] for row in product_ids],
                )
            now = await _database_time(connection)
            result = await connection.fetch(
                """UPDATE orders SET status='expired',version=version+1
                   WHERE id=ANY($1::uuid[]) AND status='awaiting_payment'
                     AND deadline<=$2::text::timestamptz
                   RETURNING group_id""",
                [row["id"] for row in orders],
                now,
            )
            for group_id in sorted({row["group_id"] for row in result}):
                await _bump_group(connection, group_id)
            total += len(result)
            if not result:
                return total
