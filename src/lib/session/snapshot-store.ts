import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";

import fsExt from "fs-ext";

import { canonicalJson } from "../shared/canonical-json";
import { validateWorkloadRecord, type WorkloadRecord } from "../readiness/workload-record";
import type { NeedsDraft, RetainedRecommendation, SessionRecord } from "./store";

/**
 * Format 10 (Release A, compatibility only) is the format-9 body: format 7 plus a `workloads` array, and no charger
 * budgets. It is reachable only through the explicit `workloadRecords` option (the setting SHOPACCESS_WORKLOAD_RECORDS=1),
 * and that mode is strict: it opens only format-10 stores and writes format 10. Ordinary mode refuses a format-10 store
 * with an explicit code and never rewrites it. Release A never converts a format-7 store to format 10: the workload
 * mode refuses a format-7 store, and a fresh format-10 store exists only through `initializeEmpty`. There is no
 * downgrade writer. See docs/workload-record-snapshot-format.md.
 *
 * Format 8 is available only through the explicit format8TestStore option on a fresh test store. It adds an optional
 * charger budget to a confirmed track. This mode refuses all earlier formats; ordinary mode refuses format 8.
 * Neither mode migrates a format-7 store to format 8. See docs/charger-budget-test-store.md.
 *
 * Format 7 (proposed, F03 conversation slice 1; merge separately gated) appends `chargerTracks`: one charger
 * clarification record per session, bound to that session's current draft (see charger-clarification.ts). It also lets
 * an assistant conversation line hold one of the five charger line keys. Formats 1–6 are still read and upgrade with
 * an empty track list; a format-6 file holds no charger line, so none is accepted there. A program that accepts only
 * format 6 or older cannot read a format-7 file and stays unavailable. No owner or rehearsal store migration is
 * authorized by this change.
 *
 * Format 6 appends `profileRevisions`: the last issued profile version for a session whose profile row is gone.
 * A marker is `{ sessionId, version }` only. It stores no brand and no model. Formats 1–5 are still read.
 * Formats 1–4 upgrade with empty profiles and empty markers. Format 5 upgrades with an empty marker list,
 * because that file did not record a version after deletion. The next successful commit, including startup
 * recovery, rewrites the file as format 6.
 * There is no downgrade writer and no code that restores a backup. A program that accepts only an older
 * format cannot read a format-6 file and stays unavailable. Restoring a copy of store.json taken before
 * a later commit discards every snapshot write made after the copy, including purchase-permission outcomes
 * and revision markers saved in the same file. Do not restore that copy while payment or checkout activity
 * is still going on.
 */
