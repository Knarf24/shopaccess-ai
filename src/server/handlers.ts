import { eligibleChargerTrack } from "@/server/charger-purchase";
import { startCheckoutWithQuote } from "@/lib/checkout/service";
import { allowlistedJourneyLanguage, explicitJourneyLanguage, guidedShopDestination } from "@/lib/i18n/language";
import { confirmPurchaseSummary } from "@/lib/confirmation/confirmation";
import { formatAdvisoryFailureDiagnostic, interpretNeedsSafely } from "@/lib/providers/ai";
import { withAdvisorySession } from "./advisory-limits";
import { INTENDED_USES, type IntendedUse } from "@/lib/readiness/engine";
import { ShopperMessageSchema } from "@/lib/security/limits";
import { legacyWorkloadRecord } from "@/lib/readiness/conversation-workload";
import { resolveDurableConversationWorkload } from "@/lib/readiness/durable-conversation-workload";
import { updateWorkloadFromShopperTurn } from "@/lib/readiness/workload-record-update";
import { setWorkloadRecord, workloadRecordForDraft } from "@/lib/session/workload-state";
import { recordAcceptedLaptopWorkload } from "@/lib/readiness/accepted-workload-turn";
import { classifyChargerText } from "@/lib/compatibility/charger-intent";
import {
  applyChargerControl,
  assistantLineAfterLaptopResult,
  chargerTrackFor,
  deleteChargerTracks,
  isOpenChargerTrack,
  laptopOutputAllowed,
  routeChargerText,
  setChargerTrack,
  type ChargerControl,
  type ChargerLine,
} from "@/lib/session/charger-clarification";
import {
  cancelCheckout,
  dispatchCapture,
  dispatchOrderCreate,
  isCaptureRecordUnsaved,
  observeCaptureAftermath,
  reconcileOperation,
  recordBuyerReturn,
  verifyApproval,
} from "@/lib/payment/orchestrator";
import type { PaymentOperation } from "@/lib/payment/operations";
import { transition, type PaymentSnapshot, type PaymentState } from "@/lib/payment/state-machine";
import { journeyCopy, type JourneyCopy } from "@/lib/i18n/demo-copy";
import { toPublicError, type PublicErrorCode } from "@/lib/security/errors";
import { readLimitedForm } from "@/lib/security/limits";
import { PROPOSED_RATE_LIMIT_POLICIES, type RateLimitPolicy } from "@/lib/security/rate-limit";
import { runtimeSandboxProvider, type Runtime } from "./runtime";
import { readSessionCookie, serializeSessionCookie } from "@/lib/session/cookie";
import { admissionExpiryMs, protectedAdmissionLocation } from "@/server/demo-admission";
import { permissionCopy, type PermissionFormCode } from "@/lib/i18n/permission-copy";
import { parsePermissionForm } from "@/server/permission-form";
import { parseProfileDelete, parseProfileSave } from "@/server/profile-form";
import { authorizeMutation } from "@/lib/session/request-guard";
import type { Session } from "@/lib/session/service";
import {
  checkoutSelectionCurrent,
  conversationStateOf,
  MAX_CONVERSATION_TURNS,
  type ConversationState,
  replaceConversationState,
  invalidatePurchaseSelections,
  mergeFollowUpCandidate,
  noteCheckoutSelection,
  purchaseSelectionsOpen,
  recordConversationTurn,
  reopenPurchaseSelections,
} from "@/lib/session/conversation";
import {
  applyInterpretation,
  beginInterpretation,
  claimFollowUp,
  commitFollowUp,
  confirmNeeds,
  needsDraftsFor,
  proposeStructuredRevision,
  saveStructuredNeeds,
  type JourneyLanguage,
  type NeedsDraft,
} from "@/lib/session/store";
import { ID_PATTERNS } from "@/lib/shared/ids";
import { failureNoticeCode, mergeInterpretedNeeds, parsePreferences, preferencesQuery, settleShopperText } from "./shopping";
import { availableSteps, SIMULATION_STEPS, type SimulationStep } from "./simulation";

/**
 * HTTP handlers for the mock demonstration, written against the standard
 * Request/Response types so they can be tested without a server. Every
 * state-changing handler goes through `guardMutation` first.
 */
const SIMULATION_POLICY: RateLimitPolicy = { name: "simulation_step", limit: 60, windowMs: 60_000 };

function seeOther(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
}

/** Stops a protected mock request before maintenance, session resolution, or checkout work. */
function admissionRefusal(request: Request, runtime: Runtime): Response | null {
  const location = protectedAdmissionLocation(
    runtime.admission,
    request.headers.get("cookie"),
    runtime.clock().getTime(),
    new URL(request.url).searchParams.get("lang"),
  );
  return location === null ? null : seeOther(location);
}

function refuse(code: PublicErrorCode, runtime: Runtime, retryAfterMs?: number): Response {
  const error = toPublicError(code, runtime.ids("event"));
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (retryAfterMs !== undefined) headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  return Response.json(error.body, { status: error.status, headers });
}

async function guardMutation(
  request: Request,
  runtime: Runtime,
  policy: RateLimitPolicy,
): Promise<{ ok: true; session: Session; form: URLSearchParams } | { ok: false; response: Response }> {
  await runtime.maintain();
  const form = await readLimitedForm(request);
  if (!form.ok) return { ok: false, response: refuse(form.error === "BODY_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", runtime) };

  const authorized = await authorizeMutation(request, runtime, form.value.get("csrfToken"));
  if (!authorized.ok) return { ok: false, response: refuse("FORBIDDEN", runtime) };

  const limit = await runtime.limiter.consume(policy, authorized.value.id);
  if (!limit.allowed) return { ok: false, response: refuse("RATE_LIMITED", runtime) };
  return { ok: true, session: authorized.value, form: form.value };
}

async function audit(runtime: Runtime, session: Session, eventType: string, checkoutIntentId: string | null, detail: Record<string, unknown>): Promise<void> {
  await runtime.audit.append({
    eventId: runtime.ids("event"),
    eventType,
    occurredAt: runtime.clock().toISOString(),
    actor: "shopper",
    sessionId: session.id,
    checkoutIntentId,
    operationId: null,
    detail,
  });
}

/**
 * GET /session/start: makes sure the browser has a server-issued anonymous
 * session, then continues to the recommendations page. A cookie value the
 * server does not recognise is never adopted; a fresh token is issued instead.
 */
export async function handleSessionStart(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const url = new URL(request.url);
  const preferences = parsePreferences(url.searchParams.get("use"), url.searchParams.get("budget"));
  // The destination is always this fixed local path; nothing from the request chooses it.
  // `started=1` lets the page detect a browser that dropped the cookie, instead of redirecting back here forever.
  const destination = preferences ? `/shop?${preferencesQuery(preferences)}&started=1` : "/";

  await runtime.maintain();
  // New sessions are subject to a process-wide allocation budget and capacity limit; existing ones are not.
  const established = await runtime.sessions.establish(readSessionCookie(request.headers.get("cookie")));
  if (!established.ok) {
    const code = established.error.reason === "ALLOCATION_RATE_EXCEEDED" ? "RATE_LIMITED" : "UNAVAILABLE";
    return refuse(code, runtime, established.error.retryAfterMs);
  }
  const issued = established.value;
  if (!issued.issuedToken) return seeOther(destination);
  return seeOther(destination, {
    "set-cookie": serializeSessionCookie(issued.issuedToken, runtime.sessions.cookieMaxAgeSeconds(issued.session)),
  });
}

/** POST /checkout/start: creates a checkout intent and a server-priced quote for one demo variant. */
export async function handleCheckoutStart(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.quoteRequest);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;

  const preferences = parsePreferences(form.get("use"), form.get("budget"));
  const interfaceLanguage = explicitJourneyLanguage(form.get("lang"));
  const back = interfaceLanguage ? `/${interfaceLanguage}/shop/needs?` : preferences ? `/shop?${preferencesQuery(preferences)}&` : "/shop?";
  const needsDraft = needsDraftsFor(runtime.store).get(session.id) ?? null;
  const needsMatched = Boolean(
    preferences &&
      needsDraft &&
      needsDraft.confirmedUse === preferences.use &&
      needsDraft.confirmedBudgetDollars === preferences.budgetDollars,
  );
  if (
    form.has("lang") &&
    preferences &&
    needsDraft &&
    (!purchaseSelectionsOpen(runtime.store, session.id) || (needsDraft.confirmedUse !== null && !needsMatched))
  ) {
    return seeOther(`/${interfaceLanguage ?? needsDraft.language}/shop/needs?error=STALE_DRAFT`);
  }

  // Only these three fields are read. Any price or total in the form is never looked at.
  const quoteRequest = { productId: form.get("productId"), variantId: form.get("variantId"), quantity: Number(form.get("quantity")) };
  // The request is validated and priced before anything is created; a rejected request allocates no checkout records.
  // Language is stored on the mock intent only. It is not part of the quote request.
  const started = await startCheckoutWithQuote(runtime.checkout, session.id, quoteRequest, interfaceLanguage);
  // The session stopped being valid after this request was authorized: same generic refusal as an unauthenticated request.
  if (!started.ok && started.error === "SESSION_NOT_ACTIVE") return refuse("FORBIDDEN", runtime);
  if (!started.ok) return seeOther(`${back}error=${started.error}`);
  const { intent, quote } = started.value;
  if (needsMatched) noteCheckoutSelection(runtime.store, session.id, intent.id);

  await audit(runtime, session, "QUOTE_ISSUED", intent.id, { quoteId: quote.quoteId, totalCents: quote.totalCents });
  return seeOther(`/checkout/${intent.id}`);
}

