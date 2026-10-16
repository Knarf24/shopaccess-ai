import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { APPROVED_MIGRATIONS } from "@/lib/pg/migrate";
import { OPERATOR_STATEMENTS } from "@/lib/pg/statements";
import { adminUrl, hex, INSUFFICIENT_PRIVILEGE, openDisposableDatabase, sqlState, TEST_NONCE_KEY, type DisposableDatabase } from "./harness";

// NEVER RUN. Written for the Increment 2.1 schema migration (0007) alone; running it needs a separate authorization
// and a new disposable PostgreSQL 17 cluster (see ./harness).
//
// Scope: the schema-only part of the acceptance manifest (specification 19.15). Everything here is done by direct
// statements of the test owner, the table owner, the web role or the operator role. No Increment 2.1 function exists
// yet, so nothing here calls one, and nothing here is evidence for a function, for a grant of the functions
// migration, or for Increment 2.1 as a whole.
//
// Fixtures follow the bypass-writer policy P1 to P7: every row satisfies every constraint and trigger, each fixture
// is one transaction, fixtures are written serially, and no trigger or constraint is switched off or changed. A
// transaction that updates or deletes a row first locks the owner row and then the intent row (P6).
//
// Statements: every statement this file sends is a fixed string. It is either written out where it is sent or is an
// entry of the table SQL below; nothing is put together from parts when the tests run, and values travel only as
// bound parameters. The static test PGT-157 reads this file and depends on that.
//
// Refusals: a test asserts that a statement is refused, where it is refused (at the statement or at COMMIT) and what
// refused it: the name of the constraint, or a fragment of the message the migration's trigger raises. It never
// asserts a particular SQLSTATE; the observed one is collected and printed once at the end of the run.

const SEVEN_TABLES = [
  "checkout_intents",
  "checkout_transitions",
  "confirmation_challenges",
  "owner_request_windows",
  "purchase_groups",
  "quote_items",
  "quotes",
] as const;
type SchemaTable = (typeof SEVEN_TABLES)[number];
const isSchemaTable = (name: string): name is SchemaTable => (SEVEN_TABLES as readonly string[]).includes(name);

const TRIGGER_FUNCTIONS = ["checkout_history_check", "checkout_intents_guard", "confirmation_challenges_guard", "owner_request_windows_guard", "quote_item_check"];

const R_A = "checkout_intents_successor_reciprocal_fkey";
const R_B = "checkout_intents_predecessor_reciprocal_fkey";
const F_2 = "checkout_intents_successor_owner_fkey";
const F_4 = "checkout_intents_current_quote_fkey";
const INTENT_HISTORY = "checkout_intents_history_check";
const TRANSITION_HISTORY = "checkout_transitions_history_check";
const QUOTE_ITEM = "quotes_item_check";
const ITEM_QUOTE = "quote_items_quote_check";
type DeferredConstraint = typeof R_B | typeof F_4 | typeof INTENT_HISTORY | typeof TRANSITION_HISTORY | typeof QUOTE_ITEM | typeof ITEM_QUOTE;

// Fixed instants, so that every fixture is the same on every run.
const T_CREATED = "2026-01-01T00:00:00.000Z";
const T_ISSUED = "2026-01-01T00:01:00.000Z";
const T_CONSUMED = "2026-01-01T00:02:00.000Z";
const T_LATER = "2026-01-01T00:05:00.000Z";
const T_CHALLENGE_EXPIRES = "2026-01-01T00:11:00.000Z";

/**
 * Every statement the transactions of this file send, each a fixed string. A step of a transaction names an entry
 * here and carries its bound values; it never carries statement text.
 */
const SQL = {
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",
  setRoleOwner: "SET ROLE shopaccess_owner",
  resetRole: "RESET ROLE",

  // P6: the owner row first, then the intent row, as the functions will.
  lockOwner: "SELECT id FROM shopaccess.checkout_owners WHERE id = $1 FOR UPDATE",
  lockIntent: "SELECT id FROM shopaccess.checkout_intents WHERE id = $1 FOR UPDATE",

  insertOwner: "INSERT INTO shopaccess.checkout_owners (id, created_at) VALUES ($1, $2)",
  insertGroup: "INSERT INTO shopaccess.purchase_groups (id, owner_id, created_at) VALUES ($1, $2, $3)",
  // One, two or three intent rows in one statement. The three columns left out have no default and stay NULL.
  insertIntent:
    "INSERT INTO shopaccess.checkout_intents (id, owner_id, purchase_group_id, replaces_intent_id, superseded_by_intent_id, state, row_version, current_quote_id, created_at, updated_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)",
  insertIntents2:
    "INSERT INTO shopaccess.checkout_intents (id, owner_id, purchase_group_id, replaces_intent_id, superseded_by_intent_id, state, row_version, current_quote_id, created_at, updated_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9), ($10, $11, $12, $13, $14, $15, $16, $17, $18, $18)",
  insertIntents3:
    "INSERT INTO shopaccess.checkout_intents (id, owner_id, purchase_group_id, replaces_intent_id, superseded_by_intent_id, state, row_version, current_quote_id, created_at, updated_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9), ($10, $11, $12, $13, $14, $15, $16, $17, $18, $18), ($19, $20, $21, $22, $23, $24, $25, $26, $27, $27)",
  insertQuote:
    "INSERT INTO shopaccess.quotes (id, owner_id, checkout_intent_id, merchant_id, catalog_revision, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, currency, assumptions_code, created_at, expires_at, digest, digest_version) " +
    "VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, $6, 'USD', 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1', $7::timestamptz, $7::timestamptz + $8::interval, $9, 'SAQD-1')",
  insertItem:
    "INSERT INTO shopaccess.quote_items (quote_id, line_number, product_id, variant_id, quantity, unit_amount_cents, line_subtotal_cents, merchant_display_name, product_title, variant_label, descriptive_terms_digest) " +
    "VALUES ($1, $2, $3, $4, 1, $5, $5, $6, $7, $8, $9)",
  insertTransition:
    "INSERT INTO shopaccess.checkout_transitions (checkout_intent_id, to_version, from_version, event_id, event_type, actor, entry_point, from_state, to_state, occurred_at, recorded_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)",
  insertChallenge:
    "INSERT INTO shopaccess.confirmation_challenges (id, owner_id, checkout_intent_id, quote_id, quote_digest, nonce_digest, nonce_key_version, summary, status, issued_at, expires_at, consumed_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, 1, '{}'::jsonb, $7, $8, $9, $10)",
  insertWindow:
    "INSERT INTO shopaccess.owner_request_windows (owner_id, window_started_at, window_calls, window_throttled, total_throttled, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",

  // Updates of one intent. Each raises the row version by one, as every legal update does, unless its name says otherwise.
  setIntentState: "UPDATE shopaccess.checkout_intents SET state = $2, updated_at = $3, row_version = row_version + 1 WHERE id = $1",
  supersedeIntent:
    "UPDATE shopaccess.checkout_intents SET state = 'SUPERSEDED', superseded_by_intent_id = $2, updated_at = $3, row_version = row_version + 1 WHERE id = $1",
  confirmIntent:
    "UPDATE shopaccess.checkout_intents SET state = 'USER_CONFIRMED', confirmation_id = $2, confirmation_status = 'CONSUMED', updated_at = $3, row_version = row_version + 1 WHERE id = $1",
  confirmIntentWithoutId:
    "UPDATE shopaccess.checkout_intents SET state = 'USER_CONFIRMED', confirmation_id = NULL, confirmation_status = 'CONSUMED', updated_at = $2, row_version = row_version + 1 WHERE id = $1",
  confirmIntentWithoutStatus:
    "UPDATE shopaccess.checkout_intents SET state = 'USER_CONFIRMED', confirmation_id = $2, confirmation_status = NULL, updated_at = $3, row_version = row_version + 1 WHERE id = $1",
  setIntentPredecessor: "UPDATE shopaccess.checkout_intents SET replaces_intent_id = $2, updated_at = $3, row_version = row_version + 1 WHERE id = $1",
  setIntentSuccessorOnly: "UPDATE shopaccess.checkout_intents SET superseded_by_intent_id = $2, updated_at = $3, row_version = row_version + 1 WHERE id = $1",
  clearIntentSuccessor: "UPDATE shopaccess.checkout_intents SET superseded_by_intent_id = NULL, updated_at = $2, row_version = row_version + 1 WHERE id = $1",
  touchIntent: "UPDATE shopaccess.checkout_intents SET updated_at = $2, row_version = row_version + 1 WHERE id = $1",
  cancelIntentByTwoVersions: "UPDATE shopaccess.checkout_intents SET state = 'CANCELED_LOCAL', updated_at = $2, row_version = row_version + 2 WHERE id = $1",
  cancelIntentChangingConfirmation:
    "UPDATE shopaccess.checkout_intents SET state = 'CANCELED_LOCAL', confirmation_id = $2, updated_at = $3, row_version = row_version + 1 WHERE id = $1",
  cancelIntentClearingConfirmation:
    "UPDATE shopaccess.checkout_intents SET state = 'CANCELED_LOCAL', confirmation_id = NULL, confirmation_status = NULL, updated_at = $2, row_version = row_version + 1 WHERE id = $1",
  cancelIntentDroppingConfirmationId:
    "UPDATE shopaccess.checkout_intents SET state = 'CANCELED_LOCAL', confirmation_id = NULL, updated_at = $2, row_version = row_version + 1 WHERE id = $1",
  cancelIntentDroppingConfirmationStatus:
    "UPDATE shopaccess.checkout_intents SET state = 'CANCELED_LOCAL', confirmation_status = NULL, updated_at = $2, row_version = row_version + 1 WHERE id = $1",
  deleteIntent: "DELETE FROM shopaccess.checkout_intents WHERE id = $1",

  // Changes of one challenge. The first three are the one legal change, from ACTIVE to a terminal status with its timestamp.
  consumeChallenge: "UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = $2 WHERE id = $1",
  supersedeChallenge: "UPDATE shopaccess.confirmation_challenges SET status = 'SUPERSEDED', superseded_at = $2 WHERE id = $1",
  expireChallenge: "UPDATE shopaccess.confirmation_challenges SET status = 'EXPIRED', expired_marked_at = $2 WHERE id = $1",
  setChallengeStatus: "UPDATE shopaccess.confirmation_challenges SET status = $2 WHERE id = $1",
  consumeChallengeChangingQuoteDigest: "UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = $2, quote_digest = $3 WHERE id = $1",
  consumeChallengeChangingNonceDigest: "UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = $2, nonce_digest = $3 WHERE id = $1",
  consumeChallengeChangingExpiresAt: "UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = $2, expires_at = $3 WHERE id = $1",
  consumeChallengeChangingIssuedAt: "UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = $2, issued_at = $3 WHERE id = $1",
  consumeChallengeChangingSummary: "UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = $2, summary = $3::jsonb WHERE id = $1",
  consumeChallengeChangingOwner: "UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = $2, owner_id = $3 WHERE id = $1",
  deleteChallenge: "DELETE FROM shopaccess.confirmation_challenges WHERE id = $1",

  // Changes of one request window.
  updateWindowCounters: "UPDATE shopaccess.owner_request_windows SET window_calls = 30, window_throttled = 2, total_throttled = 5, updated_at = $2 WHERE owner_id = $1",
  setWindowCallsBeyondLimit: "UPDATE shopaccess.owner_request_windows SET window_calls = 31 WHERE owner_id = $1",
  changeWindowOwner: "UPDATE shopaccess.owner_request_windows SET owner_id = $2 WHERE owner_id = $1",
  deleteWindow: "DELETE FROM shopaccess.owner_request_windows WHERE owner_id = $1",

  // Changes of insert-only rows, attempted as the table owner.
  touchGroup: "UPDATE shopaccess.purchase_groups SET created_at = created_at WHERE id = $1",
  deleteItems: "DELETE FROM shopaccess.quote_items WHERE quote_id = $1",
  touchTransitions: "UPDATE shopaccess.checkout_transitions SET actor = actor WHERE checkout_intent_id = $1",

  // One deferred constraint set to immediate, by its contract name.
  "immediate checkout_intents_predecessor_reciprocal_fkey": "SET CONSTRAINTS shopaccess.checkout_intents_predecessor_reciprocal_fkey IMMEDIATE",
  "immediate checkout_intents_current_quote_fkey": "SET CONSTRAINTS shopaccess.checkout_intents_current_quote_fkey IMMEDIATE",
  "immediate checkout_intents_history_check": "SET CONSTRAINTS shopaccess.checkout_intents_history_check IMMEDIATE",
  "immediate checkout_transitions_history_check": "SET CONSTRAINTS shopaccess.checkout_transitions_history_check IMMEDIATE",
  "immediate quotes_item_check": "SET CONSTRAINTS shopaccess.quotes_item_check IMMEDIATE",
  "immediate quote_items_quote_check": "SET CONSTRAINTS shopaccess.quote_items_quote_check IMMEDIATE",

  // A synthetic audit row in the shape of the PGT-142 fixture table: its id either generated in the database, in the
  // form the audit functions use, or given.
  insertAuditGenerated:
    "INSERT INTO shopaccess.audit_events (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail) " +
    "VALUES ('ev_' || replace(gen_random_uuid()::text, '-', ''), 'CONFIRMATION_ACCEPTED', $1, $1, 'shopper', NULL, $2, $3, NULL, " +
    "jsonb_build_object('transitionEventId', $4::text, 'challengeId', $5::text, 'quoteId', $6::text)) RETURNING event_id",
  insertAuditWithId:
    "INSERT INTO shopaccess.audit_events (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail) " +
    "VALUES ($7, 'CONFIRMATION_ACCEPTED', $1, $1, 'shopper', NULL, $2, $3, NULL, " +
    "jsonb_build_object('transitionEventId', $4::text, 'challengeId', $5::text, 'quoteId', $6::text))",

  // Per table: the five direct statements of the privilege test, TRUNCATE with CASCADE, and the content snapshot.
  "select checkout_intents": "SELECT count(*) FROM shopaccess.checkout_intents",
  "insert checkout_intents": "INSERT INTO shopaccess.checkout_intents DEFAULT VALUES",
  "update checkout_intents": "UPDATE shopaccess.checkout_intents SET updated_at = updated_at",
  "delete checkout_intents": "DELETE FROM shopaccess.checkout_intents",
  "truncate checkout_intents": "TRUNCATE shopaccess.checkout_intents",
  "truncate cascade checkout_intents": "TRUNCATE shopaccess.checkout_intents CASCADE",
  "snapshot checkout_intents": "SELECT count(*)::integer AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM shopaccess.checkout_intents t",

  "select checkout_transitions": "SELECT count(*) FROM shopaccess.checkout_transitions",
  "insert checkout_transitions": "INSERT INTO shopaccess.checkout_transitions DEFAULT VALUES",
  "update checkout_transitions": "UPDATE shopaccess.checkout_transitions SET actor = actor",
  "delete checkout_transitions": "DELETE FROM shopaccess.checkout_transitions",
  "truncate checkout_transitions": "TRUNCATE shopaccess.checkout_transitions",
  "truncate cascade checkout_transitions": "TRUNCATE shopaccess.checkout_transitions CASCADE",
  "snapshot checkout_transitions": "SELECT count(*)::integer AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM shopaccess.checkout_transitions t",

  "select confirmation_challenges": "SELECT count(*) FROM shopaccess.confirmation_challenges",
  "insert confirmation_challenges": "INSERT INTO shopaccess.confirmation_challenges DEFAULT VALUES",
  "update confirmation_challenges": "UPDATE shopaccess.confirmation_challenges SET status = status",
  "delete confirmation_challenges": "DELETE FROM shopaccess.confirmation_challenges",
  "truncate confirmation_challenges": "TRUNCATE shopaccess.confirmation_challenges",
  "truncate cascade confirmation_challenges": "TRUNCATE shopaccess.confirmation_challenges CASCADE",
  "snapshot confirmation_challenges": "SELECT count(*)::integer AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM shopaccess.confirmation_challenges t",

  "select owner_request_windows": "SELECT count(*) FROM shopaccess.owner_request_windows",
  "insert owner_request_windows": "INSERT INTO shopaccess.owner_request_windows DEFAULT VALUES",
  "update owner_request_windows": "UPDATE shopaccess.owner_request_windows SET window_calls = window_calls",
  "delete owner_request_windows": "DELETE FROM shopaccess.owner_request_windows",
  "truncate owner_request_windows": "TRUNCATE shopaccess.owner_request_windows",
  "truncate cascade owner_request_windows": "TRUNCATE shopaccess.owner_request_windows CASCADE",
  "snapshot owner_request_windows": "SELECT count(*)::integer AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM shopaccess.owner_request_windows t",

  "select purchase_groups": "SELECT count(*) FROM shopaccess.purchase_groups",
  "insert purchase_groups": "INSERT INTO shopaccess.purchase_groups DEFAULT VALUES",
  "update purchase_groups": "UPDATE shopaccess.purchase_groups SET created_at = created_at",
  "delete purchase_groups": "DELETE FROM shopaccess.purchase_groups",
  "truncate purchase_groups": "TRUNCATE shopaccess.purchase_groups",
  "truncate cascade purchase_groups": "TRUNCATE shopaccess.purchase_groups CASCADE",
  "snapshot purchase_groups": "SELECT count(*)::integer AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM shopaccess.purchase_groups t",

  "select quote_items": "SELECT count(*) FROM shopaccess.quote_items",
  "insert quote_items": "INSERT INTO shopaccess.quote_items DEFAULT VALUES",
  "update quote_items": "UPDATE shopaccess.quote_items SET quantity = quantity",
  "delete quote_items": "DELETE FROM shopaccess.quote_items",
  "truncate quote_items": "TRUNCATE shopaccess.quote_items",
  "truncate cascade quote_items": "TRUNCATE shopaccess.quote_items CASCADE",
  "snapshot quote_items": "SELECT count(*)::integer AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM shopaccess.quote_items t",

  "select quotes": "SELECT count(*) FROM shopaccess.quotes",
  "insert quotes": "INSERT INTO shopaccess.quotes DEFAULT VALUES",
  "update quotes": "UPDATE shopaccess.quotes SET digest = digest",
  "delete quotes": "DELETE FROM shopaccess.quotes",
  "truncate quotes": "TRUNCATE shopaccess.quotes",
  "truncate cascade quotes": "TRUNCATE shopaccess.quotes CASCADE",
  "snapshot quotes": "SELECT count(*)::integer AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM shopaccess.quotes t",

  // TRUNCATE of several tables at once (PGT-158).
  "truncate all seven":
    "TRUNCATE shopaccess.checkout_intents, shopaccess.checkout_transitions, shopaccess.confirmation_challenges, shopaccess.owner_request_windows, shopaccess.purchase_groups, shopaccess.quote_items, shopaccess.quotes",
  "truncate all seven cascade":
    "TRUNCATE shopaccess.checkout_intents, shopaccess.checkout_transitions, shopaccess.confirmation_challenges, shopaccess.owner_request_windows, shopaccess.purchase_groups, shopaccess.quote_items, shopaccess.quotes CASCADE",
  "truncate items and quotes": "TRUNCATE shopaccess.quote_items, shopaccess.quotes",
  "truncate transitions and intents": "TRUNCATE shopaccess.checkout_transitions, shopaccess.checkout_intents",
  "truncate challenges, items and quotes": "TRUNCATE shopaccess.confirmation_challenges, shopaccess.quote_items, shopaccess.quotes",
  "truncate all but groups and windows":
    "TRUNCATE shopaccess.confirmation_challenges, shopaccess.checkout_transitions, shopaccess.quote_items, shopaccess.quotes, shopaccess.checkout_intents",
  "truncate all but windows":
    "TRUNCATE shopaccess.confirmation_challenges, shopaccess.checkout_transitions, shopaccess.quote_items, shopaccess.quotes, shopaccess.checkout_intents, shopaccess.purchase_groups",
  "truncate windows and groups": "TRUNCATE shopaccess.owner_request_windows, shopaccess.purchase_groups",
} as const;
type SqlKey = keyof typeof SQL;

