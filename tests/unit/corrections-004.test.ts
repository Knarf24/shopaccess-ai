/**
 * Regression tests for Foundation Correction Directive 004
 * (AUD-012: late checkout-intent insertion after session reclamation).
 *
 * Concurrency here is forced with explicit barriers, never with sleeps: a
 * checkout request is held at the exact point just before its commit, other
 * work is run to completion, and only then is the request released.
 * In-memory, single-process guarantees only.
 */
import { describe, expect, it } from "vitest";
import { startCheckout, startCheckoutWithQuote, type CheckoutDeps } from "@/lib/checkout/service";
import { InMemoryCheckoutStore, type CheckoutRepository, type CheckoutStartCommit, type SessionLivenessCheck } from "@/lib/checkout/store";
import { confirmPurchaseSummary, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { dispatchCapture, dispatchOrderCreate, recordBuyerReturn, verifyApproval } from "@/lib/payment/orchestrator";
import { INITIAL_PAYMENT_SNAPSHOT } from "@/lib/payment/state-machine";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { SESSION_ABSOLUTE_LIFETIME_MS, SESSION_IDLE_TIMEOUT_MS } from "@/lib/session/service";
import { InMemorySessionStore } from "@/lib/session/store";
import { handleCheckoutStart } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, MINUTE, TEST_SESSION_KEY, permitPurchase } from "./helpers";

const ORIGIN = "https://shop.example.test";
const VALID_REQUEST = { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: 1 };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function runtimeWorld() {
  const time = createTestClock();
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
  return { time, runtime };
}

async function shopper(runtime: Runtime) {
  const established = await runtime.sessions.establish(null);
  if (!established.ok) throw new Error(`session refused: ${established.error.reason}`);
  // M2-3: a shopper creates the purchase permission before checking out.
  await permitPurchase(runtime, established.value.session.id);
  return { session: established.value.session, token: established.value.issuedToken!, cookie: `${SESSION_COOKIE_NAME}=${established.value.issuedToken}` };
}

/**
 * Wraps the runtime so that each checkout commit stops at a barrier placed
 * immediately before the store's atomic commit. Every earlier step of the
 * request (authorization, rate limiting, quote validation and pricing) has
 * already happened when `reached` resolves. Call `release()` to let it commit.
 */
function holdCheckoutCommits(runtime: Runtime, count: number) {
  const barriers = Array.from({ length: count }, () => ({ reached: deferred(), released: deferred() }));
  let next = 0;
  const gatedStore: CheckoutRepository = Object.create(runtime.store, {
    commitCheckoutStart: {
      value: async (commit: CheckoutStartCommit, sessionIsLive: SessionLivenessCheck) => {
        const barrier = barriers[next++];
        if (barrier) {
          barrier.reached.resolve();
          await barrier.released.promise;
        }
        return runtime.store.commitCheckoutStart(commit, sessionIsLive);
      },
    },
  });
  const checkout: CheckoutDeps = { ...runtime.checkout, store: gatedStore };
  return {
    runtime: { ...runtime, checkout } as Runtime,
    checkout,
    barriers: barriers.map((barrier) => ({ reached: barrier.reached.promise, release: () => barrier.released.resolve() })),
  };
}

function checkoutPost(cookie: string, csrfToken: string, fields: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/checkout/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie },
    body: new URLSearchParams({ productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: "1", csrfToken, ...fields }).toString(),
  });
}

const totals = (runtime: Runtime) => ({
  ...runtime.store.recordCounts(),
  operations: runtime.ledger.operationCount(),
  providerOrders: runtime.provider.orderCount(),
  providerCaptures: runtime.provider.captureCount(),
});
const EMPTY = { intents: 0, transitions: 0, quotes: 0, confirmations: 0, observations: 0, operations: 0, providerOrders: 0, providerCaptures: 0 };

