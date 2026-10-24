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
 * Connector types as Apple names them, plus a DC barrel input (C1; no curated entry uses it). A cable is "unsupported" only
 * when positive evidence says the device's documented charging ports are its complete list and the cable's connector is
 * not among them. The absence of a connector from a page is not such evidence. Whether different MagSafe generations fit
 * each other is not stated by these sources, and a barrel's fit is never inferred from its appearance.
 */
export type ConnectorType = "usb-c" | "magsafe-2" | "magsafe-3" | "dc-barrel";

export type DeviceId = "Mac14,2" | "MacBookPro12,1";
export type ChargerId = "A2743" | "A2452";
export type CableId = "usb-c-to-magsafe-3" | "usb-c-charge-cable";

export interface CuratedFact<T> {
  readonly value: T;
  readonly sources: readonly SourceId[];
}

/**
 * F03 C1: the state of one manufacturer fact (used only by the non-Apple fields below; the Apple fields keep
 * `CuratedFact | null`). A fact is usable only when sourced for the exact SKU. A family-scoped fact (for example from a
 * manual covering several models) is recorded but never satisfies a requirement. Differing sources are "discrepant":
 * "unresolved" when they need not concern the same claim for the same configuration, "contradiction" only when they
 * demonstrably do. Either kind makes every claim that needs the fact unknown.
 */
export type FactScope = "sku" | "family";
export type FactState<T> =
  | { readonly status: "sourced"; readonly value: T; readonly scope: FactScope; readonly sources: readonly SourceId[] }
  | { readonly status: "unknown"; readonly reason: string }
  | {
      readonly status: "discrepant";
      readonly kind: "unresolved" | "contradiction";
      readonly claims: readonly { readonly statement: string; readonly scope: FactScope; readonly sources: readonly SourceId[] }[];
    };

/** One USB Power Delivery voltage/current profile. */
export interface PdProfile {
  readonly volts: number;
  readonly amps: number;
}

/** A DC barrel connector's details. None is inferred from appearance, a wattage or another model. */
export interface BarrelSpec {
  readonly outerDiameterMm: FactState<number>;
  readonly innerDiameterMm: FactState<number>;
  readonly volts: FactState<number>;
  readonly polarity: FactState<"center-positive" | "center-negative">;
}

/** One charging input of a non-Apple device. */
export interface PowerInput {
  readonly connector: "usb-c" | "dc-barrel";
  /** Which physical port(s), as the source names them. */
  readonly whichPorts: FactState<string>;
  /** Whether the input accepts a USB Power Delivery source (USB-C only). Generic PD support alone never establishes a result. */
  readonly acceptsUsbPdSource: FactState<boolean>;
  /** The PD profiles the device requires: ALL of them must be offered by the adapter (same voltage, at least the current). */
  readonly requiredPdProfiles: FactState<readonly PdProfile[]>;
  /** The power the input requires, as the source states it (kept separately from any adapter rating); must agree with the profiles. */
  readonly requirement: FactState<{ readonly watts: number; readonly volts: number }>;
  readonly barrel?: BarrelSpec;
}

/** Shared by every device entry. */
interface DeviceBase<D extends string> {
  readonly id: D;
  /** The manufacturer's exact name for the model. */
  readonly name: string;
}

/** An Apple device (the existing curated shape; unchanged). */
export interface DeviceEvidence<D extends string = DeviceId> extends DeviceBase<D> {
  readonly maker?: undefined;
  readonly identity: CuratedFact<{ readonly modelIdentifier: D }>;
  /** Charging ports a source positively documents for this model; null when none is curated. */
  readonly chargingPorts: CuratedFact<readonly ConnectorType[]> | null;
  /** Positive evidence that `chargingPorts` is the complete list of charging inputs; null when no source states it. */
  readonly chargingPortsComplete: CuratedFact<true> | null;
  /** Wattages of the adapters Apple included with this model; more than one when it depends on configuration. */
  readonly includedAdapterWatts: CuratedFact<readonly number[]> | null;
}

/**
 * F03 C1: a non-Apple device identified by the manufacturer's model and part number. No real entry exists yet. Input
 * requirements, charging methods, adapter ratings and the included adapter are separate facts, each with its own scope.
 */
