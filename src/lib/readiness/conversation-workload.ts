import type { ConversationState } from "@/lib/session/conversation";
import { classifyAiWorkload, hasPotentialAiHint, mentionsLocalWork, mentionsTrainingWork, type AiWorkloadKind } from "./ai-workload";
import type { WorkloadRecord } from "./workload-record";
import { resolveWorkloadFollowUp } from "./workload-follow-up";

interface RecoveredWorkload {
  readonly kind: AiWorkloadKind;
  /** True when any retained shopper text states a workload; false means the conversation says nothing about one. */
  readonly hasWorkloadEvidence: boolean;
  /** Training was stated and is not yet tied to a location, so a later local-only reply completes it. */
  readonly pendingTraining: boolean;
}

/**
 * Resolves advisory AI workload context from the retained shopper turns.
 * This is not a durable requirement record or a compatibility verdict.
 */
export function resolveConversationWorkload(
  conversation: ConversationState | null,
  fallbackShopperText = "",
): AiWorkloadKind {
  return recoverConversationWorkload(conversation, fallbackShopperText).kind;
}

function recoverConversationWorkload(
  conversation: ConversationState | null,
  fallbackShopperText: string,
): RecoveredWorkload {
  let workload: AiWorkloadKind | null = null;
  let sawShopperTurn = false;
  let pendingTraining = false;
  let hasWorkloadEvidence = false;

  for (const turn of conversation?.turns ?? []) {
    if (turn.role !== "shopper") continue;
    sawShopperTurn = true;
    if (classifyAiWorkload(turn.text) !== null) hasWorkloadEvidence = true;

    const normalized = turn.text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    const mentionsTraining = mentionsTrainingWork(normalized);
    const mentionsLocal = mentionsLocalWork(normalized);

    const next = resolveWorkloadFollowUp(workload, turn.text);

    if (next === "cloud_ai") {
      pendingTraining = false;
    } else if (mentionsTraining) {
      pendingTraining = true;
    }

    // A later local-only clarification completes a previously stated
    // training intent without claiming hardware compatibility.
    workload =
      pendingTraining && mentionsLocal && next === "local_inference"
        ? "local_training"
        : next;
  }

  if (!sawShopperTurn && fallbackShopperText.trim()) {
    workload = resolveWorkloadFollowUp(null, fallbackShopperText);
    hasWorkloadEvidence = classifyAiWorkload(fallbackShopperText) !== null;
  }

  return { kind: workload ?? "unspecified_ai", hasWorkloadEvidence, pendingTraining };
}

/** True when any retained shopper text (or the fallback text) has likely-AI wording the classifier does not name. */
export function hasPotentialAiWording(conversation: ConversationState | null, fallbackShopperText = ""): boolean {
  const texts = [...(conversation?.turns ?? []).filter((turn) => turn.role === "shopper").map((turn) => turn.text), fallbackShopperText];
  return texts.some((text) => text.trim() !== "" && hasPotentialAiHint(text));
}

/** True when the retained conversation states an AI workload (not plain programming and not a refusal of AI). */
export function hasAiWorkloadContext(conversation: ConversationState | null, fallbackShopperText = ""): boolean {
  const recovered = recoverConversationWorkload(conversation, fallbackShopperText);
  return recovered.hasWorkloadEvidence && recovered.kind !== "general_programming";
}

/**
 * Rebuilds the record a session without one would have had, from the retained conversation only. Returns null when the
 * conversation states no workload, so a later location-only reply cannot invent one. An unresolved request is
 * "inferred" (training pending) only when training was actually stated; otherwise it stays "unresolved".
 */
export function legacyWorkloadRecord(
  conversation: ConversationState | null,
  sessionId: string,
  draftId: string,
  draftVersion: number,
  fallbackShopperText = "",
): WorkloadRecord | null {
  const recovered = recoverConversationWorkload(conversation, fallbackShopperText);
  if (!recovered.hasWorkloadEvidence) return null;
  return {
    sessionId,
    draftId,
    kind: recovered.kind,
    sourceDraftVersion: draftVersion,
    evidenceState:
      recovered.kind === "unspecified_ai" && !recovered.pendingTraining ? "unresolved" : "inferred",
  };
}
