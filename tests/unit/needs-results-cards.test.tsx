import { assessAiHardwareEvidence } from "@/lib/readiness/ai-hardware";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderWithAppRouter as renderToStaticMarkup } from "./router-render";
import { describe, expect, it, vi } from "vitest";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { TranslatedAdvisory } from "@/components/mock-journey/TranslatedAdvisory";
import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import { handleNeedsConfirm, handleNeedsSubmit, handleSessionStart } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import type { GuidedCatalogLine } from "@/server/shopping";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// Needs presentation slice (October 22, 2026): compact laptop result cards and a right-hand workspace panel. Only facts
// already in the server view are shown: the fixed demo price, the confirmed budget, the readiness status and factor
// outcomes. Memory mode, real in-memory runtime, local mock assistant; no store variables, no Channel3.
const ORIGIN = "https://shop.example.test";
const page = vi.hoisted(() => ({ runtime: null as unknown, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: page.cookie }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/server/runtime-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/runtime-access")>()),
  openApplication: async () => ({ mode: "mock", runtime: { ok: true, value: page.runtime } }),
}));
const { default: NeedsPage } = await import("@/app/[lang]/shop/needs/page");

async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function" && element.type.constructor.name === "AsyncFunction") {
    return resolveServer(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  if (element.props.children === undefined) return element;
  const children = element.props.children;
  const resolved = Array.isArray(children) ? await Promise.all(children.map(resolveServer)) : [await resolveServer(children)];
  return cloneElement(element, undefined, ...resolved);
}

const renderNeeds = async (pathLang: "en" | "es"): Promise<string> => {
  try {
    return renderToStaticMarkup(<Fragment>{await resolveServer(NeedsPage({ params: Promise.resolve({ lang: pathLang }), searchParams: Promise.resolve({}) }))}</Fragment>);
  } catch (error) {
    const url = isRedirectError(error) ? getURLFromRedirectError(error) : null;
    const next = url?.startsWith("/es/") ? "es" : url?.startsWith("/en/") ? "en" : null;
    if (!next || next === pathLang) throw error;
    return renderNeeds(next);
  }
};

const post = (path: string, fields: Record<string, string>) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: page.cookie },
    body: new URLSearchParams(fields).toString(),
  });

