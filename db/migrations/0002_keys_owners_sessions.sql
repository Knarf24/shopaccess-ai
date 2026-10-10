-- 0002: session admission guard, server key versions, checkout owners, shopper sessions.
--
-- Milestone 002, Increment 1. No BEGIN or COMMIT: the runner owns the transaction.
-- NEVER EXECUTED: written under Gate B-W.
--
-- No runtime role receives INSERT, UPDATE, DELETE or TRUNCATE on any of these
-- tables. They are changed only through the functions of migration 0006.

-- ---------------------------------------------------------------------------
-- session_admission_guard: one row that serializes admissions and holds the
-- per-minute admission budget.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.session_admission_guard (
  id                smallint PRIMARY KEY CHECK (id = 1),
  window_started_at timestamptz NOT NULL,
  window_admissions integer NOT NULL CHECK (window_admissions >= 0),
  updated_at        timestamptz NOT NULL
);

INSERT INTO shopaccess.session_admission_guard (id, window_started_at, window_admissions, updated_at)
VALUES (1, clock_timestamp(), 0, clock_timestamp());

-- The row can never be removed; the primary key and CHECK prevent a second one.
CREATE TRIGGER session_admission_guard_no_delete BEFORE DELETE ON shopaccess.session_admission_guard
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER session_admission_guard_no_truncate BEFORE TRUNCATE ON shopaccess.session_admission_guard
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

