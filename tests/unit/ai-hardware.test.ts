import { describe, expect, it } from "vitest";
import { assessAiHardware } from "../../src/lib/readiness/ai-hardware";

describe("AI hardware evidence assessment", () => {
  const catalogSpecs = {
    cpu: "Intel Core Ultra 5",
    ramGb: 16,
    storageGb: 512,
  };

  it("records known catalog specifications without claiming compatibility", () => {
    const result = assessAiHardware("general_programming", catalogSpecs);

    expect(result.knownFacts).toContain("RAM: 16 GB");
    expect(result.knownFacts).toContain("Storage: 512 GB");
    expect(result.compatibility).toBe("not_assessed");
    expect(result.authorizesPurchase).toBe(false);
  });

  it("requires GPU, VRAM and model requirements for local inference", () => {
    const result = assessAiHardware("local_inference", catalogSpecs);

    expect(result.missingEvidence).toContain("GPU");
    expect(result.missingEvidence).toContain("VRAM");
    expect(result.missingEvidence).toContain("AI model and inference requirements");
    expect(result.requiresClarification).toBe(true);
  });

  it("distinguishes local training requirements", () => {
    const result = assessAiHardware("local_training", catalogSpecs);

    expect(result.missingEvidence).toContain("Training model and dataset requirements");
    expect(result.missingEvidence).toContain("Framework and accelerator requirements");
  });

  it("does not treat invalid numeric specifications as evidence", () => {
    const result = assessAiHardware("local_inference", {
      cpu: " ",
      ramGb: -1,
      storageGb: Number.NaN,
      vramGb: 0,
    });

    expect(result.missingEvidence).toEqual(
      expect.arrayContaining(["CPU", "RAM", "Storage", "GPU", "VRAM"]),
    );
  });

  it("does not infer suitability even with GPU and VRAM values", () => {
    const result = assessAiHardware("local_training", {
      ...catalogSpecs,
      gpu: "Example accelerator",
      vramGb: 16,
    });

    expect(result.knownFacts).toContain("VRAM: 16 GB");
    expect(result.compatibility).toBe("not_assessed");
    expect(result.authorizesPurchase).toBe(false);
  });

  it("asks for cloud workload requirements", () => {
    const result = assessAiHardware("cloud_ai", catalogSpecs);

    expect(result.missingEvidence).toContain("Cloud service and workload requirements");
    expect(result.compatibility).toBe("not_assessed");
  });

  it("asks for workload clarification when AI use is unspecified", () => {
    const result = assessAiHardware("unspecified_ai", catalogSpecs);

    expect(result.missingEvidence).toContain(
      "Whether AI processing runs locally or in the cloud",
    );
  });
});
