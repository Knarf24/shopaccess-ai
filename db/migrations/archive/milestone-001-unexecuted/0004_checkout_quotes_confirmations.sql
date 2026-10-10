-- 0004: checkout intents, immutable quotes, and single-use confirmations.
-- Composite foreign keys carry session_id so a quote or confirmation can never
-- point at an intent owned by a different session.
BEGIN;

CREATE TABLE checkout_intents (
  id                        text PRIMARY KEY CHECK (id ~ '^ci_[0-9a-f]{32}$'),
  session_id                text NOT NULL REFERENCES shopper_sessions (id),
  -- Local workflow state. Provider-reported facts live in payment_provider_observations.
  state                     text NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
    'DRAFT', 'QUOTED', 'USER_CONFIRMED',
    'ORDER_CREATE_IN_FLIGHT', 'ORDER_CREATE_UNKNOWN',
    'AWAITING_APPROVAL', 'APPROVAL_CHECK_PENDING', 'APPROVED_VERIFIED',
    'CAPTURE_IN_FLIGHT', 'CAPTURE_UNKNOWN', 'CAPTURE_PENDING_PROVIDER', 'CAPTURED_VERIFIED',
    'DECLINED_RETRYABLE', 'RECONCILIATION_REQUIRED',
    'SUPERSEDED', 'CANCELED_LOCAL', 'EXPIRED', 'FAILED_TERMINAL', 'MANUAL_REVIEW',
    'PARTIALLY_REFUNDED_OBSERVED', 'REFUNDED_OBSERVED', 'REVERSED_OR_DISPUTED_OBSERVED')),
  row_version               integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  current_quote_id          text,
  confirmation_id           text,
  order_create_operation_id text,
  capture_operation_id      text,
  capture_dispatched        boolean NOT NULL DEFAULT false,
  provider_order_id         text UNIQUE,
  provider_capture_id       text UNIQUE,
  superseded_by_intent_id   text REFERENCES checkout_intents (id),
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  UNIQUE (id, session_id)
);

CREATE INDEX checkout_intents_session_id_idx ON checkout_intents (session_id);
CREATE INDEX checkout_intents_state_idx ON checkout_intents (state, updated_at);

CREATE TABLE quotes (
  id                 text PRIMARY KEY CHECK (id ~ '^qt_[0-9a-f]{32}$'),
  session_id         text NOT NULL,
  checkout_intent_id text NOT NULL,
  merchant_id        text NOT NULL REFERENCES merchants (id),
  catalog_revision   integer NOT NULL CHECK (catalog_revision > 0),
  subtotal_cents     bigint NOT NULL CHECK (subtotal_cents > 0),
  discount_cents     bigint NOT NULL CHECK (discount_cents = 0),
  tax_cents          bigint NOT NULL CHECK (tax_cents = 0),
  shipping_cents     bigint NOT NULL CHECK (shipping_cents = 0),
  total_cents        bigint NOT NULL CHECK (total_cents > 0),
  currency           text NOT NULL CHECK (currency = 'USD'),
  created_at         timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  digest             text NOT NULL UNIQUE CHECK (digest ~ '^[0-9a-f]{64}$'),
  CHECK (total_cents = subtotal_cents - discount_cents + tax_cents + shipping_cents),
  CHECK (expires_at = created_at + interval '15 minutes'),
  FOREIGN KEY (checkout_intent_id, session_id) REFERENCES checkout_intents (id, session_id),
  UNIQUE (id, session_id)
);

CREATE INDEX quotes_checkout_intent_id_idx ON quotes (checkout_intent_id);
CREATE INDEX quotes_session_id_idx ON quotes (session_id);

CREATE TABLE quote_items (
  quote_id            text NOT NULL REFERENCES quotes (id),
  line_number         integer NOT NULL CHECK (line_number >= 1),
  product_id          text NOT NULL,
  variant_id          text NOT NULL,
  quantity            integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_amount_cents   bigint NOT NULL CHECK (unit_amount_cents > 0),
  line_subtotal_cents bigint NOT NULL CHECK (line_subtotal_cents = unit_amount_cents * quantity),
  PRIMARY KEY (quote_id, line_number),
  FOREIGN KEY (variant_id, product_id) REFERENCES merchant_variants (id, product_id)
);

-- Quotes are immutable: a material change means a new quote and a new confirmation.
CREATE TRIGGER quotes_immutable BEFORE UPDATE OR DELETE ON quotes
  FOR EACH ROW EXECUTE FUNCTION shopaccess_reject_change();
CREATE TRIGGER quote_items_immutable BEFORE UPDATE OR DELETE ON quote_items
  FOR EACH ROW EXECUTE FUNCTION shopaccess_reject_change();

CREATE TABLE confirmations (
  id                 text PRIMARY KEY CHECK (id ~ '^cf_[0-9a-f]{32}$'),
  session_id         text NOT NULL,
  checkout_intent_id text NOT NULL,
  quote_id           text NOT NULL,
  quote_digest       text NOT NULL CHECK (quote_digest ~ '^[0-9a-f]{64}$'),
  -- Exactly what the shopper was shown.
  summary            jsonb NOT NULL,
  -- SHA-256 of the single-use nonce. The raw nonce is never stored.
  nonce_digest       text NOT NULL UNIQUE CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  issued_at          timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (consumed_at IS NULL OR consumed_at < expires_at),
  FOREIGN KEY (checkout_intent_id, session_id) REFERENCES checkout_intents (id, session_id),
  FOREIGN KEY (quote_id, session_id) REFERENCES quotes (id, session_id)
);

CREATE INDEX confirmations_session_id_idx ON confirmations (session_id);
-- Exactly one challenge row per quote. Issuing a replacement overwrites the unconsumed row
-- (upsert guarded by consumed_at IS NULL), so superseded challenges never accumulate and a
-- consumed challenge can never be replaced or confirmed twice.
CREATE UNIQUE INDEX confirmations_one_per_quote_idx ON confirmations (quote_id);
CREATE INDEX confirmations_unconsumed_expiry_idx ON confirmations (expires_at) WHERE consumed_at IS NULL;

COMMIT;
