import { localAiEvidenceMissing, type AiHardwareEvidenceAssessment, type ResolvedAiHardwareFact } from "@/lib/readiness/ai-hardware";

type Language = "en" | "es";

const WORKLOAD_LABELS = {
  general_programming: { en: "general programming", es: "programación general" },
  cloud_ai: { en: "cloud AI", es: "IA en la nube" },
  local_inference: { en: "local AI inference", es: "inferencia de IA local" },
  local_training: { en: "local AI training", es: "entrenamiento de IA local" },
  unspecified_ai: { en: "an unspecified AI workload", es: "una carga de trabajo de IA sin especificar" },
} as const;

const QUALITY_LABELS = {
  VERIFIED: { en: "verified from the demo catalog", es: "verificado en el catálogo de demostración" },
  UNVERIFIED: { en: "unverified external information", es: "información externa sin verificar" },
  STALE: { en: "outdated evidence", es: "evidencia desactualizada" },
  CONTRADICTORY: { en: "conflicting evidence", es: "evidencia contradictoria" },
  MISSING: { en: "not provided", es: "no disponible" },
} as const;

function hardwareFact(label: string, fact: ResolvedAiHardwareFact, language: Language): string {
  const quality = QUALITY_LABELS[fact.quality][language];
  if (fact.value === null) return `${label}: ${quality}`;
  return `${label}: ${fact.value} GB (${quality})`;
}

/**
 * An evidence disclosure, not an AI compatibility verdict or purchase authorization.
 * General readiness is assessed separately.
 */
export function AiCompatibilityDisclosure({
  assessment,
  language,
}: {
  readonly assessment: AiHardwareEvidenceAssessment;
  readonly language: Language;
}) {
  const workload = WORKLOAD_LABELS[assessment.workload][language];

  return (
    <section
      className="flex flex-col gap-1 rounded border border-zinc-300 p-3 text-sm dark:border-zinc-700"
      data-ai-compatibility={assessment.compatibility}
      data-ai-workload={assessment.workload}
      aria-label={language === "es" ? "Evidencia de compatibilidad con IA" : "AI compatibility evidence"}
    >
      <p className="font-semibold">
        {language === "es" ? "Compatibilidad con IA: no verificada" : "AI compatibility: not verified"}
      </p>
      <p>
        {language === "es"
          ? `No se ha verificado la compatibilidad de este portátil con ${workload}. La evaluación general de idoneidad no confirma que pueda ejecutar esta carga de trabajo.`
          : `This laptop has not been verified for ${workload}. General readiness does not establish that it can run this workload.`}
      </p>
      <ul className="flex flex-col gap-1">
        <li>{hardwareFact("RAM", assessment.facts.ramGb, language)}</li>
        <li>{hardwareFact("VRAM", assessment.facts.vramGb, language)}</li>
      </ul>
      {localAiEvidenceMissing(assessment) ? (
        <p data-ai-evidence-missing="gpu-vram">
          {language === "es"
            ? `Faltan datos de GPU y VRAM de este portátil, por lo que no se puede recomendar ni descartar para ${workload}. La falta de datos no significa que no funcione.`
            : `GPU and VRAM evidence is missing for this laptop, so it cannot be recommended or ruled out for ${workload}. Missing evidence does not mean it will not work.`}
        </p>
      ) : null}
      <p>
        {language === "es"
          ? "No se ha evaluado la compatibilidad específica con modelos, GPU, controladores o frameworks de IA. Esta información no autoriza una compra."
          : "Model-specific GPU, driver, and AI framework compatibility has not been assessed. This information does not authorize a purchase."}
      </p>
    </section>
  );
}
