import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import "../../guided-presentation.css";
import { type AdmissionCopy } from "@/lib/i18n/demo-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";
import { admissionScreen, type AdmissionScreenModel } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { StoreUnavailable } from "@/components/StoreUnavailable";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Present only while the passphrase refusal is rendered. */
export const DEMO_PASSPHRASE_REFUSAL_ID = "demo-passphrase-refusal";
/** Present only while the retry refusal is rendered. */
export const DEMO_ADMISSION_RETRY_ID = "demo-admission-retry";

/** Server-rendered admission screen. It reads cookies and does not set them. */
export function AdmissionScreen({ model }: { readonly model: AdmissionScreenModel }) {
  const { language, copy } = model;
  const passphraseRefusalId = model.kind === "login" && model.notice === "rejected" ? DEMO_PASSPHRASE_REFUSAL_ID : undefined;
  const retryRefusalId = model.kind === "login" && model.notice === "retry" ? DEMO_ADMISSION_RETRY_ID : undefined;
  const passphraseDescribedBy = [passphraseRefusalId, retryRefusalId].filter((id) => id !== undefined).join(" ") || undefined;
  return (
    <main className="guided-presentation">
      <div lang={language} className="presentation-column presentation-column-narrow admission-screen">
        <h1 className="text-3xl font-semibold">{copy.title}</h1>
        <LanguageChoice language={language} copy={copy} />
        {model.kind === "closed" ? <p role="alert" className="journey-panel">{copy.closed}</p> : null}
        {model.kind === "bootstrap" ? (
          <form method="post" action="/demo/admission/submit" className="journey-form">
            <p>{copy.continueHint}</p>
            <input type="hidden" name="lang" value={language} />
            <button type="submit">{copy.continueLabel}</button>
          </form>
        ) : null}
        {model.kind === "login" ? (
          <form method="post" action="/demo/admission/submit" className="journey-form">
            {passphraseRefusalId ? <p id={passphraseRefusalId} role="alert">{copy.rejected}</p> : null}
            {retryRefusalId ? <p id={retryRefusalId} role="alert">{copy.retry}</p> : null}
            <input type="hidden" name="lang" value={language} />
            <input type="hidden" name="demoCsrf" value={model.csrf} />
            <label className="flex flex-col gap-1" htmlFor="demo-passphrase">
              {copy.passphraseLabel}
              <input
                id="demo-passphrase"
                name="passphrase"
                type="password"
                autoComplete="current-password"
                aria-describedby={passphraseDescribedBy}
                aria-invalid={passphraseRefusalId ? "true" : undefined}
              />
            </label>
            <button type="submit">{copy.submit}</button>
          </form>
        ) : null}
        {model.kind === "logout" ? (
          <>
            <p>{copy.admitted}</p>
            <form method="post" action="/demo/admission/logout" className="journey-form">
              <input type="hidden" name="lang" value={language} />
              <input type="hidden" name="demoCsrf" value={model.csrf} />
              <button type="submit">{copy.logout}</button>
            </form>
          </>
        ) : null}
      </div>
    </main>
  );
}

function LanguageChoice({ language, copy }: { readonly language: JourneyLanguage; readonly copy: AdmissionCopy }) {
  return (
    <form method="get" action="/demo/admission" className="guided-entry">
      <fieldset>
        <legend>{copy.languageLegend}</legend>
        <label>
          <input type="radio" name="lang" value="en" defaultChecked={language === "en"} /> {copy.english}
        </label>
        <label lang="es">
          <input type="radio" name="lang" value="es" defaultChecked={language === "es"} /> {copy.spanish}
        </label>
      </fieldset>
      <button type="submit">{copy.showLanguage}</button>
    </form>
  );
}

export default function DemoAdmissionPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading the demonstration…</p>}>
      <AdmissionContent searchParams={searchParams} />
    </Suspense>
  );
}

async function AdmissionContentUnguarded({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  const application = opened;
  if (application.mode === "postgres") notFound();
  if (application.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;
  const runtime = runtimeOf(application);
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;

  const query = await searchParams;
  const model = admissionScreen(
    runtime.value.admission,
    (await headers()).get("cookie"),
    runtime.value.clock().getTime(),
    typeof query.lang === "string" ? query.lang : undefined,
    typeof query.notice === "string" ? query.notice : undefined,
  );
  if (model === "not-found") notFound();
  return <AdmissionScreen model={model} />;
}

/** A save refused while rendering shows the unavailable notice, never a partial or success view. */
async function AdmissionContent(props: Parameters<typeof AdmissionContentUnguarded>[0]) {
  return guardPage(() => AdmissionContentUnguarded(props), () => <StoreUnavailable />);
}
