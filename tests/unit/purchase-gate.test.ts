import { describe, expect, it } from "vitest";

import { startCheckoutWithQuote, requestQuote } from "@/lib/checkout/service";
import { confirmPurchaseSummary, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { cancelCheckout, dispatchCapture, dispatchOrderCreate, reconcileOperation, recordBuyerReturn, verifyApproval } from "@/lib/payment/orchestrator";
import { createPurchaseGate } from "@/lib/permissions/gate";
import type { Quote } from "@/lib/quote/quote";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import type { CommitResult, FoundationStore, PublishedBody } from "@/lib/session/snapshot-store";
import { pgCheckoutWithoutPermissions } from "@/server/respond";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, MINUTE, TEST_SESSION_KEY } from "./helpers";

// M2-3 slice 2: F07 enforcement on the mock checkout and payment path (docs/m2-3-plan.md §5–8). Real runtime, real
// gate, mock provider. Concurrency is shown with Promise.all where the code can interleave, and otherwise with
// deterministic interleavings placed inside the provider call (the point after the irreversible boundary).
const SITE = "https://shop.example.test";
const ITEM = { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: 1 };
const PRICE = 87_999;
const EMPTY: PublishedBody = { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [], conversations: [], selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [] };

type World = { runtime: Runtime; time: ReturnType<typeof createTestClock>; boot: () => Promise<Runtime>; body: () => PublishedBody; refuse: (when: ((body: PublishedBody) => boolean) | null) => void };

async function snapshotWorld(): Promise<World> {
  let published = structuredClone(EMPTY);
  let refuseWhen: ((body: PublishedBody) => boolean) | null = null;
  const store: FoundationStore = {
    readPublished: () => ({ status: "ready", value: { format: 4, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } }),
    async commit(body: unknown): Promise<CommitResult> {
      const next = structuredClone(body) as PublishedBody;
      if (refuseWhen?.(next)) return { status: "unavailable", outcome: "definite" };
      published = next;
      return { status: "ready", value: { format: 4, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } };
    },
  };
  const time = createTestClock("2026-10-16T12:00:00.000Z");
  const boot = async () => {
    const opened = await recoverStateGate(store, time.clock());
    if (opened.status !== "ready") throw new Error("recovery");
    return createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock, gate: opened.gate });
  };
  return { runtime: await boot(), time, boot, body: () => published, refuse: (when) => (refuseWhen = when) };
}

function memoryWorld() {
  const time = createTestClock("2026-10-16T12:00:00.000Z");
  return { runtime: createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock }), time };
}

async function shopper(runtime: Runtime) {
  const established = await runtime.sessions.establish(null);
  if (!established.ok) throw new Error("session");
  return established.value.session.id;
}

async function grant(runtime: Runtime, sessionId: string, limits: { maxQuantity?: number; maxTotalCents?: number; expiry?: string } = {}) {
  const made = await runtime.permissions.create(
    { sessionId, merchantId: runtime.catalog.merchant.merchantId, productId: ITEM.productId, variantId: ITEM.variantId, maxQuantity: limits.maxQuantity ?? 1, maxTotalCents: limits.maxTotalCents ?? 90_000, expiry: limits.expiry ?? "1h", admissionExpiresAtMs: null },
    runtime.clock(),
  );
  if (!made.ok) throw new Error(made.code);
  return made.value.permissionId;
}

const permission = (runtime: Runtime, permissionId: string) => runtime.durable.readPermissions().find((p) => p.permissionId === permissionId)!;
const stateOf = async (runtime: Runtime, intentId: string) => (await runtime.store.findIntent(intentId))?.snapshot.state ?? null;

async function start(runtime: Runtime, sessionId: string, request: object = ITEM) {
  const started = await startCheckoutWithQuote(runtime.checkout, sessionId, request);
  if (!started.ok) throw new Error(started.error);
  return started.value;
}

async function confirm(runtime: Runtime, sessionId: string, quote: Quote) {
  const challenge = await prepareConfirmation(runtime.checkout, sessionId, quote.quoteId);
  if (!challenge.ok) return challenge;
  const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
  return confirmPurchaseSummary(runtime.checkout, sessionId, { confirmationId, nonce, quoteId, quoteDigest });
}

