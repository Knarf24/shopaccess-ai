import { readPgSessionCookie, type PgSessionCookie } from "@/lib/pg/session-cookie";
import type { PgSession, PgSessionCredential, PgSessionService } from "@/lib/pg/session-service";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { checkRequestProvenance, CSRF_HEADER_NAME } from "@/lib/session/request-guard";
import { err, ok, type Result } from "@/lib/shared/result";

/**
 * Request authorization for PostgreSQL mode (specification 19.19). NEVER RUN AGAINST A DATABASE.
 *
 * Separate from the mock's guard: this module never reads the mock's token-only cookie and never calls the mock's
 * session service. It keeps the same three checks in the same order: provenance (trusted origin and Fetch
 * Metadata), then a session the database authorizes for the presented `version.token` cookie, then the CSRF token
 * bound to that session.
 *
 * There is no second attempt of any kind: a cookie that is not exactly `version.token` is no session, a cookie the
 * database refuses is no session, and neither is tried under another key version, in another format, or against
 * the mock.
 */

/** Whether the request carries the session cookie at all, whatever its value. */
export type CookiePresence = "ABSENT" | "PRESENT";

/**
 * Counts the cookie pairs named exactly as the session cookie. This is decided apart from parsing: the parser
 * answers "no usable credential" for a missing, malformed and duplicated cookie alike, and only a missing one may
 * lead to a new session without the shopper asking for it.
 */
export function sessionCookiePresence(cookieHeader: string | null | undefined): CookiePresence {
  if (!cookieHeader) return "ABSENT";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    const name = separator === -1 ? part.trim() : part.slice(0, separator).trim();
    if (name === SESSION_COOKIE_NAME) return "PRESENT";
  }
  return "ABSENT";
}

/**
 * What an authorized PostgreSQL-mode request is served with. Server-only: it is created here and nowhere else, and
 * it is never serialised, logged, returned or handed to a component.
 */
export interface PgRequestContext {
  readonly session: PgSession;
  /** The credential as presented. Needed to rotate, and for nothing else. */
  readonly cookie: PgSessionCookie;
  /** The key version and token digest the checkout entry points take as their first two values. */
  readonly credential: PgSessionCredential;
}

export type PgSessionState =
  | { readonly presence: "ABSENT"; readonly context: null }
  | { readonly presence: "PRESENT"; readonly context: PgRequestContext | null };

/**
 * Resolves the session of a Cookie header: one `authorize_session` call for a well-formed cookie, and none
 * otherwise. A present cookie without a context is an unusable credential: malformed, duplicated, in the mock's
 * format, or refused by the database.
 */
export async function resolvePgSession(cookieHeader: string | null | undefined, sessions: PgSessionService): Promise<PgSessionState> {
  if (sessionCookiePresence(cookieHeader) === "ABSENT") return { presence: "ABSENT", context: null };
  const cookie = readPgSessionCookie(cookieHeader);
  if (!cookie) return { presence: "PRESENT", context: null };
  const resolved = await sessions.resolve(cookie);
  if (!resolved.ok) return { presence: "PRESENT", context: null };
  const credential = sessions.credentialOf(resolved.value);
  if (!credential) return { presence: "PRESENT", context: null };
  return { presence: "PRESENT", context: Object.freeze({ session: resolved.value, cookie, credential }) };
}

export interface PgGuardDeps {
  readonly sessions: PgSessionService;
  readonly trustedOrigins: ReadonlySet<string>;
}

/** Trusted-origin and Fetch Metadata checks only, for the one state-changing request that has no session yet. */
export function hasTrustedProvenance(request: Request, trustedOrigins: ReadonlySet<string>): boolean {
  return checkRequestProvenance(request.headers, trustedOrigins).ok;
}

/**
 * Authorizes a state-changing request: provenance, then the session, then the CSRF token from the header or, for
 * an HTML form that cannot set a header, from the form. Every failure is the same refusal.
 */
export async function authorizePgMutation(
  request: Request,
  deps: PgGuardDeps,
  formCsrfToken?: string | null,
): Promise<Result<PgRequestContext, "FORBIDDEN">> {
  if (!hasTrustedProvenance(request, deps.trustedOrigins)) return err("FORBIDDEN");
  const state = await resolvePgSession(request.headers.get("cookie"), deps.sessions);
  if (!state.context) return err("FORBIDDEN");
  const presented = request.headers.get(CSRF_HEADER_NAME) ?? formCsrfToken ?? null;
  if (!deps.sessions.verifyCsrfToken(state.context.session, presented)) return err("FORBIDDEN");
  return ok(state.context);
}
