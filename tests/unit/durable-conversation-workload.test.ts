import { describe, expect, it } from "vitest";
import { resolveDurableConversationWorkload } from "../../src/lib/readiness/durable-conversation-workload";
import { replaceWorkloadRecords } from "../../src/lib/session/workload-state";
import type { WorkloadRecord } from "../../src/lib/readiness/workload-record";

const SESSION_ID = "session-test";
const DRAFT_ID = "draft-test";

const saved: WorkloadRecord = {
  sessionId: SESSION_ID,
  draftId: DRAFT_ID,
  kind: "local_training",
  sourceDraftVersion: 3,
  evidenceState: "explicit",
};

function hostWith(record?: WorkloadRecord): object {
  const host = {};
  if (record) {
    replaceWorkloadRecords(host, new Map([[record.sessionId, record]]));
  }
  return host;
}

describe("durable conversation workload resolution", () => {
  it("preserves local training after the original request is truncated", () => {
    const conversation = {
      draftId: DRAFT_ID,
      interfaceLanguage: "en" as const,
      turns: Array.from({ length: 8 }, (_, index) => ({
        role: "shopper" as const,
        text: `Follow-up ${index + 1}`,
      })),
    };

    expect(resolveDurableConversationWorkload(
      hostWith(saved), SESSION_ID, DRAFT_ID, 4, conversation,
      "What is your budget?",
    )).toBe("local_training");
  });

  it("rejects a saved record from a replaced draft", () => {
    expect(resolveDurableConversationWorkload(
      hostWith(saved), SESSION_ID, "replacement-draft", 4,
      null, "I will use cloud AI",
    )).toBe("cloud_ai");
  });

  it("rejects a record newer than the current draft", () => {
    expect(resolveDurableConversationWorkload(
      hostWith(saved), SESSION_ID, DRAFT_ID, 2,
      null, "I will use cloud AI",
    )).toBe("cloud_ai");
  });

  it("preserves legacy conversation classification without a saved record", () => {
    const conversation = {
      draftId: DRAFT_ID,
      interfaceLanguage: "en" as const,
      turns: [
        { role: "shopper" as const, text: "I need a laptop for AI" },
        { role: "shopper" as const, text: "I want to train models" },
        { role: "shopper" as const, text: "Locally, on my laptop" },
      ],
    };

    expect(resolveDurableConversationWorkload(
      hostWith(), SESSION_ID, DRAFT_ID, 4, conversation,
    )).toBe("local_training");
  });

  it("does not use another draft's conversation", () => {
    const conversation = {
      draftId: "another-draft",
      interfaceLanguage: "en" as const,
      turns: [
        { role: "shopper" as const, text: "I want to train AI models locally" },
      ],
    };

    expect(resolveDurableConversationWorkload(
      hostWith(), SESSION_ID, DRAFT_ID, 4, conversation,
    )).toBe("unspecified_ai");
  });
});
