import { describe, expect, it } from "vitest";

import { classifyChargerText } from "../../src/lib/compatibility/charger-intent";
import { DEVICE_IDS } from "../../src/lib/compatibility/evidence";
import {
  CHARGER_LINES,
  MAX_CHARGER_REVISION,
  applyChargerControl,
  assistantLineAfterLaptopResult,
  chargerTrackFor,
  chargerTracksOf,
  deleteChargerTracks,
  laptopOutputAllowed,
  replaceChargerTracks,
  routeChargerText,
  setChargerTrack,
  type ChargerTrack,
} from "../../src/lib/session/charger-clarification";

const S = `ses_${"1".padStart(32, "0")}`;
const OTHER = `ses_${"2".padStart(32, "0")}`;
const D = `nd_${"a".padStart(32, "0")}`;
const D2 = `nd_${"b".padStart(32, "0")}`;

const track = (state: ChargerTrack["state"], revision: number, deviceId: ChargerTrack["deviceId"] = null): ChargerTrack => ({ sessionId: S, draftId: D, state, deviceId, revision });
const route = (existing: ChargerTrack | null, text: string, structuredChange = false) =>
  routeChargerText({ existing, sessionId: S, draftId: D, reading: classifyChargerText(text), structuredChange });
const control = (existing: ChargerTrack | null, revision: number, value: Parameters<typeof applyChargerControl>[1]["control"], draftId = D, sessionId = S) =>
  applyChargerControl(existing, { sessionId, draftId, revision, control: value });

describe("charger clarification: text routing (slice 1, not wired to handlers)", () => {
  it("leaves laptop requests, plain text and a bare identifier on the laptop path when nothing is open", () => {
    for (const existing of [null, track("closed", 5)]) {
      expect(route(existing, "laptop for school under $500")).toEqual({ kind: "laptop" });
      expect(route(existing, "hello")).toEqual({ kind: "laptop" });
      expect(route(existing, "Mac14,2")).toEqual({ kind: "laptop" });
    }
  });

  it("opens at revision 1, asking for the model or reviewing an exact identifier", () => {
    expect(route(null, "I need a backup charger for my MacBook")).toEqual({ kind: "charger", track: track("awaiting_model", 1), line: "charger_model", changed: true });
    expect(route(null, "charger for Mac14,2")).toEqual({ kind: "charger", track: track("candidate", 1, "Mac14,2"), line: "charger_review", changed: true });
  });

  it("asks which task for mixed text, a bare adapter, or a charger request whose laptop fields changed", () => {
    expect(route(null, "a laptop and a charger")).toMatchObject({ kind: "charger", track: track("task_choice", 1), line: "charger_task_choice" });
    expect(route(null, "I need an adapter")).toMatchObject({ kind: "charger", track: track("task_choice", 1) });
    expect(route(null, "a charger", true)).toMatchObject({ kind: "charger", track: track("task_choice", 1) });
  });

  it("reopens a closed track with the next revision, never from 1", () => {
    expect(route(track("closed", 5), "a charger please")).toEqual({ kind: "charger", track: track("awaiting_model", 6), line: "charger_model", changed: true });
  });

  it("keeps an open clarification local: a description, adapter or unrelated text repeats the question with no revision change", () => {
    for (const text of ["MacBook Air", "the 2015 one", "an adapter", "hello", "MacBookPro15,4"]) {
      expect(route(track("awaiting_model", 3), text), text).toEqual({ kind: "charger", track: track("awaiting_model", 3), line: "charger_model", changed: false });
    }
  });

  it("takes an exact identifier as a candidate, including a correction from a confirmed model", () => {
    expect(route(track("awaiting_model", 3), "Mac14,2")).toEqual({ kind: "charger", track: track("candidate", 4, "Mac14,2"), line: "charger_review", changed: true });
    expect(route(track("task_choice", 3), "MacBookPro12,1")).toMatchObject({ track: track("candidate", 4, "MacBookPro12,1") });
    expect(route(track("confirmed", 7, "Mac14,2"), "MacBookPro12,1")).toEqual({ kind: "charger", track: track("candidate", 8, "MacBookPro12,1"), line: "charger_review", changed: true });
    // Restating the same model changes nothing.
    expect(route(track("confirmed", 7, "Mac14,2"), "Mac14,2")).toEqual({ kind: "charger", track: track("confirmed", 7, "Mac14,2"), line: "charger_shown", changed: false });
  });

  it("asks which task when an open clarification receives laptop text or changed laptop fields", () => {
    expect(route(track("confirmed", 7, "Mac14,2"), "actually a laptop for programming")).toMatchObject({ track: track("task_choice", 8), changed: true });
    expect(route(track("candidate", 2, "Mac14,2"), "more about it", true)).toMatchObject({ track: track("task_choice", 3) });
    expect(route(track("task_choice", 4), "laptop")).toMatchObject({ track: track("task_choice", 4), changed: false });
  });

  it("ignores a track that belongs to another draft or session", () => {
    const stale = { ...track("confirmed", 9, "Mac14,2"), draftId: D2 };
    expect(route(stale, "a charger")).toMatchObject({ track: track("awaiting_model", 1) });
    expect(route({ ...track("closed", 9), sessionId: OTHER }, "laptop")).toEqual({ kind: "laptop" });
  });

  it("refuses a change past the maximum revision and never wraps", () => {
    expect(route(track("awaiting_model", MAX_CHARGER_REVISION), "Mac14,2")).toEqual({ kind: "refused", code: "CHARGER_LIMIT" });
    expect(route(track("closed", MAX_CHARGER_REVISION), "a charger")).toEqual({ kind: "refused", code: "CHARGER_LIMIT" });
    expect(route(track("awaiting_model", MAX_CHARGER_REVISION), "hello")).toMatchObject({ kind: "charger", changed: false });
  });
});

