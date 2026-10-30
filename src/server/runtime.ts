import { CHARGER_CATALOG, chargerPurchaseAllowed } from "@/lib/catalog/charger-purchase";
import { isLaptopVariant } from "@/lib/catalog/schemas";
import { findMerchantVariant } from "@/lib/catalog/merchant-catalog";
import { chargerTrackFor } from "@/lib/session/charger-clarification";
import { needsDraftsFor } from "@/lib/session/store";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import type { MerchantCatalog } from "@/lib/catalog/schemas";
import type { CheckoutDeps } from "@/lib/checkout/service";
import { InMemoryCheckoutStore } from "@/lib/checkout/store";
import { InMemoryOperationLedger } from "@/lib/payment/operations";
import type { PaymentDeps } from "@/lib/payment/orchestrator";
import { createMockAdvisoryAi, type AdvisoryAiProvider } from "@/lib/providers/ai";
import { createFetchAdvisoryTransport, createQwenAdvisoryProvider, type AdvisoryTransport } from "@/lib/providers/qwen-advisory";
import { createMockDiscoveryProvider, type ProductDiscoveryProvider } from "@/lib/providers/discovery";
import {
  createFetchChannel3Transport,
  readChannel3Listings,
  searchChannel3Listings,
  type Channel3Snapshot,
  type Channel3Transport,
  type ListingOutcome,
} from "@/lib/providers/channel3-discovery";
import { MockPaymentProvider } from "@/lib/providers/payment";
import { isPayPalSandboxProvider, PayPalSandboxProvider, type PaypalTransport } from "@/lib/providers/paypal-sandbox";
import { InMemoryAuditLog } from "@/lib/security/audit";
import { createFixedWindowRateLimiter, InMemoryRateLimitStore, type RateLimiter } from "@/lib/security/rate-limit";
import { createSessionService, SESSION_IDLE_TIMEOUT_MS, type SessionService } from "@/lib/session/service";
import { memoryDurableHost, snapshotDurableHost, type DurableHost } from "@/lib/session/durable";
import { InMemorySessionStore } from "@/lib/session/store";
import { createPairingAuthority, type PairingAuthority } from "@/lib/session/grants";
import { createPermissionAuthority, type PermissionAuthority } from "@/lib/permissions/authority";
import { createProfileAuthority, type ProfileAuthority } from "@/lib/profile/authority";
import { createPurchaseGate } from "@/lib/permissions/gate";
import type { StateGate } from "@/lib/session/snapshot-state";
import { systemClock, type Clock } from "@/lib/shared/clock";
import { randomIdGenerator, type IdGenerator } from "@/lib/shared/ids";
import type { Result } from "@/lib/shared/result";
import { advisoryBudgetPresence, createBudgetedAdvisoryTransport } from "./advisory-budget";
import { DEFAULT_ADVISORY_LIMITS, createAdvisoryLimiter, createLimitedAdvisoryTransport, type AdvisoryLimiter } from "./advisory-limits";
import { DEFAULT_CHANNEL3_LIMITS } from "./channel3-config";
import { parsePersistenceMode, parseRuntimeConfig, type RuntimeConfig, type RuntimeConfigError } from "./config";
import { resolveDemoAdmission, type DemoAdmission } from "./demo-admission";
import { createPgRuntime, type PgRuntime } from "./pg-runtime";

/**
 * Everything the mock demonstration runs on. All state is held in this
 * process's memory: it is lost on restart and is not shared between server
 * instances. There is no database behind it. The assistant is the local mock unless
 * advisory configuration selects the external provider.
 */
