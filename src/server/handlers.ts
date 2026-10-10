import { startCheckoutWithQuote } from "@/lib/checkout/service";
import { confirmPurchaseSummary } from "@/lib/confirmation/confirmation";
import {
  cancelCheckout,
  dispatchCapture,
  dispatchOrderCreate,
  observeCaptureAftermath,
  reconcileOperation,
  recordBuyerReturn,
  verifyApproval,
} from "@/lib/payment/orchestrator";
import { toPublicError, type PublicErrorCode } from "@/lib/security/errors";
import { readLimitedForm } from "@/lib/security/limits";
import { PROPOSED_RATE_LIMIT_POLICIES, type RateLimitPolicy } from "@/lib/security/rate-limit";
import { readSessionCookie, serializeSessionCookie } from "@/lib/session/cookie";
import { authorizeMutation } from "@/lib/session/request-guard";
import type { Session } from "@/lib/session/service";
import { ID_PATTERNS } from "@/lib/shared/ids";
import type { Runtime } from "./runtime";
import { parsePreferences, preferencesQuery } from "./shopping";
import { availableSteps, SIMULATION_STEPS, type SimulationStep } from "./simulation";

/**
 * HTTP handlers for the mock demonstration, written against the standard
 * Request/Response types so they can be tested without a server. Every
 * state-changing handler goes through `guardMutation` first.
 */
const SIMULATION_POLICY: RateLimitPolicy = { name: "simulation_step", limit: 60, windowMs: 60_000 };

function seeOther(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
}

function refuse(code: PublicErrorCode, runtime: Runtime, retryAfterMs?: number): Response {
  const error = toPublicError(code, runtime.ids("event"));
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (retryAfterMs !== undefined) headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  return Response.json(error.body, { status: error.status, headers });
}

async function guardMutation(
  request: Request,
  runtime: Runtime,
  policy: RateLimitPolicy,
): Promise<{ ok: true; session: Session; form: URLSearchParams } | { ok: false; response: Response }> {
  await runtime.maintain();
  const form = await readLimitedForm(request);
  if (!form.ok) return { ok: false, response: refuse(form.error === "BODY_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", runtime) };

  const authorized = await authorizeMutation(request, runtime, form.value.get("csrfToken"));
  if (!authorized.ok) return { ok: false, response: refuse("FORBIDDEN", runtime) };

  const limit = await runtime.limiter.consume(policy, authorized.value.id);
  if (!limit.allowed) return { ok: false, response: refuse("RATE_LIMITED", runtime) };
  return { ok: true, session: authorized.value, form: form.value };
}

async function audit(runtime: Runtime, session: Session, eventType: string, checkoutIntentId: string | null, detail: Record<string, unknown>): Promise<void> {
  await runtime.audit.append({
    eventId: runtime.ids("event"),
    eventType,
    occurredAt: runtime.clock().toISOString(),
    actor: "shopper",
    sessionId: session.id,
    checkoutIntentId,
    operationId: null,
    detail,
  });
}

/**
 * GET /session/start: makes sure the browser has a server-issued anonymous
 * session, then continues to the recommendations page. A cookie value the
 * server does not recognise is never adopted; a fresh token is issued instead.
 */
export async function handleSessionStart(request: Request, runtime: Runtime): Promise<Response> {
  const url = new URL(request.url);
  const preferences = parsePreferences(url.searchParams.get("use"), url.searchParams.get("budget"));
  // The destination is always this fixed local path; nothing from the request chooses it.
  // `started=1` lets the page detect a browser that dropped the cookie, instead of redirecting back here forever.
  const destination = preferences ? `/shop?${preferencesQuery(preferences)}&started=1` : "/";

  await runtime.maintain();
  // New sessions are subject to a process-wide allocation budget and capacity limit; existing ones are not.
  const established = await runtime.sessions.establish(readSessionCookie(request.headers.get("cookie")));
  if (!established.ok) {
    const code = established.error.reason === "ALLOCATION_RATE_EXCEEDED" ? "RATE_LIMITED" : "UNAVAILABLE";
    return refuse(code, runtime, established.error.retryAfterMs);
  }
  const issued = established.value;
  if (!issued.issuedToken) return seeOther(destination);
  return seeOther(destination, {
    "set-cookie": serializeSessionCookie(issued.issuedToken, runtime.sessions.cookieMaxAgeSeconds(issued.session)),
  });
}

/** POST /checkout/start: creates a checkout intent and a server-priced quote for one demo variant. */
export async function handleCheckoutStart(request: Request, runtime: Runtime): Promise<Response> {
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.quoteRequest);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;

  const preferences = parsePreferences(form.get("use"), form.get("budget"));
  const back = preferences ? `/shop?${preferencesQuery(preferences)}&` : "/shop?";

  // Only these three fields are read. Any price or total in the form is never looked at.
  const quoteRequest = { productId: form.get("productId"), variantId: form.get("variantId"), quantity: Number(form.get("quantity")) };
  // The request is validated and priced before anything is created; a rejected request allocates no checkout records.
  const started = await startCheckoutWithQuote(runtime.checkout, session.id, quoteRequest);
  // The session stopped being valid after this request was authorized: same generic refusal as an unauthenticated request.
  if (!started.ok && started.error === "SESSION_NOT_ACTIVE") return refuse("FORBIDDEN", runtime);
  if (!started.ok) return seeOther(`${back}error=${started.error}`);
  const { intent, quote } = started.value;

  await audit(runtime, session, "QUOTE_ISSUED", intent.id, { quoteId: quote.quoteId, totalCents: quote.totalCents });
  return seeOther(`/checkout/${intent.id}`);
}

