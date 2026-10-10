import { describe, expect, it } from "vitest";
import {
  cancelCheckout,
  dispatchCapture,
  dispatchOrderCreate,
  observeCaptureAftermath,
  prepareCapture,
  prepareOrderCreate,
  PROPOSED_ESCALATION_AFTER_MS,
  reconcileOperation,
  recordBuyerReturn,
  verifyApproval,
} from "@/lib/payment/orchestrator";
import type { PaymentProvider } from "@/lib/providers/payment";
import { QUOTE_TTL_MS } from "@/lib/quote/quote";
import { confirmedIntent, createWorld, LEASE_MS, newSession, quotedIntent, stateOf, type World } from "./helpers";

async function toAwaitingApproval(world: World) {
  const { session } = await newSession(world);
  const { intentId, quote } = await confirmedIntent(world, session.id);
  expect(await dispatchOrderCreate(world.payment(), intentId)).toEqual({ ok: true, value: "AWAITING_APPROVAL" });
  const providerOrderId = (await world.store.findIntent(intentId))!.snapshot.context.providerOrderId!;
  return { session, intentId, quote, providerOrderId };
}

async function toApproved(world: World) {
  const setup = await toAwaitingApproval(world);
  world.provider.simulateBuyerApproval(setup.providerOrderId);
  expect(await recordBuyerReturn(world.payment(), setup.session.id, setup.intentId)).toEqual({ ok: true, value: "APPROVAL_CHECK_PENDING" });
  expect(await verifyApproval(world.payment(), setup.intentId)).toEqual({ ok: true, value: "APPROVED_VERIFIED" });
  return setup;
}

const captureOp = async (world: World, intentId: string) => (await world.ledger.listForIntent(intentId, "CAPTURE")).at(-1)!;
const orderOp = async (world: World, intentId: string) => (await world.ledger.listForIntent(intentId, "ORDER_CREATE"))[0];

