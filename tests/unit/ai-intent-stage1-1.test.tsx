import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TranslatedAdvisory } from "@/components/mock-journey/TranslatedAdvisory";
import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { classifyAiWorkload } from "@/lib/readiness/ai-workload";
import { updateWorkloadFromShopperTurn } from "@/lib/readiness/workload-record-update";
import { workloadGuidance } from "@/lib/readiness/workload-guidance";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import { openFoundationStore } from "@/lib/session/snapshot-store";
import { needsDraftsFor } from "@/lib/session/store";
import { workloadRecordForDraft } from "@/lib/session/workload-state";
import { withAiCaveat } from "@/lib/voice/ai-caveat";
import { voiceOptionsSummary } from "@/lib/voice/journey";
import { handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { buildPgShoppingView } from "@/server/pg-views";
import { createMockAdvisoryAi } from "@/lib/providers/ai";
import { createRuntime, type Runtime } from "@/server/runtime";
import { loadNeedsJourney } from "@/server/shopping";
import type { PgServices } from "@/server/pg-runtime";
import { parsePreferences } from "@/server/shopping";
import { renderWithAppRouter } from "./router-render";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

const ORIGIN = "https://shop.example.test";
const config = { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) };

/** One shopper on a runtime (memory mode, or a format-7 snapshot gate), driven through the real handlers. */
async function shopperOn(runtime: Runtime, existingToken?: string) {
  vi.spyOn(runtime.ai, "interpretNeeds").mockResolvedValue({ understoodUse: "programming", budgetDollars: "900", followUp: null });
  let token = existingToken;
  if (!token) {
    const started = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
    token = started.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  }
  const resolved = await runtime.sessions.resolve(token);
  if (!resolved.ok) throw new Error("session did not resolve");
  const session = resolved.value;
  const post = (path: string, handler: typeof handleNeedsSubmit, fields: Record<string, string>) =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: new URLSearchParams({ lang: "en", csrfToken: session.csrfToken, ...fields }).toString(),
      }),
      runtime,
    );
  const draft = () => needsDraftsFor(runtime.store).get(session.id)!;
  return {
    runtime,
    session,
    token: token!,
    draft,
    record: () => workloadRecordForDraft(runtime.store, session.id, draft().draftId, draft().version),
    async submit(text: string) {
      const current = needsDraftsFor(runtime.store).get(session.id);
      const fields: Record<string, string> = { shopperText: text };
      if (current) Object.assign(fields, { draftId: current.draftId, version: String(current.version) });
      expect((await post("/shop/needs/submit", handleNeedsSubmit, fields)).status).toBe(303);
    },
    async confirm() {
      const current = draft();
      await post("/shop/needs/confirm", handleNeedsConfirm, { draftId: current.draftId, version: String(current.version), use: "programming", budget: "900" });
      expect(draft().confirmedUse).toBeTruthy();
    },
  };
}

const memoryShopper = () => shopperOn(createRuntime(config, { clock: createTestClock().clock }));
type Buyer = Awaited<ReturnType<typeof shopperOn>>;

/** What a shopper sees: the journey's real lines rendered as the eligible cards, with the mock's pick suggested. */
async function cards(buyer: Buyer, language: "en" | "es" = "en") {
  const journey = await loadNeedsJourney(buyer.runtime, buyer.session);
  expect(journey.lines.length).toBeGreaterThan(0);
  const html = renderWithAppRouter(
    <TranslatedCatalogList copy={journeyCopy(language)} language={language} csrfToken="csrf" lines={journey.lines} confirmedUse="programming" confirmedBudgetDollars="900" labelChoices suggestedVariantIds={["dmv_aspirego15"]} />,
  );
  return { journey, html };
}

const kindAfter = (...texts: string[]) => {
  let record = null as ReturnType<typeof updateWorkloadFromShopperTurn>;
  texts.forEach((text, index) => {
    record = updateWorkloadFromShopperTurn(record, text, "s", "nd_x", index + 1);
  });
  return record?.kind ?? null;
};

