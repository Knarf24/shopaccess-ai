import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { isPersistenceUnavailable, memoryDurableHost, snapshotDurableHost } from "../../src/lib/session/durable";
import { createPairingAuthority, GRANT_LIFETIME_MS, PAIRING_LIFETIME_MS, type PairingDeps } from "../../src/lib/session/grants";
import { bodyFromState, createStateGate, restoreState, type DurableState } from "../../src/lib/session/snapshot-state";
import type { CommitResult, PublishedBody } from "../../src/lib/session/snapshot-store";
import { InMemorySessionStore, type SessionRecord } from "../../src/lib/session/store";

// M2-2 slice 1: pairing and durable extension grants (docs/m2-2-plan.md §3.2–3.3).
const T0 = new Date("2026-10-16T12:00:00.000Z");
const EXT = `chrome-extension://${"a".repeat(32)}`;
const OTHER_EXT = `chrome-extension://${"b".repeat(32)}`;
const INSTALL_A = `ins_${"1".repeat(32)}`;
const INSTALL_B = `ins_${"2".repeat(32)}`;
const KEY = Buffer.alloc(32, 9);
const verifierFor = (n: number) => n.toString(16).padStart(64, "0");
const challengeFor = (n: number) => createHash("sha256").update(verifierFor(n)).digest("hex");
const sid = (n: number) => `ses_${n.toString(16).padStart(32, "0")}`;

function session(n: number, createdAt = T0): SessionRecord {
  return { id: sid(n), tokenDigest: (n + 8).toString(16).padStart(64, "0"), createdAt, lastSeenAt: createdAt, absoluteExpiresAt: new Date(createdAt.getTime() + 24 * 3_600_000), revokedAt: null };
}

function memoryWorld(live = new Set([sid(1), sid(2)]), expires = new Map<string, Date>()) {
  const durable = memoryDurableHost({}, new InMemorySessionStore(), { windowStartedAt: null, count: 0 });
  let counter = 0;
  const deps: PairingDeps = {
    durable,
    key: KEY,
    sessionLive: (id) => live.has(id),
    sessionExpiresAt: (id) => (live.has(id) ? (expires.get(id) ?? new Date(T0.getTime() + 24 * 3_600_000)) : null),
    random: (bytes) => Buffer.from((++counter).toString(16).padStart(bytes * 2, "0"), "hex"),
  };
  return { durable, authority: createPairingAuthority(deps), live };
}

type World = ReturnType<typeof memoryWorld>;

async function pair(world: World, opts: { session?: number; installation?: string; origin?: string; n?: number; at?: Date; boundMs?: number | null } = {}) {
  const at = opts.at ?? T0;
  const n = opts.n ?? 1;
  const origin = opts.origin ?? EXT;
  const started = world.authority.start({ challenge: challengeFor(n), extensionOrigin: origin, installationId: opts.installation ?? INSTALL_A }, at.getTime());
  if (!started.ok) throw new Error(started.code);
  const approved = world.authority.approve({ pairingId: started.value.pairingId, sessionId: sid(opts.session ?? 1), deny: false, boundMs: opts.boundMs ?? null }, at.getTime());
  if (!approved.ok) throw new Error(approved.code);
  return world.authority.exchange({ pairingId: started.value.pairingId, exchangeSecret: started.value.exchangeSecret, verifier: verifierFor(n), extensionOrigin: origin }, at);
}

