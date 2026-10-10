import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { connectionStartupOptions, PG_CONNECTION_TIMEOUTS } from "@/lib/pg/client";
import { APPROVED_MIGRATIONS, findTransactionControl, listMigrations } from "@/lib/pg/migrate";
import * as statementCatalogue from "@/lib/pg/statements";
import { MIGRATION_STATEMENTS, OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { SESSION_ABSOLUTE_LIFETIME_MS, SESSION_IDLE_TIMEOUT_MS } from "@/lib/session/service";

// Static, database-free checks. Nothing here connects to PostgreSQL or executes SQL.

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
const ARCHIVE_DIR = join(MIGRATIONS_DIR, "archive", "milestone-001-unexecuted");
const BOOTSTRAP = readFileSync(join(ROOT, "db", "bootstrap", "0000_roles_and_schemas.sql"), "utf8");
const PG_SOURCE_DIR = join(ROOT, "src", "lib", "pg");

function filesUnder(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

const listed = listMigrations(MIGRATIONS_DIR);
if (!listed.ok) throw new Error(`Migration discovery failed: ${JSON.stringify(listed.error)}`);
const migrations = listed.value;
const sqlOf = (prefix: string) => migrations.find((file) => file.version.startsWith(prefix))!.sql;
const allSql = migrations.map((file) => file.sql).join("\n");
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

describe("archived Milestone 001 drafts are preserved byte for byte and never discovered", () => {
  // Recorded before the files were moved (see the archive README).
  const RECORDED: Record<string, string> = {
    "0001_shopper_sessions.sql": "b0eb2f4aa2da4f58d7b56f7a9123061728954f599a4df91293400ac7ae13a147",
    "0002_merchant_catalog.sql": "7778686f22e65e954f15082294786ebfa85fb3fbc4047aee83e4be2d126a05cb",
    "0003_carts.sql": "a7b925843395a638e1769205ef2ec2c5e28e9525d4d6eed90ae0862756458d56",
    "0004_checkout_quotes_confirmations.sql": "c84178960064d9b476b24e803e3d682209456737e9c67142f18da0822fbc2a08",
    "0005_payment_operations.sql": "bfcd219c909df07ee972b8bf176e34350f5b7a4841ca23c633f485ac234be33a",
    "0006_audit_events.sql": "a256d8e84dba37ef91ce00797842406dd50b288410cc10e0ab4d216005b9bf67",
  };

  it("holds exactly the six drafts with their recorded checksums", () => {
    const archived = readdirSync(ARCHIVE_DIR).filter((name) => name.endsWith(".sql")).sort();
    expect(archived).toEqual(Object.keys(RECORDED));
    const readme = readFileSync(join(ARCHIVE_DIR, "README.md"), "utf8");
    for (const [name, checksum] of Object.entries(RECORDED)) {
      expect(createHash("sha256").update(readFileSync(join(ARCHIVE_DIR, name))).digest("hex"), name).toBe(checksum);
      expect(readme).toContain(`${checksum}  ${name}`);
    }
  });

  it("the runner lists only the six new migrations and refuses the archive directory", () => {
    expect(migrations.map((file) => file.version)).toEqual([
      "0001_migration_ledger",
      "0002_keys_owners_sessions",
      "0003_merchant_catalog",
      "0004_merchant_catalog_seed",
      "0005_audit_events",
      "0006_session_and_key_functions",
    ]);
    for (const file of migrations) {
      expect(file.path.includes("archive"), file.path).toBe(false);
      expect(file.checksum).toBe(createHash("sha256").update(readFileSync(file.path)).digest("hex"));
    }
    const legacyChecksums = new Set(Object.values(RECORDED));
    expect(migrations.some((file) => legacyChecksums.has(file.checksum))).toBe(false);
    // Every file is pinned: the inventory names exactly these six, with exactly these bytes.
    expect(migrations.map((file) => ({ version: file.version, sha256: file.checksum }))).toEqual([...APPROVED_MIGRATIONS]);
    expect(APPROVED_MIGRATIONS).toHaveLength(6);
    expect(Object.isFrozen(APPROVED_MIGRATIONS)).toBe(true);
    expect(listMigrations(ARCHIVE_DIR)).toMatchObject({ ok: false, error: { code: "ARCHIVE_DIRECTORY_REFUSED" } });
    expect(listMigrations(join(MIGRATIONS_DIR, "archive"))).toMatchObject({ ok: false, error: { code: "ARCHIVE_DIRECTORY_REFUSED" } });
  });
});

describe("Increment 1 migrations: static structure", () => {
  it("contain no transaction control, no DROP and no dynamic SQL", () => {
    for (const migration of migrations) {
      const sql = withoutComments(migration.sql);
      expect(findTransactionControl(migration.sql), migration.version).toBe("NONE");
      expect(sql, migration.version).not.toMatch(/\bDROP\b/i);
      expect(sql, migration.version).not.toMatch(/\bEXECUTE\s+(?:format|pg_catalog\.format|'|\$)/i);
      expect(sql, migration.version).not.toMatch(/\bPASSWORD\b/i);
    }
  });

  it("create exactly nine tables, all in the shopaccess schema", () => {
    const tables = [...withoutComments(allSql).matchAll(/CREATE TABLE ([a-z_.]+)/g)].map((match) => match[1]).sort();
    expect(tables).toEqual([
      "shopaccess.audit_events",
      "shopaccess.checkout_owners",
      "shopaccess.merchant_products",
      "shopaccess.merchant_variants",
      "shopaccess.merchants",
      "shopaccess.schema_migrations",
      "shopaccess.server_key_versions",
      "shopaccess.session_admission_guard",
      "shopaccess.shopper_sessions",
    ]);
    expect(allSql).not.toMatch(/database_environment|carts|checkout_intents|payment_operations|pgcrypto/);
  });

  it("create exactly six entry points and one helper in shopaccess_api, with the fixed search path", () => {
    const sql = withoutComments(sqlOf("0006"));
    const names = [...sql.matchAll(/CREATE FUNCTION shopaccess_api\.([a-z_]+)\(/g)].map((match) => match[1]).sort();
    expect(names).toEqual([
      "activate_key_version",
      "admit_session",
      "authorize_session",
      "revoke_key_version",
      "revoke_session",
      "rotate_session",
      "session_is_live",
    ]);
    const definitions = sql.split(/(?=CREATE FUNCTION )/).filter((part) => part.startsWith("CREATE FUNCTION"));
    expect(definitions).toHaveLength(7);
    for (const definition of definitions) {
      const name = /CREATE FUNCTION shopaccess_api\.([a-z_]+)/.exec(definition)![1];
      const header = definition.slice(0, definition.indexOf("AS $$"));
      expect(header, name).toMatch(/SET search_path = pg_catalog, pg_temp/);
      expect(/SECURITY DEFINER/.test(header), name).toBe(name !== "session_is_live");
      if (name !== "session_is_live") {
        // No entry point takes a time, and every one returns a result code.
        const parameters = header.slice(header.indexOf("(") + 1, header.indexOf(") RETURNS"));
        expect(parameters, name).not.toMatch(/timestamp|interval|date/i);
        expect(header, name).toMatch(/RETURNS TABLE \(result text/);
        expect(definition, name).toMatch(/#variable_conflict use_column/);
      }
    }
    // Every trigger function in the table schema also pins its search path.
    for (const definition of withoutComments(allSql).split(/(?=CREATE FUNCTION )/).filter((part) => part.startsWith("CREATE FUNCTION shopaccess."))) {
      expect(definition).toMatch(/SET search_path = pg_catalog, pg_temp/);
    }
    // No unqualified table reference inside the function bodies.
    for (const table of ["session_admission_guard", "server_key_versions", "checkout_owners", "shopper_sessions", "audit_events"]) {
      expect(sql).not.toMatch(new RegExp(`(?:FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`));
    }
  });

  it("admission counts every remaining session row and never treats a skipped, locked row as expired", () => {
    const sql = withoutComments(sqlOf("0006"));
    const admit = sql.slice(sql.indexOf("CREATE FUNCTION shopaccess_api.admit_session("), sql.indexOf("CREATE FUNCTION shopaccess_api.authorize_session("));
    // Exactly one use of SKIP LOCKED in the whole file: the cleanup DELETE.
    expect([...sql.matchAll(/SKIP LOCKED/g)]).toHaveLength(1);
    expect(admit).toMatch(/DELETE FROM shopaccess\.shopper_sessions[\s\S]*FOR UPDATE OF d SKIP LOCKED/);
    // The capacity count has no WHERE clause: no liveness or time filter can hide a locked row.
    const count = /SELECT count\(\*\)::integer INTO v_occupied([\s\S]*?);/.exec(admit);
    expect(count?.[1].replace(/\s+/g, " ").trim()).toBe("FROM shopaccess.shopper_sessions d");
    expect(admit).toMatch(/IF v_occupied >= c_max_live_sessions THEN/);
    expect([...admit.matchAll(/session_is_live\(/g)]).toHaveLength(1);
    // Order inside the function: guard lock, key lock, decision time, cleanup, count, insert.
    const order = [
      "FROM shopaccess.session_admission_guard g",
      "FROM shopaccess.server_key_versions k",
      "v_t := clock_timestamp();",
      "DELETE FROM shopaccess.shopper_sessions",
      "INTO v_occupied",
      "INSERT INTO shopaccess.shopper_sessions",
    ].map((marker) => admit.indexOf(marker));
    expect(order.every((position) => position > -1)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    // The guard is taken FOR UPDATE and no lock wait is caught: a timeout fails the admission.
    expect(admit).toMatch(/WHERE g\.id = 1\s+FOR UPDATE;/);
    expect(sql).not.toMatch(/lock_not_available|WHEN OTHERS|NOWAIT/i);
    // The lock order is written down where the functions are.
    expect(sqlOf("0006")).toMatch(/Lock acquisition order/);
  });

  it("rotate_session returns the id of the session row it rotated", () => {
    const sql = withoutComments(sqlOf("0006"));
    const rotate = sql.slice(sql.indexOf("CREATE FUNCTION shopaccess_api.rotate_session("), sql.indexOf("CREATE FUNCTION shopaccess_api.revoke_session("));
    expect(rotate).toMatch(/RETURNS TABLE \(result text, session_id text, absolute_expires_at timestamptz, idle_expires_at timestamptz\)/);
    expect(rotate).toMatch(/RETURN QUERY SELECT 'ROTATED'::text, v_id, v_absolute_expires_at, v_t \+ c_idle_timeout;/);
    // v_id is read from the locked row, never from a parameter.
    expect(rotate).toMatch(/SELECT s\.id, s\.revoked_at, s\.absolute_expires_at, s\.last_seen_at\s+INTO v_id,/);
    expect(rotate).not.toMatch(/p_session_id/);
    for (const refusal of rotate.matchAll(/RETURN QUERY SELECT '(NOT_AUTHORIZED|KEY_NOT_ACTIVE)'::text, ([^;]+);/g)) {
      expect(refusal[2]).toBe("NULL::text, NULL::timestamptz, NULL::timestamptz");
    }
  });

  it("hand the functions to shopaccess_definer and take CREATE away again", () => {
    const sql = withoutComments(sqlOf("0006"));
    expect([...sql.matchAll(/ALTER FUNCTION shopaccess_api\.[a-z_]+\([^)]*\) OWNER TO shopaccess_definer;/g)]).toHaveLength(7);
    const grantAt = sql.indexOf("GRANT CREATE ON SCHEMA shopaccess_api TO shopaccess_definer;");
    const revokeAt = sql.indexOf("REVOKE CREATE ON SCHEMA shopaccess_api FROM shopaccess_definer;");
    expect(grantAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(sql.lastIndexOf("OWNER TO shopaccess_definer"));
    expect(grantAt).toBeLessThan(sql.indexOf("OWNER TO shopaccess_definer"));
  });

  it("grant nothing to the worker or to PUBLIC, and no table write to a runtime role", () => {
    const everything = withoutComments(`${BOOTSTRAP}\n${allSql}`);
    const grants = [...everything.matchAll(/GRANT\s+([^;]+?)\s+TO\s+([^;]+);/g)].map((match) => ({ what: match[1], to: match[2] }));
    expect(grants.length).toBeGreaterThan(10);
    for (const grant of grants) {
      expect(grant.to, grant.what).not.toMatch(/shopaccess_worker|PUBLIC/);
      if (/shopaccess_(?:web|operator)/.test(grant.to)) {
        expect(grant.what, grant.to).toMatch(/^(?:SELECT ON|EXECUTE ON FUNCTION|USAGE ON SCHEMA|CONNECT ON DATABASE)/);
      }
    }
    const definerTables = grants.filter((grant) => /shopaccess_definer/.test(grant.to) && / ON shopaccess\./.test(grant.what)).map((grant) => grant.what).sort();
    expect(definerTables).toEqual([
      "INSERT ON shopaccess.audit_events",
      "SELECT, INSERT ON shopaccess.checkout_owners",
      "SELECT, INSERT, UPDATE ON shopaccess.server_key_versions",
      "SELECT, INSERT, UPDATE, DELETE ON shopaccess.shopper_sessions",
      "SELECT, UPDATE ON shopaccess.session_admission_guard",
    ]);
    const execute = grants.filter((grant) => grant.what.startsWith("EXECUTE")).map((grant) => `${/shopaccess_api\.([a-z_]+)/.exec(grant.what)![1]}>${grant.to}`).sort();
    expect(execute).toEqual([
      "activate_key_version>shopaccess_operator",
      "admit_session>shopaccess_web",
      "authorize_session>shopaccess_web",
      "revoke_key_version>shopaccess_operator",
      "revoke_session>shopaccess_web",
      "rotate_session>shopaccess_web",
    ]);
  });

  it("the bootstrap never adopts an existing role: it refuses first, in one transaction, and verifies before commit", () => {
    const sql = withoutComments(BOOTSTRAP);
    const roles = ["shopaccess_owner", "shopaccess_definer", "shopaccess_web", "shopaccess_worker", "shopaccess_operator"];
    const statements = sql.replace(/\$bootstrap\$[\s\S]*?\$bootstrap\$/g, "$body$").split(";").map((statement) => statement.trim()).filter((statement) => statement !== "");

    // One transaction: after any error, nothing later can take effect.
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.filter((statement) => /^(?:BEGIN|COMMIT|ROLLBACK|END|START)\b/.test(statement))).toEqual(["BEGIN", "COMMIT"]);

    // The preflight is the first statement after BEGIN, before any CREATE, GRANT, REVOKE or ALTER.
    expect(statements[1]).toBe("DO $body$");
    const blocks = [...sql.matchAll(/DO \$bootstrap\$([\s\S]*?)\$bootstrap\$;/g)].map((match) => match[1]);
    expect(blocks).toHaveLength(3);
    const [preflight, , verification] = blocks;
    const firstMutation = sql.search(/\b(?:CREATE|GRANT|REVOKE|ALTER)\b/);
    expect(sql.indexOf(preflight)).toBeLessThan(firstMutation);
    expect(preflight).not.toMatch(/\b(?:CREATE|GRANT|REVOKE|ALTER|EXECUTE|UPDATE|INSERT|DELETE|SET)\b/);
    for (const role of roles) expect(preflight, role).toContain(`'${role}'`);
    expect(preflight).toMatch(/FROM pg_catalog\.pg_roles r\s+WHERE r\.rolname IN \(/);
    expect(preflight).toMatch(/IF v_existing IS NOT NULL THEN\s+RAISE EXCEPTION 'ShopAccess bootstrap refused: role\(s\) already exist/);
    expect(preflight).toMatch(/RAISE EXCEPTION 'ShopAccess bootstrap refused: schema\(s\) already exist/);
    // Refusal, never a warning: nothing downgrades or catches the error.
    expect(sql).not.toMatch(/RAISE (?:NOTICE|WARNING|INFO)|EXCEPTION\s+WHEN|ON_ERROR/i);

    // Roles are created unconditionally and statically: no "create only if absent", no dynamic role DDL.
    expect(sql).not.toMatch(/IF NOT EXISTS|CREATE ROLE %|FOREACH/i);
    const created = [...sql.matchAll(/CREATE ROLE ([a-z_]+) ([A-Z ]+);/g)];
    expect(created.map((match) => match[1])).toEqual(roles);
    for (const match of created) {
      expect(match[2], match[1]).toBe("NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
    }
    expect([...sql.matchAll(/\bCREATE ROLE\b/g)]).toHaveLength(5);
    expect(sql).not.toMatch(/\bALTER ROLE\b|\bDROP\b/);
    // The only dynamic statements name the current database, quoted as an identifier.
    for (const dynamic of sql.matchAll(/EXECUTE pg_catalog\.format\(\s*'([^']+)'/g)) {
      expect(dynamic[1]).toMatch(/^(?:REVOKE ALL|GRANT CONNECT) ON DATABASE %I /);
    }

    // The closing verification runs after every mutation and before COMMIT.
    const lastMutation = Math.max(...[...sql.matchAll(/\b(?:CREATE|GRANT|REVOKE|ALTER) /g)].map((match) => match.index));
    expect(sql.indexOf(verification)).toBeGreaterThan(lastMutation);
    for (const attribute of ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls", "rolcanlogin"]) {
      expect(verification, attribute).toContain(`r.${attribute}`);
    }
    expect(verification).toMatch(/pg_catalog\.pg_auth_members/);
    expect(verification).toMatch(/NOT a\.admin_option AND NOT a\.inherit_option AND a\.set_option/);
    expect([...verification.matchAll(/RAISE EXCEPTION/g)]).toHaveLength(3);
  });

  it("the bootstrap creates five roles without login or credentials, two schemas, and revokes PUBLIC", () => {
    const sql = withoutComments(BOOTSTRAP);
    for (const role of ["shopaccess_owner", "shopaccess_definer", "shopaccess_web", "shopaccess_worker", "shopaccess_operator"]) {
      expect(BOOTSTRAP).toContain(`'${role}'`);
    }
    expect(sql).toMatch(/NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE/);
    expect(sql).not.toMatch(/\bPASSWORD\b|\bLOGIN\b(?<!NOLOGIN)/);
    expect(sql).toMatch(/CREATE SCHEMA shopaccess AUTHORIZATION shopaccess_owner;/);
    expect(sql).toMatch(/CREATE SCHEMA shopaccess_api AUTHORIZATION shopaccess_owner;/);
    expect(sql).toMatch(/REVOKE ALL ON DATABASE %I FROM PUBLIC/);
    expect(sql).not.toMatch(/GRANT[^;]*TEMP/i);
    expect(sql).toMatch(/GRANT shopaccess_definer TO shopaccess_owner WITH INHERIT FALSE, SET TRUE;/);
    // The only role membership granted anywhere.
    expect([...withoutComments(`${BOOTSTRAP}\n${allSql}`).matchAll(/GRANT shopaccess_[a-z]+ TO /g)]).toHaveLength(1);
  });

  it("carry the owner-approved Increment 1 values, consistently with the Mock constants", () => {
    const functions = sqlOf("0006");
    expect(SESSION_IDLE_TIMEOUT_MS).toBe(2 * 60 * 60 * 1000);
    expect(SESSION_ABSOLUTE_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
    expect(functions).toMatch(/c_max_admissions\s+constant integer\s+:= 30;/);
    expect(functions).toMatch(/c_max_live_sessions constant integer\s+:= 500;/);
    expect(functions).toMatch(/c_window\s+constant interval := interval '1 minute';/);
    expect(functions).toMatch(/c_absolute_lifetime constant interval := interval '24 hours';/);
    expect(functions).toMatch(/c_touch_threshold constant interval := interval '60 seconds';/);
    // The idle timeout appears in the trigger, the helper and each function that reports it, always as 2 hours.
    expect(sqlOf("0002")).toMatch(/c_idle_timeout constant interval := interval '2 hours';/);
    expect(functions).toMatch(/p_t < p_last_seen_at \+ interval '2 hours'/);
    for (const match of `${sqlOf("0002")}\n${functions}`.matchAll(/c_idle_timeout\s+constant interval := interval '([^']+)'/g)) {
      expect(match[1]).toBe("2 hours");
    }
    expect(sqlOf("0002")).toMatch(/absolute_expires_at <= created_at \+ interval '24 hours'/);
    expect(PG_CONNECTION_TIMEOUTS).toEqual({ lockTimeoutMs: 2000, statementTimeoutMs: 5000, idleInTransactionSessionTimeoutMs: 10000 });
    expect(connectionStartupOptions()).toBe("-c lock_timeout=2000 -c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000");
  });

  it("write exactly two audit event types, and only on success", () => {
    const functions = withoutComments(sqlOf("0006"));
    const written = [...functions.matchAll(/'(KEY_[A-Z_]+|[A-Z]+_[A-Z_]*(?:ACTIVATED|REVOKED|ADMITTED|REJECTED|ISSUED))'/g)].map((match) => match[1]);
    expect([...new Set(written.filter((name) => name.startsWith("KEY_VERSION_")))].sort()).toEqual(["KEY_VERSION_ACTIVATED", "KEY_VERSION_REVOKED"]);
    expect([...functions.matchAll(/INSERT INTO shopaccess\.audit_events/g)]).toHaveLength(2);
    // The owner id is generated in the database and no function returns it.
    expect(functions).toMatch(/v_owner_id := 'own_' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\);/);
    expect(functions).not.toMatch(/RETURNS TABLE \([^)]*owner/);
    // Audit detail carries no check value, digest or token.
    for (const detail of functions.matchAll(/jsonb_build_object\(([^;]+?)\)\);/g)) {
      expect(detail[1]).not.toMatch(/check_value|token|digest|secret/i);
    }
  });

  it("add no catalog restriction beyond the archived draft and name no revision number in a CHECK", () => {
    const catalog = withoutComments(sqlOf("0003"));
    const legacy = readFileSync(join(ARCHIVE_DIR, "0002_merchant_catalog.sql"), "utf8");
    const checks = (sql: string) => [...sql.matchAll(/CHECK \((.+)\)[,\n]/g)].map((match) => match[1].trim()).sort();
    expect(checks(catalog)).toEqual(checks(withoutComments(legacy)));
    expect([...catalog.matchAll(/catalog_revision[^,\n]*/g)].every((match) => /CHECK \(catalog_revision > 0\)/.test(match[0]))).toBe(true);
    expect(catalog).toMatch(/unit_amount_cents\s+integer NOT NULL CHECK \(unit_amount_cents > 0 AND unit_amount_cents <= 2000000\)/);
  });

  it("PGT-84 (static part): the seed migration carries every fixture value", () => {
    const seed = sqlOf("0004");
    const catalog = DEMO_MERCHANT_CATALOG;
    expect(seed).toContain(`'${catalog.merchant.merchantId}', '${catalog.merchant.displayName}', true`);
    for (const product of catalog.products) {
      expect(seed).toContain(`('${product.productId}', '${catalog.merchant.merchantId}', '${product.title}',`);
      expect(seed).toContain(`'${product.description}'`);
      expect(seed).toContain(`'${product.imagePath}', ${catalog.revision})`);
      for (const variant of product.variants) {
        expect(seed).toContain(
          `('${variant.variantId}', '${product.productId}', '${variant.label}', ${variant.unitAmountCents}, '${variant.currency}', ${variant.maxQuantityPerOrder}, '${variant.availability}',`,
        );
        expect(seed).toContain(`'${JSON.stringify(variant.specs)}'::jsonb, ${catalog.revision})`);
      }
    }
    const variantCount = catalog.products.reduce((total, product) => total + product.variants.length, 0);
    expect([...seed.matchAll(/\('dmv_/g)]).toHaveLength(variantCount);
    expect([...seed.matchAll(/\('dmp_/g)]).toHaveLength(catalog.products.length);
  });
});

describe("the PostgreSQL library is isolated: SQL only in the catalogue, no environment access, not wired in", () => {
  const sources = filesUnder(PG_SOURCE_DIR, /\.ts$/);
  const CATALOGUE = join(PG_SOURCE_DIR, "statements.ts");
  // The same rule as SQL-01: any letter case; keywords may be on different lines, within one source statement.
  const SQL_TEXT = /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;]*?\b(?:FROM|SET|VALUES)\b/i;

  it("consists of exactly the six approved modules", () => {
    expect(sources.map((file) => file.slice(PG_SOURCE_DIR.length + 1)).sort()).toEqual([
      "client.ts",
      "key-ring.ts",
      "migrate.ts",
      "session-cookie.ts",
      "session-service.ts",
      "statements.ts",
    ]);
  });

  it("keeps SQL text in statements.ts only, reads no environment variable and never imports the legacy query module", () => {
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      // The rule SQL-01 applies to every module under src, with statements.ts as its one exact exception.
      expect(SQL_TEXT.test(text), file).toBe(file === CATALOGUE);
      expect(text, file).not.toMatch(/process\.env/);
      expect(text, file).not.toMatch(/["'][^"']*\/db\/queries["']|["']@\/lib\/db/);
      expect(text, file).not.toMatch(/\$\{[^}]*\}[^\n]*\b(?:WHERE|FROM)\b/);
    }
  });

  it("SQL-01 allows exactly two files: the legacy query module and the statement catalogue", () => {
    const sqlModules = filesUnder(join(ROOT, "src"), /\.(ts|tsx)$/)
      .filter((file) => SQL_TEXT.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(ROOT.length + 1))
      .sort();
    expect(sqlModules).toEqual([join("src", "lib", "db", "queries.ts"), join("src", "lib", "pg", "statements.ts")]);
    const sql01 = readFileSync(join(ROOT, "tests", "unit", "environment.test.ts"), "utf8");
    expect(sql01).toContain('const SQL_MODULES: readonly string[] = [join(ROOT, "src", "lib", "db", "queries.ts"), join(ROOT, "src", "lib", "pg", "statements.ts")];');
    expect(sql01).toContain("!SQL_MODULES.includes(file) && containsSqlText(source)");
    // The same pattern is used there, and it is not confined to one line.
    expect(sql01).toContain(`const SQL_TEXT = ${String(SQL_TEXT)};`);
    expect(SQL_TEXT.test("`SELECT a\n  FROM b`")).toBe(true);
    // And it ignores letter case.
    expect(SQL_TEXT.flags).toBe("i");
    for (const sample of ["`select a\n  from b`", '"Select a From b"', '"update t set a = $1"', "`insert\n into t values ($1)`", '"Delete From t where a in (select 1 from u)"']) {
      expect(SQL_TEXT.test(sample), sample).toBe(true);
    }
    // No directory-wide or name-suffix exception.
    expect(sql01).not.toMatch(/join\(ROOT, "src", "lib", "pg"\)\)|startsWith\(|endsWith\(join\(/);
  });

  it("is imported by nothing in the application: Increment 1 is not wired in", () => {
    for (const file of filesUnder(join(ROOT, "src"), /\.(ts|tsx)$/)) {
      if (file.startsWith(PG_SOURCE_DIR)) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(/["'](?:@\/lib\/pg|[./]+\/pg)\//);
    }
    // And the Mock runtime still builds on the in-memory stores only.
    const runtime = readFileSync(join(ROOT, "src", "server", "runtime.ts"), "utf8");
    expect(runtime).toMatch(/new InMemorySessionStore\(\)/);
    expect(runtime).not.toMatch(/\bpg\b|Pool|shopaccess_api/);
  });
});

describe("statement catalogue: immutable, parameterized, schema-qualified, and the only definition", () => {
  const source = readFileSync(join(PG_SOURCE_DIR, "statements.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const groups = { SESSION_STATEMENTS, OPERATOR_STATEMENTS, MIGRATION_STATEMENTS };
  const all: Record<string, string> = { ...SESSION_STATEMENTS, ...OPERATOR_STATEMENTS, ...MIGRATION_STATEMENTS };

  it("exports exactly three frozen groups and nothing that could build a statement", () => {
    expect(Object.keys(statementCatalogue).sort()).toEqual(["MIGRATION_STATEMENTS", "OPERATOR_STATEMENTS", "SESSION_STATEMENTS"]);
    for (const [name, group] of Object.entries(groups)) {
      expect(Object.isFrozen(group), name).toBe(true);
      for (const text of Object.values(group)) expect(typeof text, name).toBe("string");
    }
    expect(() => {
      "use strict";
      (SESSION_STATEMENTS as { admitSession: string }).admitSession = "changed";
    }).toThrow(TypeError);
    // Plain string literals only: no template literal, interpolation, concatenation, function or import.
    expect(code).not.toMatch(/`|\$\{/);
    expect(code).not.toMatch(/"\s*\+|\+\s*"|\.concat\(|\.join\(|\.replace\(/);
    expect(code).not.toMatch(/=>|\bfunction\b|\bimport\b|\brequire\b|\bclass\b/);
  });

  it("uses numbered placeholders only, numbered from $1 without gaps, matching each call's arity", () => {
    const arity: Record<string, number> = {
      admitSession: 3,
      authorizeSession: 2,
      rotateSession: 4,
      revokeSession: 2,
      readKeyVersions: 1,
      activateKeyVersion: 3,
      revokeKeyVersion: 2,
      begin: 0,
      commit: 0,
      rollback: 0,
      lockMigrations: 0,
      ledgerExists: 0,
      readLedger: 0,
      recordMigration: 2,
    };
    expect(Object.keys(all).sort()).toEqual(Object.keys(arity).sort());
    for (const [name, text] of Object.entries(all)) {
      const placeholders = [...new Set(text.match(/\$\d+/g) ?? [])].sort();
      expect(placeholders, name).toEqual(Array.from({ length: arity[name] }, (_unused, index) => `$${index + 1}`));
      // No quoted value other than the one fixed regclass name, and no statement separator or comment.
      expect(text.replace("'shopaccess.schema_migrations'", ""), name).not.toMatch(/['";]|--|\/\*/);
    }
  });

  it("qualifies every object with its schema and calls each entry point exactly once", () => {
    for (const [name, text] of Object.entries(all)) {
      if (["begin", "commit", "rollback"].includes(name)) continue;
      for (const reference of text.matchAll(/\b(?:FROM|INTO)\s+([a-z_.]+)/g)) {
        expect(reference[1], name).toMatch(/^(?:shopaccess|shopaccess_api)\.[a-z_]+$/);
      }
      for (const call of text.matchAll(/(?<![a-z_.])([a-z_]+)\(/g)) {
        expect(["count"].includes(call[1]) || text.includes(`pg_catalog.${call[1]}(`) || text.includes(`shopaccess_api.${call[1]}(`), `${name}: ${call[1]}`).toBe(true);
      }
    }
    expect({ ...MIGRATION_STATEMENTS }).toMatchObject({ begin: "BEGIN", commit: "COMMIT", rollback: "ROLLBACK" });
    const entryPoints = Object.values({ ...SESSION_STATEMENTS, ...OPERATOR_STATEMENTS })
      .map((text) => /shopaccess_api\.([a-z_]+)\(/.exec(text)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort();
    expect(entryPoints).toEqual(["activate_key_version", "admit_session", "authorize_session", "revoke_key_version", "revoke_session", "rotate_session"]);
    // Each statement selects exactly the columns its function returns (migration 0006).
    const functions = sqlOf("0006").replace(/--[^\n]*/g, "");
    for (const text of Object.values({ ...SESSION_STATEMENTS, ...OPERATOR_STATEMENTS })) {
      const call = /^SELECT (.+) FROM shopaccess_api\.([a-z_]+)\(/.exec(text);
      if (!call) continue;
      const returns = new RegExp(`CREATE FUNCTION shopaccess_api\\.${call[2]}\\([^)]*\\) RETURNS TABLE \\(([^)]*)\\)`).exec(functions);
      expect(returns?.[1].split(",").map((column) => column.trim().split(" ")[0]), call[2]).toEqual(call[1].split(", "));
    }
  });

  it("is the only definition: neither the library nor the database tests carry a second copy", () => {
    const elsewhere = [
      ...filesUnder(PG_SOURCE_DIR, /\.ts$/).filter((file) => !file.endsWith("statements.ts")),
      ...filesUnder(join(ROOT, "tests", "db"), /\.ts$/),
    ];
    for (const file of elsewhere) {
      const text = readFileSync(file, "utf8");
      for (const entryPoint of ["admit_session", "authorize_session", "rotate_session", "revoke_session", "activate_key_version", "revoke_key_version"]) {
        expect(text, `${file}: ${entryPoint}`).not.toMatch(new RegExp(`FROM shopaccess_api\\.${entryPoint}\\(`));
      }
      expect(text, file).not.toMatch(/pg_advisory_xact_lock|INSERT INTO shopaccess\.schema_migrations \(version, checksum, applied_at\) VALUES \(\$1/);
    }
    const harness = readFileSync(join(ROOT, "tests", "db", "harness.ts"), "utf8");
    expect(harness).not.toMatch(/INCREMENT_1_STATEMENTS|export const [A-Z_]*STATEMENTS/);
  });
});
