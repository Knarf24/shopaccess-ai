import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ChargerInformation } from "@/components/ChargerInformation";
import {
  EVIDENCE,
  isMakerDevice,
  CABLE_IDS,
  CHARGER_IDS,
  DEVICE_IDS,
  type AnyDeviceEvidence,
  type BarrelSpec,
  type CableEvidence,
  type CableId,
  type ChargerId,
  type DeviceId,
  type ChargerEvidence,
  type CompatibilityEvidence,
  type DocumentedConfiguration,
  type FactState,
  type MakerDeviceEvidence,
  type PowerInput,
  type SourceId,
} from "@/lib/compatibility/evidence";
import { evaluateCombination, selectDevice, type BasicGap, type DeviceSelection } from "@/lib/compatibility/rules";
import { chargerCopy } from "@/lib/i18n/charger-copy";

// F03 C1 evidence model: fact states, identity matching and the guards that keep a non-Apple result from appearing
// without complete, consistent, exact-SKU evidence.
//
// SYNTHETIC EVIDENCE. Every non-Apple device, adapter, cable, profile and listing below is invented for these tests. None
// is a manufacturer statement or a real-world result. Source IDs are reused only as placeholders, as in the existing
// synthetic charger tests.

type D = "SYN-LAPTOP" | "SYN-BARREL-LAPTOP";
type C = "SYN-PD-ADAPTER" | "SYN-BARREL-ADAPTER" | "SYN-GENERIC-PD-ADAPTER";
type K = "SYN-USBC-CABLE" | "SYN-BARREL-LEAD" | "SYN-MAGSAFE-CABLE";
type Evidence = CompatibilityEvidence<D, C, K, MakerDeviceEvidence<D>>;

const sku = <T,>(value: T, sources: SourceId[] = ["S1"]): FactState<T> => ({ status: "sourced", value, scope: "sku", sources });
const family = <T,>(value: T): FactState<T> => ({ status: "sourced", value, scope: "family", sources: ["S2"] });
const unknownFact = <T,>(): FactState<T> => ({ status: "unknown", reason: "SYNTHETIC: no source" });
const discrepant = <T,>(kind: "unresolved" | "contradiction"): FactState<T> => ({
  status: "discrepant",
  kind,
  claims: [
    { statement: "SYNTHETIC claim A", scope: "family", sources: ["S3"] },
    { statement: "SYNTHETIC claim B", scope: "sku", sources: ["S5"] },
  ],
});

const usbCInput = (): PowerInput => ({
  connector: "usb-c",
  whichPorts: sku("SYNTHETIC left USB-C port"),
  acceptsUsbPdSource: sku(true),
  requiredPdProfiles: sku([{ volts: 20, amps: 3.25 }]),
  requirement: sku({ watts: 65, volts: 20 }),
});
const matchingBarrel = (): BarrelSpec => ({ outerDiameterMm: sku(4.5), innerDiameterMm: sku(3.0), volts: sku(19), polarity: sku("center-positive") });
const barrelInput = (): PowerInput => ({
  connector: "dc-barrel",
  whichPorts: sku("SYNTHETIC DC-in"),
  acceptsUsbPdSource: unknownFact(),
  requiredPdProfiles: unknownFact(),
  requirement: sku({ watts: 65, volts: 19 }),
  barrel: matchingBarrel(),
});

function laptop(id: D, inputs: PowerInput[]): MakerDeviceEvidence<D> {
  return {
    id,
    name: `SYNTHETIC ${id}`,
    maker: "Acer",
    partIdentity: { model: id === "SYN-LAPTOP" ? "SYN-AG00-00PT-X1" : "SYN-F0000VA-XX00", partNumber: id === "SYN-LAPTOP" ? "SYN.NX.0000.001" : "SYN-90NB0000-M000", status: "verified", sources: ["S6a"] },
    powerInputs: sku(inputs),
    powerInputsComplete: unknownFact(),
    adapterRatings: unknownFact(),
    includedAdapter: { rating: unknownFact(), partNumber: unknownFact() },
    specPagePowerSupplyWatts: sku(65),
  };
}

function world(): Evidence {
  const chargers: Record<C, ChargerEvidence<C>> = {
    "SYN-PD-ADAPTER": {
      id: "SYN-PD-ADAPTER",
      name: "SYNTHETIC 65W PD adapter",
      output: { value: "usb-c", sources: ["S7"] },
      watts: { value: 65, sources: ["S7"] },
      modelNumber: { value: "SYN-PD", sources: ["S7"] },
      usbPd: { value: true, sources: ["S7"] },
      pdProfiles: sku([{ volts: 5, amps: 3 }, { volts: 9, amps: 3 }, { volts: 15, amps: 3 }, { volts: 20, amps: 3.25 }], ["S7"]),
    },
    "SYN-GENERIC-PD-ADAPTER": {
      id: "SYN-GENERIC-PD-ADAPTER",
      name: "SYNTHETIC 140W adapter with generic PD support only",
      output: { value: "usb-c", sources: ["S8"] },
      watts: { value: 140, sources: ["S8"] },
      modelNumber: { value: "SYN-GPD", sources: ["S8"] },
      usbPd: { value: true, sources: ["S8"] },
    },
    "SYN-BARREL-ADAPTER": {
      id: "SYN-BARREL-ADAPTER",
      name: "SYNTHETIC 65W barrel adapter",
      output: { value: "dc-barrel", sources: ["S7"] },
      watts: { value: 65, sources: ["S7"] },
      modelNumber: { value: "SYN-BRL", sources: ["S7"] },
      usbPd: null,
      barrel: matchingBarrel(),
    },
  };
  const cables: Record<K, CableEvidence<K>> = {
    "SYN-USBC-CABLE": {
      id: "SYN-USBC-CABLE",
      name: "SYNTHETIC USB-C cable",
      chargerEnd: "usb-c",
      deviceEnd: "usb-c",
      currentRatingAmps: sku(5, ["S8"]),
      connectorEnds: sku({ chargerEnd: "usb-c", deviceEnd: "usb-c" }, ["S8"]),
    },
    "SYN-BARREL-LEAD": { id: "SYN-BARREL-LEAD", name: "SYNTHETIC attached barrel lead", chargerEnd: "dc-barrel", deviceEnd: "dc-barrel" },
    "SYN-MAGSAFE-CABLE": {
      id: "SYN-MAGSAFE-CABLE",
      name: "SYNTHETIC MagSafe 3 cable",
      chargerEnd: "usb-c",
      deviceEnd: "magsafe-3",
      connectorEnds: sku({ chargerEnd: "usb-c", deviceEnd: "magsafe-3" }, ["S2"]),
    },
  };
  return {
    devices: { "SYN-LAPTOP": laptop("SYN-LAPTOP", [usbCInput()]), "SYN-BARREL-LAPTOP": laptop("SYN-BARREL-LAPTOP", [barrelInput()]) },
    chargers,
    cables,
    configurations: [],
  };
}

