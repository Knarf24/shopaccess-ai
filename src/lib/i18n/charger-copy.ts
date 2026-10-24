import type { ConnectorType } from "@/lib/compatibility/evidence";
import type { BasicGap, FastVerdict, WattageVerdict } from "@/lib/compatibility/rules";
import type { JourneyLanguage } from "./language";
import type { ChargerLine } from "@/lib/session/charger-clarification";

/** F03 charger information page (information only). Apple product names and page titles stay English and are marked so. */
export interface ChargerCopy {
  readonly pageTitle: string;
  readonly skip: string;
  readonly intro: string;
  readonly infoOnly: string;
  readonly affiliation: string;
  readonly claimsNote: string;
  readonly deviceLabel: string;
  readonly devicePlaceholder: string;
  readonly identifierLabel: string;
  readonly identifierHint: string;
  readonly identifyAir: string;
  readonly identifyPro: string;
  readonly submit: string;
  readonly unidentified: string;
  /** Followed by the device's Apple name and model identifier. */
  readonly resultsHeading: string;
  readonly tableCaption: string;
  /** Shown above the comparison scroller on the needs page. The charger page does not render it. */
  readonly scrollHint: string;
  readonly columns: { readonly configuration: string; readonly basic: string; readonly wattage: string; readonly fast: string };
  readonly withCable: string;
  readonly basic: {
    readonly "supported-apple-listed": string;
    readonly "supported-apple-fast-charge-list": string;
    readonly "supported-specification": string;
    /** F03 C1 (non-Apple; not rendered yet). */
    readonly "supported-manufacturer-listed": string;
    /** F03 C1 (non-Apple; not rendered yet). */
    readonly "supported-pd-profile": string;
    readonly unsupported: string;
  };
  /** Why basic support is unknown, naming only the ports a source documents and the cable's connector. */
  readonly gap: (gap: BasicGap, documentedPorts: readonly ConnectorType[], cableConnector: ConnectorType) => string;
  /** Shared, neutral disclaimer shown with every result table. */
  readonly disclaimer: string;
  /** Where the adapter model numbers come from (test footnotes about other Mac models). */
  readonly modelNumberNote: string;
  /** Row note where Apple's list names a USB-C charge cable without a power rating. */
  readonly cableRatingUnspecified: string;
  readonly wattage: (verdict: WattageVerdict, watts: number | null, included: readonly number[]) => string;
  readonly wattageOnly: string;
  readonly fast: Readonly<Record<FastVerdict, string>>;
  readonly sourceLabel: string;
  readonly cableNote: string;
  readonly cableNoteQuote: string;
  readonly cableNoteAfter: string;
  readonly sourcesHeading: string;
  readonly accessed: (date: string) => string;
  readonly otherLanguage: string;
  readonly unavailable: string;
  /** Link to this page from the guided needs page (in the journey's language). */
  readonly needsLink: string;
  /** Guidance shown instead of laptop-summary copy while charger clarification is active. */
  readonly needsExplanation: string;
  /** Hand-off form on the guided needs page: sends only the chosen exact model and the journey language. */
  readonly handoffLabel: string;
  readonly handoffPlaceholder: string;
  readonly handoffButton: string;
  readonly conversationLines: Readonly<Record<ChargerLine, string>>;
  readonly taskChoiceLabel: string;
  readonly chooseLaptopTask: string;
  readonly chooseChargerTask: string;
  readonly modelChoiceLabel: string;
  readonly confirmModel: string;
  readonly changeModel: string;
  readonly stopChargerTask: string;
  readonly currentModelLabel: string;
}

const W = (watts: number, space: string) => `${watts}${space}W`;

/** Apple's connector names (the same in both languages), and the manufacturers' "DC-in" label for a barrel input (F03 C1). */
const PORT_NAMES: Readonly<Record<ConnectorType, string>> = { "usb-c": "USB-C", "magsafe-2": "MagSafe 2", "magsafe-3": "MagSafe 3", "dc-barrel": "DC-in" };
/** The cable whose device end is this connector, as named in the gap explanation. */
const CABLE_NAMES_EN: Readonly<Record<ConnectorType, string>> = {
  "usb-c": "USB-C charge cable",
  "magsafe-2": "MagSafe 2 cable",
  "magsafe-3": "USB-C to MagSafe 3 Cable",
  "dc-barrel": "DC barrel plug",
};
const CABLE_NAMES_ES: Readonly<Record<ConnectorType, string>> = {
  "usb-c": "cable de carga USB-C",
  "magsafe-2": "cable MagSafe 2",
  "magsafe-3": "cable USB-C a MagSafe 3",
  "dc-barrel": "conector de barril de CC",
};
function includedList(included: readonly number[], space: string, or: string, depending: string): string {
  if (included.length === 1) return W(included[0]!, space);
  return `${included.map((w) => W(w, space)).join(` ${or} `)}, ${depending}`;
}

