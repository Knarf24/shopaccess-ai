import { headers } from "next/headers";
import { laptopProducts, type MerchantCatalog } from "@/lib/catalog/schemas";
import type { ConfirmationChallenge } from "@/lib/confirmation/confirmation";
import { UnexpectedRowError, type CheckoutRead, type EffectiveStatus, type OwnerCheckout, type StoredState } from "@/lib/pg/checkout-service";
import { explainAssessmentSafely, suggestProductsSafely } from "@/lib/providers/ai";
import {
  assessAiHardwareEvidence,
  evidenceFromAiLaptopVariant,
} from "@/lib/readiness/ai-hardware";
import { assessReadiness, evidenceFromMerchantVariant, type EvidenceItem } from "@/lib/readiness/engine";
import { ID_PATTERNS } from "@/lib/shared/ids";
import { resolvePgSession, type PgRequestContext, type PgSessionState } from "./pg-request-guard";
import type { PgServices } from "./pg-runtime";
import { USE_LABELS, type AssessedVariant, type ShopperPreferences, type ShoppingView } from "./shopping";

/**
 * What the pages of PostgreSQL mode show (specification 19.19, Increment 2.3). NEVER RUN AGAINST A DATABASE.
 *
 * Building a page sends `authorize_session`, which may record the session's activity as Increment 1 defines, and
 * read-only statements. It never starts, replaces, cancels or confirms a checkout, never issues a challenge, never
 * rotates a session and never admits one.
 *
 * A challenge is shown only when the database calls it usable and this process derives its nonce again from the
 * returned values and that nonce hashes to the stored digest. Nothing about a checkout is kept in memory, so the
 * same is shown after a restart and in a second tab.
 */

/** A page's data, or why there is none. `UNAVAILABLE` never carries anything of the row or the error. */
export type PgPage<T> = { readonly kind: "OK"; readonly value: T } | { readonly kind: "NOT_FOUND" } | { readonly kind: "UNAVAILABLE" };

function unavailable(label: string, error: unknown): { readonly kind: "UNAVAILABLE" } {
  // The field of an unexpected row, or nothing. Never a value or a message.
  console.error(`shopaccess: ${label} ${error instanceof UnexpectedRowError ? `row:${error.field}` : "error"}`);
  return { kind: "UNAVAILABLE" };
}

/** The Cookie header of the request being rendered. */
export async function pgCookieHeader(): Promise<string | null> {
  return (await headers()).get("cookie");
}

/** The session of the request being rendered, or `UNAVAILABLE` when the database could not be asked. */
export async function resolvePgPageSession(services: PgServices, cookieHeader: string | null): Promise<PgSessionState | "UNAVAILABLE"> {
  try {
    return await resolvePgSession(cookieHeader, services.sessions);
  } catch (error) {
    unavailable("page-session", error);
    return "UNAVAILABLE";
  }
}

/** The catalog as the database holds it now, or null. Never the fixture catalog. */
export async function loadPgCatalog(services: PgServices): Promise<MerchantCatalog | null> {
  try {
    const catalog = await services.catalog();
    if (catalog.ok) return catalog.value;
    console.error(`shopaccess: catalog ${catalog.error}`);
    return null;
  } catch (error) {
    unavailable("catalog", error);
    return null;
  }
}

const STATUS_ORDER = { READY: 0, READY_WITH_CAVEATS: 1, INSUFFICIENT_EVIDENCE: 2, NOT_RECOMMENDED: 3 } as const;

/**
 * The recommendations page on the database's catalog. The assessment, the advisory explanation and the external
 * listings are produced exactly as in the mock, from the same local modules; only the catalog differs. None of it
 * is sent to the database.
 */
