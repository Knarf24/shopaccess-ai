import type { MerchantCatalog } from "../catalog/schemas";
import {
  INITIAL_PAYMENT_SNAPSHOT,
  transition,
  type PaymentEvent,
  type PaymentSnapshot,
  type TransitionRejection,
} from "../payment/state-machine";
import { createQuote, type Quote, type QuoteRejection } from "../quote/quote";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { err, ok, type Result } from "../shared/result";
import type { CheckoutIntentRecord, CheckoutRepository, SessionLivenessCheck } from "./store";

export interface CheckoutDeps {
  readonly store: CheckoutRepository;
  /**
   * Synchronous session-liveness decision, evaluated by the store inside the
   * checkout commit. Authorization earlier in the request is not enough: the
   * session may have expired, been revoked or been reclaimed since.
   */
  readonly sessionIsLive: SessionLivenessCheck;
  readonly catalog: MerchantCatalog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type ApplyEventFailure = { code: "INTENT_NOT_FOUND" } | { code: "VERSION_CONFLICT" } | TransitionRejection;

/** Runs one event through the reducer and persists the result with compare-and-set. */
export async function applyPaymentEvent(
  store: CheckoutRepository,
  intentId: string,
  event: PaymentEvent,
): Promise<Result<PaymentSnapshot, ApplyEventFailure>> {
  const intent = await store.findIntent(intentId);
  if (!intent) return err({ code: "INTENT_NOT_FOUND" });
  const result = transition(intent.snapshot, event);
  if (!result.ok) return result;
  const stored = await store.applyTransition(intentId, intent.snapshot.version, result.value.snapshot, result.value.record);
  return stored ? ok(result.value.snapshot) : err({ code: "VERSION_CONFLICT" });
}

/** Creates an empty DRAFT checkout. Throws if the session is no longer live; nothing is stored in that case. */
export async function startCheckout(deps: CheckoutDeps, sessionId: string): Promise<CheckoutIntentRecord> {
  const record: CheckoutIntentRecord = {
    id: deps.ids("checkoutIntent"),
    sessionId,
    snapshot: INITIAL_PAYMENT_SNAPSHOT,
    createdAt: deps.clock().toISOString(),
  };
  const committed = await deps.store.commitCheckoutStart({ intent: record, transitions: [], quote: null }, deps.sessionIsLive);
  if (!committed) throw new Error("SESSION_NOT_ACTIVE");
  return record;
}

export type StartCheckoutFailure = QuoteRejection | "SESSION_NOT_ACTIVE" | "CHECKOUT_NOT_CREATED";

/**
 * Starts a checkout for one demo variant.
 *
 * 1. The request is validated and priced against the server catalog, in memory.
 *    An invalid, unavailable or external-product request stops here and
 *    allocates nothing.
 * 2. The intent, its first transition and the quote are prepared in memory.
 * 3. One atomic store commit decides that the owning session is still live
 *    and writes all three records, or writes none of them. A request whose
 *    session expired, was revoked or was reclaimed after it was authorized is
 *    rejected with SESSION_NOT_ACTIVE and leaves no record of any kind.
 */
export async function startCheckoutWithQuote(
  deps: CheckoutDeps,
  sessionId: string,
  request: unknown,
  interfaceLanguage?: "en" | "es",
): Promise<Result<{ intent: CheckoutIntentRecord; quote: Quote }, StartCheckoutFailure>> {
  const now = deps.clock();
  const intentId = deps.ids("checkoutIntent");
  const quote = createQuote({ sessionId, checkoutIntentId: intentId, request, catalog: deps.catalog, now, ids: deps.ids });
  if (!quote.ok) return quote;

  // Pure reducer step: nothing is stored yet.
  const quoted = transition(INITIAL_PAYMENT_SNAPSHOT, {
    type: "QUOTE_ISSUED",
    eventId: deps.ids("event"),
    occurredAt: now.toISOString(),
    actor: "server",
    quoteId: quote.value.quoteId,
  });
  if (!quoted.ok) return err("CHECKOUT_NOT_CREATED");

  const intent: CheckoutIntentRecord = {
    id: intentId,
    sessionId,
    snapshot: quoted.value.snapshot,
    createdAt: now.toISOString(),
    ...(interfaceLanguage ? { interfaceLanguage } : {}),
  };
  const committed = await deps.store.commitCheckoutStart({ intent, transitions: [quoted.value.record], quote: quote.value }, deps.sessionIsLive);
  if (!committed) return err("SESSION_NOT_ACTIVE");
  return ok({ intent, quote: quote.value });
}

export type RequestQuoteFailure = QuoteRejection | "INTENT_NOT_FOUND" | "INTENT_NOT_QUOTABLE";

/**
 * Issues a new immutable quote for a checkout intent owned by `sessionId`.
 * `request` is untrusted; only product, variant and quantity are read from it.
 */
export async function requestQuote(
  deps: CheckoutDeps,
  sessionId: string,
  intentId: string,
  request: unknown,
): Promise<Result<Quote, RequestQuoteFailure>> {
  const intent = await deps.store.findIntentForSession(sessionId, intentId);
  if (!intent) return err("INTENT_NOT_FOUND");

  const now = deps.clock();
  const quote = createQuote({ sessionId, checkoutIntentId: intentId, request, catalog: deps.catalog, now, ids: deps.ids });
  if (!quote.ok) return quote;

  return deps.store.transaction(async () => {
    const applied = await applyPaymentEvent(deps.store, intentId, {
      type: "QUOTE_ISSUED",
      eventId: deps.ids("event"),
      occurredAt: now.toISOString(),
      actor: "server",
      quoteId: quote.value.quoteId,
    });
    if (!applied.ok) return err("INTENT_NOT_QUOTABLE" as const);
    await deps.store.insertQuote(quote.value);
    return ok(quote.value);
  });
}
