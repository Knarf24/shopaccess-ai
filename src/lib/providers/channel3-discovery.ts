import type { ExternalListingView } from "@/lib/catalog/external-listing";
import { parseSafeExternalUrl } from "@/lib/catalog/url";

export type { ExternalListingView };

type ListingUse = "schoolwork" | "programming" | "general_productivity";

/**
 * Live Channel3 calls stay off. A discovery switch and an API key do not change this.
 * `createFetchChannel3Transport` exists for a later authorized activation and for tests
 * that pass their own `fetch`. The runtime factory must not call it.
 */
export const CHANNEL3_LIVE_ACTIVATION = false;

export const CHANNEL3_LIMITS = {
  maxActionsPerSession: 3,
  maxSearchCallsPerAction: 1,
  maxDetailCallsPerAction: 5,
  actionDeadlineMs: 8_000,
  requestTimeoutMs: 2_000,
  maxResponseBytes: 262_144,
} as const;

const API_ORIGIN = "https://api.trychannel3.com";
const SHOWABLE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USE_QUERY: Record<ListingUse, string> = {
  schoolwork: "schoolwork",
  programming: "programming",
  general_productivity: "general productivity",
};

export type Channel3FailureCode = "DEADLINE" | "REDIRECT" | "BODY_TOO_LARGE" | "HTTP_STATUS" | "TRANSPORT" | "NOT_JSON";

export type Channel3Response =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly code: Channel3FailureCode };

export interface Channel3Transport {
  search(request: { readonly query: string; readonly limit: number; readonly signal: AbortSignal }): Promise<Channel3Response>;
  detail(request: { readonly productId: string; readonly signal: AbortSignal }): Promise<Channel3Response>;
}

export type ListingOutcome =
  | { readonly status: "ready"; readonly listings: readonly ExternalListingView[]; readonly retrievedAt: string }
  | { readonly status: "limit" }
  | { readonly status: "stale" }
  | { readonly status: "error" };

export type Channel3Snapshot =
  | { readonly status: "ready"; readonly listings: readonly ExternalListingView[]; readonly retrievedAt: string }
  | { readonly status: "error" }
  | { readonly status: "pending" };

/**
 * Listing budgets and stored results are process-local and scoped to one session.
 * Pending work is kept by the session, draft, and version action key.
 * Nothing here is written to the session snapshot or shared with another process.
 * The budget and stored results reset when the process restarts.
 */
type SessionListingState = {
  actionsStarted: number;
  pending: Map<string, Promise<ListingOutcome>>;
  completed: Map<string, { listings: readonly ExternalListingView[]; retrievedAt: string }>;
  failure: Set<string>;
};

const listingStates = new WeakMap<object, Map<string, SessionListingState>>();

function stateFor(store: object, sessionId: string): SessionListingState {
  const sessions = listingStates.get(store) ?? new Map<string, SessionListingState>();
  listingStates.set(store, sessions);
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created: SessionListingState = { actionsStarted: 0, pending: new Map(), completed: new Map(), failure: new Set() };
  sessions.set(sessionId, created);
  return created;
}

/** One in-flight or stored action. The session id keeps one shopper's budget off another shopper's. */
function actionKey(sessionId: string, draftId: string, version: number): string {
  return `${sessionId}:${draftId}:${version}`;
}

export function channel3ClientForProcess(env?: Readonly<Record<string, string | undefined>>): "disabled" | "enabled" {
  // Read and drop the switch and key so a present pair cannot select the live client.
  void env?.CHANNEL3_DISCOVERY;
  void env?.CHANNEL3_API_KEY;
  return CHANNEL3_LIVE_ACTIVATION ? "enabled" : "disabled";
}

/** Query text is the confirmed use and the whole-dollar budget. Shopper free text is not accepted here. */
export function channel3Query(use: ListingUse, budgetDollars: string): string {
  return `laptop for ${USE_QUERY[use]} under ${budgetDollars} USD`;
}

