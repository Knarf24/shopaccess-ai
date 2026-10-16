-- Migration 0007: Increment 2.1 checkout schema.
--
-- STATUS: active migration. This file is in db/migrations and is named, with
-- its checksum, in the approved inventory of the migration runner; its bytes
-- do not change once pinned. When it was registered it had not been parsed or
-- executed by PostgreSQL: its behavior is established only by a separately
-- authorized PostgreSQL 17 acceptance run.
--
-- Source: docs/postgresql/postgresql-specification-v2.0-draft.md, sections
-- 19.2 and 19.3 (with 2.7, 2.9, 2.10, 2.11 and 2.18 for column definitions).
--
-- Scope: seven tables, their keys, checks and partial unique indexes, their
-- trigger functions and triggers, and the six deferred checks. Schema only.
--   * No privilege is given to any role here: the schema file is default-deny
--     (19.13). Table privileges for the function owner belong to the functions
--     file.
--   * No row is written here. No entry-point function or helper is defined.
--   * No transaction control: the runner owns the transaction.
--
-- Depends on: the bootstrap file (roles, schemas, default privileges) and
-- migrations 0001 (shopaccess.reject_change), 0002 (checkout_owners,
-- server_key_versions) and 0003 (merchants, merchant_variants).
--
-- Creation order (19.2): tables 1 to 6; then the self-referencing and forward
-- keys on checkout_intents; then the partial unique indexes; then triggers;
-- then table 7.

-- ---------------------------------------------------------------------------
-- 1. purchase_groups: one buyer-authorized purchase. Rows are never changed.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.purchase_groups (
  id         text NOT NULL,
  owner_id   text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT purchase_groups_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_groups_id_owner_key UNIQUE (id, owner_id),
  CONSTRAINT purchase_groups_id_format_check CHECK (id ~ '^pur_[0-9a-f]{32}$'),
  CONSTRAINT purchase_groups_owner_fkey FOREIGN KEY (owner_id)
    REFERENCES shopaccess.checkout_owners (id)
);

-- ---------------------------------------------------------------------------
-- 2. checkout_intents: one checkout attempt. Exactly the thirteen columns of
-- 19.2. No payment column exists, and no column has a default.
-- The self-referencing and forward keys are added after table 6.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.checkout_intents (
  id                      text NOT NULL,
  owner_id                text NOT NULL,
  purchase_group_id       text NOT NULL,
  replaces_intent_id      text,
  superseded_by_intent_id text,
  -- Informational only. Deliberately no key: a checkout outlives its session.
  created_by_session_id   text,
  state                   text NOT NULL,
  row_version             integer NOT NULL,
  current_quote_id        text NOT NULL,
  confirmation_id         text,
  confirmation_status     text,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  CONSTRAINT checkout_intents_pkey PRIMARY KEY (id),
  CONSTRAINT checkout_intents_id_owner_key UNIQUE (id, owner_id),
  CONSTRAINT checkout_intents_id_group_key UNIQUE (id, purchase_group_id),
  CONSTRAINT checkout_intents_id_replaces_key UNIQUE (id, replaces_intent_id),
  CONSTRAINT checkout_intents_id_superseded_by_key UNIQUE (id, superseded_by_intent_id),
  CONSTRAINT checkout_intents_id_format_check CHECK (id ~ '^ci_[0-9a-f]{32}$'),
  -- EXPIRED is a reserved stored state in Increment 2.1: listed, never produced.
  CONSTRAINT checkout_intents_state_check
    CHECK (state IN ('QUOTED', 'USER_CONFIRMED', 'SUPERSEDED', 'CANCELED_LOCAL', 'EXPIRED')),
  CONSTRAINT checkout_intents_quoted_no_confirmation_check
    CHECK (state <> 'QUOTED' OR (confirmation_id IS NULL AND confirmation_status IS NULL)),
  CONSTRAINT checkout_intents_confirmed_has_confirmation_check
    CHECK (state <> 'USER_CONFIRMED' OR (confirmation_id IS NOT NULL AND confirmation_status IS NOT NULL)),
  CONSTRAINT checkout_intents_confirmation_pair_check
    CHECK (
      (confirmation_id IS NULL AND confirmation_status IS NULL)
      OR
      (confirmation_id IS NOT NULL
       AND confirmation_status IS NOT NULL
       AND confirmation_status = 'CONSUMED')
    ),
  CONSTRAINT checkout_intents_superseded_pointer_check
    CHECK ((state = 'SUPERSEDED') = (superseded_by_intent_id IS NOT NULL)),
  CONSTRAINT checkout_intents_no_self_pointer_check
    CHECK (
      (replaces_intent_id IS NULL OR replaces_intent_id <> id)
      AND (superseded_by_intent_id IS NULL OR superseded_by_intent_id <> id)
    ),
  CONSTRAINT checkout_intents_row_version_check CHECK (row_version >= 2),
  CONSTRAINT checkout_intents_updated_at_check CHECK (updated_at >= created_at),
  CONSTRAINT checkout_intents_group_owner_fkey FOREIGN KEY (purchase_group_id, owner_id)
    REFERENCES shopaccess.purchase_groups (id, owner_id)
);

