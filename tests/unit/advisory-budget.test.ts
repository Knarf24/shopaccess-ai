import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisoryFailure, type AdvisoryTransport, type AdvisoryTransportRequest } from "@/lib/providers/qwen-advisory";
import { createBudgetedAdvisoryTransport, parseAdvisoryBudget, type BudgetFiles } from "@/server/advisory-budget";
import { parseRuntimeConfig } from "@/server/config";
import { createRuntime, getApplication } from "@/server/runtime";
import { TEST_SESSION_KEY } from "./helpers";

const createPgRuntime = vi.hoisted(() => vi.fn(() => ({ constructed: true })));
vi.mock("@/server/pg-runtime", () => ({ createPgRuntime }));

const ORIGIN = "https://shop.example.test";
const MODEL_ID = "qwen3.7-plus";
const API_KEY = "test-advisory-key";
const ENDPOINT = "https://synthorai.io/v1/chat/completions";
const APPLICATION_KEY = Symbol.for("shopaccess.application");
const ENV_KEYS = [
  "SHOPACCESS_PERSISTENCE_MODE",
  "SHOPACCESS_ADVISORY_BUDGET_SLOTS",
  "SHOPACCESS_ADVISORY_BUDGET_DIR",
  "SHOPACCESS_SESSION_KEY",
  "SHOPACCESS_TRUSTED_ORIGINS",
  "PAYMENT_PROVIDER_MODE",
  "SHOPACCESS_AI_MODEL_ID",
  "SHOPACCESS_AI_ENDPOINT",
  "SHOPACCESS_AI_API_KEY",
  "NODE_ENV",
] as const;

const directories: string[] = [];

function privateDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shopaccess-budget-"));
  fs.chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

function baseEnv(): Record<string, string> {
  return {
    SHOPACCESS_SESSION_KEY: TEST_SESSION_KEY.toString("base64"),
    SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
    PAYMENT_PROVIDER_MODE: "mock",
    NODE_ENV: "production",
  };
}

function externalEnv(directory?: string): Record<string, string> {
  return {
    ...baseEnv(),
    SHOPACCESS_AI_MODEL_ID: MODEL_ID,
    SHOPACCESS_AI_ENDPOINT: ENDPOINT,
    SHOPACCESS_AI_API_KEY: API_KEY,
    ...(directory ? { SHOPACCESS_ADVISORY_BUDGET_SLOTS: "2", SHOPACCESS_ADVISORY_BUDGET_DIR: directory } : {}),
  };
}

function request(): AdvisoryTransportRequest {
  return {
    url: ENDPOINT,
    method: "POST",
    headers: {},
    body: new Uint8Array(),
    signal: new AbortController().signal,
  };
}

function response(status = 204) {
  return { status, redirected: false, headers: { get: () => null }, body: null };
}

function resetApplication(): void {
  delete (globalThis as Record<symbol, unknown>)[APPLICATION_KEY];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetApplication();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const directory of directories.splice(0)) {
    try {
      if (fs.lstatSync(directory).isSymbolicLink()) fs.unlinkSync(directory);
      else fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // The directory was already removed.
    }
  }
});

