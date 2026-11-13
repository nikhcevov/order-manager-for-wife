-- Indexes for the queries on the order, catalog, and cleanup hot paths.
-- All are additive and safe for the Node service to ignore after a rollback.
CREATE INDEX IF NOT EXISTS orders_current_revision ON orders(current_revision);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC, id);
CREATE INDEX IF NOT EXISTS change_requests_order ON change_requests(order_id);
CREATE INDEX IF NOT EXISTS fulfillment_groups_user ON fulfillment_groups(user_id);
CREATE INDEX IF NOT EXISTS media_created ON media(created_at);
