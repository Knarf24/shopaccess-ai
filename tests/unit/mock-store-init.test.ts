import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/lib/shared/canonical-json";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NODE = "/usr/local/bin/node";
const HOOK = join(ROOT, "scripts", "mock-store-load-hook.mjs");
const INIT = join(ROOT, "src", "server", "mock-store-init.mts");
const RACE = "macOS can reuse a pid between the identity match and the signal; a signal is sent only after a match";
const KEY = Buffer.from("initializer-fixture-key");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("mock store initializer", () => {
  it("loads the snapshot module and fs-ext without creating a directory or a lock", async () => {
    const directory = privateDirectory();
    const result = await run([NODE, "--experimental-strip-types", "--import", HOOK, INIT, "--check-load"], directory);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("loaded\n");
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("rejects an @/ specifier in the load hook", async () => {
    const directory = privateDirectory();
    const fixture = join(directory, "alias.mts");
    fs.writeFileSync(fixture, 'import "@/lib/session/store";\n');
    const result = await run([NODE, "--experimental-strip-types", "--import", HOOK, fixture], directory);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/ERR_INVALID_MODULE_SPECIFIER|Bare alias/);
  });

  it("writes one empty snapshot and does not overwrite an existing file", async () => {
    const parent = privateDirectory();
    const directory = join(parent, "store");
    const keyFile = writeKey(parent);
    const created = await run(initArgs(directory, keyFile), parent);
    expect(created.code).toBe(0);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    const file = join(directory, "store.json");
    const first = fs.readFileSync(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(join(directory, "writer.lock")).isFile()).toBe(true);
    expect(canonicalJson(JSON.parse(first.toString("utf8")).body)).toBe(canonicalJson(emptyBody()));
    expect(JSON.parse(first.toString("utf8")).identity).toBe(identityFor(KEY));
    const again = await run(initArgs(directory, keyFile), parent);
    expect(again.code).not.toBe(0);
    expect(fs.readFileSync(file).equals(first)).toBe(true);
    expect(fs.existsSync(join(directory, "writer.lock"))).toBe(true);
  });

  it("lets the flock loser write nothing and keeps the lock", async () => {
    const parent = privateDirectory();
    const directory = join(parent, "store");
    fs.mkdirSync(directory, { mode: 0o700 });
    const keyFile = writeKey(parent);
    const first = start(initArgs(directory, keyFile));
    const second = start(initArgs(directory, keyFile));
    const results = await Promise.all([first.finish(), second.finish()]);
    expect(results.filter((code) => code === 0)).toHaveLength(1);
    expect(results.filter((code) => code !== 0)).toHaveLength(1);
    expect(fs.existsSync(join(directory, "writer.lock"))).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(join(directory, "store.json"), "utf8"));
    expect(canonicalJson(parsed.body)).toBe(canonicalJson(emptyBody()));
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("store.json"))).toEqual(["store.json"]);
  });

  it("revalidates EEXIST and still lets only one initializer write", async () => {
    const parent = privateDirectory();
    const directory = join(parent, "store");
    const keyFile = writeKey(parent);
    const first = start(initArgs(directory, keyFile));
    const second = start(initArgs(directory, keyFile));
    const results = await Promise.all([first.finish(), second.finish()]);
    expect(results.filter((code) => code === 0)).toHaveLength(1);
    expect(fs.statSync(directory).isDirectory()).toBe(true);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(join(directory, "writer.lock"))).toBe(true);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("store.json"))).toEqual(["store.json"]);
  });

  it("does not use or chmod a directory whose mode is 0755", async () => {
    const parent = privateDirectory();
    const directory = join(parent, "store");
    fs.mkdirSync(directory, { mode: 0o755 });
    fs.chmodSync(directory, 0o755);
    const keyFile = writeKey(parent);
    const result = await run(initArgs(directory, keyFile), parent);
    expect(result.code).not.toBe(0);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(join(directory, "store.json"))).toBe(false);
    expect(fs.existsSync(join(directory, "writer.lock"))).toBe(false);
  });

  it("does not follow a symlink directory", async () => {
    const parent = privateDirectory();
    const target = join(parent, "target");
    fs.mkdirSync(target, { mode: 0o700 });
    const link = join(parent, "link");
    fs.symlinkSync(target, link);
    const keyFile = writeKey(parent);
    const result = await run(initArgs(link, keyFile), parent);
    expect(result.code).not.toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});

function emptyBody() {
  return { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [] };
}

function identityFor(key: Buffer): string {
  return createHash("sha256").update(Buffer.concat([Buffer.from("shopaccess.mock-store.v1"), Buffer.from([0]), key])).digest("hex");
}

function initArgs(directory: string, keyFile: string): string[] {
  return [NODE, "--experimental-strip-types", "--import", HOOK, INIT, "--directory", directory, "--key-file", keyFile];
}

function privateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "sa-init-"));
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

function run(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = start(args, cwd);
  return child.finish().then(async (code) => ({ code, stdout: await child.stdout, stderr: await child.stderr }));
}

function start(args: string[], cwd = ROOT) {
  const previous = process.umask();
  process.umask(0o077);
  const child = spawn(args[0]!, args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  process.umask(previous);
  const identity = readIdentity(child.pid ?? -1);
  if (!identity) throw new Error(`identity probe failed; ${RACE}`);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  let finished: Promise<number | null> | null = null;
  return {
    stdout,
    stderr,
    finish() {
      if (finished) return finished;
      finished = (async () => {
        const first = await waitExit(child, 10_000);
        if (!first.timedOut) return first.code;
        const current = readIdentity(child.pid ?? -1);
        if (!current || !same(current, identity)) throw new Error(`unaccounted initializer; ${RACE}`);
        process.kill(child.pid ?? -1, "SIGTERM");
        const second = await waitExit(child, 5000);
        if (second.timedOut) throw new Error(`initializer did not exit; ${RACE}`);
        return second.code;
      })();
      return finished;
    },
  };
}

type Identity = { pid: number; ppid: number; lstart: string };

function readIdentity(pid: number): Identity | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,lstart="], { timeout: 5000, killSignal: "SIGKILL", encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), lstart: match[3] ?? "" };
}

function same(left: Identity, right: Identity): boolean {
  return left.pid === right.pid && left.ppid === right.ppid && left.lstart === right.lstart;
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
