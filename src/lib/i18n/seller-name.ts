import type { JourneyLanguage } from "./language";

const SIMULATED_EN = " (simulated)";
const SIMULATED_ES = " (simulada)";

/**
 * The seller's name as shown to the shopper (M2-3). The proper name is never translated; only the English "(simulated)"
 * descriptor that the catalog appends is, so Spanish pages say "(simulada)". The catalog and every saved summary keep the
 * catalog's own text: this is display only.
 */
export function sellerName(displayName: string, language: JourneyLanguage | undefined): string {
  if (language !== "es" || !displayName.endsWith(SIMULATED_EN)) return displayName;
  return `${displayName.slice(0, -SIMULATED_EN.length)}${SIMULATED_ES}`;
}
