# Design

## Context

See `proposal.md` for motivation and `specs/*/spec.md` for behavioral contracts. At change creation, read-only inspection found a license, OpenSpec configuration, and assistant tooling, but no application source, package manifest, tests, or deployment setup. The decisions below describe the architecture selected for that greenfield change; `tasks.md` tracks implementation and verification progress.

The shop has one seller-operated catalog. Telegram supplies identity and the app container; payments and shipment requests happen externally. The customer explicitly chose review holds that do not expire automatically and one fulfillment method for each combined group.

## Goals / Non-Goals

**Goals:**
- Own inventory and lifecycle invariants in backend transactions, not client state.
- Keep purchase/payment history independent of current packing contents.
- Deliver a runnable customer and seller application with few operational components.
- Preserve the distinction between available, reserved, bought, and fulfilled.

**Non-Goals:**
- Microservices, event sourcing, Redis, WebSockets, or a generalized commerce framework.
- Automatic payment decisions, refunds, carrier validation, or tracking synchronization.
- A Telegram-chat bot workflow that duplicates the Mini App's authoritative records.
- Item-level fulfillment splitting or supplier-side stock synchronization.

## Decisions

### 1. One TypeScript application with a small backend

Use npm workspaces with `apps/web` for React + Vite and `apps/api` for a Node.js/Fastify service. Use PostgreSQL through `pg` and explicit versioned SQL migrations. Keep domain operations grouped by catalog, orders/payments, and fulfillment; avoid creating a generic repository/service abstraction for every table.

Serve the production frontend and API from the same HTTPS origin. Development uses Vite's API proxy and a local PostgreSQL instance. A small shared package is justified only for actual shared request/response types; business logic stays server-side.

Alternative: a full-stack framework or ORM. Neither is necessary for this mobile SPA and small SQL-heavy domain; explicit transactions make stock locking easier to review. PostgreSQL is preferred over a local-only database because concurrent checkout and durable background expiry are central requirements.

```text
Telegram bot profile / shop link
                |
                v
       React Mini App
                |
                v
       Node HTTP API
          |          |
          v          v
     PostgreSQL   Persistent media volume
```

### 2. Telegram identity, server-owned authorization

Configure a main Mini App or bot menu launch using BotFather; provide the setup instructions rather than an unrelated conversational bot. Use the official Telegram WebApp bridge for theme, back navigation, main actions, and safe areas.

Exchange raw `initData` for an opaque bearer session after server signature validation and a timestamp check. Proposed launch-data acceptance is one hour; sessions last 24 hours, are stored server-side as token hashes, and are held in frontend memory rather than local storage or URLs. Expired sessions show a reopen-in-Telegram action. Revalidate seller ID membership and resource ownership on every request. Reject client-supplied identity and any production authentication bypass.

The bot token remains backend-only. Payment screenshots are fetched through authenticated endpoints and displayed using temporary browser object URLs. Product images can be publicly served only for published products. Never place session tokens, launch data, evidence, or delivery codes in logs.

Alternative: trust `initDataUnsafe` or a username. Both allow incorrect authorization. The validation contract follows Telegram's documented Mini App authentication: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app.

### 3. Separate records for orders, payments, and fulfillment

Persist these concrete concepts:

| Record | Responsibility |
|---|---|
| Customer/session | Verified Telegram ID, display identity, authentication expiry |
| Product/product image | Draft or published visibility, current price, remaining unsold stock, ordered images, comment |
| Order | Customer, reference, lifecycle, original deadline, current revision, optimistic version, fulfillment group |
| Order revision/lines | Immutable accepted name, product reference, unit price, quantity, currency, total, author/time |
| Payment evidence/review decision | Private media, associated order revision, submission time, seller decision/reason |
| Order change request/resolution | Desired selection, original revision, pending/approved/rejected decision, accepted revision, externally settled difference |
| Fulfillment group | Customer, delivery or in-person method, optional code, open/packing/completed state, version, completion kind/time |
| Checkout submission | Customer-scoped idempotency key, payload hash, result order |

Money is integer minor units in one configured shop currency, never floating point. Quantities are positive integers on lines and nonnegative integers on stock. Existing quantities retain accepted prices; additions at a changed price use separate price lots, including when the product ID matches. Product deletion is unnecessary: historical product references and images must not break purchase history.

The first order creates or selects an open fulfillment group. Subsequent checkout suggests the most recent open group and asks the customer to confirm its method and association, or create a new group. Whole orders belong to one group, never several packages at once. Grouping does not consolidate payment obligations.

### 4. Inventory is derived from durable commitments

`remaining_unsold` excludes already-bought units. Available quantity is:

```text
remaining_unsold
  - quantities in payment_review orders
  - quantities in awaiting_payment orders whose deadline is in the future
```

Do not maintain an independent cached reserved counter. Read commitments from current accepted order revisions. Confirmation of payment reduces `remaining_unsold` and moves the order out of held states in one transaction, so availability does not change merely because reserved units become bought.

