import { headers } from "next/headers";
import { findMerchantVariant } from "@/lib/catalog/merchant-catalog";
import type { ProviderObservation } from "@/lib/checkout/store";
import { prepareConfirmation, type ConfirmationChallenge } from "@/lib/confirmation/confirmation";
import { CHECKOUT_GENERIC_ES, CHECKOUT_MESSAGES_ES } from "@/lib/i18n/demo-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";
import { isPermissionRefusal, type PermissionRefusalCode } from "@/lib/i18n/permission-copy";
import type { PaymentOperation } from "@/lib/payment/operations";
import { captureDeclinedBefore } from "@/lib/payment/orchestrator";
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
  /** Why no confirmation could be prepared, other than a purchase-permission refusal (that is `permissionRefusal`). */
  readonly challengeProblem: string | null;
  /**
   * The F07 refusal that applies now (M2-3 review findings 2–5), from the saved permission and payment records, never
   * from the URL. Only before any capture could have been sent; while it applies, only Cancel and Reconcile are offered.
   */
  readonly permissionRefusal: PermissionRefusalCode | null;
  readonly steps: readonly SimulationStep[];
  readonly transitions: readonly TransitionRecord[];
  readonly observations: readonly ProviderObservation[];
  readonly operations: readonly PaymentOperation[];
  /** Set only when the mock journey sent a language. Null leaves the existing English checkout markup. */
  readonly interfaceLanguage: "en" | "es" | null;
}

/**
 * Confirmed checkouts whose next step needs the checkout's purchase permission (order creation or its resend, approval
 * that leads to a capture, the capture itself), before any capture could have been sent. A decline returns here too.
 * ORDER_CREATE_UNKNOWN (second review finding 4): an order resend needs the permission; no capture can have been sent.
 */
const PERMISSION_GATED: ReadonlySet<PaymentState> = new Set([
  "USER_CONFIRMED",
  "ORDER_CREATE_UNKNOWN",
  "AWAITING_APPROVAL",
  "APPROVAL_CHECK_PENDING",
  "APPROVED_VERIFIED",
  "DECLINED_RETRYABLE",
]);
/** Steps still offered while a refusal applies: Cancel, and Reconcile, which only reads back (a resend stays gated). */
const STEPS_WHILE_REFUSED: ReadonlySet<SimulationStep> = new Set(["cancel", "reconcile"]);

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
  let permissionRefusal: PermissionRefusalCode | null = null;
  const captures = await runtime.ledger.listForIntent(intentId, "CAPTURE");
  if (state === "QUOTED" && quote) {
    // Each render replaces the quote's single challenge; a page rendered earlier is superseded and told to refresh.
    const prepared = await prepareConfirmation(runtime.checkout, session.id, quote.quoteId);
    if (prepared.ok) challenge = prepared.value;
    else if (isPermissionRefusal(prepared.error)) permissionRefusal = prepared.error;
    else challengeProblem = prepared.error;
  } else if (PERMISSION_GATED.has(state) && quote && !context.captureDispatched) {
    // The same read-only check the next step would make, so the page never offers a step the gate will refuse.
    const checked = runtime.checkout.purchaseGate.check(session.id, quote, intentId, "display");
    if (!checked.ok) permissionRefusal = checked.code;
    else if (captureDeclinedBefore(captures)) permissionRefusal = "CONFIRMATION_REQUIRED";
  }
  const steps = availableSteps(state).filter((step) => permissionRefusal === null || STEPS_WHILE_REFUSED.has(step));

  return {
    intentId,
    state,
    quote,
    itemTitle: entry ? `${entry.product.title} — ${entry.variant.label}` : null,
    merchantName: runtime.catalog.merchant.displayName,
    challenge,
    challengeProblem,
    permissionRefusal,
    steps,
    transitions: await runtime.store.listTransitions(intentId),
    observations: await runtime.store.listObservations(intentId),
    operations: [...(await runtime.ledger.listForIntent(intentId, "ORDER_CREATE")), ...captures],
    interfaceLanguage: intent.interfaceLanguage ?? null,
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
  // PostgreSQL mode only (specification 19.19). None of these codes is produced by the mock.
  CANCELED: "This checkout was canceled.",
  REVIEW_NOT_READY: "The purchase summary could not be prepared just now. Use Review again to try once more.",
  START_UNCERTAIN:
    "We could not tell whether your checkout was created. If it appears in the list below, open it from there. If it is not listed, it may not have been created, or it may not be visible yet. Nothing has been resubmitted for you.",
  // The three local outcomes of a confirmation that was not sent to the database. Each says what was seen when the
  // form arrived, and none says what has or has not happened since.
  FORM_OUT_OF_DATE: "This form could not be processed. Reload to see the current checkout status.",
  ALREADY_CONFIRMED: "This checkout was shown as confirmed when this form arrived. Reload to see the current checkout status.",
  CHECKOUT_NOT_CONFIRMABLE: "This checkout was not awaiting confirmation when this form arrived. Reload to see the current checkout status.",
  CONFIRMATION_UNAVAILABLE: "This summary could not be confirmed. Use Review again, or request a new quote.",
  NOT_AWAITING_CONFIRMATION: "This checkout is not awaiting confirmation.",
  CHALLENGE_LIMIT_REACHED: "This quote has been reviewed too many times. Request a new quote.",
  AT_PURCHASE_CAPACITY: "You have reached the number of checkouts that can be open at once. Cancel one you no longer need, then try again.",
  GROUP_INTENT_LIMIT: "This purchase has been quoted too many times. Start a new checkout from the shop.",
  REPLACEMENT_NOT_ALLOWED: "This checkout can no longer be replaced by a new quote.",
  STALE_DRAFT: "This page is out of date. The current draft was kept. Review it and submit again.",
  DRAFT_EXPIRED: "That draft expired. Nothing was confirmed. Start again.",
  DRAFT_NOT_FOUND: "There is no draft to confirm. Nothing was confirmed.",
  TEXT_TOO_LONG: "That message is too long. Shorten it and submit again.",
  CONFIRM_INCOMPLETE: "Choose a use and enter a budget before confirming.",
};

export function messageFor(code: string | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? "That action could not be completed.";
}

/**
 * A checkout message in the checkout's saved language (finding 8). English matches `messageFor` for every own key. In Spanish, a known
 * code without Spanish wording keeps its English text and is reported as English, so the page can mark it; an unknown
 * code gets the Spanish generic message.
 */
export function checkoutMessage(code: string | undefined, language: JourneyLanguage): { readonly text: string; readonly lang: JourneyLanguage } | null {
  if (!code) return null;
  // Only own keys are messages: an inherited name (__proto__, constructor, toString…) is an unknown code (Codex finding 1).
  if (language === "en") return { text: Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : "That action could not be completed.", lang: "en" };
  if (Object.hasOwn(CHECKOUT_MESSAGES_ES, code)) return { text: CHECKOUT_MESSAGES_ES[code]!, lang: "es" };
  if (Object.hasOwn(MESSAGES, code)) return { text: MESSAGES[code]!, lang: "en" };
  return { text: CHECKOUT_GENERIC_ES, lang: "es" };
}
