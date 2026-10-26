import { isDemoCharger } from "@/lib/catalog/charger-purchase";
import { isLaptopVariant } from "@/lib/catalog/schemas";
import { findMerchantVariant } from "@/lib/catalog/merchant-catalog";
import type { MerchantCatalog } from "@/lib/catalog/schemas";
import type { PermissionFormCode } from "@/lib/i18n/permission-copy";
import { EXPIRY_CHOICES, type ExpiryChoice } from "@/lib/permissions/model";

/**
 * The create-permission form (M2-3 slice 3), parsed the same way for the review page (GET, no effect) and the create
 * route (POST). The seller always comes from the catalog entry the shopper chose, never from the form.
 */
export type PermissionFormField = "item" | "quantity" | "total" | "expiry";

export interface PermissionDraft {
  readonly merchantId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly maxQuantity: number;
  readonly maxTotalCents: number;
  readonly expiry: ExpiryChoice;
}

export type PermissionFormResult = { readonly ok: true; readonly value: PermissionDraft } | { readonly ok: false; readonly code: PermissionFormCode; readonly field: PermissionFormField };

const ITEM = /^(dmp_[a-z0-9]{6,24}):(dmv_[a-z0-9]{6,24})$/;
const QUANTITY = /^[1-9][0-9]?$/;
/** Whole dollars or dollars and exactly two cents digits; at most six whole-dollar digits. */
const TOTAL = /^(0|[1-9][0-9]{0,5})(\.[0-9]{2})?$/;

export interface PermissionFormInput {
  readonly item?: string | null;
  readonly quantity?: string | null;
  readonly total?: string | null;
  readonly expiry?: string | null;
}

export function parsePermissionForm(input: PermissionFormInput, catalog: MerchantCatalog, adapterBudgetCents?: number): PermissionFormResult {
  const item = ITEM.exec(input.item ?? "");
  const entry = item ? findMerchantVariant(catalog, item[1], item[2]) : undefined;
  if (!item || !entry || (!isLaptopVariant(entry.variant) && !(adapterBudgetCents !== undefined && isDemoCharger(catalog, item[1], item[2])))) return { ok: false, code: "ITEM_INVALID", field: "item" };
  const quantityText = input.quantity ?? "";
  const maxQuantity = QUANTITY.test(quantityText) ? Number(quantityText) : NaN;
  if (!Number.isInteger(maxQuantity) || maxQuantity > entry.variant.maxQuantityPerOrder) return { ok: false, code: "QUANTITY_INVALID", field: "quantity" };
  const total = TOTAL.exec((input.total ?? "").trim());
  const maxTotalCents = total ? Number(total[1]) * 100 + (total[2] ? Number(total[2].slice(1)) : 0) : NaN;
  if (!Number.isSafeInteger(maxTotalCents) || maxTotalCents < 1) return { ok: false, code: "TOTAL_INVALID", field: "total" };
  if (!isLaptopVariant(entry.variant) && (maxTotalCents < 5900 || maxTotalCents > adapterBudgetCents!)) return { ok: false, code: "TOTAL_INVALID", field: "total" };
  const expiry = input.expiry ?? "";
  if (!Object.hasOwn(EXPIRY_CHOICES, expiry)) return { ok: false, code: "EXPIRY_INVALID", field: "expiry" };
  return {
    ok: true,
    value: { merchantId: catalog.merchant.merchantId, productId: entry.product.productId, variantId: entry.variant.variantId, maxQuantity, maxTotalCents, expiry: expiry as ExpiryChoice },
  };
}

/** The field a model refusal belongs to, so the page can associate the message with it. */
export function fieldOf(code: PermissionFormCode): PermissionFormField | null {
  if (code === "ITEM_INVALID") return "item";
  if (code === "QUANTITY_INVALID") return "quantity";
  if (code === "TOTAL_INVALID") return "total";
  if (code === "EXPIRY_INVALID") return "expiry";
  return null;
}
