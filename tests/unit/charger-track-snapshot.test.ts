import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEVICE_IDS } from "../../src/lib/compatibility/evidence";
import { canonicalJson } from "../../src/lib/shared/canonical-json";
import {
  CHARGER_LINES,
  MAX_CHARGER_REVISION,
  applyChargerControl,
  chargerTrackFor,
  chargerTracksOf,
  setChargerTrack,
  type ChargerTrack,
} from "../../src/lib/session/charger-clarification";
import { PersistenceUnavailableError, memoryDurableHost, snapshotDurableHost } from "../../src/lib/session/durable";
import { SESSION_IDLE_TIMEOUT_MS } from "../../src/lib/session/service";
import { bodyFromState, recoverStateGate, restoreState } from "../../src/lib/session/snapshot-state";
import { openFoundationStore, type CommitResult, type FoundationStore, type PublishedBody } from "../../src/lib/session/snapshot-store";
import { InMemorySessionStore, needsDraftsFor } from "../../src/lib/session/store";

/** Slice 1: format-7 charger tracks on disposable temporary stores only. No owner or rehearsal store is opened. */

const KEY = Buffer.from("charger-track-fixture-key");
const T0 = "2026-10-19T12:00:00.000Z";
const DAY = 86_400_000;
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const NOW = new Date(Date.parse(T0) + 60_000);

const sid = (n: number) => `ses_${n.toString(16).padStart(32, "0")}`;
const did = (n: number) => `nd_${n.toString(16).padStart(32, "0")}`;
const session = (n: number, options: { createdAt?: string; lastSeenAt?: string; revokedAt?: string | null } = {}) => {
  const createdAt = options.createdAt ?? T0;
  return {
    id: sid(n),
    tokenDigest: (n + 16).toString(16).padStart(64, "0"),
    createdAt,
    lastSeenAt: options.lastSeenAt ?? createdAt,
    absoluteExpiresAt: new Date(Date.parse(createdAt) + DAY).toISOString(),
    revokedAt: options.revokedAt ?? null,
  };
};
const draft = (n: number, patch: Record<string, unknown> = {}) => ({
  sessionId: sid(n),
  draftId: did(n),
  version: 2,
  language: "en" as const,
  shopperText: "a charger",
  prefilledUse: null,
  prefilledBudgetDollars: null,
  confirmedUse: null,
  confirmedBudgetDollars: null,
  interpretationClaimVersion: null,
  interpretationPending: false,
  recommendationClaim: null,
  recommendation: null,
  notice: null,
  expiresAtMs: Date.parse(T0) + DAY,
  ...patch,
});
const entry = (n: number, state: ChargerTrack["state"], revision: number, deviceId: string | null = null, patch: Record<string, unknown> = {}) => ({
  sessionId: sid(n),
  draftId: did(n),
  state,
  deviceId,
  revision,
  ...patch,
});
const asTrack = (value: ReturnType<typeof entry>) => value as unknown as ChargerTrack;
const without = (value: object, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const BASE6 = {
  allocation: { windowStartedAt: null, count: 0 },
  admissionLogin: { windowStartedAt: null, count: 0 },
  sessions: [session(1), session(2)],
  drafts: [draft(1), draft(2)],
  conversations: [] as unknown[],
  selections: [],
  grants: [],
  permissions: [],
  profiles: [],
  profileRevisions: [],
};
const body7 = (chargerTracks: unknown[], patch: Record<string, unknown> = {}) => ({ ...BASE6, chargerTracks, ...patch });

const identityFor = (key: Buffer) => createHash("sha256").update(Buffer.concat([Buffer.from("shopaccess.mock-store.v1"), Buffer.from([0]), key])).digest("hex");
const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const file = (format: number, body: unknown) => Buffer.from(JSON.stringify({ format, identity: identityFor(KEY), sha256: checksum(body), body }));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function disposableDirectory(bytes: Buffer): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-charger-"));
  fs.chmodSync(directory, 0o700);
  directories.push(directory);
  fs.writeFileSync(join(directory, "store.json"), bytes, { mode: 0o600 });
  fs.chmodSync(join(directory, "store.json"), 0o600);
  return directory;
}

async function open(bytes: Buffer) {
  const directory = disposableDirectory(bytes);
  return { directory, opened: await openFoundationStore(directory, KEY) };
}