-- ---------------------------------------------------------------------------
-- server_key_versions: which key versions exist and their standing.
-- Holds a one-way check value only. Never key material.
-- A staged key has no row here until an operator activates it.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.server_key_versions (
  purpose      text NOT NULL CHECK (purpose IN ('session', 'confirmation_nonce')),
  key_version  smallint NOT NULL CHECK (key_version > 0),
  status       text NOT NULL CHECK (status IN ('ACTIVE', 'VERIFY_ONLY', 'REVOKED')),
  -- HMAC-SHA-256(key, 'shopaccess.keycheck.v1' || 0x00 || purpose), lowercase hex.
  check_value  text NOT NULL CHECK (check_value ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz NOT NULL,
  revoked_at   timestamptz,
  PRIMARY KEY (purpose, key_version),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

-- At most one ACTIVE version per purpose.
CREATE UNIQUE INDEX server_key_versions_one_active_idx
  ON shopaccess.server_key_versions (purpose) WHERE status = 'ACTIVE';

CREATE FUNCTION shopaccess.server_key_versions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a key version is inserted as ACTIVE' USING ERRCODE = 'restrict_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM shopaccess.server_key_versions k
      WHERE k.purpose = NEW.purpose AND k.key_version >= NEW.key_version
    ) THEN
      RAISE EXCEPTION 'a new key version must be higher than every existing version' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: identity, check value and activation time never change.
  IF NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.key_version IS DISTINCT FROM OLD.key_version
     OR NEW.check_value IS DISTINCT FROM OLD.check_value
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'key version identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Status only moves forward.
  IF NOT (
    (OLD.status = 'ACTIVE' AND NEW.status IN ('VERIFY_ONLY', 'REVOKED'))
    OR (OLD.status = 'VERIFY_ONLY' AND NEW.status = 'REVOKED')
  ) THEN
    RAISE EXCEPTION 'illegal key version status change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION shopaccess.server_key_versions_guard() FROM PUBLIC;

CREATE TRIGGER server_key_versions_guard BEFORE INSERT OR UPDATE ON shopaccess.server_key_versions
  FOR EACH ROW EXECUTE FUNCTION shopaccess.server_key_versions_guard();
CREATE TRIGGER server_key_versions_no_delete BEFORE DELETE ON shopaccess.server_key_versions
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER server_key_versions_no_truncate BEFORE TRUNCATE ON shopaccess.server_key_versions
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

-- Status and check values are not secret. The web process reads them to find
-- the ACTIVE version; operators read them to manage keys.
GRANT SELECT ON shopaccess.server_key_versions TO shopaccess_web, shopaccess_operator;

-- ---------------------------------------------------------------------------
-- checkout_owners: the durable identity that checkout data will belong to.
-- The id is generated inside admit_session. It is opaque, not a credential.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.checkout_owners (
  id         text PRIMARY KEY CHECK (id ~ '^own_[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL
);

CREATE TRIGGER checkout_owners_immutable BEFORE UPDATE ON shopaccess.checkout_owners
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER checkout_owners_no_truncate BEFORE TRUNCATE ON shopaccess.checkout_owners
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

-- ---------------------------------------------------------------------------
-- shopper_sessions: expiring credentials. Nothing references this table.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.shopper_sessions (
  id                  text PRIMARY KEY CHECK (id ~ '^ses_[0-9a-f]{32}$'),
  owner_id            text NOT NULL REFERENCES shopaccess.checkout_owners (id),
  key_purpose         text NOT NULL DEFAULT 'session' CHECK (key_purpose = 'session'),
  key_version         smallint NOT NULL,
  -- HMAC-SHA-256 of the session token. The raw token is never stored.
  token_digest        text NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  row_version         integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  FOREIGN KEY (key_purpose, key_version) REFERENCES shopaccess.server_key_versions (purpose, key_version),
  CHECK (last_seen_at >= created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (absolute_expires_at <= created_at + interval '24 hours')
);

CREATE INDEX shopper_sessions_absolute_expires_at_idx ON shopaccess.shopper_sessions (absolute_expires_at);
CREATE INDEX shopper_sessions_last_seen_at_idx ON shopaccess.shopper_sessions (last_seen_at);
CREATE INDEX shopper_sessions_owner_id_idx ON shopaccess.shopper_sessions (owner_id);

CREATE FUNCTION shopaccess.shopper_sessions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  -- Idle timeout. Must equal the constant in shopaccess_api.session_is_live
  -- (migration 0006) and the application constant; tests check all three.
  c_idle_timeout constant interval := interval '2 hours';
  v_touch_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.row_version <> 1 OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a session is inserted live at row version 1' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM shopaccess.server_key_versions k
      WHERE k.purpose = NEW.key_purpose AND k.key_version = NEW.key_version AND k.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'a session is inserted under the ACTIVE key version' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. Identity columns never change, and every accepted update raises
  -- row_version by exactly one.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.key_purpose IS DISTINCT FROM OLD.key_purpose
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at THEN
    RAISE EXCEPTION 'session identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'row_version rises by exactly one per update' USING ERRCODE = 'restrict_violation';
  END IF;

  v_touch_ok := OLD.revoked_at IS NULL
    AND NEW.last_seen_at >= OLD.last_seen_at
    AND NEW.last_seen_at < OLD.last_seen_at + c_idle_timeout
    AND NEW.last_seen_at < OLD.absolute_expires_at;

  -- Shape 1, revoke: only revoked_at changes, from NULL to a value.
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.token_digest = OLD.token_digest
     AND NEW.key_version = OLD.key_version
     AND NEW.last_seen_at = OLD.last_seen_at THEN
    RETURN NEW;
  END IF;

  -- From here on revoked_at must be unchanged.
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'illegal session update' USING ERRCODE = 'restrict_violation';
  END IF;

  -- Shape 2, touch: only last_seen_at changes.
  IF NEW.token_digest = OLD.token_digest AND NEW.key_version = OLD.key_version AND v_touch_ok THEN
    RETURN NEW;
  END IF;

  -- Shape 3, rotate: new digest, key version not lower and ACTIVE, touch conditions.
  IF NEW.token_digest <> OLD.token_digest
     AND NEW.key_version >= OLD.key_version
     AND v_touch_ok
     AND EXISTS (
       SELECT 1 FROM shopaccess.server_key_versions k
       WHERE k.purpose = NEW.key_purpose AND k.key_version = NEW.key_version AND k.status = 'ACTIVE'
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal session update' USING ERRCODE = 'restrict_violation';
END;
$$;
REVOKE ALL ON FUNCTION shopaccess.shopper_sessions_guard() FROM PUBLIC;

CREATE TRIGGER shopper_sessions_guard BEFORE INSERT OR UPDATE ON shopaccess.shopper_sessions
  FOR EACH ROW EXECUTE FUNCTION shopaccess.shopper_sessions_guard();
CREATE TRIGGER shopper_sessions_no_truncate BEFORE TRUNCATE ON shopaccess.shopper_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();
-- Row deletion is allowed (expired-session cleanup) but only shopaccess_definer
-- is granted DELETE, in migration 0006.
