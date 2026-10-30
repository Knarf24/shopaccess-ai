import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { spanishFactorReason } from "@/lib/i18n/assessment-reasons";
import type { JourneyCopy } from "@/lib/i18n/demo-copy";
import { recommendationSentence } from "@/lib/i18n/demo-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";
import { aiRecommendationUnverified } from "@/lib/readiness/ai-hardware";
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

interface AdvisoryDraft {
  readonly recommendationClaim: "pending" | "completed" | "failed" | null;
  readonly recommendation: {
    readonly assistantMessage: string | null;
    readonly recommendations: readonly {
      readonly productId: string;
      readonly variantId: string;
      readonly title: string;
      readonly unitAmountCents: number;
      readonly currency: "USD";
    }[];
  } | null;
}

export function TranslatedAdvisory({
  copy,
  language,
  draft,
  lines,
  headingTabIndex,
  suggestionSource = null,
  eligibleVariantIds = [],
  compact = false,
}: {
  readonly copy: JourneyCopy;
  readonly language: JourneyLanguage;
  readonly draft: AdvisoryDraft;
  readonly lines: readonly GuidedCatalogLine[];
  /** Set only when this heading is the skip-link target. */
  readonly headingTabIndex?: -1;
  readonly suggestionSource?: "mock" | "model" | "fallback" | null;
  readonly eligibleVariantIds?: readonly string[];
  /**
   * Status, recommendation sentence and source only. The needs page uses this because each result card already shows
   * the suggested label, price and reasons, so the items are not repeated here.
   */
  readonly compact?: boolean;
}) {
  const sentence = recommendationSentence(language, draft.recommendation?.assistantMessage ?? null);
  const sourceSentence =
    draft.recommendationClaim === "completed" && suggestionSource === "model"
      ? copy.suggestionSourceModel
      : draft.recommendationClaim === "completed" && suggestionSource === "fallback"
        ? copy.suggestionSourceFallback
      : draft.recommendationClaim === "completed" && suggestionSource === "mock"
        ? copy.suggestionSourceMock
        : null;
  const eligible = new Set(eligibleVariantIds);
  return (
    <section aria-labelledby="guided-advisory-heading" className="advisory-panel flex flex-col gap-3">
      <h2 id="guided-advisory-heading" tabIndex={headingTabIndex} className="text-2xl font-semibold">
        {copy.advisoryHeading}
      </h2>
      {draft.recommendationClaim === "pending" ? <p role="status">{copy.pending}</p> : null}
      {draft.recommendationClaim === "failed" ? <p role="alert">{copy.unavailable}</p> : null}
      {draft.recommendationClaim === "completed" && sentence ? <p role="status">{sentence}</p> : null}
      {sourceSentence ? <p>{sourceSentence}</p> : null}
      {draft.recommendationClaim === "completed" && (draft.recommendation?.recommendations ?? []).some((item) => {
        const line = lines.find((entry) => entry.productId === item.productId && entry.variantId === item.variantId);
        return line !== undefined && eligible.has(item.variantId) && aiRecommendationUnverified(line.aiHardware, line.aiContext);
      }) ? <p data-ai-general-only>{copy.aiGeneralOnlyNote}</p> : null}
      {draft.recommendationClaim === "completed" && !sentence ? <p role="alert">{copy.unavailable}</p> : null}
      {compact ? null : (
      <ul className="flex flex-col gap-3">
        {(draft.recommendation?.recommendations ?? []).map((item) => {
          const line = lines.find((entry) => entry.productId === item.productId && entry.variantId === item.variantId);
          return (
            <li key={item.variantId}>
              {eligible.has(item.variantId) && !(line && aiRecommendationUnverified(line.aiHardware, line.aiContext)) ? <p>{copy.suggestedLabel}</p> : null}
              <p>{language === "es" ? <span lang="en">{item.title}</span> : item.title}</p>
              <p>
                {copy.priceLabel} {formatUsd(item.unitAmountCents)} {item.currency}
              </p>
              {line ? (
                <>
                  <p>{copy.status[line.status]}</p>
                  <ul>
                    {line.factors.map((factor) => {
                      const spanish = language === "es" ? spanishFactorReason(factor) : null;
                      return (
                        <li key={factor.factor}>
                          {copy.factors[factor.factor]} ({copy.outcomes[factor.outcome]}){" "}
                          {assessmentLanguages(language, factor.reason, spanish, copy.missingTranslation)}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : language === "es" ? (
                <p>{copy.missingTranslation}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      )}
    </section>
  );
}
