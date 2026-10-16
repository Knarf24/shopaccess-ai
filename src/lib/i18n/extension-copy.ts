import type { JourneyLanguage } from "./language";

/** Website copy for extension pairing and paired access (M2-2). English and Spanish. */
export interface ExtensionCopy {
  readonly pairHeading: string;
  readonly pairExplanation: string;
  readonly pairLimits: string;
  readonly approve: string;
  readonly deny: string;
  readonly approved: string;
  readonly denied: string;
  readonly pairFailed: string;
  readonly pairNoSession: string;
  readonly pairedHeading: string;
  readonly pairedNone: string;
  readonly pairedExplanation: string;
  readonly revoke: (label: string) => string;
  readonly paired: (time: string) => string;
  readonly expires: (time: string) => string;
}

const EN: ExtensionCopy = {
  pairHeading: "Pair the ShopAccess side panel",
  pairExplanation: "Allow the ShopAccess browser extension to read and continue this shopping conversation.",
  pairLimits: "It cannot confirm a purchase, start a checkout or pay. Access ends within one hour, when this session ends, or when you revoke it.",
  approve: "Allow conversation access",
  deny: "Deny",
  approved: "Access allowed. Return to the side panel; it connects within a few seconds.",
  denied: "Access denied. The side panel was not connected.",
  pairFailed: "This pairing request is no longer valid. Start pairing again from the side panel.",
  pairNoSession: "Open the shop first, then start pairing again from the side panel.",
  pairedHeading: "Paired access",
  pairedNone: "No side panel is paired with this session.",
  pairedExplanation: "These side panels can read and continue this conversation. They cannot buy or pay.",
  revoke: (label) => `Revoke pairing ${label}`,
  paired: (time) => `Paired ${time}.`,
  expires: (time) => `Ends ${time}.`,
};

const ES: ExtensionCopy = {
  pairHeading: "Vincular el panel lateral de ShopAccess",
  pairExplanation: "Permita que la extensión de ShopAccess lea y continúe esta conversación de compra.",
  pairLimits: "No puede confirmar una compra, iniciar un pago ni pagar. El acceso termina en una hora, cuando termina esta sesión o cuando usted lo revoca.",
  approve: "Permitir acceso a la conversación",
  deny: "Rechazar",
  approved: "Acceso permitido. Vuelva al panel lateral; se conecta en unos segundos.",
  denied: "Acceso rechazado. El panel lateral no se conectó.",
  pairFailed: "Esta solicitud de vinculación ya no es válida. Vuelva a vincular desde el panel lateral.",
  pairNoSession: "Abra primero la tienda y vuelva a vincular desde el panel lateral.",
  pairedHeading: "Accesos vinculados",
  pairedNone: "No hay ningún panel lateral vinculado a esta sesión.",
  pairedExplanation: "Estos paneles laterales pueden leer y continuar esta conversación. No pueden comprar ni pagar.",
  revoke: (label) => `Revocar el vínculo ${label}`,
  paired: (time) => `Vinculado ${time}.`,
  expires: (time) => `Termina ${time}.`,
};

export function extensionCopy(language: JourneyLanguage): ExtensionCopy {
  return language === "es" ? ES : EN;
}

/** The pairing-specific revocation message reviewed for E1 (274866d), for a grant's eight-character label. */
export function revocationMessage(language: JourneyLanguage, label: string | null, remaining: number): string | null {
  if (label === null || !/^[a-f0-9]{8}$/.test(label)) return null;
  const es = language === "es";
  const head = es
    ? `Acceso revocado para el vínculo ${label}. Ese vínculo ya no puede leer ni cambiar esta conversación.`
    : `Access revoked for pairing ${label}. That pairing can no longer read or change this conversation.`;
  const rest = es
    ? remaining > 1 ? `Quedan ${remaining} otros vínculos activos.` : remaining === 1 ? "Queda 1 otro vínculo activo." : "No queda ningún vínculo activo."
    : remaining > 1 ? `${remaining} other pairings remain active.` : remaining === 1 ? "1 other pairing remains active." : "No paired access remains.";
  return `${head} ${rest}`;
}
