import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/lib/shared/canonical-json";
import { openFoundationStore } from "../../src/lib/session/snapshot-store";

// M2-1 slice 1: format 2 adds the guided conversation and the needs-bound selection state.
const KEY = Buffer.from("snapshot-format2-key");
const CREATED = "2026-01-01T00:00:00.000Z";
const ABSOLUTE = "2026-01-02T00:00:00.000Z";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const sessionId = (n: number) => `ses_${n.toString(16).padStart(32, "0")}`;
const draftId = (n: number) => `nd_${n.toString(16).padStart(32, "0")}`;
const session = (n: number) => ({ id: sessionId(n), tokenDigest: (n + 8).toString(16).padStart(64, "0"), createdAt: CREATED, lastSeenAt: CREATED, absoluteExpiresAt: ABSOLUTE, revokedAt: null });
const draft = (n: number, patch: Record<string, unknown> = {}) => ({
  sessionId: sessionId(n), draftId: draftId(n), version: 3, language: "es", shopperText: "para la escuela", prefilledUse: "schoolwork", prefilledBudgetDollars: "500",
  confirmedUse: null, confirmedBudgetDollars: null, interpretationClaimVersion: null, interpretationPending: false, recommendationClaim: null, recommendation: null, notice: "review", expiresAtMs: Date.parse(ABSOLUTE), ...patch,
});
const turns = (count: number) => Array.from({ length: count }, (_, i) => (i % 2 === 0 ? { role: "shopper", text: `line ${i}` } : { role: "assistant", text: "review" }));
const conversation = (n: number, patch: Record<string, unknown> = {}) => ({ sessionId: sessionId(n), draftId: draftId(n), interfaceLanguage: "es", turns: turns(4), ...patch });
const selection = (n: number, patch: Record<string, unknown> = {}) => ({ sessionId: sessionId(n), epoch: 2, closed: true, ...patch });
const body = (patch: Record<string, unknown> = {}) => ({
  allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 },
  sessions: [session(1), session(2)], drafts: [draft(1), draft(2)], conversations: [conversation(1)], selections: [selection(1)], ...patch,
});
/** The format-1 body: the format-2 body without conversations and selections. */
const legacyBody = () => {
  const { allocation, admissionLogin, sessions, drafts } = body();
  // Format-1 drafts have no interpretationPending field.
  return { allocation, admissionLogin, sessions, drafts: drafts.map((draft) => Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "interpretationPending"))) };
};
/** The same body in the current write format (3): format 2 plus an empty grant list. */
const v3 = (value: Record<string, unknown>) => ({ ...value, grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] });
const identityFor = (key: Buffer) => createHash("sha256").update(Buffer.concat([Buffer.from("shopaccess.mock-store.v1"), Buffer.from([0]), key])).digest("hex");
const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const file = (format: number, value: unknown) => Buffer.from(JSON.stringify({ format, identity: identityFor(KEY), sha256: checksum(value), body: value }));

function fixture(bytes: Buffer): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-format2-"));
  directories.push(directory);
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(join(directory, "store.json"), bytes, { mode: 0o600 });
  fs.chmodSync(join(directory, "store.json"), 0o600);
  return directory;
}

async function opens(bytes: Buffer): Promise<boolean> {
  const opened = await openFoundationStore(fixture(bytes), KEY);
  return opened.status === "ready";
}