export interface Runtime {
  readonly chargerBudgetEnabled: boolean;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly catalog: MerchantCatalog;
  readonly trustedOrigins: ReadonlySet<string>;
  readonly sessions: SessionService;
  readonly store: InMemoryCheckoutStore;
  readonly ledger: InMemoryOperationLedger;
  readonly provider: MockPaymentProvider;
  /** `sandbox` uses the PayPal sandbox adapter for checkout commands. Simulation stays on the mock provider. */
  readonly paymentMode: "mock" | "sandbox";
  readonly sandbox: PayPalSandboxProvider | null;
  readonly discovery: ProductDiscoveryProvider;
  readonly ai: AdvisoryAiProvider;
  /** `local` keeps the in-process assistant. `external` uses one configured advisory provider. */
  readonly advisory: "local" | "external";
  /** The deterministic local assistant, used as the labelled fallback when the external provider fails or is limited. */
  readonly localAi: AdvisoryAiProvider;
  /** External mode only: the server-wide AI call limits that every outbound attempt reserves against. */
  readonly advisoryLimiter: AdvisoryLimiter | null;
  /** External mode only: the provider named in the free-text disclosure. */
  readonly advisoryProviderName: "Synthorai" | "Alibaba Cloud Model Studio" | null;
  /**
   * Channel3 external-listing search. `live` only when `CHANNEL3_DISCOVERY=on` and a valid key are configured (or a
   * test injects a transport); otherwise `disabled` with a null `search` that answers "unavailable" without a request.
   * `read` returns a result only when this process already stored one; it does not call the network.
   */
  readonly channel3: {
    readonly mode: "disabled" | "live";
    read(sessionId: string, draftId: string, version: number): Channel3Snapshot | null;
    readonly search: ((request: Channel3SearchRequest) => Promise<ListingOutcome>) | null;
    /**
     * Search-action limits (session, UTC hour, UTC day), reserved synchronously before any request. One limiter per
     * runtime; the runtime is cached once per process, so every route bundle shares it. Process-local: it resets when
     * the process restarts. Null when Channel3 is disabled.
     */
    readonly limiter: AdvisoryLimiter | null;
  };
  readonly limiter: RateLimiter;
  readonly audit: InMemoryAuditLog;
  readonly checkout: CheckoutDeps;
  readonly payment: PaymentDeps;
  /**
   * Reclaims expired sessions and everything they owned. Called on every
   * request path but does real work at most once a minute. Mock-only cleanup.
   */
  maintain(): Promise<void>;
  /**
   * Demonstration admission. Omitted configuration stays off so a runtime built
   * for the existing local flow is unchanged. The process application sets this
   * from the environment.
   */
  readonly admission: DemoAdmission;
  /**
   * Where shopper state lives. `memory`: this process only, as before. `snapshot`: the save-first gate; every change
   * is durable before it is published, and a refused save makes the runtime unavailable (M2-1).
   */
  readonly durable: DurableHost;
  /** Extension pairing and grants (M2-2). Used only when `extensionOrigins` is non-empty. */
  readonly pairing: PairingAuthority;
  /** Allowed extension origins; empty switches the extension API off. */
  readonly extensionOrigins: ReadonlySet<string>;
  /** F07 purchase permissions (M2-3). Website only; never reachable from the extension API. */
  readonly permissions: PermissionAuthority;
  /** Optional device profile for this website session. Not used by recommendations, checkout, or payment. */
  readonly profiles: ProfileAuthority;
}

const MAINTENANCE_INTERVAL_MS = 60_000;

type RuntimeOverrides = {
  clock?: Clock;
  ids?: IdGenerator;
  transport?: AdvisoryTransport;
  admission?: DemoAdmission;
  paymentTransport?: PaypalTransport;
  paymentTimeoutMs?: number;
  /**
   * A provider already constructed by `PayPalSandboxProvider`. Used when that
   * construction happened in another copy of the provider module. A value that
   * was not constructed there is ignored.
   */
  sandboxProvider?: PayPalSandboxProvider;
  /** Offline tests supply this; it replaces the live transport. Production installs the live one from configuration. */
  channel3Transport?: Channel3Transport;
  /** Snapshot persistence: the recovered save-first gate. Supplied only by openRuntime (runtime-access.ts) and tests. */
  gate?: StateGate;
  chargerBudgetTestStore?: boolean;
};

