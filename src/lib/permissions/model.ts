import { findMerchantVariant } from "@/lib/catalog/merchant-catalog";
import { MAX_QUANTITY_LIMIT, type MerchantCatalog } from "@/lib/catalog/schemas";
import { randomHex } from "@/lib/shared/crypto";
import type { PermissionState, PersistedPermission } from "@/lib/session/snapshot-state";

/**
 * F07 purchase permissions (M2-3, docs/m2-3-plan.md §3). Pure rules only: no I/O, no clock, no persistence. The
 * authority (`authority.ts`) runs these inside the save-first gate.
 *
 * A permission binds one exact seller + product + variant, a maximum quantity, a maximum final payable total in USD and
 * a concrete expiry. It is single use. Only the website session that created it can ever use or revoke it.
 */

export const PERMISSION_ID = /^prm_[0-9a-f]{32}$/;
export const MAX_LIVE_PERMISSIONS_PER_SESSION = 5;
/** The snapshot's per-unit amount cap times the catalog's quantity cap. */
export const MAX_PERMISSION_TOTAL_CENTS = 2_000_000 * MAX_QUANTITY_LIMIT;
export const MAX_PERMISSION_LIFETIME_MS = 86_400_000;
export const EXPIRY_CHOICES = { "15m": 15 * 60_000, "1h": 60 * 60_000, session: null } as const;
export type ExpiryChoice = keyof typeof EXPIRY_CHOICES;

export type PermissionRefusal =
  | "BAD_REQUEST"
  | "NOT_IN_CATALOG"
  | "QUANTITY_INVALID"
  | "TOTAL_INVALID"
  | "SESSION_INVALID"
  | "PERMISSION_DUPLICATE"
  | "PERMISSION_LIMIT";

/** Why a permission gives no authority right now. */
export type NoAuthority = "PERMISSION_REVOKED" | "PERMISSION_EXPIRED" | "PERMISSION_UNAVAILABLE" | "PERMISSION_WRONG_SESSION";

const FINAL: ReadonlySet<PermissionState> = new Set(["consumed", "revoked", "expired", "outcome_unknown"]);

export const bindingKey = (p: Pick<PersistedPermission, "sessionId" | "merchantId" | "productId" | "variantId">) =>
  `${p.sessionId}\u0000${p.merchantId}\u0000${p.productId}\u0000${p.variantId}`;

/**
 * Live: carries or is exercising authority. `active` and `reserved` stop being live at expiry; `executing` (a capture
 * already sent) stays live until its outcome is recorded, so a second authority for the binding cannot appear meanwhile.
 */
export function isLive(p: PersistedPermission, now: Date): boolean {
  if (p.state === "executing") return true;
  return (p.state === "active" || p.state === "reserved") && now.getTime() < p.expiresAt.getTime();
}

/**
 * Whether `p` can authorize anything for `sessionId` at `now`. Callers in later slices add the phase rules (which state
 * and which checkout). Revoked, consumed, expired and outcome-unknown permissions never authorize anything.
 */
export function authorityOf(p: PersistedPermission, sessionId: string, now: Date): { ok: true } | { ok: false; reason: NoAuthority } {
  if (p.sessionId !== sessionId) return { ok: false, reason: "PERMISSION_WRONG_SESSION" };
  if (p.state === "revoked") return { ok: false, reason: "PERMISSION_REVOKED" };
  if (p.state === "expired") return { ok: false, reason: "PERMISSION_EXPIRED" };
  if (p.state === "consumed" || p.state === "outcome_unknown") return { ok: false, reason: "PERMISSION_UNAVAILABLE" };
  if (p.state !== "executing" && now.getTime() >= p.expiresAt.getTime()) return { ok: false, reason: "PERMISSION_EXPIRED" };
  return { ok: true };
}

/** Records lapsed authority: `active` or `reserved` past expiry becomes `expired` (as of its expiry). Others unchanged. */
export function settleExpired(permissions: readonly PersistedPermission[], now: Date): PersistedPermission[] {
  return permissions.map((p) =>
    (p.state === "active" || p.state === "reserved") && now.getTime() >= p.expiresAt.getTime()
      ? { ...p, state: "expired", checkoutIntentId: null, changedAt: p.expiresAt }
      : p,
  );
}

/**
 * The concrete expiry for a new permission: the earliest of the shopper's choice, the session's absolute expiry and the
 * admission cookie's expiry (admission on). "Until this session ends" resolves here to that earliest deadline.
 */
