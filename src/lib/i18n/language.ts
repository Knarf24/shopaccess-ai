/** Shopper-facing language for the mock guided journey. It is not session or payment state. */
export type JourneyLanguage = "en" | "es";

/**
 * Returns `en` or `es` only when `value` is exactly that token.
 * Every other value, including a missing value, is omitted.
 * A checkout stores a language only through this function, so a tampered value is not stored
 * and a purchase that posted no language stays unchanged.
 */
export function explicitJourneyLanguage(value: string | null | undefined): JourneyLanguage | undefined {
  return value === "en" || value === "es" ? value : undefined;
}

/**
 * Safe default for the guided entry, the needs draft, and fixed redirects.
 * Missing or invalid input is English. Only this result may be written into a redirect query.
 */
export function allowlistedJourneyLanguage(value: string | null | undefined): JourneyLanguage {
  return explicitJourneyLanguage(value) ?? "en";
}

/** Fixed session entry. The argument is a language candidate, never a destination. */
export function guidedSessionEntry(value: string | null | undefined): string {
  return `/session/needs?lang=${allowlistedJourneyLanguage(value)}`;
}

/** Fixed guided page after the session exists. The argument is a language candidate, never a destination. */
export function guidedShopDestination(value: string | null | undefined): string {
  return `/shop/needs?started=1&lang=${allowlistedJourneyLanguage(value)}`;
}
