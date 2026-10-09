# Design

## Context

Today `fulfillment_groups` carries a non-null `method` and a three-value `state` (`open` → `packing` → `completed`); `orders.group_id` is non-null with a composite FK `(group_id, user_id)`. Checkout (`apps/api/src/orders.ts`) requires `method` and an optional `groupId`, creating a group eagerly. The seller drives `pack` (which splits unpaid orders into a new open group and freezes), `reopen`, and `complete`. See `proposal.md` for motivation; see the change's `specs/` deltas for the behavior contract.

## Goals / Non-Goals

**Goals:**
- Automatic package assignment; no customer-facing group or method decision.
- Method chosen by the seller at shipment; one atomic, paid-only shipment.
- One shared optional delivery code per package.
- Preserve existing `orders.group_id` linkage, history, stock, and payment semantics.
- Remove the `packing` state and the freeze/reopen cycle.

**Non-Goals:**
- Partial shipment selection (shipping a subset of a customer's paid orders).
- Per-order fulfillment methods.
- A freeze or "close for additions" step.
- Carrier or payment integrations; any change to reservation or payment rules.

## Decisions

**D1 — Keep `fulfillment_groups` as the auto-managed package.** Rather than adding `orders.shipment_id` and deriving packages, reuse the existing table with `orders.group_id` unchanged. It already provides a home for the shared delivery code and the grouping used for shipped history, and it avoids rewriting the `(group_id, user_id)` FK and the ordering locks in the expiry routine.

**D2 — At most one open package per customer, via a partial unique index.** `CREATE UNIQUE INDEX ... ON fulfillment_groups(user_id) WHERE state = 'open'`. Checkout performs find-or-create: `SELECT ... WHERE user_id=$1 AND state='open' FOR UPDATE`, else `INSERT ... ON CONFLICT (user_id) WHERE state = 'open' DO NOTHING RETURNING id` and, on no row, re-`SELECT ... FOR UPDATE`. Alternative considered: a per-user advisory lock only. Rejected because the index is a cheap durable invariant that also survives future code paths (the `pack` path that used to create sibling groups is gone).

**D3 — Method becomes nullable and is set at shipment; state is `{open, completed}`.** An open package has `method IS NULL`. `packing` is removed. Existing `packing` rows are mapped to `open` in the migration; the only authoritative transition is the shipment.

**D4 — The delivery code is one shared, optional value on the open package.** Either the owner or the seller may set or replace it while the package is open (`PATCH /api/groups/:id`, now code-only). At shipment it is copied onto the completed package (as the shipped record); an in-person shipment clears it. A constraint enforces `state <> 'completed' OR method = 'delivery' OR delivery_code IS NULL`.

**D5 — Single `POST /api/seller/groups/:id/ship` replaces `pack`, `reopen`, and `complete`.** Body `{ version, method, deliveryCode?, allowMissingCode? }`. In one transaction: lock the package and its orders; reject if any included order has an unresolved change request (`pending_changes`); require at least one paid order (`no_paid_items`); move every non-paid order into a new open package; set the source `state='completed'`, `method`, `completion_kind`, `completed_at`, and the final `delivery_code`; bump versions. A delivery shipment with no code returns `409 missing_delivery_code` unless `allowMissingCode: true`, mirroring today's warning-not-block behavior. Lock ordering stays global: package (by id) before orders, as `expireOrders` already does, so `ship` cannot deadlock against expiry.

**D6 — Checkout drops `method` and `groupId`.** `POST /api/orders` accepts `{ items, expectedTotal, key }`. The `checkout_submissions` payload hash is computed over the new payload; a client retrying a key created before deploy would see `idempotency_conflict` and regenerate its key, which is harmless.

**D7 — Empty open packages are hidden and reused.** A package with no orders is not listed; the next order reuses it, so cancelled/expired-only packages do not accumulate.

**D8 — Web surface follows the model.** `SelectionEditor` loses the method radio, the group `<select>`, and the "suggested group" card. `GroupDetail` becomes read-only for the customer except the code field; the seller view hosts the method select + code + "Ship all paid". `SellerGroups` filters to open/completed and hides empty packages. Labels switch from "groups"/"packing" to "packages"/"shipments".

## Risks / Trade-offs

- [No freeze: a paid order arriving between physical packing and the Ship click is swept into the shipment] → Accepted; the seller can repack. The Ship click remains the sole point of no return.
- [All-paid: a paid order cannot be held back from a shipment] → Accepted; a held-back item must be reordered.
- [One code per package; a customer wanting two shipments] → Ship earlier or later, producing two packages, each with its own code.
- [Concurrent checkouts could create two open packages] → Partial unique index + `ON CONFLICT DO NOTHING` + re-select.
- [Existing data may hold several open groups per customer, or `packing` groups] → The migration consolidates before creating the unique index, and fails loudly if consolidation is incomplete.
- [`checkout_submissions` hash change across deploy] → Only affects a retry of a pre-deploy key; the client regenerates its key.

## Migration Plan

`apps/api/migrations/003_auto_package_fulfillment.sql`, applied by the existing versioned runner:

1. Drop the old `method`/`state`/consistency CHECK constraints on `fulfillment_groups`.
2. Map `state='packing'` → `'open'`.
3. Consolidate: for each customer with more than one open package, keep the newest (by `created_at`, tie-break `id`), move the other open packages' orders to it, carry over any non-null `delivery_code`, and delete the emptied packages.
4. `UPDATE fulfillment_groups SET method = NULL WHERE state = 'open'`.
5. Add the new constraints (state set; completed ⇒ method/`completed_at`/`completion_kind` consistent; open ⇒ method/`completed_at`/`completion_kind` NULL; completed in-person ⇒ `delivery_code` NULL).
6. Create the partial unique index on `(user_id) WHERE state='open'`.

Rollback is image rollback with a database-plus-media backup; the migration is not reversed in place.

## Open Questions

None.
