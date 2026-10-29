import { revokeSessionPermissions } from "../permissions/model";
import { chargerTracksOf, deleteChargerTracks, replaceChargerTracks, type ChargerTrack } from "./charger-clarification";
import { conversationStateOf, replaceConversationState } from "./conversation";
import { replaceUnrecoveredWorkloadDrafts, replaceWorkloadRecords, unrecoveredWorkloadDraftsOf, workloadRecordsOf } from "./workload-state";
import type { DurableState, PersistedDeviceProfile, PersistedGrant, PersistedPermission, PersistedProfileRevision, StateGate, Windows } from "./snapshot-state";
import { needsDraftsFor, replaceNeedsDrafts, type InMemorySessionStore, type SessionRecord, type SessionStore } from "./store";

/**
 * Durable decisions for the mock runtime (M2-1, docs/m2-1-plan.md §9).
 *
 * `memory` is today's behaviour: changes run directly on the in-memory host and always succeed.
 * `snapshot` runs every change as a save-first gate decision: on a scratch copy of the published state, committed,
 * and published into the runtime's maps only after the commit is durable. A refused commit throws
 * `PersistenceUnavailableError`; nothing is published, and the caller must not report success or start a provider.
 */

/** Thrown when a decision could not be saved, or the gate is already blocked. Routes answer 503; pages show the notice. */
export class PersistenceUnavailableError extends Error {
  readonly code = "PERSISTENCE_UNAVAILABLE";
  constructor() {
    super("Shopper state could not be saved.");
    this.name = "PersistenceUnavailableError";
  }
}

export function isPersistenceUnavailable(error: unknown): error is PersistenceUnavailableError {
  return error instanceof PersistenceUnavailableError;
}

/** A fixed window: at most `limit` events per `windowMs`, counted from the first event of the window. */
export interface WindowPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

export type WindowDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

/** Which admission window an allowed attempt was counted in. Only that window can take the attempt back. */
export interface AdmissionReservation {
  readonly windowStartedAt: number;
}

export type AdmissionDecision = { readonly allowed: true; readonly reservation: AdmissionReservation } | { readonly allowed: false; readonly retryAfterMs: number };

type WindowState = { readonly windowStartedAt: number | null; readonly count: number };

/**
 * Counts one event. A full window refuses; a refused event is not counted. `countRefused` keeps the admission rule:
 * every verification attempt counts, including refused ones.
 */
export function spendWindow(window: WindowState, nowMs: number, policy: WindowPolicy, countRefused: boolean): { next: WindowState; decision: WindowDecision } {
  // A backward clock does not reset a window whose start is still ahead of now.
  const fresh = window.windowStartedAt === null || nowMs >= window.windowStartedAt + policy.windowMs;
  const start = fresh ? nowMs : (window.windowStartedAt as number);
  const count = fresh ? 0 : window.count;
  if (count >= policy.limit) {
    const retryAfterMs = start + policy.windowMs - nowMs;
    return { next: countRefused ? { windowStartedAt: start, count: Math.min(count + 1, Number.MAX_SAFE_INTEGER) } : { windowStartedAt: start, count }, decision: { allowed: false, retryAfterMs } };
  }
  return { next: { windowStartedAt: start, count: count + 1 }, decision: { allowed: true } };
}

/**
 * Gives back one attempt to the window it was reserved in. Once a newer window has started, or on an empty window, nothing
 * changes: a request that finishes late can never return an attempt of a window it did not spend in.
 */
export function refundWindow(window: WindowState, reservation: AdmissionReservation): WindowState {
  if (window.windowStartedAt !== reservation.windowStartedAt || window.count === 0) return window;
  return { windowStartedAt: window.windowStartedAt, count: window.count - 1 };
}

function reserved(next: WindowState, decision: WindowDecision): AdmissionDecision {
  return decision.allowed ? { allowed: true, reservation: { windowStartedAt: next.windowStartedAt as number } } : decision;
}

export interface LiveSessionStore extends SessionStore {
  /** Synchronous liveness on the published state; false when unavailable. */
  isLive(sessionId: string, now: Date, idleTimeoutMs: number): boolean;
  /** Absolute expiry of a stored, unrevoked session on the published state, or null. */
  absoluteExpiryOf(sessionId: string): Date | null;
  /** When a stored, unrevoked session stops being live (idle or absolute), on the published state, or null. */
  liveUntil(sessionId: string, idleTimeoutMs: number): number | null;
}

/**
 * The result type a `change` callback may have: `T` itself, or `never` when `T` is (or may be) a promise or other
 * thenable. A callback runs as one synchronous decision (snapshot mode commits right after it returns; memory mode
 * cleans up in the same step), so awaited work must stay outside it. `any` is rejected because it cannot be shown not to
 * be a promise; `unknown` and every non-thenable type keep their exact type.
 */
