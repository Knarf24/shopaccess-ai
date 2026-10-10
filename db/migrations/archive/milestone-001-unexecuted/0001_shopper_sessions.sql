-- 0001: anonymous shopper sessions and shared helpers.
-- Apply migrations in filename order. Not applied to any database in this milestone.
BEGIN;

-- Shared trigger function for immutable / append-only tables.
CREATE FUNCTION shopaccess_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TABLE shopper_sessions (
  id                  text PRIMARY KEY CHECK (id ~ '^ses_[0-9a-f]{32}$'),
  -- HMAC-SHA-256 of the session token. The raw token is never stored.
  token_digest        text NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  row_version         integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CHECK (last_seen_at >= created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (absolute_expires_at <= created_at + interval '24 hours')
);

CREATE INDEX shopper_sessions_absolute_expires_at_idx ON shopper_sessions (absolute_expires_at);
CREATE INDEX shopper_sessions_last_seen_at_idx ON shopper_sessions (last_seen_at);

COMMIT;
