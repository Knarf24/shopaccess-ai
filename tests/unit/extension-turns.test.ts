import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { journeyCopy } from "@/lib/i18n/demo-copy";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { purchaseSelectionsOpen, readConversation } from "@/lib/session/conversation";
import { chargerTracksOf } from "@/lib/session/charger-clarification";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import type { CommitResult, FoundationStore, PublishedBody } from "@/lib/session/snapshot-store";
import { needsDraftsFor } from "@/lib/session/store";
import { handleExtensionConversation, handleExtensionPairingExchange, handleExtensionPairingStart, handleExtensionTurn } from "@/server/extension-handlers";
import { handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { withMockRuntime } from "@/server/respond";
import { createRuntime, type Application, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// M2-2 slice 3: the panel continues the same durable conversation as the website (docs/m2-2-plan.md §3.5).
const SITE = "https://shop.example.test";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const API = `${SITE}/api/extension/v1`;
const VERIFIER = "f".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("hex");
const EMPTY: PublishedBody = { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [], conversations: [], selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] };

function memoryRuntime(): Runtime {
  const time = createTestClock();
  return createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins: new Set([EXT]) }, { clock: time.clock });
}

async function snapshotRuntime(refuse: (body: PublishedBody) => boolean) {
  let published = structuredClone(EMPTY);
  const store: FoundationStore = {
    readPublished: () => ({ status: "ready", value: { format: 3, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } }),
    async commit(body: unknown): Promise<CommitResult> {
      const next = structuredClone(body) as PublishedBody;
      if (refuse(next)) return { status: "unavailable", outcome: "definite" };
      published = next;
      return { status: "ready", value: { format: 3, identity: "0".repeat(64), sha256: "0".repeat(64), body: next } };
    },
  };
  const time = createTestClock();
  const opened = await recoverStateGate(store, time.clock());
  if (opened.status !== "ready") throw new Error();
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins: new Set([EXT]) }, { clock: time.clock, gate: opened.gate });
  return { runtime, published: () => published };
}

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

const site = (path: string, fields: Record<string, string>, buyer: { cookie: string }) =>
  new Request(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie }, body: new URLSearchParams(fields).toString() });
const api = (path: string, body: unknown, bearer?: string) =>
  new Request(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: EXT, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });

async function pairedBearer(runtime: Runtime, sessionId: string) {
  const started = await (await handleExtensionPairingStart(api("/pairings", { protocolVersion: 1, challenge: CHALLENGE, installationId: `ins_${"1".repeat(32)}` }), runtime)).json();
  runtime.pairing.approve({ pairingId: started.value.pairingId, sessionId, deny: false, boundMs: null, matchCode: started.value.matchCode }, runtime.clock().getTime());
  const exchanged = await (await handleExtensionPairingExchange(api(`/pairings/${started.value.pairingId}/exchange`, { exchangeSecret: started.value.exchangeSecret, verifier: VERIFIER }), runtime, started.value.pairingId)).json();
  return exchanged.value.bearer as string;
}

