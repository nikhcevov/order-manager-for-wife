# Spec Delta

## MODIFIED Requirements

### Requirement: Reviewed changes after payment submission
The system SHALL let customers request additions, removals, or replacements after evidence submission or payment confirmation while their package is open. Owners SHALL be able to withdraw unresolved requests while the package is open. Requests SHALL NOT change stock, accepted totals, or shipment contents until seller approval. Pending requests SHALL be visible to the seller and block shipment until resolved.

#### Scenario: Customer requests a paid replacement
- **WHEN** the customer requests replacing a paid item
- **THEN** the original purchase remains intact and the seller sees the requested replacement for review

#### Scenario: Seller rejects the request
- **WHEN** the seller rejects a change request
- **THEN** the customer sees the decision and the existing order, stock, and payment record remain unchanged

#### Scenario: Customer withdraws a pending request
- **WHEN** the owner withdraws an unresolved item-change request while their package is open
- **THEN** the request is recorded as withdrawn without changing accepted selections, payment records, or inventory, and it no longer blocks shipment
