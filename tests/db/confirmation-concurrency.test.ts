import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { adminUrl, hex, openDisposableDatabase, TEST_NONCE_KEY, type DisposableDatabase } from "./harness";

// NEVER RUN. Written for the Increment 2.2 confirmation functions (migration 0009); running it needs a separate
// authorization and a new disposable PostgreSQL 17 cluster (see ./harness). Nothing here is evidence until it has
// been run.
//
// Scope: the cases of the Increment 2.2 acceptance map (specification 19.15) that need more than one connection at
// once. The method is the reviewed one of checkout-concurrency.test.ts, and its helpers are repeated here because a
// database test file imports nothing from another. The test owner's first connection (db.admin) is the holder: it
// takes a lock inside a transaction and keeps it. A call that is forced to wait is sent on a web client of its own
// (db.connectWeb), whose backend is read on that client before the call is sent. The test owner's second connection
// (db.secondAdmin) is the observer: it is outside any transaction while it observes, so every observation is
// current. An interleaving is forced by the holder's lock and established by what the server reports about the
// identified backends; no elapsed time is evidence of anything. The web connections carry the approved lock timeout
// of two seconds, which is not changed here: every forced wait is released well inside it.
//
// A deadline that must pass while a call waits (PGT-143, PGT-54c, PGT-54g, the boundary case of PGT-234): the
// pre-call timing condition may be set up again, at most five times, before the function under test is sent. Once it
// is sent, that call is never sent again: a barrier that fails, a lock timeout, an unexpected result or an error
// fails the test and stays visible.
//
// Statements: every statement this file sends is a fixed string held in the table SQL, or an entry of the reviewed
// catalogue. Values travel only as bound parameters. The static test PGT-157 reads this file and depends on that.
// This file sends no privilege statement and creates, replaces, alters or switches off nothing.

const PRODUCT = "dmp_codebook15";
const VARIANT = "dmv_codebook15a";
const UNIT_AMOUNT = 79900;
const UNKNOWN_PRODUCT = "dmp_unknown01";
const UNKNOWN_VARIANT = "dmv_unknown01";
const SESSION_KEY_VERSION = 1;
const NOW = "0 seconds";

const SQL = {
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",

  // The entry points, exactly as the reviewed catalogue has them (the static suite compares the two).
  startCheckout: "SELECT result, intent_id, quote_id, quote_expires_at FROM shopaccess_api.start_checkout($1, $2, $3, $4, $5, $6)",
  cancelCheckout: "SELECT result FROM shopaccess_api.cancel_checkout($1, $2, $3)",
  readCheckout:
    "SELECT result, owner_id, intent_id, purchase_group_id, stored_state, row_version, effective_status, replaces_intent_id, superseded_by_intent_id, intent_created_at, intent_updated_at, quote_id, merchant_id, merchant_display_name, product_id, product_title, variant_id, variant_label, quantity, unit_amount_cents, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, currency, assumptions_code, catalog_revision, quote_digest, quote_created_at, quote_expires_at, quote_stale, database_time, challenge_id, challenge_quote_digest, challenge_nonce_key_version, challenge_nonce_digest, challenge_summary, challenge_issued_at, challenge_expires_at, challenge_usable FROM shopaccess_api.read_checkout($1, $2, $3)",
  issueChallenge:
    "SELECT result, challenge_id, quote_digest, nonce_key_version, nonce_digest, summary, expires_at FROM shopaccess_api.issue_challenge($1, $2, $3, $4, $5, $6)",
  consumeChallenge: "SELECT result, intent_id FROM shopaccess_api.consume_challenge($1, $2, $3, $4, $5, $6)",

  // Fixtures and the holder's locks, by the test owner.
  insertOwner: "INSERT INTO shopaccess.checkout_owners (id, created_at) VALUES ($1, pg_catalog.clock_timestamp() + $2::interval)",
  insertSession:
    "INSERT INTO shopaccess.shopper_sessions (id, owner_id, key_version, token_digest, created_at, last_seen_at, absolute_expires_at) " +
    "SELECT $1, $2, 1, $3, t.now + $4::interval, t.now, t.now + $4::interval + interval '24 hours' " +
    "FROM (SELECT pg_catalog.clock_timestamp() AS now) t",
  insertGroup: "INSERT INTO shopaccess.purchase_groups (id, owner_id, created_at) VALUES ($1, $2, $3::timestamptz)",
  insertIntent:
    "INSERT INTO shopaccess.checkout_intents (id, owner_id, purchase_group_id, state, row_version, current_quote_id, created_at, updated_at) " +
    "VALUES ($1, $2, $3, 'QUOTED', 2, $4, $5::timestamptz, $5::timestamptz)",
  insertQuote:
    "INSERT INTO shopaccess.quotes (id, owner_id, checkout_intent_id, merchant_id, catalog_revision, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, currency, assumptions_code, created_at, expires_at, digest, digest_version) " +
    "SELECT f.quote_id, f.owner_id, f.intent_id, 'dmm_shopaccessdemo', 1, 79900, 0, 0, 0, 79900, 'USD', 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1', f.created_at, f.created_at + interval '15 minutes', " +
    "shopaccess_api.quote_digest_saqd1(f.quote_id, f.owner_id, f.intent_id, f.group_id, 'dmm_shopaccessdemo', 'dmp_codebook15', 'dmv_codebook15a', 1::bigint, 1::bigint, 79900::bigint, 79900::bigint, 0::bigint, 0::bigint, 0::bigint, 79900::bigint, 'USD', 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1', f.created_at, f.created_at + interval '15 minutes'), 'SAQD-1' " +
    "FROM (SELECT $1::text AS quote_id, $2::text AS owner_id, $3::text AS intent_id, $4::text AS group_id, $5::timestamptz AS created_at) f",
  insertItem:
    "INSERT INTO shopaccess.quote_items (quote_id, line_number, product_id, variant_id, quantity, unit_amount_cents, line_subtotal_cents, merchant_display_name, product_title, variant_label, descriptive_terms_digest) " +
    "SELECT $1::text, 1, mv.product_id, mv.id, 1, 79900, 79900, mm.display_name, mp.title, mv.label, shopaccess_api.descriptive_terms_digest(mp.description, mv.specs) " +
    "FROM shopaccess.merchant_variants mv JOIN shopaccess.merchant_products mp ON mp.id = mv.product_id JOIN shopaccess.merchants mm ON mm.id = mp.merchant_id " +
    "WHERE mv.id = 'dmv_codebook15a'",
  insertTransition:
    "INSERT INTO shopaccess.checkout_transitions (checkout_intent_id, to_version, from_version, event_id, event_type, actor, entry_point, from_state, to_state, occurred_at, recorded_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz)",
  cancelIntentDirectly: "UPDATE shopaccess.checkout_intents SET state = 'CANCELED_LOCAL', row_version = row_version + 1 WHERE id = $1",
  // A challenge of a quote, written directly: its id, its nonce digest, the quote, the nonce key version, and its
  // issue and expiry times as intervals from the database clock.
  insertChallenge:
    "INSERT INTO shopaccess.confirmation_challenges (id, owner_id, checkout_intent_id, quote_id, quote_digest, nonce_digest, nonce_key_version, summary, status, issued_at, expires_at) " +
    "SELECT $1::text, q.owner_id, q.checkout_intent_id, q.id, q.digest, $2::text, $4::smallint, '{}'::jsonb, 'ACTIVE', t.now + $5::interval, t.now + $6::interval " +
    "FROM shopaccess.quotes q, (SELECT pg_catalog.clock_timestamp() AS now) t WHERE q.id = $3",
  supersedeChallengeDirectly: "UPDATE shopaccess.confirmation_challenges SET status = 'SUPERSEDED', superseded_at = issued_at + interval '1 second' WHERE id = $1",
  insertWindow:
    "INSERT INTO shopaccess.owner_request_windows (owner_id, window_started_at, window_calls, window_throttled, total_throttled, updated_at) " +
    "SELECT $1, t.now + $2::interval, $3::integer, 0, 0, t.now + $2::interval FROM (SELECT pg_catalog.clock_timestamp() AS now) t",
  lockOwner: "SELECT id FROM shopaccess.checkout_owners WHERE id = $1 FOR UPDATE",
  lockIntent: "SELECT id FROM shopaccess.checkout_intents WHERE id = $1 FOR UPDATE",
  lockChallenge: "SELECT id FROM shopaccess.confirmation_challenges WHERE id = $1 FOR UPDATE",
  // A lock on a nonce key row that conflicts with the share lock a confirmation call takes on it.
  lockNonceKey: "SELECT key_version FROM shopaccess.server_key_versions WHERE purpose = 'confirmation_nonce' AND key_version = $1 FOR NO KEY UPDATE",
  // Session changes written directly, in the shapes the session trigger accepts: a rotation and a revocation.
  rotateSessionDirectly:
    "UPDATE shopaccess.shopper_sessions SET token_digest = $2, last_seen_at = pg_catalog.clock_timestamp(), row_version = row_version + 1 WHERE id = $1",
  revokeSessionDirectly: "UPDATE shopaccess.shopper_sessions SET revoked_at = pg_catalog.clock_timestamp(), row_version = row_version + 1 WHERE id = $1",
  setVariantAmount: "UPDATE shopaccess.merchant_variants SET unit_amount_cents = $2 WHERE id = $1",
  variantAmount: "SELECT unit_amount_cents FROM shopaccess.merchant_variants WHERE id = $1",

  // Observations of the server, by the test owner.
  backendPid: "SELECT pg_catalog.pg_backend_pid() AS pid",
  backendAndTransaction: "SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.pg_current_xact_id()::text AS xid",
  // The login of the connection that sends it, as the server names it.
  sessionLogin: "SELECT session_user::text AS login",
  // The observer's one observation: every backend of this database that waits on a lock, and every backend named in
  // $1 whether it waits or not, each with the backends the server reports as blocking it. Sent only by the observer,
  // outside any transaction, so that it is current each time.
  observeWaits:
    "SELECT a.pid, a.usename::text AS role, (a.wait_event_type = 'Lock') IS TRUE AS lock_wait, pg_catalog.pg_blocking_pids(a.pid) AS blocked_by " +
    "FROM pg_catalog.pg_stat_activity a " +
    "WHERE a.datname = pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid() AND (a.wait_event_type = 'Lock' OR a.pid = ANY($1::integer[])) ORDER BY a.pid",
  ungrantedTransactionLocks:
    "SELECT count(*)::integer AS n FROM pg_catalog.pg_locks l WHERE l.pid = $1 AND NOT l.granted AND l.locktype = 'transactionid' AND l.transactionid::text = $2",
  lockWaits:
    "SELECT a.pid, pg_catalog.pg_blocking_pids(a.pid) AS blocked_by FROM pg_catalog.pg_stat_activity a " +
    "WHERE a.datname = pg_catalog.current_database() AND a.wait_event_type = 'Lock' AND a.pid <> pg_catalog.pg_backend_pid() ORDER BY a.pid",
  openTransactions:
    "SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity a WHERE a.datname = pg_catalog.current_database() AND a.state LIKE 'idle in transaction%'",
  shortSleep: "SELECT pg_catalog.pg_sleep(0.005)",
  // Database time against a deadline: whether it has been reached, and how many seconds are left.
  sessionMargin:
    "SELECT (pg_catalog.clock_timestamp() >= s.absolute_expires_at) AS passed, " +
    "(extract(epoch FROM (s.absolute_expires_at - pg_catalog.clock_timestamp())))::double precision AS remaining_seconds FROM shopaccess.shopper_sessions s WHERE s.id = $1",
  challengeMargin:
    "SELECT (pg_catalog.clock_timestamp() >= c.expires_at) AS passed, " +
    "(extract(epoch FROM (c.expires_at - pg_catalog.clock_timestamp())))::double precision AS remaining_seconds FROM shopaccess.confirmation_challenges c WHERE c.id = $1",
  quoteMargin:
    "SELECT (pg_catalog.clock_timestamp() >= q.expires_at) AS passed, " +
    "(extract(epoch FROM (q.expires_at - pg_catalog.clock_timestamp())))::double precision AS remaining_seconds FROM shopaccess.quotes q WHERE q.id = $1",
  windowMargin:
    "SELECT (pg_catalog.clock_timestamp() >= w.window_started_at + interval '60 seconds') AS passed, " +
    "(extract(epoch FROM (w.window_started_at + interval '60 seconds' - pg_catalog.clock_timestamp())))::double precision AS remaining_seconds FROM shopaccess.owner_request_windows w WHERE w.owner_id = $1",
  windowTimes:
    "SELECT window_started_at, window_calls, window_throttled::integer AS window_throttled, total_throttled::integer AS total_throttled, updated_at FROM shopaccess.owner_request_windows WHERE owner_id = $1",
  windowRow:
    "SELECT window_calls, window_throttled::integer AS window_throttled, total_throttled::integer AS total_throttled FROM shopaccess.owner_request_windows WHERE owner_id = $1",

  // Observations of the rows.
  nonceDigestOf: "SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex') AS digest",
  quoteRow: "SELECT id, digest, expires_at FROM shopaccess.quotes WHERE id = $1",
  intentRow:
    "SELECT state, row_version, replaces_intent_id, superseded_by_intent_id, current_quote_id, confirmation_id, confirmation_status FROM shopaccess.checkout_intents WHERE id = $1",
  successorsOf: "SELECT id FROM shopaccess.checkout_intents WHERE replaces_intent_id = $1",
  challengeRow:
    "SELECT id, owner_id, checkout_intent_id, quote_id, quote_digest, nonce_digest, nonce_key_version, summary, status, issued_at, expires_at, consumed_at, superseded_at, expired_marked_at FROM shopaccess.confirmation_challenges WHERE id = $1",
  challengesOfQuote: "SELECT id, status FROM shopaccess.confirmation_challenges WHERE quote_id = $1 ORDER BY issued_at, id",
  transitionRows:
    "SELECT event_type, from_version, to_version, entry_point FROM shopaccess.checkout_transitions WHERE checkout_intent_id = $1 ORDER BY to_version",
  auditRows: "SELECT event_type, checkout_intent_id, session_id, detail FROM shopaccess.audit_events WHERE owner_id = $1 ORDER BY id",
  snapshot:
    "SELECT (SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.purchase_groups t) AS purchase_groups, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.checkout_intents t) AS checkout_intents, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.quotes t) AS quotes, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.quote_items t) AS quote_items, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.confirmation_challenges t) AS confirmation_challenges, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.checkout_transitions t) AS checkout_transitions, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.owner_request_windows t) AS owner_request_windows, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.audit_events t) AS audit_events, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.shopper_sessions t) AS shopper_sessions",
} as const;

