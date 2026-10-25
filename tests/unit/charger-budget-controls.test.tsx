import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChargerConversationControls } from "@/components/mock-journey/ChargerConversationControls";
const track = { sessionId: "session", draftId: "draft", state: "confirmed" as const, deviceId: "Mac14,2" as const, revision: 5, budget: { proposedCents: 5900, confirmedCents: null } };
describe("explicit charger-budget controls", () => {
  it.each(["en", "es"] as const)("labels the separate budget and confirmation in %s", language => {
    const html = renderToStaticMarkup(<ChargerConversationControls budgetEnabled csrfToken="csrf" language={language} track={track} />);
    expect(html).toContain('for="charger-budget"');
    expect(html).toContain('aria-describedby="charger-budget-hint"');
    expect(html).toContain('name="action" value="propose_budget"');
    expect(html).toContain('name="action" value="confirm_budget"');
    expect(html).toContain('name="revision" value="5"');
    expect(html).toContain('name="csrfToken" value="csrf"');
    expect(html).toContain(language === "en" ? "Confirming does not authorize a purchase" : "Confirmarlo no autoriza una compra");
    expect(html).toContain(language === "en" ? "The adapter alone does not complete the setup" : "El adaptador solo no completa la configuración");
    expect(html).not.toContain('name="budgetDollars"');
  });
  it("hides the feature by default and before model confirmation", () => {
    expect(renderToStaticMarkup(<ChargerConversationControls csrfToken="csrf" language="en" track={track} />)).not.toContain('id="charger-budget"');
    expect(renderToStaticMarkup(<ChargerConversationControls budgetEnabled csrfToken="csrf" language="en" track={{ ...track, state: "candidate" }} />)).not.toContain('id="charger-budget"');
  });
  it("does not offer confirmation until an amount is proposed or after it is confirmed", () => {
    for (const budget of [undefined, { proposedCents: 5900, confirmedCents: 5900 }]) {
      expect(renderToStaticMarkup(<ChargerConversationControls budgetEnabled csrfToken="csrf" language="en" track={{ ...track, budget }} />)).not.toContain('name="action" value="confirm_budget"');
    }
  });
});

import { afterEach, vi } from "vitest";
import { chargerBudgetTestStoreRequested, createRuntime } from "@/server/runtime";
import { TEST_SESSION_KEY } from "./helpers";
afterEach(() => vi.unstubAllEnvs());
describe("budget opt-in configuration", () => {
  it.each([undefined, "", "0", "true", "yes", " 1", "1 "])("does not enable for %j", value => {
    vi.stubEnv("SHOPACCESS_CHARGER_BUDGET_TEST_STORE", value);
    expect(chargerBudgetTestStoreRequested()).toBe(false);
  });
  it("recognizes the exact token but cannot enable the memory runtime", () => {
    vi.stubEnv("SHOPACCESS_CHARGER_BUDGET_TEST_STORE", "1");
    expect(chargerBudgetTestStoreRequested()).toBe(true);
    expect(createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: new Set() }, { chargerBudgetTestStore: true }).chargerBudgetEnabled).toBe(false);
  });
});
