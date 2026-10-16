import type { NeedsNotice } from "../i18n/needs-notice";
import type { JourneyLanguage } from "../i18n/language";
import type { IntendedUse } from "../readiness/engine";
import { randomHex } from "../shared/crypto";

export interface SessionRecord {
  readonly id: string;
  readonly tokenDigest: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface SessionStore {
  /**
   * Inserts the session only if fewer than `maxSessions` are currently stored.
   * The capacity check and the insert are ONE atomic step: no other operation
   * can run between them, so concurrent callers can never exceed the limit.
   * Returns false, storing nothing, when the store is full.
   */
  insertWithinCapacity(record: SessionRecord, maxSessions: number): Promise<boolean>;
  findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null>;
  touch(id: string, lastSeenAt: Date): Promise<void>;
  /** Compare-and-set rotation: succeeds only if the stored digest is still `expectedDigest`. */
  replaceTokenDigest(id: string, expectedDigest: string, newDigest: string, at: Date): Promise<boolean>;
  revoke(id: string, at: Date): Promise<void>;
  /** Removes sessions that are revoked, past their absolute expiry, or idle since before `idleCutoff`. Returns their IDs. */
  deleteExpired(now: Date, idleCutoff: Date): Promise<string[]>;
  /** Number of stored sessions (after cleanup this is the number of live sessions). */
  count(): Promise<number>;
}

/** Single-process store for tests and the mock milestone. Not a production session store. */
export class InMemorySessionStore implements SessionStore {
  private readonly byId = new Map<string, SessionRecord>();
  private readonly idByDigest = new Map<string, string>();

  // Deliberately contains no `await`: in a single JavaScript process the check and
  // the two writes below run to completion before any other task can observe the store.
  async insertWithinCapacity(record: SessionRecord, maxSessions: number): Promise<boolean> {
    if (this.byId.size >= maxSessions) return false;
    if (this.byId.has(record.id)) throw new Error("Duplicate session id");
    if (this.idByDigest.has(record.tokenDigest)) throw new Error("Duplicate session token digest");
    this.byId.set(record.id, record);
    this.idByDigest.set(record.tokenDigest, record.id);
    return true;
  }

  async findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null> {
    const id = this.idByDigest.get(tokenDigest);
    return (id && this.byId.get(id)) || null;
  }

  async touch(id: string, lastSeenAt: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record) this.byId.set(id, { ...record, lastSeenAt });
  }

  async replaceTokenDigest(id: string, expectedDigest: string, newDigest: string, at: Date): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record || record.tokenDigest !== expectedDigest || record.revokedAt) return false;
    this.byId.set(id, { ...record, tokenDigest: newDigest, lastSeenAt: at });
    this.idByDigest.delete(expectedDigest);
    this.idByDigest.set(newDigest, id);
    return true;
  }

  async revoke(id: string, at: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record && !record.revokedAt) this.byId.set(id, { ...record, revokedAt: at });
  }

  async deleteExpired(now: Date, idleCutoff: Date): Promise<string[]> {
    const removed: string[] = [];
    for (const record of this.byId.values()) {
      const expired =
        record.revokedAt !== null ||
        record.absoluteExpiresAt.getTime() <= now.getTime() ||
        record.lastSeenAt.getTime() <= idleCutoff.getTime();
      if (!expired) continue;
      this.byId.delete(record.id);
      this.idByDigest.delete(record.tokenDigest);
      removed.push(record.id);
    }
    return removed;
  }

  async count(): Promise<number> {
    return this.byId.size;
  }

  /** When a stored, unrevoked session stops being live (idle or absolute, whichever is first), or null. */
  liveUntil(sessionId: string, idleTimeoutMs: number): number | null {
    const record = this.byId.get(sessionId);
    if (!record || record.revokedAt !== null) return null;
    return Math.min(record.lastSeenAt.getTime() + idleTimeoutMs, record.absoluteExpiresAt.getTime());
  }

  /** Absolute expiry of a stored, unrevoked session, or null. Synchronous, for bounding extension grants. */
  absoluteExpiryOf(sessionId: string): Date | null {
    const record = this.byId.get(sessionId);
    return record && record.revokedAt === null ? record.absoluteExpiresAt : null;
  }

  /**
   * SYNCHRONOUS liveness decision for the single-process mock: true only if the
   * session is stored right now, is not revoked, and is inside both its idle
   * and absolute lifetimes. A session that has been reclaimed is simply absent.
   *
   * Because it is synchronous, a caller can decide liveness and write its own
   * records in the same uninterrupted step, so reclamation cannot happen in
   * between. This is what the checkout commit relies on.
   */
  isLive(sessionId: string, now: Date, idleTimeoutMs: number): boolean {
    const record = this.byId.get(sessionId);
    if (!record || record.revokedAt !== null) return false;
    const at = now.getTime();
    return at < record.absoluteExpiresAt.getTime() && at < record.lastSeenAt.getTime() + idleTimeoutMs;
  }
}

