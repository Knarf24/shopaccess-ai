import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { canonicalJson } from "@/lib/shared/canonical-json";
import { readConversation } from "@/lib/session/conversation";
import { chargerTrackFor, setChargerTrack } from "@/lib/session/charger-clarification";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import { openFoundationStore, openFoundationStoreWithKeyFile, type FoundationStore, type OpenOptions } from "@/lib/session/snapshot-store";
import { needsDraftsFor } from "@/lib/session/store";
import { unrecoveredWorkloadDraftsOf, workloadRecordForDraft } from "@/lib/session/workload-state";
import { handleChargerControl, handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createSnapshotApplication, mockStoreSettings, runtimeOf, type Application } from "@/server/runtime";
import { createRuntimeAccess, snapshotOpenOptions, type RuntimeAccess } from "@/server/runtime-access";
import { loadNeedsJourney } from "@/server/shopping";
import { renderWithAppRouter } from "./router-render";
import { permitCatalog } from "./helpers";

// Release B1: AI workload records survive restarts in a brand-new, disposable format-10 store.
//
// What is real here: the runtime is started through createRuntimeAccess with exactly the dependencies the process
// accessor uses (mockStoreSettings read from the environment, openFoundationStoreWithKeyFile with snapshotOpenOptions(),
// recoverStateGate, createSnapshotApplication), and every shopper action goes through the real request handlers. What is
// simulated: a "restart" is a clean close of the store followed by a new runtime on the same store and key, inside this
// test process; no HTTP server or child process is used. The no-TCP guard blocks even loopback TCP, so a real HTTP
// server could not run under it. The two format10-real-accessor-*.test.ts files cover the process accessor itself.
//
// Isolation: every SHOPACCESS_*, PAYPAL_* and PAYMENT_PROVIDER_MODE variable of the surrounding environment is removed
// for the duration of each test and restored afterwards, so SHOPACCESS_MOCK_STORE_DIR / _KEY_FILE from the user's shell
// can never be used. Directories live under the OS temp directory and only those this file created are removed.
const ORIGIN = "https://shop.example.test";
const MANAGED = (name: string) => /^(SHOPACCESS_|PAYPAL_)/.test(name) || name === "PAYMENT_PROVIDER_MODE";
const KEY = Buffer.from("isolated-format10-b1-endtoend-key");

type Env = Record<string, string | undefined>;
const created: string[] = [];
const stoppers: Array<() => Promise<void>> = [];
let savedEnv: Env = {};

function isolateEnvironment(extra: Env): void {
  savedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => MANAGED(name)));
  for (const name of Object.keys(process.env)) if (MANAGED(name)) delete process.env[name];
  Object.assign(process.env, {
    SHOPACCESS_SESSION_KEY: Buffer.alloc(32, 11).toString("base64"),
    SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
    PAYMENT_PROVIDER_MODE: "mock",
  });
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
function restoreEnvironment(): void {
  for (const name of Object.keys(process.env)) if (MANAGED(name)) delete process.env[name];
  Object.assign(process.env, savedEnv);
}

