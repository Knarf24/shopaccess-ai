import type { AiWorkloadKind } from "./ai-workload";
import { LaptopMerchantVariantSchema } from "../catalog/schemas";

export interface AiHardwareEvidence {
  readonly cpu?: string;
  readonly ramGb?: number;
  readonly storageGb?: number;
  readonly gpu?: string;
  readonly vramGb?: number;
}

export interface AiHardwareAssessment {
  readonly workload: AiWorkloadKind;
  readonly compatibility: "not_assessed";
  readonly knownFacts: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly requiresClarification: boolean;
  readonly authorizesPurchase: false;
}

export function assessAiHardware(
  workload: AiWorkloadKind,
  evidence: AiHardwareEvidence,
): AiHardwareAssessment {
  const knownFacts: string[] = [];
  const missingEvidence: string[] = [];

  const addText = (label: string, value: string | undefined) => {
    if (typeof value === "string" && value.trim().length > 0) {
      knownFacts.push(`${label}: ${value.trim()}`);
    } else {
      missingEvidence.push(label);
    }
  };

  const addNumber = (label: string, value: number | undefined) => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      knownFacts.push(`${label}: ${value} GB`);
    } else {
      missingEvidence.push(label);
    }
  };

  addText("CPU", evidence.cpu);
  addNumber("RAM", evidence.ramGb);
  addNumber("Storage", evidence.storageGb);

  if (workload === "local_inference" || workload === "local_training") {
    addText("GPU", evidence.gpu);
    addNumber("VRAM", evidence.vramGb);
  }

  if (workload === "cloud_ai") {
    missingEvidence.push("Cloud service and workload requirements");
    missingEvidence.push("Local development requirements");
  }

  if (workload === "local_inference") {
    missingEvidence.push("AI model and inference requirements");
    missingEvidence.push("Framework and execution requirements");
  }

  if (workload === "local_training") {
    missingEvidence.push("Training model and dataset requirements");
    missingEvidence.push("Framework and accelerator requirements");
  }

  if (workload === "unspecified_ai") {
    missingEvidence.push("Whether AI processing runs locally or in the cloud");
    missingEvidence.push("Specific AI workload requirements");
  }

  return {
    workload,
    compatibility: "not_assessed",
    knownFacts,
    missingEvidence,
    requiresClarification: missingEvidence.length > 0,
    authorizesPurchase: false,
  };
}


export type AiHardwareFactKey = "ramGb" | "vramGb";

export type AiHardwareEvidenceQuality =
  | "VERIFIED"
  | "UNVERIFIED"
  | "STALE"
  | "CONTRADICTORY"
  | "MISSING";

export interface AiHardwareEvidenceItem {
  readonly fact: AiHardwareFactKey;
  readonly value: number;
  readonly source: "merchant_catalog" | "external_listing";
  readonly sourceRef: string;
  readonly observedAt: string;
}

export interface ResolvedAiHardwareFact {
  readonly value: number | null;
  readonly quality: AiHardwareEvidenceQuality;
}

export interface AiHardwareEvidenceAssessment {
  readonly workload: AiWorkloadKind;
  readonly facts: Readonly<Record<AiHardwareFactKey, ResolvedAiHardwareFact>>;
  readonly compatibility: "not_assessed";
  readonly authorizesPurchase: false;
}

const AI_HARDWARE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AI_HARDWARE_CLOCK_SKEW_MS = 5 * 60 * 1000;

