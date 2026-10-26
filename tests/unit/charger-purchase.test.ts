import { describe, expect, it } from "vitest";
import { chargerPurchaseAllowed, CHARGER_CATALOG, CHARGER_PRODUCT_ID, CHARGER_VARIANT_ID } from "@/lib/catalog/charger-purchase";
import type { ChargerTrack } from "@/lib/session/charger-clarification";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
const track: ChargerTrack = { sessionId: "s", draftId: "d", state: "confirmed", deviceId: "Mac14,2", revision: 4, budget: { proposedCents: 5900, confirmedCents: 5900 } };
const terms = { productId: CHARGER_PRODUCT_ID, variantId: CHARGER_VARIANT_ID, quantity: 1, totalCents: 5900, currency: "USD", chargerDraftId: "d", chargerRevision: 4 };
describe("charger purchase policy", () => {
  it("allows only the confirmed current adapter within budget", () => expect(chargerPurchaseAllowed(CHARGER_CATALOG, "s", track, terms)).toBe(true));
  it.each([null, { ...track, state: "candidate" }, { ...track, deviceId: "MacBookPro12,1" }, { ...track, sessionId: "other" }, { ...track, draftId: "other" }, { ...track, revision: 5 }, { ...track, budget: undefined }, { ...track, budget: { proposedCents: 5900, confirmedCents: null } }, { ...track, budget: { proposedCents: 5800, confirmedCents: 5800 } }])("refuses invalid track %#", candidate => expect(chargerPurchaseAllowed(CHARGER_CATALOG, "s", candidate as ChargerTrack | null, terms)).toBe(false));
  it.each([{ quantity: 2 }, { totalCents: 1 }, { currency: "EUR" }, { variantId: "dmv_otheradapter" }, { chargerRevision: undefined }, { chargerDraftId: undefined }])("refuses altered terms %j", patch => expect(chargerPurchaseAllowed(CHARGER_CATALOG, "s", track, { ...terms, ...patch })).toBe(false));
  it("refuses a catalog rollback", () => expect(chargerPurchaseAllowed(DEMO_MERCHANT_CATALOG, "s", track, terms)).toBe(false));
});
import { createQuote, verifyQuote } from "@/lib/quote/quote";
import { createSequentialIdGenerator } from "@/lib/shared/ids";
it("quotes the fixed adapter with server binding, never a client price", () => {
  const result = createQuote({ sessionId: "ses_" + "1".repeat(32), checkoutIntentId: "ci_" + "2".repeat(32), catalog: CHARGER_CATALOG, ids: createSequentialIdGenerator(), now: new Date("2026-10-25T00:00:00Z"), request: { productId: CHARGER_PRODUCT_ID, variantId: CHARGER_VARIANT_ID, quantity: 1 }, chargerBinding: { chargerDraftId: "d", chargerRevision: 4 } });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toMatchObject({ totalCents: 5900, chargerDraftId: "d", chargerRevision: 4 });
  expect(verifyQuote(result.value, { sessionId: result.value.sessionId, catalog: CHARGER_CATALOG, now: new Date("2026-10-25T00:00:01Z") }).ok).toBe(true);
});
import { parsePermissionForm } from "@/server/permission-form";
it("offers an adapter permission only with explicit eligibility", () => {
  const input = { item: `${CHARGER_PRODUCT_ID}:${CHARGER_VARIANT_ID}`, quantity: "1", total: "59.00", expiry: "15m" };
  expect(parsePermissionForm(input, CHARGER_CATALOG).ok).toBe(false);
  expect(parsePermissionForm(input, CHARGER_CATALOG, 5900).ok).toBe(true);
});
it("refuses permission limits above the confirmed charger budget", () => {
 expect(parsePermissionForm({ item: `${CHARGER_PRODUCT_ID}:${CHARGER_VARIANT_ID}`, quantity: "1", total: "60.00", expiry: "15m" }, CHARGER_CATALOG, 5900).ok).toBe(false);
});
