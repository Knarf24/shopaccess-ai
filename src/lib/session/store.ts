export interface SessionRecord {
  readonly id: string;
  readonly tokenDigest: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface SessionStore {
  /**
   * Inserts the session only if fewer than `maxSessions` are currently stored.
   * The capacity check and the insert are ONE atomic step: no other operation
   * can run between them, so concurrent callers can never exceed the limit.
   * Returns false, storing nothing, when the store is full.
   */
  insertWithinCapacity(record: SessionRecord, maxSessions: number): Promise<boolean>;
  findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null>;
  touch(id: string, lastSeenAt: Date): Promise<void>;
  /** Compare-and-set rotation: succeeds only if the stored digest is still `expectedDigest`. */
  replaceTokenDigest(id: string, expectedDigest: string, newDigest: string, at: Date): Promise<boolean>;
  revoke(id: string, at: Date): Promise<void>;
  /** Removes sessions that are revoked, past their absolute expiry, or idle since before `idleCutoff`. Returns their IDs. */
  deleteExpired(now: Date, idleCutoff: Date): Promise<string[]>;
  /** Number of stored sessions (after cleanup this is the number of live sessions). */
  count(): Promise<number>;
}

/** Single-process store for tests and the mock milestone. Not a production session store. */
export class InMemorySessionStore implements SessionStore {
  private readonly byId = new Map<string, SessionRecord>();
  private readonly idByDigest = new Map<string, string>();

  // Deliberately contains no `await`: in a single JavaScript process the check and
  // the two writes below run to completion before any other task can observe the store.
  async insertWithinCapacity(record: SessionRecord, maxSessions: number): Promise<boolean> {
    if (this.byId.size >= maxSessions) return false;
    if (this.byId.has(record.id)) throw new Error("Duplicate session id");
    if (this.idByDigest.has(record.tokenDigest)) throw new Error("Duplicate session token digest");
    this.byId.set(record.id, record);
    this.idByDigest.set(record.tokenDigest, record.id);
    return true;
  }

  async findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null> {
    const id = this.idByDigest.get(tokenDigest);
    return (id && this.byId.get(id)) || null;
  }

  async touch(id: string, lastSeenAt: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record) this.byId.set(id, { ...record, lastSeenAt });
  }

  async replaceTokenDigest(id: string, expectedDigest: string, newDigest: string, at: Date): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record || record.tokenDigest !== expectedDigest || record.revokedAt) return false;
    this.byId.set(id, { ...record, tokenDigest: newDigest, lastSeenAt: at });
    this.idByDigest.delete(expectedDigest);
    this.idByDigest.set(newDigest, id);
    return true;
  }

  async revoke(id: string, at: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record && !record.revokedAt) this.byId.set(id, { ...record, revokedAt: at });
  }

  async deleteExpired(now: Date, idleCutoff: Date): Promise<string[]> {
    const removed: string[] = [];
    for (const record of this.byId.values()) {
      const expired =
        record.revokedAt !== null ||
        record.absoluteExpiresAt.getTime() <= now.getTime() ||
        record.lastSeenAt.getTime() <= idleCutoff.getTime();
      if (!expired) continue;
      this.byId.delete(record.id);
      this.idByDigest.delete(record.tokenDigest);
      removed.push(record.id);
    }
    return removed;
  }

  async count(): Promise<number> {
    return this.byId.size;
  }

  /**
   * SYNCHRONOUS liveness decision for the single-process mock: true only if the
   * session is stored right now, is not revoked, and is inside both its idle
   * and absolute lifetimes. A session that has been reclaimed is simply absent.
   *
   * Because it is synchronous, a caller can decide liveness and write its own
   * records in the same uninterrupted step, so reclamation cannot happen in
   * between. This is what the checkout commit relies on.
   */
  isLive(sessionId: string, now: Date, idleTimeoutMs: number): boolean {
    const record = this.byId.get(sessionId);
    if (!record || record.revokedAt !== null) return false;
    const at = now.getTime();
    return at < record.absoluteExpiresAt.getTime() && at < record.lastSeenAt.getTime() + idleTimeoutMs;
  }
}