type Draft = { devices: Record<D, MakerDeviceEvidence<D>>; chargers: Record<C, ChargerEvidence<C>>; cables: Record<K, CableEvidence<K>>; configurations: DocumentedConfiguration<D, C, K>[] };
function variant(change: (draft: Draft) => void): Evidence {
  const draft = structuredClone(world()) as Draft;
  change(draft);
  return draft;
}
const withUsbC = (change: (input: { -readonly [P in keyof PowerInput]: PowerInput[P] }) => void) =>
  variant((d) => {
    const input = { ...usbCInput() };
    change(input);
    d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: sku([input]) };
  });
const usbC = (evidence: Evidence) => evaluateCombination(evidence, "SYN-LAPTOP", "SYN-PD-ADAPTER", "SYN-USBC-CABLE");
const POSITIVE = ["supported-apple-listed", "supported-apple-fast-charge-list", "supported-specification", "supported-manufacturer-listed", "supported-pd-profile"];

describe("SYNTHETIC positive controls (the guarded paths are reachable, so the negative controls below are meaningful)", () => {
  it("every required fact sourced for the exact SKU and a matching PD profile and cable rating gives supported-pd-profile", () => {
    const result = usbC(world());
    expect(result.basic.verdict).toBe("supported-pd-profile");
    expect(result.basic.gap).toBeNull();
    expect(result.basic.sources).toEqual(expect.arrayContaining(["S6a", "S1", "S7", "S8"]));
    expect(result.documentedPorts).toEqual(["usb-c"]);
  });

  it("an exact-SKU manufacturer listing gives supported-manufacturer-listed, including for a DC barrel", () => {
    const listed = variant((d) => {
      d.configurations = [{ device: "SYN-BARREL-LAPTOP", charger: "SYN-BARREL-ADAPTER", cable: "SYN-BARREL-LEAD", kind: "pairing", basis: "manufacturer-listed", scope: "sku", sources: ["S3"] }];
    });
    expect(evaluateCombination(listed, "SYN-BARREL-LAPTOP", "SYN-BARREL-ADAPTER", "SYN-BARREL-LEAD").basic).toEqual({
      verdict: "supported-manufacturer-listed",
      sources: ["S6a", "S3"],
      gap: null,
    });
  });
});

describe("SYNTHETIC: missing, family-scoped or unresolved required facts return unknown", () => {
  const BAD: [string, () => FactState<never>, BasicGap | "missing"][] = [
    ["unknown", unknownFact, "missing"],
    ["family-scoped", () => family(null as never), "family-scoped-only"],
    ["unresolved discrepancy", () => discrepant("unresolved"), "discrepancy-unresolved"],
    ["established contradiction", () => discrepant("contradiction"), "sources-contradict"],
  ];
  const FIELDS: [string, (bad: FactState<never>) => Evidence, BasicGap][] = [
    ["the USB-C port", (bad) => withUsbC((i) => (i.whichPorts = bad)), "charging-port-for-cable-not-documented"],
    ["acceptance of a USB PD source", (bad) => withUsbC((i) => (i.acceptsUsbPdSource = bad)), "pd-profile-not-established"],
    ["the required PD profile", (bad) => withUsbC((i) => (i.requiredPdProfiles = bad)), "pd-profile-not-established"],
    ["the stated input requirement", (bad) => withUsbC((i) => (i.requirement = bad)), "pd-profile-not-established"],
    ["the adapter's PD profiles", (bad) => variant((d) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], pdProfiles: bad })), "pd-profile-not-established"],
    ["the cable's current rating", (bad) => variant((d) => (d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], currentRatingAmps: bad })), "cable-capability-not-established"],
    ["the charging-input list", (bad) => variant((d) => (d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: bad })), "no-evidence"],
  ];
  for (const [field, make, missingGap] of FIELDS) {
    for (const [state, bad, gap] of BAD) {
      it(`${state} ${field} gives unknown (${gap === "missing" ? missingGap : gap})`, () => {
        const result = usbC(make(bad()));
        expect(result.basic.verdict).toBe("unknown");
        expect(result.basic.gap).toBe(gap === "missing" ? missingGap : gap);
      });
    }
  }

  it("an absent adapter PD-profile fact or cable rating (the curated adapters and cables have none) gives unknown", () => {
    expect(usbC(variant((d) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], pdProfiles: undefined }))).basic.gap).toBe("pd-profile-not-established");
    expect(usbC(variant((d) => (d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], currentRatingAmps: undefined }))).basic.gap).toBe("cable-capability-not-established");
  });

  it("precedence: an established contradiction is reported before an unresolved discrepancy, which comes before family scope and missing facts", () => {
    const mixed = withUsbC((i) => {
      i.whichPorts = unknownFact();
      i.acceptsUsbPdSource = family(true);
      i.requiredPdProfiles = discrepant("unresolved");
    });
    expect(usbC(mixed).basic.gap).toBe("discrepancy-unresolved");
    const withContradiction = variant((d) => {
      d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: sku([{ ...usbCInput(), requiredPdProfiles: discrepant("unresolved"), acceptsUsbPdSource: discrepant("contradiction") }]) };
    });
    expect(usbC(withContradiction).basic.gap).toBe("sources-contradict");
  });

  it("exhaustive matrix: no combination of non-sourced states for the required facts (or a sourced 'no PD' on the adapter) reaches a positive verdict", () => {
    const states: (() => FactState<never> | "good")[] = [() => "good", unknownFact, () => family(null as never), () => discrepant("unresolved"), () => discrepant("contradiction")];
    let positives = 0;
    let evaluated = 0;
    for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 5; c++) for (let r = 0; r < 5; r++) for (let e = 0; e < 5; e++) for (let f = 0; f < 5; f++) for (const verified of [true, false]) for (const pdFlag of [true, false]) {
      const pick = (index: number, good: FactState<never>) => {
        const s = states[index]!();
        return s === "good" ? good : s;
      };
      const evidence = variant((d) => {
        const input = usbCInput();
        d.devices["SYN-LAPTOP"] = {
          ...d.devices["SYN-LAPTOP"],
          partIdentity: { ...d.devices["SYN-LAPTOP"].partIdentity, status: verified ? "verified" : "unverified" },
          powerInputs: sku([{ ...input, whichPorts: pick(a, input.whichPorts as never), acceptsUsbPdSource: pick(b, input.acceptsUsbPdSource as never), requiredPdProfiles: pick(c, input.requiredPdProfiles as never), requirement: pick(r, input.requirement as never) }]),
        };
        d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], usbPd: { value: pdFlag, sources: ["S7"] }, pdProfiles: pick(e, d.chargers["SYN-PD-ADAPTER"].pdProfiles as never) };
        d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], currentRatingAmps: pick(f, d.cables["SYN-USBC-CABLE"].currentRatingAmps as never) };
      });
      const verdict = usbC(evidence).basic.verdict;
      evaluated += 1;
      const allGood = a === 0 && b === 0 && c === 0 && e === 0 && f === 0 && verified;
      if (POSITIVE.includes(verdict)) positives += 1;
      const good = allGood && r === 0 && pdFlag;
      expect(POSITIVE.includes(verdict), `a${a} b${b} c${c} r${r} e${e} f${f} verified ${verified} usbPd ${pdFlag}`).toBe(good);
      if (!good) expect(verdict).toBe("unknown");
    }
    expect(evaluated).toBe(62500);
    expect(positives).toBe(1);
  }, 60_000);
});

