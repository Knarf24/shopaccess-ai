import type { MerchantCatalog } from "@/lib/catalog/schemas";
import { parsePaymentAdapterConfig, requireMockOnly } from "@/lib/payment/adapter-config";
import { readCatalog, type CatalogReadError } from "@/lib/pg/catalog";
import { createPgCheckoutService, type PgCheckoutService } from "@/lib/pg/checkout-service";
import { createPgPool, queryableFromPool, type PgQueryable } from "@/lib/pg/client";
import { loadKeyRings, type ConfiguredKeyRings } from "@/lib/pg/key-ring";
import { probeReadiness } from "@/lib/pg/readiness";
import { createPgSessionService, type PgSessionService } from "@/lib/pg/session-service";
import { createMockAdvisoryAi, type AdvisoryAiProvider } from "@/lib/providers/ai";
import { createMockDiscoveryProvider, type ProductDiscoveryProvider } from "@/lib/providers/discovery";
import { createFixedWindowRateLimiter, InMemoryRateLimitStore, type RateLimiter } from "@/lib/security/rate-limit";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { systemClock, type Clock } from "@/lib/shared/clock";
import { randomIdGenerator, type IdGenerator } from "@/lib/shared/ids";
import { err, ok, type Result } from "@/lib/shared/result";

/**
 * The PostgreSQL-mode runtime (specification 19.19, Increment 2.3). NEVER RUN AGAINST A DATABASE.
 *
 * Opt-in: it is built only when the mode setting is exactly `postgres`, and it never falls back to the mock. It
 * reads no environment variable itself; `./runtime` hands it the environment once.
 *
 * One runtime and one pool for the process:
 *  - configuration is parsed on first use. An error is permanent for the process and no pool is created;
 *  - the pool is created at most once and is never replaced. Creating it opens no connection;
 *  - concurrent first requests share one construction, and one readiness attempt runs at a time;
 *  - a successful attempt is trusted for READY_FOR_MS; after a failed one, no new attempt starts for
 *    RETRY_AFTER_MS, and requests in that interval are answered "not available" without a statement being sent;
 *  - `dispose()` is terminal. It marks the runtime disposed before it waits for anything; nothing that completes
 *    later can make the runtime ready again; and the pool is ended exactly once, however disposal and the cleanup
 *    of a failed construction overlap.
 *
 * Timeouts, stated as they are: the approved statement_timeout bounds server-side SQL execution after the statement
 * starts. The current pool configuration does not establish an end-to-end deadline for connection establishment or
 * pool acquisition, and nothing here adds one or abandons a call that is still running.
 *
 * The application connects as the web role only. It applies no migration, runs no bootstrap file and calls no
 * operator function: none of those is imported here or by anything this module builds.
 */

export const READY_FOR_MS = 60_000;
export const RETRY_AFTER_MS = 5_000;

export type PgRuntimeConfigError =
  | "DATABASE_URL_MISSING"
  | "DATABASE_URL_INVALID"
  | "KEY_RINGS_INVALID"
  | "TRUSTED_ORIGINS_MISSING"
  | "TRUSTED_ORIGINS_INVALID"
  | "PAYMENT_MODE_NOT_MOCK";

export interface PgRuntimeConfig {
  readonly databaseUrl: string;
  readonly rings: ConfiguredKeyRings;
  readonly trustedOrigins: ReadonlySet<string>;
}

const DATABASE_PROTOCOLS: readonly string[] = ["postgres:", "postgresql:"];

/**
 * Parses what PostgreSQL mode requires. Every value is required and none has a default. The single-key setting of
 * the mock is not read. Errors name settings, never values.
 */
export function parsePgRuntimeConfig(env: Readonly<Record<string, string | undefined>>): Result<PgRuntimeConfig, PgRuntimeConfigError[]> {
  const errors: PgRuntimeConfigError[] = [];

  const databaseUrl = env.SHOPACCESS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    errors.push("DATABASE_URL_MISSING");
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || !DATABASE_PROTOCOLS.includes(parsed.protocol) || parsed.hostname === "" || parsed.username === "") errors.push("DATABASE_URL_INVALID");
  }

  const rings = loadKeyRings({ sessionKeys: env.SHOPACCESS_SESSION_KEYS, nonceKeys: env.SHOPACCESS_NONCE_KEYS });
  if (!rings.ok) errors.push("KEY_RINGS_INVALID");

  let trustedOrigins: ReadonlySet<string> | null = null;
  const origins = (env.SHOPACCESS_TRUSTED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) {
    errors.push("TRUSTED_ORIGINS_MISSING");
  } else {
    try {
      trustedOrigins = parseTrustedOrigins(origins, { allowLoopbackHttp: env.NODE_ENV === "development" });
    } catch {
      errors.push("TRUSTED_ORIGINS_INVALID");
    }
  }

  const payment = parsePaymentAdapterConfig(env);
  if (!payment.ok || !requireMockOnly(payment.value).ok) errors.push("PAYMENT_MODE_NOT_MOCK");

  if (errors.length > 0 || databaseUrl === undefined || !rings.ok || !trustedOrigins) return err(errors);
  return ok({ databaseUrl, rings: rings.value, trustedOrigins });
}

/** What the runtime needs of a pool: single statements, and an end. */
export interface PgPool extends PgQueryable {
  end(): Promise<void>;
}

