import type { JourneyLanguage } from "./language";

const COPY = {
  "en": {
    "sectionLabel": "Adapter budget",
    "disclosure": "This budget is for the adapter only. The cable is sold separately. The adapter alone does not complete the setup. Confirming does not authorize a purchase.",
    "amountLabel": "Adapter budget in whole US dollars",
    "amountHint": "From 10 to 99999. Saved separately from the laptop budget.",
    "reviewButton": "Review this budget",
    "summaryLabel": "Adapter budget",
    "unconfirmed": "not confirmed",
    "confirmed": "confirmed",
    "confirmButton": "Confirm this adapter budget"
  },
  "es": {
    "sectionLabel": "Presupuesto para el adaptador",
    "disclosure": "Este presupuesto es solo para el adaptador. El cable se vende por separado. El adaptador solo no completa la configuración. Confirmarlo no autoriza una compra.",
    "amountLabel": "Presupuesto del adaptador en dólares estadounidenses enteros",
    "amountHint": "De 10 a 99999. Se guarda aparte del presupuesto del portátil.",
    "reviewButton": "Revisar este presupuesto",
    "summaryLabel": "Presupuesto del adaptador",
    "unconfirmed": "sin confirmar",
    "confirmed": "confirmado",
    "confirmButton": "Confirmar este presupuesto del adaptador"
  }
} as const;

export function chargerBudgetCopy(language: JourneyLanguage) { return COPY[language]; }
