import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { adminUrl, hex, openDisposableDatabase, TEST_NONCE_KEY, type DisposableDatabase } from "./harness";

// NEVER RUN. Written for the Increment 2.1 functions migration (0008); running it needs a separate authorization and
// a new disposable PostgreSQL 17 cluster (see ./harness). Nothing here is evidence until it has been run.
//
// Scope: the cases of the function acceptance manifest (specification 19.15) that need more than one connection at
// once. The functions are called as the web role. The test owner's first connection (db.admin) is the holder: it
// takes a lock inside a transaction and keeps it. A call that is forced to wait is sent on a web client of its own
// (db.connectWeb), whose backend is read on that client before the call is sent. The test owner's second connection
// (db.secondAdmin) is the observer: it is never inside a transaction while it observes, so every observation is
// current. (A connection inside a transaction keeps the first picture of pg_stat_activity it took. Observing through
// the holder is what made three cases of the first run of this file fail.) An interleaving is forced by the holder's
// lock and established by what the server reports about the identified backends; no elapsed time is evidence of
// anything. The web connections carry the approved lock timeout of two seconds, which is not changed here: every
// forced wait is released well inside it.
//
// Statements: every statement this file sends is a fixed string held in the table SQL. Values travel only as bound
// parameters. The static test PGT-157 reads this file and depends on that. This file sends no privilege statement.

const PRODUCT = "dmp_codebook15";
const VARIANT = "dmv_codebook15a";
const UNKNOWN_PRODUCT = "dmp_unknown01";
const UNKNOWN_VARIANT = "dmv_unknown01";
const KEY_VERSION = 1;
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
  listOwnerCheckouts:
    "SELECT intent_id, purchase_group_id, stored_state, effective_status, intent_created_at, quote_expires_at FROM shopaccess_api.list_owner_checkouts($1, $2)",

  // Fixtures and the blocker, by the test owner.
  insertOwner: "INSERT INTO shopaccess.checkout_owners (id, created_at) VALUES ($1, pg_catalog.clock_timestamp() + $2::interval)",
  insertSession:
    "INSERT INTO shopaccess.shopper_sessions (id, owner_id, key_version, token_digest, created_at, last_seen_at, absolute_expires_at) " +
    "SELECT $1, $2, $6::smallint, $3, t.now + $4::interval, t.now + $5::interval, t.now + $4::interval + interval '24 hours' " +
    "FROM (SELECT pg_catalog.clock_timestamp() AS now) t",
  // A checkout written directly by the test owner: no function runs, so no request-window row is created.
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
  insertFirstTransition:
    "INSERT INTO shopaccess.checkout_transitions (checkout_intent_id, to_version, from_version, event_id, event_type, actor, entry_point, from_state, to_state, occurred_at, recorded_at) " +
    "VALUES ($1, 2, 1, $2, 'QUOTE_ISSUED', 'server', 'start_checkout', 'DRAFT', 'QUOTED', $3::timestamptz, $3::timestamptz)",
  insertWindow:
    "INSERT INTO shopaccess.owner_request_windows (owner_id, window_started_at, window_calls, window_throttled, total_throttled, updated_at) " +
    "SELECT $1, t.now + $2::interval, $3::integer, 0, 0, t.now + $2::interval FROM (SELECT pg_catalog.clock_timestamp() AS now) t",
  lockOwner: "SELECT id FROM shopaccess.checkout_owners WHERE id = $1 FOR UPDATE",
  // Session changes written directly, in the shapes the session trigger accepts: a rotation and a revocation.
  rotateSessionDirectly:
    "UPDATE shopaccess.shopper_sessions SET token_digest = $2, last_seen_at = pg_catalog.clock_timestamp(), row_version = row_version + 1 WHERE id = $1",
  revokeSessionDirectly: "UPDATE shopaccess.shopper_sessions SET revoked_at = pg_catalog.clock_timestamp(), row_version = row_version + 1 WHERE id = $1",
  // A catalog row that exists only for the deletion case of PGT-118, and its removal.
  insertTestProduct:
    "INSERT INTO shopaccess.merchant_products (id, merchant_id, title, description, image_path, catalog_revision) " +
    "VALUES ($1, 'dmm_shopaccessdemo', 'A product for one test', 'A product that exists only for the deletion case.', '/catalog/for-one-test.svg', 1)",
  insertTestVariant:
    "INSERT INTO shopaccess.merchant_variants (id, product_id, label, unit_amount_cents, currency, max_quantity_per_order, availability, specs, catalog_revision) " +
    "VALUES ($1, $2, 'A variant for one test', 1000, 'USD', 1, 'IN_STOCK', '{}'::jsonb, 1)",
  deleteTestVariant: "DELETE FROM shopaccess.merchant_variants WHERE id = $1",
  deleteTestProduct: "DELETE FROM shopaccess.merchant_products WHERE id = $1",
  // PGT-118, direct: the lock a checkout's item holds on its variant, and a reprice of that variant meanwhile.
  backendPid: "SELECT pg_catalog.pg_backend_pid() AS pid",
  // The login of the connection that sends it, as the server names it.
  sessionLogin: "SELECT session_user::text AS login",
  blockersOf: "SELECT pg_catalog.pg_blocking_pids($1::integer) AS blocked_by",
  setLocalLockTimeout: "SET LOCAL lock_timeout = '1500ms'",
  lockVariantForUpdate: "SELECT id FROM shopaccess.merchant_variants WHERE id = $1 FOR UPDATE",
  intentVisible: "SELECT count(*)::integer AS n FROM shopaccess.checkout_intents WHERE id = $1",
  itemVariantOf:
    "SELECT count(*)::integer AS matched, min(mv.unit_amount_cents) AS variant_amount, min(mv.catalog_revision) AS variant_revision " +
    "FROM shopaccess.quotes q JOIN shopaccess.quote_items qi ON qi.quote_id = q.id " +
    "JOIN shopaccess.merchant_variants mv ON mv.id = qi.variant_id AND mv.product_id = qi.product_id WHERE q.checkout_intent_id = $1",
  openTransactions:
    "SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity a WHERE a.datname = pg_catalog.current_database() AND a.state LIKE 'idle in transaction%'",
  // A catalog write that changes no key: the kind of statement a reprice is.
  touchMerchantName: "UPDATE shopaccess.merchants SET display_name = display_name WHERE id = 'dmm_shopaccessdemo'",
  catalogRowsOf:
    "SELECT (SELECT count(*)::integer FROM shopaccess.merchant_products p WHERE p.id = $1) AS products, (SELECT count(*)::integer FROM shopaccess.merchant_variants v WHERE v.id = $2) AS variants",
  lockIntent: "SELECT id FROM shopaccess.checkout_intents WHERE id = $1 FOR UPDATE",
  repriceVariant: "UPDATE shopaccess.merchant_variants SET unit_amount_cents = $2, catalog_revision = $3 WHERE id = $1",
  variantPrice: "SELECT unit_amount_cents, catalog_revision FROM shopaccess.merchant_variants WHERE id = $1",

  // Observations of the server, by the test owner.
  backendAndTransaction: "SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.pg_current_xact_id()::text AS xid",
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
  shortSleep: "SELECT pg_catalog.pg_sleep(0.005)",
  sessionExpiryPassed: "SELECT pg_catalog.clock_timestamp() >= s.absolute_expires_at AS passed FROM shopaccess.shopper_sessions s WHERE s.id = $1",
  // Database time against a deadline: whether it has been reached, and how many seconds are left.
  sessionMargin:
    "SELECT (pg_catalog.clock_timestamp() >= s.absolute_expires_at) AS passed, " +
    "(extract(epoch FROM (s.absolute_expires_at - pg_catalog.clock_timestamp())))::double precision AS remaining_seconds FROM shopaccess.shopper_sessions s WHERE s.id = $1",
  windowMargin:
    "SELECT (pg_catalog.clock_timestamp() >= w.window_started_at + interval '60 seconds') AS passed, " +
    "(extract(epoch FROM (w.window_started_at + interval '60 seconds' - pg_catalog.clock_timestamp())))::double precision AS remaining_seconds FROM shopaccess.owner_request_windows w WHERE w.owner_id = $1",
  windowTimes:
    "SELECT window_started_at, window_calls, window_throttled::integer AS window_throttled, total_throttled::integer AS total_throttled, updated_at FROM shopaccess.owner_request_windows WHERE owner_id = $1",
  keyStatuses: "SELECT key_version, status FROM shopaccess.server_key_versions WHERE purpose = 'session' ORDER BY key_version",
  stateOf: "SELECT state FROM shopaccess.checkout_intents WHERE id = $1",
  versionOf: "SELECT row_version FROM shopaccess.checkout_intents WHERE id = $1",

  // Observations of the rows.
  intentRow:
    "SELECT state, row_version, purchase_group_id, replaces_intent_id, superseded_by_intent_id, confirmation_id FROM shopaccess.checkout_intents WHERE id = $1",
  successorsOf: "SELECT id FROM shopaccess.checkout_intents WHERE replaces_intent_id = $1",
  quoteOf:
    "SELECT q.subtotal_cents::integer AS subtotal_cents, q.catalog_revision, qi.unit_amount_cents::integer AS unit_amount_cents " +
    "FROM shopaccess.quotes q JOIN shopaccess.quote_items qi ON qi.quote_id = q.id WHERE q.checkout_intent_id = $1",
  windowRow:
    "SELECT window_calls, window_throttled::integer AS window_throttled, total_throttled::integer AS total_throttled FROM shopaccess.owner_request_windows WHERE owner_id = $1",
  ownerCounts:
    "SELECT (SELECT count(*)::integer FROM shopaccess.purchase_groups g WHERE g.owner_id = $1) AS groups, " +
    "(SELECT count(*)::integer FROM shopaccess.checkout_intents i WHERE i.owner_id = $1) AS intents, " +
    "(SELECT count(*)::integer FROM shopaccess.audit_events a WHERE a.owner_id = $1 AND a.event_type = 'OWNER_RATE_LIMITED') AS rate_limited_audits, " +
    "(SELECT count(*)::integer FROM shopaccess.audit_events a WHERE a.owner_id = $1 AND a.event_type = 'CHECKOUT_REFUSED_AT_CAPACITY') AS capacity_audits",
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