async function fullCheckout(runtime: Runtime, sessionId: string) {
  await permitPurchase(runtime, sessionId);
  const started = await startCheckoutWithQuote(runtime.checkout, sessionId, VALID_REQUEST);
  if (!started.ok) throw new Error(started.error);
  const challenge = await prepareConfirmation(runtime.checkout, sessionId, started.value.quote.quoteId);
  if (!challenge.ok) throw new Error(challenge.error);
  const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
  await confirmPurchaseSummary(runtime.checkout, sessionId, { confirmationId, nonce, quoteId, quoteDigest });
  await dispatchOrderCreate(runtime.payment, started.value.intent.id);
  const providerOrderId = (await runtime.store.findIntent(started.value.intent.id))!.snapshot.context.providerOrderId!;
  runtime.provider.simulateBuyerApproval(providerOrderId);
  await recordBuyerReturn(runtime.payment, sessionId, started.value.intent.id);
  await verifyApproval(runtime.payment, started.value.intent.id);
  await dispatchCapture(runtime.payment, started.value.intent.id);
  return started.value.intent.id;
}

describe("AUD-012: no checkout record is committed for a session that expired, was revoked or was reclaimed", () => {
  it("the audited interleaving: authorize, pause before commit, revoke, reclaim to completion, resume -> rejected, nothing stored", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 1);

    // 1-2. The request passes authorization, rate limiting and quote validation, then stops just before the commit.
    const pending = handleCheckoutStart(checkoutPost(alice.cookie, alice.session.csrfToken), held.runtime);
    await held.barriers[0].reached;
    expect(totals(runtime)).toEqual(EMPTY);

    // 3-4. The owning session is revoked and reclamation runs to completion, including checkout cleanup.
    await runtime.sessions.revoke(alice.session.id);
    expect(await runtime.sessions.purgeExpired()).toBe(1);
    expect((await runtime.sessions.resolve(alice.token)).ok).toBe(false);

    // 5-6. The original request resumes and is refused with the generic, sanitized response.
    held.barriers[0].release();
    const response = await pending;
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(JSON.parse(body).error).toMatchObject({ code: "FORBIDDEN", message: "This action is not allowed." });
    expect(body).not.toMatch(/session|expired|revoked|reclaim/i);
    expect(response.headers.get("location")).toBeNull();

    // 7. No orphan of any kind, now or after further cleanup; and no audit entry claims a quote was issued.
    expect(totals(runtime)).toEqual(EMPTY);
    await runtime.sessions.purgeExpired();
    expect(totals(runtime)).toEqual(EMPTY);
    expect(runtime.audit.list().filter((event) => event.eventType === "QUOTE_ISSUED")).toEqual([]);
  });

  it("the same interleaving when the session expires by idle timeout and is reclaimed", async () => {
    const { time, runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 1);
    const pending = startCheckoutWithQuote(held.checkout, alice.session.id, VALID_REQUEST);
    await held.barriers[0].reached;

    time.advance(SESSION_IDLE_TIMEOUT_MS);
    expect(await runtime.sessions.purgeExpired()).toBe(1);

    held.barriers[0].release();
    expect(await pending).toEqual({ ok: false, error: "SESSION_NOT_ACTIVE" });
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it.each([
    ["idle timeout", SESSION_IDLE_TIMEOUT_MS],
    ["absolute lifetime", SESSION_ABSOLUTE_LIFETIME_MS],
  ])("session expires immediately before commit (%s), with no reclamation run yet: rejected", async (_name, elapsed) => {
    const { time, runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 1);
    const pending = startCheckoutWithQuote(held.checkout, alice.session.id, VALID_REQUEST);
    await held.barriers[0].reached;

    // One millisecond before expiry a commit would still succeed; at expiry it does not.
    time.advance(elapsed);
    held.barriers[0].release();
    expect(await pending).toEqual({ ok: false, error: "SESSION_NOT_ACTIVE" });
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("session is revoked immediately before commit, with no reclamation run yet: rejected", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 1);
    const pending = handleCheckoutStart(checkoutPost(alice.cookie, alice.session.csrfToken), held.runtime);
    await held.barriers[0].reached;

    await runtime.sessions.revoke(alice.session.id);
    held.barriers[0].release();
    expect((await pending).status).toBe(403);
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("commit just inside the session lifetime succeeds", async () => {
    const { time, runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 1);
    const pending = startCheckoutWithQuote(held.checkout, alice.session.id, VALID_REQUEST);
    await held.barriers[0].reached;
    time.advance(14 * MINUTE);
    held.barriers[0].release();
    expect((await pending).ok).toBe(true);
    expect(totals(runtime)).toEqual({ ...EMPTY, intents: 1, quotes: 1, transitions: 1 });
  });

  it("commit succeeds before reclamation, then reclamation removes its records", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 1);
    const pending = handleCheckoutStart(checkoutPost(alice.cookie, alice.session.csrfToken), held.runtime);
    await held.barriers[0].reached;

    // Released while the session is still live: the checkout is committed in full.
    held.barriers[0].release();
    const response = await pending;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^\/checkout\/ci_[0-9a-f]{32}$/);
    expect(totals(runtime)).toEqual({ ...EMPTY, intents: 1, quotes: 1, transitions: 1 });

    await runtime.sessions.revoke(alice.session.id);
    await runtime.sessions.purgeExpired();
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("two concurrent checkout requests and one reclamation: the one that commits first is cleaned up, the late one is rejected", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 2);
    // Start them one after the other so it is certain which request holds which barrier.
    const first = handleCheckoutStart(checkoutPost(alice.cookie, alice.session.csrfToken), held.runtime);
    await held.barriers[0].reached;
    const second = handleCheckoutStart(checkoutPost(alice.cookie, alice.session.csrfToken), held.runtime);
    await held.barriers[1].reached;

    // Request 1 commits while the session is live.
    held.barriers[0].release();
    expect((await first).status).toBe(303);
    expect(totals(runtime)).toMatchObject({ intents: 1, quotes: 1 });

    // Reclamation runs to completion between the two commits.
    await runtime.sessions.revoke(alice.session.id);
    expect(await runtime.sessions.purgeExpired()).toBe(1);
    expect(totals(runtime)).toEqual(EMPTY);

    // Request 2 resumes afterwards.
    held.barriers[1].release();
    expect((await second).status).toBe(403);
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("two paused requests released together with reclamation in flight: whatever the order, nothing is left behind", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 2);
    const requests = [
      startCheckoutWithQuote(held.checkout, alice.session.id, VALID_REQUEST),
      startCheckoutWithQuote(held.checkout, alice.session.id, VALID_REQUEST),
    ];
    await Promise.all(held.barriers.map((barrier) => barrier.reached));

    await runtime.sessions.revoke(alice.session.id);
    const reclaiming = runtime.sessions.purgeExpired();
    held.barriers.forEach((barrier) => barrier.release());
    const [results] = await Promise.all([Promise.all(requests), reclaiming]);

    expect(results).toEqual([
      { ok: false, error: "SESSION_NOT_ACTIVE" },
      { ok: false, error: "SESSION_NOT_ACTIVE" },
    ]);
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("another shopper's records remain untouched throughout", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const bob = await shopper(runtime);
    const bobIntent = await fullCheckout(runtime, bob.session.id);
    const bobBefore = JSON.stringify([
      await runtime.store.findIntentForSession(bob.session.id, bobIntent),
      await runtime.store.listTransitions(bobIntent),
      await runtime.store.listObservations(bobIntent),
      await runtime.ledger.listForIntent(bobIntent, "CAPTURE"),
    ]);
    const before = totals(runtime);
    // M2-3: Bob's first permission was used by his completed checkout; he creates a new one for the next.
    await permitPurchase(runtime, bob.session.id);

    const held = holdCheckoutCommits(runtime, 2);
    const stale = handleCheckoutStart(checkoutPost(alice.cookie, alice.session.csrfToken), held.runtime);
    await held.barriers[0].reached;
    const bobNew = handleCheckoutStart(checkoutPost(bob.cookie, bob.session.csrfToken), held.runtime);
    await held.barriers[1].reached;
    await runtime.sessions.revoke(alice.session.id);
    await runtime.sessions.purgeExpired();
    held.barriers.forEach((barrier) => barrier.release());

    expect((await stale).status).toBe(403);
    expect((await bobNew).status).toBe(303);
    expect(totals(runtime)).toEqual({ ...before, intents: before.intents + 1, quotes: before.quotes + 1, transitions: before.transitions + 1 });
    expect(
      JSON.stringify([
        await runtime.store.findIntentForSession(bob.session.id, bobIntent),
        await runtime.store.listTransitions(bobIntent),
        await runtime.store.listObservations(bobIntent),
        await runtime.ledger.listForIntent(bobIntent, "CAPTURE"),
      ]),
    ).toBe(bobBefore);
    // Everything that remains belongs to Bob.
    const bobNewId = (await bobNew).headers.get("location")!.split("/").pop()!;
    for (const intentId of [bobIntent, bobNewId]) expect((await runtime.store.findIntent(intentId))!.sessionId).toBe(bob.session.id);
    expect(runtime.store.recordCounts().intents).toBe(2);
  });

  it("the store commit is all-or-nothing and is the only way to create an intent", async () => {
    const store = new InMemoryCheckoutStore();
    const sessions = new InMemorySessionStore();
    const now = new Date("2026-10-08T12:00:00.000Z");
    const sessionId = "ses_" + "a".repeat(32);
    await sessions.insertWithinCapacity(
      { id: sessionId, tokenDigest: "a".repeat(64), createdAt: now, lastSeenAt: now, absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_LIFETIME_MS), revokedAt: null },
      10,
    );
    const live: SessionLivenessCheck = (id) => sessions.isLive(id, now, SESSION_IDLE_TIMEOUT_MS);
    const intent = (id: string, owner = sessionId) => ({ id, sessionId: owner, snapshot: INITIAL_PAYMENT_SNAPSHOT, createdAt: now.toISOString() });

    // The liveness callback is asked about the intent's own session, exactly once, and decides the outcome.
    const asked: string[] = [];
    expect(await store.commitCheckoutStart({ intent: intent("ci_1"), transitions: [], quote: null }, (id) => (asked.push(id), false))).toBe(false);
    expect(asked).toEqual([sessionId]);
    expect(store.recordCounts()).toMatchObject({ intents: 0, quotes: 0, transitions: 0 });

    expect(await store.commitCheckoutStart({ intent: intent("ci_1"), transitions: [], quote: null }, live)).toBe(true);
    // An unknown, reclaimed or revoked session is never live.
    expect(await store.commitCheckoutStart({ intent: intent("ci_2", "ses_" + "b".repeat(32)), transitions: [], quote: null }, live)).toBe(false);
    await sessions.revoke(sessionId, now);
    expect(await store.commitCheckoutStart({ intent: intent("ci_3"), transitions: [], quote: null }, live)).toBe(false);
    await sessions.deleteExpired(now, new Date(0));
    expect(await store.commitCheckoutStart({ intent: intent("ci_4"), transitions: [], quote: null }, live)).toBe(false);
    expect(store.recordCounts().intents).toBe(1);

    // There is no other insertion method on the repository.
    const methods = Object.getOwnPropertyNames(InMemoryCheckoutStore.prototype);
    expect(methods).toContain("commitCheckoutStart");
    expect(methods).not.toContain("insertIntent");
    expect(methods.filter((name) => /intent/i.test(name) && /^(insert|create|add|put|save)/i.test(name))).toEqual([]);
  });

  it("the commit and the liveness check contain no await: the decision and the writes cannot be separated", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const body = (file: string, start: string, end: string) => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const from = source.indexOf(start);
      const to = source.indexOf(end, from + start.length);
      expect(from, start).toBeGreaterThan(-1);
      expect(to, end).toBeGreaterThan(from);
      return source.slice(from + start.length, to).replace(/\/\/.*$/gm, "");
    };
    const commit = body("src/lib/checkout/store.ts", "async commitCheckoutStart(commit: CheckoutStartCommit", "async findIntentForSession(");
    expect(commit).not.toMatch(/\bawait\b|\.then\(|setTimeout|queueMicrotask/);
    expect(commit.indexOf("sessionIsLive(intent.sessionId)")).toBeGreaterThan(-1);
    expect(commit.indexOf("sessionIsLive(intent.sessionId)")).toBeLessThan(commit.indexOf("this.intents.set("));

    const reclaim = body("src/lib/checkout/store.ts", "async deleteForSessions(sessionIds: readonly string[])", "recordCounts()");
    expect(reclaim).not.toMatch(/\bawait\b|\.then\(/);
    const expire = body("src/lib/session/store.ts", "async deleteExpired(now: Date, idleCutoff: Date)", "async count()");
    expect(expire).not.toMatch(/\bawait\b|\.then\(/);
    const liveness = body("src/lib/session/store.ts", "isLive(sessionId: string, now: Date, idleTimeoutMs: number): boolean {", "\n  }\n");
    expect(liveness).not.toMatch(/\bawait\b|async|Promise/);
  });

  it("the plain DRAFT helper obeys the same rule", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    await runtime.sessions.revoke(alice.session.id);
    await expect(startCheckout(runtime.checkout, alice.session.id)).rejects.toThrow("SESSION_NOT_ACTIVE");
    await expect(startCheckout(runtime.checkout, "ses_" + "0".repeat(32))).rejects.toThrow("SESSION_NOT_ACTIVE");
    expect(totals(runtime)).toEqual(EMPTY);
  });
});

