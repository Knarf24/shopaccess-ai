import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { confirmNeeds, saveStructuredNeeds } from "@/lib/session/store";
import {
  createFetchChannel3Transport,
  searchChannel3Listings,
  type Channel3Response,
  type Channel3Transport,
} from "@/lib/providers/channel3-discovery";
import { DEFAULT_CHANNEL3_LIMITS, parseChannel3Config, parseChannel3Limits } from "@/server/channel3-config";
import { parseRuntimeConfig } from "@/server/config";
import { handleCheckoutStart, handleNeedsListings, handleNeedsSession } from "@/server/handlers";
import { createRuntime, type Channel3SearchRequest, type Runtime } from "@/server/runtime";
import { HOUR, TEST_SESSION_KEY, createTestClock } from "./helpers";

const ORIGIN = "https://shop.example.test";
const RETRIEVED = "2026-10-23T12:00:00.000Z";
const KEY = "channel3-test-key-not-real";
const APPLICATION_KEY = Symbol.for("shopaccess.application");
const ENV = {
  SHOPACCESS_SESSION_KEY: TEST_SESSION_KEY.toString("base64"),
  SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
  PAYMENT_PROVIDER_MODE: "mock",
  CHANNEL3_DISCOVERY: "on",
  CHANNEL3_API_KEY: KEY,
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of [...Object.keys(ENV), "CHANNEL3_LIMIT_PER_SESSION", "CHANNEL3_LIMIT_PER_HOUR", "CHANNEL3_LIMIT_PER_DAY"]) delete process.env[key];
  delete (globalThis as Record<symbol, unknown>)[APPLICATION_KEY];
});

function counting(search: () => Promise<Channel3Response> = async () => ({ ok: false, code: "TRANSPORT" })) {
  const calls = { searches: 0, details: 0 };
  const transport: Channel3Transport = {
    async search() {
      calls.searches += 1;
      return search();
    },
    async detail() {
      calls.details += 1;
      return { ok: false, code: "TRANSPORT" };
    },
  };
  return { calls, transport };
}

function runtimeWith(transport: Channel3Transport, env: Record<string, string> = {}, clock = createTestClock(RETRIEVED).clock): Runtime {
  const config = parseRuntimeConfig({ SHOPACCESS_SESSION_KEY: ENV.SHOPACCESS_SESSION_KEY, SHOPACCESS_TRUSTED_ORIGINS: ORIGIN, PAYMENT_PROVIDER_MODE: "mock", ...env });
  if (!config.ok) throw new Error(config.error.join(","));
  return createRuntime(config.value, { clock, channel3Transport: transport });
}

let draftCounter = 0;
function request(sessionId: string): Channel3SearchRequest {
  draftCounter += 1;
  const current = { draftId: `nd_${draftCounter.toString(16).padStart(32, "0")}`, version: 1 };
  return { sessionId, ...current, use: "programming", budgetDollars: "900", currentDraft: () => current, now: () => RETRIEVED };
}

