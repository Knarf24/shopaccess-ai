import type { ReactNode } from "react";
import type { JourneyCopy } from "@/lib/i18n/demo-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";
import type { NeedsNotice } from "@/lib/i18n/needs-notice";
import { INTENDED_USES, type IntendedUse } from "@/lib/readiness/engine";
import type { ConversationTurn } from "@/types/conversation-turn";
import { chargerCopy } from "@/lib/i18n/charger-copy";
import { Icon } from "../Icon";

interface NeedsFormDraft {
  readonly shopperText: string;
  readonly prefilledUse: IntendedUse | null;
  readonly prefilledBudgetDollars: string | null;
  readonly draftId: string;
  readonly version: number;
  readonly notice: NeedsNotice | null;
}

function descriptionIds(ids: readonly (string | undefined)[]): string | undefined {
  const joined = ids.filter((id): id is string => id !== undefined).join(" ");
  return joined === "" ? undefined : joined;
}

function isNeedsNotice(value: string): value is NeedsNotice {
  return value === "malformed" || value === "unavailable" || value === "missing_use" || value === "missing_budget" || value === "ambiguous" || value === "review";
}

const CHARGER_LINES = ["charger_task_choice", "charger_model", "charger_review", "charger_shown", "charger_closed"] as const;

function ConversationHistory({ copy, language, turns }: { readonly copy: JourneyCopy; readonly language: JourneyLanguage; readonly turns: readonly ConversationTurn[] }) {
  if (turns.length === 0) return null;
  // Presentation only: retain saved history and all shopper messages. Older budget controls appended this notice repeatedly.
  const shownTurns = turns.filter((turn, index) => !(turn.role === "assistant" && turn.text === "charger_shown" && index > 0 && turns[index - 1].role === "assistant" && turns[index - 1].text === "charger_shown"));
  return (
    <section aria-labelledby="conversation-heading" className="flex flex-col gap-2">
      <h2 id="conversation-heading" className="text-lg font-semibold">
        {copy.conversationHeading}
      </h2>
      <ol className="flex flex-col gap-2">
        {shownTurns.map((turn, index) => (
          <li key={`${turn.role}-${index}`} className={`needs-turn needs-turn-${turn.role}`}>
            <span className="needs-speaker">{turn.role === "shopper" ? copy.speakerShopper : copy.speakerAssistant}</span>
            <p className="needs-turn-text">
              {turn.role === "assistant" && isNeedsNotice(turn.text)
                ? copy.notices[turn.text]
                : turn.role === "assistant" && (CHARGER_LINES as readonly string[]).includes(turn.text)
                  ? chargerCopy(language).conversationLines[turn.text as (typeof CHARGER_LINES)[number]]
                  : turn.text}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** First ask, follow-up, and reply all keep a natural-language box. Structured controls stay available. */
export function NeedsConversation({
  copy,
  language,
  csrfToken,
  draft,
  mode,
  turns = [],
  validationAlertId,
  noticeRendered = false,
  chargerClarification = false,
  afterHistory = null,
  externalAiNotice,
  aiLimited = false,
  secondary = false,
}: {
  readonly copy: JourneyCopy;
  readonly language: JourneyLanguage;
  readonly csrfToken: string;
  readonly draft: NeedsFormDraft | null;
  readonly mode: "first" | "clarify" | "reply";
  readonly turns?: readonly ConversationTurn[];
  /** Set only when the page is rendering the validation alert with this id. */
  readonly validationAlertId?: string;
  /** Set only when the page is rendering the needs-notice element. */
  readonly noticeRendered?: boolean;
  /** Uses charger-specific authority guidance and avoids implying a laptop summary is being confirmed. */
  readonly chargerClarification?: boolean;
  /** Separate forms rendered after the messages and before the reply box. They stay outside the reply form. */
  readonly afterHistory?: ReactNode;
  /** Present only in external-advisory mode. It describes where free text is sent before the field. */
  readonly externalAiNotice?: string;
  /** This request was refused before an external AI call. Typed and structured controls remain available. */
  readonly aiLimited?: boolean;
  /** A side task next to a primary action (review reply, re-search under results): outlined, not orange. */
  readonly secondary?: boolean;
}) {
  const useMissing = mode === "clarify" && (draft?.prefilledUse ?? null) === null;
  const budgetDisputed =
    mode === "clarify" && ((draft?.prefilledBudgetDollars ?? null) === null || draft?.notice === "ambiguous");
  const noticeId = noticeRendered ? "needs-notice" : undefined;
  const useDescribedBy = useMissing ? noticeId : undefined;
  const budgetDescribedBy = descriptionIds([
    validationAlertId,
    budgetDisputed ? noticeId : undefined,
    "budget-hint",
  ]);

  const showHistory = turns.length > 0;

  return (
    <div className="needs-conversation">
      {mode === "first" ? <p>{copy.prompt}</p> : null}
      {mode !== "first" && (chargerClarification || draft?.shopperText) ? <p>{chargerClarification ? chargerCopy(language).needsExplanation : copy.clarificationExplanation}</p> : null}
      {showHistory ? <ConversationHistory copy={copy} language={language} turns={turns} /> : null}
      {afterHistory}
      {aiLimited ? <p role="status">{copy.aiLimited}</p> : null}
      <form method="post" action="/shop/needs/submit" className="journey-form flex max-w-xl flex-col gap-4">
      {externalAiNotice ? <p id="needs-ai-notice">{externalAiNotice}</p> : null}
      {mode === "first" ? (
        <label className="flex flex-col gap-1 text-sm" htmlFor="shopper-text">
          {copy.shopperText}
          <textarea
            id="shopper-text"
            name="shopperText"
            maxLength={2000}
            rows={4}
            defaultValue={draft?.shopperText ?? ""}
            aria-describedby={externalAiNotice ? "needs-ai-notice" : undefined}
            className="rounded border border-zinc-400 p-2"
          />
        </label>
      ) : (
        <>
          {draft?.shopperText && !showHistory ? (
            <p className="original-request">
              <span className="block text-sm">{copy.shopperText}</span>
              <span className="mt-1 block whitespace-pre-wrap">{draft.shopperText}</span>
            </p>
          ) : null}
          <label className="flex flex-col gap-1 text-sm" htmlFor="shopper-reply">
            {copy.followUpLabel}
            <textarea id="shopper-reply" name="shopperText" maxLength={2000} rows={4} defaultValue="" aria-describedby={externalAiNotice ? "needs-ai-notice" : undefined} className="rounded border border-zinc-400 p-2" />
          </label>
        </>
      )}
      {mode === "reply" ? null : (
        <>
          <label className="flex flex-col gap-1 text-sm" htmlFor="needs-use">
            <span className="label-line"><Icon name="laptop" />{copy.useLabel}</span>
            <select
              id="needs-use"
              name="use"
              defaultValue={draft?.prefilledUse ?? ""}
              aria-invalid={useMissing || undefined}
              aria-describedby={useDescribedBy}
              className="rounded border border-zinc-400 p-2"
            >
              <option value="">{copy.questions.intended_use}</option>
              {INTENDED_USES.map((use) => (
                <option key={use} value={use}>
                  {copy.uses[use]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm" htmlFor="needs-budget">
            <span className="label-line"><Icon name="budget" />{copy.budgetLabel}</span>
            <input
              id="needs-budget"
              name="budget"
              inputMode="numeric"
              pattern="[1-9][0-9]{1,4}"
              defaultValue={draft?.prefilledBudgetDollars ?? ""}
              aria-invalid={budgetDisputed || undefined}
              aria-describedby={budgetDescribedBy}
              className="rounded border border-zinc-400 p-2"
            />
          </label>
          <p id="budget-hint" className="text-sm">
            {copy.budgetHint}
          </p>
        </>
      )}
      <input type="hidden" name="lang" value={language} />
      {mode !== "first" && draft ? <input type="hidden" name="draftId" value={draft.draftId} /> : null}
      {mode !== "first" && draft ? <input type="hidden" name="version" value={String(draft.version)} /> : null}
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <button type="submit" className={secondary || mode === "reply" ? "shopping-secondary-action rounded px-4 py-2 font-medium" : "shopping-primary-action rounded bg-blue-800 px-4 py-2 font-medium text-white"}>
        {mode === "reply" ? null : <Icon name="search" />}{chargerClarification ? (language === "es" ? "Enviar respuesta" : "Send reply") : copy.submit}
      </button>
      </form>
    </div>
  );
}