-- ---------------------------------------------------------------------------
-- 3. quotes: one server-priced quote per intent. Rows are never changed.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.quotes (
  id                 text NOT NULL,
  owner_id           text NOT NULL,
  checkout_intent_id text NOT NULL,
  merchant_id        text NOT NULL,
  -- The variant's catalog_revision at the catalog snapshot (A-7).
  catalog_revision   integer NOT NULL,
  subtotal_cents     bigint NOT NULL,
  discount_cents     bigint NOT NULL,
  tax_cents          bigint NOT NULL,
  shipping_cents     bigint NOT NULL,
  total_cents        bigint NOT NULL,
  currency           text NOT NULL,
  assumptions_code   text NOT NULL,
  created_at         timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  digest             text NOT NULL,
  digest_version     text NOT NULL,
  CONSTRAINT quotes_pkey PRIMARY KEY (id),
  CONSTRAINT quotes_id_owner_key UNIQUE (id, owner_id),
  CONSTRAINT quotes_id_intent_key UNIQUE (id, checkout_intent_id),
  CONSTRAINT quotes_id_intent_owner_key UNIQUE (id, checkout_intent_id, owner_id),
  CONSTRAINT quotes_digest_key UNIQUE (digest),
  -- One quote per intent (A-11).
  CONSTRAINT quotes_checkout_intent_id_key UNIQUE (checkout_intent_id),
  CONSTRAINT quotes_id_format_check CHECK (id ~ '^qt_[0-9a-f]{32}$'),
  CONSTRAINT quotes_catalog_revision_check CHECK (catalog_revision > 0),
  CONSTRAINT quotes_subtotal_check CHECK (subtotal_cents BETWEEN 1 AND 20000000),
  CONSTRAINT quotes_total_check CHECK (total_cents BETWEEN 1 AND 20000000),
  CONSTRAINT quotes_discount_check CHECK (discount_cents = 0),
  CONSTRAINT quotes_tax_check CHECK (tax_cents = 0),
  CONSTRAINT quotes_shipping_check CHECK (shipping_cents = 0),
  CONSTRAINT quotes_total_arithmetic_check
    CHECK (total_cents = subtotal_cents - discount_cents + tax_cents + shipping_cents),
  CONSTRAINT quotes_currency_check CHECK (currency = 'USD'),
  CONSTRAINT quotes_assumptions_code_check
    CHECK (assumptions_code = 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1'),
  CONSTRAINT quotes_lifetime_check CHECK (expires_at = created_at + interval '15 minutes'),
  CONSTRAINT quotes_digest_format_check CHECK (digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT quotes_digest_version_check CHECK (digest_version = 'SAQD-1'),
  -- F-1.
  CONSTRAINT quotes_intent_owner_fkey FOREIGN KEY (checkout_intent_id, owner_id)
    REFERENCES shopaccess.checkout_intents (id, owner_id),
  CONSTRAINT quotes_merchant_fkey FOREIGN KEY (merchant_id)
    REFERENCES shopaccess.merchants (id)
);

-- ---------------------------------------------------------------------------
-- 4. quote_items: the single quoted line and its display snapshot.
-- Rows are never changed.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.quote_items (
  quote_id                text NOT NULL,
  line_number             integer NOT NULL,
  product_id              text NOT NULL,
  variant_id              text NOT NULL,
  quantity                integer NOT NULL,
  unit_amount_cents       bigint NOT NULL,
  line_subtotal_cents     bigint NOT NULL,
  -- Display snapshot, taken from the catalog when the quote was made.
  merchant_display_name   text NOT NULL,
  product_title           text NOT NULL,
  variant_label           text NOT NULL,
  -- 64 hex, over the product description and the variant specifications.
  descriptive_terms_digest text NOT NULL,
  CONSTRAINT quote_items_pkey PRIMARY KEY (quote_id, line_number),
  CONSTRAINT quote_items_line_number_check CHECK (line_number = 1),
  CONSTRAINT quote_items_quantity_check CHECK (quantity BETWEEN 1 AND 10),
  CONSTRAINT quote_items_unit_amount_check CHECK (unit_amount_cents BETWEEN 1 AND 2000000),
  CONSTRAINT quote_items_line_subtotal_check CHECK (line_subtotal_cents = unit_amount_cents * quantity),
  CONSTRAINT quote_items_descriptive_terms_digest_check
    CHECK (descriptive_terms_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT quote_items_quote_fkey FOREIGN KEY (quote_id)
    REFERENCES shopaccess.quotes (id),
  -- F-14.
  CONSTRAINT quote_items_variant_product_fkey FOREIGN KEY (variant_id, product_id)
    REFERENCES shopaccess.merchant_variants (id, product_id)
);

-- ---------------------------------------------------------------------------
-- 5. confirmation_challenges: consent challenge, used from Increment 2.2.
-- The id is supplied by the caller (A-5); it is never authority.
-- No row is ever removed in Increment 2.1 (A-8).
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.confirmation_challenges (
  id                 text NOT NULL,
  owner_id           text NOT NULL,
  checkout_intent_id text NOT NULL,
  quote_id           text NOT NULL,
  quote_digest       text NOT NULL,
  -- SHA-256 of the nonce. The nonce itself is never stored.
  nonce_digest       text NOT NULL,
  nonce_key_purpose  text NOT NULL DEFAULT 'confirmation_nonce',
  nonce_key_version  smallint NOT NULL,
  summary            jsonb NOT NULL,
  status             text NOT NULL,
  issued_at          timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  superseded_at      timestamptz,
  expired_marked_at  timestamptz,
  CONSTRAINT confirmation_challenges_pkey PRIMARY KEY (id),
  CONSTRAINT confirmation_challenges_id_intent_key UNIQUE (id, checkout_intent_id),
  CONSTRAINT confirmation_challenges_id_intent_status_key UNIQUE (id, checkout_intent_id, status),
  CONSTRAINT confirmation_challenges_nonce_digest_key UNIQUE (nonce_digest),
  CONSTRAINT confirmation_challenges_id_format_check CHECK (id ~ '^cf_[0-9a-f]{32}$'),
  CONSTRAINT confirmation_challenges_quote_digest_format_check CHECK (quote_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT confirmation_challenges_nonce_digest_format_check CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT confirmation_challenges_nonce_key_purpose_check
    CHECK (nonce_key_purpose = 'confirmation_nonce'),
  CONSTRAINT confirmation_challenges_summary_size_check
    CHECK (octet_length(summary::text) <= 1024),
  CONSTRAINT confirmation_challenges_status_check
    CHECK (status IN ('ACTIVE', 'CONSUMED', 'SUPERSEDED', 'EXPIRED')),
  CONSTRAINT confirmation_challenges_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT confirmation_challenges_consumed_at_check
    CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL)),
  CONSTRAINT confirmation_challenges_superseded_at_check
    CHECK ((status = 'SUPERSEDED') = (superseded_at IS NOT NULL)),
  CONSTRAINT confirmation_challenges_expired_marked_at_check
    CHECK ((status = 'EXPIRED') = (expired_marked_at IS NOT NULL)),
  CONSTRAINT confirmation_challenges_consumed_window_check
    CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at)),
  -- F-3.
  CONSTRAINT confirmation_challenges_quote_intent_owner_fkey
    FOREIGN KEY (quote_id, checkout_intent_id, owner_id)
    REFERENCES shopaccess.quotes (id, checkout_intent_id, owner_id),
  CONSTRAINT confirmation_challenges_nonce_key_fkey
    FOREIGN KEY (nonce_key_purpose, nonce_key_version)
    REFERENCES shopaccess.server_key_versions (purpose, key_version)
);

