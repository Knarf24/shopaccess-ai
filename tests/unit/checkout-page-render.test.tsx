import { VoiceJourneyProvider } from "@/components/mock-journey/HandsFreeControls";
import { Fragment, type ReactElement, type ReactNode } from "react";
import { renderWithAppRouter } from "./router-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { confirmPurchaseSummary, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { startCheckoutWithQuote } from "@/lib/checkout/service";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { permissionCopy } from "@/lib/i18n/permission-copy";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { sandboxCorrelationId } from "@/lib/payment/adapter-config";
import { centsToPaypalAmount, type PaypalTransport } from "@/lib/providers/paypal-sandbox";
import {
  handleNeedsSession,
  handlePermissionCreate,
  handlePermissionRevoke,
  handleSandboxApprove,
  handleSandboxCancel,
  handleSandboxCapture,
  handleSandboxReturn,
  handleSimulate,
} from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, MINUTE, TEST_SESSION_KEY } from "./helpers";

// M2-3 review findings 2–5: the real checkout page, rendered against a real in-memory runtime. Only the Next request
// context (headers, connection) and the application lookup are replaced; every payment and permission decision is real.
const page = vi.hoisted(() => ({ runtime: null as unknown, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: page.cookie }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/server/runtime-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/runtime-access")>()),
  openApplication: async () => ({ mode: "mock", runtime: { ok: true, value: page.runtime } }),
}));
const { default: CheckoutPage } = await import("@/app/[lang]/checkout/[intentId]/page");

const SITE = "https://shop.example.test";
const GO15 = { item: "dmp_aspirego15:dmv_aspirego15", productId: "dmp_aspirego15", variantId: "dmv_aspirego15" };
const en = permissionCopy("en");

function world() {
  const time = createTestClock("2026-10-17T12:00:00.000Z");
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock });
  page.runtime = runtime;
  return { runtime, time };
}

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  page.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return { cookie: page.cookie, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}
type Buyer = Awaited<ReturnType<typeof shopper>>;

const post = (path: string, fields: Record<string, string>, buyer: Buyer) =>
  new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
    body: new URLSearchParams({ csrfToken: buyer.csrfToken, ...fields }).toString(),
  });

async function permit(runtime: Runtime, buyer: Buyer, expiry = "session") {
  const response = await handlePermissionCreate(post("/shop/permissions/create", { lang: "en", item: GO15.item, quantity: "1", total: "1000", expiry }, buyer), runtime);
  expect(new URL(response.headers.get("location")!, SITE).searchParams.get("result")).toBe("created");
  return runtime.permissions.list(buyer.sessionId, runtime.clock()).find((p) => p.live)!.permissionId;
}

async function revoke(runtime: Runtime, buyer: Buyer, permissionId: string) {
  const response = await handlePermissionRevoke(post("/shop/permissions/revoke", { lang: "en", permissionId }, buyer), runtime);
  expect(new URL(response.headers.get("location")!, SITE).searchParams.get("result")).toBe("revoked");
}

async function start(runtime: Runtime, buyer: Buyer, language?: "en" | "es") {
  const started = await startCheckoutWithQuote(runtime.checkout, buyer.sessionId, { productId: GO15.productId, variantId: GO15.variantId, quantity: 1 }, language);
  if (!started.ok) throw new Error(started.error);
  return started.value;
}

async function confirm(runtime: Runtime, buyer: Buyer, quoteId: string) {
  const challenge = await prepareConfirmation(runtime.checkout, buyer.sessionId, quoteId);
  if (!challenge.ok) throw new Error(challenge.error);
  const { confirmationId, nonce, quoteDigest } = challenge.value;
  const confirmed = await confirmPurchaseSummary(runtime.checkout, buyer.sessionId, { confirmationId, nonce, quoteId, quoteDigest });
  if (!confirmed.ok) throw new Error(confirmed.error);
}

async function simulate(runtime: Runtime, buyer: Buyer, intentId: string, step: string) {
  const response = await handleSimulate(post(`/checkout/${intentId}/simulate`, { step }, buyer), runtime, intentId);
  return new URL(response.headers.get("location") ?? "/", SITE).searchParams.get("error");
}

const stateOf = async (runtime: Runtime, intentId: string) => (await runtime.store.findIntent(intentId))!.snapshot.state;

/** Renders the checkout page exactly as Next would for this request: page → Suspense → guarded content. */
async function render(intentId: string, query: Record<string, string> = {}, pathLang: "en" | "es" = "en"): Promise<string> {
  try {
    const outer = CheckoutPage({ params: Promise.resolve({ lang: pathLang, intentId }), searchParams: Promise.resolve(query) }) as ReactElement<{ children: ReactElement }>;
    const content = outer.props.children;
    const tree = await (content.type as (props: unknown) => Promise<ReactNode>)(content.props);
    return renderWithAppRouter(<VoiceJourneyProvider><Fragment>{tree}</Fragment></VoiceJourneyProvider>);
  } catch (error) {
    const url = isRedirectError(error) ? getURLFromRedirectError(error) : null;
    const next = url?.startsWith("/es/") ? "es" : url?.startsWith("/en/") ? "en" : null;
    if (!next || next === pathLang) throw error;
    return render(intentId, query, next);
  }
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]);
const alerts = (html: string) => [...html.matchAll(/<p\b[^>]*role="alert"[^>]*>([\s\S]*?)<\/p>/g)].map((match) => text(match[1]));
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) => text(match[1]));
const skipTarget = (html: string) => html.match(/<a class="skip-link" href="#([^"]+)"/)?.[1];
const SUMMARY_BELOW = /summary below|new summary below/i;

