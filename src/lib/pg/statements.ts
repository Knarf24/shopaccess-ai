/**
 * Reviewed statement catalogue for the PostgreSQL 17 foundation (Milestone 002,
 * Increment 1). NEVER EXECUTED: no statement here has been run by PostgreSQL.
 *
 * This is the ONLY module under `src/lib/pg` that may contain SQL text, and the
 * only module under `src`, besides the legacy `src/lib/db/queries.ts`, that the
 * SQL-01 test allows to. The library and the database integration tests both
 * import these definitions; there is no second copy.
 *
 * Rules, each checked by tests/unit/pg-static.test.ts:
 *  - every statement is a plain string literal: no template literal, no
 *    concatenation, no function that builds SQL, no import;
 *  - values travel only as numbered placeholders, numbered from $1 without gaps;
 *  - no identifier is ever supplied at run time;
 *  - every object reference is schema-qualified;
 *  - the catalogue objects are frozen.
 */

/** Calls made by the web process. One statement each, one result row each. */
export const SESSION_STATEMENTS = Object.freeze({
  /** Parameters: session id, key version, token digest. */
  admitSession: "SELECT result, absolute_expires_at, idle_expires_at FROM shopaccess_api.admit_session($1, $2, $3)",
  /** Parameters: key version, token digest. */
  authorizeSession:
    "SELECT result, session_id, absolute_expires_at, idle_expires_at, key_status FROM shopaccess_api.authorize_session($1, $2)",
  /** Parameters: key version, token digest, new key version, new token digest. */
  rotateSession:
    "SELECT result, session_id, absolute_expires_at, idle_expires_at FROM shopaccess_api.rotate_session($1, $2, $3, $4)",
  /** Parameters: key version, token digest. */
  revokeSession: "SELECT result FROM shopaccess_api.revoke_session($1, $2)",
  /** Parameter: purpose. */
  readKeyVersions: "SELECT purpose, key_version, status, check_value FROM shopaccess.server_key_versions WHERE purpose = $1",
} as const);

/**
 * Increment 2.1 and 2.2 checkout calls made by the web process (migrations 0008
 * and 0009). One statement each. Each mutating call is sent as one statement in its own
 * transaction and is never wrapped (specification 19.5). The first two
 * parameters are always the session credential: key version, token digest.
 */
export const CHECKOUT_STATEMENTS = Object.freeze({
  /** Parameters: key version, token digest, product id, variant id, quantity, replaced intent id or null. */
  startCheckout: "SELECT result, intent_id, quote_id, quote_expires_at FROM shopaccess_api.start_checkout($1, $2, $3, $4, $5, $6)",
  /** Parameters: key version, token digest, intent id. */
  cancelCheckout: "SELECT result FROM shopaccess_api.cancel_checkout($1, $2, $3)",
  /**
   * Parameters: key version, token digest, intent id. Always exactly one row: the 33 columns of Increment 2.1 and,
   * since migration 0009, eight columns for the quote's ACTIVE confirmation challenge.
   */
  readCheckout:
    "SELECT result, owner_id, intent_id, purchase_group_id, stored_state, row_version, effective_status, replaces_intent_id, superseded_by_intent_id, intent_created_at, intent_updated_at, quote_id, merchant_id, merchant_display_name, product_id, product_title, variant_id, variant_label, quantity, unit_amount_cents, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, currency, assumptions_code, catalog_revision, quote_digest, quote_created_at, quote_expires_at, quote_stale, database_time, challenge_id, challenge_quote_digest, challenge_nonce_key_version, challenge_nonce_digest, challenge_summary, challenge_issued_at, challenge_expires_at, challenge_usable FROM shopaccess_api.read_checkout($1, $2, $3)",
  /** Parameters: key version, token digest. At most 100 rows; none when not authorized. */
  listOwnerCheckouts:
    "SELECT intent_id, purchase_group_id, stored_state, effective_status, intent_created_at, quote_expires_at FROM shopaccess_api.list_owner_checkouts($1, $2)",
  /**
   * Increment 2.2 (migration 0009). Parameters: key version, token digest, intent id, challenge id, nonce key
   * version, nonce digest. The nonce itself is never sent here.
   */
  issueChallenge:
    "SELECT result, challenge_id, quote_digest, nonce_key_version, nonce_digest, summary, expires_at FROM shopaccess_api.issue_challenge($1, $2, $3, $4, $5, $6)",
  /** Increment 2.2 (migration 0009). Parameters: key version, token digest, challenge id, nonce, quote id, quote digest. */
  consumeChallenge: "SELECT result, intent_id FROM shopaccess_api.consume_challenge($1, $2, $3, $4, $5, $6)",
} as const);

/**
 * Increment 2.3 statements of the web process that are not entry-point calls. NEVER EXECUTED by PostgreSQL.
 *
 * readCatalog: one joined read of the three catalog tables, one row per variant, in a fixed order. One statement,
 * so one snapshot. No parameters.
 *
 * readinessProbe: one row describing the connected role, as the catalog functions report it. It names no object in
 * its text: the lists and the privilege names are bound values. Parameters: required function signatures,
 * prohibited function signatures, readable tables, prohibited tables, schemas (five text arrays); then eight
 * privilege names or comma-separated privilege lists, in the order the statement uses them.
 */
