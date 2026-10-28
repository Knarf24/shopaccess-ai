import { describe, expect, it } from "vitest";
import {
  assessAiWorkload,
  type AiWorkloadKind,
} from "../../src/lib/readiness/ai-workload";

describe("AI workload advisory assessment", () => {
  const kinds: AiWorkloadKind[] = [
    "general_programming",
    "cloud_ai",
    "local_inference",
    "local_training",
    "unspecified_ai",
  ];

  it.each(kinds)(
    "never claims verified compatibility for %s",
    (kind) => {
      const result = assessAiWorkload(kind);

      expect(result.kind).toBe(kind);
      expect(result.compatibility).toBe("not_assessed");
    },
  );

  it("preserves ordinary programming without AI clarification", () => {
    const result = assessAiWorkload("general_programming");

    expect(result.requiresClarification).toBe(false);
    expect(result.missingEvidence).toEqual([]);
  });

  it("requires cloud service requirements for cloud AI", () => {
    const result = assessAiWorkload("cloud_ai");

    expect(result.requiresClarification).toBe(true);
    expect(result.missingEvidence.join(" ")).toMatch(/cloud service/i);
  });

  it("requires model and hardware evidence for local inference", () => {
    const result = assessAiWorkload("local_inference");

    expect(result.requiresClarification).toBe(true);
    expect(result.missingEvidence.join(" ")).toMatch(/model/i);
    expect(result.missingEvidence.join(" ")).toMatch(/GPU.*VRAM/i);
  });

  it("distinguishes local training from inference", () => {
    const training = assessAiWorkload("local_training");
    const inference = assessAiWorkload("local_inference");

    expect(training.missingEvidence).not.toEqual(
      inference.missingEvidence,
    );
    expect(training.missingEvidence.join(" ")).toMatch(/dataset/i);
  });

  it("requests local-versus-cloud clarification for unspecified AI", () => {
    const result = assessAiWorkload("unspecified_ai");

    expect(result.requiresClarification).toBe(true);
    expect(result.missingEvidence.join(" ")).toMatch(/locally or in the cloud/i);
  });
});

describe("AI workload classification from shopper language", () => {
  it.each([
    ["I need a laptop for Python programming", "general_programming"],
    ["I use Google Colab for machine learning", "cloud_ai"],
    ["I use cloud services for AI models", "cloud_ai"],
    ["I want to run an LLM locally", "local_inference"],
    ["I want to test AI models on my laptop", "local_inference"],
    ["I want to train neural networks on my laptop", "local_training"],
    ["I need a laptop for AI", "unspecified_ai"],
    ["Quiero ejecutar modelos de IA localmente", "local_inference"],
    ["Quiero entrenar modelos de IA en mi portátil", "local_training"],
    ["Uso Google Colab para aprendizaje automático", "cloud_ai"],
  ] as const)(
    "classifies %s as %s",
    async (shopperText, expected) => {
      const { classifyAiWorkload } = await import(
        "../../src/lib/readiness/ai-workload"
      );

      expect(classifyAiWorkload(shopperText)).toBe(expected);
    },
  );

  it("does not interpret ordinary shopping navigation as AI work", async () => {
    const { classifyAiWorkload } = await import(
      "../../src/lib/readiness/ai-workload"
    );

    for (const text of [
      "confirm my choices",
      "open permissions",
      "I need a charger",
      "budget $600",
    ]) {
      expect(classifyAiWorkload(text)).toBeNull();
    }
  });

  it("does not confuse cloud training with local training", async () => {
    const { classifyAiWorkload } = await import(
      "../../src/lib/readiness/ai-workload"
    );

    expect(
      classifyAiWorkload("I train machine learning models in Google Colab"),
    ).toBe("cloud_ai");
  });
});

describe("AI workload ambiguity safeguards", () => {
  it("does not silently treat mixed local training and cloud references as cloud-only", async () => {
    const { classifyAiWorkload } = await import(
      "../../src/lib/readiness/ai-workload"
    );
    expect(
      classifyAiWorkload(
        "I use cloud services but want to train neural networks locally"
      )
    ).toBe("unspecified_ai");
  });

  it("provides Spanish clarification for local training", async () => {
    const { workloadGuidance } = await import(
      "../../src/lib/readiness/workload-guidance"
    );
    const reply = workloadGuidance(
      "Quiero entrenar modelos de IA en mi portátil",
      "es"
    );
    expect(reply).toMatch(/entrenar|entrenamiento/i);
    expect(reply).toMatch(/GPU|VRAM/);
    expect(reply).not.toMatch(/puede ejecutar|es compatible/i);
  });
});

describe("Mixed AI workload conversation regression", () => {
  it("asks for clarification when cloud and local training are both mentioned", async () => {
    const { workloadGuidance } = await import(
      "../../src/lib/readiness/workload-guidance"
    );

    const reply = workloadGuidance(
      "I use cloud services but want to train neural networks locally",
      "en",
    );

    expect(reply).toMatch(/laptop.*cloud.*both/i);
    expect(reply).not.toMatch(/is compatible|can run/i);
  });
});

describe("AI workload conversation guidance integration", () => {
  it("asks about training requirements for local model training", async () => {
    const { workloadGuidance } = await import(
      "../../src/lib/readiness/workload-guidance"
    );

    const reply = workloadGuidance(
      "I want to train neural networks on my laptop",
      "en",
    );

    expect(reply).toMatch(/training|dataset/i);
    expect(reply).toMatch(/GPU|VRAM/i);
    expect(reply).not.toMatch(/can run|is compatible/i);
  });

  it("does not interrupt ordinary programming needs", async () => {
    const { workloadGuidance } = await import(
      "../../src/lib/readiness/workload-guidance"
    );

    expect(
      workloadGuidance("I need a laptop for Python programming", "en"),
    ).toBeNull();
  });
});
