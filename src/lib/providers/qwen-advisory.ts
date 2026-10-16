import { MAX_JSON_BODY_BYTES } from "../security/limits";
import { ADVISORY_AI_CAPABILITIES, type AdvisoryAiProvider, type AdvisoryRequest } from "./ai";

/** Client deadline for one advisory attempt. It is independent of any database statement timeout. */
export const ADVISORY_DEADLINE_MS = 15000;

/**
 * Bytes this adapter will buffer from one response. This is separate from the token cap sent on the request.
 * A Fetch implementation may already have read more into its own buffers; this limit starts at the chunks this adapter accepts.
 */
export const ADVISORY_MAX_RESPONSE_BYTES = MAX_JSON_BODY_BYTES;

/** Output-token cap sent to the provider. It is not a byte limit. */
export const ADVISORY_MAX_COMPLETION_TOKENS = 1024;

const COMPLETIONS_PATH = "/compatible-mode/v1/chat/completions";
const SYNTHORAI_ENDPOINT = "https://synthorai.io/v1/chat/completions";
const SYNTHORAI_HOST = "synthorai.io";
const SYNTHORAI_PATH = "/v1/chat/completions";

const WORKSPACE_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/;

const SUGGESTION_JSON_SCHEMA = {
  name: "shopaccess_product_suggestions",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["message", "references"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 1200 },
      references: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["productId", "variantId"],
          properties: {
            productId: { type: "string", pattern: "^dmp_[a-z0-9]{6,24}$" },
            variantId: { type: "string", pattern: "^dmv_[a-z0-9]{6,24}$" },
            claimedPriceCents: { type: "integer" },
          },
        },
      },
    },
  },
} as const;

export type AdvisoryFailureCode =
  | "REDIRECT"
  | "DEADLINE"
  | "BODY_TOO_LARGE"
  | "HTTP_STATUS"
  | "TRANSPORT"
  | "NOT_JSON"
  | "ENVELOPE"
  | "NOT_STOP"
  | "EMPTY_CONTENT";

/** Fixed diagnostic. The message never carries a credential, a request body, or a provider error. */
export class AdvisoryFailure extends Error {
  readonly code: AdvisoryFailureCode;

  constructor(code: AdvisoryFailureCode) {
    super("advisory request failed");
    this.name = "AdvisoryFailure";
    this.code = code;
  }
}

