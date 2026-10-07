# Spec Delta

## Purpose

Provide trustworthy Telegram identity and a mobile-first Mini App experience while separating seller administration from each customer's private purchase information.

## ADDED Requirements

### Requirement: Verified Telegram authentication
The system SHALL authenticate customers using server-validated Telegram Mini App launch data, including signature and freshness checks. It SHALL reject missing, invalid, or expired authentication rather than trusting client-supplied identity.

#### Scenario: Valid launch
- **WHEN** a customer opens the Mini App with valid recent Telegram launch data
- **THEN** the application identifies them by their verified Telegram user ID without requiring a separate password

#### Scenario: Forged or stale launch
- **WHEN** launch data has an invalid signature, an unacceptable timestamp, or no verifiable user
- **THEN** access to authenticated functionality is denied and no customer session is created

### Requirement: Seller-only administration
The system SHALL authorize product administration, payment decisions, order-change approval, and fulfillment administration only for configured seller Telegram IDs. A display name or username SHALL NOT grant seller access.

#### Scenario: Customer attempts administration
- **WHEN** an authenticated customer calls a seller-only operation directly
- **THEN** the system rejects the operation without changing products, payments, orders, or fulfillment

#### Scenario: Seller username changes
- **WHEN** a configured seller changes their Telegram username
- **THEN** their administration access remains bound to their Telegram ID

### Requirement: Customer ownership boundaries
The system SHALL restrict private orders, fulfillment groups, change requests, payment evidence, and delivery codes to their owning customer and authorized sellers.

#### Scenario: Another customer's identifier is supplied
- **WHEN** a customer requests or modifies another customer's order, evidence, or fulfillment group
- **THEN** access is denied and no private information or mutable state is exposed

### Requirement: Telegram-native mobile presentation
The Mini App SHALL provide usable mobile layouts, follow the active Telegram light or dark theme, respect safe areas, and provide back navigation and clear primary actions without overlapping Telegram controls.

#### Scenario: Theme or viewport changes
- **WHEN** Telegram changes theme or the usable viewport on a catalog, checkout, payment, or fulfillment screen
- **THEN** text, images, inputs, and primary actions remain readable and usable within the available area

### Requirement: Seller and customer workspace separation
The application SHALL present customers with the published shop and their purchase history and SHALL provide authorized sellers with a separate management workspace.

#### Scenario: Customer opens the application
- **WHEN** a non-seller customer opens the Mini App
- **THEN** they can browse the shop and their own purchases but cannot see management controls or other customers' records

#### Scenario: Seller opens management
- **WHEN** an authorized seller opens the management workspace
- **THEN** they can access product preparation, payment review, order-change review, and fulfillment queues
