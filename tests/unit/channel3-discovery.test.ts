import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { findMerchantVariant } from "@/lib/catalog/merchant-catalog";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import {
  CHANNEL3_LIMITS,
  CHANNEL3_LIVE_ACTIVATION,
  channel3ClientForProcess,
  channel3Query,
  createFetchChannel3Transport,
  readChannel3Listings,
  searchChannel3Listings,
  type Channel3Transport,
} from "@/lib/providers/channel3-discovery";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { confirmNeeds, needsDraftsFor, saveStructuredNeeds } from "@/lib/session/store";
import { handleNeedsListings, handleNeedsSession } from "@/server/handlers";
import { createRuntime } from "@/server/runtime";
import { HOUR, TEST_SESSION_KEY, createTestClock } from "./helpers";

const ORIGIN = "https://shop.example.test";
const RETRIEVED = "2026-10-15T16:00:00.000Z";

function draftInput(version = 1) {
  return { draftId: "nd_" + "ab".repeat(16), version };
}

function transport(overrides: Partial<Channel3Transport> = {}): Channel3Transport & { searches: number; details: string[] } {
  const state = { searches: 0, details: [] as string[] };
  const search = overrides.search ?? (async () => ({ ok: true as const, body: { products: [] } }));
  const detail = overrides.detail ?? (async (request: { productId: string }) => ({ ok: true as const, body: { id: request.productId, title: "Laptop", offers: [] } }));
  return {
    get searches() {
      return state.searches;
    },
    get details() {
      return state.details;
    },
    async search(request) {
      state.searches += 1;
      return search(request);
    },
    async detail(request) {
      state.details.push(request.productId);
      return detail(request);
    },
  };
}

function run(store: object, client: Channel3Transport, current: { draftId: string; version: number }, limits: { actionDeadlineMs?: number; requestTimeoutMs?: number } = {}) {
  return searchChannel3Listings({
    store,
    sessionId: "session-1",
    draftId: current.draftId,
    version: current.version,
    use: "schoolwork",
    budgetDollars: "580",
    transport: client,
    currentDraft: () => current,
    now: () => RETRIEVED,
    ...limits,
  });
}

