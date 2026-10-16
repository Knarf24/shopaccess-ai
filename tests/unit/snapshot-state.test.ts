import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../../src/lib/shared/canonical-json";
import type { ConversationState } from "../../src/lib/session/conversation";
import {
  bodyFromState,
  createStateGate,
  recoverStateGate,
  restoreState,
  type DurableState,
  type PersistedSelection,
  type StateGate,
} from "../../src/lib/session/snapshot-state";
import { openFoundationStore, type CommitResult, type FoundationStore } from "../../src/lib/session/snapshot-store";
import type { NeedsDraft, SessionRecord } from "../../src/lib/session/store";

// M2-1: save-first state gate (docs/m2-1-plan.md §9).
const NOW = new Date("2026-10-16T12:00:00.000Z");
const HOUR = 3_600_000;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const sid = (n: number) => `ses_${n.toString(16).padStart(32, "0")}`;
const did = (n: number) => `nd_${n.toString(16).padStart(32, "0")}`;
function session(n: number, patch: Partial<SessionRecord> = {}): SessionRecord {
  const createdAt = new Date(NOW.getTime() - HOUR);
  return { id: sid(n), tokenDigest: (n + 8).toString(16).padStart(64, "0"), createdAt, lastSeenAt: new Date(NOW.getTime() - 60_000), absoluteExpiresAt: new Date(createdAt.getTime() + 24 * HOUR), revokedAt: null, ...patch };
}
function draft(n: number, patch: Partial<NeedsDraft> = {}): NeedsDraft {
  return {
    draftId: did(n), version: 4, language: "en", shopperText: "schoolwork budget 900", prefilledUse: "schoolwork", prefilledBudgetDollars: "900",
    confirmedUse: "schoolwork", confirmedBudgetDollars: "900", interpretationClaimVersion: null, interpretationPending: false, recommendationClaim: "completed",
    recommendation: { assistantMessage: "ok", recommendations: [{ productId: "dmp_aaaaaa1", variantId: "dmv_aaaaaa1", title: "Laptop", label: "Ready", unitAmountCents: 89900, currency: "USD" }] },
    notice: null, expiresAtMs: NOW.getTime() + HOUR, ...patch,
  };
}
const conversation = (n: number, lines = 8): ConversationState => ({
  draftId: did(n), interfaceLanguage: "es",
  turns: Array.from({ length: lines }, (_, i) => (i % 2 === 0 ? { role: "shopper" as const, text: `mensaje ${i}` } : { role: "assistant" as const, text: "review" })),
});
const windows = { allocation: { windowStartedAt: NOW.getTime() - 1000, count: 3 }, admissionLogin: { windowStartedAt: NOW.getTime() - 5000, count: 2 } };
function state(patch: Partial<{ sessions: SessionRecord[]; drafts: Map<string, NeedsDraft>; conversations: Map<string, ConversationState>; selections: Map<string, PersistedSelection> }> = {}): DurableState {
  return {
    sessions: [session(1), session(2)],
    drafts: new Map([[sid(1), draft(1)], [sid(2), draft(2, { language: "es" })]]),
    conversations: new Map([[sid(1), conversation(1)]]),
    selections: new Map([[sid(1), { epoch: 3, closed: true }]]),
    windows,
    grants: [],
    ...patch,
  };
}
const withSelection = (base: DurableState, epoch: number, closed: boolean): DurableState => ({ ...base, selections: new Map([...base.selections, [sid(1), { epoch, closed }]]) });

