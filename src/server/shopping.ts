import { z } from "zod";
import { findMerchantVariant } from "@/lib/catalog/merchant-catalog";
import { isLaptopVariant, laptopProducts, type LaptopMerchantVariant, type ExternalProduct, type MerchantProduct } from "@/lib/catalog/schemas";
import {
  describeAssessment,
  explainAssessmentSafely,
  formatAdvisoryFailureDiagnostic,
  suggestProductsSafely,
  type AdvisoryFailureDiagnostic,
  type EligibleAdvisoryProduct,
  type InterpretationOutput,
  type SafeExplanation,
} from "@/lib/providers/ai";
import {
  assessReadiness,
  evidenceFromMerchantVariant,
  INTENDED_USES,
  type EvidenceItem,
  type EvidenceQuality,
  type FactKey,
  type FactorKey,
  type FactorOutcome,
  type IntendedUse,
  type ReadinessAssessment,
  type ReadinessStatus,
} from "@/lib/readiness/engine";
import {
  assessAiHardwareEvidence,
  evidenceFromAiLaptopVariant,
  type AiHardwareEvidenceAssessment,
} from "@/lib/readiness/ai-hardware";
import type { NeedsNotice } from "@/lib/i18n/needs-notice";
import { chargerTrackFor, deleteChargerTracks, laptopOutputAllowed, type ChargerTrack } from "@/lib/session/charger-clarification";
import { readConversation, type ConversationState } from "@/lib/session/conversation";
import type { Session } from "@/lib/session/service";
import {
  claimRecommendation,
  finishRecommendation,
  needsDraftsFor,
  type JourneyLanguage,
  type NeedsDraft,
  type RetainedRecommendation,
} from "@/lib/session/store";
import type { Runtime } from "./runtime";
import { withAdvisorySession } from "./advisory-limits";

export const USE_LABELS: Record<IntendedUse, string> = {
  programming: "Programming",
  schoolwork: "Schoolwork",
  general_productivity: "General productivity",
};

/** Query-string preferences. Budget is whole US dollars as typed by the shopper. */
const PreferencesSchema = z.strictObject({
  use: z.enum(INTENDED_USES),
  budget: z.string().regex(/^[1-9][0-9]{1,4}$/),
});

export interface ShopperPreferences {
  readonly use: IntendedUse;
  readonly budgetCents: number;
  readonly budgetDollars: string;
}

export function parsePreferences(use: unknown, budget: unknown): ShopperPreferences | null {
  const parsed = PreferencesSchema.safeParse({ use, budget });
  if (!parsed.success) return null;
  return { use: parsed.data.use, budgetCents: Number(parsed.data.budget) * 100, budgetDollars: parsed.data.budget };
}

export function preferencesQuery(preferences: ShopperPreferences): string {
  return new URLSearchParams({ use: preferences.use, budget: preferences.budgetDollars }).toString();
}

export interface AssessedVariant {
  readonly product: MerchantProduct;
  readonly variant: LaptopMerchantVariant;
  readonly assessment: ReadinessAssessment;
  /** AI hardware evidence only; never a compatibility verdict or purchase permission. */
  readonly aiHardware: AiHardwareEvidenceAssessment;
  readonly explanation: SafeExplanation | null;
  /** Whether a quote can be requested. Depends only on catalog availability, never on the readiness label or on AI output. */
  readonly quotable: boolean;
}

export interface AdvisoryRecommendation {
  readonly productId: string;
  readonly variantId: string;
  readonly title: string;
  readonly label: string;
  readonly unitAmountCents: number;
  readonly currency: "USD";
}

export interface ShoppingView {
  readonly preferences: ShopperPreferences;
  readonly assistantMessage: string | null;
  readonly merchantName: string;
  readonly variants: readonly AssessedVariant[];
  readonly external: readonly ExternalProduct[];
  /** Present only when the external advisory provider built this view. */
  readonly recommendations?: readonly AdvisoryRecommendation[];
  /** Present only on the external path. The local path keeps the panel's existing label. */
  readonly explanationLabel?: string;
  /** Which assistant supplied an external-mode suggestion; null when no assistant call was needed. */
  readonly suggestionSource?: SuggestionSource | null;
}

const EXTERNAL_EXPLANATION_LABEL = "Assessment summary (deterministic, advisory only): ";
const SUITABLE_RECOMMENDATIONS = "These catalog items meet the stated use and budget.";
const NO_CATALOG_MATCH = "No catalog item meets this use and budget.";
const NO_SUGGESTION_MATCH = "No suggestion matched a catalog item that meets this use and budget.";

/** Process-local. A restart drops the recorded producer. It is not part of the snapshot. */
/** `fallback`: live AI failed or was limited, so the local assistant made this suggestion. Process-local. */
export type SuggestionSource = "mock" | "model" | "fallback";