describe("Channel3 configuration", () => {
  it("is off when absent, live only with discovery=on and a valid key, and fails closed otherwise without copying values", () => {
    expect(parseChannel3Config({})).toEqual({ ok: true, value: { mode: "off" } });
    expect(parseChannel3Config({ CHANNEL3_DISCOVERY: "on", CHANNEL3_API_KEY: KEY })).toEqual({ ok: true, value: { mode: "live", apiKey: KEY } });
    expect(parseChannel3Config({ CHANNEL3_DISCOVERY: "on" })).toEqual({ ok: false, error: ["CHANNEL3_API_KEY_MISSING"] });
    expect(parseChannel3Config({ CHANNEL3_API_KEY: KEY })).toEqual({ ok: false, error: ["CHANNEL3_DISCOVERY_INVALID"] });
    expect(parseChannel3Config({ CHANNEL3_DISCOVERY: "true", CHANNEL3_API_KEY: KEY })).toEqual({ ok: false, error: ["CHANNEL3_DISCOVERY_INVALID"] });
    for (const bad of ["", "has space", "x".repeat(257), "line\nbreak"]) {
      expect(parseChannel3Config({ CHANNEL3_DISCOVERY: "on", CHANNEL3_API_KEY: bad })).toEqual({ ok: false, error: ["CHANNEL3_API_KEY_INVALID"] });
    }
    const runtime = parseRuntimeConfig({ ...ENV, CHANNEL3_API_KEY: "has space" });
    expect(runtime.ok).toBe(false);
    if (!runtime.ok) expect(runtime.error).toContain("CHANNEL3_API_KEY_INVALID");
    expect(JSON.stringify(runtime)).not.toContain("has space");
    const live = parseRuntimeConfig(ENV);
    expect(live.ok && live.value.channel3).toEqual({ mode: "live", apiKey: KEY });
    const off = parseRuntimeConfig({ SHOPACCESS_SESSION_KEY: ENV.SHOPACCESS_SESSION_KEY, SHOPACCESS_TRUSTED_ORIGINS: ORIGIN });
    expect(off.ok && "channel3" in off.value).toBe(false);
  });

  it("defaults to 3 per session, 10 per hour and 30 per day and parses overrides strictly", () => {
    expect(DEFAULT_CHANNEL3_LIMITS).toEqual({ perSession: 3, perHour: 10, perDay: 30 });
    expect(parseChannel3Limits({})).toEqual({ ok: true, value: null });
    expect(parseChannel3Limits({ CHANNEL3_LIMIT_PER_DAY: "2" })).toEqual({ ok: true, value: { perSession: 3, perHour: 10, perDay: 2 } });
    for (const bad of ["0", "-1", "1.5", "1001", "", " 2", "02"]) {
      expect(parseChannel3Limits({ CHANNEL3_LIMIT_PER_HOUR: bad })).toEqual({ ok: false, error: "CHANNEL3_LIMITS_INVALID" });
    }
  });
});

