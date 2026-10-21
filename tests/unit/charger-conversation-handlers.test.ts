import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chargerTracksOf } from "@/lib/session/charger-clarification";
import { readConversation } from "@/lib/session/conversation";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import { openFoundationStore, type CommitResult, type FoundationStore, type PublishedBody } from "@/lib/session/snapshot-store";
import { PersistenceUnavailableError } from "@/lib/session/durable";
import { needsDraftsFor } from "@/lib/session/store";
import { handleChargerControl, handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { loadNeedsJourney } from "@/server/shopping";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

const SITE = "https://shop.example.test";
const disposableStores: string[] = [];
afterEach(() => { for (const directory of disposableStores.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

async function shopper(runtime: Runtime) {
  const started = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
  const token = started.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const resolved = await runtime.sessions.resolve(token);
  if (!resolved.ok) throw new Error("session not established");
  return {
    token,
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    sessionId: resolved.value.id,
    csrfToken: resolved.value.csrfToken,
    session: resolved.value,
  };
}

function postNeeds(text: string, lang: "en" | "es", buyer: Awaited<ReturnType<typeof shopper>>) {
  return new Request(`${SITE}/shop/needs/submit`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: SITE,
      "sec-fetch-site": "same-origin",
      cookie: buyer.cookie,
    },
    body: new URLSearchParams({ lang, shopperText: text, csrfToken: buyer.csrfToken }).toString(),
  });
}

function postNeedsReply(text: string, lang: "en" | "es", buyer: Awaited<ReturnType<typeof shopper>>, draftId: string, version: number) {
  return new Request(`${SITE}/shop/needs/submit`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
    body: new URLSearchParams({ lang, draftId, version: String(version), shopperText: text, csrfToken: buyer.csrfToken }).toString(),
  });
}

function postControl(fields: Record<string, string>, buyer: Awaited<ReturnType<typeof shopper>>) {
  return new Request(`${SITE}/shop/needs/charger-control`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: SITE,
      "sec-fetch-site": "same-origin",
      cookie: buyer.cookie,
    },
    body: new URLSearchParams({ ...fields, csrfToken: buyer.csrfToken }).toString(),
  });
}

function postRawControl(fields: URLSearchParams, buyer: Awaited<ReturnType<typeof shopper>>) {
  const body = new URLSearchParams(fields);
  body.set("csrfToken", buyer.csrfToken);
  return new Request(`${SITE}/shop/needs/charger-control`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
    body: body.toString(),
  });
}

async function realDisposableSnapshot() {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-charger-slice2-"));
  fs.rmSync(directory, { recursive: true, force: true });
  const keyFile = `${directory}.key`;
  fs.writeFileSync(keyFile, "charger-conversation-test-key", { mode: 0o600 });
  disposableStores.push(directory, keyFile);
  const foundation = await openFoundationStore(directory, new Uint8Array(), { initializeEmpty: { keyFile } });
  if (foundation.status !== "ready") throw new Error("disposable snapshot unavailable");
  const time = createTestClock();
  let beforeCommit: (() => Promise<void>) | null = null;
  const wrapped: FoundationStore = {
    readPublished: () => foundation.value.readPublished(),
    async commit(body: unknown) {
      const intercept = beforeCommit;
      beforeCommit = null;
      if (intercept) await intercept();
      return foundation.value.commit(body);
    },
  };
  const wrappedGate = await recoverStateGate(wrapped, time.clock());
  if (wrappedGate.status !== "ready") throw new Error("wrapped disposable snapshot recovery failed");
  const wrappedRuntime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock, gate: wrappedGate.gate });
  return { directory, foundation: wrapped, runtime: wrappedRuntime, time, holdNextCommit(callback: () => Promise<void>) { beforeCommit = callback; } };
}