const suggestionSources = new WeakMap<object, Map<string, SuggestionSource>>();

function suggestionSourceKey(sessionId: string, draftId: string, version: number): string {
  return `${sessionId}:${draftId}:${version}`;
}

function rememberSuggestionSource(store: object, sessionId: string, draftId: string, version: number, source: SuggestionSource): void {
  const sources = suggestionSources.get(store) ?? new Map<string, SuggestionSource>();
  sources.set(suggestionSourceKey(sessionId, draftId, version), source);
  suggestionSources.set(store, sources);
}

export function readSuggestionSource(store: object, sessionId: string, draftId: string, version: number): SuggestionSource | null {
  return suggestionSources.get(store)?.get(suggestionSourceKey(sessionId, draftId, version)) ?? null;
}

const STATUS_ORDER = { READY: 0, READY_WITH_CAVEATS: 1, INSUFFICIENT_EVIDENCE: 2, NOT_RECOMMENDED: 3 } as const;

/**
 * Builds the recommendations page. Assessments are always the deterministic engine.
 * The local assistant explains each variant and suggests once. The external provider
 * is asked for one suggestion and is not asked to explain or to start a checkout.
 */
export async function buildShoppingView(runtime: Runtime, preferences: ShopperPreferences, sessionId: string): Promise<ShoppingView> {
  const now = runtime.clock();
  const stated = (fact: "budgetCents" | "intendedUse", value: number | string): EvidenceItem => ({
    fact,
    value,
    source: "shopper_stated",
    sourceRef: "entered by the shopper on this page",
    observedAt: now.toISOString(),
  });

  const variants: AssessedVariant[] = [];
  for (const product of laptopProducts(runtime.catalog)) {
    for (const variant of product.variants) {
      const result = assessReadiness(
        {
          subject: { productId: product.productId, variantId: variant.variantId, catalogRevision: runtime.catalog.revision },
          evidence: [
            stated("budgetCents", preferences.budgetCents),
            stated("intendedUse", preferences.use),
            ...evidenceFromMerchantVariant(variant, runtime.catalog.revision, now),
          ],
        },
        now,
      );
      if (!result.ok) continue;
      const explanation = await explanationFor(runtime, result.value);
      variants.push({
        product,
        variant,
        assessment: result.value,
        aiHardware: assessAiHardwareEvidence(
          "unspecified_ai",
          evidenceFromAiLaptopVariant(variant, runtime.catalog.revision, now),
          now,
        ),
        explanation,
        quotable: variant.availability === "IN_STOCK",
      });
    }
  }
  variants.sort(
    (a, b) => STATUS_ORDER[a.assessment.status] - STATUS_ORDER[b.assessment.status] || a.variant.unitAmountCents - b.variant.unitAmountCents,
  );

  const external = runtime.advisory === "external";
  const shopperMessage = `Laptop for ${USE_LABELS[preferences.use]}`;
  const discovered = await runtime.discovery.search("");
  if (!external) {
    const suggestion = await suggestProductsSafely(runtime.ai, runtime.catalog, shopperMessage);
    return {
      preferences,
      assistantMessage: suggestion.ok ? suggestion.value.message : null,
      merchantName: runtime.catalog.merchant.displayName,
      variants,
      external: discovered.products,
    };
  }

  const eligible = variants.filter((entry) => variantQualifies(entry, preferences.budgetCents));
  if (eligible.length === 0) {
    return externalView(preferences, runtime, variants, discovered.products, NO_CATALOG_MATCH, [], null);
  }
  const suitability = {
    intendedUse: preferences.use,
    budgetCents: preferences.budgetCents,
    products: eligible.map(eligibleProduct),
  };
  let source: SuggestionSource = "model";
  let suggestion = await withAdvisorySession(sessionId, () =>
    suggestProductsSafely(runtime.ai, runtime.catalog, shopperMessage, recordExternalAdvisoryFailure, suitability),
  );
  if (!suggestion.ok) {
    suggestion = await suggestProductsSafely(runtime.localAi, runtime.catalog, shopperMessage, undefined, suitability);
    source = "fallback";
  }
  if (!suggestion.ok) return externalView(preferences, runtime, variants, discovered.products, null, [], source);
  const seen = new Set<string>();
  const matched = suggestion.value.references.filter((reference) => {
    const key = `${reference.productId}:${reference.variantId}`;
    if (seen.has(key)) return false;
    const qualifies = eligible.some((entry) => entry.product.productId === reference.productId && entry.variant.variantId === reference.variantId);
    if (!qualifies) return false;
    seen.add(key);
    return true;
  });
  if (matched.length === 0) return externalView(preferences, runtime, variants, discovered.products, NO_SUGGESTION_MATCH, [], source);
  return externalView(preferences, runtime, variants, discovered.products, SUITABLE_RECOMMENDATIONS, recommendationsFrom(runtime, matched), source);
}