describe("mock payment provider and dispatch discipline", () => {
  it("exposes no refund, reversal or payout operation", () => {
    const methods: (keyof PaymentProvider)[] = ["createOrder", "captureOrder", "getOrder", "getOrderByRequestId", "getCaptureByRequestId"];
    const world = createWorld();
    const provider: PaymentProvider = world.provider;
    for (const method of methods) expect(typeof provider[method]).toBe("function");
    const callable = Object.getOwnPropertyNames(Object.getPrototypeOf(world.provider)).filter((name) => !name.startsWith("simulate"));
    expect(callable.join(",")).not.toMatch(/refund|reverse|payout|void/i);
  });

  it("commits the operation record before the provider call and never calls the provider inside a transaction", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId } = await confirmedIntent(world, session.id);
    // Wrap the provider so that, at the moment of the call, we can read what has already been persisted.
    const seen: { inTransaction: boolean; ledgerState: string; attemptCount: number; intentState: string }[] = [];
    const base = world.payment();
    const provider: PaymentProvider = {
      createOrder: async (request) => {
        const operation = await orderOp(world, intentId);
        seen.push({
          inTransaction: world.store.inTransaction,
          ledgerState: operation?.state ?? "MISSING",
          attemptCount: operation?.attemptCount ?? 0,
          intentState: await stateOf(world, intentId),
        });
        expect(operation?.providerRequestId).toBe(request.requestId);
        return world.provider.createOrder(request);
      },
      captureOrder: (request) => world.provider.captureOrder(request),
      getOrder: (id) => world.provider.getOrder(id),
      getOrderByRequestId: (id) => world.provider.getOrderByRequestId(id),
      getCaptureByRequestId: (id) => world.provider.getCaptureByRequestId(id),
    };
    expect(await dispatchOrderCreate({ ...base, provider }, intentId)).toEqual({ ok: true, value: "AWAITING_APPROVAL" });
    expect(seen).toEqual([{ inTransaction: false, ledgerState: "DISPATCHING", attemptCount: 1, intentState: "ORDER_CREATE_IN_FLIGHT" }]);

    // The same check for capture, sampled synchronously at call time.
    const flags: boolean[] = [];
    world.provider.onCall = () => flags.push(world.store.inTransaction);
    const providerOrderId = (await world.store.findIntent(intentId))!.snapshot.context.providerOrderId!;
    world.provider.simulateBuyerApproval(providerOrderId);
    await verifyApproval(world.payment(), intentId);
    await dispatchCapture(world.payment(), intentId);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((flag) => flag === false)).toBe(true);
  });

  it("will not dispatch without confirmation, and re-checks quote expiry at dispatch", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const quoted = await quotedIntent(world, session.id);
    expect(await dispatchOrderCreate(world.payment(), quoted.intentId)).toEqual({ ok: false, error: "INVALID_STATE" });

    const confirmed = await confirmedIntent(world, session.id);
    world.time.advance(QUOTE_TTL_MS);
    expect(await dispatchOrderCreate(world.payment(), confirmed.intentId)).toEqual({ ok: false, error: "QUOTE_NO_LONGER_VALID" });
    expect(await stateOf(world, confirmed.intentId)).toBe("DRAFT");
    expect(world.provider.calls).toEqual([]);
  });

  it("simulates buyer approval; a redirect alone proves nothing", async () => {
    const world = createWorld();
    const { session, intentId, providerOrderId } = await toAwaitingApproval(world);
    // The browser returns but the buyer never approved.
    expect(await recordBuyerReturn(world.payment(), session.id, intentId)).toEqual({ ok: true, value: "APPROVAL_CHECK_PENDING" });
    expect(await verifyApproval(world.payment(), intentId)).toEqual({ ok: true, value: "AWAITING_APPROVAL" });
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: false, error: "INVALID_STATE" });
    expect(world.provider.captureCount()).toBe(0);

    world.provider.simulateBuyerApproval(providerOrderId);
    expect(await verifyApproval(world.payment(), intentId)).toEqual({ ok: true, value: "APPROVED_VERIFIED" });
  });

  it("simulates incorrect order details: a mismatch goes to manual review and is never captured", async () => {
    const world = createWorld();
    const { intentId, providerOrderId, quote } = await toAwaitingApproval(world);
    world.provider.simulateBuyerApproval(providerOrderId);
    world.provider.simulateIncorrectOrderDetails(providerOrderId, quote.totalCents + 1);
    expect(await verifyApproval(world.payment(), intentId)).toEqual({ ok: true, value: "MANUAL_REVIEW" });
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: false, error: "INVALID_STATE" });
    expect(world.provider.captureCount()).toBe(0);
  });

  it("simulates capture success, pending and decline", async () => {
    const success = createWorld();
    const a = await toApproved(success);
    expect(await dispatchCapture(success.payment(), a.intentId)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });

    const declined = createWorld();
    const b = await toApproved(declined);
    declined.provider.setNextCaptureBehavior("DECLINE");
    expect(await dispatchCapture(declined.payment(), b.intentId)).toEqual({ ok: true, value: "DECLINED_RETRYABLE" });
    // The shopper re-approves; the next capture is a new logical operation with a new request ID.
    await recordBuyerReturn(declined.payment(), b.session.id, b.intentId);
    expect(await verifyApproval(declined.payment(), b.intentId)).toEqual({ ok: true, value: "APPROVED_VERIFIED" });
    expect(await dispatchCapture(declined.payment(), b.intentId)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    const operations = await declined.ledger.listForIntent(b.intentId, "CAPTURE");
    expect(operations.map((operation) => [operation.sequence, operation.state])).toEqual([[1, "DECLINED"], [2, "SUCCEEDED"]]);
    expect(operations[0].providerRequestId).not.toBe(operations[1].providerRequestId);
  });

  it("an explicit provider rejection of order creation is the only terminal failure", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId } = await confirmedIntent(world, session.id);
    world.provider.failNextCreateOrder("REJECT");
    expect(await dispatchOrderCreate(world.payment(), intentId)).toEqual({ ok: true, value: "FAILED_TERMINAL" });
    expect((await orderOp(world, intentId)).state).toBe("REJECTED");
    const [observation] = await world.store.listObservations(intentId);
    expect(observation).toMatchObject({ source: "provider_response", observedStatus: "REJECTED:MOCK_ORDER_REJECTED" });
  });

  it("records provider observations separately from local workflow state", async () => {
    const world = createWorld();
    const { intentId } = await toApproved(world);
    await dispatchCapture(world.payment(), intentId);
    const observations = await world.store.listObservations(intentId);
    expect(observations.map((observation) => `${observation.source}:${observation.subject}:${observation.observedStatus}`)).toEqual([
      "provider_response:ORDER:CREATED",
      "provider_readback:ORDER:APPROVED",
      "provider_response:CAPTURE:COMPLETED",
    ]);
    const transitions = await world.store.listTransitions(intentId);
    for (const record of transitions.filter((candidate) => candidate.actor.startsWith("provider_"))) {
      expect(observations.map((observation) => observation.id)).toContain(record.observationId);
    }
    expect(transitions.every((record) => record.eventId.startsWith("ev_"))).toBe(true);
  });
});