Every transaction changing a hold, paid selection, or stock locks affected product rows in stable ID order and checks availability after acquiring locks. When a fulfillment group or existing order is involved, acquire group rows first, then order rows, then product rows; lock multiple rows of each kind in stable ID order. Operations that do not need an earlier record never acquire it after a later lock. Stock-only administration locks products and does not subsequently lock orders.

Use PostgreSQL READ COMMITTED with explicit locks; fetch current commitments after the product locks. Sample database wall-clock time after acquiring locks for deadline decisions, not a transaction-start timestamp. A stale checkout or edit gets a conflict response with the current accepted state. Never silently reduce quantities.

An expired awaiting-payment order is excluded from availability even if a cleanup job has not changed its status yet. A periodic in-process worker marks expired orders terminally, and startup performs catch-up. Multiple workers must remain safe through locked conditional transitions. This avoids stock staying unavailable during outages without adding a queue service.

### 5. Explicit order/payment lifecycle

```text
awaiting_payment -- evidence before deadline --> payment_review -- seller confirms --> paid
       |                                               |
       +-- deadline --> expired                        +-- seller rejects --> payment_rejected
       |
       +-- customer cancels --> cancelled
```

Proposed unpaid hold duration: 30 minutes, set through deployment configuration and displayed to the customer. Edits retain the original deadline. This default is a reviewable operating choice, not a newly confirmed user preference.

Screenshot upload and evidence submission are separate actions. An upload creates an owner-bound media record; submission locks the order and relevant products, rechecks the current revision/state and database time, attaches evidence, and transitions to review. At or after the deadline, submission fails even if upload started earlier. Accepted submission before the deadline protects the stock until review, including after restarts. Expiry can never release a review-held order.

Seller confirmation and rejection are conditional, repeat-safe transitions. Rejection is terminal and releases holds, with a reason; the customer may create a new order. Evidence is not proof of a bank transfer. The seller must inspect the external account before deciding. Payment confirmation remains possible when a change request is pending, but packing stays blocked until the request is resolved.

### 6. Direct edits before evidence; reviewed corrections afterwards

While awaiting payment, use an expected order version and a customer-accepted price preview. Lock the order and all old/new products, check the original deadline and available additions, then append the new accepted revision. Release removed holds and acquire added holds together. Retain old revisions. A failed replacement preserves the entire original order.

After evidence submission, direct editing and cancellation stop. A customer can submit one pending structured request per order containing the desired item selection and an optional explanation. The request itself holds no replacement stock and clearly does not guarantee availability. Customers can withdraw an unresolved request before packing. Packing cannot begin with pending requests.

The seller sees the old selection, requested selection, current replacement availability, and signed price difference. Approval requires the customer-requested selection to still be valid and an explicit record of any additional payment or refund settled outside the app. Use current prices for added quantities and accepted prices for retained quantities. Record the difference, seller, time, and external settlement note; original screenshots and paid amounts remain tied to their original revision. The app does not execute a refund or payment.

For a review-held order, approval atomically replaces its reservation and accepted revision while leaving it under payment review. The seller checks the revised payable amount when confirming payment. For a paid order, approval atomically returns removed, unfulfilled units to unsold stock and consumes available replacement units, then records the corrected revision. Zero-difference corrections need no settlement note. A shortage leaves originals untouched. Removing every item records a zero-item resolved purchase and its external refund, rather than erasing history; it contributes nothing to packing.

Packing groups must be reopened by the seller before requests or corrections can change their contents. Completed fulfillment cannot be edited. Extra purchases normally use a new order and join an open group; this keeps payment evidence intelligible without forcing a correction of an earlier paid order.

Alternative: mutate paid lines silently or combine all purchases into one order. Both destroy the link between the amount transferred, the evidence, and the accepted purchase. Immutable revisions plus a small reviewed-correction record preserve that link without a general financial ledger.

### 7. One method per fulfillment group; independent readiness

A group has `method = delivery | in_person` and `state = open | packing | completed`. Completion kind is `sent` or `handed_over`, consistent with the method. The code is a bounded plain-text delivery-service reference supplied by the customer, not a verified carrier integration. It is optional even for delivery. Changing to in-person clears the active code; switching back requires re-entry rather than silently reusing an old shipment request.

Readiness is derived from paid items, pending requests, method, and group state. Missing delivery code is an informational warning, not an unpaid state or a hard dispatch gate. For in-person groups, hide code inputs completely.

The seller can wait for unpaid additions or fulfill only paid whole orders. When selecting paid-only fulfillment from a mixed group, atomically move the remaining unpaid orders to a new open group of the same method and leave the original group packing the paid orders. Keep an existing delivery code with the packing group; do not duplicate it onto the remaining group. Show the split to the customer. Both grouping and packing transitions lock involved groups and orders to prevent racing checkout/payment decisions.

Customers cannot modify a packing group. Seller reopening is explicit and invalidates the old packing view. Completion requires at least one paid item and no pending corrections or unpaid included orders. It closes the group, but does not mutate payment states or reduce stock a second time. New purchases go to an open/new group. Repeated completion returns the existing result.