describe("Channel3 documented schema", () => {
  async function listingFor(detail: unknown, searchBody: unknown = { products: [{ id: "abc", title: "Search title" }] }) {
    const current = { draftId: "nd_" + "cd".repeat(16), version: 1 };
    return searchChannel3Listings({
      store: {},
      sessionId: "s",
      ...current,
      use: "programming",
      budgetDollars: "900",
      transport: {
        async search() {
          return { ok: true, body: searchBody };
        },
        async detail() {
          return { ok: true, body: detail };
        },
      },
      currentDraft: () => current,
      now: () => RETRIEVED,
      reserve: () => true,
    });
  }
  const offer = (overrides: Record<string, unknown> = {}) => ({
    url: "https://shop.example/buy",
    domain: "shop.example",
    price: { price: 579.99, currency: "USD" },
    availability: "InStock",
    ...overrides,
  });
  const unknown = { reportedDomain: null, reportedAvailability: null, indicativePriceCents: null, url: null };

  it("accepts exactly one in-stock USD offer with a valid price and safe link", async () => {
    const result = await listingFor({ id: "abc", title: "Laptop", offers: [offer()] });
    expect(result).toMatchObject({ status: "ready", listings: [{ externalId: "ext_abc", title: "Laptop", reportedDomain: "shop.example", reportedAvailability: "InStock", indicativePriceCents: 57999, url: "https://shop.example/buy" }] });
  });

  it.each([
    ["the undocumented amount field", { price: { amount: "579.99", currency: "USD" } }],
    ["a string price", { price: { price: "579.99", currency: "USD" } }],
    ["a non-USD currency", { price: { price: 579.99, currency: "CAD" } }],
    ["a lower-case currency", { price: { price: 579.99, currency: "usd" } }],
    ["a missing currency", { price: { price: 579.99 } }],
    ["a zero price", { price: { price: 0, currency: "USD" } }],
    ["a negative price", { price: { price: -5, currency: "USD" } }],
    ["more than two decimals", { price: { price: 579.999, currency: "USD" } }],
    ["an implausibly large price", { price: { price: 100_000, currency: "USD" } }],
    ["a missing price", { price: undefined }],
    ["an http link", { url: "http://shop.example/buy" }],
    ["a missing link", { url: undefined }],
  ])("treats %s as unknown instead of inventing a value", async (_label, overrides) => {
    const result = await listingFor({ id: "abc", title: "Laptop", offers: [offer(overrides)] });
    expect(result).toMatchObject({ status: "ready", listings: [{ externalId: "ext_abc", indicativePriceCents: null, url: null, reportedDomain: null }] });
  });

  it("reports documented availability only, and never prices an out-of-stock or unknown offer", async () => {
    const out = await listingFor({ id: "abc", title: "Laptop", offers: [offer({ availability: "OutOfStock" })] });
    expect(out).toMatchObject({ status: "ready", listings: [{ ...unknown, reportedAvailability: "OutOfStock" }] });
    for (const availability of [undefined, "in_stock", "PreOrder", true]) {
      const result = await listingFor({ id: "abc", title: "Laptop", offers: [offer({ availability })] });
      expect(result).toMatchObject({ status: "ready", listings: [unknown] });
    }
    const mixed = await listingFor({ id: "abc", title: "Laptop", offers: [offer({ availability: "OutOfStock" }), offer({ availability: "InStock", price: { price: 1, currency: "EUR" } })] });
    expect(mixed).toMatchObject({ status: "ready", listings: [unknown] });
    const none = await listingFor({ id: "abc", title: "Laptop", offers: [] });
    expect(none).toMatchObject({ status: "ready", listings: [unknown] });
  });

  it("chooses the single usable offer among unusable ones, and withholds everything when two qualify", async () => {
    const one = await listingFor({ id: "abc", title: "Laptop", offers: [offer({ availability: "OutOfStock" }), offer({ domain: "two.example", url: "https://two.example/x" })] });
    expect(one).toMatchObject({ status: "ready", listings: [{ reportedDomain: "two.example", indicativePriceCents: 57999 }] });
    const two = await listingFor({ id: "abc", title: "Laptop", offers: [offer(), offer({ domain: "two.example" })] });
    expect(two).toMatchObject({ status: "ready", listings: [unknown] });
  });

  it("rejects malformed domains, ignores undocumented seller fields, and keeps a tracking host out of the website label", async () => {
    for (const domain of ["not a domain", "localhost", ".example.", 42, null]) {
      const result = await listingFor({ id: "abc", title: "Laptop", offers: [offer({ domain })] });
      expect(result).toMatchObject({ status: "ready", listings: [{ reportedDomain: null, indicativePriceCents: 57999 }] });
    }
    const retailer = await listingFor({ id: "abc", title: "Laptop", offers: [offer({ domain: undefined, retailer: "Verified Seller Inc" })] });
    expect(JSON.stringify(retailer)).not.toContain("Verified Seller");
    const tracked = await listingFor({ id: "abc", title: "Laptop", offers: [offer({ domain: "buy.trychannel3.com" })] });
    expect(tracked).toMatchObject({ status: "ready", listings: [{ reportedDomain: null }] });
  });

  it("uses only the documented search shape and handles malformed bodies without listings", async () => {
    for (const searchBody of [{ results: [{ id: "abc", title: "Old shape" }] }, { products: [{ product_id: "abc", name: "Old" }] }, { products: "abc" }, {}]) {
      expect(await listingFor({ id: "abc", title: "Laptop", offers: [offer()] }, searchBody)).toEqual({ status: "ready", listings: [], retrievedAt: RETRIEVED });
    }
    for (const searchBody of [null, [], "text", 42]) {
      expect((await listingFor({}, searchBody)).status).toBe("error");
    }
    for (const detail of [null, [], "text", { id: "other", title: "Wrong product", offers: [offer()] }]) {
      expect(await listingFor(detail)).toEqual({ status: "ready", listings: [], retrievedAt: RETRIEVED });
    }
  });
});

