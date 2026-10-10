import type { MerchantCatalog } from "../catalog/schemas";
import { applyPaymentEvent } from "../checkout/service";
import type { CheckoutIntentRecord, CheckoutRepository, ProviderObservation } from "../checkout/store";
import type {
  PaymentProvider,
  ProviderCallResult,
  ProviderCapture,
  ProviderOrder,
  ProviderReadback,
} from "../providers/payment";
import { verifyQuote, type Quote } from "../quote/quote";
import type { AuditLog } from "../security/audit";
import { canonicalJson } from "../shared/canonical-json";
import type { Clock } from "../shared/clock";
import { sha256Hex } from "../shared/crypto";
import type { IdGenerator } from "../shared/ids";
import { err, ok, type Result } from "../shared/result";
import { describeRejectedEvidence, validateCaptureEvidence } from "./capture-evidence";
import type { OperationLedger, PaymentOperation } from "./operations";
import type { PaymentEvent, PaymentState } from "./state-machine";

/**
 * Operation dispatch and recovery for the mock milestone.
 *
 * Every dispatch follows the same shape:
 *   1. validate state            (inside a transaction)
 *   2. persist operation + claim (inside the same transaction)
 *   3. commit
 *   4. call the provider         (outside any transaction)
 *   5. persist the observed result through a guarded transition
 *
 * Proposed, unverified service targets: try to resolve unknown outcomes within
 * 15 minutes and escalate to manual review after 60 minutes.
 */
export const PROPOSED_ESCALATION_AFTER_MS = 60 * 60 * 1000;

export interface PaymentDeps {
  readonly store: CheckoutRepository;
  readonly ledger: OperationLedger;
  readonly provider: PaymentProvider;
  readonly catalog: MerchantCatalog;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly workerId: string;
  readonly leaseMs: number;
}

export type PaymentFlowFailure =
  | "INTENT_NOT_FOUND"
  | "INVALID_STATE"
  | "QUOTE_NO_LONGER_VALID"
  | "PAYLOAD_MISMATCH"
  | "OPERATION_NOT_CLAIMABLE"
  | "OPERATION_NOT_FOUND"
  | "STATE_CONFLICT";

type EventInput = PaymentEvent extends infer E ? (E extends PaymentEvent ? Omit<E, "eventId" | "occurredAt"> : never) : never;

async function emit(deps: PaymentDeps, intentId: string, event: EventInput): Promise<boolean> {
  const full = { ...event, eventId: deps.ids("event"), occurredAt: deps.clock().toISOString() } as PaymentEvent;
  return (await applyPaymentEvent(deps.store, intentId, full)).ok;
}

async function observe(
  deps: PaymentDeps,
  operation: Pick<PaymentOperation, "id" | "checkoutIntentId"> | { id: null; checkoutIntentId: string },
  source: ProviderObservation["source"],
  subject: ProviderObservation["subject"],
  details: {
    providerOrderId?: string | null;
    providerCaptureId?: string | null;
    observedStatus: string;
    conflict?: string;
    reportedAmountCents?: number | null;
    reportedCurrency?: string | null;
  },
): Promise<string> {
  const id = deps.ids("observation");
  await deps.store.appendObservation({
    id,
    checkoutIntentId: operation.checkoutIntentId,
    operationId: operation.id,
    source,
    subject,
    providerOrderId: details.providerOrderId ?? null,
    providerCaptureId: details.providerCaptureId ?? null,
    observedStatus: details.observedStatus,
    conflict: details.conflict ?? null,
    reportedAmountCents: details.reportedAmountCents ?? null,
    reportedCurrency: details.reportedCurrency ?? null,
    observedAt: deps.clock().toISOString(),
  });
  return id;
}

async function currentState(deps: PaymentDeps, intentId: string): Promise<PaymentState | null> {
  return (await deps.store.findIntent(intentId))?.snapshot.state ?? null;
}

/** The state after a step. The intent can be gone if its (mock) session was reclaimed while the step ran. */
async function finalState(deps: PaymentDeps, intentId: string): Promise<Result<PaymentState, PaymentFlowFailure>> {
  const state = await currentState(deps, intentId);
  return state === null ? err("INTENT_NOT_FOUND") : ok(state);
}