describe("previously verified behaviour is unchanged by the commit boundary", () => {
  it("invalid quote requests still create no intent and never reach the commit", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 1);
    held.runtime.catalog.products[2].variants[0].availability = "OUT_OF_STOCK";
    let commitReached = false;
    void held.barriers[0].reached.then(() => (commitReached = true));

    for (const [fields, reason] of [
      [{ productId: "ext_mock-aurora-13" }, "REQUEST_INVALID"],
      [{ productId: "dmp_doesnotexist" }, "PRODUCT_NOT_IN_MERCHANT_CATALOG"],
      [{ productId: "dmp_vivobook16", variantId: "dmv_vivobook16" }, "VARIANT_UNAVAILABLE"],
      [{ quantity: "0" }, "REQUEST_INVALID"],
      [{ quantity: "3" }, "QUANTITY_EXCEEDS_LIMIT"],
    ] as [Record<string, string>, string][]) {
      const response = await handleCheckoutStart(checkoutPost(alice.cookie, alice.session.csrfToken, fields), held.runtime);
      expect(response.headers.get("location"), JSON.stringify(fields)).toBe(`/shop?error=${reason}`);
    }
    await Promise.resolve();
    expect(commitReached).toBe(false);
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("authorization still precedes everything: an unauthorized request never reaches validation or the commit", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const held = holdCheckoutCommits(runtime, 1);
    let commitReached = false;
    void held.barriers[0].reached.then(() => (commitReached = true));
    const response = await handleCheckoutStart(checkoutPost(alice.cookie, "0".repeat(64)), held.runtime);
    expect(response.status).toBe(403);
    expect(commitReached).toBe(false);
    expect(totals(runtime)).toEqual(EMPTY);
  });

  it("session capacity and the allocation budget are unaffected", async () => {
    const { runtime } = runtimeWorld();
    const results = await Promise.all(Array.from({ length: 60 }, () => runtime.sessions.establish(null)));
    expect(results.filter((result) => result.ok)).toHaveLength(30);
    expect(results.filter((result) => !result.ok && result.error.reason === "ALLOCATION_RATE_EXCEEDED")).toHaveLength(30);
  });

  it("a live shopper's normal checkout still works end to end, including capture evidence and confirmation replay protection", async () => {
    const { runtime } = runtimeWorld();
    const alice = await shopper(runtime);
    const started = await startCheckoutWithQuote(runtime.checkout, alice.session.id, VALID_REQUEST);
    if (!started.ok) throw new Error(started.error);
    const challenge = await prepareConfirmation(runtime.checkout, alice.session.id, started.value.quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
    const submission = { confirmationId, nonce, quoteId, quoteDigest };
    expect((await confirmPurchaseSummary(runtime.checkout, alice.session.id, submission)).ok).toBe(true);
    expect(await confirmPurchaseSummary(runtime.checkout, alice.session.id, submission)).toEqual({ ok: false, error: "CONFIRMATION_ALREADY_USED" });

    await dispatchOrderCreate(runtime.payment, started.value.intent.id);
    const providerOrderId = (await runtime.store.findIntent(started.value.intent.id))!.snapshot.context.providerOrderId!;
    runtime.provider.simulateBuyerApproval(providerOrderId);
    await recordBuyerReturn(runtime.payment, alice.session.id, started.value.intent.id);
    await verifyApproval(runtime.payment, started.value.intent.id);
    runtime.provider.corruptNextCaptureEvidence((capture) => ({ ...capture, amountCents: capture.amountCents - 1 }));
    expect(await dispatchCapture(runtime.payment, started.value.intent.id)).toEqual({ ok: true, value: "MANUAL_REVIEW" });
  });
});
