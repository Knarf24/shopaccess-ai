import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import { ExternalProductCard } from "@/components/ExternalProductCard";
import { PreferencesForm } from "@/components/PreferencesForm";
import { ReadinessPanel } from "@/components/ReadinessPanel";
import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { getRuntime } from "@/server/runtime";
import { buildShoppingView, parsePreferences, preferencesQuery, USE_LABELS } from "@/server/shopping";
import { messageFor, resolvePageSession } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function ShopContent({ searchParams }: { searchParams: SearchParams }) {
  // Everything below depends on the request and the current time, so it is rendered per request.
  await connection();
  const query = await searchParams;
  const runtime = getRuntime();
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;

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

  return (
    <>
      {error ? <p role="alert" className="rounded border-2 border-red-700 p-3">{error}</p> : null}
      <p>
        Showing demo laptops for <strong>{USE_LABELS[preferences.use]}</strong> with a budget of{" "}
        <strong>{formatUsd(preferences.budgetCents)}</strong>.
      </p>
      <PreferencesForm use={preferences.use} budget={preferences.budgetDollars} />
      {view.assistantMessage ? (
        <p className="text-sm">
          <span className="font-medium">Assistant (local mock, advisory only): </span>
          {view.assistantMessage}
        </p>
      ) : null}

      <section aria-labelledby="demo-heading" className="flex flex-col gap-4">
        <h2 id="demo-heading" className="text-2xl font-semibold">
          Demo store laptops (simulated Sandbox catalog)
        </h2>
        <p className="text-sm">Sold by {view.merchantName}. Fictional products and prices. Nothing is shipped.</p>
        <ul className="flex flex-col gap-4">
          {view.variants.map(({ product, variant, assessment, explanation, quotable }) => (
            <li key={variant.variantId} className="flex flex-col gap-3 rounded-lg border border-zinc-400 p-4">
              <h3 className="text-lg font-semibold">
                {product.title} — {variant.label}
              </h3>
              <p>
                {formatUsd(variant.unitAmountCents)} USD · {variant.specs.cpu} · {variant.specs.screenInches} inch · {variant.specs.weightKg} kg
              </p>
              <ReadinessPanel assessment={assessment} explanation={explanation?.explanation ?? null} />
              {quotable ? (
                <form method="post" action="/checkout/start">
                  <input type="hidden" name="csrfToken" value={session.csrfToken} />
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
