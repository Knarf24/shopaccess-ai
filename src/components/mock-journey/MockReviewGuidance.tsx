import { journeyCopy } from "@/lib/i18n/demo-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";

/** Purchase-review guidance for a mock checkout that carried a language. It does not replace the confirmation form. */
export function MockReviewGuidance({ language }: { readonly language: JourneyLanguage }) {
  const copy = journeyCopy(language);
  return (
    <section aria-labelledby="review-guidance-heading" className="purchase-guidance rounded-lg border border-zinc-400 p-4" lang={language}>
      <h2 id="review-guidance-heading" className="text-xl font-semibold">
        {copy.purchaseGuidanceTitle}
      </h2>
      <p>{copy.reviewGuidance}</p>
    </section>
  );
}
