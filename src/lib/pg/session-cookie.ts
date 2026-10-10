import { SESSION_COOKIE_NAME } from "../session/cookie";
import { SESSION_TOKEN_PATTERN } from "../session/token";
import { KEY_RING_MAX_VERSION } from "./key-ring";

/**
 * PostgreSQL-mode session cookie (specification 18.7).
 *
 * Same cookie name and attributes as Mock mode; only the value differs:
 * `version.token`. The Mock format (token only) is unchanged and is handled by
 * `src/lib/session/cookie.ts`, which this module does not alter.
 *
 * The version is a non-secret routing hint. It selects which configured key is
 * used to compute the token digest and proves nothing by itself: authority
 * comes only from the database's session record.
 */

export interface PgSessionCookie {
  readonly keyVersion: number;
  readonly token: string;
}

// Identical to the attributes Mock mode sets. A unit test compares the two.
const BASE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";

/** Decimal digits only, first digit 1 to 9, at most five digits. No sign, no leading zero. */
const VERSION_PATTERN = /^[1-9][0-9]{0,4}$/;

/**
 * Parses one cookie value. Anything that is not exactly `version.token` is
 * rejected: a missing dot (including a Mock-format value), more than one dot,
 * an empty part, whitespace, a sign, a leading zero, a version of 0 or above
 * 32767, or a malformed token.
 */
export function parsePgSessionCookieValue(value: string): PgSessionCookie | null {
  const separator = value.indexOf(".");
  if (separator === -1 || separator !== value.lastIndexOf(".")) return null;
  const versionText = value.slice(0, separator);
  const token = value.slice(separator + 1);
  if (!VERSION_PATTERN.test(versionText) || !SESSION_TOKEN_PATTERN.test(token)) return null;
  const keyVersion = Number(versionText);
  if (keyVersion > KEY_RING_MAX_VERSION) return null;
  return { keyVersion, token };
}

/**
 * Extracts the session cookie from a Cookie header. Returns null when the
 * cookie is absent, malformed, or present more than once: an ambiguous header
 * is treated as no session, never resolved by guessing.
 */
export function readPgSessionCookie(cookieHeader: string | null | undefined): PgSessionCookie | null {
  if (!cookieHeader) return null;
  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) values.push(part.slice(separator + 1).trim());
  }
  if (values.length !== 1) return null;
  return parsePgSessionCookieValue(values[0]);
}

export function serializePgSessionCookie(cookie: PgSessionCookie, maxAgeSeconds: number): string {
  const value = `${cookie.keyVersion}.${cookie.token}`;
  if (!Number.isInteger(cookie.keyVersion) || parsePgSessionCookieValue(value) === null) {
    throw new TypeError("Refusing to serialize a malformed session cookie");
  }
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${SESSION_COOKIE_NAME}=${value}; ${BASE_ATTRIBUTES}; Max-Age=${maxAge}`;
}
