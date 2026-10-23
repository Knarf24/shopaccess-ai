import { parsePaymentAdapterConfig, requireMockOnly } from "@/lib/payment/adapter-config";
import { parseAdvisoryApiKey, parseAdvisoryEndpoint, parseAdvisoryModelId } from "@/lib/providers/qwen-advisory";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { parseSessionKey } from "@/lib/session/token";
import { err, ok, type Result } from "@/lib/shared/result";
import { parseAdvisoryBudget, type AdvisoryBudget, type AdvisoryBudgetError } from "./advisory-budget";
import { parseAdvisoryLimits, type AdvisoryLimits } from "./advisory-limits";

export type AdvisoryConfig =
  | { readonly mode: "local" }
  | { readonly mode: "external"; readonly modelId: string; readonly endpoint: string; readonly apiKey: string };

export interface RuntimeConfig {
  readonly sessionKey: Buffer;
  readonly trustedOrigins: ReadonlySet<string>;
  /**
   * Exact `chrome-extension://<id>` origins allowed to use /api/extension/v1 (M2-2). Absent: the extension API is
   * switched off (404) and the application is unchanged.
   */
  readonly extensionOrigins?: ReadonlySet<string>;
  /** Absent means the local assistant. Parsed configuration always sets this. */
  readonly advisory?: AdvisoryConfig;
  /** Absent means the advisory transport budget is off. Parsed configuration sets this only when the budget is on. */
  readonly advisoryBudget?: Extract<AdvisoryBudget, { mode: "on" }>;
  /** Server-wide AI call limits for external mode. Absent means DEFAULT_ADVISORY_LIMITS (6 per session, 120/hour, 600/day). */
  readonly advisoryLimits?: AdvisoryLimits;
  /**
   * Absent for parsed mock configuration. A parsed sandbox configuration on
   * the in-memory runtime sets it, including the client id and secret, which
   * stay in process memory and are never copied into configuration errors.
   */
  readonly payment?:
    | { readonly mode: "mock" }
    | {
        readonly mode: "sandbox";
        readonly apiBaseUrl: string;
        readonly merchantId: string;
        readonly clientId: string;
        readonly clientSecret: string;
      };
}

export type RuntimeConfigError =
  | "SESSION_KEY_MISSING"
  | "SESSION_KEY_TOO_SHORT"
  | "TRUSTED_ORIGINS_MISSING"
  | "TRUSTED_ORIGINS_INVALID"
  | "PAYMENT_MODE_NOT_MOCK"
  | "ADVISORY_MODEL_ID_MISSING"
  | "ADVISORY_MODEL_ID_INVALID"
  | "ADVISORY_ENDPOINT_MISSING"
  | "ADVISORY_ENDPOINT_INVALID"
  | "ADVISORY_API_KEY_MISSING"
  | "ADVISORY_API_KEY_INVALID"
  | "DEMO_ADMISSION_UNSUPPORTED"
  | "ADVISORY_LIMITS_INVALID"
  /** Snapshot persistence is configured, so the runtime must be opened through openRuntime (src/server/runtime-access.ts). */
  | "MOCK_STORE_REQUIRES_OPEN_RUNTIME"
  /** Snapshot persistence together with PostgreSQL mode is unsupported. */
  | "MOCK_STORE_UNSUPPORTED"
  /** SHOPACCESS_EXTENSION_ORIGINS is set but is not a comma-separated list of chrome-extension origins. */
  | "EXTENSION_ORIGINS_INVALID"
  | AdvisoryBudgetError;

export type PersistenceMode = "mock" | "postgres";

/**
 * Which store the application runs on. PostgreSQL mode is opt-in: it is chosen only by the exact value `postgres`.
 * With the variable not set at all the application is the in-memory mock, as before. Any other value, an empty one
 * included, is an error: nothing is guessed, and a mistyped mode never becomes the mock.
 */
export function parsePersistenceMode(env: Readonly<Record<string, string | undefined>>): Result<PersistenceMode, "PERSISTENCE_MODE_INVALID"> {
  const value = env.SHOPACCESS_PERSISTENCE_MODE;
  if (value === undefined) return ok("mock");
  if (value === "postgres") return ok("postgres");
  return err("PERSISTENCE_MODE_INVALID");
}

/**
 * Parses required runtime security configuration. Fails closed: there are no
 * defaults for the session key, trusted origins or payment mode.
 *
 * Plain-HTTP loopback origins are accepted only when NODE_ENV is exactly
 * "development". Production configuration can never enable them.
 */