/** Order, buyer approval and verified approval: the checkout is then ready for capture. */
async function approve(runtime: Runtime, sessionId: string, intentId: string) {
  const created = await dispatchOrderCreate(runtime.payment, intentId);
  if (!created.ok) return created;
  const orderId = (await runtime.store.findIntent(intentId))!.snapshot.context.providerOrderId!;
  runtime.provider.simulateBuyerApproval(orderId);
  await recordBuyerReturn(runtime.payment, sessionId, intentId);
  return verifyApproval(runtime.payment, intentId);
}

async function readyForCapture(runtime: Runtime, sessionId: string) {
  const { intent, quote } = await start(runtime, sessionId);
  const confirmed = await confirm(runtime, sessionId, quote);
  if (!confirmed.ok) throw new Error(confirmed.error);
  const approved = await approve(runtime, sessionId, intent.id);
  if (!approved.ok || approved.value !== "APPROVED_VERIFIED") throw new Error("approval");
  return { intent, quote };
}

/** Runs `during` inside the provider's capture call: after the saved `executing` step, before the capture result. */
function duringCapture(runtime: Runtime, during: () => Promise<unknown>) {
  const original = runtime.provider.captureOrder.bind(runtime.provider);
  runtime.provider.captureOrder = async (request) => {
    await during();
    return original(request);
  };
}

describe("checkout start", () => {
  it("requires a matching live permission and reserves it, saved before success; nothing is created without one", async () => {
    const world = await snapshotWorld();
    const { runtime } = world;
    const sid = await shopper(runtime);
    const before = runtime.store.recordCounts();
    expect(await startCheckoutWithQuote(runtime.checkout, sid, ITEM)).toEqual({ ok: false, error: "PERMISSION_REQUIRED" });
    expect(runtime.store.recordCounts()).toEqual(before);

    const pid = await grant(runtime, sid);
    const { intent, quote } = await start(runtime, sid);
    expect(quote.totalCents).toBe(PRICE);
    expect(permission(runtime, pid)).toMatchObject({ state: "reserved", checkoutIntentId: intent.id });
    expect(world.body().permissions.find((p) => p.permissionId === pid)?.state).toBe("reserved");
  });

  it("refuses a request outside the permission: another variant, more units, a total above the maximum", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    await grant(runtime, sid, { maxQuantity: 1, maxTotalCents: PRICE - 1 });
    expect(await startCheckoutWithQuote(runtime.checkout, sid, ITEM)).toEqual({ ok: false, error: "PERMISSION_TOTAL_EXCEEDED" });
    const { runtime: other } = memoryWorld();
    const sid2 = await shopper(other);
    await grant(other, sid2, { maxQuantity: 1, maxTotalCents: 200_000 });
    expect(await startCheckoutWithQuote(other.checkout, sid2, { ...ITEM, quantity: 2 })).toEqual({ ok: false, error: "PERMISSION_QUANTITY_EXCEEDED" });
    expect(await startCheckoutWithQuote(other.checkout, sid2, { productId: "dmp_aspirego15", variantId: "dmv_aspirego15", quantity: 1 })).toEqual({ ok: false, error: "PERMISSION_REQUIRED" });
  });

  it("two checkout starts racing for one permission: exactly one reserves it", async () => {
    const { runtime } = await snapshotWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const results = await Promise.all([startCheckoutWithQuote(runtime.checkout, sid, ITEM), startCheckoutWithQuote(runtime.checkout, sid, ITEM)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error)).toEqual(["PERMISSION_IN_USE"]);
    const winner = results.find((r) => r.ok)!;
    expect(winner.ok && permission(runtime, pid).checkoutIntentId).toBe(winner.ok && winner.value.intent.id);
    expect(runtime.store.recordCounts().intents).toBe(1);
  });

  it("a live checkout keeps its reservation; one that ended before capture gives it up", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const first = await start(runtime, sid);
    expect(await startCheckoutWithQuote(runtime.checkout, sid, ITEM)).toEqual({ ok: false, error: "PERMISSION_IN_USE" });
    expect((await cancelCheckout(runtime.checkout, sid, first.intent.id)).ok).toBe(true);
    expect(permission(runtime, pid)).toMatchObject({ state: "active", checkoutIntentId: null });
    const second = await start(runtime, sid);
    expect(permission(runtime, pid).checkoutIntentId).toBe(second.intent.id);
  });

  it("revoke versus start: a revoked permission gives nothing", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    await runtime.permissions.revoke(sid, pid, runtime.clock());
    expect(await startCheckoutWithQuote(runtime.checkout, sid, ITEM)).toEqual({ ok: false, error: "PERMISSION_REVOKED" });
  });
});