describe("Channel3 budget bound", () => {
  // The confirmed budget is sent as the documented inclusive max_price AND enforced locally on every parsed offer.
  async function run(budget: string, offers: unknown[], capture?: (request: { maxPriceDollars: number }) => void) {
    const current = { draftId: "nd_" + "ef".repeat(16), version: 1 };
    let reserved = 0;
    const result = await searchChannel3Listings({
      store: {},
      sessionId: "s",
      ...current,
      use: "programming",
      budgetDollars: budget,
      transport: {
        async search(request) {
          capture?.(request);
          return { ok: true, body: { products: [{ id: "abc", title: "Laptop" }] } };
        },
        async detail() {
          return { ok: true, body: { id: "abc", title: "Laptop", offers } };
        },
      },
      currentDraft: () => current,
      now: () => RETRIEVED,
      reserve: () => {
        reserved += 1;
        return true;
      },
    });
    return { result, reserved };
  }
  const offer = (price: number, overrides: Record<string, unknown> = {}) => ({
    url: "https://shop.example/buy",
    domain: "shop.example",
    price: { price, currency: "USD" },
    availability: "InStock",
    ...overrides,
  });
  const withheld = { reportedDomain: null, indicativePriceCents: null, url: null };

  it("sends the confirmed budget as the inclusive max_price", async () => {
    let sent = 0;
    await run("900", [offer(579.99)], (request) => {
      sent = request.maxPriceDollars;
    });
    expect(sent).toBe(900);
  });

  it("prices an in-stock USD offer below and exactly at the budget", async () => {
    expect((await run("900", [offer(579.99)])).result).toMatchObject({ status: "ready", listings: [{ indicativePriceCents: 57999, url: "https://shop.example/buy" }] });
    expect((await run("900", [offer(900)])).result).toMatchObject({ status: "ready", listings: [{ indicativePriceCents: 90000, url: "https://shop.example/buy" }] });
  });

  it("never prices or links an offer above the budget, even by one cent, when the provider ignores the filter", async () => {
    for (const price of [900.01, 1099.99, 1868]) {
      const { result } = await run("900", [offer(price)]);
      expect(result).toMatchObject({ status: "ready", listings: [{ externalId: "ext_abc", ...withheld }] });
      expect(JSON.stringify(result)).not.toContain("https://shop.example/buy");
    }
  });

  it("uses the single in-budget offer when another offer is over budget, and still withholds when two are in budget", async () => {
    const one = await run("600", [offer(1099.99, { domain: "dell.example", url: "https://dell.example/x" }), offer(579, { domain: "ok.example", url: "https://ok.example/y" })]);
    expect(one.result).toMatchObject({ status: "ready", listings: [{ indicativePriceCents: 57900, reportedDomain: "ok.example", url: "https://ok.example/y" }] });
    const two = await run("600", [offer(546.03), offer(579, { domain: "two.example", url: "https://two.example/z" }), offer(629.99)]);
    expect(two.result).toMatchObject({ status: "ready", listings: [{ ...withheld, reportedAvailability: null }] });
  });

  it("keeps USD, availability and link rules alongside the budget", async () => {
    for (const bad of [offer(500, { price: { price: 500, currency: "CAD" } }), offer(500, { availability: "OutOfStock" }), offer(500, { url: "http://shop.example/buy" })]) {
      expect((await run("900", [bad])).result).toMatchObject({ status: "ready", listings: [withheld] });
    }
  });

  it("reserves and sends nothing without a valid whole-dollar budget", async () => {
    for (const budget of ["", "0", "9", "900.50", "100000", "abc"]) {
      let searched = false;
      const { result, reserved } = await run(budget, [offer(1)], () => {
        searched = true;
      });
      expect(result).toEqual({ status: "error" });
      expect(reserved).toBe(0);
      expect(searched).toBe(false);
    }
  });
});

describe("Channel3 transport", () => {
  it("requests US/USD explicitly with the documented in-stock filter, sends no user id, and maps HTTP and body failures", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = createFetchChannel3Transport(KEY, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ products: [] }), { status: 200 });
    });
    const signal = new AbortController().signal;
    await ok.search({ query: "laptop for programming under 900 USD", limit: 5, maxPriceDollars: 900, signal });
    await ok.detail({ productId: "abc", signal });
    expect(calls[0]!.url).toBe("https://api.trychannel3.com/v1/search");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      query: "laptop for programming under 900 USD",
      limit: 5,
      filters: { conditions: ["new"], availability: ["InStock"], price: { max_price: 900 } },
      config: { country: "US", currency: "USD" },
    });
    expect(calls[1]!.url).toBe("https://api.trychannel3.com/v1/products/abc?country=US&currency=USD");
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("x-user-id")).toBeNull();
      expect(call.init.redirect).toBe("error");
    }
    for (const status of [401, 402, 404, 422, 429, 500]) {
      const failing = createFetchChannel3Transport(KEY, async () => new Response("{}", { status, headers: { "retry-after": "5" } }));
      const result = await failing.search({ query: "q", limit: 5, maxPriceDollars: 900, signal });
      expect(result).toEqual({ ok: false, code: "HTTP_STATUS" });
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
    const text = createFetchChannel3Transport(KEY, async () => new Response("<html>", { status: 200 }));
    expect(await text.search({ query: "q", limit: 5, maxPriceDollars: 900, signal })).toEqual({ ok: false, code: "NOT_JSON" });
    const network = createFetchChannel3Transport(KEY, async () => {
      throw new TypeError("fetch failed");
    });
    expect(await network.detail({ productId: "abc", signal })).toEqual({ ok: false, code: "TRANSPORT" });
  });
});

