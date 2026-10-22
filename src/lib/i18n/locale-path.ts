import { documentLocale, type DocumentLocale } from "@/lib/i18n/locale-segment";

/** Legacy GET pages whose language used to travel in `?lang`. Route handlers are not in this list. */
const LEGACY_PAGES = new Set(["/shop/needs", "/shop/chargers", "/shop/permissions", "/shop/profile", "/demo/admission", "/extension/pair"]);

export function isLegacyLocalizedPage(pathname: string): boolean {
  if (LEGACY_PAGES.has(pathname)) return true;
  return /^\/checkout\/[^/]+$/.test(pathname) && pathname !== "/checkout/start";
}

/**
 * One exact `lang=es` becomes `/es/...`. A missing, invalid, or repeated `lang` becomes `/en/...`.
 * `lang` is removed. Every other query key stays, in its original order. Anything else is left alone,
 * including POST and route handlers.
 */
export function legacyLocaleRedirect(method: string, pathname: string, search: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (!isLegacyLocalizedPage(pathname)) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const values = params.getAll("lang");
  const locale: DocumentLocale = values.length === 1 && values[0] === "es" ? "es" : "en";
  params.delete("lang");
  const query = params.toString();
  return `/${locale}${pathname}${query ? `?${query}` : ""}`;
}

/** Query string with every `lang` value removed and the other keys left in order. */
export function withoutLang(query: URLSearchParams | Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams();
  const entries = query instanceof URLSearchParams ? query.entries() : Object.entries(query);
  for (const [key, value] of entries) {
    if (key === "lang" || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, value);
    }
  }
  return params.toString();
}

export function localizedPage(locale: DocumentLocale, pathname: string, query = ""): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `/${locale}${path}${query ? `?${query}` : ""}`;
}

/**
 * Redirect only when a saved language disagrees with the path. The caller has already finished admission,
 * session, and ownership checks. A matching path stays put, including a leftover `lang` query.
 */
export function savedLanguageRedirect(pathLocale: string, saved: string | null | undefined, pathname: string, query: URLSearchParams | Record<string, string | string[] | undefined>): string | null {
  const path = documentLocale(pathLocale);
  const language = saved === "en" || saved === "es" ? saved : null;
  if (!path || !language || language === path) return null;
  return localizedPage(language, pathname, withoutLang(query));
}
