import {
  isMakerDevice,
  type AnyDeviceEvidence,
  type CableId,
  type ChargerId,
  type CompatibilityEvidence,
  type ConnectorType,
  type DeviceEvidence,
  type DeviceId,
  type FactState,
  type MakerDeviceEvidence,
  type PdProfile,
  type SourceId,
} from "./evidence";

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
 *
 * F03 C1 (non-Apple devices only; no curated entry exists, and the Apple path above is unchanged):
 *  - supported-manufacturer-listed: the manufacturer lists this exact device + adapter + cable for this exact SKU, and
 *    the device's identity is verified.
 *  - supported-pd-profile: every required fact is sourced for the exact SKU and consistent, for every documented USB-C
 *    input — a verified identity, the charging port, that it accepts a USB PD source, its stated requirement, and the PD
 *    profiles it requires; each required profile offered by the adapter at the same voltage and at least that current;
 *    a stated requirement that agrees with those profiles; a cable rated for at least that current; positive, finite
 *    numbers; and no sourced "no PD" on the adapter. Wattage plus generic PD support is never enough, and a DC barrel is
 *    never assessed by specification.
 *  - otherwise unknown, with the gap; a missing, family-scoped or discrepant required fact never produces a result.
 */
export type BasicVerdict =
  | "supported-apple-listed"
  | "supported-apple-fast-charge-list"
  | "supported-specification"
  | "supported-manufacturer-listed"
  | "supported-pd-profile"
  | "unsupported"
  | "unknown";
/** Why basic support is unknown. */
export type BasicGap =
  | "connector-generation-differs"
  | "charging-port-for-cable-not-documented"
  | "no-listed-configuration"
  | "no-evidence"
  | "identity-unverified"
  | "discrepancy-unresolved"
  | "sources-contradict"
  | "family-scoped-only"
  | "connector-details-unknown"
  | "pd-profile-not-established"
  | "cable-capability-not-established"
  | "cable-connectors-not-established"
  | "no-manufacturer-listing";
/** Adapter wattage against the wattage of the adapter(s) Apple included with this model. */
export type WattageVerdict = "at-or-above-all" | "at-or-above-some" | "below-all" | "unknown";
export type FastVerdict = "listed" | "not-listed";

export interface ClaimResult<V> {
  readonly verdict: V;
  readonly sources: readonly SourceId[];
}

export interface CombinationResult<D extends string = DeviceId, C extends string = ChargerId, K extends string = CableId> {
  readonly device: D;
  readonly charger: C;
  readonly cable: K;
  readonly basic: ClaimResult<BasicVerdict> & { readonly gap: BasicGap | null };
  readonly wattage: ClaimResult<WattageVerdict> & { readonly watts: number | null; readonly includedWatts: readonly number[] };
  readonly fast: ClaimResult<FastVerdict>;
  /** The cable's device-end connector and the device's documented charging ports, for explaining a gap. */
  readonly cableConnector: ConnectorType;
  readonly documentedPorts: readonly ConnectorType[];
}

export type DeviceSelection<D extends string = DeviceId> =
  | { readonly kind: "none" }
  | { readonly kind: "unidentified" }
  | { readonly kind: "identified"; readonly device: D }
  /** F03 C1: an exact match to a non-Apple entry whose identity no official source confirms. Never evaluated. */
  | { readonly kind: "unverified"; readonly device: D };

type AnyEvidence<D extends string, C extends string, K extends string, V extends AnyDeviceEvidence<D>> = CompatibilityEvidence<D, C, K, V>;

const unique = (sources: readonly SourceId[]): SourceId[] => [...new Set(sources)];
const isMagSafe = (connector: ConnectorType) => connector === "magsafe-2" || connector === "magsafe-3";

function listed<D extends string, C extends string, K extends string, V extends AnyDeviceEvidence<D>>(
  evidence: AnyEvidence<D, C, K, V>,
  device: D,
  charger: C,
  cable: K,
  kind: "pairing" | "fast-charge",
) {
  return evidence.configurations.filter((c) => c.device === device && c.charger === charger && c.cable === cable && c.kind === kind);
}

