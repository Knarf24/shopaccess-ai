import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { CheckoutActions } from "@/components/CheckoutActions";
import { Icon } from "@/components/Icon";
import { ConfigNotice } from "@/components/ConfigNotice";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { ConfirmationSummary } from "@/components/ConfirmationSummary";
import { GuidedProgress } from "@/components/mock-journey/GuidedProgress";
import { MockReviewGuidance } from "@/components/mock-journey/MockReviewGuidance";
import { SessionNotice } from "@/components/SessionNotice";
import { SandboxCheckoutActions, SimulatedPaymentPanel } from "@/components/SimulatedPaymentPanel";
import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { savedLanguageRedirect } from "@/lib/i18n/locale-path";
import { documentLocale } from "@/lib/i18n/locale-segment";
import { sellerName } from "@/lib/i18n/seller-name";
import { PermissionRefusal } from "@/components/PermissionRefusal";
import "../../../guided-presentation.css";
import "../../../ui-refresh.css";
import { CHECKOUT_ALERT_ID, CHECKOUT_CONFIRM_HEADING_ID, CHECKOUT_NOTICE_ID, CHECKOUT_QUOTE_HEADING_ID, CHECKOUT_QUOTE_PROBLEM_ID, checkoutCurrentTargetId, checkoutMessages } from "./checkout-targets";
import type { PgRuntime } from "@/server/pg-runtime";
import { buildPgCheckoutView, PG_STATUS_LABELS, pgCookieHeader, resolvePgPageSession } from "@/server/pg-views";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { buildCheckoutView, checkoutMessage, messageFor, resolvePageSession } from "@/server/views";

