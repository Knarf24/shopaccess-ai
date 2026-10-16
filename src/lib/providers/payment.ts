/**
 * Payment provider boundary and a deterministic in-memory mock.
 *
 * Nothing in this file talks to a network, loads credentials or depends on a
 * provider SDK. The interface intentionally has no refund or reversal method:
 * those can only be observed through readback, never executed.
 */

export interface ProviderOrder {
  readonly orderId: string;
  readonly requestId: string;
  readonly status: "CREATED" | "APPROVED" | "COMPLETED";
  readonly amountCents: number;
  readonly currency: string;
  readonly merchantId: string;
  /** Present only when a sandbox create response produced a validated approval URL. */
  readonly approvalUrl?: string | null;
  /** Provider status text for the observation. Mock orders omit it and the local status is used. */
  readonly reportedStatus?: string;
  /** Observed PayPal merchant id. Mock orders omit it. */
  readonly paypalMerchantId?: string | null;
  /** Observed custom_id. Mock orders omit it. */
  readonly correlationId?: string | null;
}

export interface ProviderCapture {
  readonly captureId: string;
  readonly requestId: string;
  readonly orderId: string;
  readonly status: "COMPLETED" | "PENDING" | "DECLINED";
  readonly amountCents: number;
  readonly currency: string;
  readonly merchantId: string;
  /** Omitted sandbox evidence is unknown. The mock still reports a number. */
  readonly refundedCents?: number | null;
  /** Omitted sandbox evidence is unknown. The mock still reports a boolean. */
  readonly reversedOrDisputed?: boolean | null;
  /** Observed PayPal merchant id. Absent on mock captures. */
  readonly paypalMerchantId?: string | null;
  /** Observed custom_id. Absent on mock captures. */
  readonly correlationId?: string | null;
}

/** NO_RESPONSE means the outcome is unknown: the request may or may not have been applied. */
export type ProviderCallResult<T> =
  | { readonly kind: "RESPONSE"; readonly value: T }
  | { readonly kind: "REJECTED"; readonly code: string }
  | { readonly kind: "NO_RESPONSE" };

export type ProviderReadback<T> =
  | { readonly kind: "FOUND"; readonly value: T }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "UNAVAILABLE" };

export interface CreateOrderRequest {
  /** Stable idempotency ID for the logical operation. */
  readonly requestId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly merchantId: string;
  /** Sandbox orders need these to build custom_id and the return URLs. The mock ignores them. */
  readonly quoteId?: string;
  readonly intentId?: string;
  readonly returnOrigin?: string;
}

export interface CaptureOrderRequest {
  readonly requestId: string;
  readonly orderId: string;
}

export interface PaymentProvider {
  createOrder(request: CreateOrderRequest): Promise<ProviderCallResult<ProviderOrder>>;
  captureOrder(request: CaptureOrderRequest): Promise<ProviderCallResult<ProviderCapture>>;
  getOrder(orderId: string): Promise<ProviderReadback<ProviderOrder>>;
  getOrderByRequestId(requestId: string): Promise<ProviderReadback<ProviderOrder>>;
  getCaptureByRequestId(requestId: string): Promise<ProviderReadback<ProviderCapture>>;
}

/**
 * LOSE_RESPONSE: the provider applies the request but the response never arrives.
 * LOSE_REQUEST:  the request never reaches the provider.
 * Both look identical to the caller (NO_RESPONSE); only readback can tell them apart.
 */
export type MockFault = "LOSE_RESPONSE" | "LOSE_REQUEST" | "REJECT";
export type MockCaptureBehavior = "COMPLETE" | "PENDING" | "DECLINE";
export type MockCall = "createOrder" | "captureOrder" | "getOrder" | "getOrderByRequestId" | "getCaptureByRequestId";

export class MockPaymentProvider implements PaymentProvider {
  private readonly ordersById = new Map<string, ProviderOrder>();
  private readonly capturesById = new Map<string, ProviderCapture>();
  private readonly createFaults: MockFault[] = [];
  private readonly captureFaults: MockFault[] = [];
  private readonly captureBehaviors: MockCaptureBehavior[] = [];
  private readonly captureEvidenceFaults: ((capture: ProviderCapture) => unknown)[] = [];
  private readonly corruptedEvidence = new Map<string, (capture: ProviderCapture) => unknown>();
  private sequence = 0;

