import { isDeepStrictEqual } from "node:util";

/**
 * Comparisons and diagnostics for the integration driver that cannot print a sensitive value
 * (specification 19.19, Increment 2.3).
 *
 * Pure: no database, network, process, file or environment access. Importing this module does nothing.
 *
 * Why it exists. A test runner prints the actual and expected values of a failed matcher. The driver holds session
 * cookies, CSRF tokens, confirmation nonces, digests, owner identifiers, keys, passwords and connection URLs, and
 * none of them may reach the runner's output. So the driver never hands such a value to a matcher. It compares
 * values itself, in memory, and fails through the functions below, which decide what the failure may say:
 *  - a fixed label, written in the driver's source;
 *  - counts and booleans;
 *  - names of fields, tables, headers and categories;
 *  - a value only after `safeText` has accepted it, which it does for a small grammar of codes, names and local
 *    paths and for nothing that could be a token, a digest, a key or a URL with a host.
 *
 * Disclosure is prevented here, where the message is made. Nothing depends on scanning or redacting output later.
 */

/** A failure whose message was built by this module. It carries no `actual`, `expected` or `cause` for a runner to print. */
export class SafeAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeAssertionError";
    MADE_HERE.add(this);
  }
}

/**
 * Whether a value is a failure this module made. Decided by identity in a private set, so that asking it of a
 * hostile object runs none of that object's code: no prototype lookup, no getter, no proxy trap.
 */
export function isSafeAssertion(value: unknown): value is SafeAssertionError {
  return typeof value === "object" && value !== null && MADE_HERE.has(value);
}

const MADE_HERE = new WeakSet<object>();

const WITHHELD = "[withheld]";
/** Identifiers of this application: a short prefix and 32 hex digits. Shown as their prefix only. */
const IDENTIFIER = /\b([a-z]{2,3})_[0-9a-f]{32}\b/g;
const LONG_HEX = /[0-9a-f]{12,}/;
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const ATTRIBUTE = /^[A-Za-z-]{1,20}(?:=[A-Za-z0-9/]{1,12})?$/;
const LOCAL_PATH = /^(?:\/(?:[a-z]+|<[a-z]{2,3}>))*\/?(?:\?[a-z]+=[A-Za-z0-9_]{1,32}(?:&[a-z]+=[A-Za-z0-9_]{1,32})*)?$/;

function safeString(value: string): string {
  if (value.length > 160) return WITHHELD;
  const masked = value.replace(IDENTIFIER, "<$1>");
  if (LONG_HEX.test(masked)) return WITHHELD;
  if (masked === "" || CODE.test(masked) || NAME.test(masked) || ATTRIBUTE.test(masked)) return JSON.stringify(masked);
  if (masked.startsWith("/") && LOCAL_PATH.test(masked)) return JSON.stringify(masked);
  return WITHHELD;
}

/**
 * A value as a failure message may show it. Numbers, booleans, null and undefined are shown. A string is shown only
 * when it is a code (`QUOTED`), a name (`audit_events`), a cookie attribute (`SameSite=Lax`) or a local path whose
 * identifiers are reduced to their prefix and whose query values are at most 32 characters; anything else,
 * including every string with twelve hex digits in a row, is `[withheld]`. Arrays and objects are shown member by
 * member, to a small depth.
 */
export function safeText(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return safeString(value);
  if (depth >= 3) return WITHHELD;
  if (Array.isArray(value)) return `[${value.map((member) => safeText(member, depth + 1)).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, member]) => `${NAME.test(key) || /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) ? key : WITHHELD}: ${safeText(member, depth + 1)}`)
      .join(", ")}}`;
  }
  return WITHHELD;
}

/** Fails with the label and nothing else. The label is fixed text from the driver's source, or built from safe parts. */
export function requireThat(condition: boolean, label: string): void {
  if (condition !== true) throw new SafeAssertionError(label);
}

/**
 * Deep equality of two values that are safe by construction: statuses, codes, counts, names, local paths. Both
 * are still passed through `safeText` before they are shown, so a value that should not have been here is
 * withheld rather than printed.
 */
