import { describe, expect, it } from "vitest";
import { assessAiHardwareEvidence, evidenceFromAiLaptopVariant } from "../../src/lib/readiness/ai-hardware";
import { LaptopMerchantVariantSchema } from "../../src/lib/catalog/schemas";

describe("source-aware AI hardware evidence", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");

  const item = (
    fact: "ramGb" | "vramGb",
    value: number,
    source: "merchant_catalog" | "external_listing",
    observedAt = now.toISOString(),
  ) => ({
    fact,
    value,
    source,
    sourceRef: "test source",
    observedAt,
  });

  it("accepts consistent fresh merchant evidence as verified", () => {
    const result = assessAiHardwareEvidence(
      "local_inference",
      [item("ramGb", 16, "merchant_catalog")],
      now,
    );

    expect(result.facts.ramGb.quality).toBe("VERIFIED");
    expect(result.facts.ramGb.value).toBe(16);
    expect(result.compatibility).toBe("not_assessed");
    expect(result.authorizesPurchase).toBe(false);
  });

  it("does not treat external-only evidence as verified", () => {
    const result = assessAiHardwareEvidence(
      "local_inference",
      [item("vramGb", 8, "external_listing")],
      now,
    );

    expect(result.facts.vramGb.quality).toBe("UNVERIFIED");
  });

  it("detects contradictory fresh specifications", () => {
    const result = assessAiHardwareEvidence(
      "local_training",
      [
        item("ramGb", 16, "merchant_catalog"),
        item("ramGb", 32, "external_listing"),
      ],
      now,
    );

    expect(result.facts.ramGb.quality).toBe("CONTRADICTORY");
    expect(result.facts.ramGb.value).toBeNull();
  });

  it("rejects stale evidence as a current hardware fact", () => {
    const result = assessAiHardwareEvidence(
      "local_inference",
      [item("vramGb", 8, "merchant_catalog", "2026-08-01T12:00:00.000Z")],
      now,
    );

    expect(result.facts.vramGb.quality).toBe("STALE");
    expect(result.facts.vramGb.value).toBeNull();
  });

  it("does not accept future-dated evidence beyond clock tolerance", () => {
    const result = assessAiHardwareEvidence(
      "local_inference",
      [item("ramGb", 16, "merchant_catalog", "2026-11-01T12:00:00.000Z")],
      now,
    );

    expect(result.facts.ramGb.quality).not.toBe("VERIFIED");
  });

  it("does not accept invalid numeric values as verified facts", () => {
    const result = assessAiHardwareEvidence(
      "local_training",
      [item("vramGb", Number.POSITIVE_INFINITY, "merchant_catalog")],
      now,
    );

    expect(result.facts.vramGb.quality).not.toBe("VERIFIED");
  });
});


describe("catalog-backed AI hardware evidence", () => {
  const validVariant = {
    variantId: "dmv_abcdef",
    label: "Test laptop",
    unitAmountCents: 85000,
    currency: "USD",
    maxQuantityPerOrder: 1,
    availability: "IN_STOCK",
    specs: {
      cpu: "Example CPU",
      ramGb: 16,
      storageGb: 512,
      storageType: "SSD",
      screenInches: 14,
      weightKg: 1.5,
      operatingSystem: "Windows 11",
    },
  };

  const now = new Date("2026-10-27T12:00:00.000Z");

  it("creates RAM evidence from a validated laptop", () => {
    expect(LaptopMerchantVariantSchema.safeParse(validVariant).success).toBe(true);

    const evidence = evidenceFromAiLaptopVariant(validVariant, 3, now);

    expect(evidence).toEqual([
      {
        fact: "ramGb",
        value: 16,
        source: "merchant_catalog",
        sourceRef: "demo catalog revision 3, dmv_abcdef",
        observedAt: now.toISOString(),
      },
    ]);

    const assessment = assessAiHardwareEvidence("local_inference", evidence, now);

    expect(assessment.facts.ramGb.quality).toBe("VERIFIED");
    expect(assessment.facts.vramGb.quality).toBe("MISSING");
    expect(assessment.compatibility).toBe("not_assessed");
    expect(assessment.authorizesPurchase).toBe(false);
  });

  it("rejects invalid laptop specifications", () => {
    const invalid = {
      ...validVariant,
      specs: { ...validVariant.specs, ramGb: 0 },
    };

    expect(evidenceFromAiLaptopVariant(invalid, 3, now)).toEqual([]);
  });

  it("rejects unsupported GPU or VRAM fields", () => {
    const unsupported = {
      ...validVariant,
      specs: { ...validVariant.specs, vramGb: 8 },
    };

    expect(evidenceFromAiLaptopVariant(unsupported, 3, now)).toEqual([]);
  });

  it("rejects invalid catalog revisions", () => {
    expect(evidenceFromAiLaptopVariant(validVariant, 0, now)).toEqual([]);
  });
});