/** Everything a PostgreSQL-mode request is served with. Handed out only while the runtime is ready. */
export interface PgServices {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly trustedOrigins: ReadonlySet<string>;
  readonly sessions: PgSessionService;
  readonly checkout: PgCheckoutService;
  /** In-process limits: a first line only. The database's own throttle decides. */
  readonly limiter: RateLimiter;
  /** Advisory only, local mocks: nothing they produce is sent to the database. */
  readonly discovery: ProductDiscoveryProvider;
  readonly ai: AdvisoryAiProvider;
  /** The catalog as the database holds it now: one statement per call, never cached. */
  catalog(): Promise<Result<MerchantCatalog, CatalogReadError>>;
}

/** Builds the services on one statement runner. No statement is sent by building them. */
export function buildPgServices(db: PgQueryable, config: PgRuntimeConfig, options: { clock?: Clock; ids?: IdGenerator } = {}): PgServices {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdGenerator;
  return {
    clock,
    ids,
    trustedOrigins: config.trustedOrigins,
    sessions: createPgSessionService({ db, rings: config.rings, ids, clock }),
    checkout: createPgCheckoutService({ db, nonceRing: config.rings.confirmationNonce, ids }),
    limiter: createFixedWindowRateLimiter(new InMemoryRateLimitStore(), clock),
    discovery: createMockDiscoveryProvider(),
    ai: createMockAdvisoryAi(),
    catalog: () => readCatalog(db),
  };
}

export interface PgRuntime {
  /**
   * The services, or null while the application is not available: configuration is missing or invalid, the
   * connection is not ready, or the runtime has been disposed. Null never means "use the mock".
   */
  services(): Promise<PgServices | null>;
  /** Ends the pool, once. Afterwards `services()` is null for good. Safe to call more than once. */
  dispose(): Promise<void>;
}

export interface PgRuntimeOverrides {
  /** Where the pool comes from. Tests supply a fake; the default is the library's pool with the approved timeouts. */
  readonly createPool?: (connectionString: string) => PgPool | Promise<PgPool>;
  /** How the services are built on the pool. Tests replace it to make construction fail after the pool exists. */
  readonly buildServices?: typeof buildPgServices;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

function defaultPool(connectionString: string): PgPool {
  const pool = createPgPool(connectionString);
  // An idle connection that fails must not take the process down. Only the error code is written.
  pool.on("error", (error: unknown) => {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    console.error("shopaccess: database pool error", typeof code === "string" ? code : "unknown");
  });
  const queryable = queryableFromPool(pool);
  return { query: queryable.query, end: () => pool.end() };
}

interface Built {
  readonly db: PgQueryable;
  readonly rings: ConfiguredKeyRings;
  readonly services: PgServices;
}

export function createPgRuntime(env: Readonly<Record<string, string | undefined>>, overrides: PgRuntimeOverrides = {}): PgRuntime {
  const clock = overrides.clock ?? systemClock;

  let disposed = false;
  let pool: PgPool | null = null;
  let ending: Promise<void> | null = null;
  let construction: Promise<Built | null> | null = null;
  let probing: Promise<boolean> | null = null;
  let disposal: Promise<void> | null = null;
  let readyAt = Number.NEGATIVE_INFINITY;
  let failedAt = Number.NEGATIVE_INFINITY;

  /** The one close of the pool. Every caller that needs the pool ended receives this same promise. */
  const endPool = (): Promise<void> => {
    if (!pool) return Promise.resolve();
    if (!ending) ending = pool.end().then(() => undefined, () => undefined);
    return ending;
  };

  const construct = async (): Promise<Built | null> => {
    const config = parsePgRuntimeConfig(env);
    // Permanent for the process: this promise is kept, and no pool is created.
    if (!config.ok) return null;
    if (disposed) return null;
    let created: PgPool;
    try {
      created = await (overrides.createPool ?? defaultPool)(config.value.databaseUrl);
    } catch {
      return null;
    }
    pool = created;
    // Disposed while the pool was being created: the pool is ended and is never used.
    if (disposed) {
      await endPool();
      return null;
    }
    try {
      const db: PgQueryable = created;
      return { db, rings: config.value.rings, services: (overrides.buildServices ?? buildPgServices)(db, config.value, { clock, ids: overrides.ids }) };
    } catch {
      // Partial construction: the pool exists and nothing will use it.
      await endPool();
      return null;
    }
  };

  const probe = async (built: Built): Promise<boolean> => {
    let passed = false;
    try {
      passed = (await probeReadiness(built.db, built.rings)).ok;
    } catch {
      passed = false;
    }
    // A probe that settles after disposal publishes nothing: no readiness and no retry time.
    if (disposed) return false;
    const now = clock().getTime();
    if (passed) {
      readyAt = now;
    } else {
      readyAt = Number.NEGATIVE_INFINITY;
      failedAt = now;
    }
    return passed;
  };

  return {
    async services() {
      if (disposed) return null;
      if (!construction) construction = construct();
      const built = await construction;
      if (!built || disposed) return null;

      const now = clock().getTime();
      if (now - readyAt < READY_FOR_MS) return built.services;
      if (!probing) {
        if (now - failedAt < RETRY_AFTER_MS) return null;
        const attempt = probe(built).finally(() => {
          if (probing === attempt) probing = null;
        });
        probing = attempt;
      }
      const ready = await probing;
      return ready && !disposed ? built.services : null;
    },

    dispose() {
      // Terminal, and set before anything is awaited.
      disposed = true;
      if (!disposal) {
        disposal = (async () => {
          // A construction that is still running may yet create the pool; it is waited for, so that the pool it
          // creates is the one that is ended.
          if (construction) await construction.catch(() => null);
          await endPool();
        })();
      }
      return disposal;
    },
  };
}