async function loadQuote(deps: PaymentDeps, intent: CheckoutIntentRecord): Promise<Quote | null> {
  return intent.snapshot.context.quoteId ? deps.store.findQuote(intent.snapshot.context.quoteId) : null;
}

const orderMatchesQuote = (order: ProviderOrder, quote: Quote): boolean =>
  order.amountCents === quote.totalCents && order.currency === quote.currency && order.merchantId === quote.merchantId;

/** A thrown error from a provider call is an unknown outcome, never a failure. */
async function callProvider<T>(call: () => Promise<ProviderCallResult<T>>): Promise<ProviderCallResult<T>> {
  try {
    return await call();
  } catch {
    return { kind: "NO_RESPONSE" };
  }
}

async function readProvider<T>(call: () => Promise<ProviderReadback<T>>): Promise<ProviderReadback<T>> {
  try {
    return await call();
  } catch {
    return { kind: "UNAVAILABLE" };
  }
}

// --- Order creation -------------------------------------------------------

/** Steps 1-3: validate, persist the operation identity and claim, commit. Makes no provider call. */
export async function prepareOrderCreate(deps: PaymentDeps, intentId: string): Promise<Result<PaymentOperation, PaymentFlowFailure>> {
  return deps.store.transaction(async () => {
    const intent = await deps.store.findIntent(intentId);
    if (!intent) return err("INTENT_NOT_FOUND");
    if (intent.snapshot.state !== "USER_CONFIRMED") return err("INVALID_STATE");

    const now = deps.clock();
    const quote = verifyQuote(await loadQuote(deps, intent), { sessionId: intent.sessionId, catalog: deps.catalog, now });
    if (!quote.ok) {
      // Expired or materially changed: the shopper must get a new quote and confirm again.
      await emit(deps, intentId, { type: "QUOTE_INVALIDATED", actor: "server" });
      return err("QUOTE_NO_LONGER_VALID");
    }

    const ensured = await deps.ledger.ensureOperation({
      checkoutIntentId: intentId,
      type: "ORDER_CREATE",
      sequence: 1,
      payloadDigest: sha256Hex(canonicalJson({ quoteDigest: quote.value.digest, confirmationId: intent.snapshot.context.confirmationId })),
      now,
    });
    if (!ensured.ok) return err("PAYLOAD_MISMATCH");
    const claimed = await deps.ledger.claimForDispatch(ensured.operation.id, deps.workerId, now, deps.leaseMs);
    if (!claimed) return err("OPERATION_NOT_CLAIMABLE");
    const moved = await emit(deps, intentId, { type: "ORDER_CREATE_DISPATCHED", actor: "operation_worker", operationId: claimed.id });
    return moved ? ok(claimed) : err("STATE_CONFLICT");
  });
}

async function settleOrderFound(
  deps: PaymentDeps,
  operation: PaymentOperation,
  order: ProviderOrder,
  source: "provider_response" | "provider_readback",
): Promise<void> {
  const intent = await deps.store.findIntent(operation.checkoutIntentId);
  const quote = intent ? await loadQuote(deps, intent) : null;
  const observationId = await observe(deps, operation, source, "ORDER", { providerOrderId: order.orderId, observedStatus: order.status });
  await deps.ledger.recordOutcome(operation.id, deps.workerId, { state: "SUCCEEDED", providerReference: order.orderId }, deps.clock());
  if (!quote || !orderMatchesQuote(order, quote)) {
    await emit(deps, operation.checkoutIntentId, { type: "ORDER_DETAILS_MISMATCH", actor: source, observationId });
    return;
  }
  await emit(deps, operation.checkoutIntentId, {
    type: "ORDER_CREATED",
    actor: source,
    observationId,
    operationId: operation.id,
    providerOrderId: order.orderId,
  });
}

