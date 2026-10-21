import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/lib/shared/canonical-json";
import { SESSION_COOKIE_NAME } from "../../src/lib/session/cookie";
import { MAX_DEVICE_PROFILE_VERSION, decideProfileDelete, decideProfileSave, type ProfileWrite } from "../../src/lib/profile/model";
import { parseTrustedOrigins } from "../../src/lib/session/request-guard";
import { SESSION_ABSOLUTE_LIFETIME_MS, SESSION_IDLE_TIMEOUT_MS } from "../../src/lib/session/service";
import { PersistenceUnavailableError } from "../../src/lib/session/durable";
import { recoverStateGate, restoreState } from "../../src/lib/session/snapshot-state";
import { openFoundationStore, type CommitResult, type FoundationStore, type PublishedBody } from "../../src/lib/session/snapshot-store";
import { handleNeedsSession, handleProfileDelete, handleProfileSave } from "../../src/server/handlers";
import { withMockRuntime } from "../../src/server/respond";
import { createRuntime, type Runtime } from "../../src/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

const SITE = "https://shop.example.test";
const KEY = Buffer.from("device-profile-fixture-key");
const T0 = "2026-10-16T12:00:00.000Z";
const EMPTY: PublishedBody = {
  allocation: { windowStartedAt: null, count: 0 },
  admissionLogin: { windowStartedAt: null, count: 0 },
  sessions: [],
  drafts: [],
  conversations: [],
  selections: [],
  grants: [],
  permissions: [],
  profiles: [],
  profileRevisions: [],
  chargerTracks: [],
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const sid = (n: number) => `ses_${n.toString(16).padStart(32, "0")}`;
const write = (version: number, brand: ProfileWrite["brand"], model: ProfileWrite["model"] = { consent: false, text: "" }): ProfileWrite => ({ version, brand, model });

describe("device profile decisions", () => {
  const none: PublishedBody["profiles"] = [];
  const saved = [{ sessionId: sid(1), version: 2, brand: "Acer", model: null }];

  it("keeps an empty session unchanged, and removes a profile when both fields are withdrawn", () => {
    expect(decideProfileSave(none, sid(1), write(0, { consent: false, text: "discarded" }), true)).toEqual({ ok: true, outcome: "unchanged" });
    expect(decideProfileSave(saved, sid(1), write(2, { consent: false, text: "secret" }, { consent: false, text: "also secret" }), true)).toEqual({
      ok: true,
      outcome: "removed",
      profiles: [],
      revisions: [{ sessionId: sid(1), version: 2 }],
    });
    expect(decideProfileDelete(none, sid(1), 0, true)).toEqual({ ok: true, outcome: "unchanged" });
  });

  it("refuses consent without usable text and does not publish", () => {
    expect(decideProfileSave(saved, sid(1), write(2, { consent: true, text: "  " }), true).ok).toBe(false);
    expect(decideProfileSave(saved, sid(1), write(2, { consent: true, text: "a".repeat(81) }), true)).toEqual({ ok: false, code: "FIELD_INVALID" });
    expect(decideProfileSave(saved, sid(1), write(2, { consent: true, text: "Ace\nr" }), true)).toEqual({ ok: false, code: "FIELD_INVALID" });
  });

  it("discards posted text when consent is off and bumps the version for a field that remains", () => {
    const decided = decideProfileSave(saved, sid(1), write(2, { consent: false, text: "secret" }, { consent: true, text: " Aspire 14 " }), true);
    expect(decided).toEqual({ ok: true, outcome: "saved", profiles: [{ sessionId: sid(1), version: 3, brand: null, model: "Aspire 14" }] });
  });

  it("refuses a stale save or delete and refuses version exhaustion without wrapping", () => {
    expect(decideProfileSave(saved, sid(1), write(1, { consent: true, text: "Lenovo" }), true)).toEqual({ ok: false, code: "VERSION_STALE" });
    expect(decideProfileDelete(saved, sid(1), 1, false)).toEqual({ ok: false, code: "SESSION_NOT_LIVE" });
    expect(decideProfileDelete(saved, sid(1), 1, true)).toEqual({ ok: false, code: "VERSION_STALE" });
    const full = [{ sessionId: sid(1), version: MAX_DEVICE_PROFILE_VERSION, brand: "Acer", model: null }];
    expect(decideProfileSave(full, sid(1), write(MAX_DEVICE_PROFILE_VERSION, { consent: true, text: "Acer" }, { consent: true, text: "Go" }), true)).toEqual({
      ok: false,
      code: "VERSION_EXHAUSTED",
    });
    expect(decideProfileDelete(full, sid(1), MAX_DEVICE_PROFILE_VERSION, true)).toEqual({
      ok: true,
      outcome: "removed",
      profiles: [],
      revisions: [{ sessionId: sid(1), version: MAX_DEVICE_PROFILE_VERSION }],
    });
    expect(decideProfileSave([], sid(1), write(0, { consent: true, text: "Acer" }), true, [{ sessionId: sid(1), version: MAX_DEVICE_PROFILE_VERSION }])).toEqual({
      ok: false,
      code: "VERSION_EXHAUSTED",
    });
    const removed = decideProfileDelete(saved, sid(1), 2, true);
    expect(removed).toMatchObject({ ok: true, revisions: [{ sessionId: sid(1), version: 2 }] });
    if (!removed.ok || !removed.revisions) return;
    expect(decideProfileSave([], sid(1), write(0, { consent: true, text: "Lenovo" }), true, removed.revisions)).toEqual({
      ok: true,
      outcome: "saved",
      profiles: [{ sessionId: sid(1), version: 3, brand: "Lenovo", model: null }],
      revisions: [],
    });
    expect(decideProfileSave([], sid(1), write(2, { consent: true, text: "Acer" }), true, removed.revisions)).toEqual({ ok: false, code: "VERSION_STALE" });
    expect(decideProfileSave([{ ...saved[0], version: 0 }], sid(1), write(0, { consent: true, text: "Acer" }), true)).toEqual({ ok: false, code: "STORED_INVALID" });
    expect(decideProfileSave([{ ...saved[0], version: MAX_DEVICE_PROFILE_VERSION + 1 }], sid(1), write(1, { consent: true, text: "Acer" }), true)).toEqual({
      ok: false,
      code: "STORED_INVALID",
    });
  });
});

describe("format 5 parsing and recovery", () => {
  const identityFor = (key: Buffer) => createHash("sha256").update(Buffer.concat([Buffer.from("shopaccess.mock-store.v1"), Buffer.from([0]), key])).digest("hex");
  const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  const file = (format: number, body: unknown) => Buffer.from(JSON.stringify({ format, identity: identityFor(KEY), sha256: checksum(body), body }));
  const session = (n: number, revokedAt: string | null = null) => ({
    id: sid(n),
    tokenDigest: (n + 8).toString(16).padStart(64, "0"),
    createdAt: T0,
    lastSeenAt: T0,
    absoluteExpiresAt: "2026-10-17T12:00:00.000Z",
    revokedAt,
  });
  const permission = (n: number, state: "active" | "reserved" | "executing", sessionId = sid(1)) => ({
    permissionId: `prm_${n.toString(16).padStart(32, "0")}`,
    sessionId,
    merchantId: "dmm_shopaccessdemo",
    productId: n === 2 ? "dmp_aspirego15" : "dmp_aspire14ai",
    variantId: n === 2 ? "dmv_aspirego15" : "dmv_aspire14ai",
    maxQuantity: 1,
    maxTotalCents: 87999,
    currency: "USD" as const,
    createdAt: T0,
    expiresAt: "2026-10-16T18:00:00.000Z",
    state,
    checkoutIntentId: state === "active" ? null : `ci_${n.toString(16).padStart(32, "0")}`,
    changedAt: T0,
  });
  const base = {
    allocation: { windowStartedAt: null, count: 0 },
    admissionLogin: { windowStartedAt: null, count: 0 },
    sessions: [session(1), session(2, T0)],
    drafts: [],
    conversations: [],
    selections: [],
    grants: [],
    permissions: [permission(1, "reserved"), permission(2, "executing"), permission(3, "active", sid(2))],
  };

  async function open(bytes: Buffer) {
    const directory = fs.mkdtempSync(join(tmpdir(), "sa-profile-"));
    fs.chmodSync(directory, 0o700);
    directories.push(directory);
    fs.writeFileSync(join(directory, "store.json"), bytes, { mode: 0o600 });
    fs.chmodSync(join(directory, "store.json"), 0o600);
    return { directory, opened: await openFoundationStore(directory, KEY) };
  }

  it("upgrades formats 1–4 with an empty profile list and preserves permission records for recovery", async () => {
    const older = await open(file(4, base));
    expect(older.opened.status).toBe("ready");
    if (older.opened.status !== "ready") return;
    const read = older.opened.value.readPublished();
    expect(read.status === "ready" && read.value.format).toBe(4);
    expect(read.status === "ready" && read.value.body.profiles).toEqual([]);
    expect(read.status === "ready" && read.value.body.profileRevisions).toEqual([]);
    expect(read.status === "ready" && read.value.body.permissions.map((item) => item.state)).toEqual(["reserved", "executing", "active"]);
    expect(fs.readFileSync(join(older.directory, "store.json")).equals(file(4, base))).toBe(true);
    if (read.status !== "ready") return;
    const recovered = restoreState(read.value.body, new Date(T0));
    expect(recovered.state.permissions.map((item) => [item.sessionId, item.state, item.checkoutIntentId])).toEqual([
      [sid(1), "active", null],
      [sid(1), "outcome_unknown", `ci_${"2".padStart(32, "0")}`],
    ]);
    expect(recovered.state.profiles).toEqual([]);
    expect(recovered.state.profileRevisions).toEqual([]);
    expect(recovered.droppedSessions).toBe(1);
    const committed = await older.opened.value.commit(read.value.body);
    expect(committed.status).toBe("ready");
    expect(JSON.parse(fs.readFileSync(join(older.directory, "store.json"), "utf8")).format).toBe(7);
  });

  it("accepts one profile per session and refuses a wrapped, extra, or future format", async () => {
    const profile = { sessionId: sid(1), version: 1, brand: "Acer", model: null };
    const current = { ...base, profiles: [profile] };
    const accepted = await open(file(5, current));
    expect(accepted.opened.status).toBe("ready");
    const marked = await open(file(6, { ...base, profiles: [], profileRevisions: [{ sessionId: sid(1), version: 4 }] }));
    expect(marked.opened.status).toBe("ready");
    const refused = [
      file(8, { ...current, profileRevisions: [], chargerTracks: [] }),
      file(6, current),
      file(6, { ...current, profileRevisions: [{ sessionId: sid(1), version: 4 }] }),
      file(6, { ...base, profiles: [], profileRevisions: [{ sessionId: sid(1), version: 0 }] }),
      file(5, { ...current, extra: true }),
      file(5, { ...current, profiles: [{ ...profile, version: 0 }] }),
      file(5, { ...current, profiles: [{ ...profile, version: MAX_DEVICE_PROFILE_VERSION + 1 }] }),
      file(5, { ...current, profiles: [profile, { ...profile, version: 2 }] }),
      file(5, { ...current, profiles: [{ ...profile, brand: " Acer" }] }),
      file(5, { ...current, profiles: [{ ...profile, brand: null, model: null }] }),
      file(5, base),
    ];
    for (const bytes of refused) {
      const result = await open(bytes);
      expect(result.opened.status).toBe("unavailable");
    }
  });

  it("restores a live profile as stored and applies the existing in-flight and permission transformations", () => {
    const draft = {
      sessionId: sid(1),
      draftId: `nd_${"1".padStart(32, "0")}`,
      version: 4,
      language: "en" as const,
      shopperText: "schoolwork",
      prefilledUse: "schoolwork" as const,
      prefilledBudgetDollars: "500",
      confirmedUse: "schoolwork" as const,
      confirmedBudgetDollars: "500",
      interpretationClaimVersion: 4,
      interpretationPending: true,
      recommendationClaim: "pending" as const,
      recommendation: null,
      notice: null,
      expiresAtMs: Date.parse("2026-10-17T12:00:00.000Z"),
    };
    const body: PublishedBody = {
      ...EMPTY,
      sessions: [
        { id: sid(1), tokenDigest: "1".padStart(64, "0"), createdAt: T0, lastSeenAt: T0, absoluteExpiresAt: "2026-10-17T12:00:00.000Z", revokedAt: null },
        { id: sid(2), tokenDigest: "2".padStart(64, "0"), createdAt: T0, lastSeenAt: T0, absoluteExpiresAt: "2026-10-17T12:00:00.000Z", revokedAt: T0 },
      ],
      drafts: [draft],
      conversations: [{ sessionId: sid(1), draftId: draft.draftId, interfaceLanguage: "en", turns: [{ role: "shopper", text: "schoolwork" }] }],
      grants: [
        {
          grantId: `grt_${"a".repeat(32)}`,
          sessionId: sid(1),
          tokenDigest: "ab".padStart(64, "0"),
          extensionOrigin: `chrome-extension://${"a".repeat(32)}`,
          installationId: `ins_${"b".repeat(32)}`,
          scopes: ["conversation:read"],
          createdAt: T0,
          expiresAt: "2026-10-16T13:00:00.000Z",
          revokedAt: null,
        },
      ],
      permissions: [permission(1, "reserved"), permission(2, "executing")],
      profiles: [
        { sessionId: sid(1), version: 4, brand: "Acer", model: "Aspire 14" },
        { sessionId: sid(2), version: 1, brand: "Other", model: null },
      ],
    };
    const recovered = restoreState(body, new Date(T0));
    expect(recovered.state.profiles).toEqual([{ sessionId: sid(1), version: 4, brand: "Acer", model: "Aspire 14" }]);
    expect(recovered.state.permissions.map((item) => item.state)).toEqual(["active", "outcome_unknown"]);
    const restoredDraft = recovered.state.drafts.get(sid(1));
    expect(restoredDraft?.interpretationPending).toBe(false);
    expect(restoredDraft?.notice).toBe("unavailable");
    expect(restoredDraft?.recommendationClaim).toBe("failed");
    expect(restoredDraft?.confirmedUse).toBe("schoolwork");
    expect(recovered.state.conversations.get(sid(1))?.turns).toEqual([{ role: "shopper", text: "schoolwork" }]);
    expect(recovered.state.grants).toHaveLength(1);
    expect(recovered.interrupted).toEqual({ interpretations: 1, recommendations: 1 });
  });

  it("drops revision markers for revoked and idle sessions and keeps the live session's marker", () => {
    const idle = { ...session(3), lastSeenAt: "2026-10-16T09:00:00.000Z" };
    const body: PublishedBody = {
      ...EMPTY,
      sessions: [session(1), session(2, T0), idle],
      profileRevisions: [
        { sessionId: sid(1), version: 4 },
        { sessionId: sid(2), version: 2 },
        { sessionId: sid(3), version: 9 },
      ],
    };
    const recovered = restoreState(body, new Date(T0));
    expect(recovered.droppedSessions).toBe(2);
    expect(recovered.state.profileRevisions).toEqual([{ sessionId: sid(1), version: 4 }]);
    expect(recovered.state.profiles).toEqual([]);
  });

  it("rewrites a format-5 profile as format 6 without inventing a deletion marker", async () => {
    // Format 5 stored no version after a profile was deleted. Opening it cannot reconstruct that history,
    // so a form issued before this upgrade is not covered by a marker the file never had.
    const profile = { sessionId: sid(1), version: 2, brand: "Acer", model: null };
    const body = { ...base, profiles: [profile] };
    const bytes = file(5, body);
    const older = await open(bytes);
    expect(older.opened.status).toBe("ready");
    if (older.opened.status !== "ready") return;
    const read = older.opened.value.readPublished();
    expect(read.status === "ready" && read.value.format).toBe(5);
    expect(read.status === "ready" && read.value.body.profiles).toEqual([profile]);
    expect(read.status === "ready" && read.value.body.profileRevisions).toEqual([]);
    expect(fs.readFileSync(join(older.directory, "store.json")).equals(bytes)).toBe(true);
    if (read.status !== "ready") return;
    const committed = await older.opened.value.commit(read.value.body);
    expect(committed.status).toBe("ready");
    const written = JSON.parse(fs.readFileSync(join(older.directory, "store.json"), "utf8")) as { format: number; body: PublishedBody };
    expect(written.format).toBe(7);
    expect(written.body.profiles).toEqual([profile]);
    expect(written.body.profileRevisions).toEqual([]);
  });
});

async function snapshotRuntime() {
  let published = structuredClone(EMPTY);
  let refuseWhen: ((body: PublishedBody) => boolean) | null = null;
  let barrier: { started: () => void; released: Promise<void> } | null = null;
  const store: FoundationStore = {
    readPublished: () => ({ status: "ready", value: { format: 6, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } }),
    async commit(body: unknown): Promise<CommitResult> {
      if (barrier) {
        const held = barrier;
        barrier = null;
        held.started();
        await held.released;
      }
      const next = structuredClone(body) as PublishedBody;
      if (refuseWhen?.(next)) return { status: "unavailable", outcome: "definite" };
      published = next;
      return { status: "ready", value: { format: 6, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } };
    },
  };
  const holdNextCommit = () => {
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    barrier = { started, released };
    return { started: startedPromise, release };
  };
  const time = createTestClock(T0);
  const boot = async () => {
    const opened = await recoverStateGate(store, time.clock());
    if (opened.status !== "ready") throw new Error("recovery");
    return createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock, gate: opened.gate });
  };
  return { boot, time, published: () => published, holdNextCommit, refuse: (when: ((body: PublishedBody) => boolean) | null) => (refuseWhen = when) };
}

