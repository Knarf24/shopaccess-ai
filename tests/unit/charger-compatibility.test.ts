import { describe, expect, it } from "vitest";

import { EVIDENCE, SOURCES, type CableId, type ChargerId, type CompatibilityEvidence, type DeviceId } from "@/lib/compatibility/evidence";
import { evaluateCombination, selectDevice } from "@/lib/compatibility/rules";

// F03 information slice (owner-approved October 18; raw-source correction after Codex's review): three separate claims per
// exact device + adapter + cable configuration, each from its own evidence. Basic support distinguishes Apple-listed
// configurations; nothing is described as tested. Unsupported needs positive evidence of a mismatch.
const AIR: DeviceId = "Mac14,2";
const PRO_2015: DeviceId = "MacBookPro12,1";
const W70: ChargerId = "A2743";
const W140: ChargerId = "A2452";
const MAGSAFE3: CableId = "usb-c-to-magsafe-3";
const USBC: CableId = "usb-c-charge-cable";

const evaluate = (device: DeviceId, charger: ChargerId, cable: CableId, evidence: CompatibilityEvidence = EVIDENCE) =>
  evaluateCombination(evidence, device, charger, cable);

type Draft = { -readonly [K in keyof CompatibilityEvidence]: CompatibilityEvidence[K] };
/** A copy of the evidence with one change applied (the curated data itself is never modified). */
function variant(change: (draft: Draft) => void): CompatibilityEvidence {
  const draft = structuredClone(EVIDENCE) as Draft;
  change(draft);
  return draft;
}

