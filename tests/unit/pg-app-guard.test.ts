import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgQueryResult } from "@/lib/pg/client";
import type { ConfiguredKeyRings } from "@/lib/pg/key-ring";
import { APPLICATION_STATEMENTS, CHECKOUT_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { createSequentialIdGenerator } from "@/lib/shared/ids";
import { handlePgCancel, handlePgSessionNew, handlePgSessionRotate, handlePgSessionStart } from "@/server/pg-handlers";
import { authorizePgMutation, resolvePgSession, sessionCookiePresence, type PgRequestContext } from "@/server/pg-request-guard";
import { buildPgServices, parsePgRuntimeConfig, type PgServices } from "@/server/pg-runtime";
import { createTestClock } from "./helpers";

// NEVER RUN when written. Database-free: the "database" is the fake below. It answers the session statements of the
// reviewed catalogue from a small in-memory model; nothing here connects to PostgreSQL, and nothing the fake does
// is evidence of what PostgreSQL does. Acceptance cases are those of the Increment 2.3 plan (specification 19.19).

// Synthetic, test-only values.
const ORIGIN = "https://shop.example.test";
const SESSION_KEY_1 = Buffer.alloc(32, 41);
const SESSION_KEY_2 = Buffer.alloc(32, 42);
const NONCE_KEY = Buffer.alloc(32, 43);
const T0 = new Date("2026-10-08T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const TOKEN = /[A-Za-z0-9_-]{43}/;

type Row = Record<string, unknown>;
type Script = (values: readonly unknown[]) => Row[] | Promise<Row[]>;
type StatementName = keyof typeof SESSION_STATEMENTS | keyof typeof CHECKOUT_STATEMENTS | keyof typeof APPLICATION_STATEMENTS;

const STATEMENT_NAMES = new Map<string, string>(
  Object.entries({ ...SESSION_STATEMENTS, ...CHECKOUT_STATEMENTS, ...APPLICATION_STATEMENTS }).map(([name, text]) => [text, name]),
);

const expiries = () => ({ absolute_expires_at: new Date(T0.getTime() + 24 * HOUR), idle_expires_at: new Date(T0.getTime() + 2 * HOUR) });

/** Sessions and key versions as the web role's statements see them. One owner per session id. */
class SessionDatabase implements PgQueryable {
  readonly calls: Array<{ readonly name: string; readonly values: readonly unknown[] }> = [];
  readonly sessions = new Map<string, { id: string; keyVersion: number }>();
  /** The checkouts each session's owner has, by session id. Rows of list_owner_checkouts. */
  readonly checkoutsOf = new Map<string, Row[]>();
  /** Status of each session key version. */
  readonly sessionKeys = new Map<number, string>([[1, "ACTIVE"]]);
  private readonly scripts = new Map<string, Script>();

  constructor(private readonly rings: ConfiguredKeyRings) {
    this.on("readKeyVersions", ([purpose]) =>
      purpose === "session"
        ? [...this.sessionKeys].map(([version, status]) => ({ purpose: "session", key_version: version, status, check_value: this.rings.session.checkValue(version) }))
        : [{ purpose: "confirmation_nonce", key_version: 1, status: "ACTIVE", check_value: this.rings.confirmationNonce.checkValue(1) }],
    );
    this.on("admitSession", ([sessionId, keyVersion, tokenDigest]) => {
      if (this.sessionKeys.get(Number(keyVersion)) !== "ACTIVE") return [{ result: "KEY_NOT_ACTIVE", absolute_expires_at: null, idle_expires_at: null }];
      this.sessions.set(String(tokenDigest), { id: String(sessionId), keyVersion: Number(keyVersion) });
      return [{ result: "ADMITTED", ...expiries() }];
    });
    this.on("authorizeSession", ([keyVersion, tokenDigest]) => {
      const session = this.sessions.get(String(tokenDigest));
      const status = this.sessionKeys.get(Number(keyVersion));
      if (!session || session.keyVersion !== keyVersion || (status !== "ACTIVE" && status !== "VERIFY_ONLY")) {
        return [{ result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null, key_status: null }];
      }
      return [{ result: "AUTHORIZED", session_id: session.id, ...expiries(), key_status: status }];
    });
    this.on("rotateSession", ([keyVersion, tokenDigest, newKeyVersion, newTokenDigest]) => {
      const session = this.sessions.get(String(tokenDigest));
      if (!session || session.keyVersion !== keyVersion) return [{ result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null }];
      if (this.sessionKeys.get(Number(newKeyVersion)) !== "ACTIVE") return [{ result: "KEY_NOT_ACTIVE", session_id: null, absolute_expires_at: null, idle_expires_at: null }];
      this.sessions.delete(String(tokenDigest));
      this.sessions.set(String(newTokenDigest), { id: session.id, keyVersion: Number(newKeyVersion) });
      return [{ result: "ROTATED", session_id: session.id, ...expiries() }];
    });
    this.on("listOwnerCheckouts", ([, tokenDigest]) => this.checkoutsOf.get(this.sessions.get(String(tokenDigest))?.id ?? "") ?? []);
  }

  on(name: StatementName, script: Script): void {
    this.scripts.set(name, script);
  }

  async query<Result = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<PgQueryResult<Result>> {
    const name = STATEMENT_NAMES.get(text);
    if (name === undefined) throw new Error("a statement that is not in the reviewed catalogue was sent");
    this.calls.push({ name, values });
    const script = this.scripts.get(name);
    if (!script) throw new Error(`no script for ${name}`);
    return { rows: (await script(values)) as Result[] };
  }

  sent(name: StatementName): Array<readonly unknown[]> {
    return this.calls.filter((call) => call.name === name).map((call) => call.values);
  }
}

function world() {
  const time = createTestClock(T0.toISOString());
  const parsed = parsePgRuntimeConfig({
    SHOPACCESS_DATABASE_URL: "postgres://shopaccess_web@db.example.test:5432/shopaccess",
    SHOPACCESS_SESSION_KEYS: `1:${SESSION_KEY_1.toString("base64")},2:${SESSION_KEY_2.toString("base64")}`,
    SHOPACCESS_NONCE_KEYS: `1:${NONCE_KEY.toString("base64")}`,
    SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
    PAYMENT_PROVIDER_MODE: "mock",
  });
  if (!parsed.ok) throw new Error(`test configuration refused: ${parsed.error.join(",")}`);
  const db = new SessionDatabase(parsed.value.rings);
  const services = buildPgServices(db, parsed.value, { clock: time.clock, ids: createSequentialIdGenerator() });
  return { time, db, services };
}

const get = (path: string, cookie: string | null): Request => new Request(`${ORIGIN}${path}`, cookie === null ? {} : { headers: { cookie } });

function post(path: string, cookie: string | null, fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(cookie === null ? {} : { cookie }),
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

interface Shopper {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly context: PgRequestContext;
}

async function contextOf(services: PgServices, cookie: string): Promise<Shopper> {
  const state = await resolvePgSession(cookie, services.sessions);
  if (!state.context) throw new Error("the cookie is not an authorized session");
  return { cookie, csrfToken: state.context.session.csrfToken, context: state.context };
}

async function signIn(services: PgServices): Promise<Shopper> {
  const response = await handlePgSessionStart(get("/session/start", null), services);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie was set");
  return contextOf(services, setCookie.split(";")[0]);
}

const mockFormatCookie = `${SESSION_COOKIE_NAME}=${"A".repeat(43)}`;
const unusableCookies = (valid: Shopper): Array<[string, string]> => [
  ["the mock's format (a token and no version)", mockFormatCookie],
  ["an empty value", `${SESSION_COOKIE_NAME}=`],
  ["two dots", `${SESSION_COOKIE_NAME}=1.2.${"A".repeat(43)}`],
  ["a version with a leading zero", `${SESSION_COOKIE_NAME}=01.${"A".repeat(43)}`],
  ["a short token", `${SESSION_COOKIE_NAME}=1.${"A".repeat(42)}`],
  ["a version that is not configured", `${SESSION_COOKIE_NAME}=9.${"A".repeat(43)}`],
  ["the cookie twice", `${valid.cookie}; ${valid.cookie}`],
  ["a well-formed credential the database does not know", `${SESSION_COOKIE_NAME}=1.${"B".repeat(43)}`],
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PostgreSQL mode: whether the session cookie is present is decided apart from parsing it", () => {
  it("counts the cookie by its exact name, whatever its value", () => {
    for (const header of [null, undefined, "", "other=1", `x${SESSION_COOKIE_NAME}=1`, `${SESSION_COOKIE_NAME}x=1`, "theme=dark; lang=en"]) {
      expect(sessionCookiePresence(header), String(header)).toBe("ABSENT");
    }
    for (const header of [`${SESSION_COOKIE_NAME}=`, `${SESSION_COOKIE_NAME}=garbage`, mockFormatCookie, `a=b; ${SESSION_COOKIE_NAME}=1.x`, `${SESSION_COOKIE_NAME}=1; ${SESSION_COOKIE_NAME}=2`, ` ${SESSION_COOKIE_NAME} = 1`, SESSION_COOKIE_NAME]) {
      expect(sessionCookiePresence(header), header).toBe("PRESENT");
    }
  });
});

describe("PostgreSQL mode: request authorization (A1, A2, A3)", () => {
  it("A1: a cookie that is not exactly version.token, or names an unusable version, is no session: no authorize call, and never another version or format", async () => {
    const w = world();
    const valid = await signIn(w.services);
    const before = w.db.sent("authorizeSession").length;
    for (const [label, cookie] of unusableCookies(valid).slice(0, 7)) {
      const response = await handlePgSessionRotate(post("/session/rotate", cookie, { csrfToken: valid.csrfToken }), w.services);
      expect(response.status, label).toBe(403);
      expect((await response.json()).error.code, label).toBe("FORBIDDEN");
    }
    expect(w.db.sent("authorizeSession")).toHaveLength(before);

    // A well-formed credential the database refuses: exactly one call, under the presented version only.
    const refused = await handlePgSessionRotate(post("/session/rotate", `${SESSION_COOKIE_NAME}=1.${"B".repeat(43)}`, { csrfToken: valid.csrfToken }), w.services);
    expect(refused.status).toBe(403);
    expect(w.db.sent("authorizeSession").slice(before).map((values) => values[0])).toEqual([1]);

    // A version the database has revoked: the key state is read, and no credential is sent under it or any other.
    w.db.sessionKeys.set(1, "REVOKED");
    w.db.sessionKeys.set(2, "ACTIVE");
    const fresh = buildPgServices(w.db, (() => {
      const parsed = parsePgRuntimeConfig({
        SHOPACCESS_DATABASE_URL: "postgres://shopaccess_web@db.example.test:5432/shopaccess",
        SHOPACCESS_SESSION_KEYS: `1:${SESSION_KEY_1.toString("base64")},2:${SESSION_KEY_2.toString("base64")}`,
        SHOPACCESS_NONCE_KEYS: `1:${NONCE_KEY.toString("base64")}`,
        SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
        PAYMENT_PROVIDER_MODE: "mock",
      });
      if (!parsed.ok) throw new Error("test configuration refused");
      return parsed.value;
    })());
    const calls = w.db.sent("authorizeSession").length;
    const revoked = await handlePgSessionRotate(post("/session/rotate", valid.cookie, { csrfToken: valid.csrfToken }), fresh);
    expect(revoked.status).toBe(403);
    expect(w.db.sent("authorizeSession")).toHaveLength(calls);
  });

  it("A2: body, then provenance, then the cookie, then authorize_session, then the CSRF token; every authorization failure is the same refusal", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const mark = () => w.db.calls.length;
    const bodies: string[] = [];
    const refusedWith = async (label: string, request: Request, expectedCalls: string[]) => {
      const before = mark();
      const response = await handlePgSessionRotate(request, w.services);
      expect(response.status, label).toBe(403);
      expect(w.db.calls.slice(before).map((call) => call.name), label).toEqual(expectedCalls);
      const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };
      bodies.push(JSON.stringify({ code: body.error.code, message: body.error.message }));
    };

    // Not a form: refused before anything else is looked at.
    const before = mark();
    const notForm = await handlePgSessionRotate(new Request(`${ORIGIN}/session/rotate`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: shopper.cookie }, body: "{}" }), w.services);
    expect(notForm.status).toBe(400);
    expect(mark()).toBe(before);

    const fields = { csrfToken: shopper.csrfToken };
    await refusedWith("an untrusted origin", post("/session/rotate", shopper.cookie, fields, { origin: "https://elsewhere.example.test" }), []);
    await refusedWith("a cross-site request", post("/session/rotate", shopper.cookie, fields, { "sec-fetch-site": "cross-site" }), []);
    await refusedWith("no cookie", post("/session/rotate", null, fields), []);
    await refusedWith("a wrong CSRF token", post("/session/rotate", shopper.cookie, { csrfToken: "0".repeat(64) }), ["authorizeSession"]);
    await refusedWith("no CSRF token", post("/session/rotate", shopper.cookie, { other: "field" }), ["authorizeSession"]);
    expect(new Set(bodies).size).toBe(1);

    // The CSRF token may come in the header in place of the form field.
    const viaHeader = await authorizePgMutation(post("/session/rotate", shopper.cookie, { other: "field" }, { "x-csrf-token": shopper.csrfToken }), w.services, null);
    expect(viaHeader.ok).toBe(true);
    // Everything in order: the handler proceeds. The session is under the ACTIVE key, so nothing is rotated.
    const accepted = await handlePgSessionRotate(post("/session/rotate", shopper.cookie, fields), w.services);
    expect(accepted.status).toBe(303);
  });

  it("A3: the request context carries the credential the service bound to the session, and a look-alike session object has none", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const [admitted] = w.db.sent("admitSession");
    expect(shopper.context.credential).toEqual({ keyVersion: admitted[1], tokenDigest: admitted[2] });
    expect(w.db.sent("authorizeSession").at(-1)).toEqual([shopper.context.credential.keyVersion, shopper.context.credential.tokenDigest]);
    expect(Object.isFrozen(shopper.context)).toBe(true);
    expect(Object.isFrozen(shopper.context.credential)).toBe(true);
    expect(shopper.context.credential.tokenDigest).toMatch(/^[0-9a-f]{64}$/);

    // Only an object the service itself returned has a credential.
    expect(w.services.sessions.credentialOf({ ...shopper.context.session })).toBeNull();
    expect(w.services.sessions.credentialOf(shopper.context.session)).toEqual(shopper.context.credential);
    // The credential is not a property of the session object, and the cookie's token is not the digest.
    expect(JSON.stringify(shopper.context.session)).not.toContain(shopper.context.credential.tokenDigest);
    expect(shopper.cookie).not.toContain(shopper.context.credential.tokenDigest);
  });
});