async function ownedIntent(runtime: Runtime, session: Session, intentId: string) {
  if (!ID_PATTERNS.checkoutIntent.test(intentId)) return null;
  return runtime.store.findIntentForSession(session.id, intentId);
}

/** POST /checkout/:intentId/confirm: records the shopper's explicit confirmation. Contacts no provider. */
export async function handleConfirm(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const intent = await ownedIntent(runtime, session, intentId);
  if (!intent) return refuse("NOT_FOUND", runtime);

  const back = `/checkout/${intent.id}`;
  if (!checkoutSelectionCurrent(runtime.store, session.id, intent.id)) return seeOther(`${back}?error=QUOTE_NO_LONGER_VALID`);
  if (form.get("acknowledged") !== "yes") return seeOther(`${back}?error=ACKNOWLEDGEMENT_REQUIRED`);

  const submission = {
    confirmationId: form.get("confirmationId"),
    nonce: form.get("nonce"),
    quoteId: form.get("quoteId"),
    quoteDigest: form.get("quoteDigest"),
  };
  // The confirmation must belong to the checkout named in the URL.
  const record =
    typeof submission.confirmationId === "string" && ID_PATTERNS.confirmation.test(submission.confirmationId)
      ? await runtime.store.findConfirmationForSession(session.id, submission.confirmationId)
      : null;
  if (record && record.checkoutIntentId !== intent.id) return seeOther(`${back}?error=CONFIRMATION_MISMATCH`);

  const confirmed = await confirmPurchaseSummary(runtime.checkout, session.id, submission);
  await audit(runtime, session, confirmed.ok ? "CONFIRMATION_ACCEPTED" : "CONFIRMATION_REJECTED", intent.id, {
    result: confirmed.ok ? "ACCEPTED" : confirmed.error,
  });
  return seeOther(confirmed.ok ? `${back}?notice=CONFIRMED` : `${back}?error=${confirmed.error}`);
}

function needsLanguage(form: URLSearchParams): JourneyLanguage {
  return allowlistedJourneyLanguage(form.get("lang"));
}

function needsVersion(form: URLSearchParams): number | null {
  const raw = form.get("version");
  if (!raw || !/^[1-9][0-9]{0,8}$/.test(raw)) return null;
  return Number(raw);
}

function needsUse(value: string | null): IntendedUse | null {
  return INTENDED_USES.includes(value as IntendedUse) ? (value as IntendedUse) : null;
}

function needsBudget(value: string | null): string | null {
  return value !== null && /^[1-9][0-9]{1,4}$/.test(value) ? value : null;
}

function draftExpiry(session: Session): number {
  return Math.min(session.idleExpiresAt.getTime(), session.absoluteExpiresAt.getTime());
}

function needsBack(language: JourneyLanguage, code?: string, failure?: string | null, aiLimited = false): string {
  const query = new URLSearchParams();
  if (code) query.set("error", code);
  const notice = failureNoticeCode(failure);
  if (notice) query.set("notice", notice);
  // Not persisted: tells the page that live AI was not used because the server-wide AI call limit was reached.
  if (aiLimited) query.set("ai", "limited");
  const search = query.toString();
  return `/${language}/shop/needs${search ? `?${search}` : ""}`;
}

function chargerControlFromForm(form: URLSearchParams): ChargerControl | null {
  const allowed = new Set(["csrfToken", "lang", "draftId", "revision", "action", "task", "device", "dollars"]);
  const values = new Map<string, string>();
  for (const [key, value] of form) {
    if (!allowed.has(key) || values.has(key)) return null;
    values.set(key, value);
  }
  const action = values.get("action");
  if (action === "propose_budget") {
    if (values.has("task") || values.has("device")) return null;
    const dollars = values.get("dollars");
    return dollars === undefined ? null : { action, dollars };
  }
  if (values.has("dollars")) return null;
  if (action === "confirm_budget") {
    return values.has("task") || values.has("device") ? null : { action };
  }
  if (action === "choose_task") {
    if (values.has("device")) return null;
    const task = values.get("task");
    return task === "charger" || task === "laptop" ? { action, task } : null;
  }
  if (action === "choose_model") {
    if (values.has("task")) return null;
    const device = values.get("device");
    return device ? { action, device } : null;
  }
  if (action === "confirm" || action === "change" || action === "stop") {
    return values.has("task") || values.has("device") ? null : { action };
  }
  return null;
}

/** POST /shop/needs/charger-control. Only explicit website actions can confirm a model. */
export async function handleChargerControl(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.aiMessage);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const requestedLanguage = needsLanguage(form);
  const draftId = form.get("draftId") ?? "";
  const rawRevision = form.get("revision") ?? "";
  const control = chargerControlFromForm(form);
  if (control && (control.action === "propose_budget" || control.action === "confirm_budget") && !runtime.chargerBudgetEnabled) return seeOther(needsBack(requestedLanguage, "CLARIFICATION_INVALID"));
  if (!/^nd_[0-9a-f]{32}$/.test(draftId) || !/^[1-9][0-9]{0,8}$/.test(rawRevision) || !control) {
    return seeOther(needsBack(requestedLanguage, "CLARIFICATION_INVALID"));
  }

  const result = await runtime.durable.change((host) => {
    const now = runtime.clock().getTime();
    if (!runtime.checkout.sessionIsLive(session.id)) return { kind: "session_dead" as const, language: requestedLanguage };
    const draft = needsDraftsFor(host).get(session.id) ?? null;
    if (!draft) return { kind: "missing" as const, language: requestedLanguage };
    if (now >= draft.expiresAtMs) {
      needsDraftsFor(host).delete(session.id);
      deleteChargerTracks(host, [session.id]);
      return { kind: "expired" as const, language: draft.language };
    }
    if (draft.draftId !== draftId) return { kind: "stale" as const, language: draft.language };
    const applied = applyChargerControl(chargerTrackFor(host, session.id, draft.draftId), {
      sessionId: session.id,
      draftId,
      revision: Number(rawRevision),
      control,
    });
    if (applied.kind === "stale") return { kind: "stale" as const, language: draft.language };
    if (applied.kind === "not_allowed") return { kind: "invalid" as const, language: draft.language };
    if (applied.kind === "refused") return { kind: "limit" as const, language: draft.language };
    setChargerTrack(host, applied.track);
    if (control.action !== "propose_budget" && control.action !== "confirm_budget") rememberChargerTurn(host, session.id, draft, "", applied.line);
    // A mixed charger-and-laptop request is a charger turn, which records no laptop workload. When the charger task ends
    // (the laptop is chosen, or the shopper stops), recover the AI requirement stated in the retained conversation and
    // persist it with this transition. Only an AI workload is recovered, and an existing record is never replaced.
    if ((control.action === "stop" || (control.action === "choose_task" && control.task === "laptop")) && applied.track.state === "closed") {
      recoverWorkloadAtTrackEnd(host, session.id, draft);
    }
    return { kind: "applied" as const, language: draft.language };
  });
  if (result.kind === "session_dead") return seeOther(needsBack(requestedLanguage));
  if (result.kind === "missing") return seeOther(needsBack(requestedLanguage, "DRAFT_NOT_FOUND"));
  if (result.kind === "expired") return seeOther(needsBack(result.language, "DRAFT_EXPIRED"));
  if (result.kind === "stale") return seeOther(needsBack(result.language, "STALE_DRAFT"));
  if (result.kind === "invalid" || result.kind === "limit") return seeOther(needsBack(result.language, "CLARIFICATION_INVALID"));
  return seeOther(needsBack(result.language));
}

/**
 * GET /session/needs. Establishes the mock session, then opens the guided page.
 * The destination is always `guidedShopDestination`. No request field can replace that path.
 * A lang value other than the exact tokens `en` and `es` becomes English.
 */
