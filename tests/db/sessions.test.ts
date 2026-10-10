import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queryableFromPool } from "@/lib/pg/client";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { createPgSessionService, type PgSessionService } from "@/lib/pg/session-service";
import { OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { digestSessionToken, generateSessionToken } from "@/lib/session/token";
import { systemClock } from "@/lib/shared/clock";
import { randomIdGenerator } from "@/lib/shared/ids";
import {
  adminUrl,
  backendPid,
  hex,
  insertBackdatedSession,
  LOCK_NOT_AVAILABLE,
  openDisposableDatabase,
  resetAdmissionWindow,
  RESTRICT_VIOLATION,
  sqlState,
  TEST_KEY_V1,
  testKeyRings,
  waitForDatabaseClock,
  waitUntilBlocked,
  type DisposableDatabase,
} from "./harness";

// NEVER RUN (Gate B-X not authorized).
describe.skipIf(!adminUrl())("Increment 1 session lifecycle on a disposable PostgreSQL 17 database", () => {
  let db: DisposableDatabase;
  let sessions: PgSessionService;

  const admit = async (sessionId = `ses_${hex(16)}`, digest = hex(32)) =>
    (await db.web.query(SESSION_STATEMENTS.admitSession, [sessionId, 1, digest])).rows[0].result as string;
  const authorize = async (digest: string) => (await db.web.query(SESSION_STATEMENTS.authorizeSession, [1, digest])).rows[0];
  const sessionRow = async (id: string) =>
    (await db.admin.query("SELECT row_version, last_seen_at, revoked_at, token_digest FROM shopaccess.shopper_sessions WHERE id = $1", [id])).rows[0];
  const count = async (table: string) => Number((await db.admin.query(`SELECT count(*) AS n FROM shopaccess.${table}`)).rows[0].n);
  const budget = async () =>
    Number((await db.admin.query("SELECT window_admissions FROM shopaccess.session_admission_guard WHERE id = 1")).rows[0].window_admissions);
  const clearSessions = async () => {
    await db.admin.query("DELETE FROM shopaccess.shopper_sessions");
    await resetAdmissionWindow(db.admin);
  };

  beforeAll(async () => {
    db = await openDisposableDatabase();
    await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 1, computeKeyCheckValue(TEST_KEY_V1, "session")]);
    sessions = createPgSessionService({
      db: queryableFromPool(db.web),
      rings: testKeyRings([[1, TEST_KEY_V1]]),
      ids: randomIdGenerator,
      clock: systemClock,
    });
  });
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    await clearSessions();
  });

  it("PGT-02: 80 parallel admissions into an empty table admit exactly 30", async () => {
    const results = await Promise.all(Array.from({ length: 80 }, () => admit()));
    expect(results.filter((result) => result === "ADMITTED")).toHaveLength(30);
    expect(results.filter((result) => result === "RATE_LIMITED")).toHaveLength(50);
    expect(await count("shopper_sessions")).toBe(30);
    expect(await budget()).toBe(30);
  });

  it("PGT-01 and PGT-03: with one slot left, 50 parallel admissions create exactly one session; capacity refusals consume budget, rate refusals do not", async () => {
    await db.admin.query(
      `INSERT INTO shopaccess.checkout_owners (id, created_at)
       SELECT 'own_' || lpad(to_hex(g), 32, '0'), clock_timestamp() FROM generate_series(1, 499) g`,
    );
    await db.admin.query(
      `INSERT INTO shopaccess.shopper_sessions (id, owner_id, key_version, token_digest, created_at, last_seen_at, absolute_expires_at)
       SELECT 'ses_' || lpad(to_hex(g), 32, '0'), 'own_' || lpad(to_hex(g), 32, '0'), 1, lpad(to_hex(g), 64, '0'), t.now, t.now, t.now + interval '24 hours'
         FROM generate_series(1, 499) g, (SELECT clock_timestamp() AS now) t`,
    );
    await resetAdmissionWindow(db.admin);

    const results = await Promise.all(Array.from({ length: 50 }, () => admit()));
    expect(results.filter((result) => result === "ADMITTED")).toHaveLength(1);
    expect(results.filter((result) => result === "AT_CAPACITY")).toHaveLength(29);
    expect(results.filter((result) => result === "RATE_LIMITED")).toHaveLength(20);
    expect(await count("shopper_sessions")).toBe(500);
    // 1 admission + 29 capacity refusals consumed the budget; the 20 rate refusals did not.
    expect(await budget()).toBe(30);
  });

  it("PGT-05: an admission whose transaction is rolled back leaves no session, no owner and no budget change", async () => {
    const owners = await count("checkout_owners");
    const client = await db.connectWeb();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(SESSION_STATEMENTS.admitSession, [`ses_${hex(16)}`, 1, hex(32)]);
      expect(rows[0].result).toBe("ADMITTED");
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
    expect(await count("shopper_sessions")).toBe(0);
    expect(await count("checkout_owners")).toBe(owners);
    expect(await budget()).toBe(0);
  });

  it("refuses malformed arguments and a colliding identifier, and never returns an owner id", async () => {
    expect(await admit("not-a-session-id")).toBe("REFUSED");
    expect(await admit(`ses_${hex(16)}`, "short")).toBe("REFUSED");
    const id = `ses_${hex(16)}`;
    expect(await admit(id)).toBe("ADMITTED");
    const owners = await count("checkout_owners");
    expect(await admit(id)).toBe("REFUSED");
    expect(await count("checkout_owners")).toBe(owners);
    const { rows } = await db.web.query(SESSION_STATEMENTS.admitSession, [`ses_${hex(16)}`, 1, hex(32)]);
    expect(Object.keys(rows[0]).sort()).toEqual(["absolute_expires_at", "idle_expires_at", "result"]);
    const owner = await db.admin.query("SELECT id FROM shopaccess.checkout_owners LIMIT 1");
    expect(owner.rows[0].id).toMatch(/^own_[0-9a-f]{32}$/);
  });

  it("PGT-06 and PGT-87: row_version follows every accepted update and nothing else", async () => {
    const issued = await sessions.establish(null);
    if (!issued.ok || !issued.value.issuedCookie) throw new Error("expected a cookie");
    const { session, issuedCookie: cookie } = issued.value;
    expect((await sessionRow(session.id)).row_version).toBe(1);

    // Read-only authorization inside the touch threshold writes nothing.
    expect((await sessions.resolve(cookie)).ok).toBe(true);
    expect((await sessionRow(session.id)).row_version).toBe(1);

    // A session last seen two minutes ago is touched: last_seen_at moves and the version rises by one.
    const old = await insertBackdatedSession(db.admin, 1, "10 minutes", "2 minutes");
    const touched = await authorize(old.tokenDigest);
    expect(touched.result).toBe("AUTHORIZED");
    expect((await sessionRow(old.id)).row_version).toBe(2);
    expect((await authorize(old.tokenDigest)).result).toBe("AUTHORIZED");
    expect((await sessionRow(old.id)).row_version).toBe(2);

    // Rotation: plus one. The old cookie stops working, and the id comes back from the database.
    const rotated = await sessions.rotate(session, cookie);
    expect(rotated.ok && rotated.value.session.id).toBe(session.id);
    expect((await sessionRow(session.id)).row_version).toBe(2);
    expect(await sessions.resolve(cookie)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });

    // Revocation of a live session: plus one. A repeat is a no-op.
    if (!rotated.ok || !rotated.value.issuedCookie) throw new Error("expected a rotated cookie");
    await sessions.revoke(rotated.value.issuedCookie);
    expect((await sessionRow(session.id)).row_version).toBe(3);
    await sessions.revoke(rotated.value.issuedCookie);
    expect((await sessionRow(session.id)).row_version).toBe(3);
    expect(await sessions.resolve(rotated.value.issuedCookie)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });

    // Direct updates that leave the version unchanged, or skip one, are rejected even for the table owner.
    for (const statement of [
      "UPDATE shopaccess.shopper_sessions SET last_seen_at = last_seen_at + interval '1 second' WHERE id = $1",
      "UPDATE shopaccess.shopper_sessions SET last_seen_at = last_seen_at + interval '1 second', row_version = row_version + 2 WHERE id = $1",
    ]) {
      expect(await sqlState(() => db.admin.query(statement, [old.id])), statement).toBe(RESTRICT_VIOLATION);
    }
  });

  it("PGT-06 and 69d: revoked, idle-expired and absolutely expired sessions are never authorized, and refusal writes nothing", async () => {
    const idle = await insertBackdatedSession(db.admin, 1, "3 hours", "2 hours 1 second");
    const expired = await insertBackdatedSession(db.admin, 1, "24 hours 1 second", "1 minute");
    const fresh = await insertBackdatedSession(db.admin, 1, "23 hours 59 minutes", "1 minute 30 seconds");
    for (const session of [idle, expired]) {
      expect((await authorize(session.tokenDigest)).result).toBe("NOT_AUTHORIZED");
      expect((await sessionRow(session.id)).row_version).toBe(1);
    }
    expect((await authorize(fresh.tokenDigest)).result).toBe("AUTHORIZED");
    expect((await authorize(hex(32))).result).toBe("NOT_AUTHORIZED");
    const refused = await authorize(idle.tokenDigest);
    expect(refused).toEqual({ result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null, key_status: null });
  });

  it("PGT-54e: direct updates that would extend or resurrect a session are rejected", async () => {
    const session = await insertBackdatedSession(db.admin, 1, "1 hour", "1 minute");
    const rejected = [
      "UPDATE shopaccess.shopper_sessions SET last_seen_at = last_seen_at + interval '2 hours', row_version = row_version + 1 WHERE id = $1",
      "UPDATE shopaccess.shopper_sessions SET absolute_expires_at = absolute_expires_at + interval '1 hour', row_version = row_version + 1 WHERE id = $1",
      "UPDATE shopaccess.shopper_sessions SET owner_id = owner_id || '', created_at = created_at - interval '1 second', row_version = row_version + 1 WHERE id = $1",
    ];
    for (const statement of rejected) expect(await sqlState(() => db.admin.query(statement, [session.id])), statement).not.toBeNull();
    await db.admin.query("UPDATE shopaccess.shopper_sessions SET revoked_at = clock_timestamp(), row_version = row_version + 1 WHERE id = $1", [session.id]);
    expect(
      await sqlState(() =>
        db.admin.query("UPDATE shopaccess.shopper_sessions SET revoked_at = NULL, row_version = row_version + 1 WHERE id = $1", [session.id]),
      ),
    ).toBe(RESTRICT_VIOLATION);
  });

  it("PGT-07: a revocation waits for a transaction holding the session, then applies", async () => {
    const token = generateSessionToken();
    const digest = digestSessionToken(TEST_KEY_V1, token);
    const id = `ses_${hex(16)}`;
    expect(await admit(id, digest)).toBe("ADMITTED");

    const holder = await db.connectWeb();
    const revoker = await db.connectWeb();
    try {
      await holder.query("BEGIN");
      expect((await holder.query(SESSION_STATEMENTS.authorizeSession, [1, digest])).rows[0].result).toBe("AUTHORIZED");
      const pid = await backendPid(revoker);
      const pending = revoker.query(SESSION_STATEMENTS.revokeSession, [1, digest]);
      await waitUntilBlocked(db.admin, pid);
      expect((await sessionRow(id)).revoked_at).toBeNull();
      await holder.query("COMMIT");
      expect((await pending).rows[0].result).toBe("DONE");
      expect((await sessionRow(id)).revoked_at).not.toBeNull();
    } finally {
      await holder.end();
      await revoker.end();
    }
  });

  it("PGT-49: a lock wait longer than the approved lock timeout fails as a lock timeout, never as a decision", async () => {
    const digest = hex(32);
    const id = `ses_${hex(16)}`;
    expect(await admit(id, digest)).toBe("ADMITTED");
    const holder = await db.connectWeb();
    const waiter = await db.connectWeb();
    try {
      await holder.query("BEGIN");
      await holder.query(SESSION_STATEMENTS.authorizeSession, [1, digest]);
      expect(await sqlState(() => waiter.query(SESSION_STATEMENTS.revokeSession, [1, digest]))).toBe(LOCK_NOT_AVAILABLE);
      await holder.query("ROLLBACK");
      expect((await sessionRow(id)).revoked_at).toBeNull();
    } finally {
      await holder.end();
      await waiter.end();
    }
  });

  it("PGT-54f: an admission that waited on the guard decides with its own time, after the wait", async () => {
    // The window is about to end. One admission holds the guard; a second waits behind it and must see the new window.
    await db.admin.query(
      "UPDATE shopaccess.session_admission_guard SET window_started_at = clock_timestamp() - interval '59 seconds', window_admissions = 30 WHERE id = 1",
    );
    const holder = await db.connectWeb();
    const waiter = await db.connectWeb();
    try {
      await holder.query("SET lock_timeout = 0");
      await waiter.query("SET lock_timeout = 0");
      await waiter.query("SET statement_timeout = 0");
      await holder.query("BEGIN");
      await holder.query(SESSION_STATEMENTS.admitSession, [`ses_${hex(16)}`, 1, hex(32)]);
      const pid = await backendPid(waiter);
      const pending = waiter.query(SESSION_STATEMENTS.admitSession, [`ses_${hex(16)}`, 1, hex(32)]);
      await waitUntilBlocked(db.admin, pid);
      // Hold until the database clock has passed the end of the window, then release.
      await db.admin.query(
        "SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ((SELECT window_started_at FROM shopaccess.session_admission_guard WHERE id = 1) + interval '1 minute' - clock_timestamp()))) + 0.05)",
      );
      await holder.query("ROLLBACK");
      expect((await pending).rows[0].result).toBe("ADMITTED");
    } finally {
      await holder.end();
      await waiter.end();
    }
  });

  it("PGT-56: with the guard row missing, admission is refused and the row is not recreated", async () => {
    // The guard row cannot be deleted through SQL, so the missing-row case is produced with the trigger disabled, as superuser.
    await db.admin.query("ALTER TABLE shopaccess.session_admission_guard DISABLE TRIGGER session_admission_guard_no_delete");
    await db.admin.query("BEGIN");
    try {
      await db.admin.query("DELETE FROM shopaccess.session_admission_guard");
      const refused = await db.admin.query(SESSION_STATEMENTS.admitSession, [`ses_${hex(16)}`, 1, hex(32)]);
      expect(refused.rows[0].result).toBe("REFUSED");
      expect(await count("session_admission_guard")).toBe(0);
    } finally {
      await db.admin.query("ROLLBACK");
      await db.admin.query("ALTER TABLE shopaccess.session_admission_guard ENABLE TRIGGER session_admission_guard_no_delete");
    }
    expect(await count("session_admission_guard")).toBe(1);
  });

  it("cleanup inside admission removes dead sessions and keeps their owners and every audit row", async () => {
    const dead = await insertBackdatedSession(db.admin, 1, "5 hours", "3 hours");
    const owners = await count("checkout_owners");
    const audit = await count("audit_events");
    expect(await admit()).toBe("ADMITTED");
    expect(await sessionRow(dead.id)).toBeUndefined();
    expect(await count("checkout_owners")).toBe(owners + 1);
    expect(await count("audit_events")).toBe(audit);
  });

  // -------------------------------------------------------------------------
  // Added by the Gate B-W targeted corrections. NEVER RUN.
  // -------------------------------------------------------------------------

  /** Fills the table to `count` live sessions directly, as the test owner. Owner rows outlive a test, hence ON CONFLICT. */
  const fillLiveSessions = async (count: number) => {
    await db.admin.query(
      `INSERT INTO shopaccess.checkout_owners (id, created_at)
       SELECT 'own_' || lpad(to_hex(g), 32, '0'), clock_timestamp() FROM generate_series(1, $1::integer) g
       ON CONFLICT (id) DO NOTHING`,
      [count],
    );
    await db.admin.query(
      `INSERT INTO shopaccess.shopper_sessions (id, owner_id, key_version, token_digest, created_at, last_seen_at, absolute_expires_at)
       SELECT 'ses_' || lpad(to_hex(g), 32, '0'), 'own_' || lpad(to_hex(g), 32, '0'), 1, lpad(to_hex(g), 64, '0'), t.now, t.now, t.now + interval '24 hours'
         FROM generate_series(1, $1::integer) g, (SELECT clock_timestamp() AS now) t`,
      [count],
    );
  };
  const idleExpiry = async (id: string) =>
    (await db.admin.query("SELECT last_seen_at + interval '2 hours' AS at FROM shopaccess.shopper_sessions WHERE id = $1", [id])).rows[0].at as Date;
  const beforeInstant = async (instant: Date) =>
    (await db.admin.query("SELECT clock_timestamp() < $1::timestamptz AS before", [instant.toISOString()])).rows[0].before as boolean;
  /** Sessions that are live right now, by the same helper the entry points use. */
  const liveCount = async () =>
    Number(
      (
        await db.admin.query(
          `SELECT count(*) AS n FROM shopaccess.shopper_sessions s
            WHERE shopaccess_api.session_is_live(s.revoked_at, s.absolute_expires_at, s.last_seen_at,
                    (SELECT k.status FROM shopaccess.server_key_versions k WHERE k.purpose = s.key_purpose AND k.key_version = s.key_version),
                    clock_timestamp())`,
        )
      ).rows[0].n,
    );
  const withoutTimeouts = async (client: Awaited<ReturnType<DisposableDatabase["connectWeb"]>>) => {
    await client.query("SET lock_timeout = 0");
    await client.query("SET statement_timeout = 0");
    await client.query("SET idle_in_transaction_session_timeout = 0");
  };

  it("capacity/touch race: a locked, apparently expired session that a touch is about to refresh still occupies its slot", async () => {
    // 499 live sessions and one that is seconds from its idle expiry: 500 rows.
    await fillLiveSessions(499);
    const edge = await insertBackdatedSession(db.admin, 1, "3 hours", "1 hour 59 minutes 52 seconds");
    const expiry = await idleExpiry(edge.id);
    await resetAdmissionWindow(db.admin);

    const toucher = await db.connectWeb();
    try {
      await withoutTimeouts(toucher);
      // The touch is decided while the session is still live, and is left uncommitted: the row is locked.
      await toucher.query("BEGIN");
      expect((await toucher.query(SESSION_STATEMENTS.authorizeSession, [1, edge.tokenDigest])).rows[0].result).toBe("AUTHORIZED");
      // If this fails the machine was too slow for the fixture; the interleaving below would not be the one under test.
      expect(await beforeInstant(expiry), "the touch must be decided before the idle expiry").toBe(true);

      // Now the database clock passes the OLD idle expiry. To every other transaction the row looks expired.
      await waitForDatabaseClock(db.admin, expiry);

      // The admission cannot lock the row, so it may not treat it as expired: 500 rows are occupied.
      expect(await admit()).toBe("AT_CAPACITY");
      expect(await count("shopper_sessions")).toBe(500);

      await toucher.query("COMMIT");
    } finally {
      await toucher.end();
    }

    // The touch committed: the session is live again, and the limit was never exceeded.
    expect((await sessionRow(edge.id)).row_version).toBe(2);
    expect(await liveCount()).toBe(500);
    expect(await count("shopper_sessions")).toBe(500);
    await resetAdmissionWindow(db.admin);
    expect(await admit()).toBe("AT_CAPACITY");
  });

  it("capacity/touch race, other outcome: when the touch rolls back, the next admission removes the dead session and is admitted", async () => {
    await fillLiveSessions(499);
    const edge = await insertBackdatedSession(db.admin, 1, "3 hours", "1 hour 59 minutes 52 seconds");
    const expiry = await idleExpiry(edge.id);
    await resetAdmissionWindow(db.admin);

    const toucher = await db.connectWeb();
    try {
      await withoutTimeouts(toucher);
      await toucher.query("BEGIN");
      expect((await toucher.query(SESSION_STATEMENTS.authorizeSession, [1, edge.tokenDigest])).rows[0].result).toBe("AUTHORIZED");
      expect(await beforeInstant(expiry), "the touch must be decided before the idle expiry").toBe(true);
      await waitForDatabaseClock(db.admin, expiry);
      expect(await admit()).toBe("AT_CAPACITY");
      await toucher.query("ROLLBACK");
    } finally {
      await toucher.end();
    }

    expect(await liveCount()).toBe(499);
    expect(await admit()).toBe("ADMITTED");
    expect(await sessionRow(edge.id)).toBeUndefined();
    expect(await count("shopper_sessions")).toBe(500);
    expect(await liveCount()).toBe(500);
  });

  it("PGT-54a: a touch that waits on a lock across the idle-expiry boundary is refused and writes nothing", async () => {
    const edge = await insertBackdatedSession(db.admin, 1, "3 hours", "1 hour 59 minutes 52 seconds");
    const expiry = await idleExpiry(edge.id);
    const before = await sessionRow(edge.id);

    const waiter = await db.connectWeb();
    try {
      await withoutTimeouts(waiter);
      // The test owner holds the row, changing nothing.
      await db.admin.query("BEGIN");
      await db.admin.query("SELECT 1 FROM shopaccess.shopper_sessions WHERE id = $1 FOR UPDATE", [edge.id]);

      const pid = await backendPid(waiter);
      const pending = waiter.query(SESSION_STATEMENTS.authorizeSession, [1, edge.tokenDigest]);
      // db.admin polls from inside its own transaction; polling takes no lock on the session.
      await waitUntilBlocked(db.admin, pid);
      // The request was made, and was waiting, while the session was still live.
      expect(await beforeInstant(expiry), "the touch must be waiting before the idle expiry").toBe(true);
      await waitForDatabaseClock(db.admin, expiry);
      await db.admin.query("COMMIT");

      // Its decision time is read after the lock wait, so the session is expired by then.
      expect((await pending).rows[0]).toEqual({ result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null, key_status: null });
    } finally {
      await db.admin.query("ROLLBACK").catch(() => undefined);
      await waiter.end();
    }

    const after = await sessionRow(edge.id);
    expect(after.row_version).toBe(1);
    expect(after.last_seen_at).toEqual(before.last_seen_at);
  });

  it("rotation identity: session A cannot be rotated with session B's cookie, and the rotated id is the database's", async () => {
    const a = await sessions.establish(null);
    const b = await sessions.establish(null);
    if (!a.ok || !b.ok || !a.value.issuedCookie || !b.value.issuedCookie) throw new Error("expected two sessions");
    const versions = async () => [(await sessionRow(a.value.session.id)).row_version, (await sessionRow(b.value.session.id)).row_version];
    const digests = async () => [(await sessionRow(a.value.session.id)).token_digest, (await sessionRow(b.value.session.id)).token_digest];
    const before = await digests();

    // A's session object with B's cookie, and the reverse: refused, and neither row changes.
    expect(await sessions.rotate(a.value.session, b.value.issuedCookie)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
    expect(await sessions.rotate(b.value.session, a.value.issuedCookie)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
    // A look-alike object that this service never returned: refused.
    expect(await sessions.rotate({ ...a.value.session }, a.value.issuedCookie)).toEqual({ ok: false, error: "NOT_AUTHORIZED" });
    expect(await versions()).toEqual([1, 1]);
    expect(await digests()).toEqual(before);

    // The matching pair rotates A only, and reports A's id as stored.
    const rotated = await sessions.rotate(a.value.session, a.value.issuedCookie);
    if (!rotated.ok) throw new Error("expected a rotation");
    expect(rotated.value.session.id).toBe(a.value.session.id);
    expect(await versions()).toEqual([2, 1]);
    expect((await sessions.resolve(b.value.issuedCookie)).ok).toBe(true);

    // The function itself returns the id of the row it rotated.
    const direct = await db.web.query(SESSION_STATEMENTS.rotateSession, [1, (await digests())[1], 1, hex(32)]);
    expect(direct.rows[0]).toMatchObject({ result: "ROTATED", session_id: b.value.session.id });
    const refused = await db.web.query(SESSION_STATEMENTS.rotateSession, [1, hex(32), 1, hex(32)]);
    expect(refused.rows[0]).toEqual({ result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null });
  });
});