export function requireSafeEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new SafeAssertionError(`${label}: expected ${safeText(expected)}, observed ${safeText(actual)}`);
}

/** Equality of two sensitive values. Compared in memory; neither is ever part of the message. */
export function requireSameSecret(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new SafeAssertionError(`${label}: the two values differ (values withheld)`);
}

/** Inequality of two sensitive values. */
export function requireDifferentSecret(actual: unknown, other: unknown, label: string): void {
  if (isDeepStrictEqual(actual, other)) throw new SafeAssertionError(`${label}: the two values are the same (values withheld)`);
}

/** The names of the fields in which two records differ, a field present in only one included. Names only. */
export function differingFields(actual: Readonly<Record<string, unknown>>, expected: Readonly<Record<string, unknown>>): string[] {
  const names = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...names].filter((name) => !(name in actual) || !(name in expected) || !isDeepStrictEqual(actual[name], expected[name])).sort();
}

/** Field-by-field equality of two records of sensitive values. A failure names the differing fields, never a value. */
export function requireSameFields(actual: Readonly<Record<string, unknown>>, expected: Readonly<Record<string, unknown>>, label: string): void {
  const differing = differingFields(actual, expected);
  if (differing.length > 0) throw new SafeAssertionError(`${label}: ${differing.length} field(s) differ: ${differing.map((name) => safeText(name)).join(", ")} (values withheld)`);
}