describe("SYNTHETIC: wattage plus generic PD support is never enough", () => {
  it("a 140W adapter with a sourced generic USB PD fact but no PD-profile fact gives unknown", () => {
    const result = evaluateCombination(world(), "SYN-LAPTOP", "SYN-GENERIC-PD-ADAPTER", "SYN-USBC-CABLE");
    expect(result.basic).toEqual({ verdict: "unknown", sources: [], gap: "pd-profile-not-established" });
  });

  it("the voltage must match: 15 V at 5 A does not satisfy a 20 V requirement, whatever the wattage", () => {
    const evidence = variant((d) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], watts: { value: 100, sources: ["S7"] }, pdProfiles: sku([{ volts: 15, amps: 5 }]) }));
    expect(usbC(evidence).basic).toMatchObject({ verdict: "unknown", gap: "pd-profile-not-established" });
  });

  it("the current must be at least the requirement at that voltage: 20 V at 3 A does not satisfy 20 V at 3.25 A", () => {
    const evidence = variant((d) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], pdProfiles: sku([{ volts: 20, amps: 3 }]) }));
    expect(usbC(evidence).basic).toMatchObject({ verdict: "unknown", gap: "pd-profile-not-established" });
  });

  it("the cable must be rated for the required current: a 3 A cable does not carry a 20 V / 5 A requirement; exactly the required current does", () => {
    const fiveAmps = (cableAmps: number) =>
      variant((d) => {
        d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: sku([{ ...usbCInput(), requiredPdProfiles: sku([{ volts: 20, amps: 5 }]) }]) };
        d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], pdProfiles: sku([{ volts: 20, amps: 5 }]) };
        d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], currentRatingAmps: sku(cableAmps) };
      });
    expect(usbC(fiveAmps(3)).basic).toMatchObject({ verdict: "unknown", gap: "cable-capability-not-established" });
    expect(usbC(fiveAmps(5)).basic.verdict).toBe("supported-pd-profile");
  });

  it("a sourced 'does not accept a PD source' is unknown, not unsupported", () => {
    expect(usbC(withUsbC((i) => (i.acceptsUsbPdSource = sku(false)))).basic).toMatchObject({ verdict: "unknown", gap: "pd-profile-not-established" });
  });

  it("the spec-page power-supply wattage, adapter ratings and included-adapter facts are never used, and their discrepancies block nothing", () => {
    const noisy = variant((d) => {
      d.devices["SYN-LAPTOP"] = {
        ...d.devices["SYN-LAPTOP"],
        specPagePowerSupplyWatts: discrepant("contradiction"),
        adapterRatings: discrepant("unresolved"),
        includedAdapter: { rating: discrepant("contradiction"), partNumber: discrepant("unresolved") },
      };
    });
    expect(usbC(noisy).basic.verdict).toBe("supported-pd-profile");
    // Negative control: a stated requirement alone, without the required PD profiles, establishes nothing.
    const requirementWithoutProfiles = withUsbC((i) => (i.requiredPdProfiles = unknownFact()));
    expect(usbC(requirementWithoutProfiles).basic.verdict).toBe("unknown");
  });

  it("wattage and fast charging are never asserted for a non-Apple device in C1", () => {
    const result = usbC(world());
    expect(result.wattage).toEqual({ verdict: "unknown", sources: [], watts: 65, includedWatts: [] });
    expect(result.fast).toEqual({ verdict: "not-listed", sources: [] });
  });
});