export interface Channel3SearchRequest {
  readonly sessionId: string;
  readonly draftId: string;
  readonly version: number;
  readonly use: "schoolwork" | "programming" | "general_productivity";
  readonly budgetDollars: string;
  readonly currentDraft: () => { readonly draftId: string; readonly version: number } | null;
  readonly now: () => string;
}

const SANDBOX_INSTALLATION = Symbol.for("shopaccess.runtimeSandboxInstallation");

function sandboxInstallations(): WeakMap<Runtime, PayPalSandboxProvider> {
  const host = globalThis as typeof globalThis & { [SANDBOX_INSTALLATION]?: WeakMap<Runtime, PayPalSandboxProvider> };
  const existing = host[SANDBOX_INSTALLATION];
  if (existing) return existing;
  const created = new WeakMap<Runtime, PayPalSandboxProvider>();
  Object.defineProperty(host, SANDBOX_INSTALLATION, { value: created, enumerable: false, writable: false, configurable: false });
  return created;
}

/**
 * The sandbox provider this runtime installed, or null.
 * The mode, the stored provider, and the payment provider must all name that
 * same constructed object. Ordinary mock mode, a missing provider, a swapped
 * provider, and any object that was not constructed as one all refuse.
 * PostgreSQL mode never builds this runtime.
 */
export function runtimeSandboxProvider(runtime: Runtime): PayPalSandboxProvider | null {
  const installed = sandboxInstallations().get(runtime);
  if (!installed || runtime.paymentMode !== "sandbox" || runtime.sandbox !== installed || runtime.payment.provider !== installed) return null;
  if (!isPayPalSandboxProvider(installed)) return null;
  return installed;
}

