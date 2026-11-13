"""Fulfillment packages: one open package per customer, shared code, atomic shipment."""

from __future__ import annotations

import re
import uuid
from typing import Annotated, Any, Literal
from uuid import UUID

import asyncpg
from fastapi import Depends, FastAPI
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from .auth import authenticate
from .config import Settings
from .db import transaction
from .http import ApiError, User, check_version, owner, seller

VERSION = Annotated[int, Field(ge=1, le=2_147_483_647)]
DeliveryCode = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]

GROUP_SELECT = """SELECT g.*,jsonb_build_object('first_name',c.first_name,'username',c.username) AS customer,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',o.id,'reference',o.reference,'user_id',o.user_id,'group_id',o.group_id,
    'status',CASE WHEN o.status='awaiting_payment' AND o.deadline<=clock_timestamp() THEN 'expired' ELSE o.status END,
    'total',r.total,'currency',o.currency,'deadline',o.deadline,'current_revision',o.current_revision,
    'version',o.version,'created_at',o.created_at,
    'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id',l.product_id,'name',l.name,'unit_price',l.unit_price,'quantity',l.quantity) ORDER BY l.position)
                    FROM order_lines l WHERE l.revision_id=o.current_revision),'[]'::jsonb),
    'changes',COALESCE((SELECT jsonb_agg(to_jsonb(cr) ORDER BY cr.created_at,cr.id) FROM change_requests cr WHERE cr.order_id=o.id),'[]'::jsonb)
  ) ORDER BY o.created_at,o.id) FROM orders o JOIN order_revisions r ON r.id=o.current_revision WHERE o.group_id=g.id),'[]'::jsonb) AS orders,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id',pl.product_id,'name',pl.name,'unit_price',pl.unit_price,'quantity',pl.quantity)
                             ORDER BY pl.product_id,pl.name,pl.unit_price) FROM (
    SELECT l.product_id,l.name,l.unit_price,SUM(l.quantity)::bigint AS quantity
    FROM orders o JOIN order_lines l ON l.revision_id=o.current_revision WHERE o.group_id=g.id AND o.status='paid'
    GROUP BY l.product_id,l.name,l.unit_price
  ) pl),'[]'::jsonb) AS packing_lines
  FROM fulfillment_groups g JOIN customers c ON c.id=g.user_id"""


class GroupEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: VERSION
    delivery_code: DeliveryCode | None = Field(default=None, alias="deliveryCode")

    @field_validator("delivery_code")
    @classmethod
    def _single_line(cls, value: str | None) -> str | None:
        if value is not None and re.search(r"[\u0000-\u001f\u007f]", value):
            raise ValueError("Use a single-line delivery code.")
        return value


class ShipBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: VERSION
    method: Literal["delivery", "in_person"]
    delivery_code: DeliveryCode | None = Field(default=None, alias="deliveryCode")
    allow_missing_code: bool = Field(default=False, alias="allowMissingCode")

    @field_validator("delivery_code")
    @classmethod
    def _single_line(cls, value: str | None) -> str | None:
        if value is not None and re.search(r"[\u0000-\u001f\u007f]", value):
            raise ValueError("Use a single-line delivery code.")
        return value