-- ---------------------------------------------------------------------------
-- 6. checkout_transitions: state-change history. Exactly the eleven columns of
-- 19.2. No observation or operation column exists. Rows are never changed.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.checkout_transitions (
  checkout_intent_id text NOT NULL,
  to_version         integer NOT NULL,
  from_version       integer NOT NULL,
  event_id           text NOT NULL,
  event_type         text NOT NULL,
  actor              text NOT NULL,
  entry_point        text NOT NULL,
  from_state         text NOT NULL,
  to_state           text NOT NULL,
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL,
  CONSTRAINT checkout_transitions_pkey PRIMARY KEY (checkout_intent_id, to_version),
  CONSTRAINT checkout_transitions_event_id_key UNIQUE (event_id),
  CONSTRAINT checkout_transitions_version_step_check CHECK (to_version = from_version + 1),
  CONSTRAINT checkout_transitions_event_type_check
    CHECK (event_type IN ('QUOTE_ISSUED', 'SHOPPER_CONFIRMED', 'SHOPPER_CANCELED', 'SUPERSEDED')),
  CONSTRAINT checkout_transitions_actor_check CHECK (actor IN ('shopper', 'server')),
  CONSTRAINT checkout_transitions_entry_point_check
    CHECK (entry_point IN ('start_checkout', 'cancel_checkout', 'consume_challenge')),
  -- DRAFT is never a stored intent state; it appears only as the origin of the first transition.
  CONSTRAINT checkout_transitions_from_state_check
    CHECK (from_state IN ('DRAFT', 'QUOTED', 'USER_CONFIRMED', 'SUPERSEDED', 'CANCELED_LOCAL', 'EXPIRED')),
  CONSTRAINT checkout_transitions_to_state_check
    CHECK (to_state IN ('QUOTED', 'USER_CONFIRMED', 'SUPERSEDED', 'CANCELED_LOCAL', 'EXPIRED')),
  CONSTRAINT checkout_transitions_recorded_at_check CHECK (recorded_at >= occurred_at),
  -- Exactly the six legal combinations T1 to T6 (A-10).
  CONSTRAINT checkout_transitions_legal_combination_check
    CHECK (
      -- T1
      (event_type = 'QUOTE_ISSUED' AND actor = 'server' AND entry_point = 'start_checkout'
       AND from_state = 'DRAFT' AND to_state = 'QUOTED'
       AND from_version = 1 AND to_version = 2)
      OR
      -- T2
      (event_type = 'SHOPPER_CONFIRMED' AND actor = 'shopper' AND entry_point = 'consume_challenge'
       AND from_state = 'QUOTED' AND to_state = 'USER_CONFIRMED'
       AND from_version >= 2)
      OR
      -- T3 and T4
      (event_type = 'SHOPPER_CANCELED' AND actor = 'shopper' AND entry_point = 'cancel_checkout'
       AND from_state IN ('QUOTED', 'USER_CONFIRMED') AND to_state = 'CANCELED_LOCAL'
       AND from_version >= 2)
      OR
      -- T5 and T6
      (event_type = 'SUPERSEDED' AND actor = 'server' AND entry_point = 'start_checkout'
       AND from_state IN ('QUOTED', 'USER_CONFIRMED') AND to_state = 'SUPERSEDED'
       AND from_version >= 2)
    ),
  -- Immediate and not deferrable: the intent row always exists first (19.3).
  CONSTRAINT checkout_transitions_intent_fkey FOREIGN KEY (checkout_intent_id)
    REFERENCES shopaccess.checkout_intents (id)
);