export type SynchronousResult<T> = T & ([Extract<T, { readonly then: unknown }>] extends [never] ? unknown : never);

export interface DurableHost {
  readonly mode: "memory" | "snapshot";
  /**
   * Runs a draft, conversation or selection change against `host`. In snapshot mode the change runs at the head of
   * the writer queue on a copy of the published state and is published only after it is durable.
   */
  change<T>(change: (host: object) => SynchronousResult<T>): Promise<T>;
  readonly sessionStore: LiveSessionStore;
  /** Durable before it is relied on. */
  spendAllocation(nowMs: number, policy: WindowPolicy): Promise<WindowDecision>;
  /** Durable before the passphrase is checked. Every attempt counts until a matching passphrase refunds its own. */
  spendAdmissionAttempt(nowMs: number, policy: WindowPolicy): Promise<AdmissionDecision>;
  /** Gives back the attempt a matching passphrase spent, so only wrong passphrases fill the window (durable in snapshot mode). */
  refundAdmissionAttempt(reservation: AdmissionReservation): Promise<void>;
  /** False once a save was refused (snapshot mode only). */
  available(): boolean;
  /** Extension grants as last published (never a candidate). */
  readGrants(): readonly PersistedGrant[];
  /**
   * Runs a grant decision against the published grants. A returned `grants` list replaces them and is durable before
   * the value is returned (snapshot mode); a refused save throws PersistenceUnavailableError.
   */
  decideGrants<T>(decide: (grants: readonly PersistedGrant[]) => { readonly value: T; readonly grants?: readonly PersistedGrant[] }): Promise<T>;
  /** F07 purchase permissions as last published (never a candidate). */
  readPermissions(): readonly PersistedPermission[];
  /**
   * Runs a permission decision against the published permissions. A returned `permissions` list replaces them and is
   * durable before the value is returned (snapshot mode); a refused save throws PersistenceUnavailableError.
   */
  decidePermissions<T>(
    decide: (permissions: readonly PersistedPermission[]) => { readonly value: T; readonly permissions?: readonly PersistedPermission[] },
  ): Promise<T>;
  /** Device profiles as last published (never a candidate). */
  readProfiles(): readonly PersistedDeviceProfile[];
  /**
   * Runs a profile decision against the published profiles. A returned `profiles` list replaces them and is durable
   * before the value is returned (snapshot mode); a refused save throws PersistenceUnavailableError.
   */
  decideProfiles<T>(
    decide: (
      profiles: readonly PersistedDeviceProfile[],
      revisions: readonly PersistedProfileRevision[],
    ) => { readonly value: T; readonly profiles?: readonly PersistedDeviceProfile[]; readonly revisions?: readonly PersistedProfileRevision[] },
  ): Promise<T>;
}

/**
 * Keeps only charger tracks whose session still has the draft they were made for. The same rule applies in both modes:
 * `withHost` (snapshot) and every memory-mode change. A track installed for a replacement draft in the same change is
 * kept; the old draft's track is removed.
 */
function tracksMatchingDrafts(host: object): Array<[string, ChargerTrack]> {
  const drafts = needsDraftsFor(host);
  return [...chargerTracksOf(host)].filter(([sessionId, track]) => drafts.get(sessionId)?.draftId === track.draftId);
}

/**
 * Today's behaviour: one process, in memory. Logout and expiry also drop the session's charger track, and every change
 * removes a track whose draft it deleted or replaced (format-7 slice 1).
 */
