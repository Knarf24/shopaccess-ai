/**
 * PayPal Sandbox adapter. Unit tests inject a fake transport and never open a
 * socket. Application startup omits the transport, and the constructor then
 * uses `createFetchPaypalTransport`. This file does not read the environment.
 *
 * Access tokens and response bodies stay in this process. They are not
 * written to disk, audits, or redirects. There is no refund method.
 */

import type {
  CaptureOrderRequest,
  CreateOrderRequest,
  PaymentProvider,
  ProviderCallResult,
  ProviderCapture,
  ProviderOrder,
  ProviderReadback,
} from "./payment";
import { DEMO_CATALOG_MERCHANT_ID, SANDBOX_API_BASE_URL, sandboxCorrelationId } from "../payment/adapter-config";
import type { Clock } from "../shared/clock";
import { systemClock } from "../shared/clock";

/** Orders calls stop this long after the first POST for that operation. */
export const RETRY_CUTOFF_MS = 5 * 60 * 60 * 1000;
/** Covers headers and the full response body. Tests may inject a shorter value. */
export const REQUEST_TIMEOUT_MS = 10_000;

const ORDER_ID_PATTERN = /^[A-Z0-9]{1,36}$/;
const QUOTE_ID_PATTERN = /^qt_[0-9a-f]{32}$/;
const INTENT_ID_PATTERN = /^ci_[0-9a-f]{32}$/;
const REDIRECT_STATUSES = new Set(["CREATED", "PAYER_ACTION_REQUIRED"]);
const ACCEPTED_CREATE_STATUSES = new Set(["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"]);

export interface PaypalHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface PaypalTransportRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export type PaypalTransport = (request: PaypalTransportRequest) => Promise<PaypalHttpResponse>;

export interface PaypalOutboundCall {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly prefer: string | null;
  readonly requestId: string | null;
  readonly body: string | null;
}

export type SandboxPublicCode = "PAYEE_MISMATCH" | "APPROVAL_NOT_CONFIRMED";

interface OperationRecord {
  readonly requestId: string;
  readonly firstAttemptMs: number;
  postClosed: boolean;
  postsSent: number;
  readonly body: string;
  orderId: string | null;
  captureId: string | null;
  approvalUrl: string | null;
  readonly correlationId: string;
  readonly amountCents: number;
  readonly localMerchantId: string;
}

export interface PaypalSandboxOptions {
  readonly apiBaseUrl?: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly merchantId: string;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly transport?: PaypalTransport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function centsToPaypalAmount(cents: number): string | null {
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Accepts only digits, a dot, and exactly two fractional digits. No float math. */
export function paypalAmountToCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^[0-9]+\.[0-9]{2}$/.test(value)) return null;
  const cents = Number(`${value.slice(0, -3)}${value.slice(-2)}`);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function validateApprovalUrl(href: string, orderId: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname !== "www.sandbox.paypal.com") return null;
  if (url.pathname !== "/checkoutnow") return null;
  if (url.hash !== "") return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "token" || url.searchParams.get("token") !== orderId) return null;
  return url.toString();
}

function approvalLink(links: unknown, orderId: string): string | null {
  if (!Array.isArray(links)) return null;
  const hrefFor = (rel: string): string | null => {
    const match = links.find((link) => isRecord(link) && link.rel === rel && typeof link.href === "string");
    return match && isRecord(match) && typeof match.href === "string" ? match.href : null;
  };
  const payer = hrefFor("payer-action");
  const approve = hrefFor("approve");
  if (payer && approve && payer !== approve) return null;
  const href = payer ?? approve;
  return href ? validateApprovalUrl(href, orderId) : null;
}

function originOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

/**
 * Maps one capture object. Request id, local merchant, and omitted refund
 * observations come from the caller. Payee, amount, status, capture id, and
 * custom id are taken only from the provider body.
 */
