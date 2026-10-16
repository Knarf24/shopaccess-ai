import {
  PORTABLE_WEIGHT_LIMIT_KG,
  USE_REQUIREMENTS,
  type EvidenceQuality,
  type FactKey,
  type FactorKey,
  type FactorOutcome,
  type IntendedUse,
} from "@/lib/readiness/engine";

const USE_LABELS: Record<IntendedUse, string> = {
  programming: "programación",
  schoolwork: "tareas escolares",
  general_productivity: "productividad general",
};

export interface AssessmentReasonFacts {
  readonly factor: FactorKey;
  readonly outcome: FactorOutcome;
  readonly evidenceQuality: EvidenceQuality;
  readonly facts: readonly { readonly fact: FactKey; readonly value: number | string }[];
}

/**
 * Spanish wording for a deterministic assessment reason.
 * Numbers come from the assessment facts and the published thresholds.
 * Returns null when those facts do not support a supplied sentence.
 */
export function spanishFactorReason(input: AssessmentReasonFacts): string | null {
  if (input.outcome === "UNKNOWN") return null;
  const sentence = suppliedSentence(input);
  if (!sentence) return null;
  if (input.evidenceQuality === "UNVERIFIED" && cleanPass(input)) {
    return `${sentence} Esto se basa en información externa no verificada.`;
  }
  return sentence;
}

function suppliedSentence(input: AssessmentReasonFacts): string | null {
  switch (input.factor) {
    case "affordability":
      return affordability(input.facts);
    case "availability":
      return availability(input.facts);
    case "memory":
      return capacity(input.facts, "ramGb", "memoria", "minRamGb", "recommendedRamGb");
    case "storage":
      return capacity(input.facts, "storageGb", "almacenamiento", "minStorageGb", "recommendedStorageGb");
    case "portability":
      return portability(input.facts);
    default:
      return null;
  }
}

function affordability(facts: AssessmentReasonFacts["facts"]): string | null {
  const price = oneNumber(facts, "priceCents");
  const budget = oneNumber(facts, "budgetCents");
  if (price === null || budget === null) return null;
  return price <= budget ? "El precio está dentro del presupuesto indicado." : "El precio está por encima del presupuesto indicado.";
}

function availability(facts: AssessmentReasonFacts["facts"]): string | null {
  const value = oneString(facts, "availability");
  if (value === null) return null;
  return value === "IN_STOCK" ? "La variante figura como disponible." : "La variante no figura como disponible.";
}

function capacity(
  facts: AssessmentReasonFacts["facts"],
  fact: "ramGb" | "storageGb",
  label: string,
  minimum: "minRamGb" | "minStorageGb",
  recommended: "recommendedRamGb" | "recommendedStorageGb",
): string | null {
  const amount = oneNumber(facts, fact);
  const use = oneUse(facts);
  if (amount === null || use === null) return null;
  const limits = USE_REQUIREMENTS[use];
  const useLabel = USE_LABELS[use];
  if (amount < limits[minimum]) return `${amount} GB de ${label} están por debajo del mínimo de ${limits[minimum]} GB para ${useLabel}.`;
  if (amount < limits[recommended]) {
    return `${amount} GB de ${label} cumplen el mínimo de ${limits[minimum]} GB para ${useLabel}, pero están por debajo de los ${limits[recommended]} GB recomendados.`;
  }
  return `${amount} GB de ${label} cumplen los ${limits[recommended]} GB recomendados para ${useLabel}.`;
}

function portability(facts: AssessmentReasonFacts["facts"]): string | null {
  const weight = oneNumber(facts, "weightKg");
  if (weight === null) return null;
  return weight <= PORTABLE_WEIGHT_LIMIT_KG
    ? `Con ${weight} kg está dentro de la guía de ${PORTABLE_WEIGHT_LIMIT_KG} kg para llevarlo a diario.`
    : `Con ${weight} kg pesa más que la guía de ${PORTABLE_WEIGHT_LIMIT_KG} kg para llevarlo a diario.`;
}

function cleanPass(input: AssessmentReasonFacts): boolean {
  switch (input.factor) {
    case "affordability": {
      const price = oneNumber(input.facts, "priceCents");
      const budget = oneNumber(input.facts, "budgetCents");
      return price !== null && budget !== null && price <= budget;
    }
    case "availability":
      return oneString(input.facts, "availability") === "IN_STOCK";
    case "memory":
      return capacityPass(input.facts, "ramGb", "recommendedRamGb");
    case "storage":
      return capacityPass(input.facts, "storageGb", "recommendedStorageGb");
    case "portability": {
      const weight = oneNumber(input.facts, "weightKg");
      return weight !== null && weight <= PORTABLE_WEIGHT_LIMIT_KG;
    }
    default:
      return false;
  }
}

function capacityPass(
  facts: AssessmentReasonFacts["facts"],
  fact: "ramGb" | "storageGb",
  recommended: "recommendedRamGb" | "recommendedStorageGb",
): boolean {
  const amount = oneNumber(facts, fact);
  const use = oneUse(facts);
  if (amount === null || use === null) return false;
  return amount >= USE_REQUIREMENTS[use][recommended];
}

function matching(facts: AssessmentReasonFacts["facts"], fact: FactKey): readonly (number | string)[] {
  return facts.filter((item) => item.fact === fact).map((item) => item.value);
}

function oneNumber(facts: AssessmentReasonFacts["facts"], fact: FactKey): number | null {
  const found = matching(facts, fact);
  const first = found[0];
  if (found.length === 0 || typeof first !== "number" || !found.every((value) => value === first)) return null;
  return first;
}

function oneString(facts: AssessmentReasonFacts["facts"], fact: FactKey): string | null {
  const found = matching(facts, fact);
  const first = found[0];
  if (found.length === 0 || typeof first !== "string" || !found.every((value) => value === first)) return null;
  return first;
}

function oneUse(facts: AssessmentReasonFacts["facts"]): IntendedUse | null {
  const value = oneString(facts, "intendedUse");
  if (value === "programming" || value === "schoolwork" || value === "general_productivity") return value;
  return null;
}
