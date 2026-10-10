import { describe, expect, it } from "vitest";
import {
  INITIAL_PAYMENT_SNAPSHOT,
  isCaptureFinal,
  isOutcomeUnknown,
  PAYMENT_ACTORS,
  PAYMENT_EVENT_TYPES,
  PAYMENT_STATES,
  PAYMENT_TRANSITIONS,
  PROVIDER_EVIDENCE_ACTORS,
  transition,
  type PaymentActor,
  type PaymentContext,
  type PaymentEvent,
  type PaymentEventType,
  type PaymentSnapshot,
  type PaymentState,
} from "@/lib/payment/state-machine";

const SPEC_STATES = [
  "DRAFT", "QUOTED", "USER_CONFIRMED", "ORDER_CREATE_IN_FLIGHT", "ORDER_CREATE_UNKNOWN", "AWAITING_APPROVAL",
  "APPROVAL_CHECK_PENDING", "APPROVED_VERIFIED", "CAPTURE_IN_FLIGHT", "CAPTURE_UNKNOWN", "CAPTURE_PENDING_PROVIDER",
  "CAPTURED_VERIFIED", "DECLINED_RETRYABLE", "RECONCILIATION_REQUIRED", "SUPERSEDED", "CANCELED_LOCAL", "EXPIRED",
  "FAILED_TERMINAL", "MANUAL_REVIEW", "PARTIALLY_REFUNDED_OBSERVED", "REFUNDED_OBSERVED", "REVERSED_OR_DISPUTED_OBSERVED",
];

const PAID_STATES: PaymentState[] = ["CAPTURED_VERIFIED", "PARTIALLY_REFUNDED_OBSERVED", "REFUNDED_OBSERVED", "REVERSED_OR_DISPUTED_OBSERVED"];
const CAPTURE_MAY_BE_DISPATCHED: PaymentState[] = ["CAPTURE_IN_FLIGHT", "CAPTURE_UNKNOWN", "CAPTURE_PENDING_PROVIDER"];
const DEAD_ENDS: PaymentState[] = ["SUPERSEDED", "CANCELED_LOCAL", "EXPIRED", "FAILED_TERMINAL", "MANUAL_REVIEW"];

let counter = 0;
/** Builds an event whose identifiers match the given context, so guards about identity pass. */
function eventFor(type: PaymentEventType, actor: PaymentActor, context: PaymentContext, extent: "PARTIAL" | "FULL" = "FULL"): PaymentEvent {
  counter += 1;
  const isCaptureEvent = type.startsWith("CAPTURE");
  return {
    type,
    eventId: `ev_test_${counter}`,
    occurredAt: "2026-10-08T12:00:00.000Z",
    actor,
    observationId: PROVIDER_EVIDENCE_ACTORS.includes(actor) ? `ob_test_${counter}` : undefined,
    quoteId: context.quoteId ?? "qt_1",
    confirmationId: "cf_1",
    operationId: (isCaptureEvent ? context.captureOperationId : context.orderCreateOperationId) ?? "op_new",
    readbackObservationId: "ob_readback",
    providerOrderId: context.providerOrderId ?? "ORDER-1",
    providerCaptureId: "CAPTURE-1",
    reason: "test",
    extent,
    byCheckoutIntentId: "ci_2",
  } as unknown as PaymentEvent;
}

function contextFor(state: PaymentState, captureDispatched: boolean): PaymentContext {
  return {
    quoteId: "qt_1",
    confirmationId: state === "DRAFT" || state === "QUOTED" ? null : "cf_1",
    orderCreateOperationId: "op_order",
    captureOperationId: captureDispatched ? "op_capture" : null,
    captureDispatched,
    providerOrderId: "ORDER-1",
    providerCaptureId: null,
  };
}

interface Edge {
  from: PaymentState;
  to: PaymentState;
  type: PaymentEventType;
  actor: PaymentActor;
  captureDispatched: boolean;
}

/** Every transition the reducer accepts, for every state, event type, actor and capture phase. */
function allAcceptedEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const from of PAYMENT_STATES) {
    for (const captureDispatched of [false, true]) {
      // Capture-phase states always have a dispatched capture; earlier states never do.
      if (CAPTURE_MAY_BE_DISPATCHED.includes(from) && !captureDispatched) continue;
      if (!CAPTURE_MAY_BE_DISPATCHED.includes(from) && from !== "RECONCILIATION_REQUIRED" && !PAID_STATES.includes(from) && captureDispatched) continue;
      const context = contextFor(from, captureDispatched);
      for (const type of PAYMENT_EVENT_TYPES) {
        for (const actor of PAYMENT_ACTORS) {
          for (const extent of ["PARTIAL", "FULL"] as const) {
            const result = transition({ state: from, version: 1, context }, eventFor(type, actor, context, extent));
            if (result.ok) edges.push({ from, to: result.value.snapshot.state, type, actor, captureDispatched });
          }
        }
      }
    }
  }
  return edges;
}

