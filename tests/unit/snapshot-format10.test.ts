import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../../src/lib/shared/canonical-json";
import { readConversation } from "../../src/lib/session/conversation";
import { SESSION_COOKIE_NAME } from "../../src/lib/session/cookie";
import { parseTrustedOrigins } from "../../src/lib/session/request-guard";
import { bodyFromState, bodyFormatFor, recoverStateGate } from "../../src/lib/session/snapshot-state";
import { openFoundationStore, openFoundationStoreWithKeyFile, type FoundationStore, type OpenOptions } from "../../src/lib/session/snapshot-store";
import { needsDraftsFor } from "../../src/lib/session/store";
import { workloadRecordForDraft } from "../../src/lib/session/workload-state";
import { handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "../../src/server/handlers";
import { createRuntime } from "../../src/server/runtime";
import { workloadRecordsRequested } from "../../src/server/runtime";
import { snapshotOpenOptions } from "../../src/server/runtime-access";
import { loadNeedsJourney } from "../../src/server/shopping";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// Release A: snapshot format 10 is a compatibility layer only. Nothing here sets SHOPACCESS_WORKLOAD_RECORDS in the
// process (a few tests set and restore it for their own duration); every store is a disposable temporary directory.
const ORIGIN = "https://shop.example.test";
const config = { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) };
const KEY = Buffer.from("isolated-format10-release-a-key-1");

type Mode = "ordinary" | "format8" | "format9" | "format10";
const MODE: Record<Mode, OpenOptions> = {
  ordinary: {},
  format8: { format8TestStore: true },
  format9: { format9WorkloadTestStore: true },
  format10: { workloadRecords: true },
};

const created: string[] = [];
afterEach(async () => {
  await closeAll();
});
const open: FoundationStore[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "sa-f10-"));
  fs.chmodSync(dir, 0o700);
  created.push(dir);
  return dir;
}
async function closeAll(): Promise<void> {
  for (const store of open.splice(0).reverse()) await store.close?.();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
const keyFileIn = (dir: string): string => {
  const keyFile = join(dir, "identity.key");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
  return keyFile;
};
const bytesOf = (dir: string): string => createHash("sha256").update(fs.readFileSync(join(dir, "store.json"))).digest("hex");
const formatOnDisk = (dir: string): number => (JSON.parse(fs.readFileSync(join(dir, "store.json"), "utf8")) as { format: number }).format;

async function openFresh(mode: Mode, dir = tempDir()) {
  const opened = await openFoundationStore(dir, KEY, { ...MODE[mode], initializeEmpty: { keyFile: keyFileIn(dir) } });
  if (opened.status !== "ready") throw new Error(`fresh ${mode} store did not open: ${opened.code}`);
  open.push(opened.value);
  return { dir, store: opened.value };
}
/** Reopens an existing directory, closing the previous handle first (the writer lock is exclusive). */
async function reopen(dir: string, mode: Mode, previous?: FoundationStore) {
  await previous?.close?.();
  if (previous) open.splice(open.indexOf(previous), 1);
  const opened = await openFoundationStore(dir, KEY, MODE[mode]);
  if (opened.status === "ready") open.push(opened.value);
  return opened;
}

async function shopperOn(runtime: ReturnType<typeof createRuntime>, existingToken?: string) {
  vi.spyOn(runtime.ai, "interpretNeeds").mockResolvedValue({ understoodUse: "programming", budgetDollars: "900", followUp: null });
  let token = existingToken;
  if (!token) {
    const started = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
    token = started.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  }
  const resolved = await runtime.sessions.resolve(token);
  if (!resolved.ok) throw new Error("session did not resolve");
  const session = resolved.value;
  const post = (path: string, handler: typeof handleNeedsSubmit, fields: Record<string, string>) =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: new URLSearchParams({ lang: "en", csrfToken: session.csrfToken, ...fields }).toString(),
      }),
      runtime,
    );
  const draft = () => needsDraftsFor(runtime.store).get(session.id)!;
  return {
    runtime,
    session,
    token: token!,
    draft,
    record: () => workloadRecordForDraft(runtime.store, session.id, draft().draftId, draft().version),
    async submit(text: string) {
      const current = needsDraftsFor(runtime.store).get(session.id);
      const fields: Record<string, string> = { shopperText: text };
      if (current) Object.assign(fields, { draftId: current.draftId, version: String(current.version) });
      expect((await post("/shop/needs/submit", handleNeedsSubmit, fields)).status).toBe(303);
    },
    async confirm() {
      const current = draft();
      await post("/shop/needs/confirm", handleNeedsConfirm, { draftId: current.draftId, version: String(current.version), use: "programming", budget: "900" });
      expect(draft().confirmedUse).toBeTruthy();
    },
  };
}

