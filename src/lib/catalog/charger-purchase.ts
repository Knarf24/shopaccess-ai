import { DEMO_MERCHANT_CATALOG, findMerchantVariant } from "./merchant-catalog";
import { MerchantCatalogSchema, type MerchantCatalog } from "./schemas";
import type { ChargerTrack } from "../session/charger-clarification";
export const CHARGER_PRODUCT_ID = "dmp_apple70wadapter";
export const CHARGER_VARIANT_ID = "dmv_apple70wadapter";
/** Dated Apple capture: October 25 2026, MXN53AM/A, A2743, USD59. Simulated inventory and fulfillment. */
export const CHARGER_CATALOG = MerchantCatalogSchema.parse({ ...DEMO_MERCHANT_CATALOG, revision: 3, products: [...DEMO_MERCHANT_CATALOG.products, {
  productId: CHARGER_PRODUCT_ID, title: "Apple 70W USB-C Power Adapter", description: "A2743 · MXN53AM/A. Adapter only. Cable sold separately. Fixed demo price from October 25, 2026. Apple is not a ShopAccess partner.", imagePath: "/catalog/apple-70w-adapter.svg", variants: [{ variantId: CHARGER_VARIANT_ID, label: "A2743 · adapter only", unitAmountCents: 5900, currency: "USD", maxQuantityPerOrder: 1, availability: "IN_STOCK", kind: "charger_adapter", specs: { evidenceChargerId: "A2743" } }]
}] });
export interface ChargerPurchaseTerms { productId: string; variantId: string; quantity: number; totalCents: number; currency: string; chargerDraftId?: string; chargerRevision?: number }
export function isDemoCharger(catalog: MerchantCatalog, productId: string, variantId: string): boolean {
  const entry = findMerchantVariant(catalog, productId, variantId);
  return catalog.revision === 3 && catalog.merchant.merchantId === DEMO_MERCHANT_CATALOG.merchant.merchantId && productId === CHARGER_PRODUCT_ID && variantId === CHARGER_VARIANT_ID && entry?.variant.kind === "charger_adapter" && entry.variant.specs.evidenceChargerId === "A2743" && entry.variant.unitAmountCents === 5900 && entry.variant.currency === "USD" && entry.variant.availability === "IN_STOCK" && entry.variant.maxQuantityPerOrder === 1;
}
export function chargerPurchaseAllowed(catalog: MerchantCatalog, sessionId: string, track: ChargerTrack | null, terms: ChargerPurchaseTerms): boolean {
  return isDemoCharger(catalog, terms.productId, terms.variantId) && track?.sessionId === sessionId && track.state === "confirmed" && track.deviceId === "Mac14,2" && track.draftId === terms.chargerDraftId && track.revision === terms.chargerRevision && terms.quantity === 1 && terms.totalCents === 5900 && terms.currency === "USD" && Number.isSafeInteger(track.budget?.confirmedCents) && track.budget!.confirmedCents! >= terms.totalCents && track.budget!.confirmedCents === track.budget!.proposedCents;
}
