import { describe, expect, it } from "vitest";
import { isRerunnableDatabaseError, MAX_TRANSACTION_RERUNS, runWithReruns } from "@/lib/pg/client";
import { computeKeyCheckValue, KeyRing, validateKeyRings } from "@/lib/pg/key-ring";
import { parsePgSessionCookieValue, readPgSessionCookie, serializePgSessionCookie } from "@/lib/pg/session-cookie";
import { createPgSessionService } from "@/lib/pg/session-service";
import { SESSION_STATEMENTS } from "@/lib/pg/statements";
import { readSessionCookie, serializeSessionCookie, SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { deriveCsrfToken, digestSessionToken, generateSessionToken } from "@/lib/session/token";
import { createSequentialIdGenerator } from "@/lib/shared/ids";

const token = "A".repeat(43);

describe("PGT-85: the PostgreSQL-mode cookie value is exactly version.token", () => {
  it("parses a valid value", () => {
    expect(parsePgSessionCookieValue(`1.${token}`)).toEqual({ keyVersion: 1, token });
    expect(parsePgSessionCookieValue(`32767.${token}`)).toEqual({ keyVersion: 32767, token });
  });

  it.each([
    ["a Mock-format value with no dot", token],
    ["two dots", `1.2.${token}`],
    ["an empty version", `.${token}`],
    ["an empty token", "1."],
    ["a leading zero", `01.${token}`],
    ["version zero", `0.${token}`],
    ["a plus sign", `+1.${token}`],
    ["a minus sign", `-1.${token}`],
    ["a non-digit version", `v1.${token}`],
    ["a hexadecimal version", `0x1.${token}`],
    ["an exponent", `1e2.${token}`],
    ["whitespace in the version", `1 .${token}`],
    ["whitespace before the token", `1. ${token}`],
    ["a version above 32767", `32768.${token}`],
    ["a six-digit version", `100000.${token}`],
    ["a short token", `1.${"A".repeat(42)}`],
    ["a long token", `1.${"A".repeat(44)}`],
    ["a token with an illegal character", `1.${"A".repeat(42)}*`],
    ["a trailing dot after the token", `1.${token}.`],
    ["an empty value", ""],
  ])("rejects %s", (_name, value) => {
    expect(parsePgSessionCookieValue(value)).toBeNull();
  });

  it("reads the cookie from a header only when it appears exactly once", () => {
    expect(readPgSessionCookie(`a=b; ${SESSION_COOKIE_NAME}=3.${token}; c=d`)).toEqual({ keyVersion: 3, token });
    expect(readPgSessionCookie(`${SESSION_COOKIE_NAME}=3.${token}; ${SESSION_COOKIE_NAME}=4.${token}`)).toBeNull();
    expect(readPgSessionCookie(`${SESSION_COOKIE_NAME}=${token}`)).toBeNull();
    expect(readPgSessionCookie(null)).toBeNull();
    expect(readPgSessionCookie("")).toBeNull();
  });

  it("serializes with the same name and attributes as the Mock cookie, and the Mock format is unchanged", () => {
    const pg = serializePgSessionCookie({ keyVersion: 2, token }, 3600);
    const mock = serializeSessionCookie(token, 3600);
    expect(pg).toBe(mock.replace(`=${token};`, `=2.${token};`));
    // Each mode rejects the other's value.
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=2.${token}`)).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=${token}`)).toBe(token);
    expect(() => serializePgSessionCookie({ keyVersion: 0, token }, 60)).toThrow(TypeError);
    expect(() => serializePgSessionCookie({ keyVersion: 1.5, token }, 60)).toThrow(TypeError);
    expect(() => serializePgSessionCookie({ keyVersion: 1, token: "bad" }, 60)).toThrow(TypeError);
  });
});

