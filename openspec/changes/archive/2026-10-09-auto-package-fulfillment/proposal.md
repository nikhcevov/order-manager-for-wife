# Proposal

## Why

The fulfillment-grouping workflow asks the customer to make two coupled prospective decisions at checkout — which package to join and which delivery method to use — before either matters physically, and it leaves the seller with empty abandoned groups. The only moment that actually matters is the shipment itself, so the package should be derived automatically and closed by that shipment.

## What Changes

- **BREAKING**: Checkout no longer accepts `method` or `groupId`. The server automatically assigns a confirmed order to the customer's single open package, creating one if none is open.
- **BREAKING**: The customer no longer chooses a package or a fulfillment method. The method (delivery or in-person handover) is chosen by the seller at shipment time.
- The delivery code becomes one shared, optional value on the open package, settable by either the customer or the seller, and consumed by the shipment.
- **BREAKING**: Remove the `packing` state, the "start paid-only packing" split step, and "reopen". Shipping is a single atomic action.
- Shipping includes every paid, unshipped order for the customer with no exceptions; unpaid and review-held orders are never shipped and are carried into a fresh open package.
- Unresolved item-change requests block shipping, replacing the block on packing.
- Empty open packages are hidden from customers and sellers.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `order-fulfillment`: Replace explicit customer-chosen groups and the packing/freeze cycle with automatic package assignment, a seller-chosen method at shipment, a shared delivery code, and atomic paid-only shipment completion.
- `order-management`: Reviewed corrections are gated by an open package and blocked by shipment rather than by packing; the checkout request no longer carries a fulfillment method or package selection.

## Impact

- API: `apps/api/src/orders.ts` (checkout payload and automatic package assignment) and `apps/api/src/fulfillment.ts` (routes, states, and completion semantics).
- Database: a new migration changes `fulfillment_groups` (nullable method, removal of the `packing` state) and keeps `orders.group_id`, so existing order linkage and history are preserved.
- Web: `apps/web/src/customer.tsx` (selection editor, order detail, package detail), `apps/web/src/seller.tsx` (fulfillment list), `apps/web/src/api.ts` types, and `apps/web/src/App.tsx` navigation labels.
- Docs: the README "Delivery or in-person handover" section.
- Tests: `apps/api/test/behavior.test.ts` fulfillment coverage.
- Out of scope: partial shipment selection, per-order fulfillment methods, reintroducing a freeze or reopen step, and carrier integration.