describe("charger clarification: website controls (slice 1, not wired to routes)", () => {
  it("requires the session, the draft and the exact current revision", () => {
    const open = track("candidate", 4, "Mac14,2");
    expect(control(null, 4, { action: "confirm" })).toEqual({ kind: "stale" });
    expect(control(open, 3, { action: "confirm" })).toEqual({ kind: "stale" });
    expect(control(open, 5, { action: "confirm" })).toEqual({ kind: "stale" });
    expect(control(open, 4, { action: "confirm" }, D2)).toEqual({ kind: "stale" });
    expect(control(open, 4, { action: "confirm" }, D, OTHER)).toEqual({ kind: "stale" });
  });

  it("allows each action only in its state", () => {
    expect(control(track("awaiting_model", 2), 2, { action: "confirm" })).toEqual({ kind: "not_allowed" });
    expect(control(track("candidate", 2, "Mac14,2"), 2, { action: "choose_model", device: "MacBookPro12,1" })).toEqual({ kind: "not_allowed" });
    expect(control(track("awaiting_model", 2), 2, { action: "choose_task", task: "charger" })).toEqual({ kind: "not_allowed" });
    expect(control(track("task_choice", 2), 2, { action: "change" })).toEqual({ kind: "not_allowed" });
    for (const value of [{ action: "stop" }, { action: "confirm" }, { action: "change" }, { action: "choose_task", task: "charger" }] as const) {
      expect(control(track("closed", 2), 2, value)).toEqual({ kind: "not_allowed" });
    }
    for (const bad of ["__proto__", "Mac14", "constructor", "MacBookPro15,4", ""]) {
      expect(control(track("awaiting_model", 2), 2, { action: "choose_model", device: bad })).toEqual({ kind: "not_allowed" });
    }
  });

  it("applies the allowed transitions with the next revision and the state's line", () => {
    expect(control(track("task_choice", 1), 1, { action: "choose_task", task: "charger" })).toEqual({ kind: "applied", track: track("awaiting_model", 2), line: "charger_model" });
    expect(control(track("task_choice", 1), 1, { action: "choose_task", task: "laptop" })).toEqual({ kind: "applied", track: track("closed", 2), line: "charger_closed" });
    expect(control(track("awaiting_model", 2), 2, { action: "choose_model", device: "MacBookPro12,1" })).toEqual({ kind: "applied", track: track("candidate", 3, "MacBookPro12,1"), line: "charger_review" });
    expect(control(track("candidate", 3, "Mac14,2"), 3, { action: "confirm" })).toEqual({ kind: "applied", track: track("confirmed", 4, "Mac14,2"), line: "charger_shown" });
    expect(control(track("candidate", 3, "Mac14,2"), 3, { action: "change" })).toEqual({ kind: "applied", track: track("awaiting_model", 4), line: "charger_model" });
    expect(control(track("confirmed", 4, "Mac14,2"), 4, { action: "change" })).toEqual({ kind: "applied", track: track("awaiting_model", 5), line: "charger_model" });
    expect(control(track("confirmed", 4, "Mac14,2"), 4, { action: "stop" })).toEqual({ kind: "applied", track: track("closed", 5), line: "charger_closed" });
    expect(control(track("awaiting_model", 4), 4, { action: "stop" })).toMatchObject({ track: track("closed", 5) });
  });

  it("refuses a control past the maximum revision and leaves the track as it was", () => {
    expect(control(track("candidate", MAX_CHARGER_REVISION, "Mac14,2"), MAX_CHARGER_REVISION, { action: "confirm" })).toEqual({ kind: "refused", code: "CHARGER_LIMIT" });
  });

  it("never lets a retained control match a later clarification in the same draft (stop, switch, reopen)", () => {
    const issued: number[] = [];
    const held: { current: ChargerTrack | null } = { current: null };
    const step = (result: ReturnType<typeof route> | ReturnType<typeof control>) => {
      if (result.kind !== "charger" && result.kind !== "applied") throw new Error(`unexpected ${result.kind}`);
      held.current = result.track;
      issued.push(result.track.revision);
    };
    step(route(held.current, "a charger")); // awaiting_model
    step(control(held.current, held.current!.revision, { action: "choose_model", device: "Mac14,2" }));
    step(control(held.current, held.current!.revision, { action: "confirm" }));
    step(control(held.current, held.current!.revision, { action: "stop" }));
    step(route(held.current, "a laptop and a charger")); // reopen into task_choice
    step(control(held.current, held.current!.revision, { action: "choose_task", task: "laptop" }));
    step(route(held.current, "charger for MacBookPro12,1")); // reopen as candidate
    // Revisions strictly increase across every change, so each earlier control is stale now.
    expect(issued).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const old of issued.slice(0, -1)) {
      expect(control(held.current, old, { action: "confirm" })).toEqual({ kind: "stale" });
    }
    expect(control(held.current, 7, { action: "confirm" })).toMatchObject({ kind: "applied", track: track("confirmed", 8, "MacBookPro12,1") });
  });
});

