import type { ReactNode } from "react";
import { CABLE_IDS, CHARGER_IDS, DEVICE_IDS, EVIDENCE, SOURCES, type DeviceId, type SourceId } from "@/lib/compatibility/evidence";
import { evaluateCombination, type CombinationResult, type DeviceSelection } from "@/lib/compatibility/rules";
import { chargerCopy } from "@/lib/i18n/charger-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";

export const CHARGER_HEADING_ID = "charger-heading";
export const CHARGER_ALERT_ID = "charger-alert";
export const CHARGER_RESULTS_HEADING_ID = "charger-results-heading";

/**
 * Configurations whose Apple listing names a "USB-C charge cable" without a power rating: S3 lists "140W USB-C Power
 * Adapter + … USB-C charge cable" for MacBook Air (2022 or later) and gives no rating. Display only; rules are unchanged.
 */
const CABLE_RATING_UNSPECIFIED: ReadonlySet<string> = new Set(["Mac14,2:A2452:usb-c-charge-cable"]);

/**
 * F03 charger information (information only). Server-rendered: a native GET form and a table, no client code, no
 * session, profile, provider or payment use. Apple names and page titles are English and marked so on a Spanish page.
 */
export function ChargerInformation({
  language,
  selection,
  showDeviceSelector = true,
  showScrollHint = false,
}: {
  readonly language: JourneyLanguage;
  readonly selection: DeviceSelection;
  readonly showDeviceSelector?: boolean;
  /** Needs workspace only. The charger page leaves this off so its table markup stays as it was. */
  readonly showScrollHint?: boolean;
}) {
  const copy = chargerCopy(language);
  const english = (value: string): ReactNode => (language === "en" ? value : <span lang="en">{value}</span>);
  const device = selection.kind === "identified" ? EVIDENCE.devices[selection.device] : null;
  const results = device ? CHARGER_IDS.flatMap((charger) => CABLE_IDS.map((cable) => evaluateCombination(EVIDENCE, device.id, charger, cable))) : [];
  const skipTarget = selection.kind === "unidentified" ? CHARGER_ALERT_ID : device ? CHARGER_RESULTS_HEADING_ID : CHARGER_HEADING_ID;
  const otherLanguage = language === "en" ? "es" : "en";
  const switchQuery = new URLSearchParams(device ? { device: device.id } : {});
  const switchHref = `/${otherLanguage}/shop/chargers${switchQuery.toString() ? `?${switchQuery.toString()}` : ""}`;

  const sourceLinks = (sources: readonly SourceId[]): ReactNode =>
    sources.length ? (
      <span className="text-sm">
        {" "}
        {copy.sourceLabel}{" "}
        {sources.map((id, index) => (
          <span key={id}>
            {index ? "; " : null}
            <a href={`#source-${id}`}>{english(SOURCES[id].title)}</a>
          </span>
        ))}
      </span>
    ) : null;

  const row = (result: CombinationResult) => {
    const charger = EVIDENCE.chargers[result.charger];
    const cable = EVIDENCE.cables[result.cable];
    // Wattage is evaluated on its own; when basic support is not established, say that it compares wattage only.
    const wattageOnly = (result.basic.verdict === "unknown" || result.basic.verdict === "unsupported") && result.wattage.verdict !== "unknown";
    const basicText = result.basic.verdict === "unknown" ? copy.gap(result.basic.gap ?? "no-evidence", result.documentedPorts, result.cableConnector) : copy.basic[result.basic.verdict];
    return (
      <tr key={`${result.charger}:${result.cable}`} data-configuration={`${result.charger}:${result.cable}`}>
        <th scope="row" className="needs-config pr-3 text-left align-top">
          {english(charger.name)} {copy.withCable} {english(cable.name)}
        </th>
        <td className="needs-claim pr-3 align-top">
          {basicText}
          {sourceLinks(result.basic.sources)}
          {CABLE_RATING_UNSPECIFIED.has(`${result.device}:${result.charger}:${result.cable}`) ? <span className="block">{copy.cableRatingUnspecified}</span> : null}
        </td>
        <td className="needs-claim pr-3 align-top">
          <span className="needs-figure">
            {copy.wattage(result.wattage.verdict, result.wattage.watts, result.wattage.includedWatts)}
            {wattageOnly ? ` ${copy.wattageOnly}` : null}
          </span>
          {sourceLinks(result.wattage.sources)}
        </td>
        <td className="needs-claim align-top">
          {copy.fast[result.fast.verdict]}
          {sourceLinks(result.fast.sources)}
        </td>
      </tr>
    );
  };

  const usedSources: SourceId[] = device
    ? [...new Set<SourceId>([...results.flatMap((r) => [...r.basic.sources, ...r.wattage.sources, ...r.fast.sources]), ...device.identity.sources, "S7", "S8"])]
    : [];

  return (
    <div lang={language} className="needs-comparison flex flex-col gap-6">
      <a className="skip-link" href={`#${skipTarget}`}>
        {copy.skip}
      </a>
      <h1 id={CHARGER_HEADING_ID} tabIndex={-1} className="text-3xl font-semibold">
        {copy.pageTitle}
      </h1>
      <p>{copy.intro}</p>
      <p>{copy.infoOnly}</p>
      <p className="text-sm">{copy.affiliation}</p>
      <p>
        <a href={switchHref} lang={otherLanguage}>
          {copy.otherLanguage}
        </a>
      </p>

      {showDeviceSelector ? <form method="get" action={`/${language}/shop/chargers`} className="flex flex-col gap-3">
        <label htmlFor="charger-device">{copy.deviceLabel}</label>
        <select id="charger-device" name="device" defaultValue={device?.id ?? ""} className="rounded border border-zinc-500 bg-white px-2 py-2 text-black">
          <option value="">{copy.devicePlaceholder}</option>
          {DEVICE_IDS.map((id: DeviceId) => (
            <option key={id} value={id} lang={language === "en" ? undefined : "en"}>
              {EVIDENCE.devices[id].name} — {id}
            </option>
          ))}
        </select>
        <label htmlFor="charger-identifier">{copy.identifierLabel}</label>
        <input
          id="charger-identifier"
          name="identifier"
          type="text"
          maxLength={40}
          autoComplete="off"
          aria-describedby="charger-identifier-hint"
          className="rounded border border-zinc-500 bg-white px-2 py-2 text-black"
        />
        <p id="charger-identifier-hint" className="text-sm">
          {copy.identifierHint} <a href={SOURCES.S6a.url}>{copy.identifyAir}</a> · <a href={SOURCES.S6b.url}>{copy.identifyPro}</a>
        </p>
        <button type="submit" className="rounded bg-blue-800 px-4 py-2 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          {copy.submit}
        </button>
      </form> : null}

      {selection.kind === "unidentified" ? (
        <p id={CHARGER_ALERT_ID} tabIndex={-1} role="alert" className="rounded border-2 border-red-700 p-3">
          {copy.unidentified}
        </p>
      ) : null}

      {device ? (
        <section aria-labelledby={CHARGER_RESULTS_HEADING_ID} className="flex flex-col gap-4">
          <h2 id={CHARGER_RESULTS_HEADING_ID} tabIndex={-1} className="text-2xl font-semibold">
            {copy.resultsHeading} {english(device.name)} (<span className="needs-identifier">{device.id}</span>)
          </h2>
          <p className="text-sm">{copy.claimsNote}</p>
          <p className="text-sm">{copy.disclaimer}</p>
          <p className="text-sm">{copy.modelNumberNote}</p>
          {showScrollHint ? <p id="charger-scroll-hint" className="needs-scroll-hint">{copy.scrollHint}</p> : null}
          <div
            className={showScrollHint ? "needs-comparison-scroll overflow-x-auto" : "overflow-x-auto"}
            tabIndex={showScrollHint ? 0 : undefined}
            role={showScrollHint ? "region" : undefined}
            aria-labelledby={showScrollHint ? "charger-scroll-hint" : undefined}
          >
            <table className="w-full text-left text-sm">
              <caption className="text-left font-medium">{copy.tableCaption}</caption>
              <thead>
                <tr>
                  <th scope="col" className="pr-3">{copy.columns.configuration}</th>
                  <th scope="col" className="pr-3">{copy.columns.basic}</th>
                  <th scope="col" className="pr-3">{copy.columns.wattage}</th>
                  <th scope="col">{copy.columns.fast}</th>
                </tr>
              </thead>
              <tbody>{results.map(row)}</tbody>
            </table>
          </div>
          <p className="text-sm">
            {copy.cableNote} “<span lang="en">{copy.cableNoteQuote}</span>” {copy.cableNoteAfter}
            {sourceLinks(["S7", "S8"])}
          </p>
          <section aria-labelledby="charger-sources-heading">
            <h3 id="charger-sources-heading" className="text-lg font-semibold">
              {copy.sourcesHeading}
            </h3>
            <ul className="text-sm">
              {usedSources.map((id) => (
                <li key={id} id={`source-${id}`}>
                  <a href={SOURCES[id].url}>{english(SOURCES[id].title)}</a> — {copy.accessed(SOURCES[id].accessed)}
                </li>
              ))}
            </ul>
          </section>
        </section>
      ) : null}
    </div>
  );
}
