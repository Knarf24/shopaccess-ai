import { err, ok, type Result } from "@/lib/shared/result";

/**
 * Channel3 external-listing search (F04). Off unless both settings are present and valid:
 *  - `CHANNEL3_DISCOVERY=on`
 *  - `CHANNEL3_API_KEY`: sent only as the `x-api-key` header to https://api.trychannel3.com; never logged or shown.
 * Any other combination switches the shop off, like the AI settings. Values are never copied into errors.
 *
 * Search actions are limited before any outbound request: per session, per UTC hour and per UTC day (defaults 3 / 10 / 30;
 * optional `CHANNEL3_LIMIT_PER_SESSION`, `_PER_HOUR`, `_PER_DAY`, whole numbers 1–1000). The counters live in this
 * process only and reset when it restarts; the service must run as one instance.
 */
export type Channel3Config = { readonly mode: "off" } | { readonly mode: "live"; readonly apiKey: string };

export type Channel3ConfigError = "CHANNEL3_DISCOVERY_INVALID" | "CHANNEL3_API_KEY_MISSING" | "CHANNEL3_API_KEY_INVALID" | "CHANNEL3_LIMITS_INVALID";

export interface Channel3Limits {
  readonly perSession: number;
  readonly perHour: number;
  readonly perDay: number;
}

export const DEFAULT_CHANNEL3_LIMITS: Channel3Limits = { perSession: 3, perHour: 10, perDay: 30 };

const MAX_LIMIT = 1_000;
const LIMIT_VARIABLES = {
  perSession: "CHANNEL3_LIMIT_PER_SESSION",
  perHour: "CHANNEL3_LIMIT_PER_HOUR",
  perDay: "CHANNEL3_LIMIT_PER_DAY",
} as const;

/** A key is opaque: 1–256 visible ASCII characters, no whitespace. */
function validApiKey(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
}

export function parseChannel3Config(env: Readonly<Record<string, string | undefined>>): Result<Channel3Config, Channel3ConfigError[]> {
  const discovery = env.CHANNEL3_DISCOVERY;
  const apiKey = env.CHANNEL3_API_KEY;
  if (discovery === undefined && apiKey === undefined) return ok({ mode: "off" });
  const errors: Channel3ConfigError[] = [];
  if (discovery !== "on") errors.push("CHANNEL3_DISCOVERY_INVALID");
  if (apiKey === undefined) errors.push("CHANNEL3_API_KEY_MISSING");
  else if (!validApiKey(apiKey)) errors.push("CHANNEL3_API_KEY_INVALID");
  if (errors.length > 0 || apiKey === undefined) return err(errors);
  return ok({ mode: "live", apiKey });
}

/** All three absent: `null` (the defaults apply). Any present value must be a whole number from 1 to 1000. */
export function parseChannel3Limits(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; value: Channel3Limits | null } | { ok: false; error: "CHANNEL3_LIMITS_INVALID" } {
  const entries = Object.entries(LIMIT_VARIABLES) as [keyof Channel3Limits, string][];
  if (entries.every(([, name]) => env[name] === undefined)) return { ok: true, value: null };
  const limits: Record<keyof Channel3Limits, number> = { ...DEFAULT_CHANNEL3_LIMITS };
  for (const [key, name] of entries) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (!/^[1-9][0-9]{0,3}$/.test(raw) || Number(raw) > MAX_LIMIT) return { ok: false, error: "CHANNEL3_LIMITS_INVALID" };
    limits[key] = Number(raw);
  }
  return { ok: true, value: limits };
}