describe("SYNTHETIC: review findings (independent review of C1)", () => {
  it("finding 1: a discrepant, contradicted or family-scoped stated requirement blocks the result, even with matching profiles", () => {
    expect(usbC(withUsbC((i) => (i.requirement = discrepant("contradiction")))).basic).toMatchObject({ verdict: "unknown", gap: "sources-contradict" });
    expect(usbC(withUsbC((i) => (i.requirement = discrepant("unresolved")))).basic).toMatchObject({ verdict: "unknown", gap: "discrepancy-unresolved" });
    expect(usbC(withUsbC((i) => (i.requirement = family({ watts: 65, volts: 20 })))).basic).toMatchObject({ verdict: "unknown", gap: "family-scoped-only" });
  });

  it("finding 1: a stated requirement that disagrees with the required profile (voltage, or more power than the profile gives) is unresolved", () => {
    expect(usbC(withUsbC((i) => (i.requirement = sku({ watts: 100, volts: 20 })))).basic).toMatchObject({ verdict: "unknown", gap: "discrepancy-unresolved" });
    expect(usbC(withUsbC((i) => (i.requirement = sku({ watts: 45, volts: 19 })))).basic).toMatchObject({ verdict: "unknown", gap: "discrepancy-unresolved" });
    expect(usbC(withUsbC((i) => (i.requirement = sku({ watts: 60, volts: 20 })))).basic.verdict).toBe("supported-pd-profile");
  });

  it("finding 2: zero, negative or non-finite volts, amps or cable ratings never satisfy a requirement", () => {
    const zero = variant((d) => {
      d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: sku([{ ...usbCInput(), requiredPdProfiles: sku([{ volts: 20, amps: 0 }]), requirement: sku({ watts: 0, volts: 20 }) }]) };
      d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], pdProfiles: sku([{ volts: 20, amps: 0 }]) };
      d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], currentRatingAmps: sku(0) };
    });
    expect(usbC(zero).basic.verdict).toBe("unknown");
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(usbC(variant((d) => (d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], currentRatingAmps: sku(bad) }))).basic.verdict, `cable ${bad}`).toBe("unknown");
      expect(usbC(variant((d) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], pdProfiles: sku([{ volts: 20, amps: 3.25 }, { volts: bad, amps: 3 }]) }))).basic.verdict, `offered ${bad}`).toBe("unknown");
      expect(usbC(withUsbC((i) => (i.requiredPdProfiles = sku([{ volts: 20, amps: bad }])))).basic.verdict, `required ${bad}`).toBe("unknown");
    }
    expect(usbC(withUsbC((i) => (i.requiredPdProfiles = sku([])))).basic.verdict).toBe("unknown");
    expect(usbC(variant((d) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], pdProfiles: sku([]) }))).basic.verdict).toBe("unknown");
  });

  it("finding 3: an identifier that matches more than one entry (a shared model name) identifies nothing", () => {
    const twoSkus = variant((d) => {
      d.devices["SYN-BARREL-LAPTOP"] = { ...d.devices["SYN-BARREL-LAPTOP"], partIdentity: { ...d.devices["SYN-BARREL-LAPTOP"].partIdentity, model: "SYN-AG00-00PT-X1" } };
    });
    expect(selectDevice(twoSkus, { identifier: "SYN-AG00-00PT-X1" })).toEqual({ kind: "unidentified" });
    expect(selectDevice(twoSkus, { identifier: "SYN.NX.0000.001" })).toEqual({ kind: "identified", device: "SYN-LAPTOP" });
    const partEqualsOtherModel = variant((d) => {
      d.devices["SYN-BARREL-LAPTOP"] = { ...d.devices["SYN-BARREL-LAPTOP"], partIdentity: { ...d.devices["SYN-BARREL-LAPTOP"].partIdentity, model: "SYN.NX.0000.001" } };
    });
    expect(selectDevice(partEqualsOtherModel, { identifier: "SYN.NX.0000.001" })).toEqual({ kind: "unidentified" });
  });

  it("note 5: every documented USB-C input is checked; a second input with a conflicting fact blocks the result", () => {
    const second = (change: Partial<PowerInput>) =>
      variant((d) => (d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: sku([usbCInput(), { ...usbCInput(), whichPorts: sku("SYNTHETIC right USB-C port"), ...change }]) }));
    expect(usbC(second({})).basic.verdict).toBe("supported-pd-profile");
    expect(usbC(second({ requiredPdProfiles: discrepant("contradiction") })).basic).toMatchObject({ verdict: "unknown", gap: "sources-contradict" });
    expect(usbC(second({ requiredPdProfiles: sku([{ volts: 20, amps: 5 }]), requirement: sku({ watts: 100, volts: 20 }) })).basic).toMatchObject({ verdict: "unknown", gap: "pd-profile-not-established" });
  });

  it("note 6: every required profile must be offered, not just one of them", () => {
    // Both profiles agree with the stated requirement (20 V, at least 65 W), so only the "every profile offered" rule decides.
    const two = withUsbC((i) => {
      i.requiredPdProfiles = sku([{ volts: 20, amps: 3.25 }, { volts: 20, amps: 4 }]);
      i.requirement = sku({ watts: 65, volts: 20 });
    });
    expect(usbC(two).basic).toMatchObject({ verdict: "unknown", gap: "pd-profile-not-established" });
    const bothOffered = variant((d) => {
      d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: sku([{ ...usbCInput(), requiredPdProfiles: sku([{ volts: 20, amps: 3.25 }, { volts: 20, amps: 4 }]) }]) };
      d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], pdProfiles: sku([{ volts: 20, amps: 4 }]) };
    });
    expect(usbC(bothOffered).basic.verdict).toBe("supported-pd-profile");
  });

  it("note 7: a sourced 'no USB PD' on the adapter conflicts with its PD profiles and blocks the result", () => {
    const conflict = variant((d) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], usbPd: { value: false, sources: ["S7"] } }));
    expect(usbC(conflict).basic).toEqual({ verdict: "unknown", sources: [], gap: "discrepancy-unresolved" });
    const absent = variant((d) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], usbPd: null }));
    expect(usbC(absent).basic.verdict).toBe("supported-pd-profile");
  });

  it("note 8: an empty input list with a completeness fact is never 'unsupported'", () => {
    const empty = variant((d) => (d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: sku([]), powerInputsComplete: sku(true) }));
    expect(evaluateCombination(empty, "SYN-LAPTOP", "SYN-PD-ADAPTER", "SYN-MAGSAFE-CABLE").basic.verdict).toBe("unknown");
    expect(usbC(empty).basic.verdict).toBe("unknown");
  });

  it("note 4: Apple-only evidence cannot hold a manufacturer listing (type level; the Apple decision path is unchanged)", () => {
    const appleOnly: CompatibilityEvidence = {
      ...EVIDENCE,
      // @ts-expect-error — a manufacturer listing is not allowed in Apple-only evidence.
      configurations: [{ device: "Mac14,2", charger: "A2743", cable: "usb-c-charge-cable", kind: "pairing", basis: "manufacturer-listed", sources: ["S1"] }],
    };
    expect(appleOnly.configurations).toHaveLength(1);
  });
});

describe("SYNTHETIC: DC barrel inputs are never assessed by specification", () => {
  const barrel = (evidence: Evidence) => evaluateCombination(evidence, "SYN-BARREL-LAPTOP", "SYN-BARREL-ADAPTER", "SYN-BARREL-LEAD");
  it("identical sourced size, voltage and polarity without a manufacturer listing gives unknown", () => {
    expect(barrel(world()).basic).toEqual({ verdict: "unknown", sources: [], gap: "no-manufacturer-listing" });
  });
  it("an unknown polarity, inner diameter or voltage gives connector-details-unknown", () => {
    for (const field of ["polarity", "innerDiameterMm", "volts"] as const) {
      const evidence = variant((d) => (d.chargers["SYN-BARREL-ADAPTER"] = { ...d.chargers["SYN-BARREL-ADAPTER"], barrel: { ...matchingBarrel(), [field]: unknownFact() } }));
      expect(barrel(evidence).basic, field).toEqual({ verdict: "unknown", sources: [], gap: "connector-details-unknown" });
    }
    const noBarrelFacts = variant((d) => (d.chargers["SYN-BARREL-ADAPTER"] = { ...d.chargers["SYN-BARREL-ADAPTER"], barrel: undefined }));
    expect(barrel(noBarrelFacts).basic.gap).toBe("connector-details-unknown");
  });
  it("a family-scoped listing gives unknown (family-scoped-only), and an unverified identity blocks even an exact listing", () => {
    const listing = (scope: "sku" | "family") =>
      variant((d) => {
        d.configurations = [{ device: "SYN-BARREL-LAPTOP", charger: "SYN-BARREL-ADAPTER", cable: "SYN-BARREL-LEAD", kind: "pairing", basis: "manufacturer-listed", scope, sources: ["S3"] }];
      });
    expect(barrel(listing("family")).basic).toMatchObject({ verdict: "unknown", gap: "family-scoped-only" });
    const unverified = listing("sku");
    (unverified.devices as Draft["devices"])["SYN-BARREL-LAPTOP"] = { ...unverified.devices["SYN-BARREL-LAPTOP"], partIdentity: { ...unverified.devices["SYN-BARREL-LAPTOP"].partIdentity, status: "unverified" } };
    expect(barrel(unverified).basic).toMatchObject({ verdict: "unknown", gap: "identity-unverified" });
  });
  it("an Apple-listed or fast-charge entry never counts as a manufacturer listing for a non-Apple device", () => {
    const appleBasis = variant((d) => {
      d.configurations = [
        { device: "SYN-BARREL-LAPTOP", charger: "SYN-BARREL-ADAPTER", cable: "SYN-BARREL-LEAD", kind: "pairing", basis: "apple-listed", scope: "sku", sources: ["S1"] },
        { device: "SYN-BARREL-LAPTOP", charger: "SYN-BARREL-ADAPTER", cable: "SYN-BARREL-LEAD", kind: "fast-charge", basis: "manufacturer-listed", scope: "sku", sources: ["S3"] },
      ];
    });
    expect(barrel(appleBasis).basic.verdict).toBe("unknown");
  });
});

