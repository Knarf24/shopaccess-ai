/**
 * F03 charger information slice: curated evidence (October 18, 2026). Every fact cites the Apple page it came from; the
 * excerpts were matched verbatim in saved copies of those pages (private curation record, outside the repository).
 * Nothing here is inferred from a connector name or a wattage. Information only: these products are not sold here.
 */

export type SourceId = "S1" | "S2" | "S3" | "S5" | "S6a" | "S6b" | "S7" | "S8";

export interface EvidenceSource {
  readonly id: SourceId;
  readonly title: string;
  readonly url: string;
  /** Date the page was read and saved, America/New_York. */
  readonly accessed: string;
}

export const SOURCES: Readonly<Record<SourceId, EvidenceSource>> = {
  S1: { id: "S1", title: "Use a power adapter with your Mac", url: "https://support.apple.com/en-us/109509", accessed: "2026-10-18" },
  S2: { id: "S2", title: "MacBook Air (M2, 2022) - Tech Specs", url: "https://support.apple.com/en-us/111867", accessed: "2026-10-18" },
  S3: { id: "S3", title: "Fast charge your MacBook Air or MacBook Pro", url: "https://support.apple.com/en-us/102378", accessed: "2026-10-18" },
  S5: {
    id: "S5",
    title: "MacBook Pro (Retina, 13-inch, Early 2015) - Technical Specifications",
    url: "https://support.apple.com/en-us/111959",
    accessed: "2026-10-18",
  },
  S6a: { id: "S6a", title: "Identify your MacBook Air model", url: "https://support.apple.com/en-us/102869", accessed: "2026-10-18" },
  S6b: { id: "S6b", title: "Identify your MacBook Pro model", url: "https://support.apple.com/en-us/108052", accessed: "2026-10-18" },
  S7: { id: "S7", title: "70W USB-C Power Adapter", url: "https://www.apple.com/shop/product/mxn53am/a/70w-usb-c-power-adapter", accessed: "2026-10-18" },
  S8: { id: "S8", title: "140W USB-C Power Adapter", url: "https://www.apple.com/shop/product/mw2m3am/a/140w-usb-c-power-adapter", accessed: "2026-10-18" },
};

/**
 * Connector types as Apple names them. A cable is "unsupported" only when positive evidence says the device's documented
 * charging ports are its complete list and the cable's connector is not among them. The absence of a connector from a
 * page is not such evidence. Whether different MagSafe generations fit each other is not stated by these sources.
 */
export type ConnectorType = "usb-c" | "magsafe-2" | "magsafe-3";

export type DeviceId = "Mac14,2" | "MacBookPro12,1";
export type ChargerId = "A2743" | "A2452";
export type CableId = "usb-c-to-magsafe-3" | "usb-c-charge-cable";

export interface CuratedFact<T> {
  readonly value: T;
  readonly sources: readonly SourceId[];
}

export interface DeviceEvidence {
  readonly id: DeviceId;
  /** Apple's exact name for the model. */
  readonly name: string;
  readonly identity: CuratedFact<{ readonly modelIdentifier: DeviceId }>;
  /** Charging ports a source positively documents for this model; null when none is curated. */
  readonly chargingPorts: CuratedFact<readonly ConnectorType[]> | null;
  /** Positive evidence that `chargingPorts` is the complete list of charging inputs; null when no source states it. */
  readonly chargingPortsComplete: CuratedFact<true> | null;
  /** Wattages of the adapters Apple included with this model; more than one when it depends on configuration. */
  readonly includedAdapterWatts: CuratedFact<readonly number[]> | null;
}

export interface ChargerEvidence {
  readonly id: ChargerId;
  readonly name: string;
  readonly output: CuratedFact<ConnectorType>;
  readonly watts: CuratedFact<number>;
  /** From Apple's test footnotes, which describe tests on other Mac models (not tests of the configurations shown here). */
  readonly modelNumber: CuratedFact<string>;
  /** USB Power Delivery support of this adapter; null where no source states it (not invented). */
  readonly usbPd: CuratedFact<boolean> | null;
}

export interface CableEvidence {
  readonly id: CableId;
  readonly name: string;
  readonly chargerEnd: ConnectorType;
  readonly deviceEnd: ConnectorType;
}

/** An exact device + adapter + cable configuration that Apple documents. */
export interface DocumentedConfiguration {
  readonly device: DeviceId;
  readonly charger: ChargerId;
  readonly cable: CableId;
  /** "pairing": Apple lists or recommends it for charging. "fast-charge": on Apple's fast-charge list. */
  readonly kind: "pairing" | "fast-charge";
  /** Every curated configuration is Apple-listed; none is described by Apple as tested on this model. */
  readonly basis: "apple-listed";
  readonly sources: readonly SourceId[];
}

export interface CompatibilityEvidence {
  readonly devices: Readonly<Record<DeviceId, DeviceEvidence>>;
  readonly chargers: Readonly<Record<ChargerId, ChargerEvidence>>;
  readonly cables: Readonly<Record<CableId, CableEvidence>>;
  readonly configurations: readonly DocumentedConfiguration[];
}