async function ownedIntent(runtime: Runtime, session: Session, intentId: string) {
  if (!ID_PATTERNS.checkoutIntent.test(intentId)) return null;
  return runtime.store.findIntentForSession(session.id, intentId);
}

/** POST /checkout/:intentId/confirm: records the shopper's explicit confirmation. Contacts no provider. */
export async function handleConfirm(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const intent = await ownedIntent(runtime, session, intentId);
  if (!intent) return refuse("NOT_FOUND", runtime);

  const back = `/checkout/${intent.id}`;
  if (form.get("acknowledged") !== "yes") return seeOther(`${back}?error=ACKNOWLEDGEMENT_REQUIRED`);

  const submission = {
    confirmationId: form.get("confirmationId"),
    nonce: form.get("nonce"),
    quoteId: form.get("quoteId"),
    quoteDigest: form.get("quoteDigest"),
  };
  // The confirmation must belong to the checkout named in the URL.
  const record =
    typeof submission.confirmationId === "string" && ID_PATTERNS.confirmation.test(submission.confirmationId)
      ? await runtime.store.findConfirmationForSession(session.id, submission.confirmationId)
      : null;
  if (record && record.checkoutIntentId !== intent.id) return seeOther(`${back}?error=CONFIRMATION_MISMATCH`);

  const confirmed = await confirmPurchaseSummary(runtime.checkout, session.id, submission);
  await audit(runtime, session, confirmed.ok ? "CONFIRMATION_ACCEPTED" : "CONFIRMATION_REJECTED", intent.id, {
    result: confirmed.ok ? "ACCEPTED" : confirmed.error,
  });
  return seeOther(confirmed.ok ? `${back}?notice=CONFIRMED` : `${back}?error=${confirmed.error}`);
}

async function runSimulationStep(runtime: Runtime, session: Session, intentId: string, step: SimulationStep): Promise<string | null> {
  const { payment, provider, ledger } = runtime;
  const intent = await runtime.store.findIntentForSession(session.id, intentId);
  if (!intent) return "INTENT_NOT_FOUND";
  const { context } = intent.snapshot;
  const captureReference = async () => (context.captureOperationId ? ((await ledger.find(context.captureOperationId))?.providerReference ?? null) : null);
  const outcome = (result: { ok: boolean; error?: string }) => (result.ok ? null : (result.error ?? "STEP_FAILED"));

  switch (step) {
    case "create_order":
      return outcome(await dispatchOrderCreate(payment, intentId));
    case "create_order_lost_response":
      provider.failNextCreateOrder("LOSE_RESPONSE");
      return outcome(await dispatchOrderCreate(payment, intentId));
    case "buyer_approve":
    case "buyer_return_without_approval": {
      if (!context.providerOrderId) return "STEP_NOT_AVAILABLE";
      if (step === "buyer_approve") provider.simulateBuyerApproval(context.providerOrderId);
      if (intent.snapshot.state !== "APPROVAL_CHECK_PENDING") {
        const returned = await recordBuyerReturn(payment, session.id, intentId);
        if (!returned.ok) return returned.error;
      }
      return outcome(await verifyApproval(payment, intentId));
    }
    case "capture":
      return outcome(await dispatchCapture(payment, intentId));
    case "capture_pending":
      provider.setNextCaptureBehavior("PENDING");
      return outcome(await dispatchCapture(payment, intentId));
    case "capture_declined":
      provider.setNextCaptureBehavior("DECLINE");
      return outcome(await dispatchCapture(payment, intentId));
    case "capture_lost_response":
      provider.failNextCapture("LOSE_RESPONSE");
      return outcome(await dispatchCapture(payment, intentId));
    case "reconcile": {
      const operationId = context.captureDispatched ? context.captureOperationId : context.orderCreateOperationId;
      return operationId ? outcome(await reconcileOperation(payment, operationId)) : "STEP_NOT_AVAILABLE";
    }
    case "settle_pending": {
      const reference = await captureReference();
      if (!reference || !context.captureOperationId) return "STEP_NOT_AVAILABLE";
      provider.simulatePendingCaptureSettled(reference, "COMPLETED");
      return outcome(await reconcileOperation(payment, context.captureOperationId));
    }
    case "external_refund": {
      const reference = await captureReference();
      if (!reference) return "STEP_NOT_AVAILABLE";
      provider.simulateExternalRefund(reference, 10_000);
      return outcome(await observeCaptureAftermath(payment, intentId));
    }
    case "cancel":
      return outcome(await cancelCheckout(runtime.checkout, session.id, intentId));
  }
}

/**
 * POST /checkout/:intentId/simulate: advances the SIMULATED payment lifecycle
 * against the in-memory mock provider. Only steps valid for the current state
 * are accepted, so a rejected request can never leave a queued mock scenario behind.
 */
export async function handleSimulate(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const guarded = await guardMutation(request, runtime, SIMULATION_POLICY);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const intent = await ownedIntent(runtime, session, intentId);
  if (!intent) return refuse("NOT_FOUND", runtime);

  const back = `/checkout/${intent.id}`;
  const step = SIMULATION_STEPS.find((candidate) => candidate === form.get("step"));
  if (!step || !availableSteps(intent.snapshot.state).includes(step)) return seeOther(`${back}?error=STEP_NOT_AVAILABLE`);

  const error = await runSimulationStep(runtime, session, intent.id, step);
  await audit(runtime, session, "SIMULATION_STEP", intent.id, { step, result: error ?? "OK" });
  return seeOther(error ? `${back}?error=${error}` : back);
}