describe("pairing", () => {
  it("validates the challenge, installation and extension origin, and limits starts per minute", () => {
    const { authority } = memoryWorld();
    expect(authority.start({ challenge: "x", extensionOrigin: EXT, installationId: INSTALL_A }, T0.getTime())).toEqual({ ok: false, code: "BAD_REQUEST" });
    expect(authority.start({ challenge: challengeFor(1), extensionOrigin: EXT, installationId: "ins_bad" }, T0.getTime())).toEqual({ ok: false, code: "BAD_REQUEST" });
    expect(authority.start({ challenge: challengeFor(1), extensionOrigin: "https://evil.test", installationId: INSTALL_A }, T0.getTime())).toEqual({ ok: false, code: "BAD_REQUEST" });
    for (let i = 0; i < 30; i += 1) expect(authority.start({ challenge: challengeFor(1), extensionOrigin: EXT, installationId: INSTALL_A }, T0.getTime()).ok).toBe(true);
    expect(authority.start({ challenge: challengeFor(1), extensionOrigin: EXT, installationId: INSTALL_A }, T0.getTime())).toEqual({ ok: false, code: "RATE_LIMIT" });
    expect(authority.start({ challenge: challengeFor(1), extensionOrigin: EXT, installationId: INSTALL_A }, T0.getTime() + 60_000).ok).toBe(true);
  });

  it("polls only with the right secret and origin, at most ten times, two seconds apart", () => {
    const { authority } = memoryWorld();
    const started = authority.start({ challenge: challengeFor(1), extensionOrigin: EXT, installationId: INSTALL_A }, T0.getTime());
    if (!started.ok) throw new Error();
    const poll = (atMs: number, secret: unknown = started.value.exchangeSecret, origin = EXT) => authority.status({ pairingId: started.value.pairingId, exchangeSecret: secret, extensionOrigin: origin }, atMs);
    expect(poll(T0.getTime(), "0".repeat(64))).toEqual({ ok: false, code: "PAIRING_UNKNOWN" });
    expect(poll(T0.getTime(), started.value.exchangeSecret, OTHER_EXT)).toEqual({ ok: false, code: "PAIRING_UNKNOWN" });
    expect(poll(T0.getTime())).toEqual({ ok: true, value: { status: "pending" } });
    expect(poll(T0.getTime() + 1_000)).toEqual({ ok: false, code: "POLL_TOO_SOON" });
    for (let i = 1; i < 10; i += 1) expect(poll(T0.getTime() + i * 2_000).ok).toBe(true);
    expect(poll(T0.getTime() + 30_000)).toEqual({ ok: false, code: "POLL_LIMIT" });
  });

  it("approves only for a live session, at most three approved pairings per session, and decides once", () => {
    const { authority, live } = memoryWorld();
    const start = (n: number) => {
      const s = authority.start({ challenge: challengeFor(n), extensionOrigin: EXT, installationId: INSTALL_A }, T0.getTime());
      if (!s.ok) throw new Error();
      return s.value.pairingId;
    };
    live.delete(sid(2));
    expect(authority.approve({ pairingId: start(1), sessionId: sid(2), deny: false, boundMs: null }, T0.getTime())).toEqual({ ok: false, code: "SESSION_INVALID" });
    const ids = [start(2), start(3), start(4), start(5)];
    for (const id of ids.slice(0, 3)) expect(authority.approve({ pairingId: id, sessionId: sid(1), deny: false, boundMs: null }, T0.getTime()).ok).toBe(true);
    expect(authority.approve({ pairingId: ids[3]!, sessionId: sid(1), deny: false, boundMs: null }, T0.getTime())).toEqual({ ok: false, code: "PAIRING_LIMIT" });
    expect(authority.approve({ pairingId: ids[0]!, sessionId: sid(1), deny: true, boundMs: null }, T0.getTime())).toEqual({ ok: false, code: "PAIRING_ALREADY_DECIDED" });
  });

  it("exchanges once, only with the verifier, never when denied or expired", async () => {
    const world = memoryWorld();
    const s = world.authority.start({ challenge: challengeFor(7), extensionOrigin: EXT, installationId: INSTALL_A }, T0.getTime());
    if (!s.ok) throw new Error();
    const exchange = (verifier: string, at = T0) => world.authority.exchange({ pairingId: s.value.pairingId, exchangeSecret: s.value.exchangeSecret, verifier, extensionOrigin: EXT }, at);
    expect(await exchange(verifierFor(7))).toEqual({ ok: false, code: "PAIRING_NOT_APPROVED" });
    world.authority.approve({ pairingId: s.value.pairingId, sessionId: sid(1), deny: false, boundMs: null }, T0.getTime());
    expect(await exchange(verifierFor(8))).toEqual({ ok: false, code: "VERIFIER_INVALID" });
    const first = await exchange(verifierFor(7));
    expect(first.ok).toBe(true);
    expect(await exchange(verifierFor(7))).toEqual({ ok: false, code: "PAIRING_NOT_APPROVED" });

    const denied = world.authority.start({ challenge: challengeFor(9), extensionOrigin: EXT, installationId: INSTALL_B }, T0.getTime());
    if (!denied.ok) throw new Error();
    world.authority.approve({ pairingId: denied.value.pairingId, sessionId: sid(1), deny: true, boundMs: null }, T0.getTime());
    expect(await world.authority.exchange({ pairingId: denied.value.pairingId, exchangeSecret: denied.value.exchangeSecret, verifier: verifierFor(9), extensionOrigin: EXT }, T0)).toEqual({ ok: false, code: "PAIRING_NOT_APPROVED" });

    const late = world.authority.start({ challenge: challengeFor(10), extensionOrigin: EXT, installationId: INSTALL_B }, T0.getTime());
    if (!late.ok) throw new Error();
    world.authority.approve({ pairingId: late.value.pairingId, sessionId: sid(1), deny: false, boundMs: null }, T0.getTime());
    expect(await world.authority.exchange({ pairingId: late.value.pairingId, exchangeSecret: late.value.exchangeSecret, verifier: verifierFor(10), extensionOrigin: EXT }, new Date(T0.getTime() + PAIRING_LIFETIME_MS))).toEqual({ ok: false, code: "PAIRING_EXPIRED" });
  });
});

