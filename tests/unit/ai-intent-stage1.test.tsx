import { describe, expect, it, vi } from "vitest";

import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { assessAiHardwareEvidence } from "@/lib/readiness/ai-hardware";
import { classifyAiWorkload } from "@/lib/readiness/ai-workload";
import { updateWorkloadFromShopperTurn } from "@/lib/readiness/workload-record-update";
import { workloadGuidance } from "@/lib/readiness/workload-guidance";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import { replaceWorkloadRecords, workloadRecordForDraft } from "@/lib/session/workload-state";
import { handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime } from "@/server/runtime";
import { buildShoppingView, loadNeedsJourney, parsePreferences, type GuidedCatalogLine } from "@/server/shopping";
import { renderWithAppRouter } from "./router-render";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";
const ORIGIN = "https://shop.example.test";

type Understood = { understoodUse: "programming" | "schoolwork"; budgetDollars: string; followUp: null };
const PROGRAMMING: Understood = { understoodUse: "programming", budgetDollars: "900", followUp: null };

/** A mock-mode runtime, one shopper session, and helpers that drive the real HTTP handlers. */
async function shopper() {
  const time = createTestClock();
  const runtime = createRuntime(
    { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) },
    { clock: time.clock },
  );
  const interpret = vi.spyOn(runtime.ai, "interpretNeeds").mockResolvedValue(PROGRAMMING);

  const started = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
  const token = started.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const resolved = await runtime.sessions.resolve(token);
  if (!resolved.ok) throw new Error("session did not resolve");
  const session = resolved.value;
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;

  const post = (path: string, handler: typeof handleNeedsSubmit, fields: Record<string, string>) =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie },
        body: new URLSearchParams({ lang: "en", csrfToken: session.csrfToken, ...fields }).toString(),
      }),
      runtime,
    );

  const draft = () => needsDraftsFor(runtime.store).get(session.id)!;
  const record = () => {
    const current = needsDraftsFor(runtime.store).get(session.id);
    return current ? workloadRecordForDraft(runtime.store, session.id, current.draftId, current.version) : null;
  };

  return {
    runtime,
    session,
    interpret,
    draft,
    record,
    async submit(shopperText: string, extra: Record<string, string> = {}) {
      const current = needsDraftsFor(runtime.store).get(session.id);
      const fields: Record<string, string> = { shopperText, ...extra };
      if (current) {
        fields.draftId = current.draftId;
        fields.version = String(current.version);
      }
      const response = await post("/shop/needs/submit", handleNeedsSubmit, fields);
      expect(response.status).toBe(303);
    },
    async confirm() {
      const current = draft();
      const response = await post("/shop/needs/confirm", handleNeedsConfirm, {
        draftId: current.draftId,
        version: String(current.version),
        use: current.prefilledUse ?? "programming",
        budget: current.prefilledBudgetDollars ?? "900",
      });
      expect(response.status).toBe(303);
      expect(draft().confirmedUse).toBeTruthy();
    },
    /** A session from before workload records existed: the conversation is kept, the record is not. */
    makeLegacy() {
      replaceWorkloadRecords(runtime.store, new Map());
      expect(record()).toBeNull();
    },
  };
}


const NOW = new Date("2026-10-22T12:00:00.000Z");
const seq = (...texts: string[]) => {
  let record = null as ReturnType<typeof updateWorkloadFromShopperTurn>;
  texts.forEach((text, index) => {
    record = updateWorkloadFromShopperTurn(record, text, "s", "nd_x", index + 1);
  });
  return record;
};

describe("Stage 1: AI-intent negation", () => {
  it.each([
    "No AI, just coding for school.",
    "I don't want to do any AI work.",
    "I will not train AI models.",
    "Sin IA, solo programar para la escuela.",
    "No quiero usar IA.",
    "No voy a entrenar modelos de IA.",
  ])("treats a negated AI request as no AI workload: %s", (text) => {
    expect(["general_programming", null]).toContain(classifyAiWorkload(text));
    expect(workloadGuidance(text, "en")).toBeNull();
    expect(workloadGuidance(text, "es")).toBeNull();
  });

  it("keeps positive AI requests", () => {
    expect(classifyAiWorkload("I want to train AI models locally")).toBe("local_training");
    expect(classifyAiWorkload("Quiero entrenar modelos de IA en mi portátil")).toBe("local_training");
    expect(classifyAiWorkload("I want to work with AI models")).toBe("unspecified_ai");
    expect(classifyAiWorkload("I want AI, and I don't mind the cost")).toBe("unspecified_ai");
  });

  it("does not turn a refused location into local training", () => {
    expect(classifyAiWorkload("I want to train AI models, not on my laptop")).toBe("unspecified_ai");
    expect(seq("I want to train AI models", "Not on my laptop")?.kind).toBe("unspecified_ai");
    expect(seq("Quiero entrenar modelos de IA", "No en mi portátil")?.kind).toBe("unspecified_ai");
  });

  it("still completes training when the location is affirmed", () => {
    expect(seq("I want to train AI models", "On my laptop")?.kind).toBe("local_training");
    expect(seq("Quiero entrenar modelos de IA", "En mi portátil")?.kind).toBe("local_training");
  });
});

