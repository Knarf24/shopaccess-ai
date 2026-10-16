import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import { GuidedProgress, type GuidedStep } from "@/components/mock-journey/GuidedProgress";
import { InterpretedNeedsReview, NEEDS_REVIEW_HEADING_ID } from "@/components/mock-journey/InterpretedNeedsReview";
import { NeedsConversation } from "@/components/mock-journey/NeedsConversation";
import "../../guided-presentation.css";
import { ExternalListings, type ListingNotice } from "@/components/mock-journey/ExternalListings";
import { TranslatedAdvisory } from "@/components/mock-journey/TranslatedAdvisory";
import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { journeyCopy, type JourneyCopy } from "@/lib/i18n/demo-copy";
import { allowlistedJourneyLanguage, guidedSessionEntry, type JourneyLanguage } from "@/lib/i18n/language";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { loadNeedsJourney, visibleNeedsNotice } from "@/server/shopping";
import { resolvePageSession } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const NEEDS_VALIDATION_ALERT_ID = "needs-validation-alert";
export const NEEDS_EXPIRED_ALERT_ID = "needs-expired-alert";
export const NEEDS_PAGE_HEADING_ID = "guided-page-title";
export const NEEDS_SUGGESTIONS_HEADING_ID = "guided-advisory-heading";

export type NeedsCurrentTarget = "expired" | "alert" | "notice" | "review" | "suggestions" | "heading";

/** One skip target. Expired alert, validation alert, notice, review, suggestions, then the page heading. */
export function selectNeedsCurrentTarget(state: {
  readonly expiredDraft: boolean;
  readonly validationAlert: boolean;
  readonly noticeRendered: boolean;
  readonly reviewRendered: boolean;
  readonly suggestionsRendered: boolean;
}): NeedsCurrentTarget {
  if (state.expiredDraft) return "expired";
  if (state.validationAlert) return "alert";
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

function languageFrom(value: string | string[] | undefined): JourneyLanguage {
  return allowlistedJourneyLanguage(typeof value === "string" ? value : undefined);
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
        <p role="alert">{copy.alerts.COOKIE_DROPPED}</p>
      </div>
    );
  }
  redirect(guidedSessionEntry(lang));
}