export async function handleNeedsSession(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  await runtime.maintain();
  const established = await runtime.sessions.establish(readSessionCookie(request.headers.get("cookie")));
  if (!established.ok) {
    const code = established.error.reason === "ALLOCATION_RATE_EXCEEDED" ? "RATE_LIMITED" : "UNAVAILABLE";
    return refuse(code, runtime, established.error.retryAfterMs);
  }
  const issued = established.value;
  const headers: Record<string, string> = {};
  if (issued.issuedToken) headers["set-cookie"] = serializeSessionCookie(issued.issuedToken, runtime.sessions.cookieMaxAgeSeconds(issued.session));
  return seeOther(guidedShopDestination(new URL(request.url).searchParams.get("lang")), headers);
}

/** Explicit interface-language choice, with no change to shopping or purchase authority. */
export async function handleNeedsLanguage(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const language = explicitJourneyLanguage(form.get("lang"));
  const fromLanguage = explicitJourneyLanguage(form.get("fromLang"));
  if (!language || !fromLanguage || [...form.keys()].some(key => !["lang", "fromLang", "draftId", "version", "csrfToken"].includes(key)) || ["lang", "fromLang", "draftId", "version", "csrfToken"].some(key => form.getAll(key).length !== 1)) return refuse("BAD_REQUEST", runtime);
  const draftId = form.get("draftId");
  const version = form.get("version") ?? "";
  if (!/^nd_[0-9a-f]{32}$/.test(draftId ?? "") || !/^[1-9][0-9]{0,8}$/.test(version)) return refuse("BAD_REQUEST", runtime);
  const result = await runtime.durable.change(host => {
    if (!runtime.checkout.sessionIsLive(session.id)) return "DRAFT_EXPIRED";
    const draft = needsDraftsFor(host).get(session.id);
    if (!draft) return "DRAFT_NOT_FOUND";
    if (runtime.clock().getTime() >= draft.expiresAtMs) return "DRAFT_EXPIRED";
    if (draft.draftId !== draftId || draft.version !== Number(version) || draft.language !== fromLanguage || draft.interpretationPending || draft.recommendationClaim === "pending") return "STALE_DRAFT";
    if (draft.language === language) return null;
    // A language-only change retains version-keyed listings and recommendation provenance.
    needsDraftsFor(host).set(session.id, { ...draft, language });
    const state = conversationStateOf(host);
    const conversation = state.conversations.get(session.id);
    if (conversation?.draftId === draft.draftId) {
      const conversations = new Map(state.conversations);
      conversations.set(session.id, { ...conversation, interfaceLanguage: language });
      replaceConversationState(host, { ...state, conversations });
    }
    return null;
  });
  return seeOther(needsBack(language, result ?? undefined));
}

function rememberNeedsTurn(store: object, sessionId: string, draft: NeedsDraft, shopperText: string): void {
  recordConversationTurn(store, sessionId, {
    draftId: draft.draftId,
    interfaceLanguage: draft.language,
    shopperText,
    assistantNotice: draft.notice,
  });
  if (shopperText.trim()) {
    recordAcceptedLaptopWorkload(
      store, sessionId, draft.draftId, draft.version, shopperText,
    );
  }
}

/**
 * The retained conversation for this draft with the draft's own text placed first, as the oldest turn. The retained
 * conversation keeps only the last eight turns, so the original request may have rolled out of it. This draft's text
 * stays unchanged while a charger track is open (charger-routed texts leave it alone), so it precedes the retained turns,
 * and a later withdrawal that is still retained therefore still wins. No other draft's text can enter.
 */
function conversationWithOrigin(host: object, sessionId: string, draft: NeedsDraft, later: ConversationState["turns"] = []): ConversationState | null {
  const stored = conversationStateOf(host).conversations.get(sessionId) ?? null;
  const retained = stored?.draftId === draft.draftId ? stored : null;
  const turns = [...(retained?.turns ?? []), ...later];
  if (!draft.shopperText.trim()) return retained ? { ...retained, turns } : null;
  return {
    draftId: draft.draftId,
    interfaceLanguage: retained?.interfaceLanguage ?? draft.language,
    turns: [{ role: "shopper", text: draft.shopperText }, ...turns],
  };
}

/** Persists an AI workload recovered from the conversation, unless the draft already has a record. */
function recoverWorkloadAtTrackEnd(host: object, sessionId: string, draft: NeedsDraft, later: ConversationState["turns"] = []): void {
  if (workloadRecordForDraft(host, sessionId, draft.draftId, draft.version)) return;
  const recovered = legacyWorkloadRecord(conversationWithOrigin(host, sessionId, draft, later), sessionId, draft.draftId, draft.version);
  if (recovered && recovered.kind !== "general_programming") setWorkloadRecord(host, recovered);
}

function rememberChargerTurn(store: object, sessionId: string, draft: NeedsDraft, shopperText: string, assistantLine: ChargerLine): void {
  retainWorkloadBeforeTruncation(store, sessionId, draft, shopperText);
  recordConversationTurn(store, sessionId, {
    draftId: draft.draftId,
    interfaceLanguage: draft.language,
    shopperText,
    assistantNotice: assistantLine,
  });
}

/**
 * Charger-routed texts reach only the retained conversation, which keeps the last eight turns. When this turn would push
 * an earlier one out, the AI workload stated so far (this turn included) is made durable first, so it is not lost before
 * the charger task ends. A draft that already has a record follows this turn like any accepted turn, so a later
 * withdrawal still wins. Nothing is recorded for a draft that has stated no AI workload.
 */
function retainWorkloadBeforeTruncation(store: object, sessionId: string, draft: NeedsDraft, shopperText: string): void {
  const text = shopperText.trim();
  if (workloadRecordForDraft(store, sessionId, draft.draftId, draft.version)) {
    if (text) recordAcceptedLaptopWorkload(store, sessionId, draft.draftId, draft.version, text);
    return;
  }
  const stored = conversationStateOf(store).conversations.get(sessionId) ?? null;
  if (!stored || stored.draftId !== draft.draftId) return;
  if (stored.turns.length + (text ? 2 : 1) <= MAX_CONVERSATION_TURNS) return;
  recoverWorkloadAtTrackEnd(store, sessionId, draft, text ? [{ role: "shopper", text }] : []);
}

function rememberLaptopResult(store: object, sessionId: string, draft: NeedsDraft, shopperText: string, workloadAlreadyHandled = false): void {
  const track = chargerTrackFor(store, sessionId, draft.draftId);
  const assistantLine = assistantLineAfterLaptopResult(track, draft.notice);
  recordConversationTurn(store, sessionId, {
    draftId: draft.draftId,
    interfaceLanguage: draft.language,
    shopperText: laptopOutputAllowed(track) ? shopperText : "",
    assistantNotice: assistantLine,
  });
  if (!workloadAlreadyHandled && laptopOutputAllowed(track) && shopperText.trim()) {
    recordAcceptedLaptopWorkload(
      store, sessionId, draft.draftId, draft.version, shopperText,
    );
  }
}

function controlChange<T extends string>(posted: T | null, current: string | null): T | null {
  if (posted === null || posted === current) return null;
  return posted;
}

export type FollowUpOutcome =
  | { readonly kind: "duplicate" }
  | { readonly kind: "session_dead" }
  | { readonly kind: "charger" }
  | { readonly kind: "refused"; readonly code: "STALE_DRAFT" | "DRAFT_EXPIRED" | "CLARIFICATION_INVALID" | "DRAFT_NOT_FOUND" }
  | { readonly kind: "done"; readonly failure: "malformed" | "unavailable" | null; readonly aiLimited?: boolean };

/**
 * One follow-up message on an existing draft, shared by the website form and the extension panel (M2-2). The claim is
 * durable before the interpreter starts, the interpreter's input is the claimed text, and the result, any confirmation
 * withdrawal and the conversation line are one durable decision. `typedUse`/`typedBudget` are the website's structured
 * controls; the panel sends none.
 */
