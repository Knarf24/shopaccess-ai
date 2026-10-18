import type { JourneyLanguage } from "./language";

/** Device-profile page copy. It does not say a product is compatible or suitable. */

export const PROFILE_ERROR_CODES = ["MALFORMED", "FIELD_INVALID", "VERSION_STALE", "VERSION_EXHAUSTED", "SESSION_NOT_LIVE", "STORED_INVALID"] as const;
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number];
export const isProfileErrorCode = (code: string | null | undefined): code is ProfileErrorCode =>
  typeof code === "string" && (PROFILE_ERROR_CODES as readonly string[]).includes(code);

export const PROFILE_RESULT_CODES = ["saved", "removed", "unchanged"] as const;
export type ProfileResultCode = (typeof PROFILE_RESULT_CODES)[number];
export const isProfileResultCode = (code: string | null | undefined): code is ProfileResultCode =>
  typeof code === "string" && (PROFILE_RESULT_CODES as readonly string[]).includes(code);

export interface ProfileCopy {
  readonly pageTitle: string;
  readonly shopLink: string;
  readonly skip: string;
  readonly intro: string;
  readonly brandLabel: string;
  readonly modelLabel: string;
  readonly brandConsent: string;
  readonly modelConsent: string;
  readonly save: string;
  readonly remove: string;
  readonly empty: string;
  readonly saved: string;
  readonly removed: string;
  readonly unchanged: string;
  readonly stale: string;
  readonly invalid: string;
  readonly exhausted: string;
  readonly malformed: string;
  readonly storedInvalid: string;
  readonly sessionEnded: string;
  readonly unavailablePostgres: string;
  readonly noSession: string;
  readonly startShopping: string;
  readonly backToShop: string;
  readonly savedBrand: string;
  readonly savedModel: string;
}

const EN: ProfileCopy = {
  pageTitle: "Device profile",
  shopLink: "Device profile",
  skip: "Skip to the device profile",
  intro: "Optional. Saving a brand or model here does not change recommendations, the extension, compatibility, payment, or checkout.",
  brandLabel: "Brand",
  modelLabel: "Model",
  brandConsent: "Save the brand for this shopping session",
  modelConsent: "Save the model for this shopping session",
  save: "Save device profile",
  remove: "Remove device profile",
  empty: "No device profile is saved for this shopping session.",
  saved: "The device profile was saved.",
  removed: "The device profile was removed.",
  unchanged: "No device profile is saved.",
  stale: "The profile changed. Review it and try again.",
  invalid: "Check the box and enter the brand or model you want to save. A box that is checked needs text.",
  exhausted: "The profile could not be saved again. You can remove it.",
  malformed: "The form could not be read. Nothing was saved.",
  storedInvalid: "The saved profile could not be updated.",
  sessionEnded: "This shopping session is no longer available.",
  unavailablePostgres: "Device profiles are not available in this mode.",
  noSession: "Start a shopping session before saving a device profile.",
  startShopping: "Start shopping",
  backToShop: "Back to the shop",
  savedBrand: "Saved brand",
  savedModel: "Saved model",
};

const ES: ProfileCopy = {
  pageTitle: "Perfil del dispositivo",
  shopLink: "Perfil del dispositivo",
  skip: "Saltar al perfil del dispositivo",
  intro: "Opcional. Guardar una marca o un modelo aquí no cambia las recomendaciones, la extensión, la compatibilidad, el pago ni el proceso de compra.",
  brandLabel: "Marca",
  modelLabel: "Modelo",
  brandConsent: "Guardar la marca para esta sesión de compra",
  modelConsent: "Guardar el modelo para esta sesión de compra",
  save: "Guardar perfil del dispositivo",
  remove: "Quitar perfil del dispositivo",
  empty: "No hay un perfil del dispositivo guardado para esta sesión de compra.",
  saved: "El perfil del dispositivo se guardó.",
  removed: "El perfil del dispositivo se quitó.",
  unchanged: "No hay un perfil del dispositivo guardado.",
  stale: "El perfil cambió. Revíselo e inténtelo de nuevo.",
  invalid: "Marque la casilla y escriba la marca o el modelo que quiere guardar. Una casilla marcada necesita texto.",
  exhausted: "El perfil no se pudo guardar otra vez. Puede quitarlo.",
  malformed: "No se pudo leer el formulario. No se guardó nada.",
  storedInvalid: "No se pudo actualizar el perfil guardado.",
  sessionEnded: "Esta sesión de compra ya no está disponible.",
  unavailablePostgres: "Los perfiles del dispositivo no están disponibles en este modo.",
  noSession: "Inicie una sesión de compra antes de guardar un perfil del dispositivo.",
  startShopping: "Empezar a comprar",
  backToShop: "Volver a la tienda",
  savedBrand: "Marca guardada",
  savedModel: "Modelo guardado",
};

export function profileCopy(language: JourneyLanguage): ProfileCopy {
  return language === "es" ? ES : EN;
}

export function profileNotice(copy: ProfileCopy, code: ProfileErrorCode | ProfileResultCode | null): string | null {
  if (code === "saved") return copy.saved;
  if (code === "removed") return copy.removed;
  if (code === "unchanged") return copy.unchanged;
  if (code === "MALFORMED") return copy.malformed;
  if (code === "FIELD_INVALID") return copy.invalid;
  if (code === "VERSION_STALE") return copy.stale;
  if (code === "VERSION_EXHAUSTED") return copy.exhausted;
  if (code === "SESSION_NOT_LIVE") return copy.sessionEnded;
  if (code === "STORED_INVALID") return copy.storedInvalid;
  return null;
}
