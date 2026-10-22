import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import "../../../guided-presentation.css";
import { ChargerInformation } from "@/components/ChargerInformation";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { ConfigNotice } from "@/components/ConfigNotice";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { EVIDENCE } from "@/lib/compatibility/evidence";
import { selectDevice } from "@/lib/compatibility/rules";
import { chargerCopy } from "@/lib/i18n/charger-copy";
import { documentLocale } from "@/lib/i18n/locale-segment";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type PageParams = Promise<{ lang: string }>;

const one = (value: string | string[] | undefined, max: number) => (typeof value === "string" && value.length <= max ? value : "");

/**
 * GET /{lang}/shop/chargers: charger information (F03 information slice). The path language is the page language.
 * Reads the device query and the curated evidence: no session, profile, provider, extension or payment.
 * PostgreSQL mode says the page is unavailable and does not ask for services.
 */
async function ChargersContentUnguarded({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  await connection();
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  const language = documentLocale(lang);
  if (!language) notFound();
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  if (opened.mode === "postgres") {
    return (
      <div lang={language}>
        <DocumentLanguageSync language={language} />
        <h1 className="text-3xl font-semibold">{chargerCopy(language).pageTitle}</h1>
        <p role="alert">{chargerCopy(language).unavailable}</p>
      </div>
    );
  }
  if (opened.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;
  const runtime = runtimeOf(opened);
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;
  const admissionLocation = protectedAdmissionLocation(runtime.value.admission, (await headers()).get("cookie"), runtime.value.clock().getTime(), language);
  if (admissionLocation) redirect(admissionLocation);
  const selection = selectDevice(EVIDENCE, { device: one(query.device, 40), identifier: one(query.identifier, 40) });
  return (
    <>
      <DocumentLanguageSync language={language} />
      <ChargerInformation language={language} selection={selection} />
    </>
  );
}

async function ChargersContent(props: { params: PageParams; searchParams: SearchParams }) {
  return guardPage(() => ChargersContentUnguarded(props), () => <StoreUnavailable />);
}

export default function ChargersPage({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  return (
    <main className="guided-presentation">
      <div className="presentation-column">
        <Suspense fallback={<p>Loading…</p>}>
          <ChargersContent params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