describe("SYNTHETIC: unsupported stays positive-only", () => {
  const magsafe = (evidence: Evidence) => evaluateCombination(evidence, "SYN-LAPTOP", "SYN-PD-ADAPTER", "SYN-MAGSAFE-CABLE");
  it("a connector absent from a documented input list is not unsupported without an exact-SKU completeness fact", () => {
    expect(magsafe(world()).basic).toMatchObject({ verdict: "unknown", gap: "no-manufacturer-listing" });
    const familyComplete = variant((d) => (d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputsComplete: family(true) }));
    expect(magsafe(familyComplete).basic.verdict).toBe("unknown");
  });
  it("with an exact-SKU completeness fact, a connector that is not an input gives unsupported", () => {
    const complete = variant((d) => (d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputsComplete: sku(true, ["S5"]) }));
    // The verdict also cites the cable's device-end evidence (S2), which is now required for unsupported.
    expect(magsafe(complete).basic).toEqual({ verdict: "unsupported", sources: ["S1", "S5", "S2"], gap: null });
    expect(usbC(complete).basic.verdict).toBe("supported-pd-profile");
  });
});

describe("SYNTHETIC: identity matching", () => {
  const evidence = world();
  const select = (input: { device?: string; identifier?: string }, e: Evidence = evidence): DeviceSelection<D> => selectDevice(e, input);
  it("identifies only the exact model or exact part number, ignoring case and surrounding spaces", () => {
    expect(select({ identifier: "SYN.NX.0000.001" })).toEqual({ kind: "identified", device: "SYN-LAPTOP" });
    expect(select({ identifier: "  syn-ag00-00pt-x1 " })).toEqual({ kind: "identified", device: "SYN-LAPTOP" });
    expect(select({ device: "SYN-LAPTOP", identifier: "SYN.NX.0000.001" })).toEqual({ kind: "identified", device: "SYN-LAPTOP" });
  });
  it("never identifies a partial part number, a family or brand name, a year or another model", () => {
    for (const identifier of ["SYN.NX.0000", "SYN.NX.0000.00", "SYN-AG00", "Aspire Go", "Acer", "ASUS", "Vivobook 16", "2024", "SYN.NX.0000.0011", "Mac14,2", "NX.JJJAA.008"]) {
      expect(select({ identifier }), identifier).toEqual({ kind: "unidentified" });
    }
    expect(select({ device: "SYN-LAPTOP", identifier: "SYN-90NB0000-M000" })).toEqual({ kind: "unidentified" });
  });
  it("an exact match to an unverified identity is 'unverified', never 'identified', from the list or by part number", () => {
    const unverified = variant((d) => (d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], partIdentity: { ...d.devices["SYN-LAPTOP"].partIdentity, status: "unverified" } }));
    expect(select({ identifier: "SYN.NX.0000.001" }, unverified)).toEqual({ kind: "unverified", device: "SYN-LAPTOP" });
    expect(select({ device: "SYN-LAPTOP" }, unverified)).toEqual({ kind: "unverified", device: "SYN-LAPTOP" });
    expect(usbC(unverified).basic).toEqual({ verdict: "unknown", sources: ["S6a"], gap: "identity-unverified" });
  });
  it("an 'unverified' selection renders the existing not-identified notice and no results (no new UI)", () => {
    const html = renderToStaticMarkup(createElement(ChargerInformation, { language: "en", selection: { kind: "unverified", device: "Mac14,2" } }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(chargerCopy("en").unidentified.replace(/'/g, "&#x27;"));
    expect(html).not.toContain("<table");
    expect(html).not.toContain('id="charger-results-heading"');
  });
});

describe("SYNTHETIC: every required fact, identity and listing needs its own citation (empty-source gap)", () => {
  const uncite = <T,>(fact: FactState<T> | undefined): FactState<T> => (fact?.status === "sourced" ? { ...fact, sources: [] } : (fact as FactState<T>));
  const extra: SourceId[] = ["S1", "S2", "S3", "S5", "S6a", "S6b", "S7", "S8"];
  const recite = <T,>(fact: FactState<T> | undefined): FactState<T> => (fact?.status === "sourced" ? { ...fact, sources: extra } : (fact as FactState<T>));
  type Draft2 = Draft;
  /** Removes the citation from one required fact and gives every other required fact extra citations (which must not compensate). */
  const PD_FACTS: [string, (d: Draft2, strip: boolean) => void, BasicGap][] = [
    ["identity", (d, strip) => (d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], partIdentity: { ...d.devices["SYN-LAPTOP"].partIdentity, sources: strip ? [] : extra } }), "identity-unverified"],
    ["charging-input list", (d, strip) => (d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: (strip ? uncite : recite)(d.devices["SYN-LAPTOP"].powerInputs) }), "no-evidence"],
    ["charging port", (d, strip) => mutateInput(d, (i) => (i.whichPorts = (strip ? uncite : recite)(i.whichPorts))), "charging-port-for-cable-not-documented"],
    ["accepts a USB PD source", (d, strip) => mutateInput(d, (i) => (i.acceptsUsbPdSource = (strip ? uncite : recite)(i.acceptsUsbPdSource))), "pd-profile-not-established"],
    ["required PD profiles", (d, strip) => mutateInput(d, (i) => (i.requiredPdProfiles = (strip ? uncite : recite)(i.requiredPdProfiles))), "pd-profile-not-established"],
    ["stated requirement", (d, strip) => mutateInput(d, (i) => (i.requirement = (strip ? uncite : recite)(i.requirement))), "pd-profile-not-established"],
    ["adapter output connector", (d, strip) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], output: { ...d.chargers["SYN-PD-ADAPTER"].output, sources: strip ? [] : extra } }), "no-evidence"],
    ["adapter PD profiles", (d, strip) => (d.chargers["SYN-PD-ADAPTER"] = { ...d.chargers["SYN-PD-ADAPTER"], pdProfiles: (strip ? uncite : recite)(d.chargers["SYN-PD-ADAPTER"].pdProfiles) }), "pd-profile-not-established"],
    ["cable current rating", (d, strip) => (d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], currentRatingAmps: (strip ? uncite : recite)(d.cables["SYN-USBC-CABLE"].currentRatingAmps) }), "cable-capability-not-established"],
    ["cable connector ends", (d, strip) => (d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], connectorEnds: (strip ? uncite : recite)(d.cables["SYN-USBC-CABLE"].connectorEnds) }), "cable-connectors-not-established"],
  ];
  function mutateInput(d: Draft2, change: (input: { -readonly [P in keyof PowerInput]: PowerInput[P] }) => void) {
    const inputs = d.devices["SYN-LAPTOP"].powerInputs;
    if (inputs.status !== "sourced") throw new Error("SYNTHETIC setup");
    const input = { ...inputs.value[0]! };
    change(input);
    d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: { ...inputs, value: [input] } };
  }

  it("positive control: with every required fact cited (and extra citations everywhere) the PD result is reachable", () => {
    const all = variant((d) => PD_FACTS.forEach(([, apply]) => apply(d, false)));
    expect(usbC(all).basic.verdict).toBe("supported-pd-profile");
  });
  for (const [label, apply, gap] of PD_FACTS) {
    it(`SYNTHETIC: an uncited ${label} gives unknown (${gap}); citations on every other fact do not compensate`, () => {
      const evidence = variant((d) => {
        for (const [other, applyOther] of PD_FACTS) if (other !== label) applyOther(d, false);
        apply(d, true);
      });
      const result = usbC(evidence);
      expect(result.basic.verdict).toBe("unknown");
      expect(result.basic.gap).toBe(gap);
    });
  }
  it("SYNTHETIC: with every citation removed together, the PD result is unknown and selection is unverified", () => {
    const none = variant((d) => PD_FACTS.forEach(([, apply]) => apply(d, true)));
    expect(usbC(none).basic).toMatchObject({ verdict: "unknown", gap: "identity-unverified" });
    expect(selectDevice(none, { identifier: "SYN.NX.0000.001" })).toEqual({ kind: "unverified", device: "SYN-LAPTOP" });
  });

  it("SYNTHETIC device selection: a 'verified' identity without a citation is unverified, by part number, by model and from the list", () => {
    const uncitedIdentity = variant((d) => (d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], partIdentity: { ...d.devices["SYN-LAPTOP"].partIdentity, sources: [] } }));
    for (const input of [{ identifier: "SYN.NX.0000.001" }, { identifier: "SYN-AG00-00PT-X1" }, { device: "SYN-LAPTOP" }]) {
      expect(selectDevice(uncitedIdentity, input), JSON.stringify(input)).toEqual({ kind: "unverified", device: "SYN-LAPTOP" });
    }
    expect(selectDevice(world(), { device: "SYN-LAPTOP" })).toEqual({ kind: "identified", device: "SYN-LAPTOP" });
  });

  describe("SYNTHETIC manufacturer-listed barrel configurations", () => {
    const barrelListing = (sources: SourceId[], identitySources: SourceId[] = ["S6a"], outputSources: SourceId[] = ["S7"]) =>
      variant((d) => {
        d.configurations = [{ device: "SYN-BARREL-LAPTOP", charger: "SYN-BARREL-ADAPTER", cable: "SYN-BARREL-LEAD", kind: "pairing", basis: "manufacturer-listed", scope: "sku", sources }];
        d.devices["SYN-BARREL-LAPTOP"] = { ...d.devices["SYN-BARREL-LAPTOP"], partIdentity: { ...d.devices["SYN-BARREL-LAPTOP"].partIdentity, sources: identitySources } };
        d.chargers["SYN-BARREL-ADAPTER"] = { ...d.chargers["SYN-BARREL-ADAPTER"], output: { ...d.chargers["SYN-BARREL-ADAPTER"].output, sources: outputSources } };
      });
    const barrel = (evidence: Evidence) => evaluateCombination(evidence, "SYN-BARREL-LAPTOP", "SYN-BARREL-ADAPTER", "SYN-BARREL-LEAD").basic;
    it("positive control: a cited exact-SKU listing with a cited identity gives supported-manufacturer-listed", () => {
      expect(barrel(barrelListing(["S3"]))).toEqual({ verdict: "supported-manufacturer-listed", sources: ["S6a", "S3"], gap: null });
    });
    it("an uncited listing gives unknown, even with a cited identity", () => {
      expect(barrel(barrelListing([])).verdict).toBe("unknown");
    });
    it("an uncited identity gives unknown (identity-unverified), even with a cited listing", () => {
      expect(barrel(barrelListing(["S3"], []))).toMatchObject({ verdict: "unknown", gap: "identity-unverified" });
    });
    it("an uncited listing and an uncited identity together give unknown", () => {
      expect(barrel(barrelListing([], [], []))).toMatchObject({ verdict: "unknown", gap: "identity-unverified" });
    });
    it("an uncited adapter output connector with no listing gives unknown", () => {
      const evidence = variant((d) => (d.chargers["SYN-BARREL-ADAPTER"] = { ...d.chargers["SYN-BARREL-ADAPTER"], output: { ...d.chargers["SYN-BARREL-ADAPTER"].output, sources: [] } }));
      expect(barrel(evidence).verdict).toBe("unknown");
    });
  });

  describe("SYNTHETIC unsupported needs a cited charging-input list and a cited completeness fact", () => {
    const magsafe = (evidence: Evidence) => evaluateCombination(evidence, "SYN-LAPTOP", "SYN-PD-ADAPTER", "SYN-MAGSAFE-CABLE").basic;
    const complete = (inputsCited: boolean, completeCited: boolean) =>
      variant((d) => {
        const inputs = d.devices["SYN-LAPTOP"].powerInputs;
        d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputs: inputsCited ? inputs : uncite(inputs), powerInputsComplete: completeCited ? sku(true, ["S5"]) : sku(true, []) };
      });
    it("positive control: both cited gives unsupported", () => expect(magsafe(complete(true, true)).verdict).toBe("unsupported"));
    it("an uncited input list is never unsupported", () => expect(magsafe(complete(false, true)).verdict).toBe("unknown"));
    it("an uncited completeness fact is never unsupported", () => expect(magsafe(complete(true, false)).verdict).toBe("unknown"));
    it("both uncited is never unsupported", () => expect(magsafe(complete(false, false)).verdict).toBe("unknown"));
  });
});

