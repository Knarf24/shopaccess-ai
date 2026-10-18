import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePersistenceMode, parseRuntimeConfig } from "@/server/config";
import { parsePgRuntimeConfig, type PgRuntime, type PgServices } from "@/server/pg-runtime";
import { mockRouteNotFound, withApplication } from "@/server/respond";
import { getApplication, getRuntime, type Application } from "@/server/runtime";

// NEVER RUN when written. Database-free, and nothing here opens a connection: the PostgreSQL runtime is created but
// never asked for its services, and where a runtime is needed a stand-in is used. Acceptance cases are those of the
// Increment 2.3 plan (specification 19.19).

// Synthetic, test-only values.
const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const SESSION_KEYS = `1:${Buffer.alloc(32, 61).toString("base64")}`;
const NONCE_KEYS = `1:${Buffer.alloc(32, 62).toString("base64")}`;
const PG_ENV: Readonly<Record<string, string | undefined>> = {
  SHOPACCESS_DATABASE_URL: "postgres://shopaccess_web@db.example.test:5432/shopaccess",
  SHOPACCESS_SESSION_KEYS: SESSION_KEYS,
  SHOPACCESS_NONCE_KEYS: NONCE_KEYS,
  SHOPACCESS_TRUSTED_ORIGINS: "https://shop.example.test",
  PAYMENT_PROVIDER_MODE: "mock",
};
const MOCK_ENV: Readonly<Record<string, string | undefined>> = {
  SHOPACCESS_SESSION_KEY: Buffer.alloc(32, 63).toString("base64"),
  SHOPACCESS_TRUSTED_ORIGINS: "https://shop.example.test",
  PAYMENT_PROVIDER_MODE: "mock",
};

function filesUnder(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return filesUnder(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), "utf8");
const relative = (file: string): string => file.slice(ROOT.length + 1);

const APPLICATION_KEY = Symbol.for("shopaccess.application");
type Holder = typeof globalThis & { [APPLICATION_KEY]?: Application };
const holder = globalThis as Holder;

const MANAGED = ["SHOPACCESS_PERSISTENCE_MODE", "SHOPACCESS_DATABASE_URL", "SHOPACCESS_SESSION_KEYS", "SHOPACCESS_NONCE_KEYS", "SHOPACCESS_SESSION_KEY", "SHOPACCESS_TRUSTED_ORIGINS", "PAYMENT_PROVIDER_MODE", "SHOPACCESS_ADVISORY_BUDGET_SLOTS", "SHOPACCESS_ADVISORY_BUDGET_DIR"];
let saved = new Map<string, string | undefined>();
let savedApplication: Application | undefined;

/** Replaces the settings this application reads, and forgets the application built from the earlier ones. */
function replaceEnvironment(values: Readonly<Record<string, string | undefined>>): void {
  for (const name of MANAGED) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete holder[APPLICATION_KEY];
}

beforeEach(() => {
  saved = new Map(MANAGED.map((name) => [name, process.env[name]]));
  savedApplication = holder[APPLICATION_KEY];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (savedApplication) holder[APPLICATION_KEY] = savedApplication;
  else delete holder[APPLICATION_KEY];
  vi.restoreAllMocks();
});

