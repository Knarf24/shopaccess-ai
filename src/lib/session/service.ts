import type { Clock } from "../shared/clock";
import { constantTimeEqual } from "../shared/crypto";
import type { IdGenerator } from "../shared/ids";
import { err, ok, type Result } from "../shared/result";
import type { SessionRecord, SessionStore } from "./store";
import { deriveCsrfToken, digestSessionToken, generateSessionToken, SESSION_TOKEN_PATTERN } from "./token";

export const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface Session {
  readonly id: string;
  readonly csrfToken: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export type SessionRejection =
  | "TOKEN_MISSING"
  | "TOKEN_MALFORMED"
  | "SESSION_UNKNOWN"
  | "SESSION_REVOKED"
  | "SESSION_IDLE_EXPIRED"
  | "SESSION_ABSOLUTE_EXPIRED";

/**
 * Limits on creating NEW anonymous sessions. Both limits are process-wide:
 * the application has no trustworthy way to tell callers apart (forwarded-IP
 * headers are caller-controlled and are deliberately not consulted). These are
 * single-process protections for the local mock, not distributed rate limiting.
 */
export interface SessionAllocationPolicy {
  /** Hard cap on live sessions held at once. */
  readonly maxActiveSessions: number;
  /** New sessions permitted per window, across all callers. */
  readonly maxNewSessionsPerWindow: number;
  readonly windowMs: number;
}

export const DEFAULT_SESSION_ALLOCATION_POLICY: SessionAllocationPolicy = {
  maxActiveSessions: 500,
  maxNewSessionsPerWindow: 30,
  windowMs: 60_000,
};

export type SessionAllocationRefusal =
  | { readonly reason: "ALLOCATION_RATE_EXCEEDED"; readonly retryAfterMs: number }
  | { readonly reason: "SESSION_CAPACITY_REACHED"; readonly retryAfterMs: number };

export interface IssuedSession {
  readonly session: Session;
  /** Raw token to place in the cookie. Present only when a new token was minted. */
  readonly issuedToken: string | null;
}

export interface SessionServiceDeps {
  readonly store: SessionStore;
  readonly key: Buffer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly allocation?: SessionAllocationPolicy;
  /**
   * Called with the IDs of sessions that were just reclaimed, so data owned by
   * them can be removed too. Local mock only: real payment records need their
   * own durable retention policy and must never be deleted this way.
   */
  readonly onSessionsReclaimed?: (sessionIds: readonly string[]) => Promise<void>;
}

export interface SessionService {
  resolve(presentedToken: string | null): Promise<Result<Session, SessionRejection>>;
  /** Resolves a valid session or mints a fresh one. Never adopts a client-supplied identifier. */
  establish(presentedToken: string | null): Promise<Result<IssuedSession, SessionAllocationRefusal>>;
  /** Reclaims expired, idle and revoked sessions. Returns how many were removed. */
  purgeExpired(): Promise<number>;
  rotate(presentedToken: string | null): Promise<Result<IssuedSession, SessionRejection | "ROTATION_CONFLICT">>;
  revoke(sessionId: string): Promise<void>;
  verifyCsrfToken(session: Session, presented: string | null): boolean;
  cookieMaxAgeSeconds(session: Session): number;
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const { store, key, clock, ids } = deps;
  const allocation = deps.allocation ?? DEFAULT_SESSION_ALLOCATION_POLICY;
  let windowStart = Number.NEGATIVE_INFINITY;
  let allocatedInWindow = 0;

  async function purgeExpired(): Promise<number> {
    const now = clock();
    const reclaimed = await store.deleteExpired(now, new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS));
    // Runs even when nothing was reclaimed, so the owner-side sweep stays idempotent and self-healing.
    await deps.onSessionsReclaimed?.(reclaimed);
    return reclaimed.length;
  }

  /**
   * Decides whether creating one more session may be ATTEMPTED. The cheap
   * in-memory budget check comes first, so a flood is refused before any
   * cleanup scan, random generation, keyed hashing or storage happens. The
   * budget check and its increment have no `await` between them.
   *
   * The capacity test here is only an early exit. The authoritative capacity
   * decision is the atomic `insertWithinCapacity` in `mint`.
   */
  async function admitNewSession(): Promise<SessionAllocationRefusal | null> {
    const now = clock().getTime();
    if (now - windowStart >= allocation.windowMs) {
      windowStart = now;
      allocatedInWindow = 0;
    }
    if (allocatedInWindow >= allocation.maxNewSessionsPerWindow) {
      return { reason: "ALLOCATION_RATE_EXCEEDED", retryAfterMs: windowStart + allocation.windowMs - now };
    }
    // Every admitted attempt spends budget, including ones that then hit the capacity limit.
    allocatedInWindow += 1;
    await purgeExpired();
    if ((await store.count()) >= allocation.maxActiveSessions) {
      return { reason: "SESSION_CAPACITY_REACHED", retryAfterMs: allocation.windowMs };
    }
    return null;
  }

  const toSession = (record: SessionRecord): Session => ({
    id: record.id,
    csrfToken: deriveCsrfToken(key, record.tokenDigest),
    idleExpiresAt: new Date(record.lastSeenAt.getTime() + SESSION_IDLE_TIMEOUT_MS),
    absoluteExpiresAt: record.absoluteExpiresAt,
  });

  async function lookup(presentedToken: string | null): Promise<Result<SessionRecord, SessionRejection>> {
    if (!presentedToken) return err("TOKEN_MISSING");
    if (!SESSION_TOKEN_PATTERN.test(presentedToken)) return err("TOKEN_MALFORMED");
    const record = await store.findByTokenDigest(digestSessionToken(key, presentedToken));
    if (!record) return err("SESSION_UNKNOWN");
    if (record.revokedAt) return err("SESSION_REVOKED");
    const now = clock().getTime();
    if (now >= record.absoluteExpiresAt.getTime()) return err("SESSION_ABSOLUTE_EXPIRED");
    if (now >= record.lastSeenAt.getTime() + SESSION_IDLE_TIMEOUT_MS) return err("SESSION_IDLE_EXPIRED");
    return ok(record);
  }

  async function resolve(presentedToken: string | null): Promise<Result<Session, SessionRejection>> {
    const found = await lookup(presentedToken);
    if (!found.ok) return found;
    const now = clock();
    await store.touch(found.value.id, now);
    return ok(toSession({ ...found.value, lastSeenAt: now }));
  }

  async function mint(): Promise<IssuedSession | null> {
    const now = clock();
    const token = generateSessionToken();
    const record: SessionRecord = {
      id: ids("session"),
      tokenDigest: digestSessionToken(key, token),
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_LIFETIME_MS),
      revokedAt: null,
    };
    // Check-and-insert is one atomic store operation. Nothing is reserved beforehand, so a refused
    // or failed insert leaves no capacity held: there is no reservation that could leak.
    if (!(await store.insertWithinCapacity(record, allocation.maxActiveSessions))) return null;
    return { session: toSession(record), issuedToken: token };
  }

  return {
    resolve,

    async establish(presentedToken) {
      // A valid existing session is reused and spends no allocation budget.
      const existing = await resolve(presentedToken);
      if (existing.ok) return ok({ session: existing.value, issuedToken: null });
      const refusal = await admitNewSession();
      if (refusal) return err(refusal);
      const minted = await mint();
      // Lost the race for the last slot to a concurrent request.
      if (!minted) return err({ reason: "SESSION_CAPACITY_REACHED", retryAfterMs: allocation.windowMs });
      return ok(minted);
    },

    purgeExpired,

    async rotate(presentedToken) {
      const found = await lookup(presentedToken);
      if (!found.ok) return found;
      const now = clock();
      const token = generateSessionToken();
      const newDigest = digestSessionToken(key, token);
      // Rotation keeps the original absolute expiry and invalidates the old token immediately.
      const replaced = await store.replaceTokenDigest(found.value.id, found.value.tokenDigest, newDigest, now);
      if (!replaced) return err("ROTATION_CONFLICT");
      return ok({
        session: toSession({ ...found.value, tokenDigest: newDigest, lastSeenAt: now }),
        issuedToken: token,
      });
    },

    async revoke(sessionId) {
      await store.revoke(sessionId, clock());
    },

    verifyCsrfToken(session, presented) {
      if (!presented) return false;
      return constantTimeEqual(session.csrfToken, presented);
    },

    cookieMaxAgeSeconds(session) {
      return Math.max(0, Math.floor((session.absoluteExpiresAt.getTime() - clock().getTime()) / 1000));
    },
  };
}
