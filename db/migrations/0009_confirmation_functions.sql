-- ShopAccess AI: Milestone 002, Increment 2.2: durable confirmation, functions.
--
-- Contract: docs/postgresql/postgresql-specification-v2.0-draft.md, sections
-- 19.5 to 19.7, 19.10, 19.11, 19.13 and 19.16.
--
-- This file creates no table and changes no table, constraint or trigger. It
-- adds two entry points, issue_challenge and consume_challenge, and puts a
-- 41-column read_checkout in the place of the 33-column one of migration 0008:
-- the first 33 columns are unchanged in name, type and order, and eight columns
-- for the quote's ACTIVE challenge follow them.
--
-- Run by the migration runner inside its own transaction, as shopaccess_owner.
--
-- Lock order, as 19.4: the nonce key row (rank 2), the session row (3), the
-- owner row (5), the owner's request-window row (5a), the intent (6), the
-- challenge (7). No key row is locked after the session row. No catalog row is
-- locked.
--
-- Errors. consume_challenge and read_checkout have no handler of any kind.
-- issue_challenge has exactly one: around the two statements that end the
-- previous challenge and insert the new one, it catches a unique violation
-- and, only when the violated constraint is one of the three that contain the
-- challenge id, answers REFUSED. Every other error is raised again. Admission
-- is outside that block, so a refused call stays counted and changes no
-- challenge.

-- ---------------------------------------------------------------------------
-- read_checkout: the 33-column function is removed and the 41-column one is
-- created. A function's result type cannot be changed in place. The function
-- belongs to shopaccess_definer, so that role removes it; the migration role
-- is then named again, explicitly, for everything that follows. There is no
-- other statement of either kind in this file. If the function is missing, or
-- if anything depends on it, the statement fails and nothing of this file is
-- applied.
-- ---------------------------------------------------------------------------
SET ROLE shopaccess_definer;
DROP FUNCTION shopaccess_api.read_checkout(smallint, text, text);
SET ROLE shopaccess_owner;

