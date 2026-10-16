import { createHash } from "node:crypto";

/**
 * Evidence formats and qualification logic shared by the integration driver and by the IE-1 execution wrapper
 * (specification 19.19, Increment 2.3). NEVER RUN in operation.
 *
 * Pure: no file, process, network or environment access. Whatever touches a file system is handed in by the
 * caller as a small function, so every rule here can be exercised with in-memory fakes. The only import is the
 * hash function. The file uses only syntax that disappears when types are removed and imports nothing local,
 * so that the wrapper, a plain Node program outside the repository, can load this same file and run the same
 * code the unit suite tests, rather than a copy of it.
 *
 * Three interfaces:
 *  1. Ownership records: one line per application the driver spawns, written before any startup work is awaited.
 *  2. Sentinel evidence: salted digests of every sensitive value of a run, so that evidence can be searched for
 *     those values by someone who is never given them.
 *  3. Wrapper qualification: exclusive creation of the run directory, logging that cannot break cleanup, bounded
 *     steps, the final verdict, and the comparison of repository listings.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** The run-specific ownership identity: 32 lower-case hex digits, made by the wrapper for one run. */
export const OWNERSHIP_ID_PATTERN = /^[0-9a-f]{32}$/;

const ENCODER = new TextEncoder();

/** The bytes of a string as UTF-8. Every length in this file is a length in these bytes, never in characters. */
export function utf8Bytes(value: string): Uint8Array {
  return ENCODER.encode(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const seen = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return seen.length === wanted.length && seen.every((key, index) => key === wanted[index]);
}

/** Parsed JSON, or the one value JSON cannot produce. */
const NOT_JSON = Symbol("not JSON");
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

const isCount = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

// ---------------------------------------------------------------------------
// 1. Ownership records
// ---------------------------------------------------------------------------

export const OWNERSHIP_FILE = "application-ownership.jsonl";
export const OWNERSHIP_FORMAT = "shopaccess-ie1-ownership/1";
const OWNERSHIP_KEYS = ["format", "ownershipId", "index", "pid", "pgid", "startIdentity"];
/** The start time of a process as `ps` prints it: letters, digits, spaces and colons. Never free text. */
const START_IDENTITY_PATTERN = /^[A-Za-z0-9: ]{8,40}$/;

export interface OwnershipRecord {
  readonly format: string;
  readonly ownershipId: string;
  /** 1 for the first application the driver spawned, and so on. */
  readonly index: number;
  readonly pid: number;
  readonly pgid: number;
  /** The creation time the operating system reports. Together with the pid it identifies a single running program */
  readonly startIdentity: string;
}

/** A valid record, or null. Nothing is defaulted and nothing is repaired. */
export function ownershipRecord(fields: { ownershipId: unknown; index: unknown; pid: unknown; pgid: unknown; startIdentity: unknown }): OwnershipRecord | null {
  if (typeof fields.ownershipId !== "string" || !OWNERSHIP_ID_PATTERN.test(fields.ownershipId)) return null;
  if (!isCount(fields.index, 1, 64) || !isCount(fields.pid, 2, 4_194_304) || !isCount(fields.pgid, 2, 4_194_304)) return null;
  if (typeof fields.startIdentity !== "string" || !START_IDENTITY_PATTERN.test(fields.startIdentity)) return null;
  return { format: OWNERSHIP_FORMAT, ownershipId: fields.ownershipId, index: fields.index, pid: fields.pid, pgid: fields.pgid, startIdentity: fields.startIdentity };
}

/**
 * Registers one spawned application: validates the record and appends it as one line. Throws when the record is
 * not valid or the line could not be written; the caller treats either as a failed registration. `append` is the
 * caller's private, append-only write.
 */
export function registerOwnership(append: (line: string) => void, fields: Parameters<typeof ownershipRecord>[0]): OwnershipRecord {
  const record = ownershipRecord(fields);
  if (record === null) throw new TypeError("ownership record not valid");
  append(`${JSON.stringify(record)}\n`);
  return record;
}

export type OwnershipReading =
  | { readonly ok: true; readonly records: readonly OwnershipRecord[] }
  | { readonly ok: false; readonly reason: "UNREADABLE" | "MALFORMED" | "OWNERSHIP_MISMATCH" | "DUPLICATE_INDEX" };

/**
 * Reads back what the driver registered. Strict: every line must be a complete record of this run, and no index
 * may occur twice. `text` is null when the file could not be read. An empty file is valid and holds no record.
 */
export function readOwnership(text: string | null, ownershipId: string): OwnershipReading {
  if (text === null) return { ok: false, reason: "UNREADABLE" };
  const records: OwnershipRecord[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const parsed = parseJson(line);
    if (parsed === NOT_JSON) return { ok: false, reason: "MALFORMED" };
    if (!exactKeys(parsed, OWNERSHIP_KEYS) || parsed.format !== OWNERSHIP_FORMAT) return { ok: false, reason: "MALFORMED" };
    const record = ownershipRecord(parsed as Parameters<typeof ownershipRecord>[0]);
    if (record === null) return { ok: false, reason: "MALFORMED" };
    if (record.ownershipId !== ownershipId) return { ok: false, reason: "OWNERSHIP_MISMATCH" };
    if (records.some((known) => known.index === record.index)) return { ok: false, reason: "DUPLICATE_INDEX" };
    records.push(record);
  }
  return { ok: true, records };
}

/** What reading a process's environment for the run's identity showed. */
export type IdentityRead = "CARRIES" | "DOES_NOT_CARRY" | "EXITED" | "UNREADABLE";

/**
 * Classifies one attempt to read a process's environment. `output` is what the process table printed for that
 * pid, and `stillPresent` whether a fresh process table still lists the pid (null when that could not be read).
 * A process that has exited is told apart from one whose environment could not be read: only the first is a
 * settled answer.
 */
export function classifyIdentityRead(input: { commandSucceeded: boolean; output: string; stillPresent: boolean | null; marker: string }): IdentityRead {
  if (input.commandSucceeded && input.output.trim() !== "") return input.marker !== "" && input.output.includes(input.marker) ? "CARRIES" : "DOES_NOT_CARRY";
  return input.stillPresent === false ? "EXITED" : "UNREADABLE";
}

export type SignalDecision = "SIGNAL" | "SKIP_EXITED" | "SKIP_NOT_OURS" | "REFUSE_UNREADABLE";

/**
 * Whether a recorded pid may be signalled now. It fails closed: a signal is allowed only when a fresh process
 * table was read, shows that pid with the recorded start time, and the process's environment was read and carries
 * the run's identity. Evidence that could not be read is never treated as permission, and neither is evidence
 * that contradicts the record. `identityRequired: false` is for a run that has no ownership identity at all.
 *
 * This decides on what was just observed. It cannot bind the signal to it: the process may exit, and its pid be
 * given to another, between this decision and the signal. That interval is not closed by anything here.
 */
export function signalDecision(input: { snapshotReadable: boolean; presentWithSameStart: boolean; identity: IdentityRead; identityRequired: boolean }): SignalDecision {
  if (!input.snapshotReadable) return "REFUSE_UNREADABLE";
  if (!input.presentWithSameStart) return "SKIP_EXITED";
  if (!input.identityRequired) return "SIGNAL";
  if (input.identity === "CARRIES") return "SIGNAL";
  if (input.identity === "EXITED") return "SKIP_EXITED";
  if (input.identity === "DOES_NOT_CARRY") return "SKIP_NOT_OURS";
  return "REFUSE_UNREADABLE";
}

export type RegisteredMatch = "MATCH" | "GONE" | "PGID_MISMATCH";

/**
 * A registered application against the current process table. GONE: no such pid, or the pid now has another start
 * time. PGID_MISMATCH: the same process by pid and start time, in a different process group than was registered;
 * that contradicts the record and is not adopted.
 */
export function matchRegistered(record: { pgid: number; startIdentity: string }, seen: { pgid: number; lstart: string } | undefined): RegisteredMatch {
  if (seen === undefined || seen.lstart !== record.startIdentity) return "GONE";
  return seen.pgid === record.pgid ? "MATCH" : "PGID_MISMATCH";
}

export type SequenceReason = "OK" | "DUPLICATE_INDEX" | "UNEXPECTED_INDEX" | "MISSING_INDEX" | "OUT_OF_ORDER";

/** Registrations must be numbered 1, 2, 3, ... in the order they were written: the order the applications were started. */
export function registrationSequence(records: ReadonlyArray<{ index: number }>): { readonly valid: boolean; readonly count: number; readonly reason: SequenceReason } {
  const seen = new Set<number>();
  const fail = (reason: SequenceReason) => ({ valid: false, count: records.length, reason });
  for (const record of records) {
    if (!isCount(record.index, 1, 64)) return fail("UNEXPECTED_INDEX");
    if (seen.has(record.index)) return fail("DUPLICATE_INDEX");
    seen.add(record.index);
  }
  if (records.some((record) => record.index > records.length)) return fail("MISSING_INDEX");
  if (records.some((record, position) => record.index !== position + 1)) return fail("OUT_OF_ORDER");
  return { valid: true, count: records.length, reason: "OK" };
}

export interface OwnershipFacts {
  /** The boundary gate's own result for process identity: must be exactly "READABLE". */
  readonly boundaryProcessIdentity: string;
  /** The sweep for processes carrying the run's identity could be read. */
  readonly sweepReadable: boolean;
  readonly identityChecks: { readonly confirmed: number; readonly notOurs: number; readonly exited: number; readonly unreadable: number };
  readonly failedSnapshots: number;
  readonly failedRecordWrites: number;
  readonly registration: OwnershipReading;
  /** Registered processes whose current process group differs from the registered one. */
  readonly pgidMismatches: number;
  /** How many applications a complete run starts. */
  readonly expectedApplications: number;
}

/**
 * Whether the ownership evidence of a run qualifies. Every requirement must hold; each failure is named. A run
 * that started fewer applications than a complete one is described as that (the registrations it has may be
 * perfectly valid) and does not qualify as a complete run.
 */
export function qualifyOwnership(facts: OwnershipFacts): { readonly ok: boolean; readonly reasons: readonly string[]; readonly registered: number; readonly sequenceValid: boolean } {
  const reasons: string[] = [];
  if (facts.boundaryProcessIdentity !== "READABLE") reasons.push("PROCESS_IDENTITY_NOT_VERIFIED_AT_THE_BOUNDARY");
  if (facts.sweepReadable !== true) reasons.push("IDENTITY_SWEEP_UNREADABLE");
  if (facts.identityChecks.unreadable !== 0) reasons.push("IDENTITY_UNREADABLE_BEFORE_A_SIGNAL");
  if (facts.identityChecks.notOurs !== 0) reasons.push("RECORDED_PROCESS_WITHOUT_THE_RUN_IDENTITY");
  if (facts.failedSnapshots !== 0) reasons.push("PROCESS_SNAPSHOT_FAILED");
  if (facts.failedRecordWrites !== 0) reasons.push("OWNERSHIP_RECORD_NOT_WRITTEN");
  if (facts.pgidMismatches !== 0) reasons.push("REGISTERED_PROCESS_GROUP_DIFFERS");
  let registered = 0;
  let sequenceValid = false;
  if (!facts.registration.ok) {
    reasons.push(`REGISTRATION_${facts.registration.reason}`);
  } else {
    const sequence = registrationSequence(facts.registration.records);
    registered = sequence.count;
    sequenceValid = sequence.valid;
    if (!sequence.valid) reasons.push(`REGISTRATION_SEQUENCE_${sequence.reason}`);
    if (sequence.count < facts.expectedApplications) reasons.push("FEWER_REGISTRATIONS_THAN_A_COMPLETE_RUN");
    if (sequence.count > facts.expectedApplications) reasons.push("MORE_REGISTRATIONS_THAN_EXPECTED");
  }
  return { ok: reasons.length === 0, reasons, registered, sequenceValid };
}

// ---------------------------------------------------------------------------
// 2. Sentinel evidence
// ---------------------------------------------------------------------------

export const SENTINEL_FILE = "sentinel-evidence.json";
export const SENTINEL_FORMAT = "shopaccess-ie1-sentinels/1";
export const SENTINEL_ENCODING = "utf-8";

/** The exact categories. They are the driver's own, and a value of any other category is refused. */
export const SENTINEL_CATEGORIES: readonly string[] = [
  "private key",
  "password",
  "connection URL",
  "session cookie",
  "owner id",
  "token digest",
  "nonce digest",
  "confirmation nonce",
  "quote digest",
  "CSRF token",
];

export const SENTINEL_MIN_BYTES = 8;
export const SENTINEL_MAX_BYTES = 4096;
export const SENTINEL_MAX_ENTRIES = 4096;
/** A prime below 2^26: every product in the rolling hash stays an exact integer. */
export const ROLLING_MODULUS = 67_108_859;
const SALT_BYTES = 32;
const SENTINEL_KEYS = ["format", "encoding", "ownershipId", "salt", "base", "complete", "count", "entries"];
const ENTRY_KEYS = ["category", "byteLength", "rolling", "digest"];

export interface SentinelEntry {
  readonly category: string;
  /** Length of the value in UTF-8 bytes. */
  readonly byteLength: number;
  /** A keyed polynomial hash of the bytes: a cheap first test while scanning. It decides nothing by itself. */
  readonly rolling: number;
  /** SHA-256 of the salt followed by the value's bytes, in hex. This is what a match must equal. */
  readonly digest: string;
}

export interface SentinelEvidence {
  readonly ownershipId: string;
  readonly salt: Uint8Array;
  readonly base: number;
  readonly complete: boolean;
  readonly entries: readonly SentinelEntry[];
}

function rollingOf(bytes: Uint8Array, base: number): number {
  let hash = 0;
  for (const byte of bytes) hash = (hash * base + byte) % ROLLING_MODULUS;
  return hash;
}

function digestOf(salt: Uint8Array, bytes: Uint8Array): string {
  return createHash("sha256").update(salt).update(bytes).digest("hex");
}

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function serializeSentinelEvidence(evidence: SentinelEvidence): string {
  return `${JSON.stringify(
    {
      format: SENTINEL_FORMAT,
      encoding: SENTINEL_ENCODING,
      ownershipId: evidence.ownershipId,
      salt: hexOf(evidence.salt),
      base: evidence.base,
      complete: evidence.complete,
      count: evidence.entries.length,
      entries: evidence.entries.map((entry) => ({ category: entry.category, byteLength: entry.byteLength, rolling: entry.rolling, digest: entry.digest })),
    },
    null,
    1,
  )}\n`;
}

/**
 * Replaces a file's content as one step: the new text goes to a temporary file beside it, and that file is then
 * renamed over the target. A reader sees the old content or the new, never a part of either. If writing or
 * renaming fails, this throws, and the target still holds what it held.
 */
export function atomicReplace(files: { write(path: string, text: string): void; rename(from: string, to: string): void }, path: string, text: string): void {
  const temporary = `${path}.tmp`;
  files.write(temporary, text);
  files.rename(temporary, path);
}

/**
 * The sentinel registry of one run. A sensitive value is given to `register` BEFORE it is used for anything else;
 * what is kept and written is its category, its length in UTF-8 bytes and two hashes of it, never the value.
 * Every new value is persisted at once, through `persist`, which must replace the file atomically; a value that
 * could not be persisted is not counted as registered, and `register` throws. `complete` writes the final
 * marker: after it nothing can be registered, and a reader can tell a finished record from an interrupted one.
 */
export class SentinelRegistry {
  readonly #ownershipId: string;
  readonly #salt: Uint8Array;
  readonly #base: number;
  readonly #persist: (text: string) => void;
  readonly #entries: SentinelEntry[] = [];
  readonly #known = new Set<string>();
  #opened = false;
  #complete = false;

  constructor(options: { ownershipId: string; salt: Uint8Array; base: number; persist: (text: string) => void }) {
    if (!OWNERSHIP_ID_PATTERN.test(options.ownershipId)) throw new TypeError("ownership identity not valid");
    if (options.salt.length !== SALT_BYTES) throw new TypeError("salt must be 32 bytes");
    if (!isCount(options.base, 256, ROLLING_MODULUS - 1)) throw new TypeError("base out of range");
    this.#ownershipId = options.ownershipId;
    this.#salt = Uint8Array.from(options.salt);
    this.#base = options.base;
    this.#persist = options.persist;
  }

  #write(entries: readonly SentinelEntry[], complete: boolean): void {
    this.#persist(serializeSentinelEvidence({ ownershipId: this.#ownershipId, salt: this.#salt, base: this.#base, complete, entries }));
  }

  /** Writes the empty, incomplete record. Called once, before the first sensitive value exists. */
  open(): void {
    this.#write(this.#entries, false);
    this.#opened = true;
  }

  /**
   * Registers one value. Returns true when it was new and has been persisted, false when it was already
   * registered. Throws, without registering, when the registry is not open or already complete, the category is
   * not listed, the value's byte length is out of range, the record is full, or the write failed.
   */
  register(category: string, value: string): boolean {
    if (!this.#opened || this.#complete) throw new TypeError("sentinel registry is not open");
    if (!SENTINEL_CATEGORIES.includes(category)) throw new TypeError("sentinel category not listed");
    const bytes = utf8Bytes(value);
    if (bytes.length < SENTINEL_MIN_BYTES || bytes.length > SENTINEL_MAX_BYTES) throw new TypeError("sentinel length out of range");
    const digest = digestOf(this.#salt, bytes);
    const key = `${category}\n${digest}`;
    if (this.#known.has(key)) return false;
    if (this.#entries.length >= SENTINEL_MAX_ENTRIES) throw new TypeError("sentinel record is full");
    const entry: SentinelEntry = { category, byteLength: bytes.length, rolling: rollingOf(bytes, this.#base), digest };
    // Persisted first. Only a value that is on disk counts as registered.
    this.#write([...this.#entries, entry], false);
    this.#entries.push(entry);
    this.#known.add(key);
    return true;
  }

  /** Writes the final marker. Throws when that write fails; the record then stays incomplete. */
  complete(): void {
    if (!this.#opened) throw new TypeError("sentinel registry is not open");
    if (this.#complete) return;
    this.#write(this.#entries, true);
    this.#complete = true;
  }

  count(): number {
    return this.#entries.length;
  }

  isComplete(): boolean {
    return this.#complete;
  }
}

export type SentinelReading =
  | { readonly ok: true; readonly evidence: SentinelEvidence }
  | { readonly ok: false; readonly reason: "UNREADABLE" | "NOT_JSON" | "MALFORMED" | "WRONG_FORMAT" | "OWNERSHIP_MISMATCH" | "INCOMPLETE" };

/**
 * Reads sentinel evidence for use. Strict: the exact keys, format, encoding and categories; every number in its
 * range; the count equal to the number of entries; the run's own ownership identity; and the final completeness
 * marker. A record that is missing, unreadable, malformed, of another run or not complete is refused with one of
 * the fixed reasons. `text` is null when the file could not be read.
 */
export function readSentinelEvidence(text: string | null, ownershipId: string): SentinelReading {
  if (text === null) return { ok: false, reason: "UNREADABLE" };
  const parsed = parseJson(text);
  if (parsed === NOT_JSON) return { ok: false, reason: "NOT_JSON" };
  if (!exactKeys(parsed, SENTINEL_KEYS)) return { ok: false, reason: "MALFORMED" };
  if (parsed.format !== SENTINEL_FORMAT || parsed.encoding !== SENTINEL_ENCODING) return { ok: false, reason: "WRONG_FORMAT" };
  if (typeof parsed.salt !== "string" || !/^[0-9a-f]{64}$/.test(parsed.salt) || !isCount(parsed.base, 256, ROLLING_MODULUS - 1)) return { ok: false, reason: "MALFORMED" };
  if (typeof parsed.complete !== "boolean" || !Array.isArray(parsed.entries) || !isCount(parsed.count, 0, SENTINEL_MAX_ENTRIES) || parsed.count !== parsed.entries.length) return { ok: false, reason: "MALFORMED" };
  const entries: SentinelEntry[] = [];
  for (const entry of parsed.entries as unknown[]) {
    if (!exactKeys(entry, ENTRY_KEYS)) return { ok: false, reason: "MALFORMED" };
    if (typeof entry.category !== "string" || !SENTINEL_CATEGORIES.includes(entry.category)) return { ok: false, reason: "MALFORMED" };
    if (!isCount(entry.byteLength, SENTINEL_MIN_BYTES, SENTINEL_MAX_BYTES) || !isCount(entry.rolling, 0, ROLLING_MODULUS - 1)) return { ok: false, reason: "MALFORMED" };
    if (typeof entry.digest !== "string" || !/^[0-9a-f]{64}$/.test(entry.digest)) return { ok: false, reason: "MALFORMED" };
    entries.push({ category: entry.category, byteLength: entry.byteLength, rolling: entry.rolling, digest: entry.digest });
  }
  if (typeof parsed.ownershipId !== "string" || !OWNERSHIP_ID_PATTERN.test(parsed.ownershipId)) return { ok: false, reason: "MALFORMED" };
  if (parsed.ownershipId !== ownershipId) return { ok: false, reason: "OWNERSHIP_MISMATCH" };
  if (parsed.complete !== true) return { ok: false, reason: "INCOMPLETE" };
  const salt = Uint8Array.from((parsed.salt.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));
  return { ok: true, evidence: { ownershipId: parsed.ownershipId, salt, base: parsed.base, complete: true, entries } };
}

/**
 * Evidence for a set of values under a given salt and base, or null when any value is not acceptable (an unlisted
 * category, or a UTF-8 byte length out of range). The values themselves are not kept in what is returned.
 */
export function evidenceFromValues(options: { ownershipId: string; salt: Uint8Array; base: number; values: ReadonlyArray<{ category: string; value: string }> }): SentinelEvidence | null {
  if (!OWNERSHIP_ID_PATTERN.test(options.ownershipId) || options.salt.length !== SALT_BYTES || !isCount(options.base, 256, ROLLING_MODULUS - 1)) return null;
  const entries: SentinelEntry[] = [];
  const known = new Set<string>();
  for (const { category, value } of options.values) {
    if (!SENTINEL_CATEGORIES.includes(category)) return null;
    const bytes = utf8Bytes(value);
    if (bytes.length < SENTINEL_MIN_BYTES || bytes.length > SENTINEL_MAX_BYTES) return null;
    const digest = digestOf(options.salt, bytes);
    if (known.has(`${category}\n${digest}`)) continue;
    known.add(`${category}\n${digest}`);
    entries.push({ category, byteLength: bytes.length, rolling: rollingOf(bytes, options.base), digest });
  }
  return { ownershipId: options.ownershipId, salt: Uint8Array.from(options.salt), base: options.base, complete: true, entries };
}

/**
 * The same evidence with further values added under its own salt and base: this is how the wrapper's own secrets
 * are searched for by the one scanner, in the same pass as the driver's. Null when a value is not acceptable.
 */
export function withAdditionalValues(evidence: SentinelEvidence, values: ReadonlyArray<{ category: string; value: string }>): SentinelEvidence | null {
  const extra = evidenceFromValues({ ownershipId: evidence.ownershipId, salt: evidence.salt, base: evidence.base, values });
  if (extra === null) return null;
  const known = new Set(evidence.entries.map((entry) => `${entry.category}\n${entry.digest}`));
  return { ...evidence, entries: [...evidence.entries, ...extra.entries.filter((entry) => !known.has(`${entry.category}\n${entry.digest}`))] };
}

export interface ScanFinding {
  readonly category: string;
  readonly matches: number;
}

export interface ScanBudget {
  /** The time after which scanning stops, in the units of `now`. */
  readonly deadline: number;
  readonly now: () => number;
}

/**
 * The one matcher. Counts, in `totals`, every window of `data` that equals a registered value and ENDS after
 * `firstNewByte`; windows that lie wholly before it were counted when those bytes were first seen. For each
 * registered length every such window is tested with the rolling hash; one that passes is hashed with the salt,
 * and only an equal digest is a match. Returns false when the time budget ran out.
 */
function scanFrom(evidence: SentinelEvidence, data: Uint8Array, firstNewByte: number, totals: Map<string, number>, budget: ScanBudget): boolean {
  const lengths = [...new Set(evidence.entries.map((entry) => entry.byteLength))].sort((left, right) => left - right);
  for (const length of lengths) {
    if (length > data.length) continue;
    const wanted = new Map<number, SentinelEntry[]>();
    for (const entry of evidence.entries) {
      if (entry.byteLength !== length) continue;
      const list = wanted.get(entry.rolling);
      if (list) list.push(entry);
      else wanted.set(entry.rolling, [entry]);
    }
    let power = 1;
    for (let index = 1; index < length; index += 1) power = (power * evidence.base) % ROLLING_MODULUS;
    let start = Math.max(0, firstNewByte - length + 1);
    let hash = rollingOf(data.subarray(start, start + length), evidence.base);
    for (let windows = 0; ; start += 1, windows += 1) {
      const candidates = wanted.get(hash);
      if (candidates !== undefined) {
        const digest = digestOf(evidence.salt, data.subarray(start, start + length));
        for (const entry of candidates) if (entry.digest === digest) totals.set(entry.category, (totals.get(entry.category) ?? 0) + 1);
      }
      if (start + length >= data.length) break;
      if ((windows & 0xffff) === 0xffff && budget.now() > budget.deadline) return false;
      const without = (hash - ((data[start] * power) % ROLLING_MODULUS) + ROLLING_MODULUS) % ROLLING_MODULUS;
      hash = (without * evidence.base + data[start + length]) % ROLLING_MODULUS;
    }
    if (budget.now() > budget.deadline) return false;
  }
  return true;
}

/**
 * Searches one byte string for every registered value. Category and count are reported, never a position or a
 * byte of a window.
 *
 * What this finds: an EXACT occurrence of a registered value's UTF-8 bytes. What it does not find: a value that
 * was never registered, and any transformed form of a registered one (URL-encoded, JSON-escaped, base64 or hex of
 * it, split across lines, truncated, or in another encoding).
 *
 * Returns `complete: false` when the time budget ran out; the findings so far are then not a clean result.
 */
export function scanBytes(evidence: SentinelEvidence, bytes: Uint8Array, budget: ScanBudget): { readonly complete: boolean; readonly findings: readonly ScanFinding[] } {
  const totals = new Map<string, number>();
  const complete = scanFrom(evidence, bytes, 0, totals, budget);
  return { complete, findings: findingsOf(totals) };
}

function findingsOf(totals: ReadonlyMap<string, number>): ScanFinding[] {
  return [...totals.entries()].map(([category, matches]) => ({ category, matches })).sort((left, right) => (left.category < right.category ? -1 : left.category > right.category ? 1 : 0));
}

/**
 * One open input, read a piece at a time. `read(maxBytes)` returns the next bytes, AT MOST `maxBytes` of them, or
 * null at the end. `maxBytes` is always a positive whole number: the reader must not take more than that from the
 * input, not even to discard it. Both functions may throw.
 */
export interface ChunkReader {
  read(maxBytes: number): Uint8Array | null;
  close(): void;
}

/** The largest piece asked for in one read when the caller sets no other size. */
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export interface StreamInput {
  /** A fixed or file name for the report. Never content. */
  readonly name: string;
  /** The size before reading, or null when it could not be examined. It is compared afterwards; it bounds nothing. */
  readonly sizeBefore: number | null;
  /** Opens the input. May throw. */
  open(): ChunkReader;
  /** The size after reading, or null when it could not be examined. */
  sizeAfter(): number | null;
}

export interface StreamLimits {
  /** The most bytes that may be read from one input. Enforced while reading, whatever its size was said to be. */
  readonly maxFileBytes: number;
  /** The most bytes that may be read from all inputs together. Enforced while reading. */
  readonly maxTotalBytes: number;
  /** The most bytes asked for in one read. Defaults to `DEFAULT_CHUNK_BYTES`. */
  readonly chunkBytes?: number;
  /** One deadline for the whole scan. */
  readonly budget: ScanBudget;
  /** Asked before every read. True stops the scan. */
  readonly cancelled?: () => boolean;
}

export type ScanStatus = "SCANNED" | "UNREADABLE" | "OVERSIZED" | "TOTAL_SIZE_EXCEEDED" | "CHANGED_DURING_READ" | "READER_OVERRAN_REQUEST" | "CLOSE_FAILED" | "TIME_BUDGET_EXCEEDED" | "CANCELLED" | "NOT_REACHED";

export interface ScanReport {
  /** True only when every input was read to its end, within the limits, unchanged, and scanned in full. */
  readonly complete: boolean;
  /** True only when the scan is complete and nothing was found. An incomplete scan is never clean. */
  readonly clean: boolean;
  readonly files: ReadonlyArray<{ readonly name: string; readonly status: ScanStatus; readonly bytes: number; readonly findings: readonly ScanFinding[] }>;
}

/**
 * The one scanner: every input is read a piece at a time and searched as it is read, for every value of the given
 * evidence, the driver's sentinels and the wrapper's own secrets alike.
 *
 *  - Nothing is sized from a prior look at the input, and no limit is ever passed, not by one byte. Before each
 *    read the most that may still be read is worked out: the smallest of what is left of this input's limit,
 *    what is left of the limit on all inputs, and the piece size. The reader is asked for at most that, and must
 *    not take more from the input. When nothing is left, NO read is made.
 *  - At a limit, whether the input ended exactly there is not found by reading on. It is taken from the input's
 *    size before and after: only if both equal the number of bytes read is the input complete. Otherwise it is
 *    over the limit (it is larger, it grew, or its size could not be examined), and that is an incomplete result.
 *  - A reader that returns more than it was asked for has broken the rule above: the input is not complete, and
 *    the excess is not searched.
 *  - Memory: one piece, plus the last (longest value - 1) bytes of what came before it, so that a value lying
 *    across two pieces is found exactly once.
 *  - One deadline for the whole scan, and a cancellation that is asked before every read.
 *  - Every reader that was opened is closed, on success, failure, timeout and cancellation.
 *  - An input that could not be opened or read, that passed a limit, whose size before or after differs from what
 *    was read, whose reader would not close, or that was not reached, makes the report incomplete. Incomplete is
 *    never clean, and having found nothing in what was read changes nothing about that.
 *
 * It finds exact registered UTF-8 byte strings only: not transformed forms, and not unregistered values.
 */
export function scanStreams(evidence: SentinelEvidence, inputs: readonly StreamInput[], limits: StreamLimits): ScanReport {
  const files: Array<{ name: string; status: ScanStatus; bytes: number; findings: readonly ScanFinding[] }> = [];
  const keep = Math.max(0, ...evidence.entries.map((entry) => entry.byteLength)) - 1;
  const pieceBytes = limits.chunkBytes !== undefined && Number.isSafeInteger(limits.chunkBytes) && limits.chunkBytes >= 1 ? limits.chunkBytes : DEFAULT_CHUNK_BYTES;
  const stopNow = (): ScanStatus | null => {
    let cancelled = false;
    try {
      cancelled = limits.cancelled?.() === true;
    } catch {
      cancelled = true;
    }
    if (cancelled) return "CANCELLED";
    return limits.budget.now() > limits.budget.deadline ? "TIME_BUDGET_EXCEEDED" : null;
  };
  let total = 0;
  let stopped = false;
  for (const input of inputs) {
    if (stopped) {
      files.push({ name: input.name, status: "NOT_REACHED", bytes: 0, findings: [] });
      continue;
    }
    const early = stopNow();
    if (early !== null) {
      files.push({ name: input.name, status: early, bytes: 0, findings: [] });
      stopped = true;
      continue;
    }
    let reader: ChunkReader;
    try {
      reader = input.open();
    } catch {
      files.push({ name: input.name, status: "UNREADABLE", bytes: 0, findings: [] });
      continue;
    }
    const totals = new Map<string, number>();
    let status: ScanStatus = "SCANNED";
    let bytes = 0;
    let atLimit = false;
    let tail: Uint8Array = new Uint8Array(0);
    try {
      for (;;) {
        const halt = stopNow();
        if (halt !== null) {
          status = halt;
          break;
        }
        // The cap for this one read, settled BEFORE it is made.
        const leftInFile = limits.maxFileBytes - bytes;
        const leftInTotal = limits.maxTotalBytes - total;
        const allowance = Math.floor(Math.min(pieceBytes, leftInFile, leftInTotal));
        if (!(allowance >= 1)) {
          // Nothing may be read any more, so nothing is. Did the input end exactly here? Only its size can say.
          let sizeNow: number | null = null;
          try {
            sizeNow = input.sizeAfter();
          } catch {
            sizeNow = null;
          }
          atLimit = true;
          if (input.sizeBefore !== bytes || sizeNow !== bytes) status = leftInFile < 1 ? "OVERSIZED" : "TOTAL_SIZE_EXCEEDED";
          break;
        }
        let chunk: Uint8Array | null;
        try {
          chunk = reader.read(allowance);
        } catch {
          status = "UNREADABLE";
          break;
        }
        if (chunk === null || chunk.length === 0) break;
        if (chunk.length > allowance) {
          // More than was asked for: counted, not searched, and never complete.
          bytes += chunk.length;
          total += chunk.length;
          status = "READER_OVERRAN_REQUEST";
          break;
        }
        bytes += chunk.length;
        total += chunk.length;
        const data = new Uint8Array(tail.length + chunk.length);
        data.set(tail, 0);
        data.set(chunk, tail.length);
        if (!scanFrom(evidence, data, tail.length, totals, limits.budget)) {
          status = "TIME_BUDGET_EXCEEDED";
          break;
        }
        tail = keep > 0 ? data.slice(Math.max(0, data.length - keep)) : new Uint8Array(0);
      }
    } finally {
      try {
        reader.close();
      } catch {
        if (status === "SCANNED") status = "CLOSE_FAILED";
      }
    }
    // An input that stopped at a limit has had its size compared already, above. One that reached its end is
    // compared here.
    if (status === "SCANNED" && !atLimit) {
      let after: number | null = null;
      try {
        after = input.sizeAfter();
      } catch {
        after = null;
      }
      if (input.sizeBefore === null || after === null) status = "UNREADABLE";
      else if (input.sizeBefore !== bytes || after !== bytes) status = "CHANGED_DURING_READ";
    }
    files.push({ name: input.name, status, bytes, findings: findingsOf(totals) });
    if (status === "TIME_BUDGET_EXCEEDED" || status === "CANCELLED" || status === "TOTAL_SIZE_EXCEEDED") stopped = true;
  }
  const complete = files.every((file) => file.status === "SCANNED");
  return { complete, clean: complete && files.every((file) => file.findings.length === 0), files };
}

// ---------------------------------------------------------------------------
// 3. Wrapper qualification
// ---------------------------------------------------------------------------

export type RunDirectory =
  | { readonly created: false; readonly reason: "ALREADY_EXISTS" | "NOT_CREATED" }
  | { readonly created: true; readonly path: string; readonly usable: true; readonly modeCorrected: boolean }
  | { readonly created: true; readonly path: string; readonly usable: false; readonly reason: "WRONG_MODE" };

/**
 * Creates the run directory exclusively. `mkdir` must create exactly this one directory and fail if anything
 * already has that name (a non-recursive mkdir).
 *
 *  - A collision, or any other failure to create it: `created: false`. Nothing further is done: no check inside
 *    it, no write, no change of mode, no removal, and no path is handed back to clean up. It is not this run's.
 *  - Created by this call: `created: true`, always with its path, because it is this run's and exists. If its mode
 *    is not 700, one correction is attempted on that directory, which is new and empty: its mode is set to 700 and
 *    read again. If it is then 700 the directory is usable. If not, it is returned as created and NOT usable: the
 *    caller writes nothing into it, stops before any secret exists, and reports it as a directory this run made.
 */
export function createRunDirectory(files: { mkdir(path: string, mode: number): void; mode(path: string): number; chmod(path: string, mode: number): void }, path: string): RunDirectory {
  try {
    files.mkdir(path, 0o700);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return { created: false, reason: code === "EEXIST" ? "ALREADY_EXISTS" : "NOT_CREATED" };
  }
  const modeOf = (): number => {
    try {
      return files.mode(path);
    } catch {
      return -1;
    }
  };
  if (modeOf() === 0o700) return { created: true, path, usable: true, modeCorrected: false };
  try {
    files.chmod(path, 0o700);
  } catch {
    // Reported below by the mode that is read back.
  }
  return modeOf() === 0o700 ? { created: true, path, usable: true, modeCorrected: true } : { created: true, path, usable: false, reason: "WRONG_MODE" };
}

export interface SafeLogger {
  /** Never throws. A line that could not be written, or that came after `close`, is counted. */
  log(...lines: string[]): void;
  failures(): number;
  /** Ends the log and returns the number of lines that were not written. Nothing can be written afterwards. */
  close(): number;
}

/**
 * Logging that cannot break what it describes: a failed write is counted, and the caller carries on. `finish`,
 * when given, is called once by `close` to flush and close the underlying file; if it throws, that counts as a
 * failure too, so the final count says whether the whole log, to its last line, is on disk.
 */
export function createSafeLogger(append: (text: string) => void, echo: (text: string) => void = () => undefined, finish: () => void = () => undefined): SafeLogger {
  let failed = 0;
  let closed = false;
  return {
    log(...lines) {
      const text = `${lines.join("\n")}\n`;
      if (closed) {
        failed += 1;
        return;
      }
      try {
        append(text);
      } catch {
        failed += 1;
      }
      try {
        echo(text);
      } catch {
        // The echo is a convenience; the count above is about the record.
      }
    },
    failures: () => failed,
    close() {
      if (!closed) {
        closed = true;
        try {
          finish();
        } catch {
          failed += 1;
        }
      }
      return failed;
    },
  };
}

export interface StepOutcome {
  readonly step: string;
  readonly ok: boolean;
  /** DONE, FAILED (the step said so), THREW or TIMED_OUT. */
  readonly state: "DONE" | "FAILED" | "THREW" | "TIMED_OUT";
  readonly note: string;
}

export interface BoundedStep {
  readonly name: string;
  readonly timeoutMs: number;
  /** Returns `{ ok, note }`. May throw; may never settle. */
  run(): Promise<{ ok: boolean; note: string }>;
}

/**
 * Runs every step in order, whatever the earlier ones did. A step that throws, or that has not settled when its
 * time is up, is recorded as that, and the next step runs; a step that is abandoned at its deadline may still be
 * running. Nothing a step throws is copied. `timer` is the caller's `setTimeout`/`clearTimeout` pair.
 */
export async function runBoundedSteps(
  steps: readonly BoundedStep[],
  logger: SafeLogger,
  timer: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void },
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    let outcome: StepOutcome;
    let handle: unknown;
    const expired = new Promise<"TIMED_OUT">((resolve) => {
      handle = timer.set(() => resolve("TIMED_OUT"), step.timeoutMs);
    });
    try {
      const settled = await Promise.race([
        Promise.resolve()
          .then(() => step.run())
          .then(
            (value) => ({ value }),
            () => "THREW" as const,
          ),
        expired,
      ]);
      if (settled === "TIMED_OUT") outcome = { step: step.name, ok: false, state: "TIMED_OUT", note: `not settled after ${step.timeoutMs} ms` };
      else if (settled === "THREW") outcome = { step: step.name, ok: false, state: "THREW", note: "the step threw" };
      else outcome = { step: step.name, ok: settled.value.ok === true, state: settled.value.ok === true ? "DONE" : "FAILED", note: String(settled.value.note) };
    } catch {
      outcome = { step: step.name, ok: false, state: "THREW", note: "the step threw" };
    }
    timer.clear(handle);
    outcomes.push(outcome);
    logger.log(`cleanup: ${outcome.step}: ${outcome.state} (${outcome.note})`);
  }
  return outcomes;
}

/** The four things a run is judged on. They are reported apart and are never merged into one another. */
export interface RunOutcomes {
  /** The network boundary was shown before anything was provisioned. */
  readonly boundary: boolean;
  /** The suite ran to its own end with exit status 0 and the expected inventory, and was not forced. */
  readonly suite: boolean;
  /** Every cleanup step succeeded: nothing owned remained, the cluster is stopped, the catalogs are pristine. */
  readonly cleanup: boolean;
  /** The evidence is complete: ownership records, sentinel scan, denial record, manifests, and no failed log write. */
  readonly evidence: boolean;
}

export interface Verdict extends RunOutcomes {
  readonly resultPersisted: boolean;
  readonly manifestPersisted: boolean;
  readonly passed: boolean;
}

/**
 * The final verdict. The result file is written first, then the manifest of the evidence, which lists the result
 * file and is not itself listed anywhere. A run passes only when all four outcomes hold AND both files were
 * written: a result that could not be persisted is not a pass, whatever it would have said.
 */
export function finalize(outcomes: RunOutcomes, writers: { result(): void; manifest(): void }): Verdict {
  let resultPersisted = true;
  try {
    writers.result();
  } catch {
    resultPersisted = false;
  }
  let manifestPersisted = true;
  try {
    writers.manifest();
  } catch {
    manifestPersisted = false;
  }
  const { boundary, suite, cleanup, evidence } = outcomes;
  return { boundary, suite, cleanup, evidence, resultPersisted, manifestPersisted, passed: boundary === true && suite === true && cleanup === true && evidence === true && resultPersisted && manifestPersisted };
}

export interface Conclusion extends Verdict {
  /** Log lines that were not written, counted after the log was closed. */
  readonly logFailures: number;
  readonly scanComplete: boolean;
  readonly scanClean: boolean;
}

/**
 * The end of a run, in the one order in which nothing required can fail unnoticed:
 *   1. the final outcome lines are written to the log, and the log is closed; only now is the number of lines that
 *      were not written known, and it includes these last ones;
 *   2. the evidence is scanned, the closed log included;
 *   3. the evidence outcome is settled from what was known before, from that number being zero, and from the scan
 *      being complete and clean;
 *   4. the result file is written, with those final values; then the manifest, which lists the result file and is
 *      itself listed nowhere.
 * A pass needs all four outcomes and both files. Nothing is logged after step 1, so no later line can be lost;
 * the caller reports the verdict, and the manifest's hash, on standard output and by its exit status.
 */
export function concludeRun(input: {
  readonly outcomes: { readonly boundary: boolean; readonly suite: boolean; readonly cleanup: boolean };
  /** Everything about the evidence that is known before the log is closed and the scan is made. */
  readonly evidenceSoFar: boolean;
  readonly logger: SafeLogger;
  readonly finalLines: readonly string[];
  readonly scan: () => { complete: boolean; clean: boolean };
  readonly writers: { result(conclusion: RunOutcomes & { logFailures: number; scanComplete: boolean; scanClean: boolean }): void; manifest(): void };
}): Conclusion {
  input.logger.log(...input.finalLines);
  const logFailures = input.logger.close();
  let scanComplete = false;
  let scanClean = false;
  try {
    const scanned = input.scan();
    scanComplete = scanned.complete === true;
    scanClean = scanned.clean === true;
  } catch {
    scanComplete = false;
    scanClean = false;
  }
  const outcomes: RunOutcomes = {
    boundary: input.outcomes.boundary === true,
    suite: input.outcomes.suite === true,
    cleanup: input.outcomes.cleanup === true,
    evidence: input.evidenceSoFar === true && logFailures === 0 && scanComplete && scanClean,
  };
  const verdict = finalize(outcomes, { result: () => input.writers.result({ ...outcomes, logFailures, scanComplete, scanClean }), manifest: () => input.writers.manifest() });
  return { ...verdict, logFailures, scanComplete, scanClean };
}

/** Generated areas a run may write to. They are ignored by git, and they are the only paths left out of comparison. */
export const PERMITTED_GENERATED_PREFIXES: readonly string[] = [".next/", "node_modules/.vite/"];
export const PERMITTED_GENERATED_FILES: readonly string[] = ["next-env.d.ts"];

export type PathClass = "PERMITTED_GENERATED" | "CREDENTIAL_LIKE" | "DEPENDENCY" | "ORDINARY";

/**
 * How a repository path is treated when listings are compared.
 *  - PERMITTED_GENERATED: left out. Only the exact prefixes and files above.
 *  - CREDENTIAL_LIKE: an environment file or a key file. Its presence, size and time are compared; its content is
 *    never read, hashed or printed.
 *  - DEPENDENCY: under node_modules. Presence, size and time are compared; there are too many to hash.
 *  - ORDINARY: everything else, tracked, untracked or ignored. Compared by content hash.
 */
export function classifyPath(path: string): PathClass {
  if (PERMITTED_GENERATED_FILES.includes(path) || PERMITTED_GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return "PERMITTED_GENERATED";
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === ".env" || name.startsWith(".env.") || /\.(pem|key|p12|pfx)$/.test(name)) return "CREDENTIAL_LIKE";
  if (path.startsWith("node_modules/")) return "DEPENDENCY";
  return "ORDINARY";
}

export interface ListingDifference {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

/**
 * Compares two listings of path to signature. A signature is whatever the caller recorded for the path's class:
 * a content hash, or size and time. Permitted generated paths are left out of both sides; every other path that
 * appears, disappears or changes its signature is a discrepancy, whether git tracks it, ignores it or neither.
 */
export function compareListings(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): ListingDifference {
  const relevant = (path: string): boolean => classifyPath(path) !== "PERMITTED_GENERATED";
  const added = [...after.keys()].filter((path) => relevant(path) && !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => relevant(path) && !after.has(path)).sort();
  const changed = [...after.keys()].filter((path) => relevant(path) && before.has(path) && before.get(path) !== after.get(path)).sort();
  return { added, removed, changed };
}
