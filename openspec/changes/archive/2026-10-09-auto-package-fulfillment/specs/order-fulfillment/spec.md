# Spec Delta

## MODIFIED Requirements

### Requirement: Paid-only packing list
The seller SHALL see a combined list of paid, unshipped items for each open package and a separate list of unpaid or review-held orders. Unpaid quantities SHALL NOT be counted as ready to ship or marked sent or handed over.

#### Scenario: Paid purchases with an unpaid addition
- **WHEN** a package contains two paid orders and one awaiting-payment order
- **THEN** the seller sees the paid shipment contents separately from the unpaid addition and can choose to wait or ship only the paid orders

### Requirement: Fulfill paid orders without silently including unpaid orders
The system SHALL ship paid orders while leaving unpaid and review-held orders in a fresh open package for later fulfillment. Shipping SHALL preserve whole-order membership and SHALL NOT cancel unpaid reservations or merge their payment obligations.

#### Scenario: Seller chooses to ship paid purchases now
- **WHEN** the seller ships a package that also contains unpaid orders
- **THEN** the paid orders become part of the shipment and the remaining unpaid orders move to a new open package visible to the customer

### Requirement: Explicit fulfillment completion
The system SHALL let the seller complete an open package as sent for delivery or handed over for in-person fulfillment in a single action. A missing delivery code SHALL show a warning but SHALL NOT prohibit completion. Completed packages SHALL reject new orders and content changes and remain visible in customer history.

#### Scenario: Complete delivery without a code
- **WHEN** the seller ships a delivery package whose open package has no code
- **THEN** the app warns about the absent code and permits explicit completion without changing payment status

#### Scenario: Complete in-person handover
- **WHEN** the seller completes an in-person handover
- **THEN** every included paid order is recorded as fulfilled without asking for a delivery code

#### Scenario: Order after completion
- **WHEN** the customer places another order after the package was sent or handed over
- **THEN** the new order opens a new package and the completed package remains unchanged

### Requirement: Shared fulfillment visibility
The system SHALL show the owner and seller the package's order references, payment readiness, delivery code when present, and completion state. Paid purchases awaiting fulfillment SHALL NOT expire because delivery information is missing.

#### Scenario: Customer checks delivery progress
- **WHEN** a customer opens their package
- **THEN** they see the included orders, any shared delivery code, and whether the package is open or shipped

## ADDED Requirements

### Requirement: Automatic fulfillment packages
The system SHALL assign each confirmed order to its owner's single open package without asking the customer to choose one. Each active order SHALL belong to exactly one package, and packaging SHALL NOT merge order references, totals, evidence, or payment statuses.

#### Scenario: Additional purchase joins earlier purchases
- **WHEN** a customer places another order while a package is open
- **THEN** the new order joins that package automatically while retaining its own payment obligation and history

#### Scenario: Purchase after the previous package shipped
- **WHEN** a customer places an order after their previous package was completed
- **THEN** a new open package is created for the order

#### Scenario: No customer package selection
- **WHEN** a customer confirms an order
- **THEN** the checkout request carries no package identifier and the server chooses the package

### Requirement: Seller-chosen fulfillment method at shipment
Each shipment SHALL have exactly one method, delivery or in-person handover, applying to all its included purchases. The seller SHALL choose the method when shipping, and an open package SHALL have no method.

#### Scenario: Ship as delivery
- **WHEN** the seller ships a package as delivery
- **THEN** every included purchase is recorded as sent and delivery-code controls apply

#### Scenario: Ship as in-person handover
- **WHEN** the seller ships a package as in-person handover
- **THEN** every included purchase is recorded as handed over and any stored delivery code is not part of the shipment

### Requirement: Optional shared delivery code
The system SHALL let the package owner or the seller set or replace one optional delivery code on an open package. The code SHALL NOT be required to order, pay, or mark a purchase paid, and it SHALL be consumed by the shipment that closes the package.

#### Scenario: Owner supplies a code
- **WHEN** the customer sets a delivery code on their open package
- **THEN** the seller sees that code for the whole package and the customer is not asked for another for the same package

#### Scenario: Paid package without a code
- **WHEN** a package is paid and unshipped without a delivery code
- **THEN** the purchases remain bought and the seller sees a missing-code indicator rather than an unpaid or expired order

### Requirement: Atomic paid-only shipment
Shipping SHALL complete in a single seller action that requires at least one paid order, records the chosen method, and rejects the action while any included order has an unresolved change request.

#### Scenario: Pending change request blocks shipment
- **WHEN** an included order has an unresolved change request
- **THEN** shipment is rejected until the request is approved, rejected, or withdrawn

#### Scenario: No paid orders
- **WHEN** the seller attempts to ship a package with no paid orders
- **THEN** the shipment is rejected without changing any order

### Requirement: Package history after shipment
A shipped package SHALL be immutable and remain visible to the customer and seller as fulfillment history.

#### Scenario: Contents frozen after shipment
- **WHEN** a package has been shipped
- **THEN** its included orders, method, and recorded code cannot be changed

## REMOVED Requirements

### Requirement: Customer-owned fulfillment groups
**Reason**: Customers no longer select or create packages; assignment is automatic, removing the combine-or-create decision.
**Migration**: No customer action is required. Existing order links are preserved; an open group continues as the automatic package for that customer.

### Requirement: One fulfillment method per group
**Reason**: The delivery or handover method is now chosen by the seller at shipment instead of by the customer when creating a package.
**Migration**: No customer action is required. The method is selected on the ship action.

### Requirement: Optional customer-supplied delivery code
**Reason**: Replaced by an optional shared delivery code that either the customer or the seller may set on an open package.
**Migration**: Any existing package delivery code is preserved as the package's shared delivery code.

### Requirement: Packing freezes customer changes
**Reason**: The intermediate packing state and reopen step are removed; the only authoritative cut-off is the shipment itself.
**Migration**: No action is required. Customers may change orders until the seller ships.
