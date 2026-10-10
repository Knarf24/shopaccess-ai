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