/** Steps 4-5 for an already-claimed order-create operation. */
export async function sendOrderCreate(deps: PaymentDeps, operation: PaymentOperation): Promise<Result<PaymentState, PaymentFlowFailure>> {
  const intentId = operation.checkoutIntentId;
  const intent = await deps.store.findIntent(intentId);
  const quote = intent ? await loadQuote(deps, intent) : null;
  if (!quote) return err("INTENT_NOT_FOUND");

  const result = await callProvider(() =>
    deps.provider.createOrder({
      requestId: operation.providerRequestId,
      amountCents: quote.totalCents,
      currency: quote.currency,
      merchantId: quote.merchantId,
    }),
  );

  if (result.kind === "NO_RESPONSE") {
    await deps.ledger.recordOutcome(operation.id, deps.workerId, { state: "UNKNOWN" }, deps.clock());
    await emit(deps, intentId, { type: "ORDER_CREATE_OUTCOME_UNKNOWN", actor: "operation_worker", operationId: operation.id });
  } else if (result.kind === "REJECTED") {
    const observationId = await observe(deps, operation, "provider_response", "ORDER", { observedStatus: `REJECTED:${result.code}` });
    await deps.ledger.recordOutcome(operation.id, deps.workerId, { state: "REJECTED" }, deps.clock());
    await emit(deps, intentId, { type: "ORDER_CREATE_REJECTED", actor: "provider_response", observationId, operationId: operation.id });
  } else {
    await settleOrderFound(deps, operation, result.value, "provider_response");
  }
  return finalState(deps, intentId);
}

export async function dispatchOrderCreate(deps: PaymentDeps, intentId: string): Promise<Result<PaymentState, PaymentFlowFailure>> {
  const prepared = await prepareOrderCreate(deps, intentId);
  if (!prepared.ok) return prepared;
  return sendOrderCreate(deps, prepared.value);
}

// --- Buyer approval -------------------------------------------------------

/** A browser coming back from the provider only triggers a server-side check. */
export async function recordBuyerReturn(deps: PaymentDeps, sessionId: string, intentId: string): Promise<Result<PaymentState, PaymentFlowFailure>> {
  const intent = await deps.store.findIntentForSession(sessionId, intentId);
  if (!intent) return err("INTENT_NOT_FOUND");
  const moved = await emit(deps, intentId, { type: "BUYER_RETURNED", actor: "browser_redirect" });
  return moved ? finalState(deps, intentId) : err("INVALID_STATE");
}

/** Reads the order back from the provider and only then treats approval as verified. */
export async function verifyApproval(deps: PaymentDeps, intentId: string): Promise<Result<PaymentState, PaymentFlowFailure>> {
  const intent = await deps.store.findIntent(intentId);
  if (!intent) return err("INTENT_NOT_FOUND");
  const { state, context } = intent.snapshot;
  if ((state !== "AWAITING_APPROVAL" && state !== "APPROVAL_CHECK_PENDING") || !context.providerOrderId) return err("INVALID_STATE");
  const providerOrderId = context.providerOrderId;
  const quote = await loadQuote(deps, intent);

  const readback = await readProvider(() => deps.provider.getOrder(providerOrderId));
  if (readback.kind === "UNAVAILABLE") return ok(state);

  const reference = { id: context.orderCreateOperationId, checkoutIntentId: intentId } as { id: null; checkoutIntentId: string };
  if (readback.kind === "NOT_FOUND") {
    await observe(deps, reference, "provider_readback", "ORDER", { providerOrderId, observedStatus: "NOT_FOUND" });
    // The provider no longer knows an order we recorded: contradictory, so a person must look.
    if (state === "APPROVAL_CHECK_PENDING") {
      await emit(deps, intentId, { type: "ESCALATED_TO_MANUAL_REVIEW", actor: "reconciler", reason: "PROVIDER_ORDER_MISSING" });
    }
    return finalState(deps, intentId);
  }

  const order = readback.value;
  const observationId = await observe(deps, reference, "provider_readback", "ORDER", { providerOrderId, observedStatus: order.status });
  if (!quote || !orderMatchesQuote(order, quote)) {
    await emit(deps, intentId, { type: "ORDER_DETAILS_MISMATCH", actor: "provider_readback", observationId });
  } else if (order.status === "APPROVED") {
    await emit(deps, intentId, { type: "APPROVAL_VERIFIED", actor: "provider_readback", observationId, providerOrderId: order.orderId });
  } else if (state === "APPROVAL_CHECK_PENDING") {
    await emit(deps, intentId, { type: "APPROVAL_NOT_FOUND", actor: "provider_readback", observationId });
  }
  return finalState(deps, intentId);
}