export const MAX_NEEDS_TEXT_CHARS = 2000;

export type { JourneyLanguage, NeedsNotice };
export type RecommendationClaim = "pending" | "completed" | "failed";

export interface RetainedRecommendation {
  readonly assistantMessage: string | null;
  readonly recommendations: readonly {
    readonly productId: string;
    readonly variantId: string;
    readonly title: string;
    readonly label: string;
    readonly unitAmountCents: number;
    readonly currency: "USD";
  }[];
}

/**
 * One needs draft for one session, in this process only.
 *
 * The claim flags below are synchronous so two requests in the SAME process cannot both pass.
 * They do not protect two processes. Each process has its own memory. A missing draft in this
 * process is not rebuilt, and it is never treated as confirmed. The shared two-slot directory
 * only limits how many provider calls run; it does not remember which draft they belonged to.
 */
export interface NeedsDraft {
  readonly draftId: string;
  readonly version: number;
  readonly language: JourneyLanguage;
  readonly shopperText: string;
  readonly prefilledUse: IntendedUse | null;
  readonly prefilledBudgetDollars: string | null;
  readonly confirmedUse: IntendedUse | null;
  readonly confirmedBudgetDollars: string | null;
  readonly interpretationClaimVersion: number | null;
  /**
   * True from an interpretation or follow-up claim until its result is written. Kept separately from the claim
   * version, which stays as duplicate protection after completion, and from the notice, which confirmation clears.
   * Snapshot recovery releases only a draft that is still pending.
   */
  readonly interpretationPending: boolean;
  readonly recommendationClaim: RecommendationClaim | null;
  readonly recommendation: RetainedRecommendation | null;
  readonly notice: NeedsNotice | null;
  readonly expiresAtMs: number;
}

export type DraftRefusal = "missing" | "stale" | "expired" | "duplicate" | "conflict" | "unconfirmed";
export type ClarificationRefusal = "missing" | "stale" | "expired" | "invalid" | "session_dead";

/**
 * Identifies the draft map attached to one store object.
 * The symbol is shared by module instances in this process. The map is not:
 * it lives on that store, so another runtime's store cannot see it.
 */
const NEEDS_DRAFTS = Symbol.for("shopaccess.needsDrafts");

type DraftHost = object & { [NEEDS_DRAFTS]?: Map<string, NeedsDraft> };

function attachedDrafts(store: object): Map<string, NeedsDraft> | undefined {
  return (store as DraftHost)[NEEDS_DRAFTS];
}

/** Drafts for one mock store. Creating the empty map does not create a confirmed draft. */
export function needsDraftsFor(store: object): Map<string, NeedsDraft> {
  const host = store as DraftHost;
  let found = host[NEEDS_DRAFTS];
  if (!found) {
    found = new Map();
    host[NEEDS_DRAFTS] = found;
  }
  return found;
}

/**
 * Replaces the whole draft map for one host. Used by the snapshot runtime to publish a durable state and to seed a
 * scratch host for a queued decision. The map object stays the same, so existing readers keep their reference.
 */
export function replaceNeedsDrafts(store: object, drafts: Iterable<readonly [string, NeedsDraft]>): void {
  const found = needsDraftsFor(store);
  found.clear();
  for (const [sessionId, draft] of drafts) found.set(sessionId, draft);
}

export function deleteNeedsDrafts(store: object, sessionIds: readonly string[]): void {
  const found = attachedDrafts(store);
  if (!found) return;
  for (const sessionId of sessionIds) found.delete(sessionId);
}

function boundText(text: string): string {
  return text.trim().slice(0, MAX_NEEDS_TEXT_CHARS);
}