/** What two full-content row sets do not share, as counts. The comparison is of every row's whole text. */
export function rowDifference(before: readonly string[], after: readonly string[]): { readonly removed: number; readonly added: number } {
  const earlier = new Map<string, number>();
  for (const row of before) earlier.set(row, (earlier.get(row) ?? 0) + 1);
  let added = 0;
  for (const row of after) {
    const count = earlier.get(row) ?? 0;
    if (count > 0) earlier.set(row, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of earlier.values()) removed += count;
  return { removed, added };
}

/** Full-content equality of two row sets. A changed row is one removed and one added. The message holds counts only. */
export function requireSameRows(before: readonly string[], after: readonly string[], label: string): void {
  const { removed, added } = rowDifference(before, after);
  if (removed > 0 || added > 0) throw new SafeAssertionError(`${label}: ${removed} row(s) no longer present and ${added} row(s) new or changed (row content withheld)`);
}

/** `text` holds `part`. Neither is shown: `text` is a response or a page, and `part` may be a value from one. */
export function requireContains(text: string, part: string, label: string): void {
  if (part === "" || !text.includes(part)) throw new SafeAssertionError(`${label}: not found (content withheld)`);
}

/** `text` does not hold `part`. */
export function requireAbsent(text: string, part: string, label: string): void {
  if (part !== "" && text.includes(part)) throw new SafeAssertionError(`${label}: found (content withheld)`);
}

// ---------------------------------------------------------------------------
// Disclosure scans
// ---------------------------------------------------------------------------

export interface SecretEntry {
  /** A fixed word for the kind of value: "password", "owner id". It is what a finding reports. */
  readonly category: string;
  readonly value: string;
}

export interface ScannedReply {
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: string;
}

export type ResponseSurface = "body" | "header" | "set-cookie";

export interface DisclosureFinding {
  readonly surface: ResponseSurface;
  /** The header's name when it is an ordinary header name, `[withheld]` when it is not, and null for a body. */
  readonly header: string | null;
  readonly category: string;
  readonly matches: number;
}

function occurrences(text: string, value: string): number {
  if (value === "") return 0;
  let count = 0;
  for (let index = text.indexOf(value); index !== -1; index = text.indexOf(value, index + value.length)) count += 1;
  return count;
}

/** How often each category occurs in a text, for categories that occur at all. Never a value. */
export function scanText(text: string, secrets: readonly SecretEntry[]): Array<{ readonly category: string; readonly matches: number }> {
  const totals = new Map<string, number>();
  for (const secret of secrets) {
    const found = occurrences(text, secret.value);
    if (found > 0) totals.set(secret.category, (totals.get(secret.category) ?? 0) + found);
  }
  return [...totals.entries()].map(([category, matches]) => ({ category, matches })).sort((left, right) => left.category.localeCompare(right.category));
}

/**
 * Scans one response: its body, every header other than Set-Cookie, and Set-Cookie apart from them. A Set-Cookie
 * header rightly carries a session cookie, so the categories named in `allowedInSetCookie` are not looked for
 * there; every other category is. Header names are matched case-insensitively.
 */
export function scanReply(reply: ScannedReply, secrets: readonly SecretEntry[], allowedInSetCookie: readonly string[]): DisclosureFinding[] {
  const findings: DisclosureFinding[] = [];
  for (const found of scanText(reply.body, secrets)) findings.push({ surface: "body", header: null, ...found });
  for (const [name, values] of Object.entries(reply.headers)) {
    const lower = name.toLowerCase();
    const cookie = lower === "set-cookie";
    const searched = cookie ? secrets.filter((secret) => !allowedInSetCookie.includes(secret.category)) : secrets;
    const shown = /^[a-z0-9-]{1,40}$/.test(lower) ? lower : WITHHELD;
    for (const found of scanText(values.join("\n"), searched)) findings.push({ surface: cookie ? "set-cookie" : "header", header: shown, ...found });
  }
  return findings;
}

/** Findings as text: surface, header name, category and count. Categories and header names only. */
export function describeFindings(findings: readonly DisclosureFinding[]): string {
  const totals = new Map<string, number>();
  for (const finding of findings) {
    const key = `${finding.surface}${finding.header === null ? "" : ` ${finding.header}`}: ${safeCategory(finding.category)}`;
    totals.set(key, (totals.get(key) ?? 0) + finding.matches);
  }
  return [...totals.entries()].map(([key, matches]) => `${key} x${matches}`).sort().join("; ");
}

function safeCategory(category: string): string {
  return /^[A-Za-z][A-Za-z ]{0,39}$/.test(category) ? category : WITHHELD;
}

/** Fails when anything was found, saying where, what kind and how often. */
export function requireNoFindings(findings: readonly DisclosureFinding[], label: string): void {
  if (findings.length > 0) throw new SafeAssertionError(`${label}: ${describeFindings(findings)} (values withheld)`);
}

/** The same for a text that is not a response, such as a log. */
export function requireNoSecretsInText(text: string, secrets: readonly SecretEntry[], label: string): void {
  const found = scanText(text, secrets);
  if (found.length > 0) throw new SafeAssertionError(`${label}: ${found.map((entry) => `${safeCategory(entry.category)} x${entry.matches}`).join("; ")} (values withheld)`);
}

// ---------------------------------------------------------------------------
// Failures that were not assertions
// ---------------------------------------------------------------------------

/**
 * Nothing of an unexpected error is forwarded: not its message, its name, its stack, its cause, the errors an
 * aggregate holds, or any property it carries. Text an error brings with it is arbitrary, and whether a secret in
 * it happens to be known at that moment cannot be relied on. An unexpected failure is therefore reported as
 *   - a fixed operation label, written in the caller's source;
 *   - one category of the closed list below; and
 *   - a code, only when the error's own `code` is exactly one of the strings listed below.
 * Anything else is the fixed fallback: category UNKNOWN, no code.
 */
export type FailureCategory = "ASSERTION" | "REQUEST" | "STARTUP" | "CLEANUP" | "DATABASE_TARGET" | "NETWORK" | "FILESYSTEM" | "DATABASE" | "PROGRAMMING" | "AGGREGATE" | "UNKNOWN";

export const FAILURE_CATEGORIES: readonly FailureCategory[] = ["ASSERTION", "REQUEST", "STARTUP", "CLEANUP", "DATABASE_TARGET", "NETWORK", "FILESYSTEM", "DATABASE", "PROGRAMMING", "AGGREGATE", "UNKNOWN"];

/**
 * The exact codes that may be reported, each with its category. A code is matched as a whole string against these
 * keys; there is no pattern. A code that is not here is not reported, whatever it looks like.
 */
export const FAILURE_CODES: ReadonlyMap<string, FailureCategory> = new Map<string, FailureCategory>([
  // This driver's own request outcomes.
  ["REQUEST_DEADLINE", "REQUEST"],
  ["REQUEST_ABORTED", "REQUEST"],
  ["REQUEST_FAILED", "REQUEST"],
  // This driver's own startup outcomes.
  ["STARTUP_CANCELLED", "STARTUP"],
  ["PORT_IN_USE", "STARTUP"],
  ["SPAWN_FAILED", "STARTUP"],
  ["EXITED_EARLY", "STARTUP"],
  ["STARTUP_DEADLINE", "STARTUP"],
  ["LOG_CAPTURE_FAILED", "STARTUP"],
  // Raised by this driver's cleanup steps.
  ["REQUESTS_OUTSTANDING", "CLEANUP"],
  ["APPLICATION_NOT_STOPPED", "CLEANUP"],
  ["APPLICATION_NOT_RUNNING", "CLEANUP"],
  ["FIXTURE_NOT_OPEN", "CLEANUP"],
  ["PROCESS_REMAINING", "CLEANUP"],
  ["CLEANUP_RESULT_UNREADABLE", "CLEANUP"],
  // The harness's fixed refusals of a database target (tests/db/harness.ts, AdminTargetRefusal).
  ["ADMIN_URL_NOT_SET", "DATABASE_TARGET"],
  ["ADMIN_URL_EMPTY", "DATABASE_TARGET"],
  ["ADMIN_URL_MALFORMED", "DATABASE_TARGET"],
  ["ADMIN_URL_PARSER_DISAGREES", "DATABASE_TARGET"],
  ["AUTHORIZED_PORT_MISSING", "DATABASE_TARGET"],
  ["AUTHORIZED_PORT_INVALID", "DATABASE_TARGET"],
  ["AUTHORIZED_PORT_MISMATCH", "DATABASE_TARGET"],
  ["ENVIRONMENT_VARIABLE_REFUSED", "DATABASE_TARGET"],
  ["CONNECTION_FIELD_REFUSED", "DATABASE_TARGET"],
  ["DRIVER_TARGET_MISMATCH", "DATABASE_TARGET"],
  // Operating-system socket errors.
  ["ECONNREFUSED", "NETWORK"],
  ["ECONNRESET", "NETWORK"],
  ["ETIMEDOUT", "NETWORK"],
  ["EPIPE", "NETWORK"],
  ["EADDRINUSE", "NETWORK"],
  // Operating-system file errors.
  ["ENOENT", "FILESYSTEM"],
  ["EEXIST", "FILESYSTEM"],
  ["EACCES", "FILESYSTEM"],
  ["EPERM", "FILESYSTEM"],
  ["ENOSPC", "FILESYSTEM"],
  ["EISDIR", "FILESYSTEM"],
  ["ENOTDIR", "FILESYSTEM"],
  ["EIO", "FILESYSTEM"],
  ["WRITE_AFTER_CLOSE", "FILESYSTEM"],
  // PostgreSQL SQLSTATE values an observation or a fixture step can meet.
  ["08001", "DATABASE"],
  ["08006", "DATABASE"],
  ["28P01", "DATABASE"],
  ["3D000", "DATABASE"],
  ["40P01", "DATABASE"],
  ["42501", "DATABASE"],
  ["53300", "DATABASE"],
  ["55P03", "DATABASE"],
  ["57014", "DATABASE"],
  ["57P01", "DATABASE"],
]);

export interface FailureClass {
  readonly category: FailureCategory;
  /** One of the keys of `FAILURE_CODES`, or null. */
  readonly code: string | null;
  /** For an aggregate, how many errors it holds; otherwise 0. The errors themselves are not kept. */
  readonly members: number;
}

const UNKNOWN_FAILURE: FailureClass = { category: "UNKNOWN", code: null, members: 0 };

/**
 * Classifies anything that was thrown, and never throws itself. What was thrown is not trusted: a prototype
 * lookup, a getter or a proxy trap of it may run code or throw.
 *  - A failure the driver raised on purpose, or one this module made, is recognized by identity in private
 *    registries, which runs none of the value's code.
 *  - Anything else is examined inside one guard: its type, and its `code`, which is reported only when it is
 *    exactly a listed one. If the examination itself throws, the answer is the fixed fallback.
 * A name is never read: a name is text the error chose.
 */
export function classifyFailure(error: unknown): FailureClass {
  const trusted = trustedFailure(error);
  if (trusted !== null) return { category: trusted.code === null ? "UNKNOWN" : (FAILURE_CODES.get(trusted.code) ?? "UNKNOWN"), code: trusted.code, members: 0 };
  if (isSafeAssertion(error)) return { category: "ASSERTION", code: null, members: 0 };
  try {
    if (error instanceof AggregateError) {
      const held = Array.isArray(error.errors) ? error.errors.length : 0;
      return { category: "AGGREGATE", code: null, members: Number.isSafeInteger(held) && held >= 0 ? held : 0 };
    }
    if (typeof error === "object" && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string") {
        const category = FAILURE_CODES.get(code);
        if (category !== undefined) return { category, code, members: 0 };
      }
    }
    if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError) return { category: "PROGRAMMING", code: null, members: 0 };
  } catch {
    // Whatever the examination threw is discarded with it.
  }
  return UNKNOWN_FAILURE;
}