describe("Channel3 discovery", () => {
  it("keeps live activation disabled and does not install the fetch transport", () => {
    expect(CHANNEL3_LIVE_ACTIVATION).toBe(false);
    expect(channel3ClientForProcess({ CHANNEL3_DISCOVERY: "on", CHANNEL3_API_KEY: "channel3-test-key" })).toBe("disabled");
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) });
    expect(runtime.channel3.mode).toBe("disabled");
    const source = readFileSync("src/server/runtime.ts", "utf8");
    expect(source).not.toMatch(/createFetchChannel3Transport/);
    expect(source).toContain('from "@/lib/providers/channel3-discovery"');
    const adapter = readFileSync("src/lib/providers/channel3-discovery.ts", "utf8");
    expect(adapter).toContain("process-local");
    expect(adapter).toContain("reset when the process restarts");
    expect(adapter).not.toMatch(/readiness\/engine|payment\/orchestrator|quote\/quote|x-user-id/);
    expect(CHANNEL3_LIMITS).toEqual({
      maxActionsPerSession: 3,
      maxSearchCallsPerAction: 1,
      maxDetailCallsPerAction: 5,
      actionDeadlineMs: 8_000,
      requestTimeoutMs: 2_000,
      maxResponseBytes: 262_144,
    });
  });

  it("builds the query from the confirmed use and budget", () => {
    expect(channel3Query("programming", "900")).toBe("laptop for programming under 900 USD");
    expect(channel3Query("schoolwork", "580")).not.toContain("please buy");
  });

  it("selects price, seller, and link from one detail offer and ignores the tracking hostname and brand", async () => {
    const store = {};
    const current = draftInput();
    const client = transport({
      async search(request) {
        expect(request.query).toBe("laptop for schoolwork under 580 USD");
        expect(request.limit).toBe(5);
        return {
          ok: true,
          body: {
            products: [{ id: "abc", title: "Search title", image: "https://cdn.example/secret.png", brand: "Acer" }],
          },
        };
      },
      async detail(request) {
        expect(request.productId).toBe("abc");
        return {
          ok: true,
          body: {
            id: "abc",
            title: "Detail title",
            image: "https://cdn.example/secret.png",
            brand: "Acer",
            offers: [
              {
                retailer: "Example Retailer",
                domain: "buy.trychannel3.com",
                url: "https://shop.example/buy",
                price: { currency: "USD", amount: "19.99" },
              },
            ],
          },
        };
      },
    });
    const result = await run(store, client, current);
    expect(result).toEqual({
      status: "ready",
      retrievedAt: RETRIEVED,
      listings: [
        {
          externalId: "ext_abc",
          title: "Detail title",
          sellerLabel: "Example Retailer",
          indicativePriceCents: 1999,
          url: "https://shop.example/buy",
          retrievedAt: RETRIEVED,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret.png");
    expect(findMerchantVariant(DEMO_MERCHANT_CATALOG, "ext_abc", "dmv_aspirego15")).toBeNull();
  });

  it("does not treat a tracking hostname as the retailer and drops a mismatched detail", async () => {
    const store = {};
    const current = draftInput();
    const client = transport({
      async search() {
        return { ok: true, body: { products: [{ id: "tracked", title: "Tracked" }, { id: "other", title: "Other" }] } };
      },
      async detail(request) {
        if (request.productId === "tracked") {
          return {
            ok: true,
            body: {
              id: "tracked",
              title: "Tracked",
              offers: [{ domain: "www.buy.trychannel3.com", url: "https://buy.trychannel3.com/click", price: { currency: "USD", amount: "10.00" } }],
            },
          };
        }
        return { ok: true, body: { id: "not-the-request", title: "Wrong", offers: [{ retailer: "Nope", url: "https://shop.example/no", price: { currency: "USD", amount: "5.00" } }] } };
      },
    });
    const result = await run(store, client, current);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.listings).toEqual([
      {
        externalId: "ext_tracked",
        title: "Tracked",
        sellerLabel: null,
        indicativePriceCents: 1000,
        url: "https://buy.trychannel3.com/click",
        retrievedAt: RETRIEVED,
      },
    ]);
  });

  it("uses a non-tracking domain from the same offer and withholds price and link when the offer is ambiguous", async () => {
    const store = {};
    const current = draftInput();
    const client = transport({
      async search() {
        return { ok: true, body: { products: [{ id: "dom", title: "Domain" }, { id: "many", title: "Many" }] } };
      },
      async detail(request) {
        if (request.productId === "dom") {
          return {
            ok: true,
            body: {
              id: "dom",
              title: "Domain",
              brand: "Acer",
              offers: [{ domain: "laptops.example", url: "https://buy.trychannel3.com/click", price: { currency: "USD", amount: "10.00" } }],
            },
          };
        }
        return {
          ok: true,
          body: {
            id: "many",
            title: "Many",
            offers: [
              { retailer: "One", url: "https://one.example/buy", price: { currency: "USD", amount: "1.00" } },
              { retailer: "Two", url: "https://two.example/buy", price: { currency: "USD", amount: "2.00" } },
            ],
          },
        };
      },
    });
    const result = await run(store, client, current);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.listings.map((listing) => listing.sellerLabel)).toEqual(["laptops.example", null]);
    expect(result.listings[1]).toMatchObject({ indicativePriceCents: null, url: null });
    expect(JSON.stringify(result.listings[0])).not.toContain("Acer");
  });

  it("stops after one search and five detail calls, and makes no detail call when search fails", async () => {
    const store = {};
    const ids = ["a", "b", "c", "d", "e", "f"];
    const client = transport({
      async search() {
        return { ok: true, body: { products: ids.map((id) => ({ id, title: `Laptop ${id}` })) } };
      },
    });
    const ready = await run(store, client, draftInput());
    expect(client.searches).toBe(1);
    expect(client.details).toEqual(["a", "b", "c", "d", "e"]);
    expect(ready.status).toBe("ready");

    const failed = transport({
      async search() {
        return { ok: false, code: "HTTP_STATUS" };
      },
    });
    const error = await run({}, failed, draftInput());
    expect(error.status).toBe("error");
    expect(failed.details).toEqual([]);
  });

  it("counts a failed action, blocks the fourth before a request, and reuses a completed result", async () => {
    const store = {};
    const current = draftInput();
    const client = transport({
      async search() {
        return { ok: false, code: "TRANSPORT" };
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await run(store, client, current)).status).toBe("error");
    }
    expect(client.searches).toBe(3);
    expect((await run(store, client, current)).status).toBe("limit");
    expect(client.searches).toBe(3);
    expect(readChannel3Listings(store, "session-1", current.draftId, current.version)).toEqual({ status: "error" });

    const again = {};
    const success = transport();
    expect((await run(again, success, current)).status).toBe("ready");
    expect((await run(again, success, current)).status).toBe("ready");
    expect(success.searches).toBe(1);
  });

  it("joins a concurrent click and discards a stale result while keeping the action counted", async () => {
    const store = {};
    const current = draftInput();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = transport({
      async search() {
        await gate;
        return { ok: true, body: { products: [] } };
      },
    });
    const first = run(store, client, current);
    const second = run(store, client, current);
    release();
    expect(await Promise.all([first, second])).toEqual([
      { status: "ready", listings: [], retrievedAt: RETRIEVED },
      { status: "ready", listings: [], retrievedAt: RETRIEVED },
    ]);
    expect(client.searches).toBe(1);

    const moved = { ...draftInput(), version: 1 };
    const staleStore = {};
    const staleClient = transport({
      async search() {
        moved.version = 2;
        return { ok: true, body: { products: [{ id: "abc", title: "Laptop" }] } };
      },
    });
    const stale = await run(staleStore, staleClient, moved);
    expect(stale.status).toBe("stale");
    expect(staleClient.searches).toBe(1);
    expect(staleClient.details).toEqual([]);
    expect(readChannel3Listings(staleStore, "session-1", moved.draftId, 1)).toBeNull();
    const follow = transport({
      async search() {
        return { ok: false, code: "TRANSPORT" };
      },
    });
    expect((await run(staleStore, follow, { draftId: moved.draftId, version: 2 })).status).toBe("error");
    expect((await run(staleStore, follow, { draftId: moved.draftId, version: 2 })).status).toBe("error");
    expect((await run(staleStore, follow, { draftId: moved.draftId, version: 2 })).status).toBe("limit");
    expect(follow.searches).toBe(2);
  });

  it("applies the action deadline and the per-request timeout before later requests", async () => {
    const blocked = transport();
    expect((await run({}, blocked, draftInput(), { actionDeadlineMs: 0 })).status).toBe("error");
    expect(blocked.searches).toBe(0);

    let details = 0;
    const slow = transport({
      async search() {
        return await new Promise(() => undefined);
      },
      async detail() {
        details += 1;
        return { ok: false, code: "TRANSPORT" };
      },
    });
    expect((await run({}, slow, draftInput(), { actionDeadlineMs: 40, requestTimeoutMs: 20 })).status).toBe("error");
    expect(details).toBe(0);
  });

  it("keeps each session's action budget and joins only that session's pending action", async () => {
    const store = {};
    const current = draftInput();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = transport({
      async search() {
        await gate;
        return { ok: false, code: "TRANSPORT" };
      },
    });
    const first = run(store, client, current);
    const repeat = run(store, client, current);
    const other = searchChannel3Listings({
      store,
      sessionId: "session-2",
      draftId: current.draftId,
      version: current.version,
      use: "schoolwork",
      budgetDollars: "580",
      transport: client,
      currentDraft: () => current,
      now: () => RETRIEVED,
    });
    expect(client.searches).toBe(2);
    expect(readChannel3Listings(store, "session-1", current.draftId, current.version)).toEqual({ status: "pending" });
    expect(readChannel3Listings(store, "session-2", current.draftId, current.version)).toEqual({ status: "pending" });
    release();
    expect(await first).toEqual(await repeat);
    expect((await other).status).toBe("error");

    const more = transport({
      async search() {
        return { ok: false, code: "TRANSPORT" };
      },
    });
    expect((await run(store, more, current)).status).toBe("error");
    expect((await run(store, more, current)).status).toBe("error");
    expect((await run(store, more, current)).status).toBe("limit");
    expect(more.searches).toBe(2);
    expect((await searchChannel3Listings({
      store,
      sessionId: "session-2",
      draftId: current.draftId,
      version: current.version,
      use: "schoolwork",
      budgetDollars: "580",
      transport: more,
      currentDraft: () => current,
      now: () => RETRIEVED,
    })).status).toBe("error");
    expect(more.searches).toBe(3);
  });

  it("returns the deadline error when a detail call outlives the action and does not store a ready result", async () => {
    const store = {};
    const current = draftInput();
    let details = 0;
    const client = transport({
      async search() {
        return {
          ok: true,
          body: {
            products: [
              { id: "one", title: "First laptop" },
              { id: "two", title: "Second laptop" },
            ],
          },
        };
      },
      async detail(request) {
        details += 1;
        if (request.productId === "one") {
          return {
            ok: true,
            body: {
              id: "one",
              title: "First laptop",
              offers: [{ retailer: "Example Retailer", url: "https://shop.example/buy", price: { currency: "USD", amount: "10.00" } }],
            },
          };
        }
        return await new Promise(() => undefined);
      },
    });
    const result = await run(store, client, current, { actionDeadlineMs: 40, requestTimeoutMs: 2_000 });
    expect(result).toEqual({ status: "error" });
    expect(details).toBe(2);
    expect(readChannel3Listings(store, "session-1", current.draftId, current.version)).toEqual({ status: "error" });
  });

  it("refuses redirects, caps the body, and keeps the key out of the result", async () => {
    const key = "channel3-test-key";
    const calls: RequestInit[] = [];
    const redirecting = createFetchChannel3Transport(key, async (_url, init) => {
      calls.push(init ?? {});
      throw new TypeError("unexpected redirect");
    });
    const signal = new AbortController().signal;
    const redirected = await redirecting.search({ query: "laptop", limit: 5, signal });
    expect(redirected).toEqual({ ok: false, code: "REDIRECT" });
    expect(JSON.stringify(redirected)).not.toContain(key);
    expect(calls[0]?.redirect).toBe("error");
    expect(new Headers(calls[0]?.headers).get("x-user-id")).toBeNull();
    expect(new Headers(calls[0]?.headers).get("x-api-key")).toBe(key);

    const oversized = createFetchChannel3Transport(key, async () => new Response("{}", { headers: { "content-length": String(CHANNEL3_LIMITS.maxResponseBytes + 1) } }));
    expect(await oversized.detail({ productId: "abc", signal })).toEqual({ ok: false, code: "BODY_TOO_LARGE" });

    const streamed = createFetchChannel3Transport(key, async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(200_000));
          controller.enqueue(new Uint8Array(200_000));
          controller.close();
        },
      });
      return new Response(stream);
    });
    expect(await streamed.search({ query: "laptop", limit: 5, signal })).toEqual({ ok: false, code: "BODY_TOO_LARGE" });

    const urls: string[] = [];
    const ok = createFetchChannel3Transport(key, async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
    });
    expect(await ok.detail({ productId: "abc", signal })).toEqual({ ok: true, body: { id: "abc" } });
    expect(urls).toEqual(["https://api.trychannel3.com/v1/products/abc"]);
  });

  it("answers the shopper action as unavailable and does not call fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
    const started = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
    const token = started.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    const session = await runtime.sessions.resolve(token);
    if (!session.ok) throw new Error("session missing");
    const draft = saveStructuredNeeds(runtime.store, session.value.id, {
      submittedVersion: null,
      language: "en",
      shopperText: "",
      use: "schoolwork",
      budgetDollars: "580",
      notice: "review",
      expiresAtMs: time.clock().getTime() + HOUR,
      now: time.clock().getTime(),
    });
    if (typeof draft === "string") throw new Error(draft);
    const confirmed = confirmNeeds(runtime.store, session.value.id, { draftId: draft.draftId, version: draft.version, use: "schoolwork", budgetDollars: "580", now: time.clock().getTime() });
    if (typeof confirmed === "string") throw new Error(confirmed);
    const response = await handleNeedsListings(
      new Request(`${ORIGIN}/shop/needs/listings`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
        body: new URLSearchParams({
          csrfToken: session.value.csrfToken,
          draftId: draft.draftId,
          version: String(draft.version),
          lang: "en",
        }).toString(),
      }),
      runtime,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/en/shop/needs?listings=unavailable");
    expect(runtime.channel3.search).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(needsDraftsFor(runtime.store).get(session.value.id)?.confirmedUse).toBe("schoolwork");
    fetchSpy.mockRestore();
  });

  it("runs the handler through an injected coordinator and keeps sessions, guards, and stale results apart", async () => {
    const calls = { searches: 0 };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) },
      {
        clock: time.clock,
        channel3Transport: {
          async search() {
            calls.searches += 1;
            if (release) await gate;
            return { ok: false, code: "TRANSPORT" };
          },
          async detail() {
            return { ok: false, code: "TRANSPORT" };
          },
        },
      },
    );
    const buyer = await shopper(runtime);
    const stranger = await shopper(runtime);
    const denied = await handleNeedsListings(post("/shop/needs/listings", { lang: "en", draftId: `nd_${"ab".repeat(16)}`, version: "1" }, buyer.cookie), runtime);
    expect(denied.status).toBe(403);
    expect(calls.searches).toBe(0);

    const draft = saveStructuredNeeds(runtime.store, buyer.sessionId, {
      submittedVersion: null,
      language: "en",
      shopperText: "",
      use: "schoolwork",
      budgetDollars: "580",
      notice: "review",
      expiresAtMs: time.clock().getTime() + HOUR,
      now: time.clock().getTime(),
    });
    if (typeof draft === "string") throw new Error(draft);
    const unconfirmed = await handleNeedsListings(listingPost(buyer, draft.draftId, draft.version), runtime);
    expect(unconfirmed.headers.get("location")).toContain("error=CONFIRM_INCOMPLETE");
    const confirmed = confirmNeeds(runtime.store, buyer.sessionId, {
      draftId: draft.draftId,
      version: draft.version,
      use: "schoolwork",
      budgetDollars: "580",
      now: time.clock().getTime(),
    });
    if (typeof confirmed === "string") throw new Error(confirmed);

    const wrongVersion = await handleNeedsListings(listingPost(buyer, draft.draftId, draft.version + 9), runtime);
    expect(wrongVersion.headers.get("location")).toContain("error=STALE_DRAFT");
    const owned = await handleNeedsListings(listingPost(stranger, draft.draftId, draft.version), runtime);
    expect(owned.headers.get("location")).toContain("error=DRAFT_NOT_FOUND");
    expect(calls.searches).toBe(0);

    const first = handleNeedsListings(listingPost(buyer, draft.draftId, draft.version), runtime);
    const repeat = handleNeedsListings(listingPost(buyer, draft.draftId, draft.version), runtime);
    for (let attempt = 0; attempt < 50 && calls.searches < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.channel3.read(buyer.sessionId, draft.draftId, draft.version)).toEqual({ status: "pending" });
    expect(calls.searches).toBe(1);
    if (!release) throw new Error("gate missing");
    release();
    release = undefined;
    expect((await first).headers.get("location")).toBe("/en/shop/needs?listings=error");
    expect((await repeat).headers.get("location")).toBe("/en/shop/needs?listings=error");
    expect(calls.searches).toBe(1);

    expect((await handleNeedsListings(listingPost(buyer, draft.draftId, draft.version), runtime)).headers.get("location")).toContain("listings=error");
    expect((await handleNeedsListings(listingPost(buyer, draft.draftId, draft.version), runtime)).headers.get("location")).toContain("listings=error");
    expect((await handleNeedsListings(listingPost(buyer, draft.draftId, draft.version), runtime)).headers.get("location")).toContain("listings=limit");
    expect(calls.searches).toBe(3);
    expect((await handleNeedsListings(listingPost(stranger, draft.draftId, 1), runtime)).headers.get("location")).toContain("error=DRAFT_NOT_FOUND");

    const strangerDraft = saveStructuredNeeds(runtime.store, stranger.sessionId, {
      submittedVersion: null,
      language: "en",
      shopperText: "",
      use: "programming",
      budgetDollars: "900",
      notice: "review",
      expiresAtMs: time.clock().getTime() + HOUR,
      now: time.clock().getTime(),
    });
    if (typeof strangerDraft === "string") throw new Error(strangerDraft);
    const strangerConfirmed = confirmNeeds(runtime.store, stranger.sessionId, {
      draftId: strangerDraft.draftId,
      version: strangerDraft.version,
      use: "programming",
      budgetDollars: "900",
      now: time.clock().getTime(),
    });
    if (typeof strangerConfirmed === "string") throw new Error(strangerConfirmed);
    const strangerResult = await handleNeedsListings(listingPost(stranger, strangerDraft.draftId, strangerDraft.version), runtime);
    expect(strangerResult.headers.get("location")).toContain("listings=error");
    expect(calls.searches).toBe(4);

    let staleSessionId = "";
    const staleRuntime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) },
      {
        clock: time.clock,
        channel3Transport: {
          async search() {
            const live = needsDraftsFor(staleRuntime.store).get(staleSessionId);
            if (live) needsDraftsFor(staleRuntime.store).set(staleSessionId, { ...live, version: live.version + 1 });
            return { ok: true, body: { products: [{ id: "abc", title: "Laptop" }] } };
          },
          async detail() {
            return { ok: true, body: { id: "abc", title: "Laptop", offers: [] } };
          },
        },
      },
    );
    const movedBuyer = await shopper(staleRuntime);
    staleSessionId = movedBuyer.sessionId;
    const movedDraft = saveStructuredNeeds(staleRuntime.store, movedBuyer.sessionId, {
      submittedVersion: null,
      language: "en",
      shopperText: "",
      use: "schoolwork",
      budgetDollars: "580",
      notice: "review",
      expiresAtMs: time.clock().getTime() + HOUR,
      now: time.clock().getTime(),
    });
    if (typeof movedDraft === "string") throw new Error(movedDraft);
    const movedConfirmed = confirmNeeds(staleRuntime.store, movedBuyer.sessionId, {
      draftId: movedDraft.draftId,
      version: movedDraft.version,
      use: "schoolwork",
      budgetDollars: "580",
      now: time.clock().getTime(),
    });
    if (typeof movedConfirmed === "string") throw new Error(movedConfirmed);
    const stale = await handleNeedsListings(listingPost(movedBuyer, movedDraft.draftId, movedDraft.version), staleRuntime);
    expect(stale.headers.get("location")).toBe("/en/shop/needs?listings=stale");
    expect(staleRuntime.channel3.read(movedBuyer.sessionId, movedDraft.draftId, movedDraft.version)?.status).not.toBe("ready");
  });
});

function post(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

function listingPost(buyer: { cookie: string; csrfToken: string }, draftId: string, version: number): Request {
  return post("/shop/needs/listings", { lang: "en", csrfToken: buyer.csrfToken, draftId, version: String(version) }, buyer.cookie);
}

async function shopper(runtime: ReturnType<typeof createRuntime>) {
  const started = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
  const token = started.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session missing");
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}
