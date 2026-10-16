import { QUANTITY_MAX, UnexpectedRowError, type CheckoutRead, type IssueOutcome } from "@/lib/pg/checkout-service";
import { isCanonicalConfirmationNonce } from "@/lib/pg/confirmation-nonce";
import { serializePgSessionCookie } from "@/lib/pg/session-cookie";
import { toPublicError, type PublicErrorCode } from "@/lib/security/errors";
import { readLimitedForm } from "@/lib/security/limits";
import { PROPOSED_RATE_LIMIT_POLICIES, type RateLimitPolicy } from "@/lib/security/rate-limit";
import { ID_PATTERNS } from "@/lib/shared/ids";
import { authorizePgMutation, hasTrustedProvenance, resolvePgSession, type PgRequestContext } from "./pg-request-guard";
import type { PgServices } from "./pg-runtime";
import { parsePreferences, preferencesQuery } from "./shopping";

/**
 * HTTP handlers of PostgreSQL mode (specification 19.19, Increment 2.3). NEVER RUN AGAINST A DATABASE.
 *
 * Written against the standard Request and Response types, like the mock's handlers, and wholly separate from
 * them. Every state-changing handler goes through `guard` first, apart from the one that starts a new session,
 * which has no session to check and is guarded by provenance alone.
 *
 * What these handlers never do:
 *  - send a checkout call twice. A call whose outcome is not known is reported as not known;
 *  - issue a challenge, rotate a session or admit a session on a GET, with one exception: a request that carries
 *    no session cookie at all is admitted by GET /session/start;
 *  - put anything of a database error, a digest, an owner id or a key version in a response.
 */

const QUOTE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const SESSION_ROTATION_POLICY: RateLimitPolicy = { name: "pg_session_rotation", limit: 10, windowMs: 60_000 };
const REVIEW_POLICY: RateLimitPolicy = { name: "pg_review", limit: 30, windowMs: 60_000 };
const CANCEL_POLICY: RateLimitPolicy = { name: "pg_cancel", limit: 30, windowMs: 60_000 };
const SIMULATION_POLICY: RateLimitPolicy = { name: "pg_simulation", limit: 60, windowMs: 60_000 };

function seeOther(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
}

function refuseAs(code: PublicErrorCode, requestId: string, retryAfterMs?: number): Response {
  const error = toPublicError(code, requestId);
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (retryAfterMs !== undefined) headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  return Response.json(error.body, { status: error.status, headers });
}

function refuse(code: PublicErrorCode, services: PgServices): Response {
  return refuseAs(code, services.ids("event"));
}

/**
 * One line for the server log: a fixed label, the request id the client was given, and either the name of the
 * field of an unexpected row or the five-character SQLSTATE. Never a message, a value, a digest or a credential.
 */
function report(label: string, requestId: string, error: unknown): void {
  let detail = "error";
  if (error instanceof UnexpectedRowError) detail = `row:${error.field}`;
  else if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) detail = `sqlstate:${code}`;
  }
  console.error(`shopaccess: ${label} ${requestId} ${detail}`);
}

/**
 * The refusal for a call that failed without a usable result: an unexpected row is an internal error, anything
 * else (a timeout, a lost connection, a database error) is "not available". Nothing is tried again.
 */
function failed(services: PgServices, label: string, error: unknown): Response {
  const requestId = services.ids("event");
  report(label, requestId, error);
  return refuseAs(error instanceof UnexpectedRowError ? "INTERNAL_ERROR" : "UNAVAILABLE", requestId);
}

type Guarded = { readonly ok: true; readonly context: PgRequestContext; readonly form: URLSearchParams } | { readonly ok: false; readonly response: Response };

/** Body, provenance, session, CSRF, then the in-process limit. The limit is a first line only. */
async function guard(request: Request, services: PgServices, policy: RateLimitPolicy): Promise<Guarded> {
  const form = await readLimitedForm(request);
  if (!form.ok) return { ok: false, response: refuse(form.error === "BODY_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", services) };

  let authorized: Awaited<ReturnType<typeof authorizePgMutation>>;
  try {
    authorized = await authorizePgMutation(request, services, form.value.get("csrfToken"));
  } catch (error) {
    return { ok: false, response: failed(services, "authorize", error) };
  }
  if (!authorized.ok) return { ok: false, response: refuse("FORBIDDEN", services) };

  const limit = await services.limiter.consume(policy, authorized.value.session.id);
  if (!limit.allowed) return { ok: false, response: refuse("RATE_LIMITED", services) };
  return { ok: true, context: authorized.value, form: form.value };
}