export async function continueNeedsFollowUp(
  runtime: Runtime,
  sessionId: string,
  input: {
    readonly draftId: string;
    readonly version: number;
    readonly text: string;
    readonly typedUse: IntendedUse | null;
    readonly typedBudget: string | null;
    readonly typedUseProvided: boolean;
    readonly typedBudgetProvided: boolean;
    readonly expiresAtMs: number;
    readonly live: () => boolean;
  },
): Promise<FollowUpOutcome> {
  const message = ShopperMessageSchema.safeParse(input.text);
  if (!message.success) return { kind: "refused", code: "CLARIFICATION_INVALID" };
  // The claim is durable before the interpreter starts.
  const claimed = await runtime.durable.change((host) => {
    const now = runtime.clock().getTime();
    if (!input.live()) return { kind: "session_dead" as const };
    const draft = needsDraftsFor(host).get(sessionId) ?? null;
    if (!draft) return { kind: "refused" as const, code: "DRAFT_NOT_FOUND" as const };
    if (now >= draft.expiresAtMs) {
      needsDraftsFor(host).delete(sessionId);
      return { kind: "refused" as const, code: "DRAFT_EXPIRED" as const };
    }
    if (draft.draftId !== input.draftId || draft.version !== input.version) return { kind: "refused" as const, code: "STALE_DRAFT" as const };

    const routed = routeChargerText({
      existing: chargerTrackFor(host, sessionId, draft.draftId),
      sessionId,
      draftId: draft.draftId,
      reading: classifyChargerText(message.data),
      structuredChange:
        (input.typedUseProvided && input.typedUse !== draft.prefilledUse) ||
        (input.typedBudgetProvided && input.typedBudget !== draft.prefilledBudgetDollars),
    });
    if (routed.kind === "refused") return { kind: "refused" as const, code: routed.code };
    if (routed.kind === "charger") {
      if (routed.changed) setChargerTrack(host, routed.track);
      rememberChargerTurn(host, sessionId, draft, message.data, routed.line);
      return { kind: "charger" as const };
    }
    return claimFollowUp(host, sessionId, { draftId: input.draftId, version: input.version, shopperText: message.data, expiresAtMs: input.expiresAtMs, now }, input.live);
  });
  if (claimed.kind === "charger") return { kind: "charger" };
  if (claimed.kind === "refused") return { kind: "refused", code: claimed.code === "CHARGER_LIMIT" ? "CLARIFICATION_INVALID" : claimed.code };
  if (claimed.kind === "duplicate") return { kind: "duplicate" };
  if (claimed.kind === "session_dead") return { kind: "session_dead" };
  if (claimed.kind === "stale") return { kind: "refused", code: "STALE_DRAFT" };
  if (claimed.kind === "expired") return { kind: "refused", code: "DRAFT_EXPIRED" };
  if (claimed.kind === "invalid") return { kind: "refused", code: "CLARIFICATION_INVALID" };
  if (claimed.kind !== "claimed") return { kind: "refused", code: "DRAFT_NOT_FOUND" };

  // Provider input comes from the saved claim, not from the request.
  const claimedText = claimed.draft.shopperText;
  // Every AI call runs in this session's advisory scope, so it reserves against the call limits.
  const interpreted = await withAdvisorySession(sessionId, () =>
    interpretNeedsSafely(runtime.ai, claimedText, (diagnostic) => {
      const line = formatAdvisoryFailureDiagnostic(diagnostic);
      if (line) console.warn(line);
    }, { intendedUse: claimed.draft.prefilledUse, budgetDollars: claimed.draft.prefilledBudgetDollars }),
  );
  if (!input.live()) return { kind: "refused", code: "DRAFT_EXPIRED" };
  const model = interpreted.ok ? interpreted.value : interpreted.error === "OUTPUT_INVALID" ? "malformed" : "unavailable";
  const typedUse = controlChange(input.typedUse, claimed.draft.prefilledUse);
  const typedBudget = controlChange(input.typedBudget, claimed.draft.prefilledBudgetDollars);
  const settled = mergeInterpretedNeeds(typedUse, typedBudget, settleShopperText(claimedText, model));
  const merged = mergeFollowUpCandidate(claimed.draft, settled);
  const confirmedUse = claimed.draft.confirmedUse;
  const confirmedBudget = claimed.draft.confirmedBudgetDollars;
  const withdrawConfirmationForNeeds = Boolean(
    confirmedUse &&
      confirmedBudget &&
      merged.notice === "review" &&
      merged.prefilledUse &&
      merged.prefilledBudgetDollars &&
      (merged.prefilledUse !== confirmedUse || merged.prefilledBudgetDollars !== confirmedBudget),
  );
  // One durable decision: the follow-up result, any confirmation withdrawal, and the conversation line.
  await runtime.durable.change((host) => {
    const conversation = conversationStateOf(host).conversations.get(sessionId) ?? null;
      const previous = conversation?.draftId === claimed.draft.draftId ? conversation : null;
      const previousWorkload = resolveDurableConversationWorkload(
        host,
        sessionId,
        claimed.draft.draftId,
        claimed.draft.version,
        previous,
      );
      const savedWorkload = workloadRecordForDraft(
        host,
        sessionId,
        claimed.draft.draftId,
        claimed.draft.version,
      );
      // Recover legacy context only when no matching durable record exists, and only from what the retained
      // conversation actually states: no stated workload recovers no record.
      const workloadBeforeTurn =
        savedWorkload ??
        legacyWorkloadRecord(previous, sessionId, claimed.draft.draftId, claimed.draft.version);
      const updatedWorkload = updateWorkloadFromShopperTurn(
        workloadBeforeTurn,
        claimedText,
        sessionId,
        claimed.draft.draftId,
        claimed.draft.version,
      );
      // A workload change counts, and is persisted, only while laptop output is allowed. An open charger track
      // (for example opened while the interpreter ran) means this laptop turn changes no workload.
      const workloadWritable = laptopOutputAllowed(chargerTrackFor(host, sessionId, claimed.draft.draftId));
      const nextWorkload = workloadWritable ? updatedWorkload?.kind ?? previousWorkload : previousWorkload;
      const withdrawConfirmation =
        withdrawConfirmationForNeeds ||
        Boolean(
          confirmedUse &&
          confirmedBudget &&
          previousWorkload !== nextWorkload,
        );
      const written = commitFollowUp(host, sessionId, claimed.draft.draftId, claimed.draft.version, { ...merged, withdrawConfirmation }, runtime.clock().getTime());
    if (written && withdrawConfirmation) invalidatePurchaseSelections(host, sessionId);
    if (written) {
      if (workloadWritable && updatedWorkload) {
        setWorkloadRecord(host, updatedWorkload);
      }
      rememberLaptopResult(host, sessionId, written, claimedText, true);
    }
  });
  return { kind: "done", failure: model === "malformed" || model === "unavailable" ? model : null, aiLimited: !interpreted.ok && interpreted.error === "AI_LIMITED" };
}

