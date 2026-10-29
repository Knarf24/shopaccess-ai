import { describe, expect, it, vi } from "vitest";

import { chargerTrackFor, setChargerTrack } from "../../src/lib/session/charger-clarification";
import { SESSION_COOKIE_NAME } from "../../src/lib/session/cookie";
import { purchaseSelectionsOpen, type ConversationState } from "../../src/lib/session/conversation";
import { parseTrustedOrigins } from "../../src/lib/session/request-guard";
import { needsDraftsFor } from "../../src/lib/session/store";
import { replaceWorkloadRecords, setWorkloadRecord, workloadRecordForDraft } from "../../src/lib/session/workload-state";
import { resolveConversationWorkload } from "../../src/lib/readiness/conversation-workload";
import { handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "../../src/server/handlers";
import { createRuntime } from "../../src/server/runtime";
import { loadNeedsJourney } from "../../src/server/shopping";
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

describe("Fix A: legacy workload evidence recovery", () => {
  it("does not turn an ambiguous AI request into local training", async () => {
    const buyer = await shopper();
    await buyer.submit("I want to work with AI models");
    buyer.makeLegacy();
    await buyer.submit("On my laptop");
    expect(buyer.record()?.kind).toBe("local_inference");
  });

  it("keeps genuine training intent: train, then on my laptop", async () => {
    const buyer = await shopper();
    await buyer.submit("I want to train AI models");
    buyer.makeLegacy();
    await buyer.submit("On my laptop");
    expect(buyer.record()?.kind).toBe("local_training");
  });

  it("keeps explicit local training: train locally, then on my laptop", async () => {
    const buyer = await shopper();
    await buyer.submit("I want to train AI models locally");
    buyer.makeLegacy();
    await buyer.submit("On my laptop");
    expect(buyer.record()?.kind).toBe("local_training");
  });

  it("invents no AI requirement when the session had no AI context", async () => {
    const buyer = await shopper();
    await buyer.submit("I need a laptop for school");
    buyer.makeLegacy();
    await buyer.submit("On my laptop");
    expect(buyer.record()).toBeNull();
  });

  it("does not withdraw a confirmation or close purchase selections for a non-AI reply", async () => {
    const buyer = await shopper();
    await buyer.submit("I need a laptop for school");
    await buyer.confirm();
    buyer.makeLegacy();
    await buyer.submit("On my laptop");
    expect(buyer.draft().confirmedUse).toBe("programming");
    expect(purchaseSelectionsOpen(buyer.runtime.store, buyer.session.id)).toBe(true);
  });

  it("still withdraws when the reply genuinely changes the workload", async () => {
    const buyer = await shopper();
    await buyer.submit("I want to work with AI models");
    await buyer.confirm();
    buyer.makeLegacy();
    await buyer.submit("On my laptop");
    expect(buyer.record()?.kind).toBe("local_inference");
    expect(buyer.draft().confirmedUse).toBeFalsy();
    expect(purchaseSelectionsOpen(buyer.runtime.store, buyer.session.id)).toBe(false);
  });
});

describe("Fix B: shopping results follow the durable workload record", () => {
  async function truncated() {
    const buyer = await shopper();
    await buyer.submit("I want to train AI models locally on my laptop");
    for (let i = 0; i < 9; i++) await buyer.submit(`Thank you, follow-up ${i + 1}`);
    await buyer.confirm();
    return buyer;
  }

  it("keeps result-card workload after the conversation is truncated", async () => {
    const buyer = await truncated();
    expect(buyer.record()?.kind).toBe("local_training");
    const journey = await loadNeedsJourney(buyer.runtime, buyer.session);
    expect(journey.conversation?.turns.some((turn) => turn.text.includes("train AI models"))).toBe(false);
    expect(journey.lines.length).toBeGreaterThan(0);
    for (const line of journey.lines) expect(line.aiHardware.workload).toBe("local_training");
  });

  it("falls back to the conversation when there is no durable record", async () => {
    const buyer = await shopper();
    await buyer.submit("I want to train AI models locally on my laptop");
    await buyer.confirm();
    buyer.makeLegacy();
    const journey = await loadNeedsJourney(buyer.runtime, buyer.session);
    for (const line of journey.lines) expect(line.aiHardware.workload).toBe("local_training");
  });

  it("ignores a record for another draft or from a future draft version", async () => {
    const buyer = await shopper();
    await buyer.submit("I need a laptop for school");
    await buyer.confirm();
    const current = buyer.draft();
    const base = { sessionId: buyer.session.id, kind: "local_training" as const, evidenceState: "explicit" as const };

    setWorkloadRecord(buyer.runtime.store, { ...base, draftId: `nd_${"0".repeat(32)}`, sourceDraftVersion: 1 });
    let journey = await loadNeedsJourney(buyer.runtime, buyer.session);
    for (const line of journey.lines) expect(line.aiHardware.workload).toBe("unspecified_ai");

    setWorkloadRecord(buyer.runtime.store, { ...base, draftId: current.draftId, sourceDraftVersion: current.version + 1 });
    journey = await loadNeedsJourney(buyer.runtime, buyer.session);
    for (const line of journey.lines) expect(line.aiHardware.workload).toBe("unspecified_ai");
  });
});

describe("Fix C: conversation workload normalization", () => {
  const conversation = (...texts: string[]): ConversationState => ({
    draftId: "test-draft",
    interfaceLanguage: "en",
    turns: texts.map((text) => ({ role: "shopper" as const, text })),
  });

  it("recognises English fine-tuning followed by a local reply", () => {
    expect(resolveConversationWorkload(conversation("I want to fine-tune AI models", "On my laptop"))).toBe("local_training");
  });

  it("recognises Spanish local computing without the letter u being dropped", () => {
    expect(resolveConversationWorkload(conversation("Quiero entrenar modelos de IA", "En mi equipo"))).toBe("local_training");
  });

  it("handles accented text", () => {
    expect(resolveConversationWorkload(conversation("Quiero entrenar modelos de IA", "En mi portátil"))).toBe("local_training");
  });

  it("keeps existing English classifications", () => {
    expect(resolveConversationWorkload(conversation("I want to train AI models locally"))).toBe("local_training");
    expect(resolveConversationWorkload(conversation("I want to train AI models", "I will use cloud AI"))).toBe("cloud_ai");
    expect(resolveConversationWorkload(conversation("I want to work with AI models"))).toBe("unspecified_ai");
    expect(resolveConversationWorkload(conversation("I want to run AI models on my laptop"))).toBe("local_inference");
  });
});

describe("Fix D: charger routing and confirmation safety", () => {
  it("withdraws nothing for a workload change that is not persisted because a charger track opened", async () => {
    const buyer = await shopper();
    await buyer.submit("I want to work with AI models");
    await buyer.confirm();
    const before = buyer.record();
    const draftId = buyer.draft().draftId;

    // The charger track opens while the interpreter call for this laptop follow-up is in flight.
    buyer.interpret.mockImplementationOnce(async () => {
      await buyer.runtime.durable.change((host) => {
        setChargerTrack(host, { sessionId: buyer.session.id, draftId, state: "awaiting_model", deviceId: null, revision: 1 });
      });
      return PROGRAMMING;
    });
    await buyer.submit("I want to train AI models locally");

    expect(chargerTrackFor(buyer.runtime.store, buyer.session.id, draftId)?.state).toBe("awaiting_model");
    expect(buyer.record()).toEqual(before);
    expect(buyer.draft().confirmedUse).toBe("programming");
    expect(purchaseSelectionsOpen(buyer.runtime.store, buyer.session.id)).toBe(true);
  });

  it("still withdraws for a genuine needs change", async () => {
    const buyer = await shopper();
    await buyer.submit("I need a laptop for programming");
    await buyer.confirm();
    buyer.interpret.mockResolvedValueOnce({ understoodUse: "schoolwork", budgetDollars: "500", followUp: null });
    await buyer.submit("I need it for school and my budget is 500", { use: "programming", budget: "900" });
    expect(buyer.draft().confirmedUse).toBeFalsy();
    expect(purchaseSelectionsOpen(buyer.runtime.store, buyer.session.id)).toBe(false);
  });

  it("creates no laptop workload record from a charger-only turn", async () => {
    const buyer = await shopper();
    await buyer.submit("I need a charger for my MacBook Air");
    const draft = needsDraftsFor(buyer.runtime.store).get(buyer.session.id);
    expect(draft).toBeTruthy();
    expect(chargerTrackFor(buyer.runtime.store, buyer.session.id, draft!.draftId)).not.toBeNull();
    expect(buyer.record()).toBeNull();
  });
});
