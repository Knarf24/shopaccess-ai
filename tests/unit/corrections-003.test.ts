/**
 * Regression tests for Foundation Correction Directive 003
 * (AUD-011 capacity race, AUD-012 orphaned checkout records, quote validation before intent creation).
 * Everything here is in-memory and single-process; none of it demonstrates database-level guarantees.
 */
import { describe, expect, it } from "vitest";
import { startCheckoutWithQuote } from "@/lib/checkout/service";
import { confirmPurchaseSummary, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { dispatchCapture, dispatchOrderCreate, recordBuyerReturn, verifyApproval } from "@/lib/payment/orchestrator";
import type { PaymentProvider } from "@/lib/providers/payment";
import { InMemoryAuditLog } from "@/lib/security/audit";
import { createFixedWindowRateLimiter, InMemoryRateLimitStore } from "@/lib/security/rate-limit";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { createSessionService, SESSION_IDLE_TIMEOUT_MS, type SessionAllocationPolicy } from "@/lib/session/service";
import { InMemorySessionStore, type SessionRecord } from "@/lib/session/store";
import { generateSessionToken } from "@/lib/session/token";
import { createSequentialIdGenerator } from "@/lib/shared/ids";
import { handleCheckoutStart, handleSessionStart } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, MINUTE, TEST_SESSION_KEY } from "./helpers";

const ORIGIN = "https://shop.example.test";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// AUD-011: concurrent session-capacity race
// ---------------------------------------------------------------------------

/** A store whose cleanup and count are slow, so concurrent callers genuinely interleave around the capacity decision. */
class InterleavingSessionStore extends InMemorySessionStore {
  failNextInsert = false;

  override async deleteExpired(now: Date, idleCutoff: Date): Promise<string[]> {
    await tick();
    return super.deleteExpired(now, idleCutoff);
  }

  override async count(): Promise<number> {
    const value = await super.count();
    await tick();
    await tick();
    return value;
  }

  override async insertWithinCapacity(record: SessionRecord, maxSessions: number): Promise<boolean> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error("simulated storage failure");
    }
    return super.insertWithinCapacity(record, maxSessions);
  }
}

function sessionWorld(allocation: SessionAllocationPolicy) {
  const time = createTestClock();
  const store = new InterleavingSessionStore();
  const sessions = createSessionService({ store, key: TEST_SESSION_KEY, clock: time.clock, ids: createSequentialIdGenerator(), allocation });
  return { time, store, sessions };
}

const WIDE_BUDGET = { maxNewSessionsPerWindow: 1000, windowMs: MINUTE };