async function runtimeOn(store: FoundationStore, time = createTestClock()) {
  const recovered = await recoverStateGate(store, time.clock());
  if (recovered.status !== "ready") throw new Error(`recovery failed: ${recovered.code}`);
  return { runtime: createRuntime(config, { clock: time.clock, gate: recovered.gate }), gate: recovered.gate, time };
}

describe("Release A: format 7 remains the default", () => {
  it("an ordinary fresh store is format 7, and recovery and ordinary activity keep it format 7", async () => {
    const { dir, store } = await openFresh("ordinary");
    expect(store.readPublished()).toMatchObject({ status: "ready", value: { format: 7 } });
    const { runtime } = await runtimeOn(store);
    const buyer = await shopperOn(runtime);
    await buyer.submit("I want to train AI models locally");
    expect(formatOnDisk(dir)).toBe(7);
    expect(JSON.parse(fs.readFileSync(join(dir, "store.json"), "utf8")).body.workloads).toBeUndefined();
  });

  it("an existing format-7 store reopened ordinarily stays format 7 across recovery", async () => {
    const first = await openFresh("ordinary");
    const before = await runtimeOn(first.store);
    await (await shopperOn(before.runtime)).submit("I need a laptop for school");
    const reopened = await reopen(first.dir, "ordinary", first.store);
    if (reopened.status !== "ready") throw new Error(reopened.code);
    const { gate } = await runtimeOn(reopened.value);
    expect(reopened.value.readPublished()).toMatchObject({ value: { format: 7 } });
    expect(formatOnDisk(first.dir)).toBe(7);
    expect(bodyFormatFor(7)).toBe(7);
    expect(gate.read().status).toBe("ready");
  });

  it("process settings default to off, so an unconfigured process opens an ordinary store", async () => {
    expect(workloadRecordsRequested()).toBe(false);
    expect(snapshotOpenOptions()).toEqual({ format8TestStore: false, workloadRecords: false });
    const first = await openFresh("ordinary");
    await first.store.close?.();
    open.splice(open.indexOf(first.store), 1);
    const opened = await openFoundationStoreWithKeyFile(first.dir, keyFileIn(first.dir), snapshotOpenOptions());
    if (opened.status !== "ready") throw new Error(opened.code);
    open.push(opened.value);
    expect(opened.value.readPublished()).toMatchObject({ value: { format: 7 } });
  });

  it("only the exact token 1 requests the workload setting", () => {
    const saved = process.env.SHOPACCESS_WORKLOAD_RECORDS;
    try {
      for (const [value, expected] of [["1", true], ["0", false], ["true", false], ["", false], [" 1", false], ["yes", false]] as const) {
        process.env.SHOPACCESS_WORKLOAD_RECORDS = value;
        expect(workloadRecordsRequested(), JSON.stringify(value)).toBe(expected);
      }
      delete process.env.SHOPACCESS_WORKLOAD_RECORDS;
      expect(workloadRecordsRequested()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SHOPACCESS_WORKLOAD_RECORDS;
      else process.env.SHOPACCESS_WORKLOAD_RECORDS = saved;
    }
  });
});

describe("Release A: explicit refusals and no migration", () => {
  it("initializes a format-10 store only through the explicit option, in an isolated directory", async () => {
    const { dir, store } = await openFresh("format10");
    expect(store.readPublished()).toMatchObject({ status: "ready", value: { format: 10 } });
    expect(JSON.parse(fs.readFileSync(join(dir, "store.json"), "utf8")).body.workloads).toEqual([]);
    expect(formatOnDisk(dir)).toBe(10);
  });

  it("ordinary mode refuses a format-10 store with an explicit code and never rewrites it", async () => {
    const { dir, store } = await openFresh("format10");
    await store.close?.();
    open.splice(open.indexOf(store), 1);
    const before = bytesOf(dir);
    const refused = await openFoundationStore(dir, KEY, {});
    expect(refused).toEqual({ status: "unavailable", code: "format-10-requires-workload-setting" });
    expect(bytesOf(dir)).toBe(before);
    expect(formatOnDisk(dir)).toBe(10);
  });

  it("the workload setting refuses a format-7 store and does not convert it", async () => {
    const { dir, store } = await openFresh("ordinary");
    await store.close?.();
    open.splice(open.indexOf(store), 1);
    const before = bytesOf(dir);
    const refused = await openFoundationStore(dir, KEY, { workloadRecords: true });
    expect(refused).toEqual({ status: "unavailable", code: "workload-setting-requires-format-10-store" });
    expect(bytesOf(dir)).toBe(before);
    expect(formatOnDisk(dir)).toBe(7);
  });

  it.each([
    ["format8", "format10"],
    ["format9", "format10"],
    ["format10", "format8"],
    ["format10", "format9"],
    ["format10", "ordinary"],
  ] as const)("a %s store is not opened in %s mode, and is left unchanged", async (created_, mode) => {
    const { dir, store } = await openFresh(created_);
    await store.close?.();
    open.splice(open.indexOf(store), 1);
    const before = bytesOf(dir);
    const refused = await openFoundationStore(dir, KEY, MODE[mode]);
    expect(refused.status).toBe("unavailable");
    expect(bytesOf(dir)).toBe(before);
  });

  it("ordinary mode still refuses formats 8 and 9", async () => {
    for (const mode of ["format8", "format9"] as const) {
      const { dir, store } = await openFresh(mode);
      await store.close?.();
      open.splice(open.indexOf(store), 1);
      expect(await openFoundationStore(dir, KEY, {})).toEqual({ status: "unavailable", code: "test-format-mismatch" });
    }
  });

  it("conflicting modes are refused before anything is opened", async () => {
    for (const options of [
      { workloadRecords: true, format8TestStore: true },
      { workloadRecords: true, format9WorkloadTestStore: true },
      { format8TestStore: true, format9WorkloadTestStore: true },
    ]) {
      const dir = tempDir();
      expect(await openFoundationStore(dir, KEY, { ...options, initializeEmpty: { keyFile: keyFileIn(dir) } })).toEqual({ status: "unavailable", code: "conflicting-test-modes" });
      expect(fs.existsSync(join(dir, "store.json"))).toBe(false);
    }
  });
});

describe("Release A: format-10 validation and tamper resistance fail closed", () => {
  async function withState() {
    const { dir, store } = await openFresh("format10");
    const { runtime, gate } = await runtimeOn(store);
    const buyer = await shopperOn(runtime);
    await buyer.submit("I want to train AI models locally");
    const charger = await shopperOn(runtime);
    await charger.submit("I need a charger for my MacBook Air");
    return { dir, store, buyer, gate };
  }
  const published = (store: FoundationStore) => {
    const snapshot = store.readPublished();
    if (snapshot.status !== "ready") throw new Error("not ready");
    return JSON.parse(JSON.stringify(snapshot.value.body)) as Record<string, any>;
  };

  it("holds the workload record and the charger track together", async () => {
    const { store, buyer } = await withState();
    const body = published(store);
    expect(body.workloads).toHaveLength(1);
    expect(body.workloads[0]).toMatchObject({ sessionId: buyer.session.id, kind: "local_training" });
    expect(body.chargerTracks).toHaveLength(1);
  });

  it("the writer refuses malformed workload bodies and leaves the file untouched", async () => {
    const { dir, store, buyer } = await withState();
    const good = published(store);
    const record = good.workloads[0];
    const before = bytesOf(dir);
    const wrong: Array<[string, Record<string, any>]> = [
      ["duplicate record", { ...good, workloads: [record, record] }],
      ["wrong draft", { ...good, workloads: [{ ...record, draftId: `nd_${"0".repeat(32)}` }] }],
      ["unknown session", { ...good, workloads: [{ ...record, sessionId: "unknown-session" }] }],
      ["extra key", { ...good, workloads: [{ ...record, note: "x" }] }],
      ["bad kind", { ...good, workloads: [{ ...record, kind: "gaming" }] }],
      ["bad evidence state", { ...good, workloads: [{ ...record, evidenceState: "certain" }] }],
      ["version zero", { ...good, workloads: [{ ...record, sourceDraftVersion: 0 }] }],
      ["missing workloads key", Object.fromEntries(Object.entries(good).filter(([key]) => key !== "workloads"))],
      ["not an array", { ...good, workloads: {} }],
      ["format-8 budget on a format-10 track", { ...good, chargerTracks: good.chargerTracks.map((track: any) => ({ ...track, state: "confirmed", deviceId: "Mac14,2", budget: { proposedCents: 5900, confirmedCents: 5900 } })) }],
    ];
    for (const [label, body] of wrong) {
      const result = await store.commit(body as never);
      expect(result, label).toEqual({ status: "unavailable", outcome: "definite" });
      expect(bytesOf(dir), label).toBe(before);
    }
    expect(buyer.record()?.kind).toBe("local_training");
  });

  it("a format-7 writer refuses a body that carries workloads", async () => {
    const { store } = await openFresh("ordinary");
    const body = published(store);
    expect(await store.commit({ ...body, workloads: [] } as never)).toEqual({ status: "unavailable", outcome: "definite" });
  });

  it("tampered snapshots do not open", async () => {
    const { dir, store } = await withState();
    await store.close?.();
    open.splice(open.indexOf(store), 1);
    const path = join(dir, "store.json");
    const original = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(original);
    const flip = (value: string) => (value.endsWith("0") ? `${value.slice(0, -1)}1` : `${value.slice(0, -1)}0`);
    const variants: Array<[string, unknown]> = [
      ["checksum changed", { ...parsed, sha256: flip(parsed.sha256) }],
      ["identity changed", { ...parsed, identity: flip(parsed.identity) }],
      ["record edited without the checksum", { ...parsed, body: { ...parsed.body, workloads: parsed.body.workloads.map((entry: any) => ({ ...entry, kind: "cloud_ai" })) } }],
      ["workloads removed", { ...parsed, body: Object.fromEntries(Object.entries(parsed.body).filter(([key]) => key !== "workloads")) }],
      ["relabelled as format 7", { ...parsed, format: 7 }],
      ["unknown format", { ...parsed, format: 11 }],
    ];
    for (const [label, tampered] of variants) {
      fs.writeFileSync(path, JSON.stringify(tampered), { mode: 0o600 });
      const opened = await openFoundationStore(dir, KEY, MODE.format10);
      expect(opened.status, label).toBe("unavailable");
      if (opened.status === "ready") open.push(opened.value);
    }
    fs.writeFileSync(path, "{not json", { mode: 0o600 });
    expect((await openFoundationStore(dir, KEY, MODE.format10)).status).toBe("unavailable");
    fs.writeFileSync(path, original, { mode: 0o600 });
    const restored = await openFoundationStore(dir, KEY, MODE.format10);
    expect(restored.status).toBe("ready");
    if (restored.status === "ready") open.push(restored.value);
  });
});

describe("Release A: writer, recovery and format selection agree; records survive restarts", () => {
  it("bodyFormatFor selects the workload body only for formats 9 and 10", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((format) => bodyFormatFor(format))).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
    expect([bodyFormatFor(9), bodyFormatFor(10)]).toEqual([9, 9]);
  });

  it("keeps the AI record through truncation and three consecutive restarts, with the rest of the state unchanged", { timeout: 120000 }, async () => {
    const first = await openFresh("format10");
    let current = await runtimeOn(first.store);
    let buyer = await shopperOn(current.runtime);
    await buyer.submit("I want to train AI models locally on my laptop");
    for (let i = 0; i < 9; i++) await buyer.submit(`Thank you, follow-up ${i + 1}`);
    await buyer.confirm();
    const charger = await shopperOn(current.runtime);
    await charger.submit("I need a charger for my MacBook Air");
    expect(readConversation(current.runtime.store, buyer.session.id)?.turns.some((turn) => turn.text.includes("train AI models"))).toBe(false);

    let store = first.store;
    const identity = { sessionId: buyer.session.id, draftId: buyer.draft().draftId, confirmed: buyer.draft().confirmedUse };
    for (let restart = 1; restart <= 3; restart++) {
      const readState = (gate: typeof current.gate) => {
        const read = gate.read();
        if (read.status !== "ready") throw new Error("gate not ready");
        return read.state;
      };
      const stateBefore = readState(current.gate);
      const reopened = await reopen(first.dir, "format10", store);
      if (reopened.status !== "ready") throw new Error(`restart ${restart}: ${reopened.code}`);
      store = reopened.value;
      current = await runtimeOn(store);
      buyer = await shopperOn(current.runtime, buyer.token);
      expect(buyer.session.id, `restart ${restart}`).toBe(identity.sessionId);
      expect(buyer.draft().draftId).toBe(identity.draftId);
      expect(buyer.draft().confirmedUse).toBe(identity.confirmed);
      expect(buyer.record()?.kind, `restart ${restart}`).toBe("local_training");
      expect(formatOnDisk(first.dir)).toBe(10);
      // The state other than the workload record is what it was, and its body is a valid format-7 body.
      const after = readState(current.gate);
      expect(after.sessions.map((session) => session.id).sort()).toEqual(stateBefore.sessions.map((session) => session.id).sort());
      expect([...after.chargerTracks.keys()].sort()).toEqual([...stateBefore.chargerTracks.keys()].sort());
      expect([...after.selections]).toEqual([...stateBefore.selections]);
      const { workloads, ...withoutWorkloads } = bodyFromState(after, 9);
      expect(workloads).toHaveLength(1);
      expect(withoutWorkloads).toEqual(bodyFromState(after, 7));
      await buyer.submit(`Still here after restart ${restart}`);
    }
    const journey = await loadNeedsJourney(current.runtime, buyer.session);
    for (const line of journey.lines) expect(line.aiContext).toBe(true);
    // Release A does not make the format reversible: ordinary mode still refuses the store.
    await store.close?.();
    open.splice(open.indexOf(store), 1);
    expect(await openFoundationStore(first.dir, KEY, {})).toEqual({ status: "unavailable", code: "format-10-requires-workload-setting" });
  });

  it("a crash during a commit leaves the previous snapshot intact and the store recoverable", async () => {
    const dir = tempDir();
    let fail = false;
    const opened = await openFoundationStore(dir, KEY, {
      ...MODE.format10,
      initializeEmpty: { keyFile: keyFileIn(dir) },
      temporaryWrite: async (fd, bytes) => {
        if (fail) throw new Error("simulated crash before the temporary file is complete");
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      },
    });
    if (opened.status !== "ready") throw new Error(opened.code);
    open.push(opened.value);
    const { runtime } = await runtimeOn(opened.value);
    const buyer = await shopperOn(runtime);
    await buyer.submit("I want to train AI models locally");
    const good = bytesOf(dir);
    fail = true;
    await buyer.submit("A turn whose commit crashes").catch(() => undefined);
    expect(bytesOf(dir)).toBe(good);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("store.json.tmp."))).toEqual([]);
    const reopened = await reopen(dir, "format10", opened.value);
    expect(reopened.status).toBe("ready");
    if (reopened.status === "ready") {
      const after = await runtimeOn(reopened.value);
      const again = await shopperOn(after.runtime, buyer.token);
      expect(again.record()?.kind).toBe("local_training");
    }
  });
});