const FORMAT = 7;
/** Format 6: revision markers, no charger tracks. Read upgraded with an empty track list. */
const FORMAT_6 = 6;
/** Format 5: device profiles, no revision markers. Read upgraded with an empty marker list. */
const FORMAT_5 = 5;
/** Format 4 (M2-3): purchase permissions, no device profiles. Read upgraded with an empty profile list. */
const FORMAT_4 = 4;
/** Format 3 (M2-2): no purchase permissions. Read upgraded with an empty permission list. */
const FORMAT_3 = 3;
/** Format 2 (M2-1): no extension grants. Read upgraded with empty grant and permission lists. */
const PREVIOUS_FORMAT = 2;
/** Format-1 files (sessions and drafts only) are still read; they are upgraded in memory and rewritten as the current format on the next commit. */
const LEGACY_FORMAT = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SESSIONS = 500;
const MAX_DRAFTS = 500;
const MAX_ALLOCATION_COUNT = 30;
const MAX_RECOMMENDATIONS = 30;
/** Conversation lines kept per session. Matches MAX_CONVERSATION_TURNS: eight lines (shopper or assistant), not eight exchanges. */
const MAX_CONVERSATION_LINES = 8;
const MAX_SHOPPER_LINE = 2000;
const MAX_EPOCH = 999_999_999;
/** Extension grants (M2-2): at most three active per session, each living at most one hour. */
const MAX_ACTIVE_GRANTS_PER_SESSION = 3;
const MAX_GRANT_LIFETIME_MS = 3_600_000;
const GRANT_SCOPES = new Set(["conversation:read", "conversation:write"]);
const GRANT_ID = /^grt_[0-9a-f]{32}$/;
const INSTALLATION_ID = /^ins_[0-9a-f]{32}$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
/** F07 purchase permissions (M2-3): see src/lib/permissions/model.ts. Kept here so this module stays self-contained. */
const PERMISSION_ID = /^prm_[0-9a-f]{32}$/;
const MERCHANT_ID = /^dmm_[a-z0-9]{6,24}$/;
const CHECKOUT_INTENT_ID = /^ci_[0-9a-f]{32}$/;
const PERMISSION_STATES = new Set(["active", "reserved", "executing", "consumed", "revoked", "expired", "outcome_unknown"]);
/** States that carry a checkout: set exactly for these. */
const BOUND_STATES = new Set(["reserved", "executing", "consumed", "outcome_unknown"]);
/** Ended permissions may record the checkout that held them when they ended (M2-3 review finding 4). */
const ENDED_STATES = new Set(["revoked", "expired"]);
/** States that can hold authority (before expiry): at most one per binding and five per session. */
const LIVE_STATES = new Set(["active", "reserved", "executing"]);
const MAX_LIVE_PERMISSIONS_PER_SESSION = 5;
const MAX_PERMISSION_QUANTITY = 10;
const MAX_PERMISSION_LIFETIME_MS = 86_400_000;
const MAX_UNIT_AMOUNT_CENTS = 2_000_000;
const ABSOLUTE_LIFETIME_MS = 86_400_000;
const IDENTITY_LABEL = "shopaccess.mock-store.v1";
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SESSION_ID = /^ses_[0-9a-f]{32}$/;
const DRAFT_ID = /^nd_[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const PRODUCT_ID = /^dmp_[a-z0-9]{6,24}$/;
const VARIANT_ID = /^dmv_[a-z0-9]{6,24}$/;
const BUDGET = /^[1-9][0-9]{1,4}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** Brand and model reject every ASCII control, including tab and newline. */
const PROFILE_CONTROL = /[\u0000-\u001F\u007F]/;
const MAX_PROFILE_TEXT = 80;
const MAX_PROFILE_VERSION = 999_999_999;
const USES = new Set(["programming", "schoolwork", "general_productivity"]);
const NOTICES = new Set(["malformed", "missing_use", "missing_budget", "ambiguous", "review", "unavailable"]);
/**
 * Charger clarification (format 7). Kept here, as literals, so this module stays self-contained. Tests check that every
 * value of CHARGER_LINES, DEVICE_IDS and MAX_CHARGER_REVISION (charger-clarification.ts, evidence.ts) is accepted here
 * and that other values are rejected.
 */
const CHARGER_LINES = new Set(["charger_task_choice", "charger_model", "charger_review", "charger_shown", "charger_closed"]);
const CHARGER_DEVICES = new Set(["Mac14,2", "MacBookPro12,1"]);
const CHARGER_STATES_WITHOUT_DEVICE = new Set(["closed", "task_choice", "awaiting_model"]);
const CHARGER_STATES_WITH_DEVICE = new Set(["candidate", "confirmed"]);
const MAX_CHARGER_REVISION = 999_999_999;
/** The format that introduced charger line keys. A later format keeps accepting them; unknown formats are still refused at decode. */
const CHARGER_LINES_SINCE_FORMAT = 7;
const CLAIMS = new Set(["pending", "completed", "failed"]);

const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const LOCK_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
const TEMP_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const KEY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const LOCK_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export type PublishedSnapshot = {
  /** The format the file was written in. Older bodies are returned upgraded, with empty lists for keys they did not have. */
  readonly format: Format;
  readonly identity: string;
  readonly sha256: string;
  readonly body: PublishedBody;
};

type SnapshotSession = {
  readonly id: SessionRecord["id"];
  readonly tokenDigest: SessionRecord["tokenDigest"];
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
};

type Format = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

type SnapshotDraft = NeedsDraft & { readonly sessionId: string };

/** One shopper line, or one assistant line holding a NeedsNotice token (or, from format 7, a charger line key). */
type SnapshotTurn = { readonly role: "shopper" | "assistant"; readonly text: string };

/** The guided conversation for a session's current draft. */
type SnapshotConversation = {
  readonly sessionId: string;
  readonly draftId: string;
  readonly interfaceLanguage: "en" | "es";
  readonly turns: readonly SnapshotTurn[];
};

/** Needs-bound checkout selection state: a supported requirement change closes it and advances the epoch. */
type SnapshotSelection = { readonly sessionId: string; readonly epoch: number; readonly closed: boolean };

/** A conversation-scoped extension grant. The token itself is never stored, only its keyed digest. */
export type SnapshotGrant = {
  readonly grantId: string;
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly extensionOrigin: string;
  readonly installationId: string;
  readonly scopes: readonly ("conversation:read" | "conversation:write")[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
};

/** An F07 purchase permission. Dates are ISO strings; see PersistedPermission for the meaning of each field. */
export type SnapshotPermission = {
  readonly permissionId: string;
  readonly sessionId: string;
  readonly merchantId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly maxQuantity: number;
  readonly maxTotalCents: number;
  readonly currency: "USD";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: "active" | "reserved" | "executing" | "consumed" | "revoked" | "expired" | "outcome_unknown";
  readonly checkoutIntentId: string | null;
  readonly changedAt: string;
};

export type PublishedBody = {
  readonly allocation: WindowState;
  readonly admissionLogin: WindowState;
  readonly sessions: readonly SnapshotSession[];
  readonly drafts: readonly SnapshotDraft[];
  readonly conversations: readonly SnapshotConversation[];
  readonly selections: readonly SnapshotSelection[];
  readonly grants: readonly SnapshotGrant[];
  readonly permissions: readonly SnapshotPermission[];
  readonly profiles: readonly SnapshotProfile[];
  readonly profileRevisions: readonly SnapshotProfileRevision[];
  readonly chargerTracks: readonly SnapshotChargerTrack[];
  readonly workloads?: readonly WorkloadRecord[];
  /**
   * Format 10 only, optional. Drafts converted from a format-7 store whose earlier workload evidence is unknown. Present
   * (even when empty) only on a converted store; absent means no legacy information, never an inferred one.
   */
  readonly legacyDrafts?: readonly SnapshotLegacyDraft[];
};

/** One converted legacy draft, bound to the session's current draft in the same body. */
export type SnapshotLegacyDraft = { readonly sessionId: string; readonly draftId: string };

/** One charger clarification record (format 7). `deviceId` is set exactly for `candidate` and `confirmed`. */
export type SnapshotChargerTrack = {
  readonly sessionId: string;
  readonly draftId: string;
  readonly state: "closed" | "task_choice" | "awaiting_model" | "candidate" | "confirmed";
  readonly deviceId: "Mac14,2" | "MacBookPro12,1" | null;
  readonly revision: number;
  readonly budget?: { readonly proposedCents: number; readonly confirmedCents: number | null };
};

/** Last issued version after the profile row was removed. No brand and no model. */
type SnapshotProfileRevision = {
  readonly sessionId: string;
  readonly version: number;
};

/** One optional device profile for a session. A null field is absent. Both null is not a stored record. */
type SnapshotProfile = {
  readonly sessionId: string;
  readonly version: number;
  readonly brand: string | null;
  readonly model: string | null;
};

type WindowState = { readonly windowStartedAt: number | null; readonly count: number };

export type StoreReadResult =
  | { readonly status: "ready"; readonly value: PublishedSnapshot }
  | { readonly status: "unavailable" };

/**
 * A refused commit is either definite or indeterminate.
 * - "definite": nothing was renamed into place; the previously published snapshot is unchanged and the store stays usable.
 * - "indeterminate": the new file was renamed into place but its directory entry could not be made durable. The outcome
 *   after a crash is unknown, so the store faults and serves nothing until it is reopened.
 */
export type CommitResult =
  | { readonly status: "ready"; readonly value: PublishedSnapshot }
  | { readonly status: "unavailable"; readonly outcome: "definite" | "indeterminate" };

export type FoundationStore = {
  readPublished(): StoreReadResult;
  commit(body: unknown): Promise<CommitResult>;
  /** Optional for mocks; file-backed stores release their writer lock here. */
  close?(): Promise<void>;
};

export type OpenResult =
  | { readonly status: "ready"; readonly value: FoundationStore }
  | { readonly status: "unavailable"; readonly code: string };

export type OpenOptions = {
  /** Explicit fresh-test-store mode. Refuses every existing format other than 8; never migrates it. */
  readonly format8TestStore?: boolean;
  /** Isolated disposable workload test store. Refuses all formats except 9. */
  readonly format9WorkloadTestStore?: boolean;
  /**
   * The explicit workload-record setting (SHOPACCESS_WORKLOAD_RECORDS=1). Strict: opens only format-10 stores and writes
   * format 10. It never converts an existing store; a format-7 store is refused. Absent, the store is ordinary.
   */
  readonly workloadRecords?: boolean;
  readonly directoryFsync?: (fd: number) => Promise<void>;
  readonly temporaryWrite?: (fd: number, bytes: Buffer) => Promise<void>;
  readonly beforePathRecheck?: () => Promise<void>;
  readonly initializeEmpty?: { readonly keyFile: string };
};

type StoreState = {
  faulted: boolean;
  writeFormat: 7 | 8 | 9 | 10;
  published: PublishedSnapshot | null;
  directory: string;
  keyBytes: Buffer;
  directoryHandle: fs.promises.FileHandle;
  lockHandle: fs.promises.FileHandle;
  directoryFsync: (fd: number) => Promise<void>;
  temporaryWrite?: (fd: number, bytes: Buffer) => Promise<void>;
};

export function lockStatRejects(stat: { uid: number; mode: number; isFile: boolean; nlink: number }, uid: number): boolean {
  return !stat.isFile || stat.uid !== uid || (stat.mode & 0o777) !== LOCK_MODE || stat.nlink < 1;
}

export async function openFoundationStore(directory: string, keyBytes: Uint8Array, options: OpenOptions = {}): Promise<OpenResult> {
  if (typeof fs.constants.O_NOFOLLOW !== "number") return unavailable("no-nofollow");
  if ([options.format8TestStore, options.format9WorkloadTestStore, options.workloadRecords].filter(Boolean).length > 1) {
    return unavailable("conflicting-test-modes");
  }
  const mode: 7 | 8 | 9 | 10 = options.workloadRecords ? 10 : options.format9WorkloadTestStore ? 9 : options.format8TestStore ? 8 : 7;
  const key = Buffer.from(keyBytes);
  let directoryHandle: fs.promises.FileHandle | null = null;
  let lockHandle: fs.promises.FileHandle | null = null;
  try {
    const prepared = await prepareDirectory(directory, options.initializeEmpty !== undefined);
    if (!prepared.ok) return unavailable(prepared.code);
    directoryHandle = prepared.handle;
    const lockPath = join(directory, "writer.lock");
    lockHandle = await fs.promises.open(lockPath, LOCK_FLAGS, LOCK_MODE);
    const locked = await fstatMatches(lockHandle, { file: true, mode: LOCK_MODE, nlinkAtLeast: 1 });
    if (!locked.ok) {
      await closeQuiet(lockHandle);
      await closeQuiet(directoryHandle);
      return unavailable(locked.code);
    }
    const flockCode = await exclusiveLock(lockHandle.fd);
    if (flockCode !== null) {
      await closeQuiet(lockHandle);
      await closeQuiet(directoryHandle);
      return unavailable(flockCode);
    }
    if (options.beforePathRecheck) await options.beforePathRecheck();
    const rebound = await pathStillNames(directory, directoryHandle, lockPath, lockHandle);
    if (!rebound) {
      await closeQuiet(lockHandle);
      await closeQuiet(directoryHandle);
      return unavailable("path-recheck");
    }
    let activeKey = key;
    if (options.initializeEmpty) {
      const created = await writeEmptyIfAbsent(directory, directoryHandle, options.initializeEmpty.keyFile, options.directoryFsync, mode);
      if (!created.ok) {
        await closeQuiet(lockHandle);
        await closeQuiet(directoryHandle);
        return unavailable(created.code);
      }
      activeKey = Buffer.from(created.bytes);
    }
    const loaded = await readVerified(directory, activeKey);
    const formatAllowed = loaded.ok && (mode === 7 ? loaded.value.format <= 7 : loaded.value.format === mode);
    if (!loaded.ok || !formatAllowed) {
      await closeQuiet(lockHandle);
      await closeQuiet(directoryHandle);
      return unavailable(loaded.ok ? refusalCode(mode, loaded.value.format) : loaded.code);
    }
    const state: StoreState = {
      faulted: false,
      writeFormat: mode,
      published: loaded.value,
      directory,
      keyBytes: activeKey,
      directoryHandle,
      lockHandle,
      directoryFsync: options.directoryFsync ?? defaultDirectoryFsync,
      ...(options.temporaryWrite ? { temporaryWrite: options.temporaryWrite } : {}),
    };
    directoryHandle = null;
    lockHandle = null;
    return { status: "ready", value: createStore(state) };
  } catch (error) {
    await closeQuiet(lockHandle);
    await closeQuiet(directoryHandle);
    return unavailable(codeOf(error));
  }
}

/**
 * Opens an initialised store with its identity key read from `keyFile` (a 0600 regular file owned by this user, not a
 * symlink). Used only by src/server/runtime-access.ts. Codes only; never a path or key byte.
 */
export async function openFoundationStoreWithKeyFile(directory: string, keyFile: string, options: Pick<OpenOptions, "format8TestStore" | "workloadRecords"> = {}): Promise<OpenResult> {
  const key = await readKeyFile(keyFile);
  if (!key.ok) return unavailable("key-file");
  return openFoundationStore(directory, key.bytes, options);
}

/** Why a store of `found` format is refused in `mode`. Distinct codes make the no-migration rule explicit. */
function refusalCode(mode: 7 | 8 | 9 | 10, found: Format): string {
  if (mode === 7 && found === 10) return "format-10-requires-workload-setting";
  if (mode === 10 && found <= 7) return "workload-setting-requires-format-10-store";
  return "test-format-mismatch";
}

function createStore(state: StoreState): FoundationStore {
  let chain = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    readPublished() {
      if (closing || state.faulted || state.published === null) return { status: "unavailable" };
      return { status: "ready", value: structuredClone(state.published) };
    },
    commit(body: unknown) {
      if (closing) return Promise.resolve(definite());
      try {
        const owned = structuredClone(body);
        return enqueue(() => commitBody(state, owned));
      } catch {
        return enqueue(() => Promise.resolve(definite()));
      }
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = enqueue(async () => {
        try {
          await state.lockHandle.close();
        } finally {
          await state.directoryHandle.close();
        }
      });
      return closePromise;
    },
  };
}

function definite(): CommitResult {
  return { status: "unavailable", outcome: "definite" };
}

async function commitBody(state: StoreState, body: unknown): Promise<CommitResult> {
  // A faulted store already had an indeterminate commit; it stays indeterminate until reopened.
  if (state.faulted) return { status: "unavailable", outcome: "indeterminate" };
  const parsed = parseBody(body, state.writeFormat);
  if (!parsed) return definite();
  const snapshot = seal(parsed, state.keyBytes, state.writeFormat);
  const tempPath = join(state.directory, `store.json.tmp.${randomBytes(8).toString("hex")}`);
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  // Refuse before writing anything that could not be read back on the next open.
  if (bytes.length > MAX_BYTES) return definite();
  let temp: fs.promises.FileHandle | null = null;
  let created = false;
  let renamed = false;
  try {
    temp = await fs.promises.open(tempPath, TEMP_FLAGS, LOCK_MODE);
    created = true;
    if (state.temporaryWrite) await state.temporaryWrite(temp.fd, bytes);
    else await writeAll(temp, bytes);
    await fsyncHandle(temp);
    await temp.close();
    temp = null;
    await fs.promises.rename(tempPath, join(state.directory, "store.json"));
    renamed = true;
    try {
      await state.directoryFsync(state.directoryHandle.fd);
    } catch {
      state.faulted = true;
      state.published = null;
      return { status: "unavailable", outcome: "indeterminate" };
    }
    state.published = snapshot;
    return { status: "ready", value: structuredClone(snapshot) };
  } catch {
    if (temp) await closeQuiet(temp);
    if (created && !renamed) await fs.promises.unlink(tempPath).catch(() => undefined);
    return renamed ? { status: "unavailable", outcome: "indeterminate" } : definite();
  }
}

async function prepareDirectory(
  directory: string,
  mayCreate: boolean,
): Promise<{ ok: true; handle: fs.promises.FileHandle } | { ok: false; code: string }> {
  let stat = await lstatOrNull(directory);
  if (stat?.isSymbolicLink()) return { ok: false, code: "symlink-directory" };
  if (!stat && mayCreate) {
    try {
      await fs.promises.mkdir(directory, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (codeOf(error) !== "EEXIST") return { ok: false, code: codeOf(error) };
    }
    stat = await lstatOrNull(directory);
  }
  if (!stat) return { ok: false, code: "absent-directory" };
  if (!directoryStatAccepts(stat)) return { ok: false, code: "directory-mode" };
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(directory, DIRECTORY_FLAGS);
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
  const checked = await fstatMatches(handle, { file: false, mode: DIRECTORY_MODE, nlinkAtLeast: 1 });
  if (!checked.ok) {
    await closeQuiet(handle);
    return { ok: false, code: checked.code };
  }
  return { ok: true, handle };
}

async function writeEmptyIfAbsent(
  directory: string,
  directoryHandle: fs.promises.FileHandle,
  keyFile: string,
  directoryFsync: ((fd: number) => Promise<void>) | undefined,
  format: 7 | 8 | 9 | 10,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: string }> {
  const existing = await lstatOrNull(join(directory, "store.json"));
  if (existing) return { ok: false, code: existing.isSymbolicLink() ? "symlink-store" : "already-present" };
  const key = await readKeyFile(keyFile);
  if (!key.ok) return key;
  const snapshot = seal(format === 9 || format === 10 ? { ...emptyBody(), workloads: [] } : emptyBody(), key.bytes, format);
  const tempPath = join(directory, `store.json.tmp.${randomBytes(8).toString("hex")}`);
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  let temp: fs.promises.FileHandle | null = null;
  let created = false;
  let renamed = false;
  try {
    temp = await fs.promises.open(tempPath, TEMP_FLAGS, LOCK_MODE);
    created = true;
    await writeAll(temp, bytes);
    await fsyncHandle(temp);
    await temp.close();
    temp = null;
    await fs.promises.rename(tempPath, join(directory, "store.json"));
    renamed = true;
    await (directoryFsync ?? defaultDirectoryFsync)(directoryHandle.fd);
    return { ok: true, bytes: key.bytes };
  } catch (error) {
    if (temp) await closeQuiet(temp);
    if (created && !renamed) await fs.promises.unlink(tempPath).catch(() => undefined);
    return { ok: false, code: codeOf(error) };
  }
}

async function readKeyFile(keyFile: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: string }> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const stat = await lstatOrNull(keyFile);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return { ok: false, code: "key-file" };
    if (stat.uid !== uid() || (stat.mode & 0o777) !== LOCK_MODE) return { ok: false, code: "key-file" };
    handle = await fs.promises.open(keyFile, KEY_FLAGS);
    const checked = await fstatMatches(handle, { file: true, mode: LOCK_MODE, nlinkAtLeast: 1 });
    if (!checked.ok) return { ok: false, code: "key-file" };
    const bytes = await readHandle(handle, MAX_BYTES);
    if (bytes.length === 0) return { ok: false, code: "key-file" };
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  } finally {
    await closeQuiet(handle);
  }
}

