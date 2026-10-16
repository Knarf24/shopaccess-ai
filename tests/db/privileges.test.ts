import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_STATEMENTS } from "@/lib/pg/statements";
import {
  adminUrl,
  INSUFFICIENT_PRIVILEGE,
  openDisposableDatabase,
  sqlState,
  type DisposableDatabase,
} from "./harness";

const TABLES = [
  "schema_migrations",
  "session_admission_guard",
  "server_key_versions",
  "checkout_owners",
  "shopper_sessions",
  "merchants",
  "merchant_products",
  "merchant_variants",
  "audit_events",
] as const;

/** One ordinary column per table, for a no-op UPDATE that reaches the privilege check. */
const ANY_COLUMN: Record<(typeof TABLES)[number], string> = {
  schema_migrations: "checksum",
  session_admission_guard: "window_admissions",
  server_key_versions: "status",
  checkout_owners: "created_at",
  shopper_sessions: "last_seen_at",
  merchants: "display_name",
  merchant_products: "title",
  merchant_variants: "label",
  audit_events: "actor",
};

const WEB_READABLE = ["merchants", "merchant_products", "merchant_variants", "server_key_versions"];
const OPERATOR_READABLE = ["server_key_versions", "audit_events"];

const ENTRY_POINTS: Record<string, string> = {
  admit_session: "shopaccess_api.admit_session(text, smallint, text)",
  authorize_session: "shopaccess_api.authorize_session(smallint, text)",
  rotate_session: "shopaccess_api.rotate_session(smallint, text, smallint, text)",
  revoke_session: "shopaccess_api.revoke_session(smallint, text)",
  activate_key_version: "shopaccess_api.activate_key_version(text, smallint, text)",
  revoke_key_version: "shopaccess_api.revoke_key_version(text, smallint)",
};
const HELPER = "shopaccess_api.session_is_live(timestamptz, timestamptz, timestamptz, text, timestamptz)";

