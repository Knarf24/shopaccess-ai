import type { JourneyCopy } from "@/lib/i18n/demo-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";
import { INTENDED_USES, type IntendedUse } from "@/lib/readiness/engine";
import { Icon } from "../Icon";

export const NEEDS_REVIEW_HEADING_ID = "review-heading";

interface NeedsReviewDraft {
  readonly prefilledUse: IntendedUse | null;
  readonly prefilledBudgetDollars: string | null;
  readonly draftId: string;
  readonly version: number;
}

/** Explicit review. The posted values are the ones that can be confirmed, not a hidden inference. */
export function InterpretedNeedsReview({
  copy,
  language,
  csrfToken,
  draft,
  validationAlertId,
  headingTabIndex,
}: {
  readonly copy: JourneyCopy;
  readonly language: JourneyLanguage;
  readonly csrfToken: string;
  readonly draft: NeedsReviewDraft;
  /** Set only when the page is rendering the validation alert with this id. */
  readonly validationAlertId?: string;
  /** Set only when this heading is the skip-link target. */
  readonly headingTabIndex?: -1;
}) {
  return (
    <form key={`${draft.draftId}:${draft.version}`} method="post" action="/shop/needs/confirm" aria-labelledby={NEEDS_REVIEW_HEADING_ID} className="journey-form journey-panel flex max-w-xl flex-col gap-4 rounded-lg border border-zinc-400 p-4">
      <h2 id={NEEDS_REVIEW_HEADING_ID} tabIndex={headingTabIndex} className="text-xl font-semibold">
        {copy.reviewTitle}
      </h2>
      <p>{copy.reviewBody}</p>
      <label className="flex flex-col gap-1 text-sm" htmlFor="review-use">
        <span className="label-line"><Icon name="laptop" />{copy.useLabel}</span>
        <select id="review-use" name="use" defaultValue={draft.prefilledUse ?? ""} required className="rounded border border-zinc-400 p-2">
          <option value="">{copy.questions.intended_use}</option>
          {INTENDED_USES.map((use) => (
            <option key={use} value={use}>
              {copy.uses[use]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor="review-budget">
        <span className="label-line"><Icon name="budget" />{copy.budgetLabel}</span>
        <input
          id="review-budget"
          name="budget"
          inputMode="numeric"
          pattern="[1-9][0-9]{1,4}"
          defaultValue={draft.prefilledBudgetDollars ?? ""}
          required
          aria-describedby={validationAlertId ? `${validationAlertId} budget-hint` : "budget-hint"}
          className="rounded border border-zinc-400 p-2"
        />
      </label>
      <p id="budget-hint" className="text-sm">
        {copy.budgetHint}
      </p>
      <input type="hidden" name="lang" value={language} />
      <input type="hidden" name="draftId" value={draft.draftId} />
      <input type="hidden" name="version" value={String(draft.version)} />
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <button type="submit" className="shopping-primary-action rounded bg-blue-800 px-4 py-2 font-medium text-white">
        <Icon name="check" />{copy.confirmReview}
      </button>
    </form>
  );
}