describe("PostgreSQL mode: GET /session/start (A18, A40)", () => {
  it("A40: with no cookie at all a session is admitted once and the version.token cookie is set", async () => {
    const w = world();
    const response = await handlePgSessionStart(get("/session/start?use=programming&budget=900", null), w.services);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/shop?use=programming&budget=900&started=1");
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=1\\.${TOKEN.source}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=[0-9]+$`));
    expect(w.db.sent("admitSession")).toHaveLength(1);
    expect(w.db.sent("authorizeSession")).toEqual([]);
    // Without preferences the destination is the start page. Nothing from the request chooses it.
    const plain = await handlePgSessionStart(get("/session/start?next=https://elsewhere.example.test", null), w.services);
    expect(plain.headers.get("location")).toBe("/");
  });

  it("A18 and A40: a presented cookie that cannot be used is left as it is: no admission, no Set-Cookie, and the session-ended notice", async () => {
    const w = world();
    const valid = await signIn(w.services);
    const admitted = w.db.sent("admitSession").length;
    for (const [label, cookie] of unusableCookies(valid)) {
      const response = await handlePgSessionStart(get("/session/start?use=programming&budget=900", cookie), w.services);
      expect(response.status, label).toBe(303);
      expect(response.headers.get("location"), label).toBe("/?session=ended");
      expect(response.headers.get("set-cookie"), label).toBeNull();
    }
    expect(w.db.sent("admitSession")).toHaveLength(admitted);
  });

  it("A18: an authorized session continues unchanged, under the ACTIVE key and under a VERIFY_ONLY key; nothing is rotated on a GET", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const admitted = w.db.sent("admitSession").length;
    for (const status of ["ACTIVE", "VERIFY_ONLY"] as const) {
      w.db.sessionKeys.set(1, status);
      if (status === "VERIFY_ONLY") w.db.sessionKeys.set(2, "ACTIVE");
      const response = await handlePgSessionStart(get("/session/start?use=programming&budget=900", shopper.cookie), w.services);
      expect(response.status, status).toBe(303);
      expect(response.headers.get("location"), status).toBe("/shop?use=programming&budget=900&started=1");
      expect(response.headers.get("set-cookie"), status).toBeNull();
    }
    expect(w.db.sent("admitSession")).toHaveLength(admitted);
    expect(w.db.sent("rotateSession")).toEqual([]);
  });

  it("A18: a database error is 'not available' with the cookie untouched, and each admission refusal has its generic answer", async () => {
    const failing = world();
    const shopper = await signIn(failing.services);
    failing.db.on("authorizeSession", () => Promise.reject(new Error("connection lost")));
    const unavailable = await handlePgSessionStart(get("/session/start", shopper.cookie), failing.services);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("set-cookie")).toBeNull();

    for (const [result, status] of [["RATE_LIMITED", 429], ["AT_CAPACITY", 503], ["REFUSED", 503]] as const) {
      const w = world();
      w.db.on("admitSession", () => [{ result, absolute_expires_at: null, idle_expires_at: null }]);
      const response = await handlePgSessionStart(get("/session/start", null), w.services);
      expect(response.status, result).toBe(status);
      expect(response.headers.get("set-cookie"), result).toBeNull();
    }
  });
});

describe("PostgreSQL mode: POST /session/new, the explicit new session (A41)", () => {
  it("A41: an unusable cookie is replaced only by the cookie of an admitted session; a refusal sets nothing; a valid session is never replaced; nothing is revoked", async () => {
    const w = world();
    const admittedBefore = w.db.sent("admitSession").length;
    const response = await handlePgSessionNew(post("/session/new", mockFormatCookie, { intent: "new-session" }), w.services);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=1\\.${TOKEN.source}; `));
    expect(w.db.sent("admitSession")).toHaveLength(admittedBefore + 1);

    // A refusal: no cookie is sent, so the presented one stays.
    const refusing = world();
    refusing.db.on("admitSession", () => [{ result: "RATE_LIMITED", absolute_expires_at: null, idle_expires_at: null }]);
    const refused = await handlePgSessionNew(post("/session/new", mockFormatCookie, { intent: "new-session" }), refusing.services);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("set-cookie")).toBeNull();

    // A session that is in fact valid is given nothing new.
    const valid = await signIn(w.services);
    const admitted = w.db.sent("admitSession").length;
    const kept = await handlePgSessionNew(post("/session/new", valid.cookie, { intent: "new-session" }), w.services);
    expect(kept.status).toBe(303);
    expect(kept.headers.get("set-cookie")).toBeNull();
    expect(w.db.sent("admitSession")).toHaveLength(admitted);

    // Provenance is the guard: an untrusted origin and a cross-site request are refused with no database call.
    const calls = w.db.calls.length;
    expect((await handlePgSessionNew(post("/session/new", mockFormatCookie, { intent: "new-session" }, { origin: "https://elsewhere.example.test" }), w.services)).status).toBe(403);
    expect((await handlePgSessionNew(post("/session/new", mockFormatCookie, { intent: "new-session" }, { "sec-fetch-site": "cross-site" }), w.services)).status).toBe(403);
    expect(w.db.calls).toHaveLength(calls);
    expect(w.db.sent("revokeSession")).toEqual([]);
  });

  it("A41: a form rendered before the replacement is refused afterwards; a freshly rendered form works; the earlier owner's checkouts do not transfer", async () => {
    const w = world();
    const first = await signIn(w.services);
    const earlier = { intent_id: `ci_${"1".repeat(32)}`, purchase_group_id: `pur_${"2".repeat(32)}`, stored_state: "QUOTED", effective_status: "QUOTED", intent_created_at: T0, quote_expires_at: new Date(T0.getTime() + HOUR) };
    w.db.checkoutsOf.set(first.context.session.id, [earlier]);
    expect(await w.services.checkout.list(first.context.credential)).toHaveLength(1);

    // The first session's credential stops being usable (the database no longer knows it).
    w.db.sessions.delete(first.context.credential.tokenDigest);
    const replaced = await handlePgSessionNew(post("/session/new", first.cookie, { intent: "new-session" }), w.services);
    const setCookie = replaced.headers.get("set-cookie");
    if (!setCookie) throw new Error("the cookie was not replaced");
    const second = await contextOf(w.services, setCookie.split(";")[0]);
    expect(second.context.session.id).not.toBe(first.context.session.id);
    expect(second.csrfToken).not.toBe(first.csrfToken);

    // The old form: the new cookie with the old CSRF token. Refused at the CSRF check, before any checkout call.
    const before = w.db.calls.length;
    const stale = await handlePgCancel(post(`/checkout/${earlier.intent_id}/cancel`, second.cookie, { csrfToken: first.csrfToken }), w.services, earlier.intent_id);
    expect(stale.status).toBe(403);
    expect(w.db.calls.slice(before).map((call) => call.name)).toEqual(["authorizeSession"]);
    // The old cookie itself is no session any more.
    expect((await handlePgCancel(post(`/checkout/${earlier.intent_id}/cancel`, first.cookie, { csrfToken: first.csrfToken }), w.services, earlier.intent_id)).status).toBe(403);

    // A freshly rendered form of the new session passes the guard.
    const fresh = await handlePgSessionRotate(post("/session/rotate", second.cookie, { csrfToken: second.csrfToken }), w.services);
    expect(fresh.status).toBe(303);

    // The earlier owner's checkout is not listed for the new session, and is still where it was.
    expect(await w.services.checkout.list(second.context.credential)).toEqual([]);
    expect(w.db.checkoutsOf.get(first.context.session.id)).toEqual([earlier]);
  });
});

