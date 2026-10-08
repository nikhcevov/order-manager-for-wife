# Tasks

## 1. Sequential reference migration

- [x] 1.1 Add `apps/api/migrations/002_sequential_order_references.sql` that creates `order_number_seq` (`bigint`, start 1), renumbers existing `orders.reference` values in `created_at` order as `ORD-<n>`, positions the sequence after the highest assigned number (and leaves it ready to yield `ORD-1` when the table is empty), and sets the column default to `'ORD-' || nextval('order_number_seq')`. Verify against a scratch Postgres seeded with a few orders created out of id order: after `npm run migrate`, references read `ORD-1..ORD-n` ordered by `created_at`, and `SELECT nextval('order_number_seq')` returns the next unused number.
- [x] 1.2 Verify migration rerun and empty-table behavior: run `npm run migrate` a second time and confirm it applies nothing and leaves references unchanged; run it against an empty database and confirm the first inserted order receives `ORD-1`.

## 2. Application assignment

- [x] 2.1 Stop computing the reference in `apps/api/src/orders.ts:281` and remove `reference` from the `INSERT INTO orders(...)` column list so the database default assigns it. Verify `npm run typecheck` passes and a manual checkout (`POST /api/orders`) returns a `reference` matching `^ORD-\d+$`.
- [x] 2.2 Extend `apps/api/test/behavior.test.ts` to assert checkout references match `^ORD-\d+$`, are unique, and strictly increase between successive orders (alongside the existing uniqueness assertion), and verify `npm test -w apps/api` passes.

## 3. Integration check

- [x] 3.1 Confirm the unchanged API shape end to end: `GET /api/orders` and `GET /api/seller/orders` return `reference` as `ORD-<n>` and order operations still resolve by UUID (a request using `ORD-1` as the order id is rejected). Verify with the migrated test database and the existing web rendering path.
- [x] 3.2 Verify the customer and seller surfaces show `ORD-<n>` and never the internal UUID: load the purchase list, an order's detail and payment instructions, the seller payment-review queue, and a group's associated orders against the migrated test database. Expect no web source change (`apps/web/src/*` renders `order.reference` only).

## Workflow follow-up

- Run the migration with the API stopped (stop API → `npm run migrate` → start the new build), per the design's migration plan.
- Archive the change after review is satisfied.
