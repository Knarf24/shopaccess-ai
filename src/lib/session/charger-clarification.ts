import type { ChargerTextReading } from "../compatibility/charger-intent";
import { DEVICE_IDS, type DeviceId } from "../compatibility/evidence";
import type { NeedsNotice } from "../i18n/needs-notice";

/**
 * Charger clarification state for one session's current needs draft (F03 conversation, slice 1).
 *
 * Slice 1 defines the state, its pure transitions and its persistence (snapshot format 7, proposed). Nothing here is wired
 * into a handler, route, page or extension view yet, and nothing here calls a provider.
 *
 * One track per session, bound to that session's current draft. The track is kept after Stop or a switch to laptop
 * shopping as `closed`, and it is removed only with its draft or its session (draft expiry or replacement, logout,
 * session expiry, restore). `revision` only increases: every change of state or device advances it, including closing
 * and reopening, so a website control issued for an earlier clarification never matches a later one in the same draft.
 * A new draft has a new random id, so a control bound to an old draft never matches either. A restart restores the
 * track exactly as saved, so a control issued before the restart stays valid only while nothing changed. A change that
 * would pass MAX_CHARGER_REVISION is refused; the revision never wraps.
 *
 * Charger handling starts no AI work. Laptop work that was already started may finish; the helpers at the end say how
 * its result is shown while a clarification is open.
 */

export type ChargerState = "closed" | "task_choice" | "awaiting_model" | "candidate" | "confirmed";

export interface ChargerTrack {
  readonly sessionId: string;
  readonly draftId: string;
  readonly state: ChargerState;
  /** Set exactly for `candidate` and `confirmed`. */
  readonly deviceId: DeviceId | null;
  readonly revision: number;
}

/** Assistant lines stored in the conversation. None of them names a device. */
export type ChargerLine = "charger_task_choice" | "charger_model" | "charger_review" | "charger_shown" | "charger_closed";

export const CHARGER_LINES: readonly ChargerLine[] = ["charger_task_choice", "charger_model", "charger_review", "charger_shown", "charger_closed"];

export const MAX_CHARGER_REVISION = 999_999_999;

const LINE_FOR: Readonly<Record<ChargerState, ChargerLine>> = {
  closed: "charger_closed",
  task_choice: "charger_task_choice",
  awaiting_model: "charger_model",
  candidate: "charger_review",
  confirmed: "charger_shown",
};

export function chargerLineFor(state: ChargerState): ChargerLine {
  return LINE_FOR[state];
}

export function isOpenChargerTrack(track: ChargerTrack | null): track is ChargerTrack {
  return track !== null && track.state !== "closed";
}

function isDeviceId(value: string): value is DeviceId {
  return (DEVICE_IDS as readonly string[]).includes(value);
}

/** The track only if it belongs to this session and this draft. */
function own(existing: ChargerTrack | null, sessionId: string, draftId: string): ChargerTrack | null {
  return existing !== null && existing.sessionId === sessionId && existing.draftId === draftId ? existing : null;
}

type Next = { readonly state: ChargerState; readonly deviceId: DeviceId | null };

/** The next track, with the revision advanced only when the state or device changes. Null when past the maximum. */
function advance(existing: ChargerTrack | null, sessionId: string, draftId: string, next: Next): { track: ChargerTrack; changed: boolean } | null {
  if (existing && existing.state === next.state && existing.deviceId === next.deviceId) return { track: existing, changed: false };
  const revision = existing ? existing.revision + 1 : 1;
  if (revision > MAX_CHARGER_REVISION) return null;
  return { track: { sessionId, draftId, state: next.state, deviceId: next.deviceId, revision }, changed: true };
}

export type ChargerTextRoute =
  | { readonly kind: "laptop" }
  | { readonly kind: "charger"; readonly track: ChargerTrack; readonly line: ChargerLine; readonly changed: boolean }
  | { readonly kind: "refused"; readonly code: "CHARGER_LIMIT" };

/**
 * Routes one shopper message by the session's current clarification state, not by keywords alone.
 * - Nothing open (no track, or `closed`): laptop text, plain text and a bare identifier stay on the laptop path. A clear
 *   charger request opens the clarification (`candidate` when an exact identifier is present). Mixed text, a bare
 *   "adapter", or a charger request whose structured laptop fields changed opens it as `task_choice`.
 * - Open: an exact identifier becomes the candidate (a correction from a confirmed model); laptop text, mixed text or
 *   changed laptop fields ask which task; anything else repeats the current question. Never the laptop path.
 * `structuredChange` is true when posted laptop fields differ from the draft's prefilled values; they are never applied
 * to a charger request.
 */
export function routeChargerText(input: {
  readonly existing: ChargerTrack | null;
  readonly sessionId: string;
  readonly draftId: string;
  readonly reading: ChargerTextReading;
  readonly structuredChange: boolean;
}): ChargerTextRoute {
  const existing = own(input.existing, input.sessionId, input.draftId);
  const { kind, exactDevice } = input.reading;
  let next: Next | null;
  if (!isOpenChargerTrack(existing)) {
    if (kind === "laptop" || kind === "none") return { kind: "laptop" };
    next =
      kind === "charger" && !input.structuredChange
        ? exactDevice
          ? { state: "candidate", deviceId: exactDevice }
          : { state: "awaiting_model", deviceId: null }
        : { state: "task_choice", deviceId: null };
  } else if (kind === "laptop" || kind === "mixed" || input.structuredChange) {
    next = { state: "task_choice", deviceId: null };
  } else if (exactDevice) {
    next = existing.state === "confirmed" && existing.deviceId === exactDevice ? { state: "confirmed", deviceId: exactDevice } : { state: "candidate", deviceId: exactDevice };
  } else {
    next = { state: existing.state, deviceId: existing.deviceId };
  }
  const advanced = advance(existing, input.sessionId, input.draftId, next);
  if (!advanced) return { kind: "refused", code: "CHARGER_LIMIT" };
  return { kind: "charger", track: advanced.track, line: chargerLineFor(advanced.track.state), changed: advanced.changed };
}