export interface MakerDeviceEvidence<D extends string = string> extends DeviceBase<D> {
  readonly maker: "Acer" | "ASUS";
  /** Verified only when an official manufacturer source names this exact model and part number. */
  readonly partIdentity: {
    readonly model: string;
    readonly partNumber: string;
    readonly status: "verified" | "unverified";
    readonly sources: readonly SourceId[];
  };
  /** Every charging input a source documents for this SKU. */
  readonly powerInputs: FactState<readonly PowerInput[]>;
  /** Positive evidence that `powerInputs` is the complete list of charging inputs. */
  readonly powerInputsComplete: FactState<true>;
  /** Ratings the manufacturer states for adapters for this model (not necessarily the one in the box). */
  readonly adapterRatings: FactState<readonly { readonly watts: number; readonly volts: number; readonly amps?: number }[]>;
  /** What is actually in this SKU's box. */
  readonly includedAdapter: {
    readonly rating: FactState<{ readonly watts: number; readonly volts: number; readonly amps?: number }>;
    readonly partNumber: FactState<string>;
  };
  /** A spec-page "power supply wattage" whose meaning the page does not define; never used as a requirement. */
  readonly specPagePowerSupplyWatts: FactState<number>;
}

export type AnyDeviceEvidence<D extends string = string> = DeviceEvidence<D> | MakerDeviceEvidence<D>;

export function isMakerDevice<D extends string>(device: AnyDeviceEvidence<D>): device is MakerDeviceEvidence<D> {
  return device.maker !== undefined;
}

export interface ChargerEvidence<C extends string = ChargerId> {
  readonly id: C;
  readonly name: string;
  readonly output: CuratedFact<ConnectorType>;
  readonly watts: CuratedFact<number>;
  /** From Apple's test footnotes, which describe tests on other Mac models (not tests of the configurations shown here). */
  readonly modelNumber: CuratedFact<string>;
  /** USB Power Delivery support of this adapter; null where no source states it (not invented). */
  readonly usbPd: CuratedFact<boolean> | null;
  /** F03 C1: the PD profiles this adapter offers. Required for any non-Apple specification result; absent on curated entries. */
  readonly pdProfiles?: FactState<readonly PdProfile[]>;
  /** F03 C1: barrel details of a DC adapter's plug. Absent on curated entries. */
  readonly barrel?: BarrelSpec;
}

export interface CableEvidence<K extends string = CableId> {
  readonly id: K;
  readonly name: string;
  readonly chargerEnd: ConnectorType;
  readonly deviceEnd: ConnectorType;
  /** F03 C1: the cable's sourced current rating. Required for any non-Apple specification result; absent on curated entries. */
  readonly currentRatingAmps?: FactState<number>;
  /**
   * F03 C1: cited evidence of the connector at each end. Required, at exact scope and consistent with `chargerEnd` and
   * `deviceEnd`, for any non-Apple specification result or unsupported verdict; a current rating does not establish it.
   * Absent on curated entries (the Apple path does not use it).
   */
  readonly connectorEnds?: FactState<{ readonly chargerEnd: ConnectorType; readonly deviceEnd: ConnectorType }>;
}

export type ListingBasis = "apple-listed" | "manufacturer-listed";

/** An exact device + adapter + cable configuration that the device's manufacturer documents. */
export interface DocumentedConfiguration<D extends string = DeviceId, C extends string = ChargerId, K extends string = CableId, B extends ListingBasis = ListingBasis> {
  readonly device: D;
  readonly charger: C;
  readonly cable: K;
  /** "pairing": listed or recommended for charging. "fast-charge": on Apple's fast-charge list. */
  readonly kind: "pairing" | "fast-charge";
  /** Every curated configuration is Apple-listed; none is described by Apple as tested on this model. */
  readonly basis: B;
  /** F03 C1: for a non-Apple device, only an exact-SKU listing counts. Absent on curated (Apple) entries. */
  readonly scope?: FactScope;
  readonly sources: readonly SourceId[];
}

export interface CompatibilityEvidence<
  D extends string = DeviceId,
  C extends string = ChargerId,
  K extends string = CableId,
  V extends AnyDeviceEvidence<D> = DeviceEvidence<D>,
> {
  readonly devices: Readonly<Record<D, V>>;
  readonly chargers: Readonly<Record<C, ChargerEvidence<C>>>;
  readonly cables: Readonly<Record<K, CableEvidence<K>>>;
  /** Apple-only evidence (the default) can hold only Apple listings; a manufacturer listing needs a non-Apple device type. */
  readonly configurations: readonly DocumentedConfiguration<D, C, K, [V] extends [DeviceEvidence<D>] ? "apple-listed" : ListingBasis>[];
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