describe("grants", () => {
  it("bounds a grant by one hour, the session's absolute expiry and the admission expiry", async () => {
    const plain = await pair(memoryWorld());
    expect(plain.ok && plain.value.expiresAt).toBe(T0.getTime() + GRANT_LIFETIME_MS);
    const shortSession = await pair(memoryWorld(new Set([sid(1)]), new Map([[sid(1), new Date(T0.getTime() + 600_000)]])));
    expect(shortSession.ok && shortSession.value.expiresAt).toBe(T0.getTime() + 600_000);
    const admitted = await pair(memoryWorld(), { boundMs: T0.getTime() + 120_000 });
    expect(admitted.ok && admitted.value.expiresAt).toBe(T0.getTime() + 120_000);
  });

  it("resolves only the right scope, origin, unexpired token and live session", async () => {
    const world = memoryWorld();
    const granted = await pair(world);
    if (!granted.ok) throw new Error();
    const { bearer } = granted.value;
    expect(world.authority.resolve(bearer, "conversation:read", EXT, T0)).toEqual({ ok: true, value: { sessionId: sid(1), grantId: granted.value.grantId } });
    expect(world.authority.resolve(bearer, "conversation:read", null, T0).ok).toBe(true);
    expect(world.authority.resolve(bearer, "conversation:read", OTHER_EXT, T0)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(world.authority.resolve("0".repeat(64), "conversation:read", EXT, T0)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(world.authority.resolve(null, "conversation:read", EXT, T0)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(world.authority.resolve(bearer, "conversation:read", EXT, new Date(granted.value.expiresAt))).toEqual({ ok: false, code: "TOKEN_INVALID" });
    world.live.delete(sid(1));
    expect(world.authority.resolve(bearer, "conversation:read", EXT, T0)).toEqual({ ok: false, code: "TOKEN_INVALID" });
  });

  it("replaces the same installation's grant atomically; other installations coexist; a fourth is refused", async () => {
    const world = memoryWorld();
    const a1 = await pair(world, { n: 1, installation: INSTALL_A });
    const a2 = await pair(world, { n: 2, installation: INSTALL_A });
    if (!a1.ok || !a2.ok) throw new Error();
    expect(world.authority.resolve(a1.value.bearer, "conversation:read", EXT, T0)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(world.authority.resolve(a2.value.bearer, "conversation:read", EXT, T0).ok).toBe(true);
    expect(world.authority.list(sid(1), T0).map((g) => g.grantId)).toEqual([a2.value.grantId]);
    const b = await pair(world, { n: 3, installation: INSTALL_B });
    const c = await pair(world, { n: 4, installation: `ins_${"3".repeat(32)}` });
    expect(b.ok && c.ok).toBe(true);
    expect(world.authority.list(sid(1), T0)).toHaveLength(3);
    expect(await pair(world, { n: 5, installation: `ins_${"4".repeat(32)}` })).toEqual({ ok: false, code: "GRANT_LIMIT" });
    const again = await pair(world, { n: 6, installation: INSTALL_B });
    expect(again.ok).toBe(true);
    expect(world.authority.list(sid(1), T0)).toHaveLength(3);
    expect(world.authority.list(sid(2), T0)).toHaveLength(0);
  });

  it("revokes one grant for its own session only", async () => {
    const world = memoryWorld();
    const granted = await pair(world);
    if (!granted.ok) throw new Error();
    expect(await world.authority.revoke(sid(2), granted.value.grantId, T0)).toBe("unknown");
    expect(world.authority.resolve(granted.value.bearer, "conversation:read", EXT, T0).ok).toBe(true);
    expect(await world.authority.revoke(sid(1), granted.value.grantId, T0)).toBe("revoked");
    expect(world.authority.resolve(granted.value.bearer, "conversation:read", EXT, T0)).toEqual({ ok: false, code: "TOKEN_INVALID" });
    expect(await world.authority.revoke(sid(1), granted.value.grantId, T0)).toBe("unknown");
  });
});

describe("durable grants (snapshot gate)", () => {
  const EMPTY_STATE = (sessions: SessionRecord[]): DurableState => ({ sessions, drafts: new Map(), conversations: new Map(), selections: new Map(), windows: { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 } }, grants: [], permissions: [], profiles: [], profileRevisions: [] });

  function snapshotWorld(refuse: () => boolean = () => false) {
    let published: PublishedBody | null = null;
    const gate = createStateGate(
      {
        async commit(body: unknown): Promise<CommitResult> {
          if (refuse()) return { status: "unavailable", outcome: "definite" };
          published = structuredClone(body) as PublishedBody;
          return { status: "ready", value: { format: 3, identity: "0".repeat(64), sha256: "0".repeat(64), body: published } };
        },
      },
      EMPTY_STATE([session(1)]),
    );
    const durable = snapshotDurableHost(gate, {});
    let counter = 100;
    const authority = createPairingAuthority({
      durable,
      key: KEY,
      sessionLive: (id) => id === sid(1),
      sessionExpiresAt: () => new Date(T0.getTime() + 24 * 3_600_000),
      random: (bytes) => Buffer.from((++counter).toString(16).padStart(bytes * 2, "0"), "hex"),
    });
    return { authority, published: () => published, live: new Set([sid(1)]) };
  }

  it("persists only the token digest, and a grant survives a restart while a revoked one does not", async () => {
    const world = snapshotWorld();
    const granted = await pair(world as unknown as World);
    if (!granted.ok) throw new Error();
    const body = world.published()!;
    expect(body.grants).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(granted.value.bearer);
    const restored = restoreState(body, new Date(T0.getTime() + 60_000));
    expect(restored.state.grants.map((g) => g.grantId)).toEqual([granted.value.grantId]);
    await world.authority.revoke(sid(1), granted.value.grantId, T0);
    expect(world.published()!.grants).toEqual([]);
    expect(restoreState(bodyFromState({ ...EMPTY_STATE([session(1)]), grants: restored.state.grants }), new Date(T0.getTime() + GRANT_LIFETIME_MS)).state.grants).toEqual([]);
  });

  it("a refused save publishes no grant and no usable token", async () => {
    let refuse = false;
    const world = snapshotWorld(() => refuse);
    const started = world.authority.start({ challenge: challengeFor(1), extensionOrigin: EXT, installationId: INSTALL_A }, T0.getTime());
    if (!started.ok) throw new Error();
    world.authority.approve({ pairingId: started.value.pairingId, sessionId: sid(1), deny: false, boundMs: null }, T0.getTime());
    refuse = true;
    await expect(world.authority.exchange({ pairingId: started.value.pairingId, exchangeSecret: started.value.exchangeSecret, verifier: verifierFor(1), extensionOrigin: EXT }, T0)).rejects.toSatisfy(isPersistenceUnavailable);
    expect(world.published()).toBeNull();
    // The gate is now blocked: grants cannot even be read, so no token can be resolved.
    expect(() => world.authority.list(sid(1), T0)).toThrow(/could not be saved/);
    expect(() => world.authority.resolve("0".repeat(64), "conversation:read", EXT, T0)).toThrow(/could not be saved/);
  });
});