beforeEach(() => {
  page.runtime = null;
  page.cookie = "";
});

describe("checkout page: refusals describe the current condition (review findings 2–5)", () => {
  it("a valid permission: the confirmation summary, no refusal (positive control)", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await permit(runtime, buyer);
    const { intent } = await start(runtime, buyer);
    const html = await render(intent.id);
    expect(alerts(html)).toEqual([]);
    expect(html).toContain('action="/checkout/' + intent.id + '/confirm"');
    expect(skipTarget(html)).toBe("confirm-heading");
  });

  it("finding 2: an expired, superseded or unacknowledged summary does not also tell the shopper to review a summary that is not shown", async () => {
    for (const urlCode of ["CONFIRMATION_EXPIRED", "CONFIRMATION_SUPERSEDED", "ACKNOWLEDGEMENT_REQUIRED"]) {
      const { runtime } = world();
      const buyer = await shopper(runtime);
      const permissionId = await permit(runtime, buyer);
      const { intent } = await start(runtime, buyer);
      await revoke(runtime, buyer, permissionId);
      const html = await render(intent.id, { error: urlCode });
      expect(html, urlCode).not.toContain('/confirm"');
      expect(alerts(html), urlCode).toEqual([`${en.refusals.PERMISSION_REVOKED} ${en.managePermissions}`]);
      expect(html, urlCode).not.toMatch(SUMMARY_BELOW);
      expect(skipTarget(html), urlCode).toBe("checkout-alert");
    }
  });

  it("finding 3: after confirmation, a revoked permission is shown on reload and only Cancel is offered", async () => {
    for (const reach of ["USER_CONFIRMED", "AWAITING_APPROVAL", "APPROVED_VERIFIED"] as const) {
      const { runtime } = world();
      const buyer = await shopper(runtime);
      const permissionId = await permit(runtime, buyer);
      const { intent, quote } = await start(runtime, buyer);
      await confirm(runtime, buyer, quote.quoteId);
      if (reach !== "USER_CONFIRMED") expect(await simulate(runtime, buyer, intent.id, "create_order")).toBeNull();
      if (reach === "APPROVED_VERIFIED") expect(await simulate(runtime, buyer, intent.id, "buyer_approve")).toBeNull();
      expect(await stateOf(runtime, intent.id)).toBe(reach);
      await revoke(runtime, buyer, permissionId);

      const html = await render(intent.id);
      expect(alerts(html), reach).toEqual([`${en.refusals.PERMISSION_REVOKED} ${en.managePermissions}`]);
      expect(buttons(html), reach).toEqual(["Cancel this checkout"]);
      expect(skipTarget(html), reach).toBe("checkout-alert");
      expect(await stateOf(runtime, intent.id)).toBe(reach);
    }
  });

  it("decline: once the confirmation is spent, the page says so and offers only Cancel", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await permit(runtime, buyer);
    const { intent, quote } = await start(runtime, buyer);
    await confirm(runtime, buyer, quote.quoteId);
    for (const step of ["create_order", "buyer_approve", "capture_declined"]) expect(await simulate(runtime, buyer, intent.id, step), step).toBeNull();
    expect(await stateOf(runtime, intent.id)).toBe("DECLINED_RETRYABLE");
    const declined = await render(intent.id);
    expect(alerts(declined)).toEqual([`${en.refusals.CONFIRMATION_REQUIRED} ${en.managePermissions}`]);
    expect(buttons(declined)).toEqual(["Cancel this checkout"]);
    // Approval can still be reached directly (the route checks state only); the capture stays refused and is not offered.
    expect(await simulate(runtime, buyer, intent.id, "buyer_approve")).toBeNull();
    const approved = await render(intent.id);
    expect(alerts(approved)).toEqual([`${en.refusals.CONFIRMATION_REQUIRED} ${en.managePermissions}`]);
    expect(buttons(approved)).toEqual(["Cancel this checkout"]);
    expect(runtime.provider.captureCount()).toBe(1);
  });

  it("finding 4: a newer permission for the same item does not hide why the old checkout's permission ended", async () => {
    // Revoked, then a new permission created a minute later (real time moves on; the newer record must not win).
    {
      const { runtime, time } = world();
      const buyer = await shopper(runtime);
      const first = await permit(runtime, buyer);
      const { intent } = await start(runtime, buyer);
      await revoke(runtime, buyer, first);
      time.advance(MINUTE);
      await permit(runtime, buyer);
      const html = await render(intent.id);
      expect(alerts(html)).toEqual([`${en.refusals.PERMISSION_REVOKED} ${en.managePermissions}`]);
      // The old checkout's link to the revoked permission authorizes nothing and blocks nothing: a new checkout works.
      const next = await start(runtime, buyer);
      const fresh = await render(next.intent.id);
      expect(alerts(fresh)).toEqual([]);
      expect(fresh).toContain(`action="/checkout/${next.intent.id}/confirm"`);
    }
    // Expired after confirmation, then a new permission created.
    {
      const { runtime, time } = world();
      const buyer = await shopper(runtime);
      await permit(runtime, buyer, "15m");
      const { intent, quote } = await start(runtime, buyer);
      await confirm(runtime, buyer, quote.quoteId);
      time.advance(16 * MINUTE);
      await permit(runtime, buyer);
      const html = await render(intent.id);
      expect(alerts(html)).toEqual([`${en.refusals.PERMISSION_EXPIRED} ${en.managePermissions}`]);
      expect(buttons(html)).toEqual(["Cancel this checkout"]);
    }
  });

  const headingTextOf = (html: string) => text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  it("completed heading: only a verified capture shows it; pending, declined and unknown outcomes never look successful", async () => {
    for (const step of ["capture", "capture_pending", "capture_declined", "capture_lost_response"] as const) {
      const { runtime } = world();
      const buyer = await shopper(runtime);
      await permit(runtime, buyer);
      const { intent, quote } = await start(runtime, buyer);
      await confirm(runtime, buyer, quote.quoteId);
      for (const before of ["create_order", "buyer_approve", step]) expect(await simulate(runtime, buyer, intent.id, before), before).toBeNull();
      const state = await stateOf(runtime, intent.id);
      const html = await render(intent.id);
      if (step === "capture") {
        expect(state).toBe("CAPTURED_VERIFIED");
        expect(headingTextOf(html)).toBe("Purchase complete");
        expect(html).not.toContain('aria-current="step"');
        expect(html.match(/data-status="completed"/g)).toHaveLength(4);
        expect(text(html)).toContain("This was a local preview. No money moved and nothing ships.");
      } else {
        expect(state, step).not.toBe("CAPTURED_VERIFIED");
        expect(text(html), step).not.toMatch(/Purchase complete|Compra completada/);
        expect(headingTextOf(html), step).toBe("Review purchase");
      }
    }
  });

  it("finding 5: a permission code in the URL never produces 'Nothing was charged' once a capture may have been sent", async () => {
    for (const step of ["capture", "capture_pending", "capture_lost_response"] as const) {
      const { runtime } = world();
      const buyer = await shopper(runtime);
      await permit(runtime, buyer);
      const { intent, quote } = await start(runtime, buyer);
      await confirm(runtime, buyer, quote.quoteId);
      for (const before of ["create_order", "buyer_approve", step]) expect(await simulate(runtime, buyer, intent.id, before), before).toBeNull();
      const state = await stateOf(runtime, intent.id);
      for (const urlCode of ["PERMISSION_REVOKED", "PERMISSION_REQUIRED", "CONFIRMATION_REQUIRED"]) {
        const html = await render(intent.id, { error: urlCode });
        expect(html, `${step} ${urlCode}`).not.toMatch(/Nothing was charged|Nothing more was charged/);
        // Second review note: where the outcome is unproven, the manual-review warning itself must appear (and alone).
        if (state === "CAPTURE_UNKNOWN") expect(alerts(html), `${step} ${urlCode}`).toEqual([en.outcomeUnderReview]);
        else expect(alerts(html), `${step} ${urlCode}`).toEqual([]);
      }
    }
  });

  it("second review finding 4 (fixture path): an unknown order whose resend is refused shows the refusal, keeps Reconcile, sends nothing", async () => {
    // Fixture only: the order request is lost before it reaches the mock provider. The shopper's simulation steps offer
    // only a lost response (where reconcile finds the order), so this is not a demonstrated shopper-reachable path.
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const permissionId = await permit(runtime, buyer);
    const { intent, quote } = await start(runtime, buyer);
    await confirm(runtime, buyer, quote.quoteId);
    runtime.provider.failNextCreateOrder("LOSE_REQUEST");
    expect(await simulate(runtime, buyer, intent.id, "create_order")).not.toBe("STEP_NOT_AVAILABLE");
    expect(await stateOf(runtime, intent.id)).toBe("ORDER_CREATE_UNKNOWN");
    await revoke(runtime, buyer, permissionId);
    const refusedResend = await simulate(runtime, buyer, intent.id, "reconcile");
    expect(refusedResend).toBe("PERMISSION_REVOKED");
    expect(await stateOf(runtime, intent.id)).toBe("ORDER_CREATE_UNKNOWN");
    const ordersBefore = (await runtime.ledger.listForIntent(intent.id, "ORDER_CREATE")).map((operation) => operation.state);

    for (const query of [{ error: refusedResend! }, {}] as Record<string, string>[]) {
      const html = await render(intent.id, query);
      expect(alerts(html), JSON.stringify(query)).toEqual([`${en.refusals.PERMISSION_REVOKED} ${en.managePermissions}`]);
      // Reconcile only reads back (a resend stays refused); no payment step is offered.
      expect(buttons(html), JSON.stringify(query)).toEqual(["Check with the simulated provider (reconcile)"]);
      expect(skipTarget(html)).toBe("checkout-alert");
    }
    // Reconciling again still sends nothing.
    expect(await simulate(runtime, buyer, intent.id, "reconcile")).toBe("PERMISSION_REVOKED");
    expect((await runtime.ledger.listForIntent(intent.id, "ORDER_CREATE")).map((operation) => operation.state)).toEqual(ordersBefore);
    expect(runtime.provider.captureCount()).toBe(0);
  });

  it("a stale permission code in the URL is not shown when the current permission is fine", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await permit(runtime, buyer);
    const { intent, quote } = await start(runtime, buyer);
    await confirm(runtime, buyer, quote.quoteId);
    const html = await render(intent.id, { error: "PERMISSION_REVOKED" });
    expect(alerts(html)).toEqual([]);
    expect(buttons(html)).toContain("Simulate creating the order");
  });

  it("speaks the checkout's language", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const permissionId = await permit(runtime, buyer);
    const { intent, quote } = await start(runtime, buyer, "es");
    await confirm(runtime, buyer, quote.quoteId);
    await revoke(runtime, buyer, permissionId);
    const html = await render(intent.id);
    const es = permissionCopy("es");
    expect(alerts(html)).toEqual([`${es.refusals.PERMISSION_REVOKED} ${es.managePermissions}`]);
    expect(html).toContain('href="/es/shop/permissions"');
  });
});