export function resolveExpiry(choice: ExpiryChoice, nowMs: number, sessionExpiresAtMs: number, admissionExpiresAtMs: number | null): number {
  const duration = EXPIRY_CHOICES[choice];
  const bounds = [sessionExpiresAtMs, nowMs + MAX_PERMISSION_LIFETIME_MS, ...(duration === null ? [] : [nowMs + duration]), ...(admissionExpiresAtMs === null ? [] : [admissionExpiresAtMs])];
  return Math.min(...bounds);
}

export interface CreateInput {
  readonly sessionId: string;
  readonly merchantId: unknown;
  readonly productId: unknown;
  readonly variantId: unknown;
  readonly maxQuantity: unknown;
  readonly maxTotalCents: unknown;
  readonly expiry: unknown;
}

export interface CreateContext {
  readonly catalog: MerchantCatalog;
  readonly now: Date;
  /** Absolute expiry of the live session, or null when the session is not live. */
  readonly sessionExpiresAtMs: number | null;
  /** Admission cookie expiry when admission is on, else null. */
  readonly admissionExpiresAtMs: number | null;
  readonly random?: () => string;
}

/** Validates a create request against the catalog and the session's live permissions. Returns the next list or a refusal. */
export function decideCreate(
  existing: readonly PersistedPermission[],
  input: CreateInput,
  context: CreateContext,
): { ok: true; permission: PersistedPermission; permissions: PersistedPermission[] } | { ok: false; code: PermissionRefusal } {
  const { merchantId, productId, variantId, maxQuantity, maxTotalCents, expiry } = input;
  if (typeof merchantId !== "string" || typeof productId !== "string" || typeof variantId !== "string") return { ok: false, code: "BAD_REQUEST" };
  // Own keys only: "__proto__", "toString" and other inherited names are not expiry choices.
  if (typeof expiry !== "string" || !Object.hasOwn(EXPIRY_CHOICES, expiry)) return { ok: false, code: "BAD_REQUEST" };
  if (merchantId !== context.catalog.merchant.merchantId) return { ok: false, code: "NOT_IN_CATALOG" };
  const entry = findMerchantVariant(context.catalog, productId, variantId);
  if (!entry) return { ok: false, code: "NOT_IN_CATALOG" };
  if (typeof maxQuantity !== "number" || !Number.isInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > Math.min(entry.variant.maxQuantityPerOrder, MAX_QUANTITY_LIMIT)) {
    return { ok: false, code: "QUANTITY_INVALID" };
  }
  if (typeof maxTotalCents !== "number" || !Number.isSafeInteger(maxTotalCents) || maxTotalCents < 1 || maxTotalCents > MAX_PERMISSION_TOTAL_CENTS) {
    return { ok: false, code: "TOTAL_INVALID" };
  }
  const nowMs = context.now.getTime();
  if (context.sessionExpiresAtMs === null) return { ok: false, code: "SESSION_INVALID" };
  const expiresAtMs = resolveExpiry(expiry as ExpiryChoice, nowMs, context.sessionExpiresAtMs, context.admissionExpiresAtMs);
  // Fail closed on any non-concrete expiry, as well as on one that has already passed.
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return { ok: false, code: "SESSION_INVALID" };

  const settled = settleExpired(existing, context.now);
  const live = settled.filter((p) => p.sessionId === input.sessionId && isLive(p, context.now));
  const permission: PersistedPermission = {
    permissionId: `prm_${(context.random ?? (() => randomHex(16)))()}`,
    sessionId: input.sessionId,
    merchantId,
    productId,
    variantId,
    maxQuantity,
    maxTotalCents,
    currency: "USD",
    createdAt: context.now,
    expiresAt: new Date(expiresAtMs),
    state: "active",
    checkoutIntentId: null,
    changedAt: context.now,
  };
  if (live.some((p) => bindingKey(p) === bindingKey(permission))) return { ok: false, code: "PERMISSION_DUPLICATE" };
  if (live.length >= MAX_LIVE_PERMISSIONS_PER_SESSION) return { ok: false, code: "PERMISSION_LIMIT" };
  if (settled.some((p) => p.permissionId === permission.permissionId)) return { ok: false, code: "BAD_REQUEST" };
  return { ok: true, permission, permissions: [...settled, permission] };
}

