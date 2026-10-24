import { readFileSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChargerDeviceHandoff } from "@/components/ChargerDeviceHandoff";
import { ChargerInformation } from "@/components/ChargerInformation";
import { CABLE_IDS, CHARGER_IDS, DEVICE_IDS, EVIDENCE, type ConnectorType } from "@/lib/compatibility/evidence";
import { evaluateCombination, selectDevice, type BasicGap, type WattageVerdict } from "@/lib/compatibility/rules";
import { chargerCopy } from "@/lib/i18n/charger-copy";

// F03 C1 Apple golden baseline. The fixture was written from main 9686606 before the C1 evidence-model change and must not
// change: every Apple result, every Apple selection and every rendered charger view stay byte-identical. Regenerating it
// (CHARGER_GOLDEN_WRITE=1) is only allowed on an unmodified main checkout.
const FIXTURE = "tests/fixtures/charger-apple-golden.json";

const SELECTION_INPUTS: { device?: string; identifier?: string }[] = [
  {},
  { device: "", identifier: "" },
  { device: "Mac14,2" },
  { device: "MacBookPro12,1" },
  { identifier: "Mac14,2" },
  { identifier: " macbookpro12,1 " },
  { identifier: "MAC14,2" },
  { device: "Mac14,2", identifier: "Mac14,2" },
  { device: "Mac14,2", identifier: "MacBookPro12,1" },
  { device: "toString" },
  { device: "__proto__" },
  ...["MacBook Pro 2019", "MacBook Air M2", "2015", "Mac14", "Mac14,20", "MacBookPro15,4", "Apple", "MagSafe", "NX.JJJAA.008", "AG15-21PT-R9TL", "F1605VA-DS74", "Acer", "ASUS"].map((identifier) => ({ identifier })),
];

const GAPS: BasicGap[] = ["connector-generation-differs", "charging-port-for-cable-not-documented", "no-listed-configuration", "no-evidence"];
const PORT_SETS: ConnectorType[][] = [[], ["usb-c"], ["magsafe-2"], ["magsafe-3", "usb-c"]];
const CABLE_ENDS: ConnectorType[] = ["usb-c", "magsafe-2", "magsafe-3"];
const WATTAGE: [WattageVerdict, number | null, number[]][] = [
  ["at-or-above-all", 70, [30, 35]],
  ["at-or-above-some", 30, [30, 35]],
  ["below-all", 20, [60]],
  ["unknown", 70, []],
];

function snapshot() {
  const results = DEVICE_IDS.flatMap((device) => CHARGER_IDS.flatMap((charger) => CABLE_IDS.map((cable) => evaluateCombination(EVIDENCE, device, charger, cable))));
  const selections = SELECTION_INPUTS.map((input) => ({ input, selection: selectDevice(EVIDENCE, input) }));
  const views: Record<string, string> = {};
  for (const language of ["en", "es"] as const) {
    for (const { input } of selections) {
      const key = `${language}:${JSON.stringify(input)}`;
      views[`page ${key}`] = renderToStaticMarkup(createElement(ChargerInformation, { language, selection: selectDevice(EVIDENCE, input) }));
    }
    for (const device of DEVICE_IDS) {
      views[`needs ${language}:${device}`] = renderToStaticMarkup(
        createElement(ChargerInformation, { language, selection: selectDevice(EVIDENCE, { identifier: device }), showDeviceSelector: false, showScrollHint: true }),
      );
    }
    views[`handoff ${language}`] = renderToStaticMarkup(createElement(ChargerDeviceHandoff, { language }));
  }
  const copy: Record<string, string> = {};
  for (const language of ["en", "es"] as const) {
    const c = chargerCopy(language);
    for (const [verdict, text] of Object.entries(c.basic)) copy[`${language} basic ${verdict}`] = text;
    for (const gap of GAPS) for (const ports of PORT_SETS) for (const end of CABLE_ENDS) copy[`${language} gap ${gap} ${ports.join("+")} ${end}`] = c.gap(gap, ports, end);
    for (const [verdict, watts, included] of WATTAGE) copy[`${language} wattage ${verdict}`] = c.wattage(verdict, watts, included);
    for (const [verdict, text] of Object.entries(c.fast)) copy[`${language} fast ${verdict}`] = text;
  }
  return { results, selections, views, copy, ids: { DEVICE_IDS, CHARGER_IDS, CABLE_IDS } };
}

describe("F03 C1 Apple golden baseline (written from main before the evidence-model change)", () => {
  const current = JSON.parse(JSON.stringify(snapshot()));
  if (process.env.CHARGER_GOLDEN_WRITE === "1") writeFileSync(FIXTURE, `${JSON.stringify(current, null, 1)}\n`);
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8"));

  it("the device, adapter and cable lists are unchanged", () => expect(current.ids).toEqual(golden.ids));
  it("all eight Apple combinations give exactly the baseline results", () => {
    expect(current.results).toHaveLength(8);
    expect(current.results).toEqual(golden.results);
  });
  it("every baseline selection input selects exactly as before, including non-Apple part numbers (unidentified)", () => expect(current.selections).toEqual(golden.selections));
  it("every rendered charger view (page, needs comparison, hand-off) is byte-identical in English and Spanish", () => {
    expect(Object.keys(current.views)).toEqual(Object.keys(golden.views));
    for (const key of Object.keys(golden.views)) expect(current.views[key], key).toBe(golden.views[key]);
  });
  it("existing verdict, gap, wattage and fast-charging copy is unchanged; only the two C1 verdict strings are added", () => {
    for (const key of Object.keys(golden.copy)) expect(current.copy[key], key).toBe(golden.copy[key]);
    const added = Object.keys(current.copy).filter((key) => !(key in golden.copy));
    expect(added.sort()).toEqual(["en basic supported-manufacturer-listed", "en basic supported-pd-profile", "es basic supported-manufacturer-listed", "es basic supported-pd-profile"]);
  });
});