export function readChannel3Listings(store: object, sessionId: string, draftId: string, version: number): Channel3Snapshot | null {
  const state = listingStates.get(store)?.get(sessionId);
  if (!state) return null;
  const key = actionKey(sessionId, draftId, version);
  if (state.pending.has(key)) return { status: "pending" };
  const completed = state.completed.get(key);
  if (completed) return { status: "ready", listings: completed.listings, retrievedAt: completed.retrievedAt };
  if (state.failure.has(key)) return { status: "error" };
  return null;
}

export interface ListingSearchInput {
  readonly store: object;
  readonly sessionId: string;
  readonly draftId: string;
  readonly version: number;
  readonly use: ListingUse;
  readonly budgetDollars: string;
  readonly transport: Channel3Transport;
  readonly currentDraft: () => { readonly draftId: string; readonly version: number } | null;
  readonly now: () => string;
  readonly actionDeadlineMs?: number;
  readonly requestTimeoutMs?: number;
}

/**
 * Starts at most one search and five sequential detail calls.
 * The action budget is counted when the action starts, including when the result is later discarded.
 * A completed result for the same draft version is returned again without a request.
 * A second click for an action already in flight joins that action.
 */
export function searchChannel3Listings(input: ListingSearchInput): Promise<ListingOutcome> {
  const state = stateFor(input.store, input.sessionId);
  const key = actionKey(input.sessionId, input.draftId, input.version);
  const completed = state.completed.get(key);
  if (completed) return Promise.resolve({ status: "ready", listings: completed.listings, retrievedAt: completed.retrievedAt });
  const pending = state.pending.get(key);
  if (pending) return pending;
  if (state.actionsStarted >= CHANNEL3_LIMITS.maxActionsPerSession) return Promise.resolve({ status: "limit" });
  const current = input.currentDraft();
  if (!current || current.draftId !== input.draftId || current.version !== input.version) return Promise.resolve({ status: "stale" });

  state.actionsStarted += 1;
  const promise = executeListingSearch(input, state, key).finally(() => {
    if (state.pending.get(key) === promise) state.pending.delete(key);
  });
  state.pending.set(key, promise);
  return promise;
}

async function executeListingSearch(input: ListingSearchInput, state: SessionListingState, key: string): Promise<ListingOutcome> {
  const deadlineMs = input.actionDeadlineMs ?? CHANNEL3_LIMITS.actionDeadlineMs;
  const requestMs = input.requestTimeoutMs ?? CHANNEL3_LIMITS.requestTimeoutMs;
  const action = deadlineMs <= 0 ? AbortSignal.abort() : AbortSignal.timeout(deadlineMs);
  if (action.aborted) {
    state.failure.add(key);
    return { status: "error" };
  }

  const query = channel3Query(input.use, input.budgetDollars);
  const search = await withDeadline(action, requestMs, (signal) =>
    input.transport.search({ query, limit: CHANNEL3_LIMITS.maxDetailCallsPerAction, signal }),
  );
  if (search.status !== "ok" || !search.body.ok) {
    if (!draftStillCurrent(input)) return { status: "stale" };
    state.failure.add(key);
    return { status: "error" };
  }
  if (!draftStillCurrent(input)) return { status: "stale" };

  if (!isRecord(search.body.body)) {
    if (!draftStillCurrent(input)) return { status: "stale" };
    state.failure.add(key);
    return { status: "error" };
  }
  const candidates = showableProducts(search.body.body);
  const retrievedAt = input.now();
  const listings: ExternalListingView[] = [];
  for (const candidate of candidates.slice(0, CHANNEL3_LIMITS.maxDetailCallsPerAction)) {
    if (!draftStillCurrent(input)) return { status: "stale" };
    if (action.aborted) return deadlineError(state, key);
    const detail = await withDeadline(action, requestMs, (signal) => input.transport.detail({ productId: candidate.id, signal }));
    if (!draftStillCurrent(input)) return { status: "stale" };
    if (detail.status === "deadline" && action.aborted) return deadlineError(state, key);
    if (detail.status !== "ok" || !detail.body.ok) {
      listings.push({
        externalId: `ext_${candidate.id}`,
        title: candidate.title,
        sellerLabel: null,
        indicativePriceCents: null,
        url: null,
        retrievedAt,
      });
      continue;
    }
    const selected = listingFromDetail(detail.body.body, candidate, retrievedAt);
    if (selected) listings.push(selected);
  }

  if (!draftStillCurrent(input)) return { status: "stale" };
  if (action.aborted) return deadlineError(state, key);
  state.failure.delete(key);
  state.completed.set(key, { listings, retrievedAt });
  return { status: "ready", listings, retrievedAt };
}

