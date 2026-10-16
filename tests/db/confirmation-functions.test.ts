import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { APPROVED_MIGRATIONS } from "@/lib/pg/migrate";
import { OPERATOR_STATEMENTS } from "@/lib/pg/statements";
import { adminUrl, hex, INSUFFICIENT_PRIVILEGE, openDisposableDatabase, sqlState, TEST_NONCE_KEY, type DisposableDatabase } from "./harness";

// NEVER RUN. Written for the Increment 2.2 confirmation functions (migration 0009); running it needs a separate
// authorization and a new disposable PostgreSQL 17 cluster (see ./harness). Nothing here is evidence until it has
// been run.
//
// Scope: the single-connection part of the Increment 2.2 acceptance map (specification 19.15): issue_challenge,
// consume_challenge and the 41-column read_checkout, called as the web role through the fixed statements below.
// Fixtures and observations are direct statements of the test owner. Cases that need two connections at once are in
// confirmation-concurrency.test.ts.
//
// Statements: every statement this file sends is a fixed string, written where it is sent or held in the table SQL.
// Values travel only as bound parameters. The static test PGT-157 reads this file and depends on that.
//
// Failure injection (policy P4), and nothing wider:
//  - Case S3: two of the three reviewed PGT-112(c) fixture statements, the suppressing function and its trigger on
//    checkout_transitions, written inside withSuppressedInsert.
//  - Cases A4 to A8: one of the four reviewed PGT-128 statements, the one that takes INSERT on audit_events away
//    from the function owner, written inside withRevokedPrivilege.
// Each of the two functions begins a transaction on one client (db.admin), always rolls it back and never ends it
// any other way. No other statement of this file creates, replaces, alters or switches off anything, and none
// changes a privilege.
//
// Secrets: the nonces and digests used here are test values. None is printed.

const PRODUCT = "dmp_codebook15";
const VARIANT = "dmv_codebook15a";
const UNIT_AMOUNT = 79900;
const SESSION_KEY_VERSION = 1;

const ISOLATION_REFUSED = "0A000";
const IN_FAILED_TRANSACTION = "25P02";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

// PGT-228: the four frozen vectors (see tests/unit/pg-confirmation-nonce.test.ts for the keys and the messages).
// They were calculated twice, independently, before they were written down, and are never changed to fit.
const NONCE_VECTORS = [
  { name: "N1", nonce: "s6YDyA52ViQxQOPq89wqhAlqSLJeI-xLkrkLkMWv4uk", digest: "2fffb9607e72006eba685e7ddac819d13bec2c94a5c1182610e2db0d80577d6f" },
  { name: "N2", nonce: "7IirXIi7dOMrGYwAv_3I0qr5Xvc9EUb0-bD8_8mUYM4", digest: "143c49a989609bee83eeecc39619f5134a5005d01043aa8b3b366f21f87eb3c0" },
  { name: "N3", nonce: "CoLAXKDMy56xa6nTQYmybwZKnHsTaaHgoA5L843nA40", digest: "ec6af46bc975178a0317ffcf6c7c3aa7fb9cd138a058f21c62dac5ea104fa412" },
  { name: "N4", nonce: "gFYgk02NaZ-eb2bVIHVLC04SDbLm86P-Wk0g62Zczcs", digest: "f81b260f570657ef3ca1815da045acc92c47e05ab193ce7aa321dc727e953b0f" },
] as const;

// PGT-229: fixed values that must appear in no audit detail and in no retained output of a run. The session digest
// and the challenge id are used only by that test; the nonces and the nonce digest are those of N1 and N2.
const SENTINEL_SESSION_DIGEST = "5e".repeat(32);
const SENTINEL_REJECTED_CHALLENGE = `cf_${"9a".repeat(16)}`;

/** Every statement of this file that is not written where it is sent. Each is a fixed string. */
const SQL = {
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",
  beginRepeatableRead: "BEGIN ISOLATION LEVEL REPEATABLE READ",
  beginSerializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
  beginReadUncommitted: "BEGIN ISOLATION LEVEL READ UNCOMMITTED",
  selectOne: "SELECT 1 AS one",

  // The entry points, exactly as the reviewed catalogue has them (the static suite compares the two).
  startCheckout: "SELECT result, intent_id, quote_id, quote_expires_at FROM shopaccess_api.start_checkout($1, $2, $3, $4, $5, $6)",
  cancelCheckout: "SELECT result FROM shopaccess_api.cancel_checkout($1, $2, $3)",
  readCheckout:
    "SELECT result, owner_id, intent_id, purchase_group_id, stored_state, row_version, effective_status, replaces_intent_id, superseded_by_intent_id, intent_created_at, intent_updated_at, quote_id, merchant_id, merchant_display_name, product_id, product_title, variant_id, variant_label, quantity, unit_amount_cents, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, currency, assumptions_code, catalog_revision, quote_digest, quote_created_at, quote_expires_at, quote_stale, database_time, challenge_id, challenge_quote_digest, challenge_nonce_key_version, challenge_nonce_digest, challenge_summary, challenge_issued_at, challenge_expires_at, challenge_usable FROM shopaccess_api.read_checkout($1, $2, $3)",
  issueChallenge:
    "SELECT result, challenge_id, quote_digest, nonce_key_version, nonce_digest, summary, expires_at FROM shopaccess_api.issue_challenge($1, $2, $3, $4, $5, $6)",
  consumeChallenge: "SELECT result, intent_id FROM shopaccess_api.consume_challenge($1, $2, $3, $4, $5, $6)",

  // Fixtures, written by the test owner. P6: the owner row first, then the intent row.
  lockOwner: "SELECT id FROM shopaccess.checkout_owners WHERE id = $1 FOR UPDATE",
  lockIntent: "SELECT id FROM shopaccess.checkout_intents WHERE id = $1 FOR UPDATE",
  insertOwner: "INSERT INTO shopaccess.checkout_owners (id, created_at) VALUES ($1, pg_catalog.clock_timestamp() + $2::interval)",
  insertSession:
    "INSERT INTO shopaccess.shopper_sessions (id, owner_id, key_version, token_digest, created_at, last_seen_at, absolute_expires_at) " +
    "SELECT $1, $2, 1, $3, t.now + $4::interval, t.now + $5::interval, t.now + $4::interval + interval '24 hours' " +
    "FROM (SELECT pg_catalog.clock_timestamp() AS now) t",
  insertGroup: "INSERT INTO shopaccess.purchase_groups (id, owner_id, created_at) VALUES ($1, $2, $3::timestamptz)",
  insertIntent:
    "INSERT INTO shopaccess.checkout_intents (id, owner_id, purchase_group_id, replaces_intent_id, state, row_version, current_quote_id, created_at, updated_at) " +
    "VALUES ($1, $2, $3, NULL, 'QUOTED', 2, $4, $5::timestamptz, $5::timestamptz)",
  // The sixth value is the stored digest. NULL stores the digest the helper of start_checkout computes; a value is
  // stored as it is, which is how a quote whose stored digest is not the digest of its own fields is made.
  insertQuote:
    "INSERT INTO shopaccess.quotes (id, owner_id, checkout_intent_id, merchant_id, catalog_revision, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, currency, assumptions_code, created_at, expires_at, digest, digest_version) " +
    "SELECT f.quote_id, f.owner_id, f.intent_id, 'dmm_shopaccessdemo', 1, 79900, 0, 0, 0, 79900, 'USD', 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1', f.created_at, f.created_at + interval '15 minutes', " +
    "coalesce(f.stored_digest, shopaccess_api.quote_digest_saqd1(f.quote_id, f.owner_id, f.intent_id, f.group_id, 'dmm_shopaccessdemo', 'dmp_codebook15', 'dmv_codebook15a', 1::bigint, 1::bigint, 79900::bigint, 79900::bigint, 0::bigint, 0::bigint, 0::bigint, 79900::bigint, 'USD', 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1', f.created_at, f.created_at + interval '15 minutes')), 'SAQD-1' " +
    "FROM (SELECT $1::text AS quote_id, $2::text AS owner_id, $3::text AS intent_id, $4::text AS group_id, $5::timestamptz AS created_at, $6::text AS stored_digest) f",
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
  // issue and expiry times as intervals from the database clock. The seventh value is the digest it is bound to;
  // NULL binds it to the quote's stored digest.
  insertChallenge:
    "INSERT INTO shopaccess.confirmation_challenges (id, owner_id, checkout_intent_id, quote_id, quote_digest, nonce_digest, nonce_key_version, summary, status, issued_at, expires_at) " +
    "SELECT $1::text, q.owner_id, q.checkout_intent_id, q.id, coalesce($7::text, q.digest), $2::text, $4::smallint, '{}'::jsonb, 'ACTIVE', t.now + $5::interval, t.now + $6::interval " +
    "FROM shopaccess.quotes q, (SELECT pg_catalog.clock_timestamp() AS now) t WHERE q.id = $3",
  supersedeChallengeDirectly: "UPDATE shopaccess.confirmation_challenges SET status = 'SUPERSEDED', superseded_at = issued_at + interval '1 second' WHERE id = $1",
  expireChallengeDirectly: "UPDATE shopaccess.confirmation_challenges SET status = 'EXPIRED', expired_marked_at = expires_at WHERE id = $1",
  consumeChallengeDirectly: "UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = issued_at WHERE id = $1",
  insertWindow:
    "INSERT INTO shopaccess.owner_request_windows (owner_id, window_started_at, window_calls, window_throttled, total_throttled, updated_at) " +
    "SELECT $1, t.now + $2::interval, $3::integer, 0, 0, t.now + $2::interval FROM (SELECT pg_catalog.clock_timestamp() AS now) t",
  setVariantAmount: "UPDATE shopaccess.merchant_variants SET unit_amount_cents = $2 WHERE id = $1",
  variantAmount: "SELECT unit_amount_cents FROM shopaccess.merchant_variants WHERE id = $1",

  // Observations.
  nonceDigestOf: "SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex') AS digest",
  quoteRow: "SELECT id, digest, created_at, expires_at, total_cents::integer AS total_cents, currency FROM shopaccess.quotes WHERE id = $1",
  itemRow: "SELECT merchant_display_name, product_title, variant_label, quantity FROM shopaccess.quote_items WHERE quote_id = $1 AND line_number = 1",
  intentRow:
    "SELECT state, row_version, owner_id, purchase_group_id, superseded_by_intent_id, current_quote_id, confirmation_id, confirmation_status, updated_at FROM shopaccess.checkout_intents WHERE id = $1",
  challengeRow:
    "SELECT id, owner_id, checkout_intent_id, quote_id, quote_digest, nonce_digest, nonce_key_purpose, nonce_key_version, summary, status, issued_at, expires_at, consumed_at, superseded_at, expired_marked_at, " +
    "(expires_at = LEAST(issued_at + interval '5 minutes', (SELECT q.expires_at FROM shopaccess.quotes q WHERE q.id = c.quote_id))) AS expiry_rule_holds, " +
    "(pg_catalog.clock_timestamp() - issued_at < interval '30 seconds') AS issued_just_now " +
    "FROM shopaccess.confirmation_challenges c WHERE id = $1",
  challengesOfQuote: "SELECT id, status FROM shopaccess.confirmation_challenges WHERE quote_id = $1 ORDER BY issued_at, id",
  transitionRows:
    "SELECT to_version, from_version, event_id, event_type, actor, entry_point, from_state, to_state, (occurred_at = recorded_at) AS times_equal " +
    "FROM shopaccess.checkout_transitions WHERE checkout_intent_id = $1 ORDER BY to_version",
  auditRows:
    "SELECT event_id, event_type, actor, session_id, owner_id, checkout_intent_id, operation_id, detail, (occurred_at = recorded_at) AS times_equal " +
    "FROM shopaccess.audit_events WHERE owner_id = $1 ORDER BY id",
  // The time of a confirmation event against the rows it belongs to: the transition, the challenge and the intent.
  acceptedTimes:
    "SELECT (a.occurred_at = t.occurred_at) AS audit_is_transition_time, (c.consumed_at = t.occurred_at) AS consumed_is_transition_time, (i.updated_at = t.occurred_at) AS intent_is_transition_time, " +
    "(c.consumed_at >= c.issued_at AND c.consumed_at < c.expires_at) AS consumed_inside_lifetime " +
    "FROM shopaccess.audit_events a JOIN shopaccess.checkout_transitions t ON t.event_id = a.detail ->> 'transitionEventId' " +
    "JOIN shopaccess.confirmation_challenges c ON c.id = a.detail ->> 'challengeId' JOIN shopaccess.checkout_intents i ON i.id = a.checkout_intent_id WHERE a.event_id = $1",
  windowRow:
    "SELECT window_calls, window_throttled::integer AS window_throttled, total_throttled::integer AS total_throttled FROM shopaccess.owner_request_windows WHERE owner_id = $1",
  // The start of an owner's request window, written as OWNER_RATE_LIMITED writes it in its detail.
  windowStartedAt:
    "SELECT pg_catalog.to_char(window_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS started_at FROM shopaccess.owner_request_windows WHERE owner_id = $1",
  // The request-window rows and the audit rows that do not belong to one owner: the rows of the two tables a counted
  // call of that owner changes which it must leave as they are.
  othersSnapshot:
    "SELECT (SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.owner_request_windows t WHERE t.owner_id <> $1) AS owner_request_windows, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.audit_events t WHERE t.owner_id IS DISTINCT FROM $1) AS audit_events",
  ledgerRow: "SELECT version, checksum FROM shopaccess.schema_migrations WHERE version = $1",
  confirmationFunctions:
    "SELECT p.proname::text AS name, r.rolname::text AS owner, p.prosecdef AS security_definer, p.provolatile::text AS volatility, l.lanname::text AS language, p.proconfig AS config, " +
    "pg_catalog.has_function_privilege('shopaccess_web', p.oid, 'EXECUTE') AS web, pg_catalog.has_function_privilege('shopaccess_operator', p.oid, 'EXECUTE') AS operator, " +
    "pg_catalog.has_function_privilege('shopaccess_worker', p.oid, 'EXECUTE') AS worker, pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS everyone, " +
    "pg_catalog.pg_get_function_identity_arguments(p.oid) AS takes, (SELECT count(*)::integer FROM pg_catalog.unnest(p.proargmodes) m WHERE m = 't') AS result_columns " +
    "FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_roles r ON r.oid = p.proowner JOIN pg_catalog.pg_language l ON l.oid = p.prolang " +
    "WHERE n.nspname = 'shopaccess_api' AND p.proname IN ('read_checkout', 'issue_challenge', 'consume_challenge') ORDER BY p.proname",
  // What the function owner holds while a test transaction has taken INSERT on audit_events away from it.
  definerPrivileges:
    "SELECT pg_catalog.has_table_privilege('shopaccess_definer', 'shopaccess.audit_events', 'INSERT') AS audit_insert, " +
    "pg_catalog.has_table_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', 'INSERT') AS challenge_insert, " +
    "pg_catalog.has_column_privilege('shopaccess_definer', 'shopaccess.confirmation_challenges', 'status', 'UPDATE') AS challenge_status_update, " +
    "pg_catalog.has_table_privilege('shopaccess_definer', 'shopaccess.checkout_intents', 'UPDATE') AS intent_update, " +
    "pg_catalog.has_table_privilege('shopaccess_definer', 'shopaccess.checkout_transitions', 'INSERT') AS transition_insert, " +
    "pg_catalog.has_table_privilege('shopaccess_definer', 'shopaccess.owner_request_windows', 'INSERT') AS window_insert",
  // The test-only objects of case S3, counted from inside and after its transaction.
  suppressionFixtures:
    "SELECT (SELECT count(*)::integer FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE 'pgt112%') AS triggers, " +
    "(SELECT count(*)::integer FROM pg_catalog.pg_proc p WHERE p.proname LIKE 'pgt112%') AS functions",
  // PGT-229: audit details that hold a given text, a 64-hex value or a quoted 43-character base64url value.
  auditDetailsHolding: "SELECT count(*)::integer AS n FROM shopaccess.audit_events WHERE pg_catalog.strpos(detail::text, $1) > 0",
  auditDetailsLikeSecrets:
    "SELECT (SELECT count(*)::integer FROM shopaccess.audit_events WHERE detail::text ~ '[0-9a-f]{64}') AS digests, " +
    "(SELECT count(*)::integer FROM shopaccess.audit_events WHERE detail::text ~ '\"[A-Za-z0-9_-]{43}\"') AS nonces, " +
    "(SELECT count(*)::integer FROM shopaccess.audit_events) AS all_rows",
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
type IsolationKey = "beginRepeatableRead" | "beginSerializable" | "beginReadUncommitted";

type Admin = DisposableDatabase["admin"];
type Web = DisposableDatabase["web"];
type Row = Record<string, unknown>;

/** A session of one owner, as the functions see it: the credential is session key version 1 and this token digest. */
interface Credential {
  readonly owner: string;
  readonly session: string;
  readonly digest: string;
}

const NOW = "0 seconds";
const newId = (prefix: string): string => `${prefix}_${hex(16)}`;
/** A well-formed nonce: 43 characters of the base64url alphabet whose last one is canonical. A test value. */
const newNonce = (): string => `${hex(21)}A`;
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60 * 1000);
const sortedKeys = (value: Record<string, unknown>): string[] => Object.keys(value).sort();

/** A session row written by the test owner, for a new owner, with a given token digest or a fresh one. */
async function newCredential(client: Admin, digest: string = hex(32)): Promise<Credential> {
  const owner = newId("own");
  const session = newId("ses");
  await client.query(SQL.insertOwner, [owner, NOW]);
  await client.query(SQL.insertSession, [session, owner, digest, NOW, NOW]);
  return { owner, session, digest };
}

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

/** The request-window rows and the audit rows of everybody but one owner, as one value per table. */
async function othersOf(client: Admin, owner: string): Promise<Record<string, string>> {
  return (await client.query(SQL.othersSnapshot, [owner])).rows[0];
}

