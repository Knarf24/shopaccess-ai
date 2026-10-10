import type { AuditEvent } from "../security/audit";
import type { SessionRecord, SessionStore } from "../session/store";

/**
 * Parameterized SQL for the PostgreSQL schema in db/migrations.
 *
 * Every statement is a constant string; all runtime values travel in the
 * `values` array. Nothing here builds SQL from input. These statements have
 * NOT been executed against a database in this milestone (see the
 * implementation report); they are covered only by parameterization tests.
 */
export interface QueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

/** Structural subset of `pg.Pool` / `pg.PoolClient`. */
export interface Queryable {
  query<Row = Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<QueryResult<Row>>;
}

interface SessionRow {
  id: string;
  token_digest: string;
  created_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

export const SQL = {
  // NOT race-free in PostgreSQL: two concurrent statements can both pass the count. Database-level
  // capacity enforcement is a future integration requirement; the atomic guarantee exists only in the in-memory mock.
  insertSessionWithinCapacity: `INSERT INTO shopper_sessions (id, token_digest, created_at, last_seen_at, absolute_expires_at)
SELECT $1, $2, $3, $4, $5 WHERE (SELECT count(*) FROM shopper_sessions) < $6`,
  findSessionByDigest: `SELECT id, token_digest, created_at, last_seen_at, absolute_expires_at, revoked_at
FROM shopper_sessions WHERE token_digest = $1`,
  touchSession: `UPDATE shopper_sessions SET last_seen_at = $2, row_version = row_version + 1 WHERE id = $1`,
  rotateSession: `UPDATE shopper_sessions SET token_digest = $3, last_seen_at = $4, row_version = row_version + 1
WHERE id = $1 AND token_digest = $2 AND revoked_at IS NULL`,
  revokeSession: `UPDATE shopper_sessions SET revoked_at = $2, row_version = row_version + 1 WHERE id = $1 AND revoked_at IS NULL`,

  // Sessions that still own checkout or cart rows are kept; their retention is a deployment-stage decision.
  deleteExpiredSessions: `DELETE FROM shopper_sessions s
WHERE (s.revoked_at IS NOT NULL OR s.absolute_expires_at <= $1 OR s.last_seen_at <= $2)
  AND NOT EXISTS (SELECT 1 FROM checkout_intents i WHERE i.session_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM carts c WHERE c.session_id = s.id)
RETURNING s.id`,
  countSessions: `SELECT count(*)::int AS total FROM shopper_sessions WHERE absolute_expires_at > $1`,

  findQuoteForSession: `SELECT q.* FROM quotes q WHERE q.id = $1 AND q.session_id = $2`,
  findIntentForSession: `SELECT i.* FROM checkout_intents i WHERE i.id = $1 AND i.session_id = $2`,
  findConfirmationForSession: `SELECT c.* FROM confirmations c WHERE c.id = $1 AND c.session_id = $2`,

  consumeConfirmation: `UPDATE confirmations SET consumed_at = $2
WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2`,
  compareAndSetIntentState: `UPDATE checkout_intents SET state = $3, row_version = row_version + 1, updated_at = $4
WHERE id = $1 AND row_version = $2`,

  claimOperationForDispatch: `UPDATE payment_operations
SET state = 'DISPATCHING', lease_owner = $2, lease_expires_at = $4, attempt_count = attempt_count + 1,
    row_version = row_version + 1, updated_at = $3
WHERE id = $1 AND state IN ('PENDING', 'READBACK_CLEARED')
  AND (lease_owner IS NULL OR lease_expires_at <= $3)
RETURNING *`,
  claimOperationForRecovery: `UPDATE payment_operations
SET state = CASE WHEN state = 'PENDING_PROVIDER' THEN state ELSE 'UNKNOWN' END,
    lease_owner = $2, lease_expires_at = $4, row_version = row_version + 1, updated_at = $3
WHERE id = $1 AND state IN ('DISPATCHING', 'UNKNOWN', 'PENDING_PROVIDER', 'READBACK_CLEARED')
  AND (lease_owner IS NULL OR lease_expires_at <= $3)
RETURNING *`,

  appendAuditEvent: `INSERT INTO audit_events (event_id, event_type, occurred_at, actor, session_id, checkout_intent_id, operation_id, detail)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
} as const;

const toSessionRecord = (row: SessionRow): SessionRecord => ({
  id: row.id,
  tokenDigest: row.token_digest,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  absoluteExpiresAt: row.absolute_expires_at,
  revokedAt: row.revoked_at,
});

export class PgSessionStore implements SessionStore {
  constructor(private readonly db: Queryable) {}

  async insertWithinCapacity(record: SessionRecord, maxSessions: number): Promise<boolean> {
    const result = await this.db.query(SQL.insertSessionWithinCapacity, [
      record.id,
      record.tokenDigest,
      record.createdAt,
      record.lastSeenAt,
      record.absoluteExpiresAt,
      maxSessions,
    ]);
    return result.rowCount === 1;
  }

  async findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null> {
    const result = await this.db.query<SessionRow>(SQL.findSessionByDigest, [tokenDigest]);
    return result.rows[0] ? toSessionRecord(result.rows[0]) : null;
  }

  async touch(id: string, lastSeenAt: Date): Promise<void> {
    await this.db.query(SQL.touchSession, [id, lastSeenAt]);
  }

  async replaceTokenDigest(id: string, expectedDigest: string, newDigest: string, at: Date): Promise<boolean> {
    const result = await this.db.query(SQL.rotateSession, [id, expectedDigest, newDigest, at]);
    return result.rowCount === 1;
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.db.query(SQL.revokeSession, [id, at]);
  }

  async deleteExpired(now: Date, idleCutoff: Date): Promise<string[]> {
    return (await this.db.query<{ id: string }>(SQL.deleteExpiredSessions, [now, idleCutoff])).rows.map((row) => row.id);
  }

  async count(): Promise<number> {
    const result = await this.db.query<{ total: number }>(SQL.countSessions, [new Date()]);
    return result.rows[0]?.total ?? 0;
  }
}

/** Ownership-scoped lookups: an object owned by another session is indistinguishable from a missing one. */
export async function findQuoteRowForSession(db: Queryable, sessionId: string, quoteId: string): Promise<Record<string, unknown> | null> {
  return (await db.query(SQL.findQuoteForSession, [quoteId, sessionId])).rows[0] ?? null;
}

export async function findIntentRowForSession(db: Queryable, sessionId: string, intentId: string): Promise<Record<string, unknown> | null> {
  return (await db.query(SQL.findIntentForSession, [intentId, sessionId])).rows[0] ?? null;
}

export async function claimOperationForDispatch(
  db: Queryable,
  operationId: string,
  workerId: string,
  now: Date,
  leaseMs: number,
): Promise<Record<string, unknown> | null> {
  const result = await db.query(SQL.claimOperationForDispatch, [operationId, workerId, now, new Date(now.getTime() + leaseMs)]);
  return result.rows[0] ?? null;
}

export async function appendAuditEvent(db: Queryable, event: AuditEvent): Promise<void> {
  await db.query(SQL.appendAuditEvent, [
    event.eventId,
    event.eventType,
    event.occurredAt,
    event.actor,
    event.sessionId,
    event.checkoutIntentId,
    event.operationId,
    JSON.stringify(event.detail),
  ]);
}
