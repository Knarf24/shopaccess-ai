import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryableFromPool } from "@/lib/pg/client";
import { computeKeyCheckValue, KeyRing, loadKeyState, type KeyPurpose } from "@/lib/pg/key-ring";
import { createPgSessionService } from "@/lib/pg/session-service";
import { OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { systemClock } from "@/lib/shared/clock";
import { randomIdGenerator } from "@/lib/shared/ids";
import {
  adminUrl,
  openDisposableDatabase,
  resetAdmissionWindow,
  TEST_KEY_V1,
  TEST_KEY_V2,
  TEST_KEY_V3,
  testKeyRings,
  type DisposableDatabase,
} from "./harness";

// NEVER RUN (Gate B-X not authorized).
describe.skipIf(!adminUrl())("PGT-64, 86 and 89: key versions, staged rotation, emergency revocation, operator audit", () => {
  let db: DisposableDatabase;
  beforeAll(async () => {
    db = await openDisposableDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const activate = async (purpose: KeyPurpose, version: number, key: Buffer) =>
    (await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, [purpose, version, computeKeyCheckValue(key, purpose)])).rows[0];
  const revoke = async (purpose: KeyPurpose, version: number) =>
    (await db.operator.query(OPERATOR_STATEMENTS.revokeKeyVersion, [purpose, version])).rows[0];
  const auditRows = async () =>
    (await db.admin.query("SELECT event_type, actor, detail, session_id, owner_id FROM shopaccess.audit_events ORDER BY id")).rows;
  const ring = (keys: Array<[number, Buffer]>) => new KeyRing("session", new Map(keys));
  const service = (keys: Array<[number, Buffer]>) =>
    createPgSessionService({
      db: queryableFromPool(db.web),
      rings: testKeyRings(keys),
      ids: randomIdGenerator,
      clock: systemClock,
      keyStateRefreshIntervalMs: 0,
    });

  it("refusals write no audit row and change nothing", async () => {
    expect(await activate("session", 1, TEST_KEY_V1)).toEqual({ result: "ACTIVATED", previous_active_version: null });
    const before = await auditRows();
    expect(before).toHaveLength(1);

    const refused = [
      (await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["payments", 2, "a".repeat(64)])).rows[0].result,
      (await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 2, "not-a-check-value"])).rows[0].result,
      (await activate("session", 1, TEST_KEY_V1)).result,
      (await revoke("session", 99)).result,
      (await db.operator.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["payments", 1])).rows[0].result,
    ];
    expect(refused).toEqual(["BAD_PURPOSE", "BAD_CHECK_VALUE", "VERSION_NOT_HIGHER", "UNKNOWN_VERSION", "BAD_PURPOSE"]);
    expect(await auditRows()).toEqual(before);
  });

  it("PGT-89: a successful activation and revocation each write exactly one row, with no credential material", async () => {
    const sessions = service([[1, TEST_KEY_V1]]);
    await resetAdmissionWindow(db.admin);
    const issued = await sessions.establish(null);
    expect(issued.ok).toBe(true);

    expect(await activate("session", 2, TEST_KEY_V2)).toEqual({ result: "ACTIVATED", previous_active_version: 1 });
    expect(await revoke("session", 1)).toEqual({ result: "REVOKED", sessions_revoked: 1, was_active: false });
    expect((await revoke("session", 1)).result).toBe("ALREADY_REVOKED");

    const rows = await auditRows();
    expect(rows.map((row) => row.event_type)).toEqual(["KEY_VERSION_ACTIVATED", "KEY_VERSION_ACTIVATED", "KEY_VERSION_REVOKED"]);
    for (const row of rows) {
      expect(row.actor).toBe("operator");
      expect(row.session_id).toBeNull();
      expect(row.owner_id).toBeNull();
      expect(row.detail.operatorLogin).toBe(db.operatorLogin);
      const text = JSON.stringify(row.detail);
      for (const key of [TEST_KEY_V1, TEST_KEY_V2]) {
        expect(text).not.toContain(key.toString("hex"));
        expect(text).not.toContain(key.toString("base64"));
        expect(text).not.toContain(computeKeyCheckValue(key, "session"));
      }
    }
    expect(rows[2].detail).toMatchObject({ purpose: "session", keyVersion: 1, wasActive: false, sessionsRevoked: 1 });

    // A rolled-back operator transaction leaves no audit row.
    const client = await db.operator.connect();
    try {
      await client.query("BEGIN");
      await client.query(OPERATOR_STATEMENTS.activateKeyVersion, ["confirmation_nonce", 1, computeKeyCheckValue(TEST_KEY_V3, "confirmation_nonce")]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await auditRows()).toHaveLength(3);
  });

  it("PGT-86: a staged key is unused, and the database ACTIVE version decides admission", async () => {
    // Version 3 is configured but has no row: staged. Version 2 is ACTIVE.
    const state = await loadKeyState(queryableFromPool(db.web), ring([[2, TEST_KEY_V2], [3, TEST_KEY_V3]]));
    expect(state.ok && { active: state.value.activeVersion, staged: state.value.staged }).toEqual({ active: 2, staged: [3] });

    const sessions = service([[2, TEST_KEY_V2], [3, TEST_KEY_V3]]);
    await resetAdmissionWindow(db.admin);
    const issued = await sessions.establish(null);
    expect(issued.ok && issued.value.issuedCookie?.keyVersion).toBe(2);

    // A cookie naming the staged version is refused; no other version is tried.
    if (!issued.ok || !issued.value.issuedCookie) throw new Error("expected a cookie");
    expect(await sessions.resolve({ keyVersion: 3, token: issued.value.issuedCookie.token })).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
    // A cookie naming the revoked version 1 is refused.
    expect(await service([[1, TEST_KEY_V1], [2, TEST_KEY_V2]]).resolve({ keyVersion: 1, token: issued.value.issuedCookie.token })).toEqual({
      ok: false,
      error: "NOT_AUTHORIZED",
    });
  });

  it("PGT-86: a missing ACTIVE key or a mismatched check value fails closed", async () => {
    const missing = await loadKeyState(queryableFromPool(db.web), ring([[3, TEST_KEY_V3]]));
    expect(missing).toEqual({ ok: false, error: { code: "ACTIVE_KEY_NOT_CONFIGURED", purpose: "session", version: 2 } });
    const mismatched = await loadKeyState(queryableFromPool(db.web), ring([[2, TEST_KEY_V3]]));
    expect(mismatched).toEqual({ ok: false, error: { code: "CHECK_VALUE_MISMATCH", purpose: "session", version: 2 } });
    await resetAdmissionWindow(db.admin);
    expect(await service([[3, TEST_KEY_V3]]).establish(null)).toEqual({ ok: false, error: "KEY_UNAVAILABLE" });
  });

  it("PGT-64 and 86: a verification-only session rotates to the ACTIVE key; emergency revocation stops admission until a replacement is activated", async () => {
    const sessions = service([[2, TEST_KEY_V2], [3, TEST_KEY_V3]]);
    await resetAdmissionWindow(db.admin);
    const issued = await sessions.establish(null);
    if (!issued.ok || !issued.value.issuedCookie) throw new Error("expected a cookie");
    const cookie = issued.value.issuedCookie;

    expect((await activate("session", 3, TEST_KEY_V3)).result).toBe("ACTIVATED");
    const resolved = await sessions.resolve(cookie);
    expect(resolved.ok && resolved.value.keyStatus).toBe("VERIFY_ONLY");
    if (!resolved.ok) throw new Error("expected a session");
    const rotated = await sessions.rotate(resolved.value, cookie);
    expect(rotated.ok && rotated.value.issuedCookie?.keyVersion).toBe(3);
    expect(await sessions.resolve(cookie)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });

    // Emergency revocation of the ACTIVE version.
    expect(await revoke("session", 3)).toMatchObject({ result: "REVOKED", was_active: true });
    if (!rotated.ok || !rotated.value.issuedCookie) throw new Error("expected a rotated cookie");
    expect(await sessions.resolve(rotated.value.issuedCookie)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
    await resetAdmissionWindow(db.admin);
    expect(await sessions.establish(null)).toEqual({ ok: false, error: "KEY_UNAVAILABLE" });
    const direct = await db.web.query(SESSION_STATEMENTS.admitSession, [`ses_${"a".repeat(32)}`, 3, "b".repeat(64)]);
    expect(direct.rows[0].result).toBe("KEY_NOT_ACTIVE");

    // A lower or equal version can never be activated; a higher one restores admission.
    expect((await activate("session", 3, TEST_KEY_V3)).result).toBe("VERSION_NOT_HIGHER");
    const replacement = Buffer.alloc(32, 0x44);
    // Not the nonce test key: identical bytes in both rings would be refused.
    expect((await activate("session", 4, replacement)).result).toBe("ACTIVATED");
    await resetAdmissionWindow(db.admin);
    const restored = await service([[4, replacement]]).establish(null);
    expect(restored.ok && restored.value.issuedCookie?.keyVersion).toBe(4);
  });

  it("no key material is stored in the database", async () => {
    const dump = await db.admin.query("SELECT row_to_json(k)::text AS row FROM shopaccess.server_key_versions k");
    for (const { row } of dump.rows) {
      for (const key of [TEST_KEY_V1, TEST_KEY_V2, TEST_KEY_V3]) {
        expect(row).not.toContain(key.toString("hex"));
        expect(row).not.toContain(key.toString("base64"));
      }
    }
  });
});
