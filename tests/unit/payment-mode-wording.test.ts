import { describe, expect, it } from "vitest";
import { journeyCopy } from "@/lib/i18n/demo-copy";

// Shared wording is shown in mock and Sandbox mode alike, so it must not name a payment provider. PayPal Sandbox wording
// belongs only to the Sandbox checkout copy, which the checkout page renders in Sandbox mode (release copy correction).
const PROVIDER = /sandbox|paypal|entorno de pruebas/i;

describe("payment wording shared by mock and Sandbox mode", () => {
  for (const language of ["en", "es"] as const) {
    const copy = journeyCopy(language);
    const shared = {
      catalogNotice: copy.catalogNotice,
      taxValue: copy.confirmation.taxValue,
      explanation: copy.confirmation.explanation,
      taxNote: copy.checkoutPage.taxNote,
    };

    it(`${language}: names no payment provider`, () => {
      for (const [key, text] of Object.entries(shared)) expect(text, key).not.toMatch(PROVIDER);
    });

    it(`${language}: still says nothing is shipped and confirming takes no payment`, () => {
      expect(copy.catalogNotice).toMatch(language === "en" ? /no real money moves and nothing is shipped/ : /no se mueve dinero real y no hay entrega física/);
      expect(copy.confirmation.taxValue).toMatch(language === "en" ? /nothing is shipped/ : /no se envía nada/);
      expect(copy.checkoutPage.taxNote).toMatch(language === "en" ? /nothing is shipped/ : /no se envía nada/);
      expect(copy.confirmation.explanation).toMatch(language === "en" ? /^Confirming does not take payment\./ : /^Confirmar no cobra un pago\./);
    });
  }

  it("keeps PayPal Sandbox wording in the Sandbox checkout copy", () => {
    expect(journeyCopy("en").sandboxCheckout.heading).toBe("PayPal Sandbox checkout");
    expect(journeyCopy("es").sandboxCheckout.heading).toBe("Pago en el entorno de pruebas de PayPal");
  });
});
