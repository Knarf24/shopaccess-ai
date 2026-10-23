import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/guided-presentation.css", "utf8");

/** The value of a `--gp-*` custom property on `.guided-presentation`, following one `var()` reference. */
function token(name: string): string {
  const value = css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  const reference = value.match(/^var\((--gp-[a-z-]+)\)$/)?.[1];
  return reference ? token(reference) : value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe("guided presentation focus indicator", () => {
  // Every background a 3px-offset outline can sit on in this stylesheet. The teal fill is inside buttons only.
  const backgrounds = ["--gp-cream", "--gp-paper", "--gp-teal-soft"].map(token).concat(["#ffffff", "#fff8e8", "#dbece6"]);

  it("contrasts at least 3:1 with every page and card background (WCAG 1.4.11)", () => {
    const focus = token("--gp-focus");
    for (const background of backgrounds) expect(contrast(focus, background), `${focus} on ${background}`).toBeGreaterThanOrEqual(3);
  });

  it("still draws both focus rules with the shared token", () => {
    expect(css).toMatch(/\.guided-presentation :focus-visible\s*\{\s*outline:\s*3px solid var\(--gp-focus\);\s*outline-offset:\s*3px;/);
    expect(css).toMatch(/\.guided-presentation \[tabindex="-1"\]:focus\s*\{\s*outline:\s*3px solid var\(--gp-focus\);\s*outline-offset:\s*3px;/);
  });
});