async function readVerified(
  directory: string,
  key: Buffer,
): Promise<{ ok: true; value: PublishedSnapshot } | { ok: false; code: string }> {
  const path = join(directory, "store.json");
  const listed = await lstatOrNull(path);
  if (!listed) return { ok: false, code: "absent-store" };
  if (listed.isSymbolicLink() || !listed.isFile()) return { ok: false, code: "store-type" };
  if (listed.uid !== uid() || (listed.mode & 0o777) !== LOCK_MODE || listed.size > MAX_BYTES) return { ok: false, code: "store-mode" };
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(path, OPEN_FLAGS);
    const checked = await fstatMatches(handle, { file: true, mode: LOCK_MODE, nlinkAtLeast: 1 });
    if (!checked.ok || checked.stat.dev !== listed.dev || checked.stat.ino !== listed.ino) return { ok: false, code: "store-recheck" };
    const bytes = await readHandle(handle, MAX_BYTES + 1);
    const snapshot = decodeSnapshot(bytes, key);
    if (!snapshot) return { ok: false, code: "invalid-snapshot" };
    return { ok: true, value: snapshot };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  } finally {
    await closeQuiet(handle);
  }
}

function decodeSnapshot(bytes: Buffer, key: Buffer): PublishedSnapshot | null {
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (hasDuplicateKeys(text) || hasTrailingValue(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["format", "identity", "sha256", "body"])) return null;
  if (
    parsed.format !== 10 &&
    parsed.format !== 9 &&
    parsed.format !== 8 &&
    parsed.format !== FORMAT &&
    parsed.format !== FORMAT_6 &&
    parsed.format !== FORMAT_5 &&
    parsed.format !== FORMAT_4 &&
    parsed.format !== FORMAT_3 &&
    parsed.format !== PREVIOUS_FORMAT &&
    parsed.format !== LEGACY_FORMAT
  ) {
    return null;
  }
  const format: Format =
    parsed.format === LEGACY_FORMAT
      ? 1
      : parsed.format === PREVIOUS_FORMAT
        ? 2
        : parsed.format === FORMAT_3
          ? 3
          : parsed.format === FORMAT_4
            ? 4
            : parsed.format === FORMAT_5
              ? 5
              : parsed.format === FORMAT_6
                ? 6
                : parsed.format === 10 ? 10 : parsed.format === 9 ? 9 : parsed.format === 8 ? 8 : 7;
  if (typeof parsed.identity !== "string" || !HEX_64.test(parsed.identity)) return null;
  if (typeof parsed.sha256 !== "string" || !HEX_64.test(parsed.sha256)) return null;
  if (parsed.identity !== identityFor(key)) return null;
  // The checksum covers the body exactly as written, so it is checked before any upgrade. For format 10 it also covers
  // the format label, so a snapshot relabelled 9 <-> 10 fails here; see checksumFor.
  if (!isRecord(parsed.body) || parsed.sha256 !== checksumFor(parsed.body, format)) return null;
  const body = parseBody(parsed.body, format);
  if (!body) return null;
  return { format, identity: parsed.identity, sha256: parsed.sha256, body };
}

