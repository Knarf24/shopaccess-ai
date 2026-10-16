import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { APPROVED_MIGRATIONS } from "@/lib/pg/migrate";
import { MIGRATION_STATEMENTS, OPERATOR_STATEMENTS } from "@/lib/pg/statements";
import {
  adminUrl,
  insertBackdatedSession,
  MIGRATIONS_DIR,
  openDisposableDatabase,
  RESTRICT_VIOLATION,
  sqlState,
  TEST_KEY_V1,
  type DisposableDatabase,
} from "./harness";

/** PostgreSQL's own refusal to truncate a table that a foreign key references ("feature_not_supported"). */
const FEATURE_NOT_SUPPORTED = "0A000";

/** What PostgreSQL reported when it refused a statement. */
interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly detail: string | null;
}

/** The refusal a statement met, or null if it succeeded. */
async function refusalOf(run: () => Promise<unknown>): Promise<Refusal | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const fields = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown; detail?: unknown };
    return {
      code: typeof fields.code === "string" ? fields.code : "UNKNOWN",
      message: typeof fields.message === "string" ? fields.message : "",
      detail: typeof fields.detail === "string" ? fields.detail : null,
    };
  }
}

/**
 * PostgreSQL's foreign-key refusal of a TRUNCATE, once for each given pair of the table that references and the table
 * that is referenced. PostgreSQL reports one pair, and which one is not part of any contract.
 */
const foreignKeyRefusals = (...pairs: ReadonlyArray<readonly [referencing: string, referenced: string]>): Refusal[] =>
  pairs.map(([referencing, referenced]) => ({
    code: FEATURE_NOT_SUPPORTED,
    message: "cannot truncate a table referenced in a foreign key constraint",
    detail: `Table "${referencing}" references "${referenced}".`,
  }));

/**
 * The refusal raised by shopaccess.reject_change() (migration 0001), once for each given table: restrict_violation
 * with the message "<operation> is not permitted on <table>" and no detail. Where a statement reaches several tables,
 * the trigger of any one of them may be the one that fires first.
 */
const rejectChangeRefusals = (operation: "UPDATE" | "DELETE" | "TRUNCATE", ...tables: readonly string[]): Refusal[] =>
  tables.map((table) => ({ code: RESTRICT_VIOLATION, message: `${operation} is not permitted on ${table}`, detail: null }));

/** Whether a refusal is the bare SQLSTATE expected, or exactly one of the finite set of refusals expected. */
const isExpectedRefusal = (expected: string | readonly Refusal[], refusal: Refusal | null): boolean => {
  if (refusal === null) return false;
  if (typeof expected === "string") return refusal.code === expected;
  return expected.some((allowed) => allowed.code === refusal.code && allowed.message === refusal.message && allowed.detail === refusal.detail);
};