type Admin = DisposableDatabase["admin"];
/** One statement of a transaction: an entry of SQL and its bound values. */
type Step = readonly [statement: SqlKey, values?: readonly unknown[]];

/** The 22 TRUNCATE statements of PGT-158, each with the tables it names. */
const TRUNCATE_ATTEMPTS: ReadonlyArray<{ readonly statement: SqlKey; readonly tables: readonly SchemaTable[] }> = [
  ...SEVEN_TABLES.flatMap((table) => [
    { statement: `truncate ${table}` as const, tables: [table] },
    { statement: `truncate cascade ${table}` as const, tables: [table] },
  ]),
  { statement: "truncate all seven", tables: SEVEN_TABLES },
  { statement: "truncate all seven cascade", tables: SEVEN_TABLES },
  { statement: "truncate items and quotes", tables: ["quote_items", "quotes"] },
  { statement: "truncate transitions and intents", tables: ["checkout_transitions", "checkout_intents"] },
  { statement: "truncate challenges, items and quotes", tables: ["confirmation_challenges", "quote_items", "quotes"] },
  { statement: "truncate all but groups and windows", tables: ["confirmation_challenges", "checkout_transitions", "quote_items", "quotes", "checkout_intents"] },
  { statement: "truncate all but windows", tables: ["confirmation_challenges", "checkout_transitions", "quote_items", "quotes", "checkout_intents", "purchase_groups"] },
  { statement: "truncate windows and groups", tables: ["owner_request_windows", "purchase_groups"] },
];

interface Refusal {
  readonly code: string | null;
  readonly constraint: string | null;
  readonly message: string;
  readonly detail: string | null;
  /** The context PostgreSQL reports: for an error raised in a trigger function, the function that raised it. */
  readonly where: string | null;
}

/** Where a transaction was refused: the index of the statement, or COMMIT, or nowhere. */
interface Outcome {
  readonly at: number | "COMMIT" | null;
  readonly refusal: Refusal | null;
}

function refusalFrom(error: unknown): Refusal {
  const fields = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; constraint?: unknown; message?: unknown; detail?: unknown; where?: unknown };
  return {
    code: typeof fields.code === "string" ? fields.code : null,
    constraint: typeof fields.constraint === "string" ? fields.constraint : null,
    message: typeof fields.message === "string" ? fields.message : String(error),
    detail: typeof fields.detail === "string" ? fields.detail : null,
    where: typeof fields.where === "string" ? fields.where : null,
  };
}

const LOCK_STATEMENTS: ReadonlySet<SqlKey> = new Set<SqlKey>(["lockOwner", "lockIntent"]);

/**
 * Runs the statements in one transaction on one connection and reports where it was refused. A statement that fails
 * ends the attempt with a ROLLBACK, so the connection is usable for the next attempt. A COMMIT that fails has already
 * undone the transaction; the ROLLBACK after it only makes sure the connection is outside a transaction. A
 * transaction that is not refused is committed: nothing a statement did is hidden by undoing it. A lock statement
 * that finds no row to lock is an error in the fixture, not a refusal, and is thrown.
 */
async function transact(client: Admin, steps: readonly Step[]): Promise<Outcome> {
  await client.query(SQL.begin);
  for (const [index, [statement, values]] of steps.entries()) {
    let rows: number | null;
    try {
      rows = (await client.query(SQL[statement], values === undefined ? undefined : [...values])).rowCount;
    } catch (error) {
      await client.query(SQL.rollback);
      return { at: index, refusal: refusalFrom(error) };
    }
    if (LOCK_STATEMENTS.has(statement) && rows !== 1) {
      await client.query(SQL.rollback);
      throw new Error(`fixture error: ${statement} locked ${String(rows)} rows instead of one`);
    }
  }
  try {
    await client.query(SQL.commit);
  } catch (error) {
    await client.query(SQL.rollback);
    return { at: "COMMIT", refusal: refusalFrom(error) };
  }
  return { at: null, refusal: null };
}

type TruncateMechanism = "reject-change trigger" | "foreign-key rule";

/**
 * Which of the two protections of the seven tables refused a TRUNCATE, or null when the error is neither. Anything
 * else, whatever it is (a timeout, a cancellation, a lock that could not be taken, a missing privilege, a malformed
 * statement), is not a refusal by the schema and must not count as one.
 *
 *  - The table's own trigger: the message the migration's `reject_change()` raises for TRUNCATE on one of the seven
 *    tables, reported from inside that function.
 *  - PostgreSQL's rule for a table that a foreign key references: its message, with the detail naming a referencing
 *    table that the statement does not truncate and a referenced table that it does, both among the seven.
 *
 * Which of the two answers for a given statement is not fixed here: the manifest records it and does not assume it.
 */
function truncateMechanism(refusal: Refusal | null, named: readonly SchemaTable[]): TruncateMechanism | null {
  if (refusal === null) return null;
  const rejected = /^TRUNCATE is not permitted on ([a-z_]+)$/.exec(refusal.message);
  if (rejected !== null) {
    return isSchemaTable(rejected[1]) && (refusal.where ?? "").includes("reject_change()") ? "reject-change trigger" : null;
  }
  if (refusal.message === "cannot truncate a table referenced in a foreign key constraint") {
    const pair = /^Table "([a-z_]+)" references "([a-z_]+)"\.$/.exec(refusal.detail ?? "");
    if (pair === null) return null;
    const referencing = pair[1];
    const referenced = pair[2];
    return isSchemaTable(referencing) && isSchemaTable(referenced) && named.includes(referenced) && !named.includes(referencing) ? "foreign-key rule" : null;
  }
  return null;
}

interface CatalogLine {
  readonly merchant_id: string;
  readonly product_id: string;
  readonly variant_id: string;
  readonly unit_amount_cents: number;
  readonly catalog_revision: number;
  readonly display_name: string;
  readonly title: string;
  readonly label: string;
}

/** The identifiers of one checkout: its owner, group, intent and quote, and the quote's digest. */
interface Ids {
  readonly owner: string;
  readonly group: string;
  readonly intent: string;
  readonly quote: string;
  readonly digest: string;
}

const newId = (prefix: "own" | "pur" | "ci" | "qt" | "cf" | "evt"): string => `${prefix}_${hex(16)}`;
const freshIds = (owner: string, group: string = newId("pur")): Ids => ({ owner, group, intent: newId("ci"), quote: newId("qt"), digest: hex(32) });

const ownerStep = (owner: string): Step => ["insertOwner", [owner, T_CREATED]];
const groupStep = (ids: Pick<Ids, "group" | "owner">): Step => ["insertGroup", [ids.group, ids.owner, T_CREATED]];

/** P6: the owner row, then the intent row. Both are held to the end of the transaction they are part of. */
const lockOwnerStep = (owner: string): Step => ["lockOwner", [owner]];
const lockIntentStep = (intent: string): Step => ["lockIntent", [intent]];
/** The statements, preceded in the same transaction by the two locks of P6 for that checkout. */
const withLocks = (ids: Pick<Ids, "owner" | "intent">, steps: readonly Step[]): Step[] => [lockOwnerStep(ids.owner), lockIntentStep(ids.intent), ...steps];
/** How many statements `withLocks` puts in front: the index of the first statement after the locks. */
const AFTER_LOCKS = 2;

interface IntentRow {
  readonly id: string;
  readonly owner: string;
  readonly group: string;
  readonly replaces: string | null;
  readonly supersededBy: string | null;
  readonly state: string;
  readonly rowVersion: number;
  readonly quote: string;
}

/** One INSERT of one, two or three intent rows. */
function intentsStep(rows: readonly IntentRow[]): Step {
  const values = rows.flatMap((row) => [row.id, row.owner, row.group, row.replaces, row.supersededBy, row.state, row.rowVersion, row.quote, T_CREATED]);
  if (rows.length === 1) return ["insertIntent", values];
  if (rows.length === 2) return ["insertIntents2", values];
  if (rows.length === 3) return ["insertIntents3", values];
  throw new Error(`fixture error: no statement inserts ${rows.length} intent rows`);
}

const intentStep = (ids: Ids, overrides: Partial<IntentRow> = {}): Step =>
  intentsStep([{ id: ids.intent, owner: ids.owner, group: ids.group, replaces: null, supersededBy: null, state: "QUOTED", rowVersion: 2, quote: ids.quote, ...overrides }]);