describe("persistence mode: PostgreSQL is opt-in, and a mode that is not recognised serves nothing (A23)", () => {
  it("is the mock only when the setting is not set at all, PostgreSQL only for the exact value, and an error for anything else", () => {
    expect(parsePersistenceMode({})).toEqual({ ok: true, value: "mock" });
    expect(parsePersistenceMode({ SHOPACCESS_PERSISTENCE_MODE: "postgres" })).toEqual({ ok: true, value: "postgres" });
    for (const value of ["", "mock", "Postgres", "POSTGRES", "postgresql", "pg", " postgres", "postgres ", "true", "1"]) {
      expect(parsePersistenceMode({ SHOPACCESS_PERSISTENCE_MODE: value }), JSON.stringify(value)).toEqual({ ok: false, error: "PERSISTENCE_MODE_INVALID" });
    }
  });

  it("A23 and A33: with the mode not set the application is the mock, built from the mock's own settings as before", () => {
    replaceEnvironment(MOCK_ENV);
    const application = getApplication();
    expect(application.mode).toBe("mock");
    expect(getApplication()).toBe(application);
    const runtime = getRuntime();
    expect(runtime.ok).toBe(true);
    if (application.mode !== "mock" || !runtime.ok) return;
    expect(application.runtime).toBe(runtime);
    expect(runtime.value.store.constructor.name).toBe("InMemoryCheckoutStore");

    // Absent AI settings select the local assistant. The original two values remain, and the errors are unchanged.
    const config = parseRuntimeConfig(MOCK_ENV);
    expect(config.ok && Object.keys(config.value).sort()).toEqual(["advisory", "sessionKey", "trustedOrigins"]);
    if (config.ok) expect(config.value.advisory).toEqual({ mode: "local" });
    expect(parseRuntimeConfig({})).toEqual({ ok: false, error: ["SESSION_KEY_MISSING", "TRUSTED_ORIGINS_MISSING", "PAYMENT_MODE_NOT_MOCK"] });

    // The PostgreSQL settings alone never make the application PostgreSQL mode.
    replaceEnvironment({ ...MOCK_ENV, ...PG_ENV });
    expect(getApplication().mode).toBe("mock");
  });

  it("A23: in PostgreSQL mode no mock runtime exists, with or without the mock's settings, and whether or not the PostgreSQL settings are complete", async () => {
    for (const env of [{ ...PG_ENV }, { ...PG_ENV, ...MOCK_ENV }, {}, { SHOPACCESS_DATABASE_URL: PG_ENV.SHOPACCESS_DATABASE_URL }]) {
      replaceEnvironment({ ...env, SHOPACCESS_PERSISTENCE_MODE: "postgres" });
      const application = getApplication();
      expect(application.mode).toBe("postgres");
      expect(getRuntime()).toEqual({ ok: false, error: [] });
      expect("store" in application).toBe(false);
      if (application.mode === "postgres") {
        expect(Object.keys(application.runtime).sort()).toEqual(["dispose", "services"]);
        // Nothing was asked of it, so nothing was connected; disposing it ends nothing.
        await application.runtime.dispose();
        expect(await application.runtime.services()).toBeNull();
      }
    }
  });

  it("A23: an unrecognised mode is neither the mock nor PostgreSQL", () => {
    for (const value of ["", "mock", "Postgres", "pg"]) {
      replaceEnvironment({ ...MOCK_ENV, ...PG_ENV, SHOPACCESS_PERSISTENCE_MODE: value });
      expect(getApplication(), JSON.stringify(value)).toEqual({ mode: "invalid" });
      expect(getRuntime(), JSON.stringify(value)).toEqual({ ok: false, error: [] });
    }
  });
});

