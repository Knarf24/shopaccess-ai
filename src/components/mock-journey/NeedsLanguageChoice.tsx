import type { JourneyLanguage } from "@/lib/i18n/language";

/** Language changes are deliberate protected submissions, never a mutation on page load. */
export function NeedsLanguageChoice({ language, target, csrfToken, draft, busy = false, heading = false }: {
  readonly language: JourneyLanguage;
  readonly target: JourneyLanguage;
  readonly csrfToken: string;
  readonly draft: { readonly draftId: string; readonly version: number; readonly language?: JourneyLanguage };
  readonly busy?: boolean;
  readonly heading?: boolean;
}) {
  return <form method="post" action="/shop/needs/language" className="journey-form flex flex-col gap-2">
    {heading ? <h1 className="text-3xl font-semibold">{target === "es" ? "Continuar en español" : "Continue in English"}</h1> : null}
    <p>{language === "es" ? "Cambie el idioma sin perder sus necesidades ni su presupuesto. Sus mensajes originales se conservan." : "Change language without losing your shopping needs or budget. Your original messages are kept."}</p>
    <input type="hidden" name="csrfToken" value={csrfToken} />
    <input type="hidden" name="draftId" value={draft.draftId} />
    <input type="hidden" name="version" value={draft.version} />
    <input type="hidden" name="fromLang" value={draft.language ?? language} />
    <button type="submit" name="lang" value={target} lang={target} disabled={busy} className="shopping-secondary-action rounded px-4 py-2 font-medium">
      {target === "es" ? "Continuar en español" : "Continue in English"}
    </button>
    {busy ? <p role="status">{language === "es" ? "Espere a que termine la respuesta y vuelva a intentarlo." : "Wait for the current reply to finish, then try again."}</p> : null}
  </form>;
}
