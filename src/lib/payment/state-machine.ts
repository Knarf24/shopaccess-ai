import { err, ok, type Result } from "../shared/result";

/**
 * Pure payment-state reducer. No I/O, no clock, no randomness: the next state
 * is a function of the current snapshot and one attributable event.
 *
 * `PaymentState` is LOCAL workflow state. What the provider actually reported
 * is recorded separately as provider observations; provider-sourced events must
 * cite the observation they are based on.
 */
export const PAYMENT_STATES = [
  "DRAFT",
  "QUOTED",
  "USER_CONFIRMED",
  "ORDER_CREATE_IN_FLIGHT",
  "ORDER_CREATE_UNKNOWN",
  "AWAITING_APPROVAL",
  "APPROVAL_CHECK_PENDING",
  "APPROVED_VERIFIED",
  "CAPTURE_IN_FLIGHT",
  "CAPTURE_UNKNOWN",
  "CAPTURE_PENDING_PROVIDER",
  "CAPTURED_VERIFIED",
  "DECLINED_RETRYABLE",
  "RECONCILIATION_REQUIRED",
  "SUPERSEDED",
  "CANCELED_LOCAL",
  "EXPIRED",
  "FAILED_TERMINAL",
  "MANUAL_REVIEW",
  "PARTIALLY_REFUNDED_OBSERVED",
  "REFUNDED_OBSERVED",
  "REVERSED_OR_DISPUTED_OBSERVED",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const PAYMENT_ACTORS = [
  "shopper",
  "server",
  "operation_worker",
  "browser_redirect",
  "provider_response",
  "provider_readback",
  "provider_observation",
  "reconciler",
  "timer",
] as const;
export type PaymentActor = (typeof PAYMENT_ACTORS)[number];

/** Actors whose events assert something the provider reported. */
export const PROVIDER_EVIDENCE_ACTORS: readonly PaymentActor[] = ["provider_response", "provider_readback", "provider_observation"];

export interface PaymentContext {
  readonly quoteId: string | null;
  readonly confirmationId: string | null;
  readonly orderCreateOperationId: string | null;
  readonly captureOperationId: string | null;
  /** True from the moment a capture request may have left the building. */
  readonly captureDispatched: boolean;
  readonly providerOrderId: string | null;
  readonly providerCaptureId: string | null;
}

export interface PaymentSnapshot {
  readonly state: PaymentState;
  readonly version: number;
  readonly context: PaymentContext;
}

export const INITIAL_PAYMENT_SNAPSHOT: PaymentSnapshot = Object.freeze({
  state: "DRAFT",
  version: 1,
  context: Object.freeze({
    quoteId: null,
    confirmationId: null,
    orderCreateOperationId: null,
    captureOperationId: null,
    captureDispatched: false,
    providerOrderId: null,
    providerCaptureId: null,
  }),
});

interface EventBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly actor: PaymentActor;
  /** Provider observation this event is based on. Required for provider-evidence actors. */
  readonly observationId?: string;
}

type EventPayloads = {
  QUOTE_ISSUED: { quoteId: string };
  QUOTE_INVALIDATED: object;
  SHOPPER_CONFIRMED: { quoteId: string; confirmationId: string };
  ORDER_CREATE_DISPATCHED: { operationId: string };
  ORDER_CREATE_REDISPATCHED: { operationId: string; readbackObservationId: string };
  ORDER_CREATED: { operationId: string; providerOrderId: string };
  ORDER_CREATE_REJECTED: { operationId: string };
  ORDER_CREATE_OUTCOME_UNKNOWN: { operationId: string };
  BUYER_RETURNED: object;
  APPROVAL_VERIFIED: { providerOrderId: string };
  APPROVAL_NOT_FOUND: object;
  ORDER_DETAILS_MISMATCH: object;
  CAPTURE_DISPATCHED: { operationId: string };
  CAPTURE_REDISPATCHED: { operationId: string; readbackObservationId: string };
  CAPTURE_COMPLETED: { operationId: string; providerCaptureId: string };
  CAPTURE_PENDING: { operationId: string; providerCaptureId: string };
  CAPTURE_DECLINED: { operationId: string };
  CAPTURE_OUTCOME_UNKNOWN: { operationId: string };
  CAPTURE_EVIDENCE_MISMATCH: { operationId: string; reason: string };
  READBACK_INCONCLUSIVE: object;
  ESCALATED_TO_MANUAL_REVIEW: { reason: string };
  REFUND_OBSERVED: { extent: "PARTIAL" | "FULL" };
  REVERSAL_OR_DISPUTE_OBSERVED: object;
  SHOPPER_CANCELED: object;
  SUPERSEDED: { byCheckoutIntentId: string };
  EXPIRED: object;
};

