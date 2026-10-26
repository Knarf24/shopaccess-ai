import type { PaymentState } from "@/lib/payment/state-machine";

/** Controls offered on the simulated payment page. Each one drives the local mock provider only. */
export const SIMULATION_STEPS = [
  "create_order",
  "create_order_lost_response",
  "buyer_approve",
  "buyer_return_without_approval",
  "capture",
  "capture_pending",
  "capture_declined",
  "capture_lost_response",
  "reconcile",
  "settle_pending",
  "external_refund",
  "cancel",
] as const;
export type SimulationStep = (typeof SIMULATION_STEPS)[number];

export const STEP_LABELS: Record<SimulationStep, string> = {
  create_order: "Simulate creating the order",
  create_order_lost_response: "Simulate creating the order, but lose the response",
  buyer_approve: "Simulate the buyer approving and returning",
  buyer_return_without_approval: "Simulate the buyer returning without approving",
  capture: "Simulate capture: completed",
  capture_pending: "Simulate capture: pending at provider",
  capture_declined: "Simulate capture: declined",
  capture_lost_response: "Simulate capture, but lose the response",
  reconcile: "Check with the simulated provider (reconcile)",
  settle_pending: "Simulate the provider completing the pending capture",
  external_refund: "Simulate a refund made outside this app (limited to the remaining captured amount), then observe it",
  cancel: "Cancel this checkout",
};

const CAPTURES: SimulationStep[] = ["capture", "capture_pending", "capture_declined", "capture_lost_response"];

const STEPS_BY_STATE: Partial<Record<PaymentState, SimulationStep[]>> = {
  DRAFT: ["cancel"],
  QUOTED: ["cancel"],
  USER_CONFIRMED: ["create_order", "create_order_lost_response", "cancel"],
  ORDER_CREATE_UNKNOWN: ["reconcile"],
  AWAITING_APPROVAL: ["buyer_approve", "buyer_return_without_approval", "cancel"],
  APPROVAL_CHECK_PENDING: ["buyer_approve", "cancel"],
  APPROVED_VERIFIED: [...CAPTURES, "cancel"],
  CAPTURE_UNKNOWN: ["reconcile"],
  CAPTURE_PENDING_PROVIDER: ["settle_pending", "reconcile"],
  RECONCILIATION_REQUIRED: ["reconcile"],
  DECLINED_RETRYABLE: ["buyer_approve", "cancel"],
  CAPTURED_VERIFIED: ["external_refund"],
  PARTIALLY_REFUNDED_OBSERVED: ["external_refund"],
};

export function availableSteps(state: PaymentState): readonly SimulationStep[] {
  return STEPS_BY_STATE[state] ?? [];
}

/** Plain-language meaning of each local workflow state, always worded as a simulation. */
export const STATE_DESCRIPTIONS: Record<PaymentState, string> = {
  DRAFT: "No current quote. Nothing has been confirmed.",
  QUOTED: "A quote has been issued and is waiting for your confirmation.",
  USER_CONFIRMED: "You confirmed the purchase summary. No payment step has been simulated yet.",
  ORDER_CREATE_IN_FLIGHT: "A simulated order request is in progress. Its outcome is not known yet.",
  ORDER_CREATE_UNKNOWN: "The simulated order request got no response. It is not known whether an order exists; this is not treated as a failure.",
  AWAITING_APPROVAL: "A simulated order exists and is waiting for the buyer to approve it.",
  APPROVAL_CHECK_PENDING: "The buyer came back from the simulated approval page. That alone proves nothing; approval is being checked with the simulated provider.",
  APPROVED_VERIFIED: "The simulated provider confirmed the buyer approved this exact order. Nothing has been captured.",
  CAPTURE_IN_FLIGHT: "A simulated capture request is in progress. Its outcome is not known yet.",
  CAPTURE_UNKNOWN: "The simulated capture request got no response. It is not known whether payment was captured; this is not treated as a failure.",
  CAPTURE_PENDING_PROVIDER: "The simulated provider accepted the capture but has not completed it. This is not a completed payment.",
  CAPTURED_VERIFIED: "The simulated provider confirmed the capture completed. No real money moved.",
  DECLINED_RETRYABLE: "The simulated provider declined the capture. Nothing was captured; the buyer can approve again.",
  RECONCILIATION_REQUIRED: "The outcome is unknown and the simulated provider could not be checked. It must be reconciled before anything else happens.",
  SUPERSEDED: "This checkout was replaced by a newer one. It can never be captured.",
  CANCELED_LOCAL: "This checkout was canceled here before any capture was sent. It can never be captured.",
  EXPIRED: "This checkout expired before any capture was sent.",
  FAILED_TERMINAL: "The simulated provider explicitly rejected the order request. No order exists.",
  MANUAL_REVIEW: "The simulated provider's records do not match this checkout, or the outcome could not be resolved. A person must review it.",
  PARTIALLY_REFUNDED_OBSERVED: "A partial refund made outside this app was observed at the simulated provider.",
  REFUNDED_OBSERVED: "A full refund made outside this app was observed at the simulated provider.",
  REVERSED_OR_DISPUTED_OBSERVED: "A reversal or dispute was observed at the simulated provider.",
};
