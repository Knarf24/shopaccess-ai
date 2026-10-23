import type { JourneyLanguage } from "./language";
import type { FactorKey, FactorOutcome, IntendedUse, ReadinessStatus } from "../readiness/engine";
import type { NeedsNotice } from "./needs-notice";

/** Legend for the mock homepage language choice. The PostgreSQL home does not render it. */
export const GUIDED_ENTRY_LABEL = "Guided shopping in English or Spanish";
/** Accessible name of the English radio. The submitted value is `en`. */
export const GUIDED_LANGUAGE_EN = "English";
/** Accessible name of the Spanish radio. The submitted value is `es`. */
export const GUIDED_LANGUAGE_ES = "Español";
export const GUIDED_ENTRY_SUBMIT = "Start guided shopping";

export interface JourneyCopy {
  readonly languageName: string;
  readonly pageTitle: string;
  readonly skipToCurrentStep: string;
  readonly prompt: string;
  readonly shopperText: string;
  readonly useLabel: string;
  readonly budgetLabel: string;
  readonly budgetHint: string;
  readonly submit: string;
  readonly uses: Record<IntendedUse, string>;
  readonly questions: { readonly intended_use: string; readonly budget: string };
  readonly reviewTitle: string;
  readonly reviewBody: string;
  readonly confirmReview: string;
  readonly clarificationExplanation: string;
  readonly followUpLabel: string;
  readonly conversationHeading: string;
  /** Visible name on the shopper's own messages. */
  readonly speakerShopper: string;
  /** Visible name on messages from this website. */
  readonly speakerAssistant: string;
  readonly restartNeeds: string;
  readonly notices: Record<NeedsNotice, string>;
  readonly alerts: {
    readonly STALE_DRAFT: string;
    readonly DRAFT_EXPIRED: string;
    readonly DRAFT_NOT_FOUND: string;
    readonly CLARIFICATION_INVALID: string;
    readonly TEXT_TOO_LONG: string;
    readonly CONFIRM_INCOMPLETE: string;
    readonly COOKIE_DROPPED: string;
  };
  readonly pending: string;
  readonly suitable: string;
  readonly noCatalog: string;
  readonly noSuggestion: string;
  readonly unavailable: string;
  readonly englishOriginal: string;
  readonly missingTranslation: string;
  readonly catalogHeading: string;
  readonly catalogNotice: string;
  readonly checkLimitation: string;
  readonly whyThis: string;
  readonly excludedHeading: string;
  readonly advisoryHeading: string;
  readonly suggestedLabel: string;
  readonly otherChoiceLabel: string;
  readonly suggestionSourceMock: string;
  readonly suggestionSourceModel: string;
  readonly suggestionSourceFallback: string;
  readonly externalAiNotice: (provider: string) => string;
  readonly aiLimited: string;
  readonly listingsHeading: string;
  readonly listingsIntro: string;
  readonly searchListings: string;
  readonly listingsPending: string;
  readonly listingsSubmitError: string;
  readonly listingsUnavailable: string;
  readonly listingsLimit: string;
  readonly listingsError: string;
  readonly listingsStale: string;
  readonly listingsEmpty: string;
  readonly indicativePrice: string;
  readonly priceNotRefreshed: string;
  readonly availabilityUnverified: string;
  readonly suitabilityUnverified: string;
  readonly retrievedLabel: string;
  readonly listingsDisclosure: string;
  readonly reportedDomain: string;
  readonly domainUnknown: string;
  readonly reportedInStock: string;
  readonly reportedOutOfStock: string;
  readonly noSafeLink: string;
  readonly viewListing: string;
  readonly priceLabel: string;
  readonly reviewPurchase: string;
  readonly shipping: string;
  /** Compact result cards: the difference between the fixed demo price and the confirmed budget, both server values. */
  readonly budgetUnder: (difference: string, budget: string) => string;
  readonly budgetOver: (difference: string, budget: string) => string;
  readonly budgetEqual: (budget: string) => string;
  /** Shown only when every assessed factor passed; no count and no ranking. */
  readonly meetsAllChecks: string;
  /** The confirmed use and budget at the top of the results panel. */
  readonly confirmedBrief: (use: string, budget: string) => string;
  /** In-page link to the results on small screens. */
  readonly resultsJump: (eligible: number) => string;
  readonly navigationHome: string;
  readonly status: Record<ReadinessStatus, string>;
  readonly factors: Record<FactorKey, string>;
  readonly outcomes: Record<FactorOutcome, string>;
  readonly confirmation: {
    readonly heading: string;
    readonly seller: string;
    readonly item: string;
    readonly quantity: string;
    readonly tax: string;
    readonly taxValue: string;
    readonly total: string;
    readonly explanation: string;
    readonly acknowledgement: string;
    readonly submit: string;
  };
  readonly sandboxCheckout: {
    readonly heading: string;
    readonly awaiting: string;
    readonly approved: string;
    readonly captured: string;
    readonly approve: string;
    readonly capture: string;
    readonly approvalNotConfirmed: string;
    readonly payeeMismatch: string;
    readonly canceled: string;
    readonly unknown: string;
    /** A provider-proven capture decline (saved DECLINED_RETRYABLE): the order was approved, the capture was declined. */
    readonly declined: string;
    /** The cancel button shown while a purchase-permission refusal applies (M2-3). */
    readonly cancel: string;
  };
  /** The mock and Sandbox checkout page and the PayPal cancel-return page, in the checkout's saved language (finding 8). */
  readonly checkoutPage: {
    readonly heading: string;
    readonly quoteHeading: string;
    readonly quantityWord: string;
    readonly soldBy: string;
    readonly missingItem: string;
    readonly totalLabel: string;
    readonly taxNote: string;
    readonly cancelReturn: {
      readonly title: string;
      readonly heading: string;
      readonly noCapture: string;
      readonly capturedObserved: string;
      readonly notHere: string;
      readonly back: string;
    };
  };
  readonly purchaseGuidanceTitle: string;
  readonly reviewGuidance: string;
}

