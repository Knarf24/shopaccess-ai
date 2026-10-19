import type { CableId, ChargerId, CompatibilityEvidence, ConnectorType, DeviceId, SourceId } from "./evidence";

/**
 * F03 information slice. Three separate claims for one exact device + adapter + cable configuration, each from its own
 * evidence; missing evidence makes only the claim that needs it unknown, and wattage and fast charging never depend on
 * the basic-support verdict. Nothing is inferred from a connector name, a wattage or the absence of a fact from a page.
 *
 * Basic charging:
 *  - supported-apple-listed: Apple lists or recommends this exact configuration for this device.
 *  - supported-apple-fast-charge-list: Apple's fast-charge list includes this exact configuration (which shows it
 *    charges); used only when no charging listing exists. Apple-listed, not described as tested on this model.
 *  - unsupported: a source positively establishes the device's complete charging-port list, and the cable's connector is
 *    not in it (this configuration only; no converters or other adapters).
 *  - supported-specification: a documented USB-C charging port, a sourced USB Power Delivery fact for the adapter, and a
 *    USB-C cable (Apple's general USB-C guidance, S1).
 *  - unknown, with the specific gap.
 */
export type BasicVerdict = "supported-apple-listed" | "supported-apple-fast-charge-list" | "supported-specification" | "unsupported" | "unknown";
/** Why basic support is unknown. */
export type BasicGap = "connector-generation-differs" | "charging-port-for-cable-not-documented" | "no-listed-configuration" | "no-evidence";
/** Adapter wattage against the wattage of the adapter(s) Apple included with this model. */
export type WattageVerdict = "at-or-above-all" | "at-or-above-some" | "below-all" | "unknown";
export type FastVerdict = "listed" | "not-listed";

export interface ClaimResult<V> {
  readonly verdict: V;
  readonly sources: readonly SourceId[];
}

export interface CombinationResult {
  readonly device: DeviceId;
  readonly charger: ChargerId;
  readonly cable: CableId;
  readonly basic: ClaimResult<BasicVerdict> & { readonly gap: BasicGap | null };
  readonly wattage: ClaimResult<WattageVerdict> & { readonly watts: number | null; readonly includedWatts: readonly number[] };
  readonly fast: ClaimResult<FastVerdict>;
  /** The cable's device-end connector and the device's documented charging ports, for explaining a gap. */
  readonly cableConnector: ConnectorType;
  readonly documentedPorts: readonly ConnectorType[];
}

export type DeviceSelection = { readonly kind: "none" } | { readonly kind: "unidentified" } | { readonly kind: "identified"; readonly device: DeviceId };

const unique = (sources: readonly SourceId[]): SourceId[] => [...new Set(sources)];
const isMagSafe = (connector: ConnectorType) => connector === "magsafe-2" || connector === "magsafe-3";

function listed(evidence: CompatibilityEvidence, device: DeviceId, charger: ChargerId, cable: CableId, kind: "pairing" | "fast-charge") {
  return evidence.configurations.filter((c) => c.device === device && c.charger === charger && c.cable === cable && c.kind === kind);
}