interface PageProps {
  params: Promise<{ lang: string; intentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type Query = Record<string, string | string[] | undefined>;

function SkipToCurrentStep({ label, targetId }: { readonly label: string; readonly targetId: string }) {
  return (
    <a className="skip-link" href={`#${targetId}`}>
      {label}
    </a>
  );
}

function CheckoutFrame({ children }: { readonly children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <h1 className="text-3xl font-semibold">Demo checkout</h1>
      {children}
    </main>
  );
}

/**
 * PostgreSQL mode (specification 19.19). Loading this page reads the checkout and shows it. It issues no challenge
 * and changes no checkout: every action below is a form posting to a guarded route. The simulated payment panel
 * belongs to the mock alone and is not shown.
 */
async function PgCheckoutContent({ intentId, query, runtime }: { intentId: string; query: Query; runtime: PgRuntime }) {
  const notAvailable = (
    <p role="alert" className="rounded border-2 border-red-700 p-3">
      The shop is not available right now. Please try again later.
    </p>
  );
  const services = await runtime.services();
  if (!services) return notAvailable;

  const session = await resolvePgPageSession(services, await pgCookieHeader());
  if (session === "UNAVAILABLE") return notAvailable;
  if (!session.context) redirect(session.presence === "PRESENT" ? "/?session=ended" : "/");

  // A checkout owned by another session is indistinguishable from one that does not exist.
  const page = await buildPgCheckoutView(services, session.context, intentId);
  if (page.kind === "NOT_FOUND") notFound();
  if (page.kind !== "OK") return notAvailable;
  const view = page.value;
  const csrfToken = session.context.session.csrfToken;

  const error = messageFor(typeof query.error === "string" ? query.error : undefined);
  const notice = messageFor(typeof query.notice === "string" ? query.notice : undefined);

  const skipTarget = checkoutCurrentTargetId({
    alert: Boolean(error),
    notice: Boolean(notice),
    confirmation: Boolean(view.challenge),
    quoteProblem: !view.challenge && view.quoteStale,
    quoteStep: true,
    paymentHeadingId: null,
  });

  return (
    <>
      <SkipToCurrentStep label={journeyCopy("en").skipToCurrentStep} targetId={skipTarget} />
      {error ? <p id={CHECKOUT_ALERT_ID} tabIndex={-1} role="alert" className="rounded border-2 border-red-700 p-3">{error}</p> : null}
      {notice ? <p id={CHECKOUT_NOTICE_ID} tabIndex={-1} role="status" className="rounded border-2 border-green-800 p-3">{notice}</p> : null}
      {session.context.session.keyStatus === "VERIFY_ONLY" ? <SessionNotice kind="rotate" csrfToken={csrfToken} /> : null}

      {view.challenge ? (
        <ConfirmationSummary
          challenge={view.challenge}
          csrfToken={csrfToken}
          action={`/checkout/${view.intentId}/confirm`}
          headingTabIndex={skipTarget === CHECKOUT_CONFIRM_HEADING_ID ? -1 : undefined}
        />
      ) : (
        <section aria-labelledby="quote-heading" className="rounded-lg border border-zinc-400 p-4">
          <h2 id={CHECKOUT_QUOTE_HEADING_ID} tabIndex={-1} className="text-xl font-semibold">
            Quote
          </h2>
          <p>
            {view.itemTitle}, quantity {view.quantity}, sold by {view.merchantName}.
          </p>
          <p>
            Total {formatUsd(view.totalCents)} {view.currency}. Tax and shipping are $0.00 as an assumption of this Sandbox
            demonstration; nothing is shipped.
          </p>
          <p>{journeyCopy("en").catalogNotice}</p>
          <p>
            Status: {PG_STATUS_LABELS[view.effectiveStatus]}. Quote valid until <time dateTime={view.quoteExpiresAt}>{view.quoteExpiresAt}</time>.
          </p>
          {view.quoteStale ? <p id={CHECKOUT_QUOTE_PROBLEM_ID} tabIndex={-1} role="alert">{messageFor("QUOTE_STALE_CATALOG")}</p> : null}
        </section>
      )}

      <CheckoutActions intentId={view.intentId} actions={view.actions} csrfToken={csrfToken} />
      <p className="text-sm">Payment simulation is not part of this mode. No payment is taken and nothing is sent to a payment provider.</p>
      <p>
        <Link href="/checkouts" prefetch={false} className="underline">
          Your checkouts
        </Link>
      </p>
      <p>
        <Link href="/" prefetch={false} className="underline">
          Back to the start
        </Link>
      </p>
    </>
  );
}

async function CheckoutContentUnguarded({ params, searchParams }: PageProps) {
  // Everything below depends on the request and the current time, so it is rendered per request.
  await connection();
  const [{ lang, intentId }, query] = await Promise.all([params, searchParams]);
  const pathLanguage = documentLocale(lang);
  if (!pathLanguage) notFound();
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  const application = opened;
  if (application.mode === "postgres") {
    return (
      <CheckoutFrame>
        <PgCheckoutContent intentId={intentId} query={query} runtime={application.runtime} />
      </CheckoutFrame>
    );
  }
  if (application.mode === "invalid") {
    return (
      <CheckoutFrame>
        <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />
      </CheckoutFrame>
    );
  }
  const runtime = runtimeOf(application);
  if (!runtime.ok) {
    return (
      <CheckoutFrame>
        <ConfigNotice errors={runtime.error} />
      </CheckoutFrame>
    );
  }

  const admissionLocation = protectedAdmissionLocation(
    runtime.value.admission,
    (await headers()).get("cookie"),
    runtime.value.clock().getTime(),
    pathLanguage,
  );
  if (admissionLocation) redirect(admissionLocation);

  const session = await resolvePageSession(runtime.value);
  if (!session) redirect("/");
  // A checkout owned by another session is indistinguishable from one that does not exist.
  const view = await buildCheckoutView(runtime.value, session, intentId);
  if (!view) notFound();

  // The checkout's saved interface language (none recorded means English). A conflicting path redirects only after
  // the ownership check above, so a missing checkout never discloses another session's language.
  const language = view.interfaceLanguage ?? "en";
  const canonical = savedLanguageRedirect(pathLanguage, language, `/checkout/${intentId}`, query);
  if (canonical) redirect(canonical);
  const fixedEnglish = language === "en" ? undefined : "en";
  const copy = journeyCopy(language);
  const pageCopy = copy.checkoutPage;
  const markLang = (lang: "en" | "es") => (lang === language ? undefined : lang);
  const englishName = (name: string) => (language === "en" ? name : <span lang="en">{name}</span>);
  const errorCode = typeof query.error === "string" ? query.error : undefined;
  // F07 refusals (M2-3) are shown in the checkout's language, from the current state (checkoutMessages).
  const { refusal: permissionRefusal, underReview, showUrlError } = checkoutMessages(view, errorCode);
  const quoteProblem = checkoutMessage(view.challengeProblem ?? undefined, language);
  const error = !showUrlError
    ? null
    : errorCode === "APPROVAL_NOT_CONFIRMED"
      ? { text: copy.sandboxCheckout.approvalNotConfirmed, lang: language }
      : errorCode === "PAYEE_MISMATCH"
        ? { text: copy.sandboxCheckout.payeeMismatch, lang: language }
        : checkoutMessage(errorCode, language);
  const noticeCode = typeof query.notice === "string" ? query.notice : undefined;
  const notice = noticeCode === "CAPTURED" ? null : checkoutMessage(noticeCode, language);
  const sandbox = runtime.value.paymentMode === "sandbox";
  // A completed heading only after the existing verified capture state. Pending, declined and unknown never reach it.
  const completed = view.state === "CAPTURED_VERIFIED";
  const skipTarget = checkoutCurrentTargetId({
    alert: Boolean(error || permissionRefusal),
    notice: Boolean(notice),
    confirmation: Boolean(view.challenge),
    quoteProblem: !view.challenge && Boolean(view.quote && quoteProblem),
    quoteStep: !view.challenge && Boolean(view.quote) && view.state === "QUOTED",
    paymentHeadingId: sandbox ? "sandbox-heading" : "sim-heading",
  });

  return (
    <main className="guided-presentation ui-refresh" lang={language}>
      <DocumentLanguageSync language={language} />
      <div className="presentation-column presentation-column-narrow">
      <SkipToCurrentStep label={copy.skipToCurrentStep} targetId={skipTarget} />
      {completed ? (
        <>
          <h1 className="text-3xl font-semibold"><Icon name="check" className="ui-icon-lead" />{language === "es" ? "Compra completada" : "Purchase complete"}</h1>
          <p className="completed-note">
            {sandbox
              ? language === "es" ? "La app comprobó la captura en PayPal Sandbox. El dinero del Sandbox no es real." : "The app checked the PayPal Sandbox capture. Sandbox money is not real."
              : language === "es" ? "Esta fue una vista previa local. No se movió dinero y no se envía nada." : "This was a local preview. No money moved and nothing ships."}
          </p>
        </>
      ) : (
        <h1 className="text-3xl font-semibold">{pageCopy.heading}</h1>
      )}
      {error ? <p id={CHECKOUT_ALERT_ID} tabIndex={-1} role="alert" lang={markLang(error.lang)} className="rounded border-2 border-red-700 p-3">{error.text}</p> : null}
      {permissionRefusal ? <PermissionRefusal language={language} code={permissionRefusal} underReview={underReview} id={CHECKOUT_ALERT_ID} /> : null}
      {notice ? <p id={CHECKOUT_NOTICE_ID} tabIndex={-1} role="status" lang={markLang(notice.lang)} className="rounded border-2 border-green-800 p-3">{notice.text}</p> : null}
      <GuidedProgress copy={copy} current="purchase" complete={completed} />
      {view.interfaceLanguage && !completed ? <MockReviewGuidance language={view.interfaceLanguage} /> : null}

      {view.challenge ? (
        <ConfirmationSummary
          challenge={view.challenge}
          csrfToken={session.csrfToken}
          action={`/checkout/${view.intentId}/confirm`}
          language={view.interfaceLanguage ?? undefined}
          headingTabIndex={skipTarget === CHECKOUT_CONFIRM_HEADING_ID ? -1 : undefined}
        />
      ) : view.quote ? (
        <section aria-labelledby="quote-heading" className="rounded-lg border border-zinc-400 p-4">
          <h2 id={CHECKOUT_QUOTE_HEADING_ID} tabIndex={-1} className="text-xl font-semibold">
            {pageCopy.quoteHeading}
          </h2>
          <p>
            {view.itemTitle ? englishName(view.itemTitle) : pageCopy.missingItem}, {pageCopy.quantityWord} {view.quote.quantity}, {pageCopy.soldBy}{" "}
            {sellerName(view.merchantName, language)}.
          </p>
          <p>
            {pageCopy.totalLabel} {formatUsd(view.quote.totalCents)} {view.quote.currency}. {pageCopy.taxNote}
          </p>
          <p>{copy.catalogNotice}</p>
          {quoteProblem ? <p id={CHECKOUT_QUOTE_PROBLEM_ID} tabIndex={-1} role="alert" lang={markLang(quoteProblem.lang)}>{quoteProblem.text}</p> : null}
        </section>
      ) : null}

      {sandbox ? (
        <SandboxCheckoutActions view={view} csrfToken={session.csrfToken} copy={copy.sandboxCheckout} />
      ) : (
        <SimulatedPaymentPanel view={view} csrfToken={session.csrfToken} lang={fixedEnglish} />
      )}
      <p>
        <Link href="/" prefetch={false} className="underline">
          {copy.navigationHome}
        </Link>
      </p>
      </div>
    </main>
  );
}

export default function CheckoutPage(props: PageProps) {
  return (
    <Suspense fallback={<p>Loading checkout…</p>}>
      <CheckoutContent {...props} />
    </Suspense>
  );
}

/** A save refused while rendering shows the unavailable notice, never a partial or success view. */
async function CheckoutContent(props: Parameters<typeof CheckoutContentUnguarded>[0]) {
  return guardPage(() => CheckoutContentUnguarded(props), () => <StoreUnavailable />);
}
