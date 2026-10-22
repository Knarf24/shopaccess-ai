import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdvisoryRecommendations } from "@/components/AdvisoryRecommendations";
import { ReadinessPanel } from "@/components/ReadinessPanel";
import { DEMO_MERCHANT_CATALOG, findMerchantVariant, formatUsd } from "@/lib/catalog/merchant-catalog";
import {
  formatAdvisoryFailureDiagnostic,
  suggestProductsSafely,
  type AdvisoryAiProvider,
  type AdvisoryDiagnosticCode,
  type AdvisoryFailureDiagnostic,
  type AdvisoryFailureStage,
  type AdvisoryRequest,
} from "@/lib/providers/ai";
import { MockPaymentProvider } from "@/lib/providers/payment";
import {
  ADVISORY_DEADLINE_MS,
  ADVISORY_MAX_COMPLETION_TOKENS,
  ADVISORY_MAX_RESPONSE_BYTES,
  AdvisoryFailure,
  createFetchAdvisoryTransport,
  createQwenAdvisoryProvider,
  decodeSuggestionContent,
  encodeSuggestionRequest,
  parseAdvisoryApiKey,
  parseAdvisoryEndpoint,
  parseAdvisoryModelId,
  performAdvisoryCall,
  type AdvisoryTransport,
  type AdvisoryTransportRequest,
  type AdvisoryTransportResponse,
} from "@/lib/providers/qwen-advisory";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { parseRuntimeConfig } from "@/server/config";
import { createRuntime, type Runtime } from "@/server/runtime";
import { buildShoppingView, parsePreferences, type ShoppingView } from "@/server/shopping";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

const ORIGIN = "https://shop.example.test";
const MODEL_ID = "qwen3.7-plus";
const API_KEY = "test-advisory-key";
const ENDPOINT = "https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions";
const SYNTHORAI = "https://synthorai.io/v1/chat/completions";
const STUDY = { productId: "dmp_aspirego15", variantId: "dmv_aspirego15", unitAmountCents: 57999 };

const liveFetch = vi.fn(() => {
  throw new Error("live fetch is not used");
});

beforeEach(() => {
  liveFetch.mockClear();
  vi.stubGlobal("fetch", liveFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function baseEnv(): Record<string, string> {
  return {
    SHOPACCESS_SESSION_KEY: TEST_SESSION_KEY.toString("base64"),
    SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
    PAYMENT_PROVIDER_MODE: "mock",
    NODE_ENV: "production",
  };
}

function advisoryEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SHOPACCESS_AI_MODEL_ID: MODEL_ID,
    SHOPACCESS_AI_ENDPOINT: ENDPOINT,
    SHOPACCESS_AI_API_KEY: API_KEY,
    ...overrides,
  };
}

function request(shopperMessage = "Laptop for Programming"): AdvisoryRequest {
  return {
    instructions: "You cannot buy, reserve, confirm or pay for anything.",
    untrustedData: { shopperMessage, products: [{ productId: STUDY.productId, variantId: STUDY.variantId, title: "Acer Aspire Go 15", description: "A researched laptop." }] },
  };
}

function encoded(current: AdvisoryRequest = request()) {
  return encodeSuggestionRequest({ modelId: MODEL_ID, endpoint: ENDPOINT, apiKey: API_KEY, request: current });
}

function headerBag(headers: Record<string, string> = {}): { get(name: string): string | null } {
  const entries = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value] as const);
  return {
    get(name: string) {
      return entries.find(([key]) => key === name.toLowerCase())?.[1] ?? null;
    },
  };
}

function streamFrom(parts: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

function responseFrom(body: string, status = 200, extra: { redirected?: boolean; headers?: Record<string, string>; onCancel?: () => void } = {}): AdvisoryTransportResponse {
  return {
    status,
    redirected: extra.redirected ?? false,
    headers: headerBag(extra.headers),
    body: streamFrom([new TextEncoder().encode(body)], extra.onCancel),
  };
}

function suggestion(claimedPriceCents?: number) {
  return {
    message: "Consider the Acer Aspire Go 15.",
    references: [{ productId: STUDY.productId, variantId: STUDY.variantId, ...(claimedPriceCents === undefined ? {} : { claimedPriceCents }) }],
  };
}

function envelope(content: unknown, message: Record<string, unknown> = {}, choice: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(content), ...message },
        finish_reason: "stop",
        ...choice,
      },
    ],
  });
}

function transportReturning(body: string, extra: { status?: number; redirected?: boolean; headers?: Record<string, string>; onCancel?: () => void } = {}): { transport: AdvisoryTransport; calls: () => readonly AdvisoryTransportRequest[]; abortedDuring: () => boolean } {
  const calls: AdvisoryTransportRequest[] = [];
  let abortedDuring = false;
  const transport: AdvisoryTransport = async (next) => {
    calls.push(next);
    abortedDuring = next.signal.aborted;
    return responseFrom(body, extra.status ?? 200, extra);
  };
  return { transport, calls: () => calls, abortedDuring: () => abortedDuring };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function hangUntilAbort(request: AdvisoryTransportRequest, delayMs = 60_000): Promise<AdvisoryTransportResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(responseFrom(envelope(suggestion()))), delayMs);
    request.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function synchronousFailure(body: string): unknown {
  try {
    decodeSuggestionContent(body);
  } catch (error) {
    return error;
  }
  return undefined;
}

function providerThatThrows(error: unknown): AdvisoryAiProvider {
  return {
    capabilities: ["explain_assessment", "suggest_products"],
    async explainAssessment() {
      return {};
    },
    async interpretNeeds() {
      throw error;
    },
    async suggestProducts() {
      throw error;
    },
  };
}

function runtimeFor(config: ReturnType<typeof parseRuntimeConfig>, transport: AdvisoryTransport, clock = createTestClock().clock): Runtime {
  if (!config.ok) throw new Error("expected configuration to parse");
  return createRuntime(config.value, { clock, transport });
}

function watch(runtime: Runtime): { runtime: Runtime; counts: () => { explain: number; suggest: number } } {
  const counts = { explain: 0, suggest: 0 };
  const ai: AdvisoryAiProvider = {
    capabilities: runtime.ai.capabilities,
    async explainAssessment(next) {
      counts.explain += 1;
      return runtime.ai.explainAssessment(next);
    },
    async interpretNeeds(next) {
      return runtime.ai.interpretNeeds(next);
    },
    async suggestProducts(next) {
      counts.suggest += 1;
      return runtime.ai.suggestProducts(next);
    },
  };
  return { runtime: { ...runtime, ai }, counts: () => ({ ...counts }) };
}