const ENGLISH: JourneyCopy = {
  languageName: "English",
  pageTitle: "Guided shopping",
  skipToCurrentStep: "Skip to the current step",
  prompt: "Describe the laptop you need, or choose a use and a whole-dollar budget below.",
  shopperText: "What you need",
  useLabel: "What you will use it for",
  budgetLabel: "Budget in whole US dollars",
  budgetHint: "From 10 to 99999. A memory size, storage size, or quantity is not a budget.",
  submit: "Submit what I need",
  uses: { programming: "Programming", schoolwork: "Schoolwork", general_productivity: "General productivity" },
  questions: {
    intended_use: "What will you use the laptop for?",
    budget: "What is your budget in whole US dollars?",
  },
  reviewTitle: "Review the understood need",
  reviewBody: "These values are editable. Nothing is recommended until you confirm them.",
  confirmReview: "Confirm this use and budget",
  clarificationExplanation: "You can reply in the box or use the choices below. A reply or a choice is not confirmed until you confirm the summary.",
  followUpLabel: "Reply or correction",
  conversationHeading: "Conversation",
  speakerShopper: "You",
  speakerAssistant: "ShopAccess",
  restartNeeds: "Start again",
  notices: {
    malformed: "That message could not be read as a use and a budget. Choose both below. Nothing was recommended.",
    unavailable: "The wording could not be interpreted just now. Choose a use and a budget below, or try different words. Nothing was recommended.",
    missing_use: "What will you use the laptop for?",
    missing_budget: "What is your budget in whole US dollars?",
    ambiguous: "A number in that message could be a size or a quantity rather than a budget. Enter the budget yourself.",
    review: "Check the use and budget, change anything that is wrong, then confirm.",
  },
  alerts: {
    STALE_DRAFT: "This page is out of date. The current draft was kept. Review it and submit again.",
    DRAFT_EXPIRED: "That draft expired. Nothing was confirmed. Start again.",
    DRAFT_NOT_FOUND: "There is no draft to confirm. Nothing was confirmed.",
    CLARIFICATION_INVALID: "That choice is not a valid use or whole-dollar budget. The saved draft was not changed.",
    TEXT_TOO_LONG: "That message is too long. Shorten it and submit again.",
    CONFIRM_INCOMPLETE: "Choose a use and enter a budget before confirming.",
    COOKIE_DROPPED: "This browser did not keep the session, so the form is not shown.",
  },
  pending: "Suggestions are being prepared.",
  suitable: "These catalog items meet the stated use and budget.",
  noCatalog: "No catalog item meets this use and budget.",
  noSuggestion: "No suggestion matched a catalog item that meets this use and budget.",
  unavailable: "Suggestions are not available right now. Your confirmed use and budget were kept. Refreshing does not ask again. To ask again, change the use or budget and confirm it, or choose Start again.",
  englishOriginal: "The catalog wording and the assessment reason below are the English originals.",
  missingTranslation: "Spanish wording is not available for this line.",
  catalogHeading: "Demo laptops",
  catalogNotice:
    "ShopAccess Demo Store is simulated. Prices shown are fixed demo prices, not a guaranteed current offer. Inventory is simulated. Acer, ASUS, Newegg, and their sellers are not ShopAccess partners. Checkout is a PayPal sandbox demonstration with no physical fulfillment.",
  checkLimitation:
    "Only price, stock, memory, storage, and the published weight guideline were checked. Screen size, processor, storage type, operating system, battery, color, and any other weight limit were not checked. They do not change the prices or which laptops are eligible.",
  whyThis: "Why this?",
  excludedHeading: "Not eligible under these checks",
  advisoryHeading: "Suggestions",
  suggestedLabel: "Suggested",
  otherChoiceLabel: "Other choice you can review",
  suggestionSourceMock: "This suggestion comes from the local demo assistant, not a live model.",
  suggestionSourceModel: "This suggestion comes from the configured model. It is not a purchase instruction.",
  suggestionSourceFallback: "Live AI was unavailable or limited. This suggestion comes from the local demo assistant, not a live model.",
  externalAiNotice: (provider) =>
    `Text entered here is sent to ${provider} to interpret your shopping needs. Do not enter personal, payment, account, or device-pairing information. You can use the use and budget controls instead.`,
  aiLimited: "The live AI request limit was reached. Nothing was sent for this attempt. Local deterministic results remain available, and you can continue with the use and budget controls.",
  listingsHeading: "External listings",
  listingsIntro: "These listings are outside the demo store. ShopAccess is not the seller and cannot check them out.",
  searchListings: "Search external listings",
  listingsPending: "External listings are being retrieved.",
  listingsSubmitError: "The search form could not be submitted. You can try again.",
  listingsUnavailable: "External listing search is turned off in this demo.",
  listingsLimit: "External listing search has reached its limit. Nothing was sent.",
  listingsError: "External listings could not be retrieved.",
  listingsStale: "The request changed, so this listing result was discarded.",
  listingsEmpty: "No external listings were returned.",
  indicativePrice: "Indicative price",
  priceNotRefreshed: "Channel3 did not report a single in-stock US dollar price and link for this listing.",
  availabilityUnverified: "Availability was not reported for a single offer.",
  suitabilityUnverified: "Suitability was not checked.",
  retrievedLabel: "Retrieved",
  listingsDisclosure:
    "External listings from Channel3. Links may be affiliate links. Prices and availability are reported by Channel3 and may change; ShopAccess has not independently verified them. Purchases happen on the seller’s website.",
  reportedDomain: "Website reported by Channel3:",
  domainUnknown: "Website not reported.",
  reportedInStock: "Reported in stock by Channel3.",
  reportedOutOfStock: "Reported out of stock by Channel3.",
  noSafeLink: "No safe link is available.",
  viewListing: "View listing",
  priceLabel: "Fixed demo price",
  reviewPurchase: "Review this purchase",
  shipping: "Tax and shipping are $0.00 in this demonstration. Nothing is shipped.",
  budgetUnder: (difference, budget) => `${difference} under your ${budget} budget`,
  budgetOver: (difference, budget) => `${difference} over your ${budget} budget`,
  budgetEqual: (budget) => `Exactly your ${budget} budget`,
  meetsAllChecks: "Meets every rule checked here",
  confirmedBrief: (use, budget) => `Your confirmed brief: ${use}, up to ${budget}`,
  resultsJump: (eligible) => (eligible === 1 ? "See results · 1 eligible laptop" : `See results · ${eligible} eligible laptops`),
  navigationHome: "Back to the start",
  status: {
    READY: "Ready",
    READY_WITH_CAVEATS: "Ready with caveats",
    NOT_RECOMMENDED: "Not recommended",
    INSUFFICIENT_EVIDENCE: "Not enough evidence",
  },
  factors: { affordability: "Affordability", availability: "Availability", memory: "Memory", storage: "Storage", portability: "Portability" },
  outcomes: { PASS: "Meets the rule", CAVEAT: "Meets the rule with a caveat", FAIL: "Does not meet the rule", UNKNOWN: "Unknown" },
  confirmation: {
    heading: "Review and confirm this purchase summary",
    seller: "Seller",
    item: "Item",
    quantity: "Quantity",
    tax: "Tax and shipping",
    taxValue: "$0.00 (assumed for this Sandbox demonstration; nothing is shipped)",
    total: "Total",
    explanation:
      "Confirming does not take payment. It records that you agree to this exact summary. If PayPal checkout is added later, approving the payment in PayPal is the step that would authorize payment.",
    acknowledgement: "I have reviewed the seller, item, quantity and total above.",
    submit: "Confirm this purchase summary",
  },
  sandboxCheckout: {
    heading: "PayPal Sandbox checkout",
    awaiting: "PayPal Sandbox has not confirmed approval. No payment has been captured.",
    approved: "PayPal Sandbox confirmed approval of this order. No payment has been captured.",
    captured: "The payment was captured and the capture evidence was checked.",
    approve: "Continue to PayPal Sandbox",
    capture: "Capture the approved payment",
    approvalNotConfirmed: "PayPal Sandbox did not confirm approval. No payment was captured.",
    payeeMismatch: "The seller on the PayPal order does not match this checkout. No payment was captured.",
    canceled: "This checkout was canceled before any capture. No payment was taken.",
    unknown: "The payment outcome is unknown. Nothing here confirms that a payment was captured.",
    declined: "PayPal Sandbox declined the payment when it was captured, after the order was approved. No payment was captured.",
    cancel: "Cancel this checkout",
  },
  checkoutPage: {
    heading: "Demo checkout",
    quoteHeading: "Quote",
    quantityWord: "quantity",
    soldBy: "sold by",
    missingItem: "Item no longer in the demo catalog",
    totalLabel: "Total",
    taxNote: "Tax and shipping are $0.00 as an assumption of this Sandbox demonstration; nothing is shipped.",
    cancelReturn: {
      title: "Cancel checkout",
      heading: "Cancel this checkout",
      noCapture: "No payment has been captured.",
      capturedObserved: "A payment was captured for this checkout, and a refund, reversal or dispute was later observed.",
      notHere: "It can't be canceled here.",
      back: "Back to the checkout",
    },
  },
  purchaseGuidanceTitle: "Review this purchase",
  reviewGuidance: "Review the seller, item, quantity, and total. The total is calculated by the server. Confirming does not take payment.",
};

