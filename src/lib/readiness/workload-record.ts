import type { AiWorkloadKind } from "./ai-workload";

export type WorkloadEvidenceState = "explicit" | "inferred" | "unresolved";

export type WorkloadRecord = {
  readonly sessionId: string;
  readonly draftId: string;
  readonly kind: AiWorkloadKind;
  readonly sourceDraftVersion: number;
  readonly evidenceState: WorkloadEvidenceState;
};

const WORKLOAD_KINDS = new Set<string>([
  "general_programming",
  "cloud_ai",
  "local_inference",
  "local_training",
  "unspecified_ai",
]);

const EVIDENCE_STATES = new Set<string>([
  "explicit",
  "inferred",
  "unresolved",
]);

const RECORD_KEYS = [
  "sessionId",
  "draftId",
  "kind",
  "sourceDraftVersion",
  "evidenceState",
] as const;

export function validateWorkloadRecord(value: unknown): WorkloadRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);

  if (
    keys.length !== RECORD_KEYS.length ||
    !RECORD_KEYS.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  ) {
    return null;
  }

  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
    return null;
  }

  if (typeof record.draftId !== "string" || record.draftId.length === 0) {
    return null;
  }

  if (typeof record.kind !== "string" || !WORKLOAD_KINDS.has(record.kind)) {
    return null;
  }

  if (
    typeof record.sourceDraftVersion !== "number" ||
    !Number.isSafeInteger(record.sourceDraftVersion) ||
    record.sourceDraftVersion < 1 ||
    record.sourceDraftVersion > 999_999_999
  ) {
    return null;
  }

  if (
    typeof record.evidenceState !== "string" ||
    !EVIDENCE_STATES.has(record.evidenceState)
  ) {
    return null;
  }

  return {
    sessionId: record.sessionId,
    draftId: record.draftId,
    kind: record.kind as AiWorkloadKind,
    sourceDraftVersion: record.sourceDraftVersion,
    evidenceState: record.evidenceState as WorkloadEvidenceState,
  };
}