describe("charger clarification through the guided conversation", () => {
  it.each([
    { text: "Charger for my laptop", language: "en" as const, state: "awaiting_model", line: "charger_model" },
    { text: "I need a laptop and a charger", language: "en" as const, state: "task_choice", line: "charger_task_choice" },
    { text: "I need a laptop, but also a charger", language: "en" as const, state: "task_choice", line: "charger_task_choice" },
    { text: "Necesito un portátil, pero quiero un cargador", language: "es" as const, state: "task_choice", line: "charger_task_choice" },
    { text: "I need an adapter", language: "en" as const, state: "task_choice", line: "charger_task_choice" },
    { text: "Cargador portátil", language: "es" as const, state: "awaiting_model", line: "charger_model" },
  ])("routes '$text' without interpreting laptop needs", async ({ text, language, state, line }) => {
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock },
    );
    const buyer = await shopper(runtime);
    const interpret = vi.spyOn(runtime.ai, "interpretNeeds");
    const suggest = vi.spyOn(runtime.ai, "suggestProducts");
    const explain = vi.spyOn(runtime.ai, "explainAssessment");

    const response = await handleNeedsSubmit(postNeeds(text, language, buyer), runtime);

    expect(response.status).toBe(303);
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    expect(draft).toMatchObject({
      language,
      shopperText: text,
      prefilledUse: null,
      prefilledBudgetDollars: null,
      confirmedUse: null,
      confirmedBudgetDollars: null,
      interpretationClaimVersion: null,
      interpretationPending: false,
      recommendationClaim: null,
      notice: null,
    });
    expect(draft).toBeDefined();
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toEqual({
      sessionId: buyer.sessionId,
      draftId: draft!.draftId,
      state,
      deviceId: null,
      revision: 1,
    });
    expect(readConversation(runtime.store, buyer.sessionId)?.turns).toEqual([
      { role: "shopper", text },
      { role: "assistant", text: line },
    ]);
    expect(interpret).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
    expect(explain).not.toHaveBeenCalled();
  });

  it("routes a clear charger reply away from interpretation without changing laptop fields", async () => {
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock },
    );
    const buyer = await shopper(runtime);
    const first = await handleNeedsSubmit(postNeeds("I need a laptop for school", "en", buyer), runtime);
    expect(first.status).toBe(303);
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    const before = vi.spyOn(runtime.ai, "interpretNeeds");
    const suggestion = vi.spyOn(runtime.ai, "suggestProducts");

    const reply = new Request(`${SITE}/shop/needs/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: SITE,
        "sec-fetch-site": "same-origin",
        cookie: buyer.cookie,
      },
      body: new URLSearchParams({
        lang: "es",
        draftId: draft.draftId,
        version: String(draft.version),
        shopperText: "I need a charger for my laptop",
        use: "schoolwork",
        budget: "",
        csrfToken: buyer.csrfToken,
      }).toString(),
    });
    const response = await handleNeedsSubmit(reply, runtime);

    expect(response.status).toBe(303);
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)).toMatchObject({
      prefilledUse: "schoolwork",
      prefilledBudgetDollars: null,
      confirmedUse: null,
      confirmedBudgetDollars: null,
      interpretationClaimVersion: 1,
      recommendationClaim: null,
    });
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({
      state: "awaiting_model",
      deviceId: null,
      revision: 1,
    });
    expect(before).not.toHaveBeenCalled();
    expect(suggestion).not.toHaveBeenCalled();
  });

  it("asks which task when a charger reply explicitly clears saved laptop fields", async () => {
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock },
    );
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(
      new Request(`${SITE}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", shopperText: "", use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );
    let draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    await handleNeedsConfirm(
      new Request(`${SITE}/shop/needs/confirm`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );
    draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;

    await handleNeedsSubmit(
      new Request(`${SITE}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", draftId: draft.draftId, version: String(draft.version), shopperText: "Charger for my laptop", use: "", budget: "", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );

    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "task_choice", revision: 1 });
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)).toMatchObject({ prefilledUse: "schoolwork", prefilledBudgetDollars: "500", confirmedUse: "schoolwork", confirmedBudgetDollars: "500" });
  });

  it("publishes neither draft nor track if the atomic initial charger save is refused", async () => {
    let published: PublishedBody = {
      allocation: { windowStartedAt: null, count: 0 },
      admissionLogin: { windowStartedAt: null, count: 0 },
      sessions: [], drafts: [], conversations: [], selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [],
    };
    let refuse = false;
    const foundation: FoundationStore = {
      readPublished: () => ({ status: "ready", value: { format: 3, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } }),
      async commit(body: unknown): Promise<CommitResult> {
        if (refuse) return { status: "unavailable", outcome: "definite" };
        published = structuredClone(body) as PublishedBody;
        return { status: "ready", value: { format: 3, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } };
      },
    };
    const time = createTestClock();
    const opened = await recoverStateGate(foundation, time.clock());
    if (opened.status !== "ready") throw new Error("disposable snapshot did not open");
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock, gate: opened.gate },
    );
    const buyer = await shopper(runtime);
    refuse = true;
    const interpret = vi.spyOn(runtime.ai, "interpretNeeds");
    const suggest = vi.spyOn(runtime.ai, "suggestProducts");

    await expect(handleNeedsSubmit(postNeeds("Charger for my laptop", "en", buyer), runtime)).rejects.toBeInstanceOf(PersistenceUnavailableError);

    expect(published.drafts).toHaveLength(0);
    expect(published.chargerTracks).toHaveLength(0);
    expect(needsDraftsFor(runtime.store).has(buyer.sessionId)).toBe(false);
    expect(chargerTracksOf(runtime.store).has(buyer.sessionId)).toBe(false);
    expect(interpret).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("requires current website controls to confirm an exact candidate and rejects replayed revisions", async () => {
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock },
    );
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(postNeeds("Charger for my laptop", "en", buyer), runtime);
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;

    const chosen = await handleChargerControl(
      postControl({ lang: "en", draftId: draft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" }, buyer),
      runtime,
    );
    expect(chosen.status).toBe(303);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "candidate", deviceId: "Mac14,2", revision: 2 });

    const staleConfirm = await handleChargerControl(
      postControl({ lang: "en", draftId: draft.draftId, revision: "1", action: "confirm" }, buyer),
      runtime,
    );
    expect(staleConfirm.status).toBe(303);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "candidate", revision: 2 });

    const confirmed = await handleChargerControl(
      postControl({ lang: "en", draftId: draft.draftId, revision: "2", action: "confirm" }, buyer),
      runtime,
    );
    expect(confirmed.status).toBe(303);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "confirmed", deviceId: "Mac14,2", revision: 3 });
  });

  it("refuses malformed, repeated and unknown control fields without changing charger state", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock });
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(postNeeds("Charger for my laptop", "en", buyer), runtime);
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    const beforeTrack = chargerTracksOf(runtime.store).get(buyer.sessionId);
    const beforeTurns = readConversation(runtime.store, buyer.sessionId)?.turns;
    const fields = new URLSearchParams({ lang: "en", draftId: draft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" });
    const repeated = new URLSearchParams(fields); repeated.append("revision", "1");
    const unknown = new URLSearchParams(fields); unknown.set("unexpected", "stop");
    const conflicting = new URLSearchParams(fields); conflicting.set("task", "charger");
    for (const form of [repeated, unknown, conflicting]) {
      const response = await handleChargerControl(postRawControl(form, buyer), runtime);
      expect(response.headers.get("location")).toContain("error=CLARIFICATION_INVALID");
      expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toEqual(beforeTrack);
      expect(readConversation(runtime.store, buyer.sessionId)?.turns).toEqual(beforeTurns);
    }
  });

  it("persists a confirmed information-only charger journey and restores it from a disposable snapshot", async () => {
    const world = await realDisposableSnapshot();
    const buyer = await shopper(world.runtime);
    await handleNeedsSubmit(postNeeds("Charger for my laptop", "es", buyer), world.runtime);
    const draft = needsDraftsFor(world.runtime.store).get(buyer.sessionId)!;
    await handleChargerControl(postControl({ lang: "es", draftId: draft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" }, buyer), world.runtime);
    await handleChargerControl(postControl({ lang: "es", draftId: draft.draftId, revision: "2", action: "confirm" }, buyer), world.runtime);

    const persisted = world.foundation.readPublished();
    expect(persisted.status).toBe("ready");
    if (persisted.status !== "ready") return;
    expect(persisted.value.body.chargerTracks).toEqual([{ sessionId: buyer.sessionId, draftId: draft.draftId, state: "confirmed", deviceId: "Mac14,2", revision: 3 }]);
    expect(persisted.value.body.conversations[0]?.turns.at(-1)).toEqual({ role: "assistant", text: "charger_shown" });

    const restoredGate = await recoverStateGate(world.foundation, world.time.clock());
    if (restoredGate.status !== "ready") throw new Error("snapshot restore failed");
    const restored = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: world.time.clock, gate: restoredGate.gate });
    const resumed = await restored.sessions.resolve(buyer.token);
    expect(resumed.ok).toBe(true);
    expect(chargerTracksOf(restored.store).get(buyer.sessionId)).toEqual({ sessionId: buyer.sessionId, draftId: draft.draftId, state: "confirmed", deviceId: "Mac14,2", revision: 3 });
    expect(readConversation(restored.store, buyer.sessionId)?.turns.at(-1)).toEqual({ role: "assistant", text: "charger_shown" });
  });

  it("rejects a charger action queued behind snapshot logout using the published revoked session", async () => {
    const world = await realDisposableSnapshot();
    const buyer = await shopper(world.runtime);
    await handleNeedsSubmit(postNeeds("Charger for my laptop", "en", buyer), world.runtime);
    const draft = needsDraftsFor(world.runtime.store).get(buyer.sessionId)!;

    let enterCommit!: () => void;
    let releaseCommit!: () => void;
    const commitEntered = new Promise<void>((resolve) => { enterCommit = resolve; });
    const commitHeld = new Promise<void>((resolve) => { releaseCommit = resolve; });
    world.holdNextCommit(async () => { enterCommit(); await commitHeld; });
    const logout = world.runtime.sessions.revoke(buyer.sessionId);
    await commitEntered;

    vi.spyOn(world.runtime.sessions, "resolve").mockResolvedValue({ ok: true, value: buyer.session });
    const originalChange = world.runtime.durable.change.bind(world.runtime.durable);
    let actionDecisionQueued!: () => void;
    const queued = new Promise<void>((resolve) => { actionDecisionQueued = resolve; });
    vi.spyOn(world.runtime.durable, "change").mockImplementation((decision) => {
      actionDecisionQueued();
      return originalChange(decision);
    });
    const action = handleChargerControl(postControl({ lang: "en", draftId: draft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" }, buyer), world.runtime);
    await queued;
    releaseCommit();
    await logout;
    const response = await action;

    expect(response.status).toBe(303);
    expect(chargerTracksOf(world.runtime.store).has(buyer.sessionId)).toBe(false);
  });

  it("rechecks expiry inside a snapshot decision queued behind prior work", async () => {
    const world = await realDisposableSnapshot();
    const buyer = await shopper(world.runtime);
    await handleNeedsSubmit(postNeeds("Charger for my laptop", "en", buyer), world.runtime);
    const draft = needsDraftsFor(world.runtime.store).get(buyer.sessionId)!;
    const blockerBuyer = await shopper(world.runtime);
    await handleNeedsSubmit(postNeeds("Charger for my laptop", "en", blockerBuyer), world.runtime);
    const blockerDraft = needsDraftsFor(world.runtime.store).get(blockerBuyer.sessionId)!;

    let enterCommit!: () => void;
    let releaseCommit!: () => void;
    const commitEntered = new Promise<void>((resolve) => { enterCommit = resolve; });
    const commitHeld = new Promise<void>((resolve) => { releaseCommit = resolve; });
    world.holdNextCommit(async () => { enterCommit(); await commitHeld; });
    const preceding = handleChargerControl(postControl({ lang: "en", draftId: blockerDraft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" }, blockerBuyer), world.runtime);
    await commitEntered;

    vi.spyOn(world.runtime.sessions, "resolve").mockResolvedValue({ ok: true, value: buyer.session });
    const originalChange = world.runtime.durable.change.bind(world.runtime.durable);
    let actionDecisionQueued!: () => void;
    const queued = new Promise<void>((resolve) => { actionDecisionQueued = resolve; });
    vi.spyOn(world.runtime.durable, "change").mockImplementation((decision) => {
      actionDecisionQueued();
      return originalChange(decision);
    });
    const action = handleChargerControl(postControl({ lang: "en", draftId: draft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" }, buyer), world.runtime);
    await queued;
    world.time.advance(2 * 60 * 60 * 1000);
    releaseCommit();
    await preceding;
    const response = await action;

    expect(response.status).toBe(303);
    expect(chargerTracksOf(world.runtime.store).get(buyer.sessionId)).toMatchObject({ state: "awaiting_model", revision: 1 });
  });

  it("binds controls to the live owning session and preserves the shared CSRF/provenance guards", async () => {
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock },
    );
    const owner = await shopper(runtime);
    await handleNeedsSubmit(postNeeds("Charger for my laptop", "en", owner), runtime);
    const draft = needsDraftsFor(runtime.store).get(owner.sessionId)!;
    const other = await shopper(runtime);
    const foreign = await handleChargerControl(
      postControl({ lang: "en", draftId: draft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" }, other),
      runtime,
    );
    expect(foreign.headers.get("location")).toContain("DRAFT_NOT_FOUND");
    expect(chargerTracksOf(runtime.store).get(owner.sessionId)?.state).toBe("awaiting_model");

    const noCsrf = new Request(`${SITE}/shop/needs/charger-control`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: owner.cookie },
      body: new URLSearchParams({ lang: "en", draftId: draft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" }).toString(),
    });
    expect((await handleChargerControl(noCsrf, runtime)).status).toBe(403);

    await runtime.sessions.revoke(owner.sessionId);
    const revoked = await handleChargerControl(
      postControl({ lang: "en", draftId: draft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" }, owner),
      runtime,
    );
    expect(revoked.status).toBe(403);
    expect(chargerTracksOf(runtime.store).has(owner.sessionId)).toBe(false);
  });

  it("refuses a control after session expiry and drops its track", async () => {
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock },
    );
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(postNeeds("Charger for my laptop", "en", buyer), runtime);
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    time.advance(3 * 60 * 60 * 1000);

    const response = await handleChargerControl(
      postControl({ lang: "en", draftId: draft.draftId, revision: "1", action: "choose_model", device: "Mac14,2" }, buyer),
      runtime,
    );

    expect(response.status).toBe(403);
    expect(chargerTracksOf(runtime.store).has(buyer.sessionId)).toBe(false);
  });

  it.each(["malformed", "unavailable"] as const)("preserves the active charger question when a held laptop interpretation returns %s", async (outcome) => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock });
    const buyer = await shopper(runtime);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const interpretation = vi.spyOn(runtime.ai, "interpretNeeds").mockImplementation(async () => {
      entered?.();
      await held;
      if (outcome === "unavailable") throw new Error("synthetic provider outage");
      return { understoodUse: "not-a-use", budgetDollars: "not-a-budget", followUp: null } as never;
    });
    const laptop = handleNeedsSubmit(postNeeds("I need a laptop for school", "en", buyer), runtime);
    await waiting;
    const pending = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    await handleNeedsSubmit(postNeedsReply("Charger for my laptop", "en", buyer, pending.draftId, pending.version), runtime);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)?.state).toBe("awaiting_model");
    release?.();
    await laptop;

    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ draftId: pending.draftId, state: "awaiting_model", revision: 1 });
    expect(readConversation(runtime.store, buyer.sessionId)?.turns.at(-1)).toEqual({ role: "assistant", text: "charger_model" });
    expect(interpretation).toHaveBeenCalledTimes(1);
  });

  it("preserves Stop, reopen and candidate correction while laptop work is pending, and refuses stale controls", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock });
    const buyer = await shopper(runtime);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(runtime.ai, "interpretNeeds").mockImplementation(async () => {
      entered?.(); await held;
      return { understoodUse: "invalid", budgetDollars: "invalid", followUp: null } as never;
    });
    const laptop = handleNeedsSubmit(postNeeds("I need a laptop for school", "en", buyer), runtime);
    await waiting;
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    await handleNeedsSubmit(postNeedsReply("Charger for my laptop", "en", buyer, draft.draftId, draft.version), runtime);
    const stopped = await handleChargerControl(postControl({ lang: "en", draftId: draft.draftId, revision: "1", action: "stop" }, buyer), runtime);
    expect(stopped.status).toBe(303);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "closed", revision: 2 });

    await handleNeedsSubmit(postNeedsReply("Charger for Mac14,2", "en", buyer, draft.draftId, draft.version), runtime);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "candidate", deviceId: "Mac14,2", revision: 3 });
    await handleNeedsSubmit(postNeedsReply("Please correct that: charger for MacBookPro12,1", "en", buyer, draft.draftId, draft.version), runtime);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "candidate", deviceId: "MacBookPro12,1", revision: 4 });

    const stale = await handleChargerControl(postControl({ lang: "en", draftId: draft.draftId, revision: "3", action: "confirm" }, buyer), runtime);
    expect(stale.headers.get("location")).toContain("error=STALE_DRAFT");
    release?.();
    await laptop;
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)).toMatchObject({ state: "candidate", deviceId: "MacBookPro12,1", revision: 4 });
    expect(readConversation(runtime.store, buyer.sessionId)?.turns.at(-1)).toEqual({ role: "assistant", text: "charger_review" });
  });

  it("does not start recommendation work for a confirmed laptop draft while charger clarification is open", async () => {
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock },
    );
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(
      new Request(`${SITE}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", shopperText: "", use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );
    let draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    await handleNeedsConfirm(
      new Request(`${SITE}/shop/needs/confirm`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );
    draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    const response = await handleNeedsSubmit(
      new Request(`${SITE}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", draftId: draft.draftId, version: String(draft.version), shopperText: "Charger for my laptop", use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );
    expect(response.status).toBe(303);
    const suggest = vi.spyOn(runtime.ai, "suggestProducts");

    const journey = await loadNeedsJourney(runtime, buyer.session);

    expect(suggest).not.toHaveBeenCalled();
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.recommendationClaim).toBeNull();
    expect(journey.chargerTrack?.state).toBe("awaiting_model");
    expect(journey.lines).toEqual([]);
  });

  it("keeps charger clarification visible when an already-started recommendation returns, without starting another", async () => {
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock },
    );
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(
      new Request(`${SITE}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", shopperText: "", use: "schoolwork", budget: "1200", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );
    let draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    await handleNeedsConfirm(
      new Request(`${SITE}/shop/needs/confirm`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "1200", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );
    draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;

    let releaseSuggestion: (() => void) | undefined;
    let enteredSuggestion: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredSuggestion = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSuggestion = resolve; });
    const original = runtime.ai.suggestProducts.bind(runtime.ai);
    const suggestion = vi.spyOn(runtime.ai, "suggestProducts").mockImplementation(async (...args) => {
      enteredSuggestion?.();
      await gate;
      return original(...args);
    });
    const inFlight = loadNeedsJourney(runtime, buyer.session);
    await entered;

    await handleNeedsSubmit(
      new Request(`${SITE}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", draftId: draft.draftId, version: String(draft.version), shopperText: "Charger for my laptop", use: "schoolwork", budget: "1200", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)?.state).toBe("awaiting_model");
    expect(suggestion).toHaveBeenCalledTimes(1);
    releaseSuggestion?.();

    const completed = await inFlight;
    expect(completed.chargerTrack?.state).toBe("awaiting_model");
    expect(completed.lines).toEqual([]);
    expect(completed.listings).toBeNull();
    expect(completed.conversation?.turns.at(-1)).toEqual({ role: "assistant", text: "charger_model" });
    const refreshed = await loadNeedsJourney(runtime, buyer.session);
    expect(refreshed.lines).toEqual([]);
    expect(refreshed.conversation?.turns.at(-1)).toEqual({ role: "assistant", text: "charger_model" });
    expect(suggestion).toHaveBeenCalledTimes(1);
  });

  it("keeps the active charger question when an already-started laptop interpretation finishes", async () => {
    const time = createTestClock();
    const runtime = createRuntime(
      { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) },
      { clock: time.clock },
    );
    const buyer = await shopper(runtime);
    let releaseInterpretation: (() => void) | undefined;
    let enteredInterpretation: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredInterpretation = resolve; });
    const gate = new Promise<void>((resolve) => { releaseInterpretation = resolve; });
    const interpretation = vi.spyOn(runtime.ai, "interpretNeeds").mockImplementation(async () => {
      enteredInterpretation?.();
      await gate;
      return { understoodUse: "schoolwork", budgetDollars: "500", followUp: null };
    });

    const laptopRequest = handleNeedsSubmit(postNeeds("I need a laptop for school", "en", buyer), runtime);
    await entered;
    const pendingDraft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    expect(pendingDraft.interpretationPending).toBe(true);
    const chargerResponse = await handleNeedsSubmit(
      new Request(`${SITE}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie },
        body: new URLSearchParams({ lang: "en", draftId: pendingDraft.draftId, version: String(pendingDraft.version), shopperText: "Charger for my laptop", csrfToken: buyer.csrfToken }).toString(),
      }),
      runtime,
    );
    expect(chargerResponse.status).toBe(303);
    expect(chargerTracksOf(runtime.store).get(buyer.sessionId)?.state).toBe("awaiting_model");
    releaseInterpretation?.();
    await laptopRequest;

    const conversation = readConversation(runtime.store, buyer.sessionId)!;
    expect(conversation.turns.filter((turn) => turn.role === "assistant").at(-1)?.text).toBe("charger_model");
    expect(conversation.turns.at(-1)).toEqual({ role: "assistant", text: "charger_model" });
    expect(interpretation).toHaveBeenCalledTimes(1);
  });
});
