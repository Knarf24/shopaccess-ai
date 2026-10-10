-- 0003: demo merchant catalog (simulated Sandbox seller). External discovery
-- products are never stored in these tables.
--
-- Milestone 002, Increment 1. Column definitions, types and ranges are those of
-- the archived Milestone 001 draft, unchanged. No BEGIN or COMMIT: the runner
-- owns the transaction. NEVER EXECUTED: written under Gate B-W.

CREATE TABLE shopaccess.merchants (
  id                   text PRIMARY KEY CHECK (id ~ '^dmm_[a-z0-9]{6,24}$'),
  display_name         text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  is_simulated_sandbox boolean NOT NULL DEFAULT true CHECK (is_simulated_sandbox)
);

CREATE TABLE shopaccess.merchant_products (
  id               text PRIMARY KEY CHECK (id ~ '^dmp_[a-z0-9]{6,24}$'),
  merchant_id      text NOT NULL REFERENCES shopaccess.merchants (id),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description      text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 600),
  image_path       text NOT NULL CHECK (image_path ~ '^/catalog/[a-z0-9-]{1,64}\.svg$'),
  catalog_revision integer NOT NULL CHECK (catalog_revision > 0)
);

CREATE INDEX merchant_products_merchant_id_idx ON shopaccess.merchant_products (merchant_id);

CREATE TABLE shopaccess.merchant_variants (
  id                     text PRIMARY KEY CHECK (id ~ '^dmv_[a-z0-9]{6,24}$'),
  product_id             text NOT NULL REFERENCES shopaccess.merchant_products (id),
  label                  text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  unit_amount_cents      integer NOT NULL CHECK (unit_amount_cents > 0 AND unit_amount_cents <= 2000000),
  currency               text NOT NULL CHECK (currency = 'USD'),
  max_quantity_per_order integer NOT NULL CHECK (max_quantity_per_order BETWEEN 1 AND 10),
  availability           text NOT NULL CHECK (availability IN ('IN_STOCK', 'OUT_OF_STOCK', 'DISCONTINUED')),
  specs                  jsonb NOT NULL,
  catalog_revision       integer NOT NULL CHECK (catalog_revision > 0),
  -- Lets a later quote item reference a variant together with its product.
  UNIQUE (id, product_id)
);

CREATE INDEX merchant_variants_product_id_idx ON shopaccess.merchant_variants (product_id);

-- The merchant catalog is public reference data for the web process. Rows are
-- written only by migrations. The worker receives nothing in Increment 1.
GRANT SELECT ON shopaccess.merchants, shopaccess.merchant_products, shopaccess.merchant_variants TO shopaccess_web;