function externalView(
  preferences: ShopperPreferences,
  runtime: Runtime,
  variants: readonly AssessedVariant[],
  external: ShoppingView["external"],
  assistantMessage: string | null,
  recommendations: readonly AdvisoryRecommendation[],
  suggestionSource: SuggestionSource | null,
): ShoppingView {
  return {
    preferences,
    assistantMessage,
    merchantName: runtime.catalog.merchant.displayName,
    variants,
    external,
    recommendations,
    explanationLabel: EXTERNAL_EXPLANATION_LABEL,
    suggestionSource,
  };
}

function variantQualifies(entry: AssessedVariant, budgetCents: number): boolean {
  const status = entry.assessment.status;
  return (status === "READY" || status === "READY_WITH_CAVEATS") && entry.variant.unitAmountCents <= budgetCents;
}

function eligibleProduct(entry: AssessedVariant): EligibleAdvisoryProduct {
  return {
    productId: entry.product.productId,
    variantId: entry.variant.variantId,
    title: entry.product.title,
    description: entry.product.description,
    unitAmountCents: entry.variant.unitAmountCents,
    currency: entry.variant.currency,
    availability: entry.variant.availability,
    ramGb: entry.variant.specs.ramGb,
    storageGb: entry.variant.specs.storageGb,
    weightKg: entry.variant.specs.weightKg,
    assessmentStatus: entry.assessment.status,
    assessmentFactors: entry.assessment.factors.map((factor) => ({ factor: factor.factor, outcome: factor.outcome })),
  };
}

function recordExternalAdvisoryFailure(diagnostic: AdvisoryFailureDiagnostic): void {
  const line = formatAdvisoryFailureDiagnostic(diagnostic);
  if (line) console.warn(line);
}

async function explanationFor(runtime: Runtime, assessment: ReadinessAssessment): Promise<SafeExplanation | null> {
  if (runtime.advisory === "external") {
    return {
      status: assessment.status,
      explanation: describeAssessment(assessment),
      source: "deterministic_fallback",
      authorizesPurchase: false,
    };
  }
  const explained = await explainAssessmentSafely(runtime.ai, assessment, "Explain this assessment in plain language.");
  return explained.ok ? explained.value : null;
}

function recommendationsFrom(
  runtime: Runtime,
  references: readonly { productId: string; variantId: string }[],
): AdvisoryRecommendation[] {
  const recommendations: AdvisoryRecommendation[] = [];
  for (const reference of references) {
    const entry = findMerchantVariant(runtime.catalog, reference.productId, reference.variantId);
    if (!entry || !isLaptopVariant(entry.variant)) continue;
    recommendations.push({
      productId: entry.product.productId,
      variantId: entry.variant.variantId,
      title: entry.product.title,
      label: entry.variant.label,
      unitAmountCents: entry.variant.unitAmountCents,
      currency: entry.variant.currency,
    });
  }
  return recommendations;
}

const BUDGET_CUES = ["less than", "presupuesto", "dólares", "dolares", "máximo", "maximo", "budget", "spend", "under"];
const SPEC_CUES = ["pulgadas", "inches", "inch", "núcleos", "nucleos", "cores", "core", "unidades", "quantity", "laptops", "laptop", "gb", "kg"];

export interface BudgetReading {
  readonly candidate: string | null;
  readonly ambiguous: boolean;
}

function boundary(char: string): boolean {
  return char === "" || !/[a-záéíóúñ]/i.test(char);
}

function cueDistance(left: string, right: string, phrases: readonly string[]): number | null {
  let best: number | null = null;
  const consider = (haystack: string, distanceAt: (at: number, phrase: string) => number) => {
    const lower = haystack.toLowerCase();
    for (const phrase of phrases) {
      const needle = phrase.toLowerCase();
      let from = 0;
      while (from < lower.length) {
        const at = lower.indexOf(needle, from);
        if (at === -1) break;
        const before = at === 0 ? "" : lower[at - 1];
        const after = lower[at + needle.length] ?? "";
        if (boundary(before) && boundary(after)) {
          const distance = distanceAt(at, needle);
          if (best === null || distance < best) best = distance;
        }
        from = at + 1;
      }
    }
  };
  consider(left, (at, phrase) => left.length - (at + phrase.length));
  consider(right, (at) => at);
  return best;
}

