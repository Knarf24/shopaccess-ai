import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { parseRuntimeConfig } from "@/server/config";
import { handleCheckoutStart, handleConfirm, handleSessionStart, handleSimulate } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { buildShoppingView, parsePreferences } from "@/server/shopping";
import { availableSteps, SIMULATION_STEPS, STATE_DESCRIPTIONS, STEP_LABELS } from "@/server/simulation";
import { PAYMENT_STATES } from "@/lib/payment/state-machine";
import { ID_PATTERNS } from "@/lib/shared/ids";
import { createTestClock, MINUTE, TEST_SESSION_KEY, permitPurchase } from "./helpers";

// Synthetic, test-only values. Nothing here is a real origin or key.
const ORIGIN = "https://shop.example.test";

function world() {
  const time = createTestClock();
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
  return { time, runtime };
}

interface Shopper {
  cookie: string;
  token: string;
  sessionId: string;
  csrfToken: string;
}

async function startSession(runtime: Runtime, query = "use=programming&budget=900"): Promise<Shopper & { response: Response }> {
  const response = await handleSessionStart(new Request(`${ORIGIN}/session/start?${query}`), runtime);
  const setCookie = response.headers.get("set-cookie")!;
  const token = setCookie.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session not established");
  return { response, cookie: `${SESSION_COOKIE_NAME}=${token}`, token, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

function post(path: string, fields: Record<string, string>, shopper: Pick<Shopper, "cookie"> | null, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(shopper ? { cookie: shopper.cookie } : {}),
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const QUOTE_FIELDS = { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: "1", use: "programming", budget: "900" };

async function startCheckoutFor(runtime: Runtime, shopper: Shopper, extra: Record<string, string> = {}): Promise<string> {
  const fields = { ...QUOTE_FIELDS, ...extra };
  await permitPurchase(runtime, shopper.sessionId, { productId: fields.productId, variantId: fields.variantId });
  const response = await handleCheckoutStart(post("/checkout/start", { ...QUOTE_FIELDS, ...extra, csrfToken: shopper.csrfToken }, shopper), runtime);
  expect(response.status).toBe(303);
  const location = response.headers.get("location")!;
  expect(location).toMatch(/^\/checkout\/ci_[0-9a-f]{32}$/);
  return location.split("/").pop()!;
}

async function confirm(runtime: Runtime, shopper: Shopper, intentId: string, changes: Record<string, string> = {}) {
  const intent = (await runtime.store.findIntent(intentId))!;
  const quote = (await runtime.store.findQuote(intent.snapshot.context.quoteId!))!;
  const { prepareConfirmation } = await import("@/lib/confirmation/confirmation");
  const challenge = await prepareConfirmation(runtime.checkout, shopper.sessionId, quote.quoteId);
  if (!challenge.ok) throw new Error(challenge.error);
  const fields = {
    confirmationId: challenge.value.confirmationId,
    nonce: challenge.value.nonce,
    quoteId: challenge.value.quoteId,
    quoteDigest: challenge.value.quoteDigest,
    acknowledged: "yes",
    csrfToken: shopper.csrfToken,
    ...changes,
  };
  return { fields, response: await handleConfirm(post(`/checkout/${intentId}/confirm`, fields, shopper), runtime, intentId) };
}

const step = (runtime: Runtime, shopper: Shopper, intentId: string, name: string) =>
  handleSimulate(post(`/checkout/${intentId}/simulate`, { step: name, csrfToken: shopper.csrfToken }, shopper), runtime, intentId);

const stateOf = async (runtime: Runtime, intentId: string) => (await runtime.store.findIntent(intentId))!.snapshot.state;

describe("runtime configuration fails closed", () => {
  const valid = {
    SHOPACCESS_SESSION_KEY: TEST_SESSION_KEY.toString("base64"),
    SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
    PAYMENT_PROVIDER_MODE: "mock",
    NODE_ENV: "production",
  };

  it("requires a session key, trusted origins and mock payment mode", () => {
    expect(parseRuntimeConfig(valid).ok).toBe(true);
    expect(parseRuntimeConfig({})).toEqual({ ok: false, error: ["SESSION_KEY_MISSING", "TRUSTED_ORIGINS_MISSING", "PAYMENT_MODE_NOT_MOCK"] });
    expect(parseRuntimeConfig({ ...valid, SHOPACCESS_SESSION_KEY: "c2hvcnQ=" })).toEqual({ ok: false, error: ["SESSION_KEY_TOO_SHORT"] });
    expect(parseRuntimeConfig({ ...valid, SHOPACCESS_TRUSTED_ORIGINS: "not a url" })).toEqual({ ok: false, error: ["TRUSTED_ORIGINS_INVALID"] });
    for (const mode of ["sandbox", "live", ""]) {
      expect(parseRuntimeConfig({ ...valid, PAYMENT_PROVIDER_MODE: mode }), mode).toEqual({ ok: false, error: ["PAYMENT_MODE_NOT_MOCK"] });
    }
    expect(parseRuntimeConfig({ ...valid, PAYPAL_CLIENT_SECRET: "x" })).toEqual({ ok: false, error: ["PAYMENT_MODE_NOT_MOCK"] });
  });

  it("accepts plain-HTTP loopback origins only in development, never in production", () => {
    const loopback = { ...valid, SHOPACCESS_TRUSTED_ORIGINS: "http://localhost:3000" };
    expect(parseRuntimeConfig({ ...loopback, NODE_ENV: "development" }).ok).toBe(true);
    for (const nodeEnv of ["production", "test", undefined]) {
      expect(parseRuntimeConfig({ ...loopback, NODE_ENV: nodeEnv }), String(nodeEnv)).toEqual({ ok: false, error: ["TRUSTED_ORIGINS_INVALID"] });
    }
    // Even in development, only loopback hosts qualify.
    for (const origin of ["http://shop.example.test", "http://192.168.1.10:3000", "http://localhost.evil.example"]) {
      expect(parseRuntimeConfig({ ...loopback, NODE_ENV: "development", SHOPACCESS_TRUSTED_ORIGINS: origin }).ok, origin).toBe(false);
    }
  });
});

describe("session start route", () => {
  it("issues a server-generated session cookie with the required attributes and continues to a fixed local path", async () => {
    const { runtime } = world();
    const { response, cookie } = await startSession(runtime);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/shop?use=programming&budget=900&started=1");
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-shopaccess_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400$/);

    // An existing valid session is reused, not replaced.
    const again = await handleSessionStart(new Request(`${ORIGIN}/session/start?use=schoolwork&budget=500`, { headers: { cookie } }), runtime);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(again.headers.get("location")).toBe("/shop?use=schoolwork&budget=500&started=1");
  });

  it("never adopts an unknown cookie and never redirects off-site", async () => {
    const { runtime } = world();
    const planted = "A".repeat(43);
    const response = await handleSessionStart(
      new Request(`${ORIGIN}/session/start?use=programming&budget=900&next=https://evil.example&redirect=//evil.example`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${planted}` },
      }),
      runtime,
    );
    expect(response.headers.get("set-cookie")).not.toContain(planted);
    expect((await runtime.sessions.resolve(planted)).ok).toBe(false);
    expect(response.headers.get("location")).toBe("/shop?use=programming&budget=900&started=1");

    for (const query of ["use=gaming&budget=900", "use=programming&budget=-5", "use=programming&budget=9e9", "budget=900", "use=programming&budget=%2F%2Fevil.example"]) {
      const invalid = await handleSessionStart(new Request(`${ORIGIN}/session/start?${query}`), runtime);
      expect(invalid.headers.get("location"), query).toBe("/");
    }
  });
});

describe("recommendations view", () => {
  it("includes catalog-backed AI hardware evidence without changing purchase behavior", async () => {
    const { runtime } = world();
    const preferences = parsePreferences("programming", "900")!;
    const view = await buildShoppingView(runtime, preferences, "ai-hardware-session");

    expect(view.variants.length).toBeGreaterThan(0);

    for (const entry of view.variants) {
      const hardware = entry.aiHardware;

      expect(hardware.workload).toBe("unspecified_ai");
      expect(hardware.facts.ramGb).toEqual({
        value: entry.variant.specs.ramGb,
        quality: "VERIFIED",
      });
      expect(hardware.facts.vramGb).toEqual({
        value: null,
        quality: "MISSING",
      });
      expect(hardware.compatibility).toBe("not_assessed");
      expect(hardware.authorizesPurchase).toBe(false);
      expect(entry.assessment.authorizesPurchase).toBe(false);
      expect(entry.quotable).toBe(entry.variant.availability === "IN_STOCK");
    }

    expect(
      Object.fromEntries(
        view.variants.map((entry) => [entry.variant.variantId, entry.assessment.status]),
      ),
    ).toEqual({
      dmv_aspire14ai: "READY",
      dmv_aspirego15: "READY_WITH_CAVEATS",
      dmv_vivobook16: "NOT_RECOMMENDED",
    });
  });


  it("assesses every demo variant deterministically and keeps external listings separate and non-payable", async () => {
    const { runtime } = world();
    const preferences = parsePreferences("programming", "900")!;
    const view = await buildShoppingView(runtime, preferences, "demo-flow-session");
    const again = await buildShoppingView(runtime, preferences, "demo-flow-session");
    expect(view).toEqual(again);

    const statuses = Object.fromEntries(view.variants.map((entry) => [entry.variant.variantId, entry.assessment.status]));
    expect(statuses).toEqual({
      dmv_aspire14ai: "READY",
      dmv_aspirego15: "READY_WITH_CAVEATS",
      dmv_vivobook16: "NOT_RECOMMENDED",
    });
    for (const entry of view.variants) {
      expect(entry.assessment.authorizesPurchase).toBe(false);
      expect(entry.explanation?.status).toBe(entry.assessment.status);
      // Being quotable depends on stock only, not on the label or the AI.
      expect(entry.quotable).toBe(entry.variant.availability === "IN_STOCK");
    }
    expect(view.external.length).toBeGreaterThan(0);
    for (const product of view.external) {
      expect(product.externalId.startsWith("ext_")).toBe(true);
      expect(Object.keys(product)).not.toContain("variantId");
    }
  });

  it("rejects malformed preferences", () => {
    for (const [use, budget] of [["programming", "0"], ["programming", "9"], ["programming", "100000"], ["programming", "12.5"], ["hacking", "500"], [undefined, "500"], ["programming", ["500", "600"]]]) {
      expect(parsePreferences(use, budget), `${use} ${budget}`).toBeNull();
    }
    expect(parsePreferences("schoolwork", "450")).toEqual({ use: "schoolwork", budgetCents: 45000, budgetDollars: "450" });
  });
});

describe("mock application flow through the HTTP handlers", () => {
  it("runs requirements, quote, explicit confirmation and a simulated payment lifecycle end to end", async () => {
    const { runtime } = world();
    const shopper = await startSession(runtime);

    // Client-supplied monetary fields in the form are ignored: the server prices the quote.
    const intentId = await startCheckoutFor(runtime, shopper, { unitAmountCents: "1", totalCents: "1", currency: "EUR", price: "0.01" });
    const quote = (await runtime.store.findQuoteForSession(shopper.sessionId, (await runtime.store.findIntent(intentId))!.snapshot.context.quoteId!))!;
    expect(quote).toMatchObject({ unitAmountCents: 87999, totalCents: 87999, currency: "USD", quantity: 1 });
    expect(await stateOf(runtime, intentId)).toBe("QUOTED");

    // Confirmation needs the explicit acknowledgement.
    const unticked = await confirm(runtime, shopper, intentId, { acknowledged: "" });
    expect(unticked.response.headers.get("location")).toBe(`/checkout/${intentId}?error=ACKNOWLEDGEMENT_REQUIRED`);
    expect(await stateOf(runtime, intentId)).toBe("QUOTED");

    const confirmed = await confirm(runtime, shopper, intentId);
    expect(confirmed.response.headers.get("location")).toBe(`/checkout/${intentId}?notice=CONFIRMED`);
    expect(await stateOf(runtime, intentId)).toBe("USER_CONFIRMED");

    // Replaying the same submission changes nothing and creates no operation.
    const replay = await handleConfirm(post(`/checkout/${intentId}/confirm`, confirmed.fields, shopper), runtime, intentId);
    expect(replay.headers.get("location")).toBe(`/checkout/${intentId}?error=CONFIRMATION_ALREADY_USED`);
    expect(await runtime.ledger.listForIntent(intentId, "ORDER_CREATE")).toHaveLength(0);
    expect(runtime.provider.calls).toEqual([]);

    // A step that is not valid for the current state is refused and leaves no queued mock scenario.
    expect((await step(runtime, shopper, intentId, "capture_lost_response")).headers.get("location")).toContain("STEP_NOT_AVAILABLE");
    expect((await step(runtime, shopper, intentId, "not_a_step")).headers.get("location")).toContain("STEP_NOT_AVAILABLE");

    const path: string[] = [];
    for (const name of ["create_order", "buyer_return_without_approval", "buyer_approve", "capture_lost_response"]) {
      expect((await step(runtime, shopper, intentId, name)).headers.get("location"), name).toBe(`/checkout/${intentId}`);
      path.push(await stateOf(runtime, intentId));
    }
    expect(path).toEqual(["AWAITING_APPROVAL", "AWAITING_APPROVAL", "APPROVED_VERIFIED", "CAPTURE_UNKNOWN"]);

    // Unknown is not failure, and cancel is no longer offered or accepted.
    expect(availableSteps("CAPTURE_UNKNOWN")).toEqual(["reconcile"]);
    expect((await step(runtime, shopper, intentId, "cancel")).headers.get("location")).toContain("STEP_NOT_AVAILABLE");
    await step(runtime, shopper, intentId, "reconcile");
    expect(await stateOf(runtime, intentId)).toBe("CAPTURED_VERIFIED");
    expect(runtime.provider.captureCount()).toBe(1);

    await step(runtime, shopper, intentId, "external_refund");
    expect(await stateOf(runtime, intentId)).toBe("PARTIALLY_REFUNDED_OBSERVED");

    // The audit trail holds no session token, CSRF token or nonce.
    const auditText = JSON.stringify(runtime.audit.list());
    expect(runtime.audit.list().length).toBeGreaterThan(5);
    for (const secret of [shopper.token, shopper.csrfToken, confirmed.fields.nonce]) expect(auditText).not.toContain(secret);
  });

  it("covers pending and declined captures and local cancellation", async () => {
    const { runtime } = world();
    const shopper = await startSession(runtime);

    const pending = await startCheckoutFor(runtime, shopper);
    await confirm(runtime, shopper, pending);
    for (const name of ["create_order", "buyer_approve", "capture_pending"]) await step(runtime, shopper, pending, name);
    expect(await stateOf(runtime, pending)).toBe("CAPTURE_PENDING_PROVIDER");
    await step(runtime, shopper, pending, "reconcile");
    expect(await stateOf(runtime, pending)).toBe("CAPTURE_PENDING_PROVIDER");
    await step(runtime, shopper, pending, "settle_pending");
    expect(await stateOf(runtime, pending)).toBe("CAPTURED_VERIFIED");

    const declined = await startCheckoutFor(runtime, shopper);
    await confirm(runtime, shopper, declined);
    for (const name of ["create_order_lost_response", "reconcile", "buyer_approve", "capture_declined"]) await step(runtime, shopper, declined, name);
    expect(await stateOf(runtime, declined)).toBe("DECLINED_RETRYABLE");
    await step(runtime, shopper, declined, "cancel");
    expect(await stateOf(runtime, declined)).toBe("CANCELED_LOCAL");
    expect(availableSteps("CANCELED_LOCAL")).toEqual([]);
  });

  it("rejects external discovery IDs and unavailable variants at the checkout route", async () => {
    const { runtime } = world();
    const shopper = await startSession(runtime);
    const attempt = async (fields: Record<string, string>) =>
      (await handleCheckoutStart(post("/checkout/start", { ...QUOTE_FIELDS, ...fields, csrfToken: shopper.csrfToken }, shopper), runtime)).headers.get("location");

    expect(await attempt({ productId: "ext_mock-aurora-13", variantId: "ext_mock-aurora-13" })).toBe("/shop?use=programming&budget=900&error=REQUEST_INVALID");
    runtime.catalog.products[2].variants[0].availability = "OUT_OF_STOCK";
    expect(await attempt({ productId: "dmp_vivobook16", variantId: "dmv_vivobook16" })).toContain("error=VARIANT_UNAVAILABLE");
    expect(await attempt({ quantity: "99" })).toContain("error=REQUEST_INVALID");
    expect(await attempt({ quantity: "abc" })).toContain("error=REQUEST_INVALID");
  });
});

describe("route-level authorization", () => {
  it("rejects cross-origin, missing-origin, wrong-CSRF and sessionless mutations on every mutating route", async () => {
    const { runtime } = world();
    const shopper = await startSession(runtime);
    const intentId = await startCheckoutFor(runtime, shopper);
    const before = (await runtime.store.findIntent(intentId))!.snapshot.version;
    const intentsBefore = runtime.store.intentCount();

    const routes: [string, (request: Request) => Promise<Response>][] = [
      ["/checkout/start", (request) => handleCheckoutStart(request, runtime)],
      [`/checkout/${intentId}/confirm`, (request) => handleConfirm(request, runtime, intentId)],
      [`/checkout/${intentId}/simulate`, (request) => handleSimulate(request, runtime, intentId)],
    ];
    const good = { ...QUOTE_FIELDS, step: "cancel", acknowledged: "yes", csrfToken: shopper.csrfToken };
    const attacks: [string, Request][] = routes.flatMap(([path]) => [
      [`${path} cross-site`, post(path, good, shopper, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })],
      [`${path} forged origin header only`, post(path, good, shopper, { origin: "https://evil.example" })],
      [`${path} same-site subdomain`, post(path, good, shopper, { origin: "https://other.example.test", "sec-fetch-site": "same-site" })],
      [`${path} null origin`, post(path, good, shopper, { origin: "null" })],
      [`${path} wrong csrf`, post(path, { ...good, csrfToken: "0".repeat(64) }, shopper)],
      [`${path} no csrf`, post(path, { ...good, csrfToken: "" }, shopper)],
      [`${path} no session`, post(path, good, null)],
      [`${path} unknown session`, post(path, good, { cookie: `${SESSION_COOKIE_NAME}=${"B".repeat(43)}` })],
    ] as [string, Request][]);

    for (const [name, request] of attacks) {
      const handler = routes.find(([path]) => name.startsWith(path))![1];
      const response = await handler(request);
      expect(response.status, name).toBe(403);
      const body = await response.text();
      expect(JSON.parse(body).error.code, name).toBe("FORBIDDEN");
      // The refusal does not say which check failed or echo any secret.
      expect(body, name).not.toMatch(/csrf|origin|session|token/i);
      expect(body, name).not.toContain(shopper.csrfToken);
    }
    expect((await runtime.store.findIntent(intentId))!.snapshot.version).toBe(before);
    expect(runtime.store.intentCount()).toBe(intentsBefore);
  });

  it("gives another session's checkout the same answer as a missing one", async () => {
    const { runtime } = world();
    const alice = await startSession(runtime);
    const mallory = await startSession(runtime);
    const intentId = await startCheckoutFor(runtime, alice);

    const stolen = await handleSimulate(post(`/checkout/${intentId}/simulate`, { step: "cancel", csrfToken: mallory.csrfToken }, mallory), runtime, intentId);
    const missing = await handleSimulate(post("/x", { step: "cancel", csrfToken: mallory.csrfToken }, mallory), runtime, "ci_" + "0".repeat(32));
    const malformed = await handleSimulate(post("/x", { step: "cancel", csrfToken: mallory.csrfToken }, mallory), runtime, "../../etc/passwd");
    for (const response of [stolen, missing, malformed]) expect(response.status).toBe(404);
    expect(JSON.parse(await stolen.text()).error.message).toBe(JSON.parse(await missing.text()).error.message);

    // Mallory cannot confirm Alice's summary even with Alice's leaked confirmation values.
    const aliceConfirm = await confirm(runtime, alice, intentId, { acknowledged: "" });
    const hijack = await handleConfirm(post(`/checkout/${intentId}/confirm`, { ...aliceConfirm.fields, acknowledged: "yes", csrfToken: mallory.csrfToken }, mallory), runtime, intentId);
    expect(hijack.status).toBe(404);
    expect(await stateOf(runtime, intentId)).toBe("QUOTED");

    // A confirmation for one checkout cannot be submitted against another checkout's URL.
    // M2-3: the first checkout still holds its item's single-use permission, so the second is for another item.
    const second = await startCheckoutFor(runtime, alice, { productId: "dmp_aspirego15", variantId: "dmv_aspirego15" });
    const crossed = await handleConfirm(post(`/checkout/${second}/confirm`, { ...aliceConfirm.fields, acknowledged: "yes" }, alice), runtime, second);
    expect(crossed.headers.get("location")).toBe(`/checkout/${second}?error=CONFIRMATION_MISMATCH`);
    expect(await stateOf(runtime, intentId)).toBe("QUOTED");
    expect(await stateOf(runtime, second)).toBe("QUOTED");
  });

  it("enforces body type, body size and per-session rate limits", async () => {
    const { runtime, time } = world();
    const shopper = await startSession(runtime);
    const intentId = await startCheckoutFor(runtime, shopper);
    const headers = { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: shopper.cookie };

    const json = new Request(`${ORIGIN}/checkout/start`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(QUOTE_FIELDS) });
    expect((await handleCheckoutStart(json, runtime)).status).toBe(400);
    const huge = post("/checkout/start", { ...QUOTE_FIELDS, csrfToken: shopper.csrfToken, padding: "x".repeat(20_000) }, shopper);
    expect((await handleCheckoutStart(huge, runtime)).status).toBe(413);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await handleConfirm(post(`/checkout/${intentId}/confirm`, { csrfToken: shopper.csrfToken }, shopper), runtime, intentId);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 303)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    time.advance(MINUTE);
    expect((await handleConfirm(post(`/checkout/${intentId}/confirm`, { csrfToken: shopper.csrfToken }, shopper), runtime, intentId)).status).toBe(303);
  });

  it("an expired quote cannot be confirmed through the route", async () => {
    const { runtime, time } = world();
    const shopper = await startSession(runtime);
    const intentId = await startCheckoutFor(runtime, shopper);
    const prepared = await confirm(runtime, shopper, intentId, { acknowledged: "" });
    time.advance(16 * MINUTE);
    const late = await handleConfirm(post(`/checkout/${intentId}/confirm`, { ...prepared.fields, acknowledged: "yes" }, shopper), runtime, intentId);
    expect(late.headers.get("location")).toBe(`/checkout/${intentId}?error=CONFIRMATION_EXPIRED`);
    expect(await stateOf(runtime, intentId)).toBe("QUOTED");
  });
});

describe("simulation labelling", () => {
  it("describes every state and labels every control as a simulation", () => {
    for (const state of PAYMENT_STATES) expect(STATE_DESCRIPTIONS[state].length, state).toBeGreaterThan(20);
    for (const name of SIMULATION_STEPS.filter((candidate) => candidate !== "cancel" && candidate !== "reconcile")) {
      expect(STEP_LABELS[name], name).toMatch(/^Simulate/);
    }
    expect(STATE_DESCRIPTIONS.CAPTURE_PENDING_PROVIDER).toContain("not a completed payment");
    expect(STATE_DESCRIPTIONS.APPROVAL_CHECK_PENDING).toContain("proves nothing");
    expect(STATE_DESCRIPTIONS.CAPTURE_UNKNOWN).toContain("not treated as a failure");
    // Cancel is never offered once a capture may have been sent, and nothing is offered from dead ends.
    for (const state of ["CAPTURE_IN_FLIGHT", "CAPTURE_UNKNOWN", "CAPTURE_PENDING_PROVIDER", "CAPTURED_VERIFIED"] as const) {
      expect(availableSteps(state)).not.toContain("cancel");
    }
    expect(ID_PATTERNS.checkoutIntent.test("ci_" + "a".repeat(32))).toBe(true);
  });
});
