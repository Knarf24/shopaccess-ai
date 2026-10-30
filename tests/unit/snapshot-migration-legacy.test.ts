import { describe, expect, it } from "vitest";

import { durableAiContext } from "@/lib/readiness/durable-conversation-workload";
import type { WorkloadRecord } from "@/lib/readiness/workload-record";
import { MAX_CONVERSATION_TURNS, type ConversationState } from "@/lib/session/conversation";
import { convertBodyToWorkloadBody } from "@/lib/session/snapshot-migration";
import { bodyFromState, restoreState } from "@/lib/session/snapshot-state";
import type { PublishedBody } from "@/lib/session/snapshot-store";
import { replaceUnrecoveredWorkloadDrafts, replaceWorkloadRecords } from "@/lib/session/workload-state";

// Converted legacy drafts keep the fail-closed AI treatment for a full history through a persisted marker, while a
// native format-10 draft without a record stays unmarked. The marker changes only the "potential" AI label (disclosure
// and withheld badge); it never changes eligibility, ranking or purchase authorization.
const NOW = new Date("2026-10-29T12:00:00.000Z");
const SESSION = "ses_" + "a".repeat(32);
const DRAFT = "nd_" + "b".repeat(32);
const turns = (count: number) => Array.from({ length: count }, (_, i) => ({ role: i % 2 ? "assistant" : "shopper", text: i % 2 ? "review" : `Thank you ${i}` }));
const body7With = (count: number): PublishedBody =>
  ({
    allocation: { windowStartedAt: null, count: 0 },
    admissionLogin: { windowStartedAt: null, count: 0 },
    sessions: [{ id: SESSION, tokenDigest: "c".repeat(64), createdAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), absoluteExpiresAt: "2026-10-30T12:00:00.000Z", revokedAt: null }],
    drafts: [{ sessionId: SESSION, draftId: DRAFT, version: 1, expiresAtMs: NOW.getTime() + 3_600_000, shopperText: "Thank you", interpretationPending: false, recommendationClaim: null, recommendation: null }],
    conversations: count === 0 ? [] : [{ sessionId: SESSION, draftId: DRAFT, interfaceLanguage: "en", turns: turns(count) }],
    selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [],
  }) as unknown as PublishedBody;
const body7 = body7With(MAX_CONVERSATION_TURNS);
const record = (kind: WorkloadRecord["kind"], draftId = DRAFT): WorkloadRecord => ({ sessionId: SESSION, draftId, kind, sourceDraftVersion: 1, evidenceState: "explicit" });
const converted = (count = MAX_CONVERSATION_TURNS, now = NOW) => convertBodyToWorkloadBody(body7With(count), now);

function after(body: PublishedBody, now: Date = NOW) {
  const host = {};
  const recovered = restoreState(body, now);
  replaceUnrecoveredWorkloadDrafts(host, recovered.state.unrecoveredWorkloadDrafts ?? []);
  replaceWorkloadRecords(host, recovered.state.workloads ?? new Map());
  const conversation = (recovered.state.conversations.get(SESSION) ?? null) as ConversationState | null;
  return {
    recovered,
    marked: recovered.state.unrecoveredWorkloadDrafts?.has(DRAFT) ?? false,
    context: durableAiContext(host, SESSION, DRAFT, 1, conversation, "Thank you"),
  };
}
const withRecords = (body: PublishedBody, ...records: WorkloadRecord[]): PublishedBody => ({ ...body, workloads: records }) as PublishedBody;

describe("the pure converter", () => {
  it("keeps every format-7 key unchanged and adds only the workload collection and the markers", () => {
    const out = converted();
    expect(Object.keys(out).sort()).toEqual([...Object.keys(body7), "legacyDrafts", "workloads"].sort());
    expect({ ...out, workloads: undefined, legacyDrafts: undefined }).toEqual({ ...body7, workloads: undefined, legacyDrafts: undefined });
    expect(out.workloads).toEqual([]);
    expect(out.legacyDrafts).toEqual([{ sessionId: SESSION, draftId: DRAFT }]);
  });

  it("marks a draft at exactly eight retained turns and not at seven", () => {
    expect(converted(MAX_CONVERSATION_TURNS - 1).legacyDrafts).toEqual([]);
    expect(converted(MAX_CONVERSATION_TURNS).legacyDrafts).toHaveLength(1);
    expect(converted(0).legacyDrafts).toEqual([]);
  });

  it("marks nothing for an expired draft or a revoked or lapsed session", () => {
    expect(converted(MAX_CONVERSATION_TURNS, new Date("2026-10-29T14:00:00.000Z")).legacyDrafts).toEqual([]);
    const revoked = { ...body7, sessions: [{ ...body7.sessions[0]!, revokedAt: NOW.toISOString() }] } as PublishedBody;
    expect(convertBodyToWorkloadBody(revoked, NOW).legacyDrafts).toEqual([]);
  });

  it("refuses an input that is already converted, and does not change its input", () => {
    const before = JSON.stringify(body7);
    expect(() => convertBodyToWorkloadBody(converted(), NOW)).toThrow("not-a-conversion-input");
    expect(() => convertBodyToWorkloadBody(withRecords(body7), NOW)).toThrow("not-a-conversion-input");
    convertBodyToWorkloadBody(body7, NOW);
    expect(JSON.stringify(body7)).toBe(before);
  });
});