export type PaymentEventType = keyof EventPayloads;
export type PaymentEventOf<T extends PaymentEventType> = EventBase & { readonly type: T } & Readonly<EventPayloads[T]>;
export type PaymentEvent = { [T in PaymentEventType]: PaymentEventOf<T> }[PaymentEventType];

export const PAYMENT_EVENT_TYPES = [
  "QUOTE_ISSUED",
  "QUOTE_INVALIDATED",
  "SHOPPER_CONFIRMED",
  "ORDER_CREATE_DISPATCHED",
  "ORDER_CREATE_REDISPATCHED",
  "ORDER_CREATED",
  "ORDER_CREATE_REJECTED",
  "ORDER_CREATE_OUTCOME_UNKNOWN",
  "BUYER_RETURNED",
  "APPROVAL_VERIFIED",
  "APPROVAL_NOT_FOUND",
  "ORDER_DETAILS_MISMATCH",
  "CAPTURE_DISPATCHED",
  "CAPTURE_REDISPATCHED",
  "CAPTURE_COMPLETED",
  "CAPTURE_PENDING",
  "CAPTURE_DECLINED",
  "CAPTURE_OUTCOME_UNKNOWN",
  "CAPTURE_EVIDENCE_MISMATCH",
  "READBACK_INCONCLUSIVE",
  "ESCALATED_TO_MANUAL_REVIEW",
  "REFUND_OBSERVED",
  "REVERSAL_OR_DISPUTE_OBSERVED",
  "SHOPPER_CANCELED",
  "SUPERSEDED",
  "EXPIRED",
] as const satisfies readonly PaymentEventType[];

export interface TransitionRule<T extends PaymentEventType = PaymentEventType> {
  readonly actors: readonly PaymentActor[];
  readonly to: PaymentState | ((context: PaymentContext, event: PaymentEventOf<T>) => PaymentState);
  /** Returns a rejection code, or null when the transition is allowed. */
  readonly guard?: (context: PaymentContext, event: PaymentEventOf<T>) => string | null;
}

type TransitionTable = { [S in PaymentState]: { [T in PaymentEventType]?: TransitionRule<T> } };

const table = Object.fromEntries(PAYMENT_STATES.map((state) => [state, {}])) as TransitionTable;

function on<T extends PaymentEventType>(from: PaymentState | readonly PaymentState[], type: T, rule: TransitionRule<T>): void {
  for (const state of typeof from === "string" ? [from] : from) {
    if (table[state][type]) throw new Error(`Duplicate transition rule: ${state} + ${type}`);
    (table[state] as Record<string, unknown>)[type] = rule;
  }
}

const sameOrderOp = (context: PaymentContext, event: { operationId: string }) =>
  context.orderCreateOperationId === event.operationId ? null : "OPERATION_MISMATCH";
const sameCaptureOp = (context: PaymentContext, event: { operationId: string }) =>
  context.captureOperationId === event.operationId ? null : "OPERATION_MISMATCH";
const whileOrderUnresolved = (context: PaymentContext, event: { operationId: string }) =>
  context.captureDispatched ? "CAPTURE_PHASE_ACTIVE" : sameOrderOp(context, event);
const whileCaptureUnresolved = (context: PaymentContext, event: { operationId: string }) =>
  context.captureDispatched ? sameCaptureOp(context, event) : "CAPTURE_NOT_DISPATCHED";

/** States in which nothing can be in motion at the provider on our behalf. */
const STOPPABLE: readonly PaymentState[] = [
  "DRAFT",
  "QUOTED",
  "USER_CONFIRMED",
  "AWAITING_APPROVAL",
  "APPROVAL_CHECK_PENDING",
  "APPROVED_VERIFIED",
  "DECLINED_RETRYABLE",
];

// Quote and consent.
on(["DRAFT", "QUOTED"], "QUOTE_ISSUED", { actors: ["server"], to: "QUOTED" });
on(["QUOTED", "USER_CONFIRMED"], "QUOTE_INVALIDATED", { actors: ["server"], to: "DRAFT" });
on("QUOTED", "SHOPPER_CONFIRMED", {
  actors: ["shopper"],
  to: "USER_CONFIRMED",
  guard: (context, event) => (context.quoteId === event.quoteId ? null : "QUOTE_MISMATCH"),
});