export function parseAdvisoryModelId(value: string): string | null {
  if (value.length < 1 || value.length > 128) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function parseAdvisoryApiKey(value: string): string | null {
  if (value.length < 1 || value.length > 512) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function hasExplicitPort(value: string): boolean {
  const scheme = value.indexOf("://");
  if (scheme < 0) return false;
  const rest = value.slice(scheme + 3);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf("@");
  const hostport = at === -1 ? authority : authority.slice(at + 1);
  return hostport.includes(":");
}

/**
 * Accepts the documented Alibaba workspace hosts and the exact Synthorai Chat Completions URL.
 * The returned URL is the parser's normalized form, with no userinfo, query, fragment, or explicit port.
 */
export function parseAdvisoryEndpoint(value: string): string | null {
  if (value.includes("?") || value.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.port !== "" || hasExplicitPort(value)) return null;
  const alibaba = url.pathname === COMPLETIONS_PATH && WORKSPACE_HOST.test(url.hostname);
  const synthorai = url.hostname === SYNTHORAI_HOST && url.pathname === SYNTHORAI_PATH;
  if (!alibaba && !synthorai) return null;
  return url.href;
}

/** Asks for the same suggestion object the local guards accept, and for no other text. */
function suggestionJsonPrompt(instructions: string): string {
  return `${instructions}\nReply with only one JSON object of this shape and no other text: ${JSON.stringify(SUGGESTION_JSON_SCHEMA.schema)}`;
}

export interface EncodedSuggestionRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: {
    readonly Authorization: string;
    readonly "Content-Type": "application/json";
  };
  readonly body: string;
}

/** The Chat Completions body the application sends. Tests call this same function. */
export function encodeSuggestionRequest(input: {
  modelId: string;
  endpoint: string;
  apiKey: string;
  request: AdvisoryRequest;
}): EncodedSuggestionRequest {
  const synthorai = parseAdvisoryEndpoint(input.endpoint) === SYNTHORAI_ENDPOINT;
  const body = synthorai
    ? {
        model: input.modelId,
        messages: [
          { role: "system", content: suggestionJsonPrompt(input.request.instructions) },
          { role: "user", content: JSON.stringify(input.request.untrustedData) },
        ],
        stream: false,
        max_tokens: ADVISORY_MAX_COMPLETION_TOKENS,
        reasoning_effort: "minimal",
      }
    : {
        model: input.modelId,
        messages: [
          { role: "system", content: input.request.instructions },
          { role: "user", content: JSON.stringify(input.request.untrustedData) },
        ],
        enable_thinking: false,
        stream: false,
        max_completion_tokens: ADVISORY_MAX_COMPLETION_TOKENS,
        response_format: { type: "json_schema", json_schema: SUGGESTION_JSON_SCHEMA },
      };
  return {
    url: input.endpoint,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

const INTERPRETATION_JSON_SCHEMA = {
  name: "shopaccess_needs_interpretation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["understoodUse", "budgetDollars", "followUp"],
    properties: {
      understoodUse: { type: ["string", "null"], enum: ["schoolwork", "programming", "general_productivity", null] },
      budgetDollars: { type: ["string", "null"], pattern: "^[1-9][0-9]{1,4}$" },
      followUp: { type: ["string", "null"], enum: ["intended_use", "budget", null] },
    },
  },
} as const;

function interpretationJsonPrompt(instructions: string): string {
  return `${instructions}\nReply with only one JSON object of this shape and no other text: ${JSON.stringify(INTERPRETATION_JSON_SCHEMA.schema)}`;
}

/** Same Chat Completions encoding as a suggestion, with the interpretation schema. Tests call this function. */
export function encodeInterpretationRequest(input: {
  modelId: string;
  endpoint: string;
  apiKey: string;
  request: AdvisoryRequest;
}): EncodedSuggestionRequest {
  const synthorai = parseAdvisoryEndpoint(input.endpoint) === SYNTHORAI_ENDPOINT;
  const body = synthorai
    ? {
        model: input.modelId,
        messages: [
          { role: "system", content: interpretationJsonPrompt(input.request.instructions) },
          { role: "user", content: JSON.stringify(input.request.untrustedData) },
        ],
        stream: false,
        max_tokens: ADVISORY_MAX_COMPLETION_TOKENS,
        reasoning_effort: "minimal",
      }
    : {
        model: input.modelId,
        messages: [
          { role: "system", content: input.request.instructions },
          { role: "user", content: JSON.stringify(input.request.untrustedData) },
        ],
        enable_thinking: false,
        stream: false,
        max_completion_tokens: ADVISORY_MAX_COMPLETION_TOKENS,
        response_format: { type: "json_schema", json_schema: INTERPRETATION_JSON_SCHEMA },
      };
  return {
    url: input.endpoint,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

export interface AdvisoryTransportRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
}

export interface AdvisoryTransportResponse {
  readonly status: number;
  readonly redirected: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type AdvisoryTransport = (request: AdvisoryTransportRequest) => Promise<AdvisoryTransportResponse>;

/**
 * Production transport. Redirects are refused by the platform so the bearer credential is not forwarded.
 * Tests pass their own transport and do not call this unless they inject the implementation.
 */
export function createFetchAdvisoryTransport(transport: typeof globalThis.fetch = globalThis.fetch): AdvisoryTransport {
  const fetch = transport;
  return async (request) => {
    const encoded = request.body;
    const body = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(body).set(encoded);
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal,
      redirect: "error",
    });
    return {
      status: response.status,
      redirected: response.redirected,
      headers: response.headers,
      body: response.body,
    };
  };
}

function declaredLength(headers: { get(name: string): string | null }): number | null {
  const raw = headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

async function cancelStream(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // The stream may already be closed.
  }
}

function transportFailure(error: unknown, signal: AbortSignal): AdvisoryFailure {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return new AdvisoryFailure("DEADLINE");
  if (error instanceof TypeError && /redirect/i.test(error.message)) return new AdvisoryFailure("REDIRECT");
  return new AdvisoryFailure("TRANSPORT");
}

type RaceResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "deadline" }
  | { readonly kind: "settled" };

/**
 * One attempt. The deadline covers connection, headers, and reading the body.
 * On failure the abort signal is raised, the body is cancelled, and the timer is cleared.
 */
export async function performAdvisoryCall(transport: AdvisoryTransport, encoded: EncodedSuggestionRequest): Promise<string> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let settleGate: (value: AdvisoryFailure | "done") => void = () => {};
  const gate = new Promise<AdvisoryFailure | "done">((resolve) => {
    settleGate = resolve;
  });
  const timer = setTimeout(() => {
    controller.abort();
    settleGate(new AdvisoryFailure("DEADLINE"));
  }, ADVISORY_DEADLINE_MS);

  const attempt = (async (): Promise<string> => {
    let response: AdvisoryTransportResponse;
    try {
      response = await transport({
        url: encoded.url,
        method: "POST",
        headers: encoded.headers,
        body: new TextEncoder().encode(encoded.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw transportFailure(error, controller.signal);
    }

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await cancelStream(response.body);
      throw new AdvisoryFailure("REDIRECT");
    }
    if (response.status !== 200) {
      await cancelStream(response.body);
      throw new AdvisoryFailure("HTTP_STATUS");
    }

    const declared = declaredLength(response.headers);
    if (declared !== null && declared > ADVISORY_MAX_RESPONSE_BYTES) {
      await cancelStream(response.body);
      throw new AdvisoryFailure("BODY_TOO_LARGE");
    }
    if (!response.body) return "";

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        if (controller.signal.aborted) throw new AdvisoryFailure("DEADLINE");
        const next = await reader.read();
        if (next.done) break;
        const value = next.value;
        if (value.byteLength > ADVISORY_MAX_RESPONSE_BYTES - total) {
          await reader.cancel();
          reader = undefined;
          throw new AdvisoryFailure("BODY_TOO_LARGE");
        }
        const copy = new Uint8Array(value.byteLength);
        copy.set(value);
        chunks.push(copy);
        total += copy.byteLength;
      }
    } catch (error) {
      if (error instanceof AdvisoryFailure) throw error;
      throw transportFailure(error, controller.signal);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  })();

  const settled = attempt.then(
    (text): RaceResult => ({ kind: "text", text }),
    (error: unknown): RaceResult => ({ kind: "error", error }),
  );

  try {
    const outcome = await Promise.race([
      settled,
      gate.then((value): RaceResult => (value instanceof AdvisoryFailure ? { kind: "deadline" } : { kind: "settled" })),
    ]);
    if (outcome.kind === "deadline") throw new AdvisoryFailure("DEADLINE");
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind === "settled") throw new AdvisoryFailure("DEADLINE");
    return outcome.text;
  } finally {
    clearTimeout(timer);
    settleGate("done");
    controller.abort();
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The reader may already have been cancelled.
      }
      reader = undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Requires one non-streaming completion, one assistant choice, finish_reason "stop", and JSON object content.
 * The provider's separate reasoning text is not read.
 */
export function decodeSuggestionContent(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdvisoryFailure("NOT_JSON");
  }
  if (!isRecord(parsed) || parsed.object !== "chat.completion" || !Array.isArray(parsed.choices) || parsed.choices.length !== 1) {
    throw new AdvisoryFailure("ENVELOPE");
  }
  const choice = parsed.choices[0];
  if (!isRecord(choice)) throw new AdvisoryFailure("ENVELOPE");
  if (choice.finish_reason !== "stop") throw new AdvisoryFailure("NOT_STOP");
  const message = choice.message;
  if (!isRecord(message) || message.role !== "assistant") throw new AdvisoryFailure("ENVELOPE");
  if (typeof message.content !== "string" || message.content.trim() === "") throw new AdvisoryFailure("EMPTY_CONTENT");
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    throw new AdvisoryFailure("NOT_JSON");
  }
  if (!isRecord(content)) throw new AdvisoryFailure("NOT_JSON");
  return content;
}

export function createQwenAdvisoryProvider(options: {
  modelId: string;
  endpoint: string;
  apiKey: string;
  transport?: AdvisoryTransport;
}): AdvisoryAiProvider {
  const transport = options.transport ?? createFetchAdvisoryTransport();
  return {
    capabilities: ADVISORY_AI_CAPABILITIES,
    suggestionSource: "model",
    async explainAssessment() {
      throw new AdvisoryFailure("TRANSPORT");
    },
    async interpretNeeds(request) {
      const encoded = encodeInterpretationRequest({
        modelId: options.modelId,
        endpoint: options.endpoint,
        apiKey: options.apiKey,
        request,
      });
      const text = await performAdvisoryCall(transport, encoded);
      return decodeSuggestionContent(text);
    },
    async suggestProducts(request) {
      const encoded = encodeSuggestionRequest({
        modelId: options.modelId,
        endpoint: options.endpoint,
        apiKey: options.apiKey,
        request,
      });
      const text = await performAdvisoryCall(transport, encoded);
      return decodeSuggestionContent(text);
    },
  };
}
