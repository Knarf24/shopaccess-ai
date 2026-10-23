import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import { GuidedProgress, type GuidedStep } from "@/components/mock-journey/GuidedProgress";
import { InterpretedNeedsReview } from "@/components/mock-journey/InterpretedNeedsReview";
import { NeedsConversation } from "@/components/mock-journey/NeedsConversation";
import { PairedAccess } from "@/components/PairedAccess";
import { PermissionRefusal } from "@/components/PermissionRefusal";
import { ChargerDeviceHandoff } from "@/components/ChargerDeviceHandoff";
import { ChargerConversationControls } from "@/components/mock-journey/ChargerConversationControls";
import { ChargerInformation } from "@/components/ChargerInformation";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { chargerCopy } from "@/lib/i18n/charger-copy";
import { EVIDENCE } from "@/lib/compatibility/evidence";
import { selectDevice } from "@/lib/compatibility/rules";
import { isPermissionRefusal, permissionCopy } from "@/lib/i18n/permission-copy";
import { revocationMessage } from "@/lib/i18n/extension-copy";
import "../../../guided-presentation.css";
import "./needs-workspace.css";
import { ExternalListings, type ListingNotice } from "@/components/mock-journey/ExternalListings";
import { TranslatedAdvisory } from "@/components/mock-journey/TranslatedAdvisory";
import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { savedLanguageRedirect } from "@/lib/i18n/locale-path";
import { documentLocale } from "@/lib/i18n/locale-segment";
import {
  MissingSessionNeeds,
  NEEDS_EXPIRED_ALERT_ID,
  NEEDS_PAGE_HEADING_ID,
  NEEDS_VALIDATION_ALERT_ID,
  SkipToCurrentStep,
  needsCurrentTargetId,
  selectNeedsCurrentTarget,
} from "./current-step";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { loadNeedsJourney, visibleNeedsNotice } from "@/server/shopping";
import { resolvePageSession } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type PageParams = Promise<{ lang: string }>;

