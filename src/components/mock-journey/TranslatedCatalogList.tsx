import { Icon } from "../Icon";
import { AiCompatibilityDisclosure } from "@/components/AiCompatibilityDisclosure";
import { aiRecommendationUnverified } from "@/lib/readiness/ai-hardware";
import { productPhoto } from "@/lib/catalog/product-photos";
import { ProductPhotoCredit } from "../ProductPhotoCredit";
import { DEMO_MERCHANT_CATALOG, formatUsd } from "@/lib/catalog/merchant-catalog";
import { spanishProductDescription, spanishVariantLabel } from "@/lib/catalog/demo-translations";
import { spanishFactorReason } from "@/lib/i18n/assessment-reasons";
import type { JourneyCopy } from "@/lib/i18n/demo-copy";
import type { IntendedUse } from "@/lib/readiness/engine";
import type { JourneyLanguage } from "@/lib/i18n/language";
import type { GuidedCatalogLine } from "@/server/shopping";

function assessmentLanguages(language: JourneyLanguage, reason: string, spanish: string | null, fallback: string) {
  if (language !== "es") return reason;
  return (
    <span className="assessment-languages">
      <span lang="en">{reason}</span>
      <span>{spanish ?? fallback}</span>
    </span>
  );
}

function catalogIllustration(productId: string): string | null {
  const path = DEMO_MERCHANT_CATALOG.products.find((product) => product.productId === productId)?.imagePath;
  return path?.startsWith("/catalog/") ? path : null;
}

/** The confirmed whole-dollar budget as shown beside a price, for example "$600". */
function budgetText(budgetDollars: string): string {
  return `$${Number(budgetDollars).toLocaleString("en-US")}`;
}

/** Fixed demo price compared with the confirmed budget. Both are server values; nothing else is added. */
function budgetDifference(copy: JourneyCopy, unitAmountCents: number, budgetDollars: string): string {
  const differenceCents = Number(budgetDollars) * 100 - unitAmountCents;
  const budget = budgetText(budgetDollars);
  if (differenceCents === 0) return copy.budgetEqual(budget);
  return differenceCents > 0 ? copy.budgetUnder(formatUsd(differenceCents), budget) : copy.budgetOver(formatUsd(-differenceCents), budget);
}

/** Card heading, variant, price and budget difference. The illustration sits beside it as a thumbnail. */
function CatalogIdentity({
  copy,
  language,
  line,
  confirmedBudgetDollars,
}: {
  readonly copy: JourneyCopy;
  readonly language: JourneyLanguage;
  readonly line: GuidedCatalogLine;
  readonly confirmedBudgetDollars: string;
}) {
  const spanishLabel = language === "es" ? spanishVariantLabel(line.variantId) : null;
  const photo = productPhoto(line.productId);
  const image = photo?.path ?? catalogIllustration(line.productId);
  return (
    <>
      {image ? (
        <img className="product-illustration" src={image} alt={photo?.alt[language] ?? `${line.title}, illustration`} lang={!photo && language === "es" ? "en" : undefined} width={320} height={200} />
      ) : null}
      <h3 id={`catalog-${line.variantId}`} className="text-lg font-semibold">
        {language === "es" ? <span lang="en">{line.title}</span> : line.title}
      </h3>
      <p className="result-variant">
        {language === "es" ? (spanishLabel ?? <><span lang="en">{line.label}</span> — {copy.missingTranslation}</>) : line.label}
      </p>
      <p><ProductPhotoCredit productId={line.productId} language={language} /></p>
      <p className="result-price">
        <span className="result-amount">{formatUsd(line.unitAmountCents)}</span> <span className="result-currency">{line.currency}</span>{" "}
        <span className="result-price-label">{copy.priceLabel}</span>
      </p>
      <p className={Number(confirmedBudgetDollars) * 100 < line.unitAmountCents ? "result-budget result-budget-over" : "result-budget"}>
        {budgetDifference(copy, line.unitAmountCents, confirmedBudgetDollars)}
      </p>
    </>
  );
}