/** Shopper revoke: `active` or `reserved` of this session becomes `revoked`. A capture in progress cannot be revoked. */
export function decideRevoke(
  existing: readonly PersistedPermission[],
  sessionId: string,
  permissionId: string,
  now: Date,
): { result: "revoked"; permissions: PersistedPermission[] } | { result: "in_progress" | "unknown" } {
  const settled = settleExpired(existing, now);
  const target = settled.find((p) => p.permissionId === permissionId && p.sessionId === sessionId);
  if (!target || FINAL.has(target.state)) return { result: "unknown" };
  if (target.state === "executing") return { result: "in_progress" };
  return { result: "revoked", permissions: settled.map((p) => (p === target ? { ...p, state: "revoked", checkoutIntentId: null, changedAt: now } : p)) };
}

/** Logout: every `active` or `reserved` permission of the session is revoked in the same decision. `executing` is kept. */
export function revokeSessionPermissions(existing: readonly PersistedPermission[], sessionId: string, at: Date): PersistedPermission[] {
  return existing.map((p) =>
    p.sessionId === sessionId && (p.state === "active" || p.state === "reserved")
      ? { ...p, state: "revoked", checkoutIntentId: null, changedAt: new Date(Math.max(at.getTime(), p.createdAt.getTime())) }
      : p,
  );
}

/**
 * After a restart. Checkouts are memory-only, so no reservation can still be in use: `reserved` returns to `active`.
 * A capture that may have been sent cannot be proven either way: `executing` becomes `outcome_unknown`, never `active`.
 * Lapsed `active`/`reserved` become `expired`.
 */
export function restorePermissions(saved: readonly PersistedPermission[], now: Date): PersistedPermission[] {
  return settleExpired(saved, now).map((p) => {
    if (p.state === "reserved") return { ...p, state: "active", checkoutIntentId: null, changedAt: now };
    if (p.state === "executing") return { ...p, state: "outcome_unknown", changedAt: now };
    return p;
  });
}

// --- Transitions used by the checkout and payment paths (wired in slice 2) --------------------------------------------

type Transition = { ok: true; permission: PersistedPermission } | { ok: false; reason: NoAuthority | "PERMISSION_IN_USE" | "PERMISSION_STATE" };

/** `active` → `reserved` for one checkout. */
export function reserve(p: PersistedPermission, sessionId: string, checkoutIntentId: string, now: Date): Transition {
  const authority = authorityOf(p, sessionId, now);
  if (!authority.ok) return authority;
  if (p.state !== "active") return { ok: false, reason: p.checkoutIntentId === checkoutIntentId ? "PERMISSION_STATE" : "PERMISSION_IN_USE" };
  return { ok: true, permission: { ...p, state: "reserved", checkoutIntentId, changedAt: now } };
}

/** `reserved` for this checkout → `executing`, immediately before a capture is sent. */
export function beginExecution(p: PersistedPermission, sessionId: string, checkoutIntentId: string, now: Date): Transition {
  const authority = authorityOf(p, sessionId, now);
  if (!authority.ok) return authority;
  if (p.checkoutIntentId !== checkoutIntentId) return { ok: false, reason: "PERMISSION_IN_USE" };
  if (p.state !== "reserved") return { ok: false, reason: "PERMISSION_STATE" };
  return { ok: true, permission: { ...p, state: "executing", changedAt: now } };
}

/** `executing` → `consumed` (verified capture) or `outcome_unknown` (cannot be proven). */
export function settleExecution(p: PersistedPermission, checkoutIntentId: string, outcome: "captured" | "unknown", now: Date): Transition {
  if (p.state !== "executing" || p.checkoutIntentId !== checkoutIntentId) return { ok: false, reason: "PERMISSION_STATE" };
  return { ok: true, permission: { ...p, state: outcome === "captured" ? "consumed" : "outcome_unknown", changedAt: now } };
}

/** `reserved` → `active` when the checkout ended before any capture was prepared (known safe). Never from `executing`. */
export function release(p: PersistedPermission, checkoutIntentId: string, now: Date): Transition {
  if (p.state !== "reserved" || p.checkoutIntentId !== checkoutIntentId) return { ok: false, reason: "PERMISSION_STATE" };
  return { ok: true, permission: { ...p, state: now.getTime() >= p.expiresAt.getTime() ? "expired" : "active", checkoutIntentId: null, changedAt: now } };
}