const onDisk = (directory: string) => JSON.parse(fs.readFileSync(join(directory, "store.json"), "utf8")) as { format: number; body: PublishedBody };

describe("format 7: charger tracks (proposed; merge separately gated)", () => {
  it("accepts every state with its device rule, every curated device and every charger line", async () => {
    const tracks = [entry(1, "confirmed", 7, "Mac14,2"), entry(2, "closed", 3)];
    const conversations = [{ sessionId: sid(1), draftId: did(1), interfaceLanguage: "en", turns: [{ role: "shopper", text: "a charger" }, ...CHARGER_LINES.map((text) => ({ role: "assistant", text }))] }];
    const accepted = await open(file(7, body7(tracks, { conversations })));
    expect(accepted.opened.status).toBe("ready");
    if (accepted.opened.status !== "ready") return;
    const read = accepted.opened.value.readPublished();
    expect(read.status === "ready" && read.value.format).toBe(7);
    expect(read.status === "ready" && read.value.body.chargerTracks).toEqual(tracks);
    for (const state of ["closed", "task_choice", "awaiting_model"] as const) {
      expect((await open(file(7, body7([entry(1, state, 1)])))).opened.status, state).toBe("ready");
    }
    for (const state of ["candidate", "confirmed"] as const) {
      for (const id of DEVICE_IDS) expect((await open(file(7, body7([entry(1, state, MAX_CHARGER_REVISION, id)])))).opened.status, `${state} ${id}`).toBe("ready");
    }
  });

  it("rejects every malformed track, a charger line outside the conversation, and a track without its draft", async () => {
    const valid = entry(1, "candidate", 2, "Mac14,2");
    const missingRevision = without(valid, "revision");
    const refused: Array<[string, unknown]> = [
      ["no chargerTracks key", { ...BASE6 }],
      ["not a list", body7({} as unknown as unknown[])],
      ["missing key", body7([missingRevision])],
      ["extra key", body7([{ ...valid, extra: true }])],
      ["unknown state", body7([entry(1, "open" as ChargerTrack["state"], 2)])],
      ["prototype state", body7([entry(1, "__proto__" as ChargerTrack["state"], 2)])],
      ["closed with device", body7([entry(1, "closed", 2, "Mac14,2")])],
      ["task_choice with device", body7([entry(1, "task_choice", 2, "Mac14,2")])],
      ["awaiting_model with device", body7([entry(1, "awaiting_model", 2, "Mac14,2")])],
      ["candidate without device", body7([entry(1, "candidate", 2)])],
      ["confirmed without device", body7([entry(1, "confirmed", 2)])],
      ["uncurated device", body7([entry(1, "candidate", 2, "MacBookPro15,4")])],
      ["prototype device", body7([entry(1, "candidate", 2, "__proto__")])],
      ["non-canonical device", body7([entry(1, "candidate", 2, "mac14,2")])],
      ["revision 0", body7([entry(1, "awaiting_model", 0)])],
      ["revision past maximum", body7([entry(1, "awaiting_model", MAX_CHARGER_REVISION + 1)])],
      ["fractional revision", body7([entry(1, "awaiting_model", 1.5)])],
      ["string revision", body7([entry(1, "awaiting_model", "1" as unknown as number)])],
      ["unknown session", body7([entry(9, "awaiting_model", 1)])],
      ["other session's draft", body7([entry(1, "awaiting_model", 1, null, { draftId: did(2) })])],
      ["session without a draft", body7([entry(3, "awaiting_model", 1)], { sessions: [session(1), session(2), session(3)] })],
      ["two tracks for one session", body7([entry(1, "awaiting_model", 1), entry(1, "closed", 2)])],
      ["unknown assistant line", body7([], { conversations: [{ sessionId: sid(1), draftId: did(1), interfaceLanguage: "en", turns: [{ role: "assistant", text: "charger_unknown" }] }] })],
      ["charger line as a draft notice", body7([], { drafts: [draft(1, { notice: "charger_model" }), draft(2)] })],
    ];
    for (const [label, body] of refused) {
      expect((await open(file(7, body))).opened.status, label).toBe("unavailable");
    }
  });

  it("accepts format-7 charger lines in a conversation whose session has no track, or only a closed one", async () => {
    const lines = (n: number) => ({ sessionId: sid(n), draftId: did(n), interfaceLanguage: "es", turns: [{ role: "shopper", text: "un cargador" }, { role: "assistant", text: "charger_model" }, { role: "assistant", text: "charger_closed" }] });
    const untracked = await open(file(7, body7([], { conversations: [lines(1)] })));
    expect(untracked.opened.status).toBe("ready");
    const closed = await open(file(7, body7([entry(2, "closed", 4)], { conversations: [lines(1), lines(2)] })));
    expect(closed.opened.status).toBe("ready");
    if (closed.opened.status !== "ready") return;
    const read = closed.opened.value.readPublished();
    expect(read.status === "ready" && read.value.body.conversations.map((c) => c.turns.at(-1)?.text)).toEqual(["charger_closed", "charger_closed"]);
  });

  it("keeps format 6 strict: no chargerTracks key, no charger lines; an unknown future format is refused", async () => {
    const charged = { ...BASE6, conversations: [{ sessionId: sid(1), draftId: did(1), interfaceLanguage: "en", turns: [{ role: "assistant", text: "charger_model" }] }] };
    expect((await open(file(6, { ...BASE6, chargerTracks: [] }))).opened.status).toBe("unavailable");
    expect((await open(file(6, charged))).opened.status).toBe("unavailable");
    expect((await open(file(8, body7([])))).opened.status).toBe("unavailable");
    expect((await open(file(6, BASE6))).opened.status).toBe("ready");
  });

  it("upgrades formats 1–6 with an empty track list, leaves the file as written, and rewrites it as format 7 on commit", async () => {
    const legacyDrafts = BASE6.drafts.map((value) => without(value, "interpretationPending"));
    const { allocation, admissionLogin, sessions, drafts, conversations, selections, grants, permissions, profiles } = BASE6;
    const bodies: Array<[number, unknown]> = [
      [1, { allocation, admissionLogin, sessions, drafts: legacyDrafts }],
      [2, { allocation, admissionLogin, sessions, drafts, conversations, selections }],
      [3, { allocation, admissionLogin, sessions, drafts, conversations, selections, grants }],
      [4, { allocation, admissionLogin, sessions, drafts, conversations, selections, grants, permissions }],
      [5, { allocation, admissionLogin, sessions, drafts, conversations, selections, grants, permissions, profiles }],
      [6, BASE6],
    ];
    for (const [format, body] of bodies) {
      const bytes = file(format, body);
      const older = await open(bytes);
      expect(older.opened.status, `format ${format}`).toBe("ready");
      if (older.opened.status !== "ready") continue;
      const read = older.opened.value.readPublished();
      expect(read.status === "ready" && read.value.format).toBe(format);
      expect(read.status === "ready" && read.value.body.chargerTracks).toEqual([]);
      expect(fs.readFileSync(join(older.directory, "store.json")).equals(bytes)).toBe(true);
      if (read.status !== "ready") continue;
      const committed = await older.opened.value.commit(read.value.body);
      expect(committed.status).toBe("ready");
      const written = onDisk(older.directory);
      expect(written.format).toBe(7);
      expect(written.body.chargerTracks).toEqual([]);
    }
  });
});

