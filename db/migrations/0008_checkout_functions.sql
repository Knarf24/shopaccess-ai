-- Migration 0008: Increment 2.1 checkout functions.
--
-- STATUS: written under the Group B source-edit gate. When this file was
-- written it had not been parsed or executed by PostgreSQL: its behavior is
-- established only by a separately authorized PostgreSQL 17 acceptance run.
--
-- Source: docs/postgresql/postgresql-specification-v2.0-draft.md, sections
-- 19.5 to 19.13 (with 5.1 for SAQD-1 and 19.2 for SADT-1).
--
-- Contents, in this order:
--   * six internal helpers (19.7a), executable by no role through any grant;
--   * the two mutating entry points, start_checkout and cancel_checkout;
--   * the two read entry points, read_checkout and list_owner_checkouts;
--   * every privilege of 19.13, and the hand-over to shopaccess_definer.
-- No table, index, trigger or constraint is created or changed here. No row is
-- written when this file is applied. No transaction control: the runner owns
-- the transaction.
--
-- Depends on: migrations 0002 (sessions, owners, key versions), 0003 (catalog),
-- 0005 (audit_events), 0006 (session_is_live and the function owner's
-- Increment 1 privileges) and 0007 (the seven checkout tables).
--
-- Rules that hold for the four entry points:
--   * SECURITY DEFINER, owned by shopaccess_definer (handed over at the end of
--     this file), fixed search path pg_catalog, pg_temp, every object reference
--     schema-qualified, no dynamic statement, no exception handler.
--   * The first two parameters are the session credential. The owner is taken
--     from the live session only; no caller supplies one and none is trusted.
--   * No function has a time parameter and none reads a session setting other
--     than the isolation level it refuses.
--   * A refusal is a result code. An error undoes everything the call did.
--
-- Lock acquisition order of the mutating entry points (19.4, 19.7). Both take
-- these in this order and never in another:
--   3.  the session row, FOR SHARE
--   5.  the owner row, FOR UPDATE
--   5a. the owner's request-window row, FOR UPDATE, when one exists
--   6.  the named checkout intent, FOR UPDATE (replacement and cancellation)
-- The catalog is read in one joined statement after the last lock; no catalog
-- row is locked explicitly. A lock wait that exceeds lock_timeout raises an
-- error (55P03). Nothing here catches it.
--
-- Clock readings (19.7, timestamp contract). v_t4 is read after the request-
-- window lock and decides the window. v_t6 is read after the last lock and is
-- the time of every business row. Neither is assumed to be later than the
-- other or than a stored time.
--
-- "#variable_conflict use_column" makes an unqualified name that is both an
-- output column and a table column mean the table column.

-- ---------------------------------------------------------------------------
-- Helper 1 of 6: the isolation guard (19.5). Returns its argument at READ
-- COMMITTED and raises at every other level. The read entry points use it as
-- their LIMIT expression, so it also carries their row limit.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.require_read_committed(
  p_value integer
) RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'shopaccess: the transaction isolation level must be read committed'
      USING ERRCODE = 'feature_not_supported';
  END IF;
  RETURN p_value;
END;
$$;

-- ---------------------------------------------------------------------------
-- Helper 2 of 6: which request window a call belongs to, and whether it is
-- over the limit of 30 calls per 60 seconds. A pure function of the stored
-- window (NULL when there is no row) and an explicit time. Entry points always
-- pass their own step 4 reading. A time before the stored window's start
-- belongs to the stored window.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.owner_window_decision(
  p_window_started_at timestamptz,
  p_window_calls integer,
  p_t timestamptz
) RETURNS TABLE (starts_new_window boolean, over_limit boolean)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.starts_new_window,
         (NOT d.starts_new_window AND coalesce(p_window_calls, 0) >= 30) AS over_limit
    FROM (
      SELECT (p_window_started_at IS NULL
              OR coalesce(p_t - p_window_started_at >= interval '60 seconds', false)) AS starts_new_window
    ) d;
$$;

