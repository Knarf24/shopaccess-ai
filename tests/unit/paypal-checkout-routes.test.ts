import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SandboxCheckoutActions } from "@/components/SimulatedPaymentPanel";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { sandboxCorrelationId } from "@/lib/payment/adapter-config";
import { centsToPaypalAmount, isPayPalSandboxProvider, PayPalSandboxProvider, type PaypalTransport } from "@/lib/providers/paypal-sandbox";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import type { PaymentOperation } from "@/lib/payment/operations";
import { INITIAL_PAYMENT_SNAPSHOT, PAYMENT_STATES, type PaymentContext, type PaymentSnapshot, type PaymentState } from "@/lib/payment/state-machine";
import {
  cancelReturnStatus,
  handleConfirm,
  handleCheckoutStart,
  handleSandboxApprove,
  handleSandboxCancel,
  handleSandboxCapture,
  handleSandboxPaypalCancel,
  handleSandboxReturn,
  handleSessionStart,
} from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import type { CheckoutView } from "@/server/views";
import { TEST_SESSION_KEY, permitPurchase } from "./helpers";

const ORIGIN = "https://shop.example.test";
const PAYEE = "2ABCDEFGHJKLM";
const ORDER_ID = "5O190127TN364715T";
const CAPTURE_ID = "8AA12345BC678901C";

function tokenResponse() {
  return { status: 200, body: JSON.stringify({ access_token: "synthetic-token", expires_in: 3200 }) };
}

function sandboxConfig() {
  return {
    sessionKey: TEST_SESSION_KEY,
    trustedOrigins: parseTrustedOrigins([ORIGIN]),
    payment: {
      mode: "sandbox" as const,
      apiBaseUrl: "https://api-m.sandbox.paypal.com",
      merchantId: PAYEE,
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
    },
  };
}

function runtimeWith(transport: PaypalTransport, sandboxProvider?: PayPalSandboxProvider) {
  return createRuntime(sandboxConfig(), { paymentTransport: transport, ...(sandboxProvider ? { sandboxProvider } : {}) });
}

async function foreignProvider(transport: PaypalTransport): Promise<PayPalSandboxProvider> {
  const specifier = "@/lib/providers/paypal-sandbox?copy=cross-module";
  const other = (await import(specifier)) as typeof import("@/lib/providers/paypal-sandbox");
  const OtherProvider = other.PayPalSandboxProvider;
  const provider = new OtherProvider({
    apiBaseUrl: "https://api-m.sandbox.paypal.com",
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    merchantId: PAYEE,
    transport,
  });
  if (provider instanceof PayPalSandboxProvider || OtherProvider === PayPalSandboxProvider) throw new Error("module copy was not distinct");
  if (!isPayPalSandboxProvider(provider)) throw new Error("constructed provider was not recognized");
  return provider;
}

interface Shopper {
  cookie: string;
  csrfToken: string;
  sessionId: string;
}

