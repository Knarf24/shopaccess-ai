import type { MerchantCatalog } from "@/lib/catalog/schemas";
import type { DurableHost } from "@/lib/session/durable";
import type { PermissionState, PersistedPermission } from "@/lib/session/snapshot-state";
import { decideCreate, decideRevoke, isLive, type CreateInput, type PermissionRefusal } from "./model";

/**
 * F07 purchase permissions on the save-first gate (M2-3, docs/m2-3-plan.md §3). Website only: every method takes the
 * website session that the caller already authenticated (cookie, CSRF, admission). Nothing here is reachable from the
 * extension API. Use by the checkout and payment paths is added in slice 2.
 */
export interface PermissionView {
  readonly permissionId: string;
  readonly label: string;
  readonly merchantId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly maxQuantity: number;
  readonly maxTotalCents: number;
  readonly currency: "USD";
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** As shown: an `active` or `reserved` permission past its expiry shows as `expired`. */
  readonly state: PermissionState;
  readonly live: boolean;
}

export interface PermissionAuthority {
  create(input: Omit<CreateInput, "sessionId"> & { readonly sessionId: string; readonly admissionExpiresAtMs: number | null }, now: Date): Promise<{ ok: true; value: PermissionView } | { ok: false; code: PermissionRefusal }>;
  list(sessionId: string, now: Date): readonly PermissionView[];
  revoke(sessionId: string, permissionId: string, now: Date): Promise<"revoked" | "in_progress" | "unknown">;
}

export interface PermissionDeps {
  readonly durable: DurableHost;
  readonly catalog: MerchantCatalog;
  readonly sessionLive: (sessionId: string) => boolean;
  /** Absolute expiry of a live session, or null. */
  readonly sessionExpiresAt: (sessionId: string) => Date | null;
  readonly random?: () => string;
}

export function viewOf(p: PersistedPermission, now: Date): PermissionView {
  const live = isLive(p, now);
  const lapsed = (p.state === "active" || p.state === "reserved") && !live;
  return {
    permissionId: p.permissionId,
    label: p.permissionId.slice(4, 12),
    merchantId: p.merchantId,
    productId: p.productId,
    variantId: p.variantId,
    maxQuantity: p.maxQuantity,
    maxTotalCents: p.maxTotalCents,
    currency: p.currency,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    state: lapsed ? "expired" : p.state,
    live,
  };
}

export function createPermissionAuthority(deps: PermissionDeps): PermissionAuthority {
  return {
    async create(input, now) {
      if (!deps.sessionLive(input.sessionId)) return { ok: false, code: "SESSION_INVALID" };
      const sessionExpiresAtMs = deps.sessionExpiresAt(input.sessionId)?.getTime() ?? null;
      const outcome = await deps.durable.decidePermissions<ReturnType<typeof decideCreate>>((existing) => {
        const decided = decideCreate(existing, input, { catalog: deps.catalog, now, sessionExpiresAtMs, admissionExpiresAtMs: input.admissionExpiresAtMs, random: deps.random });
        return decided.ok ? { value: decided, permissions: decided.permissions } : { value: decided };
      });
      return outcome.ok ? { ok: true, value: viewOf(outcome.permission, now) } : { ok: false, code: outcome.code };
    },
    list(sessionId, now) {
      return deps.durable
        .readPermissions()
        .filter((p) => p.sessionId === sessionId)
        .map((p) => viewOf(p, now));
    },
    revoke(sessionId, permissionId, now) {
      return deps.durable.decidePermissions<"revoked" | "in_progress" | "unknown">((existing) => {
        const decided = decideRevoke(existing, sessionId, permissionId, now);
        return decided.result === "revoked" ? { value: "revoked" as const, permissions: decided.permissions } : { value: decided.result };
      });
    },
  };
}
