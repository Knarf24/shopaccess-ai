import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFoundationStore } from "../../src/lib/session/snapshot-store";
import { createStateGate, bodyFromState, recoverStateGate, restoreState, type DurableState } from "../../src/lib/session/snapshot-state";
import type { WorkloadRecord } from "../../src/lib/readiness/workload-record";
import type { NeedsDraft, SessionRecord } from "../../src/lib/session/store";

const NOW = new Date("2026-10-16T12:00:00.000Z");
const SESSION_ID = `ses_${"1".padStart(32, "0")}`;
const DRAFT_ID = `nd_${"1".padStart(32, "0")}`;

const session: SessionRecord = {
  id: SESSION_ID,
  tokenDigest: "a".repeat(64),
  createdAt: new Date(NOW.getTime() - 3_600_000),
  lastSeenAt: new Date(NOW.getTime() - 60_000),
  absoluteExpiresAt: new Date(NOW.getTime() - 3_600_000 + 86_400_000),
  revokedAt: null,
};

const draft: NeedsDraft = {
  draftId: DRAFT_ID,
  version: 4,
  language: "en",
  shopperText: "What is your budget?",
  prefilledUse: "programming",
  prefilledBudgetDollars: "900",
  confirmedUse: "programming",
  confirmedBudgetDollars: "900",
  interpretationClaimVersion: null,
  interpretationPending: false,
  recommendationClaim: null,
  recommendation: null,
  notice: null,
  expiresAtMs: NOW.getTime() + 3_600_000,
};

const workload: WorkloadRecord = {
  sessionId: SESSION_ID,
  draftId: DRAFT_ID,
  kind: "local_training",
  sourceDraftVersion: 3,
  evidenceState: "explicit",
};

function state(): DurableState {
  return {
    sessions: [session],
    drafts: new Map([[SESSION_ID, draft]]),
    conversations: new Map([[SESSION_ID, {
      draftId: DRAFT_ID,
      interfaceLanguage: "en",
      turns: [{ role: "shopper", text: "My budget is $900" }],
    }]]),
    selections: new Map(),
    windows: {
      allocation: { windowStartedAt: null, count: 0 },
      admissionLogin: { windowStartedAt: null, count: 0 },
    },
    grants: [],
    permissions: [],
    profiles: [],
    profileRevisions: [],
    chargerTracks: new Map(),
    workloads: new Map([[SESSION_ID, workload]]),
  };
}

describe("durable AI workload persistence (format-9 prototype)", () => {
  it("keeps ordinary format-7 body unchanged", () => {
    expect(bodyFromState(state())).not.toHaveProperty("workloads");
  });

  it("serializes a workload independently of truncated conversation turns in format 9", () => {
    const body = bodyFromState(state(), 9);
    expect(body.workloads).toEqual([workload]);
    expect(body.conversations[0].turns).toHaveLength(1);
  });

  it("restores the workload from a format-9 body", () => {
    const recovered = restoreState(bodyFromState(state(), 9), NOW);
    expect(recovered.state.workloads?.get(SESSION_ID)).toEqual(workload);
  });

  it("drops workload records for removed sessions and replaced drafts", () => {
    const base = state();
    expect(bodyFromState({ ...base, sessions: [] }, 9).workloads).toEqual([]);
    expect(bodyFromState({ ...base, drafts: new Map([[SESSION_ID, { ...draft, draftId: `nd_${"2".padStart(32, "0")}` }]]) }, 9).workloads).toEqual([]);
  });

  it("drops a workload when its draft expires during recovery", () => {
    const base = state();
    const expired = {
      ...base,
      drafts: new Map([[SESSION_ID, { ...draft, expiresAtMs: NOW.getTime() }]]),
    };
    expect(restoreState(bodyFromState(expired, 9), NOW).state.workloads?.size).toBe(0);
  });
});



it("format-9 host transaction persists workload updates", async () => {
  const { snapshotDurableHost } = await import("../../src/lib/session/durable");
  const { setWorkloadRecord } = await import("../../src/lib/session/workload-state");

  const committed: unknown[] = [];
  const store = {
    commit: async (body: unknown) => {
      committed.push(structuredClone(body));
      return {
        status: "ready" as const,
        value: {
          format: 9 as const,
          identity: "0".repeat(64),
          sha256: "0".repeat(64),
          body: body as ReturnType<typeof bodyFromState>,
        },
      };
    },
  };

  const gate = createStateGate(store, state(), 9);
  const host = snapshotDurableHost(gate, {});

  const updated: WorkloadRecord = {
    ...workload,
    kind: "cloud_ai",
    sourceDraftVersion: 4,
  };

  await host.change((scratch) => {
    setWorkloadRecord(scratch, updated);
  });

  expect(committed).toHaveLength(1);
  expect((committed[0] as { workloads?: WorkloadRecord[] }).workloads).toEqual([updated]);

  const published = gate.read();
  expect(published.status).toBe("ready");
  if (published.status !== "ready") return;
  expect(published.state.workloads?.get(SESSION_ID)).toEqual(updated);
});

