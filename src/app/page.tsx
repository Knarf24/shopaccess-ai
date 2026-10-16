import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import { MerchantProductCard } from "@/components/MerchantProductCard";
import "./guided-presentation.css";
import { PreferencesForm } from "@/components/PreferencesForm";
import { SessionNotice } from "@/components/SessionNotice";
import { GuidedLanguageChoice } from "@/components/mock-journey/GuidedLanguageChoice";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import type { MerchantCatalog } from "@/lib/catalog/schemas";
import { loadPgCatalog } from "@/server/pg-views";
import { guardPage, openApplication } from "@/server/runtime-access";
import { StoreUnavailable } from "@/components/StoreUnavailable";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function HomeHeader() {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-3xl font-semibold">ShopAccess AI</h1>
      <p className="text-lg">Help choosing a first laptop, with the evidence behind every suggestion.</p>
    </header>
  );
}

/** The notice, the preferences form and the catalog. The same three sections in both modes; only the catalog's source differs. */
function Storefront({ catalog }: { catalog: MerchantCatalog }) {
  return (
    <>
      <section aria-labelledby="notice-heading" className="sandbox-notice rounded-lg border-2 border-amber-600 bg-amber-50 p-4 text-amber-950">
        <h2 id="notice-heading" className="font-semibold">
          Simulated Sandbox shopping catalog
        </h2>
        <p className="text-sm">{journeyCopy("en").catalogNotice}</p>
      </section>

      <section aria-labelledby="start-heading" className="direct-entry flex flex-col gap-3">
        <h2 id="start-heading" className="text-2xl font-semibold">
          Tell us what you need
        </h2>
        <PreferencesForm />
      </section>

      <section aria-labelledby="catalog-heading" className="catalog-board flex flex-col gap-4">
        <h2 id="catalog-heading" className="text-2xl font-semibold">
          Demo laptops
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {catalog.products.map((product) => (
            <MerchantProductCard key={product.productId} product={product} merchantName={catalog.merchant.displayName} />
          ))}
        </div>
      </section>
    </>
  );
}

/** PostgreSQL mode, while the database cannot be used: this notice and nothing else. Never the fixture catalog. */
function NotAvailable() {
  return (
    <p role="alert" className="rounded border-2 border-red-700 p-3">
      The shop is not available right now. Please try again later.
    </p>
  );
}

async function HomeContentUnguarded({ searchParams }: { searchParams: SearchParams }) {
  // Which mode this process serves is decided when it runs, never when the page is built.
  await connection();
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  const application = opened;
  if (application.mode === "mock") {
    return (
      <main className="guided-presentation">
        <div className="presentation-column">
          <HomeHeader />
          <section className="home-hero">
            <GuidedLanguageChoice />
            <figure className="demo-illustration">
              <img src="/catalog/aspire-14-ai.svg" alt="Acer Aspire 14 AI, illustration" width={320} height={200} />
              <figcaption>Simplified illustration of the Acer Aspire 14 AI from the demo catalog. It is not a product photo.</figcaption>
            </figure>
          </section>
          <Storefront catalog={DEMO_MERCHANT_CATALOG} />
        </div>
      </main>
    );
  }
  if (application.mode === "invalid") {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-10">
        <HomeHeader />
        <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />
      </main>
    );
  }

  const query = await searchParams;
  const services = await application.runtime.services();
  if (!services) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-10">
        <HomeHeader />
        <NotAvailable />
      </main>
    );
  }
  const catalog = await loadPgCatalog(services);
  if (!catalog) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-10">
        <HomeHeader />
        <NotAvailable />
      </main>
    );
  }
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-10">
      <HomeHeader />
      {query.session === "ended" ? <SessionNotice kind="ended" /> : null}
      <Storefront catalog={catalog} />
      <p>
        <Link href="/checkouts" prefetch={false} className="underline">
          Your checkouts
        </Link>
      </p>
    </main>
  );
}

export default function Home({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading the shop…</p>}>
      <HomeContent searchParams={searchParams} />
    </Suspense>
  );
}

/** A save refused while rendering shows the unavailable notice, never a partial or success view. */
async function HomeContent(props: Parameters<typeof HomeContentUnguarded>[0]) {
  return guardPage(() => HomeContentUnguarded(props), () => <StoreUnavailable />);
}