// --- Capture --------------------------------------------------------------

export async function prepareCapture(deps: PaymentDeps, intentId: string): Promise<Result<PaymentOperation, PaymentFlowFailure>> {
  return deps.store.transaction(async () => {
    const intent = await deps.store.findIntent(intentId);
    if (!intent) return err("INTENT_NOT_FOUND");
    const { state, context } = intent.snapshot;
    if (state !== "APPROVED_VERIFIED" || !context.providerOrderId) return err("INVALID_STATE");

    const now = deps.clock();
    const existing = await deps.ledger.listForIntent(intentId, "CAPTURE");
    // Reuse the live logical capture if there is one; only a provider-confirmed decline permits a new one.
    const live = existing.find((operation) => operation.state !== "DECLINED" && operation.state !== "REJECTED");
    const ensured = await deps.ledger.ensureOperation({
      checkoutIntentId: intentId,
      type: "CAPTURE",
      sequence: live ? live.sequence : existing.length + 1,
      payloadDigest: sha256Hex(canonicalJson({ providerOrderId: context.providerOrderId, quoteId: context.quoteId })),
      now,
    });
    if (!ensured.ok) return err("PAYLOAD_MISMATCH");
    const claimed = await deps.ledger.claimForDispatch(ensured.operation.id, deps.workerId, now, deps.leaseMs);
    if (!claimed) return err("OPERATION_NOT_CLAIMABLE");
    const moved = await emit(deps, intentId, { type: "CAPTURE_DISPATCHED", actor: "operation_worker", operationId: claimed.id });
    return moved ? ok(claimed) : err("STATE_CONFLICT");
  });
}

export type CaptureSettlement = "SETTLED" | "REJECTED_EVIDENCE" | "NOT_LEASE_HOLDER" | "NO_AUTHORIZED_QUOTE";

/**
 * The only path by which capture evidence changes payment state. Used for
 * immediate provider responses and for reconciliation readbacks alike.
 *
 * `raw` is untrusted. It is validated against the immutable authorized quote
 * and the recorded provider order before anything is derived from it. Evidence
 * that fails validation is recorded as a conflicting observation, audited, and
 * sends the checkout to MANUAL_REVIEW; the operation is marked CONFLICT so no
 * worker will retry or resend it.
 *
 * Only the worker holding the operation lease can settle, and an operation can
 * be settled once: a repeated or concurrent attempt changes nothing.
 */