describe("ORD: order creation", () => {
  it("ORD-01: models one logical order-create operation", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId } = await confirmedIntent(world, session.id);

    // Two workers race to dispatch the same confirmed intent.
    const results = await Promise.all([dispatchOrderCreate(world.payment("worker-a"), intentId), dispatchOrderCreate(world.payment("worker-b"), intentId)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await dispatchOrderCreate(world.payment("worker-c"), intentId)).toEqual({ ok: false, error: "INVALID_STATE" });

    const operations = await world.ledger.listForIntent(intentId, "ORDER_CREATE");
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ state: "SUCCEEDED", attemptCount: 1, sequence: 1, leaseOwner: null });
    expect(world.provider.calls.filter((call) => call === "createOrder")).toHaveLength(1);
    expect(world.provider.orderCount()).toBe(1);

    // Re-declaring the same logical operation returns the existing row; a different payload is refused.
    const now = world.time.clock();
    const same = await world.ledger.ensureOperation({ checkoutIntentId: intentId, type: "ORDER_CREATE", sequence: 1, payloadDigest: operations[0].payloadDigest, now });
    expect(same).toMatchObject({ ok: true, created: false, operation: { id: operations[0].id } });
    expect(await world.ledger.ensureOperation({ checkoutIntentId: intentId, type: "ORDER_CREATE", sequence: 1, payloadDigest: "f".repeat(64), now })).toEqual({
      ok: false,
      error: "PAYLOAD_MISMATCH",
    });
  });

  it("ORD-02: preserves unknown state after a lost create response and resolves it by readback without a duplicate order", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId } = await confirmedIntent(world, session.id);
    world.provider.failNextCreateOrder("LOSE_RESPONSE");

    expect(await dispatchOrderCreate(world.payment(), intentId)).toEqual({ ok: true, value: "ORDER_CREATE_UNKNOWN" });
    const operation = await orderOp(world, intentId);
    expect(operation.state).toBe("UNKNOWN");
    // Not failed, not retried blindly, not cancelable while unresolved.
    expect(await dispatchOrderCreate(world.payment(), intentId)).toEqual({ ok: false, error: "INVALID_STATE" });
    expect(await cancelCheckout(world.checkout, session.id, intentId)).toEqual({ ok: false, error: "NOT_CANCELABLE" });
    expect(world.provider.calls.filter((call) => call === "createOrder")).toHaveLength(1);

    // Readback unavailable: still not a failure.
    world.provider.readbackUnavailable = true;
    expect(await reconcileOperation(world.payment(), operation.id)).toEqual({ ok: true, value: "RECONCILIATION_REQUIRED" });
    expect((await orderOp(world, intentId)).state).toBe("UNKNOWN");

    world.provider.readbackUnavailable = false;
    expect(await reconcileOperation(world.payment(), operation.id)).toEqual({ ok: true, value: "AWAITING_APPROVAL" });
    expect(world.provider.orderCount()).toBe(1);
    expect(world.provider.calls.filter((call) => call === "createOrder")).toHaveLength(1);
    expect((await orderOp(world, intentId)).state).toBe("SUCCEEDED");
  });

  it("resends the same request only after readback shows the provider never received it", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId } = await confirmedIntent(world, session.id);
    world.provider.failNextCreateOrder("LOSE_REQUEST");
    expect(await dispatchOrderCreate(world.payment(), intentId)).toEqual({ ok: true, value: "ORDER_CREATE_UNKNOWN" });
    const operation = await orderOp(world, intentId);

    expect(await reconcileOperation(world.payment(), operation.id)).toEqual({ ok: true, value: "AWAITING_APPROVAL" });
    expect(world.provider.calls).toEqual(["createOrder", "getOrderByRequestId", "createOrder"]);
    expect(world.provider.orderCount()).toBe(1);
    const after = await orderOp(world, intentId);
    expect(after).toMatchObject({ id: operation.id, providerRequestId: operation.providerRequestId, attemptCount: 2, state: "SUCCEEDED" });
  });

  it("escalates to manual review when an unknown outcome stays unresolved past the proposed target", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId } = await confirmedIntent(world, session.id);
    world.provider.failNextCreateOrder("LOSE_RESPONSE");
    await dispatchOrderCreate(world.payment(), intentId);
    const operation = await orderOp(world, intentId);
    world.provider.readbackUnavailable = true;
    world.time.advance(PROPOSED_ESCALATION_AFTER_MS);
    expect(await reconcileOperation(world.payment(), operation.id)).toEqual({ ok: true, value: "MANUAL_REVIEW" });
  });
});

