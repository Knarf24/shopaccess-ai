import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
import { InMemoryAuditLog, REDACTED, sanitizeAuditEvent } from "@/lib/security/audit";
import { PUBLIC_ERROR_CODES, publicErrorFromUnknown, toPublicError } from "@/lib/security/errors";
import { createFixedWindowRateLimiter, InMemoryRateLimitStore, PROPOSED_RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";
import { generateSessionToken } from "@/lib/session/token";
import { PAYMENT_STATES } from "@/lib/payment/state-machine";
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

const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
const migrationSql = migrationFiles.map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8")).join("\n");

describe("ENV-01: live or mixed payment configuration is rejected (future adapter configuration)", () => {
  const sandbox = {
    PAYMENT_PROVIDER_MODE: "sandbox",
    PAYPAL_CLIENT_ID: "placeholder-client-id",
    PAYPAL_CLIENT_SECRET: "placeholder-client-secret",
    PAYPAL_API_BASE_URL: SANDBOX_API_BASE_URL,
  };

  it("accepts mock mode only when no provider settings are present", () => {
    expect(parsePaymentAdapterConfig({ PAYMENT_PROVIDER_MODE: "mock" })).toEqual({ ok: true, value: { mode: "mock" } });
    expect(parsePaymentAdapterConfig({})).toEqual({ ok: false, error: "MODE_MISSING" });
    for (const key of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_API_BASE_URL", "PAYPAL_WEBHOOK_ID"]) {
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

  it("even a valid sandbox configuration cannot be activated in this milestone", () => {
    const parsed = parsePaymentAdapterConfig(sandbox);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The parsed config never carries credentials onward.
    expect(JSON.stringify(parsed.value)).not.toContain("placeholder");
    expect(requireMockOnly(parsed.value)).toEqual({ ok: false, error: "PROVIDER_NOT_AUTHORIZED_FOR_MILESTONE" });
    expect(requireMockOnly({ mode: "mock" })).toEqual({ ok: true, value: { mode: "mock" } });
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
    for (const file of [...filesUnder(join(ROOT, "src", "components"), /\.tsx$/), ...filesUnder(join(ROOT, "src", "app"), /\.tsx$/)]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/process\.env/);
      expect(text, file).not.toMatch(/@\/lib\/(?:session|db|payment|security|providers\/payment)/);
      expect(text, file).not.toMatch(/["']use client["']/);
    }
    // Environment access happens in exactly one place; everything else receives configuration as an argument.
    const readers = filesUnder(join(ROOT, "src"), /\.(ts|tsx)$/).filter((file) => /process\.env/.test(readFileSync(file, "utf8")));
    expect(readers).toEqual([join(ROOT, "src", "server", "runtime.ts")]);
    expect(readFileSync(readers[0], "utf8").match(/process\.env/g)).toHaveLength(2);
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

// MIG-01 needs a real PostgreSQL server. It runs only when SHOPACCESS_TEST_DATABASE_URL points at a
// disposable local database; otherwise it is reported as skipped (NOT RUN), never as passed.
const TEST_DATABASE_URL = process.env.SHOPACCESS_TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("MIG-01: schema and migration constraints (requires a local test database)", () => {
  it("applies all migrations in order and enforces key constraints", async () => {
    const url = new URL(TEST_DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("MIG-01 refuses to run against a non-local database");
    const { Client } = await import("pg");
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const schema = `shopaccess_mig01_${Date.now()}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      for (const name of migrationFiles) await client.query(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));

      const now = "2026-10-08T12:00:00Z";
      const session = ["ses_" + "a".repeat(32), "a".repeat(64), now, now, "2026-10-09T12:00:00Z", 500];
      await client.query(SQL.insertSessionWithinCapacity, session);
      await expect(client.query(SQL.insertSessionWithinCapacity, ["ses_" + "b".repeat(32), "a".repeat(64), now, now, "2026-10-09T12:00:00Z", 500])).rejects.toThrow();
      await expect(client.query(SQL.insertSessionWithinCapacity, ["ses_" + "c".repeat(32), "c".repeat(64), now, now, "2026-10-12T12:00:00Z", 500])).rejects.toThrow();
      await client.query(SQL.appendAuditEvent, ["ev_1", "TEST_EVENT", now, "server", null, null, null, "{}"]);
      await expect(client.query("UPDATE audit_events SET actor = $1", ["x"])).rejects.toThrow();
      await expect(client.query("DELETE FROM audit_events WHERE event_id = $1", ["ev_1"])).rejects.toThrow();
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await client.end();
    }
  });
});