const SPANISH: JourneyCopy = {
  languageName: "español",
  pageTitle: "Compra guiada",
  skipToCurrentStep: "Saltar al paso actual",
  prompt: "Describa el portátil que necesita, o elija un uso y un presupuesto en dólares enteros.",
  shopperText: "Lo que necesita",
  useLabel: "Para qué lo va a usar",
  budgetLabel: "Presupuesto en dólares enteros de EE. UU.",
  budgetHint: "De 10 a 99999. Una cantidad de memoria, almacenamiento o unidades no es un presupuesto.",
  submit: "Enviar lo que necesito",
  uses: { programming: "Programación", schoolwork: "Tareas escolares", general_productivity: "Productividad general" },
  questions: {
    intended_use: "¿Para qué va a usar el portátil?",
    budget: "¿Cuál es su presupuesto en dólares enteros?",
  },
  reviewTitle: "Revise la necesidad entendida",
  reviewBody: "Estos valores se pueden editar. No hay una recomendación hasta que usted los confirme.",
  confirmReview: "Confirmar este uso y presupuesto",
  clarificationExplanation: "Puedes responder en el cuadro o usar las opciones de abajo. Una respuesta o una opción no queda confirmada hasta que confirmes el resumen.",
  followUpLabel: "Respuesta o corrección",
  conversationHeading: "Conversación",
  speakerShopper: "Usted",
  speakerAssistant: "ShopAccess",
  restartNeeds: "Empezar de nuevo",
  notices: {
    malformed: "No se pudo leer ese mensaje como un uso y un presupuesto. Elija ambos abajo. No se recomendó nada.",
    unavailable: "No se pudo interpretar el texto ahora. Elija un uso y un presupuesto, o use otras palabras. No se recomendó nada.",
    missing_use: "¿Para qué va a usar el portátil?",
    missing_budget: "¿Cuál es su presupuesto en dólares enteros?",
    ambiguous: "Un número de ese mensaje puede ser una medida o una cantidad, no un presupuesto. Escriba el presupuesto usted.",
    review: "Revise el uso y el presupuesto, corrija lo que esté mal y luego confirme.",
  },
  alerts: {
    STALE_DRAFT: "Esta página está desactualizada. Se conservó el borrador actual. Revíselo y envíelo de nuevo.",
    DRAFT_EXPIRED: "Ese borrador caducó. No se confirmó nada. Empiece de nuevo.",
    DRAFT_NOT_FOUND: "No hay un borrador para confirmar. No se confirmó nada.",
    CLARIFICATION_INVALID: "Esa elección no es un uso válido ni un presupuesto en dólares enteros. El borrador guardado no cambió.",
    TEXT_TOO_LONG: "Ese mensaje es demasiado largo. Acórtelo y envíelo de nuevo.",
    CONFIRM_INCOMPLETE: "Elija un uso y escriba un presupuesto antes de confirmar.",
    COOKIE_DROPPED: "Este navegador no conservó la sesión, así que el formulario no se muestra.",
  },
  pending: "Se están preparando las sugerencias.",
  suitable: "Estos artículos del catálogo cumplen el uso y el presupuesto indicados.",
  noCatalog: "Ningún artículo del catálogo cumple este uso y presupuesto.",
  noSuggestion: "Ninguna sugerencia coincidió con un artículo del catálogo que cumpla este uso y presupuesto.",
  unavailable: "Las sugerencias no están disponibles ahora. Se conservaron el uso y el presupuesto confirmados. Actualizar la página no vuelve a preguntar. Para volver a preguntar, cambie el uso o el presupuesto y confírmelo, o elija Empezar de nuevo.",
  englishOriginal: "El texto del catálogo y el motivo de la evaluación que siguen son los originales en inglés.",
  missingTranslation: "No hay texto en español para esta línea.",
  catalogHeading: "Portátiles de demostración",
  catalogNotice:
    "La tienda de demostración de ShopAccess es simulada. Los precios mostrados son precios fijos de demostración, no una oferta vigente garantizada. El inventario es simulado. Acer, ASUS, Newegg y sus vendedores no son socios de ShopAccess. El pago es una demostración del entorno de pruebas de PayPal y no hay entrega física.",
  checkLimitation:
    "Solo se comprobaron el precio, la disponibilidad, la memoria, el almacenamiento y la guía de peso publicada. No se comprobaron el tamaño de la pantalla, el procesador, el tipo de almacenamiento, el sistema operativo, la batería, el color ni otro límite de peso. Esos datos no cambian los precios ni qué portátiles son adecuados.",
  whyThis: "¿Por qué este?",
  excludedHeading: "No aptos según estas comprobaciones",
  advisoryHeading: "Sugerencias",
  suggestedLabel: "Sugerido",
  otherChoiceLabel: "Otra opción que puedes revisar",
  suggestionSourceMock: "Esta sugerencia viene del asistente local de demostración, no de un modelo en vivo.",
  suggestionSourceModel: "Esta sugerencia viene del modelo configurado. No es una instrucción de compra.",
  suggestionSourceFallback: "La IA en vivo no estaba disponible o alcanzó su límite. Esta sugerencia viene del asistente local de demostración, no de un modelo en vivo.",
  externalAiNotice: (provider) =>
    `El texto escrito aquí se envía a ${provider} para interpretar sus necesidades de compra. No escriba información personal, de pago, de cuenta ni de vinculación de dispositivos. Puede usar los controles de uso y presupuesto.`,
  aiLimited: "Se alcanzó el límite de solicitudes de IA en vivo. No se envió nada en este intento. Los resultados locales y deterministas siguen disponibles, y puede continuar con los controles de uso y presupuesto.",
  listingsHeading: "Anuncios externos",
  listingsIntro: "Estos anuncios están fuera de la tienda de demostración. ShopAccess no es el vendedor y no puede cobrarlos.",
  searchListings: "Buscar anuncios externos",
  listingsPending: "Se están recuperando los anuncios externos.",
  listingsSubmitError: "No se pudo enviar el formulario de búsqueda. Puedes intentarlo de nuevo.",
  listingsUnavailable: "La búsqueda de anuncios externos está apagada en esta demostración.",
  listingsLimit: "La búsqueda de anuncios externos alcanzó su límite. No se envió nada.",
  listingsError: "No se pudieron obtener los anuncios externos.",
  listingsStale: "La solicitud cambió, así que este resultado se descartó.",
  listingsEmpty: "No se devolvieron anuncios externos.",
  indicativePrice: "Precio indicativo",
  priceNotRefreshed: "Channel3 no informó un único precio disponible en dólares estadounidenses con enlace para este anuncio.",
  availabilityUnverified: "No se informó la disponibilidad de una sola oferta.",
  suitabilityUnverified: "La idoneidad no se comprobó.",
  retrievedLabel: "Recuperado",
  listingsDisclosure:
    "Anuncios externos de Channel3. Los enlaces pueden ser enlaces de afiliado. Channel3 informa los precios y la disponibilidad, que pueden cambiar; ShopAccess no los ha verificado de forma independiente. Las compras se realizan en el sitio web del vendedor.",
  reportedDomain: "Sitio web informado por Channel3:",
  domainUnknown: "Sitio web no informado.",
  reportedInStock: "Channel3 lo informa como disponible.",
  reportedOutOfStock: "Channel3 lo informa como agotado.",
  noSafeLink: "No hay un enlace seguro.",
  viewListing: "Ver anuncio",
  priceLabel: "Precio fijo de demostración",
  reviewPurchase: "Revisar esta compra",
  shipping: "Los impuestos y el envío son 0,00 USD en esta demostración. No se envía nada.",
  budgetUnder: (difference, budget) => `${difference} por debajo de su presupuesto de ${budget}`,
  budgetOver: (difference, budget) => `${difference} por encima de su presupuesto de ${budget}`,
  budgetEqual: (budget) => `Exactamente su presupuesto de ${budget}`,
  meetsAllChecks: "Cumple todas las reglas comprobadas aquí",
  confirmedBrief: (use, budget) => `Su resumen confirmado: ${use}, hasta ${budget}`,
  resultsJump: (eligible) => (eligible === 1 ? "Ver resultados · 1 portátil apto" : `Ver resultados · ${eligible} portátiles aptos`),
  navigationHome: "Volver al inicio",
  status: {
    READY: "Adecuado",
    READY_WITH_CAVEATS: "Adecuado con reservas",
    NOT_RECOMMENDED: "No recomendado",
    INSUFFICIENT_EVIDENCE: "Evidencia insuficiente",
  },
  factors: { affordability: "Asequibilidad", availability: "Disponibilidad", memory: "Memoria", storage: "Almacenamiento", portability: "Portabilidad" },
  outcomes: { PASS: "Cumple la regla", CAVEAT: "Cumple la regla con una reserva", FAIL: "No cumple la regla", UNKNOWN: "Desconocido" },
  confirmation: {
    heading: "Revise y confirme este resumen de compra",
    seller: "Vendedor",
    item: "Artículo",
    quantity: "Cantidad",
    tax: "Impuestos y envío",
    taxValue: "0,00 USD (supuesto de esta demostración; no se envía nada)",
    total: "Total",
    explanation:
      "Confirmar no cobra un pago. Registra que usted acepta este resumen exacto. Si más adelante se añade el pago con PayPal, aprobar el pago en PayPal sería el paso que autorizaría el pago.",
    acknowledgement: "He revisado el vendedor, el artículo, la cantidad y el total de arriba.",
    submit: "Confirmar este resumen de compra",
  },
  sandboxCheckout: {
    heading: "Pago en el entorno de pruebas de PayPal",
    awaiting: "El entorno de pruebas de PayPal no ha confirmado la aprobación. No se ha capturado ningún pago.",
    approved: "El entorno de pruebas de PayPal confirmó la aprobación de este pedido. No se ha capturado ningún pago.",
    captured: "El pago se capturó y se comprobó la evidencia de la captura.",
    approve: "Continuar al entorno de pruebas de PayPal",
    capture: "Capturar el pago aprobado",
    approvalNotConfirmed: "El entorno de pruebas de PayPal no confirmó la aprobación. No se capturó ningún pago.",
    payeeMismatch: "El vendedor del pedido de PayPal no coincide con esta compra. No se capturó ningún pago.",
    canceled: "Esta compra se canceló antes de cualquier captura. No se cobró ningún pago.",
    unknown: "El resultado del pago es desconocido. Nada aquí confirma que se haya capturado un pago.",
    declined: "El entorno de pruebas de PayPal rechazó el pago al capturarlo, después de aprobarse el pedido. No se capturó ningún pago.",
    cancel: "Cancelar esta compra",
  },
  checkoutPage: {
    heading: "Compra de demostración",
    quoteHeading: "Cotización",
    quantityWord: "cantidad",
    soldBy: "vendido por",
    missingItem: "El artículo ya no está en el catálogo de demostración",
    totalLabel: "Total",
    taxNote: "Los impuestos y el envío son 0,00 USD como supuesto de esta demostración del entorno de pruebas; no se envía nada.",
    cancelReturn: {
      title: "Cancelar la compra",
      heading: "Cancelar esta compra",
      noCapture: "No se ha capturado ningún pago.",
      capturedObserved: "Se capturó un pago para esta compra y después se observó un reembolso, una reversión o una disputa.",
      notHere: "No se puede cancelar aquí.",
      back: "Volver a la compra",
    },
  },
  purchaseGuidanceTitle: "Revise esta compra",
  reviewGuidance: "Revise el vendedor, el artículo, la cantidad y el total. El total lo calcula el servidor. Confirmar no cobra un pago.",
};

