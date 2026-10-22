import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdmissionScreen, DEMO_ADMISSION_RETRY_ID, DEMO_PASSPHRASE_REFUSAL_ID } from "@/app/[lang]/demo/admission/admission-screen";
import { startCheckout } from "@/lib/checkout/service";
import { MAX_JSON_BODY_BYTES } from "@/lib/security/limits";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { SESSION_IDLE_TIMEOUT_MS } from "@/lib/session/service";
import { needsDraftsFor } from "@/lib/session/store";
import { hmacSha256Hex } from "@/lib/shared/crypto";
import { ADVISORY_BUDGET_SLOTS } from "@/server/advisory-budget";
import {
  ADMISSION_COOKIE_NAME,
  ADMISSION_LABEL,
  ADMISSION_LIFETIME_MS,
  CSRF_COOKIE_NAME,
  CSRF_LABEL,
  CSRF_LIFETIME_MS,
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_WINDOW_MS,
  admissionScreen,
  handleDemoAdmissionLogout,
  handleDemoAdmissionSubmit,
  issuePurposeCookie,
  protectedAdmissionLocation,
  readPurposeCookie,
  resolveDemoAdmission,
  verifyPurposeCookie,
  type DemoAdmission,
} from "@/server/demo-admission";
import {
  handleCheckoutStart,
  handleConfirm,
  handleNeedsConfirm,
  handleNeedsSession,
  handleNeedsSubmit,
  handleSessionStart,
  handleSimulate,
} from "@/server/handlers";
import { getApplication, createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

const ORIGIN = "https://shop.example.test";
const ADMISSION_KEY = Buffer.alloc(32, 9);
const OTHER_KEY = Buffer.alloc(32, 11);
const PASSPHRASE = "test-passphrase-value";
const APPLICATION_KEY = Symbol.for("shopaccess.application");

const MANAGED = [
  "SHOPACCESS_PERSISTENCE_MODE",
  "SHOPACCESS_SESSION_KEY",
  "SHOPACCESS_TRUSTED_ORIGINS",
  "PAYMENT_PROVIDER_MODE",
  "SHOPACCESS_DEMO_ADMISSION",
  "SHOPACCESS_DEMO_ADMISSION_KEY",
  "SHOPACCESS_DEMO_PASSPHRASE",
  "SHOPACCESS_DATABASE_URL",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of MANAGED) saved[name] = process.env[name];
});

afterEach(() => {
  for (const name of MANAGED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[APPLICATION_KEY];
});

function onAdmission(key: Buffer = ADMISSION_KEY, passphrase = PASSPHRASE): Extract<DemoAdmission, { mode: "on" }> {
  const admission = resolveDemoAdmission(
    {
      NODE_ENV: "production",
      SHOPACCESS_DEMO_ADMISSION: "on",
      SHOPACCESS_DEMO_ADMISSION_KEY: key.toString("base64"),
      SHOPACCESS_DEMO_PASSPHRASE: passphrase,
    },
    TEST_SESSION_KEY,
  );
  if (admission.mode !== "on") throw new Error("admission did not turn on");
  return admission;
}

function openedRuntime(key: Buffer = ADMISSION_KEY) {
  const time = createTestClock();
  const admission = onAdmission(key);
  const runtime = createRuntime(
    { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) },
    { clock: time.clock, admission },
  );
  return { time, runtime, admission };
}

function installMockEnv(extra: Record<string, string | undefined> = {}) {
  process.env.SHOPACCESS_SESSION_KEY = TEST_SESSION_KEY.toString("base64");
  process.env.SHOPACCESS_TRUSTED_ORIGINS = ORIGIN;
  process.env.PAYMENT_PROVIDER_MODE = "mock";
  delete process.env.SHOPACCESS_PERSISTENCE_MODE;
  delete process.env.SHOPACCESS_DEMO_ADMISSION;
  delete process.env.SHOPACCESS_DEMO_ADMISSION_KEY;
  delete process.env.SHOPACCESS_DEMO_PASSPHRASE;
  delete process.env.SHOPACCESS_DATABASE_URL;
  for (const [name, value] of Object.entries(extra)) {
    if (name === "NODE_ENV") {
      vi.stubEnv("NODE_ENV", value);
      continue;
    }
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete (globalThis as Record<symbol, unknown>)[APPLICATION_KEY];
}

function submit(path: string, fields: Record<string, string>, cookie?: string, extra?: Record<string, string>): Request {
  const headers = new Headers({
    origin: ORIGIN,
    "content-type": "application/x-www-form-urlencoded",
    "sec-fetch-site": "same-origin",
    ...extra,
  });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: new URLSearchParams(fields) });
}

function cookieValue(setCookie: string, name: string): string {
  const pair = setCookie.split(";")[0];
  expect(pair.startsWith(`${name}=`)).toBe(true);
  return pair.slice(name.length + 1);
}