export const APPLICATION_STATEMENTS = Object.freeze({
  readCatalog:
    "SELECT m.id AS merchant_id, m.display_name AS merchant_display_name, m.is_simulated_sandbox AS merchant_simulated_sandbox, p.id AS product_id, p.title AS product_title, p.description AS product_description, p.image_path AS product_image_path, p.catalog_revision AS product_catalog_revision, v.id AS variant_id, v.label AS variant_label, v.unit_amount_cents, v.currency, v.max_quantity_per_order, v.availability, v.specs, v.catalog_revision AS variant_catalog_revision FROM shopaccess.merchant_variants v JOIN shopaccess.merchant_products p ON p.id = v.product_id JOIN shopaccess.merchants m ON m.id = p.merchant_id ORDER BY p.id, v.id",
  readinessProbe:
    "SELECT session_user::text AS session_user_name, current_user::text AS current_user_name, (SELECT count(*)::integer FROM pg_catalog.pg_roles r WHERE r.rolname = session_user AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls) AS plain_role_rows, (SELECT count(*)::integer FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles r ON r.oid = a.member WHERE r.rolname = session_user) AS membership_rows, (SELECT count(*)::integer FROM pg_catalog.unnest($1::text[]) AS item WHERE pg_catalog.has_function_privilege(session_user, pg_catalog.to_regprocedure(item)::oid, $6::text) IS TRUE) AS required_functions_executable, (SELECT count(*)::integer FROM pg_catalog.unnest($2::text[]) AS item WHERE pg_catalog.to_regprocedure(item) IS NOT NULL) AS prohibited_functions_present, (SELECT count(*)::integer FROM pg_catalog.unnest($2::text[]) AS item WHERE pg_catalog.has_function_privilege(session_user, pg_catalog.to_regprocedure(item)::oid, $6::text) IS TRUE) AS prohibited_functions_executable, (SELECT count(*)::integer FROM pg_catalog.unnest($3::text[]) AS item WHERE pg_catalog.has_table_privilege(session_user, pg_catalog.to_regclass(item)::oid, $7::text) IS TRUE) AS readable_tables_readable, (SELECT count(*)::integer FROM pg_catalog.unnest($3::text[]) AS item WHERE pg_catalog.has_table_privilege(session_user, pg_catalog.to_regclass(item)::oid, $8::text) IS TRUE) AS readable_tables_writable, (SELECT count(*)::integer FROM pg_catalog.unnest($4::text[]) AS item WHERE pg_catalog.to_regclass(item) IS NOT NULL) AS prohibited_tables_present, (SELECT count(*)::integer FROM pg_catalog.unnest($4::text[]) AS item WHERE pg_catalog.has_table_privilege(session_user, pg_catalog.to_regclass(item)::oid, $9::text) IS TRUE OR pg_catalog.has_any_column_privilege(session_user, pg_catalog.to_regclass(item)::oid, $10::text) IS TRUE) AS prohibited_tables_reachable, (SELECT count(*)::integer FROM pg_catalog.unnest($5::text[]) AS item WHERE pg_catalog.has_schema_privilege(session_user, item, $11::text) IS TRUE) AS schemas_usable, (SELECT count(*)::integer FROM pg_catalog.unnest($5::text[]) AS item WHERE pg_catalog.has_schema_privilege(session_user, item, $12::text) IS TRUE) AS schemas_creatable, pg_catalog.has_database_privilege(session_user, pg_catalog.current_database()::text, $13::text) AS database_elevated",
} as const);

/** Calls made by a named operator login. */
export const OPERATOR_STATEMENTS = Object.freeze({
  /** Parameters: purpose, key version, check value. */
  activateKeyVersion: "SELECT result, previous_active_version FROM shopaccess_api.activate_key_version($1, $2, $3)",
  /** Parameters: purpose, key version. */
  revokeKeyVersion: "SELECT result, sessions_revoked, was_active FROM shopaccess_api.revoke_key_version($1, $2)",
} as const);

/** Statements of the migration runner. All run on one pinned connection. */
export const MIGRATION_STATEMENTS = Object.freeze({
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",
  /** Transaction-scoped lock so two runners cannot interleave. */
  lockMigrations: "SELECT pg_catalog.pg_advisory_xact_lock(7342019551)",
  /** One row with a boolean column `present`. */
  ledgerExists: "SELECT pg_catalog.to_regclass('shopaccess.schema_migrations') IS NOT NULL AS present",
  readLedger: "SELECT version, checksum FROM shopaccess.schema_migrations",
  /** Parameters: version, checksum. */
  recordMigration:
    "INSERT INTO shopaccess.schema_migrations (version, checksum, applied_at) VALUES ($1, $2, pg_catalog.clock_timestamp())",
} as const);
