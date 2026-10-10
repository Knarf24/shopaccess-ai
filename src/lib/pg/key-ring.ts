import { timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import { hmacSha256Hex } from "../shared/crypto";
import { err, ok, type Result } from "../shared/result";
import type { PgQueryable } from "./client";
import { SESSION_STATEMENTS } from "./statements";

/**
 * Purpose-separated key rings for PostgreSQL mode (specification 18.5, D-21).
 *
 * A ring is the set of key versions a web process has been configured with.
 * Which version is ACTIVE, VERIFY_ONLY or REVOKED is decided by the database's
 * `server_key_versions` rows, never by the ring. A configured version with no
 * row is a staged key and is unused.
 *
 * A ring copies the key bytes it is given and never hands out its own
 * buffers: `keyFor` returns a fresh copy and `useKey` lends a temporary copy
 * that is zeroed afterwards. Mutating a buffer passed in, or one handed out,
 * cannot change the ring. Key bytes are not logged, serialized, placed in
 * errors or sent to the database: errors carry a variable name and a version
 * number only.
 *
 * `loadKeyRings` is the one initialization boundary: it parses both rings and
 * refuses identical key bytes across the two purposes. The session service
 * accepts only what that boundary returns.
 *
 * Mock mode's single `SHOPACCESS_SESSION_KEY` is untouched by this module.
 */

export const KEY_PURPOSES = ["session", "confirmation_nonce"] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

/** Environment variable holding each ring. Read by the caller, never here. */
export const KEY_RING_VARIABLES: Readonly<Record<KeyPurpose, string>> = Object.freeze({
  session: "SHOPACCESS_SESSION_KEYS",
  confirmation_nonce: "SHOPACCESS_NONCE_KEYS",
});

export const KEY_RING_MIN_KEY_BYTES = 32;
export const KEY_RING_MAX_VERSION = 32_767;
export const KEY_CHECK_LABEL = "shopaccess.keycheck.v1";

export type KeyRingParseErrorCode =
  | "RING_MISSING"
  | "ENTRY_MALFORMED"
  | "VERSION_INVALID"
  | "VERSION_DUPLICATE"
  | "KEY_ENCODING_INVALID"
  | "KEY_TOO_SHORT";

/** Never contains key material. */
export interface KeyRingParseError {
  readonly code: KeyRingParseErrorCode;
  readonly variable: string;
  readonly version: number | null;
}

/** Decimal digits only, first digit 1 to 9, at most five digits. */
const VERSION_PATTERN = /^[1-9][0-9]{0,4}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A private copy of key bytes in memory of its own. `Buffer.from` would place a
 * small copy in Node's shared buffer pool, next to unrelated data; `Buffer.alloc`
 * never uses the pool.
 */
function privateCopy(key: Uint8Array): Buffer {
  const copy = Buffer.alloc(key.length);
  copy.set(key);
  return copy;
}

/** A validated ring. Printing or serializing it shows versions only. */
export class KeyRing {
  readonly #keys: ReadonlyMap<number, Buffer>;
  // The purpose is a private field, not a property: it cannot be reassigned,
  // redefined or shadowed from outside, whatever the caller does at run time.
  readonly #purpose: KeyPurpose;

  /**
   * Validates and COPIES every key. Throws a TypeError that names the version
   * only, never the key, when a version is out of range or a key is too short.
   * The instance is frozen and the class cannot be subclassed.
   */
  constructor(purpose: KeyPurpose, keys: ReadonlyMap<number, Uint8Array>) {
    if (new.target !== KeyRing) throw new TypeError("KeyRing cannot be subclassed");
    if (!KEY_PURPOSES.includes(purpose)) throw new TypeError("Unknown key purpose");
    this.#purpose = purpose;
    const copies = new Map<number, Buffer>();
    for (const [version, key] of keys) {
      if (!Number.isInteger(version) || version < 1 || version > KEY_RING_MAX_VERSION) {
        throw new TypeError("A key version is out of range");
      }
      if (!(key instanceof Uint8Array) || key.length < KEY_RING_MIN_KEY_BYTES) {
        throw new TypeError(`Key version ${version} is shorter than ${KEY_RING_MIN_KEY_BYTES} bytes`);
      }
      // The caller's buffer is not retained.
      copies.set(version, privateCopy(key));
    }
    if (copies.size === 0) throw new TypeError("A key ring holds at least one key version");
    this.#keys = copies;
    Object.freeze(this);
  }

  /** The purpose fixed at construction. Read-only at run time as well as in the type system. */
  get purpose(): KeyPurpose {
    return this.#purpose;
  }

  /**
   * The purpose of a genuine ring, read from its private field. Unlike the
   * `purpose` getter this cannot be answered by a look-alike object: it throws
   * a TypeError for anything that is not a KeyRing.
   */
  static purposeOf(ring: KeyRing): KeyPurpose {
    return ring.#purpose;
  }

  versions(): number[] {
    return [...this.#keys.keys()].sort((left, right) => left - right);
  }

  has(version: number): boolean {
    return this.#keys.has(version);
  }

  /** A fresh COPY of one version's key bytes, or null. The ring's own buffer is never returned. */
  keyFor(version: number): Buffer | null {
    const key = this.#keys.get(version);
    return key ? privateCopy(key) : null;
  }

  /**
   * Lends a temporary copy of one version's key to `work`, which must use it
   * synchronously, then zeroes the copy. Returns null for an unknown version.
   */
  useKey<T>(version: number, work: (key: Buffer) => T): T | null {
    const copy = this.keyFor(version);
    if (!copy) return null;
    try {
      return work(copy);
    } finally {
      copy.fill(0);
    }
  }

  /** The check value of one version (see `computeKeyCheckValue`), or null. It is not secret. */
  checkValue(version: number): string | null {
    const key = this.#keys.get(version);
    return key ? computeKeyCheckValue(key, this.#purpose) : null;
  }

  /** True when the two rings contain identical key bytes under any versions. Compared in constant time. */
  sharesKeyMaterialWith(other: KeyRing): boolean {
    let shared = false;
    for (const left of this.#keys.values()) {
      for (const right of other.#keys.values()) {
        if (left.length === right.length && timingSafeEqual(left, right)) shared = true;
      }
    }
    return shared;
  }

  toJSON(): { purpose: KeyPurpose; versions: number[] } {
    return { purpose: this.#purpose, versions: this.versions() };
  }

  [inspect.custom](): string {
    return `KeyRing(${this.#purpose}; versions ${this.versions().join(", ")}; key material redacted)`;
  }
}

// Methods and accessors cannot be replaced on the prototype or on the class.
Object.freeze(KeyRing.prototype);
Object.freeze(KeyRing);

function decodeStrictBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  // Rejects non-canonical encodings that Buffer would otherwise accept leniently.
  return decoded.toString("base64") === value ? decoded : null;
}

/**
 * Parses `version:base64key` entries separated by commas. Strict: no
 * whitespace, no empty entry, version 1 to 32767 without sign or leading zero,
 * canonical base64, at least 32 decoded bytes, no duplicate version. Fails
 * closed: there is no default and no partial ring.
 */
export function parseKeyRing(purpose: KeyPurpose, value: string | undefined): Result<KeyRing, KeyRingParseError> {
  const variable = KEY_RING_VARIABLES[purpose];
  const fail = (code: KeyRingParseErrorCode, version: number | null = null) => err({ code, variable, version });

  if (value === undefined || value === "") return fail("RING_MISSING");
  if (/\s/.test(value)) return fail("ENTRY_MALFORMED");

  const keys = new Map<number, Buffer>();
  for (const entry of value.split(",")) {
    const separator = entry.indexOf(":");
    if (separator === -1) return fail("ENTRY_MALFORMED");
    const versionText = entry.slice(0, separator);
    const keyText = entry.slice(separator + 1);
    if (!VERSION_PATTERN.test(versionText) || Number(versionText) > KEY_RING_MAX_VERSION) return fail("VERSION_INVALID");
    if (keyText === "") return fail("ENTRY_MALFORMED");
    const version = Number(versionText);
    if (keys.has(version)) return fail("VERSION_DUPLICATE", version);
    const key = decodeStrictBase64(keyText);
    if (!key) return fail("KEY_ENCODING_INVALID", version);
    if (key.length < KEY_RING_MIN_KEY_BYTES) return fail("KEY_TOO_SHORT", version);
    keys.set(version, key);
  }
  const ring = new KeyRing(purpose, keys);
  // The ring holds its own copies; the decoded intermediates are cleared.
  for (const decoded of keys.values()) decoded.fill(0);
  return ok(ring);
}

/**
 * HMAC-SHA-256 under the key, over the label `shopaccess.keycheck.v1`, one zero
 * byte and the purpose name; 64 lowercase hex characters. This is what an
 * operator registers when activating a version. It is one-way and not secret.
 */
export function computeKeyCheckValue(key: Buffer, purpose: KeyPurpose): string {
  return hmacSha256Hex(key, KEY_CHECK_LABEL, purpose);
}

/** True when the two rings contain identical key bytes under any versions. Such a configuration is refused. */
export function ringsShareKeyMaterial(left: KeyRing, right: KeyRing): boolean {
  return left.sharesKeyMaterialWith(right);
}

export type KeyRingsError =
  | KeyRingParseError
  | { readonly code: "RING_PURPOSE_MISMATCH" }
  | { readonly code: "KEY_MATERIAL_SHARED_ACROSS_PURPOSES" };

// Module-private: only `validateKeyRings` can construct a ConfiguredKeyRings.
const CONFIGURED_KEY_RINGS_TOKEN = Symbol("shopaccess.pg.configured-key-rings");

/**
 * Both purpose rings, after the checks that only make sense for the pair. An
 * instance exists only if each ring has its own purpose and no key bytes occur
 * in both. Obtained from `loadKeyRings` or `validateKeyRings`.
 */
export class ConfiguredKeyRings {
  readonly #validated = true;

  constructor(
    token: symbol,
    readonly session: KeyRing,
    readonly confirmationNonce: KeyRing,
  ) {
    if (token !== CONFIGURED_KEY_RINGS_TOKEN || new.target !== ConfiguredKeyRings) {
      throw new TypeError("Configured key rings are obtained only through loadKeyRings or validateKeyRings");
    }
    Object.freeze(this);
  }

  /** Always true. Its presence makes the class nominal, so a look-alike object does not type-check. */
  get validated(): boolean {
    return this.#validated;
  }
}

Object.freeze(ConfiguredKeyRings.prototype);
Object.freeze(ConfiguredKeyRings);

/**
 * Checks the pair: purposes, and purpose separation of the key bytes themselves.
 * Purposes are read from each ring's private field, so only genuine rings pass
 * and a ring cannot present a purpose other than the one it was built with.
 */
export function validateKeyRings(session: KeyRing, confirmationNonce: KeyRing): Result<ConfiguredKeyRings, KeyRingsError> {
  let sessionPurpose: KeyPurpose;
  let noncePurpose: KeyPurpose;
  try {
    sessionPurpose = KeyRing.purposeOf(session);
    noncePurpose = KeyRing.purposeOf(confirmationNonce);
  } catch {
    return err({ code: "RING_PURPOSE_MISMATCH" });
  }
  if (sessionPurpose !== "session" || noncePurpose !== "confirmation_nonce") {
    return err({ code: "RING_PURPOSE_MISMATCH" });
  }
  if (session.sharesKeyMaterialWith(confirmationNonce)) return err({ code: "KEY_MATERIAL_SHARED_ACROSS_PURPOSES" });
  return ok(new ConfiguredKeyRings(CONFIGURED_KEY_RINGS_TOKEN, session, confirmationNonce));
}

/**
 * The initialization boundary for PostgreSQL mode. Takes the raw values of
 * `SHOPACCESS_SESSION_KEYS` and `SHOPACCESS_NONCE_KEYS` (read by the caller;
 * this module reads no environment variable), parses each strictly and refuses
 * the pair if any key bytes occur in both. Fails closed: any error means no rings.
 */
export function loadKeyRings(values: {
  readonly sessionKeys: string | undefined;
  readonly nonceKeys: string | undefined;
}): Result<ConfiguredKeyRings, KeyRingsError> {
  const session = parseKeyRing("session", values.sessionKeys);
  if (!session.ok) return session;
  const confirmationNonce = parseKeyRing("confirmation_nonce", values.nonceKeys);
  if (!confirmationNonce.ok) return confirmationNonce;
  return validateKeyRings(session.value, confirmationNonce.value);
}

export type KeyVersionStatus = "ACTIVE" | "VERIFY_ONLY" | "REVOKED";

export interface KeyVersionRow {
  readonly purpose: KeyPurpose;
  readonly keyVersion: number;
  readonly status: KeyVersionStatus;
  readonly checkValue: string;
}

const STATUSES: readonly string[] = ["ACTIVE", "VERIFY_ONLY", "REVOKED"];

/** Validates rows read from `server_key_versions`. Returns null if any row is not exactly as expected. */
export function parseKeyVersionRows(purpose: KeyPurpose, rows: readonly unknown[]): KeyVersionRow[] | null {
  const parsed: KeyVersionRow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return null;
    const record = row as Record<string, unknown>;
    const keyVersion = record.key_version;
    const status = record.status;
    const checkValue = record.check_value;
    if (record.purpose !== purpose) return null;
    if (typeof keyVersion !== "number" || !Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > KEY_RING_MAX_VERSION) return null;
    if (typeof status !== "string" || !STATUSES.includes(status)) return null;
    if (typeof checkValue !== "string" || !/^[0-9a-f]{64}$/.test(checkValue)) return null;
    parsed.push({ purpose, keyVersion, status: status as KeyVersionStatus, checkValue });
  }
  return parsed;
}

export type KeyStateErrorCode =
  | "KEY_ROWS_INVALID"
  | "NO_ACTIVE_VERSION"
  | "ACTIVE_KEY_NOT_CONFIGURED"
  | "CHECK_VALUE_MISMATCH";

/** Never contains key material or a check value. */
export interface KeyStateError {
  readonly code: KeyStateErrorCode;
  readonly purpose: KeyPurpose;
  readonly version: number | null;
}

export interface KeyState {
  readonly purpose: KeyPurpose;
  /** The database-designated ACTIVE version. It decides admission and need not be the highest configured version. */
  readonly activeVersion: number;
  /** Configured versions the database accepts, with their standing. */
  readonly usable: ReadonlyMap<number, "ACTIVE" | "VERIFY_ONLY">;
  /** Configured versions with no database row. Unused until an operator activates them. */
  readonly staged: readonly number[];
  /** Configured versions the database has revoked. Their keys are ignored. */
  readonly revoked: readonly number[];
}

/**
 * Reconciles a ring with the database's key-version rows. Fails closed:
 *  - no ACTIVE row (for example after an emergency revocation): refused;
 *  - the ACTIVE version is not configured: refused;
 *  - any configured, non-revoked version whose check value does not match: refused.
 * A revoked version's key is ignored and a version without a row is staged.
 */
export function resolveKeyState(ring: KeyRing, rows: readonly KeyVersionRow[]): Result<KeyState, KeyStateError> {
  const purpose = KeyRing.purposeOf(ring);
  const fail = (code: KeyStateErrorCode, version: number | null = null) => err({ code, purpose, version });

  const byVersion = new Map<number, KeyVersionRow>();
  for (const row of rows) {
    if (row.purpose !== purpose || byVersion.has(row.keyVersion)) return fail("KEY_ROWS_INVALID");
    byVersion.set(row.keyVersion, row);
  }
  const activeRows = rows.filter((row) => row.status === "ACTIVE");
  if (activeRows.length === 0) return fail("NO_ACTIVE_VERSION");
  if (activeRows.length > 1) return fail("KEY_ROWS_INVALID");
  const activeVersion = activeRows[0].keyVersion;

  const usable = new Map<number, "ACTIVE" | "VERIFY_ONLY">();
  const staged: number[] = [];
  const revoked: number[] = [];
  for (const version of ring.versions()) {
    const row = byVersion.get(version);
    if (!row) {
      staged.push(version);
    } else if (row.status === "REVOKED") {
      revoked.push(version);
    } else if (ring.checkValue(version) !== row.checkValue) {
      return fail("CHECK_VALUE_MISMATCH", version);
    } else {
      usable.set(version, row.status);
    }
  }
  if (!usable.has(activeVersion)) return fail("ACTIVE_KEY_NOT_CONFIGURED", activeVersion);
  return ok({ purpose, activeVersion, usable, staged, revoked });
}

/** Reads the key-version rows of one purpose and reconciles them with the ring. */
export async function loadKeyState(db: PgQueryable, ring: KeyRing): Promise<Result<KeyState, KeyStateError>> {
  const purpose = KeyRing.purposeOf(ring);
  const result = await db.query(SESSION_STATEMENTS.readKeyVersions, [purpose]);
  const rows = parseKeyVersionRows(purpose, result.rows);
  if (!rows) return err({ code: "KEY_ROWS_INVALID", purpose, version: null });
  return resolveKeyState(ring, rows);
}