describe("Stage 1.1 A: positive local-AI intent is not lost to negation", () => {
  it.each([
    ["I don't want to train AI models on cloud, only locally.", "local_training"],
    ["I don't want to run AI models in the cloud, run them on my laptop.", "local_inference"],
    ["No need to run AI in the cloud, use my laptop.", "local_inference"],
    ["No quiero entrenar modelos de IA en la nube, solo en mi portátil.", "local_training"],
  ])("keeps the intent: %s", (text, kind) => {
    expect(classifyAiWorkload(text)).toBe(kind);
  });

  it.each([
    ["I want to run LLMs locally", "local_inference"],
    ["Quiero IA en mi portátil", "local_inference"],
    ["Run Llama 3 locally with Ollama", "local_inference"],
    ["Stable Diffusion on my laptop", "local_inference"],
    ["I want to fine-tune a model locally", "local_training"],
    ["I need A.I. models on my laptop", "local_inference"],
    ["I run ML models in the cloud", "cloud_ai"],
  ])("recognises AI requests: %s", (text, kind) => {
    expect(classifyAiWorkload(text)).toBe(kind);
  });

  it.each([
    ["I do not need to train models, only run LLMs on my laptop", "local_inference"],
    ["No necesito entrenar, solo ejecutar modelos de IA en mi portátil", "local_inference"],
  ])("a refused training step is not read as training: %s", (text, kind) => {
    expect(classifyAiWorkload(text)).toBe(kind);
  });

  it("a shopper who wants local AI sees the caveat and no unqualified badge, however it was phrased", async () => {
    for (const text of ["I don't want to train AI models on cloud, only locally.", "I want to run LLMs locally", "Run Llama 3 locally with Ollama"]) {
      const buyer = await memoryShopper();
      await buyer.submit(text);
      await buyer.confirm();
      const { journey, html } = await cards(buyer);
      for (const line of journey.lines) expect(line.aiContext, text).toBe(true);
      expect(html, text).not.toContain("recommendation-badge");
      expect(html, text).toContain("not verified for AI workloads");
      expect(html, text).toContain("AI compatibility: not verified");
    }
  });
});

describe("Stage 1.1 A: refused AI is recognised as non-AI", () => {
  it.each([
    "I'm not planning to do any AI.",
    "Not interested in AI.",
    "I won't be doing machine learning.",
    "I have no interest in AI.",
    "Please don't suggest AI laptops.",
    "No AI, just coding for school.",
    "I don't want to do any AI work.",
    "I will not train AI models.",
    "No pienso entrenar modelos de IA.",
  ])("the shopper sees no AI warning and keeps the normal badge: %s", async (text) => {
    expect(workloadGuidance(text, "en")).toBeNull();
    expect(workloadGuidance(text, "es")).toBeNull();
    const buyer = await memoryShopper();
    await buyer.submit(text);
    await buyer.confirm();
    const { journey, html } = await cards(buyer);
    for (const line of journey.lines) expect(line.aiContext, text).toBe(false);
    expect(html, text).not.toMatch(/AI compatibility|Compatibilidad con IA/);
    expect(html, text).toContain("recommendation-badge");
  });

  it("still treats 'I don't mind AI' as a request", () => {
    expect(classifyAiWorkload("I want AI, and I don't mind the cost")).toBe("unspecified_ai");
  });

  it("a later refusal retracts earlier AI; a refused location demotes local", () => {
    expect(kindAfter("I want to train AI models locally", "Actually, no AI")).toBe("general_programming");
    expect(kindAfter("Quiero entrenar modelos de IA localmente", "Sin IA")).toBe("general_programming");
    expect(kindAfter("I want to train AI models locally", "Not locally")).toBe("unspecified_ai");
  });
});

describe("Stage 1.1 B: uncertain AI evidence fails closed", () => {
  it("withholds the badge and keeps a warning when AI is likely but not classified", async () => {
    for (const language of ["en", "es"] as const) {
      const buyer = await memoryShopper();
      await buyer.submit("I want to run models with PyTorch on my GPU");
      await buyer.confirm();
      const { journey, html } = await cards(buyer, language);
      for (const line of journey.lines) expect(line.aiContext).toBe("potential");
      expect(html).not.toContain("recommendation-badge");
      expect(html).toContain(language === "en" ? "AI compatibility: not verified" : "Compatibilidad con IA: no verificada");
    }
  });

  it("a plain non-AI session keeps the badge and shows no AI warning, even after many turns", async () => {
    const buyer = await memoryShopper();
    await buyer.submit("I need a laptop for school");
    for (let i = 0; i < 9; i++) await buyer.submit(`Thank you ${i}`);
    await buyer.confirm();
    const { journey, html } = await cards(buyer);
    for (const line of journey.lines) expect(line.aiContext).toBe(false);
    expect(html).toContain("recommendation-badge");
    expect(html).not.toMatch(/AI compatibility/);
  });
});