const drainMicrotasks = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { token, cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

const post = (path: string, fields: Record<string, string>, buyer: { cookie: string }, headers: Record<string, string> = {}) =>
  new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie, ...headers },
    body: new URLSearchParams(fields).toString(),
  });

describe("device profile on the save-first gate", () => {
  const brand = { consent: true, text: "Acer" };

  it("saves before publication, isolates sessions, and keeps the profile across a restart inside the session lifetime", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const a = await shopper(runtime);
    const b = await shopper(runtime);
    const before = world.published().sessions.find((session) => session.id === a.sessionId);
    const saved = await runtime.profiles.save(a.sessionId, write(0, brand));
    expect(saved).toMatchObject({ ok: true, outcome: "saved" });
    expect(world.published().profiles).toEqual([{ sessionId: a.sessionId, version: 1, brand: "Acer", model: null }]);
    expect(runtime.profiles.read(b.sessionId)).toBeNull();
    expect(await runtime.profiles.remove(b.sessionId, 1)).toEqual({ ok: false, code: "VERSION_STALE" });
    expect(world.published().profiles).toHaveLength(1);
    const after = world.published().sessions.find((session) => session.id === a.sessionId);
    expect(after?.absoluteExpiresAt).toBe(before?.absoluteExpiresAt);
    world.time.advance(60_000);
    const restarted = await world.boot();
    expect(restarted.profiles.read(a.sessionId)).toMatchObject({ version: 1, brand: "Acer", model: null });
  });

  it("a save queued behind a logout that is still being saved is refused, and the profile is removed with the revoke", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const a = await shopper(runtime);
    await runtime.profiles.save(a.sessionId, write(0, brand));
    const barrier = world.holdNextCommit();
    let settled = false;
    let logout: Promise<void> | undefined;
    let saving: Promise<unknown> | undefined;
    try {
      logout = runtime.sessions.revoke(a.sessionId);
      await barrier.started;
      saving = runtime.profiles.save(a.sessionId, write(1, { consent: true, text: "Lenovo" })).then((result) => {
        settled = true;
        return result;
      });
      await drainMicrotasks();
      expect(settled).toBe(false);
      expect(world.published().profiles).toHaveLength(1);
      expect(world.published().sessions.find((session) => session.id === a.sessionId)?.revokedAt).toBeNull();
    } finally {
      barrier.release();
    }
    await logout;
    expect(await saving).toEqual({ ok: false, code: "SESSION_NOT_LIVE" });
    expect(world.published().profiles).toEqual([]);
    expect(world.published().sessions.find((session) => session.id === a.sessionId)?.revokedAt).not.toBeNull();
  });

  it("waiting in the queue past idle or absolute expiry refuses the save and does not move the session clocks", async () => {
    for (const wait of [SESSION_IDLE_TIMEOUT_MS, SESSION_ABSOLUTE_LIFETIME_MS]) {
      const world = await snapshotRuntime();
      const runtime = await world.boot();
      const a = await shopper(runtime);
      await runtime.profiles.save(a.sessionId, write(0, brand));
      const absolute = world.published().sessions.find((session) => session.id === a.sessionId)?.absoluteExpiresAt;
      world.time.advance(1000);
      const barrier = world.holdNextCommit();
      const touch = runtime.sessions.resolve(a.token);
      await barrier.started;
      let settled = false;
      const saving = runtime.profiles.save(a.sessionId, write(1, { consent: true, text: "Lenovo" })).then((result) => {
        settled = true;
        return result;
      });
      await drainMicrotasks();
      expect(settled).toBe(false);
      world.time.advance(wait);
      barrier.release();
      await touch;
      expect(await saving).toEqual({ ok: false, code: "SESSION_NOT_LIVE" });
      const session = world.published().sessions.find((item) => item.id === a.sessionId);
      expect(session?.lastSeenAt).toBe(new Date(Date.parse(T0) + 1000).toISOString());
      expect(session?.absoluteExpiresAt).toBe(absolute);
      expect(world.published().profiles).toEqual([{ sessionId: a.sessionId, version: 1, brand: "Acer", model: null }]);
    }
  });

  it("a refused commit publishes nothing and the route answers 503 without a cookie", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const a = await shopper(runtime);
    world.refuse((body) => body.profiles.length > 0);
    const request = post("/shop/profile/save", { csrfToken: a.csrfToken, lang: "en", version: "0", brand: "Acer", model: "", brandConsent: "yes" }, a);
    const response = await withMockRuntime({ mode: "mock", runtime: { ok: true, value: runtime } }, () => handleProfileSave(request, runtime));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(world.published().profiles).toEqual([]);
  });

  it("refuses a stale save and a stale delete from the form, and a repeated or unknown field", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const a = await shopper(runtime);
    const fields = { csrfToken: a.csrfToken, lang: "en", version: "0", brand: "Acer", model: "", brandConsent: "yes" };
    const first = await handleProfileSave(post("/shop/profile/save", fields, a), runtime);
    expect(new URL(first.headers.get("location") ?? "/", SITE).searchParams.get("result")).toBe("saved");
    const stale = await handleProfileSave(post("/shop/profile/save", { ...fields, version: "0", brand: "Lenovo" }, a), runtime);
    expect(new URL(stale.headers.get("location") ?? "/", SITE).searchParams.get("error")).toBe("VERSION_STALE");
    expect(world.published().profiles[0].brand).toBe("Acer");
    const staleDelete = await handleProfileDelete(post("/shop/profile/delete", { csrfToken: a.csrfToken, lang: "en", version: "0" }, a), runtime);
    expect(new URL(staleDelete.headers.get("location") ?? "/", SITE).searchParams.get("error")).toBe("VERSION_STALE");
    expect(world.published().profiles).toHaveLength(1);
    const duplicate = `csrfToken=${a.csrfToken}&csrfToken=${a.csrfToken}&lang=en&version=1&brand=Acer&model=`;
    const malformed = await handleProfileSave(
      new Request(`${SITE}/shop/profile/save`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: a.cookie },
        body: duplicate,
      }),
      runtime,
    );
    expect(new URL(malformed.headers.get("location") ?? "/", SITE).searchParams.get("error")).toBe("MALFORMED");
    const foreign = await handleProfileSave(post("/shop/profile/save", { ...fields, version: "1", sessionId: sid(9) }, a), runtime);
    expect(new URL(foreign.headers.get("location") ?? "/", SITE).searchParams.get("error")).toBe("MALFORMED");
    expect(world.published().profiles).toEqual([{ sessionId: a.sessionId, version: 1, brand: "Acer", model: null }]);
    const removed = await handleProfileDelete(post("/shop/profile/delete", { csrfToken: a.csrfToken, lang: "es", version: "1" }, a), runtime);
    expect(new URL(removed.headers.get("location") ?? "/", SITE).searchParams.get("result")).toBe("removed");
    expect(world.published().profiles).toEqual([]);
  });

  it("rejects a cross-site form and stops counting at the existing confirmation limit", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const a = await shopper(runtime);
    const fields = { csrfToken: a.csrfToken, lang: "en", version: "0", brand: "", model: "" };
    const cross = await handleProfileSave(post("/shop/profile/save", fields, a, { "sec-fetch-site": "cross-site" }), runtime);
    expect(cross.status).toBe(403);
    const missing = await handleProfileSave(post("/shop/profile/save", fields, a, { origin: "" }), runtime);
    expect(missing.status).toBe(403);
    expect(world.published().profiles).toEqual([]);
    for (let n = 0; n < 10; n += 1) {
      const response = await handleProfileSave(post("/shop/profile/save", fields, a), runtime);
      expect(response.status).toBe(303);
    }
    const limited = await handleProfileSave(post("/shop/profile/save", fields, a), runtime);
    expect(limited.status).toBe(429);
    expect(world.published().profiles).toEqual([]);
  });
});

