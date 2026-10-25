import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import "../../../guided-presentation.css";
import { ConfigNotice } from "@/components/ConfigNotice";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { extensionCopy } from "@/lib/i18n/extension-copy";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { documentLocale } from "@/lib/i18n/locale-segment";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { resolvePageSession } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type PageParams = Promise<{ lang: string }>;

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

/**
 * M2-2 approval page: the shopper allows or denies one side-panel pairing for this browser's own session. Rendering
 * decides nothing; the decision is a CSRF-protected POST to /extension/pair/decide. Mock only. Finding 3: allowing access
 * needs the six-digit code shown in the shopper's own side panel; the page never shows or echoes a code.
 */
async function PairContentUnguarded({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  await connection();
  const { lang } = await params;
  const pathLanguage = documentLocale(lang);
  if (!pathLanguage) notFound();
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  if (opened.mode === "postgres") notFound();
  if (opened.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;
  const runtime = runtimeOf(opened);
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;
  if (runtime.value.extensionOrigins.size === 0) notFound();

  const query = await searchParams;
  const language = pathLanguage;
  const copy = extensionCopy(language);
  const admissionLocation = protectedAdmissionLocation(runtime.value.admission, (await headers()).get("cookie"), runtime.value.clock().getTime(), language);
  if (admissionLocation) redirect(admissionLocation);

  const result = one(query.result);
  const message =
    result === "approved" ? copy.approved : result === "denied" ? copy.denied : result === "failed" ? copy.pairFailed : result === "code_limit" ? copy.codeLimit : null;
  // A wrong code, or a session already at its limit of pending approvals, keeps the same pairing's form (it stays pending).
  const retry = result === "code_mismatch" ? copy.codeMismatch : result === "pair_limit" ? copy.pairLimitReached : null;
  const mismatch = result === "code_mismatch";
  const pairingId = one(query.pairing);
  const session = await resolvePageSession(runtime.value);

  return (
    <div lang={language} className="flex flex-col gap-4">
      <DocumentLanguageSync language={language} />
      <h1 id="pair-heading" tabIndex={-1} className="text-2xl font-semibold">
        {copy.pairHeading}
      </h1>
      {message ? (
        // Server-rendered `autofocus` moves focus to the result on load, with no client script (SEC-01 allows none here).
        <p role={result === "failed" || result === "code_limit" ? "alert" : "status"} id="pair-result" tabIndex={-1} autoFocus>
          {message}
        </p>
      ) : !session ? (
        <p role="alert">{copy.pairNoSession}</p>
      ) : pairingId === undefined || !/^[0-9a-f]{64}$/.test(pairingId) ? (
        <p role="alert">{copy.pairFailed}</p>
      ) : (
        <form method="post" action="/extension/pair/decide" className="flex flex-col gap-3">
          {retry ? (
            <p role="alert" id="pair-code-mismatch" tabIndex={-1} autoFocus>
              {retry}
            </p>
          ) : null}
          <p>{copy.pairExplanation}</p>
          <p>{copy.pairLimits}</p>
          <p id="pair-code-warning">{copy.codeWarning}</p>
          <label htmlFor="pair-code">{copy.codeLabel}</label>
          <input
            id="pair-code"
            name="matchCode"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            maxLength={7}
            aria-describedby={mismatch ? "pair-code-mismatch pair-code-hint pair-code-warning" : "pair-code-hint pair-code-warning"}
            aria-invalid={mismatch ? true : undefined}
            className="rounded border border-zinc-500 bg-white px-2 py-2 text-black"
          />
          <p id="pair-code-hint" className="text-sm">
            {copy.codeHint}
          </p>
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

async function PairContent(props: { params: PageParams; searchParams: SearchParams }) {
  return guardPage(() => PairContentUnguarded(props), () => <StoreUnavailable />);
}

export default function ExtensionPairPage({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  return (
    <main className="guided-presentation">
      <div className="presentation-column">
        <Suspense fallback={<p>Loading…</p>}>
          <PairContent params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
