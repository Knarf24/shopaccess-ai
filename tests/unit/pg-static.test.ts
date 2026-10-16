import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { connectionStartupOptions, PG_CONNECTION_TIMEOUTS } from "@/lib/pg/client";
import { APPROVED_MIGRATIONS, findTransactionControl, listMigrations } from "@/lib/pg/migrate";
import * as statementCatalogue from "@/lib/pg/statements";
import { APPLICATION_STATEMENTS, CHECKOUT_STATEMENTS, MIGRATION_STATEMENTS, OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { INITIAL_PAYMENT_SNAPSHOT, transition, type PaymentEvent, type PaymentSnapshot } from "@/lib/payment/state-machine";
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

const APPROVED_CHECKOUT_CATALOGUE_FILES = new Set([
  join("src", "lib", "pg", "checkout-service.ts"),
  join("src", "lib", "pg", "statements.ts"),
]);

/** Executable TypeScript references to the checkout catalogue, excluding comments and string contents. */
function checkoutCatalogueReferenceFiles(sources: readonly { readonly path: string; readonly text: string }[]): string[] {
  const found = new Set<string>();
  for (const entry of sources) {
    const source = ts.createSourceFile(entry.path, entry.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "CHECKOUT_STATEMENTS") found.add(entry.path.slice(ROOT.length + 1));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found].sort();
}

function unauthorizedCheckoutCatalogueReferences(sources: readonly { readonly path: string; readonly text: string }[]): string[] {
  return checkoutCatalogueReferenceFiles(sources).filter((file) => !APPROVED_CHECKOUT_CATALOGUE_FILES.has(file));
}

const MUTATING_CHECKOUT_STATEMENTS = new Set(["startCheckout", "cancelCheckout", "issueChallenge", "consumeChallenge"]);
/** The two names under which the checkout catalogue is reachable in the service: its import and its local alias. */
const CHECKOUT_CATALOGUE_NAMES = new Set(["statements", "CHECKOUT_STATEMENTS"]);

/**
 * Where a mutating checkout statement is named, and whether it is named in the one supported form.
 *
 * The supported form is the service's own: inside a method of the service object, the statement is the text of a
 * `.query(...)` call that is awaited where it is made and kept in a variable of that statement,
 * `const reply = await db.query(statements.startCheckout, [...]);`, and that call is inside no other call.
 * Everything else is a violation: the statement kept in a variable or handed on; a query call that is returned or
 * left as the body of a function instead of being awaited in place; a query call inside an arrow function or a
 * function expression, which is how a call is extracted and handed to a retry or transaction helper; and a query
 * call nested in any other call.
 *
 * This is a narrow rule about the structure of one file, not an analysis of everything the program could do. It
 * does not follow values through variables, and it does not look at who calls the service's methods.
 */
function checkoutMutationSites(sourceText: string): { readonly direct: string[]; readonly violations: string[] } {
  const source = ts.createSourceFile("checkout-boundary-control.ts", sourceText, ts.ScriptTarget.Latest, true);
  const direct: string[] = [];
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && CHECKOUT_CATALOGUE_NAMES.has(node.expression.text) && MUTATING_CHECKOUT_STATEMENTS.has(node.name.text)) {
      const name = node.name.text;
      const call = node.parent;
      const found: string[] = [];
      if (!(ts.isCallExpression(call) && call.arguments[0] === node && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "query")) {
        found.push(`${name}: the statement is used other than as the text of a query call`);
      } else {
        const awaited = call.parent;
        if (!(ts.isAwaitExpression(awaited) && ts.isVariableDeclaration(awaited.parent) && awaited.parent.initializer === awaited)) {
          found.push(`${name}: the query call is not awaited where it is made and kept in a variable`);
        }
        let enclosing: ts.Node | undefined = call.parent;
        while (enclosing !== undefined && !ts.isFunctionLike(enclosing)) enclosing = enclosing.parent;
        if (enclosing === undefined || !ts.isMethodDeclaration(enclosing) || !ts.isObjectLiteralExpression(enclosing.parent)) {
          found.push(`${name}: the query call is not made directly in a method of the service object`);
        }
        for (let parent: ts.Node | undefined = call.parent; parent !== undefined; parent = parent.parent) {
          if (ts.isCallExpression(parent)) {
            found.push(`${name}: the query call is inside another call`);
            break;
          }
        }
      }
      if (found.length === 0) direct.push(name);
      else violations.push(...found);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { direct: direct.sort(), violations };
}

/** True when a mutating checkout statement is named anywhere but in the one supported form. */
function hasWrappedCheckoutMutation(sourceText: string): boolean {
  return checkoutMutationSites(sourceText).violations.length > 0;
}

function hasCallNamed(sourceText: string, name: string): boolean {
  const source = ts.createSourceFile("checkout-call-control.ts", sourceText, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if ((ts.isIdentifier(expression) && expression.text === name) ||
          (ts.isPropertyAccessExpression(expression) && expression.name.text === name)) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function placeholderIndexes(text: string): number[] {
  return [...new Set(text.match(/\$\d+/g) ?? [])]
    .map((placeholder) => Number(placeholder.slice(1)))
    .sort((left, right) => left - right);
}

function matchesPlaceholderArity(text: string, arity: number): boolean {
  return JSON.stringify(placeholderIndexes(text)) === JSON.stringify(Array.from({ length: arity }, (_unused, index) => index + 1));
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

  it("the runner lists only the nine approved migrations and refuses the archive directory", () => {
    expect(migrations.map((file) => file.version)).toEqual([
      "0001_migration_ledger",
      "0002_keys_owners_sessions",
      "0003_merchant_catalog",
      "0004_merchant_catalog_seed",
      "0005_audit_events",
      "0006_session_and_key_functions",
      "0007_checkout_schema",
      "0008_checkout_functions",
      "0009_confirmation_functions",
    ]);
    for (const file of migrations) {
      expect(file.path.includes("archive"), file.path).toBe(false);
      expect(file.checksum).toBe(createHash("sha256").update(readFileSync(file.path)).digest("hex"));
    }
    const legacyChecksums = new Set(Object.values(RECORDED));
    expect(migrations.some((file) => legacyChecksums.has(file.checksum))).toBe(false);
    // Every file is pinned: the inventory names exactly these nine, with exactly these bytes.
    expect(migrations.map((file) => ({ version: file.version, sha256: file.checksum }))).toEqual([...APPROVED_MIGRATIONS]);
    expect(APPROVED_MIGRATIONS).toHaveLength(9);
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
      // No migration removes anything and none changes the role it runs under, with one exception: migration 0009
      // removes the 33-column read_checkout, as its owner, to put the 41-column one in its place, and then names the
      // migration role again. Exactly these three statements, and nothing wider (PGT-227 checks where they stand).
      const confirmation = migration.version === "0009_confirmation_functions";
      expect([...sql.matchAll(/\bDROP\b[^;]*;/gi)].map((match) => match[0]), migration.version).toEqual(confirmation ? ["DROP FUNCTION shopaccess_api.read_checkout(smallint, text, text);"] : []);
      expect([...sql.matchAll(/\b(?:SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE|RESET\s+ROLE|(?:SET|RESET)\s+SESSION\s+AUTHORIZATION)\b[^;]*;/gi)].map((match) => match[0]), migration.version).toEqual(
        confirmation ? ["SET ROLE shopaccess_definer;", "SET ROLE shopaccess_owner;"] : [],
      );
      expect(sql, migration.version).not.toMatch(/\bEXECUTE\s+(?:format|pg_catalog\.format|'|\$)/i);
      expect(sql, migration.version).not.toMatch(/\bPASSWORD\b/i);
    }
  });

  it("create exactly sixteen tables, all in the shopaccess schema", () => {
    const tables = [...withoutComments(allSql).matchAll(/CREATE TABLE ([a-z_.]+)/g)].map((match) => match[1]).sort();
    expect(tables).toEqual([
      "shopaccess.audit_events",
      "shopaccess.checkout_intents",
      "shopaccess.checkout_owners",
      "shopaccess.checkout_transitions",
      "shopaccess.confirmation_challenges",
      "shopaccess.merchant_products",
      "shopaccess.merchant_variants",
      "shopaccess.merchants",
      "shopaccess.owner_request_windows",
      "shopaccess.purchase_groups",
      "shopaccess.quote_items",
      "shopaccess.quotes",
      "shopaccess.schema_migrations",
      "shopaccess.server_key_versions",
      "shopaccess.session_admission_guard",
      "shopaccess.shopper_sessions",
    ]);
    expect(allSql).not.toMatch(/database_environment|carts|payment_operations|pgcrypto/);
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
    expect(definerTables).toEqual(
      [
        // Increment 1 (migration 0006).
        "INSERT ON shopaccess.audit_events",
        "SELECT, INSERT ON shopaccess.checkout_owners",
        "SELECT, INSERT, UPDATE ON shopaccess.server_key_versions",
        "SELECT, INSERT, UPDATE, DELETE ON shopaccess.shopper_sessions",
        "SELECT, UPDATE ON shopaccess.session_admission_guard",
        // Increment 2.1 (migration 0008; specification 19.13). No DELETE on any checkout table; UPDATE on the request
        // windows by column only; SELECT only on the catalog and on the challenges.
        "SELECT ON shopaccess.merchants",
        "SELECT ON shopaccess.merchant_products",
        "SELECT ON shopaccess.merchant_variants",
        "UPDATE ON shopaccess.checkout_owners",
        "SELECT, INSERT ON shopaccess.purchase_groups",
        "SELECT, INSERT, UPDATE ON shopaccess.checkout_intents",
        "SELECT, INSERT ON shopaccess.quotes",
        "SELECT, INSERT ON shopaccess.quote_items",
        "SELECT, INSERT ON shopaccess.checkout_transitions",
        "SELECT ON shopaccess.confirmation_challenges",
        "SELECT, INSERT ON shopaccess.owner_request_windows",
        "UPDATE (window_started_at, window_calls, window_throttled, total_throttled, updated_at) ON shopaccess.owner_request_windows",
        // Increment 2.2 (migration 0009): a challenge may be inserted and ended. UPDATE by column only: the status
        // and the three times that go with it. Still no DELETE.
        "INSERT ON shopaccess.confirmation_challenges",
        "UPDATE (status, consumed_at, superseded_at, expired_marked_at) ON shopaccess.confirmation_challenges",
      ].sort(),
    );
    const execute = grants.filter((grant) => grant.what.startsWith("EXECUTE")).map((grant) => `${/shopaccess_api\.([a-z_]+)/.exec(grant.what)![1]}>${grant.to}`).sort();
    expect(execute).toEqual(
      [
        "activate_key_version>shopaccess_operator",
        "admit_session>shopaccess_web",
        "authorize_session>shopaccess_web",
        "revoke_key_version>shopaccess_operator",
        "revoke_session>shopaccess_web",
        "rotate_session>shopaccess_web",
        // The four entry points of migration 0008. No internal helper is granted to any role.
        "cancel_checkout>shopaccess_web",
        "list_owner_checkouts>shopaccess_web",
        "read_checkout>shopaccess_web",
        "start_checkout>shopaccess_web",
        // Migration 0009: the recreated reader is granted again, and the two confirmation entry points.
        "consume_challenge>shopaccess_web",
        "issue_challenge>shopaccess_web",
        "read_checkout>shopaccess_web",
      ].sort(),
    );
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

  it("PGT-84 (static part): the pinned seed stays the Increment 1 placeholder catalog", () => {
    const seed = sqlOf("0004");
    const catalog = DEMO_MERCHANT_CATALOG;
    // 0004 was applied on disposable Increment 1 clusters and remains checksum-pinned.
    // The application fixture moved to revision 2 and is not written back into that migration.
    expect(catalog.revision).toBe(2);
    expect(seed).toContain(`'${catalog.merchant.merchantId}', '${catalog.merchant.displayName}', true`);
    expect(seed).toContain("StudyBook 14");
    expect(seed).toContain("CodeBook 15");
    expect(seed).toContain("ValueBook 11");
    expect(seed).toContain("CampusBook 16");
    expect([...seed.matchAll(/\('dmp_/g)]).toHaveLength(4);
    expect([...seed.matchAll(/\('dmv_/g)]).toHaveLength(5);
    for (const product of catalog.products) {
      expect(seed).not.toContain(product.productId);
      expect(seed).not.toContain(product.title);
    }
  });
});

/**
 * Separates the top-level code of a SQL file from its dollar-quoted bodies by scanning characters, as the
 * migration runner does. Comments, quoted text and quoted identifiers are each replaced by a space, and each
 * dollar-quoted body is taken out and returned on its own. Throws when a comment, a quoted text or a body is not
 * terminated. It does not understand backslash escapes in E'' strings, so the tests below first check that the file
 * they scan has none.
 */
function sqlLayers(sql: string): { code: string; bodies: string[] } {
  let code = "";
  const bodies: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const pair = sql.slice(index, index + 2);
    if (pair === "--") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      code += " ";
    } else if (pair === "/*") {
      let depth = 1;
      index += 2;
      while (depth > 0) {
        if (index >= sql.length) throw new Error("unterminated block comment");
        const inner = sql.slice(index, index + 2);
        if (inner === "/*") {
          depth += 1;
          index += 2;
        } else if (inner === "*/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      code += " ";
    } else if (character === "'" || character === '"') {
      index += 1;
      for (;;) {
        if (index >= sql.length) throw new Error("unterminated quoted text");
        if (sql[index] === character && sql[index + 1] === character) {
          index += 2;
        } else if (sql[index] === character) {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      code += " ";
    } else if (character === "$" && !/[A-Za-z0-9_]/.test(sql[index - 1] ?? " ")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index, index + 80))?.[0];
      if (!tag) {
        code += character;
        index += 1;
      } else {
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) throw new Error("unterminated dollar-quoted body");
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

/** The top-level statements of a file, without comments, quoted text or bodies, each on one line. */
const topLevelStatements = (sql: string): string[] =>
  sqlLayers(sql)
    .code.split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter((statement) => statement !== "");

/** The top-level code first, then the code of every dollar-quoted body, however deeply nested. */
const executableText = (sql: string): string[] => {
  const layers = sqlLayers(sql);
  return [layers.code, ...layers.bodies.flatMap(executableText)];
};

describe("Increment 2.1 schema migration: static security checks", () => {
  const SCHEMA_MIGRATION = "0007_checkout_schema";
  const FUNCTIONS_MIGRATION = "0008_checkout_functions";
  // The Increment 2.1 migration files that exist: the schema file and the functions file.
  const INCREMENT_2_1_MIGRATIONS = [SCHEMA_MIGRATION, FUNCTIONS_MIGRATION];
  const E_STRING = /(?<![A-Za-z0-9_])[eE]'/;
  const sqlOfVersion = (version: string) => migrations.find((file) => file.version === version)!.sql;

  it("the scanner tells top-level statements from comments, quoted text and function bodies", () => {
    const sample = [
      "-- GRANT a",
      "/* DELETE FROM a; */ CREATE TABLE a (b text DEFAULT 'INSERT INTO a; GRANT');",
      "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN UPDATE a SET b = 'x'; RETURN NEW; END; $$;",
      "INSERT INTO a VALUES ('x');",
    ].join("\n");
    expect(topLevelStatements(sample)).toEqual([
      "CREATE TABLE a (b text DEFAULT )",
      "CREATE FUNCTION f() RETURNS trigger AS",
      "INSERT INTO a VALUES ( )",
    ]);
    const [topLevel, ...bodies] = executableText(sample);
    expect(topLevel).not.toMatch(/GRANT|DELETE|UPDATE/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/UPDATE a SET b =/);
    expect(() => sqlLayers("SELECT 'open")).toThrow();
    expect(() => sqlLayers("CREATE FUNCTION f() AS $$ BEGIN")).toThrow();
    expect(() => sqlLayers("/* open")).toThrow();
  });

  it("PGT-154: the schema migration contains no GRANT, at top level or inside a function body", () => {
    const sql = sqlOfVersion(SCHEMA_MIGRATION);
    expect(sql).not.toMatch(E_STRING);
    const texts = executableText(sql);
    // Five trigger functions, so five bodies besides the top-level code.
    expect(texts).toHaveLength(6);
    for (const text of texts) expect(text).not.toMatch(/\bGRANT\b/i);
    // No function body runs a dynamic statement, so no GRANT can be put together from quoted text.
    for (const body of texts.slice(1)) expect(body).not.toMatch(/\bEXECUTE\b/i);
    // The same reading finds the grants of an Increment 1 file, so it is able to find one here.
    expect(executableText(sqlOfVersion("0002_keys_owners_sessions")).some((text) => /\bGRANT\b/i.test(text))).toBe(true);
  });

  const ROW_WRITE = /^(?:INSERT|UPDATE|DELETE)\b/i;
  // Every statement form the schema file uses. Anything else at top level is refused, which also keeps out
  // the indirect ways of writing a row while a migration is applied: DO, WITH, MERGE, COPY, SELECT and CALL.
  const SCHEMA_STATEMENT = /^(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX|CREATE FUNCTION|REVOKE ALL ON FUNCTION|CREATE (?:CONSTRAINT )?TRIGGER) /;
  const TABLE_HEAD = /^CREATE TABLE [a-z_]+\.[a-z_]+ \(/;
  const QUERY_KEYWORD = /\b(?:SELECT|WITH|VALUES|EXECUTE)\b/i;

  /**
   * True only for the one CREATE TABLE form the schema file uses: a schema-qualified name, then one parenthesized
   * list of column and constraint definitions that ends the statement. CREATE TABLE ... AS fills the new table from
   * a query, which may itself write rows, so it must not pass. Such a statement either has no parenthesis right
   * after the name or has text after the closing one, and both are refused here; so is any query keyword. The
   * statement is read as `topLevelStatements` returns it, so a comment or quoted text cannot open or close a
   * parenthesis or supply a keyword. Every other form of CREATE TABLE is refused as well, not guessed at.
   */
  const isExplicitTableDefinition = (statement: string): boolean => {
    const head = TABLE_HEAD.exec(statement)?.[0];
    if (!head || QUERY_KEYWORD.test(statement)) return false;
    let depth = 0;
    for (let index = head.length - 1; index < statement.length; index += 1) {
      if (statement[index] === "(") {
        depth += 1;
      } else if (statement[index] === ")") {
        depth -= 1;
        // The list that opened after the name has closed: nothing may follow it.
        if (depth === 0) return index === statement.length - 1;
      }
    }
    return false;
  };

  /** Why PGT-156 refuses a top-level statement, or null when the statement is one the schema file may contain. */
  const schemaStatementRefusal = (statement: string): string | null => {
    if (ROW_WRITE.test(statement)) return "top-level row write";
    if (!SCHEMA_STATEMENT.test(statement)) return "statement form not allowed";
    if (statement.startsWith("CREATE TABLE ") && !isExplicitTableDefinition(statement)) return "CREATE TABLE is not an explicit column definition";
    return null;
  };
  const refusalsOf = (sql: string): Array<string | null> => topLevelStatements(sql).map(schemaStatementRefusal);

  // Every statement form the functions file uses, each spelled out to its end. It carries the privileges of 19.13,
  // so it grants and revokes, but only in these forms: EXECUTE on the four entry points to the web role; SELECT,
  // INSERT and UPDATE (never DELETE or TRUNCATE) on a table of the schema to the function owner; and the hand-over.
  // Anything else at top level is refused, as in the schema file: DO, WITH, MERGE, COPY, SELECT, CALL, a row write.
  const FUNCTIONS_STATEMENT =
    /^(?:CREATE FUNCTION shopaccess_api\.[a-z0-9_]+\(|REVOKE ALL ON FUNCTION shopaccess_api\.[a-z0-9_]+\([a-z, ]*\) FROM PUBLIC$|GRANT EXECUTE ON FUNCTION shopaccess_api\.(?:start_checkout|cancel_checkout|read_checkout|list_owner_checkouts)\([a-z, ]*\) TO shopaccess_web$|GRANT (?:SELECT|INSERT|UPDATE)(?:, (?:SELECT|INSERT|UPDATE))*(?: \([a-z_, ]+\))? ON shopaccess\.[a-z_]+ TO shopaccess_definer$|GRANT CREATE ON SCHEMA shopaccess_api TO shopaccess_definer$|ALTER FUNCTION shopaccess_api\.[a-z0-9_]+\([a-z, ]*\) OWNER TO shopaccess_definer$|REVOKE CREATE ON SCHEMA shopaccess_api FROM shopaccess_definer$)/;
  /** Why PGT-156 refuses a top-level statement of the functions file, or null when the statement is one it may contain. */
  const functionsStatementRefusal = (statement: string): string | null => {
    if (ROW_WRITE.test(statement)) return "top-level row write";
    return FUNCTIONS_STATEMENT.test(statement) ? null : "statement form not allowed";
  };
  const statementRefusalFor = (version: string): ((statement: string) => string | null) => (version === FUNCTIONS_MIGRATION ? functionsStatementRefusal : schemaStatementRefusal);

  it("PGT-156: no Increment 2.1 migration runs a top-level INSERT, UPDATE or DELETE", () => {
    for (const version of INCREMENT_2_1_MIGRATIONS) {
      const sql = sqlOfVersion(version);
      expect(sql, version).not.toMatch(E_STRING);
      const statements = topLevelStatements(sql);
      expect(statements.length, version).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statementRefusalFor(version)(statement), `${version}: ${statement.slice(0, 60)}`).toBeNull();
      }
    }
    // The functions file creates no table, and its forms refuse what they must: a row write, a query, an anonymous
    // block, a grant of DELETE, a grant to another role, and a grant of a helper.
    expect(topLevelStatements(sqlOfVersion(FUNCTIONS_MIGRATION)).filter((statement) => statement.startsWith("CREATE TABLE "))).toEqual([]);
    for (const refused of [
      "INSERT INTO shopaccess.quotes (id) VALUES ($1)",
      "SELECT shopaccess_api.start_checkout(1::smallint, repeat( , 64), , , 1, NULL)",
      "DO",
      "GRANT DELETE ON shopaccess.quotes TO shopaccess_definer",
      "GRANT SELECT, DELETE ON shopaccess.quotes TO shopaccess_definer",
      "GRANT SELECT ON shopaccess.quotes TO shopaccess_web",
      "GRANT SELECT ON shopaccess.quotes TO shopaccess_definer WITH GRANT OPTION",
      "GRANT EXECUTE ON FUNCTION shopaccess_api.quote_digest_saqd1(text) TO shopaccess_web",
      "GRANT EXECUTE ON FUNCTION shopaccess_api.start_checkout(smallint, text, text, text, integer, text) TO PUBLIC",
      "ALTER FUNCTION shopaccess_api.start_checkout(smallint, text, text, text, integer, text) OWNER TO shopaccess_web",
      "GRANT shopaccess_definer TO shopaccess_web",
    ]) {
      expect(functionsStatementRefusal(refused), refused).not.toBeNull();
    }
    // The seven table definitions of the schema file were among the statements accepted above.
    expect(topLevelStatements(sqlOfVersion(SCHEMA_MIGRATION)).filter((statement) => statement.startsWith("CREATE TABLE "))).toHaveLength(7);
    // Statement text inside a CREATE FUNCTION body is not examined: only top-level statements were read above.
    // The same reading finds the top-level INSERT statements of the Increment 1 seed file.
    expect(topLevelStatements(sqlOfVersion("0004_merchant_catalog_seed")).some((statement) => ROW_WRITE.test(statement))).toBe(true);
    expect(refusalsOf(sqlOfVersion("0004_merchant_catalog_seed"))).toContain("top-level row write");
  });

  it("PGT-156: CREATE TABLE ... AS cannot pass as a table definition, with or without a row-writing query", () => {
    const NOT_A_DEFINITION = "CREATE TABLE is not an explicit column definition";
    const refused: Record<string, string> = {
      "plain CREATE TABLE AS": "CREATE TABLE shopaccess.ctas_probe AS\nSELECT 1 AS id;",
      "a row-writing query inside CREATE TABLE AS": [
        "CREATE TABLE shopaccess.ctas_probe AS",
        "WITH changed AS (",
        "  DELETE FROM shopaccess.some_table",
        "  RETURNING id",
        ")",
        "SELECT id FROM changed;",
      ].join("\n"),
      "column names, then AS": "CREATE TABLE shopaccess.ctas_probe (\n  id\n) AS SELECT 1;",
      "column names and storage options, then AS": "CREATE TABLE shopaccess.ctas_probe (id) WITH (fillfactor = 70) AS SELECT 1;",
      "AS TABLE": "CREATE TABLE shopaccess.ctas_probe AS TABLE shopaccess.some_table;",
      "AS VALUES": "CREATE TABLE shopaccess.ctas_probe AS VALUES (1);",
      "AS EXECUTE": "CREATE TABLE shopaccess.ctas_probe AS EXECUTE prepared_probe;",
      "IF NOT EXISTS before the name": "CREATE TABLE IF NOT EXISTS shopaccess.ctas_probe AS SELECT 1;",
      "a comment between the name and AS": "CREATE TABLE shopaccess.ctas_probe /* ( id text ) */ AS SELECT 1;",
      "a definition followed by another clause": "CREATE TABLE shopaccess.ctas_probe (id text) INHERITS (shopaccess.some_table);",
      "an unqualified name": "CREATE TABLE ctas_probe (id text);",
    };
    for (const [label, sql] of Object.entries(refused)) expect(refusalsOf(sql), label).toEqual([NOT_A_DEFINITION]);

    const accepted: Record<string, string> = {
      "an explicit column definition": "CREATE TABLE shopaccess.valid_probe (\n  id text PRIMARY KEY,\n  created_at timestamptz NOT NULL\n);",
      "AS in comments and quoted text only": [
        "-- ) AS SELECT 1",
        "CREATE TABLE shopaccess.valid_probe ( /* ) AS WITH changed AS (DELETE FROM a RETURNING id) SELECT id FROM changed */",
        "  note text NOT NULL DEFAULT ') AS SELECT 1', -- ) AS SELECT",
        "  label text NOT NULL CHECK (label <> 'AS' AND length(label) <= 80)",
        ");",
      ].join("\n"),
    };
    for (const [label, sql] of Object.entries(accepted)) expect(refusalsOf(sql), label).toEqual([null]);

    // The older refusals still come first and are unchanged.
    expect(refusalsOf("DELETE FROM shopaccess.some_table;")).toEqual(["top-level row write"]);
    expect(refusalsOf("WITH changed AS (DELETE FROM shopaccess.some_table RETURNING id) SELECT id FROM changed;")).toEqual(["statement form not allowed"]);
    expect(refusalsOf("CREATE TEMPORARY TABLE ctas_probe AS SELECT 1;")).toEqual(["statement form not allowed"]);
  });
});

/**
 * The text of a string expression that is fixed when the file is written: a string literal, a template with no
 * interpolation, or such strings joined by `+`. Escapes are already resolved, so `\x20` is a space here. Anything
 * else (a template with an interpolation, a variable, a call) has no fixed text and gives null.
 */
function staticText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/**
 * The fixed text in a string expression, for the sweep over every string of a file: literals joined by `+` are joined
 * as they would be, and each part that is not fixed (an interpolation, a variable) counts as one space, so that
 * words on either side of it still read as neighbours.
 */
function looseText(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  if (ts.isParenthesizedExpression(node)) return looseText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return looseText(node.left) + looseText(node.right);
  return " ";
}

// What P4 forbids a fixture or test to do, as the statements that would do it: disable or replace a production
// trigger, relax or drop a constraint, change the replication role. The first exception of P4, the test-only trigger
// of the PGT-112(c) test, is admitted below (PERMITTED_SUPPRESSION_FIXTURES) as three exact statements in one exact
// place, and nothing wider: every other statement these patterns match is refused, wherever it stands.
const PROHIBITED_STATEMENTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a trigger, a rule or row security switched off or on", /\b(?:DISABLE|ENABLE)\s+(?:(?:REPLICA|ALWAYS)\s+)?(?:TRIGGER|RULE|ROW\s+LEVEL\s+SECURITY)\b/i],
  ["a table, trigger, function or other object altered", /\bALTER\s+(?:TABLE|TRIGGER|FUNCTION|PROCEDURE|ROUTINE|DOMAIN|INDEX|SCHEMA|ROLE|USER|DATABASE|SYSTEM|EVENT\s+TRIGGER|DEFAULT\s+PRIVILEGES)\b/i],
  ["a table, trigger, constraint, function or other object dropped", /\bDROP\s+(?:TABLE|TRIGGER|CONSTRAINT|FUNCTION|PROCEDURE|ROUTINE|INDEX|SCHEMA|DOMAIN|RULE|OWNED|EVENT\s+TRIGGER)\b/i],
  ["a trigger, rule or function created or replaced", /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(?:TRIGGER|RULE|FUNCTION|PROCEDURE|EVENT\s+TRIGGER)\b/i],
  ["the replication role named", /session_replication_role/i],
  ["ownership reassigned", /\bREASSIGN\s+OWNED\b/i],
];

// Privilege statements. A database test sends none, with one exception (policy P4, second exception; PGT-128): the
// four revocations below, each written out as the text of a query inside the one function of the file that begins a
// transaction, always rolls it back and can end it in no other way. Everything else that grants or revokes is
// refused, wherever it stands: as a statement that is sent, as an entry of the statement table, or as any other
// string of the file. This says nothing about migrations, which carry the grants of the specification.
const PRIVILEGE_STATEMENT_LABEL = "a privilege statement";
const PRIVILEGE_STATEMENT: ReadonlyArray<readonly [string, RegExp]> = [[PRIVILEGE_STATEMENT_LABEL, /\b(?:GRANT|REVOKE)\b/i]];
const PERMITTED_REVOCATIONS: readonly string[] = [
  "REVOKE INSERT ON shopaccess.owner_request_windows FROM shopaccess_definer",
  "REVOKE UPDATE (window_calls) ON shopaccess.owner_request_windows FROM shopaccess_definer",
  "REVOKE UPDATE (total_throttled) ON shopaccess.owner_request_windows FROM shopaccess_definer",
  "REVOKE INSERT ON shopaccess.audit_events FROM shopaccess_definer",
];
const REVOCATION_FUNCTION = "withRevokedPrivilege";

// PGT-112(c) (policy P4, first exception). The test-only trigger: one trigger function that returns NULL, and a
// BEFORE INSERT row trigger using it on one of two tables. These three statements, each written out as the text of
// a query inside the one function of the file that begins a transaction on one client, always rolls it back and can
// end it in no other way, are the only statements that create anything. Any other text that creates, replaces,
// alters or drops an object is refused as before, and so are these three anywhere else.
const SUPPRESSION_FUNCTION = "withSuppressedInsert";
const PERMITTED_SUPPRESSION_FIXTURES: readonly string[] = [
  "CREATE FUNCTION shopaccess.pgt112_suppress_row() RETURNS trigger LANGUAGE plpgsql AS $pgt112$ BEGIN RETURN NULL; END; $pgt112$",
  "CREATE TRIGGER pgt112_suppress_quote_item BEFORE INSERT ON shopaccess.quote_items FOR EACH ROW EXECUTE FUNCTION shopaccess.pgt112_suppress_row()",
  "CREATE TRIGGER pgt112_suppress_transition BEFORE INSERT ON shopaccess.checkout_transitions FOR EACH ROW EXECUTE FUNCTION shopaccess.pgt112_suppress_row()",
];
const SUPPRESSION_FIXTURE_LABEL = "a trigger, rule or function created or replaced";
/** A statement that would end a transaction other than by rolling all of it back. */
const ENDS_TRANSACTION_OTHERWISE = /^\s*(?:COMMIT|END|PREPARE\s+TRANSACTION|SAVEPOINT|RELEASE|ROLLBACK\s+(?:WORK\s+|TRANSACTION\s+)?TO)\b/i;

// An anonymous code block is not in the list above, because a pattern over the text cannot tell a DO statement from
// quoted data that happens to read like one. It is recognized in the CODE of a text instead (`sqlCode` below), where
// every quoted value has been emptied and every comment removed, and only at the start of a statement:
//  - in a statement that is sent, any statement that begins with DO is refused, whatever follows it;
//  - in a string that is not sent, a statement that begins with DO and goes on to a quoted body is reported, in any
//    quoting ('...', E'...', U&'...', dollar quotes), with or without a language before the body.
const ANONYMOUS_BLOCK = "an anonymous code block";
const DO_STATEMENT = /^\s*DO(?![A-Za-z0-9_$])/i;
const DO_STATEMENT_WITH_BODY = /^\s*DO\s*(?:LANGUAGE\s+[A-Za-z_"]+\s*)?(?:[eE]|[uU]&)?''/i;

// Ways for a fixed statement to run other text, or to change a setting, from a bound value. None is used by the
// Increment 2.1 database tests, so none is allowed in a statement they can send.
const INDIRECT_EXECUTION: ReadonlyArray<readonly [string, RegExp]> = [
  ["a setting changed through a function", /\bset_config\b/i],
  ["a query run from text by a function", /\b(?:query_to_xml[a-z_]*|cursor_to_xml[a-z_]*|dblink[a-z_]*)\b/i],
  ["a prepared or dynamic statement", /\b(?:PREPARE|EXECUTE)\s+[A-Za-z_"]/i],
  ["a COPY", /\bCOPY\s/i],
];

/**
 * Where the SQL comment that starts at `index` ends: the index just past it. Returns `index` itself when no comment
 * starts there, and null when a block comment is never closed. A line comment runs to the end of its line. A block
 * comment may hold other block comments, as PostgreSQL allows, to any depth: it ends only when every one opened
 * inside it has been closed.
 */
function afterSqlComment(text: string, index: number): number | null {
  const opening = text.slice(index, index + 2);
  if (opening === "--") {
    let end = index + 2;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
    return end;
  }
  if (opening !== "/*") return index;
  let depth = 1;
  let at = index + 2;
  while (depth > 0) {
    if (at >= text.length) return null;
    const pair = text.slice(at, at + 2);
    if (pair === "/*") {
      depth += 1;
      at += 2;
    } else if (pair === "*/") {
      depth -= 1;
      at += 2;
    } else {
      at += 1;
    }
  }
  return at;
}

/**
 * The code of a SQL text, read as PostgreSQL reads it: each comment replaced by one space, so the words on either
 * side of it stay apart; each quoted value ('...', E'...', dollar-quoted) replaced by an empty one, so that nothing
 * inside a value is taken for code and a comment marker inside a value starts no comment; quoted identifiers kept.
 * Runs of white space become one space. Returns null when a comment, a quoted value or a quoted identifier is never
 * closed: such a text cannot be read safely and is not guessed at.
 */
function sqlCode(text: string): string | null {
  let code = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const pastComment = afterSqlComment(text, index);
    if (pastComment === null) return null;
    if (pastComment !== index) {
      code += " ";
      index = pastComment;
    } else if (character === "'") {
      // In an E'' value a backslash escapes the next character.
      const escapes = /(?:^|[^A-Za-z0-9_$])[eE]$/.test(text.slice(Math.max(0, index - 2), index));
      index += 1;
      for (;;) {
        if (index >= text.length) return null;
        if (escapes && text[index] === "\\") {
          index += 2;
        } else if (text[index] === "'" && text[index + 1] === "'") {
          index += 2;
        } else if (text[index] === "'") {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      code += "''";
    } else if (character === '"') {
      const start = index;
      index += 1;
      for (;;) {
        if (index >= text.length) return null;
        if (text[index] === '"' && text[index + 1] === '"') {
          index += 2;
        } else if (text[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      code += text.slice(start, index);
    } else if (character === "$" && !/[A-Za-z0-9_]/.test(text[index - 1] ?? " ")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(index, index + 80))?.[0];
      if (tag === undefined) {
        code += character;
        index += 1;
      } else {
        const end = text.indexOf(tag, index + tag.length);
        if (end === -1) return null;
        index = end + tag.length;
        code += "''";
      }
    } else {
      code += character;
      index += 1;
    }
  }
  return code.replace(/\s+/g, " ").trim();
}

/**
 * A SQL text with its comments taken out and nothing else understood: quotes are ordinary characters here. It is a
 * second opinion for a text whose quoting the reading above gets wrong or cannot follow, and the only comment-free
 * reading of a string that is not SQL at all. A block comment that is never closed takes the rest of the text.
 */
function sqlWithoutCommentsOnly(text: string): string {
  let kept = "";
  let index = 0;
  while (index < text.length) {
    const pastComment = afterSqlComment(text, index);
    if (pastComment === null) break;
    if (pastComment !== index) {
      kept += " ";
      index = pastComment;
    } else {
      kept += text[index];
      index += 1;
    }
  }
  return kept.replace(/\s+/g, " ");
}

/**
 * The labels of the patterns a text matches, in any of up to three readings: as written; with comments removed and
 * quotes not understood; and as code, with comments removed and quoted values emptied, when the text can be read
 * that way. A match in any reading counts: a comment between two words, nested or not, does not hide them, and
 * neither does a comment marker inside a quoted value.
 */
function prohibitionsIn(text: string, patterns: ReadonlyArray<readonly [string, RegExp]>): string[] {
  const readings = [text.replace(/\s+/g, " "), sqlWithoutCommentsOnly(text)];
  const code = sqlCode(text);
  if (code !== null) readings.push(code);
  return patterns.filter(([, pattern]) => readings.some((reading) => pattern.test(reading))).map(([label]) => label);
}

/**
 * What is wrong with a statement that is sent, beyond the patterns: it cannot be read as SQL (a comment or a quoted
 * value is never closed), or one of its statements begins with DO. The second check does not depend on how the body
 * of the block is quoted or on what stands between DO and the body.
 */
function unreadableOrAnonymousBlock(statement: string): string[] {
  const code = sqlCode(statement);
  if (code === null) return ["a statement that cannot be read: a comment or a quoted value is never closed"];
  return code.split(";").some((part) => DO_STATEMENT.test(part)) ? [ANONYMOUS_BLOCK] : [];
}

/**
 * True when a string that is not sent reads, as SQL code, like an anonymous block: a statement that begins with DO
 * and goes on to a quoted body. A string that cannot be read as SQL is not one: were it ever sent, it would be
 * refused as a statement that cannot be read.
 */
function holdsAnonymousBlock(text: string): boolean {
  const code = sqlCode(text);
  return code !== null && code.split(";").some((part) => DO_STATEMENT_WITH_BODY.test(part));
}

// The only modules an Increment 2.1 database test may import, and from each the only names. In particular: from the
// harness, nothing that sends a statement of its own choosing; no file system, process or driver module.
const DATABASE_TEST_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  vitest: ["afterAll", "beforeAll", "describe", "expect", "it"],
  "@/lib/pg/key-ring": ["computeKeyCheckValue"],
  "@/lib/pg/migrate": ["APPROVED_MIGRATIONS"],
  // The two reviewed catalogues of fixed Increment 1 statements: the operator's key calls and the web role's session
  // calls. A test that needs an Increment 1 entry point (a key activation, a session admission, rotation or
  // revocation) sends the reviewed statement; it may not carry a copy of it.
  "@/lib/pg/statements": ["OPERATOR_STATEMENTS", "SESSION_STATEMENTS"],
  "./harness": ["adminUrl", "hex", "INSUFFICIENT_PRIVILEGE", "openDisposableDatabase", "sqlState", "TEST_NONCE_KEY", "DisposableDatabase"],
};
/** The one table of fixed statements a database test file declares, and the reviewed catalogue it may also send from. */
const STATEMENT_TABLE = "SQL";
const REVIEWED_CATALOGUES: readonly string[] = ["OPERATOR_STATEMENTS", "SESSION_STATEMENTS"];
/**
 * Names that give a way to run text, load code, reach the process, or apply another directory of migrations; and
 * names that give a way to get hold of a method, or to call one, other than by writing `object.method(...)`:
 * reflection on an object or its prototype, and `call`, `apply` and `bind`. A database test needs none of them. They
 * are refused wherever they appear as a name, whatever they are a property of, and as a fixed computed key.
 */
const FORBIDDEN_NAMES: readonly string[] = [
  "eval",
  "require",
  "Function",
  "Reflect",
  "Proxy",
  "globalThis",
  "process",
  "migrate",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getPrototypeOf",
  "setPrototypeOf",
  "defineProperty",
  "defineProperties",
  "__proto__",
  "prototype",
  "constructor",
  "call",
  "apply",
  "bind",
];

/** Where a database test gets its database object, the type of that object, and the three clients it carries. */
const DATABASE_SOURCE = "openDisposableDatabase";
const DATABASE_TYPE = "DisposableDatabase";
// `secondAdmin` is the harness's second test-owner connection to the same disposable database (PGT-118). It is a
// client under exactly the same rules as the other three: a direct `.query(...)` with fixed or tabled text, or a
// hand-off to a function of the file. No other member of the database object is a client, and none opens one.
const CLIENT_MEMBERS: readonly string[] = ["admin", "secondAdmin", "web", "operator"];
const CLIENT_MISUSED = "a database client is used other than to call query on it or to hand it to a function of this file";
const DATABASE_MISUSED = "the database object is used other than to reach its clients or to destroy it";
const DATABASE_NOT_KEPT = "openDisposableDatabase is used other than to keep its result in a plain variable";
const ARGUMENTS_USED = "the arguments object of a function is used: what a function receives is reached only through its named parameters";
const HAND_OFF_SHADOWED = "a function that is handed a database client has its name declared again inside another function";
// `connectWeb()` is the harness's one way to open a further client: one more login as `shopaccess_web`, with that
// role's privileges and the approved timeouts. A test that must know which backend sends a request needs a client of
// its own for it. The call is accepted in exactly one form, `const name = await db.connectWeb();`, and the name is
// then a client under the same rules as the others, with one thing more: `name.end()`, with no argument, so that the
// test can close what it opened. A name that holds an opened client may be declared in no other way, so `end` can
// never reach one of the harness's own clients through it.
const OPENED_CLIENT_SOURCE = "connectWeb";
const OPENED_CLIENT_REUSED = "the name of a client opened with connectWeb is declared in another way";

interface DatabaseTestReading {
  /** Every statement text the file can send: each fixed string given to a query call, and each entry of its statement table. */
  readonly statements: string[];
  /** Every way the file breaks the rules, with the line it is on. Empty when the file keeps them all. */
  readonly violations: string[];
}

/**
 * Reads a database test file as TypeScript and decides, without running it, what statements it can send.
 *
 * The rules make that decidable. A statement reaches the database only through a direct `.query(...)` call, and the
 * text given to such a call must be one of: a fixed string (a literal, or literals joined by `+`); an entry of the
 * file's one statement table `SQL`, which is declared once at the top level as an object of fixed strings and is
 * never used for anything else; or an entry of the reviewed catalogue. A template with an interpolation, a string
 * joined with a variable, a variable, a parameter, a call: none of these is accepted as the text of a query, whatever
 * it would have held. Values travel as bound parameters, which are not statement text.
 *
 * So that this cannot be walked round: `query` may appear only as the name of a method being called directly; no
 * method is called by a computed name; only the listed modules and names are imported; and a few names that run
 * text or load code may not appear at all.
 *
 * Every statement found is then checked against the prohibitions, and so is every other string of the file, so that
 * a prohibited statement cannot sit in a string that some later change starts to send.
 */
function readDatabaseTest(source: string): DatabaseTestReading {
  const file = ts.createSourceFile("database.test.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const statements: string[] = [];
  const violations: string[] = [];
  const report = (node: ts.Node, what: string): void => {
    violations.push(`line ${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${what}`);
  };
  let statementTables = 0;
  /** The entries of the statement table by name, for the rules that need to know what a named entry sends. */
  const tableEntries = new Map<string, string>();
  /** Strings that read like a privilege statement, checked once the whole file has been read. */
  const privilegeCandidates: ts.Node[] = [];
  /** Strings that are exactly one of the PGT-112(c) fixture statements, checked once the whole file has been read. */
  const suppressionCandidates: ts.Node[] = [];

  /** True when the node is the statement given to a direct `.query(...)` call. */
  const isQueryText = (node: ts.Node): boolean => {
    const call = node.parent;
    return ts.isCallExpression(call) && call.arguments[0] === node && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "query";
  };
  /** True for `SQL.name`, `SQL[...]` and the same on the reviewed catalogue. */
  const isTableEntry = (node: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === STATEMENT_TABLE || REVIEWED_CATALOGUES.includes(node.expression.text));

  const readImport = (node: ts.ImportDeclaration): void => {
    const from = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
    const allowed = Object.hasOwn(DATABASE_TEST_IMPORTS, from) ? DATABASE_TEST_IMPORTS[from] : null;
    const bindings = node.importClause?.namedBindings;
    if (allowed === null || node.importClause === undefined || node.importClause.name !== undefined || bindings === undefined || !ts.isNamedImports(bindings)) {
      report(node, `an import that is not on the list: "${from}"`);
      return;
    }
    for (const element of bindings.elements) {
      // A name is imported under its own name: a renamed import could hide a forbidden one.
      if (element.propertyName !== undefined || !allowed.includes(element.name.text)) report(element, `an import that is not on the list: ${element.name.text} from "${from}"`);
    }
  };

  const readStatementTable = (declaration: ts.VariableDeclaration): void => {
    statementTables += 1;
    const list = declaration.parent;
    const topLevelConstant = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 && ts.isVariableStatement(list.parent) && ts.isSourceFile(list.parent.parent);
    let value: ts.Expression | undefined = declaration.initializer;
    while (value !== undefined && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
    if (!topLevelConstant || value === undefined || !ts.isObjectLiteralExpression(value)) {
      report(declaration, "the statement table is not a top-level constant object");
      return;
    }
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        report(property, "an entry of the statement table is not a plain named entry");
        continue;
      }
      const fixed = staticText(property.initializer);
      if (fixed === null) report(property, "an entry of the statement table is not a fixed string");
      else {
        statements.push(fixed);
        tableEntries.set(property.name.text, fixed);
      }
    }
  };

  const readName = (node: ts.Identifier): void => {
    if (node.text === "query") {
      const access = node.parent;
      const calledDirectly = ts.isPropertyAccessExpression(access) && access.name === node && ts.isCallExpression(access.parent) && access.parent.expression === access;
      if (!calledDirectly) report(node, `"query" is used other than as a direct method call`);
    }
    if (node.text === STATEMENT_TABLE || REVIEWED_CATALOGUES.includes(node.text)) {
      const parent = node.parent;
      const declared = node.text === STATEMENT_TABLE && ts.isVariableDeclaration(parent) && parent.name === node;
      const asType = ts.isTypeQueryNode(parent);
      const asQueryText = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node && isQueryText(parent);
      if (!declared && !asType && !asQueryText) report(node, `${node.text} is used other than as the text of a query`);
    }
    if (FORBIDDEN_NAMES.includes(node.text)) report(node, `a name that is not allowed in a database test: ${node.text}`);
  };

  const readCall = (node: ts.CallExpression): void => {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) report(node, "a module is imported while the tests run");
    if (ts.isElementAccessExpression(node.expression)) report(node, "a method is called by a computed name");
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "query") {
      if (node.arguments.length === 0) {
        report(node, "a query call has no statement");
        return;
      }
      const text = node.arguments[0];
      const fixed = staticText(text);
      if (fixed !== null) statements.push(fixed);
      else if (!isTableEntry(text)) report(text, "the statement of a query is neither a fixed string nor an entry of a statement table");
    }
  };

  /**
   * `object[key]`. A fixed key is a name like any other: `query` and the forbidden names are refused. A numeric
   * literal reads an element. Any other key is not known until the tests run, so the value it reads could be
   * anything the object has, a method included; it is accepted only where that value cannot be called or handed on:
   * as an entry of a statement table (checked where the table is named), where a named field of it is read at once,
   * where it is assigned to, or where it is spread into an object. Everywhere else it is refused.
   */
  const readComputedAccess = (node: ts.ElementAccessExpression): void => {
    const key = node.argumentExpression;
    const fixedKey = staticText(key);
    if (fixedKey !== null) {
      if (fixedKey === "query") report(node, `"query" is used other than as a direct method call`);
      else if (FORBIDDEN_NAMES.includes(fixedKey)) report(node, `a name that is not allowed in a database test: ${fixedKey}`);
      return;
    }
    if (ts.isNumericLiteral(key) || isTableEntry(node)) return;
    const user = node.parent;
    const fieldReadAtOnce = ts.isPropertyAccessExpression(user) && user.expression === node;
    const assignedTo = ts.isBinaryExpression(user) && user.left === node && user.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const spreadIntoObject = ts.isSpreadAssignment(user);
    if (!fieldReadAtOnce && !assignedTo && !spreadIntoObject) report(node, "a property is read by a computed name and its value is kept or passed on");
  };

  const sweep = (node: ts.Node, text: string): void => {
    // One of the three PGT-112(c) fixture statements, exactly: whether it stands in its one permitted place is
    // decided after the whole file has been read. Anything else that matches a prohibition is reported at once.
    const exact = staticText(node);
    if (exact !== null && PERMITTED_SUPPRESSION_FIXTURES.includes(exact)) suppressionCandidates.push(node);
    else for (const label of prohibitionsIn(text, PROHIBITED_STATEMENTS)) report(node, `a string holds a prohibited statement: ${label}`);
    if (holdsAnonymousBlock(text)) report(node, `a string holds a prohibited statement: ${ANONYMOUS_BLOCK}`);
    if (prohibitionsIn(text, PRIVILEGE_STATEMENT).length > 0) privilegeCandidates.push(node);
  };

  // ---- Privilege statements: the one permitted place (policy P4, second exception) ----

  const within = (outer: ts.Node, inner: ts.Node): boolean => inner.getStart(file) >= outer.getStart(file) && inner.getEnd() <= outer.getEnd();
  /** True when the node, or something inside it, sends the named entry of the statement table as the text of a query. */
  const sendsTableEntry = (node: ts.Node, entry: string): boolean => {
    let found = false;
    const look = (inner: ts.Node): void => {
      if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === STATEMENT_TABLE && inner.name.text === entry && isQueryText(inner)) found = true;
      ts.forEachChild(inner, look);
    };
    look(node);
    return found;
  };
  /**
   * True when the function works on one client and nothing in it can end the transaction except by rolling all of
   * it back: every `.query(...)` in it is called on the function's first parameter; no entry of the statement table
   * is chosen by a computed key (it could be any entry); no entry of the reviewed catalogue is sent; and no
   * statement, tabled or written out, commits, prepares, or sets or releases a savepoint.
   */
  const endsOnlyByRollback = (declaration: ts.FunctionDeclaration): boolean => {
    const first = declaration.parameters[0]?.name;
    if (first === undefined || !ts.isIdentifier(first)) return false;
    const client = first.text;
    let safe = true;
    const look = (inner: ts.Node): void => {
      if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === "query") {
        const target = inner.expression.expression;
        if (!ts.isIdentifier(target) || target.text !== client) safe = false;
      }
      if (ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === STATEMENT_TABLE) safe = false;
      if (ts.isIdentifier(inner) && REVIEWED_CATALOGUES.includes(inner.text)) safe = false;
      if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === STATEMENT_TABLE) {
        const text = tableEntries.get(inner.name.text);
        if (text === undefined || ENDS_TRANSACTION_OTHERWISE.test(text)) safe = false;
      }
      if (isQueryText(inner)) {
        const fixed = staticText(inner);
        if (fixed !== null && ENDS_TRANSACTION_OTHERWISE.test(fixed)) safe = false;
      }
      ts.forEachChild(inner, look);
    };
    look(declaration);
    return safe;
  };
  /**
   * True only for one of the permitted statements, written out as the text of a query, inside the top-level function
   * named `home`, in a `try` block that is a statement of that function's body, where the statement just before the
   * `try` sends BEGIN, the `finally` of that `try` sends ROLLBACK, every query of the function is sent on its one
   * client, and nothing in the function can end the transaction any other way. Used for the four revocations of
   * PGT-128 (`withRevokedPrivilege`) and for the three fixture statements of PGT-112(c) (`withSuppressedInsert`).
   */
  const isPermittedFixture = (node: ts.Node, home: string, permitted: readonly string[]): boolean => {
    const fixed = staticText(node);
    if (fixed === null || !permitted.includes(fixed) || !isQueryText(node)) return false;
    let enclosing: ts.Node | undefined = node.parent;
    while (enclosing !== undefined && !(ts.isFunctionDeclaration(enclosing) && ts.isSourceFile(enclosing.parent))) enclosing = enclosing.parent;
    if (enclosing === undefined || !ts.isFunctionDeclaration(enclosing) || enclosing.name?.text !== home || enclosing.body === undefined) return false;
    const body = enclosing.body.statements;
    const guardIndex = body.findIndex((statement) => ts.isTryStatement(statement) && within(statement.tryBlock, node));
    if (guardIndex < 1) return false;
    const guard = body[guardIndex];
    if (!ts.isTryStatement(guard) || guard.finallyBlock === undefined) return false;
    if (tableEntries.get("begin") !== "BEGIN" || tableEntries.get("rollback") !== "ROLLBACK") return false;
    return sendsTableEntry(body[guardIndex - 1], "begin") && sendsTableEntry(guard.finallyBlock, "rollback") && endsOnlyByRollback(enclosing);
  };

  // ---- Database clients: an approved-operation policy ----
  //
  // A database client can do far more than run a statement: the driver's client exposes its connection, and the
  // connection its socket, on which any bytes can be written. Checking the text of `.query(...)` calls is therefore
  // not enough. The rules below say what a database test may do with a client, and refuse everything else, so that
  // the only thing a client is ever used for is a query whose text has been read.
  //
  //  - The database object is the result of `openDisposableDatabase()`, kept in a plain variable. Its name may be
  //    used for exactly five things: `.admin`, `.secondAdmin`, `.web` and `.operator`, which are the clients, and `.destroy()`.
  //  - A client may be used for exactly three things: `.query(...)` called on it directly; being handed, as an
  //    argument, to a function declared at the top level of the same file, whose parameter is then a client under
  //    these same rules; and being listed in pairs that a `for (const [a, b] of [[...], [...]])` loop takes apart,
  //    where the name it lands in is then a client under these same rules.
  //  - Nothing else: no other member (`connection`, `end`, `on`, `connect`, ...), no computed member, no copy into
  //    a variable, object, list or return value, no destructuring, no argument to any other function, no assignment.
  //
  // Clients are followed by name. A name that is a client anywhere in the file is treated as one everywhere in it,
  // which can only refuse more.

  const databaseNames = new Set<string>();
  const fileFunctions = new Map<string, ts.FunctionDeclaration>();
  /** The names of the top-level functions that are handed a client. Filled in once the client names are known. */
  const handOffFunctions = new Set<string>();
  const clientNames = new Set<string>();
  /** The parameter and loop names through which a client is received: the places a client name is declared. */
  const clientDeclarations = new Set<ts.Node>();
  /** The names that hold a client opened with `connectWeb()`, and the places those names are declared. */
  const openedClientNames = new Set<string>();
  const openedClientDeclarations = new Set<ts.Node>();

  const isDatabaseSource = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === DATABASE_SOURCE;

  /** The plain variable that the result of an `openDisposableDatabase()` call is kept in, awaited or not; null if it goes anywhere else. */
  const keptIn = (call: ts.CallExpression): ts.Identifier | null => {
    const value: ts.Node = ts.isAwaitExpression(call.parent) ? call.parent : call;
    const holder = value.parent;
    if (ts.isVariableDeclaration(holder) && holder.initializer === value && ts.isIdentifier(holder.name)) return holder.name;
    if (ts.isBinaryExpression(holder) && holder.right === value && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(holder.left)) return holder.left;
    return null;
  };

  /** False where an identifier is only the name of a member, a key or a type, and so does not stand for a value. */
  const standsForValue = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
    if (ts.isNamedTupleMember(parent) && parent.name === node) return false;
    return !(ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent));
  };

  const isClient = (node: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && databaseNames.has(node.expression.text) && CLIENT_MEMBERS.includes(node.name.text)) ||
    (ts.isIdentifier(node) && clientNames.has(node.text) && standsForValue(node) && !clientDeclarations.has(node));

  /** When a client is an argument of a call to a top-level function of this file: the parameter it arrives in. */
  const receivingParameter = (client: ts.Node): ts.Identifier | null => {
    const call = client.parent;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
    const called = fileFunctions.get(call.expression.text);
    const position = call.arguments.findIndex((argument) => argument === client);
    if (called === undefined || position === -1 || position >= called.parameters.length) return null;
    const parameter = called.parameters[position];
    return parameter.dotDotDotToken === undefined && ts.isIdentifier(parameter.name) ? parameter.name : null;
  };

  /** When a client is listed in a pair that a `for (const [a, b] of [[...], ...])` loop takes apart: the name it lands in. */
  const receivingLoopName = (client: ts.Node): ts.Identifier | null => {
    const pair = client.parent;
    if (!ts.isArrayLiteralExpression(pair) || !ts.isArrayLiteralExpression(pair.parent)) return null;
    let listed: ts.Node = pair.parent;
    while (ts.isAsExpression(listed.parent) || ts.isSatisfiesExpression(listed.parent) || ts.isParenthesizedExpression(listed.parent)) listed = listed.parent;
    const loop = listed.parent;
    if (!ts.isForOfStatement(loop) || loop.expression !== listed || loop.awaitModifier !== undefined) return null;
    const declared = loop.initializer;
    if (!ts.isVariableDeclarationList(declared) || (declared.flags & ts.NodeFlags.Const) === 0 || declared.declarations.length !== 1) return null;
    const pattern = declared.declarations[0].name;
    const position = pair.elements.findIndex((element) => element === client);
    if (!ts.isArrayBindingPattern(pattern) || position === -1 || position >= pattern.elements.length) return null;
    const landing = pattern.elements[position];
    if (!ts.isBindingElement(landing) || landing.dotDotDotToken !== undefined || landing.initializer !== undefined || landing.propertyName !== undefined) return null;
    return ts.isIdentifier(landing.name) ? landing.name : null;
  };

  /** `const name = await db.connectWeb();`, in exactly that form: the name the opened client is kept in. Null for any other use. */
  const openedClientName = (access: ts.PropertyAccessExpression): ts.Identifier | null => {
    const call = access.parent;
    if (access.name.text !== OPENED_CLIENT_SOURCE || access.questionDotToken !== undefined) return null;
    if (!ts.isCallExpression(call) || call.expression !== access || call.questionDotToken !== undefined || call.arguments.length !== 0 || call.typeArguments !== undefined) return null;
    const awaited = call.parent;
    if (!ts.isAwaitExpression(awaited)) return null;
    const holder = awaited.parent;
    if (!ts.isVariableDeclaration(holder) || holder.initializer !== awaited || !ts.isIdentifier(holder.name)) return null;
    const list = holder.parent;
    return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 ? holder.name : null;
  };

  const checkClientUse = (client: ts.Node): void => {
    const access = client.parent;
    const queried = ts.isPropertyAccessExpression(access) && access.expression === client && access.name.text === "query" && ts.isCallExpression(access.parent) && access.parent.expression === access;
    // A client the file opened itself may also be closed: `name.end()`, called directly, with no argument.
    const ended =
      ts.isIdentifier(client) &&
      openedClientNames.has(client.text) &&
      ts.isPropertyAccessExpression(access) &&
      access.expression === client &&
      access.name.text === "end" &&
      access.questionDotToken === undefined &&
      ts.isCallExpression(access.parent) &&
      access.parent.expression === access &&
      access.parent.questionDotToken === undefined &&
      access.parent.arguments.length === 0;
    if (!queried && !ended && receivingParameter(client) === null && receivingLoopName(client) === null) report(client, CLIENT_MISUSED);
  };

  const checkDatabaseUse = (name: ts.Identifier): void => {
    const user = name.parent;
    if (ts.isVariableDeclaration(user) && user.name === name) return;
    if (ts.isBinaryExpression(user) && user.left === name && user.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isDatabaseSource(ts.isAwaitExpression(user.right) ? user.right.expression : user.right)) return;
    }
    if (ts.isPropertyAccessExpression(user) && user.expression === name) {
      if (CLIENT_MEMBERS.includes(user.name.text)) {
        checkClientUse(user);
        return;
      }
      if (user.name.text === "destroy" && ts.isCallExpression(user.parent) && user.parent.expression === user && user.parent.arguments.length === 0) return;
      if (openedClientName(user) !== null) return;
    }
    report(name, DATABASE_MISUSED);
  };

  /** Called for every identifier, after the names below have been collected. */
  const readClientPolicy = (node: ts.Identifier): void => {
    if (node.text === DATABASE_SOURCE && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) report(node, DATABASE_NOT_KEPT);
    if (!standsForValue(node)) return;
    if (databaseNames.has(node.text)) checkDatabaseUse(node);
    if (clientNames.has(node.text) && !clientDeclarations.has(node)) checkClientUse(node);
    // A function that receives a client is the one declared at the top level, and nothing else may take its name.
    // A client is followed through the named parameter it arrives in. `arguments` reaches the same value under no
    // name at all, so it is refused wherever it stands for a value: in any function, nested or not, and before
    // anything is done with what it holds. Whether the name is the implicit object or a variable someone declared is
    // not worked out; either way it is refused. (A member or a key called `arguments` is not a value and is allowed.)
    if (node.text === "arguments") report(node, ARGUMENTS_USED);
    // A function that is handed a client is the one declared at the top level. A function or class declared inside
    // another function under the same name would be the one actually called there, with a parameter nobody follows.
    // Declarations are hoisted, so this does not depend on where in the file the inner one stands.
    const inner = node.parent;
    const declaredInside = (ts.isFunctionDeclaration(inner) || ts.isFunctionExpression(inner) || ts.isClassDeclaration(inner) || ts.isClassExpression(inner)) && inner.name === node && !ts.isSourceFile(inner.parent);
    if (declaredInside && handOffFunctions.has(node.text)) report(node, `${HAND_OFF_SHADOWED}: ${node.text}`);
    const declares = (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent) || ts.isBindingElement(node.parent)) && node.parent.name === node;
    if (declares && fileFunctions.has(node.text)) report(node, `${node.text} is the name of a function of this file and is declared again`);
    // The name of an opened client is declared only by opening one. Declared as a parameter, a loop name, another
    // variable, a function or a class, it could stand for another client, which `end` must never reach.
    const declaresFunctionOrClass = (ts.isFunctionDeclaration(inner) || ts.isFunctionExpression(inner) || ts.isClassDeclaration(inner) || ts.isClassExpression(inner)) && inner.name === node;
    if ((declares || declaresFunctionOrClass) && openedClientNames.has(node.text) && !openedClientDeclarations.has(node)) report(node, `${OPENED_CLIENT_REUSED}: ${node.text}`);
  };

  // First the names: the database object, the top-level functions, then every name a client arrives in. A client can
  // be handed on from one function to the next, so the last step is repeated until it finds nothing new.
  const collectNames = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.type !== undefined && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === DATABASE_TYPE) {
      databaseNames.add(node.name.text);
    }
    if (isDatabaseSource(node)) {
      const kept = keptIn(node);
      if (kept === null) report(node, DATABASE_NOT_KEPT);
      else databaseNames.add(kept.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && ts.isSourceFile(node.parent)) fileFunctions.set(node.name.text, node);
    ts.forEachChild(node, collectNames);
  };
  collectNames(file);
  // Then the clients the file opens itself: each is a client from the place it is declared.
  const collectOpenedClients = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && databaseNames.has(node.expression.text)) {
      const kept = openedClientName(node);
      if (kept !== null) {
        openedClientNames.add(kept.text);
        openedClientDeclarations.add(kept);
        clientNames.add(kept.text);
        clientDeclarations.add(kept);
      }
    }
    ts.forEachChild(node, collectOpenedClients);
  };
  collectOpenedClients(file);
  let foundMore = true;
  const collectClientNames = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (isClient(node)) {
      const arrivesIn = receivingParameter(node) ?? receivingLoopName(node);
      if (arrivesIn !== null && !clientDeclarations.has(arrivesIn)) {
        clientDeclarations.add(arrivesIn);
        clientNames.add(arrivesIn.text);
        foundMore = true;
      }
    }
    ts.forEachChild(node, collectClientNames);
  };
  for (let round = 0; foundMore && round < 16; round += 1) {
    foundMore = false;
    collectClientNames(file);
  }
  if (foundMore) violations.push("the names a database client is handed on through could not be followed to an end");
  // The top-level functions that are handed a client: those with a parameter a client arrives in.
  for (const [name, declaration] of fileFunctions) {
    if (declaration.parameters.some((parameter) => clientDeclarations.has(parameter.name))) handOffFunctions.add(name);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      readImport(node);
      return;
    }
    if (ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) report(node, "an import or export form that is not allowed in a database test");
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === STATEMENT_TABLE) readStatementTable(node);
    if (ts.isIdentifier(node)) {
      readName(node);
      readClientPolicy(node);
    }
    if (ts.isCallExpression(node)) readCall(node);
    if (ts.isElementAccessExpression(node)) readComputedAccess(node);
    // A computed name in an object, a class or a destructuring pattern can name anything, a method included.
    if (ts.isComputedPropertyName(node)) report(node, "a computed property name");

    // The source file itself has no parent.
    const above: ts.Node | undefined = node.parent;
    const joinedFurtherUp = above !== undefined && ts.isBinaryExpression(above) && above.operatorToken.kind === ts.SyntaxKind.PlusToken;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) sweep(node, looseText(node));
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && !joinedFurtherUp) sweep(node, looseText(node));

    ts.forEachChild(node, visit);
  };
  visit(file);

  // Every string that reads like a privilege statement is refused unless it is one of the four revocations in its
  // one permitted place. This is decided after the whole file has been read, so that the statement table is known.
  for (const candidate of privilegeCandidates) {
    if (!isPermittedFixture(candidate, REVOCATION_FUNCTION, PERMITTED_REVOCATIONS)) report(candidate, `a string holds a prohibited statement: ${PRIVILEGE_STATEMENT_LABEL}`);
  }
  // The same for the three PGT-112(c) fixture statements: each is accepted only in its one place (the same form, in
  // the function `withSuppressedInsert`), and is the prohibited statement it reads as everywhere else.
  for (const candidate of suppressionCandidates) {
    if (!isPermittedFixture(candidate, SUPPRESSION_FUNCTION, PERMITTED_SUPPRESSION_FIXTURES)) report(candidate, `a string holds a prohibited statement: ${SUPPRESSION_FIXTURE_LABEL}`);
  }

  if (statementTables !== 1) violations.push(`the file declares ${statementTables} statement tables named ${STATEMENT_TABLE}; it must declare exactly one`);
  for (const statement of statements) {
    // A PGT-112(c) fixture statement is one of three exact texts; where it stands was checked above, and a copy
    // standing anywhere else has been reported there. Nothing else is exempt from the patterns.
    if (PERMITTED_SUPPRESSION_FIXTURES.includes(statement)) continue;
    const labels = new Set([...prohibitionsIn(statement, PROHIBITED_STATEMENTS), ...prohibitionsIn(statement, INDIRECT_EXECUTION), ...unreadableOrAnonymousBlock(statement)]);
    // A permitted revocation is one of four exact texts; where it stands was checked above. Any other privilege
    // statement is refused whatever it says and wherever it stands.
    if (prohibitionsIn(statement, PRIVILEGE_STATEMENT).length > 0 && !PERMITTED_REVOCATIONS.includes(statement)) labels.add(PRIVILEGE_STATEMENT_LABEL);
    for (const label of labels) {
      violations.push(`a statement the file can send: ${label}: ${statement.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  return { statements, violations };
}

describe("Increment 2.1 database tests: static safety check (PGT-157, policy P4)", () => {
  // The Increment 2.1 database test files that exist: the schema file, and the two files of the functions migration.
  const SCHEMA_DATABASE_TEST = "checkout-schema.test.ts";
  const FUNCTIONS_DATABASE_TEST = "checkout-functions.test.ts";
  const CONCURRENCY_DATABASE_TEST = "checkout-concurrency.test.ts";
  const INCREMENT_2_1_DATABASE_TESTS = [SCHEMA_DATABASE_TEST, FUNCTIONS_DATABASE_TEST, CONCURRENCY_DATABASE_TEST];
  // The Increment 2.2 database test files: the two files of the confirmation functions (migration 0009). They are
  // read under exactly the same rules.
  const CONFIRMATION_FUNCTIONS_DATABASE_TEST = "confirmation-functions.test.ts";
  const CONFIRMATION_CONCURRENCY_DATABASE_TEST = "confirmation-concurrency.test.ts";
  const INCREMENT_2_2_DATABASE_TESTS = [CONFIRMATION_FUNCTIONS_DATABASE_TEST, CONFIRMATION_CONCURRENCY_DATABASE_TEST];
  // The checkout statements of Increment 2.1, which its two test files carry copies of.
  const INCREMENT_2_1_CHECKOUT_ENTRIES = ["startCheckout", "cancelCheckout", "readCheckout", "listOwnerCheckouts"] as const;
  const CHECKOUT_CALL = /shopaccess_api\.(?:start_checkout|cancel_checkout|read_checkout|list_owner_checkouts|issue_challenge|consume_challenge)\(/;

  const PRIVILEGE = "a privilege statement";
  const AUDIT_REVOCATION = "REVOKE INSERT ON shopaccess.audit_events FROM shopaccess_definer";
  /**
   * A small database test holding the PGT-128 function around one statement. By default it is the permitted form:
   * BEGIN, then a `try` that sends the statement and makes one attempt, then a `finally` that sends ROLLBACK. Each
   * option breaks one part of that form.
   */
  const revocationTest = (
    statement: string,
    form: { name?: string; guarded?: boolean; lastInTry?: string; inFinally?: string; beforeTry?: string } = {},
  ): string => {
    const sent = `await client.query(${JSON.stringify(statement)});`;
    const lines =
      form.guarded === false
        ? ["  await client.query(SQL.begin);", `  ${sent}`, "  await client.query(SQL.attempt);", "  await client.query(SQL.rollback);"]
        : [
            `  ${form.beforeTry ?? "await client.query(SQL.begin);"}`,
            "  try {",
            `    ${sent}`,
            `    ${form.lastInTry ?? "await client.query(SQL.attempt);"}`,
            "  } finally {",
            `    ${form.inFinally ?? "await client.query(SQL.rollback);"}`,
            "  }",
          ];
    const name = form.name ?? "withRevokedPrivilege";
    return [`async function ${name}(client: Admin, key: "attempt"): Promise<void> {`, ...lines, "}", `await ${name}(db.admin, "attempt");`].join("\n");
  };
  const REVOCATION_ENTRIES = `, rollback: "ROLLBACK", attempt: "SELECT 1", done: "COMMIT", save: "SAVEPOINT s"`;

  // PGT-112(c): the same form, in the function `withSuppressedInsert`, around one of the three fixture statements.
  const CREATED = "created or replaced";
  const [SUPPRESSION_FUNCTION_FIXTURE, QUOTE_ITEM_TRIGGER, TRANSITION_TRIGGER] = PERMITTED_SUPPRESSION_FIXTURES;
  const suppressionTest = (statement: string, form: Parameters<typeof revocationTest>[1] = {}): string => revocationTest(statement, { name: "withSuppressedInsert", ...form });

  /**
   * A small database test: one statement table, the database object declared as the real file declares it, then the
   * given lines. `entries` adds entries to the table.
   */
  const databaseTest = (body: string, entries = ""): string => `const SQL = { begin: "BEGIN"${entries} } as const;\nlet db: DisposableDatabase;\n${body}\n`;
  const violationsIn = (body: string, entries = ""): string[] => readDatabaseTest(databaseTest(body, entries)).violations;

  const NOT_FIXED = "neither a fixed string nor an entry of a statement table";
  const TABLE_MISUSED = "SQL is used other than as the text of a query";
  const QUERY_MISUSED = `"query" is used other than as a direct method call`;
  const SWITCHED = "switched off or on";
  const ANONYMOUS = "an anonymous code block";

  it("the reading accepts fixed and tabled statements, and nothing put together while the tests run", () => {
    // Each of these is a small database test that keeps every rule.
    const accepted: Array<[string, string, string?]> = [
      ["an entry of the statement table, by name", `await db.admin.query(SQL.begin);`],
      ["an entry of the statement table, by key", `await client.query(SQL[statement], values === undefined ? undefined : [...values]);`],
      ["an entry of the statement table, by a key made from a table name", "await pool.query(SQL[`select ${table}` as const]);"],
      ["an entry of the reviewed catalogue", `await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["confirmation_nonce", 1, checkValue]);`],
      ["a query on the second test-owner connection, with a fixed or tabled statement", `await db.secondAdmin.query(SQL.begin);\nconst { rows } = await db.secondAdmin.query("SELECT 1 AS n");`],
      ["the second test-owner connection handed to a function of the file", `async function reprice(client: Admin): Promise<void> {\n  await client.query(SQL.begin);\n}\nawait reprice(db.secondAdmin);`],
      ["an entry of the reviewed session catalogue, sent as the web role", `await db.web.query(SESSION_STATEMENTS.revokeSession, [1, digest]);`],
      [
        "one more web client opened, queried, handed to a function of the file, and ended",
        `async function send(client: Admin): Promise<void> {\n  await client.query(SQL.begin);\n}\nconst extra = await db.connectWeb();\nawait extra.query(SQL.begin);\nawait send(extra);\nconst close = () => extra.end();\nawait extra.end();`,
      ],
      ["the two reviewed catalogues imported under their own names", `import { OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";`],
      ["a fixed statement with bound values", `await db.admin.query("DELETE FROM shopaccess.quotes WHERE id = $1", [id]);`],
      ["a fixed statement over several lines", "await db.admin.query(`SELECT c.conname\n   FROM pg_catalog.pg_constraint c\n  WHERE c.conname = $1`, [name]);"],
      ["a fixed statement joined from fixed parts", `await db.admin.query("SELECT count(*) " + "FROM shopaccess.quotes");`],
      [
        "prohibited statements only in comments",
        `// Never: ALTER TABLE shopaccess.quotes DISABLE TRIGGER ALL; SET session_replication_role = replica\n/* DROP TRIGGER quotes_immutable ON shopaccess.quotes */\nawait db.admin.query("SELECT 1");`,
      ],
      ["a label put together from parts, which is not a statement", "const label = `${pgt}: ${what}`;"],
      ["a pattern that an assertion matches against", `expect(message).not.toMatch(/ALTER TABLE|DROP TRIGGER|session_replication_role/i);`],
      ["an explanation that names no statement", `it("PGT-150: a challenge is never deleted, and no trigger is switched off to try", async () => {});`],
      ["the statement table named as a type", `type SqlKey = keyof typeof SQL;`],
      ["the listed imports", `import { describe, expect, it } from "vitest";\nimport { adminUrl, hex, type DisposableDatabase } from "./harness";`],
      [
        "the kinds of statement these tests send",
        `await db.admin.query(SQL["truncate quotes"]);`,
        `, "truncate quotes": "TRUNCATE shopaccess.quotes CASCADE", immediate: "SET CONSTRAINTS shopaccess.quotes_item_check IMMEDIATE", lock: "SELECT id FROM shopaccess.checkout_owners WHERE id = $1 FOR UPDATE", role: "SET ROLE shopaccess_owner", joined: "SELECT 1 " + "FROM shopaccess.quotes"`,
      ],
      // Comments and quoting, read as PostgreSQL reads them.
      [
        "comment markers inside quoted values, and real comments, nested too",
        `await db.admin.query("SELECT '/* not a comment */' AS note, '--' AS dashes, 'it''s' AS quoted FROM shopaccess.quotes /* a real /* nested */ comment */ WHERE id = $1 -- to the end", [id]);`,
      ],
      [
        "the word DO where it begins no statement",
        [
          `await db.admin.query("SELECT 'DO' AS word, 'what to DO next' AS advice FROM shopaccess.quotes WHERE id = $1", [id]);`,
          `await db.admin.query("INSERT INTO shopaccess.checkout_owners (id, created_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [id, now]);`,
          `it("PGT-157: what the tests DO and do not send", async () => {});`,
        ].join("\n"),
      ],
      ["a string that is not SQL, with an unmatched quote and comment marker", `const title = "another owner's rows /* and more";\nawait db.admin.query("SELECT 1");`],
      [
        "quoted data that reads like an anonymous block",
        `await db.admin.query("SELECT 'DO ''BEGIN PERFORM 1; END''' AS note, 'DO $$ BEGIN PERFORM 1; END $$' AS other, 'DO LANGUAGE plpgsql' AS more FROM shopaccess.quotes WHERE id = $1", [id]);`,
      ],
      ["an explanation that begins with the word do", `const note = "Do not send 'this' twice";\nawait db.admin.query("SELECT 1");`],
      // Every way the database suite uses the database object and its clients.
      ["the database object opened, kept and destroyed", `beforeAll(async () => {\n  db = await openDisposableDatabase();\n});\nafterAll(async () => {\n  await db?.destroy();\n});`],
      [
        "a query on each client, with a fixed or tabled statement",
        `await db.admin.query(SQL.begin);\nawait db.web.query(SQL.begin);\nconst activated = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["confirmation_nonce", 1, checkValue]);\nconst { rows } = await db.admin.query("SELECT 1 AS n");`,
      ],
      [
        "a client handed to a function of the file, which only queries it",
        `async function transact(client: Admin, steps: readonly Step[]): Promise<void> {\n  await client.query(SQL.begin);\n  for (const [statement, values] of steps) await client.query(SQL[statement], values);\n  await client.query(SQL.begin);\n}\nawait transact(db.admin, steps);\nexpect(await transact(db.admin, steps)).toBeUndefined();`,
      ],
      [
        "clients listed in pairs for a loop, and queried inside a callback",
        `for (const [role, pool] of [\n  ["web", db.web],\n  ["operator", db.operator],\n] as const) {\n  expect(await sqlState(() => pool.query(SQL[statement])), role).toBe(code);\n}`,
      ],
      // Data read by a computed key, in the places where its value cannot be a method that is kept or called.
      [
        "an element by number, a named field, an assignment and a spread",
        `const row = rows[0];\nconst event = LEGAL[kind].event;\nstate[table] = { rows: 1 };\nconst step = { ...LEGAL[kind], eventId };\nconst next = ids[(index + 1) % size].intent;`,
      ],
      // PGT-128 (policy P4, second exception): each of the four revocations, in its one permitted place.
      ...PERMITTED_REVOCATIONS.map((revocation): [string, string, string] => [`a permitted revocation, always rolled back: ${revocation}`, revocationTest(revocation), REVOCATION_ENTRIES]),
      // PGT-112(c) (policy P4, first exception): each of the three fixture statements, in its one permitted place.
      ...PERMITTED_SUPPRESSION_FIXTURES.map((fixture): [string, string, string] => [`a permitted PGT-112(c) fixture, always rolled back: ${fixture.slice(0, 48)}`, suppressionTest(fixture), REVOCATION_ENTRIES]),
      ["words that only resemble a privilege statement", `const title = "grants and revoked sessions are not statements";\nawait db.admin.query("SELECT grantee, revoked_at FROM shopaccess.granted_things");`],
    ];
    for (const [label, body, entries] of accepted) expect(violationsIn(body, entries), label).toEqual([]);
    expect(PERMITTED_REVOCATIONS).toHaveLength(4);
    expect(PERMITTED_SUPPRESSION_FIXTURES).toHaveLength(3);
    // The reading reaches the fixture statements it accepts: they are among the statements the file can send.
    expect(readDatabaseTest(databaseTest(suppressionTest(QUOTE_ITEM_TRIGGER), REVOCATION_ENTRIES)).statements).toContain(QUOTE_ITEM_TRIGGER);

    // Escapes are resolved and joined parts are joined before anything is checked.
    expect(readDatabaseTest(databaseTest(`await db.admin.query("SELECT\\x201 " + "FROM\\u0020t");`, `, done: "COM" + "MIT"`)).statements).toEqual(["BEGIN", "COMMIT", "SELECT 1 FROM t"]);
  });

  it("the reading refuses a prohibited statement however it is spelled, and every statement it cannot read", () => {
    // Each of these breaks a rule. The fragment is part of the violation it must be reported for.
    const refused: Array<[string, string, string, string?]> = [
      // Prohibited statements, as fixed text.
      ["a trigger disabled", `await db.admin.query("ALTER TABLE shopaccess.quotes DISABLE TRIGGER quotes_immutable");`, SWITCHED],
      ["in lower case, across lines", "await db.admin.query(`alter table shopaccess.quotes\n  disable trigger all`);", SWITCHED],
      ["joined from two literals", `await db.admin.query("ALTER TABLE shopaccess.quotes " + "DISABLE TRIGGER ALL");`, SWITCHED],
      ["joined from literals that split its words", `await db.admin.query("ALT" + "ER TABLE shopaccess.quotes DIS" + "ABLE TRIG" + "GER ALL");`, SWITCHED],
      ["with escaped spaces", `await db.admin.query("ALTER\\x20TABLE\\u0020shopaccess.quotes\\tDISABLE\\x20TRIGGER\\u{20}ALL");`, SWITCHED],
      ["with an escaped line break", `await db.admin.query("ALTER TABLE shopaccess.quotes\\nDISABLE\\r\\nTRIGGER USER");`, SWITCHED],
      ["with SQL comments for spaces", `await db.admin.query("ALTER/**/TABLE shopaccess.quotes DISABLE/* x */TRIGGER ALL");`, SWITCHED],
      ["after a comment marker inside a quoted value", `await db.admin.query("SELECT '--'; ALTER TABLE shopaccess.quotes DISABLE TRIGGER ALL");`, SWITCHED],
      ["as an entry of the statement table", `await db.admin.query(SQL.bad);`, "replication role", `, bad: "SET session_replication_role = replica"`],
      ["a trigger dropped", `await db.admin.query('DROP TRIGGER quotes_immutable ON shopaccess.quotes');`, "dropped"],
      ["a constraint dropped", `await db.admin.query("ALTER TABLE shopaccess.quotes DROP CONSTRAINT quotes_lifetime_check");`, "altered"],
      ["a constraint relaxed", `await db.admin.query("ALTER TABLE shopaccess.checkout_intents ALTER CONSTRAINT checkout_intents_current_quote_fkey NOT DEFERRABLE");`, "altered"],
      ["a trigger function replaced", "await db.admin.query(`CREATE OR REPLACE FUNCTION shopaccess.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$`);", "created or replaced"],
      // The P4 exception for the PGT-112(c) test admits three exact statements in one place (see below). A test-only
      // trigger of any other name is still refused, even in the same form.
      ["a test-only trigger created", `await db.admin.query("CREATE TRIGGER skip_items BEFORE INSERT ON shopaccess.quote_items FOR EACH ROW EXECUTE FUNCTION shopaccess.skip()");`, "created or replaced"],
      ["the replication role set", `await db.admin.query("SET session_replication_role = replica");`, "replication role"],
      ["the replication role set from bound values", `await db.admin.query("SELECT pg_catalog.set_config($1, $2, false)", [name, value]);`, "changed through a function"],
      ["an anonymous block", "await db.admin.query(`DO $$ BEGIN PERFORM 1; END $$`);", "anonymous code block"],
      ["a prohibited statement in a string that is not sent", `const steps = [["ALTER TABLE shopaccess.quotes DISABLE TRIGGER ALL"]];`, "a string holds a prohibited statement"],
      // Statements whose text is not fixed: refused whatever they would have held.
      ["a template with an interpolation", "await db.admin.query(`TRUNCATE shopaccess.${table}`);", NOT_FIXED],
      ["a literal joined with a variable", `await db.admin.query("TRUNCATE shopaccess." + table);`, NOT_FIXED],
      ["a variable", `const text = "SELECT 1";\nawait db.admin.query(text);`, NOT_FIXED],
      ["a parameter of a wrapper", `const run = (text: string) => db.admin.query(text);\nawait run("SELECT 1");`, NOT_FIXED],
      ["the result of a call", `await db.admin.query(["SELECT", "1"].join(" "));`, NOT_FIXED],
      ["an entry of some other object", `const other = { a: "SELECT 1" };\nawait db.admin.query(other.a);`, NOT_FIXED],
      ["a spread argument", `await db.admin.query(...parts);`, NOT_FIXED],
      ["no statement at all", `await db.admin.query();`, "a query call has no statement"],
      // The statement table: fixed strings only, declared once, used only as the text of a query.
      ["a table entry joined with a variable", `await db.admin.query(SQL.bad);`, "an entry of the statement table is not a fixed string", `, bad: "TRUNCATE shopaccess." + table`],
      ["a table entry with an interpolation", `await db.admin.query(SQL.bad);`, "an entry of the statement table is not a fixed string", ", bad: `TRUNCATE shopaccess.${table}`"],
      ["a table entry spread in from elsewhere", `await db.admin.query(SQL.begin);`, "an entry of the statement table is not a plain named entry", `, ...more`],
      ["the table changed through a helper", `Object.assign(SQL, { begin: "SELECT 2" });`, TABLE_MISUSED],
      ["the table changed by assignment", `(SQL as { begin: string }).begin = "SELECT 2";`, TABLE_MISUSED],
      ["a table entry assigned to", `SQL.begin = "SELECT 2";`, TABLE_MISUSED],
      ["a table entry copied out and sent later", `const copy = SQL.begin;\nawait db.admin.query(copy);`, TABLE_MISUSED],
      ["a parameter with the table's name", `const run = (SQL: Record<string, string>) => db.admin.query(SQL.begin);`, TABLE_MISUSED],
      ["a second table of the same name", `{\n  const SQL = { begin: "SELECT 2" };\n  await db.admin.query(SQL.begin);\n}`, "it must declare exactly one"],
      // Other ways to reach the database or to load something that could.
      ["query called by a computed name", `await db.admin["query"]("SELECT 1");`, "a method is called by a computed name"],
      ["query bound and called later", `const send = db.admin.query.bind(db.admin);\nawait send("SELECT 1");`, QUERY_MISUSED],
      ["query taken out of the client", `const { query } = db.admin;`, QUERY_MISUSED],
      ["a harness helper that sends its own statement", `import { insertBackdatedSession } from "./harness";`, "an import that is not on the list"],
      ["a catalogue that is not for tests: the migration runner's", `import { MIGRATION_STATEMENTS } from "@/lib/pg/statements";`, "an import that is not on the list"],
      ["the checkout catalogue, which the tests copy and the static suite compares", `import { CHECKOUT_STATEMENTS } from "@/lib/pg/statements";`, "an import that is not on the list"],
      ["a reviewed catalogue copied out and sent later", `const copy = SESSION_STATEMENTS.revokeSession;\nawait db.web.query(copy);`, "SESSION_STATEMENTS is used other than as the text of a query"],
      ["a reviewed session statement inside the PGT-128 function", revocationTest(AUDIT_REVOCATION, { lastInTry: "await client.query(SESSION_STATEMENTS.revokeSession, [1, key]);" }), PRIVILEGE, REVOCATION_ENTRIES],
      ["a listed name imported under another name", `import { sqlState as run } from "./harness";`, "an import that is not on the list"],
      ["the file system", `import { readFileSync } from "node:fs";`, "an import that is not on the list"],
      ["the driver", `import { Client } from "` + `pg";`, "an import that is not on the list"],
      ["a whole module", `import * as harness from "./harness";`, "an import that is not on the list"],
      ["a module loaded while the tests run", `const fs = await import("node:fs");`, "a module is imported while the tests run"],
      ["another directory of migrations applied", `await db.migrate(directory);`, "a name that is not allowed in a database test: migrate"],
      ["text run as code", `eval(text);`, "a name that is not allowed in a database test: eval"],
      // Nested block comments, which PostgreSQL allows: a comment ends only when every comment opened inside it has.
      [
        "with a nested comment between its words",
        `await db.admin.query("ALTER/* outer /* nested */ tail */ TABLE shopaccess.quotes DISABLE/* outer /* nested */ tail */ TRIGGER quotes_immutable");`,
        SWITCHED,
      ],
      ["with comments nested three deep and no spaces", `await db.admin.query("ALTER/* a /* b /* c */ b */ a */TABLE shopaccess.quotes DISABLE/*/*/**/*/*/TRIGGER ALL");`, SWITCHED],
      ["split across literals and nested comments", `await db.admin.query("DR" + "OP/* /* x */ */TRIG" + "GER quotes_immutable ON shopaccess.quotes");`, "dropped"],
      [
        "after a comment marker inside a quoted value, with nested comments",
        `await db.admin.query("SELECT '/* ' AS a; ALTER /* /* */ */ TABLE shopaccess.quotes DISABLE /* /* */ */ TRIGGER ALL");`,
        SWITCHED,
      ],
      ["a nested comment that is never closed", `await db.admin.query("SELECT 1 /* outer /* inner */ still open");`, "cannot be read"],
      ["a quoted value that is never closed", `await db.admin.query("SELECT 'open");`, "cannot be read"],
      ["an unclosed comment in an entry of the statement table", `await db.admin.query(SQL.bad);`, "cannot be read", `, bad: "SELECT 1 /* /* */"`],
      // Anonymous blocks, however the body is quoted and whatever stands between the parts.
      ["an anonymous block in single quotes", `await db.admin.query("DO 'BEGIN PERFORM 1; END'");`, ANONYMOUS],
      ["an anonymous block with a language", `await db.admin.query("DO LANGUAGE plpgsql 'BEGIN PERFORM 1; END'");`, ANONYMOUS],
      ["an anonymous block with the language after the body", `await db.admin.query("DO 'BEGIN PERFORM 1; END' LANGUAGE plpgsql");`, ANONYMOUS],
      ["an anonymous block with no space before its body", `await db.admin.query("DO'BEGIN PERFORM 1; END'");`, ANONYMOUS],
      ["an anonymous block with an escape-string body", `await db.admin.query("DO E'BEGIN\\\\nPERFORM 1;\\\\nEND'");`, ANONYMOUS],
      ["an anonymous block after another statement", `await db.admin.query("SELECT 1; DO 'BEGIN PERFORM 1; END'");`, ANONYMOUS],
      [
        "an anonymous block with comments and line breaks between its parts",
        "await db.admin.query(`DO /* a /* b */ */\n  LANGUAGE plpgsql -- c\n  $body$ BEGIN PERFORM 1; END $body$`);",
        ANONYMOUS,
      ],
      ["an anonymous block with a Unicode-escape body", `await db.admin.query("DO U&'BEGIN PERFORM 1; END'");`, ANONYMOUS],
      ["an anonymous block with a Unicode-escape body and its escape character", `await db.admin.query("DO U&'BEGIN PERFORM 1; END' UESCAPE '!'");`, ANONYMOUS],
      ["an anonymous block in a string that is not sent", `const block = "DO LANGUAGE plpgsql 'BEGIN PERFORM 1; END'";`, "a string holds a prohibited statement: an anonymous code block"],
      // The database client: anything but a query on it, or handing it to a function of the file, is refused. The
      // first case writes raw protocol bytes to the socket; it is refused for reaching the connection, not for what
      // the bytes say. None of these is ever run.
      ["raw bytes written to a client's socket", `db.admin.connection.stream.write(Buffer.from([81, 0, 0, 0, 9, 83, 69, 76, 69, 67, 84, 0]));`, CLIENT_MISUSED],
      ["the connection of a client read", `const link = db.admin.connection;`, CLIENT_MISUSED],
      ["the socket of a client read", `const wire = db.admin.connection.stream;`, CLIENT_MISUSED],
      [
        "a write on the socket, inside a function of the file that was handed the client",
        `async function send(client: Admin, bytes: Uint8Array): Promise<void> {\n  client.connection.stream.write(bytes);\n}\nawait send(db.admin, bytes);`,
        CLIENT_MISUSED,
      ],
      ["a client kept under another name", `const admin = db.admin;\nadmin.connection.stream.write(bytes);`, CLIENT_MISUSED],
      ["the connection taken out of a client by a pattern", `const { connection } = db.admin;`, CLIENT_MISUSED],
      ["a member of a client read by a fixed computed name", `db.admin["connection"].stream.write(bytes);`, CLIENT_MISUSED],
      ["a member of a client read by a name not known until the tests run", `db.admin[member].write(bytes);`, CLIENT_MISUSED],
      ["a client handed to an imported helper", `await sqlState(db.admin);`, CLIENT_MISUSED],
      ["a client handed to a function that is not declared at the top level", `const reach = (client: Admin) => client.connection;\nreach(db.admin);`, CLIENT_MISUSED],
      ["a client handed to a method", `expect(db.admin).toBeDefined();`, CLIENT_MISUSED],
      ["a client handed to a function of the file through a rest parameter", `async function send(...clients: Admin[]): Promise<void> {}\nawait send(db.admin);`, CLIENT_MISUSED],
      ["the query method of a client taken out", `const send = db.admin.query;`, CLIENT_MISUSED],
      ["the query method of one client rebound to another", `const send = db.admin.query.bind(db.web);`, CLIENT_MISUSED],
      ["the socket reached inside a callback", `await sqlState(() => db.admin.connection.stream.write(bytes));`, CLIENT_MISUSED],
      ["the socket reached inside a hook", `afterAll(() => {\n  db.admin.connection.stream.end();\n});`, CLIENT_MISUSED],
      ["the socket reached through optional chaining", `db?.admin?.connection?.stream?.write(bytes);`, CLIENT_MISUSED],
      ["the socket reached through a cast", `(db.admin as unknown as { connection: Wire }).connection.stream.write(bytes);`, CLIENT_MISUSED],
      ["another method of a client called", `await db.admin.end();`, CLIENT_MISUSED],
      ["a listener put on a client", `db.admin.on("notice", listen);`, CLIENT_MISUSED],
      ["a pooled client checked out", `const held = await db.web.connect();`, CLIENT_MISUSED],
      ["clients kept in a list", `const all = [db.admin, db.web];`, CLIENT_MISUSED],
      ["a client kept in an object", `const box = { admin: db.admin };`, CLIENT_MISUSED],
      ["a client returned from a function", `const pick = () => db.admin;`, CLIENT_MISUSED],
      ["clients listed singly for a loop", `for (const pool of [db.web, db.operator]) {\n  await pool.query(SQL.begin);\n}`, CLIENT_MISUSED],
      ["a client from a loop used for more than a query", `for (const [role, pool] of [["web", db.web]] as const) {\n  await pool.connect();\n}`, CLIENT_MISUSED],
      [
        "a client name given another value",
        `async function send(client: Admin): Promise<void> {\n  client = other;\n  await client.query(SQL.begin);\n}\nawait send(db.admin);`,
        CLIENT_MISUSED,
      ],
      // The database object: its three clients and destroy, and nothing else.
      ["the database object kept under another name", `const other = db;`, DATABASE_MISUSED],
      ["a client taken out of the database object by a pattern", `const { admin } = db;`, DATABASE_MISUSED],
      ["a member of the database object read by a computed name", `await db[member].query(SQL.begin);`, DATABASE_MISUSED],
      ["the database object handed to a function", `await helper(db);`, DATABASE_MISUSED],
      // One more web client may be opened, in one form only, and is a client like the others that may also be ended.
      ["another client opened and not awaited", `const pending = db.connectWeb();`, DATABASE_MISUSED],
      ["another client opened with an argument", `const extra = await db.connectWeb(options);`, DATABASE_MISUSED],
      ["another client opened into a variable that can be given another value", `let extra = await db.connectWeb();`, DATABASE_MISUSED],
      ["another client opened into a pattern", `const { connection } = await db.connectWeb();`, DATABASE_MISUSED],
      ["another client opened straight into a list", `clients.push(await db.connectWeb());`, DATABASE_MISUSED],
      ["another client opened and returned", `const open = async () => await db.connectWeb();`, DATABASE_MISUSED],
      ["the method that opens a client taken out", `const open = db.connectWeb;`, DATABASE_MISUSED],
      ["another client opened through optional chaining", `const extra = await db?.connectWeb();`, DATABASE_MISUSED],
      ["the transport of an opened client", `const extra = await db.connectWeb();\nextra.connection.stream.write(bytes);`, CLIENT_MISUSED],
      ["an opened client kept under another name", `const extra = await db.connectWeb();\nconst other = extra;`, CLIENT_MISUSED],
      ["an opened client kept in a list", `const extra = await db.connectWeb();\nconst all = [extra];`, CLIENT_MISUSED],
      ["an opened client kept in an object", `const extra = await db.connectWeb();\nconst box = { extra };`, CLIENT_MISUSED],
      ["an opened client given another value", `const extra = await db.connectWeb();\nextra = other;`, CLIENT_MISUSED],
      ["the end method of an opened client taken out", `const extra = await db.connectWeb();\nconst stop = extra.end;`, CLIENT_MISUSED],
      ["an opened client ended with an argument", `const extra = await db.connectWeb();\nawait extra.end(callback);`, CLIENT_MISUSED],
      ["another method of an opened client called", `const extra = await db.connectWeb();\nextra.on("notice", listen);`, CLIENT_MISUSED],
      ["an opened client ended inside the function it was handed to", `async function stop(client: Admin): Promise<void> {\n  await client.end();\n}\nconst extra = await db.connectWeb();\nawait stop(extra);`, CLIENT_MISUSED],
      [
        "a client of the harness ended through a parameter that takes the name of an opened client",
        `async function stop(extra: Admin): Promise<void> {\n  await extra.end();\n}\nconst extra = await db.connectWeb();\nawait stop(db.admin);`,
        `${OPENED_CLIENT_REUSED}: extra`,
      ],
      ["the name of an opened client declared again as a plain variable", `const extra = await db.connectWeb();\nfunction other(): void {\n  const extra = held;\n}`, `${OPENED_CLIENT_REUSED}: extra`],
      ["a pool of the harness ended", `await db.web.end();`, CLIENT_MISUSED],
      ["a statement that is not fixed, on an opened client", "const extra = await db.connectWeb();\nawait extra.query(`UPDATE shopaccess.${table} SET a = 1`);", NOT_FIXED],
      ["a prohibited statement on an opened client", `const extra = await db.connectWeb();\nawait extra.query("ALTER TABLE shopaccess.quotes DISABLE TRIGGER ALL");`, SWITCHED],
      ["a privilege statement on an opened client", `const extra = await db.connectWeb();\nawait extra.query("GRANT UPDATE ON shopaccess.merchant_variants TO shopaccess_web");`, PRIVILEGE],
      // The second test-owner connection is a client like the others, and nothing more.
      ["the second test-owner connection ended by a test", `await db.secondAdmin.end();`, CLIENT_MISUSED],
      ["the second test-owner connection kept in a variable", `const second = db.secondAdmin;\nawait second.query("SELECT 1");`, CLIENT_MISUSED],
      ["the transport of the second test-owner connection", `db.secondAdmin.connection.stream.write(bytes);`, CLIENT_MISUSED],
      ["a statement that is not fixed, on the second test-owner connection", "await db.secondAdmin.query(`UPDATE shopaccess.${table} SET a = 1`);", NOT_FIXED],
      ["a prohibited statement on the second test-owner connection", `await db.secondAdmin.query("ALTER TABLE shopaccess.quotes DISABLE TRIGGER ALL");`, SWITCHED],
      ["a privilege statement on the second test-owner connection", `await db.secondAdmin.query("GRANT UPDATE ON shopaccess.merchant_variants TO shopaccess_web");`, PRIVILEGE],
      ["a third test-owner connection, which does not exist", `await db.thirdAdmin.query("SELECT 1");`, DATABASE_MISUSED],
      ["the connection fields of the web role", `const target = db.webConnection;`, DATABASE_MISUSED],
      ["another directory of migrations through the database object", `await db.migrate(directory);`, DATABASE_MISUSED],
      ["the connection details of the database object read", `const details = db.webConnection;`, DATABASE_MISUSED],
      ["the database object used without being kept", `(await openDisposableDatabase()).admin.connection.stream.write(bytes);`, DATABASE_NOT_KEPT],
      ["the database object opened into a pattern", `const { admin } = await openDisposableDatabase();`, DATABASE_NOT_KEPT],
      ["the function that opens the database kept under another name", `const open = openDisposableDatabase;`, DATABASE_NOT_KEPT],
      // The driver also accepts an object in place of a statement, and hands that object the connection.
      ["a query given an object that is handed the connection", `await db.admin.query({ submit: (connection) => connection.stream.write(bytes) });`, NOT_FIXED],
      // A client reached through `arguments` instead of the named parameter it was handed to. The hand-off itself is
      // an approved one and nothing here names `connection` on a client the reading follows, so no other rule refuses
      // this source: it is refused for `arguments` alone.
      [
        "a client reached through the arguments object of the function it was handed to",
        `async function send(client: Admin, bytes: Uint8Array): Promise<void> {\n  (arguments[0] as Admin).connection.stream.write(bytes);\n}\nawait send(db.admin, bytes);`,
        ARGUMENTS_USED,
      ],
      // A nested function that takes the name of a top-level function which is handed a client. The call resolves to
      // the nested one, whose parameter `other` nobody follows, so no other rule refuses this source either.
      [
        "a client redirected to a nested function with the name of an approved one",
        `async function withClient(client: Admin): Promise<void> {\n  await client.query(SQL.begin);\n}\nasync function scenario(): Promise<void> {\n  function withClient(other: Admin): void {\n    other.connection.stream.write(bytes);\n  }\n  await withClient(db.admin);\n}`,
        `${HAND_OFF_SHADOWED}: withClient`,
      ],
      // Getting hold of a method, or calling one, other than by writing object.method(...).
      [
        "a method taken from the prototype by its descriptor",
        `const found = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(db.admin), name);\nawait found.value.call(db.admin, text);`,
        "a name that is not allowed in a database test: getOwnPropertyDescriptor",
      ],
      ["the prototype of a client read", `const base = Object.getPrototypeOf(db.admin);`, "a name that is not allowed in a database test: getPrototypeOf"],
      ["the prototype named through the constructor", `const base = db.admin.constructor.prototype;`, "a name that is not allowed in a database test: prototype"],
      ["a method invoked through call", `await send.call(db.admin, "SELECT 1");`, "a name that is not allowed in a database test: call"],
      ["a method invoked through apply", `await send.apply(db.admin, ["SELECT 1"]);`, "a name that is not allowed in a database test: apply"],
      ["a method bound to a client", `const bound = send.bind(db.admin);`, "a name that is not allowed in a database test: bind"],
      ["a method invoked by reflection", `await Reflect.apply(send, db.admin, ["SELECT 1"]);`, "a name that is not allowed in a database test: Reflect"],
      ["a reflective name as a fixed computed key", `const reach = Object["getPrototypeOf"];`, "a name that is not allowed in a database test: getPrototypeOf"],
      ["a method read by a computed key and kept", `const send = db.admin[name];\nawait send("SELECT 1");`, "a property is read by a computed name"],
      ["a method read by a computed key and passed on", `await run(db.admin[name], "SELECT 1");`, "a property is read by a computed name"],
      ["a method read by a computed key into a list", `const parts = [db.admin[name]];`, "a property is read by a computed name"],
      ["a method taken by a computed name in a pattern", `const { [name]: send } = db.admin;`, "a computed property name"],
      ["a method called through an optional computed name", `await db.admin?.[name]?.("SELECT 1");`, "a method is called by a computed name"],
      ["query used as a template tag", "await db.admin.query`SELECT 1`;", QUERY_MISUSED],
      [
        "a statement put together by joining a list, then sent",
        `const text = ["ALTER", "TABLE", "shopaccess.quotes", "DISABLE", "TRIGGER", "ALL"].join(" ");\nawait db.admin.query(text);`,
        NOT_FIXED,
      ],
      // Privilege statements (policy P4, second exception). Outside the four revocations in their one place,
      // nothing that grants or revokes is accepted: the reading stays fail-closed.
      ["a grant", `await db.admin.query("GRANT SELECT ON shopaccess.quotes TO shopaccess_web");`, PRIVILEGE],
      ["a grant in lower case", `await db.admin.query("grant select on shopaccess.quotes to shopaccess_web");`, PRIVILEGE],
      ["a grant of a role", `await db.admin.query("GRANT shopaccess_definer TO shopaccess_web");`, PRIVILEGE],
      ["a grant inside the PGT-128 function", revocationTest("GRANT INSERT ON shopaccess.audit_events TO shopaccess_web"), PRIVILEGE, REVOCATION_ENTRIES],
      ["a revocation of another privilege", revocationTest("REVOKE SELECT ON shopaccess.audit_events FROM shopaccess_definer"), PRIVILEGE, REVOCATION_ENTRIES],
      ["a revocation on another table", revocationTest("REVOKE INSERT ON shopaccess.quotes FROM shopaccess_definer"), PRIVILEGE, REVOCATION_ENTRIES],
      ["a revocation of another column", revocationTest("REVOKE UPDATE (updated_at) ON shopaccess.owner_request_windows FROM shopaccess_definer"), PRIVILEGE, REVOCATION_ENTRIES],
      ["a revocation from another role", revocationTest("REVOKE INSERT ON shopaccess.audit_events FROM shopaccess_web"), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation with something added", revocationTest(`${AUDIT_REVOCATION} CASCADE`), PRIVILEGE, REVOCATION_ENTRIES],
      ["two revocations in one statement", revocationTest(`${AUDIT_REVOCATION}; REVOKE SELECT ON shopaccess.quotes FROM shopaccess_definer`), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation outside the function", `await db.admin.query("${AUDIT_REVOCATION}");`, PRIVILEGE],
      ["a permitted revocation in a function of another name", revocationTest(AUDIT_REVOCATION, { name: "withPrivilegeGone" }), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation with no rollback guard", revocationTest(AUDIT_REVOCATION, { guarded: false }), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation whose transaction is committed", revocationTest(AUDIT_REVOCATION, { lastInTry: "await client.query(SQL.done);" }), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation with a savepoint", revocationTest(AUDIT_REVOCATION, { lastInTry: "await client.query(SQL.save);" }), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation committed by a statement written out", revocationTest(AUDIT_REVOCATION, { lastInTry: `await client.query("COMMIT");` }), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation beside an entry chosen by a computed key", revocationTest(AUDIT_REVOCATION, { lastInTry: "await client.query(SQL[key]);" }), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation whose finally does not roll back", revocationTest(AUDIT_REVOCATION, { inFinally: "await client.query(SQL.attempt);" }), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation with no BEGIN before the try", revocationTest(AUDIT_REVOCATION, { beforeTry: "await client.query(SQL.attempt);" }), PRIVILEGE, REVOCATION_ENTRIES],
      ["a permitted revocation where ROLLBACK is not what the table says", revocationTest(AUDIT_REVOCATION), PRIVILEGE, `, rollback: "SELECT 2", attempt: "SELECT 1"`],
      ["a permitted revocation as an entry of the statement table", `await db.admin.query(SQL.bad);`, PRIVILEGE, `, bad: "${AUDIT_REVOCATION}"`],
      ["a permitted revocation in a string that is not sent", `const steps = [["${AUDIT_REVOCATION}"]];`, PRIVILEGE],
      // PGT-112(c) (policy P4, first exception). Outside the three fixture statements in their one place, nothing
      // that creates, replaces, alters or drops an object is accepted, and the transaction cannot be left open.
      ["a fixture trigger outside the function", `await db.admin.query(${JSON.stringify(QUOTE_ITEM_TRIGGER)});`, CREATED],
      ["the fixture function outside the function", `await db.admin.query(${JSON.stringify(SUPPRESSION_FUNCTION_FIXTURE)});`, CREATED],
      ["a fixture trigger in the PGT-128 function", revocationTest(TRANSITION_TRIGGER), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger in a function of another name", suppressionTest(QUOTE_ITEM_TRIGGER, { name: "withTriggerAdded" }), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger with no rollback guard", suppressionTest(QUOTE_ITEM_TRIGGER, { guarded: false }), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger whose transaction is committed", suppressionTest(QUOTE_ITEM_TRIGGER, { lastInTry: "await client.query(SQL.done);" }), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger committed by a statement written out", suppressionTest(QUOTE_ITEM_TRIGGER, { lastInTry: `await client.query("COMMIT");` }), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger with a savepoint", suppressionTest(QUOTE_ITEM_TRIGGER, { lastInTry: "await client.query(SQL.save);" }), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger beside an entry chosen by a computed key", suppressionTest(QUOTE_ITEM_TRIGGER, { lastInTry: "await client.query(SQL[key]);" }), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger beside a query on another client", suppressionTest(QUOTE_ITEM_TRIGGER, { lastInTry: "await db.admin.query(SQL.attempt);" }), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger whose finally does not roll back", suppressionTest(QUOTE_ITEM_TRIGGER, { inFinally: "await client.query(SQL.attempt);" }), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger with no BEGIN before the try", suppressionTest(QUOTE_ITEM_TRIGGER, { beforeTry: "await client.query(SQL.attempt);" }), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger as an entry of the statement table", `await db.admin.query(SQL.bad);`, CREATED, `, bad: ${JSON.stringify(QUOTE_ITEM_TRIGGER)}`],
      ["a fixture trigger in a string that is not sent", `const steps = [[${JSON.stringify(TRANSITION_TRIGGER)}]];`, CREATED],
      ["a fixture trigger joined from parts", suppressionTest("PLACEHOLDER").replace(`"PLACEHOLDER"`, `"CREATE TRIGGER pgt112_suppress_quote_item " + "BEFORE INSERT ON shopaccess.quote_items FOR EACH ROW EXECUTE FUNCTION shopaccess.pgt112_suppress_row()"`), CREATED, REVOCATION_ENTRIES],
      // Any other trigger or function, in the permitted place and form.
      ["a trigger that fires after the insert", suppressionTest(QUOTE_ITEM_TRIGGER.replace("BEFORE INSERT", "AFTER INSERT")), CREATED, REVOCATION_ENTRIES],
      ["a trigger on updates too", suppressionTest(QUOTE_ITEM_TRIGGER.replace("BEFORE INSERT", "BEFORE INSERT OR UPDATE")), CREATED, REVOCATION_ENTRIES],
      ["a statement trigger", suppressionTest(QUOTE_ITEM_TRIGGER.replace("FOR EACH ROW", "FOR EACH STATEMENT")), CREATED, REVOCATION_ENTRIES],
      ["a trigger on another table", suppressionTest(QUOTE_ITEM_TRIGGER.replace("shopaccess.quote_items", "shopaccess.quotes")), CREATED, REVOCATION_ENTRIES],
      ["a trigger of another name", suppressionTest(QUOTE_ITEM_TRIGGER.replace("pgt112_suppress_quote_item", "a_first_trigger")), CREATED, REVOCATION_ENTRIES],
      ["a trigger using another function", suppressionTest(QUOTE_ITEM_TRIGGER.replace("shopaccess.pgt112_suppress_row()", "shopaccess.reject_change()")), CREATED, REVOCATION_ENTRIES],
      ["a constraint trigger", suppressionTest(QUOTE_ITEM_TRIGGER.replace("CREATE TRIGGER", "CREATE CONSTRAINT TRIGGER")), CREATED, REVOCATION_ENTRIES],
      ["a fixture trigger replaced", suppressionTest(QUOTE_ITEM_TRIGGER.replace("CREATE TRIGGER", "CREATE OR REPLACE TRIGGER")), CREATED, REVOCATION_ENTRIES],
      ["a fixture function that does something else", suppressionTest(SUPPRESSION_FUNCTION_FIXTURE.replace("RETURN NULL", "RETURN NEW")), CREATED, REVOCATION_ENTRIES],
      ["a production trigger function replaced", suppressionTest(SUPPRESSION_FUNCTION_FIXTURE.replace("CREATE FUNCTION shopaccess.pgt112_suppress_row", "CREATE OR REPLACE FUNCTION shopaccess.reject_change")), CREATED, REVOCATION_ENTRIES],
      ["a fixture function with definer rights", suppressionTest(`${SUPPRESSION_FUNCTION_FIXTURE} SECURITY DEFINER`), CREATED, REVOCATION_ENTRIES],
      ["a production trigger dropped in the permitted place", suppressionTest("DROP TRIGGER quote_items_immutable ON shopaccess.quote_items"), "dropped", REVOCATION_ENTRIES],
      ["a production trigger switched off in the permitted place", suppressionTest("ALTER TABLE shopaccess.quote_items DISABLE TRIGGER ALL"), SWITCHED, REVOCATION_ENTRIES],
      ["a constraint relaxed in the permitted place", suppressionTest("ALTER TABLE shopaccess.quotes ALTER CONSTRAINT quotes_intent_owner_fkey DEFERRABLE"), "altered", REVOCATION_ENTRIES],
      ["a permitted revocation in the PGT-112(c) function", suppressionTest(AUDIT_REVOCATION), PRIVILEGE, REVOCATION_ENTRIES],
      ["default privileges altered", `await db.admin.query("ALTER DEFAULT PRIVILEGES IN SCHEMA shopaccess GRANT SELECT ON TABLES TO shopaccess_web");`, "altered"],
      ["a role altered", `await db.admin.query("ALTER ROLE shopaccess_web SUPERUSER");`, "altered"],
      ["a change of ownership", `await db.admin.query("ALTER TABLE shopaccess.quotes OWNER TO shopaccess_web");`, "altered"],
      ["ownership reassigned", `await db.admin.query("REASSIGN OWNED BY shopaccess_owner TO shopaccess_web");`, "ownership reassigned"],
    ];
    for (const [label, body, fragment, entries] of refused) {
      const violations = violationsIn(body, entries);
      expect(violations.some((violation) => violation.includes(fragment)), `${label}: ${JSON.stringify(violations)}`).toBe(true);
    }
    // A file with no statement table at all is refused too.
    expect(readDatabaseTest(`await db.admin.query("SELECT 1");\n`).violations.some((violation) => violation.includes("it must declare exactly one"))).toBe(true);
  });

  it("PGT-157: no Increment 2.1 database test disables or replaces a trigger, relaxes or drops a constraint, changes the replication role, or sends a privilege statement outside the PGT-128 exception", () => {
    const readings = new Map<string, DatabaseTestReading>();
    for (const name of [...INCREMENT_2_1_DATABASE_TESTS, ...INCREMENT_2_2_DATABASE_TESTS]) {
      const reading = readDatabaseTest(readFileSync(join(ROOT, "tests", "db", name), "utf8"));
      readings.set(name, reading);
      // Every statement the file can send is fixed text, and none of it is prohibited.
      expect(reading.violations, name).toEqual([]);
      // The reading reached the statements the file sends: the ones it is known to send are among those it found.
      for (const anchor of ["BEGIN", "COMMIT", "ROLLBACK"]) expect(reading.statements, `${name}: ${anchor}`).toContain(anchor);
    }
    const statementsOf = (name: string): string[] => readings.get(name)?.statements ?? [];
    const privilegeStatementsOf = (name: string): string[] => statementsOf(name).filter((statement) => prohibitionsIn(statement, PRIVILEGE_STATEMENT).length > 0);

    // The schema file.
    {
      const name = SCHEMA_DATABASE_TEST;
      const starting = (prefix: string): string[] => statementsOf(name).filter((statement) => statement.startsWith(prefix));
      for (const anchor of ["SET ROLE shopaccess_owner", "RESET ROLE"]) expect(statementsOf(name), `${name}: ${anchor}`).toContain(anchor);
      // PGT-158: 7 plain, 7 with CASCADE, 8 naming several tables. PGT-112(b): the six deferred constraints. P6: two locks.
      expect(starting("TRUNCATE shopaccess."), name).toHaveLength(22);
      expect(starting("SET CONSTRAINTS shopaccess."), name).toHaveLength(6);
      expect(statementsOf(name).filter((statement) => statement.endsWith(" FOR UPDATE")), name).toHaveLength(2);
      expect(starting("INSERT INTO shopaccess.checkout_intents").length, name).toBeGreaterThan(0);
      expect(privilegeStatementsOf(name), name).toEqual([]);
    }

    // The two files of the functions migration call the four entry points with exactly the statements of the
    // reviewed catalogue. They cannot import it (the import list above is not widened for them), so the copies are
    // compared here, and a copy that drifts fails this test.
    for (const name of [FUNCTIONS_DATABASE_TEST, CONCURRENCY_DATABASE_TEST]) {
      for (const entry of INCREMENT_2_1_CHECKOUT_ENTRIES) expect(statementsOf(name), `${name}: ${entry}`).toContain(CHECKOUT_STATEMENTS[entry]);
      // No statement of these files calls an entry point in any other form, apart from the one conversion-failure probe.
      const calls = statementsOf(name).filter((statement) => CHECKOUT_CALL.test(statement));
      const probes = calls.filter((statement) => !Object.values(CHECKOUT_STATEMENTS).includes(statement as (typeof CHECKOUT_STATEMENTS)[keyof typeof CHECKOUT_STATEMENTS]));
      expect(probes, name).toEqual(name === FUNCTIONS_DATABASE_TEST ? ["SELECT result FROM shopaccess_api.start_checkout($1, $2, $3, $4, $5::text::integer, $6)"] : []);
    }
    // The two files of the confirmation functions: the two new entry points, the reader and the checkout calls they
    // build on, each with exactly the statement of the reviewed catalogue, and no entry point in any other form.
    for (const name of INCREMENT_2_2_DATABASE_TESTS) {
      for (const entry of ["issueChallenge", "consumeChallenge", "readCheckout", "startCheckout", "cancelCheckout"] as const) expect(statementsOf(name), `${name}: ${entry}`).toContain(CHECKOUT_STATEMENTS[entry]);
      const calls = statementsOf(name).filter((statement) => CHECKOUT_CALL.test(statement));
      expect(calls.filter((statement) => !Object.values(CHECKOUT_STATEMENTS).includes(statement as (typeof CHECKOUT_STATEMENTS)[keyof typeof CHECKOUT_STATEMENTS])), name).toEqual([]);
    }
    // PGT-112(c): the functions file sends exactly the three fixture statements, each once, and no other statement
    // of any of the three files creates, replaces, alters, drops or switches off anything.
    const prohibitedStatementsOf = (name: string): string[] => statementsOf(name).filter((statement) => prohibitionsIn(statement, PROHIBITED_STATEMENTS).length > 0);
    expect(prohibitedStatementsOf(FUNCTIONS_DATABASE_TEST).sort()).toEqual([...PERMITTED_SUPPRESSION_FIXTURES].sort());
    expect(prohibitedStatementsOf(CONCURRENCY_DATABASE_TEST)).toEqual([]);
    expect(prohibitedStatementsOf(SCHEMA_DATABASE_TEST)).toEqual([]);
    // Case S3 (policy P4, first exception, third enumerated use): the confirmation functions file sends exactly two
    // of the three fixture statements, each once: the suppressing function and the trigger on checkout_transitions.
    // The trigger on quote_items is not sent there. The confirmation concurrency file sends none.
    expect(prohibitedStatementsOf(CONFIRMATION_FUNCTIONS_DATABASE_TEST).sort()).toEqual([PERMITTED_SUPPRESSION_FIXTURES[0], PERMITTED_SUPPRESSION_FIXTURES[2]].sort());
    expect(PERMITTED_SUPPRESSION_FIXTURES[0]).toMatch(/^CREATE FUNCTION shopaccess\.pgt112_suppress_row\(\)/);
    expect(PERMITTED_SUPPRESSION_FIXTURES[2]).toMatch(/^CREATE TRIGGER pgt112_suppress_transition BEFORE INSERT ON shopaccess\.checkout_transitions /);
    expect(prohibitedStatementsOf(CONFIRMATION_CONCURRENCY_DATABASE_TEST)).toEqual([]);
    // PGT-128: the functions file sends exactly the four permitted revocations, each once; the other file sends none.
    expect(privilegeStatementsOf(FUNCTIONS_DATABASE_TEST).sort()).toEqual([...PERMITTED_REVOCATIONS].sort());
    expect(privilegeStatementsOf(CONCURRENCY_DATABASE_TEST)).toEqual([]);
    // Cases A4 to A8 (policy P4, second exception, second enumerated use): the confirmation functions file sends
    // exactly one of the four revocations, once: INSERT on audit_events. None of the three request-window
    // revocations is sent there. The confirmation concurrency file sends none.
    expect(privilegeStatementsOf(CONFIRMATION_FUNCTIONS_DATABASE_TEST)).toEqual([AUDIT_REVOCATION]);
    expect(PERMITTED_REVOCATIONS).toContain(AUDIT_REVOCATION);
    expect(privilegeStatementsOf(CONFIRMATION_CONCURRENCY_DATABASE_TEST)).toEqual([]);

    // The reviewed catalogues the tests may also send from, or copy from, hold nothing prohibited either.
    for (const statement of [...Object.values(OPERATOR_STATEMENTS), ...Object.values(SESSION_STATEMENTS), ...Object.values(CHECKOUT_STATEMENTS)]) {
      expect(
        [
          ...prohibitionsIn(statement, PROHIBITED_STATEMENTS),
          ...prohibitionsIn(statement, INDIRECT_EXECUTION),
          ...prohibitionsIn(statement, PRIVILEGE_STATEMENT),
          ...unreadableOrAnonymousBlock(statement),
        ],
        statement,
      ).toEqual([]);
    }
  });
});

describe("Increment 2.1 functions migration (0008): static checks", () => {
  const source = sqlOf("0008");
  const sql = withoutComments(source);
  const ENTRY_POINTS = ["cancel_checkout", "list_owner_checkouts", "read_checkout", "start_checkout"];
  const HELPERS = ["checkout_transition", "descriptive_terms_digest", "owner_window_decision", "quote_digest_saqd1", "quote_material_change", "require_read_committed"];
  const DEFERRED_CONSTRAINTS = [
    "shopaccess.checkout_intents_predecessor_reciprocal_fkey",
    "shopaccess.checkout_intents_current_quote_fkey",
    "shopaccess.checkout_intents_history_check",
    "shopaccess.checkout_transitions_history_check",
    "shopaccess.quotes_item_check",
    "shopaccess.quote_items_quote_check",
  ];

  /** Each function of the file: its name, everything before its body, and its body. */
  const definitions = sql
    .split(/(?=CREATE FUNCTION )/)
    .filter((part) => part.startsWith("CREATE FUNCTION"))
    .map((part) => {
      const name = /CREATE FUNCTION shopaccess_api\.([a-z0-9_]+)\(/.exec(part)?.[1] ?? "";
      const opening = part.indexOf("AS $$");
      const closing = part.indexOf("$$;", opening + 5);
      return { name, header: part.slice(0, opening), body: part.slice(opening + 5, closing) };
    });
  const definitionOf = (name: string) => {
    const found = definitions.find((definition) => definition.name === name);
    if (!found) throw new Error(`migration 0008 does not define ${name}`);
    return found;
  };
  const parametersOf = (name: string): string[] => {
    const header = definitionOf(name).header;
    return header
      .slice(header.indexOf("(") + 1, header.indexOf(") RETURNS"))
      .split(",")
      .map((parameter) => parameter.trim().replace(/\s+/g, " "));
  };
  /** The code of a body: quoted values emptied, white space collapsed. */
  const codeOf = (name: string): string => sqlCode(definitionOf(name).body) ?? "";

  it("defines exactly four entry points and six helpers, each with its mode, owner hand-over and fixed search path", () => {
    expect(definitions.map((definition) => definition.name).sort()).toEqual([...ENTRY_POINTS, ...HELPERS].sort());
    for (const { name, header } of definitions) {
      expect(header, name).toMatch(/SET search_path = pg_catalog, pg_temp/);
      // Entry points are definer-rights; helpers run with the rights of whoever calls them (19.7a).
      expect(/SECURITY DEFINER/.test(header), name).toBe(ENTRY_POINTS.includes(name));
      // No function of the file takes a time or an interval from a runtime caller: only two helpers take a time at all.
      if (!["owner_window_decision", "quote_digest_saqd1"].includes(name)) expect(parametersOf(name).join(", "), name).not.toMatch(/timestamp|interval|date/i);
    }
    const mode = (name: string): string => /LANGUAGE (sql|plpgsql)\s+(IMMUTABLE|STABLE)?/.exec(definitionOf(name).header)?.slice(1).join(" ").trim() ?? "";
    expect(Object.fromEntries(definitions.map(({ name }) => [name, mode(name)]))).toEqual({
      require_read_committed: "plpgsql STABLE",
      owner_window_decision: "sql IMMUTABLE",
      checkout_transition: "sql IMMUTABLE",
      quote_digest_saqd1: "sql STABLE",
      descriptive_terms_digest: "sql STABLE",
      quote_material_change: "sql STABLE",
      start_checkout: "plpgsql",
      cancel_checkout: "plpgsql",
      read_checkout: "sql STABLE",
      list_owner_checkouts: "sql STABLE",
    });

    // Privileges: nothing for PUBLIC on any of the ten; EXECUTE for the web role on the four entry points only;
    // every function handed to shopaccess_definer, with CREATE on the schema held only for the hand-over.
    expect([...sql.matchAll(/REVOKE ALL ON FUNCTION shopaccess_api\.([a-z0-9_]+)\([^)]*\) FROM PUBLIC;/g)].map((match) => match[1]).sort()).toEqual([...ENTRY_POINTS, ...HELPERS].sort());
    expect([...sql.matchAll(/GRANT EXECUTE ON FUNCTION shopaccess_api\.([a-z0-9_]+)\([^)]*\) TO ([a-z_]+);/g)].map((match) => `${match[1]}>${match[2]}`).sort()).toEqual(ENTRY_POINTS.map((name) => `${name}>shopaccess_web`));
    expect([...sql.matchAll(/ALTER FUNCTION shopaccess_api\.([a-z0-9_]+)\([^)]*\) OWNER TO shopaccess_definer;/g)].map((match) => match[1]).sort()).toEqual([...ENTRY_POINTS, ...HELPERS].sort());
    const grantAt = sql.indexOf("GRANT CREATE ON SCHEMA shopaccess_api TO shopaccess_definer;");
    const revokeAt = sql.indexOf("REVOKE CREATE ON SCHEMA shopaccess_api FROM shopaccess_definer;");
    expect(grantAt).toBeGreaterThan(-1);
    expect(grantAt).toBeLessThan(sql.indexOf("OWNER TO shopaccess_definer"));
    expect(revokeAt).toBeGreaterThan(sql.lastIndexOf("OWNER TO shopaccess_definer"));
    // The file grants no DELETE and no TRUNCATE, nothing to the worker, the operator or PUBLIC, and no role membership.
    expect(sql).not.toMatch(/GRANT[^;]*\b(?:DELETE|TRUNCATE|ALL)\b/);
    expect(sql).not.toMatch(/TO (?:shopaccess_worker|shopaccess_operator|PUBLIC)\b/);
    // It creates no table, index, trigger or constraint, and changes none.
    expect(sql).not.toMatch(/\b(?:CREATE|ALTER)\s+(?:TABLE|(?:UNIQUE\s+)?INDEX|(?:CONSTRAINT\s+)?TRIGGER)\b/);
  });

  it("PGT-73e: start_checkout takes the credential, a product, a variant, a quantity and a predecessor, and no amount or digest", () => {
    expect(parametersOf("start_checkout")).toEqual([
      "p_key_version smallint",
      "p_token_digest text",
      "p_product_id text",
      "p_variant_id text",
      "p_quantity integer",
      "p_replaces_intent_id text",
    ]);
    expect(parametersOf("cancel_checkout")).toEqual(["p_key_version smallint", "p_token_digest text", "p_intent_id text"]);
    expect(parametersOf("read_checkout")).toEqual(["p_key_version smallint", "p_token_digest text", "p_intent_id text"]);
    expect(parametersOf("list_owner_checkouts")).toEqual(["p_key_version smallint", "p_token_digest text"]);
    for (const name of ENTRY_POINTS) {
      // No owner, session, amount, currency, merchant, price or digest is accepted from a caller.
      expect(parametersOf(name).slice(2).join(", "), name).not.toMatch(/owner|session|amount|cents|currency|merchant|price|total|digest/i);
      expect(definitionOf(name).header, name).not.toMatch(/RETURNS TABLE \([^)]*token_digest/);
    }
    // The exact helper signatures of specification 19.7a.
    expect(parametersOf("require_read_committed")).toEqual(["p_value integer"]);
    expect(parametersOf("owner_window_decision")).toEqual(["p_window_started_at timestamptz", "p_window_calls integer", "p_t timestamptz"]);
    expect(parametersOf("checkout_transition")).toEqual([
      "p_from_state text",
      "p_from_version integer",
      "p_event_type text",
      "p_actor text",
      "p_entry_point text",
      "p_current_quote_id text",
      "p_current_confirmation_id text",
      "p_current_superseded_by_intent_id text",
      "p_event_quote_id text",
      "p_event_confirmation_id text",
      "p_event_successor_intent_id text",
    ]);
    expect(parametersOf("quote_digest_saqd1")).toHaveLength(19);
    expect(parametersOf("descriptive_terms_digest")).toEqual(["p_description text", "p_specs jsonb"]);
    expect(parametersOf("quote_material_change")).toHaveLength(20);
  });

  it("PGT-135: each read function is one SQL SELECT, STABLE, ends in the isolation guard, and calls only the four permitted functions", () => {
    const expectedLimit: Record<string, string> = { read_checkout: "1", list_owner_checkouts: "100" };
    for (const name of ["read_checkout", "list_owner_checkouts"]) {
      const { header } = definitionOf(name);
      expect(header, name).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY DEFINER/);
      const code = codeOf(name);
      // One statement, and it is a SELECT.
      const statements = code.split(";").map((statement) => statement.trim()).filter((statement) => statement !== "");
      expect(statements, name).toHaveLength(1);
      expect(statements[0], name).toMatch(/^SELECT\b/);
      // The LIMIT expression is the guard, with the function's own limit, and nothing follows it.
      expect(statements[0].endsWith(`LIMIT shopaccess_api.require_read_committed(${expectedLimit[name]})`), name).toBe(true);
      // The only functions of the schema it calls.
      const called = [...new Set([...code.matchAll(/shopaccess_api\.([a-z0-9_]+)\(/g)].map((match) => match[1]))].sort();
      for (const helper of called) expect(["session_is_live", "require_read_committed", "descriptive_terms_digest", "quote_material_change"], `${name}: ${helper}`).toContain(helper);
      expect(called, name).toContain("session_is_live");
      expect(called, name).toContain("require_read_committed");
      // It takes no lock and writes nothing; its time is the start of the calling statement.
      expect(code, name).not.toMatch(/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b|\bFOR\s+KEY\s+SHARE\b/i);
      expect(code, name).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
      expect(code, name).not.toMatch(/clock_timestamp|now\(\)|current_timestamp|transaction_timestamp/i);
      expect(code, name).toMatch(/statement_timestamp\(\)/);
    }
    expect(codeOf("list_owner_checkouts")).toMatch(/ORDER BY i\.created_at DESC, i\.id DESC LIMIT/);
    // QUOTE_EXPIRED is derived in both, by the same rule.
    for (const name of ["read_checkout", "list_owner_checkouts"]) expect(definitionOf(name).body, name).toMatch(/IN \('QUOTED', 'USER_CONFIRMED'\) AND statement_timestamp\(\) >= [a-z_.]+ THEN 'QUOTE_EXPIRED'/);
  });

  it("PGT-133 and PGT-139 (static parts): the mutating functions check the isolation level first, catch nothing, count no rows, and nothing wraps them", () => {
    for (const name of ["start_checkout", "cancel_checkout"]) {
      const code = codeOf(name);
      // The first statement of the body is the isolation guard, before the credential is even looked at.
      expect(code.slice(code.indexOf("BEGIN")), name).toMatch(/^BEGIN PERFORM shopaccess_api\.require_read_committed\(1\);/);
      // No exception handler: a generated-identifier collision, a lock timeout and a failed check are all errors.
      expect(code, name).not.toMatch(/\bEXCEPTION\s+WHEN\b|\bWHEN\s+OTHERS\b|unique_violation|lock_not_available|NOWAIT|SKIP\s+LOCKED/i);
      // No row-count check after its own writes: a suppressed row must be caught by the forced deferred checks.
      expect(code, name).not.toMatch(/ROW_COUNT|GET\s+DIAGNOSTICS/i);
      // Forcing is mandatory: the six deferred constraints set IMMEDIATE, then DEFERRED, after the last write.
      const forcing = [...code.matchAll(/SET CONSTRAINTS ([a-z_., ]+?) (IMMEDIATE|DEFERRED);/g)].map((match) => ({ names: match[1].split(",").map((part) => part.trim()), mode: match[2] }));
      expect(forcing.map((entry) => entry.mode), name).toEqual(["IMMEDIATE", "DEFERRED"]);
      for (const entry of forcing) expect(entry.names, name).toEqual(DEFERRED_CONSTRAINTS);
      expect(code.indexOf("SET CONSTRAINTS"), name).toBeGreaterThan(Math.max(code.lastIndexOf("INSERT INTO"), code.lastIndexOf("UPDATE shopaccess.")));
      // No session touch, no write to a challenge, no delete of anything.
      expect(code, name).not.toMatch(/(?:UPDATE|INSERT INTO|DELETE FROM) shopaccess\.(?:shopper_sessions|confirmation_challenges|checkout_owners|server_key_versions)\b/);
      expect(code, name).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/);
      // Two clock readings and no other source of time.
      expect([...code.matchAll(/(v_t[46]) := clock_timestamp\(\);/g)].map((match) => match[1]), name).toEqual(["v_t4", "v_t6"]);
      // Timestamp contract (19.7): an existing window row's updated_at never moves backward; a first row is at v_t4.
      expect([...code.matchAll(/updated_at = GREATEST\(w\.updated_at, v_t4\)/g)], name).toHaveLength(3);
      expect(code, name).toMatch(/VALUES \(v_owner_id, v_t4, 1, 0, 0, v_t4\)/);
      expect(code, name).toMatch(/updated_at = GREATEST\(i\.updated_at, v_t6\)/);
      expect(code, name).not.toMatch(/updated_at = v_t/);
    }
    // PGT-133 (d): only the catalogue and its checkout service may refer to checkout statements. The service sends
    // each mutation directly through the one-statement queryable; it does not introduce a transaction or rerun.
    const sourceFiles = filesUnder(join(ROOT, "src"), /\.(ts|tsx)$/).map((path) => ({ path, text: readFileSync(path, "utf8") }));
    expect(checkoutCatalogueReferenceFiles(sourceFiles)).toEqual([...APPROVED_CHECKOUT_CATALOGUE_FILES].sort());
    expect(unauthorizedCheckoutCatalogueReferences(sourceFiles)).toEqual([]);
    const checkoutService = readFileSync(join(PG_SOURCE_DIR, "checkout-service.ts"), "utf8");
    expect(hasWrappedCheckoutMutation(checkoutService)).toBe(false);
    // The service names each of the four mutating statements exactly once, and each time in the supported form.
    expect(checkoutMutationSites(checkoutService)).toEqual({ direct: [...MUTATING_CHECKOUT_STATEMENTS].sort(), violations: [] });
    expect(hasCallNamed(checkoutService, "runWithReruns")).toBe(false);
    for (const statement of Object.values(CHECKOUT_STATEMENTS)) expect(statement).not.toMatch(/;|\bBEGIN\b|\bCOMMIT\b/i);
  });

  it("rejects an executable checkout-catalogue reference from an unauthorized application module", () => {
    const harmlessComment = {
      path: join(ROOT, "src", "server", "unapproved-checkout-reader.ts"),
      text: "// CHECKOUT_STATEMENTS is discussed here, but not referenced by executable code.\nexport {};",
    };
    expect(unauthorizedCheckoutCatalogueReferences([harmlessComment])).toEqual([]);
    const fixture = {
      path: join(ROOT, "src", "server", "unapproved-checkout-reader.ts"),
      text: 'import { CHECKOUT_STATEMENTS } from "@/lib/pg/statements"; void CHECKOUT_STATEMENTS.startCheckout;',
    };
    expect(unauthorizedCheckoutCatalogueReferences([fixture])).toEqual([join("src", "server", "unapproved-checkout-reader.ts")]);
  });

  it("rejects a transaction wrapper around a mutating checkout statement", () => {
    expect(hasWrappedCheckoutMutation(`async function send(db: Db) {
      return withTransaction(db, () => db.query(statements.startCheckout, []));
    }`)).toBe(true);
  });

  it("rejects a mutating checkout query that is extracted into a callback and handed to another function", () => {
    // The form the direct-call rule alone would miss: the query call is the body of a function, and it is that
    // function, not the call, that is handed to the helper.
    const extracted = `function createService(db: Db) {
      return {
        async start(values: unknown[]) {
          const mutation = () => db.query(statements.startCheckout, values);
          return retryMutation(mutation);
        },
      };
    }`;
    expect(checkoutMutationSites(extracted).direct).toEqual([]);
    expect(checkoutMutationSites(extracted).violations).toEqual([
      "startCheckout: the query call is not awaited where it is made and kept in a variable",
      "startCheckout: the query call is not made directly in a method of the service object",
    ]);
    expect(hasWrappedCheckoutMutation(extracted)).toBe(true);

    // The same with the await inside the extracted function: awaited and kept, but not in a method of the service.
    const extractedAsync = `function createService(db: Db) {
      return {
        async cancel(values: unknown[]) {
          const mutation = async () => {
            const reply = await db.query(statements.cancelCheckout, values);
            return reply;
          };
          return retryMutation(mutation);
        },
      };
    }`;
    expect(checkoutMutationSites(extractedAsync).violations).toEqual(["cancelCheckout: the query call is not made directly in a method of the service object"]);

    // The statement itself kept in a variable, to be sent from somewhere this rule does not follow.
    const aliased = `function createService(db: Db) {
      return {
        async issue(values: unknown[]) {
          const text = statements.issueChallenge;
          const reply = await db.query(text, values);
          return reply;
        },
      };
    }`;
    expect(checkoutMutationSites(aliased).violations).toEqual(["issueChallenge: the statement is used other than as the text of a query call"]);

    // Named through the catalogue's own name instead of the local alias: the same rule applies.
    const byCatalogueName = `function createService(db: Db) {
      return {
        async consume(values: unknown[]) {
          return retryMutation(() => db.query(CHECKOUT_STATEMENTS.consumeChallenge, values));
        },
      };
    }`;
    expect(hasWrappedCheckoutMutation(byCatalogueName)).toBe(true);
    // A call that is returned instead of being awaited in place, and a top-level function that is not a method.
    expect(hasWrappedCheckoutMutation(`function createService(db: Db) { return { start(values: unknown[]) { return db.query(statements.startCheckout, values); } }; }`)).toBe(true);
    expect(hasWrappedCheckoutMutation(`async function start(db: Db, values: unknown[]) { const reply = await db.query(statements.startCheckout, values); return reply; }`)).toBe(true);
  });

  it("accepts the supported form: a mutating statement awaited in place, in a method of the service object", () => {
    const supported = `function createService(db: Db) {
      const statements = CHECKOUT_STATEMENTS;
      return {
        async start(values: unknown[]) {
          const reply = await db.query(statements.startCheckout, values);
          return reply.rows;
        },
        async issue(values: unknown[]) {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const reply = await db.query(statements.issueChallenge, values);
            if (reply.rows.length === 1) return reply.rows;
          }
          return [];
        },
        // A read is not a mutation, and this rule says nothing about it.
        async read(values: unknown[]) {
          return db.query(statements.readCheckout, values);
        },
      };
    }`;
    expect(checkoutMutationSites(supported)).toEqual({ direct: ["issueChallenge", "startCheckout"], violations: [] });
    expect(hasWrappedCheckoutMutation(supported)).toBe(false);
  });

  it("rejects automatic rerun wrapping around a mutating checkout statement", () => {
    expect(hasWrappedCheckoutMutation(`async function send(db: Db) {
      return runWithReruns(() => db.query(statements.issueChallenge, []));
    }`)).toBe(true);
  });

  it("business results are decided in the order of 19.7, and the audit rows carry exactly the approved keys", () => {
    const body = definitionOf("start_checkout").body;
    const returned = (result: string): number => body.indexOf(`RETURN QUERY SELECT '${result}'::text`);
    const order = [
      "REPLACEMENT_NOT_ALLOWED",
      "PRODUCT_NOT_IN_MERCHANT_CATALOG",
      "VARIANT_UNAVAILABLE",
      "QUANTITY_EXCEEDS_LIMIT",
      "AMOUNT_OUT_OF_RANGE",
      "GROUP_INTENT_LIMIT",
      "AT_PURCHASE_CAPACITY",
      "STARTED",
    ].map(returned);
    expect(order.every((position) => position > -1)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    // Precedence before step 8: REQUEST_INVALID before any lock; RATE_LIMITED before the resource is looked at.
    expect(returned("REQUEST_INVALID")).toBeLessThan(body.indexOf("FOR SHARE"));
    expect(returned("RATE_LIMITED")).toBeGreaterThan(body.indexOf("FROM shopaccess.owner_request_windows w"));
    expect(returned("RATE_LIMITED")).toBeLessThan(body.indexOf("FROM shopaccess.checkout_intents i"));
    // The catalog is read once, in one joined statement, after the last lock.
    expect([...body.matchAll(/FROM shopaccess\.merchant_variants mv/g)]).toHaveLength(1);
    expect(body.indexOf("FROM shopaccess.merchant_variants mv")).toBeGreaterThan(body.lastIndexOf("FOR UPDATE"));

    // Every audit row of the file: its event type and the keys of its detail, exactly.
    const audited = [...sql.matchAll(/'ev_' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\), '([A-Z_]+)'[\s\S]*?jsonb_build_object\(([\s\S]*?)\)\);/g)].map((match) => ({
      event: match[1],
      // A key is a camelCase name followed by its value. A quoted VALUE (a reason code, a time zone) is not one.
      keys: [...match[2].matchAll(/'([a-z][A-Za-z]*)',/g)].map((key) => key[1]),
    }));
    const keysOf = (event: string): string[][] => audited.filter((row) => row.event === event).map((row) => row.keys);
    expect([...new Set(audited.map((row) => row.event))].sort()).toEqual(["CHECKOUT_CANCELED", "CHECKOUT_REFUSED_AT_CAPACITY", "CHECKOUT_SUPERSEDED", "OWNER_RATE_LIMITED", "QUOTE_ISSUED"]);
    expect(keysOf("QUOTE_ISSUED")).toEqual([["transitionEventId", "quoteId", "purchaseGroupId", "productId", "variantId", "quantity", "totalCents"]]);
    expect(keysOf("CHECKOUT_SUPERSEDED")).toEqual([["transitionEventId", "supersededByIntentId"]]);
    expect(keysOf("CHECKOUT_CANCELED")).toEqual([["transitionEventId", "fromState"]]);
    expect(keysOf("CHECKOUT_REFUSED_AT_CAPACITY")).toEqual([
      ["reason", "limit", "purchaseGroupId"],
      ["reason", "limit"],
    ]);
    // One in each mutating function.
    expect(keysOf("OWNER_RATE_LIMITED")).toEqual([
      ["limit", "windowSeconds", "windowStartedAt"],
      ["limit", "windowSeconds", "windowStartedAt"],
    ]);
    for (const row of audited) expect(row.keys.join(" "), row.event).not.toMatch(/digest|token|nonce|keyVersion|secret/i);
    // Every audit row has its two times equal, and carries the session and the owner in their columns.
    expect([...sql.matchAll(/'ev_' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\), '[A-Z_]+', (v_t[46]), (v_t[46]), '(server|shopper)',\s+v_session_id, v_owner_id,/g)].map((match) => match[1] === match[2])).toEqual(
      audited.map(() => true),
    );
  });

  it("SAQD-1 and SADT-1 are computed by one helper each, from fixed prefixes, and the functions use nothing else for them", () => {
    // "SAQD", version 01, 19 fields; "SADT", version 01, 2 fields.
    expect(definitionOf("quote_digest_saqd1").body).toContain("decode('53415144010013', 'hex')");
    expect(definitionOf("descriptive_terms_digest").body).toContain("decode('53414454010002', 'hex')");
    expect([...definitionOf("quote_digest_saqd1").body.matchAll(/\(\d+, (?:true|false), /g)]).toHaveLength(19);
    expect([...sql.matchAll(/sha256\(/g)]).toHaveLength(2);
    // The stored digests come from the helpers, in start_checkout only.
    expect([...definitionOf("start_checkout").body.matchAll(/shopaccess_api\.quote_digest_saqd1\(/g)]).toHaveLength(1);
    expect([...definitionOf("start_checkout").body.matchAll(/shopaccess_api\.descriptive_terms_digest\(/g)]).toHaveLength(1);
    expect(definitionOf("cancel_checkout").body).not.toMatch(/quote_digest_saqd1|descriptive_terms_digest/);
    // The transition rules are in one helper; each mutating function asks it and writes what it answers.
    expect([...definitionOf("start_checkout").body.matchAll(/shopaccess_api\.checkout_transition\(/g)]).toHaveLength(2);
    expect([...definitionOf("cancel_checkout").body.matchAll(/shopaccess_api\.checkout_transition\(/g)]).toHaveLength(1);
    // Cancellation and supersession write the confirmation pointer back as the helper returned it, never NULL.
    expect(definitionOf("cancel_checkout").body).toMatch(/confirmation_id = v_next_confirmation_id,/);
    expect(definitionOf("start_checkout").body).toMatch(/confirmation_id = v_pred_next_confirmation_id,/);
    expect(sql).not.toMatch(/confirmation_id = NULL|confirmation_status = /);
  });
});

describe("Increment 2.2 confirmation functions migration (0009): static checks (PGT-225, PGT-227)", () => {
  const source = sqlOf("0009");
  const sql = withoutComments(source);
  const ENTRY_POINTS = ["consume_challenge", "issue_challenge", "read_checkout"];
  const DEFERRED_CONSTRAINTS = [
    "shopaccess.checkout_intents_predecessor_reciprocal_fkey",
    "shopaccess.checkout_intents_current_quote_fkey",
    "shopaccess.checkout_intents_history_check",
    "shopaccess.checkout_transitions_history_check",
    "shopaccess.quotes_item_check",
    "shopaccess.quote_items_quote_check",
  ];
  const SIGNATURES: Record<string, string> = {
    read_checkout: "smallint, text, text",
    issue_challenge: "smallint, text, text, text, smallint, text",
    consume_challenge: "smallint, text, text, text, text, text",
  };
  // The three unique constraints of confirmation_challenges that contain the challenge id (migration 0007). A
  // violation of any of them can only mean that a row with that id already exists.
  const ID_CONSTRAINTS = ["confirmation_challenges_pkey", "confirmation_challenges_id_intent_key", "confirmation_challenges_id_intent_status_key"];

  const definitions = sql
    .split(/(?=CREATE FUNCTION )/)
    .filter((part) => part.startsWith("CREATE FUNCTION"))
    .map((part) => {
      const name = /CREATE FUNCTION shopaccess_api\.([a-z0-9_]+)\(/.exec(part)?.[1] ?? "";
      const opening = part.indexOf("AS $$");
      const closing = part.indexOf("$$;", opening + 5);
      return { name, header: part.slice(0, opening), body: part.slice(opening + 5, closing) };
    });
  const definitionOf = (name: string) => {
    const found = definitions.find((definition) => definition.name === name);
    if (!found) throw new Error(`migration 0009 does not define ${name}`);
    return found;
  };
  const parametersOf = (name: string): string[] => {
    const header = definitionOf(name).header;
    return header
      .slice(header.indexOf("(") + 1, header.indexOf(") RETURNS"))
      .split(",")
      .map((parameter) => parameter.trim().replace(/\s+/g, " "));
  };
  const returnsOf = (header: string): string[] =>
    (/RETURNS TABLE \(([^)]*)\)/.exec(header)?.[1] ?? "").split(",").map((column) => column.trim().replace(/\s+/g, " "));
  /** The code of a body: quoted values emptied, white space collapsed. */
  const codeOf = (name: string): string => sqlCode(definitionOf(name).body) ?? "";
  /** The result codes a body returns, in the order they stand in it. */
  const resultsOf = (name: string): string[] => [...definitionOf(name).body.matchAll(/RETURN QUERY SELECT '([A-Z_]+)'::text/g)].map((match) => match[1]);

  // ---- The reader replacement: one role switch, one DROP, one switch back (decision 12) ----

  const ROLE_TO_OWNER_OF_FUNCTION = "SET ROLE shopaccess_definer";
  const THE_DROP = "DROP FUNCTION shopaccess_api.read_checkout(smallint, text, text)";
  const ROLE_TO_MIGRATION_ROLE = "SET ROLE shopaccess_owner";
  const ROLE_OR_DROP = /\b(?:DROP|CASCADE|RESET|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE|SESSION\s+AUTHORIZATION)\b|\bIF\s+EXISTS\b/i;
  /**
   * What is wrong with the role and DROP statements of a list of top-level statements, or null. The only accepted
   * shape: the first three statements are the switch to the function's owner, the one DROP, and the switch back to
   * the migration role, in that order; the fourth creates read_checkout again; and no other statement anywhere names
   * a role command, a DROP, CASCADE or IF EXISTS.
   */
  const replacementDefect = (statements: readonly string[]): string | null => {
    if (statements[0] !== ROLE_TO_OWNER_OF_FUNCTION) return "the file does not begin with the switch to the function owner";
    if (statements[1] !== THE_DROP) return "the switch to the function owner is not followed at once by the one permitted DROP";
    if (statements[2] !== ROLE_TO_MIGRATION_ROLE) return "the DROP is not followed at once by the switch back to the migration role";
    if (!/^CREATE FUNCTION shopaccess_api\.read_checkout\(/.test(statements[3] ?? "")) return "read_checkout is not created again right after the switch back";
    const elsewhere = statements.slice(3).filter((statement) => ROLE_OR_DROP.test(statement));
    return elsewhere.length > 0 ? `a role command, DROP, CASCADE or IF EXISTS outside the three permitted statements: ${elsewhere[0].slice(0, 60)}` : null;
  };

  // Every statement form the file uses, each spelled out to its end. Anything else at top level is refused.
  const CONFIRMATION_STATEMENT = new RegExp(
    "^(?:" +
      [
        "SET ROLE shopaccess_definer",
        "DROP FUNCTION shopaccess_api\\.read_checkout\\(smallint, text, text\\)",
        "SET ROLE shopaccess_owner",
        "CREATE FUNCTION shopaccess_api\\.(?:read_checkout|issue_challenge|consume_challenge)\\(.*",
        "REVOKE ALL ON FUNCTION shopaccess_api\\.(?:read_checkout|issue_challenge|consume_challenge)\\([a-z, ]*\\) FROM PUBLIC",
        "GRANT EXECUTE ON FUNCTION shopaccess_api\\.(?:read_checkout|issue_challenge|consume_challenge)\\([a-z, ]*\\) TO shopaccess_web",
        "GRANT INSERT ON shopaccess\\.confirmation_challenges TO shopaccess_definer",
        "GRANT UPDATE \\(status, consumed_at, superseded_at, expired_marked_at\\) ON shopaccess\\.confirmation_challenges TO shopaccess_definer",
        "GRANT CREATE ON SCHEMA shopaccess_api TO shopaccess_definer",
        "ALTER FUNCTION shopaccess_api\\.(?:read_checkout|issue_challenge|consume_challenge)\\([a-z, ]*\\) OWNER TO shopaccess_definer",
        "REVOKE CREATE ON SCHEMA shopaccess_api FROM shopaccess_definer",
      ].join("|") +
      ")$",
  );
  const confirmationStatementRefusal = (statement: string): string | null => (CONFIRMATION_STATEMENT.test(statement) ? null : "statement form not allowed");

  // ---- The one exception handler (decision 8) ----

  /**
   * What is wrong with the exception handling of the body of issue_challenge, or null. The only accepted shape:
   * exactly one handler in the body; it belongs to a block that holds exactly two statements, the update that ends
   * the previous challenge and the insert of the new one; it catches unique_violation and nothing else; it reads the
   * schema, the table and the constraint of the violation; it answers REFUSED only for the three constraints that
   * contain the challenge id, and raises every other error again; the admission stands before the block; and nothing
   * is written after it. `body` is the body with comments removed.
   */
  const handlerDefect = (body: string): string | null => {
    const code = sqlCode(body);
    if (code === null) return "the body cannot be read";
    const handlers = [...code.matchAll(/\bEXCEPTION\s+WHEN\b/g)];
    if (handlers.length !== 1) return `${handlers.length} exception handlers`;
    if (/\bWHEN\s+OTHERS\b|\bSQLSTATE\b|\bSQLERRM\b|\block_not_available\b/i.test(code)) return "a broad handler, or one that reads the error some other way";
    const handlerAt = code.indexOf("EXCEPTION WHEN");
    const blockAt = code.lastIndexOf("BEGIN ", handlerAt);
    const blockEnd = code.indexOf("END; IF v_refused THEN", handlerAt);
    if (blockAt <= code.indexOf("BEGIN ") || blockEnd === -1) return "the handler does not belong to the one protected block";
    const protectedStatements = code
      .slice(blockAt + "BEGIN ".length, handlerAt)
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    if (protectedStatements.length !== 2) return `${protectedStatements.length} statements in the protected block`;
    if (!/^UPDATE shopaccess\.confirmation_challenges c SET status = /.test(protectedStatements[0])) return "the first protected statement is not the update that ends the previous challenge";
    if (!/^INSERT INTO shopaccess\.confirmation_challenges \(/.test(protectedStatements[1])) return "the second protected statement is not the insert of the new challenge";
    const handler = code.slice(handlerAt, blockEnd).trim();
    if ((handler.match(/\bWHEN\b/g) ?? []).length !== 1 || !handler.startsWith("EXCEPTION WHEN unique_violation THEN ")) return "the handler catches something other than unique_violation alone";
    const handlerStatements = handler
      .slice("EXCEPTION WHEN unique_violation THEN ".length)
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    if (handlerStatements.length !== 4) return `${handlerStatements.length} statements in the handler`;
    if (handlerStatements[0] !== "GET STACKED DIAGNOSTICS v_violation_schema = SCHEMA_NAME, v_violation_table = TABLE_NAME, v_violation_constraint = CONSTRAINT_NAME") return "the handler does not read the schema, the table and the constraint of the violation";
    if (!/^IF v_violation_schema = '' AND v_violation_table = '' AND v_violation_constraint IN \( ?'', '', '' ?\) THEN v_refused := true$/.test(handlerStatements[1])) return "the handler does not decide on exactly the schema, the table and three constraint names";
    if (handlerStatements[2] !== "ELSE RAISE" || handlerStatements[3] !== "END IF") return "an error that is not the id collision is not raised again";
    // The names themselves, read from the text as it is written.
    const written = /EXCEPTION\s+WHEN[\s\S]*?END IF;/.exec(body)?.[0] ?? "";
    const names = [...written.matchAll(/'([^']*)'/g)].map((match) => match[1]);
    if (names.length !== 5 || names[0] !== "shopaccess" || names[1] !== "confirmation_challenges") return "the handler does not name the schema shopaccess and the table confirmation_challenges";
    if (names.slice(2).join(",") !== ID_CONSTRAINTS.join(",")) return "the handler does not name exactly the three constraints that contain the challenge id";
    // Admission before the block; no request-window or audit statement in it; no write after it.
    const admissionAt = code.indexOf("INSERT INTO shopaccess.owner_request_windows");
    if (admissionAt === -1 || admissionAt > blockAt) return "the admission does not stand before the protected block";
    const block = code.slice(blockAt, blockEnd);
    if (/owner_request_windows|audit_events|\bRETURN\b|\bPERFORM\b|\bFOR\s+(?:UPDATE|SHARE)\b/.test(block)) return "the protected block holds more than the two challenge statements";
    if (/\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/.test(code.slice(blockEnd))) return "something is written after the protected block";
    const challengeWrites = [...code.matchAll(/(?:UPDATE|INSERT INTO) shopaccess\.confirmation_challenges\b/g)].map((match) => match.index ?? -1);
    if (challengeWrites.length !== 2 || challengeWrites.some((at) => at < blockAt || at > handlerAt)) return "a challenge is written outside the protected block";
    return null;
  };

  it("defines exactly three functions: the recreated reader and the two confirmation entry points, with their modes, hand-over and fixed search path", () => {
    expect(definitions.map((definition) => definition.name).sort()).toEqual(ENTRY_POINTS);
    expect([...sql.matchAll(/CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER|CONSTRAINT TRIGGER|TYPE|SCHEMA|ROLE)\b/g)]).toEqual([]);
    for (const { name, header, body } of definitions) {
      expect(header, name).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp\s*$/);
      expect(parametersOf(name).slice(0, 2), name).toEqual(["p_key_version smallint", "p_token_digest text"]);
      expect(returnsOf(header)[0], name).toBe("result text");
      // No function takes a time, an owner, an amount, a currency, a merchant or a summary.
      expect(parametersOf(name).join(", "), name).not.toMatch(/timestamp|interval|date|owner|amount|cents|currency|merchant|summary/i);
      // No dynamic statement anywhere.
      expect(body, name).not.toMatch(/\bEXECUTE\b/i);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION shopaccess_api.${name}(${SIGNATURES[name]}) FROM PUBLIC;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION shopaccess_api.${name}(${SIGNATURES[name]}) TO shopaccess_web;`);
      expect(sql).toContain(`ALTER FUNCTION shopaccess_api.${name}(${SIGNATURES[name]}) OWNER TO shopaccess_definer;`);
    }
    expect(parametersOf("issue_challenge")).toEqual(["p_key_version smallint", "p_token_digest text", "p_intent_id text", "p_challenge_id text", "p_nonce_key_version smallint", "p_nonce_digest text"]);
    expect(returnsOf(definitionOf("issue_challenge").header)).toEqual(["result text", "challenge_id text", "quote_digest text", "nonce_key_version smallint", "nonce_digest text", "summary jsonb", "expires_at timestamptz"]);
    expect(parametersOf("consume_challenge")).toEqual(["p_key_version smallint", "p_token_digest text", "p_challenge_id text", "p_nonce text", "p_quote_id text", "p_quote_digest text"]);
    expect(returnsOf(definitionOf("consume_challenge").header)).toEqual(["result text", "intent_id text"]);
    for (const name of ["issue_challenge", "consume_challenge"]) {
      expect(definitionOf(name).header, name).toMatch(/LANGUAGE plpgsql\s+SECURITY DEFINER/);
      expect(definitionOf(name).body, name).toMatch(/#variable_conflict use_column/);
    }
    // The hand-over: CREATE on the schema is granted before the first change of owner and taken away after the last.
    const grantAt = sql.indexOf("GRANT CREATE ON SCHEMA shopaccess_api TO shopaccess_definer;");
    const revokeAt = sql.indexOf("REVOKE CREATE ON SCHEMA shopaccess_api FROM shopaccess_definer;");
    expect(grantAt).toBeGreaterThan(-1);
    expect(grantAt).toBeLessThan(sql.indexOf("OWNER TO shopaccess_definer"));
    expect(revokeAt).toBeGreaterThan(sql.lastIndexOf("OWNER TO shopaccess_definer"));
    expect([...sql.matchAll(/OWNER TO shopaccess_definer;/g)]).toHaveLength(3);
    // The table privileges of 19.13, and no other grant on any table.
    expect([...sql.matchAll(/GRANT\s+([^;]+?)\s+ON shopaccess\.([a-z_]+) TO ([a-z_]+);/g)].map((match) => `${match[1]} ON ${match[2]} TO ${match[3]}`)).toEqual([
      "INSERT ON confirmation_challenges TO shopaccess_definer",
      "UPDATE (status, consumed_at, superseded_at, expired_marked_at) ON confirmation_challenges TO shopaccess_definer",
    ]);
    expect(sql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|WITH GRANT OPTION|shopaccess_worker|shopaccess_operator/);
  });

  it("PGT-227: read_checkout is replaced by exactly one switch to its owner, one DROP and one switch back, and every other top-level statement has a listed form", () => {
    const statements = topLevelStatements(source);
    expect(replacementDefect(statements)).toBeNull();
    expect(statements.slice(0, 3)).toEqual([ROLE_TO_OWNER_OF_FUNCTION, THE_DROP, ROLE_TO_MIGRATION_ROLE]);
    // The three statements stand next to each other, in this order, with nothing between them.
    expect(sql).toContain("SET ROLE shopaccess_definer;\nDROP FUNCTION shopaccess_api.read_checkout(smallint, text, text);\nSET ROLE shopaccess_owner;\n");
    expect(sql).not.toMatch(/\bCASCADE\b|\bIF\s+EXISTS\b|\bRESET\b|\bSESSION\s+AUTHORIZATION\b|\bSET\s+LOCAL\b|\bSET\s+SESSION\b/i);
    for (const statement of statements) expect(confirmationStatementRefusal(statement), statement.slice(0, 70)).toBeNull();
    // No function body changes the role either.
    for (const { name, body } of definitions) expect(body, name).not.toMatch(/\bROLE\b|\bDROP\b|SESSION\s+AUTHORIZATION/i);

    // Negative controls: each of these lists is the real one with one change, and each is refused.
    const rest = statements.slice(3);
    const refusedLists: Array<[string, string[]]> = [
      ["the DROP of another function", [ROLE_TO_OWNER_OF_FUNCTION, "DROP FUNCTION shopaccess_api.start_checkout(smallint, text, text, text, integer, text)", ROLE_TO_MIGRATION_ROLE, ...rest]],
      ["the DROP of a table", [ROLE_TO_OWNER_OF_FUNCTION, "DROP TABLE shopaccess.confirmation_challenges", ROLE_TO_MIGRATION_ROLE, ...rest]],
      ["CASCADE", [ROLE_TO_OWNER_OF_FUNCTION, `${THE_DROP} CASCADE`, ROLE_TO_MIGRATION_ROLE, ...rest]],
      ["IF EXISTS", [ROLE_TO_OWNER_OF_FUNCTION, "DROP FUNCTION IF EXISTS shopaccess_api.read_checkout(smallint, text, text)", ROLE_TO_MIGRATION_ROLE, ...rest]],
      ["a second DROP", [...statements, THE_DROP]],
      ["a second DROP right after the first", [ROLE_TO_OWNER_OF_FUNCTION, THE_DROP, THE_DROP, ROLE_TO_MIGRATION_ROLE, ...rest]],
      ["a switch to another role", ["SET ROLE shopaccess_web", THE_DROP, ROLE_TO_MIGRATION_ROLE, ...rest]],
      ["no switch to the function owner", [THE_DROP, ROLE_TO_MIGRATION_ROLE, ...rest]],
      ["RESET ROLE in place of naming the migration role", [ROLE_TO_OWNER_OF_FUNCTION, THE_DROP, "RESET ROLE", ...rest]],
      ["SET SESSION AUTHORIZATION", [ROLE_TO_OWNER_OF_FUNCTION, THE_DROP, "SET SESSION AUTHORIZATION shopaccess_owner", ...rest]],
      ["SET LOCAL ROLE", ["SET LOCAL ROLE shopaccess_definer", THE_DROP, ROLE_TO_MIGRATION_ROLE, ...rest]],
      ["something between the switch and the DROP", [ROLE_TO_OWNER_OF_FUNCTION, rest[0], THE_DROP, ROLE_TO_MIGRATION_ROLE, ...rest.slice(1)]],
      ["no switch back after the DROP", [ROLE_TO_OWNER_OF_FUNCTION, THE_DROP, ...rest]],
      ["a switch back that comes later", [ROLE_TO_OWNER_OF_FUNCTION, THE_DROP, rest[0], ROLE_TO_MIGRATION_ROLE, ...rest.slice(1)]],
      ["the switch to the function owner again, later in the file", [...statements, ROLE_TO_OWNER_OF_FUNCTION]],
      ["a switch back to the migration role again, later in the file", [...statements, ROLE_TO_MIGRATION_ROLE]],
      ["the function not created again", [ROLE_TO_OWNER_OF_FUNCTION, THE_DROP, ROLE_TO_MIGRATION_ROLE, ...rest.slice(1)]],
    ];
    for (const [label, list] of refusedLists) expect(replacementDefect(list), label).not.toBeNull();
    for (const refused of [
      "DROP FUNCTION shopaccess_api.read_checkout(smallint, text, text) CASCADE",
      "DROP FUNCTION IF EXISTS shopaccess_api.read_checkout(smallint, text, text)",
      "DROP FUNCTION shopaccess_api.cancel_checkout(smallint, text, text)",
      "SET ROLE shopaccess_web",
      "RESET ROLE",
      "SET SESSION AUTHORIZATION shopaccess_owner",
      "SET LOCAL ROLE shopaccess_definer",
      "GRANT shopaccess_definer TO shopaccess_web",
      "GRANT DELETE ON shopaccess.confirmation_challenges TO shopaccess_definer",
      "GRANT UPDATE ON shopaccess.confirmation_challenges TO shopaccess_definer",
      "GRANT UPDATE (status, nonce_digest) ON shopaccess.confirmation_challenges TO shopaccess_definer",
      "GRANT INSERT ON shopaccess.confirmation_challenges TO shopaccess_web",
      "GRANT INSERT ON shopaccess.confirmation_challenges TO shopaccess_definer WITH GRANT OPTION",
      "GRANT EXECUTE ON FUNCTION shopaccess_api.issue_challenge(smallint, text, text, text, smallint, text) TO PUBLIC",
      "GRANT EXECUTE ON FUNCTION shopaccess_api.quote_digest_saqd1(text) TO shopaccess_web",
      "ALTER FUNCTION shopaccess_api.issue_challenge(smallint, text, text, text, smallint, text) OWNER TO shopaccess_web",
      "INSERT INTO shopaccess.confirmation_challenges (id) VALUES ($1)",
      "DO",
    ]) {
      expect(confirmationStatementRefusal(refused), refused).not.toBeNull();
    }
  });

  it("PGT-225: the recreated read_checkout is one SQL SELECT, STABLE, ends in the isolation guard, and returns the 33 columns of Increment 2.1 followed by eight challenge columns", () => {
    const { header, body } = definitionOf("read_checkout");
    expect(header).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY DEFINER/);
    expect(parametersOf("read_checkout")).toEqual(["p_key_version smallint", "p_token_digest text", "p_intent_id text"]);
    const code = codeOf("read_checkout");
    const statements = code.split(";").map((statement) => statement.trim()).filter((statement) => statement !== "");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^SELECT\b/);
    expect(statements[0].endsWith("LIMIT shopaccess_api.require_read_committed(1)")).toBe(true);
    const called = [...new Set([...code.matchAll(/shopaccess_api\.([a-z0-9_]+)\(/g)].map((match) => match[1]))].sort();
    expect(called).toEqual(["quote_material_change", "require_read_committed", "session_is_live"]);
    expect(code).not.toMatch(/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b|\bFOR\s+KEY\s+SHARE\b/i);
    expect(code).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
    expect(code).not.toMatch(/clock_timestamp|now\(\)|current_timestamp|transaction_timestamp/i);
    expect(code).toMatch(/statement_timestamp\(\)/);
    expect(code).not.toMatch(/\bEXCEPTION\b|\bRAISE\b/);
    expect(body).toMatch(/IN \('QUOTED', 'USER_CONFIRMED'\) AND statement_timestamp\(\) >= [a-z_.]+ THEN 'QUOTE_EXPIRED'/);

    // 41 columns: the 33 of migration 0008, unchanged in name, type and order, and then these eight.
    const columns = returnsOf(header);
    const before = /CREATE FUNCTION shopaccess_api\.read_checkout\([^)]*\) RETURNS TABLE \(([^)]*)\)/.exec(withoutComments(sqlOf("0008")))?.[1].split(",").map((column) => column.trim().replace(/\s+/g, " ")) ?? [];
    expect(before).toHaveLength(33);
    expect(columns).toHaveLength(41);
    expect(columns.slice(0, 33)).toEqual(before);
    expect(columns.slice(33)).toEqual([
      "challenge_id text",
      "challenge_quote_digest text",
      "challenge_nonce_key_version smallint",
      "challenge_nonce_digest text",
      "challenge_summary jsonb",
      "challenge_issued_at timestamptz",
      "challenge_expires_at timestamptz",
      "challenge_usable boolean",
    ]);
    expect(CHECKOUT_STATEMENTS.readCheckout.slice("SELECT ".length, CHECKOUT_STATEMENTS.readCheckout.indexOf(" FROM ")).split(", ")).toEqual(columns.map((column) => column.split(" ")[0]));
    // Only the ACTIVE challenge of the intent's current quote, of the same intent and owner, is ever shown.
    expect(body).toMatch(/LEFT JOIN shopaccess\.confirmation_challenges c\s+ON c\.quote_id = q\.id AND c\.checkout_intent_id = i\.id AND c\.owner_id = s\.owner_id AND c\.status = 'ACTIVE'/);
    // The usable flag: the seven conditions of the contract, and NULL when not authorized.
    const usable = /CASE\s+WHEN v\.found_intent_id IS NULL THEN NULL\s+ELSE coalesce\(([\s\S]*?),\s+false\)\s+END/.exec(body)?.[1].replace(/\s+/g, " ").trim();
    expect(usable).toBe(
      "v.found_challenge_id IS NOT NULL AND v.found_state = 'QUOTED' AND statement_timestamp() < v.found_quote_expires_at AND statement_timestamp() < v.found_challenge_expires_at AND v.found_challenge_quote_digest = v.found_quote_digest AND NOT v.found_quote_stale AND v.found_nonce_key_status IN ('ACTIVE', 'VERIFY_ONLY')",
    );
    // Never returned: a token digest, a session id, the nonce key's status, the descriptive-terms digest.
    expect(columns.join(", ")).not.toMatch(/token|session|key_status|descriptive/);
  });

  it("the mutating functions check the isolation level first, lock in the order of 19.4, read the clock twice and touch no session", () => {
    for (const name of ["issue_challenge", "consume_challenge"]) {
      const code = codeOf(name);
      expect(code.slice(code.indexOf("BEGIN")), name).toMatch(/^BEGIN PERFORM shopaccess_api\.require_read_committed\(1\);/);
      expect(code, name).not.toMatch(/ROW_COUNT|GET\s+DIAGNOSTICS|NOWAIT|SKIP\s+LOCKED/i);
      expect(code, name).not.toMatch(/(?:UPDATE|INSERT INTO|DELETE FROM) shopaccess\.(?:shopper_sessions|checkout_owners|server_key_versions|quotes|quote_items|purchase_groups|merchants|merchant_products|merchant_variants)\b/);
      expect(code, name).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/);
      expect([...code.matchAll(/(v_t[46]) := clock_timestamp\(\);/g)].map((match) => match[1]), name).toEqual(["v_t4", "v_t6"]);
      // Exactly one key row is locked, the nonce key, FOR SHARE, and it is locked before the session row.
      const keyLocks = [...code.matchAll(/FROM shopaccess\.server_key_versions k WHERE k\.purpose = '' AND k\.key_version = [a-z_]+ FOR SHARE;/g)];
      expect(keyLocks, name).toHaveLength(1);
      expect([...code.matchAll(/FROM shopaccess\.server_key_versions\b[^;]*\bFOR\b/g)], name).toHaveLength(1);
      const sessionLockAt = code.search(/FROM shopaccess\.shopper_sessions s WHERE [^;]* FOR SHARE;/);
      const ownerLockAt = code.search(/FROM shopaccess\.checkout_owners o WHERE o\.id = v_owner_id FOR UPDATE;/);
      const windowLockAt = code.search(/FROM shopaccess\.owner_request_windows w WHERE w\.owner_id = v_owner_id FOR UPDATE;/);
      const intentLockAt = code.search(/FROM shopaccess\.checkout_intents i WHERE [^;]* FOR UPDATE;/);
      const challengeLockAt = code.search(/FROM shopaccess\.confirmation_challenges c WHERE [^;]* FOR UPDATE;/);
      const order = [keyLocks[0].index ?? -1, sessionLockAt, ownerLockAt, windowLockAt, intentLockAt, challengeLockAt];
      expect(order.every((at) => at > -1), `${name}: ${order.join(", ")}`).toBe(true);
      expect([...order].sort((left, right) => left - right), name).toEqual(order);
      // No catalog row is locked: the catalog is read once, after the last lock.
      expect(code, name).not.toMatch(/merchant_(?:variants|products) [a-z]+ [^;]*\bFOR\s+(?:UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)\b/);
      expect(code.indexOf("shopaccess_api.quote_material_change("), name).toBeGreaterThan(challengeLockAt);
      // Timestamp contract: the request-window floors of 19.7, as in migration 0008.
      expect([...code.matchAll(/updated_at = GREATEST\(w\.updated_at, v_t4\)/g)], name).toHaveLength(3);
      expect(code, name).toMatch(/VALUES \(v_owner_id, v_t4, 1, 0, 0, v_t4\)/);
      expect(code, name).not.toMatch(/updated_at = v_t/);
      // The first-in-window throttle audit row is timed at the step 4 reading; confirmation events at step 6.
      expect(code, name).toMatch(/'', v_t4, v_t4, '', v_session_id, v_owner_id, NULL, NULL,/);
    }
    // consume_challenge forces the six deferred checks after its last write; issue_challenge writes nothing that a
    // deferred check watches, and forces none.
    const consume = codeOf("consume_challenge");
    const forcing = [...consume.matchAll(/SET CONSTRAINTS ([a-z_., ]+?) (IMMEDIATE|DEFERRED);/g)].map((match) => ({ names: match[1].split(",").map((part) => part.trim()), mode: match[2] }));
    expect(forcing.map((entry) => entry.mode)).toEqual(["IMMEDIATE", "DEFERRED"]);
    for (const entry of forcing) expect(entry.names).toEqual(DEFERRED_CONSTRAINTS);
    expect(consume.indexOf("SET CONSTRAINTS")).toBeGreaterThan(Math.max(consume.lastIndexOf("INSERT INTO"), consume.lastIndexOf("UPDATE shopaccess.")));
    expect(consume).toMatch(/updated_at = GREATEST\(i\.updated_at, v_t6\)/);
    expect(codeOf("issue_challenge")).not.toMatch(/SET CONSTRAINTS/);
    expect(codeOf("issue_challenge")).not.toMatch(/(?:UPDATE|INSERT INTO) shopaccess\.(?:checkout_intents|checkout_transitions)\b/);
    // Step 0d of consume_challenge is an unlocked lookup by id and owner together, and the key lock depends on it.
    expect(definitionOf("consume_challenge").body).toMatch(/WHERE c\.id = p_challenge_id AND c\.owner_id = v_owner_id;\s+v_known := FOUND;[\s\S]*?IF v_known THEN\s+SELECT k\.status INTO v_nonce_key_status/);
    // Since Increment 2.3 the two statements are sent from one place, the checkout service, and named nowhere else
    // in the library. The server modules of PostgreSQL mode call the service; they hold no statement.
    const SERVICE = join(PG_SOURCE_DIR, "checkout-service.ts");
    expect(readFileSync(SERVICE, "utf8")).toMatch(/statements\.issueChallenge/);
    expect(readFileSync(SERVICE, "utf8")).toMatch(/statements\.consumeChallenge/);
    for (const file of filesUnder(join(ROOT, "src"), /\.(ts|tsx)$/)) {
      if (file === join(PG_SOURCE_DIR, "statements.ts") || file === SERVICE) continue;
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/issueChallenge|consumeChallenge|CHECKOUT_STATEMENTS/);
      if (!file.startsWith(PG_SOURCE_DIR)) expect(text, file).not.toMatch(/shopaccess_api\./);
      // The nonce is derived in the checkout service alone. The one other user of the nonce module is the confirm
      // handler, which checks the form of a submitted nonce and derives nothing.
      if (file === join(PG_SOURCE_DIR, "confirmation-nonce.ts")) continue;
      expect(text, file).not.toMatch(/deriveConfirmationNonce|confirmationNonceDigest|confirmationNonceMessage|CONFIRMATION_NONCE_LABEL/);
      if (file === join(ROOT, "src", "server", "pg-handlers.ts")) {
        expect(text.match(/confirmation-nonce/g)).toHaveLength(1);
        expect(text).toContain('import { isCanonicalConfirmationNonce } from "@/lib/pg/confirmation-nonce";');
      } else {
        expect(text, file).not.toMatch(/confirmation-nonce|isCanonicalConfirmationNonce/);
      }
    }
    const service = readFileSync(SERVICE, "utf8");
    expect(service).toContain('import { confirmationNonceDigest, deriveConfirmationNonce } from "./confirmation-nonce";');
    // Derived with a key the ring lends, and only the digest is a value of the issue call.
    expect(service).toMatch(/ring\.useKey\(version, \(key\) => \{\s+const nonce = deriveConfirmationNonce\(key, \{ challengeId, ownerId, quoteDigest \}\);\s+return \{ nonce, nonceDigest: confirmationNonceDigest\(nonce\) \};/);
    expect(service).toMatch(/statements\.issueChallenge, \[\s+credential\.keyVersion,\s+credential\.tokenDigest,\s+input\.intentId,\s+challengeId,\s+version,\s+derived\.nonceDigest,\s+\]/);
  });

  it("business results are decided in the reviewed order, and expiry, reuse and the ceiling are compared as the contract says", () => {
    expect(resultsOf("issue_challenge")).toEqual([
      "NOT_AUTHORIZED", // step 0a
      "NOT_AUTHORIZED", // step 0b: no session
      "NOT_AUTHORIZED", // step 0b: not live
      "REQUEST_INVALID", // step 0c
      "NOT_AUTHORIZED", // step 2
      "NOT_AUTHORIZED", // step 4
      "RATE_LIMITED", // step 4b
      "NOT_AUTHORIZED", // step 6
      "INTENT_NOT_AWAITING_CONFIRMATION", // rule 1
      "QUOTE_EXPIRED", // rule 2
      "QUOTE_STALE_CATALOG", // rule 3
      "QUOTE_DIGEST_MISMATCH", // rule 4
      "NONCE_KEY_NOT_ACTIVE", // rule 5
      "CONFIRMATION_ALREADY_USED", // rule 6
      "REUSED", // rule 7
      "CHALLENGE_LIMIT_REACHED", // rule 8
      "REFUSED", // rule 9: the id exists already
      "REFUSED", // rule 10: the id came to exist while this call ran
      "ISSUED",
    ]);
    expect(resultsOf("consume_challenge")).toEqual([
      "NOT_AUTHORIZED", // step 0a
      "NOT_AUTHORIZED", // step 0b: no session
      "NOT_AUTHORIZED", // step 0b: not live
      "REQUEST_INVALID", // step 0c
      "NOT_AUTHORIZED", // step 2
      "NOT_AUTHORIZED", // step 4
      "CONFIRMATION_NOT_FOUND", // row 1, before the throttle decision
      "RATE_LIMITED", // step 4b
      "NOT_AUTHORIZED", // step 6
      "CONFIRMATION_SUPERSEDED", // row 2
      "CONFIRMATION_ALREADY_USED", // row 3
      "CONFIRMATION_KEY_REVOKED", // row 4
      "CONFIRMATION_ALREADY_USED", // row 5
      "CONFIRMATION_MISMATCH", // row 6
      "CONFIRMATION_EXPIRED", // row 7
      "QUOTE_DIGEST_MISMATCH", // row 8
      "QUOTE_EXPIRED", // row 9
      "QUOTE_STALE_CATALOG", // row 10
      "INTENT_NOT_AWAITING_CONFIRMATION", // row 11
      "CONFIRMED", // row 12
    ]);
    const issue = definitionOf("issue_challenge").body;
    const consume = definitionOf("consume_challenge").body;
    // Admission stands before every business rule, and after the last NOT_AUTHORIZED.
    for (const [name, body, first] of [["issue_challenge", issue, "'INTENT_NOT_AWAITING_CONFIRMATION'"], ["consume_challenge", consume, "'CONFIRMATION_SUPERSEDED'"]] as const) {
      const admissionAt = body.indexOf("INSERT INTO shopaccess.owner_request_windows");
      expect(admissionAt, name).toBeGreaterThan(body.lastIndexOf("'NOT_AUTHORIZED'"));
      expect(admissionAt, name).toBeLessThan(body.indexOf(first));
    }
    // CONFIRMATION_NOT_FOUND is decided before the request window is classified, and nothing is written before it.
    const notFoundAt = consume.indexOf("'CONFIRMATION_NOT_FOUND'");
    expect(notFoundAt).toBeLessThan(consume.indexOf("shopaccess_api.owner_window_decision("));
    expect(consume.slice(0, notFoundAt)).not.toMatch(/\b(?:INSERT INTO|UPDATE shopaccess\.|DELETE FROM)\b/);
    // Reuse only with strictly more than 60 seconds left (the exact threshold is static evidence: PGT-16).
    expect(issue).toMatch(/AND v_active_expires_at - v_t6 > interval '60 seconds' THEN/);
    expect(issue).not.toMatch(/>= interval '60 seconds'/);
    expect(issue).toMatch(/AND v_active_quote_digest = v_quote_digest\s+AND v_active_key_version = p_nonce_key_version/);
    // Five minutes, capped at the quote's expiry; at most eight rows per quote in any status; decided before a write.
    expect(issue).toMatch(/v_new_expires_at := LEAST\(v_t6 \+ interval '5 minutes', v_quote_expires_at\);/);
    expect(issue).toMatch(/c_challenge_ceiling constant integer := 8;/);
    expect(issue).toMatch(/WHERE c\.quote_id = v_quote_id;\s+IF v_challenge_count >= c_challenge_ceiling THEN/);
    expect(issue.indexOf("'CHALLENGE_LIMIT_REACHED'")).toBeLessThan(issue.indexOf("UPDATE shopaccess.confirmation_challenges"));
    // Expiry is decided on the step 6 reading as it is: at or after the expiry is expired. No floor is applied.
    expect(issue).toMatch(/IF v_t6 >= v_quote_expires_at THEN/);
    expect(consume).toMatch(/IF v_ch_status = 'EXPIRED' OR v_t6 >= v_ch_expires_at THEN/);
    expect(consume).toMatch(/IF v_t6 >= v_quote_expires_at THEN/);
    expect(`${issue}\n${consume}`).not.toMatch(/GREATEST\([^)]*\) >= v_[a-z_]*expires_at/);
    // The time of consumption is floored at the time of issue, and only in the write of the success path.
    expect([...consume.matchAll(/consumed_at = GREATEST\(v_t6, c\.issued_at\)/g)]).toHaveLength(1);
    expect(consume.indexOf("consumed_at = GREATEST(v_t6, c.issued_at)")).toBeGreaterThan(consume.indexOf("'INTENT_NOT_AWAITING_CONFIRMATION'"));
    // The nonce: canonical format before any lock; hashed here; never stored.
    expect(consume).toContain("p_nonce !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'");
    expect(consume).toContain("encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex') IS DISTINCT FROM v_ch_nonce_digest");
    // The nonce appears in the body in exactly three places: twice in the format check, once where it is hashed.
    expect([...consume.matchAll(/p_nonce\b/g)]).toHaveLength(3);
    // Success: the challenge first, then the transition helper, the intent with its pointer, the transition, the audit.
    const steps = ["status = 'CONSUMED',", "shopaccess_api.checkout_transition(", "confirmation_status = 'CONSUMED',", "INSERT INTO shopaccess.checkout_transitions", "'CONFIRMATION_ACCEPTED'", "SET CONSTRAINTS"].map((step) => consume.indexOf(step, consume.indexOf("'INTENT_NOT_AWAITING_CONFIRMATION'")));
    expect(steps.every((at) => at > -1)).toBe(true);
    expect([...steps].sort((left, right) => left - right)).toEqual(steps);
    expect(consume).toMatch(/'SHOPPER_CONFIRMED', 'shopper', 'consume_challenge',\s+v_quote_pointer, v_confirmation_id, v_superseded_by,\s+v_ch_quote_id, p_challenge_id, NULL\)/);
  });

  it("PGT-227: exactly one exception handler exists, in issue_challenge, and it answers REFUSED only for a collision of the challenge id", () => {
    const issue = definitionOf("issue_challenge").body;
    expect(handlerDefect(issue)).toBeNull();
    // The whole file: one handler, one reading of the diagnostics, no row count, and none in the other two functions.
    expect([...sql.matchAll(/\bEXCEPTION\s+WHEN\b/g)]).toHaveLength(1);
    expect([...sql.matchAll(/GET\s+STACKED\s+DIAGNOSTICS/g)]).toHaveLength(1);
    expect(sql).not.toMatch(/ROW_COUNT|\bWHEN\s+OTHERS\b|SQLSTATE\s+'|SQLERRM/);
    for (const name of ["consume_challenge", "read_checkout"]) {
      expect(codeOf(name), name).not.toMatch(/\bEXCEPTION\s+WHEN\b|unique_violation|DIAGNOSTICS/);
    }
    // The three constraints are exactly the unique constraints of the table that contain the id (migration 0007);
    // the constraint on the nonce digest and the two partial unique indexes are not among them.
    const schema = withoutComments(sqlOf("0007"));
    const unique = [...schema.matchAll(/CONSTRAINT (confirmation_challenges_[a-z_]+) (?:PRIMARY KEY|UNIQUE) \(([a-z_, ]+)\)/g)].map((match) => ({ name: match[1], columns: match[2].split(",").map((column) => column.trim()) }));
    expect(unique.map((entry) => entry.name).sort()).toEqual([...ID_CONSTRAINTS, "confirmation_challenges_nonce_digest_key"].sort());
    expect(unique.filter((entry) => entry.columns.includes("id")).map((entry) => entry.name)).toEqual(ID_CONSTRAINTS);
    for (const entry of unique.filter((candidate) => candidate.columns.includes("id"))) expect(entry.columns[0], entry.name).toBe("id");
    expect(issue).not.toMatch(/nonce_digest_key|one_active_idx|one_consumed_idx/);

    // Negative controls: each is the real body with one change, and each is refused.
    const change = (from: string | RegExp, to: string): string => {
      const changed = issue.replace(from, to);
      if (changed === issue) throw new Error(`the control changed nothing: ${String(from)}`);
      return changed;
    };
    // The admission (step 7) cut out of its place and put into the protected block instead.
    const admissionFrom = issue.indexOf("  IF NOT v_window_exists THEN");
    const admissionTo = issue.indexOf("  IF v_state IS DISTINCT FROM 'QUOTED' THEN");
    expect(admissionFrom).toBeGreaterThan(-1);
    expect(admissionTo).toBeGreaterThan(admissionFrom);
    const admissionInsideTheBlock = `${issue.slice(0, admissionFrom)}${issue.slice(admissionTo)}`.replace(
      "\n  BEGIN\n    UPDATE shopaccess.confirmation_challenges c",
      "\n  BEGIN\n    INSERT INTO shopaccess.owner_request_windows (owner_id) VALUES (v_owner_id);\n    UPDATE shopaccess.confirmation_challenges c",
    );
    expect(admissionInsideTheBlock).toContain("BEGIN\n    INSERT INTO shopaccess.owner_request_windows (owner_id)");
    const AUDIT_INSERT = "INSERT INTO shopaccess.audit_events (event_id) VALUES ('x');";
    const WINDOW_UPDATE = "UPDATE shopaccess.owner_request_windows w SET window_calls = w.window_calls + 1 WHERE w.owner_id = v_owner_id;";
    const refusedBodies: Array<[string, string]> = [
      ["a broad handler", change("WHEN unique_violation THEN", "WHEN OTHERS THEN")],
      ["a second condition in the handler", change("WHEN unique_violation THEN", "WHEN unique_violation OR lock_not_available THEN")],
      ["a second handler clause", change(/(\n\s+END;\n\n\s+IF v_refused THEN)/, "\n    WHEN check_violation THEN\n      v_refused := true;$1")],
      ["an error that is swallowed instead of raised again", change(/ELSE\s+RAISE;/, "ELSE\n        v_refused := true;")],
      ["no filter on the constraint at all", change(/IF v_violation_schema = 'shopaccess'[\s\S]*?THEN\s+v_refused := true;\s+ELSE\s+RAISE;\s+END IF;/, "v_refused := true;")],
      ["the nonce digest constraint among the accepted ones", change("'confirmation_challenges_id_intent_status_key')", "'confirmation_challenges_id_intent_status_key',\n               'confirmation_challenges_nonce_digest_key')")],
      ["another constraint in place of the primary key", change("'confirmation_challenges_pkey',", "'confirmation_challenges_nonce_digest_key',")],
      ["another table", change("AND v_violation_table = 'confirmation_challenges'", "AND v_violation_table = 'quotes'")],
      ["no check of the table", change(/\s+AND v_violation_table = 'confirmation_challenges'/, "")],
      ["the diagnostics not read", change(/GET STACKED DIAGNOSTICS[\s\S]*?CONSTRAINT_NAME;/, "")],
      ["an audit row written inside the protected block", change(/(\n\s+EXCEPTION\n\s+WHEN unique_violation THEN)/, `\n    ${AUDIT_INSERT}$1`)],
      ["the request window written inside the protected block", change(/(\n\s+EXCEPTION\n\s+WHEN unique_violation THEN)/, `\n    ${WINDOW_UPDATE}$1`)],
      ["a return from inside the protected block", change(/(\n\s+EXCEPTION\n\s+WHEN unique_violation THEN)/, "\n    RETURN;$1")],
      ["an audit row written inside the handler", change(/(GET STACKED DIAGNOSTICS)/, `${AUDIT_INSERT}\n      $1`)],
      ["the previous challenge ended outside the protected block", change(/(\n  BEGIN\n    UPDATE shopaccess\.confirmation_challenges c)/, "\n  UPDATE shopaccess.confirmation_challenges c SET status = 'SUPERSEDED', superseded_at = v_t6 WHERE c.id = v_active_id;$1")],
      ["a write after the protected block", change(/(\n  RETURN QUERY SELECT 'ISSUED'::text)/, `\n  ${AUDIT_INSERT}$1`)],
      ["a second handler elsewhere in the function", change(/(\n  v_new_expires_at := LEAST\()/, "\n  BEGIN\n    PERFORM 1;\n  EXCEPTION\n    WHEN unique_violation THEN\n      NULL;\n  END;$1")],
      ["the admission moved into the protected block", admissionInsideTheBlock],
    ];
    for (const [label, body] of refusedBodies) expect(handlerDefect(body), label).not.toBeNull();
  });

  it("the confirmation audit rows carry exactly the reviewed columns and keys, at the step 6 reading, and never a nonce, a digest or a key version", () => {
    const issue = definitionOf("issue_challenge").body;
    const consume = definitionOf("consume_challenge").body;
    const all = `${issue}\n${consume}`;
    const eventsOf = (body: string): string[] => [...body.matchAll(/'(CONFIRMATION_ACCEPTED|CONFIRMATION_REJECTED|OWNER_RATE_LIMITED)'/g)].map((match) => match[1]);
    expect(eventsOf(issue)).toEqual(["OWNER_RATE_LIMITED", "CONFIRMATION_REJECTED"]);
    expect(eventsOf(consume)).toEqual(["OWNER_RATE_LIMITED", "CONFIRMATION_REJECTED", "CONFIRMATION_REJECTED", "CONFIRMATION_REJECTED", "CONFIRMATION_ACCEPTED"]);
    // No other event type is written by this file, and every audit insert names the same ten columns.
    expect([...all.matchAll(/INSERT INTO shopaccess\.audit_events\s+\(([a-z_, ]+)\)/g)].map((match) => match[1])).toEqual(Array.from({ length: 7 }, () => "event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail"));
    expect([...all.matchAll(/\('ev_' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\), '([A-Z_]+)', (v_t[46]), (v_t[46]), '([a-z]+)',\s+v_session_id, v_owner_id, ([a-z_A-Z]+), NULL,/g)].map((match) => match.slice(1).join(" "))).toEqual([
      "OWNER_RATE_LIMITED v_t4 v_t4 server NULL",
      "CONFIRMATION_REJECTED v_t6 v_t6 shopper p_intent_id",
      "OWNER_RATE_LIMITED v_t4 v_t4 server NULL",
      "CONFIRMATION_REJECTED v_t6 v_t6 shopper v_known_intent_id",
      "CONFIRMATION_REJECTED v_t6 v_t6 shopper v_known_intent_id",
      "CONFIRMATION_REJECTED v_t6 v_t6 shopper v_known_intent_id",
      "CONFIRMATION_ACCEPTED v_t6 v_t6 shopper v_known_intent_id",
    ]);
    // Rejections: exactly the keys result and challengeId. On the issue side there is no challenge: challengeId is
    // null, and the id the caller sent is never written. On the consume side it is the id of the locked challenge.
    const rejections = (body: string): string[] => [...body.matchAll(/jsonb_build_object\(\s*'result', '([A-Z_]+)',\s*'challengeId', ([A-Za-z_:]+)\)\);/g)].map((match) => `${match[1]} ${match[2]}`);
    expect(rejections(issue)).toEqual(["QUOTE_DIGEST_MISMATCH NULL::text"]);
    expect(rejections(consume)).toEqual(["CONFIRMATION_KEY_REVOKED p_challenge_id", "CONFIRMATION_MISMATCH p_challenge_id", "QUOTE_DIGEST_MISMATCH p_challenge_id"]);
    // In consume_challenge, p_challenge_id is the id of the row locked at step 5: that row is selected by it.
    expect(consume).toMatch(/WHERE c\.id = p_challenge_id AND c\.owner_id = v_owner_id\s+FOR UPDATE;/);
    // Each audited result is returned right after its audit row, and no other result has one.
    for (const [body, audited] of [[issue, ["QUOTE_DIGEST_MISMATCH"]], [consume, ["CONFIRMATION_KEY_REVOKED", "CONFIRMATION_MISMATCH", "QUOTE_DIGEST_MISMATCH"]]] as const) {
      const afterAudit = [...body.matchAll(/'CONFIRMATION_REJECTED'[\s\S]*?RETURN QUERY SELECT '([A-Z_]+)'::text/g)].map((match) => match[1]);
      expect(afterAudit).toEqual(audited);
    }
    // Acceptance: exactly the keys transitionEventId, challengeId and quoteId.
    expect(consume).toMatch(/jsonb_build_object\(\s*'transitionEventId', v_event_id,\s*'challengeId', p_challenge_id,\s*'quoteId', v_ch_quote_id\)\);/);
    // Nothing secret in any detail or summary: no nonce, no token, no digest, no key version.
    // What is examined is every key and every value expression of every object this file builds; the result codes,
    // which are fixed upper-case words, are set aside first (one of them is named after the digest it refuses).
    const built = [...all.matchAll(/jsonb_build_object\(([^;]*)\);/g)].map((match) => match[1].replace(/'[A-Z_]+'/g, "''"));
    expect(built).toHaveLength(8);
    for (const argumentsText of built) expect(argumentsText).not.toMatch(/nonce|token|digest|key_version|secret/i);
    // The summary is built from the stored quote, with exactly the six reviewed fields.
    expect(issue).toMatch(/v_new_summary := jsonb_build_object\(\s*'merchantName', v_merchant_name,\s*'productTitle', v_product_title,\s*'variantLabel', v_variant_label,\s*'quantity', v_quantity,\s*'currency', v_currency,\s*'totalCents', v_total_cents\);/);
  });
});

describe("PGT-138 (reducer side): the TypeScript reducer agrees with the six transitions of specification 19.2", () => {
  const QUOTE = "qt_00000000000000000000000000000001";
  const OTHER_QUOTE = "qt_00000000000000000000000000000002";
  const CHALLENGE = "cf_00000000000000000000000000000003";
  const SUCCESSOR = "ci_00000000000000000000000000000004";
  const base = { eventId: "ev_00000000000000000000000000000005", occurredAt: "2026-01-01T00:00:00.000Z" } as const;
  const snapshot = (state: PaymentSnapshot["state"], version: number, quoteId: string | null, confirmationId: string | null): PaymentSnapshot => ({
    state,
    version,
    context: { ...INITIAL_PAYMENT_SNAPSHOT.context, quoteId, confirmationId },
  });
  const quoted = snapshot("QUOTED", 2, QUOTE, null);
  const confirmed = snapshot("USER_CONFIRMED", 3, QUOTE, CHALLENGE);

  it("accepts T1 to T6 with the same target state, version step and pointer changes as checkout_transition", () => {
    const t1 = transition(INITIAL_PAYMENT_SNAPSHOT, { ...base, type: "QUOTE_ISSUED", actor: "server", quoteId: QUOTE });
    expect(t1.ok && { state: t1.value.snapshot.state, version: t1.value.snapshot.version, quoteId: t1.value.snapshot.context.quoteId, confirmationId: t1.value.snapshot.context.confirmationId }).toEqual({
      state: "QUOTED",
      version: 2,
      quoteId: QUOTE,
      confirmationId: null,
    });
    const t2 = transition(quoted, { ...base, type: "SHOPPER_CONFIRMED", actor: "shopper", quoteId: QUOTE, confirmationId: CHALLENGE });
    expect(t2.ok && { state: t2.value.snapshot.state, version: t2.value.snapshot.version, quoteId: t2.value.snapshot.context.quoteId, confirmationId: t2.value.snapshot.context.confirmationId }).toEqual({
      state: "USER_CONFIRMED",
      version: 3,
      quoteId: QUOTE,
      confirmationId: CHALLENGE,
    });
    // T3 to T6: cancellation and supersession leave the quote and the confirmation pointer exactly as they were.
    for (const from of [quoted, confirmed]) {
      const canceled = transition(from, { ...base, type: "SHOPPER_CANCELED", actor: "shopper" });
      expect(canceled.ok && { state: canceled.value.snapshot.state, version: canceled.value.snapshot.version, context: canceled.value.snapshot.context }, from.state).toEqual({
        state: "CANCELED_LOCAL",
        version: from.version + 1,
        context: from.context,
      });
      const superseded = transition(from, { ...base, type: "SUPERSEDED", actor: "server", byCheckoutIntentId: SUCCESSOR });
      expect(superseded.ok && { state: superseded.value.snapshot.state, version: superseded.value.snapshot.version, context: superseded.value.snapshot.context }, from.state).toEqual({
        state: "SUPERSEDED",
        version: from.version + 1,
        context: from.context,
      });
    }
  });

  it("ignores a pointer the event's type does not use, as checkout_transition does: the event is accepted and the pointer reaches nothing", () => {
    // The same cases as the database side (tests/db/checkout-functions.test.ts): an otherwise valid event that also
    // carries a quote, a confirmation or a successor its type has no use for. The reducer reads only the payload of
    // the event's own type, so the result is the one of the plain event.
    const strays = { quoteId: OTHER_QUOTE, confirmationId: "cf_00000000000000000000000000000009", byCheckoutIntentId: "ci_00000000000000000000000000000008" };
    const withStrays = (event: PaymentEvent): PaymentEvent => ({ ...strays, ...event }) as PaymentEvent;
    const outcome = (from: PaymentSnapshot, event: PaymentEvent) => {
      const result = transition(from, event);
      return result.ok ? { state: result.value.snapshot.state, version: result.value.snapshot.version, context: result.value.snapshot.context } : null;
    };
    const plainEvents: Array<[string, PaymentSnapshot, PaymentEvent]> = [
      ["T1", INITIAL_PAYMENT_SNAPSHOT, { ...base, type: "QUOTE_ISSUED", actor: "server", quoteId: QUOTE }],
      ["T2", quoted, { ...base, type: "SHOPPER_CONFIRMED", actor: "shopper", quoteId: QUOTE, confirmationId: CHALLENGE }],
      ["T3", quoted, { ...base, type: "SHOPPER_CANCELED", actor: "shopper" }],
      ["T4", confirmed, { ...base, type: "SHOPPER_CANCELED", actor: "shopper" }],
      ["T5", quoted, { ...base, type: "SUPERSEDED", actor: "server", byCheckoutIntentId: SUCCESSOR }],
      ["T6", confirmed, { ...base, type: "SUPERSEDED", actor: "server", byCheckoutIntentId: SUCCESSOR }],
    ];
    for (const [label, from, event] of plainEvents) {
      const plain = outcome(from, event);
      expect(plain, label).not.toBeNull();
      // The strays are spread first, so the event's own fields win where it has them.
      expect(outcome(from, withStrays(event)), label).toEqual(plain);
    }
    // Cancellation and supersession with strays: the quote and the confirmation pointer are still the ones held.
    expect(outcome(confirmed, withStrays({ ...base, type: "SHOPPER_CANCELED", actor: "shopper" }))?.context).toEqual(confirmed.context);
    expect(outcome(confirmed, withStrays({ ...base, type: "SUPERSEDED", actor: "server", byCheckoutIntentId: SUCCESSOR }))?.context).toEqual(confirmed.context);
  });

  it("refuses what checkout_transition refuses: the quote-match guard, the wrong actor, and a terminal state", () => {
    expect(transition(quoted, { ...base, type: "SHOPPER_CONFIRMED", actor: "shopper", quoteId: OTHER_QUOTE, confirmationId: CHALLENGE }).ok).toBe(false);
    expect(transition(quoted, { ...base, type: "SHOPPER_CONFIRMED", actor: "server", quoteId: QUOTE, confirmationId: CHALLENGE }).ok).toBe(false);
    expect(transition(confirmed, { ...base, type: "SHOPPER_CONFIRMED", actor: "shopper", quoteId: QUOTE, confirmationId: CHALLENGE }).ok).toBe(false);
    expect(transition(INITIAL_PAYMENT_SNAPSHOT, { ...base, type: "QUOTE_ISSUED", actor: "shopper", quoteId: QUOTE }).ok).toBe(false);
    expect(transition(quoted, { ...base, type: "SHOPPER_CANCELED", actor: "server" }).ok).toBe(false);
    expect(transition(quoted, { ...base, type: "SUPERSEDED", actor: "shopper", byCheckoutIntentId: SUCCESSOR }).ok).toBe(false);
    for (const terminal of [snapshot("CANCELED_LOCAL", 3, QUOTE, null), snapshot("SUPERSEDED", 3, QUOTE, null)]) {
      expect(transition(terminal, { ...base, type: "SHOPPER_CANCELED", actor: "shopper" }).ok, terminal.state).toBe(false);
      expect(transition(terminal, { ...base, type: "SUPERSEDED", actor: "server", byCheckoutIntentId: SUCCESSOR }).ok, terminal.state).toBe(false);
    }
  });

  it("accepts the listed combinations that Increment 2.1 excludes, so the exclusions are real and are exactly these", () => {
    // Specification 19.12. Each of these is accepted by the reducer and refused by checkout_transition.
    expect(transition(quoted, { ...base, type: "QUOTE_ISSUED", actor: "server", quoteId: OTHER_QUOTE }).ok, "an in-place re-quote").toBe(true);
    expect(transition(quoted, { ...base, type: "QUOTE_INVALIDATED", actor: "server" }).ok, "QUOTE_INVALIDATED").toBe(true);
    expect(transition(INITIAL_PAYMENT_SNAPSHOT, { ...base, type: "SHOPPER_CANCELED", actor: "shopper" }).ok, "cancel from DRAFT").toBe(true);
    expect(transition(INITIAL_PAYMENT_SNAPSHOT, { ...base, type: "SUPERSEDED", actor: "server", byCheckoutIntentId: SUCCESSOR }).ok, "supersession from DRAFT").toBe(true);
    for (const from of [INITIAL_PAYMENT_SNAPSHOT, quoted, confirmed]) expect(transition(from, { ...base, type: "EXPIRED", actor: "timer" }).ok, `EXPIRED from ${from.state}`).toBe(true);
  });
});

describe("the PostgreSQL library is isolated: SQL only in the catalogue, no environment access, imported by the PostgreSQL server modules alone", () => {
  const sources = filesUnder(PG_SOURCE_DIR, /\.ts$/);
  const CATALOGUE = join(PG_SOURCE_DIR, "statements.ts");
  // The same rule as SQL-01: any letter case; keywords may be on different lines, within one source statement.
  const SQL_TEXT = /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;]*?\b(?:FROM|SET|VALUES)\b/i;

  it("consists of exactly the eleven approved modules", () => {
    // The eight of Increments 1 to 2.2, and the three of Increment 2.3: catalog, checkout-service and readiness.
    expect(sources.map((file) => file.slice(PG_SOURCE_DIR.length + 1)).sort()).toEqual([
      "catalog.ts",
      "checkout-service.ts",
      "client.ts",
      "confirmation-nonce.ts",
      "key-ring.ts",
      "migrate.ts",
      "readiness.ts",
      "saqd.ts",
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

  it("is imported by exactly the four server modules of PostgreSQL mode, each importing only what it is allowed (Increment 2.3)", () => {
    // Which library modules each server module may import. Nothing else in the application imports the library:
    // no page, no component, no route, and none of the mock's modules.
    const ALLOWED: Record<string, readonly string[]> = {
      [join("src", "server", "pg-runtime.ts")]: ["catalog", "checkout-service", "client", "key-ring", "readiness", "session-service"],
      [join("src", "server", "pg-request-guard.ts")]: ["session-cookie", "session-service"],
      [join("src", "server", "pg-handlers.ts")]: ["checkout-service", "confirmation-nonce", "session-cookie"],
      [join("src", "server", "pg-views.ts")]: ["checkout-service"],
    };
    const imported: Record<string, string[]> = {};
    for (const file of filesUnder(join(ROOT, "src"), /\.(ts|tsx)$/)) {
      if (file.startsWith(PG_SOURCE_DIR)) continue;
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/["'][./]+\/pg\//);
      const modules = [...text.matchAll(/from "@\/lib\/pg\/([a-z-]+)"/g)].map((match) => match[1]);
      expect(text.match(/@\/lib\/pg\//g)?.length ?? 0, file).toBe(modules.length);
      if (modules.length > 0) imported[file.slice(ROOT.length + 1)] = [...new Set(modules)].sort();
    }
    expect(imported).toEqual(ALLOWED);
    // The migration runner, the statement catalogue itself and the digest encoder are imported by no server module:
    // statements reach the application only through the library's services.
    for (const modules of Object.values(imported)) for (const name of ["migrate", "statements", "saqd"]) expect(modules).not.toContain(name);
    // Only the runtime module takes a pool, and only it builds the services.
    const runtimeModule = readFileSync(join(ROOT, "src", "server", "pg-runtime.ts"), "utf8");
    expect(runtimeModule).toMatch(/import \{ createPgPool, queryableFromPool, type PgQueryable \} from "@\/lib\/pg\/client";/);
    // Assemble the pattern so this test source is not itself mistaken for a driver import by pg-harness.test.ts.
    const driverImport = new RegExp(["from\\s+(['\\\"])", "pg", "\\1"].join(""));
    const doubleQuotedImport = ["import { Pool } from ", '"', "pg", '";'].join("");
    const singleQuotedImport = ["import { Pool } from ", "'", "pg", "';"].join("");
    expect(driverImport.test(doubleQuotedImport)).toBe(true);
    expect(driverImport.test(singleQuotedImport)).toBe(true);
    expect(runtimeModule).not.toMatch(/withPinnedConnection|connectionSourceFromPool|runWithReruns/);
    expect(runtimeModule).not.toMatch(driverImport);

    // And the Mock runtime still builds on the in-memory stores only: `createRuntime` is as it was, and the module
    // reaches PostgreSQL mode through `./pg-runtime` alone.
    const runtime = readFileSync(join(ROOT, "src", "server", "runtime.ts"), "utf8");
    expect(runtime).toMatch(/new InMemorySessionStore\(\)/);
    expect(runtime).not.toMatch(/@\/lib\/pg|Pool|shopaccess_api/);
    const createRuntime = runtime.slice(runtime.indexOf("export function createRuntime"), runtime.indexOf(" * What this process serves."));
    expect(createRuntime.length).toBeGreaterThan(1000);
    expect(createRuntime).not.toMatch(/\bpg\b|postgres/i);
  });

  it("the three library modules of Increment 2.3 send catalogue statements only, each from its own group", () => {
    const text = (name: string): string => readFileSync(join(PG_SOURCE_DIR, name), "utf8");
    // The checkout service: the six checkout calls, and nothing of another group.
    expect([...text("checkout-service.ts").matchAll(/statements\.([A-Za-z]+)/g)].map((match) => match[1]).sort()).toEqual(Object.keys(CHECKOUT_STATEMENTS).sort());
    expect(text("checkout-service.ts")).toMatch(/const statements = CHECKOUT_STATEMENTS;/);
    expect(text("checkout-service.ts")).not.toMatch(/SESSION_STATEMENTS|OPERATOR_STATEMENTS|MIGRATION_STATEMENTS|APPLICATION_STATEMENTS/);
    // The catalog reader and the readiness probe: one application statement each.
    expect([...text("catalog.ts").matchAll(/[A-Z_]+_STATEMENTS\.[A-Za-z]+/g)].map((match) => match[0])).toEqual(["APPLICATION_STATEMENTS.readCatalog"]);
    expect([...text("readiness.ts").matchAll(/[A-Z_]+_STATEMENTS\.[A-Za-z]+/g)].map((match) => match[0])).toEqual(["APPLICATION_STATEMENTS.readinessProbe"]);
    for (const name of ["catalog.ts", "checkout-service.ts", "readiness.ts"]) {
      // Every query is sent with a catalogue entry as its text: never a literal, a template or a variable built here.
      for (const call of text(name).matchAll(/\.query\(([^,)]+)/g)) expect(call[1].trim(), `${name}: ${call[0]}`).toMatch(/^(?:statements|APPLICATION_STATEMENTS)\.[A-Za-z]+$/);
      expect(text(name), name).not.toMatch(/OPERATOR_STATEMENTS|MIGRATION_STATEMENTS|from "\.\/migrate"/);
    }
  });
});

describe("statement catalogue: immutable, parameterized, schema-qualified, and the only definition", () => {
  const source = readFileSync(join(PG_SOURCE_DIR, "statements.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const groups = { SESSION_STATEMENTS, OPERATOR_STATEMENTS, MIGRATION_STATEMENTS, CHECKOUT_STATEMENTS, APPLICATION_STATEMENTS };
  const all: Record<string, string> = { ...SESSION_STATEMENTS, ...OPERATOR_STATEMENTS, ...MIGRATION_STATEMENTS, ...CHECKOUT_STATEMENTS, ...APPLICATION_STATEMENTS };
  // The readiness probe (Increment 2.3) reads the system catalogs about the connected role. It is the one statement
  // that may name a relation outside the two application schemas, and exactly these three: the role catalog, the
  // membership catalog, and the function that turns a bound array into rows.
  const PROBE_SOURCES = ["pg_catalog.pg_auth_members", "pg_catalog.pg_roles", "pg_catalog.unnest"];

  it("exports exactly five frozen groups and nothing that could build a statement", () => {
    expect(Object.keys(statementCatalogue).sort()).toEqual(["APPLICATION_STATEMENTS", "CHECKOUT_STATEMENTS", "MIGRATION_STATEMENTS", "OPERATOR_STATEMENTS", "SESSION_STATEMENTS"]);
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
      startCheckout: 6,
      cancelCheckout: 3,
      readCheckout: 3,
      listOwnerCheckouts: 2,
      issueChallenge: 6,
      consumeChallenge: 6,
      readCatalog: 0,
      readinessProbe: 13,
    };
    expect(Object.keys(all).sort()).toEqual(Object.keys(arity).sort());
    const thirteen = Array.from({ length: 13 }, (_unused, index) => `$${index + 1}`).join(" ");
    expect(placeholderIndexes(thirteen)).toEqual(Array.from({ length: 13 }, (_unused, index) => index + 1));
    expect(matchesPlaceholderArity(thirteen, 13)).toBe(true);
    expect(matchesPlaceholderArity("$1 $3", 3)).toBe(false); // Missing $2 remains a gap, not a lexical sort issue.
    expect(placeholderIndexes("$1 $1 $2")).toEqual([1, 2]); // Reuse is unique and does not manufacture arity.
    expect(matchesPlaceholderArity("$1 $1 $2", 2)).toBe(true);
    expect(matchesPlaceholderArity("$1 $1 $2", 3)).toBe(false);
    for (const [name, text] of Object.entries(all)) {
      expect(matchesPlaceholderArity(text, arity[name]), name).toBe(true);
      // No quoted value other than the one fixed regclass name, and no statement separator or comment.
      expect(text.replace("'shopaccess.schema_migrations'", ""), name).not.toMatch(/['";]|--|\/\*/);
    }
  });

  it("qualifies every object with its schema and calls each entry point exactly once", () => {
    for (const [name, text] of Object.entries(all)) {
      if (["begin", "commit", "rollback"].includes(name)) continue;
      for (const reference of text.matchAll(/\b(?:FROM|INTO)\s+([a-z_.]+)/g)) {
        if (name === "readinessProbe") expect(PROBE_SOURCES, name).toContain(reference[1]);
        else expect(reference[1], name).toMatch(/^(?:shopaccess|shopaccess_api)\.[a-z_]+$/);
      }
      for (const reference of text.matchAll(/\bJOIN\s+([a-z_.]+)/g)) {
        if (name === "readinessProbe") expect(PROBE_SOURCES, name).toContain(reference[1]);
        else expect(reference[1], name).toMatch(/^(?:shopaccess|shopaccess_api)\.[a-z_]+$/);
      }
      for (const call of text.matchAll(/(?<![a-z_.])([a-z_]+)\(/g)) {
        expect(["count"].includes(call[1]) || text.includes(`pg_catalog.${call[1]}(`) || text.includes(`shopaccess_api.${call[1]}(`), `${name}: ${call[1]}`).toBe(true);
      }
    }
    expect({ ...MIGRATION_STATEMENTS }).toMatchObject({ begin: "BEGIN", commit: "COMMIT", rollback: "ROLLBACK" });

    // The two application statements of Increment 2.3. Each is one read-only SELECT.
    expect(Object.keys(APPLICATION_STATEMENTS).sort()).toEqual(["readCatalog", "readinessProbe"]);
    for (const [name, text] of Object.entries(APPLICATION_STATEMENTS)) {
      expect(text, name).toMatch(/^SELECT /);
      expect(text, name).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|CREATE|ALTER|DROP|SET|CALL|DO|COPY|LOCK)\b|\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY|KEY)\b/);
      expect(text, name).not.toMatch(/shopaccess_api\./);
    }
    // The catalog: exactly the three catalog tables, joined on their keys, in a fixed order, with the columns the
    // tables of migration 0003 define.
    const catalogRead = APPLICATION_STATEMENTS.readCatalog;
    expect([...catalogRead.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/g)].map((match) => match[1])).toEqual(["shopaccess.merchant_variants", "shopaccess.merchant_products", "shopaccess.merchants"]);
    expect(catalogRead).toMatch(/ ON p\.id = v\.product_id JOIN shopaccess\.merchants m ON m\.id = p\.merchant_id ORDER BY p\.id, v\.id$/);
    const catalogTables = sqlOf("0003").replace(/--[^\n]*/g, "");
    const columnsOf = (table: string): string[] => {
      const body = new RegExp(`CREATE TABLE shopaccess\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(catalogTables)?.[1] ?? "";
      return [...body.matchAll(/^\s{2}([a-z_]+)\s+(?:text|integer|boolean|jsonb)\b/gm)].map((match) => match[1]);
    };
    for (const [alias, table] of [["m", "merchants"], ["p", "merchant_products"], ["v", "merchant_variants"]] as const) {
      const defined = columnsOf(table);
      expect(defined.length, table).toBeGreaterThan(2);
      const selected = [...catalogRead.slice(0, catalogRead.indexOf(" FROM ")).matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, "g"))].map((match) => match[1]);
      for (const column of selected) expect(defined, `${table}.${column}`).toContain(column);
    }
    // The probe: no object is named in its text and no literal is written into it; it reads the system catalogs
    // and privilege functions for the connected role only.
    const probe = APPLICATION_STATEMENTS.readinessProbe;
    expect(probe).not.toMatch(/shopaccess|'/);
    expect([...probe.matchAll(/\b(?:FROM|JOIN)\s+([a-z_.]+)/g)].map((match) => match[1]).filter((source, index, list) => list.indexOf(source) === index).sort()).toEqual(PROBE_SOURCES);
    expect(probe.match(/\bsession_user\b/g)?.length).toBeGreaterThan(10);
    for (const call of probe.matchAll(/pg_catalog\.(has_[a-z_]+_privilege)\(([a-z_]+),/g)) expect(call[2], call[1]).toBe("session_user");
    expect([...new Set([...probe.matchAll(/pg_catalog\.([a-z_]+)\(/g)].map((match) => match[1]))].sort()).toEqual([
      "current_database",
      "has_any_column_privilege",
      "has_database_privilege",
      "has_function_privilege",
      "has_schema_privilege",
      "has_table_privilege",
      "to_regclass",
      "to_regprocedure",
      "unnest",
    ]);
    // One row, fourteen named columns.
    expect([...probe.matchAll(/ AS ([a-z_]+)(?=,| \(|$)/g)].map((match) => match[1]).filter((alias) => alias !== "item")).toEqual([
      "session_user_name",
      "current_user_name",
      "plain_role_rows",
      "membership_rows",
      "required_functions_executable",
      "prohibited_functions_present",
      "prohibited_functions_executable",
      "readable_tables_readable",
      "readable_tables_writable",
      "prohibited_tables_present",
      "prohibited_tables_reachable",
      "schemas_usable",
      "schemas_creatable",
      "database_elevated",
    ]);
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
    // The same for the six checkout calls, against migrations 0009 and 0008: each is one call of one entry point,
    // with the credential first, and selects exactly the columns the function returns, in its order. Migration 0009
    // is read first: its read_checkout is the one that exists once both are applied.
    const checkoutFunctions = `${sqlOf("0009")}\n${sqlOf("0008")}`.replace(/--[^\n]*/g, "");
    const checkoutEntryPoints: string[] = [];
    for (const [name, text] of Object.entries(CHECKOUT_STATEMENTS)) {
      const call = /^SELECT (.+) FROM shopaccess_api\.([a-z_]+)\((\$\d+(?:, \$\d+)*)\)$/.exec(text);
      expect(call, name).not.toBeNull();
      if (!call) continue;
      checkoutEntryPoints.push(call[2]);
      const definition = new RegExp(`CREATE FUNCTION shopaccess_api\\.${call[2]}\\(([^)]*)\\) RETURNS TABLE \\(([^)]*)\\)`).exec(checkoutFunctions);
      expect(definition?.[2].split(",").map((column) => column.trim().split(" ")[0]), call[2]).toEqual(call[1].split(", "));
      // One placeholder per parameter, in order.
      const parameters = definition?.[1].split(",").map((parameter) => parameter.trim()) ?? [];
      expect(call[3].split(", "), call[2]).toEqual(parameters.map((_unused, index) => `$${index + 1}`));
      expect(parameters.slice(0, 2), call[2]).toEqual(["p_key_version smallint", "p_token_digest text"]);
    }
    expect(checkoutEntryPoints.sort()).toEqual(["cancel_checkout", "consume_challenge", "issue_challenge", "list_owner_checkouts", "read_checkout", "start_checkout"]);
    // 41 columns from read_checkout (the 33 of Increment 2.1 and the eight challenge columns of 2.2) and 6 from
    // list_owner_checkouts (specification 19.11).
    expect(CHECKOUT_STATEMENTS.readCheckout.slice("SELECT ".length, CHECKOUT_STATEMENTS.readCheckout.indexOf(" FROM ")).split(", ")).toHaveLength(41);
    expect(CHECKOUT_STATEMENTS.listOwnerCheckouts.slice("SELECT ".length, CHECKOUT_STATEMENTS.listOwnerCheckouts.indexOf(" FROM ")).split(", ")).toHaveLength(6);
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
