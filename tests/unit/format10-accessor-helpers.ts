import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { openFoundationStore, type OpenOptions } from "../../src/lib/session/snapshot-store";

/** Shared setup for the real process-accessor tests: one disposable store, an isolated environment, and cleanup. */
export const ORIGIN = "https://shop.example.test";
const MANAGED = (name: string) => /^(SHOPACCESS_|PAYPAL_)/.test(name) || name === "PAYMENT_PROVIDER_MODE";

export function isolatedEnvironment(extra: Record<string, string>): () => void {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([name]) => MANAGED(name)));
  for (const name of Object.keys(process.env)) if (MANAGED(name)) delete process.env[name];
  Object.assign(process.env, {
    SHOPACCESS_SESSION_KEY: Buffer.alloc(32, 12).toString("base64"),
    SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
    PAYMENT_PROVIDER_MODE: "mock",
    ...extra,
  });
  return () => {
    for (const name of Object.keys(process.env)) if (MANAGED(name)) delete process.env[name];
    Object.assign(process.env, saved);
  };
}

export async function disposableStore(options: OpenOptions): Promise<{ dir: string; keyFile: string; remove: () => void }> {
  const dir = fs.mkdtempSync(join(tmpdir(), "sa-b1-accessor-"));
  fs.chmodSync(dir, 0o700);
  const key = Buffer.from("isolated-format10-b1-accessor-key");
  const keyFile = join(dir, "identity.key");
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  const opened = await openFoundationStore(dir, key, { ...options, initializeEmpty: { keyFile } });
  if (opened.status !== "ready") throw new Error(`fresh store failed: ${opened.code}`);
  await opened.value.close?.();
  return {
    dir,
    keyFile,
    remove: () => {
      if (!dir.startsWith(tmpdir() + sep)) throw new Error("refusing to remove a path outside the temp directory");
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const formatOnDisk = (dir: string): number => (JSON.parse(fs.readFileSync(join(dir, "store.json"), "utf8")) as { format: number }).format;
