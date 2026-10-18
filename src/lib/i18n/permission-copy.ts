import type { JourneyLanguage } from "./language";

/**
 * F07 purchase-permission copy (M2-3 slice 3), English and Spanish. Shopper-facing only: no internal state names,
 * identifiers or payment-state details beyond what the shopper needs to act.
 */

export const PERMISSION_REFUSAL_CODES = [
  "PERMISSION_REQUIRED",
  "PERMISSION_MISMATCH",
  "PERMISSION_QUANTITY_EXCEEDED",
  "PERMISSION_TOTAL_EXCEEDED",
  "PERMISSION_EXPIRED",
  "PERMISSION_REVOKED",
  "PERMISSION_IN_USE",
  "PERMISSION_UNAVAILABLE",
  "CONFIRMATION_REQUIRED",
] as const;
export type PermissionRefusalCode = (typeof PERMISSION_REFUSAL_CODES)[number];

export const isPermissionRefusal = (code: string | undefined | null): code is PermissionRefusalCode =>
  typeof code === "string" && (PERMISSION_REFUSAL_CODES as readonly string[]).includes(code);

/** Outcomes of the permissions page's own forms (create, revoke, review). */
export const PERMISSION_FORM_CODES = [
  "ITEM_INVALID",
  "QUANTITY_INVALID",
  "TOTAL_INVALID",
  "EXPIRY_INVALID",
  "PERMISSION_DUPLICATE",
  "PERMISSION_LIMIT",
  "SESSION_INVALID",
  "REVOKE_IN_PROGRESS",
  "REVOKE_NOT_AVAILABLE",
] as const;
export type PermissionFormCode = (typeof PERMISSION_FORM_CODES)[number];
export const isPermissionFormCode = (code: string | undefined | null): code is PermissionFormCode =>
  typeof code === "string" && (PERMISSION_FORM_CODES as readonly string[]).includes(code);

export type ShownState = "active" | "reserved" | "executing" | "consumed" | "revoked" | "expired" | "outcome_unknown";