const LEGACY_BODY_KEYS = ["allocation", "admissionLogin", "sessions", "drafts"] as const;
const PREVIOUS_BODY_KEYS = [...LEGACY_BODY_KEYS, "conversations", "selections"] as const;
const FORMAT_3_BODY_KEYS = [...PREVIOUS_BODY_KEYS, "grants"] as const;
const FORMAT_4_BODY_KEYS = [...FORMAT_3_BODY_KEYS, "permissions"] as const;
const FORMAT_5_BODY_KEYS = [...FORMAT_4_BODY_KEYS, "profiles"] as const;
const FORMAT_6_BODY_KEYS = [...FORMAT_5_BODY_KEYS, "profileRevisions"] as const;
const BODY_KEYS = [...FORMAT_6_BODY_KEYS, "chargerTracks"] as const;
const FORMAT_9_BODY_KEYS = [...BODY_KEYS, "workloads"] as const;
/** Format 10 has the format-9 body. Charger budgets stay format 8 only. */
const FORMAT_10_BODY_KEYS = FORMAT_9_BODY_KEYS;

/** Parses a body written in `format`. Older formats are returned upgraded with empty lists for the keys they did not have. */
function parseBody(value: unknown, format: Format): PublishedBody | null {
  const keys =
    format === LEGACY_FORMAT
      ? LEGACY_BODY_KEYS
      : format === PREVIOUS_FORMAT
        ? PREVIOUS_BODY_KEYS
        : format === FORMAT_3
          ? FORMAT_3_BODY_KEYS
          : format === FORMAT_4
            ? FORMAT_4_BODY_KEYS
            : format === FORMAT_5
              ? FORMAT_5_BODY_KEYS
              : format === FORMAT_6
                ? FORMAT_6_BODY_KEYS
                : format === 10
                  ? FORMAT_10_BODY_KEYS
                  : format === 9
                    ? FORMAT_9_BODY_KEYS
                    : BODY_KEYS;
  const withLegacy = format === 10 && isRecord(value) && Object.prototype.hasOwnProperty.call(value, "legacyDrafts") ? [...keys, "legacyDrafts"] : keys;
  if (!isRecord(value) || !hasExactKeys(value, withLegacy)) return null;
  const allocation = parseWindow(value.allocation, MAX_ALLOCATION_COUNT);
  const admissionLogin = parseWindow(value.admissionLogin, MAX_SAFE);
  if (!allocation || !admissionLogin || !Array.isArray(value.sessions) || !Array.isArray(value.drafts)) return null;
  if (value.sessions.length > MAX_SESSIONS || value.drafts.length > MAX_DRAFTS) return null;
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const entry of value.sessions) {
    const session = sessionIdentity(entry);
    if (!session || ids.has(session.id) || digests.has(session.tokenDigest)) return null;
    ids.add(session.id);
    digests.add(session.tokenDigest);
  }
  const draftOf = new Map<string, string>();
  for (const entry of value.drafts) {
    const draft = draftIdentity(entry, ids, format);
    if (!draft || draftOf.has(draft.sessionId)) return null;
    draftOf.set(draft.sessionId, draft.draftId);
  }
  if (format === LEGACY_FORMAT) {
    // Format 1 had no pending flag. Its contract defined a pending interpretation as: claim on the current version, no
    // notice, nothing confirmed, no recommendation claim. That definition is applied once, on upgrade.
    const drafts = (value.drafts as Array<Omit<SnapshotDraft, "interpretationPending">>).map((draft) => ({
      ...draft,
      interpretationPending:
        draft.interpretationClaimVersion !== null &&
        draft.interpretationClaimVersion === draft.version &&
        draft.notice === null &&
        draft.confirmedUse === null &&
        draft.recommendationClaim === null,
    }));
    return {
      ...(value as Omit<PublishedBody, "conversations" | "selections" | "drafts" | "grants" | "permissions" | "profiles" | "profileRevisions" | "chargerTracks">),
      drafts,
      conversations: [],
      selections: [],
      grants: [],
      permissions: [],
      profiles: [],
      profileRevisions: [],
      chargerTracks: [],
    };
  }
  if (!Array.isArray(value.conversations) || !Array.isArray(value.selections)) return null;
  if (value.conversations.length > MAX_SESSIONS || value.selections.length > MAX_SESSIONS) return null;
  const talking = new Set<string>();
  for (const entry of value.conversations) {
    const conversation = conversationIdentity(entry, draftOf, format);
    if (!conversation || talking.has(conversation.sessionId)) return null;
    talking.add(conversation.sessionId);
  }
  const selecting = new Set<string>();
  for (const entry of value.selections) {
    const selection = selectionIdentity(entry, ids);
    if (!selection || selecting.has(selection.sessionId)) return null;
    selecting.add(selection.sessionId);
  }
  if (format === PREVIOUS_FORMAT) {
    return {
      ...(value as Omit<PublishedBody, "grants" | "permissions" | "profiles" | "profileRevisions" | "chargerTracks">),
      grants: [],
      permissions: [],
      profiles: [],
      profileRevisions: [],
      chargerTracks: [],
    };
  }
  if (!Array.isArray(value.grants) || value.grants.length > MAX_SESSIONS * MAX_ACTIVE_GRANTS_PER_SESSION * 4) return null;
  const grantIds = new Set<string>();
  const tokenDigests = new Set<string>();
  const activePerSession = new Map<string, number>();
  const activeInstallations = new Set<string>();
  for (const entry of value.grants) {
    const grant = grantIdentity(entry, ids);
    if (!grant || grantIds.has(grant.grantId) || tokenDigests.has(grant.tokenDigest)) return null;
    grantIds.add(grant.grantId);
    tokenDigests.add(grant.tokenDigest);
    if (grant.active) {
      const count = (activePerSession.get(grant.sessionId) ?? 0) + 1;
      if (count > MAX_ACTIVE_GRANTS_PER_SESSION) return null;
      activePerSession.set(grant.sessionId, count);
      // One active grant per installation: a re-pair replaces, it does not add.
      if (activeInstallations.has(grant.installationKey)) return null;
      activeInstallations.add(grant.installationKey);
    }
  }
  if (format === FORMAT_3) {
    return { ...(value as Omit<PublishedBody, "permissions" | "profiles" | "profileRevisions" | "chargerTracks">), permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] };
  }
  if (!Array.isArray(value.permissions) || value.permissions.length > MAX_SESSIONS * 50) return null;
  const permissionIds = new Set<string>();
  const livePerSession = new Map<string, number>();
  const liveBindings = new Set<string>();
  for (const entry of value.permissions) {
    const permission = permissionIdentity(entry, ids);
    if (!permission || permissionIds.has(permission.permissionId)) return null;
    permissionIds.add(permission.permissionId);
    if (permission.live) {
      const count = (livePerSession.get(permission.sessionId) ?? 0) + 1;
      if (count > MAX_LIVE_PERMISSIONS_PER_SESSION) return null;
      livePerSession.set(permission.sessionId, count);
      // One live authority per exact seller + product + variant binding (D-M23-6).
      if (liveBindings.has(permission.bindingKey)) return null;
      liveBindings.add(permission.bindingKey);
    }
  }
  if (format === FORMAT_4) return { ...(value as Omit<PublishedBody, "profiles" | "profileRevisions" | "chargerTracks">), profiles: [], profileRevisions: [], chargerTracks: [] };
  if (!Array.isArray(value.profiles) || value.profiles.length > value.sessions.length) return null;
  const profileSessions = new Set<string>();
  for (const entry of value.profiles) {
    const sessionId = profileIdentity(entry, ids);
    if (!sessionId || profileSessions.has(sessionId)) return null;
    profileSessions.add(sessionId);
  }
  if (format === FORMAT_5) return { ...(value as Omit<PublishedBody, "profileRevisions" | "chargerTracks">), profileRevisions: [], chargerTracks: [] };
  if (!Array.isArray(value.profileRevisions) || value.profileRevisions.length > value.sessions.length) return null;
  const revisionSessions = new Set<string>();
  for (const entry of value.profileRevisions) {
    const sessionId = revisionIdentity(entry, ids);
    if (!sessionId || revisionSessions.has(sessionId) || profileSessions.has(sessionId)) return null;
    revisionSessions.add(sessionId);
  }
  if (format === FORMAT_6) return { ...(value as Omit<PublishedBody, "chargerTracks">), chargerTracks: [] };
  if (!Array.isArray(value.chargerTracks) || value.chargerTracks.length > value.sessions.length) return null;
  const trackSessions = new Set<string>();
  for (const entry of value.chargerTracks) {
    const sessionId = chargerTrackIdentity(entry, draftOf, format);
    if (!sessionId || trackSessions.has(sessionId)) return null;
    trackSessions.add(sessionId);
  }
  if (format === 9 || format === 10) {
    if (!Array.isArray(value.workloads) || value.workloads.length > value.sessions.length) return null;
    const workloadSessions = new Set<string>();
    for (const entry of value.workloads) {
      const workload = validateWorkloadRecord(entry);
      if (!workload) return null;
      if (draftOf.get(workload.sessionId) !== workload.draftId) return null;
      if (workloadSessions.has(workload.sessionId)) return null;
      workloadSessions.add(workload.sessionId);
    }
  }
  if (format === 10 && Object.prototype.hasOwnProperty.call(value, "legacyDrafts")) {
    if (!Array.isArray(value.legacyDrafts) || value.legacyDrafts.length > value.sessions.length) return null;
    const legacySessions = new Set<string>();
    for (const entry of value.legacyDrafts) {
      if (!isRecord(entry) || !hasExactKeys(entry, ["sessionId", "draftId"])) return null;
      if (typeof entry.sessionId !== "string" || typeof entry.draftId !== "string") return null;
      if (draftOf.get(entry.sessionId) !== entry.draftId) return null;
      if (legacySessions.has(entry.sessionId)) return null;
      legacySessions.add(entry.sessionId);
    }
  }

  return value as PublishedBody;
}