export function memoryDurableHost(store: object, sessionStore: InMemorySessionStore, admissionAttempts: { windowStartedAt: number | null; count: number }): DurableHost {
  let allocation: WindowState = { windowStartedAt: null, count: 0 };
  let grants: readonly PersistedGrant[] = [];
  // Memory mode keeps nothing across a restart. A logged-out session's permissions give no authority because authority
  // requires a live session; snapshot mode also revokes them durably at logout.
  let permissions: readonly PersistedPermission[] = [];
  let profiles: readonly PersistedDeviceProfile[] = [];
  let profileRevisions: readonly PersistedProfileRevision[] = [];
  const dropProfiles = (sessionIds: readonly string[]) => {
    if (sessionIds.length === 0) return;
    const gone = new Set(sessionIds);
    profiles = profiles.filter((profile) => !gone.has(profile.sessionId));
    profileRevisions = profileRevisions.filter((revision) => !gone.has(revision.sessionId));
  };
  const sessions: LiveSessionStore = {
    insertWithinCapacity: (record, maxSessions) => sessionStore.insertWithinCapacity(record, maxSessions),
    findByTokenDigest: (tokenDigest) => sessionStore.findByTokenDigest(tokenDigest),
    touch: (id, lastSeenAt) => sessionStore.touch(id, lastSeenAt),
    replaceTokenDigest: (id, expectedDigest, newDigest, at) => sessionStore.replaceTokenDigest(id, expectedDigest, newDigest, at),
    revoke: async (id, at) => {
      await sessionStore.revoke(id, at);
      dropProfiles([id]);
      deleteChargerTracks(store, [id]);
    },
    deleteExpired: async (now, idleCutoff) => {
      const removed = await sessionStore.deleteExpired(now, idleCutoff);
      dropProfiles(removed);
      deleteChargerTracks(store, removed);
      return removed;
    },
    count: () => sessionStore.count(),
    isLive: (sessionId, now, idleTimeoutMs) => sessionStore.isLive(sessionId, now, idleTimeoutMs),
    absoluteExpiryOf: (sessionId) => sessionStore.absoluteExpiryOf(sessionId),
    liveUntil: (sessionId, idleTimeoutMs) => sessionStore.liveUntil(sessionId, idleTimeoutMs),
  };
  return {
    mode: "memory",
    async change(change) {
      try {
        return change(store);
      } finally {
        // Memory mode has no rollback: even a change that throws after deleting a draft leaves no stale track.
        replaceChargerTracks(store, tracksMatchingDrafts(store));
      }
    },
    sessionStore: sessions,
    async spendAllocation(nowMs, policy) {
      const spent = spendWindow(allocation, nowMs, policy, false);
      allocation = spent.next;
      return spent.decision;
    },
    async spendAdmissionAttempt(nowMs, policy) {
      const spent = spendWindow(admissionAttempts, nowMs, policy, true);
      admissionAttempts.windowStartedAt = spent.next.windowStartedAt;
      admissionAttempts.count = spent.next.count;
      return reserved(spent.next, spent.decision);
    },
    async refundAdmissionAttempt(reservation) {
      const next = refundWindow(admissionAttempts, reservation);
      admissionAttempts.windowStartedAt = next.windowStartedAt;
      admissionAttempts.count = next.count;
    },
    available: () => true,
    readGrants: () => grants,
    async decideGrants(decide) {
      const decision = decide(grants);
      if (decision.grants) grants = decision.grants;
      return decision.value;
    },
    readPermissions: () => permissions,
    async decidePermissions(decide) {
      const decision = decide(permissions);
      if (decision.permissions) permissions = decision.permissions;
      return decision.value;
    },
    readProfiles: () => profiles,
    async decideProfiles(decide) {
      const decision = decide(profiles, profileRevisions);
      if (decision.profiles) profiles = decision.profiles;
      if (decision.revisions) profileRevisions = decision.revisions;
      return decision.value;
    },
  };
}

/** Copies a durable state's drafts, conversations, selections and charger tracks into a host object (scratch or published). */
function load(host: object, state: DurableState): void {
  const ids = new Set(state.sessions.map((session) => session.id));
  replaceNeedsDrafts(host, [...state.drafts].filter(([sessionId]) => ids.has(sessionId)));
  replaceConversationState(host, {
    conversations: new Map([...state.conversations].filter(([sessionId]) => ids.has(sessionId))),
    selections: new Map([...state.selections].filter(([sessionId]) => ids.has(sessionId))),
  });
  replaceChargerTracks(host, [...state.chargerTracks].filter(([sessionId]) => ids.has(sessionId)));
  const liveDraftIds = new Set([...state.drafts].filter(([sessionId]) => ids.has(sessionId)).map(([, draft]) => draft.draftId));
  replaceUnrecoveredWorkloadDrafts(host, [...(state.unrecoveredWorkloadDrafts ?? [])].filter((id) => liveDraftIds.has(id)));
  replaceWorkloadRecords(
    host,
    new Map(
      [...(state.workloads ?? new Map())].filter(
        ([sessionId, record]) =>
          ids.has(sessionId) &&
          state.drafts.get(sessionId)?.draftId === record.draftId,
      ),
    ),
  );
}

/**
 * The next state from a scratch host. A charger track whose draft is gone or replaced in this same change is dropped
 * here, so it never outlives its draft in the published state.
 */