// NEVER RUN (Gate B-X not authorized).
describe.skipIf(!adminUrl())("PGT-69a, 69b, 88 and V-24: Increment 1 roles and privileges", () => {
  let db: DisposableDatabase;
  beforeAll(async () => {
    db = await openDisposableDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("PGT-69b: web and operator cannot write any table, and read only what is granted", async () => {
    for (const [pool, readable] of [
      [db.web, WEB_READABLE],
      [db.operator, OPERATOR_READABLE],
    ] as const) {
      for (const table of TABLES) {
        const writes = [
          `INSERT INTO shopaccess.${table} DEFAULT VALUES`,
          `UPDATE shopaccess.${table} SET ${ANY_COLUMN[table]} = ${ANY_COLUMN[table]}`,
          `DELETE FROM shopaccess.${table}`,
          `TRUNCATE shopaccess.${table}`,
        ];
        for (const statement of writes) {
          expect(await sqlState(() => pool.query(statement)), statement).toBe(INSUFFICIENT_PRIVILEGE);
        }
        const read = await sqlState(() => pool.query(`SELECT count(*) FROM shopaccess.${table}`));
        expect(read, `read ${table}`).toBe(readable.includes(table) ? null : INSUFFICIENT_PRIVILEGE);
      }
    }
  });

  it("each role may execute only its own entry points, and nobody but the function owner the helper", async () => {
    const expectations: Array<[string, string[]]> = [
      ["shopaccess_web", ["admit_session", "authorize_session", "rotate_session", "revoke_session"]],
      ["shopaccess_operator", ["activate_key_version", "revoke_key_version"]],
      ["shopaccess_worker", []],
      ["shopaccess_owner", []],
    ];
    for (const [role, allowed] of expectations) {
      for (const [name, signature] of Object.entries(ENTRY_POINTS)) {
        const { rows } = await db.admin.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS granted", [role, signature]);
        expect(rows[0].granted, `${role} ${name}`).toBe(allowed.includes(name));
      }
      const helper = await db.admin.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS granted", [role, HELPER]);
      expect(helper.rows[0].granted, `${role} helper`).toBe(false);
    }
    expect(
      await sqlState(() =>
        db.web.query(
          "SELECT shopaccess_api.session_is_live(NULL, clock_timestamp(), clock_timestamp(), 'ACTIVE', clock_timestamp())",
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("PGT-88: functions are owned by shopaccess_definer, are definer-rights with a fixed search path", async () => {
    const { rows } = await db.admin.query(
      `SELECT p.proname, r.rolname AS owner, p.prosecdef, p.proconfig
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'shopaccess_api'`,
    );
    // Seven of Increment 1, the ten of migration 0008 (four entry points and six internal helpers), and the two
    // confirmation entry points of migration 0009, which also puts read_checkout in the place of the one of 0008.
    expect(rows).toHaveLength(19);
    // The internal helpers run with the rights of whoever calls them; every entry point is definer-rights.
    const invokerRights = [
      "session_is_live",
      "require_read_committed",
      "owner_window_decision",
      "checkout_transition",
      "quote_digest_saqd1",
      "descriptive_terms_digest",
      "quote_material_change",
    ];
    for (const row of rows) {
      expect(row.owner, row.proname).toBe("shopaccess_definer");
      expect(row.proconfig, row.proname).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(row.prosecdef, row.proname).toBe(!invokerRights.includes(row.proname));
    }
  });

  it("PGT-88: the function owner holds exactly its table privileges, owns no table and can create nothing", async () => {
    const grants = await db.admin.query(
      "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'shopaccess_definer' AND table_schema = 'shopaccess' ORDER BY table_name, privilege_type",
    );
    // Increment 1's privileges, those the functions migration 0008 adds, and INSERT on confirmation_challenges from
    // migration 0009 (specification 19.13). No DELETE on any checkout table, and no table-level UPDATE on
    // owner_request_windows or on confirmation_challenges: those two are granted by column.
    expect(grants.rows.map((row) => `${row.table_name}:${row.privilege_type}`)).toEqual([
      "audit_events:INSERT",
      "checkout_intents:INSERT",
      "checkout_intents:SELECT",
      "checkout_intents:UPDATE",
      "checkout_owners:INSERT",
      "checkout_owners:SELECT",
      "checkout_owners:UPDATE",
      "checkout_transitions:INSERT",
      "checkout_transitions:SELECT",
      "confirmation_challenges:INSERT",
      "confirmation_challenges:SELECT",
      "merchant_products:SELECT",
      "merchant_variants:SELECT",
      "merchants:SELECT",
      "owner_request_windows:INSERT",
      "owner_request_windows:SELECT",
      "purchase_groups:INSERT",
      "purchase_groups:SELECT",
      "quote_items:INSERT",
      "quote_items:SELECT",
      "quotes:INSERT",
      "quotes:SELECT",
      "server_key_versions:INSERT",
      "server_key_versions:SELECT",
      "server_key_versions:UPDATE",
      "session_admission_guard:SELECT",
      "session_admission_guard:UPDATE",
      "shopper_sessions:DELETE",
      "shopper_sessions:INSERT",
      "shopper_sessions:SELECT",
      "shopper_sessions:UPDATE",
    ]);
    // Migration 0009, confirmation_challenges: the function owner may insert a row, and may update exactly the
    // status and the three times that go with it. Every other column, and every other operation, is refused.
    const challengeColumns = await db.admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'shopaccess' AND table_name = 'confirmation_challenges' ORDER BY column_name",
    );
    const updatable = ["consumed_at", "expired_marked_at", "status", "superseded_at"];
    expect(challengeColumns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(updatable));
    expect(challengeColumns.rows).toHaveLength(15);
    for (const { column_name: column } of challengeColumns.rows) {
      const { rows } = await db.admin.query(
        "SELECT has_column_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', $1, 'UPDATE') AS may_update, has_column_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', $1, 'INSERT') AS may_insert, has_column_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', $1, 'SELECT') AS may_select",
        [column],
      );
      expect(rows[0], column).toEqual({ may_update: updatable.includes(column), may_insert: true, may_select: true });
    }
    const challengeColumnGrants = await db.admin.query(
      "SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'shopaccess_definer' AND table_schema = 'shopaccess' AND table_name = 'confirmation_challenges' AND privilege_type = 'UPDATE' ORDER BY column_name",
    );
    expect(challengeColumnGrants.rows.map((row) => row.column_name)).toEqual(updatable);
    const challengeTable = await db.admin.query(
      `SELECT has_table_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', 'INSERT') AS may_insert,
              has_table_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', 'SELECT') AS may_select,
              has_table_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', 'UPDATE') AS may_update_every_column,
              has_table_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', 'DELETE') AS may_delete,
              has_table_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', 'TRUNCATE') AS may_truncate,
              has_table_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', 'REFERENCES') AS may_reference,
              has_table_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', 'TRIGGER') AS may_trigger`,
    );
    expect(challengeTable.rows[0]).toEqual({ may_insert: true, may_select: true, may_update_every_column: false, may_delete: false, may_truncate: false, may_reference: false, may_trigger: false });
    // The web role, the operator, the worker and PUBLIC still hold nothing on the table: no table privilege and no
    // privilege on any column.
    for (const role of ["shopaccess_web", "shopaccess_operator", "shopaccess_worker"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const { rows } = await db.admin.query("SELECT has_table_privilege($1, 'shopaccess.confirmation_challenges', $2) AS granted", [role, privilege]);
        expect(rows[0].granted, `${role} ${privilege}`).toBe(false);
      }
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        const { rows } = await db.admin.query("SELECT has_any_column_privilege($1, 'shopaccess.confirmation_challenges', $2) AS granted", [role, privilege]);
        expect(rows[0].granted, `${role} ${privilege} on a column`).toBe(false);
      }
    }
    const publicOrOther = await db.admin.query(
      `SELECT grantee, privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'shopaccess' AND table_name = 'confirmation_challenges' AND grantee NOT IN ('shopaccess_owner', 'shopaccess_definer')
       UNION ALL
       SELECT grantee, privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'shopaccess' AND table_name = 'confirmation_challenges' AND grantee NOT IN ('shopaccess_owner', 'shopaccess_definer')`,
    );
    expect(publicOrOther.rows).toEqual([]);
    // The three functions of migration 0009: the web role may execute them, and nobody else but their owner.
    const confirmationFunctions = await db.admin.query(
      `SELECT p.proname,
              has_function_privilege('shopaccess_web', p.oid, 'EXECUTE') AS web,
              has_function_privilege('shopaccess_operator', p.oid, 'EXECUTE') AS operator,
              has_function_privilege('shopaccess_worker', p.oid, 'EXECUTE') AS worker,
              has_function_privilege('public', p.oid, 'EXECUTE') AS everyone
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'shopaccess_api' AND p.proname IN ('read_checkout', 'issue_challenge', 'consume_challenge')
        ORDER BY p.proname`,
    );
    expect(confirmationFunctions.rows).toEqual(
      ["consume_challenge", "issue_challenge", "read_checkout"].map((proname) => ({ proname, web: true, operator: false, worker: false, everyone: false })),
    );
    const owned = await db.admin.query(
      "SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'shopaccess' AND tableowner <> 'shopaccess_owner'",
    );
    expect(owned.rows).toHaveLength(0);
    for (const schema of ["shopaccess", "shopaccess_api"]) {
      for (const role of ["shopaccess_definer", "shopaccess_web", "shopaccess_worker", "shopaccess_operator"]) {
        const { rows } = await db.admin.query("SELECT has_schema_privilege($1, $2, 'CREATE') AS granted", [role, schema]);
        expect(rows[0].granted, `${role} CREATE ${schema}`).toBe(false);
      }
    }
  });

  it("V-24: the worker has nothing, no runtime role can create temporary objects, and memberships are exactly as specified", async () => {
    const worker = await db.admin.query(
      `SELECT has_database_privilege('shopaccess_worker', current_database(), 'CONNECT') AS connect,
              has_schema_privilege('shopaccess_worker', 'shopaccess', 'USAGE') AS tables_schema,
              has_schema_privilege('shopaccess_worker', 'shopaccess_api', 'USAGE') AS api_schema`,
    );
    expect(worker.rows[0]).toEqual({ connect: false, tables_schema: false, api_schema: false });
    const workerGrants = await db.admin.query(
      "SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'shopaccess_worker' UNION ALL SELECT 1 FROM information_schema.role_column_grants WHERE grantee = 'shopaccess_worker'",
    );
    expect(workerGrants.rows).toHaveLength(0);

    for (const role of ["shopaccess_web", "shopaccess_worker", "shopaccess_operator", "shopaccess_definer", db.operatorLogin]) {
      const { rows } = await db.admin.query("SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS granted", [role]);
      expect(rows[0].granted, `${role} TEMPORARY`).toBe(false);
    }
    expect(await sqlState(() => db.web.query("CREATE TEMPORARY TABLE shadow (id integer)"))).toBe(INSUFFICIENT_PRIVILEGE);

    const memberships = await db.admin.query(
      `SELECT m.rolname AS member, g.rolname AS granted
         FROM pg_catalog.pg_auth_members a
         JOIN pg_catalog.pg_roles m ON m.oid = a.member
         JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
        WHERE m.rolname LIKE 'shopaccess%' AND g.rolname LIKE 'shopaccess%'
        ORDER BY 1, 2`,
    );
    const pairs = memberships.rows.map((row) => `${row.member}>${row.granted}`);
    expect(pairs).toContain("shopaccess_owner>shopaccess_definer");
    expect(pairs).toContain(`${db.operatorLogin}>shopaccess_operator`);
    expect(pairs.filter((pair) => /^shopaccess_(web|worker|definer|operator)>/.test(pair))).toEqual([]);

    const columnGrants = await db.admin.query(
      "SELECT grantee, table_name FROM information_schema.role_column_grants WHERE table_schema = 'shopaccess' AND grantee IN ('shopaccess_web', 'shopaccess_operator') AND table_name NOT IN ('merchants', 'merchant_products', 'merchant_variants', 'server_key_versions', 'audit_events')",
    );
    expect(columnGrants.rows).toHaveLength(0);
  });

  it("PGT-88: a web role cannot switch role and cannot shadow objects through its search path", async () => {
    expect(await sqlState(() => db.web.query("SET ROLE shopaccess_definer"))).not.toBeNull();
    expect(await sqlState(() => db.web.query("SET ROLE shopaccess_owner"))).not.toBeNull();
    const client = await db.connectWeb();
    try {
      await client.query("SET search_path = pg_temp, public");
      const { rows } = await client.query(SESSION_STATEMENTS.revokeSession, [1, "0".repeat(64)]);
      expect(rows).toEqual([{ result: "DONE" }]);
    } finally {
      await client.end();
    }
  });
});
