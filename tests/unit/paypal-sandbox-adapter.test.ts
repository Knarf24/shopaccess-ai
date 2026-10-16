import { describe, expect, it } from "vitest";
import type { Result } from "@/lib/shared/result";
import { DEMO_CATALOG_MERCHANT_ID, sandboxCorrelationId } from "@/lib/payment/adapter-config";
import { validateCaptureEvidence, type CaptureEvidenceRejection } from "@/lib/payment/capture-evidence";
import { dispatchCapture, dispatchOrderCreate, observeCaptureAftermath, verifyApproval } from "@/lib/payment/orchestrator";
import {
  captureEvidenceFromPaypal,
  centsToPaypalAmount,
  paypalAmountToCents,
  PayPalSandboxProvider,
  RETRY_CUTOFF_MS,
  validateApprovalUrl,
  type PaypalTransport,
} from "@/lib/providers/paypal-sandbox";
import { confirmedIntent, createWorld, newSession, stateOf } from "./helpers";

const PAYEE = "2ABCDEFGHJKLM";
const ORDER_ID = "5O190127TN364715T";
const CAPTURE_ID = "8AA12345BC678901C";
const OTHER_CAPTURE = "9BB12345BC678901D";
const QUOTE_ID = `qt_${"ab".repeat(16)}`;
const INTENT_ID = `ci_${"cd".repeat(16)}`;
const REQUEST_ID = `rq_${"ef".repeat(16)}`;
const ORIGIN = "https://shop.example.test";
const AMOUNT = 44900;

function clockFrom(start = Date.parse("2026-10-14T12:00:00.000Z")) {
  let now = start;
  return {
    clock: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  };
}

function tokenBody() {
  return { status: 200, body: JSON.stringify({ access_token: "synthetic-token", expires_in: 3200 }) };
}

function orderJson(status: string, extra: Record<string, unknown> = {}, id = ORDER_ID) {
  return JSON.stringify({
    id,
    status,
    purchase_units: [
      {
        custom_id: sandboxCorrelationId(QUOTE_ID),
        payee: { merchant_id: PAYEE },
        amount: { currency_code: "USD", value: "449.00" },
        ...extra,
      },
    ],
    links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
  });
}

function captureJson(id = CAPTURE_ID, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id,
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "449.00" },
    custom_id: sandboxCorrelationId(QUOTE_ID),
    payee: { merchant_id: PAYEE },
    supplementary_data: { related_ids: { order_id: ORDER_ID } },
    ...extra,
  });
}

function provider(transport: PaypalTransport, time = clockFrom(), timeoutMs = 10_000) {
  return new PayPalSandboxProvider({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    merchantId: PAYEE,
    clock: time.clock,
    timeoutMs,
    transport,
  });
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    amountCents: AMOUNT,
    currency: "USD",
    merchantId: DEMO_CATALOG_MERCHANT_ID,
    quoteId: QUOTE_ID,
    intentId: INTENT_ID,
    returnOrigin: ORIGIN,
    ...overrides,
  };
}

const expected = {
  providerRequestId: REQUEST_ID,
  providerOrderId: ORDER_ID,
  totalCents: AMOUNT,
  currency: "USD",
  merchantId: DEMO_CATALOG_MERCHANT_ID,
  knownCaptureId: null,
  paypalMerchantId: PAYEE,
  correlationId: sandboxCorrelationId(QUOTE_ID),
};