describe("re-checks at confirmation and order creation", () => {
  it("revoke after reservation: confirmation preparation and submission both refuse, and the checkout stays unconfirmed", async () => {
    const { runtime } = await snapshotWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent, quote } = await start(runtime, sid);
    const challenge = await prepareConfirmation(runtime.checkout, sid, quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    expect(await runtime.permissions.revoke(sid, pid, runtime.clock())).toBe("revoked");
    const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
    expect(await confirmPurchaseSummary(runtime.checkout, sid, { confirmationId, nonce, quoteId, quoteDigest })).toEqual({ ok: false, error: "PERMISSION_REVOKED" });
    expect(await prepareConfirmation(runtime.checkout, sid, quote.quoteId)).toEqual({ ok: false, error: "PERMISSION_REVOKED" });
    expect(await stateOf(runtime, intent.id)).toBe("QUOTED");
  });

  it("duplicate confirmation submit: one confirmation, one reservation", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent, quote } = await start(runtime, sid);
    const challenge = await prepareConfirmation(runtime.checkout, sid, quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
    const submissions = await Promise.all([1, 2].map(() => confirmPurchaseSummary(runtime.checkout, sid, { confirmationId, nonce, quoteId, quoteDigest })));
    expect(submissions.filter((s) => s.ok)).toHaveLength(1);
    expect(await stateOf(runtime, intent.id)).toBe("USER_CONFIRMED");
    expect(permission(runtime, pid)).toMatchObject({ state: "reserved", checkoutIntentId: intent.id });
  });

  it("revoke after confirmation: order creation refuses and no provider order exists", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent, quote } = await start(runtime, sid);
    expect((await confirm(runtime, sid, quote)).ok).toBe(true);
    await runtime.permissions.revoke(sid, pid, runtime.clock());
    expect(await dispatchOrderCreate(runtime.payment, intent.id)).toEqual({ ok: false, error: "PERMISSION_REVOKED" });
    expect(runtime.provider.orderCount()).toBe(0);
    expect(await stateOf(runtime, intent.id)).toBe("USER_CONFIRMED");
  });

  it("expiry between reservation and confirmation refuses confirmation", async () => {
    const { runtime, time } = memoryWorld();
    const sid = await shopper(runtime);
    await grant(runtime, sid, { expiry: "15m" });
    time.advance(10 * MINUTE);
    const { quote } = await start(runtime, sid);
    time.advance(6 * MINUTE); // permission ended at +15; the quote (+25) is still valid
    expect(await confirm(runtime, sid, quote)).toEqual({ ok: false, error: "PERMISSION_EXPIRED" });
  });

  it("a changed quote on the same checkout is checked again: another variant or more units than permitted refuse", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    await grant(runtime, sid, { maxQuantity: 1, maxTotalCents: 300_000 });
    const { intent } = await start(runtime, sid);
    const otherItem = await requestQuote(runtime.checkout, sid, intent.id, { productId: "dmp_aspirego15", variantId: "dmv_aspirego15", quantity: 1 });
    if (!otherItem.ok) throw new Error(otherItem.error);
    expect(await prepareConfirmation(runtime.checkout, sid, otherItem.value.quoteId)).toEqual({ ok: false, error: "PERMISSION_MISMATCH" });
    const moreUnits = await requestQuote(runtime.checkout, sid, intent.id, { ...ITEM, quantity: 2 });
    if (!moreUnits.ok) throw new Error(moreUnits.error);
    expect(await prepareConfirmation(runtime.checkout, sid, moreUnits.value.quoteId)).toEqual({ ok: false, error: "PERMISSION_QUANTITY_EXCEEDED" });
  });

  it("price changes are checked against the current total: lower or equal to the maximum passes, above it refuses", () => {
    const { runtime } = memoryWorld();
    const time = createTestClock("2026-10-16T12:00:00.000Z");
    const permissions = [
      {
        permissionId: `prm_${"1".repeat(32)}`,
        sessionId: "ses_live",
        merchantId: runtime.catalog.merchant.merchantId,
        productId: ITEM.productId,
        variantId: ITEM.variantId,
        maxQuantity: 1,
        maxTotalCents: 90_000,
        currency: "USD" as const,
        createdAt: time.clock(),
        expiresAt: new Date(time.clock().getTime() + 60 * MINUTE),
        state: "reserved" as const,
        checkoutIntentId: "ci_held",
        changedAt: time.clock(),
      },
    ];
    const gate = createPurchaseGate({ durable: { ...runtime.durable, readPermissions: () => permissions }, sessionLive: (id) => id === "ses_live", clock: time.clock });
    const quote = { merchantId: runtime.catalog.merchant.merchantId, productId: ITEM.productId, variantId: ITEM.variantId, quantity: 1, totalCents: PRICE, currency: "USD" };
    expect(gate.check("ses_live", { ...quote, totalCents: 50_000 }, "ci_held", "confirm_submit")).toEqual({ ok: true });
    expect(gate.check("ses_live", { ...quote, totalCents: 90_000 }, "ci_held", "order_create")).toEqual({ ok: true });
    expect(gate.check("ses_live", { ...quote, totalCents: 90_001 }, "ci_held", "order_create")).toEqual({ ok: false, code: "PERMISSION_TOTAL_EXCEEDED" });
    expect(gate.check("ses_live", { ...quote, currency: "EUR" }, "ci_held", "order_create")).toEqual({ ok: false, code: "PERMISSION_MISMATCH" });
    expect(gate.check("ses_live", { ...quote, merchantId: "dmm_othershop1" }, "ci_held", "order_create").ok).toBe(false);
    expect(gate.check("ses_live", { ...quote, quantity: 2 }, "ci_held", "order_create")).toEqual({ ok: false, code: "PERMISSION_QUANTITY_EXCEEDED" });
    expect(gate.check("ses_live", quote, "ci_other", "order_create")).toEqual({ ok: false, code: "PERMISSION_UNAVAILABLE" });
    expect(gate.check("ses_dead", quote, "ci_held", "order_create")).toEqual({ ok: false, code: "PERMISSION_UNAVAILABLE" });
  });
});

