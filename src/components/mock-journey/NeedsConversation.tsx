import type { JourneyCopy } from "@/lib/i18n/demo-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";
import type { NeedsNotice } from "@/lib/i18n/needs-notice";
import { INTENDED_USES, type IntendedUse } from "@/lib/readiness/engine";
import type { ConversationTurn } from "@/types/conversation-turn";

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

function ConversationHistory({ copy, turns }: { readonly copy: JourneyCopy; readonly turns: readonly ConversationTurn[] }) {
  if (turns.length === 0) return null;
  return (
    <section aria-labelledby="conversation-heading" className="flex flex-col gap-2">
      <h2 id="conversation-heading" className="text-lg font-semibold">
        {copy.conversationHeading}
      </h2>
      <ol className="flex flex-col gap-2">
        {turns.map((turn, index) => (
          <li key={`${turn.role}-${index}`} className="whitespace-pre-wrap">
            {turn.role === "assistant" && isNeedsNotice(turn.text) ? copy.notices[turn.text] : turn.text}
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
    <form method="post" action="/shop/needs/submit" className="journey-form flex max-w-xl flex-col gap-4">
      {mode === "first" ? <p>{copy.prompt}</p> : null}
      {mode !== "first" && draft?.shopperText ? <p>{copy.clarificationExplanation}</p> : null}
      {showHistory ? <ConversationHistory copy={copy} turns={turns} /> : null}
      {mode === "first" ? (
        <label className="flex flex-col gap-1 text-sm" htmlFor="shopper-text">
          {copy.shopperText}
          <textarea
            id="shopper-text"
            name="shopperText"
            maxLength={2000}
            rows={4}
            defaultValue={draft?.shopperText ?? ""}
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
            <textarea id="shopper-reply" name="shopperText" maxLength={2000} rows={4} defaultValue="" className="rounded border border-zinc-400 p-2" />
          </label>
        </>
      )}
      {mode === "reply" ? null : (
        <>
          <label className="flex flex-col gap-1 text-sm" htmlFor="needs-use">
            {copy.useLabel}
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
            {copy.budgetLabel}
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
      <button type="submit" className="rounded bg-blue-800 px-4 py-2 font-medium text-white">
        {copy.submit}
      </button>
    </form>
  );
}
