import type { WorkloadRecord } from "./workload-record";
import { updateWorkloadFromShopperTurn } from "./workload-record-update";
import {
  setWorkloadRecord,
  workloadRecordForDraft,
} from "../session/workload-state";

/**
 * Updates advisory workload context only after the caller has accepted
 * a laptop shopper turn within its durable transaction.
 *
 * The caller must enforce laptop/charger routing and draft acceptance.
 * This helper does not commit transactions, verify hardware compatibility,
 * or authorize purchases.
 */
export function recordAcceptedLaptopWorkload(
  host: object,
  sessionId: string,
  draftId: string,
  draftVersion: number,
  shopperText: string,
): {
  readonly previous: WorkloadRecord | null;
  readonly current: WorkloadRecord | null;
  readonly changed: boolean;
} {
  const previous = workloadRecordForDraft(
    host,
    sessionId,
    draftId,
    draftVersion,
  );

  const current = updateWorkloadFromShopperTurn(
    previous,
    shopperText,
    sessionId,
    draftId,
    draftVersion,
  );

  if (current && current !== previous) {
    setWorkloadRecord(host, current);
  }

  return {
    previous,
    current,
    changed: previous !== null && current !== null &&
      previous.kind !== current.kind,
  };
}