describe("recovery and the saved body", () => {
  it("restores a live session's track exactly as stored and drops revoked, idle and expired-draft tracks", () => {
    const idleCreated = at(-DAY / 2);
    const body = {
      ...body7([entry(1, "confirmed", 41, "MacBookPro12,1"), entry(2, "awaiting_model", 3), entry(3, "closed", 9), entry(4, "candidate", 5, "Mac14,2")]),
      sessions: [session(1), session(2, { revokedAt: T0 }), session(3, { createdAt: idleCreated, lastSeenAt: idleCreated }), session(4)],
      drafts: [draft(1), draft(2), draft(3), draft(4, { expiresAtMs: Date.parse(T0) })],
    } as unknown as PublishedBody;
    expect(Date.parse(idleCreated) + SESSION_IDLE_TIMEOUT_MS).toBeLessThan(NOW.getTime());
    const recovered = restoreState(body, NOW);
    expect([...recovered.state.chargerTracks.values()]).toEqual([entry(1, "confirmed", 41, "MacBookPro12,1")]);
  });

  it("drops a track for a replaced draft even when an unvalidated body reaches recovery", () => {
    const body = { ...body7([entry(1, "awaiting_model", 2, null, { draftId: did(7) })]) } as unknown as PublishedBody;
    expect(restoreState(body, NOW).state.chargerTracks.size).toBe(0);
  });

  it("saves only tracks whose session is present and whose draft is still that session's draft", () => {
    const recovered = restoreState(body7([entry(1, "candidate", 4, "Mac14,2"), entry(2, "closed", 2)]) as unknown as PublishedBody, NOW).state;
    expect(bodyFromState(recovered).chargerTracks).toEqual([entry(1, "candidate", 4, "Mac14,2"), entry(2, "closed", 2)]);
    const drafts = new Map(recovered.drafts);
    drafts.delete(sid(2));
    drafts.set(sid(1), { ...drafts.get(sid(1))!, draftId: did(8) });
    expect(bodyFromState({ ...recovered, drafts }).chargerTracks).toEqual([]);
    expect(bodyFromState({ ...recovered, sessions: recovered.sessions.filter((s) => s.id !== sid(1)) }).chargerTracks).toEqual([entry(2, "closed", 2)]);
  });
});