describe("CAP: capture", () => {
  it("CAP-01: prevents concurrent logical capture claims", async () => {
    const world = createWorld();
    const { intentId } = await toApproved(world);

    const results = await Promise.all(["worker-a", "worker-b", "worker-c"].map((worker) => dispatchCapture(world.payment(worker), intentId)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await world.ledger.listForIntent(intentId, "CAPTURE")).toHaveLength(1);
    expect(world.provider.calls.filter((call) => call === "captureOrder")).toHaveLength(1);
    expect(world.provider.captureCount()).toBe(1);

    // At the ledger level: while one worker holds the lease, nobody else can claim for dispatch or recovery.
    const second = createWorld();
    const setup = await toApproved(second);
    const claimed = await prepareCapture(second.payment("worker-a"), setup.intentId);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const now = second.time.clock();
    expect(await second.ledger.claimForDispatch(claimed.value.id, "worker-b", now, LEASE_MS)).toBeNull();
    expect(await second.ledger.claimForRecovery(claimed.value.id, "worker-b", now, LEASE_MS)).toBeNull();
    expect(await prepareCapture(second.payment("worker-b"), setup.intentId)).toEqual({ ok: false, error: "INVALID_STATE" });
    // A worker that does not hold the lease cannot record an outcome.
    expect(await second.ledger.recordOutcome(claimed.value.id, "worker-b", { state: "SUCCEEDED", providerReference: "X" }, now)).toBeNull();
  });

  it("CAP-02: preserves operation identity across retries", async () => {
    const world = createWorld();
    const { intentId } = await toApproved(world);
    world.provider.failNextCapture("LOSE_REQUEST");
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: true, value: "CAPTURE_UNKNOWN" });
    const first = await captureOp(world, intentId);

    // First recovery: the provider has no trace, so the same request is sent again - and lost again.
    world.provider.failNextCapture("LOSE_REQUEST");
    expect(await reconcileOperation(world.payment("worker-b"), first.id)).toEqual({ ok: true, value: "CAPTURE_UNKNOWN" });
    expect(await reconcileOperation(world.payment("worker-c"), first.id)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });

    const operations = await world.ledger.listForIntent(intentId, "CAPTURE");
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ id: first.id, providerRequestId: first.providerRequestId, payloadDigest: first.payloadDigest, attemptCount: 3, state: "SUCCEEDED" });
    expect((await world.store.findIntent(intentId))!.snapshot.context.captureOperationId).toBe(first.id);
    expect(world.provider.captureCount()).toBe(1);
  });

  it("simulates duplicate requests: a repeated request ID returns the original result and creates nothing new", async () => {
    const world = createWorld();
    const { intentId, providerOrderId } = await toApproved(world);
    await dispatchCapture(world.payment(), intentId);
    const operation = await captureOp(world, intentId);
    const again = await world.provider.captureOrder({ requestId: operation.providerRequestId, orderId: providerOrderId });
    expect(again.kind === "RESPONSE" && again.value.captureId).toBe(operation.providerReference);
    expect(world.provider.duplicateRequestCount).toBe(1);
    expect(world.provider.captureCount()).toBe(1);

    const order = await orderOp(world, intentId);
    const repeat = await world.provider.createOrder({ requestId: order.providerRequestId, amountCents: 1, currency: "USD", merchantId: "dmm_shopaccessdemo" });
    expect(repeat).toEqual({ kind: "REJECTED", code: "MOCK_IDEMPOTENCY_PAYLOAD_MISMATCH" });
    expect(world.provider.orderCount()).toBe(1);
  });

  it("refuses cancellation once a capture has been dispatched", async () => {
    const world = createWorld();
    const { session, intentId } = await toApproved(world);
    world.provider.failNextCapture("LOSE_RESPONSE");
    await dispatchCapture(world.payment(), intentId);
    expect(await cancelCheckout(world.checkout, session.id, intentId)).toEqual({ ok: false, error: "CAPTURE_ALREADY_DISPATCHED" });
    expect(await stateOf(world, intentId)).toBe("CAPTURE_UNKNOWN");
  });

  it("a canceled checkout is never captured", async () => {
    const world = createWorld();
    const { session, intentId } = await toApproved(world);
    expect(await cancelCheckout(world.checkout, session.id, intentId)).toEqual({ ok: true, value: "CANCELED_LOCAL" });
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: false, error: "INVALID_STATE" });
    expect(world.provider.captureCount()).toBe(0);
  });
});

