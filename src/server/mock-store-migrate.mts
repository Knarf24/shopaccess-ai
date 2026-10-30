import { createHash } from "node:crypto";
import fs from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "../lib/shared/canonical-json";
import { convertBodyToWorkloadBody } from "../lib/session/snapshot-migration";
import { openFoundationStoreWithKeyFile, type PublishedBody } from "../lib/session/snapshot-store";

/**
 * Offline conversion of a mock snapshot store from format 1 to 7 into format 10. Explicit, never run at startup, and
 * imported by nothing in the application.
 *
 *   node --experimental-strip-types --import scripts/mock-store-load-hook.mjs src/server/mock-store-migrate.mts \
 *     --source-directory D --key-file K --backup-directory B (--dry-run | --convert)
 *
 * All three paths and exactly one mode are required. The application must be stopped: the source is opened through the
 * store's own validated open (exclusive writer lock, key identity, permissions, symlink and checksum checks), so a
 * running application, a second conversion or an insecure store is refused. Formats 8, 9 and 10 are refused untouched.
 *
 * --dry-run validates the source and the paths and reports the format and how many legacy markers a conversion would
 * write. It creates and writes nothing. --convert first copies store.json byte for byte into the NEW directory B (mode
 * 0700, file 0600; B must not exist and must not overlap the source, compared by canonical path so symlinked ancestors
 * are seen), verifies that copy independently (it must open as a valid store under the same key with the same format,
 * identity and body, and be byte-identical; that open leaves a `writer.lock` beside it, so the backup holds
 * store.json and writer.lock), then writes the converted body through the store's one validated atomic commit, then
 * reopens the result in workload mode and compares it.
 *
 * What a backup is, and is not:
 *  - The encryption key is NOT copied. Keep the original key file separately: a backup is unreadable without it.
 *  - Conversion is one-way. This tool never restores a backup, never sets SHOPACCESS_WORKLOAD_RECORDS and never retries.
 *  - Restoring a backup is a manual, offline step with the application stopped; it discards every write made after the
 *    backup was taken, including purchase-permission outcomes. Do not restore while checkout activity is going on.
 *  - If backup verification fails, the backup directory is left in place for inspection, and the next conversion
 *    attempt refuses that path (backup-exists) until it is removed or another path is given. The source is untouched.
 *  - Older format-10 readers (without the optional legacyDrafts key) reject a converted file and stay unavailable.
 *
 * Outcomes (one line on stdout, codes and counts only: no key bytes, no shopper data; `source=` says what happened to
 * the source store):
 *   exit 0  status=dry-run | converted        source=unchanged | converted
 *   exit 1  status=refused | failed           source=unchanged   (stopped before the source commit)
 *   exit 2  usage error                       (nothing was read)
 *   exit 3  status=indeterminate              source=unknown     (the rename may or may not be durable; investigate
 *                                                                 the store and the backup before any retry)
 *   exit 4  status=unverified                 source=unknown     (the commit was reported, but the result could not
 *                                                                 be verified, or the source changed unexpectedly)
 * After exit 3 or 4 nothing is restored automatically.
 */
export type Hooks = {
  readonly directoryFsync?: (fd: number) => Promise<void>;
  readonly temporaryWrite?: (fd: number, bytes: Buffer) => Promise<void>;
  readonly afterBackup?: () => Promise<void>;
};
export type Args = { readonly source: string; readonly keyFile: string; readonly backup: string; readonly mode: "dry-run" | "convert" };
export type Report =
  | { readonly status: "dry-run"; readonly fromFormat: number; readonly legacyDrafts: number }
  | { readonly status: "converted"; readonly fromFormat: number; readonly legacyDrafts: number; readonly backup: string }
  | { readonly status: "refused" | "failed"; readonly code: string; readonly backup?: string }
  | { readonly status: "indeterminate" | "unverified"; readonly code: string; readonly backup: string };

const refused = (code: string): Report => ({ status: "refused", code });