describe("advisory transport budget configuration", () => {
  it("keeps the existing configuration when both budget variables are absent", () => {
    expect(parseRuntimeConfig({})).toEqual({ ok: false, error: ["SESSION_KEY_MISSING", "TRUSTED_ORIGINS_MISSING", "PAYMENT_MODE_NOT_MOCK"] });
    const parsed = parseRuntimeConfig(baseEnv());
    expect(parsed.ok && Object.keys(parsed.value).sort()).toEqual(["advisory", "sessionKey", "trustedOrigins"]);
    if (parsed.ok) expect(parsed.value.advisory).toEqual({ mode: "local" });
    const external = parseRuntimeConfig(externalEnv());
    expect(external.ok && external.value.advisoryBudget).toBeUndefined();
  });

  it("fails closed on partial, invalid, local, in-repository, and non-private directories", () => {
    const directory = privateDirectory();
    const partial = parseRuntimeConfig({ ...externalEnv(), SHOPACCESS_ADVISORY_BUDGET_SLOTS: "2" });
    expect(partial).toEqual({ ok: false, error: ["ADVISORY_BUDGET_PARTIAL"] });
    expect(JSON.stringify(partial)).not.toContain(directory);
    expect(JSON.stringify(partial)).not.toContain(API_KEY);

    expect(parseRuntimeConfig({ ...externalEnv(), SHOPACCESS_ADVISORY_BUDGET_DIR: "" })).toEqual({ ok: false, error: ["ADVISORY_BUDGET_PARTIAL"] });
    expect(parseRuntimeConfig({ ...externalEnv(), SHOPACCESS_ADVISORY_BUDGET_SLOTS: "", SHOPACCESS_ADVISORY_BUDGET_DIR: "" })).toEqual({
      ok: false,
      error: ["ADVISORY_BUDGET_INVALID"],
    });
    expect(parseRuntimeConfig({ ...externalEnv(directory), SHOPACCESS_ADVISORY_BUDGET_SLOTS: "3" })).toEqual({ ok: false, error: ["ADVISORY_BUDGET_INVALID"] });
    expect(parseRuntimeConfig({ ...baseEnv(), SHOPACCESS_ADVISORY_BUDGET_SLOTS: "2", SHOPACCESS_ADVISORY_BUDGET_DIR: directory })).toEqual({
      ok: false,
      error: ["ADVISORY_BUDGET_INVALID"],
    });
    expect(parseRuntimeConfig({ ...externalEnv(), SHOPACCESS_ADVISORY_BUDGET_SLOTS: "2", SHOPACCESS_ADVISORY_BUDGET_DIR: "budget-slots" })).toEqual({
      ok: false,
      error: ["ADVISORY_BUDGET_INVALID"],
    });
    expect(parseRuntimeConfig({ ...externalEnv(), SHOPACCESS_ADVISORY_BUDGET_SLOTS: "2", SHOPACCESS_ADVISORY_BUDGET_DIR: path.join(process.cwd(), "src", "server") })).toEqual({
      ok: false,
      error: ["ADVISORY_BUDGET_INVALID"],
    });

    fs.chmodSync(directory, 0o755);
    expect(parseRuntimeConfig(externalEnv(directory))).toEqual({ ok: false, error: ["ADVISORY_BUDGET_INVALID"] });
    fs.chmodSync(directory, 0o700);
    const link = `${directory}-link`;
    fs.symlinkSync(directory, link, "dir");
    directories.push(link);
    expect(parseRuntimeConfig({ ...externalEnv(), SHOPACCESS_ADVISORY_BUDGET_SLOTS: "2", SHOPACCESS_ADVISORY_BUDGET_DIR: link })).toEqual({
      ok: false,
      error: ["ADVISORY_BUDGET_INVALID"],
    });

    const stat = fs.lstatSync(directory);
    const foreignOwner: BudgetFiles = {
      ...realBudgetFiles(),
      lstatSync: () => ({ uid: stat.uid + 1, mode: stat.mode, isSymbolicLink: () => false, isDirectory: () => true }),
    };
    expect(parseAdvisoryBudget(externalEnv(directory), { advisory: "external", repoRoot: process.cwd() }, foreignOwner)).toEqual({
      ok: false,
      error: "ADVISORY_BUDGET_INVALID",
    });
  });

  it("isolates a later configuration from an enabled budget", () => {
    const directory = privateDirectory();
    const enabled = parseRuntimeConfig(externalEnv(directory));
    expect(enabled.ok && enabled.value.advisoryBudget).toEqual({ mode: "on", slots: 2, directory });
    const later = parseRuntimeConfig(baseEnv());
    expect(later.ok && later.value.advisory).toEqual({ mode: "local" });
    expect(later.ok && later.value.advisoryBudget).toBeUndefined();
    expect(JSON.stringify(later)).not.toContain(API_KEY);
    expect(JSON.stringify(later)).not.toContain(directory);
  });

  it("refuses PostgreSQL mode when a budget variable is present and preserves it when both are absent", () => {
    process.env.SHOPACCESS_PERSISTENCE_MODE = "postgres";
    process.env.SHOPACCESS_ADVISORY_BUDGET_DIR = privateDirectory();
    resetApplication();
    const refused = getApplication();
    expect(createPgRuntime).not.toHaveBeenCalled();
    expect(refused).toEqual({ mode: "mock", runtime: { ok: false, error: ["ADVISORY_BUDGET_INVALID"] } });

    delete process.env.SHOPACCESS_ADVISORY_BUDGET_DIR;
    resetApplication();
    createPgRuntime.mockClear();
    const allowed = getApplication();
    expect(createPgRuntime).toHaveBeenCalledTimes(1);
    expect(allowed.mode).toBe("postgres");
    expect(getApplication()).toBe(allowed);
  });
});

