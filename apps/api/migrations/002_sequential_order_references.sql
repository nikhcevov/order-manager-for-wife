-- Short, human-readable order references: ORD-1, ORD-2, ... ORD-<n>.
-- The UUID primary key stays the identity; this only changes the displayed reference.
CREATE SEQUENCE order_number_seq AS bigint START WITH 1;

-- Renumber historic orders in creation order so the format is uniform.
WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM orders
)
UPDATE orders o SET reference = 'ORD-' || numbered.n
FROM numbered WHERE o.id = numbered.id;

-- Continue after the highest assigned number; leave an empty table ready to yield ORD-1.
SELECT setval('order_number_seq', GREATEST((SELECT count(*) FROM orders), 1), (SELECT count(*) FROM orders) > 0);

ALTER TABLE orders ALTER COLUMN reference SET DEFAULT 'ORD-' || nextval('order_number_seq');
