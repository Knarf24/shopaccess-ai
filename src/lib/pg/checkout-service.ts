import { constantTimeEqual } from "../shared/crypto";
import type { IdGenerator } from "../shared/ids";
import type { PgQueryable } from "./client";
import { confirmationNonceDigest, deriveConfirmationNonce } from "./confirmation-nonce";
import { KeyRing, loadKeyState, type KeyState } from "./key-ring";
import type { PgSessionCredential } from "./session-service";
import { CHECKOUT_STATEMENTS } from "./statements";

/**
 * PostgreSQL checkout service (specification 19.19, Increment 2.3).
 *
 * NEVER RUN AGAINST A DATABASE. Typed calls of the six checkout entry points of migrations 0008 and 0009, and the
 * strict reading of what they return. This module holds no statement text: every statement is taken from the
 * reviewed catalogue.
 *
 * Rules this module keeps:
 *  - every call is sent exactly once. Nothing here is re-run: not after a lock timeout, not after a lost
 *    connection, not after an unexpected row. What a failed call did is for the caller to treat as unknown;
 *  - the first two values of every call are the session credential, which the caller obtained from the session
 *    service and passes straight through;
 *  - a row that is not exactly as the entry point is defined to return is refused whole: an UnexpectedRowError
 *    names the field, never the value, and nothing of that row is handed on;
 *  - the confirmation nonce is derived here, with a key lent by the configured ring, and only its digest is sent
 *    to issue_challenge.
 */

/** A database row that is not what its entry point returns. Carries the name of the field, never its value. */
export class UnexpectedRowError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`A database row was not as expected: ${field}`);
    this.name = "UnexpectedRowError";
    this.field = field;
  }
}

export const STORED_STATES = ["QUOTED", "USER_CONFIRMED", "SUPERSEDED", "CANCELED_LOCAL", "EXPIRED"] as const;
export type StoredState = (typeof STORED_STATES)[number];
export type EffectiveStatus = StoredState | "QUOTE_EXPIRED";

/** Bounds of the amount columns, as the tables of migration 0007 constrain them. */
export const UNIT_AMOUNT_MAX_CENTS = 2_000_000;
export const QUOTE_AMOUNT_MAX_CENTS = 20_000_000;
export const QUANTITY_MAX = 10;

const OWNER_ID = /^own_[0-9a-f]{32}$/;
const INTENT_ID = /^ci_[0-9a-f]{32}$/;
const GROUP_ID = /^pur_[0-9a-f]{32}$/;
const QUOTE_ID = /^qt_[0-9a-f]{32}$/;
const CHALLENGE_ID = /^cf_[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MERCHANT_ID = /^dmm_[a-z0-9]{6,24}$/;
const PRODUCT_ID = /^dmp_[a-z0-9]{6,24}$/;
const VARIANT_ID = /^dmv_[a-z0-9]{6,24}$/;
const UNIT_AMOUNT_TEXT = /^[1-9][0-9]{0,6}$/;
const QUOTE_AMOUNT_TEXT = /^[1-9][0-9]{0,7}$/;

type Row = Record<string, unknown>;

function oneRow(rows: readonly unknown[], what: string): Row {
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) throw new UnexpectedRowError(`${what}: row count`);
  return rows[0] as Row;
}

function text(row: Row, field: string, pattern?: RegExp): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0 || value.length > 1000) throw new UnexpectedRowError(field);
  if (pattern && !pattern.test(value)) throw new UnexpectedRowError(field);
  return value;
}

function optionalText(row: Row, field: string, pattern: RegExp): string | null {
  return row[field] === null ? null : text(row, field, pattern);
}

function integer(row: Row, field: string, minimum: number, maximum: number): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new UnexpectedRowError(field);
  return value;
}

function date(row: Row, field: string): Date {
  const value = row[field];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new UnexpectedRowError(field);
  return value;
}

function flag(row: Row, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") throw new UnexpectedRowError(field);
  return value;
}

function oneOf<T extends string>(row: Row, field: string, allowed: readonly T[]): T {
  const value = row[field];
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new UnexpectedRowError(field);
  return found;
}

