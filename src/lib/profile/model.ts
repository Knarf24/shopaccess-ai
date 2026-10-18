import type { PersistedDeviceProfile, PersistedProfileRevision } from "@/lib/session/snapshot-state";

/** Slice limit for one saved brand or model. Not a catalog lookup. */
export const MAX_DEVICE_PROFILE_CHARS = 80;
/** Highest stored version. The next save is refused; the version does not wrap. */
export const MAX_DEVICE_PROFILE_VERSION = 999_999_999;

const PROFILE_CONTROL = /[\u0000-\u001F\u007F]/;

export type ProfileCode = "SESSION_NOT_LIVE" | "VERSION_STALE" | "VERSION_EXHAUSTED" | "FIELD_INVALID" | "STORED_INVALID";
export type ProfileOutcome = "saved" | "removed" | "unchanged";

export interface ProfileFieldInput {
  readonly consent: boolean;
  readonly text: string;
}

export interface ProfileWrite {
  readonly version: number;
  readonly brand: ProfileFieldInput;
  readonly model: ProfileFieldInput;
}

export type ProfileDecision =
  | {
      readonly ok: true;
      readonly outcome: ProfileOutcome;
      readonly profiles?: readonly PersistedDeviceProfile[];
      /** Present when the session's revision marker changes. Empty means the marker was consumed. */
      readonly revisions?: readonly PersistedProfileRevision[];
    }
  | { readonly ok: false; readonly code: ProfileCode };

/** Stored text: trimmed, 1–80 characters, no ASCII control character. */
export function validProfileText(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_DEVICE_PROFILE_CHARS && value.trim() === value && !PROFILE_CONTROL.test(value);
}

/** A stored version is an integer from 1 through the maximum. Zero is only the empty-form token. */
export function validStoredVersion(version: number): boolean {
  return Number.isSafeInteger(version) && version >= 1 && version <= MAX_DEVICE_PROFILE_VERSION;
}

function postedVersion(version: number): boolean {
  return Number.isSafeInteger(version) && version >= 0 && version <= MAX_DEVICE_PROFILE_VERSION;
}

export function storedProfileOk(profile: PersistedDeviceProfile): boolean {
  if (!validStoredVersion(profile.version)) return false;
  if (profile.brand === null && profile.model === null) return false;
  if (profile.brand !== null && !validProfileText(profile.brand)) return false;
  if (profile.model !== null && !validProfileText(profile.model)) return false;
  return true;
}

function taken(field: ProfileFieldInput): { readonly ok: true; readonly value: string | null } | { readonly ok: false } {
  if (!field.consent) return { ok: true, value: null };
  const text = field.text.trim();
  if (!validProfileText(text)) return { ok: false };
  return { ok: true, value: text };
}

function owned(existing: readonly PersistedDeviceProfile[], sessionId: string): PersistedDeviceProfile | null | "duplicate" {
  const matches = existing.filter((profile) => profile.sessionId === sessionId);
  if (matches.length > 1) return "duplicate";
  return matches[0] ?? null;
}

function markerOf(revisions: readonly PersistedProfileRevision[], sessionId: string): PersistedProfileRevision | null | "duplicate" {
  const matches = revisions.filter((revision) => revision.sessionId === sessionId);
  if (matches.length > 1) return "duplicate";
  return matches[0] ?? null;
}

/**
 * The revision marker remembers the last issued version after the profile row is gone. It has no brand or model.
 * A session has a profile or a marker or neither. The next create is marker + 1, or 1 when no marker exists.
 * At the maximum, that create is refused and the marker stays. The number does not wrap and does not go back to 1.
 */
function remember(revisions: readonly PersistedProfileRevision[], sessionId: string, version: number): readonly PersistedProfileRevision[] {
  return [...revisions.filter((revision) => revision.sessionId !== sessionId), { sessionId, version }];
}

function forget(revisions: readonly PersistedProfileRevision[], sessionId: string): readonly PersistedProfileRevision[] {
  return revisions.filter((revision) => revision.sessionId !== sessionId);
}