-- ---------------------------------------------------------------------------
-- Helper 3 of 6: the six legal transitions T1 to T6 (19.2) as one predicate.
-- It is given the stored state and version, the event, the actor, the entry
-- point and the pointers the intent holds now, and answers whether the change
-- is accepted and what the intent holds afterwards. An event that does not
-- change a pointer returns the value it was given: cancellation and
-- supersession never clear a confirmation pointer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.checkout_transition(
  p_from_state text,
  p_from_version integer,
  p_event_type text,
  p_actor text,
  p_entry_point text,
  p_current_quote_id text,
  p_current_confirmation_id text,
  p_current_superseded_by_intent_id text,
  p_event_quote_id text,
  p_event_confirmation_id text,
  p_event_successor_intent_id text
) RETURNS TABLE (accepted boolean, to_state text, to_version integer, quote_id text, confirmation_id text, superseded_by_intent_id text)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.accepted,
         CASE WHEN d.accepted THEN d.next_state END,
         CASE WHEN d.accepted THEN p_from_version + 1 END,
         CASE WHEN d.accepted THEN d.next_quote_id END,
         CASE WHEN d.accepted THEN d.next_confirmation_id END,
         CASE WHEN d.accepted THEN d.next_superseded_by_intent_id END
    FROM (
      SELECT coalesce(
               CASE p_event_type
                 -- T1
                 WHEN 'QUOTE_ISSUED' THEN
                   p_actor = 'server' AND p_entry_point = 'start_checkout'
                   AND p_from_state = 'DRAFT' AND p_from_version = 1
                   AND p_current_quote_id IS NULL
                   AND p_current_confirmation_id IS NULL
                   AND p_current_superseded_by_intent_id IS NULL
                   AND p_event_quote_id IS NOT NULL
                 -- T2
                 WHEN 'SHOPPER_CONFIRMED' THEN
                   p_actor = 'shopper' AND p_entry_point = 'consume_challenge'
                   AND p_from_state = 'QUOTED' AND p_from_version >= 2
                   AND p_current_quote_id IS NOT NULL
                   AND p_event_quote_id = p_current_quote_id
                   AND p_current_confirmation_id IS NULL
                   AND p_event_confirmation_id IS NOT NULL
                   AND p_current_superseded_by_intent_id IS NULL
                 -- T3 and T4
                 WHEN 'SHOPPER_CANCELED' THEN
                   p_actor = 'shopper' AND p_entry_point = 'cancel_checkout'
                   AND p_from_state IN ('QUOTED', 'USER_CONFIRMED') AND p_from_version >= 2
                   AND p_current_quote_id IS NOT NULL
                   AND p_current_superseded_by_intent_id IS NULL
                 -- T5 and T6
                 WHEN 'SUPERSEDED' THEN
                   p_actor = 'server' AND p_entry_point = 'start_checkout'
                   AND p_from_state IN ('QUOTED', 'USER_CONFIRMED') AND p_from_version >= 2
                   AND p_current_quote_id IS NOT NULL
                   AND p_current_superseded_by_intent_id IS NULL
                   AND p_event_successor_intent_id IS NOT NULL
                 ELSE false
               END,
               false) AS accepted,
             CASE p_event_type
               WHEN 'QUOTE_ISSUED' THEN 'QUOTED'
               WHEN 'SHOPPER_CONFIRMED' THEN 'USER_CONFIRMED'
               WHEN 'SHOPPER_CANCELED' THEN 'CANCELED_LOCAL'
               WHEN 'SUPERSEDED' THEN 'SUPERSEDED'
             END AS next_state,
             CASE WHEN p_event_type = 'QUOTE_ISSUED' THEN p_event_quote_id ELSE p_current_quote_id END AS next_quote_id,
             CASE WHEN p_event_type = 'SHOPPER_CONFIRMED' THEN p_event_confirmation_id ELSE p_current_confirmation_id END AS next_confirmation_id,
             CASE WHEN p_event_type = 'SUPERSEDED' THEN p_event_successor_intent_id ELSE p_current_superseded_by_intent_id END AS next_superseded_by_intent_id
    ) d;
$$;