/** Product description in the journey language; English original marked on a Spanish page. */
function CatalogDescription({ copy, language, line }: { readonly copy: JourneyCopy; readonly language: JourneyLanguage; readonly line: GuidedCatalogLine }) {
  const spanishDescription = language === "es" ? spanishProductDescription(line.productId) : null;
  if (language !== "es") return <p>{line.description}</p>;
  return (
    <>
      <p>{spanishDescription ?? copy.missingTranslation}</p>
      <p className="result-original">
        <span lang="en">{line.label}</span>
        <br />
        <span lang="en">{line.description}</span>
      </p>
    </>
  );
}

/** Suitability from the readiness status, then each factor that did not pass. No count, rank or score. */
function ResultSummary({
  copy,
  line,
  factors,
  excluded = false,
  hidePass = false,
}: {
  readonly copy: JourneyCopy;
  readonly line: GuidedCatalogLine;
  readonly factors: GuidedCatalogLine["factors"];
  /** An excluded line never says that every rule passed. */
  readonly excluded?: boolean;
  /** The Recommended badge already says the item fits; the status and pass line move into the details. */
  readonly hidePass?: boolean;
}) {
  const tradeoffs = factors.filter((factor) => factor.outcome !== "PASS");
  return (
    <>
      {hidePass ? null : (
        <p className="result-status" data-status={line.status}>
          {copy.status[line.status]}
        </p>
      )}
      {tradeoffs.length === 0 ? (
        excluded || hidePass ? null : <p className="result-all-pass">{copy.meetsAllChecks}</p>
      ) : (
        <ul className="result-tradeoffs">
          {tradeoffs.map((factor) => (
            <li key={`${line.variantId}-${factor.factor}`} className="result-tradeoff" data-outcome={factor.outcome}>
              {copy.factors[factor.factor]}: {copy.outcomes[factor.outcome]}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function FactorList({
  copy,
  language,
  line,
  factors,
}: {
  readonly copy: JourneyCopy;
  readonly language: JourneyLanguage;
  readonly line: GuidedCatalogLine;
  readonly factors: GuidedCatalogLine["factors"];
}) {
  return (
    <ul>
      {factors.map((factor) => {
        const spanish = language === "es" ? spanishFactorReason(factor) : null;
        return (
          <li key={`${line.variantId}-${factor.factor}`}>
            {copy.factors[factor.factor]} ({copy.outcomes[factor.outcome]}){" "}
            {assessmentLanguages(language, factor.reason, spanish, copy.missingTranslation)}
          </li>
        );
      })}
    </ul>
  );
}

/** Eligible lines keep a purchase control. Excluded lines list every failing or unknown factor and have none. */
export function TranslatedCatalogList({
  copy,
  language,
  csrfToken,
  lines,
  excludedLines = [],
  confirmedUse,
  confirmedBudgetDollars,
  labelChoices = false,
  suggestedVariantIds = [],
}: {
  readonly copy: JourneyCopy;
  readonly language: JourneyLanguage;
  readonly csrfToken: string;
  readonly lines: readonly GuidedCatalogLine[];
  readonly excludedLines?: readonly GuidedCatalogLine[];
  readonly confirmedUse: IntendedUse;
  readonly confirmedBudgetDollars: string;
  readonly labelChoices?: boolean;
  readonly suggestedVariantIds?: readonly string[];
}) {
  return (
    <section aria-labelledby="guided-catalog-heading" className="comparison flex flex-col gap-4">
      <h2 id="guided-catalog-heading" className="text-2xl font-semibold">
        {copy.catalogHeading}
      </h2>
      <div className="results-notes">
        <p>{copy.catalogNotice}</p>
        <details className="comparison-checks">
          <summary>{language === "es" ? "Qué comprobamos" : "What we checked"}</summary>
          <p className="limitation">{copy.checkLimitation}</p>
          {language === "es" ? <p>{copy.englishOriginal}</p> : null}
        </details>
      </div>
      <ul className="eligible-list flex flex-col gap-4">
        {lines.map((line) => {
          const suggested = labelChoices && suggestedVariantIds.includes(line.variantId);
          // A suggestion for local AI is not shown as an unqualified recommendation without GPU/VRAM evidence.
          const unverifiedForAi = suggested && aiRecommendationUnverified(line.aiHardware, line.aiContext);
          const recommended = suggested && !unverifiedForAi;
          return (
          <li key={line.variantId} className="result-card eligible-card">
            <CatalogIdentity copy={copy} language={language} line={line} confirmedBudgetDollars={confirmedBudgetDollars} />
            {labelChoices ? (
              <p className={`result-choice${recommended ? " recommendation-badge" : ""}`}>{recommended ? copy.suggestedLabel : unverifiedForAi ? copy.aiUnverifiedChoiceLabel : copy.otherChoiceLabel}</p>
            ) : null}
            <ResultSummary copy={copy} line={line} factors={line.factors} hidePass={recommended} />
              {line.aiContext === false ? null : <AiCompatibilityDisclosure assessment={line.aiHardware} language={language} />}
            <details className="result-details">
              <summary>{copy.whyThis}</summary>
              {recommended ? (
                <p>
                  <span className="result-status" data-status={line.status}>{copy.status[line.status]}</span>{" "}
                  {line.factors.every((factor) => factor.outcome === "PASS") ? copy.meetsAllChecks : null}
                </p>
              ) : null}
              <CatalogDescription copy={copy} language={language} line={line} />
              <p>{copy.shipping}</p>
              <FactorList copy={copy} language={language} line={line} factors={line.factors} />
            </details>
            {line.quotable ? (
              <form method="post" action="/checkout/start">
                <input type="hidden" name="csrfToken" value={csrfToken} />
                <input type="hidden" name="productId" value={line.productId} />
                <input type="hidden" name="variantId" value={line.variantId} />
                <input type="hidden" name="quantity" value="1" />
                <input type="hidden" name="use" value={confirmedUse} />
                <input type="hidden" name="budget" value={confirmedBudgetDollars} />
                <input type="hidden" name="lang" value={language} />
                <button
                  type="submit"
                  id={`review-${line.variantId}`}
                  aria-labelledby={`review-${line.variantId} catalog-${line.variantId}`}
                  className="shopping-primary-action rounded bg-blue-800 px-4 py-2 font-medium text-white"
                >
                  <Icon name="receipt" />
                  {copy.reviewPurchase}
                </button>
              </form>
            ) : null}
          </li>
          );
        })}
      </ul>
      {excludedLines.length > 0 ? (
        <section aria-labelledby="guided-excluded-heading" className="flex flex-col gap-4">
          <h2 id="guided-excluded-heading" className="text-2xl font-semibold">
            {copy.excludedHeading}
          </h2>
          <ul className="excluded-list flex flex-col gap-4">
            {excludedLines.map((line) => {
              const failing = line.factors.filter((factor) => factor.outcome === "FAIL" || factor.outcome === "UNKNOWN");
              return (
                <li key={line.variantId} className="result-card excluded-card">
                  <CatalogIdentity copy={copy} language={language} line={line} confirmedBudgetDollars={confirmedBudgetDollars} />
                  <ResultSummary copy={copy} line={line} factors={failing} excluded />
              {line.aiContext === false ? null : <AiCompatibilityDisclosure assessment={line.aiHardware} language={language} />}
                  <details className="result-details">
                    <summary>{copy.whyThis}</summary>
                    <CatalogDescription copy={copy} language={language} line={line} />
                    <FactorList copy={copy} language={language} line={line} factors={failing} />
                  </details>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
