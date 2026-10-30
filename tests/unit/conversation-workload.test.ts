import { describe, expect, it } from "vitest";
import type { ConversationState } from "../../src/lib/session/conversation";
import { resolveConversationWorkload } from "../../src/lib/readiness/conversation-workload";

function conversation(
  turns: ConversationState["turns"],
): ConversationState {
  return {
    draftId: "test-draft",
    interfaceLanguage: "en",
    turns,
  };
}

describe("conversation workload resolution", () => {
  it("resolves an English AI training follow-up", () => {
    const state = conversation([
      { role: "shopper", text: "I need a laptop for AI" },
      { role: "shopper", text: "I want to train models" },
      { role: "shopper", text: "Locally, on my laptop" },
    ]);

    expect(resolveConversationWorkload(state)).toBe("local_training");
  });

  it("resolves Spanish local training", () => {
    const state = conversation([
      { role: "shopper", text: "Necesito una laptop para inteligencia artificial" },
      { role: "shopper", text: "Quiero entrenar modelos localmente" },
    ]);

    expect(resolveConversationWorkload(state)).toBe("local_training");
  });

  it("allows a later explicit cloud requirement", () => {
    const state = conversation([
      { role: "shopper", text: "I want to train AI models locally" },
      { role: "shopper", text: "Actually, I will use cloud AI" },
    ]);

    expect(resolveConversationWorkload(state)).toBe("cloud_ai");
  });

  it("does not treat assistant messages as shopper requirements", () => {
    const state = conversation([
      { role: "shopper", text: "I need a laptop for AI" },
      { role: "assistant", text: "You could train models locally" },
    ]);

    expect(resolveConversationWorkload(state)).toBe("unspecified_ai");
  });

  it("uses the draft text when no conversation is retained", () => {
    expect(
      resolveConversationWorkload(null, "I want to train AI models locally"),
    ).toBe("local_training");
  });

  it("cannot recover discarded workload evidence from conversation alone", () => {
    const turns = [
      { role: "shopper" as const, text: "I want to train AI models locally" },
      ...Array.from({ length: 9 }, (_, i) => ({
        role: "shopper" as const,
        text: `Thank you, follow-up ${i + 1}`,
      })),
    ];

    const retained = conversation(turns.slice(-8));

    expect(resolveConversationWorkload(retained)).toBe("unspecified_ai");
  });

  it("defaults to unspecified AI without evidence", () => {
    expect(resolveConversationWorkload(null)).toBe("unspecified_ai");
  });
});