-- ---------------------------------------------------------------------------
-- Self-referencing and forward keys on checkout_intents.
-- R-B and F-4 are the only deferrable keys in the schema.
-- ---------------------------------------------------------------------------
ALTER TABLE shopaccess.checkout_intents
  ADD CONSTRAINT checkout_intents_predecessor_group_fkey
  FOREIGN KEY (replaces_intent_id, purchase_group_id)
  REFERENCES shopaccess.checkout_intents (id, purchase_group_id)
  NOT DEFERRABLE;

-- F-2.
ALTER TABLE shopaccess.checkout_intents
  ADD CONSTRAINT checkout_intents_successor_owner_fkey
  FOREIGN KEY (superseded_by_intent_id, owner_id)
  REFERENCES shopaccess.checkout_intents (id, owner_id)
  NOT DEFERRABLE;

-- R-A: the successor pointer names the one row that replaces this one.
ALTER TABLE shopaccess.checkout_intents
  ADD CONSTRAINT checkout_intents_successor_reciprocal_fkey
  FOREIGN KEY (superseded_by_intent_id, id)
  REFERENCES shopaccess.checkout_intents (id, replaces_intent_id)
  NOT DEFERRABLE;

-- R-B (deferred check 1 of 6): a successor's predecessor points back at it.
ALTER TABLE shopaccess.checkout_intents
  ADD CONSTRAINT checkout_intents_predecessor_reciprocal_fkey
  FOREIGN KEY (replaces_intent_id, id)
  REFERENCES shopaccess.checkout_intents (id, superseded_by_intent_id)
  DEFERRABLE INITIALLY DEFERRED;