describe("PostgreSQL mode: POST /session/rotate, the only rotation (A19, A20)", () => {
  it("A19: a session under the ACTIVE key is left alone, with no rotation call and no cookie", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const response = await handlePgSessionRotate(post("/session/rotate", shopper.cookie, { csrfToken: shopper.csrfToken }), w.services);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(w.db.sent("rotateSession")).toEqual([]);
  });

  it("A19: a session under a VERIFY_ONLY key is rotated to the ACTIVE key: a new cookie, the same session and owner, and the old form refused until reloaded", async () => {
    const w = world();
    const earlier = await signIn(w.services);
    const listed = [{ intent_id: `ci_${"3".repeat(32)}`, purchase_group_id: `pur_${"4".repeat(32)}`, stored_state: "QUOTED", effective_status: "QUOTED", intent_created_at: T0, quote_expires_at: new Date(T0.getTime() + HOUR) }];
    w.db.checkoutsOf.set(earlier.context.session.id, listed);
    w.db.sessionKeys.set(1, "VERIFY_ONLY");
    w.db.sessionKeys.set(2, "ACTIVE");

    const shopper = await contextOf(w.services, earlier.cookie);
    expect(shopper.context.session.keyStatus).toBe("VERIFY_ONLY");
    const response = await handlePgSessionRotate(post("/session/rotate", shopper.cookie, { csrfToken: shopper.csrfToken }), w.services);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=2\\.${TOKEN.source}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=[0-9]+$`));
    if (!setCookie) throw new Error("no cookie");

    const rotated = await contextOf(w.services, setCookie.split(";")[0]);
    expect(rotated.context.session.id).toBe(earlier.context.session.id);
    expect(rotated.context.session.keyStatus).toBe("ACTIVE");
    expect(rotated.context.credential.keyVersion).toBe(2);
    expect(rotated.csrfToken).not.toBe(shopper.csrfToken);
    // The owner's checkouts are listed as before.
    expect((await w.services.checkout.list(rotated.context.credential)).map((item) => item.intentId)).toEqual([listed[0].intent_id]);

    // The old cookie is no session, and a form rendered before the rotation is refused with the new cookie.
    expect((await resolvePgSession(shopper.cookie, w.services.sessions)).context).toBeNull();
    const stale = await handlePgSessionRotate(post("/session/rotate", rotated.cookie, { csrfToken: shopper.csrfToken }), w.services);
    expect(stale.status).toBe(403);
    const reloaded = await handlePgSessionRotate(post("/session/rotate", rotated.cookie, { csrfToken: rotated.csrfToken }), w.services);
    expect(reloaded.status).toBe(303);
  });

  it("A3 and A19: the session object a rotation replaced has no credential afterwards", async () => {
    const w = world();
    const earlier = await signIn(w.services);
    w.db.sessionKeys.set(1, "VERIFY_ONLY");
    w.db.sessionKeys.set(2, "ACTIVE");
    const shopper = await contextOf(w.services, earlier.cookie);
    const rotated = await w.services.sessions.rotate(shopper.context.session, shopper.context.cookie);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(w.services.sessions.credentialOf(shopper.context.session)).toBeNull();
    expect(w.services.sessions.credentialOf(rotated.value.session)).toMatchObject({ keyVersion: 2 });
  });

  it("A19: a refused rotation and an unavailable key leave the cookie untouched", async () => {
    const refusing = world();
    const first = await signIn(refusing.services);
    refusing.db.sessionKeys.set(1, "VERIFY_ONLY");
    refusing.db.sessionKeys.set(2, "ACTIVE");
    refusing.db.on("rotateSession", () => [{ result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null }]);
    const shopper = await contextOf(refusing.services, first.cookie);
    const refused = await handlePgSessionRotate(post("/session/rotate", shopper.cookie, { csrfToken: shopper.csrfToken }), refusing.services);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();

    // No ACTIVE version at all: the rotation cannot name a key, and nothing is changed.
    const keyless = world();
    const second = await signIn(keyless.services);
    keyless.db.sessionKeys.set(1, "VERIFY_ONLY");
    const waiting = await contextOf(keyless.services, second.cookie);
    const unavailable = await handlePgSessionRotate(post("/session/rotate", waiting.cookie, { csrfToken: waiting.csrfToken }), keyless.services);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("set-cookie")).toBeNull();
    expect(keyless.db.sessions.has(waiting.context.credential.tokenDigest)).toBe(true);
  });

  it("A20: no GET sends a rotation, an admission for a presented cookie, or a checkout mutation", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    w.db.sessionKeys.set(1, "VERIFY_ONLY");
    w.db.sessionKeys.set(2, "ACTIVE");
    const before = w.db.calls.length;
    for (const [, cookie] of [["valid", shopper.cookie] as [string, string], ...unusableCookies(shopper)]) {
      await handlePgSessionStart(get("/session/start?use=programming&budget=900", cookie), w.services);
    }
    const sent = new Set(w.db.calls.slice(before).map((call) => call.name));
    for (const name of ["rotateSession", "admitSession", "revokeSession", "startCheckout", "cancelCheckout", "issueChallenge", "consumeChallenge"]) {
      expect(sent.has(name), name).toBe(false);
    }
  });
});

// Migration 0006: a refusal of a session entry point has every column after `result` NULL. The service refuses a
// refusal row that carries a value or lacks a column as a malformed answer. Through the application that is "not
// available", never the ordinary refusal and never a new session.
describe("PostgreSQL mode: a session refusal carries nothing, and one that does is a malformed answer", () => {
  const MALFORMED = "Entry point returned a refusal that is not empty";
  const carried: Row = { session_id: `ses_${"1".repeat(32)}`, absolute_expires_at: new Date(T0.getTime() + 24 * HOUR), idle_expires_at: new Date(T0.getTime() + 2 * HOUR), key_status: "ACTIVE" };
  /** The refusal row with one column carrying a value, or with that column left out. */
  const shaped = (result: string, columns: readonly string[], column: string, shape: "carried" | "missing"): Row => {
    const row: Row = { result };
    for (const name of columns) row[name] = null;
    if (shape === "carried") row[column] = carried[column];
    else delete row[column];
    return row;
  };
  const SHAPES = ["carried", "missing"] as const;

  it("admit_session: RATE_LIMITED, AT_CAPACITY, KEY_NOT_ACTIVE and REFUSED must have both expiry columns NULL", async () => {
    const columns = ["absolute_expires_at", "idle_expires_at"];
    // The valid, empty refusals keep their meaning.
    for (const [result, error] of [["RATE_LIMITED", "RATE_LIMITED"], ["AT_CAPACITY", "AT_CAPACITY"], ["REFUSED", "REFUSED"], ["KEY_NOT_ACTIVE", "KEY_UNAVAILABLE"]] as const) {
      const w = world();
      w.db.on("admitSession", () => [{ result, absolute_expires_at: null, idle_expires_at: null }]);
      expect(await w.services.sessions.establish(null), result).toEqual({ ok: false, error });
    }
    for (const result of ["RATE_LIMITED", "AT_CAPACITY", "KEY_NOT_ACTIVE", "REFUSED"]) {
      for (const column of columns) {
        for (const shape of SHAPES) {
          const label = `${result}: ${column} ${shape}`;
          const w = world();
          w.db.on("admitSession", () => [shaped(result, columns, column, shape)]);
          await expect(w.services.sessions.establish(null), label).rejects.toThrow(MALFORMED);
          // One call: a malformed answer is not asked for again.
          expect(w.db.sent("admitSession"), label).toHaveLength(1);
          const response = await handlePgSessionStart(get("/session/start", null), w.services);
          expect(response.status, label).toBe(503);
          expect(response.headers.get("set-cookie"), label).toBeNull();
        }
      }
    }
  });

  it("authorize_session: NOT_AUTHORIZED must have the session id, both expiries and the key status NULL", async () => {
    const columns = ["session_id", "absolute_expires_at", "idle_expires_at", "key_status"];
    for (const column of columns) {
      for (const shape of SHAPES) {
        const label = `${column} ${shape}`;
        const w = world();
        const shopper = await signIn(w.services);
        w.db.on("authorizeSession", () => [shaped("NOT_AUTHORIZED", columns, column, shape)]);
        await expect(resolvePgSession(shopper.cookie, w.services.sessions), label).rejects.toThrow(MALFORMED);
        // A state-changing request: "not available", not the ordinary 403, and nothing follows.
        const before = w.db.calls.length;
        const posted = await handlePgSessionRotate(post("/session/rotate", shopper.cookie, { csrfToken: shopper.csrfToken }), w.services);
        expect(posted.status, label).toBe(503);
        expect(w.db.calls.slice(before).map((call) => call.name), label).toEqual(["authorizeSession"]);
        // The session start: "not available", no admission and no cookie.
        const admitted = w.db.sent("admitSession").length;
        const started = await handlePgSessionStart(get("/session/start", shopper.cookie), w.services);
        expect(started.status, label).toBe(503);
        expect(started.headers.get("set-cookie"), label).toBeNull();
        expect(w.db.sent("admitSession"), label).toHaveLength(admitted);
      }
    }
    // The valid, empty refusal is the ordinary "no session".
    const w = world();
    const shopper = await signIn(w.services);
    w.db.on("authorizeSession", () => [{ result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null, key_status: null }]);
    expect(await resolvePgSession(shopper.cookie, w.services.sessions)).toEqual({ presence: "PRESENT", context: null });
    expect((await handlePgSessionRotate(post("/session/rotate", shopper.cookie, { csrfToken: shopper.csrfToken }), w.services)).status).toBe(403);
  });

  it("rotate_session: NOT_AUTHORIZED and KEY_NOT_ACTIVE must have the session id and both expiries NULL", async () => {
    const columns = ["session_id", "absolute_expires_at", "idle_expires_at"];
    const verifyOnly = async () => {
      const w = world();
      const earlier = await signIn(w.services);
      w.db.sessionKeys.set(1, "VERIFY_ONLY");
      w.db.sessionKeys.set(2, "ACTIVE");
      const shopper = await contextOf(w.services, earlier.cookie);
      return { w, shopper };
    };
    // The valid, empty refusals keep their meaning, and the cookie is untouched.
    for (const [result, error, status] of [["NOT_AUTHORIZED", "NOT_AUTHORIZED", 403], ["KEY_NOT_ACTIVE", "KEY_UNAVAILABLE", 503]] as const) {
      const { w, shopper } = await verifyOnly();
      w.db.on("rotateSession", () => [{ result, session_id: null, absolute_expires_at: null, idle_expires_at: null }]);
      expect(await w.services.sessions.rotate(shopper.context.session, shopper.context.cookie), result).toEqual({ ok: false, error });
      const again = await verifyOnly();
      again.w.db.on("rotateSession", () => [{ result, session_id: null, absolute_expires_at: null, idle_expires_at: null }]);
      const response = await handlePgSessionRotate(post("/session/rotate", again.shopper.cookie, { csrfToken: again.shopper.csrfToken }), again.w.services);
      expect(response.status, result).toBe(status);
      expect(response.headers.get("set-cookie"), result).toBeNull();
    }
    for (const result of ["NOT_AUTHORIZED", "KEY_NOT_ACTIVE"]) {
      for (const column of columns) {
        for (const shape of SHAPES) {
          const label = `${result}: ${column} ${shape}`;
          const { w, shopper } = await verifyOnly();
          w.db.on("rotateSession", () => [shaped(result, columns, column, shape)]);
          await expect(w.services.sessions.rotate(shopper.context.session, shopper.context.cookie), label).rejects.toThrow(MALFORMED);
          expect(w.db.sent("rotateSession"), label).toHaveLength(1);
          // The session object keeps its credential: nothing was rotated.
          expect(w.services.sessions.credentialOf(shopper.context.session), label).toEqual(shopper.context.credential);

          const again = await verifyOnly();
          again.w.db.on("rotateSession", () => [shaped(result, columns, column, shape)]);
          const response = await handlePgSessionRotate(post("/session/rotate", again.shopper.cookie, { csrfToken: again.shopper.csrfToken }), again.w.services);
          expect(response.status, label).toBe(503);
          expect(response.headers.get("set-cookie"), label).toBeNull();
          expect(again.w.db.sessions.has(again.shopper.context.credential.tokenDigest), label).toBe(true);
        }
      }
    }
  });
});