it("format-9 durable state drops a workload when its draft is replaced", async () => {
  const initial = state();
  const committed: unknown[] = [];
  const store = {
    commit: async (body: unknown) => {
      committed.push(body);
      return {
        status: "ready" as const,
        value: {
          format: 9 as const,
          identity: "0".repeat(64),
          sha256: "0".repeat(64),
          body: body as ReturnType<typeof bodyFromState>,
        },
      };
    },
  };

  const gate = createStateGate(store, initial, 9);
  const result = await gate.decide((current) => ({
    value: "replaced",
    next: {
      ...current,
      drafts: new Map([
        [SESSION_ID, { ...draft, draftId: `nd_${"2".padStart(32, "0")}`, version: 1 }],
      ]),
    },
  }));

  expect(result).toEqual({ status: "done", value: "replaced" });
  expect(committed).toHaveLength(1);
  expect((committed[0] as { workloads?: unknown[] }).workloads).toEqual([]);

  const published = gate.read();
  expect(published.status).toBe("ready");
  if (published.status !== "ready") return;

  expect(published.state.workloads?.has(SESSION_ID)).toBe(false);
});


it("format-9 logout removes workload in the same durable commit", async () => {
  const { snapshotDurableHost } = await import("../../src/lib/session/durable");

  const committed: unknown[] = [];
  const store = {
    commit: async (body: unknown) => {
      committed.push(structuredClone(body));
      return {
        status: "ready" as const,
        value: {
          format: 9 as const,
          identity: "0".repeat(64),
          sha256: "0".repeat(64),
          body: body as ReturnType<typeof bodyFromState>,
        },
      };
    },
  };

  const gate = createStateGate(store, state(), 9);
  const host = snapshotDurableHost(gate, {});
  const revokedAt = new Date(NOW.getTime() + 1_000);

  await host.sessionStore.revoke(SESSION_ID, revokedAt);

  expect(committed).toHaveLength(1);

  const saved = committed[0] as {
    sessions: Array<{ id: string; revokedAt: string | null }>;
    workloads?: unknown[];
  };

  expect(saved.sessions.find((record) => record.id === SESSION_ID)?.revokedAt)
    .toBe(revokedAt.toISOString());
  expect(saved.workloads).toEqual([]);

  const published = gate.read();
  expect(published.status).toBe("ready");
  if (published.status !== "ready") return;

  expect(published.state.workloads?.has(SESSION_ID)).toBe(false);
});


it("format-9 expiration removes workload in the same durable commit", async () => {
  const { snapshotDurableHost } = await import("../../src/lib/session/durable");

  const committed: unknown[] = [];
  const store = {
    commit: async (body: unknown) => {
      committed.push(structuredClone(body));
      return {
        status: "ready" as const,
        value: {
          format: 9 as const,
          identity: "0".repeat(64),
          sha256: "0".repeat(64),
          body: body as ReturnType<typeof bodyFromState>,
        },
      };
    },
  };

  const gate = createStateGate(store, state(), 9);
  const host = snapshotDurableHost(gate, {});

  const later = new Date(session.absoluteExpiresAt.getTime() + 1_000);
  const idleCutoff = new Date(later.getTime() - 30 * 60_000);

  const removed = await host.sessionStore.deleteExpired(later, idleCutoff);

  expect(removed).toEqual([SESSION_ID]);
  expect(committed).toHaveLength(1);

  const saved = committed[0] as {
    sessions: Array<{ id: string }>;
    workloads?: unknown[];
  };

  expect(saved.sessions).toEqual([]);
  expect(saved.workloads).toEqual([]);

  const published = gate.read();
  expect(published.status).toBe("ready");
  if (published.status !== "ready") return;

  expect(published.state.sessions).toEqual([]);
  expect(published.state.workloads?.has(SESSION_ID)).toBe(false);
});

it("format-9 gate commits workload-only changes", async () => {
  const initial = state();
  const committed: unknown[] = [];
  const store = {
    commit: async (body: unknown) => {
      committed.push(body);
      return { status: "ready" as const, value: {
        format: 9 as const,
        identity: "0".repeat(64),
        sha256: "0".repeat(64),
        body: body as ReturnType<typeof bodyFromState>,
      } };
    },
  };

  const gate = createStateGate(store, initial, 9);
  const result = await gate.decide((current) => ({
    value: "saved",
    next: {
      ...current,
      workloads: new Map([[SESSION_ID, { ...workload, kind: "cloud_ai" as const }]]),
    },
  }));

  expect(result).toEqual({ status: "done", value: "saved" });
  expect(committed).toHaveLength(1);
  expect((committed[0] as { workloads?: unknown[] }).workloads).toEqual([
    { ...workload, kind: "cloud_ai" },
  ]);
});


