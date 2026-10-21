import { DEVICE_IDS, EVIDENCE, type DeviceId } from "@/lib/compatibility/evidence";
import { chargerCopy } from "@/lib/i18n/charger-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";

interface ChargerTrackView {
  readonly sessionId: string;
  readonly draftId: string;
  readonly state: "closed" | "task_choice" | "awaiting_model" | "candidate" | "confirmed";
  readonly deviceId: DeviceId | null;
  readonly revision: number;
}

function ControlFields({
  csrfToken,
  language,
  track,
}: {
  readonly csrfToken: string;
  readonly language: JourneyLanguage;
  readonly track: ChargerTrackView;
}) {
  return (
    <>
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="lang" value={language} />
      <input type="hidden" name="draftId" value={track.draftId} />
      <input type="hidden" name="revision" value={String(track.revision)} />
    </>
  );
}

/** Explicit server-rendered website actions. The extension may clarify by text but cannot confirm a device. */
export function ChargerConversationControls({
  csrfToken,
  language,
  track,
}: {
  readonly csrfToken: string;
  readonly language: JourneyLanguage;
  readonly track: ChargerTrackView;
}) {
  const copy = chargerCopy(language);
  const formClass = "flex max-w-xl flex-col gap-3 rounded border border-zinc-400 p-4";
  const buttonClass = "rounded border border-zinc-700 px-4 py-2 text-left font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
  return (
    <section aria-label={track.state === "task_choice" ? copy.taskChoiceLabel : copy.modelChoiceLabel} className="needs-conversation-controls flex flex-col gap-3">
      {track.state === "task_choice" ? (
        <form method="post" action="/shop/needs/charger-control" className={formClass}>
          <ControlFields csrfToken={csrfToken} language={language} track={track} />
          <input type="hidden" name="action" value="choose_task" />
          <p>{copy.taskChoiceLabel}</p>
          <button className={buttonClass} name="task" value="laptop" type="submit">{copy.chooseLaptopTask}</button>
          <button className={buttonClass} name="task" value="charger" type="submit">{copy.chooseChargerTask}</button>
        </form>
      ) : null}
      {track.state === "awaiting_model" ? (
        <form method="post" action="/shop/needs/charger-control" className={formClass}>
          <ControlFields csrfToken={csrfToken} language={language} track={track} />
          <input type="hidden" name="action" value="choose_model" />
          <label htmlFor="charger-conversation-model">{copy.modelChoiceLabel}</label>
          <select id="charger-conversation-model" name="device" defaultValue="" className="rounded border border-zinc-500 bg-white px-2 py-2 text-black">
            <option value="">{copy.handoffPlaceholder}</option>
            {DEVICE_IDS.map((id) => <option key={id} value={id} lang={language === "en" ? undefined : "en"}>{EVIDENCE.devices[id].name} — {id}</option>)}
          </select>
          <button className={buttonClass} type="submit">{copy.handoffButton}</button>
        </form>
      ) : null}
      {track.state === "candidate" ? (
        <div className="flex max-w-xl flex-col gap-3 rounded border border-zinc-400 p-4">
          {track.deviceId ? <p>{copy.currentModelLabel} <span lang={language === "en" ? undefined : "en"}>{EVIDENCE.devices[track.deviceId].name} ({track.deviceId})</span></p> : null}
          <p>{copy.confirmModel}</p>
          <form method="post" action="/shop/needs/charger-control">
            <ControlFields csrfToken={csrfToken} language={language} track={track} />
            <input type="hidden" name="action" value="confirm" />
            <button className={buttonClass} type="submit">{copy.confirmModel}</button>
          </form>
          <form method="post" action="/shop/needs/charger-control">
            <ControlFields csrfToken={csrfToken} language={language} track={track} />
            <input type="hidden" name="action" value="change" />
            <button className={buttonClass} type="submit">{copy.changeModel}</button>
          </form>
        </div>
      ) : null}
      {track.state === "confirmed" ? (
        <form method="post" action="/shop/needs/charger-control" className={formClass}>
          <ControlFields csrfToken={csrfToken} language={language} track={track} />
          <input type="hidden" name="action" value="change" />
          <button className={buttonClass} type="submit">{copy.changeModel}</button>
        </form>
      ) : null}
      {track.state !== "closed" ? (
        <form method="post" action="/shop/needs/charger-control" className="max-w-xl">
          <ControlFields csrfToken={csrfToken} language={language} track={track} />
          <input type="hidden" name="action" value="stop" />
          <button className={buttonClass} type="submit">{copy.stopChargerTask}</button>
        </form>
      ) : null}
    </section>
  );
}
