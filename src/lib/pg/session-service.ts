import { deriveCsrfToken, digestSessionToken, generateSessionToken } from "../session/token";
import type { Clock } from "../shared/clock";
import { constantTimeEqual } from "../shared/crypto";
import type { IdGenerator } from "../shared/ids";
import { err, ok, type Result } from "../shared/result";
import { runWithReruns, type PgQueryable, type RerunOptions } from "./client";
import { loadKeyState, type ConfiguredKeyRings, type KeyState } from "./key-ring";
import type { PgSessionCookie } from "./session-cookie";
import { SESSION_STATEMENTS } from "./statements";

/**
 * PostgreSQL session service (specification 18.3 and 18.7).
 *
 * A separate service that sits beside the Mock `createSessionService`. It is
 * NOT wired into the running application in Increment 1, and the Mock service,
 * its cookie format and its behaviour are unchanged.
 *
 * Every decision is taken by the database: this service computes token digests
 * with the configured key, calls one entry-point function per operation, and
 * reports the result. It never reads a session row, never learns an owner id,
 * and never tries a second key version for a presented cookie.
 *
 * Rotation is bound to identity twice. The session object must be one this
 * service instance returned, and the presented cookie must be the credential
 * that object was resolved from; otherwise nothing is sent to the database.
 * The session id of the result is the one the database reports for the row it
 * rotated, never a value taken from the caller's object.
 *
 * Differences from the Mock service, by design:
 *  - one generic rejection instead of five specific reasons;
 *  - rotation takes the resolved session and the presented cookie;
 *  - revocation takes the presented cookie, not a session id;
 *  - there is no purge method: cleanup happens inside admission.
 */

export interface PgSession {
  readonly id: string;
  readonly csrfToken: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly keyVersion: number;
  /** VERIFY_ONLY means the session is valid but should be rotated to the ACTIVE key. */
  readonly keyStatus: "ACTIVE" | "VERIFY_ONLY";
}

export interface IssuedPgSession {
  readonly session: PgSession;
  /** Cookie to set. Present only when a new token was minted. */
  readonly issuedCookie: PgSessionCookie | null;
}

/**
 * The credential a session object was resolved from, as the checkout entry points take it: the key version and the
 * token digest. Server-side only. It is passed to an entry point and to nothing else: never to a response, a log
 * or a component.
 */
export interface PgSessionCredential {
  readonly keyVersion: number;
  readonly tokenDigest: string;
}

export type PgSessionRejection = "NOT_AUTHORIZED";
export type PgAdmissionRefusal = "RATE_LIMITED" | "AT_CAPACITY" | "KEY_UNAVAILABLE" | "REFUSED";
export type PgRotationRefusal = "NOT_AUTHORIZED" | "KEY_UNAVAILABLE";

export interface PgSessionServiceDeps {
  /** Each entry point is one statement, so a single-statement runner (a pool) is sufficient. */
  readonly db: PgQueryable;
  /** Both rings, as returned by `loadKeyRings`. Only the `session` ring is used here. */
  readonly rings: ConfiguredKeyRings;
  readonly ids: IdGenerator;
  /** Used only to pace key-state refreshes and to compute cookie Max-Age. Never to decide liveness. */
  readonly clock: Clock;
  readonly rerun?: RerunOptions;
  /** Minimum time between two key-state reads triggered by an unknown cookie version. */
  readonly keyStateRefreshIntervalMs?: number;
}

export interface PgSessionService {
  resolve(cookie: PgSessionCookie | null): Promise<Result<PgSession, PgSessionRejection>>;
  /** Resolves a valid session or admits a fresh one. Never adopts a client-supplied identifier. */
  establish(cookie: PgSessionCookie | null): Promise<Result<IssuedPgSession, PgAdmissionRefusal>>;
  /**
   * Rotates the token of `session`. `session` must come from this service and
   * `cookie` must be the credential it was resolved from; a mismatch is
   * NOT_AUTHORIZED and rotates nothing.
   */
  rotate(session: PgSession, cookie: PgSessionCookie): Promise<Result<IssuedPgSession, PgRotationRefusal>>;
  revoke(cookie: PgSessionCookie | null): Promise<void>;
  /**
   * The credential of a session object this instance returned. Null for any other object, and for a session whose
   * credential a rotation has since replaced. The digest still originates only inside this service.
   */
  credentialOf(session: PgSession): PgSessionCredential | null;
  verifyCsrfToken(session: PgSession, presented: string | null): boolean;
  cookieMaxAgeSeconds(session: PgSession): number;
}

const DEFAULT_KEY_STATE_REFRESH_INTERVAL_MS = 5_000;

function firstRow(rows: readonly unknown[]): Record<string, unknown> {
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new Error("Entry point did not return exactly one row");
  }
  return rows[0] as Record<string, unknown>;
}

const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) throw new Error("Entry point returned an invalid session id");
  return value;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("Entry point returned an invalid timestamp");
  return value;
}

