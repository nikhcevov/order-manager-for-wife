# Spec Delta

## Purpose

Manage customer purchases and their inventory commitments safely, including timed reservations, changing selections, payment-linked restrictions, and durable purchase history.

## ADDED Requirements

### Requirement: Cart without inventory commitment
The system SHALL let customers add, remove, and change product quantities in a cart without reserving stock. Checkout SHALL revalidate publication, current prices, and available quantities before the customer accepts the order.

#### Scenario: Customer abandons a cart
- **WHEN** a customer adds the last unit to their cart and leaves without confirming an order
- **THEN** other customers can still order that unit

#### Scenario: Price changes before checkout
- **WHEN** a cart contains an outdated price
- **THEN** the customer must see and accept the revised total before an order is created

### Requirement: Atomic order submission
The system SHALL create a confirmed order and reserve all its requested quantities together, or create neither. It SHALL reject empty carts, unpublished products, invalid quantities, and insufficient stock with an actionable conflict response.

#### Scenario: Partial cart shortage
- **WHEN** one item in a multi-item checkout has insufficient stock
- **THEN** no order or partial reservation is created and the customer is told which selection must change

#### Scenario: Competing for the final unit
- **WHEN** two customers concurrently confirm orders for the same final unit
- **THEN** exactly one order acquires it and the other receives an availability conflict

### Requirement: Duplicate and stale submissions are safe
The system SHALL prevent repeated submissions of the same checkout from creating duplicate orders or holds. Order mutations SHALL reject stale revisions rather than overwriting newer accepted changes.

#### Scenario: Checkout response is lost
- **WHEN** the customer repeats the same submission after its successful response was lost
- **THEN** the existing order is returned without reserving another quantity

#### Scenario: Two screens edit one order
- **WHEN** an edit is submitted against an older order revision
- **THEN** it is rejected with the current order state and no inventory change

### Requirement: Timed unpaid holds
The system SHALL display a server-established deadline for awaiting-payment orders and release their stock after that deadline, including while customers are offline. Orders under payment review SHALL remain reserved until a seller decision, irrespective of the original deadline.

#### Scenario: No payment evidence arrives
- **WHEN** an awaiting-payment order reaches its deadline
- **THEN** it becomes expired and its held quantities become orderable again

#### Scenario: Restart after missed deadline
- **WHEN** the service resumes after an unpaid order's deadline
- **THEN** that order cannot continue excluding its quantities from availability

### Requirement: Atomic unpaid order editing
The system SHALL let owners add, remove, or replace items while an order awaits payment and its deadline has not passed. It SHALL present the revised total for acceptance and apply the full revision atomically without extending the original deadline. Retained quantities SHALL keep their accepted prices; newly added quantities SHALL use current prices.

#### Scenario: Replacement is unavailable
- **WHEN** a customer replaces an item with an unavailable product
- **THEN** the edit fails and the original selections, total, and holds remain unchanged

#### Scenario: Successful removal and addition
- **WHEN** a customer accepts an available revised selection
- **THEN** removed quantities are released, added quantities are held, and the new total is recorded with the original deadline

### Requirement: Customer cancellation before payment submission
The system SHALL let customers cancel awaiting-payment orders and immediately release their holds. Customers SHALL NOT directly cancel orders under payment review or paid orders; those changes require seller review.

#### Scenario: Cancel unpaid order
- **WHEN** the owner cancels an order still awaiting payment
- **THEN** the order becomes cancelled and its held stock is released exactly once

### Requirement: Reviewed changes after payment submission
The system SHALL let customers request additions, removals, or replacements after payment evidence submission or payment confirmation, before fulfillment completion. Requests SHALL NOT change stock, accepted totals, or packing contents until seller approval. Pending requests SHALL be visible to the seller and prevent fulfillment completion until resolved.

#### Scenario: Customer requests a paid replacement
- **WHEN** the customer requests replacing a paid item
- **THEN** the original purchase remains intact and the seller sees the requested replacement for review

#### Scenario: Seller rejects the request
- **WHEN** the seller rejects a change request
- **THEN** the customer sees the decision and the existing order, stock, and payment record remain unchanged

### Requirement: Safe approval of reviewed corrections
The system SHALL apply seller-approved corrections atomically after checking replacement stock and recording any externally settled payment difference. It SHALL preserve prior accepted selections and payment evidence, reject unavailable replacements without releasing originals, and prohibit changes to completed fulfillment.

#### Scenario: Approve a paid correction
- **WHEN** the seller approves a paid replacement with available stock and records settlement of any price difference
- **THEN** inventory and current packing contents reflect the correction while original purchase and payment records remain accessible

#### Scenario: Unsettled difference or unavailable replacement
- **WHEN** approval requires an unrecorded payment or refund, or replacement stock is unavailable
- **THEN** approval is rejected and the original paid selection remains intact

### Requirement: Separate subsequent purchases and durable history
The system SHALL let customers create additional orders after a paid purchase and view each order's reference, accepted selections, total, deadline where applicable, payment state, changes, and fulfillment association. Product edits SHALL NOT alter recorded purchase history.

#### Scenario: Buy another item after payment
- **WHEN** a customer with a paid order confirms another purchase
- **THEN** a distinct order and payment obligation are created without rewriting the earlier purchase
