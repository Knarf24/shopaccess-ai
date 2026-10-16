import { err, ok, type Result } from "../shared/result";
import type { PgQueryable } from "./client";
import { loadKeyState, type ConfiguredKeyRings } from "./key-ring";
import { APPLICATION_STATEMENTS } from "./statements";

/**
 * Readiness of a PostgreSQL connection for the web process (specification 19.19, decision D8).
 *
 * NEVER RUN AGAINST A DATABASE. A pool carries the approved timeouts and proves nothing about the role it connects
 * as. Before the application serves anything in PostgreSQL mode it sends one fixed statement from the reviewed
 * catalogue and requires every value of its one row to be exactly as listed here; then it requires the configured
 * key rings to agree with the database's key versions.
 *
 * What this cannot establish: the web role cannot read the migration ledger, so the checksums of the applied
 * migrations are not verified here. That stays with whoever applies migrations.
 */

/** The only role the application may be connected as. */
export const READINESS_ROLE = "shopaccess_web";

/** The ten entry points the web role calls, by exact signature (migrations 0006, 0008 and 0009). */
export const REQUIRED_FUNCTIONS: readonly string[] = Object.freeze([
  "shopaccess_api.admit_session(text, smallint, text)",
  "shopaccess_api.authorize_session(smallint, text)",
  "shopaccess_api.rotate_session(smallint, text, smallint, text)",
  "shopaccess_api.revoke_session(smallint, text)",
  "shopaccess_api.start_checkout(smallint, text, text, text, integer, text)",
  "shopaccess_api.cancel_checkout(smallint, text, text)",
  "shopaccess_api.read_checkout(smallint, text, text)",
  "shopaccess_api.list_owner_checkouts(smallint, text)",
  "shopaccess_api.issue_challenge(smallint, text, text, text, smallint, text)",
  "shopaccess_api.consume_challenge(smallint, text, text, text, text, text)",
]);

/** The operator functions and the internal helpers: they must exist, and the web role must not be able to call one. */
export const PROHIBITED_FUNCTIONS: readonly string[] = Object.freeze([
  "shopaccess_api.activate_key_version(text, smallint, text)",
  "shopaccess_api.revoke_key_version(text, smallint)",
  "shopaccess_api.session_is_live(timestamptz, timestamptz, timestamptz, text, timestamptz)",
  "shopaccess_api.require_read_committed(integer)",
  "shopaccess_api.owner_window_decision(timestamptz, integer, timestamptz)",
  "shopaccess_api.checkout_transition(text, integer, text, text, text, text, text, text, text, text, text)",
  "shopaccess_api.quote_digest_saqd1(text, text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, text, text, timestamptz, timestamptz)",
  "shopaccess_api.descriptive_terms_digest(text, jsonb)",
  "shopaccess_api.quote_material_change(bigint, text, integer, text, text, text, text, text, text, bigint, text, text, integer, text, text, text, text, text, text, jsonb)",
]);

/** The four tables the web role reads directly, and may not write. */
export const READABLE_TABLES: readonly string[] = Object.freeze([
  "shopaccess.merchants",
  "shopaccess.merchant_products",
  "shopaccess.merchant_variants",
  "shopaccess.server_key_versions",
]);

/** Tables the web role reaches only through the entry points: no privilege of any kind, on the table or a column. */
export const PROHIBITED_TABLES: readonly string[] = Object.freeze([
  "shopaccess.schema_migrations",
  "shopaccess.session_admission_guard",
  "shopaccess.checkout_owners",
  "shopaccess.shopper_sessions",
  "shopaccess.audit_events",
  "shopaccess.purchase_groups",
  "shopaccess.checkout_intents",
  "shopaccess.quotes",
  "shopaccess.quote_items",
  "shopaccess.confirmation_challenges",
  "shopaccess.checkout_transitions",
  "shopaccess.owner_request_windows",
]);

export const READINESS_SCHEMAS: readonly string[] = Object.freeze(["shopaccess", "shopaccess_api"]);

// Privilege names, bound as values. Each is its own constant.
const PRIVILEGE_EXECUTE = "EXECUTE";
const PRIVILEGE_READ = "SELECT";
const PRIVILEGES_WRITE = "INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER";
const PRIVILEGES_ANY_TABLE = "SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER";
const PRIVILEGES_ANY_COLUMN = "SELECT, INSERT, UPDATE, REFERENCES";
const PRIVILEGE_USAGE = "USAGE";
const PRIVILEGE_CREATE = "CREATE";
const PRIVILEGES_DATABASE = "CREATE, TEMPORARY";