describe("SYNTHETIC: cable connector ends need their own cited, exact-scope, consistent fact", () => {
  type Ends = { chargerEnd: "usb-c" | "magsafe-3" | "dc-barrel" | "magsafe-2"; deviceEnd: "usb-c" | "magsafe-3" | "dc-barrel" | "magsafe-2" };
  const withCable = (change: Partial<CableEvidence<K>>) => variant((d) => (d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], ...change }));
  const magsafe = (evidence: Evidence) => evaluateCombination(evidence, "SYN-LAPTOP", "SYN-PD-ADAPTER", "SYN-MAGSAFE-CABLE").basic;
  const completeInputs = (change: Partial<CableEvidence<K>> = {}) =>
    variant((d) => {
      d.devices["SYN-LAPTOP"] = { ...d.devices["SYN-LAPTOP"], powerInputsComplete: sku(true, ["S5"]) };
      d.cables["SYN-MAGSAFE-CABLE"] = { ...d.cables["SYN-MAGSAFE-CABLE"], ...change };
    });

  it("positive control: cited exact-scope ends that match the plain fields allow the PD result, citing the ends", () => {
    const result = usbC(world());
    expect(result.basic.verdict).toBe("supported-pd-profile");
    expect(result.basic.sources).toContain("S8");
  });

  it("a cited current rating does not establish connector identity: rating cited, ends absent → unknown", () => {
    const ratedOnly = withCable({ connectorEnds: undefined, currentRatingAmps: sku(5, ["S1", "S2", "S3", "S8"]) });
    expect(usbC(ratedOnly).basic).toEqual({ verdict: "unknown", sources: [], gap: "cable-connectors-not-established" });
  });

  const BAD_ENDS: [string, () => FactState<Ends> | undefined, BasicGap][] = [
    ["missing", () => undefined, "cable-connectors-not-established"],
    ["unknown", () => unknownFact<Ends>(), "cable-connectors-not-established"],
    ["uncited", () => sku<Ends>({ chargerEnd: "usb-c", deviceEnd: "usb-c" }, []), "cable-connectors-not-established"],
    ["family-scoped", () => family<Ends>({ chargerEnd: "usb-c", deviceEnd: "usb-c" }), "family-scoped-only"],
    ["an unresolved discrepancy", () => discrepant<Ends>("unresolved"), "discrepancy-unresolved"],
    ["an established contradiction", () => discrepant<Ends>("contradiction"), "sources-contradict"],
    ["inconsistent with the plain device end", () => sku<Ends>({ chargerEnd: "usb-c", deviceEnd: "magsafe-3" }, ["S8"]), "discrepancy-unresolved"],
    ["inconsistent with the plain adapter end", () => sku<Ends>({ chargerEnd: "magsafe-2", deviceEnd: "usb-c" }, ["S8"]), "discrepancy-unresolved"],
  ];
  for (const [label, ends, gap] of BAD_ENDS) {
    it(`${label} connector ends prevent specification support (${gap})`, () => {
      expect(usbC(withCable({ connectorEnds: ends() as CableEvidence<K>["connectorEnds"] })).basic).toMatchObject({ verdict: "unknown", gap });
    });
  }

  it("changing only the plain connector field (cited fact unchanged) removes specification support", () => {
    expect(usbC(world()).basic.verdict).toBe("supported-pd-profile");
    expect(usbC(withCable({ deviceEnd: "magsafe-3" })).basic).toMatchObject({ verdict: "unknown", gap: "discrepancy-unresolved" });
    expect(usbC(withCable({ chargerEnd: "magsafe-2" })).basic).toMatchObject({ verdict: "unknown", gap: "discrepancy-unresolved" });
  });

  it("the plain fields alone (both ends USB-C, rating cited) never establish the connectors", () => {
    expect(usbC(withCable({ connectorEnds: undefined })).basic).toMatchObject({ verdict: "unknown", gap: "cable-connectors-not-established" });
  });

  it("cited ends that are not USB-C at both ends never give a PD result", () => {
    const toMagSafe = withCable({ deviceEnd: "magsafe-3", connectorEnds: sku({ chargerEnd: "usb-c", deviceEnd: "magsafe-3" }, ["S8"]) });
    expect(usbC(toMagSafe).basic.verdict).toBe("unknown");
  });

  describe("unsupported needs cited device-end evidence", () => {
    it("positive control: cited inputs, cited completeness and cited consistent ends give unsupported, citing the ends", () => {
      expect(magsafe(completeInputs())).toEqual({ verdict: "unsupported", sources: ["S1", "S5", "S2"], gap: null });
    });
    for (const [label, ends] of [
      ["missing", undefined],
      ["uncited", sku<Ends>({ chargerEnd: "usb-c", deviceEnd: "magsafe-3" }, [])],
      ["family-scoped", family<Ends>({ chargerEnd: "usb-c", deviceEnd: "magsafe-3" })],
      ["discrepant", discrepant<Ends>("unresolved")],
      ["inconsistent with the plain device end", sku<Ends>({ chargerEnd: "usb-c", deviceEnd: "usb-c" }, ["S2"])],
    ] as const) {
      it(`${label} device-end evidence is never unsupported`, () => {
        expect(magsafe(completeInputs({ connectorEnds: ends as CableEvidence<K>["connectorEnds"] })).verdict).toBe("unknown");
      });
    }
    it("changing only the plain device end (cited fact still MagSafe 3) is never unsupported", () => {
      expect(magsafe(completeInputs({ deviceEnd: "dc-barrel" })).verdict).toBe("unknown");
    });
  });

  it("an explicit cited exact-SKU manufacturer listing remains an independent basis, without connector-end facts", () => {
    const listed = variant((d) => {
      d.cables["SYN-USBC-CABLE"] = { ...d.cables["SYN-USBC-CABLE"], connectorEnds: undefined, currentRatingAmps: undefined };
      d.configurations = [{ device: "SYN-LAPTOP", charger: "SYN-PD-ADAPTER", cable: "SYN-USBC-CABLE", kind: "pairing", basis: "manufacturer-listed", scope: "sku", sources: ["S3"] }];
    });
    expect(usbC(listed).basic).toEqual({ verdict: "supported-manufacturer-listed", sources: ["S6a", "S3"], gap: null });
  });
});

