import { MAX_CONVERSATION_TURNS } from "./conversation";
import { SESSION_IDLE_TIMEOUT_MS } from "./service";

/** The parts of a snapshot body the converter reads. Any full body satisfies it and is returned with all its keys. */
type Body = {
  readonly sessions: readonly { readonly id: string; readonly lastSeenAt: string; readonly absoluteExpiresAt: string; readonly revokedAt: string | null }[];
  readonly drafts: readonly { readonly sessionId: string; readonly draftId: string; readonly expiresAtMs: number }[];
  readonly conversations: readonly { readonly sessionId: string; readonly draftId: string; readonly turns: readonly unknown[] }[];
  readonly workloads?: unknown;
  readonly legacyDrafts?: unknown;
};

/**
 * The format-10 body for a format-7 (or older, already upgraded) body: every existing key unchanged, plus an empty
 * `workloads` collection and the `legacyDrafts` markers. No workload is synthesized for any draft.
 *
 * Contract: the input is an eligible legacy body, that is, one without a `workloads` collection (formats 1 to 7 carry
 * none), and one that is not already converted; any other input is rejected. A marker is written only for a draft that
 * survives at `now` (live session, unexpired draft) and whose retained conversation is full (eight turns, so earlier
 * turns may already have been lost). Nothing is inferred about the workload itself.
 *
 * Pure: it validates nothing and writes nothing. The caller must validate the source (open it through the store) before
 * converting, and must seal and write the result through the store's own validated path.
 */
export function convertBodyToWorkloadBody<T extends Body>(body: T, now: Date): T & { readonly workloads: readonly []; readonly legacyDrafts: readonly { readonly sessionId: string; readonly draftId: string }[] } {
  if (body.workloads !== undefined || body.legacyDrafts !== undefined) throw new Error("not-a-conversion-input");
  // The same survival rule as restoreState (kept equal by a test): a live session and an unexpired draft.
  const at = now.getTime();
  const liveSessions = new Set(
    body.sessions
      .filter((session) => session.revokedAt === null && at < Date.parse(session.absoluteExpiresAt) && at < Date.parse(session.lastSeenAt) + SESSION_IDLE_TIMEOUT_MS)
      .map((session) => session.id),
  );
  const legacyDrafts = body.drafts
    .filter((draft) => liveSessions.has(draft.sessionId) && at < draft.expiresAtMs)
    .filter(({ sessionId, draftId }) => body.conversations.some((conversation) => conversation.sessionId === sessionId && conversation.draftId === draftId && conversation.turns.length >= MAX_CONVERSATION_TURNS))
    .map(({ sessionId, draftId }) => ({ sessionId, draftId }));
  return { ...body, workloads: [], legacyDrafts };
}
