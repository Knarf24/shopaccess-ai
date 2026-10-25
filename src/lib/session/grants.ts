import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import type { DurableHost } from "./durable";
import type { GrantScope, PersistedGrant } from "./snapshot-state";

/**
 * Extension pairing and conversation grants (M2-2, docs/m2-2-plan.md §3.2–3.3).
 *
 * A pairing is started by the extension, approved on the website by a live (and, when admission is on, admitted)
 * session, and exchanged once for a bearer token. Pairings are memory-only and last five minutes. Grants are durable:
 * only an HMAC digest of the token is kept. Exchanging a pairing from the same installation replaces that
 * installation's earlier grant in the same durable decision; different installations coexist, three at most.
 *
 * M2-2 finding 3: each pairing has a six-digit matching code, returned only in the start response to the panel that began
 * it. Approval on the website requires typing that code; only a keyed digest bound to the pairing ID is kept (in memory,
 * never saved). Five wrong codes end the pairing. Deny needs no code. Exchange still needs the secret and the verifier.
 */

export const PAIRING_LIFETIME_MS = 300_000;
export const GRANT_LIFETIME_MS = 3_600_000;
export const MAX_ACTIVE_GRANTS = 3;
const MAX_APPROVED_PAIRINGS = 3;
const MAX_POLLS = 10;
const MIN_POLL_GAP_MS = 2_000;
export const MAX_CODE_ATTEMPTS = 5;
const CODE_LABEL = "shopaccess.extension-pairing-code.v1";
const MATCH_CODE = /^[0-9]{6}$/;
const STARTS_PER_MINUTE = 30;
const GRANT_SCOPES: readonly GrantScope[] = ["conversation:read", "conversation:write"];
const TOKEN_LABEL = "shopaccess.extension-grant.v1";
const HEX_64 = /^[0-9a-f]{64}$/;
const INSTALLATION_ID = /^ins_[0-9a-f]{32}$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export type PairingRefusal =
  | "BAD_REQUEST"
  | "RATE_LIMIT"
  | "PAIRING_UNKNOWN"
  | "PAIRING_EXPIRED"
  | "PAIRING_ALREADY_DECIDED"
  | "PAIRING_NOT_APPROVED"
  | "PAIRING_LIMIT"
  | "POLL_LIMIT"
  | "POLL_TOO_SOON"
  | "VERIFIER_INVALID"
  | "SESSION_INVALID"
  | "GRANT_LIMIT"
  | "PAIRING_CODE_MISMATCH"
  | "PAIRING_CODE_LIMIT";

export type Refused = { readonly ok: false; readonly code: PairingRefusal };
type Ok<T> = { readonly ok: true; readonly value: T };

interface Pairing {
  readonly pairingId: string;
  readonly challenge: string;
  readonly exchangeDigest: string;
  /** Keyed digest of the matching code, bound to the pairing ID. The code itself is never kept. */
  readonly codeDigest: string;
  codeAttempts: number;
  readonly extensionOrigin: string;
  readonly installationId: string;
  readonly expiresAtMs: number;
  status: "pending" | "approved" | "denied" | "consumed";
  sessionId: string | null;
  /** Admission expiry recorded at approval (admission on), or null. Bounds the grant. */
  boundMs: number | null;
  polls: number;
  lastPollMs: number;
}

