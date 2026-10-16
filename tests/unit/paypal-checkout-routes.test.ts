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
import type { PaymentState } from "@/lib/payment/state-machine";
import {
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
    const markup = (state: PaymentState) =>
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
            steps: [],
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
