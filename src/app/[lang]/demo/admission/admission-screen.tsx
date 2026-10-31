import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { type AdmissionCopy } from "@/lib/i18n/demo-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";
import { type AdmissionScreenModel } from "@/server/demo-admission";

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
    <main className="guided-presentation ui-refresh">
      <div lang={language} className="presentation-column presentation-column-narrow admission-screen">
        <DocumentLanguageSync language={language} />
        <header className="gate-intro">
          <p className="gate-brand">ShopAccess AI</p>
          <h1 className="text-3xl font-semibold">{copy.title}</h1>
          <p>{copy.intro}</p>
        </header>
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
            <p>{copy.loginHint}</p>
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