-- ---------------------------------------------------------------------------
-- Helper 4 of 6: the quote digest SAQD-1 (5.1) over exactly these 19 fields in
-- this order. Bytes: ASCII SAQD, version 01, field count 0013, then each field
-- as a type byte, a 4-byte big-endian length and the value: type 01 is text,
-- type 02 an 8-byte big-endian integer. The two times are microseconds since
-- the Unix epoch. A NULL argument gives NULL, so a quote can never be stored
-- with a digest over fewer fields.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.quote_digest_saqd1(
  p_quote_id text,
  p_owner_id text,
  p_intent_id text,
  p_purchase_group_id text,
  p_merchant_id text,
  p_product_id text,
  p_variant_id text,
  p_catalog_revision bigint,
  p_quantity bigint,
  p_unit_amount_cents bigint,
  p_subtotal_cents bigint,
  p_discount_cents bigint,
  p_tax_cents bigint,
  p_shipping_cents bigint,
  p_total_cents bigint,
  p_currency text,
  p_assumptions_code text,
  p_created_at timestamptz,
  p_expires_at timestamptz
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN count(*) FILTER (WHERE CASE WHEN f.is_text THEN f.text_value IS NULL ELSE f.integer_value IS NULL END) = 0
           THEN encode(
                  sha256(
                    decode('53415144010013', 'hex')
                    || string_agg(
                         CASE
                           WHEN f.is_text
                           THEN decode('01', 'hex') || int4send(octet_length(convert_to(f.text_value, 'UTF8'))) || convert_to(f.text_value, 'UTF8')
                           ELSE decode('0200000008', 'hex') || int8send(f.integer_value)
                         END,
                         ''::bytea ORDER BY f.position)),
                  'hex')
         END
    FROM (
      VALUES
        (1, true, p_quote_id, NULL::bigint),
        (2, true, p_owner_id, NULL::bigint),
        (3, true, p_intent_id, NULL::bigint),
        (4, true, p_purchase_group_id, NULL::bigint),
        (5, true, p_merchant_id, NULL::bigint),
        (6, true, p_product_id, NULL::bigint),
        (7, true, p_variant_id, NULL::bigint),
        (8, false, NULL::text, p_catalog_revision),
        (9, false, NULL::text, p_quantity),
        (10, false, NULL::text, p_unit_amount_cents),
        (11, false, NULL::text, p_subtotal_cents),
        (12, false, NULL::text, p_discount_cents),
        (13, false, NULL::text, p_tax_cents),
        (14, false, NULL::text, p_shipping_cents),
        (15, false, NULL::text, p_total_cents),
        (16, true, p_currency, NULL::bigint),
        (17, true, p_assumptions_code, NULL::bigint),
        (18, false, NULL::text, (extract(epoch FROM p_created_at) * 1000000)::bigint),
        (19, false, NULL::text, (extract(epoch FROM p_expires_at) * 1000000)::bigint)
    ) AS f(position, is_text, text_value, integer_value);
$$;

-- ---------------------------------------------------------------------------
-- Helper 5 of 6: the descriptive-terms digest SADT-1 (19.2). Bytes: ASCII
-- SADT, version 01, field count 0002, then two fields of type 03, each with a
-- 4-byte big-endian byte length: the product description, and the variant
-- specifications as jsonb prints them. Nothing is trimmed or normalized.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.descriptive_terms_digest(
  p_description text,
  p_specs jsonb
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN p_description IS NULL OR p_specs IS NULL THEN NULL
           ELSE encode(
                  sha256(
                    decode('53414454010002', 'hex')
                    || decode('03', 'hex') || int4send(octet_length(convert_to(p_description, 'UTF8'))) || convert_to(p_description, 'UTF8')
                    || decode('03', 'hex') || int4send(octet_length(convert_to(p_specs::text, 'UTF8'))) || convert_to(p_specs::text, 'UTF8')),
                  'hex')
         END;
$$;

-- ---------------------------------------------------------------------------
-- Helper 6 of 6: whether a stored quote is stale (19.8). The p_q_ values are
-- the stored snapshot; the p_c_ values are the catalog now. A missing catalog
-- row arrives as NULLs and is stale. The image path and both revision numbers
-- are not compared.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.quote_material_change(
  p_q_unit_amount_cents bigint,
  p_q_currency text,
  p_q_quantity integer,
  p_q_merchant_id text,
  p_q_product_id text,
  p_q_merchant_display_name text,
  p_q_product_title text,
  p_q_variant_label text,
  p_q_descriptive_terms_digest text,
  p_c_unit_amount_cents bigint,
  p_c_currency text,
  p_c_availability text,
  p_c_max_quantity_per_order integer,
  p_c_merchant_id text,
  p_c_product_id text,
  p_c_merchant_display_name text,
  p_c_product_title text,
  p_c_variant_label text,
  p_c_description text,
  p_c_specs jsonb
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_c_unit_amount_cents IS DISTINCT FROM p_q_unit_amount_cents
      OR p_c_currency IS DISTINCT FROM p_q_currency
      OR p_c_availability IS DISTINCT FROM 'IN_STOCK'
      OR p_c_max_quantity_per_order IS NULL
      OR p_q_quantity IS NULL
      OR p_c_max_quantity_per_order < p_q_quantity
      OR p_c_merchant_id IS DISTINCT FROM p_q_merchant_id
      OR p_c_product_id IS DISTINCT FROM p_q_product_id
      OR p_c_merchant_display_name IS DISTINCT FROM p_q_merchant_display_name
      OR p_c_product_title IS DISTINCT FROM p_q_product_title
      OR p_c_variant_label IS DISTINCT FROM p_q_variant_label
      OR shopaccess_api.descriptive_terms_digest(p_c_description, p_c_specs) IS DISTINCT FROM p_q_descriptive_terms_digest;
$$;

-- ---------------------------------------------------------------------------
-- start_checkout (web)
-- A new checkout, or the replacement of an existing one (19.3, 19.7).
-- Business results are decided in this order (19.7): replacement eligibility;
-- then the catalog; then capacity. Only a capacity refusal writes an audit row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.start_checkout(
  p_key_version smallint,
  p_token_digest text,
  p_product_id text,
  p_variant_id text,
  p_quantity integer,
  p_replaces_intent_id text
) RETURNS TABLE (result text, intent_id text, quote_id text, quote_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  c_quote_lifetime   constant interval := interval '15 minutes';
  c_window_limit     constant integer  := 30;
  c_window_seconds   constant integer  := 60;
  c_max_groups       constant integer  := 10;
  c_max_group_intents constant integer := 10;
  c_max_subtotal     constant bigint   := 20000000;
  c_assumptions_code constant text     := 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1';
  v_session_id          text;
  v_owner_id            text;
  v_locked_session_id   text;
  v_locked_owner_id     text;
  v_revoked_at          timestamptz;
  v_absolute_expires_at timestamptz;
  v_last_seen_at        timestamptz;
  v_key_status          text;
  v_window_exists       boolean;
  v_window_started_at   timestamptz;
  v_window_calls        integer;
  v_window_throttled    bigint;
  v_new_window          boolean;
  v_over_limit          boolean;
  v_t4                  timestamptz;
  v_t6                  timestamptz;
  v_pred_found          boolean := false;
  v_pred_state          text;
  v_pred_version        integer;
  v_pred_group_id       text;
  v_pred_quote_id       text;
  v_pred_confirmation_id text;
  v_pred_superseded_by  text;
  v_pred_accepted       boolean;
  v_pred_to_state       text;
  v_pred_to_version     integer;
  v_pred_next_confirmation_id text;
  v_pred_next_superseded_by   text;
  v_new_accepted        boolean;
  v_new_state           text;
  v_new_version         integer;
  v_new_quote_pointer   text;
  v_intent_id           text;
  v_quote_id            text;
  v_group_id            text;
  v_quote_event_id      text;
  v_superseded_event_id text;
  v_unit_amount_cents   bigint;
  v_currency            text;
  v_max_quantity        integer;
  v_availability        text;
  v_catalog_revision    integer;
  v_variant_label       text;
  v_specs               jsonb;
  v_product_title       text;
  v_description         text;
  v_merchant_id         text;
  v_merchant_name       text;
  v_subtotal_cents      bigint;
  v_count               bigint;
  v_expires_at          timestamptz;
BEGIN
  -- Before anything else: the isolation level (19.5).
  PERFORM shopaccess_api.require_read_committed(1);

  -- Step 0a: credential format.
  IF p_key_version IS NULL OR p_key_version <= 0
     OR p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 0b: unlocked lookup; the session must exist and appear live.
  SELECT s.id, s.owner_id, s.revoked_at, s.absolute_expires_at, s.last_seen_at
    INTO v_session_id, v_owner_id, v_revoked_at, v_absolute_expires_at, v_last_seen_at
    FROM shopaccess.shopper_sessions s
   WHERE s.key_purpose = 'session' AND s.key_version = p_key_version AND s.token_digest = p_token_digest;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, clock_timestamp()) THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 0c: argument format. Before any lock and before admission.
  IF p_product_id IS NULL OR p_product_id !~ '^dmp_[a-z0-9]{6,24}$'
     OR p_variant_id IS NULL OR p_variant_id !~ '^dmv_[a-z0-9]{6,24}$'
     OR p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 10
     OR (p_replaces_intent_id IS NOT NULL AND p_replaces_intent_id !~ '^ci_[0-9a-f]{32}$') THEN
    RETURN QUERY SELECT 'REQUEST_INVALID'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
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
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::timestamptz;
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
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::timestamptz;
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
    RETURN QUERY SELECT 'RATE_LIMITED'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 5: the predecessor, by its id and the caller's owner together. A
  -- missing id and another owner's id both select nothing and lock nothing.
  IF p_replaces_intent_id IS NOT NULL THEN
    SELECT i.state, i.row_version, i.purchase_group_id, i.current_quote_id, i.confirmation_id, i.superseded_by_intent_id
      INTO v_pred_state, v_pred_version, v_pred_group_id, v_pred_quote_id, v_pred_confirmation_id, v_pred_superseded_by
      FROM shopaccess.checkout_intents i
     WHERE i.id = p_replaces_intent_id AND i.owner_id = v_owner_id
       FOR UPDATE;
    v_pred_found := FOUND;
  END IF;

  -- Step 6: the second clock reading, the credential a last time, and the
  -- resource of step 5.
  v_t6 := clock_timestamp();

  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, v_t6)
     OR (p_replaces_intent_id IS NOT NULL AND NOT v_pred_found) THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- Step 7: admission, in the window assigned at step 4.
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

  -- Step 8: business rules. Identifiers are generated here, in the database.
  v_intent_id := 'ci_' || replace(gen_random_uuid()::text, '-', '');
  v_quote_id := 'qt_' || replace(gen_random_uuid()::text, '-', '');
  v_quote_event_id := 'ev_' || replace(gen_random_uuid()::text, '-', '');

  -- 8.1 Replacement eligibility, decided on the stored state only.
  IF p_replaces_intent_id IS NOT NULL THEN
    SELECT x.accepted, x.to_state, x.to_version, x.confirmation_id, x.superseded_by_intent_id
      INTO v_pred_accepted, v_pred_to_state, v_pred_to_version, v_pred_next_confirmation_id, v_pred_next_superseded_by
      FROM shopaccess_api.checkout_transition(
             v_pred_state, v_pred_version, 'SUPERSEDED', 'server', 'start_checkout',
             v_pred_quote_id, v_pred_confirmation_id, v_pred_superseded_by,
             NULL, NULL, v_intent_id) x;
    IF NOT v_pred_accepted THEN
      RETURN QUERY SELECT 'REPLACEMENT_NOT_ALLOWED'::text, NULL::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;

  -- 8.2 The catalog, read in one joined statement after the last lock. The
  -- quote stores what this statement returned.
  SELECT mv.unit_amount_cents::bigint, mv.currency, mv.max_quantity_per_order, mv.availability, mv.catalog_revision,
         mv.label, mv.specs, mp.title, mp.description, mm.id, mm.display_name
    INTO v_unit_amount_cents, v_currency, v_max_quantity, v_availability, v_catalog_revision,
         v_variant_label, v_specs, v_product_title, v_description, v_merchant_id, v_merchant_name
    FROM shopaccess.merchant_variants mv
    JOIN shopaccess.merchant_products mp ON mp.id = mv.product_id
    JOIN shopaccess.merchants mm ON mm.id = mp.merchant_id
   WHERE mv.id = p_variant_id AND mv.product_id = p_product_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PRODUCT_NOT_IN_MERCHANT_CATALOG'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_availability IS DISTINCT FROM 'IN_STOCK' THEN
    RETURN QUERY SELECT 'VARIANT_UNAVAILABLE'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_quantity > v_max_quantity THEN
    RETURN QUERY SELECT 'QUANTITY_EXCEEDS_LIMIT'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  v_subtotal_cents := v_unit_amount_cents * p_quantity;
  IF v_subtotal_cents < 1 OR v_subtotal_cents > c_max_subtotal THEN
    RETURN QUERY SELECT 'AMOUNT_OUT_OF_RANGE'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  -- 8.3 Capacity, counted under the owner lock. A refusal writes one audit row.
  IF p_replaces_intent_id IS NOT NULL THEN
    v_group_id := v_pred_group_id;
    SELECT count(*) INTO v_count
      FROM shopaccess.checkout_intents i
     WHERE i.purchase_group_id = v_group_id;
    IF v_count >= c_max_group_intents THEN
      INSERT INTO shopaccess.audit_events
        (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
      VALUES
        ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CHECKOUT_REFUSED_AT_CAPACITY', v_t6, v_t6, 'server',
         v_session_id, v_owner_id, p_replaces_intent_id, NULL,
         jsonb_build_object(
           'reason', 'GROUP_INTENT_LIMIT',
           'limit', c_max_group_intents,
           'purchaseGroupId', v_group_id));
      RETURN QUERY SELECT 'GROUP_INTENT_LIMIT'::text, NULL::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
  ELSE
    -- A group is unresolved while any of its intents is stored as QUOTED or
    -- USER_CONFIRMED, whether or not its quote has expired (19.9).
    SELECT count(*) INTO v_count
      FROM shopaccess.purchase_groups g
     WHERE g.owner_id = v_owner_id
       AND EXISTS (
         SELECT 1
           FROM shopaccess.checkout_intents i
          WHERE i.purchase_group_id = g.id
            AND i.state IN ('QUOTED', 'USER_CONFIRMED'));
    IF v_count >= c_max_groups THEN
      INSERT INTO shopaccess.audit_events
        (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
      VALUES
        ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CHECKOUT_REFUSED_AT_CAPACITY', v_t6, v_t6, 'server',
         v_session_id, v_owner_id, NULL, NULL,
         jsonb_build_object(
           'reason', 'AT_PURCHASE_CAPACITY',
           'limit', c_max_groups));
      RETURN QUERY SELECT 'AT_PURCHASE_CAPACITY'::text, NULL::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
    v_group_id := 'pur_' || replace(gen_random_uuid()::text, '-', '');
  END IF;

  -- 8.4 The write sequence of 19.3. The new intent is stored directly as the
  -- result of T1; DRAFT is never stored.
  SELECT x.accepted, x.to_state, x.to_version, x.quote_id
    INTO v_new_accepted, v_new_state, v_new_version, v_new_quote_pointer
    FROM shopaccess_api.checkout_transition(
           'DRAFT', 1, 'QUOTE_ISSUED', 'server', 'start_checkout',
           NULL, NULL, NULL,
           v_quote_id, NULL, NULL) x;
  IF NOT v_new_accepted THEN
    RAISE EXCEPTION 'shopaccess: the initial quote transition was not accepted';
  END IF;

  IF p_replaces_intent_id IS NULL THEN
    INSERT INTO shopaccess.purchase_groups (id, owner_id, created_at)
    VALUES (v_group_id, v_owner_id, v_t6);
  END IF;

  INSERT INTO shopaccess.checkout_intents
    (id, owner_id, purchase_group_id, replaces_intent_id, superseded_by_intent_id, created_by_session_id,
     state, row_version, current_quote_id, confirmation_id, confirmation_status, created_at, updated_at)
  VALUES
    (v_intent_id, v_owner_id, v_group_id, p_replaces_intent_id, NULL, v_session_id,
     v_new_state, v_new_version, v_new_quote_pointer, NULL, NULL, v_t6, v_t6);

  v_expires_at := v_t6 + c_quote_lifetime;

  INSERT INTO shopaccess.quotes
    (id, owner_id, checkout_intent_id, merchant_id, catalog_revision,
     subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents,
     currency, assumptions_code, created_at, expires_at, digest, digest_version)
  VALUES
    (v_quote_id, v_owner_id, v_intent_id, v_merchant_id, v_catalog_revision,
     v_subtotal_cents, 0, 0, 0, v_subtotal_cents,
     v_currency, c_assumptions_code, v_t6, v_expires_at,
     shopaccess_api.quote_digest_saqd1(
       v_quote_id, v_owner_id, v_intent_id, v_group_id, v_merchant_id, p_product_id, p_variant_id,
       v_catalog_revision::bigint, p_quantity::bigint, v_unit_amount_cents,
       v_subtotal_cents, 0::bigint, 0::bigint, 0::bigint, v_subtotal_cents,
       v_currency, c_assumptions_code, v_t6, v_expires_at),
     'SAQD-1');

  INSERT INTO shopaccess.quote_items
    (quote_id, line_number, product_id, variant_id, quantity, unit_amount_cents, line_subtotal_cents,
     merchant_display_name, product_title, variant_label, descriptive_terms_digest)
  VALUES
    (v_quote_id, 1, p_product_id, p_variant_id, p_quantity, v_unit_amount_cents, v_subtotal_cents,
     v_merchant_name, v_product_title, v_variant_label,
     shopaccess_api.descriptive_terms_digest(v_description, v_specs));

  INSERT INTO shopaccess.checkout_transitions
    (checkout_intent_id, to_version, from_version, event_id, event_type, actor, entry_point,
     from_state, to_state, occurred_at, recorded_at)
  VALUES
    (v_intent_id, v_new_version, 1, v_quote_event_id, 'QUOTE_ISSUED', 'server', 'start_checkout',
     'DRAFT', v_new_state, v_t6, v_t6);

  IF p_replaces_intent_id IS NOT NULL THEN
    v_superseded_event_id := 'ev_' || replace(gen_random_uuid()::text, '-', '');
    -- The confirmation pointer is written back as it was given: unchanged.
    UPDATE shopaccess.checkout_intents i
       SET state = v_pred_to_state,
           row_version = v_pred_to_version,
           superseded_by_intent_id = v_pred_next_superseded_by,
           confirmation_id = v_pred_next_confirmation_id,
           updated_at = GREATEST(i.updated_at, v_t6)
     WHERE i.id = p_replaces_intent_id AND i.owner_id = v_owner_id;

    INSERT INTO shopaccess.checkout_transitions
      (checkout_intent_id, to_version, from_version, event_id, event_type, actor, entry_point,
       from_state, to_state, occurred_at, recorded_at)
    VALUES
      (p_replaces_intent_id, v_pred_to_version, v_pred_version, v_superseded_event_id, 'SUPERSEDED', 'server', 'start_checkout',
       v_pred_state, v_pred_to_state, v_t6, v_t6);
  END IF;

  INSERT INTO shopaccess.audit_events
    (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
  VALUES
    ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'QUOTE_ISSUED', v_t6, v_t6, 'server',
     v_session_id, v_owner_id, v_intent_id, NULL,
     jsonb_build_object(
       'transitionEventId', v_quote_event_id,
       'quoteId', v_quote_id,
       'purchaseGroupId', v_group_id,
       'productId', p_product_id,
       'variantId', p_variant_id,
       'quantity', p_quantity,
       'totalCents', v_subtotal_cents));

  IF p_replaces_intent_id IS NOT NULL THEN
    INSERT INTO shopaccess.audit_events
      (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
    VALUES
      ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CHECKOUT_SUPERSEDED', v_t6, v_t6, 'server',
       v_session_id, v_owner_id, p_replaces_intent_id, NULL,
       jsonb_build_object(
         'transitionEventId', v_superseded_event_id,
         'supersededByIntentId', v_intent_id));
  END IF;

  -- Forcing is mandatory (19.3): every deferred check queued by this call is
  -- decided here, inside the call, and the constraints are then restored.
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

  RETURN QUERY SELECT 'STARTED'::text, v_intent_id, v_quote_id, v_expires_at;
END;
$$;

-- ---------------------------------------------------------------------------
-- cancel_checkout (web)
-- Cancels a checkout stored as QUOTED or USER_CONFIRMED. An expired quote does
-- not prevent it. The confirmation pointer of a USER_CONFIRMED intent is left
-- exactly as it is.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.cancel_checkout(
  p_key_version smallint,
  p_token_digest text,
  p_intent_id text
) RETURNS TABLE (result text)
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
  v_version             integer;
  v_quote_pointer       text;
  v_confirmation_id     text;
  v_superseded_by       text;
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
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text;
    RETURN;
  END IF;

  -- Step 0b: unlocked lookup; the session must exist and appear live.
  SELECT s.id, s.owner_id, s.revoked_at, s.absolute_expires_at, s.last_seen_at
    INTO v_session_id, v_owner_id, v_revoked_at, v_absolute_expires_at, v_last_seen_at
    FROM shopaccess.shopper_sessions s
   WHERE s.key_purpose = 'session' AND s.key_version = p_key_version AND s.token_digest = p_token_digest;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text;
    RETURN;
  END IF;
  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, clock_timestamp()) THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text;
    RETURN;
  END IF;

  -- Step 0c: argument format. Before any lock and before admission.
  IF p_intent_id IS NULL OR p_intent_id !~ '^ci_[0-9a-f]{32}$' THEN
    RETURN QUERY SELECT 'REQUEST_INVALID'::text;
    RETURN;
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
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text;
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
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text;
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
    RETURN QUERY SELECT 'RATE_LIMITED'::text;
    RETURN;
  END IF;

  -- Step 5: the intent, by its id and the caller's owner together. A missing
  -- id and another owner's id both select nothing and lock nothing.
  SELECT i.state, i.row_version, i.current_quote_id, i.confirmation_id, i.superseded_by_intent_id
    INTO v_state, v_version, v_quote_pointer, v_confirmation_id, v_superseded_by
    FROM shopaccess.checkout_intents i
   WHERE i.id = p_intent_id AND i.owner_id = v_owner_id
     FOR UPDATE;
  v_found := FOUND;

  -- Step 6: the second clock reading, the credential a last time, and the
  -- resource of step 5.
  v_t6 := clock_timestamp();

  SELECT k.status INTO v_key_status
    FROM shopaccess.server_key_versions k
   WHERE k.purpose = 'session' AND k.key_version = p_key_version;
  IF NOT shopaccess_api.session_is_live(v_revoked_at, v_absolute_expires_at, v_last_seen_at, v_key_status, v_t6)
     OR NOT v_found THEN
    RETURN QUERY SELECT 'NOT_AUTHORIZED'::text;
    RETURN;
  END IF;

  -- Step 7: admission, in the window assigned at step 4.
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

  -- Step 8: the transition, decided by the one helper on the stored state.
  SELECT x.accepted, x.to_state, x.to_version, x.confirmation_id
    INTO v_accepted, v_to_state, v_to_version, v_next_confirmation_id
    FROM shopaccess_api.checkout_transition(
           v_state, v_version, 'SHOPPER_CANCELED', 'shopper', 'cancel_checkout',
           v_quote_pointer, v_confirmation_id, v_superseded_by,
           NULL, NULL, NULL) x;
  IF NOT v_accepted THEN
    RETURN QUERY SELECT 'NOT_CANCELABLE'::text;
    RETURN;
  END IF;

  v_event_id := 'ev_' || replace(gen_random_uuid()::text, '-', '');

  -- The confirmation pointer is written back as it was given: unchanged.
  UPDATE shopaccess.checkout_intents i
     SET state = v_to_state,
         row_version = v_to_version,
         confirmation_id = v_next_confirmation_id,
         updated_at = GREATEST(i.updated_at, v_t6)
   WHERE i.id = p_intent_id AND i.owner_id = v_owner_id;

  INSERT INTO shopaccess.checkout_transitions
    (checkout_intent_id, to_version, from_version, event_id, event_type, actor, entry_point,
     from_state, to_state, occurred_at, recorded_at)
  VALUES
    (p_intent_id, v_to_version, v_version, v_event_id, 'SHOPPER_CANCELED', 'shopper', 'cancel_checkout',
     v_state, v_to_state, v_t6, v_t6);

  INSERT INTO shopaccess.audit_events
    (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail)
  VALUES
    ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CHECKOUT_CANCELED', v_t6, v_t6, 'shopper',
     v_session_id, v_owner_id, p_intent_id, NULL,
     jsonb_build_object(
       'transitionEventId', v_event_id,
       'fromState', v_state));

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

  RETURN QUERY SELECT 'CANCELED'::text;
