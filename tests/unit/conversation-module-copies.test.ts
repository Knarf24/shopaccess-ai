import { describe, expect, it, vi } from "vitest";

// B1, an M2-1 defect found in the M2-2 browser check (October 16): under the dev server conversation.ts can be loaded
// once per route bundle. Conversation and confirmation-withdrawal state kept in module-level WeakMaps was then
// invisible to a different copy, so the runtime's save could miss a line a route had just recorded. State now lives on
// the shared store object.
describe("conversation state across module copies", () => {
  it("a second copy of the module sees the conversation and selection state the first copy recorded", async () => {
    const store = {};
    const first = await import("@/lib/session/conversation");
    first.recordConversationTurn(store, "ses_1", { draftId: "nd_1", interfaceLanguage: "en", shopperText: "a laptop for schoolwork, budget 600", assistantNotice: "review" });
    first.invalidatePurchaseSelections(store, "ses_1");

    vi.resetModules();
    const second = await import("@/lib/session/conversation");
    expect(second).not.toBe(first);
    expect(second.readConversation(store, "ses_1")?.turns.map((t) => t.text)).toEqual(["a laptop for schoolwork, budget 600", "review"]);
    expect(second.purchaseSelectionsOpen(store, "ses_1")).toBe(false);
    const state = second.conversationStateOf(store);
    expect([...state.conversations.keys()]).toEqual(["ses_1"]);
    expect(state.selections.get("ses_1")).toEqual({ epoch: 1, closed: true });
  });
});