describe("startup recovery of an older store", () => {
  it("rewrites a format-6 store as format 7 during startup recovery, with an empty track list and the rest unchanged", async () => {
    const directory = disposableDirectory(file(6, BASE6));
    const opened = await openFoundationStore(directory, KEY);
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    expect(onDisk(directory).format).toBe(6);
    const gate = await recoverStateGate(opened.value, NOW);
    expect(gate.status).toBe("ready");
    const written = onDisk(directory);
    expect(written.format).toBe(7);
    expect(written.body.chargerTracks).toEqual([]);
    expect(written.body.sessions.map((s) => s.id)).toEqual([sid(1), sid(2)]);
    expect(written.body.drafts.map((d) => d.draftId)).toEqual([did(1), did(2)]);
  });
});

describe("durable lifecycle on a disposable store", () => {
  async function boot(bytes: Buffer, wrap?: (store: FoundationStore) => FoundationStore) {
    const directory = disposableDirectory(bytes);
    const opened = await openFoundationStore(directory, KEY);
    if (opened.status !== "ready") throw new Error("open");
    const store = wrap ? wrap(opened.value) : opened.value;
    const gate = await recoverStateGate(store, NOW);
    if (gate.status !== "ready") throw new Error("recover");
    const published = {};
    return { directory, published, host: snapshotDurableHost(gate.gate, published) };
  }

  /** A restart: the saved bytes are copied to a fresh disposable directory, decoded again and recovered. */
  async function restart(directory: string, now: Date) {
    const copy = disposableDirectory(fs.readFileSync(join(directory, "store.json")));
    const opened = await openFoundationStore(copy, KEY);
    if (opened.status !== "ready") throw new Error("reopen");
    const gate = await recoverStateGate(opened.value, now);
    if (gate.status !== "ready") throw new Error("recover");
    const published = {};
    return { directory: copy, published, host: snapshotDurableHost(gate.gate, published) };
  }

  it("commits a track as format 7, publishes it, and keeps the same state and revision valid across a restart", async () => {
    const world = await boot(file(6, BASE6));
    await world.host.change((host) => setChargerTrack(host, asTrack(entry(1, "awaiting_model", 1))));
    expect(onDisk(world.directory).format).toBe(7);
    expect(onDisk(world.directory).body.chargerTracks).toEqual([entry(1, "awaiting_model", 1)]);
    expect(chargerTrackFor(world.published, sid(1), did(1))).toEqual(entry(1, "awaiting_model", 1));
    await world.host.change((host) => {
      const result = applyChargerControl(chargerTrackFor(host, sid(1), did(1)), { sessionId: sid(1), draftId: did(1), revision: 1, control: { action: "choose_model", device: "Mac14,2" } });
      if (result.kind === "applied") setChargerTrack(host, result.track);
    });
    const later = await restart(world.directory, new Date(NOW.getTime() + 60_000));
    const restored = chargerTrackFor(later.published, sid(1), did(1));
    expect(restored).toEqual(entry(1, "candidate", 2, "Mac14,2"));
    // Restart alone does not invalidate a control: the session, draft, state and revision are unchanged.
    expect(applyChargerControl(restored, { sessionId: sid(1), draftId: did(1), revision: 2, control: { action: "confirm" } })).toMatchObject({ kind: "applied" });
    // A control retained from before the change is still stale after the restart.
    expect(applyChargerControl(restored, { sessionId: sid(1), draftId: did(1), revision: 1, control: { action: "choose_model", device: "MacBookPro12,1" } })).toEqual({ kind: "stale" });
  });

  it("removes the session's track in the same commit as its logout and keeps other sessions' tracks", async () => {
    const commits: PublishedBody[] = [];
    const world = await boot(file(7, body7([entry(1, "confirmed", 6, "Mac14,2"), entry(2, "candidate", 2, "MacBookPro12,1")])), (store) => ({
      readPublished: () => store.readPublished(),
      async commit(body: unknown) {
        commits.push(structuredClone(body) as PublishedBody);
        return store.commit(body);
      },
    }));
    const before = commits.length;
    await world.host.sessionStore.revoke(sid(1), new Date(NOW.getTime() + 1_000));
    expect(commits.length).toBe(before + 1);
    const logout = commits.at(-1)!;
    expect(logout.sessions.find((s) => s.id === sid(1))?.revokedAt).not.toBeNull();
    expect(logout.chargerTracks).toEqual([entry(2, "candidate", 2, "MacBookPro12,1")]);
    expect(chargerTracksOf(world.published).has(sid(1))).toBe(false);
    expect(chargerTracksOf(world.published).has(sid(2))).toBe(true);
  });

  it("removes tracks of expired sessions with the rest of their state", async () => {
    const world = await boot(file(7, body7([entry(1, "awaiting_model", 1), entry(2, "closed", 4)])));
    const later = new Date(NOW.getTime() + SESSION_IDLE_TIMEOUT_MS + 60_000);
    await world.host.sessionStore.touch(sid(2), new Date(later.getTime() - 1_000));
    const removed = await world.host.sessionStore.deleteExpired(later, new Date(later.getTime() - SESSION_IDLE_TIMEOUT_MS));
    expect(removed).toEqual([sid(1)]);
    expect(onDisk(world.directory).body.chargerTracks).toEqual([entry(2, "closed", 4)]);
    expect([...chargerTracksOf(world.published).keys()]).toEqual([sid(2)]);
  });

  it("drops a track in the same change that deletes its draft", async () => {
    const world = await boot(file(7, body7([entry(1, "candidate", 3, "Mac14,2")])));
    await world.host.change((host) => {
      needsDraftsFor(host).delete(sid(1));
    });
    expect(onDisk(world.directory).body.chargerTracks).toEqual([]);
    expect(chargerTracksOf(world.published).size).toBe(0);
  });

  it("drops the old track when the draft is replaced in the same change, and keeps a track for the new draft", async () => {
    const world = await boot(file(7, body7([entry(1, "confirmed", 5, "Mac14,2"), entry(2, "candidate", 3, "MacBookPro12,1")])));
    await world.host.change((host) => {
      const drafts = needsDraftsFor(host);
      // Session 1: same session, new draft id; its old track is left in the host and must not survive.
      drafts.set(sid(1), { ...drafts.get(sid(1))!, draftId: did(11), version: 1 });
      // Session 2: replaced too, with a track written for the new draft in the same change.
      drafts.set(sid(2), { ...drafts.get(sid(2))!, draftId: did(12), version: 1 });
      setChargerTrack(host, { sessionId: sid(2), draftId: did(12), state: "awaiting_model", deviceId: null, revision: 1 });
    });
    expect(onDisk(world.directory).body.chargerTracks).toEqual([{ sessionId: sid(2), draftId: did(12), state: "awaiting_model", deviceId: null, revision: 1 }]);
    expect(chargerTrackFor(world.published, sid(1), did(1))).toBeNull();
    expect(chargerTracksOf(world.published).has(sid(1))).toBe(false);
    expect(chargerTrackFor(world.published, sid(2), did(12))).toEqual({ sessionId: sid(2), draftId: did(12), state: "awaiting_model", deviceId: null, revision: 1 });
  });

  it("publishes nothing when the save is refused", async () => {
    let refuse = false;
    const world = await boot(file(7, body7([])), (store) => ({
      readPublished: () => store.readPublished(),
      commit: async (body: unknown): Promise<CommitResult> => (refuse ? { status: "unavailable", outcome: "definite" } : store.commit(body)),
    }));
    const saved = fs.readFileSync(join(world.directory, "store.json"));
    refuse = true;
    await expect(world.host.change((host) => setChargerTrack(host, asTrack(entry(1, "awaiting_model", 1))))).rejects.toBeInstanceOf(PersistenceUnavailableError);
    expect(chargerTracksOf(world.published).size).toBe(0);
    expect(fs.readFileSync(join(world.directory, "store.json")).equals(saved)).toBe(true);
  });
});

