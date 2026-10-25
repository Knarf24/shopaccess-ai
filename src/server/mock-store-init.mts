import fsExt from "fs-ext";

import { openFoundationStore } from "../lib/session/snapshot-store";

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--check-load") {
  if (typeof openFoundationStore !== "function" || typeof fsExt.flock !== "function") process.exit(1);
  if (typeof fsExt.constants?.LOCK_EX !== "number" || typeof fsExt.constants?.LOCK_NB !== "number") process.exit(1);
  process.stdout.write("loaded\n");
  process.exit(0);
}

const directory = flag("--directory");
const keyFile = flag("--key-file");
if (!directory || !keyFile || args.length !== 4) process.exit(1);

const opened = await openFoundationStore(directory, new Uint8Array(), { initializeEmpty: { keyFile }, format8TestStore: process.env.SHOPACCESS_CHARGER_BUDGET_TEST_STORE === "1" });
if (opened.status !== "ready") process.exit(1);
const published = opened.value.readPublished();
process.exit(published.status === "ready" ? 0 : 1);

function flag(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}
