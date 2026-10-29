import { MAX_CONVERSATION_TURNS, type ConversationState } from "../session/conversation";
import { workloadRecordForDraft, workloadsUnrecovered } from "../session/workload-state";
import type { AiWorkloadKind } from "./ai-workload";
import { hasAiWorkloadContext, hasPotentialAiWording, resolveConversationWorkload } from "./conversation-workload";

/**
 * Resolves advisory workload context for a specific shopper draft.
 *
 * A matching durable record survives conversation truncation. Legacy
 * sessions without a record retain their existing conversation behavior.
 *
 * This is not a hardware compatibility verdict or purchase authorization.
 */
export function resolveDurableConversationWorkload(
  host: object,
  sessionId: string,
  draftId: string,
  draftVersion: number,
  conversation: ConversationState | null,
  fallbackShopperText = "",
): AiWorkloadKind {
  const saved = workloadRecordForDraft(
    host,
    sessionId,
    draftId,
    draftVersion,
  );

  if (saved) return saved.kind;

  const matchingConversation =
    conversation?.draftId === draftId ? conversation : null;

  return resolveConversationWorkload(
    matchingConversation,
    fallbackShopperText,
  );
}

/**
 * Whether AI-specific caveats apply to this draft: true (an AI workload is known), "potential" (AI is likely or cannot
 * be ruled out) or false (confirmed non-AI). Unknown fails closed to "potential". Unknown means likely-AI wording the
 * classifier does not name, or a draft restored from a snapshot format without workload records whose retained history
 * may be truncated. In-process non-AI sessions, which never write a record, stay false.
 */
export function durableAiContext(
  host: object,
  sessionId: string,
  draftId: string,
  draftVersion: number,
  conversation: ConversationState | null,
  fallbackShopperText = "",
): boolean | "potential" {
  const matching = conversation?.draftId === draftId ? conversation : null;
  const potential = hasPotentialAiWording(matching, fallbackShopperText);
  const saved = workloadRecordForDraft(host, sessionId, draftId, draftVersion);
  // After a restart the history may have been truncated and its AI record lost. A newer plain-programming record then
  // says nothing about the earlier, forgotten turns, so the uncertainty stays.
  const uncertainAfterRestart = workloadsUnrecovered(host, draftId) && (matching?.turns.length ?? 0) >= MAX_CONVERSATION_TURNS;
  if (saved) return saved.kind !== "general_programming" ? true : potential || uncertainAfterRestart ? "potential" : false;
  if (hasAiWorkloadContext(matching, fallbackShopperText)) return true;
  if (potential) return "potential";
  return uncertainAfterRestart ? "potential" : false;
}
