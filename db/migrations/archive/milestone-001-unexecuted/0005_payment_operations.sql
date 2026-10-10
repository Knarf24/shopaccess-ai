-- 0005: durable payment-operation ledger and provider observations.
-- An operation row is committed BEFORE any provider call is attempted, and no
-- transaction is held open across a provider call.
BEGIN;

CREATE TABLE payment_operations (
  id                  text PRIMARY KEY CHECK (id ~ '^op_[0-9a-f]{32}$'),
  checkout_intent_id  text NOT NULL REFERENCES checkout_intents (id),
  operation_type      text NOT NULL CHECK (operation_type IN ('ORDER_CREATE', 'CAPTURE')),
  sequence            integer NOT NULL CHECK (sequence >= 1),
  -- Stable idempotency ID reused on every attempt of this logical operation.
  provider_request_id text NOT NULL UNIQUE CHECK (provider_request_id ~ '^rq_[0-9a-f]{32}$'),
  payload_digest      text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  state               text NOT NULL DEFAULT 'PENDING' CHECK (state IN (
    'PENDING', 'DISPATCHING', 'UNKNOWN', 'READBACK_CLEARED',
    'PENDING_PROVIDER', 'SUCCEEDED', 'DECLINED', 'REJECTED', 'CONFLICT')),
  lease_owner         text,
  lease_expires_at    timestamptz,
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_reference  text,
  row_version         integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  -- One logical operation per intent, type and sequence.
  UNIQUE (checkout_intent_id, operation_type, sequence),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (state <> 'DISPATCHING' OR lease_owner IS NOT NULL)
);

-- Only one order-create operation may ever exist for an intent.
CREATE UNIQUE INDEX payment_operations_single_order_create_idx
  ON payment_operations (checkout_intent_id) WHERE operation_type = 'ORDER_CREATE';
-- At most one capture that has not been definitively declined or rejected.
CREATE UNIQUE INDEX payment_operations_single_live_capture_idx
  ON payment_operations (checkout_intent_id)
  WHERE operation_type = 'CAPTURE' AND state NOT IN ('DECLINED', 'REJECTED');
-- Recovery scan: operations needing attention, by lease expiry.
CREATE INDEX payment_operations_recovery_idx
  ON payment_operations (state, lease_expires_at)
  WHERE state IN ('DISPATCHING', 'UNKNOWN', 'PENDING_PROVIDER', 'READBACK_CLEARED');

CREATE TABLE payment_provider_observations (
  id                  text PRIMARY KEY CHECK (id ~ '^ob_[0-9a-f]{32}$'),
  checkout_intent_id  text NOT NULL REFERENCES checkout_intents (id),
  operation_id        text REFERENCES payment_operations (id),
  source              text NOT NULL CHECK (source IN ('provider_response', 'provider_readback', 'provider_observation')),
  subject             text NOT NULL CHECK (subject IN ('ORDER', 'CAPTURE')),
  provider_order_id   text,
  provider_capture_id text,
  observed_status     text NOT NULL CHECK (char_length(observed_status) BETWEEN 1 AND 200),
  -- Set when the evidence was rejected: the reason, and what the provider actually reported.
  conflict            text CHECK (conflict IS NULL OR char_length(conflict) BETWEEN 1 AND 64),
  reported_amount_cents bigint,
  reported_currency   text,
  observed_at         timestamptz NOT NULL
);

CREATE INDEX payment_provider_observations_intent_idx ON payment_provider_observations (checkout_intent_id, observed_at);

-- Observations are evidence: recorded once, never edited.
CREATE TRIGGER payment_provider_observations_append_only BEFORE UPDATE OR DELETE ON payment_provider_observations
  FOR EACH ROW EXECUTE FUNCTION shopaccess_reject_change();

COMMIT;
