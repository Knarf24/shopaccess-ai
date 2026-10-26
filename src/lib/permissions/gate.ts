import type { PaymentState } from "../payment/state-machine";
import type { DurableHost } from "../session/durable";
import type { PersistedPermission } from "../session/snapshot-state";
import { authorityOf, bindingKey, isLive, release, reserve, settleExpired } from "./model";

/**
 * F07 enforcement on the mock checkout and payment path (M2-3 slice 2, docs/m2-3-plan.md §5).
 *
 * Every check requires a live website session on its own; a saved permission never implies one. Checks always compare
 * the current quote (seller, product, variant, quantity, final total and currency) with the permission.
 *
 * The irreversible boundary is the capture dispatch. `beginCapture` saves `executing` before the payment orchestrator
 * claims the capture operation or calls the provider; if that save fails, it throws and no capture starts. Until then a
 * revoke wins and every later check refuses. After it, revoke cannot undo a capture that may be under way.
 */

export type PurchaseRefusal =
  | "PERMISSION_REQUIRED"
  /** Another seller, product or variant, or another currency. */
  | "PERMISSION_MISMATCH"
  | "PERMISSION_QUANTITY_EXCEEDED"
  | "PERMISSION_TOTAL_EXCEEDED"
  | "PERMISSION_EXPIRED"
  | "PERMISSION_REVOKED"
  | "PERMISSION_IN_USE"
  | "PERMISSION_UNAVAILABLE"
  /** A capture of this checkout was definitively declined: a new capture needs a fresh shopper confirmation. */
  | "CONFIRMATION_REQUIRED";

export type GateResult = { readonly ok: true } | { readonly ok: false; readonly code: PurchaseRefusal };

/** The quote fields a permission is checked against. */
export interface QuoteTerms {
  readonly merchantId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly totalCents: number;
  readonly currency: string;
  readonly chargerDraftId?: string;
  readonly chargerRevision?: number;
}

/** `display`: read-only, to show a checkout page that agrees with the saved permission (M2-3 review finding 3). */
export type CheckPhase = "confirm_prepare" | "confirm_submit" | "order_create" | "order_resend" | "display";

export interface PurchaseGate {
  /** Checkout start: the one matching live permission is reserved for `checkoutIntentId`, saved before success. */
  reserveForCheckout(sessionId: string, quote: QuoteTerms, checkoutIntentId: string, stateOf: (intentId: string) => Promise<PaymentState | null>): Promise<GateResult>;
  /** Re-check before confirmation and order creation: reserved for this checkout, live session, unexpired, matching. */
  check(sessionId: string, quote: QuoteTerms, checkoutIntentId: string, phase: CheckPhase): GateResult;
  /**
   * Final check and the saved `reserved` → `executing` step, immediately before a capture is dispatched. Throws if the
   * save fails. `declinedBefore`: this checkout already had a capture the provider definitively declined or rejected. The
   * confirmation that led to it is then spent: no further capture on this checkout (CONFIRMATION_REQUIRED). The shopper
   * cancels (which releases the permission) and confirms again in a new checkout.
   */
  beginCapture(sessionId: string, quote: QuoteTerms, checkoutIntentId: string, declinedBefore: boolean): Promise<GateResult>;
  /**
   * Reconciliation found no trace of this checkout's capture at the provider and would resend the same operation (same
   * request ID). That is a capture attempt: the permission must be `executing` or `outcome_unknown` for this checkout,
   * unexpired, matching, with a live session. It is saved as `executing` again before the resend.
   */
  beginCaptureResend(sessionId: string, quote: QuoteTerms, checkoutIntentId: string): Promise<GateResult>;
  /** Records what a capture step proved: consumed, back to reserved (provider-proven decline), or outcome unknown. */
  recordPaymentState(checkoutIntentId: string, state: PaymentState): Promise<void>;
  /** The checkout ended before any capture: a `reserved` permission returns to `active`. Never from any other state. */
  releaseCheckout(checkoutIntentId: string): Promise<void>;
}

export interface GateDeps {
  readonly durable: DurableHost;
  readonly sessionLive: (sessionId: string) => boolean;
  readonly clock: () => Date;
  readonly checkoutAllowed?: (sessionId: string, quote: QuoteTerms) => boolean;
}

/** Payment states in which a checkout can no longer reach capture without starting over. Its reservation may move. */
const RELEASABLE: ReadonlySet<PaymentState> = new Set(["DRAFT", "CANCELED_LOCAL", "EXPIRED", "SUPERSEDED", "FAILED_TERMINAL", "DECLINED_RETRYABLE"]);
const CAPTURED: ReadonlySet<PaymentState> = new Set(["CAPTURED_VERIFIED", "PARTIALLY_REFUNDED_OBSERVED", "REFUNDED_OBSERVED", "REVERSED_OR_DISPUTED_OBSERVED"]);
const UNPROVEN: ReadonlySet<PaymentState> = new Set(["CAPTURE_UNKNOWN", "RECONCILIATION_REQUIRED", "MANUAL_REVIEW"]);