describe("Release A corrections: no overwrite of an existing store", () => {
  it.each([
    ["ordinary", "format10"],
    ["format10", "format10"],
    ["format10", "ordinary"],
    ["format9", "format10"],
  ] as const)("initializeEmpty over an existing %s store in %s mode refuses and changes nothing", async (existing, mode) => {
    const { dir, store } = await openFresh(existing);
    await store.close?.();
    open.splice(open.indexOf(store), 1);
    const lockPath = join(dir, "writer.lock");
    const before = { store: bytesOf(dir), lockMode: fs.statSync(lockPath).mode & 0o777, files: fs.readdirSync(dir).sort() };
    const refused = await openFoundationStore(dir, KEY, { ...MODE[mode], initializeEmpty: { keyFile: keyFileIn(dir) } });
    expect(refused).toEqual({ status: "unavailable", code: "already-present" });
    expect(bytesOf(dir)).toBe(before.store);
    expect(fs.statSync(lockPath).mode & 0o777).toBe(before.lockMode);
    expect(fs.readdirSync(dir).sort()).toEqual(before.files);
  });

  it("a store that is already open (writer lock held) cannot be opened or initialised again", async () => {
    const { dir } = await openFresh("format10");
    const before = bytesOf(dir);
    for (const options of [MODE.format10, { ...MODE.format10, initializeEmpty: { keyFile: keyFileIn(dir) } }]) {
      const second = await openFoundationStore(dir, KEY, options);
      expect(second.status).toBe("unavailable");
      if (second.status === "ready") open.push(second.value);
    }
    expect(bytesOf(dir)).toBe(before);
  });
});

