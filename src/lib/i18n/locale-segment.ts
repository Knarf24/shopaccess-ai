/** Document locales the localized root layout may place on `<html lang>`. */
export const DOCUMENT_LOCALES = ["en", "es"] as const;

export type DocumentLocale = (typeof DOCUMENT_LOCALES)[number];

/** Exact `en` or `es` only. Every other segment, including `fr` and `en-US`, is rejected. */
export function documentLocale(value: string): DocumentLocale | null {
  return value === "en" || value === "es" ? value : null;
}