/** A failure class as text: fixed words, a listed category, a listed code or NONE, and a count. */
export function describeFailureClass(failure: FailureClass): string {
  const category = FAILURE_CATEGORIES.includes(failure.category) ? failure.category : "UNKNOWN";
  const code = failure.code !== null && FAILURE_CODES.has(failure.code) ? failure.code : "NONE";
  const members = Number.isSafeInteger(failure.members) && failure.members > 0 ? ` errors=${failure.members}` : "";
  return `category=${category} code=${code}${members}`;
}

/**
 * A label as a message may carry it: the text itself when it is short, made of letters, digits, spaces and a
 * little punctuation, and has no word of 25 characters or more, as the fixed labels in the driver's source are;
 * otherwise fixed words. This is a guard
 * against a mistake in a caller, not a way to pass a value through.
 */
export function safeLabel(label: unknown): string {
  return typeof label === "string" && /^[A-Za-z0-9 ,.:'()/-]{1,80}$/.test(label) && !/\S{25,}/.test(label) && !LONG_HEX.test(label) ? label : "unlabelled operation";
}

// ---------------------------------------------------------------------------
// Cleanup: exact lists of step names and of facts
// ---------------------------------------------------------------------------

/** The cleanup steps the driver has, by their exact names. A name that is not one of these is not written. */
export const CLEANUP_STEP_NAMES: readonly string[] = [
  "abort and settle outstanding requests",
  "stop application 1 and close its log",
  "stop application 2 and close its log",
  "stop application 3 and close its log",
  "destroy the disposable database fixture (harness cleanup)",
];
export const UNLISTED_STEP = "unlisted step";

/** A listed step name as it is; anything else, of any type, as the one placeholder. Compared, never matched by pattern. */
export function cleanupStepName(name: unknown): string {
  return typeof name === "string" && CLEANUP_STEP_NAMES.includes(name) ? name : UNLISTED_STEP;
}

/** The facts a cleanup step may record, by their exact keys. Booleans: */
export const CLEANUP_BOOLEAN_FACTS: readonly string[] = ["stopped", "processRemaining", "portFree", "processRemainedAfterEarlierAttempt"];
/** Counts: whole numbers from 0 to `FACT_COUNT_LIMIT`. */
export const CLEANUP_COUNT_FACTS: readonly string[] = ["aborted", "outstanding", "signalsSent", "logFailures", "problems", "stopAttempts", "failedStopAttempts"];
export const FACT_COUNT_LIMIT = 1_000_000;

export type SafeFacts = Readonly<Record<string, number | boolean>>;

export interface InspectedFacts {
  readonly facts: Record<string, number | boolean>;
  /** How many keys of the given object were not kept: unlisted, of the wrong type, out of range, or not plain data. */
  readonly dropped: number;
}

/** A whole number from 0 to the limit, or the fallback. */
export function boundedCount(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= FACT_COUNT_LIMIT ? value : fallback;
}

/**
 * The value of an own, plain data property, or undefined when the object has no such property. A property that is
 * an accessor is refused by throwing, without calling it. The caller guards the call: a proxy may throw here.
 */
function ownData(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new TypeError("accessor");
  return descriptor.value;
}

/**
 * Keeps the listed facts of an object and counts the rest. Only the listed keys are read, as plain data: no getter
 * is called. Never throws: an object that cannot be examined yields no facts.
 */
export function inspectFacts(value: unknown): InspectedFacts {
  const facts: Record<string, number | boolean> = {};
  if (typeof value !== "object" || value === null) return { facts, dropped: 0 };
  try {
    let kept = 0;
    for (const key of CLEANUP_BOOLEAN_FACTS) {
      const fact = ownData(value, key);
      if (typeof fact === "boolean") {
        facts[key] = fact;
        kept += 1;
      }
    }
    for (const key of CLEANUP_COUNT_FACTS) {
      const fact = ownData(value, key);
      if (boundedCount(fact, -1) >= 0) {
        facts[key] = fact as number;
        kept += 1;
      }
    }
    return { facts, dropped: boundedCount(Object.keys(value).length - kept) };
  } catch {
    return { facts: {}, dropped: 0 };
  }
}

export function safeFacts(value: unknown): Record<string, number | boolean> {
  return inspectFacts(value).facts;
}

interface TrustedFailure {
  /** A listed code, or null. */
  readonly code: string | null;
  readonly facts: SafeFacts;
  readonly dropped: number;
}

const RAISED_HERE = new WeakMap<object, TrustedFailure>();

/**
 * What the driver recorded when it raised this failure on purpose, or null for anything else. Looked up by
 * identity: nothing of the value is read, so a forged or hostile object gets null and runs no code.
 */
export function trustedFailure(error: unknown): TrustedFailure | null {
  return typeof error === "object" && error !== null ? (RAISED_HERE.get(error) ?? null) : null;
}

/**
 * A failure raised on purpose by the driver, with one of the listed codes and, optionally, listed facts. Its
 * message is the code. What cleanup later reports of it comes from a private record made here, never from
 * reading the object again.
 */
export class CodedFailure extends Error {
  readonly code: string;
  readonly facts: SafeFacts;
  constructor(code: string, facts: SafeFacts = {}) {
    const listed = FAILURE_CODES.has(code);
    super(listed ? code : "unlisted code");
    this.name = "CodedFailure";
    // An unlisted code is not kept, so that nothing printing this error's properties can show it.
    this.code = listed ? code : "UNLISTED";
    const inspected = inspectFacts(facts);
    this.facts = Object.freeze(inspected.facts);
    RAISED_HERE.set(this, { code: listed ? code : null, facts: this.facts, dropped: inspected.dropped });
  }
}

/**
 * An unexpected failure as a `SafeAssertionError` that says where it happened and what class of failure it was,
 * and nothing else. The original error is not attached and nothing of its text is copied. A `SafeAssertionError`
 * is returned as it is: its message was made by this module.
 */
export function redactedFailure(error: unknown, operation: string): SafeAssertionError {
  if (isSafeAssertion(error)) return error;
  return new SafeAssertionError(`${safeLabel(operation)}: unexpected failure [${describeFailureClass(classifyFailure(error))}] (error text withheld)`);
}

/** Runs `work`; anything it throws is rethrown through `redactedFailure` under the fixed operation label. */
export async function withRedactedFailures<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw redactedFailure(error, operation);
  }
}