const refused = (code: PurchaseRefusal): GateResult => ({ ok: false, code });
const OK: GateResult = { ok: true };

const sameBinding = (p: PersistedPermission, sessionId: string, quote: QuoteTerms) =>
  bindingKey(p) === bindingKey({ sessionId, merchantId: quote.merchantId, productId: quote.productId, variantId: quote.variantId });

/**
 * Quantity, final payable total and currency within the permission, or the refusal. A lower price is fine; a higher
 * one only up to the maximum.
 */
function boundsRefusal(p: PersistedPermission, quote: QuoteTerms): PurchaseRefusal | null {
  if (quote.currency !== p.currency) return "PERMISSION_MISMATCH";
  if (quote.quantity > p.maxQuantity) return "PERMISSION_QUANTITY_EXCEEDED";
  if (quote.totalCents > p.maxTotalCents) return "PERMISSION_TOTAL_EXCEEDED";
  return null;
}

/** The shopper-facing reason when no live permission for the binding exists. */
function absentReason(permissions: readonly PersistedPermission[], sessionId: string, quote: QuoteTerms, now: Date): PurchaseRefusal {
  const latest = permissions
    .filter((p) => sameBinding(p, sessionId, quote))
    .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())[0];
  if (!latest) return "PERMISSION_REQUIRED";
  const authority = authorityOf(latest, sessionId, now);
  if (authority.ok) return "PERMISSION_UNAVAILABLE";
  if (authority.reason === "PERMISSION_WRONG_SESSION") return "PERMISSION_REQUIRED";
  return authority.reason;
}

/** The permission held by this checkout, checked for session, authority, state and the current quote. */
function heldBy(
  permissions: readonly PersistedPermission[],
  sessionId: string,
  quote: QuoteTerms,
  checkoutIntentId: string,
  now: Date,
  states: ReadonlySet<PersistedPermission["state"]>,
  ignoreExpiry = false,
): { ok: true; permission: PersistedPermission } | { ok: false; code: PurchaseRefusal } {
  const held = permissions.filter((p) => p.checkoutIntentId === checkoutIntentId);
  // Never choose between two authorities: the saved-state invariants make this impossible, so treat it as corruption.
  if (held.length > 1) return { ok: false, code: "PERMISSION_UNAVAILABLE" };
  const permission = held[0];
  if (!permission || permission.sessionId !== sessionId) return { ok: false, code: absentReason(permissions, sessionId, quote, now) };
  if (!ignoreExpiry) {
    const authority = authorityOf(permission, sessionId, now);
    if (!authority.ok) return { ok: false, code: authority.reason === "PERMISSION_WRONG_SESSION" ? "PERMISSION_REQUIRED" : authority.reason };
  }
  if (permission.state === "revoked") return { ok: false, code: "PERMISSION_REVOKED" };
  if (!states.has(permission.state)) return { ok: false, code: "PERMISSION_UNAVAILABLE" };
  if (!sameBinding(permission, sessionId, quote)) return { ok: false, code: "PERMISSION_MISMATCH" };
  const outside = boundsRefusal(permission, quote);
  if (outside) return { ok: false, code: outside };
  return { ok: true, permission };
}

const RESERVED: ReadonlySet<PersistedPermission["state"]> = new Set(["reserved"]);
const RESENDABLE: ReadonlySet<PersistedPermission["state"]> = new Set(["executing", "outcome_unknown"]);