/** POST /shop/needs/submit. A complete structured use and budget does not call the interpreter. */
export async function handleNeedsSubmit(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.aiMessage);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const language = needsLanguage(form);
  const expiresAtMs = draftExpiry(session);

  // A draft with no new message is the structured fallback: zero interpreter calls.
  // A new message is one follow-up interpretation. Confirmed fields change only through confirmNeeds.
  if (form.has("draftId")) {
    const draftId = form.get("draftId") ?? "";
    const version = needsVersion(form);
    if (version === null || !/^nd_[0-9a-f]{32}$/.test(draftId)) return seeOther(needsBack(language, "DRAFT_NOT_FOUND"));
    const reply = (form.get("shopperText") ?? "").trim();
    if (reply.length > 2000) return seeOther(needsBack(language, "TEXT_TOO_LONG"));
    const live = () => runtime.checkout.sessionIsLive(session.id);
    if (reply.length === 0) {
      // One durable decision: the revision, any confirmation withdrawal, and the conversation line.
      const revised = await runtime.durable.change((host) => {
        const result = proposeStructuredRevision(
          host,
          session.id,
          {
            draftId,
            version,
            use: needsUse(form.get("use")),
            budgetDollars: needsBudget(form.get("budget")),
            expiresAtMs,
            now: runtime.clock().getTime(),
          },
          live,
        );
        if (result.kind === "revised") {
          if (result.withdrewConfirmation) invalidatePurchaseSelections(host, session.id);
          rememberNeedsTurn(host, session.id, result.draft, "");
        }
        return result;
      });
      if (revised.kind === "session_dead") return seeOther(needsBack(language));
      if (revised.kind === "stale") return seeOther(needsBack(language, "STALE_DRAFT"));
      if (revised.kind === "expired") return seeOther(needsBack(language, "DRAFT_EXPIRED"));
      if (revised.kind === "missing") return seeOther(needsBack(language, "DRAFT_NOT_FOUND"));
      if (revised.kind === "invalid") return seeOther(needsBack(language, "CLARIFICATION_INVALID"));
      if (revised.kind === "unchanged") return seeOther(needsBack(language));
      return seeOther(needsBack(language));
    }

    const outcome = await continueNeedsFollowUp(runtime, session.id, {
      draftId,
      version,
      text: reply,
      typedUse: needsUse(form.get("use")),
      typedBudget: needsBudget(form.get("budget")),
      typedUseProvided: form.has("use"),
      typedBudgetProvided: form.has("budget"),
      expiresAtMs,
      live,
    });
    if (outcome.kind === "duplicate" || outcome.kind === "session_dead") return seeOther(needsBack(language));
    if (outcome.kind === "refused") return seeOther(needsBack(language, outcome.code));
    if (outcome.kind === "charger") return seeOther(needsBack(language));
    return seeOther(needsBack(language, undefined, outcome.failure, outcome.aiLimited === true));
  }

  const text = form.get("shopperText") ?? "";
  if (text.trim().length > 2000) return seeOther(needsBack(language, "TEXT_TOO_LONG"));
  const typedUse = needsUse(form.get("use"));
  const typedBudget = needsBudget(form.get("budget"));
  const submittedVersion = needsVersion(form);
  const message = ShopperMessageSchema.safeParse(text);
  const reading = message.success ? classifyChargerText(message.data) : null;

  // A first charger/ambiguous request creates its ordinary needs draft and clarification track in one
  // serialized, save-first decision. Laptop fields are deliberately not inferred or attached to this task.
  if (message.success && reading && reading.kind !== "laptop" && reading.kind !== "none") {
    const started = await runtime.durable.change((host) => {
      const now = runtime.clock().getTime();
      if (!runtime.checkout.sessionIsLive(session.id)) return { kind: "session_dead" as const };
      const saved = saveStructuredNeeds(host, session.id, {
        submittedVersion,
        language,
        shopperText: message.data,
        use: null,
        budgetDollars: null,
        notice: null,
        expiresAtMs: draftExpiry(session),
        now,
      });
      if (typeof saved === "string") return { kind: saved as "stale" | "expired" };
      const routed = routeChargerText({
        existing: chargerTrackFor(host, session.id, saved.draftId),
        sessionId: session.id,
        draftId: saved.draftId,
        reading,
        structuredChange: typedUse !== null || typedBudget !== null,
      });
      if (routed.kind === "refused") return { kind: "limit" as const };
      if (routed.kind !== "charger") return { kind: "invalid" as const };
      if (routed.changed) setChargerTrack(host, routed.track);
      rememberChargerTurn(host, session.id, saved, message.data, routed.line);
      return { kind: "saved" as const };
    });
    if (started.kind === "stale") return seeOther(needsBack(language, "STALE_DRAFT"));
    if (started.kind === "expired") return seeOther(needsBack(language, "DRAFT_EXPIRED"));
    if (started.kind !== "saved") return seeOther(needsBack(language));
    return seeOther(needsBack(language));
  }

  const now = runtime.clock().getTime();

  if (typedUse && typedBudget) {
    const saved = await runtime.durable.change((host) => {
      const result = saveStructuredNeeds(host, session.id, {
        submittedVersion,
        language,
        shopperText: text,
        use: typedUse,
        budgetDollars: typedBudget,
        notice: "review",
        expiresAtMs,
        now,
      });
      if (typeof result !== "string") rememberNeedsTurn(host, session.id, result, text);
      return result;
    });
    if (saved === "stale") return seeOther(needsBack(language, "STALE_DRAFT"));
    if (saved === "expired") return seeOther(needsBack(language, "DRAFT_EXPIRED"));
    return seeOther(needsBack(language));
  }

  if (!message.success) {
    const saved = await runtime.durable.change((host) => {
      const result = saveStructuredNeeds(host, session.id, {
        submittedVersion,
        language,
        shopperText: "",
        use: typedUse,
        budgetDollars: typedBudget,
        notice: typedUse ? "missing_budget" : "missing_use",
        expiresAtMs,
        now,
      });
      if (typeof result !== "string") rememberNeedsTurn(host, session.id, result, "");
      return result;
    });
    if (saved === "stale") return seeOther(needsBack(language, "STALE_DRAFT"));
    if (saved === "expired") return seeOther(needsBack(language, "DRAFT_EXPIRED"));
    return seeOther(needsBack(language));
  }

  // The claim is durable before the interpreter starts.
  const claimed = await runtime.durable.change((host) => {
    // A text that carries only a version still follows the charger rules: while a track is open it is a charger turn and
    // never replaces the draft text, so the conversation keeps its order.
    const current = needsDraftsFor(host).get(session.id) ?? null;
    const open =
      current && reading && current.version === submittedVersion && now < current.expiresAtMs
        ? chargerTrackFor(host, session.id, current.draftId)
        : null;
    if (current && reading && isOpenChargerTrack(open)) {
      if (!runtime.checkout.sessionIsLive(session.id)) return { kind: "session_dead" as const };
      const routed = routeChargerText({
        existing: open,
        sessionId: session.id,
        draftId: current.draftId,
        reading,
        structuredChange: typedUse !== null || typedBudget !== null,
      });
      if (routed.kind === "refused") return { kind: "limit" as const };
      if (routed.kind === "charger") {
        if (routed.changed) setChargerTrack(host, routed.track);
        rememberChargerTurn(host, session.id, current, message.data, routed.line);
        return { kind: "charger" as const };
      }
    }
    return beginInterpretation(host, session.id, {
      submittedVersion,
      language,
      shopperText: message.data,
      expiresAtMs,
      now,
    });
  });
  if (claimed.kind === "charger" || claimed.kind === "session_dead") return seeOther(needsBack(language));
  if (claimed.kind === "limit") return seeOther(needsBack(language, "CLARIFICATION_INVALID"));
  if (claimed.kind === "duplicate") return seeOther(needsBack(language));
  if (claimed.kind === "stale") return seeOther(needsBack(language, "STALE_DRAFT"));
  if (claimed.kind === "expired") return seeOther(needsBack(language, "DRAFT_EXPIRED"));
  if (claimed.kind !== "claimed") return seeOther(needsBack(language, "DRAFT_NOT_FOUND"));

  // Provider input comes from the saved claim, not from the request.
  const claimedText = claimed.draft.shopperText;
  const interpreted = await withAdvisorySession(session.id, () =>
    interpretNeedsSafely(runtime.ai, claimedText, (diagnostic) => {
      const line = formatAdvisoryFailureDiagnostic(diagnostic);
      if (line) console.warn(line);
    }),
  );
  if (!runtime.checkout.sessionIsLive(session.id)) return seeOther(needsBack(language, "DRAFT_EXPIRED"));
  const model = interpreted.ok ? interpreted.value : interpreted.error === "OUTPUT_INVALID" ? "malformed" : "unavailable";
  const settled = mergeInterpretedNeeds(typedUse, typedBudget, settleShopperText(claimedText, model));
  // One durable decision: the interpretation result (rechecked against the claim) and the conversation line.
  await runtime.durable.change((host) => {
    const wrote = applyInterpretation(host, session.id, claimed.draft.draftId, claimed.draft.version, settled, runtime.clock().getTime());
    const drafted = needsDraftsFor(host).get(session.id);
    if (wrote && drafted) rememberLaptopResult(host, session.id, drafted, claimedText);
  });
  const failure = model === "malformed" || model === "unavailable" ? model : null;
  return seeOther(needsBack(language, undefined, failure, !interpreted.ok && interpreted.error === "AI_LIMITED"));
}

/**
 * POST /shop/needs/confirm. Stores only the submitted use and budget.
 * A missing draft is refused. It is not recreated as confirmed.
 */
export async function handleNeedsConfirm(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const language = needsLanguage(form);
  const use = needsUse(form.get("use"));
  const budget = needsBudget(form.get("budget"));
  if (!use || !budget) return seeOther(needsBack(language, "CONFIRM_INCOMPLETE"));
  const version = needsVersion(form);
  const draftId = form.get("draftId") ?? "";
  if (version === null || !/^nd_[0-9a-f]{32}$/.test(draftId)) return seeOther(needsBack(language, "DRAFT_NOT_FOUND"));
  // One durable decision: the confirmation and the reopening of needs-bound selections.
  const confirmed = await runtime.durable.change((host) => {
    const result = confirmNeeds(host, session.id, { draftId, version, use, budgetDollars: budget, now: runtime.clock().getTime() });
    if (typeof result !== "string") reopenPurchaseSelections(host, session.id);
    return result;
  });
  if (confirmed === "stale" || confirmed === "conflict") return seeOther(needsBack(language, "STALE_DRAFT"));
  if (confirmed === "expired") return seeOther(needsBack(language, "DRAFT_EXPIRED"));
  if (confirmed === "missing") return seeOther(needsBack(language, "DRAFT_NOT_FOUND"));
  return seeOther(needsBack(language));
}

/**
 * POST /shop/needs/listings. The shopper asks for external listings for the confirmed brief.
 * Without a configured Channel3 transport the answer is "unavailable" and nothing is sent. With one, the search action
 * reserves its limits first; a refusal answers "limit" and nothing is sent.
 */
