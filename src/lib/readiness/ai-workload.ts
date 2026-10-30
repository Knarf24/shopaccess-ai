/**
 * Advisory AI workload classification.
 *
 * This module does not assess product compatibility, authorize purchases,
 * or modify the existing readiness engine.
 */

export type AiWorkloadKind =
  | "general_programming"
  | "cloud_ai"
  | "local_inference"
  | "local_training"
  | "unspecified_ai";

export interface AiWorkloadAssessment {
  readonly kind: AiWorkloadKind;
  readonly requiresClarification: boolean;
  readonly missingEvidence: readonly string[];
  readonly compatibility: "not_assessed";
}

export function assessAiWorkload(
  kind: AiWorkloadKind,
): AiWorkloadAssessment {
  switch (kind) {
    case "general_programming":
      return {
        kind,
        requiresClarification: false,
        missingEvidence: [],
        compatibility: "not_assessed",
      };

    case "cloud_ai":
      return {
        kind,
        requiresClarification: true,
        missingEvidence: [
          "Cloud service and workload requirements",
          "Local development requirements",
        ],
        compatibility: "not_assessed",
      };

    case "local_inference":
      return {
        kind,
        requiresClarification: true,
        missingEvidence: [
          "AI model and inference requirements",
          "Verified laptop CPU and RAM",
          "Verified GPU and VRAM, where applicable",
        ],
        compatibility: "not_assessed",
      };

    case "local_training":
      return {
        kind,
        requiresClarification: true,
        missingEvidence: [
          "Training workload, model size, and dataset",
          "Framework and accelerator requirements",
          "Verified laptop CPU, RAM, GPU, and VRAM",
        ],
        compatibility: "not_assessed",
      };

    case "unspecified_ai":
      return {
        kind,
        requiresClarification: true,
        missingEvidence: [
          "Whether AI processing will run locally or in the cloud",
          "Specific AI workload and model requirements",
        ],
        compatibility: "not_assessed",
      };
  }
}

const AI_TERM =
  "(?:ai|llms?|ml|ia|machine learning|deep[- ]learning|neural (?:networks?|nets?)|inteligencia artificial|artificial intelligence|aprendizaje profundo|modelos? de ia|aprendizaje automatico|redes? neuronales?|(?:llamm?a|lamma)(?: ?\\d+(?:\\.\\d+)?)?|ollama|stable[- ]diffusion|gguf|ggml|comfyui|embeddings?|rag(?: pipelines?| systems?| apps?| applications?)|(?:mistral|gemma|qwen)(?: ?\\d+(?:\\.\\d+)?b?| locally| models?| llms?)|(?:(?:run|running|use|using|local|openai|faster|fast) whisper|whisper (?:locally|on (?:the |my )?(?:laptop|machine|computer|gpu)|large|medium|small|tiny|base|models?|v[1-3]|ai|transcription|cpp))|(?:quantized|quantised|cuantizad[oa]s?)(?: \\w+)? (?:models?|modelos?)|modelos? (?:cuantizad[oa]s?|locales)|inferencia(?: local)? de modelos|fine[- ]?tun(?:e|ing)(?: (?:a|an|the|my|our|some))?(?: \\w+)? models?)";
const CLOUD_TERM = "(?:cloud|colab|nube|sagemaker|vertex ai)";
const NEGATION =
  "(?:no|not|never|without|sin|nunca|nada de|nothing|zero|don'?t|do not|dont|won'?t|will not|wouldn'?t|would not|doesn'?t|isn'?t|aren'?t|can'?t|cannot)";
// Only these everyday words may sit between a negation and the thing it negates, so "I don't mind AI" is not negated.
const BRIDGE =
  "(?:fan|keen|into|of|want|need|plan|planning|going|intend|interested|interest|in|about|to|do|doing|be|any|anything|something|use|using|run|running|train|training|work|working|with|on|for|the|a|an|it|them|me|suggest|recommend|show|ai|llms?|ml|models?|workloads?|inference|stuff|quiero|necesito|voy|pienso|pensando|planeo|interesa|interesado|interes|usar|entrenar|ejecutar|trabajar|con|hacer|ningun|ninguna|en|de|la|el|los|las|mi|su|modelos?|ia)";
