import { isPermissionRefusal, type PermissionRefusalCode } from "@/lib/i18n/permission-copy";

export const CHECKOUT_ALERT_ID = "checkout-alert";
export const CHECKOUT_NOTICE_ID = "checkout-notice";
export const CHECKOUT_QUOTE_PROBLEM_ID = "checkout-quote-problem";
export const CHECKOUT_CONFIRM_HEADING_ID = "confirm-heading";
export const CHECKOUT_QUOTE_HEADING_ID = "quote-heading";

/**
 * The skip link's one target (M2-3): a refusal or error, then a notice, then the current step: the confirmation summary,
 * a problem with the quote, the quote while the checkout is still at it, else the payment section.
 */
export function checkoutCurrentTargetId(state: {
  readonly alert: boolean;
  readonly notice: boolean;
  readonly confirmation: boolean;
  readonly quoteProblem: boolean;
  readonly quoteStep: boolean;
  readonly paymentHeadingId: string | null;
}): string {
  if (state.alert) return CHECKOUT_ALERT_ID;
  if (state.notice) return CHECKOUT_NOTICE_ID;
  if (state.confirmation) return CHECKOUT_CONFIRM_HEADING_ID;
  if (state.quoteProblem) return CHECKOUT_QUOTE_PROBLEM_ID;
  if (state.quoteStep || !state.paymentHeadingId) return CHECKOUT_QUOTE_HEADING_ID;
  return state.paymentHeadingId;
}

/** A capture may have been sent and its outcome is not proven: a refused resend is reported as manual review. */
const OUTCOME_UNPROVEN: ReadonlySet<string> = new Set(["CAPTURE_UNKNOWN", "RECONCILIATION_REQUIRED", "MANUAL_REVIEW"]);

/**
 * What the mock checkout reports about F07 (M2-3, D2 and review findings 2–5). The refusal shown is the one that applies
 * now (`view.permissionRefusal`, from saved state); it replaces any message carried in the URL, which described the form
 * that was just sent and could otherwise contradict it ("review the summary below" with no summary). A permission code in
 * the URL is shown only once a capture's outcome is unproven, and then as manual review, never "nothing was charged".
 * Anywhere else a URL permission code is stale or hand-made, and is ignored.
 */
export function checkoutMessages(
  view: { readonly state: string; readonly permissionRefusal: PermissionRefusalCode | null },
  errorCode: string | undefined,
): { readonly refusal: PermissionRefusalCode | null; readonly underReview: boolean; readonly showUrlError: boolean } {
  if (view.permissionRefusal) return { refusal: view.permissionRefusal, underReview: false, showUrlError: false };
  if (isPermissionRefusal(errorCode)) return OUTCOME_UNPROVEN.has(view.state) ? { refusal: errorCode, underReview: true, showUrlError: false } : { refusal: null, underReview: false, showUrlError: false };
  return { refusal: null, underReview: false, showUrlError: true };
}
