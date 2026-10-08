# Tasks

All tasks are implementation work for a later explicit apply request. The planning workflow does not execute them. Follow the five capability specs and `design.md`; proposed defaults remain visibly documented rather than represented as user-confirmed preferences.

## 1. Runnable application and persistence

- [x] 1.1 Create the TypeScript npm workspaces, React/Vite frontend, and Node/Fastify backend with same-origin production serving and a development API proxy; verify the documented development command serves the real frontend and reaches the backend.
- [x] 1.2 Add PostgreSQL development setup and versioned migrations for customers/sessions, products/media, immutable order revisions, evidence/decisions, change requests/settlements, fulfillment groups, and checkout submission keys; verify migrations apply to an empty isolated database and reject invalid quantities and inconsistent relationships.
- [x] 1.3 Add validated runtime configuration for bot token, seller IDs, currency, payment instructions, database, media volume, public origin, and unpaid-hold duration; verify startup rejects missing required inputs and loads a complete local configuration without exposing secrets.
- [x] 1.4 After the startup smoke, document local startup, migration execution, persistent volumes, and required environment values in the project README; verify the documented commands work from a clean setup.

## 2. Telegram access and protected media

- [x] 2.1 Implement server validation of Telegram launch signatures/timestamps and opaque hashed sessions, seller-ID authorization, and owner-scoped resource access; verify focused authentication tests reject forged, stale, future-dated, expired-session, non-seller, and cross-customer requests while accepting a valid signed fixture.
- [x] 2.2 Implement the Telegram-aware React shell with theme updates, safe areas, back navigation, primary actions, session expiry, and customer/seller workspace separation; verify the running screens in light/dark mobile layouts and denied administrative access with a customer session.
- [x] 2.3 Implement persistent image upload/storage with generated keys, trusted decoding, file/dimension limits, draft/public product access rules, authenticated evidence retrieval, and unreferenced-upload housekeeping; verify real uploads render and focused tests deny cross-customer evidence access and reject disguised non-images and path traversal.
- [x] 2.4 After the access/media smoke, document BotFather launch setup, session behavior, seller IDs, supported uploads, and database/media backup requirements; verify a configured Telegram launch opens the app or record the exact missing credential/HTTPS prerequisite without claiming integration proof.

## 3. Product preparation and publication

- [x] 3.1 Implement seller draft creation/editing, ordered images, optional comments, integer-minor-unit pricing, remaining-unsold quantity, and transactional selected-product publication; verify API behavior keeps drafts inaccessible and makes a valid batch visible together without partial publication on failure.
- [x] 3.2 Implement product management forms and the batch publish action, plus customer catalog/detail screens with images and available/reserved/bought distinctions; verify the real seller can prepare and publish products and a customer can inspect them on the running app.
- [x] 3.3 Implement stock maintenance with active-hold protection and catalog availability derived from durable order commitments; add focused tests for reducing stock below reservations, elapsed unpaid holds, and accepted-price preservation after product edits, and verify those tests pass.
- [x] 3.4 After the catalog smoke, document draft versus published behavior, stock meaning, and publication steps; verify the seller can follow the documented flow without exposing unfinished products.

## 4. Cart, checkout, unpaid editing, and expiry

- [x] 4.1 Implement customer cart and accepted-total preview without holds, quantity validation, stale-price conflicts, and checkout group/method selection or creation; verify cart abandonment leaves the last unit orderable and changed prices require visible customer acceptance.
- [x] 4.2 Implement atomic multi-item checkout with stable product locking, a server deadline, owner-scoped idempotency key/payload fingerprint, and accepted purchase snapshots; verify PostgreSQL-backed tests prove one winner for the last unit, no partial reservation on shortage, and no duplicate order on a repeated submission.
- [x] 4.3 Implement atomic unpaid add/remove/replace, accepted price lots, optimistic versions, and cancellation without extending the deadline; verify focused tests preserve originals after a failed replacement, reject stale edits, retain existing prices, price additions correctly, and release cancelled quantities once.
- [x] 4.4 Implement effective expiry on reads/stock calculations, periodic terminal-state cleanup, and startup catch-up using database wall-clock deadline checks; verify deadline-boundary and restart scenarios release unpaid stock but never release review-held or paid purchases.
- [x] 4.5 Implement customer order detail/history and unpaid editing screens with deadlines, conflicts, accepted revisions, cancellation, and group associations; verify the actual app can checkout, revise an order, cancel it, and recover from a stock conflict without silent quantity changes.
- [x] 4.6 After the order smoke, document cart versus hold behavior, the proposed 30-minute configurable default, edit pricing, and cancellation/expiry rules; verify the documented customer journey matches the screens and API outcomes.

## 5. Manual payment evidence and seller review