type Admin = DisposableDatabase["admin"];
type Web = DisposableDatabase["web"];
type Row = Record<string, unknown>;

/** A session of one owner, as the functions see it: the credential is session key version 1 and this token digest. */
interface Credential {
  readonly owner: string;
  readonly session: string;
  readonly digest: string;
}

const newId = (prefix: string): string => `${prefix}_${hex(16)}`;
/** A well-formed nonce: 43 characters of the base64url alphabet whose last one is canonical. A test value. */
const newNonce = (): string => `${hex(21)}A`;

/**
 * A session row written by the test owner, for a new owner or an existing one. `createdOffset` is relative to the
 * database clock; the absolute expiry is 24 hours after creation, so "-86399 seconds" gives a session that has one
 * second left.
 */
async function newCredential(client: Admin, createdOffset: string = NOW, existingOwner: string | null = null): Promise<Credential> {
  const owner = existingOwner ?? newId("own");
  const session = newId("ses");
  const digest = hex(32);
  if (existingOwner === null) await client.query(SQL.insertOwner, [owner, NOW]);
  await client.query(SQL.insertSession, [session, owner, digest, createdOffset]);
  return { owner, session, digest };
}

function sqlStateOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
}

function constraintOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "constraint" in error ? String((error as { constraint: unknown }).constraint) : null;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Forced waits: identified callers, a current observer, a checked lock queue
// ---------------------------------------------------------------------------

// Timing. The web role's lock timeout is two seconds (approved, D-8); nothing here changes it. A call that is forced
// to wait starts waiting no earlier than the moment the clock of its barrier is read, and that is before the first
// call of the barrier is sent. Every bound below is counted from that reading, for all stages of the barrier together.
const WEB_LOCK_TIMEOUT_MS = 2_000;
/** No round of observation starts at or after this. A round is at most two observations and one pause of 5 ms. */
const OVERLAP_OBSERVATION_MS = 1_200;
/** The same, where a database deadline at most one second away must still lie ahead when the wait is observed. */
const SINGLE_WAIT_OBSERVATION_MS = 400;
/** No reading of a database deadline starts at or after this. */
const DEADLINE_CROSSING_MS = 1_500;
/** The holder lets go only before this. Later, the test fails instead of letting a call run into its lock timeout. */
const RELEASE_LIMIT_MS = 1_700;

interface BarrierClock {
  readonly startedAt: number;
  readonly observeUntil: number;
}

/** Read before the first call of a barrier is sent. The time only ends the observing; it is never evidence of a wait. */
function startClock(observationMs: number): BarrierClock {
  const startedAt = Date.now();
  return { startedAt, observeUntil: startedAt + observationMs };
}

/** Fails, before the holder lets go, when so much time has passed that a waiting call may be about to time out. */
function requireTimeToRelease(clock: BarrierClock, stage: string): void {
  const elapsed = Date.now() - clock.startedAt;
  if (elapsed >= RELEASE_LIMIT_MS) {
    throw new Error(`${stage}: ${elapsed} ms have passed since the first call was sent; the holder must let go within ${RELEASE_LIMIT_MS} ms, inside the lock timeout of ${WEB_LOCK_TIMEOUT_MS} ms`);
  }
}

type WebClient = Awaited<ReturnType<DisposableDatabase["connectWeb"]>>;
type Observer = DisposableDatabase["secondAdmin"];

/** A call a caller can send: one of the four mutating functions, or one of the two reviewed session changes. */
interface Request {
  readonly statement: "startCheckout" | "cancelCheckout" | "issueChallenge" | "consumeChallenge" | "sessionRevocation" | "sessionRotation";
  readonly values: readonly unknown[];
}

/** How a submitted call ended. Both ways are kept: a raised error is never turned into a result. */
type Outcome =
  | { readonly kind: "returned"; readonly row: Record<string, unknown> }
  | { readonly kind: "raised"; readonly sqlstate: string; readonly constraint: string | null; readonly error: unknown };

/** Attaches both handlers at once, in the same step in which the call is sent: no rejection is ever left unhandled. */
function tagged(sent: Promise<{ rows: Array<Record<string, unknown>> }>): Promise<Outcome> {
  return sent.then(
    (reply): Outcome => ({ kind: "returned", row: reply.rows[0] }),
    (error: unknown): Outcome => ({ kind: "raised", sqlstate: sqlStateOf(error), constraint: constraintOf(error), error }),
  );
}

/** The result code of a call, or "ERROR <sqlstate>" if it raised: a timeout can never be read as a business refusal. */
const resultOf = (outcome: Outcome): string => (outcome.kind === "returned" ? String(outcome.row.result) : `ERROR ${outcome.sqlstate}`);

/** The same with the constraint an error named, for the one case that expects an error. */
const failureOf = (outcome: Outcome): { result: string | null; sqlstate: string | null; constraint: string | null } =>
  outcome.kind === "returned" ? { result: String(outcome.row.result), sqlstate: null, constraint: null } : { result: null, sqlstate: outcome.sqlstate, constraint: outcome.constraint };

/** What is printed about a settled call when a barrier fails: its result code or its SQLSTATE, and nothing else of it. */
function summaryOf(settled: unknown): unknown {
  if (typeof settled !== "object" || settled === null || !("kind" in settled)) return settled;
  const outcome = settled as Outcome;
  return outcome.kind === "returned" ? { returned: outcome.row.result } : { raised: outcome.sqlstate, constraint: outcome.constraint };
}

/** Sends one call on the caller's own client. The handlers are attached before this function returns. */
function submit(client: WebClient, request: Request): Promise<Outcome> {
  const values = [...request.values];
  switch (request.statement) {
    case "startCheckout":
      return tagged(client.query(SQL.startCheckout, values));
    case "cancelCheckout":
      return tagged(client.query(SQL.cancelCheckout, values));
    case "issueChallenge":
      return tagged(client.query(SQL.issueChallenge, values));
    case "consumeChallenge":
      return tagged(client.query(SQL.consumeChallenge, values));
    case "sessionRevocation":
      return tagged(client.query(SESSION_STATEMENTS.revokeSession, values));
    case "sessionRotation":
      return tagged(client.query(SESSION_STATEMENTS.rotateSession, values));
  }
}

/** The backend of a client, read on that client. */
async function backendPidOf(client: WebClient): Promise<number> {
  return Number((await client.query(SQL.backendPid)).rows[0].pid);
}

/**
 * One caller: a web client of its own, and the backend that client is, read on it before anything is sent. Whatever
 * the caller sends runs in that backend, so a wait the server reports for that backend is the wait of that call.
 */
interface Caller {
  readonly label: string;
  readonly pid: number;
  send(request: Request): Promise<Outcome>;
  close(): Promise<void>;
}

/**
 * Opens one caller per label, runs the body, and closes every client that was opened: after the body has returned or
 * failed, and so after every call it sent has settled. A failure of the body is kept; failures to close are reported
 * with it, or by themselves when the body succeeded.
 */
async function withCallers<T>(open: (label: string) => Promise<Caller>, labels: readonly string[], body: (callers: readonly Caller[]) => Promise<T>): Promise<T> {
  const callers: Caller[] = [];
  let failed: { readonly error: unknown } | null = null;
  let value: T | undefined;
  try {
    for (const label of labels) callers.push(await open(label));
    value = await body(callers);
  } catch (error) {
    failed = { error };
  }
  const closed = await Promise.allSettled(callers.map((each) => each.close()));
  const closing = closed.flatMap((entry) => (entry.status === "rejected" ? [entry.reason as unknown] : []));
  if (failed !== null) {
    if (closing.length === 0) throw failed.error;
    throw new AggregateError([failed.error, ...closing], `${messageOf(failed.error)}; and ${closing.length} client(s) of the test could not be closed: ${closing.map(messageOf).join("; ")}`);
  }
  if (closing.length > 0) throw new AggregateError(closing, `${closing.length} client(s) of the test could not be closed: ${closing.map(messageOf).join("; ")}`);
  return value as T;
}

/** The backend and the transaction of the holder, read on the holder inside its transaction. */
interface Holder {
  readonly pid: number;
  readonly xid: string;
}

/**
 * Runs the body inside one transaction of the holder and commits it. `submitted` is the list the body adds every
 * call to as it sends it. If the body fails, the holder is rolled back first, which lets every waiting call go; then
 * every submitted call is awaited (each settles: its handlers were attached when it was sent) and how it ended is
 * printed; then the failure of the body is thrown again, with a failed rollback added to it if there was one.
 */
async function holding<T>(client: Admin, submitted: ReadonlyArray<Promise<unknown>>, body: () => Promise<T>): Promise<T> {
  await client.query(SQL.begin);
  let value: T;
  try {
    value = await body();
    await client.query(SQL.commit);
  } catch (error) {
    const cleanup: unknown[] = [];
    try {
      await client.query(SQL.rollback);
    } catch (rollbackFailure) {
      cleanup.push(rollbackFailure);
    }
    const settled = await Promise.allSettled(submitted);
    console.info(`after a failed barrier, the ${settled.length} submitted call(s) ended as: ${JSON.stringify(settled.map((entry) => (entry.status === "fulfilled" ? summaryOf(entry.value) : { rejected: sqlStateOf(entry.reason) })))}`);
    if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], `${messageOf(error)}; and the holder could not be rolled back: ${cleanup.map(messageOf).join("; ")}`);
    throw error;
  }
  return value;
}

/** One backend as the observer saw it: whether it waits on a lock, and the backends the server names as blocking it. */
interface Waiter {
  readonly pid: number;
  readonly role: string;
  readonly lock_wait: boolean;
  readonly blocked_by: number[];
}

interface QueueEvidence {
  /** The backends that waited, as observed twice in a row with the same result. */
  readonly waiters: Waiter[];
  readonly observations: number;
  /** Milliseconds from the first submission to the accepted observation. Reported, never asserted. */
  readonly elapsedMs: number;
}

const edgesOf = (waiter: Waiter): { pid: number; blocked_by: number[] } => ({ pid: waiter.pid, blocked_by: waiter.blocked_by });

/**
 * Decides whether one observation is the lock queue the test set up. It is, when all of these hold:
 *
 *  - every recorded caller is present and waits (the server names at least one backend blocking it);
 *  - the backends that wait are exactly the recorded callers, plus exactly `others` further backends;
 *  - for every backend, "waits on a lock" and "has blockers" agree (they are read separately; a sample in which they
 *    disagree was taken while something moved, and is not accepted);
 *  - every blocker the server names is the holder or another backend that waits in the same observation. A later
 *    waiter may be reported as blocked by an earlier waiter instead of by the holder, or by both: that is accepted;
 *  - followed from any waiter, every chain of blockers ends at the holder: no chain ends anywhere else, and none
 *    comes back to itself.
 *
 * Returns what is wrong, or null.
 */
function queueDefect(rows: readonly Waiter[], holder: Holder, callers: readonly Caller[], others: number): string | null {
  const byPid = new Map<number, Waiter>();
  for (const row of rows) {
    if (byPid.has(row.pid)) return `backend ${row.pid} was reported twice`;
    byPid.set(row.pid, row);
  }
  if (byPid.has(holder.pid)) return `the holder (${holder.pid}) is itself reported as waiting on a lock`;
  for (const each of callers) {
    const row = byPid.get(each.pid);
    if (row === undefined) return `${each.label} (${each.pid}) is not a backend of this database`;
    if (row.blocked_by.length === 0) return `${each.label} (${each.pid}) does not wait`;
  }
  const recorded = new Set(callers.map((each) => each.pid));
  if (recorded.size !== callers.length) return "two recorded callers have the same backend";
  const unrecorded = rows.filter((row) => !recorded.has(row.pid));
  if (unrecorded.length !== others) return `${unrecorded.length} backend(s) other than the recorded callers wait (${unrecorded.map((row) => row.pid).join(", ")}); expected ${others}`;
  for (const row of rows) {
    if (row.lock_wait !== (row.blocked_by.length > 0)) return `backend ${row.pid} was sampled while it moved: waits on a lock ${row.lock_wait}, ${row.blocked_by.length} blocker(s)`;
  }
  const progress = new Map<number, "entered" | "ends at the holder">();
  const follow = (pid: number, path: readonly number[]): string | null => {
    if (pid === holder.pid) return null;
    const row = byPid.get(pid);
    if (row === undefined || row.blocked_by.length === 0) return `the chain ${[...path, pid].join(" > ")} ends at backend ${pid}, which is not the holder and does not wait`;
    const seen = progress.get(pid);
    if (seen === "ends at the holder") return null;
    if (seen === "entered") return `the chain ${[...path, pid].join(" > ")} comes back to itself`;
    progress.set(pid, "entered");
    for (const next of row.blocked_by) {
      const defect = follow(next, [...path, pid]);
      if (defect !== null) return defect;
    }
    progress.set(pid, "ends at the holder");
    return null;
  };
  for (const row of rows) {
    const defect = follow(row.pid, []);
    if (defect !== null) return defect;
  }
  return null;
}