const stateStep = (intent: string, state: string): Step => ["setIntentState", [intent, state, T_LATER]];
const supersedeStep = (predecessor: string, successor: string): Step => ["supersedeIntent", [predecessor, successor, T_LATER]];
const confirmStep = (intent: string, challenge: string): Step => ["confirmIntent", [intent, challenge, T_LATER]];
const predecessorStep = (intent: string, predecessor: string): Step => ["setIntentPredecessor", [intent, predecessor, T_LATER]];

function quoteStep(ids: Ids, line: CatalogLine, options: { quote?: string; owner?: string; subtotal?: number; lifetime?: string; digest?: string } = {}): Step {
  return [
    "insertQuote",
    [
      options.quote ?? ids.quote,
      options.owner ?? ids.owner,
      ids.intent,
      line.merchant_id,
      line.catalog_revision,
      options.subtotal ?? line.unit_amount_cents,
      T_CREATED,
      options.lifetime ?? "15 minutes",
      options.digest ?? ids.digest,
    ],
  ];
}

/** The quoted line: quantity 1 at the catalog price, so its subtotal is the catalog price. */
const itemStep = (ids: Ids, line: CatalogLine, options: { lineNumber?: number } = {}): Step => [
  "insertItem",
  [ids.quote, options.lineNumber ?? 1, line.product_id, line.variant_id, line.unit_amount_cents, line.display_name, line.title, line.label, hex(32)],
];

interface TransitionRow {
  readonly intent: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly eventId: string;
  readonly event: string;
  readonly actor: string;
  readonly entry: string;
  readonly from: string;
  readonly to: string;
  /** When the transition occurred and was recorded. T_LATER unless a fixture has to time it otherwise. */
  readonly at?: string;
}

const rawTransitionStep = (row: TransitionRow): Step => [
  "insertTransition",
  [row.intent, row.toVersion, row.fromVersion, row.eventId, row.event, row.actor, row.entry, row.from, row.to, row.at ?? T_LATER],
];

/** The six legal combinations of specification 19.2, without their versions. */
const LEGAL = {
  T1: { event: "QUOTE_ISSUED", actor: "server", entry: "start_checkout", from: "DRAFT", to: "QUOTED" },
  T2: { event: "SHOPPER_CONFIRMED", actor: "shopper", entry: "consume_challenge", from: "QUOTED", to: "USER_CONFIRMED" },
  T3: { event: "SHOPPER_CANCELED", actor: "shopper", entry: "cancel_checkout", from: "QUOTED", to: "CANCELED_LOCAL" },
  T4: { event: "SHOPPER_CANCELED", actor: "shopper", entry: "cancel_checkout", from: "USER_CONFIRMED", to: "CANCELED_LOCAL" },
  T5: { event: "SUPERSEDED", actor: "server", entry: "start_checkout", from: "QUOTED", to: "SUPERSEDED" },
  T6: { event: "SUPERSEDED", actor: "server", entry: "start_checkout", from: "USER_CONFIRMED", to: "SUPERSEDED" },
} as const;
type LegalKind = keyof typeof LEGAL;

/** A legal transition from the given version to the next one. */
const transitionStep = (intent: string, kind: LegalKind, fromVersion: number, overrides: Partial<TransitionRow> = {}): Step =>
  rawTransitionStep({ intent, fromVersion, toVersion: fromVersion + 1, eventId: newId("evt"), ...LEGAL[kind], ...overrides });
const t1Step = (intent: string, eventId: string = newId("evt")): Step => transitionStep(intent, "T1", 1, { eventId });

const challengeStep = (challenge: string, ids: Ids, options: { owner?: string; status?: string; consumedAt?: string | null; expiresAt?: string } = {}): Step => [
  "insertChallenge",
  [
    challenge,
    options.owner ?? ids.owner,
    ids.intent,
    ids.quote,
    ids.digest,
    hex(32),
    options.status ?? "ACTIVE",
    T_ISSUED,
    options.expiresAt ?? T_CHALLENGE_EXPIRES,
    options.consumedAt ?? null,
  ],
];

type TerminalStatus = "CONSUMED" | "SUPERSEDED" | "EXPIRED";
/** The one change a challenge may make: from ACTIVE to a terminal status, with that status's timestamp. */
const challengeStatusStep = (challenge: string, status: TerminalStatus): Step => [
  status === "CONSUMED" ? "consumeChallenge" : status === "SUPERSEDED" ? "supersedeChallenge" : "expireChallenge",
  [challenge, T_CONSUMED],
];

const windowStep = (owner: string, counters: { calls: number; throttled: number; total: number; updatedAt?: string }): Step => [
  "insertWindow",
  [owner, T_ISSUED, counters.calls, counters.throttled, counters.total, counters.updatedAt ?? T_ISSUED],
];

/**
 * An error class that means the test itself is wrong (a misspelled statement, a bad value, a broken transaction),
 * not that the database refused the write. Such an error must never count as a refusal.
 */
const MALFORMED_TEST = /^(?:42|22|25)/;

/** What identifies a refusal as the intended one: the constraint named, a fragment of the trigger's message, or both. */
interface RefusedBy {
  /** One name, one of several names, or a pattern. */
  readonly constraint?: string | readonly string[] | RegExp;
  readonly message?: string;
}