function sessionCookieHeader(services: PgServices, issued: { session: PgRequestContext["session"]; issuedCookie: PgRequestContext["cookie"] | null }): Record<string, string> {
  if (!issued.issuedCookie) throw new UnexpectedRowError("issued cookie");
  return { "set-cookie": serializePgSessionCookie(issued.issuedCookie, services.sessions.cookieMaxAgeSeconds(issued.session)) };
}

/**
 * GET /session/start. A request with no session cookie at all is given a new session. A request whose cookie is
 * authorized continues unchanged; nothing is rotated here. A request that carries a cookie the application cannot
 * use (malformed, duplicated, in the mock's format, or refused by the database) is given nothing new and its
 * cookie is left as it is: it is sent to the notice that offers an explicit new session.
 */
export async function handlePgSessionStart(request: Request, services: PgServices): Promise<Response> {
  const url = new URL(request.url);
  const preferences = parsePreferences(url.searchParams.get("use"), url.searchParams.get("budget"));
  // The destination is always a fixed local path; nothing from the request chooses it.
  const destination = preferences ? `/shop?${preferencesQuery(preferences)}&started=1` : "/";

  try {
    const state = await resolvePgSession(request.headers.get("cookie"), services.sessions);
    if (state.context) return seeOther(destination);
    if (state.presence === "PRESENT") return seeOther("/?session=ended");

    const admitted = await services.sessions.establish(null);
    if (!admitted.ok) return refuse(admitted.error === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAVAILABLE", services);
    return seeOther(destination, sessionCookieHeader(services, admitted.value));
  } catch (error) {
    return failed(services, "session-start", error);
  }
}

/**
 * POST /session/new. The explicit way to leave a credential that can no longer be used. Guarded by provenance
 * only: there is no session, so there is no CSRF token. A request whose cookie is in fact authorized is given
 * nothing new. The presented cookie is replaced only by the cookie of a session the database admitted; on any
 * refusal no cookie is sent at all. The earlier session is not ended, and its checkouts do not move.
 */
export async function handlePgSessionNew(request: Request, services: PgServices): Promise<Response> {
  const form = await readLimitedForm(request);
  if (!form.ok) return refuse(form.error === "BODY_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", services);
  if (!hasTrustedProvenance(request, services.trustedOrigins)) return refuse("FORBIDDEN", services);

  try {
    const state = await resolvePgSession(request.headers.get("cookie"), services.sessions);
    if (state.context) return seeOther("/");

    const admitted = await services.sessions.establish(null);
    if (!admitted.ok) return refuse(admitted.error === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAVAILABLE", services);
    return seeOther("/", sessionCookieHeader(services, admitted.value));
  } catch (error) {
    return failed(services, "session-new", error);
  }
}

/**
 * POST /session/rotate. The only place a session is rotated. A session under the ACTIVE key is left alone, with no
 * database call. A session under a VERIFY_ONLY key is rotated to the ACTIVE key: the same session and owner, a new
 * cookie, and a new CSRF token, so a form rendered before the rotation is refused until it is loaded again.
 */
export async function handlePgSessionRotate(request: Request, services: PgServices): Promise<Response> {
  const guarded = await guard(request, services, SESSION_ROTATION_POLICY);
  if (!guarded.ok) return guarded.response;
  const { session, cookie } = guarded.context;
  if (session.keyStatus === "ACTIVE") return seeOther("/");

  try {
    const rotated = await services.sessions.rotate(session, cookie);
    if (!rotated.ok) return refuse(rotated.error === "NOT_AUTHORIZED" ? "FORBIDDEN" : "UNAVAILABLE", services);
    return seeOther("/", sessionCookieHeader(services, rotated.value));
  } catch (error) {
    return failed(services, "session-rotate", error);
  }
}

/** Where a request for a challenge leads, once the checkout is known. Used by Review again. */
function afterIssue(services: PgServices, intentId: string, issued: IssueOutcome): Response {
  const page = `/checkout/${intentId}`;
  if (issued.outcome === "READY") return seeOther(page);
  if (issued.outcome === "NOT_READY") return seeOther(`${page}?error=REVIEW_NOT_READY`);
  switch (issued.result) {
    case "RATE_LIMITED":
      return refuse("RATE_LIMITED", services);
    case "NOT_AUTHORIZED":
      return refuse("FORBIDDEN", services);
    case "REQUEST_INVALID":
      return refuse("BAD_REQUEST", services);
    case "CHALLENGE_LIMIT_REACHED":
      return seeOther(`${page}?error=CHALLENGE_LIMIT_REACHED`);
    case "QUOTE_EXPIRED":
      return seeOther(`${page}?error=QUOTE_EXPIRED`);
    case "QUOTE_STALE_CATALOG":
      return seeOther(`${page}?error=QUOTE_STALE_CATALOG`);
    case "QUOTE_DIGEST_MISMATCH":
      return seeOther(`${page}?error=CONFIRMATION_UNAVAILABLE`);
    // The page shows the checkout as it is.
    case "CONFIRMATION_ALREADY_USED":
    case "INTENT_NOT_AWAITING_CONFIRMATION":
      return seeOther(page);
  }
}

/**
 * POST /checkout/start. Starts a checkout, or replaces one, and then asks once for its first challenge.
 *
 * start_checkout, read_checkout and issue_challenge are three separate calls, each committed by itself.
 *  - If the start call fails without a usable result, whether the checkout exists is not known. Nothing is sent
 *    again; the shopper is sent to the list of checkouts with a notice that says so.
 *  - Once the start call has answered STARTED the checkout is known. Whatever fails after that leads to that
 *    checkout's page, which offers Review again. The start call is never repeated to recover a challenge.
 */
export async function handlePgCheckoutStart(request: Request, services: PgServices): Promise<Response> {
  const guarded = await guard(request, services, PROPOSED_RATE_LIMIT_POLICIES.quoteRequest);
  if (!guarded.ok) return guarded.response;
  const { context, form } = guarded;
  const { credential } = context;

  // Only these four fields are read. Any price or total in the form is never looked at.
  const productId = form.get("productId");
  const variantId = form.get("variantId");
  const quantity = Number(form.get("quantity"));
  const replaces = form.get("replaces");
  // The quantity of start_checkout is 1 to 10. Anything else is refused here, before any checkout call.
  if (productId === null || variantId === null || !Number.isInteger(quantity) || quantity < 1 || quantity > QUANTITY_MAX) return refuse("BAD_REQUEST", services);
  if (replaces !== null && !ID_PATTERNS.checkoutIntent.test(replaces)) return refuse("BAD_REQUEST", services);

  const preferences = parsePreferences(form.get("use"), form.get("budget"));
  let back = preferences ? `/shop?${preferencesQuery(preferences)}&error=` : "/shop?error=";

  if (replaces !== null) {
    // A replacement names a checkout of this owner that is still QUOTED or USER_CONFIRMED. A canceled or
    // superseded checkout is never sent as a predecessor. The database decides again under its own locks.
    let predecessor: CheckoutRead;
    try {
      const read = await services.checkout.read(credential, replaces);
      if (!read.authorized) return refuse("FORBIDDEN", services);
      predecessor = read.checkout;
    } catch (error) {
      return failed(services, "start-predecessor-read", error);
    }
    back = `/checkout/${replaces}?error=`;
    if (predecessor.storedState !== "QUOTED" && predecessor.storedState !== "USER_CONFIRMED") return seeOther(`${back}REPLACEMENT_NOT_ALLOWED`);
  }

  let started: Awaited<ReturnType<PgServices["checkout"]["start"]>>;
  try {
    started = await services.checkout.start(credential, { productId, variantId, quantity, replacesIntentId: replaces });
  } catch (error) {
    // Not known whether the checkout was created. Sent once; not sent again.
    report("start-uncertain", services.ids("event"), error);
    return seeOther("/checkouts?notice=START_UNCERTAIN");
  }

  switch (started.result) {
    case "STARTED":
      break;
    case "NOT_AUTHORIZED":
      return refuse("FORBIDDEN", services);
    case "REQUEST_INVALID":
      return refuse("BAD_REQUEST", services);
    case "RATE_LIMITED":
      return refuse("RATE_LIMITED", services);
    default:
      return seeOther(`${back}${started.result}`);
  }

  // The checkout exists. From here every failure leads to its page.
  const page = `/checkout/${started.intentId}`;
  try {
    const read = await services.checkout.read(credential, started.intentId);
    if (!read.authorized) return seeOther(`${page}?error=REVIEW_NOT_READY`);
    // The trusted context of the request for a challenge is the authorized read just made, never the form.
    const issued = await services.checkout.issue(credential, { intentId: started.intentId, checkout: read.checkout });
    return seeOther(issued.outcome === "READY" ? page : `${page}?error=REVIEW_NOT_READY`);
  } catch (error) {
    report("start-review", services.ids("event"), error);
    return seeOther(`${page}?error=REVIEW_NOT_READY`);
  }
}

/**
 * POST /checkout/:intentId/review ("Review again"). Asks once for a challenge of the checkout in the URL: the
 * database reuses the ACTIVE one or issues a new one by its own policy. The page itself never does this.
 */
export async function handlePgReview(request: Request, services: PgServices, intentId: string): Promise<Response> {
  const guarded = await guard(request, services, REVIEW_POLICY);
  if (!guarded.ok) return guarded.response;
  const { credential } = guarded.context;
  if (!ID_PATTERNS.checkoutIntent.test(intentId)) return refuse("NOT_FOUND", services);

  let checkout: CheckoutRead;
  try {
    const read = await services.checkout.read(credential, intentId);
    if (!read.authorized) return refuse("NOT_FOUND", services);
    checkout = read.checkout;
  } catch (error) {
    return failed(services, "review-read", error);
  }

  try {
    const issued = await services.checkout.issue(credential, { intentId, checkout });
    return afterIssue(services, intentId, issued);
  } catch (error) {
    report("review-issue", services.ids("event"), error);
    return seeOther(`/checkout/${intentId}?error=REVIEW_NOT_READY`);
  }
}

/**
 * POST /checkout/:intentId/confirm.
 *
 * The confirmation is bound to the checkout in the URL before anything is consumed: the authorized read of that
 * checkout must show the submitted challenge as the ACTIVE challenge of its quote. Only then is consume_challenge
 * called, with that challenge id and the submitted nonce, quote id and quote digest as they were sent, so that the
 * database decides every mismatch, counts the call and writes its own rejection audit row.
 *
 * In every other case no consume call is made and the answer is one of this application's own outcomes
 * (FORM_OUT_OF_DATE, ALREADY_CONFIRMED, CHECKOUT_NOT_CONFIRMABLE). They describe what the read showed at that
 * moment; none is a result of consume_challenge, and none is counted or audited by the database.
 */
export async function handlePgConfirm(request: Request, services: PgServices, intentId: string): Promise<Response> {
  const guarded = await guard(request, services, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { context, form } = guarded;
  const { credential } = context;
  if (!ID_PATTERNS.checkoutIntent.test(intentId)) return refuse("NOT_FOUND", services);

  // Shapes first. A malformed field is refused before any checkout call.
  const challengeId = form.get("confirmationId");
  const nonce = form.get("nonce");
  const quoteId = form.get("quoteId");
  const quoteDigest = form.get("quoteDigest");
  if (
    challengeId === null ||
    !ID_PATTERNS.confirmation.test(challengeId) ||
    nonce === null ||
    !isCanonicalConfirmationNonce(nonce) ||
    quoteId === null ||
    !ID_PATTERNS.quote.test(quoteId) ||
    quoteDigest === null ||
    !QUOTE_DIGEST_PATTERN.test(quoteDigest)
  ) {
    return refuse("BAD_REQUEST", services);
  }

  let checkout: CheckoutRead;
  try {
    const read = await services.checkout.read(credential, intentId);
    // A checkout of another owner is indistinguishable from one that does not exist.
    if (!read.authorized) return refuse("NOT_FOUND", services);
    checkout = read.checkout;
  } catch (error) {
    return failed(services, "confirm-read", error);
  }

  const page = `/checkout/${intentId}`;
  if (form.get("acknowledged") !== "yes") return seeOther(`${page}?error=ACKNOWLEDGEMENT_REQUIRED`);

  if (!checkout.challenge || checkout.challenge.id !== challengeId) {
    // Local outcomes: no consume call.
    if (checkout.challenge) return seeOther(`${page}?error=FORM_OUT_OF_DATE`);
    if (checkout.storedState === "QUOTED") return seeOther(`${page}?error=FORM_OUT_OF_DATE`);
    if (checkout.storedState === "USER_CONFIRMED") return seeOther(`${page}?notice=ALREADY_CONFIRMED`);
    return seeOther(`${page}?error=CHECKOUT_NOT_CONFIRMABLE`);
  }

  let consumed: Awaited<ReturnType<PgServices["checkout"]["consume"]>>;
  try {
    consumed = await services.checkout.consume(credential, { challengeId: checkout.challenge.id, nonce, quoteId, quoteDigest });
  } catch (error) {
    // Sent once. The page shows the checkout as it is when it is next loaded.
    return failed(services, "confirm-consume", error);
  }

  switch (consumed.result) {
    case "CONFIRMED": {
      // Defensive: the confirmation is of the checkout in the URL. If the database names another, it has already
      // committed there; nothing is redirected and the next page load shows the true state.
      if (consumed.intentId !== intentId) {
        const requestId = services.ids("event");
        report("confirm-intent-differs", requestId, null);
        return refuseAs("INTERNAL_ERROR", requestId);
      }
      return seeOther(`${page}?notice=CONFIRMED`);
    }
    case "NOT_AUTHORIZED":
      return refuse("FORBIDDEN", services);
    case "REQUEST_INVALID":
      return refuse("BAD_REQUEST", services);
    case "RATE_LIMITED":
      return refuse("RATE_LIMITED", services);
    case "QUOTE_DIGEST_MISMATCH":
    case "CONFIRMATION_KEY_REVOKED":
      return seeOther(`${page}?error=CONFIRMATION_UNAVAILABLE`);
    case "INTENT_NOT_AWAITING_CONFIRMATION":
      return seeOther(`${page}?error=NOT_AWAITING_CONFIRMATION`);
    // The database's own result, shown as it reported it. The first three can follow only from a change between
    // the read above and the call.
    case "CONFIRMATION_SUPERSEDED":
    case "CONFIRMATION_ALREADY_USED":
    case "CONFIRMATION_NOT_FOUND":
    case "CONFIRMATION_MISMATCH":
    case "CONFIRMATION_EXPIRED":
    case "QUOTE_EXPIRED":
    case "QUOTE_STALE_CATALOG":
      return seeOther(`${page}?error=${consumed.result}`);
  }
}

/** POST /checkout/:intentId/cancel. One cancel_checkout call; the database decides whether it can be canceled. */
export async function handlePgCancel(request: Request, services: PgServices, intentId: string): Promise<Response> {
  const guarded = await guard(request, services, CANCEL_POLICY);
  if (!guarded.ok) return guarded.response;
  if (!ID_PATTERNS.checkoutIntent.test(intentId)) return refuse("NOT_FOUND", services);

  let result: Awaited<ReturnType<PgServices["checkout"]["cancel"]>>;
  try {
    result = await services.checkout.cancel(guarded.context.credential, intentId);
  } catch (error) {
    return failed(services, "cancel", error);
  }
  const page = `/checkout/${intentId}`;
  switch (result) {
    case "CANCELED":
      return seeOther(`${page}?notice=CANCELED`);
    case "NOT_CANCELABLE":
      return seeOther(`${page}?error=NOT_CANCELABLE`);
    case "NOT_AUTHORIZED":
      return refuse("NOT_FOUND", services);
    case "RATE_LIMITED":
      return refuse("RATE_LIMITED", services);
    case "REQUEST_INVALID":
      return refuse("BAD_REQUEST", services);
  }
}

/**
 * POST /checkout/:intentId/simulate. The simulated payment lifecycle belongs to the mock alone: PostgreSQL mode
 * has no payment table, state or function. After the guard the answer is always "not found".
 */
export async function handlePgSimulate(request: Request, services: PgServices): Promise<Response> {
  const guarded = await guard(request, services, SIMULATION_POLICY);
  if (!guarded.ok) return guarded.response;
  return refuse("NOT_FOUND", services);
}
