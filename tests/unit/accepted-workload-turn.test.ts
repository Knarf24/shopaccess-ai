import { describe, expect, it } from "vitest";
import { recordAcceptedLaptopWorkload } from "../../src/lib/readiness/accepted-workload-turn";
import { workloadRecordForDraft } from "../../src/lib/session/workload-state";

describe("accepted laptop workload recording", () => {
  it("records an initial local training requirement", () => {
    const host = {};
    const result = recordAcceptedLaptopWorkload(
      host, "session-test", "draft-test", 1,
      "I want to train AI models locally",
    );

    expect(result.current?.kind).toBe("local_training");
    expect(result.changed).toBe(false);
    expect(workloadRecordForDraft(
      host, "session-test", "draft-test", 1,
    )?.kind).toBe("local_training");
  });

  it("preserves local training across unrelated follow-ups", () => {
    const host = {};
    recordAcceptedLaptopWorkload(
      host, "session-test", "draft-test", 1,
      "I want to train AI models locally",
    );

    const result = recordAcceptedLaptopWorkload(
      host, "session-test", "draft-test", 2,
      "My budget is $900",
    );

    expect(result.current?.kind).toBe("local_training");
    expect(result.changed).toBe(false);
  });

  it("detects an explicit switch to cloud AI", () => {
    const host = {};
    recordAcceptedLaptopWorkload(
      host, "session-test", "draft-test", 1,
      "I want to train AI models locally",
    );

    const result = recordAcceptedLaptopWorkload(
      host, "session-test", "draft-test", 2,
      "Actually I will train the models in the cloud",
    );

    expect(result.previous?.kind).toBe("local_training");
    expect(result.current?.kind).toBe("cloud_ai");
    expect(result.changed).toBe(true);
  });

  it("does not reuse a record from another draft", () => {
    const host = {};
    recordAcceptedLaptopWorkload(
      host, "session-test", "draft-one", 1,
      "I want to train AI models locally",
    );

    const result = recordAcceptedLaptopWorkload(
      host, "session-test", "draft-two", 1,
      "I need a laptop for programming",
    );

    expect(result.previous).toBeNull();
    expect(result.current?.kind).toBe("general_programming");
    expect(workloadRecordForDraft(
      host, "session-test", "draft-one", 1,
    )).toBeNull();
  });

  it("does not create a record for an empty message", () => {
    const host = {};
    const result = recordAcceptedLaptopWorkload(
      host, "session-test", "draft-test", 1, "",
    );

    expect(result.current).toBeNull();
    expect(result.changed).toBe(false);
    expect(workloadRecordForDraft(
      host, "session-test", "draft-test", 1,
    )).toBeNull();
  });

  it("does not grant purchase authorization", () => {
    const host = {};
    const result = recordAcceptedLaptopWorkload(
      host, "session-test", "draft-test", 1,
      "I want to train AI models locally",
    );

    expect(result.current).not.toHaveProperty("authorizesPurchase");
    expect(result.current).not.toHaveProperty("compatibilityVerified");
  });
});