const EDGES = allAcceptedEdges();

function run(events: [PaymentEventType, PaymentActor][], start: PaymentSnapshot = INITIAL_PAYMENT_SNAPSHOT): PaymentSnapshot {
  return events.reduce((snapshot, [type, actor]) => {
    const result = transition(snapshot, eventFor(type, actor, snapshot.context));
    if (!result.ok) throw new Error(`${snapshot.state} + ${type} rejected: ${result.error.code} ${result.error.detail ?? ""}`);
    return result.value.snapshot;
  }, start);
}

const TO_AWAITING_APPROVAL: [PaymentEventType, PaymentActor][] = [
  ["QUOTE_ISSUED", "server"],
  ["SHOPPER_CONFIRMED", "shopper"],
  ["ORDER_CREATE_DISPATCHED", "operation_worker"],
  ["ORDER_CREATED", "provider_response"],
];
const TO_CAPTURE_IN_FLIGHT: [PaymentEventType, PaymentActor][] = [
  ...TO_AWAITING_APPROVAL,
  ["BUYER_RETURNED", "browser_redirect"],
  ["APPROVAL_VERIFIED", "provider_readback"],
  ["CAPTURE_DISPATCHED", "operation_worker"],
];

describe("payment state model", () => {
  it("defines exactly the required states", () => {
    expect([...PAYMENT_STATES].sort()).toEqual([...SPEC_STATES].sort());
    expect(Object.keys(PAYMENT_TRANSITIONS).sort()).toEqual([...SPEC_STATES].sort());
  });

  it("walks the happy path and records an attributable transition for every step", () => {
    let snapshot = INITIAL_PAYMENT_SNAPSHOT;
    const visited: PaymentState[] = [snapshot.state];
    for (const [type, actor] of [...TO_CAPTURE_IN_FLIGHT, ["CAPTURE_COMPLETED", "provider_response"]] as [PaymentEventType, PaymentActor][]) {
      const event = eventFor(type, actor, snapshot.context);
      const result = transition(snapshot, event);
      expect(result.ok, `${snapshot.state} + ${type}`).toBe(true);
      if (!result.ok) return;
      expect(result.value.record).toMatchObject({
        eventId: event.eventId,
        eventType: type,
        actor,
        from: snapshot.state,
        to: result.value.snapshot.state,
        fromVersion: snapshot.version,
        toVersion: snapshot.version + 1,
      });
      snapshot = result.value.snapshot;
      visited.push(snapshot.state);
    }
    expect(visited).toEqual([
      "DRAFT", "QUOTED", "USER_CONFIRMED", "ORDER_CREATE_IN_FLIGHT", "AWAITING_APPROVAL",
      "APPROVAL_CHECK_PENDING", "APPROVED_VERIFIED", "CAPTURE_IN_FLIGHT", "CAPTURED_VERIFIED",
    ]);
  });

  it("is pure: the input snapshot is never mutated and equal inputs give equal outputs", () => {
    const snapshot = run([["QUOTE_ISSUED", "server"]]);
    const copy = structuredClone(snapshot);
    const event = eventFor("SHOPPER_CONFIRMED", "shopper", snapshot.context);
    const first = transition(snapshot, event);
    const second = transition(snapshot, event);
    expect(snapshot).toEqual(copy);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first.ok && first.value.snapshot)).toBe(true);
  });

  it("every state is reachable and every edge names a known state", () => {
    const reachable = new Set<PaymentState>(["DRAFT"]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of EDGES) {
        if (reachable.has(edge.from) && !reachable.has(edge.to)) {
          reachable.add(edge.to);
          changed = true;
        }
      }
    }
    expect([...reachable].sort()).toEqual([...SPEC_STATES].sort());
  });
});