/**
 * F03 C1 runtime safeguard: a listing used by the Apple path must be explicitly Apple-attributed and apply to this exact
 * model (no scope, as in the curated entries, or "sku"). A missing, other or unexpected attribution, or a family scope,
 * never produces "Apple lists…", Apple's fast-charge list, or any supported result. TypeScript alone does not enforce this.
 */
function appleListed<D extends string, C extends string, K extends string, V extends AnyDeviceEvidence<D>>(
  evidence: AnyEvidence<D, C, K, V>,
  device: D,
  charger: C,
  cable: K,
  kind: "pairing" | "fast-charge",
) {
  return listed(evidence, device, charger, cable, kind).filter((c) => c.basis === "apple-listed" && (c.scope === undefined || c.scope === "sku"));
}

function basicClaim<D extends string, C extends string, K extends string, V extends AnyDeviceEvidence<D>>(
  evidence: AnyEvidence<D, C, K, V>,
  deviceFacts: DeviceEvidence<D>,
  charger: C,
  cable: K,
): CombinationResult["basic"] {
  const device = deviceFacts.id;
  const pairing = appleListed(evidence, device, charger, cable, "pairing");
  if (pairing.length) return { verdict: "supported-apple-listed", sources: unique(pairing.flatMap((c) => c.sources)), gap: null };
  const fast = appleListed(evidence, device, charger, cable, "fast-charge");
  if (fast.length) return { verdict: "supported-apple-fast-charge-list", sources: unique(fast.flatMap((c) => c.sources)), gap: null };

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

/** A fact usable as a requirement: sourced for the exact SKU. Anything else blocks the claim with a gap. */
type Blocker = { readonly level: 0 | 1 | 2 | 3; readonly gap: BasicGap };
/** Precedence: an established contradiction, then an unresolved discrepancy, then a family-scoped fact, then a missing one. */
/**
 * F03 C1: a non-Apple fact, identity or listing counts only with at least one source reference of its own. An uncited
 * "sourced" fact is treated as missing; citations on other facts never compensate.
 */
const cited = (sources: readonly SourceId[] | undefined): boolean => Array.isArray(sources) && sources.length > 0;

function blocker(fact: FactState<unknown> | undefined, missingGap: BasicGap): Blocker | null {
  if (!fact || fact.status === "unknown") return { level: 3, gap: missingGap };
  if (fact.status === "discrepant") return fact.kind === "contradiction" ? { level: 0, gap: "sources-contradict" } : { level: 1, gap: "discrepancy-unresolved" };
  if (!cited(fact.sources)) return { level: 3, gap: missingGap };
  if (fact.scope !== "sku") return { level: 2, gap: "family-scoped-only" };
  return null;
}
const firstBlocker = (blockers: readonly (Blocker | null)[]): Blocker | null =>
  blockers.filter((b): b is Blocker => b !== null).sort((a, b) => a.level - b.level)[0] ?? null;
const sourcesOf = (fact: FactState<unknown> | undefined): readonly SourceId[] => (fact?.status === "sourced" ? fact.sources : []);
const sourcedValue = <T>(fact: FactState<T> | undefined): T | null =>
  fact?.status === "sourced" && fact.scope === "sku" && cited(fact.sources) ? fact.value : null;
/** A non-Apple identity counts as verified only when marked verified and cited. */
const identityVerified = (device: MakerDeviceEvidence<string>): boolean => device.partIdentity.status === "verified" && cited(device.partIdentity.sources);

/** F03 C1: basic support for a non-Apple device. Guards only; no path is reachable with curated data. */
function makerBasicClaim<D extends string, C extends string, K extends string, V extends AnyDeviceEvidence<D>>(
  evidence: AnyEvidence<D, C, K, V>,
  device: MakerDeviceEvidence<D>,
  charger: C,
  cable: K,
): CombinationResult["basic"] {
  const unknown = (gap: BasicGap, sources: readonly SourceId[] = []) => ({ verdict: "unknown" as const, sources: unique(sources), gap });
  if (!identityVerified(device)) return unknown("identity-unverified", device.partIdentity.sources);

  const listings = listed(evidence, device.id, charger, cable, "pairing").filter((c) => c.basis === "manufacturer-listed");
  const exact = listings.filter((c) => c.scope === "sku" && cited(c.sources));
  if (exact.length) {
    return { verdict: "supported-manufacturer-listed", sources: unique([...device.partIdentity.sources, ...exact.flatMap((c) => c.sources)]), gap: null };
  }
  const familyListing: Blocker | null = listings.length ? { level: 2, gap: "family-scoped-only" } : null;

  const chargerFacts = evidence.chargers[charger];
  const cableFacts = evidence.cables[cable];
  const inputs = sourcedValue(device.powerInputs);
  const complete = sourcedValue(device.powerInputsComplete);
  // Cited, exact-scope connector ends that agree with the plain fields the rules read; otherwise null (never the plain fields alone).
  const citedEnds = sourcedValue(cableFacts.connectorEnds);
  const ends = citedEnds && citedEnds.chargerEnd === cableFacts.chargerEnd && citedEnds.deviceEnd === cableFacts.deviceEnd ? citedEnds : null;
  if (inputs && inputs.length > 0 && complete === true && ends && !inputs.some((input) => input.connector === ends.deviceEnd)) {
    return {
      verdict: "unsupported",
      sources: unique([...sourcesOf(device.powerInputs), ...sourcesOf(device.powerInputsComplete), ...sourcesOf(cableFacts.connectorEnds)]),
      gap: null,
    };
  }

  // The adapter's output connector is a required fact for every path below; uncited, nothing is assessed.
  if (!cited(chargerFacts.output.sources)) return unknown(familyListing?.gap ?? "no-evidence");

  // A DC barrel is never assessed by specification: only an exact-SKU manufacturer listing (above) establishes it.
  if (cableFacts.deviceEnd === "dc-barrel" || chargerFacts.output.value === "dc-barrel") {
    const barrels = [chargerFacts.barrel, ...(inputs ?? []).filter((i) => i.connector === "dc-barrel").map((i) => i.barrel)];
    const details = barrels.flatMap((b) => (b ? [b.outerDiameterMm, b.innerDiameterMm, b.volts, b.polarity] : [undefined]));
    const detailBlocker = firstBlocker(details.map((fact) => blocker(fact, "connector-details-unknown")));
    return unknown((firstBlocker([detailBlocker, familyListing]) ?? { gap: "no-manufacturer-listing" as const }).gap);
  }

  // Both cable ends must be established by their own cited, exact-scope fact; a current rating or the plain fields do not.
  const endsBlocker = blocker(cableFacts.connectorEnds, "cable-connectors-not-established");
  if (endsBlocker) return unknown(firstBlocker([endsBlocker, familyListing])!.gap);
  if (!ends) return unknown("discrepancy-unresolved");
  const allUsbC = ends.chargerEnd === "usb-c" && ends.deviceEnd === "usb-c" && chargerFacts.output.value === "usb-c";
  if (!allUsbC) return unknown(familyListing?.gap ?? "no-manufacturer-listing");

  const inputsBlocker = blocker(device.powerInputs, "no-evidence");
  if (inputsBlocker) return unknown(firstBlocker([inputsBlocker, familyListing])!.gap);
  // Every documented USB-C input is checked: a conflict on any of them blocks the result (never "the first one").
  const usbCInputs = inputs!.filter((input) => input.connector === "usb-c");
  if (!usbCInputs.length) return unknown(familyListing?.gap ?? "charging-port-for-cable-not-documented", sourcesOf(device.powerInputs));

  const blocked = firstBlocker([
    ...usbCInputs.flatMap((input) => [
      blocker(input.whichPorts, "charging-port-for-cable-not-documented"),
      blocker(input.acceptsUsbPdSource, "pd-profile-not-established"),
      blocker(input.requiredPdProfiles, "pd-profile-not-established"),
      blocker(input.requirement, "pd-profile-not-established"),
    ]),
    blocker(chargerFacts.pdProfiles, "pd-profile-not-established"),
    blocker(cableFacts.currentRatingAmps, "cable-capability-not-established"),
    familyListing,
  ]);
  if (blocked) return unknown(blocked.gap);
  // Generic PD support is only a cross-check: a sourced "no PD" on the adapter conflicts with its PD profiles.
  if (chargerFacts.usbPd && chargerFacts.usbPd.value !== true) return unknown("discrepancy-unresolved");

  const positive = (n: number) => Number.isFinite(n) && n > 0;
  const validProfile = (p: PdProfile) => positive(p.volts) && positive(p.amps);
  const offered = sourcedValue(chargerFacts.pdProfiles)!;
  const cableAmps = sourcedValue(cableFacts.currentRatingAmps)!;
  if (!offered.length || !offered.every(validProfile)) return unknown("pd-profile-not-established");
  if (!positive(cableAmps)) return unknown("cable-capability-not-established");
  for (const input of usbCInputs) {
    if (sourcedValue(input.acceptsUsbPdSource) !== true) return unknown("pd-profile-not-established");
    const required = sourcedValue(input.requiredPdProfiles)!;
    const requirement = sourcedValue(input.requirement)!;
    if (!required.length || !required.every(validProfile) || !positive(requirement.watts) || !positive(requirement.volts)) return unknown("pd-profile-not-established");
    // The stated requirement must agree with every required profile (same voltage, profile power at least the wattage).
    if (!required.every((need) => need.volts === requirement.volts && need.volts * need.amps >= requirement.watts - 1e-9)) return unknown("discrepancy-unresolved");
    // Every required profile must be offered: the same voltage and at least the current.
    if (!required.every((need) => offered.some((p) => p.volts === need.volts && p.amps >= need.amps))) return unknown("pd-profile-not-established");
    if (!required.every((need) => cableAmps >= need.amps)) return unknown("cable-capability-not-established");
  }

  return {
    verdict: "supported-pd-profile",
    sources: unique([
      ...device.partIdentity.sources,
      ...sourcesOf(device.powerInputs),
      ...usbCInputs.flatMap((input) => [...sourcesOf(input.whichPorts), ...sourcesOf(input.acceptsUsbPdSource), ...sourcesOf(input.requiredPdProfiles), ...sourcesOf(input.requirement)]),
      ...sourcesOf(chargerFacts.pdProfiles),
      ...sourcesOf(cableFacts.connectorEnds),
      ...sourcesOf(cableFacts.currentRatingAmps),
    ]),
    gap: null,
  };
}

function wattageClaim<D extends string, C extends string, K extends string, V extends AnyDeviceEvidence<D>>(
  evidence: AnyEvidence<D, C, K, V>,
  deviceFacts: AnyDeviceEvidence<D>,
  charger: C,
): CombinationResult["wattage"] {
  const watts = evidence.chargers[charger].watts;
  // F03 C1: no wattage comparison for a non-Apple device yet (its copy would name Apple's included adapter).
  if (isMakerDevice(deviceFacts)) return { verdict: "unknown", sources: [], watts: watts.value, includedWatts: [] };
  const included = deviceFacts.includedAdapterWatts;
  if (!included || included.value.length === 0) return { verdict: "unknown", sources: [], watts: watts.value, includedWatts: [] };
  const sources = unique([...included.sources, ...watts.sources]);
  const atOrAbove = included.value.filter((w) => watts.value >= w).length;
  const verdict: WattageVerdict = atOrAbove === included.value.length ? "at-or-above-all" : atOrAbove > 0 ? "at-or-above-some" : "below-all";
  return { verdict, sources, watts: watts.value, includedWatts: included.value };
}

function fastClaim<D extends string, C extends string, K extends string, V extends AnyDeviceEvidence<D>>(
  evidence: AnyEvidence<D, C, K, V>,
  deviceFacts: AnyDeviceEvidence<D>,
  charger: C,
  cable: K,
): ClaimResult<FastVerdict> {
  // F03 C1: fast charging is an Apple list; a non-Apple device is never on it.
  if (isMakerDevice(deviceFacts)) return { verdict: "not-listed", sources: [] };
  const fast = appleListed(evidence, deviceFacts.id, charger, cable, "fast-charge");
  return fast.length ? { verdict: "listed", sources: unique(fast.flatMap((c) => c.sources)) } : { verdict: "not-listed", sources: [] };
}

export function evaluateCombination<D extends string, C extends string, K extends string, V extends AnyDeviceEvidence<D>>(
  evidence: AnyEvidence<D, C, K, V>,
  device: D,
  charger: C,
  cable: K,
): CombinationResult<D, C, K> {
  const deviceFacts: AnyDeviceEvidence<D> = evidence.devices[device];
  const maker = isMakerDevice(deviceFacts);
  const makerInputs = maker ? sourcedValue(deviceFacts.powerInputs) : null;
  return {
    device,
    charger,
    cable,
    basic: maker ? makerBasicClaim(evidence, deviceFacts, charger, cable) : basicClaim(evidence, deviceFacts, charger, cable),
    wattage: wattageClaim(evidence, deviceFacts, charger),
    fast: fastClaim(evidence, deviceFacts, charger, cable),
    cableConnector: evidence.cables[cable].deviceEnd,
    documentedPorts: maker ? (makerInputs ?? []).map((input) => input.connector) : (deviceFacts.chargingPorts?.value ?? []),
  };
}

/**
 * The curated device whose identifier is exactly `value` (case and surrounding spaces ignored); never a fuzzy match.
 * Apple: the model identifier. F03 C1, non-Apple: the manufacturer's exact model or exact part number. A value that
 * matches more than one entry (for example a model name shared by several SKUs) identifies nothing.
 */
function byIdentifier<D extends string, V extends AnyDeviceEvidence<D>>(devices: Readonly<Record<D, V>>, value: string): D | null {
  const wanted = value.trim().toLowerCase();
  const names = (device: AnyDeviceEvidence<D>): string[] =>
    isMakerDevice(device) ? [device.partIdentity.model, device.partIdentity.partNumber] : [device.identity.value.modelIdentifier];
  const found = (Object.values(devices) as AnyDeviceEvidence<D>[]).filter((device) => names(device).some((name) => name.toLowerCase() === wanted));
  return found.length === 1 ? found[0]!.id : null;
}

/**
 * The shopper's device: only a curated model chosen from the list or given by its exact identifier. A description,
 * a year, a partial name or a disagreement between the two inputs leaves the device unidentified. F03 C1: an exact match
 * to a non-Apple entry whose identity is unverified is "unverified", never "identified".
 */
export function selectDevice<D extends string = DeviceId, C extends string = ChargerId, K extends string = CableId, V extends AnyDeviceEvidence<D> = DeviceEvidence<D>>(
  evidence: AnyEvidence<D, C, K, V>,
  input: { readonly device?: string; readonly identifier?: string },
): DeviceSelection<D> {
  const chosen = input.device?.trim() ?? "";
  const typed = input.identifier?.trim() ?? "";
  if (!chosen && !typed) return { kind: "none" };
  const fromList = chosen ? (Object.hasOwn(evidence.devices, chosen) ? (chosen as D) : null) : undefined;
  const fromText = typed ? byIdentifier(evidence.devices, typed) : undefined;
  if (fromList === null || fromText === null) return { kind: "unidentified" };
  if (fromList && fromText && fromList !== fromText) return { kind: "unidentified" };
  const device = fromList ?? fromText;
  if (!device) return { kind: "unidentified" };
  const facts: AnyDeviceEvidence<D> = evidence.devices[device];
  if (isMakerDevice(facts) && !identityVerified(facts)) return { kind: "unverified", device };
  return { kind: "identified", device };
}