export function createRuntime(config: RuntimeConfig, overrides: RuntimeOverrides = {}): Runtime {
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? randomIdGenerator;
  const adapterEnabled = overrides.chargerBudgetTestStore === true && overrides.gate !== undefined && config.payment?.mode !== "sandbox";
  const catalog = adapterEnabled ? CHARGER_CATALOG : DEMO_MERCHANT_CATALOG;
  const advisory = config.advisory?.mode === "external" ? config.advisory : { mode: "local" as const };
  const store = new InMemoryCheckoutStore();
  const ledger = new InMemoryOperationLedger(ids);
  const provider = new MockPaymentProvider();
  const paymentTransport = overrides.paymentTransport;
  const candidate =
    config.payment?.mode === "sandbox"
      ? (overrides.sandboxProvider ??
        new PayPalSandboxProvider({
          apiBaseUrl: config.payment.apiBaseUrl,
          clientId: config.payment.clientId,
          clientSecret: config.payment.clientSecret,
          merchantId: config.payment.merchantId,
          clock,
          ...(overrides.paymentTimeoutMs !== undefined ? { timeoutMs: overrides.paymentTimeoutMs } : {}),
          ...(paymentTransport ? { transport: paymentTransport } : {}),
        }))
      : null;
  const sandbox = candidate !== null && isPayPalSandboxProvider(candidate) ? candidate : null;
  const audit = new InMemoryAuditLog();

  // LOCAL MOCK ONLY: when a session is reclaimed, the checkout data it owned goes with it. The ledger
  // sweep is by "intent no longer exists", so it is idempotent and also collects anything written by
  // a request that was still running when its session was reclaimed.
  const onSessionsReclaimed = async (sessionIds: readonly string[]): Promise<void> => {
    await store.deleteForSessions(sessionIds);
    await ledger.deleteOrphans((intentId) => store.hasIntent(intentId));
    provider.retainOnlyRequests(ledger.providerRequestIds());
  };
  const admission = overrides.admission ?? { mode: "off" };
  const durable = overrides.gate
    ? snapshotDurableHost(overrides.gate, store)
    : memoryDurableHost(store, new InMemorySessionStore(), admission.mode === "on" ? admission.attempts : { windowStartedAt: null, count: 0 });
  const sessionStore = durable.sessionStore;
  const sessions = createSessionService({
    store: sessionStore,
    key: config.sessionKey,
    clock,
    ids,
    onSessionsReclaimed,
    ...(durable.mode === "snapshot" ? { spendAllocation: durable.spendAllocation } : {}),
  });
  // Synchronous: the checkout store calls this inside its atomic commit (single-process mock only).
  const sessionIsLive = (sessionId: string): boolean => sessionStore.isLive(sessionId, clock(), SESSION_IDLE_TIMEOUT_MS);
  const pairing = createPairingAuthority({
    durable,
    key: config.sessionKey,
    sessionLive: sessionIsLive,
    sessionExpiresAt: (sessionId) => sessionStore.absoluteExpiryOf(sessionId),
  });
  // F07 enforcement for checkout start, confirmation, order creation and capture (M2-3 slice 2).
  const currentCharger = (sessionId: string) => {
    const draft = needsDraftsFor(store).get(sessionId);
    return draft && draft.expiresAtMs > clock().getTime() ? chargerTrackFor(store, sessionId, draft.draftId) : null;
  };
  const purchaseGate = createPurchaseGate({ durable, sessionLive: sessionIsLive, clock, checkoutAllowed(sessionId, quote) {
    const entry = findMerchantVariant(catalog, quote.productId, quote.variantId);
    if (entry && isLaptopVariant(entry.variant)) return true;
    return adapterEnabled && chargerPurchaseAllowed(catalog, sessionId, currentCharger(sessionId), quote);
  } });
  const permissions = createPermissionAuthority({
    durable,
    catalog,
    sessionLive: sessionIsLive,
    sessionExpiresAt: (sessionId) => sessionStore.absoluteExpiryOf(sessionId),
  });
  const profiles = createProfileAuthority({ durable, sessionLive: sessionIsLive });

  // The live transport is installed only from a valid configuration (CHANNEL3_DISCOVERY=on + CHANNEL3_API_KEY).
  const channel3Transport =
    overrides.channel3Transport ?? (config.channel3?.mode === "live" ? createFetchChannel3Transport(config.channel3.apiKey) : undefined);
  const channel3Limiter = channel3Transport ? createAdvisoryLimiter(config.channel3Limits ?? DEFAULT_CHANNEL3_LIMITS, clock) : null;
  const advisoryLimiter = advisory.mode === "external" ? createAdvisoryLimiter(config.advisoryLimits ?? DEFAULT_ADVISORY_LIMITS, clock) : null;
  const transport = selectAdvisoryTransport(config, overrides, advisoryLimiter);
  let nextMaintenanceAt = Number.NEGATIVE_INFINITY;
  const maintain = async (): Promise<void> => {
    const now = clock().getTime();
    if (now < nextMaintenanceAt) return;
    nextMaintenanceAt = now + MAINTENANCE_INTERVAL_MS;
    await sessions.purgeExpired();
  };

  const runtime: Runtime = {
    chargerBudgetEnabled: overrides.chargerBudgetTestStore === true && overrides.gate !== undefined,
    clock,
    ids,
    catalog,
    trustedOrigins: config.trustedOrigins,
    sessions,
    store,
    ledger,
    provider,
    paymentMode: sandbox ? "sandbox" : "mock",
    sandbox,
    discovery: createMockDiscoveryProvider(),
    ai:
      advisory.mode === "external"
        ? createQwenAdvisoryProvider({
            modelId: advisory.modelId,
            endpoint: advisory.endpoint,
            apiKey: advisory.apiKey,
            ...(transport ? { transport } : {}),
          })
        : createMockAdvisoryAi(),
    advisory: advisory.mode,
    localAi: createMockAdvisoryAi(),
    advisoryLimiter,
    advisoryProviderName: advisory.mode === "external" ? (new URL(advisory.endpoint).hostname === "synthorai.io" ? "Synthorai" : "Alibaba Cloud Model Studio") : null,
    channel3: {
      mode: channel3Transport ? "live" : "disabled",
      read(sessionId, draftId, version) {
        return readChannel3Listings(store, sessionId, draftId, version);
      },
      search:
        channel3Transport && channel3Limiter
          ? (request) =>
              searchChannel3Listings({
                ...request,
                store,
                transport: channel3Transport,
                reserve: () => channel3Limiter.reserve(request.sessionId).ok,
              })
          : null,
      limiter: channel3Limiter,
    },
    limiter: createFixedWindowRateLimiter(new InMemoryRateLimitStore(), clock),
    audit,
    checkout: { store, sessionIsLive, catalog, clock, ids, purchaseGate, chargerBinding(sessionId) {
      const track = currentCharger(sessionId);
      return adapterEnabled && track ? { chargerDraftId: track.draftId, chargerRevision: track.revision } : undefined;
    } },
    payment: {
      store,
      ledger,
      provider: sandbox ?? provider,
      catalog,
      audit,
      clock,
      ids,
      workerId: "demo-worker",
      leaseMs: 30_000,
      purchaseGate,
      ...(sandbox && config.payment?.mode === "sandbox" ? { paypalMerchantId: config.payment.merchantId } : {}),
    },
    maintain,
    admission,
    durable,
    pairing,
    extensionOrigins: config.extensionOrigins ?? new Set<string>(),
    permissions,
    profiles,
  };
  if (sandbox) sandboxInstallations().set(runtime, sandbox);
  return runtime;
}

