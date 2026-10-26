import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NeedsConversation } from "@/components/mock-journey/NeedsConversation";
import { recommendationSentence, journeyCopy } from "@/lib/i18n/demo-copy";
import { chargerRecommendationCopy } from "@/lib/i18n/charger-recommendation-copy";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { MerchantProductCard } from "@/components/MerchantProductCard";
import { SimulatedPaymentPanel } from "@/components/SimulatedPaymentPanel";
it("keeps the evaluation disclosure once outside uncluttered product cards and changes no catalog state", () => {
 expect(DEMO_MERCHANT_CATALOG.revision).toBe(2);
 expect(DEMO_MERCHANT_CATALOG.merchant.displayName).toBe("ShopAccess Demo Store (simulated)");
 for (const product of DEMO_MERCHANT_CATALOG.products) {
  const html = renderToStaticMarkup(<MerchantProductCard product={product} merchantName={DEMO_MERCHANT_CATALOG.merchant.displayName} />);
  expect(html).not.toContain("simulated"); expect(html).not.toContain("Fixed demo price");
  expect(html).not.toContain("Sold by"); expect(html).toContain(product.title);
 }
});
it.each(["en", "es"] as const)("retains reference-price, no-charge and no-shipment disclosures in %s", language => {
 const copy=journeyCopy(language); const charger=chargerRecommendationCopy(language);
 expect(copy.catalogNotice).toMatch(language === "en" ? /no real money moves and nothing is shipped/ : /no se mueve dinero real y no hay entrega física/);
 expect(copy.catalogNotice).toMatch(language === "en" ? /reference data, not live offers/ : /datos de referencia, no ofertas en vivo/);
 expect(charger.footnote).toMatch(language === "en" ? /no money is charged and no products are shipped/ : /no se cobra dinero ni se envían productos/);
 expect(copy.sandboxCheckout.heading).toContain(language === "en" ? "PayPal Sandbox" : "PayPal");
});
it("labels the local mock accurately and does not rename its action route or state", () => {
 const html=renderToStaticMarkup(<SimulatedPaymentPanel csrfToken="csrf" view={{ intentId:"test",state:"CAPTURED_VERIFIED",quote:null,itemTitle:"Adapter",merchantName:"Demo",challenge:null,challengeProblem:null,permissionRefusal:null,steps:["external_refund"],transitions:[],observations:[],operations:[],interfaceLanguage:"en" }} />);
 expect(html).toContain("Local payment preview"); expect(html).toContain("does not contact PayPal");
 expect(html).toContain("no money will be charged and no products will ship"); expect(html).toContain("CAPTURED_VERIFIED");
 expect(html).toContain('action="/checkout/test/simulate"'); expect(html).toContain('name="csrfToken" value="csrf"');
});

it.each(["en", "es"] as const)("maps the unchanged server recommendation sentences to new customer text in %s", language => {
 const copy=journeyCopy(language);
 expect(recommendationSentence(language,"These catalog items meet the stated use and budget.")).toBe(copy.suitable);
 expect(recommendationSentence(language,"No catalog item meets this use and budget.")).toBe(copy.noCatalog);
 expect(recommendationSentence(language,"No suggestion matched a catalog item that meets this use and budget.")).toBe(copy.noSuggestion);
 expect(recommendationSentence(language,"untrusted model prose")).toBeNull();
});
it.each(["en", "es"] as const)("gives charger replies a contextual label in %s", language => {
 const html=renderToStaticMarkup(<NeedsConversation copy={journeyCopy(language)} language={language} csrfToken="csrf" draft={null} mode="first" chargerClarification />);
 expect(html).toContain(language === "en" ? "Send reply" : "Enviar respuesta");
 expect(html).not.toContain(journeyCopy(language).submit);
});
