import { describe, expect, it } from "vitest";

import { journeyCopy } from "@/lib/i18n/demo-copy";
import { checkoutMessage, messageFor } from "@/server/views";

// Finding 8, checkout part: every checkout text exists in both languages, and English is exactly today's wording.
describe("checkout copy parity", () => {
  it("both languages define every checkout page text, non-empty, with the same keys", () => {
    const en = journeyCopy("en").checkoutPage;
    const es = journeyCopy("es").checkoutPage;
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const copy of [en, es]) for (const [key, value] of Object.entries(copy)) if (typeof value === "string") expect(value.trim(), key).not.toBe("");
    expect(Object.keys(es.cancelReturn).sort()).toEqual(Object.keys(en.cancelReturn).sort());
    for (const copy of [en.cancelReturn, es.cancelReturn]) for (const [key, value] of Object.entries(copy)) expect(value.trim(), key).not.toBe("");
  });

  it("English checkout page text is today's wording", () => {
    const en = journeyCopy("en").checkoutPage;
    expect(en.heading).toBe("Review purchase");
    expect(en.quoteHeading).toBe("Quote");
    expect(en.missingItem).toBe("Item no longer in the catalog");
    expect(en.cancelReturn).toEqual({
      title: "Cancel checkout",
      heading: "Cancel this checkout",
      noCapture: "No payment has been captured.",
      capturedObserved: "A payment was captured for this checkout, and a refund, reversal or dispute was later observed.",
      notHere: "It can't be canceled here.",
      back: "Back to the checkout",
    });
  });

  it("checkout messages: English is messageFor unchanged; Spanish is a different, non-empty text marked Spanish", () => {
    const translated = [
      "CONFIRMED",
      "ACKNOWLEDGEMENT_REQUIRED",
      "CONFIRMATION_ALREADY_USED",
      "CONFIRMATION_SUPERSEDED",
      "CONFIRMATION_NOT_FOUND",
      "CONFIRMATION_EXPIRED",
      "CONFIRMATION_MISMATCH",
      "QUOTE_EXPIRED",
      "QUOTE_STALE_CATALOG",
      "QUOTE_NO_LONGER_VALID",
      "VARIANT_UNAVAILABLE",
      "QUANTITY_EXCEEDS_LIMIT",
      "CAPTURE_ALREADY_DISPATCHED",
      "NOT_CANCELABLE",
    ];
    for (const code of translated) {
      expect(checkoutMessage(code, "en"), code).toEqual({ text: messageFor(code), lang: "en" });
      const spanish = checkoutMessage(code, "es");
      expect(spanish?.lang, code).toBe("es");
      expect(spanish?.text.trim(), code).not.toBe("");
      expect(spanish?.text, code).not.toBe(messageFor(code));
    }
    // Simulation-only and PostgreSQL-only codes keep their English text and say so.
    for (const code of ["STEP_NOT_AVAILABLE", "CANCELED", "REVIEW_NOT_READY"]) expect(checkoutMessage(code, "es"), code).toEqual({ text: messageFor(code), lang: "en" });
    expect(checkoutMessage("NOT_A_REAL_CODE", "es")).toEqual({ text: "No se pudo completar esa acción.", lang: "es" });
    expect(checkoutMessage("NOT_A_REAL_CODE", "en")).toEqual({ text: "That action could not be completed.", lang: "en" });
    expect(checkoutMessage(undefined, "es")).toBeNull();
    // Codex finding 1: only the checkout's own keys are recognized; inherited Object.prototype names are unknown codes.
    for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(checkoutMessage(code, "en"), code).toEqual({ text: "That action could not be completed.", lang: "en" });
      expect(checkoutMessage(code, "es"), code).toEqual({ text: "No se pudo completar esa acción.", lang: "es" });
    }
  });
});
