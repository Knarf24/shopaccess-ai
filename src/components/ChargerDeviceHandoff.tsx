import { DEVICE_IDS, EVIDENCE } from "@/lib/compatibility/evidence";
import { chargerCopy } from "@/lib/i18n/charger-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";

/**
 * F03 device hand-off on the guided needs page. A native GET form that sends only the shopper's explicitly chosen exact
 * model and the journey language to the charger page, which validates the model itself. Nothing is pre-selected, nothing
 * is saved, and no draft, conversation, profile or provider is read or written. Server-rendered; no client code.
 */
export function ChargerDeviceHandoff({ language }: { readonly language: JourneyLanguage }) {
  const copy = chargerCopy(language);
  return (
    <form method="get" action="/shop/chargers" className="flex flex-col gap-3">
      <input type="hidden" name="lang" value={language} />
      <label htmlFor="needs-charger-device">{copy.handoffLabel}</label>
      <select id="needs-charger-device" name="device" defaultValue="" className="rounded border border-zinc-500 bg-white px-2 py-2 text-black">
        <option value="">{copy.handoffPlaceholder}</option>
        {DEVICE_IDS.map((id) => (
          <option key={id} value={id} lang={language === "en" ? undefined : "en"}>
            {EVIDENCE.devices[id].name} — {id}
          </option>
        ))}
      </select>
      <button type="submit" className="rounded border border-zinc-600 px-4 py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        {copy.handoffButton}
      </button>
    </form>
  );
}
