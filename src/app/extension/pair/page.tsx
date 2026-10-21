import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import "../../guided-presentation.css";
import { ConfigNotice } from "@/components/ConfigNotice";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { extensionCopy } from "@/lib/i18n/extension-copy";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { allowlistedJourneyLanguage } from "@/lib/i18n/language";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { resolvePageSession } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

/**
 * M2-2 approval page: the shopper allows or denies one side-panel pairing for this browser's own session. Rendering
 * decides nothing; the decision is a CSRF-protected POST to /extension/pair/decide. Mock only.
 */
async function PairContentUnguarded({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  if (opened.mode === "postgres") notFound();
  if (opened.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;
  const runtime = runtimeOf(opened);
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;
  if (runtime.value.extensionOrigins.size === 0) notFound();

  const query = await searchParams;
  const language = allowlistedJourneyLanguage(one(query.lang));
  const copy = extensionCopy(language);
  const admissionLocation = protectedAdmissionLocation(runtime.value.admission, (await headers()).get("cookie"), runtime.value.clock().getTime(), language);
  if (admissionLocation) redirect(admissionLocation);

  const result = one(query.result);
  const message = result === "approved" ? copy.approved : result === "denied" ? copy.denied : result === "failed" ? copy.pairFailed : null;
  const pairingId = one(query.pairing);
  const session = await resolvePageSession(runtime.value);

  return (
    <div lang={language} className="flex flex-col gap-4">
      <DocumentLanguageSync language={language} />
      <h1 id="pair-heading" tabIndex={-1} className="text-2xl font-semibold">
        {copy.pairHeading}
      </h1>
      {message ? (
        <p role={result === "failed" ? "alert" : "status"} id="pair-result" tabIndex={-1}>
          {message}
        </p>
      ) : !session ? (
        <p role="alert">{copy.pairNoSession}</p>
      ) : pairingId === undefined || !/^[0-9a-f]{64}$/.test(pairingId) ? (
        <p role="alert">{copy.pairFailed}</p>
      ) : (
        <form method="post" action="/extension/pair/decide" className="flex flex-col gap-3">
          <p>{copy.pairExplanation}</p>
          <p>{copy.pairLimits}</p>
          <input type="hidden" name="csrfToken" value={session.csrfToken} />
          <input type="hidden" name="pairingId" value={pairingId} />
          <input type="hidden" name="lang" value={language} />
          <div className="flex gap-3">
            <button type="submit" name="decision" value="approve" className="underline">
              {copy.approve}
            </button>
            <button type="submit" name="decision" value="deny" className="underline">
              {copy.deny}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

async function PairContent(props: { searchParams: SearchParams }) {
  return guardPage(() => PairContentUnguarded(props), () => <StoreUnavailable />);
}

export default function ExtensionPairPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="guided-presentation">
      <div className="presentation-column">
        <Suspense fallback={<p>Loading…</p>}>
          <PairContent searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