export const DEVICE_IDS: readonly DeviceId[] = ["Mac14,2", "MacBookPro12,1"];
export const CHARGER_IDS: readonly ChargerId[] = ["A2743", "A2452"];
export const CABLE_IDS: readonly CableId[] = ["usb-c-to-magsafe-3", "usb-c-charge-cable"];

export const EVIDENCE: CompatibilityEvidence = {
  devices: {
    // S6a "MacBook Air (M2, 2022)" … "Model Identifier:" "Mac14,2"; S2 "MagSafe 3 charging port", "Two Thunderbolt / USB 4
    // ports with support for:" "Charging"; included 30W (8-core GPU) or 35W Dual (10-core GPU and 512GB storage).
    "Mac14,2": {
      id: "Mac14,2",
      name: "MacBook Air (M2, 2022)",
      identity: { value: { modelIdentifier: "Mac14,2" }, sources: ["S6a"] },
      chargingPorts: { value: ["magsafe-3", "usb-c"], sources: ["S2"] },
      chargingPortsComplete: null,
      includedAdapterWatts: { value: [30, 35], sources: ["S2"] },
    },
    // S6b "MacBook Pro (Retina, 13-inch, Early 2015)" … "MacBookPro12,1"; S5 "MagSafe 2 power port"; "60W MagSafe 2 Power
    // Adapter". S5 does not state that MagSafe 2 is the only charging input, so no completeness fact is recorded.
    "MacBookPro12,1": {
      id: "MacBookPro12,1",
      name: "MacBook Pro (Retina, 13-inch, Early 2015)",
      identity: { value: { modelIdentifier: "MacBookPro12,1" }, sources: ["S6b"] },
      chargingPorts: { value: ["magsafe-2"], sources: ["S5"] },
      chargingPortsComplete: null,
      includedAdapterWatts: { value: [60], sources: ["S5"] },
    },
  },
  chargers: {
    // S7 footnote "Apple 70W USB-C Power Adapter (Model A2743)"; S3 footnote names the same model.
    A2743: {
      id: "A2743",
      name: "Apple 70W USB-C Power Adapter (Model A2743)",
      output: { value: "usb-c", sources: ["S7"] },
      watts: { value: 70, sources: ["S7"] },
      modelNumber: { value: "A2743", sources: ["S3", "S7"] },
      usbPd: null,
    },
    // S8 footnote "Apple 140W USB-C Power Adapter (Model A2452)"; S3 footnote names the same model.
    A2452: {
      id: "A2452",
      name: "Apple 140W USB-C Power Adapter (Model A2452)",
      output: { value: "usb-c", sources: ["S8"] },
      watts: { value: 140, sources: ["S8"] },
      modelNumber: { value: "A2452", sources: ["S3", "S8"] },
      usbPd: null,
    },
  },
  cables: {
    "usb-c-to-magsafe-3": { id: "usb-c-to-magsafe-3", name: "Apple USB-C to MagSafe 3 Cable", chargerEnd: "usb-c", deviceEnd: "magsafe-3" },
    "usb-c-charge-cable": { id: "usb-c-charge-cable", name: "Apple USB-C charge cable", chargerEnd: "usb-c", deviceEnd: "usb-c" },
  },
  configurations: [
    // S1 under "MacBook Air models introduced in 2022 or later": "Apple 70W USB-C Power Adapter and USB-C to MagSafe 3
    // Cable"; S7 "Apple recommends pairing it with … a 13-inch or 15-inch MacBook Air using a USB-C to MagSafe 3 Cable or
    // USB-C Charge Cable."
    { device: "Mac14,2", charger: "A2743", cable: "usb-c-to-magsafe-3", kind: "pairing", basis: "apple-listed", sources: ["S1", "S7"] },
    { device: "Mac14,2", charger: "A2743", cable: "usb-c-charge-cable", kind: "pairing", basis: "apple-listed", sources: ["S7"] },
    // S3 under "MacBook Air (2022 or later)": "70W USB-C Power Adapter + USB-C to MagSafe 3 Cable or USB-C charge cable";
    // S2 "Fast-charge capable with 70W USB-C Power Adapter".
    { device: "Mac14,2", charger: "A2743", cable: "usb-c-to-magsafe-3", kind: "fast-charge", basis: "apple-listed", sources: ["S3", "S2"] },
    { device: "Mac14,2", charger: "A2743", cable: "usb-c-charge-cable", kind: "fast-charge", basis: "apple-listed", sources: ["S3"] },
    // S3 under "MacBook Air (2022 or later)": "140W USB-C Power Adapter + USB-C to MagSafe 3 Cable or USB-C charge cable".
    { device: "Mac14,2", charger: "A2452", cable: "usb-c-to-magsafe-3", kind: "fast-charge", basis: "apple-listed", sources: ["S3"] },
    { device: "Mac14,2", charger: "A2452", cable: "usb-c-charge-cable", kind: "fast-charge", basis: "apple-listed", sources: ["S3"] },
  ],
};
