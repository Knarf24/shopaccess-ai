import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { NEEDS_REVIEW_HEADING_ID } from "@/components/mock-journey/InterpretedNeedsReview";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { PAIRED_ACCESS_RESULT_ID } from "@/components/PairedAccess";
import { journeyCopy, type JourneyCopy } from "@/lib/i18n/demo-copy";
import { allowlistedJourneyLanguage, guidedSessionEntry } from "@/lib/i18n/language";

export const NEEDS_VALIDATION_ALERT_ID = "needs-validation-alert";
export const NEEDS_EXPIRED_ALERT_ID = "needs-expired-alert";
export const NEEDS_PAGE_HEADING_ID = "guided-page-title";
export const NEEDS_SUGGESTIONS_HEADING_ID = "guided-advisory-heading";

export type NeedsCurrentTarget = "expired" | "alert" | "revoked" | "notice" | "review" | "suggestions" | "heading";

/**
 * One skip target. Expired alert, validation alert, the result of revoking a paired side panel (M2-2), notice, review,
 * suggestions, then the page heading.
 */
export function selectNeedsCurrentTarget(state: {
  readonly expiredDraft: boolean;
  readonly validationAlert: boolean;
  readonly revocationRendered?: boolean;
  readonly noticeRendered: boolean;
  readonly reviewRendered: boolean;
  readonly suggestionsRendered: boolean;
}): NeedsCurrentTarget {
  if (state.expiredDraft) return "expired";
  if (state.validationAlert) return "alert";
  if (state.revocationRendered) return "revoked";
  if (state.noticeRendered) return "notice";
  if (state.reviewRendered) return "review";
  if (state.suggestionsRendered) return "suggestions";
  return "heading";
}

export function needsCurrentTargetId(target: NeedsCurrentTarget): string {
  switch (target) {
    case "expired":
      return NEEDS_EXPIRED_ALERT_ID;
    case "alert":
      return NEEDS_VALIDATION_ALERT_ID;
    case "revoked":
      return PAIRED_ACCESS_RESULT_ID;
    case "notice":
      return "needs-notice";
    case "review":
      return NEEDS_REVIEW_HEADING_ID;
    case "suggestions":
      return NEEDS_SUGGESTIONS_HEADING_ID;
    case "heading":
      return NEEDS_PAGE_HEADING_ID;
  }
}

/** First tab stop in the journey language. It does not submit a form. */
export function SkipToCurrentStep({ copy, targetId }: { readonly copy: JourneyCopy; readonly targetId: string }) {
  return (
    <a className="skip-link" href={`#${targetId}`}>
      {copy.skipToCurrentStep}
    </a>
  );
}

/** A page with no session either starts one or reports that the browser dropped the cookie. */
export function MissingSessionNeeds({
  started,
  lang,
}: {
  readonly started: string | undefined;
  readonly lang: string | undefined;
}): ReactNode {
  if (started === "1") {
    const language = allowlistedJourneyLanguage(lang);
    const copy = journeyCopy(language);
    return (
      <div lang={language}>
        <DocumentLanguageSync language={language} />
        <p role="alert">{copy.alerts.COOKIE_DROPPED}</p>
      </div>
    );
  }
  redirect(guidedSessionEntry(lang));
}