/**
 * One amount column. The driver hands a bigint over as text, and only text is accepted: a number, a bigint, null or
 * anything else is refused, and so is text with a sign, a leading zero, an exponent, a space or a decimal point.
 * The text is checked first and the range second; the value is converted only after both.
 */
function amount(row: Row, field: string, form: RegExp, maximum: number): number {
  const value = row[field];
  if (typeof value !== "string" || !form.test(value)) throw new UnexpectedRowError(field);
  const cents = Number(value);
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > maximum) throw new UnexpectedRowError(field);
  return cents;
}

/** A column that the quote table constrains to zero: only the text "0" is accepted. */
function zeroAmount(row: Row, field: string): 0 {
  if (row[field] !== "0") throw new UnexpectedRowError(field);
  return 0;
}

export interface CheckoutAmounts {
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly subtotalCents: number;
  readonly discountCents: 0;
  readonly taxCents: 0;
  readonly shippingCents: 0;
  readonly totalCents: number;
}

/**
 * The quantity and the six amount columns of a read_checkout row. Order: type and text form, then range, then the
 * two arithmetic rules. The first field that fails is the one named.
 */
export function decodeCheckoutAmounts(row: Record<string, unknown>): CheckoutAmounts {
  const quantity = integer(row, "quantity", 1, QUANTITY_MAX);
  const unitAmountCents = amount(row, "unit_amount_cents", UNIT_AMOUNT_TEXT, UNIT_AMOUNT_MAX_CENTS);
  const subtotalCents = amount(row, "subtotal_cents", QUOTE_AMOUNT_TEXT, QUOTE_AMOUNT_MAX_CENTS);
  const discountCents = zeroAmount(row, "discount_cents");
  const taxCents = zeroAmount(row, "tax_cents");
  const shippingCents = zeroAmount(row, "shipping_cents");
  const totalCents = amount(row, "total_cents", QUOTE_AMOUNT_TEXT, QUOTE_AMOUNT_MAX_CENTS);
  if (subtotalCents !== unitAmountCents * quantity) throw new UnexpectedRowError("subtotal_cents: arithmetic");
  if (totalCents !== subtotalCents) throw new UnexpectedRowError("total_cents: arithmetic");
  return { quantity, unitAmountCents, subtotalCents, discountCents, taxCents, shippingCents, totalCents };
}

/** What a challenge says the shopper is asked to confirm: the six keys issue_challenge writes, and no other. */
export interface ChallengeSummary {
  readonly merchantName: string;
  readonly productTitle: string;
  readonly variantLabel: string;
  readonly quantity: number;
  readonly currency: "USD";
  readonly totalCents: number;
}

const SUMMARY_KEYS = ["currency", "merchantName", "productTitle", "quantity", "totalCents", "variantLabel"];

function summary(value: unknown, field: string): ChallengeSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UnexpectedRowError(field);
  const record = value as Row;
  if (Object.keys(record).sort().join(",") !== SUMMARY_KEYS.join(",")) throw new UnexpectedRowError(field);
  for (const key of ["merchantName", "productTitle", "variantLabel"]) {
    const part = record[key];
    if (typeof part !== "string" || part.length === 0 || part.length > 200) throw new UnexpectedRowError(field);
  }
  const quantity = record.quantity;
  const totalCents = record.totalCents;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > QUANTITY_MAX) throw new UnexpectedRowError(field);
  if (typeof totalCents !== "number" || !Number.isInteger(totalCents) || totalCents < 1 || totalCents > QUOTE_AMOUNT_MAX_CENTS) throw new UnexpectedRowError(field);
  if (record.currency !== "USD") throw new UnexpectedRowError(field);
  return {
    merchantName: record.merchantName as string,
    productTitle: record.productTitle as string,
    variantLabel: record.variantLabel as string,
    quantity,
    currency: "USD",
    totalCents,
  };
}