-- F-4 (deferred check 2 of 6): the intent's quote exists and belongs to it.
ALTER TABLE shopaccess.checkout_intents
  ADD CONSTRAINT checkout_intents_current_quote_fkey
  FOREIGN KEY (current_quote_id, id)
  REFERENCES shopaccess.quotes (id, checkout_intent_id)
  DEFERRABLE INITIALLY DEFERRED;

-- F-5.
ALTER TABLE shopaccess.checkout_intents
  ADD CONSTRAINT checkout_intents_confirmation_fkey
  FOREIGN KEY (confirmation_id, id, confirmation_status)
  REFERENCES shopaccess.confirmation_challenges (id, checkout_intent_id, status)
  NOT DEFERRABLE;

-- ---------------------------------------------------------------------------
-- Partial unique indexes.
-- ---------------------------------------------------------------------------
-- At most one successor per intent.
CREATE UNIQUE INDEX checkout_intents_one_successor_idx
  ON shopaccess.checkout_intents (replaces_intent_id) WHERE replaces_intent_id IS NOT NULL;

-- Exactly one root per purchase group.
CREATE UNIQUE INDEX checkout_intents_one_root_idx
  ON shopaccess.checkout_intents (purchase_group_id) WHERE replaces_intent_id IS NULL;

-- At most one ACTIVE and at most one CONSUMED challenge per quote.
CREATE UNIQUE INDEX confirmation_challenges_one_active_idx
  ON shopaccess.confirmation_challenges (quote_id) WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX confirmation_challenges_one_consumed_idx
  ON shopaccess.confirmation_challenges (quote_id) WHERE status = 'CONSUMED';

CREATE INDEX quotes_expires_at_idx
ON shopaccess.quotes (expires_at);

CREATE INDEX confirmation_challenges_active_expires_at_idx
ON shopaccess.confirmation_challenges (expires_at)
WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Trigger functions. All are in schema shopaccess, owned by the migration role,
-- run with the invoker's rights and a fixed search path, and are executable by
-- no role through any privilege statement in this file.
-- ---------------------------------------------------------------------------

-- checkout_intents: the insert rule and the update rules of 19.3.
CREATE FUNCTION shopaccess.checkout_intents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_challenge_status text;
  v_challenge_intent text;
  v_challenge_owner  text;
  v_challenge_quote  text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'QUOTED' OR NEW.row_version IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'a checkout intent is inserted as QUOTED at row version 2' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.superseded_by_intent_id IS NOT NULL
       OR NEW.confirmation_id IS NOT NULL
       OR NEW.confirmation_status IS NOT NULL THEN
      RAISE EXCEPTION 'a checkout intent is inserted with no successor and no confirmation' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.current_quote_id IS NULL THEN
      RAISE EXCEPTION 'a checkout intent is inserted with its quote pointer set' USING ERRCODE = 'restrict_violation';
    END IF;
    -- A root has no predecessor. A replacement names a row that exists already.
    IF NEW.replaces_intent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM shopaccess.checkout_intents i WHERE i.id = NEW.replaces_intent_id
    ) THEN
      RAISE EXCEPTION 'a replacement names a checkout intent that already exists' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE.
  IF OLD.state IN ('SUPERSEDED', 'CANCELED_LOCAL', 'EXPIRED') THEN
    RAISE EXCEPTION 'a checkout intent in a terminal state accepts no update' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.purchase_group_id IS DISTINCT FROM OLD.purchase_group_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.replaces_intent_id IS DISTINCT FROM OLD.replaces_intent_id
     OR NEW.current_quote_id IS DISTINCT FROM OLD.current_quote_id THEN
    RAISE EXCEPTION 'checkout intent identity, ancestry and quote pointer are immutable' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.row_version IS DISTINCT FROM OLD.row_version + 1 THEN
    RAISE EXCEPTION 'row_version rises by exactly one per update' USING ERRCODE = 'restrict_violation';
  END IF;

  -- Legal edges (A-9). An update that keeps the state is not one of them.
  IF NOT (
    (OLD.state = 'QUOTED' AND NEW.state IN ('USER_CONFIRMED', 'SUPERSEDED', 'CANCELED_LOCAL'))
    OR (OLD.state = 'USER_CONFIRMED' AND NEW.state IN ('SUPERSEDED', 'CANCELED_LOCAL'))
  ) THEN
    RAISE EXCEPTION 'illegal checkout intent state change' USING ERRCODE = 'restrict_violation';
  END IF;

  -- The successor pointer is set once, only with the change to SUPERSEDED.
  IF NEW.superseded_by_intent_id IS DISTINCT FROM OLD.superseded_by_intent_id
     AND NOT (
       OLD.superseded_by_intent_id IS NULL
       AND NEW.superseded_by_intent_id IS NOT NULL
       AND NEW.state = 'SUPERSEDED'
     ) THEN
    RAISE EXCEPTION 'the successor pointer is set once, only with the change to SUPERSEDED' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.state = 'USER_CONFIRMED' THEN
    -- The confirmation pointer is set once, only here.
    IF OLD.confirmation_id IS NOT NULL
       OR OLD.confirmation_status IS NOT NULL
       OR NEW.confirmation_id IS NULL
       OR NEW.confirmation_status IS DISTINCT FROM 'CONSUMED' THEN
      RAISE EXCEPTION 'the confirmation pointer is set once, with the change to USER_CONFIRMED' USING ERRCODE = 'restrict_violation';
    END IF;
    -- A consumed challenge of this intent, this owner and this quote.
    SELECT c.status, c.checkout_intent_id, c.owner_id, c.quote_id
      INTO v_challenge_status, v_challenge_intent, v_challenge_owner, v_challenge_quote
      FROM shopaccess.confirmation_challenges c
     WHERE c.id = NEW.confirmation_id;
    IF NOT FOUND
       OR v_challenge_status IS DISTINCT FROM 'CONSUMED'
       OR v_challenge_intent IS DISTINCT FROM NEW.id
       OR v_challenge_owner IS DISTINCT FROM NEW.owner_id
       OR v_challenge_quote IS DISTINCT FROM NEW.current_quote_id THEN
      RAISE EXCEPTION 'the confirmation must be a consumed challenge of this intent, owner and quote' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id
       OR NEW.confirmation_status IS DISTINCT FROM OLD.confirmation_status THEN
      RAISE EXCEPTION 'the confirmation pointer changes only with the change to USER_CONFIRMED' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION shopaccess.checkout_intents_guard() FROM PUBLIC;

