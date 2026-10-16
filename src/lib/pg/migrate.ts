import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { err, ok, type Result } from "../shared/result";
import { withPinnedConnection, type PgConnectionSource } from "./client";
import { MIGRATION_STATEMENTS } from "./statements";

/**
 * Migration runner for the PostgreSQL 17 foundation (specification 14).
 *
 * It applies an explicit, approved inventory of files and nothing else. A file
 * is applied only if its name is in the inventory AND its bytes have the
 * SHA-256 recorded there. Changing a migration therefore means changing the
 * inventory below in the same reviewed change. This pin, not text parsing, is
 * what keeps an unreviewed statement out of a migration.
 *
 * It never discovers or executes the archived Milestone 001 drafts:
 *  - the directory is resolved with realpath, so a symlink alias is seen for
 *    what it is, and any path with an `archive` segment is refused;
 *  - the directory must be a `db/migrations` directory;
 *  - it does not enter subdirectories, and refuses every entry that is not an
 *    inventory file, except the `archive` directory, which it never opens;
 *  - a symlink is never followed.
 * It never reads `db/bootstrap`, which a database administrator runs by hand.
 *
 * Each migration runs with its ledger row in one transaction on ONE pinned
 * connection (see `withPinnedConnection`).
 *
 * This module has never been run against a database.
 */

export interface ApprovedMigration {
  /** File name without `.sql`. This is the ledger key. */
  readonly version: string;
  /** SHA-256 of the file's bytes, lowercase hex. */
  readonly sha256: string;
}

/**
 * The approved inventory. Nine files, in order: the six of Increment 1, then
 * the Increment 2.1 checkout schema, the Increment 2.1 checkout functions and
 * the Increment 2.2 confirmation functions.
 * Update a checksum only together with the reviewed change to the file it
 * names.
 */
export const APPROVED_MIGRATIONS: readonly ApprovedMigration[] = Object.freeze([
  Object.freeze({ version: "0001_migration_ledger", sha256: "f5e90a75aa48c2b4bde4d64149a0fbcc2ff8f53884c77ca6dd27539c0589c671" }),
  Object.freeze({ version: "0002_keys_owners_sessions", sha256: "9dc70f121f34aa4f0e05dd4aa2412c51abfc1cbe6ed6854ee72a5628f6d481a6" }),
  Object.freeze({ version: "0003_merchant_catalog", sha256: "dc16b7f1a3a230ef9344afc0a388bededf2c2bc7af54513b3ee83a87e96ae0e1" }),
  Object.freeze({ version: "0004_merchant_catalog_seed", sha256: "4fe7e277e1633d956c50fdefe212723c8be0e2ff4b5bcf4227dceb9e7b84c015" }),
  Object.freeze({ version: "0005_audit_events", sha256: "4cb9f7c16c9b4858279a2592286b7cc90167a747b50d584efe4f2140862e7d1f" }),
  Object.freeze({ version: "0006_session_and_key_functions", sha256: "5ec51928563fc6dc611e0a9c8156639bdadfb6f3863f70b545671f19d52ae99f" }),
  Object.freeze({ version: "0007_checkout_schema", sha256: "a20f362b83b6f06805a42a04d8b33875e1420b7ea21bb042166921f9450a2668" }),
  Object.freeze({ version: "0008_checkout_functions", sha256: "4bbc00c378c664e452c3677b708bd9a8ac431b9469a4fb989b1ce90b2b4cf0b4" }),
  Object.freeze({ version: "0009_confirmation_functions", sha256: "931c9cc7b97000017ef900050b6e94f31c58d28db039b995b0247ce858a1241d" }),
]);

export interface MigrationFile {
  /** File name without `.sql`. This is the ledger key. */
  readonly version: string;
  /** Canonical (realpath) location. */
  readonly path: string;
  /** SHA-256 of the file's bytes, lowercase hex. */
  readonly checksum: string;
  readonly sql: string;
}

