import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { purchaseSelectionsOpen, readConversation } from "@/lib/session/conversation";
import { isPersistenceUnavailable } from "@/lib/session/durable";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import { openFoundationStore, type CommitResult, type FoundationStore, type PublishedBody } from "@/lib/session/snapshot-store";
import { needsDraftsFor } from "@/lib/session/store";
import { handleCheckoutStart, handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { withMockRuntime } from "@/server/respond";
import { guardPage } from "@/server/runtime-access";
import { createRuntime, type Application, type Runtime } from "@/server/runtime";
import { loadNeedsJourney } from "@/server/shopping";
import { createTestClock, HOUR, TEST_SESSION_KEY } from "./helpers";

// M2-1 slice 3/4: the mock runtime on the save-first snapshot gate.
const ORIGIN = "https://shop.example.test";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function realStore(): Promise<FoundationStore> {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-runtime-"));
  fs.rmSync(directory, { recursive: true });
  const keyFile = `${directory}.key`;
  fs.writeFileSync(keyFile, "runtime-test-key", { mode: 0o600 });
  directories.push(directory, keyFile);
  const opened = await openFoundationStore(directory, new Uint8Array(), { initializeEmpty: { keyFile } });
  if (opened.status !== "ready") throw new Error(opened.code);
  return opened.value;
}

/** An in-process store seeded with a body; refuses a commit whose body matches `refuseWhen`. Used to restart and inject faults. */
function memoryStore(seed: PublishedBody) {
  let published = structuredClone(seed);
  let refuseWhen: ((body: PublishedBody) => boolean) | null = null;
  let outcome: "definite" | "indeterminate" = "definite";
  const commits: PublishedBody[] = [];
  const store: FoundationStore = {
    readPublished: () => ({ status: "ready", value: { format: 2, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } }),
    async commit(body: unknown): Promise<CommitResult> {
      const next = structuredClone(body) as PublishedBody;
      commits.push(next);
      if (refuseWhen?.(next)) return { status: "unavailable", outcome };
      published = next;
      return { status: "ready", value: { format: 2, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(next) } };
    },
  };
  return {
    store,
    refuse(predicate: (body: PublishedBody) => boolean, kind: "definite" | "indeterminate" = "definite") {
      refuseWhen = predicate;
      outcome = kind;
    },
    body: () => published,
    commits,
  };
}

const EMPTY: PublishedBody = { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [], conversations: [], selections: [] };

async function snapshotRuntime(store: FoundationStore, time = createTestClock()): Promise<Runtime> {
  const opened = await recoverStateGate(store, time.clock());
  if (opened.status !== "ready") throw new Error(opened.code);
  return createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock, gate: opened.gate });
}