function basicClaim(evidence: CompatibilityEvidence, device: DeviceId, charger: ChargerId, cable: CableId): CombinationResult["basic"] {
  const pairing = listed(evidence, device, charger, cable, "pairing");
  if (pairing.length) return { verdict: "supported-apple-listed", sources: unique(pairing.flatMap((c) => c.sources)), gap: null };
  const fast = listed(evidence, device, charger, cable, "fast-charge");
  if (fast.length) return { verdict: "supported-apple-fast-charge-list", sources: unique(fast.flatMap((c) => c.sources)), gap: null };

  const deviceFacts = evidence.devices[device];
  const chargerFacts = evidence.chargers[charger];
  const cableFacts = evidence.cables[cable];
  const ports = deviceFacts.chargingPorts;
  const complete = deviceFacts.chargingPortsComplete;
  if (ports && complete?.value === true && !ports.value.includes(cableFacts.deviceEnd)) {
    return { verdict: "unsupported", sources: unique([...ports.sources, ...complete.sources]), gap: null };
  }

  const pd = chargerFacts.usbPd;
  if (
    cableFacts.chargerEnd === "usb-c" &&
    cableFacts.deviceEnd === "usb-c" &&
    chargerFacts.output.value === "usb-c" &&
    ports?.value.includes("usb-c") &&
    pd?.value === true
  ) {
    return { verdict: "supported-specification", sources: unique([...ports.sources, ...pd.sources, ...chargerFacts.output.sources, "S1"]), gap: null };
  }

  if (!ports) return { verdict: "unknown", sources: [], gap: "no-evidence" };
  if (ports.value.includes(cableFacts.deviceEnd)) return { verdict: "unknown", sources: unique(ports.sources), gap: "no-listed-configuration" };
  if (isMagSafe(cableFacts.deviceEnd) && ports.value.some(isMagSafe)) {
    return { verdict: "unknown", sources: unique(ports.sources), gap: "connector-generation-differs" };
  }
  return { verdict: "unknown", sources: unique(ports.sources), gap: "charging-port-for-cable-not-documented" };
}

function wattageClaim(evidence: CompatibilityEvidence, device: DeviceId, charger: ChargerId): CombinationResult["wattage"] {
  const watts = evidence.chargers[charger].watts;
  const included = evidence.devices[device].includedAdapterWatts;
  if (!included || included.value.length === 0) return { verdict: "unknown", sources: [], watts: watts.value, includedWatts: [] };
  const sources = unique([...included.sources, ...watts.sources]);
  const atOrAbove = included.value.filter((w) => watts.value >= w).length;
  const verdict: WattageVerdict = atOrAbove === included.value.length ? "at-or-above-all" : atOrAbove > 0 ? "at-or-above-some" : "below-all";
  return { verdict, sources, watts: watts.value, includedWatts: included.value };
}

function fastClaim(evidence: CompatibilityEvidence, device: DeviceId, charger: ChargerId, cable: CableId): ClaimResult<FastVerdict> {
  const fast = listed(evidence, device, charger, cable, "fast-charge");
  return fast.length ? { verdict: "listed", sources: unique(fast.flatMap((c) => c.sources)) } : { verdict: "not-listed", sources: [] };
}

export function evaluateCombination(evidence: CompatibilityEvidence, device: DeviceId, charger: ChargerId, cable: CableId): CombinationResult {
  return {
    device,
    charger,
    cable,
    basic: basicClaim(evidence, device, charger, cable),
    wattage: wattageClaim(evidence, device, charger),
    fast: fastClaim(evidence, device, charger, cable),
    cableConnector: evidence.cables[cable].deviceEnd,
    documentedPorts: evidence.devices[device].chargingPorts?.value ?? [],
  };
}

/** The curated device whose model identifier is exactly `value` (case and surrounding spaces ignored); never a fuzzy match. */
function byIdentifier(evidence: CompatibilityEvidence, value: string): DeviceId | null {
  const wanted = value.trim().toLowerCase();
  const found = Object.values(evidence.devices).find((device) => device.identity.value.modelIdentifier.toLowerCase() === wanted);
  return found ? found.id : null;
}

/**
 * The shopper's device: only a curated model chosen from the list or given by its exact model identifier. A description,
 * a year, a partial name or a disagreement between the two inputs leaves the device unidentified.
 */
export function selectDevice(evidence: CompatibilityEvidence, input: { readonly device?: string; readonly identifier?: string }): DeviceSelection {
  const chosen = input.device?.trim() ?? "";
  const typed = input.identifier?.trim() ?? "";
  if (!chosen && !typed) return { kind: "none" };
  const fromList = chosen ? (Object.hasOwn(evidence.devices, chosen) ? (chosen as DeviceId) : null) : undefined;
  const fromText = typed ? byIdentifier(evidence, typed) : undefined;
  if (fromList === null || fromText === null) return { kind: "unidentified" };
  if (fromList && fromText && fromList !== fromText) return { kind: "unidentified" };
  const device = fromList ?? fromText;
  return device ? { kind: "identified", device } : { kind: "unidentified" };
}