/** The ACTIVE challenge of a checkout's quote, as read_checkout reports it. */
export interface CheckoutChallenge {
  readonly id: string;
  readonly quoteDigest: string;
  readonly nonceKeyVersion: number;
  readonly nonceDigest: string;
  readonly summary: ChallengeSummary;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/** One checkout of the session's own owner: the 41 columns of read_checkout, read strictly. */
export interface CheckoutRead extends CheckoutAmounts {
  readonly ownerId: string;
  readonly intentId: string;
  readonly purchaseGroupId: string;
  readonly storedState: StoredState;
  readonly rowVersion: number;
  readonly effectiveStatus: EffectiveStatus;
  readonly replacesIntentId: string | null;
  readonly supersededByIntentId: string | null;
  readonly intentCreatedAt: Date;
  readonly intentUpdatedAt: Date;
  readonly quoteId: string;
  readonly merchantId: string;
  readonly merchantDisplayName: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly variantId: string;
  readonly variantLabel: string;
  readonly currency: "USD";
  readonly assumptionsCode: string;
  readonly catalogRevision: number;
  readonly quoteDigest: string;
  readonly quoteCreatedAt: Date;
  readonly quoteExpiresAt: Date;
  readonly quoteStale: boolean;
  readonly databaseTime: Date;
  /** The quote's ACTIVE challenge, or null. A consumed, superseded or expired challenge is never reported. */
  readonly challenge: CheckoutChallenge | null;
  /** The database's own answer to "could this challenge be confirmed now". False when there is none. */
  readonly challengeUsable: boolean;
}

export type CheckoutReadResult = { readonly authorized: false } | { readonly authorized: true; readonly checkout: CheckoutRead };

const CHALLENGE_COLUMNS = [
  "challenge_id",
  "challenge_quote_digest",
  "challenge_nonce_key_version",
  "challenge_nonce_digest",
  "challenge_summary",
  "challenge_issued_at",
  "challenge_expires_at",
];

function decodeChallenge(row: Row): CheckoutChallenge | null {
  if (row.challenge_id === null) {
    for (const column of CHALLENGE_COLUMNS) if (row[column] !== null) throw new UnexpectedRowError(column);
    return null;
  }
  return {
    id: text(row, "challenge_id", CHALLENGE_ID),
    quoteDigest: text(row, "challenge_quote_digest", DIGEST),
    nonceKeyVersion: integer(row, "challenge_nonce_key_version", 1, 32_767),
    nonceDigest: text(row, "challenge_nonce_digest", DIGEST),
    summary: summary(row.challenge_summary, "challenge_summary"),
    issuedAt: date(row, "challenge_issued_at"),
    expiresAt: date(row, "challenge_expires_at"),
  };
}

/** The forty columns of read_checkout after `result`, in the order the function returns them. */
export const READ_CHECKOUT_DATA_COLUMNS = [
  "owner_id",
  "intent_id",
  "purchase_group_id",
  "stored_state",
  "row_version",
  "effective_status",
  "replaces_intent_id",
  "superseded_by_intent_id",
  "intent_created_at",
  "intent_updated_at",
  "quote_id",
  "merchant_id",
  "merchant_display_name",
  "product_id",
  "product_title",
  "variant_id",
  "variant_label",
  "quantity",
  "unit_amount_cents",
  "subtotal_cents",
  "discount_cents",
  "tax_cents",
  "shipping_cents",
  "total_cents",
  "currency",
  "assumptions_code",
  "catalog_revision",
  "quote_digest",
  "quote_created_at",
  "quote_expires_at",
  "quote_stale",
  "database_time",
  "challenge_id",
  "challenge_quote_digest",
  "challenge_nonce_key_version",
  "challenge_nonce_digest",
  "challenge_summary",
  "challenge_issued_at",
  "challenge_expires_at",
  "challenge_usable",
] as const;

/** The six columns of issue_challenge after `result`: present for ISSUED and REUSED, and NULL for every other result. */
export const ISSUE_CHALLENGE_DATA_COLUMNS = ["challenge_id", "quote_digest", "nonce_key_version", "nonce_digest", "summary", "expires_at"] as const;

/** The three columns of start_checkout after `result`: present for STARTED, and NULL for every refusal. */
export const START_CHECKOUT_DATA_COLUMNS = ["intent_id", "quote_id", "quote_expires_at"] as const;

/** Requires each named column to be present and NULL: a refusal carries nothing. The first that is not is named. */
function requireNull(row: Row, columns: readonly string[]): void {
  for (const column of columns) if (row[column] !== null) throw new UnexpectedRowError(column);
}

/** Reads one read_checkout row. Throws UnexpectedRowError for anything that is not exactly as defined. */
export function decodeCheckoutRead(row: Record<string, unknown>): CheckoutReadResult {
  const result = oneOf(row, "result", ["OK", "NOT_AUTHORIZED"] as const);
  if (result === "NOT_AUTHORIZED") {
    // The function answers NOT_AUTHORIZED with every other column NULL. A row that says "not authorized" and
    // carries anything else is not that answer, and is not read as one.
    requireNull(row, READ_CHECKOUT_DATA_COLUMNS);
    return { authorized: false };
  }
  const amounts = decodeCheckoutAmounts(row);
  const challenge = decodeChallenge(row);
  const challengeUsable = flag(row, "challenge_usable");
  if (challengeUsable && challenge === null) throw new UnexpectedRowError("challenge_usable");
  if (row.currency !== "USD") throw new UnexpectedRowError("currency");
  const checkout: CheckoutRead = {
    ...amounts,
    ownerId: text(row, "owner_id", OWNER_ID),
    intentId: text(row, "intent_id", INTENT_ID),
    purchaseGroupId: text(row, "purchase_group_id", GROUP_ID),
    storedState: oneOf(row, "stored_state", STORED_STATES),
    rowVersion: integer(row, "row_version", 2, 2_147_483_647),
    effectiveStatus: oneOf(row, "effective_status", [...STORED_STATES, "QUOTE_EXPIRED"] as const),
    replacesIntentId: optionalText(row, "replaces_intent_id", INTENT_ID),
    supersededByIntentId: optionalText(row, "superseded_by_intent_id", INTENT_ID),
    intentCreatedAt: date(row, "intent_created_at"),
    intentUpdatedAt: date(row, "intent_updated_at"),
    quoteId: text(row, "quote_id", QUOTE_ID),
    merchantId: text(row, "merchant_id", MERCHANT_ID),
    merchantDisplayName: text(row, "merchant_display_name"),
    productId: text(row, "product_id", PRODUCT_ID),
    productTitle: text(row, "product_title"),
    variantId: text(row, "variant_id", VARIANT_ID),
    variantLabel: text(row, "variant_label"),
    currency: "USD",
    assumptionsCode: text(row, "assumptions_code"),
    catalogRevision: integer(row, "catalog_revision", 1, 2_147_483_647),
    quoteDigest: text(row, "quote_digest", DIGEST),
    quoteCreatedAt: date(row, "quote_created_at"),
    quoteExpiresAt: date(row, "quote_expires_at"),
    quoteStale: flag(row, "quote_stale"),
    databaseTime: date(row, "database_time"),
    challenge,
    challengeUsable,
  };
  // The ACTIVE challenge is the challenge of this quote: the same summary, and an expiry no later than the quote's.
  // A row in which the two disagree is refused whole, so that an inconsistent summary is never shown or acted on.
  if (challenge) requireChallengeOfQuote(challenge.summary, challenge.expiresAt, checkout, "challenge_summary", "challenge_expires_at");
  return { authorized: true, checkout };
}

export interface StartInput {
  readonly productId: string;
  readonly variantId: string;
  readonly quantity: number;
  /** The checkout this one replaces, or null for a new purchase group. */
  readonly replacesIntentId: string | null;
}

export const START_REFUSALS = [
  "NOT_AUTHORIZED",
  "REQUEST_INVALID",
  "RATE_LIMITED",
  "REPLACEMENT_NOT_ALLOWED",
  "PRODUCT_NOT_IN_MERCHANT_CATALOG",
  "VARIANT_UNAVAILABLE",
  "QUANTITY_EXCEEDS_LIMIT",
  "AMOUNT_OUT_OF_RANGE",
  "AT_PURCHASE_CAPACITY",
  "GROUP_INTENT_LIMIT",
] as const;
export type StartRefusal = (typeof START_REFUSALS)[number];

export type StartResult =
  | { readonly result: "STARTED"; readonly intentId: string; readonly quoteId: string; readonly quoteExpiresAt: Date }
  | { readonly result: StartRefusal };

export const CANCEL_RESULTS = ["CANCELED", "NOT_CANCELABLE", "NOT_AUTHORIZED", "RATE_LIMITED", "REQUEST_INVALID"] as const;
export type CancelResult = (typeof CANCEL_RESULTS)[number];

export const ISSUE_REFUSALS = [
  "NOT_AUTHORIZED",
  "REQUEST_INVALID",
  "RATE_LIMITED",
  "INTENT_NOT_AWAITING_CONFIRMATION",
  "QUOTE_EXPIRED",
  "QUOTE_STALE_CATALOG",
  "QUOTE_DIGEST_MISMATCH",
  "CONFIRMATION_ALREADY_USED",
  "CHALLENGE_LIMIT_REACHED",
] as const;
export type IssueRefusal = (typeof ISSUE_REFUSALS)[number];

/**
 * What one request for a challenge came to.
 *  - READY: the quote has an ACTIVE challenge that this process can show: newly issued, or an existing one whose
 *    nonce this process derived again and checked against the stored digest.
 *  - NOT_READY: no challenge can be shown now, and the database refused nothing the shopper can act on.
 *  - REFUSED: a business refusal of the database, as it reported it.
 */
export type IssueOutcome =
  | { readonly outcome: "READY"; readonly result: "ISSUED" | "REUSED"; readonly challengeId: string }
  | { readonly outcome: "NOT_READY"; readonly reason: "KEY_UNAVAILABLE" | "KEY_NOT_ACTIVE" | "ID_REFUSED" | "REUSED_NOT_DERIVABLE" }
  | { readonly outcome: "REFUSED"; readonly result: IssueRefusal };

export interface IssueInput {
  /** The intent the challenge is asked for. It must be the intent of `checkout`. */
  readonly intentId: string;
  /**
   * The checkout as an authorized read_checkout row of this session just showed it. It is the trusted context of
   * the call: the owner id and the stored quote digest the nonce is derived from, and the quote a returned
   * challenge is held against. It is never built from a submitted form.
   */
  readonly checkout: CheckoutRead;
}

export const CONSUME_RESULTS = [
  "CONFIRMED",
  "NOT_AUTHORIZED",
  "REQUEST_INVALID",
  "CONFIRMATION_NOT_FOUND",
  "RATE_LIMITED",
  "CONFIRMATION_SUPERSEDED",
  "CONFIRMATION_ALREADY_USED",
  "CONFIRMATION_KEY_REVOKED",
  "CONFIRMATION_MISMATCH",
  "CONFIRMATION_EXPIRED",
  "QUOTE_DIGEST_MISMATCH",
  "QUOTE_EXPIRED",
  "QUOTE_STALE_CATALOG",
  "INTENT_NOT_AWAITING_CONFIRMATION",
] as const;
export type ConsumeRefusal = Exclude<(typeof CONSUME_RESULTS)[number], "CONFIRMED">;

export type ConsumeResult = { readonly result: "CONFIRMED"; readonly intentId: string } | { readonly result: ConsumeRefusal };

export interface ConsumeInput {
  readonly challengeId: string;
  readonly nonce: string;
  readonly quoteId: string;
  readonly quoteDigest: string;
}

export interface OwnerCheckout {
  readonly intentId: string;
  readonly purchaseGroupId: string;
  readonly storedState: StoredState;
  readonly effectiveStatus: EffectiveStatus;
  readonly createdAt: Date;
  readonly quoteExpiresAt: Date;
}

/** What a challenge is held against: the quote of the checkout, as an authorized read reported it. */
interface QuoteSnapshot {
  readonly merchantDisplayName: string;
  readonly productTitle: string;
  readonly variantLabel: string;
  readonly quantity: number;
  readonly currency: "USD";
  readonly totalCents: number;
  readonly quoteExpiresAt: Date;
}

/**
 * A challenge belongs to its quote: its summary is the quote's own seller, item, quantity, currency and total,
 * and it does not outlive the quote. One rule, used wherever a challenge is read: for the ISSUED and REUSED rows
 * of issue_challenge, and for the ACTIVE challenge that read_checkout reports beside its quote.
 *
 * Nothing here is compared with this process's clock. An expiry that has passed is a valid answer; whether the
 * challenge can still be used is the database's to decide.
 */
function requireChallengeOfQuote(stored: ChallengeSummary, expiresAt: Date, quote: QuoteSnapshot, summaryField: string, expiryField: string): void {
  if (
    stored.merchantName !== quote.merchantDisplayName ||
    stored.productTitle !== quote.productTitle ||
    stored.variantLabel !== quote.variantLabel ||
    stored.quantity !== quote.quantity ||
    stored.currency !== quote.currency ||
    stored.totalCents !== quote.totalCents
  ) {
    throw new UnexpectedRowError(summaryField);
  }
  if (expiresAt.getTime() > quote.quoteExpiresAt.getTime()) throw new UnexpectedRowError(expiryField);
}

/** The six data columns of an ISSUED or REUSED row, read completely. */
export interface IssuedChallenge {
  readonly challengeId: string;
  readonly quoteDigest: string;
  readonly nonceKeyVersion: number;
  readonly nonceDigest: string;
  readonly summary: ChallengeSummary;
  readonly expiresAt: Date;
}

/**
 * Reads the six data columns of an ISSUED or REUSED row of issue_challenge and holds them against the contract.
 *
 * Structure: every column present and of its type; the summary has exactly its six keys. Contract, against the
 * trusted checkout and the call: the quote digest is the stored digest of the checkout's quote; the key version is
 * the one this call named, which is the only version the function issues or reuses under; the summary is the
 * checkout's own seller, item, quantity, currency and total; and the challenge does not outlive its quote.
 *
 * Whether the challenge can still be used is not decided here. A challenge whose expiry has passed while the
 * answer travelled is a valid answer; usability is the database's to decide, at read_checkout and at
 * consume_challenge. Nothing here compares a time with this process's clock.
 */
export function decodeIssuedChallenge(row: Record<string, unknown>, checkout: CheckoutRead, namedKeyVersion: number): IssuedChallenge {
  const challengeId = text(row, "challenge_id", CHALLENGE_ID);
  const quoteDigest = text(row, "quote_digest", DIGEST);
  const nonceKeyVersion = integer(row, "nonce_key_version", 1, 32_767);
  const nonceDigest = text(row, "nonce_digest", DIGEST);
  const stored = summary(row.summary, "summary");
  const expiresAt = date(row, "expires_at");

  if (quoteDigest !== checkout.quoteDigest) throw new UnexpectedRowError("quote_digest");
  if (nonceKeyVersion !== namedKeyVersion) throw new UnexpectedRowError("nonce_key_version");
  requireChallengeOfQuote(stored, expiresAt, checkout, "summary", "expires_at");
  return { challengeId, quoteDigest, nonceKeyVersion, nonceDigest, summary: stored, expiresAt };
}

export const OWNER_CHECKOUT_LIMIT = 100;

export interface PgCheckoutServiceDeps {
  /** Each entry point is one statement, so a single-statement runner (a pool) is sufficient. */
  readonly db: PgQueryable;
  /** The `confirmation_nonce` ring of the configured key rings. Its keys cannot change while the process runs. */
  readonly nonceRing: KeyRing;
  readonly ids: IdGenerator;
}

export interface PgCheckoutService {
  start(credential: PgSessionCredential, input: StartInput): Promise<StartResult>;
  cancel(credential: PgSessionCredential, intentId: string): Promise<CancelResult>;
  read(credential: PgSessionCredential, intentId: string): Promise<CheckoutReadResult>;
  list(credential: PgSessionCredential): Promise<readonly OwnerCheckout[]>;
  issue(credential: PgSessionCredential, input: IssueInput): Promise<IssueOutcome>;
  consume(credential: PgSessionCredential, input: ConsumeInput): Promise<ConsumeResult>;
  /**
   * The nonce of a checkout's ACTIVE challenge, derived again from what the database returned, or null. It is given
   * only when the database calls the challenge usable, the ring holds the challenge's key version, and the derived
   * nonce hashes to the stored digest. Nothing is written and no statement is sent.
   */
  displayNonce(checkout: CheckoutRead): string | null;
}

export function createPgCheckoutService(deps: PgCheckoutServiceDeps): PgCheckoutService {
  const { db, ids } = deps;
  const ring = deps.nonceRing;
  if (KeyRing.purposeOf(ring) !== "confirmation_nonce") throw new TypeError("The checkout service requires the confirmation nonce ring");
  const statements = CHECKOUT_STATEMENTS;

  // Which nonce key version the database calls ACTIVE. Read on first use, and read again only after the database
  // has answered NONCE_KEY_NOT_ACTIVE. A read can show a different version; it can never supply missing key bytes.
  let keyState: KeyState | null = null;
  async function readKeyState(): Promise<KeyState | null> {
    const loaded = await loadKeyState(db, ring);
    keyState = loaded.ok ? loaded.value : null;
    return keyState;
  }

  /** The nonce of one challenge and its digest, under one configured key version; null when the version is not configured. */
  function derive(version: number, challengeId: string, ownerId: string, quoteDigest: string): { nonce: string; nonceDigest: string } | null {
    return ring.useKey(version, (key) => {
      const nonce = deriveConfirmationNonce(key, { challengeId, ownerId, quoteDigest });
      return { nonce, nonceDigest: confirmationNonceDigest(nonce) };
    });
  }

  return {
    async start(credential, input) {
      const reply = await db.query(statements.startCheckout, [
        credential.keyVersion,
        credential.tokenDigest,
        input.productId,
        input.variantId,
        input.quantity,
        input.replacesIntentId,
      ]);
      const row = oneRow(reply.rows, "start_checkout");
      const result = oneOf(row, "result", ["STARTED", ...START_REFUSALS] as const);
      if (result !== "STARTED") {
        // A refusal carries nothing: the three data columns are NULL. A row that names a refusal and carries an
        // intent, a quote or an expiry is an unexpected row, never an ordinary refusal.
        requireNull(row, START_CHECKOUT_DATA_COLUMNS);
        return { result };
      }
      return { result, intentId: text(row, "intent_id", INTENT_ID), quoteId: text(row, "quote_id", QUOTE_ID), quoteExpiresAt: date(row, "quote_expires_at") };
    },

    async cancel(credential, intentId) {
      const reply = await db.query(statements.cancelCheckout, [credential.keyVersion, credential.tokenDigest, intentId]);
      return oneOf(oneRow(reply.rows, "cancel_checkout"), "result", CANCEL_RESULTS);
    },

    async read(credential, intentId) {
      const reply = await db.query(statements.readCheckout, [credential.keyVersion, credential.tokenDigest, intentId]);
      return decodeCheckoutRead(oneRow(reply.rows, "read_checkout"));
    },

    async list(credential) {
      const reply = await db.query(statements.listOwnerCheckouts, [credential.keyVersion, credential.tokenDigest]);
      if (reply.rows.length > OWNER_CHECKOUT_LIMIT) throw new UnexpectedRowError("list_owner_checkouts: row count");
      return reply.rows.map((entry) => {
        if (typeof entry !== "object" || entry === null) throw new UnexpectedRowError("list_owner_checkouts: row");
        const row = entry as Row;
        return {
          intentId: text(row, "intent_id", INTENT_ID),
          purchaseGroupId: text(row, "purchase_group_id", GROUP_ID),
          storedState: oneOf(row, "stored_state", STORED_STATES),
          effectiveStatus: oneOf(row, "effective_status", [...STORED_STATES, "QUOTE_EXPIRED"] as const),
          createdAt: date(row, "intent_created_at"),
          quoteExpiresAt: date(row, "quote_expires_at"),
        };
      });
    },

    async issue(credential, input) {
      const checkout = input.checkout;
      // The trusted row is the row of the intent asked for, or nothing is sent.
      if (checkout.intentId !== input.intentId) throw new UnexpectedRowError("intent_id");
      let state = keyState ?? (await readKeyState());
      if (!state) return { outcome: "NOT_READY", reason: "KEY_UNAVAILABLE" };

      // At most two calls: the second only when the database refused the version this process believed ACTIVE and
      // a new reading names another configured version. Each call that the database admits is counted there.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const version = state.activeVersion;
        const challengeId = ids("confirmation");
        const derived = derive(version, challengeId, checkout.ownerId, checkout.quoteDigest);
        if (!derived) return { outcome: "NOT_READY", reason: "KEY_UNAVAILABLE" };

        const reply = await db.query(statements.issueChallenge, [
          credential.keyVersion,
          credential.tokenDigest,
          input.intentId,
          challengeId,
          version,
          derived.nonceDigest,
        ]);
        const row = oneRow(reply.rows, "issue_challenge");
        const result = oneOf(row, "result", ["ISSUED", "REUSED", "NONCE_KEY_NOT_ACTIVE", "REFUSED", ...ISSUE_REFUSALS] as const);

        if (result === "ISSUED" || result === "REUSED") {
          // Both success rows are read completely and held against the trusted checkout and against what was sent.
          const issued = decodeIssuedChallenge(row, checkout, version);
          if (result === "ISSUED") {
            // A new challenge is the one this call proposed: its id and its nonce digest are the ones sent.
            if (issued.challengeId !== challengeId) throw new UnexpectedRowError("challenge_id");
            if (issued.nonceDigest !== derived.nonceDigest) throw new UnexpectedRowError("nonce_digest");
            return { outcome: "READY", result, challengeId };
          }
          // An existing challenge keeps its own id, which is not the one proposed. It can be shown only if this
          // process derives its nonce again, from the returned id and the trusted owner id and quote digest, and
          // that nonce hashes to the digest the database holds.
          const again = derive(issued.nonceKeyVersion, issued.challengeId, checkout.ownerId, issued.quoteDigest);
          if (!again || !constantTimeEqual(again.nonceDigest, issued.nonceDigest)) return { outcome: "NOT_READY", reason: "REUSED_NOT_DERIVABLE" };
          return { outcome: "READY", result, challengeId: issued.challengeId };
        }
        // Every other result is a refusal, and a refusal carries nothing: all six data columns are NULL. A row
        // that names a refusal and carries a value is an unexpected row, never an ordinary refusal.
        requireNull(row, ISSUE_CHALLENGE_DATA_COLUMNS);
        if (result === "NONCE_KEY_NOT_ACTIVE") {
          if (attempt > 0) return { outcome: "NOT_READY", reason: "KEY_NOT_ACTIVE" };
          const reread = await readKeyState();
          if (!reread || reread.activeVersion === version) return { outcome: "NOT_READY", reason: "KEY_NOT_ACTIVE" };
          state = reread;
          continue;
        }
        // An id that already exists. It is not tried again with another id.
        if (result === "REFUSED") return { outcome: "NOT_READY", reason: "ID_REFUSED" };
        return { outcome: "REFUSED", result };
      }
      return { outcome: "NOT_READY", reason: "KEY_NOT_ACTIVE" };
    },

    async consume(credential, input) {
      const reply = await db.query(statements.consumeChallenge, [
        credential.keyVersion,
        credential.tokenDigest,
        input.challengeId,
        input.nonce,
        input.quoteId,
        input.quoteDigest,
      ]);
      const row = oneRow(reply.rows, "consume_challenge");
      const result = oneOf(row, "result", CONSUME_RESULTS);
      if (result === "CONFIRMED") return { result, intentId: text(row, "intent_id", INTENT_ID) };
      if (row.intent_id !== null) throw new UnexpectedRowError("intent_id");
      return { result };
    },

    displayNonce(checkout) {
      const challenge = checkout.challenge;
      if (!challenge || !checkout.challengeUsable) return null;
      const derived = derive(challenge.nonceKeyVersion, challenge.id, checkout.ownerId, challenge.quoteDigest);
      if (!derived || !constantTimeEqual(derived.nonceDigest, challenge.nonceDigest)) return null;
      return derived.nonce;
    },
  };
}