function freshDraft(input: {
  previous: NeedsDraft | null;
  language: JourneyLanguage;
  shopperText: string;
  expiresAtMs: number;
  prefilledUse: IntendedUse | null;
  prefilledBudgetDollars: string | null;
  notice: NeedsNotice | null;
  interpretationClaimVersion: number | null;
}): NeedsDraft {
  return {
    draftId: input.previous?.draftId ?? `nd_${randomHex(16)}`,
    version: (input.previous?.version ?? 0) + 1,
    language: input.language,
    shopperText: boundText(input.shopperText),
    prefilledUse: input.prefilledUse,
    prefilledBudgetDollars: input.prefilledBudgetDollars,
    confirmedUse: null,
    confirmedBudgetDollars: null,
    interpretationClaimVersion: input.interpretationClaimVersion,
    interpretationPending: input.interpretationClaimVersion !== null,
    recommendationClaim: null,
    recommendation: null,
    notice: input.notice,
    expiresAtMs: input.expiresAtMs,
  };
}

function current(store: object, sessionId: string, now: number): NeedsDraft | "expired" | "missing" {
  const draft = needsDraftsFor(store).get(sessionId) ?? null;
  if (!draft) return "missing";
  if (now >= draft.expiresAtMs) {
    needsDraftsFor(store).delete(sessionId);
    return "expired";
  }
  return draft;
}

/** Saves the shopper's own controls. Does not call a provider and does not confirm them. */
export function saveStructuredNeeds(
  store: object,
  sessionId: string,
  input: {
    readonly submittedVersion: number | null;
    readonly language: JourneyLanguage;
    readonly shopperText: string;
    readonly use: IntendedUse | null;
    readonly budgetDollars: string | null;
    readonly notice: NeedsNotice;
    readonly expiresAtMs: number;
    readonly now: number;
  },
): NeedsDraft | DraftRefusal {
  const existing = current(store, sessionId, input.now);
  if (existing === "expired") return "expired";
  if (existing !== "missing" && input.submittedVersion !== null && input.submittedVersion !== existing.version) return "stale";
  if (existing !== "missing" && input.submittedVersion === null) return "stale";
  const draft = freshDraft({
    previous: existing === "missing" ? null : existing,
    language: input.language,
    shopperText: input.shopperText,
    expiresAtMs: input.expiresAtMs,
    prefilledUse: input.use,
    prefilledBudgetDollars: input.budgetDollars,
    notice: input.notice,
    interpretationClaimVersion: null,
  });
  needsDraftsFor(store).set(sessionId, draft);
  return draft;
}

/**
 * Claims one interpretation for this version inside this process, or replaces the draft with a new version.
 * A second caller that still names the claimed version does not receive another claim.
 */
export function beginInterpretation(
  store: object,
  sessionId: string,
  input: {
    readonly submittedVersion: number | null;
    readonly language: JourneyLanguage;
    readonly shopperText: string;
    readonly expiresAtMs: number;
    readonly now: number;
  },
): { readonly kind: "claimed"; readonly draft: NeedsDraft } | { readonly kind: DraftRefusal } {
  const existing = current(store, sessionId, input.now);
  if (existing === "expired") return { kind: "expired" };
  if (existing !== "missing" && input.submittedVersion !== null && input.submittedVersion !== existing.version) return { kind: "stale" };
  if (existing !== "missing" && input.submittedVersion === null) return { kind: "stale" };
  const text = boundText(input.shopperText);
  if (
    existing !== "missing" &&
    input.submittedVersion === existing.version &&
    existing.interpretationClaimVersion === existing.version &&
    existing.shopperText === text
  ) {
    return { kind: "duplicate" };
  }
  const draft = freshDraft({
    previous: existing === "missing" ? null : existing,
    language: input.language,
    shopperText: text,
    expiresAtMs: input.expiresAtMs,
    prefilledUse: null,
    prefilledBudgetDollars: null,
    notice: null,
    interpretationClaimVersion: (existing === "missing" ? 0 : existing.version) + 1,
  });
  needsDraftsFor(store).set(sessionId, draft);
  return { kind: "claimed", draft };
}

/** Writes an interpretation only onto the version that was claimed. A newer draft is left as it is. */
export function applyInterpretation(
  store: object,
  sessionId: string,
  draftId: string,
  version: number,
  patch: Pick<NeedsDraft, "prefilledUse" | "prefilledBudgetDollars" | "notice">,
  now: number,
): boolean {
  const existing = current(store, sessionId, now);
  if (existing === "expired" || existing === "missing") return false;
  if (existing.draftId !== draftId || existing.version !== version || existing.interpretationClaimVersion !== version) return false;
  needsDraftsFor(store).set(sessionId, { ...existing, ...patch, interpretationPending: false });
  return true;
}