// Order creation.
on("USER_CONFIRMED", "ORDER_CREATE_DISPATCHED", {
  actors: ["operation_worker"],
  to: "ORDER_CREATE_IN_FLIGHT",
  guard: (context, event) => {
    if (context.confirmationId === null) return "NOT_CONFIRMED";
    return context.orderCreateOperationId === null || context.orderCreateOperationId === event.operationId
      ? null
      : "OPERATION_MISMATCH";
  },
});
on("ORDER_CREATE_IN_FLIGHT", "ORDER_CREATED", { actors: ["provider_response"], to: "AWAITING_APPROVAL", guard: sameOrderOp });
on(["ORDER_CREATE_UNKNOWN", "RECONCILIATION_REQUIRED"], "ORDER_CREATED", {
  actors: ["provider_readback"],
  to: "AWAITING_APPROVAL",
  guard: whileOrderUnresolved,
});
// The only path to FAILED_TERMINAL: an explicit provider rejection received in response.
on("ORDER_CREATE_IN_FLIGHT", "ORDER_CREATE_REJECTED", { actors: ["provider_response"], to: "FAILED_TERMINAL", guard: sameOrderOp });
on("ORDER_CREATE_IN_FLIGHT", "ORDER_CREATE_OUTCOME_UNKNOWN", {
  actors: ["operation_worker", "reconciler"],
  to: "ORDER_CREATE_UNKNOWN",
  guard: sameOrderOp,
});
on(["ORDER_CREATE_UNKNOWN", "RECONCILIATION_REQUIRED"], "ORDER_CREATE_REDISPATCHED", {
  actors: ["operation_worker"],
  to: "ORDER_CREATE_IN_FLIGHT",
  guard: (context, event) => (event.readbackObservationId ? whileOrderUnresolved(context, event) : "READBACK_REQUIRED"),
});

// Buyer approval. A browser redirect only ever asks for a check; it proves nothing.
on(["AWAITING_APPROVAL", "DECLINED_RETRYABLE"], "BUYER_RETURNED", { actors: ["browser_redirect"], to: "APPROVAL_CHECK_PENDING" });
on(["AWAITING_APPROVAL", "APPROVAL_CHECK_PENDING"], "APPROVAL_VERIFIED", {
  actors: ["provider_readback"],
  to: "APPROVED_VERIFIED",
  guard: (context, event) =>
    context.providerOrderId !== null && context.providerOrderId === event.providerOrderId ? null : "PROVIDER_ORDER_MISMATCH",
});
on("APPROVAL_CHECK_PENDING", "APPROVAL_NOT_FOUND", { actors: ["provider_readback"], to: "AWAITING_APPROVAL" });
on(["ORDER_CREATE_IN_FLIGHT"], "ORDER_DETAILS_MISMATCH", { actors: ["provider_response"], to: "MANUAL_REVIEW" });
on(
  ["ORDER_CREATE_UNKNOWN", "RECONCILIATION_REQUIRED", "AWAITING_APPROVAL", "APPROVAL_CHECK_PENDING", "APPROVED_VERIFIED"],
  "ORDER_DETAILS_MISMATCH",
  { actors: ["provider_readback"], to: "MANUAL_REVIEW" },
);