describe("charger clarification: laptop work that was already started (slice 1 helpers, not wired)", () => {
  it("keeps the laptop line only when no clarification is open", () => {
    expect(assistantLineAfterLaptopResult(null, "review")).toBe("review");
    expect(assistantLineAfterLaptopResult(track("closed", 3), "missing_budget")).toBe("missing_budget");
    expect(assistantLineAfterLaptopResult(track("closed", 3), null)).toBeNull();
    expect(assistantLineAfterLaptopResult(track("task_choice", 3), "review")).toBe("charger_task_choice");
    expect(assistantLineAfterLaptopResult(track("awaiting_model", 3), "unavailable")).toBe("charger_model");
    expect(assistantLineAfterLaptopResult(track("candidate", 3, "Mac14,2"), "malformed")).toBe("charger_review");
    expect(assistantLineAfterLaptopResult(track("confirmed", 3, "Mac14,2"), null)).toBe("charger_shown");
  });

  it("allows new laptop output only while nothing is open", () => {
    expect(laptopOutputAllowed(null)).toBe(true);
    expect(laptopOutputAllowed(track("closed", 2))).toBe(true);
    for (const state of ["task_choice", "awaiting_model"] as const) expect(laptopOutputAllowed(track(state, 2))).toBe(false);
    for (const state of ["candidate", "confirmed"] as const) expect(laptopOutputAllowed(track(state, 2, "Mac14,2"))).toBe(false);
  });
});

describe("charger clarification: host slot", () => {
  it("holds one track per session and returns it only for its own draft", () => {
    const host = {};
    expect([...chargerTracksOf(host)]).toEqual([]);
    setChargerTrack(host, track("awaiting_model", 1));
    setChargerTrack(host, { ...track("closed", 4), sessionId: OTHER });
    expect(chargerTrackFor(host, S, D)).toEqual(track("awaiting_model", 1));
    expect(chargerTrackFor(host, S, D2)).toBeNull();
    setChargerTrack(host, track("candidate", 2, "Mac14,2"));
    expect([...chargerTracksOf(host).keys()].sort()).toEqual([S, OTHER].sort());
    deleteChargerTracks(host, [OTHER]);
    expect([...chargerTracksOf(host).keys()]).toEqual([S]);
    replaceChargerTracks(host, []);
    expect(chargerTracksOf(host).size).toBe(0);
  });

  it("is shared by module copies through a global symbol, as drafts and conversations are", () => {
    const host = {};
    setChargerTrack(host, track("awaiting_model", 1));
    expect(Object.getOwnPropertySymbols(host).map((symbol) => symbol.description)).toContain("shopaccess.chargerTracks");
  });

  it("names exactly the five assistant lines and covers every curated device", () => {
    expect([...CHARGER_LINES].sort()).toEqual(["charger_closed", "charger_model", "charger_review", "charger_shown", "charger_task_choice"]);
    for (const id of DEVICE_IDS) {
      expect(control(track("awaiting_model", 1), 1, { action: "choose_model", device: id })).toMatchObject({ kind: "applied" });
    }
  });
});
