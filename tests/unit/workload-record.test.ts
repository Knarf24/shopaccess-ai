import { describe, expect, it } from "vitest";

import {
  validateWorkloadRecord,
  type WorkloadRecord,
} from "../../src/lib/readiness/workload-record";

const valid: WorkloadRecord = {
  sessionId: "session-1",
  draftId: "draft-1",
  kind: "local_training",
  sourceDraftVersion: 4,
  evidenceState: "explicit",
};

describe("durable AI workload record", () => {
  it("accepts a valid, draft-bound workload", () => {
    expect(validateWorkloadRecord(valid)).toEqual(valid);
  });

  it.each([
    "general_programming",
    "cloud_ai",
    "local_inference",
    "local_training",
    "unspecified_ai",
  ] as const)("accepts workload kind %s", (kind) => {
    expect(validateWorkloadRecord({ ...valid, kind })).toMatchObject({ kind });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid source draft version %s", (sourceDraftVersion) => {
    expect(validateWorkloadRecord({ ...valid, sourceDraftVersion })).toBeNull();
  });

  it.each([
    "",
    "assumed",
    "verified_hardware",
  ])("rejects invalid evidence state %s", (evidenceState) => {
    expect(validateWorkloadRecord({ ...valid, evidenceState })).toBeNull();
  });

  it("rejects unknown fields", () => {
    expect(validateWorkloadRecord({ ...valid, purchaseAuthorized: true })).toBeNull();
  });

  it("rejects missing session or draft identity", () => {
    expect(validateWorkloadRecord({ ...valid, sessionId: "" })).toBeNull();
    expect(validateWorkloadRecord({ ...valid, draftId: "" })).toBeNull();
  });
});
