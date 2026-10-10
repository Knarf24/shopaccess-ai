import { z } from "zod";
import { MERCHANT_PRODUCT_ID_PATTERN, MERCHANT_VARIANT_ID_PATTERN, type MerchantVariant } from "../catalog/schemas";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/crypto";
import { err, ok, type Result } from "../shared/result";

/**
 * Deterministic purchase readiness engine. The same validated input always
 * yields the same assessment. The result describes suitability evidence only;
 * it is never permission to purchase and nothing here can start a checkout.
 */
export const READINESS_ENGINE_VERSION = "readiness-1.0.0";

const HOUR_MS = 60 * 60 * 1000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export const INTENDED_USES = ["programming", "schoolwork", "general_productivity"] as const;
export type IntendedUse = (typeof INTENDED_USES)[number];

export const FACT_KEYS = [
  "budgetCents",
  "intendedUse",
  "priceCents",
  "availability",
  "ramGb",
  "storageGb",
  "weightKg",
] as const;
export type FactKey = (typeof FACT_KEYS)[number];

/** How long a piece of evidence may be relied on after it was observed. */
export const EVIDENCE_MAX_AGE_MS: Record<FactKey, number> = {
  budgetCents: 24 * HOUR_MS,
  intendedUse: 24 * HOUR_MS,
  priceCents: 24 * HOUR_MS,
  availability: 24 * HOUR_MS,
  ramGb: 30 * 24 * HOUR_MS,
  storageGb: 30 * 24 * HOUR_MS,
  weightKg: 30 * 24 * HOUR_MS,
};

/** Published, versioned thresholds per intended use. */
export const USE_REQUIREMENTS: Record<IntendedUse, { minRamGb: number; recommendedRamGb: number; minStorageGb: number; recommendedStorageGb: number }> = {
  programming: { minRamGb: 8, recommendedRamGb: 16, minStorageGb: 256, recommendedStorageGb: 512 },
  schoolwork: { minRamGb: 8, recommendedRamGb: 8, minStorageGb: 128, recommendedStorageGb: 256 },
  general_productivity: { minRamGb: 8, recommendedRamGb: 8, minStorageGb: 128, recommendedStorageGb: 256 },
};

export const PORTABLE_WEIGHT_LIMIT_KG = 2;

export const EvidenceItemSchema = z.strictObject({
  fact: z.enum(FACT_KEYS),
  value: z.union([z.number().finite(), z.string().min(1).max(64)]),
  source: z.enum(["shopper_stated", "merchant_catalog", "external_listing"]),
  /** Where the value came from, e.g. a catalog revision. Plain text, never interpreted. */
  sourceRef: z.string().min(1).max(120),
  observedAt: z.iso.datetime(),
});

// Strict objects: unknown keys (for example income or health details) are
// rejected rather than silently accepted, so no sensitive attribute can be
// supplied to, or inferred by, the engine.
export const ReadinessInputSchema = z.strictObject({
  subject: z.strictObject({
    productId: z.string().regex(MERCHANT_PRODUCT_ID_PATTERN),
    variantId: z.string().regex(MERCHANT_VARIANT_ID_PATTERN),
    catalogRevision: z.number().int().positive(),
  }),
  evidence: z.array(EvidenceItemSchema).max(64),
});

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type ReadinessInput = z.infer<typeof ReadinessInputSchema>;

export type ReadinessStatus = "READY" | "READY_WITH_CAVEATS" | "NOT_RECOMMENDED" | "INSUFFICIENT_EVIDENCE";
export type FactorOutcome = "PASS" | "CAVEAT" | "FAIL" | "UNKNOWN";
export type EvidenceQuality = "VERIFIED" | "SHOPPER_STATED" | "UNVERIFIED" | "STALE" | "CONTRADICTORY" | "MISSING";
export type FactorKey = "affordability" | "availability" | "memory" | "storage" | "portability";

