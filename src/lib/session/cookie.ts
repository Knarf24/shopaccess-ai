import { SESSION_TOKEN_PATTERN } from "./token";

/**
 * The `__Host-` prefix makes browsers require Secure, Path=/ and no Domain.
 * These attributes are identical in every environment; local development uses
 * HTTPS on localhost (see docs/security-foundation.md) instead of weaker cookies.
 */
export const SESSION_COOKIE_NAME = "__Host-shopaccess_session";

const BASE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";

export function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new TypeError("Refusing to serialize a malformed session token");
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${SESSION_COOKIE_NAME}=${token}; ${BASE_ATTRIBUTES}; Max-Age=${maxAge}`;
}

export function serializeClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; ${BASE_ATTRIBUTES}; Max-Age=0`;
}

/**
 * Extracts the session token from a Cookie header. Returns null when the cookie
 * is absent, malformed, or present more than once (an ambiguous header is
 * treated as no session rather than guessing which value to trust).
 */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) values.push(part.slice(separator + 1).trim());
  }
  if (values.length !== 1) return null;
  return SESSION_TOKEN_PATTERN.test(values[0]) ? values[0] : null;
}