interface Credential {
  readonly owner: string;
  readonly session: string;
  readonly digest: string;
  /** The session key version the session row was written under, and so the one a call must present. */
  readonly keyVersion: number;
}

const newId = (prefix: string): string => `${prefix}_${hex(16)}`;

/**
 * A session row written by the test owner, for a new owner or an existing one, under the given session key version
 * (which must be ACTIVE when the row is written). Offsets are relative to the database clock; the absolute expiry is
 * 24 hours after creation.
 */
async function newCredential(
  client: Admin,
  createdOffset: string = NOW,
  lastSeenOffset: string = NOW,
  existingOwner: string | null = null,
  keyVersion: number = KEY_VERSION,
): Promise<Credential> {
  const owner = existingOwner ?? newId("own");
  const session = newId("ses");
  const digest = hex(32);
  if (existingOwner === null) await client.query(SQL.insertOwner, [owner, createdOffset]);
  await client.query(SQL.insertSession, [session, owner, digest, createdOffset, lastSeenOffset, keyVersion]);
  return { owner, session, digest, keyVersion };
}

/**
 * A valid QUOTED checkout written directly by the test owner in one transaction: group, intent, quote (digest from
 * the helper start_checkout uses), item and first transition. No function runs, so the owner's request-window row,
 * if it has none, stays absent. Returns the intent.
 */
async function insertFixtureCheckout(client: Admin, owner: string): Promise<string> {
  const intent = newId("ci");
  const quote = newId("qt");
  const group = newId("pur");
  const created = new Date(Date.now() - 60 * 1000).toISOString();
  await client.query(SQL.begin);
  try {
    await client.query(SQL.insertGroup, [group, owner, created]);
    await client.query(SQL.insertIntent, [intent, owner, group, quote, created]);
    await client.query(SQL.insertQuote, [quote, owner, intent, group, created]);
    await client.query(SQL.insertItem, [quote]);
    await client.query(SQL.insertFirstTransition, [intent, newId("ev"), created]);
    await client.query(SQL.commit);
  } catch (error) {
    await client.query(SQL.rollback);
    throw error;
  }
  return intent;
}

function sqlStateOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
}

function constraintOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "constraint" in error ? String((error as { constraint: unknown }).constraint) : null;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function startedIntent(pool: Web, credential: Credential): Promise<string> {
  const { rows } = await pool.query(SQL.startCheckout, [credential.keyVersion, credential.digest, PRODUCT, VARIANT, 1, null]);
  expect(rows[0].result).toBe("STARTED");
  return rows[0].intent_id;
}

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

/** A call a caller can send: one of the two mutating checkout functions, or one of the two reviewed session changes. */
interface Request {
  readonly statement: "startCheckout" | "cancelCheckout" | "sessionRevocation" | "sessionRotation";
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

// A call that must still be waiting when a database deadline passes. A deadline one second away is used, and the
// call is submitted only when the server reports at least half of that second still left; otherwise the attempt is
// abandoned before anything is sent and a new deadline is set up. The wait is observed within
// SINGLE_WAIT_OBSERVATION_MS, the deadline is then read until it has passed or DEADLINE_CROSSING_MS is reached, and
// the holder lets go before RELEASE_LIMIT_MS: inside the web role's lock timeout of two seconds, which is not
// widened here. No elapsed time is taken as evidence of anything: what is asserted is what the server reported.
const DEADLINE_OFFSET = "-86399 seconds";
const WINDOW_OFFSET = "-59 seconds";
const REQUIRED_MARGIN_SECONDS = 0.5;
const ATTEMPTS = 5;

interface WaitEvidence {
  /** How many deadlines were set up before one left enough time to submit. */
  readonly attempts: number;
  /** Seconds the server reported left before the deadline, just before the call was submitted. */
  readonly remainingAtSubmission: number;
  /** How many backends the server reported waiting for the holder alone while the call waited: the caller, and no other. */
  readonly blockedByBlocker: number;
  /** How many ungranted transaction-id lock requests the caller's backend had against the holder's transaction. */
  readonly waitsOnBlockerTransaction: number;
  /** Whether database time was still before the deadline while the call was observed waiting. */
  readonly beforeDeadlineWhileBlocked: boolean;
  /** Whether database time was observed at or past the deadline before the holder let go. */
  readonly deadlineReachedBeforeRelease: boolean;
  /** The result code of the call, or "ERROR <sqlstate>". */
  readonly result: string;
}

/** The waiters that wait for the holder and for nothing else. */
const directlyBehind = (queue: QueueEvidence, holder: Holder): Waiter[] => queue.waiters.filter((waiter) => waiter.blocked_by.length === 1 && waiter.blocked_by.includes(holder.pid));

/**
 * PGT-143. A session of `owner` that is one second from its absolute expiry cancels `intent`, on the caller's own
 * client, while the holder holds the intent row. The call is submitted only after the server confirms the session is
 * still live with time to spare; the caller's backend is observed waiting for the holder, on the holder's
 * transaction, with database time still before the expiry; database time is then observed reaching the expiry; only
 * then does the holder let go. Returns that evidence with the whole-database snapshots taken just before the
 * transaction and after the call.
 */
async function expiryWhileWaiting(client: Admin, observer: Observer, caller: Caller, owner: string, intent: string): Promise<WaitEvidence & { before: unknown; after: unknown }> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const expiring = await newCredential(client, DEADLINE_OFFSET, NOW, owner);
    const before = (await client.query(SQL.snapshot)).rows[0];
    const submitted: Array<Promise<Outcome>> = [];
    const evidence = await holding(client, submitted, async (): Promise<Omit<WaitEvidence, "result"> | null> => {
      // The holder locks exactly the target intent row, and records its backend and its transaction.
      await client.query(SQL.lockIntent, [intent]);
      const holder: Holder = (await client.query(SQL.backendAndTransaction)).rows[0];
      // Liveness is verified on the server immediately before submission.
      const margin = (await client.query(SQL.sessionMargin, [expiring.session])).rows[0];
      if (!(margin.passed === false && margin.remaining_seconds >= REQUIRED_MARGIN_SECONDS)) return null;
      const clock = startClock(SINGLE_WAIT_OBSERVATION_MS);
      submitted.push(caller.send({ statement: "cancelCheckout", values: [expiring.keyVersion, expiring.digest, intent] }));
      const queue = await awaitQueue(observer, holder, clock, [caller], `${caller.label}, attempt ${attempt}`);
      const waitsOnBlockerTransaction = await transactionWaits(observer, caller.pid, holder.xid);
      // While the call is blocked, database time is still before the expiry.
      const beforeDeadlineWhileBlocked = (await client.query(SQL.sessionMargin, [expiring.session])).rows[0].passed === false;
      // Database time is read until it has reached the expiry. Nothing is released before that is observed.
      let reached = false;
      while (!reached && Date.now() - clock.startedAt < DEADLINE_CROSSING_MS) {
        reached = (await client.query(SQL.sessionMargin, [expiring.session])).rows[0].passed === true;
        if (!reached) await client.query(SQL.shortSleep);
      }
      requireTimeToRelease(clock, `${caller.label}, attempt ${attempt}`);
      return {
        attempts: attempt,
        remainingAtSubmission: margin.remaining_seconds,
        blockedByBlocker: directlyBehind(queue, holder).length,
        waitsOnBlockerTransaction,
        beforeDeadlineWhileBlocked,
        deadlineReachedBeforeRelease: reached,
      };
    });
    if (evidence !== null) {
      const result = resultOf((await Promise.all(submitted))[0]);
      const after = (await client.query(SQL.snapshot)).rows[0];
      return { ...evidence, result, before, after };
    }
    // Too little time was left: nothing was sent. The unused session stays behind, expired; a new one is set up.
  }
  throw new Error(`no session had ${REQUIRED_MARGIN_SECONDS} seconds left before submission in ${ATTEMPTS} attempts`);
}

/** Asserts the evidence of a forced wait: the call waited on the holder, before the deadline, and was released only after it. */
function expectWaitedAcrossDeadline(evidence: WaitEvidence, label: string): void {
  expect(evidence.remainingAtSubmission, label).toBeGreaterThanOrEqual(REQUIRED_MARGIN_SECONDS);
  expect(evidence.blockedByBlocker, label).toBe(1);
  expect(evidence.waitsOnBlockerTransaction, label).toBe(1);
  expect(evidence.beforeDeadlineWhileBlocked, label).toBe(true);
  expect(evidence.deadlineReachedBeforeRelease, label).toBe(true);
}

/**
 * PGT-124 (c). A new owner with a prebuilt checkout and a request window that is one second from its boundary. The
 * owner cancels the checkout, on the caller's own client, while the holder holds the intent row: the call's step 4
 * reading is before the boundary; the caller's backend is observed waiting for the holder with database time still
 * before the boundary; database time is observed reaching the boundary; then the holder lets go. Returns the evidence
 * and the window before and after.
 */