/** Parse Spanish whole-number words only; no AI output can authorize a budget. */
const SPANISH_SMALL: Readonly<Record<string, number>> = {
 cero:0, un:1, uno:1, una:1, dos:2, tres:3, cuatro:4, cinco:5, seis:6, siete:7, ocho:8, nueve:9,
 diez:10, once:11, doce:12, trece:13, catorce:14, quince:15, dieciseis:16, diecisiete:17, dieciocho:18, diecinueve:19,
 veinte:20, veintiuno:21, veintiun:21, veintidos:22, veintitres:23, veinticuatro:24, veinticinco:25, veintiseis:26, veintisiete:27, veintiocho:28, veintinueve:29,
 treinta:30, cuarenta:40, cincuenta:50, sesenta:60, setenta:70, ochenta:80, noventa:90,
};
const SPANISH_HUNDREDS: Readonly<Record<string, number>> = {cien:100,ciento:100,doscientos:200,trescientos:300,cuatrocientos:400,quinientos:500,seiscientos:600,setecientos:700,ochocientos:800,novecientos:900};
function spanishUnderHundred(words: readonly string[]): number | null {
 if(words.length===1)return SPANISH_SMALL[words[0]] ?? null;
 if(words.length===3 && words[1]==="y") {
  const tens=SPANISH_SMALL[words[0]],unit=SPANISH_SMALL[words[2]];
  if(tens>=30 && tens%10===0 && unit>=1 && unit<=9)return tens+unit;
 }
 return null;
}
function spanishUnderThousand(words: readonly string[]): number | null {
 if(!words.length)return 0;
 const hundred=SPANISH_HUNDREDS[words[0]];
 if(hundred===undefined)return spanishUnderHundred(words);
 if(words[0]==="cien")return words.length===1 ? 100 : null;
 if(words.length===1)return words[0]==="ciento" ? null : hundred;
 const rest=spanishUnderHundred(words.slice(1));
 return rest!==null && rest>0 ? hundred+rest : null;
}
function spanishNumber(words: readonly string[]): number | null {
 const at=words.indexOf("mil");
 if(at===-1)return spanishUnderThousand(words);
 if(words.lastIndexOf("mil")!==at)return null;
 const thousands=at===0 ? 1 : spanishUnderHundred(words.slice(0,at));
 const rest=spanishUnderThousand(words.slice(at+1));
 return thousands!==null && thousands>0 && rest!==null ? thousands*1000+rest : null;
}
function normalizeSpanishBudgetWords(text: string): { text: string; ambiguous: boolean } {
 const normalized=text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
 const tokens=[...Object.keys(SPANISH_SMALL),...Object.keys(SPANISH_HUNDREDS),"mil","millon","millones","coma","punto","menos"];
 const word=`(?:${tokens.join("|")})`;
 const pattern=new RegExp(`\\b${word}(?:\\s+(?:y\\s+)?${word})*\\b`,"g");
 let ambiguous=false;
 const converted=normalized.replace(pattern,(phrase:string,at:number)=>{
  const left=normalized.slice(Math.max(0,at-48),at),right=normalized.slice(at+phrase.length,at+phrase.length+48);
  const budgetDistance=cueDistance(left,right,BUDGET_CUES),specDistance=cueDistance(left,right,SPEC_CUES);
  if(budgetDistance===null || (specDistance!==null && specDistance<budgetDistance))return phrase;
  const value=spanishNumber(phrase.split(/\s+/));
  if(value!==null && value<10)return phrase;
  // Never salvage a partial number from malformed, fractional or mixed digit/word input.
  if(value===null || value>99999 || /[\d.,-]\s*$/.test(left) || /^\s*(?:\d|[.,]\s*(?:\d|\w))/.test(right)) {ambiguous=true;return phrase;}
  return String(value);
 });
 return {text:converted,ambiguous};
}