const COPY: Record<JourneyLanguage, JourneyCopy> = { en: ENGLISH, es: SPANISH };

export function journeyCopy(language: JourneyLanguage): JourneyCopy {
  return COPY[language];
}

export interface AdmissionCopy {
  readonly title: string;
  readonly languageLegend: string;
  readonly english: string;
  readonly spanish: string;
  readonly showLanguage: string;
  readonly continueLabel: string;
  readonly continueHint: string;
  readonly passphraseLabel: string;
  readonly submit: string;
  readonly rejected: string;
  readonly retry: string;
  readonly closed: string;
  readonly admitted: string;
  readonly logout: string;
}

const ADMISSION_ENGLISH: AdmissionCopy = {
  title: "Enter the demonstration",
  languageLegend: "Language",
  english: "English",
  spanish: "Español",
  showLanguage: "Show this language",
  continueLabel: "Continue",
  continueHint: "The next step asks for the passphrase.",
  passphraseLabel: "Passphrase",
  submit: "Enter",
  rejected: "The passphrase was not accepted.",
  retry: "Too many attempts. Please wait and try again.",
  closed: "This demonstration is not available.",
  admitted: "You can continue into the shop, or leave the demonstration.",
  logout: "Leave the demonstration",
};

const ADMISSION_SPANISH: AdmissionCopy = {
  title: "Entrar a la demostración",
  languageLegend: "Idioma",
  english: "English",
  spanish: "Español",
  showLanguage: "Mostrar este idioma",
  continueLabel: "Continuar",
  continueHint: "El siguiente paso pide la frase de acceso.",
  passphraseLabel: "Frase de acceso",
  submit: "Entrar",
  rejected: "La frase de acceso no fue aceptada.",
  retry: "Demasiados intentos. Espere y vuelva a intentarlo.",
  closed: "Esta demostración no está disponible.",
  admitted: "Puede continuar a la tienda o salir de la demostración.",
  logout: "Salir de la demostración",
};