async function setUp(runtime: Runtime, budget = "500") {
  const buyer = await shopper(runtime);
  await handleNeedsSubmit(site("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget, csrfToken: buyer.csrfToken }, buyer), runtime);
  const bearer = await pairedBearer(runtime, buyer.sessionId);
  return { buyer, bearer, draft: () => needsDraftsFor(runtime.store).get(buyer.sessionId)! };
}

const turn = (draftId: string, version: number, shopperText: string, clientRequestId: string, bearer: string) =>
  api("/conversation/turns", { draftId, version, shopperText, clientRequestId }, bearer);

describe("panel turns on the shared conversation", () => {
  it("a panel message reaches the website conversation, and the website's reaches the panel", async () => {
    const runtime = memoryRuntime();
    const { buyer, bearer, draft } = await setUp(runtime);
    const before = draft();
    const response = await handleExtensionTurn(turn(before.draftId, before.version, "a laptop for programming, budget 900", "req-00000001", bearer), runtime);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.value.conversation.turns.map((t: { text: string }) => t.text)).toContain("a laptop for programming, budget 900");
    expect(readConversation(runtime.store, buyer.sessionId)?.turns.map((t) => t.text)).toContain("a laptop for programming, budget 900");
    expect(draft().version).toBe(before.version + 1);

    const after = draft();
    await handleNeedsSubmit(site("/shop/needs/submit", { lang: "en", draftId: after.draftId, version: String(after.version), shopperText: "make it 950", csrfToken: buyer.csrfToken }, buyer), runtime);
    const read = await (await handleExtensionConversation(new Request(`${API}/conversation`, { method: "POST", headers: { origin: EXT, "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: "{}" }), runtime)).json();
    expect(read.value.conversation.turns.map((t: { text: string }) => t.text)).toContain("make it 950");
  });

  it("gives the panel the website's localized notice text for an assistant line, never the stored key", async () => {
    const runtime = memoryRuntime();
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(site("/shop/needs/submit", { lang: "es", shopperText: "una laptop para tareas, presupuesto 600", csrfToken: buyer.csrfToken }, buyer), runtime);
    const bearer = await pairedBearer(runtime, buyer.sessionId);
    const read = await (await handleExtensionConversation(new Request(`${API}/conversation`, { method: "POST", headers: { origin: EXT, "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: "{}" }), runtime)).json();
    const stored = readConversation(runtime.store, buyer.sessionId)!.turns;
    const assistant = stored.findIndex((t) => t.role === "assistant");
    expect(assistant).toBeGreaterThan(-1);
    const notice = stored[assistant].text as keyof ReturnType<typeof journeyCopy>["notices"];
    expect(read.value.conversation.turns[assistant].text).toBe(journeyCopy("es").notices[notice]);
    expect(read.value.conversation.turns[assistant].text).not.toBe(notice);
  });

  it("lets extension text identify an exact charger candidate but never confirm or add device fields", async () => {
    const runtime = memoryRuntime();
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(site("/shop/needs/submit", { lang: "es", shopperText: "Necesito una laptop y un cargador", csrfToken: buyer.csrfToken }, buyer), runtime);
    const before = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)?.state).toBe("task_choice");
    const bearer = await pairedBearer(runtime, buyer.sessionId);
    const interpret = vi.spyOn(runtime.ai, "interpretNeeds");
    const suggest = vi.spyOn(runtime.ai, "suggestProducts");

    const response = await handleExtensionTurn(turn(before.draftId, before.version, "I mean charger information", "req-charger01", bearer), runtime);
    expect(response.status).toBe(200);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "awaiting_model", revision: 2 });
    const body = await response.json();
    expect(body.value.conversation.interfaceLanguage).toBe("es");
    expect(body.value.conversation.turns.at(-1).text).toBe("¿Para qué modelo exacto de Mac es este cargador? Elija un modelo o responda con su identificador exacto.");
    const identified = await handleExtensionTurn(turn(before.draftId, before.version, "Mac14,2", "req-charger02", bearer), runtime);
    expect(identified.status).toBe(200);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "candidate", deviceId: "Mac14,2", revision: 3 });
    const candidate = await identified.json();
    expect(candidate.value.conversation.turns.at(-1).text).toBe("Revise el modelo de Mac identificado. Confirme en este sitio web para ver solo información; no se comprará nada.");
    expect(interpret).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();

    const injected = await handleExtensionTurn(
      api("/conversation/turns", { draftId: before.draftId, version: before.version, shopperText: "Mac14,2", clientRequestId: "req-device03", deviceId: "Mac14,2" }, bearer),
      runtime,
    );
    expect(injected.status).toBe(400);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)?.state).toBe("candidate");
  });

  it("refuses a stale version without changing anything", async () => {
    const runtime = memoryRuntime();
    const { buyer, bearer, draft } = await setUp(runtime);
    const before = draft();
    const turns = readConversation(runtime.store, buyer.sessionId)?.turns;
    const stale = await handleExtensionTurn(turn(before.draftId, before.version + 3, "anything", "req-00000002", bearer), runtime);
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("STALE_DRAFT");
    expect(draft()).toEqual(before);
    expect(readConversation(runtime.store, buyer.sessionId)?.turns).toEqual(turns);
  });

  it("returns the same result for a retried client request id, with one turn and one interpreter call", async () => {
    const runtime = memoryRuntime();
    const { buyer, bearer, draft } = await setUp(runtime);
    const before = draft();
    const interpret = vi.spyOn(runtime.ai, "interpretNeeds");
    const first = await handleExtensionTurn(turn(before.draftId, before.version, "for programming please", "req-00000003", bearer), runtime);
    const second = await handleExtensionTurn(turn(before.draftId, before.version, "for programming please", "req-00000003", bearer), runtime);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(readConversation(runtime.store, buyer.sessionId)?.turns.filter((t) => t.text === "for programming please")).toHaveLength(1);
  });

  it("refuses the same client request id with a different message, without a new turn or interpreter call", async () => {
    const runtime = memoryRuntime();
    const { buyer, bearer, draft } = await setUp(runtime);
    const before = draft();
    const first = await handleExtensionTurn(turn(before.draftId, before.version, "for programming please", "req-00000010", bearer), runtime);
    expect(first.status).toBe(200);
    const after = draft();
    const turns = readConversation(runtime.store, buyer.sessionId)?.turns;
    const interpret = vi.spyOn(runtime.ai, "interpretNeeds");
    const conflict = await handleExtensionTurn(turn(before.draftId, before.version, "something else entirely", "req-00000010", bearer), runtime);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("REQUEST_ID_CONFLICT");
    // Surrounding whitespace is not a different message: still the earlier result.
    const retry = await handleExtensionTurn(turn(before.draftId, before.version, "  for programming please ", "req-00000010", bearer), runtime);
    expect(retry.status).toBe(200);
    expect(interpret).not.toHaveBeenCalled();
    expect(draft()).toEqual(after);
    expect(readConversation(runtime.store, buyer.sessionId)?.turns).toEqual(turns);
  });

  it("website and panel share one 20-per-minute message allowance; a refused panel message reaches no interpreter and is not remembered", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins: new Set([EXT]) }, { clock: time.clock });
    const { buyer, bearer, draft } = await setUp(runtime); // one website submit already counted
    for (let i = 1; i < 20; i++) {
      const d = draft();
      if (i % 2 === 0) {
        const r = await handleNeedsSubmit(site("/shop/needs/submit", { lang: "en", draftId: d.draftId, version: String(d.version), shopperText: `website message ${i}`, csrfToken: buyer.csrfToken }, buyer), runtime);
        expect(r.status).toBe(303);
      } else {
        expect((await handleExtensionTurn(turn(d.draftId, d.version, `panel message ${i}`, `req-limit-${i}`, bearer), runtime)).status).toBe(200);
      }
    }
    const d = draft();
    const interpret = vi.spyOn(runtime.ai, "interpretNeeds");
    const limited = await handleExtensionTurn(turn(d.draftId, d.version, "one too many", "req-limit-21", bearer), runtime);
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(interpret).not.toHaveBeenCalled();
    expect(draft()).toEqual(d);
    // The website is refused on the same counter.
    const website = await handleNeedsSubmit(site("/shop/needs/submit", { lang: "en", draftId: d.draftId, version: String(d.version), shopperText: "website too", csrfToken: buyer.csrfToken }, buyer), runtime);
    expect(website.status).toBe(429);

    time.advance(60_000);
    const again = await handleExtensionTurn(turn(d.draftId, d.version, "one too many", "req-limit-21", bearer), runtime);
    expect(again.status).toBe(200);
    expect(interpret).toHaveBeenCalledTimes(1);
  });

  it("a supported change from the panel withdraws the website confirmation", async () => {
    const runtime = memoryRuntime();
    const { buyer, bearer, draft } = await setUp(runtime, "900");
    const d = draft();
    await handleNeedsConfirm(site("/shop/needs/confirm", { lang: "en", draftId: d.draftId, version: String(d.version), use: "schoolwork", budget: "900", csrfToken: buyer.csrfToken }, buyer), runtime);
    expect(purchaseSelectionsOpen(runtime.store, buyer.sessionId)).toBe(true);
    const confirmed = draft();
    vi.spyOn(runtime.ai, "interpretNeeds").mockResolvedValue({ understoodUse: "schoolwork", budgetDollars: "600", followUp: null });
    const response = await handleExtensionTurn(turn(confirmed.draftId, confirmed.version, "actually my budget is 600 dollars", "req-00000004", bearer), runtime);
    expect(response.status).toBe(200);
    expect(draft().confirmedUse).toBeNull();
    expect(purchaseSelectionsOpen(runtime.store, buyer.sessionId)).toBe(false);
  });

  it("requires a write-capable token from the extension origin and refuses originless and revoked requests", async () => {
    const runtime = memoryRuntime();
    const { buyer, bearer, draft } = await setUp(runtime);
    const d = draft();
    expect((await handleExtensionTurn(turn(d.draftId, d.version, "x y", "req-00000005", "0".repeat(64)), runtime)).status).toBe(401);
    const originless = new Request(`${API}/conversation/turns`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "none", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ draftId: d.draftId, version: d.version, shopperText: "x y", clientRequestId: "req-00000006" }) });
    expect((await handleExtensionTurn(originless, runtime)).status).toBe(403);
    const grantId = runtime.pairing.list(buyer.sessionId, runtime.clock())[0]!.grantId;
    await runtime.pairing.revoke(buyer.sessionId, grantId, runtime.clock());
    expect((await handleExtensionTurn(turn(d.draftId, d.version, "x y", "req-00000007", bearer), runtime)).status).toBe(401);
    expect(draft()).toEqual(d);
  });

  it("a refused claim save answers 503 and the interpreter is never called", async () => {
    const world = await snapshotRuntime((body) => body.drafts.some((d) => d.interpretationPending));
    const { bearer, draft } = await setUp(world.runtime);
    const d = draft();
    const interpret = vi.spyOn(world.runtime.ai, "interpretNeeds");
    const application: Application = { mode: "mock", runtime: { ok: true, value: world.runtime } };
    const response = await withMockRuntime(application, (rt) => handleExtensionTurn(turn(d.draftId, d.version, "for programming", "req-00000008", bearer), rt));
    expect(response.status).toBe(503);
    expect(interpret).not.toHaveBeenCalled();
    expect(world.published().drafts[0]?.interpretationPending).toBe(false);
  });
});