describe("REC: reconciliation and recovery", () => {
  it("REC-01: reconciles a lost capture response by readback, without capturing twice", async () => {
    const world = createWorld();
    const { intentId } = await toApproved(world);
    world.provider.failNextCapture("LOSE_RESPONSE");
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: true, value: "CAPTURE_UNKNOWN" });
    const operation = await captureOp(world, intentId);
    expect(operation.state).toBe("UNKNOWN");
    // No blind retry is possible from the unknown state.
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: false, error: "INVALID_STATE" });

    const callsBefore = world.provider.calls.length;
    expect(await reconcileOperation(world.payment("reconciler-1"), operation.id)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect(world.provider.calls.slice(callsBefore)).toEqual(["getCaptureByRequestId"]);
    expect(world.provider.captureCount()).toBe(1);
    expect((await captureOp(world, intentId)).state).toBe("SUCCEEDED");
    const last = (await world.store.listTransitions(intentId)).at(-1)!;
    expect(last).toMatchObject({ eventType: "CAPTURE_COMPLETED", actor: "provider_readback", from: "CAPTURE_UNKNOWN" });
    expect(last.observationId).not.toBeNull();
  });

  it("REC-02: keeps provider-pending captures non-final until the provider reports completion", async () => {
    const world = createWorld();
    const { session, intentId } = await toApproved(world);
    world.provider.setNextCaptureBehavior("PENDING");
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: true, value: "CAPTURE_PENDING_PROVIDER" });
    const operation = await captureOp(world, intentId);
    expect(operation.state).toBe("PENDING_PROVIDER");

    // Repeated checks while still pending change nothing, however much time passes.
    for (let check = 0; check < 3; check += 1) {
      world.time.advance(10 * 60 * 1000);
      expect(await reconcileOperation(world.payment(), operation.id)).toEqual({ ok: true, value: "CAPTURE_PENDING_PROVIDER" });
    }
    expect((await captureOp(world, intentId)).state).toBe("PENDING_PROVIDER");
    expect(await cancelCheckout(world.checkout, session.id, intentId)).toEqual({ ok: false, error: "CAPTURE_ALREADY_DISPATCHED" });
    expect(await observeCaptureAftermath(world.payment(), intentId)).toEqual({ ok: false, error: "INVALID_STATE" });

    world.provider.simulatePendingCaptureSettled(operation.providerReference!, "COMPLETED");
    expect(await reconcileOperation(world.payment(), operation.id)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });

    // A pending capture can also settle as declined.
    const other = createWorld();
    const setup = await toApproved(other);
    other.provider.setNextCaptureBehavior("PENDING");
    await dispatchCapture(other.payment(), setup.intentId);
    const pending = await captureOp(other, setup.intentId);
    other.provider.simulatePendingCaptureSettled(pending.providerReference!, "DECLINED");
    expect(await reconcileOperation(other.payment(), pending.id)).toEqual({ ok: true, value: "DECLINED_RETRYABLE" });
  });

  it("REC-03: models restart and expired-lease recovery", async () => {
    const world = createWorld();
    const { intentId } = await toApproved(world);

    // Worker A commits the claim, then the process dies before any result is recorded.
    // The provider did receive and apply the request.
    const claimed = await prepareCapture(world.payment("worker-a"), intentId);
    if (!claimed.ok) throw new Error("setup");
    const providerOrderId = (await world.store.findIntent(intentId))!.snapshot.context.providerOrderId!;
    await world.provider.captureOrder({ requestId: claimed.value.providerRequestId, orderId: providerOrderId });
    expect(await stateOf(world, intentId)).toBe("CAPTURE_IN_FLIGHT");
    expect((await captureOp(world, intentId)).state).toBe("DISPATCHING");

    // After "restart", the lease is still live: the recovery worker must wait.
    expect(await world.ledger.listRecoverable(world.time.clock())).toEqual([]);
    expect(await reconcileOperation(world.payment("worker-b"), claimed.value.id)).toEqual({ ok: false, error: "OPERATION_NOT_CLAIMABLE" });
    expect(await dispatchCapture(world.payment("worker-b"), intentId)).toEqual({ ok: false, error: "INVALID_STATE" });

    world.time.advance(LEASE_MS);
    expect((await world.ledger.listRecoverable(world.time.clock())).map((operation) => operation.id)).toEqual([claimed.value.id]);

    const callsBefore = world.provider.calls.length;
    expect(await reconcileOperation(world.payment("worker-b"), claimed.value.id)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    // Recovery read back first and did not resend.
    expect(world.provider.calls.slice(callsBefore)).toEqual(["getCaptureByRequestId"]);
    expect(world.provider.captureCount()).toBe(1);
    const path = (await world.store.listTransitions(intentId)).slice(-2).map((record) => `${record.actor}:${record.from}->${record.to}`);
    expect(path).toEqual(["reconciler:CAPTURE_IN_FLIGHT->CAPTURE_UNKNOWN", "provider_readback:CAPTURE_UNKNOWN->CAPTURED_VERIFIED"]);
    // The crashed worker's late result is ignored.
    expect(await world.ledger.recordOutcome(claimed.value.id, "worker-a", { state: "DECLINED" }, world.time.clock())).toBeNull();
    expect((await captureOp(world, intentId)).state).toBe("SUCCEEDED");
  });

  it("REC-03: a crash before the request left is recovered by resending the same operation", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId } = await confirmedIntent(world, session.id);
    const claimed = await prepareOrderCreate(world.payment("worker-a"), intentId);
    if (!claimed.ok) throw new Error("setup");
    expect(world.provider.calls).toEqual([]);

    world.time.advance(LEASE_MS);
    expect(await reconcileOperation(world.payment("worker-b"), claimed.value.id)).toEqual({ ok: true, value: "AWAITING_APPROVAL" });
    expect(world.provider.calls).toEqual(["getOrderByRequestId", "createOrder"]);
    const operation = await orderOp(world, intentId);
    expect(operation).toMatchObject({ id: claimed.value.id, providerRequestId: claimed.value.providerRequestId, attemptCount: 2, state: "SUCCEEDED" });
    expect(world.provider.orderCount()).toBe(1);
  });
});