function withHost(state: DurableState, host: object): DurableState {
  const conversation = conversationStateOf(host);
  return { ...state, drafts: new Map(needsDraftsFor(host)), conversations: conversation.conversations, selections: conversation.selections, chargerTracks: new Map(tracksMatchingDrafts(host)), unrecoveredWorkloadDrafts: new Set(
    [...unrecoveredWorkloadDraftsOf(host)].filter((id) => [...needsDraftsFor(host).values()].some((draft) => draft.draftId === id)),
  ), workloads: state.workloads === undefined
      ? undefined
      : new Map(
          [...workloadRecordsOf(host)].filter(
            ([sessionId, record]) =>
              state.sessions.some((session) => session.id === sessionId) &&
              needsDraftsFor(host).get(sessionId)?.draftId === record.draftId,
          ),
        ) };
}

/** Drops everything a removed session owned, in the same state. */
function withoutSessions(state: DurableState, removed: ReadonlySet<string>): DurableState {
  const keep = <V>(map: ReadonlyMap<string, V>) => new Map([...map].filter(([sessionId]) => !removed.has(sessionId)));
  return {
    ...state,
    sessions: state.sessions.filter((s) => !removed.has(s.id)),
    drafts: keep(state.drafts),
    conversations: keep(state.conversations),
    selections: keep(state.selections),
    chargerTracks: keep(state.chargerTracks),
    grants: state.grants.filter((grant) => !removed.has(grant.sessionId)),
    permissions: state.permissions.filter((permission) => !removed.has(permission.sessionId)),
    profiles: state.profiles.filter((profile) => !removed.has(profile.sessionId)),
    profileRevisions: state.profileRevisions.filter((revision) => !removed.has(revision.sessionId)),
  };
}

/**
 * Snapshot mode. `published` is the runtime's real host (the checkout store object): its draft, conversation and
 * selection maps always hold the last durable state. Session reads use the gate's published state.
 */
