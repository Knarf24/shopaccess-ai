import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { CheckoutActions } from "@/components/CheckoutActions";
import { ConfigNotice } from "@/components/ConfigNotice";
import { ConfirmationSummary } from "@/components/ConfirmationSummary";
import { GuidedProgress } from "@/components/mock-journey/GuidedProgress";
import { MockReviewGuidance } from "@/components/mock-journey/MockReviewGuidance";
import { SessionNotice } from "@/components/SessionNotice";
import { SandboxCheckoutActions, SimulatedPaymentPanel } from "@/components/SimulatedPaymentPanel";
import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import "../../guided-presentation.css";
import type { PgRuntime } from "@/server/pg-runtime";
import { buildPgCheckoutView, PG_STATUS_LABELS, pgCookieHeader, resolvePgPageSession } from "@/server/pg-views";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { buildCheckoutView, messageFor, resolvePageSession } from "@/server/views";

interface PageProps {
  params: Promise<{ intentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type Query = Record<string, string | string[] | undefined>;

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

  return (
    <>
      {error ? <p role="alert" className="rounded border-2 border-red-700 p-3">{error}</p> : null}
      {notice ? <p role="status" className="rounded border-2 border-green-800 p-3">{notice}</p> : null}
      {session.context.session.keyStatus === "VERIFY_ONLY" ? <SessionNotice kind="rotate" csrfToken={csrfToken} /> : null}

      {view.challenge ? (
        <ConfirmationSummary challenge={view.challenge} csrfToken={csrfToken} action={`/checkout/${view.intentId}/confirm`} />
      ) : (
        <section aria-labelledby="quote-heading" className="rounded-lg border border-zinc-400 p-4">
          <h2 id="quote-heading" className="text-xl font-semibold">
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
          {view.quoteStale ? <p role="alert">{messageFor("QUOTE_STALE_CATALOG")}</p> : null}
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
  const [{ intentId }, query] = await Promise.all([params, searchParams]);
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
    typeof query.lang === "string" ? query.lang : undefined,
  );
  if (admissionLocation) redirect(admissionLocation);

  const session = await resolvePageSession(runtime.value);
  if (!session) redirect("/");
  // A checkout owned by another session is indistinguishable from one that does not exist.
  const view = await buildCheckoutView(runtime.value, session, intentId);
  if (!view) notFound();

  const copy = journeyCopy(view.interfaceLanguage ?? "en");
  const errorCode = typeof query.error === "string" ? query.error : undefined;
  const error =
    errorCode === "APPROVAL_NOT_CONFIRMED"
      ? copy.sandboxCheckout.approvalNotConfirmed
      : errorCode === "PAYEE_MISMATCH"
        ? copy.sandboxCheckout.payeeMismatch
        : messageFor(errorCode);
  const noticeCode = typeof query.notice === "string" ? query.notice : undefined;
  const notice = noticeCode === "CAPTURED" ? null : messageFor(noticeCode);

  return (
    <main className="guided-presentation">
      <div className="presentation-column presentation-column-narrow">
      <h1 className="text-3xl font-semibold">Demo checkout</h1>
      {error ? <p role="alert" className="rounded border-2 border-red-700 p-3">{error}</p> : null}
      {notice ? <p role="status" className="rounded border-2 border-green-800 p-3">{notice}</p> : null}
      <GuidedProgress copy={journeyCopy(view.interfaceLanguage ?? "en")} current="purchase" />
      {view.interfaceLanguage ? <MockReviewGuidance language={view.interfaceLanguage} /> : null}

      {view.challenge ? (
        <ConfirmationSummary
          challenge={view.challenge}
          csrfToken={session.csrfToken}
          action={`/checkout/${view.intentId}/confirm`}
          language={view.interfaceLanguage ?? undefined}
        />
      ) : view.quote ? (
        <section aria-labelledby="quote-heading" className="rounded-lg border border-zinc-400 p-4">
          <h2 id="quote-heading" className="text-xl font-semibold">
            Quote
          </h2>
          <p>
            {view.itemTitle ?? "Item no longer in the demo catalog"}, quantity {view.quote.quantity}, sold by {view.merchantName}.
          </p>
          <p>
            Total {formatUsd(view.quote.totalCents)} {view.quote.currency}. Tax and shipping are $0.00 as an assumption of this Sandbox
            demonstration; nothing is shipped.
          </p>
          <p>{journeyCopy(view.interfaceLanguage ?? "en").catalogNotice}</p>
          {view.challengeProblem ? <p role="alert">{messageFor(view.challengeProblem)}</p> : null}
        </section>
      ) : null}

      {runtime.value.paymentMode === "sandbox" ? (
        <SandboxCheckoutActions view={view} csrfToken={session.csrfToken} copy={copy.sandboxCheckout} />
      ) : (
        <SimulatedPaymentPanel view={view} csrfToken={session.csrfToken} />
      )}
      <p>
        <Link href="/" prefetch={false} className="underline">
          Back to the start
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
