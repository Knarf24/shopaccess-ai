import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChargerRecommendationLayout } from "@/components/mock-journey/ChargerRecommendationLayout";
import type { ChargerTrack } from "@/lib/session/charger-clarification";
const track: ChargerTrack = { sessionId: "s", draftId: "nd_" + "a".repeat(32), state: "confirmed", deviceId: "Mac14,2", revision: 12, budget: { proposedCents: 6000, confirmedCents: 6000 } };
const render = (language: "en" | "es", permitted = false) => renderToStaticMarkup(<ChargerRecommendationLayout language={language} csrfToken="csrf" track={track} permitted={permitted} headingId="guided-page-title" compatibility={<p>Compatibility evidence</p>} conversation={<form action="/shop/needs/submit"><textarea aria-label="Reply" /></form>} />);
it.each(["en", "es"] as const)("shows approved recommendation hierarchy in %s", language => {
 const html = render(language);
 expect(html.match(/<h1\b/g)).toHaveLength(1); expect(html).toContain('id="guided-page-title"');
 expect(html.match(/aria-current="step"/g)).toHaveLength(1);
 expect(html).toContain(language === "en" ? "Your recommended adapter" : "Su adaptador recomendado");
 expect(html).toContain("$60.00"); expect(html).toContain("$59.00");
 expect(html).toContain('name="action" value="change"'); expect(html).toContain('name="action" value="propose_budget"');
 expect(html).toContain('name="csrfToken" value="csrf"'); expect(html).toContain('name="revision" value="12"');
 expect(html).toContain('name="draftId" value="nd_' + "a".repeat(32) + '"');
 expect(html).not.toContain('name="action" value="confirm_budget"');
 expect(html).toContain('aria-describedby="charger-budget-hint"');
 expect(html).not.toMatch(/<details[^>]*\bopen/);
 expect(html).toContain("Compatibility evidence"); expect(html).toContain('action="/shop/needs/submit"');
 expect(html.indexOf('action="/shop/needs/submit"')).toBeGreaterThan(html.indexOf("charger-recommendation-title"));
 expect(html).not.toContain('action="/checkout/start"');
});
it("preserves the explicit permitted checkout form", () => {
 const html = render("en",true);
 expect(html).toContain('action="/checkout/start"'); expect(html).toContain('name="quantity" value="1"');
 expect(html).toContain("Review purchase");
});