/**
 * The barrier. Observes, through the observer and outside any transaction, until the lock queue is the one the test
 * set up (see `queueDefect`) in two observations in a row that agree with each other, and returns the second. The
 * holder may let go only after this has returned. If the clock runs out first, this throws, and says what the last
 * observation lacked: a missed observation is a failure of the test, never a reason to go on.
 */
async function awaitQueue(observer: Observer, holder: Holder, clock: BarrierClock, callers: readonly Caller[], stage: string, others: number = 0): Promise<QueueEvidence> {
  const pids = callers.map((each) => each.pid);
  const observe = async (): Promise<Waiter[]> =>
    (await observer.query(SQL.observeWaits, [pids])).rows.map((row: { pid: unknown; role: unknown; lock_wait: unknown; blocked_by: unknown[] }) => ({
      pid: Number(row.pid),
      role: String(row.role),
      lock_wait: row.lock_wait === true,
      blocked_by: row.blocked_by.map(Number).sort((left, right) => left - right),
    }));
  const pictureOf = (rows: readonly Waiter[]): string => JSON.stringify(rows.map(edgesOf));
  let observations = 0;
  let lacking = "nothing was observed";
  while (Date.now() < clock.observeUntil) {
    const first = await observe();
    observations += 1;
    lacking = queueDefect(first, holder, callers, others) ?? "";
    if (lacking === "") {
      const second = await observe();
      observations += 1;
      lacking = queueDefect(second, holder, callers, others) ?? (pictureOf(first) === pictureOf(second) ? "" : "two observations in a row disagreed");
      if (lacking === "") return { waiters: second, observations, elapsedMs: Date.now() - clock.startedAt };
    }
    await observer.query(SQL.shortSleep);
  }
  throw new Error(
    `${stage}: the server did not report the expected lock queue within ${clock.observeUntil - clock.startedAt} ms of the first submission ` +
      `(${observations} observations; holder ${holder.pid}; callers ${callers.map((each) => `${each.label}=${each.pid}`).join(", ")}; ${others} other waiter(s) expected; last observation: ${lacking})`,
  );
}

/** How many ungranted transaction-id lock requests a backend has against the holder's transaction. */
async function transactionWaits(observer: Observer, pid: number, xid: string): Promise<number> {
  return (await observer.query(SQL.ungrantedTransactionLocks, [pid, xid])).rows[0].n;
}

/** What the server reported while the calls of `inOrder` were waiting. */
interface ObservedOverlap {
  /** The two results, in the order the calls were forced into. */
  readonly results: [string, string];
  readonly holder: Holder;
  /** The backends of the two callers. */
  readonly first: number;
  readonly second: number;
  /** The queue while only the first call had been sent, and the queue once both had. */
  readonly alone: QueueEvidence;
  readonly both: QueueEvidence;
  /** How many ungranted transaction-id lock requests against the holder's transaction the first call had. */
  readonly firstWaitsOnHolderTransaction: number;
}

/**
 * Forces two mutating calls on the same intent to overlap, in a fixed order, and reports what the server saw. The
 * holder holds the intent row. The first call takes the owner lock and then waits for the intent; only when the
 * server reports that wait, for that caller's backend, is the second sent, and it waits for the owner lock behind
 * the first. Both waits are observed together, each for its own backend, before the holder lets go. The first call
 * then finishes before the second can start its work. Both calls have settled when this returns.
 */
async function inOrder(client: Admin, observer: Observer, firstCaller: Caller, secondCaller: Caller, intent: string, first: Request, second: Request): Promise<ObservedOverlap> {
  const submitted: Array<Promise<Outcome>> = [];
  const observed = await holding(client, submitted, async () => {
    await client.query(SQL.lockIntent, [intent]);
    const holder: Holder = (await client.query(SQL.backendAndTransaction)).rows[0];
    const clock = startClock(OVERLAP_OBSERVATION_MS);
    submitted.push(firstCaller.send(first));
    const alone = await awaitQueue(observer, holder, clock, [firstCaller], `${firstCaller.label} alone`);
    const firstWaitsOnHolderTransaction = await transactionWaits(observer, firstCaller.pid, holder.xid);
    submitted.push(secondCaller.send(second));
    const both = await awaitQueue(observer, holder, clock, [firstCaller, secondCaller], `${firstCaller.label} and ${secondCaller.label}`);
    requireTimeToRelease(clock, `${firstCaller.label} and ${secondCaller.label}`);
    return { holder, alone, both, firstWaitsOnHolderTransaction };
  });
  const outcomes = await Promise.all(submitted);
  return { ...observed, first: firstCaller.pid, second: secondCaller.pid, results: [resultOf(outcomes[0]), resultOf(outcomes[1])] };
}

/**
 * Asserts the overlap `inOrder` forced. While only the first call had been sent, it was the one backend that waited,
 * for the holder alone, on the holder's transaction. Once both had been sent, exactly those two backends waited: the
 * first still for the holder alone, the second for the first alone (it waits for the owner row the first one holds).
 */
function expectOverlap(observed: ObservedOverlap, label: string): void {
  expect(observed.first, label).not.toBe(observed.second);
  expect(observed.alone.waiters.map(edgesOf), label).toEqual([{ pid: observed.first, blocked_by: [observed.holder.pid] }]);
  expect(observed.firstWaitsOnHolderTransaction, label).toBe(1);
  expect([...observed.both.waiters.map(edgesOf)].sort((left, right) => left.pid - right.pid), label).toEqual(
    [
      { pid: observed.first, blocked_by: [observed.holder.pid] },
      { pid: observed.second, blocked_by: [observed.first] },
    ].sort((left, right) => left.pid - right.pid),
  );
}

// ---------------------------------------------------------------------------
// Fixtures and observations of this file
// ---------------------------------------------------------------------------

async function digestOfNonce(client: Admin, nonce: string): Promise<string> {
  return String((await client.query(SQL.nonceDigestOf, [nonce])).rows[0].digest);
}

async function snapshotOf(client: Admin): Promise<Record<string, string>> {
  return (await client.query(SQL.snapshot)).rows[0];
}

/** The tables whose content differs between two snapshots, in name order. */
function changedTables(before: Record<string, string>, after: Record<string, string>): string[] {
  const later = new Map(Object.entries(after));
  return Object.entries(before)
    .filter(([table, content]) => later.get(table) !== content)
    .map(([table]) => table)
    .sort();
}

async function windowOf(client: Admin, owner: string): Promise<{ window_calls: number; window_throttled: number; total_throttled: number } | null> {
  const { rows } = await client.query(SQL.windowRow, [owner]);
  return rows.length === 0 ? null : rows[0];
}

async function auditTypesOf(client: Admin, owner: string): Promise<string[]> {
  return (await client.query(SQL.auditRows, [owner])).rows.map((row) => String(row.event_type));
}

async function intentOf(client: Admin, intent: string): Promise<Row> {
  return (await client.query(SQL.intentRow, [intent])).rows[0];
}

async function challengeOf(client: Admin, challenge: string): Promise<Row> {
  return (await client.query(SQL.challengeRow, [challenge])).rows[0];
}

async function statusesOf(client: Admin, quote: string): Promise<string[]> {
  return (await client.query(SQL.challengesOfQuote, [quote])).rows.map((row) => `${row.id}:${row.status}`);
}

async function transitionsOf(client: Admin, intent: string): Promise<string[]> {
  return (await client.query(SQL.transitionRows, [intent])).rows.map((row) => `${row.event_type}:${row.from_version}>${row.to_version}:${row.entry_point}`);
}

/** A checkout, with what the tests need of its quote. */
interface Started {
  readonly intent: string;
  readonly quote: string;
  readonly quoteDigest: string;
}

/** A checkout started through start_checkout on the web pool. */
async function startedCheckout(client: Admin, pool: Web, credential: Credential): Promise<Started> {
  const started = (await pool.query(SQL.startCheckout, [SESSION_KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, null])).rows[0];
  expect(started.result).toBe("STARTED");
  const quote = (await client.query(SQL.quoteRow, [started.quote_id])).rows[0];
  return { intent: started.intent_id, quote: started.quote_id, quoteDigest: quote.digest };
}

/**
 * A QUOTED checkout written directly by the test owner in one transaction. No function runs, so the owner has no
 * request-window row. `createdAt` decides the quote's expiry, fifteen minutes later.
 */
async function fixtureCheckout(client: Admin, credential: Credential, createdAt: Date = new Date(Date.now() - 60 * 1000)): Promise<Started> {
  const intent = newId("ci");
  const quote = newId("qt");
  const group = newId("pur");
  const created = createdAt.toISOString();
  await client.query(SQL.begin);
  try {
    await client.query(SQL.lockOwner, [credential.owner]);
    await client.query(SQL.insertGroup, [group, credential.owner, created]);
    await client.query(SQL.insertIntent, [intent, credential.owner, group, quote, created]);
    await client.query(SQL.insertQuote, [quote, credential.owner, intent, group, created]);
    await client.query(SQL.insertItem, [quote]);
    await client.query(SQL.insertTransition, [intent, 2, 1, newId("ev"), "QUOTE_ISSUED", "server", "start_checkout", "DRAFT", "QUOTED", created]);
    await client.query(SQL.commit);
  } catch (error) {
    await client.query(SQL.rollback);
    throw error;
  }
  const stored = (await client.query(SQL.quoteRow, [quote])).rows[0];
  return { intent, quote, quoteDigest: stored.digest };
}

/** Moves a QUOTED fixture checkout to CANCELED_LOCAL by direct writes, under the locks of P6. No function runs. */
async function cancelFixtureDirectly(client: Admin, credential: Credential, intent: string): Promise<void> {
  await client.query(SQL.begin);
  try {
    await client.query(SQL.lockOwner, [credential.owner]);
    await client.query(SQL.lockIntent, [intent]);
    await client.query(SQL.cancelIntentDirectly, [intent]);
    await client.query(SQL.insertTransition, [intent, 3, 2, newId("ev"), "SHOPPER_CANCELED", "shopper", "cancel_checkout", "QUOTED", "CANCELED_LOCAL", new Date().toISOString()]);
    await client.query(SQL.commit);
  } catch (error) {
    await client.query(SQL.rollback);
    throw error;
  }
}

/** A challenge, with the nonce that belongs to it. */
interface Challenge {
  readonly challenge: string;
  readonly nonce: string;
  readonly nonceDigest: string;
}

/** An ACTIVE challenge of a quote written directly, issued and expiring at the given intervals from the database clock. */
async function fixtureChallenge(client: Admin, quote: string, keyVersion: number, issued: string = "-10 seconds", expires: string = "200 seconds"): Promise<Challenge> {
  const challenge = newId("cf");
  const nonce = newNonce();
  const nonceDigest = await digestOfNonce(client, nonce);
  await client.query(SQL.insertChallenge, [challenge, nonceDigest, quote, keyVersion, issued, expires]);
  return { challenge, nonce, nonceDigest };
}

/** An ACTIVE challenge issued through issue_challenge on the web pool. */
async function issuedChallenge(client: Admin, pool: Web, credential: Credential, started: Started, keyVersion: number): Promise<Challenge> {
  const challenge = newId("cf");
  const nonce = newNonce();
  const nonceDigest = await digestOfNonce(client, nonce);
  const issued = (await pool.query(SQL.issueChallenge, [SESSION_KEY_VERSION, credential.digest, started.intent, challenge, keyVersion, nonceDigest])).rows[0];
  expect(issued.result).toBe("ISSUED");
  return { challenge, nonce, nonceDigest };
}

const startRequest = (credential: Credential, replaces: string | null): Request => ({ statement: "startCheckout", values: [SESSION_KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, replaces] });
const cancelRequest = (credential: Credential, intent: string): Request => ({ statement: "cancelCheckout", values: [SESSION_KEY_VERSION, credential.digest, intent] });
const issueRequest = (credential: Credential, intent: string, challenge: string, keyVersion: number, nonceDigest: string): Request => ({
  statement: "issueChallenge",
  values: [SESSION_KEY_VERSION, credential.digest, intent, challenge, keyVersion, nonceDigest],
});
const consumeRequest = (credential: Credential, challenge: string, nonce: string, quote: string, quoteDigest: string): Request => ({
  statement: "consumeChallenge",
  values: [SESSION_KEY_VERSION, credential.digest, challenge, nonce, quote, quoteDigest],
});

const tally = (results: readonly string[]): Record<string, number> => {
  const counted = new Map<string, number>();
  for (const result of results) counted.set(result, (counted.get(result) ?? 0) + 1);
  return Object.fromEntries([...counted.entries()].sort(([left], [right]) => left.localeCompare(right)));
};

/**
 * As `holding`, but the holder's transaction is rolled back at the end instead of being committed: for a holder
 * whose own writes must not survive. If the body fails, the same order applies: the holder is rolled back first,
 * every submitted call is awaited and how it ended is printed, and the failure of the body is thrown again.
 */
async function holdingThenUndoing<T>(client: Admin, submitted: ReadonlyArray<Promise<unknown>>, body: () => Promise<T>): Promise<T> {
  await client.query(SQL.begin);
  let value: T;
  try {
    value = await body();
  } catch (error) {
    const cleanup: unknown[] = [];
    try {
      await client.query(SQL.rollback);
    } catch (rollbackFailure) {
      cleanup.push(rollbackFailure);
    }
    const settled = await Promise.allSettled(submitted);
    console.info(`after a failed barrier, the ${settled.length} submitted call(s) ended as: ${JSON.stringify(settled.map((entry) => (entry.status === "fulfilled" ? summaryOf(entry.value) : { rejected: sqlStateOf(entry.reason) })))}`);
    if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], `${messageOf(error)}; and the holder could not be rolled back: ${cleanup.map(messageOf).join("; ")}`);
    throw error;
  }
  await client.query(SQL.rollback);
  return value;
}

// ---------------------------------------------------------------------------
// A call that must still be waiting when a database deadline passes
// ---------------------------------------------------------------------------