export async function buildPgShoppingView(services: PgServices, preferences: ShopperPreferences): Promise<PgPage<ShoppingView>> {
  const catalog = await loadPgCatalog(services);
  if (!catalog) return { kind: "UNAVAILABLE" };

  const now = services.clock();
  const stated = (fact: "budgetCents" | "intendedUse", value: number | string): EvidenceItem => ({
    fact,
    value,
    source: "shopper_stated",
    sourceRef: "entered by the shopper on this page",
    observedAt: now.toISOString(),
  });

  const variants: AssessedVariant[] = [];
  for (const product of laptopProducts(catalog)) {
    for (const variant of product.variants) {
      const result = assessReadiness(
        {
          subject: { productId: product.productId, variantId: variant.variantId, catalogRevision: catalog.revision },
          evidence: [stated("budgetCents", preferences.budgetCents), stated("intendedUse", preferences.use), ...evidenceFromMerchantVariant(variant, catalog.revision, now)],
        },
        now,
      );
      if (!result.ok) continue;
      const explained = await explainAssessmentSafely(services.ai, result.value, "Explain this assessment in plain language.");
      variants.push({
        product,
        variant,
        assessment: result.value,
        aiHardware: assessAiHardwareEvidence(
          "unspecified_ai",
          evidenceFromAiLaptopVariant(variant, catalog.revision, now),
          now,
        ),
        explanation: explained.ok ? explained.value : null,
        quotable: variant.availability === "IN_STOCK",
      });
    }
  }
  variants.sort((a, b) => STATUS_ORDER[a.assessment.status] - STATUS_ORDER[b.assessment.status] || a.variant.unitAmountCents - b.variant.unitAmountCents);

  const suggestion = await suggestProductsSafely(services.ai, catalog, `Laptop for ${USE_LABELS[preferences.use]}`);
  const discovered = await services.discovery.search("");
  return {
    kind: "OK",
    value: {
      preferences,
      assistantMessage: suggestion.ok ? suggestion.value.message : null,
      merchantName: catalog.merchant.displayName,
      variants,
      external: discovered.products,
    },
  };
}

/** What a new quote for the same item needs. Taken from the authorized read, never from the browser. */
export interface PgQuoteRequest {
  readonly productId: string;
  readonly variantId: string;
  readonly quantity: number;
}

/** The actions a checkout page offers. Each is a guarded POST; the database decides again when it is sent. */
export interface PgCheckoutActions {
  /** "Review again": ask for a challenge of this checkout. */
  readonly review: boolean;
  readonly cancel: boolean;
  /** A new quote that replaces this checkout: only from QUOTED or USER_CONFIRMED. */
  readonly replace: PgQuoteRequest | null;
  /** A new checkout with no predecessor: for a checkout that can be neither confirmed nor replaced. */
  readonly startAnother: PgQuoteRequest | null;
  /** The checkout that replaced this one. */
  readonly successorIntentId: string | null;
}

/**
 * Which actions a checkout offers, from its stored state alone and from whether a challenge is being shown.
 *  - QUOTED with a challenge shown: confirm (the form), cancel.
 *  - QUOTED, quote live and unchanged, no challenge shown: review again, cancel.
 *  - QUOTED, quote expired or stale: a replacing quote, cancel.
 *  - USER_CONFIRMED: cancel, a replacing quote.
 *  - CANCELED_LOCAL or EXPIRED: start another, with no predecessor. The record stays as it is.
 *  - SUPERSEDED: a link to the checkout that replaced it.
 */
export function pgCheckoutActions(checkout: CheckoutRead, challengeShown: boolean): PgCheckoutActions {
  const item: PgQuoteRequest = { productId: checkout.productId, variantId: checkout.variantId, quantity: checkout.quantity };
  const none: PgCheckoutActions = { review: false, cancel: false, replace: null, startAnother: null, successorIntentId: null };
  switch (checkout.storedState) {
    case "QUOTED": {
      if (challengeShown) return { ...none, cancel: true };
      const quoteEnded = checkout.effectiveStatus === "QUOTE_EXPIRED" || checkout.quoteStale;
      return quoteEnded ? { ...none, cancel: true, replace: item } : { ...none, cancel: true, review: true };
    }
    case "USER_CONFIRMED":
      return { ...none, cancel: true, replace: item };
    case "CANCELED_LOCAL":
    case "EXPIRED":
      return { ...none, startAnother: item };
    case "SUPERSEDED":
      return { ...none, successorIntentId: checkout.supersededByIntentId };
  }
}