beforeEach(() => {
  isolateEnvironment({});
});
afterEach(async () => {
  for (const stop of stoppers.splice(0).reverse()) await stop();
  for (const dir of created.splice(0)) {
    expect(dir.startsWith(tmpdir() + sep), `refusing to remove a path outside the temp directory: ${dir}`).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  restoreEnvironment();
  expect(Object.keys(process.env).filter((name) => MANAGED(name) && !(name in savedEnv))).toEqual([]);
});

type World = { readonly dir: string; readonly keyFile: string };
type Mode = "ordinary" | "format8" | "format9" | "format10";
const MODE: Record<Mode, OpenOptions> = {
  ordinary: {},
  format8: { format8TestStore: true },
  format9: { format9WorkloadTestStore: true },
  format10: { workloadRecords: true },
};

/** A brand-new store directory, key file and empty store of the given format. Test-only: the application never initializes. */
async function freshWorld(mode: Mode, key: Buffer = KEY): Promise<World> {
  const dir = fs.mkdtempSync(join(tmpdir(), "sa-b1-"));
  fs.chmodSync(dir, 0o700);
  created.push(dir);
  const keyFile = join(dir, "identity.key");
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  const opened = await openFoundationStore(dir, key, { ...MODE[mode], initializeEmpty: { keyFile } });
  if (opened.status !== "ready") throw new Error(`could not create a fresh ${mode} store: ${opened.code}`);
  await opened.value.close?.();
  return { dir, keyFile };
}
const storePath = (world: World) => join(world.dir, "store.json");
const diskFile = (world: World) => JSON.parse(fs.readFileSync(storePath(world), "utf8")) as { format: number; identity: string; sha256: string; body: Record<string, any> };
const diskBytes = (world: World) => createHash("sha256").update(fs.readFileSync(storePath(world))).digest("hex");

type Started =
  | { readonly status: "ready"; readonly runtime: ReturnType<typeof runtimeValue>; readonly stop: () => Promise<void> }
  | { readonly status: "unavailable"; readonly code: string };
const runtimeValue = (application: Application) => {
  const runtime = runtimeOf(application);
  if (!runtime.ok) throw new Error(`no runtime: ${runtime.error.join(",")}`);
  return runtime.value;
};

/** The real startup path: settings from the environment, the production open options, recovery, and the real build. */
async function start(world: World): Promise<Started> {
  const settings = mockStoreSettings();
  expect(settings).toMatchObject({ state: "requested", directory: world.dir, keyFile: world.keyFile });
  let store: FoundationStore | null = null;
  const access = createRuntimeAccess({
    settings: mockStoreSettings,
    memory: () => {
      throw new Error("the in-memory runtime must not be used when a store is requested");
    },
    openStore: async (directory, keyFile) => {
      const opened = await openFoundationStoreWithKeyFile(directory, keyFile, snapshotOpenOptions());
      if (opened.status === "ready") store = opened.value;
      return opened;
    },
    recover: recoverStateGate,
    build: createSnapshotApplication,
    now: () => new Date(),
    report: () => undefined,
  });
  const result: RuntimeAccess = await access.open();
  if (result.status !== "ready") return { status: "unavailable", code: result.code };
  const stop = async () => {
    await store?.close?.();
    store = null;
  };
  stoppers.push(stop);
  return { status: "ready", runtime: runtimeValue(result.application), stop };
}
async function mustStart(world: World) {
  const started = await start(world);
  if (started.status !== "ready") throw new Error(`startup failed: ${started.code}`);
  return started;
}

type RuntimeOf = ReturnType<typeof runtimeValue>;
async function shopper(runtime: RuntimeOf, existingToken?: string) {
  vi.spyOn(runtime.ai, "interpretNeeds").mockResolvedValue({ understoodUse: "programming", budgetDollars: "900", followUp: null });
  let token = existingToken;
  if (!token) {
    const response = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
    token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  }
  const resolved = await runtime.sessions.resolve(token);
  if (!resolved.ok) throw new Error(`session did not resolve: ${resolved.error}`);
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
  const draft = () => needsDraftsFor(runtime.store).get(session.id) ?? null;
  return {
    runtime,
    session,
    token: token!,
    draft,
    record: () => {
      const current = draft();
      return current ? workloadRecordForDraft(runtime.store, session.id, current.draftId, current.version) : null;
    },
    async submit(text: string, newDraft = false) {
      const current = newDraft ? null : draft();
      const fields: Record<string, string> = { shopperText: text };
      if (current) Object.assign(fields, { draftId: current.draftId, version: String(current.version) });
      expect((await post("/shop/needs/submit", handleNeedsSubmit, fields)).status).toBe(303);
    },
    async confirm() {
      const current = draft()!;
      await post("/shop/needs/confirm", handleNeedsConfirm, { draftId: current.draftId, version: String(current.version), use: "programming", budget: "900" });
      expect(draft()!.confirmedUse).toBeTruthy();
    },
    async chooseLaptop() {
      const current = draft()!;
      const track = chargerTrackFor(runtime.store, session.id, current.draftId);
      expect(track).not.toBeNull();
      const response = await post("/shop/needs/charger-control", handleChargerControl, {
        draftId: current.draftId,
        revision: String(track!.revision),
        action: "choose_task",
        task: "laptop",
      });
      expect(response.status).toBe(303);
    },
    async cards() {
      const journey = await loadNeedsJourney(runtime, session);
      expect(journey.lines.length).toBeGreaterThan(0);
      const html = renderWithAppRouter(
        <TranslatedCatalogList copy={journeyCopy("en")} language="en" csrfToken="csrf" lines={journey.lines} confirmedUse="programming" confirmedBudgetDollars="900" labelChoices suggestedVariantIds={["dmv_aspirego15"]} />,
      );
      return { journey, html };
    },
  };
}
type Shopper = Awaited<ReturnType<typeof shopper>>;

/** Starts with the setting on, over a brand-new format-10 store. */
async function activated() {
  const world = await freshWorld("format10");
  process.env.SHOPACCESS_MOCK_STORE_DIR = world.dir;
  process.env.SHOPACCESS_MOCK_STORE_KEY_FILE = world.keyFile;
  process.env.SHOPACCESS_WORKLOAD_RECORDS = "1";
  expect(diskFile(world).format).toBe(10);
  return world;
}
function pointAt(world: World, setting: boolean): void {
  process.env.SHOPACCESS_MOCK_STORE_DIR = world.dir;
  process.env.SHOPACCESS_MOCK_STORE_KEY_FILE = world.keyFile;
  if (setting) process.env.SHOPACCESS_WORKLOAD_RECORDS = "1";
  else delete process.env.SHOPACCESS_WORKLOAD_RECORDS;
}

const kinds = (world: World) => diskFile(world).body.workloads.map((record: any) => `${record.kind}/${record.evidenceState}`);

describe("B1 activation: a brand-new format-10 store through the real startup path", () => {
  it("never uses the surrounding environment's store settings", () => {
    expect(mockStoreSettings()).toEqual({ state: "absent" });
    expect(snapshotOpenOptions()).toEqual({ format8TestStore: false, workloadRecords: false });
  });

  it("writes format 10 and the workload record to disk after a legitimate shopper turn", async () => {
    const world = await activated();
    const { runtime } = await mustStart(world);
    const buyer = await shopper(runtime);
    expect(diskFile(world).body.workloads).toEqual([]);
    await buyer.submit("I want to train AI models locally on my laptop");
    const file = diskFile(world);
    expect(file.format).toBe(10);
    expect(file.body.workloads).toHaveLength(1);
    expect(file.body.workloads[0]).toMatchObject({ sessionId: buyer.session.id, draftId: buyer.draft()!.draftId, kind: "local_training" });
    expect(Object.keys(file.body).sort()).toEqual(["admissionLogin", "allocation", "chargerTracks", "conversations", "drafts", "grants", "permissions", "profileRevisions", "profiles", "selections", "sessions", "workloads"]);
    expect(file.sha256).toBe(createHash("sha256").update(`shopaccess-snapshot-format-10\n${canonicalJson(file.body)}`, "utf8").digest("hex"));
  });

  it("without the setting the real startup path refuses that store and rewrites nothing; an ordinary store stays format 7", async () => {
    const world = await activated();
    const before = diskBytes(world);
    pointAt(world, false);
    expect(await start(world)).toEqual({ status: "unavailable", code: "open-format-10-requires-workload-setting" });
    expect(diskBytes(world)).toBe(before);
    expect(diskFile(world).format).toBe(10);

    const ordinary = await freshWorld("ordinary");
    pointAt(ordinary, false);
    const { runtime } = await mustStart(ordinary);
    await (await shopper(runtime)).submit("I want to train AI models locally");
    expect(diskFile(ordinary).format).toBe(7);
    expect(diskFile(ordinary).body.workloads).toBeUndefined();
  });
});

describe("B1 journeys: records survive restarts, truncation and continued shopping", () => {
  it("A: local AI training survives three restarts and truncation, with the warning and no badge", { timeout: 120000 }, async () => {
    const world = await activated();
    let started = await mustStart(world);
    let buyer = await shopper(started.runtime);
    await buyer.submit("I want to train AI models locally on my laptop");
    for (let i = 0; i < 9; i++) await buyer.submit(`Thank you, follow-up ${i + 1}`);
    await buyer.confirm();
    const identity = { sessionId: buyer.session.id, draftId: buyer.draft()!.draftId, confirmed: buyer.draft()!.confirmedUse };
    expect(kinds(world)).toEqual(["local_training/explicit"]);
    const first = await buyer.cards();
    for (const line of first.journey.lines) expect(line.aiContext).toBe(true);
    expect(first.html).not.toContain("recommendation-badge");
    expect(first.html).toContain("GPU and VRAM evidence is missing");

    for (let restart = 1; restart <= 3; restart++) {
      const versionBefore = buyer.draft()!.version;
      await started.stop();
      started = await mustStart(world);
      buyer = await shopper(started.runtime, buyer.token);
      expect(buyer.session.id, `restart ${restart}`).toBe(identity.sessionId);
      expect(buyer.draft()!.draftId).toBe(identity.draftId);
      expect(buyer.draft()!.version).toBe(versionBefore);
      expect(buyer.draft()!.confirmedUse).toBe(identity.confirmed);
      // The durable record, not the temporary uncertainty marker, carries the workload.
      expect(buyer.record()?.kind, `restart ${restart}`).toBe("local_training");
      expect(unrecoveredWorkloadDraftsOf(started.runtime.store).size).toBe(0);
      const { journey, html } = await buyer.cards();
      for (const line of journey.lines) {
        expect(line.aiContext).toBe(true);
        expect(line.aiHardware.workload).toBe("local_training");
      }
      expect(html).not.toContain("recommendation-badge");
      expect(html).toContain("AI compatibility: not verified");
      await buyer.submit(`Still here after restart ${restart}`);
      expect(buyer.draft()!.version).toBeGreaterThan(versionBefore);
      expect(buyer.record()?.kind).toBe("local_training");
      expect(diskFile(world).format).toBe(10);
      expect(kinds(world)).toEqual(["local_training/explicit"]);
    }
  });

  it("B: local inference survives a restart", async () => {
    const world = await activated();
    let started = await mustStart(world);
    let buyer = await shopper(started.runtime);
    await buyer.submit("I want to run LLMs locally on my laptop");
    await buyer.confirm();
    expect(kinds(world)).toEqual(["local_inference/explicit"]);
    await started.stop();
    started = await mustStart(world);
    buyer = await shopper(started.runtime, buyer.token);
    expect(buyer.record()?.kind).toBe("local_inference");
    const { journey, html } = await buyer.cards();
    for (const line of journey.lines) expect(line.aiHardware.workload).toBe("local_inference");
    expect(html).not.toContain("recommendation-badge");
  });

  it("C: cloud-only AI survives a restart with the ordinary badge and no local-GPU warning", async () => {
    const world = await activated();
    let started = await mustStart(world);
    let buyer = await shopper(started.runtime);
    await buyer.submit("I will use cloud AI services");
    await buyer.confirm();
    expect(kinds(world)).toEqual(["cloud_ai/explicit"]);
    await started.stop();
    started = await mustStart(world);
    buyer = await shopper(started.runtime, buyer.token);
    expect(buyer.record()?.kind).toBe("cloud_ai");
    const { journey, html } = await buyer.cards();
    for (const line of journey.lines) {
      expect(line.aiContext).toBe(true);
      expect(line.aiHardware.workload).toBe("cloud_ai");
    }
    expect(html).toContain("recommendation-badge");
    expect(html).toContain("AI compatibility: not verified");
    expect(html).not.toContain("GPU and VRAM evidence is missing");
  });

  it("D: an unspecified AI request keeps its conservative treatment after a restart", async () => {
    const world = await activated();
    let started = await mustStart(world);
    let buyer = await shopper(started.runtime);
    await buyer.submit("I want to work with AI models");
    await buyer.confirm();
    expect(kinds(world)).toEqual(["unspecified_ai/unresolved"]);
    await started.stop();
    started = await mustStart(world);
    buyer = await shopper(started.runtime, buyer.token);
    expect(buyer.record()?.kind).toBe("unspecified_ai");
    const { journey, html } = await buyer.cards();
    for (const line of journey.lines) expect(line.aiContext).toBe(true);
    expect(html).not.toContain("recommendation-badge");
    expect(html).toContain("AI compatibility: not verified");
  });

  it("E: a non-AI shopper gets no record and no AI warning, even after truncation and three restarts", { timeout: 120000 }, async () => {
    const world = await activated();
    let started = await mustStart(world);
    let buyer = await shopper(started.runtime);
    await buyer.submit("I need a laptop for school");
    for (let i = 0; i < 9; i++) await buyer.submit(`Thank you, follow-up ${i + 1}`);
    await buyer.confirm();
    expect(diskFile(world).body.workloads).toEqual([]);
    for (let restart = 1; restart <= 3; restart++) {
      await started.stop();
      started = await mustStart(world);
      buyer = await shopper(started.runtime, buyer.token);
      expect(buyer.record()).toBeNull();
      // Format 10 stores a workloads array, so there is no uncertainty marker and no false warning.
      expect(unrecoveredWorkloadDraftsOf(started.runtime.store).size).toBe(0);
      const { journey, html } = await buyer.cards();
      for (const line of journey.lines) expect(line.aiContext, `restart ${restart}`).toBe(false);
      expect(html).toContain("recommendation-badge");
      expect(html).not.toMatch(/AI compatibility/);
    }
  });

  it("F1: a charger-only turn does not erase an earlier laptop workload, across a restart", async () => {
    const world = await activated();
    let started = await mustStart(world);
    let buyer = await shopper(started.runtime);
    await buyer.submit("I want to train AI models locally on my laptop");
    expect(kinds(world)).toEqual(["local_training/explicit"]);
    await buyer.submit("I also need a charger for my MacBook Air");
    expect(chargerTrackFor(started.runtime.store, buyer.session.id, buyer.draft()!.draftId)).not.toBeNull();
    expect(buyer.record()?.kind).toBe("local_training");
    expect(kinds(world)).toEqual(["local_training/explicit"]);
    await started.stop();
    started = await mustStart(world);
    buyer = await shopper(started.runtime, buyer.token);
    expect(buyer.record()?.kind).toBe("local_training");
  });

  it("F2: a mixed charger and laptop request keeps its AI workload once the laptop is chosen", async () => {
    const world = await activated();
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit("I need a charger and a laptop to train AI models locally");
    expect(chargerTrackFor(started.runtime.store, buyer.session.id, buyer.draft()!.draftId)?.state).toBe("task_choice");
    expect(diskFile(world).body.workloads).toEqual([]);
    await buyer.chooseLaptop();
    expect(buyer.record()?.kind).toBe("local_training");
    expect(diskFile(world).body.workloads).toEqual([
      { sessionId: buyer.session.id, draftId: buyer.draft()!.draftId, kind: "local_training", sourceDraftVersion: buyer.draft()!.version, evidenceState: "inferred" },
    ]);
  });
});

describe("B1 safety: refusals, tampering and stale records", () => {
  it("an existing format-7 store refuses workload mode and is not converted", async () => {
    const world = await freshWorld("ordinary");
    const before = diskBytes(world);
    pointAt(world, true);
    expect(await start(world)).toEqual({ status: "unavailable", code: "open-workload-setting-requires-format-10-store" });
    expect(diskBytes(world)).toBe(before);
    expect(diskFile(world).format).toBe(7);
  });

  it("formats 8 and 9 stay isolated from both the ordinary and the workload startup path", async () => {
    for (const mode of ["format8", "format9"] as const) {
      const world = await freshWorld(mode);
      const before = diskBytes(world);
      for (const setting of [false, true]) {
        pointAt(world, setting);
        const result = await start(world);
        expect(result.status, `${mode} setting=${setting}`).toBe("unavailable");
      }
      expect(diskBytes(world)).toBe(before);
    }
  });

  it("a wrong key, a corrupted file and relabelled files fail closed without being rewritten", async () => {
    const world = await activated();
    const original = fs.readFileSync(storePath(world), "utf8");
    const file = JSON.parse(original);
    const check = async (label: string, write: () => void) => {
      write();
      const before = diskBytes(world);
      const result = await start(world);
      expect(result.status, label).toBe("unavailable");
      expect(diskBytes(world), label).toBe(before);
      fs.writeFileSync(storePath(world), original, { mode: 0o600 });
    };
    await check("garbage", () => fs.writeFileSync(storePath(world), "{not json", { mode: 0o600 }));
    await check("checksum flipped", () => fs.writeFileSync(storePath(world), JSON.stringify({ ...file, sha256: `${file.sha256.slice(0, -1)}${file.sha256.endsWith("0") ? "1" : "0"}` }), { mode: 0o600 }));
    await check("relabelled 9 without a recomputed checksum", () => fs.writeFileSync(storePath(world), JSON.stringify({ ...file, format: 9 }), { mode: 0o600 }));
    await check("relabelled 7", () => fs.writeFileSync(storePath(world), JSON.stringify({ ...file, format: 7 }), { mode: 0o600 }));
    // A different key file for the same store.
    const otherKey = join(world.dir, "other.key");
    fs.writeFileSync(otherKey, Buffer.from("a-different-identity-key-0000000000"), { mode: 0o600 });
    process.env.SHOPACCESS_MOCK_STORE_KEY_FILE = otherKey;
    const wrong = await openFoundationStoreWithKeyFile(world.dir, otherKey, snapshotOpenOptions());
    expect(wrong.status).toBe("unavailable");
    expect(diskBytes(world)).toBe(createHash("sha256").update(original).digest("hex"));
    process.env.SHOPACCESS_MOCK_STORE_KEY_FILE = world.keyFile;
    // Restored, the genuine store starts again.
    expect((await start(world)).status).toBe("ready");
  });

  it("documents the limit: a relabel with a recomputed unkeyed checksum is accepted", async () => {
    const world = await freshWorld("format9");
    const file = diskFile(world);
    fs.writeFileSync(storePath(world), JSON.stringify({ ...file, format: 10, sha256: createHash("sha256").update(`shopaccess-snapshot-format-10\n${canonicalJson(file.body)}`, "utf8").digest("hex") }), { mode: 0o600 });
    pointAt(world, true);
    expect((await start(world)).status).toBe("ready");
  });

  it("a replaced draft does not regain the old draft's workload record", { timeout: 120000 }, async () => {
    const world = await activated();
    let started = await mustStart(world);
    let buyer = await shopper(started.runtime);
    await buyer.submit("I want to train AI models locally");
    const oldDraft = buyer.draft()!.draftId;
    expect(kinds(world)).toHaveLength(1);
    // The persistence-level meaning of "replaced": the session's current draft gets a different draft id.
    const newDraft = `nd_${"a".repeat(32)}`;
    await started.runtime.durable.change((host) => {
      const draft = needsDraftsFor(host).get(buyer.session.id)!;
      needsDraftsFor(host).set(buyer.session.id, { ...draft, draftId: newDraft, version: 1, confirmedUse: null, confirmedBudgetDollars: null });
    });
    expect(diskFile(world).body.workloads.filter((record: any) => record.draftId === oldDraft)).toEqual([]);
    await started.stop();
    started = await mustStart(world);
    buyer = await shopper(started.runtime, buyer.token);
    expect(buyer.draft()!.draftId).toBe(newDraft);
    expect(buyer.record()).toBeNull();
    expect(diskFile(world).body.workloads).toEqual([]);
  });

  it("an expired draft is dropped with its record, and a later draft does not inherit it", async () => {
    const world = await activated();
    let started = await mustStart(world);
    let buyer = await shopper(started.runtime);
    await buyer.submit("I want to train AI models locally");
    expect(kinds(world)).toHaveLength(1);
    await started.runtime.durable.change((host) => {
      const draft = needsDraftsFor(host).get(buyer.session.id)!;
      needsDraftsFor(host).set(buyer.session.id, { ...draft, expiresAtMs: 1 });
    });
    await started.stop();
    started = await mustStart(world);
    buyer = await shopper(started.runtime, buyer.token);
    expect(buyer.draft()).toBeNull();
    expect(diskFile(world).body.workloads).toEqual([]);
    await buyer.submit("I need a laptop for school");
    expect(buyer.record()).toBeNull();
  });

  it("a revoked session loses its record and its draft", async () => {
    const world = await activated();
    let started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit("I want to train AI models locally");
    expect(kinds(world)).toHaveLength(1);
    await started.runtime.sessions.revoke(buyer.session.id);
    await started.stop();
    started = await mustStart(world);
    expect((await started.runtime.sessions.resolve(buyer.token)).ok).toBe(false);
    expect(diskFile(world).body.workloads).toEqual([]);
    expect(diskFile(world).body.drafts).toEqual([]);
  });

  it("session identity, permissions, selections, charger tracks and confirmation are unchanged by a restart; no checkout is created", async () => {
    const world = await activated();
    let started = await mustStart(world);
    let buyer = await shopper(started.runtime);
    await buyer.submit("I want to train AI models locally on my laptop");
    await buyer.confirm();
    await permitCatalog(started.runtime, buyer.session.id);
    // A genuine workload change withdraws the confirmation and closes purchase selections (a persisted marker).
    await buyer.submit("Actually I will use cloud AI services");
    expect(buyer.draft()!.confirmedUse).toBeNull();
    const charger = await shopper(started.runtime);
    await charger.submit("I need a charger for my MacBook Air");
    const before = diskFile(world).body;
    expect(before.permissions.length).toBeGreaterThan(0);
    expect(before.chargerTracks).toHaveLength(1);
    expect(before.selections.length).toBeGreaterThan(0);
    const pick = (body: Record<string, any>) => ({
      sessions: body.sessions.map((session: any) => session.id).sort(),
      permissions: [...body.permissions].map((permission: any) => canonicalJson(permission)).sort(),
      selections: [...body.selections].map((selection: any) => canonicalJson(selection)).sort(),
      chargerTracks: [...body.chargerTracks].map((track: any) => canonicalJson(track)).sort(),
      drafts: body.drafts.map((draft: any) => ({ sessionId: draft.sessionId, draftId: draft.draftId, version: draft.version, confirmedUse: draft.confirmedUse, confirmedBudgetDollars: draft.confirmedBudgetDollars })).sort((a: any, b: any) => a.sessionId.localeCompare(b.sessionId)),
    });
    const expected = pick(before);
    await started.stop();
    started = await mustStart(world);
    expect(pick(diskFile(world).body)).toEqual(expected);
    buyer = await shopper(started.runtime, buyer.token);
    expect(buyer.record()?.kind).toBe("cloud_ai");
    expect(buyer.draft()!.confirmedUse).toBeNull();
    // No checkout or payment state exists in any snapshot, and the test never called a checkout handler.
    expect(Object.keys(diskFile(world).body)).not.toEqual(expect.arrayContaining(["checkouts", "intents", "payments"]));
  });
});

describe("B1 mixed-task recovery: choosing the laptop persists the laptop workload", () => {
  const MIXED = (tail: string) => `I need a charger and a laptop ${tail}`;
  async function chosen(text: string) {
    const world = await activated();
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit(text);
    expect(chargerTrackFor(started.runtime.store, buyer.session.id, buyer.draft()!.draftId)?.state).toBe("task_choice");
    expect(diskFile(world).body.workloads).toEqual([]);
    await buyer.chooseLaptop();
    return { world, started, buyer };
  }
  const persisted = (buyer: Shopper) => ({ sessionId: buyer.session.id, draftId: buyer.draft()!.draftId, sourceDraftVersion: buyer.draft()!.version });

  it.each([
    ["to train AI models locally", "local_training", "inferred"],
    ["to run LLMs locally on my laptop", "local_inference", "inferred"],
    ["to use cloud AI services", "cloud_ai", "inferred"],
    ["to work with AI models", "unspecified_ai", "unresolved"],
  ] as const)("%s is recovered as %s with the exact durable record", async (tail, kind, evidence) => {
    const { world, buyer } = await chosen(MIXED(tail));
    expect(diskFile(world).body.workloads).toEqual([{ ...persisted(buyer), kind, evidenceState: evidence }]);
    expect(buyer.record()?.kind).toBe(kind);
    expect(diskFile(world).format).toBe(10);
  });

  it("cloud-only AI is not misclassified as local training, and keeps the ordinary badge after a restart", async () => {
    const { world, started, buyer: first } = await chosen(MIXED("to use cloud AI services"));
    await first.confirm();
    await started.stop();
    const restarted = await mustStart(world);
    const buyer = await shopper(restarted.runtime, first.token);
    expect(buyer.record()?.kind).toBe("cloud_ai");
    const { journey, html } = await buyer.cards();
    for (const line of journey.lines) expect(line.aiHardware.workload).toBe("cloud_ai");
    expect(html).toContain("recommendation-badge");
    expect(html).not.toContain("GPU and VRAM evidence is missing");
  });

  it("survives three restarts and truncation past eight turns, with the warning and no badge", { timeout: 120000 }, async () => {
    const { world, started: first, buyer: initial } = await chosen(MIXED("to train AI models locally"));
    const expected = [{ ...persisted(initial), kind: "local_training", evidenceState: "inferred" }];
    let buyer = initial;
    for (let i = 0; i < 9; i++) await buyer.submit(`Thank you, follow-up ${i + 1}`);
    await buyer.confirm();
    // Later accepted turns advance the record's source version; its identity and classification do not change.
    const afterTurns = diskFile(world).body.workloads;
    expect(afterTurns).toHaveLength(1);
    expect(afterTurns[0]).toMatchObject({ sessionId: expected[0].sessionId, draftId: expected[0].draftId, kind: "local_training", evidenceState: "inferred" });
    expect(afterTurns[0].sourceDraftVersion).toBeGreaterThanOrEqual(expected[0].sourceDraftVersion);
    let started = first;
    for (let restart = 1; restart <= 3; restart++) {
      await started.stop();
      started = await mustStart(world);
      buyer = await shopper(started.runtime, buyer.token);
      expect(buyer.record()?.kind, `restart ${restart}`).toBe("local_training");
      expect(unrecoveredWorkloadDraftsOf(started.runtime.store).size).toBe(0);
      const { journey, html } = await buyer.cards();
      for (const line of journey.lines) expect(line.aiContext).toBe(true);
      expect(html).not.toContain("recommendation-badge");
      expect(html).toContain("GPU and VRAM evidence is missing");
      expect(diskFile(world).body.workloads).toHaveLength(1);
      expect(diskFile(world).body.workloads[0]).toMatchObject({ sessionId: buyer.session.id, draftId: buyer.draft()!.draftId, kind: "local_training" });
    }
  });

  it("a charger-only request creates no laptop workload", async () => {
    const world = await activated();
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit("I need a charger for my MacBook Air");
    expect(chargerTrackFor(started.runtime.store, buyer.session.id, buyer.draft()!.draftId)?.state).toBe("awaiting_model");
    expect(diskFile(world).body.workloads).toEqual([]);
    expect(buyer.record()).toBeNull();
  });

  it.each([
    ["for school", "no AI evidence"],
    ["for programming in Python", "plain programming"],
    [", no AI", "an explicit refusal of AI"],
    ["; my sister does not use AI", "an unrelated negated mention"],
  ])("a mixed request %s (%s) creates no AI workload record", async (tail) => {
    const { world, started, buyer } = await chosen(MIXED(tail));
    expect(diskFile(world).body.workloads).toEqual([]);
    expect(buyer.record()).toBeNull();
    await buyer.confirm();
    for (const line of (await buyer.cards()).journey.lines) expect(line.aiContext).toBe(false);
    await started.stop();
  });

  it("does not overwrite a record the laptop task already has", async () => {
    const world = await activated();
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit("I want to train AI models locally on my laptop");
    const before = diskFile(world).body.workloads;
    expect(before).toHaveLength(1);
    await buyer.submit("I also need a charger and a laptop for school");
    expect(chargerTrackFor(started.runtime.store, buyer.session.id, buyer.draft()!.draftId)?.state).toBe("task_choice");
    await buyer.chooseLaptop();
    expect(diskFile(world).body.workloads).toEqual(before.map((record: any) => ({ ...record })));
    expect(buyer.record()?.kind).toBe("local_training");
  });

  it("choosing the charger task instead recovers no laptop workload", async () => {
    const world = await activated();
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit(MIXED("to train AI models locally"));
    const draft = buyer.draft()!;
    const track = chargerTrackFor(started.runtime.store, buyer.session.id, draft.draftId)!;
    const response = await handleChargerControl(
      new Request(`${ORIGIN}/shop/needs/charger-control`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${buyer.token}` },
        body: new URLSearchParams({ lang: "en", csrfToken: buyer.session.csrfToken, draftId: draft.draftId, revision: String(track.revision), action: "choose_task", task: "charger" }).toString(),
      }),
      started.runtime,
    );
    expect(response.status).toBe(303);
    expect(chargerTrackFor(started.runtime.store, buyer.session.id, draft.draftId)?.state).toBe("awaiting_model");
    expect(buyer.record()).toBeNull();
    expect(diskFile(world).body.workloads).toEqual([]);
  });

  it("does not recover a record from another draft's conversation", async () => {
    const { world: _unused, started, buyer } = await (async () => {
      const world = await activated();
      const started = await mustStart(world);
      const buyer = await shopper(started.runtime);
      await buyer.submit(MIXED("to train AI models locally"));
      return { world, started, buyer };
    })();
    const newDraft = `nd_${"c".repeat(32)}`;
    await started.runtime.durable.change((host) => {
      const draft = needsDraftsFor(host).get(buyer.session.id)!;
      // A genuinely different draft has its own text; it must not carry the old draft's request.
      needsDraftsFor(host).set(buyer.session.id, { ...draft, draftId: newDraft, version: 1, shopperText: "I need a charger and a laptop for school", confirmedUse: null, confirmedBudgetDollars: null });
      setChargerTrack(host, { sessionId: buyer.session.id, draftId: newDraft, state: "task_choice", deviceId: null, revision: 1 });
    });
    await buyer.chooseLaptop();
    expect(buyer.draft()!.draftId).toBe(newDraft);
    expect(buyer.record()).toBeNull();
  });

  it("a charger-only follow-up after the recovery does not erase the workload", async () => {
    const { world, started: first, buyer } = await chosen(MIXED("to train AI models locally"));
    await buyer.submit("I also need a charger for my MacBook Air");
    expect(buyer.record()?.kind).toBe("local_training");
    expect(diskFile(world).body.workloads).toHaveLength(1);
    await first.stop();
    const restarted = await mustStart(world);
    expect((await shopper(restarted.runtime, buyer.token)).record()?.kind).toBe("local_training");
  });

  it("an expired draft does not pass its recovered record to a later draft", async () => {
    const { world, started, buyer } = await chosen(MIXED("to train AI models locally"));
    expect(diskFile(world).body.workloads).toHaveLength(1);
    await started.runtime.durable.change((host) => {
      const draft = needsDraftsFor(host).get(buyer.session.id)!;
      needsDraftsFor(host).set(buyer.session.id, { ...draft, expiresAtMs: 1 });
    });
    await started.stop();
    const restarted = await mustStart(world);
    const again = await shopper(restarted.runtime, buyer.token);
    expect(again.draft()).toBeNull();
    expect(diskFile(world).body.workloads).toEqual([]);
    await again.submit(MIXED("for school"));
    await again.chooseLaptop();
    expect(again.record()).toBeNull();
    expect(diskFile(world).body.workloads).toEqual([]);
  });

  it("a replaced draft does not keep the recovered record", async () => {
    const { world, started, buyer } = await chosen(MIXED("to train AI models locally"));
    const oldDraft = buyer.draft()!.draftId;
    const newDraft = `nd_${"b".repeat(32)}`;
    await started.runtime.durable.change((host) => {
      const draft = needsDraftsFor(host).get(buyer.session.id)!;
      needsDraftsFor(host).set(buyer.session.id, { ...draft, draftId: newDraft, version: 1, confirmedUse: null, confirmedBudgetDollars: null });
    });
    expect(diskFile(world).body.workloads.filter((record: any) => record.draftId === oldDraft)).toEqual([]);
    expect(diskFile(world).body.workloads).toEqual([]);
  });

  it("format 7 stays the default: the store is not format 10 and holds no workload records", async () => {
    const world = await freshWorld("ordinary");
    pointAt(world, false);
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit(MIXED("to train AI models locally"));
    await buyer.chooseLaptop();
    expect(diskFile(world).format).toBe(7);
    expect(diskFile(world).body.workloads).toBeUndefined();
    await started.stop();
    expect((await start(world)).status).toBe("ready");
    expect(diskFile(world).format).toBe(7);
  });
});

describe("B1 mixed-task recovery beyond the eight-turn window", () => {
  const MIXED = "I need a charger and a laptop to train AI models locally";
  /** The mixed request, `followUps` further texts while the track is open (each charger-routed), then the laptop is chosen. */
  async function chosenAfter(text: string, followUps: number, extra: string[] = []) {
    const world = await activated();
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit(text);
    for (const line of extra) await buyer.submit(line);
    for (let i = 0; i < followUps; i++) await buyer.submit(`Thank you, follow-up ${i + 1}`);
    const retained = readConversation(started.runtime.store, buyer.session.id)?.turns ?? [];
    await buyer.chooseLaptop();
    const retainedAfterChoice = readConversation(started.runtime.store, buyer.session.id)?.turns ?? [];
    return { world, started, buyer, retainedBeforeChoice: retained, retainedAfterChoice };
  }
  const exact = (buyer: Shopper, kind: string, evidence = "inferred") => ({
    sessionId: buyer.session.id,
    draftId: buyer.draft()!.draftId,
    kind,
    sourceDraftVersion: buyer.draft()!.version,
    evidenceState: evidence,
  });

  it.each([0, 1, 2, 3, 4, 5])("the mixed request is recovered with %i follow-ups before the laptop is chosen", async (followUps) => {
    const { world, buyer, retainedBeforeChoice, retainedAfterChoice } = await chosenAfter(MIXED, followUps);
    // 2 turns per text, capped at 8. The choice itself appends one more assistant line before the recovery reads the
    // conversation, so the original request is already gone at 3 follow-ups: the exact eight-turn boundary.
    expect(retainedBeforeChoice.length).toBe(Math.min(8, 2 + 2 * followUps));
    expect(retainedBeforeChoice.some((turn) => turn.text === MIXED)).toBe(followUps <= 3);
    expect(retainedAfterChoice.some((turn) => turn.text === MIXED)).toBe(followUps <= 2);
    expect(diskFile(world).body.workloads).toEqual([exact(buyer, "local_training")]);
    expect(buyer.record()?.kind).toBe("local_training");
  });

  it("an ordinary laptop follow-up after the choice neither loses the record nor brings back the badge", async () => {
    const { world, buyer } = await chosenAfter(MIXED, 4);
    await buyer.submit("I prefer something lightweight");
    await buyer.confirm();
    expect(diskFile(world).body.workloads).toHaveLength(1);
    expect(diskFile(world).body.workloads[0]).toMatchObject({ sessionId: buyer.session.id, draftId: buyer.draft()!.draftId, kind: "local_training" });
    const { journey, html } = await buyer.cards();
    for (const line of journey.lines) expect(line.aiContext).toBe(true);
    expect(html).not.toContain("recommendation-badge");
    expect(html).toContain("AI compatibility: not verified");
    expect(html).toContain("GPU and VRAM evidence is missing");
  });

  it("survives three restarts and truncation after a late choice", { timeout: 120000 }, async () => {
    const { world, started: first, buyer: initial } = await chosenAfter(MIXED, 4);
    let buyer = initial;
    for (let i = 0; i < 9; i++) await buyer.submit(`Thank you, laptop follow-up ${i + 1}`);
    await buyer.confirm();
    let started = first;
    for (let restart = 1; restart <= 3; restart++) {
      await started.stop();
      started = await mustStart(world);
      buyer = await shopper(started.runtime, buyer.token);
      expect(buyer.record()?.kind, `restart ${restart}`).toBe("local_training");
      expect(unrecoveredWorkloadDraftsOf(started.runtime.store).size).toBe(0);
      const { journey, html } = await buyer.cards();
      for (const line of journey.lines) expect(line.aiContext).toBe(true);
      expect(html).not.toContain("recommendation-badge");
      expect(diskFile(world).body.workloads).toHaveLength(1);
    }
  });

  it("an AI requirement withdrawn inside the retained window is not recovered", async () => {
    const { world, buyer } = await chosenAfter(MIXED, 0, ["Actually, no AI"]);
    expect(diskFile(world).body.workloads).toEqual([]);
    expect(buyer.record()).toBeNull();
    await buyer.confirm();
    // No durable record, no known AI workload; the earlier AI wording still raises the conservative hint, never a badge.
    for (const line of (await buyer.cards()).journey.lines) expect(line.aiContext).toBe("potential");
  });

  it("DOCUMENTED LIMIT: a withdrawal that has itself rolled out of the window is not seen, so the original request stands (fails closed)", async () => {
    const { world, buyer } = await chosenAfter(MIXED, 4, ["Actually, no AI"]);
    expect(diskFile(world).body.workloads).toEqual([exact(buyer, "local_training")]);
  });

  it.each([
    ["hint-only wording", "I need a charger and a laptop to run models with PyTorch on my GPU"],
    ["coding only", "I need a charger and a laptop for programming in Python"],
    ["no AI", "I need a charger and a laptop, no AI"],
  ])("%s creates no record, even after the original text rolled out", async (_label, text) => {
    for (const followUps of [0, 4]) {
      const { world, buyer } = await chosenAfter(text, followUps);
      expect(diskFile(world).body.workloads, `${followUps} follow-ups`).toEqual([]);
      expect(buyer.record()).toBeNull();
    }
  });

  it("hint-only wording keeps the conservative potential-AI treatment while its text is the draft text", async () => {
    const { buyer } = await chosenAfter("I need a charger and a laptop to run models with PyTorch on my GPU", 4);
    await buyer.confirm();
    const { journey, html } = await buyer.cards();
    for (const line of journey.lines) expect(line.aiContext).toBe("potential");
    expect(html).not.toContain("recommendation-badge");
  });

  it.each([0, 4])("Spanish mixed wording is recovered with %i follow-ups", async (followUps) => {
    const { world, buyer } = await chosenAfter("Necesito un cargador y una laptop para entrenar modelos de IA localmente", followUps);
    expect(diskFile(world).body.workloads).toEqual([exact(buyer, "local_training")]);
  });

  it("an existing workload record is not overwritten, even after truncation", async () => {
    const world = await activated();
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit("I want to run LLMs locally on my laptop");
    const before = diskFile(world).body.workloads;
    expect(before).toHaveLength(1);
    await buyer.submit("I also need a charger and a laptop for school");
    for (let i = 0; i < 4; i++) await buyer.submit(`Thank you, follow-up ${i + 1}`);
    await buyer.chooseLaptop();
    expect(diskFile(world).body.workloads).toEqual(before.map((record: any) => ({ ...record })));
    expect(buyer.record()?.kind).toBe("local_inference");
  });

  it("a different draft does not inherit the original request's text", async () => {
    const { world, started, buyer } = await chosenAfter(MIXED, 0);
    expect(diskFile(world).body.workloads).toHaveLength(1);
    const newDraft = `nd_${"d".repeat(32)}`;
    await started.runtime.durable.change((host) => {
      const draft = needsDraftsFor(host).get(buyer.session.id)!;
      needsDraftsFor(host).set(buyer.session.id, { ...draft, draftId: newDraft, version: 1, shopperText: "I need a charger and a laptop for school", confirmedUse: null, confirmedBudgetDollars: null });
      setChargerTrack(host, { sessionId: buyer.session.id, draftId: newDraft, state: "task_choice", deviceId: null, revision: 1 });
    });
    await buyer.chooseLaptop();
    expect(buyer.draft()!.draftId).toBe(newDraft);
    expect(buyer.record()).toBeNull();
    expect(diskFile(world).body.workloads).toEqual([]);
  });

  it("with no stored draft text the retained conversation alone is still used", async () => {
    const world = await activated();
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit(MIXED);
    await started.runtime.durable.change((host) => {
      const draft = needsDraftsFor(host).get(buyer.session.id)!;
      needsDraftsFor(host).set(buyer.session.id, { ...draft, shopperText: "" });
    });
    await buyer.chooseLaptop();
    expect(diskFile(world).body.workloads).toEqual([exact(buyer, "local_training")]);
  });

  it("an expired draft and a revoked session leave nothing to recover", async () => {
    const expired = await chosenAfter(MIXED, 4);
    await expired.started.runtime.durable.change((host) => {
      const draft = needsDraftsFor(host).get(expired.buyer.session.id)!;
      needsDraftsFor(host).set(expired.buyer.session.id, { ...draft, expiresAtMs: 1 });
    });
    await expired.started.stop();
    const restarted = await mustStart(expired.world);
    const again = await shopper(restarted.runtime, expired.buyer.token);
    expect(again.draft()).toBeNull();
    expect(diskFile(expired.world).body.workloads).toEqual([]);

    const revoked = await chosenAfter(MIXED, 4);
    await revoked.started.runtime.sessions.revoke(revoked.buyer.session.id);
    await revoked.started.stop();
    const after = await mustStart(revoked.world);
    expect((await after.runtime.sessions.resolve(revoked.buyer.token)).ok).toBe(false);
    expect(diskFile(revoked.world).body.workloads).toEqual([]);
  });

  it("a charger-only request creates no record, and stopping the charger task recovers nothing (known limit)", async () => {
    const world = await activated();
    const started = await mustStart(world);
    const buyer = await shopper(started.runtime);
    await buyer.submit("I need a charger for my MacBook Air");
    expect(diskFile(world).body.workloads).toEqual([]);

    const mixed = await chosenAfter(MIXED, 0).then(async () => {
      const w = await activated();
      const s = await mustStart(w);
      const b = await shopper(s.runtime);
      await b.submit(MIXED);
      const draft = b.draft()!;
      const track = chargerTrackFor(s.runtime.store, b.session.id, draft.draftId)!;
      await handleChargerControl(
        new Request(`${ORIGIN}/shop/needs/charger-control`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${b.token}` },
          body: new URLSearchParams({ lang: "en", csrfToken: b.session.csrfToken, draftId: draft.draftId, revision: String(track.revision), action: "stop" }).toString(),
        }),
        s.runtime,
      );
      return { w, b };
    });
    // Stop is not the laptop choice: nothing is recorded; the intent survives only in the retained conversation.
    expect(diskFile(mixed.w).body.workloads).toEqual([]);
    expect(mixed.b.record()).toBeNull();
  });
});
