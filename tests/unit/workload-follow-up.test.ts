import { describe, expect, it } from "vitest";
import { resolveWorkloadFollowUp } from "../../src/lib/readiness/workload-follow-up";
import { assessAiWorkload } from "../../src/lib/readiness/ai-workload";

describe("multi-turn AI workload clarification", () => {
  it("resolves an ambiguous AI request to local training", () => {
    expect(resolveWorkloadFollowUp("unspecified_ai", "I'll train them locally"))
      .toBe("local_training");
  });

  it("resolves a cloud-only clarification", () => {
    expect(resolveWorkloadFollowUp("unspecified_ai", "I'll use Google Colab"))
      .toBe("cloud_ai");
  });

  it("supports Spanish local training clarification", () => {
    expect(resolveWorkloadFollowUp("unspecified_ai", "Voy a entrenar localmente"))
      .toBe("local_training");
  });

  it("does not silently choose between cloud and local", () => {
    expect(resolveWorkloadFollowUp("unspecified_ai", "Both cloud and local"))
      .toBe("unspecified_ai");
  });

  it("recognizes a change from local inference to training", () => {
    expect(resolveWorkloadFollowUp("local_inference", "I want to train instead"))
      .toBe("local_training");
  });

  it("does not interpret unrelated navigation as a workload change", () => {
    expect(resolveWorkloadFollowUp("cloud_ai", "Open permissions"))
      .toBe("cloud_ai");
  });

  it("does not invent a workload without context", () => {
    expect(resolveWorkloadFollowUp(null, "I'll train them locally"))
      .toBeNull();
  });

  it("handles an explicit switch from cloud AI to local training", () => {
    expect(
      resolveWorkloadFollowUp("cloud_ai", "I want to train AI models locally instead"),
    ).toBe("local_training");
  });

  it("keeps mixed cloud and local training requirements unresolved", () => {
    expect(
      resolveWorkloadFollowUp("local_training", "I need both cloud and local training"),
    ).toBe("unspecified_ai");
  });

  it("recognizes a cloud-only switch from local training", () => {
    expect(
      resolveWorkloadFollowUp("local_training", "I'll use Google Colab instead"),
    ).toBe("cloud_ai");
  });

  it("never converts classification into verified compatibility", () => {
    const kind = resolveWorkloadFollowUp("unspecified_ai", "I'll train them locally");
    expect(kind).toBe("local_training");
    expect(assessAiWorkload(kind!).compatibility).toBe("not_assessed");
  });
});
