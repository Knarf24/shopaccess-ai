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

  it("creates exactly nine tables, six entry points and one helper, and records six migrations", async () => {
    const tables = await db.admin.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'shopaccess' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "audit_events",
      "checkout_owners",
      "merchant_products",
      "merchant_variants",
      "merchants",
      "schema_migrations",
      "server_key_versions",
      "session_admission_guard",
      "shopper_sessions",
    ]);
    const functions = await db.admin.query(
      "SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'shopaccess_api' ORDER BY p.proname",
    );
    expect(functions.rows.map((row) => row.proname)).toEqual([
      "activate_key_version",
      "admit_session",
      "authorize_session",
      "revoke_key_version",
      "revoke_session",
      "rotate_session",
      "session_is_live",
    ]);
    const apiTables = await db.admin.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'shopaccess_api'");
    expect(apiTables.rows).toHaveLength(0);
    const views = await db.admin.query(
      "SELECT 1 FROM information_schema.views WHERE table_schema IN ('shopaccess', 'shopaccess_api')",
    );
    expect(views.rows).toHaveLength(0);
    const ledger = await db.admin.query("SELECT version FROM shopaccess.schema_migrations ORDER BY version");
    expect(ledger.rows.map((row) => row.version)).toEqual(APPROVED_MIGRATIONS.map((entry) => entry.version));
    expect(ledger.rows).toHaveLength(6);
    const checksums = await db.admin.query("SELECT version, checksum FROM shopaccess.schema_migrations ORDER BY version");
    expect(checksums.rows).toEqual(APPROVED_MIGRATIONS.map((entry) => ({ version: entry.version, checksum: entry.sha256 })));
  });

  it("never applied an archived Milestone 001 draft", async () => {
    const legacyOnly = await db.admin.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('carts', 'cart_items', 'checkout_intents', 'quotes', 'quote_items', 'confirmations', 'payment_operations', 'payment_provider_observations')",
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
    expect(ledger.rows[0].n).toBe(6);
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
      expect(before.schema_migrations.rows).toBe(6);
      expect(before.session_admission_guard.rows).toBe(1);

      // Each statement with the refusal it must meet.
      //  - 23001 (restrict_violation): raised by the table's own reject-change trigger.
      //  - 0A000: PostgreSQL itself refuses a plain TRUNCATE of a table that a foreign key references
      //    (shopper_sessions references both server_key_versions and checkout_owners), before any trigger runs.
      //    For those two tables the trigger is what must stop TRUNCATE ... CASCADE and a multi-table TRUNCATE,
      //    where the foreign-key refusal no longer applies. Those cases follow.
      const expected: Record<string, string> = {
        "UPDATE shopaccess.schema_migrations SET checksum = checksum": RESTRICT_VIOLATION,
        "DELETE FROM shopaccess.schema_migrations": RESTRICT_VIOLATION,
        "TRUNCATE shopaccess.schema_migrations": RESTRICT_VIOLATION,
        "DELETE FROM shopaccess.session_admission_guard": RESTRICT_VIOLATION,
        "TRUNCATE shopaccess.session_admission_guard": RESTRICT_VIOLATION,
        "TRUNCATE shopaccess.server_key_versions": FEATURE_NOT_SUPPORTED,
        "TRUNCATE shopaccess.checkout_owners": FEATURE_NOT_SUPPORTED,
        "TRUNCATE shopaccess.shopper_sessions": RESTRICT_VIOLATION,
        "TRUNCATE shopaccess.audit_events": RESTRICT_VIOLATION,
        // CASCADE would empty shopper_sessions as well. Only the triggers stand in the way.
        "TRUNCATE shopaccess.server_key_versions CASCADE": RESTRICT_VIOLATION,
        "TRUNCATE shopaccess.checkout_owners CASCADE": RESTRICT_VIOLATION,
        "TRUNCATE shopaccess.shopper_sessions CASCADE": RESTRICT_VIOLATION,
        // Naming the referencing table in the same statement also removes the foreign-key refusal.
        "TRUNCATE shopaccess.server_key_versions, shopaccess.shopper_sessions": RESTRICT_VIOLATION,
        "TRUNCATE shopaccess.checkout_owners, shopaccess.shopper_sessions": RESTRICT_VIOLATION,
        "TRUNCATE shopaccess.shopper_sessions, shopaccess.server_key_versions, shopaccess.checkout_owners, shopaccess.audit_events, shopaccess.session_admission_guard, shopaccess.schema_migrations":
          RESTRICT_VIOLATION,
      };
      // Every case is attempted before anything is asserted, so one wrong expectation cannot hide the rest.
      const observed: Record<string, string | null> = {};
      for (const statement of Object.keys(expected)) observed[statement] = await sqlState(() => db.admin.query(statement));
      // No statement succeeded, whatever its error code.
      expect(Object.entries(observed).filter(([, code]) => code === null).map(([statement]) => statement)).toEqual([]);
      expect(observed).toEqual(expected);

      // Not one row of any protected table was removed or altered.
      expect(await snapshot()).toEqual(before);

      // A second guard row is impossible.
      expect(
        await sqlState(() =>
          db.admin.query(
            "INSERT INTO shopaccess.session_admission_guard (id, window_started_at, window_admissions, updated_at) VALUES (2, clock_timestamp(), 0, clock_timestamp())",
          ),
        ),
      ).not.toBeNull();
      expect(await snapshot()).toEqual(before);
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
