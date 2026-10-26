import { CHARGER_PRODUCT_ID, CHARGER_VARIANT_ID, chargerPurchaseAllowed } from "@/lib/catalog/charger-purchase";
import { chargerTrackFor } from "@/lib/session/charger-clarification";
import { needsDraftsFor } from "@/lib/session/store";
import type { Runtime } from "./runtime";
/** Read only: budgets are never inferred from laptop preferences or URL parameters. */
export function eligibleChargerTrack(runtime: Runtime, sessionId: string) {
  if (!runtime.chargerBudgetEnabled || runtime.paymentMode !== "mock") return null;
  const draft = needsDraftsFor(runtime.store).get(sessionId);
  const track = draft && draft.expiresAtMs > runtime.clock().getTime() ? chargerTrackFor(runtime.store, sessionId, draft.draftId) : null;
  return track && chargerPurchaseAllowed(runtime.catalog, sessionId, track, { productId: CHARGER_PRODUCT_ID, variantId: CHARGER_VARIANT_ID, quantity: 1, totalCents: 5900, currency: "USD", chargerDraftId: track.draftId, chargerRevision: track.revision }) ? track : null;
}