// Second review finding 2: sandbox mode. A mocked PayPal transport (synthetic responses only; nothing leaves the test).
const PAYEE = "2ABCDEFGHJKLM";
const ORDER_ID = "5O190127TN364715T";

function sandboxWorld() {
  const queue: Array<{ status: number; body: string }> = [];
  const transport: PaypalTransport = async (request) => {
    if (request.url.endsWith("/token")) return { status: 200, body: JSON.stringify({ access_token: "synthetic-token", expires_in: 3200 }) };
    const next = queue.shift();
    if (!next) throw new Error(`unexpected PayPal call ${request.url}`);
    return next;
  };
  const time = createTestClock("2026-10-17T12:00:00.000Z");
  const runtime = createRuntime(
    {
      sessionKey: TEST_SESSION_KEY,
      trustedOrigins: parseTrustedOrigins([SITE]),
      payment: { mode: "sandbox", apiBaseUrl: "https://api-m.sandbox.paypal.com", merchantId: PAYEE, clientId: "synthetic-client", clientSecret: "synthetic-secret" },
    },
    { clock: time.clock, paymentTransport: transport },
  );
  page.runtime = runtime;
  return { runtime, queue };
}

const orderBody = (quoteId: string, totalCents: number, status: string) =>
  JSON.stringify({
    id: ORDER_ID,
    status,
    purchase_units: [{ custom_id: sandboxCorrelationId(quoteId), payee: { merchant_id: PAYEE }, amount: { currency_code: "USD", value: centsToPaypalAmount(totalCents) } }],
    links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}` }],
  });

async function sandboxApproved(runtime: Runtime, queue: Array<{ status: number; body: string }>, buyer: Buyer, language?: "en" | "es") {
  const { intent, quote } = await start(runtime, buyer, language);
  await confirm(runtime, buyer, quote.quoteId);
  queue.push({ status: 201, body: orderBody(quote.quoteId, quote.totalCents, "CREATED") });
  expect((await handleSandboxApprove(post(`/checkout/${intent.id}/approve`, {}, buyer), runtime, intent.id)).status).toBe(303);
  queue.push({ status: 200, body: orderBody(quote.quoteId, quote.totalCents, "APPROVED") });
  await handleSandboxReturn(new Request(`${SITE}/checkout/${intent.id}/return?token=${ORDER_ID}`, { headers: { cookie: buyer.cookie } }), runtime, intent.id);
  expect(await stateOf(runtime, intent.id)).toBe("APPROVED_VERIFIED");
  return { intent, quote };
}

const formActions = (html: string) => [...html.matchAll(/<form\b[^>]*action="([^"]+)"/g)].map((match) => match[1]);
const captureCalls = (runtime: Runtime) => runtime.sandbox!.outbound.filter((call) => call.url.endsWith("/capture")).length;

describe("checkout page in sandbox mode: a refusal offers the protected Cancel and no payment action", () => {
  it("revoked after PayPal approval: the refusal, Cancel only; the cancel handler then cancels without any capture", async () => {
    const { runtime, queue } = sandboxWorld();
    const buyer = await shopper(runtime);
    const permissionId = await permit(runtime, buyer);
    const { intent } = await sandboxApproved(runtime, queue, buyer);
    await revoke(runtime, buyer, permissionId);

    const html = await render(intent.id);
    expect(alerts(html)).toEqual([`${en.refusals.PERMISSION_REVOKED} ${en.managePermissions}`]);
    expect(formActions(html)).toEqual([`/checkout/${intent.id}/cancel`]);
    expect(buttons(html)).toEqual(["Cancel this checkout"]);
    expect(html).toContain(`<input type="hidden" name="csrfToken" value="${buyer.csrfToken}"/>`);

    // The capture route itself still refuses (the gate), and nothing reaches PayPal's capture endpoint.
    await handleSandboxCapture(post(`/checkout/${intent.id}/capture`, {}, buyer), runtime, intent.id);
    expect(captureCalls(runtime)).toBe(0);
    expect(await stateOf(runtime, intent.id)).toBe("APPROVED_VERIFIED");

    // The existing protected cancel handler: CSRF required, then canceled.
    expect((await handleSandboxCancel(post(`/checkout/${intent.id}/cancel`, { csrfToken: "wrong" }, buyer), runtime, intent.id)).status).toBe(403);
    expect(await stateOf(runtime, intent.id)).toBe("APPROVED_VERIFIED");
    const canceled = await handleSandboxCancel(post(`/checkout/${intent.id}/cancel`, {}, buyer), runtime, intent.id);
    expect(canceled.headers.get("location")).toBe(`/checkout/${intent.id}`);
    expect(await stateOf(runtime, intent.id)).toBe("CANCELED_LOCAL");
    const after = await render(intent.id);
    expect(alerts(after)).toEqual([]);
    expect(formActions(after)).toEqual([]);
    expect(captureCalls(runtime)).toBe(0);
  });

  it("a definitive decline: 'confirmation spent' with Cancel only; cancelling frees the permission for a new checkout", async () => {
    const { runtime, queue } = sandboxWorld();
    const buyer = await shopper(runtime);
    await permit(runtime, buyer);
    const { intent, quote } = await sandboxApproved(runtime, queue, buyer);
    queue.push({
      status: 201,
      body: JSON.stringify({
        id: "8AA12345BC678901C",
        status: "DECLINED",
        amount: { currency_code: "USD", value: centsToPaypalAmount(quote.totalCents) },
        custom_id: sandboxCorrelationId(quote.quoteId),
        payee: { merchant_id: PAYEE },
        supplementary_data: { related_ids: { order_id: ORDER_ID } },
      }),
    });
    await handleSandboxCapture(post(`/checkout/${intent.id}/capture`, {}, buyer), runtime, intent.id);
    expect(await stateOf(runtime, intent.id)).toBe("DECLINED_RETRYABLE");
    expect(captureCalls(runtime)).toBe(1);

    const html = await render(intent.id);
    expect(alerts(html)).toEqual([`${en.refusals.CONFIRMATION_REQUIRED} ${en.managePermissions}`]);
    expect(formActions(html)).toEqual([`/checkout/${intent.id}/cancel`]);
    expect(buttons(html)).toEqual(["Cancel this checkout"]);

    await handleSandboxCancel(post(`/checkout/${intent.id}/cancel`, {}, buyer), runtime, intent.id);
    expect(await stateOf(runtime, intent.id)).toBe("CANCELED_LOCAL");
    expect(runtime.permissions.list(buyer.sessionId, runtime.clock()).map((p) => p.state)).toEqual(["active"]);
    const next = await start(runtime, buyer);
    expect(await stateOf(runtime, next.intent.id)).toBe("QUOTED");
    expect(captureCalls(runtime)).toBe(1);
  });
});

// Language of parts (owner-approved correction, October 18): the checkout is marked with its resolved interface language,
// and the English-only parts of a Spanish checkout are marked English. Resolved from the rendered markup's lang attributes.
const VOID_ELEMENTS = new Set(["input", "meta", "br", "img", "hr", "link", "source", "area", "base", "col", "embed", "track", "wbr"]);

/** The language in effect at the first opening tag that matches `tag`, through its ancestors' lang (document default "en"). */
function langAt(html: string, tag: RegExp): string | null {
  const stack: Array<{ name: string; lang: string }> = [];
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [whole, closing, rawName, attributes, selfClosing] = match;
    const name = rawName.toLowerCase();
    if (closing) {
      const at = stack.map((entry) => entry.name).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    const lang = attributes.match(/\slang="([^"]+)"/)?.[1] ?? stack.at(-1)?.lang ?? "en";
    if (tag.test(whole)) return lang;
    if (!selfClosing && !VOID_ELEMENTS.has(name)) stack.push({ name, lang });
  }
  return null;
}

describe("checkout page: language of parts (language-marker correction)", () => {
  async function refusedCheckout(language?: "es") {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const permissionId = await permit(runtime, buyer);
    const { intent, quote } = await start(runtime, buyer, language);
    await confirm(runtime, buyer, quote.quoteId);
    await revoke(runtime, buyer, permissionId);
    return { runtime, buyer, intent, quote };
  }

  it("a Spanish checkout is marked Spanish: refusal, skip link, steps and catalog notice; English-only parts are marked English", async () => {
    const { intent } = await refusedCheckout("es");
    const html = await render(intent.id, { notice: "CONFIRMED" });
    expect(html).toMatch(/^<main class="guided-presentation ui-refresh" lang="es">/);
    expect(langAt(html, /id="checkout-alert"/)).toBe("es");
    expect(html).toContain(permissionCopy("es").refusals.PERMISSION_REVOKED);
    expect(langAt(html, /class="skip-link"/)).toBe("es");
    expect(langAt(html, /<ol\b/)).toBe("es");
    // Spanish since the finding 8 checkout cleanup: the page heading, the quote lines, the notice and the start link.
    expect(langAt(html, /<h1\b/)).toBe("es");
    expect(langAt(html, /id="quote-heading"/)).toBe("es");
    expect(langAt(html, /id="checkout-notice"/)).toBe("es");
    expect(langAt(html, /<a\b[^>]*href="\/"/)).toBe("es");
    // English whatever the language: the simulated payment panel and its controls.
    expect(langAt(html, /aria-labelledby="sim-heading"/)).toBe("en");
    expect(langAt(html, /<button\b/)).toBe("en");
  });

  it("a Spanish confirmation summary and a Spanish manual-review message are marked Spanish", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await permit(runtime, buyer);
    const { intent } = await start(runtime, buyer, "es");
    const quoted = await render(intent.id);
    expect(langAt(quoted, /aria-labelledby="confirm-heading"/)).toBe("es");
    expect(langAt(quoted, /id="confirm-heading"/)).toBe("es");
    expect(langAt(quoted, /class="skip-link"/)).toBe("es");

    const captured = await (async () => {
      const lost = world();
      const other = await shopper(lost.runtime);
      await permit(lost.runtime, other);
      const started = await start(lost.runtime, other, "es");
      await confirm(lost.runtime, other, started.quote.quoteId);
      for (const step of ["create_order", "buyer_approve", "capture_lost_response"]) expect(await simulate(lost.runtime, other, started.intent.id, step), step).toBeNull();
      expect(await stateOf(lost.runtime, started.intent.id)).toBe("CAPTURE_UNKNOWN");
      return render(started.intent.id, { error: "PERMISSION_REVOKED" });
    })();
    expect(alerts(captured)).toEqual([permissionCopy("es").outcomeUnderReview]);
    expect(langAt(captured, /id="checkout-alert"/)).toBe("es");
  });

  it("an English checkout is marked English and nothing is marked Spanish", async () => {
    const { intent } = await refusedCheckout();
    const html = await render(intent.id);
    expect(html).toMatch(/^<main class="guided-presentation ui-refresh" lang="en">/);
    expect(langAt(html, /id="checkout-alert"/)).toBe("en");
    expect(langAt(html, /class="skip-link"/)).toBe("en");
    expect(html).not.toContain('lang="es"');
    // No per-part markers are added to an English page: only <main> carries lang.
    expect(html.match(/\slang="/g)).toHaveLength(1);
  });
});

// Finding 8, checkout part (owner-approved October 18): the heading, quote lines, notices, errors and start link follow
// the language saved on the checkout, never the URL. English wording is unchanged. The simulated panel stays English.
describe("checkout page: wording follows the saved checkout language (finding 8)", () => {
  const ITEM_TITLE = "Acer Aspire Go 15 — 8 GB LPDDR5, 256 GB PCIe NVMe SSD";
  const ENGLISH = {
    heading: "Review purchase",
    quoteHeading: "Quote",
    quoteLine: `${ITEM_TITLE}, quantity 1, sold by ShopAccess Demo Store (simulated).`,
    total: "Total $579.99 USD. Tax and shipping are $0.00 as an assumption of this demonstration; nothing is shipped.",
    confirmed: "Your confirmation of this purchase summary was recorded. No payment has been taken.",
    back: "Back to the start",
  };
  const SPANISH = {
    heading: "Revisar compra",
    quoteHeading: "Cotización",
    quoteLine: `${ITEM_TITLE}, cantidad 1, vendido por ShopAccess Demo Store (simulada).`,
    total: "Total $579.99 USD. Los impuestos y el envío son 0,00 USD como supuesto de esta demostración; no se envía nada.",
    confirmed: "Se registró su confirmación de este resumen de compra. No se ha cobrado ningún pago.",
    back: "Volver al inicio",
  };

  async function confirmedCheckout(language?: "es") {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await permit(runtime, buyer);
    const { intent, quote } = await start(runtime, buyer, language);
    await confirm(runtime, buyer, quote.quoteId);
    return intent;
  }
  const headingText = (html: string, pattern: RegExp) => text(html.match(pattern)?.[1] ?? "");

  it("a Spanish checkout: heading, quote, notice and start link in Spanish; the English product name and simulated panel marked English", async () => {
    const intent = await confirmedCheckout("es");
    const html = await render(intent.id, { notice: "CONFIRMED" });
    const visible = text(html);
    expect(headingText(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/)).toBe(SPANISH.heading);
    expect(headingText(html, /id="quote-heading"[^>]*>([\s\S]*?)<\/h2>/)).toBe(SPANISH.quoteHeading);
    for (const line of [SPANISH.quoteLine, SPANISH.total, SPANISH.confirmed, SPANISH.back]) expect(visible, line).toContain(line);
    for (const line of [ENGLISH.heading, ENGLISH.quoteLine, ENGLISH.total, ENGLISH.confirmed, ENGLISH.back]) expect(visible, line).not.toContain(line);
    expect(langAt(html, /<h1\b/)).toBe("es");
    expect(langAt(html, /id="quote-heading"/)).toBe("es");
    expect(langAt(html, /id="checkout-notice"/)).toBe("es");
    expect(langAt(html, /<a\b[^>]*href="\/"/)).toBe("es");
    expect(html).toContain(`<span lang="en">${ITEM_TITLE}</span>, cantidad`);
    expect(langAt(html, /aria-labelledby="sim-heading"/)).toBe("en");
  });

  it("an English checkout keeps today's wording and markup: only <main> carries lang", async () => {
    const intent = await confirmedCheckout();
    const html = await render(intent.id, { notice: "CONFIRMED" });
    const visible = text(html);
    expect(html).toContain('<h1 class="text-3xl font-semibold">Review purchase</h1>');
    expect(headingText(html, /id="quote-heading"[^>]*>([\s\S]*?)<\/h2>/)).toBe(ENGLISH.quoteHeading);
    for (const line of [ENGLISH.quoteLine, ENGLISH.total, ENGLISH.confirmed, ENGLISH.back]) expect(visible, line).toContain(line);
    expect(html.match(/\slang="/g)).toHaveLength(1);
  });

  it("the URL cannot change the language: ?lang on either checkout renders the same page", async () => {
    const spanish = await confirmedCheckout("es");
    const asSpanish = await render(spanish.id, { notice: "CONFIRMED" });
    expect(text(asSpanish)).toContain(SPANISH.heading);
    expect(await render(spanish.id, { notice: "CONFIRMED", lang: "en" })).toBe(asSpanish);
    expect(await render(spanish.id, { notice: "CONFIRMED" }, "en")).toBe(asSpanish);
    const english = await confirmedCheckout();
    const asEnglish = await render(english.id, { notice: "CONFIRMED" });
    expect(await render(english.id, { notice: "CONFIRMED", lang: "es" })).toBe(asEnglish);
    expect(await render(english.id, { notice: "CONFIRMED" }, "es")).toBe(asEnglish);
    expect(asEnglish).not.toContain('lang="es"');
  });

  it("another session's Spanish checkout is not found and does not reveal that language", async () => {
    const { runtime } = world();
    const owner = await shopper(runtime);
    await permit(runtime, owner);
    const { intent } = await start(runtime, owner, "es");
    const other = await shopper(runtime);
    page.cookie = other.cookie;
    for (const pathLang of ["en", "es"] as const) {
      let thrown: unknown;
      try {
        const outer = CheckoutPage({ params: Promise.resolve({ lang: pathLang, intentId: intent.id }), searchParams: Promise.resolve({}) }) as ReactElement<{ children: ReactElement }>;
        const content = outer.props.children;
        await (content.type as (props: unknown) => Promise<ReactNode>)(content.props);
      } catch (error) {
        thrown = error;
      }
      expect(isRedirectError(thrown) ? getURLFromRedirectError(thrown) : null).toBeNull();
      expect(String(thrown)).toContain("404");
      expect(String(thrown)).not.toContain("Revisar compra");
    }
  });

  it("errors: Spanish where translated, English text marked English otherwise, and a Spanish generic message for unknown codes", async () => {
    const spanish = await confirmedCheckout("es");
    const acknowledgement = await render(spanish.id, { error: "ACKNOWLEDGEMENT_REQUIRED" });
    expect(alerts(acknowledgement)).toEqual(["Marque la casilla para indicar que revisó el resumen antes de confirmar."]);
    expect(langAt(acknowledgement, /id="checkout-alert"/)).toBe("es");
    const simulationOnly = await render(spanish.id, { error: "STEP_NOT_AVAILABLE" });
    expect(alerts(simulationOnly)).toEqual(["That simulation step is not available in the current state."]);
    expect(langAt(simulationOnly, /id="checkout-alert"/)).toBe("en");
    const unknown = await render(spanish.id, { error: "NOT_A_REAL_CODE" });
    expect(alerts(unknown)).toEqual(["No se pudo completar esa acción."]);
    expect(langAt(unknown, /id="checkout-alert"/)).toBe("es");

    const english = await confirmedCheckout();
    expect(alerts(await render(english.id, { error: "ACKNOWLEDGEMENT_REQUIRED" }))).toEqual(["Tick the box to show you reviewed the summary before confirming."]);
    expect(alerts(await render(english.id, { error: "NOT_A_REAL_CODE" }))).toEqual(["That action could not be completed."]);
  });
});

// Codex review of the Spanish checkout patch, finding 1: a code that is not one of the checkout's own messages, including
// Object.prototype names, renders the generic message in either language, never an inherited property.
describe("checkout page: unknown and prototype-named message codes (Codex finding 1)", () => {
  const GENERIC = { en: "That action could not be completed.", es: "No se pudo completar esa acción." };
  for (const language of ["en", "es"] as const) {
    it(`${language}: __proto__, constructor, toString and hasOwnProperty give the generic message as an error and as a notice`, async () => {
      const { runtime } = world();
      const buyer = await shopper(runtime);
      await permit(runtime, buyer);
      const { intent, quote } = await start(runtime, buyer, language === "es" ? "es" : undefined);
      await confirm(runtime, buyer, quote.quoteId);
      for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        const asError = await render(intent.id, { error: code });
        expect(alerts(asError), code).toEqual([GENERIC[language]]);
        expect(langAt(asError, /id="checkout-alert"/), code).toBe(language);
        const asNotice = await render(intent.id, { notice: code });
        expect(text(asNotice.match(/id="checkout-notice"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ""), code).toBe(GENERIC[language]);
      }
    });
  }
});

// Codex review of the Spanish checkout patch, finding 2: after a provider-proven capture decline the page explains the
// decline from the saved DECLINED_RETRYABLE state. The capture handler's URL code (APPROVAL_NOT_CONFIRMED) would say the
// buyer's approval is missing, which is false here, so it is not shown. Mocked transport; nothing leaves the test.
describe("checkout page in sandbox mode: a provider-proven capture decline is explained from saved state (Codex finding 2)", () => {
  const DECLINED = {
    en: "PayPal Sandbox declined the payment when it was captured, after the order was approved. No payment was captured.",
    es: "El entorno de pruebas de PayPal rechazó el pago al capturarlo, después de aprobarse el pedido. No se capturó ningún pago.",
  };
  for (const language of ["en", "es"] as const) {
    it(`${language}: the real capture handler and page show the decline, not missing approval, and keep the existing controls`, async () => {
      const { runtime, queue } = sandboxWorld();
      const buyer = await shopper(runtime);
      await permit(runtime, buyer);
      const { intent, quote } = await sandboxApproved(runtime, queue, buyer, language === "es" ? "es" : undefined);
      const sandboxCopy = journeyCopy(language).sandboxCheckout;
      const refusalCopy = permissionCopy(language);
      // Before the capture, no decline wording.
      expect(text(await render(intent.id))).not.toContain(DECLINED[language]);

      queue.push({
        status: 201,
        body: JSON.stringify({
          id: "8AA12345BC678901C",
          status: "DECLINED",
          amount: { currency_code: "USD", value: centsToPaypalAmount(quote.totalCents) },
          custom_id: sandboxCorrelationId(quote.quoteId),
          payee: { merchant_id: PAYEE },
          supplementary_data: { related_ids: { order_id: ORDER_ID } },
        }),
      });
      const response = await handleSandboxCapture(post(`/checkout/${intent.id}/capture`, {}, buyer), runtime, intent.id);
      expect(await stateOf(runtime, intent.id)).toBe("DECLINED_RETRYABLE");
      expect(captureCalls(runtime)).toBe(1);

      // The page the browser lands on, with whatever the handler put in the URL; then the URL codes a visitor could add.
      const landing = Object.fromEntries(new URL(response.headers.get("location")!, SITE).searchParams);
      for (const query of [landing, {}, { error: "APPROVAL_NOT_CONFIRMED" }, { error: "PAYEE_MISMATCH" }, { notice: "CAPTURED" }]) {
        const html = await render(intent.id, query);
        const visible = text(html);
        const label = `${language} ${JSON.stringify(query)}`;
        expect(visible, label).toContain(DECLINED[language]);
        expect(langAt(html, /aria-labelledby="sandbox-heading"/), label).toBe(language);
        expect(visible, label).not.toContain(sandboxCopy.approvalNotConfirmed);
        expect(visible, label).not.toContain(sandboxCopy.unknown);
        expect(visible, label).not.toContain(sandboxCopy.captured);
        // Existing controls are unchanged: the spent-confirmation refusal and the protected Cancel only.
        expect(alerts(html), label).toEqual([`${refusalCopy.refusals.CONFIRMATION_REQUIRED} ${refusalCopy.managePermissions}`]);
        expect(formActions(html), label).toEqual([`/checkout/${intent.id}/cancel`]);
        expect(buttons(html), label).toEqual([sandboxCopy.cancel]);
      }
      expect(captureCalls(runtime)).toBe(1);
    });
  }
});