export async function handleNeedsListings(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const language = needsLanguage(form);
  const version = needsVersion(form);
  const draftId = form.get("draftId") ?? "";
  if (version === null || !/^nd_[0-9a-f]{32}$/.test(draftId)) return seeOther(needsBack(language, "DRAFT_NOT_FOUND"));
  const draft = needsDraftsFor(runtime.store).get(session.id);
  if (!draft || draft.draftId !== draftId) return seeOther(needsBack(language, "DRAFT_NOT_FOUND"));
  if (runtime.clock().getTime() >= draft.expiresAtMs) return seeOther(needsBack(language, "DRAFT_EXPIRED"));
  if (draft.version !== version) return seeOther(needsBack(language, "STALE_DRAFT"));
  if (!draft.confirmedUse || !draft.confirmedBudgetDollars) return seeOther(needsBack(language, "CONFIRM_INCOMPLETE"));
  const search = runtime.channel3.search;
  if (!search || runtime.channel3.mode !== "live") return seeOther(listingsBack(language, "unavailable"));
  const use = draft.confirmedUse;
  const budgetDollars = draft.confirmedBudgetDollars;
  const outcome = await search({
    sessionId: session.id,
    draftId: draft.draftId,
    version: draft.version,
    use,
    budgetDollars,
    currentDraft: () => {
      const current = needsDraftsFor(runtime.store).get(session.id);
      return current ? { draftId: current.draftId, version: current.version } : null;
    },
    now: () => runtime.clock().toISOString(),
  });
  if (outcome.status === "ready") return seeOther(needsBack(language));
  if (outcome.status === "limit") return seeOther(listingsBack(language, "limit"));
  if (outcome.status === "stale") return seeOther(listingsBack(language, "stale"));
  return seeOther(listingsBack(language, "error"));
}

function listingsBack(language: JourneyLanguage, listings: "unavailable" | "limit" | "error" | "stale"): string {
  return `/${language}/shop/needs?${new URLSearchParams({ listings }).toString()}`;
}

async function runSimulationStep(runtime: Runtime, session: Session, intentId: string, step: SimulationStep): Promise<string | null> {
  const { payment, provider, ledger } = runtime;
  const intent = await runtime.store.findIntentForSession(session.id, intentId);
  if (!intent) return "INTENT_NOT_FOUND";
  const { context } = intent.snapshot;
  const captureReference = async () => (context.captureOperationId ? ((await ledger.find(context.captureOperationId))?.providerReference ?? null) : null);
  const outcome = (result: { ok: boolean; error?: string }) => (result.ok ? null : (result.error ?? "STEP_FAILED"));

  switch (step) {
    case "create_order":
      return outcome(await dispatchOrderCreate(payment, intentId));
    case "create_order_lost_response":
      provider.failNextCreateOrder("LOSE_RESPONSE");
      return outcome(await dispatchOrderCreate(payment, intentId));
    case "buyer_approve":
    case "buyer_return_without_approval": {
      if (!context.providerOrderId) return "STEP_NOT_AVAILABLE";
      if (step === "buyer_approve") provider.simulateBuyerApproval(context.providerOrderId);
      if (intent.snapshot.state !== "APPROVAL_CHECK_PENDING") {
        const returned = await recordBuyerReturn(payment, session.id, intentId);
        if (!returned.ok) return returned.error;
      }
      return outcome(await verifyApproval(payment, intentId));
    }
    case "capture":
      return outcome(await dispatchCapture(payment, intentId));
    case "capture_pending":
      provider.setNextCaptureBehavior("PENDING");
      return outcome(await dispatchCapture(payment, intentId));
    case "capture_declined":
      provider.setNextCaptureBehavior("DECLINE");
      return outcome(await dispatchCapture(payment, intentId));
    case "capture_lost_response":
      provider.failNextCapture("LOSE_RESPONSE");
      return outcome(await dispatchCapture(payment, intentId));
    case "reconcile": {
      const operationId = context.captureDispatched ? context.captureOperationId : context.orderCreateOperationId;
      return operationId ? outcome(await reconcileOperation(payment, operationId)) : "STEP_NOT_AVAILABLE";
    }
    case "settle_pending": {
      const reference = await captureReference();
      if (!reference || !context.captureOperationId) return "STEP_NOT_AVAILABLE";
      provider.simulatePendingCaptureSettled(reference, "COMPLETED");
      return outcome(await reconcileOperation(payment, context.captureOperationId));
    }
    case "external_refund": {
      const reference = await captureReference();
      if (!reference) return "STEP_NOT_AVAILABLE";
      provider.simulateExternalRefund(reference, 10_000);
      return outcome(await observeCaptureAftermath(payment, intentId));
    }
    case "cancel":
      return outcome(await cancelCheckout(runtime.checkout, session.id, intentId));
  }
}

/**
 * POST /checkout/:intentId/simulate: advances the SIMULATED payment lifecycle
 * against the in-memory mock provider. Only steps valid for the current state
 * are accepted, so a rejected request can never leave a queued mock scenario behind.
 */
export async function handleSimulate(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  if (runtime.paymentMode === "sandbox") return refuse("NOT_FOUND", runtime);
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, SIMULATION_POLICY);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const intent = await ownedIntent(runtime, session, intentId);
  if (!intent) return refuse("NOT_FOUND", runtime);

  const back = `/checkout/${intent.id}`;
  const step = SIMULATION_STEPS.find((candidate) => candidate === form.get("step"));
  if (!step || !availableSteps(intent.snapshot.state).includes(step)) return seeOther(`${back}?error=STEP_NOT_AVAILABLE`);

  let error: string | null;
  try {
    error = await runSimulationStep(runtime, session, intent.id, step);
  } catch (thrown) {
    if (!isCaptureRecordUnsaved(thrown)) throw thrown;
    const requestId = publicReference(runtime);
    await auditBestEffort(runtime, session, "SIMULATION_STEP", intent.id, { step, result: "CAPTURE_RECORD_UNSAVED", requestId });
    return captureRecordUnsaved(intent.interfaceLanguage ?? "en", requestId);
  }
  await audit(runtime, session, "SIMULATION_STEP", intent.id, { step, result: error ?? "OK" });
  return seeOther(error ? `${back}?error=${error}` : back);
}

function requestOrigin(request: Request, runtime: Runtime): string | null {
  const origin = request.headers.get("origin");
  return origin !== null && runtime.trustedOrigins.has(origin) ? origin : null;
}

function checkoutBack(intentId: string, error?: string): string {
  return error ? `/checkout/${intentId}?error=${error}` : `/checkout/${intentId}`;
}

async function requireSandbox(request: Request, runtime: Runtime, intentId: string) {
  const sandbox = runtimeSandboxProvider(runtime);
  if (!sandbox) return { ok: false as const, response: refuse("NOT_FOUND", runtime) };
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return { ok: false as const, response: guarded.response };
  const intent = await ownedIntent(runtime, guarded.session, intentId);
  if (!intent) return { ok: false as const, response: refuse("NOT_FOUND", runtime) };
  return { ok: true as const, session: guarded.session, intent, sandbox };
}

/** POST /checkout/:intentId/approve. Mock mode never reaches this. */
export async function handleSandboxApprove(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const ready = await requireSandbox(request, runtime, intentId);
  if (!ready.ok) return ready.response;
  const back = `/checkout/${ready.intent.id}`;
  if (ready.intent.snapshot.state !== "USER_CONFIRMED" || !ready.intent.snapshot.context.quoteId) {
    return seeOther(`${back}?error=APPROVAL_NOT_CONFIRMED`);
  }
  const origin = requestOrigin(request, runtime);
  if (!origin) return seeOther(`${back}?error=APPROVAL_NOT_CONFIRMED`);
  ready.sandbox.armReturnOrigin(ready.intent.id, origin);
  const created = await dispatchOrderCreate(runtime.payment, ready.intent.id);
  const after = await runtime.store.findIntent(ready.intent.id);
  const orderId = after?.snapshot.context.providerOrderId ?? null;
  const approvalUrl = created.ok && after?.snapshot.state === "AWAITING_APPROVAL" && orderId ? ready.sandbox.approvalUrlFor(orderId) : null;
  await audit(runtime, ready.session, "SANDBOX_APPROVE", ready.intent.id, { result: approvalUrl ? "REDIRECT" : "NOT_CONFIRMED" });
  if (approvalUrl) return seeOther(approvalUrl);
  return seeOther(checkoutBack(ready.intent.id, ready.sandbox.consumePublicCode() ?? "APPROVAL_NOT_CONFIRMED"));
}

