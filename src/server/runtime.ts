import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import type { MerchantCatalog } from "@/lib/catalog/schemas";
import type { CheckoutDeps } from "@/lib/checkout/service";
import { InMemoryCheckoutStore } from "@/lib/checkout/store";
import { InMemoryOperationLedger } from "@/lib/payment/operations";
import type { PaymentDeps } from "@/lib/payment/orchestrator";
import { createMockAdvisoryAi, type AdvisoryAiProvider } from "@/lib/providers/ai";
import { createMockDiscoveryProvider, type ProductDiscoveryProvider } from "@/lib/providers/discovery";
import { MockPaymentProvider } from "@/lib/providers/payment";
import { InMemoryAuditLog } from "@/lib/security/audit";
import { createFixedWindowRateLimiter, InMemoryRateLimitStore, type RateLimiter } from "@/lib/security/rate-limit";
import { createSessionService, SESSION_IDLE_TIMEOUT_MS, type SessionService } from "@/lib/session/service";
import { InMemorySessionStore } from "@/lib/session/store";
import { systemClock, type Clock } from "@/lib/shared/clock";
import { randomIdGenerator, type IdGenerator } from "@/lib/shared/ids";
import type { Result } from "@/lib/shared/result";
import { parseRuntimeConfig, type RuntimeConfig, type RuntimeConfigError } from "./config";

/**
 * Everything the mock demonstration runs on. All state is held in this
 * process's memory: it is lost on restart and is not shared between server
 * instances. There is no database and no external service behind it.
 */
export interface Runtime {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly catalog: MerchantCatalog;
  readonly trustedOrigins: ReadonlySet<string>;
  readonly sessions: SessionService;
  readonly store: InMemoryCheckoutStore;
  readonly ledger: InMemoryOperationLedger;
  readonly provider: MockPaymentProvider;
  readonly discovery: ProductDiscoveryProvider;
  readonly ai: AdvisoryAiProvider;
  readonly limiter: RateLimiter;
  readonly audit: InMemoryAuditLog;
  readonly checkout: CheckoutDeps;
  readonly payment: PaymentDeps;
  /**
   * Reclaims expired sessions and everything they owned. Called on every
   * request path but does real work at most once a minute. Mock-only cleanup.
   */
  maintain(): Promise<void>;
}

const MAINTENANCE_INTERVAL_MS = 60_000;

export function createRuntime(config: RuntimeConfig, overrides: { clock?: Clock; ids?: IdGenerator } = {}): Runtime {
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? randomIdGenerator;
  const catalog = DEMO_MERCHANT_CATALOG;
  const store = new InMemoryCheckoutStore();
  const ledger = new InMemoryOperationLedger(ids);
  const provider = new MockPaymentProvider();
  const audit = new InMemoryAuditLog();

  // LOCAL MOCK ONLY: when a session is reclaimed, the checkout data it owned goes with it. The ledger
  // sweep is by "intent no longer exists", so it is idempotent and also collects anything written by
  // a request that was still running when its session was reclaimed.
  const onSessionsReclaimed = async (sessionIds: readonly string[]): Promise<void> => {
    await store.deleteForSessions(sessionIds);
    await ledger.deleteOrphans((intentId) => store.hasIntent(intentId));
    provider.retainOnlyRequests(ledger.providerRequestIds());
  };
  const sessionStore = new InMemorySessionStore();
  const sessions = createSessionService({ store: sessionStore, key: config.sessionKey, clock, ids, onSessionsReclaimed });
  // Synchronous: the checkout store calls this inside its atomic commit (single-process mock only).
  const sessionIsLive = (sessionId: string): boolean => sessionStore.isLive(sessionId, clock(), SESSION_IDLE_TIMEOUT_MS);

  let nextMaintenanceAt = Number.NEGATIVE_INFINITY;
  const maintain = async (): Promise<void> => {
    const now = clock().getTime();
    if (now < nextMaintenanceAt) return;
    nextMaintenanceAt = now + MAINTENANCE_INTERVAL_MS;
    await sessions.purgeExpired();
  };

  return {
    clock,
    ids,
    catalog,
    trustedOrigins: config.trustedOrigins,
    sessions,
    store,
    ledger,
    provider,
    discovery: createMockDiscoveryProvider(),
    ai: createMockAdvisoryAi(),
    limiter: createFixedWindowRateLimiter(new InMemoryRateLimitStore(), clock),
    audit,
    checkout: { store, sessionIsLive, catalog, clock, ids },
    payment: { store, ledger, provider, catalog, audit, clock, ids, workerId: "demo-worker", leaseMs: 30_000 },
    maintain,
  };
}

const GLOBAL_KEY = Symbol.for("shopaccess.demo.runtime");
type GlobalWithRuntime = typeof globalThis & { [GLOBAL_KEY]?: Result<Runtime, RuntimeConfigError[]> };

/**
 * Process-wide runtime, created once from environment configuration. This is
 * the only place in the application that reads process.env. If configuration
 * is missing or invalid the result is an error and nothing is served.
 */
export function getRuntime(): Result<Runtime, RuntimeConfigError[]> {
  const holder = globalThis as GlobalWithRuntime;
  if (!holder[GLOBAL_KEY]) {
    const config = parseRuntimeConfig(process.env);
    holder[GLOBAL_KEY] = config.ok ? { ok: true, value: createRuntime(config.value) } : config;
  }
  return holder[GLOBAL_KEY];
}
