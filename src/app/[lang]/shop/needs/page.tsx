import { voiceAiOption } from "@/lib/voice/ai-caveat";
import { workloadGuidance } from "@/lib/readiness/workload-guidance";
import { macBookPro2019Guide } from "@/lib/compatibility/macbook-pro-2019-guide";
import { voiceOptionsSummary, chargerVoiceGuidance, type VoiceChargerContext } from "@/lib/voice/journey";
import { ChargerRecommendationLayout } from "@/components/mock-journey/ChargerRecommendationLayout";
import { eligibleChargerTrack } from "@/server/charger-purchase";
import { CHARGER_PRODUCT_ID, CHARGER_VARIANT_ID } from "@/lib/catalog/charger-purchase";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import { GuidedProgress, type GuidedStep } from "@/components/mock-journey/GuidedProgress";
import { InterpretedNeedsReview } from "@/components/mock-journey/InterpretedNeedsReview";
import { NeedsConversation, assistantText } from "@/components/mock-journey/NeedsConversation";
import { HandsFreeControls } from "@/components/mock-journey/HandsFreeControls";
import { NeedsLanguageChoice } from "@/components/mock-journey/NeedsLanguageChoice";
import { PairedAccess } from "@/components/PairedAccess";
import { PermissionRefusal } from "@/components/PermissionRefusal";
import { ChargerDeviceHandoff } from "@/components/ChargerDeviceHandoff";
import { ChargerConversationControls } from "@/components/mock-journey/ChargerConversationControls";
import { ChargerInformation } from "@/components/ChargerInformation";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { chargerCopy, chargerModelHelp } from "@/lib/i18n/charger-copy";
import { EVIDENCE } from "@/lib/compatibility/evidence";
import { selectDevice } from "@/lib/compatibility/rules";
import { isPermissionRefusal, permissionCopy } from "@/lib/i18n/permission-copy";
import { revocationMessage } from "@/lib/i18n/extension-copy";
import "../../../guided-presentation.css";
import "./needs-workspace.css";
import "./charger-recommendation.css";
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
import { Icon } from "@/components/Icon";

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
  if (canonical && journey.draft && query.started === "1") return <section lang={pathLanguage} className="journey-panel flex flex-col gap-4">
    <DocumentLanguageSync language={pathLanguage} />
    <NeedsLanguageChoice heading language={pathLanguage} target={pathLanguage} csrfToken={session.csrfToken} draft={journey.draft} busy={journey.draft.interpretationPending || journey.draft.recommendationClaim === "pending"} />
    <Link href={canonical} prefetch={false}>{pathLanguage === "es" ? "Volver sin cambiar el idioma" : "Go back without changing language"}</Link>
  </section>;
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
  const purchaseTrack = eligibleChargerTrack(runtime.value, session.id);
  const adapterInProgress = runtime.value.permissions.list(session.id, runtime.value.clock()).some(p => p.productId === CHARGER_PRODUCT_ID && (p.state === "executing" || p.state === "outcome_unknown"));
  const adapterPermitted = purchaseTrack !== null && runtime.value.permissions.list(session.id, runtime.value.clock()).some(p => p.live && p.state === "active" && p.productId === CHARGER_PRODUCT_ID && p.variantId === CHARGER_VARIANT_ID && p.maxQuantity >= 1 && p.maxTotalCents >= 5900);
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

  const lastAssistant = [...(journey.conversation?.turns ?? [])].reverse().find(turn => turn.role === "assistant");
  const lastShopper = [...(journey.conversation?.turns ?? [])].reverse().find(turn=>turn.role === "shopper");
  const modelGuide = chargerOpen ? macBookPro2019Guide(lastShopper?.text ?? "",language) : null;
  const voiceCharger: VoiceChargerContext | undefined = chargerOpen && chargerTrack ? {
    state: chargerTrack.state, deviceId: chargerTrack.deviceId,
    modelHelp: chargerModelHelp(lastShopper?.text ?? "",language) ?? undefined,
    deviceName: chargerTrack.deviceId ? EVIDENCE.devices[chargerTrack.deviceId].name : null,
    budgetEnabled: runtime.value.chargerBudgetEnabled,
    proposedCents: chargerTrack.budget?.proposedCents ?? null, confirmedCents: chargerTrack.budget?.confirmedCents ?? null,
    purchasable: purchaseTrack !== null && !adapterInProgress, permitted: adapterPermitted,
  } : undefined;
  const voiceOptions = purchaseTrack && !adapterInProgress ? [{productId:CHARGER_PRODUCT_ID,variantId:CHARGER_VARIANT_ID,title:"Apple 70W USB-C Power Adapter",priceCents:5900,description:language === "es" ? "Cable vendido por separado." : "Cable sold separately.",recommended:true}] : chargerOpen ? [] : eligibleLines.filter(line => line.quotable).map(line => ({ productId: line.productId, variantId: line.variantId, title: line.title, priceCents: line.unitAmountCents, ...voiceAiOption(line, suggestedVariantIds.includes(line.variantId), language) }));
  const workloadReply = !chargerOpen && lastAssistant?.text === "review" ? workloadGuidance(lastShopper?.text ?? "", language) : null;
  const spokenReply = alert ?? (permissionRefusal ? language === "es" ? "Esta compra necesita un permiso válido. Diga abrir permisos." : "This purchase needs a valid permission. Say open permissions." : voiceCharger ? chargerVoiceGuidance(voiceCharger,language) : workloadReply ?? (showConfirm
    ? language === "es"
      ? `Entendí: ${copy.uses[journey.draft!.prefilledUse!]}, con un presupuesto de ${journey.draft!.prefilledBudgetDollars} dólares. Revise sus opciones. Diga confirmo mis opciones o use el botón de la página.`
      : `I understood: ${copy.uses[journey.draft!.prefilledUse!]}, with a budget of ${journey.draft!.prefilledBudgetDollars} dollars. Check your choices. Say confirm my choices or use the button on the page.`
    : suggestionsRendered && !chargerOpen
      ? (permissionRefusal
        ? language === "es" ? "Esta compra necesita un permiso válido. Diga abrir permisos." : "This purchase needs a valid permission. Say open permissions."
        : voiceOptionsSummary(voiceOptions, language))
      : lastAssistant ? assistantText(lastAssistant.text, copy, language) : copy.prompt));
  const voiceReplyKey = [journey.draft?.draftId ?? "new", journey.draft?.version ?? 0, confirmedUse, confirmedBudgetDollars, language, notice, permissionRefusal ?? "", chargerTrack?.revision ?? 0, chargerTrack?.state ?? "", typeof query.voiceTurn === "string" ? query.voiceTurn.slice(0, 64) : ""].join(":");

  return (
    <div lang={language} className={`needs-layout flex flex-col gap-6${purchaseTrack ? " charger-rec-shell" : ""}`}>
      <DocumentLanguageSync language={language} />
      <SkipToCurrentStep copy={copy} targetId={currentTargetId} />
      {!expiredDraft ? <HandsFreeControls language={language} reply={spokenReply} notice={Boolean(alert || permissionRefusal)} replyKey={voiceReplyKey} stage={voiceCharger ? purchaseTrack && !adapterInProgress ? "options" : "charger" : suggestionsRendered ? "options" : "needs"} charger={voiceCharger} options={voiceOptions} /> : null}
      <header className="needs-unified-header">
      {journey.draft ? <NeedsLanguageChoice language={language} target={language === "en" ? "es" : "en"} csrfToken={session.csrfToken} draft={journey.draft} busy={journey.draft.interpretationPending || journey.draft.recommendationClaim === "pending"} /> : null}
      {!purchaseTrack ? <h1
        id={currentTarget === "heading" ? NEEDS_PAGE_HEADING_ID : undefined}
        tabIndex={currentTarget === "heading" ? -1 : undefined}
        className="text-3xl font-semibold"
      >
        {copy.pageTitle}
      </h1> : null}
      {!purchaseTrack && currentStep ? <GuidedProgress copy={copy} current={currentStep} /> : null}
      </header>
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
      {purchaseTrack && journey.draft ? (
        <>
          {adapterInProgress ? <p role="status">{language === "es" ? "Una compra anterior ya está en curso o su resultado no se conoce. Cambiar el dispositivo o presupuesto no cancela esa compra. Revise su resultado antes de volver a comprar." : "An earlier purchase is already underway or its result is unknown. Changing the device or budget does not cancel that purchase. Check its result before buying again."}</p> : null}
          <ChargerRecommendationLayout language={language} csrfToken={session.csrfToken} track={purchaseTrack} permitted={adapterPermitted} headingId={NEEDS_PAGE_HEADING_ID}
            compatibility={<ChargerInformation language={language} selection={selectDevice(EVIDENCE, { identifier: purchaseTrack.deviceId! })} showDeviceSelector={false} showScrollHint embedded />}
            conversation={<NeedsConversation copy={copy} language={language} csrfToken={session.csrfToken} draft={journey.draft} mode="reply" turns={journey.conversation?.turns} chargerClarification externalAiNotice={externalAiNotice} aiLimited={aiLimited} />}
          />
        </>
      ) : chargerOpen && journey.draft && chargerTrack ? (
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
            afterHistory={<>
              {modelGuide ? <section aria-labelledby="model-guide-heading" className="rounded border border-blue-200 bg-white p-5">
        <h2 id="model-guide-heading" className="text-xl font-semibold">{language === "es" ? "Cargador para su MacBook Pro de 2019" : "Charger for your 2019 MacBook Pro"}</h2>
        <p>{modelGuide.summary}</p>
        <p>{language === "es" ? "Precio de referencia del adaptador: $79.00 USD. No incluye cable, impuestos ni envío. El precio y la disponibilidad pueden cambiar." : "Adapter reference price: $79.00 USD. Cable, tax and shipping are not included. Price and availability may change."}</p>
        <p><a href={modelGuide.productUrl} className="underline">{language === "es" ? "Ver adaptador de 96W en Apple" : "View 96W adapter at Apple"}</a></p>
        <p><a href={modelGuide.supportUrl} className="underline">{language === "es" ? "Fuente: guía de cargadores de Apple" : "Source: Apple charger guidance"}</a></p>
        <p>{language === "es" ? "Este enlace abre el sitio de Apple. ShopAccess no realiza ni verifica una compra allí." : "This link opens Apple's website. ShopAccess does not place or verify a purchase there."}</p>
      </section> : null}
              {chargerTrack.state === "task_choice" ? (
                <ChargerConversationControls budgetEnabled={runtime.value.chargerBudgetEnabled} csrfToken={session.csrfToken} language={language} track={chargerTrack} />
              ) : null}
            </>}
          />
          {chargerTrack.state === "task_choice" ? null : (
            <ChargerConversationControls budgetEnabled={runtime.value.chargerBudgetEnabled} csrfToken={session.csrfToken} language={language} track={chargerTrack} />
          )}
          {adapterInProgress ? <p role="status">{language === "es" ? "Una compra anterior ya está en curso o su resultado no se conoce. Cambiar el dispositivo o presupuesto no cancela esa compra. Revise su resultado antes de volver a comprar." : "An earlier purchase is already underway or its result is unknown. Changing the device or budget does not cancel that purchase. Check its result before buying again."}</p> : null}
          {chargerTrack.state === "confirmed" && chargerTrack.deviceId === "Mac14,2" && chargerTrack.budget?.confirmedCents !== null && chargerTrack.budget?.confirmedCents !== undefined && chargerTrack.budget.confirmedCents < 5900 ? <p role="status">{language === "es" ? "No hay un adaptador recomendado dentro de su presupuesto confirmado. El adaptador de demostración cuesta $59.00; puede cambiar su presupuesto o detener esta búsqueda." : "No recommended adapter fits your confirmed budget. The demo adapter costs $59.00; you can change your budget or stop this search."}</p> : null}
          {chargerTrack.state === "confirmed" && chargerTrack.deviceId ? (
            <details open={purchaseTrack === null} className="rounded-lg border border-blue-200 p-4">
              <summary className="cursor-pointer font-medium">{language === "es" ? "Ver detalles de compatibilidad" : "View compatibility details"}</summary>
              <ChargerInformation language={language} selection={selectDevice(EVIDENCE, { identifier: chargerTrack.deviceId })} showDeviceSelector={false} showScrollHint />
            </details>
          ) : null}
        </>
      ) : null}
      <div className="needs-shopping-columns">
        <div className="needs-shopping-left">
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
            secondary
          />
            <a className="needs-results-jump" href="#guided-advisory-heading">
            {copy.resultsJump(eligibleLines.length)}
          </a>
          </>
        ) : null}
<aside className="needs-side">
        <p>
          <Link href={`/${language}/shop/permissions`} prefetch={false} className="underline">
            {permissionCopy(language).managePermissions}
          </Link>
        </p>
        {!chargerOpen ? <details className="needs-handoff">
          <summary><Icon name="plug" />{language === "es" ? "¿Busca un cargador?" : "Looking for a charger?"}</summary>
          <h2 id="needs-handoff-heading">
            <Link href={`/${language}/shop/chargers`} prefetch={false} className="underline">
              {chargerCopy(language).needsLink}
            </Link>
          </h2>
          <ChargerDeviceHandoff language={language} />
        </details> : null}
        <p>
          <Link href="/" prefetch={false} className="underline">
            {copy.navigationHome}
          </Link>
        </p>
      </aside>
        </div>
        <div className="needs-shopping-right">
      {!chargerOpen && journey.draft && confirmedUse && confirmedBudgetDollars ? (
        <>


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

        </div>
      </div>
      {pairedAccessShown ? (
        <PairedAccess
          language={language}
          csrfToken={session.csrfToken}
          grants={runtime.value.pairing.list(session.id, runtime.value.clock())}
          revokedLabel={revokedLabel}
        />
      ) : null}

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