const ENGLISH: ChargerCopy = {
  pageTitle: "Charger information for your Mac",
  skip: "Skip to the current step",
  intro: "Choose your exact Mac model to see what Apple's public documentation says about two Apple power adapters, each with two cables.",
  infoOnly: "This page gives information only. These chargers are not sold here.",
  affiliation:
    "ShopAccess is not affiliated with Apple. Apple product names are used only to identify products, and the evidence comes from Apple's public support and product pages listed below.",
  claimsNote:
    "Each row describes one adapter with one cable. Charging, wattage and fast charging are separate statements, each with its own sources. Wattage and connector type alone do not show how quickly a Mac charges.",
  deviceLabel: "Your Mac model",
  devicePlaceholder: "Choose a model",
  identifierLabel: "Or enter the exact model identifier",
  identifierHint: "For example Mac14,2. You can find it in System Information or with Apple's pages below. A description such as a year is not enough.",
  identifyAir: "Identify your MacBook Air model",
  identifyPro: "Identify your MacBook Pro model",
  submit: "Show charger information",
  unidentified:
    "That does not identify one Mac model in this comparison. A description such as a year or a family name can match several models with different charging needs, so nothing is shown. Choose a model from the list or enter its exact model identifier.",
  resultsHeading: "Results for",
  tableCaption: "Two Apple power adapters, each with two cables",
  scrollHint: "Scroll sideways inside this table to read every claim.",
  columns: { configuration: "Adapter and cable", basic: "Charging", wattage: "Wattage", fast: "Fast charging" },
  withCable: "with",
  basic: {
    "supported-apple-listed": "Apple lists this adapter and cable for this Mac.",
    "supported-apple-fast-charge-list": "Apple's fast-charge list includes this exact adapter and cable for this Mac, which shows that this configuration charges it.",
    "supported-specification": "Supported by specification: Apple's USB-C charging guidance and the cited specifications for this Mac and adapter.",
    "supported-manufacturer-listed": "The manufacturer lists this adapter and cable for this exact model and part number.",
    "supported-pd-profile":
      "The cited sources give this adapter a USB Power Delivery voltage and current that match what this exact model and part number requires, and rate this cable for that current.",
    unsupported:
      "Not supported in this configuration: the sources establish that this Mac's charging ports do not include this cable's connector. This covers this adapter and cable only, without converters or other adapters.",
  },
  gap: (gap, ports, cable) => {
    const names = ports.map((p) => PORT_NAMES[p]).join(" and ");
    switch (gap) {
      case "connector-generation-differs":
        return `Not established: this Mac's documented power port is ${names} and this cable ends in ${PORT_NAMES[cable]}; the captured sources do not say whether they fit.`;
      case "charging-port-for-cable-not-documented":
        return `Not established: the captured Apple specifications for this Mac document a ${names} power port and do not address charging through a ${CABLE_NAMES_EN[cable]}.`;
      case "no-listed-configuration":
        return "Not established: the captured Apple pages do not list this configuration for this Mac, and no adapter specification here supports it.";
      case "no-evidence":
        return "Not established: the captured sources do not show whether this configuration charges this Mac.";
      // F03 C1 (non-Apple; not rendered yet). Neutral: none of these says that a configuration works or fails.
      case "identity-unverified":
        return "Not assessed: no official manufacturer source confirms this exact model and part number.";
      case "discrepancy-unresolved":
        return "Not established: the cited information differs on something this result needs, and the difference has not been resolved.";
      case "sources-contradict":
        return "Not established: the sources contradict each other on a fact this result needs, for this exact configuration.";
      case "family-scoped-only":
        return "Not established: the available information describes a model family, not this exact model and part number.";
      case "connector-details-unknown":
        return "Not established: the sources do not give every detail of this connector (size, voltage and polarity), and a barrel connector is assessed only from a manufacturer listing for this exact model.";
      case "pd-profile-not-established":
        return "Not established: the sources do not show a matching USB Power Delivery voltage and current for this model and adapter.";
      case "cable-capability-not-established":
        return "Not established: the sources do not show that this cable is rated for the current this configuration needs.";
      case "cable-connectors-not-established":
        return "Not established: the sources do not show which connector this cable has at each end for this exact configuration.";
      case "no-manufacturer-listing":
        return "Not established: the manufacturer does not list this configuration for this model, and the cited specifications do not establish it.";
    }
  },
  disclaimer:
    "Each result states what the captured Apple sources support. An unknown result is not a compatibility recommendation. An Apple-listed configuration is not necessarily one Apple tested on this exact model.",
  modelNumberNote: "The adapters' model numbers come from Apple's test footnotes, which describe tests on other Mac models.",
  cableRatingUnspecified:
    "Apple lists a USB-C charge cable for this configuration, but the captured source does not specify its required power rating. This result does not establish that every USB-C cable is suitable.",
  wattage: (verdict, watts, included) => {
    const list = includedList(included, "", "or", "depending on configuration");
    switch (verdict) {
      case "at-or-above-all":
        return `${W(watts ?? 0, "")} is at or above the wattage of the adapter Apple included (${list}).`;
      case "at-or-above-some":
        return `${W(watts ?? 0, "")} is at or above some of the adapters Apple included (${list}) and below others. Apple recommends at least the wattage of the adapter recommended for your Mac for the best charging experience.`;
      case "below-all":
        return `${W(watts ?? 0, "")} is below the wattage of the adapter Apple included (${list}). Apple recommends at least that wattage for the best charging experience.`;
      case "unknown":
        return "Wattage comparison not established.";
    }
  },
  wattageOnly: "This compares wattage only; it does not show that this configuration charges this Mac.",
  fast: {
    listed: "Apple lists this configuration for fast charging.",
    "not-listed": "Apple's captured fast-charge list does not include this configuration.",
  },
  sourceLabel: "Sources:",
  cableNote: "Apple's store pages for both adapters say:",
  cableNoteQuote: "Charging cable sold separately.",
  cableNoteAfter: "",
  sourcesHeading: "Sources",
  accessed: (date) => `Accessed ${date}`,
  otherLanguage: "Español",
  unavailable: "Charger information is not available in this mode.",
  needsLink: "Explore charger information",
  needsExplanation: "Reply with the exact Mac model identifier or choose a model below. Confirm the model on this website to see an information-only comparison; nothing is purchased.",
  handoffLabel: "Which Mac is this for?",
  handoffPlaceholder: "Choose an exact model",
  handoffButton: "Show charger information for this Mac",
  conversationLines: {
    charger_task_choice: "Which task should we work on now: laptop shopping or charger information? Choose one to continue.",
    charger_model: "Which exact Mac model is this charger for? Choose a model or reply with its exact identifier.",
    charger_review: "Review this identified Mac model. Confirm on this website to see information only; this does not buy anything.",
    charger_shown: "This is the information-only charger comparison for the confirmed Mac model.",
    charger_closed: "Charger clarification stopped. Laptop requirements remain separate and unconfirmed.",
  },
  taskChoiceLabel: "Choose which task to continue",
  chooseLaptopTask: "Continue laptop shopping",
  chooseChargerTask: "Continue charger information",
  modelChoiceLabel: "Choose the exact Mac model",
  confirmModel: "Confirm model and show charger information",
  changeModel: "Choose a different model",
  stopChargerTask: "Stop charger clarification",
  currentModelLabel: "Selected model:",
};