END;
$$;

-- ---------------------------------------------------------------------------
-- read_checkout (web)
-- One statement, one snapshot, always exactly one row. Takes no lock and
-- writes nothing. Time is the start time of the calling statement. A failed
-- credential and an intent id that is malformed, missing or another owner's
-- all give the same row: NOT_AUTHORIZED with every other column NULL.
-- The LIMIT expression is the isolation guard (19.5).
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.read_checkout(
  p_key_version smallint,
  p_token_digest text,
  p_intent_id text
) RETURNS TABLE (result text, owner_id text, intent_id text, purchase_group_id text, stored_state text, row_version integer, effective_status text, replaces_intent_id text, superseded_by_intent_id text, intent_created_at timestamptz, intent_updated_at timestamptz, quote_id text, merchant_id text, merchant_display_name text, product_id text, product_title text, variant_id text, variant_label text, quantity integer, unit_amount_cents bigint, subtotal_cents bigint, discount_cents bigint, tax_cents bigint, shipping_cents bigint, total_cents bigint, currency text, assumptions_code text, catalog_revision integer, quote_digest text, quote_created_at timestamptz, quote_expires_at timestamptz, quote_stale boolean, database_time timestamptz)
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
         CASE WHEN v.found_intent_id IS NULL THEN NULL ELSE statement_timestamp() END
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
             ) AS found_quote_stale
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
-- list_owner_checkouts (web)
-- The caller's own checkouts, newest first, at most 100. No row when the
-- credential fails. Takes no lock and writes nothing.
-- The LIMIT expression is the isolation guard (19.5) and carries the limit.
-- ---------------------------------------------------------------------------
CREATE FUNCTION shopaccess_api.list_owner_checkouts(
  p_key_version smallint,
  p_token_digest text
) RETURNS TABLE (intent_id text, purchase_group_id text, stored_state text, effective_status text, intent_created_at timestamptz, quote_expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.id,
         i.purchase_group_id,
         i.state,
         CASE
           WHEN i.state IN ('QUOTED', 'USER_CONFIRMED') AND statement_timestamp() >= q.expires_at THEN 'QUOTE_EXPIRED'
           ELSE i.state
         END,
         i.created_at,
         q.expires_at
    FROM shopaccess.shopper_sessions s
    LEFT JOIN shopaccess.server_key_versions k
      ON k.purpose = s.key_purpose AND k.key_version = s.key_version
    JOIN shopaccess.checkout_intents i
      ON i.owner_id = s.owner_id
    JOIN shopaccess.quotes q
      ON q.id = i.current_quote_id AND q.checkout_intent_id = i.id
   WHERE p_key_version IS NOT NULL AND p_key_version > 0
     AND p_token_digest IS NOT NULL AND p_token_digest ~ '^[0-9a-f]{64}$'
     AND s.key_purpose = 'session'
     AND s.key_version = p_key_version
     AND s.token_digest = p_token_digest
     AND shopaccess_api.session_is_live(s.revoked_at, s.absolute_expires_at, s.last_seen_at, k.status, statement_timestamp())
   ORDER BY i.created_at DESC, i.id DESC
   LIMIT shopaccess_api.require_read_committed(100);
$$;

-- ---------------------------------------------------------------------------
-- Privileges (19.13). Every grant of Increment 2.1 is in this file.
-- ---------------------------------------------------------------------------

-- Nothing is executable by PUBLIC (default privileges already ensure this;
-- stated again so this file is self-evident).
REVOKE ALL ON FUNCTION shopaccess_api.require_read_committed(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.owner_window_decision(timestamptz, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.checkout_transition(text, integer, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.quote_digest_saqd1(text, text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, text, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.descriptive_terms_digest(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.quote_material_change(bigint, text, integer, text, text, text, text, text, text, bigint, text, text, integer, text, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.start_checkout(smallint, text, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.cancel_checkout(smallint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.read_checkout(smallint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION shopaccess_api.list_owner_checkouts(smallint, text) FROM PUBLIC;

-- Web: the four entry points, and nothing else. No table privilege on any of
-- the seven tables. The six helpers are granted to nobody. The operator, the
-- worker and PUBLIC receive nothing.
GRANT EXECUTE ON FUNCTION shopaccess_api.start_checkout(smallint, text, text, text, integer, text) TO shopaccess_web;
GRANT EXECUTE ON FUNCTION shopaccess_api.cancel_checkout(smallint, text, text) TO shopaccess_web;
GRANT EXECUTE ON FUNCTION shopaccess_api.read_checkout(smallint, text, text) TO shopaccess_web;
GRANT EXECUTE ON FUNCTION shopaccess_api.list_owner_checkouts(smallint, text) TO shopaccess_web;

-- The function owner gets exactly the table privileges its functions and the
-- triggers that run inside them use. No DELETE, no TRUNCATE, no DDL, no
-- ownership of any table.
--   * The catalog: SELECT only. A quote is priced from one snapshot.
--   * checkout_owners: UPDATE for the owner-row lock only; the table's trigger
--     rejects every update.
--   * confirmation_challenges: SELECT only in Increment 2.1.
--   * owner_request_windows: UPDATE on the five non-key columns only, so the
--     owner of a window can never be changed.
GRANT SELECT ON shopaccess.merchants TO shopaccess_definer;
GRANT SELECT ON shopaccess.merchant_products TO shopaccess_definer;
GRANT SELECT ON shopaccess.merchant_variants TO shopaccess_definer;
GRANT UPDATE ON shopaccess.checkout_owners TO shopaccess_definer;
GRANT SELECT, INSERT ON shopaccess.purchase_groups TO shopaccess_definer;
GRANT SELECT, INSERT, UPDATE ON shopaccess.checkout_intents TO shopaccess_definer;
GRANT SELECT, INSERT ON shopaccess.quotes TO shopaccess_definer;
GRANT SELECT, INSERT ON shopaccess.quote_items TO shopaccess_definer;
GRANT SELECT, INSERT ON shopaccess.checkout_transitions TO shopaccess_definer;
GRANT SELECT ON shopaccess.confirmation_challenges TO shopaccess_definer;
GRANT SELECT, INSERT ON shopaccess.owner_request_windows TO shopaccess_definer;
GRANT UPDATE (window_started_at, window_calls, window_throttled, total_throttled, updated_at) ON shopaccess.owner_request_windows TO shopaccess_definer;

-- Hand the functions to shopaccess_definer. It needs CREATE on the schema only
-- for the moment of the hand-over; the privilege is revoked again immediately,
-- so at runtime the function owner can create nothing.
GRANT CREATE ON SCHEMA shopaccess_api TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.require_read_committed(integer) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.owner_window_decision(timestamptz, integer, timestamptz) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.checkout_transition(text, integer, text, text, text, text, text, text, text, text, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.quote_digest_saqd1(text, text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, text, text, timestamptz, timestamptz) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.descriptive_terms_digest(text, jsonb) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.quote_material_change(bigint, text, integer, text, text, text, text, text, text, bigint, text, text, integer, text, text, text, text, text, text, jsonb) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.start_checkout(smallint, text, text, text, integer, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.cancel_checkout(smallint, text, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.read_checkout(smallint, text, text) OWNER TO shopaccess_definer;
ALTER FUNCTION shopaccess_api.list_owner_checkouts(smallint, text) OWNER TO shopaccess_definer;
REVOKE CREATE ON SCHEMA shopaccess_api FROM shopaccess_definer;