async function bootstrap(runtime: Runtime, lang = "en"): Promise<string> {
  const response = await handleDemoAdmissionSubmit(submit("/demo/admission/submit", { lang }), runtime);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`/${lang}/demo/admission`);
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toContain("HttpOnly");
  expect(cookies[0]).toContain("Secure");
  expect(cookies[0]).toContain("SameSite=Lax");
  expect(cookies[0]).toContain("Path=/");
  expect(cookies[0]).toContain("Max-Age=600");
  expect(cookies[0].includes("Domain=")).toBe(false);
  return cookieValue(cookies[0], CSRF_COOKIE_NAME);
}

function assertDescriptionReferencesExist(markup: string): void {
  const referenced = [...markup.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((match) =>
    match[1].split(" ").filter((id) => id.length > 0),
  );
  for (const id of referenced) {
    expect(markup.match(new RegExp(`\\bid="${id}"`, "g")), id).toHaveLength(1);
  }
}

describe("demo admission", () => {
  it("keeps the local development flow when admission is unset and leaves direct runtimes off", async () => {
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) });
    expect(runtime.admission.mode).toBe("off");
    const started = await handleNeedsSession(new Request(`${ORIGIN}/session/needs?lang=es`), runtime);
    expect(started.status).toBe(303);
    expect(started.headers.get("location")).toBe("/es/shop/needs?started=1");
    expect(started.headers.get("set-cookie")?.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect((await handleDemoAdmissionSubmit(submit("/demo/admission/submit", { lang: "en" }), runtime)).status).toBe(404);
    expect((await handleDemoAdmissionLogout(submit("/demo/admission/logout", { lang: "en" }), runtime)).status).toBe(404);
    expect(admissionScreen(runtime.admission, null, runtime.clock().getTime(), "en", null)).toBe("not-found");

    installMockEnv({ NODE_ENV: "development" });
    const application = getApplication();
    expect(application.mode).toBe("mock");
    if (application.mode !== "mock" || !application.runtime.ok) throw new Error("development runtime was not built");
    expect(application.runtime.value.admission.mode).toBe("off");
    const fromProcess = await handleSessionStart(new Request(`${ORIGIN}/session/start`), application.runtime.value);
    expect(fromProcess.status).toBe(303);
    expect(fromProcess.headers.get("location")).toBe("/");
    expect(fromProcess.headers.get("set-cookie")?.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  });

  it("fails closed for omitted or invalid production admission without creating a session", async () => {
    const cases: Record<string, string | undefined>[] = [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", SHOPACCESS_DEMO_ADMISSION: "off" },
      { NODE_ENV: "production", SHOPACCESS_DEMO_ADMISSION: "" },
      { NODE_ENV: undefined },
      {
        NODE_ENV: "production",
        SHOPACCESS_DEMO_ADMISSION: "on",
        SHOPACCESS_DEMO_ADMISSION_KEY: ADMISSION_KEY.toString("base64"),
        SHOPACCESS_DEMO_PASSPHRASE: "nineteen-byte-pass!",
      },
      {
        NODE_ENV: "development",
        SHOPACCESS_DEMO_ADMISSION: "on",
        SHOPACCESS_DEMO_PASSPHRASE: PASSPHRASE,
      },
      {
        NODE_ENV: "production",
        SHOPACCESS_DEMO_ADMISSION: "on",
        SHOPACCESS_DEMO_ADMISSION_KEY: TEST_SESSION_KEY.toString("base64"),
        SHOPACCESS_DEMO_PASSPHRASE: PASSPHRASE,
      },
    ];
    for (const extra of cases) {
      installMockEnv(extra);
      const application = getApplication();
      expect(application.mode, JSON.stringify(extra.NODE_ENV)).toBe("mock");
      if (application.mode !== "mock" || !application.runtime.ok) throw new Error("closed runtime was not built");
      expect(application.runtime.value.admission.mode).toBe("closed");
      const needs = await handleNeedsSession(new Request(`${ORIGIN}/session/needs?lang=es`), application.runtime.value);
      const start = await handleSessionStart(new Request(`${ORIGIN}/session/start?lang=https://evil.example`), application.runtime.value);
      expect(needs.status).toBe(303);
      expect(needs.headers.get("location")).toBe("/es/demo/admission");
      expect(needs.headers.get("set-cookie")).toBeNull();
      expect(start.status).toBe(303);
      expect(start.headers.get("location")).toBe("/en/demo/admission");
      expect(start.headers.get("location")?.includes("evil.example")).toBe(false);
      expect(start.headers.get("set-cookie")).toBeNull();
      delete (globalThis as Record<symbol, unknown>)[APPLICATION_KEY];
    }
  });

  it("refuses admission combined with PostgreSQL and leaves PostgreSQL unchanged when the setting is absent", () => {
    installMockEnv({ NODE_ENV: "production", SHOPACCESS_PERSISTENCE_MODE: "postgres", SHOPACCESS_DEMO_ADMISSION: "on" });
    expect(getApplication()).toEqual({ mode: "mock", runtime: { ok: false, error: ["DEMO_ADMISSION_UNSUPPORTED"] } });

    installMockEnv({ NODE_ENV: "production", SHOPACCESS_PERSISTENCE_MODE: "postgres" });
    expect(getApplication().mode).toBe("postgres");
    expect(ADVISORY_BUDGET_SLOTS).toBe(2);
  });

  it("issues the CSRF cookie only from the submit response and admits only a later matching passphrase", async () => {
    const { runtime, admission } = openedRuntime();
    expect(admission.attempts.count).toBe(0);
    const csrf = await bootstrap(runtime, "es");
    expect(admission.attempts.count).toBe(0);
    expect(runtime.clock().getTime().toString().startsWith("0")).toBe(false);

    const mismatched = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "es", demoCsrf: "not-the-token", passphrase: PASSPHRASE }, `${CSRF_COOKIE_NAME}=${csrf}`),
      runtime,
    );
    expect(mismatched.headers.get("location")).toBe("/es/demo/admission");
    expect(admission.attempts.count).toBe(0);
    const rotated = cookieValue(mismatched.headers.getSetCookie()[0], CSRF_COOKIE_NAME);
    expect(rotated).not.toBe(csrf);
    expect(mismatched.headers.get("location")?.includes(PASSPHRASE)).toBe(false);

    const missingPassphrase = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "es", demoCsrf: rotated }, `${CSRF_COOKIE_NAME}=${rotated}`),
      runtime,
    );
    expect(missingPassphrase.headers.get("location")).toBe("/es/demo/admission");
    expect(missingPassphrase.headers.getSetCookie()).toEqual([]);
    expect(admission.attempts.count).toBe(0);

    const wrong = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "not-a-language", demoCsrf: rotated, passphrase: "wrong-passphrase-value" }, `${CSRF_COOKIE_NAME}=${rotated}`),
      runtime,
    );
    expect(wrong.headers.get("location")).toBe("/en/demo/admission?notice=rejected");
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect(admission.attempts.count).toBe(1);

    const accepted = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "es", demoCsrf: rotated, passphrase: PASSPHRASE }, `${CSRF_COOKIE_NAME}=${rotated}`),
      runtime,
    );
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/?lang=es");
    const admissionCookie = cookieValue(accepted.headers.getSetCookie()[0], ADMISSION_COOKIE_NAME);
    expect(accepted.headers.getSetCookie()[0]).toContain("Max-Age=28800");
    expect(accepted.headers.get("location")?.includes(PASSPHRASE)).toBe(false);
    expect(admission.attempts.count).toBe(2);
    expect(verifyPurposeCookie(admissionCookie, ADMISSION_KEY, runtime.clock().getTime(), ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(true);
    expect(verifyPurposeCookie(admissionCookie, ADMISSION_KEY, runtime.clock().getTime(), ADMISSION_LIFETIME_MS, CSRF_LABEL)).toBe(false);
    expect(verifyPurposeCookie(rotated, ADMISSION_KEY, runtime.clock().getTime(), CSRF_LIFETIME_MS, ADMISSION_LABEL)).toBe(false);
  });

  it("rejects a request whose origin or fetch site is not trusted before any attempt is counted", async () => {
    const { runtime, admission } = openedRuntime();
    const noOrigin = new Request(`${ORIGIN}/demo/admission/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ lang: "es", passphrase: PASSPHRASE }),
    });
    const missing = await handleDemoAdmissionSubmit(noOrigin, runtime);
    expect(missing.headers.get("location")).toBe("/en/demo/admission");
    expect(missing.headers.getSetCookie()).toEqual([]);
    expect(admission.attempts.count).toBe(0);

    const crossSite = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "es", passphrase: PASSPHRASE }, undefined, { "sec-fetch-site": "cross-site" }),
      runtime,
    );
    expect(crossSite.headers.getSetCookie()).toEqual([]);
    expect(admission.attempts.count).toBe(0);
  });

  it("rejects tampered, expired, duplicate and cross-purpose cookies", () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    const issued = issuePurposeCookie(ADMISSION_KEY, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL);
    const csrf = issuePurposeCookie(ADMISSION_KEY, now, CSRF_LIFETIME_MS, CSRF_LABEL);
    expect(verifyPurposeCookie(issued.value, ADMISSION_KEY, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(true);
    expect(verifyPurposeCookie(issued.value, ADMISSION_KEY, now, ADMISSION_LIFETIME_MS, CSRF_LABEL)).toBe(false);
    expect(verifyPurposeCookie(csrf.value, ADMISSION_KEY, now, CSRF_LIFETIME_MS, ADMISSION_LABEL)).toBe(false);
    expect(verifyPurposeCookie(issued.value, OTHER_KEY, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(false);

    const mac = issued.value.slice(-64);
    const flipped = `${issued.value.slice(0, -64)}${mac.endsWith("a") ? mac.slice(0, -1) + "b" : mac.slice(0, -1) + "a"}`;
    expect(verifyPurposeCookie(flipped, ADMISSION_KEY, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(false);
    expect(verifyPurposeCookie(`${issued.value.slice(0, -64)}${mac.toUpperCase()}`, ADMISSION_KEY, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(false);

    const [version, expiry, nonce] = issued.value.split(".");
    expect(verifyPurposeCookie(`${version}.0${expiry}.${nonce}.${mac}`, ADMISSION_KEY, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(false);
    expect(verifyPurposeCookie(issued.value, ADMISSION_KEY, now + ADMISSION_LIFETIME_MS, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(false);
    expect(verifyPurposeCookie(issued.value, ADMISSION_KEY, now + ADMISSION_LIFETIME_MS - 1, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(true);

    const tooFar = now + ADMISSION_LIFETIME_MS + 1;
    const farPayload = `v1.${tooFar}.${nonce}`;
    const farMac = hmacSha256Hex(ADMISSION_KEY, ADMISSION_LABEL, farPayload);
    expect(verifyPurposeCookie(`${farPayload}.${farMac}`, ADMISSION_KEY, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(false);
    const exactNow = `v1.${now}.${nonce}`;
    expect(verifyPurposeCookie(`${exactNow}.${hmacSha256Hex(ADMISSION_KEY, ADMISSION_LABEL, exactNow)}`, ADMISSION_KEY, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)).toBe(false);

    const header = `${ADMISSION_COOKIE_NAME}=${issued.value}; ${ADMISSION_COOKIE_NAME}=${issued.value}`;
    expect(readPurposeCookie(header, ADMISSION_COOKIE_NAME)).toBeNull();
    expect(protectedAdmissionLocation(onAdmission(), header, now, "en")).toBe("/en/demo/admission");
    expect(protectedAdmissionLocation(onAdmission(), `${ADMISSION_COOKIE_NAME}=${csrf.value}`, now, "es")).toBe("/es/demo/admission");
    expect(protectedAdmissionLocation(onAdmission(), `${ADMISSION_COOKIE_NAME}=${issued.value}`, now, "es")).toBeNull();
  });

  it("counts every verification, including successes, and opens a new window on the boundary", async () => {
    const { runtime, admission, time } = openedRuntime();
    const csrf = await bootstrap(runtime, "en");
    expect(admission.attempts.count).toBe(0);
    const cookie = `${CSRF_COOKIE_NAME}=${csrf}`;
    for (let attempt = 1; attempt <= LOGIN_ATTEMPT_LIMIT; attempt += 1) {
      const response = await handleDemoAdmissionSubmit(
        submit("/demo/admission/submit", { lang: "en", demoCsrf: csrf, passphrase: PASSPHRASE }, cookie),
        runtime,
      );
      expect(response.headers.get("location")).toBe("/?lang=en");
      expect(response.headers.getSetCookie()[0]?.startsWith(`${ADMISSION_COOKIE_NAME}=`)).toBe(true);
    }
    const blocked = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "en", demoCsrf: csrf, passphrase: PASSPHRASE }, cookie),
      runtime,
    );
    expect(blocked.headers.get("location")).toBe("/en/demo/admission?notice=retry");
    expect(blocked.headers.getSetCookie()).toEqual([]);
    expect(admission.attempts.count).toBe(LOGIN_ATTEMPT_LIMIT + 1);

    time.advance(LOGIN_WINDOW_MS - 1);
    const reissued = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "en", demoCsrf: csrf, passphrase: PASSPHRASE }, cookie),
      runtime,
    );
    expect(reissued.headers.get("location")).toBe("/en/demo/admission");
    expect(admission.attempts.count).toBe(LOGIN_ATTEMPT_LIMIT + 1);
    const fresh = cookieValue(reissued.headers.getSetCookie()[0], CSRF_COOKIE_NAME);
    const stillBlocked = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "en", demoCsrf: fresh, passphrase: PASSPHRASE }, `${CSRF_COOKIE_NAME}=${fresh}`),
      runtime,
    );
    expect(stillBlocked.headers.get("location")).toBe("/en/demo/admission?notice=retry");
    expect(admission.attempts.count).toBe(LOGIN_ATTEMPT_LIMIT + 2);
    time.advance(1);
    const renewed = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "en", demoCsrf: fresh, passphrase: PASSPHRASE }, `${CSRF_COOKIE_NAME}=${fresh}`),
      runtime,
    );
    expect(renewed.headers.get("location")).toBe("/?lang=en");
    expect(admission.attempts.count).toBe(1);
    expect(admission.attempts.windowStartedAt).toBe(runtime.clock().getTime());
  });

  it("does not count a CSRF bootstrap, an empty oversized body, or a missing passphrase, and does count an empty passphrase", async () => {
    const { runtime, admission } = openedRuntime();
    await bootstrap(runtime);
    const csrf = await bootstrap(runtime);
    const oversized = new Request(`${ORIGIN}/demo/admission/submit`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
      body: `passphrase=${"a".repeat(MAX_JSON_BODY_BYTES)}`,
    });
    const tooLarge = await handleDemoAdmissionSubmit(oversized, runtime);
    expect(tooLarge.headers.get("location")).toBe("/en/demo/admission");
    expect(tooLarge.headers.getSetCookie()).toEqual([]);
    expect(admission.attempts.count).toBe(0);

    const empty = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "en", demoCsrf: csrf, passphrase: "" }, `${CSRF_COOKIE_NAME}=${csrf}`),
      runtime,
    );
    expect(empty.headers.get("location")).toBe("/en/demo/admission?notice=rejected");
    expect(admission.attempts.count).toBe(1);
  });

  it("revokes the shopper session on logout and does not reset the attempt window", async () => {
    const { runtime, admission } = openedRuntime();
    const csrf = await bootstrap(runtime, "es");
    const admitted = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "es", demoCsrf: csrf, passphrase: PASSPHRASE }, `${CSRF_COOKIE_NAME}=${csrf}`),
      runtime,
    );
    const admissionCookie = cookieValue(admitted.headers.getSetCookie()[0], ADMISSION_COOKIE_NAME);
    const planted = await runtime.sessions.establish(null);
    if (!planted.ok || !planted.value.issuedToken) throw new Error("session was not planted");
    const cookie = `${CSRF_COOKIE_NAME}=${csrf}; ${ADMISSION_COOKIE_NAME}=${admissionCookie}; ${SESSION_COOKIE_NAME}=${planted.value.issuedToken}`;
    const loggedOut = await handleDemoAdmissionLogout(submit("/demo/admission/logout", { lang: "es", demoCsrf: csrf }, cookie), runtime);
    expect(loggedOut.headers.get("location")).toBe("/es/demo/admission");
    const cleared = loggedOut.headers.getSetCookie();
    expect(cleared).toHaveLength(3);
    expect(cleared.every((cookie) => cookie.includes("Max-Age=0") && cookie.includes("HttpOnly") && !cookie.includes("Domain="))).toBe(true);
    const revoked = await runtime.sessions.resolve(planted.value.issuedToken);
    if (revoked.ok) throw new Error("session was not revoked");
    expect(revoked.error).toBe("SESSION_REVOKED");
    expect(admission.attempts.count).toBe(1);

    const refused = await handleDemoAdmissionLogout(
      submit("/demo/admission/logout", { lang: "es", demoCsrf: "other" }, cookie),
      runtime,
    );
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(admission.attempts.count).toBe(1);
  });

  it("rejects a cookie after the admission key changes", async () => {
    const first = openedRuntime(ADMISSION_KEY);
    const csrf = await bootstrap(first.runtime, "en");
    const admitted = await handleDemoAdmissionSubmit(
      submit("/demo/admission/submit", { lang: "en", demoCsrf: csrf, passphrase: PASSPHRASE }, `${CSRF_COOKIE_NAME}=${csrf}`),
      first.runtime,
    );
    const admissionCookie = cookieValue(admitted.headers.getSetCookie()[0], ADMISSION_COOKIE_NAME);
    const second = openedRuntime(OTHER_KEY);
    const header = `${ADMISSION_COOKIE_NAME}=${admissionCookie}`;
    expect(protectedAdmissionLocation(second.runtime.admission, header, second.runtime.clock().getTime(), "en")).toBe("/en/demo/admission");
    const response = await handleSessionStart(new Request(`${ORIGIN}/session/start`, { headers: { cookie: header } }), second.runtime);
    expect(response.headers.get("location")).toBe("/en/demo/admission");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses every protected route before session, draft or checkout state changes", async () => {
    const calls: Array<(runtime: Runtime, cookie: string) => Promise<Response>> = [
      (runtime, cookie) => handleSessionStart(new Request(`${ORIGIN}/session/start?lang=es`, { headers: { cookie } }), runtime),
      (runtime, cookie) => handleNeedsSession(new Request(`${ORIGIN}/session/needs?lang=es`, { headers: { cookie } }), runtime),
      (runtime, cookie) => handleNeedsSubmit(submit("/shop/needs/submit?lang=es", { use: "schoolwork", budget: "500", shopperText: "school", csrfToken: "x" }, cookie), runtime),
      (runtime, cookie) => handleNeedsConfirm(submit("/shop/needs/confirm?lang=es", { use: "schoolwork", budget: "500", draftId: "nd_" + "ab".repeat(16), version: "1", csrfToken: "x" }, cookie), runtime),
      (runtime, cookie) => handleCheckoutStart(submit("/checkout/start?lang=es", { variantId: "studybook-14", quantity: "1", csrfToken: "x" }, cookie), runtime),
      (runtime, cookie) => handleConfirm(submit("/checkout/ci_x/confirm?lang=es", { csrfToken: "x" }, cookie), runtime, "ci_" + "ab".repeat(16)),
      (runtime, cookie) => handleSimulate(submit("/checkout/ci_x/simulate?lang=es", { step: "approve", csrfToken: "x" }, cookie), runtime, "ci_" + "ab".repeat(16)),
    ];

    for (const call of calls) {
      const { runtime, time } = openedRuntime();
      const planted = await runtime.sessions.establish(null);
      if (!planted.ok || !planted.value.issuedToken) throw new Error("session was not planted");
      const intent = await startCheckout(runtime.checkout, planted.value.session.id);
      const before = JSON.stringify(await runtime.store.findIntent(intent.id));
      expect(needsDraftsFor(runtime.store).size).toBe(0);
      time.advance(SESSION_IDLE_TIMEOUT_MS + 1);
      const response = await call(runtime, `${SESSION_COOKIE_NAME}=${planted.value.issuedToken}`);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/es/demo/admission");
      expect(response.headers.getSetCookie()).toEqual([]);
      const idle = await runtime.sessions.resolve(planted.value.issuedToken);
      if (idle.ok) throw new Error("idle session was still admitted");
      expect(idle.error).toBe("SESSION_IDLE_EXPIRED");
      expect(JSON.stringify(await runtime.store.findIntent(intent.id))).toBe(before);
      expect(needsDraftsFor(runtime.store).size).toBe(0);
    }

    for (const page of ["src/app/(english)/shop/page.tsx", "src/app/[lang]/shop/needs/page.tsx", "src/app/[lang]/checkout/[intentId]/page.tsx"]) {
      const text = readFileSync(page, "utf8");
      const gate = text.indexOf("protectedAdmissionLocation");
      const resolve = text.indexOf("await resolvePageSession(");
      expect(gate, page).toBeGreaterThan(-1);
      expect(resolve, page).toBeGreaterThan(gate);
    }
    const { runtime } = openedRuntime();
    const planted = await runtime.sessions.establish(null);
    if (!planted.ok || !planted.value.issuedToken) throw new Error("session was not planted");
    expect(protectedAdmissionLocation(runtime.admission, `${SESSION_COOKIE_NAME}=${planted.value.issuedToken}`, runtime.clock().getTime(), "es")).toBe("/es/demo/admission");
  });

  it("renders English and Spanish admission screens without the passphrase or a client hook", () => {
    const admission = onAdmission();
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    const csrf = issuePurposeCookie(ADMISSION_KEY, now, CSRF_LIFETIME_MS, CSRF_LABEL).value;
    const closedModel = admissionScreen({ mode: "closed" }, null, now, "es", "<script>alert(1)</script>");
    if (closedModel === "not-found") throw new Error("closed screen missing");
    const closed = renderToStaticMarkup(AdmissionScreen({ model: closedModel }));
    expect(closed).toContain('lang="es"');
    expect(closed).toContain("Esta demostración no está disponible.");
    expect(closed).toContain('action="/demo/admission"');
    expect(closed).toContain('value="en"');
    expect(closed).toContain('value="es"');
    expect(closed.includes("passphrase")).toBe(false);
    expect(closed.includes("<script")).toBe(false);
    expect(closed.includes("alert(1)")).toBe(false);
    expect(closed).not.toMatch(/autofocus|tabindex/i);

    const loginModel = admissionScreen(admission, `${CSRF_COOKIE_NAME}=${csrf}`, now, "en", "rejected");
    if (loginModel === "not-found" || loginModel.kind !== "login") throw new Error("login screen missing");
    const login = renderToStaticMarkup(AdmissionScreen({ model: loginModel }));
    expect(login).toContain('lang="en"');
    expect(login).toContain('type="password"');
    expect(login).toContain('for="demo-passphrase"');
    expect(login).toContain('id="demo-passphrase"');
    expect(login).toContain('role="alert"');
    expect(login).toContain("The passphrase was not accepted.");
    expect(login).toContain('action="/demo/admission/submit"');
    expect(login.includes(PASSPHRASE)).toBe(false);
    expect(login.includes(ADMISSION_KEY.toString("base64"))).toBe(false);
    expect(login).not.toMatch(/autofocus|tabindex/i);

    const logout = admissionScreen(admission, `${CSRF_COOKIE_NAME}=${csrf}; ${ADMISSION_COOKIE_NAME}=${issuePurposeCookie(ADMISSION_KEY, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL).value}`, now, "es", null);
    if (logout === "not-found" || logout.kind !== "logout") throw new Error("expected the logout screen");
    const logoutMarkup = renderToStaticMarkup(AdmissionScreen({ model: logout }));
    expect(logoutMarkup).toContain('action="/demo/admission/logout"');
    expect(logoutMarkup).toContain("Salir de la demostración");
    const spanishLogin = admissionScreen(admission, `${CSRF_COOKIE_NAME}=${csrf}`, now, "es", null);
    if (spanishLogin === "not-found" || spanishLogin.kind !== "login") throw new Error("Spanish login screen missing");
    expect(renderToStaticMarkup(AdmissionScreen({ model: spanishLogin }))).toContain("Frase de acceso");
    expect(logoutMarkup.includes('name="passphrase"')).toBe(false);

    const page = readFileSync("src/app/[lang]/demo/admission/page.tsx", "utf8");
    expect(page).not.toMatch(/process\.env|use client|cookies\(\)\.set|set-cookie/i);
    expect(page).not.toMatch(/resolvePageSession|sessions\.establish|maintain\(/);
    const conversation = readFileSync("src/components/mock-journey/NeedsConversation.tsx", "utf8");
    const review = readFileSync("src/components/mock-journey/InterpretedNeedsReview.tsx", "utf8");
    const entry = readFileSync("src/components/mock-journey/GuidedLanguageChoice.tsx", "utf8");
    expect(conversation).toContain('action="/shop/needs/submit"');
    expect(review).toContain('action="/shop/needs/confirm"');
    expect(entry).toContain('action="/session/needs"');
    expect(readFileSync("src/server/demo-admission.ts", "utf8").includes("process.env")).toBe(false);
  });

  it("renders English and Spanish admission screens and describes the passphrase field only when the refusal exists", () => {
    const admission = onAdmission();
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    const csrf = issuePurposeCookie(ADMISSION_KEY, now, CSRF_LIFETIME_MS, CSRF_LABEL).value;
    const stylesheet = readFileSync("src/app/guided-presentation.css", "utf8");
    expect(stylesheet).toMatch(/\.guided-presentation :focus-visible\s*\{[^}]*outline:\s*3px solid var\(--gp-focus\)/);
    expect(stylesheet).toMatch(/\.guided-presentation \.journey-form input[\s\S]*?border:\s*1px solid #bfcfca/);
    expect(stylesheet).toMatch(/\.guided-presentation \.admission-screen \.guided-entry\s*\{[^}]*gap:\s*12px/);
    expect(stylesheet).toMatch(/\.guided-presentation \.admission-screen input\[type="password"\]\s*\{[^}]*border-color:\s*var\(--gp-teal\)/);

    function render(model: Exclude<ReturnType<typeof admissionScreen>, "not-found">): string {
      return renderToStaticMarkup(AdmissionScreen({ model }));
    }

    function passwordField(markup: string): string {
      return markup.match(/<input[^>]*type="password"[^>]*>/)?.[0] ?? "";
    }

    const englishRejected = admissionScreen(admission, `${CSRF_COOKIE_NAME}=${csrf}`, now, "en", "rejected");
    if (englishRejected === "not-found" || englishRejected.kind !== "login") throw new Error("English login missing");
    const english = render(englishRejected);
    expect(english).toContain('lang="en"');
    expect(english).toContain("Enter the demonstration");
    expect(english).toContain("Passphrase");
    expect(english).toContain("The passphrase was not accepted.");
    expect(english).toContain('class="guided-presentation"');
    expect(english).toContain('class="presentation-column presentation-column-narrow admission-screen"');
    expect(english).toContain('class="text-3xl font-semibold"');
    expect(english).toContain('class="guided-entry"');
    expect(english).toContain('class="journey-form"');
    expect(english).toContain('type="password"');
    expect(english.match(/aria-invalid="true"/g)).toHaveLength(1);
    expect(passwordField(english)).toContain('aria-invalid="true"');
    expect(english.match(new RegExp(`id="${DEMO_PASSPHRASE_REFUSAL_ID}"`, "g"))).toHaveLength(1);
    expect(english).toContain(`aria-describedby="${DEMO_PASSPHRASE_REFUSAL_ID}"`);
    expect(english.includes(DEMO_ADMISSION_RETRY_ID)).toBe(false);
    assertDescriptionReferencesExist(english);
    expect(english).not.toMatch(/autofocus|tabindex/i);

    const spanishRejected = admissionScreen(admission, `${CSRF_COOKIE_NAME}=${csrf}`, now, "es", "rejected");
    if (spanishRejected === "not-found" || spanishRejected.kind !== "login") throw new Error("Spanish login missing");
    const spanish = render(spanishRejected);
    expect(spanish).toContain('lang="es"');
    expect(spanish).toContain("Entrar a la demostración");
    expect(spanish).toContain("Frase de acceso");
    expect(spanish).toContain("La frase de acceso no fue aceptada.");
    expect(spanish).toContain('class="text-3xl font-semibold"');
    expect(spanish.match(/aria-invalid="true"/g)).toHaveLength(1);
    expect(passwordField(spanish)).toContain('aria-invalid="true"');
    expect(spanish.match(new RegExp(`id="${DEMO_PASSPHRASE_REFUSAL_ID}"`, "g"))).toHaveLength(1);
    expect(spanish).toContain(`aria-describedby="${DEMO_PASSPHRASE_REFUSAL_ID}"`);
    expect(spanish.includes(DEMO_ADMISSION_RETRY_ID)).toBe(false);
    assertDescriptionReferencesExist(spanish);
    expect(spanish).not.toMatch(/autofocus|tabindex/i);

    const quiet = admissionScreen(admission, `${CSRF_COOKIE_NAME}=${csrf}`, now, "en", null);
    if (quiet === "not-found" || quiet.kind !== "login") throw new Error("quiet login missing");
    const quietMarkup = render(quiet);
    expect(quietMarkup).toContain('lang="en"');
    expect(quietMarkup).toContain("Passphrase");
    expect(quietMarkup).toContain('class="journey-form"');
    expect(quietMarkup).toContain('class="text-3xl font-semibold"');
    expect(quietMarkup.includes("aria-describedby")).toBe(false);
    expect(quietMarkup.includes("aria-invalid")).toBe(false);
    expect(quietMarkup.includes(DEMO_PASSPHRASE_REFUSAL_ID)).toBe(false);
    expect(quietMarkup.includes(DEMO_ADMISSION_RETRY_ID)).toBe(false);
    assertDescriptionReferencesExist(quietMarkup);

    const englishRetry = admissionScreen(admission, `${CSRF_COOKIE_NAME}=${csrf}`, now, "en", "retry");
    if (englishRetry === "not-found" || englishRetry.kind !== "login") throw new Error("English retry missing");
    const englishRetryMarkup = render(englishRetry);
    expect(englishRetryMarkup).toContain('lang="en"');
    expect(englishRetryMarkup).toContain("Passphrase");
    expect(englishRetryMarkup).toContain("Too many attempts. Please wait and try again.");
    expect(englishRetryMarkup.match(new RegExp(`id="${DEMO_ADMISSION_RETRY_ID}"`, "g"))).toHaveLength(1);
    expect(englishRetryMarkup).toContain(`aria-describedby="${DEMO_ADMISSION_RETRY_ID}"`);
    expect(englishRetryMarkup.includes(DEMO_PASSPHRASE_REFUSAL_ID)).toBe(false);
    expect(passwordField(englishRetryMarkup).includes("aria-invalid")).toBe(false);
    assertDescriptionReferencesExist(englishRetryMarkup);

    const retry = admissionScreen(admission, `${CSRF_COOKIE_NAME}=${csrf}`, now, "es", "retry");
    if (retry === "not-found" || retry.kind !== "login") throw new Error("retry login missing");
    const retryMarkup = render(retry);
    expect(retryMarkup).toContain('lang="es"');
    expect(retryMarkup).toContain("Frase de acceso");
    expect(retryMarkup).toContain("Demasiados intentos. Espere y vuelva a intentarlo.");
    expect(retryMarkup.match(new RegExp(`id="${DEMO_ADMISSION_RETRY_ID}"`, "g"))).toHaveLength(1);
    expect(retryMarkup).toContain(`aria-describedby="${DEMO_ADMISSION_RETRY_ID}"`);
    expect(retryMarkup.includes(DEMO_PASSPHRASE_REFUSAL_ID)).toBe(false);
    expect(passwordField(retryMarkup).includes("aria-invalid")).toBe(false);
    assertDescriptionReferencesExist(retryMarkup);

    const bootstrap = admissionScreen(admission, null, now, "es", null);
    if (bootstrap === "not-found" || bootstrap.kind !== "bootstrap") throw new Error("bootstrap missing");
    const bootstrapMarkup = render(bootstrap);
    expect(bootstrapMarkup).toContain('lang="es"');
    expect(bootstrapMarkup).toContain("Continuar");
    expect(bootstrapMarkup).toContain("El siguiente paso pide la frase de acceso.");
    expect(bootstrapMarkup).toContain('class="guided-presentation"');
    expect(bootstrapMarkup).toContain('class="journey-form"');
    expect(bootstrapMarkup.includes('type="password"')).toBe(false);
    expect(bootstrapMarkup.includes("aria-describedby")).toBe(false);
    expect(bootstrapMarkup.includes("aria-invalid")).toBe(false);
    expect(bootstrapMarkup.includes(DEMO_ADMISSION_RETRY_ID)).toBe(false);
    assertDescriptionReferencesExist(bootstrapMarkup);

    const closed = admissionScreen({ mode: "closed" }, null, now, "en", "rejected");
    if (closed === "not-found" || closed.kind !== "closed") throw new Error("refusal missing");
    const closedMarkup = render(closed);
    expect(closedMarkup).toContain('lang="en"');
    expect(closedMarkup).toContain("This demonstration is not available.");
    expect(closedMarkup).toContain('class="guided-presentation"');
    expect(closedMarkup).toContain('class="journey-panel"');
    expect(closedMarkup.includes('type="password"')).toBe(false);
    expect(closedMarkup.includes(DEMO_PASSPHRASE_REFUSAL_ID)).toBe(false);
    expect(closedMarkup.includes(DEMO_ADMISSION_RETRY_ID)).toBe(false);
    expect(closedMarkup.includes("aria-describedby")).toBe(false);
    expect(closedMarkup.includes("aria-invalid")).toBe(false);
    assertDescriptionReferencesExist(closedMarkup);

    const closedSpanish = admissionScreen({ mode: "closed" }, null, now, "es", null);
    if (closedSpanish === "not-found" || closedSpanish.kind !== "closed") throw new Error("Spanish refusal missing");
    const closedSpanishMarkup = render(closedSpanish);
    expect(closedSpanishMarkup).toContain('lang="es"');
    expect(closedSpanishMarkup).toContain("Esta demostración no está disponible.");
    expect(closedSpanishMarkup).toContain('class="guided-entry"');
    expect(closedSpanishMarkup.includes("aria-describedby")).toBe(false);
  });
});