describe("Channel3 search limits", () => {
  it("reserves before the request, counts failures, and refuses the session's fourth action with no request", async () => {
    const { calls, transport } = counting();
    const runtime = runtimeWith(transport);
    const search = runtime.channel3.search!;
    for (let i = 0; i < 3; i += 1) expect((await search(request("ses_a"))).status).toBe("error");
    expect(calls.searches).toBe(3);
    expect((await search(request("ses_a"))).status).toBe("limit");
    expect(calls.searches).toBe(3);
    expect((await search(request("ses_b"))).status).toBe("error");
    expect(calls.searches).toBe(4);
  });

  it("applies the hour and day limits across sessions; hour rollover resets only the hour, never a session's allowance", async () => {
    const time = createTestClock("2026-10-23T12:59:00.000Z");
    const { calls, transport } = counting();
    const runtime = runtimeWith(transport, { CHANNEL3_LIMIT_PER_SESSION: "3", CHANNEL3_LIMIT_PER_HOUR: "2", CHANNEL3_LIMIT_PER_DAY: "3" }, time.clock);
    const search = runtime.channel3.search!;
    expect((await search(request("ses_a"))).status).toBe("error");
    expect((await search(request("ses_b"))).status).toBe("error");
    expect((await search(request("ses_c"))).status).toBe("limit"); // hour (2)
    expect(calls.searches).toBe(2);
    time.advance(2 * 60 * 1000); // 13:01, a new UTC hour
    expect((await search(request("ses_c"))).status).toBe("error");
    expect((await search(request("ses_d"))).status).toBe("limit"); // day (3)
    expect(calls.searches).toBe(3);
  });

  it("does not restore a live session's allowance at UTC day rollover", async () => {
    const time = createTestClock("2026-10-23T23:59:00.000Z");
    const { calls, transport } = counting();
    const runtime = runtimeWith(transport, { CHANNEL3_LIMIT_PER_SESSION: "1" }, time.clock);
    const search = runtime.channel3.search!;
    expect((await search(request("ses_a"))).status).toBe("error");
    time.advance(2 * 60 * 1000); // next UTC day
    expect((await search(request("ses_a"))).status).toBe("limit");
    expect((await search(request("ses_b"))).status).toBe("error");
    expect(calls.searches).toBe(2);
  });

  it("is atomic for concurrent actions: only the available capacity starts requests", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, transport } = counting(async () => {
      await gate;
      return { ok: false, code: "TRANSPORT" };
    });
    const runtime = runtimeWith(transport, { CHANNEL3_LIMIT_PER_DAY: "2" });
    const search = runtime.channel3.search!;
    const pending = ["ses_a", "ses_b", "ses_c", "ses_d"].map((id) => search(request(id)));
    release();
    const statuses = (await Promise.all(pending)).map((result) => result.status);
    expect(statuses.filter((status) => status === "limit")).toHaveLength(2);
    expect(calls.searches).toBe(2);
  });

  it("with the test limit of 2 per day, the third search action is refused by the app before any request", async () => {
    const { calls, transport } = counting();
    const runtime = runtimeWith(transport, { CHANNEL3_LIMIT_PER_DAY: "2" });
    const first = await shopperWithBrief(runtime, "programming", "900");
    const second = await shopperWithBrief(runtime, "schoolwork", "600");
    expect((await handleNeedsListings(listingPost(first), runtime)).headers.get("location")).toBe("/en/shop/needs?listings=error");
    expect((await handleNeedsListings(listingPost(second), runtime)).headers.get("location")).toBe("/en/shop/needs?listings=error");
    expect(calls.searches).toBe(2);
    const third = await shopperWithBrief(runtime, "general_productivity", "700");
    expect((await handleNeedsListings(listingPost(third), runtime)).headers.get("location")).toBe("/en/shop/needs?listings=limit");
    expect(calls.searches).toBe(2);
  });
});