export async function settleCaptureEvidence(
  deps: PaymentDeps,
  operation: PaymentOperation,
  raw: unknown,
  source: "provider_response" | "provider_readback",
): Promise<CaptureSettlement> {
  const intentId = operation.checkoutIntentId;
  const intent = await deps.store.findIntent(intentId);
  const quote = intent ? await loadQuote(deps, intent) : null;
  const providerOrderId = intent?.snapshot.context.providerOrderId ?? null;
  const now = deps.clock();

  const verdict =
    intent && quote && providerOrderId
      ? validateCaptureEvidence(raw, {
          providerRequestId: operation.providerRequestId,
          providerOrderId,
          totalCents: quote.totalCents,
          currency: quote.currency,
          merchantId: quote.merchantId,
          knownCaptureId: intent.snapshot.context.providerCaptureId,
        })
      : null;

  if (!verdict || !verdict.ok) {
    const reason = verdict ? verdict.error : "NO_AUTHORIZED_QUOTE";
    // Claim the settlement first: if this worker no longer holds the lease, someone else has dealt with it.
    if (!(await deps.ledger.recordOutcome(operation.id, deps.workerId, { state: "CONFLICT" }, now))) return "NOT_LEASE_HOLDER";
    const reported = describeRejectedEvidence(raw);
    const observationId = await observe(deps, operation, source, "CAPTURE", {
      providerOrderId: reported.providerOrderId,
      providerCaptureId: reported.providerCaptureId,
      observedStatus: reported.reportedStatus,
      conflict: reason,
      reportedAmountCents: reported.reportedAmountCents,
      reportedCurrency: reported.reportedCurrency,
    });
    await emit(deps, intentId, { type: "CAPTURE_EVIDENCE_MISMATCH", actor: source, observationId, operationId: operation.id, reason });
    await deps.audit.append({
      eventId: deps.ids("event"),
      eventType: "CAPTURE_EVIDENCE_REJECTED",
      occurredAt: now.toISOString(),
      actor: source,
      sessionId: intent?.sessionId ?? null,
      checkoutIntentId: intentId,
      operationId: operation.id,
      detail: { reason, source, reportedStatus: reported.reportedStatus, observationId },
    });
    return verdict ? "REJECTED_EVIDENCE" : "NO_AUTHORIZED_QUOTE";
  }

  const capture = verdict.value;
  const outcome =
    capture.status === "COMPLETED"
      ? ({ state: "SUCCEEDED", providerReference: capture.captureId } as const)
      : capture.status === "PENDING"
        ? ({ state: "PENDING_PROVIDER", providerReference: capture.captureId } as const)
        : ({ state: "DECLINED" } as const);
  if (!(await deps.ledger.recordOutcome(operation.id, deps.workerId, outcome, now))) return "NOT_LEASE_HOLDER";

  const observationId = await observe(deps, operation, source, "CAPTURE", {
    providerOrderId: capture.orderId,
    providerCaptureId: capture.captureId,
    observedStatus: capture.status,
  });
  const common = { actor: source, observationId, operationId: operation.id } as const;
  if (capture.status === "COMPLETED") {
    await emit(deps, intentId, { type: "CAPTURE_COMPLETED", ...common, providerCaptureId: capture.captureId });
  } else if (capture.status === "PENDING") {
    // No-op if the intent is already CAPTURE_PENDING_PROVIDER: pending is never promoted without evidence.
    await emit(deps, intentId, { type: "CAPTURE_PENDING", ...common, providerCaptureId: capture.captureId });
  } else {
    await emit(deps, intentId, { type: "CAPTURE_DECLINED", ...common });
  }
  return "SETTLED";
}

export async function sendCapture(deps: PaymentDeps, operation: PaymentOperation): Promise<Result<PaymentState, PaymentFlowFailure>> {
  const intentId = operation.checkoutIntentId;
  const intent = await deps.store.findIntent(intentId);
  const providerOrderId = intent?.snapshot.context.providerOrderId;
  if (!providerOrderId) return err("INTENT_NOT_FOUND");

  const result = await callProvider(() => deps.provider.captureOrder({ requestId: operation.providerRequestId, orderId: providerOrderId }));

  if (result.kind === "NO_RESPONSE") {
    await deps.ledger.recordOutcome(operation.id, deps.workerId, { state: "UNKNOWN" }, deps.clock());
    await emit(deps, intentId, { type: "CAPTURE_OUTCOME_UNKNOWN", actor: "operation_worker", operationId: operation.id });
  } else if (result.kind === "REJECTED") {
    // An explicit rejection is provider evidence that no capture was made.
    const observationId = await observe(deps, operation, "provider_response", "CAPTURE", { providerOrderId, observedStatus: `REJECTED:${result.code}` });
    await deps.ledger.recordOutcome(operation.id, deps.workerId, { state: "REJECTED" }, deps.clock());
    await emit(deps, intentId, { type: "CAPTURE_DECLINED", actor: "provider_response", observationId, operationId: operation.id });
  } else {
    await settleCaptureEvidence(deps, operation, result.value, "provider_response");
  }
  return finalState(deps, intentId);
}

export async function dispatchCapture(deps: PaymentDeps, intentId: string): Promise<Result<PaymentState, PaymentFlowFailure>> {
  const prepared = await prepareCapture(deps, intentId);
  if (!prepared.ok) return prepared;
  return sendCapture(deps, prepared.value);
}

// --- Recovery -------------------------------------------------------------