const ADMISSION: Record<JourneyLanguage, AdmissionCopy> = { en: ADMISSION_ENGLISH, es: ADMISSION_SPANISH };

export function admissionCopy(language: JourneyLanguage): AdmissionCopy {
  return ADMISSION[language];
}

/** Fixed server sentences, in the shopper's language. Model prose is never passed through here. */
export function recommendationSentence(language: JourneyLanguage, message: string | null): string | null {
  const copy = COPY[language];
  if (message === "These catalog items meet the stated use and budget.") return copy.suitable;
  if (message === "No catalog item meets this use and budget.") return copy.noCatalog;
  if (message === "No suggestion matched a catalog item that meets this use and budget.") return copy.noSuggestion;
  return null;
}

/**
 * Spanish wording for the checkout messages a mock or Sandbox checkout can show (finding 8). The English originals stay in
 * `MESSAGES` (src/server/views.ts). A code missing here keeps its English text, marked English on a Spanish page.
 */
export const CHECKOUT_MESSAGES_ES: Readonly<Record<string, string>> = {
  CONFIRMED: "Se registró su confirmación de este resumen de compra. No se ha cobrado ningún pago.",
  ACKNOWLEDGEMENT_REQUIRED: "Marque la casilla para indicar que revisó el resumen antes de confirmar.",
  CONFIRMATION_ALREADY_USED: "Este resumen ya se confirmó. Confirmarlo de nuevo no cambia nada.",
  CONFIRMATION_SUPERSEDED:
    "Este resumen se volvió a abrir en otra pestaña o se actualizó, así que la copia que envió está desactualizada. No se confirmó nada. Revise el resumen de abajo y vuelva a confirmar.",
  CONFIRMATION_NOT_FOUND: "Ese resumen ya no está disponible. No se confirmó nada. Revise el resumen de abajo y vuelva a confirmar.",
  CONFIRMATION_EXPIRED: "Este resumen caducó antes de confirmarse. Revise el nuevo resumen de abajo.",
  CONFIRMATION_MISMATCH: "La confirmación no coincidía con este resumen. Revise el resumen de abajo e inténtelo de nuevo.",
  QUOTE_EXPIRED: "Esta cotización caducó. Vuelva atrás y pida una nueva cotización.",
  QUOTE_STALE_CATALOG: "El artículo cambió desde que se hizo esta cotización. Vuelva atrás y pida una nueva cotización.",
  QUOTE_NO_LONGER_VALID: "La cotización ya no era válida, así que no se envió nada. Vuelva atrás y pida una nueva cotización.",
  VARIANT_UNAVAILABLE: "Ese portátil no está disponible.",
  QUANTITY_EXCEEDS_LIMIT: "Esa cantidad supera el límite para este portátil.",
  CAPTURE_ALREADY_DISPATCHED: "Esta compra no se puede cancelar porque es posible que ya se haya enviado una solicitud de captura.",
  NOT_CANCELABLE: "Esta compra no se puede cancelar en su estado actual.",
};

/** Spanish counterpart of the generic "That action could not be completed." */
export const CHECKOUT_GENERIC_ES = "No se pudo completar esa acción.";