async function boundaryWhileWaiting(
  client: Admin,
  observer: Observer,
  caller: Caller,
): Promise<WaitEvidence & { credential: Credential; windowBefore: { window_started_at: Date; window_calls: number; updated_at: Date }; windowAfter: { window_started_at: Date; window_calls: number; window_throttled: number; updated_at: Date } }> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const credential = await newCredential(client);
    const intent = await insertFixtureCheckout(client, credential.owner);
    await client.query(SQL.insertWindow, [credential.owner, WINDOW_OFFSET, 5]);
    const windowBefore = (await client.query(SQL.windowTimes, [credential.owner])).rows[0];
    const submitted: Array<Promise<Outcome>> = [];
    const evidence = await holding(client, submitted, async (): Promise<Omit<WaitEvidence, "result"> | null> => {
      await client.query(SQL.lockIntent, [intent]);
      const holder: Holder = (await client.query(SQL.backendAndTransaction)).rows[0];
      const margin = (await client.query(SQL.windowMargin, [credential.owner])).rows[0];
      if (!(margin.passed === false && margin.remaining_seconds >= REQUIRED_MARGIN_SECONDS)) return null;
      const clock = startClock(SINGLE_WAIT_OBSERVATION_MS);
      submitted.push(caller.send({ statement: "cancelCheckout", values: [credential.keyVersion, credential.digest, intent] }));
      const queue = await awaitQueue(observer, holder, clock, [caller], `${caller.label}, attempt ${attempt}`);
      const waitsOnBlockerTransaction = await transactionWaits(observer, caller.pid, holder.xid);
      // The call has taken its step 4 reading (it holds the owner and window rows and waits at step 5), and
      // database time is still before the boundary: that reading was before the boundary.
      const beforeDeadlineWhileBlocked = (await client.query(SQL.windowMargin, [credential.owner])).rows[0].passed === false;
      let reached = false;
      while (!reached && Date.now() - clock.startedAt < DEADLINE_CROSSING_MS) {
        reached = (await client.query(SQL.windowMargin, [credential.owner])).rows[0].passed === true;
        if (!reached) await client.query(SQL.shortSleep);
      }
      requireTimeToRelease(clock, `${caller.label}, attempt ${attempt}`);
      return {
        attempts: attempt,
        remainingAtSubmission: margin.remaining_seconds,
        blockedByBlocker: directlyBehind(queue, holder).length,
        waitsOnBlockerTransaction,
        beforeDeadlineWhileBlocked,
        deadlineReachedBeforeRelease: reached,
      };
    });
    if (evidence !== null) {
      const result = resultOf((await Promise.all(submitted))[0]);
      const windowAfter = (await client.query(SQL.windowTimes, [credential.owner])).rows[0];
      return { ...evidence, result, credential, windowBefore, windowAfter };
    }
  }
  throw new Error(`no request window had ${REQUIRED_MARGIN_SECONDS} seconds left before submission in ${ATTEMPTS} attempts`);
}

/**
 * PGT-81d. Sends one new-group checkout per caller for one owner while the holder holds that owner's row, so that all
 * of them wait for the owner lock at once. Every caller's backend is observed waiting, in one queue that ends at the
 * holder, before the row is released. Every call has settled when this returns.
 */
async function overlappingStarts(
  client: Admin,
  observer: Observer,
  callers: readonly Caller[],
  credential: Credential,
): Promise<{ results: string[]; holder: Holder; queue: QueueEvidence; onHolderTransaction: number }> {
  const request: Request = { statement: "startCheckout", values: [credential.keyVersion, credential.digest, PRODUCT, VARIANT, 1, null] };
  const submitted: Array<Promise<Outcome>> = [];
  const observed = await holding(client, submitted, async () => {
    await client.query(SQL.lockOwner, [credential.owner]);
    const holder: Holder = (await client.query(SQL.backendAndTransaction)).rows[0];
    const clock = startClock(OVERLAP_OBSERVATION_MS);
    for (const each of callers) submitted.push(each.send(request));
    const queue = await awaitQueue(observer, holder, clock, callers, `${callers.length} new-group checkouts`);
    // Of all the callers, how many wait on the holder's transaction itself (the others wait behind them, in line).
    let onHolderTransaction = 0;
    for (const each of callers) onHolderTransaction += await transactionWaits(observer, each.pid, holder.xid);
    requireTimeToRelease(clock, `${callers.length} new-group checkouts`);
    return { holder, queue, onHolderTransaction };
  });
  return { ...observed, results: (await Promise.all(submitted)).map(resultOf) };
}

/**
 * PGT-132, for a session. The holder changes the session row in a transaction it has not committed (a rotation to
 * `newDigest`, or a revocation), so it holds the session row. A cancellation with the credential as it was is then
 * sent on the caller's own client: it finds the session live at step 0 and waits for the session row at step 2. That
 * wait is observed, for the caller's backend, before the change is committed. Returns the result of the call and the
 * wait that was observed.
 */
async function whileSessionChanges(
  client: Admin,
  observer: Observer,
  caller: Caller,
  change: "rotation" | "revocation",
  credential: Credential,
  newDigest: string,
  intent: string,
): Promise<{ result: string; blockedByBlocker: number; waitsOnBlockerTransaction: number }> {
  const submitted: Array<Promise<Outcome>> = [];
  const observed = await holding(client, submitted, async () => {
    if (change === "rotation") await client.query(SQL.rotateSessionDirectly, [credential.session, newDigest]);
    if (change === "revocation") await client.query(SQL.revokeSessionDirectly, [credential.session]);
    const holder: Holder = (await client.query(SQL.backendAndTransaction)).rows[0];
    const clock = startClock(OVERLAP_OBSERVATION_MS);
    submitted.push(caller.send({ statement: "cancelCheckout", values: [credential.keyVersion, credential.digest, intent] }));
    const queue = await awaitQueue(observer, holder, clock, [caller], `${caller.label} during the ${change}`);
    const waitsOnBlockerTransaction = await transactionWaits(observer, caller.pid, holder.xid);
    requireTimeToRelease(clock, `${caller.label} during the ${change}`);
    return { blockedByBlocker: directlyBehind(queue, holder).length, waitsOnBlockerTransaction };
  });
  return { result: resultOf((await Promise.all(submitted))[0]), ...observed };
}

/**
 * PGT-132, case A for a session. The checkout call goes first, on its own client: it takes the session row FOR SHARE
 * and waits for the intent, which the holder holds. Only when that wait is observed is the session's revocation, or
 * its rotation to `newDigest`, sent through the reviewed Increment 1 statement on a second client of its own; it
 * waits for the session row the checkout call holds. Both waits are observed together, each for its own backend,
 * before the holder lets go. Returns both results, the checkout backend, and the waits.
 */
async function whileCallHoldsSession(
  client: Admin,
  observer: Observer,
  checkoutCaller: Caller,
  changeCaller: Caller,
  change: "revocation" | "rotation",
  credential: Credential,
  newDigest: string,
  intent: string,
): Promise<{ checkoutResult: string; changeResult: string; checkoutBackend: number; holder: Holder; alone: Array<{ pid: number; blocked_by: number[] }>; waits: Array<{ pid: number; blocked_by: number[] }> }> {
  const submitted: Array<Promise<Outcome>> = [];
  const changeRequest: Request =
    change === "revocation"
      ? { statement: "sessionRevocation", values: [credential.keyVersion, credential.digest] }
      : { statement: "sessionRotation", values: [credential.keyVersion, credential.digest, credential.keyVersion, newDigest] };
  const observed = await holding(client, submitted, async () => {
    await client.query(SQL.lockIntent, [intent]);
    const holder: Holder = (await client.query(SQL.backendAndTransaction)).rows[0];
    const clock = startClock(OVERLAP_OBSERVATION_MS);
    submitted.push(checkoutCaller.send({ statement: "cancelCheckout", values: [credential.keyVersion, credential.digest, intent] }));
    const alone = await awaitQueue(observer, holder, clock, [checkoutCaller], `${checkoutCaller.label} alone`);
    submitted.push(changeCaller.send(changeRequest));
    const both = await awaitQueue(observer, holder, clock, [checkoutCaller, changeCaller], `${checkoutCaller.label} and the session ${change}`);
    requireTimeToRelease(clock, `${checkoutCaller.label} and the session ${change}`);
    return { holder, alone: alone.waiters.map(edgesOf), waits: both.waiters.map(edgesOf) };
  });
  const outcomes = await Promise.all(submitted);
  return { ...observed, checkoutResult: resultOf(outcomes[0]), changeResult: resultOf(outcomes[1]), checkoutBackend: checkoutCaller.pid };
}

const tally = (results: readonly string[]): Record<string, number> => {
  const counted = new Map<string, number>();
  for (const result of results) counted.set(result, (counted.get(result) ?? 0) + 1);
  return Object.fromEntries([...counted.entries()].sort(([left], [right]) => left.localeCompare(right)));
};

