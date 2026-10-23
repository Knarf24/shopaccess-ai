import { AsyncLocalStorage } from "node:async_hooks";
import { AdvisoryFailure, type AdvisoryTransport } from "@/lib/providers/qwen-advisory";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "@/lib/session/service";

/**
 * Server-wide limits on outbound AI calls (hosted release safeguard, October 22, 2026).
 *
 * Every outbound attempt reserves capacity first: one call for the session, the current UTC hour and the current UTC
 * day. The check and the increments run synchronously, with no await in between, so concurrent requests in this single
 * process cannot exceed the remaining capacity. A refused reservation makes no outbound attempt; the caller then uses
 * its local fallback.
 *
 * The session comes from the request's advisory scope (`withAdvisorySession`). An attempt made outside a scope is
 * refused, so a call site that forgets to set it can never spend.
 *
 * Counters live in this process only. A restart or redeploy resets them; the provider-side prepaid credit is the hard
 * ceiling. They are not shared between processes, so the service must run as one instance.
 */

export interface AdvisoryLimits {
  readonly perSession: number;
  readonly perHour: number;
  readonly perDay: number;
}

export const DEFAULT_ADVISORY_LIMITS: AdvisoryLimits = { perSession: 6, perHour: 120, perDay: 600 };

const MAX_LIMIT = 100_000;
const LIMIT_VARIABLES = {
  perSession: "SHOPACCESS_AI_LIMIT_PER_SESSION",
  perHour: "SHOPACCESS_AI_LIMIT_PER_HOUR",
  perDay: "SHOPACCESS_AI_LIMIT_PER_DAY",
} as const;

/** All three absent: `null` (the defaults apply). Any present value must be a whole number from 1 to 100000. */
export function parseAdvisoryLimits(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; value: AdvisoryLimits | null } | { ok: false; error: "ADVISORY_LIMITS_INVALID" } {
  const entries = Object.entries(LIMIT_VARIABLES) as [keyof AdvisoryLimits, string][];
  if (entries.every(([, name]) => env[name] === undefined)) return { ok: true, value: null };
  const limits: Record<keyof AdvisoryLimits, number> = { ...DEFAULT_ADVISORY_LIMITS };
  for (const [key, name] of entries) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (!/^[1-9][0-9]{0,5}$/.test(raw)) return { ok: false, error: "ADVISORY_LIMITS_INVALID" };
    const value = Number(raw);
    if (value > MAX_LIMIT) return { ok: false, error: "ADVISORY_LIMITS_INVALID" };
    limits[key] = value;
  }
  return { ok: true, value: limits };
}

export type AdvisoryLimitRefusal = "session" | "hour" | "day" | "no_session";
export type AdvisoryReservation = { readonly ok: true } | { readonly ok: false; readonly refusal: AdvisoryLimitRefusal };

export interface AdvisoryLimiter {
  /** Synchronous check-and-reserve. Nothing is reserved when it refuses. */
  reserve(sessionId: string | null): AdvisoryReservation;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function createAdvisoryLimiter(limits: AdvisoryLimits, clock: () => Date): AdvisoryLimiter {
  let hourWindow = Number.NaN;
  let hourCount = 0;
  let dayWindow = Number.NaN;
  let dayCount = 0;
  const perSession = new Map<string, { count: number; lastAt: number }>();
  return {
    reserve(sessionId) {
      if (sessionId === null) return { ok: false, refusal: "no_session" };
      const now = clock().getTime();
      const hour = Math.floor(now / HOUR_MS);
      const day = Math.floor(now / DAY_MS);
      if (hour !== hourWindow) {
        hourWindow = hour;
        hourCount = 0;
      }
      if (day !== dayWindow) {
        dayWindow = day;
        dayCount = 0;
        // A session ID cannot be live after its absolute lifetime. Retaining entries for at least that long ensures a
        // live session never regains allowance at midnight, while preventing an unbounded map in a long-running host.
        for (const [id, entry] of perSession) {
          if (now - entry.lastAt >= SESSION_ABSOLUTE_LIFETIME_MS) perSession.delete(id);
        }
      }
      const session = perSession.get(sessionId) ?? { count: 0, lastAt: now };
      if (session.count >= limits.perSession) return { ok: false, refusal: "session" };
      if (dayCount >= limits.perDay) return { ok: false, refusal: "day" };
      if (hourCount >= limits.perHour) return { ok: false, refusal: "hour" };
      perSession.set(sessionId, { count: session.count + 1, lastAt: now });
      hourCount += 1;
      dayCount += 1;
      return { ok: true };
    },
  };
}

/**
 * The dev server can load this module once per route bundle, while the runtime and its limited transport are built once
 * per process from whichever copy loads first. The storage container is therefore shared through `globalThis`, so a
 * scope set by any copy is visible to the transport. Only the container is global: each session ID lives in its own
 * async scope and ends with it.
 */
const SCOPE_KEY = Symbol.for("shopaccess.advisorySessionScope");
type AdvisoryScope = AsyncLocalStorage<{ readonly sessionId: string }>;
type GlobalWithAdvisoryScope = typeof globalThis & { [SCOPE_KEY]?: AdvisoryScope };

function sessionScope(): AdvisoryScope {
  const holder = globalThis as GlobalWithAdvisoryScope;
  holder[SCOPE_KEY] ??= new AsyncLocalStorage<{ readonly sessionId: string }>();
  return holder[SCOPE_KEY];
}

/** Runs `fn` with this session as the subject of any AI call it makes. */
export function withAdvisorySession<T>(sessionId: string, fn: () => T): T {
  return sessionScope().run({ sessionId }, fn);
}

export function currentAdvisorySession(): string | null {
  return sessionScope().getStore()?.sessionId ?? null;
}

/** Wraps the outbound transport. A refused reservation throws `LIMITED` and sends nothing. */
export function createLimitedAdvisoryTransport(inner: AdvisoryTransport, limiter: AdvisoryLimiter): AdvisoryTransport {
  return (request) => {
    const reservation = limiter.reserve(currentAdvisorySession());
    if (!reservation.ok) return Promise.reject(new AdvisoryFailure("LIMITED"));
    return inner(request);
  };
}