async function NeedsContentUnguarded({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  const application = opened;
  if (application.mode === "postgres") notFound();
  if (application.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;
  const runtime = runtimeOf(application);
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;

  const query = await searchParams;
  const admissionLocation = protectedAdmissionLocation(
    runtime.value.admission,
    (await headers()).get("cookie"),
    runtime.value.clock().getTime(),
    typeof query.lang === "string" ? query.lang : undefined,
  );
  if (admissionLocation) redirect(admissionLocation);
  const session = await resolvePageSession(runtime.value);
  if (!session) {
    return (
      <MissingSessionNeeds
        started={query.started === "1" ? "1" : undefined}
        lang={typeof query.lang === "string" ? query.lang : undefined}
      />
    );
  }

  const journey = await loadNeedsJourney(runtime.value, session);
  const language = journey.draft?.language ?? languageFrom(query.lang);
  const copy = journeyCopy(language);
  const errorCode = typeof query.error === "string" ? query.error : undefined;
  const alert = errorCode && errorCode in copy.alerts ? copy.alerts[errorCode as keyof typeof copy.alerts] : null;
  const notice = visibleNeedsNotice({
    sessionLive: true,
    draft: journey.draft,
    queryNotice: typeof query.notice === "string" ? query.notice : null,
  });
  const expiredDraft = journey.expiredDraft || errorCode === "DRAFT_EXPIRED";
  const showConfirm =
    journey.draft !== null &&
    journey.draft.confirmedUse === null &&
    journey.draft.prefilledUse !== null &&
    journey.draft.prefilledBudgetDollars !== null &&
    journey.draft.notice === "review";
  const showClarify =
    !expiredDraft && journey.draft !== null && journey.draft.confirmedUse === null && !showConfirm;
  const showFirstAsk = !expiredDraft && journey.draft === null;
  const confirmedUse = journey.draft?.confirmedUse ?? null;
  const confirmedBudgetDollars = journey.draft?.confirmedBudgetDollars ?? null;
  const budgetCents = confirmedBudgetDollars === null ? null : Number(confirmedBudgetDollars) * 100;
  const eligibleLines =
    budgetCents === null
      ? []
      : journey.lines.filter(
          (line) => (line.status === "READY" || line.status === "READY_WITH_CAVEATS") && line.unitAmountCents <= budgetCents,
        );
  const excludedLines =
    budgetCents === null ? [] : journey.lines.filter((line) => !eligibleLines.some((eligible) => eligible.variantId === line.variantId));
  const failureNotice = notice === "malformed" || notice === "unavailable" ? notice : null;
  const statusNotice =
    notice && notice !== "malformed" && notice !== "unavailable" && (journey.draft?.confirmedUse === null || notice === "ambiguous") ? notice : null;
  const validationAlertId = !expiredDraft && alert ? NEEDS_VALIDATION_ALERT_ID : undefined;
  const noticeRendered = !expiredDraft && (failureNotice !== null || statusNotice !== null);
  const suggestionsRendered = Boolean(journey.draft && confirmedUse && confirmedBudgetDollars);
  const listingNotice = listingNoticeFrom(query.listings) ?? (journey.listings?.status === "error" ? "error" : null);
  const listingsPending = journey.listings?.status === "pending";
  const externalListings = journey.listings?.status === "ready" ? journey.listings.listings : null;
  const suggestedVariantIds = journey.draft?.recommendation?.recommendations.map((item) => item.variantId) ?? [];
  const currentTarget = selectNeedsCurrentTarget({
    expiredDraft,
    validationAlert: validationAlertId !== undefined,
    noticeRendered,
    reviewRendered: showConfirm,
    suggestionsRendered,
  });
  const currentTargetId = needsCurrentTargetId(currentTarget);
  const currentStep: GuidedStep | null = expiredDraft
    ? null
    : showFirstAsk || showClarify
      ? "needs"
      : showConfirm
        ? "confirm"
        : confirmedUse && confirmedBudgetDollars
          ? "results"
          : null;

  return (
    <div lang={language} className="flex flex-col gap-6">
      <SkipToCurrentStep copy={copy} targetId={currentTargetId} />
      <h1
        id={currentTarget === "heading" ? NEEDS_PAGE_HEADING_ID : undefined}
        tabIndex={currentTarget === "heading" ? -1 : undefined}
        className="text-3xl font-semibold"
      >
        {copy.pageTitle}
      </h1>
      {currentStep ? <GuidedProgress copy={copy} current={currentStep} /> : null}
      {expiredDraft ? (
        <>
          <p id={NEEDS_EXPIRED_ALERT_ID} role="alert" tabIndex={-1}>
            {copy.alerts.DRAFT_EXPIRED}
          </p>
          <p>
            <Link href={`/shop/needs?lang=${language}`} prefetch={false} className="underline">
              {copy.restartNeeds}
            </Link>
          </p>
        </>
      ) : null}
      {validationAlertId && alert ? (
        <p id={validationAlertId} role="alert" tabIndex={-1}>
          {alert}
        </p>
      ) : null}
      {!expiredDraft && failureNotice ? (
        <p id="needs-notice" role="alert" tabIndex={currentTarget === "notice" ? -1 : undefined}>
          {copy.notices[failureNotice]}
        </p>
      ) : null}
      {!expiredDraft && statusNotice ? (
        <p id="needs-notice" role="status" tabIndex={currentTarget === "notice" ? -1 : undefined}>
          {copy.notices[statusNotice]}
        </p>
      ) : null}
      {showFirstAsk ? (
        <NeedsConversation
          copy={copy}
          language={language}
          csrfToken={session.csrfToken}
          draft={null}
          mode="first"
          validationAlertId={validationAlertId}
          turns={journey.conversation?.turns}
          noticeRendered={noticeRendered}
        />
      ) : null}
      {showClarify && journey.draft ? (
        <NeedsConversation
          copy={copy}
          language={language}
          csrfToken={session.csrfToken}
          draft={journey.draft}
          mode="clarify"
          turns={journey.conversation?.turns}
          validationAlertId={validationAlertId}
          noticeRendered={noticeRendered}
        />
      ) : null}
      {showConfirm && journey.draft ? (
        <>
          <NeedsConversation
            copy={copy}
            language={language}
            csrfToken={session.csrfToken}
            draft={journey.draft}
            mode="reply"
            turns={journey.conversation?.turns}
          />
          {journey.draft.shopperText ? (
            <p>
              <span className="block text-sm">{copy.shopperText}</span>
              <span className="mt-1 block whitespace-pre-wrap">{journey.draft.shopperText}</span>
            </p>
          ) : null}
          <InterpretedNeedsReview
            copy={copy}
            language={language}
            csrfToken={session.csrfToken}
            draft={journey.draft}
            validationAlertId={validationAlertId}
            headingTabIndex={currentTarget === "review" ? -1 : undefined}
          />
        </>
      ) : null}
      {journey.draft && confirmedUse && confirmedBudgetDollars ? (
        <>
          <NeedsConversation
            copy={copy}
            language={language}
            csrfToken={session.csrfToken}
            draft={journey.draft}
            mode="clarify"
            turns={journey.conversation?.turns}
            validationAlertId={validationAlertId}
            noticeRendered={noticeRendered}
          />
          <TranslatedAdvisory
            copy={copy}
            language={language}
            draft={journey.draft}
            lines={journey.lines}
            headingTabIndex={currentTarget === "suggestions" ? -1 : undefined}
            suggestionSource={journey.suggestionSource}
            eligibleVariantIds={eligibleLines.map((line) => line.variantId)}
          />
          <TranslatedCatalogList
            copy={copy}
            language={language}
            csrfToken={session.csrfToken}
            lines={eligibleLines}
            excludedLines={excludedLines}
            confirmedUse={confirmedUse}
            confirmedBudgetDollars={confirmedBudgetDollars}
            labelChoices={journey.draft.recommendationClaim === "completed"}
            suggestedVariantIds={suggestedVariantIds}
          />
          <ExternalListings
            copy={copy}
            language={language}
            csrfToken={session.csrfToken}
            draftId={journey.draft.draftId}
            version={journey.draft.version}
            notice={listingNotice}
            listings={externalListings}
            pending={listingsPending}
          />
        </>
      ) : null}
      <p>
        <Link href="/" prefetch={false} className="underline">
          {copy.navigationHome}
        </Link>
      </p>
    </div>
  );
}

function listingNoticeFrom(value: string | string[] | undefined): ListingNotice | null {
  const token = Array.isArray(value) ? value[0] : value;
  if (token === "unavailable" || token === "limit" || token === "error" || token === "stale") return token;
  return null;
}

export default function NeedsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="guided-presentation">
      <div className="presentation-column">
        <Suspense fallback={<p>Loading guided shopping…</p>}>
          <NeedsContent searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

/** A save refused while rendering shows the unavailable notice, never a partial or success view. */
async function NeedsContent(props: Parameters<typeof NeedsContentUnguarded>[0]) {
  return guardPage(() => NeedsContentUnguarded(props), () => <StoreUnavailable />);
}