describe("PostgreSQL mode settings: all required, none defaulted, and errors that name settings only (A23)", () => {
  it("accepts a complete configuration and does not need the mock's single key", () => {
    const parsed = parsePgRuntimeConfig(PG_ENV);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value).sort()).toEqual(["databaseUrl", "rings", "trustedOrigins"]);
    expect(parsed.value.rings.validated).toBe(true);
    expect([...parsed.value.trustedOrigins]).toEqual(["https://shop.example.test"]);
    expect(parsePgRuntimeConfig({ ...PG_ENV, SHOPACCESS_DATABASE_URL: "postgresql://shopaccess_web@db.example.test/shopaccess" }).ok).toBe(true);
    // The rings print versions only.
    expect(JSON.stringify(parsed.value.rings)).not.toContain(Buffer.alloc(32, 61).toString("base64"));
  });

  it("names every setting that is missing or invalid", () => {
    expect(parsePgRuntimeConfig({})).toEqual({ ok: false, error: ["DATABASE_URL_MISSING", "KEY_RINGS_INVALID", "TRUSTED_ORIGINS_MISSING", "PAYMENT_MODE_NOT_MOCK"] });
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ SHOPACCESS_DATABASE_URL: undefined }, "DATABASE_URL_MISSING"],
      [{ SHOPACCESS_DATABASE_URL: "" }, "DATABASE_URL_MISSING"],
      [{ SHOPACCESS_DATABASE_URL: "not a url" }, "DATABASE_URL_INVALID"],
      [{ SHOPACCESS_DATABASE_URL: "mysql://shopaccess_web@db.example.test/shopaccess" }, "DATABASE_URL_INVALID"],
      [{ SHOPACCESS_DATABASE_URL: "https://shop.example.test/" }, "DATABASE_URL_INVALID"],
      [{ SHOPACCESS_DATABASE_URL: "postgres://db.example.test/shopaccess" }, "DATABASE_URL_INVALID"],
      [{ SHOPACCESS_SESSION_KEYS: undefined }, "KEY_RINGS_INVALID"],
      [{ SHOPACCESS_NONCE_KEYS: undefined }, "KEY_RINGS_INVALID"],
      [{ SHOPACCESS_SESSION_KEYS: "1:c2hvcnQ=" }, "KEY_RINGS_INVALID"],
      // The same key bytes under both purposes are refused.
      [{ SHOPACCESS_NONCE_KEYS: SESSION_KEYS }, "KEY_RINGS_INVALID"],
      [{ SHOPACCESS_TRUSTED_ORIGINS: undefined }, "TRUSTED_ORIGINS_MISSING"],
      [{ SHOPACCESS_TRUSTED_ORIGINS: "not a url" }, "TRUSTED_ORIGINS_INVALID"],
      [{ SHOPACCESS_TRUSTED_ORIGINS: "http://localhost:3000" }, "TRUSTED_ORIGINS_INVALID"],
      [{ PAYMENT_PROVIDER_MODE: undefined }, "PAYMENT_MODE_NOT_MOCK"],
      [{ PAYMENT_PROVIDER_MODE: "paypal" }, "PAYMENT_MODE_NOT_MOCK"],
    ];
    for (const [change, error] of cases) {
      const parsed = parsePgRuntimeConfig({ ...PG_ENV, ...change });
      expect(parsed, JSON.stringify(Object.keys(change))).toEqual({ ok: false, error: [error] });
      // No value is ever part of an error.
      expect(JSON.stringify(parsed)).not.toMatch(/example\.test|c2hvcnQ|paypal/);
    }
    // A loopback origin over plain HTTP is accepted only in development, as in the mock.
    expect(parsePgRuntimeConfig({ ...PG_ENV, SHOPACCESS_TRUSTED_ORIGINS: "http://localhost:3000", NODE_ENV: "development" }).ok).toBe(true);
  });
});

describe("mode dispatch: PostgreSQL mode never reaches the mock, and 'not available' carries no business data (A23, A24)", () => {
  const services = { marker: "services" } as unknown as PgServices;
  const runtimeGiving = (value: PgServices | null): PgRuntime => ({ services: () => Promise.resolve(value), dispose: () => Promise.resolve() });
  const handlers = () => ({ mock: vi.fn(async () => new Response("mock")), postgres: vi.fn(async () => new Response("postgres")) });

  it("answers the generic 'not available' refusal while the PostgreSQL runtime has no services, and calls neither handler", async () => {
    holder[APPLICATION_KEY] = { mode: "postgres", runtime: runtimeGiving(null) };
    const both = handlers();
    const response = await withApplication(both);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe("UNAVAILABLE");
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "requestId"]);
    expect(both.mock).not.toHaveBeenCalled();
    expect(both.postgres).not.toHaveBeenCalled();
  });

  it("calls the PostgreSQL handler with the services when ready, and turns anything it throws into the generic internal error", async () => {
    holder[APPLICATION_KEY] = { mode: "postgres", runtime: runtimeGiving(services) };
    const both = handlers();
    expect(await (await withApplication(both)).text()).toBe("postgres");
    expect(both.postgres).toHaveBeenCalledWith(services);
    expect(both.mock).not.toHaveBeenCalled();

    const failing = await withApplication({ mock: both.mock, postgres: () => Promise.reject(new Error("relation shopaccess.quotes: permission denied")) });
    expect(failing.status).toBe(500);
    const text = await failing.text();
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toMatch(/permission denied|shopaccess\.quotes/);
  });

  it("serves nothing for an unrecognised mode, and the mock as before for the mock", async () => {
    holder[APPLICATION_KEY] = { mode: "invalid" };
    const both = handlers();
    const invalid = await withApplication(both);
    expect(invalid.status).toBe(503);
    expect((await invalid.json()).error.code).toBe("NOT_CONFIGURED");
    expect(both.mock).not.toHaveBeenCalled();
    expect(both.postgres).not.toHaveBeenCalled();

    // The mock without its settings: the answer it always gave.
    holder[APPLICATION_KEY] = { mode: "mock", runtime: { ok: false, error: ["SESSION_KEY_MISSING"] } };
    const unconfigured = await withApplication(both);
    expect(unconfigured.status).toBe(503);
    expect((await unconfigured.json()).error.code).toBe("NOT_CONFIGURED");
    expect(both.postgres).not.toHaveBeenCalled();

    // A route that exists only in PostgreSQL mode is "not found" in the mock.
    const missing = await mockRouteNotFound();
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
  });
});