/**
 * One charger track per session, bound to that session's draft in the same body. The device is a canonical curated
 * identifier exactly for `candidate` and `confirmed`, and null otherwise. Revision 0 and a revision past the maximum are
 * rejected, not wrapped.
 */
function chargerTrackIdentity(value: unknown, draftOf: ReadonlyMap<string, string>, format: Format): string | null {
  if (!isRecord(value)) return null;
  const keys = ["sessionId", "draftId", "state", "deviceId", "revision"];
  if (!hasExactKeys(value, format === 8 && "budget" in value ? [...keys, "budget"] : keys)) return null;
  if ("budget" in value) {
    if (value.state !== "confirmed" || !isRecord(value.budget) || !hasExactKeys(value.budget, ["proposedCents", "confirmedCents"])) return null;
    const { proposedCents, confirmedCents } = value.budget;
    if (!isBoundedInteger(proposedCents, 1000, 9999900) || (proposedCents as number) % 100 !== 0) return null;
    if (confirmedCents !== null && confirmedCents !== proposedCents) return null;
  }
  if (typeof value.sessionId !== "string" || typeof value.draftId !== "string") return null;
  if (!draftOf.has(value.sessionId) || draftOf.get(value.sessionId) !== value.draftId) return null;
  if (typeof value.state !== "string") return null;
  if (CHARGER_STATES_WITHOUT_DEVICE.has(value.state)) {
    if (value.deviceId !== null) return null;
  } else if (CHARGER_STATES_WITH_DEVICE.has(value.state)) {
    if (typeof value.deviceId !== "string" || !CHARGER_DEVICES.has(value.deviceId)) return null;
  } else {
    return null;
  }
  if (!isBoundedInteger(value.revision, 1, MAX_CHARGER_REVISION)) return null;
  return value.sessionId;
}

