-- 0006: the six trusted entry-point functions of Increment 1, their one
-- internal helper, the function owner's table privileges and the EXECUTE grants.
--
-- Milestone 002, Increment 1. No BEGIN or COMMIT: the runner owns the transaction.
-- NEVER EXECUTED: written under Gate B-W. No statement here has been parsed or
-- run by PostgreSQL.
--
-- Rules that hold for every entry point below:
--   * SECURITY DEFINER, owned by shopaccess_definer (handed over at the end of
--     this file), fixed search path pg_catalog, pg_temp, every object reference
--     schema-qualified, no dynamic SQL.
--   * Exactly one result row. An expected refusal is a result code, never an error.
--   * The decision time is clock_timestamp() read after the last blocking lock.
--     No function has a time parameter and none reads a session setting.
--   * No function commits. No function touches a payment provider.
--
-- Lock acquisition order (specification 13.3). Every function takes its locks
-- in this order and never in another, so no two of them can deadlock:
--   1. the session_admission_guard row
--   2. server_key_versions rows
--   3. shopper_sessions rows
--     admit_session        1 FOR UPDATE; 2 FOR SHARE; 3 only without waiting
--                          (SKIP LOCKED), so it never waits for a session row
--     authorize_session    3
--     rotate_session       2 FOR SHARE; 3
--     revoke_session       3
--     activate_key_version 1; 2
--     revoke_key_version   1; 2; 3
-- A lock wait that exceeds lock_timeout raises an error (55P03). No function
-- catches it, so an admission whose capacity is uncertain fails closed.
--
-- "#variable_conflict use_column" makes an unqualified name that is both an
-- output column and a table column mean the table column.

