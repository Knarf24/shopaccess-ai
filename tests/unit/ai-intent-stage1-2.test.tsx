import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TranslatedAdvisory } from "@/components/mock-journey/TranslatedAdvisory";
import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { classifyAiWorkload } from "@/lib/readiness/ai-workload";
import { resolveWorkloadFollowUp } from "@/lib/readiness/workload-follow-up";
import { updateWorkloadFromShopperTurn } from "@/lib/readiness/workload-record-update";
import { readConversation } from "@/lib/session/conversation";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import { openFoundationStore } from "@/lib/session/snapshot-store";
import { needsDraftsFor } from "@/lib/session/store";
import { workloadRecordForDraft, workloadsUnrecovered } from "@/lib/session/workload-state";
import { handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { loadNeedsJourney } from "@/server/shopping";
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


type Ctx = boolean | "potential";
const html = async (buyer: Buyer) => (await cards(buyer)).html;

/** A format-7 production-style store, restarted once; the resumed shopper can keep talking. */
async function restarted(first: string, followUps: number, run: (resumed: Buyer, before: Buyer) => Promise<void>) {
  const dir = fs.mkdtempSync(join(tmpdir(), "sa-s12-"));
  const reopened = fs.mkdtempSync(join(tmpdir(), "sa-s12-re-"));
  const key = Buffer.from("isolated-format7-stage12-key-0001");
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
    fs.writeFileSync(join(reopened, "store.json"), fs.readFileSync(join(dir, "store.json")), { mode: 0o600 });
    const reopenedStore = await openFoundationStore(reopened, key, {});
    if (reopenedStore.status !== "ready") throw new Error("reopen failed");
    stores.push(reopenedStore.value);
    const after = await recoverStateGate(reopenedStore.value, time.clock());
    if (after.status !== "ready") throw new Error("recover after restart failed");
    const resumed = await shopperOn(createRuntime(config, { clock: time.clock, gate: after.gate }), before.token);
    await run(resumed, before);
  } finally {
    for (const store of stores.reverse()) await store.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reopened, { recursive: true, force: true });
  }
}

describe("Stage 1.2: unrecognised AI workloads are recognised", () => {
  it.each([
    ["run Mistral 7B on my laptop", "local_inference"],
    ["I'm building a RAG pipeline", "unspecified_ai"],
    ["I work with ggml and gguf files", "unspecified_ai"],
    ["I want to run Whisper locally", "local_inference"],
    ["ComfyUI on my laptop", "local_inference"],
    ["I want to generate embeddings locally", "local_inference"],
    ["run gemma 2 and qwen locally", "local_inference"],
    ["quantized models on my laptop", "local_inference"],
    ["corro modelos cuantizados", "unspecified_ai"],
    ["inferencia local de modelos", "local_inference"],
    ["I do deep-learning", "unspecified_ai"],
    ["stable-diffusion on my laptop", "local_inference"],
    ["run lamma 3 locally", "local_inference"],
    ["I'm not a fan of cloud AI so I run llama on my laptop", "local_inference"],
  ])("classifies %s", (text, kind) => {
    expect(classifyAiWorkload(text)).toBe(kind);
  });

  it("does not treat ordinary words as AI", () => {
    for (const text of ["I clean with a rag", "I need a laptop for school", "I record podcasts and whisper to my cat"]) {
      expect(["general_programming", null], text).toContain(classifyAiWorkload(text));
    }
  });

  it("a shopper with an unrecognised-before AI request is warned and gets no unqualified badge", async () => {
    for (const text of ["run Mistral 7B on my laptop", "I'm building a RAG pipeline", "run gemma 2 and qwen locally", "corro modelos cuantizados"]) {
      const buyer = await memoryShopper();
      await buyer.submit(text);
      await buyer.confirm();
      const { journey, html } = await cards(buyer);
      for (const line of journey.lines) expect(line.aiContext, text).toBe(true);
      expect(html, text).not.toContain("recommendation-badge");
      expect(html, text).toContain("AI compatibility: not verified");
    }
  });

  it("a programming remark does not erase an earlier AI request, and a later AI request is not hidden by programming", async () => {
    expect(kindAfter("I use Python", "I will run Mistral 7B on my laptop")).toBe("local_inference");
    expect(kindAfter("I want to train AI models locally", "I will use Python for it")).toBe("local_training");
    expect(kindAfter("I want to train AI models locally", "Actually, no AI, just coding")).toBe("general_programming");
    const buyer = await memoryShopper();
    await buyer.submit("I want to train AI models locally");
    await buyer.submit("I will use Python for it");
    await buyer.confirm();
    for (const line of (await cards(buyer)).journey.lines) expect(line.aiContext).toBe(true);
  });
});