describe("Channel3 across separately loaded route bundles", () => {
  it("copies of the runtime share one application and one limiter, and copies of the adapter share listing state", async () => {
    Object.assign(process.env, ENV, { CHANNEL3_LIMIT_PER_SESSION: "2" });
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);

    vi.resetModules();
    const routeOne = await import("@/server/runtime");
    const adapterOne = await import("@/lib/providers/channel3-discovery");
    const application = routeOne.getApplication();
    vi.resetModules();
    const routeTwo = await import("@/server/runtime");
    const adapterTwo = await import("@/lib/providers/channel3-discovery");
    expect(routeTwo).not.toBe(routeOne);
    expect(adapterTwo).not.toBe(adapterOne);
    expect(routeTwo.getApplication()).toBe(application);

    const one = routeOne.runtimeOf(application);
    const two = routeTwo.runtimeOf(routeTwo.getApplication());
    if (!one.ok || !two.ok) throw new Error("runtime configuration rejected");
    expect(one.value.channel3.mode).toBe("live");
    expect(two.value.channel3.limiter).toBe(one.value.channel3.limiter);

    const first = request("ses_shared");
    expect((await one.value.channel3.search!(first)).status).toBe("error");
    expect((await two.value.channel3.search!(request("ses_shared"))).status).toBe("error");
    expect((await one.value.channel3.search!(request("ses_shared"))).status).toBe("limit");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(adapterTwo.readChannel3Listings(one.value.store, "ses_shared", first.draftId, first.version)).toEqual({ status: "error" });
    for (const call of fetchSpy.mock.calls as unknown as [string, RequestInit][]) expect(String(call[0])).toMatch(/^https:\/\/api\.trychannel3\.com\//);
  });
});

describe("External listings are not purchasable", () => {
  it("refuses to start checkout for an ext_ ID and creates no checkout", async () => {
    const { transport } = counting();
    const runtime = runtimeWith(transport);
    const buyer = await shopperWithBrief(runtime, "programming", "900");
    for (const ids of [
      { productId: "ext_abc", variantId: "ext_abc" },
      { productId: "ext_abc", variantId: "dmv_aspirego15" },
      { productId: "dmp_aspirego15", variantId: "ext_abc" },
    ]) {
      const response = await handleCheckoutStart(
        post("/checkout/start", { csrfToken: buyer.csrfToken, lang: "en", ...ids, quantity: "1" }, buyer.cookie),
        runtime,
      );
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location).toContain("error=");
      expect(location).not.toMatch(/\/checkout\/ci_/);
    }
    expect(runtime.audit.list().filter((event) => event.eventType === "QUOTE_ISSUED")).toEqual([]);
  });
});

function post(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

function listingPost(buyer: { cookie: string; csrfToken: string; draftId: string; version: number }): Request {
  return post("/shop/needs/listings", { lang: "en", csrfToken: buyer.csrfToken, draftId: buyer.draftId, version: String(buyer.version) }, buyer.cookie);
}

async function shopperWithBrief(runtime: Runtime, use: "programming" | "schoolwork" | "general_productivity", budget: string) {
  const now = runtime.clock().getTime();
  const started = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
  const token = started.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session missing");
  const draft = saveStructuredNeeds(runtime.store, session.value.id, {
    submittedVersion: null,
    language: "en",
    shopperText: "",
    use,
    budgetDollars: budget,
    notice: "review",
    expiresAtMs: now + HOUR,
    now,
  });
  if (typeof draft === "string") throw new Error(draft);
  const confirmed = confirmNeeds(runtime.store, session.value.id, { draftId: draft.draftId, version: draft.version, use, budgetDollars: budget, now });
  if (typeof confirmed === "string") throw new Error(confirmed);
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken, draftId: draft.draftId, version: draft.version };
}