describe("a retained form cannot affect a profile created after deletion", () => {
  async function recreate(restart: boolean) {
    const world = await snapshotRuntime();
    let runtime = await world.boot();
    const buyer = await shopper(runtime);
    const retainedSave = { csrfToken: buyer.csrfToken, lang: "en", version: "1", brand: "Acer", model: "", brandConsent: "yes" };
    const retainedDelete = { csrfToken: buyer.csrfToken, lang: "en", version: "1" };
    const created = await handleProfileSave(post("/shop/profile/save", { ...retainedSave, version: "0" }, buyer), runtime);
    expect(new URL(created.headers.get("location") ?? "/", SITE).searchParams.get("result")).toBe("saved");
    const removed = await handleProfileDelete(post("/shop/profile/delete", retainedDelete, buyer), runtime);
    expect(new URL(removed.headers.get("location") ?? "/", SITE).searchParams.get("result")).toBe("removed");
    const again = await handleProfileSave(
      post("/shop/profile/save", { csrfToken: buyer.csrfToken, lang: "en", version: "0", brand: "Lenovo", model: "", brandConsent: "yes" }, buyer),
      runtime,
    );
    expect(new URL(again.headers.get("location") ?? "/", SITE).searchParams.get("result")).toBe("saved");
    if (restart) runtime = await world.boot();
    return { world, runtime, buyer, retainedSave, retainedDelete };
  }

  const later = (sessionId: string) => [{ sessionId, version: 2, brand: "Lenovo", model: null }];

  it("keeps the recreated profile when the first profile's save form is submitted", async () => {
    const { world, runtime, buyer, retainedSave } = await recreate(false);
    const stale = await handleProfileSave(post("/shop/profile/save", retainedSave, buyer), runtime);
    expect(new URL(stale.headers.get("location") ?? "/", SITE).searchParams.get("error")).toBe("VERSION_STALE");
    expect(world.published().profiles).toEqual(later(buyer.sessionId));
  });

  it("keeps the recreated profile when the first profile's delete form is submitted", async () => {
    const { world, runtime, buyer, retainedDelete } = await recreate(false);
    const stale = await handleProfileDelete(post("/shop/profile/delete", retainedDelete, buyer), runtime);
    expect(new URL(stale.headers.get("location") ?? "/", SITE).searchParams.get("error")).toBe("VERSION_STALE");
    expect(world.published().profiles).toEqual(later(buyer.sessionId));
  });

  it("keeps the recreated profile when the first save form is submitted after a restart", async () => {
    const { world, runtime, buyer, retainedSave } = await recreate(true);
    const stale = await handleProfileSave(post("/shop/profile/save", retainedSave, buyer), runtime);
    expect(new URL(stale.headers.get("location") ?? "/", SITE).searchParams.get("error")).toBe("VERSION_STALE");
    expect(world.published().profiles).toEqual(later(buyer.sessionId));
  });

  it("keeps the recreated profile when the first delete form is submitted after a restart", async () => {
    const { world, runtime, buyer, retainedDelete } = await recreate(true);
    const stale = await handleProfileDelete(post("/shop/profile/delete", retainedDelete, buyer), runtime);
    expect(new URL(stale.headers.get("location") ?? "/", SITE).searchParams.get("error")).toBe("VERSION_STALE");
    expect(world.published().profiles).toEqual(later(buyer.sessionId));
  });

  it("does not let an empty create form overwrite a profile saved after that form was shown", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const buyer = await shopper(runtime);
    const empty = { csrfToken: buyer.csrfToken, lang: "en", version: "0", brand: "Acer", model: "", brandConsent: "yes" };
    const saved = await handleProfileSave(post("/shop/profile/save", { ...empty, brand: "Lenovo" }, buyer), runtime);
    expect(new URL(saved.headers.get("location") ?? "/", SITE).searchParams.get("result")).toBe("saved");
    const stale = await handleProfileSave(post("/shop/profile/save", empty, buyer), runtime);
    expect(new URL(stale.headers.get("location") ?? "/", SITE).searchParams.get("error")).toBe("VERSION_STALE");
    expect(world.published().profiles).toEqual([{ sessionId: buyer.sessionId, version: 1, brand: "Lenovo", model: null }]);
  });
});