const SPANISH: ChargerCopy = {
  pageTitle: "Información de cargadores para su Mac",
  skip: "Saltar al paso actual",
  intro: "Elija el modelo exacto de su Mac para ver lo que dice la documentación pública de Apple sobre dos adaptadores de corriente de Apple, cada uno con dos cables.",
  infoOnly: "Esta página solo da información. Estos cargadores no se venden aquí.",
  affiliation:
    "ShopAccess no está afiliado con Apple. Los nombres de productos de Apple se usan solo para identificarlos, y la evidencia procede de las páginas públicas de soporte y de productos de Apple que se indican abajo.",
  claimsNote:
    "Cada fila describe un adaptador con un cable. La carga, la potencia y la carga rápida son afirmaciones separadas, cada una con sus propias fuentes. La potencia y el tipo de conector por sí solos no indican con qué rapidez se carga un Mac.",
  deviceLabel: "Modelo de su Mac",
  devicePlaceholder: "Elija un modelo",
  identifierLabel: "O escriba el identificador de modelo exacto",
  identifierHint: "Por ejemplo Mac14,2. Puede encontrarlo en Información del Sistema o con las páginas de Apple de abajo. Una descripción como un año no basta.",
  identifyAir: "Identificar el modelo de su MacBook Air (en inglés)",
  identifyPro: "Identificar el modelo de su MacBook Pro (en inglés)",
  submit: "Mostrar información de cargadores",
  unidentified:
    "Eso no identifica un solo modelo de Mac en esta comparación. Una descripción como un año o el nombre de una familia puede corresponder a varios modelos con necesidades de carga distintas, así que no se muestra nada. Elija un modelo de la lista o escriba su identificador de modelo exacto.",
  resultsHeading: "Resultados para",
  tableCaption: "Dos adaptadores de corriente de Apple, cada uno con dos cables",
  scrollHint: "Desplace hacia el lado dentro de esta tabla para leer cada afirmación.",
  columns: { configuration: "Adaptador y cable", basic: "Carga", wattage: "Potencia", fast: "Carga rápida" },
  withCable: "con",
  basic: {
    "supported-apple-listed": "Apple indica este adaptador y este cable para este Mac.",
    "supported-apple-fast-charge-list": "La lista de carga rápida de Apple incluye este adaptador y este cable exactos para este Mac, lo que muestra que esta configuración lo carga.",
    "supported-specification": "Admitido según las especificaciones: la guía de carga USB-C de Apple y las especificaciones citadas de este Mac y del adaptador.",
    "supported-manufacturer-listed": "El fabricante indica este adaptador y este cable para este modelo y número de pieza exactos.",
    "supported-pd-profile":
      "Las fuentes citadas dan a este adaptador un voltaje y una corriente USB Power Delivery que coinciden con lo que requiere este modelo y número de pieza exactos, y especifican este cable para esa corriente.",
    unsupported:
      "No admitido en esta configuración: las fuentes establecen que los puertos de carga de este Mac no incluyen el conector de este cable. Esto se refiere solo a este adaptador y este cable, sin convertidores ni otros adaptadores.",
  },
  gap: (gap, ports, cable) => {
    const names = ports.map((p) => PORT_NAMES[p]).join(" y ");
    switch (gap) {
      case "connector-generation-differs":
        return `No establecido: el puerto de alimentación documentado de este Mac es ${names} y este cable termina en ${PORT_NAMES[cable]}; las fuentes capturadas no dicen si encajan.`;
      case "charging-port-for-cable-not-documented":
        return `No establecido: las especificaciones de Apple capturadas para este Mac documentan un puerto de alimentación ${names} y no tratan la carga mediante un ${CABLE_NAMES_ES[cable]}.`;
      case "no-listed-configuration":
        return "No establecido: las páginas de Apple capturadas no indican esta configuración para este Mac, y ninguna especificación de adaptador de esta página la respalda.";
      case "no-evidence":
        return "No establecido: las fuentes capturadas no muestran si esta configuración carga este Mac.";
      // F03 C1 (no Apple; aún no se muestra). Neutral: ninguno dice que una configuración funcione o no.
      case "identity-unverified":
        return "No evaluado: ninguna fuente oficial del fabricante confirma este modelo y número de pieza exactos.";
      case "discrepancy-unresolved":
        return "No establecido: la información citada difiere en algo que este resultado necesita, y la diferencia no se ha resuelto.";
      case "sources-contradict":
        return "No establecido: las fuentes se contradicen en un dato que este resultado necesita, para esta misma configuración.";
      case "family-scoped-only":
        return "No establecido: la información disponible describe una familia de modelos, no este modelo y número de pieza exactos.";
      case "connector-details-unknown":
        return "No establecido: las fuentes no dan todos los datos de este conector (tamaño, voltaje y polaridad), y un conector de barril solo se evalúa con una indicación del fabricante para este modelo exacto.";
      case "pd-profile-not-established":
        return "No establecido: las fuentes no muestran un voltaje y una corriente USB Power Delivery coincidentes para este modelo y adaptador.";
      case "cable-capability-not-established":
        return "No establecido: las fuentes no muestran que este cable esté especificado para la corriente que necesita esta configuración.";
      case "cable-connectors-not-established":
        return "No establecido: las fuentes no muestran qué conector tiene este cable en cada extremo para esta configuración exacta.";
      case "no-manufacturer-listing":
        return "No establecido: el fabricante no indica esta configuración para este modelo, y las especificaciones citadas no la establecen.";
    }
  },
  disclaimer:
    "Cada resultado indica lo que respaldan las fuentes de Apple capturadas. Un resultado desconocido no es una recomendación de compatibilidad. Una configuración que Apple indica no es necesariamente una que Apple haya probado con este modelo exacto.",
  modelNumberNote: "Los números de modelo de los adaptadores proceden de las notas de prueba de Apple, que describen pruebas con otros modelos de Mac.",
  cableRatingUnspecified:
    "Apple indica un cable de carga USB-C para esta configuración, pero la fuente capturada no especifica la potencia nominal que requiere. Este resultado no establece que cualquier cable USB-C sea adecuado.",
  wattage: (verdict, watts, included) => {
    const list = includedList(included, " ", "o", "según la configuración");
    switch (verdict) {
      case "at-or-above-all":
        return `${W(watts ?? 0, " ")} es igual o superior a la potencia del adaptador que Apple incluyó (${list}).`;
      case "at-or-above-some":
        return `${W(watts ?? 0, " ")} es igual o superior a algunos de los adaptadores que Apple incluyó (${list}) e inferior a otros. Apple recomienda al menos la potencia del adaptador recomendado para su Mac para la mejor experiencia de carga.`;
      case "below-all":
        return `${W(watts ?? 0, " ")} es inferior a la potencia del adaptador que Apple incluyó (${list}). Apple recomienda al menos esa potencia para la mejor experiencia de carga.`;
      case "unknown":
        return "Comparación de potencia no establecida.";
    }
  },
  wattageOnly: "Esto compara solo la potencia; no muestra que esta configuración cargue este Mac.",
  fast: {
    listed: "Apple indica esta configuración para la carga rápida.",
    "not-listed": "La lista de carga rápida de Apple capturada no incluye esta configuración.",
  },
  sourceLabel: "Fuentes:",
  cableNote: "Las páginas de la tienda de Apple de ambos adaptadores dicen:",
  cableNoteQuote: "Charging cable sold separately.",
  cableNoteAfter: "(El cable de carga se vende por separado.)",
  sourcesHeading: "Fuentes",
  accessed: (date) => `Consultado el ${date}`,
  otherLanguage: "English",
  unavailable: "La información de cargadores no está disponible en este modo.",
  needsLink: "Consultar información sobre cargadores",
  needsExplanation: "Responda con el identificador exacto del modelo de Mac o elija un modelo abajo. Confirme el modelo en este sitio web para ver una comparación informativa; no se compra nada.",
  handoffLabel: "¿Para qué Mac es?",
  handoffPlaceholder: "Elija un modelo exacto",
  handoffButton: "Mostrar información de cargadores para este Mac",
  conversationLines: {
    charger_task_choice: "¿Qué tarea quiere continuar ahora: buscar un portátil o consultar información sobre cargadores? Elija una para seguir.",
    charger_model: "¿Para qué modelo exacto de Mac es este cargador? Elija un modelo o responda con su identificador exacto.",
    charger_review: "Revise el modelo de Mac identificado. Confirme en este sitio web para ver solo información; no se comprará nada.",
    charger_shown: "Esta es la comparación informativa de cargadores para el modelo de Mac confirmado.",
    charger_closed: "Se detuvo la aclaración sobre cargadores. Los requisitos del portátil siguen separados y sin confirmar.",
  },
  taskChoiceLabel: "Elija qué tarea desea continuar",
  chooseLaptopTask: "Continuar con la búsqueda de un portátil",
  chooseChargerTask: "Continuar con la información de cargadores",
  modelChoiceLabel: "Elija el modelo exacto de Mac",
  confirmModel: "Confirmar el modelo y mostrar información de cargadores",
  changeModel: "Elegir otro modelo",
  stopChargerTask: "Detener la aclaración sobre cargadores",
  currentModelLabel: "Modelo seleccionado:",
};

export function chargerCopy(language: JourneyLanguage): ChargerCopy {
  return language === "es" ? SPANISH : ENGLISH;
}
