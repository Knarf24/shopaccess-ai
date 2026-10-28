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

/**
 * Classifies explicit shopper language for advisory clarification only.
 * Ambiguous workloads remain unspecified; no hardware suitability is inferred.
 */
export function classifyAiWorkload(text: string): AiWorkloadKind | null {
  const words = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const ai = /\b(ai|llm|machine learning|deep learning|neural networks?|inteligencia artificial|modelos? de ia|aprendizaje automatico|redes? neuronales?)\b/.test(words);

  const programming = /\b(python|programming|coding|software development|programacion|programar)\b/.test(words);

  const cloud = /\b(cloud|colab|nube|sagemaker|vertex ai)\b/.test(words);

  const local = /\b(local(?:ly|mente)?|on (?:the |my )?laptop(?: itself)?|en (?:el |mi )?(?:portatil|equipo))\b/.test(words);

  const training = /\b(train(?:ing)?|entrenar|entrenamiento|fine[- ]?tun(?:e|ing)|entrenando)\b/.test(words);

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
