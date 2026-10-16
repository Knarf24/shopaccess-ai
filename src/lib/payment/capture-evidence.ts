import { z } from "zod";
import { err, ok, type Result } from "../shared/result";

/**
 * The single place where capture evidence from a provider is judged.
 *
 * Whatever a provider adapter returns for a capture (an immediate response or
 * a reconciliation readback) is treated as untrusted data and must pass
 * `validateCaptureEvidence` before any payment-state transition is derived
 * from it. Nothing else in the application may decide that a capture counts.
 */
const CaptureEvidenceSchema = z.object({
  captureId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  orderId: z.string().min(1).max(128),
  status: z.enum(["COMPLETED", "PENDING", "DECLINED"]),
  amountCents: z.number().int().positive().refine(Number.isSafeInteger),
  currency: z.string().min(1).max(8),
  merchantId: z.string().min(1).max(64),
  refundedCents: z.number().int().nonnegative().refine(Number.isSafeInteger).nullish(),
  reversedOrDisputed: z.boolean().nullish(),
  paypalMerchantId: z.string().min(1).max(64).nullish(),
  correlationId: z.string().min(1).max(127).nullish(),
});

export interface VerifiedCaptureEvidence {
  readonly captureId: string;
  readonly requestId: string;
  readonly orderId: string;
  readonly status: "COMPLETED" | "PENDING" | "DECLINED";
  readonly amountCents: number;
  readonly currency: string;
  readonly merchantId: string;
  /** Null when the provider body did not report a refund. That is not a report of zero. */
  readonly refundedCents: number | null;
  /** Null when the provider body did not report a dispute or reversal. That is not a report of false. */
  readonly reversedOrDisputed: boolean | null;
  /** Present only when the caller asked for a sandbox payee check. */
  readonly paypalMerchantId?: string | null;
  /** Present only when the caller asked for a sandbox payee check. */
  readonly correlationId?: string | null;
}

export type CaptureEvidenceRejection =
  | "EVIDENCE_INCOMPLETE"
  | "EVIDENCE_INCONSISTENT"
  | "REQUEST_MISMATCH"
  | "ORDER_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "MERCHANT_MISMATCH"
  | "CAPTURE_ID_CHANGED"
  | "PAYEE_MISMATCH"
  | "CORRELATION_MISMATCH";

/** What the capture must match: the immutable authorized quote and the recorded order and operation. */
export interface ExpectedCapture {
  readonly providerRequestId: string;
  readonly providerOrderId: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly merchantId: string;
  /** Capture ID already recorded for this operation (for example while pending), if any. */
  readonly knownCaptureId: string | null;
  /** Set for sandbox captures. Mock callers omit both and the payee check does not run. */
  readonly paypalMerchantId?: string;
  readonly correlationId?: string;
}

/**
 * Accepts capture evidence only if every required field is present and well
 * formed, it is internally consistent, and it matches the authorized quote and
 * the recorded provider order. The reported status is returned as-is; only a
 * validated `COMPLETED` may ever lead to CAPTURED_VERIFIED.
 */
export function validateCaptureEvidence(raw: unknown, expected: ExpectedCapture): Result<VerifiedCaptureEvidence, CaptureEvidenceRejection> {
  const parsed = CaptureEvidenceSchema.safeParse(raw);
  if (!parsed.success) return err("EVIDENCE_INCOMPLETE");
  const capture = parsed.data;
  const refundedCents = capture.refundedCents ?? null;
  const reversedOrDisputed = capture.reversedOrDisputed ?? null;
  const paypalMerchantId = capture.paypalMerchantId ?? null;
  const correlationId = capture.correlationId ?? null;

  if (refundedCents !== null && refundedCents > capture.amountCents) return err("EVIDENCE_INCONSISTENT");
  if (capture.requestId !== expected.providerRequestId) return err("REQUEST_MISMATCH");
  if (capture.orderId !== expected.providerOrderId) return err("ORDER_MISMATCH");
  if (capture.amountCents !== expected.totalCents) return err("AMOUNT_MISMATCH");
  if (capture.currency !== expected.currency) return err("CURRENCY_MISMATCH");
  if (capture.merchantId !== expected.merchantId) return err("MERCHANT_MISMATCH");
  if (expected.paypalMerchantId !== undefined) {
    if (paypalMerchantId !== expected.paypalMerchantId) return err("PAYEE_MISMATCH");
    if (correlationId !== expected.correlationId) return err("CORRELATION_MISMATCH");
  }
  if (expected.knownCaptureId !== null && capture.captureId !== expected.knownCaptureId) return err("CAPTURE_ID_CHANGED");
  const verified = {
    captureId: capture.captureId,
    requestId: capture.requestId,
    orderId: capture.orderId,
    status: capture.status,
    amountCents: capture.amountCents,
    currency: capture.currency,
    merchantId: capture.merchantId,
    refundedCents,
    reversedOrDisputed,
  };
  if (expected.paypalMerchantId === undefined) return ok(Object.freeze(verified));
  return ok(Object.freeze({ ...verified, paypalMerchantId, correlationId }));
}

/** Pulls display-safe identifiers out of rejected evidence so the conflicting observation can still be recorded. */
export function describeRejectedEvidence(raw: unknown): {
  providerOrderId: string | null;
  providerCaptureId: string | null;
  reportedStatus: string;
  reportedAmountCents: number | null;
  reportedCurrency: string | null;
} {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown, max: number) => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);
  return {
    providerOrderId: text(record.orderId, 128),
    providerCaptureId: text(record.captureId, 128),
    reportedStatus: text(record.status, 32) ?? "MISSING",
    reportedAmountCents: typeof record.amountCents === "number" && Number.isSafeInteger(record.amountCents) ? record.amountCents : null,
    reportedCurrency: text(record.currency, 8),
  };
}
