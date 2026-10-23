import type { ExternalListingView } from "@/lib/catalog/external-listing";
import { parseSafeExternalUrl } from "@/lib/catalog/url";

export type { ExternalListingView };

type ListingUse = "schoolwork" | "programming" | "general_productivity";

/**
 * Channel3 external-listing search (F04). The runtime installs `createFetchChannel3Transport` only when
 * `CHANNEL3_DISCOVERY=on` and a valid `CHANNEL3_API_KEY` are configured (src/server/channel3-config.ts).
 * Each search action reserves capacity first (per session, per UTC hour, per UTC day) through the caller's `reserve`;
 * a refused reservation makes no request. Listings are never merchant quotes, readiness inputs or purchasable items.
 */
export const CHANNEL3_LIMITS = {
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
 * Stored results are process-local and scoped to one session. Pending work is kept by the session, draft, and version
 * action key. Nothing here is written to the session snapshot or shared with another process.
 * Stored results reset when the process restarts. The action budget is the runtime's limiter (`reserve`).
 *
 * The container is shared through `globalThis`, so a copy of this module loaded by another route bundle sees the same
 * results (the lesson of the advisory scope defect).
 */
type SessionListingState = {
  pending: Map<string, Promise<ListingOutcome>>;
  completed: Map<string, { listings: readonly ExternalListingView[]; retrievedAt: string }>;
  failure: Set<string>;
};

const LISTING_STATES = Symbol.for("shopaccess.channel3ListingStates");
type GlobalWithListingStates = typeof globalThis & { [LISTING_STATES]?: WeakMap<object, Map<string, SessionListingState>> };

function listingStatesContainer(): WeakMap<object, Map<string, SessionListingState>> {
  const holder = globalThis as GlobalWithListingStates;
  holder[LISTING_STATES] ??= new WeakMap<object, Map<string, SessionListingState>>();
  return holder[LISTING_STATES];
}

function stateFor(store: object, sessionId: string): SessionListingState {
  const states = listingStatesContainer();
  const sessions = states.get(store) ?? new Map<string, SessionListingState>();
  states.set(store, sessions);
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created: SessionListingState = { pending: new Map(), completed: new Map(), failure: new Set() };
  sessions.set(sessionId, created);
  return created;
}

/** One in-flight or stored action. The session id keeps one shopper's budget off another shopper's. */
function actionKey(sessionId: string, draftId: string, version: number): string {
  return `${sessionId}:${draftId}:${version}`;
}

/** Query text is the confirmed use and the whole-dollar budget. Shopper free text is not accepted here. */
export function channel3Query(use: ListingUse, budgetDollars: string): string {
  return `laptop for ${USE_QUERY[use]} under ${budgetDollars} USD`;
}

export function readChannel3Listings(store: object, sessionId: string, draftId: string, version: number): Channel3Snapshot | null {
  const state = listingStatesContainer().get(store)?.get(sessionId);
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
  /**
   * Reserves one search action (session, UTC hour, UTC day) synchronously, before any request. `false` means the limit
   * was reached and nothing is sent. A reserved action counts even if it later fails or is discarded.
   */
  readonly reserve: () => boolean;
  readonly now: () => string;
  readonly actionDeadlineMs?: number;
  readonly requestTimeoutMs?: number;
}

/**
 * Starts at most one search and five sequential detail calls.
 * The action is reserved when it starts (no await before the reservation), including when the result is later
 * discarded or the request fails.
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
  const current = input.currentDraft();
  if (!current || current.draftId !== input.draftId || current.version !== input.version) return Promise.resolve({ status: "stale" });
  if (!input.reserve()) return Promise.resolve({ status: "limit" });

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
      listings.push(unknownListing(candidate, retrievedAt));
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

/** Documented search shape: `{ products: [{ id, title, … }] }`. Undocumented alternatives are not accepted. */
function showableProducts(body: unknown): { id: string; title: string }[] {
  if (!isRecord(body) || !Array.isArray(body.products)) return [];
  const products: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const entry of body.products) {
    if (!isRecord(entry)) continue;
    const id = plain(entry.id, 64);
    const title = plain(entry.title, 200);
    if (!id || !title || !SHOWABLE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    products.push({ id, title });
  }
  return products;
}

/** A row whose detail could not be read: title only, everything else unknown. */
function unknownListing(candidate: { id: string; title: string }, retrievedAt: string): ExternalListingView {
  return {
    externalId: `ext_${candidate.id}`,
    title: candidate.title,
    reportedDomain: null,
    reportedAvailability: null,
    indicativePriceCents: null,
    url: null,
    retrievedAt,
  };
}

type OfferReading = {
  readonly domain: string | null;
  readonly availability: "InStock" | "OutOfStock" | null;
  readonly cents: number | null;
  readonly url: string | null;
};

/**
 * Documented detail shape: `{ id, title, offers: [{ url, domain, price: { price, currency }, availability }] }`.
 * A price, link and domain are shown only when exactly one offer is in stock with a valid USD price and a safe link.
 * With no offers, several such offers, or anything absent or malformed, those fields stay unknown (`null`).
 */
function listingFromDetail(
  body: unknown,
  candidate: { id: string; title: string },
  retrievedAt: string,
): ExternalListingView | null {
  if (!isRecord(body)) return null;
  const id = plain(body.id, 64);
  if (id !== candidate.id) return null;
  const title = plain(body.title, 200) ?? candidate.title;
  const offers = Array.isArray(body.offers) ? body.offers.filter(isRecord).map(readOffer) : [];
  const usable = offers.filter((offer) => offer.availability === "InStock" && offer.cents !== null && offer.url !== null);
  if (usable.length === 1) {
    const offer = usable[0]!;
    return {
      externalId: `ext_${candidate.id}`,
      title,
      reportedDomain: offer.domain,
      reportedAvailability: "InStock",
      indicativePriceCents: offer.cents,
      url: offer.url,
      retrievedAt,
    };
  }
  // Not exactly one usable offer: report availability only when every offer agrees on a documented value.
  const states = new Set(offers.map((offer) => offer.availability));
  const reportedAvailability = offers.length > 0 && states.size === 1 && !states.has(null) ? [...states][0]! : null;
  return { ...unknownListing({ id: candidate.id, title }, retrievedAt), reportedAvailability: usable.length > 1 ? null : reportedAvailability };
}

function readOffer(offer: Record<string, unknown>): OfferReading {
  const availability = offer.availability === "InStock" || offer.availability === "OutOfStock" ? offer.availability : null;
  return { domain: reportedDomain(offer.domain), availability, cents: usdCents(offer.price), url: safeOfferUrl(offer.url) };
}

function isTrackingHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return name === "buy.trychannel3.com" || name.endsWith(".buy.trychannel3.com");
}

