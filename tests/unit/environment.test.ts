import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  appendAuditEvent,
  claimOperationForDispatch,
  findIntentRowForSession,
  findQuoteRowForSession,
  PgSessionStore,
  SQL,
  type Queryable,
} from "@/lib/db/queries";
import { parsePaymentAdapterConfig, requireMockOnly, SANDBOX_API_BASE_URL } from "@/lib/payment/adapter-config";
import { parseRuntimeConfig } from "@/server/config";
import { parsePgRuntimeConfig } from "@/server/pg-runtime";
import { InMemoryAuditLog, REDACTED, sanitizeAuditEvent } from "@/lib/security/audit";
import { PUBLIC_ERROR_CODES, publicErrorFromUnknown, toPublicError } from "@/lib/security/errors";
import { createFixedWindowRateLimiter, InMemoryRateLimitStore, PROPOSED_RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";
import { generateSessionToken } from "@/lib/session/token";
import { PAYMENT_STATES } from "@/lib/payment/state-machine";
import { FOCUS_ON_ARRIVAL_SHA256 } from "./sec01-pins";
import { createTestClock, MINUTE } from "./helpers";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "db", "migrations", "archive", "milestone-001-unexecuted");

function filesUnder(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

/**
 * SEC-01 client-code exception for FocusOnArrival.tsx (M2-3, owner decision October 17; tightened after review finding 1
 * and the second review's finding 1). Two layers:
 * - the file's bytes must match the approved SHA-256 in sec01-pins.ts, so any change at all needs a reviewed update;
 * - its vocabulary is limited to the directive, one import of React's useEffect, getElementById and focus. Any other
 *   identifier or string (a second import, require, import(), a re-export, network, storage, cookie, location or HTML
 *   APIs, JSX) is a violation. Comments and strings are read in one left-to-right pass, so "//" inside a string cannot
 *   hide the rest of a line. Code with no identifiers or strings at all is caught only by the pin.
 */
const FOCUS_ON_ARRIVAL_IDENTIFIERS = new Set([
  "Document", "FocusOnArrival", "Pick", "boolean", "const", "doc", "document", "export", "false", "focus", "focusArrivalTarget",
  "from", "function", "getElementById", "if", "import", "null", "readonly", "return", "string", "target", "targetId", "true", "useEffect",
]);
const FOCUS_ON_ARRIVAL_STRINGS = new Set(["use client", "react", "getElementById"]);

export function focusOnArrivalViolations(source: string): string[] {
  const violations: string[] = [];
  // One pass: whichever of a comment or a string starts first wins, as in the language itself.
  const strings: string[] = [];
  const bare = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (token) => {
    if (token[0] === "/") return " ";
    strings.push(token);
    return " ";
  });
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (_match: string, literal?: string) => literal ?? " ");
  if (!/^"use client";\s*import \{ useEffect \} from "react";\s/.test(code)) violations.push("must start with the directive and its one React import");
  for (const literal of strings) {
    if (literal[0] !== '"' || !FOCUS_ON_ARRIVAL_STRINGS.has(literal.slice(1, -1))) violations.push(`string ${literal}`);
  }
  for (const identifier of new Set(bare.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    if (!FOCUS_ON_ARRIVAL_IDENTIFIERS.has(identifier)) violations.push(`identifier ${identifier}`);
  }
  if ((bare.match(/\bimport\b/g) ?? []).length !== 1) violations.push("exactly one import");
  if ((bare.match(/\bfrom\b/g) ?? []).length !== 1) violations.push("no re-export");
  return violations;
}

/** The approved-contents check for an excepted client module: null when its bytes match the reviewed pin. */
export function pinViolation(bytes: Buffer | string, expectedSha256: string): string | null {
  const actual = createHash("sha256").update(bytes).digest("hex");
  return actual === expectedSha256 ? null : `contents differ from the reviewed pin (sha256 ${actual})`;
}