const ENGLISH_SMALL: Readonly<Record<string, number>> = {
 zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,
 twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,
};
function englishUnderHundred(words: readonly string[]): number | null {
 if(words.length===1)return ENGLISH_SMALL[words[0]] ?? null;
 if(words.length===2){const tens=ENGLISH_SMALL[words[0]],unit=ENGLISH_SMALL[words[1]];if(tens>=20 && tens%10===0 && unit>=1 && unit<=9)return tens+unit;}
 return null;
}
function englishUnderThousand(words: readonly string[]): number | null {
 if(!words.length)return 0;
 if(words[1]!=="hundred")return englishUnderHundred(words);
 const hundreds=ENGLISH_SMALL[words[0]];
 if(!(hundreds>=1 && hundreds<=9))return null;
 if(words.length===2)return hundreds*100;
 const rest=englishUnderHundred(words.slice(words[2]==="and" ? 3 : 2));
 return rest!==null && rest>0 ? hundreds*100+rest : null;
}
function englishNumber(words: readonly string[]): number | null {
 const at=words.indexOf("thousand");
 if(at===-1)return englishUnderThousand(words);
 if(words.lastIndexOf("thousand")!==at)return null;
 const thousands=englishUnderHundred(words.slice(0,at));
 const suffix=words.slice(at+1);
 const rest=englishUnderThousand(suffix[0]==="and" ? suffix.slice(1) : suffix);
 if(suffix.length===1 && suffix[0]==="and")return null;
 return thousands!==null && thousands>0 && rest!==null ? thousands*1000+rest : null;
}
function normalizeEnglishBudgetWords(text: string): { text: string; ambiguous: boolean } {
 const tokens=[...Object.keys(ENGLISH_SMALL),"hundred","thousand","million","point","minus","negative"];
 const word=`(?:${tokens.join("|")})`;
 const pattern=new RegExp(`\\b${word}(?:[\\s-]+(?:${word}|and))*\\b`,"gi");
 let ambiguous=false;
 const converted=text.replace(pattern,(phrase:string,at:number)=>{
  const left=text.slice(Math.max(0,at-48),at),right=text.slice(at+phrase.length,at+phrase.length+48);
  const budgetDistance=cueDistance(left,right,[...BUDGET_CUES,"dollars"]),specDistance=cueDistance(left,right,SPEC_CUES);
  if(budgetDistance===null || (specDistance!==null && specDistance<budgetDistance))return phrase;
  const value=englishNumber(phrase.toLowerCase().split(/[\s-]+/));
  if(value!==null && value<10)return phrase;
  if(value===null || value>99999 || /[\d.,-]\s*$/.test(left) || /^\s*(?:\d|[.,]\s*(?:\d|\w))/.test(right)){ambiguous=true;return phrase;}
  return String(value);
 });
 return {text:converted,ambiguous};
}

/** A clean budget is a 2–5 digit whole-dollar amount with a budget cue closer than any size or quantity cue. */
export function readBudgetFromText(text: string): BudgetReading {
  const english = normalizeEnglishBudgetWords(text);
  const spanish = normalizeSpanishBudgetWords(english.text);
  text = spanish.text;
  // A sentence-ending period is punctuation; a decimal point before digits remains invalid.
  text = text.replace(/(?<=\d)\.(?=\s|$)/g, " ");
  // A comma before prose/end is punctuation, not part of a numeric amount.
  text = text.replace(/(?<=\d),(?=\s+[a-záéíóúñ]|$)/gi, " ");
  // Normalize only complete US-style thousands groups; never split malformed/decimal amounts.
  text = text.replace(/(?<![\d.,])([1-9][0-9]{0,2}(?:,[0-9]{3})+)(?![\d.,])/g, value => value.replaceAll(",", ""));
  const pattern = /(^|[^\d.,])(\$)?\s*([1-9][0-9]{1,4})(?![\d.,])/g;
  const candidates = new Set<string>();
  let ambiguous = english.ambiguous || spanish.ambiguous;
  for (const match of text.matchAll(pattern)) {
    const value = match[3];
    if (!value || match.index === undefined) continue;
    const numberAt = match.index + match[0].length - value.length;
    const left = text.slice(Math.max(0, numberAt - 48), numberAt);
    const right = text.slice(numberAt + value.length, numberAt + value.length + 48);
    const budgetDistance = match[2] === "$" ? 0 : cueDistance(left, right, BUDGET_CUES);
    const specDistance = cueDistance(left, right, SPEC_CUES);
    if (budgetDistance === null) continue;
    if (specDistance !== null && specDistance < budgetDistance) continue;
    if (specDistance !== null && specDistance === budgetDistance) {
      ambiguous = true;
      continue;
    }
    candidates.add(value);
  }
  if (ambiguous || candidates.size > 1) return { candidate: null, ambiguous: true };
  return { candidate: [...candidates][0] ?? null, ambiguous: false };
}

export function settleShopperText(text: string, model: InterpretationOutput | "malformed" | "unavailable"): {
  readonly prefilledUse: IntendedUse | null;
  readonly prefilledBudgetDollars: string | null;
  readonly notice: NeedsNotice;
} {
  if (model === "malformed" || model === "unavailable") {
    return { prefilledUse: null, prefilledBudgetDollars: null, notice: model === "malformed" ? "malformed" : "unavailable" };
  }
  const reading = readBudgetFromText(text);
  const modelUse = model.understoodUse;
  const modelBudget = model.budgetDollars !== null && model.budgetDollars === reading.candidate ? model.budgetDollars : null;
  const budget = reading.ambiguous ? null : (modelBudget ?? reading.candidate);
  if (reading.ambiguous) return { prefilledUse: modelUse, prefilledBudgetDollars: null, notice: "ambiguous" };
  if (modelUse === null) return { prefilledUse: null, prefilledBudgetDollars: budget, notice: "missing_use" };
  if (budget === null) return { prefilledUse: modelUse, prefilledBudgetDollars: null, notice: "missing_budget" };
  return { prefilledUse: modelUse, prefilledBudgetDollars: budget, notice: "review" };
}