export type MigrationDiscoveryError =
  | { readonly code: "INVENTORY_INVALID"; readonly detail: string }
  | { readonly code: "ARCHIVE_DIRECTORY_REFUSED"; readonly directory: string }
  | { readonly code: "DIRECTORY_NOT_FOUND"; readonly directory: string }
  | { readonly code: "DIRECTORY_NOT_APPROVED"; readonly directory: string }
  | { readonly code: "UNEXPECTED_ENTRY"; readonly name: string }
  | { readonly code: "NOT_A_REGULAR_FILE"; readonly name: string }
  | { readonly code: "MIGRATION_MISSING"; readonly version: string }
  | { readonly code: "CHECKSUM_NOT_APPROVED"; readonly version: string }
  | { readonly code: "MIGRATION_NOT_ANALYSABLE"; readonly version: string }
  | { readonly code: "TRANSACTION_CONTROL_IN_FILE"; readonly version: string };

const ARCHIVE_SEGMENT = "archive";
const APPROVED_DIRECTORY_TAIL = `${sep}db${sep}migrations`;
const VERSION_PATTERN = /^([0-9]{4})_[a-z0-9_]{1,60}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

function validateInventory(inventory: readonly ApprovedMigration[]): string | null {
  if (inventory.length === 0) return "the inventory is empty";
  const seen = new Set<string>();
  for (let index = 0; index < inventory.length; index += 1) {
    const { version, sha256 } = inventory[index];
    const match = VERSION_PATTERN.exec(version);
    if (!match) return `entry ${index + 1} has a malformed version`;
    if (match[1] !== String(index + 1).padStart(4, "0")) return `entry ${index + 1} is not numbered ${String(index + 1).padStart(4, "0")}`;
    if (seen.has(version)) return `entry ${index + 1} repeats a version`;
    seen.add(version);
    if (!SHA256_PATTERN.test(sha256)) return `entry ${index + 1} has a malformed checksum`;
  }
  return null;
}

interface SqlLayers {
  /** The text with comments, string literals, quoted identifiers and dollar-quoted bodies each replaced by a space. */
  readonly code: string;
  /** The contents of each dollar-quoted body. */
  readonly bodies: readonly string[];
}

/**
 * Separates SQL code from comments, literals and dollar-quoted bodies by
 * scanning characters, so line breaks, block comments (nested or not) and
 * spacing cannot hide a keyword. Returns null when a comment, literal or body
 * is not terminated: such a file is refused rather than guessed at.
 */
function separateSql(sql: string): SqlLayers | null {
  let code = "";
  const bodies: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      code += " ";
    } else if (character === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (depth > 0) {
        if (index >= sql.length) return null;
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      code += " ";
    } else if (character === "'" || character === '"') {
      // In an E'' string a backslash escapes the next character.
      const before = sql[index - 1];
      const escapes =
        character === "'" && (before === "E" || before === "e") && !IDENTIFIER_CHARACTER.test(sql[index - 2] ?? " ");
      index += 1;
      for (;;) {
        if (index >= sql.length) return null;
        if (escapes && sql[index] === "\\") {
          index += 2;
        } else if (sql[index] === character && sql[index + 1] === character) {
          index += 2;
        } else if (sql[index] === character) {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      code += character === '"' ? " quoted_identifier " : " ";
    } else if (character === "$" && !IDENTIFIER_CHARACTER.test(sql[index - 1] ?? " ")) {
      const tag = DOLLAR_TAG.exec(sql.slice(index, index + 80))?.[0];
      if (!tag) {
        code += character;
        index += 1;
      } else {
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) return null;
        bodies.push(sql.slice(index + tag.length, end));
        index = end + tag.length;
        code += " ";
      }
    } else {
      code += character;
      index += 1;
    }
  }
  return { code, bodies };
}