-- ---------------------------------------------------------------------------
-- Internal helper: the liveness rule (specification 4.3) as a pure function of
-- row values and an explicit time. Entry points always pass clock_timestamp().
-- Executable only by its owner; tests call it as the test owner to check exact
-- boundaries. p_key_status is NULL when the key version has no row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.session_is_live(
  p_revoked_at          timestamptz,
  p_absolute_expires_at timestamptz,
  p_last_seen_at        timestamptz,
  p_key_status          text,
  p_t                   timestamptz
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_revoked_at IS NULL
     AND p_t < p_absolute_expires_at
     AND p_t < p_last_seen_at + interval '2 hours'
     AND coalesce(p_key_status IN ('ACTIVE', 'VERIFY_ONLY'), false);
$$;

-- ---------------------------------------------------------------------------
-- admit_session (web)
-- Locks: guard row FOR UPDATE; the named key-version row FOR SHARE; dead
-- session rows without waiting.
--
-- Capacity rule. The guard row is held FOR UPDATE, so admissions are serial and
-- no other transaction can insert or delete a session row. After removing the
-- rows that are dead AND that nobody else holds, the function counts EVERY
-- remaining row against the limit of 500, whether or not it looks live at v_t.
-- A row it could not lock may be in the middle of an authorize_session touch or
-- a rotation that will make it live again when that transaction commits, so it
-- is never treated as expired. The number of live sessions can therefore never
-- exceed the number of rows, and the number of rows never exceeds 500.
-- The count does not depend on the time, and nothing after v_t waits for a
-- lock, so v_t does not have to be read again.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.admit_session(
  p_session_id   text,
  p_key_version  smallint,
  p_token_digest text
) RETURNS TABLE (result text, absolute_expires_at timestamptz, idle_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  c_window            constant interval := interval '1 minute';
  c_max_admissions    constant integer  := 30;
  c_max_live_sessions constant integer  := 500;
  c_absolute_lifetime constant interval := interval '24 hours';
  c_idle_timeout      constant interval := interval '2 hours';
  v_window_started_at timestamptz;
  v_window_admissions integer;
  v_key_status        text;
  v_t                 timestamptz;
  v_occupied          integer;
  v_owner_id          text;
BEGIN
  IF p_session_id IS NULL OR p_session_id !~ '^ses_[0-9a-f]{32}$'
     OR p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$'
     OR p_key_version IS NULL OR p_key_version <= 0 THEN
    RETURN QUERY SELECT 'REFUSED'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT g.window_started_at, g.window_admissions
    INTO v_window_started_at, v_window_admissions
    FROM shopaccess.session_admission_guard g
   WHERE g.id = 1
     FOR UPDATE;
  IF NOT FOUND THEN
    -- A missing guard row is never recreated: admission is refused.
    RETURN QUERY SELECT 'REFUSED'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version
     FOR SHARE;

  v_t := clock_timestamp();

  IF v_t >= v_window_started_at + c_window THEN
    v_window_started_at := v_t;
    v_window_admissions := 0;
  END IF;

  IF v_window_admissions >= c_max_admissions THEN
    -- The budget is not consumed by this refusal.
    RETURN QUERY SELECT 'RATE_LIMITED'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_key_status IS DISTINCT FROM 'ACTIVE' THEN
    -- Missing, verification-only or revoked key version. Budget not consumed.
    RETURN QUERY SELECT 'KEY_NOT_ACTIVE'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  -- From here the attempt consumes budget, whatever the outcome.
  UPDATE shopaccess.session_admission_guard g
     SET window_started_at = v_window_started_at,
         window_admissions = v_window_admissions + 1,
         updated_at = v_t
   WHERE g.id = 1;

  -- Remove sessions that are dead at v_t and that this transaction could lock.
  -- A row held by another transaction is skipped here and stays counted below.
  DELETE FROM shopaccess.shopper_sessions s
   WHERE s.id IN (
     SELECT d.id
       FROM shopaccess.shopper_sessions d
      WHERE NOT shopaccess_api.session_is_live(
              d.revoked_at, d.absolute_expires_at, d.last_seen_at,
              (SELECT k.status FROM shopaccess.server_key_versions k
                WHERE k.purpose = d.key_purpose AND k.key_version = d.key_version),
              v_t)
        FOR UPDATE OF d SKIP LOCKED
   );

  -- Every remaining row occupies a slot. No liveness filter: see the capacity rule.
  SELECT count(*)::integer INTO v_occupied
    FROM shopaccess.shopper_sessions d;

  IF v_occupied >= c_max_live_sessions THEN
    -- This refusal has consumed the budget.
    RETURN QUERY SELECT 'AT_CAPACITY'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  -- The owner id is generated here. No caller supplies one and none is returned.
  v_owner_id := 'own_' || replace(gen_random_uuid()::text, '-', '');

  BEGIN
    INSERT INTO shopaccess.checkout_owners (id, created_at) VALUES (v_owner_id, v_t);
    INSERT INTO shopaccess.shopper_sessions
      (id, owner_id, key_purpose, key_version, token_digest, created_at, last_seen_at, absolute_expires_at, revoked_at, row_version)
    VALUES
      (p_session_id, v_owner_id, 'session', p_key_version, p_token_digest, v_t, v_t, v_t + c_absolute_lifetime, NULL, 1);
  EXCEPTION WHEN unique_violation THEN
    -- Identifier or digest collision. Neither row is kept.
    RETURN QUERY SELECT 'REFUSED'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END;

  RETURN QUERY SELECT 'ADMITTED'::text, v_t + c_absolute_lifetime, v_t + c_idle_timeout;
END;
$$;

-- ---------------------------------------------------------------------------
-- authorize_session (web)
-- Locks: the session row FOR NO KEY UPDATE. Writes nothing on refusal.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.authorize_session(
  p_key_version  smallint,
  p_token_digest text
) RETURNS TABLE (result text, session_id text, absolute_expires_at timestamptz, idle_expires_at timestamptz, key_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  c_idle_timeout    constant interval := interval '2 hours';
  c_touch_threshold constant interval := interval '60 seconds';
  v_id                  text;
  v_revoked_at          timestamptz;
  v_absolute_expires_at timestamptz;
  v_last_seen_at        timestamptz;
  v_key_status          text;
  v_t                   timestamptz;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$'
     OR p_key_version IS NULL OR p_key_version <= 0 THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;

  SELECT s.id, s.revoked_at, s.absolute_expires_at, s.last_seen_at
    INTO v_id, v_revoked_at, v_absolute_expires_at, v_last_seen_at
    FROM shopaccess.shopper_sessions s
   WHERE s.key_purpose = 'session' AND s.key_version = p_key_version AND s.token_digest = p_token_digest
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;

  v_t := clock_timestamp();

  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;

  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, v_t) THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::text;
    RETURN;
  END IF;

  -- Touch only past the threshold, so most requests write nothing.
  IF v_t - v_last_seen_at > c_touch_threshold THEN
    UPDATE shopaccess.shopper_sessions s
       SET last_seen_at = v_t,
           row_version = s.row_version + 1
     WHERE s.id = v_id;
    v_last_seen_at := v_t;
  END IF;

  RETURN QUERY SELECT 'AUTHORIZED'::text, v_id, v_absolute_expires_at, v_last_seen_at + c_idle_timeout, v_key_status;
END;
$$;

-- ---------------------------------------------------------------------------
-- rotate_session (web)
-- Locks: the ACTIVE session-key row FOR SHARE, then the session row.
-- Returns the id of the session row it rotated, so the caller never has to
-- trust an identity it was handed from elsewhere.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.rotate_session(
  p_key_version      smallint,
  p_token_digest     text,
  p_new_key_version  smallint,
  p_new_token_digest text
) RETURNS TABLE (result text, session_id text, absolute_expires_at timestamptz, idle_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  c_idle_timeout constant interval := interval '2 hours';
  v_active_version      smallint;
  v_id                  text;
  v_revoked_at          timestamptz;
  v_absolute_expires_at timestamptz;
  v_last_seen_at        timestamptz;
  v_key_status          text;
  v_t                   timestamptz;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$'
     OR p_new_token_digest IS NULL OR p_new_token_digest !~ '^[0-9a-f]{64}$'
     OR p_key_version IS NULL OR p_key_version <= 0
     OR p_new_key_version IS NULL OR p_new_key_version <= 0
     OR p_new_token_digest = p_token_digest THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT k.key_version INTO v_active_version
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.status = 'ACTIVE'
     FOR SHARE;

  SELECT s.id, s.revoked_at, s.absolute_expires_at, s.last_seen_at
    INTO v_id, v_revoked_at, v_absolute_expires_at, v_last_seen_at
    FROM shopaccess.shopper_sessions s
   WHERE s.key_purpose = 'session' AND s.key_version = p_key_version AND s.token_digest = p_token_digest
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  v_t := clock_timestamp();

  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;

  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, v_t) THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_active_version IS NULL OR p_new_key_version <> v_active_version THEN
    RETURN QUERY SELECT 'KEY_NOT_ACTIVE'::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  BEGIN
    UPDATE shopaccess.shopper_sessions s
       SET token_digest = p_new_token_digest,
           key_version = p_new_key_version,
           last_seen_at = v_t,
           row_version = s.row_version + 1
     WHERE s.id = v_id;
  EXCEPTION WHEN unique_violation THEN
    -- The new digest already belongs to another session. Nothing changed.
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END;

  RETURN QUERY SELECT 'ROTATED'::text, v_id, v_absolute_expires_at, v_t + c_idle_timeout;
END;
$$;

-- ---------------------------------------------------------------------------
-- revoke_session (web)
-- Locks: the session row. Always answers DONE, so it is not an oracle.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.revoke_session(
  p_key_version  smallint,
  p_token_digest text
) RETURNS TABLE (result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_id         text;
  v_revoked_at timestamptz;
  v_t          timestamptz;
BEGIN
  IF p_token_digest IS NOT NULL AND p_token_digest ~ '^[0-9a-f]{64}$'
     AND p_key_version IS NOT NULL AND p_key_version > 0 THEN
    SELECT s.id, s.revoked_at INTO v_id, v_revoked_at
      FROM shopaccess.shopper_sessions s
     WHERE s.key_purpose = 'session' AND s.key_version = p_key_version AND s.token_digest = p_token_digest
       FOR NO KEY UPDATE;
    IF FOUND AND v_revoked_at IS NULL THEN
      v_t := clock_timestamp();
      UPDATE shopaccess.shopper_sessions s
         SET revoked_at = v_t,
             row_version = s.row_version + 1
       WHERE s.id = v_id;
    END IF;
  END IF;

  RETURN QUERY SELECT 'DONE'::text;
END;
$$;

-- ---------------------------------------------------------------------------
-- activate_key_version (operator)
-- Locks: guard row; every key-version row of the purpose.
-- Writes one KEY_VERSION_ACTIVATED audit row in the same transaction, and only
-- on success. A refusal writes nothing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.activate_key_version(
  p_purpose     text,
  p_key_version smallint,
  p_check_value text
) RETURNS TABLE (result text, previous_active_version smallint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_max_version      smallint;
  v_previous_version smallint;
  v_t                timestamptz;
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('session', 'confirmation_nonce') THEN
    RETURN QUERY SELECT 'BAD_PURPOSE'::text, NULL::smallint;
    RETURN;
  END IF;
  IF p_check_value IS NULL OR p_check_value !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'BAD_CHECK_VALUE'::text, NULL::smallint;
    RETURN;
  END IF;
  IF p_key_version IS NULL OR p_key_version <= 0 THEN
    RETURN QUERY SELECT 'VERSION_NOT_HIGHER'::text, NULL::smallint;
    RETURN;
  END IF;

  PERFORM 1 FROM shopaccess.session_admission_guard g WHERE g.id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session admission guard row is missing' USING ERRCODE = 'restrict_violation';
  END IF;

  PERFORM 1 FROM shopaccess.server_key_versions k
   WHERE k.purpose = p_purpose
   ORDER BY k.key_version
     FOR UPDATE;

  v_t := clock_timestamp();

  SELECT max(k.key_version) INTO v_max_version
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = p_purpose;
  IF v_max_version IS NOT NULL AND p_key_version <= v_max_version THEN
    RETURN QUERY SELECT 'VERSION_NOT_HIGHER'::text, NULL::smallint;
    RETURN;
  END IF;

  SELECT k.key_version INTO v_previous_version
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = p_purpose AND k.status = 'ACTIVE';

  -- Demote first: at most one ACTIVE row may exist per purpose at any moment.
  IF v_previous_version IS NOT NULL THEN
    UPDATE shopaccess.server_key_versions k
       SET status = 'VERIFY_ONLY'
     WHERE k.purpose = p_purpose AND k.key_version = v_previous_version;
  END IF;

  INSERT INTO shopaccess.server_key_versions (purpose, key_version, status, check_value, activated_at, revoked_at)
  VALUES (p_purpose, p_key_version, 'ACTIVE', p_check_value, v_t, NULL);

  -- The audit row holds no key bytes, no check value and no token.
  INSERT INTO shopaccess.audit_events
    (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
  VALUES
    ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'KEY_VERSION_ACTIVATED', v_t, v_t, 'operator',
     NULL, NULL, NULL, NULL,
     jsonb_build_object(
       'purpose', p_purpose,
       'keyVersion', p_key_version,
       'previousActiveVersion', v_previous_version,
       'operatorLogin', session_user::text));

  RETURN QUERY SELECT 'ACTIVATED'::text, v_previous_version;
END;
$$;

-- ---------------------------------------------------------------------------
-- revoke_key_version (operator)
-- Locks: guard row; the key-version row; that version's sessions.
-- May revoke the ACTIVE version (emergency revocation): no admission or
-- rotation then succeeds until a higher version is activated.
-- Writes one KEY_VERSION_REVOKED audit row in the same transaction, and only
-- on success. A refusal or a repeat writes nothing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.revoke_key_version(
  p_purpose     text,
  p_key_version smallint
) RETURNS TABLE (result text, sessions_revoked integer, was_active boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_status   text;
  v_t        timestamptz;
  v_sessions integer;
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('session', 'confirmation_nonce') THEN
    RETURN QUERY SELECT 'BAD_PURPOSE'::text, NULL::integer, NULL::boolean;
    RETURN;
  END IF;
  IF p_key_version IS NULL OR p_key_version <= 0 THEN
    RETURN QUERY SELECT 'UNKNOWN_VERSION'::text, NULL::integer, NULL::boolean;
    RETURN;
  END IF;

  PERFORM 1 FROM shopaccess.session_admission_guard g WHERE g.id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session admission guard row is missing' USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT k.status INTO v_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = p_purpose AND k.key_version = p_key_version
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'UNKNOWN_VERSION'::text, NULL::integer, NULL::boolean;
    RETURN;
  END IF;
  IF v_status = 'REVOKED' THEN
    RETURN QUERY SELECT 'ALREADY_REVOKED'::text, NULL::integer, NULL::boolean;
    RETURN;
  END IF;

  -- Lock that version's sessions before reading the decision time.
  PERFORM 1 FROM shopaccess.shopper_sessions s
   WHERE s.key_purpose = p_purpose AND s.key_version = p_key_version
   ORDER BY s.id
     FOR NO KEY UPDATE;

  v_t := clock_timestamp();

  UPDATE shopaccess.server_key_versions k
     SET status = 'REVOKED',
         revoked_at = v_t
   WHERE k.purpose = p_purpose AND k.key_version = p_key_version;

  UPDATE shopaccess.shopper_sessions s
     SET revoked_at = v_t,
         row_version = s.row_version + 1
   WHERE s.key_purpose = p_purpose AND s.key_version = p_key_version AND s.revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  INSERT INTO shopaccess.audit_events
    (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
  VALUES
    ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'KEY_VERSION_REVOKED', v_t, v_t, 'operator',
     NULL, NULL, NULL, NULL,
     jsonb_build_object(
       'purpose', p_purpose,
       'keyVersion', p_key_version,
       'wasActive', v_status = 'ACTIVE',
       'sessionsRevoked', v_sessions,
       'operatorLogin', session_user::text));

  RETURN QUERY SELECT 'REVOKED'::text, v_sessions, v_status = 'ACTIVE';
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------

-- Nothing is executable by PUBLIC (default privileges already ensure this;
-- stated again so this file is self-evident).
REVOKE ALL ON FUNCTION shopaccess_api.session_is_live(timestamptz, timestamptz, timestamptz, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.admit_session(text, smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.authorize_session(smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.rotate_session(smallint, text, smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.revoke_session(smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.activate_key_version(text, smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.revoke_key_version(text, smallint) FROM PUBLIC;

-- Web: the four session functions. Operator: the two key functions.
-- The worker receives nothing in Increment 1. The helper is granted to nobody.
GRANT EXECUTE ON FUNCTION shopaccess_api.admit_session(text, smallint, text) TO shopaccess_web;
GRANT EXECUTE ON FUNCTION shopaccess_api.authorize_session(smallint, text) TO shopaccess_web;
GRANT EXECUTE ON FUNCTION shopaccess_api.rotate_session(smallint, text, smallint, text) TO shopaccess_web;
GRANT EXECUTE ON FUNCTION shopaccess_api.revoke_session(smallint, text) TO shopaccess_web;
GRANT EXECUTE ON FUNCTION shopaccess_api.activate_key_version(text, smallint, text) TO shopaccess_operator;
GRANT EXECUTE ON FUNCTION shopaccess_api.revoke_key_version(text, smallint) TO shopaccess_operator;

-- The function owner gets exactly the table privileges its functions use.
-- No TRUNCATE, no DDL, no ownership of any table, nothing on the catalog or the
-- migration ledger.
GRANT SELECT, UPDATE ON shopaccess.session_admission_guard TO shopaccess_definer;
GRANT SELECT, INSERT, UPDATE ON shopaccess.server_key_versions TO shopaccess_definer;
GRANT SELECT, INSERT ON shopaccess.checkout_owners TO shopaccess_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON shopaccess.shopper_sessions TO shopaccess_definer;
GRANT INSERT ON shopaccess.audit_events TO shopaccess_definer;

-- Hand the functions to shopaccess_definer. It needs CREATE on the schema only
-- for the moment of the hand-over; the privilege is revoked again immediately,
-- so at runtime the function owner can create nothing.
GRANT CREATE ON SCHEMA shopaccess_api TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.session_is_live(timestamptz, timestamptz, timestamptz, text, timestamptz) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.admit_session(text, smallint, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.authorize_session(smallint, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.rotate_session(smallint, text, smallint, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.revoke_session(smallint, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.activate_key_version(text, smallint, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.revoke_key_version(text, smallint) OWNER TO shopaccess_definer;
REVOKE CREATE ON SCHEMA shopaccess_api FROM shopaccess_definer;