describe("restoration and lifecycle of the legacy marker", () => {
  it("format 7: every restored draft is marked, as before", () => {
    expect(after(body7)).toMatchObject({ marked: true, context: "potential" });
    expect(after(body7).recovered.state.legacyDrafts).toBeUndefined();
  });

  it("a converted full-history draft is marked and stays potential-AI", () => {
    const result = after(converted());
    expect(result).toMatchObject({ marked: true, context: "potential" });
    expect([...(result.recovered.state.legacyDrafts ?? [])]).toEqual([[SESSION, DRAFT]]);
  });

  it("a native format-10 draft without a record stays unmarked (no legacy key, and an empty list)", () => {
    expect(after(withRecords(body7))).toMatchObject({ marked: false, context: false });
    expect(after(withRecords(body7)).recovered.state.legacyDrafts).toBeUndefined();
    expect(after({ ...withRecords(body7), legacyDrafts: [] } as PublishedBody)).toMatchObject({ marked: false, context: false });
  });

  it("a converted draft below eight turns is unmarked and unaffected", () => {
    expect(after(converted(MAX_CONVERSATION_TURNS - 2))).toMatchObject({ marked: false, context: false });
  });

  it("a general_programming record does not clear the marker", () => {
    const body = { ...converted(), workloads: [record("general_programming")] } as PublishedBody;
    expect(after(body)).toMatchObject({ marked: true, context: "potential" });
    expect(bodyFromState(after(body).recovered.state, 9).legacyDrafts).toEqual([{ sessionId: SESSION, draftId: DRAFT }]);
  });

  it.each(["local_training", "local_inference", "cloud_ai", "unspecified_ai"] as const)("a %s record supersedes the effect but not the marker", (kind) => {
    const body = { ...converted(), workloads: [record(kind)] } as PublishedBody;
    expect(after(body).context).toBe(true);
    expect(bodyFromState(after(body).recovered.state, 9).legacyDrafts).toEqual([{ sessionId: SESSION, draftId: DRAFT }]);
  });

  it("is written back unchanged, including an empty list, and absent stays absent", () => {
    expect(bodyFromState(after(converted()).recovered.state, 9).legacyDrafts).toEqual([{ sessionId: SESSION, draftId: DRAFT }]);
    expect(bodyFromState(after({ ...withRecords(body7), legacyDrafts: [] } as PublishedBody).recovered.state, 9).legacyDrafts).toEqual([]);
    expect("legacyDrafts" in bodyFromState(after(withRecords(body7)).recovered.state, 9)).toBe(false);
    expect("legacyDrafts" in bodyFromState(after(body7).recovered.state, 7)).toBe(false);
  });

  it("survives a second restart through the written body", () => {
    const written = bodyFromState(after(converted()).recovered.state, 9);
    expect(after(written)).toMatchObject({ marked: true, context: "potential" });
    expect(after(bodyFromState(after(written).recovered.state, 9))).toMatchObject({ marked: true, context: "potential" });
  });

  it("disappears with a replaced draft, an expired draft or an ended session", () => {
    const state = after(converted()).recovered.state;
    const replaced = { ...state, drafts: new Map([[SESSION, { ...state.drafts.get(SESSION)!, draftId: "nd_" + "d".repeat(32) }]]) };
    expect(bodyFromState(replaced, 9).legacyDrafts).toEqual([]);
    expect(after(converted(), new Date("2026-10-29T14:00:00.000Z")).recovered.state.legacyDrafts?.size).toBe(0);
    const revoked = { ...converted(), sessions: [{ ...body7.sessions[0]!, revokedAt: NOW.toISOString() }] } as PublishedBody;
    expect(after(revoked).recovered.state.legacyDrafts?.size).toBe(0);
  });

  it("ignores a marker whose draft is not the session's current draft", () => {
    const stale = { ...converted(), legacyDrafts: [{ sessionId: SESSION, draftId: "nd_" + "e".repeat(32) }] } as PublishedBody;
    expect(after(stale)).toMatchObject({ marked: false, context: false });
  });
});
