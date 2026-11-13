"""Fulfillment contract: packages, shared codes, atomic shipment, leftovers."""

from __future__ import annotations

import re
import uuid
from typing import Any

from .helpers import ALICE, BOB, SELLER, Env, session
from .support import (
    checkout,
    confirm,
    group_of,
    order_of,
    patch_group,
    pay,
    pending_change,
    product_detail,
    published_product,
    request_change,
    resolve,
    review,
    selection,
    ship,
    quantities,
)
from .uploads import bearer


async def test_one_open_package_and_a_shared_delivery_code(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    bob = await session(env, BOB)
    product = await published_product(env, seller, stock=8)

    first = (await checkout(env, alice, selection(product["id"], 1))).json()
    group = await group_of(env, alice, first["group_id"])
    assert (group["state"], group["method"], group["delivery_code"]) == ("open", None, None)
    assert re.fullmatch(r"ORD-\d+", first["reference"])

    second = (await checkout(env, alice, selection(product["id"], 1))).json()
    assert second["group_id"] == first["group_id"]
    assert re.fullmatch(r"ORD-\d+", second["reference"])
    assert int(second["reference"][4:]) > int(first["reference"][4:])
    group = await group_of(env, alice, group["id"])
    assert len(group["orders"]) == 2

    unchanged = await patch_group(env, alice, group)
    assert unchanged.status_code == 200
    assert unchanged.json()["delivery_code"] is None
    assert unchanged.json()["version"] == group["version"]

    by_customer = await patch_group(env, alice, group, "External-request-123")
    assert by_customer.status_code == 200, by_customer.text
    group = by_customer.json()
    assert group["delivery_code"] == "External-request-123"
    kept = await patch_group(env, alice, group)
    assert kept.status_code == 200
    assert kept.json()["delivery_code"] == "External-request-123"
    assert kept.json()["version"] == group["version"]
    group = kept.json()

    by_seller = await patch_group(env, seller, group, "Seller-replacement")
    assert by_seller.status_code == 200
    group = by_seller.json()
    assert group["delivery_code"] == "Seller-replacement"

    previous = group["version"]
    cleared = await patch_group(env, alice, group, None)
    assert cleared.status_code == 200
    assert cleared.json()["delivery_code"] is None

    stale = await patch_group(
        env, alice, {"id": cleared.json()["id"], "version": previous}, "stale"
    )
    assert stale.status_code == 409
    assert stale.json()["error"] == "stale_version"

    foreign = await patch_group(env, bob, cleared.json(), "not-mine")
    assert foreign.status_code == 404

    multiline = await patch_group(env, alice, cleared.json(), "bad\ncode")
    assert multiline.status_code == 400
    assert multiline.json()["error"] == "invalid_input"

    assert await env.pool.fetchval("SELECT count(*) FROM orders") == 2
    assert await env.pool.fetchval(
        "SELECT count(*) FROM fulfillment_groups WHERE state='open'"
    ) == 1


async def test_ship_paid_orders_and_move_unpaid_and_review_held_ones(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    paid_product = await published_product(env, seller, stock=10, name="Paid")
    unpaid_product = await published_product(env, seller, stock=10, name="Unpaid")

    first = await confirm(env, alice, seller, (await checkout(env, alice, selection(paid_product["id"], 2))).json())
    second = await confirm(env, alice, seller, (await checkout(env, alice, selection(paid_product["id"], 1))).json())
    unpaid = (await checkout(env, alice, selection(unpaid_product["id"], 2))).json()
    reviewed = (await review(env, alice, (await checkout(env, alice, selection(unpaid_product["id"], 1))).json())).json()
    assert first["group_id"] == second["group_id"] == unpaid["group_id"] == reviewed["group_id"]

    group = await group_of(env, alice, first["group_id"])
    group = (await patch_group(env, alice, group, "Keep-with-paid-package")).json()
    assert quantities((await group_of(env, seller, group["id"]))["packing_lines"]) == {
        paid_product["id"]: 3
    }
    before_paid = await product_detail(env, alice, paid_product["id"])
    before_unpaid = await product_detail(env, alice, unpaid_product["id"])

    shipped_response = await ship(env, seller, group)
    assert shipped_response.status_code == 200, shipped_response.text
    shipped = shipped_response.json()
    assert (shipped["state"], shipped["completion_kind"], shipped["method"]) == (
        "completed",
        "sent",
        "delivery",
    )
    assert shipped["delivery_code"] == "Keep-with-paid-package"
    assert shipped["completed_at"]
    assert {order["id"] for order in shipped["orders"]} == {first["id"], second["id"]}
    assert quantities(shipped["packing_lines"]) == {paid_product["id"]: 3}

    moved_unpaid = await order_of(env, alice, unpaid["id"])
    moved_review = await order_of(env, alice, reviewed["id"])
    assert moved_unpaid["group_id"] == moved_review["group_id"]
    assert moved_unpaid["group_id"] != shipped["id"]
    assert moved_unpaid["status"] == "awaiting_payment"
    assert moved_review["status"] == "payment_review"
    assert moved_unpaid["deadline"] == unpaid["deadline"]
    assert moved_review["evidence"] == reviewed["evidence"]

    remaining = await group_of(env, alice, moved_unpaid["group_id"])
    assert (remaining["state"], remaining["method"], remaining["delivery_code"]) == (
        "open",
        None,
        None,
    )
    assert (await product_detail(env, alice, paid_product["id"]))["remaining_unsold"] == before_paid["remaining_unsold"]
    assert (await product_detail(env, alice, unpaid_product["id"]))["reserved"] == before_unpaid["reserved"]

    fresh = await confirm(env, alice, seller, (await checkout(env, alice, selection(paid_product["id"], 1))).json())
    assert fresh["group_id"] != shipped["id"]

    shipped_order = await order_of(env, alice, first["id"])
    blocked_change = await request_change(env, alice, shipped_order, [])
    assert blocked_change.status_code == 409
    assert blocked_change.json()["error"] == "package_completed"
    blocked_edit = await patch_group(env, alice, shipped, "too-late")
    assert blocked_edit.status_code == 409
    assert blocked_edit.json()["error"] == "package_completed"


async def test_shipping_requires_paid_items_and_a_resolved_correction(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    bob = await session(env, BOB)
    product = await published_product(env, seller, stock=5)

    bob_order = (await checkout(env, bob, selection(product["id"], 1))).json()
    bob_group = await group_of(env, bob, bob_order["group_id"])
    no_paid = await ship(env, seller, bob_group)
    assert no_paid.status_code == 409
    assert no_paid.json()["error"] == "no_paid_items"

    order = await confirm(env, alice, seller, (await checkout(env, alice, selection(product["id"], 2))).json())
    group = await group_of(env, alice, order["group_id"])
    assert group["delivery_code"] is None
    changed = await request_change(env, alice, order, selection(product["id"], 1))
    assert changed.status_code == 200
    order = changed.json()
    group = await group_of(env, alice, order["group_id"])
    pending = await ship(env, seller, group)
    assert pending.status_code == 409
    assert pending.json()["error"] == "pending_changes"

    order = (await resolve(env, seller, order, pending_change(order)["id"], "rejected", reason="Keep both")).json()
    group = await group_of(env, alice, order["group_id"])
    missing = await ship(env, seller, group)
    assert missing.status_code == 409
    assert missing.json()["error"] == "missing_delivery_code"
    assert (await group_of(env, alice, group["id"]))["state"] == "open"

    before = await product_detail(env, alice, product["id"])
    shipped = (await ship(env, seller, group, allow_missing=True)).json()
    assert (shipped["state"], shipped["completion_kind"]) == ("completed", "sent")
    repeated = await ship(env, seller, shipped, allow_missing=True)
    assert repeated.status_code == 200
    assert repeated.json()["version"] == shipped["version"]
    assert repeated.json()["completed_at"] == shipped["completed_at"]

    after = await product_detail(env, alice, product["id"])
    assert (after["remaining_unsold"], after["bought"]) == (
        before["remaining_unsold"],
        before["bought"],
    )
    current_order = await order_of(env, alice, order["id"])
    assert current_order["status"] == "paid"
    assert current_order["decision"] == order["decision"]
    assert (await patch_group(env, alice, shipped, "too-late")).status_code == 409
    assert (await request_change(env, alice, current_order, [])).status_code == 409

    following = (await checkout(env, alice, selection(product["id"], 1))).json()
    assert following["group_id"] != shipped["id"]
    assert (await group_of(env, alice, shipped["id"]))["completion_kind"] == "sent"


async def test_in_person_handover_ignores_and_discards_the_delivery_code(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    product = await published_product(env, seller, stock=3)
    paid = await confirm(env, alice, seller, (await checkout(env, alice, selection(product["id"], 1))).json())
    group = await group_of(env, alice, paid["group_id"])
    assert group["method"] is None
    group = (await patch_group(env, alice, group, "Ignored-on-handover")).json()
    assert group["delivery_code"] == "Ignored-on-handover"

    shipped = (await ship(env, seller, group, method="in_person")).json()
    assert (shipped["completion_kind"], shipped["method"], shipped["delivery_code"]) == (
        "handed_over",
        "in_person",
        None,
    )
    assert (await product_detail(env, alice, product["id"]))["remaining_unsold"] == 2
    assert (await order_of(env, alice, paid["id"]))["status"] == "paid"


async def test_empty_open_package_is_hidden_and_reused(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    product = await published_product(env, seller, stock=2)
    package_id = "99999999-9999-9999-9999-999999999999"
    await env.pool.execute(
        "INSERT INTO fulfillment_groups(id,user_id) VALUES($1,'2001')", uuid.UUID(package_id)
    )

    assert (await env.client.get("/api/groups", headers=bearer(alice))).json() == []
    assert (await env.client.get("/api/seller/groups", headers=bearer(seller))).json() == []
    assert (await env.client.get(f"/api/groups/{package_id}", headers=bearer(alice))).status_code == 404

    order = (await checkout(env, alice, selection(product["id"], 1))).json()
    assert order["group_id"] == package_id
    groups = (await env.client.get("/api/groups", headers=bearer(alice))).json()
    assert len(groups) == 1
    assert len(groups[0]["orders"]) == 1
