-- Automatic fulfillment packages: one open package per customer, method chosen at shipment.
-- Replaces the customer-chosen groups and the packing/freeze/reopen cycle.

-- Rebuild the table's CHECK constraints so the new model is authoritative.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'fulfillment_groups'::regclass AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE fulfillment_groups DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

-- Method is unknown until the seller ships an open package.
ALTER TABLE fulfillment_groups ALTER COLUMN method DROP NOT NULL;

-- The intermediate packing state is gone; the only cut-off is the shipment itself.
UPDATE fulfillment_groups SET state = 'open' WHERE state = 'packing';

-- At most one open package per customer: fold older open packages into the newest.
CREATE TEMP TABLE package_merge AS
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn,
         first_value(id) OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS survivor
  FROM fulfillment_groups
  WHERE state = 'open'
)
SELECT id AS loser, survivor FROM ranked WHERE rn > 1;

-- Carry any delivery code onto the surviving package before the others are removed.
UPDATE fulfillment_groups s
SET delivery_code = source.delivery_code
FROM (
  SELECT DISTINCT ON (m.survivor) m.survivor, g.delivery_code
  FROM package_merge m
  JOIN fulfillment_groups g ON g.id = m.loser
  WHERE g.delivery_code IS NOT NULL
  ORDER BY m.survivor, m.loser
) source
WHERE s.id = source.survivor AND s.delivery_code IS NULL;

UPDATE orders SET group_id = pm.survivor, version = version + 1
FROM package_merge pm WHERE orders.group_id = pm.loser;

DELETE FROM fulfillment_groups g USING package_merge pm WHERE g.id = pm.loser;

DROP TABLE package_merge;

-- An open package has no method yet.
UPDATE fulfillment_groups SET method = NULL WHERE state = 'open';

ALTER TABLE fulfillment_groups ADD CONSTRAINT fulfillment_groups_state_valid
  CHECK (state IN ('open','completed'));
ALTER TABLE fulfillment_groups ADD CONSTRAINT fulfillment_groups_method_valid
  CHECK (method IS NULL OR method IN ('delivery','in_person'));
ALTER TABLE fulfillment_groups ADD CONSTRAINT fulfillment_groups_delivery_code_length
  CHECK (length(delivery_code) <= 200);
ALTER TABLE fulfillment_groups ADD CONSTRAINT fulfillment_groups_completion_kind_valid
  CHECK (completion_kind IS NULL OR completion_kind IN ('sent','handed_over'));
ALTER TABLE fulfillment_groups ADD CONSTRAINT fulfillment_groups_completion_consistent
  CHECK (
    (state = 'completed' AND method IS NOT NULL AND completed_at IS NOT NULL AND completion_kind IS NOT NULL
      AND ((method = 'delivery' AND completion_kind = 'sent')
        OR (method = 'in_person' AND completion_kind = 'handed_over')))
    OR (state = 'open' AND method IS NULL AND completed_at IS NULL AND completion_kind IS NULL)
  );
ALTER TABLE fulfillment_groups ADD CONSTRAINT fulfillment_groups_code_requires_delivery
  CHECK (state <> 'completed' OR method = 'delivery' OR delivery_code IS NULL);

CREATE UNIQUE INDEX fulfillment_groups_one_open_per_customer
  ON fulfillment_groups(user_id) WHERE state = 'open';