function deadlineError(state: SessionListingState, key: string): ListingOutcome {
  state.completed.delete(key);
  state.failure.add(key);
  return { status: "error" };
}

function draftStillCurrent(input: ListingSearchInput): boolean {
  const current = input.currentDraft();
  return current !== null && current.draftId === input.draftId && current.version === input.version;
}

type DeadlineResult = { readonly status: "ok"; readonly body: Channel3Response } | { readonly status: "deadline" };

async function withDeadline(
  action: AbortSignal,
  requestMs: number,
  run: (signal: AbortSignal) => Promise<Channel3Response>,
): Promise<DeadlineResult> {
  if (action.aborted || requestMs <= 0) return { status: "deadline" };
  const signal = AbortSignal.any([action, AbortSignal.timeout(requestMs)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DeadlineResult>((resolve) => {
    const finish = () => resolve({ status: "deadline" });
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, requestMs);
  });
  try {
    const body = await Promise.race([run(signal).then((value) => ({ status: "ok" as const, body: value })), deadline]);
    return body;
  } catch {
    return { status: "deadline" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plain(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function showableProducts(body: unknown): { id: string; title: string }[] {
  if (!isRecord(body)) return [];
  const list = Array.isArray(body.products) ? body.products : Array.isArray(body.results) ? body.results : [];
  const products: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = plain(entry.id, 64) ?? plain(entry.product_id, 64);
    const title = plain(entry.title, 200) ?? plain(entry.name, 200);
    if (!id || !title || !SHOWABLE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    products.push({ id, title });
  }
  return products;
}

function listingFromDetail(
  body: unknown,
  candidate: { id: string; title: string },
  retrievedAt: string,
): ExternalListingView | null {
  if (!isRecord(body)) return null;
  const id = plain(body.id, 64) ?? plain(body.product_id, 64);
  if (id !== candidate.id) return null;
  const title = plain(body.title, 200) ?? plain(body.name, 200) ?? candidate.title;
  const offer = singleOffer(body);
  const sellerLabel = offer ? sellerFromOffer(offer) : null;
  const price = offer ? usdCents(offer) : null;
  const url = offer ? safeOfferUrl(offer) : null;
  const priced = price !== null && url !== null;
  return {
    externalId: `ext_${candidate.id}`,
    title,
    sellerLabel,
    indicativePriceCents: priced ? price : null,
    url: priced ? url : null,
    retrievedAt,
  };
}

function singleOffer(body: Record<string, unknown>): Record<string, unknown> | null {
  const offers = Array.isArray(body.offers) ? body.offers : Array.isArray(body.listings) ? body.listings : null;
  if (!offers || offers.length !== 1) return null;
  const offer = offers[0];
  return isRecord(offer) ? offer : null;
}

function isTrackingHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return name === "buy.trychannel3.com" || name.endsWith(".buy.trychannel3.com");
}

function hostnameOf(value: string): string | null {
  if (!/^[a-z0-9.-]{1,253}$/i.test(value) || !value.includes(".") || value.startsWith(".") || value.endsWith(".")) return null;
  return value.toLowerCase();
}

function sellerFromOffer(offer: Record<string, unknown>): string | null {
  const retailer = plain(offer.retailer, 80) ?? plain(offer.retailer_name, 80) ?? plain(offer.seller, 80);
  if (retailer) return retailer;
  const domain = plain(offer.domain, 253);
  const domainHost = domain ? hostnameOf(domain) : null;
  if (domainHost && !isTrackingHost(domainHost)) return domainHost;
  const url = plain(offer.url, 2048);
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!host || isTrackingHost(host)) return null;
    return host;
  } catch {
    return null;
  }
}

function usdCents(offer: Record<string, unknown>): number | null {
  const prices = Array.isArray(offer.prices) ? offer.prices : offer.price !== undefined ? [offer.price] : [];
  if (prices.length !== 1 || !isRecord(prices[0])) return null;
  const price = prices[0];
  const currency = plain(price.currency, 8);
  if (currency !== "USD") return null;
  const amount = typeof price.amount === "number" ? String(price.amount) : plain(price.amount, 16);
  if (!amount || !/^\d{1,7}(\.\d{2})?$/.test(amount)) return null;
  const [whole, fraction = "00"] = amount.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  return cents;
}

function safeOfferUrl(offer: Record<string, unknown>): string | null {
  const parsed = parseSafeExternalUrl(offer.url);
  return parsed.ok ? parsed.value : null;
}

/**
 * Production transport. Redirects are refused so the API key is not forwarded to another origin.
 * Tests pass their own fetch. The runtime does not install this function.
 */
export function createFetchChannel3Transport(apiKey: string, fetchImpl: typeof fetch = globalThis.fetch): Channel3Transport {
  const fetch = fetchImpl;
  const headers = { "x-api-key": apiKey, accept: "application/json" };
  const call = async (url: string, init: RequestInit, signal: AbortSignal): Promise<Channel3Response> => {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal, redirect: "error" });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return { ok: false, code: "DEADLINE" };
      if (error instanceof TypeError && /redirect/i.test(error.message)) return { ok: false, code: "REDIRECT" };
      return { ok: false, code: "TRANSPORT" };
    }
    return readChannel3Response(response, signal);
  };
  return {
    search(request) {
      return call(
        `${API_ORIGIN}/v1/search`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ query: request.query, limit: request.limit }),
        },
        request.signal,
      );
    },
    detail(request) {
      return call(
        `${API_ORIGIN}/v1/products/${encodeURIComponent(request.productId)}`,
        { method: "GET", headers },
        request.signal,
      );
    },
  };
}

