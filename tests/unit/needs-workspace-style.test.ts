import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NeedsConversation } from "@/components/mock-journey/NeedsConversation";
import { journeyCopy } from "@/lib/i18n/demo-copy";

const css = readFileSync("src/app/[lang]/shop/needs/needs-workspace.css", "utf8");
const needsPage = readFileSync("src/app/[lang]/shop/needs/page.tsx", "utf8");
const conversation = readFileSync("src/components/mock-journey/NeedsConversation.tsx", "utf8");

describe("needs workspace presentation", () => {
  it("applies only on the needs page and keeps every rule under .needs-workspace", () => {
    expect(needsPage).toContain('import "./needs-workspace.css"');
    expect(needsPage).toContain('className="guided-presentation needs-workspace"');
    expect(needsPage).not.toContain("use client");
    for (const file of [
      "src/app/(english)/page.tsx",
      "src/app/(english)/shop/page.tsx",
      "src/app/[lang]/shop/chargers/page.tsx",
      "src/app/[lang]/shop/profile/page.tsx",
      "src/app/[lang]/shop/permissions/page.tsx",
      "src/app/[lang]/checkout/[intentId]/page.tsx",
      "src/app/[lang]/extension/pair/page.tsx",
      "src/app/[lang]/demo/admission/page.tsx",
      "src/app/guided-presentation.css",
    ]) {
      expect(readFileSync(file, "utf8")).not.toContain("needs-workspace");
    }
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{/g);
    for (const match of selectors) {
      const block = match[1].trim();
      if (block.startsWith("@")) continue;
      for (const selector of block.split(",").map((item) => item.trim())) {
        expect(selector.startsWith(".needs-workspace"), selector).toBe(true);
        if (isComparisonSelector(selector)) expectComparisonAncestor(selector);
      }
    }
    const tableSelectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
      .flatMap((match) => match[1].trim().split(",").map((selector) => selector.trim()))
      .filter((selector) => /\btable\b|\bth\b|\btd\b/.test(selector));
    expect(tableSelectors.length).toBeGreaterThan(0);
    for (const selector of tableSelectors) expectComparisonAncestor(selector);
  });

  it("hosts the three official faces locally and does not add a font package or remote image", () => {
    expect(css).not.toMatch(/@import|unsplash|pexels|fontsource|fonts\.google|fonts\.gstatic/i);
    expect(needsPage).not.toContain("ShopProvider");
    expect(needsPage).not.toContain("LangProvider");
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1].replace(/["']/g, ""));
    expect(urls).toEqual([
      "./fonts/plus-jakarta-sans/PlusJakartaSans[wght].ttf",
      "./fonts/dm-sans/DMSans[opsz,wght].ttf",
      "./fonts/ibm-plex-mono/IBMPlexMono-Regular.ttf",
      "./fonts/ibm-plex-mono/IBMPlexMono-Bold.ttf",
    ]);
    for (const family of ["plus-jakarta-sans", "dm-sans", "ibm-plex-mono"]) {
      const dir = join("src/app/[lang]/shop/needs/fonts", family);
      const names = readdirSync(dir);
      expect(names).toContain("OFL.txt");
      expect(readFileSync(join(dir, "OFL.txt"), "utf8")).toContain("SIL Open Font License, Version 1.1");
      expect(names.some((name) => name.includes("Italic"))).toBe(false);
    }
  });

  it("keeps the focused skip link fixed and clear of the heading, and labels both speakers", () => {
    const focused = css.match(/\.needs-workspace \.skip-link:focus-visible\s*\{([^}]*)\}/);
    expect(focused?.[1]).toMatch(/position:\s*fixed/);
    expect(focused?.[1]).toMatch(/bottom:\s*1rem/);
    expect(focused?.[1]).toMatch(/top:\s*auto/);
    expect(focused?.[1]).not.toMatch(/position:\s*static/);
    const markup = renderToStaticMarkup(
      createElement(NeedsConversation, {
        copy: journeyCopy("en"),
        language: "en",
        csrfToken: "csrf-token",
        draft: {
          shopperText: "I need a laptop",
          prefilledUse: null,
          prefilledBudgetDollars: null,
          draftId: "nd_review",
          version: 1,
          notice: null,
        },
        mode: "reply",
        turns: [
          { role: "shopper", text: "I need a laptop" },
          { role: "assistant", text: "Which task should we work on?" },
        ],
      }),
    );
    expect(markup).toContain("needs-turn-shopper");
    expect(markup).toContain("needs-turn-assistant");
    expect(markup).toContain(">You<");
    expect(markup).toContain(">ShopAccess<");
    expect(conversation).toContain("copy.speakerShopper");
    expect(conversation).toContain("copy.speakerAssistant");
    expect(readFileSync("src/lib/i18n/demo-copy.ts", "utf8")).toContain('speakerShopper: "You"');
    expect(readFileSync("src/lib/i18n/demo-copy.ts", "utf8")).toContain('speakerShopper: "Usted"');
    expect(needsPage).toContain("needs-handoff");
    expect(needsPage).toContain("showScrollHint");
    expect(css).toContain(".needs-comparison-scroll");
    expect(css).toContain(".needs-config");
    const narrow = css.match(/@media \(max-width: 1023px\)\s*\{([\s\S]*)\}\s*$/);
    expect(narrow?.[1]).toMatch(/\.needs-config[\s\S]*position:\s*static/);
    expect(narrow?.[1]).not.toMatch(/\.needs-config[\s\S]*position:\s*sticky/);
  });

  it("darkens control borders and limits comparison chrome to the comparison wrapper", () => {
    expect(css).not.toContain("div:has(#charger-heading)");
    expect(css).toContain(".needs-workspace .needs-comparison {");
    expect(css).toContain(".needs-workspace .needs-layout:has(.needs-comparison) > .needs-comparison");
    const desktop = css.match(/@media \(min-width: 1024px\)\s*\{([\s\S]*)\}\s*@media \(max-width: 1023px\)/);
    expect(desktop?.[1]).toMatch(/\.needs-config[\s\S]*position:\s*sticky/);
    const border = css.match(/--needs-input:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(border).toBeTruthy();
    for (const surface of ["#ffffff", "#f5f6f8", "#fbfbfc"]) {
      expect(contrast(border!, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(readFileSync("src/components/ChargerInformation.tsx", "utf8")).toContain('className="needs-comparison flex flex-col gap-6"');
  });
});

function isComparisonSelector(selector: string): boolean {
  return /\btable\b|\bth\b|\btd\b|\.needs-(?:comparison|config|claim|figure|identifier|scroll-hint)/.test(selector);
}

function expectComparisonAncestor(selector: string): void {
  const wrapperIndex = selector.search(/\.needs-comparison(?![-\w])/);
  expect(wrapperIndex, `comparison selector is missing its wrapper ancestor: ${selector}`).toBeGreaterThanOrEqual(0);
  const cellOrTable = selector.search(/(?:^|\s)(?:table|th|td)(?=$|[\s:[.#])/);
  if (cellOrTable >= 0) expect(wrapperIndex, `table/cell target precedes wrapper: ${selector}`).toBeLessThan(cellOrTable);
  const classTarget = selector.search(/\.needs-(?:config|claim|figure|identifier|scroll-hint|comparison-scroll)(?![-\w])/);
  if (classTarget >= 0) expect(wrapperIndex, `comparison class precedes wrapper: ${selector}`).toBeLessThan(classTarget);
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channel = (value: number) => {
      const srgb = value / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };
    const red = channel(Number.parseInt(hex.slice(1, 3), 16));
    const green = channel(Number.parseInt(hex.slice(3, 5), 16));
    const blue = channel(Number.parseInt(hex.slice(5, 7), 16));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}