export function mergeInterpretedNeeds(
  typedUse: IntendedUse | null,
  typedBudget: string | null,
  settled: { readonly prefilledUse: IntendedUse | null; readonly prefilledBudgetDollars: string | null; readonly notice: NeedsNotice },
): { readonly prefilledUse: IntendedUse | null; readonly prefilledBudgetDollars: string | null; readonly notice: NeedsNotice } {
  if (settled.notice === "malformed" || settled.notice === "unavailable") {
    return { prefilledUse: typedUse, prefilledBudgetDollars: typedBudget, notice: settled.notice };
  }
  if (settled.notice === "ambiguous" && typedBudget === null) {
    return { prefilledUse: typedUse ?? settled.prefilledUse, prefilledBudgetDollars: null, notice: "ambiguous" };
  }
  const prefilledUse = typedUse ?? settled.prefilledUse;
  const prefilledBudgetDollars = typedBudget ?? settled.prefilledBudgetDollars;
  if (prefilledUse === null) return { prefilledUse: null, prefilledBudgetDollars, notice: "missing_use" };
  if (prefilledBudgetDollars === null) return { prefilledUse, prefilledBudgetDollars: null, notice: "missing_budget" };
  return { prefilledUse, prefilledBudgetDollars, notice: "review" };
}

const FAILURE_NOTICES = ["malformed", "unavailable"] as const;
export type FailureNoticeCode = (typeof FAILURE_NOTICES)[number];

/** An allowlisted interpretation failure. Any other query value is omitted. */
export function failureNoticeCode(value: string | null | undefined): FailureNoticeCode | null {
  return value === "malformed" || value === "unavailable" ? value : null;
}

/**
 * The draft's own notice wins. A query notice is a fallback only when this
 * live session has no draft, so the notice does not invent a draft.
 */
export function visibleNeedsNotice(input: {
  readonly sessionLive: boolean;
  readonly draft: { readonly notice: NeedsNotice | null } | null;
  readonly queryNotice: string | null | undefined;
}): NeedsNotice | null {
  if (!input.sessionLive) return null;
  if (input.draft) return input.draft.notice;
  return failureNoticeCode(input.queryNotice);
}

export interface GuidedAssessmentFactor {
  readonly factor: FactorKey;
  readonly outcome: FactorOutcome;
  readonly reason: string;
  readonly evidenceQuality: EvidenceQuality;
  readonly facts: readonly { readonly fact: FactKey; readonly value: number | string }[];
}

export interface GuidedCatalogLine {
  readonly productId: string;
  readonly variantId: string;
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly unitAmountCents: number;
  readonly currency: "USD";
  readonly quotable: boolean;
  readonly status: ReadinessStatus;
  readonly explanation: string;
  readonly factors: readonly GuidedAssessmentFactor[];
}

type GuidedAssessed = AssessedVariant & {
  productId: string;
  variantId: string;
  title: string;
  description: string;
  label: string;
  unitAmountCents: number;
  currency: "USD";
  quotable: boolean;
  status: ReadinessStatus;
};

function assessGuidedVariants(runtime: Runtime, preferences: ShopperPreferences): GuidedAssessed[] {
  const now = runtime.clock();
  const stated = (fact: "budgetCents" | "intendedUse", value: number | string): EvidenceItem => ({
    fact,
    value,
    source: "shopper_stated",
    sourceRef: "confirmed by the shopper for this draft",
    observedAt: now.toISOString(),
  });
  const lines: GuidedAssessed[] = [];
  for (const product of laptopProducts(runtime.catalog)) {
    for (const variant of product.variants) {
      const result = assessReadiness(
        {
          subject: { productId: product.productId, variantId: variant.variantId, catalogRevision: runtime.catalog.revision },
          evidence: [
            stated("budgetCents", preferences.budgetCents),
            stated("intendedUse", preferences.use),
            ...evidenceFromMerchantVariant(variant, runtime.catalog.revision, now),
          ],
        },
        now,
      );
      if (!result.ok) continue;
      lines.push({
        product,
        variant,
        assessment: result.value,
        aiHardware: assessAiHardwareEvidence(
          "unspecified_ai",
          evidenceFromAiLaptopVariant(variant, runtime.catalog.revision, now),
          now,
        ),
        explanation: null,
        productId: product.productId,
        variantId: variant.variantId,
        title: product.title,
        description: product.description,
        label: variant.label,
        unitAmountCents: variant.unitAmountCents,
        currency: variant.currency,
        quotable: variant.availability === "IN_STOCK",
        status: result.value.status,
      });
    }
  }
  return lines;
}