describe("Release A corrections: runtime setting", () => {
  const withEnv = async (values: Record<string, string | undefined>, run: () => Promise<void> | void) => {
    const names = ["SHOPACCESS_WORKLOAD_RECORDS", "SHOPACCESS_CHARGER_BUDGET_TEST_STORE"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) {
        if (values[name] === undefined) delete process.env[name];
        else process.env[name] = values[name];
      }
      await run();
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  };

  it("SHOPACCESS_WORKLOAD_RECORDS=1 enables workloadRecords only", async () => {
    await withEnv({ SHOPACCESS_WORKLOAD_RECORDS: "1" }, () => {
      expect(snapshotOpenOptions()).toEqual({ format8TestStore: false, workloadRecords: true });
    });
  });

  it("unset and invalid values leave it off", async () => {
    for (const value of [undefined, "", "0", "true", "yes", " 1", "1 ", "01"]) {
      await withEnv({ SHOPACCESS_WORKLOAD_RECORDS: value }, () => {
        expect(snapshotOpenOptions().workloadRecords, JSON.stringify(value)).toBe(false);
      });
    }
  });

  it("the charger-budget setting stays independent", async () => {
    await withEnv({ SHOPACCESS_CHARGER_BUDGET_TEST_STORE: "1" }, () => {
      expect(snapshotOpenOptions()).toEqual({ format8TestStore: true, workloadRecords: false });
    });
  });

  it("both settings together are conflicting: the store refuses and the file is untouched", async () => {
    const { dir, store } = await openFresh("ordinary");
    await store.close?.();
    open.splice(open.indexOf(store), 1);
    const before = bytesOf(dir);
    await withEnv({ SHOPACCESS_WORKLOAD_RECORDS: "1", SHOPACCESS_CHARGER_BUDGET_TEST_STORE: "1" }, async () => {
      expect(snapshotOpenOptions()).toEqual({ format8TestStore: true, workloadRecords: true });
      expect(await openFoundationStoreWithKeyFile(dir, keyFileIn(dir), snapshotOpenOptions())).toEqual({ status: "unavailable", code: "conflicting-test-modes" });
    });
    expect(bytesOf(dir)).toBe(before);
    expect(process.env.SHOPACCESS_WORKLOAD_RECORDS).toBeUndefined();
  });

  it("with the setting on, a format-7 store is refused through the process path and not converted", async () => {
    const { dir, store } = await openFresh("ordinary");
    await store.close?.();
    open.splice(open.indexOf(store), 1);
    const before = bytesOf(dir);
    await withEnv({ SHOPACCESS_WORKLOAD_RECORDS: "1" }, async () => {
      expect(await openFoundationStoreWithKeyFile(dir, keyFileIn(dir), snapshotOpenOptions())).toEqual({ status: "unavailable", code: "workload-setting-requires-format-10-store" });
    });
    expect(bytesOf(dir)).toBe(before);
    expect(formatOnDisk(dir)).toBe(7);
  });
});

