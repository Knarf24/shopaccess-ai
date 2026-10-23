import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NeedsConversation } from "@/components/mock-journey/NeedsConversation";
import { TranslatedAdvisory } from "@/components/mock-journey/TranslatedAdvisory";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { AdvisoryFailure, encodeInterpretationRequest, encodeSuggestionRequest, type AdvisoryTransport } from "@/lib/providers/qwen-advisory";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import {
  DEFAULT_ADVISORY_LIMITS,
  createAdvisoryLimiter,
  createLimitedAdvisoryTransport,
  parseAdvisoryLimits,
  withAdvisorySession,
} from "@/server/advisory-limits";
import { parseRuntimeConfig } from "@/server/config";
import { handleCheckoutStart, handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { buildShoppingView, loadNeedsJourney, parsePreferences } from "@/server/shopping";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// AI safeguards (October 22, 2026): server-wide call limits reserved before every outbound attempt, deterministic results
// and permission checks when AI fails or is limited, a labelled local fallback, and a disclosure before free text.
// No live call is made: every transport here is an in-memory fake.
const ORIGIN = "https://shop.example.test";
const SYNTHORAI = "https://synthorai.io/v1/chat/completions";
const ALIBABA = "https://ws-test.us-east-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions";
const API_KEY = "synthetic-test-key";

function body(content: unknown): ReadableStream<Uint8Array> {
  const text = JSON.stringify({ object: "chat.completion", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }] });
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** Counts outbound attempts. `answer` decides each reply; a thrown error is a provider failure. */
function fakeProvider(answer: (requestBody: Record<string, unknown>) => unknown) {
  const sent: Record<string, unknown>[] = [];
  const transport: AdvisoryTransport = async (request) => {
    const parsed = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
    sent.push(parsed);
    const content = answer(parsed);
    return { status: 200, redirected: false, headers: { get: () => null }, body: body(content) };
  };
  return { transport, sent };
}

const isSuggestion = (requestBody: Record<string, unknown>) => JSON.stringify(requestBody).includes("references");