/**
 * External mode: every outbound attempt first reserves against the call limits, then (when configured) the legacy
 * two-slot budget, then the network or the injected test transport. Local mode makes no outbound call.
 */
function selectAdvisoryTransport(
  config: RuntimeConfig,
  overrides: { transport?: AdvisoryTransport },
  limiter: AdvisoryLimiter | null,
): AdvisoryTransport | undefined {
  if (!limiter) return overrides.transport;
  const inner = overrides.transport ?? createFetchAdvisoryTransport();
  const budgeted = config.advisoryBudget?.mode === "on" ? createBudgetedAdvisoryTransport(config.advisoryBudget.directory, inner, process.cwd()) : inner;
  return createLimitedAdvisoryTransport(budgeted, limiter);
}

/**
 * What this process serves. Decided once, from the environment:
 *  - `mock`: the in-memory demonstration above, or the list of what its configuration lacks;
 *  - `postgres`: the opt-in PostgreSQL mode (specification 19.19). Its runtime is built in `./pg-runtime`, connects
 *    only when first used and never falls back to the mock;
 *  - `invalid`: the mode setting has a value that is not recognised. Nothing is served.
 */
export type Application =
  | { readonly mode: "mock"; readonly runtime: Result<Runtime, RuntimeConfigError[]> }
  | { readonly mode: "postgres"; readonly runtime: PgRuntime }
  | { readonly mode: "invalid" };

const APPLICATION_KEY = Symbol.for("shopaccess.application");
type GlobalWithApplication = typeof globalThis & { [APPLICATION_KEY]?: Application };

/**
 * The environment of this process. This function is the only place in the application that reads process.env;
 * everything else receives configuration as an argument.
 */
