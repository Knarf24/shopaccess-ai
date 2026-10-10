import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  computeKeyCheckValue,
  KEY_RING_VARIABLES,
  KeyRing,
  ConfiguredKeyRings,
  loadKeyRings,
  loadKeyState,
  parseKeyRing,
  parseKeyVersionRows,
  resolveKeyState,
  ringsShareKeyMaterial,
  validateKeyRings,
  type KeyVersionRow,
} from "@/lib/pg/key-ring";
import { SESSION_STATEMENTS } from "@/lib/pg/statements";

// Fixed test-only bytes. Not secrets: they exist only in this file.
const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const KEY_C = Buffer.alloc(48, 0xc3);
const b64 = (key: Buffer) => key.toString("base64");
const entry = (version: number, key: Buffer) => `${version}:${b64(key)}`;

describe("PGT-86 (database-free part): key-ring parsing is strict and fails closed", () => {
  it("uses the two approved variable names", () => {
    expect(KEY_RING_VARIABLES).toEqual({ session: "SHOPACCESS_SESSION_KEYS", confirmation_nonce: "SHOPACCESS_NONCE_KEYS" });
  });

  it("parses comma-separated version:base64key entries", () => {
    const ring = parseKeyRing("session", `${entry(2, KEY_B)},${entry(1, KEY_A)},${entry(32767, KEY_C)}`);
    if (!ring.ok) throw new Error("expected a ring");
    expect(ring.value.versions()).toEqual([1, 2, 32767]);
    expect(ring.value.keyFor(2)?.equals(KEY_B)).toBe(true);
    expect(ring.value.keyFor(3)).toBeNull();
    expect(ring.value.has(1)).toBe(true);
  });

  it.each([
    ["missing", undefined, "RING_MISSING", null],
    ["empty", "", "RING_MISSING", null],
    ["a space after the comma", `${entry(1, KEY_A)}, ${entry(2, KEY_B)}`, "ENTRY_MALFORMED", null],
    ["a trailing newline", `${entry(1, KEY_A)}\n`, "ENTRY_MALFORMED", null],
    ["a trailing comma", `${entry(1, KEY_A)},`, "ENTRY_MALFORMED", null],
    ["no version separator", b64(KEY_A), "ENTRY_MALFORMED", null],
    ["version zero", `0:${b64(KEY_A)}`, "VERSION_INVALID", null],
    ["a leading zero", `01:${b64(KEY_A)}`, "VERSION_INVALID", null],
    ["a signed version", `+1:${b64(KEY_A)}`, "VERSION_INVALID", null],
    ["a non-integer version", `1.5:${b64(KEY_A)}`, "VERSION_INVALID", null],
    ["a version above 32767", `32768:${b64(KEY_A)}`, "VERSION_INVALID", null],
    ["a six-digit version", `100000:${b64(KEY_A)}`, "VERSION_INVALID", null],
    ["a duplicate version", `${entry(1, KEY_A)},${entry(1, KEY_B)}`, "VERSION_DUPLICATE", 1],
    ["a 31-byte key", `3:${Buffer.alloc(31, 7).toString("base64")}`, "KEY_TOO_SHORT", 3],
    ["base64url characters", `4:${b64(Buffer.alloc(32, 0xfb)).replace(/\+/g, "-").replace(/\//g, "_")}`, "KEY_ENCODING_INVALID", 4],
    ["missing padding", `5:${b64(Buffer.alloc(32, 9)).replace(/=+$/, "")}`, "KEY_ENCODING_INVALID", 5],
    ["non-canonical base64", `6:${b64(Buffer.alloc(32, 9)).slice(0, -2)}R=`, "KEY_ENCODING_INVALID", 6],
    ["an empty key", "7:", "ENTRY_MALFORMED", null],
  ])("rejects %s", (_name, value, code, version) => {
    expect(parseKeyRing("session", value)).toEqual({ ok: false, error: { code, variable: "SHOPACCESS_SESSION_KEYS", version } });
  });

  it("names the nonce variable for the nonce ring", () => {
    expect(parseKeyRing("confirmation_nonce", undefined)).toEqual({
      ok: false,
      error: { code: "RING_MISSING", variable: "SHOPACCESS_NONCE_KEYS", version: null },
    });
  });

  it("never exposes key material in errors, JSON or inspection output", () => {
    const short = Buffer.alloc(31, 0x5a);
    const failure = parseKeyRing("session", `${entry(1, KEY_A)},9:${short.toString("base64")}`);
    const ring = parseKeyRing("session", `${entry(1, KEY_A)},${entry(2, KEY_B)}`);
    if (!ring.ok) throw new Error("expected a ring");
    const outputs = [JSON.stringify(failure), JSON.stringify(ring.value), inspect(ring.value), inspect({ nested: ring.value }, { depth: 5 }), String(ring.value), Object.keys(ring.value).join(",")];
    for (const output of outputs) {
      for (const key of [KEY_A, KEY_B, short]) {
        expect(output).not.toContain(key.toString("base64"));
        expect(output).not.toContain(key.toString("hex"));
      }
    }
    expect(JSON.parse(JSON.stringify(ring.value))).toEqual({ purpose: "session", versions: [1, 2] });
  });
});

