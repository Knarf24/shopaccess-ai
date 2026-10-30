import {
  classifyAiWorkload,
  cloudMentionCount,
  mentionsCloudWork,
  mentionsLocalWork,
  mentionsTrainingWork,
  normalizeWorkloadText,
  refusesAiWork,
  refusesLocalWork,
  type AiWorkloadKind,
} from "./ai-workload";

/**
 * Interprets a short follow-up using an established AI workload context.
 *
 * This is advisory classification only. It cannot establish hardware
 * compatibility, product suitability, or purchasing authority.
 */
// Permissive or tentative wording ("I don't mind the cloud", "maybe the cloud too") adds the cloud; it does not replace local use.
const CLOUD_TENTATIVE_CUE = /\b(mind|maybe|perhaps|also|too|either|could|might|open to|fine with|or|tambien|quizas|podria)\b/;
const CLOUD_SWITCH_CUE = /\b(instead|only|just|switch|rather|exclusively|nothing but|solo|solamente|mejor|en su lugar)\b/;

export function resolveWorkloadFollowUp(
  previous: AiWorkloadKind | null,
  reply: string,
): AiWorkloadKind | null {
  const explicit = classifyAiWorkload(reply);

  if (previous === null) return explicit;

  const words = normalizeWorkloadText(reply);

  const cloud = mentionsCloudWork(words);
  const local = mentionsLocalWork(words);
  const training = mentionsTrainingWork(words);
  const inference = /\b(run|running|test|testing|execute|ejecutar|ejecutando|inference|inferencia)\b/.test(words);

  // An explicit refusal ("actually, no AI") retracts an established AI workload; a refused location ("not locally")
  // keeps the workload but no longer places it on the laptop.
  if (previous !== "general_programming" && explicit === null && refusesAiWork(words)) return "general_programming";
  if ((previous === "local_training" || previous === "local_inference") && explicit === null && refusesLocalWork(words)) {
    // "cloud, not local" is cloud-only; "not locally" alone leaves the workload without a place.
    return cloud && !local ? "cloud_ai" : "unspecified_ai";
  }

  // A programming remark is not a retraction: only an explicit refusal (above) ends an established AI workload.
  if (previous !== "general_programming" && explicit === "general_programming" && !refusesAiWork(words)) return previous;

  // Explicit, complete AI requests take precedence, but mixed
  // local/cloud requirements remain unresolved.
  if (explicit !== null && explicit !== "unspecified_ai") {
    return explicit;
  }

  if (cloud && local) return "unspecified_ai";

  if (previous === "general_programming") {
    return explicit ?? previous;
  }

  // A tentative cloud mention after local intent is not a switch; a stated switch is.
  if (cloud) {
    const local_ = previous === "local_training" || previous === "local_inference";
    return local_ && CLOUD_TENTATIVE_CUE.test(words) && !CLOUD_SWITCH_CUE.test(words) && cloudMentionCount(words) < 2 ? "unspecified_ai" : "cloud_ai";
  }
  if (local && training) return "local_training";
  if (local && inference) return "local_inference";
  // Location alone does not change an established training workload.
  if (local && previous === "local_training") return previous;
  if (local) return "local_inference";

  if (previous === "local_inference" && training) {
    return "local_training";
  }

  if (previous === "local_training" && inference) {
    return "unspecified_ai";
  }

  return explicit ?? previous;
}
