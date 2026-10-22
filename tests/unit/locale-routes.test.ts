import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { legacyLocaleRedirect, localizedPage, savedLanguageRedirect } from "@/lib/i18n/locale-path";

describe("legacy localized page redirects", () => {
  it("sends one exact lang=es to the Spanish prefix and drops lang", () => {
    expect(legacyLocaleRedirect("GET", "/shop/needs", "?started=1&lang=es")).toBe("/es/shop/needs?started=1");
    expect(legacyLocaleRedirect("GET", "/shop/chargers", "?device=Mac14,2&lang=es&identifier=air")).toBe("/es/shop/chargers?device=Mac14%2C2&identifier=air");
    expect(legacyLocaleRedirect("HEAD", "/demo/admission", "?lang=es")).toBe("/es/demo/admission");
  });

  it("sends a missing, invalid, or repeated lang to the English prefix", () => {
    expect(legacyLocaleRedirect("GET", "/shop/needs", "")).toBe("/en/shop/needs");
    expect(legacyLocaleRedirect("GET", "/shop/permissions", "?lang=en&review=1")).toBe("/en/shop/permissions?review=1");
    expect(legacyLocaleRedirect("GET", "/shop/profile", "?lang=fr&result=saved")).toBe("/en/shop/profile?result=saved");
    expect(legacyLocaleRedirect("GET", "/extension/pair", "?lang=es&lang=en&pairing=abc")).toBe("/en/extension/pair?pairing=abc");
    expect(legacyLocaleRedirect("GET", "/checkout/ci_test", "?lang=ES&notice=CONFIRMED")).toBe("/en/checkout/ci_test?notice=CONFIRMED");
  });

  it("does not redirect route handlers, POSTs, or pages that are already outside the allowlist", () => {
    expect(legacyLocaleRedirect("POST", "/shop/needs", "?lang=es")).toBeNull();
    expect(legacyLocaleRedirect("POST", "/shop/needs/submit", "")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/shop/needs/submit", "?lang=es")).toBeNull();
    expect(legacyLocaleRedirect("POST", "/checkout/ci_test/confirm", "")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/checkout/ci_test/confirm", "")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/checkout/start", "?lang=es")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/session/needs", "?lang=es")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/api/extension/v1/conversation", "")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/en/shop/needs", "")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/fr/shop/needs", "")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/", "?lang=es")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/shop", "?lang=es")).toBeNull();
    expect(legacyLocaleRedirect("GET", "/checkouts", "")).toBeNull();
  });
});

describe("saved language canonical path", () => {
  it("redirects only after the saved language disagrees with the path, and keeps the other query", () => {
    expect(savedLanguageRedirect("en", "es", "/shop/needs", { started: "1", lang: "en", error: "STALE_DRAFT" })).toBe("/es/shop/needs?started=1&error=STALE_DRAFT");
    expect(savedLanguageRedirect("es", "en", "/checkout/ci_test", { notice: "CONFIRMED", lang: "es" })).toBe("/en/checkout/ci_test?notice=CONFIRMED");
    expect(savedLanguageRedirect("es", "es", "/shop/needs", { lang: "en" })).toBeNull();
    expect(savedLanguageRedirect("en", undefined, "/shop/chargers", { lang: "es", device: "Mac14,2" })).toBeNull();
    expect(savedLanguageRedirect("fr", "es", "/shop/needs", {})).toBeNull();
  });

  it("builds a prefixed page without a lang query", () => {
    expect(localizedPage("es", "/demo/admission", "notice=rejected")).toBe("/es/demo/admission?notice=rejected");
  });
});

describe("localized root layout", () => {
  it("rejects an unsupported segment instead of rendering it as English", () => {
    const source = readFileSync("src/app/[lang]/layout.tsx", "utf8");
    expect(source).toContain("if (!locale) notFound()");
    expect(source).toContain("lang={locale}");
    expect(source).not.toContain('locale ?? "en"');
    expect(source).not.toContain("data-locale-check");
    expect(source).not.toContain("unsupported-locale");
    expect(readFileSync("src/app/(english)/layout.tsx", "utf8")).toContain('<html lang="en"');
  });
});
