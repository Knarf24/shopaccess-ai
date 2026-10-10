-- 0006: sanitized, append-only audit events.
-- Rows are written only through the application sanitizer. session_id and the
-- other references are deliberately not foreign keys so audit history does not
-- constrain, and is not removed by, changes to operational tables.
--
-- Retention: a 30-day period is PROPOSED for Sandbox payment/audit records. It
-- is not implemented here. Because UPDATE and DELETE are blocked, retention
-- will need a separately reviewed, privileged maintenance path (for example
-- time-partitioned tables with partition drops) at the deployment stage.
BEGIN;

CREATE TABLE audit_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id           text NOT NULL UNIQUE CHECK (char_length(event_id) BETWEEN 1 AND 64),
  event_type         text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  actor              text NOT NULL CHECK (actor ~ '^[a-z_]{2,32}$'),
  session_id         text,
  checkout_intent_id text,
  operation_id       text,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192)
);

CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at);
CREATE INDEX audit_events_checkout_intent_idx ON audit_events (checkout_intent_id, occurred_at);

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION shopaccess_reject_change();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess_reject_change();

COMMIT;