export function snapshotDurableHost(gate: StateGate, published: object): DurableHost {
  const current = (): DurableState => {
    const read = gate.read();
    if (read.status !== "ready") throw new PersistenceUnavailableError();
    return read.state;
  };
  load(published, current());
  gate.subscribe((state) => load(published, state));

  const decide = async <T>(decision: (state: DurableState) => { value: T; next?: DurableState }): Promise<T> => {
    const decided = await gate.decide(decision);
    if (decided.status !== "done") throw new PersistenceUnavailableError();
    return decided.value;
  };
  const replaceSession = (state: DurableState, record: SessionRecord): DurableState => ({ ...state, sessions: state.sessions.map((s) => (s.id === record.id ? record : s)) });

  const sessionStore: LiveSessionStore = {
    insertWithinCapacity: (record, maxSessions) =>
      decide((state) => {
        if (state.sessions.length >= maxSessions) return { value: false };
        if (state.sessions.some((s) => s.id === record.id)) throw new Error("Duplicate session id");
        if (state.sessions.some((s) => s.tokenDigest === record.tokenDigest)) throw new Error("Duplicate session token digest");
        return { value: true, next: { ...state, sessions: [...state.sessions, record] } };
      }),
    findByTokenDigest: async (tokenDigest) => current().sessions.find((s) => s.tokenDigest === tokenDigest) ?? null,
    touch: (id, lastSeenAt) =>
      decide((state) => {
        const record = state.sessions.find((s) => s.id === id);
        // A backward clock never moves lastSeenAt back; nothing past the absolute expiry is written.
        if (!record || lastSeenAt.getTime() < record.lastSeenAt.getTime() || lastSeenAt.getTime() > record.absoluteExpiresAt.getTime()) return { value: undefined };
        return { value: undefined, next: replaceSession(state, { ...record, lastSeenAt }) };
      }),
    replaceTokenDigest: (id, expectedDigest, newDigest, at) =>
      decide((state) => {
        const record = state.sessions.find((s) => s.id === id);
        if (!record || record.tokenDigest !== expectedDigest || record.revokedAt) return { value: false };
        if (at.getTime() < record.lastSeenAt.getTime() || at.getTime() > record.absoluteExpiresAt.getTime()) return { value: false };
        return { value: true, next: replaceSession(state, { ...record, tokenDigest: newDigest, lastSeenAt: at }) };
      }),
    revoke: (id, at) =>
      decide((state) => {
        const record = state.sessions.find((s) => s.id === id);
        if (!record || record.revokedAt || at.getTime() < record.createdAt.getTime()) return { value: undefined };
        // Logout also revokes the session's extension grants, in the same durable decision (M2-2 §3.3).
        const grants = state.grants.map((grant) =>
          grant.sessionId === id && grant.revokedAt === null ? { ...grant, revokedAt: new Date(Math.max(at.getTime(), grant.createdAt.getTime())) } : grant,
        );
        // F07: active and reserved purchase permissions are revoked in the same decision (M2-3 §8).
        const permissions = revokeSessionPermissions(state.permissions, id, at);
        const profiles = state.profiles.filter((profile) => profile.sessionId !== id);
        const profileRevisions = state.profileRevisions.filter((revision) => revision.sessionId !== id);
        // Logout removes the session's charger clarification in the same decision.
        const chargerTracks = new Map([...state.chargerTracks].filter(([sessionId]) => sessionId !== id));
          const workloads = state.workloads
            ? new Map([...state.workloads].filter(([sessionId]) => sessionId !== id))
            : undefined;
        return { value: undefined, next: { ...replaceSession(state, { ...record, revokedAt: at }), grants, permissions, profiles, profileRevisions, chargerTracks, workloads } };
      }),
    deleteExpired: (now, idleCutoff) =>
      decide((state) => {
        const removed = state.sessions
          .filter((s) => s.revokedAt !== null || s.absoluteExpiresAt.getTime() <= now.getTime() || s.lastSeenAt.getTime() <= idleCutoff.getTime())
          .map((s) => s.id);
        if (removed.length === 0) return { value: [] };
        return { value: removed, next: withoutSessions(state, new Set(removed)) };
      }),
    count: async () => current().sessions.length,
    liveUntil(sessionId, idleTimeoutMs) {
      const read = gate.read();
      if (read.status !== "ready") return null;
      const record = read.state.sessions.find((s) => s.id === sessionId);
      if (!record || record.revokedAt !== null) return null;
      return Math.min(record.lastSeenAt.getTime() + idleTimeoutMs, record.absoluteExpiresAt.getTime());
    },
    absoluteExpiryOf(sessionId) {
      const read = gate.read();
      if (read.status !== "ready") return null;
      const record = read.state.sessions.find((s) => s.id === sessionId);
      return record && record.revokedAt === null ? record.absoluteExpiresAt : null;
    },
    isLive(sessionId, now, idleTimeoutMs) {
      const read = gate.read();
      if (read.status !== "ready") return false;
      const record = read.state.sessions.find((s) => s.id === sessionId);
      if (!record || record.revokedAt !== null) return false;
      const at = now.getTime();
      return at < record.absoluteExpiresAt.getTime() && at < record.lastSeenAt.getTime() + idleTimeoutMs;
    },
  };

  const spend = (key: keyof Windows, countRefused: boolean) => (nowMs: number, policy: WindowPolicy) =>
    decide((state) => {
      const spent = spendWindow(state.windows[key], nowMs, policy, countRefused);
      return { value: spent.decision, next: { ...state, windows: { ...state.windows, [key]: spent.next } } };
    });

  return {
    mode: "snapshot",
    change: (change) =>
      decide((state) => {
        const scratch = {};
        load(scratch, state);
        const value = change(scratch);
        return { value, next: withHost(state, scratch) };
      }),
    sessionStore,
    spendAllocation: spend("allocation", false),
    spendAdmissionAttempt: (nowMs, policy) =>
      decide((state) => {
        const spent = spendWindow(state.windows.admissionLogin, nowMs, policy, true);
        return { value: reserved(spent.next, spent.decision), next: { ...state, windows: { ...state.windows, admissionLogin: spent.next } } };
      }),
    refundAdmissionAttempt: (reservation) =>
      decide((state) => {
        const next = refundWindow(state.windows.admissionLogin, reservation);
        return next === state.windows.admissionLogin ? { value: undefined } : { value: undefined, next: { ...state, windows: { ...state.windows, admissionLogin: next } } };
      }),
    available: () => gate.status().kind === "ready",
    readGrants: () => current().grants,
    decideGrants: (grantDecision) =>
      decide((state) => {
        const decision = grantDecision(state.grants);
        return decision.grants ? { value: decision.value, next: { ...state, grants: decision.grants } } : { value: decision.value };
      }),
    readPermissions: () => current().permissions,
    decidePermissions: (permissionDecision) =>
      decide((state) => {
        const decision = permissionDecision(state.permissions);
        return decision.permissions ? { value: decision.value, next: { ...state, permissions: decision.permissions } } : { value: decision.value };
      }),
    readProfiles: () => current().profiles,
    decideProfiles: (profileDecision) =>
      decide((state) => {
        const decision = profileDecision(state.profiles, state.profileRevisions);
        if (!decision.profiles && !decision.revisions) return { value: decision.value };
        return {
          value: decision.value,
          next: {
            ...state,
            ...(decision.profiles ? { profiles: decision.profiles } : {}),
            ...(decision.revisions ? { profileRevisions: decision.revisions } : {}),
          },
        };
      }),
  };
}