-- confirmation_challenges: inserted ACTIVE; may leave ACTIVE once; nothing else changes.
CREATE FUNCTION shopaccess.confirmation_challenges_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'ACTIVE'
       OR NEW.consumed_at IS NOT NULL
       OR NEW.superseded_at IS NOT NULL
       OR NEW.expired_marked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a confirmation challenge is inserted as ACTIVE' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: only from ACTIVE to one terminal status. The table checks tie each
  -- terminal timestamp to its status, so exactly the matching one is set.
  IF OLD.status IS DISTINCT FROM 'ACTIVE' OR NEW.status NOT IN ('CONSUMED', 'SUPERSEDED', 'EXPIRED') THEN
    RAISE EXCEPTION 'illegal confirmation challenge status change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.checkout_intent_id IS DISTINCT FROM OLD.checkout_intent_id
     OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.quote_digest IS DISTINCT FROM OLD.quote_digest
     OR NEW.nonce_digest IS DISTINCT FROM OLD.nonce_digest
     OR NEW.nonce_key_purpose IS DISTINCT FROM OLD.nonce_key_purpose
     OR NEW.nonce_key_version IS DISTINCT FROM OLD.nonce_key_version
     OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'confirmation challenge binding columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION shopaccess.confirmation_challenges_guard() FROM PUBLIC;

-- Deferred history validation, H1 to H4, for one intent. Used by both history
-- constraint triggers. It only reads, and takes no lock.
CREATE FUNCTION shopaccess.checkout_history_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_intent_id text;
  v_version   integer;
  v_state     text;
  v_count     bigint;
  v_min       integer;
  v_max       integer;
  v_reason    text;
