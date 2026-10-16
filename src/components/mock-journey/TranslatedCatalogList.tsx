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

function CatalogIdentity({
  copy,
  language,
  line,
}: {
  readonly copy: JourneyCopy;
  readonly language: JourneyLanguage;
  readonly line: GuidedCatalogLine;
}) {
  const spanishDescription = language === "es" ? spanishProductDescription(line.productId) : null;
  const spanishLabel = language === "es" ? spanishVariantLabel(line.variantId) : null;
  const image = catalogIllustration(line.productId);
  return (
    <>
      {image ? (
        <img className="product-illustration" src={image} alt={`${line.title}, illustration`} lang={language === "es" ? "en" : undefined} width={320} height={200} />
      ) : null}
      <h3 id={`catalog-${line.variantId}`} className="text-lg font-semibold">
        {language === "es" ? <span lang="en">{line.title}</span> : line.title}
      </h3>
      <p>{language === "es" ? <span lang="en">{line.description}</span> : line.description}</p>
      {language === "es" ? spanishDescription ? <p>{spanishDescription}</p> : <p>{copy.missingTranslation}</p> : null}
      <p>
        {language === "es" ? <span lang="en">{line.label}</span> : line.label}
        {language === "es" ? spanishLabel ? <span> — {spanishLabel}</span> : <span> — {copy.missingTranslation}</span> : null}
      </p>
      <p>
        {copy.priceLabel} {formatUsd(line.unitAmountCents)} {line.currency}
      </p>
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
      <p>{copy.catalogNotice}</p>
      <p className="limitation" role="status">{copy.checkLimitation}</p>
      {language === "es" ? <p>{copy.englishOriginal}</p> : null}
      <ul className="eligible-list flex flex-col gap-4">
        {lines.map((line) => (
          <li key={line.variantId} className="eligible-card rounded-lg border border-zinc-400 p-4">
            {labelChoices ? <p>{suggestedVariantIds.includes(line.variantId) ? copy.suggestedLabel : copy.otherChoiceLabel}</p> : null}
            <CatalogIdentity copy={copy} language={language} line={line} />
            <p>{copy.shipping}</p>
            <h4 className="font-semibold">{copy.whyThis}</h4>
            <FactorList copy={copy} language={language} line={line} factors={line.factors} />
            {line.quotable ? (
              <form method="post" action="/checkout/start">
                <input type="hidden" name="csrfToken" value={csrfToken} />
                <input type="hidden" name="productId" value={line.productId} />
                <input type="hidden" name="variantId" value={line.variantId} />
                <input type="hidden" name="quantity" value="1" />
                <input type="hidden" name="use" value={confirmedUse} />
                <input type="hidden" name="budget" value={confirmedBudgetDollars} />
                <input type="hidden" name="lang" value={language} />
                <button type="submit" className="rounded bg-blue-800 px-4 py-2 font-medium text-white">
                  {language === "es" ? (
                    <>
                      {`${copy.reviewPurchase} para `}
                      <span lang="en">{line.title}</span>
                      {", "}
                      <span lang="en">{line.label}</span>
                    </>
                  ) : (
                    `${copy.reviewPurchase} for ${line.title}, ${line.label}`
                  )}
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {excludedLines.length > 0 ? (
        <section aria-labelledby="guided-excluded-heading" className="flex flex-col gap-4">
          <h2 id="guided-excluded-heading" className="text-2xl font-semibold">
            {copy.excludedHeading}
          </h2>
          <ul className="excluded-list flex flex-col gap-4">
            {excludedLines.map((line) => (
              <li key={line.variantId} className="excluded-card rounded-lg border border-zinc-400 p-4">
                <CatalogIdentity copy={copy} language={language} line={line} />
                <FactorList
                  copy={copy}
                  language={language}
                  line={line}
                  factors={line.factors.filter((factor) => factor.outcome === "FAIL" || factor.outcome === "UNKNOWN")}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