export function createPurchaseGate(deps: GateDeps): PurchaseGate {
  const replace = (list: readonly PersistedPermission[], next: PersistedPermission) => list.map((p) => (p.permissionId === next.permissionId ? next : p));

  return {
    async reserveForCheckout(sessionId, quote, checkoutIntentId, stateOf) {
      if (!deps.sessionLive(sessionId) || deps.checkoutAllowed?.(sessionId, quote) === false) return refused("PERMISSION_UNAVAILABLE");
      const now = deps.clock();
      // The state of a checkout that holds the permission is read first (the decision itself is synchronous) and
      // rechecked against the saved permission inside the decision: if the holder changed meanwhile, this start loses.
      const candidates = deps.durable.readPermissions().filter((p) => sameBinding(p, sessionId, quote) && isLive(p, now));
      const holder = candidates.length === 1 && candidates[0].state === "reserved" ? candidates[0] : null;
      const holderState = holder?.checkoutIntentId ? await stateOf(holder.checkoutIntentId) : null;

      return deps.durable.decidePermissions<GateResult>((saved) => {
        if (!deps.sessionLive(sessionId) || deps.checkoutAllowed?.(sessionId, quote) === false) return { value: refused("PERMISSION_UNAVAILABLE") };
        const permissions = settleExpired(saved, now);
        const live = permissions.filter((p) => sameBinding(p, sessionId, quote) && isLive(p, now));
        if (live.length > 1) return { value: refused("PERMISSION_UNAVAILABLE") };
        const permission = live[0];
        if (!permission) return { value: refused(absentReason(permissions, sessionId, quote, now)) };
        const outside = boundsRefusal(permission, quote);
        if (outside) return { value: refused(outside) };
        if (permission.state === "executing") return { value: refused("PERMISSION_IN_USE") };
        let available = permission;
        if (permission.state === "reserved") {
          const sameHolder = holder !== null && holder.permissionId === permission.permissionId && holder.checkoutIntentId === permission.checkoutIntentId && holder.changedAt.getTime() === permission.changedAt.getTime();
          // A live checkout keeps its reservation. One that ended (or no longer exists) before any capture gives it up.
          if (!sameHolder || (holderState !== null && !RELEASABLE.has(holderState))) return { value: refused("PERMISSION_IN_USE") };
          const released = release(permission, permission.checkoutIntentId!, now);
          if (!released.ok) return { value: refused("PERMISSION_IN_USE") };
          available = released.permission;
        }
        const reserved = reserve(available, sessionId, checkoutIntentId, now);
        if (!reserved.ok) return { value: refused(reserved.reason === "PERMISSION_IN_USE" ? "PERMISSION_IN_USE" : "PERMISSION_UNAVAILABLE") };
        return { value: OK, permissions: replace(permissions, reserved.permission) };
      });
    },

    check(sessionId, quote, checkoutIntentId) {
      if (!deps.sessionLive(sessionId) || deps.checkoutAllowed?.(sessionId, quote) === false) return refused("PERMISSION_UNAVAILABLE");
      const result = heldBy(deps.durable.readPermissions(), sessionId, quote, checkoutIntentId, deps.clock(), RESERVED);
      return result.ok ? OK : refused(result.code);
    },

    async beginCapture(sessionId, quote, checkoutIntentId, declinedBefore) {
      if (!deps.sessionLive(sessionId) || deps.checkoutAllowed?.(sessionId, quote) === false) return refused("PERMISSION_UNAVAILABLE");
      const now = deps.clock();
      return deps.durable.decidePermissions<GateResult>((saved) => {
        // Rechecked inside the decision, so a revoke or logout saved just before this cannot be overtaken.
        if (!deps.sessionLive(sessionId) || deps.checkoutAllowed?.(sessionId, quote) === false) return { value: refused("PERMISSION_UNAVAILABLE") };
        const held = heldBy(saved, sessionId, quote, checkoutIntentId, now, RESERVED);
        if (!held.ok) return { value: refused(held.code) };
        if (declinedBefore) return { value: refused("CONFIRMATION_REQUIRED") };
        return { value: OK, permissions: replace(saved, { ...held.permission, state: "executing", changedAt: now }) };
      });
    },

    async beginCaptureResend(sessionId, quote, checkoutIntentId) {
      if (!deps.sessionLive(sessionId) || deps.checkoutAllowed?.(sessionId, quote) === false) return refused("PERMISSION_UNAVAILABLE");
      const now = deps.clock();
      return deps.durable.decidePermissions<GateResult>((saved) => {
        if (!deps.sessionLive(sessionId) || deps.checkoutAllowed?.(sessionId, quote) === false) return { value: refused("PERMISSION_UNAVAILABLE") };
        // `executing` and `outcome_unknown` carry no authority of their own, so expiry is checked here explicitly.
        const held = heldBy(saved, sessionId, quote, checkoutIntentId, now, RESENDABLE, true);
        if (!held.ok) return { value: refused(held.code) };
        if (now.getTime() >= held.permission.expiresAt.getTime()) return { value: refused("PERMISSION_EXPIRED") };
        return { value: OK, permissions: replace(saved, { ...held.permission, state: "executing", changedAt: now }) };
      });
    },

    async recordPaymentState(checkoutIntentId, state) {
      const now = deps.clock();
      await deps.durable.decidePermissions((saved) => {
        const permission = saved.find((p) => p.checkoutIntentId === checkoutIntentId && (p.state === "executing" || p.state === "outcome_unknown"));
        if (!permission) return { value: null };
        let next: PersistedPermission["state"] | null = null;
        if (CAPTURED.has(state)) next = "consumed";
        // Provider-proven: no capture. Still bound to this checkout, which cannot capture again without a new confirmation.
        else if (state === "DECLINED_RETRYABLE" && permission.state === "executing") next = "reserved";
        else if (UNPROVEN.has(state)) next = "outcome_unknown";
        if (next === null || next === permission.state) return { value: null };
        return { value: null, permissions: replace(saved, { ...permission, state: next, changedAt: now }) };
      });
    },

    async releaseCheckout(checkoutIntentId) {
      const now = deps.clock();
      await deps.durable.decidePermissions((saved) => {
        const permission = saved.find((p) => p.checkoutIntentId === checkoutIntentId && p.state === "reserved");
        if (!permission) return { value: null };
        const released = release(permission, checkoutIntentId, now);
        return released.ok ? { value: null, permissions: replace(saved, released.permission) } : { value: null };
      });
    },
  };
}
