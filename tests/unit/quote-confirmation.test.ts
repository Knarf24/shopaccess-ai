import { describe, expect, it } from "vitest";
import { requestQuote, startCheckout } from "@/lib/checkout/service";
import { confirmPurchaseSummary, CONFIRMATION_TTL_MS, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { computeQuoteDigest, createQuote, QUOTE_TTL_MS, QuoteSchema, SANDBOX_ASSUMPTIONS, verifyQuote } from "@/lib/quote/quote";
import { createSequentialIdGenerator } from "@/lib/shared/ids";
import { createWorld, MINUTE, newSession, quotedIntent, SAMPLE_REQUEST, stateOf } from "./helpers";

async function challengeFor(world: ReturnType<typeof createWorld>, sessionId: string) {
  const { intentId, quote } = await quotedIntent(world, sessionId);
  const challenge = await prepareConfirmation(world.checkout, sessionId, quote.quoteId);
  if (!challenge.ok) throw new Error(`prepare failed: ${challenge.error}`);
  const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
  return { intentId, quote, challenge: challenge.value, submission: { confirmationId, nonce, quoteId, quoteDigest } };
}

describe("immutable quotes", () => {
  it("contains every required field, built from server catalog data", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, quote } = await quotedIntent(world, session.id, { ...SAMPLE_REQUEST, quantity: 2 });

    expect(quote).toMatchObject({
      sessionId: session.id,
      checkoutIntentId: intentId,
      merchantId: "dmm_shopaccessdemo",
      productId: "dmp_codebook15",
      variantId: "dmv_codebook15a",
      catalogRevision: 1,
      quantity: 2,
      unitAmountCents: 79900,
      subtotalCents: 159800,
      discountCents: 0,
      taxCents: 0,
      shippingCents: 0,
      totalCents: 159800,
      currency: "USD",
      assumptions: SANDBOX_ASSUMPTIONS,
    });
    expect(Date.parse(quote.expiresAt) - Date.parse(quote.createdAt)).toBe(15 * MINUTE);
    expect(quote.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(await stateOf(world, intentId)).toBe("QUOTED");
    // Stored quotes cannot be replaced.
    await expect(world.store.insertQuote(quote)).rejects.toThrow();
  });

  it("QTE-01: rejects client monetary overrides", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const intent = await startCheckout(world.checkout, session.id);
    const overrides = [
      { unitAmountCents: 1 },
      { totalCents: 1 },
      { subtotalCents: 1 },
      { discountCents: 79800 },
      { taxCents: -1 },
      { shippingCents: 0 },
      { currency: "EUR" },
      { merchantId: "dmm_attacker01" },
      { price: "0.01" },
      { catalogRevision: 99 },
      { expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
    for (const override of overrides) {
      const result = await requestQuote(world.checkout, session.id, intent.id, { ...SAMPLE_REQUEST, ...override });
      expect(result, JSON.stringify(override)).toEqual({ ok: false, error: "REQUEST_INVALID" });
    }
    expect(await stateOf(world, intent.id)).toBe("DRAFT");

    // The same request without overrides is priced by the server alone.
    const clean = await requestQuote(world.checkout, session.id, intent.id, SAMPLE_REQUEST);
    expect(clean.ok && clean.value.totalCents).toBe(79900);
  });

  it("rejects invalid quantities, unavailable variants and quantities above the per-order maximum", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const intent = await startCheckout(world.checkout, session.id);
    const ask = (request: unknown) => requestQuote(world.checkout, session.id, intent.id, request);

    for (const quantity of [0, -1, 1.5, "2", 11, Number.NaN, 1e21]) {
      expect(await ask({ ...SAMPLE_REQUEST, quantity }), String(quantity)).toEqual({ ok: false, error: "REQUEST_INVALID" });
    }
    expect(await ask({ ...SAMPLE_REQUEST, quantity: 3 })).toEqual({ ok: false, error: "QUANTITY_EXCEEDS_LIMIT" });
    expect(await ask({ productId: "dmp_campusbook16", variantId: "dmv_campusbook16a", quantity: 1 })).toEqual({ ok: false, error: "VARIANT_UNAVAILABLE" });
    expect(await ask(null)).toEqual({ ok: false, error: "REQUEST_INVALID" });
  });

  it("QTE-02: verifies exact integer arithmetic", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    world.catalog.products[1].variants[0].unitAmountCents = 33333;
    const { quote } = await quotedIntent(world, session.id, { ...SAMPLE_REQUEST, quantity: 2 });
    expect(quote.subtotalCents).toBe(66666);
    expect(quote.totalCents).toBe(66666);
    for (const amount of [quote.unitAmountCents, quote.subtotalCents, quote.totalCents]) expect(Number.isInteger(amount)).toBe(true);

    const context = { sessionId: session.id, catalog: world.catalog, now: world.time.clock() };
    const redigest = (changes: Record<string, unknown>) => {
      const body = { ...quote, ...changes } as Record<string, unknown>;
      delete body.digest;
      return { ...body, digest: computeQuoteDigest(body as never) };
    };

    // Tampering without recomputing the digest is caught by the digest.
    expect(verifyQuote({ ...quote, totalCents: 1 }, context)).toEqual({ ok: false, error: "QUOTE_MALFORMED" });
    expect(verifyQuote({ ...quote, quantity: 1 }, context)).toEqual({ ok: false, error: "QUOTE_MALFORMED" });
    expect(verifyQuote({ ...quote, quoteId: "qt_" + "f".repeat(32) }, context)).toEqual({ ok: false, error: "QUOTE_DIGEST_MISMATCH" });

    // Even with a valid digest, inconsistent or unsupported amounts are rejected.
    const invalid = [
      { totalCents: 66665 },
      { subtotalCents: 66667, totalCents: 66667 },
      { unitAmountCents: 33333.5, subtotalCents: 66667, totalCents: 66667 },
      { totalCents: -66666 },
      { discountCents: 1, totalCents: 66665 },
      { taxCents: 100, totalCents: 66766 },
      { currency: "EUR" },
      { expiresAt: new Date(Date.parse(quote.createdAt) + 60 * MINUTE).toISOString() },
    ];
    for (const changes of invalid) {
      expect(QuoteSchema.safeParse(redigest(changes)).success, JSON.stringify(changes)).toBe(false);
      expect(verifyQuote(redigest(changes), context), JSON.stringify(changes)).toEqual({ ok: false, error: "QUOTE_MALFORMED" });
    }
    expect(verifyQuote(quote, context).ok).toBe(true);
  });

  it("rejects amounts that would exceed safe integer range rather than rounding", () => {
    const world = createWorld();
    world.catalog.products[1].variants[0].unitAmountCents = Number.MAX_SAFE_INTEGER;
    world.catalog.products[1].variants[0].maxQuantityPerOrder = 2;
    const result = createQuote({
      sessionId: "ses_" + "0".repeat(32),
      checkoutIntentId: "ci_" + "0".repeat(32),
      request: { ...SAMPLE_REQUEST, quantity: 2 },
      catalog: world.catalog,
      now: world.time.clock(),
      ids: createSequentialIdGenerator(),
    });
    expect(result).toEqual({ ok: false, error: "AMOUNT_OUT_OF_RANGE" });
  });

  it("expires after 15 minutes and is bound to its session", async () => {
    const world = createWorld();
    const alice = await newSession(world);
    const mallory = await newSession(world);
    const { quote } = await quotedIntent(world, alice.session.id);
    const at = (ms: number) => ({ sessionId: alice.session.id, catalog: world.catalog, now: new Date(Date.parse(quote.createdAt) + ms) });

    expect(verifyQuote(quote, at(QUOTE_TTL_MS - 1)).ok).toBe(true);
    expect(verifyQuote(quote, at(QUOTE_TTL_MS))).toEqual({ ok: false, error: "QUOTE_EXPIRED" });
    expect(verifyQuote(quote, { ...at(0), sessionId: mallory.session.id })).toEqual({ ok: false, error: "QUOTE_NOT_OWNED" });
  });

  it("a material change produces a new quote that needs a new confirmation", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const first = await challengeFor(world, session.id);
    const second = await requestQuote(world.checkout, session.id, first.intentId, { ...SAMPLE_REQUEST, quantity: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.quoteId).not.toBe(first.quote.quoteId);
    expect(second.value.digest).not.toBe(first.quote.digest);
    // The confirmation prepared for the old quote no longer applies.
    expect(await confirmPurchaseSummary(world.checkout, session.id, first.submission)).toEqual({
      ok: false,
      error: "INTENT_NOT_AWAITING_CONFIRMATION",
    });
    expect(await stateOf(world, first.intentId)).toBe("QUOTED");
  });
});