// A deadline one second away is used, and the call is submitted only when the server reports at least half of that
// second still left. The pre-call condition may be set up again, at most SETUP_ATTEMPTS times; nothing has been sent
// when it is. Once the call is sent it is never sent again: its wait is observed within SINGLE_WAIT_OBSERVATION_MS,
// the deadline is read until it has passed or DEADLINE_CROSSING_MS is reached, and the holder lets go before
// RELEASE_LIMIT_MS, inside the web role's lock timeout of two seconds, which is not widened here. A barrier that
// fails, a lock timeout, an unexpected result or an error then fails the test.
const SETUP_ATTEMPTS = 5;
const REQUIRED_MARGIN_SECONDS = 0.5;
const ONE_SECOND_FROM_SESSION_EXPIRY = "-86399 seconds";

type Deadline = "session" | "challenge" | "quote" | "window";

/** One setup of a deadline-crossing case: the intent the holder locks, the call, and the deadline it must outwait. */
interface Crossing {
  readonly intent: string;
  readonly request: Request;
  readonly deadline: Deadline;
  /** The session id, the challenge id, the quote id or the owner id whose deadline it is. */
  readonly subject: string;
}

async function marginOf(client: Admin, deadline: Deadline, subject: string): Promise<{ passed: boolean; remaining_seconds: number }> {
  if (deadline === "session") return (await client.query(SQL.sessionMargin, [subject])).rows[0];
  if (deadline === "challenge") return (await client.query(SQL.challengeMargin, [subject])).rows[0];
  if (deadline === "quote") return (await client.query(SQL.quoteMargin, [subject])).rows[0];
  return (await client.query(SQL.windowMargin, [subject])).rows[0];
}

interface WaitEvidence {
  /** How many times the pre-call condition was set up before one setup left enough time to submit. */
  readonly attempts: number;
  /** Seconds the server reported left before the deadline, just before the call was submitted. */
  readonly remainingAtSubmission: number;
  /** How many backends waited for the holder alone while the call waited: the caller, and no other. */
  readonly blockedByHolder: number;
  /** How many ungranted transaction-id lock requests the caller's backend had against the holder's transaction. */
  readonly waitsOnHolderTransaction: number;
  /** Whether database time was still before the deadline while the call was observed waiting. */
  readonly beforeDeadlineWhileBlocked: boolean;
  /** Whether database time was observed at or past the deadline before the holder let go. */
  readonly deadlineReachedBeforeRelease: boolean;
  /** The result code of the call, or "ERROR <sqlstate>". */
  readonly result: string;
  /** The setup the call was made under. */
  readonly crossing: Crossing;
}

/**
 * Sends one call, on the caller's own client, that waits for an intent the holder holds until a database deadline
 * has passed. `setup` prepares the case and may be run again, before anything is sent, while the server reports too
 * little time left. The call is sent once.
 */
async function waitedAcross(client: Admin, observer: Observer, caller: Caller, setup: (attempt: number) => Promise<Crossing>): Promise<WaitEvidence> {
  for (let attempt = 1; attempt <= SETUP_ATTEMPTS; attempt += 1) {
    const crossing = await setup(attempt);
    const submitted: Array<Promise<Outcome>> = [];
    const evidence = await holding(client, submitted, async (): Promise<Omit<WaitEvidence, "result" | "crossing"> | null> => {
      await client.query(SQL.lockIntent, [crossing.intent]);
      const holder: Holder = (await client.query(SQL.backendAndTransaction)).rows[0];
      // The time left is read on the server immediately before submission. Too little: nothing is sent.
      const margin = await marginOf(client, crossing.deadline, crossing.subject);
      if (!(margin.passed === false && margin.remaining_seconds >= REQUIRED_MARGIN_SECONDS)) return null;
      const clock = startClock(SINGLE_WAIT_OBSERVATION_MS);
      submitted.push(caller.send(crossing.request));
      const queue = await awaitQueue(observer, holder, clock, [caller], `${caller.label}, setup ${attempt}`);
      const waitsOnHolderTransaction = await transactionWaits(observer, caller.pid, holder.xid);
      const beforeDeadlineWhileBlocked = (await marginOf(client, crossing.deadline, crossing.subject)).passed === false;
      // Database time is read until it has reached the deadline. Nothing is released before that is observed.
      let reached = false;
      while (!reached && Date.now() - clock.startedAt < DEADLINE_CROSSING_MS) {
        reached = (await marginOf(client, crossing.deadline, crossing.subject)).passed === true;
        if (!reached) await client.query(SQL.shortSleep);
      }
      requireTimeToRelease(clock, `${caller.label}, setup ${attempt}`);
      return {
        attempts: attempt,
        remainingAtSubmission: margin.remaining_seconds,
        blockedByHolder: queue.waiters.filter((waiter) => waiter.blocked_by.length === 1 && waiter.blocked_by.includes(holder.pid)).length,
        waitsOnHolderTransaction,
        beforeDeadlineWhileBlocked,
        deadlineReachedBeforeRelease: reached,
      };
    });
    if (evidence !== null) return { ...evidence, crossing, result: resultOf((await Promise.all(submitted))[0]) };
    // Too little time was left: nothing was sent, and the case is set up again.
  }
  throw new Error(`the pre-call timing condition (${REQUIRED_MARGIN_SECONDS} seconds left on the server) could not be established in ${SETUP_ATTEMPTS} setups; nothing was sent`);
}

/** Asserts the evidence of a forced wait: the call waited on the holder, before the deadline, and was released only after it. */
function expectWaitedAcrossDeadline(evidence: WaitEvidence, label: string): void {
  expect(evidence.remainingAtSubmission, label).toBeGreaterThanOrEqual(REQUIRED_MARGIN_SECONDS);
  expect(evidence.blockedByHolder, label).toBe(1);
  expect(evidence.waitsOnHolderTransaction, label).toBe(1);
  expect(evidence.beforeDeadlineWhileBlocked, label).toBe(true);
  expect(evidence.deadlineReachedBeforeRelease, label).toBe(true);
}

// ---------------------------------------------------------------------------
// Sessions against a confirmation call (PGT-233)
// ---------------------------------------------------------------------------

/**
 * The holder changes the session row in a transaction it has not committed (a rotation to `newDigest`, or a
 * revocation), so it holds the session row. The call, with the credential as it was, is then sent on the caller's
 * own client: it finds the session live at step 0 and waits for the session row at step 2. That wait is observed,
 * for the caller's backend, before the change is committed.
 */
async function whileSessionChanges(
  client: Admin,
  observer: Observer,
  caller: Caller,
  change: "rotation" | "revocation",
  session: string,
  newDigest: string,
  request: Request,
): Promise<{ result: string; blockedByHolder: number; waitsOnHolderTransaction: number }> {
  const submitted: Array<Promise<Outcome>> = [];
  const observed = await holding(client, submitted, async () => {
    if (change === "rotation") await client.query(SQL.rotateSessionDirectly, [session, newDigest]);
    if (change === "revocation") await client.query(SQL.revokeSessionDirectly, [session]);
    const holder: Holder = (await client.query(SQL.backendAndTransaction)).rows[0];
    const clock = startClock(OVERLAP_OBSERVATION_MS);
    submitted.push(caller.send(request));
    const queue = await awaitQueue(observer, holder, clock, [caller], `${caller.label} during the ${change}`);
    const waitsOnHolderTransaction = await transactionWaits(observer, caller.pid, holder.xid);
    requireTimeToRelease(clock, `${caller.label} during the ${change}`);
    return { blockedByHolder: queue.waiters.filter((waiter) => waiter.blocked_by.length === 1 && waiter.blocked_by.includes(holder.pid)).length, waitsOnHolderTransaction };
  });
  return { result: resultOf((await Promise.all(submitted))[0]), ...observed };
}

/**
 * The confirmation call goes first, on its own client: it takes the session row FOR SHARE and waits for the intent,
 * which the holder holds. Only when that wait is observed is the session's change sent, through the reviewed
 * Increment 1 statement, on a second client of its own; it waits for the session row the first call holds. Both
 * waits are observed together, each for its own backend, before the holder lets go.
 */
async function whileCallHoldsSession(
  client: Admin,
  observer: Observer,
  firstCaller: Caller,
  changeCaller: Caller,
  intent: string,
  request: Request,
  changeRequest: Request,
): Promise<{ result: string; changeResult: string; holder: Holder; alone: Array<{ pid: number; blocked_by: number[] }>; waits: Array<{ pid: number; blocked_by: number[] }> }> {
  const submitted: Array<Promise<Outcome>> = [];
  const observed = await holding(client, submitted, async () => {
    await client.query(SQL.lockIntent, [intent]);
    const holder: Holder = (await client.query(SQL.backendAndTransaction)).rows[0];
    const clock = startClock(OVERLAP_OBSERVATION_MS);
    submitted.push(firstCaller.send(request));
    const alone = await awaitQueue(observer, holder, clock, [firstCaller], `${firstCaller.label} alone`);
    submitted.push(changeCaller.send(changeRequest));
    const both = await awaitQueue(observer, holder, clock, [firstCaller, changeCaller], `${firstCaller.label} and ${changeCaller.label}`);
    requireTimeToRelease(clock, `${firstCaller.label} and ${changeCaller.label}`);
    return { holder, alone: alone.waiters.map(edgesOf), waits: both.waiters.map(edgesOf) };
  });
  const outcomes = await Promise.all(submitted);
  return { ...observed, result: resultOf(outcomes[0]), changeResult: resultOf(outcomes[1]) };
}