describe("REF-01: externally observed refunds are represented without being executed", () => {
  it("observes partial and full refunds and reversals through readback only", async () => {
    const world = createWorld();
    const { intentId, quote } = await toApproved(world);
    await dispatchCapture(world.payment(), intentId);
    const operation = await captureOp(world, intentId);
    const callsBefore = world.provider.calls.length;

    expect(await observeCaptureAftermath(world.payment(), intentId)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });

    world.provider.simulateExternalRefund(operation.providerReference!, 10000);
    expect(await observeCaptureAftermath(world.payment(), intentId)).toEqual({ ok: true, value: "PARTIALLY_REFUNDED_OBSERVED" });
    expect(await observeCaptureAftermath(world.payment(), intentId)).toEqual({ ok: true, value: "PARTIALLY_REFUNDED_OBSERVED" });

    world.provider.simulateExternalRefund(operation.providerReference!, quote.totalCents);
    expect(await observeCaptureAftermath(world.payment(), intentId)).toEqual({ ok: true, value: "REFUNDED_OBSERVED" });

    world.provider.simulateExternalReversalOrDispute(operation.providerReference!);
    expect(await observeCaptureAftermath(world.payment(), intentId)).toEqual({ ok: true, value: "REVERSED_OR_DISPUTED_OBSERVED" });

    // Only readbacks were made: the application executed nothing.
    expect(new Set(world.provider.calls.slice(callsBefore))).toEqual(new Set(["getCaptureByRequestId"]));
    expect(await world.ledger.listForIntent(intentId, "CAPTURE")).toHaveLength(1);
    const refundTransitions = (await world.store.listTransitions(intentId)).filter((record) => /REFUND|REVERSAL/.test(record.eventType));
    expect(refundTransitions.map((record) => record.actor)).toEqual(["provider_readback", "provider_readback", "provider_readback"]);
    expect(refundTransitions.every((record) => record.observationId !== null)).toBe(true);
  });
});