function externalRuntime(transport: AdvisoryTransport, limits = { perSession: 6, perHour: 120, perDay: 600 }) {
  const time = createTestClock("2026-10-22T12:00:00.000Z");
  const runtime = createRuntime(
    {
      sessionKey: TEST_SESSION_KEY,
      trustedOrigins: parseTrustedOrigins([ORIGIN]),
      advisory: { mode: "external", modelId: "qwen3.7-plus", endpoint: SYNTHORAI, apiKey: API_KEY },
      advisoryLimits: limits,
    },
    { clock: time.clock, transport },
  );
  return { runtime, time };
}

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${ORIGIN}/session/needs?lang=en`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken, session: session.value };
}

const post = (path: string, fields: Record<string, string>, cookie: string) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie },
    body: new URLSearchParams(fields).toString(),
  });

async function confirmedBrief(runtime: Runtime, buyer: Awaited<ReturnType<typeof shopper>>) {
  await handleNeedsSubmit(post("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "600", csrfToken: buyer.csrfToken }, buyer.cookie), runtime);
  const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
  await handleNeedsConfirm(
    post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "600", csrfToken: buyer.csrfToken }, buyer.cookie),
    runtime,
  );
}

describe("advisory call limits", () => {
  it("defaults to 6 per session, 120 per hour and 600 per day, and parses optional overrides strictly", () => {
    expect(DEFAULT_ADVISORY_LIMITS).toEqual({ perSession: 6, perHour: 120, perDay: 600 });
    expect(parseAdvisoryLimits({})).toEqual({ ok: true, value: null });
    expect(parseAdvisoryLimits({ SHOPACCESS_AI_LIMIT_PER_HOUR: "50" })).toEqual({ ok: true, value: { perSession: 6, perHour: 50, perDay: 600 } });
    for (const bad of ["0", "-1", "1.5", "", "abc", "100001", " 5"]) {
      expect(parseAdvisoryLimits({ SHOPACCESS_AI_LIMIT_PER_SESSION: bad }), bad).toEqual({ ok: false, error: "ADVISORY_LIMITS_INVALID" });
    }
    const parsed = parseRuntimeConfig({
      SHOPACCESS_SESSION_KEY: TEST_SESSION_KEY.toString("base64"),
      SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
      PAYMENT_PROVIDER_MODE: "mock",
      SHOPACCESS_AI_LIMIT_PER_DAY: "nope",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("ADVISORY_LIMITS_INVALID");
  });

  it("refuses the seventh call in a session, the 121st in an hour and the 601st in a day, and never wraps", () => {
    const time = createTestClock("2026-10-22T00:00:00.000Z");
    const limiter = createAdvisoryLimiter(DEFAULT_ADVISORY_LIMITS, time.clock);
    for (let i = 0; i < 6; i += 1) expect(limiter.reserve("ses_a")).toEqual({ ok: true });
    expect(limiter.reserve("ses_a")).toEqual({ ok: false, refusal: "session" });
    // Other sessions share the hourly window: 6 used, 114 more fit in this hour.
    let granted = 6;
    for (let s = 0; granted < 120; s += 1) {
      for (let i = 0; i < 6 && granted < 120; i += 1) {
        expect(limiter.reserve(`ses_h${s}`).ok).toBe(true);
        granted += 1;
      }
    }
    expect(limiter.reserve("ses_fresh")).toEqual({ ok: false, refusal: "hour" });
    // The next hour opens; the daily total keeps counting.
    let day = 120;
    for (let hour = 1; day < 600; hour += 1) {
      time.advance(60 * 60 * 1000);
      for (let i = 0; i < 120 && day < 600; i += 1) {
        expect(limiter.reserve(`ses_d${hour}_${Math.floor(i / 6)}`).ok).toBe(true);
        day += 1;
      }
    }
    time.advance(60 * 60 * 1000);
    expect(limiter.reserve("ses_next")).toEqual({ ok: false, refusal: "day" });
    // A new UTC day resets the daily and hourly windows. This synthetic session is now older than the application's
    // absolute session lifetime, so its retained counter can be reclaimed.
    time.advance(24 * 60 * 60 * 1000);
    expect(limiter.reserve("ses_next")).toEqual({ ok: true });
    expect(limiter.reserve("ses_a")).toEqual({ ok: true });
  });

  it("does not reset a live session's allowance at a UTC day boundary", () => {
    const time = createTestClock("2026-10-22T23:59:59.000Z");
    const limiter = createAdvisoryLimiter({ perSession: 1, perHour: 10, perDay: 10 }, time.clock);
    expect(limiter.reserve("ses_boundary")).toEqual({ ok: true });
    time.advance(2_000);
    expect(limiter.reserve("ses_boundary")).toEqual({ ok: false, refusal: "session" });
  });

  it("refuses an attempt made outside a session scope (fail closed)", () => {
    const limiter = createAdvisoryLimiter(DEFAULT_ADVISORY_LIMITS, createTestClock().clock);
    expect(limiter.reserve(null)).toEqual({ ok: false, refusal: "no_session" });
  });

  it("keeps each session's allowance isolated", () => {
    const limiter = createAdvisoryLimiter({ perSession: 1, perHour: 10, perDay: 10 }, createTestClock().clock);
    expect(limiter.reserve("ses_a")).toEqual({ ok: true });
    expect(limiter.reserve("ses_b")).toEqual({ ok: true });
    expect(limiter.reserve("ses_a")).toEqual({ ok: false, refusal: "session" });
    expect(limiter.reserve("ses_b")).toEqual({ ok: false, refusal: "session" });
  });
});

describe("limited transport", () => {
  it("reserves before each outbound attempt, so concurrent requests cannot exceed the remaining capacity", async () => {
    const time = createTestClock();
    const limiter = createAdvisoryLimiter({ perSession: 6, perHour: 3, perDay: 600 }, time.clock);
    let inner = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: AdvisoryTransport = async () => {
      inner += 1;
      await gate;
      return { status: 200, redirected: false, headers: { get: () => null }, body: body({}) };
    };
    const limited = createLimitedAdvisoryTransport(slow, limiter);
    const request = { url: SYNTHORAI, method: "POST" as const, headers: {}, body: new Uint8Array(), signal: new AbortController().signal };
    const attempts = [
      withAdvisorySession("ses_1", () => limited(request)),
      withAdvisorySession("ses_2", () => limited(request)),
      withAdvisorySession("ses_3", () => limited(request)),
      withAdvisorySession("ses_4", () => limited(request)),
      withAdvisorySession("ses_5", () => limited(request)),
    ];
    release();
    const settled = await Promise.allSettled(attempts);
    expect(inner).toBe(3);
    const refused = settled.filter((result) => result.status === "rejected");
    expect(refused).toHaveLength(2);
    for (const result of refused) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(AdvisoryFailure);
      expect(((result as PromiseRejectedResult).reason as AdvisoryFailure).code).toBe("LIMITED");
    }
  });

  it("makes no outbound attempt without a session scope", async () => {
    let inner = 0;
    const limited = createLimitedAdvisoryTransport(async () => {
      inner += 1;
      throw new Error("must not run");
    }, createAdvisoryLimiter(DEFAULT_ADVISORY_LIMITS, createTestClock().clock));
    await expect(limited({ url: SYNTHORAI, method: "POST", headers: {}, body: new Uint8Array(), signal: new AbortController().signal } as never)).rejects.toMatchObject({ code: "LIMITED" });
    expect(inner).toBe(0);
  });
});

describe("runtime: every AI path goes through the limits", () => {
  it("stops sending free text at the session limit and keeps the structured path usable", async () => {
    const provider = fakeProvider(() => ({ understoodUse: "schoolwork", budgetDollars: null, followUp: "budget" }));
    const { runtime } = externalRuntime(provider.transport, { perSession: 2, perHour: 120, perDay: 600 });
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(post("/shop/needs/submit", { lang: "en", shopperText: "a laptop for school", csrfToken: buyer.csrfToken }, buyer.cookie), runtime);
    for (const text of ["about 500 dollars", "make it 550"]) {
      const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
      const response = await handleNeedsSubmit(
        post("/shop/needs/submit", { lang: "en", draftId: draft.draftId, version: String(draft.version), shopperText: text, csrfToken: buyer.csrfToken }, buyer.cookie),
        runtime,
      );
      if (text === "make it 550") {
        expect(new URL(response.headers.get("location")!, ORIGIN).searchParams.get("ai")).toBe("limited");
      }
    }
    expect(provider.sent).toHaveLength(2);
    // The structured controls still produce a reviewable brief with no AI call.
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", draftId: draft.draftId, version: String(draft.version), shopperText: "", use: "schoolwork", budget: "600", csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)!.notice).toBe("review");
    expect(provider.sent).toHaveLength(2);
  });

  it("falls back to a labelled local suggestion and keeps deterministic cards when the provider fails", async () => {
    const provider = fakeProvider((requestBody) => {
      if (isSuggestion(requestBody)) throw new Error("provider down");
      return {};
    });
    const { runtime } = externalRuntime(provider.transport);
    const buyer = await shopper(runtime);
    await confirmedBrief(runtime, buyer);
    const journey = await loadNeedsJourney(runtime, buyer.session);
    expect(provider.sent.filter(isSuggestion)).toHaveLength(1);
    expect(journey.draft?.recommendationClaim).toBe("completed");
    expect(journey.suggestionSource).toBe("fallback");
    expect(journey.lines.map((line) => line.variantId)).toContain("dmv_aspirego15");
    // Purchase-permission checks are unchanged: no permission, no checkout.
    const started = await handleCheckoutStart(
      post("/checkout/start", { csrfToken: buyer.csrfToken, lang: "en", productId: "dmp_aspirego15", variantId: "dmv_aspirego15", quantity: "1", use: "schoolwork", budget: "600" }, buyer.cookie),
      runtime,
    );
    expect(started.headers.get("location")).toContain("PERMISSION_REQUIRED");
  });

  it("uses the labelled local fallback without an outbound attempt once the limit is reached", async () => {
    const provider = fakeProvider(() => ({ message: "Consider this laptop.", references: [{ productId: "dmp_aspirego15", variantId: "dmv_aspirego15" }] }));
    const { runtime } = externalRuntime(provider.transport, { perSession: 6, perHour: 120, perDay: 1 });
    const first = await shopper(runtime);
    await confirmedBrief(runtime, first);
    expect((await loadNeedsJourney(runtime, first.session)).suggestionSource).toBe("model");
    const second = await shopper(runtime);
    await confirmedBrief(runtime, second);
    const journey = await loadNeedsJourney(runtime, second.session);
    expect(provider.sent).toHaveLength(1);
    expect(journey.suggestionSource).toBe("fallback");
    expect(journey.lines.length).toBeGreaterThan(0);
  });

  it("keeps the cards when a recommendation is stored as failed", async () => {
    const time = createTestClock("2026-10-22T12:00:00.000Z");
    const base = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
    const runtime: Runtime = {
      ...base,
      ai: {
        ...base.ai,
        async suggestProducts() {
          throw new Error("local assistant failed");
        },
      },
    };
    const buyer = await shopper(runtime);
    await confirmedBrief(runtime, buyer);
    const journey = await loadNeedsJourney(runtime, buyer.session);
    expect(journey.draft?.recommendationClaim).toBe("failed");
    expect(journey.lines.map((line) => line.variantId)).toContain("dmv_aspirego15");
  });

  it("binds the legacy shop advisory to its resolved session and labels its local fallback", async () => {
    const provider = fakeProvider(() => ({
      message: "Consider this laptop.",
      references: [{ productId: "dmp_aspirego15", variantId: "dmv_aspirego15" }],
    }));
    const { runtime } = externalRuntime(provider.transport, { perSession: 1, perHour: 120, perDay: 600 });
    const buyer = await shopper(runtime);
    const preferences = parsePreferences("schoolwork", "600");
    if (!preferences) throw new Error("preferences");

    const model = await buildShoppingView(runtime, preferences, buyer.sessionId);
    const fallback = await buildShoppingView(runtime, preferences, buyer.sessionId);

    expect(provider.sent).toHaveLength(1);
    expect(model.suggestionSource).toBe("model");
    expect(fallback.suggestionSource).toBe("fallback");
    expect(fallback.recommendations?.map((item) => item.variantId)).toContain("dmv_aspirego15");
  });
});

describe("provider request settings", () => {
  const request = { instructions: "x", untrustedData: { shopperMessage: "a laptop", products: [] } };
  const sentBody = (encoded: { body: string }) => JSON.parse(encoded.body) as Record<string, unknown>;

  it("disables thinking on Synthorai (documented for qwen3.7-plus) and sends no undocumented response_format", () => {
    for (const encoded of [
      encodeInterpretationRequest({ modelId: "qwen3.7-plus", endpoint: SYNTHORAI, apiKey: API_KEY, request }),
      encodeSuggestionRequest({ modelId: "qwen3.7-plus", endpoint: SYNTHORAI, apiKey: API_KEY, request }),
    ]) {
      const sent = sentBody(encoded);
      expect(sent.enable_thinking).toBe(false);
      expect(sent).not.toHaveProperty("response_format");
      expect(sent.max_tokens).toBe(1024);
    }
  });

  it("leaves the Alibaba request settings unchanged", () => {
    const sent = sentBody(encodeSuggestionRequest({ modelId: "qwen-plus", endpoint: ALIBABA, apiKey: API_KEY, request }));
    expect(sent.enable_thinking).toBe(false);
    expect(sent).toHaveProperty("response_format");
  });
});

describe("disclosure and labels", () => {
  for (const language of ["en", "es"] as const) {
    it(`discloses that free text goes to Synthorai before it is submitted, only when live AI is on (${language})`, () => {
      const copy = journeyCopy(language);
      const notice = copy.externalAiNotice("Synthorai");
      expect(notice).toContain("Synthorai");
      const live = renderToStaticMarkup(
        <NeedsConversation copy={copy} language={language} csrfToken="t" draft={null} mode="first" externalAiNotice={notice} aiLimited />,
      );
      expect(live).toContain(notice);
      expect(live).toContain(copy.aiLimited);
      expect(live).toMatch(/<textarea[^>]*id="shopper-text"[^>]*aria-describedby="[^"]*needs-ai-notice/);
      expect(live.indexOf(notice)).toBeLessThan(live.indexOf("<textarea"));
      const reply = renderToStaticMarkup(
        <NeedsConversation
          copy={copy}
          language={language}
          csrfToken="t"
          draft={{ shopperText: "", prefilledUse: null, prefilledBudgetDollars: null, draftId: "d", version: 1, notice: null }}
          mode="reply"
          externalAiNotice={notice}
        />,
      );
      expect(reply).toMatch(/needs-ai-notice[\s\S]*<textarea[^>]*id="shopper-reply"[^>]*aria-describedby="needs-ai-notice"/);
      const local = renderToStaticMarkup(<NeedsConversation copy={copy} language={language} csrfToken="t" draft={null} mode="first" />);
      expect(local).not.toContain("Synthorai");
      expect(local).not.toContain("needs-ai-notice");
    });

    it(`labels a local fallback as not live AI (${language})`, () => {
      const copy = journeyCopy(language);
      const recommendation = { assistantMessage: "These catalog items meet the stated use and budget.", recommendations: [] };
      const markup = renderToStaticMarkup(
        <TranslatedAdvisory copy={copy} language={language} draft={{ recommendationClaim: "completed", recommendation }} lines={[]} suggestionSource="fallback" compact />,
      );
      expect(markup).toContain(copy.suggestionSourceFallback);
      expect(markup).not.toContain(copy.suggestionSourceModel);
      expect(copy.aiLimited.length).toBeGreaterThan(0);
    });
  }
});