describe.skipIf(!adminUrl())("Increment 2.2 confirmation functions under concurrency (migration 0009) on a disposable PostgreSQL 17 database", () => {
  let db: DisposableDatabase;
  // The ACTIVE version of the nonce key, or the last one that was ACTIVE. A test that ends a version moves on.
  let activeNonceKey = 1;
  // The operator login, as the server names it on the operator pool.
  let operatorLogin = "";

  beforeAll(async () => {
    db = await openDisposableDatabase();
    const session = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 1, computeKeyCheckValue(TEST_NONCE_KEY, "session")]);
    expect(session.rows[0].result).toBe("ACTIVATED");
    const nonce = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["confirmation_nonce", 1, computeKeyCheckValue(TEST_NONCE_KEY, "confirmation_nonce")]);
    expect(nonce.rows[0].result).toBe("ACTIVATED");
    operatorLogin = String((await db.operator.query(SQL.sessionLogin)).rows[0].login);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  /**
   * Opens one caller: one more client as the web role, with that role's approved timeouts, and the backend it is,
   * read on it. The client is used for nothing but the calls of that caller and is ended by `withCallers`. (A client
   * that is somehow left open is ended by the harness when the database is dropped.)
   */
  const openCaller = async (label: string): Promise<Caller> => {
    const dedicated = await db.connectWeb();
    try {
      const pid = await backendPidOf(dedicated);
      return { label, pid, send: (request) => submit(dedicated, request), close: () => dedicated.end() };
    } catch (error) {
      try {
        await dedicated.end();
      } catch (closing) {
        throw new AggregateError([error, closing], `${messageOf(error)}; and the client could not be closed: ${messageOf(closing)}`);
      }
      throw error;
    }
  };
  /** Activates the next nonce key version and returns the version that was current until now. */
  const activateNextNonceKey = async (): Promise<number> => {
    const previous = activeNonceKey;
    const activated = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["confirmation_nonce", previous + 1, hex(32)]);
    expect(activated.rows[0].result).toBe("ACTIVATED");
    activeNonceKey = previous + 1;
    return previous;
  };
  /** A checkout started through the function, with an ACTIVE challenge issued through the function. */
  const readyToConfirm = async (): Promise<Started & Challenge & { credential: Credential; keyVersion: number }> => {
    const credential = await newCredential(db.admin);
    const started = await startedCheckout(db.admin, db.web, credential);
    const challenge = await issuedChallenge(db.admin, db.web, credential, started, activeNonceKey);
    return { ...started, ...challenge, credential, keyVersion: activeNonceKey };
  };
  /** A directly written checkout with a directly written ACTIVE challenge: no function has run for its owner. */
  const staged = async (issued: string = "-10 seconds", expires: string = "200 seconds", createdAt: Date = new Date(Date.now() - 60 * 1000)): Promise<Started & Challenge & { credential: Credential }> => {
    const credential = await newCredential(db.admin);
    const checkout = await fixtureCheckout(db.admin, credential, createdAt);
    const challenge = await fixtureChallenge(db.admin, checkout.quote, activeNonceKey, issued, expires);
    return { ...checkout, ...challenge, credential };
  };
  /** Nothing is left open or waiting after a forced case. */
  const expectQuiet = async (label: string): Promise<void> => {
    expect((await db.secondAdmin.query(SQL.lockWaits)).rows, label).toEqual([]);
    expect((await db.secondAdmin.query(SQL.openTransactions)).rows[0].n, label).toBe(0);
  };

  it("PGT-15: two submissions of one challenge, forced into an order: the first confirms and the second is CONFIRMATION_ALREADY_USED", async () => {
    const ready = await readyToConfirm();
    const request = consumeRequest(ready.credential, ready.challenge, ready.nonce, ready.quote, ready.quoteDigest);
    const observed = await withCallers(openCaller, ["the first submission", "the second submission"], ([first, second]) => inOrder(db.admin, db.secondAdmin, first, second, ready.intent, request, request));
    expectOverlap(observed, "two submissions");
    expect(observed.results).toEqual(["CONFIRMED", "CONFIRMATION_ALREADY_USED"]);
    expect(await intentOf(db.admin, ready.intent)).toMatchObject({ state: "USER_CONFIRMED", row_version: 3, confirmation_id: ready.challenge, confirmation_status: "CONSUMED" });
    expect(await transitionsOf(db.admin, ready.intent)).toEqual(["QUOTE_ISSUED:1>2:start_checkout", "SHOPPER_CONFIRMED:2>3:consume_challenge"]);
    expect(await auditTypesOf(db.admin, ready.credential.owner)).toEqual(["QUOTE_ISSUED", "CONFIRMATION_ACCEPTED"]);
    expect(await windowOf(db.admin, ready.credential.owner)).toMatchObject({ window_calls: 4, window_throttled: 0 });
    await expectQuiet("PGT-15");
  });

  it("PGT-18: twenty submissions of one challenge at once give one confirmation, nineteen CONFIRMATION_ALREADY_USED, one transition, and no error", async () => {
    const ready = await readyToConfirm();
    const values = [SESSION_KEY_VERSION, ready.credential.digest, ready.challenge, ready.nonce, ready.quote, ready.quoteDigest];
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => tagged(db.web.query(SQL.consumeChallenge, values))));
    expect(tally(outcomes.map(resultOf))).toEqual({ CONFIRMATION_ALREADY_USED: 19, CONFIRMED: 1 });
    expect(outcomes.filter((outcome) => outcome.kind === "returned" && outcome.row.intent_id !== null)).toHaveLength(1);
    expect(await statusesOf(db.admin, ready.quote)).toEqual([`${ready.challenge}:CONSUMED`]);
    expect(await intentOf(db.admin, ready.intent)).toMatchObject({ state: "USER_CONFIRMED", row_version: 3, confirmation_id: ready.challenge });
    expect(await transitionsOf(db.admin, ready.intent)).toHaveLength(2);
    expect(await auditTypesOf(db.admin, ready.credential.owner)).toEqual(["QUOTE_ISSUED", "CONFIRMATION_ACCEPTED"]);
    // Every one of the twenty was admitted and counted: 1 start, 1 issue, 20 submissions.
    expect(await windowOf(db.admin, ready.credential.owner)).toEqual({ window_calls: 22, window_throttled: 0, total_throttled: 0 });
  });

  it("PGT-19: issue against consume, in both forced orders: never two ACTIVE challenges and never two CONSUMED ones", async () => {
    // Consume first, then issue.
    const consumeFirst = await readyToConfirm();
    const afterConsume = await withCallers(openCaller, ["the confirmation", "the issue"], async ([first, second]) =>
      inOrder(
        db.admin,
        db.secondAdmin,
        first,
        second,
        consumeFirst.intent,
        consumeRequest(consumeFirst.credential, consumeFirst.challenge, consumeFirst.nonce, consumeFirst.quote, consumeFirst.quoteDigest),
        issueRequest(consumeFirst.credential, consumeFirst.intent, newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce())),
      ),
    );
    expectOverlap(afterConsume, "consume, then issue");
    expect(afterConsume.results).toEqual(["CONFIRMED", "INTENT_NOT_AWAITING_CONFIRMATION"]);
    expect(await statusesOf(db.admin, consumeFirst.quote)).toEqual([`${consumeFirst.challenge}:CONSUMED`]);
    expect(await auditTypesOf(db.admin, consumeFirst.credential.owner)).toEqual(["QUOTE_ISSUED", "CONFIRMATION_ACCEPTED"]);
    expect(await windowOf(db.admin, consumeFirst.credential.owner)).toMatchObject({ window_calls: 4 });

    // Issue first, with a challenge that can be reused; then consume.
    const reuseFirst = await readyToConfirm();
    const afterReuse = await withCallers(openCaller, ["the issue", "the confirmation"], async ([first, second]) =>
      inOrder(
        db.admin,
        db.secondAdmin,
        first,
        second,
        reuseFirst.intent,
        issueRequest(reuseFirst.credential, reuseFirst.intent, newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce())),
        consumeRequest(reuseFirst.credential, reuseFirst.challenge, reuseFirst.nonce, reuseFirst.quote, reuseFirst.quoteDigest),
      ),
    );
    expectOverlap(afterReuse, "issue (reused), then consume");
    expect(afterReuse.results).toEqual(["REUSED", "CONFIRMED"]);
    expect(await statusesOf(db.admin, reuseFirst.quote)).toEqual([`${reuseFirst.challenge}:CONSUMED`]);

    // Issue first, where the existing challenge is under an older key version and so is not reused; then consume of
    // the older challenge.
    const olderFirst = await readyToConfirm();
    await activateNextNonceKey();
    const replacement = newId("cf");
    const afterReplacement = await withCallers(openCaller, ["the issue", "the confirmation"], async ([first, second]) =>
      inOrder(
        db.admin,
        db.secondAdmin,
        first,
        second,
        olderFirst.intent,
        issueRequest(olderFirst.credential, olderFirst.intent, replacement, activeNonceKey, await digestOfNonce(db.admin, newNonce())),
        consumeRequest(olderFirst.credential, olderFirst.challenge, olderFirst.nonce, olderFirst.quote, olderFirst.quoteDigest),
      ),
    );
    expectOverlap(afterReplacement, "issue (new), then consume of the old one");
    expect(afterReplacement.results).toEqual(["ISSUED", "CONFIRMATION_SUPERSEDED"]);
    expect(await statusesOf(db.admin, olderFirst.quote)).toEqual([`${olderFirst.challenge}:SUPERSEDED`, `${replacement}:ACTIVE`]);
    expect(await intentOf(db.admin, olderFirst.intent)).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
    expect(await auditTypesOf(db.admin, olderFirst.credential.owner)).toEqual(["QUOTE_ISSUED"]);
    await expectQuiet("PGT-19");
  });

  it("PGT-230: confirm against cancel, in both forced orders", async () => {
    // Confirm first, then cancel: cancellation of a confirmed checkout succeeds and keeps the confirmation pointer.
    const confirmFirst = await readyToConfirm();
    const windowBefore = (await windowOf(db.admin, confirmFirst.credential.owner))?.window_calls ?? 0;
    const afterConfirm = await withCallers(openCaller, ["the confirmation", "the cancellation"], ([first, second]) =>
      inOrder(
        db.admin,
        db.secondAdmin,
        first,
        second,
        confirmFirst.intent,
        consumeRequest(confirmFirst.credential, confirmFirst.challenge, confirmFirst.nonce, confirmFirst.quote, confirmFirst.quoteDigest),
        cancelRequest(confirmFirst.credential, confirmFirst.intent),
      ),
    );
    expectOverlap(afterConfirm, "confirm, then cancel");
    expect(afterConfirm.results).toEqual(["CONFIRMED", "CANCELED"]);
    expect((await windowOf(db.admin, confirmFirst.credential.owner))?.window_calls).toBe(windowBefore + 2);
    expect(await transitionsOf(db.admin, confirmFirst.intent)).toEqual(["QUOTE_ISSUED:1>2:start_checkout", "SHOPPER_CONFIRMED:2>3:consume_challenge", "SHOPPER_CANCELED:3>4:cancel_checkout"]);
    expect(await auditTypesOf(db.admin, confirmFirst.credential.owner)).toEqual(["QUOTE_ISSUED", "CONFIRMATION_ACCEPTED", "CHECKOUT_CANCELED"]);
    expect(await intentOf(db.admin, confirmFirst.intent)).toMatchObject({ state: "CANCELED_LOCAL", row_version: 4, confirmation_id: confirmFirst.challenge, confirmation_status: "CONSUMED" });
    expect(await challengeOf(db.admin, confirmFirst.challenge)).toMatchObject({ status: "CONSUMED" });

    // Cancel first, then consume: the challenge stays ACTIVE and is unusable.
    const cancelFirst = await readyToConfirm();
    const cancelWindowBefore = (await windowOf(db.admin, cancelFirst.credential.owner))?.window_calls ?? 0;
    const afterCancel = await withCallers(openCaller, ["the cancellation", "the confirmation"], ([first, second]) =>
      inOrder(
        db.admin,
        db.secondAdmin,
        first,
        second,
        cancelFirst.intent,
        cancelRequest(cancelFirst.credential, cancelFirst.intent),
        consumeRequest(cancelFirst.credential, cancelFirst.challenge, cancelFirst.nonce, cancelFirst.quote, cancelFirst.quoteDigest),
      ),
    );
    expectOverlap(afterCancel, "cancel, then confirm");
    expect(afterCancel.results).toEqual(["CANCELED", "INTENT_NOT_AWAITING_CONFIRMATION"]);
    expect((await windowOf(db.admin, cancelFirst.credential.owner))?.window_calls).toBe(cancelWindowBefore + 2);
    expect(await transitionsOf(db.admin, cancelFirst.intent)).toEqual(["QUOTE_ISSUED:1>2:start_checkout", "SHOPPER_CANCELED:2>3:cancel_checkout"]);
    expect(await auditTypesOf(db.admin, cancelFirst.credential.owner)).toEqual(["QUOTE_ISSUED", "CHECKOUT_CANCELED"]);
    expect(await intentOf(db.admin, cancelFirst.intent)).toMatchObject({ state: "CANCELED_LOCAL", row_version: 3, confirmation_id: null, confirmation_status: null });
    expect(await challengeOf(db.admin, cancelFirst.challenge)).toMatchObject({ status: "ACTIVE", consumed_at: null });
    await expectQuiet("PGT-230");
  });

  it("PGT-231: confirm against replace, in both forced orders", async () => {
    // Confirm first, then replace: a confirmed predecessor is replaced and keeps its confirmation pointer.
    const confirmFirst = await readyToConfirm();
    const windowBefore = (await windowOf(db.admin, confirmFirst.credential.owner))?.window_calls ?? 0;
    const afterConfirm = await withCallers(openCaller, ["the confirmation", "the replacement"], ([first, second]) =>
      inOrder(
        db.admin,
        db.secondAdmin,
        first,
        second,
        confirmFirst.intent,
        consumeRequest(confirmFirst.credential, confirmFirst.challenge, confirmFirst.nonce, confirmFirst.quote, confirmFirst.quoteDigest),
        startRequest(confirmFirst.credential, confirmFirst.intent),
      ),
    );
    expectOverlap(afterConfirm, "confirm, then replace");
    expect(afterConfirm.results).toEqual(["CONFIRMED", "STARTED"]);
    expect((await windowOf(db.admin, confirmFirst.credential.owner))?.window_calls).toBe(windowBefore + 2);
    const successorOfConfirmed = (await db.admin.query(SQL.successorsOf, [confirmFirst.intent])).rows;
    expect(successorOfConfirmed).toHaveLength(1);
    expect(await transitionsOf(db.admin, confirmFirst.intent)).toEqual(["QUOTE_ISSUED:1>2:start_checkout", "SHOPPER_CONFIRMED:2>3:consume_challenge", "SUPERSEDED:3>4:start_checkout"]);
    expect(await transitionsOf(db.admin, successorOfConfirmed[0].id)).toEqual(["QUOTE_ISSUED:1>2:start_checkout"]);
    expect((await auditTypesOf(db.admin, confirmFirst.credential.owner)).sort()).toEqual(["CHECKOUT_SUPERSEDED", "CONFIRMATION_ACCEPTED", "QUOTE_ISSUED", "QUOTE_ISSUED"]);
    expect(await intentOf(db.admin, confirmFirst.intent)).toMatchObject({ state: "SUPERSEDED", row_version: 4, confirmation_id: confirmFirst.challenge, confirmation_status: "CONSUMED", superseded_by_intent_id: successorOfConfirmed[0].id });
    expect(await challengeOf(db.admin, confirmFirst.challenge)).toMatchObject({ status: "CONSUMED" });
    const successorRow = await intentOf(db.admin, successorOfConfirmed[0].id);
    expect(successorRow).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null, confirmation_status: null, replaces_intent_id: confirmFirst.intent });
    expect(await statusesOf(db.admin, String(successorRow.current_quote_id))).toEqual([]);

    // Replace first, then consume of the predecessor's challenge.
    const replaceFirst = await readyToConfirm();
    const replaceWindowBefore = (await windowOf(db.admin, replaceFirst.credential.owner))?.window_calls ?? 0;
    const afterReplace = await withCallers(openCaller, ["the replacement", "the confirmation"], ([first, second]) =>
      inOrder(
        db.admin,
        db.secondAdmin,
        first,
        second,
        replaceFirst.intent,
        startRequest(replaceFirst.credential, replaceFirst.intent),
        consumeRequest(replaceFirst.credential, replaceFirst.challenge, replaceFirst.nonce, replaceFirst.quote, replaceFirst.quoteDigest),
      ),
    );
    expectOverlap(afterReplace, "replace, then confirm");
    expect(afterReplace.results).toEqual(["STARTED", "INTENT_NOT_AWAITING_CONFIRMATION"]);
    expect((await windowOf(db.admin, replaceFirst.credential.owner))?.window_calls).toBe(replaceWindowBefore + 2);
    const successorOfReplaced = (await db.admin.query(SQL.successorsOf, [replaceFirst.intent])).rows;
    expect(successorOfReplaced).toHaveLength(1);
    expect(await transitionsOf(db.admin, replaceFirst.intent)).toEqual(["QUOTE_ISSUED:1>2:start_checkout", "SUPERSEDED:2>3:start_checkout"]);
    expect(await transitionsOf(db.admin, successorOfReplaced[0].id)).toEqual(["QUOTE_ISSUED:1>2:start_checkout"]);
    expect((await auditTypesOf(db.admin, replaceFirst.credential.owner)).sort()).toEqual(["CHECKOUT_SUPERSEDED", "QUOTE_ISSUED", "QUOTE_ISSUED"]);
    expect(await intentOf(db.admin, replaceFirst.intent)).toMatchObject({ state: "SUPERSEDED", row_version: 3, confirmation_id: null, confirmation_status: null, superseded_by_intent_id: successorOfReplaced[0].id });
    expect(await challengeOf(db.admin, replaceFirst.challenge)).toMatchObject({ status: "ACTIVE", consumed_at: null });
    expect(await intentOf(db.admin, successorOfReplaced[0].id)).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
    await expectQuiet("PGT-231");
  });

  it("PGT-209 and PGT-207R (locks): a foreign intent, a foreign challenge and a foreign challenge's nonce key are never locked: the call returns while another connection holds them", async () => {
    const foreign = await readyToConfirm();
    const labels = ["issue, under the limit", "issue, over the limit", "case 1: missing, under", "case 2: missing, over", "case 3: foreign, under", "case 4: foreign, over"];
    await withCallers(openCaller, labels, async (callers) => {
      // One owner per caller; every second one already has a full request window.
      const credentials: Credential[] = [];
      for (const [index] of callers.entries()) {
        const credential = await newCredential(db.admin);
        if (index % 2 === 1) await db.admin.query(SQL.insertWindow, [credential.owner, "-5 seconds", 30]);
        credentials.push(credential);
      }
      const windowsBefore = await Promise.all(credentials.map((credential) => windowOf(db.admin, credential.owner)));
      const snapshotBefore = await snapshotOf(db.admin);
      const missing = newId("cf");
      const requests: Request[] = [
        // The issue calls name a nonce key version that does not exist, so that they have no key row of their own
        // to lock: the holder below holds the row of the foreign challenge's key, which is the ACTIVE one.
        issueRequest(credentials[0], foreign.intent, newId("cf"), 30000, hex(32)),
        issueRequest(credentials[1], foreign.intent, newId("cf"), 30000, hex(32)),
        consumeRequest(credentials[2], missing, foreign.nonce, foreign.quote, foreign.quoteDigest),
        consumeRequest(credentials[3], missing, foreign.nonce, foreign.quote, foreign.quoteDigest),
        consumeRequest(credentials[4], foreign.challenge, foreign.nonce, foreign.quote, foreign.quoteDigest),
        consumeRequest(credentials[5], foreign.challenge, foreign.nonce, foreign.quote, foreign.quoteDigest),
      ];
      const submitted: Array<Promise<Outcome>> = [];
      const results = await holdingThenUndoing(db.admin, submitted, async () => {
        // The holder holds the foreign intent, the foreign challenge, and that challenge's nonce key row in a mode
        // that conflicts with the share lock a confirmation call takes on a key. A call that tried to lock any of
        // them would wait, and would end as a lock timeout.
        await db.admin.query(SQL.lockIntent, [foreign.intent]);
        await db.admin.query(SQL.lockChallenge, [foreign.challenge]);
        await db.admin.query(SQL.lockNonceKey, [foreign.keyVersion]);
        const settled: string[] = [];
        for (const [index, caller] of callers.entries()) {
          const request = requests.at(index);
          if (request === undefined) throw new Error(`no request for ${caller.label}`);
          const pending = caller.send(request);
          submitted.push(pending);
          // Awaited while the holder still holds all three rows.
          settled.push(resultOf(await pending));
          expect((await db.secondAdmin.query(SQL.lockWaits)).rows, caller.label).toEqual([]);
        }
        return settled;
      });
      expect(results).toEqual(["NOT_AUTHORIZED", "RATE_LIMITED", "CONFIRMATION_NOT_FOUND", "CONFIRMATION_NOT_FOUND", "CONFIRMATION_NOT_FOUND", "CONFIRMATION_NOT_FOUND"]);
      const windowsAfter = await Promise.all(credentials.map((credential) => windowOf(db.admin, credential.owner)));
      // PGT-207R: none of the four consume calls is counted, throttled or audited, under the limit or over it.
      expect(windowsAfter.slice(2)).toEqual(windowsBefore.slice(2));
      expect(windowsAfter.slice(2)).toEqual([null, { window_calls: 30, window_throttled: 0, total_throttled: 0 }, null, { window_calls: 30, window_throttled: 0, total_throttled: 0 }]);
      for (const credential of credentials.slice(2)) expect(await auditTypesOf(db.admin, credential.owner), credential.owner).toEqual([]);
      // PGT-209: the issue for a foreign intent writes nothing under the limit and is throttled over it.
      expect(windowsAfter.slice(0, 2)).toEqual([null, { window_calls: 30, window_throttled: 1, total_throttled: 1 }]);
      expect(await auditTypesOf(db.admin, credentials[0].owner)).toEqual([]);
      expect(await auditTypesOf(db.admin, credentials[1].owner)).toEqual(["OWNER_RATE_LIMITED"]);
      expect(changedTables(snapshotBefore, await snapshotOf(db.admin))).toEqual(["audit_events", "owner_request_windows"]);
    });
    expect(await challengeOf(db.admin, foreign.challenge)).toMatchObject({ status: "ACTIVE" });
    expect(await statusesOf(db.admin, foreign.quote)).toEqual([`${foreign.challenge}:ACTIVE`]);
    await expectQuiet("PGT-209 and PGT-207R");
  });

  it("PGT-208: a challenge that becomes visible only after the call's first lookup is still CONFIRMATION_NOT_FOUND, and its nonce key is never locked late", async () => {
    const credential = await newCredential(db.admin);
    const checkout = await fixtureCheckout(db.admin, credential);
    const challenge = newId("cf");
    const nonce = newNonce();
    const nonceDigest = await digestOfNonce(db.admin, nonce);
    let observerHoldsTheKey = false;
    try {
      await withCallers(openCaller, ["the confirmation"], async ([caller]) => {
        const submitted: Array<Promise<Outcome>> = [];
        const before = await snapshotOf(db.admin);
        await holding(db.admin, submitted, async () => {
          // The holder writes the caller's own challenge and does not commit it, and holds the caller's owner row.
          await db.admin.query(SQL.insertChallenge, [challenge, nonceDigest, checkout.quote, activeNonceKey, "-10 seconds", "200 seconds"]);
          await db.admin.query(SQL.lockOwner, [credential.owner]);
          const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
          const clock = startClock(OVERLAP_OBSERVATION_MS);
          // The call's lookup at step 0d cannot see the challenge, so it locks no key row. It takes its session row
          // and then waits for its owner row: observed, for its backend, behind the holder alone.
          submitted.push(caller.send(consumeRequest(credential, challenge, nonce, checkout.quote, checkout.quoteDigest)));
          const queue = await awaitQueue(db.secondAdmin, holder, clock, [caller], caller.label);
          expect(queue.waiters.map(edgesOf)).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
          expect(await transactionWaits(db.secondAdmin, caller.pid, holder.xid)).toBe(1);
          // Now the observer's connection takes the nonce key row of that challenge, in a mode that conflicts with
          // the share lock a confirmation call takes on a key, and keeps it past the holder's commit.
          await db.secondAdmin.query(SQL.begin);
          observerHoldsTheKey = true;
          await db.secondAdmin.query(SQL.lockNonceKey, [activeNonceKey]);
          requireTimeToRelease(clock, caller.label);
          // The holder commits: the challenge becomes visible, and the owner row is free.
        });
        // The call returns while the key row is still held by the observer's connection: it did not ask for it.
        const outcome = (await Promise.all(submitted))[0];
        expect(resultOf(outcome)).toBe("CONFIRMATION_NOT_FOUND");
        expect(outcome.kind === "returned" ? outcome.row.intent_id : "raised").toBeNull();
        // The call wrote nothing: the only change is the challenge the holder committed.
        expect(changedTables(before, await snapshotOf(db.admin))).toEqual(["confirmation_challenges"]);
        expect(await windowOf(db.admin, credential.owner)).toBeNull();
        expect(await auditTypesOf(db.admin, credential.owner)).toEqual([]);
      });
    } finally {
      // Cleanup on the same connection that took the key lock.
      if (observerHoldsTheKey) await db.secondAdmin.query(SQL.rollback);
    }
    // The challenge is there and is good: the same submission, sent again as a new call, confirms.
    expect(await challengeOf(db.admin, challenge)).toMatchObject({ status: "ACTIVE", checkout_intent_id: checkout.intent });
    expect((await db.web.query(SQL.consumeChallenge, [SESSION_KEY_VERSION, credential.digest, challenge, nonce, checkout.quote, checkout.quoteDigest])).rows).toEqual([{ result: "CONFIRMED", intent_id: checkout.intent }]);
    await expectQuiet("PGT-208");
  });

  it("PGT-215 (c): a challenge id that comes to exist while the call runs, inserted by another owner's call, is REFUSED: counted, and the caller's previous challenge is left exactly as it was", async () => {
    // Owner A is the holder's own call, inside the holder's transaction. Owner B is the caller. B has an ACTIVE
    // challenge with too little time left to be reused, so B's call has to end it and insert a new one.
    for (const ending of ["the other insert is committed", "the other insert is undone"] as const) {
      const ownerA = await newCredential(db.admin);
      const checkoutA = await fixtureCheckout(db.admin, ownerA);
      const ownerB = await newCredential(db.admin);
      const checkoutB = await fixtureCheckout(db.admin, ownerB);
      const previous = await fixtureChallenge(db.admin, checkoutB.quote, activeNonceKey, "-270 seconds", "30 seconds");
      const previousBefore = await challengeOf(db.admin, previous.challenge);
      const contested = newId("cf");
      const digestA = await digestOfNonce(db.admin, newNonce());
      const digestB = await digestOfNonce(db.admin, newNonce());
      const outcome = await withCallers(openCaller, [`owner B, when ${ending}`], async ([caller]) => {
        const submitted: Array<Promise<Outcome>> = [];
        const body = async (): Promise<void> => {
          // Owner A's call, by the holder, not committed: the row with the contested id exists for the holder alone.
          expect((await db.admin.query(SQL.issueChallenge, [SESSION_KEY_VERSION, ownerA.digest, checkoutA.intent, contested, activeNonceKey, digestA])).rows[0]).toMatchObject({ result: "ISSUED", challenge_id: contested });
          const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
          const clock = startClock(OVERLAP_OBSERVATION_MS);
          // Owner B's call cannot see that row at its lookup. Its insert of the same id then waits for the holder's
          // transaction: observed, for its backend, behind the holder alone and on the holder's transaction.
          submitted.push(caller.send(issueRequest(ownerB, checkoutB.intent, contested, activeNonceKey, digestB)));
          const queue = await awaitQueue(db.secondAdmin, holder, clock, [caller], caller.label);
          expect(queue.waiters.map(edgesOf)).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
          expect(await transactionWaits(db.secondAdmin, caller.pid, holder.xid)).toBe(1);
          requireTimeToRelease(clock, caller.label);
        };
        if (ending === "the other insert is committed") await holding(db.admin, submitted, body);
        else await holdingThenUndoing(db.admin, submitted, body);
        return (await Promise.all(submitted))[0];
      });
      if (ending === "the other insert is committed") {
        // The collision exists only at the insert: the one handler of the function answers it.
        expect(resultOf(outcome), ending).toBe("REFUSED");
        expect(outcome.kind === "returned" ? outcome.row : null, ending).toEqual({ result: "REFUSED", challenge_id: null, quote_digest: null, nonce_key_version: null, nonce_digest: null, summary: null, expires_at: null });
        // Counted, and nothing else: the previous challenge is exactly as it was, and no audit row is written.
        expect(await windowOf(db.admin, ownerB.owner), ending).toEqual({ window_calls: 1, window_throttled: 0, total_throttled: 0 });
        expect(await challengeOf(db.admin, previous.challenge), ending).toEqual(previousBefore);
        expect(await statusesOf(db.admin, checkoutB.quote), ending).toEqual([`${previous.challenge}:ACTIVE`]);
        expect(await auditTypesOf(db.admin, ownerB.owner), ending).toEqual([]);
        // The contested id exists once, and belongs to owner A.
        expect(await challengeOf(db.admin, contested), ending).toMatchObject({ owner_id: ownerA.owner, checkout_intent_id: checkoutA.intent, nonce_digest: digestA, status: "ACTIVE" });
      } else {
        // The control: the other insert never came to exist, so the same call of owner B is served.
        expect(resultOf(outcome), ending).toBe("ISSUED");
        expect(await windowOf(db.admin, ownerB.owner), ending).toEqual({ window_calls: 1, window_throttled: 0, total_throttled: 0 });
        expect(await statusesOf(db.admin, checkoutB.quote), ending).toEqual([`${previous.challenge}:SUPERSEDED`, `${contested}:ACTIVE`]);
        expect(await challengeOf(db.admin, contested), ending).toMatchObject({ owner_id: ownerB.owner, checkout_intent_id: checkoutB.intent, nonce_digest: digestB, status: "ACTIVE" });
        expect(await statusesOf(db.admin, checkoutA.quote), ending).toEqual([]);
        expect(await windowOf(db.admin, ownerA.owner), ending).toBeNull();
      }
    }
    await expectQuiet("PGT-215 (c)");
  });

  it("PGT-143 (2.2): issue_challenge and consume_challenge that wait on the intent until the session has expired are NOT_AUTHORIZED, and change nothing, with and without a request-window row", async () => {
    for (const target of ["issue_challenge", "consume_challenge"] as const) {
      for (const window of ["absent", "present"] as const) {
        const label = `${target}, request window ${window}`;
        const fixture = await staged();
        if (window === "present") await db.admin.query(SQL.insertWindow, [fixture.credential.owner, "-5 seconds", 3]);
        let before: Record<string, string> = {};
        const observed = await withCallers(openCaller, [`the ${target} call`], ([caller]) =>
          waitedAcross(db.admin, db.secondAdmin, caller, async () => {
            // A session of the same owner that has one second left. Set up again if too little of it remains.
            const expiring = await newCredential(db.admin, ONE_SECOND_FROM_SESSION_EXPIRY, fixture.credential.owner);
            before = await snapshotOf(db.admin);
            const request =
              target === "issue_challenge"
                ? issueRequest(expiring, fixture.intent, newId("cf"), activeNonceKey, hex(32))
                : consumeRequest(expiring, fixture.challenge, fixture.nonce, fixture.quote, fixture.quoteDigest);
            return { intent: fixture.intent, request, deadline: "session", subject: expiring.session };
          }),
        );
        console.info(`PGT-143 (2.2), ${label}, as observed: ${JSON.stringify({ ...observed, crossing: undefined })}`);
        expectWaitedAcrossDeadline(observed, label);
        expect(observed.result, label).toBe("NOT_AUTHORIZED");
        // No side effects: not one row of any table changed after the call was set up: no counter, no challenge,
        // no intent, no transition, no audit row, no session row.
        expect(await snapshotOf(db.admin), label).toEqual(before);
        expect(await windowOf(db.admin, fixture.credential.owner), label).toEqual(window === "absent" ? null : { window_calls: 3, window_throttled: 0, total_throttled: 0 });
        expect(await challengeOf(db.admin, fixture.challenge), label).toMatchObject({ status: "ACTIVE" });
        expect(await intentOf(db.admin, fixture.intent), label).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
      }
    }
    await expectQuiet("PGT-143 (2.2)");
  });

  it("PGT-54c: a confirmation that waits past its challenge's expiry is CONFIRMATION_EXPIRED, and the challenge is marked EXPIRED", async () => {
    const setups: Array<Awaited<ReturnType<typeof staged>>> = [];
    const observed = await withCallers(openCaller, ["the confirmation"], ([caller]) =>
      waitedAcross(db.admin, db.secondAdmin, caller, async () => {
        // A challenge with one second left. Set up again, for a new owner, if too little of it remains.
        const current = await staged("-299 seconds", "1 second");
        setups.push(current);
        return { intent: current.intent, request: consumeRequest(current.credential, current.challenge, current.nonce, current.quote, current.quoteDigest), deadline: "challenge", subject: current.challenge };
      }),
    );
    console.info(`PGT-54c as observed: ${JSON.stringify({ ...observed, crossing: undefined })}`);
    const used = setups.at(-1);
    if (used === undefined) throw new Error("the case was not set up");
    expectWaitedAcrossDeadline(observed, "PGT-54c");
    expect(observed.result).toBe("CONFIRMATION_EXPIRED");
    const marked = await challengeOf(db.admin, used.challenge);
    expect(marked).toMatchObject({ status: "EXPIRED", consumed_at: null, superseded_at: null });
    expect(marked.expired_marked_at).toBeInstanceOf(Date);
    expect(await statusesOf(db.admin, used.quote)).toEqual([`${used.challenge}:EXPIRED`]);
    expect(await windowOf(db.admin, used.credential.owner)).toEqual({ window_calls: 1, window_throttled: 0, total_throttled: 0 });
    expect(await auditTypesOf(db.admin, used.credential.owner)).toEqual([]);
    expect(await intentOf(db.admin, used.intent)).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
    expect(await transitionsOf(db.admin, used.intent)).toHaveLength(1);
    await expectQuiet("PGT-54c");
  });

  it("PGT-54g: an issue that waits past its quote's expiry is QUOTE_EXPIRED: no new challenge, and the existing ACTIVE one is not marked", async () => {
    const setups: Array<Awaited<ReturnType<typeof staged>>> = [];
    let existingBefore: Row = {};
    const observed = await withCallers(openCaller, ["the issue"], ([caller]) =>
      waitedAcross(db.admin, db.secondAdmin, caller, async () => {
        // A quote with one second left (made 14 minutes and 59 seconds ago), whose ACTIVE challenge, a fixture that
        // outlives it, has too little time left to be reused. Set up again if too little of the quote remains.
        const current = await staged("-270 seconds", "30 seconds", new Date(Date.now() - 899 * 1000));
        setups.push(current);
        existingBefore = await challengeOf(db.admin, current.challenge);
        return { intent: current.intent, request: issueRequest(current.credential, current.intent, newId("cf"), activeNonceKey, hex(32)), deadline: "quote", subject: current.quote };
      }),
    );
    console.info(`PGT-54g as observed: ${JSON.stringify({ ...observed, crossing: undefined })}`);
    const used = setups.at(-1);
    if (used === undefined) throw new Error("the case was not set up");
    expectWaitedAcrossDeadline(observed, "PGT-54g");
    expect(observed.result).toBe("QUOTE_EXPIRED");
    expect(await statusesOf(db.admin, used.quote)).toEqual([`${used.challenge}:ACTIVE`]);
    expect(await challengeOf(db.admin, used.challenge)).toEqual(existingBefore);
    expect(await windowOf(db.admin, used.credential.owner)).toEqual({ window_calls: 1, window_throttled: 0, total_throttled: 0 });
    expect(await auditTypesOf(db.admin, used.credential.owner)).toEqual([]);
    await expectQuiet("PGT-54g");
  });

  it("PGT-218 (b): a material change of the catalog committed while issue_challenge or consume_challenge waits makes the call QUOTE_STALE_CATALOG", async () => {
    const original = (await db.admin.query(SQL.variantAmount, [VARIANT])).rows[0].unit_amount_cents;
    expect(original).toBe(UNIT_AMOUNT);
    try {
      for (const target of ["issue_challenge", "consume_challenge"] as const) {
        const ready = await readyToConfirm();
        // The same fixture serves both: for the issue, the catalog is looked at before the existing challenge is
        // considered for reuse.
        const before = await snapshotOf(db.admin);
        const outcome = await withCallers(openCaller, [`the ${target} call`], async ([caller]) => {
          const submitted: Array<Promise<Outcome>> = [];
          await holding(db.admin, submitted, async () => {
            await db.admin.query(SQL.lockIntent, [ready.intent]);
            const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
            const clock = startClock(OVERLAP_OBSERVATION_MS);
            submitted.push(
              caller.send(
                target === "issue_challenge"
                  ? issueRequest(ready.credential, ready.intent, newId("cf"), activeNonceKey, hex(32))
                  : consumeRequest(ready.credential, ready.challenge, ready.nonce, ready.quote, ready.quoteDigest),
              ),
            );
            const queue = await awaitQueue(db.secondAdmin, holder, clock, [caller], caller.label);
            expect(queue.waiters.map(edgesOf), target).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
            // Only now the change, in the holder's transaction. One COMMIT commits it and releases the intent.
            await db.admin.query(SQL.setVariantAmount, [VARIANT, UNIT_AMOUNT + 1]);
            const still = await awaitQueue(db.secondAdmin, holder, clock, [caller], `${caller.label}, after the uncommitted change`);
            expect(still.waiters.map(edgesOf), target).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
            requireTimeToRelease(clock, caller.label);
          });
          return (await Promise.all(submitted))[0];
        });
        await db.admin.query(SQL.setVariantAmount, [VARIANT, original]);
        expect(resultOf(outcome), target).toBe("QUOTE_STALE_CATALOG");
        // Counted, and nothing else of the checkout changed.
        expect(changedTables(before, await snapshotOf(db.admin)), target).toEqual(["owner_request_windows"]);
        expect(await statusesOf(db.admin, ready.quote), target).toEqual([`${ready.challenge}:ACTIVE`]);
        expect(await intentOf(db.admin, ready.intent), target).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
        expect(await auditTypesOf(db.admin, ready.credential.owner), target).toEqual(["QUOTE_ISSUED"]);
        // With the catalog as it was, the same checkout confirms.
        expect((await db.web.query(SQL.consumeChallenge, [SESSION_KEY_VERSION, ready.credential.digest, ready.challenge, ready.nonce, ready.quote, ready.quoteDigest])).rows).toEqual([{ result: "CONFIRMED", intent_id: ready.intent }]);
      }
    } finally {
      await db.admin.query(SQL.setVariantAmount, [VARIANT, original]);
    }
    await expectQuiet("PGT-218 (b)");
  });

  it("PGT-233: a session rotation or revocation that holds the session row makes a waiting issue or consume NOT_AUTHORIZED with no side effects; one that comes after the call waits for it", async () => {
    // The change first: the call waits for the session row and is then refused.
    for (const target of ["issue_challenge", "consume_challenge"] as const) {
      for (const change of ["rotation", "revocation"] as const) {
        const label = `${target} during a ${change}`;
        const ready = await readyToConfirm();
        const newDigest = hex(32);
        const before = await snapshotOf(db.admin);
        const request =
          target === "issue_challenge"
            ? issueRequest(ready.credential, ready.intent, newId("cf"), activeNonceKey, hex(32))
            : consumeRequest(ready.credential, ready.challenge, ready.nonce, ready.quote, ready.quoteDigest);
        const observed = await withCallers(openCaller, [`the ${target} call`], ([caller]) => whileSessionChanges(db.admin, db.secondAdmin, caller, change, ready.credential.session, newDigest, request));
        expect(observed, label).toEqual({ result: "NOT_AUTHORIZED", blockedByHolder: 1, waitsOnHolderTransaction: 1 });
        // Nothing changed but the session row the holder changed.
        expect(changedTables(before, await snapshotOf(db.admin)), label).toEqual(["shopper_sessions"]);
        expect(await statusesOf(db.admin, ready.quote), label).toEqual([`${ready.challenge}:ACTIVE`]);
        expect(await auditTypesOf(db.admin, ready.credential.owner), label).toEqual(["QUOTE_ISSUED"]);
        if (change === "rotation") {
          // The rotated credential is the session now, and confirms the same checkout.
          const rotated: Credential = { ...ready.credential, digest: newDigest };
          expect((await db.web.query(SQL.consumeChallenge, [SESSION_KEY_VERSION, rotated.digest, ready.challenge, ready.nonce, ready.quote, ready.quoteDigest])).rows, label).toEqual([{ result: "CONFIRMED", intent_id: ready.intent }]);
        }
      }
    }
    // The call first: it holds the session row; the change waits behind it; the call completes; the change follows.
    for (const target of ["issue_challenge", "consume_challenge"] as const) {
      for (const change of ["revocation", "rotation"] as const) {
        const label = `a ${change} after ${target}`;
        const ready = await readyToConfirm();
        const newDigest = hex(32);
        const replacement = newId("cf");
        const request =
          target === "issue_challenge"
            ? issueRequest(ready.credential, ready.intent, replacement, activeNonceKey, await digestOfNonce(db.admin, newNonce()))
            : consumeRequest(ready.credential, ready.challenge, ready.nonce, ready.quote, ready.quoteDigest);
        const changeRequest: Request =
          change === "revocation"
            ? { statement: "sessionRevocation", values: [SESSION_KEY_VERSION, ready.credential.digest] }
            : { statement: "sessionRotation", values: [SESSION_KEY_VERSION, ready.credential.digest, SESSION_KEY_VERSION, newDigest] };
        const observed = await withCallers(openCaller, [`the ${target} call`, `the session ${change}`], ([first, second]) => whileCallHoldsSession(db.admin, db.secondAdmin, first, second, ready.intent, request, changeRequest));
        // First the call alone waited, for the holder alone; then two backends waited: the call still behind the
        // holder, and the session change behind the call alone, for the session row the call holds.
        expect(observed.alone, label).toHaveLength(1);
        expect(observed.alone[0].blocked_by, label).toEqual([observed.holder.pid]);
        expect(observed.waits, label).toHaveLength(2);
        expect(observed.waits.filter((wait) => wait.pid !== observed.alone[0].pid).map((wait) => wait.blocked_by), label).toEqual([[observed.alone[0].pid]]);
        expect(observed.result, label).toBe(target === "issue_challenge" ? "REUSED" : "CONFIRMED");
        expect(observed.changeResult, label).toBe(change === "revocation" ? "DONE" : "ROTATED");
        // A later call with the credential as it was is refused, and changes nothing.
        const before = await snapshotOf(db.admin);
        expect((await db.web.query(SQL.issueChallenge, [SESSION_KEY_VERSION, ready.credential.digest, ready.intent, newId("cf"), activeNonceKey, hex(32)])).rows[0].result, label).toBe("NOT_AUTHORIZED");
        expect(await snapshotOf(db.admin), label).toEqual(before);
      }
    }
    await expectQuiet("PGT-233");
  });

  it("PGT-232: a nonce-key revocation against consume_challenge and issue_challenge: after the call it waits for the call; before it, or holding the key row, it decides the call's result", async () => {
    // ---- consume_challenge, case A: the call holds the key row; the revocation waits for the call alone.
    const caseA = await readyToConfirm();
    const keyOfCaseA = await activateNextNonceKey(); // that version is VERIFY_ONLY now, and can be ended
    expect(keyOfCaseA).toBe(caseA.keyVersion);
    await withCallers(openCaller, ["the confirmation of case A"], async ([caller]) => {
      const confirmations: Array<Promise<Outcome>> = [];
      const keyChanges: Array<Promise<Row>> = [];
      const submitted: Array<Promise<unknown>> = [];
      await holding(db.admin, submitted, async () => {
        await db.admin.query(SQL.lockIntent, [caseA.intent]);
        const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
        const clock = startClock(OVERLAP_OBSERVATION_MS);
        const confirmation = caller.send(consumeRequest(caseA.credential, caseA.challenge, caseA.nonce, caseA.quote, caseA.quoteDigest));
        confirmations.push(confirmation);
        submitted.push(confirmation);
        const alone = await awaitQueue(db.secondAdmin, holder, clock, [caller], caller.label);
        expect(alone.waiters.map(edgesOf)).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
        // The revocation is the operator's statement and goes through the operator pool; both handlers are attached
        // as it is sent. The harness has no operator client of its own, so this waiter is identified by what the
        // server reports: the one waiting backend that is not the caller's, logged in as exactly the operator login,
        // and waiting for the caller's backend alone.
        const keyChange = db.operator.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["confirmation_nonce", keyOfCaseA]).then(
          (reply) => reply.rows[0] as Row,
          (error: unknown): Row => ({ result: `ERROR ${sqlStateOf(error)}`, was_active: null }),
        );
        keyChanges.push(keyChange);
        submitted.push(keyChange);
        const both = await awaitQueue(db.secondAdmin, holder, clock, [caller], `${caller.label} and the key change behind it`, 1);
        const behind = both.waiters.filter((waiter) => waiter.pid !== caller.pid);
        expect(behind.map((waiter) => waiter.blocked_by)).toEqual([[caller.pid]]);
        expect(behind.map((waiter) => waiter.role)).toEqual([operatorLogin]);
        expect(both.waiters.filter((waiter) => waiter.pid === caller.pid).map((waiter) => waiter.role)).not.toContain(operatorLogin);
        requireTimeToRelease(clock, caller.label);
      });
      // The call completes while its key is still accepted; the revocation completes afterwards.
      expect(resultOf((await Promise.all(confirmations))[0])).toBe("CONFIRMED");
      expect((await Promise.all(keyChanges))[0]).toMatchObject({ result: "REVOKED", was_active: false });
    });
    expect(await auditTypesOf(db.admin, caseA.credential.owner)).toEqual(["QUOTE_ISSUED", "CONFIRMATION_ACCEPTED"]);
    expect(await intentOf(db.admin, caseA.intent)).toMatchObject({ state: "USER_CONFIRMED", confirmation_id: caseA.challenge });

    // ---- consume_challenge, case B1: the revocation is committed before the call.
    const caseB1 = await readyToConfirm();
    const keyOfCaseB1 = await activateNextNonceKey();
    expect((await db.operator.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["confirmation_nonce", keyOfCaseB1])).rows[0]).toMatchObject({ result: "REVOKED", was_active: false });
    expect((await db.web.query(SQL.consumeChallenge, [SESSION_KEY_VERSION, caseB1.credential.digest, caseB1.challenge, caseB1.nonce, caseB1.quote, caseB1.quoteDigest])).rows).toEqual([{ result: "CONFIRMATION_KEY_REVOKED", intent_id: null }]);
    expect(await auditTypesOf(db.admin, caseB1.credential.owner)).toEqual(["QUOTE_ISSUED", "CONFIRMATION_REJECTED"]);
    expect(await windowOf(db.admin, caseB1.credential.owner)).toMatchObject({ window_calls: 3 });
    expect(await challengeOf(db.admin, caseB1.challenge)).toMatchObject({ status: "ACTIVE" });

    // ---- consume_challenge, case B2: the revocation holds the key row, uncommitted; the call waits for that row.
    const caseB2 = await readyToConfirm();
    const keyOfCaseB2 = await activateNextNonceKey();
    const resultB2 = await withCallers(openCaller, ["the confirmation of case B2"], async ([caller]) => {
      const submitted: Array<Promise<Outcome>> = [];
      await holding(db.admin, submitted, async () => {
        const ending = await db.admin.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["confirmation_nonce", keyOfCaseB2]);
        expect(ending.rows[0]).toMatchObject({ result: "REVOKED", was_active: false });
        const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
        const clock = startClock(OVERLAP_OBSERVATION_MS);
        // The call finds its challenge at step 0d and waits for that challenge's key row at step 1.
        submitted.push(caller.send(consumeRequest(caseB2.credential, caseB2.challenge, caseB2.nonce, caseB2.quote, caseB2.quoteDigest)));
        const queue = await awaitQueue(db.secondAdmin, holder, clock, [caller], caller.label);
        expect(queue.waiters.map(edgesOf)).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
        expect(await transactionWaits(db.secondAdmin, caller.pid, holder.xid)).toBe(1);
        requireTimeToRelease(clock, caller.label);
      });
      return resultOf((await Promise.all(submitted))[0]);
    });
    expect(resultB2).toBe("CONFIRMATION_KEY_REVOKED");
    expect(await auditTypesOf(db.admin, caseB2.credential.owner)).toEqual(["QUOTE_ISSUED", "CONFIRMATION_REJECTED"]);
    expect(await windowOf(db.admin, caseB2.credential.owner)).toMatchObject({ window_calls: 3 });
    expect(await challengeOf(db.admin, caseB2.challenge)).toMatchObject({ status: "ACTIVE" });
    expect(await intentOf(db.admin, caseB2.intent)).toMatchObject({ state: "QUOTED", confirmation_id: null });

    // ---- issue_challenge, case A: the call holds the row of the ACTIVE key it named; the revocation waits for it.
    const issueA = await newCredential(db.admin);
    const issueACheckout = await startedCheckout(db.admin, db.web, issueA);
    const issueAChallenge = newId("cf");
    const issueANonce = newNonce();
    const issueADigest = await digestOfNonce(db.admin, issueANonce);
    const keyOfIssueA = activeNonceKey;
    await withCallers(openCaller, ["the issue of case A"], async ([caller]) => {
      const issues: Array<Promise<Outcome>> = [];
      const keyChanges: Array<Promise<Row>> = [];
      const submitted: Array<Promise<unknown>> = [];
      await holding(db.admin, submitted, async () => {
        await db.admin.query(SQL.lockIntent, [issueACheckout.intent]);
        const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
        const clock = startClock(OVERLAP_OBSERVATION_MS);
        const issuing = caller.send(issueRequest(issueA, issueACheckout.intent, issueAChallenge, keyOfIssueA, issueADigest));
        issues.push(issuing);
        submitted.push(issuing);
        await awaitQueue(db.secondAdmin, holder, clock, [caller], caller.label);
        const keyChange = db.operator.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["confirmation_nonce", keyOfIssueA]).then(
          (reply) => reply.rows[0] as Row,
          (error: unknown): Row => ({ result: `ERROR ${sqlStateOf(error)}`, was_active: null }),
        );
        keyChanges.push(keyChange);
        submitted.push(keyChange);
        const both = await awaitQueue(db.secondAdmin, holder, clock, [caller], `${caller.label} and the key change behind it`, 1);
        const behind = both.waiters.filter((waiter) => waiter.pid !== caller.pid);
        expect(behind.map((waiter) => waiter.blocked_by)).toEqual([[caller.pid]]);
        expect(behind.map((waiter) => waiter.role)).toEqual([operatorLogin]);
        requireTimeToRelease(clock, caller.label);
      });
      // The key was ACTIVE when the call read it under its lock: the challenge is issued. Then the key is ended.
      expect(resultOf((await Promise.all(issues))[0])).toBe("ISSUED");
      expect((await Promise.all(keyChanges))[0]).toMatchObject({ result: "REVOKED", was_active: true });
    });
    // No version is ACTIVE now. Issue is refused under the ended one; the challenge issued above is refused too.
    expect((await db.web.query(SQL.issueChallenge, [SESSION_KEY_VERSION, issueA.digest, issueACheckout.intent, newId("cf"), keyOfIssueA, hex(32)])).rows[0].result).toBe("NONCE_KEY_NOT_ACTIVE");
    expect((await db.web.query(SQL.consumeChallenge, [SESSION_KEY_VERSION, issueA.digest, issueAChallenge, issueANonce, issueACheckout.quote, issueACheckout.quoteDigest])).rows).toEqual([{ result: "CONFIRMATION_KEY_REVOKED", intent_id: null }]);
    expect(await statusesOf(db.admin, issueACheckout.quote)).toEqual([`${issueAChallenge}:ACTIVE`]);
    await activateNextNonceKey();

    // ---- issue_challenge, case B2: the revocation holds the row of the key the call names; the call waits for it.
    const issueB2 = await newCredential(db.admin);
    const issueB2Checkout = await startedCheckout(db.admin, db.web, issueB2);
    const keyOfIssueB2 = activeNonceKey;
    const resultIssueB2 = await withCallers(openCaller, ["the issue of case B2"], async ([caller]) => {
      const submitted: Array<Promise<Outcome>> = [];
      await holding(db.admin, submitted, async () => {
        const ending = await db.admin.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["confirmation_nonce", keyOfIssueB2]);
        expect(ending.rows[0]).toMatchObject({ result: "REVOKED", was_active: true });
        const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
        const clock = startClock(OVERLAP_OBSERVATION_MS);
        submitted.push(caller.send(issueRequest(issueB2, issueB2Checkout.intent, newId("cf"), keyOfIssueB2, hex(32))));
        const queue = await awaitQueue(db.secondAdmin, holder, clock, [caller], caller.label);
        expect(queue.waiters.map(edgesOf)).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
        requireTimeToRelease(clock, caller.label);
      });
      return resultOf((await Promise.all(submitted))[0]);
    });
    expect(resultIssueB2).toBe("NONCE_KEY_NOT_ACTIVE");
    // ---- issue_challenge, case B1: the same, with the revocation long committed.
    expect((await db.web.query(SQL.issueChallenge, [SESSION_KEY_VERSION, issueB2.digest, issueB2Checkout.intent, newId("cf"), keyOfIssueB2, hex(32)])).rows[0].result).toBe("NONCE_KEY_NOT_ACTIVE");
    expect(await statusesOf(db.admin, issueB2Checkout.quote)).toEqual([]);
    expect(await auditTypesOf(db.admin, issueB2.owner)).toEqual(["QUOTE_ISSUED"]);
    expect(await windowOf(db.admin, issueB2.owner)).toMatchObject({ window_calls: 3, window_throttled: 0 });
    // A new ACTIVE version, for whatever runs after this test. VERIFY_ONLY against ACTIVE is in
    // confirmation-functions.test.ts (PGT-17, PGT-203c and PGT-212).
    await activateNextNonceKey();
    expect((await db.web.query(SQL.issueChallenge, [SESSION_KEY_VERSION, issueB2.digest, issueB2Checkout.intent, newId("cf"), activeNonceKey, hex(32)])).rows[0].result).toBe("ISSUED");
    await expectQuiet("PGT-232");
  });

  it("PGT-234: the four mutating functions share one request window: a call that crosses the boundary while it waits stays in its window, and of forty calls at once exactly thirty are admitted", async () => {
    // The boundary: a window that started 59 seconds ago with five calls. The issue takes its step 4 reading before
    // the boundary and waits past it.
    let windowBefore: Row = {};
    let owner = "";
    const observed = await withCallers(openCaller, ["the issue across the boundary"], ([caller]) =>
      waitedAcross(db.admin, db.secondAdmin, caller, async () => {
        const credential = await newCredential(db.admin);
        const checkout = await fixtureCheckout(db.admin, credential);
        await db.admin.query(SQL.insertWindow, [credential.owner, "-59 seconds", 5]);
        windowBefore = (await db.admin.query(SQL.windowTimes, [credential.owner])).rows[0];
        owner = credential.owner;
        return { intent: checkout.intent, request: issueRequest(credential, checkout.intent, newId("cf"), activeNonceKey, hex(32)), deadline: "window", subject: credential.owner };
      }),
    );
    console.info(`PGT-234 (boundary) as observed: ${JSON.stringify({ ...observed, crossing: undefined })}`);
    expectWaitedAcrossDeadline(observed, "the window boundary");
    expect(observed.result).toBe("ISSUED");
    const windowAfter = (await db.admin.query(SQL.windowTimes, [owner])).rows[0];
    // Counted in the window assigned at step 4: its start is unchanged and its count is one higher, although the
    // call finished after the boundary.
    expect(windowAfter.window_started_at).toEqual(windowBefore.window_started_at);
    expect(windowAfter).toMatchObject({ window_calls: 6, window_throttled: 0, total_throttled: 0 });

    // Forty at once, ten of each function, for one owner without a request-window row. Every one of them would be
    // admitted and answered with its own refusal if there were room; thirty are, ten are throttled.
    const credential = await newCredential(db.admin);
    const canceled = await fixtureCheckout(db.admin, credential);
    await cancelFixtureDirectly(db.admin, credential, canceled.intent);
    const other = await fixtureCheckout(db.admin, credential);
    const ended = await fixtureChallenge(db.admin, other.quote, activeNonceKey);
    await db.admin.query(SQL.supersedeChallengeDirectly, [ended.challenge]);
    expect(await windowOf(db.admin, credential.owner)).toBeNull();
    const before = await snapshotOf(db.admin);
    const expectedByFunction = [
      ["start_checkout", "PRODUCT_NOT_IN_MERCHANT_CATALOG"],
      ["cancel_checkout", "NOT_CANCELABLE"],
      ["issue_challenge", "INTENT_NOT_AWAITING_CONFIRMATION"],
      ["consume_challenge", "CONFIRMATION_SUPERSEDED"],
    ] as const;
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => [
        tagged(db.web.query(SQL.startCheckout, [SESSION_KEY_VERSION, credential.digest, UNKNOWN_PRODUCT, UNKNOWN_VARIANT, 1, null])),
        tagged(db.web.query(SQL.cancelCheckout, [SESSION_KEY_VERSION, credential.digest, canceled.intent])),
        tagged(db.web.query(SQL.issueChallenge, [SESSION_KEY_VERSION, credential.digest, canceled.intent, newId("cf"), activeNonceKey, hex(32)])),
        tagged(db.web.query(SQL.consumeChallenge, [SESSION_KEY_VERSION, credential.digest, ended.challenge, ended.nonce, other.quote, other.quoteDigest])),
      ]).flat(),
    );
    const results = outcomes.map(resultOf);
    // Each call returned its own function's refusal or RATE_LIMITED, and nothing raised.
    for (const [index, result] of results.entries()) {
      const expected = expectedByFunction.at(index % 4);
      if (expected === undefined) throw new Error("no expectation for this call");
      expect([expected[1], "RATE_LIMITED"], `${expected[0]}, call ${index + 1}`).toContain(result);
    }
    expect(results.filter((result) => result === "RATE_LIMITED")).toHaveLength(10);
    expect(results.filter((result) => result !== "RATE_LIMITED")).toHaveLength(30);
    expect(await windowOf(db.admin, credential.owner)).toEqual({ window_calls: 30, window_throttled: 10, total_throttled: 10 });
    // One audit row: the first throttled call of the window. Nothing else of any table changed.
    expect(await auditTypesOf(db.admin, credential.owner)).toEqual(["OWNER_RATE_LIMITED"]);
    expect(changedTables(before, await snapshotOf(db.admin))).toEqual(["audit_events", "owner_request_windows"]);
    console.info(`PGT-234 (forty at once) as observed: ${JSON.stringify(tally(results))}`);
    await expectQuiet("PGT-234");
  });
});