async function windowOf(client: Admin, owner: string): Promise<{ window_calls: number; window_throttled: number; total_throttled: number } | null> {
  const { rows } = await client.query(SQL.windowRow, [owner]);
  return rows.length === 0 ? null : rows[0];
}

async function auditsOf(client: Admin, owner: string): Promise<Array<{ event_id: string; event_type: string; actor: string; session_id: string | null; owner_id: string; checkout_intent_id: string | null; operation_id: string | null; detail: Row; times_equal: boolean }>> {
  return (await client.query(SQL.auditRows, [owner])).rows;
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

/** One call of issue_challenge as the web role. Always exactly one row. */
async function issue(pool: Web, credential: Credential, intent: unknown, challenge: unknown, keyVersion: unknown, nonceDigest: unknown): Promise<Row> {
  const { rows } = await pool.query(SQL.issueChallenge, [SESSION_KEY_VERSION, credential.digest, intent, challenge, keyVersion, nonceDigest]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** One call of consume_challenge as the web role. Always exactly one row. */
async function consume(pool: Web, credential: Credential, challenge: unknown, nonce: unknown, quote: unknown, quoteDigest: unknown): Promise<Row> {
  const { rows } = await pool.query(SQL.consumeChallenge, [SESSION_KEY_VERSION, credential.digest, challenge, nonce, quote, quoteDigest]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function readCheckout(pool: Web, credential: Credential, intent: unknown): Promise<Row> {
  const { rows } = await pool.query(SQL.readCheckout, [SESSION_KEY_VERSION, credential.digest, intent]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** What a result with no challenge looks like: the result code, and every other column NULL. */
const issueRefusal = (result: string): Row => ({ result, challenge_id: null, quote_digest: null, nonce_key_version: null, nonce_digest: null, summary: null, expires_at: null });

/** A checkout started through start_checkout, with what the tests need of its quote. */
interface Started {
  readonly intent: string;
  readonly quote: string;
  readonly quoteDigest: string;
}

async function startCheckout(client: Admin, pool: Web, credential: Credential): Promise<Started> {
  const started = (await pool.query(SQL.startCheckout, [SESSION_KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, null])).rows[0];
  expect(started.result).toBe("STARTED");
  const quote = (await client.query(SQL.quoteRow, [started.quote_id])).rows[0];
  return { intent: started.intent_id, quote: started.quote_id, quoteDigest: quote.digest };
}

/** A checkout and an ACTIVE challenge of it, both made by the real functions. */
interface Baseline extends Started {
  readonly credential: Credential;
  readonly challenge: string;
  readonly nonce: string;
  readonly nonceDigest: string;
  readonly keyVersion: number;
}

async function baseline(client: Admin, pool: Web, keyVersion: number): Promise<Baseline> {
  const credential = await newCredential(client);
  const started = await startCheckout(client, pool, credential);
  const challenge = newId("cf");
  const nonce = newNonce();
  const nonceDigest = await digestOfNonce(client, nonce);
  const issued = await issue(pool, credential, started.intent, challenge, keyVersion, nonceDigest);
  expect(issued.result).toBe("ISSUED");
  return { ...started, credential, challenge, nonce, nonceDigest, keyVersion };
}

/**
 * A QUOTED checkout written directly by the test owner in one transaction: group, intent, quote, item and first
 * transition. No function runs, so the owner has no request-window row. `storedDigest` stores that digest in place
 * of the digest of the quote's own fields.
 */
async function fixtureCheckout(client: Admin, credential: Credential, createdAt: Date = minutesAgo(1), storedDigest: string | null = null): Promise<Started> {
  const intent = newId("ci");
  const quote = newId("qt");
  const group = newId("pur");
  const created = createdAt.toISOString();
  await client.query(SQL.begin);
  try {
    await client.query(SQL.lockOwner, [credential.owner]);
    await client.query(SQL.insertGroup, [group, credential.owner, created]);
    await client.query(SQL.insertIntent, [intent, credential.owner, group, quote, created]);
    await client.query(SQL.insertQuote, [quote, credential.owner, intent, group, created, storedDigest]);
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

/** A challenge written directly, with the nonce that belongs to it. */
interface FixtureChallenge {
  readonly challenge: string;
  readonly nonce: string;
  readonly nonceDigest: string;
}

/**
 * An ACTIVE challenge of a quote, written directly: under `keyVersion`, issued and expiring at the given intervals
 * from the database clock, and bound to the quote's stored digest unless `boundDigest` says otherwise. The defaults
 * give a challenge issued ten seconds ago with 200 seconds left.
 */
async function fixtureChallenge(client: Admin, quote: string, keyVersion: number, issued: string = "-10 seconds", expires: string = "200 seconds", boundDigest: string | null = null): Promise<FixtureChallenge> {
  const challenge = newId("cf");
  const nonce = newNonce();
  const nonceDigest = await digestOfNonce(client, nonce);
  await client.query(SQL.insertChallenge, [challenge, nonceDigest, quote, keyVersion, issued, expires, boundDigest]);
  return { challenge, nonce, nonceDigest };
}

/** Ends a directly written ACTIVE challenge by a direct write: one of the three fixed statements above. */
async function endChallenge(client: Admin, challenge: string, status: "SUPERSEDED" | "EXPIRED" | "CONSUMED"): Promise<void> {
  if (status === "SUPERSEDED") await client.query(SQL.supersedeChallengeDirectly, [challenge]);
  if (status === "EXPIRED") await client.query(SQL.expireChallengeDirectly, [challenge]);
  if (status === "CONSUMED") await client.query(SQL.consumeChallengeDirectly, [challenge]);
}

/** A directly written checkout with a directly written ACTIVE challenge: no function has run for its owner. */
interface Staged extends Started, FixtureChallenge {
  readonly credential: Credential;
}

async function stage(
  client: Admin,
  keyVersion: number,
  options: { readonly createdAt?: Date; readonly storedDigest?: string | null; readonly issued?: string; readonly expires?: string; readonly boundDigest?: string | null } = {},
): Promise<Staged> {
  const credential = await newCredential(client);
  const checkout = await fixtureCheckout(client, credential, options.createdAt ?? minutesAgo(1), options.storedDigest ?? null);
  const challenge = await fixtureChallenge(client, checkout.quote, keyVersion, options.issued ?? "-10 seconds", options.expires ?? "200 seconds", options.boundDigest ?? null);
  return { ...checkout, ...challenge, credential };
}

/** What one call did: its row, the tables it changed, what it did to the owner's request window, and its audit rows. */
interface Observed {
  readonly row: Row;
  readonly changed: string[];
  /** Admitted calls added to the owner's window. */
  readonly counted: number;
  /** Throttled calls added to the owner's window. */
  readonly throttled: number;
  readonly windowExists: boolean;
  readonly audits: Awaited<ReturnType<typeof auditsOf>>;
}

async function observe(client: Admin, owner: string, act: () => Promise<Row>): Promise<Observed> {
  const before = await snapshotOf(client);
  const windowBefore = await windowOf(client, owner);
  const auditsBefore = await auditsOf(client, owner);
  const row = await act();
  const after = await snapshotOf(client);
  const windowAfter = await windowOf(client, owner);
  const auditsAfter = await auditsOf(client, owner);
  return {
    row,
    changed: changedTables(before, after),
    counted: (windowAfter?.window_calls ?? 0) - (windowBefore?.window_calls ?? 0),
    throttled: (windowAfter?.total_throttled ?? 0) - (windowBefore?.total_throttled ?? 0),
    windowExists: windowAfter !== null,
    audits: auditsAfter.slice(auditsBefore.length),
  };
}

// What a call may change, by kind of outcome (specification 19.10).
const NOTHING: string[] = [];
const COUNTER_ONLY = ["owner_request_windows"];
const COUNTER_AND_AUDIT = ["audit_events", "owner_request_windows"];
const COUNTER_AND_CHALLENGE = ["confirmation_challenges", "owner_request_windows"];
const CONFIRMATION = ["audit_events", "checkout_intents", "checkout_transitions", "confirmation_challenges", "owner_request_windows"];

/** Asserts one CONFIRMATION_REJECTED row: its columns, and exactly the two keys of its detail. */
function expectRejection(audit: Observed["audits"][number], credential: Credential, intent: string, result: string, challenge: string | null, label: string): void {
  expect(audit, label).toMatchObject({ event_type: "CONFIRMATION_REJECTED", actor: "shopper", session_id: credential.session, owner_id: credential.owner, checkout_intent_id: intent, operation_id: null, times_equal: true });
  expect(audit.event_id, label).toMatch(/^ev_[0-9a-f]{32}$/);
  expect(sortedKeys(audit.detail), label).toEqual(["challengeId", "result"]);
  expect(audit.detail, label).toEqual({ result, challengeId: challenge });
}

/**
 * Cases A4 to A8 (policy P4, second exception). Inside one transaction of the test owner, which is always rolled
 * back: INSERT on audit_events is taken from the function owner, and one call of issue_challenge or consume_challenge
 * is made on the same client. Returns what the call returned or raised, what the function owner held at that moment,
 * and what the next statement of the transaction gave.
 */
async function withRevokedPrivilege(
  client: Admin,
  target: "issueChallenge" | "consumeChallenge",
  values: readonly unknown[],
): Promise<{ returned: string | null; sqlstate: string | null; message: string | null; where: string | null; held: Row; afterwards: string | null }> {
  await client.query(SQL.begin);
  try {
    await client.query("REVOKE INSERT ON shopaccess.audit_events FROM shopaccess_definer");
    const held = (await client.query(SQL.definerPrivileges)).rows[0];
    let returned: string | null = null;
    let failure: unknown = null;
    try {
      const reply = target === "issueChallenge" ? await client.query(SQL.issueChallenge, [...values]) : await client.query(SQL.consumeChallenge, [...values]);
      returned = String(reply.rows[0].result);
    } catch (error) {
      failure = error;
    }
    const afterwards = await sqlState(() => client.query(SQL.selectOne));
    const fields = (typeof failure === "object" && failure !== null ? failure : {}) as { code?: unknown; message?: unknown; where?: unknown };
    return {
      returned,
      sqlstate: typeof fields.code === "string" ? fields.code : null,
      message: typeof fields.message === "string" ? fields.message : null,
      where: typeof fields.where === "string" ? fields.where : null,
      held,
      afterwards,
    };
  } finally {
    await client.query(SQL.rollback);
  }
}

/**
 * Case S3 (policy P4, first exception). Inside one transaction of the test owner, which is always rolled back: a
 * test-only trigger makes the insert of a transition do nothing, and one call of consume_challenge is made on the
 * same client. Returns what the call returned or raised, how many test-only objects existed at that moment, and what
 * the next statement of the transaction gave.
 */
async function withSuppressedInsert(
  client: Admin,
  values: readonly unknown[],
): Promise<{ returned: string | null; sqlstate: string | null; constraint: string | null; fixturesInside: Row; afterwards: string | null }> {
  await client.query(SQL.begin);
  try {
    await client.query("CREATE FUNCTION shopaccess.pgt112_suppress_row() RETURNS trigger LANGUAGE plpgsql AS $pgt112$ BEGIN RETURN NULL; END; $pgt112$");
    await client.query("CREATE TRIGGER pgt112_suppress_transition BEFORE INSERT ON shopaccess.checkout_transitions FOR EACH ROW EXECUTE FUNCTION shopaccess.pgt112_suppress_row()");
    const fixturesInside = (await client.query(SQL.suppressionFixtures)).rows[0];
    let returned: string | null = null;
    let failure: unknown = null;
    try {
      const reply = await client.query(SQL.consumeChallenge, [...values]);
      returned = String(reply.rows[0].result);
    } catch (error) {
      failure = error;
    }
    const afterwards = await sqlState(() => client.query(SQL.selectOne));
    const fields = (typeof failure === "object" && failure !== null ? failure : {}) as { code?: unknown; constraint?: unknown };
    return {
      returned,
      sqlstate: typeof fields.code === "string" ? fields.code : null,
      constraint: typeof fields.constraint === "string" ? fields.constraint : null,
      fixturesInside,
      afterwards,
    };
  } finally {
    await client.query(SQL.rollback);
  }
}

/** One call inside a transaction of the given isolation level, as the test owner; the transaction is rolled back. */
async function underIsolation(client: Admin, isolation: IsolationKey, target: "issueChallenge" | "consumeChallenge" | "readCheckout", values: readonly unknown[]): Promise<string | null> {
  await client.query(SQL[isolation]);
  try {
    if (target === "issueChallenge") return await sqlState(() => client.query(SQL.issueChallenge, [...values]));
    if (target === "consumeChallenge") return await sqlState(() => client.query(SQL.consumeChallenge, [...values]));
    return await sqlState(() => client.query(SQL.readCheckout, [...values]));
  } finally {
    await client.query(SQL.rollback);
  }
}

describe.skipIf(!adminUrl())("Increment 2.2 confirmation functions (migration 0009) on a disposable PostgreSQL 17 database", () => {
  let db: DisposableDatabase;
  // The ACTIVE version of the nonce key. A test that needs a version that is no longer ACTIVE moves on to the next.
  let activeNonceKey = 1;

  beforeAll(async () => {
    db = await openDisposableDatabase();
    // A session row can be inserted only under an ACTIVE session key, and a challenge only under a nonce key that
    // exists. The check values are test values; no key material is stored.
    const session = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 1, computeKeyCheckValue(TEST_NONCE_KEY, "session")]);
    expect(session.rows[0].result).toBe("ACTIVATED");
    const nonce = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["confirmation_nonce", 1, computeKeyCheckValue(TEST_NONCE_KEY, "confirmation_nonce")]);
    expect(nonce.rows[0].result).toBe("ACTIVATED");
  });
  afterAll(async () => {
    await db?.destroy();
  });

  /** Activates the next nonce key version. The version that was ACTIVE becomes VERIFY_ONLY, and is returned. */
  const retireNonceKey = async (): Promise<number> => {
    const retired = activeNonceKey;
    const activated = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["confirmation_nonce", retired + 1, hex(32)]);
    expect(activated.rows[0].result).toBe("ACTIVATED");
    activeNonceKey = retired + 1;
    return retired;
  };
  /** Ends a nonce key version that is no longer ACTIVE, through the accepted operator function. */
  const endNonceKey = async (version: number): Promise<void> => {
    const ended = await db.operator.query(OPERATOR_STATEMENTS.revokeKeyVersion, ["confirmation_nonce", version]);
    expect(ended.rows[0]).toMatchObject({ result: "REVOKED", was_active: false });
  };
  /** Changes the price of the quoted variant, runs the body, and puts the price back. A material change. */
  const whileRepriced = async <T>(body: () => Promise<T>): Promise<T> => {
    const original = (await db.admin.query(SQL.variantAmount, [VARIANT])).rows[0].unit_amount_cents;
    await db.admin.query(SQL.setVariantAmount, [VARIANT, UNIT_AMOUNT + 1]);
    try {
      return await body();
    } finally {
      await db.admin.query(SQL.setVariantAmount, [VARIANT, original]);
    }
  };

  it("PGT-226: migration 0009 is applied with its pinned checksum; its three functions belong to the function owner; the web role executes them and reaches no table", async () => {
    const pinned = APPROVED_MIGRATIONS.find((entry) => entry.version === "0009_confirmation_functions");
    expect(pinned).toBeDefined();
    expect((await db.admin.query(SQL.ledgerRow, ["0009_confirmation_functions"])).rows).toEqual([{ version: "0009_confirmation_functions", checksum: pinned?.sha256 }]);

    const functions = (await db.admin.query(SQL.confirmationFunctions)).rows;
    expect(functions.map((row) => row.name)).toEqual(["consume_challenge", "issue_challenge", "read_checkout"]);
    for (const row of functions) {
      expect(row, row.name).toMatchObject({ owner: "shopaccess_definer", security_definer: true, config: ["search_path=pg_catalog, pg_temp"], web: true, operator: false, worker: false, everyone: false });
    }
    const byName = new Map(functions.map((row) => [String(row.name), row]));
    expect(byName.get("read_checkout")).toMatchObject({ volatility: "s", language: "sql", takes: "p_key_version smallint, p_token_digest text, p_intent_id text", result_columns: 41 });
    expect(byName.get("issue_challenge")).toMatchObject({
      volatility: "v",
      language: "plpgsql",
      takes: "p_key_version smallint, p_token_digest text, p_intent_id text, p_challenge_id text, p_nonce_key_version smallint, p_nonce_digest text",
      result_columns: 7,
    });
    expect(byName.get("consume_challenge")).toMatchObject({
      volatility: "v",
      language: "plpgsql",
      takes: "p_key_version smallint, p_token_digest text, p_challenge_id text, p_nonce text, p_quote_id text, p_quote_digest text",
      result_columns: 2,
    });
    // The function owner's table privileges are asserted exactly in privileges.test.ts and checkout-functions.test.ts.
    expect((await db.admin.query(SQL.definerPrivileges)).rows[0]).toEqual({ audit_insert: true, challenge_insert: true, challenge_status_update: true, intent_update: true, transition_insert: true, window_insert: true });

    // The web role reaches the challenges only through the functions: every direct statement is refused.
    const staged = await stage(db.admin, activeNonceKey);
    expect(await sqlState(() => db.web.query("SELECT id FROM shopaccess.confirmation_challenges WHERE id = $1", [staged.challenge]))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(() => db.web.query("UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = issued_at WHERE id = $1", [staged.challenge]))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(() => db.web.query("DELETE FROM shopaccess.confirmation_challenges WHERE id = $1", [staged.challenge]))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlState(() =>
        db.web.query(
          "INSERT INTO shopaccess.confirmation_challenges (id, owner_id, checkout_intent_id, quote_id, quote_digest, nonce_digest, nonce_key_version, summary, status, issued_at, expires_at) " +
            "VALUES ($1, $2, $3, $4, $5, $6, 1, '{}'::jsonb, 'ACTIVE', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + interval '1 minute')",
          [newId("cf"), staged.credential.owner, staged.intent, staged.quote, staged.quoteDigest, hex(32)],
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(() => db.web.query("SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(nonce_digest, 'UTF8')), 'hex') FROM shopaccess.confirmation_challenges LIMIT 1"))).toBe(INSUFFICIENT_PRIVILEGE);
    // The operator may not call the confirmation functions.
    expect(await sqlState(() => db.operator.query(SQL.consumeChallenge, [SESSION_KEY_VERSION, staged.credential.digest, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest]))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(() => db.operator.query(SQL.issueChallenge, [SESSION_KEY_VERSION, staged.credential.digest, staged.intent, newId("cf"), activeNonceKey, hex(32)]))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await challengeOf(db.admin, staged.challenge)).toMatchObject({ status: "ACTIVE" });
  });

  it("PGT-228 (database side): the database's SHA-256 of the 43 characters of each frozen nonce is the frozen digest", async () => {
    for (const vector of NONCE_VECTORS) {
      expect(vector.nonce, vector.name).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
      expect(await digestOfNonce(db.admin, vector.nonce), vector.name).toBe(vector.digest);
    }
    // The digest is over the characters as they are: another nonce, or the same one with a character changed, differs.
    expect(await digestOfNonce(db.admin, `${NONCE_VECTORS[0].nonce.slice(0, 42)}o`)).not.toBe(NONCE_VECTORS[0].digest);
  });

  it("PGT-223: read_checkout returns 41 columns; the ACTIVE challenge of the quote, or none; and whether it is usable", async () => {
    // (b) No challenge yet.
    const credential = await newCredential(db.admin);
    const started = await startCheckout(db.admin, db.web, credential);
    const none = await readCheckout(db.web, credential, started.intent);
    expect(Object.keys(none)).toHaveLength(41);
    expect(none).toMatchObject({ result: "OK", stored_state: "QUOTED", challenge_id: null, challenge_quote_digest: null, challenge_nonce_key_version: null, challenge_nonce_digest: null, challenge_summary: null, challenge_issued_at: null, challenge_expires_at: null, challenge_usable: false });

    // (a) An ACTIVE, usable challenge: the seven columns are the stored row's.
    const challenge = newId("cf");
    const nonceDigest = await digestOfNonce(db.admin, newNonce());
    const issued = await issue(db.web, credential, started.intent, challenge, activeNonceKey, nonceDigest);
    expect(issued.result).toBe("ISSUED");
    const stored = await challengeOf(db.admin, challenge);
    const shown = await readCheckout(db.web, credential, started.intent);
    expect(Object.keys(shown).slice(0, 33)).toEqual(Object.keys(none).slice(0, 33));
    expect(Object.keys(shown).slice(33)).toEqual(["challenge_id", "challenge_quote_digest", "challenge_nonce_key_version", "challenge_nonce_digest", "challenge_summary", "challenge_issued_at", "challenge_expires_at", "challenge_usable"]);
    expect(shown).toMatchObject({
      result: "OK",
      challenge_id: challenge,
      challenge_quote_digest: started.quoteDigest,
      challenge_nonce_key_version: activeNonceKey,
      challenge_nonce_digest: nonceDigest,
      challenge_summary: stored.summary,
      challenge_issued_at: stored.issued_at,
      challenge_expires_at: stored.expires_at,
      challenge_usable: true,
    });
    expect(shown.quote_digest).toBe(started.quoteDigest);
    // The first 33 columns are what they were before the challenge existed, apart from the time of the reading.
    expect({ ...shown, database_time: null, challenge_id: null, challenge_quote_digest: null, challenge_nonce_key_version: null, challenge_nonce_digest: null, challenge_summary: null, challenge_issued_at: null, challenge_expires_at: null, challenge_usable: false }).toEqual({ ...none, database_time: null });
    // A reading changes nothing.
    const before = await snapshotOf(db.admin);
    await readCheckout(db.web, credential, started.intent);
    expect(await snapshotOf(db.admin)).toEqual(before);

    // (c) ACTIVE but not usable, one reason at a time. The seven columns are still shown.
    const unusable = async (label: string, staged: Staged): Promise<void> => {
      const row = await readCheckout(db.web, staged.credential, staged.intent);
      expect(row, label).toMatchObject({ result: "OK", challenge_id: staged.challenge, challenge_nonce_digest: staged.nonceDigest, challenge_usable: false });
      expect(row.challenge_expires_at, label).toBeInstanceOf(Date);
    };
    await unusable("the challenge is past its expiry", await stage(db.admin, activeNonceKey, { issued: "-400 seconds", expires: "-30 seconds" }));
    await unusable("the quote has expired", await stage(db.admin, activeNonceKey, { createdAt: minutesAgo(20), expires: "200 seconds" }));
    await unusable("the challenge is bound to another digest than the quote's", await stage(db.admin, activeNonceKey, { boundDigest: hex(32) }));
    const canceled = await stage(db.admin, activeNonceKey);
    await cancelFixtureDirectly(db.admin, canceled.credential, canceled.intent);
    await unusable("the intent is canceled", canceled);
    const stale = await stage(db.admin, activeNonceKey);
    await whileRepriced(() => unusable("a material change of the catalog", stale));
    expect(await readCheckout(db.web, stale.credential, stale.intent)).toMatchObject({ challenge_id: stale.challenge, challenge_usable: true, quote_stale: false });
    const underEndedKey = await stage(db.admin, activeNonceKey);
    const ended = await retireNonceKey();
    // VERIFY_ONLY is still usable; ended is not.
    expect(await readCheckout(db.web, underEndedKey.credential, underEndedKey.intent)).toMatchObject({ challenge_id: underEndedKey.challenge, challenge_nonce_key_version: ended, challenge_usable: true });
    await endNonceKey(ended);
    await unusable("the nonce key of the challenge has been ended", underEndedKey);

    // (d) Only challenges that have ended: none is shown.
    for (const status of ["SUPERSEDED", "EXPIRED", "CONSUMED"] as const) {
      const staged = await stage(db.admin, activeNonceKey);
      await endChallenge(db.admin, staged.challenge, status);
      expect(await readCheckout(db.web, staged.credential, staged.intent), status).toMatchObject({ result: "OK", challenge_id: null, challenge_summary: null, challenge_expires_at: null, challenge_usable: false });
    }
  });

  it("PGT-224: read_checkout is NOT_AUTHORIZED, with every other column NULL, for a failed credential and for a missing, foreign or malformed intent", async () => {
    const mine = await baseline(db.admin, db.web, activeNonceKey);
    const other = await newCredential(db.admin);
    const attempts: Array<[string, Credential, unknown]> = [
      ["another owner's intent", other, mine.intent],
      ["a missing intent", mine.credential, newId("ci")],
      ["a malformed intent", mine.credential, "not-an-intent"],
      ["no intent", mine.credential, null],
      ["an unknown token digest", { ...mine.credential, digest: hex(32) }, mine.intent],
      ["a malformed token digest", { ...mine.credential, digest: "not-a-digest" }, mine.intent],
    ];
    for (const [label, credential, intent] of attempts) {
      const row = await readCheckout(db.web, credential, intent);
      expect(Object.keys(row), label).toHaveLength(41);
      expect(row.result, label).toBe("NOT_AUTHORIZED");
      expect(Object.entries(row).filter(([name, value]) => name !== "result" && value !== null), label).toEqual([]);
    }
    expect(await readCheckout(db.web, mine.credential, mine.intent)).toMatchObject({ result: "OK", challenge_id: mine.challenge, challenge_usable: true });
  });

  it("PGT-210: a first issue inserts one ACTIVE challenge bound to the intent, the owner, the quote and its stored digest, with a summary built from the quote", async () => {
    const credential = await newCredential(db.admin);
    const started = await startCheckout(db.admin, db.web, credential);
    const challenge = newId("cf");
    const nonceDigest = await digestOfNonce(db.admin, newNonce());
    const observed = await observe(db.admin, credential.owner, () => issue(db.web, credential, started.intent, challenge, activeNonceKey, nonceDigest));
    expect(observed.row).toMatchObject({ result: "ISSUED", challenge_id: challenge, quote_digest: started.quoteDigest, nonce_key_version: activeNonceKey, nonce_digest: nonceDigest });
    expect(sortedKeys(observed.row)).toEqual(["challenge_id", "expires_at", "nonce_digest", "nonce_key_version", "quote_digest", "result", "summary"]);
    expect(observed.changed).toEqual(COUNTER_AND_CHALLENGE);
    expect(observed.counted).toBe(1);
    expect(observed.audits).toEqual([]);

    const stored = await challengeOf(db.admin, challenge);
    expect(stored).toMatchObject({
      id: challenge,
      owner_id: credential.owner,
      checkout_intent_id: started.intent,
      quote_id: started.quote,
      quote_digest: started.quoteDigest,
      nonce_digest: nonceDigest,
      nonce_key_purpose: "confirmation_nonce",
      nonce_key_version: activeNonceKey,
      status: "ACTIVE",
      consumed_at: null,
      superseded_at: null,
      expired_marked_at: null,
      // Five minutes from the time of issue, or the quote's expiry if that is earlier.
      expiry_rule_holds: true,
      issued_just_now: true,
    });
    expect(observed.row.expires_at).toEqual(stored.expires_at);
    // The summary: exactly six fields, from the stored quote and its item, never from the caller.
    const quote = (await db.admin.query(SQL.quoteRow, [started.quote])).rows[0];
    const item = (await db.admin.query(SQL.itemRow, [started.quote])).rows[0];
    const summary = stored.summary as Record<string, unknown>;
    expect(sortedKeys(summary)).toEqual(["currency", "merchantName", "productTitle", "quantity", "totalCents", "variantLabel"]);
    expect(summary).toEqual({ merchantName: item.merchant_display_name, productTitle: item.product_title, variantLabel: item.variant_label, quantity: item.quantity, currency: quote.currency, totalCents: quote.total_cents });
    expect(observed.row.summary).toEqual(summary);
    expect(JSON.stringify(summary)).not.toMatch(/[0-9a-f]{64}/);
    // The intent is untouched.
    expect(await intentOf(db.admin, started.intent)).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null, confirmation_status: null });
    expect((await db.admin.query(SQL.transitionRows, [started.intent])).rows).toHaveLength(1);
  });

  it("PGT-14: 25 issue calls and 200 reads inside the reuse window leave one challenge; every later issue is REUSED and returns the first one", async () => {
    // The owner's request window admits 30 calls a minute, so 200 issue calls cannot be made; 25 are.
    const credential = await newCredential(db.admin);
    const started = await startCheckout(db.admin, db.web, credential);
    const first = newId("cf");
    const firstDigest = await digestOfNonce(db.admin, newNonce());
    const issued = await issue(db.web, credential, started.intent, first, activeNonceKey, firstDigest);
    expect(issued.result).toBe("ISSUED");
    const afterFirst = await snapshotOf(db.admin);
    for (let again = 0; again < 24; again += 1) {
      // Each call offers a new id and a new digest; neither is used.
      const row = await issue(db.web, credential, started.intent, newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce()));
      expect(row, `call ${again + 2}`).toEqual({ ...issued, result: "REUSED" });
    }
    for (let reading = 0; reading < 200; reading += 1) {
      const row = await readCheckout(db.web, credential, started.intent);
      if (row.challenge_id !== first || row.challenge_usable !== true) throw new Error(`reading ${reading + 1} did not show the one usable challenge`);
    }
    expect(await statusesOf(db.admin, started.quote)).toEqual([`${first}:ACTIVE`]);
    expect(await windowOf(db.admin, credential.owner)).toMatchObject({ window_calls: 26, window_throttled: 0 });
    expect(changedTables(afterFirst, await snapshotOf(db.admin))).toEqual(COUNTER_ONLY);
    expect((await auditsOf(db.admin, credential.owner)).map((row) => row.event_type)).toEqual(["QUOTE_ISSUED"]);
  });

  it("PGT-16: an ACTIVE challenge is reused only with more than 60 seconds left; otherwise it ends as SUPERSEDED, or as EXPIRED when past its expiry, and a new one is issued", async () => {
    // The comparison at exactly 60 seconds is static evidence (the static suite reads the strict comparison in the
    // function); the margins here are wide so that the time a test takes cannot move a case across the line.
    const reusable = await stage(db.admin, activeNonceKey, { issued: "-180 seconds", expires: "120 seconds" });
    const kept = await observe(db.admin, reusable.credential.owner, async () => issue(db.web, reusable.credential, reusable.intent, newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce())));
    expect(kept.row).toMatchObject({ result: "REUSED", challenge_id: reusable.challenge, nonce_digest: reusable.nonceDigest, nonce_key_version: activeNonceKey, quote_digest: reusable.quoteDigest });
    expect(kept.changed).toEqual(COUNTER_ONLY);
    expect(await statusesOf(db.admin, reusable.quote)).toEqual([`${reusable.challenge}:ACTIVE`]);

    const nearExpiry = await stage(db.admin, activeNonceKey, { issued: "-270 seconds", expires: "30 seconds" });
    const replacement = newId("cf");
    const renewed = await observe(db.admin, nearExpiry.credential.owner, async () => issue(db.web, nearExpiry.credential, nearExpiry.intent, replacement, activeNonceKey, await digestOfNonce(db.admin, newNonce())));
    expect(renewed.row).toMatchObject({ result: "ISSUED", challenge_id: replacement });
    expect(renewed.changed).toEqual(COUNTER_AND_CHALLENGE);
    expect(renewed.audits).toEqual([]);
    expect(await challengeOf(db.admin, nearExpiry.challenge)).toMatchObject({ status: "SUPERSEDED", expired_marked_at: null, consumed_at: null });
    expect((await challengeOf(db.admin, nearExpiry.challenge)).superseded_at).toBeInstanceOf(Date);
    expect(await statusesOf(db.admin, nearExpiry.quote)).toEqual([`${nearExpiry.challenge}:SUPERSEDED`, `${replacement}:ACTIVE`]);

    const pastExpiry = await stage(db.admin, activeNonceKey, { issued: "-400 seconds", expires: "-30 seconds" });
    const afterExpiry = newId("cf");
    const reissued = await observe(db.admin, pastExpiry.credential.owner, async () => issue(db.web, pastExpiry.credential, pastExpiry.intent, afterExpiry, activeNonceKey, await digestOfNonce(db.admin, newNonce())));
    expect(reissued.row).toMatchObject({ result: "ISSUED", challenge_id: afterExpiry });
    expect(await challengeOf(db.admin, pastExpiry.challenge)).toMatchObject({ status: "EXPIRED", superseded_at: null, consumed_at: null });
    expect((await challengeOf(db.admin, pastExpiry.challenge)).expired_marked_at).toBeInstanceOf(Date);
    expect(await statusesOf(db.admin, pastExpiry.quote)).toEqual([`${pastExpiry.challenge}:EXPIRED`, `${afterExpiry}:ACTIVE`]);
  });

  it("PGT-17 and PGT-212: after a newer nonce key is activated, a challenge under the older one is superseded, its nonce is refused, and only an ACTIVE key can issue", async () => {
    const older = await baseline(db.admin, db.web, activeNonceKey);
    const retired = await retireNonceKey();
    expect(retired).toBe(older.keyVersion);

    // PGT-212: the older version is VERIFY_ONLY now, and an unknown version does not exist: neither can issue.
    for (const [label, version] of [["a VERIFY_ONLY version", retired], ["a version that does not exist", 30000]] as const) {
      const refused = await observe(db.admin, older.credential.owner, async () => issue(db.web, older.credential, older.intent, newId("cf"), version, await digestOfNonce(db.admin, newNonce())));
      expect(refused.row, label).toEqual(issueRefusal("NONCE_KEY_NOT_ACTIVE"));
      expect(refused.changed, label).toEqual(COUNTER_ONLY);
      expect(refused.audits, label).toEqual([]);
    }
    expect(await statusesOf(db.admin, older.quote)).toEqual([`${older.challenge}:ACTIVE`]);

    // PGT-17: an issue under the new ACTIVE version does not reuse the older challenge: it supersedes it.
    const newer = newId("cf");
    const newerNonce = newNonce();
    const issued = await issue(db.web, older.credential, older.intent, newer, activeNonceKey, await digestOfNonce(db.admin, newerNonce));
    expect(issued).toMatchObject({ result: "ISSUED", challenge_id: newer, nonce_key_version: activeNonceKey });
    expect(await statusesOf(db.admin, older.quote)).toEqual([`${older.challenge}:SUPERSEDED`, `${newer}:ACTIVE`]);
    const oldNonce = await observe(db.admin, older.credential.owner, () => consume(db.web, older.credential, older.challenge, older.nonce, older.quote, older.quoteDigest));
    expect(oldNonce.row).toEqual({ result: "CONFIRMATION_SUPERSEDED", intent_id: null });
    expect(oldNonce.changed).toEqual(COUNTER_ONLY);
    expect(oldNonce.audits).toEqual([]);

    // PGT-212: an ended version cannot issue either.
    await endNonceKey(retired);
    const afterEnd = await baseline(db.admin, db.web, activeNonceKey);
    const refused = await observe(db.admin, afterEnd.credential.owner, async () => issue(db.web, afterEnd.credential, afterEnd.intent, newId("cf"), retired, await digestOfNonce(db.admin, newNonce())));
    expect(refused.row).toEqual(issueRefusal("NONCE_KEY_NOT_ACTIVE"));
    expect(refused.changed).toEqual(COUNTER_ONLY);
    expect(await statusesOf(db.admin, afterEnd.quote)).toEqual([`${afterEnd.challenge}:ACTIVE`]);
    // The newer challenge of the first checkout is still good.
    expect(await consume(db.web, older.credential, newer, newerNonce, older.quote, older.quoteDigest)).toEqual({ result: "CONFIRMED", intent_id: older.intent });
  });

  it("PGT-211: a quote with eight challenge rows, in whatever status, gets no ninth, and the refusal changes none of them", async () => {
    const credential = await newCredential(db.admin);
    const checkout = await fixtureCheckout(db.admin, credential);
    for (let ended = 0; ended < 7; ended += 1) {
      const earlier = await fixtureChallenge(db.admin, checkout.quote, activeNonceKey, "-290 seconds", "10 seconds");
      await db.admin.query(SQL.supersedeChallengeDirectly, [earlier.challenge]);
    }
    // The eighth is ACTIVE with too little time left to be reused, so the call has to decide on the ceiling.
    const eighth = await fixtureChallenge(db.admin, checkout.quote, activeNonceKey, "-270 seconds", "30 seconds");
    const before = await statusesOf(db.admin, checkout.quote);
    expect(before).toHaveLength(8);
    const observed = await observe(db.admin, credential.owner, async () => issue(db.web, credential, checkout.intent, newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce())));
    expect(observed.row).toEqual(issueRefusal("CHALLENGE_LIMIT_REACHED"));
    expect(observed.changed).toEqual(COUNTER_ONLY);
    expect(observed.counted).toBe(1);
    expect(observed.audits).toEqual([]);
    expect(await statusesOf(db.admin, checkout.quote)).toEqual(before);
    expect(await challengeOf(db.admin, eighth.challenge)).toMatchObject({ status: "ACTIVE", superseded_at: null, expired_marked_at: null });
    // With seven rows the same call is served: the limit is eight rows, not seven.
    const seven = await newCredential(db.admin);
    const sevenCheckout = await fixtureCheckout(db.admin, seven);
    for (let ended = 0; ended < 7; ended += 1) {
      const earlier = await fixtureChallenge(db.admin, sevenCheckout.quote, activeNonceKey, "-290 seconds", "10 seconds");
      await db.admin.query(SQL.supersedeChallengeDirectly, [earlier.challenge]);
    }
    expect((await issue(db.web, seven, sevenCheckout.intent, newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce()))).result).toBe("ISSUED");
    expect(await statusesOf(db.admin, sevenCheckout.quote)).toHaveLength(8);
  });

  it("PGT-213: no challenge is issued for an intent that is canceled, superseded or confirmed, for an expired quote, or after a material change; each refusal is counted and changes nothing else", async () => {
    const refusedFor = async (label: string, credential: Credential, intent: string, quote: string, expected: string): Promise<void> => {
      const before = await statusesOf(db.admin, quote);
      const observed = await observe(db.admin, credential.owner, async () => issue(db.web, credential, intent, newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce())));
      expect(observed.row, label).toEqual(issueRefusal(expected));
      expect(observed.changed, label).toEqual(COUNTER_ONLY);
      expect(observed.counted, label).toBe(1);
      expect(observed.audits, label).toEqual([]);
      expect(await statusesOf(db.admin, quote), label).toEqual(before);
    };
    // Canceled, through cancel_checkout.
    const canceling = await newCredential(db.admin);
    const canceled = await startCheckout(db.admin, db.web, canceling);
    expect((await db.web.query(SQL.cancelCheckout, [SESSION_KEY_VERSION, canceling.digest, canceled.intent])).rows).toEqual([{ result: "CANCELED" }]);
    await refusedFor("a canceled intent", canceling, canceled.intent, canceled.quote, "INTENT_NOT_AWAITING_CONFIRMATION");
    // Superseded, through start_checkout.
    const replacing = await newCredential(db.admin);
    const replaced = await startCheckout(db.admin, db.web, replacing);
    expect((await db.web.query(SQL.startCheckout, [SESSION_KEY_VERSION, replacing.digest, PRODUCT, VARIANT, 1, replaced.intent])).rows[0].result).toBe("STARTED");
    await refusedFor("a superseded intent", replacing, replaced.intent, replaced.quote, "INTENT_NOT_AWAITING_CONFIRMATION");
    // Confirmed, through the functions: the consumed challenge is not replaced by another.
    const confirmed = await baseline(db.admin, db.web, activeNonceKey);
    expect((await consume(db.web, confirmed.credential, confirmed.challenge, confirmed.nonce, confirmed.quote, confirmed.quoteDigest)).result).toBe("CONFIRMED");
    await refusedFor("a confirmed intent", confirmed.credential, confirmed.intent, confirmed.quote, "INTENT_NOT_AWAITING_CONFIRMATION");
    // A QUOTED intent whose quote already has a consumed challenge (written directly: the functions never leave this).
    const usedDirectly = await stage(db.admin, activeNonceKey);
    await db.admin.query(SQL.consumeChallengeDirectly, [usedDirectly.challenge]);
    await refusedFor("a quote that already has a consumed challenge", usedDirectly.credential, usedDirectly.intent, usedDirectly.quote, "CONFIRMATION_ALREADY_USED");
    // An expired quote (a fixture made 20 minutes ago).
    const expiring = await newCredential(db.admin);
    const expired = await fixtureCheckout(db.admin, expiring, minutesAgo(20));
    await refusedFor("an expired quote", expiring, expired.intent, expired.quote, "QUOTE_EXPIRED");
    // A material change of the catalog.
    const repricing = await newCredential(db.admin);
    const repriced = await startCheckout(db.admin, db.web, repricing);
    await whileRepriced(() => refusedFor("a material change", repricing, repriced.intent, repriced.quote, "QUOTE_STALE_CATALOG"));
    // Put back, the same checkout gets its challenge.
    expect((await issue(db.web, repricing, repriced.intent, newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce()))).result).toBe("ISSUED");
  });

  it("PGT-73b: a quote whose stored digest is not the digest of its own fields gets no challenge; each such call writes exactly one rejection, which names no challenge and never the id the caller sent", async () => {
    const credential = await newCredential(db.admin);
    const tampered = await fixtureCheckout(db.admin, credential, minutesAgo(1), hex(32));
    const sentIds: string[] = [];
    // PGT-73b-r: five calls, five rejections.
    for (let occurrence = 1; occurrence <= 5; occurrence += 1) {
      const sent = newId("cf");
      sentIds.push(sent);
      const observed = await observe(db.admin, credential.owner, async () => issue(db.web, credential, tampered.intent, sent, activeNonceKey, await digestOfNonce(db.admin, newNonce())));
      expect(observed.row, `occurrence ${occurrence}`).toEqual(issueRefusal("QUOTE_DIGEST_MISMATCH"));
      expect(observed.changed, `occurrence ${occurrence}`).toEqual(COUNTER_AND_AUDIT);
      expect(observed.counted, `occurrence ${occurrence}`).toBe(1);
      expect(observed.audits, `occurrence ${occurrence}`).toHaveLength(1);
      expectRejection(observed.audits[0], credential, tampered.intent, "QUOTE_DIGEST_MISMATCH", null, `occurrence ${occurrence}`);
    }
    const audits = await auditsOf(db.admin, credential.owner);
    expect(audits.map((row) => row.event_type)).toEqual(Array.from({ length: 5 }, () => "CONFIRMATION_REJECTED"));
    expect(await windowOf(db.admin, credential.owner)).toMatchObject({ window_calls: 5, window_throttled: 0 });
    expect(await statusesOf(db.admin, tampered.quote)).toEqual([]);
    for (const sent of sentIds) expect((await db.admin.query(SQL.auditDetailsHolding, [sent])).rows[0].n, sent).toBe(0);
  });

  it("PGT-209 (results): issue_challenge for a missing or a foreign intent is NOT_AUTHORIZED with no side effects under the limit, and RATE_LIMITED over it", async () => {
    const other = await baseline(db.admin, db.web, activeNonceKey);
    for (const [label, intentFor] of [["a missing intent", () => newId("ci")], ["another owner's intent", () => other.intent]] as const) {
      const under = await newCredential(db.admin);
      const observed = await observe(db.admin, under.owner, async () => issue(db.web, under, intentFor(), newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce())));
      expect(observed.row, label).toEqual(issueRefusal("NOT_AUTHORIZED"));
      expect(observed.changed, label).toEqual(NOTHING);
      expect(observed.windowExists, label).toBe(false);
      expect(observed.audits, label).toEqual([]);

      const over = await newCredential(db.admin);
      await db.admin.query(SQL.insertWindow, [over.owner, "-5 seconds", 30]);
      const throttled = await observe(db.admin, over.owner, async () => issue(db.web, over, intentFor(), newId("cf"), activeNonceKey, await digestOfNonce(db.admin, newNonce())));
      expect(throttled.row, label).toEqual(issueRefusal("RATE_LIMITED"));
      expect(throttled.changed, label).toEqual(COUNTER_AND_AUDIT);
      expect({ counted: throttled.counted, throttled: throttled.throttled }, label).toEqual({ counted: 0, throttled: 1 });
      expect(throttled.audits.map((row) => row.event_type), label).toEqual(["OWNER_RATE_LIMITED"]);
    }
    expect(await statusesOf(db.admin, other.quote)).toEqual([`${other.challenge}:ACTIVE`]);
  });

  it("PGT-214 and PGT-220: a malformed argument of either function is REQUEST_INVALID before any lock and before admission, also over the limit, and changes nothing", async () => {
    const good = await baseline(db.admin, db.web, activeNonceKey);
    const over = await stage(db.admin, activeNonceKey);
    await db.admin.query(SQL.insertWindow, [over.credential.owner, "-5 seconds", 30]);
    const before = await snapshotOf(db.admin);
    const goodDigest = hex(32);
    // issue_challenge: intent id, challenge id, nonce key version, nonce digest.
    const issueArguments: Array<[string, unknown, unknown, unknown, unknown]> = [
      ["no intent id", null, newId("cf"), activeNonceKey, goodDigest],
      ["an intent id with a wrong prefix", `cf_${hex(16)}`, newId("cf"), activeNonceKey, goodDigest],
      ["an intent id in upper case", `ci_${"A".repeat(32)}`, newId("cf"), activeNonceKey, goodDigest],
      ["a short intent id", `ci_${hex(15)}`, newId("cf"), activeNonceKey, goodDigest],
      ["no challenge id", good.intent, null, activeNonceKey, goodDigest],
      ["a challenge id with a wrong prefix", good.intent, `ci_${hex(16)}`, activeNonceKey, goodDigest],
      ["a long challenge id", good.intent, `cf_${hex(17)}`, activeNonceKey, goodDigest],
      ["a challenge id with a trailing space", good.intent, `cf_${hex(16)} `, activeNonceKey, goodDigest],
      ["no nonce key version", good.intent, newId("cf"), null, goodDigest],
      ["nonce key version zero", good.intent, newId("cf"), 0, goodDigest],
      ["a negative nonce key version", good.intent, newId("cf"), -1, goodDigest],
      ["no nonce digest", good.intent, newId("cf"), activeNonceKey, null],
      ["a nonce digest of 63 characters", good.intent, newId("cf"), activeNonceKey, goodDigest.slice(1)],
      ["a nonce digest in upper case", good.intent, newId("cf"), activeNonceKey, goodDigest.toUpperCase()],
      ["a nonce in place of its digest", good.intent, newId("cf"), activeNonceKey, newNonce()],
    ];
    for (const [label, intent, challenge, keyVersion, nonceDigest] of issueArguments) {
      expect(await issue(db.web, good.credential, intent, challenge, keyVersion, nonceDigest), label).toEqual(issueRefusal("REQUEST_INVALID"));
      expect(await issue(db.web, over.credential, intent === good.intent ? over.intent : intent, challenge, keyVersion, nonceDigest), `${label}, over the limit`).toEqual(issueRefusal("REQUEST_INVALID"));
    }
    // consume_challenge: challenge id, nonce, quote id, quote digest.
    const consumeArguments: Array<[string, unknown, unknown, unknown, unknown]> = [
      ["no challenge id", null, good.nonce, good.quote, good.quoteDigest],
      ["a challenge id with a wrong prefix", `qt_${hex(16)}`, good.nonce, good.quote, good.quoteDigest],
      ["a challenge id in upper case", `cf_${"B".repeat(32)}`, good.nonce, good.quote, good.quoteDigest],
      ["no nonce", good.challenge, null, good.quote, good.quoteDigest],
      ["a nonce of 42 characters", good.challenge, good.nonce.slice(0, 42), good.quote, good.quoteDigest],
      ["a nonce of 44 characters", good.challenge, `${good.nonce}A`, good.quote, good.quoteDigest],
      ["a padded nonce", good.challenge, `${good.nonce.slice(0, 42)}=`, good.quote, good.quoteDigest],
      ["a nonce in the other base64 alphabet", good.challenge, `+${good.nonce.slice(1)}`, good.quote, good.quoteDigest],
      ["a nonce whose last character is not canonical", good.challenge, `${good.nonce.slice(0, 42)}B`, good.quote, good.quoteDigest],
      ["a nonce with a space", good.challenge, ` ${good.nonce.slice(1)}`, good.quote, good.quoteDigest],
      ["no quote id", good.challenge, good.nonce, null, good.quoteDigest],
      ["a quote id with a wrong prefix", good.challenge, good.nonce, `ci_${hex(16)}`, good.quoteDigest],
      ["no quote digest", good.challenge, good.nonce, good.quote, null],
      ["a quote digest of 65 characters", good.challenge, good.nonce, good.quote, `${good.quoteDigest}0`],
      ["a quote digest in upper case", good.challenge, good.nonce, good.quote, good.quoteDigest.toUpperCase()],
    ];
    for (const [label, challenge, nonce, quote, quoteDigest] of consumeArguments) {
      expect(await consume(db.web, good.credential, challenge, nonce, quote, quoteDigest), label).toEqual({ result: "REQUEST_INVALID", intent_id: null });
      expect(await consume(db.web, over.credential, challenge === good.challenge ? over.challenge : challenge, nonce, quote, quoteDigest), `${label}, over the limit`).toEqual({ result: "REQUEST_INVALID", intent_id: null });
    }
    // A caller without a live session is told NOT_AUTHORIZED instead, whatever the arguments.
    expect(await issue(db.web, { ...good.credential, digest: hex(32) }, null, null, null, null)).toEqual(issueRefusal("NOT_AUTHORIZED"));
    expect(await consume(db.web, { ...good.credential, digest: hex(32) }, null, null, null, null)).toEqual({ result: "NOT_AUTHORIZED", intent_id: null });
    expect(await snapshotOf(db.admin)).toEqual(before);
    // The well-formed submission still confirms.
    expect(await consume(db.web, good.credential, good.challenge, good.nonce, good.quote, good.quoteDigest)).toEqual({ result: "CONFIRMED", intent_id: good.intent });
  });

  it("PGT-215 (a) and (b): a challenge id that already exists is REFUSED and only counted; a nonce digest that already exists is an error that undoes the whole call", async () => {
    // (a) The same owner: the id belongs to a challenge of another of the owner's quotes, so reuse cannot apply.
    const credential = await newCredential(db.admin);
    const first = await startCheckout(db.admin, db.web, credential);
    const second = await startCheckout(db.admin, db.web, credential);
    const existing = newId("cf");
    expect((await issue(db.web, credential, first.intent, existing, activeNonceKey, await digestOfNonce(db.admin, newNonce()))).result).toBe("ISSUED");
    const sameOwner = await observe(db.admin, credential.owner, async () => issue(db.web, credential, second.intent, existing, activeNonceKey, await digestOfNonce(db.admin, newNonce())));
    expect(sameOwner.row).toEqual(issueRefusal("REFUSED"));
    expect(sameOwner.changed).toEqual(COUNTER_ONLY);
    expect(sameOwner.counted).toBe(1);
    expect(sameOwner.audits).toEqual([]);
    expect(await statusesOf(db.admin, second.quote)).toEqual([]);
    expect(await challengeOf(db.admin, existing)).toMatchObject({ status: "ACTIVE", checkout_intent_id: first.intent });

    // (a) Another owner: the id belongs to somebody else's challenge. The caller's own ACTIVE challenge, which has
    // too little time left to be reused, is left exactly as it was.
    const other = await stage(db.admin, activeNonceKey, { issued: "-270 seconds", expires: "30 seconds" });
    const ownBefore = await challengeOf(db.admin, other.challenge);
    const otherOwner = await observe(db.admin, other.credential.owner, async () => issue(db.web, other.credential, other.intent, existing, activeNonceKey, await digestOfNonce(db.admin, newNonce())));
    expect(otherOwner.row).toEqual(issueRefusal("REFUSED"));
    expect(otherOwner.changed).toEqual(COUNTER_ONLY);
    expect(otherOwner.audits).toEqual([]);
    expect(await challengeOf(db.admin, other.challenge)).toEqual({ ...ownBefore, issued_just_now: false });
    expect(await statusesOf(db.admin, other.quote)).toEqual([`${other.challenge}:ACTIVE`]);

    // (b) A new id with a nonce digest that another challenge already has: not REFUSED. The call raises, and nothing
    // of it survives: not the admission, and not the end of the caller's previous challenge.
    const clashing = await stage(db.admin, activeNonceKey, { issued: "-270 seconds", expires: "30 seconds" });
    const taken = (await challengeOf(db.admin, existing)).nonce_digest;
    const before = await snapshotOf(db.admin);
    let failure: unknown = null;
    try {
      await db.web.query(SQL.issueChallenge, [SESSION_KEY_VERSION, clashing.credential.digest, clashing.intent, newId("cf"), activeNonceKey, taken]);
    } catch (error) {
      failure = error;
    }
    const fields = (typeof failure === "object" && failure !== null ? failure : {}) as { code?: unknown; constraint?: unknown };
    expect({ code: fields.code, constraint: fields.constraint }).toEqual({ code: UNIQUE_VIOLATION, constraint: "confirmation_challenges_nonce_digest_key" });
    expect(await snapshotOf(db.admin)).toEqual(before);
    expect(await windowOf(db.admin, clashing.credential.owner)).toBeNull();
    expect(await challengeOf(db.admin, clashing.challenge)).toMatchObject({ status: "ACTIVE", superseded_at: null });
  });

  it("PGT-216 and PGT-217: a correct submission confirms once, atomically; every replay is CONFIRMATION_ALREADY_USED and only counted", async () => {
    const good = await baseline(db.admin, db.web, activeNonceKey);
    const versionBefore = await intentOf(db.admin, good.intent);
    const observed = await observe(db.admin, good.credential.owner, () => consume(db.web, good.credential, good.challenge, good.nonce, good.quote, good.quoteDigest));
    expect(observed.row).toEqual({ result: "CONFIRMED", intent_id: good.intent });
    expect(observed.changed).toEqual(CONFIRMATION);
    expect(observed.counted).toBe(1);

    expect(await challengeOf(db.admin, good.challenge)).toMatchObject({ status: "CONSUMED", superseded_at: null, expired_marked_at: null, nonce_digest: good.nonceDigest, quote_digest: good.quoteDigest });
    expect(await intentOf(db.admin, good.intent)).toMatchObject({ state: "USER_CONFIRMED", row_version: 3, confirmation_id: good.challenge, confirmation_status: "CONSUMED", current_quote_id: good.quote, superseded_by_intent_id: null, purchase_group_id: versionBefore.purchase_group_id });
    const transitions = (await db.admin.query(SQL.transitionRows, [good.intent])).rows;
    expect(transitions).toHaveLength(2);
    expect(transitions[1]).toMatchObject({ event_type: "SHOPPER_CONFIRMED", actor: "shopper", entry_point: "consume_challenge", from_state: "QUOTED", to_state: "USER_CONFIRMED", from_version: 2, to_version: 3, times_equal: true });
    expect(observed.audits).toHaveLength(1);
    const accepted = observed.audits[0];
    expect(accepted).toMatchObject({ event_type: "CONFIRMATION_ACCEPTED", actor: "shopper", session_id: good.credential.session, owner_id: good.credential.owner, checkout_intent_id: good.intent, operation_id: null, times_equal: true });
    expect(accepted.event_id).toMatch(/^ev_[0-9a-f]{32}$/);
    expect(sortedKeys(accepted.detail)).toEqual(["challengeId", "quoteId", "transitionEventId"]);
    expect(accepted.detail).toEqual({ transitionEventId: transitions[1].event_id, challengeId: good.challenge, quoteId: good.quote });
    // One time for the whole confirmation: the audit row, the transition, the consumption and the intent.
    expect((await db.admin.query(SQL.acceptedTimes, [accepted.event_id])).rows).toEqual([{ audit_is_transition_time: true, consumed_is_transition_time: true, intent_is_transition_time: true, consumed_inside_lifetime: true }]);
    expect(await readCheckout(db.web, good.credential, good.intent)).toMatchObject({ stored_state: "USER_CONFIRMED", effective_status: "USER_CONFIRMED", row_version: 3, challenge_id: null, challenge_usable: false });

    // PGT-217: five replays, with the correct values and with a wrong nonce.
    const settled = await snapshotOf(db.admin);
    for (let replay = 1; replay <= 5; replay += 1) {
      const nonce = replay % 2 === 0 ? newNonce() : good.nonce;
      expect(await consume(db.web, good.credential, good.challenge, nonce, good.quote, good.quoteDigest), `replay ${replay}`).toEqual({ result: "CONFIRMATION_ALREADY_USED", intent_id: null });
    }
    expect(changedTables(settled, await snapshotOf(db.admin))).toEqual(COUNTER_ONLY);
    expect(await windowOf(db.admin, good.credential.owner)).toMatchObject({ window_calls: 8, window_throttled: 0 });
    expect((await auditsOf(db.admin, good.credential.owner)).map((row) => row.event_type)).toEqual(["QUOTE_ISSUED", "CONFIRMATION_ACCEPTED"]);
  });

  it("PGT-201 and PGT-205: a well-formed wrong nonce, quote id or quote digest is CONFIRMATION_MISMATCH, with one rejection each time and the challenge still ACTIVE", async () => {
    const other = await baseline(db.admin, db.web, activeNonceKey);
    const submissions: Array<[string, (good: Baseline) => [unknown, unknown, unknown]]> = [
      ["PGT-201a: a nonce that is not the challenge's", (good) => [newNonce(), good.quote, good.quoteDigest]],
      ["PGT-201b: a quote id that is not the challenge's", (good) => [good.nonce, other.quote, good.quoteDigest]],
      ["PGT-201c and PGT-73d: a quote digest that is not the challenge's", (good) => [good.nonce, good.quote, hex(32)]],
      ["another owner's quote id and digest together", (good) => [good.nonce, other.quote, other.quoteDigest]],
    ];
    for (const [label, wrong] of submissions) {
      const good = await baseline(db.admin, db.web, activeNonceKey);
      const [nonce, quote, quoteDigest] = wrong(good);
      const observed = await observe(db.admin, good.credential.owner, () => consume(db.web, good.credential, good.challenge, nonce, quote, quoteDigest));
      expect(observed.row, label).toEqual({ result: "CONFIRMATION_MISMATCH", intent_id: null });
      expect(observed.changed, label).toEqual(COUNTER_AND_AUDIT);
      expect(observed.counted, label).toBe(1);
      expect(observed.audits, label).toHaveLength(1);
      expectRejection(observed.audits[0], good.credential, good.intent, "CONFIRMATION_MISMATCH", good.challenge, label);
      expect(await challengeOf(db.admin, good.challenge), label).toMatchObject({ status: "ACTIVE", consumed_at: null });
      expect(await intentOf(db.admin, good.intent), label).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
    }
    // PGT-205: five times, five rejections, no quota; and the correct nonce still confirms afterwards.
    const repeated = await baseline(db.admin, db.web, activeNonceKey);
    for (let occurrence = 1; occurrence <= 5; occurrence += 1) {
      expect(await consume(db.web, repeated.credential, repeated.challenge, newNonce(), repeated.quote, repeated.quoteDigest), `occurrence ${occurrence}`).toEqual({ result: "CONFIRMATION_MISMATCH", intent_id: null });
    }
    expect((await auditsOf(db.admin, repeated.credential.owner)).map((row) => row.event_type)).toEqual(["QUOTE_ISSUED", ...Array.from({ length: 5 }, () => "CONFIRMATION_REJECTED")]);
    expect(await windowOf(db.admin, repeated.credential.owner)).toMatchObject({ window_calls: 7 });
    expect(await consume(db.web, repeated.credential, repeated.challenge, repeated.nonce, repeated.quote, repeated.quoteDigest)).toEqual({ result: "CONFIRMED", intent_id: repeated.intent });
  });

  it("PGT-202 and PGT-205: stored digests that do not agree are QUOTE_DIGEST_MISMATCH, with one rejection each time and nothing confirmed", async () => {
    // PGT-202a and PGT-73c: the quote's stored digest is not the digest of its own fields; the challenge is bound to
    // that stored digest, and the submission repeats it.
    const tampered = await stage(db.admin, activeNonceKey, { storedDigest: hex(32) });
    // PGT-202b: the quote is correct; the challenge is bound to another digest, and the submission repeats that one.
    const otherDigest = hex(32);
    const misbound = await stage(db.admin, activeNonceKey, { boundDigest: otherDigest });
    for (const [label, staged, submitted] of [
      ["PGT-202a: the stored quote digest is wrong", tampered, tampered.quoteDigest],
      ["PGT-202b: the challenge is bound to another digest", misbound, otherDigest],
    ] as const) {
      const observed = await observe(db.admin, staged.credential.owner, () => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, submitted));
      expect(observed.row, label).toEqual({ result: "QUOTE_DIGEST_MISMATCH", intent_id: null });
      expect(observed.changed, label).toEqual(COUNTER_AND_AUDIT);
      expect(observed.audits, label).toHaveLength(1);
      expectRejection(observed.audits[0], staged.credential, staged.intent, "QUOTE_DIGEST_MISMATCH", staged.challenge, label);
      expect(await challengeOf(db.admin, staged.challenge), label).toMatchObject({ status: "ACTIVE" });
      expect(await intentOf(db.admin, staged.intent), label).toMatchObject({ state: "QUOTED", confirmation_id: null });
    }
    // PGT-205: four more times on the first: five rejections in all.
    for (let occurrence = 2; occurrence <= 5; occurrence += 1) {
      expect(await consume(db.web, tampered.credential, tampered.challenge, tampered.nonce, tampered.quote, tampered.quoteDigest), `occurrence ${occurrence}`).toEqual({ result: "QUOTE_DIGEST_MISMATCH", intent_id: null });
    }
    expect((await auditsOf(db.admin, tampered.credential.owner)).map((row) => row.event_type)).toEqual(Array.from({ length: 5 }, () => "CONFIRMATION_REJECTED"));
    expect(await windowOf(db.admin, tampered.credential.owner)).toMatchObject({ window_calls: 5 });
  });

  it("PGT-203, PGT-205 and PGT-206: an ended nonce key refuses an ACTIVE challenge with one rejection each time; a challenge that had already ended keeps its own result, unaudited; a VERIFY_ONLY key still confirms", async () => {
    // Everything below is issued under the version that is ACTIVE now, and that version is ended afterwards.
    const correct = await baseline(db.admin, db.web, activeNonceKey); // PGT-203a
    const wrongNonce = await baseline(db.admin, db.web, activeNonceKey); // PGT-203b
    const verifyOnly = await baseline(db.admin, db.web, activeNonceKey); // PGT-203c
    const consumed = await baseline(db.admin, db.web, activeNonceKey); // PGT-206a, c, e
    expect((await consume(db.web, consumed.credential, consumed.challenge, consumed.nonce, consumed.quote, consumed.quoteDigest)).result).toBe("CONFIRMED");
    const superseded = await stage(db.admin, activeNonceKey); // PGT-206b, c
    await db.admin.query(SQL.supersedeChallengeDirectly, [superseded.challenge]);
    const control = await baseline(db.admin, db.web, activeNonceKey); // PGT-206d

    const retired = await retireNonceKey();
    // PGT-203c: VERIFY_ONLY is not ended. A correct submission confirms; no rejection is written.
    const stillGood = await observe(db.admin, verifyOnly.credential.owner, () => consume(db.web, verifyOnly.credential, verifyOnly.challenge, verifyOnly.nonce, verifyOnly.quote, verifyOnly.quoteDigest));
    expect(stillGood.row).toEqual({ result: "CONFIRMED", intent_id: verifyOnly.intent });
    expect(stillGood.audits.map((row) => row.event_type)).toEqual(["CONFIRMATION_ACCEPTED"]);

    await endNonceKey(retired);

    // PGT-203a and PGT-203b, and PGT-206d: an ACTIVE challenge under the ended key.
    for (const [label, good, nonce] of [
      ["PGT-203a: correct values", correct, correct.nonce],
      ["PGT-203b: a wrong nonce (the key is looked at first)", wrongNonce, newNonce()],
      ["PGT-206d: the control", control, control.nonce],
    ] as const) {
      const observed = await observe(db.admin, good.credential.owner, () => consume(db.web, good.credential, good.challenge, nonce, good.quote, good.quoteDigest));
      expect(observed.row, label).toEqual({ result: "CONFIRMATION_KEY_REVOKED", intent_id: null });
      expect(observed.changed, label).toEqual(COUNTER_AND_AUDIT);
      expect(observed.counted, label).toBe(1);
      expect(observed.audits, label).toHaveLength(1);
      expectRejection(observed.audits[0], good.credential, good.intent, "CONFIRMATION_KEY_REVOKED", good.challenge, label);
      expect(await challengeOf(db.admin, good.challenge), label).toMatchObject({ status: "ACTIVE" });
      expect(await intentOf(db.admin, good.intent), label).toMatchObject({ state: "QUOTED", confirmation_id: null });
    }
    // PGT-205: four more times: five rejections in all.
    for (let occurrence = 2; occurrence <= 5; occurrence += 1) {
      expect(await consume(db.web, correct.credential, correct.challenge, correct.nonce, correct.quote, correct.quoteDigest), `occurrence ${occurrence}`).toEqual({ result: "CONFIRMATION_KEY_REVOKED", intent_id: null });
    }
    expect((await auditsOf(db.admin, correct.credential.owner)).filter((row) => row.event_type === "CONFIRMATION_REJECTED")).toHaveLength(5);

    // PGT-206a, b, c: a challenge that had already ended, under the ended key. Its own result, no rejection, counted.
    const ended: Array<[string, Credential, string, string, string, string, string]> = [
      ["PGT-206a: CONSUMED, correct values", consumed.credential, consumed.challenge, consumed.nonce, consumed.quote, consumed.quoteDigest, "CONFIRMATION_ALREADY_USED"],
      ["PGT-206c: CONSUMED, a wrong nonce", consumed.credential, consumed.challenge, newNonce(), consumed.quote, consumed.quoteDigest, "CONFIRMATION_ALREADY_USED"],
      ["PGT-206b: SUPERSEDED, correct values", superseded.credential, superseded.challenge, superseded.nonce, superseded.quote, superseded.quoteDigest, "CONFIRMATION_SUPERSEDED"],
      ["PGT-206c: SUPERSEDED, a wrong nonce", superseded.credential, superseded.challenge, newNonce(), superseded.quote, superseded.quoteDigest, "CONFIRMATION_SUPERSEDED"],
    ];
    for (const [label, credential, challenge, nonce, quote, quoteDigest, expected] of ended) {
      const observed = await observe(db.admin, credential.owner, () => consume(db.web, credential, challenge, nonce, quote, quoteDigest));
      expect(observed.row, label).toEqual({ result: expected, intent_id: null });
      expect(observed.changed, label).toEqual(COUNTER_ONLY);
      expect(observed.counted, label).toBe(1);
      expect(observed.audits, label).toEqual([]);
    }
    // PGT-206e: five times: the same result, no audit row, five counted.
    const beforeFive = await windowOf(db.admin, consumed.credential.owner);
    const auditsBeforeFive = (await auditsOf(db.admin, consumed.credential.owner)).length;
    for (let occurrence = 1; occurrence <= 5; occurrence += 1) {
      expect(await consume(db.web, consumed.credential, consumed.challenge, consumed.nonce, consumed.quote, consumed.quoteDigest), `occurrence ${occurrence}`).toEqual({ result: "CONFIRMATION_ALREADY_USED", intent_id: null });
    }
    expect((await windowOf(db.admin, consumed.credential.owner))?.window_calls).toBe((beforeFive?.window_calls ?? 0) + 5);
    expect(await auditsOf(db.admin, consumed.credential.owner)).toHaveLength(auditsBeforeFive);
    expect(await intentOf(db.admin, consumed.intent)).toMatchObject({ state: "USER_CONFIRMED", row_version: 3, confirmation_id: consumed.challenge });
  });

  it("PGT-207R (results): a missing or a foreign challenge is CONFIRMATION_NOT_FOUND, under the limit and over it, and is neither counted nor throttled nor audited", async () => {
    const foreign = await baseline(db.admin, db.web, activeNonceKey);
    const cases: Array<[string, boolean, () => string]> = [
      ["case 1: a missing id, under the limit", false, () => newId("cf")],
      ["case 2: a missing id, over the limit", true, () => newId("cf")],
      ["case 3: another owner's id, under the limit", false, () => foreign.challenge],
      ["case 4: another owner's id, over the limit", true, () => foreign.challenge],
    ];
    for (const [label, overTheLimit, challengeOfCase] of cases) {
      const caller = await newCredential(db.admin);
      if (overTheLimit) await db.admin.query(SQL.insertWindow, [caller.owner, "-5 seconds", 30]);
      const windowBefore = await windowOf(db.admin, caller.owner);
      // The values a holder of the foreign challenge would send: the result must still be "not found".
      const observed = await observe(db.admin, caller.owner, () => consume(db.web, caller, challengeOfCase(), foreign.nonce, foreign.quote, foreign.quoteDigest));
      expect(observed.row, label).toEqual({ result: "CONFIRMATION_NOT_FOUND", intent_id: null });
      expect(observed.changed, label).toEqual(NOTHING);
      expect(observed.audits, label).toEqual([]);
      expect(await windowOf(db.admin, caller.owner), label).toEqual(windowBefore);
      expect(observed.windowExists, label).toBe(overTheLimit);
    }
    expect(await challengeOf(db.admin, foreign.challenge)).toMatchObject({ status: "ACTIVE" });
    // An own challenge, over the limit, is throttled: the ownership decision is what comes first, not the result.
    const own = await stage(db.admin, activeNonceKey);
    await db.admin.query(SQL.insertWindow, [own.credential.owner, "-5 seconds", 30]);
    expect(await consume(db.web, own.credential, own.challenge, own.nonce, own.quote, own.quoteDigest)).toEqual({ result: "RATE_LIMITED", intent_id: null });
  });

  it("PGT-20 and PGT-218: an expired challenge is marked and refused; an expired quote, a material change and an intent that no longer awaits confirmation are refused, and only counted", async () => {
    // PGT-20: a challenge that expired 30 seconds ago and is still stored ACTIVE.
    const late = await stage(db.admin, activeNonceKey, { issued: "-400 seconds", expires: "-30 seconds" });
    const marked = await observe(db.admin, late.credential.owner, () => consume(db.web, late.credential, late.challenge, late.nonce, late.quote, late.quoteDigest));
    expect(marked.row).toEqual({ result: "CONFIRMATION_EXPIRED", intent_id: null });
    expect(marked.changed).toEqual(COUNTER_AND_CHALLENGE);
    expect(marked.audits).toEqual([]);
    expect(await challengeOf(db.admin, late.challenge)).toMatchObject({ status: "EXPIRED", consumed_at: null, superseded_at: null });
    expect((await challengeOf(db.admin, late.challenge)).expired_marked_at).toBeInstanceOf(Date);
    // Again: now stored EXPIRED. The same result; nothing left to mark.
    const again = await observe(db.admin, late.credential.owner, () => consume(db.web, late.credential, late.challenge, late.nonce, late.quote, late.quoteDigest));
    expect(again.row).toEqual({ result: "CONFIRMATION_EXPIRED", intent_id: null });
    expect(again.changed).toEqual(COUNTER_ONLY);

    // PGT-218a: a material change committed before the call.
    const stale = await baseline(db.admin, db.web, activeNonceKey);
    const staleObserved = await whileRepriced(() => observe(db.admin, stale.credential.owner, () => consume(db.web, stale.credential, stale.challenge, stale.nonce, stale.quote, stale.quoteDigest)));
    expect(staleObserved.row).toEqual({ result: "QUOTE_STALE_CATALOG", intent_id: null });
    expect(staleObserved.changed).toEqual(COUNTER_ONLY);
    expect(staleObserved.audits).toEqual([]);
    expect(await challengeOf(db.admin, stale.challenge)).toMatchObject({ status: "ACTIVE" });
    // Put back, the same submission confirms.
    expect(await consume(db.web, stale.credential, stale.challenge, stale.nonce, stale.quote, stale.quoteDigest)).toEqual({ result: "CONFIRMED", intent_id: stale.intent });

    // The quote has expired, and the challenge (a fixture with a later expiry than its quote's) has not.
    const outlived = await stage(db.admin, activeNonceKey, { createdAt: minutesAgo(20), expires: "200 seconds" });
    const quoteExpired = await observe(db.admin, outlived.credential.owner, () => consume(db.web, outlived.credential, outlived.challenge, outlived.nonce, outlived.quote, outlived.quoteDigest));
    expect(quoteExpired.row).toEqual({ result: "QUOTE_EXPIRED", intent_id: null });
    expect(quoteExpired.changed).toEqual(COUNTER_ONLY);
    expect(await challengeOf(db.admin, outlived.challenge)).toMatchObject({ status: "ACTIVE", expired_marked_at: null });
  });

  it("PGT-221: a challenge left ACTIVE after its intent was canceled or superseded is unusable: the six submissions give their six results, and nothing is ever confirmed", async () => {
    const foreign = await baseline(db.admin, db.web, activeNonceKey);
    const endings: Array<[string, (good: Baseline) => Promise<void>, string, number]> = [
      [
        "canceled",
        async (good) => {
          expect((await db.web.query(SQL.cancelCheckout, [SESSION_KEY_VERSION, good.credential.digest, good.intent])).rows).toEqual([{ result: "CANCELED" }]);
        },
        "CANCELED_LOCAL",
        3,
      ],
      [
        "superseded",
        async (good) => {
          expect((await db.web.query(SQL.startCheckout, [SESSION_KEY_VERSION, good.credential.digest, PRODUCT, VARIANT, 1, good.intent])).rows[0].result).toBe("STARTED");
        },
        "SUPERSEDED",
        3,
      ],
    ];
    for (const [ending, end, state, version] of endings) {
      const expectUnconfirmed = async (label: string, good: Baseline): Promise<void> => {
        expect(await intentOf(db.admin, good.intent), label).toMatchObject({ state, row_version: version, confirmation_id: null, confirmation_status: null });
        expect((await auditsOf(db.admin, good.credential.owner)).filter((row) => row.event_type === "CONFIRMATION_ACCEPTED"), label).toEqual([]);
        expect(await readCheckout(db.web, good.credential, good.intent), label).toMatchObject({ stored_state: state, challenge_usable: false });
      };
      const submit = async (label: string, good: Baseline, challenge: unknown, nonce: unknown, quote: unknown, quoteDigest: unknown): Promise<Observed> => {
        const observed = await observe(db.admin, good.credential.owner, () => consume(db.web, good.credential, challenge, nonce, quote, quoteDigest));
        await expectUnconfirmed(label, good);
        expect((await db.admin.query(SQL.transitionRows, [good.intent])).rows, label).toHaveLength(2);
        return observed;
      };

      // 1. Correct and unexpired.
      const first = await baseline(db.admin, db.web, activeNonceKey);
      await end(first);
      expect(await challengeOf(db.admin, first.challenge), ending).toMatchObject({ status: "ACTIVE" });
      const one = await submit(`${ending}, 1: correct`, first, first.challenge, first.nonce, first.quote, first.quoteDigest);
      expect(one.row, `${ending}, 1`).toEqual({ result: "INTENT_NOT_AWAITING_CONFIRMATION", intent_id: null });
      expect(one.changed, `${ending}, 1`).toEqual(COUNTER_ONLY);
      expect(one.audits, `${ending}, 1`).toEqual([]);
      // 2. A well-formed wrong nonce.
      const two = await submit(`${ending}, 2: wrong nonce`, first, first.challenge, newNonce(), first.quote, first.quoteDigest);
      expect(two.row, `${ending}, 2`).toEqual({ result: "CONFIRMATION_MISMATCH", intent_id: null });
      expect(two.changed, `${ending}, 2`).toEqual(COUNTER_AND_AUDIT);
      expectRejection(two.audits[0], first.credential, first.intent, "CONFIRMATION_MISMATCH", first.challenge, `${ending}, 2`);
      // 3. The correct nonce with a wrong quote id, and with a wrong quote digest.
      for (const [what, quote, quoteDigest] of [["quote id", foreign.quote, first.quoteDigest], ["quote digest", first.quote, hex(32)]] as const) {
        const three = await submit(`${ending}, 3: wrong ${what}`, first, first.challenge, first.nonce, quote, quoteDigest);
        expect(three.row, `${ending}, 3 (${what})`).toEqual({ result: "CONFIRMATION_MISMATCH", intent_id: null });
        expect(three.changed, `${ending}, 3 (${what})`).toEqual(COUNTER_AND_AUDIT);
        expect(three.audits, `${ending}, 3 (${what})`).toHaveLength(1);
      }
      // 4. Malformed.
      const four = await submit(`${ending}, 4: malformed`, first, first.challenge, "not-a-nonce", first.quote, first.quoteDigest);
      expect(four.row, `${ending}, 4`).toEqual({ result: "REQUEST_INVALID", intent_id: null });
      expect(four.changed, `${ending}, 4`).toEqual(NOTHING);
      // 6. Another owner's challenge id, and a missing one.
      for (const challenge of [foreign.challenge, newId("cf")]) {
        const six = await submit(`${ending}, 6: not the caller's`, first, challenge, first.nonce, first.quote, first.quoteDigest);
        expect(six.row, `${ending}, 6`).toEqual({ result: "CONFIRMATION_NOT_FOUND", intent_id: null });
        expect(six.changed, `${ending}, 6`).toEqual(NOTHING);
      }
      expect(await challengeOf(db.admin, first.challenge), ending).toMatchObject({ status: "ACTIVE" });

      // 5. Correct, after the challenge's expiry: a second checkout, whose ACTIVE challenge expired 30 seconds ago.
      const credential = await newCredential(db.admin);
      const started = await startCheckout(db.admin, db.web, credential);
      const expired = await fixtureChallenge(db.admin, started.quote, activeNonceKey, "-400 seconds", "-30 seconds");
      const second: Baseline = { ...started, credential, ...expired, keyVersion: activeNonceKey };
      await end(second);
      const five = await submit(`${ending}, 5: after expiry`, second, second.challenge, second.nonce, second.quote, second.quoteDigest);
      expect(five.row, `${ending}, 5`).toEqual({ result: "CONFIRMATION_EXPIRED", intent_id: null });
      expect(five.changed, `${ending}, 5`).toEqual(COUNTER_AND_CHALLENGE);
      expect(five.audits, `${ending}, 5`).toEqual([]);
      expect(await challengeOf(db.admin, second.challenge), `${ending}, 5`).toMatchObject({ status: "EXPIRED" });
    }
    expect(await challengeOf(db.admin, foreign.challenge)).toMatchObject({ status: "ACTIVE" });
  });

  it("PGT-222: where two conditions of consume_challenge hold at once, the earlier one decides: eighteen concrete overlaps", async () => {
    type Expected = { readonly result: string; readonly changed: readonly string[]; readonly audited: string | null; readonly status: string };
    const overlap = async (label: string, staged: Staged, submitted: { readonly nonce?: string; readonly quoteDigest?: string }, expected: Expected): Promise<void> => {
      const observed = await observe(db.admin, staged.credential.owner, () => consume(db.web, staged.credential, staged.challenge, submitted.nonce ?? staged.nonce, staged.quote, submitted.quoteDigest ?? staged.quoteDigest));
      expect(observed.row, label).toEqual({ result: expected.result, intent_id: null });
      expect(observed.changed, label).toEqual(expected.changed);
      expect(observed.audits.map((row) => row.event_type), label).toEqual(expected.audited === null ? [] : [expected.audited === "OWNER_RATE_LIMITED" ? "OWNER_RATE_LIMITED" : "CONFIRMATION_REJECTED"]);
      if (expected.audited !== null && expected.audited !== "OWNER_RATE_LIMITED") expectRejection(observed.audits[0], staged.credential, staged.intent, expected.audited, staged.challenge, label);
      expect(await challengeOf(db.admin, staged.challenge), label).toMatchObject({ status: expected.status });
      expect(await intentOf(db.admin, staged.intent), label).toMatchObject({ confirmation_id: null });
      expect((await db.admin.query(SQL.transitionRows, [staged.intent])).rows.filter((row) => row.event_type === "SHOPPER_CONFIRMED"), label).toEqual([]);
    };
    /**
     * A second challenge of the same quote, CONSUMED by a direct write. A quote has one ACTIVE challenge at most, so
     * this is used only after the staged challenge has ended: the sibling is inserted ACTIVE and consumed at once.
     */
    const consumedSibling = async (staged: Staged): Promise<void> => {
      const sibling = newId("cf");
      await db.admin.query(SQL.begin);
      try {
        await db.admin.query(SQL.insertChallenge, [sibling, await digestOfNonce(db.admin, newNonce()), staged.quote, activeNonceKey, "-10 seconds", "200 seconds", null]);
        await db.admin.query(SQL.consumeChallengeDirectly, [sibling]);
        await db.admin.query(SQL.commit);
      } catch (error) {
        await db.admin.query(SQL.rollback);
        throw error;
      }
    };
    /** A staged checkout whose one challenge has ended, with a second challenge of the same quote CONSUMED. */
    const endedWithConsumedSibling = async (keyVersion: number, status: "SUPERSEDED" | "EXPIRED"): Promise<Staged> => {
      const staged = await stage(db.admin, keyVersion);
      await endChallenge(db.admin, staged.challenge, status);
      await consumedSibling(staged);
      return staged;
    };

    // Cases d, e and f need a nonce key that is ended after their challenges exist.
    const caseD = await stage(db.admin, activeNonceKey);
    const caseE = await stage(db.admin, activeNonceKey);
    await db.admin.query(SQL.expireChallengeDirectly, [caseE.challenge]);
    const caseF = await endedWithConsumedSibling(activeNonceKey, "EXPIRED");
    await endNonceKey(await retireNonceKey());

    // a: submitted CONSUMED, and a wrong nonce. Row 3.
    const caseA = await stage(db.admin, activeNonceKey);
    await db.admin.query(SQL.consumeChallengeDirectly, [caseA.challenge]);
    await overlap("a: CONSUMED with a wrong nonce", caseA, { nonce: newNonce() }, { result: "CONFIRMATION_ALREADY_USED", changed: COUNTER_ONLY, audited: null, status: "CONSUMED" });
    // b: submitted SUPERSEDED, and a wrong nonce. Row 2.
    const caseB = await stage(db.admin, activeNonceKey);
    await db.admin.query(SQL.supersedeChallengeDirectly, [caseB.challenge]);
    await overlap("b: SUPERSEDED with a wrong nonce", caseB, { nonce: newNonce() }, { result: "CONFIRMATION_SUPERSEDED", changed: COUNTER_ONLY, audited: null, status: "SUPERSEDED" });
    // c: submitted SUPERSEDED, and another challenge of the quote CONSUMED. Row 2 before row 5.
    const caseC = await endedWithConsumedSibling(activeNonceKey, "SUPERSEDED");
    await overlap("c: SUPERSEDED beside a consumed one", caseC, {}, { result: "CONFIRMATION_SUPERSEDED", changed: COUNTER_ONLY, audited: null, status: "SUPERSEDED" });
    // d: ACTIVE, key ended, wrong nonce. Row 4 before row 6: the rejection names the key, not the mismatch.
    await overlap("d: ACTIVE under an ended key with a wrong nonce", caseD, { nonce: newNonce() }, { result: "CONFIRMATION_KEY_REVOKED", changed: COUNTER_AND_AUDIT, audited: "CONFIRMATION_KEY_REVOKED", status: "ACTIVE" });
    // e: stored EXPIRED, key ended. Row 4 before row 7.
    await overlap("e: stored EXPIRED under an ended key", caseE, {}, { result: "CONFIRMATION_KEY_REVOKED", changed: COUNTER_AND_AUDIT, audited: "CONFIRMATION_KEY_REVOKED", status: "EXPIRED" });
    // f: stored EXPIRED, key ended, another challenge CONSUMED. Row 4 before row 5.
    await overlap("f: stored EXPIRED under an ended key beside a consumed one", caseF, {}, { result: "CONFIRMATION_KEY_REVOKED", changed: COUNTER_AND_AUDIT, audited: "CONFIRMATION_KEY_REVOKED", status: "EXPIRED" });
    // g: stored EXPIRED, another challenge CONSUMED, key valid. Row 5 before row 7.
    const caseG = await endedWithConsumedSibling(activeNonceKey, "EXPIRED");
    await overlap("g: stored EXPIRED beside a consumed one", caseG, {}, { result: "CONFIRMATION_ALREADY_USED", changed: COUNTER_ONLY, audited: null, status: "EXPIRED" });
    // h: ACTIVE beside a different CONSUMED challenge. The functions never leave this; a direct fixture does. Row 5.
    const hCredential = await newCredential(db.admin);
    const hCheckout = await fixtureCheckout(db.admin, hCredential);
    const hSibling = await fixtureChallenge(db.admin, hCheckout.quote, activeNonceKey);
    await db.admin.query(SQL.consumeChallengeDirectly, [hSibling.challenge]);
    const hActive = await fixtureChallenge(db.admin, hCheckout.quote, activeNonceKey);
    await overlap("h: ACTIVE beside a consumed one", { ...hCheckout, ...hActive, credential: hCredential }, {}, { result: "CONFIRMATION_ALREADY_USED", changed: COUNTER_ONLY, audited: null, status: "ACTIVE" });
    // i: a wrong nonce, and the challenge past its expiry. Row 6 before row 7: the challenge is not marked.
    const caseI = await stage(db.admin, activeNonceKey, { issued: "-400 seconds", expires: "-30 seconds" });
    await overlap("i: a wrong nonce on a challenge past its expiry", caseI, { nonce: newNonce() }, { result: "CONFIRMATION_MISMATCH", changed: COUNTER_AND_AUDIT, audited: "CONFIRMATION_MISMATCH", status: "ACTIVE" });
    // j: a wrong nonce, and a stored quote digest that is wrong. Row 6 before row 8.
    const caseJ = await stage(db.admin, activeNonceKey, { storedDigest: hex(32) });
    await overlap("j: a wrong nonce on a quote with a wrong stored digest", caseJ, { nonce: newNonce() }, { result: "CONFIRMATION_MISMATCH", changed: COUNTER_AND_AUDIT, audited: "CONFIRMATION_MISMATCH", status: "ACTIVE" });
    // k: past expiry, and a wrong stored digest. Row 7 before row 8: marked, not audited.
    const caseK = await stage(db.admin, activeNonceKey, { storedDigest: hex(32), issued: "-400 seconds", expires: "-30 seconds" });
    await overlap("k: past expiry on a quote with a wrong stored digest", caseK, {}, { result: "CONFIRMATION_EXPIRED", changed: COUNTER_AND_CHALLENGE, audited: null, status: "EXPIRED" });
    // l: a wrong stored digest, and a material change. Row 8 before row 10.
    const caseL = await stage(db.admin, activeNonceKey, { storedDigest: hex(32) });
    await whileRepriced(() => overlap("l: a wrong stored digest and a material change", caseL, {}, { result: "QUOTE_DIGEST_MISMATCH", changed: COUNTER_AND_AUDIT, audited: "QUOTE_DIGEST_MISMATCH", status: "ACTIVE" }));
    // m: a material change, and the intent canceled. Row 10 before row 11.
    const caseM = await stage(db.admin, activeNonceKey);
    await cancelFixtureDirectly(db.admin, caseM.credential, caseM.intent);
    await whileRepriced(() => overlap("m: a material change on a canceled intent", caseM, {}, { result: "QUOTE_STALE_CATALOG", changed: COUNTER_ONLY, audited: null, status: "ACTIVE" }));
    // n: the quote expired, the challenge (a fixture with a later expiry than its quote's) not. Row 9.
    const caseN = await stage(db.admin, activeNonceKey, { createdAt: minutesAgo(20), expires: "200 seconds" });
    await overlap("n: an expired quote under a challenge that outlives it", caseN, {}, { result: "QUOTE_EXPIRED", changed: COUNTER_ONLY, audited: null, status: "ACTIVE" });
    // o: the caller's window is full (30 admitted, none throttled), and the nonce is wrong. Step 4b before row 6:
    // RATE_LIMITED, the first throttled call of the window, with its one OWNER_RATE_LIMITED row and no rejection.
    const caseO = await stage(db.admin, activeNonceKey);
    await db.admin.query(SQL.insertWindow, [caseO.credential.owner, "-5 seconds", 30]);
    await overlap("o: a wrong nonce from a caller over the limit", caseO, { nonce: newNonce() }, { result: "RATE_LIMITED", changed: COUNTER_AND_AUDIT, audited: "OWNER_RATE_LIMITED", status: "ACTIVE" });
    expect(await windowOf(db.admin, caseO.credential.owner)).toEqual({ window_calls: 30, window_throttled: 1, total_throttled: 1 });
    // p: stored EXPIRED, another challenge CONSUMED, and a wrong nonce. Row 5 before row 6: not audited.
    const caseP = await endedWithConsumedSibling(activeNonceKey, "EXPIRED");
    await overlap("p: stored EXPIRED beside a consumed one, with a wrong nonce", caseP, { nonce: newNonce() }, { result: "CONFIRMATION_ALREADY_USED", changed: COUNTER_ONLY, audited: null, status: "EXPIRED" });
    // q: a wrong stored digest, and the quote expired under a challenge that outlives it. Row 8 before row 9.
    const caseQ = await stage(db.admin, activeNonceKey, { createdAt: minutesAgo(20), storedDigest: hex(32), expires: "200 seconds" });
    await overlap("q: a wrong stored digest on an expired quote", caseQ, {}, { result: "QUOTE_DIGEST_MISMATCH", changed: COUNTER_AND_AUDIT, audited: "QUOTE_DIGEST_MISMATCH", status: "ACTIVE" });
    // r: the quote expired under a challenge that outlives it, and a material change. Row 9 before row 10.
    const caseR = await stage(db.admin, activeNonceKey, { createdAt: minutesAgo(20), expires: "200 seconds" });
    await whileRepriced(() => overlap("r: an expired quote and a material change", caseR, {}, { result: "QUOTE_EXPIRED", changed: COUNTER_ONLY, audited: null, status: "ACTIVE" }));
  });

  it("PGT-204 (cases A4 to A8): when the audit row of a confirmation cannot be written, the call raises and nothing of it survives", async () => {
    // Set up before any transaction is begun. A6 needs a nonce key that is ended after its challenge exists.
    const a6 = await baseline(db.admin, db.web, activeNonceKey);
    await endNonceKey(await retireNonceKey());
    const a4 = await baseline(db.admin, db.web, activeNonceKey);
    const a5 = await stage(db.admin, activeNonceKey, { storedDigest: hex(32) });
    const a7Credential = await newCredential(db.admin);
    const a7 = await fixtureCheckout(db.admin, a7Credential, minutesAgo(1), hex(32));
    const a8 = await baseline(db.admin, db.web, activeNonceKey);
    const a7Digest = await digestOfNonce(db.admin, newNonce());
    const wrongNonce = newNonce();

    const cases: Array<[string, Credential, "issueChallenge" | "consumeChallenge", readonly unknown[], string]> = [
      ["A4: the rejection of a wrong nonce", a4.credential, "consumeChallenge", [SESSION_KEY_VERSION, a4.credential.digest, a4.challenge, wrongNonce, a4.quote, a4.quoteDigest], "shopaccess_api.consume_challenge("],
      ["A5: the rejection of a wrong stored quote digest", a5.credential, "consumeChallenge", [SESSION_KEY_VERSION, a5.credential.digest, a5.challenge, a5.nonce, a5.quote, a5.quoteDigest], "shopaccess_api.consume_challenge("],
      ["A6: the rejection of an ended nonce key", a6.credential, "consumeChallenge", [SESSION_KEY_VERSION, a6.credential.digest, a6.challenge, a6.nonce, a6.quote, a6.quoteDigest], "shopaccess_api.consume_challenge("],
      ["A7: the rejection of a wrong stored quote digest at issue", a7Credential, "issueChallenge", [SESSION_KEY_VERSION, a7Credential.digest, a7.intent, newId("cf"), activeNonceKey, a7Digest], "shopaccess_api.issue_challenge("],
      ["A8: the acceptance of a correct submission", a8.credential, "consumeChallenge", [SESSION_KEY_VERSION, a8.credential.digest, a8.challenge, a8.nonce, a8.quote, a8.quoteDigest], "shopaccess_api.consume_challenge("],
    ];
    const outcomes: Array<{ label: string; sqlstate: string | null; afterwards: string | null }> = [];
    for (const [label, credential, target, values, functionName] of cases) {
      const before = await snapshotOf(db.admin);
      const windowBefore = await windowOf(db.admin, credential.owner);
      const outcome = await withRevokedPrivilege(db.admin, target, values);
      outcomes.push({ label, sqlstate: outcome.sqlstate, afterwards: outcome.afterwards });
      // Inside the transaction, before the call: the function owner had lost exactly INSERT on audit_events.
      expect(outcome.held, label).toEqual({ audit_insert: false, challenge_insert: true, challenge_status_update: true, intent_update: true, transition_insert: true, window_insert: true });
      // The call raised, and it is the denied insert into audit_events, inside the function under test, that raised.
      expect(outcome.returned, label).toBeNull();
      expect(outcome.sqlstate, label).toBe(INSUFFICIENT_PRIVILEGE);
      expect(outcome.message, label).toBe("permission denied for table audit_events");
      expect(outcome.where ?? "", label).toContain(functionName);
      expect(outcome.where ?? "", label).toContain("INSERT INTO shopaccess.audit_events");
      // The transaction was aborted by it, and was rolled back.
      expect(outcome.afterwards, label).toBe(IN_FAILED_TRANSACTION);
      // Afterwards: the privilege is back, and nothing survives: no counter, no challenge change, no intent change.
      expect((await db.admin.query(SQL.definerPrivileges)).rows[0], label).toEqual({ audit_insert: true, challenge_insert: true, challenge_status_update: true, intent_update: true, transition_insert: true, window_insert: true });
      expect(await snapshotOf(db.admin), label).toEqual(before);
      expect(await windowOf(db.admin, credential.owner), label).toEqual(windowBefore);
    }
    console.info(`PGT-204 as observed: ${JSON.stringify(outcomes)}`);
    // Outside the test transaction each of the five does what it should: the audit row was all that was missing.
    expect(await consume(db.web, a4.credential, a4.challenge, wrongNonce, a4.quote, a4.quoteDigest)).toEqual({ result: "CONFIRMATION_MISMATCH", intent_id: null });
    expect(await consume(db.web, a5.credential, a5.challenge, a5.nonce, a5.quote, a5.quoteDigest)).toEqual({ result: "QUOTE_DIGEST_MISMATCH", intent_id: null });
    expect(await consume(db.web, a6.credential, a6.challenge, a6.nonce, a6.quote, a6.quoteDigest)).toEqual({ result: "CONFIRMATION_KEY_REVOKED", intent_id: null });
    expect((await issue(db.web, a7Credential, a7.intent, newId("cf"), activeNonceKey, a7Digest)).result).toBe("QUOTE_DIGEST_MISMATCH");
    expect(await consume(db.web, a8.credential, a8.challenge, a8.nonce, a8.quote, a8.quoteDigest)).toEqual({ result: "CONFIRMED", intent_id: a8.intent });
  });

  it("PGT-112 (c), case S3: a deferred check that fails for consume_challenge's own writes is raised by the call itself, with its constraint name, and nothing survives", async () => {
    const good = await baseline(db.admin, db.web, activeNonceKey);
    const before = await snapshotOf(db.admin);
    expect((await db.admin.query(SQL.suppressionFixtures)).rows[0]).toEqual({ triggers: 0, functions: 0 });
    const outcome = await withSuppressedInsert(db.admin, [SESSION_KEY_VERSION, good.credential.digest, good.challenge, good.nonce, good.quote, good.quoteDigest]);
    console.info(`PGT-112(c) S3 as observed: ${JSON.stringify(outcome)}`);
    // The test-only function and its one trigger existed inside the transaction, and only there.
    expect(outcome.fixturesInside).toEqual({ triggers: 1, functions: 1 });
    // The transition was not inserted, so the intent has no history for its new version. The function forces the
    // deferred checks before it returns: the call raises; it returns nothing.
    expect(outcome.returned).toBeNull();
    expect(outcome.sqlstate).toBe(CHECK_VIOLATION);
    expect(outcome.constraint).toBe("checkout_intents_history_check");
    expect(outcome.afterwards).toBe(IN_FAILED_TRANSACTION);
    // After the rollback: no test-only object is left, and nothing of the call survives.
    expect((await db.admin.query(SQL.suppressionFixtures)).rows[0]).toEqual({ triggers: 0, functions: 0 });
    expect(await snapshotOf(db.admin)).toEqual(before);
    expect(await challengeOf(db.admin, good.challenge)).toMatchObject({ status: "ACTIVE", consumed_at: null });
    expect(await intentOf(db.admin, good.intent)).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
    // Without the trigger the same submission confirms.
    expect(await consume(db.web, good.credential, good.challenge, good.nonce, good.quote, good.quoteDigest)).toEqual({ result: "CONFIRMED", intent_id: good.intent });
    expect((await db.admin.query(SQL.transitionRows, [good.intent])).rows).toHaveLength(2);
  });

  it("PGT-133: issue_challenge, consume_challenge and read_checkout refuse every isolation level but READ COMMITTED, authorized or not, and change nothing", async () => {
    const good = await baseline(db.admin, db.web, activeNonceKey);
    const unknown = hex(32);
    const before = await snapshotOf(db.admin);
    const observed: Array<{ level: string; situation: string; sqlstate: string | null }> = [];
    const situations: Array<[string, "issueChallenge" | "consumeChallenge" | "readCheckout", readonly unknown[]]> = [
      ["issue_challenge, authorized", "issueChallenge", [SESSION_KEY_VERSION, good.credential.digest, good.intent, newId("cf"), activeNonceKey, hex(32)]],
      ["issue_challenge, unauthorized", "issueChallenge", [SESSION_KEY_VERSION, unknown, good.intent, newId("cf"), activeNonceKey, hex(32)]],
      ["issue_challenge, malformed", "issueChallenge", [SESSION_KEY_VERSION, good.credential.digest, null, null, null, null]],
      ["consume_challenge, authorized", "consumeChallenge", [SESSION_KEY_VERSION, good.credential.digest, good.challenge, good.nonce, good.quote, good.quoteDigest]],
      ["consume_challenge, unauthorized", "consumeChallenge", [SESSION_KEY_VERSION, unknown, good.challenge, good.nonce, good.quote, good.quoteDigest]],
      ["consume_challenge, no such challenge", "consumeChallenge", [SESSION_KEY_VERSION, good.credential.digest, newId("cf"), good.nonce, good.quote, good.quoteDigest]],
      ["read_checkout, authorized, found", "readCheckout", [SESSION_KEY_VERSION, good.credential.digest, good.intent]],
      ["read_checkout, authorized, no such intent", "readCheckout", [SESSION_KEY_VERSION, good.credential.digest, newId("ci")]],
      ["read_checkout, unauthorized", "readCheckout", [SESSION_KEY_VERSION, unknown, good.intent]],
    ];
    for (const level of ["beginRepeatableRead", "beginSerializable", "beginReadUncommitted"] as const) {
      for (const [situation, target, values] of situations) {
        const sqlstate = await underIsolation(db.admin, level, target, values);
        observed.push({ level, situation, sqlstate });
        expect(sqlstate, `${level}: ${situation}`).toBe(ISOLATION_REFUSED);
      }
    }
    console.info(`Increment 2.2 isolation refusals as observed: ${JSON.stringify(observed)}`);
    expect(await snapshotOf(db.admin)).toEqual(before);
    expect(await challengeOf(db.admin, good.challenge)).toMatchObject({ status: "ACTIVE" });
    // Under READ COMMITTED, inside a transaction that is then rolled back, a confirmation leaves nothing behind.
    await db.admin.query(SQL.begin);
    try {
      expect((await db.admin.query(SQL.consumeChallenge, [SESSION_KEY_VERSION, good.credential.digest, good.challenge, good.nonce, good.quote, good.quoteDigest])).rows).toEqual([{ result: "CONFIRMED", intent_id: good.intent }]);
    } finally {
      await db.admin.query(SQL.rollback);
    }
    expect(await snapshotOf(db.admin)).toEqual(before);
  });

  it("PGT-134: every outcome of the two functions changes exactly the tables 19.10 permits, from an owner without a request-window row and from one with a row", async () => {
    // Every scenario is built by direct writes, so that its owner has no request-window row until the call under
    // test, or until the test writes one. Each returns the owner, the call, and what the call must give and change.
    // `row`, where given, is the whole row the call must return; `verify`, where given, looks at the audit row of the
    // call and at the rows the call must have left as they were.
    type Scenario = {
      readonly owner: string;
      readonly act: () => Promise<Row>;
      readonly result: string;
      readonly changed: readonly string[];
      readonly counted: 0 | 1;
      readonly audits: readonly string[];
      readonly row?: Row;
      readonly verify?: (observed: Observed, label: string) => Promise<void>;
    };
    // CONFIRMATION_KEY_REVOKED needs a nonce key that has ended: the version that is ACTIVE now is retired and then
    // ended through the operator functions, before any scenario is built. Its challenges are written directly.
    const endedNonceKey = await retireNonceKey();
    await endNonceKey(endedNonceKey);
    const foreign = await stage(db.admin, activeNonceKey);
    const scenarios: Array<[string, () => Promise<Scenario>]> = [
      ["issue: NOT_AUTHORIZED (credential)", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        return { owner: staged.credential.owner, act: () => issue(db.web, { ...staged.credential, digest: hex(32) }, staged.intent, newId("cf"), activeNonceKey, hex(32)), result: "NOT_AUTHORIZED", changed: NOTHING, counted: 0, audits: [] };
      }],
      ["issue: NOT_AUTHORIZED (another owner's intent)", async () => {
        const credential = await newCredential(db.admin);
        return { owner: credential.owner, act: () => issue(db.web, credential, foreign.intent, newId("cf"), activeNonceKey, hex(32)), result: "NOT_AUTHORIZED", changed: NOTHING, counted: 0, audits: [] };
      }],
      ["issue: REQUEST_INVALID", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        return { owner: staged.credential.owner, act: () => issue(db.web, staged.credential, staged.intent, "not-a-challenge", activeNonceKey, hex(32)), result: "REQUEST_INVALID", changed: NOTHING, counted: 0, audits: [] };
      }],
      ["issue: INTENT_NOT_AWAITING_CONFIRMATION", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        await cancelFixtureDirectly(db.admin, staged.credential, staged.intent);
        return { owner: staged.credential.owner, act: () => issue(db.web, staged.credential, staged.intent, newId("cf"), activeNonceKey, hex(32)), result: "INTENT_NOT_AWAITING_CONFIRMATION", changed: COUNTER_ONLY, counted: 1, audits: [] };
      }],
      ["issue: QUOTE_EXPIRED", async () => {
        const credential = await newCredential(db.admin);
        const checkout = await fixtureCheckout(db.admin, credential, minutesAgo(20));
        return { owner: credential.owner, act: () => issue(db.web, credential, checkout.intent, newId("cf"), activeNonceKey, hex(32)), result: "QUOTE_EXPIRED", changed: COUNTER_ONLY, counted: 1, audits: [] };
      }],
      ["issue: QUOTE_DIGEST_MISMATCH", async () => {
        const credential = await newCredential(db.admin);
        const checkout = await fixtureCheckout(db.admin, credential, minutesAgo(1), hex(32));
        return { owner: credential.owner, act: () => issue(db.web, credential, checkout.intent, newId("cf"), activeNonceKey, hex(32)), result: "QUOTE_DIGEST_MISMATCH", changed: COUNTER_AND_AUDIT, counted: 1, audits: ["CONFIRMATION_REJECTED"] };
      }],
      ["issue: NONCE_KEY_NOT_ACTIVE", async () => {
        const credential = await newCredential(db.admin);
        const checkout = await fixtureCheckout(db.admin, credential);
        return { owner: credential.owner, act: () => issue(db.web, credential, checkout.intent, newId("cf"), 30000, hex(32)), result: "NONCE_KEY_NOT_ACTIVE", changed: COUNTER_ONLY, counted: 1, audits: [] };
      }],
      ["issue: REUSED", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        return { owner: staged.credential.owner, act: () => issue(db.web, staged.credential, staged.intent, newId("cf"), activeNonceKey, hex(32)), result: "REUSED", changed: COUNTER_ONLY, counted: 1, audits: [] };
      }],
      ["issue: REFUSED", async () => {
        const credential = await newCredential(db.admin);
        const checkout = await fixtureCheckout(db.admin, credential);
        return { owner: credential.owner, act: () => issue(db.web, credential, checkout.intent, foreign.challenge, activeNonceKey, hex(32)), result: "REFUSED", changed: COUNTER_ONLY, counted: 1, audits: [] };
      }],
      ["issue: ISSUED", async () => {
        const credential = await newCredential(db.admin);
        const checkout = await fixtureCheckout(db.admin, credential);
        return { owner: credential.owner, act: () => issue(db.web, credential, checkout.intent, newId("cf"), activeNonceKey, hex(32)), result: "ISSUED", changed: COUNTER_AND_CHALLENGE, counted: 1, audits: [] };
      }],
      ["issue: QUOTE_STALE_CATALOG", async () => {
        const credential = await newCredential(db.admin);
        const checkout = await fixtureCheckout(db.admin, credential);
        return {
          owner: credential.owner,
          // The price differs only while the call runs; the catalog is in no snapshot, and is put back before the next one.
          act: () => whileRepriced(() => issue(db.web, credential, checkout.intent, newId("cf"), activeNonceKey, hex(32))),
          result: "QUOTE_STALE_CATALOG",
          row: issueRefusal("QUOTE_STALE_CATALOG"),
          changed: COUNTER_ONLY,
          counted: 1,
          audits: [],
          verify: async (_observed, label) => {
            expect(await statusesOf(db.admin, checkout.quote), label).toEqual([]);
            expect(await intentOf(db.admin, checkout.intent), label).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
          },
        };
      }],
      ["issue: CONFIRMATION_ALREADY_USED", async () => {
        // A QUOTED intent whose quote already has a consumed challenge (written directly: the functions never leave this).
        const staged = await stage(db.admin, activeNonceKey);
        await db.admin.query(SQL.consumeChallengeDirectly, [staged.challenge]);
        return {
          owner: staged.credential.owner,
          act: () => issue(db.web, staged.credential, staged.intent, newId("cf"), activeNonceKey, hex(32)),
          result: "CONFIRMATION_ALREADY_USED",
          row: issueRefusal("CONFIRMATION_ALREADY_USED"),
          changed: COUNTER_ONLY,
          counted: 1,
          audits: [],
          verify: async (_observed, label) => {
            expect(await statusesOf(db.admin, staged.quote), label).toEqual([`${staged.challenge}:CONSUMED`]);
            expect(await intentOf(db.admin, staged.intent), label).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
          },
        };
      }],
      ["issue: CHALLENGE_LIMIT_REACHED", async () => {
        // Eight rows of one quote, as in PGT-211: seven ended, and one ACTIVE with too little time left to be reused.
        const credential = await newCredential(db.admin);
        const checkout = await fixtureCheckout(db.admin, credential);
        for (let ended = 0; ended < 7; ended += 1) {
          const earlier = await fixtureChallenge(db.admin, checkout.quote, activeNonceKey, "-290 seconds", "10 seconds");
          await db.admin.query(SQL.supersedeChallengeDirectly, [earlier.challenge]);
        }
        const eighth = await fixtureChallenge(db.admin, checkout.quote, activeNonceKey, "-270 seconds", "30 seconds");
        const listed = await statusesOf(db.admin, checkout.quote);
        expect(listed).toHaveLength(8);
        return {
          owner: credential.owner,
          act: () => issue(db.web, credential, checkout.intent, newId("cf"), activeNonceKey, hex(32)),
          result: "CHALLENGE_LIMIT_REACHED",
          row: issueRefusal("CHALLENGE_LIMIT_REACHED"),
          changed: COUNTER_ONLY,
          counted: 1,
          audits: [],
          verify: async (_observed, label) => {
            expect(await statusesOf(db.admin, checkout.quote), label).toEqual(listed);
            expect(await challengeOf(db.admin, eighth.challenge), label).toMatchObject({ status: "ACTIVE", consumed_at: null, superseded_at: null, expired_marked_at: null });
          },
        };
      }],
      ["consume: NOT_AUTHORIZED (credential)", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        return { owner: staged.credential.owner, act: () => consume(db.web, { ...staged.credential, digest: hex(32) }, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest), result: "NOT_AUTHORIZED", changed: NOTHING, counted: 0, audits: [] };
      }],
      ["consume: REQUEST_INVALID", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        return { owner: staged.credential.owner, act: () => consume(db.web, staged.credential, staged.challenge, "not-a-nonce", staged.quote, staged.quoteDigest), result: "REQUEST_INVALID", changed: NOTHING, counted: 0, audits: [] };
      }],
      ["consume: CONFIRMATION_NOT_FOUND", async () => {
        const credential = await newCredential(db.admin);
        return { owner: credential.owner, act: () => consume(db.web, credential, foreign.challenge, foreign.nonce, foreign.quote, foreign.quoteDigest), result: "CONFIRMATION_NOT_FOUND", changed: NOTHING, counted: 0, audits: [] };
      }],
      ["consume: CONFIRMATION_SUPERSEDED", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        await db.admin.query(SQL.supersedeChallengeDirectly, [staged.challenge]);
        return { owner: staged.credential.owner, act: () => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest), result: "CONFIRMATION_SUPERSEDED", changed: COUNTER_ONLY, counted: 1, audits: [] };
      }],
      ["consume: CONFIRMATION_ALREADY_USED", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        await db.admin.query(SQL.consumeChallengeDirectly, [staged.challenge]);
        return { owner: staged.credential.owner, act: () => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest), result: "CONFIRMATION_ALREADY_USED", changed: COUNTER_ONLY, counted: 1, audits: [] };
      }],
      ["consume: CONFIRMATION_MISMATCH", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        return { owner: staged.credential.owner, act: () => consume(db.web, staged.credential, staged.challenge, newNonce(), staged.quote, staged.quoteDigest), result: "CONFIRMATION_MISMATCH", changed: COUNTER_AND_AUDIT, counted: 1, audits: ["CONFIRMATION_REJECTED"] };
      }],
      ["consume: CONFIRMATION_EXPIRED", async () => {
        const staged = await stage(db.admin, activeNonceKey, { issued: "-400 seconds", expires: "-30 seconds" });
        return { owner: staged.credential.owner, act: () => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest), result: "CONFIRMATION_EXPIRED", changed: COUNTER_AND_CHALLENGE, counted: 1, audits: [] };
      }],
      ["consume: QUOTE_DIGEST_MISMATCH", async () => {
        const staged = await stage(db.admin, activeNonceKey, { storedDigest: hex(32) });
        return { owner: staged.credential.owner, act: () => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest), result: "QUOTE_DIGEST_MISMATCH", changed: COUNTER_AND_AUDIT, counted: 1, audits: ["CONFIRMATION_REJECTED"] };
      }],
      ["consume: QUOTE_EXPIRED", async () => {
        const staged = await stage(db.admin, activeNonceKey, { createdAt: minutesAgo(20), expires: "200 seconds" });
        return { owner: staged.credential.owner, act: () => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest), result: "QUOTE_EXPIRED", changed: COUNTER_ONLY, counted: 1, audits: [] };
      }],
      ["consume: INTENT_NOT_AWAITING_CONFIRMATION", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        await cancelFixtureDirectly(db.admin, staged.credential, staged.intent);
        return { owner: staged.credential.owner, act: () => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest), result: "INTENT_NOT_AWAITING_CONFIRMATION", changed: COUNTER_ONLY, counted: 1, audits: [] };
      }],
      ["consume: CONFIRMED", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        return { owner: staged.credential.owner, act: () => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest), result: "CONFIRMED", changed: CONFIRMATION, counted: 1, audits: ["CONFIRMATION_ACCEPTED"] };
      }],
      ["consume: CONFIRMATION_KEY_REVOKED", async () => {
        // An ACTIVE challenge under the ended nonce key, submitted with its own correct values.
        const staged = await stage(db.admin, endedNonceKey);
        return {
          owner: staged.credential.owner,
          act: () => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest),
          result: "CONFIRMATION_KEY_REVOKED",
          row: { result: "CONFIRMATION_KEY_REVOKED", intent_id: null },
          changed: COUNTER_AND_AUDIT,
          counted: 1,
          audits: ["CONFIRMATION_REJECTED"],
          verify: async (observed, label) => {
            expect(observed.audits, label).toHaveLength(1);
            expectRejection(observed.audits[0], staged.credential, staged.intent, "CONFIRMATION_KEY_REVOKED", staged.challenge, label);
            expect(await auditsOf(db.admin, staged.credential.owner), label).toHaveLength(1);
            expect(await challengeOf(db.admin, staged.challenge), label).toMatchObject({ status: "ACTIVE", nonce_key_version: endedNonceKey, consumed_at: null, superseded_at: null, expired_marked_at: null });
            expect(await intentOf(db.admin, staged.intent), label).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
          },
        };
      }],
      ["consume: QUOTE_STALE_CATALOG", async () => {
        const staged = await stage(db.admin, activeNonceKey);
        return {
          owner: staged.credential.owner,
          act: () => whileRepriced(() => consume(db.web, staged.credential, staged.challenge, staged.nonce, staged.quote, staged.quoteDigest)),
          result: "QUOTE_STALE_CATALOG",
          row: { result: "QUOTE_STALE_CATALOG", intent_id: null },
          changed: COUNTER_ONLY,
          counted: 1,
          audits: [],
          verify: async (_observed, label) => {
            expect(await challengeOf(db.admin, staged.challenge), label).toMatchObject({ status: "ACTIVE", consumed_at: null, superseded_at: null, expired_marked_at: null });
            expect(await intentOf(db.admin, staged.intent), label).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
          },
        };
      }],
    ];
    const recorded: Array<{ window: string; outcome: string; result: unknown; changed: string[]; audited: string[] }> = [];
    for (const window of ["absent", "present"] as const) {
      for (const [label, build] of scenarios) {
        const scenario = await build();
        if (window === "present") await db.admin.query(SQL.insertWindow, [scenario.owner, "-5 seconds", 3]);
        const others = await othersOf(db.admin, scenario.owner);
        const observed = await observe(db.admin, scenario.owner, scenario.act);
        recorded.push({ window, outcome: label, result: observed.row.result, changed: observed.changed, audited: observed.audits.map((row) => row.event_type) });
        expect(observed.row.result, `${window}: ${label}`).toBe(scenario.result);
        expect(observed.changed, `${window}: ${label}`).toEqual(scenario.changed);
        expect(observed.audits.map((row) => row.event_type), `${window}: ${label}`).toEqual(scenario.audits);
        expect({ counted: observed.counted, throttled: observed.throttled }, `${window}: ${label}`).toEqual({ counted: scenario.counted, throttled: 0 });
        // The request window: an absent row stays absent unless the call was admitted, and then holds one call; a
        // present row holds its three calls, and one more if the call was admitted.
        const expectedWindow = window === "absent" ? (scenario.counted === 1 ? { window_calls: 1, window_throttled: 0, total_throttled: 0 } : null) : { window_calls: 3 + scenario.counted, window_throttled: 0, total_throttled: 0 };
        expect(await windowOf(db.admin, scenario.owner), `${window}: ${label}`).toEqual(expectedWindow);
        // No request-window row and no audit row of anybody else is changed, added or removed by the call.
        expect(await othersOf(db.admin, scenario.owner), `${window}: ${label}`).toEqual(others);
        if (scenario.row !== undefined) expect(observed.row, `${window}: ${label}`).toEqual(scenario.row);
        if (scenario.verify !== undefined) await scenario.verify(observed, `${window}: ${label}`);
      }
    }

    // RATE_LIMITED. A call is throttled only when the owner's request-window row is already full, and an owner
    // without a row is always admitted: the row is then written holding that one call. So RATE_LIMITED has no
    // row-absent state for either function. That combination is recorded as not applicable, and is not made up.
    const notApplicable = [
      { window: "absent", outcome: "issue: RATE_LIMITED", reason: "an owner without a request-window row is admitted, never throttled" },
      { window: "absent", outcome: "consume: RATE_LIMITED", reason: "an owner without a request-window row is admitted, never throttled" },
    ];
    // Each owner is written directly, with an ACTIVE challenge of its own and a window that already holds the limit
    // of 30 calls. The first throttled call of the window changes the counters and writes one OWNER_RATE_LIMITED row;
    // every later one changes the counters only.
    const issueLimited = await stage(db.admin, activeNonceKey);
    const consumeLimited = await stage(db.admin, activeNonceKey);
    const limited: Array<[string, Staged, () => Promise<Row>, Row]> = [
      ["issue: RATE_LIMITED", issueLimited, () => issue(db.web, issueLimited.credential, issueLimited.intent, newId("cf"), activeNonceKey, hex(32)), issueRefusal("RATE_LIMITED")],
      ["consume: RATE_LIMITED", consumeLimited, () => consume(db.web, consumeLimited.credential, consumeLimited.challenge, consumeLimited.nonce, consumeLimited.quote, consumeLimited.quoteDigest), { result: "RATE_LIMITED", intent_id: null }],
    ];
    for (const [label, staged, throttledCall, refusal] of limited) {
      const limitedOwner = staged.credential.owner;
      await db.admin.query(SQL.insertWindow, [limitedOwner, "-5 seconds", 30]);
      const startedAt = String((await db.admin.query(SQL.windowStartedAt, [limitedOwner])).rows[0].started_at);
      const others = await othersOf(db.admin, limitedOwner);

      const first = await observe(db.admin, limitedOwner, throttledCall);
      recorded.push({ window: "present", outcome: `${label} (first)`, result: first.row.result, changed: first.changed, audited: first.audits.map((row) => row.event_type) });
      expect(first.row, `${label} (first)`).toEqual(refusal);
      expect(first.changed, `${label} (first)`).toEqual(COUNTER_AND_AUDIT);
      expect({ counted: first.counted, throttled: first.throttled }, `${label} (first)`).toEqual({ counted: 0, throttled: 1 });
      expect(await windowOf(db.admin, limitedOwner), `${label} (first)`).toEqual({ window_calls: 30, window_throttled: 1, total_throttled: 1 });
      expect(first.audits, `${label} (first)`).toHaveLength(1);
      expect(first.audits[0], `${label} (first)`).toMatchObject({ event_type: "OWNER_RATE_LIMITED", actor: "server", session_id: staged.credential.session, owner_id: limitedOwner, checkout_intent_id: null, operation_id: null, times_equal: true });
      expect(first.audits[0].event_id, `${label} (first)`).toMatch(/^ev_[0-9a-f]{32}$/);
      expect(sortedKeys(first.audits[0].detail), `${label} (first)`).toEqual(["limit", "windowSeconds", "windowStartedAt"]);
      expect(first.audits[0].detail, `${label} (first)`).toEqual({ limit: 30, windowSeconds: 60, windowStartedAt: startedAt });

      for (const occurrence of [2, 3]) {
        const later = await observe(db.admin, limitedOwner, throttledCall);
        recorded.push({ window: "present", outcome: `${label} (call ${occurrence})`, result: later.row.result, changed: later.changed, audited: later.audits.map((row) => row.event_type) });
        expect(later.row, `${label} (call ${occurrence})`).toEqual(refusal);
        expect(later.changed, `${label} (call ${occurrence})`).toEqual(COUNTER_ONLY);
        expect({ counted: later.counted, throttled: later.throttled }, `${label} (call ${occurrence})`).toEqual({ counted: 0, throttled: 1 });
        expect(later.audits, `${label} (call ${occurrence})`).toEqual([]);
        expect(await windowOf(db.admin, limitedOwner), `${label} (call ${occurrence})`).toEqual({ window_calls: 30, window_throttled: occurrence, total_throttled: occurrence });
      }
      // One audit row in all for the owner; the window still starts where it did; and nothing of the owner's
      // checkout, and no row of anybody else, was touched by the three calls.
      expect((await auditsOf(db.admin, limitedOwner)).map((row) => row.event_type), label).toEqual(["OWNER_RATE_LIMITED"]);
      expect(String((await db.admin.query(SQL.windowStartedAt, [limitedOwner])).rows[0].started_at), label).toBe(startedAt);
      expect(await statusesOf(db.admin, staged.quote), label).toEqual([`${staged.challenge}:ACTIVE`]);
      expect(await challengeOf(db.admin, staged.challenge), label).toMatchObject({ status: "ACTIVE", consumed_at: null, superseded_at: null, expired_marked_at: null });
      expect(await intentOf(db.admin, staged.intent), label).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null });
      expect(await othersOf(db.admin, limitedOwner), label).toEqual(others);
    }
    console.info(`Increment 2.2 PGT-134 not applicable: ${JSON.stringify(notApplicable)}`);
    console.info(`Increment 2.2 PGT-134 as observed: ${JSON.stringify(recorded)}`);
    // Sessions, quotes, items, groups and intents of other owners are named by no outcome but the confirmation.
    expect(recorded.flatMap((entry) => entry.changed).filter((table) => ["shopper_sessions", "quotes", "quote_items", "purchase_groups"].includes(table))).toEqual([]);
    expect(await challengeOf(db.admin, foreign.challenge)).toMatchObject({ status: "ACTIVE" });
  });

  it("PGT-229: no audit detail holds a nonce, a digest, a token digest or a rejected challenge id, for a flow made with fixed sentinel values", async () => {
    // Fixed values, so that the same values can be looked for in the retained output of a run. None is printed here.
    const credential = await newCredential(db.admin, SENTINEL_SESSION_DIGEST);
    const correct = NONCE_VECTORS[0];
    const wrong = NONCE_VECTORS[1];
    // A rejected issue: the stored digest of this quote is wrong, and the id the caller sends is the sentinel id.
    const tampered = await fixtureCheckout(db.admin, credential, minutesAgo(1), hex(32));
    expect((await issue(db.web, credential, tampered.intent, SENTINEL_REJECTED_CHALLENGE, activeNonceKey, wrong.digest)).result).toBe("QUOTE_DIGEST_MISMATCH");
    // A real checkout: issued with the digest of the correct sentinel nonce, refused once with the wrong one, confirmed.
    const started = await startCheckout(db.admin, db.web, credential);
    const challenge = newId("cf");
    expect((await issue(db.web, credential, started.intent, challenge, activeNonceKey, correct.digest)).result).toBe("ISSUED");
    expect((await consume(db.web, credential, challenge, wrong.nonce, started.quote, started.quoteDigest)).result).toBe("CONFIRMATION_MISMATCH");
    expect(await consume(db.web, credential, challenge, correct.nonce, started.quote, started.quoteDigest)).toEqual({ result: "CONFIRMED", intent_id: started.intent });
    const audits = await auditsOf(db.admin, credential.owner);
    expect(audits.map((row) => row.event_type)).toEqual(["CONFIRMATION_REJECTED", "QUOTE_ISSUED", "CONFIRMATION_REJECTED", "CONFIRMATION_ACCEPTED"]);

    // The sentinels, and the two digests of this flow, are in no audit detail of the whole database.
    const secrets: Array<[string, string]> = [
      ["the session token digest", SENTINEL_SESSION_DIGEST],
      ["the correct nonce", correct.nonce],
      ["the wrong nonce", wrong.nonce],
      ["the digest of the correct nonce", correct.digest],
      ["the digest of the wrong nonce", wrong.digest],
      ["the quote digest", started.quoteDigest],
      ["the stored digest of the tampered quote", tampered.quoteDigest],
      ["the challenge id of the rejected issue", SENTINEL_REJECTED_CHALLENGE],
    ];
    for (const [what, value] of secrets) expect((await db.admin.query(SQL.auditDetailsHolding, [value])).rows[0].n, what).toBe(0);
    // The check can find something: the id of the real challenge is in two details, as it should be.
    expect((await db.admin.query(SQL.auditDetailsHolding, [challenge])).rows[0].n).toBe(2);
    // And nothing that looks like a digest or a nonce is in any audit detail this file has caused.
    const alike = (await db.admin.query(SQL.auditDetailsLikeSecrets)).rows[0];
    expect(alike.all_rows).toBeGreaterThan(10);
    expect({ digests: alike.digests, nonces: alike.nonces }).toEqual({ digests: 0, nonces: 0 });
    // No key version is in a confirmation detail either: exactly the reviewed keys, and nothing else.
    for (const audit of audits.filter((row) => row.event_type !== "QUOTE_ISSUED")) {
      expect(sortedKeys(audit.detail), audit.event_type).toEqual(audit.event_type === "CONFIRMATION_ACCEPTED" ? ["challengeId", "quoteId", "transitionEventId"] : ["challengeId", "result"]);
    }
    expect(audits[0].detail).toEqual({ result: "QUOTE_DIGEST_MISMATCH", challengeId: null });
  });
});
