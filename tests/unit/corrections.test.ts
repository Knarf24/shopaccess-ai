/**
 * Regression tests for Foundation Correction Directive 002
 * (AUD-003 capture evidence, AUD-001 session allocation, AUD-002 confirmation challenges).
 * All tests run against in-memory stores and the local mock provider.
 */
import { describe, expect, it } from "vitest";
import { confirmPurchaseSummary, CONFIRMATION_TTL_MS, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { validateCaptureEvidence, type ExpectedCapture } from "@/lib/payment/capture-evidence";
import {
  dispatchCapture,
  dispatchOrderCreate,
  observeCaptureAftermath,
  prepareCapture,
  reconcileOperation,
  recordBuyerReturn,
  settleCaptureEvidence,
  verifyApproval,
} from "@/lib/payment/orchestrator";
import { PAYMENT_TRANSITIONS } from "@/lib/payment/state-machine";
import type { ProviderCapture } from "@/lib/providers/payment";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { createSessionService, SESSION_ABSOLUTE_LIFETIME_MS, SESSION_IDLE_TIMEOUT_MS } from "@/lib/session/service";
import { InMemorySessionStore } from "@/lib/session/store";
import { digestSessionToken, generateSessionToken } from "@/lib/session/token";
import { createSequentialIdGenerator } from "@/lib/shared/ids";
import { handleConfirm, handleSessionStart } from "@/server/handlers";
import { createRuntime } from "@/server/runtime";
import { buildCheckoutView } from "@/server/views";
import { confirmedIntent, createTestClock, createWorld, LEASE_MS, MINUTE, newSession, quotedIntent, stateOf, TEST_SESSION_KEY, type World, permitPurchase } from "./helpers";

// ---------------------------------------------------------------------------
// AUD-003: capture evidence verification
// ---------------------------------------------------------------------------

async function toApproved(world: World) {
  const { session } = await newSession(world);
  const { intentId, quote } = await confirmedIntent(world, session.id);
  await dispatchOrderCreate(world.payment(), intentId);
  const providerOrderId = (await world.store.findIntent(intentId))!.snapshot.context.providerOrderId!;
  world.provider.simulateBuyerApproval(providerOrderId);
  await recordBuyerReturn(world.payment(), session.id, intentId);
  expect(await verifyApproval(world.payment(), intentId)).toEqual({ ok: true, value: "APPROVED_VERIFIED" });
  return { session, intentId, quote, providerOrderId };
}

const captureOp = async (world: World, intentId: string) => (await world.ledger.listForIntent(intentId, "CAPTURE")).at(-1)!;

type Corruption = [name: string, reason: string, mutate: (capture: ProviderCapture) => unknown];

const without = (key: keyof ProviderCapture) => (capture: ProviderCapture) => {
  const copy: Record<string, unknown> = { ...capture };
  delete copy[key];
  return copy;
};

const CORRUPTIONS: Corruption[] = [
  ["wrong order ID", "ORDER_MISMATCH", (capture) => ({ ...capture, orderId: "MOCK-ORDER-9999" })],
  ["wrong amount (lower)", "AMOUNT_MISMATCH", (capture) => ({ ...capture, amountCents: capture.amountCents - 1 })],
  ["wrong amount (higher)", "AMOUNT_MISMATCH", (capture) => ({ ...capture, amountCents: capture.amountCents + 100 })],
  ["wrong currency", "CURRENCY_MISMATCH", (capture) => ({ ...capture, currency: "EUR" })],
  ["wrong merchant/payee", "MERCHANT_MISMATCH", (capture) => ({ ...capture, merchantId: "dmm_someoneelse" })],
  ["wrong request ID", "REQUEST_MISMATCH", (capture) => ({ ...capture, requestId: "rq_" + "f".repeat(32) })],
  ["missing capture ID", "EVIDENCE_INCOMPLETE", without("captureId")],
  ["missing amount", "EVIDENCE_INCOMPLETE", without("amountCents")],
  ["missing currency", "EVIDENCE_INCOMPLETE", without("currency")],
  ["missing merchant", "EVIDENCE_INCOMPLETE", without("merchantId")],
  ["missing order ID", "EVIDENCE_INCOMPLETE", without("orderId")],
  ["missing status", "EVIDENCE_INCOMPLETE", without("status")],
  ["unrecognised status", "EVIDENCE_INCOMPLETE", (capture) => ({ ...capture, status: "SUCCESS" })],
  ["non-integer amount", "EVIDENCE_INCOMPLETE", (capture) => ({ ...capture, amountCents: capture.amountCents + 0.5 })],
  ["amount as a string", "EVIDENCE_INCOMPLETE", (capture) => ({ ...capture, amountCents: String(capture.amountCents) })],
  ["refund larger than the capture", "EVIDENCE_INCONSISTENT", (capture) => ({ ...capture, refundedCents: capture.amountCents + 1 })],
  ["not an object", "EVIDENCE_INCOMPLETE", () => null],
];

describe("AUD-003: capture evidence is verified before a payment can become CAPTURED_VERIFIED", () => {
  it("1. accepts a correct capture, from a response and from a readback", async () => {
    const world = createWorld();
    const { intentId } = await toApproved(world);
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect((await captureOp(world, intentId)).state).toBe("SUCCEEDED");
    expect(world.audit.list()).toEqual([]);

    const lost = createWorld();
    const setup = await toApproved(lost);
    lost.provider.failNextCapture("LOSE_RESPONSE");
    await dispatchCapture(lost.payment(), setup.intentId);
    expect(await reconcileOperation(lost.payment(), (await captureOp(lost, setup.intentId)).id)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
  });

  it("validator: every expected field must be present, well formed and equal to what was authorized", () => {
    const good: ProviderCapture = {
      captureId: "MOCK-CAPTURE-0001",
      requestId: "rq_1",
      orderId: "MOCK-ORDER-0001",
      status: "COMPLETED",
      amountCents: 79900,
      currency: "USD",
      merchantId: "dmm_shopaccessdemo",
      refundedCents: 0,
      reversedOrDisputed: false,
    };
    const expected: ExpectedCapture = {
      providerRequestId: "rq_1",
      providerOrderId: "MOCK-ORDER-0001",
      totalCents: 79900,
      currency: "USD",
      merchantId: "dmm_shopaccessdemo",
      knownCaptureId: null,
    };
    expect(validateCaptureEvidence(good, expected)).toEqual({ ok: true, value: good });
    for (const [name, reason, mutate] of CORRUPTIONS) {
      expect(validateCaptureEvidence(mutate({ ...good, requestId: "rq_1" }), expected), name).toEqual({ ok: false, error: reason });
    }
    // A capture ID that differs from the one already recorded for this operation is rejected.
    expect(validateCaptureEvidence(good, { ...expected, knownCaptureId: "MOCK-CAPTURE-0002" })).toEqual({ ok: false, error: "CAPTURE_ID_CHANGED" });
    expect(validateCaptureEvidence(good, { ...expected, knownCaptureId: good.captureId }).ok).toBe(true);
  });

  it.each(CORRUPTIONS)("2-6. immediate response with %s goes to MANUAL_REVIEW (%s) and is never completed or retried", async (_name, reason, mutate) => {
    const world = createWorld();
    const { session, intentId } = await toApproved(world);
    world.provider.corruptNextCaptureEvidence(mutate);

    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: true, value: "MANUAL_REVIEW" });

    // Not completed, and the last transition is the guarded mismatch event citing an observation.
    const transitions = await world.store.listTransitions(intentId);
    expect(transitions.some((record) => record.to === "CAPTURED_VERIFIED")).toBe(false);
    const last = transitions.at(-1)!;
    expect(last).toMatchObject({ eventType: "CAPTURE_EVIDENCE_MISMATCH", actor: "provider_response", from: "CAPTURE_IN_FLIGHT", to: "MANUAL_REVIEW" });

    // The conflicting observation is preserved, separately from local state.
    const observation = (await world.store.listObservations(intentId)).at(-1)!;
    expect(observation.id).toBe(last.observationId);
    expect(observation).toMatchObject({ source: "provider_response", subject: "CAPTURE", conflict: reason });

    // No automatic retry: the operation is CONFLICT, unclaimable, and nothing further is sent.
    const operation = await captureOp(world, intentId);
    expect(operation).toMatchObject({ state: "CONFLICT", attemptCount: 1, leaseOwner: null });
    const callsBefore = world.provider.calls.length;
    world.time.advance(10 * LEASE_MS);
    expect(await world.ledger.listRecoverable(world.time.clock())).toEqual([]);
    expect(await reconcileOperation(world.payment("worker-b"), operation.id)).toEqual({ ok: false, error: "OPERATION_NOT_CLAIMABLE" });
    expect(await dispatchCapture(world.payment("worker-b"), intentId)).toEqual({ ok: false, error: "INVALID_STATE" });
    expect(world.provider.calls.length).toBe(callsBefore);
    expect(await stateOf(world, intentId)).toBe("MANUAL_REVIEW");

    // One sanitized audit record, with no session token or CSRF token in it.
    const audit = world.audit.list();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      eventType: "CAPTURE_EVIDENCE_REJECTED",
      actor: "provider_response",
      checkoutIntentId: intentId,
      operationId: operation.id,
      sessionId: session.id,
      detail: { reason, source: "provider_response", observationId: observation.id },
    });
    expect(JSON.stringify(audit)).not.toContain(session.csrfToken);
  });

  it.each(CORRUPTIONS)("7. reconciliation readback with %s goes to MANUAL_REVIEW (%s)", async (_name, reason, mutate) => {
    const world = createWorld();
    const { intentId } = await toApproved(world);
    // The provider applies the capture but the response is lost; what it later reports is wrong.
    world.provider.failNextCapture("LOSE_RESPONSE");
    world.provider.corruptNextCaptureEvidence(mutate);
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: true, value: "CAPTURE_UNKNOWN" });
    const operation = await captureOp(world, intentId);

    expect(await reconcileOperation(world.payment("reconciler-1"), operation.id)).toEqual({ ok: true, value: "MANUAL_REVIEW" });
    const last = (await world.store.listTransitions(intentId)).at(-1)!;
    expect(last).toMatchObject({ eventType: "CAPTURE_EVIDENCE_MISMATCH", actor: "provider_readback", from: "CAPTURE_UNKNOWN", to: "MANUAL_REVIEW" });
    expect((await world.store.listObservations(intentId)).at(-1)).toMatchObject({ source: "provider_readback", conflict: reason });
    expect((await captureOp(world, intentId)).state).toBe("CONFLICT");
    expect(world.audit.list().map((event) => event.detail.reason)).toEqual([reason]);
    // Reconciliation read back once and did not resend the capture.
    expect(world.provider.calls.filter((call) => call === "captureOrder")).toHaveLength(1);
    expect(world.provider.captureCount()).toBe(1);
  });

  it("7. a pending capture that later reports mismatched evidence is not completed", async () => {
    const world = createWorld();
    const { intentId } = await toApproved(world);
    world.provider.setNextCaptureBehavior("PENDING");
    expect(await dispatchCapture(world.payment(), intentId)).toEqual({ ok: true, value: "CAPTURE_PENDING_PROVIDER" });
    const operation = await captureOp(world, intentId);

    world.provider.simulatePendingCaptureSettled(operation.providerReference!, "COMPLETED");
    world.provider.corruptCaptureEvidence(operation.providerReference!, (capture) => ({ ...capture, amountCents: 1 }));
    expect(await reconcileOperation(world.payment(), operation.id)).toEqual({ ok: true, value: "MANUAL_REVIEW" });
    expect((await world.store.listObservations(intentId)).at(-1)).toMatchObject({ conflict: "AMOUNT_MISMATCH", reportedAmountCents: 1, observedStatus: "COMPLETED" });

    // The same applies if the provider swaps in a different capture ID for the operation.
    const swapped = createWorld();
    const setup = await toApproved(swapped);
    swapped.provider.setNextCaptureBehavior("PENDING");
    await dispatchCapture(swapped.payment(), setup.intentId);
    const pending = await captureOp(swapped, setup.intentId);
    swapped.provider.simulatePendingCaptureSettled(pending.providerReference!, "COMPLETED");
    swapped.provider.corruptCaptureEvidence(pending.providerReference!, (capture) => ({ ...capture, captureId: "MOCK-CAPTURE-7777" }));
    expect(await reconcileOperation(swapped.payment(), pending.id)).toEqual({ ok: true, value: "MANUAL_REVIEW" });
    expect(swapped.audit.list()[0].detail.reason).toBe("CAPTURE_ID_CHANGED");
  });

  it("mismatched evidence reporting PENDING or DECLINED is not trusted either", async () => {
    for (const behavior of ["PENDING", "DECLINE"] as const) {
      const world = createWorld();
      const { intentId } = await toApproved(world);
      world.provider.setNextCaptureBehavior(behavior);
      world.provider.corruptNextCaptureEvidence((capture) => ({ ...capture, orderId: "MOCK-ORDER-9999" }));
      expect(await dispatchCapture(world.payment(), intentId), behavior).toEqual({ ok: true, value: "MANUAL_REVIEW" });
    }
  });

  it("8. repeated settlement attempts change nothing after the first", async () => {
    const world = createWorld();
    const { intentId } = await toApproved(world);
    const claimed = await prepareCapture(world.payment(), intentId);
    if (!claimed.ok) throw new Error("setup");
    const providerOrderId = (await world.store.findIntent(intentId))!.snapshot.context.providerOrderId!;
    const response = await world.provider.captureOrder({ requestId: claimed.value.providerRequestId, orderId: providerOrderId });
    if (response.kind !== "RESPONSE") throw new Error("setup");

    expect(await settleCaptureEvidence(world.payment(), claimed.value, response.value, "provider_response")).toBe("SETTLED");
    const versionAfter = (await world.store.findIntent(intentId))!.snapshot.version;
    const observationsAfter = (await world.store.listObservations(intentId)).length;

    // The same evidence again, different (wrong) evidence, and another worker: all are no-ops.
    expect(await settleCaptureEvidence(world.payment(), claimed.value, response.value, "provider_response")).toBe("NOT_LEASE_HOLDER");
    expect(await settleCaptureEvidence(world.payment(), claimed.value, { ...response.value, amountCents: 1 }, "provider_readback")).toBe("NOT_LEASE_HOLDER");
    expect(await settleCaptureEvidence(world.payment("worker-b"), claimed.value, response.value, "provider_response")).toBe("NOT_LEASE_HOLDER");

    expect(await stateOf(world, intentId)).toBe("CAPTURED_VERIFIED");
    expect((await world.store.findIntent(intentId))!.snapshot.version).toBe(versionAfter);
    expect((await world.store.listObservations(intentId)).length).toBe(observationsAfter);
    expect((await captureOp(world, intentId)).state).toBe("SUCCEEDED");
    expect(world.audit.list()).toEqual([]);
  });

  it("8. concurrent settlement: of several simultaneous attempts exactly one takes effect", async () => {
    for (const evidence of ["correct", "mismatched"] as const) {
      const world = createWorld();
      const { intentId } = await toApproved(world);
      if (evidence === "mismatched") world.provider.corruptNextCaptureEvidence((capture) => ({ ...capture, currency: "EUR" }));
      const claimed = await prepareCapture(world.payment(), intentId);
      if (!claimed.ok) throw new Error("setup");
      const providerOrderId = (await world.store.findIntent(intentId))!.snapshot.context.providerOrderId!;
      const response = await world.provider.captureOrder({ requestId: claimed.value.providerRequestId, orderId: providerOrderId });
      if (response.kind !== "RESPONSE") throw new Error("setup");

      const results = await Promise.all(Array.from({ length: 5 }, () => settleCaptureEvidence(world.payment(), claimed.value, response.value, "provider_response")));
      expect(results.filter((result) => result !== "NOT_LEASE_HOLDER"), evidence).toHaveLength(1);
      const transitions = (await world.store.listTransitions(intentId)).filter((record) => record.from === "CAPTURE_IN_FLIGHT");
      expect(transitions, evidence).toHaveLength(1);
      expect(transitions[0].to).toBe(evidence === "correct" ? "CAPTURED_VERIFIED" : "MANUAL_REVIEW");
      expect(world.audit.list()).toHaveLength(evidence === "correct" ? 0 : 1);
    }

    // Two reconcilers racing over the same unknown capture: one claims, the other is refused.
    const world = createWorld();
    const { intentId } = await toApproved(world);
    world.provider.failNextCapture("LOSE_RESPONSE");
    await dispatchCapture(world.payment(), intentId);
    const operation = await captureOp(world, intentId);
    const raced = await Promise.all([reconcileOperation(world.payment("r1"), operation.id), reconcileOperation(world.payment("r2"), operation.id)]);
    expect(raced.filter((result) => result.ok)).toHaveLength(1);
    expect(await stateOf(world, intentId)).toBe("CAPTURED_VERIFIED");
    expect((await world.store.listTransitions(intentId)).filter((record) => record.to === "CAPTURED_VERIFIED")).toHaveLength(1);
  });

  it("CAPTURED_VERIFIED is reachable only through CAPTURE_COMPLETED, and mismatches only lead to MANUAL_REVIEW", () => {
    for (const [from, rules] of Object.entries(PAYMENT_TRANSITIONS)) {
      for (const [type, rule] of Object.entries(rules)) {
        if (rule.to === "CAPTURED_VERIFIED") expect(type, from).toBe("CAPTURE_COMPLETED");
        if (type === "CAPTURE_EVIDENCE_MISMATCH") {
          expect(rule.to, from).toBe("MANUAL_REVIEW");
          expect(rule.actors.every((actor) => actor === "provider_response" || actor === "provider_readback")).toBe(true);
        }
      }
    }
    expect(Object.keys(PAYMENT_TRANSITIONS.MANUAL_REVIEW)).toEqual([]);
  });

  it("after capture, evidence that no longer matches is recorded but never acted on", async () => {
    const world = createWorld();
    const { intentId } = await toApproved(world);
    await dispatchCapture(world.payment(), intentId);
    const operation = await captureOp(world, intentId);
    world.provider.simulateExternalRefund(operation.providerReference!, 10000);
    world.provider.corruptCaptureEvidence(operation.providerReference!, (capture) => ({ ...capture, orderId: "MOCK-ORDER-9999" }));
    expect(await observeCaptureAftermath(world.payment(), intentId)).toEqual({ ok: true, value: "CAPTURED_VERIFIED" });
    expect((await world.store.listObservations(intentId)).at(-1)).toMatchObject({ conflict: "ORDER_MISMATCH" });
  });
});

