import { describe, expect, it } from "vitest";
import { requestQuote } from "@/lib/checkout/service";
import { confirmPurchaseSummary, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { cancelCheckout } from "@/lib/payment/orchestrator";
import { readSessionCookie, serializeSessionCookie, SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { authorizeMutation, checkRequestProvenance, CSRF_HEADER_NAME, parseTrustedOrigins } from "@/lib/session/request-guard";
import { digestSessionToken, generateSessionToken, parseSessionKey, SESSION_TOKEN_PATTERN } from "@/lib/session/token";
import { createWorld, HOUR, MINUTE, newSession, quotedIntent, SAMPLE_REQUEST, TEST_SESSION_KEY } from "./helpers";

const ORIGIN = "https://shop.example.test";
const trustedOrigins = parseTrustedOrigins([ORIGIN]);

function mutation(headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/checkout/quote`, { method: "POST", headers });
}

describe("anonymous sessions", () => {
  it("generates opaque 256-bit tokens and stores only a keyed digest", async () => {
    const world = createWorld();
    const { token, session } = await newSession(world);
    expect(token).toMatch(SESSION_TOKEN_PATTERN);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const record = await world.sessionStore.findByTokenDigest(digestSessionToken(TEST_SESSION_KEY, token));
    expect(record?.id).toBe(session.id);
    expect(JSON.stringify(record)).not.toContain(token);
    expect(session.id).not.toContain(token);
  });

  it("serializes a __Host- cookie with HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain", () => {
    const cookie = serializeSessionCookie(generateSessionToken(), 3600);
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=3600"]) expect(cookie).toContain(attribute);
    expect(cookie.toLowerCase()).not.toContain("domain");
  });

  it("SES-01: rejects session fixation - an unknown client-supplied token is never adopted", async () => {
    const world = createWorld();
    const attackerChosen = generateSessionToken();

    expect(await world.sessions.resolve(attackerChosen)).toEqual({ ok: false, error: "SESSION_UNKNOWN" });
    expect(await world.sessions.resolve("attacker-chosen-id")).toEqual({ ok: false, error: "TOKEN_MALFORMED" });

    const established = await world.sessions.establish(attackerChosen);
    if (!established.ok) throw new Error("setup");
    const issued = established.value;
    expect(issued.issuedToken).not.toBeNull();
    expect(issued.issuedToken).not.toBe(attackerChosen);
    // The attacker's value still does not identify any session afterwards.
    expect((await world.sessions.resolve(attackerChosen)).ok).toBe(false);
    expect((await world.sessions.resolve(issued.issuedToken)).ok).toBe(true);
  });

  it("ignores ambiguous or malformed cookie headers", () => {
    const token = generateSessionToken();
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=${token}`)).toBe(token);
    expect(readSessionCookie(`a=b; ${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_NAME}=${generateSessionToken()}`)).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=short`)).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });

  it("enforces the 2 hour idle timeout and the 24 hour absolute lifetime", async () => {
    const idle = createWorld();
    const first = await newSession(idle);
    idle.time.advance(2 * HOUR - MINUTE);
    expect((await idle.sessions.resolve(first.token)).ok).toBe(true);
    idle.time.advance(2 * HOUR);
    expect(await idle.sessions.resolve(first.token)).toEqual({ ok: false, error: "SESSION_IDLE_EXPIRED" });

    const absolute = createWorld();
    const second = await newSession(absolute);
    for (let hour = 0; hour < 23; hour += 1) {
      absolute.time.advance(HOUR);
      expect((await absolute.sessions.resolve(second.token)).ok).toBe(true);
    }
    absolute.time.advance(HOUR);
    expect(await absolute.sessions.resolve(second.token)).toEqual({ ok: false, error: "SESSION_ABSOLUTE_EXPIRED" });
  });

  it("supports revocation and rotation; a rotated-out token and its CSRF token stop working", async () => {
    const world = createWorld();
    const { token, session } = await newSession(world);
    const rotated = await world.sessions.rotate(token);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.value.session.id).toBe(session.id);
    expect(rotated.value.session.absoluteExpiresAt).toEqual(session.absoluteExpiresAt);
    expect(await world.sessions.resolve(token)).toEqual({ ok: false, error: "SESSION_UNKNOWN" });
    expect(world.sessions.verifyCsrfToken(rotated.value.session, session.csrfToken)).toBe(false);

    await world.sessions.revoke(session.id);
    expect(await world.sessions.resolve(rotated.value.issuedToken)).toEqual({ ok: false, error: "SESSION_REVOKED" });
  });

  it("fails closed when the digest key is missing or too short", () => {
    expect(parseSessionKey(undefined)).toEqual({ ok: false, error: "KEY_MISSING" });
    expect(parseSessionKey(Buffer.alloc(16).toString("base64"))).toEqual({ ok: false, error: "KEY_TOO_SHORT" });
    expect(parseSessionKey(Buffer.alloc(32, 1).toString("base64")).ok).toBe(true);
  });

  it("SES-02: prevents cross-session access to intents, quotes, confirmations and cancellation", async () => {
    const world = createWorld();
    const alice = await newSession(world);
    const mallory = await newSession(world);
    const { intentId, quote } = await quotedIntent(world, alice.session.id);
    const challenge = await prepareConfirmation(world.checkout, alice.session.id, quote.quoteId);
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;
    const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;

    expect(await world.store.findIntentForSession(mallory.session.id, intentId)).toBeNull();
    expect(await world.store.findQuoteForSession(mallory.session.id, quote.quoteId)).toBeNull();
    expect(await world.store.findConfirmationForSession(mallory.session.id, confirmationId)).toBeNull();

    expect(await requestQuote(world.checkout, mallory.session.id, intentId, SAMPLE_REQUEST)).toEqual({ ok: false, error: "INTENT_NOT_FOUND" });
    expect(await prepareConfirmation(world.checkout, mallory.session.id, quote.quoteId)).toEqual({ ok: false, error: "QUOTE_NOT_FOUND" });
    // Even with every secret value leaked, another session cannot confirm.
    expect(await confirmPurchaseSummary(world.checkout, mallory.session.id, { confirmationId, nonce, quoteId, quoteDigest })).toEqual({
      ok: false,
      error: "CONFIRMATION_NOT_FOUND",
    });
    expect(await cancelCheckout(world.checkout, mallory.session.id, intentId)).toEqual({ ok: false, error: "INTENT_NOT_FOUND" });

    // The owner is unaffected.
    expect((await confirmPurchaseSummary(world.checkout, alice.session.id, { confirmationId, nonce, quoteId, quoteDigest })).ok).toBe(true);
  });
});

describe("CSRF-01: unauthorized cross-origin mutations are rejected", () => {
  it("accepts a same-origin mutation with a valid session and session-bound CSRF token", async () => {
    const world = createWorld();
    const { token, session } = await newSession(world);
    const result = await authorizeMutation(
      mutation({ origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${token}`, [CSRF_HEADER_NAME]: session.csrfToken }),
      { sessions: world.sessions, trustedOrigins },
    );
    expect(result.ok && result.value.id).toBe(session.id);
  });

  it("rejects untrusted, missing or opaque origins and non-same-origin Fetch Metadata", async () => {
    const world = createWorld();
    const { token, session } = await newSession(world);
    const valid = { cookie: `${SESSION_COOKIE_NAME}=${token}`, [CSRF_HEADER_NAME]: session.csrfToken };
    const deps = { sessions: world.sessions, trustedOrigins };

    const cases: [Record<string, string>, string][] = [
      [{ ...valid, origin: "https://evil.example" }, "ORIGIN_UNTRUSTED"],
      [{ ...valid, origin: "null" }, "ORIGIN_UNTRUSTED"],
      [{ ...valid, origin: "http://shop.example.test" }, "ORIGIN_UNTRUSTED"],
      [{ ...valid, origin: `${ORIGIN}.evil.example` }, "ORIGIN_UNTRUSTED"],
      [{ ...valid }, "ORIGIN_MISSING"],
      [{ ...valid, referer: "https://evil.example/page" }, "ORIGIN_UNTRUSTED"],
      [{ ...valid, origin: ORIGIN, "sec-fetch-site": "cross-site" }, "FETCH_SITE_REJECTED"],
      [{ ...valid, origin: ORIGIN, "sec-fetch-site": "same-site" }, "FETCH_SITE_REJECTED"],
      [{ ...valid, origin: ORIGIN, "sec-fetch-site": "none" }, "FETCH_SITE_REJECTED"],
    ];
    for (const [headers, reason] of cases) {
      expect(await authorizeMutation(mutation(headers), deps), JSON.stringify(headers)).toEqual({ ok: false, error: reason });
    }
  });

  it("rejects a missing, wrong or other-session CSRF token and a missing session", async () => {
    const world = createWorld();
    const alice = await newSession(world);
    const mallory = await newSession(world);
    const deps = { sessions: world.sessions, trustedOrigins };
    const base = { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${alice.token}` };

    expect(await authorizeMutation(mutation(base), deps)).toEqual({ ok: false, error: "CSRF_TOKEN_INVALID" });
    expect(await authorizeMutation(mutation({ ...base, [CSRF_HEADER_NAME]: "0".repeat(64) }), deps)).toEqual({ ok: false, error: "CSRF_TOKEN_INVALID" });
    expect(await authorizeMutation(mutation({ ...base, [CSRF_HEADER_NAME]: mallory.session.csrfToken }), deps)).toEqual({
      ok: false,
      error: "CSRF_TOKEN_INVALID",
    });
    expect(await authorizeMutation(mutation({ origin: ORIGIN, [CSRF_HEADER_NAME]: alice.session.csrfToken }), deps)).toEqual({
      ok: false,
      error: "TOKEN_MISSING",
    });
  });

  it("falls back to Referer only when Origin is absent, and requires https trusted origins", () => {
    expect(checkRequestProvenance(new Headers({ referer: `${ORIGIN}/cart` }), trustedOrigins).ok).toBe(true);
    expect(() => parseTrustedOrigins(["http://localhost:3000"])).toThrow();
    expect(() => parseTrustedOrigins([`${ORIGIN}/path`])).toThrow();
    expect(() => parseTrustedOrigins([])).toThrow();
  });
});