describe("memory mode", () => {
  const memoryDraft = (n: number, draftId = did(n)) => without(draft(n, { draftId }), "sessionId") as unknown as Parameters<ReturnType<typeof needsDraftsFor>["set"]>[1];
  const memoryWorld = () => {
    const store = {};
    const host = memoryDurableHost(store, new InMemorySessionStore(), { windowStartedAt: null, count: 0 });
    for (const n of [1, 2, 3]) {
      needsDraftsFor(store).set(sid(n), memoryDraft(n));
      setChargerTrack(store, asTrack(entry(n, "candidate", 4, "Mac14,2")));
    }
    return { store, host };
  };

  it("removes a track in the same change that deletes its draft and keeps the other sessions' tracks", async () => {
    const { store, host } = memoryWorld();
    await host.change((h) => {
      needsDraftsFor(h).delete(sid(1));
    });
    expect([...chargerTracksOf(store).keys()].sort()).toEqual([sid(2), sid(3)].sort());
  });

  it("removes the old track when a draft is replaced, and keeps a valid track installed for the new draft in the same change", async () => {
    const { store, host } = memoryWorld();
    await host.change((h) => {
      needsDraftsFor(h).set(sid(1), memoryDraft(1, did(11)));
      needsDraftsFor(h).set(sid(2), memoryDraft(2, did(12)));
      setChargerTrack(h, { sessionId: sid(2), draftId: did(12), state: "awaiting_model", deviceId: null, revision: 1 });
    });
    expect(chargerTracksOf(store).has(sid(1))).toBe(false);
    expect(chargerTrackFor(store, sid(2), did(12))).toEqual({ sessionId: sid(2), draftId: did(12), state: "awaiting_model", deviceId: null, revision: 1 });
    expect(chargerTrackFor(store, sid(3), did(3))).toEqual(entry(3, "candidate", 4, "Mac14,2"));
  });

  it("still removes the stale track when the change throws after deleting the draft", async () => {
    const { store, host } = memoryWorld();
    await expect(
      host.change((h) => {
        needsDraftsFor(h).delete(sid(1));
        throw new Error("decision failed");
      }),
    ).rejects.toThrow("decision failed");
    expect(chargerTracksOf(store).has(sid(1))).toBe(false);
    expect(chargerTracksOf(store).size).toBe(2);
  });

  it("drops a session's track at logout and at expiry", async () => {
    const store = {};
    const sessions = new InMemorySessionStore();
    const record = (n: number, lastSeenAt: Date) => ({ id: sid(n), tokenDigest: (n + 16).toString(16).padStart(64, "0"), createdAt: new Date(T0), lastSeenAt, absoluteExpiresAt: new Date(Date.parse(T0) + DAY), revokedAt: null });
    await sessions.insertWithinCapacity(record(1, new Date(T0)), 10);
    await sessions.insertWithinCapacity(record(2, new Date(T0)), 10);
    await sessions.insertWithinCapacity(record(3, new Date(Date.parse(T0) + SESSION_IDLE_TIMEOUT_MS)), 10);
    const host = memoryDurableHost(store, sessions, { windowStartedAt: null, count: 0 });
    for (const n of [1, 2, 3]) setChargerTrack(store, asTrack(entry(n, "awaiting_model", 1)));
    await host.sessionStore.revoke(sid(1), new Date(NOW.getTime()));
    expect(chargerTracksOf(store).has(sid(1))).toBe(false);
    const later = new Date(Date.parse(T0) + SESSION_IDLE_TIMEOUT_MS + 1_000);
    await host.sessionStore.deleteExpired(later, new Date(later.getTime() - SESSION_IDLE_TIMEOUT_MS));
    expect([...chargerTracksOf(store).keys()]).toEqual([sid(3)]);
  });
});