export interface GrantView {
  readonly grantId: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface PairingAuthority {
  start(input: { readonly challenge: unknown; readonly extensionOrigin: string; readonly installationId: unknown }, nowMs: number): Ok<{ pairingId: string; exchangeSecret: string; matchCode: string; expiresAt: number }> | Refused;
  status(input: { readonly pairingId: string; readonly exchangeSecret: unknown; readonly extensionOrigin: string }, nowMs: number): Ok<{ status: "pending" | "approved" | "denied" }> | Refused;
  /**
   * Called by the website after its own session, admission and CSRF checks. Approval requires the pairing's matching code;
   * deny does not. Synchronous: the check, the attempt count and the decision happen in one step.
   */
  approve(
    input: { readonly pairingId: string; readonly sessionId: string; readonly deny: boolean; readonly boundMs: number | null; readonly matchCode?: unknown },
    nowMs: number,
  ): Ok<{ status: "approved" | "denied" }> | Refused;
  exchange(input: { readonly pairingId: string; readonly exchangeSecret: unknown; readonly verifier: unknown; readonly extensionOrigin: string }, now: Date): Promise<Ok<{ bearer: string; grantId: string; expiresAt: number }> | Refused>;
  /** The token must have been minted for exactly this extension origin (always checked; no originless path). */
  resolve(bearer: string | null, scope: GrantScope, extensionOrigin: string, now: Date): Ok<{ sessionId: string; grantId: string }> | { readonly ok: false; readonly code: "TOKEN_INVALID" | "SCOPE_DENIED" };
  list(sessionId: string, now: Date): readonly GrantView[];
  revoke(sessionId: string, grantId: string, now: Date): Promise<"revoked" | "unknown">;
}

export interface PairingDeps {
  readonly durable: DurableHost;
  /** Keyed digest secret (the session key). Never stored. */
  readonly key: Buffer;
  /** Published liveness of a website session. */
  readonly sessionLive: (sessionId: string) => boolean;
  /** Absolute expiry of a live session, for bounding grants. */
  readonly sessionExpiresAt: (sessionId: string) => Date | null;
  readonly random?: (bytes: number) => Buffer;
  /** Six decimal digits from a cryptographically secure source (leading zeros kept). Injectable for tests only. */
  readonly matchCode?: () => string;
}

/**
 * Six decimal digits, uniform over 000000–999999 from Node's cryptographically secure `randomInt` (leading zeros kept).
 * The integer source is a parameter only so tests can check the formatting.
 */
export function generateMatchCode(int: (min: number, max: number) => number = randomInt): string {
  return int(0, 1_000_000).toString().padStart(6, "0");
}

/** Keyed digest of a pairing's matching code, bound to that pairing's ID (domain-separated; never stored outside memory). */
export function pairingCodeDigest(key: Buffer, pairingId: string, code: string): string {
  return createHmac("sha256", key).update(`${CODE_LABEL}\u0000${pairingId}\u0000${code}`).digest("hex");
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const active = (grant: PersistedGrant, now: Date) => grant.revokedAt === null && now.getTime() < grant.expiresAt.getTime();

export function createPairingAuthority(deps: PairingDeps): PairingAuthority {
  const random = deps.random ?? randomBytes;
  const secret = () => random(32).toString("hex");
  const digestToken = (token: string) => createHmac("sha256", deps.key).update(`${TOKEN_LABEL}\u0000${token}`).digest("hex");
  const newCode = deps.matchCode ?? (() => generateMatchCode());
  const digestCode = (pairingId: string, code: string) => pairingCodeDigest(deps.key, pairingId, code);
  const pairings = new Map<string, Pairing>();
  let windowStartMs = Number.NEGATIVE_INFINITY;
  let starts = 0;

  const find = (pairingId: string, nowMs: number): Pairing | Refused => {
    const pairing = pairings.get(pairingId);
    if (!pairing) return { ok: false, code: "PAIRING_UNKNOWN" };
    if (nowMs >= pairing.expiresAtMs) {
      pairings.delete(pairingId);
      return { ok: false, code: "PAIRING_EXPIRED" };
    }
    return pairing;
  };
  const isRefused = (value: Pairing | Refused): value is Refused => "ok" in value;
  const secretMatches = (pairing: Pairing, presented: unknown) => typeof presented === "string" && HEX_64.test(presented) && same(sha256(presented), pairing.exchangeDigest);

  return {
    start(input, nowMs) {
      if (typeof input.challenge !== "string" || !HEX_64.test(input.challenge)) return { ok: false, code: "BAD_REQUEST" };
      if (typeof input.installationId !== "string" || !INSTALLATION_ID.test(input.installationId)) return { ok: false, code: "BAD_REQUEST" };
      if (!EXTENSION_ORIGIN.test(input.extensionOrigin)) return { ok: false, code: "BAD_REQUEST" };
      if (nowMs - windowStartMs >= 60_000) {
        windowStartMs = nowMs;
        starts = 0;
      }
      if (starts >= STARTS_PER_MINUTE) return { ok: false, code: "RATE_LIMIT" };
      starts += 1;
      for (const [id, pairing] of pairings) if (nowMs >= pairing.expiresAtMs) pairings.delete(id);
      const pairingId = secret();
      const exchangeSecret = secret();
      const matchCode = newCode();
      if (!MATCH_CODE.test(matchCode)) return { ok: false, code: "BAD_REQUEST" };
      const expiresAtMs = nowMs + PAIRING_LIFETIME_MS;
      pairings.set(pairingId, {
        pairingId,
        challenge: input.challenge,
        exchangeDigest: sha256(exchangeSecret),
        codeDigest: digestCode(pairingId, matchCode),
        codeAttempts: 0,
        extensionOrigin: input.extensionOrigin,
        installationId: input.installationId,
        expiresAtMs,
        status: "pending",
        sessionId: null,
        boundMs: null,
        polls: 0,
        lastPollMs: Number.NEGATIVE_INFINITY,
      });
      return { ok: true, value: { pairingId, exchangeSecret, matchCode, expiresAt: expiresAtMs } };
    },

    status(input, nowMs) {
      const pairing = find(input.pairingId, nowMs);
      if (isRefused(pairing)) return pairing;
      if (pairing.extensionOrigin !== input.extensionOrigin || !secretMatches(pairing, input.exchangeSecret)) return { ok: false, code: "PAIRING_UNKNOWN" };
      if (pairing.polls >= MAX_POLLS) return { ok: false, code: "POLL_LIMIT" };
      if (nowMs - pairing.lastPollMs < MIN_POLL_GAP_MS) return { ok: false, code: "POLL_TOO_SOON" };
      pairing.polls += 1;
      pairing.lastPollMs = nowMs;
      const status = pairing.status === "consumed" ? "approved" : pairing.status;
      return { ok: true, value: { status } };
    },

    approve(input, nowMs) {
      if (!deps.sessionLive(input.sessionId)) return { ok: false, code: "SESSION_INVALID" };
      const pairing = find(input.pairingId, nowMs);
      if (isRefused(pairing)) return pairing;
      if (pairing.status !== "pending") return { ok: false, code: "PAIRING_ALREADY_DECIDED" };
      if (!input.deny) {
        // The code must be the one issued for this pairing. Every failed attempt counts; the fifth ends the pairing.
        const presented = typeof input.matchCode === "string" ? input.matchCode : "";
        const matches = MATCH_CODE.test(presented) && same(digestCode(pairing.pairingId, presented), pairing.codeDigest);
        if (!matches) {
          pairing.codeAttempts += 1;
          if (pairing.codeAttempts >= MAX_CODE_ATTEMPTS) {
            pairing.status = "denied";
            return { ok: false, code: "PAIRING_CODE_LIMIT" };
          }
          return { ok: false, code: "PAIRING_CODE_MISMATCH" };
        }
        const approved = [...pairings.values()].filter((p) => p.sessionId === input.sessionId && p.status === "approved" && nowMs < p.expiresAtMs).length;
        if (approved >= MAX_APPROVED_PAIRINGS) return { ok: false, code: "PAIRING_LIMIT" };
      }
      pairing.status = input.deny ? "denied" : "approved";
      pairing.sessionId = input.sessionId;
      pairing.boundMs = input.boundMs;
      return { ok: true, value: { status: pairing.status } };
    },

    async exchange(input, now) {
      const nowMs = now.getTime();
      const pairing = find(input.pairingId, nowMs);
      if (isRefused(pairing)) return pairing;
      if (pairing.extensionOrigin !== input.extensionOrigin || !secretMatches(pairing, input.exchangeSecret)) return { ok: false, code: "PAIRING_UNKNOWN" };
      if (pairing.status !== "approved" || pairing.sessionId === null) return { ok: false, code: "PAIRING_NOT_APPROVED" };
      if (typeof input.verifier !== "string" || !HEX_64.test(input.verifier) || !same(sha256(input.verifier), pairing.challenge)) return { ok: false, code: "VERIFIER_INVALID" };
      // Consumed before the durable decision: a refused save never leaves a pairing that can be exchanged again.
      pairing.status = "consumed";
      const sessionId = pairing.sessionId;
      if (!deps.sessionLive(sessionId)) return { ok: false, code: "SESSION_INVALID" };
      const sessionExpiry = deps.sessionExpiresAt(sessionId);
      if (!sessionExpiry) return { ok: false, code: "SESSION_INVALID" };
      const bounds = [nowMs + GRANT_LIFETIME_MS, sessionExpiry.getTime(), ...(pairing.boundMs === null ? [] : [pairing.boundMs])];
      const expiresAtMs = Math.min(...bounds);
      if (expiresAtMs <= nowMs) return { ok: false, code: "SESSION_INVALID" };
      const bearer = secret();
      const grant: PersistedGrant = {
        grantId: `grt_${random(16).toString("hex")}`,
        sessionId,
        tokenDigest: digestToken(bearer),
        extensionOrigin: pairing.extensionOrigin,
        installationId: pairing.installationId,
        scopes: [...GRANT_SCOPES],
        createdAt: now,
        expiresAt: new Date(expiresAtMs),
        revokedAt: null,
      };
      const outcome = await deps.durable.decideGrants((grants) => {
        // Only usable grants are kept; revoked and expired ones are dropped from the snapshot.
        const usable = grants.filter((g) => active(g, now));
        const replaced = usable.filter((g) => g.sessionId === sessionId && g.extensionOrigin === grant.extensionOrigin && g.installationId === grant.installationId);
        const others = usable.filter((g) => !replaced.includes(g));
        if (others.filter((g) => g.sessionId === sessionId).length >= MAX_ACTIVE_GRANTS) return { value: "limit" as const };
        return { value: "minted" as const, grants: [...others, grant] };
      });
      if (outcome === "limit") return { ok: false, code: "GRANT_LIMIT" };
      return { ok: true, value: { bearer, grantId: grant.grantId, expiresAt: expiresAtMs } };
    },

    resolve(bearer, scope, extensionOrigin, now) {
      if (bearer === null || !HEX_64.test(bearer)) return { ok: false, code: "TOKEN_INVALID" };
      const digest = digestToken(bearer);
      const grant = deps.durable.readGrants().find((g) => same(g.tokenDigest, digest));
      if (!grant || !active(grant, now) || !deps.sessionLive(grant.sessionId)) return { ok: false, code: "TOKEN_INVALID" };
      // A token is bound to the extension that paired it, on every request.
      if (extensionOrigin !== grant.extensionOrigin) return { ok: false, code: "TOKEN_INVALID" };
      if (!grant.scopes.includes(scope)) return { ok: false, code: "SCOPE_DENIED" };
      return { ok: true, value: { sessionId: grant.sessionId, grantId: grant.grantId } };
    },

    list(sessionId, now) {
      return deps.durable
        .readGrants()
        .filter((g) => g.sessionId === sessionId && active(g, now))
        .map((g) => ({ grantId: g.grantId, label: g.grantId.slice(4, 12), createdAt: g.createdAt, expiresAt: g.expiresAt }));
    },

    revoke(sessionId, grantId, now) {
      return deps.durable.decideGrants((grants) => {
        const target = grants.find((g) => g.grantId === grantId && g.sessionId === sessionId && active(g, now));
        if (!target) return { value: "unknown" as const };
        return { value: "revoked" as const, grants: grants.filter((g) => g !== target && active(g, now)) };
      });
    },
  };
}