export interface PgCheckoutView {
  readonly intentId: string;
  readonly storedState: StoredState;
  readonly effectiveStatus: EffectiveStatus;
  readonly quoteStale: boolean;
  readonly merchantName: string;
  readonly itemTitle: string;
  readonly quantity: number;
  readonly totalCents: number;
  readonly currency: "USD";
  readonly quoteExpiresAt: string;
  /** Present only when the database calls the challenge usable and its nonce was derived again and checked. */
  readonly challenge: ConfirmationChallenge | null;
  readonly actions: PgCheckoutActions;
}

/** One checkout of the session's owner, for display. A checkout of another owner is "not found", like a missing one. */
export async function buildPgCheckoutView(services: PgServices, context: PgRequestContext, intentId: string): Promise<PgPage<PgCheckoutView>> {
  if (!ID_PATTERNS.checkoutIntent.test(intentId)) return { kind: "NOT_FOUND" };
  let checkout: CheckoutRead;
  try {
    const read = await services.checkout.read(context.credential, intentId);
    if (!read.authorized) return { kind: "NOT_FOUND" };
    checkout = read.checkout;
  } catch (error) {
    return unavailable("checkout-read", error);
  }

  let challenge: ConfirmationChallenge | null = null;
  const nonce = services.checkout.displayNonce(checkout);
  if (nonce !== null && checkout.challenge) {
    challenge = {
      confirmationId: checkout.challenge.id,
      nonce,
      quoteId: checkout.quoteId,
      quoteDigest: checkout.challenge.quoteDigest,
      summary: checkout.challenge.summary,
      expiresAt: checkout.challenge.expiresAt.toISOString(),
    };
  }

  return {
    kind: "OK",
    value: {
      intentId: checkout.intentId,
      storedState: checkout.storedState,
      effectiveStatus: checkout.effectiveStatus,
      quoteStale: checkout.quoteStale,
      merchantName: checkout.merchantDisplayName,
      itemTitle: `${checkout.productTitle} — ${checkout.variantLabel}`,
      quantity: checkout.quantity,
      totalCents: checkout.totalCents,
      currency: checkout.currency,
      quoteExpiresAt: checkout.quoteExpiresAt.toISOString(),
      challenge,
      actions: pgCheckoutActions(checkout, challenge !== null),
    },
  };
}

export interface PgCheckoutListItem {
  readonly intentId: string;
  readonly effectiveStatus: EffectiveStatus;
  readonly createdAt: string;
  readonly quoteExpiresAt: string;
}

/**
 * The owner's checkouts, in the order the database returns them. Best-effort recovery only: a checkout that is
 * listed can be opened again; a checkout that is not listed has not thereby been shown not to exist.
 */
export async function buildPgCheckoutList(services: PgServices, context: PgRequestContext): Promise<PgPage<readonly PgCheckoutListItem[]>> {
  let rows: readonly OwnerCheckout[];
  try {
    rows = await services.checkout.list(context.credential);
  } catch (error) {
    return unavailable("checkout-list", error);
  }
  return {
    kind: "OK",
    value: rows.map((row) => ({
      intentId: row.intentId,
      effectiveStatus: row.effectiveStatus,
      createdAt: row.createdAt.toISOString(),
      quoteExpiresAt: row.quoteExpiresAt.toISOString(),
    })),
  };
}

/** Shopper-facing words for a checkout's status. */
export const PG_STATUS_LABELS: Record<EffectiveStatus, string> = {
  QUOTED: "Waiting for your confirmation",
  USER_CONFIRMED: "Confirmed by you",
  CANCELED_LOCAL: "Canceled",
  SUPERSEDED: "Replaced by a newer quote",
  EXPIRED: "Expired",
  QUOTE_EXPIRED: "Quote expired",
};
