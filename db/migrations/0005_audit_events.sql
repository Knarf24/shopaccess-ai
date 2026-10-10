-- 0005: sanitized, append-only audit events.
--
-- Milestone 002, Increment 1. session_id and the other references are
-- deliberately not foreign keys, so audit history neither constrains nor is
-- removed by changes to operational tables. No BEGIN or COMMIT: the runner owns
-- the transaction. NEVER EXECUTED: written under Gate B-W.
--
-- In Increment 1 the only writers are the two operator key functions of
-- migration 0006, with event types KEY_VERSION_ACTIVATED and KEY_VERSION_REVOKED.
-- No retention or deletion mechanism exists or is authorized.

CREATE TABLE shopaccess.audit_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id           text NOT NULL UNIQUE CHECK (char_length(event_id) BETWEEN 1 AND 64),
  event_type         text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL,
  actor              text NOT NULL CHECK (actor ~ '^[a-z_]{2,32}$'),
  session_id         text,
  owner_id           text,
  checkout_intent_id text,
  operation_id       text,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192)
);

CREATE INDEX audit_events_occurred_at_idx ON shopaccess.audit_events (occurred_at);
CREATE INDEX audit_events_checkout_intent_idx ON shopaccess.audit_events (checkout_intent_id, occurred_at);

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON shopaccess.audit_events
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON shopaccess.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

GRANT SELECT ON shopaccess.audit_events TO shopaccess_operator;
