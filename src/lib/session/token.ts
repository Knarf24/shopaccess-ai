import { hmacSha256Hex, randomTokenBase64Url } from "../shared/crypto";
import { err, ok, type Result } from "../shared/result";

/** 32 random bytes (256 bits), base64url encoded without padding. */
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_KEY_MIN_BYTES = 32;

export function generateSessionToken(): string {
  return randomTokenBase64Url(32);
}

/** Only the keyed digest is persisted; the raw token lives in the cookie alone. */
export function digestSessionToken(key: Buffer, token: string): string {
  return hmacSha256Hex(key, "shopaccess.session.v1", token);
}

/** CSRF token bound to the current session token digest, so rotation invalidates it. */
export function deriveCsrfToken(key: Buffer, tokenDigest: string): string {
  return hmacSha256Hex(key, "shopaccess.csrf.v1", tokenDigest);
}

/**
 * Parses the server-side digest key from configuration (base64, >= 32 bytes).
 * Fails closed: a missing or short key is an error, never a default.
 */
export function parseSessionKey(value: string | undefined): Result<Buffer, "KEY_MISSING" | "KEY_TOO_SHORT"> {
  if (!value) return err("KEY_MISSING");
  const key = Buffer.from(value, "base64");
  if (key.length < SESSION_KEY_MIN_BYTES) return err("KEY_TOO_SHORT");
  return ok(key);
}