/**
 * Resolves an operation whose outcome is unknown, pending at the provider, or
 * abandoned by a crashed worker. It always reads back from the provider first
 * and only resends (same operation, same request ID) when the provider reports
 * no trace of the request.
 */
export async function reconcileOperation(deps: PaymentDeps, operationId: string): Promise<Result<PaymentState, PaymentFlowFailure>> {
  const before = await deps.ledger.find(operationId);
  if (!before) return err("OPERATION_NOT_FOUND");
  const claimed = await deps.ledger.claimForRecovery(operationId, deps.workerId, deps.clock(), deps.leaseMs);
  if (!claimed) return err("OPERATION_NOT_CLAIMABLE");

  const intentId = claimed.checkoutIntentId;
  const isOrder = claimed.type === "ORDER_CREATE";

  // A worker died mid-dispatch: the local state must say "unknown" before anything else happens.
  const inFlight: PaymentState = isOrder ? "ORDER_CREATE_IN_FLIGHT" : "CAPTURE_IN_FLIGHT";
  if ((await currentState(deps, intentId)) === inFlight) {
    await emit(deps, intentId, {
      type: isOrder ? "ORDER_CREATE_OUTCOME_UNKNOWN" : "CAPTURE_OUTCOME_UNKNOWN",
      actor: "reconciler",
      operationId,
    });
  }

  const readback: ProviderReadback<ProviderOrder | ProviderCapture> = await readProvider<ProviderOrder | ProviderCapture>(() =>
    isOrder ? deps.provider.getOrderByRequestId(claimed.providerRequestId) : deps.provider.getCaptureByRequestId(claimed.providerRequestId),
  );
  const keepAs = (): Promise<PaymentOperation | null> =>
    deps.ledger.recordOutcome(
      operationId,
      deps.workerId,
      claimed.state === "PENDING_PROVIDER" && claimed.providerReference
        ? { state: "PENDING_PROVIDER", providerReference: claimed.providerReference }
        : { state: "UNKNOWN" },
      deps.clock(),
    );

  if (readback.kind === "UNAVAILABLE") {
    await keepAs();
    const overdue = deps.clock().getTime() - Date.parse(claimed.createdAt) >= PROPOSED_ESCALATION_AFTER_MS;
    if (overdue) {
      await emit(deps, intentId, { type: "ESCALATED_TO_MANUAL_REVIEW", actor: "reconciler", reason: "UNRESOLVED_PAST_TARGET" });
    } else {
      await emit(deps, intentId, { type: "READBACK_INCONCLUSIVE", actor: "reconciler" });
    }
    return finalState(deps, intentId);
  }

  if (readback.kind === "NOT_FOUND") {
    const observationId = await observe(deps, claimed, "provider_readback", isOrder ? "ORDER" : "CAPTURE", { observedStatus: "NOT_FOUND" });
    if (claimed.state === "PENDING_PROVIDER") {
      // The provider previously reported this capture; losing it is contradictory evidence.
      await keepAs();
      await emit(deps, intentId, { type: "ESCALATED_TO_MANUAL_REVIEW", actor: "reconciler", reason: "PENDING_CAPTURE_MISSING" });
      return finalState(deps, intentId);
    }
    await deps.ledger.recordOutcome(operationId, deps.workerId, { state: "READBACK_CLEARED" }, deps.clock());
    const resend = await deps.ledger.claimForDispatch(operationId, deps.workerId, deps.clock(), deps.leaseMs);
    if (!resend) return err("OPERATION_NOT_CLAIMABLE");
    const moved = await emit(deps, intentId, {
      type: isOrder ? "ORDER_CREATE_REDISPATCHED" : "CAPTURE_REDISPATCHED",
      actor: "operation_worker",
      operationId,
      readbackObservationId: observationId,
    });
    if (!moved) return err("STATE_CONFLICT");
    return isOrder ? sendOrderCreate(deps, resend) : sendCapture(deps, resend);
  }

  if (isOrder) await settleOrderFound(deps, claimed, readback.value as ProviderOrder, "provider_readback");
  else await settleCaptureEvidence(deps, claimed, readback.value, "provider_readback");
  return finalState(deps, intentId);
}

