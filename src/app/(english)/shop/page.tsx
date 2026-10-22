import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import { PreferencesForm } from "@/components/PreferencesForm";
import { SessionNotice } from "@/components/SessionNotice";
import { profileCopy } from "@/lib/i18n/profile-copy";
import { isPermissionRefusal } from "@/lib/i18n/permission-copy";
import { ShopListing } from "./shop-listing";
import type { PgRuntime } from "@/server/pg-runtime";
import { buildPgShoppingView, pgCookieHeader, resolvePgPageSession } from "@/server/pg-views";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { buildShoppingView, parsePreferences, preferencesQuery } from "@/server/shopping";
import { messageFor, resolvePageSession } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type Query = Record<string, string | string[] | undefined>;

/**
 * PostgreSQL mode (specification 19.19): the same recommendations, on the catalog the database holds. Loading this
 * page admits no session, rotates none and starts no checkout.
 */
async function PgShopContent({ query, runtime }: { query: Query; runtime: PgRuntime }) {
  const notAvailable = (
    <p role="alert" className="rounded border-2 border-red-700 p-3">
      The shop is not available right now. Please try again later.
    </p>
  );
  const services = await runtime.services();
  if (!services) return notAvailable;

  const preferences = parsePreferences(query.use, query.budget);
  if (!preferences) {
    return (
      <>
        <p role="alert">Choose what you will use the laptop for and enter a budget between 10 and 99999 dollars.</p>
        <PreferencesForm />
      </>
    );
  }

  const session = await resolvePgPageSession(services, await pgCookieHeader());
  if (session === "UNAVAILABLE") return notAvailable;
  if (!session.context) {
    // A cookie that cannot be used is never replaced without the shopper asking for it.
    if (session.presence === "PRESENT") redirect("/?session=ended");
    if (query.started !== "1") redirect(`/session/start?${preferencesQuery(preferences)}`);
    return (
      <p role="alert">
        Your browser did not keep the secure session cookie, so the demo cannot continue. The cookie is only accepted over HTTPS, or
        on http://localhost in browsers that treat localhost as secure (Chrome and Firefox do).
      </p>
    );
  }

  const page = await buildPgShoppingView(services, preferences);
  if (page.kind !== "OK") return notAvailable;
  const error = messageFor(typeof query.error === "string" ? query.error : undefined);
  return (
    <>
      <ShopListing
        view={page.value}
        preferences={preferences}
        csrfToken={session.context.session.csrfToken}
        error={error}
        refusal={null}
        sessionNotice={session.context.session.keyStatus === "VERIFY_ONLY" ? <SessionNotice kind="rotate" csrfToken={session.context.session.csrfToken} /> : null}
      />
      <p>
        <Link href="/checkouts" prefetch={false} className="underline">
          Your checkouts
        </Link>
      </p>
    </>
  );
}

async function ShopContentUnguarded({ searchParams }: { searchParams: SearchParams }) {
  // Everything below depends on the request and the current time, so it is rendered per request.
  await connection();
  const query = await searchParams;
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  const application = opened;
  if (application.mode === "postgres") return <PgShopContent query={query} runtime={application.runtime} />;
  if (application.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;
  const runtime = runtimeOf(application);
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;

  const admissionLocation = protectedAdmissionLocation(
    runtime.value.admission,
    (await headers()).get("cookie"),
    runtime.value.clock().getTime(),
    typeof query.lang === "string" ? query.lang : undefined,
  );
  if (admissionLocation) redirect(admissionLocation);

  const preferences = parsePreferences(query.use, query.budget);
  if (!preferences) {
    return (
      <>
        <p role="alert">Choose what you will use the laptop for and enter a budget between 10 and 99999 dollars.</p>
        <PreferencesForm />
      </>
    );
  }

  const session = await resolvePageSession(runtime.value);
  if (!session) {
    if (query.started !== "1") redirect(`/session/start?${preferencesQuery(preferences)}`);
    return (
      <p role="alert">
        Your browser did not keep the secure session cookie, so the demo cannot continue. The cookie is only accepted over HTTPS, or
        on http://localhost in browsers that treat localhost as secure (Chrome and Firefox do).
      </p>
    );
  }

  const view = await buildShoppingView(runtime.value, preferences);
  const errorCode = typeof query.error === "string" ? query.error : undefined;
  // F07 refusals (M2-3) get their own message and a link to purchase permissions. This page is English only.
  const refusal = isPermissionRefusal(errorCode) ? errorCode : null;
  const error = refusal ? null : messageFor(errorCode);

  return (
    <>
      <ShopListing view={view} preferences={preferences} csrfToken={session.csrfToken} error={error} refusal={refusal} />
      <p>
        <Link href="/en/shop/profile" prefetch={false}>{profileCopy("en").shopLink}</Link>
      </p>
    </>
  );
}

export default function ShopPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-10">
      <h1 className="text-3xl font-semibold">Laptops and readiness assessments</h1>
      <Suspense fallback={<p>Loading assessments…</p>}>
        <ShopContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/** A save refused while rendering shows the unavailable notice, never a partial or success view. */
async function ShopContent(props: Parameters<typeof ShopContentUnguarded>[0]) {
  return guardPage(() => ShopContentUnguarded(props), () => <StoreUnavailable />);
}
