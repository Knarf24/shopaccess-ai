import { GUIDED_ENTRY_LABEL, GUIDED_ENTRY_SUBMIT, GUIDED_LANGUAGE_EN, GUIDED_LANGUAGE_ES } from "@/lib/i18n/demo-copy";

/**
 * Mock homepage entry. The only posted field is the allowlisted language.
 * The action is the fixed session route; this form has no destination field.
 */
export function GuidedLanguageChoice() {
  return (
    <form method="get" action="/session/needs" className="guided-entry flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend>{GUIDED_ENTRY_LABEL}</legend>
        <label>
          <input type="radio" name="lang" value="en" required /> {GUIDED_LANGUAGE_EN}
        </label>
        <label lang="es">
          <input type="radio" name="lang" value="es" required /> {GUIDED_LANGUAGE_ES}
        </label>
      </fieldset>
      <button type="submit" className="w-fit rounded bg-blue-800 px-4 py-2 font-medium text-white">
        {GUIDED_ENTRY_SUBMIT}
      </button>
    </form>
  );
}