describe("PayPal sandbox adapter", () => {
  it("maps only the demo seller and refuses every other merchant before a request", async () => {
    const calls: string[] = [];
    const sandbox = provider(async (request) => {
      calls.push(request.url);
      return tokenBody();
    });
    const refused = await sandbox.createOrder(createRequest({ merchantId: "dmm_othercatalog" }));
    expect(refused).toEqual({ kind: "REJECTED", code: "MERCHANT_NOT_MAPPED" });
    expect(calls).toEqual([]);

    const created = await sandbox.createOrder(createRequest());
    expect(created.kind).toBe("NO_RESPONSE");
    const body = sandbox.outbound.find((call) => call.url.endsWith("/v2/checkout/orders"))?.body ?? "";
    expect(body).toContain(`"payee":{"merchant_id":"${PAYEE}"}`);
    expect(body).toContain(`"custom_id":"${sandboxCorrelationId(QUOTE_ID)}"`);
    expect(body).not.toContain("application_context");
    expect(body).not.toContain(`"merchant_id":"${DEMO_CATALOG_MERCHANT_ID}"`);
  });

  it("keeps payee identity and custom_id as separate checks and does not invent refund or dispute observations", () => {
    const base = {
      requestId: REQUEST_ID,
      localMerchantId: DEMO_CATALOG_MERCHANT_ID,
      orderId: ORDER_ID,
      capture: {
        id: CAPTURE_ID,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "449.00" },
        seller_receivable_breakdown: { paypal_fee: { currency_code: "USD", value: "13.02" } },
        seller_protection: { dispute_categories: ["ITEM_NOT_RECEIVED"] },
      },
      payeeMerchantId: PAYEE,
      correlationId: sandboxCorrelationId(QUOTE_ID),
    };
    const matched = validateCaptureEvidence(captureEvidenceFromPaypal(base), expected);
    expect(matched.ok).toBe(true);
    if (matched.ok) {
      expect(matched.value.refundedCents).toBeNull();
      expect(matched.value.reversedOrDisputed).toBeNull();
      expect(matched.value.merchantId).toBe(DEMO_CATALOG_MERCHANT_ID);
      expect(matched.value.paypalMerchantId).toBe(PAYEE);
    }
    expect(rejection(validateCaptureEvidence(captureEvidenceFromPaypal({ ...base, payeeMerchantId: undefined }), expected))).toBe("PAYEE_MISMATCH");
    expect(rejection(validateCaptureEvidence(captureEvidenceFromPaypal({ ...base, payeeMerchantId: "3XXXXXXXXXXXX" }), expected))).toBe("PAYEE_MISMATCH");
    expect(rejection(validateCaptureEvidence(captureEvidenceFromPaypal({ ...base, correlationId: "other-token" }), expected))).toBe("CORRELATION_MISMATCH");
    for (const status of ["FAILED", "PARTIALLY_REFUNDED", "REFUNDED"]) {
      const rejected = validateCaptureEvidence(captureEvidenceFromPaypal({ ...base, capture: { ...base.capture, status } }), expected);
      expect(rejection(rejected), status).toBe("EVIDENCE_INCOMPLETE");
    }
    const mockEvidence = {
      captureId: CAPTURE_ID,
      requestId: REQUEST_ID,
      orderId: ORDER_ID,
      status: "COMPLETED",
      amountCents: AMOUNT,
      currency: "USD",
      merchantId: DEMO_CATALOG_MERCHANT_ID,
      refundedCents: 0,
      reversedOrDisputed: false,
    };
    const mockVerdict = validateCaptureEvidence(mockEvidence, { ...expected, paypalMerchantId: undefined, correlationId: undefined });
    expect(mockVerdict.ok).toBe(true);
    if (mockVerdict.ok) {
      expect(mockVerdict.value.refundedCents).toBe(0);
      expect(mockVerdict.value.reversedOrDisputed).toBe(false);
    }
  });

  it("converts cents without binary floating point and rejects other spellings", () => {
    expect(centsToPaypalAmount(44900)).toBe("449.00");
    expect(centsToPaypalAmount(449)).toBe("4.49");
    expect(paypalAmountToCents("449.00")).toBe(44900);
    for (const spelling of ["449", "449.0", "449.000", "+449.00", "-1.00", "1e2", "4,449.00", "449.001"]) {
      expect(paypalAmountToCents(spelling), spelling).toBeNull();
    }
  });

  it("accepts only the sandbox approval URL", () => {
    const href = `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`;
    expect(validateApprovalUrl(href, ORDER_ID)).toBe(href);
    expect(validateApprovalUrl(`https://user:pass@www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`, ORDER_ID)).toBeNull();
    expect(validateApprovalUrl(`http://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`, ORDER_ID)).toBeNull();
    expect(validateApprovalUrl(`https://www.paypal.com/checkoutnow?token=${ORDER_ID}`, ORDER_ID)).toBeNull();
    expect(validateApprovalUrl(`https://api-m.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`, ORDER_ID)).toBeNull();
    expect(validateApprovalUrl(`https://www.sandbox.paypal.com/checkout?token=${ORDER_ID}`, ORDER_ID)).toBeNull();
    expect(validateApprovalUrl(`https://www.sandbox.paypal.com/checkoutnow?token=OTHER&extra=1`, ORDER_ID)).toBeNull();
  });

  it("normalizes create statuses and does not treat a create response as approval or capture", async () => {
    const cases = [
      ["CREATED", "RESPONSE", true],
      ["PAYER_ACTION_REQUIRED", "RESPONSE", true],
      ["APPROVED", "RESPONSE", false],
      ["COMPLETED", "NO_RESPONSE", false],
      ["SAVED", "NO_RESPONSE", false],
      ["VOIDED", "NO_RESPONSE", false],
      ["UNKNOWN", "NO_RESPONSE", false],
    ] as const;
    for (const [status, kind, redirect] of cases) {
      const sandbox = provider(async (request) => (request.url.endsWith("/token") ? tokenBody() : { status: 201, body: orderJson(status) }));
      const result = await sandbox.createOrder(createRequest({ requestId: `rq_${status.toLowerCase().padEnd(32, "0").slice(0, 32)}` }));
      expect(result.kind, status).toBe(kind);
      if (result.kind === "RESPONSE") {
        expect(result.value.status).toBe("CREATED");
        expect(result.value.reportedStatus).toBe(status);
        expect(result.value.approvalUrl ? true : false).toBe(redirect);
      }
      expect(sandbox.outbound.some((call) => call.url.includes("/capture"))).toBe(false);
    }
  });

  it("sends Prefer only on create and capture posts", async () => {
    const steps = [tokenBody, () => ({ status: 201, body: orderJson("CREATED") }), tokenBody, () => ({ status: 200, body: orderJson("APPROVED") })];
    const sandbox = provider(async (request) => {
      const next = steps.shift();
      if (!next) throw new Error(request.url);
      return next();
    });
    await sandbox.createOrder(createRequest());
    await sandbox.getOrder(ORDER_ID);
    const posts = sandbox.outbound.filter((call) => call.method === "POST" && call.url.endsWith("/v2/checkout/orders"));
    const reads = sandbox.outbound.filter((call) => call.method === "GET");
    expect(posts.every((call) => call.prefer === "return=representation")).toBe(true);
    expect(reads.every((call) => call.prefer === null)).toBe(true);
  });

  it("refuses a get that lacks required evidence or payee", async () => {
    const bodies = [
      orderJson("APPROVED").replace('"449.00"', '"449"'),
      JSON.stringify({ id: ORDER_ID, status: "APPROVED", purchase_units: [{ custom_id: sandboxCorrelationId(QUOTE_ID), amount: { currency_code: "USD", value: "449.00" } }] }),
    ];
    for (const body of bodies) {
      const sandbox = provider(async (request) => (request.url.endsWith("/token") ? tokenBody() : request.method === "POST" ? { status: 201, body: orderJson("CREATED") } : { status: 200, body }));
      await sandbox.createOrder(createRequest());
      expect((await sandbox.getOrder(ORDER_ID)).kind).toBe("UNAVAILABLE");
    }
  });

  it("replays a lost create with the same request id and discards an HTTP 201 replay", async () => {
    let phase: "lose" | "created" | "replay" = "lose";
    const sandbox = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      if (phase === "lose") return { status: 500, body: "" };
      if (phase === "created") return { status: 201, body: orderJson("CREATED", {}, "NEW1234567890ORDER1") };
      return { status: 200, body: orderJson("CREATED") };
    });
    expect((await sandbox.createOrder(createRequest())).kind).toBe("NO_RESPONSE");
    phase = "created";
    expect((await sandbox.getOrderByRequestId(REQUEST_ID)).kind).toBe("UNAVAILABLE");
    expect(sandbox.approvalUrlFor("NEW1234567890ORDER1")).toBeNull();
    phase = "replay";
    const found = await sandbox.getOrderByRequestId(REQUEST_ID);
    expect(found.kind).toBe("FOUND");
    if (found.kind === "FOUND") expect(found.value.orderId).toBe(ORDER_ID);
  });

  it("reads a stored order with GET and treats HTTP 404 as not found", async () => {
    let get = false;
    const sandbox = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      if (request.method === "POST") return { status: 201, body: orderJson("CREATED") };
      get = true;
      return { status: 404, body: "{}" };
    });
    await sandbox.createOrder(createRequest());
    const posts = sandbox.outbound.filter((call) => call.method === "POST" && call.url.includes("/v2/checkout/orders")).length;
    expect((await sandbox.getOrderByRequestId(REQUEST_ID)).kind).toBe("NOT_FOUND");
    expect(get).toBe(true);
    expect(sandbox.outbound.filter((call) => call.method === "POST" && call.url.includes("/v2/checkout/orders"))).toHaveLength(posts);
  });

  it("treats a capture HTTP 200 with no stored capture id as unavailable and keeps the reviewed replay rule", async () => {
    const sandbox = await createdProvider();
    const captureRequest = { requestId: `rq_${"a1".repeat(16)}`, orderId: ORDER_ID };
    const anonymous = await sandbox.captureOrder(captureRequest);
    expect(anonymous.kind).toBe("NO_RESPONSE");
    const again = await sandbox.captureOrder(captureRequest);
    expect(again.kind).toBe("NO_RESPONSE");
    expect((await sandbox.getCaptureByRequestId("rq_missing")).kind).toBe("UNAVAILABLE");

    let capturePosts = 0;
    const stored = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      if (request.url.endsWith("/capture")) {
        capturePosts += 1;
        return capturePosts === 1 ? { status: 201, body: captureJson() } : { status: 200, body: captureJson() };
      }
      return { status: 201, body: orderJson("CREATED") };
    });
    await stored.createOrder(createRequest({ requestId: `rq_${"b2".repeat(16)}` }));
    const first = await stored.captureOrder({ requestId: `rq_${"c3".repeat(16)}`, orderId: ORDER_ID });
    expect(first.kind).toBe("RESPONSE");
    const replay = await stored.captureOrder({ requestId: `rq_${"c3".repeat(16)}`, orderId: ORDER_ID });
    expect(replay.kind).toBe("RESPONSE");
    if (replay.kind === "RESPONSE") expect(replay.value.captureId).toBe(CAPTURE_ID);
    const changed = validateCaptureEvidence(
      { ...expectedCaptureBody(), captureId: OTHER_CAPTURE },
      { ...expected, providerRequestId: `rq_${"c3".repeat(16)}`, knownCaptureId: CAPTURE_ID },
    );
    expect(rejection(changed)).toBe("CAPTURE_ID_CHANGED");
  });

  it("closes posts at the cutoff and does not reopen them", async () => {
    const time = clockFrom();
    let mode: "lose" | "answer" = "lose";
    const sandbox = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      if (mode === "lose") return { status: 500, body: "" };
      return { status: 200, body: orderJson("CREATED") };
    }, time);
    expect((await sandbox.createOrder(createRequest())).kind).toBe("NO_RESPONSE");
    time.advance(RETRY_CUTOFF_MS);
    mode = "answer";
    expect((await sandbox.getOrderByRequestId(REQUEST_ID)).kind).toBe("UNAVAILABLE");
    time.set(Date.parse("2026-10-14T12:00:00.000Z") + 60_000);
    expect((await sandbox.getOrderByRequestId(REQUEST_ID)).kind).toBe("UNAVAILABLE");
    expect(sandbox.outbound.filter((call) => call.url.endsWith("/v2/checkout/orders"))).toHaveLength(1);
  });

  it("does not refresh or retry when a 401 reaches the cutoff, and limits a 401 to one refresh", async () => {
    const time = clockFrom();
    let orders = 0;
    const closed = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      orders += 1;
      time.advance(RETRY_CUTOFF_MS);
      return { status: 401, body: "{}" };
    }, time);
    expect((await closed.createOrder(createRequest())).kind).toBe("NO_RESPONSE");
    expect(orders).toBe(1);
    expect(closed.outbound.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
    time.set(Date.parse("2026-10-14T12:00:00.000Z") + 1_000);
    expect((await closed.getOrderByRequestId(REQUEST_ID)).kind).toBe("UNAVAILABLE");
    expect(closed.outbound.filter((call) => call.url.endsWith("/v2/checkout/orders"))).toHaveLength(1);

    let orderStatus = 401;
    const refreshed = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      const status = orderStatus;
      orderStatus = 201;
      return { status, body: status === 201 ? orderJson("CREATED") : "{}" };
    });
    expect((await refreshed.createOrder(createRequest({ requestId: `rq_${"d4".repeat(16)}` }))).kind).toBe("RESPONSE");
    expect(refreshed.outbound.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);
    expect(refreshed.outbound.filter((call) => call.url.endsWith("/v2/checkout/orders"))).toHaveLength(2);

    let seen = 0;
    const second = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      seen += 1;
      return { status: 401, body: "{}" };
    });
    expect((await second.createOrder(createRequest({ requestId: `rq_${"e5".repeat(16)}` }))).kind).toBe("NO_RESPONSE");
    expect(seen).toBe(2);
    expect(second.outbound.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);

    const tokenRejected = provider(async () => ({ status: 401, body: "{}" }));
    expect((await tokenRejected.createOrder(createRequest({ requestId: `rq_${"f6".repeat(16)}` }))).kind).toBe("NO_RESPONSE");
    expect(tokenRejected.outbound.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
    expect(tokenRejected.outbound.some((call) => call.url.includes("/v2/checkout/orders"))).toBe(false);
  });

  it("refreshes once and retries one Orders GET after HTTP 401", async () => {
    let gets = 0;
    const sandbox = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      if (request.method === "POST") return { status: 201, body: orderJson("CREATED") };
      gets += 1;
      if (gets === 1) return { status: 401, body: orderJson("APPROVED") };
      return { status: 200, body: orderJson("APPROVED") };
    });
    expect((await sandbox.createOrder(createRequest())).kind).toBe("RESPONSE");
    const read = await sandbox.getOrder(ORDER_ID);
    expect(read.kind).toBe("FOUND");
    if (read.kind === "FOUND") expect(read.value.reportedStatus).toBe("APPROVED");
    const orderGets = sandbox.outbound.filter((call) => call.method === "GET" && call.url.endsWith(`/v2/checkout/orders/${ORDER_ID}`));
    expect(orderGets).toHaveLength(2);
    expect(orderGets.every((call) => call.prefer === null)).toBe(true);
    expect(sandbox.outbound.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);
  });

  it("stops after a second Orders GET 401 without another token or another GET", async () => {
    let gets = 0;
    const sandbox = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      if (request.method === "POST") return { status: 201, body: orderJson("CREATED") };
      gets += 1;
      return { status: 401, body: orderJson("APPROVED") };
    });
    expect((await sandbox.createOrder(createRequest({ requestId: `rq_${"a1".repeat(16)}` }))).kind).toBe("RESPONSE");
    expect((await sandbox.getOrder(ORDER_ID)).kind).toBe("UNAVAILABLE");
    expect(gets).toBe(2);
    expect(sandbox.outbound.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(sandbox.outbound.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);
  });

  it("treats a stalled Orders GET body as unknown and does not parse it", async () => {
    const started = Date.now();
    let gets = 0;
    const sandbox = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      if (request.method === "POST") return { status: 201, body: orderJson("CREATED") };
      gets += 1;
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return { status: 200, body: orderJson("APPROVED") };
    }, clockFrom(), 25);
    expect((await sandbox.createOrder(createRequest({ requestId: `rq_${"b2".repeat(16)}` }))).kind).toBe("RESPONSE");
    expect((await sandbox.getOrder(ORDER_ID)).kind).toBe("UNAVAILABLE");
    expect(gets).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not refresh or retry an Orders GET when closure is reached first, and still reads the stored order afterward", async () => {
    const time = clockFrom();
    let gets = 0;
    const sandbox = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      if (request.method === "POST") return { status: 201, body: orderJson("CREATED") };
      gets += 1;
      if (gets === 1) {
        time.advance(RETRY_CUTOFF_MS);
        return { status: 401, body: orderJson("APPROVED") };
      }
      return { status: 200, body: orderJson("APPROVED") };
    }, time);
    expect((await sandbox.createOrder(createRequest({ requestId: `rq_${"c7".repeat(16)}` }))).kind).toBe("RESPONSE");
    expect((await sandbox.getOrder(ORDER_ID)).kind).toBe("UNAVAILABLE");
    expect(gets).toBe(1);
    expect(sandbox.outbound.filter((call) => call.method === "GET")).toHaveLength(1);
    expect(sandbox.outbound.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);

    time.set(Date.parse("2026-10-14T12:00:00.000Z") + 1_000);
    const read = await sandbox.getOrder(ORDER_ID);
    expect(read.kind).toBe("FOUND");
    if (read.kind === "FOUND") expect(read.value.reportedStatus).toBe("APPROVED");
    expect(gets).toBe(2);
    const calls = sandbox.outbound;
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);
    expect(calls.at(-2)?.url.endsWith("/token")).toBe(true);
    expect(calls.at(-1)?.method).toBe("GET");
  });

  it("aborts a stalled response body without parsing it", async () => {
    const started = Date.now();
    let mode: "stall" | "created" = "stall";
    const sandbox = provider(async (request) => {
      if (request.url.endsWith("/token")) return tokenBody();
      if (mode === "stall") {
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return { status: 201, body: orderJson("CREATED", {}, "STALLEDORDER123456789012345678901234") };
    }, clockFrom(), 25);
    expect((await sandbox.createOrder(createRequest())).kind).toBe("NO_RESPONSE");
    expect(Date.now() - started).toBeLessThan(1_000);
    mode = "created";
    expect((await sandbox.getOrderByRequestId(REQUEST_ID)).kind).toBe("UNAVAILABLE");
    expect(sandbox.approvalUrlFor("STALLEDORDER123456789012345678901234")).toBeNull();
  });

  it("verifies only an exact approved readback and leaves omitted refund evidence unobserved", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, quote } = await confirmedIntent(world, session.id);
    const amount = centsToPaypalAmount(quote.totalCents);
    const correlation = sandboxCorrelationId(quote.quoteId);
    const bodies: Array<{ status: number; body: string }> = [];
    const sandbox = new PayPalSandboxProvider({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      merchantId: PAYEE,
      clock: world.time.clock,
      transport: async (request) => {
        if (request.url.endsWith("/token")) return tokenBody();
        const next = bodies.shift();
        if (!next) throw new Error(`unexpected ${request.method} ${request.url}`);
        return next;
      },
    });
    sandbox.armReturnOrigin(intentId, ORIGIN);
    const deps = { ...world.payment(), provider: sandbox, paypalMerchantId: PAYEE };
    const order = (status: string, httpStatus: number, captures?: unknown[]) => ({
      status: httpStatus,
      body: JSON.stringify({
        id: ORDER_ID,
        status,
        purchase_units: [
          {
            custom_id: correlation,
            payee: { merchant_id: PAYEE },
            amount: { currency_code: "USD", value: amount },
            ...(captures ? { payments: { captures } } : {}),
          },
        ],
        links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}` }],
      }),
    });
    bodies.push(order("CREATED", 201));
    const created = await dispatchOrderCreate(deps, intentId);
    if (!created.ok) throw new Error(created.error);
    expect(created.value).toBe("AWAITING_APPROVAL");
    expect(await stateOf(world, intentId)).toBe("AWAITING_APPROVAL");

    bodies.push(order("PAYER_ACTION_REQUIRED", 200));
    await verifyApproval(deps, intentId);
    expect(await stateOf(world, intentId)).toBe("AWAITING_APPROVAL");

    bodies.push(order("APPROVED", 200));
    const approved = await verifyApproval(deps, intentId);
    if (!approved.ok) throw new Error(approved.error);
    expect(approved.value).toBe("APPROVED_VERIFIED");

    bodies.push({
      status: 201,
      body: JSON.stringify({
        id: CAPTURE_ID,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: amount },
        custom_id: correlation,
        payee: { merchant_id: PAYEE },
        supplementary_data: { related_ids: { order_id: ORDER_ID } },
        seller_receivable_breakdown: { paypal_fee: { value: "1.00" } },
      }),
    });
    const captured = await dispatchCapture(deps, intentId);
    if (!captured.ok) throw new Error(captured.error);
    expect(captured.value).toBe("CAPTURED_VERIFIED");
    bodies.push(order("COMPLETED", 200, [{ id: CAPTURE_ID, status: "COMPLETED", amount: { currency_code: "USD", value: amount } }]));
    const aftermath = await observeCaptureAftermath(deps, intentId);
    if (!aftermath.ok) throw new Error(aftermath.error);
    expect(aftermath.value).toBe("CAPTURED_VERIFIED");
    const transitions = await world.store.listTransitions(intentId);
    expect(transitions.some((record) => record.eventType === "REFUND_OBSERVED" || record.eventType === "REVERSAL_OR_DISPUTE_OBSERVED")).toBe(false);
  });
});

function rejection(result: Result<unknown, CaptureEvidenceRejection>): CaptureEvidenceRejection {
  if (result.ok) throw new Error("expected the evidence to be rejected");
  return result.error;
}

function expectedCaptureBody() {
  return captureEvidenceFromPaypal({
    requestId: `rq_${"c3".repeat(16)}`,
    localMerchantId: DEMO_CATALOG_MERCHANT_ID,
    orderId: ORDER_ID,
    capture: { id: CAPTURE_ID, status: "COMPLETED", amount: { currency_code: "USD", value: "449.00" } },
    payeeMerchantId: PAYEE,
    correlationId: sandboxCorrelationId(QUOTE_ID),
  });
}

async function createdProvider() {
  const sandbox = provider(async (request) => {
    if (request.url.endsWith("/token")) return tokenBody();
    if (request.url.endsWith("/capture")) return { status: 200, body: captureJson() };
    if (request.method === "GET") {
      return {
        status: 200,
        body: JSON.stringify({
          id: ORDER_ID,
          status: "COMPLETED",
          purchase_units: [{ custom_id: sandboxCorrelationId(QUOTE_ID), payee: { merchant_id: PAYEE }, amount: { currency_code: "USD", value: "449.00" } }],
        }),
      };
    }
    return { status: 201, body: orderJson("CREATED") };
  });
  await sandbox.createOrder(createRequest());
  return sandbox;
}