BEGIN
  IF TG_TABLE_NAME = 'checkout_intents' THEN
    v_intent_id := NEW.id;
  ELSE
    v_intent_id := NEW.checkout_intent_id;
  END IF;

  SELECT i.row_version, i.state INTO v_version, v_state
    FROM shopaccess.checkout_intents i
   WHERE i.id = v_intent_id;

  IF NOT FOUND THEN
    v_reason := 'the checkout intent does not exist';
  ELSE
    SELECT count(*), min(t.to_version), max(t.to_version)
      INTO v_count, v_min, v_max
      FROM shopaccess.checkout_transitions t
     WHERE t.checkout_intent_id = v_intent_id;

    IF v_count IS DISTINCT FROM (v_version - 1)::bigint
       OR v_min IS DISTINCT FROM 2
       OR v_max IS DISTINCT FROM v_version THEN
      -- H1: exactly v - 1 rows, with to_version 2 through v.
      v_reason := 'H1: the transitions do not run from version 2 to the row version without a gap';
    ELSIF NOT EXISTS (
      SELECT 1
        FROM shopaccess.checkout_transitions t
       WHERE t.checkout_intent_id = v_intent_id
         AND t.to_version = 2
         AND t.from_version = 1
         AND t.event_type = 'QUOTE_ISSUED'
         AND t.actor = 'server'
         AND t.entry_point = 'start_checkout'
         AND t.from_state = 'DRAFT'
         AND t.to_state = 'QUOTED'
    ) THEN
      -- H2: the row at to_version 2 is T1.
      v_reason := 'H2: the first transition is not the initial quote transition';
    ELSIF EXISTS (
      SELECT 1
        FROM (
          SELECT t.to_version,
                 t.from_version,
                 t.from_state,
                 lag(t.to_state) OVER (ORDER BY t.to_version) AS previous_to_state,
                 lag(t.to_version) OVER (ORDER BY t.to_version) AS previous_to_version
            FROM shopaccess.checkout_transitions t
           WHERE t.checkout_intent_id = v_intent_id
        ) s
       WHERE s.to_version > 2
         AND (s.from_state IS DISTINCT FROM s.previous_to_state
              OR s.from_version IS DISTINCT FROM s.previous_to_version)
    ) THEN
      -- H3: each later row continues from the previous one.
      v_reason := 'H3: a transition does not continue from the one before it';
    ELSIF NOT EXISTS (
      SELECT 1
        FROM shopaccess.checkout_transitions t
       WHERE t.checkout_intent_id = v_intent_id
         AND t.to_version = v_version
         AND t.to_state = v_state
    ) THEN
      -- H4: the last row ends in the stored state.
      v_reason := 'H4: the last transition does not end in the stored state';
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'checkout history is not valid: %', v_reason
      USING ERRCODE = 'check_violation',
            CONSTRAINT = TG_NAME,
            TABLE = TG_TABLE_NAME,
            SCHEMA = TG_TABLE_SCHEMA;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION shopaccess.checkout_history_check() FROM PUBLIC;

-- Deferred quote validation, Q1 and Q2, for one quote. Used by both quote
-- constraint triggers. It only reads, and takes no lock.
CREATE FUNCTION shopaccess.quote_item_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_quote_id      text;
  v_subtotal      bigint;
  v_count         bigint;
  v_line_number   integer;
  v_line_subtotal bigint;
  v_reason        text;
BEGIN
  IF TG_TABLE_NAME = 'quotes' THEN
    v_quote_id := NEW.id;
  ELSE
    v_quote_id := NEW.quote_id;
  END IF;

  SELECT q.subtotal_cents INTO v_subtotal
    FROM shopaccess.quotes q
   WHERE q.id = v_quote_id;

  IF NOT FOUND THEN
    v_reason := 'the quote does not exist';
  ELSE
    SELECT count(*), min(qi.line_number), min(qi.line_subtotal_cents)
      INTO v_count, v_line_number, v_line_subtotal
      FROM shopaccess.quote_items qi
     WHERE qi.quote_id = v_quote_id;

    IF v_count IS DISTINCT FROM 1::bigint OR v_line_number IS DISTINCT FROM 1 THEN
      -- Q1: exactly one item, with line number 1.
      v_reason := 'Q1: the quote does not have exactly one item with line number 1';
    ELSIF v_line_subtotal IS DISTINCT FROM v_subtotal THEN
      -- Q2: the item subtotal equals the quote subtotal.
      v_reason := 'Q2: the item subtotal does not equal the quote subtotal';
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'quote and item are not consistent: %', v_reason
      USING ERRCODE = 'check_violation',
            CONSTRAINT = TG_NAME,
            TABLE = TG_TABLE_NAME,
            SCHEMA = TG_TABLE_SCHEMA;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION shopaccess.quote_item_check() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Triggers on tables 1 to 6.
-- ---------------------------------------------------------------------------

-- purchase_groups: insert-only.
CREATE TRIGGER purchase_groups_immutable BEFORE UPDATE OR DELETE ON shopaccess.purchase_groups
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER purchase_groups_no_truncate BEFORE TRUNCATE ON shopaccess.purchase_groups
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

