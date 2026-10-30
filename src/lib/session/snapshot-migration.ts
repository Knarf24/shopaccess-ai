import { MAX_CONVERSATION_TURNS } from "./conversation";
import { restoreState } from "./snapshot-state";

type Body = Parameters<typeof restoreState>[0];

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
export function convertBodyToWorkloadBody(body: Body, now: Date): Body & { readonly workloads: readonly []; readonly legacyDrafts: readonly { readonly sessionId: string; readonly draftId: string }[] } {
  if (body.workloads !== undefined || body.legacyDrafts !== undefined) throw new Error("not-a-conversion-input");
  const { state } = restoreState(body, now);
  const legacyDrafts = body.drafts
    .filter(({ sessionId, draftId }) => {
      if (state.drafts.get(sessionId)?.draftId !== draftId) return false;
      const conversation = state.conversations.get(sessionId);
      return conversation?.draftId === draftId && conversation.turns.length >= MAX_CONVERSATION_TURNS;
    })
    .map(({ sessionId, draftId }) => ({ sessionId, draftId }));
  return { ...body, workloads: [], legacyDrafts };
}
