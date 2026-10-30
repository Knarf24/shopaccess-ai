import { aiRecommendationUnverified } from "@/lib/readiness/ai-hardware";
import type { GuidedCatalogLine } from "@/server/shopping";

/**
 * Spoken caveat for options whose AI suitability is unverified. The option description is read aloud with each option,
 * so the caveat travels with it instead of the word "Recommended" merely being left out. This file is separate from
 * the hash-pinned journey module on purpose.
 */
export function withAiCaveat(description: string, unverified: boolean, language: string): string {
  if (!unverified) return description;
  const caveat =
    language === "es"
      ? "Aviso: no se ha verificado la compatibilidad de hardware con IA de este portátil."
      : "Note: hardware compatibility for AI is not verified for this laptop.";
  return `${description}. ${caveat}`;
}

/**
 * One spoken option as the needs page presents it: the description carries the AI caveat and "recommended" is dropped
 * whenever the suggestion cannot be shown as an unqualified recommendation (same rule as the visual cards).
 */
export function voiceAiOption(
  line: Pick<GuidedCatalogLine, "label" | "aiHardware" | "aiContext">,
  suggested: boolean,
  language: string,
): { readonly description: string; readonly recommended: boolean } {
  const unverified = aiRecommendationUnverified(line.aiHardware, line.aiContext);
  return { description: withAiCaveat(line.label, unverified, language), recommended: suggested && !unverified };
}