/** The thirteen bound values of the probe, in the order of its placeholders. */
export function readinessProbeParameters(): readonly unknown[] {
  return [
    [...REQUIRED_FUNCTIONS],
    [...PROHIBITED_FUNCTIONS],
    [...READABLE_TABLES],
    [...PROHIBITED_TABLES],
    [...READINESS_SCHEMAS],
    PRIVILEGE_EXECUTE,
    PRIVILEGE_READ,
    PRIVILEGES_WRITE,
    PRIVILEGES_ANY_TABLE,
    PRIVILEGES_ANY_COLUMN,
    PRIVILEGE_USAGE,
    PRIVILEGE_CREATE,
    PRIVILEGES_DATABASE,
  ];
}

export type ReadinessFailure =
  | "PROBE_ROW_INVALID"
  | "ROLE_NOT_WEB"
  | "ROLE_ELEVATED"
  | "ROLE_HAS_MEMBERSHIP"
  | "REQUIRED_FUNCTION_NOT_EXECUTABLE"
  | "PROHIBITED_FUNCTION_MISSING"
  | "PROHIBITED_FUNCTION_EXECUTABLE"
  | "READABLE_TABLE_NOT_READABLE"
  | "READABLE_TABLE_WRITABLE"
  | "PROHIBITED_TABLE_MISSING"
  | "PROHIBITED_TABLE_REACHABLE"
  | "SCHEMA_USAGE_MISSING"
  | "SCHEMA_CREATE_HELD"
  | "DATABASE_PRIVILEGE_ELEVATED"
  | "SESSION_KEY_STATE"
  | "NONCE_KEY_STATE";

/** The one row a ready connection returns. Every value is required exactly. */
export function expectedReadinessRow(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    session_user_name: READINESS_ROLE,
    current_user_name: READINESS_ROLE,
    plain_role_rows: 1,
    membership_rows: 0,
    required_functions_executable: REQUIRED_FUNCTIONS.length,
    prohibited_functions_present: PROHIBITED_FUNCTIONS.length,
    prohibited_functions_executable: 0,
    readable_tables_readable: READABLE_TABLES.length,
    readable_tables_writable: 0,
    prohibited_tables_present: PROHIBITED_TABLES.length,
    prohibited_tables_reachable: 0,
    schemas_usable: READINESS_SCHEMAS.length,
    schemas_creatable: 0,
    database_elevated: false,
  });
}

const CHECKS: ReadonlyArray<readonly [string, ReadinessFailure]> = [
  ["session_user_name", "ROLE_NOT_WEB"],
  ["current_user_name", "ROLE_NOT_WEB"],
  ["plain_role_rows", "ROLE_ELEVATED"],
  ["membership_rows", "ROLE_HAS_MEMBERSHIP"],
  ["required_functions_executable", "REQUIRED_FUNCTION_NOT_EXECUTABLE"],
  ["prohibited_functions_present", "PROHIBITED_FUNCTION_MISSING"],
  ["prohibited_functions_executable", "PROHIBITED_FUNCTION_EXECUTABLE"],
  ["readable_tables_readable", "READABLE_TABLE_NOT_READABLE"],
  ["readable_tables_writable", "READABLE_TABLE_WRITABLE"],
  ["prohibited_tables_present", "PROHIBITED_TABLE_MISSING"],
  ["prohibited_tables_reachable", "PROHIBITED_TABLE_REACHABLE"],
  ["schemas_usable", "SCHEMA_USAGE_MISSING"],
  ["schemas_creatable", "SCHEMA_CREATE_HELD"],
  ["database_elevated", "DATABASE_PRIVILEGE_ELEVATED"],
];

/**
 * Compares the probe's rows with the expected row. Exactly one row, exactly the expected columns, and every value
 * identical in type and value: a count returned as text, a missing column or an extra one is not accepted.
 */
export function evaluateReadinessRows(rows: readonly unknown[]): Result<void, ReadinessFailure> {
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) return err("PROBE_ROW_INVALID");
  const row = rows[0] as Record<string, unknown>;
  const expected = expectedReadinessRow();
  if (Object.keys(row).sort().join(",") !== Object.keys(expected).sort().join(",")) return err("PROBE_ROW_INVALID");
  for (const [column, failure] of CHECKS) {
    if (row[column] !== expected[column]) return err(failure);
  }
  return ok(undefined);
}

/**
 * One readiness attempt: the probe statement, then the key-version rows of both purposes against the configured
 * rings. A database error is thrown; the caller treats it as "not ready".
 */
export async function probeReadiness(db: PgQueryable, rings: ConfiguredKeyRings): Promise<Result<void, ReadinessFailure>> {
  const reply = await db.query(APPLICATION_STATEMENTS.readinessProbe, readinessProbeParameters());
  const evaluated = evaluateReadinessRows(reply.rows);
  if (!evaluated.ok) return evaluated;
  // The ACTIVE version of each purpose is configured, and every configured version the database accepts has the
  // check value of the configured key.
  if (!(await loadKeyState(db, rings.session)).ok) return err("SESSION_KEY_STATE");
  if (!(await loadKeyState(db, rings.confirmationNonce)).ok) return err("NONCE_KEY_STATE");
  return ok(undefined);
}
