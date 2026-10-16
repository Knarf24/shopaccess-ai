import { startCheckoutWithQuote } from "@/lib/checkout/service";
import { allowlistedJourneyLanguage, explicitJourneyLanguage, guidedShopDestination } from "@/lib/i18n/language";
import { confirmPurchaseSummary } from "@/lib/confirmation/confirmation";
import { formatAdvisoryFailureDiagnostic, interpretNeedsSafely } from "@/lib/providers/ai";
import { INTENDED_USES, type IntendedUse } from "@/lib/readiness/engine";
import { ShopperMessageSchema } from "@/lib/security/limits";
import {
  cancelCheckout,
  dispatchCapture,
  dispatchOrderCreate,
  observeCaptureAftermath,
  reconcileOperation,
  recordBuyerReturn,
  verifyApproval,
} from "@/lib/payment/orchestrator";
import { toPublicError, type PublicErrorCode } from "@/lib/security/errors";
import { readLimitedForm } from "@/lib/security/limits";
import { PROPOSED_RATE_LIMIT_POLICIES, type RateLimitPolicy } from "@/lib/security/rate-limit";
import { runtimeSandboxProvider, type Runtime } from "./runtime";
import { readSessionCookie, serializeSessionCookie } from "@/lib/session/cookie";
import { admissionExpiryMs, protectedAdmissionLocation } from "@/server/demo-admission";
import { authorizeMutation } from "@/lib/session/request-guard";
import type { Session } from "@/lib/session/service";
import {
  checkoutSelectionCurrent,
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
  const back = interfaceLanguage ? "/shop/needs?" : preferences ? `/shop?${preferencesQuery(preferences)}&` : "/shop?";
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
    return seeOther(`/shop/needs?lang=${interfaceLanguage ?? needsDraft.language}&error=STALE_DRAFT`);
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

function needsBack(language: JourneyLanguage, code?: string, failure?: string | null): string {
  const query = new URLSearchParams({ lang: language });
  if (code) query.set("error", code);
  const notice = failureNoticeCode(failure);
  if (notice) query.set("notice", notice);
  return `/shop/needs?${query.toString()}`;
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

function rememberNeedsTurn(store: object, sessionId: string, draft: NeedsDraft, shopperText: string): void {
  recordConversationTurn(store, sessionId, {
    draftId: draft.draftId,
    interfaceLanguage: draft.language,
    shopperText,
    assistantNotice: draft.notice,
  });
}

function controlChange<T extends string>(posted: T | null, current: string | null): T | null {
  if (posted === null || posted === current) return null;
  return posted;
}

export type FollowUpOutcome =
  | { readonly kind: "duplicate" }
  | { readonly kind: "session_dead" }
  | { readonly kind: "refused"; readonly code: "STALE_DRAFT" | "DRAFT_EXPIRED" | "CLARIFICATION_INVALID" | "DRAFT_NOT_FOUND" }
  | { readonly kind: "done"; readonly failure: "malformed" | "unavailable" | null };

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
    readonly expiresAtMs: number;
    readonly live: () => boolean;
  },
): Promise<FollowUpOutcome> {
  const message = ShopperMessageSchema.safeParse(input.text);
  if (!message.success) return { kind: "refused", code: "CLARIFICATION_INVALID" };
  // The claim is durable before the interpreter starts.
  const claimed = await runtime.durable.change((host) =>
    claimFollowUp(host, sessionId, { draftId: input.draftId, version: input.version, shopperText: message.data, expiresAtMs: input.expiresAtMs, now: runtime.clock().getTime() }, input.live),
  );
  if (claimed.kind === "duplicate") return { kind: "duplicate" };
  if (claimed.kind === "session_dead") return { kind: "session_dead" };
  if (claimed.kind === "stale") return { kind: "refused", code: "STALE_DRAFT" };
  if (claimed.kind === "expired") return { kind: "refused", code: "DRAFT_EXPIRED" };
  if (claimed.kind === "invalid") return { kind: "refused", code: "CLARIFICATION_INVALID" };
  if (claimed.kind !== "claimed") return { kind: "refused", code: "DRAFT_NOT_FOUND" };

  // Provider input comes from the saved claim, not from the request.
  const claimedText = claimed.draft.shopperText;
  const interpreted = await interpretNeedsSafely(runtime.ai, claimedText, (diagnostic) => {
    const line = formatAdvisoryFailureDiagnostic(diagnostic);
    if (line) console.warn(line);
  });
  if (!input.live()) return { kind: "refused", code: "DRAFT_EXPIRED" };
  const model = interpreted.ok ? interpreted.value : interpreted.error === "OUTPUT_INVALID" ? "malformed" : "unavailable";
  const typedUse = controlChange(input.typedUse, claimed.draft.prefilledUse);
  const typedBudget = controlChange(input.typedBudget, claimed.draft.prefilledBudgetDollars);
  const settled = mergeInterpretedNeeds(typedUse, typedBudget, settleShopperText(claimedText, model));
  const merged = mergeFollowUpCandidate(claimed.draft, settled);
  const confirmedUse = claimed.draft.confirmedUse;
  const confirmedBudget = claimed.draft.confirmedBudgetDollars;
  const withdrawConfirmation = Boolean(
    confirmedUse &&
      confirmedBudget &&
      merged.notice === "review" &&
      merged.prefilledUse &&
      merged.prefilledBudgetDollars &&
      (merged.prefilledUse !== confirmedUse || merged.prefilledBudgetDollars !== confirmedBudget),
  );
  // One durable decision: the follow-up result, any confirmation withdrawal, and the conversation line.
  await runtime.durable.change((host) => {
    const written = commitFollowUp(host, sessionId, claimed.draft.draftId, claimed.draft.version, { ...merged, withdrawConfirmation }, runtime.clock().getTime());
    if (written && withdrawConfirmation) invalidatePurchaseSelections(host, sessionId);
    if (written) rememberNeedsTurn(host, sessionId, written, claimedText);
  });
  return { kind: "done", failure: model === "malformed" || model === "unavailable" ? model : null };
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
      expiresAtMs,
      live,
    });
    if (outcome.kind === "duplicate" || outcome.kind === "session_dead") return seeOther(needsBack(language));
    if (outcome.kind === "refused") return seeOther(needsBack(language, outcome.code));
    return seeOther(needsBack(language, undefined, outcome.failure));
  }

  const text = form.get("shopperText") ?? "";
  if (text.trim().length > 2000) return seeOther(needsBack(language, "TEXT_TOO_LONG"));
  const typedUse = needsUse(form.get("use"));
  const typedBudget = needsBudget(form.get("budget"));
  const submittedVersion = needsVersion(form);
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

  const message = ShopperMessageSchema.safeParse(text);
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
  const claimed = await runtime.durable.change((host) =>
    beginInterpretation(host, session.id, {
      submittedVersion,
      language,
      shopperText: message.data,
      expiresAtMs,
      now,
    }),
  );
  if (claimed.kind === "duplicate") return seeOther(needsBack(language));
  if (claimed.kind === "stale") return seeOther(needsBack(language, "STALE_DRAFT"));
  if (claimed.kind === "expired") return seeOther(needsBack(language, "DRAFT_EXPIRED"));
  if (claimed.kind !== "claimed") return seeOther(needsBack(language, "DRAFT_NOT_FOUND"));

  // Provider input comes from the saved claim, not from the request.
  const claimedText = claimed.draft.shopperText;
  const interpreted = await interpretNeedsSafely(runtime.ai, claimedText, (diagnostic) => {
    const line = formatAdvisoryFailureDiagnostic(diagnostic);
    if (line) console.warn(line);
  });
  if (!runtime.checkout.sessionIsLive(session.id)) return seeOther(needsBack(language, "DRAFT_EXPIRED"));
  const model = interpreted.ok ? interpreted.value : interpreted.error === "OUTPUT_INVALID" ? "malformed" : "unavailable";
  const settled = mergeInterpretedNeeds(typedUse, typedBudget, settleShopperText(claimedText, model));
  // One durable decision: the interpretation result (rechecked against the claim) and the conversation line.
  await runtime.durable.change((host) => {
    const wrote = applyInterpretation(host, session.id, claimed.draft.draftId, claimed.draft.version, settled, runtime.clock().getTime());
    const drafted = needsDraftsFor(host).get(session.id);
    if (wrote && drafted) rememberNeedsTurn(host, session.id, drafted, claimedText);
  });
  const failure = model === "malformed" || model === "unavailable" ? model : null;
  return seeOther(needsBack(language, undefined, failure));
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
 * POST /shop/needs/listings. The shopper asks for external listings.
 * Live Channel3 is not installed, so this route never calls a transport.
 * A present discovery switch and API key do not change that.
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
  if (!search || runtime.channel3.mode !== "disabled") return seeOther(listingsBack(language, "unavailable"));
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
  return `/shop/needs?${new URLSearchParams({ lang: language, listings }).toString()}`;
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

  const error = await runSimulationStep(runtime, session, intent.id, step);
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

