import { Pool, type PoolClient } from "pg";

/**
 * Connection wrapper for the PostgreSQL 17 foundation (Milestone 002, Increment 1).
 *
 * NOT WIRED INTO THE RUNNING APPLICATION. Nothing in `src/server` or `src/app`
 * imports this directory; the application still runs on the in-memory mock.
 * This module has never been run against a database.
 *
 * This module contains no statement text. Every statement the library sends is
 * defined in `./statements`, the one reviewed catalogue.
 */

export interface PgQueryResult<Row> {
  readonly rows: readonly Row[];
}

/**
 * Runs one statement. An implementation may use a different connection for
 * every call (a pool does), so this is enough only for work that is a single
 * statement. Anything that spans statements needs a `PinnedConnection`.
 */
export interface PgQueryable {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>>;
}

/** One connection taken out of a source. It must be given back exactly once. */
export interface PgAcquiredClient extends PgQueryable {
  /** Returns the connection. A truthy argument asks the source to destroy it instead of reusing it. */
  release(destroy?: boolean): void;
}

/** Hands out one dedicated connection per call. A `pg` pool does this; see `connectionSourceFromPool`. */
export interface PgConnectionSource {
  connect(): Promise<PgAcquiredClient>;
}

// Module-private: only `withPinnedConnection` can construct a PinnedConnection.
const PINNED_CONNECTION_TOKEN = Symbol("shopaccess.pg.pinned-connection");

/**
 * Exactly one backend connection, held for the duration of one unit of work.
 * Transaction-bound code takes this type and nothing else. Because the class
 * has private fields it is nominal: an object that merely has a `query`
 * method, such as a pool, does not type-check as one, and at run time the
 * constructor refuses any caller but `withPinnedConnection`.
 */
export class PinnedConnection {
  readonly #client: PgAcquiredClient;
  #open = true;
  #discard = false;

  constructor(token: symbol, client: PgAcquiredClient) {
    if (token !== PINNED_CONNECTION_TOKEN) {
      throw new TypeError("A pinned connection is obtained only through withPinnedConnection");
    }
    this.#client = client;
  }

  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
    if (!this.#open) return Promise.reject(new Error("The pinned connection has already been released"));
    return this.#client.query<Row>(text, values);
  }

  /** Marks the connection as not reusable, for example when a ROLLBACK could not be confirmed. */
  discard(): void {
    this.#discard = true;
  }

  /** Whether `discard` was called. Read by `withPinnedConnection` when it releases. */
  get discarded(): boolean {
    return this.#discard;
  }

  /** Called by `withPinnedConnection` only: further use is refused. */
  close(token: symbol): void {
    if (token !== PINNED_CONNECTION_TOKEN) throw new TypeError("Only withPinnedConnection closes a pinned connection");
    this.#open = false;
  }
}

/**
 * Acquires one connection, runs `work` on it and releases it in every case.
 * If `work` throws, or marked the connection with `discard`, the connection is
 * destroyed rather than returned for reuse: its transaction state is unknown.
 *
 * Refuses, before doing any work, a source that does not hand out a releasable
 * client. A bare `pg` Client (whose `connect()` resolves to nothing) and an
 * object that only has `query` are both refused.
 * A client that has `release` but no `query` is released for destruction before
 * the refusal, so the acquired resource is not abandoned.
 */
export async function withPinnedConnection<T>(
  source: PgConnectionSource,
  work: (connection: PinnedConnection) => Promise<T>,
): Promise<T> {
  if (typeof source !== "object" || source === null || typeof source.connect !== "function") {
    throw new TypeError("A connection source with connect() is required: a transaction needs one pinned connection");
  }
  const client: unknown = await source.connect();
  const candidate = typeof client === "object" && client !== null ? (client as Partial<PgAcquiredClient>) : null;
  if (!candidate || typeof candidate.query !== "function" || typeof candidate.release !== "function") {
    // Something was acquired but cannot be used. If it can be given back, it is,
    // marked for destruction, so a malformed adapter does not leak a connection.
    if (candidate && typeof candidate.release === "function") {
      try {
        candidate.release(true);
      } catch {
        // The refusal below is the error the caller needs; nothing more can be done with this object.
      }
    }
    throw new TypeError("connect() did not return a usable, releasable client: a transaction needs one pinned connection");
  }
  const acquired = client as PgAcquiredClient;
  const pinned = new PinnedConnection(PINNED_CONNECTION_TOKEN, acquired);
  let failed = false;
  try {
    return await work(pinned);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    pinned.close(PINNED_CONNECTION_TOKEN);
    acquired.release(failed || pinned.discarded);
  }
}

