-- 0003: session-owned carts.
BEGIN;

CREATE TABLE carts (
  id          text PRIMARY KEY CHECK (id ~ '^ct_[0-9a-f]{32}$'),
  session_id  text NOT NULL REFERENCES shopper_sessions (id),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE INDEX carts_session_id_idx ON carts (session_id);

CREATE TABLE cart_items (
  cart_id    text NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  variant_id text NOT NULL REFERENCES merchant_variants (id),
  quantity   integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  added_at   timestamptz NOT NULL,
  PRIMARY KEY (cart_id, variant_id)
);

COMMIT;
