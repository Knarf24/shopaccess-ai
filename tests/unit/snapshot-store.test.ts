import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsExt from "fs-ext";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../../src/lib/shared/canonical-json";
import type { PublishedBody } from "../../src/lib/session/snapshot-store";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const KEY = Buffer.from("snapshot-fixture-key");
const OTHER_KEY = Buffer.from("snapshot-other-key");
const CREATED = "2026-01-01T00:00:00.000Z";
const ABSOLUTE = "2026-01-02T00:00:00.000Z";
const CREATED_MS = Date.parse(CREATED);
const MAX_SAFE = 9007199254740991;
const RACE = "macOS can reuse a pid between the identity match and the signal; a signal is sent only after a match";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("snapshot foundation", () => {
  it("exports only the storage opener and the non-storage lock predicate", async () => {
    const loaded = await import("../../src/lib/session/snapshot-store");
    const names = Object.keys(loaded).filter((key) => key !== "__esModule").sort();
    expect(names).toEqual(["lockStatRejects", "openFoundationStore", "openFoundationStoreWithKeyFile"]);
    const uid = process.getuid?.() ?? 0;
    expect(loaded.lockStatRejects({ uid: uid + 1, mode: 0o600, isFile: true, nlink: 1 }, uid)).toBe(true);
    expect(loaded.lockStatRejects({ uid, mode: 0o600, isFile: true, nlink: 1 }, uid)).toBe(false);
  });

  // Owner-approved M2-1 boundary (docs/m2-1-plan.md §9.8). The October 14 foundation plan deferred runtime integration;
  // integration is now allowed only through src/server/runtime-access.ts.
  it("lets only runtime-access.ts reach snapshot storage and keeps it out of routes, handlers, shopping, respond and runtime.ts", () => {
    const source = walk(join(ROOT, "src")).filter((file) => /\.(ts|tsx|mts)$/.test(file));
    const rel = (file: string) => file.slice(ROOT.length).replace(/^\//, "");
    const valueImport = /(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+["'][^"']*snapshot-store["']|import\(\s*["'][^"']*snapshot-store["']\s*\)|(?:^|\n)\s*export\s+[^;]*?from\s+["'][^"']*snapshot-store["']/;
    const typeImport = /(?:^|\n)\s*import\s+type\s+[^;]*?from\s+["'][^"']*snapshot-store["']/;
    const fsExt = /["']fs-ext["']/;
    const valueImporters = source.filter((file) => valueImport.test(fs.readFileSync(file, "utf8"))).map(rel).sort();
    const typeImporters = source.filter((file) => typeImport.test(fs.readFileSync(file, "utf8"))).map(rel).sort();
    const fsExtImporters = source.filter((file) => fsExt.test(fs.readFileSync(file, "utf8"))).map(rel).sort();
    const allowedValue = ["src/server/mock-store-init.mts", "src/server/runtime-access.ts"];
    expect(valueImporters.every((file) => allowedValue.includes(file)), valueImporters.join(", ")).toBe(true);
    expect(typeImporters.every((file) => file === "src/lib/session/snapshot-state.ts"), typeImporters.join(", ")).toBe(true);
    expect(fsExtImporters.every((file) => ["src/lib/session/snapshot-store.ts", "src/server/mock-store-init.mts", "src/types/fs-ext.ts"].includes(file)), fsExtImporters.join(", ")).toBe(true);
    const forbidden = [...walk(join(ROOT, "src", "app")), ...["runtime.ts", "respond.ts", "handlers.ts", "shopping.ts"].map((name) => join(ROOT, "src", "server", name))];
    for (const file of forbidden) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/snapshot-store/);
      expect(text, file).not.toMatch(/fs-ext/);
    }
  });

  it("the boundary scan recognises value, dynamic, re-export and type-only imports", () => {
    const valueImport = /(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+["'][^"']*snapshot-store["']|import\(\s*["'][^"']*snapshot-store["']\s*\)|(?:^|\n)\s*export\s+[^;]*?from\s+["'][^"']*snapshot-store["']/;
    const typeImport = /(?:^|\n)\s*import\s+type\s+[^;]*?from\s+["'][^"']*snapshot-store["']/;
    expect(valueImport.test('import { openFoundationStore } from "@/lib/session/snapshot-store";')).toBe(true);
    expect(valueImport.test('const m = await import("../lib/session/snapshot-store");')).toBe(true);
    expect(valueImport.test('export { openFoundationStore } from "./snapshot-store";')).toBe(true);
    expect(valueImport.test('import type { PublishedBody } from "./snapshot-store";')).toBe(false);
    expect(typeImport.test('import type { PublishedBody } from "./snapshot-store";')).toBe(true);
  });

  it("accepts and refuses the format-1 matrix without rewriting fixture bytes", async () => {
    const { openFoundationStore } = await import("../../src/lib/session/snapshot-store");
    const rows = matrix();
    expect(rows.map((row) => row.id)).toEqual(expectedIds());
    const retained: unknown[] = [];
    for (const row of rows) {
      const directory = fixture(row.bytes);
      try {
        const opened = await openFoundationStore(directory, KEY);
        if (row.accept) {
          expect(opened.status, row.id).toBe("ready");
          if (opened.status !== "ready") continue;
          retained.push(opened.value);
          const published = opened.value.readPublished();
          expect(published.status, row.id).toBe("ready");
          if (published.status !== "ready") continue;
          const file = JSON.parse(row.bytes.toString("utf8"));
          // Format-1 files are served upgraded with empty conversations and selections; checksum and bytes are unchanged.
          // Format-1 drafts gain the pending flag by the format-1 contract's definition of a pending interpretation.
          const drafts = file.body.drafts.map((draft: Record<string, unknown>) => ({
            ...draft,
            interpretationPending:
              draft.interpretationClaimVersion !== null && draft.interpretationClaimVersion === draft.version && draft.notice === null && draft.confirmedUse === null && draft.recommendationClaim === null,
          }));
          expect(canonicalJson(published.value), row.id).toBe(canonicalJson({ ...file, body: { ...file.body, drafts, conversations: [], selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] } }));
          if (row.id === "F16") expect(stalenessDetectedByChecksum).toBe(false);
        } else {
          expect(opened.status, row.id).toBe("unavailable");
        }
        expect(fs.readFileSync(join(directory, "store.json")).equals(row.bytes), row.id).toBe(true);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    expect(retained.length).toBeGreaterThan(0);
  }, 180_000);

  it("leaves the published body in place when a temporary write fails", async () => {
    const { openFoundationStore } = await import("../../src/lib/session/snapshot-store");
    const original = pack(baseBody());
    const directory = fixture(original);
    const opened = await openFoundationStore(directory, KEY, {
      temporaryWrite: async () => {
        throw new Error("temporary-write");
      },
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    const before = opened.value.readPublished();
    const failed = await opened.value.commit(writing(current(bodyWith([session(1)], []))));
    expect(failed).toEqual({ status: "unavailable", outcome: "definite" });
    expect(canonicalJson(opened.value.readPublished())).toBe(canonicalJson(before));
    expect(fs.readFileSync(join(directory, "store.json")).equals(original)).toBe(true);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("store.json.tmp."))).toEqual([]);
    expect(fs.existsSync(join(directory, "writer.lock"))).toBe(true);
  });

  it("publishes the owned commit when the caller mutates the submitted object", async () => {
    const { openFoundationStore } = await import("../../src/lib/session/snapshot-store");
    const directory = fixture(pack(baseBody()));
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let flushes = 0;
    const opened = await openFoundationStore(directory, KEY, {
      directoryFsync: async (fd) => {
        flushes += 1;
        if (flushes === 1) await firstGate;
        await new Promise<void>((resolve, reject) => fs.fsync(fd, (error) => (error ? reject(error) : resolve())));
      },
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    try {
      const firstCommit = opened.value.commit(writing(current(baseBody())));
      const started = Date.now();
      while (flushes !== 1) {
        if (Date.now() - started > 2000) throw new Error("the first commit did not reach the queue barrier");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const record = session(1);
      const line = item(1, { title: "nested title" });
      const advice = recommendation([line]);
      const nested = draft(record.id, 1, confirmedPatch(advice));
      const submitted = writing(current(bodyWith([record], [nested])));
      const expected = canonicalJson(submitted);
      const secondCommit = opened.value.commit(submitted);
      record.id = `ses_${"c".repeat(32)}`;
      nested.shopperText = "mutated while queued";
      advice.assistantMessage = "mutated message";
      line.title = "mutated title";
      expect(canonicalJson(submitted)).not.toBe(expected);
      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([firstCommit, secondCommit]);
      expect(firstResult.status).toBe("ready");
      expect(secondResult.status).toBe("ready");
      record.tokenDigest = "d".repeat(64);
      nested.shopperText = "mutated after publish";
      line.title = "mutated after publish";
      const published = opened.value.readPublished();
      expect(published.status).toBe("ready");
      if (published.status !== "ready" || secondResult.status !== "ready") return;
      expect(canonicalJson(published.value.body)).toBe(expected);
      expect(published.value.sha256).toBe(checksum(published.value.body));
      expect(canonicalJson(published.value)).toBe(canonicalJson(secondResult.value));
      const stored = JSON.parse(fs.readFileSync(join(directory, "store.json"), "utf8")) as { sha256: string; body: unknown };
      expect(canonicalJson(stored.body)).toBe(expected);
      expect(stored.sha256).toBe(published.value.sha256);
      const seen = opened.value.readPublished();
      expect(seen.status).toBe("ready");
      if (seen.status !== "ready") return;
      const body: PublishedBody = seen.value.body;
      if (!exposesOwnedRead(body)) throw new Error("published snapshot is missing the nested fields");
      body.drafts[0].shopperText = "mutated through the read result";
      body.sessions[0].id = `ses_${"e".repeat(32)}`;
      const publishedRecommendation = body.drafts[0].recommendation;
      if (publishedRecommendation === null) throw new Error("published snapshot is missing the nested fields");
      publishedRecommendation.recommendations[0].title = "mutated through the read result";
      const again = opened.value.readPublished();
      expect(again.status).toBe("ready");
      if (again.status !== "ready") return;
      expect(again.value).not.toBe(seen.value);
      expect(again.value.body).not.toBe(seen.value.body);
      expect(again.value.body.drafts).not.toBe(seen.value.body.drafts);
      expect(again.value.body.drafts[0]).not.toBe(seen.value.body.drafts[0]);
      expect(canonicalJson(again.value.body)).toBe(expected);
      expect(canonicalJson(again.value)).toBe(canonicalJson(published.value));
    } finally {
      releaseFirst();
    }
  });

  it("serves nothing and touches no filesystem after an uncertain commit", async () => {
    const saved = {
      readFileSync: fs.readFileSync,
      readdirSync: fs.readdirSync,
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      chmodSync: fs.chmodSync,
    };
    const probeDirectory = saved.mkdirSync(join(tmpdir(), `sa-probe-${Date.now()}`), { recursive: true }) as string;
    const probe = await fs.promises.open(join(probeDirectory, "probe"), "w");
    const handlePrototype = Object.getPrototypeOf(probe) as object;
    await probe.close();
    const counts = new Map<string, number>();
    const restores: Array<() => void> = [];
    wrapFunctions("fs", fs, counts, restores);
    wrapFunctions("fs.promises", fs.promises, counts, restores);
    wrapFunctions("fs-ext", fsExt, counts, restores);
    wrapFunctions("FileHandle", handlePrototype, counts, restores);
    wrapHandleClose(fs.promises, counts, restores);
    const required = ["fs.lstat", "fs.fstat", "fs-ext.flock", "fs-ext.flockSync", "FileHandle.read", "FileHandle.write", "FileHandle.close", "FileHandle.stat", "FileHandle.sync", "FileHandle.datasync"];
    for (const name of required) expect(counts.has(name), name).toBe(true);
    try {
      vi.resetModules();
      const { openFoundationStore } = await import("../../src/lib/session/snapshot-store");
      const previous = current(baseBody());
      const candidate = writing(current(bodyWith([session(1, { id: "ses_" + "a".repeat(32) })], [])));
      const third = writing(current(bodyWith([session(2)], [])));
      const directory = saved.mkdirSync(join(tmpdir(), `sa-fault-${Date.now()}`), { recursive: true }) as string;
      saved.chmodSync(directory, 0o700);
      const storePath = join(directory, "store.json");
      saved.writeFileSync(storePath, pack2(previous), { mode: 0o600 });
      saved.chmodSync(storePath, 0o600);
      const opened = await openFoundationStore(directory, KEY, {
        directoryFsync: async () => {
          throw new Error("directory-flush");
        },
      });
      expect(opened.status).toBe("ready");
      if (opened.status !== "ready") return;
      const committed = await opened.value.commit(candidate);
      expect(committed).toEqual({ status: "unavailable", outcome: "indeterminate" });
      const baselineBytes = saved.readFileSync(storePath);
      const baseline = new Map(counts);
      const read = opened.value.readPublished();
      const afterRead = new Map(counts);
      const written = await opened.value.commit(third);
      const afterWrite = new Map(counts);
      expect(read.status).toBe("unavailable");
      expect(written).toEqual({ status: "unavailable", outcome: "indeterminate" });
      expect(sameCounts(afterRead, baseline), countDiff(baseline, afterRead)).toBe(true);
      expect(sameCounts(afterWrite, baseline), countDiff(baseline, afterWrite)).toBe(true);
      expect(saved.readFileSync(storePath).equals(baselineBytes)).toBe(true);
      expect(saved.readdirSync(directory).filter((name) => name.startsWith("store.json.tmp."))).toEqual([]);
      expect(canonicalJson(candidate)).not.toBe(canonicalJson(previous));
      expect(canonicalJson(third)).not.toBe(canonicalJson(candidate));
      fs.rmSync(directory, { recursive: true, force: true });
    } finally {
      for (const restore of restores.reverse()) restore();
      fs.rmSync(probeDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("reopens one whole snapshot after the writing process has exited", async () => {
    const previous = current(bodyWith([session(4)], [draft(session(4).id)]));
    // Format 4 stays on disk. The served body adds an empty profile list and does not rewrite the file.
    const served = { ...previous, profiles: [], profileRevisions: [], chargerTracks: [] };
    const failed = fixture(pack2(previous));
    const failedKey = writeKey(failed);
    const failedChild = spawnChild("failed-write", failed, failedKey);
    const failedHash = await failedChild.output;
    expect(await failedChild.finish()).toBe(0);
    expect(failedHash).toBe(checksum(served));
    expect(await reopen(failed, checksum(served))).toBe(checksum(served));

    const renamed = fixture(pack2(previous));
    const renamedKey = writeKey(renamed);
    const renamedChild = spawnChild("uncertain", renamed, renamedKey);
    const renamedHash = await renamedChild.output;
    expect(await renamedChild.finish()).toBe(0);
    expect(renamedHash).not.toBe(checksum(previous));
    expect(await reopen(renamed, renamedHash ?? "")).toBe(renamedHash);
  }, 30_000);

  it("stops on a lock symlink, a 0644 lock, and a directory at the lock path", async () => {
    const { openFoundationStore } = await import("../../src/lib/session/snapshot-store");
    const symlinkDirectory = privateDirectory();
    const target = join(symlinkDirectory, "target");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, join(symlinkDirectory, "link"));
    expect((await openFoundationStore(join(symlinkDirectory, "link"), KEY)).status).toBe("unavailable");
    expect(fs.lstatSync(join(symlinkDirectory, "link")).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);

    const modeDirectory = fixture(pack(baseBody()));
    fs.writeFileSync(join(modeDirectory, "writer.lock"), "", { mode: 0o644 });
    fs.chmodSync(join(modeDirectory, "writer.lock"), 0o644);
    expect((await openFoundationStore(modeDirectory, KEY)).status).toBe("unavailable");
    expect(fs.statSync(join(modeDirectory, "writer.lock")).isFile()).toBe(true);
    expect(fs.statSync(join(modeDirectory, "writer.lock")).mode & 0o777).toBe(0o644);

    const directoryLock = fixture(pack(baseBody()));
    fs.mkdirSync(join(directoryLock, "writer.lock"), { mode: 0o700 });
    expect((await openFoundationStore(directoryLock, KEY)).status).toBe("unavailable");
    expect(fs.statSync(join(directoryLock, "writer.lock")).isDirectory()).toBe(true);

    const lockLink = fixture(pack(baseBody()));
    fs.writeFileSync(join(lockLink, "elsewhere"), "");
    fs.symlinkSync("elsewhere", join(lockLink, "writer.lock"));
    expect((await openFoundationStore(lockLink, KEY)).status).toBe("unavailable");
    expect(fs.lstatSync(join(lockLink, "writer.lock")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(lockLink, "store.json")).equals(pack(baseBody()))).toBe(true);
  });

  it("receives EAGAIN from a live holder and keeps a renamed lock inode", async () => {
    expect(RACE).toContain("macOS can reuse a pid");
    const directory = fixture(pack(baseBody()));
    const keyFile = writeKey(directory);
    const holder = spawnChild("hold", directory, keyFile);
    let contender: ReturnType<typeof spawnChild> | null = null;
    let mismatch: ReturnType<typeof spawnChild> | null = null;
    try {
      expect(await holder.ready).not.toBeNull();
      contender = spawnChild("contend", directory, keyFile);
      const output = await contender.output;
      const alive = readIdentity(holder.child.pid ?? -1);
      expect(alive && sameIdentity(alive, holder.identity)).toBe(true);
      expect(process.kill(holder.child.pid ?? -1, 0)).toBe(true);
      expect(output).toBe("EAGAIN");
      expect(await contender.finish()).toBe(0);
      holder.release();
      expect(await holder.finish()).toBe(0);
      mismatch = spawnChild("mismatch", directory, keyFile);
      expect(await mismatch.ready).not.toBeNull();
      const locked = fs.statSync(join(directory, "writer.lock"));
      fs.renameSync(join(directory, "writer.lock"), join(directory, "writer.lock.moved"));
      mismatch.release();
      expect(await mismatch.finish()).toBe(0);
      const moved = fs.statSync(join(directory, "writer.lock.moved"));
      expect(moved.ino).toBe(locked.ino);
      expect(moved.dev).toBe(locked.dev);
      expect(fs.existsSync(join(directory, "writer.lock"))).toBe(false);
    } finally {
      if (contender) await contender.finish();
      if (mismatch) {
        mismatch.release();
        await mismatch.finish();
      }
      holder.release();
      await holder.finish();
    }
  }, 30_000);

  it("does not create a missing directory or the first store file", async () => {
    const { openFoundationStore } = await import("../../src/lib/session/snapshot-store");
    const missing = join(tmpdir(), `sa-missing-${Date.now()}-${randomBytes(4).toString("hex")}`);
    expect((await openFoundationStore(missing, KEY)).status).toBe("unavailable");
    expect(fs.existsSync(missing)).toBe(false);
    const directory = privateDirectory();
    expect((await openFoundationStore(directory, KEY)).status).toBe("unavailable");
    expect(fs.existsSync(join(directory, "store.json"))).toBe(false);
  });
});

const stalenessDetectedByChecksum = false;

function matrix(): Array<{ id: string; accept: boolean; bytes: Buffer }> {
  const row = (id: string, accept: boolean, bytes: Buffer) => ({ id, accept, bytes });
  const sessionId = session(1).id;
  const withDraft = (patch: Record<string, unknown> = {}, draftPatch: Record<string, unknown> = {}) => bodyWith([session(1, patch)], [draft(sessionId, 1, draftPatch)]);
  const completedBody = (recommendation: unknown, draftPatch: Record<string, unknown> = {}) =>
    bodyWith([session(1)], [draft(sessionId, 1, { confirmedUse: "schoolwork", confirmedBudgetDollars: "500", recommendationClaim: "completed", recommendation, ...draftPatch })]);
  return [
    row("E01", true, pack(withDraft({}, { shopperText: "café" }))),
    row("E02", false, corruptUtf8(pack(baseBody()))),
    row("E03", true, pack(baseBody())),
    row("E04", false, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), pack(baseBody())])),
    row("E05", true, pack(baseBody())),
    row("E06", true, Buffer.concat([pack(baseBody()), Buffer.from("\n")])),
    row("E07", false, Buffer.concat([pack(baseBody()), Buffer.from("x")])),
    row("E08", false, Buffer.concat([pack(baseBody()), Buffer.from(" 0")])),
    row("E09", false, raw(pack(baseBody()), `{"format":1,`, `{"format":1,"format":2,`)),
    row("E10", false, raw(pack(baseBody()), `"sessions":[]`, `"sessions":[],"sessions":[1]`)),
    row("E11", false, raw(pack(baseBody()), `"allocation":{"windowStartedAt":null,"count":0}`, `"allocation":{"windowStartedAt":null,"count":0,"count":1}`)),
    row("E12", false, raw(pack(baseBody()), `"admissionLogin":{"windowStartedAt":null,"count":0}`, `"admissionLogin":{"windowStartedAt":null,"count":0,"count":1}`)),
    row("E13", false, raw(pack(withDraft()), `"id":"${sessionId}"`, `"id":"${sessionId}","id":"ses_${"b".repeat(32)}"`)),
    row("E14", false, raw(pack(withDraft()), `"version":1`, `"version":1,"version":2`)),
    row("E15", false, raw(pack(completedBody(recommendation([item(1)]))), `"assistantMessage":"ok"`, `"assistantMessage":"ok","assistantMessage":"no"`)),
    row("E16", false, raw(pack(completedBody(recommendation([item(1)]))), `"currency":"USD"`, `"currency":"USD","currency":"EUR"`)),
    row("E17", true, pack(baseBody())),
    row("E18", true, pad(pack(baseBody()), 8 * 1024 * 1024)),
    row("E19", false, pad(pack(baseBody()), 8 * 1024 * 1024 + 1)),
    row("E20", false, Buffer.alloc(0)),
    row("E21", false, Buffer.from("not-json")),
    row("F01", true, pack(baseBody())),
    row("F02", false, envelope(baseBody(), { format: 0 })),
    row("F03", false, envelope(baseBody(), { format: 2 })),
    row("F04", false, envelope(baseBody(), { format: "1" })),
    row("F05", false, envelope(baseBody(), { format: true })),
    row("F06", true, raw(pack(baseBody()), `{"format":1,`, `{"format":1.0,`)),
    row("F07", true, pack(baseBody())),
    row("F08", false, envelope(baseBody(), { identity: identityFor(OTHER_KEY) })),
    row("F09", false, envelope(baseBody(), { identity: identityFor(KEY).toUpperCase() })),
    row("F10", false, envelope(baseBody(), { identity: identityFor(KEY).slice(0, 63) })),
    row("F11", false, envelope(baseBody(), { identity: `${identityFor(KEY)}a` })),
    row("F12", false, envelope(baseBody(), { identity: `${identityFor(KEY).slice(0, 63)}g` })),
    row("F13", true, pack(baseBody())),
    row("F14", false, envelope(baseBody(), { sha256: flip(checksum(baseBody())) })),
    row("F15", false, envelope(baseBody(), { sha256: createHash("sha256").update(identityFor(KEY), "utf8").digest("hex") })),
    row("F16", true, pack(withDraft({}, { shopperText: "older" }))),
    row("F17", false, envelope(baseBody(), { sha256: checksum(baseBody()).toUpperCase() })),
    row("F18", false, envelope(baseBody(), {}, ["format"])),
    row("F19", false, envelope(baseBody(), {}, ["identity"])),
    row("F20", false, envelope(baseBody(), {}, ["sha256"])),
    row("F21", false, envelope(baseBody(), {}, ["body"])),
    row("F22", false, envelope(baseBody(), { extra: true })),
    row("F23", false, pack(omit(baseBody(), "allocation"))),
    row("F24", false, pack(omit(baseBody(), "admissionLogin"))),
    row("F25", false, pack(omit(baseBody(), "sessions"))),
    row("F26", false, pack(omit(baseBody(), "drafts"))),
    row("F27", false, pack({ ...baseBody(), checkout: [] })),
    row("F28", false, pack(baseBody({ allocation: omit({ windowStartedAt: null, count: 0 }, "windowStartedAt") }))),
    row("F29", false, pack(baseBody({ allocation: omit({ windowStartedAt: null, count: 0 }, "count") }))),
    row("F30", false, pack(baseBody({ allocation: { windowStartedAt: null, count: 0, windowMs: 1 } }))),
    row("F31", false, pack(baseBody({ admissionLogin: omit({ windowStartedAt: null, count: 0 }, "windowStartedAt") }))),
    row("F32", false, pack(baseBody({ admissionLogin: omit({ windowStartedAt: null, count: 0 }, "count") }))),
    row("F33", false, pack(baseBody({ admissionLogin: { windowStartedAt: null, count: 0, limit: 1 } }))),
    row("F34", false, pack(bodyWith([omit(session(1), "id")], []))),
    row("F35", false, pack(bodyWith([omit(session(1), "tokenDigest")], []))),
    row("F36", false, pack(bodyWith([omit(session(1), "createdAt")], []))),
    row("F37", false, pack(bodyWith([omit(session(1), "lastSeenAt")], []))),
    row("F38", false, pack(bodyWith([omit(session(1), "absoluteExpiresAt")], []))),
    row("F39", false, pack(bodyWith([omit(session(1), "revokedAt")], []))),
    row("F40", false, pack(bodyWith([{ ...session(1), token: "raw" }], []))),
    row("F41", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "sessionId")]))),
    row("F42", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "draftId")]))),
    row("F43", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "version")]))),
    row("F44", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "language")]))),
    row("F45", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "shopperText")]))),
    row("F46", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "prefilledUse")]))),
    row("F47", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "prefilledBudgetDollars")]))),
    row("F48", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "confirmedUse")]))),
    row("F49", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "confirmedBudgetDollars")]))),
    row("F50", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "interpretationClaimVersion")]))),
    row("F51", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "recommendationClaim")]))),
    row("F52", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "recommendation")]))),
    row("F53", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "notice")]))),
    row("F54", false, pack(bodyWith([session(1)], [omit(draft(sessionId), "expiresAtMs")]))),
    row("F55", false, pack(bodyWith([session(1)], [{ ...draft(sessionId), csrf: "no" }]))),
    row("F56", false, pack(baseBody({ allocation: { windowStartedAt: 0, count: "0" } }))),
    row("F57", false, pack(baseBody({ allocation: { windowStartedAt: 0, count: true } }))),
    row("W01", true, pack(baseBody())),
    row("W02", false, pack(baseBody({ allocation: { windowStartedAt: null, count: 1 } }))),
    row("W03", true, pack(baseBody({ allocation: { windowStartedAt: 0, count: 0 } }))),
    row("W04", true, pack(baseBody({ allocation: { windowStartedAt: 1, count: 30 } }))),
    row("W05", false, pack(baseBody({ allocation: { windowStartedAt: 1, count: 31 } }))),
    row("W06", false, pack(baseBody({ allocation: { windowStartedAt: 0, count: -1 } }))),
    row("W07", true, pack(baseBody({ allocation: { windowStartedAt: 0, count: 0 } }))),
    row("W08", true, pack(baseBody({ allocation: { windowStartedAt: MAX_SAFE, count: 0 } }))),
    row("W09", false, pack(baseBody({ allocation: { windowStartedAt: -1, count: 0 } }))),
    row("W10", false, pack(baseBody({ allocation: { windowStartedAt: MAX_SAFE + 1, count: 0 } }))),
    row("W11", false, pack(baseBody({ allocation: { windowStartedAt: "0", count: 0 } }))),
    row("W12", true, raw(pack(baseBody({ allocation: { windowStartedAt: 1, count: 30 } })), `"allocation":{"windowStartedAt":1,"count":30}`, `"allocation":{"windowStartedAt":1,"count":30.0}`)),
    row("W13", true, raw(pack(baseBody({ allocation: { windowStartedAt: 1, count: 30 } })), `"allocation":{"windowStartedAt":1,"count":30}`, `"allocation":{"windowStartedAt":1,"count":3e1}`)),
    row("W14", true, pack(baseBody())),
    row("W15", false, pack(baseBody({ admissionLogin: { windowStartedAt: null, count: 1 } }))),
    row("W16", true, pack(baseBody({ admissionLogin: { windowStartedAt: 0, count: 0 } }))),
    row("W17", true, pack(baseBody({ admissionLogin: { windowStartedAt: 1, count: 31 } }))),
    row("W18", true, pack(baseBody({ admissionLogin: { windowStartedAt: 1, count: MAX_SAFE } }))),
    row("W19", false, pack(baseBody({ admissionLogin: { windowStartedAt: 1, count: MAX_SAFE + 1 } }))),
    row("W20", false, pack(baseBody({ admissionLogin: { windowStartedAt: 0, count: -1 } }))),
    row("W21", false, pack(baseBody({ admissionLogin: { windowStartedAt: "0", count: 0 } }))),
    row("W22", true, raw(pack(baseBody({ admissionLogin: { windowStartedAt: 1, count: 1 } })), `"admissionLogin":{"windowStartedAt":1,"count":1}`, `"admissionLogin":{"windowStartedAt":1,"count":1.0}`)),
    row("S01", true, pack(baseBody())),
    row("S02", true, pack(bodyWith(sessions(500), []))),
    row("S03", false, pack(bodyWith(sessions(501), []))),
    row("S04", true, pack(bodyWith([session(1)], []))),
    row("S05", true, pack(bodyWith(sessions(500), sessions(500).map((item, index) => draft(item.id, index + 1))))),
    row("S06", false, pack(bodyWith(sessions(501), sessions(501).map((item, index) => draft(item.id, index + 1))))),
    row("S07", false, pack(bodyWith([session(1)], [draft(sessionId, 1), draft(sessionId, 2)]))),
    row("S08", false, pack(bodyWith([session(1)], [draft("ses_" + "9".repeat(32))]))),
    row("S09", false, pack(bodyWith([session(1), session(2, { id: sessionId })], []))),
    row("S10", false, pack(bodyWith([session(1), session(2, { tokenDigest: session(1).tokenDigest })], []))),
    row("S11", true, pack(bodyWith([session(1), session(2)], []))),
    row("S12", true, pack(bodyWith([session(1, { id: `ses_${"0".repeat(32)}` }), session(2, { id: `ses_${"f".repeat(32)}` })], []))),
    row("S13", false, pack(bodyWith([session(1, { id: `ses_${"a".repeat(31)}` })], []))),
    row("S14", false, pack(bodyWith([session(1, { id: `ses_${"a".repeat(33)}` })], []))),
    row("S15", false, pack(bodyWith([session(1, { id: `ses_${"A".repeat(32)}` })], []))),
    row("S16", false, pack(bodyWith([session(1, { id: `nd_${"0".repeat(32)}` })], []))),
    row("S17", true, pack(bodyWith([session(1)], []))),
    row("S18", false, pack(bodyWith([session(1, { tokenDigest: "a".repeat(63) })], []))),
    row("S19", false, pack(bodyWith([session(1, { tokenDigest: "a".repeat(65) })], []))),
    row("S20", false, pack(bodyWith([session(1, { tokenDigest: "A".repeat(64) })], []))),
    row("S21", true, pack(bodyWith([session(1), session(2)], [draft(sessionId, 1, { draftId: `nd_${"0".repeat(32)}` }), draft(session(2).id, 2, { draftId: `nd_${"f".repeat(32)}` })]))),
    row("S22", false, pack(bodyWith([session(1)], [draft(sessionId, 1, { draftId: `nd_${"a".repeat(31)}` })]))),
    row("S23", false, pack(bodyWith([session(1)], [draft(sessionId, 1, { draftId: `nd_${"a".repeat(33)}` })]))),
    row("S24", false, pack(bodyWith([session(1)], [draft(sessionId, 1, { draftId: `nd_${"A".repeat(32)}` })]))),
    row("S25", false, pack(bodyWith([session(1)], [draft(sessionId, 1, { draftId: `ses_${"0".repeat(32)}` })]))),
    row("S26", true, pack(bodyWith([session(1), session(2, stamp("2026-01-01T00:00:00.999Z"))], []))),
    row("S27", false, pack(bodyWith([session(1, { createdAt: "2026-01-01T00:00:00Z" })], []))),
    row("S28", false, pack(bodyWith([session(1, { createdAt: "2026-01-01T00:00:00.000+00:00" })], []))),
    row("S29", false, pack(bodyWith([session(1, { createdAt: "2026-02-31T00:00:00.000Z" })], []))),
    row("S30", true, pack(bodyWith([session(1)], []))),
    row("S31", false, pack(bodyWith([session(1, { absoluteExpiresAt: new Date(CREATED_MS + 86_399_999).toISOString() })], []))),
    row("S32", false, pack(bodyWith([session(1, { absoluteExpiresAt: new Date(CREATED_MS + 86_400_001).toISOString() })], []))),
    row("S33", true, pack(bodyWith([session(1, { lastSeenAt: CREATED })], []))),
    row("S34", true, pack(bodyWith([session(1, { lastSeenAt: ABSOLUTE })], []))),
    row("S35", false, pack(bodyWith([session(1, { lastSeenAt: new Date(CREATED_MS - 1).toISOString() })], []))),
    row("S36", false, pack(bodyWith([session(1, { lastSeenAt: new Date(CREATED_MS + 86_400_001).toISOString() })], []))),
    row("S37", true, pack(bodyWith([session(1, { revokedAt: null })], []))),
    row("S38", true, pack(bodyWith([session(1, { revokedAt: CREATED })], []))),
    row("S39", true, pack(bodyWith([session(1, { revokedAt: new Date(CREATED_MS + 86_400_001).toISOString() })], []))),
    row("S40", false, pack(bodyWith([session(1, { revokedAt: new Date(CREATED_MS - 1).toISOString() })], []))),
    row("D01", true, pack(withDraft({}, { version: 1 }))),
    row("D02", true, pack(withDraft({}, { version: 999_999_999 }))),
    row("D03", false, pack(withDraft({}, { version: 0 }))),
    row("D04", false, pack(withDraft({}, { version: 1_000_000_000 }))),
    row("D05", false, pack(withDraft({}, { version: -1 }))),
    row("D06", true, raw(pack(withDraft()), `"version":1`, `"version":1.0`)),
    row("D07", false, pack(withDraft({}, { version: "1" }))),
    row("D08", true, pack(bodyWith([session(1), session(2)], [draft(sessionId, 1, { language: "en" }), draft(session(2).id, 2, { language: "es" })]))),
    row("D09", false, pack(withDraft({}, { language: "EN" }))),
    row("D10", false, pack(withDraft({}, { language: "fr" }))),
    row("D11", false, pack(withDraft({}, { language: "" }))),
    row("D12", true, pack(withDraft({}, { shopperText: "" }))),
    row("D13", true, pack(withDraft({}, { shopperText: "a".repeat(2000) }))),
    row("D14", false, pack(withDraft({}, { shopperText: "a".repeat(2001) }))),
    row("D15", true, pack(bodyWith([session(1), session(2), session(3)], ["programming", "schoolwork", "general_productivity"].map((use, index) => draft([session(1), session(2), session(3)][index]!.id, index + 1, { prefilledUse: use }))))),
    row("D16", true, pack(withDraft({}, { prefilledUse: null, prefilledBudgetDollars: null }))),
    row("D17", true, pack(withDraft({}, { prefilledUse: "programming", prefilledBudgetDollars: null }))),
    row("D18", true, pack(withDraft({}, { prefilledUse: null, prefilledBudgetDollars: "500" }))),
    row("D19", false, pack(withDraft({}, { prefilledUse: "work" }))),
    row("D20", true, pack(withDraft({}, { confirmedUse: null, confirmedBudgetDollars: null }))),
    row("D21", true, pack(withDraft({}, { confirmedUse: "schoolwork", confirmedBudgetDollars: "500" }))),
    row("D22", false, pack(withDraft({}, { confirmedUse: "schoolwork", confirmedBudgetDollars: null }))),
    row("D23", false, pack(withDraft({}, { confirmedUse: null, confirmedBudgetDollars: "500" }))),
    row("D24", true, pack(bodyWith([session(1), session(2), session(3)], ["10", "500", "99999"].map((budget, index) => draft([session(1), session(2), session(3)][index]!.id, index + 1, { prefilledBudgetDollars: budget }))))),
    row("D25", false, pack(withDraft({}, { prefilledBudgetDollars: "1" }))),
    row("D26", false, pack(withDraft({}, { prefilledBudgetDollars: "9" }))),
    row("D27", false, pack(withDraft({}, { prefilledBudgetDollars: "01" }))),
    row("D28", false, pack(withDraft({}, { prefilledBudgetDollars: "100000" }))),
    row("D29", false, pack(withDraft({}, { prefilledBudgetDollars: "0" }))),
    row("D30", true, pack(withDraft({}, { interpretationClaimVersion: null }))),
    row("D31", true, pack(withDraft({}, { version: 2, interpretationClaimVersion: 2 }))),
    row("D32", false, pack(withDraft({}, { version: 2, interpretationClaimVersion: 1 }))),
    row("D33", true, pack(withDraft({}, { interpretationClaimVersion: 1, notice: null, confirmedUse: null, confirmedBudgetDollars: null, recommendationClaim: null, recommendation: null }))),
    row("D34", true, pack(withDraft({}, { interpretationClaimVersion: 1, notice: "review" }))),
    row("D35", true, pack(withDraft({}, { interpretationClaimVersion: 1, prefilledUse: "schoolwork", prefilledBudgetDollars: null }))),
    row("D36", true, pack(withDraft({}, { recommendationClaim: null, recommendation: null }))),
    row("D37", false, pack(withDraft({}, { confirmedUse: "schoolwork", confirmedBudgetDollars: "500", recommendationClaim: null, recommendation: recommendation([]) }))),
    row("D38", true, pack(withDraft({}, { confirmedUse: "schoolwork", confirmedBudgetDollars: "500", recommendationClaim: "pending", recommendation: null }))),
    row("D39", false, pack(withDraft({}, { recommendationClaim: "pending", recommendation: null }))),
    row("D40", false, pack(withDraft({}, { confirmedUse: "schoolwork", confirmedBudgetDollars: "500", recommendationClaim: "pending", recommendation: recommendation([]) }))),
    row("D41", true, pack(withDraft({}, { confirmedUse: "schoolwork", confirmedBudgetDollars: "500", recommendationClaim: "failed", recommendation: null }))),
    row("D42", false, pack(withDraft({}, { confirmedUse: "schoolwork", confirmedBudgetDollars: "500", recommendationClaim: "failed", recommendation: recommendation([]) }))),
    row("D43", false, pack(withDraft({}, { recommendationClaim: "failed", recommendation: null }))),
    row("D44", true, pack(completedBody(recommendation([])))),
    row("D45", false, pack(withDraft({}, { confirmedUse: "schoolwork", confirmedBudgetDollars: "500", recommendationClaim: "completed", recommendation: null }))),
    row("D46", false, pack(withDraft({}, { recommendationClaim: "completed", recommendation: recommendation([]) }))),
    row("D47", false, pack(withDraft({}, { confirmedUse: "schoolwork", confirmedBudgetDollars: "500", recommendationClaim: "done", recommendation: null }))),
    row("D48", true, pack(bodyWith(sessions(7), [null, "malformed", "missing_use", "missing_budget", "ambiguous", "review", "unavailable"].map((notice, index) => draft(sessions(7)[index]!.id, index + 1, { notice }))))),
    row("D49", false, pack(withDraft({}, { notice: "error" }))),
    row("D50", true, pack(bodyWith([session(1), session(2)], [draft(sessionId, 1, { expiresAtMs: 0 }), draft(session(2).id, 2, { expiresAtMs: MAX_SAFE })]))),
    row("D51", false, pack(withDraft({}, { expiresAtMs: null }))),
    row("D52", false, pack(withDraft({}, { expiresAtMs: -1 }))),
    row("D53", false, pack(withDraft({}, { expiresAtMs: MAX_SAFE + 1 }))),
    row("D54", false, pack(withDraft({}, { expiresAtMs: "0" }))),
    row("D55", true, pack(completedBody(recommendation([], null)))),
    row("D56", true, pack(bodyWith([session(1), session(2)], [1, 1200].map((length, index) => draft([session(1), session(2)][index]!.id, index + 1, confirmedPatch(recommendation([], "m".repeat(length)))))))),
    row("D57", false, pack(completedBody(recommendation([], "")))),
    row("D58", false, pack(completedBody(recommendation([], "m".repeat(1201))))),
    row("D59", true, pack(completedBody(recommendation([], "\t")))),
    row("D60", false, pack(completedBody(recommendation([], "\u0001")))),
    row("D61", false, pack(completedBody(recommendation([], "\u007f")))),
    row("D62", true, pack(bodyWith([session(1), session(2)], [draft(sessionId, 1, confirmedPatch(recommendation([]))), draft(session(2).id, 2, confirmedPatch(recommendation(Array.from({ length: 30 }, (_, index) => item(index + 1)))))]))),
    row("D63", false, pack(completedBody(recommendation(Array.from({ length: 31 }, (_, index) => item(index + 1)))))),
    row("D64", true, pack(completedBody(recommendation([item(1, { productId: "dmp_" + "a".repeat(6) }), item(2, { productId: "dmp_" + "b".repeat(24) })])))),
    row("D65", false, pack(completedBody(recommendation([item(1, { productId: "dmp_" + "a".repeat(5) })])))),
    row("D66", false, pack(completedBody(recommendation([item(1, { productId: "dmp_" + "a".repeat(25) })])))),
    row("D67", false, pack(completedBody(recommendation([item(1, { productId: "dmp_" + "A".repeat(6) }), item(2, { productId: "ext_" + "a".repeat(6) })])))),
    row("D68", true, pack(completedBody(recommendation([item(1, { variantId: "dmv_" + "a".repeat(6) }), item(2, { variantId: "dmv_" + "b".repeat(24) })])))),
    row("D69", false, pack(completedBody(recommendation([item(1, { variantId: "dmv_" + "a".repeat(5) }), item(2, { variantId: "dmv_" + "b".repeat(25) })])))),
    row("D70", false, pack(completedBody(recommendation([item(1, { variantId: "dmv_" + "A".repeat(6) }), item(2, { variantId: "dmp_" + "a".repeat(6) })])))),
    row("D71", true, pack(completedBody(recommendation([item(1, { productId: "dmp_sameprod", variantId: "dmv_varone1" }), item(2, { productId: "dmp_sameprod", variantId: "dmv_vartwo2" })])))),
    row("D72", false, pack(completedBody(recommendation([item(1), item(1)])))),
    row("D73", true, pack(completedBody(recommendation([item(1, { productId: "dmp_zznotcatalog01", variantId: "dmv_zznotcatalog01" })])))),
    row("D74", true, pack(completedBody(recommendation([item(1, { title: "t" }), item(2, { title: "t".repeat(120) })])))),
    row("D75", false, pack(completedBody(recommendation([item(1, { title: "" }), item(2, { title: "t".repeat(121) })])))),
    row("D76", true, pack(completedBody(recommendation([item(1, { label: "l" }), item(2, { label: "l".repeat(80) })])))),
    row("D77", false, pack(completedBody(recommendation([item(1, { label: "" }), item(2, { label: "l".repeat(81) })])))),
    row("D78", true, pack(completedBody(recommendation([item(1, { title: "\t" })])))),
    row("D79", false, pack(completedBody(recommendation([item(1, { title: "\u0001" })])))),
    row("D80", true, pack(completedBody(recommendation([item(1, { unitAmountCents: 1 }), item(2, { unitAmountCents: 2_000_000 })])))),
    row("D81", false, pack(completedBody(recommendation([item(1, { unitAmountCents: 0 })])))),
    row("D82", false, pack(completedBody(recommendation([item(1, { unitAmountCents: -1 })])))),
    row("D83", false, pack(completedBody(recommendation([item(1, { unitAmountCents: 2_000_001 })])))),
    row("D84", true, pack(completedBody(recommendation([item(1, { currency: "USD" })])))),
    row("D85", false, pack(completedBody(recommendation([item(1, { currency: "usd" })])))),
    row("D86", false, pack(completedBody(recommendation([item(1, { currency: "EUR" })])))),
    row("D87", false, pack(completedBody(omit(recommendation([item(1)]), "assistantMessage")))),
    row("D88", false, pack(completedBody(omit(recommendation([item(1)]), "recommendations")))),
    row("D89", false, pack(completedBody({ ...recommendation([item(1)]), status: "x" }))),
    row("D90", false, pack(completedBody(recommendation([omit(item(1), "productId")])))),
    row("D91", false, pack(completedBody(recommendation([omit(item(1), "variantId")])))),
    row("D92", false, pack(completedBody(recommendation([omit(item(1), "title")])))),
    row("D93", false, pack(completedBody(recommendation([omit(item(1), "label")])))),
    row("D94", false, pack(completedBody(recommendation([omit(item(1), "unitAmountCents")])))),
    row("D95", false, pack(completedBody(recommendation([omit(item(1), "currency")])))),
    row("D96", false, pack(completedBody(recommendation([{ ...item(1), availability: "x" }])))),
  ];
}