const TOP_LEVEL_TRANSACTION_CONTROL =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
const BODY_TRANSACTION_CONTROL = /\b(?:COMMIT|ROLLBACK)\b/i;

export type TransactionControlFinding = "NONE" | "FOUND" | "NOT_ANALYSABLE";

/**
 * Looks for a statement that would start, end or partly undo a transaction.
 * The runner owns the transaction, so a migration may contain none. This is a
 * second line of defence behind the checksum pin: it reads statements, not
 * lines, and also looks inside function and DO bodies, where a COMMIT or
 * ROLLBACK has no legitimate use in this design.
 */
export function findTransactionControl(sql: string): TransactionControlFinding {
  const layers = separateSql(sql);
  if (!layers) return "NOT_ANALYSABLE";
  for (const statement of layers.code.split(";")) {
    if (TOP_LEVEL_TRANSACTION_CONTROL.test(statement.trim())) return "FOUND";
  }
  for (const body of layers.bodies) {
    const inner = separateSql(body);
    if (!inner) return "NOT_ANALYSABLE";
    if (BODY_TRANSACTION_CONTROL.test(inner.code)) return "FOUND";
    // A body may itself contain dollar-quoted text.
    for (const nested of inner.bodies) {
      const finding = findTransactionControl(nested);
      if (finding !== "NONE") return finding;
    }
  }
  return "NONE";
}

/**
 * Reads the migrations of `directory` against an inventory. Fails closed on
 * anything unexpected. `listMigrations` is this function with the approved
 * inventory; a different inventory exists only so that tests can exercise the
 * rules in a temporary directory. The runner itself accepts no inventory.
 */
export function discoverMigrations(
  directory: string,
  inventory: readonly ApprovedMigration[],
): Result<MigrationFile[], MigrationDiscoveryError> {
  const invalid = validateInventory(inventory);
  if (invalid) return err({ code: "INVENTORY_INVALID", detail: invalid });

  const requested = resolve(directory);
  if (requested.split(sep).includes(ARCHIVE_SEGMENT)) return err({ code: "ARCHIVE_DIRECTORY_REFUSED", directory: requested });
  let root: string;
  try {
    root = realpathSync(requested);
  } catch {
    return err({ code: "DIRECTORY_NOT_FOUND", directory: requested });
  }
  // After resolving symlinks: an alias that points into the archive is refused here.
  if (root.split(sep).includes(ARCHIVE_SEGMENT)) return err({ code: "ARCHIVE_DIRECTORY_REFUSED", directory: root });
  if (!root.endsWith(APPROVED_DIRECTORY_TAIL)) return err({ code: "DIRECTORY_NOT_APPROVED", directory: root });

  const expected = new Set(inventory.map((entry) => `${entry.version}.sql`));
  const present = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ARCHIVE_SEGMENT) {
      // The archive must be a real directory. It is never opened.
      if (!entry.isDirectory()) return err({ code: "UNEXPECTED_ENTRY", name: entry.name });
      continue;
    }
    if (!expected.has(entry.name)) return err({ code: "UNEXPECTED_ENTRY", name: entry.name });
    // A symbolic link reports neither isFile nor isDirectory here, so it is refused.
    if (!entry.isFile()) return err({ code: "NOT_A_REGULAR_FILE", name: entry.name });
    const path = join(root, entry.name);
    if (realpathSync(path) !== path) return err({ code: "NOT_A_REGULAR_FILE", name: entry.name });
    present.add(entry.name);
  }

  const files: MigrationFile[] = [];
  for (const { version, sha256 } of inventory) {
    const name = `${version}.sql`;
    if (!present.has(name)) return err({ code: "MIGRATION_MISSING", version });
    const path = join(root, name);
    const bytes = readFileSync(path);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (checksum !== sha256) return err({ code: "CHECKSUM_NOT_APPROVED", version });
    const sql = bytes.toString("utf8");
    const finding = findTransactionControl(sql);
    if (finding === "NOT_ANALYSABLE") return err({ code: "MIGRATION_NOT_ANALYSABLE", version });
    if (finding === "FOUND") return err({ code: "TRANSACTION_CONTROL_IN_FILE", version });
    files.push({ version, path, checksum, sql });
  }
  return ok(files);
}