export interface FactorAssessment {
  readonly factor: FactorKey;
  readonly required: boolean;
  readonly outcome: FactorOutcome;
  readonly evidenceQuality: EvidenceQuality;
  readonly evidence: readonly EvidenceItem[];
  readonly missing: readonly FactKey[];
  readonly contradictory: readonly FactKey[];
  readonly reason: string;
}

export interface ReadinessAssessment {
  readonly engineVersion: string;
  readonly status: ReadinessStatus;
  readonly subject: ReadinessInput["subject"];
  readonly factors: readonly FactorAssessment[];
  readonly inputDigest: string;
  readonly assessedAt: string;
  /** After this instant at least one piece of supporting evidence is stale. */
  readonly validUntil: string;
  /** Always false. Readiness labels describe the assessment, not permission to purchase. */
  readonly authorizesPurchase: false;
}

type ResolvedFact =
  | { status: "OK"; value: number | string; items: EvidenceItem[]; quality: "VERIFIED" | "SHOPPER_STATED" | "UNVERIFIED" }
  | { status: "MISSING" | "STALE" | "CONTRADICTORY"; items: EvidenceItem[] };

const QUALITY_RANK: Record<EvidenceQuality, number> = {
  VERIFIED: 0,
  SHOPPER_STATED: 1,
  UNVERIFIED: 2,
  STALE: 3,
  CONTRADICTORY: 4,
  MISSING: 5,
};

function isFresh(item: EvidenceItem, now: number): boolean {
  const observed = Date.parse(item.observedAt);
  return observed <= now + CLOCK_SKEW_TOLERANCE_MS && now < observed + EVIDENCE_MAX_AGE_MS[item.fact];
}

function resolveFact(evidence: readonly EvidenceItem[], fact: FactKey, now: number): ResolvedFact {
  const all = evidence.filter((item) => item.fact === fact);
  if (all.length === 0) return { status: "MISSING", items: [] };
  const fresh = all.filter((item) => isFresh(item, now));
  if (fresh.length === 0) return { status: "STALE", items: all };
  if (new Set(fresh.map((item) => canonicalJson(item.value))).size > 1) return { status: "CONTRADICTORY", items: fresh };
  const quality = fresh.some((item) => item.source === "merchant_catalog")
    ? "VERIFIED"
    : fresh.some((item) => item.source === "shopper_stated")
      ? "SHOPPER_STATED"
      : "UNVERIFIED";
  return { status: "OK", value: fresh[0].value, items: fresh, quality };
}

interface FactorRule {
  readonly factor: FactorKey;
  readonly required: boolean;
  readonly facts: readonly FactKey[];
  evaluate(values: Record<string, number | string>): { outcome: "PASS" | "CAVEAT" | "FAIL"; reason: string } | { invalid: FactKey };
}

const asPositiveNumber = (value: number | string): number | null =>
  typeof value === "number" && value > 0 ? value : null;

const asIntendedUse = (value: number | string): IntendedUse | null =>
  INTENDED_USES.includes(value as IntendedUse) ? (value as IntendedUse) : null;

function thresholdRule(
  factor: "memory" | "storage",
  fact: "ramGb" | "storageGb",
  label: string,
  pick: (use: IntendedUse) => { min: number; recommended: number },
): FactorRule {
  return {
    factor,
    required: true,
    facts: ["intendedUse", fact],
    evaluate(values) {
      const use = asIntendedUse(values.intendedUse);
      const amount = asPositiveNumber(values[fact]);
      if (use === null) return { invalid: "intendedUse" };
      if (amount === null) return { invalid: fact };
      const { min, recommended } = pick(use);
      if (amount < min) return { outcome: "FAIL", reason: `${amount} GB ${label} is below the ${min} GB minimum for ${use}.` };
      if (amount < recommended) {
        return { outcome: "CAVEAT", reason: `${amount} GB ${label} meets the ${min} GB minimum for ${use} but is below the recommended ${recommended} GB.` };
      }
      return { outcome: "PASS", reason: `${amount} GB ${label} meets the recommended ${recommended} GB for ${use}.` };
    },
  };
}