/**
 * Clarification write for a live, session-owned draft. Retains shopperText and language.
 * Increments the version and clears confirmation and recommendation. Invalid or omitted
 * structured values leave the draft unchanged. Session liveness, ownership, expiry, and
 * version are checked in this synchronous step. Single-process only.
 */
export function mergeClarification(
  store: object,
  sessionId: string,
  input: {
    readonly draftId: string;
    readonly version: number;
    readonly use: IntendedUse | null;
    readonly budgetDollars: string | null;
    readonly expiresAtMs: number;
    readonly now: number;
  },
  sessionIsLive: () => boolean,
): NeedsDraft | ClarificationRefusal {
  if (!sessionIsLive()) return "session_dead";
  const existing = current(store, sessionId, input.now);
  if (existing === "expired") return "expired";
  if (existing === "missing") return "missing";
  if (existing.draftId !== input.draftId) return "missing";
  if (existing.version !== input.version) return "stale";
  if (input.use === null || input.budgetDollars === null) return "invalid";
  const draft = freshDraft({
    previous: existing,
    language: existing.language,
    shopperText: existing.shopperText,
    expiresAtMs: input.expiresAtMs,
    prefilledUse: input.use,
    prefilledBudgetDollars: input.budgetDollars,
    notice: "review",
    interpretationClaimVersion: null,
  });
  needsDraftsFor(store).set(sessionId, draft);
  return draft;
}

/**
 * Claims one follow-up interpretation without clearing a confirmation.
 * The previous supported fields stay until `commitFollowUp` writes the merge.
 */
export function claimFollowUp(
  store: object,
  sessionId: string,
  input: {
    readonly draftId: string;
    readonly version: number;
    readonly shopperText: string;
    readonly expiresAtMs: number;
    readonly now: number;
  },
  sessionIsLive: () => boolean,
): { readonly kind: "claimed"; readonly draft: NeedsDraft } | { readonly kind: "duplicate" | ClarificationRefusal } {
  if (!sessionIsLive()) return { kind: "session_dead" };
  const existing = current(store, sessionId, input.now);
  if (existing === "expired") return { kind: "expired" };
  if (existing === "missing") return { kind: "missing" };
  if (existing.draftId !== input.draftId) return { kind: "missing" };
  if (existing.version !== input.version) return { kind: "stale" };
  const text = boundText(input.shopperText);
  if (text.length === 0) return { kind: "invalid" };
  if (existing.shopperText === text && existing.interpretationClaimVersion === existing.version) return { kind: "duplicate" };
  const draft: NeedsDraft = {
    ...existing,
    version: existing.version + 1,
    shopperText: text,
    interpretationClaimVersion: existing.version + 1,
    interpretationPending: true,
    expiresAtMs: input.expiresAtMs,
  };
  needsDraftsFor(store).set(sessionId, draft);
  return { kind: "claimed", draft };
}

/** Writes a follow-up merge onto the claimed version. Withdraws confirmation only when asked. */
export function commitFollowUp(
  store: object,
  sessionId: string,
  draftId: string,
  version: number,
  patch: {
    readonly prefilledUse: IntendedUse | null;
    readonly prefilledBudgetDollars: string | null;
    readonly notice: NeedsNotice | null;
    readonly withdrawConfirmation: boolean;
  },
  now: number,
): NeedsDraft | null {
  const existing = current(store, sessionId, now);
  if (existing === "expired" || existing === "missing") return null;
  if (existing.draftId !== draftId || existing.version !== version || existing.interpretationClaimVersion !== version) return null;
  const draft: NeedsDraft = {
    ...existing,
    prefilledUse: patch.prefilledUse,
    prefilledBudgetDollars: patch.prefilledBudgetDollars,
    notice: patch.notice,
    confirmedUse: patch.withdrawConfirmation ? null : existing.confirmedUse,
    confirmedBudgetDollars: patch.withdrawConfirmation ? null : existing.confirmedBudgetDollars,
    recommendation: patch.withdrawConfirmation ? null : existing.recommendation,
    recommendationClaim: patch.withdrawConfirmation ? null : existing.recommendationClaim,
    interpretationPending: false,
  };
  needsDraftsFor(store).set(sessionId, draft);
  return draft;
}

/**
 * Structured correction. An unconfirmed draft uses the existing clarification write.
 * A confirmed draft is left unchanged when the posted pair matches it. A different pair
 * becomes an unconfirmed summary; the confirmed fields are not replaced in place.
 */
