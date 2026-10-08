# Spec Delta

## Purpose

Support external manual payments with private evidence and explicit seller review, keeping inventory reserved while evidence is reviewed without pretending to process or verify transfers automatically.

## ADDED Requirements

### Requirement: Manual payment instructions
The system SHALL show an awaiting-payment order's accepted total, currency, reference, hold deadline, and seller-provided payment instructions. The app SHALL NOT initiate or claim automatic verification of a payment.

#### Scenario: Customer opens payment screen
- **WHEN** the customer opens their newly confirmed order
- **THEN** they see the amount to pay externally, the order reference, instructions, and the deadline for submitting evidence

### Requirement: Screenshot evidence submission
The system SHALL let an order's owner upload at least one supported payment screenshot and explicitly submit it for review before the unpaid hold deadline. Only successful evidence submission SHALL move the order to payment review; choosing or uploading a file alone SHALL NOT do so.

#### Scenario: Submit valid evidence
- **WHEN** a customer submits a successfully stored screenshot before the order deadline
- **THEN** the screenshot is attached to that order's accepted revision and the order enters payment review

#### Scenario: Upload fails
- **WHEN** the screenshot upload fails or the file is unsupported or oversized
- **THEN** the customer sees a clear error and the order remains awaiting payment with its original deadline

### Requirement: Review holds survive the deadline
The system SHALL keep all quantities of an order under payment review reserved until the seller confirms or rejects payment. Review holds SHALL survive service restarts and SHALL NOT expire automatically.

#### Scenario: Seller reviews later
- **WHEN** valid evidence was submitted before the deadline and the seller has not reviewed it by that deadline
- **THEN** the order remains reserved and no held unit becomes available to another customer

#### Scenario: Evidence races expiry
- **WHEN** evidence submission and expiry contend for the same order
- **THEN** evidence accepted before the deadline enters review and keeps the hold, while evidence submitted at or after the deadline is rejected without reviving an expired hold

### Requirement: Explicit seller payment confirmation
The system SHALL let only the seller mark a review-held order paid after checking the external transfer. Confirmation SHALL mark its quantities bought exactly once and preserve the evidence and decision history. It SHALL NOT imply that fulfillment is complete.

#### Scenario: Confirm actual payment
- **WHEN** the seller confirms payment for an order under review
- **THEN** the customer sees paid status, the quantities become bought, and they are eligible for fulfillment

#### Scenario: Duplicate confirmation
- **WHEN** the same confirmation is repeated or retried
- **THEN** the purchase and inventory transition are not duplicated

### Requirement: Seller rejection releases reservations
The system SHALL let the seller reject unverified payment with a reason, close the order as payment rejected, and release its holds exactly once. The customer SHALL see the reason and be able to place a new order against current availability.

#### Scenario: Screenshot does not establish payment
- **WHEN** the seller rejects an order after checking that the claimed payment cannot be verified
- **THEN** its reserved stock becomes available, its evidence remains in history, and it does not appear as a paid purchase

### Requirement: Private payment evidence
The system SHALL restrict payment screenshot access to the order owner and authorized sellers. Screenshots SHALL NOT use publicly accessible catalog image links or become visible to other customers.

#### Scenario: Unauthorized screenshot access
- **WHEN** another customer or an unauthenticated visitor tries to retrieve payment evidence
- **THEN** no screenshot bytes or private payment details are returned

### Requirement: Payment review workspace
The system SHALL give the seller a queue of review-held orders with customer identity, reference, accepted items, amount, screenshots, submission time, pending changes, and confirmation or rejection actions. Customers SHALL see the resulting review status in their own order view.

#### Scenario: Review oldest pending order
- **WHEN** the seller opens the payment queue
- **THEN** they can identify outstanding reviews, inspect the supporting screenshots, and make a decision without searching Telegram chat