it("format-9 recovery preserves workload records through a real store", async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-workload-restart-"));
  const restartDirectory = fs.mkdtempSync(join(tmpdir(), "sa-workload-reopened-"));
  const key = Buffer.from("isolated-workload-format9-restart-key");

  const storesToClose: Array<{ close?: () => Promise<void> }> = [];

  try {
    for (const location of [directory, restartDirectory]) {
      fs.chmodSync(location, 0o700);
    }

    const keyFile = join(directory, "identity.key");
    fs.writeFileSync(keyFile, key, { mode: 0o600 });

    const opened = await openFoundationStore(directory, key, {
      format9WorkloadTestStore: true,
      initializeEmpty: { keyFile },
    });

    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    storesToClose.push(opened.value);

    const saved = await opened.value.commit(bodyFromState(state(), 9));
    if (saved.status !== "ready") {
      throw new Error(`Format-9 test-store commit rejected: ${JSON.stringify(saved)}`);
    }
    expect(saved.status).toBe("ready");

    const bytes = fs.readFileSync(join(directory, "store.json"));
    fs.writeFileSync(join(restartDirectory, "store.json"), bytes, { mode: 0o600 });

    const reopened = await openFoundationStore(restartDirectory, key, {
      format9WorkloadTestStore: true,
    });

    expect(reopened.status).toBe("ready");
    if (reopened.status !== "ready") return;
    storesToClose.push(reopened.value);

    const recovered = await recoverStateGate(reopened.value, NOW);
    expect(recovered.status).toBe("ready");
    if (recovered.status !== "ready") return;

    const published = recovered.gate.read();
    expect(published.status).toBe("ready");
    if (published.status !== "ready") return;

    expect(published.state.workloads?.get(SESSION_ID)).toEqual(workload);

    const snapshot = reopened.value.readPublished();
    expect(snapshot.status).toBe("ready");
    if (snapshot.status !== "ready") return;

    expect(snapshot.value.format).toBe(9);
    expect(snapshot.value.body.workloads).toEqual([workload]);
  } finally {
    try {
      for (const store of storesToClose.reverse()) {
        await store.close?.();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(restartDirectory, { recursive: true, force: true });
    }
  }
});


describe("draft-validated workload lookup", () => {
  it("returns a saved workload after the original conversation has been truncated", async () => {
    const { workloadRecordForDraft, replaceWorkloadRecords } = await import(
      "../../src/lib/session/workload-state"
    );

    const host = {};
    replaceWorkloadRecords(host, new Map([[SESSION_ID, workload]]));

    expect(workloadRecordForDraft(host, SESSION_ID, DRAFT_ID, 4)).toEqual(workload);
  });

  it("rejects a different session or replaced draft", async () => {
    const { workloadRecordForDraft, replaceWorkloadRecords } = await import(
      "../../src/lib/session/workload-state"
    );

    const host = {};
    replaceWorkloadRecords(host, new Map([[SESSION_ID, workload]]));

    expect(workloadRecordForDraft(host, "another-session", DRAFT_ID, 4)).toBeNull();
    expect(workloadRecordForDraft(host, SESSION_ID, "another-draft", 4)).toBeNull();
  });

  it("rejects future, zero, and noninteger draft versions", async () => {
    const { workloadRecordForDraft, replaceWorkloadRecords } = await import(
      "../../src/lib/session/workload-state"
    );

    const host = {};
    replaceWorkloadRecords(host, new Map([[SESSION_ID, workload]]));

    expect(workloadRecordForDraft(host, SESSION_ID, DRAFT_ID, 2)).toBeNull();
    expect(workloadRecordForDraft(host, SESSION_ID, DRAFT_ID, 0)).toBeNull();
    expect(workloadRecordForDraft(host, SESSION_ID, DRAFT_ID, 3.5)).toBeNull();
  });

  it("rejects an internally inconsistent record", async () => {
    const { workloadRecordForDraft, replaceWorkloadRecords } = await import(
      "../../src/lib/session/workload-state"
    );

    const host = {};
    replaceWorkloadRecords(host, new Map([
      [SESSION_ID, { ...workload, sessionId: "another-session" }],
    ]));

    expect(workloadRecordForDraft(host, SESSION_ID, DRAFT_ID, 4)).toBeNull();
  });
});