describe.skipIf(!adminUrl())("Increment 2.1 checkout schema (migration 0007) on a disposable PostgreSQL 17 database: schema-only acceptance", () => {
  let db: DisposableDatabase;
  let line: CatalogLine;
  let ownerA: string;
  let ownerB: string;
  /** What each refusal looked like, for the record of the run. Never asserted against. */
  const evidence: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    db = await openDisposableDatabase();
    const catalog = await db.admin.query(
      `SELECT p.merchant_id, v.product_id, v.id AS variant_id, v.unit_amount_cents, v.catalog_revision, m.display_name, p.title, v.label
         FROM shopaccess.merchant_variants v
         JOIN shopaccess.merchant_products p ON p.id = v.product_id
         JOIN shopaccess.merchants m ON m.id = p.merchant_id
        ORDER BY v.id
        LIMIT 1`,
    );
    expect(catalog.rows).toHaveLength(1);
    line = catalog.rows[0] as CatalogLine;
    // Challenges name a nonce key version. It is made ACTIVE through the accepted operator function.
    const activated = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["confirmation_nonce", 1, computeKeyCheckValue(TEST_NONCE_KEY, "confirmation_nonce")]);
    expect(activated.rows[0].result).toBe("ACTIVATED");
    ownerA = await newOwner();
    ownerB = await newOwner();
  });

  afterAll(async () => {
    if (evidence.length > 0) console.info(`Increment 2.1 schema refusals as observed (not asserted): ${JSON.stringify(evidence)}`);
    await db?.destroy();
  });

  // ---- Helpers bound to this database ----

  /** A fixture or a positive control: the transaction must commit. */
  const must = async (what: string, steps: readonly Step[]): Promise<void> => {
    expect(await transact(db.admin, steps), what).toEqual({ at: null, refusal: null });
  };
  /** One statement, in a transaction of its own. */
  const one = (step: Step): Promise<Outcome> => transact(db.admin, [step]);
  /** A change to an existing row of a checkout, attempted under the two locks of P6. A refusal of the change is at AFTER_LOCKS. */
  const change = (ids: Pick<Ids, "owner" | "intent">, step: Step): Promise<Outcome> => transact(db.admin, withLocks(ids, [step]));

  /** Asserts a refusal, where it happened, and what identifies it as the intended one. */
  const expectRefused = (pgt: string, what: string, outcome: Outcome, at: number | "COMMIT", by: RefusedBy): void => {
    const label = `${pgt}: ${what}`;
    evidence.push({ pgt, what, at: outcome.at, sqlstate: outcome.refusal?.code ?? null, constraint: outcome.refusal?.constraint ?? null });
    // A refusal that nothing identifies could be any error at all.
    expect(by.constraint !== undefined || by.message !== undefined, label).toBe(true);
    expect(outcome.refusal, label).not.toBeNull();
    expect(outcome.at, label).toBe(at);
    expect(MALFORMED_TEST.test(outcome.refusal?.code ?? ""), `${label}: ${outcome.refusal?.message}`).toBe(false);
    if (typeof by.constraint === "string") expect(outcome.refusal?.constraint, label).toBe(by.constraint);
    else if (by.constraint instanceof RegExp) expect(outcome.refusal?.constraint ?? "", label).toMatch(by.constraint);
    else if (by.constraint !== undefined) expect(by.constraint, label).toContain(outcome.refusal?.constraint);
    if (by.message !== undefined) expect(outcome.refusal?.message ?? "", label).toContain(by.message);
  };

  /** Asserts that one TRUNCATE was refused, at the statement, by one of the two protections of the seven tables. */
  const expectTruncateRefused = (pgt: string, statement: SqlKey, tables: readonly SchemaTable[], outcome: Outcome): void => {
    const mechanism = truncateMechanism(outcome.refusal, tables);
    evidence.push({ pgt, statement, at: outcome.at, sqlstate: outcome.refusal?.code ?? null, mechanism, message: outcome.refusal?.message ?? null });
    expect(outcome.at, `${pgt}: ${statement}`).toBe(0);
    expect(mechanism, `${pgt}: ${statement}: ${outcome.refusal?.message}`).not.toBeNull();
  };

  async function newOwner(): Promise<string> {
    const owner = newId("own");
    await must("owner fixture", [ownerStep(owner)]);
    return owner;
  }

  /** The five statements of one complete, valid new checkout. Nothing existing is changed, so nothing is locked. */
  const rootSteps = (ids: Ids): Step[] => [groupStep(ids), intentStep(ids), quoteStep(ids, line), itemStep(ids, line), t1Step(ids.intent)];

  const createRoot = async (owner: string): Promise<Ids> => {
    const ids = freshIds(owner);
    await must("root checkout fixture", rootSteps(ids));
    return ids;
  };

  /**
   * A valid replacement, in the write order of specification 19.3. The predecessor is an existing row that this
   * transaction changes, so the owner row and the predecessor are locked first (P6). Then the successor and its rows,
   * then the predecessor marked SUPERSEDED with its pointer, then the predecessor's transition.
   */
  const successorSteps = (ids: Ids, predecessor: Ids, kind: "T5" | "T6" = "T5", predecessorVersion = 2): Step[] =>
    withLocks(predecessor, [
      intentStep(ids, { replaces: predecessor.intent }),
      quoteStep(ids, line),
      itemStep(ids, line),
      t1Step(ids.intent),
      supersedeStep(predecessor.intent, ids.intent),
      transitionStep(predecessor.intent, kind, predecessorVersion),
    ]);

  const createSuccessor = async (predecessor: Ids, kind: "T5" | "T6" = "T5", predecessorVersion = 2): Promise<Ids> => {
    const ids = freshIds(predecessor.owner, predecessor.group);
    await must("replacement fixture", successorSteps(ids, predecessor, kind, predecessorVersion));
    return ids;
  };

  /**
   * A consumed challenge for the checkout, and the checkout moved to USER_CONFIRMED at version 3 (the PGT-142 fixture
   * shape), under the locks of P6. Returns the challenge and the event id of the confirming transition. The challenge
   * is consumed at T_CONSUMED. `transitionAt` times the confirming transition; a fixture that also writes the
   * synthetic audit row of PGT-142 passes T_CONSUMED, so that the transition is timed at the consumption time.
   * With `withAuditRow`, that synthetic CONFIRMATION_ACCEPTED row is the last statement of the same transaction, on
   * the same connection: the challenge, its consumption, the intent's change, the transition and the audit row are
   * committed together or not at all. Its identifier is generated in the database; the caller reads it back.
   */
  const confirm = async (ids: Ids, transitionAt?: string, withAuditRow = false): Promise<{ challenge: string; eventId: string }> => {
    const challenge = newId("cf");
    const eventId = newId("evt");
    const steps: Step[] = [
      challengeStep(challenge, ids),
      challengeStatusStep(challenge, "CONSUMED"),
      confirmStep(ids.intent, challenge),
      transitionStep(ids.intent, "T2", 2, { eventId, at: transitionAt }),
    ];
    if (withAuditRow) steps.push(["insertAuditGenerated", [T_CONSUMED, ids.owner, ids.intent, eventId, challenge, ids.quote]]);
    await must("confirmed checkout fixture", withLocks(ids, steps));
    return { challenge, eventId };
  };

  const cancel = async (ids: Ids, kind: "T3" | "T4" = "T3", fromVersion = 2): Promise<void> => {
    await must("canceled checkout fixture", withLocks(ids, [stateStep(ids.intent, "CANCELED_LOCAL"), transitionStep(ids.intent, kind, fromVersion)]));
  };

  /** A new challenge for the checkout, left ACTIVE or moved to a terminal status in the same transaction, under the locks of P6. */
  const createChallenge = async (ids: Ids, status: "ACTIVE" | TerminalStatus = "ACTIVE"): Promise<string> => {
    const challenge = newId("cf");
    const steps = status === "ACTIVE" ? [challengeStep(challenge, ids)] : [challengeStep(challenge, ids), challengeStatusStep(challenge, status)];
    await must(`${status} challenge fixture`, withLocks(ids, steps));
    return challenge;
  };

  const intentRow = async (intent: string): Promise<Record<string, unknown>> => {
    const { rows } = await db.admin.query(
      "SELECT state, row_version, replaces_intent_id, superseded_by_intent_id, current_quote_id, confirmation_id, confirmation_status, updated_at::text AS updated_at FROM shopaccess.checkout_intents WHERE id = $1",
      [intent],
    );
    expect(rows, intent).toHaveLength(1);
    return rows[0];
  };

  const transitionCount = async (intent: string): Promise<number> =>
    (await db.admin.query("SELECT count(*)::integer AS n FROM shopaccess.checkout_transitions WHERE checkout_intent_id = $1", [intent])).rows[0].n;

  /** How many rows of a refused new checkout exist. `group` is null when the group belonged to an earlier fixture. */
  const rowsOf = async (ids: Ids, group: string | null = ids.group): Promise<number> =>
    (
      await db.admin.query(
        `SELECT ((SELECT count(*) FROM shopaccess.purchase_groups WHERE id = $1)
               + (SELECT count(*) FROM shopaccess.checkout_intents WHERE id = $2)
               + (SELECT count(*) FROM shopaccess.quotes WHERE id = $3)
               + (SELECT count(*) FROM shopaccess.quote_items WHERE quote_id = $3)
               + (SELECT count(*) FROM shopaccess.checkout_transitions WHERE checkout_intent_id = $2))::integer AS n`,
        [group, ids.intent, ids.quote],
      )
    ).rows[0].n;

  /** Row count and a digest of every row of each of the seven tables. */
  const snapshot = async (): Promise<Record<string, { rows: number; digest: string }>> => {
    const state: Record<string, { rows: number; digest: string }> = {};
    for (const table of SEVEN_TABLES) {
      const { rows } = await db.admin.query(SQL[`snapshot ${table}` as const]);
      state[table] = { rows: rows[0].n, digest: rows[0].digest };
    }
    return state;
  };

  // -------------------------------------------------------------------------
  // PGT-101, schema part: what migration 0007 created
  // -------------------------------------------------------------------------

  it("PGT-101 (schema part): the seven tables exist and the ledger records migration 0007 with its pinned checksum", async () => {
    const tables = await db.admin.query(
      "SELECT table_name::text AS table_name FROM information_schema.tables WHERE table_schema = 'shopaccess' AND table_type = 'BASE TABLE' AND table_name::text = ANY($1::text[]) ORDER BY 1",
      [[...SEVEN_TABLES]],
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([...SEVEN_TABLES]);
    const owners = await db.admin.query("SELECT tablename::text AS table_name, tableowner::text AS owner FROM pg_catalog.pg_tables WHERE schemaname = 'shopaccess' AND tablename::text = ANY($1::text[])", [
      [...SEVEN_TABLES],
    ]);
    expect(owners.rows).toHaveLength(7);
    for (const row of owners.rows) expect(row.owner, row.table_name).toBe("shopaccess_owner");

    const pinned = APPROVED_MIGRATIONS.find((entry) => entry.version === "0007_checkout_schema");
    expect(pinned).toBeDefined();
    const ledger = await db.admin.query("SELECT version, checksum FROM shopaccess.schema_migrations WHERE version = $1", ["0007_checkout_schema"]);
    expect(ledger.rows).toEqual([{ version: "0007_checkout_schema", checksum: pinned?.sha256 }]);
  });

  it("PGT-101 and PGT-106: the contract keys exist with their columns; only R-B and F-4 are deferred; one quote per intent is a key", async () => {
    const { rows } = await db.admin.query(
      `SELECT c.conname::text AS name, t.relname::text AS table_name, c.contype::text AS kind, c.condeferrable AS deferrable, c.condeferred AS deferred,
              pg_catalog.pg_get_constraintdef(c.oid) AS definition
         FROM pg_catalog.pg_constraint c
         JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'shopaccess' AND t.relname::text = ANY($1::text[])`,
      [[...SEVEN_TABLES]],
    );
    const byName = new Map<string, { table_name: string; kind: string; deferrable: boolean; deferred: boolean; definition: string }>(rows.map((row) => [row.name, row]));

    // PGT-106: the five candidate keys of checkout_intents, none deferrable.
    const candidateKeys: Array<[string, string, string]> = [
      ["checkout_intents_pkey", "p", "PRIMARY KEY (id)"],
      ["checkout_intents_id_owner_key", "u", "UNIQUE (id, owner_id)"],
      ["checkout_intents_id_group_key", "u", "UNIQUE (id, purchase_group_id)"],
      ["checkout_intents_id_replaces_key", "u", "UNIQUE (id, replaces_intent_id)"],
      ["checkout_intents_id_superseded_by_key", "u", "UNIQUE (id, superseded_by_intent_id)"],
    ];
    for (const [name, kind, definition] of candidateKeys) {
      expect(byName.get(name), name).toEqual({ name, table_name: "checkout_intents", kind, deferrable: false, deferred: false, definition });
    }

    // The seven foreign keys of checkout_intents. Two of them, and no others, are deferrable and initially deferred.
    const foreignKeys: Array<[string, string, string, string, boolean]> = [
      ["checkout_intents_group_owner_fkey", "purchase_group_id, owner_id", "purchase_groups", "id, owner_id", false],
      ["checkout_intents_predecessor_group_fkey", "replaces_intent_id, purchase_group_id", "checkout_intents", "id, purchase_group_id", false],
      [F_2, "superseded_by_intent_id, owner_id", "checkout_intents", "id, owner_id", false],
      [R_A, "superseded_by_intent_id, id", "checkout_intents", "id, replaces_intent_id", false],
      [R_B, "replaces_intent_id, id", "checkout_intents", "id, superseded_by_intent_id", true],
      [F_4, "current_quote_id, id", "quotes", "id, checkout_intent_id", true],
      ["checkout_intents_confirmation_fkey", "confirmation_id, id, confirmation_status", "confirmation_challenges", "id, checkout_intent_id, status", false],
    ];
    for (const [name, columns, target, targetColumns, isDeferred] of foreignKeys) {
      const found = byName.get(name);
      expect(found, name).toBeDefined();
      expect([found?.table_name, found?.kind, found?.deferrable, found?.deferred], name).toEqual(["checkout_intents", "f", isDeferred, isDeferred]);
      expect(found?.definition.startsWith(`FOREIGN KEY (${columns}) REFERENCES `), `${name}: ${found?.definition}`).toBe(true);
      expect(found?.definition, name).toContain(`${target}(${targetColumns})`);
    }
    const deferredForeignKeys = rows.filter((row) => row.kind === "f" && (row.deferrable || row.deferred)).map((row) => row.name).sort();
    expect(deferredForeignKeys).toEqual([F_4, R_B].sort());

    // The transition-to-intent key is immediate and not deferrable (19.2).
    const transitionKeys = rows.filter((row) => row.table_name === "checkout_transitions" && row.kind === "f");
    expect(transitionKeys).toHaveLength(1);
    expect([transitionKeys[0].deferrable, transitionKeys[0].deferred]).toEqual([false, false]);
    expect(transitionKeys[0].definition).toContain("checkout_intents(id)");

    // One quote per intent (A-11): a unique key on that one column, not deferrable.
    const oneQuote = rows.filter((row) => row.table_name === "quotes" && row.kind === "u" && row.definition === "UNIQUE (checkout_intent_id)");
    expect(oneQuote).toHaveLength(1);
    expect(oneQuote[0].deferrable).toBe(false);
  });

  it("PGT-101: the triggers of 19.3 are attached, enabled, and the four constraint triggers are deferrable and initially deferred", async () => {
    const { rows } = await db.admin.query(
      `SELECT g.tgname::text AS name, t.relname::text AS table_name, g.tgtype::integer AS type, g.tgenabled::text AS enabled,
              (g.tgconstraint <> 0) AS is_constraint, g.tgdeferrable AS deferrable, g.tginitdeferred AS initially_deferred,
              pn.nspname::text || '.' || p.proname::text AS routine
         FROM pg_catalog.pg_trigger g
         JOIN pg_catalog.pg_class t ON t.oid = g.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_catalog.pg_proc p ON p.oid = g.tgfoid
         JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
        WHERE n.nspname = 'shopaccess' AND NOT g.tgisinternal AND t.relname::text = ANY($1::text[])`,
      [[...SEVEN_TABLES]],
    );
    const byName = new Map<string, Record<string, unknown>>(rows.map((row) => [row.name, row]));

    // pg_trigger.tgtype bits: 1 per row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate.
    const ROW = 1;
    const BEFORE = 2;
    const INSERT = 4;
    const DELETE = 8;
    const UPDATE = 16;
    const TRUNCATE = 32;
    const REJECT = "shopaccess.reject_change";
    const ordinary: Array<[string, SchemaTable, number, string]> = [
      ["purchase_groups_immutable", "purchase_groups", ROW + BEFORE + UPDATE + DELETE, REJECT],
      ["purchase_groups_no_truncate", "purchase_groups", BEFORE + TRUNCATE, REJECT],
      ["checkout_intents_guard", "checkout_intents", ROW + BEFORE + INSERT + UPDATE, "shopaccess.checkout_intents_guard"],
      ["checkout_intents_no_delete", "checkout_intents", ROW + BEFORE + DELETE, REJECT],
      ["checkout_intents_no_truncate", "checkout_intents", BEFORE + TRUNCATE, REJECT],
      ["quotes_immutable", "quotes", ROW + BEFORE + UPDATE + DELETE, REJECT],
      ["quotes_no_truncate", "quotes", BEFORE + TRUNCATE, REJECT],
      ["quote_items_immutable", "quote_items", ROW + BEFORE + UPDATE + DELETE, REJECT],
      ["quote_items_no_truncate", "quote_items", BEFORE + TRUNCATE, REJECT],
      ["confirmation_challenges_guard", "confirmation_challenges", ROW + BEFORE + INSERT + UPDATE, "shopaccess.confirmation_challenges_guard"],
      ["confirmation_challenges_no_delete", "confirmation_challenges", ROW + BEFORE + DELETE, REJECT],
      ["confirmation_challenges_no_truncate", "confirmation_challenges", BEFORE + TRUNCATE, REJECT],
      ["checkout_transitions_append_only", "checkout_transitions", ROW + BEFORE + UPDATE + DELETE, REJECT],
      ["checkout_transitions_no_truncate", "checkout_transitions", BEFORE + TRUNCATE, REJECT],
      ["owner_request_windows_guard", "owner_request_windows", ROW + BEFORE + UPDATE, "shopaccess.owner_request_windows_guard"],
      ["owner_request_windows_no_delete", "owner_request_windows", ROW + BEFORE + DELETE, REJECT],
      ["owner_request_windows_no_truncate", "owner_request_windows", BEFORE + TRUNCATE, REJECT],
    ];
    for (const [name, table, type, routine] of ordinary) {
      expect(byName.get(name), name).toEqual({ name, table_name: table, type, enabled: "O", is_constraint: false, deferrable: false, initially_deferred: false, routine });
    }
    // The four deferred constraint triggers: after the row's insert (and, for the intent, its update), per row.
    const deferred: Array<[string, SchemaTable, number, string]> = [
      [INTENT_HISTORY, "checkout_intents", ROW + INSERT + UPDATE, "shopaccess.checkout_history_check"],
      [TRANSITION_HISTORY, "checkout_transitions", ROW + INSERT, "shopaccess.checkout_history_check"],
      [QUOTE_ITEM, "quotes", ROW + INSERT, "shopaccess.quote_item_check"],
      [ITEM_QUOTE, "quote_items", ROW + INSERT, "shopaccess.quote_item_check"],
    ];
    for (const [name, table, type, routine] of deferred) {
      expect(byName.get(name), name).toEqual({ name, table_name: table, type, enabled: "O", is_constraint: true, deferrable: true, initially_deferred: true, routine });
    }
    expect(rows.filter((row) => row.is_constraint).map((row) => row.name).sort()).toEqual(deferred.map(([name]) => name).sort());
    // Every one of the seven tables refuses TRUNCATE by a trigger of its own, and no trigger on them is switched off.
    for (const table of SEVEN_TABLES) expect(rows.some((row) => row.table_name === table && row.type === BEFORE + TRUNCATE), table).toBe(true);
    expect(rows.filter((row) => row.enabled !== "O").map((row) => row.name)).toEqual([]);
  });

  it("PGT-101: the contract's partial unique indexes exist, and so do the two separately approved expiry indexes", async () => {
    const names = [
      "checkout_intents_one_successor_idx",
      "checkout_intents_one_root_idx",
      "confirmation_challenges_one_active_idx",
      "confirmation_challenges_one_consumed_idx",
      "quotes_expires_at_idx",
      "confirmation_challenges_active_expires_at_idx",
    ];
    const { rows } = await db.admin.query(
      `SELECT ic.relname::text AS name, tc.relname::text AS table_name, i.indisunique AS is_unique, i.indisvalid AS is_valid,
              pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
        WHERE n.nspname = 'shopaccess' AND ic.relname::text = ANY($1::text[])`,
      [names],
    );
    const byName = new Map<string, { table_name: string; is_unique: boolean; is_valid: boolean; predicate: string | null; definition: string }>(rows.map((row) => [row.name, row]));
    const expected: Array<[string, SchemaTable, boolean, string, string | null]> = [
      // Contract (19.2): the two partial unique indexes of checkout_intents.
      ["checkout_intents_one_successor_idx", "checkout_intents", true, "(replaces_intent_id)", "replaces_intent_id IS NOT NULL"],
      ["checkout_intents_one_root_idx", "checkout_intents", true, "(purchase_group_id)", "replaces_intent_id IS NULL"],
      // Section 2.11, adopted by 19.2: at most one ACTIVE and one CONSUMED challenge per quote.
      ["confirmation_challenges_one_active_idx", "confirmation_challenges", true, "(quote_id)", "'ACTIVE'"],
      ["confirmation_challenges_one_consumed_idx", "confirmation_challenges", true, "(quote_id)", "'CONSUMED'"],
      // Approved separately by the owner; not yet listed in the inventory of 19.2. Ordinary, not unique.
      ["quotes_expires_at_idx", "quotes", false, "(expires_at)", null],
      ["confirmation_challenges_active_expires_at_idx", "confirmation_challenges", false, "(expires_at)", "'ACTIVE'"],
    ];
    for (const [name, table, isUnique, columns, predicate] of expected) {
      const found = byName.get(name);
      expect(found, name).toBeDefined();
      expect([found?.table_name, found?.is_unique, found?.is_valid], name).toEqual([table, isUnique, true]);
      expect(found?.definition, name).toContain(columns);
      if (predicate === null) expect(found?.predicate, name).toBeNull();
      else expect(found?.predicate ?? "", name).toContain(predicate);
    }
    expect(byName.get("confirmation_challenges_active_expires_at_idx")?.predicate ?? "").toContain("status");
  });

  // -------------------------------------------------------------------------
  // PGT-102, schema part: after migration 0007 alone, only the table owner reaches the seven tables (19.13)
  // -------------------------------------------------------------------------

  it("PGT-102 (schema part): every direct statement by the web role and by the operator role on the seven tables is refused", async () => {
    for (const [role, pool] of [
      ["web", db.web],
      ["operator", db.operator],
    ] as const) {
      for (const table of SEVEN_TABLES) {
        for (const kind of ["select", "insert", "update", "delete", "truncate"] as const) {
          const statement = `${kind} ${table}` as const;
          expect(await sqlState(() => pool.query(SQL[statement])), `${role}: ${statement}`).toBe(INSUFFICIENT_PRIVILEGE);
        }
      }
    }
  });

  it("PGT-102 (schema part): PUBLIC, web, operator and worker hold no table or column privilege on the seven tables", async () => {
    // The function owner is no longer in this list. Its privileges of 19.13 are given by the functions migration
    // (0008), which this database now has as well, and are asserted exactly in checkout-functions.test.ts and in
    // privileges.test.ts. What stays true at every stage is asserted here: no runtime role and not PUBLIC.
    const roles = ["public", "shopaccess_web", "shopaccess_operator", "shopaccess_worker"];
    const tablePrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    const tables = await db.admin.query(
      `SELECT r.role_name, t.table_name, p.privilege,
              pg_catalog.has_table_privilege(r.role_name::name, 'shopaccess.' || t.table_name, p.privilege) AS granted
         FROM unnest($1::text[]) AS r(role_name)
        CROSS JOIN unnest($2::text[]) AS t(table_name)
        CROSS JOIN unnest($3::text[]) AS p(privilege)`,
      [roles, [...SEVEN_TABLES], tablePrivileges],
    );
    expect(tables.rows).toHaveLength(roles.length * SEVEN_TABLES.length * tablePrivileges.length);
    expect(tables.rows.filter((row) => row.granted).map((row) => `${row.role_name} ${row.privilege} ${row.table_name}`)).toEqual([]);

    const columnPrivileges = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
    const columns = await db.admin.query(
      `SELECT r.role_name, t.table_name, p.privilege,
              pg_catalog.has_any_column_privilege(r.role_name::name, 'shopaccess.' || t.table_name, p.privilege) AS granted
         FROM unnest($1::text[]) AS r(role_name)
        CROSS JOIN unnest($2::text[]) AS t(table_name)
        CROSS JOIN unnest($3::text[]) AS p(privilege)`,
      [roles, [...SEVEN_TABLES], columnPrivileges],
    );
    expect(columns.rows).toHaveLength(roles.length * SEVEN_TABLES.length * columnPrivileges.length);
    expect(columns.rows.filter((row) => row.granted).map((row) => `${row.role_name} ${row.privilege} ${row.table_name}`)).toEqual([]);
  });

  it("PGT-102 (schema part): the five trigger functions are owned by the migration role, run with the caller's rights and a fixed search path, and are executable by no other role", async () => {
    const functions = await db.admin.query(
      `SELECT p.proname::text AS name, o.rolname::text AS owner, p.prosecdef AS security_definer, p.proconfig AS config,
              p.prorettype::regtype::text AS returns, l.lanname::text AS language, p.pronargs::integer AS arguments
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
         JOIN pg_catalog.pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'shopaccess' AND p.proname::text = ANY($1::text[])
        ORDER BY p.proname`,
      [TRIGGER_FUNCTIONS],
    );
    expect(functions.rows).toEqual(
      TRIGGER_FUNCTIONS.map((name) => ({
        name,
        owner: "shopaccess_owner",
        security_definer: false,
        config: ["search_path=pg_catalog, pg_temp"],
        returns: "trigger",
        language: "plpgsql",
        arguments: 0,
      })),
    );

    const roles = ["public", "shopaccess_web", "shopaccess_operator", "shopaccess_worker", "shopaccess_definer"];
    const execute = await db.admin.query(
      `SELECT r.role_name, f.name,
              pg_catalog.has_function_privilege(r.role_name::name, 'shopaccess.' || f.name || '()', 'EXECUTE') AS granted
         FROM unnest($1::text[]) AS r(role_name)
        CROSS JOIN unnest($2::text[]) AS f(name)`,
      [roles, TRIGGER_FUNCTIONS],
    );
    expect(execute.rows).toHaveLength(roles.length * TRIGGER_FUNCTIONS.length);
    expect(execute.rows.filter((row) => row.granted).map((row) => `${row.role_name} ${row.name}`)).toEqual([]);
  });

  it("PGT-102 (schema part): the triggers bind the table owner too", async () => {
    // Not evidence for "a trigger fires for a role without EXECUTE on its function": at this stage the only roles that
    // can write these tables are the table owner, which owns the functions, and the test owner, a superuser. That
    // question waits for the function owner's grants. What can be shown now is that owning the table is not a way round.
    const ids = await createRoot(ownerA);
    const before = await snapshot();
    await db.admin.query(SQL.setRoleOwner);
    try {
      const attempts: Array<[string, Step]> = [
        ["update of a purchase group", ["touchGroup", [ids.group]]],
        ["delete of a quote item", ["deleteItems", [ids.quote]]],
        ["delete of a checkout intent", ["deleteIntent", [ids.intent]]],
        ["update of a transition", ["touchTransitions", [ids.intent]]],
      ];
      for (const [what, step] of attempts) {
        const outcome = await change(ids, step);
        expectRefused("PGT-102", `as the table owner, ${what}`, outcome, AFTER_LOCKS, { message: "is not permitted on" });
        expect(outcome.refusal?.code, what).not.toBe(INSUFFICIENT_PRIVILEGE);
      }
    } finally {
      await db.admin.query(SQL.resetRole);
    }
    expect(await snapshot()).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // Positive controls: valid fixtures commit
  // -------------------------------------------------------------------------

  it("positive control: a valid new checkout commits, and each of the five legal state changes commits with its transition", async () => {
    const quoted = await createRoot(ownerA);
    expect(await intentRow(quoted.intent)).toMatchObject({ state: "QUOTED", row_version: 2, replaces_intent_id: null, superseded_by_intent_id: null, current_quote_id: quoted.quote });
    expect(await transitionCount(quoted.intent)).toBe(1);

    // QUOTED to USER_CONFIRMED (T2), then USER_CONFIRMED to CANCELED_LOCAL (T4).
    const confirmedThenCanceled = await createRoot(ownerA);
    const { challenge } = await confirm(confirmedThenCanceled);
    expect(await intentRow(confirmedThenCanceled.intent)).toMatchObject({ state: "USER_CONFIRMED", row_version: 3, confirmation_id: challenge, confirmation_status: "CONSUMED" });
    await cancel(confirmedThenCanceled, "T4", 3);
    expect(await intentRow(confirmedThenCanceled.intent)).toMatchObject({ state: "CANCELED_LOCAL", row_version: 4, confirmation_id: challenge });

    // QUOTED to CANCELED_LOCAL (T3).
    const canceled = await createRoot(ownerA);
    await cancel(canceled);
    expect(await intentRow(canceled.intent)).toMatchObject({ state: "CANCELED_LOCAL", row_version: 3 });

    // QUOTED to SUPERSEDED (T5): a correct predecessor and successor pair (PGT-107).
    const predecessor = await createRoot(ownerA);
    const successor = await createSuccessor(predecessor);
    expect(await intentRow(predecessor.intent)).toMatchObject({ state: "SUPERSEDED", row_version: 3, superseded_by_intent_id: successor.intent });
    expect(await intentRow(successor.intent)).toMatchObject({ state: "QUOTED", row_version: 2, replaces_intent_id: predecessor.intent });

    // USER_CONFIRMED to SUPERSEDED (T6).
    const confirmedPredecessor = await createRoot(ownerA);
    await confirm(confirmedPredecessor);
    const secondSuccessor = await createSuccessor(confirmedPredecessor, "T6", 3);
    expect(await intentRow(confirmedPredecessor.intent)).toMatchObject({ state: "SUPERSEDED", row_version: 4, superseded_by_intent_id: secondSuccessor.intent });
  });

  // -------------------------------------------------------------------------
  // PGT-112 (b), the schema-only control of PGT-112 (c), PGT-107, PGT-146 and PGT-147: the deferred checks
  // -------------------------------------------------------------------------

  interface DeferredCase {
    readonly pgt: string;
    readonly what: string;
    /** The deferred constraint that this invalid fixture violates. */
    readonly constraint: DeferredConstraint;
    /** A second deferred check of the same rule that may answer first at COMMIT, when both are queued. */
    readonly orAtCommit?: DeferredConstraint;
    /** A fragment of the reason the check gives, for the history and quote checks. */
    readonly reason?: string;
    /** Builds a new invalid fixture, and a count of what must not exist or must not have changed afterwards. */
    build(): Promise<{ steps: Step[]; leftovers(): Promise<number> }>;
  }

  /**
   * An invalid transaction on an existing committed checkout: afterwards the checkout must be exactly as it was.
   * `updates` says whether the transaction changes the existing intent row; if it does, the locks of P6 come first.
   */
  const onExisting = async (updates: boolean, make: (base: Ids) => Step[]): Promise<{ steps: Step[]; leftovers(): Promise<number> }> => {
    const base = await createRoot(ownerA);
    return {
      steps: updates ? withLocks(base, make(base)) : make(base),
      leftovers: async () => {
        const row = await intentRow(base.intent);
        return (row.state === "QUOTED" && row.row_version === 2 ? 0 : 1) + ((await transitionCount(base.intent)) - 1);
      },
    };
  };

  const deferredCases: readonly DeferredCase[] = [
    {
      pgt: "PGT-112(b), PGT-107",
      what: "a successor whose predecessor is not marked (R-B)",
      constraint: R_B,
      build: async () => {
        // The predecessor is deliberately left unchanged, so this transaction changes no existing row and takes no lock.
        const predecessor = await createRoot(ownerA);
        const ids = freshIds(ownerA, predecessor.group);
        return {
          steps: [intentStep(ids, { replaces: predecessor.intent }), quoteStep(ids, line), itemStep(ids, line), t1Step(ids.intent)],
          leftovers: async () => (await rowsOf(ids, null)) + ((await intentRow(predecessor.intent)).superseded_by_intent_id === null ? 0 : 1),
        };
      },
    },
    {
      pgt: "PGT-112(b)",
      what: "an intent whose quote pointer names no quote (F-4)",
      constraint: F_4,
      build: async () => {
        const ids = freshIds(ownerA);
        return { steps: [groupStep(ids), intentStep(ids), t1Step(ids.intent)], leftovers: () => rowsOf(ids) };
      },
    },
    {
      pgt: "PGT-112(b), PGT-112(c) control for S2, PGT-147",
      what: "an intent with no first transition",
      constraint: INTENT_HISTORY,
      reason: "H1:",
      build: async () => {
        const ids = freshIds(ownerA);
        return { steps: [groupStep(ids), intentStep(ids), quoteStep(ids, line), itemStep(ids, line)], leftovers: () => rowsOf(ids) };
      },
    },
    {
      pgt: "PGT-112(b), PGT-147",
      what: "an extra transition for an unchanged intent",
      constraint: TRANSITION_HISTORY,
      reason: "H1:",
      // An insert only: the existing intent row is not changed.
      build: () => onExisting(false, (base) => [transitionStep(base.intent, "T3", 2)]),
    },
    {
      pgt: "PGT-112(b), PGT-112(c) control for S1, PGT-146",
      what: "a quote with no item",
      constraint: QUOTE_ITEM,
      reason: "Q1:",
      build: async () => {
        const ids = freshIds(ownerA);
        return { steps: [groupStep(ids), intentStep(ids), quoteStep(ids, line), t1Step(ids.intent)], leftovers: () => rowsOf(ids) };
      },
    },
    {
      pgt: "PGT-112(b), PGT-146",
      what: "an item whose subtotal differs from its quote's",
      constraint: ITEM_QUOTE,
      // The quote's own check is queued first, by the quote's insert, and validates the same pair.
      orAtCommit: QUOTE_ITEM,
      reason: "Q2:",
      build: async () => {
        const ids = freshIds(ownerA);
        return {
          steps: [groupStep(ids), intentStep(ids), quoteStep(ids, line, { subtotal: line.unit_amount_cents * 2 }), itemStep(ids, line), t1Step(ids.intent)],
          leftovers: () => rowsOf(ids),
        };
      },
    },
    {
      pgt: "PGT-112(c) control for C1",
      what: "an intent canceled with no transition",
      constraint: INTENT_HISTORY,
      reason: "H1:",
      build: () => onExisting(true, (base) => [stateStep(base.intent, "CANCELED_LOCAL")]),
    },
    {
      pgt: "PGT-147",
      what: "a version gap",
      constraint: INTENT_HISTORY,
      orAtCommit: TRANSITION_HISTORY,
      reason: "H1:",
      build: () => onExisting(true, (base) => [stateStep(base.intent, "CANCELED_LOCAL"), transitionStep(base.intent, "T3", 3)]),
    },
    {
      pgt: "PGT-147",
      what: "a state discontinuity",
      constraint: INTENT_HISTORY,
      orAtCommit: TRANSITION_HISTORY,
      reason: "H3:",
      build: () => onExisting(true, (base) => [stateStep(base.intent, "CANCELED_LOCAL"), transitionStep(base.intent, "T4", 2)]),
    },
    {
      pgt: "PGT-147",
      what: "a final-state mismatch",
      constraint: INTENT_HISTORY,
      orAtCommit: TRANSITION_HISTORY,
      reason: "H4:",
      build: () => onExisting(true, (base) => [stateStep(base.intent, "CANCELED_LOCAL"), transitionStep(base.intent, "T5", 2)]),
    },
  ];

  it("PGT-112(b), 107, 146, 147: each invalid fixture is accepted statement by statement, refused at COMMIT with its constraint named, and leaves nothing", async () => {
    // This is also the control of PGT-112(c): the same invalid state, made by direct writes that force nothing,
    // raises only at COMMIT. The other half of PGT-112(c), a real function call that must raise inside the call, needs
    // the functions and is not here.
    for (const deferredCase of deferredCases) {
      const fixture = await deferredCase.build();
      const outcome = await transact(db.admin, fixture.steps);
      const accepted = deferredCase.orAtCommit === undefined ? deferredCase.constraint : [deferredCase.constraint, deferredCase.orAtCommit];
      expectRefused(deferredCase.pgt, `${deferredCase.what}, at COMMIT`, outcome, "COMMIT", { constraint: accepted, message: deferredCase.reason });
      expect(await fixture.leftovers(), deferredCase.what).toBe(0);
    }
  });

  it("PGT-112(b), 147: setting the violated constraint to immediate raises at that statement, with its name, and leaves nothing", async () => {
    // First evidence for the assumption that SET CONSTRAINTS can name a constraint trigger as well as a foreign key.
    for (const deferredCase of deferredCases) {
      const fixture = await deferredCase.build();
      const steps: Step[] = [...fixture.steps, [`immediate ${deferredCase.constraint}` as const]];
      const outcome = await transact(db.admin, steps);
      expectRefused(deferredCase.pgt, `${deferredCase.what}, at SET CONSTRAINTS`, outcome, fixture.steps.length, { constraint: deferredCase.constraint, message: deferredCase.reason });
      expect(await fixture.leftovers(), deferredCase.what).toBe(0);
    }
  });

  it("PGT-112(b): all six deferred constraints are covered by an invalid fixture of their own", () => {
    expect([...new Set<string>(deferredCases.map((deferredCase) => deferredCase.constraint))].sort()).toEqual([F_4, INTENT_HISTORY, ITEM_QUOTE, QUOTE_ITEM, R_B, TRANSITION_HISTORY].sort());
  });

  // -------------------------------------------------------------------------
  // PGT-107 to PGT-110: the replacement chain, by direct writes
  // -------------------------------------------------------------------------

  it("PGT-107: a successor pointer to a root, to an unrelated intent or to a missing intent is refused at once", async () => {
    const predecessor = await createRoot(ownerA);
    const otherRoot = await createRoot(ownerA);
    const unrelated = await createSuccessor(await createRoot(ownerA));
    const before = await intentRow(predecessor.intent);

    expectRefused("PGT-107", "pointer to a root", await change(predecessor, supersedeStep(predecessor.intent, otherRoot.intent)), AFTER_LOCKS, { constraint: R_A });
    expectRefused("PGT-107", "pointer to another intent's successor", await change(predecessor, supersedeStep(predecessor.intent, unrelated.intent)), AFTER_LOCKS, { constraint: R_A });
    // A missing intent fails both the owner key and the reciprocal key; which one answers is not assumed.
    expectRefused("PGT-107", "pointer to a missing intent", await change(predecessor, supersedeStep(predecessor.intent, newId("ci"))), AFTER_LOCKS, { constraint: [R_A, F_2] });

    expect(await intentRow(predecessor.intent)).toEqual(before);
  });

  it("PGT-108: ancestry is fixed at insertion, and no ring can be inserted in one statement", async () => {
    const root = await createRoot(ownerA);
    const first = await createRoot(ownerA);
    const second = await createSuccessor(first);
    const third = await createSuccessor(second);
    const before = [await intentRow(root.intent), await intentRow(first.intent), await intentRow(second.intent), await intentRow(third.intent)];

    expectRefused("PGT-108", "a root given a predecessor", await change(root, predecessorStep(root.intent, third.intent)), AFTER_LOCKS, { message: "immutable" });
    // The row whose predecessor would change already has a successor, so it is terminal and refuses every update.
    expectRefused("PGT-108", "a predecessor changed to a descendant", await change(second, predecessorStep(second.intent, third.intent)), AFTER_LOCKS, { message: "terminal state" });
    expect([await intentRow(root.intent), await intentRow(first.intent), await intentRow(second.intent), await intentRow(third.intent)]).toEqual(before);

    // New rows only: nothing existing is changed, so nothing is locked.
    const ring = (size: 2 | 3, reciprocal: boolean): Step[] => {
      const group = newId("pur");
      const ids = Array.from({ length: size }, () => freshIds(ownerA, group));
      const rows = ids.map((member, index) => ({
        id: member.intent,
        owner: ownerA,
        group,
        replaces: ids[(index + 1) % size].intent,
        supersededBy: reciprocal ? ids[(index + size - 1) % size].intent : null,
        state: "QUOTED",
        rowVersion: 2,
        quote: member.quote,
      }));
      return [groupStep({ group, owner: ownerA }), intentsStep(rows)];
    };
    const NO_PREDECESSOR = "names a checkout intent that already exists";
    const NO_SUCCESSOR_AT_INSERT = "no successor and no confirmation";
    expectRefused("PGT-108", "a two-row ring in one statement", await transact(db.admin, ring(2, false)), 1, { message: NO_PREDECESSOR });
    expectRefused("PGT-108", "a three-row ring in one statement", await transact(db.admin, ring(3, false)), 1, { message: NO_PREDECESSOR });
    expectRefused("PGT-108", "a fully reciprocal ring in one statement", await transact(db.admin, ring(2, true)), 1, { message: NO_SUCCESSOR_AT_INSERT });
    expectRefused("PGT-108", "a fully reciprocal three-row ring in one statement", await transact(db.admin, ring(3, true)), 1, { message: NO_SUCCESSOR_AT_INSERT });
  });

  it("PGT-109: serial attempts by a privileged writer to close a two-row and a three-row ring are all refused", async () => {
    // Nothing is claimed for concurrent writers that bypass the functions (17.4, item 25).
    const first = await createRoot(ownerA);
    const second = await createSuccessor(first);
    const third = await createSuccessor(second);
    const pointers = async () => [await intentRow(first.intent), await intentRow(second.intent), await intentRow(third.intent)];
    const before = await pointers();

    // Two rows: make the last intent's successor its own predecessor, or the predecessor's predecessor the last intent.
    expectRefused("PGT-109", "two-row ring by successor pointer", await change(third, supersedeStep(third.intent, second.intent)), AFTER_LOCKS, { constraint: R_A });
    expectRefused("PGT-109", "two-row ring by predecessor pointer", await change(second, predecessorStep(second.intent, third.intent)), AFTER_LOCKS, { message: "terminal state" });
    // Three rows: join the last intent back to the root, from either end.
    expectRefused("PGT-109", "three-row ring by successor pointer", await change(third, supersedeStep(third.intent, first.intent)), AFTER_LOCKS, { constraint: R_A });
    expectRefused("PGT-109", "three-row ring by predecessor pointer", await change(first, predecessorStep(first.intent, third.intent)), AFTER_LOCKS, { message: "terminal state" });
    expect(await pointers()).toEqual(before);
  });

  it("PGT-110: the successor pointer is set once, only with the change to SUPERSEDED, and a terminal row accepts no update", async () => {
    const quoted = await createRoot(ownerA);
    const other = await createRoot(ownerA);
    const superseded = await createRoot(ownerA);
    await createSuccessor(superseded);
    const canceled = await createRoot(ownerA);
    await cancel(canceled);
    const before = [await intentRow(quoted.intent), await intentRow(superseded.intent), await intentRow(canceled.intent)];

    const TERMINAL = { message: "terminal state" };
    expectRefused("PGT-110", "pointer set without a state change", await change(quoted, ["setIntentSuccessorOnly", [quoted.intent, other.intent, T_LATER]]), AFTER_LOCKS, {
      message: "illegal checkout intent state change",
    });
    expectRefused("PGT-110", "pointer changed", await change(superseded, ["setIntentSuccessorOnly", [superseded.intent, other.intent, T_LATER]]), AFTER_LOCKS, TERMINAL);
    expectRefused("PGT-110", "pointer cleared", await change(superseded, ["clearIntentSuccessor", [superseded.intent, T_LATER]]), AFTER_LOCKS, TERMINAL);
    expectRefused("PGT-110", "update of a SUPERSEDED row", await change(superseded, ["touchIntent", [superseded.intent, T_LATER]]), AFTER_LOCKS, TERMINAL);
    expectRefused("PGT-110", "update of a CANCELED_LOCAL row", await change(canceled, ["touchIntent", [canceled.intent, T_LATER]]), AFTER_LOCKS, TERMINAL);
    expectRefused("PGT-110", "a CANCELED_LOCAL row moved back to QUOTED", await change(canceled, stateStep(canceled.intent, "QUOTED")), AFTER_LOCKS, TERMINAL);

    expect([await intentRow(quoted.intent), await intentRow(superseded.intent), await intentRow(canceled.intent)]).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // PGT-105, PGT-148, PGT-155: states, events, actors and edges
  // -------------------------------------------------------------------------

  const INSERTED_AS_QUOTED = { message: "inserted as QUOTED" };
  const ILLEGAL_EDGE = { message: "illegal checkout intent state change" };
  const TRANSITION_CHECK = { constraint: /^checkout_transitions_[a-z_]+_check$/ };

  it("PGT-105: payment states, payment events, other actors and DRAFT as a stored state are rejected", async () => {
    // The stored-state list holds the five states of 19.2 and nothing else.
    const check = await db.admin.query(
      `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS definition
         FROM pg_catalog.pg_constraint c
         JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'shopaccess' AND t.relname = 'checkout_intents' AND c.conname = 'checkout_intents_state_check'`,
    );
    expect(check.rows).toHaveLength(1);
    const listed = [...String(check.rows[0].definition).matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort();
    expect(listed).toEqual(["CANCELED_LOCAL", "EXPIRED", "QUOTED", "SUPERSEDED", "USER_CONFIRMED"]);

    for (const state of ["DRAFT", "CAPTURE_PENDING", "CAPTURED_VERIFIED", "DISPATCHING"]) {
      const ids = freshIds(ownerA);
      expectRefused("PGT-105", `an intent stored as ${state}`, await transact(db.admin, [groupStep(ids), intentStep(ids, { state })]), 1, INSERTED_AS_QUOTED);
      expect(await rowsOf(ids), state).toBe(0);
      const existing = await createRoot(ownerA);
      expectRefused("PGT-105", `an intent updated to ${state}`, await change(existing, stateStep(existing.intent, state)), AFTER_LOCKS, ILLEGAL_EDGE);
      expect(await intentRow(existing.intent)).toMatchObject({ state: "QUOTED", row_version: 2 });
    }

    const base = await createRoot(ownerA);
    const T3: TransitionRow = { intent: base.intent, fromVersion: 2, toVersion: 3, eventId: "", ...LEGAL.T3 };
    const rejected: Array<[string, Partial<TransitionRow>]> = [
      ["payment event CAPTURE_COMPLETED", { event: "CAPTURE_COMPLETED" }],
      ["payment event CAPTURE_DISPATCHED", { event: "CAPTURE_DISPATCHED" }],
      ["actor timer", { actor: "timer" }],
      ["actor browser_redirect", { actor: "browser_redirect" }],
      ["actor operation_worker", { actor: "operation_worker" }],
      ["actor reconciler", { actor: "reconciler" }],
      ["payment state as target", { to: "CAPTURED_VERIFIED" }],
      ["payment state as origin", { from: "DISPATCHING" }],
      ["DRAFT as target", { to: "DRAFT" }],
    ];
    for (const [what, difference] of rejected) {
      expectRefused("PGT-105", `a transition with ${what}`, await one(rawTransitionStep({ ...T3, ...difference, eventId: newId("evt") })), 0, TRANSITION_CHECK);
    }
    expect(await transitionCount(base.intent)).toBe(1);
  });

  it("PGT-148: every state change outside the five legal edges is refused, from every stored state that can be built", async () => {
    const quoted = await createRoot(ownerA);
    const confirmed = await createRoot(ownerA);
    await confirm(confirmed);
    const superseded = await createRoot(ownerA);
    await createSuccessor(superseded);
    const canceled = await createRoot(ownerA);
    await cancel(canceled);

    const STATES = ["QUOTED", "USER_CONFIRMED", "SUPERSEDED", "CANCELED_LOCAL", "EXPIRED"];
    const legal = new Set(["QUOTED>USER_CONFIRMED", "QUOTED>SUPERSEDED", "QUOTED>CANCELED_LOCAL", "USER_CONFIRMED>SUPERSEDED", "USER_CONFIRMED>CANCELED_LOCAL"]);
    // A stored EXPIRED cannot be constructed in Increment 2.1, so it has no row to start from.
    const stored: Array<[string, Ids, boolean]> = [
      ["QUOTED", quoted, false],
      ["USER_CONFIRMED", confirmed, false],
      ["SUPERSEDED", superseded, true],
      ["CANCELED_LOCAL", canceled, true],
    ];
    let attempts = 0;
    for (const [from, ids, terminal] of stored) {
      const before = await intentRow(ids.intent);
      expect(before.state).toBe(from);
      for (const to of STATES) {
        if (legal.has(`${from}>${to}`)) continue;
        attempts += 1;
        expectRefused("PGT-148", `${from} to ${to}`, await change(ids, stateStep(ids.intent, to)), AFTER_LOCKS, terminal ? { message: "terminal state" } : ILLEGAL_EDGE);
      }
      expect(await intentRow(ids.intent), from).toEqual(before);
    }
    // 4 stored states, 5 targets each, less the 5 legal edges.
    expect(attempts).toBe(15);

    // A row version that does not rise by exactly one is refused as well.
    expectRefused("PGT-148", "a legal edge with a version step of two", await change(quoted, ["cancelIntentByTwoVersions", [quoted.intent, T_LATER]]), AFTER_LOCKS, { message: "row_version" });
    expect(await intentRow(quoted.intent)).toMatchObject({ state: "QUOTED", row_version: 2 });
  });

  it("PGT-148: every transition outside T1 to T6 is refused at once, including a wrong actor, entry point or version", async () => {
    const base = await createRoot(ownerA);
    const at = (kind: LegalKind, fromVersion: number, difference: Partial<TransitionRow> = {}): TransitionRow => ({
      intent: base.intent,
      fromVersion,
      toVersion: fromVersion + 1,
      eventId: newId("evt"),
      ...LEGAL[kind],
      ...difference,
    });
    const rejected: Array<[string, TransitionRow]> = [
      ["T1 at versions 2 to 3", at("T1", 2)],
      ["T1 by the shopper", at("T1", 1, { actor: "shopper" })],
      ["T1 through cancel_checkout", at("T1", 1, { entry: "cancel_checkout" })],
      ["QUOTE_ISSUED from QUOTED", at("T1", 2, { from: "QUOTED" })],
      ["T2 by the server", at("T2", 2, { actor: "server" })],
      ["T2 through start_checkout", at("T2", 2, { entry: "start_checkout" })],
      ["T2 at versions 1 to 2", at("T2", 1)],
      ["T2 from DRAFT", at("T2", 2, { from: "DRAFT" })],
      ["T3 by the server", at("T3", 2, { actor: "server" })],
      ["T3 through start_checkout", at("T3", 2, { entry: "start_checkout" })],
      ["T3 through consume_challenge", at("T3", 2, { entry: "consume_challenge" })],
      ["T3 at versions 1 to 2", at("T3", 1)],
      ["cancel from SUPERSEDED", at("T3", 2, { from: "SUPERSEDED" })],
      ["cancel from CANCELED_LOCAL", at("T3", 2, { from: "CANCELED_LOCAL" })],
      ["cancel from EXPIRED", at("T3", 2, { from: "EXPIRED" })],
      ["cancel to USER_CONFIRMED", at("T3", 2, { to: "USER_CONFIRMED" })],
      ["T5 by the shopper", at("T5", 2, { actor: "shopper" })],
      ["T5 through cancel_checkout", at("T5", 2, { entry: "cancel_checkout" })],
      ["T5 at versions 1 to 2", at("T5", 1)],
      ["supersede from DRAFT", at("T5", 2, { from: "DRAFT" })],
      ["supersede from CANCELED_LOCAL", at("T6", 2, { from: "CANCELED_LOCAL" })],
      ["supersede to QUOTED", at("T5", 2, { to: "QUOTED" })],
      ["an entry point that does not exist", at("T3", 2, { entry: "issue_challenge" })],
      ["an event that does not exist", at("T3", 2, { event: "QUOTE_EXPIRED" })],
      ["a version step of two", at("T3", 2, { toVersion: 4 })],
      ["a version step of zero", at("T3", 2, { toVersion: 2 })],
    ];
    for (const [what, row] of rejected) {
      expectRefused("PGT-148", `transition: ${what}`, await one(rawTransitionStep(row)), 0, TRANSITION_CHECK);
    }
    expect(await transitionCount(base.intent)).toBe(1);
  });

  it("PGT-155: EXPIRED cannot be inserted as a stored state, reached by update, or named as a transition target", async () => {
    const ids = freshIds(ownerA);
    expectRefused("PGT-155", "an intent inserted as EXPIRED", await transact(db.admin, [groupStep(ids), intentStep(ids, { state: "EXPIRED" })]), 1, INSERTED_AS_QUOTED);
    expect(await rowsOf(ids)).toBe(0);

    const quoted = await createRoot(ownerA);
    const confirmed = await createRoot(ownerA);
    await confirm(confirmed);
    expectRefused("PGT-155", "QUOTED updated to EXPIRED", await change(quoted, stateStep(quoted.intent, "EXPIRED")), AFTER_LOCKS, ILLEGAL_EDGE);
    expectRefused("PGT-155", "USER_CONFIRMED updated to EXPIRED", await change(confirmed, stateStep(confirmed.intent, "EXPIRED")), AFTER_LOCKS, ILLEGAL_EDGE);
    expect(await intentRow(quoted.intent)).toMatchObject({ state: "QUOTED", row_version: 2 });
    expect(await intentRow(confirmed.intent)).toMatchObject({ state: "USER_CONFIRMED", row_version: 3 });

    // EXPIRED is in the list of target states and in no legal combination, so the combination check is what refuses it.
    for (const kind of ["T3", "T5"] as const) {
      expectRefused("PGT-155", `a ${LEGAL[kind].event} transition to EXPIRED`, await one(transitionStep(quoted.intent, kind, 2, { to: "EXPIRED" })), 0, {
        constraint: "checkout_transitions_legal_combination_check",
      });
    }
    expect(await transitionCount(quoted.intent)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // PGT-119, PGT-139, PGT-146, PGT-147(a), PGT-151: quotes, items, identifiers
  // -------------------------------------------------------------------------

  it("PGT-119 (schema part): a quote expires exactly 15 minutes after it was created, and no other lifetime is stored", async () => {
    const stored = await createRoot(ownerA);
    const lifetime = await db.admin.query("SELECT (expires_at - created_at) = interval '15 minutes' AS exact FROM shopaccess.quotes WHERE id = $1", [stored.quote]);
    expect(lifetime.rows).toEqual([{ exact: true }]);

    for (const other of ["14 minutes", "16 minutes", "15 minutes 1 second", "0 minutes"]) {
      const ids = freshIds(ownerA);
      const outcome = await transact(db.admin, [groupStep(ids), intentStep(ids), quoteStep(ids, line, { lifetime: other })]);
      expectRefused("PGT-119", `a quote lifetime of ${other}`, outcome, 2, { constraint: "quotes_lifetime_check" });
      expect(await rowsOf(ids), other).toBe(0);
    }
    // The effective status around the expiry instant, and the stored state after expiry, are read through the
    // functions and are not tested here.
  });

  it("PGT-139 (schema part): a duplicate intent, quote or transition event identifier is refused by its own key", async () => {
    const eventId = newId("evt");
    const existing = freshIds(ownerA);
    await must("checkout with a known event id", [groupStep(existing), intentStep(existing), quoteStep(existing, line), itemStep(existing, line), t1Step(existing.intent, eventId)]);

    // A different owner and group each time, so that only the single-column key is violated.
    const sameIntent: Ids = { ...freshIds(ownerB), intent: existing.intent };
    expectRefused("PGT-139", "duplicate intent id", await transact(db.admin, [groupStep(sameIntent), intentStep(sameIntent)]), 1, { constraint: "checkout_intents_pkey" });

    const sameQuote: Ids = { ...freshIds(ownerB), quote: existing.quote };
    expectRefused("PGT-139", "duplicate quote id", await transact(db.admin, [groupStep(sameQuote), intentStep(sameQuote), quoteStep(sameQuote, line)]), 2, { constraint: "quotes_pkey" });
    expect(await rowsOf({ ...sameQuote, quote: newId("qt") })).toBe(0);

    const sameEvent = freshIds(ownerB);
    expectRefused(
      "PGT-139",
      "duplicate transition event id",
      await transact(db.admin, [groupStep(sameEvent), intentStep(sameEvent), quoteStep(sameEvent, line), itemStep(sameEvent, line), t1Step(sameEvent.intent, eventId)]),
      4,
      { constraint: "checkout_transitions_event_id_key" },
    );
    expect(await rowsOf(sameEvent)).toBe(0);
    // The rule that no function handles a unique violation is a static check on the functions and is not here.
  });

  it("PGT-139 (schema part): a duplicate audit event identifier is refused by the audit table's unique key", async () => {
    // A synthetic audit row, as policy P7 allows a fixture to write: the CONFIRMATION_ACCEPTED row of the PGT-142
    // fixture table, for a checkout confirmed by a fixture. No function writes it, and nothing here says one would.
    // The specification says what the detail holds and not what its keys are called; the three names are this file's.
    const ids = await createRoot(ownerA);
    // PGT-142 times three things at one instant: the challenge's consumption, the confirming transition, and the
    // audit row. The fixture consumes the challenge at T_CONSUMED, so the transition and the audit row use it too.
    // The audit row is written by the fixture's own transaction, as its last statement, and commits with the rest.
    const { challenge, eventId: transitionEventId } = await confirm(ids, T_CONSUMED, true);
    const values = [T_CONSUMED, ids.owner, ids.intent, transitionEventId, challenge, ids.quote];
    const stored = async (auditEventId: string) =>
      (await db.admin.query("SELECT a::text AS row FROM shopaccess.audit_events a WHERE a.event_id = $1 ORDER BY a.id", [auditEventId])).rows.map((row) => row.row);

    // The fixture's row took an identifier generated in the database, in the form the audit functions use. It is the
    // one CONFIRMATION_ACCEPTED row of this intent.
    const written = await db.admin.query("SELECT a.event_id FROM shopaccess.audit_events a WHERE a.checkout_intent_id = $1 AND a.event_type = 'CONFIRMATION_ACCEPTED'", [ids.intent]);
    expect(written.rows).toHaveLength(1);
    const auditEventId = String(written.rows[0].event_id);
    expect(auditEventId).toMatch(/^ev_[0-9a-f]{32}$/);
    const before = await stored(auditEventId);
    expect(before).toHaveLength(1);

    // As stored: the transition and the audit row carry the challenge's consumption time, each as both of its times.
    // Equal times alone would not show one transaction, so the rows are also compared by the transaction that wrote
    // their current version: the challenge, the intent, the transition and the audit row must all name the same one.
    const times = await db.admin.query(
      `SELECT c.consumed_at = t.occurred_at AS transition_at_consumption,
              t.recorded_at = t.occurred_at AS transition_recorded_then,
              a.occurred_at = c.consumed_at AS audit_at_consumption,
              a.recorded_at = c.consumed_at AS audit_recorded_then,
              (c.xmin = a.xmin AND i.xmin = a.xmin AND t.xmin = a.xmin) AS written_by_one_transaction
         FROM shopaccess.confirmation_challenges c
         JOIN shopaccess.checkout_intents i ON i.id = c.checkout_intent_id
         JOIN shopaccess.checkout_transitions t ON t.event_id = $2
         JOIN shopaccess.audit_events a ON a.event_id = $3
        WHERE c.id = $1`,
      [challenge, transitionEventId, auditEventId],
    );
    expect(times.rows).toEqual([
      { transition_at_consumption: true, transition_recorded_then: true, audit_at_consumption: true, audit_recorded_then: true, written_by_one_transaction: true },
    ]);

    // The same row again with the same identifier: every other value is valid, so the identifier is the only reason.
    // The key was declared without a name in migration 0005, so its name is the one PostgreSQL gives it.
    expectRefused("PGT-139", "duplicate audit event id", await one(["insertAuditWithId", [...values, auditEventId]]), 0, { constraint: "audit_events_event_id_key" });
    expect(await stored(auditEventId)).toEqual(before);

    // Control: the same row with a new identifier is accepted, given or generated.
    const otherId = newId("evt");
    await must("the same audit row under another identifier", [["insertAuditWithId", [...values, otherId]]]);
    expect(await stored(otherId)).toHaveLength(1);
    const second = await db.admin.query(SQL.insertAuditGenerated, values);
    expect(String(second.rows[0].event_id)).not.toBe(auditEventId);
    expect(await stored(auditEventId)).toEqual(before);
  });

  it("PGT-146: a second item for a quote is refused at once, whatever its line number", async () => {
    // A quote with no item, and an item whose subtotal differs, are refused at COMMIT: see the deferred cases above.
    const ids = await createRoot(ownerA);
    expectRefused("PGT-146", "a second item with line number 2", await one(itemStep(ids, line, { lineNumber: 2 })), 0, { constraint: "quote_items_line_number_check" });
    expectRefused("PGT-146", "a second item with line number 1", await one(itemStep(ids, line)), 0, { constraint: "quote_items_pkey" });
    const items = await db.admin.query("SELECT count(*)::integer AS n FROM shopaccess.quote_items WHERE quote_id = $1", [ids.quote]);
    expect(items.rows[0].n).toBe(1);
  });

  it("PGT-147(a): a transition that names an intent which does not exist is refused at the statement, by the immediate key", async () => {
    const outcome = await one(t1Step(newId("ci")));
    expectRefused("PGT-147", "an orphan transition", outcome, 0, { constraint: "checkout_transitions_intent_fkey" });
  });

  it("PGT-151: a second quote for one intent is refused", async () => {
    const ids = await createRoot(ownerA);
    expectRefused("PGT-151", "a second quote", await one(quoteStep(ids, line, { quote: newId("qt"), digest: hex(32) })), 0, { constraint: "quotes_checkout_intent_id_key" });
    const quotes = await db.admin.query("SELECT count(*)::integer AS n FROM shopaccess.quotes WHERE checkout_intent_id = $1", [ids.intent]);
    expect(quotes.rows[0].n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Ownership at the schema level. Nothing here tests the functions' authorization.
  // -------------------------------------------------------------------------

  it("schema-level ownership: an intent, a quote and a challenge cannot be attached to another owner's rows", async () => {
    const foreignIntent = freshIds(ownerA);
    expectRefused("isolation", "an intent of one owner in another owner's group", await transact(db.admin, [groupStep(foreignIntent), intentStep(foreignIntent, { owner: ownerB })]), 1, {
      constraint: "checkout_intents_group_owner_fkey",
    });

    const foreignQuote = freshIds(ownerA);
    expectRefused(
      "isolation",
      "a quote of one owner for another owner's intent",
      await transact(db.admin, [groupStep(foreignQuote), intentStep(foreignQuote), quoteStep(foreignQuote, line, { owner: ownerB })]),
      2,
      { constraint: "quotes_intent_owner_fkey" },
    );

    const committed = await createRoot(ownerA);
    expectRefused("isolation", "a challenge of one owner for another owner's quote", await one(challengeStep(newId("cf"), committed, { owner: ownerB })), 0, {
      constraint: "confirmation_challenges_quote_intent_owner_fkey",
    });
    expect(await rowsOf(foreignIntent)).toBe(0);
    expect(await rowsOf(foreignQuote)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // PGT-149, PGT-150: the confirmation pointer and the challenge table
  // -------------------------------------------------------------------------

  it("PGT-149: the confirmation pointer accepts only a consumed challenge of the same intent and owner, is set whole, and never changes afterwards", async () => {
    const target = await createRoot(ownerA);
    const own = await createChallenge(target);
    const sibling = await createRoot(ownerA);
    const siblingConsumed = await createChallenge(sibling, "CONSUMED");
    const stranger = await createRoot(ownerB);
    const strangerConsumed = await createChallenge(stranger, "CONSUMED");

    const quotedRow = await intentRow(target.intent);
    const CONSUMED_MATCH = { message: "consumed challenge of this intent" };
    expectRefused("PGT-149", "a challenge that is not consumed", await change(target, confirmStep(target.intent, own)), AFTER_LOCKS, CONSUMED_MATCH);
    expectRefused("PGT-149", "a challenge of another intent", await change(target, confirmStep(target.intent, siblingConsumed)), AFTER_LOCKS, CONSUMED_MATCH);
    expectRefused("PGT-149", "a challenge of another owner", await change(target, confirmStep(target.intent, strangerConsumed)), AFTER_LOCKS, CONSUMED_MATCH);
    expectRefused("PGT-149", "a challenge that does not exist", await change(target, confirmStep(target.intent, newId("cf"))), AFTER_LOCKS, CONSUMED_MATCH);
    expect(await intentRow(target.intent)).toEqual(quotedRow);

    // The intent's own challenge is consumed. From here a correct confirmation would be accepted, so the two malformed
    // pairs below are refused for being malformed and for nothing else.
    await must("own challenge consumed", withLocks(target, [challengeStatusStep(own, "CONSUMED")]));

    // The table also carries a CHECK that the pointer and its status are both NULL or both set. The trigger runs
    // before that CHECK and refuses the same rows, so the trigger is what answers each case below; the CHECK is the
    // second line and is asserted to exist.
    const pairCheck = await db.admin.query(
      `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS definition
         FROM pg_catalog.pg_constraint c
         JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'shopaccess' AND t.relname = 'checkout_intents' AND c.conname = 'checkout_intents_confirmation_pair_check' AND c.contype = 'c'`,
    );
    expect(pairCheck.rows).toHaveLength(1);
    for (const fragment of ["confirmation_id IS NULL", "confirmation_status IS NULL", "confirmation_id IS NOT NULL", "confirmation_status IS NOT NULL", "'CONSUMED'"]) {
      expect(String(pairCheck.rows[0].definition), fragment).toContain(fragment);
    }

    // Malformed pairs at the moment of confirmation: one half of the pointer without the other.
    const SET_ONCE = { message: "confirmation pointer is set once" };
    expectRefused("PGT-149", "confirmation with a status and no challenge id", await change(target, ["confirmIntentWithoutId", [target.intent, T_LATER]]), AFTER_LOCKS, SET_ONCE);
    expect(await intentRow(target.intent)).toEqual(quotedRow);
    expectRefused("PGT-149", "confirmation with a challenge id and no status", await change(target, ["confirmIntentWithoutStatus", [target.intent, own, T_LATER]]), AFTER_LOCKS, SET_ONCE);
    expect(await intentRow(target.intent)).toEqual(quotedRow);

    // The same intent, with its own consumed challenge and both halves of the pointer, is confirmed.
    await must("confirmation with the consumed challenge", withLocks(target, [confirmStep(target.intent, own), transitionStep(target.intent, "T2", 2)]));
    const confirmedRow = await intentRow(target.intent);
    expect(confirmedRow).toMatchObject({ state: "USER_CONFIRMED", row_version: 3, confirmation_id: own, confirmation_status: "CONSUMED" });

    // After it is set, the pointer does not change, is not cleared, and cannot lose one half.
    const POINTER_FIXED = { message: "confirmation pointer changes only" };
    expectRefused("PGT-149", "the pointer changed after being set", await change(target, ["cancelIntentChangingConfirmation", [target.intent, siblingConsumed, T_LATER]]), AFTER_LOCKS, POINTER_FIXED);
    expectRefused("PGT-149", "the pointer cleared after being set", await change(target, ["cancelIntentClearingConfirmation", [target.intent, T_LATER]]), AFTER_LOCKS, POINTER_FIXED);
    expect(await intentRow(target.intent)).toEqual(confirmedRow);
    expectRefused("PGT-149", "the challenge id dropped, the status kept", await change(target, ["cancelIntentDroppingConfirmationId", [target.intent, T_LATER]]), AFTER_LOCKS, POINTER_FIXED);
    expect(await intentRow(target.intent)).toEqual(confirmedRow);
    expectRefused("PGT-149", "the status dropped, the challenge id kept", await change(target, ["cancelIntentDroppingConfirmationStatus", [target.intent, T_LATER]]), AFTER_LOCKS, POINTER_FIXED);
    expect(await intentRow(target.intent)).toEqual(confirmedRow);
  });

  it("PGT-150: a challenge is inserted ACTIVE, leaves ACTIVE once, keeps its binding columns, and is never deleted or truncated", async () => {
    const ids = await createRoot(ownerA);
    // One challenge in each of the four statuses, made one after another on the same quote.
    const superseded = await createChallenge(ids, "SUPERSEDED");
    const expired = await createChallenge(ids, "EXPIRED");
    const consumed = await createChallenge(ids, "CONSUMED");
    const active = await createChallenge(ids);

    const all: Array<[string, string]> = [
      ["ACTIVE", active],
      ["CONSUMED", consumed],
      ["SUPERSEDED", superseded],
      ["EXPIRED", expired],
    ];
    const rowsNow = async () =>
      (await db.admin.query("SELECT c::text AS row FROM shopaccess.confirmation_challenges c WHERE c.quote_id = $1 ORDER BY c.id", [ids.quote])).rows.map((row) => row.row);
    const before = await rowsNow();
    expect(before).toHaveLength(4);

    // Illegal status changes: anything from a terminal status, and ACTIVE to ACTIVE.
    const ILLEGAL = { message: "illegal confirmation challenge status change" };
    for (const [from, challenge] of all) {
      for (const to of ["ACTIVE", "CONSUMED", "SUPERSEDED", "EXPIRED"]) {
        if (from === "ACTIVE" && to !== "ACTIVE") continue;
        expectRefused("PGT-150", `challenge ${from} to ${to}`, await change(ids, ["setChallengeStatus", [challenge, to]]), AFTER_LOCKS, ILLEGAL);
      }
    }

    // Insert with a terminal status. A new row: nothing existing is changed, so nothing is locked.
    for (const status of ["CONSUMED", "SUPERSEDED", "EXPIRED"]) {
      const outcome = await one(challengeStep(newId("cf"), ids, { status, consumedAt: status === "CONSUMED" ? T_CONSUMED : null }));
      expectRefused("PGT-150", `challenge inserted as ${status}`, outcome, 0, { message: "inserted as ACTIVE" });
    }

    // A binding column changed, in the one update that is otherwise allowed.
    const BINDING = { message: "binding columns are immutable" };
    const bindingChanges: Array<[string, SqlKey, unknown]> = [
      ["quote_digest", "consumeChallengeChangingQuoteDigest", hex(32)],
      ["nonce_digest", "consumeChallengeChangingNonceDigest", hex(32)],
      ["expires_at", "consumeChallengeChangingExpiresAt", "2026-01-01T00:12:00.000Z"],
      ["issued_at", "consumeChallengeChangingIssuedAt", "2026-01-01T00:00:30.000Z"],
      ["summary", "consumeChallengeChangingSummary", '{"changed":true}'],
      ["owner_id", "consumeChallengeChangingOwner", ownerB],
    ];
    for (const [column, statement, value] of bindingChanges) {
      expectRefused("PGT-150", `binding column ${column} changed`, await change(ids, [statement, [active, T_CONSUMED, value]]), AFTER_LOCKS, BINDING);
    }

    // DELETE in each of the four statuses.
    for (const [status, challenge] of all) {
      expectRefused("PGT-150", `delete of a ${status} challenge`, await change(ids, ["deleteChallenge", [challenge]]), AFTER_LOCKS, { message: "DELETE is not permitted on confirmation_challenges" });
    }

    // TRUNCATE, refused by one of the two protections of the table. Which one is recorded and not assumed (see PGT-158).
    for (const statement of ["truncate confirmation_challenges", "truncate cascade confirmation_challenges"] as const) {
      expectTruncateRefused("PGT-150", statement, ["confirmation_challenges"], await one([statement]));
    }
    expect(await rowsNow()).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // PGT-152: the throttle table, as the test owner
  // -------------------------------------------------------------------------

  it("PGT-152 (schema part): the throttle table enforces its bounds, keeps its owner, and is never deleted from or truncated", async () => {
    const owner = await newOwner();
    await must("request window", [windowStep(owner, { calls: 1, throttled: 0, total: 0 })]);
    // A request window belongs to an owner and to no intent, so a change to it is made under the owner lock alone.
    const underOwnerLock = (step: Step): Promise<Outcome> => transact(db.admin, [lockOwnerStep(owner), step]);
    const AFTER_OWNER_LOCK = 1;
    // An ordinary counter update is allowed; the boundary values 0 and 30 are stored.
    expect(await underOwnerLock(["updateWindowCounters", [owner, T_LATER]]), "counter update").toEqual({ at: null, refusal: null });
    const boundary = await newOwner();
    await must("request window with no calls", [windowStep(boundary, { calls: 0, throttled: 0, total: 0 })]);
    const windows = async () => (await db.admin.query("SELECT w::text AS row FROM shopaccess.owner_request_windows w WHERE w.owner_id = ANY($1::text[]) ORDER BY w.owner_id", [[owner, boundary]])).rows;
    const before = await windows();
    expect(before).toHaveLength(2);

    const bounds: Array<[string, { calls: number; throttled: number; total: number; updatedAt?: string }, string]> = [
      ["31 calls", { calls: 31, throttled: 0, total: 0 }, "owner_request_windows_window_calls_check"],
      ["-1 calls", { calls: -1, throttled: 0, total: 0 }, "owner_request_windows_window_calls_check"],
      ["a negative throttled count", { calls: 1, throttled: -1, total: 0 }, "owner_request_windows_window_throttled_check"],
      ["a total below the window's count", { calls: 1, throttled: 3, total: 2 }, "owner_request_windows_total_throttled_check"],
      ["an update time before the window start", { calls: 1, throttled: 0, total: 0, updatedAt: T_CREATED }, "owner_request_windows_updated_at_check"],
    ];
    for (const [what, counters, constraint] of bounds) {
      const other = await newOwner();
      expectRefused("PGT-152", what, await one(windowStep(other, counters)), 0, { constraint });
    }
    expectRefused("PGT-152", "an update to 31 calls", await underOwnerLock(["setWindowCallsBeyondLimit", [owner]]), AFTER_OWNER_LOCK, { constraint: "owner_request_windows_window_calls_check" });
    expectRefused("PGT-152", "a window for an owner that does not exist", await one(windowStep(newId("own"), { calls: 1, throttled: 0, total: 0 })), 0, { constraint: "owner_request_windows_owner_fkey" });
    expectRefused("PGT-152", "a second window for one owner", await one(windowStep(owner, { calls: 1, throttled: 0, total: 0 })), 0, { constraint: "owner_request_windows_pkey" });

    // A change of owner_id, by trigger, as the test owner. The refusal by privilege, as the function owner, needs the
    // column grant of the functions migration and is not here.
    const elsewhere = await newOwner();
    expectRefused("PGT-152", "a change of owner_id", await underOwnerLock(["changeWindowOwner", [owner, elsewhere]]), AFTER_OWNER_LOCK, { message: "owner of a request window is immutable" });
    expectRefused("PGT-152", "a delete", await underOwnerLock(["deleteWindow", [owner]]), AFTER_OWNER_LOCK, { message: "DELETE is not permitted on owner_request_windows" });
    for (const statement of ["truncate owner_request_windows", "truncate cascade owner_request_windows"] as const) {
      expectTruncateRefused("PGT-152", statement, ["owner_request_windows"], await one([statement]));
    }
    expect(await windows()).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // PGT-158: privileged TRUNCATE. Kept last: if a protection were missing, the rows of this disposable database
  // would be gone, and no later test in this file depends on them.
  // -------------------------------------------------------------------------

  it("PGT-158: every TRUNCATE of the seven tables is refused for the table owner and for the test owner, and no row changes", async () => {
    // A complete, valid, committed fixture with a row in each of the seven tables: group, intent, quote, item, first
    // transition, an ACTIVE challenge under the ACTIVE nonce key version, and a request window.
    const owner = await newOwner();
    const ids = await createRoot(owner);
    await createChallenge(ids);
    await must("request window", [windowStep(owner, { calls: 1, throttled: 0, total: 0 })]);

    const before = await snapshot();
    for (const table of SEVEN_TABLES) expect(before[table].rows, table).toBeGreaterThan(0);
    expect(TRUNCATE_ATTEMPTS).toHaveLength(22);

    interface Attempt {
      readonly role: string;
      readonly statement: string;
      readonly outcome: Outcome;
      readonly mechanism: TruncateMechanism | null;
    }
    /**
     * Attempts all 22 statements, each in a transaction of its own, and only collects what happened. A statement that
     * is refused is rolled back, so the next one starts clean. A statement that is not refused is committed and stays
     * committed: it shows up below as a success and as a changed snapshot. Nothing is asserted here.
     */
    const attemptAll = async (role: string): Promise<Attempt[]> => {
      const attempts: Attempt[] = [];
      for (const { statement, tables } of TRUNCATE_ATTEMPTS) {
        const outcome = await one([statement]);
        attempts.push({ role, statement, outcome, mechanism: truncateMechanism(outcome.refusal, tables) });
      }
      return attempts;
    };

    // Both roles are attempted, and both snapshots taken, before anything is asserted: a failed expectation about the
    // first role cannot keep the second role from being tried.
    let asTableOwner: Attempt[];
    await db.admin.query(SQL.setRoleOwner);
    try {
      asTableOwner = await attemptAll("table owner");
    } finally {
      await db.admin.query(SQL.resetRole);
    }
    const afterTableOwner = await snapshot();
    const asTestOwner = await attemptAll("test owner");
    const afterTestOwner = await snapshot();

    const attempts = [...asTableOwner, ...asTestOwner];
    for (const { role, statement, outcome, mechanism } of attempts) {
      evidence.push({ pgt: "PGT-158", role, statement, at: outcome.at, sqlstate: outcome.refusal?.code ?? null, mechanism, message: outcome.refusal?.message ?? null, detail: outcome.refusal?.detail ?? null });
    }
    const describeAttempt = ({ role, statement, outcome }: Attempt): string => `${role}: ${statement}: ${outcome.refusal?.code ?? "no error"} ${outcome.refusal?.message ?? ""}`;

    expect(attempts).toHaveLength(44);
    // No statement succeeded.
    expect(attempts.filter(({ outcome }) => outcome.refusal === null).map(describeAttempt)).toEqual([]);
    // Every refusal came at the TRUNCATE itself, not at BEGIN and not at COMMIT.
    expect(attempts.filter(({ outcome }) => outcome.at !== 0).map(describeAttempt)).toEqual([]);
    // Every refusal was made by the table's own trigger or by the foreign-key rule. Any other error is not a refusal
    // by the schema: a timeout, a cancellation, a lock, a missing privilege or a malformed statement would be listed here.
    expect(attempts.filter(({ mechanism }) => mechanism === null).map(describeAttempt)).toEqual([]);
    // Not one row of any of the seven tables was removed or altered, by either role.
    expect(afterTableOwner).toEqual(before);
    expect(afterTestOwner).toEqual(before);
  });
});
