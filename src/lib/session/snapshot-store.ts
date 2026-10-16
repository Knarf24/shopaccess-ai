import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";

import fsExt from "fs-ext";

import { canonicalJson } from "../shared/canonical-json";
import type { NeedsDraft, RetainedRecommendation, SessionRecord } from "./store";

const FORMAT = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SESSIONS = 500;
const MAX_DRAFTS = 500;
const MAX_ALLOCATION_COUNT = 30;
const MAX_RECOMMENDATIONS = 30;
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
const USES = new Set(["programming", "schoolwork", "general_productivity"]);
const NOTICES = new Set(["malformed", "missing_use", "missing_budget", "ambiguous", "review", "unavailable"]);
const CLAIMS = new Set(["pending", "completed", "failed"]);

const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const LOCK_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
const TEMP_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const KEY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const LOCK_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export type PublishedSnapshot = {
  readonly format: 1;
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

type SnapshotDraft = NeedsDraft & { readonly sessionId: string };

export type PublishedBody = {
  readonly allocation: WindowState;
  readonly admissionLogin: WindowState;
  readonly sessions: readonly SnapshotSession[];
  readonly drafts: readonly SnapshotDraft[];
};

type WindowState = { readonly windowStartedAt: number | null; readonly count: number };

export type StoreReadResult =
  | { readonly status: "ready"; readonly value: PublishedSnapshot }
  | { readonly status: "unavailable" };

export type FoundationStore = {
  readPublished(): StoreReadResult;
  commit(body: unknown): Promise<StoreReadResult>;
};

export type OpenResult =
  | { readonly status: "ready"; readonly value: FoundationStore }
  | { readonly status: "unavailable"; readonly code: string };

export type OpenOptions = {
  readonly directoryFsync?: (fd: number) => Promise<void>;
  readonly temporaryWrite?: (fd: number, bytes: Buffer) => Promise<void>;
  readonly beforePathRecheck?: () => Promise<void>;
  readonly initializeEmpty?: { readonly keyFile: string };
};

type StoreState = {
  faulted: boolean;
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
      const created = await writeEmptyIfAbsent(directory, directoryHandle, options.initializeEmpty.keyFile, options.directoryFsync);
      if (!created.ok) {
        await closeQuiet(lockHandle);
        await closeQuiet(directoryHandle);
        return unavailable(created.code);
      }
      activeKey = Buffer.from(created.bytes);
    }
    const loaded = await readVerified(directory, activeKey);
    if (!loaded.ok) {
      await closeQuiet(lockHandle);
      await closeQuiet(directoryHandle);
      return unavailable(loaded.code);
    }
    const state: StoreState = {
      faulted: false,
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

function createStore(state: StoreState): FoundationStore {
  let chain = Promise.resolve();
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
      if (state.faulted || state.published === null) return { status: "unavailable" };
      return { status: "ready", value: structuredClone(state.published) };
    },
    commit(body: unknown) {
      try {
        const owned = structuredClone(body);
        return enqueue(() => commitBody(state, owned));
      } catch {
        return enqueue(() => Promise.resolve({ status: "unavailable" }));
      }
    },
  };
}

async function commitBody(state: StoreState, body: unknown): Promise<StoreReadResult> {
  if (state.faulted) return { status: "unavailable" };
  const parsed = parseBody(body);
  if (!parsed) return { status: "unavailable" };
  const snapshot = seal(parsed, state.keyBytes);
  const tempPath = join(state.directory, `store.json.tmp.${randomBytes(8).toString("hex")}`);
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
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
      return { status: "unavailable" };
    }
    state.published = snapshot;
    return { status: "ready", value: structuredClone(snapshot) };
  } catch {
    if (temp) await closeQuiet(temp);
    if (created && !renamed) await fs.promises.unlink(tempPath).catch(() => undefined);
    return { status: "unavailable" };
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
): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: string }> {
  const existing = await lstatOrNull(join(directory, "store.json"));
  if (existing) return { ok: false, code: existing.isSymbolicLink() ? "symlink-store" : "already-present" };
  const key = await readKeyFile(keyFile);
  if (!key.ok) return key;
  const snapshot = seal(emptyBody(), key.bytes);
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
  if (parsed.format !== FORMAT || typeof parsed.identity !== "string" || !HEX_64.test(parsed.identity)) return null;
  if (typeof parsed.sha256 !== "string" || !HEX_64.test(parsed.sha256)) return null;
  if (parsed.identity !== identityFor(key)) return null;
  const body = parseBody(parsed.body);
  if (!body) return null;
  if (parsed.sha256 !== checksumFor(body)) return null;
  return { format: FORMAT, identity: parsed.identity, sha256: parsed.sha256, body };
}

function parseBody(value: unknown): PublishedBody | null {
  if (!isRecord(value) || !hasExactKeys(value, ["allocation", "admissionLogin", "sessions", "drafts"])) return null;
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
  const owners = new Set<string>();
  for (const entry of value.drafts) {
    const draft = draftIdentity(entry, ids);
    if (!draft || owners.has(draft.sessionId)) return null;
    owners.add(draft.sessionId);
  }
  return value as PublishedBody;
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

function draftIdentity(value: unknown, sessionIds: ReadonlySet<string>): { sessionId: string } | null {
  const keys = [
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
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
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
  return { sessionId: value.sessionId };
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
  };
}

function seal(body: PublishedBody, key: Buffer): PublishedSnapshot {
  const identity = identityFor(key);
  const sha256 = checksumFor(body);
  return { format: FORMAT, identity, sha256, body };
}

function identityFor(key: Buffer): string {
  const label = Buffer.from(IDENTITY_LABEL, "utf8");
  const separator = Buffer.from([0]);
  return createHash("sha256").update(Buffer.concat([label, separator, key])).digest("hex");
}

function checksumFor(body: PublishedBody): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
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