/** One marker per session, and not for a session that still has a profile. Version 0 and a version past the maximum are rejected. */
function revisionIdentity(value: unknown, sessionIds: ReadonlySet<string>): string | null {
  const keys = ["sessionId", "version"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (typeof value.sessionId !== "string" || !sessionIds.has(value.sessionId)) return null;
  if (!isBoundedInteger(value.version, 1, MAX_PROFILE_VERSION)) return null;
  return value.sessionId;
}

function profileText(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_PROFILE_TEXT && value.trim() === value && !PROFILE_CONTROL.test(value);
}

/** One profile per session. Version 0 and a version past the maximum are rejected, not wrapped. */
function profileIdentity(value: unknown, sessionIds: ReadonlySet<string>): string | null {
  const keys = ["sessionId", "version", "brand", "model"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (typeof value.sessionId !== "string" || !sessionIds.has(value.sessionId)) return null;
  if (!isBoundedInteger(value.version, 1, MAX_PROFILE_VERSION)) return null;
  if (!profileText(value.brand) || !profileText(value.model)) return null;
  if (value.brand === null && value.model === null) return null;
  return value.sessionId;
}

/**
 * Strict shape of one saved permission. "Live" here is by state only: an `active` or `reserved` record past its expiry
 * is turned into `expired` by the next decision, and a new permission for the binding is only created after that.
 */
function permissionIdentity(
  value: unknown,
  sessionIds: ReadonlySet<string>,
): { permissionId: string; sessionId: string; live: boolean; bindingKey: string } | null {
  const keys = ["permissionId", "sessionId", "merchantId", "productId", "variantId", "maxQuantity", "maxTotalCents", "currency", "createdAt", "expiresAt", "state", "checkoutIntentId", "changedAt"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (typeof value.permissionId !== "string" || !PERMISSION_ID.test(value.permissionId)) return null;
  if (typeof value.sessionId !== "string" || !sessionIds.has(value.sessionId)) return null;
  if (typeof value.merchantId !== "string" || !MERCHANT_ID.test(value.merchantId)) return null;
  if (typeof value.productId !== "string" || !PRODUCT_ID.test(value.productId)) return null;
  if (typeof value.variantId !== "string" || !VARIANT_ID.test(value.variantId)) return null;
  if (!isBoundedInteger(value.maxQuantity, 1, MAX_PERMISSION_QUANTITY)) return null;
  if (!isBoundedInteger(value.maxTotalCents, 1, MAX_UNIT_AMOUNT_CENTS * MAX_PERMISSION_QUANTITY)) return null;
  if (value.currency !== "USD") return null;
  if (typeof value.state !== "string" || !PERMISSION_STATES.has(value.state)) return null;
  const createdAt = parseTimestamp(value.createdAt);
  const expiresAt = parseTimestamp(value.expiresAt);
  const changedAt = parseTimestamp(value.changedAt);
  if (!createdAt || !expiresAt || !changedAt) return null;
  if (expiresAt.getTime() <= createdAt.getTime() || expiresAt.getTime() - createdAt.getTime() > MAX_PERMISSION_LIFETIME_MS) return null;
  if (changedAt.getTime() < createdAt.getTime()) return null;
  const linked = typeof value.checkoutIntentId === "string" && CHECKOUT_INTENT_ID.test(value.checkoutIntentId);
  if (BOUND_STATES.has(value.state) ? !linked : ENDED_STATES.has(value.state) ? !linked && value.checkoutIntentId !== null : value.checkoutIntentId !== null) return null;
  return {
    permissionId: value.permissionId,
    sessionId: value.sessionId,
    live: LIVE_STATES.has(value.state),
    bindingKey: `${value.sessionId}\u0000${value.merchantId}\u0000${value.productId}\u0000${value.variantId}`,
  };
}

function grantIdentity(
  value: unknown,
  sessionIds: ReadonlySet<string>,
): { grantId: string; sessionId: string; tokenDigest: string; active: boolean; installationKey: string } | null {
  const keys = ["grantId", "sessionId", "tokenDigest", "extensionOrigin", "installationId", "scopes", "createdAt", "expiresAt", "revokedAt"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (typeof value.grantId !== "string" || !GRANT_ID.test(value.grantId)) return null;
  if (typeof value.sessionId !== "string" || !sessionIds.has(value.sessionId)) return null;
  if (typeof value.tokenDigest !== "string" || !DIGEST.test(value.tokenDigest)) return null;
  if (typeof value.extensionOrigin !== "string" || !EXTENSION_ORIGIN.test(value.extensionOrigin)) return null;
  if (typeof value.installationId !== "string" || !INSTALLATION_ID.test(value.installationId)) return null;
  if (!Array.isArray(value.scopes) || value.scopes.length === 0 || value.scopes.length > GRANT_SCOPES.size) return null;
  if (new Set(value.scopes).size !== value.scopes.length || !value.scopes.every((scope) => typeof scope === "string" && GRANT_SCOPES.has(scope))) return null;
  const createdAt = parseTimestamp(value.createdAt);
  const expiresAt = parseTimestamp(value.expiresAt);
  if (!createdAt || !expiresAt) return null;
  if (expiresAt.getTime() <= createdAt.getTime() || expiresAt.getTime() - createdAt.getTime() > MAX_GRANT_LIFETIME_MS) return null;
  let revokedAt: Date | null = null;
  if (value.revokedAt !== null) {
    revokedAt = parseTimestamp(value.revokedAt);
    if (!revokedAt || revokedAt.getTime() < createdAt.getTime()) return null;
  }
  return {
    grantId: value.grantId,
    sessionId: value.sessionId,
    tokenDigest: value.tokenDigest,
    active: revokedAt === null,
    installationKey: `${value.sessionId}\u0000${value.extensionOrigin}\u0000${value.installationId}`,
  };
}

/** A conversation belongs to a stored session and to that session's current draft. Charger line keys need format 7. */
function conversationIdentity(value: unknown, draftOf: ReadonlyMap<string, string>, format: Format): { sessionId: string } | null {
  if (!isRecord(value) || !hasExactKeys(value, ["sessionId", "draftId", "interfaceLanguage", "turns"])) return null;
  if (typeof value.sessionId !== "string" || typeof value.draftId !== "string") return null;
  if (draftOf.get(value.sessionId) !== value.draftId) return null;
  if (value.interfaceLanguage !== "en" && value.interfaceLanguage !== "es") return null;
  if (!Array.isArray(value.turns) || value.turns.length > MAX_CONVERSATION_LINES) return null;
  for (const turn of value.turns) {
    if (!isRecord(turn) || !hasExactKeys(turn, ["role", "text"]) || typeof turn.text !== "string") return null;
    if (turn.role === "assistant") {
      if (!NOTICES.has(turn.text) && !(format >= CHARGER_LINES_SINCE_FORMAT && CHARGER_LINES.has(turn.text))) return null;
    } else if (turn.role === "shopper") {
      if (turn.text.length < 1 || turn.text.length > MAX_SHOPPER_LINE || turn.text !== turn.text.trim() || CONTROL.test(turn.text)) return null;
    } else {
      return null;
    }
  }
  return { sessionId: value.sessionId };
}

function selectionIdentity(value: unknown, sessionIds: ReadonlySet<string>): { sessionId: string } | null {
  if (!isRecord(value) || !hasExactKeys(value, ["sessionId", "epoch", "closed"])) return null;
  if (typeof value.sessionId !== "string" || !sessionIds.has(value.sessionId)) return null;
  if (!isBoundedInteger(value.epoch, 0, MAX_EPOCH) || typeof value.closed !== "boolean") return null;
  return { sessionId: value.sessionId };
}

function parseWindow(value: unknown, maxCount: number): WindowState | null {
  if (!isRecord(value) || !hasExactKeys(value, ["windowStartedAt", "count"])) return null;
  if (!isBoundedInteger(value.count, 0, maxCount)) return null;
  if (value.windowStartedAt === null) return value.count === 0 ? { windowStartedAt: null, count: 0 } : null;
  if (!isBoundedInteger(value.windowStartedAt, 0, MAX_SAFE)) return null;
  return { windowStartedAt: value.windowStartedAt, count: value.count };
}

function sessionIdentity(value: unknown): { id: string; tokenDigest: string } | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "tokenDigest", "createdAt", "lastSeenAt", "absoluteExpiresAt", "revokedAt"])) return null;
  if (typeof value.id !== "string" || !SESSION_ID.test(value.id)) return null;
  if (typeof value.tokenDigest !== "string" || !DIGEST.test(value.tokenDigest)) return null;
  const createdAt = parseTimestamp(value.createdAt);
  const lastSeenAt = parseTimestamp(value.lastSeenAt);
  const absoluteExpiresAt = parseTimestamp(value.absoluteExpiresAt);
  if (createdAt === null || lastSeenAt === null || absoluteExpiresAt === null) return null;
  if (absoluteExpiresAt.getTime() !== createdAt.getTime() + ABSOLUTE_LIFETIME_MS) return null;
  if (lastSeenAt.getTime() < createdAt.getTime() || lastSeenAt.getTime() > absoluteExpiresAt.getTime()) return null;
  let revokedAt: Date | null = null;
  if (value.revokedAt !== null) {
    revokedAt = parseTimestamp(value.revokedAt);
    if (!revokedAt || revokedAt.getTime() < createdAt.getTime()) return null;
  }
  return { id: value.id, tokenDigest: value.tokenDigest };
}

