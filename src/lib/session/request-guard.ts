import { err, ok, type Result } from "../shared/result";
import { readSessionCookie } from "./cookie";
import type { Session, SessionRejection, SessionService } from "./service";

export const CSRF_HEADER_NAME = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ProvenanceRejection = "ORIGIN_MISSING" | "ORIGIN_UNTRUSTED" | "FETCH_SITE_REJECTED";
export type MutationRejection = ProvenanceRejection | SessionRejection | "CSRF_TOKEN_INVALID";

export function isMutationMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export interface TrustedOriginOptions {
  /**
   * Local development only: also accept plain-HTTP loopback origins
   * (http://localhost:PORT, http://127.0.0.1:PORT). This never changes cookie
   * attributes, and runtime configuration refuses to enable it in production.
   */
  readonly allowLoopbackHttp?: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Builds the trusted-origin allowlist. Every entry must be a bare HTTPS origin;
 * anything else is a configuration error, not something to tolerate.
 */
export function parseTrustedOrigins(origins: readonly string[], options: TrustedOriginOptions = {}): ReadonlySet<string> {
  const trusted = new Set<string>();
  for (const candidate of origins) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new TypeError("Trusted origin is not a valid URL");
    }
    const loopbackHttp = options.allowLoopbackHttp === true && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
    if ((url.protocol !== "https:" && !loopbackHttp) || url.origin !== candidate) {
      throw new TypeError("Trusted origins must be bare https origins");
    }
    trusted.add(url.origin);
  }
  if (trusted.size === 0) throw new TypeError("At least one trusted origin is required");
  return trusted;
}

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** Trusted-origin and Fetch Metadata checks for a state-changing request. */
export function checkRequestProvenance(
  headers: Headers,
  trustedOrigins: ReadonlySet<string>,
): Result<void, ProvenanceRejection> {
  // Sec-Fetch-Site is absent in older browsers; when present, only same-origin may mutate.
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return err("FETCH_SITE_REJECTED");

  const originHeader = headers.get("origin");
  const origin = originHeader !== null ? originOf(originHeader) : originOf(headers.get("referer"));
  if (origin === null) return err(originHeader === null && !headers.get("referer") ? "ORIGIN_MISSING" : "ORIGIN_UNTRUSTED");
  if (!trustedOrigins.has(origin)) return err("ORIGIN_UNTRUSTED");
  return ok(undefined);
}

export interface MutationGuardDeps {
  readonly sessions: SessionService;
  readonly trustedOrigins: ReadonlySet<string>;
}

/**
 * Authorizes a state-changing request: provenance, then an existing server-side
 * session, then the session-bound CSRF token. Any failure rejects the request.
 */
export async function authorizeMutation(
  request: Request,
  deps: MutationGuardDeps,
  /** CSRF token from a form field, for HTML form posts that cannot set a header. */
  formCsrfToken?: string | null,
): Promise<Result<Session, MutationRejection>> {
  const provenance = checkRequestProvenance(request.headers, deps.trustedOrigins);
  if (!provenance.ok) return provenance;

  const session = await deps.sessions.resolve(readSessionCookie(request.headers.get("cookie")));
  if (!session.ok) return session;

  if (!deps.sessions.verifyCsrfToken(session.value, request.headers.get(CSRF_HEADER_NAME) ?? formCsrfToken ?? null)) {
    return err("CSRF_TOKEN_INVALID");
  }
  return ok(session.value);
}