export type ChargerControl =
  | { readonly action: "choose_task"; readonly task: "charger" | "laptop" }
  | { readonly action: "choose_model"; readonly device: string }
  | { readonly action: "confirm" }
  | { readonly action: "change" }
  | { readonly action: "stop" };

export type ChargerControlResult =
  | { readonly kind: "applied"; readonly track: ChargerTrack; readonly line: ChargerLine }
  | { readonly kind: "stale" }
  | { readonly kind: "not_allowed" }
  | { readonly kind: "refused"; readonly code: "CHARGER_LIMIT" };

/** The state an action leads to from `track`, or null when the action is not allowed there. */
function controlTarget(track: ChargerTrack, control: ChargerControl): Next | null {
  switch (control.action) {
    case "choose_task":
      if (track.state !== "task_choice") return null;
      return control.task === "charger" ? { state: "awaiting_model", deviceId: null } : control.task === "laptop" ? { state: "closed", deviceId: null } : null;
    case "choose_model":
      return track.state === "awaiting_model" && isDeviceId(control.device) ? { state: "candidate", deviceId: control.device } : null;
    case "confirm":
      return track.state === "candidate" ? { state: "confirmed", deviceId: track.deviceId } : null;
    case "change":
      return track.state === "candidate" || track.state === "confirmed" ? { state: "awaiting_model", deviceId: null } : null;
    case "stop":
      return isOpenChargerTrack(track) ? { state: "closed", deviceId: null } : null;
    default:
      return null;
  }
}

/**
 * One website control. It must name the session's own track, the current draft and the exact current revision; then the
 * action must be allowed in the track's state. Every applied control advances the revision.
 */
export function applyChargerControl(
  existing: ChargerTrack | null,
  input: { readonly sessionId: string; readonly draftId: string; readonly revision: number; readonly control: ChargerControl },
): ChargerControlResult {
  const track = own(existing, input.sessionId, input.draftId);
  if (!track || track.revision !== input.revision) return { kind: "stale" };
  const next = controlTarget(track, input.control);
  if (!next) return { kind: "not_allowed" };
  const advanced = advance(track, input.sessionId, input.draftId, next);
  if (!advanced) return { kind: "refused", code: "CHARGER_LIMIT" };
  return { kind: "applied", track: advanced.track, line: chargerLineFor(advanced.track.state) };
}

/**
 * The assistant line recorded when laptop work that was started before a clarification opened finishes. Its laptop
 * fields are still written; while a clarification is open, its laptop line is replaced by the clarification's current
 * question so it does not replace the active charger question.
 */
export function assistantLineAfterLaptopResult(track: ChargerTrack | null, notice: NeedsNotice | null): NeedsNotice | ChargerLine | null {
  return isOpenChargerTrack(track) ? chargerLineFor(track.state) : notice;
}

/** New laptop output (for example a recommendation claim) may start only while no clarification is open. */
export function laptopOutputAllowed(track: ChargerTrack | null): boolean {
  return !isOpenChargerTrack(track);
}

/**
 * Per-host tracks under a global symbol, as needs drafts and conversations are (store.ts, conversation.ts): the Next.js
 * server can load this module more than once, and every copy must see the same map for the same host.
 */
const CHARGER_TRACKS = Symbol.for("shopaccess.chargerTracks");

type TrackHost = object & { [CHARGER_TRACKS]?: Map<string, ChargerTrack> };

function trackMap(store: object): Map<string, ChargerTrack> {
  const host = store as TrackHost;
  let found = host[CHARGER_TRACKS];
  if (!found) {
    found = new Map();
    host[CHARGER_TRACKS] = found;
  }
  return found;
}

export function chargerTracksOf(store: object): ReadonlyMap<string, ChargerTrack> {
  return trackMap(store);
}

/** Replaces every track of one host. Used by the snapshot runtime to publish a durable state and to seed a scratch host. */
export function replaceChargerTracks(store: object, tracks: Iterable<readonly [string, ChargerTrack]>): void {
  const found = trackMap(store);
  found.clear();
  for (const [sessionId, track] of tracks) found.set(sessionId, track);
}

export function setChargerTrack(store: object, track: ChargerTrack): void {
  trackMap(store).set(track.sessionId, track);
}

export function deleteChargerTracks(store: object, sessionIds: readonly string[]): void {
  const found = trackMap(store);
  for (const sessionId of sessionIds) found.delete(sessionId);
}

/** The session's track for this draft, or null (none, or a track left from another draft). */
export function chargerTrackFor(store: object, sessionId: string, draftId: string): ChargerTrack | null {
  return own(trackMap(store).get(sessionId) ?? null, sessionId, draftId);
}