const FACTOR_RULES: readonly FactorRule[] = [
  {
    factor: "affordability",
    required: true,
    facts: ["budgetCents", "priceCents"],
    evaluate(values) {
      const budget = asPositiveNumber(values.budgetCents);
      const price = asPositiveNumber(values.priceCents);
      if (budget === null || !Number.isSafeInteger(budget)) return { invalid: "budgetCents" };
      if (price === null || !Number.isSafeInteger(price)) return { invalid: "priceCents" };
      return price <= budget
        ? { outcome: "PASS", reason: "The price is within the stated budget." }
        : { outcome: "FAIL", reason: "The price is above the stated budget." };
    },
  },
  {
    factor: "availability",
    required: true,
    facts: ["availability"],
    evaluate(values) {
      return values.availability === "IN_STOCK"
        ? { outcome: "PASS", reason: "The variant is listed as in stock." }
        : { outcome: "FAIL", reason: "The variant is not listed as in stock." };
    },
  },
  thresholdRule("memory", "ramGb", "memory", (use) => ({
    min: USE_REQUIREMENTS[use].minRamGb,
    recommended: USE_REQUIREMENTS[use].recommendedRamGb,
  })),
  thresholdRule("storage", "storageGb", "storage", (use) => ({
    min: USE_REQUIREMENTS[use].minStorageGb,
    recommended: USE_REQUIREMENTS[use].recommendedStorageGb,
  })),
  {
    factor: "portability",
    required: false,
    facts: ["weightKg"],
    evaluate(values) {
      const weight = asPositiveNumber(values.weightKg);
      if (weight === null) return { invalid: "weightKg" };
      return weight <= PORTABLE_WEIGHT_LIMIT_KG
        ? { outcome: "PASS", reason: `At ${weight} kg it is within the ${PORTABLE_WEIGHT_LIMIT_KG} kg guideline for carrying daily.` }
        : { outcome: "CAVEAT", reason: `At ${weight} kg it is heavier than the ${PORTABLE_WEIGHT_LIMIT_KG} kg guideline for carrying daily.` };
    },
  },
];

function assessFactor(rule: FactorRule, evidence: readonly EvidenceItem[], now: number): { factor: FactorAssessment; expiresAt: number } {
  const resolved = rule.facts.map((fact) => ({ fact, result: resolveFact(evidence, fact, now) }));
  const items = resolved.flatMap((entry) => entry.result.items);
  const missing = resolved.filter((entry) => entry.result.status === "MISSING" || entry.result.status === "STALE").map((entry) => entry.fact);
  const contradictory = resolved.filter((entry) => entry.result.status === "CONTRADICTORY").map((entry) => entry.fact);
  const base = { factor: rule.factor, required: rule.required, evidence: items };
  const unknown = (evidenceQuality: EvidenceQuality, reason: string, extraMissing: FactKey[] = []): { factor: FactorAssessment; expiresAt: number } => ({
    factor: { ...base, outcome: "UNKNOWN", evidenceQuality, missing: [...missing, ...extraMissing], contradictory, reason },
    expiresAt: Number.POSITIVE_INFINITY,
  });

  if (contradictory.length > 0) return unknown("CONTRADICTORY", `Sources disagree about: ${contradictory.join(", ")}.`);
  if (missing.length > 0) {
    const stale = resolved.some((entry) => entry.result.status === "STALE");
    return unknown(stale ? "STALE" : "MISSING", `${stale ? "Missing or out-of-date" : "Missing"} information: ${missing.join(", ")}.`);
  }

  const values: Record<string, number | string> = {};
  let quality: EvidenceQuality = "VERIFIED";
  for (const { fact, result } of resolved) {
    if (result.status !== "OK") continue;
    values[fact] = result.value;
    if (QUALITY_RANK[result.quality] > QUALITY_RANK[quality]) quality = result.quality;
  }

  const evaluated = rule.evaluate(values);
  if ("invalid" in evaluated) return unknown("MISSING", `The value provided for ${evaluated.invalid} cannot be used.`, [evaluated.invalid]);

  // Evidence that only an external listing vouches for cannot produce a clean pass.
  const downgraded = quality === "UNVERIFIED" && evaluated.outcome === "PASS";
  const expiresAt = Math.min(...items.map((item) => Date.parse(item.observedAt) + EVIDENCE_MAX_AGE_MS[item.fact]));
  return {
    factor: {
      ...base,
      outcome: downgraded ? "CAVEAT" : evaluated.outcome,
      evidenceQuality: quality,
      missing: [],
      contradictory: [],
      reason: downgraded ? `${evaluated.reason} This relies on unverified external information.` : evaluated.reason,
    },
    expiresAt,
  };
}