describe("boundaries of the PostgreSQL wiring, checked on the source text (A20, A23, A32, A34)", () => {
  const PG_SERVER_MODULES = ["pg-handlers.ts", "pg-request-guard.ts", "pg-runtime.ts", "pg-views.ts"].map((name) => join("src", "server", name));
  const NEW_LIBRARY_MODULES = ["checkout-service.ts", "catalog.ts", "readiness.ts"].map((name) => join(SRC, "lib", "pg", name));
  const sources = filesUnder(SRC, /\.(ts|tsx)$/);

  it("A32: only the four PostgreSQL server modules import the PostgreSQL library; no page, component or route does", () => {
    const importers = sources
      .filter((file) => !file.startsWith(join(SRC, "lib", "pg")))
      .filter((file) => /["'](?:@\/lib\/pg|[./]+\/pg)\//.test(readFileSync(file, "utf8")))
      .map(relative)
      .sort();
    expect(importers).toEqual(PG_SERVER_MODULES);
    for (const file of [...filesUnder(join(SRC, "app"), /\.(ts|tsx)$/), ...filesUnder(join(SRC, "components"), /\.tsx$/)]) {
      expect(readFileSync(file, "utf8"), relative(file)).not.toMatch(/["']@\/lib\/pg\//);
    }
  });

  it("A32: no migration, bootstrap or operator statement is reachable from the application", () => {
    const reachable = [...PG_SERVER_MODULES.map((file) => join(ROOT, file)), ...NEW_LIBRARY_MODULES, join(SRC, "server", "runtime.ts"), join(SRC, "server", "respond.ts"), join(SRC, "server", "config.ts"), ...filesUnder(join(SRC, "app"), /\.(ts|tsx)$/)];
    for (const file of reachable) {
      const text = readFileSync(file, "utf8");
      expect(text, relative(file)).not.toMatch(/["'](?:@\/lib\/pg|\.)\/migrate["']/);
      expect(text, relative(file)).not.toMatch(/OPERATOR_STATEMENTS|MIGRATION_STATEMENTS|applyMigrations|activateKeyVersion|revokeKeyVersion|db\/bootstrap/);
      expect(text, relative(file)).not.toMatch(/withPinnedConnection|connectionSourceFromPool/);
    }
    // The session service is the only caller of the session entry points, and it names no operator function either.
    expect(read("lib", "pg", "session-service.ts")).not.toMatch(/OPERATOR_STATEMENTS|MIGRATION_STATEMENTS/);
  });

  it("A23: the PostgreSQL modules build no mock store, session service or confirmation, and the mock's modules know nothing of PostgreSQL mode", () => {
    for (const file of [...PG_SERVER_MODULES.map((name) => join(ROOT, name)), ...NEW_LIBRARY_MODULES]) {
      const text = readFileSync(file, "utf8");
      expect(text, relative(file)).not.toMatch(/InMemorySessionStore|InMemoryCheckoutStore|InMemoryOperationLedger|MockPaymentProvider|InMemoryAuditLog/);
      expect(text, relative(file)).not.toMatch(/createSessionService|readSessionCookie\b|serializeSessionCookie\b|authorizeMutation\b|prepareConfirmation|confirmPurchaseSummary|startCheckoutWithQuote/);
      expect(text, relative(file)).not.toMatch(/["']@\/lib\/(?:checkout|quote|payment\/(?:orchestrator|operations|state-machine))/);
    }
    for (const name of ["handlers.ts", "views.ts", "shopping.ts", "simulation.ts"]) {
      expect(read("server", name), name).not.toMatch(/pg-runtime|pg-handlers|pg-views|pg-request-guard|@\/lib\/pg/);
    }
    // The mock runtime is still built on the in-memory stores, in the same function as before.
    const runtime = read("server", "runtime.ts");
    expect(runtime).toMatch(/export function createRuntime\(config: RuntimeConfig/);
    expect(runtime).toMatch(/new InMemorySessionStore\(\)/);
    expect(runtime).toMatch(/new InMemoryCheckoutStore\(\)/);
    expect(runtime).not.toMatch(/@\/lib\/pg|Pool\b|shopaccess_api/);
  });

  it("A14: no checkout call is re-run: the checkout service and the handlers never use the re-run helper", () => {
    for (const file of [...PG_SERVER_MODULES.map((name) => join(ROOT, name)), ...NEW_LIBRARY_MODULES]) {
      expect(readFileSync(file, "utf8"), relative(file)).not.toMatch(/runWithReruns|isRerunnableDatabaseError|MAX_TRANSACTION_RERUNS/);
    }
  });

  it("A15 and A20: building a page calls no mutating method, and GET routes are the session routes plus the sandbox return and cancel pages", () => {
    const views = read("server", "pg-views.ts");
    expect(views).not.toMatch(/\.(?:start|cancel|issue|consume|rotate|establish|revoke)\(/);
    expect(views).not.toMatch(/pg-handlers/);
    for (const file of filesUnder(join(SRC, "app"), /\.tsx$/)) expect(readFileSync(file, "utf8"), relative(file)).not.toMatch(/pg-handlers|@\/server\/handlers/);

    const getRoutes = filesUnder(join(SRC, "app"), /^route\.ts$/)
      .filter((file) => /export async function GET\b/.test(readFileSync(file, "utf8")))
      .map(relative)
      .sort();
    expect(getRoutes).toEqual(
      [
        // M2-2: the extension conversation read. It changes nothing; it is bearer-authenticated and mock only.
        join("src", "app", "api", "extension", "v1", "conversation", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "paypal-cancel", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "return", "route.ts"),
        join("src", "app", "session", "needs", "route.ts"),
        join("src", "app", "session", "start", "route.ts"),
      ].sort(),
    );
    const needsGet = readFileSync(join(ROOT, "src", "app", "session", "needs", "route.ts"), "utf8");
    expect(needsGet).toContain("postgres: async () => mockRouteNotFound()");
    // The handler behind it rotates nothing.
    const handlers = read("server", "pg-handlers.ts");
    const sessionStart = handlers.slice(handlers.indexOf("export async function handlePgSessionStart"), handlers.indexOf("export async function handlePgSessionNew"));
    expect(sessionStart).not.toMatch(/\.rotate\(|establish\(state|establish\(cookie|\.checkout\./);
    expect(sessionStart).toMatch(/establish\(null\)/);
  });

  it("A32: every route dispatches by mode, and a route of PostgreSQL mode alone is 'not found' in the mock", () => {
    const routes = filesUnder(join(SRC, "app"), /^route\.ts$/).map(relative).sort();
    expect(routes).toEqual(
      [
        // M2-2 extension API (docs/m2-2-plan.md §3.1): mock only.
        join("src", "app", "api", "extension", "v1", "conversation", "route.ts"),
        join("src", "app", "api", "extension", "v1", "conversation", "turns", "route.ts"),
        join("src", "app", "api", "extension", "v1", "pairings", "[pairingId]", "exchange", "route.ts"),
        join("src", "app", "api", "extension", "v1", "pairings", "[pairingId]", "status", "route.ts"),
        join("src", "app", "api", "extension", "v1", "pairings", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "approve", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "cancel", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "capture", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "confirm", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "paypal-cancel", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "return", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "review", "route.ts"),
        join("src", "app", "checkout", "[intentId]", "simulate", "route.ts"),
        join("src", "app", "checkout", "start", "route.ts"),
        join("src", "app", "demo", "admission", "logout", "route.ts"),
        join("src", "app", "demo", "admission", "submit", "route.ts"),
        // M2-2 website side of pairing: approve or deny, and revoke. Mock only.
        join("src", "app", "extension", "pair", "decide", "route.ts"),
        join("src", "app", "extension", "revoke", "route.ts"),
        join("src", "app", "session", "needs", "route.ts"),
        join("src", "app", "session", "new", "route.ts"),
        join("src", "app", "session", "rotate", "route.ts"),
        join("src", "app", "session", "start", "route.ts"),
        join("src", "app", "shop", "needs", "confirm", "route.ts"),
        join("src", "app", "shop", "needs", "listings", "route.ts"),
        join("src", "app", "shop", "needs", "submit", "route.ts"),
        // M2-3: purchase permissions, mock only; PostgreSQL refuses them (503).
        join("src", "app", "shop", "permissions", "create", "route.ts"),
        join("src", "app", "shop", "permissions", "revoke", "route.ts"),
      ].sort(),
    );
    const mockOnly: Record<string, string> = {
      [join("src", "app", "session", "needs", "route.ts")]: "handleNeedsSession(request, runtime)",
      [join("src", "app", "shop", "needs", "submit", "route.ts")]: "handleNeedsSubmit(request, runtime)",
      [join("src", "app", "shop", "needs", "confirm", "route.ts")]: "handleNeedsConfirm(request, runtime)",
      [join("src", "app", "shop", "needs", "listings", "route.ts")]: "handleNeedsListings(request, runtime)",
      [join("src", "app", "demo", "admission", "submit", "route.ts")]: "handleDemoAdmissionSubmit(request, runtime)",
      [join("src", "app", "demo", "admission", "logout", "route.ts")]: "handleDemoAdmissionLogout(request, runtime)",
      [join("src", "app", "api", "extension", "v1", "pairings", "route.ts")]: "handleExtensionPairingStart(request, runtime)",
      [join("src", "app", "api", "extension", "v1", "pairings", "[pairingId]", "status", "route.ts")]: "handleExtensionPairingStatus(request, runtime, pairingId)",
      [join("src", "app", "api", "extension", "v1", "pairings", "[pairingId]", "exchange", "route.ts")]: "handleExtensionPairingExchange(request, runtime, pairingId)",
      [join("src", "app", "api", "extension", "v1", "conversation", "route.ts")]: "handleExtensionConversation(request, runtime)",
      [join("src", "app", "api", "extension", "v1", "conversation", "turns", "route.ts")]: "handleExtensionTurn(request, runtime)",
      [join("src", "app", "extension", "pair", "decide", "route.ts")]: "handleExtensionPairDecision(request, runtime)",
      [join("src", "app", "extension", "revoke", "route.ts")]: "handleExtensionRevoke(request, runtime)",
    };
    const sandboxRoutes: Record<string, string> = {
      [join("src", "app", "checkout", "[intentId]", "approve", "route.ts")]: "handleSandboxApprove(request, runtime, intentId)",
      [join("src", "app", "checkout", "[intentId]", "return", "route.ts")]: "handleSandboxReturn(request, runtime, intentId)",
      [join("src", "app", "checkout", "[intentId]", "paypal-cancel", "route.ts")]: "handleSandboxPaypalCancel(request, runtime, intentId)",
      [join("src", "app", "checkout", "[intentId]", "capture", "route.ts")]: "handleSandboxCapture(request, runtime, intentId)",
    };
    const shared: Record<string, [string, string]> = {
      [join("src", "app", "session", "start", "route.ts")]: ["handleSessionStart(request, runtime)", "handlePgSessionStart(request, services)"],
    };
    // M2-3: purchase permissions exist only in the mock; PostgreSQL mode answers 503, not 404.
    const pgPermissionsRefused: Record<string, string> = {
      [join("src", "app", "shop", "permissions", "create", "route.ts")]: "handlePermissionCreate(request, runtime)",
      [join("src", "app", "shop", "permissions", "revoke", "route.ts")]: "handlePermissionRevoke(request, runtime)",
    };
    // M2-3: PostgreSQL mode has no F07 purchase-permission enforcement, so its checkout steps are refused (fail closed).
    const pgCheckoutRefused: Record<string, string> = {
      [join("src", "app", "checkout", "start", "route.ts")]: "handleCheckoutStart(request, runtime)",
      [join("src", "app", "checkout", "[intentId]", "confirm", "route.ts")]: "handleConfirm(request, runtime, intentId)",
      [join("src", "app", "checkout", "[intentId]", "simulate", "route.ts")]: "handleSimulate(request, runtime, intentId)",
    };
    for (const route of routes) {
      const text = readFileSync(join(ROOT, route), "utf8");
      expect(text, route).toMatch(/withApplication\(\{/);
      const pair = shared[route];
      if (route.startsWith(join("src", "app", "checkout"))) expect(text, route).not.toMatch(/handlePg|pg-handlers/);
      if (pgPermissionsRefused[route]) {
        expect(text, route).toContain(`mock: (runtime) => ${pgPermissionsRefused[route]}`);
        expect(text, route).toContain("postgres: async () => pgPermissionsUnavailable()");
      } else if (pgCheckoutRefused[route]) {
        expect(text, route).toContain(`mock: (runtime) => ${pgCheckoutRefused[route]}`);
        expect(text, route).toContain("postgres: async () => pgCheckoutWithoutPermissions()");
      } else if (pair) {
        expect(text, route).toContain(`mock: (runtime) => ${pair[0]}`);
        expect(text, route).toContain(`postgres: (services) => ${pair[1]}`);
      } else if (mockOnly[route]) {
        expect(text, route).toContain(`mock: (runtime) => ${mockOnly[route]}`);
        expect(text, route).toContain("postgres: async () => mockRouteNotFound()");
      } else if (sandboxRoutes[route]) {
        expect(text, route).toContain(`runtime.paymentMode === "sandbox" ? ${sandboxRoutes[route]} : mockRouteNotFound()`);
        expect(text, route).toContain("postgres: () => mockRouteNotFound()");
      } else if (route === join("src", "app", "checkout", "[intentId]", "cancel", "route.ts")) {
        expect(text, route).toContain('runtime.paymentMode === "sandbox" ? handleSandboxCancel(request, runtime, intentId) : mockRouteNotFound()');
        expect(text, route).toContain("postgres: async () => pgCheckoutWithoutPermissions()");
      } else if (route === join("src", "app", "checkout", "[intentId]", "review", "route.ts")) {
        expect(text, route).toContain("mock: () => mockRouteNotFound()");
        expect(text, route).toContain("postgres: async () => pgCheckoutWithoutPermissions()");
      } else {
        expect(text, route).toContain("mock: () => mockRouteNotFound()");
        expect(text, route).not.toMatch(/@\/server\/handlers/);
      }
    }
  });

  it("A34: the simulated payment panel is rendered by the mock branch alone", () => {
    const page = read("app", "checkout", "[intentId]", "page.tsx");
    const postgres = page.slice(page.indexOf("async function PgCheckoutContent"), page.indexOf("async function CheckoutContent"));
    expect(postgres).not.toMatch(/SimulatedPaymentPanel|\/simulate/);
    expect(postgres).toContain("Payment simulation is not part of this mode");
    expect(page.slice(page.indexOf("async function CheckoutContent"))).toMatch(/<SimulatedPaymentPanel /);
  });

  it("the mode is read at request time on every page, so a page built for one mode is never served in another", () => {
    for (const parts of [["app", "page.tsx"], ["app", "shop", "page.tsx"], ["app", "checkout", "[intentId]", "page.tsx"], ["app", "checkouts", "page.tsx"], ["app", "demo", "admission", "page.tsx"]]) {
      const text = read(...parts);
      const connection = text.indexOf("await connection();");
      // M2-1: pages reach the process application only through openApplication (runtime-access.ts), after connection().
      const application = text.indexOf("await openApplication();");
      expect(connection, parts.join("/")).toBeGreaterThan(-1);
      expect(application, parts.join("/")).toBeGreaterThan(connection);
      expect(text, parts.join("/")).not.toMatch(/getApplication\(|getRuntime\(/);
    }
    expect(read("app", "shop", "needs", "page.tsx")).not.toMatch(/getApplication\(|getRuntime\(/);
    // In PostgreSQL mode the start page shows the database's catalog or the notice, never the fixture catalog.
    const home = read("app", "page.tsx");
    expect(home.match(/DEMO_MERCHANT_CATALOG/g)).toHaveLength(2);
    const mockBranch = home.slice(home.indexOf('if (application.mode === "mock")'), home.indexOf('if (application.mode === "invalid")'));
    expect(mockBranch).toContain("<GuidedLanguageChoice />");
    expect(mockBranch).toContain("<Storefront catalog={DEMO_MERCHANT_CATALOG} />");
    const postgresBranch = home.slice(home.indexOf("const catalog = await loadPgCatalog(services);"));
    expect(postgresBranch).not.toContain("GuidedLanguageChoice");
    expect(postgresBranch).not.toContain('action="/session/needs"');
    expect(postgresBranch).toContain("<Storefront catalog={catalog} />");
    // The owner list does not exist in the mock.
    expect(read("app", "checkouts", "page.tsx")).toMatch(/if \(application\.mode === "mock"\) notFound\(\);/);
  });

  it("states the timeout limitation as it is, and adds no race or timer that would abandon a call", () => {
    const runtime = read("server", "pg-runtime.ts");
    expect(runtime.replace(/\s*\n \* /g, " ")).toContain(
      "the approved statement_timeout bounds server-side SQL execution after the statement starts. The current pool configuration does not establish an end-to-end deadline for connection establishment or pool acquisition",
    );
    for (const name of ["pg-runtime.ts", "pg-handlers.ts", "pg-views.ts", "pg-request-guard.ts"]) {
      expect(read("server", name), name).not.toMatch(/Promise\.race|setTimeout|AbortController/);
    }
    for (const file of NEW_LIBRARY_MODULES) expect(readFileSync(file, "utf8"), relative(file)).not.toMatch(/Promise\.race|setTimeout|AbortController/);
  });

  it("the two notices and the checkout actions are plain forms posting to the guarded routes", () => {
    const notice = read("components", "SessionNotice.tsx");
    expect(notice).toContain('<form method="post" action="/session/new">');
    expect(notice).toContain('<form method="post" action="/session/rotate">');
    expect(notice).toContain("Checkouts from the earlier session will not transfer to the new one.");
    expect(notice).toMatch(/name="csrfToken" value=\{props\.csrfToken\}/);
    const actions = read("components", "CheckoutActions.tsx");
    expect(actions).toContain("action={`/checkout/${intentId}/review`}");
    expect(actions).toContain("action={`/checkout/${intentId}/cancel`}");
    expect(actions.match(/action="\/checkout\/start"/g)).toHaveLength(2);
    // Only the replacing quote names a predecessor; "start another" never does.
    expect(actions.match(/name="replaces"/g)).toHaveLength(1);
    for (const component of [notice, actions]) expect(component).not.toMatch(/onClick|onSubmit|use client|<a href/);
  });
});
