import { createHash } from "node:crypto";

import { journeyCopy } from "@/lib/i18n/demo-copy";
import { chargerCopy } from "@/lib/i18n/charger-copy";
import { CHARGER_LINES } from "@/lib/session/charger-clarification";
import type { NeedsNotice } from "@/lib/i18n/needs-notice";
import { readConversation } from "@/lib/session/conversation";
import { SESSION_IDLE_TIMEOUT_MS } from "@/lib/session/service";
import { needsDraftsFor } from "@/lib/session/store";
import { PROPOSED_RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";
import { continueNeedsFollowUp } from "./handlers";
import { bearerOf, extensionJson, guardExtensionRequest, readExtensionJson, refuseExtension } from "./extension-guard";
import type { Runtime } from "./runtime";

/**
 * /api/extension/v1 handlers (M2-2). Pairing start, status and exchange, and the conversation read. Every handler runs
 * inside withMockRuntime, so a refused save is the public 503 and no handler runs on a blocked gate.
 */

const PAIRING_ID = /^[0-9a-f]{64}$/;

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  RATE_LIMIT: 429,
  RATE_LIMITED: 429,
  POLL_LIMIT: 429,
  POLL_TOO_SOON: 429,
  PAIRING_UNKNOWN: 404,
  PAIRING_EXPIRED: 410,
  PAIRING_NOT_APPROVED: 409,
  PAIRING_ALREADY_DECIDED: 409,
  PAIRING_LIMIT: 409,
  VERIFIER_INVALID: 400,
  SESSION_INVALID: 401,
  GRANT_LIMIT: 409,
  TOKEN_INVALID: 401,
  SCOPE_DENIED: 403,
  STALE_DRAFT: 409,
  DRAFT_EXPIRED: 410,
  DRAFT_NOT_FOUND: 404,
  CLARIFICATION_INVALID: 400,
  REQUEST_ID_CONFLICT: 409,
};

const refusal = (code: string, origin: string | null) => refuseExtension(code, STATUS[code] ?? 400, origin);

export async function handleExtensionPairingStart(request: Request, runtime: Runtime): Promise<Response> {
  const guard = guardExtensionRequest(request, runtime.extensionOrigins);
  if (!guard.ok) return guard.response;
  const origin = guard.origin;
  const body = await readExtensionJson(request, ["protocolVersion", "challenge", "installationId"]);
  if (!body || body.protocolVersion !== 1) return refusal("BAD_REQUEST", origin);
  const started = runtime.pairing.start({ challenge: body.challenge, extensionOrigin: origin, installationId: body.installationId }, runtime.clock().getTime());
  return started.ok ? extensionJson({ ok: true, value: started.value }, 200, origin) : refusal(started.code, origin);
}

export async function handleExtensionPairingStatus(request: Request, runtime: Runtime, pairingId: string): Promise<Response> {
  const guard = guardExtensionRequest(request, runtime.extensionOrigins);
  if (!guard.ok) return guard.response;
  const origin = guard.origin;
  if (!PAIRING_ID.test(pairingId)) return refusal("PAIRING_UNKNOWN", origin);
  const body = await readExtensionJson(request, ["exchangeSecret"]);
  if (!body) return refusal("BAD_REQUEST", origin);
  const status = runtime.pairing.status({ pairingId, exchangeSecret: body.exchangeSecret, extensionOrigin: origin }, runtime.clock().getTime());
  return status.ok ? extensionJson({ ok: true, value: status.value }, 200, origin) : refusal(status.code, origin);
}

export async function handleExtensionPairingExchange(request: Request, runtime: Runtime, pairingId: string): Promise<Response> {
  const guard = guardExtensionRequest(request, runtime.extensionOrigins);
  if (!guard.ok) return guard.response;
  const origin = guard.origin;
  if (!PAIRING_ID.test(pairingId)) return refusal("PAIRING_UNKNOWN", origin);
  const body = await readExtensionJson(request, ["exchangeSecret", "verifier"]);
  if (!body) return refusal("BAD_REQUEST", origin);
  const exchanged = await runtime.pairing.exchange({ pairingId, exchangeSecret: body.exchangeSecret, verifier: body.verifier, extensionOrigin: origin }, runtime.clock());
  return exchanged.ok ? extensionJson({ ok: true, value: exchanged.value }, 200, origin) : refusal(exchanged.code, origin);
}