/** GET /checkout/:intentId/return. Confirms approval only. It does not capture. */
export async function handleSandboxReturn(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const sandbox = runtimeSandboxProvider(runtime);
  if (!sandbox) return refuse("NOT_FOUND", runtime);
  await runtime.maintain();
  const resolved = await runtime.sessions.resolve(readSessionCookie(request.headers.get("cookie")));
  if (!resolved.ok) return seeOther("/");
  const intent = await ownedIntent(runtime, resolved.value, intentId);
  if (!intent) return refuse("NOT_FOUND", runtime);
  const token = new URL(request.url).searchParams.get("token");
  const storedOrderId = intent.snapshot.context.providerOrderId;
  if (token !== null && token !== storedOrderId) return seeOther(checkoutBack(intent.id, "APPROVAL_NOT_CONFIRMED"));
  await recordBuyerReturn(runtime.payment, resolved.value.id, intent.id);
  await verifyApproval(runtime.payment, intent.id);
  const after = await runtime.store.findIntent(intent.id);
  await audit(runtime, resolved.value, "SANDBOX_RETURN", intent.id, { result: after?.snapshot.state === "APPROVED_VERIFIED" ? "APPROVED" : "NOT_CONFIRMED" });
  if (after?.snapshot.state === "APPROVED_VERIFIED") return seeOther(`/checkout/${intent.id}`);
  return seeOther(checkoutBack(intent.id, sandbox.consumePublicCode() ?? "APPROVAL_NOT_CONFIRMED"));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}

/** What the saved payment state proves about capture, for the PayPal cancel-return page. */
export type CancelReturnStatus = "captured" | "captured_observed" | "no_capture" | "canceled" | "uncertain";

/** States in which no capture can have happened, provided the saved context and ledger agree. */
const NO_CAPTURE_STATES: readonly PaymentState[] = [
  "DRAFT",
  "QUOTED",
  "USER_CONFIRMED",
  "ORDER_CREATE_IN_FLIGHT",
  "ORDER_CREATE_UNKNOWN",
  "AWAITING_APPROVAL",
  "APPROVAL_CHECK_PENDING",
  "APPROVED_VERIFIED",
  "DECLINED_RETRYABLE",
  "EXPIRED",
  "SUPERSEDED",
  "FAILED_TERMINAL",
];

/**
 * Classify the saved payment state for the cancel-return page (Codex slices 1–2 review, finding 1).
 * "No capture" needs the state, the capture context and every saved CAPTURE operation to agree that nothing
 * can have been captured; a false or absent dispatch flag alone is not enough. Anything else is uncertain.
 */
export function cancelReturnStatus(snapshot: PaymentSnapshot, captures: readonly PaymentOperation[]): CancelReturnStatus {
  if (snapshot.state === "CAPTURED_VERIFIED") return "captured";
  if (["PARTIALLY_REFUNDED_OBSERVED", "REFUNDED_OBSERVED", "REVERSED_OR_DISPUTED_OBSERVED"].includes(snapshot.state)) return "captured_observed";
  const { captureDispatched, captureOperationId, providerCaptureId } = snapshot.context;
  const nothingCaptured =
    captureDispatched === false &&
    captureOperationId === null &&
    providerCaptureId === null &&
    captures.every((operation) => operation.state === "DECLINED" || operation.state === "REJECTED");
  if (!nothingCaptured) return "uncertain";
  if (snapshot.state === "CANCELED_LOCAL") return "canceled";
  return NO_CAPTURE_STATES.includes(snapshot.state) ? "no_capture" : "uncertain";
}

/** The cancel-return page's statement for a status, in the checkout's language (finding 8). Wording only: `cancelable` is decided by the caller. */
function cancelReturnMessage(status: CancelReturnStatus, cancelable: boolean, copy: JourneyCopy): string {
  const page = copy.checkoutPage.cancelReturn;
  switch (status) {
    case "canceled":
      return copy.sandboxCheckout.canceled;
    case "no_capture":
      return cancelable ? page.noCapture : `${page.noCapture} ${page.notHere}`;
    case "captured":
      return `${copy.sandboxCheckout.captured} ${page.notHere}`;
    case "captured_observed":
      return `${page.capturedObserved} ${page.notHere}`;
    case "uncertain":
      return `${copy.sandboxCheckout.unknown} ${page.notHere}`;
  }
}

/**
 * GET /checkout/:intentId/paypal-cancel. Describes the saved payment state and offers the same-origin cancel form
 * only where the state machine still allows a shopper cancel. It does not cancel and changes no payment or permission.
 */
export async function handleSandboxPaypalCancel(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  if (runtime.paymentMode !== "sandbox") return refuse("NOT_FOUND", runtime);
  await runtime.maintain();
  const resolved = await runtime.sessions.resolve(readSessionCookie(request.headers.get("cookie")));
  if (!resolved.ok) return seeOther("/");
  const intent = await ownedIntent(runtime, resolved.value, intentId);
  if (!intent) return refuse("NOT_FOUND", runtime);
  const status = cancelReturnStatus(intent.snapshot, await runtime.ledger.listForIntent(intent.id, "CAPTURE"));
  const cancelable =
    status === "no_capture" &&
    transition(intent.snapshot, { type: "SHOPPER_CANCELED", eventId: "cancel-return-preview", occurredAt: runtime.clock().toISOString(), actor: "shopper" }).ok;
  // Language comes only from the saved checkout (finding 8); it changes the wording, never what is offered.
  const language = intent.interfaceLanguage ?? "en";
  const copy = journeyCopy(language);
  const page = copy.checkoutPage.cancelReturn;
  const message = cancelReturnMessage(status, cancelable, copy);
  const action = `/checkout/${intent.id}/cancel`;
  const form = cancelable
    ? `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="csrfToken" value="${escapeHtml(resolved.value.csrfToken)}"><button type="submit">${escapeHtml(copy.sandboxCheckout.cancel)}</button></form>`
    : "";
  const back = `<p><a href="${escapeHtml(`/checkout/${intent.id}`)}">${escapeHtml(page.back)}</a></p>`;
  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><title>${escapeHtml(page.title)}</title></head><body><main><h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(message)}</p>${form}${back}</main></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** POST /checkout/:intentId/capture. Success is only CAPTURED_VERIFIED. */
export async function handleSandboxCapture(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const ready = await requireSandbox(request, runtime, intentId);
  if (!ready.ok) return ready.response;
  if (ready.intent.snapshot.state !== "APPROVED_VERIFIED") return seeOther(checkoutBack(ready.intent.id, "APPROVAL_NOT_CONFIRMED"));
  try {
    await dispatchCapture(runtime.payment, ready.intent.id);
  } catch (thrown) {
    if (!isCaptureRecordUnsaved(thrown)) throw thrown;
    const requestId = publicReference(runtime);
    await auditBestEffort(runtime, ready.session, "SANDBOX_CAPTURE", ready.intent.id, { result: "CAPTURE_RECORD_UNSAVED", requestId });
    return captureRecordUnsaved(ready.intent.interfaceLanguage ?? "en", requestId);
  }
  const after = await runtime.store.findIntent(ready.intent.id);
  const captured = after?.snapshot.state === "CAPTURED_VERIFIED";
  await audit(runtime, ready.session, "SANDBOX_CAPTURE", ready.intent.id, { result: captured ? "CAPTURED_VERIFIED" : "NOT_CAPTURED" });
  if (captured) return seeOther(`/checkout/${ready.intent.id}?notice=CAPTURED`);
  return seeOther(checkoutBack(ready.intent.id, ready.sandbox.consumePublicCode() ?? "APPROVAL_NOT_CONFIRMED"));
}

/** POST /checkout/:intentId/cancel. Only before a capture may have been sent. */
export async function handleSandboxCancel(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const ready = await requireSandbox(request, runtime, intentId);
  if (!ready.ok) return ready.response;
  const canceled = await cancelCheckout(runtime.checkout, ready.session.id, ready.intent.id);
  await audit(runtime, ready.session, "SANDBOX_CANCEL", ready.intent.id, { result: canceled.ok ? "CANCELED" : canceled.error });
  if (!canceled.ok) return seeOther(checkoutBack(ready.intent.id, "APPROVAL_NOT_CONFIRMED"));
  return seeOther(`/checkout/${ready.intent.id}`);
}

/**
 * POST /extension/pair/decide (M2-2). The website decides a pairing for its own live session, after the usual admission,
 * origin, Fetch Metadata and CSRF checks. An approval is bounded by the admission expiry when admission is on, and needs
 * the pairing's matching code (finding 3), typed by the shopper from their own side panel. The code is never put in a
 * redirect, a log or the response.
 */
