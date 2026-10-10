import { z } from "zod";
import type { ExternalProduct, MerchantProduct, MerchantVariant } from "@/lib/catalog/schemas";
import { explainAssessmentSafely, suggestProductsSafely, type SafeExplanation } from "@/lib/providers/ai";
import {
  assessReadiness,
  evidenceFromMerchantVariant,
  INTENDED_USES,
  type EvidenceItem,
  type IntendedUse,
  type ReadinessAssessment,
} from "@/lib/readiness/engine";
import type { Runtime } from "./runtime";

export const USE_LABELS: Record<IntendedUse, string> = {
  programming: "Programming",
  schoolwork: "Schoolwork",
  general_productivity: "General productivity",
};

/** Query-string preferences. Budget is whole US dollars as typed by the shopper. */
const PreferencesSchema = z.strictObject({
  use: z.enum(INTENDED_USES),
  budget: z.string().regex(/^[1-9][0-9]{1,4}$/),
});

export interface ShopperPreferences {
  readonly use: IntendedUse;
  readonly budgetCents: number;
  readonly budgetDollars: string;
}

export function parsePreferences(use: unknown, budget: unknown): ShopperPreferences | null {
  const parsed = PreferencesSchema.safeParse({ use, budget });
  if (!parsed.success) return null;
  return { use: parsed.data.use, budgetCents: Number(parsed.data.budget) * 100, budgetDollars: parsed.data.budget };
}

export function preferencesQuery(preferences: ShopperPreferences): string {
  return new URLSearchParams({ use: preferences.use, budget: preferences.budgetDollars }).toString();
}

export interface AssessedVariant {
  readonly product: MerchantProduct;
  readonly variant: MerchantVariant;
  readonly assessment: ReadinessAssessment;
  readonly explanation: SafeExplanation | null;
  /** Whether a quote can be requested. Depends only on catalog availability, never on the readiness label or on AI output. */
  readonly quotable: boolean;
}

export interface ShoppingView {
  readonly preferences: ShopperPreferences;
  readonly assistantMessage: string | null;
  readonly merchantName: string;
  readonly variants: readonly AssessedVariant[];
  readonly external: readonly ExternalProduct[];
}

const STATUS_ORDER = { READY: 0, READY_WITH_CAVEATS: 1, INSUFFICIENT_EVIDENCE: 2, NOT_RECOMMENDED: 3 } as const;

/**
 * Builds the recommendations page: a deterministic assessment for every demo
 * variant, an advisory explanation from the local mock AI, and separately
 * listed external discovery results that cannot be checked out.
 */
export async function buildShoppingView(runtime: Runtime, preferences: ShopperPreferences): Promise<ShoppingView> {
  const now = runtime.clock();
  const stated = (fact: "budgetCents" | "intendedUse", value: number | string): EvidenceItem => ({
    fact,
    value,
    source: "shopper_stated",
    sourceRef: "entered by the shopper on this page",
    observedAt: now.toISOString(),
  });

  const variants: AssessedVariant[] = [];
  for (const product of runtime.catalog.products) {
    for (const variant of product.variants) {
      const result = assessReadiness(
        {
          subject: { productId: product.productId, variantId: variant.variantId, catalogRevision: runtime.catalog.revision },
          evidence: [
            stated("budgetCents", preferences.budgetCents),
            stated("intendedUse", preferences.use),
            ...evidenceFromMerchantVariant(variant, runtime.catalog.revision, now),
          ],
        },
        now,
      );
      if (!result.ok) continue;
      const explained = await explainAssessmentSafely(runtime.ai, result.value, "Explain this assessment in plain language.");
      variants.push({
        product,
        variant,
        assessment: result.value,
        explanation: explained.ok ? explained.value : null,
        quotable: variant.availability === "IN_STOCK",
      });
    }
  }
  variants.sort(
    (a, b) => STATUS_ORDER[a.assessment.status] - STATUS_ORDER[b.assessment.status] || a.variant.unitAmountCents - b.variant.unitAmountCents,
  );

  const suggestion = await suggestProductsSafely(runtime.ai, runtime.catalog, `Laptop for ${USE_LABELS[preferences.use]}`);
  const discovered = await runtime.discovery.search("");
  return {
    preferences,
    assistantMessage: suggestion.ok ? suggestion.value.message : null,
    merchantName: runtime.catalog.merchant.displayName,
    variants,
    external: discovered.products,
  };
}