/** The approved migrations of `directory`, in order, or the reason they are refused. */
export function listMigrations(directory: string): Result<MigrationFile[], MigrationDiscoveryError> {
  return discoverMigrations(directory, APPROVED_MIGRATIONS);
}

export interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
}

export type MigrationPlanError =
  | { readonly code: "APPLIED_MIGRATION_MISSING"; readonly version: string }
  | { readonly code: "CHECKSUM_MISMATCH"; readonly version: string }
  | { readonly code: "APPLIED_OUT_OF_ORDER"; readonly version: string };

/**
 * Decides what remains to be applied. The applied migrations must be exactly
 * the first files of the sequence, each with an unchanged checksum. An altered,
 * missing or out-of-order migration is refused; nothing is applied in that case.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): Result<MigrationFile[], MigrationPlanError> {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const appliedVersions = new Set<string>();
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) return err({ code: "APPLIED_MIGRATION_MISSING", version: row.version });
    if (file.checksum !== row.checksum) return err({ code: "CHECKSUM_MISMATCH", version: row.version });
    appliedVersions.add(row.version);
  }
  const pending: MigrationFile[] = [];
  for (const file of files) {
    if (appliedVersions.has(file.version)) {
      if (pending.length > 0) return err({ code: "APPLIED_OUT_OF_ORDER", version: file.version });
    } else {
      pending.push(file);
    }
  }
  return ok(pending);
}

export type MigrationRunError = MigrationDiscoveryError | MigrationPlanError;

/**
 * Applies the pending approved migrations. `source` must hand out connections
 * logged in as the migration role.
 *
 * One connection is acquired, used for every statement and released in every
 * case. For each migration the BEGIN, the advisory lock, the ledger read, the
 * migration itself, its ledger row and the COMMIT all travel on that one
 * connection, so a failure leaves that migration entirely unapplied and
 * unrecorded. A ledger row is written only inside the transaction that applied
 * the file, and a version is reported as applied only after its COMMIT returned.
 *
 * Discovery happens first: if the directory is refused, no connection is
 * acquired. Applying an up-to-date database is a no-op. A database error is
 * rethrown after a ROLLBACK; if the ROLLBACK cannot be confirmed the
 * connection is destroyed instead of being reused.
 */
export async function applyMigrations(
  source: PgConnectionSource,
  directory: string,
): Promise<Result<string[], MigrationRunError>> {
  const listed = listMigrations(directory);
  if (!listed.ok) return listed;
  const statements = MIGRATION_STATEMENTS;

  return withPinnedConnection(source, async (connection): Promise<Result<string[], MigrationRunError>> => {
    const appliedNow: string[] = [];
    for (;;) {
      try {
        await connection.query(statements.begin);
        await connection.query(statements.lockMigrations);
        const exists = await connection.query<{ present: boolean }>(statements.ledgerExists);
        const applied =
          exists.rows[0]?.present === true ? (await connection.query<AppliedMigration>(statements.readLedger)).rows : [];
        const plan = planMigrations(listed.value, applied);
        if (!plan.ok) {
          await connection.query(statements.rollback);
          return plan;
        }
        const next = plan.value[0];
        if (!next) {
          await connection.query(statements.commit);
          return ok(appliedNow);
        }
        await connection.query(next.sql);
        await connection.query(statements.recordMigration, [next.version, next.checksum]);
        await connection.query(statements.commit);
        appliedNow.push(next.version);
      } catch (error) {
        try {
          await connection.query(statements.rollback);
        } catch {
          connection.discard();
        }
        throw error;
      }
    }
  });
}
