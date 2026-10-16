import { conversationStateOf, replaceConversationState } from "./conversation";
import type { DurableState, StateGate, Windows } from "./snapshot-state";
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

export interface LiveSessionStore extends SessionStore {
  /** Synchronous liveness on the published state; false when unavailable. */
  isLive(sessionId: string, now: Date, idleTimeoutMs: number): boolean;
}

export interface DurableHost {
  readonly mode: "memory" | "snapshot";
  /**
   * Runs a draft, conversation or selection change against `host`. In snapshot mode the change runs at the head of
   * the writer queue on a copy of the published state and is published only after it is durable.
   */
  change<T>(change: (host: object) => T): Promise<T>;
  readonly sessionStore: LiveSessionStore;
  /** Durable before it is relied on. */
  spendAllocation(nowMs: number, policy: WindowPolicy): Promise<WindowDecision>;
  /** Durable before the passphrase is checked. Every attempt counts. */
  spendAdmissionAttempt(nowMs: number, policy: WindowPolicy): Promise<WindowDecision>;
  /** False once a save was refused (snapshot mode only). */
  available(): boolean;
}

/** Today's behaviour, unchanged: one process, in memory. */
export function memoryDurableHost(store: object, sessionStore: InMemorySessionStore, admissionAttempts: { windowStartedAt: number | null; count: number }): DurableHost {
  let allocation: WindowState = { windowStartedAt: null, count: 0 };
  return {
    mode: "memory",
    async change(change) {
      return change(store);
    },
    sessionStore,
    async spendAllocation(nowMs, policy) {
      const spent = spendWindow(allocation, nowMs, policy, false);
      allocation = spent.next;
      return spent.decision;
    },
    async spendAdmissionAttempt(nowMs, policy) {
      const spent = spendWindow(admissionAttempts, nowMs, policy, true);
      admissionAttempts.windowStartedAt = spent.next.windowStartedAt;
      admissionAttempts.count = spent.next.count;
      return spent.decision;
    },
    available: () => true,
  };
}

/** Copies a durable state's drafts, conversations and selections into a host object (scratch or published). */
function load(host: object, state: DurableState): void {
  const ids = new Set(state.sessions.map((session) => session.id));
  replaceNeedsDrafts(host, [...state.drafts].filter(([sessionId]) => ids.has(sessionId)));
  replaceConversationState(host, {
    conversations: new Map([...state.conversations].filter(([sessionId]) => ids.has(sessionId))),
    selections: new Map([...state.selections].filter(([sessionId]) => ids.has(sessionId))),
  });
}

function withHost(state: DurableState, host: object): DurableState {
  const conversation = conversationStateOf(host);
  return { ...state, drafts: new Map(needsDraftsFor(host)), conversations: conversation.conversations, selections: conversation.selections };
}

/** Drops everything a removed session owned, in the same state. */
function withoutSessions(state: DurableState, removed: ReadonlySet<string>): DurableState {
  const keep = <V>(map: ReadonlyMap<string, V>) => new Map([...map].filter(([sessionId]) => !removed.has(sessionId)));
  return { ...state, sessions: state.sessions.filter((s) => !removed.has(s.id)), drafts: keep(state.drafts), conversations: keep(state.conversations), selections: keep(state.selections) };
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
        return { value: undefined, next: replaceSession(state, { ...record, revokedAt: at }) };
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
    spendAdmissionAttempt: spend("admissionLogin", true),
    available: () => gate.status().kind === "ready",
  };
}
