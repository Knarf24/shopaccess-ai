import { parsePaymentAdapterConfig, requireMockOnly } from "@/lib/payment/adapter-config";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { parseSessionKey } from "@/lib/session/token";
import { err, ok, type Result } from "@/lib/shared/result";

export interface RuntimeConfig {
  readonly sessionKey: Buffer;
  readonly trustedOrigins: ReadonlySet<string>;
}

export type RuntimeConfigError =
  | "SESSION_KEY_MISSING"
  | "SESSION_KEY_TOO_SHORT"
  | "TRUSTED_ORIGINS_MISSING"
  | "TRUSTED_ORIGINS_INVALID"
  | "PAYMENT_MODE_NOT_MOCK";

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
  if (!payment.ok || !requireMockOnly(payment.value).ok) errors.push("PAYMENT_MODE_NOT_MOCK");

  if (errors.length > 0 || !key.ok || !trustedOrigins) return err(errors);
  return ok({ sessionKey: key.value, trustedOrigins });
}
