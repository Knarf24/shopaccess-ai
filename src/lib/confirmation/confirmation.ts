import { z } from "zod";
import { findMerchantVariant } from "../catalog/merchant-catalog";
import { applyPaymentEvent, type CheckoutDeps } from "../checkout/service";
import type { ConfirmationRecord, ConfirmationSummary } from "../checkout/store";
import { verifyQuote, type QuoteVerificationFailure } from "../quote/quote";
import { constantTimeEqual, randomTokenBase64Url, sha256Hex } from "../shared/crypto";
import { ID_PATTERNS } from "../shared/ids";
import { err, ok, type Result } from "../shared/result";

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export interface ConfirmationChallenge {
  readonly confirmationId: string;
  /** Single-use nonce. Returned once for embedding in the confirmation form; only its digest is stored. */
  readonly nonce: string;
  readonly quoteId: string;
  readonly quoteDigest: string;
  readonly summary: ConfirmationSummary;
  readonly expiresAt: string;
}

export type PrepareConfirmationFailure = QuoteVerificationFailure | "QUOTE_NOT_FOUND" | "INTENT_NOT_AWAITING_CONFIRMATION";

/**
 * Creates the purchase summary a shopper will be asked to confirm, bound to one
 * quote and one session.
 *
 * One active challenge per quote: only a digest of the nonce is stored, so an
 * existing challenge cannot be shown again. Each call therefore issues a
 * replacement and atomically discards the previous one. A page opened earlier
 * (another tab, or before a refresh) holds a superseded challenge and is told
 * to refresh when it submits.
 */
export async function prepareConfirmation(
  deps: CheckoutDeps,
  sessionId: string,
  quoteId: string,
): Promise<Result<ConfirmationChallenge, PrepareConfirmationFailure>> {
  const now = deps.clock();
  const stored = await deps.store.findQuoteForSession(sessionId, quoteId);
  if (!stored) return err("QUOTE_NOT_FOUND");
  const quote = verifyQuote(stored, { sessionId, catalog: deps.catalog, now });
  if (!quote.ok) return quote;

  const intent = await deps.store.findIntentForSession(sessionId, quote.value.checkoutIntentId);
  if (!intent || intent.snapshot.state !== "QUOTED" || intent.snapshot.context.quoteId !== quoteId) {
    return err("INTENT_NOT_AWAITING_CONFIRMATION");
  }

  // verifyQuote already proved the variant exists and is unchanged.
  const entry = findMerchantVariant(deps.catalog, quote.value.productId, quote.value.variantId)!;
  const summary: ConfirmationSummary = {
    merchantName: deps.catalog.merchant.displayName,
    productTitle: entry.product.title,
    variantLabel: entry.variant.label,
    quantity: quote.value.quantity,
    currency: quote.value.currency,
    totalCents: quote.value.totalCents,
  };
  const nonce = randomTokenBase64Url(32);
  const expiresAt = new Date(Math.min(now.getTime() + CONFIRMATION_TTL_MS, Date.parse(quote.value.expiresAt)));
  const record: ConfirmationRecord = {
    id: deps.ids("confirmation"),
    sessionId,
    checkoutIntentId: quote.value.checkoutIntentId,
    quoteId,
    quoteDigest: quote.value.digest,
    summary,
    nonceDigest: sha256Hex(nonce),
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    consumedAt: null,
  };
  // Reclaim challenges that expired unused, then install this one as the quote's only challenge.
  await deps.store.purgeExpiredConfirmations(now);
  if (!(await deps.store.replaceActiveConfirmation(record))) return err("INTENT_NOT_AWAITING_CONFIRMATION");
  return ok({
    confirmationId: record.id,
    nonce,
    quoteId,
    quoteDigest: record.quoteDigest,
    summary,
    expiresAt: record.expiresAt,
  });
}