describe("explicit confirmation", () => {
  it("binds session, intent, quote digest, displayed summary, nonce and expiry", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, quote, challenge } = await challengeFor(world, session.id);
    const record = await world.store.findConfirmationForSession(session.id, challenge.confirmationId);

    expect(record).toMatchObject({
      sessionId: session.id,
      checkoutIntentId: intentId,
      quoteId: quote.quoteId,
      quoteDigest: quote.digest,
      consumedAt: null,
      summary: {
        merchantName: "ShopAccess Demo Store (simulated)",
        productTitle: "CodeBook 15",
        variantLabel: "16 GB memory, 512 GB SSD",
        quantity: 1,
        currency: "USD",
        totalCents: 79900,
      },
    });
    expect(Date.parse(record!.expiresAt) - Date.parse(record!.issuedAt)).toBe(CONFIRMATION_TTL_MS);
    expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only a digest of the nonce is stored.
    expect(JSON.stringify(record)).not.toContain(challenge.nonce);

    const other = await challengeFor(world, session.id);
    expect(other.challenge.nonce).not.toBe(challenge.nonce);
  });

  it("rejects wrong nonces, digests and malformed submissions without consuming the confirmation", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, submission } = await challengeFor(world, session.id);
    const attempt = (changes: Record<string, unknown>) => confirmPurchaseSummary(world.checkout, session.id, { ...submission, ...changes });

    expect(await attempt({ nonce: "A".repeat(43) })).toEqual({ ok: false, error: "CONFIRMATION_MISMATCH" });
    expect(await attempt({ quoteDigest: "0".repeat(64) })).toEqual({ ok: false, error: "CONFIRMATION_MISMATCH" });
    expect(await attempt({ quoteId: "qt_" + "0".repeat(32) })).toEqual({ ok: false, error: "CONFIRMATION_NOT_FOUND" });
    expect(await attempt({ totalCents: 1 })).toEqual({ ok: false, error: "SUBMISSION_INVALID" });
    expect(await attempt({ nonce: undefined })).toEqual({ ok: false, error: "SUBMISSION_INVALID" });
    expect(await stateOf(world, intentId)).toBe("QUOTED");

    expect((await attempt({})).ok).toBe(true);
    expect(await stateOf(world, intentId)).toBe("USER_CONFIRMED");
  });

  it("CNF-01: rejects an expired confirmation", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, submission } = await challengeFor(world, session.id);
    world.time.advance(CONFIRMATION_TTL_MS);
    expect(await confirmPurchaseSummary(world.checkout, session.id, submission)).toEqual({ ok: false, error: "CONFIRMATION_EXPIRED" });
    expect(await stateOf(world, intentId)).toBe("QUOTED");

    // A confirmation never outlives its quote.
    const late = createWorld();
    const owner = await newSession(late);
    const { quote } = await quotedIntent(late, owner.session.id);
    late.time.advance(QUOTE_TTL_MS - MINUTE);
    const challenge = await prepareConfirmation(late.checkout, owner.session.id, quote.quoteId);
    expect(challenge.ok && challenge.value.expiresAt).toBe(quote.expiresAt);
    late.time.advance(MINUTE);
    expect(await prepareConfirmation(late.checkout, owner.session.id, quote.quoteId)).toEqual({ ok: false, error: "QUOTE_EXPIRED" });
  });

  it("CNF-02: prevents confirmation replay", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, submission } = await challengeFor(world, session.id);

    expect((await confirmPurchaseSummary(world.checkout, session.id, submission)).ok).toBe(true);
    const intentsBefore = world.store.intentCount();
    const versionBefore = (await world.store.findIntent(intentId))!.snapshot.version;

    for (let replay = 0; replay < 3; replay += 1) {
      expect(await confirmPurchaseSummary(world.checkout, session.id, submission)).toEqual({ ok: false, error: "CONFIRMATION_ALREADY_USED" });
    }
    expect(world.store.intentCount()).toBe(intentsBefore);
    expect((await world.store.findIntent(intentId))!.snapshot.version).toBe(versionBefore);
    expect((await world.store.listTransitions(intentId)).filter((record) => record.eventType === "SHOPPER_CONFIRMED")).toHaveLength(1);
    expect(await world.ledger.listForIntent(intentId, "ORDER_CREATE")).toHaveLength(0);
    expect(world.provider.calls).toEqual([]);
  });

  it("CNF-02: of several concurrent submissions exactly one succeeds", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { intentId, submission } = await challengeFor(world, session.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => confirmPurchaseSummary(world.checkout, session.id, submission)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await world.store.listTransitions(intentId)).filter((record) => record.eventType === "SHOPPER_CONFIRMED")).toHaveLength(1);
  });

  it("confirming never contacts the payment provider", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { submission } = await challengeFor(world, session.id);
    await confirmPurchaseSummary(world.checkout, session.id, submission);
    expect(world.provider.calls).toEqual([]);
    expect(world.provider.orderCount()).toBe(0);
  });
});
