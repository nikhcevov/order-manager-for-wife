# product-catalog Specification

## Purpose

Let the seller prepare and publish a single shop's products while giving customers accurate pricing, images, and availability without exposing unpublished stock.

## Requirements

### Requirement: Private product preparation
The system SHALL let the seller create and edit draft products with a name, one or more images, a price, a nonnegative integer stock quantity, and an optional comment. Draft products SHALL remain invisible and unorderable to customers.

#### Scenario: Seller prepares a batch
- **WHEN** the seller saves several products without publishing them
- **THEN** the products remain available for seller editing but do not appear in customer catalog or direct product access

#### Scenario: Invalid product data
- **WHEN** a product has a missing name or image, a negative price, or a negative or fractional stock quantity
- **THEN** the system rejects saving it with actionable field errors

### Requirement: Explicit batch publication
The system SHALL let the seller publish selected valid draft products together through one explicit action. Publication SHALL make every selected product visible together or leave the whole selection unpublished when validation fails.

#### Scenario: Publish prepared products
- **WHEN** the seller publishes a selection of valid drafts
- **THEN** customers can browse and order all products in that selection

#### Scenario: Invalid draft in selection
- **WHEN** one selected draft cannot be published
- **THEN** the system identifies the problem and does not partially publish the selection

### Requirement: Published product browsing
The system SHALL show published product names, images, prices in the shop currency, optional comments, and current orderable quantities. Customers SHALL be able to view product details and select quantities without exceeding the displayed availability.

#### Scenario: Browse a published product
- **WHEN** a customer opens a product with several images and a comment
- **THEN** the customer can inspect its images, description, price, and available quantity before adding it to their cart

### Requirement: Distinct reserved and sold availability
The system SHALL exclude active order holds from orderable stock and distinguish temporarily reserved units from units bought after seller payment confirmation. Sold-out and temporarily unavailable products SHALL remain visible but not orderable when no units are available.

#### Scenario: Last available unit is reserved
- **WHEN** another customer places an order holding the final unit
- **THEN** subsequent catalog reads show no orderable units and identify the temporary reservation rather than reporting that unit as bought

#### Scenario: Payment is confirmed or hold expires
- **WHEN** the seller confirms payment or an unpaid hold expires
- **THEN** subsequent catalog reads respectively reflect the purchase or the released orderable quantity

### Requirement: Safe stock maintenance
The system SHALL let the seller adjust remaining unsold stock but SHALL reject a quantity lower than units currently reserved. Product price or description edits SHALL NOT rewrite existing order snapshots.

#### Scenario: Seller reduces stock beneath reservations
- **WHEN** three units are reserved and the seller attempts to set remaining unsold stock to two
- **THEN** the adjustment is rejected and the existing stock and holds are preserved

#### Scenario: Seller changes published price
- **WHEN** the seller updates a published product's price after an order was placed
- **THEN** future purchases use the new price while that order retains its accepted price

### Requirement: Usable product media
The system SHALL accept supported image uploads from the seller, reject invalid or oversized files with a clear error, and display uploaded product images without making payment evidence publicly accessible.

#### Scenario: Image upload fails
- **WHEN** a seller selects an unsupported file or an upload fails
- **THEN** the app explains the failure and does not publish a product with a broken image reference