describe("format 8: explicitly selected fresh test stores only", () => {
  it("refuses format 7 in format-8 mode without changing any file bytes", async () => {
    const bytes = file(7, body7([]));
    const directory = disposableDirectory(bytes);
    expect((await openFoundationStore(directory, KEY, { format8TestStore: true })).status).toBe("unavailable");
    expect(fs.readFileSync(join(directory, "store.json"))).toEqual(bytes);
  });
  it("refuses format 8 in ordinary mode and keeps format 7 available", async () => {
    expect((await open(file(8, body7([])))).opened.status).toBe("unavailable");
    expect((await open(file(7, body7([])))).opened.status).toBe("ready");
  });
  it("preserves a confirmed budget and revision across recovery and a durable commit", async () => {
    const track = entry(1, "confirmed", 12, "Mac14,2", { budget: { proposedCents: 5900, confirmedCents: 5900 } });
    const directory = disposableDirectory(file(8, body7([track])));
    const opened = await openFoundationStore(directory, KEY, { format8TestStore: true });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw Error("setup");
    const recovered = await recoverStateGate(opened.value, NOW);
    expect(recovered.status).toBe("ready");
    expect(onDisk(directory).format).toBe(8);
    expect(onDisk(directory).body.chargerTracks).toEqual([track]);
  });
  it.each([
    { proposedCents: 5999, confirmedCents: null },
    { proposedCents: 5900, confirmedCents: 6000 },
    { proposedCents: 0, confirmedCents: null },
    { proposedCents: 5900, confirmedCents: null, extra: true },
    null,
  ])("rejects malformed budget state %j", async budget => {
    const directory = disposableDirectory(file(8, body7([entry(1, "confirmed", 4, "Mac14,2", { budget })])));
    expect((await openFoundationStore(directory, KEY, { format8TestStore: true })).status).toBe("unavailable");
  });
  it("refuses budget fields in format 7 and on an unconfirmed model", async () => {
    const budget = { proposedCents: 5900, confirmedCents: null };
    expect((await open(file(7, body7([entry(1, "confirmed", 4, "Mac14,2", { budget })])))).opened.status).toBe("unavailable");
    const directory = disposableDirectory(file(8, body7([entry(1, "candidate", 4, "Mac14,2", { budget })])));
    expect((await openFoundationStore(directory, KEY, { format8TestStore: true })).status).toBe("unavailable");
  });
  it("initializes an empty format-8 test store explicitly", async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "sa-budget-fresh-"));
    fs.chmodSync(directory, 0o700); directories.push(directory);
    const keyFile = join(directory, "identity.key");
    fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
    const opened = await openFoundationStore(directory, KEY, { format8TestStore: true, initializeEmpty: { keyFile } });
    expect(opened.status).toBe("ready");
    expect(onDisk(directory).format).toBe(8);
    expect(onDisk(directory).body.permissions).toEqual([]);
  });
});