describe("database re-runs are bounded and limited to lock failures", () => {
  const failure = (code: string) => Object.assign(new Error("database error"), { code });
  const noSleep = { sleep: async () => undefined, random: () => 0 };

  it("recognizes only deadlock and lock timeout", () => {
    expect(isRerunnableDatabaseError(failure("40P01"))).toBe(true);
    expect(isRerunnableDatabaseError(failure("55P03"))).toBe(true);
    for (const code of ["40001", "23505", "57014", "42501", "08006"]) expect(isRerunnableDatabaseError(failure(code))).toBe(false);
    expect(isRerunnableDatabaseError(new Error("no code"))).toBe(false);
    expect(isRerunnableDatabaseError(null)).toBe(false);
  });

  it("re-runs at most three times, then rethrows", async () => {
    expect(MAX_TRANSACTION_RERUNS).toBe(3);
    let attempts = 0;
    await expect(
      runWithReruns(async () => {
        attempts += 1;
        throw failure("40P01");
      }, noSleep),
    ).rejects.toMatchObject({ code: "40P01" });
    expect(attempts).toBe(4);

    attempts = 0;
    const value = await runWithReruns(async () => {
      attempts += 1;
      if (attempts < 3) throw failure("55P03");
      return "done";
    }, noSleep);
    expect(value).toBe("done");
    expect(attempts).toBe(3);
  });

  it("never re-runs after any other error", async () => {
    let attempts = 0;
    await expect(
      runWithReruns(async () => {
        attempts += 1;
        throw failure("23505");
      }, noSleep),
    ).rejects.toMatchObject({ code: "23505" });
    expect(attempts).toBe(1);
  });
});