function summarize(factors: readonly FactorAssessment[]): ReadinessStatus {
  const required = factors.filter((factor) => factor.required);
  // A conclusive failure on verified facts outranks gaps elsewhere; otherwise any gap blocks a conclusion.
  if (required.some((factor) => factor.outcome === "FAIL")) return "NOT_RECOMMENDED";
  if (required.some((factor) => factor.outcome === "UNKNOWN")) return "INSUFFICIENT_EVIDENCE";
  if (factors.some((factor) => factor.outcome !== "PASS")) return "READY_WITH_CAVEATS";
  return "READY";
}

/** Digest of everything material to the conclusion. Observation times are covered by `validUntil` instead. */
export function digestReadinessInput(input: ReadinessInput): string {
  const evidence = input.evidence
    .map((item) => ({ fact: item.fact, value: item.value, source: item.source, sourceRef: item.sourceRef }))
    .map((item) => canonicalJson(item))
    .sort();
  return sha256Hex(canonicalJson({ engineVersion: READINESS_ENGINE_VERSION, subject: input.subject, evidence }));
}

export function assessReadiness(rawInput: unknown, now: Date): Result<ReadinessAssessment, "INVALID_INPUT"> {
  const parsed = ReadinessInputSchema.safeParse(rawInput);
  if (!parsed.success) return err("INVALID_INPUT");
  const input = parsed.data;
  const nowMs = now.getTime();

  const assessed = FACTOR_RULES.map((rule) => assessFactor(rule, input.evidence, nowMs));
  const factors = assessed.map((entry) => entry.factor);
  const earliestExpiry = Math.min(...assessed.map((entry) => entry.expiresAt));

  return ok({
    engineVersion: READINESS_ENGINE_VERSION,
    status: summarize(factors),
    subject: input.subject,
    factors,
    inputDigest: digestReadinessInput(input),
    assessedAt: now.toISOString(),
    validUntil: new Date(Number.isFinite(earliestExpiry) ? earliestExpiry : nowMs).toISOString(),
    authorizesPurchase: false,
  });
}

/**
 * A stored assessment may only be reused while the material inputs are
 * unchanged and its evidence is still fresh. Otherwise it must be recomputed.
 */
export function isAssessmentCurrent(assessment: ReadinessAssessment, currentInput: unknown, now: Date): boolean {
  const parsed = ReadinessInputSchema.safeParse(currentInput);
  if (!parsed.success) return false;
  return (
    assessment.engineVersion === READINESS_ENGINE_VERSION &&
    assessment.inputDigest === digestReadinessInput(parsed.data) &&
    now.getTime() < Date.parse(assessment.validUntil)
  );
}

/** Builds verified evidence for a demo merchant variant from the authoritative catalog. */
export function evidenceFromMerchantVariant(variant: MerchantVariant, catalogRevision: number, observedAt: Date): EvidenceItem[] {
  const common = {
    source: "merchant_catalog" as const,
    sourceRef: `demo catalog revision ${catalogRevision}, ${variant.variantId}`,
    observedAt: observedAt.toISOString(),
  };
  return [
    { fact: "priceCents", value: variant.unitAmountCents, ...common },
    { fact: "availability", value: variant.availability, ...common },
    { fact: "ramGb", value: variant.specs.ramGb, ...common },
    { fact: "storageGb", value: variant.specs.storageGb, ...common },
    { fact: "weightKg", value: variant.specs.weightKg, ...common },
  ];
}