describe("SYNTHETIC mixed Apple/non-Apple evidence: the Apple listing path needs Apple attribution and an applicable scope at runtime", () => {
  type MD = DeviceId | D;
  type MC = ChargerId | C;
  type MK = CableId | K;
  type Mixed = CompatibilityEvidence<MD, MC, MK, AnyDeviceEvidence<MD>>;
  type MixedConfiguration = DocumentedConfiguration<MD, MC, MK>;
  const synthetic = world();
  const mixed = (configurations: readonly MixedConfiguration[] = EVIDENCE.configurations): Mixed => ({
    devices: { ...EVIDENCE.devices, ...synthetic.devices },
    chargers: { ...EVIDENCE.chargers, ...synthetic.chargers },
    cables: { ...EVIDENCE.cables, ...synthetic.cables },
    configurations,
  });
  const air = (evidence: Mixed) => evaluateCombination(evidence, "Mac14,2", "A2743", "usb-c-charge-cable");
  const listing = (extra: Record<string, unknown>, kind: "pairing" | "fast-charge" = "pairing") =>
    ({ device: "Mac14,2", charger: "A2743", cable: "usb-c-charge-cable", kind, sources: ["S1"], ...extra }) as unknown as MixedConfiguration;

  it("with the curated configurations, every Apple result in mixed evidence equals the golden fixture", () => {
    const golden = JSON.parse(readFileSync("tests/fixtures/charger-apple-golden.json", "utf8")).results;
    const results = DEVICE_IDS.flatMap((device) => CHARGER_IDS.flatMap((charger) => CABLE_IDS.map((cable) => evaluateCombination(mixed(), device, charger, cable))));
    expect(JSON.parse(JSON.stringify(results))).toEqual(golden);
  });

  it("positive controls: an Apple-attributed listing without a scope (curated form) or with an exact-SKU scope gives 'Apple lists'", () => {
    expect(air(mixed([listing({ basis: "apple-listed" })])).basic).toEqual({ verdict: "supported-apple-listed", sources: ["S1"], gap: null });
    expect(air(mixed([listing({ basis: "apple-listed", scope: "sku" })])).basic.verdict).toBe("supported-apple-listed");
    const fast = air(mixed([listing({ basis: "apple-listed" }, "fast-charge")]));
    expect(fast.basic.verdict).toBe("supported-apple-fast-charge-list");
    expect(fast.fast.verdict).toBe("listed");
  });

  const INVALID: [string, Record<string, unknown>][] = [
    ["a manufacturer listing", { basis: "manufacturer-listed" }],
    ["a manufacturer listing for the exact SKU", { basis: "manufacturer-listed", scope: "sku" }],
    ["a missing attribution", {}],
    ["an empty attribution", { basis: "" }],
    ["a differently written attribution", { basis: "Apple-Listed" }],
    ["an ambiguous attribution (several values)", { basis: ["apple-listed", "manufacturer-listed"] }],
    ["an Apple attribution with a family scope", { basis: "apple-listed", scope: "family" }],
    ["an Apple attribution with an unexpected scope", { basis: "apple-listed", scope: "model-line" }],
  ];
  for (const [label, extra] of INVALID) {
    it(`SYNTHETIC: ${label} never gives "Apple lists", Apple's fast-charge list or any supported result`, () => {
      for (const kind of ["pairing", "fast-charge"] as const) {
        const result = air(mixed([listing(extra, kind)]));
        expect(result.basic, `${label} (${kind})`).toEqual({ verdict: "unknown", sources: ["S2"], gap: "no-listed-configuration" });
        expect(result.fast, `${label} (${kind})`).toEqual({ verdict: "not-listed", sources: [] });
      }
    });
  }

  it("SYNTHETIC: an invalid listing next to a valid Apple listing adds none of its sources", () => {
    const result = air(mixed([listing({ basis: "apple-listed", sources: ["S7"] }), listing({ basis: "manufacturer-listed", sources: ["S3"] }), listing({ basis: "apple-listed", scope: "family", sources: ["S5"] })]));
    expect(result.basic).toEqual({ verdict: "supported-apple-listed", sources: ["S7"], gap: null });
  });

  it("SYNTHETIC: in mixed evidence, an Apple listing on a non-Apple device and a manufacturer listing on an Apple device both stay unknown", () => {
    const crossed = mixed([
      { device: "SYN-BARREL-LAPTOP", charger: "SYN-BARREL-ADAPTER", cable: "SYN-BARREL-LEAD", kind: "pairing", basis: "apple-listed", scope: "sku", sources: ["S1"] },
      { device: "Mac14,2", charger: "SYN-BARREL-ADAPTER", cable: "SYN-BARREL-LEAD", kind: "pairing", basis: "manufacturer-listed", scope: "sku", sources: ["S3"] },
    ]);
    expect(evaluateCombination(crossed, "SYN-BARREL-LAPTOP", "SYN-BARREL-ADAPTER", "SYN-BARREL-LEAD").basic.verdict).toBe("unknown");
    expect(evaluateCombination(crossed, "Mac14,2", "SYN-BARREL-ADAPTER", "SYN-BARREL-LEAD").basic.verdict).toBe("unknown");
  });
});