-- checkout_intents: guarded insert and update; never removed.
CREATE TRIGGER checkout_intents_guard BEFORE INSERT OR UPDATE ON shopaccess.checkout_intents
  FOR EACH ROW EXECUTE FUNCTION shopaccess.checkout_intents_guard();
CREATE TRIGGER checkout_intents_no_delete BEFORE DELETE ON shopaccess.checkout_intents
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER checkout_intents_no_truncate BEFORE TRUNCATE ON shopaccess.checkout_intents
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

-- quotes and quote_items: insert-only.
CREATE TRIGGER quotes_immutable BEFORE UPDATE OR DELETE ON shopaccess.quotes
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER quotes_no_truncate BEFORE TRUNCATE ON shopaccess.quotes
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

CREATE TRIGGER quote_items_immutable BEFORE UPDATE OR DELETE ON shopaccess.quote_items
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER quote_items_no_truncate BEFORE TRUNCATE ON shopaccess.quote_items
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

-- confirmation_challenges: guarded insert and update; never removed, in any status.
CREATE TRIGGER confirmation_challenges_guard BEFORE INSERT OR UPDATE ON shopaccess.confirmation_challenges
  FOR EACH ROW EXECUTE FUNCTION shopaccess.confirmation_challenges_guard();
CREATE TRIGGER confirmation_challenges_no_delete BEFORE DELETE ON shopaccess.confirmation_challenges
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER confirmation_challenges_no_truncate BEFORE TRUNCATE ON shopaccess.confirmation_challenges
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

-- checkout_transitions: append-only.
CREATE TRIGGER checkout_transitions_append_only BEFORE UPDATE OR DELETE ON shopaccess.checkout_transitions
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER checkout_transitions_no_truncate BEFORE TRUNCATE ON shopaccess.checkout_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

-- ---------------------------------------------------------------------------
-- Deferred constraint triggers (deferred checks 3 to 6 of 6). Each is
-- deferrable and initially deferred, per row. The functions of Increment 2.1
-- set all six deferred checks to immediate before they return.
-- ---------------------------------------------------------------------------
CREATE CONSTRAINT TRIGGER checkout_intents_history_check
  AFTER INSERT OR UPDATE ON shopaccess.checkout_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION shopaccess.checkout_history_check();

CREATE CONSTRAINT TRIGGER checkout_transitions_history_check
  AFTER INSERT ON shopaccess.checkout_transitions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION shopaccess.checkout_history_check();

CREATE CONSTRAINT TRIGGER quotes_item_check
  AFTER INSERT ON shopaccess.quotes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION shopaccess.quote_item_check();

CREATE CONSTRAINT TRIGGER quote_items_quote_check
  AFTER INSERT ON shopaccess.quote_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION shopaccess.quote_item_check();

-- ---------------------------------------------------------------------------
-- 7. owner_request_windows: one request counter per owner (A-13).
-- The limit of 30 calls is also a table bound. No write-shape trigger.
-- ---------------------------------------------------------------------------
CREATE TABLE shopaccess.owner_request_windows (
  owner_id          text NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_calls      integer NOT NULL,
  window_throttled  bigint NOT NULL,
  total_throttled   bigint NOT NULL,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT owner_request_windows_pkey PRIMARY KEY (owner_id),
  CONSTRAINT owner_request_windows_window_calls_check CHECK (window_calls BETWEEN 0 AND 30),
  CONSTRAINT owner_request_windows_window_throttled_check CHECK (window_throttled >= 0),
  CONSTRAINT owner_request_windows_total_throttled_check CHECK (total_throttled >= window_throttled),
  CONSTRAINT owner_request_windows_updated_at_check CHECK (updated_at >= window_started_at),
  CONSTRAINT owner_request_windows_owner_fkey FOREIGN KEY (owner_id)
    REFERENCES shopaccess.checkout_owners (id)
);

-- owner_request_windows: the owner never changes.
CREATE FUNCTION shopaccess.owner_request_windows_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'the owner of a request window is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION shopaccess.owner_request_windows_guard() FROM PUBLIC;

CREATE TRIGGER owner_request_windows_guard BEFORE UPDATE ON shopaccess.owner_request_windows
  FOR EACH ROW EXECUTE FUNCTION shopaccess.owner_request_windows_guard();
CREATE TRIGGER owner_request_windows_no_delete BEFORE DELETE ON shopaccess.owner_request_windows
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER owner_request_windows_no_truncate BEFORE TRUNCATE ON shopaccess.owner_request_windows
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();
