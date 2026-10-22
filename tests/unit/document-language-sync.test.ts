import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type LanguageRoot = { lang: string };
type SyncLanguage = (root: LanguageRoot, language: "en" | "es") => () => void;

const syncLanguage = (await import("@/components/mock-journey/ListingSearchForm") as unknown as {
  syncDocumentLanguage?: SyncLanguage;
}).syncDocumentLanguage;

describe("document language synchronization", () => {
  it("uses the resolved journey language and restores the English shell when the localized route unmounts", () => {
    expect(syncLanguage).toBeTypeOf("function");
    const root = { lang: "en" };
    const restore = syncLanguage!(root, "es");
    expect(root.lang).toBe("es");

    restore();
    expect(root.lang).toBe("en");
  });

  it("does not let stale cleanup overwrite a newer route language", () => {
    const root = { lang: "en" };
    const restoreOldRoute = syncLanguage!(root, "es");
    root.lang = "en";
    restoreOldRoute();
    expect(root.lang).toBe("en");
  });

  it("mounts the synchronizer on routes using their existing resolved language", () => {
    const routes = [
      "src/app/[lang]/shop/needs/page.tsx",
      "src/app/[lang]/shop/needs/current-step.tsx",
      "src/app/[lang]/shop/chargers/page.tsx",
      "src/app/[lang]/shop/permissions/page.tsx",
      "src/app/[lang]/shop/profile/page.tsx",
      "src/app/[lang]/checkout/[intentId]/page.tsx",
      "src/app/[lang]/extension/pair/page.tsx",
      "src/app/[lang]/demo/admission/admission-screen.tsx",
    ];

    for (const route of routes) {
      const source = readFileSync(route, "utf8");
      expect(source, route).toContain("DocumentLanguageSync");
      expect(source, route).toMatch(/<DocumentLanguageSync\s+language=\{language\}\s*\/>/);
    }
    const clientSource = readFileSync("src/components/mock-journey/ListingSearchForm.tsx", "utf8");
    expect(clientSource).toMatch(/useLayoutEffect\(\(\) => syncDocumentLanguage\(document\.documentElement, language\), \[language\]\)/);
    expect(readFileSync("src/app/(english)/layout.tsx", "utf8")).toContain('<html lang="en"');
    const localized = readFileSync("src/app/[lang]/layout.tsx", "utf8");
    expect(localized).toContain("if (!locale) notFound()");
    expect(localized).toContain("lang={locale}");
  });
});