/**
 * One profile per session. Consent off drops that field and ignores the posted text. Consent on with blank or
 * invalid text refuses the whole save. Both fields absent removes a record, or leaves an empty session unchanged.
 * Removing the record keeps a revision marker and discards the text. A new version is the last issued version + 1.
 * Posted 0 is only the empty-form token. It is not the marker, and it cannot match a profile that was saved later.
 * At the maximum, a further save is refused and the record stays so it can still be removed.
 */
export function decideProfileSave(
  existing: readonly PersistedDeviceProfile[],
  sessionId: string,
  input: ProfileWrite,
  live: boolean,
  revisions: readonly PersistedProfileRevision[] = [],
): ProfileDecision {
  if (!live) return { ok: false, code: "SESSION_NOT_LIVE" };
  if (!postedVersion(input.version)) return { ok: false, code: "VERSION_STALE" };
  const current = owned(existing, sessionId);
  const marker = markerOf(revisions, sessionId);
  if (current === "duplicate" || marker === "duplicate") return { ok: false, code: "STORED_INVALID" };
  if (current && !storedProfileOk(current)) return { ok: false, code: "STORED_INVALID" };
  if (marker && !validStoredVersion(marker.version)) return { ok: false, code: "STORED_INVALID" };
  if (current && marker) return { ok: false, code: "STORED_INVALID" };
  const brand = taken(input.brand);
  const model = taken(input.model);
  if (!brand.ok || !model.ok) return { ok: false, code: "FIELD_INVALID" };
  if (brand.value === null && model.value === null) {
    if (!current) return input.version === 0 ? { ok: true, outcome: "unchanged" } : { ok: false, code: "VERSION_STALE" };
    if (input.version !== current.version) return { ok: false, code: "VERSION_STALE" };
    return { ok: true, outcome: "removed", profiles: existing.filter((profile) => profile.sessionId !== sessionId), revisions: remember(revisions, sessionId, current.version) };
  }
  if (!current) {
    if (input.version !== 0) return { ok: false, code: "VERSION_STALE" };
    const next = (marker?.version ?? 0) + 1;
    if (next > MAX_DEVICE_PROFILE_VERSION) return { ok: false, code: "VERSION_EXHAUSTED" };
    return {
      ok: true,
      outcome: "saved",
      profiles: [...existing, { sessionId, version: next, brand: brand.value, model: model.value }],
      ...(marker ? { revisions: forget(revisions, sessionId) } : {}),
    };
  }
  if (input.version !== current.version) return { ok: false, code: "VERSION_STALE" };
  if (current.version >= MAX_DEVICE_PROFILE_VERSION) return { ok: false, code: "VERSION_EXHAUSTED" };
  const updated: PersistedDeviceProfile = { sessionId, version: current.version + 1, brand: brand.value, model: model.value };
  return { ok: true, outcome: "saved", profiles: existing.map((profile) => (profile.sessionId === sessionId ? updated : profile)) };
}

/**
 * Removes the session's profile when the posted version matches. The marker keeps that version and not the text.
 * Version 0 with no record is an empty success. Any other version with no record is stale, including the marker's.
 */
export function decideProfileDelete(
  existing: readonly PersistedDeviceProfile[],
  sessionId: string,
  version: number,
  live: boolean,
  revisions: readonly PersistedProfileRevision[] = [],
): ProfileDecision {
  if (!live) return { ok: false, code: "SESSION_NOT_LIVE" };
  if (!postedVersion(version)) return { ok: false, code: "VERSION_STALE" };
  const current = owned(existing, sessionId);
  const marker = markerOf(revisions, sessionId);
  if (current === "duplicate" || marker === "duplicate") return { ok: false, code: "STORED_INVALID" };
  if (marker && !validStoredVersion(marker.version)) return { ok: false, code: "STORED_INVALID" };
  if (current && marker) return { ok: false, code: "STORED_INVALID" };
  if (!current) return version === 0 ? { ok: true, outcome: "unchanged" } : { ok: false, code: "VERSION_STALE" };
  if (!storedProfileOk(current)) return { ok: false, code: "STORED_INVALID" };
  if (version !== current.version) return { ok: false, code: "VERSION_STALE" };
  return { ok: true, outcome: "removed", profiles: existing.filter((profile) => profile.sessionId !== sessionId), revisions: remember(revisions, sessionId, current.version) };
}