export function captureEvidenceFromPaypal(input: {
  readonly requestId: string;
  readonly localMerchantId: string;
  readonly orderId: unknown;
  readonly capture: unknown;
  readonly payeeMerchantId: unknown;
  readonly correlationId: unknown;
}): Record<string, unknown> {
  const capture = isRecord(input.capture) ? input.capture : {};
  const amount = isRecord(capture.amount) ? capture.amount : {};
  const evidence: Record<string, unknown> = {
    requestId: input.requestId,
    merchantId: input.localMerchantId,
    paypalMerchantId: typeof input.payeeMerchantId === "string" && input.payeeMerchantId.length > 0 ? input.payeeMerchantId : null,
    correlationId: typeof input.correlationId === "string" && input.correlationId.length > 0 ? input.correlationId : null,
  };
  if (typeof capture.id === "string") evidence.captureId = capture.id;
  if (typeof input.orderId === "string") evidence.orderId = input.orderId;
  if (typeof capture.status === "string") evidence.status = capture.status;
  const cents = paypalAmountToCents(amount.value);
  if (cents !== null) evidence.amountCents = cents;
  if (typeof amount.currency_code === "string") evidence.currency = amount.currency_code;
  return evidence;
}

/** The orchestrator re-checks this object in validateCaptureEvidence. It is not trusted here. */
function asCapture(value: Record<string, unknown>): ProviderCapture {
  return value as unknown as ProviderCapture;
}

export function createFetchPaypalTransport(): PaypalTransport {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });
    const body = await response.text();
    if (request.signal.aborted) throw new Error("response body aborted");
    return { status: response.status, body };
  };
}

const SANDBOX_PROVIDER_MARK = Symbol.for("shopaccess.paypalSandboxProvider");

function constructedSandboxProviders(): WeakSet<object> {
  const host = globalThis as typeof globalThis & { [SANDBOX_PROVIDER_MARK]?: WeakSet<object> };
  const existing = host[SANDBOX_PROVIDER_MARK];
  if (existing) return existing;
  const created = new WeakSet<object>();
  Object.defineProperty(host, SANDBOX_PROVIDER_MARK, { value: created, enumerable: false, writable: false, configurable: false });
  return created;
}

const constructedProviders = constructedSandboxProviders();

/** True only for an object constructed by this class, including a separate copy of this module. */
export function isPayPalSandboxProvider(value: unknown): value is PayPalSandboxProvider {
  return typeof value === "object" && value !== null && constructedProviders.has(value);
}

export class PayPalSandboxProvider implements PaymentProvider {
  private readonly apiBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly merchantId: string;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly transport: PaypalTransport;
  private readonly creates = new Map<string, OperationRecord>();
  private readonly captures = new Map<string, OperationRecord>();
  private readonly returnOrigins = new Map<string, string>();
  private token: { readonly value: string; readonly expiresAtMs: number } | null = null;
  private publicCode: SandboxPublicCode | null = null;
  readonly outbound: PaypalOutboundCall[] = [];

  constructor(options: PaypalSandboxOptions) {
    constructedProviders.add(this);
    this.apiBaseUrl = options.apiBaseUrl ?? SANDBOX_API_BASE_URL;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.merchantId = options.merchantId;
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.transport = options.transport ?? createFetchPaypalTransport();
  }

  armReturnOrigin(intentId: string, origin: string): void {
    const normalized = originOf(origin);
    if (normalized) this.returnOrigins.set(intentId, normalized);
  }

  approvalUrlFor(orderId: string): string | null {
    for (const record of this.creates.values()) {
      if (record.orderId === orderId && record.approvalUrl) return record.approvalUrl;
    }
    return null;
  }

  consumePublicCode(): SandboxPublicCode | null {
    const code = this.publicCode;
    this.publicCode = null;
    return code;
  }

