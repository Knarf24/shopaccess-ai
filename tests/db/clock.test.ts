import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import {
  adminUrl,
  hex,
  insertBackdatedSession,
  INSUFFICIENT_PRIVILEGE,
  openDisposableDatabase,
  sqlState,
  TEST_KEY_V1,
  type DisposableDatabase,
} from "./harness";

const LIVE = "SELECT shopaccess_api.session_is_live($1::timestamptz, $2::timestamptz, $3::timestamptz, $4, $5::timestamptz) AS live";

// NEVER RUN (Gate B-X not authorized).
describe.skipIf(!adminUrl())("PGT-90: the test clock is test-only and production time cannot be overridden", () => {
  let db: DisposableDatabase;
  beforeAll(async () => {
    db = await openDisposableDatabase();
    await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 1, computeKeyCheckValue(TEST_KEY_V1, "session")]);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("no entry point has a time parameter", async () => {
    const { rows } = await db.admin.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments, p.prosecdef
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'shopaccess_api'`,
    );
    for (const row of rows.filter((candidate) => candidate.prosecdef === true)) {
      expect(String(row.arguments), row.proname).not.toMatch(/time|date|interval/i);
    }
  });

  it("the liveness helper decides exact boundaries from an explicit time, and only the test owner may call it", async () => {
    const live = async (revoked: string | null, absolute: string, lastSeen: string, status: string | null, t: string) =>
      (await db.admin.query(LIVE, [revoked, absolute, lastSeen, status, t])).rows[0].live as boolean;
    const lastSeen = "2026-01-01T00:00:00Z";
    const absolute = "2026-01-01T10:00:00Z";

    // Idle boundary: two hours after last_seen_at.
    expect(await live(null, absolute, lastSeen, "ACTIVE", "2026-01-01T01:59:59.999999Z")).toBe(true);
    expect(await live(null, absolute, lastSeen, "ACTIVE", "2026-01-01T02:00:00Z")).toBe(false);
    expect(await live(null, absolute, lastSeen, "ACTIVE", "2026-01-01T02:00:00.000001Z")).toBe(false);
    // Absolute boundary.
    const seenLate = "2026-01-01T09:30:00Z";
    expect(await live(null, absolute, seenLate, "VERIFY_ONLY", "2026-01-01T09:59:59.999999Z")).toBe(true);
    expect(await live(null, absolute, seenLate, "VERIFY_ONLY", "2026-01-01T10:00:00Z")).toBe(false);
    // Revoked, revoked key, missing key row.
    expect(await live("2026-01-01T00:30:00Z", absolute, lastSeen, "ACTIVE", "2026-01-01T01:00:00Z")).toBe(false);
    expect(await live(null, absolute, lastSeen, "REVOKED", "2026-01-01T01:00:00Z")).toBe(false);
    expect(await live(null, absolute, lastSeen, null, "2026-01-01T01:00:00Z")).toBe(false);

    for (const pool of [db.web, db.operator]) {
      expect(await sqlState(() => pool.query(LIVE, [null, absolute, lastSeen, "ACTIVE", lastSeen]))).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("a caller's session settings do not change the decision time", async () => {
    const idle = await insertBackdatedSession(db.admin, 1, "3 hours", "2 hours 1 second");
    const client = await db.connectWeb();
    try {
      // Settings a caller might try in order to look earlier in time.
      await client.query("SET TIME ZONE 'Pacific/Kiritimati'");
      await client.query("SET datestyle = 'ISO, DMY'");
      await client.query("BEGIN");
      const { rows } = await client.query(SESSION_STATEMENTS.authorizeSession, [1, idle.tokenDigest]);
      expect(rows[0].result).toBe("NOT_AUTHORIZED");
      await client.query("ROLLBACK");
      // A custom setting has no authority either, and unknown time settings cannot be created.
      await client.query("SELECT set_config('shopaccess.now', '2000-01-01T00:00:00Z', false)");
      expect((await client.query(SESSION_STATEMENTS.authorizeSession, [1, idle.tokenDigest])).rows[0].result).toBe("NOT_AUTHORIZED");
      expect((await client.query(SESSION_STATEMENTS.authorizeSession, [1, hex(32)])).rows[0].result).toBe("NOT_AUTHORIZED");
    } finally {
      await client.end();
    }
  });

  it("existing rows cannot be backdated: created_at is immutable", async () => {
    const session = await insertBackdatedSession(db.admin, 1, "1 hour", "1 minute");
    expect(
      await sqlState(() =>
        db.admin.query(
          "UPDATE shopaccess.shopper_sessions SET created_at = created_at - interval '1 day', row_version = row_version + 1 WHERE id = $1",
          [session.id],
        ),
      ),
    ).not.toBeNull();
  });
});
