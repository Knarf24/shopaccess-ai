import { describe, expect, it } from "vitest";
import { applyChargerBudget, type ChargerBudget } from "@/lib/session/charger-budget";
const base: ChargerBudget = { sessionId: "session", draftId: "draft", deviceId: "Mac14,2", revision: 1, proposedCents: null, confirmedCents: null };
const request = { sessionId: "session", draftId: "draft", revision: 1 };
describe("separate charger budget", () => {
  it("proposes without confirming and refuses a stale confirmation", () => {
    const proposed = applyChargerBudget(base, { ...request, action: "propose", dollars: "59" });
    expect(proposed).toEqual({ ok: true, value: { ...base, revision: 2, proposedCents: 5900 } });
    if (!proposed.ok) throw Error("setup");
    expect(applyChargerBudget(proposed.value, { ...request, action: "confirm" })).toEqual({ ok: false, code: "STALE" });
    expect(applyChargerBudget(proposed.value, { ...request, revision: 2, action: "confirm" })).toMatchObject({ ok: true, value: { confirmedCents: 5900, revision: 3 } });
  });
  it.each(["", "0", "-1", "1.5", "Infinity", "100000", " 59", "059"])("rejects invalid whole-dollar budget %s", dollars => {
    expect(applyChargerBudget(base, { ...request, action: "propose", dollars })).toEqual({ ok: false, code: "INVALID" });
  });
  it("clears both budgets on a device change", () => {
    expect(applyChargerBudget({ ...base, proposedCents: 5900, confirmedCents: 5900 }, { ...request, action: "device", deviceId: "MacBookPro12,1" })).toMatchObject({ ok: true, value: { revision: 2, proposedCents: null, confirmedCents: null } });
  });
  it("refuses cross-session and cross-draft controls", () => {
    for (const patch of [{ sessionId: "other" }, { draftId: "other" }]) expect(applyChargerBudget(base, { ...request, ...patch, action: "propose", dollars: "59" })).toEqual({ ok: false, code: "STALE" });
  });
  it("requires a proposed amount before confirmation", () => {
    expect(applyChargerBudget(base, { ...request, action: "confirm" })).toEqual({ ok: false, code: "INVALID" });
  });
  it("refuses revision exhaustion", () => {
    expect(applyChargerBudget({ ...base, revision: 999999999 }, { ...request, revision: 999999999, action: "propose", dollars: "59" })).toEqual({ ok: false, code: "LIMIT" });
  });
});

import { applyChargerControl, routeChargerText, type ChargerTrack } from "@/lib/session/charger-clarification";
const confirmedTrack: ChargerTrack = { sessionId: "session", draftId: "draft", state: "confirmed", deviceId: "Mac14,2", revision: 4 };
describe("budget bound to the current charger track", () => {
  it("requires explicit proposal and confirmation on the shared revision", () => {
    const proposed = applyChargerControl(confirmedTrack, { ...request, revision: 4, control: { action: "propose_budget", dollars: "59" } });
    expect(proposed).toMatchObject({ kind: "applied", track: { revision: 5, budget: { proposedCents: 5900, confirmedCents: null } } });
    if (proposed.kind !== "applied") throw Error("setup");
    expect(applyChargerControl(proposed.track, { ...request, revision: 4, control: { action: "confirm_budget" } })).toEqual({ kind: "stale" });
    expect(applyChargerControl(proposed.track, { ...request, revision: 5, control: { action: "confirm_budget" } })).toMatchObject({ kind: "applied", track: { revision: 6, budget: { proposedCents: 5900, confirmedCents: 5900 } } });
  });
  it("does not accept a budget before the model is confirmed", () => {
    for (const state of ["candidate", "awaiting_model", "closed"] as const) {
      expect(applyChargerControl({ ...confirmedTrack, state, deviceId: state === "candidate" ? "Mac14,2" : null }, { ...request, revision: 4, control: { action: "propose_budget", dollars: "59" } })).toEqual({ kind: "not_allowed" });
    }
  });
  it("clears the budget when the model changes through controls or text", () => {
    const track = { ...confirmedTrack, budget: { proposedCents: 5900, confirmedCents: 5900 } };
    const changed = applyChargerControl(track, { ...request, revision: 4, control: { action: "change" } });
    expect(changed).toMatchObject({ kind: "applied", track: { revision: 5, deviceId: null } });
    if (changed.kind !== "applied") throw Error("setup");
    expect(changed.track.budget).toBeUndefined();
    const corrected = routeChargerText({ existing: track, sessionId: "session", draftId: "draft", reading: { kind: "charger", exactDevice: "MacBookPro12,1" }, structuredChange: false });
    expect(corrected).toMatchObject({ kind: "charger", track: { revision: 5, state: "candidate", deviceId: "MacBookPro12,1" } });
    if (corrected.kind !== "charger") throw Error("setup");
    expect(corrected.track.budget).toBeUndefined();
  });
  it("preserves the budget when text only repeats the same confirmed model", () => {
    const track = { ...confirmedTrack, budget: { proposedCents: 5900, confirmedCents: 5900 } };
    expect(routeChargerText({ existing: track, sessionId: "session", draftId: "draft", reading: { kind: "charger", exactDevice: "Mac14,2" }, structuredChange: false })).toMatchObject({ kind: "charger", track, changed: false });
  });
  it("editing a confirmed amount removes confirmation and advances the revision", () => {
    expect(applyChargerControl({ ...confirmedTrack, budget: { proposedCents: 5900, confirmedCents: 5900 } }, { ...request, revision: 4, control: { action: "propose_budget", dollars: "60" } })).toMatchObject({ kind: "applied", track: { revision: 5, budget: { proposedCents: 6000, confirmedCents: null } } });
  });
});