  /** Calls received, in order. Only the most recent ones are kept. */
  readonly calls: MockCall[] = [];
  /** Requests that reused an already-applied request ID. */
  duplicateRequestCount = 0;
  readbackUnavailable = false;
  /** Invoked at the start of every call; tests use it to assert call-site conditions. */
  onCall: ((call: MockCall) => void) | null = null;

  // --- Scenario controls -------------------------------------------------

  failNextCreateOrder(fault: MockFault): void {
    this.createFaults.push(fault);
  }

  failNextCapture(fault: MockFault): void {
    this.captureFaults.push(fault);
  }

  setNextCaptureBehavior(behavior: MockCaptureBehavior): void {
    this.captureBehaviors.push(behavior);
  }

  /**
   * Makes the NEXT new capture report wrong or incomplete evidence, in both its
   * response and later readbacks. The mock's own record stays correct; only what
   * it reports is altered, as a faulty or hostile provider response would be.
   */
  corruptNextCaptureEvidence(mutate: (capture: ProviderCapture) => unknown): void {
    this.captureEvidenceFaults.push(mutate);
  }

  /** Makes an existing capture report altered evidence from now on (for example at reconciliation). */
  corruptCaptureEvidence(captureId: string, mutate: (capture: ProviderCapture) => unknown): void {
    if (!this.capturesById.has(captureId)) throw new Error("Mock provider: unknown capture");
    this.corruptedEvidence.set(captureId, mutate);
  }

  simulateBuyerApproval(orderId: string): void {
    this.updateOrder(orderId, (order) => (order.status === "CREATED" ? { ...order, status: "APPROVED" } : order));
  }

  /** Simulates the provider holding order details that differ from what was quoted. */
  simulateIncorrectOrderDetails(orderId: string, amountCents: number): void {
    this.updateOrder(orderId, (order) => ({ ...order, amountCents }));
  }

  simulatePendingCaptureSettled(captureId: string, result: "COMPLETED" | "DECLINED"): void {
    this.updateCapture(captureId, (capture) => (capture.status === "PENDING" ? { ...capture, status: result } : capture));
  }

  /** A refund made elsewhere (for example in the provider dashboard). The app can only observe it. */
  simulateExternalRefund(captureId: string, amountCents: number): void {
    this.updateCapture(captureId, (capture) => ({
      ...capture,
      refundedCents: Math.min(capture.amountCents, (capture.refundedCents ?? 0) + amountCents),
    }));
  }

  simulateExternalReversalOrDispute(captureId: string): void {
    this.updateCapture(captureId, (capture) => ({ ...capture, reversedOrDisputed: true }));
  }

  /**
   * Drops the mock's own orders and captures whose request ID is not in `liveRequestIds`
   * (used when mock checkouts are cleaned up). Idempotent. Because it keeps by "still known"
   * and does not remove by list, it also collects records created by a request that was
   * still in flight when its checkout was cleaned up.
   */
  retainOnlyRequests(liveRequestIds: ReadonlySet<string>): void {
    for (const order of this.ordersById.values()) {
      if (!liveRequestIds.has(order.requestId)) this.ordersById.delete(order.orderId);
    }
    for (const capture of this.capturesById.values()) {
      if (liveRequestIds.has(capture.requestId)) continue;
      this.capturesById.delete(capture.captureId);
      this.corruptedEvidence.delete(capture.captureId);
    }
  }

  orderCount(): number {
    return this.ordersById.size;
  }

  captureCount(): number {
    return this.capturesById.size;
  }

  // --- PaymentProvider ---------------------------------------------------

  async createOrder(request: CreateOrderRequest): Promise<ProviderCallResult<ProviderOrder>> {
    this.record("createOrder");
    const fault = this.createFaults.shift();
    if (fault === "LOSE_REQUEST") return { kind: "NO_RESPONSE" };
    if (fault === "REJECT") return { kind: "REJECTED", code: "MOCK_ORDER_REJECTED" };

    let order = this.findOrderByRequestId(request.requestId);
    if (order) {
      this.duplicateRequestCount += 1;
      if (order.amountCents !== request.amountCents || order.currency !== request.currency || order.merchantId !== request.merchantId) {
        return { kind: "REJECTED", code: "MOCK_IDEMPOTENCY_PAYLOAD_MISMATCH" };
      }
    } else {
      order = {
        orderId: this.nextId("MOCK-ORDER"),
        requestId: request.requestId,
        status: "CREATED",
        amountCents: request.amountCents,
        currency: request.currency,
        merchantId: request.merchantId,
      };
      this.ordersById.set(order.orderId, order);
    }
    return fault === "LOSE_RESPONSE" ? { kind: "NO_RESPONSE" } : { kind: "RESPONSE", value: order };
  }