const NOTICES: ReadonlySet<string> = new Set<NeedsNotice>(["malformed", "missing_use", "missing_budget", "ambiguous", "review", "unavailable"]);

/** What the side panel may read: the session's current draft summary and its conversation. No prices, quotes or payment. */
export function extensionConversationView(runtime: Runtime, sessionId: string) {
  const now = runtime.clock().getTime();
  const stored = needsDraftsFor(runtime.store).get(sessionId) ?? null;
  const draft = stored && now < stored.expiresAtMs ? stored : null;
  const conversation = readConversation(runtime.store, sessionId);
  return {
    draft: draft && {
      draftId: draft.draftId,
      version: draft.version,
      language: draft.language,
      notice: draft.notice,
      prefilledUse: draft.prefilledUse,
      prefilledBudgetDollars: draft.prefilledBudgetDollars,
      confirmedUse: draft.confirmedUse,
      confirmedBudgetDollars: draft.confirmedBudgetDollars,
      recommendationClaim: draft.recommendationClaim,
    },
    // An assistant line is stored as a notice key; the panel gets the same localized text the website shows.
    conversation:
      draft && conversation && conversation.draftId === draft.draftId
        ? {
            interfaceLanguage: conversation.interfaceLanguage,
            turns: conversation.turns.map((turn) => {
              if (turn.role !== "assistant") return turn;
              if (NOTICES.has(turn.text)) return { role: turn.role, text: journeyCopy(conversation.interfaceLanguage).notices[turn.text as NeedsNotice] };
              if ((CHARGER_LINES as readonly string[]).includes(turn.text)) {
                return { role: turn.role, text: chargerCopy(conversation.interfaceLanguage).conversationLines[turn.text as (typeof CHARGER_LINES)[number]] };
              }
              return turn;
            }),
          }
        : null,
  };
}

/**
 * POST /api/extension/v1/conversation: the panel's read of the shared conversation. A POST so that the browser always sends
 * the extension's Origin; the body must be exactly `{}`. Side-effect free: it changes no draft, conversation, grant or limit.
 */
export async function handleExtensionConversation(request: Request, runtime: Runtime): Promise<Response> {
  const guard = guardExtensionRequest(request, runtime.extensionOrigins);
  if (!guard.ok) return guard.response;
  const origin = guard.origin;
  const resolved = runtime.pairing.resolve(bearerOf(request), "conversation:read", origin, runtime.clock());
  if (!resolved.ok) return refusal(resolved.code, origin);
  if (!(await readExtensionJson(request, []))) return refusal("BAD_REQUEST", origin);
  return extensionJson({ ok: true, value: extensionConversationView(runtime, resolved.value.sessionId) }, 200, origin);
}

/**
 * GET /api/extension/v1/conversation: retired (the read is a POST). 405 with `Allow: POST`, no-store; still "not found" when
 * no extension origin is configured, like every other extension route. Nothing is read or resolved.
 */
export function handleExtensionConversationGet(runtime: Runtime): Response {
  if (runtime.extensionOrigins.size === 0) return refuseExtension("NOT_FOUND", 404);
  return Response.json({ ok: false, code: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { allow: "POST", "cache-control": "no-store", vary: "Origin" } });
}

const DRAFT_ID = /^nd_[0-9a-f]{32}$/;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const REPLAY_TTL_MS = 600_000;
const REPLAY_MAX = 500;
/**
 * Per grant and client request id: the response already given, so a retry gets it again rather than STALE_DRAFT.
 * `fingerprint` identifies the message the id was first used for; the same id with a different message is refused.
 * Process-local.
 */