const application = (runtime: Runtime): Application => ({ mode: "mock", runtime: { ok: true, value: runtime } });

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
  expect(response.status).toBe(303);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session not established");
  return { token, cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

function post(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

async function structured(runtime: Runtime, buyer: Awaited<ReturnType<typeof shopper>>, fields: Record<string, string>) {
  return handleNeedsSubmit(post("/shop/needs/submit", { lang: "es", shopperText: "", csrfToken: buyer.csrfToken, ...fields }, buyer.cookie), runtime);
}

describe("snapshot runtime", () => {
  it("persists sessions, drafts, the conversation (language, eight-line cap) and confirmation invalidation across a restart", async () => {
    const time = createTestClock();
    const disk = await realStore();
    const a = await snapshotRuntime(disk, time);
    const buyer = await shopper(a);
    await structured(a, buyer, { use: "schoolwork", budget: "500" });
    let draft = needsDraftsFor(a.store).get(buyer.sessionId)!;
    for (const budget of ["600", "700", "800", "900", "920", "940", "950"]) {
      await structured(a, buyer, { draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget });
      draft = needsDraftsFor(a.store).get(buyer.sessionId)!;
    }
    // Eight lines so far (one assistant line per structured submission); the next change makes nine, capped at eight.
    expect(readConversation(a.store, buyer.sessionId)?.turns).toHaveLength(8);
    const confirmed = await handleNeedsConfirm(post("/shop/needs/confirm", { lang: "es", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "950", csrfToken: buyer.csrfToken }, buyer.cookie), a);
    expect(confirmed.headers.get("location")).toBe("/shop/needs?lang=es");
    expect(purchaseSelectionsOpen(a.store, buyer.sessionId)).toBe(true);
    draft = needsDraftsFor(a.store).get(buyer.sessionId)!;
    // A supported requirement change withdraws the confirmation and closes needs-bound selections in one snapshot.
    await structured(a, buyer, { draftId: draft.draftId, version: String(draft.version), use: "programming", budget: "950" });
    expect(purchaseSelectionsOpen(a.store, buyer.sessionId)).toBe(false);
    expect(readConversation(a.store, buyer.sessionId)?.turns).toHaveLength(8);
    const published = disk.readPublished();
    if (published.status !== "ready") throw new Error("read");
    expect(published.value.body.selections).toEqual([{ sessionId: buyer.sessionId, epoch: 1, closed: true }]);
    expect(published.value.body.allocation.count).toBe(1);

    // Restart: a new runtime recovered from what was durably published.
    const b = await snapshotRuntime(memoryStore(published.value.body).store, time);
    const resumed = await b.sessions.resolve(buyer.token);
    expect(resumed.ok && resumed.value.id).toBe(buyer.sessionId);
    const restored = needsDraftsFor(b.store).get(buyer.sessionId)!;
    expect(restored).toEqual(needsDraftsFor(a.store).get(buyer.sessionId));
    expect(restored.confirmedUse).toBeNull();
    expect(restored.language).toBe("es");
    const conversation = readConversation(b.store, buyer.sessionId);
    expect(conversation?.turns).toEqual(readConversation(a.store, buyer.sessionId)?.turns);
    expect(conversation?.turns).toHaveLength(8);
    expect(conversation?.interfaceLanguage).toBe("es");
    expect(purchaseSelectionsOpen(b.store, buyer.sessionId)).toBe(false);
  });

  it("refuses stale writes and other sessions after a restart, and does not restore expired sessions", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const buyer = await shopper(a);
    await structured(a, buyer, { use: "schoolwork", budget: "500" });
    const draft = needsDraftsFor(a.store).get(buyer.sessionId)!;

    const b = await snapshotRuntime(memoryStore(disk.body()).store, time);
    const before = disk.body();
    const stale = await structured(b, buyer, { draftId: draft.draftId, version: String(draft.version + 5), use: "programming", budget: "900" });
    expect(stale.headers.get("location")).toContain("error=STALE_DRAFT");
    expect(readConversation(b.store, buyer.sessionId)?.turns).toEqual(before.conversations[0]?.turns);
    const other = await shopper(b);
    const foreign = await handleNeedsConfirm(post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "500", csrfToken: other.csrfToken }, other.cookie), b);
    expect(foreign.headers.get("location")).toContain("error=DRAFT_NOT_FOUND");
    expect(needsDraftsFor(b.store).get(buyer.sessionId)?.confirmedUse).toBeNull();

    time.advance(3 * HOUR);
    const c = await snapshotRuntime(memoryStore(disk.body()).store, time);
    expect((await c.sessions.resolve(buyer.token)).ok).toBe(false);
    expect(needsDraftsFor(c.store).has(buyer.sessionId)).toBe(false);
  });

  it("does not resume or confirm a checkout intent that existed only before the restart", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const buyer = await shopper(a);
    const started = await handleCheckoutStart(post("/checkout/start", { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: "1", lang: "en", csrfToken: buyer.csrfToken }, buyer.cookie), a);
    const intentId = started.headers.get("location")!.split("/").pop()!;
    expect(await a.store.findIntent(intentId)).not.toBeNull();
    const b = await snapshotRuntime(memoryStore(disk.body()).store, time);
    expect(await b.store.findIntent(intentId)).toBeNull();
    expect(JSON.stringify(disk.body())).not.toContain(intentId);
  });

  for (const kind of ["definite", "indeterminate"] as const) {
    it(`a ${kind} refusal of the interpretation claim answers 503 without calling the interpreter, then blocks`, async () => {
      const disk = memoryStore(EMPTY);
      const runtime = await snapshotRuntime(disk.store);
      const buyer = await shopper(runtime);
      const interpret = vi.spyOn(runtime.ai, "interpretNeeds");
      disk.refuse((body) => body.drafts.some((d) => d.interpretationClaimVersion !== null), kind);
      const response = await withMockRuntime(application(runtime), (rt) => handleNeedsSubmit(post("/shop/needs/submit", { lang: "en", shopperText: "a laptop for school, about 500 dollars", csrfToken: buyer.csrfToken }, buyer.cookie), rt));
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(interpret).not.toHaveBeenCalled();
      expect(disk.body().drafts).toEqual([]);
      expect(needsDraftsFor(runtime.store).size).toBe(0);
      const handler = vi.fn(async () => new Response(null, { status: 303 }));
      const blocked = await withMockRuntime(application(runtime), handler);
      expect(blocked.status).toBe(503);
      expect(handler).not.toHaveBeenCalled();
    });
  }

  it("a refused recommendation claim starts no provider call, and the page shows the unavailable notice", async () => {
    const disk = memoryStore(EMPTY);
    const runtime = await snapshotRuntime(disk.store);
    const buyer = await shopper(runtime);
    await structured(runtime, buyer, { use: "schoolwork", budget: "900" });
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    await handleNeedsConfirm(post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "900", csrfToken: buyer.csrfToken }, buyer.cookie), runtime);
    const suggest = vi.spyOn(runtime.ai, "suggestProducts");
    const explain = vi.spyOn(runtime.ai, "explainAssessment");
    disk.refuse((body) => body.drafts.some((d) => d.recommendationClaim === "pending"));
    const session = await runtime.sessions.resolve(buyer.token);
    if (!session.ok) throw new Error("session");
    await expect(loadNeedsJourney(runtime, session.value)).rejects.toSatisfy(isPersistenceUnavailable);
    expect(suggest).not.toHaveBeenCalled();
    expect(explain).not.toHaveBeenCalled();
    expect(disk.body().drafts[0]?.recommendationClaim).toBeNull();
    const rendered = await guardPage(async () => {
      await loadNeedsJourney(runtime, session.value);
      return "journey";
    }, () => "unavailable");
    expect(rendered).toBe("unavailable");
  });

  it("makes the allocation spend durable before minting; a refused spend mints nothing", async () => {
    const disk = memoryStore(EMPTY);
    const runtime = await snapshotRuntime(disk.store);
    disk.refuse((body) => body.allocation.count > 0);
    const response = await withMockRuntime(application(runtime), (rt) => handleNeedsSession(new Request(`${ORIGIN}/session/needs`), rt));
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(disk.body().sessions).toEqual([]);
    expect(disk.commits.some((body) => body.sessions.length > 0)).toBe(false);
  });

  it("makes each admission attempt durable before it is relied on; a refused spend throws instead of allowing", async () => {
    const disk = memoryStore(EMPTY);
    const runtime = await snapshotRuntime(disk.store);
    const policy = { limit: 5, windowMs: 900_000 };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await runtime.durable.spendAdmissionAttempt(1_000 + attempt, policy)).toEqual({ allowed: true });
      expect(disk.body().admissionLogin).toEqual({ windowStartedAt: 1_001, count: attempt });
    }
    expect((await runtime.durable.spendAdmissionAttempt(2_000, policy)).allowed).toBe(false);
    expect(disk.body().admissionLogin.count).toBe(6);
    disk.refuse(() => true);
    await expect(runtime.durable.spendAdmissionAttempt(3_000, policy)).rejects.toSatisfy(isPersistenceUnavailable);
    expect(disk.body().admissionLogin.count).toBe(6);
  });

  async function confirmedBuyer(runtime: Runtime) {
    const buyer = await shopper(runtime);
    await structured(runtime, buyer, { use: "schoolwork", budget: "900" });
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    await handleNeedsConfirm(post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "900", csrfToken: buyer.csrfToken }, buyer.cookie), runtime);
    return buyer;
  }

  it("an unsupported follow-up (malformed interpretation) keeps the confirmation and open selections, durably", async () => {
    const disk = memoryStore(EMPTY);
    const runtime = await snapshotRuntime(disk.store);
    const buyer = await confirmedBuyer(runtime);
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    vi.spyOn(runtime.ai, "interpretNeeds").mockResolvedValue("not an interpretation");
    const response = await handleNeedsSubmit(post("/shop/needs/submit", { lang: "en", draftId: draft.draftId, version: String(draft.version), shopperText: "actually make it something else", csrfToken: buyer.csrfToken }, buyer.cookie), runtime);
    expect(response.status).toBe(303);
    const after = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    expect(after.confirmedUse).toBe("schoolwork");
    expect(after.confirmedBudgetDollars).toBe("900");
    expect(purchaseSelectionsOpen(runtime.store, buyer.sessionId)).toBe(true);
    expect(disk.body().drafts[0]?.confirmedUse).toBe("schoolwork");
    expect(disk.body().selections.every((selection) => !selection.closed)).toBe(true);
  });

  it("an explicit re-confirmation after a restart reopens selections, durably", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const buyer = await confirmedBuyer(a);
    let draft = needsDraftsFor(a.store).get(buyer.sessionId)!;
    await structured(a, buyer, { draftId: draft.draftId, version: String(draft.version), use: "programming", budget: "900" });
    expect(purchaseSelectionsOpen(a.store, buyer.sessionId)).toBe(false);

    const restarted = memoryStore(disk.body());
    const b = await snapshotRuntime(restarted.store, time);
    expect(purchaseSelectionsOpen(b.store, buyer.sessionId)).toBe(false);
    draft = needsDraftsFor(b.store).get(buyer.sessionId)!;
    await handleNeedsConfirm(post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: String(draft.version), use: "programming", budget: "900", csrfToken: buyer.csrfToken }, buyer.cookie), b);
    expect(purchaseSelectionsOpen(b.store, buyer.sessionId)).toBe(true);
    expect(restarted.body().selections).toEqual([{ sessionId: buyer.sessionId, epoch: 1, closed: false }]);
    expect(restarted.body().drafts[0]?.confirmedUse).toBe("programming");
  });

  it("recovers an interrupted recommendation as failed and an interrupted interpretation as unavailable, with no provider call", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const confirmed = await confirmedBuyer(a);
    const interpreting = await shopper(a);
    await structured(a, interpreting, { use: "programming", budget: "700" });
    const seeded = structuredClone(disk.body());
    const pending = seeded.drafts.find((d) => d.sessionId === confirmed.sessionId)!;
    Object.assign(pending, { recommendationClaim: "pending", recommendation: null });
    const claimed = seeded.drafts.find((d) => d.sessionId === interpreting.sessionId)!;
    Object.assign(claimed, { interpretationClaimVersion: claimed.version, interpretationPending: true, notice: null });

    const restarted = memoryStore(seeded);
    const b = await snapshotRuntime(restarted.store, time);
    expect(restarted.body().drafts.find((d) => d.sessionId === confirmed.sessionId)).toMatchObject({ recommendationClaim: "failed", recommendation: null, confirmedUse: "schoolwork" });
    expect(restarted.body().drafts.find((d) => d.sessionId === interpreting.sessionId)).toMatchObject({ interpretationClaimVersion: null, notice: "unavailable" });
    const suggest = vi.spyOn(b.ai, "suggestProducts");
    const explain = vi.spyOn(b.ai, "explainAssessment");
    const interpret = vi.spyOn(b.ai, "interpretNeeds");
    const session = await b.sessions.resolve(confirmed.token);
    if (!session.ok) throw new Error("session");
    const journey = await loadNeedsJourney(b, session.value);
    expect(journey.draft?.recommendationClaim).toBe("failed");
    expect(suggest).not.toHaveBeenCalled();
    expect(explain).not.toHaveBeenCalled();
    expect(interpret).not.toHaveBeenCalled();
  });

  // Review correction: completed claims keep their duplicate protection across a restart; only pending ones are interrupted.
  const TEXT = "a laptop for school, about 500 dollars";
  const FOLLOW = "make the budget 700 dollars";
  const initial = (runtime: Runtime, buyer: Awaited<ReturnType<typeof shopper>>, version?: number) =>
    handleNeedsSubmit(post("/shop/needs/submit", { lang: "en", shopperText: TEXT, csrfToken: buyer.csrfToken, ...(version !== undefined ? { version: String(version) } : {}) }, buyer.cookie), runtime);
  const followUp = (runtime: Runtime, buyer: Awaited<ReturnType<typeof shopper>>, draftId: string, version: number) =>
    handleNeedsSubmit(post("/shop/needs/submit", { lang: "en", draftId, version: String(version), shopperText: FOLLOW, csrfToken: buyer.csrfToken }, buyer.cookie), runtime);

  it("keeps a completed initial interpretation, and its duplicate protection, across a restart", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const buyer = await shopper(a);
    expect((await initial(a, buyer)).status).toBe(303);
    const done = needsDraftsFor(a.store).get(buyer.sessionId)!;
    expect(done.interpretationClaimVersion).toBe(done.version);
    expect(done.notice).not.toBeNull();
    const b = await snapshotRuntime(memoryStore(disk.body()).store, time);
    expect(needsDraftsFor(b.store).get(buyer.sessionId)).toEqual(done);
    const interpret = vi.spyOn(b.ai, "interpretNeeds");
    await initial(b, buyer, done.version);
    expect(interpret).not.toHaveBeenCalled();
    expect(needsDraftsFor(b.store).get(buyer.sessionId)).toEqual(done);
  });

  it("keeps a completed follow-up, and its duplicate protection, across a restart", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const buyer = await shopper(a);
    await structured(a, buyer, { use: "schoolwork", budget: "500" });
    const before = needsDraftsFor(a.store).get(buyer.sessionId)!;
    expect((await followUp(a, buyer, before.draftId, before.version)).status).toBe(303);
    const done = needsDraftsFor(a.store).get(buyer.sessionId)!;
    expect(done.version).toBe(before.version + 1);
    expect(done.interpretationClaimVersion).toBe(done.version);
    expect(done.notice).not.toBeNull();
    const b = await snapshotRuntime(memoryStore(disk.body()).store, time);
    expect(needsDraftsFor(b.store).get(buyer.sessionId)).toEqual(done);
    expect(readConversation(b.store, buyer.sessionId)?.turns).toEqual(readConversation(a.store, buyer.sessionId)?.turns);
    const interpret = vi.spyOn(b.ai, "interpretNeeds");
    const again = await followUp(b, buyer, done.draftId, done.version);
    expect(again.status).toBe(303);
    expect(interpret).not.toHaveBeenCalled();
    expect(needsDraftsFor(b.store).get(buyer.sessionId)).toEqual(done);
  });

  it("restores a genuinely interrupted initial interpretation as unavailable and lets the shopper resubmit", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const buyer = await shopper(a);
    // The claim is saved; the result save is refused, so the process "stops" with the claim pending.
    disk.refuse((body) => body.drafts.some((d) => d.interpretationClaimVersion !== null && d.notice !== null));
    const response = await withMockRuntime(application(a), (rt) => initial(rt, buyer));
    expect(response.status).toBe(503);
    const pending = disk.body().drafts[0]!;
    expect(pending).toMatchObject({ interpretationClaimVersion: pending.version, notice: null });
    const restarted = memoryStore(disk.body());
    const b = await snapshotRuntime(restarted.store, time);
    const recovered = needsDraftsFor(b.store).get(buyer.sessionId)!;
    expect(recovered).toMatchObject({ interpretationClaimVersion: null, notice: "unavailable", version: pending.version });
    const interpret = vi.spyOn(b.ai, "interpretNeeds");
    await initial(b, buyer, recovered.version);
    expect(interpret).toHaveBeenCalledTimes(1);
  });

  it("restores a genuinely interrupted follow-up as unavailable, keeping confirmed values, and lets the shopper resubmit", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const buyer = await confirmedBuyer(a);
    const before = needsDraftsFor(a.store).get(buyer.sessionId)!;
    disk.refuse((body) => body.drafts.some((d) => d.interpretationClaimVersion !== null && d.notice !== null));
    const response = await withMockRuntime(application(a), (rt) => followUp(rt, buyer, before.draftId, before.version));
    expect(response.status).toBe(503);
    const pending = disk.body().drafts[0]!;
    expect(pending).toMatchObject({ version: before.version + 1, interpretationClaimVersion: before.version + 1, notice: null, confirmedUse: "schoolwork" });
    const b = await snapshotRuntime(memoryStore(disk.body()).store, time);
    const recovered = needsDraftsFor(b.store).get(buyer.sessionId)!;
    expect(recovered).toMatchObject({ interpretationClaimVersion: null, notice: "unavailable", confirmedUse: "schoolwork", confirmedBudgetDollars: "900" });
    const interpret = vi.spyOn(b.ai, "interpretNeeds");
    await followUp(b, buyer, recovered.draftId, recovered.version);
    expect(interpret).toHaveBeenCalledTimes(1);
  });

  // Review correction 2: confirmation clears the notice, so completion must not be inferred from the notice.
  const confirmCurrent = async (runtime: Runtime, buyer: Awaited<ReturnType<typeof shopper>>) => {
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    const use = draft.prefilledUse ?? "schoolwork";
    const budget = draft.prefilledBudgetDollars ?? "800";
    const response = await handleNeedsConfirm(post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: String(draft.version), use, budget, csrfToken: buyer.csrfToken }, buyer.cookie), runtime);
    expect(response.headers.get("location")).toBe("/shop/needs?lang=en");
    return needsDraftsFor(runtime.store).get(buyer.sessionId)!;
  };

  it("keeps a completed initial interpretation that was then confirmed across a restart", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const buyer = await shopper(a);
    await initial(a, buyer);
    const confirmed = await confirmCurrent(a, buyer);
    expect(confirmed).toMatchObject({ interpretationClaimVersion: confirmed.version, interpretationPending: false, notice: null });
    expect(confirmed.confirmedUse).not.toBeNull();
    const b = await snapshotRuntime(memoryStore(disk.body()).store, time);
    const restored = needsDraftsFor(b.store).get(buyer.sessionId)!;
    expect(restored).toMatchObject({ interpretationClaimVersion: confirmed.version, interpretationPending: false, confirmedUse: confirmed.confirmedUse, confirmedBudgetDollars: confirmed.confirmedBudgetDollars });
    expect(restored.notice).not.toBe("unavailable");
    expect(purchaseSelectionsOpen(b.store, buyer.sessionId)).toBe(true);
    const interpret = vi.spyOn(b.ai, "interpretNeeds");
    await initial(b, buyer, restored.version);
    expect(interpret).not.toHaveBeenCalled();
  });

  it("keeps a completed follow-up that was then confirmed across a restart", async () => {
    const time = createTestClock();
    const disk = memoryStore(EMPTY);
    const a = await snapshotRuntime(disk.store, time);
    const buyer = await shopper(a);
    await structured(a, buyer, { use: "schoolwork", budget: "500" });
    const before = needsDraftsFor(a.store).get(buyer.sessionId)!;
    await followUp(a, buyer, before.draftId, before.version);
    const confirmed = await confirmCurrent(a, buyer);
    expect(confirmed).toMatchObject({ version: before.version + 1, interpretationClaimVersion: before.version + 1, interpretationPending: false, notice: null });
    const b = await snapshotRuntime(memoryStore(disk.body()).store, time);
    const restored = needsDraftsFor(b.store).get(buyer.sessionId)!;
    expect(restored).toEqual(confirmed);
    const interpret = vi.spyOn(b.ai, "interpretNeeds");
    await followUp(b, buyer, restored.draftId, restored.version);
    expect(interpret).not.toHaveBeenCalled();
    expect(needsDraftsFor(b.store).get(buyer.sessionId)).toEqual(confirmed);
  });
});