function adaptPoolClient(client: PoolClient): PgAcquiredClient {
  return {
    async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
      const result = values === undefined ? await client.query(text) : await client.query(text, [...values]);
      return { rows: result.rows as Row[] };
    },
    release(destroy?: boolean): void {
      client.release(destroy === true);
    },
  };
}

/** A `pg` pool as a source of pinned connections. */
export function connectionSourceFromPool(pool: Pool): PgConnectionSource {
  return {
    async connect(): Promise<PgAcquiredClient> {
      return adaptPoolClient(await pool.connect());
    },
  };
}

/** A `pg` pool as a single-statement runner. Each call may use a different connection. */
export function queryableFromPool(pool: Pool): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
      const result = values === undefined ? await pool.query(text) : await pool.query(text, [...values]);
      return { rows: result.rows as Row[] };
    },
  };
}

/** Owner-approved for the local MVP (specification 13.1). */
export const PG_CONNECTION_TIMEOUTS = Object.freeze({
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
  idleInTransactionSessionTimeoutMs: 10_000,
});

/** A rolled-back database transaction may be re-run at most this many times. */
export const MAX_TRANSACTION_RERUNS = 3;

/** Startup options that apply the approved timeouts to every connection. */
export function connectionStartupOptions(): string {
  return [
    `-c lock_timeout=${PG_CONNECTION_TIMEOUTS.lockTimeoutMs}`,
    `-c statement_timeout=${PG_CONNECTION_TIMEOUTS.statementTimeoutMs}`,
    `-c idle_in_transaction_session_timeout=${PG_CONNECTION_TIMEOUTS.idleInTransactionSessionTimeoutMs}`,
  ].join(" ");
}

/**
 * Creates a pool whose connections carry the approved timeouts. The caller
 * supplies the connection string; this module reads no environment variable.
 * No connection is opened until the pool is first used.
 */
export function createPgPool(connectionString: string, maxConnections = 5): Pool {
  return new Pool({ connectionString, max: maxConnections, options: connectionStartupOptions() });
}

const DEADLOCK_DETECTED = "40P01";
const LOCK_NOT_AVAILABLE = "55P03";

/** True only for a deadlock or a lock timeout: failures after which the whole transaction was rolled back. */
export function isRerunnableDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === DEADLOCK_DETECTED || code === LOCK_NOT_AVAILABLE;
}

export interface RerunOptions {
  /** Waits between attempts. Injected in tests so they never sleep. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Source of jitter in [0, 1). */
  readonly random?: () => number;
}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Runs one complete database transaction, re-running it from the start after a
 * deadlock or lock timeout, at most MAX_TRANSACTION_RERUNS times. Any other
 * error, and the error of the last attempt, is rethrown unchanged.
 *
 * DATABASE WORK ONLY. `work` must contain nothing but database statements whose
 * effects were rolled back by the failure. It must never contain a call to a
 * payment provider or any other external side effect: a re-run would repeat it.
 */
export async function runWithReruns<T>(work: () => Promise<T>, options: RerunOptions = {}): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  for (let rerun = 0; ; rerun += 1) {
    try {
      return await work();
    } catch (error) {
      if (rerun >= MAX_TRANSACTION_RERUNS || !isRerunnableDatabaseError(error)) throw error;
      await sleep(Math.floor(25 * 2 ** rerun * (0.5 + random())));
    }
  }
}
