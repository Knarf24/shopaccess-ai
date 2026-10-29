import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TranslatedAdvisory } from "@/components/mock-journey/TranslatedAdvisory";
import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { classifyAiWorkload, hasPotentialAiHint } from "@/lib/readiness/ai-workload";
import { resolveWorkloadFollowUp } from "@/lib/readiness/workload-follow-up";
import { updateWorkloadFromShopperTurn } from "@/lib/readiness/workload-record-update";
import { resolveConversationWorkload } from "@/lib/readiness/conversation-workload";
import type { ConversationState } from "@/lib/session/conversation";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import { openFoundationStore } from "@/lib/session/snapshot-store";
import { needsDraftsFor } from "@/lib/session/store";
import { workloadRecordForDraft } from "@/lib/session/workload-state";
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



const asConversation = (...texts: string[]): ConversationState => ({
  draftId: "d",
  interfaceLanguage: "en",
  turns: texts.map((text) => ({ role: "shopper" as const, text })),
});

describe("Stage 1.3: potential-AI wording keeps the disclosure and drops the unsupported badge", () => {
  it.each([
    "run deepseek r1 locally on my laptop",
    "phi-3 mini on my laptop",
    "I use LM Studio to chat with local models",
    "serving with vllm on my laptop",
    "building a langchain agent with local models",
    "quiero afinar modelos en mi portatil",
    "image generation locally with flux",
    "Run Claude Code and Gemini CLI locally",
    "I fine-tune models with LoRA",
    "QLoRA on my own machine",
    "I run ROCm workloads",
    "mlx on my Mac",
    "GPTQ quantized checkpoints",
    "I want local models",
    "open source models on my laptop",
    "I do text to image work",
    "I study artificial intelligence",
    "Estudio aprendizaje profundo",
  ])("an AI-ish request is never silently recommended: %s", async (text) => {
    const buyer = await memoryShopper();
    await buyer.submit(text);
    await buyer.confirm();
    const { journey, html } = await cards(buyer);
    for (const line of journey.lines) expect(line.aiContext, text).not.toBe(false);
    expect(html, text).not.toContain("recommendation-badge");
    expect(html, text).toContain("AI compatibility: not verified");
  });

  it.each([
    "I paint like Claude Monet and need a laptop for school",
    "I'm a Gemini and need a laptop for homework",
    "I clean with a rag",
    "Phi Kappa Theta meets on Fridays and I need a laptop for school",
    "I need open source software for school",
    "My friend recommended a flux capacitor repair guide",
  ])("ordinary requests are not flagged: %s", async (text) => {
    expect(hasPotentialAiHint(text), text).toBe(false);
    expect(["general_programming", null], text).toContain(classifyAiWorkload(text));
    const buyer = await memoryShopper();
    await buyer.submit(text);
    await buyer.confirm();
    const { journey, html } = await cards(buyer);
    for (const line of journey.lines) expect(line.aiContext, text).toBe(false);
    expect(html, text).toContain("recommendation-badge");
    expect(html, text).not.toMatch(/AI compatibility/);
  });

  it("bare AI model names still raise the conservative hint", async () => {
    for (const text of ["I want to try qwen", "a rag setup", "I want whisper"]) {
      expect(hasPotentialAiHint(text), text).toBe(true);
    }
    const buyer = await memoryShopper();
    await buyer.submit("I want to try qwen");
    await buyer.confirm();
    const { journey, html } = await cards(buyer);
    for (const line of journey.lines) expect(line.aiContext).toBe("potential");
    expect(html).not.toContain("recommendation-badge");
  });

  it("a refused AI request stays non-AI", () => {
    expect(hasPotentialAiHint("No AI, just coding for school")).toBe(false);
    expect(hasPotentialAiHint("I will not train AI models")).toBe(false);
  });
});

describe("Stage 1.3: explicit cloud-only versus tentative cloud", () => {
  it.each([
    "cloud, not local",
    "cloud not locally",
    "only cloud, never locally",
    "solo en la nube, no local",
    "nube, no en mi portátil",
    "cloud or whatever, cloud",
    "colab or sagemaker",
    "cloud only, or instead",
  ])("a genuine cloud-only statement switches to cloud: %s", (text) => {
    expect(resolveWorkloadFollowUp("local_inference", text)).toBe("cloud_ai");
    expect(resolveWorkloadFollowUp("local_training", text)).toBe("cloud_ai");
  });

  it.each(["I don't mind the cloud", "maybe the cloud too", "cloud works too", "could I use the cloud?", "quizas la nube"])(
    "a tentative cloud mention stays ambiguous: %s",
    (text) => {
      expect(resolveWorkloadFollowUp("local_inference", text)).toBe("unspecified_ai");
    },
  );

  it("a cloud-only shopper keeps the badge and the disclosure; an ambiguous one loses the badge", async () => {
    const cloud = await memoryShopper();
    await cloud.submit("I want to run AI models locally");
    await cloud.submit("cloud, not local");
    await cloud.confirm();
    const c = await cards(cloud);
    for (const line of c.journey.lines) expect(line.aiHardware.workload).toBe("cloud_ai");
    expect(c.html).toContain("recommendation-badge");
    expect(c.html).toContain("AI compatibility: not verified");
    const tentative = await memoryShopper();
    await tentative.submit("I want to run AI models locally");
    await tentative.submit("cloud works too");
    await tentative.confirm();
    const t = await cards(tentative);
    for (const line of t.journey.lines) expect(line.aiHardware.workload).toBe("unspecified_ai");
    expect(t.html).not.toContain("recommendation-badge");
  });
});

describe("Stage 1.3: the durable record and the conversation agree on pending training", () => {
  it.each([
    [["I want AI", "I will train models", "locally"]],
    [["I want AI", "I will train models", "I code in python", "locally"]],
    [["Quiero IA", "Voy a entrenar modelos", "en mi portátil"]],
  ])("%j resolves to local training either way", (texts) => {
    expect(kindAfter(...texts)).toBe("local_training");
    expect(resolveConversationWorkload(asConversation(...texts))).toBe("local_training");
  });

  it("without a training mention the two paths still agree on inference", () => {
    const texts = ["I want AI", "I code in python", "locally"];
    expect(kindAfter(...texts)).toBe("local_inference");
    expect(resolveConversationWorkload(asConversation(...texts))).toBe("local_inference");
  });
});