-- ---------------------------------------------------------------------------
-- read_checkout (web)
-- One statement, one snapshot, always exactly one row. Takes no lock and
-- writes nothing. Time is the start time of the calling statement. A failed
-- credential and an intent id that is malformed, missing or another owner's
-- all give the same row: NOT_AUTHORIZED with every other column NULL.
--
-- Columns 34 to 40 are the quote's ACTIVE challenge, and are NULL when it has
-- none; a challenge in any other status is never shown. challenge_usable is
-- true exactly when there is such a challenge, the intent is stored QUOTED,
-- the time is before the quote's expiry and before the challenge's, the
-- challenge is bound to the quote's digest, the quote is not stale, and the
-- challenge's nonce key is ACTIVE or VERIFY_ONLY. It does not compute the
-- quote digest again and does not apply the reuse margin.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.read_checkout(
  p_key_version smallint,
  p_token_digest text,
  p_intent_id text
) RETURNS TABLE (result text, owner_id text, intent_id text, purchase_group_id text, stored_state text, row_version integer, effective_status text, replaces_intent_id text, superseded_by_intent_id text, intent_created_at timestamptz, intent_updated_at timestamptz, quote_id text, merchant_id text, merchant_display_name text, product_id text, product_title text, variant_id text, variant_label text, quantity integer, unit_amount_cents bigint, subtotal_cents bigint, discount_cents bigint, tax_cents bigint, shipping_cents bigint, total_cents bigint, currency text, assumptions_code text, catalog_revision integer, quote_digest text, quote_created_at timestamptz, quote_expires_at timestamptz, quote_stale boolean, database_time timestamptz, challenge_id text, challenge_quote_digest text, challenge_nonce_key_version smallint, challenge_nonce_digest text, challenge_summary jsonb, challenge_issued_at timestamptz, challenge_expires_at timestamptz, challenge_usable boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN v.found_intent_id IS NULL THEN 'NOT_AUTHORIZED' ELSE 'OK' END::text,
         v.found_owner_id,
         v.found_intent_id,
         v.found_purchase_group_id,
         v.found_state,
         v.found_row_version,
         CASE
           WHEN v.found_state IN ('QUOTED', 'USER_CONFIRMED') AND statement_timestamp() >= v.found_quote_expires_at THEN 'QUOTE_EXPIRED'
           ELSE v.found_state
         END,
         v.found_replaces_intent_id,
         v.found_superseded_by_intent_id,
         v.found_intent_created_at,
         v.found_intent_updated_at,
         v.found_quote_id,
         v.found_merchant_id,
         v.found_merchant_display_name,
         v.found_product_id,
         v.found_product_title,
         v.found_variant_id,
         v.found_variant_label,
         v.found_quantity,
         v.found_unit_amount_cents,
         v.found_subtotal_cents,
         v.found_discount_cents,
         v.found_tax_cents,
         v.found_shipping_cents,
         v.found_total_cents,
         v.found_currency,
         v.found_assumptions_code,
         v.found_catalog_revision,
         v.found_quote_digest,
         v.found_quote_created_at,
         v.found_quote_expires_at,
         v.found_quote_stale,
         CASE WHEN v.found_intent_id IS NULL THEN NULL ELSE statement_timestamp() END,
         v.found_challenge_id,
         v.found_challenge_quote_digest,
         v.found_challenge_nonce_key_version,
         v.found_challenge_nonce_digest,
         v.found_challenge_summary,
         v.found_challenge_issued_at,
         v.found_challenge_expires_at,
         CASE
           WHEN v.found_intent_id IS NULL THEN NULL
           ELSE coalesce(
                  v.found_challenge_id IS NOT NULL
                  AND v.found_state = 'QUOTED'
                  AND statement_timestamp() < v.found_quote_expires_at
                  AND statement_timestamp() < v.found_challenge_expires_at
                  AND v.found_challenge_quote_digest = v.found_quote_digest
                  AND NOT v.found_quote_stale
                  AND v.found_nonce_key_status IN ('ACTIVE', 'VERIFY_ONLY'),
                  false)
         END
    FROM (SELECT 1 AS present) one
    LEFT JOIN LATERAL (
      SELECT s.owner_id AS found_owner_id,
             i.id AS found_intent_id,
             i.purchase_group_id AS found_purchase_group_id,
             i.state AS found_state,
             i.row_version AS found_row_version,
             i.replaces_intent_id AS found_replaces_intent_id,
             i.superseded_by_intent_id AS found_superseded_by_intent_id,
             i.created_at AS found_intent_created_at,
             i.updated_at AS found_intent_updated_at,
             q.id AS found_quote_id,
             q.merchant_id AS found_merchant_id,
             qi.merchant_display_name AS found_merchant_display_name,
             qi.product_id AS found_product_id,
             qi.product_title AS found_product_title,
             qi.variant_id AS found_variant_id,
             qi.variant_label AS found_variant_label,
             qi.quantity AS found_quantity,
             qi.unit_amount_cents AS found_unit_amount_cents,
             q.subtotal_cents AS found_subtotal_cents,
             q.discount_cents AS found_discount_cents,
             q.tax_cents AS found_tax_cents,
             q.shipping_cents AS found_shipping_cents,
             q.total_cents AS found_total_cents,
             q.currency AS found_currency,
             q.assumptions_code AS found_assumptions_code,
             q.catalog_revision AS found_catalog_revision,
             q.digest AS found_quote_digest,
             q.created_at AS found_quote_created_at,
             q.expires_at AS found_quote_expires_at,
             shopaccess_api.quote_material_change(
               qi.unit_amount_cents, q.currency, qi.quantity, q.merchant_id, qi.product_id,
               qi.merchant_display_name, qi.product_title, qi.variant_label, qi.descriptive_terms_digest,
               mv.unit_amount_cents::bigint, mv.currency, mv.availability, mv.max_quantity_per_order,
               mp.merchant_id, mv.product_id, mm.display_name, mp.title, mv.label, mp.description, mv.specs
             ) AS found_quote_stale,
             c.id AS found_challenge_id,
             c.quote_digest AS found_challenge_quote_digest,
             c.nonce_key_version AS found_challenge_nonce_key_version,
             c.nonce_digest AS found_challenge_nonce_digest,
             c.summary AS found_challenge_summary,
             c.issued_at AS found_challenge_issued_at,
             c.expires_at AS found_challenge_expires_at,
             nk.status AS found_nonce_key_status
        FROM shopaccess.shopper_sessions s
        LEFT JOIN shopaccess.server_key_versions k
          ON k.purpose = s.key_purpose AND k.key_version = s.key_version
        JOIN shopaccess.checkout_intents i
          ON i.owner_id = s.owner_id AND i.id = p_intent_id
        JOIN shopaccess.quotes q
          ON q.id = i.current_quote_id AND q.checkout_intent_id = i.id
        JOIN shopaccess.quote_items qi
          ON qi.quote_id = q.id AND qi.line_number = 1
        LEFT JOIN shopaccess.merchant_variants mv
          ON mv.id = qi.variant_id
        LEFT JOIN shopaccess.merchant_products mp
          ON mp.id = mv.product_id
        LEFT JOIN shopaccess.merchants mm
          ON mm.id = mp.merchant_id
        LEFT JOIN shopaccess.confirmation_challenges c
          ON c.quote_id = q.id AND c.checkout_intent_id = i.id AND c.owner_id = s.owner_id AND c.status = 'ACTIVE'
        LEFT JOIN shopaccess.server_key_versions nk
          ON nk.purpose = c.nonce_key_purpose AND nk.key_version = c.nonce_key_version
       WHERE p_key_version IS NOT NULL AND p_key_version > 0
         AND p_token_digest IS NOT NULL AND p_token_digest ~ '^[0-9a-f]{64}$'
         AND p_intent_id IS NOT NULL AND p_intent_id ~ '^ci_[0-9a-f]{32}$'
         AND s.key_purpose = 'session'
         AND s.key_version = p_key_version
         AND s.token_digest = p_token_digest
         AND shopaccess_api.session_is_live(s.revoked_at, s.absolute_expires_at, s.last_seen_at, k.status, statement_timestamp())
    ) v ON true
   LIMIT shopaccess_api.require_read_committed(1);
$$;

-- ---------------------------------------------------------------------------
-- issue_challenge (web)
-- Gives the caller a confirmation challenge for the current quote of one of its
-- QUOTED intents: the existing ACTIVE one when it can still be used, a new one
-- otherwise. The caller supplies the challenge id, the version of the nonce key
-- and the digest of the nonce; the nonce itself never reaches this function.
-- The summary is built here from the stored quote and is never supplied.
--
-- Results: ISSUED, REUSED, NOT_AUTHORIZED, REQUEST_INVALID, RATE_LIMITED,
-- INTENT_NOT_AWAITING_CONFIRMATION, QUOTE_EXPIRED, QUOTE_STALE_CATALOG,
-- QUOTE_DIGEST_MISMATCH, NONCE_KEY_NOT_ACTIVE, CONFIRMATION_ALREADY_USED,
-- CHALLENGE_LIMIT_REACHED, REFUSED. The six columns after the result are
-- non-NULL for ISSUED and REUSED only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.issue_challenge(
  p_key_version smallint,
  p_token_digest text,
  p_intent_id text,
  p_challenge_id text,
  p_nonce_key_version smallint,
  p_nonce_digest text
) RETURNS TABLE (result text, challenge_id text, quote_digest text, nonce_key_version smallint, nonce_digest text, summary jsonb, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  c_window_limit      constant integer := 30;
  c_window_seconds    constant integer := 60;
  c_challenge_ceiling constant integer := 8;
  v_session_id          text;
  v_owner_id            text;
  v_locked_session_id   text;
  v_locked_owner_id     text;
  v_revoked_at          timestamptz;
  v_absolute_expires_at timestamptz;
  v_last_seen_at        timestamptz;
  v_key_status          text;
  v_nonce_key_found     boolean;
  v_nonce_key_status    text;
  v_window_exists       boolean;
  v_window_started_at   timestamptz;
  v_window_calls        integer;
  v_window_throttled    bigint;
  v_new_window          boolean;
  v_over_limit          boolean;
  v_t4                  timestamptz;
  v_t6                  timestamptz;
  v_found               boolean;
  v_state               text;
  v_group_id            text;
  v_quote_id            text;
  v_merchant_id         text;
  v_catalog_revision    integer;
  v_subtotal_cents      bigint;
  v_discount_cents      bigint;
  v_tax_cents           bigint;
  v_shipping_cents      bigint;
  v_total_cents         bigint;
  v_currency            text;
  v_assumptions_code    text;
  v_quote_created_at    timestamptz;
  v_quote_expires_at    timestamptz;
  v_quote_digest        text;
  v_product_id          text;
  v_variant_id          text;
  v_quantity            integer;
  v_unit_amount_cents   bigint;
  v_merchant_name       text;
  v_product_title       text;
  v_variant_label       text;
  v_descriptive_digest  text;
  v_stale               boolean;
  v_active_id           text;
  v_active_quote_digest text;
  v_active_key_version  smallint;
  v_active_nonce_digest text;
  v_active_summary      jsonb;
  v_active_expires_at   timestamptz;
  v_challenge_count     integer;
  v_new_expires_at      timestamptz;
  v_new_summary         jsonb;
  v_refused             boolean := false;
  v_violation_schema    text;
  v_violation_table     text;
  v_violation_constraint text;
BEGIN
  -- Before anything else: the isolation level (19.5).
  PERFORM shopaccess_api.require_read_committed(1);

  -- Step 0a: credential format.
  IF p_key_version IS NULL OR p_key_version <= 0
     OR p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 0b: unlocked lookup; the session must exist and appear live.
  SELECT s.id, s.owner_id, s.revoked_at, s.absolute_expires_at, s.last_seen_at
    INTO v_session_id, v_owner_id, v_revoked_at, v_absolute_expires_at, v_last_seen_at
    FROM shopaccess.shopper_sessions s
   WHERE s.key_purpose = 'session' AND s.key_version = p_key_version AND s.token_digest = p_token_digest;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, clock_timestamp()) THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 0c: argument format. Before any lock and before admission.
  IF p_intent_id IS NULL OR p_intent_id !~ '^ci_[0-9a-f]{32}$'
     OR p_challenge_id IS NULL OR p_challenge_id !~ '^cf_[0-9a-f]{32}$'
     OR p_nonce_key_version IS NULL OR p_nonce_key_version <= 0
     OR p_nonce_digest IS NULL OR p_nonce_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'REQUEST_INVALID'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 1: the nonce key row the caller named, FOR SHARE, if there is one.
  -- This is the only key row this call locks, and it is locked before the
  -- session row.
  SELECT k.status INTO v_nonce_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'confirmation_nonce' AND k.key_version = p_nonce_key_version
     FOR SHARE;
  v_nonce_key_found := FOUND;

  -- Step 2: the session row, found again by the exact credential, FOR SHARE.
  SELECT s.id, s.owner_id, s.revoked_at, s.absolute_expires_at, s.last_seen_at
    INTO v_locked_session_id, v_locked_owner_id, v_revoked_at, v_absolute_expires_at, v_last_seen_at
    FROM shopaccess.shopper_sessions s
   WHERE s.key_purpose = 'session' AND s.key_version = p_key_version AND s.token_digest = p_token_digest
     FOR SHARE;
  IF NOT FOUND
     OR v_locked_session_id IS DISTINCT FROM v_session_id
     OR v_locked_owner_id IS DISTINCT FROM v_owner_id THEN
    -- No further lock is taken and nothing is written.
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 3: the owner row, FOR UPDATE. Held until the call ends.
  PERFORM 1
     FROM shopaccess.checkout_owners o
    WHERE o.id = v_owner_id
      FOR UPDATE;

  -- Step 4: the request-window row, if there is one, by a locking read. Then
  -- the first clock reading and the credential again.
  SELECT w.window_started_at, w.window_calls
    INTO v_window_started_at, v_window_calls
    FROM shopaccess.owner_request_windows w
   WHERE w.owner_id = v_owner_id
     FOR UPDATE;
  v_window_exists := FOUND;

  v_t4 := clock_timestamp();

  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, v_t4) THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 4a: which window, and whether it is full. Nothing is written.
  SELECT d.starts_new_window, d.over_limit
    INTO v_new_window, v_over_limit
    FROM shopaccess_api.owner_window_decision(v_window_started_at, v_window_calls, v_t4) d;

  -- Step 4b: over the limit. The counters first, then the audit row.
  IF v_over_limit THEN
    UPDATE shopaccess.owner_request_windows w
       SET window_throttled = w.window_throttled + 1,
           total_throttled = w.total_throttled + 1,
           updated_at = GREATEST(w.updated_at, v_t4)
     WHERE w.owner_id = v_owner_id
    RETURNING w.window_throttled INTO v_window_throttled;
    IF v_window_throttled = 1 THEN
      INSERT INTO shopaccess.audit_events
        (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
      VALUES
        ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'OWNER_RATE_LIMITED', v_t4, v_t4, 'server',
         v_session_id, v_owner_id, NULL, NULL,
         jsonb_build_object(
           'limit', c_window_limit,
           'windowSeconds', c_window_seconds,
           'windowStartedAt', to_char(v_window_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
    END IF;
    RETURN QUERY SELECT 'RATE_LIMITED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 5: the intent, by its id and the caller's owner together, and then
  -- the challenge rows of its current quote, in id order. A missing id and
  -- another owner's id both select nothing and lock nothing.
  SELECT i.state, i.purchase_group_id, i.current_quote_id
    INTO v_state, v_group_id, v_quote_id
    FROM shopaccess.checkout_intents i
   WHERE i.id = p_intent_id AND i.owner_id = v_owner_id
     FOR UPDATE;
  v_found := FOUND;

  PERFORM 1
     FROM shopaccess.confirmation_challenges c
    WHERE c.quote_id = v_quote_id AND c.checkout_intent_id = p_intent_id AND c.owner_id = v_owner_id
    ORDER BY c.id
      FOR UPDATE;

  -- Step 6: the second clock reading, the credential a last time, and the
  -- resource of step 5. This reading decides every expiry below, as it is.
  v_t6 := clock_timestamp();

  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, v_t6)
     OR NOT v_found THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 7: admission, in the window assigned at step 4. Everything below is
  -- counted, the refusals included.
  IF NOT v_window_exists THEN
    INSERT INTO shopaccess.owner_request_windows
      (owner_id, window_started_at, window_calls, window_throttled, total_throttled, updated_at)
    VALUES
      (v_owner_id, v_t4, 1, 0, 0, v_t4);
  ELSIF v_new_window THEN
    UPDATE shopaccess.owner_request_windows w
       SET window_started_at = v_t4,
           window_calls = 1,
           window_throttled = 0,
           updated_at = GREATEST(w.updated_at, v_t4)
     WHERE w.owner_id = v_owner_id;
  ELSE
    UPDATE shopaccess.owner_request_windows w
       SET window_calls = w.window_calls + 1,
           updated_at = GREATEST(w.updated_at, v_t4)
     WHERE w.owner_id = v_owner_id;
  END IF;

  -- Step 8, rule 1: the intent must be stored QUOTED.
  IF v_state IS DISTINCT FROM 'QUOTED' THEN
    RETURN QUERY SELECT 'INTENT_NOT_AWAITING_CONFIRMATION'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- The stored quote and its one item.
  SELECT q.merchant_id, q.catalog_revision, q.subtotal_cents, q.discount_cents, q.tax_cents, q.shipping_cents,
         q.total_cents, q.currency, q.assumptions_code, q.created_at, q.expires_at, q.digest,
         qi.product_id, qi.variant_id, qi.quantity, qi.unit_amount_cents,
         qi.merchant_display_name, qi.product_title, qi.variant_label, qi.descriptive_terms_digest
    INTO v_merchant_id, v_catalog_revision, v_subtotal_cents, v_discount_cents, v_tax_cents, v_shipping_cents,
         v_total_cents, v_currency, v_assumptions_code, v_quote_created_at, v_quote_expires_at, v_quote_digest,
         v_product_id, v_variant_id, v_quantity, v_unit_amount_cents,
         v_merchant_name, v_product_title, v_variant_label, v_descriptive_digest
    FROM shopaccess.quotes q
    JOIN shopaccess.quote_items qi
      ON qi.quote_id = q.id AND qi.line_number = 1
   WHERE q.id = v_quote_id AND q.checkout_intent_id = p_intent_id AND q.owner_id = v_owner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shopaccess: the quote of a checkout intent was not found' USING ERRCODE = 'data_exception';
  END IF;

  -- Rule 2: the quote's expiry, against the reading of step 6 as it is.
  IF v_t6 >= v_quote_expires_at THEN
    RETURN QUERY SELECT 'QUOTE_EXPIRED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Rule 3: a material change of the catalog. One statement, after the last
  -- lock; no catalog row is locked. Anything but a clear "unchanged" is stale.
  SELECT shopaccess_api.quote_material_change(
           v_unit_amount_cents, v_currency, v_quantity, v_merchant_id, v_product_id,
           v_merchant_name, v_product_title, v_variant_label, v_descriptive_digest,
           mv.unit_amount_cents::bigint, mv.currency, mv.availability, mv.max_quantity_per_order,
           mp.merchant_id, mv.product_id, mm.display_name, mp.title, mv.label, mp.description, mv.specs)
    INTO v_stale
    FROM (SELECT 1 AS present) one
    LEFT JOIN shopaccess.merchant_variants mv
      ON mv.id = v_variant_id
    LEFT JOIN shopaccess.merchant_products mp
      ON mp.id = mv.product_id
    LEFT JOIN shopaccess.merchants mm
      ON mm.id = mp.merchant_id;
  IF v_stale IS DISTINCT FROM false THEN
    RETURN QUERY SELECT 'QUOTE_STALE_CATALOG'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Rule 4: the stored digest must be the digest of the stored quote. This
  -- refusal is audited (19.10). No challenge exists for it, so the audit row
  -- names none; the id the caller sent is not written anywhere.
  IF shopaccess_api.quote_digest_saqd1(
       v_quote_id, v_owner_id, p_intent_id, v_group_id, v_merchant_id, v_product_id, v_variant_id,
       v_catalog_revision::bigint, v_quantity::bigint, v_unit_amount_cents, v_subtotal_cents, v_discount_cents,
       v_tax_cents, v_shipping_cents, v_total_cents, v_currency, v_assumptions_code,
       v_quote_created_at, v_quote_expires_at) IS DISTINCT FROM v_quote_digest THEN
    INSERT INTO shopaccess.audit_events
      (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
    VALUES
      ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CONFIRMATION_REJECTED', v_t6, v_t6, 'shopper',
       v_session_id, v_owner_id, p_intent_id, NULL,
       jsonb_build_object(
         'result', 'QUOTE_DIGEST_MISMATCH',
         'challengeId', NULL::text));
    RETURN QUERY SELECT 'QUOTE_DIGEST_MISMATCH'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Rule 5: the nonce key the caller named must be ACTIVE. Read from the row
  -- locked at step 1.
  IF NOT v_nonce_key_found OR v_nonce_key_status IS DISTINCT FROM 'ACTIVE' THEN
    RETURN QUERY SELECT 'NONCE_KEY_NOT_ACTIVE'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Rule 6: a quote that already has a consumed challenge gets no other.
  PERFORM 1
     FROM shopaccess.confirmation_challenges c
    WHERE c.quote_id = v_quote_id AND c.status = 'CONSUMED';
  IF FOUND THEN
    RETURN QUERY SELECT 'CONFIRMATION_ALREADY_USED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Rule 7: the ACTIVE challenge of the quote is given again when it is bound
  -- to the stored digest, is under the key version the caller named, and has
  -- more than 60 seconds left. Nothing is written.
  SELECT c.id, c.quote_digest, c.nonce_key_version, c.nonce_digest, c.summary, c.expires_at
    INTO v_active_id, v_active_quote_digest, v_active_key_version, v_active_nonce_digest, v_active_summary, v_active_expires_at
    FROM shopaccess.confirmation_challenges c
   WHERE c.quote_id = v_quote_id AND c.status = 'ACTIVE';
  IF FOUND
     AND v_active_quote_digest = v_quote_digest
     AND v_active_key_version = p_nonce_key_version
     AND v_active_expires_at - v_t6 > interval '60 seconds' THEN
    RETURN QUERY SELECT 'REUSED'::text, v_active_id, v_active_quote_digest, v_active_key_version, v_active_nonce_digest, v_active_summary, v_active_expires_at;
    RETURN;
  END IF;

  -- Rule 8: at most eight challenge rows for one quote, whatever their status.
  -- Decided before any write: the ACTIVE row, if there is one, is left as it is.
  SELECT count(*)::integer INTO v_challenge_count
    FROM shopaccess.confirmation_challenges c
   WHERE c.quote_id = v_quote_id;
  IF v_challenge_count >= c_challenge_ceiling THEN
    RETURN QUERY SELECT 'CHALLENGE_LIMIT_REACHED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Rule 9: a challenge with the id the caller sent already exists, whoever it
  -- belongs to. Nothing but the admission has been written.
  PERFORM 1
     FROM shopaccess.confirmation_challenges c
    WHERE c.id = p_challenge_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'REFUSED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  -- Rule 10: the previous ACTIVE challenge ends and the new one is inserted.
  v_new_expires_at := LEAST(v_t6 + interval '5 minutes', v_quote_expires_at);
  v_new_summary := jsonb_build_object(
    'merchantName', v_merchant_name,
    'productTitle', v_product_title,
    'variantLabel', v_variant_label,
    'quantity', v_quantity,
    'currency', v_currency,
    'totalCents', v_total_cents);

  -- The one protected block of this file. It holds these two statements and
  -- nothing else. A challenge id that turns out to exist only now, because
  -- another transaction inserted it meanwhile, undoes both statements and is
  -- answered REFUSED; any other error is raised again and undoes the call.
  BEGIN
    UPDATE shopaccess.confirmation_challenges c
       SET status = CASE WHEN v_t6 >= c.expires_at THEN 'EXPIRED' ELSE 'SUPERSEDED' END,
           expired_marked_at = CASE WHEN v_t6 >= c.expires_at THEN v_t6 END,
           superseded_at = CASE WHEN v_t6 >= c.expires_at THEN NULL ELSE v_t6 END
     WHERE c.id = v_active_id;
    INSERT INTO shopaccess.confirmation_challenges
      (id, owner_id, checkout_intent_id, quote_id, quote_digest, nonce_digest, nonce_key_purpose, nonce_key_version,
       summary, status, issued_at, expires_at)
    VALUES
      (p_challenge_id, v_owner_id, p_intent_id, v_quote_id, v_quote_digest, p_nonce_digest, 'confirmation_nonce', p_nonce_key_version,
       v_new_summary, 'ACTIVE', v_t6, v_new_expires_at);
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS
        v_violation_schema = SCHEMA_NAME,
        v_violation_table = TABLE_NAME,
        v_violation_constraint = CONSTRAINT_NAME;
      IF v_violation_schema = 'shopaccess'
         AND v_violation_table = 'confirmation_challenges'
         AND v_violation_constraint IN (
               'confirmation_challenges_pkey',
               'confirmation_challenges_id_intent_key',
               'confirmation_challenges_id_intent_status_key') THEN
        v_refused := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF v_refused THEN
    RETURN QUERY SELECT 'REFUSED'::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::jsonb, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ISSUED'::text, p_challenge_id, v_quote_digest, p_nonce_key_version, p_nonce_digest, v_new_summary, v_new_expires_at;
END;
$$;

-- ---------------------------------------------------------------------------
-- consume_challenge (web)
-- Records the shopper's confirmation of one quote: the challenge becomes
-- CONSUMED, the intent USER_CONFIRMED with its confirmation pointer, one
-- transition and one audit row are written, all in this one call. The nonce is
-- hashed here and compared with the stored digest; it is stored nowhere.
--
-- Results, first match: CONFIRMATION_NOT_FOUND, CONFIRMATION_SUPERSEDED,
-- CONFIRMATION_ALREADY_USED, CONFIRMATION_KEY_REVOKED, CONFIRMATION_ALREADY_USED
-- (another challenge of the quote is consumed), CONFIRMATION_MISMATCH,
-- CONFIRMATION_EXPIRED, QUOTE_DIGEST_MISMATCH, QUOTE_EXPIRED,
-- QUOTE_STALE_CATALOG, INTENT_NOT_AWAITING_CONFIRMATION, CONFIRMED; and
-- NOT_AUTHORIZED, REQUEST_INVALID, RATE_LIMITED as for every mutating call.
-- intent_id is non-NULL for CONFIRMED only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.consume_challenge(
  p_key_version smallint,
  p_token_digest text,
  p_challenge_id text,
  p_nonce text,
  p_quote_id text,
  p_quote_digest text
) RETURNS TABLE (result text, intent_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  c_window_limit     constant integer := 30;
  c_window_seconds   constant integer := 60;
  v_session_id          text;
  v_owner_id            text;
  v_locked_session_id   text;
  v_locked_owner_id     text;
  v_revoked_at          timestamptz;
  v_absolute_expires_at timestamptz;
  v_last_seen_at        timestamptz;
  v_key_status          text;
  v_known               boolean;
  v_known_key_version   smallint;
  v_known_intent_id     text;
  v_nonce_key_status    text;
  v_window_exists       boolean;
  v_window_started_at   timestamptz;
  v_window_calls        integer;
  v_window_throttled    bigint;
  v_new_window          boolean;
  v_over_limit          boolean;
  v_t4                  timestamptz;
  v_t6                  timestamptz;
  v_intent_found        boolean;
  v_challenge_found     boolean;
  v_state               text;
  v_version             integer;
  v_group_id            text;
  v_quote_pointer       text;
  v_confirmation_id     text;
  v_superseded_by       text;
  v_ch_status           text;
  v_ch_quote_id         text;
  v_ch_quote_digest     text;
  v_ch_nonce_digest     text;
  v_ch_issued_at        timestamptz;
  v_ch_expires_at       timestamptz;
  v_merchant_id         text;
  v_catalog_revision    integer;
  v_subtotal_cents      bigint;
  v_discount_cents      bigint;
  v_tax_cents           bigint;
  v_shipping_cents      bigint;
  v_total_cents         bigint;
  v_currency            text;
  v_assumptions_code    text;
  v_quote_created_at    timestamptz;
  v_quote_expires_at    timestamptz;
  v_quote_digest        text;
  v_product_id          text;
  v_variant_id          text;
  v_quantity            integer;
  v_unit_amount_cents   bigint;
  v_merchant_name       text;
  v_product_title       text;
  v_variant_label       text;
  v_descriptive_digest  text;
  v_stale               boolean;
  v_accepted            boolean;
  v_to_state            text;
  v_to_version          integer;
  v_next_confirmation_id text;
  v_event_id            text;
BEGIN
  -- Before anything else: the isolation level (19.5).
  PERFORM shopaccess_api.require_read_committed(1);

  -- Step 0a: credential format.
  IF p_key_version IS NULL OR p_key_version <= 0
     OR p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text;
    RETURN;
  END IF;

  -- Step 0b: unlocked lookup; the session must exist and appear live.
  SELECT s.id, s.owner_id, s.revoked_at, s.absolute_expires_at, s.last_seen_at
    INTO v_session_id, v_owner_id, v_revoked_at, v_absolute_expires_at, v_last_seen_at
    FROM shopaccess.shopper_sessions s
   WHERE s.key_purpose = 'session' AND s.key_version = p_key_version AND s.token_digest = p_token_digest;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text;
    RETURN;
  END IF;
  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, clock_timestamp()) THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text;
    RETURN;
  END IF;

  -- Step 0c: argument format. Before any lock and before admission. A nonce is
  -- 43 base64url characters for 32 bytes; only sixteen characters can stand
  -- last in a canonical encoding.
  IF p_challenge_id IS NULL OR p_challenge_id !~ '^cf_[0-9a-f]{32}$'
     OR p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
     OR p_quote_id IS NULL OR p_quote_id !~ '^qt_[0-9a-f]{32}$'
     OR p_quote_digest IS NULL OR p_quote_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'REQUEST_INVALID'::text, NULL::text;
    RETURN;
  END IF;

  -- Step 0d: unlocked lookup of the challenge, by its id and the caller's
  -- owner together. What it finds, or does not find, governs the rest of the
  -- call: a challenge that becomes visible only later is still not found.
  SELECT c.nonce_key_version, c.checkout_intent_id
    INTO v_known_key_version, v_known_intent_id
    FROM shopaccess.confirmation_challenges c
   WHERE c.id = p_challenge_id AND c.owner_id = v_owner_id;
  v_known := FOUND;

  -- Step 1: the nonce key row of that challenge, FOR SHARE. Only when step 0d
  -- found the challenge; no key row is locked at any later point.
  IF v_known THEN
    SELECT k.status INTO v_nonce_key_status
      FROM shopaccess.server_key_versions k
     WHERE k.purpose = 'confirmation_nonce' AND k.key_version = v_known_key_version
       FOR SHARE;
  END IF;

  -- Step 2: the session row, found again by the exact credential, FOR SHARE.
  SELECT s.id, s.owner_id, s.revoked_at, s.absolute_expires_at, s.last_seen_at
    INTO v_locked_session_id, v_locked_owner_id, v_revoked_at, v_absolute_expires_at, v_last_seen_at
    FROM shopaccess.shopper_sessions s
   WHERE s.key_purpose = 'session' AND s.key_version = p_key_version AND s.token_digest = p_token_digest
     FOR SHARE;
  IF NOT FOUND
     OR v_locked_session_id IS DISTINCT FROM v_session_id
     OR v_locked_owner_id IS DISTINCT FROM v_owner_id THEN
    -- No further lock is taken and nothing is written.
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text;
    RETURN;
  END IF;

  -- Step 3: the owner row, FOR UPDATE. Held until the call ends.
  PERFORM 1
     FROM shopaccess.checkout_owners o
    WHERE o.id = v_owner_id
      FOR UPDATE;

  -- Step 4: the request-window row, if there is one, by a locking read. Then
  -- the first clock reading and the credential again.
  SELECT w.window_started_at, w.window_calls
    INTO v_window_started_at, v_window_calls
    FROM shopaccess.owner_request_windows w
   WHERE w.owner_id = v_owner_id
     FOR UPDATE;
  v_window_exists := FOUND;

  v_t4 := clock_timestamp();

  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, v_t4) THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text;
    RETURN;
  END IF;

  -- Row 1 (step 4-own): no such challenge for this owner. Decided before the
  -- request window is looked at; not counted; nothing is written.
  IF NOT v_known THEN
    RETURN QUERY SELECT 'CONFIRMATION_NOT_FOUND'::text, NULL::text;
    RETURN;
  END IF;

  -- Step 4a: which window, and whether it is full. Nothing is written.
  SELECT d.starts_new_window, d.over_limit
    INTO v_new_window, v_over_limit
    FROM shopaccess_api.owner_window_decision(v_window_started_at, v_window_calls, v_t4) d;

  -- Step 4b: over the limit. The counters first, then the audit row.
  IF v_over_limit THEN
    UPDATE shopaccess.owner_request_windows w
       SET window_throttled = w.window_throttled + 1,
           total_throttled = w.total_throttled + 1,
           updated_at = GREATEST(w.updated_at, v_t4)
     WHERE w.owner_id = v_owner_id
    RETURNING w.window_throttled INTO v_window_throttled;
    IF v_window_throttled = 1 THEN
      INSERT INTO shopaccess.audit_events
        (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
      VALUES
        ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'OWNER_RATE_LIMITED', v_t4, v_t4, 'server',
         v_session_id, v_owner_id, NULL, NULL,
         jsonb_build_object(
           'limit', c_window_limit,
           'windowSeconds', c_window_seconds,
           'windowStartedAt', to_char(v_window_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
    END IF;
    RETURN QUERY SELECT 'RATE_LIMITED'::text, NULL::text;
    RETURN;
  END IF;

  -- Step 5: the challenge's intent, by its id and the caller's owner together,
  -- and then the challenge itself.
  SELECT i.state, i.row_version, i.purchase_group_id, i.current_quote_id, i.confirmation_id, i.superseded_by_intent_id
    INTO v_state, v_version, v_group_id, v_quote_pointer, v_confirmation_id, v_superseded_by
    FROM shopaccess.checkout_intents i
   WHERE i.id = v_known_intent_id AND i.owner_id = v_owner_id
     FOR UPDATE;
  v_intent_found := FOUND;

  SELECT c.status, c.quote_id, c.quote_digest, c.nonce_digest, c.issued_at, c.expires_at
    INTO v_ch_status, v_ch_quote_id, v_ch_quote_digest, v_ch_nonce_digest, v_ch_issued_at, v_ch_expires_at
    FROM shopaccess.confirmation_challenges c
   WHERE c.id = p_challenge_id AND c.owner_id = v_owner_id
     FOR UPDATE;
  v_challenge_found := FOUND;

  -- Step 6: the second clock reading, the credential a last time, and the
  -- resources of step 5. This reading decides every expiry below, as it is.
  v_t6 := clock_timestamp();

  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, v_t6)
     OR NOT v_intent_found
     OR NOT v_challenge_found THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text;
    RETURN;
  END IF;

  -- Step 7: admission, in the window assigned at step 4. Everything below is
  -- counted, the refusals included.
  IF NOT v_window_exists THEN
    INSERT INTO shopaccess.owner_request_windows
      (owner_id, window_started_at, window_calls, window_throttled, total_throttled, updated_at)
    VALUES
      (v_owner_id, v_t4, 1, 0, 0, v_t4);
  ELSIF v_new_window THEN
    UPDATE shopaccess.owner_request_windows w
       SET window_started_at = v_t4,
           window_calls = 1,
           window_throttled = 0,
           updated_at = GREATEST(w.updated_at, v_t4)
     WHERE w.owner_id = v_owner_id;
  ELSE
    UPDATE shopaccess.owner_request_windows w
       SET window_calls = w.window_calls + 1,
           updated_at = GREATEST(w.updated_at, v_t4)
     WHERE w.owner_id = v_owner_id;
  END IF;

  -- Rows 2 and 3: the submitted challenge has already ended. Decided before
  -- the key is looked at, and not audited.
  IF v_ch_status = 'SUPERSEDED' THEN
    RETURN QUERY SELECT 'CONFIRMATION_SUPERSEDED'::text, NULL::text;
    RETURN;
  END IF;
  IF v_ch_status = 'CONSUMED' THEN
    RETURN QUERY SELECT 'CONFIRMATION_ALREADY_USED'::text, NULL::text;
    RETURN;
  END IF;

  -- Row 4: the challenge's nonce key, read from the row locked at step 1. Only
  -- ACTIVE and VERIFY_ONLY are accepted. Audited.
  IF v_nonce_key_status IS NULL OR v_nonce_key_status NOT IN ('ACTIVE', 'VERIFY_ONLY') THEN
    INSERT INTO shopaccess.audit_events
      (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
    VALUES
      ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CONFIRMATION_REJECTED', v_t6, v_t6, 'shopper',
       v_session_id, v_owner_id, v_known_intent_id, NULL,
       jsonb_build_object(
         'result', 'CONFIRMATION_KEY_REVOKED',
         'challengeId', p_challenge_id));
    RETURN QUERY SELECT 'CONFIRMATION_KEY_REVOKED'::text, NULL::text;
    RETURN;
  END IF;

  -- Row 5: another challenge of the same quote is the consumed one.
  PERFORM 1
     FROM shopaccess.confirmation_challenges c
    WHERE c.quote_id = v_ch_quote_id AND c.status = 'CONSUMED' AND c.id <> p_challenge_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'CONFIRMATION_ALREADY_USED'::text, NULL::text;
    RETURN;
  END IF;

  -- Row 6: the nonce, the quote id or the quote digest is not the challenge's.
  -- The stored digest is the lowercase hex SHA-256 of the 43 characters.
  -- Audited.
  IF encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex') IS DISTINCT FROM v_ch_nonce_digest
     OR p_quote_id IS DISTINCT FROM v_ch_quote_id
     OR p_quote_digest IS DISTINCT FROM v_ch_quote_digest THEN
    INSERT INTO shopaccess.audit_events
      (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
    VALUES
      ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CONFIRMATION_REJECTED', v_t6, v_t6, 'shopper',
       v_session_id, v_owner_id, v_known_intent_id, NULL,
       jsonb_build_object(
         'result', 'CONFIRMATION_MISMATCH',
         'challengeId', p_challenge_id));
    RETURN QUERY SELECT 'CONFIRMATION_MISMATCH'::text, NULL::text;
    RETURN;
  END IF;

  -- Row 7: the challenge has expired. An ACTIVE row is marked. The reading of
  -- step 6 is used as it is.
  IF v_ch_status = 'EXPIRED' OR v_t6 >= v_ch_expires_at THEN
    UPDATE shopaccess.confirmation_challenges c
       SET status = 'EXPIRED',
           expired_marked_at = v_t6
     WHERE c.id = p_challenge_id AND c.owner_id = v_owner_id AND c.status = 'ACTIVE';
    RETURN QUERY SELECT 'CONFIRMATION_EXPIRED'::text, NULL::text;
    RETURN;
  END IF;

  -- The stored quote and its one item.
  SELECT q.merchant_id, q.catalog_revision, q.subtotal_cents, q.discount_cents, q.tax_cents, q.shipping_cents,
         q.total_cents, q.currency, q.assumptions_code, q.created_at, q.expires_at, q.digest,
         qi.product_id, qi.variant_id, qi.quantity, qi.unit_amount_cents,
         qi.merchant_display_name, qi.product_title, qi.variant_label, qi.descriptive_terms_digest
    INTO v_merchant_id, v_catalog_revision, v_subtotal_cents, v_discount_cents, v_tax_cents, v_shipping_cents,
         v_total_cents, v_currency, v_assumptions_code, v_quote_created_at, v_quote_expires_at, v_quote_digest,
         v_product_id, v_variant_id, v_quantity, v_unit_amount_cents,
         v_merchant_name, v_product_title, v_variant_label, v_descriptive_digest
    FROM shopaccess.quotes q
    JOIN shopaccess.quote_items qi
      ON qi.quote_id = q.id AND qi.line_number = 1
   WHERE q.id = v_ch_quote_id AND q.checkout_intent_id = v_known_intent_id AND q.owner_id = v_owner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shopaccess: the quote of a confirmation challenge was not found' USING ERRCODE = 'data_exception';
  END IF;

  -- Row 8: the digest of the stored quote, computed again, must be the stored
  -- digest, and the stored digest must be the one the challenge is bound to.
  -- Audited.
  IF shopaccess_api.quote_digest_saqd1(
       v_ch_quote_id, v_owner_id, v_known_intent_id, v_group_id, v_merchant_id, v_product_id, v_variant_id,
       v_catalog_revision::bigint, v_quantity::bigint, v_unit_amount_cents, v_subtotal_cents, v_discount_cents,
       v_tax_cents, v_shipping_cents, v_total_cents, v_currency, v_assumptions_code,
       v_quote_created_at, v_quote_expires_at) IS DISTINCT FROM v_quote_digest
     OR v_quote_digest IS DISTINCT FROM v_ch_quote_digest THEN
    INSERT INTO shopaccess.audit_events
      (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
    VALUES
      ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CONFIRMATION_REJECTED', v_t6, v_t6, 'shopper',
       v_session_id, v_owner_id, v_known_intent_id, NULL,
       jsonb_build_object(
         'result', 'QUOTE_DIGEST_MISMATCH',
         'challengeId', p_challenge_id));
    RETURN QUERY SELECT 'QUOTE_DIGEST_MISMATCH'::text, NULL::text;
    RETURN;
  END IF;

  -- Row 9: the quote's expiry, against the reading of step 6 as it is.
  IF v_t6 >= v_quote_expires_at THEN
    RETURN QUERY SELECT 'QUOTE_EXPIRED'::text, NULL::text;
    RETURN;
  END IF;

  -- Row 10: a material change of the catalog. One statement, after the last
  -- lock; no catalog row is locked. Anything but a clear "unchanged" is stale.
  SELECT shopaccess_api.quote_material_change(
           v_unit_amount_cents, v_currency, v_quantity, v_merchant_id, v_product_id,
           v_merchant_name, v_product_title, v_variant_label, v_descriptive_digest,
           mv.unit_amount_cents::bigint, mv.currency, mv.availability, mv.max_quantity_per_order,
           mp.merchant_id, mv.product_id, mm.display_name, mp.title, mv.label, mp.description, mv.specs)
    INTO v_stale
    FROM (SELECT 1 AS present) one
    LEFT JOIN shopaccess.merchant_variants mv
      ON mv.id = v_variant_id
    LEFT JOIN shopaccess.merchant_products mp
      ON mp.id = mv.product_id
    LEFT JOIN shopaccess.merchants mm
      ON mm.id = mp.merchant_id;
  IF v_stale IS DISTINCT FROM false THEN
    RETURN QUERY SELECT 'QUOTE_STALE_CATALOG'::text, NULL::text;
    RETURN;
  END IF;

  -- Row 11: the intent must be stored QUOTED with this quote.
  IF v_state IS DISTINCT FROM 'QUOTED' OR v_quote_pointer IS DISTINCT FROM v_ch_quote_id THEN
    RETURN QUERY SELECT 'INTENT_NOT_AWAITING_CONFIRMATION'::text, NULL::text;
    RETURN;
  END IF;

  -- Row 12: the confirmation. The challenge first: the intent's pointer names a
  -- consumed challenge, and that key is checked at once. The time of
  -- consumption is never before the time of issue; the expiry above was
  -- decided on the reading as it is.
  UPDATE shopaccess.confirmation_challenges c
     SET status = 'CONSUMED',
         consumed_at = GREATEST(v_t6, c.issued_at)
   WHERE c.id = p_challenge_id AND c.owner_id = v_owner_id;

  -- The transition, decided by the one helper on the stored state.
  SELECT x.accepted, x.to_state, x.to_version, x.confirmation_id
    INTO v_accepted, v_to_state, v_to_version, v_next_confirmation_id
    FROM shopaccess_api.checkout_transition(
           v_state, v_version, 'SHOPPER_CONFIRMED', 'shopper', 'consume_challenge',
           v_quote_pointer, v_confirmation_id, v_superseded_by,
           v_ch_quote_id, p_challenge_id, NULL) x;
  IF v_accepted IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'shopaccess: the confirmation of a QUOTED intent was not accepted as a transition' USING ERRCODE = 'data_exception';
  END IF;

  v_event_id := 'ev_' || replace(gen_random_uuid()::text, '-', '');

  UPDATE shopaccess.checkout_intents i
     SET state = v_to_state,
         row_version = v_to_version,
         confirmation_id = v_next_confirmation_id,
         confirmation_status = 'CONSUMED',
         updated_at = GREATEST(i.updated_at, v_t6)
   WHERE i.id = v_known_intent_id AND i.owner_id = v_owner_id;

  INSERT INTO shopaccess.checkout_transitions
    (checkout_intent_id, to_version, from_version, event_id, event_type, actor, entry_point,
     from_state, to_state, occurred_at, recorded_at)
  VALUES
    (v_known_intent_id, v_to_version, v_version, v_event_id, 'SHOPPER_CONFIRMED', 'shopper', 'consume_challenge',
     v_state, v_to_state, v_t6, v_t6);

  INSERT INTO shopaccess.audit_events
    (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
  VALUES
    ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CONFIRMATION_ACCEPTED', v_t6, v_t6, 'shopper',
     v_session_id, v_owner_id, v_known_intent_id, NULL,
     jsonb_build_object(
       'transitionEventId', v_event_id,
       'challengeId', p_challenge_id,
       'quoteId', v_ch_quote_id));

  -- Forcing is mandatory (19.3).
  SET CONSTRAINTS
    shopaccess.checkout_intents_predecessor_reciprocal_fkey,
    shopaccess.checkout_intents_current_quote_fkey,
    shopaccess.checkout_intents_history_check,
    shopaccess.checkout_transitions_history_check,
    shopaccess.quotes_item_check,
    shopaccess.quote_items_quote_check
    IMMEDIATE;
  SET CONSTRAINTS
    shopaccess.checkout_intents_predecessor_reciprocal_fkey,
    shopaccess.checkout_intents_current_quote_fkey,
    shopaccess.checkout_intents_history_check,
    shopaccess.checkout_transitions_history_check,
    shopaccess.quotes_item_check,
    shopaccess.quote_items_quote_check
    DEFERRED;

  RETURN QUERY SELECT 'CONFIRMED'::text, v_known_intent_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (19.13). No default EXECUTE for anybody.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION shopaccess_api.read_checkout(smallint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.issue_challenge(smallint, text, text, text, smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.consume_challenge(smallint, text, text, text, text, text) FROM PUBLIC;

-- Web: the reader again, and the two new entry points. Still no table
-- privilege on any of the seven tables. The operator, the worker and PUBLIC
-- receive nothing.
GRANT EXECUTE ON FUNCTION shopaccess_api.read_checkout(smallint, text, text) TO shopaccess_web;
GRANT EXECUTE ON FUNCTION shopaccess_api.issue_challenge(smallint, text, text, text, smallint, text) TO shopaccess_web;
GRANT EXECUTE ON FUNCTION shopaccess_api.consume_challenge(smallint, text, text, text, text, text) TO shopaccess_web;

-- The function owner may now insert a challenge and end one: the status and
-- the three times that go with it, and no other column. It already reads the
-- table (migration 0008). No DELETE, no TRUNCATE.
GRANT INSERT ON shopaccess.confirmation_challenges TO shopaccess_definer;
GRANT UPDATE (status, consumed_at, superseded_at, expired_marked_at) ON shopaccess.confirmation_challenges TO shopaccess_definer;

-- Hand the three functions to shopaccess_definer. It needs CREATE on the schema
-- only for the moment of the hand-over; the privilege is taken away again at
-- once, so at runtime the function owner can create nothing.
GRANT CREATE ON SCHEMA shopaccess_api TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.read_checkout(smallint, text, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.issue_challenge(smallint, text, text, text, smallint, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.consume_challenge(smallint, text, text, text, text, text) OWNER TO shopaccess_definer;
REVOKE CREATE ON SCHEMA shopaccess_api FROM shopaccess_definer;