function environment(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

export function chargerBudgetTestStoreRequested(): boolean {
  return environment().SHOPACCESS_CHARGER_BUDGET_TEST_STORE === "1";
}

/**
 * The explicit workload-record setting. Only the exact token "1" selects the workload-capable snapshot format (10),
 * and then only for a store that is already format 10. Nothing sets it; see docs/workload-record-snapshot-format.md.
 */
export function workloadRecordsRequested(): boolean {
  return environment().SHOPACCESS_WORKLOAD_RECORDS === "1";
}

/** Snapshot persistence settings (M2-1). Values are paths; they are never logged or shown. */
export type MockStoreSettings =
  | { readonly state: "absent" }
  | { readonly state: "requested"; readonly directory: string | null; readonly keyFile: string | null; readonly mode: "mock" | "postgres" | "invalid" };

/**
 * Neither setting: the in-memory mock, as before. Either setting: snapshot persistence is requested, and the runtime
 * must be opened through openRuntime; a missing or invalid setting then fails closed rather than falling back to memory.
 */
export function mockStoreSettings(): MockStoreSettings {
  const env = environment();
  const directory = env.SHOPACCESS_MOCK_STORE_DIR;
  const keyFile = env.SHOPACCESS_MOCK_STORE_KEY_FILE;
  if (directory === undefined && keyFile === undefined) return { state: "absent" };
  const mode = parsePersistenceMode(env);
  return { state: "requested", directory: directory || null, keyFile: keyFile || null, mode: mode.ok ? mode.value : "invalid" };
}

/** The mock runtime of an application, or an error with nothing to list. */
export function runtimeOf(application: Application): Result<Runtime, RuntimeConfigError[]> {
  return application.mode === "mock" ? application.runtime : { ok: false, error: [] };
}

/**
 * The snapshot-mode application, built only by openRuntime after recovery is durable. Configuration and admission
 * are parsed exactly as for the in-memory mock.
 */
export function createSnapshotApplication(gate: StateGate): Application {
  const env = environment();
  const config = parseRuntimeConfig(env);
  return {
    mode: "mock",
    runtime: config.ok ? { ok: true, value: createRuntime(config.value, { admission: resolveDemoAdmission(env, config.value.sessionKey), gate, chargerBudgetTestStore: env.SHOPACCESS_CHARGER_BUDGET_TEST_STORE === "1" }) } : config,
  };
}

/**
 * The process-wide application, created once from environment configuration. In PostgreSQL mode no in-memory
 * checkout or session store is ever built, and in mock mode nothing of the PostgreSQL runtime is.
 */
export function getApplication(): Application {
  const holder = globalThis as GlobalWithApplication;
  const existing = holder[APPLICATION_KEY];
  if (existing) return existing;

  const env = environment();
  const mode = parsePersistenceMode(env);
  const store = mockStoreSettings();
  let application: Application;
  if (!mode.ok) {
    application = { mode: "invalid" };
  } else if (store.state === "requested") {
    // Snapshot persistence never reaches createPgRuntime, and is never served from here: openRuntime owns it.
    application = { mode: "mock", runtime: { ok: false, error: [mode.value === "postgres" ? "MOCK_STORE_UNSUPPORTED" : "MOCK_STORE_REQUIRES_OPEN_RUNTIME"] } };
  } else if (mode.value === "postgres" && advisoryBudgetPresence(env) === "present") {
    // getApplication is the PostgreSQL gate. A budget setting must not construct that runtime.
    application = { mode: "mock", runtime: { ok: false, error: ["ADVISORY_BUDGET_INVALID"] } };
  } else if (mode.value === "postgres" && env.SHOPACCESS_DEMO_ADMISSION === "on") {
    // Admission and PostgreSQL persistence together are unsupported. An absent admission setting does not take this branch.
    application = { mode: "mock", runtime: { ok: false, error: ["DEMO_ADMISSION_UNSUPPORTED"] } };
  } else if (mode.value === "postgres") {
    application = { mode: "postgres", runtime: createPgRuntime(env) };
  } else {
    const config = parseRuntimeConfig(env);
    application = {
      mode: "mock",
      runtime: config.ok
        ? { ok: true, value: createRuntime(config.value, { admission: resolveDemoAdmission(env, config.value.sessionKey) }) }
        : config,
    };
  }
  holder[APPLICATION_KEY] = application;
  return application;
}

/**
 * The mock runtime. If its configuration is missing or invalid the result is an error and nothing is served. In
 * any other mode the result is an error too, with nothing to list: the mock is never built beside another mode.
 */
export function getRuntime(): Result<Runtime, RuntimeConfigError[]> {
  const application = getApplication();
  return application.mode === "mock" ? application.runtime : { ok: false, error: [] };
}