describe("key check value: HMAC-SHA-256 over the label, a zero byte and the purpose", () => {
  it("matches an independent computation and is purpose-separated", () => {
    for (const purpose of ["session", "confirmation_nonce"] as const) {
      const expected = createHmac("sha256", KEY_A).update(Buffer.from(`shopaccess.keycheck.v1\0${purpose}`, "utf8")).digest("hex");
      expect(computeKeyCheckValue(KEY_A, purpose)).toBe(expected);
      expect(expected).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(computeKeyCheckValue(KEY_A, "session")).not.toBe(computeKeyCheckValue(KEY_A, "confirmation_nonce"));
    expect(computeKeyCheckValue(KEY_A, "session")).not.toBe(computeKeyCheckValue(KEY_B, "session"));
  });

  it("detects identical key bytes in the two purpose rings", () => {
    const session = new KeyRing("session", new Map([[1, KEY_A], [2, KEY_B]]));
    expect(ringsShareKeyMaterial(session, new KeyRing("confirmation_nonce", new Map([[7, Buffer.from(KEY_B)]])))).toBe(true);
    expect(ringsShareKeyMaterial(session, new KeyRing("confirmation_nonce", new Map([[1, KEY_C]])))).toBe(false);
  });
});

describe("PGT-86 (database-free part): the database ACTIVE version decides, and mismatches fail closed", () => {
  const ring = new KeyRing("session", new Map([[1, KEY_A], [2, KEY_B], [3, KEY_C]]));
  const row = (keyVersion: number, status: KeyVersionRow["status"], key: Buffer): KeyVersionRow => ({
    purpose: "session",
    keyVersion,
    status,
    checkValue: computeKeyCheckValue(key, "session"),
  });

  it("treats a configured version without a row as staged, even when it is the highest", () => {
    const state = resolveKeyState(ring, [row(1, "VERIFY_ONLY", KEY_A), row(2, "ACTIVE", KEY_B)]);
    if (!state.ok) throw new Error("expected a state");
    expect(state.value.activeVersion).toBe(2);
    expect([...state.value.usable]).toEqual([[1, "VERIFY_ONLY"], [2, "ACTIVE"]]);
    expect(state.value.staged).toEqual([3]);
    expect(state.value.revoked).toEqual([]);
  });

  it("ignores a revoked version's key, whatever its check value", () => {
    const state = resolveKeyState(ring, [row(1, "REVOKED", KEY_C), row(2, "ACTIVE", KEY_B)]);
    if (!state.ok) throw new Error("expected a state");
    expect(state.value.revoked).toEqual([1]);
    expect(state.value.usable.has(1)).toBe(false);
  });

  it.each([
    ["no ACTIVE row (for example after emergency revocation)", [row(1, "VERIFY_ONLY", KEY_A), row(2, "REVOKED", KEY_B)], "NO_ACTIVE_VERSION", null],
    ["no rows at all", [], "NO_ACTIVE_VERSION", null],
    ["the ACTIVE version is not configured", [row(9, "ACTIVE", KEY_A)], "ACTIVE_KEY_NOT_CONFIGURED", 9],
    ["the ACTIVE key's check value does not match", [row(2, "ACTIVE", KEY_A)], "CHECK_VALUE_MISMATCH", 2],
    ["a verification-only key's check value does not match", [row(1, "VERIFY_ONLY", KEY_B), row(2, "ACTIVE", KEY_B)], "CHECK_VALUE_MISMATCH", 1],
    ["two ACTIVE rows", [row(1, "ACTIVE", KEY_A), row(2, "ACTIVE", KEY_B)], "KEY_ROWS_INVALID", null],
    ["a repeated version", [row(2, "ACTIVE", KEY_B), row(2, "VERIFY_ONLY", KEY_B)], "KEY_ROWS_INVALID", null],
  ])("refuses when %s", (_name, rows, code, version) => {
    expect(resolveKeyState(ring, rows)).toEqual({ ok: false, error: { code, purpose: "session", version } });
  });

  it("validates rows read from the database and refuses anything unexpected", async () => {
    const good = { purpose: "session", key_version: 2, status: "ACTIVE", check_value: computeKeyCheckValue(KEY_B, "session") };
    expect(parseKeyVersionRows("session", [good])).toEqual([row(2, "ACTIVE", KEY_B)]);
    for (const bad of [
      { ...good, purpose: "confirmation_nonce" },
      { ...good, key_version: "2" },
      { ...good, key_version: 0 },
      { ...good, status: "STAGED" },
      { ...good, check_value: "abc" },
      null,
    ]) {
      expect(parseKeyVersionRows("session", [bad])).toBeNull();
    }
    const calls: Array<[string, readonly unknown[] | undefined]> = [];
    const db = { query: async (text: string, values?: readonly unknown[]) => (calls.push([text, values]), { rows: [good] }) };
    const loaded = await loadKeyState(db as never, ring);
    expect(loaded.ok && loaded.value.activeVersion).toBe(2);
    // The statement is the catalogue's, with the purpose as its only bound value.
    expect(calls).toEqual([[SESSION_STATEMENTS.readKeyVersions, ["session"]]]);
    const broken = { query: async () => ({ rows: [{ ...good, status: "?" }] }) };
    expect(await loadKeyState(broken as never, ring)).toEqual({
      ok: false,
      error: { code: "KEY_ROWS_INVALID", purpose: "session", version: null },
    });
  });
});

describe("key-ring safety: buffers are copied in and out, and both rings pass one validation boundary", () => {
  const snapshot = (ring: KeyRing, version: number) => ring.checkValue(version);

  it("copies key buffers at construction: mutating the caller's buffer afterwards changes nothing", () => {
    const supplied = Buffer.alloc(32, 0x41);
    const ring = new KeyRing("session", new Map([[1, supplied]]));
    const before = snapshot(ring, 1);
    expect(before).toBe(computeKeyCheckValue(Buffer.alloc(32, 0x41), "session"));

    supplied.fill(0);
    expect(snapshot(ring, 1)).toBe(before);
    expect(ring.keyFor(1)?.equals(Buffer.alloc(32, 0x41))).toBe(true);
    // A view over the same memory is not retained either.
    const backing = new Uint8Array(32).fill(0x42);
    const viewed = new KeyRing("session", new Map([[1, backing]]));
    backing.fill(0xff);
    expect(viewed.keyFor(1)?.equals(Buffer.alloc(32, 0x42))).toBe(true);
  });

  it("never hands out its own buffer: mutating a returned or lent key changes nothing", () => {
    const ring = new KeyRing("session", new Map([[1, KEY_A]]));
    const before = snapshot(ring, 1);

    const first = ring.keyFor(1)!;
    const second = ring.keyFor(1)!;
    expect(first).not.toBe(second);
    expect(first.buffer).not.toBe(second.buffer);
    first.fill(0);
    second.write("attacker-controlled");
    expect(ring.keyFor(1)?.equals(KEY_A)).toBe(true);
    expect(snapshot(ring, 1)).toBe(before);

    // useKey lends a copy and zeroes it afterwards, even when the work throws.
    let lent: Buffer | null = null;
    expect(
      ring.useKey(1, (key) => {
        lent = key;
        expect(key.equals(KEY_A)).toBe(true);
        key.fill(0x7f);
        return "used";
      }),
    ).toBe("used");
    expect(lent!.equals(Buffer.alloc(32, 0))).toBe(true);
    expect(() =>
      ring.useKey(1, (key) => {
        lent = key;
        throw new Error("work failed");
      }),
    ).toThrow("work failed");
    expect(lent!.equals(Buffer.alloc(32, 0))).toBe(true);
    expect(ring.useKey(9, () => "never")).toBeNull();
    expect(ring.checkValue(9)).toBeNull();
    expect(snapshot(ring, 1)).toBe(before);
    expect(KEY_A.equals(Buffer.alloc(32, 0xa1))).toBe(true);
  });

  it("validates at construction and names only the version in its error", () => {
    const short = Buffer.alloc(31, 0x5a);
    for (const build of [
      () => new KeyRing("session", new Map([[1, short]])),
      () => new KeyRing("session", new Map([[0, KEY_A]])),
      () => new KeyRing("session", new Map([[32768, KEY_A]])),
      () => new KeyRing("session", new Map([[1.5, KEY_A]])),
      () => new KeyRing("session", new Map()),
      () => new KeyRing("payments" as never, new Map([[1, KEY_A]])),
      () => new KeyRing("session", new Map([[1, "not-bytes" as never]])),
    ]) {
      let message = "";
      try {
        build();
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      for (const key of [short, KEY_A]) {
        expect(message).not.toContain(key.toString("base64"));
        expect(message).not.toContain(key.toString("hex"));
      }
    }
  });

  it("loadKeyRings parses both rings and returns them only as a validated pair", () => {
    const rings = loadKeyRings({ sessionKeys: `${entry(1, KEY_A)},${entry(2, KEY_B)}`, nonceKeys: entry(1, KEY_C) });
    if (!rings.ok) throw new Error("expected rings");
    expect(rings.value).toBeInstanceOf(ConfiguredKeyRings);
    expect(rings.value.validated).toBe(true);
    expect(rings.value.session.purpose).toBe("session");
    expect(rings.value.confirmationNonce.purpose).toBe("confirmation_nonce");
    expect(rings.value.session.versions()).toEqual([1, 2]);
    expect(Object.isFrozen(rings.value)).toBe(true);
    const output = `${JSON.stringify(rings.value)} ${inspect(rings.value, { depth: 5 })}`;
    for (const key of [KEY_A, KEY_B, KEY_C]) {
      expect(output).not.toContain(key.toString("base64"));
      expect(output).not.toContain(key.toString("hex"));
    }
  });

  it("fails closed when either ring is missing or malformed, naming the variable", () => {
    expect(loadKeyRings({ sessionKeys: undefined, nonceKeys: entry(1, KEY_C) })).toEqual({
      ok: false,
      error: { code: "RING_MISSING", variable: "SHOPACCESS_SESSION_KEYS", version: null },
    });
    expect(loadKeyRings({ sessionKeys: entry(1, KEY_A), nonceKeys: "" })).toEqual({
      ok: false,
      error: { code: "RING_MISSING", variable: "SHOPACCESS_NONCE_KEYS", version: null },
    });
    expect(loadKeyRings({ sessionKeys: entry(1, KEY_A), nonceKeys: `2:${Buffer.alloc(31, 1).toString("base64")}` })).toEqual({
      ok: false,
      error: { code: "KEY_TOO_SHORT", variable: "SHOPACCESS_NONCE_KEYS", version: 2 },
    });
  });

  it("refuses identical key bytes across the two purposes, under any version numbers", () => {
    const reused = { ok: false, error: { code: "KEY_MATERIAL_SHARED_ACROSS_PURPOSES" } };
    expect(loadKeyRings({ sessionKeys: entry(1, KEY_A), nonceKeys: entry(1, KEY_A) })).toEqual(reused);
    expect(loadKeyRings({ sessionKeys: `${entry(1, KEY_A)},${entry(2, KEY_B)}`, nonceKeys: `${entry(7, KEY_C)},${entry(9, KEY_B)}` })).toEqual(reused);
    // The refusal carries no key material and no version.
    expect(JSON.stringify(loadKeyRings({ sessionKeys: entry(1, KEY_A), nonceKeys: entry(1, KEY_A) }))).not.toContain(KEY_A.toString("base64"));
    // Same length, different bytes: accepted. A prefix of a longer key is not "identical".
    expect(loadKeyRings({ sessionKeys: entry(1, KEY_A), nonceKeys: entry(1, KEY_B) }).ok).toBe(true);
    expect(loadKeyRings({ sessionKeys: entry(1, Buffer.alloc(32, 0xc3)), nonceKeys: entry(1, KEY_C) }).ok).toBe(true);
  });

  it("refuses rings presented under the wrong purpose, and cannot be constructed around the boundary", () => {
    const session = new KeyRing("session", new Map([[1, KEY_A]]));
    const nonce = new KeyRing("confirmation_nonce", new Map([[1, KEY_B]]));
    expect(validateKeyRings(nonce, session)).toEqual({ ok: false, error: { code: "RING_PURPOSE_MISMATCH" } });
    expect(validateKeyRings(session, session)).toEqual({ ok: false, error: { code: "RING_PURPOSE_MISMATCH" } });
    expect(validateKeyRings(session, nonce).ok).toBe(true);
    expect(() => new ConfiguredKeyRings(Symbol("forged"), session, session)).toThrow(TypeError);
  });

  it("a ring's purpose cannot be changed after validation, by any run-time mutation", () => {
    const session = new KeyRing("session", new Map([[1, KEY_A]]));
    const nonce = new KeyRing("confirmation_nonce", new Map([[1, KEY_B]]));
    const rings = validateKeyRings(session, nonce);
    if (!rings.ok) throw new Error("expected rings");
    const sessionCheck = session.checkValue(1);
    const loose = session as unknown as Record<string, unknown>;

    // Assignment, redefinition, deletion and prototype replacement all fail, and change nothing.
    expect(() => {
      loose.purpose = "confirmation_nonce";
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(session, "purpose", { value: "confirmation_nonce" })).toThrow(TypeError);
    expect(() => Object.defineProperty(session, "purpose", { get: () => "confirmation_nonce" })).toThrow(TypeError);
    expect(Reflect.set(session, "purpose", "confirmation_nonce")).toBe(false);
    expect(Reflect.deleteProperty(session, "purpose")).toBe(true); // nothing own to delete: the getter lives on the frozen prototype
    expect(() => Object.setPrototypeOf(session, { purpose: "confirmation_nonce" })).toThrow(TypeError);
    expect(() => Object.assign(session, { purpose: "confirmation_nonce" })).toThrow(TypeError);
    // The accessor itself cannot be swapped on the class.
    expect(() => Object.defineProperty(KeyRing.prototype, "purpose", { get: () => "confirmation_nonce" })).toThrow(TypeError);
    expect(() => {
      (KeyRing.prototype as unknown as Record<string, unknown>).checkValue = () => "forged";
    }).toThrow(TypeError);
    expect(() => {
      (KeyRing as unknown as Record<string, unknown>).purposeOf = () => "session";
    }).toThrow(TypeError);

    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(KeyRing.prototype)).toBe(true);
    expect(Object.getOwnPropertyNames(session)).toEqual([]);
    expect(session.purpose).toBe("session");
    expect(KeyRing.purposeOf(session)).toBe("session");
    expect(JSON.parse(JSON.stringify(session)).purpose).toBe("session");
    // Purpose separation still holds: the check value is still computed for the original purpose.
    expect(session.checkValue(1)).toBe(sessionCheck);
    expect(session.checkValue(1)).toBe(computeKeyCheckValue(KEY_A, "session"));
    expect(session.checkValue(1)).not.toBe(computeKeyCheckValue(KEY_A, "confirmation_nonce"));

    // The validated pair is equally fixed.
    const pair = rings.value as unknown as Record<string, unknown>;
    expect(() => {
      pair.session = nonce;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(rings.value, "confirmationNonce", { value: session })).toThrow(TypeError);
    expect(() => Object.defineProperty(ConfiguredKeyRings.prototype, "validated", { get: () => true })).toThrow(TypeError);
    expect(rings.value.session).toBe(session);
    expect(KeyRing.purposeOf(rings.value.confirmationNonce)).toBe("confirmation_nonce");
  });

  it("a look-alike or subclass cannot present another purpose to validation", () => {
    const nonce = new KeyRing("confirmation_nonce", new Map([[1, KEY_B]]));
    // Subclassing, the one way to override the accessor, is refused at construction.
    class Disguised extends KeyRing {
      get purpose(): "session" {
        return "session";
      }
    }
    expect(() => new Disguised("confirmation_nonce", new Map([[1, KEY_A]]))).toThrow(TypeError);

    // An object that merely answers "session" is not a ring: its private field is what validation reads.
    const proxied = new Proxy(nonce, { get: (target, key) => (key === "purpose" ? "session" : Reflect.get(target, key)) });
    const impostor = Object.create(KeyRing.prototype) as KeyRing;
    const plain = { purpose: "session", sharesKeyMaterialWith: () => false } as unknown as KeyRing;
    for (const fake of [proxied, impostor, plain]) {
      expect(validateKeyRings(fake, nonce)).toEqual({ ok: false, error: { code: "RING_PURPOSE_MISMATCH" } });
      expect(() => KeyRing.purposeOf(fake)).toThrow(TypeError);
    }
    expect(() => resolveKeyState(plain, [])).toThrow(TypeError);
    // A genuine nonce ring offered as the session ring is still refused.
    expect(validateKeyRings(nonce, nonce)).toEqual({ ok: false, error: { code: "RING_PURPOSE_MISMATCH" } });
  });
});