export async function handleExtensionPairDecision(request: Request, runtime: Runtime): Promise<Response> {
  if (runtime.extensionOrigins.size === 0) return refuse("NOT_FOUND", runtime);
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const language = needsLanguage(form);
  const pairingId = form.get("pairingId") ?? "";
  const decision = form.get("decision");
  if (!/^[0-9a-f]{64}$/.test(pairingId) || (decision !== "approve" && decision !== "deny")) return seeOther(`/${language}/extension/pair?result=failed`);
  const nowMs = runtime.clock().getTime();
  // Spaces and hyphens a shopper may type between the digit groups are ignored; anything else must be six digits.
  const matchCode = (form.get("matchCode") ?? "").replace(/[\s-]+/g, "");
  const decided = runtime.pairing.approve(
    { pairingId, sessionId: session.id, deny: decision === "deny", boundMs: admissionExpiryMs(runtime.admission, request.headers.get("cookie"), nowMs), matchCode },
    nowMs,
  );
  // A wrong code returns to the same pairing's form (the pairing ID is not secret); the code itself is never echoed.
  if (!decided.ok && decided.code === "PAIRING_CODE_MISMATCH") return seeOther(`/${language}/extension/pair?pairing=${pairingId}&result=code_mismatch`);
  // A correct code with the session already at its limit of approved, not yet connected panels: the pairing stays pending.
  if (!decided.ok && decided.code === "PAIRING_LIMIT") return seeOther(`/${language}/extension/pair?pairing=${pairingId}&result=pair_limit`);
  const result = decided.ok ? decided.value.status : decided.code === "PAIRING_CODE_LIMIT" ? "code_limit" : "failed";
  return seeOther(`/${language}/extension/pair?result=${result}`);
}

/** POST /extension/revoke (M2-2). Revokes one of this session's grants; durable before the page reports it. */
export async function handleExtensionRevoke(request: Request, runtime: Runtime): Promise<Response> {
  if (runtime.extensionOrigins.size === 0) return refuse("NOT_FOUND", runtime);
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const language = needsLanguage(form);
  const grantId = form.get("grantId") ?? "";
  if (!/^grt_[0-9a-f]{32}$/.test(grantId)) return seeOther(needsBack(language));
  const revoked = await runtime.pairing.revoke(session.id, grantId, runtime.clock());
  if (revoked !== "revoked") return seeOther(needsBack(language));
  return seeOther(`/${language}/shop/needs?revoked=${grantId.slice(4, 12)}`);
}

/** Where the permissions page reports a create or revoke outcome, with the entered values echoed back (never secrets). */
function permissionsBack(language: JourneyLanguage, outcome: Record<string, string>): string {
  return `/${language}/shop/permissions?${new URLSearchParams(outcome).toString()}`;
}

const MODEL_TO_FORM: Record<string, PermissionFormCode> = {
  BAD_REQUEST: "ITEM_INVALID",
  NOT_IN_CATALOG: "ITEM_INVALID",
  QUANTITY_INVALID: "QUANTITY_INVALID",
  TOTAL_INVALID: "TOTAL_INVALID",
  SESSION_INVALID: "SESSION_INVALID",
  PERMISSION_DUPLICATE: "PERMISSION_DUPLICATE",
  PERMISSION_LIMIT: "PERMISSION_LIMIT",
};

/**
 * POST /shop/permissions/create (M2-3). The website's own guard (admission, trusted origin, same-origin Fetch Metadata,
 * CSRF, rate limit) and a live session. The item is validated against the catalog and the seller taken from it.
 * Saved before the page reports it. No extension credential has any effect here: only the website cookie and CSRF.
 */
export async function handlePermissionCreate(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const language = needsLanguage(form);
  const entered = { item: form.get("item") ?? "", quantity: form.get("quantity") ?? "", total: form.get("total") ?? "", expiry: form.get("expiry") ?? "" };
  const parsed = parsePermissionForm(entered, runtime.catalog, eligibleChargerTrack(runtime, session.id)?.budget?.confirmedCents ?? undefined);
  if (!parsed.ok) return seeOther(permissionsBack(language, { error: parsed.code, ...entered }));
  const now = runtime.clock();
  const made = await runtime.permissions.create(
    { sessionId: session.id, ...parsed.value, admissionExpiresAtMs: admissionExpiryMs(runtime.admission, request.headers.get("cookie"), now.getTime()) },
    now,
  );
  if (!made.ok) return seeOther(permissionsBack(language, { error: MODEL_TO_FORM[made.code] ?? "ITEM_INVALID", ...entered }));
  return seeOther(permissionsBack(language, { result: "created" }));
}

/**
 * POST /shop/permissions/revoke (M2-3). Same guard. The server decides: active or reserved is revoked (a reserved
 * checkout then fails closed); executing is refused as in progress; used, revoked, ended or outcome-unknown permissions
 * cannot be revoked. Another session's permission does not exist here.
 */
export async function handlePermissionRevoke(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const { session, form } = guarded;
  const language = needsLanguage(form);
  const permissionId = form.get("permissionId") ?? "";
  if (!/^prm_[0-9a-f]{32}$/.test(permissionId)) return seeOther(permissionsBack(language, { error: "REVOKE_NOT_AVAILABLE" }));
  const result = await runtime.permissions.revoke(session.id, permissionId, runtime.clock());
  if (result === "revoked") return seeOther(permissionsBack(language, { result: "revoked" }));
  return seeOther(permissionsBack(language, { error: result === "in_progress" ? "REVOKE_IN_PROGRESS" : "REVOKE_NOT_AVAILABLE" }));
}

/**
 * A capture was sent, but its final record could not be saved (M2-3). Never "failed" and never "try again": the payment
 * may have gone through. The store stays unavailable (the gate is blocked) and the outcome is checked manually.
 *
 * The request is a form post, so the answer is a full page (review finding 6): language, title, heading and the message
 * as an alert, then the same non-sensitive reference the earlier JSON answer carried (also in the audit record). It has
 * no form, button, link or script, so nothing on it can pay, retry or resubmit; a resubmitted request is refused before
 * any handler runs while the store is unavailable.
 */
function captureRecordUnsaved(language: JourneyLanguage, requestId: string): Response {
  const copy = permissionCopy(language);
  const title = escapeHtml(copy.captureRecordUnsavedTitle);
  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p role="alert">${escapeHtml(copy.captureRecordUnsaved)}</p><p>${escapeHtml(copy.referenceLabel)}: <code>${escapeHtml(requestId)}</code></p></main></body></html>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** The public request reference (letters, digits, - and _ only), as every refusal carries. */
function publicReference(runtime: Runtime): string {
  return toPublicError("UNAVAILABLE", runtime.ids("event")).body.error.requestId;
}

/**
 * Audits an outcome without letting the audit change the answer. The in-memory audit log is separate from the blocked
 * state store, so this normally succeeds; it is process-local and lost on restart. A durable audit log kept in the same
 * store would be refused here, and the shopper must still get the do-not-pay-again page, so a failure is swallowed.
 */
async function auditBestEffort(runtime: Runtime, session: Session, eventType: string, checkoutIntentId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await audit(runtime, session, eventType, checkoutIntentId, detail);
  } catch {
    // Nothing more can be done safely here; the answer below must not change.
  }
}

function profileBack(language: JourneyLanguage, outcome: Record<string, string>): string {
  return `/${language}/shop/profile?${new URLSearchParams(outcome).toString()}`;
}

/**
 * POST /shop/profile/save. The same admission, origin, Fetch Metadata, CSRF and confirmation rate limit as the other
 * website forms. The owner is the authenticated session. A posted session id is not a field this form accepts.
 */
export async function handleProfileSave(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const parsed = parseProfileSave(guarded.form);
  if (!parsed.ok || !parsed.write) return seeOther(profileBack("en", { error: "MALFORMED" }));
  const saved = await runtime.profiles.save(guarded.session.id, parsed.write);
  if (!saved.ok) return seeOther(profileBack(parsed.language, { error: saved.code }));
  return seeOther(profileBack(parsed.language, { result: saved.outcome }));
}

/** POST /shop/profile/delete. Same guard. Removes this session's profile when the posted version matches. */
export async function handleProfileDelete(request: Request, runtime: Runtime): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const guarded = await guardMutation(request, runtime, PROPOSED_RATE_LIMIT_POLICIES.confirmation);
  if (!guarded.ok) return guarded.response;
  const parsed = parseProfileDelete(guarded.form);
  if (!parsed.ok) return seeOther(profileBack("en", { error: "MALFORMED" }));
  const removed = await runtime.profiles.remove(guarded.session.id, parsed.version);
  if (!removed.ok) return seeOther(profileBack(parsed.language, { error: removed.code }));
  return seeOther(profileBack(parsed.language, { result: removed.outcome }));
}

