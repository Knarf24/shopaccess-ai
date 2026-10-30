import { classifyAiWorkload, mentionsLocalWork, mentionsTrainingWork } from "./ai-workload";
import type { WorkloadRecord } from "./workload-record";
import { resolveWorkloadFollowUp } from "./workload-follow-up";

/**
 * Derives advisory workload evidence from one accepted shopper turn.
 *
 * This function is pure. Callers must persist its result in the same
 * durable transaction as the accepted draft/conversation update.
 *
 * It does not establish hardware compatibility or purchase authority.
 */
export function updateWorkloadFromShopperTurn(
  previous: WorkloadRecord | null,
  shopperText: string,
  sessionId: string,
  draftId: string,
  draftVersion: number,
): WorkloadRecord | null {
  if (
    !sessionId ||
    !draftId ||
    !Number.isSafeInteger(draftVersion) ||
    draftVersion < 1 ||
    draftVersion > 999999999
  ) {
    return null;
  }

  const matchingPrevious =
    previous?.sessionId === sessionId &&
    previous.draftId === draftId &&
    Number.isSafeInteger(previous.sourceDraftVersion) &&
    previous.sourceDraftVersion >= 1 &&
    previous.sourceDraftVersion <= draftVersion
      ? previous
      : null;

  const text = shopperText.trim();
  if (!text) return matchingPrevious;

  const explicit = classifyAiWorkload(text);
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const mentionsTraining = mentionsTrainingWork(normalized);

  const mentionsLocal = mentionsLocalWork(normalized);

  const nextFromText = resolveWorkloadFollowUp(matchingPrevious?.kind ?? null, text);

  if (nextFromText === null) return matchingPrevious;

  const pendingTraining =
    matchingPrevious?.kind === "unspecified_ai" &&
    matchingPrevious.evidenceState === "inferred";

  const next =
    pendingTraining && mentionsLocal && nextFromText === "local_inference"
      ? "local_training"
      : nextFromText;

  const evidenceState =
    next === "unspecified_ai" && mentionsTraining
      ? "inferred"
      : explicit !== null && explicit !== "unspecified_ai"
        ? "explicit"
        : next === "unspecified_ai"
          ? "unresolved"
          : "inferred";

  // An unchanged kind keeps its evidence, so a pending training mention survives later turns; an AI-specific
  // statement of the same kind still upgrades it to explicit.
  const unchanged = matchingPrevious !== null && next === matchingPrevious.kind;
  const explicitAi = explicit !== null && explicit !== "general_programming" && explicit !== "unspecified_ai";
  const keptEvidence: WorkloadRecord["evidenceState"] | null =
    unchanged && !explicitAi
      ? next === "unspecified_ai" && mentionsTraining
        ? "inferred"
        : matchingPrevious.evidenceState
      : null;

  return {
    sessionId,
    draftId,
    kind: next,
    sourceDraftVersion: draftVersion,
    evidenceState: keptEvidence ?? evidenceState,
  };
}