describe("capture: the irreversible boundary", () => {
  it("saves executing before the provider is called, then consumes on a verified capture", async () => {
    const world = await snapshotWorld();
    const { runtime } = world;
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    const seen: string[] = [];
    duringCapture(runtime, async () => {
      seen.push(world.body().permissions.find((p) => p.permissionId === pid)!.state);
    });
    expect(await dispatchCapture(runtime.payment, intent.id)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect(seen).toEqual(["executing"]);
    expect(permission(runtime, pid)).toMatchObject({ state: "consumed", checkoutIntentId: intent.id });
    // Single use: the binding needs a new permission now.
    expect(await startCheckoutWithQuote(runtime.checkout, sid, ITEM)).toEqual({ ok: false, error: "PERMISSION_UNAVAILABLE" });
  });

  it("a failed save of executing starts no capture", async () => {
    const world = await snapshotWorld();
    const { runtime } = world;
    const sid = await shopper(runtime);
    await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    world.refuse((body) => body.permissions.some((p) => p.state === "executing"));
    await expect(dispatchCapture(runtime.payment, intent.id)).rejects.toThrow(/could not be saved/);
    expect(runtime.provider.captureCount()).toBe(0);
    expect(await stateOf(runtime, intent.id)).toBe("APPROVED_VERIFIED");
  });

  it("revoke before the boundary wins: no capture is sent", async () => {
    const { runtime } = await snapshotWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    expect(await runtime.permissions.revoke(sid, pid, runtime.clock())).toBe("revoked");
    expect(await dispatchCapture(runtime.payment, intent.id)).toEqual({ ok: false, error: "PERMISSION_REVOKED" });
    expect(runtime.provider.captureCount()).toBe(0);
    expect(await stateOf(runtime, intent.id)).toBe("APPROVED_VERIFIED");
  });

  it("revoke after the boundary cannot undo the capture under way: it reports in progress, and the capture is recorded", async () => {
    const { runtime } = await snapshotWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    let revoke: string | null = null;
    duringCapture(runtime, async () => {
      revoke = await runtime.permissions.revoke(sid, pid, runtime.clock());
    });
    expect(await dispatchCapture(runtime.payment, intent.id)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect(revoke).toBe("in_progress");
    expect(permission(runtime, pid).state).toBe("consumed");
  });

  it("two capture attempts: one capture at the provider, the other refused", async () => {
    const { runtime } = await snapshotWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    const results = await Promise.all([dispatchCapture(runtime.payment, intent.id), dispatchCapture(runtime.payment, intent.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(runtime.provider.captureCount()).toBe(1);
    expect(permission(runtime, pid).state).toBe("consumed");
  });

  it("expiry between confirmation and capture refuses the capture", async () => {
    const { runtime, time } = memoryWorld();
    const sid = await shopper(runtime);
    await grant(runtime, sid, { expiry: "15m" });
    time.advance(5 * MINUTE);
    const { intent } = await readyForCapture(runtime, sid);
    time.advance(11 * MINUTE);
    expect(await dispatchCapture(runtime.payment, intent.id)).toEqual({ ok: false, error: "PERMISSION_EXPIRED" });
    expect(runtime.provider.captureCount()).toBe(0);
  });

  it("logout versus checkout and capture: before the boundary nothing proceeds; after it the capture is recorded", async () => {
    const world = await snapshotWorld();
    const { runtime } = world;
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    await runtime.sessions.revoke(sid);
    expect(permission(runtime, pid).state).toBe("revoked");
    expect((await dispatchCapture(runtime.payment, intent.id)).ok).toBe(false);
    expect(runtime.provider.captureCount()).toBe(0);
    expect(await startCheckoutWithQuote(runtime.checkout, sid, ITEM)).toEqual({ ok: false, error: "PERMISSION_UNAVAILABLE" });

    const other = await snapshotWorld();
    const sid2 = await shopper(other.runtime);
    const pid2 = await grant(other.runtime, sid2);
    const ready = await readyForCapture(other.runtime, sid2);
    duringCapture(other.runtime, () => other.runtime.sessions.revoke(sid2));
    expect(await dispatchCapture(other.runtime.payment, ready.intent.id)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect(permission(other.runtime, pid2).state).toBe("consumed");
  });

  it("a provider-proven decline returns the permission to this checkout's reservation; cancel then releases it", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    runtime.provider.setNextCaptureBehavior("DECLINE");
    expect(await dispatchCapture(runtime.payment, intent.id)).toEqual({ ok: true, value: "DECLINED_RETRYABLE" });
    expect(permission(runtime, pid)).toMatchObject({ state: "reserved", checkoutIntentId: intent.id });
    expect((await cancelCheckout(runtime.checkout, sid, intent.id)).ok).toBe(true);
    expect(permission(runtime, pid)).toMatchObject({ state: "active", checkoutIntentId: null });
  });

  it("after a definitive decline the old confirmation is spent: no second capture on that checkout; a new confirmation in a new checkout is required", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    runtime.provider.setNextCaptureBehavior("DECLINE");
    expect(await dispatchCapture(runtime.payment, intent.id)).toEqual({ ok: true, value: "DECLINED_RETRYABLE" });
    const capturesAfterDecline = runtime.provider.captureCount();

    // The state machine lets the buyer approve again and reach APPROVED_VERIFIED without any new shopper confirmation...
    await recordBuyerReturn(runtime.payment, sid, intent.id);
    expect(await verifyApproval(runtime.payment, intent.id)).toEqual({ ok: true, value: "APPROVED_VERIFIED" });
    // ...but the capture is refused, nothing reaches the provider, and the permission stays bound to this checkout.
    expect(await dispatchCapture(runtime.payment, intent.id)).toEqual({ ok: false, error: "CONFIRMATION_REQUIRED" });
    expect(runtime.provider.captureCount()).toBe(capturesAfterDecline);
    expect(permission(runtime, pid)).toMatchObject({ state: "reserved", checkoutIntentId: intent.id });

    // Cancelling releases it (existing rule); a new checkout with a new confirmation can then capture once.
    expect((await cancelCheckout(runtime.checkout, sid, intent.id)).ok).toBe(true);
    expect(permission(runtime, pid).state).toBe("active");
    const next = await readyForCapture(runtime, sid);
    expect(await dispatchCapture(runtime.payment, next.intent.id)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect(permission(runtime, pid)).toMatchObject({ state: "consumed", checkoutIntentId: next.intent.id });
  });

  it("a pending capture keeps executing until reconciliation proves completion", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    runtime.provider.setNextCaptureBehavior("PENDING");
    expect(await dispatchCapture(runtime.payment, intent.id)).toEqual({ ok: true, value: "CAPTURE_PENDING_PROVIDER" });
    expect(permission(runtime, pid).state).toBe("executing");
    const context = (await runtime.store.findIntent(intent.id))!.snapshot.context;
    runtime.provider.simulatePendingCaptureSettled(context.providerCaptureId!, "COMPLETED");
    expect(await reconcileOperation(runtime.payment, context.captureOperationId!)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect(permission(runtime, pid).state).toBe("consumed");
  });
});

describe("outcome unknown and reconciliation", () => {
  async function lostCapture(fault: "LOSE_REQUEST" | "LOSE_RESPONSE") {
    const world = await snapshotWorld();
    const { runtime } = world;
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent } = await readyForCapture(runtime, sid);
    runtime.provider.failNextCapture(fault);
    expect(await dispatchCapture(runtime.payment, intent.id)).toEqual({ ok: true, value: "CAPTURE_UNKNOWN" });
    expect(permission(runtime, pid)).toMatchObject({ state: "outcome_unknown", checkoutIntentId: intent.id });
    const operationId = (await runtime.store.findIntent(intent.id))!.snapshot.context.captureOperationId!;
    return { world, runtime, sid, pid, intent, operationId };
  }

  it("outcome unknown gives no authority for a new checkout", async () => {
    const { runtime, sid } = await lostCapture("LOSE_RESPONSE");
    expect(await startCheckoutWithQuote(runtime.checkout, sid, ITEM)).toEqual({ ok: false, error: "PERMISSION_UNAVAILABLE" });
  });

  it("same-checkout reconciliation: a found capture is settled without a resend and consumes the permission", async () => {
    const { runtime, pid, operationId } = await lostCapture("LOSE_RESPONSE");
    expect(await reconcileOperation(runtime.payment, operationId)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect(runtime.provider.captureCount()).toBe(1);
    expect(permission(runtime, pid).state).toBe("consumed");
  });

  it("same-checkout reconciliation: no trace at the provider resends the same operation, saved as executing first", async () => {
    const { world, runtime, pid, operationId } = await lostCapture("LOSE_REQUEST");
    const seen: string[] = [];
    duringCapture(runtime, async () => {
      seen.push(world.body().permissions.find((p) => p.permissionId === pid)!.state);
    });
    expect(await reconcileOperation(runtime.payment, operationId)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect(seen).toEqual(["executing"]);
    expect(runtime.provider.captureCount()).toBe(1);
    expect(permission(runtime, pid).state).toBe("consumed");
  });

  it("no resend once the session is dead or the permission has expired; the outcome stays unknown", async () => {
    const dead = await lostCapture("LOSE_REQUEST");
    await dead.runtime.sessions.revoke(dead.sid);
    expect(await reconcileOperation(dead.runtime.payment, dead.operationId)).toEqual({ ok: false, error: "PERMISSION_UNAVAILABLE" });
    expect(dead.runtime.provider.captureCount()).toBe(0);
    expect(permission(dead.runtime, dead.pid).state).toBe("outcome_unknown");

    const late = await lostCapture("LOSE_REQUEST");
    late.world.time.advance(61 * MINUTE);
    expect(await reconcileOperation(late.runtime.payment, late.operationId)).toEqual({ ok: false, error: "PERMISSION_EXPIRED" });
    expect(late.runtime.provider.captureCount()).toBe(0);
    expect(permission(late.runtime, late.pid).state).toBe("outcome_unknown");
  });
});

describe("restart", () => {
  it("a reserved permission returns to active and the old checkout is gone; a new checkout can reserve it", async () => {
    const world = await snapshotWorld();
    const sid = await shopper(world.runtime);
    const pid = await grant(world.runtime, sid);
    const { intent } = await start(world.runtime, sid);
    world.time.advance(MINUTE);
    const after = await world.boot();
    expect(await after.store.findIntent(intent.id)).toBeNull();
    expect(permission(after, pid)).toMatchObject({ state: "active", checkoutIntentId: null });
    const next = await start(after, sid);
    expect(permission(after, pid).checkoutIntentId).toBe(next.intent.id);
  });

  it("a restart while executing (capture possibly sent) restores outcome unknown, never active", async () => {
    const world = await snapshotWorld();
    const sid = await shopper(world.runtime);
    const pid = await grant(world.runtime, sid);
    const { intent } = await readyForCapture(world.runtime, sid);
    let mid: PublishedBody | null = null;
    duringCapture(world.runtime, async () => {
      mid = structuredClone(world.body());
    });
    await dispatchCapture(world.runtime.payment, intent.id);
    expect(mid!.permissions.find((p) => p.permissionId === pid)?.state).toBe("executing");
    const store: FoundationStore = {
      readPublished: () => ({ status: "ready", value: { format: 4, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(mid!) } }),
      commit: async (body: unknown) => ({ status: "ready", value: { format: 4, identity: "0".repeat(64), sha256: "0".repeat(64), body: body as PublishedBody } }),
    };
    const opened = await recoverStateGate(store, world.time.clock());
    if (opened.status !== "ready") throw new Error();
    const after = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: world.time.clock, gate: opened.gate });
    expect(permission(after, pid)).toMatchObject({ state: "outcome_unknown", checkoutIntentId: intent.id });
    expect(await startCheckoutWithQuote(after.checkout, sid, ITEM)).toEqual({ ok: false, error: "PERMISSION_UNAVAILABLE" });
  });
});

describe("live session in memory mode", () => {
  it("a logged-out session's untouched permission record gives no authority at any step", async () => {
    const { runtime } = memoryWorld();
    const sid = await shopper(runtime);
    const pid = await grant(runtime, sid);
    const { intent, quote } = await start(runtime, sid);
    await runtime.sessions.revoke(sid);
    // Memory mode does not rewrite the record (docs/m2-3-plan.md §5); every check requires the live session itself.
    expect(permission(runtime, pid).state).toBe("reserved");
    expect(runtime.checkout.purchaseGate.check(sid, quote, intent.id, "confirm_prepare")).toEqual({ ok: false, code: "PERMISSION_UNAVAILABLE" });
    expect(await runtime.checkout.purchaseGate.beginCapture(sid, quote, intent.id, false)).toEqual({ ok: false, code: "PERMISSION_UNAVAILABLE" });
    expect(await runtime.checkout.purchaseGate.reserveForCheckout(sid, quote, "ci_new", async () => null)).toEqual({ ok: false, code: "PERMISSION_UNAVAILABLE" });
  });
});

describe("PostgreSQL mode", () => {
  it("checkout fails closed with an explicit refusal", async () => {
    const response = await pgCheckoutWithoutPermissions();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error).toMatchObject({ code: "UNAVAILABLE", message: "Checkout is turned off in PostgreSQL mode: purchase permissions are not enforced there." });
  });
});