/**
 * One suggestion for a confirmed draft. Eligible variants are chosen before the request.
 * No eligible variant means no provider call. The model's prose is not kept.
 */
export async function recommendConfirmedNeeds(runtime: Runtime, preferences: ShopperPreferences): Promise<RetainedRecommendation | "failed"> {
  return (await recommendWithSource(runtime, preferences)).outcome;
}

/**
 * One suggestion for a confirmed brief. With live AI, a failed or limited suggestion falls back to the deterministic
 * local assistant and is labelled `fallback`; it is never presented as a live AI response. The server-assessed cards
 * and purchase-permission checks do not depend on this result.
 */
async function recommendWithSource(
  runtime: Runtime,
  preferences: ShopperPreferences,
): Promise<{ outcome: RetainedRecommendation | "failed"; source: SuggestionSource }> {
  const primary: SuggestionSource = runtime.ai.suggestionSource === "model" ? "model" : "mock";
  const lines = assessGuidedVariants(runtime, preferences);
  const eligible = lines.filter((line) => variantQualifies(line, preferences.budgetCents));
  if (eligible.length === 0) return { outcome: { assistantMessage: NO_CATALOG_MATCH, recommendations: [] }, source: primary };
  const suitability = { intendedUse: preferences.use, budgetCents: preferences.budgetCents, products: eligible.map(eligibleProduct) };
  const message = `Laptop for ${USE_LABELS[preferences.use]}`;
  let source: SuggestionSource = primary;
  let suggestion = await suggestProductsSafely(runtime.ai, runtime.catalog, message, recordExternalAdvisoryFailure, suitability);
  if (!suggestion.ok && runtime.advisory === "external") {
    suggestion = await suggestProductsSafely(runtime.localAi, runtime.catalog, message, undefined, suitability);
    source = "fallback";
  }
  if (!suggestion.ok) return { outcome: "failed", source };
  return { outcome: matchedRecommendation(runtime, eligible, suggestion.value.references), source };
}