describe.skipIf(!adminUrl())("Increment 2.1 checkout functions under concurrency (migration 0008) on a disposable PostgreSQL 17 database", () => {
  let db: DisposableDatabase;

  beforeAll(async () => {
    db = await openDisposableDatabase();
    const session = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 1, computeKeyCheckValue(TEST_NONCE_KEY, "session")]);
    expect(session.rows[0].result).toBe("ACTIVATED");
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

  it("PGT-113: two overlapping replacements of one predecessor give one successor and one refusal", async () => {
    const credential = await newCredential(db.admin);
    const predecessor = await startedIntent(db.web, credential);
    const values = [KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, predecessor];
    // The overlap is established on the server, not assumed: the first request holds the owner lock and waits for
    // the predecessor; the second waits for the owner lock behind it; both waits are observed before either moves.
    const observed = await withCallers(openCaller, ["the first replacement", "the second replacement"], ([first, second]) =>
      inOrder(db.admin, db.secondAdmin, first, second, predecessor, { statement: "startCheckout", values }, { statement: "startCheckout", values }),
    );
    expectOverlap(observed, "two replacements");
    expect(observed.results).toEqual(["STARTED", "REPLACEMENT_NOT_ALLOWED"]);

    const successors = (await db.admin.query(SQL.successorsOf, [predecessor])).rows;
    expect(successors).toHaveLength(1);
    // The pointers agree both ways.
    expect((await db.admin.query(SQL.intentRow, [predecessor])).rows[0]).toMatchObject({ state: "SUPERSEDED", row_version: 3, superseded_by_intent_id: successors[0].id });
    expect((await db.admin.query(SQL.intentRow, [successors[0].id])).rows[0]).toMatchObject({ state: "QUOTED", row_version: 2, replaces_intent_id: predecessor, superseded_by_intent_id: null });
    expect((await db.admin.query(SQL.ownerCounts, [credential.owner])).rows[0]).toMatchObject({ groups: 1, intents: 2 });
    // Both requests were admitted and counted; the refused one wrote nothing else.
    expect((await db.admin.query(SQL.windowRow, [credential.owner])).rows).toEqual([{ window_calls: 3, window_throttled: 0, total_throttled: 0 }]);
  });

  it("PGT-115: replace racing cancel, in both orders: the second is refused", async () => {
    const credential = await newCredential(db.admin);

    // Replace first, then cancel.
    const replacedFirst = await startedIntent(db.web, credential);
    const replaceThenCancel = await withCallers(openCaller, ["the replacement", "the cancellation"], ([first, second]) =>
      inOrder(
        db.admin,
        db.secondAdmin,
        first,
        second,
        replacedFirst,
        { statement: "startCheckout", values: [KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, replacedFirst] },
        { statement: "cancelCheckout", values: [KEY_VERSION, credential.digest, replacedFirst] },
      ),
    );
    expectOverlap(replaceThenCancel, "replace, then cancel");
    expect(replaceThenCancel.results).toEqual(["STARTED", "NOT_CANCELABLE"]);
    expect((await db.admin.query(SQL.intentRow, [replacedFirst])).rows[0]).toMatchObject({ state: "SUPERSEDED", row_version: 3 });
    expect((await db.admin.query(SQL.successorsOf, [replacedFirst])).rows).toHaveLength(1);

    // Cancel first, then replace.
    const canceledFirst = await startedIntent(db.web, credential);
    const cancelThenReplace = await withCallers(openCaller, ["the cancellation", "the replacement"], ([first, second]) =>
      inOrder(
        db.admin,
        db.secondAdmin,
        first,
        second,
        canceledFirst,
        { statement: "cancelCheckout", values: [KEY_VERSION, credential.digest, canceledFirst] },
        { statement: "startCheckout", values: [KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, canceledFirst] },
      ),
    );
    expectOverlap(cancelThenReplace, "cancel, then replace");
    expect(cancelThenReplace.results).toEqual(["CANCELED", "REPLACEMENT_NOT_ALLOWED"]);
    expect((await db.admin.query(SQL.intentRow, [canceledFirst])).rows[0]).toMatchObject({ state: "CANCELED_LOCAL", row_version: 3, superseded_by_intent_id: null });
    expect((await db.admin.query(SQL.successorsOf, [canceledFirst])).rows).toEqual([]);
  });

  it("PGT-126 and PGT-144 (c): parallel calls for one owner admit exactly thirty, and two first calls create one row", async () => {
    // PGT-144c: two first calls in parallel, from a row-absent state.
    const pair = await newCredential(db.admin);
    const pairValues = [KEY_VERSION, pair.digest, UNKNOWN_PRODUCT, UNKNOWN_VARIANT, 1, null];
    const firstTwo = await Promise.all([db.web.query(SQL.startCheckout, pairValues), db.web.query(SQL.startCheckout, pairValues)]);
    expect(firstTwo.map((reply) => reply.rows[0].result)).toEqual(["PRODUCT_NOT_IN_MERCHANT_CATALOG", "PRODUCT_NOT_IN_MERCHANT_CATALOG"]);
    expect((await db.admin.query(SQL.windowRow, [pair.owner])).rows).toEqual([{ window_calls: 2, window_throttled: 0, total_throttled: 0 }]);

    // PGT-126: forty at once. Thirty are admitted; ten are throttled; one audit row.
    const credential = await newCredential(db.admin);
    const values = [KEY_VERSION, credential.digest, UNKNOWN_PRODUCT, UNKNOWN_VARIANT, 1, null];
    const replies = await Promise.all(Array.from({ length: 40 }, () => db.web.query(SQL.startCheckout, values)));
    expect(tally(replies.map((reply) => reply.rows[0].result))).toEqual({ PRODUCT_NOT_IN_MERCHANT_CATALOG: 30, RATE_LIMITED: 10 });
    expect((await db.admin.query(SQL.windowRow, [credential.owner])).rows).toEqual([{ window_calls: 30, window_throttled: 10, total_throttled: 10 }]);
    expect((await db.admin.query(SQL.ownerCounts, [credential.owner])).rows[0]).toMatchObject({ groups: 0, intents: 0, rate_limited_audits: 1 });
  });

  it("PGT-81d (from an empty owner, unforced): starts at the same time never take an owner past ten unresolved purchase groups", async () => {
    const credential = await newCredential(db.admin);
    const values = [KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, null];
    const replies = await Promise.all(Array.from({ length: 15 }, () => db.web.query(SQL.startCheckout, values)));
    expect(tally(replies.map((reply) => reply.rows[0].result))).toEqual({ AT_PURCHASE_CAPACITY: 5, STARTED: 10 });
    // Five refusals, five audit rows: no quota.
    expect((await db.admin.query(SQL.ownerCounts, [credential.owner])).rows[0]).toEqual({ groups: 10, intents: 10, rate_limited_audits: 0, capacity_audits: 5 });
    expect((await db.admin.query(SQL.windowRow, [credential.owner])).rows).toEqual([{ window_calls: 15, window_throttled: 0, total_throttled: 0 }]);
  });

  it("PGT-143 (row-present): a session that expires while the call waits on the intent lock is refused, with no side effects", async () => {
    const credential = await newCredential(db.admin);
    // The intent is started through the function, so the owner's request-window row exists.
    const intent = await startedIntent(db.web, credential);
    const windowBefore = (await db.admin.query(SQL.windowRow, [credential.owner])).rows;
    expect(windowBefore).toEqual([{ window_calls: 1, window_throttled: 0, total_throttled: 0 }]);

    const observed = await withCallers(openCaller, ["the expiring call"], ([caller]) => expiryWhileWaiting(db.admin, db.secondAdmin, caller, credential.owner, intent));
    console.info(`PGT-143 (row-present) as observed: ${JSON.stringify({ ...observed, before: undefined, after: undefined })}`);
    expectWaitedAcrossDeadline(observed, "row-present");
    expect(observed.result).toBe("NOT_AUTHORIZED");
    // No side effects: not one row of any table changed, the counter and the challenges included.
    expect(observed.after).toEqual(observed.before);
    expect((await db.admin.query(SQL.windowRow, [credential.owner])).rows).toEqual(windowBefore);
    expect((await db.admin.query(SQL.intentRow, [intent])).rows[0]).toMatchObject({ state: "QUOTED", row_version: 2 });
  });

  it("PGT-143 (row-absent): the same from an owner with no request-window row: refused, and the row stays absent", async () => {
    const credential = await newCredential(db.admin);
    // A valid prebuilt intent: written directly, so no function has run for this owner and it has no window row.
    const intent = await insertFixtureCheckout(db.admin, credential.owner);
    expect((await db.admin.query(SQL.windowRow, [credential.owner])).rows).toEqual([]);
    expect((await db.admin.query(SQL.intentRow, [intent])).rows[0]).toMatchObject({ state: "QUOTED", row_version: 2 });

    const observed = await withCallers(openCaller, ["the expiring call"], ([caller]) => expiryWhileWaiting(db.admin, db.secondAdmin, caller, credential.owner, intent));
    console.info(`PGT-143 (row-absent) as observed: ${JSON.stringify({ ...observed, before: undefined, after: undefined })}`);
    expectWaitedAcrossDeadline(observed, "row-absent");
    expect(observed.result).toBe("NOT_AUTHORIZED");
    // The window row is still absent, and nothing persistent changed anywhere: no group, intent, quote, item,
    // challenge, transition, window, audit row or session row.
    expect((await db.admin.query(SQL.windowRow, [credential.owner])).rows).toEqual([]);
    expect(observed.after).toEqual(observed.before);
    expect((await db.admin.query(SQL.intentRow, [intent])).rows[0]).toMatchObject({ state: "QUOTED", row_version: 2 });
    expect((await db.admin.query(SQL.ownerCounts, [credential.owner])).rows[0]).toEqual({ groups: 1, intents: 1, rate_limited_audits: 0, capacity_audits: 0 });
  });

  it("PGT-124 (c): a call that crosses the window boundary while it waits is counted in the window assigned at step 4, and the next call starts a new one", async () => {
    const observed = await withCallers(openCaller, ["the call across the boundary"], ([caller]) => boundaryWhileWaiting(db.admin, db.secondAdmin, caller));
    console.info(`PGT-124 (c) as observed: ${JSON.stringify(observed)}`);
    expectWaitedAcrossDeadline(observed, "window boundary");
    expect(observed.result).toBe("CANCELED");
    // Counted in the stored window: its start is unchanged and its count is one higher, although the call
    // finished after the boundary.
    expect(observed.windowAfter.window_started_at.getTime()).toBe(observed.windowBefore.window_started_at.getTime());
    expect(observed.windowAfter).toMatchObject({ window_calls: 6, window_throttled: 0 });
    const boundary = observed.windowBefore.window_started_at.getTime() + 60_000;
    expect(observed.windowAfter.updated_at.getTime()).toBeLessThan(boundary);

    // The next call takes its own step 4 reading after the boundary and starts a new window there.
    const next = await db.web.query(SQL.startCheckout, [observed.credential.keyVersion, observed.credential.digest, UNKNOWN_PRODUCT, UNKNOWN_VARIANT, 1, null]);
    expect(next.rows[0].result).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    const renewed = (await db.admin.query(SQL.windowTimes, [observed.credential.owner])).rows[0];
    expect(renewed).toMatchObject({ window_calls: 1, window_throttled: 0 });
    expect(renewed.window_started_at.getTime()).toBeGreaterThanOrEqual(boundary);
    expect(renewed.updated_at.getTime()).toBe(renewed.window_started_at.getTime());
  });

  it("PGT-81d: with nine unresolved groups, new-group checkouts forced to overlap create exactly one more", async () => {
    for (const count of [2, 8]) {
      const credential = await newCredential(db.admin);
      for (let index = 0; index < 9; index += 1) await insertFixtureCheckout(db.admin, credential.owner);
      const labels = Array.from({ length: count }, (_, index) => `checkout ${index + 1} of ${count}`);
      const observed = await withCallers(openCaller, labels, async (callers) => ({
        backends: callers.map((each) => each.pid),
        ...(await overlappingStarts(db.admin, db.secondAdmin, callers, credential)),
      }));
      console.info(
        `PGT-81d (${count} requests) as observed: ${JSON.stringify({ holder: observed.holder.pid, queue: observed.queue.waiters.map(edgesOf), onHolderTransaction: observed.onHolderTransaction, observations: observed.queue.observations, elapsedMs: observed.queue.elapsedMs })}`,
      );
      const ascending = (left: number, right: number): number => left - right;
      // Every request was waiting at once, before any of them moved: the backends that waited are exactly the
      // backends of the callers, each of them distinct.
      expect(new Set(observed.backends).size, `${count} requests`).toBe(count);
      expect(observed.queue.waiters.map((waiter) => waiter.pid).sort(ascending), `${count} requests`).toEqual([...observed.backends].sort(ascending));
      // The queue ends at the holder (the barrier checked every chain). The server may name the holder, an earlier
      // waiter, or both, as what blocks a later waiter: at least one caller waits for the holder itself, on the
      // holder's transaction, and no caller is blocked by anything outside the holder and the other callers.
      expect(observed.queue.waiters.filter((waiter) => waiter.blocked_by.includes(observed.holder.pid)).length, `${count} requests`).toBeGreaterThanOrEqual(1);
      expect(observed.onHolderTransaction, `${count} requests`).toBeGreaterThanOrEqual(1);
      const permitted = [observed.holder.pid, ...observed.backends];
      expect(observed.queue.waiters.flatMap((waiter) => waiter.blocked_by).filter((pid) => !permitted.includes(pid)), `${count} requests`).toEqual([]);
      // Exactly one creation; the rest waited on the owner row and were refused; none raised (no deadlock, no timeout).
      expect(observed.results, `${count} requests`).toHaveLength(count);
      expect(tally(observed.results), `${count} requests`).toEqual({ AT_PURCHASE_CAPACITY: count - 1, STARTED: 1 });
      // The owner ends at exactly ten groups, with one capacity audit row per refusal, and every request was counted.
      expect((await db.admin.query(SQL.ownerCounts, [credential.owner])).rows[0], `${count} requests`).toEqual({ groups: 10, intents: 10, rate_limited_audits: 0, capacity_audits: count - 1 });
      expect((await db.admin.query(SQL.windowRow, [credential.owner])).rows, `${count} requests`).toEqual([{ window_calls: count, window_throttled: 0, total_throttled: 0 }]);
    }
  });

  it("PGT-118 (deletion): a checkout that meets a committed deletion of its variant fails with an error and writes nothing", async () => {
    const product = `dmp_onetest${hex(4)}`;
    const variant = `dmv_onetest${hex(4)}`;
    await db.admin.query(SQL.insertTestProduct, [product]);
    await db.admin.query(SQL.insertTestVariant, [variant, product]);
    try {
      const credential = await newCredential(db.admin);
      const before = (await db.admin.query(SQL.snapshot)).rows[0];
      await withCallers(openCaller, ["the checkout of the deleted variant"], async ([caller]) => {
        const submitted: Array<Promise<Outcome>> = [];
        await holding(db.admin, submitted, async () => {
          // The catalog writer deletes the variant and has not committed: it holds the variant row.
          await db.admin.query(SQL.deleteTestVariant, [variant]);
          const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
          const clock = startClock(OVERLAP_OBSERVATION_MS);
          submitted.push(caller.send({ statement: "startCheckout", values: [credential.keyVersion, credential.digest, product, variant, 1, null] }));
          // The checkout read the catalog without waiting (the deletion is not committed), wrote its intent and quote,
          // and now waits for the variant row at the item's foreign-key check: observed on the server, for its backend.
          const queue = await awaitQueue(db.secondAdmin, holder, clock, [caller], caller.label);
          expect(queue.waiters.map(edgesOf)).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
          expect(await transactionWaits(db.secondAdmin, caller.pid, holder.xid)).toBe(1);
          // Supplementary only; the evidence for "a reprice does not wait" is the direct test below, on the variant
          // row itself. Here, on the merchant row: a catalog writer does not wait for a checkout. The waiting checkout has
          // already written its quote, so it holds the key-share lock its foreign-key check took on the merchant row.
          // A write to that row that changes no key, which is what a reprice is, returns at once. Had it needed to
          // wait for the checkout, the two would have deadlocked here and one of them would have failed.
          expect((await db.admin.query(SQL.touchMerchantName)).rowCount).toBe(1);
          const afterwards = await awaitQueue(db.secondAdmin, holder, clock, [caller], `${caller.label}, after the merchant write`);
          expect(afterwards.waiters.map(edgesOf)).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
          requireTimeToRelease(clock, caller.label);
        });
        // An error, not a result: the item's key to the variant fails once the deletion is committed.
        expect(failureOf((await Promise.all(submitted))[0])).toEqual({ result: null, sqlstate: "23503", constraint: "quote_items_variant_product_fkey" });
      });
      // Nothing was written: no group, intent, quote, transition or audit row, and no request-window row.
      expect((await db.admin.query(SQL.snapshot)).rows[0]).toEqual(before);
      expect((await db.admin.query(SQL.windowRow, [credential.owner])).rows).toEqual([]);
    } finally {
      // The catalog is put back as it was: the variant, if it is still there, and then its product.
      await db.admin.query(SQL.deleteTestVariant, [variant]);
      await db.admin.query(SQL.deleteTestProduct, [product]);
    }
    expect((await db.admin.query(SQL.catalogRowsOf, [product, variant])).rows[0]).toEqual({ products: 0, variants: 0 });
  });

  it("PGT-136: a read sees an uncommitted change not at all, then whole, and never waits for it", async () => {
    const credential = await newCredential(db.admin);
    const intent = await startedIntent(db.web, credential);
    const read = async () => (await db.web.query(SQL.readCheckout, [KEY_VERSION, credential.digest, intent])).rows[0];
    const list = async () => (await db.web.query(SQL.listOwnerCheckouts, [KEY_VERSION, credential.digest])).rows;

    await db.admin.query(SQL.begin);
    try {
      // The cancellation, uncommitted: the test owner's transaction holds the owner, window and intent rows.
      expect((await db.admin.query(SQL.cancelCheckout, [KEY_VERSION, credential.digest, intent])).rows).toEqual([{ result: "CANCELED" }]);
      // The reads return at once (they take no lock), and show the state before the change, whole.
      expect(await read()).toMatchObject({ result: "OK", stored_state: "QUOTED", row_version: 2, effective_status: "QUOTED" });
      expect((await list()).map((row) => `${row.stored_state}:${row.effective_status}`)).toEqual(["QUOTED:QUOTED"]);
      await db.admin.query(SQL.commit);
    } catch (error) {
      await db.admin.query(SQL.rollback);
      throw error;
    }
    // Committed: the change is visible, whole.
    expect(await read()).toMatchObject({ result: "OK", stored_state: "CANCELED_LOCAL", row_version: 3, effective_status: "CANCELED_LOCAL" });
    expect((await list()).map((row) => `${row.stored_state}:${row.effective_status}`)).toEqual(["CANCELED_LOCAL:CANCELED_LOCAL"]);
  });

  it("PGT-12, PGT-117 and PGT-118: a reprice neither blocks a checkout nor is blocked, and a quote never mixes old and new values", async () => {
    const credential = await newCredential(db.admin);
    const original = (await db.admin.query(SQL.variantPrice, [VARIANT])).rows[0];
    const repriced = { unit_amount_cents: original.unit_amount_cents + 100, catalog_revision: original.catalog_revision + 1 };
    try {
      let duringReprice: string;
      await db.admin.query(SQL.begin);
      try {
        // The reprice, uncommitted: the catalog writer holds the variant row.
        await db.admin.query(SQL.repriceVariant, [VARIANT, repriced.unit_amount_cents, repriced.catalog_revision]);
        // The checkout is not blocked by it, and is priced from the committed values: old price with old revision.
        duringReprice = await startedIntent(db.web, credential);
        await db.admin.query(SQL.commit);
      } catch (error) {
        await db.admin.query(SQL.rollback);
        throw error;
      }
      expect((await db.admin.query(SQL.quoteOf, [duringReprice])).rows[0]).toEqual({
        subtotal_cents: original.unit_amount_cents,
        catalog_revision: original.catalog_revision,
        unit_amount_cents: original.unit_amount_cents,
      });
      // After the commit: new price and new revision, together.
      const afterReprice = await startedIntent(db.web, credential);
      expect((await db.admin.query(SQL.quoteOf, [afterReprice])).rows[0]).toEqual({
        subtotal_cents: repriced.unit_amount_cents,
        catalog_revision: repriced.catalog_revision,
        unit_amount_cents: repriced.unit_amount_cents,
      });
      // The earlier quote is now stale, and says so; the later one is not.
      expect((await db.web.query(SQL.readCheckout, [KEY_VERSION, credential.digest, duringReprice])).rows[0].quote_stale).toBe(true);
      expect((await db.web.query(SQL.readCheckout, [KEY_VERSION, credential.digest, afterReprice])).rows[0].quote_stale).toBe(false);
    } finally {
      await db.admin.query(SQL.repriceVariant, [VARIANT, original.unit_amount_cents, original.catalog_revision]);
    }
  });

  it("PGT-12 and PGT-117 (committed while waiting): a replacement that waits on its predecessor while a reprice commits is priced from the new price and the new revision together", async () => {
    const credential = await newCredential(db.admin);
    const predecessor = await startedIntent(db.web, credential);
    const original = (await db.admin.query(SQL.variantPrice, [VARIANT])).rows[0];
    const repriced = { unit_amount_cents: original.unit_amount_cents + 250, catalog_revision: original.catalog_revision + 1 };
    // The predecessor was quoted at the original price and revision.
    expect((await db.admin.query(SQL.quoteOf, [predecessor])).rows[0]).toMatchObject({ unit_amount_cents: original.unit_amount_cents, catalog_revision: original.catalog_revision });

    try {
      const outcome = await withCallers(openCaller, ["the replacement"], async ([caller]) => {
        const submitted: Array<Promise<Outcome>> = [];
        await holding(db.admin, submitted, async () => {
          // The holder holds exactly the predecessor row, and nothing else yet.
          await db.admin.query(SQL.lockIntent, [predecessor]);
          const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
          const clock = startClock(OVERLAP_OBSERVATION_MS);
          submitted.push(caller.send({ statement: "startCheckout", values: [KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, predecessor] }));
          // Observed on the server, while the only row the holder holds is the predecessor: exactly one backend
          // waits, it is the caller's, it is blocked by exactly the holder, on the holder's transaction. The checkout
          // has therefore passed its owner and window locks and stands at step 5, before its catalog read.
          const queue = await awaitQueue(db.secondAdmin, holder, clock, [caller], caller.label);
          expect(queue.waiters.map(edgesOf)).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
          expect(await transactionWaits(db.secondAdmin, caller.pid, holder.xid)).toBe(1);
          // Only now the reprice, in the holder's transaction: price and revision change together.
          await db.admin.query(SQL.repriceVariant, [VARIANT, repriced.unit_amount_cents, repriced.catalog_revision]);
          // Not yet committed: another connection still reads the original values, and the checkout still waits.
          expect((await db.web.query(SQL.variantPrice, [VARIANT])).rows[0]).toEqual(original);
          const afterwards = await awaitQueue(db.secondAdmin, holder, clock, [caller], `${caller.label}, after the uncommitted reprice`);
          expect(afterwards.waiters.map(edgesOf)).toEqual([{ pid: caller.pid, blocked_by: [holder.pid] }]);
          requireTimeToRelease(clock, caller.label);
          // One COMMIT, by `holding`, commits the reprice and releases the predecessor.
        });
        return (await Promise.all(submitted))[0];
      });
      expect(resultOf(outcome)).toBe("STARTED");
      const successor = outcome.kind === "returned" ? String(outcome.row.intent_id) : "";
      // The catalog is read once, after the last lock: the successor's quote carries the committed reprice whole,
      // never the old price with the new revision or the new price with the old one.
      expect((await db.admin.query(SQL.quoteOf, [successor])).rows[0]).toEqual({
        subtotal_cents: repriced.unit_amount_cents,
        catalog_revision: repriced.catalog_revision,
        unit_amount_cents: repriced.unit_amount_cents,
      });
      // The predecessor's quote is untouched and is now stale; the successor's is not.
      expect((await db.admin.query(SQL.quoteOf, [predecessor])).rows[0]).toMatchObject({ unit_amount_cents: original.unit_amount_cents, catalog_revision: original.catalog_revision });
      expect((await db.admin.query(SQL.intentRow, [predecessor])).rows[0]).toMatchObject({ state: "SUPERSEDED", row_version: 3, superseded_by_intent_id: successor });
      expect((await db.web.query(SQL.readCheckout, [KEY_VERSION, credential.digest, predecessor])).rows[0].quote_stale).toBe(true);
      expect((await db.web.query(SQL.readCheckout, [KEY_VERSION, credential.digest, successor])).rows[0].quote_stale).toBe(false);
    } finally {
      await db.admin.query(SQL.repriceVariant, [VARIANT, original.unit_amount_cents, original.catalog_revision]);
    }
  });

  it("PGT-118 (direct): a reprice of a variant completes while a checkout that quoted it holds its foreign-key lock on that variant, open and uncommitted", async () => {
    // Two test-owner connections. db.admin is the holder: it runs a checkout inside a transaction and keeps it open,
    // so the key-share lock the item's foreign-key check took on the variant row stays held. db.secondAdmin is the
    // catalog writer. The operator pool only observes.
    const credential = await newCredential(db.admin);
    const original = (await db.admin.query(SQL.variantPrice, [VARIANT])).rows[0];
    const repriced = { unit_amount_cents: original.unit_amount_cents + 500, catalog_revision: original.catalog_revision + 1 };
    const writerPid = (await db.secondAdmin.query(SQL.backendPid)).rows[0].pid;
    // How long the test looks for the writer's lock wait: 600 ms, against the 1500 ms lock timeout of that request.
    const OBSERVATION_DEADLINE_MS = 600;
    let heldIntent: string | null = null;
    try {
      await db.admin.query(SQL.begin);
      try {
        // The holder: a complete checkout of the variant, not committed.
        const started = (await db.admin.query(SQL.startCheckout, [credential.keyVersion, credential.digest, PRODUCT, VARIANT, 1, null])).rows[0];
        expect(started.result).toBe("STARTED");
        heldIntent = started.intent_id;
        const holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
        expect(holder.pid).not.toBe(writerPid);
        // Its rows exist for the holder alone: the transaction is open.
        expect((await db.admin.query(SQL.intentVisible, [heldIntent])).rows[0].n).toBe(1);
        expect((await db.secondAdmin.query(SQL.intentVisible, [heldIntent])).rows[0].n).toBe(0);

        // 1. The lock is established, on the intended row, by the holder. The writer asks for the one lock a
        //    key-share lock conflicts with, FOR UPDATE on that variant row, under a short lock timeout of its own.
        //    While that request waits, the server names the backends it waits for: exactly the holder. It then
        //    times out; it is never granted.
        let blockers: number[] = [];
        let request: Promise<string | null> | null = null;
        await db.secondAdmin.query(SQL.begin);
        try {
          await db.secondAdmin.query(SQL.setLocalLockTimeout);
          const requestSentAt = Date.now();
          request = db.secondAdmin.query(SQL.lockVariantForUpdate, [VARIANT]).then(
            () => null,
            (error: unknown) => sqlStateOf(error),
          );
          // The observation window is bounded by a deadline of its own, well inside the request's lock timeout of
          // 1500 ms. The clock was read before the request was sent, so the server's timeout cannot fall earlier
          // than 1500 ms after it. No observing query is started at or after 600 ms; the last one may be followed
          // by one 5 ms pause, and so has about 900 ms to return before the request can time out. The clock only
          // ends the polling: what counts as the lock is the server's answer, never the time that passed.
          let polls = 0;
          while (blockers.length === 0 && Date.now() - requestSentAt < OBSERVATION_DEADLINE_MS) {
            blockers = (await db.operator.query(SQL.blockersOf, [writerPid])).rows[0].blocked_by;
            polls += 1;
            if (blockers.length === 0) await db.operator.query(SQL.shortSleep);
          }
          if (blockers.length === 0) {
            const outcome = (await request) ?? "the lock request succeeded";
            const elapsed = Date.now() - requestSentAt;
            throw new Error(
              `PGT-118: the server never reported the writer waiting on a lock within ${OBSERVATION_DEADLINE_MS} ms ` +
                `(${polls} observations, ${elapsed} ms); its lock request ended with ${outcome}`,
            );
          }
          expect(blockers).toEqual([holder.pid]);
          expect(await request).toBe("55P03");
        } finally {
          // The request is settled before anything else is sent on this connection; then its transaction ends.
          await Promise.allSettled([request]);
          await db.secondAdmin.query(SQL.rollback);
        }

        // 2. The reprice: price and revision, no key column, on the independent connection, in a transaction of its
        //    own that commits. Its lock timeout is a bound for the test, not a condition of success: were the update
        //    to wait for the holder at all, it would fail here instead of hanging.
        let updated: number | null = null;
        await db.secondAdmin.query(SQL.begin);
        try {
          await db.secondAdmin.query(SQL.setLocalLockTimeout);
          updated = (await db.secondAdmin.query(SQL.repriceVariant, [VARIANT, repriced.unit_amount_cents, repriced.catalog_revision])).rowCount;
          await db.secondAdmin.query(SQL.commit);
        } catch (error) {
          await db.secondAdmin.query(SQL.rollback);
          throw error;
        }
        expect(updated).toBe(1);

        // 3. The reprice completed, and is committed, BEFORE the holder was released. The holder is still in the
        //    same transaction, its checkout still invisible to everyone else; and every other connection already
        //    reads the new price and revision. Nothing waits on a lock.
        expect((await db.admin.query(SQL.backendAndTransaction)).rows[0]).toEqual(holder);
        expect((await db.secondAdmin.query(SQL.intentVisible, [heldIntent])).rows[0].n).toBe(0);
        expect((await db.secondAdmin.query(SQL.variantPrice, [VARIANT])).rows[0]).toEqual(repriced);
        expect((await db.web.query(SQL.variantPrice, [VARIANT])).rows[0]).toEqual(repriced);
        expect((await db.secondAdmin.query(SQL.lockWaits)).rows).toEqual([]);
        expect((await db.secondAdmin.query(SQL.openTransactions)).rows[0].n).toBe(1);

        // Only now is the holder released.
        await db.admin.query(SQL.commit);
      } catch (error) {
        await db.admin.query(SQL.rollback);
        throw error;
      }
      if (heldIntent === null) throw new Error("the holder's checkout was not started");

      // The checkout committed after the reprice and keeps what it was quoted: the price and the revision it read.
      expect((await db.admin.query(SQL.quoteOf, [heldIntent])).rows[0]).toEqual({
        subtotal_cents: original.unit_amount_cents,
        catalog_revision: original.catalog_revision,
        unit_amount_cents: original.unit_amount_cents,
      });
      // Foreign-key integrity is whole: the item still names one existing variant of its product, which now
      // carries the repriced values; and the quote, read back, says it is stale.
      expect((await db.admin.query(SQL.itemVariantOf, [heldIntent])).rows[0]).toEqual({
        matched: 1,
        variant_amount: repriced.unit_amount_cents,
        variant_revision: repriced.catalog_revision,
      });
      expect((await db.web.query(SQL.readCheckout, [credential.keyVersion, credential.digest, heldIntent])).rows[0]).toMatchObject({ result: "OK", stored_state: "QUOTED", quote_stale: true });
    } finally {
      // Cleanup: the catalog is put back by the holder's connection.
      await db.admin.query(SQL.repriceVariant, [VARIANT, original.unit_amount_cents, original.catalog_revision]);
    }
    // Nothing is left behind: the variant is as it was, no transaction is open on either connection, nothing waits.
    expect((await db.secondAdmin.query(SQL.variantPrice, [VARIANT])).rows[0]).toEqual(original);
    expect((await db.admin.query(SQL.openTransactions)).rows[0].n).toBe(0);
    expect((await db.admin.query(SQL.lockWaits)).rows).toEqual([]);
    if (heldIntent !== null) expect((await db.admin.query(SQL.itemVariantOf, [heldIntent])).rows[0].matched).toBe(1);
  });

  it("PGT-136 (stress and control): reads taken while a checkout is being replaced are always one whole state; a two-statement reader is not", async () => {
    const credential = await newCredential(db.admin);
    const WHOLE_STATES = ["QUOTED:2:none", "SUPERSEDED:3:successor"];
    const seen = new Set<string>();
    // Eight rounds: each leaves one unresolved purchase group, and the owner may hold ten.
    for (let round = 0; round < 8; round += 1) {
      const predecessor = await startedIntent(db.web, credential);
      const readValues = [credential.keyVersion, credential.digest, predecessor];
      // One replacement and eight reads at once, on separate connections of the pool.
      const [replacement, ...reads] = await Promise.all([
        db.web.query(SQL.startCheckout, [credential.keyVersion, credential.digest, PRODUCT, VARIANT, 1, predecessor]),
        ...Array.from({ length: 8 }, () => db.web.query(SQL.readCheckout, readValues)),
      ]);
      expect(replacement.rows[0].result, `round ${round}`).toBe("STARTED");
      for (const read of reads) {
        const row = read.rows[0];
        expect(row.result, `round ${round}`).toBe("OK");
        const state = `${row.stored_state}:${row.row_version}:${row.superseded_by_intent_id === null ? "none" : "successor"}`;
        seen.add(state);
        // Never the state of one version with the version or the pointer of another.
        expect(WHOLE_STATES, `round ${round}`).toContain(state);
        // A successor pointer, when it is there, names the one successor.
        if (row.superseded_by_intent_id !== null) expect(row.superseded_by_intent_id, `round ${round}`).toBe(replacement.rows[0].intent_id);
      }
    }
    // Which of the two states each read met is not fixed; what was met is recorded with the run.
    console.info(`PGT-136 stress: states seen by concurrent reads: ${JSON.stringify([...seen].sort())}`);

    // Control: a reader made of two statements, with a committed change between them, does put together a state
    // that never existed. This is what the single statement of read_checkout rules out.
    const intent = await startedIntent(db.web, credential);
    const stateFirst = (await db.admin.query(SQL.stateOf, [intent])).rows[0].state;
    expect((await db.web.query(SQL.cancelCheckout, [credential.keyVersion, credential.digest, intent])).rows).toEqual([{ result: "CANCELED" }]);
    const versionSecond = (await db.admin.query(SQL.versionOf, [intent])).rows[0].row_version;
    const mixed = `${stateFirst}:${versionSecond}:none`;
    expect(mixed).toBe("QUOTED:3:none");
    expect([...WHOLE_STATES, "CANCELED_LOCAL:3:none"]).not.toContain(mixed);
    const whole = (await db.web.query(SQL.readCheckout, [credential.keyVersion, credential.digest, intent])).rows[0];
    expect(`${whole.stored_state}:${whole.row_version}`).toBe("CANCELED_LOCAL:3");
  });

  it("PGT-132 (session rotation and revocation overlapping a call): the call waits for the session row and is then refused, with no side effects", async () => {
    // Rotation. The call presents the credential as it was; when the rotation commits, the exact credential no
    // longer finds a row, and the call ends at step 2.
    const rotating = await newCredential(db.admin);
    const rotatingIntent = await startedIntent(db.web, rotating);
    const rotatingWindow = (await db.admin.query(SQL.windowTimes, [rotating.owner])).rows;
    const newDigest = hex(32);
    const rotation = await withCallers(openCaller, ["the call"], ([caller]) => whileSessionChanges(db.admin, db.secondAdmin, caller, "rotation", rotating, newDigest, rotatingIntent));
    expect(rotation).toEqual({ result: "NOT_AUTHORIZED", blockedByBlocker: 1, waitsOnBlockerTransaction: 1 });
    expect((await db.admin.query(SQL.intentRow, [rotatingIntent])).rows[0]).toMatchObject({ state: "QUOTED", row_version: 2 });
    expect((await db.admin.query(SQL.windowTimes, [rotating.owner])).rows).toEqual(rotatingWindow);
    expect((await db.admin.query(SQL.ownerCounts, [rotating.owner])).rows[0]).toEqual({ groups: 1, intents: 1, rate_limited_audits: 0, capacity_audits: 0 });
    // The rotated credential is the session now: it reaches the same checkout.
    expect((await db.web.query(SQL.cancelCheckout, [rotating.keyVersion, newDigest, rotatingIntent])).rows).toEqual([{ result: "CANCELED" }]);

    // Revocation (case B2 for a session). The row is still found by the exact credential, now revoked: the call is
    // refused at the step 4 revalidation.
    const revoked = await newCredential(db.admin);
    const revokedIntent = await startedIntent(db.web, revoked);
    const revokedWindow = (await db.admin.query(SQL.windowTimes, [revoked.owner])).rows;
    const revocation = await withCallers(openCaller, ["the call"], ([caller]) => whileSessionChanges(db.admin, db.secondAdmin, caller, "revocation", revoked, revoked.digest, revokedIntent));
    expect(revocation).toEqual({ result: "NOT_AUTHORIZED", blockedByBlocker: 1, waitsOnBlockerTransaction: 1 });
    expect((await db.admin.query(SQL.intentRow, [revokedIntent])).rows[0]).toMatchObject({ state: "QUOTED", row_version: 2 });
    expect((await db.admin.query(SQL.windowTimes, [revoked.owner])).rows).toEqual(revokedWindow);
    // Case B1 for a session: revoked before the call starts.
    expect((await db.web.query(SQL.cancelCheckout, [revoked.keyVersion, revoked.digest, revokedIntent])).rows).toEqual([{ result: "NOT_AUTHORIZED" }]);
    expect((await db.web.query(SQL.readCheckout, [revoked.keyVersion, revoked.digest, revokedIntent])).rows[0].result).toBe("NOT_AUTHORIZED");
    expect((await db.admin.query(SQL.windowTimes, [revoked.owner])).rows).toEqual(revokedWindow);
  });

  it("PGT-132 (case A for a session): a revocation or a rotation sent after the call holds the session row waits for it; the call completes; the change completes afterward", async () => {
    for (const change of ["revocation", "rotation"] as const) {
      const credential = await newCredential(db.admin);
      const intent = await startedIntent(db.web, credential);
      const newDigest = hex(32);
      const observed = await withCallers(openCaller, ["the checkout call", "the session change"], ([checkoutCaller, changeCaller]) =>
        whileCallHoldsSession(db.admin, db.secondAdmin, checkoutCaller, changeCaller, change, credential, newDigest, intent),
      );
      // First the checkout call alone waited, for the holder alone. Then two backends waited at once: the checkout
      // call still behind the holder, and the session change behind the checkout call alone, for the session row
      // that call holds.
      expect(observed.alone, change).toEqual([{ pid: observed.checkoutBackend, blocked_by: [observed.holder.pid] }]);
      expect(observed.waits, change).toHaveLength(2);
      expect(observed.waits.filter((wait) => wait.pid === observed.checkoutBackend).map((wait) => wait.blocked_by), change).toEqual([[observed.holder.pid]]);
      expect(observed.waits.filter((wait) => wait.pid !== observed.checkoutBackend).map((wait) => wait.blocked_by), change).toEqual([[observed.checkoutBackend]]);
      // The call completed while its credential was still valid. The change completed afterward.
      expect(observed.checkoutResult, change).toBe("CANCELED");
      expect(observed.changeResult, change).toBe(change === "revocation" ? "DONE" : "ROTATED");
      expect((await db.admin.query(SQL.intentRow, [intent])).rows[0], change).toMatchObject({ state: "CANCELED_LOCAL", row_version: 3 });
      // A later call with the credential as it was is refused, and changes nothing of that owner.
      const windowBefore = (await db.admin.query(SQL.windowTimes, [credential.owner])).rows;
      const later = await db.web.query(SQL.startCheckout, [credential.keyVersion, credential.digest, PRODUCT, VARIANT, 1, null]);
      expect(later.rows[0].result, change).toBe("NOT_AUTHORIZED");
      expect((await db.admin.query(SQL.windowTimes, [credential.owner])).rows, change).toEqual(windowBefore);
      expect((await db.admin.query(SQL.ownerCounts, [credential.owner])).rows[0], change).toMatchObject({ groups: 1, intents: 1 });
      // After a rotation the new credential is the session, with the same owner and the same counter.
      if (change === "rotation") {
        const rotated = await db.web.query(SQL.startCheckout, [credential.keyVersion, newDigest, PRODUCT, VARIANT, 1, null]);
        expect(rotated.rows[0].result).toBe("STARTED");
        expect((await db.admin.query(SQL.ownerCounts, [credential.owner])).rows[0]).toMatchObject({ groups: 2, intents: 2 });
      }
    }
  });

  // This test changes the session key versions of the database, so it is the last one of the file.
  it("PGT-132 (key versions): activation during a call, and key revocation cases A, B1 and B2", async () => {
    const statuses = async (): Promise<string[]> => (await db.admin.query(SQL.keyStatuses)).rows.map((row) => `${row.key_version}:${row.status}`);
    expect(await statuses()).toEqual(["1:ACTIVE"]);

    await withCallers(openCaller, ["the call during the activation", "the case A call", "the case B2 call"], async ([activationCaller, caseACaller, caseB2Caller]) => {
      // --- Activation during a call. A newer key is activated while a call under version 1 waits: the session's key
      // becomes VERIFY_ONLY, which is valid, and the call succeeds.
      const first = await newCredential(db.admin);
      const firstIntent = await startedIntent(db.web, first);
      const activationCalls: Array<Promise<Outcome>> = [];
      await holding(db.admin, activationCalls, async () => {
        await db.admin.query(SQL.lockIntent, [firstIntent]);
        const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
        const clock = startClock(OVERLAP_OBSERVATION_MS);
        activationCalls.push(activationCaller.send({ statement: "cancelCheckout", values: [1, first.digest, firstIntent] }));
        const queue = await awaitQueue(db.secondAdmin, holder, clock, [activationCaller], activationCaller.label);
        expect(queue.waiters.map(edgesOf)).toEqual([{ pid: activationCaller.pid, blocked_by: [holder.pid] }]);
        // The activation neither waits for the call nor is waited for: no key-version row is locked by a checkout call.
        const activated = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 2, hex(32)]);
        expect(activated.rows[0].result).toBe("ACTIVATED");
        expect(await statuses()).toEqual(["1:VERIFY_ONLY", "2:ACTIVE"]);
        requireTimeToRelease(clock, activationCaller.label);
      });
      expect(resultOf((await Promise.all(activationCalls))[0])).toBe("CANCELED");
      // A session under a VERIFY_ONLY key stays authorized for later calls too.
      const firstAgain = await startedIntent(db.web, first);

      // --- Case A. The checkout call locks the session row first; the revocation of its key waits for that row; the
      // call completes while the credential is still valid; the revocation completes afterward.
      const second = await newCredential(db.admin, NOW, NOW, null, 2);
      const secondStart = (await db.web.query(SQL.startCheckout, [2, second.digest, PRODUCT, VARIANT, 1, null])).rows[0];
      expect(secondStart.result).toBe("STARTED");
      const caseACalls: Array<Promise<Outcome>> = [];
      const caseARevocations: Array<Promise<{ result: string; sessions_revoked: number | null; was_active: boolean | null }>> = [];
      const caseASubmitted: Array<Promise<unknown>> = [];
      // The operator login, read from the server on the operator pool before anything is held: the login the key
      // revocation below is sent under.
      const operatorLogin = String((await db.operator.query(SQL.sessionLogin)).rows[0].login);
      await holding(db.admin, caseASubmitted, async () => {
        await db.admin.query(SQL.lockIntent, [secondStart.intent_id]);
        const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
        const clock = startClock(OVERLAP_OBSERVATION_MS);
        const checkoutCall = caseACaller.send({ statement: "cancelCheckout", values: [2, second.digest, secondStart.intent_id] });
        caseACalls.push(checkoutCall);
        caseASubmitted.push(checkoutCall);
        // The checkout backend is the caller's own: it is the one backend that waits, for the holder alone.
        const alone = await awaitQueue(db.secondAdmin, holder, clock, [caseACaller], caseACaller.label);
        expect(alone.waiters.map(edgesOf)).toEqual([{ pid: caseACaller.pid, blocked_by: [holder.pid] }]);
        // The key revocation is the operator's statement and is sent through the operator pool; both handlers are
        // attached as it is sent. The harness has no operator client of its own, so this one waiter is not known by
        // its backend beforehand. It is identified by what the server reports instead: it is the one waiting backend
        // that is not the caller's, its login is exactly the operator login, and it waits for the caller's backend alone.
        const keyChange = db.operator.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["session", 2]).then(
          (reply) => reply.rows[0],
          (error: unknown) => ({ result: `ERROR ${sqlStateOf(error)}`, sessions_revoked: null, was_active: null }),
        );
        caseARevocations.push(keyChange);
        caseASubmitted.push(keyChange);
        const both = await awaitQueue(db.secondAdmin, holder, clock, [caseACaller], `${caseACaller.label} and the key change behind it`, 1);
        const callerRole = both.waiters.filter((waiter) => waiter.pid === caseACaller.pid).map((waiter) => waiter.role);
        const behind = both.waiters.filter((waiter) => waiter.pid !== caseACaller.pid);
        expect(behind.map((waiter) => waiter.blocked_by)).toEqual([[caseACaller.pid]]);
        expect(callerRole).toHaveLength(1);
        expect(behind.map((waiter) => waiter.role)).toEqual([operatorLogin]);
        expect(operatorLogin).not.toBe(callerRole[0]);
        // While it waits, the key is still ACTIVE: the sessions are locked before the status is changed.
        expect(await statuses()).toEqual(["1:VERIFY_ONLY", "2:ACTIVE"]);
        requireTimeToRelease(clock, caseACaller.label);
      });
      expect(resultOf((await Promise.all(caseACalls))[0])).toBe("CANCELED");
      expect((await Promise.all(caseARevocations))[0]).toEqual({ result: "REVOKED", sessions_revoked: 1, was_active: true });
      expect(await statuses()).toEqual(["1:VERIFY_ONLY", "2:REVOKED"]);
      // A later call with that credential is refused, and changes nothing of that owner.
      const secondCounts = (await db.admin.query(SQL.ownerCounts, [second.owner])).rows[0];
      const secondWindow = (await db.admin.query(SQL.windowTimes, [second.owner])).rows;
      expect((await db.web.query(SQL.startCheckout, [2, second.digest, PRODUCT, VARIANT, 1, null])).rows[0].result).toBe("NOT_AUTHORIZED");
      expect((await db.admin.query(SQL.ownerCounts, [second.owner])).rows[0]).toEqual(secondCounts);
      expect((await db.admin.query(SQL.windowTimes, [second.owner])).rows).toEqual(secondWindow);

      // --- Case B1. The revocation commits before the call starts.
      const firstCounts = (await db.admin.query(SQL.ownerCounts, [first.owner])).rows[0];
      const firstWindow = (await db.admin.query(SQL.windowTimes, [first.owner])).rows;
      const revokedFirst = await db.operator.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["session", 1]);
      expect(revokedFirst.rows[0]).toMatchObject({ result: "REVOKED", was_active: false });
      expect((await db.web.query(SQL.cancelCheckout, [1, first.digest, firstAgain])).rows).toEqual([{ result: "NOT_AUTHORIZED" }]);
      expect((await db.web.query(SQL.readCheckout, [1, first.digest, firstAgain])).rows[0].result).toBe("NOT_AUTHORIZED");
      expect((await db.admin.query(SQL.ownerCounts, [first.owner])).rows[0]).toEqual(firstCounts);
      expect((await db.admin.query(SQL.windowTimes, [first.owner])).rows).toEqual(firstWindow);
      expect((await db.admin.query(SQL.intentRow, [firstAgain])).rows[0]).toMatchObject({ state: "QUOTED", row_version: 2 });

      // --- Case B2. The revocation locks the session row first and commits while the checkout call waits for it.
      expect((await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 3, hex(32)])).rows[0].result).toBe("ACTIVATED");
      const third = await newCredential(db.admin, NOW, NOW, null, 3);
      const thirdStart = (await db.web.query(SQL.startCheckout, [3, third.digest, PRODUCT, VARIANT, 1, null])).rows[0];
      expect(thirdStart.result).toBe("STARTED");
      const thirdWindow = (await db.admin.query(SQL.windowTimes, [third.owner])).rows;
      const caseB2Calls: Array<Promise<Outcome>> = [];
      await holding(db.admin, caseB2Calls, async () => {
        // The revocation, in the holder's transaction and not committed: it holds the key row and the session row.
        const revoking = await db.admin.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["session", 3]);
        expect(revoking.rows[0]).toMatchObject({ result: "REVOKED", sessions_revoked: 1, was_active: true });
        const holder: Holder = (await db.admin.query(SQL.backendAndTransaction)).rows[0];
        const clock = startClock(OVERLAP_OBSERVATION_MS);
        // The call finds the session live at step 0 (the revocation is not committed) and waits for its row at step 2.
        caseB2Calls.push(caseB2Caller.send({ statement: "cancelCheckout", values: [3, third.digest, thirdStart.intent_id] }));
        const queue = await awaitQueue(db.secondAdmin, holder, clock, [caseB2Caller], caseB2Caller.label);
        expect(queue.waiters.map(edgesOf)).toEqual([{ pid: caseB2Caller.pid, blocked_by: [holder.pid] }]);
        expect(await transactionWaits(db.secondAdmin, caseB2Caller.pid, holder.xid)).toBe(1);
        requireTimeToRelease(clock, caseB2Caller.label);
      });
      // It then reads the revoked session: NOT_AUTHORIZED, and nothing of that owner changed.
      expect(resultOf((await Promise.all(caseB2Calls))[0])).toBe("NOT_AUTHORIZED");
      expect((await db.admin.query(SQL.intentRow, [thirdStart.intent_id])).rows[0]).toMatchObject({ state: "QUOTED", row_version: 2 });
      expect((await db.admin.query(SQL.windowTimes, [third.owner])).rows).toEqual(thirdWindow);
      expect((await db.admin.query(SQL.ownerCounts, [third.owner])).rows[0]).toEqual({ groups: 1, intents: 1, rate_limited_audits: 0, capacity_audits: 0 });
      expect(await statuses()).toEqual(["1:REVOKED", "2:REVOKED", "3:REVOKED"]);
    });
  });
});