export async function migrateStore(args: Args, hooks: Hooks = {}, now: Date = new Date()): Promise<Report> {
  const env = process.env;
  if (env.SHOPACCESS_WORKLOAD_RECORDS === "1" || env.SHOPACCESS_CHARGER_BUDGET_TEST_STORE === "1") return refused("conflicting-environment");
  const source = resolve(args.source);
  const backup = resolve(args.backup);
  const lock = lstat(resolve(source, "writer.lock"));
  if (!lock || !lock.isFile()) return refused("lock-file-missing");
  const backupParent = lstat(dirname(backup));
  if (!backupParent || backupParent.isSymbolicLink() || !backupParent.isDirectory()) return refused("backup-parent");
  // Compare canonical locations: every existing ancestor is resolved, so a backup reached through a symlinked ancestor,
  // or spelled with ".." parts, is seen where it really is. Nothing is created here.
  let realSource: string;
  let realBackup: string;
  try {
    realSource = fs.realpathSync(source);
    realBackup = join(fs.realpathSync(dirname(backup)), basename(backup));
  } catch {
    return refused("backup-parent");
  }
  if (realBackup === realSource || realBackup.startsWith(realSource + sep) || realSource.startsWith(realBackup + sep)) return refused("backup-overlaps-source");
  if (lstat(realBackup)) return refused("backup-exists");

  const opened = await openFoundationStoreWithKeyFile(source, args.keyFile, {
    convertLegacyTo10: true,
    ...(hooks.directoryFsync ? { directoryFsync: hooks.directoryFsync } : {}),
    ...(hooks.temporaryWrite ? { temporaryWrite: hooks.temporaryWrite } : {}),
  });
  if (opened.status !== "ready") return refused(`open-${opened.code}`);
  const store = opened.value;
  // Where an unexpected error would leave the source: before the commit nothing changed; during it the outcome is
  // unknown; after it the result is unverified. An unexpected error is reported, never thrown at the caller.
  let stage: "before" | "commit" | "after" = "before";
  let closed = false;
  const release = async () => {
    if (!closed) {
      closed = true;
      await store.close?.();
    }
  };
  try {
    const published = store.readPublished();
    if (published.status !== "ready") return refused("snapshot-unavailable");
    const fromFormat = published.value.format;
    let converted: PublishedBody;
    try {
      converted = convertBodyToWorkloadBody(published.value.body, now) as PublishedBody;
    } catch {
      return { status: "failed", code: "convert" };
    }
    const legacyDrafts = converted.legacyDrafts?.length ?? 0;
    if (args.mode === "dry-run") return { status: "dry-run", fromFormat, legacyDrafts };

    const sourceBytes = readFile(resolve(source, "store.json"));
    if (!sourceBytes) return { status: "failed", code: "source-read" };
    const made = writeBackup(realBackup, sourceBytes);
    if (made) return { status: "failed", code: made };
    const checked = await verifyCopy(realBackup, args.keyFile, fromFormat, published.value.identity, (body) => canonicalJson(body) === canonicalJson(published.value.body), false);
    const backupBytes = readFile(resolve(realBackup, "store.json"));
    if (!checked || !backupBytes || !backupBytes.equals(sourceBytes)) {
      return { status: "failed", code: "backup-verify", backup };
    }
    if (hooks.afterBackup) await hooks.afterBackup();

    stage = "commit";
    const committed = await store.commit(converted);
    if (committed.status !== "ready") {
      if (committed.outcome === "indeterminate") {
        await release();
        return { status: "indeterminate", code: "commit-indeterminate", backup };
      }
      const now_ = readFile(resolve(source, "store.json"));
      return now_ && now_.equals(sourceBytes)
        ? { status: "refused", code: "commit-refused-source-unchanged", backup }
        : { status: "unverified", code: "commit-refused-source-changed", backup };
    }
    stage = "after";
    await release();

    if (!(await verifyCopy(source, args.keyFile, 10, published.value.identity, (body) => canonicalJson(body) === canonicalJson(converted), true))) {
      return { status: "unverified", code: "post-verify", backup };
    }
    return { status: "converted", fromFormat, legacyDrafts, backup };
  } catch {
    return stage === "before" ? { status: "failed", code: "unexpected-error" } : { status: stage === "commit" ? "indeterminate" : "unverified", code: "unexpected-error", backup: args.backup };
  } finally {
    await release();
  }
}

/** Opens `directory` through the store's own validated open and checks its format, identity and body. Writes nothing. */
async function verifyCopy(directory: string, keyFile: string, format: number, identity: string, sameBody: (body: PublishedBody) => boolean, workload: boolean): Promise<boolean> {
  const opened = await openFoundationStoreWithKeyFile(directory, keyFile, workload ? { workloadRecords: true } : {});
  if (opened.status !== "ready") return false;
  try {
    const read = opened.value.readPublished();
    return read.status === "ready" && read.value.format === format && read.value.identity === identity && sameBody(read.value.body);
  } finally {
    await opened.value.close?.();
  }
}

function lstat(path: string): fs.Stats | null {
  try {
    return fs.lstatSync(path);
  } catch {
    return null;
  }
}

function readFile(path: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Creates the backup directory (0700, new) and copies the bytes into it (0600). Returns a code on failure, after removing what it made. */
function writeBackup(backup: string, bytes: Buffer): string | null {
  try {
    fs.mkdirSync(backup, { mode: 0o700 });
  } catch {
    return "backup-create";
  }
  try {
    const fd = fs.openSync(resolve(backup, "store.json"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directory = fs.openSync(backup, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    return null;
  } catch {
    try {
      fs.chmodSync(backup, 0o700);
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      // Left in place for inspection; the next attempt refuses this path.
    }
    return "backup-write";
  }
}

export function parseArgs(argv: readonly string[]): Args | null {
  const flags = new Map<string, string>();
  let mode: Args["mode"] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run" || arg === "--convert") {
      const next = arg === "--dry-run" ? "dry-run" : "convert";
      if (mode && mode !== next) return null;
      mode = next;
    } else if (arg === "--source-directory" || arg === "--key-file" || arg === "--backup-directory") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--") || flags.has(arg)) return null;
      flags.set(arg, value);
      i += 1;
    } else {
      return null;
    }
  }
  const source = flags.get("--source-directory");
  const keyFile = flags.get("--key-file");
  const backup = flags.get("--backup-directory");
  if (!source || !keyFile || !backup || !mode || flags.size !== 3) return null;
  return { source, keyFile, backup, mode };
}

/** What happened to the source store, for the machine-readable line. */
export function sourceState(report: Report): "unchanged" | "converted" | "unknown" {
  if (report.status === "converted") return "converted";
  return report.status === "indeterminate" || report.status === "unverified" ? "unknown" : "unchanged";
}

export function exitCode(report: Report): number {
  if (report.status === "dry-run" || report.status === "converted") return 0;
  return report.status === "indeterminate" ? 3 : report.status === "unverified" ? 4 : 1;
}

export function line(report: Report): string {
  const fields = Object.entries(report).map(([key, value]) => `${key}=${value}`);
  return [...fields, `source=${sourceState(report)}`].join(" ");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write("usage: mock-store-migrate.mts --source-directory D --key-file K --backup-directory B (--dry-run | --convert)\n");
    process.exit(2);
  }
  const report = await migrateStore(args);
  process.stdout.write(`${line(report)}\n`, () => process.exit(exitCode(report)));
}
