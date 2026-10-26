import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NeedsConversation } from "@/components/mock-journey/NeedsConversation";
import { SimulatedPaymentPanel } from "@/components/SimulatedPaymentPanel";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import type { ConversationTurn } from "@/types/conversation-turn";
const copy = journeyCopy("en");
it("collapses only adjacent repeated charger notices in existing histories", () => {
 const turns: ConversationTurn[] = [{ role: "assistant", text: "charger_shown" }, { role: "assistant", text: "charger_shown" }, { role: "shopper", text: "My question" }, { role: "assistant", text: "charger_shown" }];
 const html = renderToStaticMarkup(<NeedsConversation copy={copy} language="en" csrfToken="csrf" draft={null} mode="reply" chargerClarification turns={turns} />);
 expect(html.match(/This is the information-only charger comparison/g)).toHaveLength(2);
 expect(html).toContain("My question"); expect(turns).toHaveLength(4);
});
it("does not advertise a fixed refund above a smaller capture", () => {
 const html = renderToStaticMarkup(<SimulatedPaymentPanel csrfToken="csrf" view={{ intentId: "test", state: "CAPTURED_VERIFIED", quote: null, itemTitle: "Adapter", merchantName: "Demo", challenge: null, challengeProblem: null, permissionRefusal: null, steps: ["external_refund"], transitions: [], observations: [], operations: [], interfaceLanguage: "en" }} />);
 expect(html).not.toContain("$100.00"); expect(html).toContain('value="external_refund"');
});
