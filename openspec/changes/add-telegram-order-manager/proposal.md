# Proposal

## Why

Selling through Telegram messages makes it difficult to keep stock, payment evidence, order changes, and packing lists consistent. A single-shop Telegram Mini App will let customers reserve purchases while giving the seller one place to verify manual payments and prepare combined deliveries or in-person handovers.

## What Changes

- Introduce a mobile-first React Telegram Mini App and a Node.js backend, with verified Telegram identity and seller-only administration.
- Let the seller prepare products privately with name, images, price, quantity, and optional comment, then publish selected products together.
- Provide a published catalog, cart, and atomic order submission. Carts do not hold stock; confirmed orders create timed holds and reduce customer-visible availability.
- Collect manual-payment screenshots in the app. Evidence received before the deadline keeps items reserved until the seller confirms or rejects payment; a screenshot alone never marks items bought.
- Support atomic edits to unpaid orders without extending their deadline, and seller-reviewed change requests after payment evidence or payment confirmation. Preserve payment and purchase history when approving corrections; additional purchases can remain separate orders.
- Group a customer's orders for one fulfillment event, with exactly one method for the whole group: delivery or in-person handover. Delivery codes are optional, customer-supplied after creating an external shipment request, and absent for in-person handover.
- Provide seller queues for payment review and fulfillment, combined packing lists, and completion as sent or handed over. Unpaid additions cannot be dispatched as paid purchases.

## Capabilities

### New Capabilities

- `telegram-access`: Verified Telegram customer identity, ownership boundaries, seller authorization, and Telegram-native presentation.
- `product-catalog`: Private product preparation, batch publication, media, pricing, stock maintenance, and customer-visible availability.
- `order-management`: Cart checkout, timed inventory holds, concurrent-stock correctness, order history, and controlled order edits.
- `manual-payments`: Payment instructions, protected screenshot evidence, review-held reservations, and explicit seller confirmation or rejection.
- `order-fulfillment`: Grouped purchases, one delivery or handover method, optional delivery codes, packing readiness, and completion.

### Modified Capabilities

None. The project currently has no durable capability specs or application implementation.

## Impact

- Greenfield application: new frontend, backend, database schema, protected media handling, and deployment/runtime configuration will be required during implementation. This change creates planning artifacts only.
- Proposed infrastructure: TypeScript, React with Vite, a single Node service, PostgreSQL for transactional stock and durable reservations, and persistent media storage.
- External dependencies: a Telegram bot configured to launch the HTTPS Mini App; manual payment and shipment creation remain outside the application.
- No existing API or data migration is affected.
- Out of scope: integrated payments, automatic payment recognition, delivery-service APIs, automatic channel posting, multi-shop support, supplier procurement, automated refunds, and mixed fulfillment methods within one group. Telegram chat remains available for exceptional communication but is not the authoritative order record.