describe("curated evidence stays Apple-only (no real non-Apple laptop, adapter, cable or listing in C1)", () => {
  it("has no non-Apple device and no C1 fact on any adapter, cable or configuration", () => {
    expect(Object.values(EVIDENCE.devices).some((device) => isMakerDevice(device))).toBe(false);
    for (const charger of Object.values(EVIDENCE.chargers)) {
      expect(charger.pdProfiles, charger.id).toBeUndefined();
      expect(charger.barrel, charger.id).toBeUndefined();
      expect(charger.output.value, charger.id).not.toBe("dc-barrel");
    }
    for (const cable of Object.values(EVIDENCE.cables)) {
      expect(cable.currentRatingAmps, cable.id).toBeUndefined();
      expect(cable.connectorEnds, cable.id).toBeUndefined();
    }
    for (const configuration of EVIDENCE.configurations) {
      expect(configuration.basis).toBe("apple-listed");
      expect(configuration.scope).toBeUndefined();
    }
  });
});

describe("C1 copy is neutral and distinguishes unresolved discrepancies from established contradictions", () => {
  const NEW_GAPS: BasicGap[] = [
    "identity-unverified",
    "discrepancy-unresolved",
    "sources-contradict",
    "family-scoped-only",
    "connector-details-unknown",
    "pd-profile-not-established",
    "cable-capability-not-established",
    "cable-connectors-not-established",
    "no-manufacturer-listing",
  ];
  for (const language of ["en", "es"] as const) {
    it(`${language}: every new gap has its own text, and none says that a configuration works, fails or is compatible`, () => {
      const copy = chargerCopy(language);
      const texts = NEW_GAPS.map((gap) => copy.gap(gap, ["usb-c"], "usb-c"));
      expect(new Set(texts).size).toBe(NEW_GAPS.length);
      for (const text of texts) {
        expect(text.length).toBeGreaterThan(40);
        expect(text).not.toMatch(/compatib|supported|unsupported|works|will charge|admitid|funciona|cargará/i);
      }
      const [unresolved, contradiction] = [copy.gap("discrepancy-unresolved", [], "usb-c"), copy.gap("sources-contradict", [], "usb-c")];
      expect(unresolved).not.toMatch(/contradict|contradicen/i);
      expect(contradiction).toMatch(language === "en" ? /contradict/ : /contradicen/);
      for (const verdict of ["supported-manufacturer-listed", "supported-pd-profile"] as const) {
        expect(copy.basic[verdict]).not.toMatch(/compatib|supported|admitid|funciona/i);
        expect(copy.basic[verdict]).toMatch(language === "en" ? /exact model and part number/ : /modelo y número de pieza exactos/);
      }
    });
  }
});
