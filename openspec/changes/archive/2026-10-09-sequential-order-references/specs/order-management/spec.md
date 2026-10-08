# Spec Delta

## ADDED Requirements

### Requirement: Human-readable sequential order references

The system SHALL assign every confirmed order a short reference of the form `ORD-<n>`, where `<n>` is a positive integer with no leading zeros, assigned in order of creation and starting at `ORD-1`. References SHALL be unique, SHALL never be reused or reassigned, and SHALL remain the value shown to customers and sellers for that order. Gaps in the sequence MAY occur.

#### Scenario: First order
- **WHEN** the shop's first order is confirmed
- **THEN** its reference is `ORD-1`

#### Scenario: Numbers follow creation order
- **WHEN** an order is confirmed after earlier orders, including across a service restart
- **THEN** its reference is greater than every reference issued before it

#### Scenario: Cancelled order keeps its number
- **WHEN** an order with reference `ORD-3` is cancelled
- **THEN** `ORD-3` is never issued to another order

#### Scenario: Pre-existing orders gain short references
- **WHEN** orders created before this change are present
- **THEN** they expose sequential `ORD-<n>` references ordered by their creation time

### Requirement: Order references stay display-only and identity stays UUID

The system SHALL keep each order's immutable UUID as its internal identity and SHALL resolve every order operation by that UUID. The human-readable reference SHALL be display-only and SHALL NOT be accepted as an order identifier for lookup or authorization.

#### Scenario: Order operations resolve by internal identity
- **WHEN** a customer or seller acts on an order
- **THEN** the system resolves it by its UUID and enforces ownership, independent of the reference text

#### Scenario: Reference is not a lookup key
- **WHEN** a request supplies a reference such as `ORD-1` in place of the order UUID
- **THEN** no order is resolved from the reference value

### Requirement: The short reference is the identifier shown to people

The system SHALL display an order's human-readable `ORD-<n>` reference, not its internal UUID, wherever the customer or seller interface identifies an order. Internal UUIDs SHALL remain limited to routing, API paths, and list keys.

#### Scenario: Customer sees the short reference
- **WHEN** a customer views their purchase list, an order's detail, or its payment instructions
- **THEN** the order is labelled with its `ORD-<n>` reference and its internal UUID is not shown

#### Scenario: Seller sees the short reference
- **WHEN** the seller views the payment-review queue, a change request, or a fulfillment group
- **THEN** each order is labelled with its `ORD-<n>` reference and its internal UUID is not shown