describe("snapshot format 2", () => {
  it("round-trips conversations and selections exactly", async () => {
    const value = body();
    const directory = fixture(file(2, value));
    const opened = await openFoundationStore(directory, KEY);
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    const read = opened.value.readPublished();
    expect(read.status === "ready" && read.value.format).toBe(2);
    expect(read.status === "ready" && canonicalJson(read.value.body)).toBe(canonicalJson(v3(value)));
    const next = body({ conversations: [conversation(1), conversation(2, { interfaceLanguage: "en", turns: turns(8) })], selections: [selection(1), selection(2, { epoch: 0, closed: false })] });
    const committed = await opened.value.commit(v3(next));
    expect(committed.status).toBe("ready");
    const stored = JSON.parse(fs.readFileSync(join(directory, "store.json"), "utf8"));
    expect(stored.format).toBe(7);
    expect(canonicalJson(stored.body)).toBe(canonicalJson(v3(next)));
  });

  it("refuses inconsistent or malformed conversation and selection entries", async () => {
    const refused: Array<[string, Record<string, unknown>]> = [
      ["conversation for an unknown session", { conversations: [conversation(9)] }],
      ["conversation for a session without a draft", { drafts: [draft(1)], conversations: [conversation(2)] }],
      ["conversation naming another draft", { conversations: [conversation(1, { draftId: draftId(2) })] }],
      ["two conversations for one session", { conversations: [conversation(1), conversation(1)] }],
      ["nine lines (the limit is eight lines)", { conversations: [conversation(1, { turns: turns(9) })] }],
      ["assistant line that is not a notice token", { conversations: [conversation(1, { turns: [{ role: "assistant", text: "free text" }] })] }],
      ["empty shopper line", { conversations: [conversation(1, { turns: [{ role: "shopper", text: "" }] })] }],
      ["untrimmed shopper line", { conversations: [conversation(1, { turns: [{ role: "shopper", text: " padded" }] })] }],
      ["control character", { conversations: [conversation(1, { turns: [{ role: "shopper", text: "a\u0007b" }] })] }],
      ["shopper line over 2000 characters", { conversations: [conversation(1, { turns: [{ role: "shopper", text: "x".repeat(2001) }] })] }],
      ["unknown role", { conversations: [conversation(1, { turns: [{ role: "system", text: "review" }] })] }],
      ["extra turn key", { conversations: [conversation(1, { turns: [{ role: "shopper", text: "a", at: 1 }] })] }],
      ["bad interface language", { conversations: [conversation(1, { interfaceLanguage: "fr" })] }],
      ["extra conversation key", { conversations: [{ ...conversation(1), extra: true }] }],
      ["selection for an unknown session", { selections: [selection(9)] }],
      ["two selections for one session", { selections: [selection(1), selection(1)] }],
      ["negative epoch", { selections: [selection(1, { epoch: -1 })] }],
      ["draft without the pending flag", { drafts: [Object.fromEntries(Object.entries(draft(1)).filter(([key]) => key !== "interpretationPending")), draft(2)] }],
      ["pending flag that is not boolean", { drafts: [draft(1, { interpretationPending: "yes" }), draft(2)] }],
      ["pending without a claim on the current version", { drafts: [draft(1, { interpretationPending: true, interpretationClaimVersion: null }), draft(2)] }],
      ["fractional epoch", { selections: [selection(1, { epoch: 1.5 })] }],
      ["non-boolean closed", { selections: [selection(1, { closed: "true" })] }],
      ["conversations not an array", { conversations: {} }],
    ];
    for (const [label, patch] of refused) expect(await opens(file(2, body(patch))), label).toBe(false);
    const legacy = legacyBody();
    expect(await opens(file(2, legacy)), "format 2 without the new keys").toBe(false);
    expect(await opens(file(1, body())), "format 1 carrying format-2 keys").toBe(false);
    expect(await opens(file(3, body())), "unknown format").toBe(false);
  });

  it("reads a format-1 file upgraded, leaves it untouched, and writes the current format (3) on the next commit", async () => {
    const legacy = legacyBody();
    const bytes = file(1, legacy);
    const directory = fixture(bytes);
    const opened = await openFoundationStore(directory, KEY);
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    const read = opened.value.readPublished();
    expect(read.status === "ready" && read.value.format).toBe(1);
    expect(read.status === "ready" && canonicalJson(read.value.body)).toBe(canonicalJson({ ...legacy, drafts: legacy.drafts.map((d) => ({ ...d, interpretationPending: false })), conversations: [], selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] }));
    expect(fs.readFileSync(join(directory, "store.json")).equals(bytes)).toBe(true);
    const committed = await opened.value.commit(v3(body()));
    expect(committed.status).toBe("ready");
    const stored = JSON.parse(fs.readFileSync(join(directory, "store.json"), "utf8"));
    expect(stored.format).toBe(7);
    expect(canonicalJson(stored.body)).toBe(canonicalJson(v3(body())));
    expect(stored.sha256).toBe(checksum(v3(body())));
  });

  it("refuses a commit larger than the readable limit as definite, leaving the store usable", async () => {
    const directory = fixture(file(2, body()));
    const opened = await openFoundationStore(directory, KEY);
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    const before = fs.readFileSync(join(directory, "store.json"));
    const many = Array.from({ length: 480 }, (_, i) => i + 10);
    const huge = v3(body({
      sessions: many.map(session),
      drafts: many.map((n) => draft(n, { shopperText: "y".repeat(2000) })),
      conversations: many.map((n) => conversation(n, { turns: Array.from({ length: 8 }, () => ({ role: "shopper", text: "z".repeat(2000) })) })),
      selections: [],
    }));
    const result = await opened.value.commit(huge);
    expect(result).toEqual({ status: "unavailable", outcome: "definite" });
    expect(fs.readFileSync(join(directory, "store.json")).equals(before)).toBe(true);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("store.json.tmp."))).toEqual([]);
    expect((await opened.value.commit(v3(body({ selections: [] })))).status).toBe("ready");
  });

  it("reports a refused body as definite and a post-rename flush failure as indeterminate", async () => {
    const definiteDir = fixture(file(2, body()));
    const usable = await openFoundationStore(definiteDir, KEY);
    if (usable.status !== "ready") throw new Error("open");
    expect(await usable.value.commit({ not: "a body" })).toEqual({ status: "unavailable", outcome: "definite" });
    expect(usable.value.readPublished().status).toBe("ready");

    const faultDir = fixture(file(2, body()));
    const faulting = await openFoundationStore(faultDir, KEY, { directoryFsync: async () => { throw new Error("flush"); } });
    if (faulting.status !== "ready") throw new Error("open");
    expect(await faulting.value.commit(v3(body({ selections: [] })))).toEqual({ status: "unavailable", outcome: "indeterminate" });
    expect(faulting.value.readPublished().status).toBe("unavailable");
    expect(await faulting.value.commit(v3(body()))).toEqual({ status: "unavailable", outcome: "indeterminate" });
  });
});