describe("advisory configuration", () => {
  it("keeps the local assistant when the three settings are absent and still fails closed on payment", () => {
    expect(parseRuntimeConfig({})).toEqual({ ok: false, error: ["SESSION_KEY_MISSING", "TRUSTED_ORIGINS_MISSING", "PAYMENT_MODE_NOT_MOCK"] });
    const parsed = parseRuntimeConfig(baseEnv());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.advisory).toEqual({ mode: "local" });
    expect(parseRuntimeConfig({ ...baseEnv(), PAYPAL_CLIENT_SECRET: "x", ...advisoryEnv() })).toEqual({ ok: false, error: ["PAYMENT_MODE_NOT_MOCK"] });
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("rejects a partial or empty advisory configuration without echoing the values", () => {
    const secret = "endpoint-sentinel.example";
    const key = "key-sentinel-value";
    expect(parseRuntimeConfig({ ...baseEnv(), SHOPACCESS_AI_MODEL_ID: MODEL_ID })).toEqual({
      ok: false,
      error: ["ADVISORY_ENDPOINT_MISSING", "ADVISORY_API_KEY_MISSING"],
    });
    expect(parseRuntimeConfig({ ...baseEnv(), SHOPACCESS_AI_ENDPOINT: ENDPOINT, SHOPACCESS_AI_API_KEY: API_KEY })).toEqual({
      ok: false,
      error: ["ADVISORY_MODEL_ID_MISSING"],
    });
    expect(parseRuntimeConfig({ ...baseEnv(), SHOPACCESS_AI_MODEL_ID: "", SHOPACCESS_AI_ENDPOINT: "", SHOPACCESS_AI_API_KEY: "" })).toEqual({
      ok: false,
      error: ["ADVISORY_MODEL_ID_INVALID", "ADVISORY_ENDPOINT_INVALID", "ADVISORY_API_KEY_INVALID"],
    });
    const leaked = parseRuntimeConfig({
      ...baseEnv(),
      SHOPACCESS_AI_MODEL_ID: "has space",
      SHOPACCESS_AI_ENDPOINT: `https://user:pass@${secret}/compatible-mode/v1/chat/completions`,
      SHOPACCESS_AI_API_KEY: `${key}\n`,
    });
    expect(leaked).toEqual({ ok: false, error: ["ADVISORY_MODEL_ID_INVALID", "ADVISORY_ENDPOINT_INVALID", "ADVISORY_API_KEY_INVALID"] });
    expect(JSON.stringify(leaked)).not.toContain(secret);
    expect(JSON.stringify(leaked)).not.toContain(key);
    expect(JSON.stringify(leaked)).not.toContain("pass");
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("accepts only the documented workspace hosts and the chat completions path", () => {
    for (const region of ["cn-beijing", "ap-southeast-1", "us-east-1", "eu-central-1", "ap-northeast-1", "cn-hongkong"]) {
      const endpoint = `https://llm-1.${region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
      expect(parseAdvisoryEndpoint(endpoint), region).toBe(endpoint);
    }
    expect(parseAdvisoryEndpoint("https://WS.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions")).toBe(ENDPOINT);
    const rejected = [
      "http://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      "https://user:pass@ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      "https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions?trace=1",
      "https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions#fragment",
      "https://ws.ap-southeast-1.maas.aliyuncs.com:443/compatible-mode/v1/chat/completions",
      "https://ws.ap-southeast-1.maas.aliyuncs.com:8443/compatible-mode/v1/chat/completions",
      "https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions/",
      "https://ws.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
      "https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions",
      "https://a.b.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      "https://-bad.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      "https://bad-.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    ];
    for (const endpoint of rejected) expect(parseAdvisoryEndpoint(endpoint), endpoint).toBeNull();
    expect(parseAdvisoryModelId("m".repeat(128))).toBe("m".repeat(128));
    expect(parseAdvisoryModelId("m".repeat(129))).toBeNull();
    expect(parseAdvisoryModelId("qwen plus")).toBeNull();
    const spacedKey = `${"k".repeat(511)} `;
    expect(parseAdvisoryApiKey(spacedKey)).toBe(spacedKey);
    expect(parseAdvisoryApiKey("k".repeat(513))).toBeNull();
    expect(parseAdvisoryApiKey("test\r\nX-Injected: 1")).toBeNull();
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("accepts the exact Synthorai chat completions endpoint", () => {
    expect(parseAdvisoryEndpoint(SYNTHORAI)).toBe(SYNTHORAI);
    expect(parseAdvisoryEndpoint("https://Synthorai.io/v1/chat/completions")).toBe(SYNTHORAI);
    const parsed = parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv({ SHOPACCESS_AI_ENDPOINT: SYNTHORAI }) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected the Synthorai endpoint");
    const advisory = parsed.value.advisory;
    if (!advisory || advisory.mode !== "external") throw new Error("expected the Synthorai endpoint");
    expect(advisory.endpoint).toBe(SYNTHORAI);
    const rejected = [
      "http://synthorai.io/v1/chat/completions",
      "https://user:pass@synthorai.io/v1/chat/completions",
      "https://synthorai.io/v1/chat/completions?trace=1",
      "https://synthorai.io/v1/chat/completions#fragment",
      "https://synthorai.io:443/v1/chat/completions",
      "https://synthorai.io:8443/v1/chat/completions",
      "https://synthorai.io/v1/chat/completions/",
      "https://synthorai.io/compatible-mode/v1/chat/completions",
      "https://api.synthorai.io/v1/chat/completions",
      "https://synthorai.io.evil.example/v1/chat/completions",
      "https://notsynthorai.io/v1/chat/completions",
    ];
    for (const endpoint of rejected) expect(parseAdvisoryEndpoint(endpoint), endpoint).toBeNull();
    expect(liveFetch).not.toHaveBeenCalled();
  });
});

describe("suggestion encoder and decoder", () => {
  it("sends one non-streaming chat completion and reads only assistant JSON content", async () => {
    const current = request();
    const { transport, calls, abortedDuring } = transportReturning(envelope(suggestion(), { reasoning_content: JSON.stringify({ message: "hidden reasoning", references: [] }) }));
    const provider = createQwenAdvisoryProvider({ modelId: "custom-model", endpoint: ENDPOINT, apiKey: API_KEY, transport });
    const decoded = await provider.suggestProducts(current);
    const expected = encodeSuggestionRequest({ modelId: "custom-model", endpoint: ENDPOINT, apiKey: API_KEY, request: current });
    expect(calls()).toHaveLength(1);
    const sent = calls()[0];
    expect(new TextDecoder().decode(sent.body)).toBe(expected.body);
    expect(sent.url).toBe(ENDPOINT);
    expect(sent.method).toBe("POST");
    expect(sent.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(sent.headers["Content-Type"]).toBe("application/json");
    expect(abortedDuring()).toBe(false);
    const body = JSON.parse(expected.body) as Record<string, unknown>;
    expect(body.model).toBe("custom-model");
    expect(body.enable_thinking).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.max_completion_tokens).toBe(ADVISORY_MAX_COMPLETION_TOKENS);
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.max_completion_tokens).not.toBe(ADVISORY_MAX_RESPONSE_BYTES);
    expect(body.tools).toBeUndefined();
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: current.instructions });
    expect(messages[1].role).toBe("user");
    expect(JSON.parse(messages[1].content)).toEqual(current.untrustedData);
    const format = body.response_format as { type: string; json_schema: { strict: boolean; schema: { additionalProperties: boolean; properties: { references: { items: { required: string[] } } } } } };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    expect(format.json_schema.schema.properties.references.items.required).toEqual(["productId", "variantId"]);
    expect(expected.body).not.toContain(API_KEY);
    expect(decoded).toEqual(decodeSuggestionContent(envelope(suggestion(), { reasoning_content: JSON.stringify({ message: "hidden reasoning", references: [] }) })));
    expect(decoded).toEqual(suggestion());
    expect(decoded).not.toEqual({ message: "hidden reasoning", references: [] });
    await expect(provider.explainAssessment(current)).rejects.toMatchObject({ code: "TRANSPORT", message: "advisory request failed" });
    expect(calls()).toHaveLength(1);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("rejects envelopes that are not one stopped assistant JSON message", async () => {
    const cases: Array<[string, string]> = [
      ["{", "NOT_JSON"],
      [JSON.stringify([]), "ENVELOPE"],
      [JSON.stringify({ object: "chat.completion.chunk", choices: [] }), "ENVELOPE"],
      [JSON.stringify({ object: "chat.completion", choices: [] }), "ENVELOPE"],
      [JSON.stringify({ object: "chat.completion", choices: [{}, {}] }), "ENVELOPE"],
      [JSON.stringify({ object: "chat.completion", choices: [{ finish_reason: "length", message: { role: "assistant", content: "{}" } }] }), "NOT_STOP"],
      [JSON.stringify({ object: "chat.completion", choices: [{ finish_reason: "stop", message: { role: "user", content: "{}" } }] }), "ENVELOPE"],
      [JSON.stringify({ object: "chat.completion", choices: [{ finish_reason: "stop", message: { role: "assistant", content: null, reasoning_content: JSON.stringify(suggestion()) } }] }), "EMPTY_CONTENT"],
      [JSON.stringify({ object: "chat.completion", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "not json" } }] }), "NOT_JSON"],
      [JSON.stringify({ object: "chat.completion", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "[]" } }] }), "NOT_JSON"],
    ];
    for (const [body, code] of cases) {
      const { transport } = transportReturning(body);
      const provider = createQwenAdvisoryProvider({ modelId: MODEL_ID, endpoint: ENDPOINT, apiKey: API_KEY, transport });
      expect(synchronousFailure(body), code).toMatchObject({ code, message: "advisory request failed" });
      await expect(provider.suggestProducts(request()), code).rejects.toMatchObject({ code, message: "advisory request failed" });
    }
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("encodes a Synthorai completion without Alibaba-only fields and still fails closed", async () => {
    const current = request();
    const encodedRequest = encodeSuggestionRequest({ modelId: MODEL_ID, endpoint: SYNTHORAI, apiKey: API_KEY, request: current });
    const body = JSON.parse(encodedRequest.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "reasoning_effort", "stream"]);
    expect(body.model).toBe(MODEL_ID);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(ADVISORY_MAX_COMPLETION_TOKENS);
    expect(body.max_tokens).toBe(1024);
    expect(body.max_tokens).not.toBe(ADVISORY_MAX_RESPONSE_BYTES);
    expect(body.reasoning_effort).toBe("minimal");
    expect(body.enable_thinking).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(encodedRequest.body).not.toContain("enable_thinking");
    expect(encodedRequest.body).not.toContain("max_completion_tokens");
    expect(encodedRequest.body).not.toContain("response_format");
    expect(encodedRequest.body).not.toContain(API_KEY);
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content.startsWith(`${current.instructions}\n`)).toBe(true);
    expect(messages[0].content).toContain("Reply with only one JSON object of this shape and no other text:");
    expect(messages[0].content).toContain('"additionalProperties":false');
    expect(messages[0].content).toContain('"required":["message","references"]');
    expect(messages[0].content).toContain('"productId"');
    expect(messages[0].content).toContain('"variantId"');
    expect(messages[0].content).toContain('"claimedPriceCents"');
    expect(messages[1].role).toBe("user");
    expect(JSON.parse(messages[1].content)).toEqual(current.untrustedData);

    const { transport, calls } = transportReturning(envelope(suggestion()));
    const provider = createQwenAdvisoryProvider({ modelId: MODEL_ID, endpoint: SYNTHORAI, apiKey: API_KEY, transport });
    await expect(provider.suggestProducts(current)).resolves.toEqual(suggestion());
    expect(calls()).toHaveLength(1);
    expect(calls()[0].url).toBe(SYNTHORAI);
    expect(new TextDecoder().decode(calls()[0].body)).toBe(encodedRequest.body);
    expect(calls()[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);

    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 200 }));
    const signal = new AbortController().signal;
    await createFetchAdvisoryTransport(fetchImpl)({
      url: SYNTHORAI,
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: new Uint8Array(),
      signal,
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", method: "POST", signal });

    const invalid = createQwenAdvisoryProvider({
      modelId: MODEL_ID,
      endpoint: SYNTHORAI,
      apiKey: API_KEY,
      transport: async () => responseFrom(JSON.stringify({ object: "chat.completion", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "not json" } }] })),
    });
    await expect(invalid.suggestProducts(current)).rejects.toMatchObject({ code: "NOT_JSON", message: "advisory request failed" });

    const inventedBody = envelope({ message: "Try this exclusive deal.", references: [{ productId: "dmp_inventeddeal", variantId: "dmv_inventeddeal" }] });
    const runtime = runtimeFor(
      parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv({ SHOPACCESS_AI_ENDPOINT: SYNTHORAI }) }),
      async () => responseFrom(inventedBody),
    );
    await expect(suggestProductsSafely(runtime.ai, runtime.catalog, "Laptop for Programming")).resolves.toEqual({ ok: false, error: "INVENTED_REFERENCE" });

    const malformed = runtimeFor(
      parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv({ SHOPACCESS_AI_ENDPOINT: SYNTHORAI }) }),
      async () => responseFrom(envelope({ message: "Order placed.", references: [], action: { type: "purchase" } })),
    );
    await expect(suggestProductsSafely(malformed.ai, malformed.catalog, "Laptop for Programming")).resolves.toEqual({ ok: false, error: "OUTPUT_INVALID" });
    expect(liveFetch).not.toHaveBeenCalled();
  });
});

describe("bounded transport", () => {
  it("refuses redirects from the fetch transport and from a returned redirect response", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 200 }));
    const wrapped = createFetchAdvisoryTransport(fetchImpl);
    const signal = new AbortController().signal;
    await wrapped({ url: ENDPOINT, method: "POST", headers: { Authorization: `Bearer ${API_KEY}` }, body: new Uint8Array(), signal });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", method: "POST", signal });
    expect(liveFetch).not.toHaveBeenCalled();

    const redirectFetch = vi.fn(async () => {
      throw new TypeError("redirect mode is set to error: https://evil.example");
    });
    vi.stubGlobal("fetch", redirectFetch);
    const refused = createQwenAdvisoryProvider({ modelId: MODEL_ID, endpoint: ENDPOINT, apiKey: API_KEY });
    const redirectError = await refused.suggestProducts(request()).then(
      () => { throw new Error("redirect resolved"); },
      (error: unknown) => error,
    );
    expect(redirectError).toMatchObject({ code: "REDIRECT", message: "advisory request failed" });
    expect(redirectError).toBeInstanceOf(AdvisoryFailure);
    if (redirectError instanceof Error) expect(redirectError.message).not.toContain("evil.example");
    expect(redirectFetch).toHaveBeenCalledTimes(1);

    for (const status of [301, 302, 307, 308]) {
      let cancelled = false;
      const { transport, calls } = transportReturning(envelope(suggestion()), { status, onCancel: () => (cancelled = true) });
      await expect(performAdvisoryCall(transport, encoded())).rejects.toMatchObject({ code: "REDIRECT", message: "advisory request failed" });
      expect(cancelled, String(status)).toBe(true);
      expect(calls()).toHaveLength(1);
    }
    let redirected = false;
    const followed = transportReturning(envelope(suggestion()), { redirected: true, onCancel: () => (redirected = true) });
    await expect(performAdvisoryCall(followed.transport, encoded())).rejects.toMatchObject({ code: "REDIRECT" });
    expect(redirected).toBe(true);
  });

  it("applies one 15000 ms deadline to headers and the rest of the body, then settles the timer", async () => {
    expect(ADVISORY_DEADLINE_MS).toBe(15000);
    vi.useFakeTimers();
    const slowHeaders = performAdvisoryCall((next) => hangUntilAbort(next, ADVISORY_DEADLINE_MS + 1), encoded());
    const headersFailed = slowHeaders.then(
      () => { throw new Error("headers resolved"); },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(ADVISORY_DEADLINE_MS);
    await expect(headersFailed).resolves.toMatchObject({ code: "DEADLINE", message: "advisory request failed" });
    expect(vi.getTimerCount()).toBe(0);

    let enqueued = false;
    const slowBody = performAdvisoryCall((next) => {
      return new Promise((resolve, reject) => {
        const headers = setTimeout(() => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let release: (() => void) | undefined;
          resolve({
            status: 200,
            redirected: false,
            headers: headerBag(),
            body: new ReadableStream({
              pull(controller) {
                return new Promise((done) => {
                  release = () => done();
                  timer = setTimeout(() => {
                    enqueued = true;
                    controller.enqueue(new TextEncoder().encode(envelope(suggestion())));
                    controller.close();
                    done();
                  }, ADVISORY_DEADLINE_MS - 4000 + 1);
                });
              },
              cancel() {
                if (timer !== undefined) clearTimeout(timer);
                release?.();
              },
            }),
          });
        }, 4000);
        next.signal.addEventListener("abort", () => {
          clearTimeout(headers);
          reject(abortError());
        }, { once: true });
      });
    }, encoded());
    const bodyFailed = slowBody.then(
      () => { throw new Error("body resolved"); },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(ADVISORY_DEADLINE_MS - 4000);
    await expect(bodyFailed).resolves.toMatchObject({ code: "DEADLINE" });
    expect(enqueued).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const accepted = performAdvisoryCall((next) => {
      return new Promise((resolve, reject) => {
        const headers = setTimeout(() => {
          resolve(responseFrom(envelope(suggestion())));
        }, 4000);
        next.signal.addEventListener("abort", () => {
          clearTimeout(headers);
          reject(abortError());
        }, { once: true });
      });
    }, encoded());
    await vi.advanceTimersByTimeAsync(4000);
    await expect(accepted).resolves.toBe(envelope(suggestion()));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the 16384 byte buffer separate from the 1024 token request cap", async () => {
    expect(ADVISORY_MAX_RESPONSE_BYTES).toBe(16384);
    expect(ADVISORY_MAX_COMPLETION_TOKENS).toBe(1024);
    const wide = suggestion();
    const wideMessage = { ...wide, message: "A".repeat(1500) };
    const wideBody = envelope(wideMessage);
    expect(new TextEncoder().encode(wideBody).byteLength).toBeGreaterThan(1024);
    expect(new TextEncoder().encode(wideBody).byteLength).toBeLessThan(16384);
    const { transport } = transportReturning(wideBody);
    await expect(performAdvisoryCall(transport, encoded())).resolves.toBe(wideBody);

    const exact = "a".repeat(16384);
    const within = transportReturning(exact);
    await expect(performAdvisoryCall(within.transport, encoded())).resolves.toBe(exact);
    expect(synchronousFailure(exact)).toMatchObject({ code: "NOT_JSON", message: "advisory request failed" });

    let readerRequested = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.resolve();
      },
    });
    const getReader = body.getReader.bind(body);
    body.getReader = ((...args: Parameters<ReadableStream<Uint8Array>["getReader"]>) => {
      readerRequested = true;
      return getReader(...args);
    }) as ReadableStream<Uint8Array>["getReader"];
    const declared = performAdvisoryCall(async () => ({
      status: 200,
      redirected: false,
      headers: headerBag({ "content-length": "16385" }),
      body,
    }), encoded());
    await expect(declared).rejects.toMatchObject({ code: "BODY_TOO_LARGE", message: "advisory request failed" });
    expect(readerRequested).toBe(false);

    const sentinel = "BODY-SENTINEL-not-decoded";
    const oversized = new Uint8Array(16385);
    oversized.set(new TextEncoder().encode(sentinel));
    let cancelled = false;
    await expect(performAdvisoryCall(async () => ({
      status: 200,
      redirected: false,
      headers: headerBag(),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(oversized);
        },
        cancel() {
          cancelled = true;
        },
      }),
    }), encoded())).rejects.toMatchObject({ code: "BODY_TOO_LARGE", message: "advisory request failed" });
    expect(cancelled).toBe(true);

    const first = new Uint8Array(16384);
    const second = new Uint8Array([1]);
    await expect(performAdvisoryCall(async () => ({
      status: 200,
      redirected: false,
      headers: headerBag(),
      body: streamFrom([first, second]),
    }), encoded())).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });

    const raw = new Error(`${API_KEY} ${sentinel} provider failed`);
    const failed = performAdvisoryCall(async () => {
      throw raw;
    }, encoded());
    await expect(failed).rejects.toMatchObject({ code: "TRANSPORT", message: "advisory request failed" });
    await expect(failed).rejects.toThrow("advisory request failed");
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("does not retry a failed attempt", async () => {
    let calls = 0;
    const transport: AdvisoryTransport = async () => {
      calls += 1;
      return responseFrom("nope", 500);
    };
    const provider = createQwenAdvisoryProvider({ modelId: MODEL_ID, endpoint: ENDPOINT, apiKey: API_KEY, transport });
    await expect(provider.suggestProducts(request())).rejects.toMatchObject({ code: "HTTP_STATUS" });
    expect(calls).toBe(1);
    expect(liveFetch).not.toHaveBeenCalled();
  });
});

describe("shop rendering", () => {
  const preferences = parsePreferences("programming", "900");
  if (!preferences) throw new Error("preferences");

  it("preserves the local assistant and does not call the external provider", async () => {
    const clock = createTestClock().clock;
    const transport: AdvisoryTransport = async () => {
      throw new Error("local assistant called the provider");
    };
    const watched = watch(runtimeFor(parseRuntimeConfig(baseEnv()), transport, clock));
    const view = await buildShoppingView(watched.runtime, preferences);
    const again = await buildShoppingView(watched.runtime, preferences);
    expect(view).toEqual(again);
    const variantCount = DEMO_MERCHANT_CATALOG.products.reduce((count, product) => count + product.variants.length, 0);
    expect(watched.counts()).toEqual({ explain: variantCount * 2, suggest: 2 });
    expect(view.recommendations).toBeUndefined();
    expect(view.explanationLabel).toBeUndefined();
    expect(view.assistantMessage).toBe("Here is a laptop from the demo catalog to consider.");
    for (const entry of view.variants) {
      expect(entry.explanation?.source).toBe("ai");
      expect(entry.explanation?.status).toBe(entry.assessment.status);
      expect(entry.explanation?.authorizesPurchase).toBe(false);
      expect(entry.assessment.authorizesPurchase).toBe(false);
    }
    expect(watched.runtime.advisory).toBe("local");
    expect(watched.runtime.provider).toBeInstanceOf(MockPaymentProvider);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("asks for one catalog-priced suggestion per render and shows it without checkout controls", async () => {
    const clock = createTestClock().clock;
    let calls = 0;
    const seen: AdvisoryTransportRequest[] = [];
    const transport: AdvisoryTransport = async (next) => {
      calls += 1;
      seen.push(next);
      return responseFrom(envelope(suggestion(STUDY.unitAmountCents), { reasoning_content: "{\"message\":\"do not use\"}" }));
    };
    const config = parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() });
    const watched = watch(runtimeFor(config, transport, clock));
    const view = await buildShoppingView(watched.runtime, preferences);
    expect(calls).toBe(1);
    expect(watched.counts()).toEqual({ explain: 0, suggest: 1 });
    calls = 0;
    const again = await buildShoppingView(watched.runtime, preferences);
    expect(calls).toBe(1);
    expect(view).toEqual(again);
    expect(watched.runtime.advisory).toBe("external");
    expect(watched.runtime.provider).toBeInstanceOf(MockPaymentProvider);
    expect(JSON.stringify({ advisory: watched.runtime.advisory })).not.toContain(API_KEY);

    const sent = JSON.parse(new TextDecoder().decode(seen[0].body)) as { model: string; enable_thinking: boolean; stream: boolean; max_completion_tokens: number; tools?: unknown; messages: { role: string; content: string }[] };
    expect(sent.model).toBe(MODEL_ID);
    expect(sent.enable_thinking).toBe(false);
    expect(sent.stream).toBe(false);
    expect(sent.max_completion_tokens).toBe(1024);
    expect(sent.tools).toBeUndefined();
    expect(sent.messages[1].content).toContain("Laptop for Programming");
    expect(seen[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(new TextDecoder().decode(seen[0].body)).not.toContain(API_KEY);

    const entry = findMerchantVariant(DEMO_MERCHANT_CATALOG, STUDY.productId, STUDY.variantId);
    if (!entry) throw new Error("missing catalog entry");
    expect(view.recommendations).toEqual([
      {
        productId: STUDY.productId,
        variantId: STUDY.variantId,
        title: entry.product.title,
        label: entry.variant.label,
        unitAmountCents: entry.variant.unitAmountCents,
        currency: "USD",
      },
    ]);
    expect(view.recommendations?.[0]?.unitAmountCents).toBe(STUDY.unitAmountCents);
    expect(view.explanationLabel).toBe("Assessment summary (deterministic, advisory only): ");
    for (const variant of view.variants) {
      expect(variant.explanation?.source).toBe("deterministic_fallback");
      expect(variant.explanation?.status).toBe(variant.assessment.status);
      expect(variant.explanation?.authorizesPurchase).toBe(false);
    }
    expect(Object.fromEntries(view.variants.map((variant) => [variant.variant.variantId, variant.assessment.status]))).toEqual({
      dmv_aspire14ai: "READY",
      dmv_aspirego15: "READY_WITH_CAVEATS",
      dmv_vivobook16: "NOT_RECOMMENDED",
    });

    const html = renderToStaticMarkup(<AdvisoryRecommendations message={view.assistantMessage} recommendations={view.recommendations ?? []} />);
    expect(html).toContain(entry.product.title);
    expect(html).toContain(entry.variant.label);
    expect(html).toContain(`${formatUsd(STUDY.unitAmountCents)} USD`);
    expect(html).not.toContain("$0.01");
    expect(html).not.toMatch(/<form|<button|checkout|paypal/i);
    const panel = renderToStaticMarkup(
      <ReadinessPanel assessment={view.variants[0].assessment} explanation={view.variants[0].explanation?.explanation ?? null} explanationLabel={view.explanationLabel} />,
    );
    expect(panel).toContain("Assessment summary (deterministic, advisory only): ");
    expect(panel).not.toContain("local mock");
    const localPanel = renderToStaticMarkup(
      <ReadinessPanel assessment={view.variants[0].assessment} explanation="The available evidence supports this laptop." />,
    );
    expect(localPanel).toContain("Assistant explanation (local mock, advisory only): ");

    const page = readFileSync(join(process.cwd(), "src", "app", "(english)", "shop", "shop-listing.tsx"), "utf8");
    const shopPage = readFileSync(join(process.cwd(), "src", "app", "(english)", "shop", "page.tsx"), "utf8");
    expect(shopPage).toContain("ShopListing");
    expect(page).toContain("AdvisoryRecommendations");
    expect(page).toContain("Assistant (local mock, advisory only): ");
    expect(page).toContain('action="/checkout/start"');
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("drops invalid, invented, and mispriced model output without a checkout control", async () => {
    const clock = createTestClock().clock;
    const cases: Array<{ body: string; error: string; text: string }> = [
      { body: envelope({ message: "Order placed.", references: [], action: { type: "purchase" } }), error: "OUTPUT_INVALID", text: "Order placed." },
      { body: envelope({ message: "Try this exclusive deal.", references: [{ productId: "dmp_inventeddeal", variantId: "dmv_inventeddeal" }] }), error: "INVENTED_REFERENCE", text: "dmp_inventeddeal" },
      { body: envelope({ message: "This one is on sale.", references: [{ productId: STUDY.productId, variantId: STUDY.variantId, claimedPriceCents: 1 }] }), error: "PRICE_MISMATCH", text: "$0.01" },
    ];
    for (const item of cases) {
      let calls = 0;
      const transport: AdvisoryTransport = async () => {
        calls += 1;
        return responseFrom(item.body);
      };
      const runtime = runtimeFor(parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() }), transport, clock);
      const safe = await suggestProductsSafely(runtime.ai, runtime.catalog, "Laptop for Programming");
      expect(safe).toEqual({ ok: false, error: item.error });
      const view = await buildShoppingView(runtime, preferences);
      expect(calls).toBe(2);
      expect(view.assistantMessage).toBeNull();
      expect(view.recommendations).toEqual([]);
      const html = renderToStaticMarkup(<AdvisoryRecommendations message={view.assistantMessage} recommendations={view.recommendations ?? []} />);
      expect(html).toContain("No suggestion is available.");
      expect(html).toContain("No catalog item could be shown.");
      expect(html).not.toContain(item.text);
      expect(html).not.toMatch(/<form|<button|checkout|paypal/i);
    }

    const hostile = renderToStaticMarkup(<AdvisoryRecommendations message={'<script>alert(1)</script>'} recommendations={[]} />);
    expect(hostile).toContain("&lt;script&gt;");
    expect(hostile).not.toContain("<script>");
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("uses the safe fallback when the single request misses its deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const transport: AdvisoryTransport = (next) => {
      calls += 1;
      return hangUntilAbort(next);
    };
    const runtime = runtimeFor(parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() }), transport, createTestClock().clock);
    const pending = buildShoppingView(runtime, preferences);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ADVISORY_DEADLINE_MS);
    const view: ShoppingView = await pending;
    expect(calls).toBe(1);
    expect(view.assistantMessage).toBeNull();
    expect(view.recommendations).toEqual([]);
    for (const entry of view.variants) expect(entry.explanation?.source).toBe("deterministic_fallback");
    expect(vi.getTimerCount()).toBe(0);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("records distinguishable safe diagnostics for timeout, invalid JSON, and catalog rejection", async () => {
    const secret = "synthetic-advisory-secret";
    const prose = "Consider this exclusive secret prose";
    const captured: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      if (typeof message === "string") captured.push(message);
    });
    try {
      vi.useFakeTimers();
      const timeoutTransport: AdvisoryTransport = (next) => new Promise((_resolve, reject) => {
        next.signal.addEventListener("abort", () => {
          const error = new Error(`timeout ${secret} ${ENDPOINT} ${prose}`);
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      const timeoutRuntime = runtimeFor(parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() }), timeoutTransport, createTestClock().clock);
      const timeoutPending = buildShoppingView(timeoutRuntime, preferences);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(ADVISORY_DEADLINE_MS);
      const timeoutView: ShoppingView = await timeoutPending;
      expect(timeoutView.assistantMessage).toBeNull();
      expect(timeoutView.recommendations).toEqual([]);
      for (const entry of timeoutView.variants) expect(entry.explanation?.source).toBe("deterministic_fallback");

      vi.useRealTimers();
      const jsonTransport: AdvisoryTransport = async () => responseFrom(`{not-json ${secret} ${ENDPOINT} ${prose}`);
      const jsonRuntime = runtimeFor(parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() }), jsonTransport, createTestClock().clock);
      const jsonView = await buildShoppingView(jsonRuntime, preferences);
      expect(jsonView.assistantMessage).toBeNull();
      expect(jsonView.recommendations).toEqual([]);

      const catalogTransport: AdvisoryTransport = async () => responseFrom(envelope({
        message: `${prose} ${secret}`,
        references: [{ productId: "dmp_inventeddeal", variantId: "dmv_inventeddeal" }],
      }));
      const catalogRuntime = runtimeFor(parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() }), catalogTransport, createTestClock().clock);
      const catalogView = await buildShoppingView(catalogRuntime, preferences);
      expect(catalogView.assistantMessage).toBeNull();
      expect(catalogView.recommendations).toEqual([]);

      expect(captured).toHaveLength(3);
      expect(captured[0]).toBe("shopaccess: advisory stage=transport code=DEADLINE elapsedMs=15000");
      expect(captured[1]).toMatch(/^shopaccess: advisory stage=decoding code=NOT_JSON elapsedMs=\d+$/);
      expect(captured[2]).toMatch(/^shopaccess: advisory stage=output_validation code=INVENTED_REFERENCE elapsedMs=\d+$/);
      const recorded = JSON.stringify(spy.mock.calls);
      expect(recorded).not.toContain(secret);
      expect(recorded).not.toContain(ENDPOINT);
      expect(recorded).not.toContain(API_KEY);
      expect(recorded).not.toContain(prose);
      expect(recorded).not.toContain("dmp_inventeddeal");
      expect(recorded).not.toContain("StudyBook");
      expect(liveFetch).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies throwing getters and Proxy traps as a fixed transport diagnostic", async () => {
    const secret = "synthetic-getter-secret";
    const raw = "raw-getter-or-proxy-failure";
    const captured: string[] = [];
    const getterError = Object.defineProperties(Object.create(null), {
      name: { enumerable: true, get: () => { throw new Error(`name ${secret} ${raw}`); } },
      code: { enumerable: true, get: () => { throw new Error(`code ${secret} ${raw}`); } },
    });
    const namedThrow = {
      get name(): string {
        return "AdvisoryFailure";
      },
      get code(): string {
        throw new Error(`code ${secret} ${ENDPOINT} ${raw}`);
      },
    };
    const proxyError = new Proxy(Object.create(null), {
      get(_target, property) {
        throw new Error(`proxy ${String(property)} ${secret} ${raw}`);
      },
    });
    for (const error of [getterError, namedThrow, proxyError]) {
      const result = await suggestProductsSafely(providerThatThrows(error), DEMO_MERCHANT_CATALOG, "Laptop for Programming", (diagnostic) => {
        const line = formatAdvisoryFailureDiagnostic(diagnostic);
        if (line) captured.push(line);
      });
      expect(result).toEqual({ ok: false, error: "AI_UNAVAILABLE" });
    }
    expect(captured).toHaveLength(3);
    for (const line of captured) {
      expect(line).toMatch(/^shopaccess: advisory stage=transport code=TRANSPORT elapsedMs=\d+$/);
    }
    const recorded = captured.join("\n");
    expect(recorded).not.toContain(secret);
    expect(recorded).not.toContain(raw);
    expect(recorded).not.toContain(ENDPOINT);
    expect(recorded).not.toContain(API_KEY);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("keeps the safe result and fallback when the diagnostic callback throws", async () => {
    const secret = "synthetic-callback-secret";
    const raw = "raw-callback-failure";
    const captured: string[] = [];
    const throwingSink = (diagnostic: AdvisoryFailureDiagnostic): void => {
      const line = formatAdvisoryFailureDiagnostic(diagnostic);
      if (line) captured.push(line);
      throw new Error(`${raw} ${secret} ${ENDPOINT}`);
    };
    const unavailable = await suggestProductsSafely(
      providerThatThrows(new Error(`${raw} ${secret}`)),
      DEMO_MERCHANT_CATALOG,
      "Laptop for Programming",
      throwingSink,
    );
    expect(unavailable).toEqual({ ok: false, error: "AI_UNAVAILABLE" });

    const invented = await suggestProductsSafely({
      capabilities: ["explain_assessment", "suggest_products"],
      async explainAssessment() {
        return {};
      },
      async interpretNeeds() {
        return { understoodUse: null, budgetDollars: null, followUp: null };
      },
      async suggestProducts() {
        return {
          message: `${raw} ${secret}`,
          references: [{ productId: "dmp_inventeddeal", variantId: "dmv_inventeddeal" }],
        };
      },
    }, DEMO_MERCHANT_CATALOG, "Laptop for Programming", throwingSink);
    expect(invented).toEqual({ ok: false, error: "INVENTED_REFERENCE" });

    if (!preferences) throw new Error("preferences");
    const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      if (typeof message === "string") captured.push(message);
      throw new Error(`${raw} ${secret}`);
    });
    try {
      const transport: AdvisoryTransport = async () => responseFrom(`{not-json ${secret} ${raw}`);
      const runtime = runtimeFor(parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() }), transport, createTestClock().clock);
      const direct = await suggestProductsSafely(runtime.ai, runtime.catalog, "Laptop for Programming");
      expect(direct).toEqual({ ok: false, error: "AI_UNAVAILABLE" });
      const view = await buildShoppingView(runtime, preferences);
      expect(view.assistantMessage).toBeNull();
      expect(view.recommendations).toEqual([]);
      for (const entry of view.variants) expect(entry.explanation?.source).toBe("deterministic_fallback");
      expect(captured[0]).toMatch(/^shopaccess: advisory stage=transport code=TRANSPORT elapsedMs=\d+$/);
      expect(captured[1]).toMatch(/^shopaccess: advisory stage=output_validation code=INVENTED_REFERENCE elapsedMs=\d+$/);
      expect(captured[2]).toMatch(/^shopaccess: advisory stage=decoding code=NOT_JSON elapsedMs=\d+$/);
      const recorded = JSON.stringify(captured);
      expect(recorded).not.toContain(secret);
      expect(recorded).not.toContain(raw);
      expect(recorded).not.toContain(ENDPOINT);
      expect(recorded).not.toContain("dmp_inventeddeal");
      expect(liveFetch).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("omits mismatched stage and code pairs and clamps elapsed diagnostics", async () => {
    const secret = "synthetic-pair-secret";
    const mismatches: Array<{ stage: AdvisoryFailureStage; code: AdvisoryDiagnosticCode }> = [
      { stage: "transport", code: "NOT_JSON" },
      { stage: "decoding", code: "DEADLINE" },
      { stage: "output_validation", code: "TRANSPORT" },
      { stage: "transport", code: "OUTPUT_INVALID" },
      { stage: "decoding", code: "PRICE_MISMATCH" },
      { stage: "output_validation", code: "EMPTY_CONTENT" },
    ];
    for (const mismatch of mismatches) {
      expect(formatAdvisoryFailureDiagnostic({ ...mismatch, elapsedMs: 12 })).toBeNull();
    }
    const hostileCode = formatAdvisoryFailureDiagnostic({
      stage: "transport",
      code: `${secret}` as AdvisoryDiagnosticCode,
      elapsedMs: 12,
    });
    const hostileStage = formatAdvisoryFailureDiagnostic({
      stage: secret as AdvisoryFailureStage,
      code: "TRANSPORT",
      elapsedMs: 12,
    });
    expect(hostileCode).toBeNull();
    expect(hostileStage).toBeNull();
    expect(JSON.stringify([hostileCode, hostileStage])).not.toContain(secret);

    expect(formatAdvisoryFailureDiagnostic({ stage: "transport", code: "TRANSPORT", elapsedMs: 60_001 })).toBe(
      "shopaccess: advisory stage=transport code=TRANSPORT elapsedMs=60000",
    );
    expect(formatAdvisoryFailureDiagnostic({ stage: "transport", code: "DEADLINE", elapsedMs: -15 })).toBe(
      "shopaccess: advisory stage=transport code=DEADLINE elapsedMs=0",
    );
    expect(formatAdvisoryFailureDiagnostic({ stage: "decoding", code: "NOT_JSON", elapsedMs: Number.NaN })).toBe(
      "shopaccess: advisory stage=decoding code=NOT_JSON elapsedMs=0",
    );
    expect(formatAdvisoryFailureDiagnostic({ stage: "decoding", code: "ENVELOPE", elapsedMs: Number.POSITIVE_INFINITY })).toBe(
      "shopaccess: advisory stage=decoding code=ENVELOPE elapsedMs=0",
    );
    expect(formatAdvisoryFailureDiagnostic({ stage: "output_validation", code: "PRICE_MISMATCH", elapsedMs: Number.NEGATIVE_INFINITY })).toBe(
      "shopaccess: advisory stage=output_validation code=PRICE_MISMATCH elapsedMs=0",
    );

    const seen: AdvisoryFailureDiagnostic[] = [];
    const clock = vi.spyOn(Date, "now");
    const scriptElapsed = (start: number, end: number): void => {
      let seenCalls = 0;
      clock.mockImplementation(() => {
        seenCalls += 1;
        return seenCalls === 1 ? start : end;
      });
    };
    try {
      scriptElapsed(10_000, 100_000);
      const oversized = await suggestProductsSafely(
        providerThatThrows(new AdvisoryFailure("DEADLINE")),
        DEMO_MERCHANT_CATALOG,
        "Laptop for Programming",
        (diagnostic) => { seen.push(diagnostic); },
      );
      scriptElapsed(5_000, 1_000);
      const negative = await suggestProductsSafely(
        providerThatThrows(new Error(secret)),
        DEMO_MERCHANT_CATALOG,
        "Laptop for Programming",
        (diagnostic) => { seen.push(diagnostic); },
      );
      scriptElapsed(Number.NaN, Number.NaN);
      const nonFinite = await suggestProductsSafely(
        providerThatThrows(new AdvisoryFailure("NOT_JSON")),
        DEMO_MERCHANT_CATALOG,
        "Laptop for Programming",
        (diagnostic) => { seen.push(diagnostic); },
      );
      expect(oversized).toEqual({ ok: false, error: "AI_UNAVAILABLE" });
      expect(negative).toEqual({ ok: false, error: "AI_UNAVAILABLE" });
      expect(nonFinite).toEqual({ ok: false, error: "AI_UNAVAILABLE" });
      expect(seen).toEqual([
        { stage: "transport", code: "DEADLINE", elapsedMs: 60000 },
        { stage: "transport", code: "TRANSPORT", elapsedMs: 0 },
        { stage: "decoding", code: "NOT_JSON", elapsedMs: 0 },
      ]);
      expect(JSON.stringify(seen)).not.toContain(secret);
      expect(liveFetch).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("sends only the eligible Aspire Go 15 and does not display rejected prose", async () => {
    const schoolwork = parsePreferences("schoolwork", "580");
    if (!schoolwork) throw new Error("preferences");
    const seen: AdvisoryTransportRequest[] = [];
    const transport: AdvisoryTransport = async (next) => {
      seen.push(next);
      return responseFrom(envelope({
        message: "Consider Acer Aspire Go 15, Acer Aspire 14 AI, and ASUS Vivobook 16.",
        references: [
          { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai" },
          { productId: "dmp_vivobook16", variantId: "dmv_vivobook16" },
          { productId: STUDY.productId, variantId: STUDY.variantId },
        ],
      }));
    };
    const view = await buildShoppingView(runtimeFor(parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() }), transport), schoolwork);
    expect(seen).toHaveLength(1);
    const payload = JSON.parse(JSON.parse(new TextDecoder().decode(seen[0].body)).messages[1].content) as {
      shopperMessage: string;
      intendedUse: string;
      budgetCents: number;
      products: Array<{ productId: string; variantId: string; unitAmountCents: number; ramGb: number; storageGb: number; assessmentStatus: string }>;
    };
    expect(payload.shopperMessage).toBe("Laptop for Schoolwork");
    expect(payload.intendedUse).toBe("schoolwork");
    expect(payload.budgetCents).toBe(58000);
    expect(payload.products.map((product) => product.productId)).toEqual([STUDY.productId]);
    expect(payload.products[0]).toMatchObject({
      variantId: STUDY.variantId,
      unitAmountCents: 57999,
      ramGb: 8,
      storageGb: 256,
      assessmentStatus: "READY",
    });
    expect(new TextDecoder().decode(seen[0].body)).not.toContain("Aspire 14");
    expect(new TextDecoder().decode(seen[0].body)).not.toContain("Vivobook");
    expect(view.assistantMessage).toBe("These catalog items meet the stated use and budget.");
    expect(view.recommendations?.map((item) => item.variantId)).toEqual([STUDY.variantId]);
    expect(view.variants.map((entry) => entry.variant.variantId).sort()).toEqual([
      "dmv_aspire14ai",
      "dmv_aspirego15",
      "dmv_vivobook16",
    ]);
    expect(Object.fromEntries(view.variants.map((entry) => [entry.variant.variantId, entry.assessment.status]))).toEqual({
      dmv_aspirego15: "READY",
      dmv_aspire14ai: "NOT_RECOMMENDED",
      dmv_vivobook16: "NOT_RECOMMENDED",
    });
    const html = renderToStaticMarkup(<AdvisoryRecommendations message={view.assistantMessage} recommendations={view.recommendations ?? []} />);
    expect(html).toContain("Acer Aspire Go 15");
    expect(html).not.toContain("Aspire 14");
    expect(html).not.toContain("Vivobook");
    expect(html).not.toContain("Consider Acer");
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("skips the provider when no catalog variant meets the use and budget", async () => {
    const schoolwork = parsePreferences("schoolwork", "200");
    if (!schoolwork) throw new Error("preferences");
    let calls = 0;
    const transport: AdvisoryTransport = async () => {
      calls += 1;
      return responseFrom(envelope(suggestion()));
    };
    const view = await buildShoppingView(runtimeFor(parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() }), transport), schoolwork);
    expect(calls).toBe(0);
    expect(view.assistantMessage).toBe("No catalog item meets this use and budget.");
    expect(view.recommendations).toEqual([]);
    expect(view.variants).toHaveLength(3);
    const html = renderToStaticMarkup(<AdvisoryRecommendations message={view.assistantMessage} recommendations={view.recommendations ?? []} />);
    expect(html).toContain("No catalog item meets this use and budget.");
    expect(html).not.toContain("No suggestion is available.");
    expect(html).not.toContain("No catalog item could be shown.");
    expect(html).not.toContain("Aspire");
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("shows a no-match sentence when every returned reference fails eligibility", async () => {
    const schoolwork = parsePreferences("schoolwork", "580");
    if (!schoolwork) throw new Error("preferences");
    let calls = 0;
    const transport: AdvisoryTransport = async () => {
      calls += 1;
      return responseFrom(envelope({
        message: "Acer Aspire 14 AI is the one to buy.",
        references: [{ productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai" }],
      }));
    };
    const view = await buildShoppingView(runtimeFor(parseRuntimeConfig({ ...baseEnv(), ...advisoryEnv() }), transport), schoolwork);
    expect(calls).toBe(1);
    expect(view.assistantMessage).toBe("No suggestion matched a catalog item that meets this use and budget.");
    expect(view.recommendations).toEqual([]);
    expect(view.variants.some((entry) => entry.variant.variantId === "dmv_aspire14ai" && entry.assessment.status === "NOT_RECOMMENDED")).toBe(true);
    expect(view.variants.some((entry) => entry.variant.variantId === STUDY.variantId && entry.assessment.status === "READY")).toBe(true);
    const html = renderToStaticMarkup(<AdvisoryRecommendations message={view.assistantMessage} recommendations={view.recommendations ?? []} />);
    expect(html).toContain("No suggestion matched a catalog item that meets this use and budget.");
    expect(html).not.toContain("Aspire 14");
    expect(html).not.toContain("the one to buy");
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("keeps the local assistant message for the same schoolwork budget", async () => {
    const schoolwork = parsePreferences("schoolwork", "500");
    if (!schoolwork) throw new Error("preferences");
    const transport: AdvisoryTransport = async () => {
      throw new Error("local assistant called the provider");
    };
    const view = await buildShoppingView(runtimeFor(parseRuntimeConfig(baseEnv()), transport), schoolwork);
    expect(view.recommendations).toBeUndefined();
    expect(view.assistantMessage).toBe("Here is a laptop from the demo catalog to consider.");
    expect(view.variants).toHaveLength(3);
    expect(liveFetch).not.toHaveBeenCalled();
  });
});

describe("configured runtime", () => {
  it("stores a normalized endpoint and does not put the credential on the runtime", () => {
    const parsed = parseRuntimeConfig({
      ...baseEnv(),
      ...advisoryEnv({ SHOPACCESS_AI_ENDPOINT: "https://WS.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", SHOPACCESS_AI_API_KEY: `${API_KEY} ` }),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.advisory).toEqual({ mode: "external", modelId: MODEL_ID, endpoint: ENDPOINT, apiKey: `${API_KEY} ` });
    const transport: AdvisoryTransport = async () => responseFrom(envelope(suggestion()));
    const runtime = createRuntime(parsed.value, { transport });
    expect(runtime.advisory).toBe("external");
    expect(JSON.stringify(runtime.advisory)).not.toContain(API_KEY);
    expect(liveFetch).not.toHaveBeenCalled();
  });
});