async def _read_groups(
    db: Any,
    *,
    group_id: UUID | None = None,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
    # An open package with no orders is transient; do not list it.
    conditions = ["(g.state <> 'open' OR EXISTS(SELECT 1 FROM orders o WHERE o.group_id=g.id))"]
    params: list[Any] = []
    if group_id is not None:
        params.append(group_id)
        conditions.append(f"g.id=${len(params)}")
    if user_id is not None:
        params.append(user_id)
        conditions.append(f"g.user_id=${len(params)}")
    rows = await db.fetch(
        f"{GROUP_SELECT} WHERE {' AND '.join(conditions)} ORDER BY g.created_at,g.id", *params
    )
    return [dict(row) for row in rows]


async def _lock_group(connection: Any, group_id: UUID) -> dict[str, Any]:
    group = await connection.fetchrow(
        "SELECT * FROM fulfillment_groups WHERE id=$1 FOR UPDATE", group_id
    )
    if group is None:
        raise ApiError(404, "not_found", "Fulfillment group not found")
    return dict(group)


async def _lock_orders(connection: Any, group_id: UUID) -> list[dict[str, Any]]:
    rows = await connection.fetch(
        "SELECT id,status FROM orders WHERE group_id=$1 ORDER BY id FOR UPDATE", group_id
    )
    return [dict(row) for row in rows]


async def _require_shippable(connection: Any, group_id: UUID) -> None:
    pending = await connection.fetchval(
        """SELECT 1 FROM change_requests cr JOIN orders o ON o.id=cr.order_id
           WHERE o.group_id=$1 AND cr.state='pending' LIMIT 1""",
        group_id,
    )
    if pending:
        raise ApiError(
            409,
            "pending_changes",
            "Resolve or withdraw all pending item-change requests before shipping.",
        )
    paid = await connection.fetchval(
        """SELECT 1 FROM orders o JOIN order_lines l ON l.revision_id=o.current_revision
           WHERE o.group_id=$1 AND o.status='paid' LIMIT 1""",
        group_id,
    )
    if not paid:
        raise ApiError(
            409, "no_paid_items", "At least one paid item is required to ship a package."
        )


def register_fulfillment(app: FastAPI, pool: asyncpg.Pool, _config: Settings) -> None:
    @app.get("/api/groups")
    async def list_groups(user: User = Depends(authenticate)) -> list[dict[str, Any]]:
        return await _read_groups(pool, user_id=user.id)

    @app.get("/api/seller/groups")
    async def list_all_groups(user: User = Depends(authenticate)) -> list[dict[str, Any]]:
        seller(user)
        return await _read_groups(pool)

    @app.get("/api/groups/{group_id}")
    async def group_detail(
        group_id: UUID, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        groups = await _read_groups(pool, group_id=group_id)
        if not groups:
            raise ApiError(404, "not_found", "Fulfillment group not found")
        owner(user, groups[0]["user_id"])
        return groups[0]

    @app.patch("/api/groups/{group_id}")
    async def edit_group(
        group_id: UUID, body: GroupEdit, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        async with transaction(pool) as connection:
            group = await _lock_group(connection, group_id)
            if group["user_id"] != user.id and not user.is_seller:
                raise ApiError(404, "not_found", "Fulfillment group not found")
            if group["state"] != "open":
                raise ApiError(
                    409,
                    "package_completed",
                    "Shipment details cannot change after the package is shipped.",
                )
            check_version(group["version"], body.version)
            if "delivery_code" in body.model_fields_set:
                code = body.delivery_code or None
            else:
                code = group["delivery_code"]
            if group["delivery_code"] != code:
                await connection.execute(
                    "UPDATE fulfillment_groups SET delivery_code=$2,version=version+1 WHERE id=$1",
                    group_id,
                    code,
                )
            return (await _read_groups(connection, group_id=group_id))[0]

    @app.post("/api/seller/groups/{group_id}/ship")
    async def ship_group(
        group_id: UUID, body: ShipBody, user: User = Depends(authenticate)
    ) -> dict[str, Any]:
        seller(user)
        async with transaction(pool) as connection:
            group = await _lock_group(connection, group_id)
            if group["state"] == "completed":
                return (await _read_groups(connection, group_id=group_id))[0]
            check_version(group["version"], body.version)
            orders = await _lock_orders(connection, group_id)
            await _require_shippable(connection, group_id)
            if body.method == "in_person":
                code = None
            elif "delivery_code" in body.model_fields_set:
                code = body.delivery_code or None
            else:
                code = group["delivery_code"]
            if body.method == "delivery" and not code and not body.allow_missing_code:
                raise ApiError(
                    409,
                    "missing_delivery_code",
                    "No delivery code was supplied. Confirm explicitly to ship without a code.",
                    {"allowMissingCode": True},
                )
            # Close the package before opening the leftover package, so the
            # one-open-per-customer index allows it.
            await connection.execute(
                """UPDATE fulfillment_groups SET state='completed',method=$2,delivery_code=$3,
                   completion_kind=$4,completed_at=clock_timestamp(),version=version+1
                   WHERE id=$1""",
                group_id,
                body.method,
                code,
                "sent" if body.method == "delivery" else "handed_over",
            )
            if any(order["status"] != "paid" for order in orders):
                remaining_id = uuid.uuid4()
                await connection.execute(
                    "INSERT INTO fulfillment_groups(id,user_id) VALUES($1,$2)",
                    remaining_id,
                    group["user_id"],
                )
                await connection.execute(
                    """UPDATE orders SET group_id=$2,version=version+1
                       WHERE group_id=$1 AND status<>'paid'""",
                    group_id,
                    remaining_id,
                )
            return (await _read_groups(connection, group_id=group_id))[0]