// Run twice under Gate B-X. In the first run PGT-50 failed on a wrong expected error code and was corrected afterwards;
// the corrected PGT-50 passed in the second run (9 October 2026, PostgreSQL 17.11). Replaces, for the new sequence,
// what MIG-01 checked for the legacy drafts.
describe.skipIf(!adminUrl())("Increment 1 migrations on a disposable PostgreSQL 17 database", () => {
  let db: DisposableDatabase;
  beforeAll(async () => {
    db = await openDisposableDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("creates exactly sixteen tables and the nineteen functions of Increments 1, 2.1 and 2.2, and records nine migrations", async () => {
    const tables = await db.admin.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'shopaccess' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "audit_events",
      "checkout_intents",
      "checkout_owners",
      "checkout_transitions",
      "confirmation_challenges",
      "merchant_products",
      "merchant_variants",
      "merchants",
      "owner_request_windows",
      "purchase_groups",
      "quote_items",
      "quotes",
      "schema_migrations",
      "server_key_versions",
      "session_admission_guard",
      "shopper_sessions",
    ]);
    const functions = await db.admin.query(
      "SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'shopaccess_api' ORDER BY p.proname",
    );
    // Increment 1: six entry points and one helper. Migration 0008: four entry points and six helpers. Migration
    // 0009: two entry points, and read_checkout again in the place of the one of 0008 (one function, as before).
    expect(functions.rows.map((row) => row.proname)).toEqual([
      "activate_key_version",
      "admit_session",
      "authorize_session",
      "cancel_checkout",
      "checkout_transition",
      "consume_challenge",
      "descriptive_terms_digest",
      "issue_challenge",
      "list_owner_checkouts",
      "owner_window_decision",
      "quote_digest_saqd1",
      "quote_material_change",
      "read_checkout",
      "require_read_committed",
      "revoke_key_version",
      "revoke_session",
      "rotate_session",
      "session_is_live",
      "start_checkout",
    ]);
    const apiTables = await db.admin.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'shopaccess_api'");
    expect(apiTables.rows).toHaveLength(0);
    const views = await db.admin.query(
      "SELECT 1 FROM information_schema.views WHERE table_schema IN ('shopaccess', 'shopaccess_api')",
    );
    expect(views.rows).toHaveLength(0);
    const ledger = await db.admin.query("SELECT version FROM shopaccess.schema_migrations ORDER BY version");
    expect(ledger.rows.map((row) => row.version)).toEqual(APPROVED_MIGRATIONS.map((entry) => entry.version));
    expect(ledger.rows).toHaveLength(9);
    const checksums = await db.admin.query("SELECT version, checksum FROM shopaccess.schema_migrations ORDER BY version");
    expect(checksums.rows).toEqual(APPROVED_MIGRATIONS.map((entry) => ({ version: entry.version, checksum: entry.sha256 })));
  });

  it("never applied an archived Milestone 001 draft", async () => {
    const legacyOnly = await db.admin.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('carts', 'cart_items', 'confirmations', 'payment_operations', 'payment_provider_observations')",
    );
    expect(legacyOnly.rows).toHaveLength(0);
  });

  it("PGT-51: applying the sequence again is a no-op, and an altered file is refused before any statement is sent", async () => {
    // The runner acquires its own pinned connection as the migration role.
    expect(await db.migrate(MIGRATIONS_DIR)).toEqual({ ok: true, value: [] });

    const scratch = mkdtempSync(join(tmpdir(), "shopaccess-migrations-"));
    const copy = join(scratch, "db", "migrations");
    try {
      mkdirSync(copy, { recursive: true });
      for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
        if (entry.isFile()) cpSync(join(MIGRATIONS_DIR, entry.name), join(copy, entry.name));
      }
      // An unchanged copy is still a no-op.
      expect(await db.migrate(copy)).toEqual({ ok: true, value: [] });
      appendFileSync(join(copy, "0003_merchant_catalog.sql"), "\n-- altered after being applied\n");
      expect(await db.migrate(copy)).toEqual({ ok: false, error: { code: "CHECKSUM_NOT_APPROVED", version: "0003_merchant_catalog" } });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const ledger = await db.admin.query("SELECT count(*)::integer AS n FROM shopaccess.schema_migrations");
    expect(ledger.rows[0].n).toBe(9);
  });

  it("PGT-50: append-only and immutable tables reject update, delete and truncate even for the table owner, and their rows are unchanged", async () => {
    // Real rows in every protected table, so that "nothing changed" means something:
    // a key version and its audit row through the operator function, then an owner and a session.
    const activated = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 1, computeKeyCheckValue(TEST_KEY_V1, "session")]);
    expect(activated.rows[0].result).toBe("ACTIVATED");
    await insertBackdatedSession(db.admin, 1, "1 hour", "1 minute");

    const PROTECTED = ["schema_migrations", "session_admission_guard", "server_key_versions", "checkout_owners", "shopper_sessions", "audit_events"] as const;
    /** Row count and a digest of every row of each protected table. */
    const snapshot = async () => {
      const state: Record<string, { rows: number; digest: string }> = {};
      for (const table of PROTECTED) {
        const { rows } = await db.admin.query(
          `SELECT count(*)::integer AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM shopaccess.${table} t`,
        );
        state[table] = { rows: rows[0].n, digest: rows[0].digest };
      }
      return state;
    };

    await db.admin.query("SET ROLE shopaccess_owner");
    try {
      const before = await snapshot();
      // Every table holds at least one row before anything is attempted.
      expect(Object.fromEntries(PROTECTED.map((table) => [table, before[table].rows > 0]))).toEqual(
        Object.fromEntries(PROTECTED.map((table) => [table, true])),
      );
      expect(before.schema_migrations.rows).toBe(9);
      expect(before.session_admission_guard.rows).toBe(1);

      // Each statement with the refusal it must meet.
      //  - 23001 (restrict_violation): raised by a table's own reject-change trigger, with a message naming the
      //    operation and the table. A statement that reaches several tables may be stopped by the trigger of any one
      //    of them, so each of those tables is listed and no order is assumed.
      //  - 0A000: PostgreSQL itself refuses a TRUNCATE of a table that a foreign key references, before any trigger
      //    runs, unless every referencing table is named in the same statement. shopper_sessions references both
      //    server_key_versions and checkout_owners (migration 0002); since migration 0007, confirmation_challenges
      //    also references server_key_versions, and purchase_groups and owner_request_windows also reference
      //    checkout_owners. For those two tables the trigger is what must stop TRUNCATE ... CASCADE, where the
      //    foreign-key refusal does not apply.
      // A bare code is compared with the SQLSTATE alone. A list is the finite set of refusals the statement may
      // meet: the SQLSTATE, the message and the detail must all match one member, so no other error is accepted.
      const expected: Record<string, string | readonly Refusal[]> = {
        "UPDATE shopaccess.schema_migrations SET checksum = checksum": rejectChangeRefusals("UPDATE", "schema_migrations"),
        "DELETE FROM shopaccess.schema_migrations": rejectChangeRefusals("DELETE", "schema_migrations"),
        "TRUNCATE shopaccess.schema_migrations": rejectChangeRefusals("TRUNCATE", "schema_migrations"),
        "DELETE FROM shopaccess.session_admission_guard": rejectChangeRefusals("DELETE", "session_admission_guard"),
        "TRUNCATE shopaccess.session_admission_guard": rejectChangeRefusals("TRUNCATE", "session_admission_guard"),
        "TRUNCATE shopaccess.server_key_versions": FEATURE_NOT_SUPPORTED,
        "TRUNCATE shopaccess.checkout_owners": FEATURE_NOT_SUPPORTED,
        // Nothing references these two, so their own triggers are the only ones reached.
        "TRUNCATE shopaccess.shopper_sessions": rejectChangeRefusals("TRUNCATE", "shopper_sessions"),
        "TRUNCATE shopaccess.audit_events": rejectChangeRefusals("TRUNCATE", "audit_events"),
        // CASCADE reaches every table that references the named one, directly or through another table, and only
        // the triggers stand in the way. Through confirmation_challenges it reaches checkout_intents, and through
        // that quotes, quote_items and checkout_transitions.
        "TRUNCATE shopaccess.server_key_versions CASCADE": rejectChangeRefusals(
          "TRUNCATE",
          "server_key_versions",
          "shopper_sessions",
          "confirmation_challenges",
          "checkout_intents",
          "quotes",
          "quote_items",
          "checkout_transitions",
        ),
        // Through purchase_groups it reaches checkout_intents, and through that the other checkout tables.
        "TRUNCATE shopaccess.checkout_owners CASCADE": rejectChangeRefusals(
          "TRUNCATE",
          "checkout_owners",
          "shopper_sessions",
          "purchase_groups",
          "owner_request_windows",
          "checkout_intents",
          "quotes",
          "quote_items",
          "confirmation_challenges",
          "checkout_transitions",
        ),
        "TRUNCATE shopaccess.shopper_sessions CASCADE": rejectChangeRefusals("TRUNCATE", "shopper_sessions"),
        // Naming shopper_sessions in the same statement no longer removes the foreign-key refusal: tables of
        // migration 0007 reference these two as well, and are not named. Each list holds every foreign key from a
        // table the statement does not name to a table it does name, and nothing else.
        "TRUNCATE shopaccess.server_key_versions, shopaccess.shopper_sessions": foreignKeyRefusals(["confirmation_challenges", "server_key_versions"]),
        "TRUNCATE shopaccess.checkout_owners, shopaccess.shopper_sessions": foreignKeyRefusals(
          ["purchase_groups", "checkout_owners"],
          ["owner_request_windows", "checkout_owners"],
        ),
        "TRUNCATE shopaccess.shopper_sessions, shopaccess.server_key_versions, shopaccess.checkout_owners, shopaccess.audit_events, shopaccess.session_admission_guard, shopaccess.schema_migrations":
          foreignKeyRefusals(
            ["confirmation_challenges", "server_key_versions"],
            ["purchase_groups", "checkout_owners"],
            ["owner_request_windows", "checkout_owners"],
          ),
      };
      // Every case is attempted, and every snapshot read, before anything is asserted, so one wrong expectation
      // can hide neither the remaining cases nor the state of the rows.
      const observed: Record<string, Refusal | null> = {};
      for (const statement of Object.keys(expected)) observed[statement] = await refusalOf(() => db.admin.query(statement));
      const afterStatements = await snapshot();
      const secondGuardRow = await sqlState(() =>
        db.admin.query(
          "INSERT INTO shopaccess.session_admission_guard (id, window_started_at, window_admissions, updated_at) VALUES (2, clock_timestamp(), 0, clock_timestamp())",
        ),
      );
      const afterSecondGuardRow = await snapshot();

      // Not one row of any protected table was removed or altered.
      expect(afterStatements).toEqual(before);
      // A second guard row is impossible.
      expect(secondGuardRow).not.toBeNull();
      expect(afterSecondGuardRow).toEqual(before);

      // No statement succeeded, whatever its error code.
      expect(Object.entries(observed).filter(([, refusal]) => refusal === null).map(([statement]) => statement)).toEqual([]);
      // Each statement met a refusal it is allowed to meet. A statement that did not is listed with what it met.
      expect(
        Object.entries(expected)
          .filter(([statement, allowed]) => !isExpectedRefusal(allowed, observed[statement]))
          .map(([statement]) => ({ statement, observed: observed[statement] })),
      ).toEqual([]);
    } finally {
      await db.admin.query("RESET ROLE");
    }
  });

  it("integrity checks reject malformed ledger, key-version and owner rows", async () => {
    await db.admin.query("SET ROLE shopaccess_owner");
    try {
      const rejected: Array<[string, unknown[]]> = [
        [MIGRATION_STATEMENTS.recordMigration, ["7_bad", "0".repeat(64)]],
        [MIGRATION_STATEMENTS.recordMigration, ["0007_ok", "XYZ"]],
        ["INSERT INTO shopaccess.server_key_versions (purpose, key_version, status, check_value, activated_at) VALUES ($1, 9, 'ACTIVE', $2, clock_timestamp())", ["session", "not-hex"]],
        ["INSERT INTO shopaccess.server_key_versions (purpose, key_version, status, check_value, activated_at) VALUES ($1, 9, 'REVOKED', $2, clock_timestamp())", ["confirmation_nonce", "a".repeat(64)]],
        ["INSERT INTO shopaccess.checkout_owners (id, created_at) VALUES ($1, clock_timestamp())", ["own_UPPERCASE"]],
      ];
      for (const [statement, values] of rejected) {
        expect(await sqlState(() => db.admin.query(statement, values)), statement).not.toBeNull();
      }
    } finally {
      await db.admin.query("RESET ROLE");
    }
  });
});
