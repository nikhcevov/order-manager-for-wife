CREATE TABLE customers (
 id text PRIMARY KEY CHECK (id ~ '^[0-9]+$'), first_name text NOT NULL, username text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES customers(id),
 expires_at timestamptz NOT NULL
);
CREATE TABLE media (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES customers(id),
 kind text NOT NULL CHECK(kind IN ('product','evidence')), storage_key text NOT NULL UNIQUE,
 mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE products (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 comment text NOT NULL DEFAULT '' CHECK(length(comment)<=4000), price integer NOT NULL CHECK(price>=0),
 remaining_unsold integer NOT NULL CHECK(remaining_unsold>=0),
 published boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE product_images (
 product_id uuid NOT NULL REFERENCES products(id), media_id uuid NOT NULL REFERENCES media(id),
 position integer NOT NULL CHECK(position>=0), PRIMARY KEY(product_id,media_id), UNIQUE(product_id,position)
);
CREATE TABLE fulfillment_groups (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES customers(id),
 method text NOT NULL CHECK(method IN ('delivery','in_person')),
 delivery_code text CHECK(length(delivery_code)<=200),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','packing','completed')),
 version integer NOT NULL DEFAULT 1, completion_kind text CHECK(completion_kind IN ('sent','handed_over')),
 completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,user_id),
 CHECK(method='delivery' OR delivery_code IS NULL),
 CHECK((state='completed' AND completed_at IS NOT NULL AND ((method='delivery' AND completion_kind='sent') OR (method='in_person' AND completion_kind='handed_over'))) OR (state<>'completed' AND completed_at IS NULL AND completion_kind IS NULL))
);
CREATE TABLE orders (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE, user_id text NOT NULL REFERENCES customers(id),
 group_id uuid NOT NULL, status text NOT NULL DEFAULT 'awaiting_payment' CHECK(status IN ('awaiting_payment','payment_review','paid','expired','cancelled','payment_rejected')),
 deadline timestamptz NOT NULL, current_revision uuid NOT NULL, version integer NOT NULL DEFAULT 1,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(group_id,user_id) REFERENCES fulfillment_groups(id,user_id)
);
CREATE TABLE order_revisions (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), number integer NOT NULL CHECK(number>0),
 total bigint NOT NULL CHECK(total>=0), author_id text NOT NULL REFERENCES customers(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(order_id,number), UNIQUE(id,order_id)
);
ALTER TABLE orders ADD CONSTRAINT current_revision_belongs_to_order FOREIGN KEY(current_revision,id) REFERENCES order_revisions(id,order_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE order_lines (
 revision_id uuid NOT NULL REFERENCES order_revisions(id), position integer NOT NULL,
 product_id uuid NOT NULL REFERENCES products(id), name text NOT NULL,
 unit_price integer NOT NULL CHECK(unit_price>=0), quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(revision_id,position)
);
CREATE TABLE payment_evidence (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), revision_id uuid NOT NULL,
 media_id uuid NOT NULL UNIQUE REFERENCES media(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(revision_id,order_id) REFERENCES order_revisions(id,order_id)
);
CREATE TABLE payment_decisions (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES orders(id), revision_id uuid NOT NULL,
 seller_id text NOT NULL REFERENCES customers(id), decision text NOT NULL CHECK(decision IN ('confirmed','rejected')),
 reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(revision_id,order_id) REFERENCES order_revisions(id,order_id)
);
CREATE TABLE change_requests (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), base_revision uuid NOT NULL,
 selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='array'), requested_total bigint NOT NULL CHECK(requested_total>=0), note text NOT NULL DEFAULT '' CHECK(length(note)<=4000),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','withdrawn')),
 resolved_revision uuid REFERENCES order_revisions(id), seller_id text REFERENCES customers(id),
 difference bigint, settlement_note text NOT NULL DEFAULT '', reason text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), resolved_at timestamptz,
 FOREIGN KEY(base_revision,order_id) REFERENCES order_revisions(id,order_id)
);
CREATE UNIQUE INDEX one_pending_change ON change_requests(order_id) WHERE state='pending';
CREATE TABLE checkout_submissions (
 user_id text NOT NULL REFERENCES customers(id), key text NOT NULL, payload_hash text NOT NULL,
 order_id uuid NOT NULL REFERENCES orders(id), PRIMARY KEY(user_id,key)
);
CREATE INDEX orders_group ON orders(group_id);
CREATE INDEX orders_holds ON orders(status,deadline);
CREATE INDEX lines_product ON order_lines(product_id,revision_id);
CREATE INDEX evidence_order ON payment_evidence(order_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE FUNCTION immutable_purchase_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Accepted purchase snapshots are immutable'; END;
$$;
CREATE TRIGGER immutable_revisions BEFORE UPDATE OR DELETE ON order_revisions FOR EACH ROW EXECUTE FUNCTION immutable_purchase_snapshot();
CREATE TRIGGER immutable_lines BEFORE UPDATE OR DELETE ON order_lines FOR EACH ROW EXECUTE FUNCTION immutable_purchase_snapshot();