describe("Stage 1: recommendation badge for local AI", () => {
  const vramEvidence = [{ fact: "vramGb" as const, value: 8, source: "merchant_catalog" as const, sourceRef: "test", observedAt: NOW.toISOString() }];
  const line = (workload: Parameters<typeof assessAiHardwareEvidence>[0], extra: Partial<GuidedCatalogLine> = {}, evidence: Parameters<typeof assessAiHardwareEvidence>[1] = []): GuidedCatalogLine => ({
    aiHardware: assessAiHardwareEvidence(workload, evidence, NOW),
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
    factors: [{ factor: "memory", outcome: "PASS", reason: "memory-reason-pass", evidenceQuality: "VERIFIED", facts: [] }],
    ...extra,
  });
  const render = (language: "en" | "es", lines: GuidedCatalogLine[], excluded: GuidedCatalogLine[] = []) =>
    renderWithAppRouter(
      <TranslatedCatalogList copy={journeyCopy(language)} language={language} csrfToken="csrf" lines={lines} excludedLines={excluded} confirmedUse="programming" confirmedBudgetDollars="900" labelChoices suggestedVariantIds={["dmv_aspirego15"]} />,
    );

  it.each(["local_training", "local_inference"] as const)("withholds the unqualified badge for %s without GPU/VRAM evidence", (workload) => {
    const en = render("en", [line(workload)]);
    expect(en).not.toContain("recommendation-badge");
    expect(en).not.toMatch(/>Recommended</);
    expect(en).toContain("not verified for AI workloads");
    expect(en).toContain("AI compatibility: not verified");
    expect(en).toContain("GPU and VRAM evidence is missing");
    expect(en).not.toMatch(/will not run|cannot run|incompatible/i);
    const es = render("es", [line(workload)]);
    expect(es).not.toContain("recommendation-badge");
    expect(es).not.toMatch(/>Recomendado</);
    expect(es).toContain("no verificado para cargas de IA");
    expect(es).toContain("Faltan datos de GPU y VRAM");
  });

  it("keeps the badge when the workload does not need that evidence", () => {
    for (const workload of ["cloud_ai", "unspecified_ai", "general_programming"] as const) {
      const html = render("en", [line(workload)]);
      expect(html, workload).toContain("recommendation-badge");
      expect(html, workload).toContain("Recommended");
    }
  });

  it("keeps the badge for local AI when verified VRAM evidence exists", () => {
    const html = render("en", [line("local_training", {}, vramEvidence)]);
    expect(html).toContain("recommendation-badge");
  });

  it("hides AI disclosures when the session has no AI context, and keeps them otherwise", () => {
    for (const language of ["en", "es"] as const) {
      const none = render(language, [line("unspecified_ai", { aiContext: false })], [line("unspecified_ai", { aiContext: false, variantId: "dmv_x" })]);
      expect(none).not.toMatch(/AI compatibility|Compatibilidad con IA/);
      expect(none).not.toContain("data-ai-compatibility");
      const withContext = render(language, [line("unspecified_ai", { aiContext: true })]);
      expect(withContext).toContain("data-ai-compatibility");
      const unspecifiedField = render(language, [line("unspecified_ai")]);
      expect(unspecifiedField).toContain("data-ai-compatibility");
    }
  });
});

describe("Stage 1: server view marks AI context", () => {
  it("is false for non-AI and negated sessions, true for AI sessions", async () => {
    for (const [text, expected] of [
      ["I need a laptop for school", false],
      ["No AI, just coding for school.", false],
      ["I will not train AI models.", false],
      ["I want to train AI models locally", true],
      ["I want to work with AI models", true],
    ] as const) {
      const buyer = await shopper();
      await buyer.submit(text);
      await buyer.confirm();
      const journey = await loadNeedsJourney(buyer.runtime, buyer.session);
      expect(journey.lines.length, text).toBeGreaterThan(0);
      for (const entry of journey.lines) expect(entry.aiContext, text).toBe(expected);
    }
  });

  it("marks the legacy shop view only when a workload is supplied", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
    const preferences = parsePreferences("programming", "900")!;
    const plain = await buildShoppingView(runtime, preferences, "s1");
    for (const entry of plain.variants) expect((entry as { aiContext?: boolean }).aiContext).toBe(false);
    const cloud = await buildShoppingView(runtime, preferences, "s1", "cloud_ai");
    for (const entry of cloud.variants) expect((entry as { aiContext?: boolean }).aiContext).toBe(true);
  });

  it("records no workload for a negated AI session and an unspecified record for a refused location", async () => {
    const negated = await shopper();
    await negated.submit("I will not train AI models.");
    expect(negated.record()).toBeNull();
    const refused = await shopper();
    await refused.submit("I want to train AI models");
    await refused.submit("Not on my laptop");
    expect(refused.record()?.kind).toBe("unspecified_ai");
  });
});