type Replay = { readonly status: number; readonly body: unknown; readonly expiresAtMs: number; readonly fingerprint: string };
const replays = new WeakMap<Runtime, Map<string, Replay>>();

function replayCache(runtime: Runtime) {
  let found = replays.get(runtime);
  if (!found) {
    found = new Map();
    replays.set(runtime, found);
  }
  return found;
}

/** POST /api/extension/v1/conversation/turns: one follow-up message from the panel, on the website's durable path. */
export async function handleExtensionTurn(request: Request, runtime: Runtime): Promise<Response> {
  const guard = guardExtensionRequest(request, runtime.extensionOrigins);
  if (!guard.ok) return guard.response;
  const origin = guard.origin;
  const resolved = runtime.pairing.resolve(bearerOf(request), "conversation:write", origin, runtime.clock());
  if (!resolved.ok) return refusal(resolved.code, origin);
  const body = await readExtensionJson(request, ["draftId", "version", "shopperText", "clientRequestId"]);
  if (!body) return refusal("BAD_REQUEST", origin);
  const { draftId, version, shopperText, clientRequestId } = body;
  if (typeof draftId !== "string" || !DRAFT_ID.test(draftId)) return refusal("DRAFT_NOT_FOUND", origin);
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 999_999_999) return refusal("BAD_REQUEST", origin);
  if (typeof shopperText !== "string" || shopperText.trim().length === 0 || shopperText.length > 2000) return refusal("CLARIFICATION_INVALID", origin);
  if (typeof clientRequestId !== "string" || !CLIENT_REQUEST_ID.test(clientRequestId)) return refusal("BAD_REQUEST", origin);

  const now = runtime.clock().getTime();
  const cache = replayCache(runtime);
  for (const [key, entry] of cache) if (entry.expiresAtMs <= now) cache.delete(key);
  const key = `${resolved.value.grantId}\u0000${clientRequestId}`;
  const fingerprint = createHash("sha256").update(JSON.stringify([draftId, version, shopperText.trim()])).digest("hex");
  const replay = cache.get(key);
  if (replay) return replay.fingerprint === fingerprint ? extensionJson(replay.body, replay.status, origin) : refusal("REQUEST_ID_CONFLICT", origin);

  const { sessionId } = resolved.value;
  const liveUntil = runtime.durable.sessionStore.liveUntil(sessionId, SESSION_IDLE_TIMEOUT_MS);
  if (liveUntil === null || liveUntil <= now) return refusal("TOKEN_INVALID", origin);
  // The website's follow-up limit, on the same counter (policy and session): website and panel share one allowance.
  // Checked before any interpretation; a refusal is not remembered, so the same request can be sent again later.
  const limit = await runtime.limiter.consume(PROPOSED_RATE_LIMIT_POLICIES.aiMessage, sessionId);
  if (!limit.allowed) {
    const limited = refusal("RATE_LIMITED", origin);
    limited.headers.set("retry-after", String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
    return limited;
  }
  const outcome = await continueNeedsFollowUp(runtime, sessionId, {
    draftId,
    version,
    text: shopperText.trim(),
    typedUse: null,
    typedBudget: null,
    typedUseProvided: false,
    typedBudgetProvided: false,
    expiresAtMs: liveUntil,
    live: () => runtime.checkout.sessionIsLive(sessionId),
  });
  if (outcome.kind === "session_dead") return refusal("TOKEN_INVALID", origin);
  const result =
    outcome.kind === "refused"
      ? { status: STATUS[outcome.code] ?? 400, body: { ok: false, code: outcome.code } }
      : { status: 200, body: { ok: true, value: { failure: outcome.kind === "done" ? outcome.failure : null, duplicate: outcome.kind === "duplicate", ...extensionConversationView(runtime, sessionId) } } };
  if (cache.size >= REPLAY_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { ...result, expiresAtMs: now + REPLAY_TTL_MS, fingerprint });
  return extensionJson(result.body, result.status, origin);
}

