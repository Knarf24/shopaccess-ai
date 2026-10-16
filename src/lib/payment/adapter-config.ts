import { err, ok, type Result } from "../shared/result";

/**
 * Payment-adapter configuration. Mock is the default. A complete sandbox
 * configuration can be parsed. The in-memory runtime may attach it. PostgreSQL
 * mode still calls `requireMockOnly` and refuses it. The parsed adapter result
 * never includes the client id or secret.
 */
export const SANDBOX_API_BASE_URL = "https://api-m.sandbox.paypal.com";
export const DEMO_CATALOG_MERCHANT_ID = "dmm_shopaccessdemo";
const PAYPAL_MERCHANT_ID_PATTERN = /^[2-9A-HJ-NP-Z]{13}$/;

const CREDENTIAL_KEYS = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_API_BASE_URL", "PAYPAL_WEBHOOK_ID", "PAYPAL_SANDBOX_MERCHANT_ID"] as const;

export type PaymentAdapterConfig =
  | { readonly mode: "mock" }
  | { readonly mode: "sandbox"; readonly apiBaseUrl: typeof SANDBOX_API_BASE_URL; readonly merchantId: string };

export type PaymentConfigRejection =
  | "MODE_MISSING"
  | "MODE_UNSUPPORTED"
  | "LIVE_MODE_FORBIDDEN"
  | "MOCK_MODE_WITH_PROVIDER_SETTINGS"
  | "SANDBOX_CREDENTIALS_INCOMPLETE"
  | "SANDBOX_BASE_URL_NOT_SANDBOX"
  | "SANDBOX_MERCHANT_ID_INVALID";

export function sandboxCorrelationId(quoteId: string): string {
  return `${DEMO_CATALOG_MERCHANT_ID}:${quoteId}`;
}

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
    const merchantId = env.PAYPAL_SANDBOX_MERCHANT_ID;
    if (!merchantId || !PAYPAL_MERCHANT_ID_PATTERN.test(merchantId)) return err("SANDBOX_MERCHANT_ID_INVALID");
    return ok({ mode: "sandbox", apiBaseUrl: SANDBOX_API_BASE_URL, merchantId });
  }

  return err("MODE_UNSUPPORTED");
}

/** PostgreSQL startup still refuses anything other than mock. The in-memory runtime does not call this for a parsed sandbox configuration. */
export function requireMockOnly(config: PaymentAdapterConfig): Result<{ readonly mode: "mock" }, "PROVIDER_NOT_AUTHORIZED_FOR_MILESTONE"> {
  return config.mode === "mock" ? ok({ mode: "mock" }) : err("PROVIDER_NOT_AUTHORIZED_FOR_MILESTONE");
}