async function readChannel3Response(response: Response, signal: AbortSignal): Promise<Channel3Response> {
  if (response.redirected) {
    await cancelBody(response);
    return { ok: false, code: "REDIRECT" };
  }
  if (response.status < 200 || response.status >= 300) {
    await cancelBody(response);
    return { ok: false, code: "HTTP_STATUS" };
  }
  const declared = declaredLength(response.headers);
  if (declared !== null && declared > CHANNEL3_LIMITS.maxResponseBytes) {
    await cancelBody(response);
    return { ok: false, code: "BODY_TOO_LARGE" };
  }
  const text = await readBounded(response, signal);
  if (!text.ok) return { ok: false, code: text.code };
  try {
    return { ok: true, body: JSON.parse(text.text) as unknown };
  } catch {
    return { ok: false, code: "NOT_JSON" };
  }
}

function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The stream may already be closed.
  }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; code: Channel3FailureCode }> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        await reader.cancel();
        return { ok: false, code: "DEADLINE" };
      }
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > CHANNEL3_LIMITS.maxResponseBytes) {
        await reader.cancel();
        return { ok: false, code: "BODY_TOO_LARGE" };
      }
      chunks.push(step.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return { ok: false, code: "DEADLINE" };
    return { ok: false, code: "TRANSPORT" };
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(body) };
}