describe("Release A corrections: workload count cap", () => {
  it("a body with more workload records than sessions is rejected and the previous snapshot is unchanged", async () => {
    const { dir, store } = await openFresh("format10");
    const { runtime } = await runtimeOn(store);
    const buyer = await shopperOn(runtime);
    await buyer.submit("I want to train AI models locally");
    const snapshot = store.readPublished();
    if (snapshot.status !== "ready") throw new Error("not ready");
    const good = JSON.parse(JSON.stringify(snapshot.value.body)) as Record<string, any>;
    expect(good.sessions).toHaveLength(1);
    expect(good.workloads).toHaveLength(1);
    const before = bytesOf(dir);
    const record = good.workloads[0];
    const tooMany = { ...good, workloads: [record, { ...record, sessionId: "another-session" }, { ...record, sessionId: "third-session" }] };
    expect(await store.commit(tooMany as never)).toEqual({ status: "unavailable", outcome: "definite" });
    expect(bytesOf(dir)).toBe(before);
    expect(buyer.record()?.kind).toBe("local_training");
  });
});

describe("Release A corrections: the format-10 checksum is bound to its format", () => {
  const plain = (body: unknown) => createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
  const domain = (body: unknown) => createHash("sha256").update(`shopaccess-snapshot-format-10\n${canonicalJson(body)}`, "utf8").digest("hex");
  const readFile = (dir: string) => JSON.parse(fs.readFileSync(join(dir, "store.json"), "utf8")) as { format: number; identity: string; sha256: string; body: unknown };
  const writeFile = (dir: string, value: unknown) => fs.writeFileSync(join(dir, "store.json"), JSON.stringify(value), { mode: 0o600 });
  const status = async (dir: string, mode: Mode) => {
    const opened = await openFoundationStore(dir, KEY, MODE[mode]);
    if (opened.status === "ready") {
      open.push(opened.value);
      return "open";
    }
    return opened.code;
  };

  it("format 10 uses the domain-separated checksum; formats 7 and 9 keep the bare body checksum", async () => {
    for (const [mode, format] of [["ordinary", 7], ["format9", 9], ["format10", 10]] as const) {
      const { dir, store } = await openFresh(mode);
      await store.close?.();
      open.splice(open.indexOf(store), 1);
      const file = readFile(dir);
      expect(file.format).toBe(format);
      expect(file.sha256).toBe(format === 10 ? domain(file.body) : plain(file.body));
      expect(file.sha256).not.toBe(format === 10 ? plain(file.body) : domain(file.body));
    }
  });

  it("the same body seals to the same bytes every time (deterministic)", async () => {
    const { dir, store } = await openFresh("format10");
    const body = JSON.parse(JSON.stringify((store.readPublished() as { value: { body: unknown } }).value.body));
    expect((await store.commit(body)).status).toBe("ready");
    const first = bytesOf(dir);
    expect((await store.commit(body)).status).toBe("ready");
    expect(bytesOf(dir)).toBe(first);
  });

  it("relabelling a format-9 store as 10, or a format-10 store as 9, fails validation", async () => {
    const nine = await openFresh("format9");
    await nine.store.close?.();
    open.splice(open.indexOf(nine.store), 1);
    writeFile(nine.dir, { ...readFile(nine.dir), format: 10 });
    expect(await status(nine.dir, "format10")).toBe("invalid-snapshot");
    expect(await status(nine.dir, "format9")).toBe("invalid-snapshot");

    const ten = await openFresh("format10");
    await ten.store.close?.();
    open.splice(open.indexOf(ten.store), 1);
    writeFile(ten.dir, { ...readFile(ten.dir), format: 9 });
    expect(await status(ten.dir, "format9")).toBe("invalid-snapshot");
    expect(await status(ten.dir, "format10")).toBe("invalid-snapshot");
  });

  it("every other relabel of a format-10 or format-9 store is refused in every mode", async () => {
    for (const source of ["format9", "format10"] as const) {
      const { dir, store } = await openFresh(source);
      await store.close?.();
      open.splice(open.indexOf(store), 1);
      const original = readFile(dir);
      for (const label of [1, 2, 3, 4, 5, 6, 7, 8, 11, 0, "10", null]) {
        writeFile(dir, { ...original, format: label });
        for (const mode of ["ordinary", "format8", "format9", "format10"] as const) {
          expect(await status(dir, mode), `${source} as ${String(label)} in ${mode}`).not.toBe("open");
        }
      }
    }
  });

  it("documents that the checksum is unkeyed: a relabel with a recomputed checksum is accepted", async () => {
    const { dir, store } = await openFresh("format9");
    await store.close?.();
    open.splice(open.indexOf(store), 1);
    const file = readFile(dir);
    writeFile(dir, { ...file, format: 10, sha256: domain(file.body) });
    // Integrity against accidents and sloppy relabelling, not authentication: no key is needed to recompute it.
    expect(await status(dir, "format10")).toBe("open");
  });
});