// Capture.
on("APPROVED_VERIFIED", "CAPTURE_DISPATCHED", {
  actors: ["operation_worker"],
  to: "CAPTURE_IN_FLIGHT",
  guard: (context, event) =>
    context.captureOperationId === null || context.captureOperationId === event.operationId ? null : "OPERATION_MISMATCH",
});
on("CAPTURE_IN_FLIGHT", "CAPTURE_COMPLETED", { actors: ["provider_response"], to: "CAPTURED_VERIFIED", guard: sameCaptureOp });
on(["CAPTURE_UNKNOWN", "RECONCILIATION_REQUIRED"], "CAPTURE_COMPLETED", {
  actors: ["provider_readback"],
  to: "CAPTURED_VERIFIED",
  guard: whileCaptureUnresolved,
});
on("CAPTURE_PENDING_PROVIDER", "CAPTURE_COMPLETED", {
  actors: ["provider_readback", "provider_observation"],
  to: "CAPTURED_VERIFIED",
  guard: sameCaptureOp,
});
on("CAPTURE_IN_FLIGHT", "CAPTURE_PENDING", { actors: ["provider_response"], to: "CAPTURE_PENDING_PROVIDER", guard: sameCaptureOp });
on(["CAPTURE_UNKNOWN", "RECONCILIATION_REQUIRED"], "CAPTURE_PENDING", {
  actors: ["provider_readback"],
  to: "CAPTURE_PENDING_PROVIDER",
  guard: whileCaptureUnresolved,
});
on("CAPTURE_IN_FLIGHT", "CAPTURE_DECLINED", { actors: ["provider_response"], to: "DECLINED_RETRYABLE", guard: sameCaptureOp });
on(["CAPTURE_UNKNOWN", "RECONCILIATION_REQUIRED"], "CAPTURE_DECLINED", {
  actors: ["provider_readback"],
  to: "DECLINED_RETRYABLE",
  guard: whileCaptureUnresolved,
});
on("CAPTURE_PENDING_PROVIDER", "CAPTURE_DECLINED", {
  actors: ["provider_readback", "provider_observation"],
  to: "DECLINED_RETRYABLE",
  guard: sameCaptureOp,
});
on("CAPTURE_IN_FLIGHT", "CAPTURE_OUTCOME_UNKNOWN", {
  actors: ["operation_worker", "reconciler"],
  to: "CAPTURE_UNKNOWN",
  guard: sameCaptureOp,
});
// Capture evidence that does not match the authorized quote or recorded order is never accepted as
// paid, declined or pending. It stops automation and goes to a person.
on("CAPTURE_IN_FLIGHT", "CAPTURE_EVIDENCE_MISMATCH", { actors: ["provider_response"], to: "MANUAL_REVIEW", guard: sameCaptureOp });
on(["CAPTURE_UNKNOWN", "RECONCILIATION_REQUIRED"], "CAPTURE_EVIDENCE_MISMATCH", {
  actors: ["provider_readback"],
  to: "MANUAL_REVIEW",
  guard: whileCaptureUnresolved,
});
on("CAPTURE_PENDING_PROVIDER", "CAPTURE_EVIDENCE_MISMATCH", { actors: ["provider_readback"], to: "MANUAL_REVIEW", guard: sameCaptureOp });
on(["CAPTURE_UNKNOWN", "RECONCILIATION_REQUIRED"], "CAPTURE_REDISPATCHED", {
  actors: ["operation_worker"],
  to: "CAPTURE_IN_FLIGHT",
  guard: (context, event) => (event.readbackObservationId ? whileCaptureUnresolved(context, event) : "READBACK_REQUIRED"),
});

// Reconciliation.
on(["ORDER_CREATE_UNKNOWN", "CAPTURE_UNKNOWN"], "READBACK_INCONCLUSIVE", { actors: ["reconciler"], to: "RECONCILIATION_REQUIRED" });
on(
  ["ORDER_CREATE_UNKNOWN", "CAPTURE_UNKNOWN", "RECONCILIATION_REQUIRED", "CAPTURE_PENDING_PROVIDER", "APPROVAL_CHECK_PENDING"],
  "ESCALATED_TO_MANUAL_REVIEW",
  { actors: ["reconciler"], to: "MANUAL_REVIEW" },
);

// Post-capture observations. Reported by the provider; never executed from here.
on(["CAPTURED_VERIFIED", "PARTIALLY_REFUNDED_OBSERVED"], "REFUND_OBSERVED", {
  actors: ["provider_readback", "provider_observation"],
  to: (_context, event) => (event.extent === "FULL" ? "REFUNDED_OBSERVED" : "PARTIALLY_REFUNDED_OBSERVED"),
});
on(["CAPTURED_VERIFIED", "PARTIALLY_REFUNDED_OBSERVED", "REFUNDED_OBSERVED"], "REVERSAL_OR_DISPUTE_OBSERVED", {
  actors: ["provider_readback", "provider_observation"],
  to: "REVERSED_OR_DISPUTED_OBSERVED",
});

// Local endings. None of these is reachable once a capture may have been dispatched.
on(STOPPABLE, "SHOPPER_CANCELED", { actors: ["shopper"], to: "CANCELED_LOCAL" });
on(STOPPABLE, "SUPERSEDED", { actors: ["server"], to: "SUPERSEDED" });
on(STOPPABLE, "EXPIRED", { actors: ["timer", "provider_readback"], to: "EXPIRED" });

export const PAYMENT_TRANSITIONS: Readonly<TransitionTable> = table;

