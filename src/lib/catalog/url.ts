import { isIP } from "node:net";
import { err, ok, type Result } from "../shared/result";

export const MAX_EXTERNAL_URL_LENGTH = 2048;

export type UnsafeUrlReason =
  | "NOT_A_STRING"
  | "TOO_LONG"
  | "MALFORMED"
  | "UNSUPPORTED_PROTOCOL"
  | "CREDENTIALS_PRESENT"
  | "HOST_NOT_ALLOWED";

/**
 * Validates an outbound link for display only. The server never fetches these
 * URLs; the check exists so shoppers are only ever offered plain HTTPS links to
 * public hostnames.
 */
export function parseSafeExternalUrl(input: unknown): Result<string, UnsafeUrlReason> {
  if (typeof input !== "string") return err("NOT_A_STRING");
  if (input.length === 0 || input.length > MAX_EXTERNAL_URL_LENGTH) return err(input.length === 0 ? "MALFORMED" : "TOO_LONG");
  // Reject whitespace and control characters outright instead of relying on URL normalization.
  if (/[\s\u0000-\u001f\u007f\\]/.test(input)) return err("MALFORMED");

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return err("MALFORMED");
  }
  if (url.protocol !== "https:") return err("UNSUPPORTED_PROTOCOL");
  if (url.username !== "" || url.password !== "") return err("CREDENTIALS_PRESENT");

  const host = url.hostname.toLowerCase();
  const bareHost = host.startsWith("[") ? host.slice(1, -1) : host;
  if (
    host === "" ||
    isIP(bareHost) !== 0 ||
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return err("HOST_NOT_ALLOWED");
  }
  return ok(url.href);
}