// AI named after a negation counts as refused only when the clause ends there ("no AI, just coding"), not when a
// contrast follows ("don't train AI on the cloud, only locally").
const NEGATED_AI = new RegExp(
  `\\b${NEGATION}(?:\\s+${BRIDGE}){0,6}?\\s+${AI_TERM}\\b(?:\\s+(?:models?|work|workloads?|stuff|anything|tools?|laptops?|features?|projects?|at all|anymore|any more|modelos?|trabajo|cosas|portatiles?|equipos?))*(?=\\s*(?:[,.;:!?]|$)|\\s+(?:just|only|but|and|for|so|because|since|thanks|please|solo|solamente|pero|y|para|porque)\\b)`,
  "g",
);
const NEGATED_AI_AFTER = new RegExp(
  `\\b${AI_TERM}(?:\\s+(?:is|are|was))?\\s+(?:not|isn'?t|aren'?t)\\s+(?:something|needed|necessary|a priority|important|relevant|for me|what i need)\\b`,
  "g",
);
const TRAINING_TERM = "(?:train(?:ing)?|entrenar|entrenamiento|entrenando|fine[- ]?tun(?:e|ing))";
// As with AI, a refused step counts only when the clause ends there; "don't train on the cloud, only locally" still trains.
const NEGATED_TRAINING = new RegExp(
  `\\b${NEGATION}(?:\\s+${BRIDGE}){0,4}?\\s+${TRAINING_TERM}\\b(?:\\s+(?:ai|llms?|ml|models?|modelos?|de|ia|them|it|anything|any|more|at all|anymore))*(?=\\s*(?:[,.;:!?]|$)|\\s+(?:just|only|but|and|for|so|because|since|solo|solamente|pero|y|para|porque)\\b)`,
  "g",
);
const NEGATED_CLOUD = new RegExp(`\\b${NEGATION}(?:\\s+${BRIDGE}){0,8}?\\s+${CLOUD_TERM}\\b`, "g");
const LOCAL_TERM =
  "(?:local(?:ly|mente)?|on (?:the |my )?laptop(?: itself)?|en (?:el |mi )?(?:portatil|equipo)|(?:use|using|usar|usando) (?:the |my |el |mi )?(?:own )?(?:laptop|portatil|computer|computadora))";
const NEGATED_LOCAL = new RegExp(`\\b${NEGATION}(?:\\s+${BRIDGE}){0,6}?\\s*${LOCAL_TERM}\\b`, "g");

// AI-related wording the classifier does not name. It never decides a workload; it only keeps the AI caveat.
const POTENTIAL_AI_HINT = new RegExp(
  "\\b(?:pytorch|tensorflow|cuda|vram|deepseek(?: ?r?\\d+)?|phi[- ]?\\d|lm ?studio|vllm|langchain|q?lora|rocm|mlx|gptq|awq|flux(?= (?:image|dev|schnell|model|\\d))|image generation with flux|text[- ]to[- ]image|image generation|generative ai|gen ?ai|(?:claude|gemini) (?:code|cli|api|models?|locally|opus|sonnet|haiku|pro|flash)|(?:local|open[- ]source|self[- ]hosted) (?:models?|llms?)|modelos? (?:locales|open source|de codigo abierto)|afinar (?:\\w+ )?modelos?|hugging ?face|transformers?|language models?|modelos? de lenguaje|gpt|chatgpt|openai|copilot|jupyter|data science|ciencia de datos|fine[- ]?tun(?:e|ing)|computer vision|opencv|yolo|vector databases?|rag (?:setup|stack|pipelines?|systems?|apps?|chatbots?|index|with|over)|retrieval[- ]augmented|whisper|mistral|gemma|qwen|llamm?a|lamma|quantiz\\w*|cuantiz\\w*|(?:run|running|train|training|fine[- ]?tun(?:e|ing)|correr|ejecutar|entrenar)\\s+(?:\\w+\\s+){0,2}(?:models?|modelos?))\\b",
);

