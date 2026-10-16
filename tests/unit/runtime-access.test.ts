import { describe, expect, it, vi } from "vitest";

import { createRuntimeAccess, type RuntimeAccessDeps } from "../../src/server/runtime-access";
import type { Application, MockStoreSettings } from "../../src/server/runtime";
import type { FoundationStore } from "../../src/lib/session/snapshot-store";
import type { StateGate } from "../../src/lib/session/snapshot-state";

// M2-1: openRuntime's startup barrier, exercised through injected dependencies (not inferred from source).
const memoryApplication = { mode: "invalid" } as Application;
const snapshotApplication = { mode: "mock", runtime: { ok: false, error: [] } } as unknown as Application;
const requested: MockStoreSettings = { state: "requested", directory: "/private/store", keyFile: "/private/key", mode: "mock" };
const fakeStore = { readPublished: () => ({ status: "unavailable" }), commit: async () => ({ status: "unavailable", outcome: "definite" }) } as FoundationStore;
const fakeGate = {} as StateGate;

function deps(patch: Partial<RuntimeAccessDeps> = {}) {
  let releaseOpen: () => void = () => {};
  const opened = new Promise<void>((resolve) => (releaseOpen = resolve));
  const base: RuntimeAccessDeps = {
    settings: () => requested,
    memory: vi.fn(() => memoryApplication),
    openStore: vi.fn(async () => {
      await opened;
      return { status: "ready" as const, value: fakeStore };
    }),
    recover: vi.fn(async () => ({ status: "ready" as const, gate: fakeGate, interrupted: { interpretations: 0, recommendations: 0 }, droppedSessions: 0 })),
    build: vi.fn(() => snapshotApplication),
    now: () => new Date("2026-10-16T12:00:00.000Z"),
    report: vi.fn(),
    ...patch,
  };
  return { deps: base, releaseOpen };
}