describe("revision markers leave with the session and lose a race on the same version", () => {
  const brand = { consent: true, text: "Acer" };

  async function deleted(world: Awaited<ReturnType<typeof snapshotRuntime>>, runtime: Runtime) {
    const buyer = await shopper(runtime);
    expect(await runtime.profiles.save(buyer.sessionId, write(0, brand))).toMatchObject({ ok: true, outcome: "saved" });
    expect(await runtime.profiles.remove(buyer.sessionId, 1)).toMatchObject({ ok: true, outcome: "removed" });
    expect(world.published().profiles).toEqual([]);
    expect(world.published().profileRevisions).toEqual([{ sessionId: buyer.sessionId, version: 1 }]);
    return buyer;
  }

  it("removes the marker when the session is logged out", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const buyer = await deleted(world, runtime);
    await runtime.sessions.revoke(buyer.sessionId);
    expect(world.published().profiles).toEqual([]);
    expect(world.published().profileRevisions).toEqual([]);
  });

  it("removes the marker when idle expiry or the absolute lifetime reclaims the session", async () => {
    for (const wait of [SESSION_IDLE_TIMEOUT_MS, SESSION_ABSOLUTE_LIFETIME_MS]) {
      const world = await snapshotRuntime();
      const runtime = await world.boot();
      const buyer = await deleted(world, runtime);
      if (wait === SESSION_ABSOLUTE_LIFETIME_MS) {
        const step = 60 * 60 * 1000;
        let remaining = wait - 1000;
        while (remaining > 0) {
          world.time.advance(Math.min(step, remaining));
          expect((await runtime.sessions.resolve(buyer.token)).ok).toBe(true);
          remaining -= Math.min(step, remaining);
        }
        world.time.advance(1000);
      } else {
        world.time.advance(wait);
      }
      expect(await runtime.sessions.purgeExpired()).toBe(1);
      expect(world.published().sessions.find((session) => session.id === buyer.sessionId)).toBeUndefined();
      expect(world.published().profileRevisions).toEqual([]);
    }
  });

  it("lets the first of two saves with the same version win and refuses the second", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const buyer = await shopper(runtime);
    await runtime.profiles.save(buyer.sessionId, write(0, brand));
    const barrier = world.holdNextCommit();
    let settled = false;
    const first = runtime.profiles.save(buyer.sessionId, write(1, { consent: true, text: "Lenovo" })).then((result) => {
      settled = true;
      return result;
    });
    await barrier.started;
    const second = runtime.profiles.save(buyer.sessionId, write(1, { consent: true, text: "Other" }));
    await drainMicrotasks();
    expect(settled).toBe(false);
    barrier.release();
    expect(await first).toMatchObject({ ok: true, outcome: "saved" });
    expect(await second).toEqual({ ok: false, code: "VERSION_STALE" });
    expect(world.published().profiles).toEqual([{ sessionId: buyer.sessionId, version: 2, brand: "Lenovo", model: null }]);
    expect(world.published().profileRevisions).toEqual([]);
  });

  it("lets the first of two deletes with the same version win and leaves that marker", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const buyer = await shopper(runtime);
    await runtime.profiles.save(buyer.sessionId, write(0, brand));
    const barrier = world.holdNextCommit();
    let settled = false;
    const first = runtime.profiles.remove(buyer.sessionId, 1).then((result) => {
      settled = true;
      return result;
    });
    await barrier.started;
    const second = runtime.profiles.remove(buyer.sessionId, 1);
    await drainMicrotasks();
    expect(settled).toBe(false);
    barrier.release();
    expect(await first).toMatchObject({ ok: true, outcome: "removed" });
    expect(await second).toEqual({ ok: false, code: "VERSION_STALE" });
    expect(world.published().profiles).toEqual([]);
    expect(world.published().profileRevisions).toEqual([{ sessionId: buyer.sessionId, version: 1 }]);
  });

  it("does not publish a deletion marker when the commit is refused", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const buyer = await shopper(runtime);
    await runtime.profiles.save(buyer.sessionId, write(0, brand));
    world.refuse((body) => body.profileRevisions.length > 0);
    await expect(runtime.profiles.remove(buyer.sessionId, 1)).rejects.toBeInstanceOf(PersistenceUnavailableError);
    expect(world.published().profiles).toEqual([{ sessionId: buyer.sessionId, version: 1, brand: "Acer", model: null }]);
    expect(world.published().profileRevisions).toEqual([]);
  });
});
