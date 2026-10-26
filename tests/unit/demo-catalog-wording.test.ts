import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { siteMetadata } from "@/lib/i18n/site-metadata";

// The demo catalog is not a PayPal Sandbox, whatever the payment mode, so catalog headings and page descriptions say
// "demo catalog" in English and Spanish (release copy follow-up to the provider-neutral wording).
const SANDBOX = /sandbox|entorno de pruebas/i;

describe("demo catalog wording", () => {
  it("describes the site and the catalog heading as a demo catalog, in English and Spanish", () => {
    expect(journeyCopy("en").catalogNoticeHeading).toBe("For evaluation");
    expect(journeyCopy("es").catalogNoticeHeading).toBe("Para evaluación");
    expect(siteMetadata("en")).toEqual({ title: "ShopAccess AI", description: "An inclusive laptop-shopping assistant demo with a demo catalog." });
    expect(siteMetadata("es")).toEqual({ title: "ShopAccess AI", description: "Una demostración de un asistente inclusivo para comprar portátiles, con un catálogo de demostración." });
    for (const language of ["en", "es"] as const) {
      expect(journeyCopy(language).catalogNoticeHeading).not.toMatch(SANDBOX);
      expect(siteMetadata(language).description).not.toMatch(SANDBOX);
    }
  });

  it("uses the shared wording in the layouts, the home heading and the shop listing", () => {
    const localized = readFileSync("src/app/[lang]/layout.tsx", "utf8");
    expect(localized).toMatch(/export async function generateMetadata/);
    expect(localized).toContain("siteMetadata(locale)");
    expect(readFileSync("src/app/(english)/layout.tsx", "utf8")).toContain('siteMetadata("en")');
    expect(readFileSync("src/app/(english)/page.tsx", "utf8")).toContain('journeyCopy("en").catalogNoticeHeading');
    expect(readFileSync("src/app/(english)/shop/shop-listing.tsx", "utf8")).toContain("Explore laptops");
    for (const file of ["src/app/[lang]/layout.tsx", "src/app/(english)/layout.tsx", "src/app/(english)/page.tsx", "src/app/(english)/shop/shop-listing.tsx"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/simulated sandbox|sandbox catalog|sandbox shopping/i);
    }
  });
});