describe("PostgreSQL session service against a fake database (no connection)", () => {
  const KEY_1 = Buffer.alloc(32, 0x01);
  const KEY_2 = Buffer.alloc(32, 0x02);
  const KEY_3 = Buffer.alloc(32, 0x03);
  const KEY_NONCE = Buffer.alloc(32, 0x0e);
  // The fake routes on the catalogue's own statement texts: the service can send nothing else.
  const ADMIT = SESSION_STATEMENTS.admitSession;
  const AUTHORIZE = SESSION_STATEMENTS.authorizeSession;
  const ROTATE = SESSION_STATEMENTS.rotateSession;
  const REVOKE = SESSION_STATEMENTS.revokeSession;
  const KEYS = SESSION_STATEMENTS.readKeyVersions;
  const ringsOf = (keys: Array<[number, Buffer]>) => {
    const rings = validateKeyRings(new KeyRing("session", new Map(keys)), new KeyRing("confirmation_nonce", new Map([[1, KEY_NONCE]])));
    if (!rings.ok) throw new Error("expected valid test rings");
    return rings.value;
  };
  const later = new Date("2026-10-09T14:00:00Z");
  const absolute = new Date("2026-10-10T12:00:00Z");
  const now = new Date("2026-10-09T12:00:00Z");

  type Call = { text: string; values: readonly unknown[] };
  function world(options: { keyRows: () => unknown[]; respond: (call: Call) => Record<string, unknown> }) {
    const calls: Call[] = [];
    const db = {
      async query(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });
        if (text === KEYS) return { rows: options.keyRows() };
        return { rows: [options.respond({ text, values })] };
      },
    };
    return { calls, db };
  }
  const keyRow = (version: number, status: string, key: Buffer) => ({
    purpose: "session",
    key_version: version,
    status,
    check_value: computeKeyCheckValue(key, "session"),
  });
  const service = (db: { query: never } | object, keys: Array<[number, Buffer]>) =>
    createPgSessionService({
      db: db as never,
      rings: ringsOf(keys),
      ids: createSequentialIdGenerator(),
      clock: () => now,
      rerun: { sleep: async () => undefined, random: () => 0 },
      keyStateRefreshIntervalMs: 0,
    });

  it("accepts only rings that passed the validation boundary", () => {
    const session = new KeyRing("session", new Map([[1, KEY_1]]));
    const nonce = new KeyRing("confirmation_nonce", new Map([[1, KEY_NONCE]]));
    for (const lookAlike of [
      { session, confirmationNonce: nonce, validated: false },
      { session: nonce, confirmationNonce: session, validated: true },
    ]) {
      expect(() => createPgSessionService({ db: {} as never, rings: lookAlike as never, ids: createSequentialIdGenerator(), clock: () => now })).toThrow(TypeError);
    }
  });

  it("resolves with exactly one authorize call under the cookie's key version, and never another version", async () => {
    const presented = generateSessionToken();
    const { calls, db } = world({
      keyRows: () => [keyRow(1, "VERIFY_ONLY", KEY_1), keyRow(2, "ACTIVE", KEY_2)],
      respond: () => ({ result: "AUTHORIZED", session_id: "ses_" + "a".repeat(32), absolute_expires_at: absolute, idle_expires_at: later, key_status: "VERIFY_ONLY" }),
    });
    const sessions = service(db, [[1, KEY_1], [2, KEY_2]]);
    const resolved = await sessions.resolve({ keyVersion: 1, token: presented });
    if (!resolved.ok) throw new Error("expected a session");
    const digest = digestSessionToken(KEY_1, presented);
    expect(calls.filter((call) => call.text === AUTHORIZE)).toEqual([{ text: AUTHORIZE, values: [1, digest] }]);
    expect(resolved.value).toEqual({
      id: "ses_" + "a".repeat(32),
      csrfToken: deriveCsrfToken(KEY_1, digest),
      idleExpiresAt: later,
      absoluteExpiresAt: absolute,
      keyVersion: 1,
      keyStatus: "VERIFY_ONLY",
    });
    expect(sessions.verifyCsrfToken(resolved.value, resolved.value.csrfToken)).toBe(true);
    expect(sessions.verifyCsrfToken(resolved.value, "wrong")).toBe(false);
    expect(sessions.verifyCsrfToken(resolved.value, null)).toBe(false);
    expect(sessions.cookieMaxAgeSeconds(resolved.value)).toBe(24 * 3600);
    expect("ownerId" in resolved.value).toBe(false);
  });

  it("treats an unconfigured, staged or revoked cookie version as no session, without an authorize call", async () => {
    const { calls, db } = world({
      keyRows: () => [keyRow(1, "REVOKED", KEY_1), keyRow(2, "ACTIVE", KEY_2)],
      respond: () => {
        throw new Error("no entry point should be called");
      },
    });
    const sessions = service(db, [[1, KEY_1], [2, KEY_2], [3, KEY_3]]);
    for (const keyVersion of [9, 3, 1]) {
      expect(await sessions.resolve({ keyVersion, token })).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
    }
    expect(await sessions.resolve(null)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
    expect(calls.every((call) => call.text === KEYS)).toBe(true);
  });

  it("maps a database refusal to one generic rejection", async () => {
    const { db } = world({
      keyRows: () => [keyRow(2, "ACTIVE", KEY_2)],
      respond: () => ({ result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null, key_status: null }),
    });
    expect(await service(db, [[2, KEY_2]]).resolve({ keyVersion: 2, token })).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
  });

  it("admits under the database ACTIVE version, not the highest configured one, and supplies no owner id", async () => {
    const { calls, db } = world({
      keyRows: () => [keyRow(1, "VERIFY_ONLY", KEY_1), keyRow(2, "ACTIVE", KEY_2)],
      respond: () => ({ result: "ADMITTED", absolute_expires_at: absolute, idle_expires_at: later }),
    });
    const issued = await service(db, [[1, KEY_1], [2, KEY_2], [3, KEY_3]]).establish(null);
    if (!issued.ok || !issued.value.issuedCookie) throw new Error("expected an issued session");
    const admit = calls.find((call) => call.text === ADMIT)!;
    expect(admit.values).toHaveLength(3);
    expect(admit.values[0]).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(admit.values[1]).toBe(2);
    expect(admit.values[2]).toBe(digestSessionToken(KEY_2, issued.value.issuedCookie.token));
    expect(issued.value.issuedCookie.keyVersion).toBe(2);
    expect(issued.value.session.id).toBe(admit.values[0]);
    expect(JSON.stringify(admit.values)).not.toContain("own_");
  });

  it.each([
    ["RATE_LIMITED", "RATE_LIMITED"],
    ["AT_CAPACITY", "AT_CAPACITY"],
    ["REFUSED", "REFUSED"],
  ])("reports %s", async (result, expected) => {
    const { db } = world({ keyRows: () => [keyRow(2, "ACTIVE", KEY_2)], respond: () => ({ result, absolute_expires_at: null, idle_expires_at: null }) });
    expect(await service(db, [[2, KEY_2]]).establish(null)).toEqual({ ok: false, error: expected });
  });

  it("fails closed when no usable ACTIVE key exists, without calling admit", async () => {
    for (const keyRows of [
      () => [],
      () => [keyRow(2, "REVOKED", KEY_2)],
      () => [keyRow(2, "ACTIVE", KEY_1)],
      () => [keyRow(5, "ACTIVE", KEY_2)],
    ]) {
      const { calls, db } = world({ keyRows, respond: () => ({ result: "ADMITTED" }) });
      expect(await service(db, [[2, KEY_2]]).establish(null)).toEqual({ ok: false, error: "KEY_UNAVAILABLE" });
      expect(calls.some((call) => call.text === ADMIT)).toBe(false);
    }
  });

  it("re-reads the key state once after KEY_NOT_ACTIVE, then refuses", async () => {
    let active = 2;
    const { calls, db } = world({
      keyRows: () => (active === 2 ? [keyRow(2, "ACTIVE", KEY_2)] : [keyRow(2, "VERIFY_ONLY", KEY_2), keyRow(3, "ACTIVE", KEY_3)]),
      respond: (call) => {
        if (call.values[1] === 2) {
          active = 3;
          return { result: "KEY_NOT_ACTIVE", absolute_expires_at: null, idle_expires_at: null };
        }
        return { result: "ADMITTED", absolute_expires_at: absolute, idle_expires_at: later };
      },
    });
    const issued = await service(db, [[2, KEY_2], [3, KEY_3]]).establish(null);
    expect(issued.ok && issued.value.issuedCookie?.keyVersion).toBe(3);
    expect(calls.filter((call) => call.text === ADMIT)).toHaveLength(2);

    const stuck = world({ keyRows: () => [keyRow(2, "ACTIVE", KEY_2)], respond: () => ({ result: "KEY_NOT_ACTIVE", absolute_expires_at: null, idle_expires_at: null }) });
    expect(await service(stuck.db, [[2, KEY_2]]).establish(null)).toEqual({ ok: false, error: "KEY_UNAVAILABLE" });
    expect(stuck.calls.filter((call) => call.text === ADMIT)).toHaveLength(2);
  });

  it("rotates to the ACTIVE key and revokes by presented cookie", async () => {
    const presented = generateSessionToken();
    const { calls, db } = world({
      keyRows: () => [keyRow(1, "VERIFY_ONLY", KEY_1), keyRow(2, "ACTIVE", KEY_2)],
      respond: (call) =>
        call.text === ROTATE
          ? { result: "ROTATED", session_id: "ses_" + "b".repeat(32), absolute_expires_at: absolute, idle_expires_at: later }
          : call.text === REVOKE
            ? { result: "DONE" }
            : { result: "AUTHORIZED", session_id: "ses_" + "b".repeat(32), absolute_expires_at: absolute, idle_expires_at: later, key_status: "VERIFY_ONLY" },
    });
    const sessions = service(db, [[1, KEY_1], [2, KEY_2]]);
    const cookie = { keyVersion: 1, token: presented };
    const resolved = await sessions.resolve(cookie);
    if (!resolved.ok) throw new Error("expected a session");
    const rotated = await sessions.rotate(resolved.value, cookie);
    if (!rotated.ok || !rotated.value.issuedCookie) throw new Error("expected a rotated session");
    const rotate = calls.find((call) => call.text === ROTATE)!;
    expect(rotate.values).toEqual([1, digestSessionToken(KEY_1, presented), 2, digestSessionToken(KEY_2, rotated.value.issuedCookie.token)]);
    expect(rotated.value.session).toMatchObject({ id: resolved.value.id, keyVersion: 2, keyStatus: "ACTIVE" });

    await sessions.revoke(cookie);
    await sessions.revoke(null);
    await sessions.revoke({ keyVersion: 9, token: presented });
    expect(calls.filter((call) => call.text === REVOKE)).toEqual([{ text: REVOKE, values: [1, digestSessionToken(KEY_1, presented)] }]);
  });

  it("re-runs a call after a lock timeout and never passes key material or raw tokens to the database", async () => {
    let failures = 2;
    const seen: unknown[] = [];
    const db = {
      async query(text: string, values: readonly unknown[] = []) {
        seen.push(...values);
        if (text === KEYS) return { rows: [keyRow(2, "ACTIVE", KEY_2)] };
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("lock timeout"), { code: "55P03" });
        }
        return { rows: [{ result: "ADMITTED", absolute_expires_at: absolute, idle_expires_at: later }] };
      },
    };
    const issued = await service(db, [[2, KEY_2]]).establish(null);
    if (!issued.ok || !issued.value.issuedCookie) throw new Error("expected an issued session");
    const sent = JSON.stringify(seen);
    expect(sent).not.toContain(issued.value.issuedCookie.token);
    expect(sent).not.toContain(KEY_2.toString("hex"));
    expect(sent).not.toContain(KEY_2.toString("base64"));
  });

  describe("rotation identity binding", () => {
    const ID_A = "ses_" + "a".repeat(32);
    const ID_B = "ses_" + "b".repeat(32);
    const tokenA = generateSessionToken();
    const tokenB = generateSessionToken();
    const digestA = digestSessionToken(KEY_2, tokenA);
    const digestB = digestSessionToken(KEY_2, tokenB);
    const cookieA = { keyVersion: 2, token: tokenA };
    const cookieB = { keyVersion: 2, token: tokenB };

    /** A fake database holding two sessions, which answers by token digest as the real functions do. */
    function twoSessions() {
      const byDigest = new Map([[digestA, ID_A], [digestB, ID_B]]);
      return world({
        keyRows: () => [keyRow(1, "VERIFY_ONLY", KEY_1), keyRow(2, "ACTIVE", KEY_2)],
        respond: (call) => {
          if (call.text === AUTHORIZE) {
            const id = byDigest.get(String(call.values[1]));
            return id
              ? { result: "AUTHORIZED", session_id: id, absolute_expires_at: absolute, idle_expires_at: later, key_status: "ACTIVE" }
              : { result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null, key_status: null };
          }
          if (call.text === ROTATE) {
            const id = byDigest.get(String(call.values[1]));
            if (!id) return { result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null };
            byDigest.delete(String(call.values[1]));
            byDigest.set(String(call.values[3]), id);
            return { result: "ROTATED", session_id: id, absolute_expires_at: absolute, idle_expires_at: later };
          }
          throw new Error("unexpected call");
        },
      });
    }
    const rotations = (calls: Call[]) => calls.filter((call) => call.text === ROTATE);

    it("refuses session A paired with session B's cookie, in both directions, without calling the database", async () => {
      const { calls, db } = twoSessions();
      const sessions = service(db, [[1, KEY_1], [2, KEY_2]]);
      const a = await sessions.resolve(cookieA);
      const b = await sessions.resolve(cookieB);
      if (!a.ok || !b.ok) throw new Error("expected two sessions");
      expect([a.value.id, b.value.id]).toEqual([ID_A, ID_B]);

      expect(await sessions.rotate(a.value, cookieB)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
      expect(await sessions.rotate(b.value, cookieA)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
      // Same token under another key version is another credential.
      expect(await sessions.rotate(a.value, { keyVersion: 1, token: tokenA })).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
      expect(rotations(calls)).toEqual([]);

      // Both sessions are untouched and still resolve.
      expect((await sessions.resolve(cookieA)).ok).toBe(true);
      expect((await sessions.resolve(cookieB)).ok).toBe(true);
    });

    it("refuses a session object this service did not return, however plausible", async () => {
      const { calls, db } = twoSessions();
      const sessions = service(db, [[2, KEY_2]]);
      const a = await sessions.resolve(cookieA);
      if (!a.ok) throw new Error("expected a session");
      const copy = { ...a.value };
      const forged = { ...a.value, id: ID_B };
      const fromAnotherInstance = await service(twoSessions().db, [[2, KEY_2]]).resolve(cookieA);
      if (!fromAnotherInstance.ok) throw new Error("expected a session");
      for (const candidate of [copy, forged, fromAnotherInstance.value]) {
        expect(await sessions.rotate(candidate, cookieA)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
      }
      expect(rotations(calls)).toEqual([]);
      // The session object cannot be edited into another identity either.
      expect(Object.isFrozen(a.value)).toBe(true);
    });

    it("returns the session id the database reports, and the old object and cookie rotate nothing afterwards", async () => {
      const { calls, db } = twoSessions();
      const sessions = service(db, [[2, KEY_2]]);
      const a = await sessions.resolve(cookieA);
      if (!a.ok) throw new Error("expected a session");

      const rotated = await sessions.rotate(a.value, cookieA);
      if (!rotated.ok || !rotated.value.issuedCookie) throw new Error("expected a rotation");
      expect(rotated.value.session.id).toBe(ID_A);
      expect(rotations(calls)).toHaveLength(1);
      expect(rotations(calls)[0].values.slice(0, 3)).toEqual([2, digestA, 2]);

      // The id is taken from the database row, not from the object that was passed in.
      const relabelled = world({
        keyRows: () => [keyRow(2, "ACTIVE", KEY_2)],
        respond: (call) =>
          call.text === AUTHORIZE
            ? { result: "AUTHORIZED", session_id: ID_A, absolute_expires_at: absolute, idle_expires_at: later, key_status: "ACTIVE" }
            : { result: "ROTATED", session_id: ID_B, absolute_expires_at: absolute, idle_expires_at: later },
      });
      const other = service(relabelled.db, [[2, KEY_2]]);
      const resolved = await other.resolve(cookieA);
      if (!resolved.ok) throw new Error("expected a session");
      const authoritative = await other.rotate(resolved.value, cookieA);
      expect(authoritative.ok && authoritative.value.session.id).toBe(ID_B);

      // Replay: the consumed object and the old cookie are both refused, with no further database rotation.
      expect(await sessions.rotate(a.value, cookieA)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
      expect(await sessions.rotate(rotated.value.session, cookieA)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
      expect(rotations(calls)).toHaveLength(1);
      // The new object with the new cookie is the valid pair.
      expect((await sessions.rotate(rotated.value.session, rotated.value.issuedCookie)).ok).toBe(true);
    });

    it("rejects a malformed session id from the database rather than passing it on", async () => {
      const bad = world({
        keyRows: () => [keyRow(2, "ACTIVE", KEY_2)],
        respond: (call) =>
          call.text === AUTHORIZE
            ? { result: "AUTHORIZED", session_id: ID_A, absolute_expires_at: absolute, idle_expires_at: later, key_status: "ACTIVE" }
            : { result: "ROTATED", session_id: null, absolute_expires_at: absolute, idle_expires_at: later },
      });
      const sessions = service(bad.db, [[2, KEY_2]]);
      const resolved = await sessions.resolve(cookieA);
      if (!resolved.ok) throw new Error("expected a session");
      await expect(sessions.rotate(resolved.value, cookieA)).rejects.toThrow("invalid session id");
    });
  });
});