describe("Stage 1.1 C: production snapshot format loses workload records on restart", () => {
  async function restartedFormat7(first: string, followUps: number) {
    const dir = fs.mkdtempSync(join(tmpdir(), "sa-s11-"));
    const reopened = fs.mkdtempSync(join(tmpdir(), "sa-s11-re-"));
    const key = Buffer.from("isolated-format7-stage11-key-0001");
    const stores: Array<{ close?: () => Promise<void> }> = [];
    try {
      for (const path of [dir, reopened]) fs.chmodSync(path, 0o700);
      const keyFile = join(dir, "identity.key");
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
      const time = createTestClock();
      const opened = await openFoundationStore(dir, key, { initializeEmpty: { keyFile } });
      if (opened.status !== "ready") throw new Error("store did not open");
      stores.push(opened.value);
      const recovered = await recoverStateGate(opened.value, time.clock());
      if (recovered.status !== "ready") throw new Error("state did not recover");
      const before = await shopperOn(createRuntime(config, { clock: time.clock, gate: recovered.gate }));
      await before.submit(first);
      for (let i = 0; i < followUps; i++) await before.submit(`Thank you, follow-up ${i + 1}`);
      await before.confirm();
      const inProcess = await cards(before);
      const published = opened.value.readPublished();
      if (published.status !== "ready") throw new Error("no snapshot");
      expect(published.value.format).toBe(7);

      fs.writeFileSync(join(reopened, "store.json"), fs.readFileSync(join(dir, "store.json")), { mode: 0o600 });
      const reopenedStore = await openFoundationStore(reopened, key, {});
      if (reopenedStore.status !== "ready") throw new Error("reopen failed");
      stores.push(reopenedStore.value);
      const after = await recoverStateGate(reopenedStore.value, time.clock());
      if (after.status !== "ready") throw new Error("recover after restart failed");
      const resumed = await shopperOn(createRuntime(config, { clock: time.clock, gate: after.gate }), before.token);
      return { inProcess, resumed, restarted: await cards(resumed) };
    } finally {
      for (const store of stores.reverse()) await store.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(reopened, { recursive: true, force: true });
    }
  }

  it("reproduces the loss: the format-7 snapshot keeps no workload record across a restart", { timeout: 60000 }, async () => {
    const { inProcess, resumed } = await restartedFormat7("I want to train AI models locally on my laptop", 9);
    expect(inProcess.journey.lines.every((line) => line.aiContext === true)).toBe(true);
    expect(resumed.record()).toBeNull();
  });

  it("after a restart with truncated history, local AI is not silently recommended", { timeout: 60000 }, async () => {
    const { restarted } = await restartedFormat7("I want to train AI models locally on my laptop", 9);
    for (const line of restarted.journey.lines) expect(line.aiContext).not.toBe(false);
    expect(restarted.html).not.toContain("recommendation-badge");
    expect(restarted.html).toContain("AI compatibility: not verified");
  });

  it("after a restart with intact history, the workload is recovered from the conversation", { timeout: 60000 }, async () => {
    const { restarted } = await restartedFormat7("I want to train AI models locally on my laptop", 0);
    for (const line of restarted.journey.lines) expect(line.aiContext).toBe(true);
    for (const line of restarted.journey.lines) expect(line.aiHardware.workload).toBe("local_training");
  });
});

describe("Stage 1.1 D: consistent presentation", () => {
  const pgServices = () =>
    ({
      catalog: async () => ({ ok: true, value: DEMO_MERCHANT_CATALOG }),
      clock: () => new Date("2026-10-22T12:00:00.000Z"),
      ai: createMockAdvisoryAi(),
      discovery: createRuntime(config).discovery,
    }) as unknown as PgServices;

  it("the Postgres shop view marks ordinary shoppers as having no AI context", async () => {
    const view = await buildPgShoppingView(pgServices(), parsePreferences("programming", "900")!);
    expect(view.kind).toBe("OK");
    if (view.kind !== "OK") return;
    expect(view.value.variants.length).toBeGreaterThan(0);
    for (const entry of view.value.variants) expect(entry.aiContext).toBe(false);
  });

  it("voice options say hardware compatibility is not verified, not merely omit 'Recommended'", () => {
    const option = (unverified: boolean, recommended: boolean, language: string) => ({
      productId: "p", variantId: "v", title: "Acer Aspire Go 15", priceCents: 57999,
      description: withAiCaveat("8 GB LPDDR5", unverified, language), recommended,
    });
    const en = voiceOptionsSummary([option(true, false, "en")], "en");
    expect(en).toContain("hardware compatibility for AI is not verified");
    expect(en).not.toContain("Recommended by the assistant");
    expect(voiceOptionsSummary([option(true, false, "es")], "es")).toContain("no se ha verificado la compatibilidad de hardware con IA");
    expect(voiceOptionsSummary([option(false, true, "en")], "en")).toContain("Recommended by the assistant");
    expect(voiceOptionsSummary([option(false, true, "en")], "en")).not.toContain("not verified");
  });

  it("the card label and the advisory text say general use only, not an AI match", async () => {
    const buyer = await memoryShopper();
    await buyer.submit("I want to run LLMs locally");
    await buyer.confirm();
    for (const language of ["en", "es"] as const) {
      const { journey, html } = await cards(buyer, language);
      expect(html).toContain(language === "en" ? "Matches your budget and general use; not verified for AI workloads" : "Cumple su presupuesto y uso general; no verificado para cargas de IA");
      expect(html).not.toContain("Matches your budget and use;");
      const advisory = renderWithAppRouter(
        <TranslatedAdvisory
          copy={journeyCopy(language)}
          language={language}
          draft={{ recommendationClaim: "completed", recommendation: { assistantMessage: "These catalog items meet the stated use and budget.", recommendations: [{ productId: "dmp_aspirego15", variantId: "dmv_aspirego15", title: "Acer Aspire Go 15", unitAmountCents: 57999, currency: "USD" }] } }}
          lines={journey.lines}
          eligibleVariantIds={["dmv_aspirego15"]}
          compact
        />,
      );
      expect(advisory).toContain(language === "en" ? "AI suitability has not been verified" : "no se ha verificado la idoneidad para IA");
    }
  });
});
