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
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.owner, row.proname).toBe("shopaccess_definer");
      expect(row.proconfig, row.proname).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(row.prosecdef, row.proname).toBe(row.proname !== "session_is_live");
    }
  });

  it("PGT-88: the function owner holds exactly its table privileges, owns no table and can create nothing", async () => {
    const grants = await db.admin.query(
      "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'shopaccess_definer' AND table_schema = 'shopaccess' ORDER BY table_name, privilege_type",
    );
    expect(grants.rows.map((row) => `${row.table_name}:${row.privilege_type}`)).toEqual([
      "audit_events:INSERT",
      "checkout_owners:INSERT",
      "checkout_owners:SELECT",
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