describe("AUD-011: session capacity cannot be exceeded by concurrent requests", () => {
  it("one remaining slot: of many parallel requests exactly one gets it", async () => {
    const { store, sessions } = sessionWorld({ maxActiveSessions: 5, ...WIDE_BUDGET });
    for (let index = 0; index < 4; index += 1) expect((await sessions.establish(null)).ok).toBe(true);

    const results = await Promise.all(Array.from({ length: 25 }, () => sessions.establish(null)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results.filter((candidate) => !candidate.ok)) {
      expect(result).toMatchObject({ ok: false, error: { reason: "SESSION_CAPACITY_REACHED" } });
    }
    expect(await store.count()).toBe(5);
  });

  it("full capacity: every parallel request is refused and nothing is stored", async () => {
    const { store, sessions } = sessionWorld({ maxActiveSessions: 3, ...WIDE_BUDGET });
    for (let index = 0; index < 3; index += 1) await sessions.establish(null);

    const results = await Promise.all(Array.from({ length: 25 }, () => sessions.establish(null)));
    expect(results.every((result) => !result.ok && result.error.reason === "SESSION_CAPACITY_REACHED")).toBe(true);
    expect(await store.count()).toBe(3);
  });

  it("empty store: a burst larger than capacity creates exactly `capacity` sessions, each distinct", async () => {
    const { store, sessions } = sessionWorld({ maxActiveSessions: 7, ...WIDE_BUDGET });
    const results = await Promise.all(Array.from({ length: 60 }, () => sessions.establish(null)));
    const created = results.flatMap((result) => (result.ok ? [result.value] : []));
    expect(created).toHaveLength(7);
    expect(new Set(created.map((item) => item.session.id)).size).toBe(7);
    expect(new Set(created.map((item) => item.issuedToken)).size).toBe(7);
    expect(await store.count()).toBe(7);

    // Repeated bursts never push it over.
    for (let round = 0; round < 5; round += 1) {
      await Promise.all(Array.from({ length: 20 }, () => sessions.establish(null)));
      expect(await store.count()).toBe(7);
    }
  });

  it("the store's check-and-insert is atomic on its own", async () => {
    const store = new InMemorySessionStore();
    const now = new Date("2026-10-08T12:00:00.000Z");
    const record = (index: number): SessionRecord => ({
      id: `ses_${index.toString(16).padStart(32, "0")}`,
      tokenDigest: index.toString(16).padStart(64, "0"),
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + MINUTE),
      revokedAt: null,
    });
    const results = await Promise.all(Array.from({ length: 50 }, (_unused, index) => store.insertWithinCapacity(record(index), 10)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await store.count()).toBe(10);
    expect(await store.insertWithinCapacity(record(99), 10)).toBe(false);
  });

  it("the 30-per-minute style process-wide budget still holds under parallel requests", async () => {
    const { time, store, sessions } = sessionWorld({ maxActiveSessions: 100, maxNewSessionsPerWindow: 3, windowMs: MINUTE });
    const burst = await Promise.all(Array.from({ length: 40 }, () => sessions.establish(null)));
    expect(burst.filter((result) => result.ok)).toHaveLength(3);
    expect(burst.filter((result) => !result.ok && result.error.reason === "ALLOCATION_RATE_EXCEEDED")).toHaveLength(37);
    expect(await store.count()).toBe(3);

    time.advance(MINUTE);
    const next = await Promise.all(Array.from({ length: 40 }, () => sessions.establish(null)));
    expect(next.filter((result) => result.ok)).toHaveLength(3);
    expect(await store.count()).toBe(6);
  });

  it("valid-session reuse is unaffected at full capacity, in parallel with new-session attempts", async () => {
    const { store, sessions } = sessionWorld({ maxActiveSessions: 2, ...WIDE_BUDGET });
    const first = await sessions.establish(null);
    const second = await sessions.establish(null);
    if (!first.ok || !second.ok) throw new Error("setup");

    const mixed = await Promise.all(
      Array.from({ length: 30 }, (_unused, index) => sessions.establish(index % 3 === 0 ? null : index % 3 === 1 ? first.value.issuedToken : generateSessionToken())),
    );
    mixed.forEach((result, index) => {
      if (index % 3 === 1) expect(result).toMatchObject({ ok: true, value: { issuedToken: null, session: { id: first.value.session.id } } });
      else expect(result.ok).toBe(false);
    });
    expect(await store.count()).toBe(2);
    expect((await sessions.resolve(second.value.issuedToken)).ok).toBe(true);
  });

  it("a failed session creation holds no capacity: there is nothing to leak", async () => {
    const { store, sessions } = sessionWorld({ maxActiveSessions: 2, ...WIDE_BUDGET });
    expect((await sessions.establish(null)).ok).toBe(true);

    store.failNextInsert = true;
    await expect(sessions.establish(null)).rejects.toThrow("simulated storage failure");
    expect(await store.count()).toBe(1);

    // The slot the failed attempt was going for is still available, and the cap still holds afterwards.
    expect((await sessions.establish(null)).ok).toBe(true);
    expect(await sessions.establish(null)).toMatchObject({ ok: false, error: { reason: "SESSION_CAPACITY_REACHED" } });
    expect(await store.count()).toBe(2);

    // Many failures in a row change nothing either.
    const { store: other, sessions: otherSessions } = sessionWorld({ maxActiveSessions: 1, ...WIDE_BUDGET });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      other.failNextInsert = true;
      await expect(otherSessions.establish(null)).rejects.toThrow();
    }
    expect((await otherSessions.establish(null)).ok).toBe(true);
  });

  it("the route: a parallel burst creates at most the budget, and each success has its own cookie", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
    const responses = await Promise.all(Array.from({ length: 80 }, () => handleSessionStart(new Request(`${ORIGIN}/session/start`), runtime)));
    const created = responses.filter((response) => response.status === 303);
    expect(created).toHaveLength(30);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(50);
    expect(new Set(created.map((response) => response.headers.get("set-cookie"))).size).toBe(30);
    expect(responses.filter((response) => response.status !== 303).every((response) => response.headers.get("set-cookie") === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AUD-012: orphaned checkout records
// ---------------------------------------------------------------------------

function runtimeWorld() {
  const time = createTestClock();
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
  return { time, runtime };
}

async function shopper(runtime: Runtime) {
  const established = await runtime.sessions.establish(null);
  if (!established.ok) throw new Error(`session refused: ${established.error.reason}`);
  return { session: established.value.session, token: established.value.issuedToken! };
}

const VALID_REQUEST = { productId: "dmp_codebook15", variantId: "dmv_codebook15a", quantity: 1 };

/** Drives one checkout through quote, confirmation, order, approval and capture, leaving records of every kind. */
async function fullCheckout(runtime: Runtime, sessionId: string, capture: "complete" | "pending" | "lost" = "complete") {
  const started = await startCheckoutWithQuote(runtime.checkout, sessionId, VALID_REQUEST);
  if (!started.ok) throw new Error(started.error);
  const { intent, quote } = started.value;
  const challenge = await prepareConfirmation(runtime.checkout, sessionId, quote.quoteId);
  if (!challenge.ok) throw new Error(challenge.error);
  const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
  await confirmPurchaseSummary(runtime.checkout, sessionId, { confirmationId, nonce, quoteId, quoteDigest });
  await dispatchOrderCreate(runtime.payment, intent.id);
  const providerOrderId = (await runtime.store.findIntent(intent.id))!.snapshot.context.providerOrderId!;
  runtime.provider.simulateBuyerApproval(providerOrderId);
  await recordBuyerReturn(runtime.payment, sessionId, intent.id);
  await verifyApproval(runtime.payment, intent.id);
  if (capture === "pending") runtime.provider.setNextCaptureBehavior("PENDING");
  if (capture === "lost") runtime.provider.failNextCapture("LOSE_RESPONSE");
  await dispatchCapture(runtime.payment, intent.id);
  return { intentId: intent.id, quoteId: quote.quoteId };
}

const totals = (runtime: Runtime) => ({
  ...runtime.store.recordCounts(),
  operations: runtime.ledger.operationCount(),
  providerOrders: runtime.provider.orderCount(),
  providerCaptures: runtime.provider.captureCount(),
});

const EMPTY = { intents: 0, transitions: 0, quotes: 0, confirmations: 0, observations: 0, operations: 0, providerOrders: 0, providerCaptures: 0 };

describe("AUD-012: reclaiming a mock session removes everything it owned", () => {
  it("cleanup: intents, history, quotes, confirmations, operations, observations and mock provider records all go", async () => {
    const { time, runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    // Include unknown and pending outcomes: in the local mock these are removed too.
    await fullCheckout(runtime, alice.session.id, "complete");
    await fullCheckout(runtime, alice.session.id, "pending");
    await fullCheckout(runtime, alice.session.id, "lost");
    await startCheckoutWithQuote(runtime.checkout, alice.session.id, VALID_REQUEST);

    const before = totals(runtime);
    expect(before).toMatchObject({ intents: 4, quotes: 4, confirmations: 3, operations: 6, providerOrders: 3, providerCaptures: 3 });
    expect(before.transitions).toBeGreaterThan(15);
    expect(before.observations).toBeGreaterThan(6);

    time.advance(SESSION_IDLE_TIMEOUT_MS);
    await runtime.maintain();
    expect(totals(runtime)).toEqual(EMPTY);
    expect((await runtime.sessions.resolve(alice.token)).ok).toBe(false);
  });

  it("revoked sessions are reclaimed with their records as well", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    await fullCheckout(runtime, alice.session.id);
    await runtime.sessions.revoke(alice.session.id);
    expect(await runtime.sessions.purgeExpired()).toBe(1);
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("ownership isolation: another session's records are untouched and remain fully usable", async () => {
    const { time, runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const bob = await shopper(runtime);
    await fullCheckout(runtime, alice.session.id);
    await fullCheckout(runtime, alice.session.id, "pending");
    const bobDone = await fullCheckout(runtime, bob.session.id);
    const bobSnapshot = JSON.stringify([
      await runtime.store.findIntentForSession(bob.session.id, bobDone.intentId),
      await runtime.store.listTransitions(bobDone.intentId),
      await runtime.store.listObservations(bobDone.intentId),
      await runtime.ledger.listForIntent(bobDone.intentId, "CAPTURE"),
      await runtime.store.findQuoteForSession(bob.session.id, bobDone.quoteId),
    ]);

    // Bob stays active; Alice goes idle.
    time.advance(SESSION_IDLE_TIMEOUT_MS - MINUTE);
    expect((await runtime.sessions.resolve(bob.token)).ok).toBe(true);
    time.advance(2 * MINUTE);
    await runtime.maintain();

    expect(totals(runtime)).toMatchObject({ intents: 1, quotes: 1, confirmations: 1, operations: 2, providerOrders: 1, providerCaptures: 1 });
    expect(
      JSON.stringify([
        await runtime.store.findIntentForSession(bob.session.id, bobDone.intentId),
        await runtime.store.listTransitions(bobDone.intentId),
        await runtime.store.listObservations(bobDone.intentId),
        await runtime.ledger.listForIntent(bobDone.intentId, "CAPTURE"),
        await runtime.store.findQuoteForSession(bob.session.id, bobDone.quoteId),
      ]),
    ).toBe(bobSnapshot);

    // Bob can still start, confirm and pay (simulated) for a new checkout.
    const bobOpen = await startCheckoutWithQuote(runtime.checkout, bob.session.id, VALID_REQUEST);
    if (!bobOpen.ok) throw new Error("setup");
    const challenge = await prepareConfirmation(runtime.checkout, bob.session.id, bobOpen.value.quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
    expect((await confirmPurchaseSummary(runtime.checkout, bob.session.id, { confirmationId, nonce, quoteId, quoteDigest })).ok).toBe(true);
    expect(await dispatchOrderCreate(runtime.payment, bobOpen.value.intent.id)).toEqual({ ok: true, value: "AWAITING_APPROVAL" });
  });

  it("the store removes by owner only, and reports exactly which intents went", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const bob = await shopper(runtime);
    const a = await fullCheckout(runtime, alice.session.id);
    const b = await fullCheckout(runtime, bob.session.id);
    expect(await runtime.store.deleteForSessions([alice.session.id, "ses_" + "f".repeat(32)])).toEqual([a.intentId]);
    expect(await runtime.store.hasIntent(a.intentId)).toBe(false);
    expect(await runtime.store.hasIntent(b.intentId)).toBe(true);
    expect(await runtime.store.deleteForSessions([])).toEqual([]);
  });

  it("repeated cleanup is idempotent, including several cleanups at once", async () => {
    const { time, runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const bob = await shopper(runtime);
    await fullCheckout(runtime, alice.session.id);
    await fullCheckout(runtime, bob.session.id);
    time.advance(SESSION_IDLE_TIMEOUT_MS - MINUTE);
    await runtime.sessions.resolve(bob.token);
    time.advance(2 * MINUTE);

    const removed = await Promise.all(Array.from({ length: 6 }, () => runtime.sessions.purgeExpired()));
    expect(removed.reduce((total, count) => total + count, 0)).toBe(1);
    const after = totals(runtime);
    expect(after).toMatchObject({ intents: 1, operations: 2, providerOrders: 1, providerCaptures: 1 });

    for (let repeat = 0; repeat < 5; repeat += 1) {
      expect(await runtime.sessions.purgeExpired()).toBe(0);
      expect(await runtime.store.deleteForSessions([alice.session.id])).toEqual([]);
      expect(totals(runtime)).toEqual(after);
    }
  });

  it("concurrent activity: a payment step still running when its session is reclaimed leaves no orphans and reports cleanly", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const bob = await shopper(runtime);
    const bobCheckout = await fullCheckout(runtime, bob.session.id);

    const started = await startCheckoutWithQuote(runtime.checkout, alice.session.id, VALID_REQUEST);
    if (!started.ok) throw new Error("setup");
    const challenge = await prepareConfirmation(runtime.checkout, alice.session.id, started.value.quote.quoteId);
    if (!challenge.ok) throw new Error("setup");
    const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
    await confirmPurchaseSummary(runtime.checkout, alice.session.id, { confirmationId, nonce, quoteId, quoteDigest });

    // The session is revoked and reclaimed in the middle of the (mock) provider call.
    const racingProvider: PaymentProvider = {
      createOrder: async (request) => {
        await runtime.sessions.revoke(alice.session.id);
        await runtime.sessions.purgeExpired();
        return runtime.provider.createOrder(request);
      },
      captureOrder: (request) => runtime.provider.captureOrder(request),
      getOrder: (id) => runtime.provider.getOrder(id),
      getOrderByRequestId: (id) => runtime.provider.getOrderByRequestId(id),
      getCaptureByRequestId: (id) => runtime.provider.getCaptureByRequestId(id),
    };
    const result = await dispatchOrderCreate({ ...runtime.payment, provider: racingProvider }, started.value.intent.id);
    expect(result).toEqual({ ok: false, error: "INTENT_NOT_FOUND" });

    // Late writes from the straggler were dropped; the one mock order it created is collected by the next sweep.
    expect(runtime.store.recordCounts()).toMatchObject({ intents: 1, quotes: 1, confirmations: 1 });
    expect(await runtime.store.listObservations(started.value.intent.id)).toEqual([]);
    expect(await runtime.ledger.listForIntent(started.value.intent.id, "ORDER_CREATE")).toEqual([]);
    await runtime.sessions.purgeExpired();
    expect(totals(runtime)).toMatchObject({ intents: 1, operations: 2, providerOrders: 1, providerCaptures: 1 });
    // Bob was not disturbed.
    expect((await runtime.store.findIntentForSession(bob.session.id, bobCheckout.intentId))!.snapshot.state).toBe("CAPTURED_VERIFIED");

    // Writes addressed to a reclaimed checkout are refused at the store itself.
    await runtime.store.insertQuote(started.value.quote);
    expect(await runtime.store.findQuote(started.value.quote.quoteId)).toBeNull();
    expect(await prepareConfirmation(runtime.checkout, alice.session.id, started.value.quote.quoteId)).toEqual({ ok: false, error: "QUOTE_NOT_FOUND" });
  });

  it("concurrent activity: cleanup running alongside other shoppers' checkouts removes only the expired owner's data", async () => {
    const { time, runtime } = runtimeWorld();
    const old = await shopper(runtime);
    await fullCheckout(runtime, old.session.id);
    time.advance(SESSION_IDLE_TIMEOUT_MS);
    const live = [await shopper(runtime), await shopper(runtime), await shopper(runtime)];

    await Promise.all([
      runtime.sessions.purgeExpired(),
      ...live.map((item) => fullCheckout(runtime, item.session.id)),
      runtime.sessions.purgeExpired(),
    ]);
    expect(totals(runtime)).toMatchObject({ intents: 3, quotes: 3, confirmations: 3, operations: 6, providerOrders: 3, providerCaptures: 3 });
    for (const item of live) expect((await runtime.sessions.resolve(item.token)).ok).toBe(true);
  });

  it("long-running use does not accumulate records: after many expired sessions only live data remains", async () => {
    const { time, runtime } = runtimeWorld();
    let peak = 0;
    for (let cycle = 0; cycle < 40; cycle += 1) {
      const visitor = await shopper(runtime);
      await fullCheckout(runtime, visitor.session.id, cycle % 3 === 0 ? "lost" : cycle % 3 === 1 ? "pending" : "complete");
      await startCheckoutWithQuote(runtime.checkout, visitor.session.id, VALID_REQUEST);
      time.advance(SESSION_IDLE_TIMEOUT_MS);
      // Maintenance is driven by ordinary request handling, not by a test-only call.
      await handleSessionStart(new Request(`${ORIGIN}/session/start`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${visitor.token}` } }), runtime);
      peak = Math.max(peak, totals(runtime).intents);
    }
    // Each cycle's request reclaimed the previous visitor and admitted one new, empty session.
    expect(peak).toBe(0);
    expect(totals(runtime)).toEqual(EMPTY);
    expect(await runtime.sessions.purgeExpired()).toBe(0);
  });

  it("cleanup is driven by ordinary requests from live shoppers, with no new session needed", async () => {
    for (const trigger of ["session-start with a valid cookie", "a checkout mutation"] as const) {
      const { time, runtime } = runtimeWorld();
      const gone = await shopper(runtime);
      const live = await shopper(runtime);
      await fullCheckout(runtime, gone.session.id, "pending");
      time.advance(SESSION_IDLE_TIMEOUT_MS - MINUTE);
      await runtime.sessions.resolve(live.token);
      time.advance(2 * MINUTE);
      expect(totals(runtime).intents).toBe(1);

      const cookie = `${SESSION_COOKIE_NAME}=${live.token}`;
      if (trigger === "session-start with a valid cookie") {
        const response = await handleSessionStart(new Request(`${ORIGIN}/session/start`, { headers: { cookie } }), runtime);
        expect(response.headers.get("set-cookie")).toBeNull();
      } else {
        // Even a rejected mutation (wrong CSRF token) runs maintenance first.
        const response = await handleCheckoutStart(
          new Request(`${ORIGIN}/checkout/start`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie },
            body: "csrfToken=wrong",
          }),
          runtime,
        );
        expect(response.status).toBe(403);
      }
      expect(totals(runtime), trigger).toEqual(EMPTY);
      expect((await runtime.sessions.resolve(live.token)).ok).toBe(true);
    }
  });

  it("maintenance does its work at most once a minute", async () => {
    const { time, runtime } = runtimeWorld();
    const visitor = await shopper(runtime);
    await fullCheckout(runtime, visitor.session.id);
    await runtime.maintain();
    await runtime.sessions.revoke(visitor.session.id);
    await runtime.maintain();
    expect(totals(runtime).intents).toBe(1);
    time.advance(MINUTE);
    await runtime.maintain();
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("related mock records are bounded too: rate-limit counters and the in-memory audit log", async () => {
    const time = createTestClock();
    const store = new InMemoryRateLimitStore();
    const limiter = createFixedWindowRateLimiter(store, time.clock);
    const policy = { name: "p", limit: 5, windowMs: MINUTE };
    for (let minute = 0; minute < 30; minute += 1) {
      for (let subject = 0; subject < 20; subject += 1) await limiter.consume(policy, `ses_${minute}_${subject}`);
      time.advance(MINUTE);
    }
    expect(store.size()).toBeLessThanOrEqual(40);
    // Limits inside the current window are unaffected by the pruning.
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await limiter.consume(policy, "same")).allowed).toBe(true);
    expect((await limiter.consume(policy, "same")).allowed).toBe(false);

    const log = new InMemoryAuditLog(100);
    const event = (index: number) => ({
      eventId: `ev_${index}`,
      eventType: "TEST_EVENT",
      occurredAt: "2026-10-08T12:00:00.000Z",
      actor: "server",
      sessionId: null,
      checkoutIntentId: null,
      operationId: null,
      detail: { index },
    });
    for (let index = 0; index < 1000; index += 1) await log.append(event(index));
    expect(log.list()).toHaveLength(100);
    expect(log.list()[0].eventId).toBe("ev_900");
    await expect(log.append(event(999))).rejects.toThrow("Duplicate");
  });
});

// ---------------------------------------------------------------------------
// Quote requests are validated before any checkout record is created
// ---------------------------------------------------------------------------

describe("checkout start validates the quote request before creating an intent", () => {
  const INVALID: [string, unknown, string][] = [
    ["external product ID", { ...VALID_REQUEST, productId: "ext_mock-aurora-13" }, "REQUEST_INVALID"],
    ["external variant ID", { ...VALID_REQUEST, variantId: "ext_mock-aurora-13" }, "REQUEST_INVALID"],
    ["unknown product", { ...VALID_REQUEST, productId: "dmp_doesnotexist" }, "PRODUCT_NOT_IN_MERCHANT_CATALOG"],
    ["variant of another product", { productId: "dmp_studybook14", variantId: "dmv_codebook15a", quantity: 1 }, "PRODUCT_NOT_IN_MERCHANT_CATALOG"],
    ["out-of-stock variant", { productId: "dmp_campusbook16", variantId: "dmv_campusbook16a", quantity: 1 }, "VARIANT_UNAVAILABLE"],
    ["zero quantity", { ...VALID_REQUEST, quantity: 0 }, "REQUEST_INVALID"],
    ["negative quantity", { ...VALID_REQUEST, quantity: -1 }, "REQUEST_INVALID"],
    ["fractional quantity", { ...VALID_REQUEST, quantity: 1.5 }, "REQUEST_INVALID"],
    ["quantity above the global limit", { ...VALID_REQUEST, quantity: 11 }, "REQUEST_INVALID"],
    ["quantity above the variant limit", { ...VALID_REQUEST, quantity: 3 }, "QUANTITY_EXCEEDS_LIMIT"],
    ["quantity as text", { ...VALID_REQUEST, quantity: "2" }, "REQUEST_INVALID"],
    ["NaN quantity", { ...VALID_REQUEST, quantity: Number.NaN }, "REQUEST_INVALID"],
    ["missing variant", { productId: "dmp_codebook15", quantity: 1 }, "REQUEST_INVALID"],
    ["client price override", { ...VALID_REQUEST, unitAmountCents: 1 }, "REQUEST_INVALID"],
    ["client total override", { ...VALID_REQUEST, totalCents: 1 }, "REQUEST_INVALID"],
    ["null", null, "REQUEST_INVALID"],
    ["array", [VALID_REQUEST], "REQUEST_INVALID"],
    ["string", "dmp_codebook15", "REQUEST_INVALID"],
  ];

  it.each(INVALID)("service: %s allocates nothing", async (_name, request, reason) => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    expect(await startCheckoutWithQuote(runtime.checkout, alice.session.id, request)).toEqual({ ok: false, error: reason });
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("service: a valid request creates exactly one intent, one quote and one transition, priced by the server", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const started = await startCheckoutWithQuote(runtime.checkout, alice.session.id, { ...VALID_REQUEST, quantity: 2 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(totals(runtime)).toEqual({ ...EMPTY, intents: 1, quotes: 1, transitions: 1 });
    expect(started.value.intent.snapshot).toMatchObject({ state: "QUOTED", version: 2, context: { quoteId: started.value.quote.quoteId } });
    expect(started.value.quote).toMatchObject({
      sessionId: alice.session.id,
      checkoutIntentId: started.value.intent.id,
      unitAmountCents: 79900,
      totalCents: 159800,
      currency: "USD",
    });
    expect(await runtime.store.findIntentForSession(alice.session.id, started.value.intent.id)).toMatchObject({ snapshot: { state: "QUOTED" } });
    expect((await runtime.store.listTransitions(started.value.intent.id))[0]).toMatchObject({ eventType: "QUOTE_ISSUED", actor: "server", from: "DRAFT", to: "QUOTED" });
  });

  function post(fields: Record<string, string>, cookie: string | null, headers: Record<string, string> = {}): Request {
    return new Request(`${ORIGIN}/checkout/start`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it("route: invalid and external-product requests create no checkout state, however many are sent", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const cookie = `${SESSION_COOKIE_NAME}=${alice.token}`;
    const base = { productId: "dmp_codebook15", variantId: "dmv_codebook15a", quantity: "1", csrfToken: alice.session.csrfToken };
    const invalid: [Record<string, string>, string][] = [
      [{ ...base, productId: "ext_mock-aurora-13" }, "REQUEST_INVALID"],
      [{ ...base, productId: "ext_mock-aurora-13", variantId: "ext_mock-aurora-13" }, "REQUEST_INVALID"],
      [{ ...base, productId: "dmp_doesnotexist" }, "PRODUCT_NOT_IN_MERCHANT_CATALOG"],
      [{ ...base, productId: "dmp_campusbook16", variantId: "dmv_campusbook16a" }, "VARIANT_UNAVAILABLE"],
      [{ ...base, quantity: "0" }, "REQUEST_INVALID"],
      [{ ...base, quantity: "99" }, "REQUEST_INVALID"],
      [{ ...base, quantity: "3" }, "QUANTITY_EXCEEDS_LIMIT"],
      [{ ...base, quantity: "abc" }, "REQUEST_INVALID"],
      [{ csrfToken: alice.session.csrfToken }, "REQUEST_INVALID"],
    ];
    for (const [fields, reason] of invalid) {
      const response = await handleCheckoutStart(post(fields, cookie), runtime);
      expect(response.status).toBe(303);
      expect(response.headers.get("location"), JSON.stringify(fields)).toBe(`/shop?error=${reason}`);
      expect(totals(runtime), JSON.stringify(fields)).toEqual(EMPTY);
    }
    // No QUOTE_ISSUED audit entry was written for any of them.
    expect(runtime.audit.list()).toEqual([]);
  });

  it("route: authorization still comes first, and server pricing is unchanged", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const cookie = `${SESSION_COOKIE_NAME}=${alice.token}`;
    const good = { productId: "dmp_codebook15", variantId: "dmv_codebook15a", quantity: "1", csrfToken: alice.session.csrfToken };

    const refused = [
      post(good, cookie, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
      post({ ...good, csrfToken: "0".repeat(64) }, cookie),
      post(good, null),
      post(good, `${SESSION_COOKIE_NAME}=${"B".repeat(43)}`),
    ];
    for (const request of refused) expect((await handleCheckoutStart(request, runtime)).status).toBe(403);
    expect(totals(runtime)).toEqual(EMPTY);

    // Monetary fields in the form are never read: the server prices the quote.
    const response = await handleCheckoutStart(post({ ...good, unitAmountCents: "1", totalCents: "1", currency: "EUR" }, cookie), runtime);
    const intentId = response.headers.get("location")!.split("/").pop()!;
    expect(response.headers.get("location")).toMatch(/^\/checkout\/ci_[0-9a-f]{32}$/);
    expect(totals(runtime)).toEqual({ ...EMPTY, intents: 1, quotes: 1, transitions: 1 });
    const quoteId = (await runtime.store.findIntent(intentId))!.snapshot.context.quoteId!;
    expect(await runtime.store.findQuoteForSession(alice.session.id, quoteId)).toMatchObject({ unitAmountCents: 79900, totalCents: 79900, currency: "USD" });
  });
});
