"""Order contract: reservations, revisions, evidence, payments, corrections, expiry."""

from __future__ import annotations

import asyncio
from typing import Any

from shop.orders import expire_orders

from .helpers import ALICE, BOB, SELLER, Env, session
from .support import (
    checkout,
    order_of,
    pay,
    preview,
    product_detail,
    published_product,
    pending_change,
    request_change,
    resolve,
    review,
    selection,
    withdraw,
)
from .uploads import bearer, upload


async def test_preview_holds_nothing_and_only_one_buyer_wins_the_last_unit(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    bob = await session(env, BOB)
    product = await published_product(env, seller, stock=1)

    quoted = await preview(env, alice, selection(product["id"]))
    assert quoted["total"] == 100
    detail = await product_detail(env, alice, product["id"])
    assert (detail["reserved"], detail["available"], detail["remaining_unsold"]) == (0, 1, 1)

    first, second = await asyncio.gather(
        checkout(env, alice, selection(product["id"]), key="alice-last"),
        checkout(env, bob, selection(product["id"]), key="bob-last"),
    )
    assert sorted((first.status_code, second.status_code)) == [200, 409]
    failure = first if first.status_code == 409 else second
    assert failure.json()["error"] == "stock_conflict"
    assert await env.pool.fetchval("SELECT count(*) FROM orders") == 1
    assert (await product_detail(env, alice, product["id"]))["available"] == 0


async def test_checkout_is_all_or_nothing_and_rejects_bad_selections(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    first = await published_product(env, seller, stock=1, name="Scarce")
    second = await published_product(env, seller, stock=5, name="Plenty")
    held = (await checkout(env, alice, selection(first["id"]))).json()

    failed = await checkout(
        env,
        alice,
        [
            {"productId": first["id"], "quantity": 1},
            {"productId": second["id"], "quantity": 1},
        ],
    )
    assert failed.status_code == 409
    assert failed.json()["error"] == "stock_conflict"
    assert await env.pool.fetchval("SELECT count(*) FROM orders") == 1
    assert (await product_detail(env, alice, second["id"]))["remaining_unsold"] == 5

    for items in ([], [{"productId": first["id"], "quantity": 0}]):
        response = await env.client.post(
            "/api/orders",
            headers=bearer(alice),
            json={"items": items, "expectedTotal": 0, "key": "bad"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "invalid_input"

    duplicate = [{"productId": second["id"], "quantity": 1}] * 2
    response = await env.client.post(
        "/api/orders",
        headers=bearer(alice),
        json={"items": duplicate, "expectedTotal": 200, "key": "duplicate"},
    )
    assert response.status_code == 400

    unknown = await env.client.post(
        "/api/orders",
        headers=bearer(alice),
        json={
            "items": [{"productId": "00000000-0000-4000-8000-000000000000", "quantity": 1}],
            "expectedTotal": 100,
            "key": "unknown",
        },
    )
    assert unknown.status_code == 409
    assert unknown.json()["error"] == "product_unavailable"

    draft_image = (await upload(env, seller, b"product")).json()["id"]
    draft = await env.client.post(
        "/api/seller/products",
        headers=bearer(seller),
        json={"name": "Draft", "price": 100, "stock": 1, "imageIds": [draft_image]},
    )
    assert draft.status_code == 200
    hidden = await env.client.post(
        "/api/orders",
        headers=bearer(alice),
        json={"items": selection(draft.json()["id"]), "expectedTotal": 100, "key": "draft"},
    )
    assert hidden.status_code == 409
    assert hidden.json()["error"] == "product_unavailable"

    bob = await session(env, BOB)
    foreign = await env.client.post(
        "/api/orders/preview",
        headers=bearer(bob),
        json={"items": selection(first["id"]), "orderId": held["id"]},
    )
    assert foreign.status_code == 404


async def test_price_acceptance_and_idempotent_checkout(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    product = await published_product(env, seller, price=100, stock=5)
    items = selection(product["id"])

    patched = await env.client.patch(
        f"/api/seller/products/{product['id']}",
        headers=bearer(seller),
        json={
            "version": product["version"],
            "name": product["name"],
            "comment": "",
            "price": 200,
            "stock": 5,
            "imageIds": product["images"],
        },
    )
    assert patched.status_code == 200

    stale_price = await checkout(env, alice, items, expected_total=100, key="price-key")
    assert stale_price.status_code == 409
    assert stale_price.json()["error"] == "price_changed"
    assert stale_price.json()["details"]["total"] == 200

    # The failed attempt at the old price must not have written a submission.
    accepted = await checkout(env, alice, items, expected_total=200, key="price-key")
    assert accepted.status_code == 200, accepted.text
    order = accepted.json()
    assert order["total"] == 200

    replay = await checkout(env, alice, items, expected_total=200, key="price-key")
    assert replay.status_code == 200
    assert replay.json()["id"] == order["id"]
    assert await env.pool.fetchval("SELECT count(*) FROM checkout_submissions") == 1
    assert await env.pool.fetchval("SELECT count(*) FROM orders") == 1

    conflict = await checkout(env, alice, items, expected_total=201, key="price-key")
    assert conflict.status_code == 409
    assert conflict.json()["error"] == "idempotency_conflict"


async def test_unpaid_edits_keep_accepted_lots_and_the_original_deadline(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    product = await published_product(env, seller, price=100, stock=20)
    order = (await checkout(env, alice, selection(product["id"], 3))).json()
    deadline = order["deadline"]

    patched = await env.client.patch(
        f"/api/seller/products/{product['id']}",
        headers=bearer(seller),
        json={
            "version": product["version"],
            "name": product["name"],
            "comment": "",
            "price": 200,
            "stock": 20,
            "imageIds": product["images"],
        },
    )
    assert patched.status_code == 200

    reduced = await env.client.patch(
        f"/api/orders/{order['id']}",
        headers=bearer(alice),
        json={"version": order["version"], "items": selection(product["id"], 1), "expectedTotal": 100},
    )
    assert reduced.status_code == 200, reduced.text
    assert reduced.json()["total"] == 100
    assert reduced.json()["deadline"] == deadline

    increased = await env.client.patch(
        f"/api/orders/{order['id']}",
        headers=bearer(alice),
        json={"version": reduced.json()["version"], "items": selection(product["id"], 3), "expectedTotal": 500},
    )
    assert increased.status_code == 200, increased.text
    assert increased.json()["total"] == 500
    assert [(line["unit_price"], line["quantity"]) for line in increased.json()["lines"]] == [
        (100, 1),
        (200, 2),
    ]
    assert increased.json()["deadline"] == deadline

    stale = await env.client.patch(
        f"/api/orders/{order['id']}",
        headers=bearer(alice),
        json={
            "version": increased.json()["version"] - 1,
            "items": selection(product["id"], 1),
            "expectedTotal": 100,
        },
    )
    assert stale.status_code == 409
    assert stale.json()["error"] == "stale_version"
    assert stale.json()["details"]["order"]["version"] == increased.json()["version"]

    expiring = (await checkout(env, alice, selection(product["id"], 1))).json()
    await env.pool.execute("UPDATE orders SET deadline=clock_timestamp() WHERE id=$1", expiring["id"])
    assert (await order_of(env, alice, expiring["id"]))["status"] == "expired"
    for response in (
        await env.client.patch(
            f"/api/orders/{expiring['id']}",
            headers=bearer(alice),
            json={"version": expiring["version"], "items": [], "expectedTotal": 0},
        ),
        await env.client.post(
            f"/api/orders/{expiring['id']}/cancel",
            headers=bearer(alice),
            json={"version": expiring["version"]},
        ),
    ):
        assert response.status_code == 409
        assert response.json()["error"] == "order_expired"

    cancelled = (await checkout(env, alice, selection(product["id"], 1))).json()
    first_cancel = await env.client.post(
        f"/api/orders/{cancelled['id']}/cancel", headers=bearer(alice), json={"version": cancelled["version"]}
    )
    assert first_cancel.status_code == 200
    assert first_cancel.json()["status"] == "cancelled"
    second_cancel = await env.client.post(
        f"/api/orders/{cancelled['id']}/cancel",
        headers=bearer(alice),
        json={"version": first_cancel.json()["version"]},
    )
    assert second_cancel.status_code == 200
    assert second_cancel.json()["version"] == first_cancel.json()["version"]

    emptied = (await checkout(env, alice, selection(product["id"], 1))).json()
    empty_edit = await env.client.patch(
        f"/api/orders/{emptied['id']}",
        headers=bearer(alice),
        json={"version": emptied["version"], "items": [], "expectedTotal": 0},
    )
    assert empty_edit.status_code == 200
    assert empty_edit.json()["status"] == "cancelled"
    assert empty_edit.json()["total"] == 0
    assert empty_edit.json()["lines"] == []


async def test_evidence_and_exactly_once_payment_decisions(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    bob = await session(env, BOB)
    product = await published_product(env, seller, stock=5)
    order = (await checkout(env, alice, selection(product["id"], 2))).json()

    alice_media = (await upload(env, alice, b"evidence")).json()["id"]
    bob_media = (await upload(env, bob, b"evidence")).json()["id"]
    assert (await order_of(env, alice, order["id"]))["evidence"] == []

    foreign = await review(env, alice, order, [bob_media])
    assert foreign.status_code == 400
    assert foreign.json()["error"] == "invalid_evidence"

    reviewed = await review(env, alice, order, [alice_media])
    assert reviewed.status_code == 200, reviewed.text
    reviewed_order = reviewed.json()
    assert reviewed_order["status"] == "payment_review"
    assert len(reviewed_order["evidence"]) == 1
    assert (await product_detail(env, alice, product["id"]))["reserved"] == 2

    resubmitted = await review(env, alice, reviewed_order, [alice_media])
    assert resubmitted.status_code == 200
    assert resubmitted.json()["version"] == reviewed_order["version"]
    assert await env.pool.fetchval("SELECT count(*) FROM payment_evidence") == 1

    first, second = await asyncio.gather(
        pay(env, seller, reviewed_order),
        pay(env, seller, reviewed_order),
    )
    assert first.status_code == second.status_code == 200
    assert await env.pool.fetchval("SELECT count(*) FROM payment_decisions") == 1
    paid = (await order_of(env, alice, order["id"]))
    assert paid["status"] == "paid"
    detail = await product_detail(env, alice, product["id"])
    assert (detail["remaining_unsold"], detail["bought"]) == (3, 2)

    late_reject = await pay(env, seller, paid, decision="rejected", reason="too late")
    assert late_reject.status_code == 409
    assert late_reject.json()["error"] == "payment_already_decided"
    assert late_reject.json()["details"]["order"]["status"] == "paid"

    rejected_order = (await checkout(env, alice, selection(product["id"], 1))).json()
    rejected_review = (await review(env, alice, rejected_order)).json()
    missing_reason = await pay(env, seller, rejected_review, decision="rejected")
    assert missing_reason.status_code == 400
    assert missing_reason.json()["details"][0]["field"] == "reason"
    rejected = await pay(env, seller, rejected_review, decision="rejected", reason="not received")
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "payment_rejected"
    assert rejected.json()["decision"]["decision"] == "rejected"
    assert (await product_detail(env, alice, product["id"]))["reserved"] == 0

    expiring = (await checkout(env, alice, selection(product["id"], 1))).json()
    expiring_media = (await upload(env, alice, b"evidence")).json()["id"]
    await env.pool.execute("UPDATE orders SET deadline=clock_timestamp() WHERE id=$1", expiring["id"])
    late_evidence = await review(env, alice, expiring, [expiring_media])
    assert late_evidence.status_code == 409
    assert late_evidence.json()["error"] == "order_expired"
    assert await env.pool.fetchval(
        "SELECT count(*) FROM payment_evidence WHERE order_id=$1", expiring["id"]
    ) == 0


async def test_corrections_are_inventory_neutral_until_approved_with_settlement(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    product = await published_product(env, seller, price=100, stock=20)
    order = (await checkout(env, alice, selection(product["id"], 1))).json()
    reviewed = (await review(env, alice, order)).json()
    paid = (await pay(env, seller, reviewed)).json()
    assert paid["status"] == "paid"
    assert (await product_detail(env, alice, product["id"]))["remaining_unsold"] == 19

    add_two = selection(product["id"], 3)
    pending = await request_change(env, alice, paid, add_two)
    assert pending.status_code == 200, pending.text
    pending_order = pending.json()
    change_id = pending_change(pending_order)["id"]
    assert pending_order["changes"][0]["state"] == "pending"
    assert pending_order["total"] == 100
    assert (await product_detail(env, alice, product["id"]))["available"] == 19

    duplicate_pending = await request_change(env, alice, pending_order, add_two)
    assert duplicate_pending.status_code == 409
    assert duplicate_pending.json()["error"] == "change_pending"

    withdrawn = await withdraw(env, alice, pending_order, change_id)
    assert withdrawn.status_code == 200
    assert withdrawn.json()["changes"][0]["state"] == "withdrawn"

    second = (await request_change(env, alice, withdrawn.json(), add_two)).json()
    rejected = await resolve(env, seller, second, pending_change(second)["id"], "rejected", reason="no")
    assert rejected.status_code == 200, rejected.text
    assert next(c for c in rejected.json()["changes"] if c["state"] == "rejected")["state"] == "rejected"

    third = (await request_change(env, alice, rejected.json(), add_two)).json()
    no_settlement = await resolve(env, seller, third, pending_change(third)["id"], "approved")
    assert no_settlement.status_code == 409
    assert no_settlement.json()["error"] == "settlement_required"
    assert no_settlement.json()["details"]["difference"] == 200

    approved = await resolve(
        env, seller, third, pending_change(third)["id"], "approved", settlement="cash received"
    )
    assert approved.status_code == 200, approved.text
    approved_order = approved.json()
    assert approved_order["total"] == 300
    assert next(c for c in approved_order["changes"] if c["state"] == "approved")["difference"] == 200
    detail = await product_detail(env, alice, product["id"])
    assert (detail["remaining_unsold"], detail["bought"]) == (17, 3)

    priced = await request_change(env, alice, approved_order, selection(product["id"], 4))
    assert priced.status_code == 200
    priced_order = priced.json()
    current_product = await product_detail(env, seller, product["id"])
    patched = await env.client.patch(
        f"/api/seller/products/{product['id']}",
        headers=bearer(seller),
        json={
            "version": current_product["version"],
            "name": product["name"],
            "comment": "",
            "price": 200,
            "stock": 17,
            "imageIds": product["images"],
        },
    )
    assert patched.status_code == 200, patched.text
    changed_price = await resolve(
        env,
        seller,
        priced_order,
        pending_change(priced_order)["id"],
        "approved",
        settlement="adjustment",
    )
    assert changed_price.status_code == 409
    assert changed_price.json()["error"] == "requested_price_changed"
    await withdraw(env, alice, priced_order, pending_change(priced_order)["id"])


async def test_payment_succeeds_with_pending_change_and_full_refund_zeroes_revision(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    product = await published_product(env, seller, price=100, stock=20)

    order = (await checkout(env, alice, selection(product["id"], 1))).json()
    reviewed = (await review(env, alice, order)).json()
    pending = await request_change(env, alice, reviewed, selection(product["id"], 1))
    assert pending.status_code == 200
    pending_order = pending.json()
    assert pending_order["total"] == 100  # pending change does not rewrite the accepted total

    confirmed = await pay(env, seller, pending_order)
    assert confirmed.status_code == 200, confirmed.text
    paid = confirmed.json()
    assert paid["status"] == "paid"

    resolved = await resolve(
        env, seller, paid, pending_change(paid)["id"], "approved"
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["total"] == 100
    assert next(c for c in resolved.json()["changes"] if c["state"] == "approved")["difference"] == 0

    before = await product_detail(env, alice, product["id"])
    refund = await request_change(
        env, alice, resolved.json(), []
    )
    assert refund.status_code == 200, refund.text
    refund_order = refund.json()
    approved = await resolve(
        env,
        seller,
        refund_order,
        pending_change(refund_order)["id"],
        "approved",
        settlement="refunded",
    )
    assert approved.status_code == 200, approved.text
    final = approved.json()
    assert final["total"] == 0
    assert final["lines"] == []
    assert next(c for c in final["changes"] if c["state"] == "approved" and c["difference"] == -100)
    after = await product_detail(env, alice, product["id"])
    assert after["remaining_unsold"] == before["remaining_unsold"] + 1
    assert (after["bought"], final["status"]) == (0, "paid")


async def test_expiry_releases_unpaid_holds_but_keeps_review_holds(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    product = await published_product(env, seller, stock=5)

    order = (await checkout(env, alice, selection(product["id"], 2))).json()
    await env.pool.execute("UPDATE orders SET deadline=clock_timestamp() WHERE id=$1", order["id"])
    assert await expire_orders(env.pool) == 1
    assert (await order_of(env, alice, order["id"]))["status"] == "expired"
    detail = await product_detail(env, alice, product["id"])
    assert (detail["reserved"], detail["available"]) == (0, 5)
    assert await expire_orders(env.pool) == 0

    review_order = (await checkout(env, alice, selection(product["id"], 1))).json()
    reviewed = (await review(env, alice, review_order)).json()
    await env.pool.execute(
        "UPDATE orders SET deadline=clock_timestamp() WHERE id=$1", review_order["id"]
    )
    assert await expire_orders(env.pool) == 0
    assert (await order_of(env, alice, review_order["id"]))["status"] == "payment_review"
    assert (await product_detail(env, alice, product["id"]))["reserved"] == 1

async def test_order_visibility_and_seller_boundaries(env: Env) -> None:
    seller = await session(env, SELLER)
    alice = await session(env, ALICE)
    bob = await session(env, BOB)
    product = await published_product(env, seller)
    order = (await checkout(env, alice, selection(product["id"]))).json()

    assert (await env.client.get(f"/api/orders/{order['id']}", headers=bearer(bob))).status_code == 404
    assert (await env.client.get(f"/api/orders/{order['id']}", headers=bearer(seller))).status_code == 200
    assert (await env.client.get("/api/orders", headers=bearer(bob))).json() == []
    assert [entry["id"] for entry in (await env.client.get("/api/orders", headers=bearer(alice))).json()] == [order["id"]]
    assert [entry["id"] for entry in (await env.client.get("/api/seller/orders", headers=bearer(seller))).json()] == [order["id"]]

    foreign_change = await env.client.post(
        f"/api/orders/{order['id']}/changes",
        headers=bearer(bob),
        json={"version": order["version"], "items": [], "expectedTotal": 0},
    )
    assert foreign_change.status_code == 404
    non_seller_payment = await env.client.post(
        f"/api/seller/orders/{order['id']}/payment",
        headers=bearer(alice),
        json={"version": order["version"], "decision": "confirmed"},
    )
    assert non_seller_payment.status_code == 403
    malformed = await env.client.get("/api/orders/ORD-1", headers=bearer(alice))
    assert malformed.status_code == 400
    assert malformed.json()["error"] == "invalid_input"
