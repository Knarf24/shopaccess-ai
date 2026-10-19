import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import "../../guided-presentation.css";
import { ChargerInformation } from "@/components/ChargerInformation";
import { ConfigNotice } from "@/components/ConfigNotice";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { EVIDENCE } from "@/lib/compatibility/evidence";
import { selectDevice } from "@/lib/compatibility/rules";
import { chargerCopy } from "@/lib/i18n/charger-copy";
import { allowlistedJourneyLanguage } from "@/lib/i18n/language";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const one = (value: string | string[] | undefined, max: number) => (typeof value === "string" && value.length <= max ? value : "");

/**
 * GET /shop/chargers: charger information (F03 information slice). Reads only the query and the curated evidence: no session,
 * profile, provider, extension or payment. PostgreSQL mode says the page is unavailable and does not ask for services.
 */
async function ChargersContentUnguarded({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const query = await searchParams;
  const language = allowlistedJourneyLanguage(one(query.lang, 8));
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  if (opened.mode === "postgres") {
    return (
      <div lang={language}>
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
  return <ChargerInformation language={language} selection={selection} />;
}

async function ChargersContent(props: { searchParams: SearchParams }) {
  return guardPage(() => ChargersContentUnguarded(props), () => <StoreUnavailable />);
}

export default function ChargersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="guided-presentation">
      <div className="presentation-column">
        <Suspense fallback={<p>Loading…</p>}>
          <ChargersContent searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