function resolveAiHardwareFact(
  fact: AiHardwareFactKey,
  evidence: readonly AiHardwareEvidenceItem[],
  nowMs: number,
): ResolvedAiHardwareFact {
  const relevant = evidence.filter((item) => item.fact === fact);

  if (relevant.length === 0) {
    return { value: null, quality: "MISSING" };
  }

  const valid = relevant.filter(
    (item) =>
      typeof item.value === "number" &&
      Number.isFinite(item.value) &&
      item.value > 0 &&
      typeof item.sourceRef === "string" &&
      item.sourceRef.trim().length > 0 &&
      (item.source === "merchant_catalog" ||
        item.source === "external_listing") &&
      Number.isFinite(Date.parse(item.observedAt)),
  );

  if (valid.length !== relevant.length) {
    return { value: null, quality: "MISSING" };
  }

  const fresh = valid.filter((item) => {
    const observed = Date.parse(item.observedAt);

    return (
      observed <= nowMs + AI_HARDWARE_CLOCK_SKEW_MS &&
      nowMs < observed + AI_HARDWARE_MAX_AGE_MS
    );
  });

  if (fresh.length === 0) {
    return { value: null, quality: "STALE" };
  }

  if (new Set(fresh.map((item) => item.value)).size > 1) {
    return { value: null, quality: "CONTRADICTORY" };
  }

  return {
    value: fresh[0].value,
    quality: fresh.some((item) => item.source === "merchant_catalog")
      ? "VERIFIED"
      : "UNVERIFIED",
  };
}

/**
 * True when the workload runs on the laptop's own GPU and the catalog gives no verified VRAM. Missing evidence is not
 * proof of incompatibility: it only means a "Recommended" claim cannot be substantiated for this workload.
 */
export function localAiEvidenceMissing(assessment: AiHardwareEvidenceAssessment): boolean {
  return (
    (assessment.workload === "local_training" || assessment.workload === "local_inference") &&
    assessment.facts.vramGb.quality !== "VERIFIED"
  );
}

/**
 * True when a suggestion must not be shown as an unqualified recommendation for this shopper: local AI without
 * verified VRAM, or an AI request the classifier could not pin down ("potential"). This is a label rule only. It
 * says nothing about whether the laptop works, and it never changes eligibility, ranking or purchase authorization.
 */
export function aiRecommendationUnverified(
  assessment: AiHardwareEvidenceAssessment,
  aiContext: boolean | "potential" | undefined,
): boolean {
  // "unspecified_ai" with a known AI context means local use cannot be ruled out; only explicit cloud-only use is exempt.
  return (
    localAiEvidenceMissing(assessment) ||
    aiContext === "potential" ||
    (aiContext === true && assessment.workload === "unspecified_ai")
  );
}

/**
 * Source-aware hardware evidence inventory.
 * No model-specific compatibility conclusion or purchase authorization.
 */
export function assessAiHardwareEvidence(
  workload: AiWorkloadKind,
  evidence: readonly AiHardwareEvidenceItem[],
  now: Date,
): AiHardwareEvidenceAssessment {
  const nowMs = now.getTime();

  return {
    workload,
    facts: {
      ramGb: resolveAiHardwareFact("ramGb", evidence, nowMs),
      vramGb: resolveAiHardwareFact("vramGb", evidence, nowMs),
    },
    compatibility: "not_assessed",
    authorizesPurchase: false,
  };
}


/**
 * Construct AI evidence only from a schema-validated merchant laptop variant.
 * The catalog currently contains RAM but no GPU or VRAM fields.
 */
export function evidenceFromAiLaptopVariant(
  rawVariant: unknown,
  catalogRevision: number,
  observedAt: Date,
): AiHardwareEvidenceItem[] {
  const parsed = LaptopMerchantVariantSchema.safeParse(rawVariant);

  if (
    !parsed.success ||
    !Number.isSafeInteger(catalogRevision) ||
    catalogRevision <= 0 ||
    !Number.isFinite(observedAt.getTime())
  ) {
    return [];
  }

  const variant = parsed.data;

  return [
    {
      fact: "ramGb",
      value: variant.specs.ramGb,
      source: "merchant_catalog",
      sourceRef: `demo catalog revision ${catalogRevision}, ${variant.variantId}`,
      observedAt: observedAt.toISOString(),
    },
  ];
}