export const ConfirmationSubmissionSchema = z.strictObject({
  confirmationId: z.string().regex(ID_PATTERNS.confirmation),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  quoteId: z.string().regex(ID_PATTERNS.quote),
  quoteDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ConfirmFailure =
  | QuoteVerificationFailure
  | "SUBMISSION_INVALID"
  | "CONFIRMATION_NOT_FOUND"
  | "CONFIRMATION_SUPERSEDED"
  | "CONFIRMATION_MISMATCH"
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_ALREADY_USED"
  | "INTENT_NOT_AWAITING_CONFIRMATION";

export interface ConfirmedPurchaseSummary {
  readonly confirmationId: string;
  readonly checkoutIntentId: string;
  readonly quoteId: string;
  readonly confirmedAt: string;
}

/**
 * Records a deliberate shopper confirmation of one specific summary. It can
 * succeed at most once per confirmation; a replay changes nothing. Confirming
 * does not contact any payment provider.
 */
export async function confirmPurchaseSummary(
  deps: CheckoutDeps,
  sessionId: string,
  submission: unknown,
): Promise<Result<ConfirmedPurchaseSummary, ConfirmFailure>> {
  const parsed = ConfirmationSubmissionSchema.safeParse(submission);
  if (!parsed.success) return err("SUBMISSION_INVALID");
  const now = deps.clock();

  // Everything is looked up through the session, so another session's challenge simply does not exist here.
  const record = await deps.store.findConfirmationForQuote(sessionId, parsed.data.quoteId);
  if (!record) return err("CONFIRMATION_NOT_FOUND");
  if (record.id !== parsed.data.confirmationId) {
    // The quote has a different challenge now: this submission comes from an out-of-date page.
    return err(record.consumedAt !== null ? "CONFIRMATION_ALREADY_USED" : "CONFIRMATION_SUPERSEDED");
  }
  const matches =
    constantTimeEqual(record.nonceDigest, sha256Hex(parsed.data.nonce)) &&
    record.quoteId === parsed.data.quoteId &&
    record.quoteDigest === parsed.data.quoteDigest;
  if (!matches) return err("CONFIRMATION_MISMATCH");
  if (record.consumedAt !== null) return err("CONFIRMATION_ALREADY_USED");
  if (now.getTime() >= Date.parse(record.expiresAt)) return err("CONFIRMATION_EXPIRED");

  const stored = await deps.store.findQuoteForSession(sessionId, record.quoteId);
  const quote = verifyQuote(stored, { sessionId, catalog: deps.catalog, now });
  if (!quote.ok) return quote;
  if (quote.value.digest !== record.quoteDigest || quote.value.totalCents !== record.summary.totalCents) {
    return err("CONFIRMATION_MISMATCH");
  }

  return deps.store.transaction(async () => {
    const intent = await deps.store.findIntentForSession(sessionId, record.checkoutIntentId);
    if (!intent || intent.snapshot.state !== "QUOTED" || intent.snapshot.context.quoteId !== record.quoteId) {
      return err("INTENT_NOT_AWAITING_CONFIRMATION" as const);
    }
    // Consume first: of any number of concurrent submissions, exactly one proceeds.
    if (!(await deps.store.consumeConfirmation(record.id, now.toISOString()))) {
      return err("CONFIRMATION_ALREADY_USED" as const);
    }
    const applied = await applyPaymentEvent(deps.store, record.checkoutIntentId, {
      type: "SHOPPER_CONFIRMED",
      eventId: deps.ids("event"),
      occurredAt: now.toISOString(),
      actor: "shopper",
      quoteId: record.quoteId,
      confirmationId: record.id,
    });
    if (!applied.ok) return err("INTENT_NOT_AWAITING_CONFIRMATION" as const);
    return ok({
      confirmationId: record.id,
      checkoutIntentId: record.checkoutIntentId,
      quoteId: record.quoteId,
      confirmedAt: now.toISOString(),
    });
  });
}