/** The offer's `domain` as Channel3 reports it. Not a verified seller identity; a tracking host is not shown. */
function reportedDomain(value: unknown): string | null {
  const domain = plain(value, 253);
  if (!domain) return null;
  if (!/^[a-z0-9.-]{1,253}$/i.test(domain) || !domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  const host = domain.toLowerCase();
  return isTrackingHost(host) ? null : host;
}

/**
 * Documented price: `{ price: number, currency: string }` in major units. Only an exact `USD` currency and a finite,
 * positive amount with at most two decimals (and below USD 100,000) is accepted; anything else is unknown.
 */
function usdCents(value: unknown): number | null {
  if (!isRecord(value) || value.currency !== "USD") return null;
  const amount = value.price;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount >= 100_000) return null;
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6 || !Number.isSafeInteger(cents)) return null;
  return cents;
}

function safeOfferUrl(value: unknown): string | null {
  const parsed = parseSafeExternalUrl(value);
  return parsed.ok ? parsed.value : null;
}

/**
 * Production transport, installed by the runtime only from a valid configuration (CHANNEL3_DISCOVERY=on and a key).
 * Redirects are refused so the API key is not forwarded to another origin. Tests pass their own fetch.
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
          // Explicit US/USD locale and the documented default filters (new, in stock).
          body: JSON.stringify({
            query: request.query,
            limit: request.limit,
            filters: { conditions: ["new"], availability: ["InStock"] },
            config: { country: "US", currency: "USD" },
          }),
        },
        request.signal,
      );
    },
    detail(request) {
      return call(
        `${API_ORIGIN}/v1/products/${encodeURIComponent(request.productId)}?country=US&currency=USD`,
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
