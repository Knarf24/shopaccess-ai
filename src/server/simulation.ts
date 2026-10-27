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
/** Presentation only. Protocol state and action identifiers remain unchanged. */
const ES_STEPS: Record<SimulationStep, string> = {
 create_order: "Simular la creación del pedido",
 create_order_lost_response: "Simular la creación del pedido con respuesta perdida",
 buyer_approve: "Simular la aprobación del comprador y su regreso",
 buyer_return_without_approval: "Simular el regreso del comprador sin aprobar",
 capture: "Simular el cobro completado",
 capture_pending: "Simular el cobro pendiente en el proveedor",
 capture_declined: "Simular el cobro rechazado",
 capture_lost_response: "Simular el cobro con respuesta perdida",
 reconcile: "Consultar el resultado con el proveedor simulado",
 settle_pending: "Simular que el proveedor completa el cobro pendiente",
 external_refund: "Simular un reembolso externo, hasta el importe cobrado restante, y consultar el resultado",
 cancel: "Cancelar esta compra",
};
const ES_STATES: Record<PaymentState, string> = {
 DRAFT: "No hay una cotización vigente. No se ha confirmado nada.",
 QUOTED: "Se ha emitido una cotización y se espera su confirmación.",
 USER_CONFIRMED: "Confirmó el resumen de compra. Todavía no se ha simulado ningún paso de pago.",
 ORDER_CREATE_IN_FLIGHT: "Se está solicitando un pedido simulado. Todavía no se conoce el resultado.",
 ORDER_CREATE_UNKNOWN: "La solicitud de pedido simulado no recibió respuesta. No se sabe si existe un pedido; no se considera un fallo confirmado.",
 AWAITING_APPROVAL: "Existe un pedido simulado y se espera la aprobación del comprador.",
 APPROVAL_CHECK_PENDING: "El comprador regresó de la página de aprobación simulada. El regreso no demuestra aprobación; se consulta al proveedor simulado.",
 APPROVED_VERIFIED: "El proveedor simulado confirmó la aprobación de este pedido exacto. Todavía no se ha cobrado nada.",
 CAPTURE_IN_FLIGHT: "Se está solicitando un cobro simulado. Todavía no se conoce el resultado.",
 CAPTURE_UNKNOWN: "La solicitud de cobro simulado no recibió respuesta. No se sabe si se realizó el cobro; no se considera un fallo confirmado.",
 CAPTURE_PENDING_PROVIDER: "El proveedor simulado aceptó el cobro, pero no lo ha completado. Esto no es un pago completado.",
 CAPTURED_VERIFIED: "El proveedor simulado confirmó que el cobro se completó. No se movió dinero real.",
 DECLINED_RETRYABLE: "El proveedor simulado rechazó el cobro. No se cobró nada; el comprador puede aprobar de nuevo.",
 RECONCILIATION_REQUIRED: "El resultado es desconocido y no se pudo consultar al proveedor simulado. Debe comprobarse antes de continuar.",
 SUPERSEDED: "Esta compra fue reemplazada por otra más reciente. Ya no puede cobrarse.",
 CANCELED_LOCAL: "Esta compra se canceló antes de solicitar un cobro. Ya no puede cobrarse.",
 EXPIRED: "Esta compra venció antes de solicitar un cobro.",
 FAILED_TERMINAL: "El proveedor simulado rechazó expresamente la solicitud de pedido. No existe un pedido.",
 MANUAL_REVIEW: "Los registros del proveedor simulado no coinciden con esta compra o no se pudo resolver el resultado. Una persona debe revisarlo.",
 PARTIALLY_REFUNDED_OBSERVED: "Se observó en el proveedor simulado un reembolso parcial realizado fuera de esta aplicación.",
 REFUNDED_OBSERVED: "Se observó en el proveedor simulado un reembolso total realizado fuera de esta aplicación.",
 REVERSED_OR_DISPUTED_OBSERVED: "Se observó en el proveedor simulado una reversión o una disputa.",
};
export function paymentPreviewCopy(language: "en" | "es" = "en") {
 const es=language==="es";
 return {
  heading: es ? "Vista previa de pago local" : "Local payment preview",
  disclosure: es ? "Para evaluación: no se cobrará dinero ni se enviarán productos. Esta vista previa local no contacta con PayPal." : "For evaluation: no money will be charged and no products will ship. This local preview does not contact PayPal.",
  status: es ? "Estado del pago: " : "Payment status: ",
  controls: es ? "Controles de la simulación de pago" : "Payment preview controls",
  noSteps: es ? "No hay más pasos de simulación disponibles en este estado." : "No further simulation steps are available from this state.",
  history: es ? "Historial de estados: cambios y eventos que los causaron" : "State history (each change and the event that caused it)",
  event: es ? "Evento" : "Event", actor: es ? "Causado por" : "Caused by", change: es ? "Cambio" : "Change",
  observations: es ? "Lo que informó el proveedor simulado, separado del estado local" : "What the simulated provider reported (kept separate from local state)",
  source: es ? "Fuente" : "Source", subject: es ? "Acerca de" : "About", reportedStatus: es ? "Estado informado" : "Reported status",
  operation: es ? "Operación" : "Operation", attempts: es ? "intentos" : "attempts", requestId: es ? "ID de solicitud" : "request ID",
  steps: es ? ES_STEPS : STEP_LABELS, states: es ? ES_STATES : STATE_DESCRIPTIONS,
 };
}
