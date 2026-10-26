import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/ui-refresh.css", "utf8");
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

const OPTED_IN: Record<string, string> = {
  "src/app/(english)/page.tsx": "src/app/(english)/page.tsx",
  "src/app/[lang]/demo/admission/page.tsx": "src/app/[lang]/demo/admission/admission-screen.tsx",
  "src/app/[lang]/shop/permissions/page.tsx": "src/app/[lang]/shop/permissions/page.tsx",
  "src/app/[lang]/checkout/[intentId]/page.tsx": "src/app/[lang]/checkout/[intentId]/page.tsx",
  "src/app/[lang]/shop/chargers/page.tsx": "src/app/[lang]/shop/chargers/page.tsx",
};

describe("ui refresh presentation", () => {
  it("applies only on the home, admission, permissions, checkout and charger information pages, and keeps every rule under .guided-presentation.ui-refresh", () => {
    for (const [page, markup] of Object.entries(OPTED_IN)) {
      expect(readFileSync(page, "utf8"), page).toMatch(/import "[./]+ui-refresh\.css";/);
      expect(readFileSync(markup, "utf8"), markup).toContain('className="guided-presentation ui-refresh"');
    }
    for (const file of [
      "src/app/(english)/shop/page.tsx",
      "src/app/[lang]/shop/profile/page.tsx",
      "src/app/[lang]/shop/needs/page.tsx",
      "src/app/[lang]/extension/pair/page.tsx",
      "src/app/guided-presentation.css",
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("ui-refresh");
    }
    for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
      const block = match[1].trim();
      if (block.startsWith("@")) continue;
      for (const selector of block.split(",").map((item) => item.trim())) {
        expect(selector.startsWith(".guided-presentation.ui-refresh"), selector).toBe(true);
      }
    }
  });

  it("uses the needs workspace's local font files and fetches nothing from elsewhere", () => {
    expect(css).not.toMatch(/@import|https?:|fontsource|fonts\.google|fonts\.gstatic/i);
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1].replace(/["']/g, ""));
    expect(urls).toEqual([
      "./[lang]/shop/needs/fonts/plus-jakarta-sans/PlusJakartaSans[wght].ttf",
      "./[lang]/shop/needs/fonts/dm-sans/DMSans[opsz,wght].ttf",
      "./[lang]/shop/needs/fonts/ibm-plex-mono/IBMPlexMono-Regular.ttf",
    ]);
    for (const url of urls) expect(existsSync(join("src/app", url)), url).toBe(true);
  });

  it("keeps a visible 3px focus ring and readable progress steps on narrow screens", () => {
    expect(withoutComments).toMatch(/\.guided-presentation\.ui-refresh :focus-visible,[^{]*\{[^}]*outline:\s*3px solid var\(--ui-brand\);[^}]*outline-offset:\s*2px;/);
    expect(withoutComments).toMatch(/--ui-brand:\s*#2457d6;/);
    expect(withoutComments).toMatch(/@media \(max-width: 639px\)\s*\{[^@]*\.journey-steps\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(withoutComments).toMatch(/@media \(max-width: 359px\)\s*\{[^@]*\.journey-steps\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  });

  it("styles simulation steps as secondary controls, not as the page's main action", () => {
    expect(withoutComments).toMatch(/button\[type="submit"\]\[name="step"\]:not\(:disabled\)\s*\{[^}]*background:\s*var\(--gp-paper\);[^}]*\}/);
  });
});