  async createOrder(request: CreateOrderRequest): Promise<ProviderCallResult<ProviderOrder>> {
    if (request.merchantId !== DEMO_CATALOG_MERCHANT_ID) return { kind: "REJECTED", code: "MERCHANT_NOT_MAPPED" };
    if (request.currency !== "USD") return { kind: "REJECTED", code: "CURRENCY_NOT_USD" };
    const amount = centsToPaypalAmount(request.amountCents);
    const quoteId = request.quoteId;
    const intentId = request.intentId;
    const origin = (request.returnOrigin ? originOf(request.returnOrigin) : null) ?? (intentId ? this.returnOrigins.get(intentId) : undefined);
    if (!amount || !quoteId || !QUOTE_ID_PATTERN.test(quoteId) || !intentId || !INTENT_ID_PATTERN.test(intentId) || !origin) {
      return { kind: "NO_RESPONSE" };
    }

    const existing = this.creates.get(request.requestId);
    if (existing?.orderId) return this.orderCommand(await this.readOrder(existing));
    const correlationId = sandboxCorrelationId(quoteId);
    const body = JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          custom_id: correlationId,
          payee: { merchant_id: this.merchantId },
          amount: { currency_code: "USD", value: amount },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: `${origin}/checkout/${intentId}/return`,
            cancel_url: `${origin}/checkout/${intentId}/paypal-cancel`,
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
          },
        },
      },
    });
    const record =
      existing ??
      this.remember(this.creates, {
        requestId: request.requestId,
        firstAttemptMs: this.clock().getTime(),
        postClosed: false,
        postsSent: 0,
        body,
        orderId: null,
        captureId: null,
        approvalUrl: null,
        correlationId,
        amountCents: request.amountCents,
        localMerchantId: request.merchantId,
      });
    const sent = await this.postJson(`${this.apiBaseUrl}/v2/checkout/orders`, record.body, record, true);
    if (sent === "NO_RESPONSE") return { kind: "NO_RESPONSE" };
    return this.acceptCreate(record, sent.status, sent.body);
  }

  async captureOrder(request: CaptureOrderRequest): Promise<ProviderCallResult<ProviderCapture>> {
    const create = this.createForOrder(request.orderId);
    if (!create) return { kind: "NO_RESPONSE" };
    const existing = this.captures.get(request.requestId);
    const record =
      existing ??
      this.remember(this.captures, {
        requestId: request.requestId,
        firstAttemptMs: this.clock().getTime(),
        postClosed: false,
        postsSent: 0,
        body: "{}",
        orderId: request.orderId,
        captureId: null,
        approvalUrl: null,
        correlationId: create.correlationId,
        amountCents: create.amountCents,
        localMerchantId: create.localMerchantId,
      });
    const sent = await this.postJson(`${this.apiBaseUrl}/v2/checkout/orders/${encodeURIComponent(request.orderId)}/capture`, record.body, record, true);
    if (sent === "NO_RESPONSE") return { kind: "NO_RESPONSE" };
    return this.acceptCapturePost(record, sent.status, sent.body);
  }

  async getOrder(orderId: string): Promise<ProviderReadback<ProviderOrder>> {
    const record = this.createForOrder(orderId);
    if (!record) return { kind: "UNAVAILABLE" };
    return this.readOrder(record);
  }

  async getOrderByRequestId(requestId: string): Promise<ProviderReadback<ProviderOrder>> {
    const record = this.creates.get(requestId);
    if (!record) return { kind: "UNAVAILABLE" };
    if (record.orderId) return this.readOrder(record);
    if (record.postClosed) return { kind: "UNAVAILABLE" };
    const sent = await this.postJson(`${this.apiBaseUrl}/v2/checkout/orders`, record.body, record, true);
    if (sent === "NO_RESPONSE") return { kind: "UNAVAILABLE" };
    const accepted = this.acceptCreate(record, sent.status, sent.body);
    return this.orderReadback(accepted);
  }

  async getCaptureByRequestId(requestId: string): Promise<ProviderReadback<ProviderCapture>> {
    const record = this.captures.get(requestId);
    if (!record || !record.orderId) return { kind: "UNAVAILABLE" };
    return this.readCapture(record);
  }

  private remember(store: Map<string, OperationRecord>, record: OperationRecord): OperationRecord {
    store.set(record.requestId, record);
    return record;
  }

  private createForOrder(orderId: string): OperationRecord | null {
    for (const record of this.creates.values()) if (record.orderId === orderId) return record;
    return null;
  }

  private closed(record: OperationRecord): boolean {
    if (record.postClosed) return true;
    const now = this.clock().getTime();
    const elapsed = now - record.firstAttemptMs;
    if (!Number.isFinite(now) || !Number.isFinite(record.firstAttemptMs) || elapsed < 0 || elapsed >= RETRY_CUTOFF_MS) {
      record.postClosed = true;
      return true;
    }
    return false;
  }

  private async accessToken(): Promise<string | null> {
    const now = this.clock().getTime();
    if (this.token && now < this.token.expiresAtMs) return this.token.value;
    const sent = await this.transmit({
      method: "POST",
      url: `${this.apiBaseUrl}/v1/oauth2/token`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`, "utf8").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!sent || sent.status !== 200) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(sent.body);
    } catch {
      return null;
    }
    if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) return null;
    const expiresIn = parsed.expires_in;
    const lifetime = typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : 0;
    this.token = { value: parsed.access_token, expiresAtMs: this.clock().getTime() + Math.max(0, lifetime - 60) * 1000 };
    return this.token.value;
  }

  private async postJson(url: string, body: string, record: OperationRecord, allow401Retry: boolean): Promise<{ status: number; body: string } | "NO_RESPONSE"> {
    if (this.closed(record)) return "NO_RESPONSE";
    const token = await this.accessToken();
    if (!token || this.closed(record)) return "NO_RESPONSE";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": record.requestId,
      Prefer: "return=representation",
    };
    record.postsSent += 1;
    const sent = await this.transmit({ method: "POST", url, headers, body });
    if (!sent) return "NO_RESPONSE";
    if (sent.status === 401 && allow401Retry) {
      this.token = null;
      if (this.closed(record)) return "NO_RESPONSE";
      const refreshed = await this.accessToken();
      if (!refreshed || this.closed(record)) return "NO_RESPONSE";
      const retried = await this.transmit({
        method: "POST",
        url,
        headers: { ...headers, Authorization: `Bearer ${refreshed}` },
        body,
      });
      if (!retried || retried.status === 401 || retried.status >= 500) return "NO_RESPONSE";
      return retried;
    }
    if (sent.status >= 500) return "NO_RESPONSE";
    return sent;
  }

  private async transmit(input: { method: "GET" | "POST"; url: string; headers: Record<string, string>; body?: string }): Promise<PaypalHttpResponse | null> {
    const prefer = input.headers.Prefer ?? input.headers.prefer ?? null;
    this.outbound.push({
      method: input.method,
      url: input.url,
      prefer,
      requestId: input.headers["PayPal-Request-Id"] ?? input.headers["paypal-request-id"] ?? null,
      body: input.body ?? null,
    });
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.transport({ ...input, signal });
      if (signal.aborted) return null;
      return response;
    } catch {
      return null;
    }
  }

  private async getJson(url: string, record: OperationRecord): Promise<{ status: number; body: string } | "NO_RESPONSE"> {
    const token = await this.accessToken();
    if (!token) return "NO_RESPONSE";
    const sent = await this.transmit({ method: "GET", url, headers: { Authorization: `Bearer ${token}` } });
    if (!sent) return "NO_RESPONSE";
    if (sent.status === 401) {
      this.token = null;
      if (this.closed(record)) return "NO_RESPONSE";
      const refreshed = await this.accessToken();
      if (!refreshed || this.closed(record)) return "NO_RESPONSE";
      const retried = await this.transmit({ method: "GET", url, headers: { Authorization: `Bearer ${refreshed}` } });
      if (!retried || retried.status === 401 || retried.status >= 500) return "NO_RESPONSE";
      return retried;
    }
    if (sent.status >= 500) return "NO_RESPONSE";
    return sent;
  }

  private acceptCreate(record: OperationRecord, status: number, body: string): ProviderCallResult<ProviderOrder> {
    const replay = record.postsSent > 1;
    if (status !== 200 && status !== 201) return { kind: "NO_RESPONSE" };
    if (replay && status !== 200) return { kind: "NO_RESPONSE" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { kind: "NO_RESPONSE" };
    }
    if (!isRecord(parsed) || typeof parsed.id !== "string" || !ORDER_ID_PATTERN.test(parsed.id)) return { kind: "NO_RESPONSE" };
    const rawStatus = typeof parsed.status === "string" ? parsed.status : "";
    if (!ACCEPTED_CREATE_STATUSES.has(rawStatus)) return { kind: "NO_RESPONSE" };
    const unit = Array.isArray(parsed.purchase_units) ? parsed.purchase_units[0] : undefined;
    const purchase = isRecord(unit) ? unit : {};
    const payee = isRecord(purchase.payee) ? purchase.payee.merchant_id : undefined;
    const amount = isRecord(purchase.amount) ? purchase.amount : {};
    if (payee !== this.merchantId) {
      this.publicCode = "PAYEE_MISMATCH";
      return { kind: "NO_RESPONSE" };
    }
    if (purchase.custom_id !== record.correlationId || paypalAmountToCents(amount.value) !== record.amountCents || amount.currency_code !== "USD") {
      this.publicCode = "APPROVAL_NOT_CONFIRMED";
      return { kind: "NO_RESPONSE" };
    }
    const redirect = REDIRECT_STATUSES.has(rawStatus) ? approvalLink(parsed.links, parsed.id) : null;
    record.orderId = parsed.id;
    record.approvalUrl = redirect;
    const order: ProviderOrder = {
      orderId: parsed.id,
      requestId: record.requestId,
      status: "CREATED",
      amountCents: record.amountCents,
      currency: "USD",
      merchantId: record.localMerchantId,
      approvalUrl: redirect,
      reportedStatus: rawStatus,
      paypalMerchantId: this.merchantId,
      correlationId: record.correlationId,
    };
    return { kind: "RESPONSE", value: order };
  }

  private async readOrder(record: OperationRecord): Promise<ProviderReadback<ProviderOrder>> {
    if (!record.orderId) return { kind: "UNAVAILABLE" };
    const sent = await this.getJson(`${this.apiBaseUrl}/v2/checkout/orders/${encodeURIComponent(record.orderId)}`, record);
    if (sent === "NO_RESPONSE") return { kind: "UNAVAILABLE" };
    if (sent.status === 404) return { kind: "NOT_FOUND" };
    if (sent.status !== 200) return { kind: "UNAVAILABLE" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(sent.body);
    } catch {
      return { kind: "UNAVAILABLE" };
    }
    if (!isRecord(parsed) || parsed.id !== record.orderId) return { kind: "UNAVAILABLE" };
    const rawStatus = typeof parsed.status === "string" ? parsed.status : "";
    const unit = Array.isArray(parsed.purchase_units) ? parsed.purchase_units[0] : undefined;
    if (!isRecord(unit)) return { kind: "UNAVAILABLE" };
    const payee = isRecord(unit.payee) ? unit.payee.merchant_id : undefined;
    const amount = isRecord(unit.amount) ? unit.amount : {};
    const cents = paypalAmountToCents(amount.value);
    if (typeof payee !== "string") {
      this.publicCode = "PAYEE_MISMATCH";
      return { kind: "UNAVAILABLE" };
    }
    if (payee !== this.merchantId) {
      this.publicCode = "PAYEE_MISMATCH";
      return { kind: "UNAVAILABLE" };
    }
    if (unit.custom_id !== record.correlationId) {
      this.publicCode = "APPROVAL_NOT_CONFIRMED";
      return { kind: "UNAVAILABLE" };
    }
    if (cents === null || amount.currency_code !== "USD") return { kind: "UNAVAILABLE" };
    const localStatus = rawStatus === "APPROVED" || rawStatus === "COMPLETED" ? rawStatus : "CREATED";
    return {
      kind: "FOUND",
      value: {
        orderId: record.orderId,
        requestId: record.requestId,
        status: localStatus,
        amountCents: cents,
        currency: "USD",
        merchantId: record.localMerchantId,
        approvalUrl: null,
        reportedStatus: rawStatus,
        paypalMerchantId: payee,
        correlationId: typeof unit.custom_id === "string" ? unit.custom_id : null,
      },
    };
  }

  private acceptCapturePost(record: OperationRecord, status: number, body: string): ProviderCallResult<ProviderCapture> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { kind: "NO_RESPONSE" };
    }
    const evidence = this.evidenceForCaptureBody(record, parsed);
    const captureId = typeof evidence.captureId === "string" ? evidence.captureId : null;
    if (status === 201) {
      if (record.captureId !== null) return { kind: "NO_RESPONSE" };
      if (!captureId) return { kind: "RESPONSE", value: asCapture(evidence) };
      record.captureId = captureId;
      return { kind: "RESPONSE", value: asCapture(evidence) };
    }
    if (status === 200) {
      if (!record.captureId || captureId !== record.captureId) return { kind: "NO_RESPONSE" };
      return { kind: "RESPONSE", value: asCapture(evidence) };
    }
    return { kind: "NO_RESPONSE" };
  }

  private async readCapture(record: OperationRecord): Promise<ProviderReadback<ProviderCapture>> {
    if (!record.orderId) return { kind: "UNAVAILABLE" };
    const sent = await this.getJson(`${this.apiBaseUrl}/v2/checkout/orders/${encodeURIComponent(record.orderId)}`, record);
    if (sent === "NO_RESPONSE") return { kind: "UNAVAILABLE" };
    if (sent.status === 404) return { kind: "UNAVAILABLE" };
    if (sent.status !== 200) return { kind: "UNAVAILABLE" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(sent.body);
    } catch {
      return { kind: "UNAVAILABLE" };
    }
    if (!isRecord(parsed)) return { kind: "UNAVAILABLE" };
    const rawStatus = typeof parsed.status === "string" ? parsed.status : "";
    const unit = Array.isArray(parsed.purchase_units) ? parsed.purchase_units[0] : undefined;
    const payments = isRecord(unit) && isRecord(unit.payments) ? unit.payments : {};
    const captures = Array.isArray(payments.captures) ? payments.captures : [];
    if (captures.length === 0) {
      if (rawStatus === "APPROVED" && !record.postClosed) return { kind: "NOT_FOUND" };
      return { kind: "UNAVAILABLE" };
    }
    if (captures.length !== 1) return { kind: "UNAVAILABLE" };
    const evidence = captureEvidenceFromPaypal({
      requestId: record.requestId,
      localMerchantId: record.localMerchantId,
      orderId: parsed.id,
      capture: captures[0],
      payeeMerchantId: isRecord(unit) && isRecord(unit.payee) ? unit.payee.merchant_id : undefined,
      correlationId: isRecord(unit) ? unit.custom_id : undefined,
    });
    if (!isRecord(captures[0]) || typeof captures[0].status !== "string") return { kind: "UNAVAILABLE" };
    if (parsed.id !== record.orderId) return { kind: "UNAVAILABLE" };
    const seen = typeof evidence.captureId === "string" ? evidence.captureId : null;
    if (record.captureId && seen !== record.captureId) return { kind: "UNAVAILABLE" };
    if (typeof evidence.captureId !== "string" || typeof evidence.amountCents !== "number" || typeof evidence.currency !== "string" || typeof evidence.status !== "string") {
      return { kind: "UNAVAILABLE" };
    }
    return { kind: "FOUND", value: asCapture(evidence) };
  }

  private evidenceForCaptureBody(record: OperationRecord, parsed: unknown): Record<string, unknown> {
    if (!isRecord(parsed)) return { requestId: record.requestId, merchantId: record.localMerchantId };
    if (Array.isArray(parsed.purchase_units)) {
      const unit = isRecord(parsed.purchase_units[0]) ? parsed.purchase_units[0] : {};
      const payments = isRecord(unit.payments) ? unit.payments : {};
      const capture = Array.isArray(payments.captures) ? payments.captures[0] : undefined;
      return captureEvidenceFromPaypal({
        requestId: record.requestId,
        localMerchantId: record.localMerchantId,
        orderId: parsed.id,
        capture,
        payeeMerchantId: isRecord(unit.payee) ? unit.payee.merchant_id : undefined,
        correlationId: unit.custom_id,
      });
    }
    const related = isRecord(parsed.supplementary_data) && isRecord(parsed.supplementary_data.related_ids) ? parsed.supplementary_data.related_ids.order_id : undefined;
    return captureEvidenceFromPaypal({
      requestId: record.requestId,
      localMerchantId: record.localMerchantId,
      orderId: related,
      capture: parsed,
      payeeMerchantId: isRecord(parsed.payee) ? parsed.payee.merchant_id : undefined,
      correlationId: parsed.custom_id,
    });
  }

  private orderCommand(readback: ProviderReadback<ProviderOrder>): ProviderCallResult<ProviderOrder> {
    if (readback.kind === "FOUND") return { kind: "RESPONSE", value: readback.value };
    return { kind: "NO_RESPONSE" };
  }

  private orderReadback(result: ProviderCallResult<ProviderOrder>): ProviderReadback<ProviderOrder> {
    if (result.kind === "RESPONSE") return { kind: "FOUND", value: result.value };
    return { kind: "UNAVAILABLE" };
  }
}