/** Looks for refunds, reversals or disputes on a completed capture. Observation only: nothing is executed. */
export async function observeCaptureAftermath(deps: PaymentDeps, intentId: string): Promise<Result<PaymentState, PaymentFlowFailure>> {
  const intent = await deps.store.findIntent(intentId);
  if (!intent) return err("INTENT_NOT_FOUND");
  const { state, context } = intent.snapshot;
  const operations = await deps.ledger.listForIntent(intentId, "CAPTURE");
  const operation = operations.find((candidate) => candidate.id === context.captureOperationId);
  if (!operation || !["CAPTURED_VERIFIED", "PARTIALLY_REFUNDED_OBSERVED", "REFUNDED_OBSERVED"].includes(state)) return err("INVALID_STATE");

  const readback = await readProvider(() => deps.provider.getCaptureByRequestId(operation.providerRequestId));
  if (readback.kind !== "FOUND") return ok(state);
  const quote = await loadQuote(deps, intent);
  const verdict =
    quote && context.providerOrderId
      ? validateCaptureEvidence(readback.value, {
          providerRequestId: operation.providerRequestId,
          providerOrderId: context.providerOrderId,
          totalCents: quote.totalCents,
          currency: quote.currency,
          merchantId: quote.merchantId,
          knownCaptureId: context.providerCaptureId,
        })
      : null;
  if (!verdict || !verdict.ok) {
    // Evidence that does not match this checkout is recorded but never acted on.
    const reported = describeRejectedEvidence(readback.value);
    await observe(deps, operation, "provider_readback", "CAPTURE", {
      providerOrderId: reported.providerOrderId,
      providerCaptureId: reported.providerCaptureId,
      observedStatus: reported.reportedStatus,
      conflict: verdict ? verdict.error : "NO_AUTHORIZED_QUOTE",
      reportedAmountCents: reported.reportedAmountCents,
      reportedCurrency: reported.reportedCurrency,
    });
    return ok(state);
  }
  const capture = verdict.value;
  const refundStatus = capture.refundedCents >= capture.amountCents ? "FULL" : capture.refundedCents > 0 ? "PARTIAL" : "NONE";
  const observationId = await observe(deps, operation, "provider_readback", "CAPTURE", {
    providerOrderId: capture.orderId,
    providerCaptureId: capture.captureId,
    observedStatus: `${capture.status};refund=${refundStatus};reversedOrDisputed=${capture.reversedOrDisputed}`,
  });

  if (refundStatus === "FULL" && state !== "REFUNDED_OBSERVED") {
    await emit(deps, intentId, { type: "REFUND_OBSERVED", actor: "provider_readback", observationId, extent: "FULL" });
  } else if (refundStatus === "PARTIAL" && state === "CAPTURED_VERIFIED") {
    await emit(deps, intentId, { type: "REFUND_OBSERVED", actor: "provider_readback", observationId, extent: "PARTIAL" });
  }
  if (capture.reversedOrDisputed) {
    await emit(deps, intentId, { type: "REVERSAL_OR_DISPUTE_OBSERVED", actor: "provider_readback", observationId });
  }
  return finalState(deps, intentId);
}

/** Local cancellation. Refused once a capture may have been dispatched. */
export async function cancelCheckout(
  deps: Pick<PaymentDeps, "store" | "clock" | "ids">,
  sessionId: string,
  intentId: string,
): Promise<Result<PaymentState, "INTENT_NOT_FOUND" | "CAPTURE_ALREADY_DISPATCHED" | "NOT_CANCELABLE">> {
  const intent = await deps.store.findIntentForSession(sessionId, intentId);
  if (!intent) return err("INTENT_NOT_FOUND");
  const applied = await applyPaymentEvent(deps.store, intentId, {
    type: "SHOPPER_CANCELED",
    eventId: deps.ids("event"),
    occurredAt: deps.clock().toISOString(),
    actor: "shopper",
  });
  if (applied.ok) return ok(applied.value.state);
  return err("code" in applied.error && applied.error.code === "CAPTURE_ALREADY_DISPATCHED" ? "CAPTURE_ALREADY_DISPATCHED" : "NOT_CANCELABLE");
}
