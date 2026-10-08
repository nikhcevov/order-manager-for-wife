# Design

## Context

See `proposal.md` - Why. The relevant current state:

- `orders.id uuid PRIMARY KEY` is the immutable internal identity; every order route keys on it (`apps/api/src/orders.ts:229-439`) and queries are owner-scoped.
- `orders.reference text NOT NULL UNIQUE` (`apps/api/migrations/001_initial.sql:38`) is the display string, currently `ORD-` + the 32-character uppercase hex of `orders.id` (`apps/api/src/orders.ts:281`).
- Migrations are plain numbered SQL files applied in filename order inside one transaction under an advisory lock (`apps/api/src/db.ts`), after which the API starts. `npm run migrate` runs before `npm start`.
- The reference is display-only: no query, route, or authorization path reads it.

## Goals / Non-Goals

**Goals:**
- Each confirmed order exposes a short `ORD-<n>` reference, assigned in creation order, from a single durable counter.
- Existing orders are renumbered so the format is uniform.
- Internal identity and all lookups remain UUID-based and unchanged.

**Non-Goals:**
- No change to `orders.id`, order routes, API response shapes, web UI, or fulfillment grouping.
- No anti-enumeration protection (unguessable/random codes), no check digit, no per-year or per-group sub-numbering - deliberately excluded per the accepted tradeoffs in the proposal.
- No reusable or releasable numbers: cancelled/expired orders keep their number.

## Decisions

### Decision: Format is `ORD-<n>`, unpadded decimal

`ORD-1`, `ORD-2`, … `ORD-129`. No leading zeros, no date prefix, no random suffix. Matches the requested "simple" form and keeps the existing `ORD-` prefix so no UI string handling changes.

*Alternatives considered:* zero-padded fixed width (`ORD-0001`) - rejected, adds noise with no benefit at this scale; short random code (`ORD-7K3Q`) - rejected by the user in favor of sequential readability; truncating the UUID - rejected, still opaque and collision-prone.

### Decision: Sequence-backed value, assigned by a column default

Create `order_number_seq` (`bigint`, start 1) and set `orders.reference`'s default to `'ORD-' || nextval('order_number_seq')`. The insert stops supplying `reference`.

*Rationale:* one authoritative allocator, no application-side `max()+1` race, no read-modify-write. `nextval` is called at INSERT time, i.e. after stock/price validation, so most rejected checkouts never consume a number.

*Alternatives considered:* application-computed `SELECT max(number)+1 FOR UPDATE` - rejected, needs locking and unique-violation retries; a `number bigint` column with `reference` derived - rejected as redundant, since nothing reads the integer independently of the reference string.

### Decision: The reference stays the display field; no new column

The number is carried inside `orders.reference`; `orders.id` remains the identity. Keeps the API contract (`reference`) and the `UNIQUE` guard intact.

*Alternative considered:* expose both `id` and a numeric `number` in responses - rejected, expands the API for no consumer need.

### Decision: Renumber existing orders during migration

One-time backfill orders existing rows by `created_at` and assigns sequential references, then sets the sequence past the highest value.

*Alternative considered:* leave historic `ORD-<uuid>` references and start new orders at `ORD-1` - rejected; a permanently mixed format defeats the "don't mix orders up in delivery" goal. The original UUID-derived value remains reproducible from `orders.id`, which makes the renumber reversible (see rollback).

### Decision: No frontend change; the reference is already the identifier rendered

Every order-facing surface renders `orders.reference`: `OrderCard` (`apps/web/src/ui.tsx:23`, used by the customer purchase list, a group's associated orders, and the seller review queue) and the order eyebrow/heading/payment instructions (`apps/web/src/customer.tsx:51,76,77`). UUIDs appear only as route ids (`context.openOrder(order.id)`), React `key`s, and API path segments. The new short reference therefore reaches both customer and seller with no web change; the spec pins "short reference, never the internal UUID" so a future view cannot regress to the id.

*Alternative considered:* expose the number as a separate field and format it in the UI - rejected; keeping one display string leaves the API and views unchanged.

## Risks / Trade-offs

- **Enumeration and volume leak** → Accepted by the user: sequential references are guessable and reveal order count. Bounded because the reference is never a lookup or authorization key; this is now pinned by a spec scenario.
- **Sequence gaps** → `nextval` is non-transactional, so a rolled-back checkout can consume a number. Accepted and documented in the spec ("Gaps MAY occur"); numbers stay strictly increasing and are never reused.
- **Visual transposition** (`ORD-129` vs `ORD-192`) → Accepted; no check digit. The reference is not typed into a lookup, so a misread cannot select the wrong order.
- **Renumbering invalidates saved references** → Historic references change value during the migration. Mitigated by the deploy procedure below and by the original value being recomputable from `orders.id`.
- **Concurrent inserts during backfill** → If the old build keeps serving while the backfill runs, it can insert `ORD-<uuid>` rows that the backfill has already passed. Mitigated by stopping the API before migrating (sequence: stop API → migrate → start new API).
- **Overflow** → Use a `bigint` sequence, not `integer`.
- **Uniqueness** → Guaranteed by the sequence; the existing `UNIQUE` constraint is retained as a backstop.

## Migration Plan

New migration file `apps/api/migrations/002_sequential_order_references.sql`:

1. `CREATE SEQUENCE order_number_seq AS bigint START WITH 1;`
2. Backfill in creation order:
   ```sql
   WITH numbered AS (
     SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM orders
   )
   UPDATE orders o SET reference = 'ORD-' || numbered.n
   FROM numbered WHERE o.id = numbered.id;
   ```
3. Position the sequence: `SELECT setval('order_number_seq', (SELECT count(*) FROM orders))` when rows exist, otherwise `setval('order_number_seq', 1, false)` so the first new order is `ORD-1`.
4. Set the default: `ALTER TABLE orders ALTER COLUMN reference SET DEFAULT 'ORD-' || nextval('order_number_seq');`

Application change: remove the `reference` computation and the `reference` value from the `INSERT INTO orders(...)` column list (`apps/api/src/orders.ts:281-286`).

Deploy order: stop the API → run `npm run migrate` → start the new API build. This closes the concurrent-insert window in step 2.

Rollback: redeploy the previous build; the app resumes computing `ORD-<id hex>` on insert, so new orders keep working. To restore historic references exactly, recompute them from the id: `UPDATE orders SET reference = 'ORD-' || upper(replace(id::text,'-',''));`. The sequence can be left in place.

## Open Questions

_None._