export interface PermissionCopy {
  readonly pageTitle: string;
  readonly intro: string;
  readonly stillConfirm: string;
  readonly noSession: string;
  readonly startShopping: string;
  readonly unavailablePostgres: string;
  readonly createHeading: string;
  readonly itemLabel: string;
  readonly itemHint: string;
  readonly quantityLabel: string;
  readonly totalLabel: string;
  readonly totalHint: string;
  readonly expiryLegend: string;
  readonly expiryChoices: { readonly "15m": string; readonly "1h": string; readonly session: string };
  readonly reviewButton: string;
  readonly reviewHeading: string;
  readonly reviewIntro: string;
  readonly createButton: string;
  readonly changeLink: string;
  readonly field: { readonly seller: string; readonly product: string; readonly variant: string; readonly quantity: string; readonly total: string; readonly currency: string; readonly ends: string };
  readonly endsAtCreation: string;
  readonly listHeading: string;
  readonly listEmpty: string;
  readonly states: Record<ShownState, string>;
  readonly stateHelp: Partial<Record<ShownState, string>>;
  /** Button text. Several buttons are told apart by the item they describe (aria-describedby), never by an identifier. */
  readonly revoke: string;
  readonly created: string;
  readonly revoked: string;
  readonly formErrors: Record<PermissionFormCode, string>;
  readonly refusals: Record<PermissionRefusalCode, string>;
  readonly managePermissions: string;
  readonly backToShopping: string;
  /** A capture was sent but its record could not be saved: never "failed", never "try again". */
  readonly captureRecordUnsaved: string;
  /** Title and heading of the page that carries `captureRecordUnsaved`. */
  readonly captureRecordUnsavedTitle: string;
  /** Label for the support reference on that page. */
  readonly referenceLabel: string;
  /** Reconciliation cannot continue (for example after the session ended): manual review. */
  readonly outcomeUnderReview: string;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const formatUsd = usd;

const EN: PermissionCopy = {
  pageTitle: "Purchase permissions",
  intro: "A purchase permission allows one purchase of one exact item, up to a quantity and a total you choose, until it ends.",
  stillConfirm: "You still review and confirm every purchase yourself. A permission never buys anything on its own.",
  noSession: "Open the shop first, then come back to create a purchase permission.",
  startShopping: "Go to the shop",
  unavailablePostgres: "Purchase permissions are unavailable in PostgreSQL mode.",
  createHeading: "Create a purchase permission",
  itemLabel: "Item",
  itemHint: "The seller comes from the item you choose.",
  quantityLabel: "Maximum quantity",
  totalLabel: "Maximum total in US dollars",
  totalHint: "The most you allow for this purchase, including tax and shipping. For example 900 or 879.99.",
  expiryLegend: "Ends",
  expiryChoices: { "15m": "In 15 minutes", "1h": "In 1 hour", session: "When this shopping session ends" },
  reviewButton: "Review permission",
  reviewHeading: "Check this permission before creating it",
  reviewIntro: "This is exactly what the permission will allow.",
  createButton: "Create permission",
  changeLink: "Change these details",
  field: { seller: "Seller", product: "Product", variant: "Version", quantity: "Up to quantity", total: "Up to total", currency: "Currency", ends: "Ends" },
  endsAtCreation: "The exact end time is set when you create it.",
  listHeading: "Your purchase permissions",
  listEmpty: "You have no purchase permissions in this session.",
  states: {
    active: "Ready to use",
    reserved: "Held by a checkout in progress",
    executing: "Completing a payment now",
    consumed: "Used",
    revoked: "Revoked",
    expired: "Ended",
    outcome_unknown: "Payment being checked",
  },
  stateHelp: {
    reserved: "You can still revoke it. The checkout will then stop before any payment.",
    executing: "A payment is being completed with this permission. It can no longer be revoked.",
    outcome_unknown: "We could not confirm whether the payment went through. This permission cannot be used again; the payment will be checked manually. Do not pay again for this item until you know the result.",
  },
  revoke: "Revoke permission",
  created: "Purchase permission created. You can now check out this item within its limits.",
  revoked: "Purchase permission revoked. It can no longer be used.",
  formErrors: {
    ITEM_INVALID: "Choose an item from the list.",
    QUANTITY_INVALID: "Choose a maximum quantity this item allows.",
    TOTAL_INVALID: "Enter a total in US dollars greater than zero, with at most two decimal places.",
    EXPIRY_INVALID: "Choose when the permission ends.",
    PERMISSION_DUPLICATE: "You already have a permission for this exact item. Revoke it first to create a new one.",
    PERMISSION_LIMIT: "You already have five permissions that can be used. Revoke one to create another.",
    SESSION_INVALID: "This shopping session has ended. Open the shop again.",
    REVOKE_IN_PROGRESS: "That permission is being used to complete a payment right now, so it cannot be revoked.",
    REVOKE_NOT_AVAILABLE: "That permission cannot be revoked. It may already be used, revoked or ended.",
  },
  refusals: {
    PERMISSION_REQUIRED: "You need a purchase permission for this exact item before you can check out. Nothing was charged.",
    PERMISSION_MISMATCH: "Your purchase permission is for a different item or seller. Nothing was charged. Create a permission for this item.",
    PERMISSION_QUANTITY_EXCEEDED: "This quantity is more than your purchase permission allows. Nothing was charged.",
    PERMISSION_TOTAL_EXCEEDED: "The total is more than your purchase permission allows. Nothing was charged.",
    PERMISSION_EXPIRED: "Your purchase permission for this item has ended. Nothing was charged. Create a new one to continue.",
    PERMISSION_REVOKED: "Your purchase permission for this item was revoked. Nothing was charged.",
    PERMISSION_IN_USE: "Your purchase permission for this item is already being used by another checkout. Finish or cancel that checkout first.",
    PERMISSION_UNAVAILABLE: "Your purchase permission for this item cannot be used right now. Nothing new was charged. Check your purchase permissions.",
    CONFIRMATION_REQUIRED: "The payment for this checkout was declined, so its confirmation can't be used again. Nothing more was charged. Cancel this checkout and start a new one to confirm again.",
  },
  managePermissions: "Manage purchase permissions",
  backToShopping: "Back to shopping",
  captureRecordUnsavedTitle: "Payment status not confirmed",
  referenceLabel: "Reference",
  captureRecordUnsaved:
    "Your payment may already have gone through, but this purchase could not be recorded here. Do not pay again. The purchase will be checked manually; the store shows as unavailable until then.",
  outcomeUnderReview: "We could not confirm whether the payment went through, and it cannot be retried from here. It will be checked manually. Do not pay again.",
};

const ES: PermissionCopy = {
  pageTitle: "Permisos de compra",
  intro: "Un permiso de compra autoriza una compra de un artículo exacto, hasta la cantidad y el total que usted elija, hasta que termine.",
  stillConfirm: "Usted sigue revisando y confirmando cada compra. Un permiso nunca compra nada por sí solo.",
  noSession: "Abra primero la tienda y luego vuelva para crear un permiso de compra.",
  startShopping: "Ir a la tienda",
  unavailablePostgres: "Los permisos de compra no están disponibles en el modo PostgreSQL.",
  createHeading: "Crear un permiso de compra",
  itemLabel: "Artículo",
  itemHint: "El vendedor corresponde al artículo que elija.",
  quantityLabel: "Cantidad máxima",
  totalLabel: "Total máximo en dólares estadounidenses",
  totalHint: "Lo máximo que autoriza para esta compra, con impuestos y envío. Por ejemplo 900 o 879.99.",
  expiryLegend: "Termina",
  expiryChoices: { "15m": "En 15 minutos", "1h": "En 1 hora", session: "Cuando termine esta sesión de compra" },
  reviewButton: "Revisar permiso",
  reviewHeading: "Revise este permiso antes de crearlo",
  reviewIntro: "Esto es exactamente lo que autorizará el permiso.",
  createButton: "Crear permiso",
  changeLink: "Cambiar estos datos",
  field: { seller: "Vendedor", product: "Producto", variant: "Versión", quantity: "Hasta la cantidad", total: "Hasta el total", currency: "Moneda", ends: "Termina" },
  endsAtCreation: "La hora exacta de término se fija al crearlo.",
  listHeading: "Sus permisos de compra",
  listEmpty: "No tiene permisos de compra en esta sesión.",
  states: {
    active: "Listo para usar",
    reserved: "Reservado por una compra en curso",
    executing: "Completando un pago ahora",
    consumed: "Usado",
    revoked: "Revocado",
    expired: "Terminado",
    outcome_unknown: "Pago en revisión",
  },
  stateHelp: {
    reserved: "Todavía puede revocarlo. La compra se detendrá antes de cualquier pago.",
    executing: "Se está completando un pago con este permiso. Ya no se puede revocar.",
    outcome_unknown: "No pudimos confirmar si el pago se realizó. Este permiso no se puede volver a usar; el pago se revisará manualmente. No vuelva a pagar este artículo hasta conocer el resultado.",
  },
  revoke: "Revocar permiso",
  created: "Permiso de compra creado. Ya puede comprar este artículo dentro de sus límites.",
  revoked: "Permiso de compra revocado. Ya no se puede usar.",
  formErrors: {
    ITEM_INVALID: "Elija un artículo de la lista.",
    QUANTITY_INVALID: "Elija una cantidad máxima que este artículo permita.",
    TOTAL_INVALID: "Escriba un total en dólares estadounidenses mayor que cero, con dos decimales como máximo.",
    EXPIRY_INVALID: "Elija cuándo termina el permiso.",
    PERMISSION_DUPLICATE: "Ya tiene un permiso para este artículo exacto. Revóquelo primero para crear otro.",
    PERMISSION_LIMIT: "Ya tiene cinco permisos que se pueden usar. Revoque uno para crear otro.",
    SESSION_INVALID: "Esta sesión de compra terminó. Vuelva a abrir la tienda.",
    REVOKE_IN_PROGRESS: "Ese permiso se está usando para completar un pago en este momento, así que no se puede revocar.",
    REVOKE_NOT_AVAILABLE: "Ese permiso no se puede revocar. Puede que ya se haya usado, revocado o terminado.",
  },
  refusals: {
    PERMISSION_REQUIRED: "Necesita un permiso de compra para este artículo exacto antes de comprar. No se cobró nada.",
    PERMISSION_MISMATCH: "Su permiso de compra es para otro artículo u otro vendedor. No se cobró nada. Cree un permiso para este artículo.",
    PERMISSION_QUANTITY_EXCEEDED: "Esta cantidad supera lo que permite su permiso de compra. No se cobró nada.",
    PERMISSION_TOTAL_EXCEEDED: "El total supera lo que permite su permiso de compra. No se cobró nada.",
    PERMISSION_EXPIRED: "Su permiso de compra para este artículo terminó. No se cobró nada. Cree uno nuevo para continuar.",
    PERMISSION_REVOKED: "Su permiso de compra para este artículo fue revocado. No se cobró nada.",
    PERMISSION_IN_USE: "Su permiso de compra para este artículo ya lo está usando otra compra. Termine o cancele esa compra primero.",
    PERMISSION_UNAVAILABLE: "Su permiso de compra para este artículo no se puede usar ahora. No se cobró nada nuevo. Revise sus permisos de compra.",
    CONFIRMATION_REQUIRED: "El pago de esta compra fue rechazado, así que su confirmación no se puede volver a usar. No se cobró nada más. Cancele esta compra y empiece una nueva para confirmar otra vez.",
  },
  managePermissions: "Administrar permisos de compra",
  backToShopping: "Volver a la compra",
  captureRecordUnsavedTitle: "Estado del pago sin confirmar",
  referenceLabel: "Referencia",
  captureRecordUnsaved:
    "Es posible que su pago ya se haya realizado, pero esta compra no se pudo registrar aquí. No vuelva a pagar. La compra se revisará manualmente; mientras tanto, la tienda aparece como no disponible.",
  outcomeUnderReview: "No pudimos confirmar si el pago se realizó, y no se puede reintentar desde aquí. Se revisará manualmente. No vuelva a pagar.",
};

export function permissionCopy(language: JourneyLanguage): PermissionCopy {
  return language === "es" ? ES : EN;
}