async function NeedsContentUnguarded({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  await connection();
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  const pathLanguage = documentLocale(lang);
  if (!pathLanguage) notFound();
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  const application = opened;
  if (application.mode === "postgres") notFound();
  if (application.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;
  const runtime = runtimeOf(application);
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;

  const admissionLocation = protectedAdmissionLocation(
    runtime.value.admission,
    (await headers()).get("cookie"),
    runtime.value.clock().getTime(),
    pathLanguage,
  );
  if (admissionLocation) redirect(admissionLocation);
  const session = await resolvePageSession(runtime.value);
  if (!session) {
    return (
      <MissingSessionNeeds
        started={query.started === "1" ? "1" : undefined}
        lang={pathLanguage}
      />
    );
  }

  const journey = await loadNeedsJourney(runtime.value, session);
  const canonical = journey.draft ? savedLanguageRedirect(pathLanguage, journey.draft.language, "/shop/needs", query) : null;
  if (canonical) redirect(canonical);
  const language = journey.draft?.language ?? pathLanguage;
  const copy = journeyCopy(language);
  const externalAiNotice = runtime.value.advisory === "external" && runtime.value.advisoryProviderName
    ? copy.externalAiNotice(runtime.value.advisoryProviderName)
    : undefined;
  const aiLimited = query.ai === "limited";
  const errorCode = typeof query.error === "string" ? query.error : undefined;
  const alert = errorCode && errorCode in copy.alerts ? copy.alerts[errorCode as keyof typeof copy.alerts] : null;
  // F07 (M2-3): a refused checkout start. Not a needs-form error, so it is not linked to the needs inputs.
  const permissionRefusal = isPermissionRefusal(errorCode) ? errorCode : null;
  const notice = visibleNeedsNotice({
    sessionLive: true,
    draft: journey.draft,
    queryNotice: typeof query.notice === "string" ? query.notice : null,
  });
  const chargerTrack = journey.chargerTrack;
  const chargerOpen = chargerTrack !== null && chargerTrack.state !== "closed";
  const expiredDraft = journey.expiredDraft || errorCode === "DRAFT_EXPIRED";
  const showConfirm = !chargerOpen &&
    journey.draft !== null &&
    journey.draft.confirmedUse === null &&
    journey.draft.prefilledUse !== null &&
    journey.draft.prefilledBudgetDollars !== null &&
    journey.draft.notice === "review";
  const showClarify = !chargerOpen &&
    !expiredDraft && journey.draft !== null && journey.draft.confirmedUse === null && !showConfirm;
  const showFirstAsk = !expiredDraft && !chargerOpen && journey.draft === null;
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
  const failureNotice = !chargerOpen && (notice === "malformed" || notice === "unavailable") ? notice : null;
  const statusNotice =
    !chargerOpen && notice && notice !== "malformed" && notice !== "unavailable" && (journey.draft?.confirmedUse === null || notice === "ambiguous") ? notice : null;
  const validationAlertId = !expiredDraft && alert ? NEEDS_VALIDATION_ALERT_ID : undefined;
  const noticeRendered = !expiredDraft && (failureNotice !== null || statusNotice !== null);
  const suggestionsRendered = Boolean(journey.draft && confirmedUse && confirmedBudgetDollars);
  const listingNotice = listingNoticeFrom(query.listings) ?? (journey.listings?.status === "error" ? "error" : null);
  const listingsPending = journey.listings?.status === "pending";
  const externalListings = journey.listings?.status === "ready" ? journey.listings.listings : null;
  const suggestedVariantIds = journey.draft?.recommendation?.recommendations.map((item) => item.variantId) ?? [];
  const pairedAccessShown = runtime.value.extensionOrigins.size > 0;
  const revokedLabel = pairedAccessShown && typeof query.revoked === "string" ? query.revoked : null;
  const currentTarget = selectNeedsCurrentTarget({
    expiredDraft,
    validationAlert: validationAlertId !== undefined || (!expiredDraft && permissionRefusal !== null),
    revocationRendered: revocationMessage(language, revokedLabel, 0) !== null,
    noticeRendered,
    reviewRendered: showConfirm,
    suggestionsRendered: suggestionsRendered && !chargerOpen,
  });
  const currentTargetId = needsCurrentTargetId(currentTarget);
  const currentStep: GuidedStep | null = expiredDraft
    ? null
    : chargerOpen
      ? "needs"
    : showFirstAsk || showClarify
      ? "needs"
      : showConfirm
        ? "confirm"
        : confirmedUse && confirmedBudgetDollars
          ? "results"
          : null;

  return (
    <div lang={language} className="needs-layout flex flex-col gap-6">
      <DocumentLanguageSync language={language} />
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
            <Link href={`/${language}/shop/needs`} prefetch={false} className="underline">
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
      {!expiredDraft && !alert && permissionRefusal ? <PermissionRefusal language={language} code={permissionRefusal} id={NEEDS_VALIDATION_ALERT_ID} /> : null}
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
      {chargerOpen && journey.draft && chargerTrack ? (
        <>
          <NeedsConversation
            copy={copy}
            language={language}
            csrfToken={session.csrfToken}
            draft={journey.draft}
            mode="reply"
            turns={journey.conversation?.turns}
            chargerClarification
            externalAiNotice={externalAiNotice}
            aiLimited={aiLimited}
            afterHistory={
              chargerTrack.state === "task_choice" ? (
                <ChargerConversationControls csrfToken={session.csrfToken} language={language} track={chargerTrack} />
              ) : null
            }
          />
          {chargerTrack.state === "task_choice" ? null : (
            <ChargerConversationControls csrfToken={session.csrfToken} language={language} track={chargerTrack} />
          )}
          {chargerTrack.state === "confirmed" && chargerTrack.deviceId ? (
            <ChargerInformation
              language={language}
              selection={selectDevice(EVIDENCE, { identifier: chargerTrack.deviceId })}
              showDeviceSelector={false}
              showScrollHint
            />
          ) : null}
        </>
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
          externalAiNotice={externalAiNotice}
          aiLimited={aiLimited}
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
          externalAiNotice={externalAiNotice}
          aiLimited={aiLimited}
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
            externalAiNotice={externalAiNotice}
            aiLimited={aiLimited}
          />
          {journey.draft.shopperText ? (
            <p>
              <span className="block text-sm">{copy.shopperText}</span>
              <span className="mt-1 block whitespace-pre-wrap">{journey.draft.shopperText}</span>
            </p>
          ) : null}
          <div className="needs-brief-panel">
            <InterpretedNeedsReview
              copy={copy}
              language={language}
              csrfToken={session.csrfToken}
              draft={journey.draft}
              validationAlertId={validationAlertId}
              headingTabIndex={currentTarget === "review" ? -1 : undefined}
            />
          </div>
        </>
      ) : null}
      {!chargerOpen && journey.draft && confirmedUse && confirmedBudgetDollars ? (
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
            externalAiNotice={externalAiNotice}
            aiLimited={aiLimited}
          />
          <a className="needs-results-jump" href="#guided-advisory-heading">
            {copy.resultsJump(eligibleLines.length)}
          </a>
          <div className="needs-results-panel">
          <p className="needs-confirmed-brief">
            {copy.confirmedBrief(copy.uses[confirmedUse], `$${Number(confirmedBudgetDollars).toLocaleString("en-US")}`)}
          </p>
          <TranslatedAdvisory
            copy={copy}
            language={language}
            draft={journey.draft}
            lines={journey.lines}
            headingTabIndex={currentTarget === "suggestions" ? -1 : undefined}
            suggestionSource={journey.suggestionSource}
            eligibleVariantIds={eligibleLines.map((line) => line.variantId)}
            compact
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
          </div>
        </>
      ) : null}
      {pairedAccessShown ? (
        <PairedAccess
          language={language}
          csrfToken={session.csrfToken}
          grants={runtime.value.pairing.list(session.id, runtime.value.clock())}
          revokedLabel={revokedLabel}
        />
      ) : null}
      <aside className="needs-side">
        <p>
          <Link href={`/${language}/shop/permissions`} prefetch={false} className="underline">
            {permissionCopy(language).managePermissions}
          </Link>
        </p>
        <section className="needs-handoff" aria-labelledby="needs-handoff-heading">
          <h2 id="needs-handoff-heading">
            <Link href={`/${language}/shop/chargers`} prefetch={false} className="underline">
              {chargerCopy(language).needsLink}
            </Link>
          </h2>
          <ChargerDeviceHandoff language={language} />
        </section>
        <p>
          <Link href="/" prefetch={false} className="underline">
            {copy.navigationHome}
          </Link>
        </p>
      </aside>
    </div>
  );
}

function listingNoticeFrom(value: string | string[] | undefined): ListingNotice | null {
  const token = Array.isArray(value) ? value[0] : value;
  if (token === "unavailable" || token === "limit" || token === "error" || token === "stale") return token;
  return null;
}

export default function NeedsPage({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  return (
    <main className="guided-presentation needs-workspace">
      <div className="presentation-column">
        <Suspense fallback={<p>Loading guided shopping…</p>}>
          <NeedsContent params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

/** A save refused while rendering shows the unavailable notice, never a partial or success view. */
async function NeedsContent(props: Parameters<typeof NeedsContentUnguarded>[0]) {
  return guardPage(() => NeedsContentUnguarded(props), () => <StoreUnavailable />);
}