describe("advisory transport budget reservations", () => {
  it("forwards through the injected runtime transport and retains the slot when that transport fails", async () => {
    const directory = privateDirectory();
    const parsed = parseRuntimeConfig(externalEnv(directory));
    if (!parsed.ok || !parsed.value.advisoryBudget) throw new Error("expected the budget to be enabled");
    let calls = 0;
    const transport: AdvisoryTransport = async (incoming) => {
      calls += 1;
      expect(incoming.url).toBe(ENDPOINT);
      throw new Error("downstream");
    };
    vi.stubGlobal("fetch", () => {
      throw new Error("network is not used");
    });
    const runtime = createRuntime(parsed.value, { transport });
    await expect(runtime.ai.suggestProducts({ instructions: "Advisory only.", untrustedData: { shopperMessage: "Laptop for Programming", products: [] } })).rejects.toBeInstanceOf(AdvisoryFailure);
    expect(calls).toBe(1);
    expect(fs.readdirSync(directory).sort()).toEqual(["slot-1"]);
    await expect(runtime.ai.suggestProducts({ instructions: "Advisory only.", untrustedData: { shopperMessage: "Laptop for Programming", products: [] } })).rejects.toBeInstanceOf(AdvisoryFailure);
    expect(calls).toBe(2);
    expect(fs.readdirSync(directory).sort()).toEqual(["slot-1", "slot-2"]);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("slot-"))).toHaveLength(2);
  });

  it("allows two concurrent forwards and refuses the rest without a retry", async () => {
    const directory = privateDirectory();
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = createBudgetedAdvisoryTransport(directory, async () => {
      started += 1;
      await gate;
      return response(200);
    }, process.cwd());
    const pending = Promise.allSettled([transport(request()), transport(request()), transport(request()), transport(request())]);
    expect(started).toBe(2);
    release();
    const settled = await pending;
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(2);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(2);
    expect(started).toBe(2);
    expect(fs.readdirSync(directory).sort()).toEqual(["slot-1", "slot-2"]);
  });

  it("shares the two slots across processes", async () => {
    const directory = privateDirectory();
    const outcomes = await Promise.all([workerAttempt(directory), workerAttempt(directory), workerAttempt(directory)]);
    expect(outcomes.sort()).toEqual(["forwarded", "forwarded", "refused"]);
    expect(fs.readdirSync(directory).sort()).toEqual(["slot-1", "slot-2"]);
  });

  it("refuses forwarding when open, write, or close fails and keeps a consumed slot", async () => {
    const directory = privateDirectory();
    const calls = { count: 0 };
    const transport = createBudgetedAdvisoryTransport(directory, transportInner(calls), process.cwd());

    const opened = createBudgetedAdvisoryTransport(directory, transportInner(calls), process.cwd(), {
      ...realBudgetFiles(),
      openSync: () => {
        throw Object.assign(new Error("open failed"), { code: "EIO" });
      },
    });
    await expect(opened(request())).rejects.toMatchObject({ code: "TRANSPORT" });
    expect(calls.count).toBe(0);
    expect(fs.readdirSync(directory)).toEqual([]);

    const written = createBudgetedAdvisoryTransport(directory, transportInner(calls), process.cwd(), {
      ...realBudgetFiles(),
      writeSync: () => {
        throw new Error("write failed");
      },
    });
    await expect(written(request())).rejects.toMatchObject({ code: "TRANSPORT" });
    expect(calls.count).toBe(0);
    expect(fs.readdirSync(directory).sort()).toEqual(["slot-1"]);

    const closed = createBudgetedAdvisoryTransport(directory, transportInner(calls), process.cwd(), {
      ...realBudgetFiles(),
      closeSync: (fd) => {
        fs.closeSync(fd);
        throw new Error("close failed");
      },
    });
    await expect(closed(request())).rejects.toMatchObject({ code: "TRANSPORT" });
    expect(calls.count).toBe(0);
    expect(fs.readdirSync(directory).sort()).toEqual(["slot-1", "slot-2"]);

    await expect(transport(request())).rejects.toMatchObject({ code: "TRANSPORT" });
    expect(calls.count).toBe(0);
  });
});

function realBudgetFiles(): BudgetFiles {
  return {
    openSync: (file, flags, mode) => fs.openSync(file, flags, mode),
    writeSync: (fd, data) => fs.writeSync(fd, data),
    closeSync: (fd) => {
      fs.closeSync(fd);
    },
    lstatSync: (file) => fs.lstatSync(file),
  };
}

function transportInner(calls: { count: number }): AdvisoryTransport {
  return async () => {
    calls.count += 1;
    return response();
  };
}

function workerAttempt(directory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(new URL("./advisory-budget.child.mjs", import.meta.url)), {
      execArgv: ["--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", fileURLToPath(new URL("./advisory-budget-register.mjs", import.meta.url))],
      workerData: { directory },
    });
    let message = "";
    worker.on("message", (value) => {
      message = String(value);
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code === 0) resolve(message);
      else reject(new Error(`budget worker exited ${code}`));
    });
  });
}
