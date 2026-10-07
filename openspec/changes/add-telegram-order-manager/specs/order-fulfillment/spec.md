# Spec Delta

## Purpose

Combine a customer's purchases into one package or one in-person handover while preserving individual orders, payment obligations, and an unambiguous fulfillment method.

## ADDED Requirements

### Requirement: Customer-owned fulfillment groups
The system SHALL let a customer associate multiple whole orders with one open fulfillment group owned by that customer. Each active order SHALL belong to exactly one group, and grouping SHALL NOT merge order references, totals, evidence, or payment statuses.

#### Scenario: Additional purchase joins earlier purchases
- **WHEN** a customer places another order and selects their existing open group
- **THEN** the new order appears in that group while retaining its own payment obligation and history

#### Scenario: Attempt to join another customer's group
- **WHEN** a customer supplies a group owned by someone else
- **THEN** the association is rejected without changing either customer's records

### Requirement: One fulfillment method per group
Each fulfillment group SHALL have exactly one method, delivery or in-person handover, applying to all its included purchases. A customer SHALL select the method when creating the group and SHALL be able to change it while the group is open. Different methods SHALL require separate groups, not mixed item-level choices.

#### Scenario: Choose in-person handover
- **WHEN** a customer selects in-person handover for an open group
- **THEN** every included purchase is scheduled for that handover and delivery-code controls are absent

#### Scenario: Separate delivery and handover
- **WHEN** a customer wants some orders delivered and others handed over
- **THEN** they must use separate groups, each with a single method

### Requirement: Optional customer-supplied delivery code
The system SHALL let the owning customer add or replace an optional delivery code on an open delivery group after creating a shipment request externally. It SHALL NOT require a code to order, pay, or mark a purchase paid. In-person groups SHALL have no active delivery code.

#### Scenario: Paid delivery without a code
- **WHEN** a customer has paid but has not supplied a delivery code
- **THEN** the purchases remain bought and the seller sees a missing-code indicator rather than an unpaid or expired order

#### Scenario: Change method to in person
- **WHEN** the customer switches an open group from delivery to in-person handover
- **THEN** the active delivery code is cleared and no delivery code is required for completion

### Requirement: Paid-only packing list
The seller SHALL see a combined list of paid, unfulfilled items for each group and a separate list of unpaid or review-held orders. Unpaid quantities SHALL NOT be counted as ready to pack or marked sent or handed over.

#### Scenario: Paid purchases with an unpaid addition
- **WHEN** a group contains two paid orders and one awaiting-payment order
- **THEN** the seller sees the paid packing contents separately from the unpaid addition and can choose to wait or fulfill only the paid orders

### Requirement: Fulfill paid orders without silently including unpaid orders
The system SHALL let the seller move paid orders into packing while leaving unpaid orders in an open group for later fulfillment. This selection SHALL preserve whole-order membership and SHALL NOT cancel unpaid reservations or merge their payment obligations.

#### Scenario: Seller chooses to ship paid purchases now
- **WHEN** the seller chooses paid-only fulfillment for a mixed-payment group
- **THEN** the paid orders enter one packing group and the remaining unpaid orders stay in an open group visible to the customer

### Requirement: Packing freezes customer changes
The system SHALL prevent customers from adding orders, changing method or code, or requesting item changes in a packing group. The seller SHALL be able to reopen an uncompleted packing group before accepting changes. Unresolved order-change requests SHALL prevent a group from entering packing or completing fulfillment.

#### Scenario: Customer buys while earlier purchases are packing
- **WHEN** a customer places a new order after their earlier group enters packing
- **THEN** the new order uses an open or new group unless the seller explicitly reopens the earlier group

#### Scenario: Pending replacement during packing preparation
- **WHEN** an included order has an unresolved replacement request
- **THEN** packing cannot begin until the request is approved or rejected

### Requirement: Explicit fulfillment completion
The system SHALL let the seller complete a paid packing group as sent for delivery or handed over for in-person fulfillment. A missing delivery code SHALL show a warning but SHALL NOT prohibit seller completion. Completed groups SHALL reject new orders and content changes and remain visible in customer history.

#### Scenario: Complete delivery without a code
- **WHEN** the seller confirms that a delivery group without a code has been sent
- **THEN** the app warns about the absent code and permits explicit completion without changing payment status

#### Scenario: Complete in-person handover
- **WHEN** the seller marks an in-person group handed over
- **THEN** all its included paid orders are recorded as fulfilled without asking for a delivery code

#### Scenario: Order after completion
- **WHEN** the customer places another order after the group was sent or handed over
- **THEN** the new order belongs to an open or new group and the completed group remains unchanged

### Requirement: Shared fulfillment visibility
The system SHALL show the owner and seller the group's method, associated order references, payment readiness, delivery code where applicable, packing state, and completion state. Paid purchases awaiting fulfillment SHALL NOT expire because delivery information is missing.

#### Scenario: Customer checks delivery progress
- **WHEN** a customer opens their delivery group
- **THEN** they see their submitted code, included orders, and whether the group is open, packing, or sent