describe("mandatory invariants", () => {
  it("every transition is attributable to a specific authorized event", () => {
    const snapshot = run([["QUOTE_ISSUED", "server"]]);
    const good = eventFor("SHOPPER_CONFIRMED", "shopper", snapshot.context);

    expect(transition(snapshot, { ...good, eventId: "" })).toMatchObject({ ok: false, error: { code: "EVENT_MALFORMED" } });
    expect(transition(snapshot, { ...good, occurredAt: "not a date" })).toMatchObject({ ok: false, error: { code: "EVENT_MALFORMED" } });
    expect(transition(snapshot, { ...good, actor: "anonymous" as PaymentActor })).toMatchObject({ ok: false, error: { code: "EVENT_MALFORMED" } });
    // Only the shopper can confirm: not the server, a worker, the AI layer (which has no actor at all) or a provider.
    for (const actor of PAYMENT_ACTORS.filter((candidate) => candidate !== "shopper")) {
      expect(transition(snapshot, eventFor("SHOPPER_CONFIRMED", actor, snapshot.context)).ok, actor).toBe(false);
    }
    expect(transition(snapshot, { ...good, quoteId: "qt_other" } as PaymentEvent)).toMatchObject({ ok: false, error: { code: "GUARD_REJECTED", detail: "QUOTE_MISMATCH" } });
    // An order can never be dispatched without a recorded shopper confirmation.
    const unconfirmed: PaymentSnapshot = { state: "USER_CONFIRMED", version: 3, context: { ...snapshot.context, confirmationId: null } };
    expect(transition(unconfirmed, eventFor("ORDER_CREATE_DISPATCHED", "operation_worker", unconfirmed.context))).toMatchObject({
      ok: false,
      error: { detail: "NOT_CONFIRMED" },
    });
    for (const edge of EDGES) expect(PAYMENT_TRANSITIONS[edge.from][edge.type]?.actors).toContain(edge.actor);
  });

  it("browser redirects never prove payment", () => {
    const redirectEdges = EDGES.filter((edge) => edge.actor === "browser_redirect");
    expect(redirectEdges.length).toBeGreaterThan(0);
    for (const edge of redirectEdges) {
      expect(edge.type).toBe("BUYER_RETURNED");
      expect(edge.to).toBe("APPROVAL_CHECK_PENDING");
    }
    // A redirect cannot assert approval or capture, whatever it claims.
    const awaiting = run(TO_AWAITING_APPROVAL);
    for (const type of ["APPROVAL_VERIFIED", "CAPTURE_COMPLETED", "CAPTURE_DISPATCHED", "ORDER_CREATED"] as const) {
      for (const from of PAYMENT_STATES) {
        const snapshot = { ...awaiting, state: from };
        expect(transition(snapshot, eventFor(type, "browser_redirect", snapshot.context)).ok, `${from} + ${type}`).toBe(false);
      }
    }
    // Reaching APPROVED_VERIFIED or CAPTURED_VERIFIED always requires provider evidence.
    for (const edge of EDGES.filter((candidate) => candidate.to === "APPROVED_VERIFIED" || candidate.to === "CAPTURED_VERIFIED")) {
      expect(PROVIDER_EVIDENCE_ACTORS).toContain(edge.actor);
    }
  });

  it("provider evidence is distinct from local state: provider-sourced events must cite an observation", () => {
    const inFlight = run(TO_AWAITING_APPROVAL.slice(0, 3));
    const event = eventFor("ORDER_CREATED", "provider_response", inFlight.context);
    expect(transition(inFlight, { ...event, observationId: undefined })).toMatchObject({ ok: false, error: { code: "PROVIDER_EVIDENCE_REQUIRED" } });
    const accepted = transition(inFlight, event);
    expect(accepted.ok && accepted.value.record.observationId).toBe(event.observationId);
    // Local actors cannot fabricate provider outcomes.
    for (const actor of ["server", "shopper", "operation_worker", "timer", "reconciler"] as const) {
      expect(transition(inFlight, eventFor("ORDER_CREATED", actor, inFlight.context)).ok, actor).toBe(false);
    }
  });

  it("provider-pending captures are not completed captures", () => {
    const pending = run([...TO_CAPTURE_IN_FLIGHT, ["CAPTURE_PENDING", "provider_response"]]);
    expect(pending.state).toBe("CAPTURE_PENDING_PROVIDER");
    expect(isCaptureFinal(pending.state)).toBe(false);
    expect(PAYMENT_STATES.filter(isCaptureFinal)).toEqual(["CAPTURED_VERIFIED"]);
    // Leaving pending requires provider evidence (or escalation); time, the shopper and the server cannot complete it.
    for (const edge of EDGES.filter((candidate) => candidate.from === "CAPTURE_PENDING_PROVIDER")) {
      // Escalation by the reconciler, or rejected capture evidence found on readback.
      if (edge.to === "MANUAL_REVIEW") expect(["reconciler", "provider_readback"]).toContain(edge.actor);
      else expect(PROVIDER_EVIDENCE_ACTORS).toContain(edge.actor);
    }
    expect(run([["CAPTURE_COMPLETED", "provider_readback"]], pending).state).toBe("CAPTURED_VERIFIED");
    expect(run([["CAPTURE_DECLINED", "provider_readback"]], pending).state).toBe("DECLINED_RETRYABLE");
  });

  it("ambiguous payment outcomes never become generic failures", () => {
    const ambiguous = PAYMENT_STATES.filter(isOutcomeUnknown);
    expect(ambiguous.sort()).toEqual(["CAPTURE_IN_FLIGHT", "CAPTURE_UNKNOWN", "ORDER_CREATE_IN_FLIGHT", "ORDER_CREATE_UNKNOWN", "RECONCILIATION_REQUIRED"]);

    // FAILED_TERMINAL is reachable only through an explicit provider rejection received in response.
    const toFailed = EDGES.filter((edge) => edge.to === "FAILED_TERMINAL");
    expect(toFailed.length).toBeGreaterThan(0);
    for (const edge of toFailed) expect(edge).toMatchObject({ from: "ORDER_CREATE_IN_FLIGHT", type: "ORDER_CREATE_REJECTED", actor: "provider_response" });

    for (const edge of EDGES.filter((candidate) => ambiguous.includes(candidate.from))) {
      // Never silently "failed", "expired", "canceled" or back to a retry-from-scratch state.
      expect(["EXPIRED", "CANCELED_LOCAL", "SUPERSEDED", "DRAFT", "QUOTED", "USER_CONFIRMED"], `${edge.from} -${edge.type}-> ${edge.to}`).not.toContain(edge.to);
      // A definite negative or positive outcome needs provider evidence.
      if (["FAILED_TERMINAL", "DECLINED_RETRYABLE", "CAPTURED_VERIFIED", "AWAITING_APPROVAL", "CAPTURE_PENDING_PROVIDER"].includes(edge.to)) {
        expect(PROVIDER_EVIDENCE_ACTORS, `${edge.from} -${edge.type}-> ${edge.to}`).toContain(edge.actor);
      }
    }
    // A lost response leads to UNKNOWN, and from UNKNOWN a resend requires a readback first.
    const unknown = run([...TO_AWAITING_APPROVAL.slice(0, 3), ["ORDER_CREATE_OUTCOME_UNKNOWN", "operation_worker"]]);
    expect(unknown.state).toBe("ORDER_CREATE_UNKNOWN");
    const resend = eventFor("ORDER_CREATE_REDISPATCHED", "operation_worker", unknown.context);
    expect(transition(unknown, { ...resend, readbackObservationId: "" } as PaymentEvent)).toMatchObject({ ok: false, error: { detail: "READBACK_REQUIRED" } });
    expect(transition(unknown, eventFor("ORDER_CREATE_DISPATCHED", "operation_worker", unknown.context)).ok).toBe(false);
    expect(transition(unknown, resend).ok).toBe(true);
  });

  it("cancellation cannot claim to stop a capture already dispatched", () => {
    const inFlight = run(TO_CAPTURE_IN_FLIGHT);
    const states = [
      inFlight,
      run([["CAPTURE_OUTCOME_UNKNOWN", "operation_worker"]], inFlight),
      run([["CAPTURE_PENDING", "provider_response"]], inFlight),
      run([["CAPTURE_OUTCOME_UNKNOWN", "operation_worker"], ["READBACK_INCONCLUSIVE", "reconciler"]], inFlight),
    ];
    for (const snapshot of states) {
      expect(transition(snapshot, eventFor("SHOPPER_CANCELED", "shopper", snapshot.context)), snapshot.state).toMatchObject({
        ok: false,
        error: { code: "CAPTURE_ALREADY_DISPATCHED" },
      });
    }
    for (const edge of EDGES.filter((candidate) => candidate.captureDispatched && !PAID_STATES.includes(candidate.from))) {
      expect(["CANCELED_LOCAL", "SUPERSEDED", "EXPIRED"], `${edge.from} -${edge.type}-> ${edge.to}`).not.toContain(edge.to);
    }
    // Before capture is dispatched, cancellation works.
    const approved = run(TO_CAPTURE_IN_FLIGHT.slice(0, -1));
    expect(run([["SHOPPER_CANCELED", "shopper"]], approved).state).toBe("CANCELED_LOCAL");
    // While an order-create outcome is unresolved, cancellation is refused rather than guessed at.
    const orderInFlight = run(TO_AWAITING_APPROVAL.slice(0, 3));
    expect(transition(orderInFlight, eventFor("SHOPPER_CANCELED", "shopper", orderInFlight.context)).ok).toBe(false);
  });

  it("confirmed completed captures cannot revert to an unpaid state", () => {
    for (const edge of EDGES.filter((candidate) => PAID_STATES.includes(candidate.from))) {
      expect(PAID_STATES, `${edge.from} -${edge.type}-> ${edge.to}`).toContain(edge.to);
      expect(PROVIDER_EVIDENCE_ACTORS).toContain(edge.actor);
    }
    const captured = run([...TO_CAPTURE_IN_FLIGHT, ["CAPTURE_COMPLETED", "provider_response"]]);
    for (const [type, actor] of [
      ["SHOPPER_CANCELED", "shopper"],
      ["EXPIRED", "timer"],
      ["SUPERSEDED", "server"],
      ["QUOTE_INVALIDATED", "server"],
      ["CAPTURE_DECLINED", "provider_readback"],
      ["CAPTURE_DISPATCHED", "operation_worker"],
      ["QUOTE_ISSUED", "server"],
    ] as [PaymentEventType, PaymentActor][]) {
      expect(transition(captured, eventFor(type, actor, captured.context)).ok, type).toBe(false);
    }
  });

  it("a superseded or canceled checkout cannot automatically capture", () => {
    for (const state of DEAD_ENDS) {
      expect(EDGES.filter((edge) => edge.from === state), state).toEqual([]);
      expect(Object.keys(PAYMENT_TRANSITIONS[state])).toEqual([]);
    }
    const approved = run(TO_CAPTURE_IN_FLIGHT.slice(0, -1));
    for (const [type, actor] of [["SHOPPER_CANCELED", "shopper"], ["SUPERSEDED", "server"]] as [PaymentEventType, PaymentActor][]) {
      const ended = run([[type, actor]], approved);
      expect(transition(ended, eventFor("CAPTURE_DISPATCHED", "operation_worker", ended.context)).ok).toBe(false);
      expect(transition(ended, eventFor("CAPTURE_COMPLETED", "provider_response", ended.context)).ok).toBe(false);
    }
    // Capture can only ever be dispatched from APPROVED_VERIFIED.
    for (const edge of EDGES.filter((candidate) => candidate.type === "CAPTURE_DISPATCHED")) expect(edge.from).toBe("APPROVED_VERIFIED");
  });

  it("keeps one logical operation identity per phase", () => {
    const inFlight = run(TO_CAPTURE_IN_FLIGHT);
    const other = { ...eventFor("CAPTURE_COMPLETED", "provider_response", inFlight.context), operationId: "op_someone_else" } as PaymentEvent;
    expect(transition(inFlight, other)).toMatchObject({ ok: false, error: { detail: "OPERATION_MISMATCH" } });

    // After a provider-confirmed decline the next capture is a new logical operation.
    const declined = run([["CAPTURE_DECLINED", "provider_response"]], inFlight);
    expect(declined.state).toBe("DECLINED_RETRYABLE");
    expect(declined.context).toMatchObject({ captureOperationId: null, captureDispatched: false });
  });

  it("refunds and disputes are observations only", () => {
    const captured = run([...TO_CAPTURE_IN_FLIGHT, ["CAPTURE_COMPLETED", "provider_response"]]);
    const partial = transition(captured, eventFor("REFUND_OBSERVED", "provider_observation", captured.context, "PARTIAL"));
    expect(partial.ok && partial.value.snapshot.state).toBe("PARTIALLY_REFUNDED_OBSERVED");
    const full = transition(captured, eventFor("REFUND_OBSERVED", "provider_readback", captured.context, "FULL"));
    expect(full.ok && full.value.snapshot.state).toBe("REFUNDED_OBSERVED");
    expect(run([["REVERSAL_OR_DISPUTE_OBSERVED", "provider_observation"]], captured).state).toBe("REVERSED_OR_DISPUTED_OBSERVED");
    for (const actor of ["shopper", "server", "operation_worker", "reconciler", "timer", "browser_redirect"] as const) {
      expect(transition(captured, eventFor("REFUND_OBSERVED", actor, captured.context)).ok, actor).toBe(false);
    }
    expect(PAYMENT_EVENT_TYPES.filter((type) => /REFUND|REVERS/.test(type))).toEqual(["REFUND_OBSERVED", "REVERSAL_OR_DISPUTE_OBSERVED"]);
  });
});
