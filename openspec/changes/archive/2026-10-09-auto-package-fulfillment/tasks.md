# Tasks

## 1. Database migration

- [x] 1.1 Add `apps/api/migrations/003_auto_package_fulfillment.sql`: drop the old method/state/consistency CHECKs; map `state='packing'` to `'open'`; consolidate each customer's multiple open packages into the newest (move orders, carry a non-null `delivery_code`, delete the emptied rows); set `method=NULL` for open rows; add the new state/method/completed checks and the `UNIQUE(user_id) WHERE state='open'` partial index. Verify: `npm run migrate` applies cleanly to a fresh test database and `\d fulfillment_groups` shows the new constraints and index.

## 2. API: automatic packages and atomic shipment

- [x] 2.1 In `apps/api/src/orders.ts`, drop `method`/`groupId` from `POST /api/orders` and assign the order to the owner's open package by find-or-create (`SELECT ... FOR UPDATE`, else `INSERT ... ON CONFLICT (user_id) WHERE state='open' DO NOTHING RETURNING id`, else re-select); update the `openGroup` guard to reject a completed package. Verify: a behavior test confirms two consecutive checkouts share one `group_id` and a checkout after shipment opens a new package.
- [x] 2.2 In `apps/api/src/fulfillment.ts`, replace `pack`/`reopen`/`complete` with `POST /api/seller/groups/:id/ship` (body `{version, method, deliveryCode?, allowMissingCode?}`): reject pending change requests and zero paid orders, move non-paid orders to a new open package, set the source `completed` with method/`completion_kind`/`completed_at` and the final code, and return `missing_delivery_code` unless `allowMissingCode`. Make `PATCH /api/groups/:id` code-only and allowed for the owner or seller. Verify: behavior tests cover shipping without a code, in-person clearing the code, unpaid orders moving out, and rejection on pending changes or no paid orders.
- [x] 2.3 Hide empty open packages from `GET /api/groups` and `GET /api/seller/groups`. Verify: a behavior test confirms a package holding only expired/cancelled orders is not listed but is reused by the next checkout.
- [x] 2.4 Rewrite the fulfillment group in `apps/api/test/behavior.test.ts` (and the boundary test's group routes plus the `checkout` helper signature) for the new endpoints, removing assertions on `packing`, `reopen`, method-at-checkout, and the group selector. Verify: `npm test` passes against the test database.

## 3. Web: remove the customer fulfillment decisions

- [x] 3.1 Update `apps/web/src/api.ts`: `Group.state` is `'open' | 'completed'`, `method` is `Method | null`, add the ship payload shape, and adjust labels. Verify: `npm run typecheck`.
- [x] 3.2 In `apps/web/src/customer.tsx`, remove the method radio, group `<select>`, and "suggested group" card from `SelectionEditor` and send `{items, expectedTotal, key}`; update `OrderDetail` wording from groups/packing to packages/shipment. Verify: `npm run typecheck`.
- [x] 3.3 In `apps/web/src/customer.tsx` (`GroupDetail`), make the customer view read-only apart from the shared code field and give the seller a method + code + "Ship all paid" action; in `apps/web/src/seller.tsx` (`SellerGroups`), filter to open/completed and hide empty packages. Verify: `npm run typecheck`.
- [x] 3.4 Update `apps/web/src/App.tsx` navigation and footer labels ("Delivery" → "Packages"). Verify: `npm run build` succeeds.

## 4. Documentation

- [x] 4.1 Rewrite the README "Delivery or in-person handover" and customer-checkout sections for automatic packages and the seller-chosen method at shipment. Verify: the documented endpoints and labels match the shipped API and UI.

## 5. Integration verification

- [x] 5.1 Run `npm run typecheck`, `npm test`, and `npm run build`, then smoke the full flow in the browser (checkout → a second order joins the package → one shared code → seller ships all paid → history) and confirm unpaid leftovers open a new package.

## Workflow follow-up

- Archive the change with `/opsx-archive` after review.
- Verify the archived specs and main spec after archive.