  async captureOrder(request: CaptureOrderRequest): Promise<ProviderCallResult<ProviderCapture>> {
    this.record("captureOrder");
    const fault = this.captureFaults.shift();
    if (fault === "LOSE_REQUEST") return { kind: "NO_RESPONSE" };
    if (fault === "REJECT") return { kind: "REJECTED", code: "MOCK_CAPTURE_REJECTED" };

    let capture = this.findCaptureByRequestId(request.requestId);
    if (capture) {
      this.duplicateRequestCount += 1;
    } else {
      const order = this.ordersById.get(request.orderId);
      if (!order) return { kind: "REJECTED", code: "MOCK_ORDER_NOT_FOUND" };
      if (order.status !== "APPROVED") return { kind: "REJECTED", code: "MOCK_ORDER_NOT_APPROVED" };
      const behavior = this.captureBehaviors.shift() ?? "COMPLETE";
      capture = {
        captureId: this.nextId("MOCK-CAPTURE"),
        requestId: request.requestId,
        orderId: order.orderId,
        status: behavior === "COMPLETE" ? "COMPLETED" : behavior === "PENDING" ? "PENDING" : "DECLINED",
        amountCents: order.amountCents,
        currency: order.currency,
        merchantId: order.merchantId,
        refundedCents: 0,
        reversedOrDisputed: false,
      };
      this.capturesById.set(capture.captureId, capture);
      const evidenceFault = this.captureEvidenceFaults.shift();
      if (evidenceFault) this.corruptedEvidence.set(capture.captureId, evidenceFault);
      if (capture.status === "COMPLETED") this.ordersById.set(order.orderId, { ...order, status: "COMPLETED" });
    }
    return fault === "LOSE_RESPONSE" ? { kind: "NO_RESPONSE" } : { kind: "RESPONSE", value: this.reported(capture) };
  }

  async getOrder(orderId: string): Promise<ProviderReadback<ProviderOrder>> {
    this.record("getOrder");
    if (this.readbackUnavailable) return { kind: "UNAVAILABLE" };
    const order = this.ordersById.get(orderId);
    return order ? { kind: "FOUND", value: order } : { kind: "NOT_FOUND" };
  }

  async getOrderByRequestId(requestId: string): Promise<ProviderReadback<ProviderOrder>> {
    this.record("getOrderByRequestId");
    if (this.readbackUnavailable) return { kind: "UNAVAILABLE" };
    const order = this.findOrderByRequestId(requestId);
    return order ? { kind: "FOUND", value: order } : { kind: "NOT_FOUND" };
  }

  async getCaptureByRequestId(requestId: string): Promise<ProviderReadback<ProviderCapture>> {
    this.record("getCaptureByRequestId");
    if (this.readbackUnavailable) return { kind: "UNAVAILABLE" };
    const capture = this.findCaptureByRequestId(requestId);
    return capture ? { kind: "FOUND", value: this.reported(capture) } : { kind: "NOT_FOUND" };
  }

  // --- Internals ---------------------------------------------------------

  /** What the mock reports for a capture. Deliberately able to violate the declared type. */
  private reported(capture: ProviderCapture): ProviderCapture {
    const mutate = this.corruptedEvidence.get(capture.captureId);
    return mutate ? (mutate({ ...capture }) as ProviderCapture) : capture;
  }

  private record(call: MockCall): void {
    this.calls.push(call);
    if (this.calls.length > 1000) this.calls.splice(0, this.calls.length - 1000);
    this.onCall?.(call);
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence.toString().padStart(4, "0")}`;
  }

  private findOrderByRequestId(requestId: string): ProviderOrder | undefined {
    return [...this.ordersById.values()].find((order) => order.requestId === requestId);
  }

  private findCaptureByRequestId(requestId: string): ProviderCapture | undefined {
    return [...this.capturesById.values()].find((capture) => capture.requestId === requestId);
  }

  private updateOrder(orderId: string, change: (order: ProviderOrder) => ProviderOrder): void {
    const order = this.ordersById.get(orderId);
    if (!order) throw new Error("Mock provider: unknown order");
    this.ordersById.set(orderId, change(order));
  }

  private updateCapture(captureId: string, change: (capture: ProviderCapture) => ProviderCapture): void {
    const capture = this.capturesById.get(captureId);
    if (!capture) throw new Error("Mock provider: unknown capture");
    this.capturesById.set(captureId, change(capture));
  }
}