/** GET /checkout/:intentId/paypal-cancel. Renders a same-origin cancel form and does not cancel. */
export async function handleSandboxPaypalCancel(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  if (runtime.paymentMode !== "sandbox") return refuse("NOT_FOUND", runtime);
  await runtime.maintain();
  const resolved = await runtime.sessions.resolve(readSessionCookie(request.headers.get("cookie")));
  if (!resolved.ok) return seeOther("/");
  const intent = await ownedIntent(runtime, resolved.value, intentId);
  if (!intent) return refuse("NOT_FOUND", runtime);
  const action = `/checkout/${intent.id}/cancel`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cancel checkout</title></head><body><main><h1>Cancel this checkout</h1><p>No payment has been captured.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="csrfToken" value="${escapeHtml(resolved.value.csrfToken)}"><button type="submit">Cancel this checkout</button></form></main></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** POST /checkout/:intentId/capture. Success is only CAPTURED_VERIFIED. */
export async function handleSandboxCapture(request: Request, runtime: Runtime, intentId: string): Promise<Response> {
  const refused = admissionRefusal(request, runtime);
  if (refused) return refused;
  const ready = await requireSandbox(request, runtime, intentId);
  if (!ready.ok) return ready.response;
  if (ready.intent.snapshot.state !== "APPROVED_VERIFIED") return seeOther(checkoutBack(ready.intent.id, "APPROVAL_NOT_CONFIRMED"));
  await dispatchCapture(runtime.payment, ready.intent.id);
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
 * origin, Fetch Metadata and CSRF checks. An approval is bounded by the admission expiry when admission is on.
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
  if (!/^[0-9a-f]{64}$/.test(pairingId) || (decision !== "approve" && decision !== "deny")) return seeOther(`/extension/pair?lang=${language}&result=failed`);
  const nowMs = runtime.clock().getTime();
  const decided = runtime.pairing.approve(
    { pairingId, sessionId: session.id, deny: decision === "deny", boundMs: admissionExpiryMs(runtime.admission, request.headers.get("cookie"), nowMs) },
    nowMs,
  );
  const result = decided.ok ? decided.value.status : "failed";
  return seeOther(`/extension/pair?lang=${language}&result=${result}`);
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
  return seeOther(`/shop/needs?lang=${language}&revoked=${grantId.slice(4, 12)}`);
}