Alternative: a separate shipping choice on each order or item. It introduces mixed packages and conflicts with the agreed whole-group choice. A generic fulfillment group also describes an in-person handover without calling it a shipment in the UI.

### 8. Media stays simple but private where required

Use a persistent filesystem volume for this single-service deployment, with generated storage keys and database metadata. Keep storage outside the public frontend directory. Do not introduce an object-storage provider abstraction without a deployment need.

Accept JPEG, PNG, and WebP images with a proposed 10 MiB file limit, trusted image decoding, and bounded dimensions. Reject SVG and non-image payloads; never trust filename extensions or user-controlled paths. Publish product media only through publication-aware URLs; evidence is always authorization-gated. Attach successful uploads only, and remove abandoned, unreferenced uploads through bounded housekeeping. Back up media alongside the database.

Alternative: screenshots only in Telegram chat. That loses the order association and requires seller searches. Storing evidence in the app makes review complete; chat remains for exceptional communication.

### 9. Small API and visible end-to-end screens

Use resource routes under `/api` for session exchange, catalog, media upload/access, customer orders and changes, fulfillment groups, and seller product/payment/change/packing operations. Mutations carry expected versions; checkout additionally carries a stable submission key and a payload fingerprint. Reusing a key with a different payload is a conflict. Do not create retries that silently submit a new purchase.

Customer screens: catalog/details, cart, checkout/group choice, order/payment evidence, order edit or change request, order history, and delivery/pickup group details. Seller screens: draft/published products, batch publish, payment queue with images, change-request review with settlement recording, and combined fulfillment/packing details.

Refresh data after mutations, on Mini App activation, and by polling while the app is active (proposed interval: 10 seconds). Customers see current sold/reserved quantities without a WebSocket server; checkout always remains authoritative. Show conflicts, deadline expiry, evidence rejection, pending requests, and missing codes explicitly. Freeze duplicate action buttons during a request but rely on backend idempotency for correctness.

### 10. Proof before delivery, not merely compilation

Use deterministic domain/API tests against an isolated PostgreSQL database for last-unit contention, deadline boundaries, evidence-versus-expiry, duplicate decisions, edit rollback, paid corrections, ownership denial, and fulfillment splitting/freezing. Test uncertain transitions and consumer-visible behavior, not source text or forwarding.

During implementation, exercise actual browser screens with two customers and a seller, then verify a real Telegram launch, identity, theme, navigation, safe areas, and screenshot upload on a supported Telegram client. If bot credentials or HTTPS hosting are unavailable, report that exact runtime verification limit; a mocked identity smoke is not Telegram integration proof.

## Risks / Trade-offs

- Fake screenshots can hold stock indefinitely -> Keep an oldest-first review queue and explicit rejection/release actions; no automatic review expiry because the customer chose review until decision.
- Manual decisions can be wrong -> Show original evidence, revision totals, pending changes, and settlement notes together; do not label screenshots as verified transfers.
- Paid corrections require refunds or extra transfers -> Record manual settlement before applying nonzero differences; never hide them as a simple stock edit.
- In-process jobs stop with the service -> Availability excludes elapsed unpaid holds independently; startup catch-up and repeat-safe transitions complete history later.
- Delivery codes may be invalid or stale after additions -> Treat codes as customer-provided, make the group visible, allow replacement while open, and leave external shipment validation to the participants.
- Local media storage binds deployment to persistent disk -> Use a backed-up volume; moving to object storage is a separate deployment decision if needed.
- Telegram WebView behavior varies by platform -> Verify the actual Mini App surface, not just a desktop browser.
- Polling is not instantaneous -> Refresh on activation and mutations; backend transactions prevent overselling even with a stale screen.

## Migration Plan

The initial greenfield rollout had no existing application data to migrate. The following steps describe that initial rollout. Existing deployments must preserve database and media state and use compatible migrations and backed-up rollback procedures.

1. Create versioned initial PostgreSQL migrations, local development services, and persistent media storage.
2. Supply bot token, seller Telegram IDs, shop currency, manual payment instructions, public HTTPS URL, database connection, and storage path through validated runtime configuration. Hold duration has the proposed 30-minute default.
3. Deploy frontend and API together, run migrations before accepting orders, and configure the bot's launch URL using BotFather.
4. Exercise the real purchase/review/fulfillment flows before sharing the shop link with customers.
5. For rollback after real purchases exist, stop new mutations, retain database/media backups, and restore a compatible service release. Never drop purchase/evidence tables or erase stock history as a rollback shortcut.

## Open Questions

The user reports the shop live at https://matchagirlie.han-diatonic.uk. Configure `PUBLIC_ORIGIN` and the bot's Mini App/menu-button URL to that same HTTPS origin. Bot credentials, seller IDs, currency, and payment instructions remain deployment configuration, not values to commit here. A live HTTPS deployment alone does not establish real Telegram identity, authorization, device presentation, upload, or restart-persistence verification. The user reports task 8.4 passed on iPhone 14 Pro Max, iOS 27.0.1, Swiftgram 12.9.3; the real-client and restart-persistence results are recorded in `tasks.md`. The seller can review the proposed hold duration and upload limits without changing the chosen model.