/**
 * A refusal of a session entry point carries nothing: every column after `result` is present and NULL (migration
 * 0006). A row that names a refusal and carries a value, or lacks a column, is not that refusal: it is refused as
 * a malformed answer, like any other row that is not what the entry point returns.
 */
const ADMIT_REFUSAL_COLUMNS = ["absolute_expires_at", "idle_expires_at"] as const;
const AUTHORIZE_REFUSAL_COLUMNS = ["session_id", "absolute_expires_at", "idle_expires_at", "key_status"] as const;
const ROTATE_REFUSAL_COLUMNS = ["session_id", "absolute_expires_at", "idle_expires_at"] as const;

function requireEmptyRefusal(row: Record<string, unknown>, columns: readonly string[]): void {
  for (const column of columns) {
    if (row[column] !== null) throw new Error("Entry point returned a refusal that is not empty");
  }
}

/** The credential a session object was resolved from. Held by the service, never by the caller. */
interface SessionBinding {
  readonly keyVersion: number;
  readonly tokenDigest: string;
}

export function createPgSessionService(deps: PgSessionServiceDeps): PgSessionService {
  const { db, ids, clock } = deps;
  const ring = deps.rings.session;
  if (deps.rings.validated !== true || ring.purpose !== "session") {
    throw new TypeError("The session service requires validated key rings");
  }
  const statements = SESSION_STATEMENTS;
  const refreshIntervalMs = deps.keyStateRefreshIntervalMs ?? DEFAULT_KEY_STATE_REFRESH_INTERVAL_MS;

  let keyState: KeyState | null = null;
  let keyStateReadAt = Number.NEGATIVE_INFINITY;

  // Sessions this instance returned, with the credential each was resolved from.
  // A caller cannot forge an entry: the map is reachable only from this closure.
  const bindings = new WeakMap<PgSession, SessionBinding>();
  function bound(session: PgSession, binding: SessionBinding): PgSession {
    const frozen = Object.freeze(session);
    bindings.set(frozen, binding);
    return frozen;
  }

  // Each entry point is one statement, so each call is one implicit transaction and is safe to re-run.
  const call = (text: string, values: readonly unknown[]) => runWithReruns(() => db.query(text, values), deps.rerun);

  async function refreshKeyState(): Promise<KeyState | null> {
    keyStateReadAt = clock().getTime();
    const loaded = await loadKeyState(db, ring);
    keyState = loaded.ok ? loaded.value : null;
    return keyState;
  }

  /**
   * Whether a presented cookie version may be used. A version that is not
   * configured, is staged (no database row) or has been revoked may not, and
   * no other version is ever tried in its place.
   */
  async function isUsable(version: number): Promise<boolean> {
    if (!ring.has(version)) return false;
    if (!keyState || (!keyState.usable.has(version) && clock().getTime() - keyStateReadAt >= refreshIntervalMs)) {
      await refreshKeyState();
    }
    return keyState?.usable.has(version) === true;
  }

  /** Token digest and CSRF token under one version's key. The key copy is zeroed after use. */
  function derive(version: number, token: string): { tokenDigest: string; csrfToken: string } | null {
    return ring.useKey(version, (key) => {
      const tokenDigest = digestSessionToken(key, token);
      return { tokenDigest, csrfToken: deriveCsrfToken(key, tokenDigest) };
    });
  }

  async function resolve(cookie: PgSessionCookie | null): Promise<Result<PgSession, PgSessionRejection>> {
    if (!cookie) return err("NOT_AUTHORIZED");
    if (!(await isUsable(cookie.keyVersion))) return err("NOT_AUTHORIZED");
    const derived = derive(cookie.keyVersion, cookie.token);
    if (!derived) return err("NOT_AUTHORIZED");
    const row = firstRow((await call(statements.authorizeSession, [cookie.keyVersion, derived.tokenDigest])).rows);
    if (row.result === "NOT_AUTHORIZED") requireEmptyRefusal(row, AUTHORIZE_REFUSAL_COLUMNS);
    if (row.result !== "AUTHORIZED") return err("NOT_AUTHORIZED");
    if (row.key_status !== "ACTIVE" && row.key_status !== "VERIFY_ONLY") {
      throw new Error("authorize_session returned an unexpected row");
    }
    return ok(
      bound(
        {
          id: requireSessionId(row.session_id),
          csrfToken: derived.csrfToken,
          idleExpiresAt: requireDate(row.idle_expires_at),
          absoluteExpiresAt: requireDate(row.absolute_expires_at),
          keyVersion: cookie.keyVersion,
          keyStatus: row.key_status,
        },
        { keyVersion: cookie.keyVersion, tokenDigest: derived.tokenDigest },
      ),
    );
  }

  async function admit(): Promise<Result<IssuedPgSession, PgAdmissionRefusal>> {
    // One retry only: when the database reports that the version this process believed ACTIVE no longer is.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = attempt === 0 && keyState ? keyState : await refreshKeyState();
      if (!state) return err("KEY_UNAVAILABLE");

      const token = generateSessionToken();
      const derived = derive(state.activeVersion, token);
      if (!derived) return err("KEY_UNAVAILABLE");
      const sessionId = ids("session");
      const row = firstRow((await call(statements.admitSession, [sessionId, state.activeVersion, derived.tokenDigest])).rows);

      switch (row.result) {
        case "ADMITTED":
          return ok({
            session: bound(
              {
                id: sessionId,
                csrfToken: derived.csrfToken,
                idleExpiresAt: requireDate(row.idle_expires_at),
                absoluteExpiresAt: requireDate(row.absolute_expires_at),
                keyVersion: state.activeVersion,
                keyStatus: "ACTIVE",
              },
              { keyVersion: state.activeVersion, tokenDigest: derived.tokenDigest },
            ),
            issuedCookie: { keyVersion: state.activeVersion, token },
          });
        case "RATE_LIMITED":
          requireEmptyRefusal(row, ADMIT_REFUSAL_COLUMNS);
          return err("RATE_LIMITED");
        case "AT_CAPACITY":
          requireEmptyRefusal(row, ADMIT_REFUSAL_COLUMNS);
          return err("AT_CAPACITY");
        case "KEY_NOT_ACTIVE":
          requireEmptyRefusal(row, ADMIT_REFUSAL_COLUMNS);
          keyState = null;
          continue;
        case "REFUSED":
          requireEmptyRefusal(row, ADMIT_REFUSAL_COLUMNS);
          return err("REFUSED");
        default:
          throw new Error("admit_session returned an unexpected result");
      }
    }
    return err("KEY_UNAVAILABLE");
  }

  return {
    resolve,

    async establish(cookie) {
      const existing = await resolve(cookie);
      if (existing.ok) return ok({ session: existing.value, issuedCookie: null });
      return admit();
    },

    async rotate(session, cookie) {
      // Identity binding, before anything reaches the database.
      const binding = bindings.get(session);
      if (!binding || binding.keyVersion !== cookie.keyVersion) return err("NOT_AUTHORIZED");
      if (!(await isUsable(cookie.keyVersion))) return err("NOT_AUTHORIZED");
      const presented = derive(cookie.keyVersion, cookie.token);
      if (!presented || !constantTimeEqual(presented.tokenDigest, binding.tokenDigest)) return err("NOT_AUTHORIZED");

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = attempt === 0 && keyState ? keyState : await refreshKeyState();
        if (!state) return err("KEY_UNAVAILABLE");

        const token = generateSessionToken();
        const renewed = derive(state.activeVersion, token);
        if (!renewed) return err("KEY_UNAVAILABLE");
        const row = firstRow(
          (
            await call(statements.rotateSession, [
              cookie.keyVersion,
              presented.tokenDigest,
              state.activeVersion,
              renewed.tokenDigest,
            ])
          ).rows,
        );

        switch (row.result) {
          case "ROTATED":
            // The old credential no longer exists, so the old object can rotate nothing further.
            bindings.delete(session);
            return ok({
              session: bound(
                {
                  // Authoritative: the id of the row the database rotated.
                  id: requireSessionId(row.session_id),
                  csrfToken: renewed.csrfToken,
                  idleExpiresAt: requireDate(row.idle_expires_at),
                  absoluteExpiresAt: requireDate(row.absolute_expires_at),
                  keyVersion: state.activeVersion,
                  keyStatus: "ACTIVE",
                },
                { keyVersion: state.activeVersion, tokenDigest: renewed.tokenDigest },
              ),
              issuedCookie: { keyVersion: state.activeVersion, token },
            });
          case "NOT_AUTHORIZED":
            requireEmptyRefusal(row, ROTATE_REFUSAL_COLUMNS);
            return err("NOT_AUTHORIZED");
          case "KEY_NOT_ACTIVE":
            requireEmptyRefusal(row, ROTATE_REFUSAL_COLUMNS);
            keyState = null;
            continue;
          default:
            throw new Error("rotate_session returned an unexpected result");
        }
      }
      return err("KEY_UNAVAILABLE");
    },

    async revoke(cookie) {
      if (!cookie) return;
      // Revocation is attempted for any configured version, including one the database has since revoked.
      const derived = derive(cookie.keyVersion, cookie.token);
      if (!derived) return;
      await call(statements.revokeSession, [cookie.keyVersion, derived.tokenDigest]);
    },

    credentialOf(session) {
      const binding = bindings.get(session);
      return binding ? Object.freeze({ keyVersion: binding.keyVersion, tokenDigest: binding.tokenDigest }) : null;
    },

    verifyCsrfToken(session, presented) {
      if (!presented) return false;
      return constantTimeEqual(session.csrfToken, presented);
    },

    cookieMaxAgeSeconds(session) {
      return Math.max(0, Math.floor((session.absoluteExpiresAt.getTime() - clock().getTime()) / 1000));
    },
  };
}
