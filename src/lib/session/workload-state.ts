import type { WorkloadRecord } from "../readiness/workload-record";

const WORKLOADS = Symbol.for("shopaccess.workloads");

function workloadMap(store: object): Map<string, WorkloadRecord> {
  const host = store as Record<symbol, Map<string, WorkloadRecord> | undefined>;
  let records = host[WORKLOADS];

  if (!records) {
    records = new Map<string, WorkloadRecord>();
    host[WORKLOADS] = records;
  }

  return records;
}

/** Read an isolated copy of the workload records on this host. */
export function workloadRecordsOf(
  store: object,
): ReadonlyMap<string, WorkloadRecord> {
  return new Map(workloadMap(store));
}

/** Replace the host's workload records when loading durable state. */
export function replaceWorkloadRecords(
  store: object,
  records: ReadonlyMap<string, WorkloadRecord>,
): void {
  const current = workloadMap(store);
  current.clear();

  for (const [sessionId, record] of records) {
    if (record.sessionId === sessionId) {
      current.set(sessionId, record);
    }
  }
}

/**
 * Read advisory workload context only for the matching session and draft.
 * Reject records from future draft versions or with invalid version bounds.
 * This does not verify hardware compatibility or authorize purchases.
 */
export function workloadRecordForDraft(
  store: object,
  sessionId: string,
  draftId: string,
  draftVersion: number,
): WorkloadRecord | null {
  if (!Number.isSafeInteger(draftVersion) || draftVersion < 1) return null;

  const record = workloadMap(store).get(sessionId);
  if (
    !record ||
    record.sessionId !== sessionId ||
    record.draftId !== draftId ||
    !Number.isSafeInteger(record.sourceDraftVersion) ||
    record.sourceDraftVersion < 1 ||
    record.sourceDraftVersion > draftVersion
  ) {
    return null;
  }

  return record;
}

/** Set one workload record. This does not independently persist a transaction. */
export function setWorkloadRecord(
  store: object,
  record: WorkloadRecord,
): void {
  workloadMap(store).set(record.sessionId, record);
}

const UNRECOVERED = Symbol.for("shopaccess.workloadUnrecovered");

function unrecoveredOf(store: object): Set<string> {
  const host = store as Record<symbol, Set<string> | undefined>;
  let drafts = host[UNRECOVERED];
  if (!drafts) {
    drafts = new Set<string>();
    host[UNRECOVERED] = drafts;
  }
  return drafts;
}

/**
 * Drafts restored from a snapshot format that does not store workload records (formats 7 and 8). For them the absence
 * of a record proves nothing, because it may have been lost at restart. The marker lives on the host with the rest of
 * the state, is carried by the durable state, and is pruned to the drafts that still exist. In memory only; it changes
 * no persisted data.
 */
export function replaceUnrecoveredWorkloadDrafts(store: object, draftIds: Iterable<string>): void {
  const marked = unrecoveredOf(store);
  marked.clear();
  for (const id of draftIds) marked.add(id);
}

export function unrecoveredWorkloadDraftsOf(store: object): ReadonlySet<string> {
  return new Set(unrecoveredOf(store));
}

export function workloadsUnrecovered(store: object, draftId: string): boolean {
  return unrecoveredOf(store).has(draftId);
}
