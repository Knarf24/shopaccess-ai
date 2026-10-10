import { headers } from "next/headers";
import { findMerchantVariant } from "@/lib/catalog/merchant-catalog";
import type { ProviderObservation } from "@/lib/checkout/store";
import { prepareConfirmation, type ConfirmationChallenge } from "@/lib/confirmation/confirmation";
import type { PaymentOperation } from "@/lib/payment/operations";
import type { PaymentState, TransitionRecord } from "@/lib/payment/state-machine";
import type { Quote } from "@/lib/quote/quote";
import { readSessionCookie } from "@/lib/session/cookie";
import type { Session } from "@/lib/session/service";
import { ID_PATTERNS } from "@/lib/shared/ids";
import type { Runtime } from "./runtime";
import { availableSteps, type SimulationStep } from "./simulation";

/** Resolves the anonymous session for a page render. Returns null when there is no valid session. */
export async function resolvePageSession(runtime: Runtime): Promise<Session | null> {
  const session = await runtime.sessions.resolve(readSessionCookie((await headers()).get("cookie")));
  return session.ok ? session.value : null;
}

export interface CheckoutView {
  readonly intentId: string;
  readonly state: PaymentState;
  readonly quote: Quote | null;
  readonly itemTitle: string | null;
  readonly merchantName: string;
  /** Present only while the checkout is waiting for confirmation and the quote is still valid. */
  readonly challenge: ConfirmationChallenge | null;
  readonly challengeProblem: string | null;
  readonly steps: readonly SimulationStep[];
  readonly transitions: readonly TransitionRecord[];
  readonly observations: readonly ProviderObservation[];
  readonly operations: readonly PaymentOperation[];
}

/** Loads a checkout for display. Returns null unless it belongs to the given session. */
export async function buildCheckoutView(runtime: Runtime, session: Session, intentId: string): Promise<CheckoutView | null> {
  if (!ID_PATTERNS.checkoutIntent.test(intentId)) return null;
  const intent = await runtime.store.findIntentForSession(session.id, intentId);
  if (!intent) return null;

  const { state, context } = intent.snapshot;
  const quote = context.quoteId ? await runtime.store.findQuoteForSession(session.id, context.quoteId) : null;
  const entry = quote ? findMerchantVariant(runtime.catalog, quote.productId, quote.variantId) : null;

  let challenge: ConfirmationChallenge | null = null;
  let challengeProblem: string | null = null;
  if (state === "QUOTED" && quote) {
    // Each render replaces the quote's single challenge; a page rendered earlier is superseded and told to refresh.
    const prepared = await prepareConfirmation(runtime.checkout, session.id, quote.quoteId);
    if (prepared.ok) challenge = prepared.value;
    else challengeProblem = prepared.error;
  }

  return {
    intentId,
    state,
    quote,
    itemTitle: entry ? `${entry.product.title} — ${entry.variant.label}` : null,
    merchantName: runtime.catalog.merchant.displayName,
    challenge,
    challengeProblem,
    steps: availableSteps(state),
    transitions: await runtime.store.listTransitions(intentId),
    observations: await runtime.store.listObservations(intentId),
    operations: [...(await runtime.ledger.listForIntent(intentId, "ORDER_CREATE")), ...(await runtime.ledger.listForIntent(intentId, "CAPTURE"))],
  };
}

/** Fixed, shopper-facing text for every code that can appear in a redirect. Unknown codes get a generic message. */
const MESSAGES: Record<string, string> = {
  CONFIRMED: "Your confirmation of this purchase summary was recorded. No payment has been taken.",
  ACKNOWLEDGEMENT_REQUIRED: "Tick the box to show you reviewed the summary before confirming.",
  CONFIRMATION_ALREADY_USED: "This summary was already confirmed. Confirming again changes nothing.",
  CONFIRMATION_SUPERSEDED:
    "This summary was opened again in another tab or refreshed, so the copy you submitted is out of date. Nothing was confirmed. Review the summary below and confirm again.",
  CONFIRMATION_NOT_FOUND: "That summary is no longer available. Nothing was confirmed. Review the summary below and confirm again.",
  CONFIRMATION_EXPIRED: "This summary expired before it was confirmed. Review the new summary below.",
  CONFIRMATION_MISMATCH: "The confirmation did not match this summary. Review the summary below and try again.",
  QUOTE_EXPIRED: "This quote expired. Go back and request a new quote.",
  QUOTE_STALE_CATALOG: "The item changed since this quote was made. Go back and request a new quote.",
  QUOTE_NO_LONGER_VALID: "The quote was no longer valid, so nothing was sent. Go back and request a new quote.",
  VARIANT_UNAVAILABLE: "That laptop is not available.",
  QUANTITY_EXCEEDS_LIMIT: "That quantity is above the limit for this laptop.",
  CAPTURE_ALREADY_DISPATCHED: "This checkout cannot be canceled because a capture request may already have been sent.",
  NOT_CANCELABLE: "This checkout cannot be canceled in its current state.",
  STEP_NOT_AVAILABLE: "That simulation step is not available in the current state.",
};

export function messageFor(code: string | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? "That action could not be completed.";
}
