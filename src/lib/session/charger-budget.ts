import type { DeviceId } from "../compatibility/evidence";
import { DEVICE_IDS } from "../compatibility/evidence";
import { MAX_CHARGER_REVISION } from "./charger-revision";

/** Charger-budget transition input. Purchase authority is outside this module. */
export interface ChargerBudget {
  readonly sessionId: string;
  readonly draftId: string;
  readonly deviceId: DeviceId;
  readonly revision: number;
  readonly proposedCents: number | null;
  readonly confirmedCents: number | null;
}
type BudgetAction =
  | { readonly action: "propose"; readonly dollars: string }
  | { readonly action: "confirm" }
  | { readonly action: "device"; readonly deviceId: DeviceId };
type Request = BudgetAction & { readonly sessionId: string; readonly draftId: string; readonly revision: number };
type Result = { readonly ok: true; readonly value: ChargerBudget } | { readonly ok: false; readonly code: "STALE" | "INVALID" | "LIMIT" };

/** Pure transition: the caller must persist the result before acknowledging it. No laptop budget is read. */
export function applyChargerBudget(current: ChargerBudget, input: Request): Result {
  if (input.sessionId !== current.sessionId || input.draftId !== current.draftId || input.revision !== current.revision) return { ok: false, code: "STALE" };
  if (!Number.isSafeInteger(current.revision) || current.revision < 1 || current.revision >= MAX_CHARGER_REVISION) return { ok: false, code: "LIMIT" };
  let next: ChargerBudget;
  switch (input.action) {
    case "propose": {
      if (!/^[1-9][0-9]{1,4}$/.test(input.dollars)) return { ok: false, code: "INVALID" };
      next = { ...current, proposedCents: Number(input.dollars) * 100, confirmedCents: null };
      break;
    }
    case "confirm":
      if (!Number.isSafeInteger(current.proposedCents) || current.proposedCents === null || current.proposedCents < 1000 || current.proposedCents > 9999900 || current.proposedCents % 100 !== 0) return { ok: false, code: "INVALID" };
      next = { ...current, confirmedCents: current.proposedCents };
      break;
    case "device":
      if (!(DEVICE_IDS as readonly string[]).includes(input.deviceId)) return { ok: false, code: "INVALID" };
      next = { ...current, deviceId: input.deviceId, proposedCents: null, confirmedCents: null };
      break;
    default:
      return { ok: false, code: "INVALID" };
  }
  return { ok: true, value: { ...next, revision: current.revision + 1 } };
}