describe("Stage 1.2: ambiguous local and cloud requests", () => {
  it("does not flip local intent to cloud on a bare mention", () => {
    expect(resolveWorkloadFollowUp("local_inference", "I don't mind the cloud")).toBe("unspecified_ai");
    expect(resolveWorkloadFollowUp("local_training", "Maybe the cloud too")).toBe("unspecified_ai");
  });

  it("still switches to cloud when the shopper says so", () => {
    expect(resolveWorkloadFollowUp("local_training", "I'll use Google Colab instead")).toBe("cloud_ai");
    expect(resolveWorkloadFollowUp("local_training", "Cloud only")).toBe("cloud_ai");
    expect(resolveWorkloadFollowUp("local_inference", "Actually, I will use cloud AI")).toBe("cloud_ai");
  });

  it("an ambiguous AI shopper gets no unqualified badge; a cloud-only shopper keeps it", async () => {
    const ambiguous = await memoryShopper();
    await ambiguous.submit("I want to run AI models locally");
    await ambiguous.submit("I don't mind the cloud");
    await ambiguous.confirm();
    const a = await cards(ambiguous);
    for (const line of a.journey.lines) expect(line.aiHardware.workload).toBe("unspecified_ai");
    expect(a.html).not.toContain("recommendation-badge");
    expect(a.html).toContain("AI compatibility: not verified");

    const cloudOnly = await memoryShopper();
    await cloudOnly.submit("I will use cloud AI services");
    await cloudOnly.confirm();
    const c = await cards(cloudOnly);
    for (const line of c.journey.lines) {
      expect(line.aiHardware.workload).toBe("cloud_ai");
      expect(line.aiContext).toBe(true);
    }
    expect(c.html).toContain("recommendation-badge");
    expect(c.html).toContain("AI compatibility: not verified");
  });

  it("the advisory list follows the same rule", async () => {
    const draft = (variantId: string) => ({
      recommendationClaim: "completed" as const,
      recommendation: { assistantMessage: "These catalog items meet the stated use and budget.", recommendations: [{ productId: "dmp_aspirego15", variantId, title: "Acer Aspire Go 15", unitAmountCents: 57999, currency: "USD" as const }] },
    });
    const render = (buyer: Buyer, lines: Awaited<ReturnType<typeof cards>>["journey"]["lines"]) =>
      renderWithAppRouter(<TranslatedAdvisory copy={journeyCopy("en")} language="en" draft={draft("dmv_aspirego15")} lines={lines} eligibleVariantIds={["dmv_aspirego15"]} />);
    const ambiguous = await memoryShopper();
    await ambiguous.submit("I'm building a RAG pipeline");
    await ambiguous.confirm();
    const withheld = render(ambiguous, (await cards(ambiguous)).journey.lines);
    expect(withheld).not.toContain("<p>Recommended</p>");
    expect(withheld).toContain("AI suitability has not been verified");
    const cloud = await memoryShopper();
    await cloud.submit("I will use cloud AI services");
    await cloud.confirm();
    const kept = render(cloud, (await cards(cloud)).journey.lines);
    expect(kept).toContain("<p>Recommended</p>");
    expect(kept).not.toContain("AI suitability has not been verified");
  });

  it("the voice option follows the same rule", async () => {
    const { voiceAiOption } = await import("@/lib/voice/ai-caveat");
    const ambiguous = await memoryShopper();
    await ambiguous.submit("I'm building a RAG pipeline");
    await ambiguous.confirm();
    const [line] = (await cards(ambiguous)).journey.lines;
    const spoken = voiceAiOption(line, true, "en");
    expect(spoken.recommended).toBe(false);
    expect(spoken.description).toContain("hardware compatibility for AI is not verified");
    const cloud = await memoryShopper();
    await cloud.submit("I will use cloud AI services");
    await cloud.confirm();
    const [cloudLine] = (await cards(cloud)).journey.lines;
    expect(voiceAiOption(cloudLine, true, "en").recommended).toBe(true);
    expect(voiceAiOption(cloudLine, false, "en").recommended).toBe(false);
  });

  it("non-AI sessions keep ordinary recommendations and no AI text", async () => {
    const buyer = await memoryShopper();
    await buyer.submit("I need a laptop for school");
    await buyer.confirm();
    const page = await html(buyer);
    expect(page).toContain("recommendation-badge");
    expect(page).not.toMatch(/AI compatibility/);
  });
});

describe("Stage 1.2: restart uncertainty (format-7 store)", () => {
  it("survives an unrelated programming turn after truncated AI history", { timeout: 120000 }, async () => {
    await restarted("I want to train AI models locally on my laptop", 9, async (resumed) => {
      await resumed.submit("I will use Python for scripts");
      await resumed.confirm();
      const { journey, html: page } = await cards(resumed);
      for (const line of journey.lines) expect(line.aiContext).not.toBe(false);
      expect(page).not.toContain("recommendation-badge");
      expect(page).toContain("AI compatibility: not verified");
    });
  });

  it("applies the warning exactly when the retained history may be truncated (eight turns)", { timeout: 240000 }, async () => {
    const seen: Array<{ turns: number; ctx: Ctx }> = [];
    for (const followUps of [0, 1, 2, 3, 4]) {
      await restarted("I need a laptop for school", followUps, async (resumed) => {
        const turns = readConversation(resumed.runtime.store, resumed.session.id)?.turns.length ?? 0;
        const { journey } = await cards(resumed);
        seen.push({ turns, ctx: journey.lines[0].aiContext as Ctx });
      });
    }
    expect(seen.some((entry) => entry.turns < 8)).toBe(true);
    expect(seen.some((entry) => entry.turns >= 8)).toBe(true);
    for (const entry of seen) expect(entry.ctx, JSON.stringify(entry)).toBe(entry.turns >= 8 ? "potential" : false);
  });

  it("scopes the marker to the restored store and drops it when the draft goes", { timeout: 120000 }, async () => {
    await restarted("I need a laptop for school", 0, async (resumed) => {
      const draftId = resumed.draft().draftId;
      expect(workloadsUnrecovered(resumed.runtime.store, draftId)).toBe(true);
      const other = createRuntime(config, { clock: createTestClock().clock });
      expect(workloadsUnrecovered(other.store, draftId)).toBe(false);
      await resumed.runtime.durable.change((host) => {
        needsDraftsFor(host).delete(resumed.session.id);
      });
      expect(workloadsUnrecovered(resumed.runtime.store, draftId)).toBe(false);
    });
  });
});