// ---------------------------------------------------------------------------
// AUD-001: session allocation and cleanup
// ---------------------------------------------------------------------------

function sessionWorld(allocation = { maxActiveSessions: 5, maxNewSessionsPerWindow: 3, windowMs: MINUTE }) {
  const time = createTestClock();
  const store = new InMemorySessionStore();
  const sessions = createSessionService({ store, key: TEST_SESSION_KEY, clock: time.clock, ids: createSequentialIdGenerator(), allocation });
  return { time, store, sessions };
}

describe("AUD-001: anonymous session allocation is bounded and expired sessions are reclaimed", () => {
  it("repeated new-session requests are refused once the process-wide budget is spent, before any session is created", async () => {
    const { store, sessions } = sessionWorld();
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await sessions.establish(null)).ok).toBe(true);

    let scans = 0;
    const originalCount = store.count.bind(store);
    store.count = async () => ((scans += 1), originalCount());
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const refused = await sessions.establish(attempt % 2 ? generateSessionToken() : null);
      expect(refused).toMatchObject({ ok: false, error: { reason: "ALLOCATION_RATE_EXCEEDED" } });
      if (!refused.ok) expect(refused.error.retryAfterMs).toBeGreaterThan(0);
    }
    // The refusal happened on the cheap counter: no cleanup scan, no storage, no growth.
    expect(scans).toBe(0);
    expect(await originalCount()).toBe(3);
  });

  it("rate limit recovers after the permitted interval", async () => {
    const { time, sessions } = sessionWorld();
    for (let attempt = 0; attempt < 3; attempt += 1) await sessions.establish(null);
    expect((await sessions.establish(null)).ok).toBe(false);
    time.advance(MINUTE - 1);
    expect((await sessions.establish(null)).ok).toBe(false);
    time.advance(1);
    expect((await sessions.establish(null)).ok).toBe(true);
  });

  it("capacity exhaustion: live sessions never exceed the cap, however long creation is attempted", async () => {
    const { time, store, sessions } = sessionWorld();
    let created = 0;
    let capacityRefusals = 0;
    for (let minute = 0; minute < 20; minute += 1) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const result = await sessions.establish(null);
        if (result.ok) created += 1;
        else if (result.error.reason === "SESSION_CAPACITY_REACHED") capacityRefusals += 1;
        expect(await store.count()).toBeLessThanOrEqual(5);
      }
      time.advance(MINUTE);
    }
    expect(created).toBe(5);
    expect(capacityRefusals).toBeGreaterThan(0);
    expect(await store.count()).toBe(5);
  });

  it("expired-session cleanup: idle, absolute-expired and revoked sessions are reclaimed and capacity is freed", async () => {
    const { time, store, sessions } = sessionWorld({ maxActiveSessions: 3, maxNewSessionsPerWindow: 100, windowMs: MINUTE });
    const issued = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await sessions.establish(null);
      if (!result.ok) throw new Error("setup");
      issued.push(result.value);
    }
    expect(await sessions.establish(null)).toMatchObject({ ok: false, error: { reason: "SESSION_CAPACITY_REACHED" } });

    // One is revoked, one stays active, one goes idle.
    await sessions.revoke(issued[0].session.id);
    time.advance(SESSION_IDLE_TIMEOUT_MS - MINUTE);
    expect((await sessions.resolve(issued[1].issuedToken)).ok).toBe(true);
    time.advance(2 * MINUTE);

    expect(await sessions.purgeExpired()).toBe(2);
    expect(await store.count()).toBe(1);
    // Reclaimed sessions are gone for good: their tokens identify nothing.
    expect(await store.findByTokenDigest(digestSessionToken(TEST_SESSION_KEY, issued[2].issuedToken!))).toBeNull();
    expect(await sessions.resolve(issued[2].issuedToken)).toEqual({ ok: false, error: "SESSION_UNKNOWN" });
    expect((await sessions.resolve(issued[1].issuedToken)).ok).toBe(true);

    // Allocation runs cleanup itself: capacity is available again without an explicit purge.
    expect((await sessions.establish(null)).ok).toBe(true);
    expect((await sessions.establish(null)).ok).toBe(true);
    expect(await sessions.establish(null)).toMatchObject({ ok: false, error: { reason: "SESSION_CAPACITY_REACHED" } });

    time.advance(SESSION_ABSOLUTE_LIFETIME_MS);
    expect(await sessions.purgeExpired()).toBe(3);
    expect(await store.count()).toBe(0);
  });

  it("expired-session cleanup happens on the allocation path itself, with no separate purge call", async () => {
    const { time, store, sessions } = sessionWorld({ maxActiveSessions: 2, maxNewSessionsPerWindow: 100, windowMs: MINUTE });
    await sessions.establish(null);
    await sessions.establish(null);
    expect(await sessions.establish(null)).toMatchObject({ ok: false, error: { reason: "SESSION_CAPACITY_REACHED" } });

    time.advance(SESSION_IDLE_TIMEOUT_MS);
    expect((await sessions.establish(null)).ok).toBe(true);
    expect(await store.count()).toBe(1);
  });

  it("valid-session reuse: an existing session keeps working and spends no allocation budget", async () => {
    const { sessions, store } = sessionWorld();
    const first = await sessions.establish(null);
    if (!first.ok) throw new Error("setup");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const reused = await sessions.establish(first.value.issuedToken);
      expect(reused).toMatchObject({ ok: true, value: { issuedToken: null, session: { id: first.value.session.id } } });
    }
    // The budget (3) is still available for two more new sessions, then exhausted; the existing session is unaffected.
    expect((await sessions.establish(null)).ok).toBe(true);
    expect((await sessions.establish(null)).ok).toBe(true);
    expect((await sessions.establish(null)).ok).toBe(false);
    expect((await sessions.establish(first.value.issuedToken)).ok).toBe(true);
    expect((await sessions.resolve(first.value.issuedToken)).ok).toBe(true);
    expect(await store.count()).toBe(3);
  });

  it("session isolation and fixation resistance are unchanged under allocation limits", async () => {
    const { sessions, store } = sessionWorld();
    const alice = await sessions.establish(null);
    const bob = await sessions.establish(null);
    if (!alice.ok || !bob.ok) throw new Error("setup");
    expect(alice.value.session.id).not.toBe(bob.value.session.id);
    expect(alice.value.issuedToken).not.toBe(bob.value.issuedToken);
    expect(alice.value.session.csrfToken).not.toBe(bob.value.session.csrfToken);
    expect(sessions.verifyCsrfToken(alice.value.session, bob.value.session.csrfToken)).toBe(false);

    // An attacker-chosen token is never adopted, whether or not budget remains.
    const planted = generateSessionToken();
    const withBudget = await sessions.establish(planted);
    expect(withBudget.ok && withBudget.value.issuedToken).not.toBe(planted);
    const withoutBudget = await sessions.establish(planted);
    expect(withoutBudget.ok).toBe(false);
    expect((await sessions.resolve(planted)).ok).toBe(false);

    // Stored records hold digests only; refusals carry no token or digest.
    const stored = await store.findByTokenDigest(digestSessionToken(TEST_SESSION_KEY, alice.value.issuedToken!));
    expect(JSON.stringify(stored)).not.toContain(alice.value.issuedToken);
    expect(JSON.stringify(withoutBudget)).not.toMatch(/[A-Za-z0-9_-]{43}|[0-9a-f]{64}/);
  });

  it("the session-start route enforces the limits and ignores caller-controlled forwarded-IP headers", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins(["https://shop.example.test"]) }, { clock: time.clock });
    const start = (headers: Record<string, string> = {}) =>
      handleSessionStart(new Request("https://shop.example.test/session/start?use=programming&budget=900", { headers }), runtime);

    const statuses: number[] = [];
    let cookie = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      // Rotating spoofed client addresses buys nothing: the budget is process-wide.
      const response = await start({ "x-forwarded-for": `203.0.113.${attempt}`, "x-real-ip": `198.51.100.${attempt}`, forwarded: `for=192.0.2.${attempt}` });
      statuses.push(response.status);
      if (response.status === 303 && !cookie) cookie = response.headers.get("set-cookie")!.split(";")[0];
    }
    expect(statuses.filter((status) => status === 303)).toHaveLength(30);
    expect(statuses.slice(30).every((status) => status === 429)).toBe(true);

    const refused = await start();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(JSON.parse(await refused.text()).error.code).toBe("RATE_LIMITED");

    // A shopper who already has a session is not locked out while new allocation is refused.
    const existing = await start({ cookie });
    expect(existing.status).toBe(303);
    expect(existing.headers.get("set-cookie")).toBeNull();
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);

    time.advance(MINUTE);
    expect((await start()).status).toBe(303);
  });

  it("the route reports capacity exhaustion as 503 without creating a session", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins(["https://shop.example.test"]) }, { clock: time.clock });
    // Fill to the default capacity of 500 across several windows (30 per minute), staying inside the idle timeout.
    let created = 0;
    while (created < 500) {
      for (let attempt = 0; attempt < 30 && created < 500; attempt += 1) {
        const response = await handleSessionStart(new Request("https://shop.example.test/session/start"), runtime);
        expect(response.status).toBe(303);
        created += 1;
      }
      time.advance(MINUTE);
    }
    const full = await handleSessionStart(new Request("https://shop.example.test/session/start"), runtime);
    expect(full.status).toBe(503);
    expect(full.headers.get("set-cookie")).toBeNull();
    expect(JSON.parse(await full.text()).error.code).toBe("UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// AUD-002: confirmation challenge lifecycle
// ---------------------------------------------------------------------------

async function challenge(world: World, sessionId: string, quoteId: string) {
  const prepared = await prepareConfirmation(world.checkout, sessionId, quoteId);
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.error}`);
  const { confirmationId, nonce, quoteDigest } = prepared.value;
  return { ...prepared.value, submission: { confirmationId, nonce, quoteId, quoteDigest } };
}

describe("AUD-002: one active confirmation challenge per quote", () => {
  it("1. repeated checkout views never accumulate challenges", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins(["https://shop.example.test"]) }, { clock: time.clock });
    const established = await runtime.sessions.establish(null);
    if (!established.ok) throw new Error("setup");
    const session = established.value.session;
    // M2-3: the application's checkout start, which reserves the shopper's purchase permission.
    const { startCheckoutWithQuote } = await import("@/lib/checkout/service");
    await permitPurchase(runtime, session.id);
    const started = await startCheckoutWithQuote(runtime.checkout, session.id, { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: 1 });
    if (!started.ok) throw new Error(started.error);
    const intent = started.value.intent;

    const seen = new Set<string>();
    for (let view = 0; view < 200; view += 1) {
      const rendered = await buildCheckoutView(runtime, session, intent.id);
      seen.add(rendered!.challenge!.confirmationId);
      expect(runtime.store.confirmationCount()).toBe(1);
    }
    expect(seen.size).toBe(200);
  });

  it("2. two browser tabs: the newer tab can confirm; the older one is told to refresh and nothing is confirmed by it", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, quote } = await quotedIntent(world, session.id);
    const tabA = await challenge(world, session.id, quote.quoteId);
    const tabB = await challenge(world, session.id, quote.quoteId);
    expect(tabA.nonce).not.toBe(tabB.nonce);

    expect(await confirmPurchaseSummary(world.checkout, session.id, tabA.submission)).toEqual({ ok: false, error: "CONFIRMATION_SUPERSEDED" });
    expect(await stateOf(world, intentId)).toBe("QUOTED");
    // Mixing the old ID with the new nonce, or the new ID with the old nonce, does not work either.
    expect(await confirmPurchaseSummary(world.checkout, session.id, { ...tabA.submission, nonce: tabB.nonce })).toEqual({ ok: false, error: "CONFIRMATION_SUPERSEDED" });
    expect(await confirmPurchaseSummary(world.checkout, session.id, { ...tabB.submission, nonce: tabA.nonce })).toEqual({ ok: false, error: "CONFIRMATION_MISMATCH" });

    expect((await confirmPurchaseSummary(world.checkout, session.id, tabB.submission)).ok).toBe(true);
    expect(await stateOf(world, intentId)).toBe("USER_CONFIRMED");
    // After the other tab confirmed, the old tab learns it is already confirmed.
    expect(await confirmPurchaseSummary(world.checkout, session.id, tabA.submission)).toEqual({ ok: false, error: "CONFIRMATION_ALREADY_USED" });
  });

  it("2. the route gives the older tab a clear refresh message", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins(["https://shop.example.test"]) }, { clock: time.clock });
    const established = await runtime.sessions.establish(null);
    if (!established.ok) throw new Error("setup");
    const { session, issuedToken } = established.value;
    const { startCheckoutWithQuote } = await import("@/lib/checkout/service");
    const { messageFor } = await import("@/server/views");
    await permitPurchase(runtime, session.id);
    const started = await startCheckoutWithQuote(runtime.checkout, session.id, { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: 1 });
    if (!started.ok) throw new Error(started.error);
    const intent = started.value.intent;
    const tabA = (await buildCheckoutView(runtime, session, intent.id))!.challenge!;
    await buildCheckoutView(runtime, session, intent.id);

    const response = await handleConfirm(
      new Request(`https://shop.example.test/checkout/${intent.id}/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://shop.example.test",
          "sec-fetch-site": "same-origin",
          cookie: `${SESSION_COOKIE_NAME}=${issuedToken}`,
        },
        body: new URLSearchParams({
          confirmationId: tabA.confirmationId,
          nonce: tabA.nonce,
          quoteId: tabA.quoteId,
          quoteDigest: tabA.quoteDigest,
          acknowledged: "yes",
          csrfToken: session.csrfToken,
        }).toString(),
      }),
      runtime,
      intent.id,
    );
    expect(response.headers.get("location")).toBe(`/checkout/${intent.id}?error=CONFIRMATION_SUPERSEDED`);
    expect(messageFor("CONFIRMATION_SUPERSEDED")).toMatch(/another tab or refreshed.*Nothing was confirmed.*confirm again/);
    expect((await runtime.store.findIntent(intent.id))!.snapshot.state).toBe("QUOTED");
  });

  it("3. concurrent challenge issuance leaves exactly one active challenge, and only it can confirm", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, quote } = await quotedIntent(world, session.id);
    const issued = await Promise.all(Array.from({ length: 12 }, () => challenge(world, session.id, quote.quoteId)));
    expect(world.store.confirmationCount()).toBe(1);
    expect(new Set(issued.map((item) => item.nonce)).size).toBe(12);

    const active = await world.store.findConfirmationForQuote(session.id, quote.quoteId);
    const results = await Promise.all(issued.map((item) => confirmPurchaseSummary(world.checkout, session.id, item.submission)));
    const succeeded = results.map((result, index) => (result.ok ? issued[index].confirmationId : null)).filter(Boolean);
    expect(succeeded).toEqual([active!.id]);
    expect((await world.store.listTransitions(intentId)).filter((record) => record.eventType === "SHOPPER_CONFIRMED")).toHaveLength(1);
  });

  it("4. old challenge invalidation is atomic and keeps session, intent, digest and expiry binding", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, quote } = await quotedIntent(world, session.id);
    const first = await challenge(world, session.id, quote.quoteId);
    world.time.advance(MINUTE);
    const second = await challenge(world, session.id, quote.quoteId);

    expect(await world.store.findConfirmationForSession(session.id, first.confirmationId)).toBeNull();
    const record = await world.store.findConfirmationForQuote(session.id, quote.quoteId);
    expect(record).toMatchObject({ id: second.confirmationId, sessionId: session.id, checkoutIntentId: intentId, quoteId: quote.quoteId, quoteDigest: quote.digest, consumedAt: null });
    expect(Date.parse(record!.expiresAt) - Date.parse(record!.issuedAt)).toBe(CONFIRMATION_TTL_MS);
    expect(JSON.stringify(record)).not.toContain(second.nonce);

    // Two quotes each keep their own single challenge.
    const other = await quotedIntent(world, session.id);
    await challenge(world, session.id, other.quote.quoteId);
    expect(world.store.confirmationCount()).toBe(2);
    expect((await world.store.findConfirmationForQuote(session.id, quote.quoteId))!.id).toBe(second.confirmationId);
  });

  it("5. expired, unused challenges are reclaimed; a consumed one is kept", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const quotes = [];
    for (let index = 0; index < 4; index += 1) quotes.push(await quotedIntent(world, session.id));
    const challenges = [];
    for (const item of quotes) challenges.push(await challenge(world, session.id, item.quote.quoteId));
    expect((await confirmPurchaseSummary(world.checkout, session.id, challenges[0].submission)).ok).toBe(true);
    expect(world.store.confirmationCount()).toBe(4);

    world.time.advance(CONFIRMATION_TTL_MS);
    expect(await confirmPurchaseSummary(world.checkout, session.id, challenges[1].submission)).toEqual({ ok: false, error: "CONFIRMATION_EXPIRED" });
    expect(await world.store.purgeExpiredConfirmations(world.time.clock())).toBe(3);
    expect(world.store.confirmationCount()).toBe(1);
    expect((await world.store.findConfirmationForQuote(session.id, quotes[0].quote.quoteId))!.consumedAt).not.toBeNull();
    // After reclamation an old submission is still refused, and issuing a new challenge also cleans up.
    expect(await confirmPurchaseSummary(world.checkout, session.id, challenges[2].submission)).toEqual({ ok: false, error: "CONFIRMATION_NOT_FOUND" });
    const fresh = await challenge(world, session.id, quotes[3].quote.quoteId);
    expect(world.store.confirmationCount()).toBe(2);
    expect((await confirmPurchaseSummary(world.checkout, session.id, fresh.submission)).ok).toBe(true);
  });

  it("6-7. successful confirmation, then replay is rejected and no new challenge can be issued for that quote", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, quote } = await quotedIntent(world, session.id);
    const issued = await challenge(world, session.id, quote.quoteId);

    const confirmed = await confirmPurchaseSummary(world.checkout, session.id, issued.submission);
    expect(confirmed).toMatchObject({ ok: true, value: { confirmationId: issued.confirmationId, checkoutIntentId: intentId, quoteId: quote.quoteId } });

    for (let replay = 0; replay < 3; replay += 1) {
      expect(await confirmPurchaseSummary(world.checkout, session.id, issued.submission)).toEqual({ ok: false, error: "CONFIRMATION_ALREADY_USED" });
    }
    expect(await prepareConfirmation(world.checkout, session.id, quote.quoteId)).toEqual({ ok: false, error: "INTENT_NOT_AWAITING_CONFIRMATION" });
    // The store itself refuses to replace a consumed challenge.
    const consumed = (await world.store.findConfirmationForQuote(session.id, quote.quoteId))!;
    expect(await world.store.replaceActiveConfirmation({ ...consumed, id: "cf_" + "9".repeat(32), consumedAt: null })).toBe(false);
    expect((await world.store.findConfirmationForQuote(session.id, quote.quoteId))!.id).toBe(issued.confirmationId);
    expect((await world.store.listTransitions(intentId)).filter((record) => record.eventType === "SHOPPER_CONFIRMED")).toHaveLength(1);
    expect(await world.ledger.listForIntent(intentId, "ORDER_CREATE")).toHaveLength(0);
  });

  it("8. cross-session challenge submission fails and cannot disturb the owner's challenge", async () => {
    const world = createWorld();
    const alice = await newSession(world);
    const mallory = await newSession(world);
    const { intentId, quote } = await quotedIntent(world, alice.session.id);
    const issued = await challenge(world, alice.session.id, quote.quoteId);

    expect(await confirmPurchaseSummary(world.checkout, mallory.session.id, issued.submission)).toEqual({ ok: false, error: "CONFIRMATION_NOT_FOUND" });
    // Mallory cannot issue (and so replace) a challenge for Alice's quote.
    expect(await prepareConfirmation(world.checkout, mallory.session.id, quote.quoteId)).toEqual({ ok: false, error: "QUOTE_NOT_FOUND" });
    expect(await world.store.findConfirmationForQuote(mallory.session.id, quote.quoteId)).toBeNull();
    expect((await world.store.findConfirmationForQuote(alice.session.id, quote.quoteId))!.id).toBe(issued.confirmationId);

    expect(await stateOf(world, intentId)).toBe("QUOTED");
    expect((await confirmPurchaseSummary(world.checkout, alice.session.id, issued.submission)).ok).toBe(true);
  });
});