function draftIdentity(value: unknown, sessionIds: ReadonlySet<string>, format: Format): { sessionId: string; draftId: string } | null {
  const legacyKeys = [
    "sessionId",
    "draftId",
    "version",
    "language",
    "shopperText",
    "prefilledUse",
    "prefilledBudgetDollars",
    "confirmedUse",
    "confirmedBudgetDollars",
    "interpretationClaimVersion",
    "recommendationClaim",
    "recommendation",
    "notice",
    "expiresAtMs",
  ] as const;
  const keys = format === LEGACY_FORMAT ? legacyKeys : [...legacyKeys, "interpretationPending"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (format !== LEGACY_FORMAT) {
    // Pending means a claim on the current version whose result has not been written.
    if (typeof value.interpretationPending !== "boolean") return null;
    if (value.interpretationPending && value.interpretationClaimVersion !== value.version) return null;
  }
  if (typeof value.sessionId !== "string" || !sessionIds.has(value.sessionId)) return null;
  if (typeof value.draftId !== "string" || !DRAFT_ID.test(value.draftId)) return null;
  if (!isBoundedInteger(value.version, 1, 999_999_999)) return null;
  if (value.language !== "en" && value.language !== "es") return null;
  if (typeof value.shopperText !== "string" || value.shopperText.length > 2000) return null;
  if (!isUse(value.prefilledUse) || !isUse(value.confirmedUse)) return null;
  if (!isBudget(value.prefilledBudgetDollars) || !isBudget(value.confirmedBudgetDollars)) return null;
  const confirmedPaired = (value.confirmedUse === null) === (value.confirmedBudgetDollars === null);
  if (!confirmedPaired) return null;
  if (value.interpretationClaimVersion !== null && value.interpretationClaimVersion !== value.version) return null;
  if (value.recommendationClaim !== null && (typeof value.recommendationClaim !== "string" || !CLAIMS.has(value.recommendationClaim))) return null;
  if (value.notice !== null && (typeof value.notice !== "string" || !NOTICES.has(value.notice))) return null;
  if (!isBoundedInteger(value.expiresAtMs, 0, MAX_SAFE)) return null;
  const recommendation = parseRecommendation(value.recommendation);
  if (recommendation === undefined) return null;
  if (!claimShape(value.recommendationClaim, value.confirmedUse, recommendation)) return null;
  return { sessionId: value.sessionId, draftId: value.draftId };
}

function claimShape(
  claim: unknown,
  confirmedUse: unknown,
  recommendation: RetainedRecommendation | null,
): boolean {
  const confirmed = confirmedUse !== null;
  if (claim === null) return recommendation === null;
  if (claim === "pending" || claim === "failed") return confirmed && recommendation === null;
  if (claim === "completed") return confirmed && recommendation !== null;
  return false;
}

function parseRecommendation(value: unknown): RetainedRecommendation | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["assistantMessage", "recommendations"])) return undefined;
  if (value.assistantMessage !== null) {
    if (typeof value.assistantMessage !== "string" || value.assistantMessage.length < 1 || value.assistantMessage.length > 1200) return undefined;
    if (CONTROL.test(value.assistantMessage)) return undefined;
  }
  if (!Array.isArray(value.recommendations) || value.recommendations.length > MAX_RECOMMENDATIONS) return undefined;
  const pairs = new Set<string>();
  const recommendations: Array<RetainedRecommendation["recommendations"][number]> = [];
  for (const item of value.recommendations) {
    if (!isRecord(item) || !hasExactKeys(item, ["productId", "variantId", "title", "label", "unitAmountCents", "currency"])) return undefined;
    if (typeof item.productId !== "string" || !PRODUCT_ID.test(item.productId)) return undefined;
    if (typeof item.variantId !== "string" || !VARIANT_ID.test(item.variantId)) return undefined;
    if (typeof item.title !== "string" || item.title.length < 1 || item.title.length > 120 || CONTROL.test(item.title)) return undefined;
    if (typeof item.label !== "string" || item.label.length < 1 || item.label.length > 80 || CONTROL.test(item.label)) return undefined;
    if (!isBoundedInteger(item.unitAmountCents, 1, MAX_UNIT_AMOUNT_CENTS)) return undefined;
    if (item.currency !== "USD") return undefined;
    const pair = `${item.productId}\u0000${item.variantId}`;
    if (pairs.has(pair)) return undefined;
    pairs.add(pair);
    recommendations.push({
      productId: item.productId,
      variantId: item.variantId,
      title: item.title,
      label: item.label,
      unitAmountCents: item.unitAmountCents,
      currency: "USD",
    });
  }
  return { assistantMessage: value.assistantMessage, recommendations };
}

function emptyBody(): PublishedBody {
  return {
    allocation: { windowStartedAt: null, count: 0 },
    admissionLogin: { windowStartedAt: null, count: 0 },
    sessions: [],
    drafts: [],
    conversations: [],
    selections: [],
    grants: [],
    permissions: [],
    profiles: [],
    profileRevisions: [],
    chargerTracks: [],
  };
}

function seal(body: PublishedBody, key: Buffer, format: 7 | 8 | 9 | 10): PublishedSnapshot {
  const identity = identityFor(key);
  const sha256 = checksumFor(body, format);
  return { format, identity, sha256, body };
}