const SCRIPT_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** True when the file's directive prologue (after comments and any other directives) contains "use client". */
function declaresClient(text: string): boolean {
  if (/^\s*["']use client["']/m.test(text)) return true;
  let rest = text;
  for (;;) {
    rest = rest.replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)+/, "");
    const directive = rest.match(/^(["'])([^"'\n]*)\1\s*;?/);
    if (!directive) return false;
    if (directive[2] === "use client") return true;
    rest = rest.slice(directive[0].length);
  }
}

/** Every source file (any script extension, anywhere under src) that declares itself client code. */
export function clientDirectiveFiles(files: readonly { readonly path: string; readonly text: string }[]): string[] {
  return files.filter((file) => SCRIPT_FILE.test(file.path) && declaresClient(file.text)).map((file) => file.path);
}

type Source = { readonly path: string; readonly text: string };

/** Every source file SEC-01 inspects under `dir`: all supported script extensions (Codex review finding 1). */
export function collectSec01Sources(dir: string): Source[] {
  return filesUnder(dir, SCRIPT_FILE).map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.(?:ts|mts|cts)$/.test(path)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * The module references in one file, read with the TypeScript parser (an existing dependency): import and export
 * declarations, `import x = require()`, `import()` types, and `import()` and `require()` calls. A call whose specifier is
 * not a literal string (a variable, a concatenation, a template with substitutions) cannot be resolved by reading the
 * source, so it is reported as computed and the policy refuses it (Codex review finding 2). This is a source policy: it
 * does not depend on whether a bundler would include the module.
 */
function moduleReferences(source: Source): { readonly literals: string[]; readonly computed: string[] } {
  const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, scriptKind(source.path));
  const literals: string[] = [];
  const computed: string[] = [];
  const literalText = (node: ts.Node | undefined) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const text = literalText(node.moduleSpecifier);
      if (text !== null) literals.push(text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const text = literalText(node.moduleReference.expression);
      if (text !== null) literals.push(text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const text = literalText(node.argument.literal);
      if (text !== null) literals.push(text);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || requireCall) {
        const text = literalText(node.arguments[0]);
        if (text !== null) literals.push(text);
        else computed.push(`${source.path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${dynamicImport ? "import()" : "require()"}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { literals, computed };
}

/**
 * Resolves a literal specifier to a collected source file, as the project resolves it: `@/` is `src/` (tsconfig paths;
 * there is no baseUrl, so any other bare specifier is a package), relative paths from the importer, with an explicit
 * supported suffix or none. Directory index files are not resolved: both policy targets are fixed files, never an index,
 * so a barrel or alias path can reach them only through a file that imports them directly, and that file is reported.
 */
function resolveModule(specifier: string, importer: string, root: string, known: ReadonlySet<string>): string | null {
  const base = specifier.slice(0, 2) === "@/" ? join(root, "src", specifier.slice(2)) : specifier[0] === "." ? join(dirname(importer), specifier) : null;
  if (base === null) return null;
  const stem = base.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
  const candidates = [base, ...SCRIPT_EXTENSIONS.map((extension) => stem + extension)];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/** The SEC-01 client-module and import policy over collected sources (`root` is the repository root they live under). */
export function sec01Report(sources: readonly Source[], root: string) {
  const known = new Set(sources.map((source) => source.path));
  const references = sources.map((source) => ({ path: source.path, ...moduleReferences(source) }));
  const importersOfFile = (target: string) =>
    references.filter((entry) => entry.literals.some((specifier) => resolveModule(specifier, entry.path, root, known) === target)).map((entry) => entry.path).sort();
  return {
    clientModules: clientDirectiveFiles(sources).sort(),
    focusOnArrivalImporters: importersOfFile(join(root, "src", "components", "FocusOnArrival.tsx")),
    purchasePermissionsImporters: importersOfFile(join(root, "src", "components", "PurchasePermissions.tsx")),
    computedSpecifiers: references.flatMap((entry) => entry.computed).sort(),
  };
}

const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
const migrationSql = migrationFiles.map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8")).join("\n");

describe("ENV-01: live or mixed payment configuration is rejected (future adapter configuration)", () => {
  const sandbox = {
    PAYMENT_PROVIDER_MODE: "sandbox",
    PAYPAL_CLIENT_ID: "placeholder-client-id",
    PAYPAL_CLIENT_SECRET: "placeholder-client-secret",
    PAYPAL_API_BASE_URL: SANDBOX_API_BASE_URL,
    PAYPAL_SANDBOX_MERCHANT_ID: "2ABCDEFGHJKLM",
  };

  it("accepts mock mode only when no provider settings are present", () => {
    expect(parsePaymentAdapterConfig({ PAYMENT_PROVIDER_MODE: "mock" })).toEqual({ ok: true, value: { mode: "mock" } });
    expect(parsePaymentAdapterConfig({})).toEqual({ ok: false, error: "MODE_MISSING" });
    for (const key of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_API_BASE_URL", "PAYPAL_WEBHOOK_ID", "PAYPAL_SANDBOX_MERCHANT_ID"]) {
      expect(parsePaymentAdapterConfig({ PAYMENT_PROVIDER_MODE: "mock", [key]: "anything" }), key).toEqual({
        ok: false,
        error: "MOCK_MODE_WITH_PROVIDER_SETTINGS",
      });
    }
  });

  it("rejects live mode and any sandbox configuration pointing at a non-sandbox host", () => {
    for (const mode of ["live", "production"]) {
      expect(parsePaymentAdapterConfig({ ...sandbox, PAYMENT_PROVIDER_MODE: mode })).toEqual({ ok: false, error: "LIVE_MODE_FORBIDDEN" });
    }
    for (const mode of ["LIVE", "Sandbox", "test", "paypal"]) {
      expect(parsePaymentAdapterConfig({ ...sandbox, PAYMENT_PROVIDER_MODE: mode }), mode).toEqual({ ok: false, error: "MODE_UNSUPPORTED" });
    }
    for (const url of [
      "https://api-m.paypal.com",
      "https://api.paypal.com",
      "https://api-m.sandbox.paypal.com.evil.example",
      "https://api-m.sandbox.paypal.com/",
      "http://api-m.sandbox.paypal.com",
      undefined,
    ]) {
      expect(parsePaymentAdapterConfig({ ...sandbox, PAYPAL_API_BASE_URL: url }), String(url)).toEqual({ ok: false, error: "SANDBOX_BASE_URL_NOT_SANDBOX" });
    }
    expect(parsePaymentAdapterConfig({ ...sandbox, PAYPAL_CLIENT_SECRET: undefined })).toEqual({ ok: false, error: "SANDBOX_CREDENTIALS_INCOMPLETE" });
  });

  it("attaches a complete sandbox configuration on the in-memory runtime and still refuses it for PostgreSQL", () => {
    const parsed = parsePaymentAdapterConfig(sandbox);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ mode: "sandbox", apiBaseUrl: SANDBOX_API_BASE_URL, merchantId: "2ABCDEFGHJKLM" });
    // The adapter parse result never carries credentials onward.
    expect(JSON.stringify(parsed.value)).not.toContain("placeholder");
    expect(requireMockOnly(parsed.value)).toEqual({ ok: false, error: "PROVIDER_NOT_AUTHORIZED_FOR_MILESTONE" });
    expect(requireMockOnly({ mode: "mock" })).toEqual({ ok: true, value: { mode: "mock" } });
    expect(parsePaymentAdapterConfig({ ...sandbox, PAYPAL_SANDBOX_MERCHANT_ID: undefined })).toEqual({ ok: false, error: "SANDBOX_MERCHANT_ID_INVALID" });
    expect(parsePaymentAdapterConfig({ ...sandbox, PAYPAL_SANDBOX_MERCHANT_ID: "not-a-merchant" })).toEqual({ ok: false, error: "SANDBOX_MERCHANT_ID_INVALID" });

    const runtime = parseRuntimeConfig({
      SHOPACCESS_SESSION_KEY: Buffer.alloc(32, 9).toString("base64"),
      SHOPACCESS_TRUSTED_ORIGINS: "https://shop.example.test",
      NODE_ENV: "production",
      ...sandbox,
    });
    expect(runtime.ok).toBe(true);
    if (!runtime.ok || runtime.value.payment?.mode !== "sandbox") throw new Error("sandbox runtime config was not accepted");
    expect(runtime.value.payment.apiBaseUrl).toBe(SANDBOX_API_BASE_URL);
    expect(runtime.value.payment.merchantId).toBe("2ABCDEFGHJKLM");
    expect(runtime.value.payment.clientId).toBe(sandbox.PAYPAL_CLIENT_ID);
    expect(runtime.value.payment.clientSecret).toBe(sandbox.PAYPAL_CLIENT_SECRET);
    expect(Object.keys(runtime.value).sort()).toEqual(["advisory", "payment", "sessionKey", "trustedOrigins"]);
    expect(JSON.stringify({ ok: false, error: ["PAYMENT_MODE_NOT_MOCK"] })).not.toContain("placeholder");
    const mockRuntime = parseRuntimeConfig({
      SHOPACCESS_SESSION_KEY: Buffer.alloc(32, 9).toString("base64"),
      SHOPACCESS_TRUSTED_ORIGINS: "https://shop.example.test",
      NODE_ENV: "production",
      PAYMENT_PROVIDER_MODE: "mock",
    });
    expect(mockRuntime.ok && Object.keys(mockRuntime.value).sort()).toEqual(["advisory", "sessionKey", "trustedOrigins"]);

    const postgres = parsePgRuntimeConfig({
      SHOPACCESS_SESSION_KEY: Buffer.alloc(32, 9).toString("base64"),
      SHOPACCESS_TRUSTED_ORIGINS: "https://shop.example.test",
      NODE_ENV: "production",
      ...sandbox,
    });
    expect(postgres.ok).toBe(false);
    if (!postgres.ok) expect(postgres.error).toContain("PAYMENT_MODE_NOT_MOCK");
    expect(JSON.stringify(postgres)).not.toContain("placeholder");
  });
});

/**
 * SQL text: a statement keyword followed by FROM, SET or VALUES, with any
 * characters between them, line breaks included, up to the next semicolon. A
 * semicolon ends a statement of the source code, so the two words must sit in
 * one expression: a string, a template literal, or strings joined together.
 * Case is ignored: upper-case, lower-case and mixed-case SQL all match, and the
 * two words of INSERT INTO and DELETE FROM may be separated by any white space.
 * The rule is deliberately broad. If ordinary code or a comment ever matches,
 * the answer is to reword that code, never to narrow the rule or add a file.
 */
const SQL_TEXT = /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;]*?\b(?:FROM|SET|VALUES)\b/i;
const containsSqlText = (source: string): boolean => SQL_TEXT.test(source);

/** The only two modules under `src` that may contain SQL text. Exact files: no directory is exempt. */
const SQL_MODULES: readonly string[] = [join(ROOT, "src", "lib", "db", "queries.ts"), join(ROOT, "src", "lib", "pg", "statements.ts")];
const violatesSqlRule = (file: string, source: string): boolean => !SQL_MODULES.includes(file) && containsSqlText(source);

describe("SQL-01: SQL injection is rejected through parameterized queries", () => {
  const INJECTIONS = ["' OR '1'='1", "x'; DROP TABLE shopper_sessions; --", "1; SELECT pg_sleep(10)", "\\'; --", "\"); DELETE FROM quotes; --", "'||(SELECT token_digest FROM shopper_sessions)||'"];

  function recordingDb() {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const db: Queryable = {
      async query<Row>(text: string, values: readonly unknown[]) {
        calls.push({ text, values });
        return { rows: [] as Row[], rowCount: 0 };
      },
    };
    return { db, calls };
  }

  it("sends hostile input only as bound values; statement text is always a known constant", async () => {
    const statements = new Set<string>(Object.values(SQL));
    for (const payload of INJECTIONS) {
      const { db, calls } = recordingDb();
      const sessions = new PgSessionStore(db);
      const now = new Date("2026-10-08T12:00:00.000Z");
      await sessions.findByTokenDigest(payload);
      await sessions.insertWithinCapacity({ id: payload, tokenDigest: payload, createdAt: now, lastSeenAt: now, absoluteExpiresAt: now, revokedAt: null }, 500);
      await sessions.touch(payload, now);
      await sessions.replaceTokenDigest(payload, payload, payload, now);
      await sessions.revoke(payload, now);
      await findQuoteRowForSession(db, payload, payload);
      await findIntentRowForSession(db, payload, payload);
      await claimOperationForDispatch(db, payload, payload, now, 1000);
      await appendAuditEvent(db, {
        eventId: payload,
        eventType: payload,
        occurredAt: now.toISOString(),
        actor: payload,
        sessionId: payload,
        checkoutIntentId: payload,
        operationId: payload,
        detail: { note: payload },
      });

      expect(calls).toHaveLength(9);
      for (const call of calls) {
        expect(statements.has(call.text)).toBe(true);
        expect(call.text).not.toContain(payload);
        expect(call.values.some((value) => typeof value === "string" && value.includes(payload))).toBe(true);
        // Every placeholder is supplied and nothing extra is sent.
        const placeholders = new Set(call.text.match(/\$\d+/g));
        expect(placeholders.size).toBe(call.values.length);
      }
    }
  });

  it("contains no string-built SQL: statements use only numbered placeholders", () => {
    for (const [name, text] of Object.entries(SQL)) {
      expect(text, name).toMatch(/\$1/);
      expect(text, name).not.toMatch(/\$\{|'\s*\+|\+\s*'/);
    }
    const source = readFileSync(join(ROOT, "src", "lib", "db", "queries.ts"), "utf8");
    expect(source).not.toMatch(/\$\{/);
    // No other module issues SQL. Exactly two files may: see SQL_MODULES.
    for (const file of filesUnder(join(ROOT, "src"), /\.(ts|tsx)$/)) {
      expect(violatesSqlRule(file, readFileSync(file, "utf8")), file).toBe(false);
    }
    // Both allowed files exist and do contain SQL; nothing else under src does.
    expect(filesUnder(join(ROOT, "src"), /\.(ts|tsx)$/).filter((file) => containsSqlText(readFileSync(file, "utf8"))).sort()).toEqual([...SQL_MODULES].sort());
  });

  it("detects SQL that is spread over several lines, outside the two allowed files", () => {
    const elsewhere = join(ROOT, "src", "lib", "pg", "session-service.ts");
    const multiline = [
      "const q = `\n  SELECT id,\n         token_digest\n    FROM shopper_sessions\n   WHERE id = $1`;",
      'const q = "SELECT id, token_digest " +\n  "FROM shopper_sessions WHERE id = $1";',
      'const q = ["UPDATE shopper_sessions",\n  "SET revoked_at = $2",\n  "WHERE id = $1"].join(" ");',
      "const q = `INSERT INTO audit_events (event_id)\n\n\n  VALUES ($1)`;",
      "const q = `DELETE FROM carts\n  WHERE id IN (\n    SELECT\n      cart_id\n    FROM stale_carts)`;",
      "db.query(\n  'SELECT *'\n  // a comment between the parts\n  + ' FROM quotes',\n);",
      "const q = `SELECT 1\r\nFROM t`;",
    ];
    for (const source of multiline) {
      // None of these has the two keywords on one line: the single-line rule this replaces missed every one.
      expect(/\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^\n]*\b(?:FROM|SET|VALUES)\b/.test(source), source).toBe(false);
      expect(containsSqlText(source), source).toBe(true);
      expect(violatesSqlRule(elsewhere, source), source).toBe(true);
    }
    // Single-line SQL is still caught.
    expect(violatesSqlRule(elsewhere, 'const q = "SELECT id FROM quotes WHERE id = $1";')).toBe(true);
    // Ordinary code is not: the keywords must belong to one statement of the source.
    for (const source of [
      "// FOR UPDATE takes a row lock;\nconst rows = result.rows; // values come FROM the caller",
      'const label = "SELECT a plan";\nconst other = "copied FROM the cart";',
      "type Mode = 'INSERT' | 'UPDATE';\nconst from = values;",
      'import { useState } from "react";\nconst selected = items.filter(Boolean);\nconst updated = true;',
      "const selection = pick(options);\nreturn { values: selection, set: new Set(selection) };",
    ]) {
      expect(containsSqlText(source), source).toBe(false);
    }
  });

  it("detects SQL in any letter case: lower, upper and mixed, on one line or several, in strings and template literals", () => {
    const unauthorized = [
      join(ROOT, "src", "lib", "pg", "session-service.ts"),
      join(ROOT, "src", "lib", "pg", "client.ts"),
      join(ROOT, "src", "server", "handlers.ts"),
      join(ROOT, "src", "app", "page.tsx"),
    ];
    const cases: Array<[string, string]> = [
      ["lower case, one line", 'const q = "select id from quotes where id = $1";'],
      ["upper case, one line", 'const q = "SELECT id FROM quotes WHERE id = $1";'],
      ["mixed case, one line", 'const q = "Select id From quotes Where id = $1";'],
      ["alternating case", 'const q = "sElEcT id fRoM quotes";'],
      ["lower-case keyword, upper-case clause", 'const q = "select id FROM quotes";'],
      ["upper-case keyword, lower-case clause", 'const q = "SELECT id from quotes";'],
      ["lower-case insert", 'const q = "insert into audit_events (event_id) values ($1)";'],
      ["mixed-case insert with extra spacing", 'const q = "Insert   Into audit_events (event_id) Values ($1)";'],
      ["lower-case update", 'const q = "update shopper_sessions set revoked_at = $2 where id = $1";'],
      ["mixed-case update", 'const q = "Update shopper_sessions Set revoked_at = $2";'],
      ["lower-case delete", 'const q = "delete from carts using stale s where s.id = carts.id and s.id in (select 1 from t)";'],
      ["lower case, multiline template literal", "const q = `\n  select id,\n         token_digest\n    from shopper_sessions\n   where id = $1`;"],
      ["mixed case, multiline template literal", "const q = `\n  Select id\n    From shopper_sessions`;"],
      ["lower case, template literal with an interpolation", "const q = `select * from ${table}\n where id = $1`;"],
      ["lower case, concatenated over lines", 'const q = "select id, token_digest " +\n  "from shopper_sessions where id = $1";'],
      ["mixed case, joined array over lines", 'const q = ["Update shopper_sessions",\n  "sEt revoked_at = $2",\n  "where id = $1"].join(" ");'],
      ["lower-case insert split across lines", "const q = `insert\n  into audit_events (event_id)\n\n  values ($1)`;"],
      ["lower-case delete split across lines", "const q = `delete\n\tfrom carts\n where id in (\n  select\n   cart_id\n  from stale)`;"],
      ["upper case, multiline template literal", "const q = `\n  SELECT id\n    FROM shopper_sessions`;"],
      ["Windows line endings", "const q = `select 1\r\nfrom t`;"],
      ["a tagged template", "const rows = await sql`\n  select id\n  from quotes`;"],
    ];
    for (const [name, source] of cases) {
      expect(containsSqlText(source), name).toBe(true);
      for (const file of unauthorized) expect(violatesSqlRule(file, source), `${name} in ${file}`).toBe(true);
      // Only the two exact files are exempt, for every case.
      for (const allowed of SQL_MODULES) expect(violatesSqlRule(allowed, source), name).toBe(false);
    }
    // The upper-case-only rule this replaces missed every lower-case and mixed-case form above.
    const upperOnly = /\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^;]*?\b(?:FROM|SET|VALUES)\b/;
    expect(cases.filter(([, source]) => !upperOnly.test(source)).length).toBeGreaterThanOrEqual(17);
    // The pattern itself: case-insensitive, not global or sticky (no state between calls), and able to cross lines.
    expect(SQL_TEXT.flags).toBe("i");
    expect(containsSqlText("select 1\nfrom t") && containsSqlText("select 1\nfrom t")).toBe(true);
  });

  it("allows SQL in exactly two files, matched by full path and never by directory or name", () => {
    expect(SQL_MODULES).toEqual([join(ROOT, "src", "lib", "db", "queries.ts"), join(ROOT, "src", "lib", "pg", "statements.ts")]);
    const sql = "const q = `SELECT 1\n  FROM t`;";
    for (const allowed of SQL_MODULES) expect(violatesSqlRule(allowed, sql)).toBe(false);
    for (const refused of [
      join(ROOT, "src", "lib", "pg", "client.ts"),
      join(ROOT, "src", "lib", "pg", "migrate.ts"),
      join(ROOT, "src", "lib", "pg", "more-statements.ts"),
      join(ROOT, "src", "lib", "pg", "statements.ts.ts"),
      join(ROOT, "src", "lib", "pg", "nested", "statements.ts"),
      join(ROOT, "src", "lib", "db", "nested", "queries.ts"),
      join(ROOT, "src", "server", "db", "queries.ts"),
      join(ROOT, "src", "lib", "db", "other.ts"),
      join(ROOT, "src", "statements.ts"),
      join("src", "lib", "pg", "statements.ts"),
    ]) {
      expect(violatesSqlRule(refused, sql), refused).toBe(true);
    }
  });

  it("scopes every ownership lookup by session", () => {
    for (const name of ["findQuoteForSession", "findIntentForSession", "findConfirmationForSession"] as const) {
      expect(SQL[name]).toMatch(/WHERE \w\.id = \$1 AND \w\.session_id = \$2$/);
    }
  });
});

describe("SEC-01: no sensitive credentials in client output or logs", () => {
  it("redacts secrets, tokens and free text from audit events", async () => {
    const token = generateSessionToken();
    const log = new InMemoryAuditLog();
    const stored = await log.append({
      eventId: "ev_1",
      eventType: "CONFIRMATION_ACCEPTED",
      occurredAt: "2026-10-08T12:00:00.000Z",
      actor: "shopper",
      sessionId: "ses_" + "a".repeat(32),
      checkoutIntentId: "ci_" + "b".repeat(32),
      operationId: null,
      detail: {
        sessionToken: token,
        csrfToken: "abc",
        nonce: "n",
        authorization: "Bearer abc.def",
        clientSecret: "s3cret",
        cookie: "__Host-shopaccess_session=x",
        shopperMessage: "my card is 4111 1111 1111 1111",
        innocentKey: token,
        looksLikeDigest: "a".repeat(64),
        nested: { password: "hunter2" },
        totalCents: 79900,
        result: "ACCEPTED",
        long: "x".repeat(1000),
      },
    });
    const serialized = JSON.stringify(log.list());
    for (const secret of [token, "s3cret", "hunter2", "4111", "Bearer", "abc.def", "__Host-"]) expect(serialized).not.toContain(secret);
    expect(stored.detail).toMatchObject({ totalCents: 79900, result: "ACCEPTED", sessionToken: REDACTED, innocentKey: REDACTED, looksLikeDigest: REDACTED, nested: REDACTED });
    expect(String(stored.detail.long).length).toBeLessThan(300);
    expect(Object.isFrozen(stored)).toBe(true);
    // The audit log interface is append-only.
    expect(Object.getOwnPropertyNames(InMemoryAuditLog.prototype).sort()).toEqual(["append", "constructor", "list"]);
    await expect(log.append({ ...stored, detail: {} })).rejects.toThrow();
    expect(() => sanitizeAuditEvent({ eventId: "ev_2", eventType: "X", detail: {}, sessionId: token })).toThrow();
  });

  it("public error responses carry only fixed text", () => {
    const secretError = new Error("connect ECONNREFUSED postgres://app:hunter2@db.internal:5432/shop at /srv/app/db.ts:10");
    const response = publicErrorFromUnknown(secretError, "req_123");
    expect(response).toEqual({ status: 500, body: { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again.", requestId: "req_123" } } });
    for (const code of PUBLIC_ERROR_CODES) {
      const body = JSON.stringify(toPublicError(code, "<script>alert(1)</script>"));
      expect(body).not.toMatch(/script|stack|postgres|hunter2/i);
      expect(body).toContain('"requestId":"unavailable"');
    }
  });

  it("no credentials, private keys or client-exposed secrets exist in the repository sources", () => {
    const files = [
      ...filesUnder(join(ROOT, "src"), /\.(ts|tsx|css)$/),
      ...filesUnder(join(ROOT, "db"), /\.sql$/),
      ...filesUnder(join(ROOT, "public"), /\.(svg|json|txt|html|js)$/),
      join(ROOT, "next.config.ts"),
      join(ROOT, "package.json"),
    ];
    const forbidden = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\bsk_(?:live|test)_[A-Za-z0-9]+/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /NEXT_PUBLIC_[A-Z_]*(?:SECRET|TOKEN|KEY|PASSWORD)/,
      /(?:secret|password|client_secret|api_key|apikey)\s*[:=]\s*["'][^"']{8,}["']/i,
      /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/,
      /\bA[A-Za-z0-9_-]{20,}:E[A-Za-z0-9_-]{20,}\b/,
    ];
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
    }
    expect(filesUnder(ROOT, /^\.env/).filter((file) => !file.includes("node_modules"))).toEqual([]);
  });

  it("UI code reads no environment variables and imports no server-only modules", () => {
    const listingSearchForm = join(ROOT, "src", "components", "mock-journey", "ListingSearchForm.tsx");
    // M2-3 (owner decision, October 17): moves focus after a full-page form result. See focusOnArrivalViolations.
    const focusOnArrival = join(ROOT, "src", "components", "FocusOnArrival.tsx");
    for (const file of [...filesUnder(join(ROOT, "src", "components"), /\.tsx$/), ...filesUnder(join(ROOT, "src", "app"), /\.tsx$/)]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/process\.env/);
      expect(text, file).not.toMatch(/@\/lib\/(?:session|db|payment|security|providers\/payment)/);
      if (file === listingSearchForm) {
        expect(text).toContain('"use client"');
        expect(text).not.toMatch(/\bfetch\s*\(|@\/lib\/(?:session|db|payment|security|providers)|@\/server\//);
      } else if (file === focusOnArrival) {
        expect(focusOnArrivalViolations(text)).toEqual([]);
        expect(pinViolation(readFileSync(file), FOCUS_ON_ARRIVAL_SHA256)).toBeNull();
      } else {
        expect(text, file).not.toMatch(/["']use client["']/);
      }
    }
    // Environment access happens in exactly one place; everything else receives configuration as an argument.
    const readers = filesUnder(join(ROOT, "src"), /\.(ts|tsx)$/).filter((file) => /process\.env/.test(readFileSync(file, "utf8")));
    expect(readers).toEqual([join(ROOT, "src", "server", "runtime.ts")]);
    expect(readFileSync(readers[0], "utf8").match(/process\.env/g)).toHaveLength(2);
  });

  it("SEC-01: exactly two client modules in all of src, and FocusOnArrival only where the plan put it", () => {
    // The permissions page only (docs/m2-3-plan.md §9): FocusOnArrival through PurchasePermissions, used by that page alone.
    expect(sec01Report(collectSec01Sources(join(ROOT, "src")), ROOT)).toEqual({
      clientModules: [join(ROOT, "src", "components", "FocusOnArrival.tsx"), join(ROOT, "src", "components", "mock-journey", "ListingSearchForm.tsx")].sort(),
      focusOnArrivalImporters: [join(ROOT, "src", "components", "PurchasePermissions.tsx")],
      purchasePermissionsImporters: [join(ROOT, "src", "app", "shop", "permissions", "page.tsx")],
      computedSpecifiers: [],
    });
  });

  describe("SEC-01 through the repository path: collector and policy together, on a temporary source tree (Codex review)", () => {
    /** Builds a throwaway repository with the real approved files plus the given extra files, and reports on it. */
    function reportFor(extra: Record<string, string>) {
      const root = mkdtempSync(join(tmpdir(), "sec01-"));
      try {
        const files: Record<string, string> = {
          "src/components/FocusOnArrival.tsx": readFileSync(join(ROOT, "src", "components", "FocusOnArrival.tsx"), "utf8"),
          "src/components/mock-journey/ListingSearchForm.tsx": '"use client";\nexport function ListingSearchForm() { return null; }\n',
          "src/components/PurchasePermissions.tsx": 'import { FocusOnArrival } from "./FocusOnArrival";\nexport const P = FocusOnArrival;\n',
          "src/app/shop/permissions/page.tsx": 'import { PurchasePermissions } from "@/components/PurchasePermissions";\nexport default PurchasePermissions;\n',
          ...extra,
        };
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), text);
        }
        const report = sec01Report(collectSec01Sources(join(root, "src")), root);
        const relative = (paths: readonly string[]) => paths.map((path) => path.slice(root.length + 1)).sort();
        return {
          clientModules: relative(report.clientModules),
          focusOnArrivalImporters: relative(report.focusOnArrivalImporters),
          purchasePermissionsImporters: relative(report.purchasePermissionsImporters),
          computedSpecifiers: report.computedSpecifiers.map((entry) => entry.slice(root.length + 1)).sort(),
        };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const APPROVED = {
      clientModules: ["src/components/FocusOnArrival.tsx", "src/components/mock-journey/ListingSearchForm.tsx"],
      focusOnArrivalImporters: ["src/components/PurchasePermissions.tsx"],
      purchasePermissionsImporters: ["src/app/shop/permissions/page.tsx"],
      computedSpecifiers: [],
    };

    it("the approved tree passes (positive control)", () => {
      expect(reportFor({})).toEqual(APPROVED);
    });

    it("finding 1: .mts and .cts files are collected, so their client directives and FocusOnArrival imports are refused", () => {
      expect(
        reportFor({
          "src/lib/client-module.mts": '"use client";\nexport const a = 1;\n',
          "src/server/client-module.cts": "'use client';\nexports.a = 1;\n",
          "src/lib/uses-focus.mts": 'import { FocusOnArrival } from "../components/FocusOnArrival";\nexport const f = FocusOnArrival;\n',
          "src/server/uses-focus.cts": 'const f = require("@/components/FocusOnArrival");\nmodule.exports = f;\n',
        }),
      ).toEqual({
        ...APPROVED,
        clientModules: [...APPROVED.clientModules, "src/lib/client-module.mts", "src/server/client-module.cts"].sort(),
        focusOnArrivalImporters: [...APPROVED.focusOnArrivalImporters, "src/lib/uses-focus.mts", "src/server/uses-focus.cts"].sort(),
      });
    });

    it("finding 2: computed import() and require() specifiers are refused, wherever they are in src", () => {
      const report = reportFor({
        "src/lib/a.ts": 'const name = "../components/FocusOnArrival";\nexport const m = () => import(name);\n',
        "src/lib/b.ts": 'export const m = () => import("../components/Focus" + "OnArrival");\n',
        "src/lib/c.ts": "const part = \"FocusOnArrival\";\nexport const m = () => import(`../components/${part}`);\n",
        "src/lib/d.cts": 'const name = "../components/FocusOnArrival";\nmodule.exports = require(name);\n',
        "src/lib/e.js": 'const base = "../components/";\nmodule.exports = require(base + "FocusOnArrival");\n',
      });
      expect(report.computedSpecifiers).toEqual(["src/lib/a.ts:2 import()", "src/lib/b.ts:1 import()", "src/lib/c.ts:2 import()", "src/lib/d.cts:2 require()", "src/lib/e.js:2 require()"]);
    });

    it("finding 2: literal forms, explicit suffixes, type-only and TS import-equals imports, aliases and re-exports are all importers", () => {
      const report = reportFor({
        "src/lib/template.ts": "export const m = () => import(`../components/FocusOnArrival`);\n",
        "src/lib/suffix-js.ts": 'export { FocusOnArrival } from "../components/FocusOnArrival.js";\n',
        "src/lib/suffix-tsx.ts": 'import { FocusOnArrival } from "@/components/FocusOnArrival.tsx";\nexport const f = FocusOnArrival;\n',
        "src/lib/suffix-jsx.mjs": 'export * from "../components/FocusOnArrival.jsx";\n',
        "src/lib/type-only.ts": 'import type { FocusOnArrival } from "../components/FocusOnArrival";\nexport type F = typeof FocusOnArrival;\n',
        "src/lib/import-equals.ts": 'import f = require("../components/FocusOnArrival");\nexport const g = f;\n',
        "src/components/index.ts": 'export * from "./FocusOnArrival";\nexport { PurchasePermissions as Permissions } from "./PurchasePermissions";\n',
        "src/app/other/page.tsx": 'import { Permissions } from "@/components";\nexport default Permissions;\n',
        "src/lib/not-it.ts": 'import { x } from "./NotFocusOnArrivalHelper";\nexport const y = x;\n',
        "src/lib/NotFocusOnArrivalHelper.ts": "export const x = 1;\n",
      });
      expect(report.focusOnArrivalImporters).toEqual(
        [
          "src/components/PurchasePermissions.tsx",
          "src/components/index.ts",
          "src/lib/import-equals.ts",
          "src/lib/suffix-js.ts",
          "src/lib/suffix-jsx.mjs",
          "src/lib/suffix-tsx.ts",
          "src/lib/template.ts",
          "src/lib/type-only.ts",
        ].sort(),
      );
      // A barrel that re-exports PurchasePermissions is itself an importer, so the alias path cannot hide a second user
      // (src/app/other/page.tsx reaches it only through the barrel, which is what the policy reports).
      expect(report.purchasePermissionsImporters).toEqual(["src/app/shop/permissions/page.tsx", "src/components/index.ts"]);
      expect(report.computedSpecifiers).toEqual([]);
    });
  });

  it("SEC-01 negative controls: each known way around the FocusOnArrival exception is caught", () => {
    const real = readFileSync(join(ROOT, "src", "components", "FocusOnArrival.tsx"), "utf8");
    expect(focusOnArrivalViolations(real)).toEqual([]);
    // Review finding 1's bypasses of the previous checks, then other routes to the same capabilities.
    const additions: Record<string, string> = {
      indentedImport: '  import { cookies } from "next/headers";',
      splitImport: 'import\n  { x } from "../server/handlers";',
      reExport: 'export { handlePermissionRevoke } from "../server/handlers";',
      dynamicImport: 'void import("../server/handlers");',
      require: 'const fs = require("fs");',
      sendBeacon: 'navigator.sendBeacon("/x", "y");',
      locationAssign: 'window.location = "https://example.test";',
      dangerousHtml: "export const X = () => <div dangerouslySetInnerHTML={{ __html: targetId }} />;",
      fetch: 'void fetch("/api");',
      escapedFetch: "void \\u0066etch(targetId);",
      templateString: "const u = `/x/${targetId}`;",
      windowOpen: 'window.open("https://example.test");',
      cookie: "const c = document.cookie;",
      storage: 'localStorage.setItem("k", targetId);',
      evalCall: "eval(targetId);",
    };
    for (const [name, line] of Object.entries(additions)) {
      expect(focusOnArrivalViolations(`${real}\n${line}\n`), name).not.toEqual([]);
    }
    // A comment may say anything; it is not code.
    expect(focusOnArrivalViolations(`${real}\n// fetch(require("x")) and window.location are mentioned only here\n`)).toEqual([]);

    // Second review, finding 1. Bypass A: a string "//" used to hide the rest of its line from the vocabulary check.
    const bypassA = `${real}\n"//"; fetch(targetId); navigator.sendBeacon("/x", document.cookie);\n`;
    expect(focusOnArrivalViolations(bypassA)).toEqual(expect.arrayContaining(['string "//"', "identifier fetch", "identifier navigator", "identifier sendBeacon", "identifier cookie"]));
    // Bypass B: code made only of punctuation has no identifier or string, so only the pin can see it.
    const bypassB = `${real}\n[][(![]+[])[+[]]];\n`;
    expect(focusOnArrivalViolations(bypassB)).toEqual([]);
    // The pin rejects both, and any other change at all, down to one added space.
    expect(pinViolation(readFileSync(join(ROOT, "src", "components", "FocusOnArrival.tsx")), FOCUS_ON_ARRIVAL_SHA256)).toBeNull();
    for (const [name, text] of Object.entries({ bypassA, bypassB, addedSpace: `${real} `, commentOnly: `${real}// note\n` })) {
      expect(pinViolation(text, FOCUS_ON_ARRIVAL_SHA256), name).not.toBeNull();
    }

    // The directive scan covers every script extension and directory, and the importer scan every import form.
    const fake = (path: string, text: string) => ({ path, text });
    expect(clientDirectiveFiles([fake("src/lib/x.ts", '"use client";\nexport const a = 1;'), fake("src/app/y.jsx", "  'use client'\n"), fake("src/lib/z.ts", "export {};")])).toEqual([
      "src/lib/x.ts",
      "src/app/y.jsx",
    ]);
    // Second review: valid prologues the line-start check missed, and the .mts/.cts extensions (one .mts exists in src).
    expect(
      clientDirectiveFiles([
        fake("src/lib/lead.ts", '/* note */ "use client";\nexport const a = 1;'),
        fake("src/lib/strict.js", '"use strict"; "use client";\nexport const a = 1;'),
        fake("src/lib/after-line-comment.ts", '// header\n/** doc */\n"use client"\nexport const a = 1;'),
        fake("src/server/tool.mts", '"use client";\n'),
        fake("src/server/tool.cts", "'use client';\n"),
        // Not directives: a mention in a comment, or the same text later as an ordinary string.
        fake("src/lib/comment.ts", '// "use client" is not used here\nexport const a = 1;'),
        fake("src/lib/later.ts", 'export const a = 1;\nconst b = ["use client"];'),
      ]),
    ).toEqual(["src/lib/lead.ts", "src/lib/strict.js", "src/lib/after-line-comment.ts", "src/server/tool.mts", "src/server/tool.cts"]);
    // Importer forms (static, dynamic, require, template, suffixes, re-exports, aliases) and computed specifiers are
    // covered through the repository path in "SEC-01 through the repository path" above.
  });

  it("session identifiers never appear in URLs or provider metadata", async () => {
    const { createWorld, confirmedIntent, newSession } = await import("./helpers");
    const { dispatchOrderCreate } = await import("@/lib/payment/orchestrator");
    const world = createWorld();
    const { session, token } = await newSession(world);
    const { intentId } = await confirmedIntent(world, session.id);
    const sent: unknown[] = [];
    const provider = { ...world.payment().provider, createOrder: async (request: never) => (sent.push(request), world.provider.createOrder(request)) };
    await dispatchOrderCreate({ ...world.payment(), provider: Object.assign(Object.create(world.provider), provider) }, intentId);
    const outbound = JSON.stringify(sent) + JSON.stringify(await world.store.listObservations(intentId));
    expect(sent).toHaveLength(1);
    expect(outbound).not.toContain(token);
    expect(outbound).not.toContain(session.id);
    expect(outbound).not.toContain(session.csrfToken);
  });
});

describe("rate limiting interface", () => {
  it("limits per subject and window in the reference implementation", async () => {
    const time = createTestClock();
    const limiter = createFixedWindowRateLimiter(new InMemoryRateLimitStore(), time.clock);
    const policy = PROPOSED_RATE_LIMIT_POLICIES.confirmation;
    for (let attempt = 0; attempt < policy.limit; attempt += 1) expect((await limiter.consume(policy, "ses_a")).allowed).toBe(true);
    const blocked = await limiter.consume(policy, "ses_a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect((await limiter.consume(policy, "ses_b")).allowed).toBe(true);
    time.advance(MINUTE);
    expect((await limiter.consume(policy, "ses_a")).allowed).toBe(true);
  });
});

describe("migration files (static checks only - these do not execute SQL)", () => {
  it("are strictly ordered, transactional and cover every required table", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    migrationFiles.forEach((name, index) => expect(name).toMatch(new RegExp(`^${String(index + 1).padStart(4, "0")}_[a-z_]+\\.sql$`)));
    for (const name of migrationFiles) {
      const text = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      expect(text.match(/^BEGIN;$/m), name).not.toBeNull();
      expect(text.trimEnd().endsWith("COMMIT;"), name).toBe(true);
      expect(text, name).not.toMatch(/\bDROP\b|\bTRUNCATE TABLE\b|INSERT INTO/i);
    }
    for (const table of [
      "shopper_sessions", "merchants", "merchant_products", "merchant_variants", "carts", "cart_items", "checkout_intents",
      "quotes", "quote_items", "confirmations", "payment_operations", "payment_provider_observations", "audit_events",
    ]) {
      expect(migrationSql, table).toMatch(new RegExp(`CREATE TABLE ${table} \\(`));
    }
  });

  it("declare the same states and identifiers the application uses", () => {
    for (const state of PAYMENT_STATES) expect(migrationSql, state).toContain(`'${state}'`);
    for (const state of ["PENDING", "DISPATCHING", "UNKNOWN", "READBACK_CLEARED", "PENDING_PROVIDER", "SUCCEEDED", "DECLINED", "REJECTED"]) {
      expect(migrationSql).toContain(`'${state}'`);
    }
    for (const column of [...Object.values(SQL).join(" ").matchAll(/\b(token_digest|absolute_expires_at|revoked_at|row_version|lease_owner|lease_expires_at|attempt_count|consumed_at|checkout_intent_id|operation_id|event_id)\b/g)].map((match) => match[1])) {
      expect(migrationSql, column).toContain(column);
    }
    expect(migrationSql).toMatch(/provider_request_id\s+text NOT NULL UNIQUE/);
    expect(migrationSql).toMatch(/provider_order_id\s+text UNIQUE/);
    expect(migrationSql).toMatch(/provider_capture_id\s+text UNIQUE/);
    expect(migrationSql).toMatch(/UNIQUE \(checkout_intent_id, operation_type, sequence\)/);
    expect(migrationSql).toMatch(/audit_events_append_only BEFORE UPDATE OR DELETE/);
  });
});
