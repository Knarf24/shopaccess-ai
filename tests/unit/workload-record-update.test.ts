import { describe, expect, it } from "vitest";
import { updateWorkloadFromShopperTurn } from "../../src/lib/readiness/workload-record-update";
import type { WorkloadRecord } from "../../src/lib/readiness/workload-record";

const previous: WorkloadRecord = {
  sessionId: "session-test",
  draftId: "draft-test",
  kind: "local_training",
  sourceDraftVersion: 3,
  evidenceState: "explicit",
};

describe("advisory workload record updates", () => {
  it("retains local training through an unrelated budget reply", () => {
    const result = updateWorkloadFromShopperTurn(
      previous, "My budget is $900", "session-test", "draft-test", 4,
    );

    expect(result?.kind).toBe("local_training");
    expect(result?.sourceDraftVersion).toBe(4);
  });

  it("accepts an explicit switch from local training to cloud AI", () => {
    const result = updateWorkloadFromShopperTurn(
      previous, "Actually, I will use cloud AI instead",
      "session-test", "draft-test", 4,
    );

    expect(result?.kind).toBe("cloud_ai");
  });

  it("resolves local training from a prior training requirement", () => {
    const training: WorkloadRecord = {
      ...previous,
      kind: "unspecified_ai",
      evidenceState: "inferred",
    };

    const result = updateWorkloadFromShopperTurn(
      training, "I will train the models on my laptop",
      "session-test", "draft-test", 4,
    );

    expect(result?.kind).toBe("local_training");
  });

  it("does not carry a record across draft boundaries", () => {
    const result = updateWorkloadFromShopperTurn(
      previous, "My budget is $900",
      "session-test", "replacement-draft", 4,
    );

    expect(result?.kind).not.toBe("local_training");
  });

  it("combines an earlier training request with a later local-only clarification", () => {
    const initial = updateWorkloadFromShopperTurn(
      null,
      "I want to train AI models",
      "session-test",
      "draft-test",
      1,
    );

    expect(initial?.kind).toBe("unspecified_ai");

    const clarified = updateWorkloadFromShopperTurn(
      initial,
      "On my laptop",
      "session-test",
      "draft-test",
      2,
    );

    expect(clarified?.kind).toBe("local_training");
  });

  it("does not turn an unspecified AI request into training", () => {
    const initial = updateWorkloadFromShopperTurn(
      null,
      "I want to work with AI models",
      "session-test",
      "draft-test",
      1,
    );

    expect(initial?.kind).toBe("unspecified_ai");

    const clarified = updateWorkloadFromShopperTurn(
      initial,
      "On my laptop",
      "session-test",
      "draft-test",
      2,
    );

    expect(clarified?.kind).toBe("local_inference");
  });

  it("does not create purchase authorization", () => {
    const result = updateWorkloadFromShopperTurn(
      previous, "I want to train AI models locally",
      "session-test", "draft-test", 4,
    );

    expect(result).not.toHaveProperty("authorizesPurchase");
    expect(result).not.toHaveProperty("compatibility", "verified");
  });
});