/** Accent-stripped, lower-cased text, the form every workload matcher works on. */
export function normalizeWorkloadText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/\ba\.\s?i\b\.?/gi, "ai")
    .toLowerCase();
}

/** The text with explicitly refused AI work ("no AI", "I will not train AI models") removed. Expects normalized text. */
export function withoutNegatedAi(words: string): string {
  return words.replace(NEGATED_AI, " ").replace(NEGATED_AI_AFTER, " ");
}

/** True when AI work is explicitly refused and no AI request remains. Expects normalized text. */
export function refusesAiWork(words: string): boolean {
  const remaining = withoutNegatedAi(words);
  return remaining !== words && !new RegExp(`\\b${AI_TERM}\\b`).test(remaining);
}

/** True when local (on-laptop) work is stated and not refused ("not on my laptop"). Expects normalized text. */
export function mentionsLocalWork(words: string): boolean {
  return new RegExp(`\\b${LOCAL_TERM}\\b`).test(words.replace(NEGATED_LOCAL, " "));
}

/** True when the shopper refuses local work ("not locally") and states none. Expects normalized text. */
export function refusesLocalWork(words: string): boolean {
  return new RegExp(`\\b${NEGATION}\\b`).test(words) && words.replace(NEGATED_LOCAL, " ") !== words && !mentionsLocalWork(words);
}

/** True when training is stated and not refused ("I don't need to train, only run models"). Expects normalized text. */
export function mentionsTrainingWork(words: string): boolean {
  return new RegExp(`\\b${TRAINING_TERM}\\b`).test(words.replace(NEGATED_TRAINING, " "));
}

/** How many times cloud work is stated and not refused; a restated or listed cloud ("colab or sagemaker") is not tentative. */
export function cloudMentionCount(words: string): number {
  return (words.replace(NEGATED_CLOUD, " ").match(new RegExp(`\\b${CLOUD_TERM}\\b`, "g")) ?? []).length;
}

/** Cloud work stated and not refused ("no need to run it in the cloud"). Expects normalized text. */
export function mentionsCloudWork(words: string): boolean {
  return new RegExp(`\\b${CLOUD_TERM}\\b`).test(words.replace(NEGATED_CLOUD, " "));
}

/** True for likely-AI wording that is not a classified workload and not refused. Expects raw shopper text. */
export function hasPotentialAiHint(text: string): boolean {
  return POTENTIAL_AI_HINT.test(withoutNegatedAi(normalizeWorkloadText(text)));
}

/**
 * Classifies explicit shopper language for advisory clarification only.
 * Ambiguous workloads remain unspecified; no hardware suitability is inferred.
 */
export function classifyAiWorkload(text: string): AiWorkloadKind | null {
  const words = normalizeWorkloadText(text);

  const ai = new RegExp(`\\b${AI_TERM}\\b`).test(withoutNegatedAi(words));

  const programming = /\b(python|programming|coding|software development|programacion|programar)\b/.test(words);

  const cloud = mentionsCloudWork(words);

  const local = mentionsLocalWork(words);

  const training = mentionsTrainingWork(words);

  const inference = /\b(run|running|test|testing|execute|ejecutar|ejecutando|inference|inferencia)\b/.test(words);

  if (!ai) return programming ? "general_programming" : null;

  // Mixed cloud/local references require clarification.
  if (cloud && local) return "unspecified_ai";
  if (cloud) return "cloud_ai";

  if (local && training) return "local_training";

  if (local && inference) return "local_inference";

  // Explicit local model use without a named operation still needs evidence.
  if (local) return "local_inference";

  return "unspecified_ai";
}
