import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AdvisoryRecommendations } from "@/components/AdvisoryRecommendations";
import { ConfigNotice } from "@/components/ConfigNotice";
import { ExternalProductCard } from "@/components/ExternalProductCard";
import { PreferencesForm } from "@/components/PreferencesForm";
import { ReadinessPanel } from "@/components/ReadinessPanel";
import { SessionNotice } from "@/components/SessionNotice";
import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import type { PgRuntime } from "@/server/pg-runtime";
import { buildPgShoppingView, pgCookieHeader, resolvePgPageSession } from "@/server/pg-views";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { buildShoppingView, parsePreferences, preferencesQuery, USE_LABELS, type ShopperPreferences, type ShoppingView } from "@/server/shopping";
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
      {session.context.session.keyStatus === "VERIFY_ONLY" ? <SessionNotice kind="rotate" csrfToken={session.context.session.csrfToken} /> : null}
      <ShopListing view={page.value} preferences={preferences} csrfToken={session.context.session.csrfToken} error={error} />
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
  const error = messageFor(typeof query.error === "string" ? query.error : undefined);

  return <ShopListing view={view} preferences={preferences} csrfToken={session.csrfToken} error={error} />;
}

/** The recommendations as shown in both modes: the same markup, whichever catalog the view was built on. */
function ShopListing({ view, preferences, csrfToken, error }: { view: ShoppingView; preferences: ShopperPreferences; csrfToken: string; error: string | null }) {
  return (
    <>
      {error ? <p role="alert" className="rounded border-2 border-red-700 p-3">{error}</p> : null}
      <p>
        Showing demo laptops for <strong>{USE_LABELS[preferences.use]}</strong> with a budget of{" "}
        <strong>{formatUsd(preferences.budgetCents)}</strong>.
      </p>
      <PreferencesForm use={preferences.use} budget={preferences.budgetDollars} />
      {view.recommendations !== undefined ? (
        <AdvisoryRecommendations message={view.assistantMessage} recommendations={view.recommendations} />
      ) : view.assistantMessage ? (
        <p className="text-sm">
          <span className="font-medium">Assistant (local mock, advisory only): </span>
          {view.assistantMessage}
        </p>
      ) : null}

      <section aria-labelledby="demo-heading" className="flex flex-col gap-4">
        <h2 id="demo-heading" className="text-2xl font-semibold">
          Demo store laptops (simulated Sandbox catalog)
        </h2>
        <p className="text-sm">
          Sold by {view.merchantName}. {journeyCopy("en").catalogNotice}
        </p>
        <ul className="flex flex-col gap-4">
          {view.variants.map(({ product, variant, assessment, explanation, quotable }) => (
            <li key={variant.variantId} className="flex flex-col gap-3 rounded-lg border border-zinc-400 p-4">
              <h3 className="text-lg font-semibold">
                {product.title} — {variant.label}
              </h3>
              <p>
                Fixed demo price {formatUsd(variant.unitAmountCents)} USD · {variant.specs.cpu} · {variant.specs.screenInches} inch ·{" "}
                {variant.specs.weightKg} kg
              </p>
              <ReadinessPanel
                assessment={assessment}
                explanation={explanation?.explanation ?? null}
                explanationLabel={view.explanationLabel}
              />
              {quotable ? (
                <form method="post" action="/checkout/start">
                  <input type="hidden" name="csrfToken" value={csrfToken} />
                  <input type="hidden" name="productId" value={product.productId} />
                  <input type="hidden" name="variantId" value={variant.variantId} />
                  <input type="hidden" name="quantity" value="1" />
                  <input type="hidden" name="use" value={preferences.use} />
                  <input type="hidden" name="budget" value={preferences.budgetDollars} />
                  <button type="submit" className="rounded bg-blue-800 px-4 py-2 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                    Get a demo quote for {product.title}, {variant.label}
                  </button>
                </form>
              ) : (
                <p className="text-sm">Not available, so it cannot be quoted.</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="external-heading" className="flex flex-col gap-4 border-t-4 border-zinc-500 pt-6">
        <h2 id="external-heading" className="text-2xl font-semibold">
          Found elsewhere (external sellers, mock data)
        </h2>
        <p className="text-sm">
          These listings come from other sellers and are not part of the demo store. Their details are unverified and they cannot be
          bought or quoted here.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {view.external.map((product) => (
            <ExternalProductCard key={product.externalId} product={product} />
          ))}
        </div>
      </section>
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
