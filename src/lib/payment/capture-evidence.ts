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
  refundedCents: z.number().int().nonnegative().refine(Number.isSafeInteger),
  reversedOrDisputed: z.boolean(),
});

export type VerifiedCaptureEvidence = Readonly<z.infer<typeof CaptureEvidenceSchema>>;

export type CaptureEvidenceRejection =
  | "EVIDENCE_INCOMPLETE"
  | "EVIDENCE_INCONSISTENT"
  | "REQUEST_MISMATCH"
  | "ORDER_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "MERCHANT_MISMATCH"
  | "CAPTURE_ID_CHANGED";

/** What the capture must match: the immutable authorized quote and the recorded order and operation. */
export interface ExpectedCapture {
  readonly providerRequestId: string;
  readonly providerOrderId: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly merchantId: string;
  /** Capture ID already recorded for this operation (for example while pending), if any. */
  readonly knownCaptureId: string | null;
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

  if (capture.refundedCents > capture.amountCents) return err("EVIDENCE_INCONSISTENT");
  if (capture.requestId !== expected.providerRequestId) return err("REQUEST_MISMATCH");
  if (capture.orderId !== expected.providerOrderId) return err("ORDER_MISMATCH");
  if (capture.amountCents !== expected.totalCents) return err("AMOUNT_MISMATCH");
  if (capture.currency !== expected.currency) return err("CURRENCY_MISMATCH");
  if (capture.merchantId !== expected.merchantId) return err("MERCHANT_MISMATCH");
  if (expected.knownCaptureId !== null && capture.captureId !== expected.knownCaptureId) return err("CAPTURE_ID_CHANGED");
  return ok(Object.freeze(capture));
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