function matchedRecommendation(
  runtime: Runtime,
  eligible: readonly GuidedAssessed[],
  references: readonly { readonly productId: string; readonly variantId: string }[],
): RetainedRecommendation {
  const suggestion = { value: { references } };
  const allowed = new Set(eligible.map((line) => `${line.productId}:${line.variantId}`));
  const seen = new Set<string>();
  const matched = suggestion.value.references.filter((reference) => {
    const key = `${reference.productId}:${reference.variantId}`;
    if (seen.has(key) || !allowed.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (matched.length === 0) return { assistantMessage: NO_SUGGESTION_MATCH, recommendations: [] };
  return { assistantMessage: SUITABLE_RECOMMENDATIONS, recommendations: recommendationsFrom(runtime, matched) };
}

/**
 * Loads the session draft and, when it is confirmed and this process has not already claimed a
 * recommendation, asks once. A completed or failed claim is returned as stored. A missing draft
 * is not rebuilt. An expired draft is deleted and never reconstructed. After the provider returns,
 * a dead session or a replaced version is not written.
 */
export async function loadNeedsJourney(
  runtime: Runtime,
  session: Session,
): Promise<{
  draft: NeedsDraft | null;
  lines: readonly GuidedCatalogLine[];
  expiredDraft: boolean;
  suggestionSource: SuggestionSource | null;
  listings: ReturnType<Runtime["channel3"]["read"]>;
  conversation: ConversationState | null;
  chargerTrack: ChargerTrack | null;
}> {
  const now = runtime.clock().getTime();
  const conversationFor = (draftId: string | null): ConversationState | null => {
    if (!draftId) return null;
    const state = readConversation(runtime.store, session.id);
    return state && state.draftId === draftId ? state : null;
  };
  const existing = needsDraftsFor(runtime.store).get(session.id) ?? null;
  if (existing && now >= existing.expiresAtMs) {
    // Durable deletion of exactly the observed, still-expired draft. A replacement published meanwhile stays.
    await runtime.durable.change((host) => {
      const published = needsDraftsFor(host).get(session.id);
      const decisionNow = runtime.clock().getTime();
      if (published && published.draftId === existing.draftId && published.version === existing.version && decisionNow >= published.expiresAtMs) {
        needsDraftsFor(host).delete(session.id);
        deleteChargerTracks(host, [session.id]);
      }
    });
    return { draft: null, lines: [], expiredDraft: true, suggestionSource: null, listings: null, conversation: null, chargerTrack: null };
  }
  const trackFor = (draftId: string | null): ChargerTrack | null => draftId ? chargerTrackFor(runtime.store, session.id, draftId) : null;
  if (!existing || !existing.confirmedUse || !existing.confirmedBudgetDollars) {
    return { draft: existing, lines: [], expiredDraft: false, suggestionSource: null, listings: null, conversation: conversationFor(existing?.draftId ?? null), chargerTrack: trackFor(existing?.draftId ?? null) };
  }
  // The claim is durable before the provider starts, and the provider input is taken from the saved claim.
  const claim = await runtime.durable.change((host) => {
    const decisionNow = runtime.clock().getTime();
    if (!runtime.checkout.sessionIsLive(session.id)) return { claimed: false as const, draft: null, blocked: true as const };
    const current = needsDraftsFor(host).get(session.id) ?? null;
    if (!current || decisionNow >= current.expiresAtMs || current.draftId !== existing.draftId || current.version !== existing.version) {
      return { claimed: false as const, draft: null, blocked: true as const };
    }
    const track = chargerTrackFor(host, session.id, current.draftId);
    if (!laptopOutputAllowed(track)) return { claimed: false as const, draft: current, blocked: true as const };
    const result = claimRecommendation(host, session.id, current.draftId, current.version, decisionNow);
    return result === "claimed"
      ? { claimed: true as const, draft: needsDraftsFor(host).get(session.id) ?? null, blocked: false as const }
      : { claimed: false as const, draft: needsDraftsFor(host).get(session.id) ?? current, blocked: false as const };
  });
  if (claim.claimed && claim.draft) {
    const claimedDraft = claim.draft;
    const preferences = parsePreferences(claimedDraft.confirmedUse, claimedDraft.confirmedBudgetDollars);
    // The suggestion runs in this session's advisory scope, so any AI call reserves against the call limits.
    const recommended = preferences ? await withAdvisorySession(session.id, () => recommendWithSource(runtime, preferences)) : null;
    const outcome = recommended ? recommended.outcome : "failed";
    {
      // Rechecked against the live session, claimed draft id and version inside the save-first decision.
      const written = await runtime.durable.change((host) => {
        const after = runtime.clock().getTime();
        if (!runtime.checkout.sessionIsLive(session.id)) return null;
        finishRecommendation(
          host,
          session.id,
          claimedDraft.draftId,
          claimedDraft.version,
          outcome === "failed" ? "failed" : "completed",
          outcome === "failed" ? null : outcome,
          after,
        );
        return needsDraftsFor(host).get(session.id);
      });
      if (
        outcome !== "failed" &&
        outcome.assistantMessage !== NO_CATALOG_MATCH &&
        written?.recommendationClaim === "completed" &&
        written.draftId === claimedDraft.draftId &&
        written.version === claimedDraft.version
      ) {
        rememberSuggestionSource(
          runtime.store,
          session.id,
          written.draftId,
          written.version,
          recommended?.source ?? "mock",
        );
      }
    }
  }
  const draft = needsDraftsFor(runtime.store).get(session.id) ?? null;
  const chargerTrack = trackFor(draft?.draftId ?? null);
  const outputAllowed = laptopOutputAllowed(chargerTrack);
  const listings = outputAllowed && draft?.confirmedUse && draft.confirmedBudgetDollars ? runtime.channel3.read(session.id, draft.draftId, draft.version) : null;
  const suggestionSource =
    draft?.recommendationClaim === "completed" ? readSuggestionSource(runtime.store, session.id, draft.draftId, draft.version) : null;
  // The cards are the server's own assessment, so they render for any confirmed brief, including when the suggestion
  // failed; the suggestions section reports that separately.
  if (!draft?.confirmedUse || !draft.confirmedBudgetDollars) {
    return { draft, lines: [], expiredDraft: false, suggestionSource, listings, conversation: conversationFor(draft?.draftId ?? null), chargerTrack };
  }
  const preferences = parsePreferences(draft.confirmedUse, draft.confirmedBudgetDollars);
  if (!preferences || !outputAllowed) return { draft, lines: [], expiredDraft: false, suggestionSource, listings, conversation: conversationFor(draft.draftId), chargerTrack };
  return {
    draft,
    suggestionSource,
    listings,
    lines: assessGuidedVariants(runtime, preferences).map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      title: line.title,
      description: line.description,
      label: line.label,
      unitAmountCents: line.unitAmountCents,
      currency: line.currency,
      quotable: line.quotable,
      status: line.status,
      explanation: describeAssessment(line.assessment),
      factors: line.assessment.factors.map((factor) => ({
        factor: factor.factor,
        outcome: factor.outcome,
        reason: factor.reason,
        evidenceQuality: factor.evidenceQuality,
        facts: factor.evidence.map((item) => ({ fact: item.fact, value: item.value })),
      })),
    })),
    expiredDraft: false,
    conversation: conversationFor(draft.draftId),
    chargerTrack,
  };
}

export type { JourneyLanguage };