function exposesOwnedRead(body: PublishedBody): body is PublishedBody & {
  sessions: [{ id: string }, ...PublishedBody["sessions"]];
  drafts: [{
    shopperText: string;
    recommendation: {
      recommendations: [{ title: string }, ...NonNullable<PublishedBody["drafts"][number]["recommendation"]>["recommendations"]];
    };
  }, ...PublishedBody["drafts"]];
} {
  const session = body.sessions[0];
  const draft = body.drafts[0];
  const recommendation = draft?.recommendation;
  return session !== undefined && draft !== undefined && recommendation !== null && recommendation.recommendations[0] !== undefined;
}

function expectedIds(): string[] {
  return [...ids("E", 21), ...ids("F", 57), ...ids("W", 22), ...ids("S", 40), ...ids("D", 96)];
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`);
}

function baseBody(patch: Record<string, unknown> = {}) {
  return { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [], ...patch };
}

function bodyWith(sessions: unknown[], drafts: unknown[], patch: Record<string, unknown> = {}) {
  return { ...baseBody(), sessions, drafts, ...patch };
}

function session(n: number, patch: Record<string, unknown> = {}) {
  return { id: `ses_${n.toString(16).padStart(32, "0")}`, tokenDigest: (n + 8).toString(16).padStart(64, "0"), createdAt: CREATED, lastSeenAt: CREATED, absoluteExpiresAt: ABSOLUTE, revokedAt: null, ...patch };
}

function sessions(count: number) {
  return Array.from({ length: count }, (_, index) => session(index + 1));
}

function draft(sessionId: string, n = 1, patch: Record<string, unknown> = {}) {
  return {
    sessionId,
    draftId: `nd_${n.toString(16).padStart(32, "0")}`,
    version: 1,
    language: "en",
    shopperText: "",
    prefilledUse: null,
    prefilledBudgetDollars: null,
    confirmedUse: null,
    confirmedBudgetDollars: null,
    interpretationClaimVersion: null,
    recommendationClaim: null,
    recommendation: null,
    notice: null,
    expiresAtMs: 0,
    ...patch,
  };
}

function item(n: number, patch: Record<string, unknown> = {}) {
  return { productId: `dmp_${n.toString(16).padStart(6, "a")}`, variantId: `dmv_${n.toString(16).padStart(6, "b")}`, title: "t", label: "l", unitAmountCents: 1, currency: "USD", ...patch };
}

function recommendation(items: unknown[], assistantMessage: string | null = "ok") {
  return { assistantMessage, recommendations: items };
}

function confirmedPatch(recommendationValue: unknown) {
  return { confirmedUse: "schoolwork", confirmedBudgetDollars: "500", recommendationClaim: "completed", recommendation: recommendationValue };
}

function stamp(createdAt: string) {
  const created = Date.parse(createdAt);
  return { createdAt, lastSeenAt: createdAt, absoluteExpiresAt: new Date(created + 86_400_000).toISOString() };
}

function omit(value: object, key: string): Record<string, unknown> {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

/** A format-5 commit body: the format-4 shape plus an empty profile list. */
function writing(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, profiles: [], profileRevisions: [], chargerTracks: [] };
}

/** A format-2 body: the format-1 fields plus empty (or given) conversations and selections. */
function current(body: Record<string, unknown>, patch: Record<string, unknown> = {}) {
  const drafts = Array.isArray(body.drafts) ? body.drafts.map((draft) => ({ interpretationPending: false, ...(draft as Record<string, unknown>) })) : body.drafts;
  return { conversations: [], selections: [], grants: [], permissions: [], ...body, drafts, ...patch };
}

/** A file in the current write format (4). */
function pack2(body: unknown): Buffer {
  return Buffer.from(JSON.stringify({ format: 4, identity: identityFor(KEY), sha256: checksum(body), body }));
}

function pack(body: unknown): Buffer {
  return Buffer.from(JSON.stringify({ format: 1, identity: identityFor(KEY), sha256: checksum(body), body }));
}

function envelope(body: unknown, patch: Record<string, unknown>, drop: string[] = []): Buffer {
  const record: Record<string, unknown> = { format: 1, identity: identityFor(KEY), sha256: checksum(body), body, ...patch };
  for (const key of drop) delete record[key];
  return Buffer.from(JSON.stringify(record));
}

function raw(bytes: Buffer, from: string, to: string): Buffer {
  const text = bytes.toString("utf8");
  const index = text.indexOf(from);
  if (index < 0 || text.indexOf(from, index + from.length) >= 0) throw new Error(`raw replacement is not unique: ${from}`);
  return Buffer.from(text.slice(0, index) + to + text.slice(index + from.length));
}

function pad(bytes: Buffer, size: number): Buffer {
  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length, 0x20)]);
}

function corruptUtf8(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  copy[copy.length - 2] = 0xff;
  return copy;
}

function flip(hex: string): string {
  const last = hex.at(-1) === "a" ? "b" : "a";
  return hex.slice(0, -1) + last;
}

function identityFor(key: Buffer): string {
  return createHash("sha256").update(Buffer.concat([Buffer.from("shopaccess.mock-store.v1"), Buffer.from([0]), key])).digest("hex");
}

function checksum(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

function fixture(bytes: Buffer): string {
  const directory = privateDirectory();
  const file = join(directory, "store.json");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return directory;
}

function privateDirectory(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-snap-"));
  fs.chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

function writeKey(directory: string): string {
  const file = join(directory, "key");
  fs.writeFileSync(file, KEY, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function wrapHandleClose(target: object, counts: Map<string, number>, restores: Array<() => void>) {
  counts.set("FileHandle.close", 0);
  const descriptor = Object.getOwnPropertyDescriptor(target, "open");
  if (!descriptor || typeof descriptor.value !== "function") throw new Error("fs.promises.open is not wrapped");
  const original = descriptor.value as (...args: unknown[]) => Promise<{ close?: (...args: unknown[]) => unknown }>;
  const wrapped = async function (this: unknown, ...args: unknown[]) {
    const handle = await original.apply(this, args);
    if (handle && typeof handle.close === "function") {
      const close = handle.close;
      handle.close = function (this: unknown, ...closeArgs: unknown[]) {
        counts.set("FileHandle.close", (counts.get("FileHandle.close") ?? 0) + 1);
        return close.apply(this, closeArgs);
      };
    }
    return handle;
  };
  Object.defineProperty(target, "open", { ...descriptor, value: wrapped });
  restores.push(() => Object.defineProperty(target, "open", descriptor));
}

function wrapFunctions(label: string, target: object, counts: Map<string, number>, restores: Array<() => void>) {
  for (const key of Object.getOwnPropertyNames(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || key === "constructor") continue;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const name = `${label}.${key}`;
    counts.set(name, 0);
    const wrapped = function (this: unknown, ...args: unknown[]) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return original.apply(this, args);
    };
    try {
      Object.defineProperty(target, key, { ...descriptor, value: wrapped });
      restores.push(() => Object.defineProperty(target, key, descriptor));
    } catch {
      if (!descriptor.writable) continue;
      const record = target as Record<string, unknown>;
      record[key] = wrapped;
      restores.push(() => {
        record[key] = original;
      });
    }
  }
}

function countDiff(left: Map<string, number>, right: Map<string, number>): string {
  const lines: string[] = [];
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const before = left.get(name) ?? 0;
    const after = right.get(name) ?? 0;
    if (before !== after) lines.push(`${name} ${before} -> ${after}`);
  }
  return lines.join(", ");
}

function sameCounts(left: Map<string, number>, right: Map<string, number>): boolean {
  const names = new Set([...left.keys(), ...right.keys()]);
  for (const name of names) if ((left.get(name) ?? 0) !== (right.get(name) ?? 0)) return false;
  return true;
}

type Identity = { pid: number; ppid: number; lstart: string };

function spawnChild(mode: string, directory: string, keyFile: string) {
  const started = Date.now();
  const child = spawn("/usr/local/bin/node", ["--experimental-strip-types", "--import", join(ROOT, "scripts", "mock-store-load-hook.mjs"), join(ROOT, "tests", "unit", "snapshot-lock-child.mts"), mode, directory, keyFile], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: process.env,
  });
  const identity = readIdentity(child.pid ?? -1);
  if (!identity) {
    const index = directories.indexOf(directory);
    if (index >= 0) directories.splice(index, 1);
    throw new Error(`identity probe failed for ${mode}; directory retained; ${RACE}`);
  }
  let released = false;
  let finished: Promise<number | null> | null = null;
  const ready = waitByte(child.stdio[3] as NodeJS.ReadableStream, 5000);
  const output = collect(child.stdout);
  const finish = () => {
    if (finished) return finished;
    finished = (async () => {
      const first = await waitExit(child, Math.min(5000, Math.max(1, 20_000 - (Date.now() - started))));
      if (!first.timedOut) return first.code;
      const current = readIdentity(child.pid ?? -1);
      if (!current || !sameIdentity(current, identity)) throw new Error(`unaccounted ${mode} child; directory retained; ${RACE}`);
      process.kill(child.pid ?? -1, "SIGTERM");
      const second = await waitExit(child, 5000);
      if (second.timedOut) throw new Error(`child ${mode} did not exit; ${RACE}`);
      return second.code;
    })();
    return finished;
  };
  return {
    child,
    identity,
    ready,
    output,
    finish,
    release() {
      if (released) return;
      released = true;
      child.stdin?.write(Buffer.from([1]));
      void finish();
    },
  };
}

async function reopen(directory: string, expected: string): Promise<string> {
  const keyFile = writeKey(directory);
  const child = spawnChild("reopen", directory, keyFile);
  const output = await child.output;
  const code = await child.finish();
  expect(code).toBe(0);
  expect(output).toBe(expected);
  return output ?? "";
}

function readIdentity(pid: number): Identity | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,lstart="], { timeout: 5000, killSignal: "SIGKILL", encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), lstart: match[3] ?? "" };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.pid === right.pid && left.ppid === right.ppid && left.lstart === right.lstart;
}

function waitByte(stream: NodeJS.ReadableStream, ms: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stream.off("data", onData);
      resolve(null);
    }, ms);
    const onData = (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk);
    };
    stream.once("data", onData);
  });
}

function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stream) return resolve("");
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

function waitExit(child: ChildProcess, ms: number): Promise<{ code: number | null; timedOut: boolean }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, timedOut: false });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve({ code: null, timedOut: true });
    }, ms);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    };
    child.once("exit", onExit);
  });
}