async function shopper(runtime: Runtime): Promise<Shopper> {
  const response = await handleSessionStart(new Request(`${ORIGIN}/session/start?use=programming&budget=900`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  // M2-3: a shopper creates the purchase permission before checking out.
  await permitPurchase(runtime, session.value.id);
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, csrfToken: session.value.csrfToken, sessionId: session.value.id };
}

function post(path: string, fields: Record<string, string>, current: Shopper | null): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(current ? { cookie: current.cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function confirmed(runtime: Runtime, current: Shopper): Promise<{ intentId: string; totalCents: number; quoteId: string }> {
  const started = await handleCheckoutStart(
    post("/checkout/start", { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: "1", use: "programming", budget: "900", csrfToken: current.csrfToken }, current),
    runtime,
  );
  const intentId = new URL(started.headers.get("location")!, ORIGIN).pathname.split("/").pop()!;
  const intent = (await runtime.store.findIntent(intentId))!;
  const quote = (await runtime.store.findQuote(intent.snapshot.context.quoteId!))!;
  const { prepareConfirmation } = await import("@/lib/confirmation/confirmation");
  const challenge = await prepareConfirmation(runtime.checkout, current.sessionId, quote.quoteId);
  if (!challenge.ok) throw new Error(challenge.error);
  await handleConfirm(
    post(
      `/checkout/${intentId}/confirm`,
      {
        confirmationId: challenge.value.confirmationId,
        nonce: challenge.value.nonce,
        quoteId: challenge.value.quoteId,
        quoteDigest: challenge.value.quoteDigest,
        acknowledged: "yes",
        csrfToken: current.csrfToken,
      },
      current,
    ),
    runtime,
    intentId,
  );
  return { intentId, totalCents: quote.totalCents, quoteId: quote.quoteId };
}

function orderBody(quoteId: string, totalCents: number, status: string) {
  return JSON.stringify({
    id: ORDER_ID,
    status,
    purchase_units: [
      {
        custom_id: sandboxCorrelationId(quoteId),
        payee: { merchant_id: PAYEE },
        amount: { currency_code: "USD", value: centsToPaypalAmount(totalCents) },
      },
    ],
    links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}` }],
  });
}

describe("PayPal sandbox checkout handlers", () => {
  it("constructs the sandbox adapter from configuration and does not call it without a checkout action", () => {
    const runtime = createRuntime({
      sessionKey: TEST_SESSION_KEY,
      trustedOrigins: parseTrustedOrigins([ORIGIN]),
      payment: {
        mode: "sandbox",
        apiBaseUrl: "https://api-m.sandbox.paypal.com",
        merchantId: PAYEE,
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      },
    });
    expect(runtime.paymentMode).toBe("sandbox");
    expect(runtime.sandbox).not.toBeNull();
    expect(runtime.sandbox?.outbound).toEqual([]);
    expect(runtime.provider).not.toBe(runtime.sandbox);
  });

  it("answers 404 for sandbox handlers while payment mode is the plain mock", async () => {
    const mockRuntime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) });
    const current = await shopper(mockRuntime);
    const { intentId } = await confirmed(mockRuntime, current);
    expect((await handleSandboxApprove(post(`/checkout/${intentId}/approve`, { csrfToken: current.csrfToken }, current), mockRuntime, intentId)).status).toBe(404);
  });

  it("requires the session and CSRF token, hides another session's checkout, and captures only after approval", async () => {
    const bodies: Array<{ status: number; body: string }> = [];
    const runtime = runtimeWith(async (request) => {
      if (request.url.endsWith("/token")) return tokenResponse();
      const next = bodies.shift();
      if (!next) throw new Error(request.url);
      return next;
    });
    const current = await shopper(runtime);
    const { intentId, totalCents, quoteId } = await confirmed(runtime, current);
    const missing = await handleSandboxApprove(post(`/checkout/${intentId}/approve`, {}, current), runtime, intentId);
    expect(missing.status).toBe(403);

    const other = await shopper(runtime);
    const hidden = await handleSandboxApprove(post(`/checkout/${intentId}/approve`, { csrfToken: other.csrfToken }, other), runtime, intentId);
    expect(hidden.status).toBe(404);

    const tooSoon = await handleSandboxCapture(post(`/checkout/${intentId}/capture`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect(tooSoon.headers.get("location")).toContain("APPROVAL_NOT_CONFIRMED");
    expect(runtime.sandbox?.outbound.some((call) => call.url.endsWith("/capture"))).toBe(false);

    bodies.push({ status: 201, body: orderBody(quoteId, totalCents, "CREATED") });
    const approved = await handleSandboxApprove(post(`/checkout/${intentId}/approve`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`);

    const checkoutBefore = structuredClone({
      intent: await runtime.store.findIntent(intentId),
      transitions: await runtime.store.listTransitions(intentId),
      observations: await runtime.store.listObservations(intentId),
    });
    const auditBefore = structuredClone(runtime.audit.list());
    const callsBefore = structuredClone(runtime.sandbox!.outbound);
    const ledgerBefore = structuredClone([
      ...(await runtime.ledger.listForIntent(intentId, "ORDER_CREATE")),
      ...(await runtime.ledger.listForIntent(intentId, "CAPTURE")),
    ]);
    const mismatch = await handleSandboxReturn(new Request(`${ORIGIN}/checkout/${intentId}/return?token=OTHER&PayerID=IGNORED`, { headers: { cookie: current.cookie } }), runtime, intentId);
    expect(mismatch.headers.get("location")).toContain("APPROVAL_NOT_CONFIRMED");
    expect({
      intent: await runtime.store.findIntent(intentId),
      transitions: await runtime.store.listTransitions(intentId),
      observations: await runtime.store.listObservations(intentId),
    }).toEqual(checkoutBefore);
    expect(runtime.audit.list()).toEqual(auditBefore);
    expect(runtime.sandbox!.outbound).toEqual(callsBefore);
    expect([
      ...(await runtime.ledger.listForIntent(intentId, "ORDER_CREATE")),
      ...(await runtime.ledger.listForIntent(intentId, "CAPTURE")),
    ]).toEqual(ledgerBefore);

    bodies.push({ status: 200, body: orderBody(quoteId, totalCents, "APPROVED") });
    const returned = await handleSandboxReturn(new Request(`${ORIGIN}/checkout/${intentId}/return?token=${ORDER_ID}&PayerID=IGNORED`, { headers: { cookie: current.cookie } }), runtime, intentId);
    expect(returned.headers.get("location")).toBe(`/checkout/${intentId}`);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("APPROVED_VERIFIED");
    expect(runtime.sandbox?.outbound.some((call) => call.url.endsWith("/capture"))).toBe(false);

    bodies.push({
      status: 201,
      body: JSON.stringify({
        id: CAPTURE_ID,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: centsToPaypalAmount(totalCents) },
        custom_id: sandboxCorrelationId(quoteId),
        payee: { merchant_id: PAYEE },
        supplementary_data: { related_ids: { order_id: ORDER_ID } },
      }),
    });
    const captured = await handleSandboxCapture(post(`/checkout/${intentId}/capture`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect(captured.headers.get("location")).toBe(`/checkout/${intentId}?notice=CAPTURED`);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("CAPTURED_VERIFIED");
  });

  it("renders a cancel form without canceling, then cancels only from the POST", async () => {
    const runtime = runtimeWith(async () => tokenResponse());
    const current = await shopper(runtime);
    const { intentId } = await confirmed(runtime, current);
    const page = await handleSandboxPaypalCancel(new Request(`${ORIGIN}/checkout/${intentId}/paypal-cancel`, { headers: { cookie: current.cookie } }), runtime, intentId);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`/checkout/${intentId}/cancel`);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("USER_CONFIRMED");
    const canceled = await handleSandboxCancel(post(`/checkout/${intentId}/cancel`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect(canceled.status).toBe(303);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("CANCELED_LOCAL");
  });

  it("shows capture success only after the capture is verified", () => {
    const copy = journeyCopy("en").sandboxCheckout;
    const markup = (state: PaymentState, permissionRefusal: CheckoutView["permissionRefusal"] = null, steps: CheckoutView["steps"] = []) =>
      renderToStaticMarkup(
        SandboxCheckoutActions({
          view: {
            intentId: `ci_${"ab".repeat(16)}`,
            state,
            quote: null,
            itemTitle: null,
            merchantName: "ShopAccess Demo Store (simulated)",
            challenge: null,
            challengeProblem: null,
            permissionRefusal,
            steps,
            transitions: [],
            observations: [],
            operations: [],
            interfaceLanguage: "en",
          } satisfies CheckoutView,
          csrfToken: "csrf",
          copy,
        }),
      );
    expect(markup("APPROVED_VERIFIED")).toContain(copy.approved);
    expect(markup("APPROVED_VERIFIED")).not.toContain(copy.captured);
    expect(markup("CAPTURED_VERIFIED")).toContain(copy.captured);
    expect(markup("USER_CONFIRMED")).toContain(copy.approve);
    expect(markup("USER_CONFIRMED")).not.toContain(copy.captured);
    // M2-3 review finding 3: while a permission refusal applies, neither approval nor capture is offered.
    for (const refusal of ["PERMISSION_REVOKED", "CONFIRMATION_REQUIRED"] as const) {
      expect(markup("USER_CONFIRMED", refusal), refusal).not.toMatch(/<form|<button/);
      expect(markup("APPROVED_VERIFIED", refusal), refusal).not.toMatch(/<form|<button/);
      // Second review finding 2: while cancelling is valid, the protected cancel form is the only control.
      for (const state of ["USER_CONFIRMED", "APPROVED_VERIFIED"] as const) {
        const html = markup(state, refusal, ["cancel"]);
        expect([...html.matchAll(/<form\b[^>]*action="([^"]+)"/g)].map((match) => match[1]), `${state} ${refusal}`).toEqual([`/checkout/ci_${"ab".repeat(16)}/cancel`]);
        expect(html).toContain('<input type="hidden" name="csrfToken" value="csrf"/>');
        expect([...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map((match) => match[1])).toEqual([copy.cancel]);
      }
    }
    // No refusal: no cancel form here (unchanged behaviour).
    expect(markup("APPROVED_VERIFIED", null, ["cancel"])).not.toContain("/cancel");
  });

  it("refuses approve, return, and capture for mock mode, a missing provider, an inconsistent runtime, and PostgreSQL routes", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    for (const route of ["approve", "return", "capture"]) {
      const text = readFileSync(join(root, "src", "app", "checkout", "[intentId]", route, "route.ts"), "utf8");
      expect(text, route).toContain('runtime.paymentMode === "sandbox"');
      expect(text, route).toContain("postgres: () => mockRouteNotFound()");
    }

    const mockRuntime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) });
    const current = await shopper(mockRuntime);
    const { intentId } = await confirmed(mockRuntime, current);
    const mockReturn = new Request(`${ORIGIN}/checkout/${intentId}/return?token=${ORDER_ID}`, { headers: { cookie: current.cookie } });
    expect((await handleSandboxApprove(post(`/checkout/${intentId}/approve`, { csrfToken: current.csrfToken }, current), mockRuntime, intentId)).status).toBe(404);
    expect((await handleSandboxReturn(mockReturn, mockRuntime, intentId)).status).toBe(404);
    expect((await handleSandboxCapture(post(`/checkout/${intentId}/capture`, { csrfToken: current.csrfToken }, current), mockRuntime, intentId)).status).toBe(404);

    const duck = {
      armReturnOrigin() {},
      approvalUrlFor() {
        return "https://www.sandbox.paypal.com/checkoutnow?token=NOTREAL";
      },
      consumePublicCode() {
        return null;
      },
      outbound: [],
    } as unknown as PayPalSandboxProvider;
    const ignored = createRuntime(sandboxConfig(), { sandboxProvider: duck });
    expect(ignored.paymentMode).toBe("mock");
    expect(ignored.sandbox).toBeNull();
    expect(isPayPalSandboxProvider(duck)).toBe(false);
    const ignoredShopper = await shopper(ignored);
    const ignoredCheckout = await confirmed(ignored, ignoredShopper);
    expect((await handleSandboxApprove(post(`/checkout/${ignoredCheckout.intentId}/approve`, { csrfToken: ignoredShopper.csrfToken }, ignoredShopper), ignored, ignoredCheckout.intentId)).status).toBe(404);

    const runtime = runtimeWith(async () => ({ status: 500, body: "" }));
    const shopperOnRuntime = await shopper(runtime);
    const checkout = await confirmed(runtime, shopperOnRuntime);
    const installed = runtime.payment;
    const callsBefore = runtime.sandbox?.outbound.length ?? 0;
    const mutable = runtime as Runtime & { paymentMode: Runtime["paymentMode"]; sandbox: Runtime["sandbox"]; payment: Runtime["payment"] };
    mutable.payment = { ...installed, provider: runtime.provider };
    expect((await handleSandboxApprove(post(`/checkout/${checkout.intentId}/approve`, { csrfToken: shopperOnRuntime.csrfToken }, shopperOnRuntime), runtime, checkout.intentId)).status).toBe(404);
    mutable.payment = installed;
    mutable.paymentMode = "mock";
    expect((await handleSandboxReturn(new Request(`${ORIGIN}/checkout/${checkout.intentId}/return`, { headers: { cookie: shopperOnRuntime.cookie } }), runtime, checkout.intentId)).status).toBe(404);
    mutable.paymentMode = "sandbox";
    const detached = { ...runtime, sandbox: null };
    expect((await handleSandboxCapture(post(`/checkout/${checkout.intentId}/capture`, { csrfToken: shopperOnRuntime.csrfToken }, shopperOnRuntime), detached, checkout.intentId)).status).toBe(404);
    const foreign = await foreignProvider(async () => ({ status: 500, body: "" }));
    mutable.sandbox = foreign;
    mutable.payment = { ...installed, provider: foreign };
    expect((await handleSandboxApprove(post(`/checkout/${checkout.intentId}/approve`, { csrfToken: shopperOnRuntime.csrfToken }, shopperOnRuntime), runtime, checkout.intentId)).status).toBe(404);
    expect(runtime.sandbox?.outbound.length ?? 0).toBe(callsBefore);
    expect(foreign.outbound).toEqual([]);
  });

  it("approves, returns, and captures through a provider constructed by a distinct module copy", async () => {
    const bodies: Array<{ status: number; body: string }> = [];
    const transport: PaypalTransport = async (request) => {
      if (request.url.endsWith("/token")) return tokenResponse();
      const next = bodies.shift();
      if (!next) throw new Error(request.url);
      return next;
    };
    const foreign = await foreignProvider(transport);
    const runtime = runtimeWith(transport, foreign);
    expect(runtime.paymentMode).toBe("sandbox");
    expect(runtime.sandbox).toBe(foreign);
    expect(runtime.payment.provider).toBe(foreign);
    const current = await shopper(runtime);
    const { intentId, totalCents, quoteId } = await confirmed(runtime, current);

    bodies.push({ status: 201, body: orderBody(quoteId, totalCents, "CREATED") });
    const approved = await handleSandboxApprove(post(`/checkout/${intentId}/approve`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`);

    bodies.push({ status: 200, body: orderBody(quoteId, totalCents, "APPROVED") });
    const returned = await handleSandboxReturn(new Request(`${ORIGIN}/checkout/${intentId}/return?token=${ORDER_ID}&PayerID=IGNORED`, { headers: { cookie: current.cookie } }), runtime, intentId);
    expect(returned.headers.get("location")).toBe(`/checkout/${intentId}`);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("APPROVED_VERIFIED");

    bodies.push({
      status: 201,
      body: JSON.stringify({
        id: CAPTURE_ID,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: centsToPaypalAmount(totalCents) },
        custom_id: sandboxCorrelationId(quoteId),
        payee: { merchant_id: PAYEE },
        supplementary_data: { related_ids: { order_id: ORDER_ID } },
      }),
    });
    const captured = await handleSandboxCapture(post(`/checkout/${intentId}/capture`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect(captured.headers.get("location")).toBe(`/checkout/${intentId}?notice=CAPTURED`);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("CAPTURED_VERIFIED");
    expect(foreign.outbound.some((call) => call.url.startsWith("https://api-m.sandbox.paypal.com/"))).toBe(true);
    expect(foreign.outbound.some((call) => !call.url.startsWith("https://api-m.sandbox.paypal.com/"))).toBe(false);
  });
});

// Codex slices 1–2 review finding 1: the PayPal cancel-return page (GET) states and offers only what the saved payment
// state supports, and changes nothing. Mocked transport; no PayPal call leaves the test.
describe("sandbox cancel-return page follows the saved payment state", () => {
  const copy = journeyCopy("en").sandboxCheckout;
  const NO_CAPTURE = "No payment has been captured.";

  function world(fallback: { status: number; body: string } | null = null) {
    const replies: Array<{ status: number; body: string }> = [];
    const runtime = runtimeWith(async (request) => {
      if (request.url.endsWith("/token")) return tokenResponse();
      const next = replies.shift() ?? fallback;
      if (!next) throw new Error(`unexpected PayPal call ${request.url}`);
      return next;
    });
    return { runtime, replies };
  }

  async function approved(runtime: Runtime, replies: Array<{ status: number; body: string }>) {
    const current = await shopper(runtime);
    const { intentId, totalCents, quoteId } = await confirmed(runtime, current);
    replies.push({ status: 201, body: orderBody(quoteId, totalCents, "CREATED") });
    await handleSandboxApprove(post(`/checkout/${intentId}/approve`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    replies.push({ status: 200, body: orderBody(quoteId, totalCents, "APPROVED") });
    await handleSandboxReturn(new Request(`${ORIGIN}/checkout/${intentId}/return?token=${ORDER_ID}`, { headers: { cookie: current.cookie } }), runtime, intentId);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("APPROVED_VERIFIED");
    return { current, intentId, totalCents, quoteId };
  }

  const captureReply = (quoteId: string, totalCents: number, status: string) => ({
    status: 201,
    body: JSON.stringify({
      id: CAPTURE_ID,
      status,
      amount: { currency_code: "USD", value: centsToPaypalAmount(totalCents) },
      custom_id: sandboxCorrelationId(quoteId),
      payee: { merchant_id: PAYEE },
      supplementary_data: { related_ids: { order_id: ORDER_ID } },
    }),
  });

  /** Everything a GET must leave unchanged. */
  async function recorded(runtime: Runtime, intentId: string) {
    return structuredClone({
      intent: await runtime.store.findIntent(intentId),
      transitions: await runtime.store.listTransitions(intentId),
      observations: await runtime.store.listObservations(intentId),
      ledger: [...(await runtime.ledger.listForIntent(intentId, "ORDER_CREATE")), ...(await runtime.ledger.listForIntent(intentId, "CAPTURE"))],
      audit: runtime.audit.list(),
      outbound: runtime.sandbox!.outbound,
      permissions: runtime.durable.readPermissions(),
    });
  }

  async function cancelPage(runtime: Runtime, current: Shopper, intentId: string) {
    const before = await recorded(runtime, intentId);
    const response = await handleSandboxPaypalCancel(new Request(`${ORIGIN}/checkout/${intentId}/paypal-cancel`, { headers: { cookie: current.cookie } }), runtime, intentId);
    expect(response.status).toBe(200);
    expect(await recorded(runtime, intentId)).toEqual(before);
    const html = await response.text();
    return { html, forms: [...html.matchAll(/<form\b[^>]*action="([^"]+)"/g)].map((match) => match[1]) };
  }

  it("captured: says it was captured, offers no cancel, and links back to the checkout", async () => {
    const { runtime, replies } = world();
    const { current, intentId, totalCents, quoteId } = await approved(runtime, replies);
    replies.push(captureReply(quoteId, totalCents, "COMPLETED"));
    await handleSandboxCapture(post(`/checkout/${intentId}/capture`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("CAPTURED_VERIFIED");
    const page = await cancelPage(runtime, current, intentId);
    expect(page.html).not.toContain(NO_CAPTURE);
    expect(page.html).toContain(copy.captured);
    expect(page.forms).toEqual([]);
    expect(page.html).toContain(`href="/checkout/${intentId}"`);
  });

  it("capture outcome uncertain: says so, never 'no payment has been captured', and offers no cancel", async () => {
    const { runtime, replies } = world({ status: 500, body: "{}" });
    const { current, intentId } = await approved(runtime, replies);
    await handleSandboxCapture(post(`/checkout/${intentId}/capture`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    const intent = (await runtime.store.findIntent(intentId))!;
    expect(intent.snapshot.context.captureDispatched).toBe(true);
    expect(["CAPTURE_UNKNOWN", "RECONCILIATION_REQUIRED", "CAPTURE_IN_FLIGHT"]).toContain(intent.snapshot.state);
    const page = await cancelPage(runtime, current, intentId);
    expect(page.html).not.toContain(NO_CAPTURE);
    expect(page.html).toContain(copy.unknown);
    expect(page.forms).toEqual([]);
    expect(page.html).toContain(`href="/checkout/${intentId}"`);
  });

  it("provider-proven decline: no capture, and Cancel is offered because the state machine still allows it", async () => {
    const { runtime, replies } = world();
    const { current, intentId, totalCents, quoteId } = await approved(runtime, replies);
    replies.push(captureReply(quoteId, totalCents, "DECLINED"));
    await handleSandboxCapture(post(`/checkout/${intentId}/capture`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("DECLINED_RETRYABLE");
    const page = await cancelPage(runtime, current, intentId);
    expect(page.html).toContain(NO_CAPTURE);
    expect(page.forms).toEqual([`/checkout/${intentId}/cancel`]);
  });

  it("order outcome unknown: no capture, but no Cancel because the state machine does not allow it", async () => {
    const { runtime } = world({ status: 500, body: "{}" });
    const current = await shopper(runtime);
    const { intentId } = await confirmed(runtime, current);
    await handleSandboxApprove(post(`/checkout/${intentId}/approve`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("ORDER_CREATE_UNKNOWN");
    const page = await cancelPage(runtime, current, intentId);
    expect(page.html).toContain(`${NO_CAPTURE} It can&#39;t be canceled here.`);
    expect(page.forms).toEqual([]);
    expect(page.html).toContain(`href="/checkout/${intentId}"`);
  });

  it("before any capture: no capture, Cancel offered; after Cancel: canceled wording and no form", async () => {
    const { runtime, replies } = world();
    const { current, intentId } = await approved(runtime, replies);
    const open = await cancelPage(runtime, current, intentId);
    expect(open.html).toContain(NO_CAPTURE);
    expect(open.forms).toEqual([`/checkout/${intentId}/cancel`]);
    await handleSandboxCancel(post(`/checkout/${intentId}/cancel`, { csrfToken: current.csrfToken }, current), runtime, intentId);
    expect((await runtime.store.findIntent(intentId))?.snapshot.state).toBe("CANCELED_LOCAL");
    const closed = await cancelPage(runtime, current, intentId);
    expect(closed.html).toContain(copy.canceled);
    expect(closed.forms).toEqual([]);
  });
});

// Codex slices 1–2 review finding 1, states the mocked flows above do not reach: the classifier behind the page.
describe("cancel-return classification", () => {
  const snapshot = (state: PaymentState, context: Partial<PaymentContext> = {}): PaymentSnapshot => ({ state, version: 9, context: { ...INITIAL_PAYMENT_SNAPSHOT.context, ...context } });
  const capture = (state: PaymentOperation["state"]) => ({ type: "CAPTURE", state }) as PaymentOperation;
  const dispatched = { captureDispatched: true, captureOperationId: "op_capture", providerCaptureId: CAPTURE_ID };

  it("captured, refunded and disputed states are never 'no capture'", () => {
    expect(cancelReturnStatus(snapshot("CAPTURED_VERIFIED", dispatched), [capture("SUCCEEDED")])).toBe("captured");
    for (const state of ["PARTIALLY_REFUNDED_OBSERVED", "REFUNDED_OBSERVED", "REVERSED_OR_DISPUTED_OBSERVED"] as const) {
      expect(cancelReturnStatus(snapshot(state, dispatched), [capture("SUCCEEDED")])).toBe("captured_observed");
    }
  });

  it("capture in flight, unknown, pending, reconciliation and manual review are uncertain, before or after dispatch", () => {
    for (const state of ["CAPTURE_IN_FLIGHT", "CAPTURE_UNKNOWN", "CAPTURE_PENDING_PROVIDER", "RECONCILIATION_REQUIRED", "MANUAL_REVIEW"] as const) {
      expect(cancelReturnStatus(snapshot(state, dispatched), [capture("UNKNOWN")])).toBe("uncertain");
      expect(cancelReturnStatus(snapshot(state), [])).toBe("uncertain");
    }
  });

  it("a no-capture state is uncertain unless the capture context and every saved capture operation agree", () => {
    expect(cancelReturnStatus(snapshot("APPROVED_VERIFIED"), [])).toBe("no_capture");
    expect(cancelReturnStatus(snapshot("DECLINED_RETRYABLE"), [capture("DECLINED")])).toBe("no_capture");
    expect(cancelReturnStatus(snapshot("CANCELED_LOCAL"), [capture("REJECTED")])).toBe("canceled");
    const violations: Array<[Partial<PaymentContext>, PaymentOperation[]]> = [
      [{ captureDispatched: true }, []],
      [{ captureOperationId: "op_capture" }, []],
      [{ providerCaptureId: CAPTURE_ID }, []],
      [{}, [capture("DECLINED"), capture("SUCCEEDED")]],
      [{}, [capture("UNKNOWN")]],
      [{}, [capture("PENDING")]],
      [{}, [capture("DISPATCHING")]],
    ];
    for (const state of ["APPROVED_VERIFIED", "DECLINED_RETRYABLE", "CANCELED_LOCAL", "EXPIRED"] as const) {
      for (const [context, captures] of violations) expect(cancelReturnStatus(snapshot(state, context), captures)).toBe("uncertain");
    }
  });

  it("every payment state is classified, and only the listed pre-capture and ended states can be 'no capture'", () => {
    const noCapture = PAYMENT_STATES.filter((state) => cancelReturnStatus(snapshot(state), []) === "no_capture");
    expect(noCapture).toEqual([
      "DRAFT",
      "QUOTED",
      "USER_CONFIRMED",
      "ORDER_CREATE_IN_FLIGHT",
      "ORDER_CREATE_UNKNOWN",
      "AWAITING_APPROVAL",
      "APPROVAL_CHECK_PENDING",
      "APPROVED_VERIFIED",
      "DECLINED_RETRYABLE",
      "SUPERSEDED",
      "EXPIRED",
      "FAILED_TERMINAL",
    ]);
  });
});