async function shopper(): Promise<{ runtime: Runtime; sessionId: string; csrfToken: string }> {
  const time = createTestClock("2026-10-22T12:00:00.000Z");
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
  page.runtime = runtime;
  const started = await handleSessionStart(new Request(`${ORIGIN}/session/start?use=schoolwork&budget=600`), runtime);
  const token = started.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  page.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { runtime, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

async function briefIn(lang: "en" | "es", budget: string, confirm: boolean) {
  const buyer = await shopper();
  await handleNeedsSubmit(post("/shop/needs/submit", { lang, shopperText: "", use: "schoolwork", budget, csrfToken: buyer.csrfToken }), buyer.runtime);
  const draft = needsDraftsFor(buyer.runtime.store).get(buyer.sessionId)!;
  if (confirm) {
    await handleNeedsConfirm(
      post("/shop/needs/confirm", { lang, draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget, csrfToken: buyer.csrfToken }),
      buyer.runtime,
    );
  }
  return buyer;
}

const line = (patch: Partial<GuidedCatalogLine> = {}): GuidedCatalogLine => ({
  aiHardware: assessAiHardwareEvidence("unspecified_ai", [], new Date("2026-10-22T12:00:00.000Z")),
  productId: "dmp_aspirego15",
  variantId: "dmv_aspirego15",
  title: "Acer Aspire Go 15",
  description: "A light laptop for notes, documents, browsing and video calls.",
  label: "8 GB LPDDR5, 256 GB PCIe NVMe SSD",
  unitAmountCents: 57999,
  currency: "USD",
  quotable: true,
  status: "READY",
  explanation: "The available evidence supports this laptop for your stated needs.",
  factors: [
    { factor: "memory", outcome: "PASS", reason: "memory-reason-pass", evidenceQuality: "VERIFIED", facts: [] },
    { factor: "portability", outcome: "PASS", reason: "portability-reason-pass", evidenceQuality: "VERIFIED", facts: [] },
  ],
  ...patch,
});

/** From one card's heading to the next card's heading, as the existing catalog tests slice it. */
function item(markup: string, variantId: string): string {
  const start = markup.indexOf(`id="catalog-${variantId}"`);
  expect(start).toBeGreaterThan(-1);
  const next = markup.indexOf('id="catalog-', start + 1);
  return markup.slice(start, next === -1 ? markup.length : next);
}

const amounts = (markup: string) => [...new Set(markup.replace(/<[^>]+>/g, " ").match(/\$[0-9][0-9,]*(?:\.[0-9]{2})?/g) ?? [])].sort();

const catalog = (language: "en" | "es", lines: GuidedCatalogLine[], excludedLines: GuidedCatalogLine[] = [], budget = "600") =>
  renderToStaticMarkup(
    <TranslatedCatalogList
      copy={journeyCopy(language)}
      language={language}
      csrfToken="csrf-token"
      lines={lines}
      excludedLines={excludedLines}
      confirmedUse="schoolwork"
      confirmedBudgetDollars={budget}
    />,
  );

describe("compact laptop result cards", () => {
  it("shows the server price, its difference from the confirmed budget, the suitability and each non-passing factor", () => {
    const copy = journeyCopy("en");
    const caveat = line({
      status: "READY_WITH_CAVEATS",
      factors: [
        { factor: "memory", outcome: "PASS", reason: "memory-reason-pass", evidenceQuality: "VERIFIED", facts: [] },
        { factor: "storage", outcome: "CAVEAT", reason: "storage-reason-caveat", evidenceQuality: "VERIFIED", facts: [] },
      ],
    });
    const card = item(catalog("en", [caveat]), "dmv_aspirego15");
    expect(card).toContain("$579.99");
    expect(card).toContain(copy.budgetUnder("$20.01", "$600"));
    expect(card).toContain(copy.status.READY_WITH_CAVEATS);
    expect(card).toMatch(new RegExp(`class="result-tradeoff"[^>]*>${copy.factors.storage}: ${copy.outcomes.CAVEAT}<`));
    expect(card).not.toMatch(new RegExp(`class="result-tradeoff"[^>]*>${copy.factors.memory}:`));
    expect(card).not.toContain(copy.meetsAllChecks);
    // Every reason stays available under "Why this?", collapsed by a native disclosure.
    const details = card.match(/<details[^>]*>[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(details).toContain(`<summary>${copy.whyThis}</summary>`);
    expect(details).toContain("memory-reason-pass");
    expect(details).toContain("storage-reason-caveat");
    // The purchase form is unchanged.
    const form = card.match(/<form\b[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    const open = form.match(/<form\b[^>]*>/)?.[0] ?? "";
    expect(open).toContain('action="/checkout/start"');
    expect(open).toContain('method="post"');
    expect([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2]])).toEqual([
      ["csrfToken", "csrf-token"],
      ["productId", "dmp_aspirego15"],
      ["variantId", "dmv_aspirego15"],
      ["quantity", "1"],
      ["use", "schoolwork"],
      ["budget", "600"],
      ["lang", "en"],
    ]);
    expect(form).toContain(">Review purchase<");
    expect(form).toContain('aria-labelledby="review-dmv_aspirego15 catalog-dmv_aspirego15"');
  });

  it("says every checked rule passed only when all factors pass, and invents no ranks, counts or charges", () => {
    const copy = journeyCopy("en");
    const markup = catalog("en", [line()]);
    const card = item(markup, "dmv_aspirego15");
    expect(card).toContain(copy.meetsAllChecks);
    expect(card).not.toContain('class="result-tradeoff"');
    expect(markup).not.toMatch(/best fit|rank|checks supported|check unknown|#1|recommended pick|tax and shipping included/i);
    expect(card).toContain("AI compatibility: not verified");
    expect(card).toContain('data-ai-compatibility="not_assessed"');
    expect(card).toContain("VRAM: not provided");
    expect(card).toContain("General readiness does not establish that it can run this workload.");
    expect(card).not.toMatch(/AI compatibility:\s*(?:verified|confirmed|supported|guaranteed)\b/i);
    // Only the server price, the difference, the confirmed budget and the existing $0.00 demonstration line appear.
    expect(amounts(card)).toEqual(["$0.00", "$20.01", "$579.99", "$600"].sort());
  });

  it("does not confuse general readiness with verified local AI training compatibility", () => {
    const trainingEvidence = assessAiHardwareEvidence(
      "local_training",
      [],
      new Date("2026-10-22T12:00:00.000Z"),
    );

    const card = item(
      catalog("en", [line({ status: "READY", aiHardware: trainingEvidence })]),
      "dmv_aspirego15",
    );

    expect(card).toContain('data-status="READY"');
    expect(card).toContain('data-ai-workload="local_training"');
    expect(card).toContain('data-ai-compatibility="not_assessed"');
    expect(card).toContain("AI compatibility: not verified");
    expect(card).toContain("local AI training");
    expect(card).toContain("RAM: not provided");
    expect(card).toContain("VRAM: not provided");
    expect(card).toContain("does not authorize a purchase");
    expect(card).not.toMatch(/AI compatibility:\s*(?:verified|confirmed|supported|guaranteed)\b/i);
  });

  it("states the difference at and over the budget, and keeps an excluded card free of purchase controls", () => {
    const copy = journeyCopy("en");
    const equal = item(catalog("en", [line({ unitAmountCents: 60000 })]), "dmv_aspirego15");
    expect(equal).toContain(copy.budgetEqual("$600"));
    const over = line({
      productId: "dmp_aspire14ai",
      variantId: "dmv_aspire14ai",
      title: "Acer Aspire 14 AI",
      unitAmountCents: 87999,
      quotable: true,
      status: "NOT_RECOMMENDED",
      factors: [{ factor: "affordability", outcome: "FAIL", reason: "affordability-reason-fail", evidenceQuality: "VERIFIED", facts: [] }],
    });
    const excluded = item(catalog("en", [], [over]), "dmv_aspire14ai");
    expect(excluded).toContain(copy.budgetOver("$279.99", "$600"));
    expect(excluded).toContain(copy.status.NOT_RECOMMENDED);
    expect(excluded).toMatch(new RegExp(`class="result-tradeoff"[^>]*>${copy.factors.affordability}: ${copy.outcomes.FAIL}<`));
    expect(excluded).toContain("affordability-reason-fail");
    expect(excluded).not.toContain("<form");
    expect(excluded).not.toContain("<button");
  });

  it("localizes the comparison in Spanish and keeps English catalog originals marked", () => {
    const copy = journeyCopy("es");
    const card = item(catalog("es", [line()]), "dmv_aspirego15");
    expect(card).toContain(copy.budgetUnder("$20.01", "$600"));
    expect(card).toContain(copy.meetsAllChecks);
    expect(card).toContain(copy.status.READY);
    expect(card).toContain('<span lang="en">Acer Aspire Go 15</span>');
    expect(card).toContain('<span lang="en">8 GB LPDDR5, 256 GB PCIe NVMe SSD</span>');
    expect(card).toContain('name="lang" value="es"');
    expect(card).toContain("Compatibilidad con IA: no verificada");
    expect(card).toContain("VRAM: no disponible");
    expect(card).toContain('data-ai-compatibility="not_assessed"');
    expect(copy.budgetUnder("$1", "$2")).not.toBe(journeyCopy("en").budgetUnder("$1", "$2"));
  });

  it("can show the recommendation status once without repeating each suggested item's factors", () => {
    const copy = journeyCopy("en");
    const recommendation = {
      assistantMessage: "These catalog items meet the stated use and budget.",
      recommendations: [{ productId: "dmp_aspirego15", variantId: "dmv_aspirego15", title: "Acer Aspire Go 15", unitAmountCents: 57999, currency: "USD" as const }],
    };
    const draft = { recommendationClaim: "completed" as const, recommendation };
    const compact = renderToStaticMarkup(<TranslatedAdvisory copy={copy} language="en" draft={draft} lines={[line()]} suggestionSource="mock" compact />);
    expect(compact).toContain('id="guided-advisory-heading"');
    expect(compact).toContain(copy.suggestionSourceMock);
    expect(compact).not.toContain("memory-reason-pass");
    expect(compact).not.toContain("$579.99");
    const full = renderToStaticMarkup(<TranslatedAdvisory copy={copy} language="en" draft={draft} lines={[line()]} suggestionSource="mock" />);
    expect(full).toContain("memory-reason-pass");
    expect(full).toContain("$579.99");
  });
});

describe("needs workspace panels", () => {
  for (const lang of ["en", "es"] as const) {
    it(`places the confirmed brief and results in the right panel once (${lang})`, async () => {
      const copy = journeyCopy(lang);
      await briefIn(lang, "600", true);
      const html = await renderNeeds(lang);
      const panel = html.match(/<div class="needs-results-panel"[\s\S]*$/)?.[0] ?? "";
      expect(panel).not.toBe("");
      expect(panel).toContain(copy.confirmedBrief(copy.uses.schoolwork, "$600"));
      expect(panel).toContain('id="guided-advisory-heading"');
      expect(panel).toContain('id="guided-catalog-heading"');
      expect(panel).toContain('action="/checkout/start"');
      expect(panel).toContain(`name="lang" value="${lang}"`);
      // Each card's reasons appear once on the page, not again under the suggestions heading.
      const reasonOccurrences = html.split("Why this?").length - 1 + (html.split("¿Por qué este?").length - 1);
      expect(reasonOccurrences).toBe((html.match(/id="catalog-/g) ?? []).length);
      // Small screens get a plain in-page link to the results; no script.
      const eligible = (panel.match(/class="result-card eligible-card"/g) ?? []).length;
      expect(html).toContain(`<a class="needs-results-jump" href="#guided-advisory-heading">${copy.resultsJump(eligible)}</a>`);
      // Existing routes and controls remain.
      expect(html).toMatch(new RegExp(`action="/${lang}/shop/chargers"`));
      expect(html).toContain(`href="/${lang}/shop/permissions"`);
    });
  }

  it("places the unconfirmed brief review in the right panel with its revision fields", async () => {
    const buyer = await briefIn("en", "600", false);
    const draft = needsDraftsFor(buyer.runtime.store).get(buyer.sessionId)!;
    const html = await renderNeeds("en");
    const panel = html.match(/<div class="needs-brief-panel">[\s\S]*?<\/form><\/div>/)?.[0] ?? "";
    expect(panel).toContain('action="/shop/needs/confirm"');
    expect(panel).toContain(`name="draftId" value="${draft.draftId}"`);
    expect(panel).toContain(`name="version" value="${draft.version}"`);
    expect(html).not.toContain("needs-results-panel");
    expect(html).not.toContain("needs-results-jump");
  });

  it("adds no client module and leaves FocusOnArrival and its pin unchanged", () => {
    for (const file of [
      "src/app/[lang]/shop/needs/page.tsx",
      "src/components/mock-journey/TranslatedCatalogList.tsx",
      "src/components/mock-journey/TranslatedAdvisory.tsx",
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/["']use client["']/);
    }
    const pins = readFileSync("tests/unit/sec01-pins.ts", "utf8");
    const focus = createHash("sha256").update(readFileSync("src/components/FocusOnArrival.tsx")).digest("hex");
    expect(pins).toContain(focus);
  });

  it("hides the in-page results link on wide screens and keeps the panels in the second column", () => {
    const css = readFileSync("src/app/[lang]/shop/needs/needs-workspace.css", "utf8");
    const wide = css.slice(css.indexOf("@media (min-width: 1024px)"));
    expect(wide).toMatch(/\.needs-workspace \.needs-results-jump\s*\{[^}]*display:\s*none/);
    expect(wide).toMatch(/\.needs-results-panel[^{]*\{[^}]*grid-column:\s*2/);
    expect(wide).toMatch(/\.needs-brief-panel[^{]*\{[^}]*grid-column:\s*2/);
  });
});