- [x] 5.1 Implement payment instructions and separate screenshot-upload/evidence-submit operations tied to accepted revisions; verify the running customer flow reaches review only after successful explicit submission and handles invalid media or late submission without reviving stock.
- [x] 5.2 Implement conditional transitions into payment review and seller confirmation/rejection, protected evidence reads, decision history, and exactly-once purchase/stock effects; verify focused tests cover evidence-versus-expiry, review persistence past deadline/restart, duplicate decisions, and rejection releasing reservations once.
- [x] 5.3 Implement the seller review queue and evidence viewer with customer, total, revision, submission time, pending requests, and explicit decision controls, plus customer review results; verify one real submitted screenshot can be inspected and confirmed or rejected through the actual screens.
- [x] 5.4 After the payment smoke, document external payment checking, screenshots not proving payment, indefinite review holds, and terminal rejection behavior; verify the seller instructions clearly distinguish reserved, review-held, bought, and fulfilled states.

## 6. Reviewed changes to submitted and paid orders

- [x] 6.1 Implement owner-created structured change requests, one pending request per order, withdrawal, seller rejection, and pending-request visibility without changing inventory; verify requests retain originals and cannot target another customer or completed/packing fulfillment.
- [x] 6.2 Implement transactional approval for review-held and paid corrections with availability checks, immutable revisions, retained-price lots, and externally settled nonzero differences; verify focused tests cover available/unavailable replacement, removed-stock restoration, zero-difference approval, missing settlement rejection, full removal with recorded refund, and duplicate approval.
- [x] 6.3 Implement customer request/history views and seller comparison/approval screens showing accepted items, requested changes, price difference, and settlement notes; verify a customer-requested paid replacement is approved or rejected through the actual app without overwriting original evidence.
- [x] 6.4 After the correction smoke, document direct-edit versus review boundaries, replacement-stock uncertainty, manual additional-payment/refund settlement, and subsequent purchases as separate orders; verify documented examples correspond to tested transitions.

## 7. Combined delivery or in-person fulfillment

- [x] 7.1 Implement customer-owned group association, one method per whole group, open-group method changes, optional delivery-code entry/replacement, and code clearing on switching to in-person; verify focused tests reject mixed or cross-customer associations and keep paid purchases valid without a delivery code.
- [x] 7.2 Implement paid-only packing lists, unpaid/review-held separation, and atomic paid-only packing that moves remaining unpaid orders into a new open group without copying the old delivery code; verify mixed-payment tests preserve reservation/payment records and never include unpaid units in a completed package.
- [x] 7.3 Implement packing freeze, seller reopening, pending-change blocking, and repeat-safe completion as sent or handed over; verify tests reject customer changes while packing, reject new additions after completion, preserve stock on repeated completion, and permit explicit delivery completion with a missing-code warning.
- [x] 7.4 Implement customer delivery/pickup screens and seller grouped queues/packing views with individual order references and readiness; verify several paid purchases appear in one packing list, handover requires no code, and a new purchase uses an open/new group after packing starts.
- [x] 7.5 After the fulfillment smoke, document whole-group method selection, optional codes, external shipment creation, paid-only splitting, reopening, and completion; verify the seller can follow both delivery and handover journeys using the running app.

## 8. End-to-end integration proof

- [x] 8.1 Connect active-app polling, activation refresh, mutation refresh, duplicate-action feedback, and visible failure states across customer and seller screens; verify a second customer sees another customer's reservation, rejection/expiry release, and payment-confirmed sale while backend checkout remains safe under stale display data.
- [x] 8.2 Run the complete applicable typecheck/build and focused PostgreSQL-backed behavioral suite after integration; verify all five capability contracts are covered without implementation-text or mock-forwarding tests and record the exercised results.
- [x] 8.3 Exercise the actual web surface with a seller and two isolated customers through publication, competing checkout, unpaid replacement, evidence review beyond the deadline, paid correction, another order in the same group, paid-only packing, delivery without a code, and in-person handover; verify observed UI and database outcomes match the specs.
- [x] 8.4 Exercise a real Telegram Mini App launch over HTTPS with valid identity, seller authorization, theme/back/safe-area behavior, and screenshot upload, including persistence after service restart; verify observable outcomes and state any unavailable device/credential verification precisely rather than treating signed fixtures as Telegram-client proof.
  - User-reported verification recorded on 2026-10-09: iPhone 14 Pro Max, iOS 27.0.1, Swiftgram 12.9.3; real Mini App launch through https://t.me/matchagirlie_bot/matchagirlie.
  - Seller access worked; customer management access was absent; light/dark theme, back navigation, and safe-area behavior passed. Screenshot evidence was submitted and visible to the seller.
  - The app was restarted; the order, review-held reservation, and screenshot persisted after reopening. No failures reported.
- [x] 8.5 Verify the documented deployment/backup procedure, restore database plus media into an isolated instance, and run a purchase-history/evidence read smoke there; confirm secrets and private evidence are not exposed by production serving or logs and that implementation added no payment or carrier integration outside the agreed scope.