describe("runtime access", () => {
  it("returns the in-memory application unchanged when no snapshot setting is present, and opens nothing", async () => {
    const { deps: d } = deps({ settings: () => ({ state: "absent" }) });
    const access = createRuntimeAccess(d);
    expect(await access.open()).toEqual({ status: "ready", application: memoryApplication });
    expect(d.openStore).not.toHaveBeenCalled();
  });

  it("shares one startup between concurrent callers; nobody gets a runtime before recovery completes", async () => {
    const { deps: d, releaseOpen } = deps();
    const access = createRuntimeAccess(d);
    const calls = [access.open(), access.open(), access.open()];
    let settled = 0;
    for (const call of calls) void call.then(() => (settled += 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(0);
    expect(d.build).not.toHaveBeenCalled();
    releaseOpen();
    const results = await Promise.all(calls);
    for (const result of results) expect(result).toEqual({ status: "ready", application: snapshotApplication });
    expect(d.openStore).toHaveBeenCalledTimes(1);
    expect(d.recover).toHaveBeenCalledTimes(1);
    expect(d.build).toHaveBeenCalledTimes(1);
    expect(await access.open()).toBe(results[0]);
    expect(d.openStore).toHaveBeenCalledTimes(1);
  });

  it("a failed open stays unavailable for the life of the process and is not retried", async () => {
    const { deps: d } = deps({ openStore: vi.fn(async () => ({ status: "unavailable" as const, code: "store-mode" })) });
    const access = createRuntimeAccess(d);
    const [first, second] = await Promise.all([access.open(), access.open()]);
    expect(first).toEqual({ status: "unavailable", code: "open-store-mode" });
    expect(second).toBe(first);
    expect(await access.open()).toBe(first);
    expect(d.openStore).toHaveBeenCalledTimes(1);
    expect(d.build).not.toHaveBeenCalled();
    expect(d.memory).not.toHaveBeenCalled();
  });

  it("a refused recovery commit builds no runtime", async () => {
    const { deps: d } = deps({ recover: vi.fn(async () => ({ status: "unavailable" as const, code: "recovery-commit-indeterminate" })) });
    const access = createRuntimeAccess({ ...d, openStore: vi.fn(async () => ({ status: "ready" as const, value: fakeStore })) });
    expect(await access.open()).toEqual({ status: "unavailable", code: "recovery-commit-indeterminate" });
    expect(d.build).not.toHaveBeenCalled();
  });

  it("a startup that throws is unavailable, not a crash and not the in-memory runtime", async () => {
    const { deps: d } = deps({ openStore: vi.fn(async () => { throw new Error("boom"); }) });
    const access = createRuntimeAccess(d);
    expect(await access.open()).toEqual({ status: "unavailable", code: "startup-error" });
    expect(d.memory).not.toHaveBeenCalled();
  });

  it("an incomplete setting fails closed instead of falling back to memory", async () => {
    for (const settings of [
      { state: "requested", directory: "/private/store", keyFile: null, mode: "mock" },
      { state: "requested", directory: null, keyFile: "/private/key", mode: "mock" },
    ] as const) {
      const { deps: d } = deps({ settings: () => settings });
      const access = createRuntimeAccess(d);
      expect(await access.open()).toEqual({ status: "unavailable", code: "MOCK_STORE_SETTINGS_INCOMPLETE" });
      expect(d.openStore).not.toHaveBeenCalled();
      expect(d.memory).not.toHaveBeenCalled();
    }
  });

  it("PostgreSQL mode with a snapshot setting fails closed without opening anything", async () => {
    const { deps: d } = deps({ settings: () => ({ ...requested, mode: "postgres" as const }) });
    const access = createRuntimeAccess(d);
    expect(await access.open()).toEqual({ status: "unavailable", code: "MOCK_STORE_UNSUPPORTED" });
    expect(d.openStore).not.toHaveBeenCalled();
    expect(d.memory).not.toHaveBeenCalled();
  });

  it("diagnostics name the storage mode and a code, never a path", async () => {
    const { deps: d } = deps({ openStore: vi.fn(async () => ({ status: "unavailable" as const, code: "key-file" })) });
    await createRuntimeAccess(d).open();
    const lines = (d.report as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual(["shopaccess: storage mode=snapshot status=unavailable code=open-key-file"]);
    expect(lines.join(" ")).not.toContain("/private");
  });

  // Review correction: an invalid SHOPACCESS_PERSISTENCE_MODE is refused before snapshot storage is touched.
  it("an invalid persistence mode fails closed with no store open, no recovery write and no runtime construction", async () => {
    const commit = vi.fn();
    const { deps: d } = deps({ settings: () => ({ ...requested, mode: "invalid" as const }) });
    const access = createRuntimeAccess({ ...d, recover: vi.fn(async (store) => { await store.commit({}); commit(); return { status: "unavailable" as const, code: "x" }; }) });
    const [first, second] = await Promise.all([access.open(), access.open()]);
    expect(first).toEqual({ status: "unavailable", code: "PERSISTENCE_MODE_INVALID" });
    expect(second).toBe(first);
    expect(d.openStore).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(d.build).not.toHaveBeenCalled();
    expect(d.memory).not.toHaveBeenCalled();
  });

  it("reads an unrecognised persistence mode as invalid in the snapshot settings", async () => {
    const { mockStoreSettings } = await import("../../src/server/runtime");
    const saved = { ...process.env };
    try {
      process.env.SHOPACCESS_PERSISTENCE_MODE = "bogus";
      process.env.SHOPACCESS_MOCK_STORE_DIR = "/nonexistent/store";
      process.env.SHOPACCESS_MOCK_STORE_KEY_FILE = "/nonexistent/key";
      expect(mockStoreSettings()).toEqual({ state: "requested", directory: "/nonexistent/store", keyFile: "/nonexistent/key", mode: "invalid" });
      process.env.SHOPACCESS_PERSISTENCE_MODE = "";
      expect(mockStoreSettings()).toMatchObject({ mode: "invalid" });
      delete process.env.SHOPACCESS_PERSISTENCE_MODE;
      expect(mockStoreSettings()).toMatchObject({ mode: "mock" });
    } finally {
      for (const key of ["SHOPACCESS_PERSISTENCE_MODE", "SHOPACCESS_MOCK_STORE_DIR", "SHOPACCESS_MOCK_STORE_KEY_FILE"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