/** A store whose commits resolve only when the test says so. */
function controlledStore() {
  const pending: Array<(result: CommitResult) => void> = [];
  const commit = vi.fn(() => new Promise<CommitResult>((resolve) => pending.push(resolve)));
  return { store: { commit }, commit, settle: (result: CommitResult) => pending.shift()?.(result), waiting: () => pending.length };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const READY: CommitResult = { status: "ready", value: { format: 2, identity: "0".repeat(64), sha256: "0".repeat(64), body: bodyFromState(state()) } };

/** The caller pattern every provider path must follow: a durable claim first, then the provider. */
async function claimThenCall(gate: StateGate, provider: () => void) {
  const claim = await gate.decide((current) => ({ value: "claimed", next: withSelection(current, 9, false) }));
  if (claim.status === "done") provider();
  return claim;
}

async function realStore(): Promise<FoundationStore> {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-gate-"));
  fs.rmSync(directory, { recursive: true });
  const keyFile = `${directory}.key`;
  fs.writeFileSync(keyFile, "gate-test-key", { mode: 0o600 });
  directories.push(directory, keyFile);
  const opened = await openFoundationStore(directory, new Uint8Array(), { initializeEmpty: { keyFile } });
  if (opened.status !== "ready") throw new Error(opened.code);
  return opened.value;
}

describe("state conversion and recovery", () => {
  it("round-trips sessions, drafts, eight-line conversation, language, selections and windows", () => {
    const body = bodyFromState(state());
    const restored = restoreState(body, NOW).state;
    expect(restored.sessions).toEqual(state().sessions);
    expect([...restored.drafts]).toEqual([...state().drafts]);
    expect(restored.conversations.get(sid(1))).toEqual(conversation(1));
    expect(restored.conversations.get(sid(1))?.turns).toHaveLength(8);
    expect(restored.selections.get(sid(1))).toEqual({ epoch: 3, closed: true });
    expect(restored.windows).toEqual(windows);
    expect(canonicalJson(bodyFromState(restored))).toBe(canonicalJson(body));
  });

  it("leaves out entries whose session is gone and conversations for a replaced draft", () => {
    const body = bodyFromState(state({ sessions: [session(1)], conversations: new Map([[sid(1), { ...conversation(1), draftId: did(7) }], [sid(2), conversation(2)]]), selections: new Map([[sid(2), { epoch: 1, closed: false }]]) }));
    expect(body.sessions.map((s) => s.id)).toEqual([sid(1)]);
    expect(body.drafts.map((d) => d.sessionId)).toEqual([sid(1)]);
    expect(body.conversations).toEqual([]);
    expect(body.selections).toEqual([]);
  });

  it("drops revoked, idle-expired and absolutely expired sessions with everything they own", () => {
    const old = new Date(NOW.getTime() - 25 * HOUR);
    const body = bodyFromState(state({
      sessions: [session(1), session(2, { revokedAt: NOW }), session(3, { lastSeenAt: new Date(NOW.getTime() - 2 * HOUR) }), session(4, { createdAt: old, lastSeenAt: new Date(NOW.getTime() - 1000), absoluteExpiresAt: new Date(old.getTime() + 24 * HOUR) })],
      drafts: new Map([1, 2, 3, 4].map((n) => [sid(n), draft(n)])),
      conversations: new Map([1, 2, 3, 4].map((n) => [sid(n), conversation(n)])),
      selections: new Map([[sid(2), { epoch: 1, closed: true }], [sid(4), { epoch: 1, closed: true }]]),
    }));
    const recovered = restoreState(body, NOW);
    expect(recovered.state.sessions.map((s) => s.id)).toEqual([sid(1)]);
    expect([...recovered.state.drafts.keys()]).toEqual([sid(1)]);
    expect([...recovered.state.conversations.keys()]).toEqual([sid(1)]);
    expect([...recovered.state.selections.keys()]).toEqual([]);
    expect(recovered.droppedSessions).toBe(3);
  });

  it("drops an expired draft and its conversation but keeps the live session", () => {
    const recovered = restoreState(bodyFromState(state({ drafts: new Map([[sid(1), draft(1, { expiresAtMs: NOW.getTime() })], [sid(2), draft(2)]]) })), NOW).state;
    expect(recovered.sessions).toHaveLength(2);
    expect(recovered.drafts.has(sid(1))).toBe(false);
    expect(recovered.conversations.has(sid(1))).toBe(false);
  });

  it("leaves a completed interpretation claim unchanged, even when confirmation cleared its notice: it is duplicate protection", () => {
    for (const notice of ["review", null] as const) {
      const body = bodyFromState(state({ drafts: new Map([[sid(1), draft(1, { interpretationClaimVersion: 4, interpretationPending: false, notice })]]), conversations: new Map() }));
      const recovered = restoreState(body, NOW);
      expect(recovered.state.drafts.get(sid(1))).toMatchObject({ interpretationClaimVersion: 4, interpretationPending: false, notice, confirmedUse: "schoolwork" });
      expect(recovered.interrupted.interpretations).toBe(0);
    }
  });

  it("releases a pending follow-up that kept earlier confirmed values", () => {
    const body = bodyFromState(state({ drafts: new Map([[sid(1), draft(1, { interpretationClaimVersion: 4, interpretationPending: true, notice: "review" })]]), conversations: new Map() }));
    const recovered = restoreState(body, NOW);
    expect(recovered.state.drafts.get(sid(1))).toMatchObject({ interpretationClaimVersion: null, interpretationPending: false, notice: "unavailable", confirmedUse: "schoolwork" });
    expect(recovered.interrupted.interpretations).toBe(1);
  });

  it("restores an interrupted interpretation as unavailable and an interrupted recommendation as failed, keeping confirmation and selections", () => {
    const body = bodyFromState(state({
      drafts: new Map([
        [sid(1), draft(1, { confirmedUse: null, confirmedBudgetDollars: null, recommendationClaim: null, recommendation: null, interpretationClaimVersion: 4, interpretationPending: true, notice: null })],
        [sid(2), draft(2, { recommendationClaim: "pending", recommendation: null })],
      ]),
      conversations: new Map(),
    }));
    const recovered = restoreState(body, NOW);
    expect(recovered.state.drafts.get(sid(1))).toMatchObject({ interpretationClaimVersion: null, notice: "unavailable", version: 4 });
    expect(recovered.state.drafts.get(sid(2))).toMatchObject({ recommendationClaim: "failed", recommendation: null, confirmedUse: "schoolwork", confirmedBudgetDollars: "900" });
    expect(recovered.state.selections.get(sid(1))).toEqual({ epoch: 3, closed: true });
    expect(recovered.interrupted).toEqual({ interpretations: 1, recommendations: 1 });
  });
});

describe("save-first gate", () => {
  it("publishes a change only after the commit is durable; readers see the old state meanwhile", async () => {
    const control = controlledStore();
    const gate = createStateGate(control.store, state());
    const decided = gate.decide((current) => ({ value: "ok", next: withSelection(current, 4, false) }));
    await flush();
    expect(control.waiting()).toBe(1);
    const during = gate.read();
    expect(during.status === "ready" && during.state.selections.get(sid(1))).toEqual({ epoch: 3, closed: true });
    control.settle(READY);
    expect(await decided).toEqual({ status: "done", value: "ok" });
    const after = gate.read();
    expect(after.status === "ready" && after.state.selections.get(sid(1))).toEqual({ epoch: 4, closed: false });
  });

  it("does not start a provider until the claim is durable", async () => {
    const control = controlledStore();
    const gate = createStateGate(control.store, state());
    const provider = vi.fn();
    const flow = claimThenCall(gate, provider);
    await flush();
    expect(provider).not.toHaveBeenCalled();
    control.settle(READY);
    await flow;
    expect(provider).toHaveBeenCalledTimes(1);
  });

  for (const outcome of ["definite", "indeterminate"] as const) {
    it(`a ${outcome} refusal publishes nothing, starts no provider, and blocks every later decision and read`, async () => {
      const control = controlledStore();
      const gate = createStateGate(control.store, state());
      const provider = vi.fn();
      const flow = claimThenCall(gate, provider);
      await flush();
      control.settle({ status: "unavailable", outcome });
      expect(await flow).toEqual({ status: "unavailable" });
      expect(provider).not.toHaveBeenCalled();
      expect(gate.status()).toEqual({ kind: "blocked", outcome });
      expect(gate.read()).toEqual({ status: "unavailable" });
      const later = vi.fn(() => ({ value: 1, next: state() }));
      expect(await gate.decide(later)).toEqual({ status: "unavailable" });
      expect(later).not.toHaveBeenCalled();
      expect(control.commit).toHaveBeenCalledTimes(1);
    });
  }

  it("treats a commit that throws as a definite refusal", async () => {
    const gate = createStateGate({ commit: async () => { throw new Error("io"); } }, state());
    const provider = vi.fn();
    expect(await claimThenCall(gate, provider)).toEqual({ status: "unavailable" });
    expect(provider).not.toHaveBeenCalled();
    expect(gate.status()).toEqual({ kind: "blocked", outcome: "definite" });
  });

  it("runs queued decisions in order, each against the state published by the one before (recheck)", async () => {
    const control = controlledStore();
    const gate = createStateGate(control.store, state());
    const seen: number[] = [];
    const first = gate.decide((current) => { seen.push(current.selections.get(sid(1))?.epoch ?? -1); return { value: 1, next: withSelection(current, 10, false) }; });
    const second = gate.decide((current) => { seen.push(current.selections.get(sid(1))?.epoch ?? -1); return { value: 2, next: withSelection(current, 11, false) }; });
    await flush();
    expect(seen).toEqual([3]);
    control.settle(READY);
    await first;
    await flush();
    expect(seen).toEqual([3, 10]);
    control.settle(READY);
    await second;
  });

  it("a queued decision behind a refused commit never runs", async () => {
    const control = controlledStore();
    const gate = createStateGate(control.store, state());
    const first = gate.decide((current) => ({ value: 1, next: withSelection(current, 5, false) }));
    const behind = vi.fn((current: DurableState) => ({ value: 2, next: current }));
    const second = gate.decide(behind);
    await flush();
    control.settle({ status: "unavailable", outcome: "definite" });
    expect(await first).toEqual({ status: "unavailable" });
    expect(await second).toEqual({ status: "unavailable" });
    expect(behind).not.toHaveBeenCalled();
  });

  it("a decision without a change does not commit", async () => {
    const control = controlledStore();
    const gate = createStateGate(control.store, state());
    expect(await gate.decide(() => ({ value: "read" }))).toEqual({ status: "done", value: "read" });
    expect(control.commit).not.toHaveBeenCalled();
  });

  it("a decision that throws rejects its own call and leaves the gate usable", async () => {
    const control = controlledStore();
    const gate = createStateGate(control.store, state());
    await expect(gate.decide(() => { throw new Error("bug"); })).rejects.toThrow("bug");
    expect(gate.status()).toEqual({ kind: "ready" });
    expect(await gate.decide(() => ({ value: 1 }))).toEqual({ status: "done", value: 1 });
  });

  it("recovers through the real store, durably, before the gate exists", async () => {
    const store = await realStore();
    const seeded = await store.commit(bodyFromState(state({ drafts: new Map([[sid(1), draft(1, { recommendationClaim: "pending", recommendation: null })], [sid(2), draft(2)]]) })));
    expect(seeded.status).toBe("ready");
    const opened = await recoverStateGate(store, NOW);
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    expect(opened.interrupted).toEqual({ interpretations: 0, recommendations: 1 });
    const published = store.readPublished();
    expect(published.status === "ready" && published.value.body.drafts.find((d) => d.sessionId === sid(1))?.recommendationClaim).toBe("failed");
    expect(published.status === "ready" && published.value.body.allocation).toEqual(windows.allocation);
  });

  it("does not build a gate when the recovery commit is refused", async () => {
    const store: FoundationStore = {
      readPublished: () => ({ status: "ready", value: { format: 2, identity: "0".repeat(64), sha256: "0".repeat(64), body: bodyFromState(state()) } }),
      commit: async () => ({ status: "unavailable", outcome: "indeterminate" }),
    };
    expect(await recoverStateGate(store, NOW)).toEqual({ status: "unavailable", code: "recovery-commit-indeterminate" });
  });
});