function applyContext(context: PaymentContext, event: PaymentEvent): PaymentContext {
  switch (event.type) {
    case "QUOTE_ISSUED":
      return { ...context, quoteId: event.quoteId, confirmationId: null };
    case "QUOTE_INVALIDATED":
      return { ...context, quoteId: null, confirmationId: null };
    case "SHOPPER_CONFIRMED":
      return { ...context, confirmationId: event.confirmationId };
    case "ORDER_CREATE_DISPATCHED":
      return { ...context, orderCreateOperationId: event.operationId };
    case "ORDER_CREATED":
      return { ...context, providerOrderId: event.providerOrderId };
    case "CAPTURE_DISPATCHED":
      return { ...context, captureOperationId: event.operationId, captureDispatched: true };
    case "CAPTURE_COMPLETED":
    case "CAPTURE_PENDING":
      return { ...context, providerCaptureId: event.providerCaptureId };
    case "CAPTURE_DECLINED":
      // The provider has stated this capture did not happen; a later attempt is a new logical operation.
      return { ...context, captureOperationId: null, captureDispatched: false, providerCaptureId: null };
    default:
      return context;
  }
}

/** Audit record proving which authorized event caused a transition. */
export interface TransitionRecord {
  readonly eventId: string;
  readonly eventType: PaymentEventType;
  readonly actor: PaymentActor;
  readonly observationId: string | null;
  readonly occurredAt: string;
  readonly from: PaymentState;
  readonly to: PaymentState;
  readonly fromVersion: number;
  readonly toVersion: number;
}

export interface TransitionRejection {
  readonly code:
    | "EVENT_MALFORMED"
    | "TRANSITION_NOT_ALLOWED"
    | "ACTOR_NOT_AUTHORIZED"
    | "PROVIDER_EVIDENCE_REQUIRED"
    | "CAPTURE_ALREADY_DISPATCHED"
    | "GUARD_REJECTED";
  readonly detail?: string;
  readonly state: PaymentState;
  readonly eventType: string;
}

export interface TransitionSuccess {
  readonly snapshot: PaymentSnapshot;
  readonly record: TransitionRecord;
}

export function transition(snapshot: PaymentSnapshot, event: PaymentEvent): Result<TransitionSuccess, TransitionRejection> {
  const reject = (code: TransitionRejection["code"], detail?: string) =>
    err({ code, detail, state: snapshot.state, eventType: String(event?.type) });

  if (
    !event ||
    typeof event.eventId !== "string" ||
    event.eventId.length === 0 ||
    typeof event.occurredAt !== "string" ||
    Number.isNaN(Date.parse(event.occurredAt)) ||
    !PAYMENT_ACTORS.includes(event.actor)
  ) {
    return reject("EVENT_MALFORMED");
  }

  const rule = PAYMENT_TRANSITIONS[snapshot.state][event.type] as TransitionRule | undefined;
  if (!rule) {
    // Be explicit about why cancellation is refused: we cannot claim to stop a capture already sent.
    if (event.type === "SHOPPER_CANCELED" && snapshot.context.captureDispatched) return reject("CAPTURE_ALREADY_DISPATCHED");
    return reject("TRANSITION_NOT_ALLOWED");
  }
  if (!rule.actors.includes(event.actor)) return reject("ACTOR_NOT_AUTHORIZED");
  if (PROVIDER_EVIDENCE_ACTORS.includes(event.actor) && !event.observationId) return reject("PROVIDER_EVIDENCE_REQUIRED");

  const refusal = rule.guard?.(snapshot.context, event) ?? null;
  if (refusal !== null) return reject("GUARD_REJECTED", refusal);

  const to = typeof rule.to === "function" ? rule.to(snapshot.context, event) : rule.to;
  const next: PaymentSnapshot = Object.freeze({
    state: to,
    version: snapshot.version + 1,
    context: Object.freeze(applyContext(snapshot.context, event)),
  });
  return ok({
    snapshot: next,
    record: {
      eventId: event.eventId,
      eventType: event.type,
      actor: event.actor,
      observationId: event.observationId ?? null,
      occurredAt: event.occurredAt,
      from: snapshot.state,
      to,
      fromVersion: snapshot.version,
      toVersion: next.version,
    },
  });
}

/** Only a verified completed capture counts as paid. Provider-pending is not final. */
export function isCaptureFinal(state: PaymentState): boolean {
  return state === "CAPTURED_VERIFIED";
}

/** States where the true outcome at the provider is not yet known. */
export function isOutcomeUnknown(state: PaymentState): boolean {
  return (
    state === "ORDER_CREATE_IN_FLIGHT" ||
    state === "ORDER_CREATE_UNKNOWN" ||
    state === "CAPTURE_IN_FLIGHT" ||
    state === "CAPTURE_UNKNOWN" ||
    state === "RECONCILIATION_REQUIRED"
  );
}