export function parseRuntimeConfig(env: Readonly<Record<string, string | undefined>>): Result<RuntimeConfig, RuntimeConfigError[]> {
  const errors: RuntimeConfigError[] = [];

  const key = parseSessionKey(env.SHOPACCESS_SESSION_KEY);
  if (!key.ok) errors.push(key.error === "KEY_MISSING" ? "SESSION_KEY_MISSING" : "SESSION_KEY_TOO_SHORT");

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
  let sandboxPayment: RuntimeConfig["payment"] = undefined;
  if (!payment.ok) errors.push("PAYMENT_MODE_NOT_MOCK");
  else if (payment.value.mode === "sandbox") {
    const clientId = env.PAYPAL_CLIENT_ID;
    const clientSecret = env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) errors.push("PAYMENT_MODE_NOT_MOCK");
    else sandboxPayment = { mode: "sandbox", apiBaseUrl: payment.value.apiBaseUrl, merchantId: payment.value.merchantId, clientId, clientSecret };
  } else if (!requireMockOnly(payment.value).ok) errors.push("PAYMENT_MODE_NOT_MOCK");

  const advisory = parseAdvisoryConfig(env);
  if (!advisory.ok) errors.push(...advisory.error);

  const budget = parseAdvisoryBudget(env, {
    advisory: advisory.ok ? advisory.value.mode : "invalid",
    repoRoot: process.cwd(),
  });
  if (!budget.ok) errors.push(budget.error);

  const limits = parseAdvisoryLimits(env);
  if (!limits.ok) errors.push(limits.error);

  const extensionOrigins = parseExtensionOrigins(env.SHOPACCESS_EXTENSION_ORIGINS);
  if (extensionOrigins === "invalid") errors.push("EXTENSION_ORIGINS_INVALID");

  if (errors.length > 0 || !key.ok || !trustedOrigins || !advisory.ok || !budget.ok || !limits.ok || extensionOrigins === "invalid") return err(errors);
  const budgeted = budget.value.mode === "off"
    ? { sessionKey: key.value, trustedOrigins, advisory: advisory.value }
    : { sessionKey: key.value, trustedOrigins, advisory: advisory.value, advisoryBudget: budget.value };
  const base = limits.value ? { ...budgeted, advisoryLimits: limits.value } : budgeted;
  const parsed = extensionOrigins ? { ...base, extensionOrigins } : base;
  return ok(sandboxPayment ? { ...parsed, payment: sandboxPayment } : parsed);
}

/** Absent: no extension API. Present: one or more exact chrome-extension origins, comma separated. */
function parseExtensionOrigins(value: string | undefined): ReadonlySet<string> | null | "invalid" {
  if (value === undefined) return null;
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0 || !origins.every((origin) => /^chrome-extension:\/\/[a-p]{32}$/.test(origin))) return "invalid";
  return new Set(origins);
}

/**
 * All three advisory settings absent selects the local assistant.
 * Any one of them present requires all three to be valid. Values are never copied into errors.
 */
function parseAdvisoryConfig(env: Readonly<Record<string, string | undefined>>): Result<AdvisoryConfig, RuntimeConfigError[]> {
  const model = env.SHOPACCESS_AI_MODEL_ID;
  const endpoint = env.SHOPACCESS_AI_ENDPOINT;
  const apiKey = env.SHOPACCESS_AI_API_KEY;
  if (model === undefined && endpoint === undefined && apiKey === undefined) return ok({ mode: "local" });

  const errors: RuntimeConfigError[] = [];
  const modelId = model === undefined ? null : parseAdvisoryModelId(model);
  const normalized = endpoint === undefined ? null : parseAdvisoryEndpoint(endpoint);
  const key = apiKey === undefined ? null : parseAdvisoryApiKey(apiKey);
  if (model === undefined) errors.push("ADVISORY_MODEL_ID_MISSING");
  else if (modelId === null) errors.push("ADVISORY_MODEL_ID_INVALID");
  if (endpoint === undefined) errors.push("ADVISORY_ENDPOINT_MISSING");
  else if (normalized === null) errors.push("ADVISORY_ENDPOINT_INVALID");
  if (apiKey === undefined) errors.push("ADVISORY_API_KEY_MISSING");
  else if (key === null) errors.push("ADVISORY_API_KEY_INVALID");
  if (errors.length > 0 || modelId === null || normalized === null || key === null) return err(errors);
  return ok({ mode: "external", modelId, endpoint: normalized, apiKey: key });
}
