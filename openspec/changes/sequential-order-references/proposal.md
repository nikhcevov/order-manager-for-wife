# Proposal

## Why

Order references are currently derived from the order UUID (`ORD-` followed by 32 hex characters, `apps/api/src/orders.ts:281`), producing a 36-character string that is hard to read aloud, retype, or match at a delivery handover. The reference is only ever displayed; the UUID primary key already provides true identity, so the reference can be short and human-friendly instead.

## What Changes

- Replace the UUID-derived `orders.reference` value with a short sequential reference of the form `ORD-<n>` (`ORD-1`, `ORD-2`, … `ORD-129`), assigned from a dedicated PostgreSQL sequence in creation order.
- Keep `orders.id` (UUID) as the immutable internal identity, and keep every API route looking orders up by that UUID; the reference stays display-only.
- No web-code change is required: every customer- and seller-facing surface already renders `orders.reference` (`apps/web/src/ui.tsx:23`, `apps/web/src/customer.tsx:51,76,77`, and the seller views, which reuse `OrderCard`), so the short reference reaches both automatically. The change pins "short reference, never the internal UUID" as required behavior.
- Renumber existing orders in creation order during the migration so the format is uniform, then advance the sequence so new orders continue after the highest assigned number.
- **BREAKING** (display only): order references change value. Any reference a customer or seller already saved/screenshotted becomes stale after the migration. No code, route, or API shape depends on reference text.
- Accepted tradeoffs, called out explicitly: references are guessable and reveal order volume; sequence gaps are possible because a rolled-back checkout (`nextval` is non-transactional) may consume a number; plain sequential numbers can be visually transposed (`ORD-129` vs `ORD-192`).

## Capabilities

### New Capabilities

<!-- New capabilities being introduced. -->

_None._

### Modified Capabilities

- `order-management`: adds a requirement that every order exposes a short, sequential, human-readable reference, assigned in creation order and never reused, while internal identity and all lookups remain UUID-based.

## Impact

- `apps/api/migrations/`: new migration creating the sequence, backfilling existing `orders.reference` values, and setting the column default.
- `apps/api/src/orders.ts`: stop computing the reference in application code (line 281); let the database default assign it.
- `apps/api/test/behavior.test.ts`: the reference-uniqueness assertion (line 578) now exercises the sequential format.
- No web UI code change: customer and seller surfaces already render `order.reference` (the UUID appears only in routing, React keys, and API paths), so the short reference appears automatically. No API response shapes, fulfillment grouping, or access control change.