describe("curated evidence", () => {
  it("cites only known Apple sources with an access date", () => {
    for (const source of Object.values(SOURCES)) {
      expect(source.url, source.id).toMatch(/^https:\/\/(support\.apple\.com|www\.apple\.com)\//);
      expect(source.accessed, source.id).toBe("2026-10-18");
    }
    const cited = [
      ...Object.values(EVIDENCE.devices).flatMap((d) => [d.identity, d.chargingPorts, d.chargingPortsComplete, d.includedAdapterWatts].flatMap((f) => f?.sources ?? [])),
      ...Object.values(EVIDENCE.chargers).flatMap((c) => [...c.output.sources, ...c.watts.sources, ...c.modelNumber.sources, ...(c.usbPd?.sources ?? [])]),
      ...EVIDENCE.configurations.flatMap((c) => c.sources),
    ];
    for (const id of cited) expect(SOURCES[id], id).toBeDefined();
  });

  it("states no fact that no captured source gives: no USB PD, no complete port list, no 'no USB-C'", () => {
    expect(EVIDENCE.chargers.A2743.usbPd).toBeNull();
    expect(EVIDENCE.chargers.A2452.usbPd).toBeNull();
    // S5 documents a MagSafe 2 power port; it does not establish that this is the only charging input.
    expect(EVIDENCE.devices[PRO_2015].chargingPorts).toEqual({ value: ["magsafe-2"], sources: ["S5"] });
    for (const device of Object.values(EVIDENCE.devices)) expect(device.chargingPortsComplete, device.id).toBeNull();
    expect(JSON.stringify(EVIDENCE)).not.toMatch(/usbCCharging|"no-usb-c"|portFamilies/);
  });

  it("adapter model numbers come from test footnotes about other Mac models, and no configuration is described as tested", () => {
    expect(EVIDENCE.chargers.A2743.modelNumber).toEqual({ value: "A2743", sources: ["S3", "S7"] });
    expect(EVIDENCE.chargers.A2452.modelNumber).toEqual({ value: "A2452", sources: ["S3", "S8"] });
    for (const configuration of EVIDENCE.configurations) expect(configuration.basis, JSON.stringify(configuration)).toBe("apple-listed");
  });
});

describe("the evidence matrix (curated)", () => {
  it("MacBook Air (M2, 2022) with the 70W adapter: Apple-listed for both cables; wattage above both included adapters; fast-charge listed", () => {
    for (const cable of [MAGSAFE3, USBC]) {
      const result = evaluate(AIR, W70, cable);
      expect(result.basic.verdict, cable).toBe("supported-apple-listed");
      expect(result.basic.sources, cable).toContain("S7");
      expect(result.wattage).toMatchObject({ verdict: "at-or-above-all", watts: 70, includedWatts: [30, 35] });
      expect(result.wattage.sources).toEqual(expect.arrayContaining(["S2", "S7"]));
      expect(result.fast.verdict, cable).toBe("listed");
      expect(result.fast.sources, cable).toContain("S3");
    }
    expect(evaluate(AIR, W70, MAGSAFE3).basic.sources).toContain("S1");
  });

  it("MacBook Air (M2, 2022) with the 140W adapter: supported only through Apple's listed fast-charge configurations", () => {
    for (const cable of [MAGSAFE3, USBC]) {
      const result = evaluate(AIR, W140, cable);
      expect(result.basic, cable).toEqual({ verdict: "supported-apple-fast-charge-list", sources: ["S3"], gap: null });
      expect(result.wattage).toMatchObject({ verdict: "at-or-above-all", watts: 140, includedWatts: [30, 35] });
      expect(result.fast, cable).toEqual({ verdict: "listed", sources: ["S3"] });
    }
  });

  it("MacBook Pro (Retina, 13-inch, Early 2015) with a USB-C charge cable: unknown, with the specific gap; wattage and fast charging evaluated on their own", () => {
    for (const charger of [W70, W140]) {
      const result = evaluate(PRO_2015, charger, USBC);
      expect(result.basic, charger).toEqual({ verdict: "unknown", sources: ["S5"], gap: "charging-port-for-cable-not-documented" });
      expect(result.wattage, charger).toMatchObject({ verdict: "at-or-above-all", includedWatts: [60] });
      expect(result.fast, charger).toEqual({ verdict: "not-listed", sources: [] });
    }
  });

  it("MacBook Pro (Retina, 13-inch, Early 2015) with a USB-C to MagSafe 3 cable: unknown, because the sources do not say whether MagSafe 3 fits MagSafe 2", () => {
    for (const charger of [W70, W140]) {
      const result = evaluate(PRO_2015, charger, MAGSAFE3);
      expect(result.basic, charger).toEqual({ verdict: "unknown", sources: ["S5"], gap: "connector-generation-differs" });
      expect(result.wattage, charger).toMatchObject({ verdict: "at-or-above-all", includedWatts: [60] });
      expect(result.fast.verdict, charger).toBe("not-listed");
    }
  });

  it("no curated configuration is unsupported", () => {
    for (const device of [AIR, PRO_2015]) {
      for (const charger of [W70, W140]) {
        for (const cable of [MAGSAFE3, USBC]) expect(evaluate(device, charger, cable).basic.verdict, `${device} ${charger} ${cable}`).not.toBe("unsupported");
      }
    }
  });
});

describe("removing the evidence a claim needs affects only that claim", () => {
  it("without the 70W listings, basic support for the Air rests on the fast-charge list; wattage is unchanged", () => {
    const evidence = variant((d) => {
      d.configurations = d.configurations.filter((c) => c.kind !== "pairing");
    });
    const result = evaluate(AIR, W70, MAGSAFE3, evidence);
    expect(result.basic).toEqual({ verdict: "supported-apple-fast-charge-list", sources: ["S3", "S2"], gap: null });
    expect(result.wattage.verdict).toBe("at-or-above-all");
  });

  it("without any listed configuration, the Air's basic support is unknown (no USB PD fact to fall back on); wattage stays", () => {
    const evidence = variant((d) => {
      d.configurations = [];
    });
    for (const charger of [W70, W140]) {
      for (const cable of [MAGSAFE3, USBC]) {
        const result = evaluate(AIR, charger, cable, evidence);
        expect(result.basic, `${charger} ${cable}`).toMatchObject({ verdict: "unknown", gap: "no-listed-configuration" });
        expect(result.wattage.verdict, `${charger} ${cable}`).toBe("at-or-above-all");
        expect(result.fast.verdict, `${charger} ${cable}`).toBe("not-listed");
      }
    }
  });

  it("without the fast-charge entries, only fast charging changes for the 70W listings", () => {
    const evidence = variant((d) => {
      d.configurations = d.configurations.filter((c) => c.kind !== "fast-charge");
    });
    const result = evaluate(AIR, W70, USBC, evidence);
    expect(result.basic).toEqual({ verdict: "supported-apple-listed", sources: ["S7"], gap: null });
    expect(result.wattage.verdict).toBe("at-or-above-all");
    expect(result.fast).toEqual({ verdict: "not-listed", sources: [] });
  });

  it("without the 2015 model's documented charging port, its gap becomes general; wattage and fast charging are unaffected", () => {
    const evidence = variant((d) => {
      d.devices = { ...d.devices, [PRO_2015]: { ...d.devices[PRO_2015], chargingPorts: null } };
    });
    const result = evaluate(PRO_2015, W70, USBC, evidence);
    expect(result.basic).toEqual({ verdict: "unknown", sources: [], gap: "no-evidence" });
    expect(result.wattage.verdict).toBe("at-or-above-all");
    expect(result.fast.verdict).toBe("not-listed");
  });

  it("without the included-adapter wattage, only the wattage claim becomes unknown", () => {
    const evidence = variant((d) => {
      d.devices = { ...d.devices, [AIR]: { ...d.devices[AIR], includedAdapterWatts: null } };
    });
    const result = evaluate(AIR, W70, MAGSAFE3, evidence);
    expect(result.wattage.verdict).toBe("unknown");
    expect(result.basic.verdict).toBe("supported-apple-listed");
    expect(result.fast.verdict).toBe("listed");
  });

  it("a lower-wattage adapter is reported as below, without changing basic support", () => {
    const evidence = variant((d) => {
      d.chargers = { ...d.chargers, [W70]: { ...d.chargers[W70], watts: { value: 30, sources: ["S7"] } } };
    });
    const result = evaluate(AIR, W70, MAGSAFE3, evidence);
    expect(result.wattage).toMatchObject({ verdict: "at-or-above-some", watts: 30, includedWatts: [30, 35] });
    expect(result.basic.verdict).toBe("supported-apple-listed");
    const lower = variant((d) => {
      d.chargers = { ...d.chargers, [W70]: { ...d.chargers[W70], watts: { value: 20, sources: ["S7"] } } };
    });
    expect(evaluate(AIR, W70, MAGSAFE3, lower).wattage.verdict).toBe("below-all");
  });
});

// SYNTHETIC EVIDENCE. The facts injected below are invented for these tests to exercise rule branches. They are not
// curated, not Apple statements, and not real-world results for any Mac.
describe("rule branches exercised only with SYNTHETIC evidence", () => {
  it("SYNTHETIC: a positively complete charging-port list without the cable's connector gives unsupported; wattage and fast charging stay independent", () => {
    const synthetic = variant((d) => {
      d.devices = { ...d.devices, [PRO_2015]: { ...d.devices[PRO_2015], chargingPortsComplete: { value: true, sources: ["S5"] } } };
    });
    const usbC = evaluate(PRO_2015, W70, USBC, synthetic);
    expect(usbC.basic).toEqual({ verdict: "unsupported", sources: ["S5"], gap: null });
    expect(usbC.wattage.verdict).toBe("at-or-above-all");
    expect(usbC.fast.verdict).toBe("not-listed");
    // A different MagSafe generation is still a mismatch once the list is positively complete.
    expect(evaluate(PRO_2015, W70, MAGSAFE3, synthetic).basic.verdict).toBe("unsupported");
    // An Apple listing takes precedence over the synthetic completeness fact.
    const listed = variant((d) => {
      d.devices = { ...d.devices, [AIR]: { ...d.devices[AIR], chargingPortsComplete: { value: true, sources: ["S2"] } } };
    });
    expect(evaluate(AIR, W70, USBC, listed).basic.verdict).toBe("supported-apple-listed");
  });

  it("SYNTHETIC: a sourced USB PD fact enables the specification-based path, only for a USB-C cable into a documented USB-C charging port", () => {
    const synthetic = variant((d) => {
      d.configurations = [];
      d.chargers = { ...d.chargers, [W70]: { ...d.chargers[W70], usbPd: { value: true, sources: ["S1"] } } };
    });
    expect(evaluate(AIR, W70, USBC, synthetic).basic).toEqual({ verdict: "supported-specification", sources: expect.arrayContaining(["S1", "S2"]), gap: null });
    expect(evaluate(AIR, W70, MAGSAFE3, synthetic).basic.verdict).toBe("unknown");
    expect(evaluate(PRO_2015, W70, USBC, synthetic).basic).toMatchObject({ verdict: "unknown", gap: "charging-port-for-cable-not-documented" });
  });
});

describe("device selection", () => {
  it("selects only a curated model, from the list or an exact model identifier", () => {
    expect(selectDevice(EVIDENCE, { device: "Mac14,2" })).toEqual({ kind: "identified", device: AIR });
    expect(selectDevice(EVIDENCE, { identifier: " macbookpro12,1 " })).toEqual({ kind: "identified", device: PRO_2015 });
    expect(selectDevice(EVIDENCE, {})).toEqual({ kind: "none" });
    expect(selectDevice(EVIDENCE, { device: "", identifier: "" })).toEqual({ kind: "none" });
  });

  it("never identifies a description, a year, a partial name or an unknown identifier", () => {
    for (const identifier of ["MacBook Pro 2019", "MacBook Air M2", "2015", "Mac14", "Mac14,20", "MacBookPro15,4", "MacBook Air (M2, 2022)", "__proto__", "constructor"]) {
      expect(selectDevice(EVIDENCE, { identifier }), identifier).toEqual({ kind: "unidentified" });
    }
    expect(selectDevice(EVIDENCE, { device: "toString" })).toEqual({ kind: "unidentified" });
  });

  it("an identifier that disagrees with the chosen model leaves the device unidentified", () => {
    expect(selectDevice(EVIDENCE, { device: "Mac14,2", identifier: "MacBookPro12,1" })).toEqual({ kind: "unidentified" });
    expect(selectDevice(EVIDENCE, { device: "Mac14,2", identifier: "Mac14,2" })).toEqual({ kind: "identified", device: AIR });
  });
});