function identityFor(key: Buffer): string {
  const label = Buffer.from(IDENTITY_LABEL, "utf8");
  const separator = Buffer.from([0]);
  return createHash("sha256").update(Buffer.concat([label, separator, key])).digest("hex");
}

/** Domain separator for the format-10 checksum. Formats 1 to 9 keep the bare body checksum, byte for byte. */
const FORMAT_10_CHECKSUM_DOMAIN = "shopaccess-snapshot-format-10\n";

/**
 * Checksum of a snapshot body. Formats 1 to 9: sha256 of the canonical body only, exactly as before. Format 10: sha256
 * of the domain separator, the format-10 label and the canonical body, so the label is bound to the checksum and a
 * format-9 snapshot cannot be relabelled as 10 (or the reverse) without recomputing it. This is an UNKEYED checksum
 * against accidents and sloppy relabelling, not cryptographic authentication: anyone who can write the file can
 * recompute it. Authenticating a store would need a keyed construction and is a separate decision.
 */
function checksumFor(body: Record<string, unknown> | PublishedBody, format: Format): string {
  const text = canonicalJson(body);
  return createHash("sha256")
    .update(format === 10 ? `${FORMAT_10_CHECKSUM_DOMAIN}${text}` : text, "utf8")
    .digest("hex");
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) return null;
  return parsed;
}

function isUse(value: unknown): value is NeedsDraft["prefilledUse"] {
  return value === null || (typeof value === "string" && USES.has(value));
}

function isBudget(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && BUDGET.test(value));
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasDuplicateKeys(text: string): boolean {
  const index = skipWhitespace(text, 0);
  const seen = scanValue(text, index, new Set());
  return seen.duplicate;
}

function hasTrailingValue(text: string): boolean {
  let index = skipWhitespace(text, 0);
  const scanned = scanValue(text, index, null);
  if (scanned.end < 0) return true;
  index = skipWhitespace(text, scanned.end);
  return index !== text.length;
}

function scanValue(text: string, index: number, keys: Set<string> | null): { end: number; duplicate: boolean } {
  index = skipWhitespace(text, index);
  const mark = text[index];
  if (mark === "{") return scanObject(text, index, keys);
  if (mark === "[") return scanArray(text, index, keys);
  if (mark === '"') {
    const end = skipString(text, index);
    return { end, duplicate: false };
  }
  const literal = text.slice(index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);
  if (!literal) return { end: -1, duplicate: false };
  return { end: index + literal[0].length, duplicate: false };
}

function scanObject(text: string, index: number, parentKeys: Set<string> | null): { end: number; duplicate: boolean } {
  const own = new Set<string>();
  let duplicate = false;
  index += 1;
  index = skipWhitespace(text, index);
  if (text[index] === "}") return { end: index + 1, duplicate };
  while (index < text.length) {
    if (text[index] !== '"') return { end: -1, duplicate };
    const keyEnd = skipString(text, index);
    if (keyEnd < 0) return { end: -1, duplicate };
    const key = JSON.parse(text.slice(index, keyEnd)) as string;
    if (own.has(key)) duplicate = true;
    own.add(key);
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ":") return { end: -1, duplicate };
    const value = scanValue(text, index + 1, parentKeys);
    if (value.end < 0) return { end: -1, duplicate: duplicate || value.duplicate };
    duplicate = duplicate || value.duplicate;
    index = skipWhitespace(text, value.end);
    if (text[index] === "}") return { end: index + 1, duplicate };
    if (text[index] !== ",") return { end: -1, duplicate };
    index = skipWhitespace(text, index + 1);
  }
  return { end: -1, duplicate };
}

function scanArray(text: string, index: number, keys: Set<string> | null): { end: number; duplicate: boolean } {
  let duplicate = false;
  index += 1;
  index = skipWhitespace(text, index);
  if (text[index] === "]") return { end: index + 1, duplicate };
  while (index < text.length) {
    const value = scanValue(text, index, keys);
    if (value.end < 0) return { end: -1, duplicate: duplicate || value.duplicate };
    duplicate = duplicate || value.duplicate;
    index = skipWhitespace(text, value.end);
    if (text[index] === "]") return { end: index + 1, duplicate };
    if (text[index] !== ",") return { end: -1, duplicate };
    index = skipWhitespace(text, index + 1);
  }
  return { end: -1, duplicate };
}

function skipString(text: string, index: number): number {
  index += 1;
  while (index < text.length) {
    const mark = text[index];
    if (mark === "\\") {
      index += 2;
      continue;
    }
    if (mark === '"') return index + 1;
    index += 1;
  }
  return -1;
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length && (text[index] === " " || text[index] === "\n" || text[index] === "\r" || text[index] === "\t")) index += 1;
  return index;
}

async function pathStillNames(
  directory: string,
  directoryHandle: fs.promises.FileHandle,
  lockPath: string,
  lockHandle: fs.promises.FileHandle,
): Promise<boolean> {
  const directoryStat = await fs.promises.lstat(directory);
  const directoryFd = await directoryHandle.stat();
  if (!directoryStatAccepts(directoryStat) || directoryStat.dev !== directoryFd.dev || directoryStat.ino !== directoryFd.ino) return false;
  const lockStat = await fs.promises.lstat(lockPath);
  const lockFd = await lockHandle.stat();
  if (lockStatRejects({ uid: lockStat.uid, mode: lockStat.mode, isFile: lockStat.isFile(), nlink: lockStat.nlink }, uid())) return false;
  return lockStat.dev === lockFd.dev && lockStat.ino === lockFd.ino;
}

function directoryStatAccepts(stat: fs.Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid() && (stat.mode & 0o777) === DIRECTORY_MODE;
}

async function fstatMatches(
  handle: fs.promises.FileHandle,
  expected: { file: boolean; mode: number; nlinkAtLeast: number },
): Promise<{ ok: true; stat: fs.Stats } | { ok: false; code: string }> {
  const stat = await handle.stat();
  const typeOk = expected.file ? stat.isFile() : stat.isDirectory();
  if (!typeOk || stat.uid !== uid() || (stat.mode & 0o777) !== expected.mode || stat.nlink < expected.nlinkAtLeast) {
    return { ok: false, code: "descriptor" };
  }
  return { ok: true, stat };
}

function exclusiveLock(fd: number): Promise<string | null> {
  const flags = fsExt.constants.LOCK_EX | fsExt.constants.LOCK_NB;
  return new Promise((resolve) => {
    fsExt.flock(fd, flags, (error) => resolve(error ? error.code ?? "flock" : null));
  });
}

async function defaultDirectoryFsync(fd: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fs.fsync(fd, (error) => (error ? reject(error) : resolve()));
  });
}

async function fsyncHandle(handle: fs.promises.FileHandle): Promise<void> {
  await handle.sync();
}

async function writeAll(handle: fs.promises.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten <= 0) throw new Error("short-write");
    offset += result.bytesWritten;
  }
}

async function readHandle(handle: fs.promises.FileHandle, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const scratch = Buffer.alloc(64 * 1024);
  for (;;) {
    const result = await handle.read(scratch, 0, scratch.length, null);
    if (result.bytesRead <= 0) break;
    total += result.bytesRead;
    if (total > limit) return Buffer.alloc(limit + 1);
    chunks.push(Buffer.from(scratch.subarray(0, result.bytesRead)));
  }
  return Buffer.concat(chunks);
}

async function lstatOrNull(path: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

async function closeQuiet(handle: fs.promises.FileHandle | null): Promise<void> {
  if (!handle) return;
  await handle.close().catch(() => undefined);
}

function unavailable(code: string): OpenResult {
  return { status: "unavailable", code };
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "io";
}

function uid(): number {
  return process.getuid?.() ?? -1;
}