export function proposeStructuredRevision(
  store: object,
  sessionId: string,
  input: {
    readonly draftId: string;
    readonly version: number;
    readonly use: IntendedUse | null;
    readonly budgetDollars: string | null;
    readonly expiresAtMs: number;
    readonly now: number;
  },
  sessionIsLive: () => boolean,
):
  | { readonly kind: "revised"; readonly draft: NeedsDraft; readonly withdrewConfirmation: boolean }
  | { readonly kind: "unchanged" }
  | { readonly kind: "missing" }
  | { readonly kind: "stale" }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid" }
  | { readonly kind: "session_dead" } {
  if (!sessionIsLive()) return { kind: "session_dead" };
  const existing = current(store, sessionId, input.now);
  if (existing === "expired") return { kind: "expired" };
  if (existing === "missing") return { kind: "missing" };
  if (existing.draftId !== input.draftId) return { kind: "missing" };
  if (existing.version !== input.version) return { kind: "stale" };
  if (input.use === null || input.budgetDollars === null) return { kind: "invalid" };
  if (existing.confirmedUse !== null || existing.confirmedBudgetDollars !== null) {
    if (existing.confirmedUse === input.use && existing.confirmedBudgetDollars === input.budgetDollars) return { kind: "unchanged" };
    const draft = freshDraft({
      previous: existing,
      language: existing.language,
      shopperText: existing.shopperText,
      expiresAtMs: input.expiresAtMs,
      prefilledUse: input.use,
      prefilledBudgetDollars: input.budgetDollars,
      notice: "review",
      interpretationClaimVersion: null,
    });
    needsDraftsFor(store).set(sessionId, draft);
    return { kind: "revised", draft, withdrewConfirmation: true };
  }
  const merged = mergeClarification(store, sessionId, input, sessionIsLive);
  if (merged === "session_dead") return { kind: "session_dead" };
  if (merged === "stale") return { kind: "stale" };
  if (merged === "expired") return { kind: "expired" };
  if (merged === "missing") return { kind: "missing" };
  if (merged === "invalid") return { kind: "invalid" };
  return { kind: "revised", draft: merged, withdrewConfirmation: false };
}

/** Stores a confirmed use and budget. The interpretation notice is cleared only on that write. */
export function confirmNeeds(
  store: object,
  sessionId: string,
  input: {
    readonly draftId: string;
    readonly version: number;
    readonly use: IntendedUse;
    readonly budgetDollars: string;
    readonly now: number;
  },
): NeedsDraft | DraftRefusal {
  const existing = current(store, sessionId, input.now);
  if (existing === "expired" || existing === "missing") return existing === "expired" ? "expired" : "missing";
  if (existing.draftId !== input.draftId || existing.version !== input.version) return "stale";
  if (existing.confirmedUse !== null || existing.confirmedBudgetDollars !== null) {
    if (existing.confirmedUse === input.use && existing.confirmedBudgetDollars === input.budgetDollars) return existing;
    return "conflict";
  }
  const draft: NeedsDraft = { ...existing, confirmedUse: input.use, confirmedBudgetDollars: input.budgetDollars, notice: null };
  needsDraftsFor(store).set(sessionId, draft);
  return draft;
}

export function claimRecommendation(store: object, sessionId: string, draftId: string, version: number, now: number): "claimed" | DraftRefusal {
  const existing = current(store, sessionId, now);
  if (existing === "expired" || existing === "missing") return existing === "expired" ? "expired" : "missing";
  if (existing.draftId !== draftId || existing.version !== version) return "stale";
  if (existing.confirmedUse === null || existing.confirmedBudgetDollars === null) return "unconfirmed";
  if (existing.recommendationClaim !== null) return "duplicate";
  needsDraftsFor(store).set(sessionId, { ...existing, recommendationClaim: "pending" });
  return "claimed";
}

export function finishRecommendation(
  store: object,
  sessionId: string,
  draftId: string,
  version: number,
  outcome: "completed" | "failed",
  recommendation: RetainedRecommendation | null,
  now: number,
): boolean {
  const existing = current(store, sessionId, now);
  if (existing === "expired" || existing === "missing") return false;
  if (existing.draftId !== draftId || existing.version !== version || existing.recommendationClaim !== "pending") return false;
  needsDraftsFor(store).set(sessionId, {
    ...existing,
    recommendationClaim: outcome,
    recommendation: outcome === "completed" ? recommendation : null,
  });
  return true;
}
