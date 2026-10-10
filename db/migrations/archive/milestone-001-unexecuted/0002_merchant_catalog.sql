-- 0002: demo merchant catalog (simulated Sandbox seller). External discovery
-- products are never stored in these tables.
BEGIN;

CREATE TABLE merchants (
  id                   text PRIMARY KEY CHECK (id ~ '^dmm_[a-z0-9]{6,24}$'),
  display_name         text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  is_simulated_sandbox boolean NOT NULL DEFAULT true CHECK (is_simulated_sandbox)
);

CREATE TABLE merchant_products (
  id               text PRIMARY KEY CHECK (id ~ '^dmp_[a-z0-9]{6,24}$'),
  merchant_id      text NOT NULL REFERENCES merchants (id),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description      text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 600),
  image_path       text NOT NULL CHECK (image_path ~ '^/catalog/[a-z0-9-]{1,64}\.svg$'),
  catalog_revision integer NOT NULL CHECK (catalog_revision > 0)
);

CREATE INDEX merchant_products_merchant_id_idx ON merchant_products (merchant_id);

CREATE TABLE merchant_variants (
  id                     text PRIMARY KEY CHECK (id ~ '^dmv_[a-z0-9]{6,24}$'),
  product_id             text NOT NULL REFERENCES merchant_products (id),
  label                  text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  unit_amount_cents      integer NOT NULL CHECK (unit_amount_cents > 0 AND unit_amount_cents <= 2000000),
  currency               text NOT NULL CHECK (currency = 'USD'),
  max_quantity_per_order integer NOT NULL CHECK (max_quantity_per_order BETWEEN 1 AND 10),
  availability           text NOT NULL CHECK (availability IN ('IN_STOCK', 'OUT_OF_STOCK', 'DISCONTINUED')),
  specs                  jsonb NOT NULL,
  catalog_revision       integer NOT NULL CHECK (catalog_revision > 0),
  -- Lets quote_items reference a variant together with its product.
  UNIQUE (id, product_id)
);

CREATE INDEX merchant_variants_product_id_idx ON merchant_variants (product_id);

COMMIT;