describe("format-8 permission recovery remains separate from charger budget", () => {
  it("never reactivates consumed, revoked or expired permissions", async () => {
    const permissions = ["consumed", "revoked", "expired", "reserved"].map((state, i) => ({
      permissionId: `prm_${(i + 1).toString(16).padStart(32, "0")}`, sessionId: sid(1), merchantId: "dmm_shopaccessdemo",
      productId: `dmp_product${i}`, variantId: `dmv_variant${i}`, maxQuantity: 1, maxTotalCents: 60000, currency: "USD",
      createdAt: T0, expiresAt: at(3600000), state,
      checkoutIntentId: state === "consumed" || state === "reserved" ? `ci_${(i + 1).toString(16).padStart(32, "0")}` : null,
      changedAt: at(1000),
    }));
    const track = entry(1, "confirmed", 12, "Mac14,2", { budget: { proposedCents: 5900, confirmedCents: 5900 } });
    const directory = disposableDirectory(file(8, body7([track], { permissions })));
    const opened = await openFoundationStore(directory, KEY, { format8TestStore: true });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw Error("setup");
    expect((await recoverStateGate(opened.value, NOW)).status).toBe("ready");
    expect(onDisk(directory).body.permissions.map(p => p.state)).toEqual(["consumed", "revoked", "expired", "active"]);
    expect(onDisk(directory).body.chargerTracks).toEqual([track]);
  });
});
