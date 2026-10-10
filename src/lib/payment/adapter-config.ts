import { err, ok, type Result } from "../shared/result";

/**
 * Configuration parsing for a FUTURE payment adapter. No adapter exists in
 * this milestone and only `mock` can be activated. The parser exists now so
 * that live or mixed configuration is rejected from the first day an adapter
 * is written.
 */
export const SANDBOX_API_BASE_URL = "https://api-m.sandbox.paypal.com";

const CREDENTIAL_KEYS = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_API_BASE_URL", "PAYPAL_WEBHOOK_ID"] as const;

export type PaymentAdapterConfig =
  | { readonly mode: "mock" }
  | { readonly mode: "sandbox"; readonly apiBaseUrl: typeof SANDBOX_API_BASE_URL };

export type PaymentConfigRejection =
  | "MODE_MISSING"
  | "MODE_UNSUPPORTED"
  | "LIVE_MODE_FORBIDDEN"
  | "MOCK_MODE_WITH_PROVIDER_SETTINGS"
  | "SANDBOX_CREDENTIALS_INCOMPLETE"
  | "SANDBOX_BASE_URL_NOT_SANDBOX";

export function parsePaymentAdapterConfig(env: Readonly<Record<string, string | undefined>>): Result<PaymentAdapterConfig, PaymentConfigRejection> {
  const mode = env.PAYMENT_PROVIDER_MODE;
  if (!mode) return err("MODE_MISSING");
  if (mode === "live" || mode === "production") return err("LIVE_MODE_FORBIDDEN");

  if (mode === "mock") {
    // Mixed configuration: a mock deployment must not carry provider settings at all.
    if (CREDENTIAL_KEYS.some((key) => env[key])) return err("MOCK_MODE_WITH_PROVIDER_SETTINGS");
    return ok({ mode: "mock" });
  }

  if (mode === "sandbox") {
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return err("SANDBOX_CREDENTIALS_INCOMPLETE");
    // Exact match only: any other host, including the live API host, is rejected.
    if (env.PAYPAL_API_BASE_URL !== SANDBOX_API_BASE_URL) return err("SANDBOX_BASE_URL_NOT_SANDBOX");
    return ok({ mode: "sandbox", apiBaseUrl: SANDBOX_API_BASE_URL });
  }

  return err("MODE_UNSUPPORTED");
}

/** Gate for this milestone: anything other than the mock provider is refused. */
export function requireMockOnly(config: PaymentAdapterConfig): Result<{ readonly mode: "mock" }, "PROVIDER_NOT_AUTHORIZED_FOR_MILESTONE"> {
  return config.mode === "mock" ? ok({ mode: "mock" }) : err("PROVIDER_NOT_AUTHORIZED_FOR_MILESTONE");
}
