import type { Clock } from "../shared/clock";

export interface RateLimitPolicy {
  /** Stable policy name, used as part of the counter key. */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

/**
 * Counter storage. A production deployment needs a store shared by every
 * server instance (for example one PostgreSQL row per key and window, updated
 * with a single atomic upsert). `increment` must be atomic in that store.
 */
export interface RateLimitStore {
  increment(key: string, windowStartMs: number, windowMs: number): Promise<number>;
}

export interface RateLimiter {
  /** `subject` must be an internal identifier (session row ID, hashed address), never a raw token. */
  consume(policy: RateLimitPolicy, subject: string): Promise<RateLimitDecision>;
}

export const PROPOSED_RATE_LIMIT_POLICIES = {
  aiMessage: { name: "ai_message", limit: 20, windowMs: 60_000 },
  quoteRequest: { name: "quote_request", limit: 30, windowMs: 60_000 },
  confirmation: { name: "confirmation", limit: 10, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

export function createFixedWindowRateLimiter(store: RateLimitStore, clock: Clock): RateLimiter {
  return {
    async consume(policy, subject) {
      const now = clock().getTime();
      const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
      const count = await store.increment(`${policy.name}:${subject}`, windowStart, policy.windowMs);
      const allowed = count <= policy.limit;
      return {
        allowed,
        remaining: Math.max(0, policy.limit - count),
        retryAfterMs: allowed ? 0 : windowStart + policy.windowMs - now,
      };
    },
  };
}

/** Single-process store for tests only. It does not limit anything across server instances. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, number>();
  private readonly windowEnds = new Map<string, number>();
  private nextSweepAt = 0;

  async increment(key: string, windowStartMs: number, windowMs: number): Promise<number> {
    const counterKey = `${key}@${windowStartMs}`;
    // Counters for windows that have ended are dropped, so the store does not grow with elapsed time.
    if (windowStartMs >= this.nextSweepAt) {
      for (const [stored, endsAt] of this.windowEnds) {
        if (endsAt <= windowStartMs) {
          this.windowEnds.delete(stored);
          this.counters.delete(stored);
        }
      }
      this.nextSweepAt = windowStartMs + windowMs;
    }
    this.windowEnds.set(counterKey, windowStartMs + windowMs);
    const next = (this.counters.get(counterKey) ?? 0) + 1;
    this.counters.set(counterKey, next);
    return next;
  }

  /** Test helper. */
  size(): number {
    return this.counters.size;
  }
}
