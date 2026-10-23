import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutActions } from "@/components/CheckoutActions";
import { ConfirmationSummary } from "@/components/ConfirmationSummary";
import { SessionNotice } from "@/components/SessionNotice";
import {
  CONSUME_RESULTS,
  decodeCheckoutAmounts,
  decodeCheckoutRead,
  decodeIssuedChallenge,
  ISSUE_CHALLENGE_DATA_COLUMNS,
  ISSUE_REFUSALS,
  READ_CHECKOUT_DATA_COLUMNS,
  START_CHECKOUT_DATA_COLUMNS,
  START_REFUSALS,
  UnexpectedRowError,
  type CheckoutRead,
} from "@/lib/pg/checkout-service";
import type { PgQueryable, PgQueryResult } from "@/lib/pg/client";
import { confirmationNonceDigest, deriveConfirmationNonce } from "@/lib/pg/confirmation-nonce";
import type { ConfiguredKeyRings } from "@/lib/pg/key-ring";
import { APPLICATION_STATEMENTS, CHECKOUT_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { createSequentialIdGenerator } from "@/lib/shared/ids";
import {
  handlePgCancel,
  handlePgCheckoutStart,
  handlePgConfirm,
  handlePgReview,
  handlePgSessionStart,
  handlePgSimulate,
} from "@/server/pg-handlers";
import { resolvePgSession, type PgRequestContext } from "@/server/pg-request-guard";
import { buildPgServices, parsePgRuntimeConfig, type PgRuntimeConfig, type PgServices } from "@/server/pg-runtime";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { buildPgCheckoutList, buildPgCheckoutView, buildPgShoppingView, loadPgCatalog, pgCheckoutActions } from "@/server/pg-views";
import { createRuntime } from "@/server/runtime";
import { buildShoppingView, parsePreferences } from "@/server/shopping";
import { messageFor } from "@/server/views";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// NEVER RUN when written. Database-free: every "database" here is the fake below, which answers the statements of the
// reviewed catalogue from scripts and a small in-memory model. Nothing here connects to PostgreSQL, and nothing a
// fake returns is evidence of what PostgreSQL does. The acceptance cases named in the titles are those of the
// Increment 2.3 plan (specification 19.19); cases marked I or B there need a real database or a browser and are
// not established by this file.

// Synthetic, test-only values. Nothing here is a real origin, key or address.
const ORIGIN = "https://shop.example.test";
const SESSION_KEY = Buffer.alloc(32, 11);
const NONCE_KEY_1 = Buffer.alloc(32, 22);
const NONCE_KEY_2 = Buffer.alloc(32, 33);
const DATABASE_URL = "postgres://shopaccess_web@db.example.test:5432/shopaccess";
const OWNER = `own_${"a".repeat(32)}`;
const GROUP = `pur_${"b".repeat(32)}`;
const QUOTE_DIGEST = "c".repeat(64);
const T0 = new Date("2026-10-08T12:00:00.000Z");
const MINUTE = 60_000;

type Row = Record<string, unknown>;
type Script = (values: readonly unknown[]) => Row[] | Promise<Row[]>;
type StatementName = keyof typeof SESSION_STATEMENTS | keyof typeof CHECKOUT_STATEMENTS | keyof typeof APPLICATION_STATEMENTS;

const STATEMENT_NAMES = new Map<string, string>(
  Object.entries({ ...SESSION_STATEMENTS, ...CHECKOUT_STATEMENTS, ...APPLICATION_STATEMENTS }).map(([name, text]) => [text, name]),
);
const CHECKOUT_CALLS = Object.keys(CHECKOUT_STATEMENTS);

const sha256 = (value: string): string => createHash("sha256").update(value, "ascii").digest("hex");
const hex32 = (seed: number): string => seed.toString(16).padStart(32, "0");

function configFor(nonceKeys: string): PgRuntimeConfig {
  const parsed = parsePgRuntimeConfig({
    SHOPACCESS_DATABASE_URL: DATABASE_URL,
    SHOPACCESS_SESSION_KEYS: `1:${SESSION_KEY.toString("base64")}`,
    SHOPACCESS_NONCE_KEYS: nonceKeys,
    SHOPACCESS_TRUSTED_ORIGINS: ORIGIN,
    PAYMENT_PROVIDER_MODE: "mock",
  });
  if (!parsed.ok) throw new Error(`test configuration refused: ${parsed.error.join(",")}`);
  return parsed.value;
}
const ONE_NONCE_KEY = `1:${NONCE_KEY_1.toString("base64")}`;
const TWO_NONCE_KEYS = `1:${NONCE_KEY_1.toString("base64")},2:${NONCE_KEY_2.toString("base64")}`;

/** A read_checkout row for one intent: 41 columns, internally consistent, QUOTED with no challenge. */
function readRow(intentId: string, overrides: Row = {}): Row {
  return {
    result: "OK",
    owner_id: OWNER,
    intent_id: intentId,
    purchase_group_id: GROUP,
    stored_state: "QUOTED",
    row_version: 2,
    effective_status: "QUOTED",
    replaces_intent_id: null,
    superseded_by_intent_id: null,
    intent_created_at: T0,
    intent_updated_at: T0,
    quote_id: `qt_${intentId.slice(3)}`,
    merchant_id: "dmm_shopaccessdemo",
    merchant_display_name: "ShopAccess Demo Store",
    product_id: "dmp_codebook15",
    product_title: "CodeBook 15",
    variant_id: "dmv_codebook15a",
    variant_label: "16 GB, 512 GB",
    quantity: 1,
    unit_amount_cents: "79900",
    subtotal_cents: "79900",
    discount_cents: "0",
    tax_cents: "0",
    shipping_cents: "0",
    total_cents: "79900",
    currency: "USD",
    assumptions_code: "SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1",
    catalog_revision: 1,
    quote_digest: QUOTE_DIGEST,
    quote_created_at: T0,
    quote_expires_at: new Date(T0.getTime() + 15 * MINUTE),
    quote_stale: false,
    database_time: T0,
    challenge_id: null,
    challenge_quote_digest: null,
    challenge_nonce_key_version: null,
    challenge_nonce_digest: null,
    challenge_summary: null,
    challenge_issued_at: null,
    challenge_expires_at: null,
    challenge_usable: false,
    ...overrides,
  };
}

const NOT_AUTHORIZED_READ: Row = Object.fromEntries(Object.keys(readRow(`ci_${hex32(0)}`)).map((column) => [column, null]));
NOT_AUTHORIZED_READ.result = "NOT_AUTHORIZED";

const SUMMARY = { merchantName: "ShopAccess Demo Store", productTitle: "CodeBook 15", variantLabel: "16 GB, 512 GB", quantity: 1, currency: "USD", totalCents: 79900 };

/**
 * A fake of the database as the web role sees it: it accepts only statements of the reviewed catalogue, records
 * every call, and answers from a script per statement. The default scripts keep a small model of sessions and
 * checkouts, enough for a flow; a test replaces a script to make a call answer something else or fail.
 */
class FakeDatabase implements PgQueryable {
  readonly calls: Array<{ readonly name: string; readonly values: readonly unknown[] }> = [];
  readonly sessions = new Map<string, { id: string; keyVersion: number }>();
  readonly checkouts = new Map<string, Row>();
  nonceKeyRows: Row[];
  private readonly scripts = new Map<string, Script>();
  private nextIntent = 1;

  constructor(private readonly rings: ConfiguredKeyRings) {
    this.nonceKeyRows = [{ purpose: "confirmation_nonce", key_version: 1, status: "ACTIVE", check_value: rings.confirmationNonce.checkValue(1) }];
    this.on("readKeyVersions", ([purpose]) =>
      purpose === "session" ? [{ purpose: "session", key_version: 1, status: "ACTIVE", check_value: this.rings.session.checkValue(1) }] : this.nonceKeyRows,
    );
    this.on("admitSession", ([sessionId, keyVersion, tokenDigest]) => {
      this.sessions.set(String(tokenDigest), { id: String(sessionId), keyVersion: Number(keyVersion) });
      return [{ result: "ADMITTED", absolute_expires_at: new Date(T0.getTime() + 24 * 60 * MINUTE), idle_expires_at: new Date(T0.getTime() + 120 * MINUTE) }];
    });
    this.on("authorizeSession", ([keyVersion, tokenDigest]) => {
      const session = this.sessions.get(String(tokenDigest));
      if (!session || session.keyVersion !== keyVersion) return [{ result: "NOT_AUTHORIZED", session_id: null, absolute_expires_at: null, idle_expires_at: null, key_status: null }];
      return [
        { result: "AUTHORIZED", session_id: session.id, absolute_expires_at: new Date(T0.getTime() + 24 * 60 * MINUTE), idle_expires_at: new Date(T0.getTime() + 120 * MINUTE), key_status: "ACTIVE" },
      ];
    });
    this.on("startCheckout", () => {
      const intentId = `ci_${hex32(this.nextIntent)}`;
      this.nextIntent += 1;
      this.checkouts.set(intentId, readRow(intentId));
      return [{ result: "STARTED", intent_id: intentId, quote_id: `qt_${intentId.slice(3)}`, quote_expires_at: new Date(T0.getTime() + 15 * MINUTE) }];
    });
    this.on("readCheckout", ([, , intentId]) => [this.checkouts.get(String(intentId)) ?? NOT_AUTHORIZED_READ]);
    this.on("listOwnerCheckouts", () =>
      [...this.checkouts.values()].map((row) => ({
        intent_id: row.intent_id,
        purchase_group_id: row.purchase_group_id,
        stored_state: row.stored_state,
        effective_status: row.effective_status,
        intent_created_at: row.intent_created_at,
        quote_expires_at: row.quote_expires_at,
      })),
    );
    this.on("issueChallenge", ([, , intentId, challengeId, nonceKeyVersion, nonceDigest]) => {
      const row = this.checkouts.get(String(intentId));
      if (!row) return [{ result: "NOT_AUTHORIZED", challenge_id: null, quote_digest: null, nonce_key_version: null, nonce_digest: null, summary: null, expires_at: null }];
      const expiresAt = new Date(T0.getTime() + 5 * MINUTE);
      Object.assign(row, {
        challenge_id: challengeId,
        challenge_quote_digest: row.quote_digest,
        challenge_nonce_key_version: nonceKeyVersion,
        challenge_nonce_digest: nonceDigest,
        challenge_summary: { ...SUMMARY },
        challenge_issued_at: T0,
        challenge_expires_at: expiresAt,
        challenge_usable: true,
      });
      return [{ result: "ISSUED", challenge_id: challengeId, quote_digest: row.quote_digest, nonce_key_version: nonceKeyVersion, nonce_digest: nonceDigest, summary: { ...SUMMARY }, expires_at: expiresAt }];
    });
    this.on("consumeChallenge", ([, , challengeId, nonce, quoteId, quoteDigest]) => {
      const row = [...this.checkouts.values()].find((candidate) => candidate.challenge_id === challengeId);
      if (!row) return [{ result: "CONFIRMATION_NOT_FOUND", intent_id: null }];
      if (sha256(String(nonce)) !== row.challenge_nonce_digest || quoteId !== row.quote_id || quoteDigest !== row.challenge_quote_digest) {
        return [{ result: "CONFIRMATION_MISMATCH", intent_id: null }];
      }
      Object.assign(row, {
        stored_state: "USER_CONFIRMED",
        effective_status: "USER_CONFIRMED",
        row_version: 3,
        challenge_id: null,
        challenge_quote_digest: null,
        challenge_nonce_key_version: null,
        challenge_nonce_digest: null,
        challenge_summary: null,
        challenge_issued_at: null,
        challenge_expires_at: null,
        challenge_usable: false,
      });
      return [{ result: "CONFIRMED", intent_id: row.intent_id }];
    });
    this.on("cancelCheckout", ([, , intentId]) => {
      const row = this.checkouts.get(String(intentId));
      if (!row) return [{ result: "NOT_AUTHORIZED" }];
      Object.assign(row, { stored_state: "CANCELED_LOCAL", effective_status: "CANCELED_LOCAL", row_version: 3 });
      return [{ result: "CANCELED" }];
    });
  }

  on(name: StatementName, script: Script): void {
    this.scripts.set(name, script);
  }

  async query<Result = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<PgQueryResult<Result>> {
    const name = STATEMENT_NAMES.get(text);
    if (name === undefined) throw new Error("a statement that is not in the reviewed catalogue was sent");
    this.calls.push({ name, values });
    const script = this.scripts.get(name);
    if (!script) throw new Error(`no script for ${name}`);
    return { rows: (await script(values)) as Result[] };
  }

  /** The values of every call of one statement, in order. */
  sent(name: StatementName): Array<readonly unknown[]> {
    return this.calls.filter((call) => call.name === name).map((call) => call.values);
  }

  /** The names of the checkout calls made so far: session and key-version statements are left out. */
  checkoutCalls(): string[] {
    return this.calls.map((call) => call.name).filter((name) => CHECKOUT_CALLS.includes(name));
  }

  /** A deep copy of the checkout model, for "nothing changed" comparisons. */
  snapshot(): Row[] {
    return structuredClone([...this.checkouts.values()]);
  }
}

interface Shopper {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly context: PgRequestContext;
}

function world(nonceKeys: string = ONE_NONCE_KEY) {
  const time = createTestClock(T0.toISOString());
  const config = configFor(nonceKeys);
  const db = new FakeDatabase(config.rings);
  const services = buildPgServices(db, config, { clock: time.clock, ids: createSequentialIdGenerator() });
  return { time, config, db, services };
}

async function signIn(services: PgServices): Promise<Shopper> {
  const response = await handlePgSessionStart(new Request(`${ORIGIN}/session/start`), services);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie was set");
  const cookie = setCookie.split(";")[0];
  const state = await resolvePgSession(cookie, services.sessions);
  if (!state.context) throw new Error("the session was not established");
  return { cookie, csrfToken: state.context.session.csrfToken, context: state.context };
}

function post(path: string, shopper: Pick<Shopper, "cookie"> | null, fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(shopper ? { cookie: shopper.cookie } : {}),
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const QUOTE_FIELDS = { productId: "dmp_codebook15", variantId: "dmv_codebook15a", quantity: "1", use: "programming", budget: "900" };

async function startCheckout(w: ReturnType<typeof world>, shopper: Shopper, extra: Record<string, string> = {}): Promise<{ response: Response; location: string }> {
  const response = await handlePgCheckoutStart(post("/checkout/start", shopper, { ...QUOTE_FIELDS, ...extra, csrfToken: shopper.csrfToken }), w.services);
  return { response, location: response.headers.get("location") ?? "" };
}

/** Starts a checkout through the handler and returns its id. The default scripts issue its first challenge. */
async function startedIntent(w: ReturnType<typeof world>, shopper: Shopper): Promise<string> {
  const { response, location } = await startCheckout(w, shopper);
  expect(response.status).toBe(303);
  expect(location).toMatch(/^\/checkout\/ci_[0-9a-f]{32}$/);
  return location.slice("/checkout/".length);
}

/** The confirmation form of a checkout as its page shows it. */
async function formOf(w: ReturnType<typeof world>, shopper: Shopper, intentId: string): Promise<Record<string, string>> {
  const page = await buildPgCheckoutView(w.services, shopper.context, intentId);
  if (page.kind !== "OK" || !page.value.challenge) throw new Error("the checkout shows no confirmation form");
  const { confirmationId, nonce, quoteId, quoteDigest } = page.value.challenge;
  return { confirmationId, nonce, quoteId, quoteDigest, acknowledged: "yes", csrfToken: shopper.csrfToken };
}

const confirm = (w: ReturnType<typeof world>, shopper: Shopper, intentId: string, fields: Record<string, string>): Promise<Response> =>
  handlePgConfirm(post(`/checkout/${intentId}/confirm`, shopper, fields), w.services, intentId);

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PostgreSQL mode: starting a checkout and its first challenge (A9, A11, A14, A45, A46)", () => {
  it("A11: start sends only the item and the credential; issue sends a generated id, the active configured key version and a digest, and never the nonce", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const { response, location } = await startCheckout(w, shopper, { unitAmountCents: "1", totalCents: "1", ownerId: OWNER });
    expect(response.status).toBe(303);
    expect(location).toMatch(/^\/checkout\/ci_[0-9a-f]{32}$/);
    const intentId = location.slice("/checkout/".length);

    expect(w.db.checkoutCalls()).toEqual(["startCheckout", "readCheckout", "issueChallenge"]);
    // A price or an owner id in the form is never read.
    expect(w.db.sent("startCheckout")).toEqual([[1, shopper.context.credential.tokenDigest, "dmp_codebook15", "dmv_codebook15a", 1, null]]);
    expect(w.db.sent("readCheckout")).toEqual([[1, shopper.context.credential.tokenDigest, intentId]]);

    const [issue] = w.db.sent("issueChallenge");
    expect(issue).toHaveLength(6);
    expect(issue.slice(0, 3)).toEqual([1, shopper.context.credential.tokenDigest, intentId]);
    const challengeId = String(issue[3]);
    expect(challengeId).toMatch(/^cf_[0-9a-f]{32}$/);
    expect(issue[4]).toBe(1);
    // The digest is that of the nonce derived from the generated id, the read's owner id and its stored digest.
    const nonce = deriveConfirmationNonce(NONCE_KEY_1, { challengeId, ownerId: OWNER, quoteDigest: QUOTE_DIGEST });
    expect(issue[5]).toBe(confirmationNonceDigest(nonce));
    for (const call of w.db.calls) expect(call.values, call.name).not.toContain(nonce);
  });

  it("A9: when start has answered STARTED and the challenge cannot be issued, the shopper lands on that checkout with REVIEW_NOT_READY; start is sent once and Review again recovers", async () => {
    for (const failure of ["issue throws", "issue is refused", "the read throws", "the read is an unexpected row"] as const) {
      const w = world();
      const shopper = await signIn(w.services);
      if (failure === "issue throws") w.db.on("issueChallenge", () => Promise.reject(new Error("connection lost")));
      if (failure === "issue is refused") w.db.on("issueChallenge", () => [{ result: "REFUSED", challenge_id: null, quote_digest: null, nonce_key_version: null, nonce_digest: null, summary: null, expires_at: null }]);
      if (failure === "the read throws") w.db.on("readCheckout", () => Promise.reject(new Error("timeout")));
      if (failure === "the read is an unexpected row") w.db.on("readCheckout", ([, , intentId]) => [readRow(String(intentId), { total_cents: "079900" })]);

      const { response, location } = await startCheckout(w, shopper);
      expect(response.status, failure).toBe(303);
      expect(location, failure).toMatch(/^\/checkout\/ci_[0-9a-f]{32}\?error=REVIEW_NOT_READY$/);
      expect(w.db.sent("startCheckout"), failure).toHaveLength(1);
      expect(w.db.sent("issueChallenge").length, failure).toBeLessThanOrEqual(1);
      expect(messageFor("REVIEW_NOT_READY"), failure).toContain("Review again");
    }

    // Recovery: the same checkout, a new request for a challenge, and still exactly one start call.
    const w = world();
    const shopper = await signIn(w.services);
    let fail = true;
    const original: Script = ([, , intentId, challengeId, version, digest]) => {
      const row = w.db.checkouts.get(String(intentId));
      if (!row) throw new Error("unknown intent");
      Object.assign(row, { challenge_id: challengeId, challenge_quote_digest: row.quote_digest, challenge_nonce_key_version: version, challenge_nonce_digest: digest, challenge_summary: { ...SUMMARY }, challenge_issued_at: T0, challenge_expires_at: new Date(T0.getTime() + 5 * MINUTE), challenge_usable: true });
      return [{ result: "ISSUED", challenge_id: challengeId, quote_digest: row.quote_digest, nonce_key_version: version, nonce_digest: digest, summary: { ...SUMMARY }, expires_at: new Date(T0.getTime() + 5 * MINUTE) }];
    };
    w.db.on("issueChallenge", (values) => (fail ? Promise.reject(new Error("connection lost")) : original(values)));
    const { location } = await startCheckout(w, shopper);
    const intentId = location.slice("/checkout/".length, location.indexOf("?"));
    fail = false;
    const reviewed = await handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);
    expect(reviewed.status).toBe(303);
    expect(reviewed.headers.get("location")).toBe(`/checkout/${intentId}`);
    expect(w.db.sent("startCheckout")).toHaveLength(1);
    const page = await buildPgCheckoutView(w.services, shopper.context, intentId);
    expect(page.kind === "OK" && page.value.challenge !== null).toBe(true);
  });

  it("A45: a start whose answer is lost after the database committed is sent once, reported as not known, and the committed checkout is in the list", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const committed = `ci_${hex32(77)}`;
    w.db.on("startCheckout", () => {
      w.db.checkouts.set(committed, readRow(committed));
      return Promise.reject(new Error("the connection was lost before the answer arrived"));
    });
    const { response, location } = await startCheckout(w, shopper);
    expect(response.status).toBe(303);
    expect(location).toBe("/checkouts?notice=START_UNCERTAIN");
    expect(w.db.sent("startCheckout")).toHaveLength(1);
    expect(w.db.checkoutCalls()).toEqual(["startCheckout"]);

    const list = await buildPgCheckoutList(w.services, shopper.context);
    expect(list.kind === "OK" ? list.value.map((item) => item.intentId) : null).toEqual([committed]);
  });

  it("A46: a start whose outcome is not known and whose checkout does not exist shows the notice and an empty list, and the text does not say that the start failed", async () => {
    for (const failure of ["thrown", "no usable row"] as const) {
      const w = world();
      const shopper = await signIn(w.services);
      w.db.on("startCheckout", () => (failure === "thrown" ? Promise.reject(new Error("timeout")) : [{ result: "SOMETHING_ELSE", intent_id: null, quote_id: null, quote_expires_at: null }]));
      const { location } = await startCheckout(w, shopper);
      expect(location, failure).toBe("/checkouts?notice=START_UNCERTAIN");
      expect(w.db.sent("startCheckout"), failure).toHaveLength(1);
      const list = await buildPgCheckoutList(w.services, shopper.context);
      expect(list, failure).toEqual({ kind: "OK", value: [] });
    }
    const text = messageFor("START_UNCERTAIN") ?? "";
    expect(text).toContain("could not tell whether your checkout was created");
    expect(text).toContain("Nothing has been resubmitted for you");
    expect(text).not.toMatch(/\bfailed\b|was not created\b|did not go through/i);
  });

  it("A14: a refused id, a timeout and a lost connection are each sent exactly once; no checkout call is ever repeated", async () => {
    // issue: REFUSED (the id exists) and a lock timeout, through Review again.
    for (const answer of ["REFUSED", "lock timeout", "deadlock"] as const) {
      const w = world();
      const shopper = await signIn(w.services);
      const intentId = await startedIntent(w, shopper);
      const before = w.db.sent("issueChallenge").length;
      w.db.on("issueChallenge", () => {
        if (answer === "REFUSED") return [{ result: "REFUSED", challenge_id: null, quote_digest: null, nonce_key_version: null, nonce_digest: null, summary: null, expires_at: null }];
        return Promise.reject(Object.assign(new Error("canceled"), { code: answer === "lock timeout" ? "55P03" : "40P01" }));
      });
      const reviewed = await handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);
      expect(reviewed.headers.get("location"), answer).toBe(`/checkout/${intentId}?error=REVIEW_NOT_READY`);
      expect(w.db.sent("issueChallenge").length - before, answer).toBe(1);
    }
    // consume and cancel: a failure is "not available", and the call is not sent again.
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = await startedIntent(w, shopper);
    const form = await formOf(w, shopper, intentId);
    w.db.on("consumeChallenge", () => Promise.reject(Object.assign(new Error("canceled"), { code: "55P03" })));
    const confirmed = await confirm(w, shopper, intentId, form);
    expect(confirmed.status).toBe(503);
    expect(w.db.sent("consumeChallenge")).toHaveLength(1);
    w.db.on("cancelCheckout", () => Promise.reject(new Error("connection lost")));
    const canceled = await handlePgCancel(post(`/checkout/${intentId}/cancel`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);
    expect(canceled.status).toBe(503);
    expect(w.db.sent("cancelCheckout")).toHaveLength(1);
  });

  it("maps every refusal of start_checkout: three generic refusals, and the rest back to the shop with their code", async () => {
    const expected: Record<string, number | string> = {
      NOT_AUTHORIZED: 403,
      REQUEST_INVALID: 400,
      RATE_LIMITED: 429,
      REPLACEMENT_NOT_ALLOWED: "/shop?use=programming&budget=900&error=REPLACEMENT_NOT_ALLOWED",
      PRODUCT_NOT_IN_MERCHANT_CATALOG: "/shop?use=programming&budget=900&error=PRODUCT_NOT_IN_MERCHANT_CATALOG",
      VARIANT_UNAVAILABLE: "/shop?use=programming&budget=900&error=VARIANT_UNAVAILABLE",
      QUANTITY_EXCEEDS_LIMIT: "/shop?use=programming&budget=900&error=QUANTITY_EXCEEDS_LIMIT",
      AMOUNT_OUT_OF_RANGE: "/shop?use=programming&budget=900&error=AMOUNT_OUT_OF_RANGE",
      AT_PURCHASE_CAPACITY: "/shop?use=programming&budget=900&error=AT_PURCHASE_CAPACITY",
      GROUP_INTENT_LIMIT: "/shop?use=programming&budget=900&error=GROUP_INTENT_LIMIT",
    };
    expect(Object.keys(expected).sort()).toEqual([...START_REFUSALS].sort());
    for (const [result, outcome] of Object.entries(expected)) {
      const w = world();
      const shopper = await signIn(w.services);
      w.db.on("startCheckout", () => [{ result, intent_id: null, quote_id: null, quote_expires_at: null }]);
      const { response, location } = await startCheckout(w, shopper);
      if (typeof outcome === "number") expect(response.status, result).toBe(outcome);
      else expect(location, result).toBe(outcome);
      // Nothing follows a refused start.
      expect(w.db.checkoutCalls(), result).toEqual(["startCheckout"]);
    }
    // A28: the capacity refusals have their own fixed messages.
    for (const code of ["AT_PURCHASE_CAPACITY", "GROUP_INTENT_LIMIT", "CHALLENGE_LIMIT_REACHED", "REPLACEMENT_NOT_ALLOWED"]) {
      expect(messageFor(code), code).not.toBe(messageFor("AN_UNKNOWN_CODE"));
    }
  });

  it("refuses a malformed start before any checkout call", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const malformedStarts: Array<Record<string, string>> = [{ quantity: "one" }, { quantity: "1.5" }, { quantity: "0" }, { replaces: "ci_not-an-id" }, { replaces: `cf_${hex32(1)}` }];
    for (const fields of malformedStarts) {
      const { response } = await startCheckout(w, shopper, fields);
      expect(response.status, JSON.stringify(fields)).toBe(400);
    }
    expect(w.db.checkoutCalls()).toEqual([]);
  });
});

describe("PostgreSQL mode: the nonce key and an existing challenge (A12, A13)", () => {
  const review = (w: ReturnType<typeof world>, shopper: Shopper, intentId: string): Promise<Response> =>
    handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);

  it("A12: REUSED is shown only when the nonce derived from the returned values hashes to the returned digest", async () => {
    const existingId = `cf_${"d".repeat(32)}`;
    const good = confirmationNonceDigest(deriveConfirmationNonce(NONCE_KEY_1, { challengeId: existingId, ownerId: OWNER, quoteDigest: QUOTE_DIGEST }));
    const cases: Array<[string, Row, string]> = [
      ["derivable", { nonce_key_version: 1, nonce_digest: good }, ""],
      ["a digest this process cannot reproduce", { nonce_key_version: 1, nonce_digest: "e".repeat(64) }, "?error=REVIEW_NOT_READY"],
      ["a key version that is not configured", { nonce_key_version: 7, nonce_digest: good }, "?error=REVIEW_NOT_READY"],
    ];
    for (const [label, returned, suffix] of cases) {
      const w = world();
      const shopper = await signIn(w.services);
      const intentId = `ci_${hex32(5)}`;
      w.db.checkouts.set(intentId, readRow(intentId));
      w.db.on("issueChallenge", () => [{ result: "REUSED", challenge_id: existingId, quote_digest: QUOTE_DIGEST, summary: { ...SUMMARY }, expires_at: new Date(T0.getTime() + 4 * MINUTE), ...returned }]);
      const reviewed = await review(w, shopper, intentId);
      expect(reviewed.headers.get("location"), label).toBe(`/checkout/${intentId}${suffix}`);
      expect(w.db.sent("issueChallenge"), label).toHaveLength(1);
    }
  });

  it("A13: after NONCE_KEY_NOT_ACTIVE there is one new reading of the key versions and at most one more call, only for a different configured version", async () => {
    const refusal = { result: "NONCE_KEY_NOT_ACTIVE", challenge_id: null, quote_digest: null, nonce_key_version: null, nonce_digest: null, summary: null, expires_at: null };
    const echo = (values: readonly unknown[]): Row[] => [{ result: "ISSUED", challenge_id: values[3], quote_digest: QUOTE_DIGEST, nonce_key_version: values[4], nonce_digest: values[5], summary: { ...SUMMARY }, expires_at: new Date(T0.getTime() + 5 * MINUTE) }];
    const setUp = async () => {
      const w = world(TWO_NONCE_KEYS);
      const shopper = await signIn(w.services);
      const intentId = `ci_${hex32(6)}`;
      w.db.checkouts.set(intentId, readRow(intentId));
      return { w, shopper, intentId };
    };
    const nonceRow = (rings: ConfiguredKeyRings, version: number, status: string): Row => ({ purpose: "confirmation_nonce", key_version: version, status, check_value: rings.confirmationNonce.checkValue(version) });

    // The reading names another configured version: one more call, under that version, with a new id.
    {
      const { w, shopper, intentId } = await setUp();
      w.db.on("issueChallenge", (values) => {
        if (values[4] === 1) {
          w.db.nonceKeyRows = [nonceRow(w.config.rings, 1, "VERIFY_ONLY"), nonceRow(w.config.rings, 2, "ACTIVE")];
          return [refusal];
        }
        return echo(values);
      });
      const reviewed = await review(w, shopper, intentId);
      expect(reviewed.headers.get("location")).toBe(`/checkout/${intentId}`);
      const calls = w.db.sent("issueChallenge");
      expect(calls.map((values) => values[4])).toEqual([1, 2]);
      expect(calls[0][3]).not.toBe(calls[1][3]);
      const nonce = deriveConfirmationNonce(NONCE_KEY_2, { challengeId: String(calls[1][3]), ownerId: OWNER, quoteDigest: QUOTE_DIGEST });
      expect(calls[1][5]).toBe(confirmationNonceDigest(nonce));
    }
    // The reading names the same version: no second call.
    {
      const { w, shopper, intentId } = await setUp();
      w.db.on("issueChallenge", () => [refusal]);
      expect((await review(w, shopper, intentId)).headers.get("location")).toBe(`/checkout/${intentId}?error=REVIEW_NOT_READY`);
      expect(w.db.sent("issueChallenge")).toHaveLength(1);
    }
    // The reading names a version whose key is not configured: a reading cannot supply key bytes, so no second call.
    {
      const { w, shopper, intentId } = await setUp();
      w.db.on("issueChallenge", () => {
        w.db.nonceKeyRows = [nonceRow(w.config.rings, 1, "VERIFY_ONLY"), { purpose: "confirmation_nonce", key_version: 3, status: "ACTIVE", check_value: "f".repeat(64) }];
        return [refusal];
      });
      expect((await review(w, shopper, intentId)).headers.get("location")).toBe(`/checkout/${intentId}?error=REVIEW_NOT_READY`);
      expect(w.db.sent("issueChallenge")).toHaveLength(1);
    }
    // The second call is refused the same way: never a third.
    {
      const { w, shopper, intentId } = await setUp();
      w.db.on("issueChallenge", (values) => {
        if (values[4] === 1) w.db.nonceKeyRows = [nonceRow(w.config.rings, 1, "VERIFY_ONLY"), nonceRow(w.config.rings, 2, "ACTIVE")];
        return [refusal];
      });
      expect((await review(w, shopper, intentId)).headers.get("location")).toBe(`/checkout/${intentId}?error=REVIEW_NOT_READY`);
      expect(w.db.sent("issueChallenge")).toHaveLength(2);
    }
  });

  it("maps every business refusal of issue_challenge on Review again", async () => {
    const intentId = `ci_${hex32(8)}`;
    const expected: Record<string, number | string> = {
      NOT_AUTHORIZED: 403,
      REQUEST_INVALID: 400,
      RATE_LIMITED: 429,
      INTENT_NOT_AWAITING_CONFIRMATION: `/checkout/${intentId}`,
      CONFIRMATION_ALREADY_USED: `/checkout/${intentId}`,
      QUOTE_EXPIRED: `/checkout/${intentId}?error=QUOTE_EXPIRED`,
      QUOTE_STALE_CATALOG: `/checkout/${intentId}?error=QUOTE_STALE_CATALOG`,
      QUOTE_DIGEST_MISMATCH: `/checkout/${intentId}?error=CONFIRMATION_UNAVAILABLE`,
      CHALLENGE_LIMIT_REACHED: `/checkout/${intentId}?error=CHALLENGE_LIMIT_REACHED`,
    };
    expect(Object.keys(expected).sort()).toEqual([...ISSUE_REFUSALS].sort());
    for (const [result, outcome] of Object.entries(expected)) {
      const w = world();
      const shopper = await signIn(w.services);
      w.db.checkouts.set(intentId, readRow(intentId));
      w.db.on("issueChallenge", () => [{ result, challenge_id: null, quote_digest: null, nonce_key_version: null, nonce_digest: null, summary: null, expires_at: null }]);
      const reviewed = await review(w, shopper, intentId);
      if (typeof outcome === "number") expect(reviewed.status, result).toBe(outcome);
      else expect(reviewed.headers.get("location"), result).toBe(outcome);
    }
    // A checkout of another owner, or none: "not found", and no request for a challenge.
    const w = world();
    const shopper = await signIn(w.services);
    expect((await review(w, shopper, `ci_${hex32(404)}`)).status).toBe(404);
    expect(w.db.sent("issueChallenge")).toEqual([]);
  });
});

describe("PostgreSQL mode: what a page load sends and shows (A15, A16)", () => {
  it("A15: a page load reads the checkout and nothing else; a QUOTED checkout with no challenge offers Review again and issues nothing", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = `ci_${hex32(9)}`;
    w.db.checkouts.set(intentId, readRow(intentId));
    const before = w.db.calls.length;
    const page = await buildPgCheckoutView(w.services, shopper.context, intentId);
    expect(w.db.calls.slice(before).map((call) => call.name)).toEqual(["readCheckout"]);
    expect(page.kind).toBe("OK");
    if (page.kind !== "OK") return;
    expect(page.value.challenge).toBeNull();
    expect(page.value.actions).toEqual({ review: true, cancel: true, replace: null, startAnother: null, successorIntentId: null });
    expect(w.db.sent("issueChallenge")).toEqual([]);

    // Another owner's checkout, a missing one and a malformed id are all "not found".
    expect(await buildPgCheckoutView(w.services, shopper.context, `ci_${hex32(404)}`)).toEqual({ kind: "NOT_FOUND" });
    expect(await buildPgCheckoutView(w.services, shopper.context, "not-an-id")).toEqual({ kind: "NOT_FOUND" });
  });

  it("A16: after a restart with the same keys, and in a second tab, the same challenge and nonce are shown from the read alone", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = await startedIntent(w, shopper);
    const first = await buildPgCheckoutView(w.services, shopper.context, intentId);
    const second = await buildPgCheckoutView(w.services, shopper.context, intentId);
    if (first.kind !== "OK" || second.kind !== "OK" || !first.value.challenge) throw new Error("no challenge shown");
    expect(second.value.challenge).toEqual(first.value.challenge);
    const issued = w.db.sent("issueChallenge");
    expect(issued).toHaveLength(1);
    expect(first.value.challenge.confirmationId).toBe(issued[0][3]);
    expect(first.value.challenge.nonce).toBe(deriveConfirmationNonce(NONCE_KEY_1, { challengeId: String(issued[0][3]), ownerId: OWNER, quoteDigest: QUOTE_DIGEST }));

    // A new process: new services on the same database, keys parsed again from the same configuration.
    const restarted = buildPgServices(w.db, configFor(ONE_NONCE_KEY), { clock: w.time.clock, ids: createSequentialIdGenerator() });
    const state = await resolvePgSession(shopper.cookie, restarted.sessions);
    if (!state.context) throw new Error("the session did not survive the restart");
    const after = await buildPgCheckoutView(restarted, state.context, intentId);
    expect(after.kind === "OK" ? after.value.challenge : null).toEqual(first.value.challenge);
    expect(w.db.sent("issueChallenge")).toHaveLength(1);
  });

  it("shows no form when the database does not call the challenge usable, when its key is not configured, or when the derived nonce does not hash to the stored digest", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = await startedIntent(w, shopper);
    const row = w.db.checkouts.get(intentId);
    if (!row) throw new Error("no row");
    const good = { ...row };
    for (const [label, change] of [
      ["not usable", { challenge_usable: false }],
      ["a key version that is not configured", { challenge_nonce_key_version: 9 }],
      ["another digest", { challenge_nonce_digest: "e".repeat(64) }],
    ] as const) {
      w.db.checkouts.set(intentId, { ...good, ...change });
      const page = await buildPgCheckoutView(w.services, shopper.context, intentId);
      expect(page.kind === "OK" ? page.value.challenge : "not OK", label).toBeNull();
    }
    w.db.checkouts.set(intentId, good);
    const page = await buildPgCheckoutView(w.services, shopper.context, intentId);
    expect(page.kind === "OK" && page.value.challenge !== null).toBe(true);
  });
});

describe("PostgreSQL mode: confirmation is bound to the checkout in the URL (A4 to A8, A37, A39)", () => {
  it("A5, and the unit part of A38: a matching challenge reaches consume_challenge with the URL-bound id and the submitted nonce, quote id and quote digest, unchanged", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = await startedIntent(w, shopper);
    const form = await formOf(w, shopper, intentId);

    // Well-formed values that are not the database's: they are forwarded as sent, and the database decides.
    const otherQuote = `qt_${"9".repeat(32)}`;
    const otherDigest = "8".repeat(64);
    const wrong = await confirm(w, shopper, intentId, { ...form, quoteId: otherQuote, quoteDigest: otherDigest });
    expect(wrong.headers.get("location")).toBe(`/checkout/${intentId}?error=CONFIRMATION_MISMATCH`);
    expect(w.db.sent("consumeChallenge")).toEqual([[1, shopper.context.credential.tokenDigest, form.confirmationId, form.nonce, otherQuote, otherDigest]]);

    const right = await confirm(w, shopper, intentId, form);
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe(`/checkout/${intentId}?notice=CONFIRMED`);
    expect(w.db.sent("consumeChallenge")[1]).toEqual([1, shopper.context.credential.tokenDigest, form.confirmationId, form.nonce, form.quoteId, form.quoteDigest]);
  });

  it("A4 and A37: checkout B's form posted to checkout A's URL sends no consume call, gets the local FORM_OUT_OF_DATE outcome, and leaves both checkouts as they were", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const a = await startedIntent(w, shopper);
    const b = await startedIntent(w, shopper);
    const formB = await formOf(w, shopper, b);
    const before = w.db.snapshot();

    const response = await confirm(w, shopper, a, formB);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/checkout/${a}?error=FORM_OUT_OF_DATE`);
    expect(w.db.sent("consumeChallenge")).toEqual([]);
    expect(w.db.snapshot()).toEqual(before);
    // The local outcome is not a consume_challenge result name.
    expect([...CONSUME_RESULTS] as string[]).not.toContain("FORM_OUT_OF_DATE");

    // B is still confirmable at its own URL, by this single actor.
    const own = await confirm(w, shopper, b, formB);
    expect(own.headers.get("location")).toBe(`/checkout/${b}?notice=CONFIRMED`);
    expect(w.db.checkouts.get(a)?.stored_state).toBe("QUOTED");
  });

  it("A7 and A39: with no ACTIVE challenge the answer is a local outcome for the state the read showed; no consume call is made and the checkout model is unchanged", async () => {
    const cases: Array<[string, Row, string]> = [
      ["QUOTED, no challenge", {}, "?error=FORM_OUT_OF_DATE"],
      ["USER_CONFIRMED (a replay)", { stored_state: "USER_CONFIRMED", effective_status: "USER_CONFIRMED", row_version: 3 }, "?notice=ALREADY_CONFIRMED"],
      ["CANCELED_LOCAL", { stored_state: "CANCELED_LOCAL", effective_status: "CANCELED_LOCAL", row_version: 3 }, "?error=CHECKOUT_NOT_CONFIRMABLE"],
      ["SUPERSEDED", { stored_state: "SUPERSEDED", effective_status: "SUPERSEDED", row_version: 3, superseded_by_intent_id: `ci_${hex32(99)}` }, "?error=CHECKOUT_NOT_CONFIRMABLE"],
      ["EXPIRED", { stored_state: "EXPIRED", effective_status: "EXPIRED", row_version: 3 }, "?error=CHECKOUT_NOT_CONFIRMABLE"],
    ];
    for (const [label, state, suffix] of cases) {
      const w = world();
      const shopper = await signIn(w.services);
      const intentId = `ci_${hex32(20)}`;
      w.db.checkouts.set(intentId, readRow(intentId, state));
      const before = w.db.snapshot();
      const stale = { confirmationId: `cf_${"1".repeat(32)}`, nonce: deriveConfirmationNonce(NONCE_KEY_1, { challengeId: `cf_${"1".repeat(32)}`, ownerId: OWNER, quoteDigest: QUOTE_DIGEST }), quoteId: `qt_${intentId.slice(3)}`, quoteDigest: QUOTE_DIGEST, acknowledged: "yes", csrfToken: shopper.csrfToken };
      const response = await confirm(w, shopper, intentId, stale);
      expect(response.headers.get("location"), label).toBe(`/checkout/${intentId}${suffix}`);
      expect(w.db.sent("consumeChallenge"), label).toEqual([]);
      expect(w.db.checkoutCalls(), label).toEqual(["readCheckout"]);
      expect(w.db.snapshot(), label).toEqual(before);
    }
    // The wording describes what was seen, and claims nothing about what has happened since.
    for (const code of ["FORM_OUT_OF_DATE", "ALREADY_CONFIRMED", "CHECKOUT_NOT_CONFIRMABLE"]) {
      const text = messageFor(code) ?? "";
      expect(text, code).toContain("Reload to see the current checkout status");
      expect(text, code).not.toMatch(/nothing was confirmed|nothing changed/i);
    }
  });

  it("A6: CONFIRMED naming a checkout other than the one in the URL is an internal error and redirects nowhere", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = await startedIntent(w, shopper);
    const form = await formOf(w, shopper, intentId);
    w.db.on("consumeChallenge", () => [{ result: "CONFIRMED", intent_id: `ci_${hex32(4242)}` }]);
    const response = await confirm(w, shopper, intentId, form);
    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
    expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
  });

  it("A8: a change after the read is decided by the database, and every consume_challenge result has its outcome", async () => {
    const expected: Record<string, number | string> = {
      NOT_AUTHORIZED: 403,
      REQUEST_INVALID: 400,
      RATE_LIMITED: 429,
      CONFIRMATION_SUPERSEDED: "?error=CONFIRMATION_SUPERSEDED",
      CONFIRMATION_ALREADY_USED: "?error=CONFIRMATION_ALREADY_USED",
      CONFIRMATION_NOT_FOUND: "?error=CONFIRMATION_NOT_FOUND",
      CONFIRMATION_MISMATCH: "?error=CONFIRMATION_MISMATCH",
      CONFIRMATION_EXPIRED: "?error=CONFIRMATION_EXPIRED",
      CONFIRMATION_KEY_REVOKED: "?error=CONFIRMATION_UNAVAILABLE",
      QUOTE_DIGEST_MISMATCH: "?error=CONFIRMATION_UNAVAILABLE",
      QUOTE_EXPIRED: "?error=QUOTE_EXPIRED",
      QUOTE_STALE_CATALOG: "?error=QUOTE_STALE_CATALOG",
      INTENT_NOT_AWAITING_CONFIRMATION: "?error=NOT_AWAITING_CONFIRMATION",
    };
    expect([...Object.keys(expected), "CONFIRMED"].sort()).toEqual([...CONSUME_RESULTS].sort());
    for (const [result, outcome] of Object.entries(expected)) {
      const w = world();
      const shopper = await signIn(w.services);
      const intentId = await startedIntent(w, shopper);
      const form = await formOf(w, shopper, intentId);
      w.db.on("consumeChallenge", () => [{ result, intent_id: null }]);
      const response = await confirm(w, shopper, intentId, form);
      if (typeof outcome === "number") expect(response.status, result).toBe(outcome);
      else expect(response.headers.get("location"), result).toBe(`/checkout/${intentId}${outcome}`);
      expect(w.db.sent("consumeChallenge"), result).toHaveLength(1);
      if (typeof outcome === "string") expect(messageFor(outcome.slice("?error=".length)), result).not.toBe(messageFor("AN_UNKNOWN_CODE"));
    }
  });

  it("refuses malformed fields before any checkout call, a missing acknowledgement before consume, and a checkout of another owner as not found", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = await startedIntent(w, shopper);
    const form = await formOf(w, shopper, intentId);
    const before = w.db.checkoutCalls().length;

    const malformed: Array<Record<string, string>> = [
      { confirmationId: "cf_short" },
      { nonce: form.nonce.slice(0, 42) },
      { nonce: `${form.nonce.slice(0, 42)}B` },
      { quoteId: `ci_${hex32(1)}` },
      { quoteDigest: QUOTE_DIGEST.toUpperCase() },
      { quoteDigest: "c".repeat(63) },
    ];
    for (const change of malformed) {
      const response = await confirm(w, shopper, intentId, { ...form, ...change });
      expect(response.status, JSON.stringify(Object.keys(change))).toBe(400);
    }
    const { nonce: _nonce, ...withoutNonce } = form;
    void _nonce;
    expect((await confirm(w, shopper, intentId, withoutNonce)).status).toBe(400);
    expect(w.db.checkoutCalls()).toHaveLength(before);

    const { acknowledged: _acknowledged, ...unacknowledged } = form;
    void _acknowledged;
    const response = await confirm(w, shopper, intentId, unacknowledged);
    expect(response.headers.get("location")).toBe(`/checkout/${intentId}?error=ACKNOWLEDGEMENT_REQUIRED`);
    expect(w.db.sent("consumeChallenge")).toEqual([]);

    expect((await confirm(w, shopper, `ci_${hex32(404)}`, form)).status).toBe(404);
    expect((await handlePgConfirm(post("/checkout/x/confirm", shopper, form), w.services, "not-an-id")).status).toBe(404);
    expect(w.db.sent("consumeChallenge")).toEqual([]);
  });
});

describe("PostgreSQL mode: cancel, replacement and starting another (A21, A22)", () => {
  it("maps every result of cancel_checkout", async () => {
    const expected: Record<string, number | string> = { CANCELED: "?notice=CANCELED", NOT_CANCELABLE: "?error=NOT_CANCELABLE", NOT_AUTHORIZED: 404, RATE_LIMITED: 429, REQUEST_INVALID: 400 };
    for (const [result, outcome] of Object.entries(expected)) {
      const w = world();
      const shopper = await signIn(w.services);
      const intentId = `ci_${hex32(30)}`;
      w.db.checkouts.set(intentId, readRow(intentId));
      w.db.on("cancelCheckout", () => [{ result }]);
      const response = await handlePgCancel(post(`/checkout/${intentId}/cancel`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);
      if (typeof outcome === "number") expect(response.status, result).toBe(outcome);
      else expect(response.headers.get("location"), result).toBe(`/checkout/${intentId}${outcome}`);
      expect(w.db.sent("cancelCheckout"), result).toEqual([[1, shopper.context.credential.tokenDigest, intentId]]);
    }
  });

  it("A22: a replacement is offered and sent only for a QUOTED or USER_CONFIRMED predecessor, expired and stale quotes included", async () => {
    const decode = (row: Row) => {
      const read = decodeCheckoutRead(row);
      if (!read.authorized) throw new Error("not authorized");
      return read.checkout;
    };
    const item = { productId: "dmp_codebook15", variantId: "dmv_codebook15a", quantity: 1 };
    const id = `ci_${hex32(40)}`;
    const none = { review: false, cancel: false, replace: null, startAnother: null, successorIntentId: null };
    // The actions of each stored state.
    expect(pgCheckoutActions(decode(readRow(id)), true)).toEqual({ ...none, cancel: true });
    expect(pgCheckoutActions(decode(readRow(id)), false)).toEqual({ ...none, cancel: true, review: true });
    expect(pgCheckoutActions(decode(readRow(id, { effective_status: "QUOTE_EXPIRED" })), false)).toEqual({ ...none, cancel: true, replace: item });
    expect(pgCheckoutActions(decode(readRow(id, { quote_stale: true })), false)).toEqual({ ...none, cancel: true, replace: item });
    expect(pgCheckoutActions(decode(readRow(id, { stored_state: "USER_CONFIRMED", effective_status: "USER_CONFIRMED", row_version: 3 })), false)).toEqual({ ...none, cancel: true, replace: item });
    const successor = `ci_${hex32(41)}`;
    expect(pgCheckoutActions(decode(readRow(id, { stored_state: "SUPERSEDED", effective_status: "SUPERSEDED", row_version: 3, superseded_by_intent_id: successor })), false)).toEqual({ ...none, successorIntentId: successor });

    // Sent: the predecessor id is the sixth value of start_checkout.
    for (const state of [{}, { effective_status: "QUOTE_EXPIRED" }, { quote_stale: true }, { stored_state: "USER_CONFIRMED", effective_status: "USER_CONFIRMED", row_version: 3 }]) {
      const w = world();
      const shopper = await signIn(w.services);
      w.db.checkouts.set(id, readRow(id, state));
      const { location } = await startCheckout(w, shopper, { replaces: id });
      expect(location, JSON.stringify(state)).toMatch(/^\/checkout\/ci_[0-9a-f]{32}$/);
      expect(w.db.sent("startCheckout").map((values) => values[5]), JSON.stringify(state)).toEqual([id]);
    }

    // The database's own refusal leads back to the predecessor's page.
    const w = world();
    const shopper = await signIn(w.services);
    w.db.checkouts.set(id, readRow(id));
    w.db.on("startCheckout", () => [{ result: "REPLACEMENT_NOT_ALLOWED", intent_id: null, quote_id: null, quote_expires_at: null }]);
    expect((await startCheckout(w, shopper, { replaces: id })).location).toBe(`/checkout/${id}?error=REPLACEMENT_NOT_ALLOWED`);
    // A predecessor that is missing or belongs to another owner: the generic refusal, and no start call.
    const other = world();
    const otherShopper = await signIn(other.services);
    expect((await startCheckout(other, otherShopper, { replaces: `ci_${hex32(404)}` })).response.status).toBe(403);
    expect(other.db.sent("startCheckout")).toEqual([]);
  });

  it("A21: a canceled checkout offers Start another with no predecessor; a canceled or superseded id is never sent as one, and the canceled record is unchanged", async () => {
    const decode = (row: Row) => {
      const read = decodeCheckoutRead(row);
      if (!read.authorized) throw new Error("not authorized");
      return read.checkout;
    };
    const id = `ci_${hex32(50)}`;
    const canceled = readRow(id, { stored_state: "CANCELED_LOCAL", effective_status: "CANCELED_LOCAL", row_version: 3 });
    expect(pgCheckoutActions(decode(canceled), false)).toEqual({ review: false, cancel: false, replace: null, startAnother: { productId: "dmp_codebook15", variantId: "dmv_codebook15a", quantity: 1 }, successorIntentId: null });

    // Start another: the form carries no predecessor, and the call's sixth value is NULL.
    const w = world();
    const shopper = await signIn(w.services);
    w.db.checkouts.set(id, { ...canceled });
    const { location } = await startCheckout(w, shopper);
    expect(location).toMatch(/^\/checkout\/ci_[0-9a-f]{32}$/);
    expect(w.db.sent("startCheckout").map((values) => values[5])).toEqual([null]);
    expect(w.db.checkouts.get(id)).toEqual(canceled);

    // A forged replacement of a canceled or superseded checkout is refused after the handler's own read.
    for (const state of [
      { stored_state: "CANCELED_LOCAL", effective_status: "CANCELED_LOCAL", row_version: 3 },
      { stored_state: "SUPERSEDED", effective_status: "SUPERSEDED", row_version: 3, superseded_by_intent_id: `ci_${hex32(51)}` },
      { stored_state: "EXPIRED", effective_status: "EXPIRED", row_version: 3 },
    ]) {
      const forged = world();
      const forger = await signIn(forged.services);
      forged.db.checkouts.set(id, readRow(id, state));
      const { location: back } = await startCheckout(forged, forger, { replaces: id });
      expect(back, state.stored_state).toBe(`/checkout/${id}?error=REPLACEMENT_NOT_ALLOWED`);
      expect(forged.db.sent("startCheckout"), state.stored_state).toEqual([]);
    }
  });
});

describe("PostgreSQL mode: limits, simulation and the owner list (A28, A34)", () => {
  it("A28: the in-process limit is applied first and sends no checkout call; the database's RATE_LIMITED is the 429 too", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = await startedIntent(w, shopper);
    const form = await formOf(w, shopper, intentId);
    // Ten confirmations a minute pass the in-process policy; each is answered by the database.
    w.db.on("consumeChallenge", () => [{ result: "RATE_LIMITED", intent_id: null }]);
    for (let attempt = 1; attempt <= 10; attempt += 1) expect((await confirm(w, shopper, intentId, form)).status, `attempt ${attempt}`).toBe(429);
    expect(w.db.sent("consumeChallenge")).toHaveLength(10);
    // The eleventh is stopped before the database is asked about the checkout at all.
    const calls = w.db.checkoutCalls().length;
    expect((await confirm(w, shopper, intentId, form)).status).toBe(429);
    expect(w.db.checkoutCalls()).toHaveLength(calls);
  });

  it("A34: the simulation route is always not found for an authorized request, and forbidden without a session", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = await startedIntent(w, shopper);
    const calls = w.db.checkoutCalls().length;
    for (const step of ["create_order", "capture", "cancel"]) {
      const response = await handlePgSimulate(post(`/checkout/${intentId}/simulate`, shopper, { step, csrfToken: shopper.csrfToken }), w.services);
      expect(response.status, step).toBe(404);
    }
    expect((await handlePgSimulate(post(`/checkout/${intentId}/simulate`, null, { step: "cancel" }), w.services)).status).toBe(403);
    expect(w.db.checkoutCalls()).toHaveLength(calls);
  });

  it("the owner list shows what the database returned, refuses more than 100 rows, and is 'not available' on a failure", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const a = await startedIntent(w, shopper);
    const b = await startedIntent(w, shopper);
    const list = await buildPgCheckoutList(w.services, shopper.context);
    expect(list.kind === "OK" ? list.value.map((item) => [item.intentId, item.effectiveStatus]) : null).toEqual([[a, "QUOTED"], [b, "QUOTED"]]);
    expect(w.db.sent("listOwnerCheckouts").at(-1)).toEqual([1, shopper.context.credential.tokenDigest]);

    const row = { intent_id: a, purchase_group_id: GROUP, stored_state: "QUOTED", effective_status: "QUOTED", intent_created_at: T0, quote_expires_at: T0 };
    w.db.on("listOwnerCheckouts", () => Array.from({ length: 101 }, () => ({ ...row })));
    expect(await buildPgCheckoutList(w.services, shopper.context)).toEqual({ kind: "UNAVAILABLE" });
    w.db.on("listOwnerCheckouts", () => Promise.reject(new Error("timeout")));
    expect(await buildPgCheckoutList(w.services, shopper.context)).toEqual({ kind: "UNAVAILABLE" });
  });
});

describe("PostgreSQL mode: the recommendations on the database's catalog (A26)", () => {
  const catalogRows = (): Row[] =>
    [...DEMO_MERCHANT_CATALOG.products]
      .sort((left, right) => left.productId.localeCompare(right.productId))
      .flatMap((product) =>
        [...product.variants]
          .sort((left, right) => left.variantId.localeCompare(right.variantId))
          .map((variant) => ({
            merchant_id: DEMO_MERCHANT_CATALOG.merchant.merchantId,
            merchant_display_name: DEMO_MERCHANT_CATALOG.merchant.displayName,
            merchant_simulated_sandbox: DEMO_MERCHANT_CATALOG.merchant.simulatedSandbox,
            product_id: product.productId,
            product_title: product.title,
            product_description: product.description,
            product_image_path: product.imagePath,
            product_catalog_revision: DEMO_MERCHANT_CATALOG.revision,
            variant_id: variant.variantId,
            variant_label: variant.label,
            unit_amount_cents: variant.unitAmountCents,
            currency: variant.currency,
            max_quantity_per_order: variant.maxQuantityPerOrder,
            availability: variant.availability,
            specs: { ...variant.specs },
            variant_catalog_revision: DEMO_MERCHANT_CATALOG.revision,
          })),
      );

  it("A26: one catalog statement per view; the same assessments, order and quotable flags as the mock gives for the fixture", async () => {
    const w = world();
    w.db.on("readCatalog", () => catalogRows());
    const preferences = parsePreferences("programming", "900");
    if (!preferences) throw new Error("test preferences refused");

    const page = await buildPgShoppingView(w.services, preferences);
    expect(w.db.sent("readCatalog")).toEqual([[]]);
    if (page.kind !== "OK") throw new Error("the view is not available");

    const mock = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: w.time.clock });
    const expected = await buildShoppingView(mock, preferences, "pg-app-flow-session");
    // Compared by variant: where two variants have the same status and price, their order follows the order the
    // catalog was read in, which is by id here and by the fixture's own order in the mock.
    const shape = (view: typeof expected) =>
      view.variants.map((entry) => `${entry.variant.variantId}|${entry.assessment.status}|${String(entry.quotable)}|${entry.variant.unitAmountCents}`).sort();
    expect(shape(page.value)).toEqual(shape(expected));
    expect(page.value.variants).toHaveLength(expected.variants.length);
    expect(page.value.merchantName).toBe(expected.merchantName);
    expect(page.value.external).toEqual(expected.external);

    // Nothing is kept: a second view sends the statement again.
    await buildPgShoppingView(w.services, preferences);
    expect(w.db.sent("readCatalog")).toHaveLength(2);
  });

  it("A26: a catalog that cannot be read or is not coherent is 'not available', never the fixture catalog", async () => {
    const preferences = parsePreferences("programming", "900");
    if (!preferences) throw new Error("test preferences refused");
    const scripts: Array<[string, Script]> = [
      ["a database error", () => Promise.reject(new Error("timeout"))],
      ["no rows", () => []],
      ["a variant at another revision", () => catalogRows().map((row, index) => (index === 0 ? { ...row, variant_catalog_revision: 99 } : row))],
      ["an amount as text", () => catalogRows().map((row, index) => (index === 0 ? { ...row, unit_amount_cents: "79900" } : row))],
    ];
    for (const [label, script] of scripts) {
      const w = world();
      w.db.on("readCatalog", script);
      expect(await loadPgCatalog(w.services), label).toBeNull();
      expect(await buildPgShoppingView(w.services, preferences), label).toEqual({ kind: "UNAVAILABLE" });
    }
  });
});

describe("PostgreSQL mode: amounts are decoded per field, and a refused row leads nowhere (A47)", () => {
  const amounts = (overrides: Row = {}): Row => ({ quantity: 1, unit_amount_cents: "79900", subtotal_cents: "79900", discount_cents: "0", tax_cents: "0", shipping_cents: "0", total_cents: "79900", ...overrides });
  const fieldOf = (row: Row): string | null => {
    try {
      decodeCheckoutAmounts(row);
      return null;
    } catch (error) {
      if (error instanceof UnexpectedRowError) return error.field;
      throw error;
    }
  };

  it("accepts the valid boundaries, with internally consistent rows", () => {
    expect(decodeCheckoutAmounts(amounts({ unit_amount_cents: "1", subtotal_cents: "1", total_cents: "1" }))).toEqual({ quantity: 1, unitAmountCents: 1, subtotalCents: 1, discountCents: 0, taxCents: 0, shippingCents: 0, totalCents: 1 });
    expect(decodeCheckoutAmounts(amounts({ unit_amount_cents: "2000000", subtotal_cents: "2000000", total_cents: "2000000" })).unitAmountCents).toBe(2_000_000);
    expect(decodeCheckoutAmounts(amounts({ quantity: 10, unit_amount_cents: "2000000", subtotal_cents: "20000000", total_cents: "20000000" }))).toMatchObject({ quantity: 10, subtotalCents: 20_000_000, totalCents: 20_000_000 });
    expect(decodeCheckoutAmounts(amounts()).totalCents).toBe(79_900);
  });

  it("refuses a value below or above the range of its own field, and names that field", () => {
    expect(fieldOf(amounts({ unit_amount_cents: "0" }))).toBe("unit_amount_cents");
    expect(fieldOf(amounts({ unit_amount_cents: "2000001", subtotal_cents: "2000001", total_cents: "2000001" }))).toBe("unit_amount_cents");
    expect(fieldOf(amounts({ subtotal_cents: "0" }))).toBe("subtotal_cents");
    expect(fieldOf(amounts({ quantity: 10, unit_amount_cents: "2000000", subtotal_cents: "20000001", total_cents: "20000001" }))).toBe("subtotal_cents");
    expect(fieldOf(amounts({ total_cents: "0" }))).toBe("total_cents");
    expect(fieldOf(amounts({ quantity: 10, unit_amount_cents: "2000000", subtotal_cents: "20000000", total_cents: "20000001" }))).toBe("total_cents");
  });

  it("accepts only the text 0 for discount, tax and shipping, each by itself", () => {
    for (const field of ["discount_cents", "tax_cents", "shipping_cents"]) {
      expect(fieldOf(amounts({ [field]: "0" })), field).toBeNull();
      for (const value of ["1", "00", "-0", "", 0, null, undefined, BigInt(0)]) expect(fieldOf(amounts({ [field]: value })), `${field}: ${String(value)}`).toBe(field);
    }
  });

  it("refuses malformed integer text and every driver type but text, for each of the three amounts", () => {
    for (const field of ["unit_amount_cents", "subtotal_cents", "total_cents"]) {
      for (const value of ["079900", "-1", "+1", "1e5", " 1", "1 ", "1.0", "", 79900, BigInt(79900), null, undefined, { value: "79900" }]) {
        expect(fieldOf(amounts({ [field]: value })), `${field}: ${typeof value}`).toBe(field);
      }
    }
  });

  it("holds the quantity to 1 through 10 as an integer number", () => {
    expect(fieldOf(amounts({ quantity: 1 }))).toBeNull();
    expect(decodeCheckoutAmounts(amounts({ quantity: 10, unit_amount_cents: "100", subtotal_cents: "1000", total_cents: "1000" })).quantity).toBe(10);
    for (const value of [0, 11, 1.5, "1", null]) expect(fieldOf(amounts({ quantity: value })), String(value)).toBe("quantity");
  });

  it("refuses an arithmetic mismatch among values that are each in range", () => {
    expect(fieldOf(amounts({ quantity: 2, unit_amount_cents: "100", subtotal_cents: "300", total_cents: "300" }))).toBe("subtotal_cents: arithmetic");
    expect(fieldOf(amounts({ quantity: 2, unit_amount_cents: "100", subtotal_cents: "200", total_cents: "201" }))).toBe("total_cents: arithmetic");
  });

  it("a refused row renders nothing, is 'not available' or an internal error, names only the field in the log, and is followed by no mutating call", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = `ci_${hex32(60)}`;
    const marker = "98765";
    w.db.checkouts.set(intentId, readRow(intentId, { unit_amount_cents: `0${marker}`, challenge_id: `cf_${"7".repeat(32)}` }));

    expect(await buildPgCheckoutView(w.services, shopper.context, intentId)).toEqual({ kind: "UNAVAILABLE" });

    const fields = { confirmationId: `cf_${"7".repeat(32)}`, nonce: deriveConfirmationNonce(NONCE_KEY_1, { challengeId: `cf_${"7".repeat(32)}`, ownerId: OWNER, quoteDigest: QUOTE_DIGEST }), quoteId: `qt_${intentId.slice(3)}`, quoteDigest: QUOTE_DIGEST, acknowledged: "yes", csrfToken: shopper.csrfToken };
    const confirmed = await confirm(w, shopper, intentId, fields);
    expect(confirmed.status).toBe(500);
    expect(JSON.stringify(await confirmed.json())).not.toContain(marker);
    const reviewed = await handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);
    expect(reviewed.status).toBe(500);
    const replaced = await startCheckout(w, shopper, { replaces: intentId });
    expect(replaced.response.status).toBe(500);

    expect(w.db.checkoutCalls().filter((name) => name !== "readCheckout")).toEqual([]);
    expect(logged.join("\n")).toContain("row:unit_amount_cents");
    expect(logged.join("\n")).not.toContain(marker);
  });
});

describe("PostgreSQL mode: nothing secret or internal reaches a response or the log (A29)", () => {
  it("no response of a whole flow, and no log line, holds a digest, an owner id, a key, a connection detail or a database message; the nonce appears only in the form", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const responses: Response[] = [];
    const { response: started, location } = await startCheckout(w, shopper);
    responses.push(started);
    const intentId = location.slice("/checkout/".length);
    const form = await formOf(w, shopper, intentId);
    responses.push(await confirm(w, shopper, intentId, { ...form, nonce: deriveConfirmationNonce(NONCE_KEY_2, { challengeId: form.confirmationId, ownerId: OWNER, quoteDigest: QUOTE_DIGEST }) }));
    responses.push(await handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId));
    const detail = "relation shopaccess.checkout_intents: permission denied for host db.example.test";
    w.db.on("cancelCheckout", () => Promise.reject(Object.assign(new Error(detail), { code: "42501" })));
    responses.push(await handlePgCancel(post(`/checkout/${intentId}/cancel`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId));
    w.db.on("consumeChallenge", () => Promise.reject(new Error(detail)));
    responses.push(await confirm(w, shopper, intentId, form));
    responses.push(await handlePgSimulate(post(`/checkout/${intentId}/simulate`, shopper, { step: "cancel", csrfToken: shopper.csrfToken }), w.services));
    responses.push(await handlePgConfirm(post(`/checkout/${intentId}/confirm`, null, form), w.services, intentId));

    const row = w.db.checkouts.get(intentId) ?? {};
    const secrets = [
      shopper.context.credential.tokenDigest,
      String(row.challenge_nonce_digest),
      String(row.quote_digest),
      OWNER,
      SESSION_KEY.toString("base64"),
      NONCE_KEY_1.toString("base64"),
      DATABASE_URL,
      "db.example.test",
      detail,
      "permission denied",
      form.nonce,
    ];
    for (const response of responses) {
      const text = `${await response.clone().text()}\n${[...response.headers.entries()].map((entry) => entry.join(": ")).join("\n")}`;
      for (const secret of secrets) expect(text.includes(secret), `a response holds ${secrets.indexOf(secret)}`).toBe(false);
    }
    for (const line of logged) for (const secret of secrets) expect(line.includes(secret), `a log line holds ${secrets.indexOf(secret)}`).toBe(false);
    // The log names the failure by its five-character code.
    expect(logged.some((line) => line.includes("sqlstate:42501"))).toBe(true);
    // The nonce is in the form the page shows, and nowhere else.
    expect(form.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("PostgreSQL mode: the start quantity is held to the entry point's 1 through 10", () => {
  it("accepts 1 and 10 and sends them; refuses 11 and anything above or below before any checkout call", async () => {
    for (const quantity of ["1", "10"]) {
      const w = world();
      const shopper = await signIn(w.services);
      const { response, location } = await startCheckout(w, shopper, { quantity });
      expect(response.status, quantity).toBe(303);
      expect(location, quantity).toMatch(/^\/checkout\/ci_[0-9a-f]{32}$/);
      expect(w.db.sent("startCheckout").map((values) => values[4]), quantity).toEqual([Number(quantity)]);
    }
    const w = world();
    const shopper = await signIn(w.services);
    for (const quantity of ["11", "12", "100", "1000", "0", "-1", "1.5", "10.0001", "1e1x", ""]) {
      const { response } = await startCheckout(w, shopper, { quantity });
      expect(response.status, JSON.stringify(quantity)).toBe(400);
    }
    expect(w.db.checkoutCalls()).toEqual([]);
  });
});

describe("PostgreSQL mode: a refusal row carries nothing, and one that does is an unexpected row", () => {
  const rejectedField = async (work: Promise<unknown>): Promise<string | null> => {
    try {
      await work;
      return null;
    } catch (error) {
      if (error instanceof UnexpectedRowError) return error.field;
      throw error;
    }
  };
  const decodedField = (row: Row): string | null => {
    try {
      decodeCheckoutRead(row);
      return null;
    } catch (error) {
      if (error instanceof UnexpectedRowError) return error.field;
      throw error;
    }
  };

  it("read_checkout NOT_AUTHORIZED: every one of the forty other columns must be NULL", async () => {
    expect(READ_CHECKOUT_DATA_COLUMNS).toHaveLength(40);
    // The list is the statement's own column list after `result`.
    const selected = CHECKOUT_STATEMENTS.readCheckout.slice("SELECT ".length, CHECKOUT_STATEMENTS.readCheckout.indexOf(" FROM ")).split(", ");
    expect(["result", ...READ_CHECKOUT_DATA_COLUMNS]).toEqual(selected);

    // The valid shape: NOT_AUTHORIZED and forty NULLs.
    expect(decodeCheckoutRead({ ...NOT_AUTHORIZED_READ })).toEqual({ authorized: false });
    // Each column by itself: any value, false and zero included, and a column that is missing.
    const filled = readRow(`ci_${hex32(70)}`, { challenge_id: `cf_${"7".repeat(32)}`, challenge_quote_digest: QUOTE_DIGEST, challenge_nonce_key_version: 1, challenge_nonce_digest: "e".repeat(64), challenge_summary: { ...SUMMARY }, challenge_issued_at: T0, challenge_expires_at: T0, replaces_intent_id: `ci_${hex32(71)}`, superseded_by_intent_id: `ci_${hex32(72)}` });
    for (const column of READ_CHECKOUT_DATA_COLUMNS) {
      expect(filled[column], column).not.toBeNull();
      expect(decodedField({ ...NOT_AUTHORIZED_READ, [column]: filled[column] }), column).toBe(column);
      const { [column]: _removed, ...missing } = NOT_AUTHORIZED_READ;
      void _removed;
      expect(decodedField(missing), `${column} missing`).toBe(column);
    }
    for (const value of [false, 0, "", "0"]) expect(decodedField({ ...NOT_AUTHORIZED_READ, quote_stale: value }), JSON.stringify(value)).toBe("quote_stale");

    // Through the application: such a row is not "not found". It is the unexpected-row path, and nothing follows it.
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = `ci_${hex32(73)}`;
    w.db.on("readCheckout", () => [{ ...NOT_AUTHORIZED_READ, owner_id: OWNER }]);
    expect(await buildPgCheckoutView(w.services, shopper.context, intentId)).toEqual({ kind: "UNAVAILABLE" });
    const reviewed = await handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);
    expect(reviewed.status).toBe(500);
    const canceledForm = { confirmationId: `cf_${"7".repeat(32)}`, nonce: deriveConfirmationNonce(NONCE_KEY_1, { challengeId: `cf_${"7".repeat(32)}`, ownerId: OWNER, quoteDigest: QUOTE_DIGEST }), quoteId: `qt_${hex32(73)}`, quoteDigest: QUOTE_DIGEST, acknowledged: "yes", csrfToken: shopper.csrfToken };
    expect((await confirm(w, shopper, intentId, canceledForm)).status).toBe(500);
    expect(w.db.checkoutCalls().filter((name) => name !== "readCheckout")).toEqual([]);
    expect(logged.join("\n")).toContain("row:owner_id");
    // The ordinary answer is still "not found".
    w.db.on("readCheckout", () => [{ ...NOT_AUTHORIZED_READ }]);
    expect(await buildPgCheckoutView(w.services, shopper.context, intentId)).toEqual({ kind: "NOT_FOUND" });
  });

  it("issue_challenge: every result but ISSUED and REUSED must have all six data columns NULL", async () => {
    expect([...ISSUE_CHALLENGE_DATA_COLUMNS]).toEqual(["challenge_id", "quote_digest", "nonce_key_version", "nonce_digest", "summary", "expires_at"]);
    const selected = CHECKOUT_STATEMENTS.issueChallenge.slice("SELECT ".length, CHECKOUT_STATEMENTS.issueChallenge.indexOf(" FROM ")).split(", ");
    expect(["result", ...ISSUE_CHALLENGE_DATA_COLUMNS]).toEqual(selected);

    const empty: Row = { challenge_id: null, quote_digest: null, nonce_key_version: null, nonce_digest: null, summary: null, expires_at: null };
    const carried: Row = { challenge_id: `cf_${"7".repeat(32)}`, quote_digest: QUOTE_DIGEST, nonce_key_version: 1, nonce_digest: "e".repeat(64), summary: { ...SUMMARY }, expires_at: T0 };
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = `ci_${hex32(74)}`;
    w.db.checkouts.set(intentId, readRow(intentId));
    const trusted = decodeCheckoutRead(readRow(intentId));
    if (!trusted.authorized) throw new Error("the trusted row was refused");
    const issue = () => w.services.checkout.issue(shopper.context.credential, { intentId, checkout: trusted.checkout });

    for (const result of [...ISSUE_REFUSALS, "NONCE_KEY_NOT_ACTIVE", "REFUSED"]) {
      // The valid shape is an ordinary outcome, not an error.
      w.db.on("issueChallenge", () => [{ result, ...empty }]);
      const outcome = await issue();
      expect(outcome.outcome, result).toBe(result === "NONCE_KEY_NOT_ACTIVE" || result === "REFUSED" ? "NOT_READY" : "REFUSED");
      // Each data column by itself, with a value and missing.
      for (const column of ISSUE_CHALLENGE_DATA_COLUMNS) {
        w.db.on("issueChallenge", () => [{ result, ...empty, [column]: carried[column] }]);
        expect(await rejectedField(issue()), `${result}: ${column}`).toBe(column);
        w.db.on("issueChallenge", () => {
          const { [column]: _removed, ...missing } = empty;
          void _removed;
          return [{ result, ...missing }];
        });
        expect(await rejectedField(issue()), `${result}: ${column} missing`).toBe(column);
      }
    }

    // Through the application: a refusal that carries a value is not shown as that refusal.
    w.db.on("issueChallenge", () => [{ result: "QUOTE_EXPIRED", ...empty, challenge_id: carried.challenge_id }]);
    const reviewed = await handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);
    expect(reviewed.headers.get("location")).toBe(`/checkout/${intentId}?error=REVIEW_NOT_READY`);
    expect(logged.join("\n")).toContain("row:challenge_id");
    w.db.on("issueChallenge", () => [{ result: "QUOTE_EXPIRED", ...empty }]);
    const expired = await handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);
    expect(expired.headers.get("location")).toBe(`/checkout/${intentId}?error=QUOTE_EXPIRED`);
  });
});

describe("PostgreSQL mode: start refusals carry nothing, and both success rows of issue_challenge are read completely", () => {
  const rejectedField = async (work: Promise<unknown>): Promise<string | null> => {
    try {
      await work;
      return null;
    } catch (error) {
      if (error instanceof UnexpectedRowError) return error.field;
      throw error;
    }
  };
  const trustedCheckout = (intentId: string, overrides: Row = {}): CheckoutRead => {
    const read = decodeCheckoutRead(readRow(intentId, overrides));
    if (!read.authorized) throw new Error("the trusted row was refused");
    return read.checkout;
  };
  const QUOTE_EXPIRES = new Date(T0.getTime() + 15 * MINUTE);

  it("start_checkout: every refusal must have intent_id, quote_id and quote_expires_at NULL; a row that carries or lacks one is an unexpected row", async () => {
    expect([...START_CHECKOUT_DATA_COLUMNS]).toEqual(["intent_id", "quote_id", "quote_expires_at"]);
    const selected = CHECKOUT_STATEMENTS.startCheckout.slice("SELECT ".length, CHECKOUT_STATEMENTS.startCheckout.indexOf(" FROM ")).split(", ");
    expect(["result", ...START_CHECKOUT_DATA_COLUMNS]).toEqual(selected);

    const empty: Row = { intent_id: null, quote_id: null, quote_expires_at: null };
    const carried: Row = { intent_id: `ci_${hex32(90)}`, quote_id: `qt_${hex32(90)}`, quote_expires_at: QUOTE_EXPIRES };
    const w = world();
    const shopper = await signIn(w.services);
    const start = () => w.services.checkout.start(shopper.context.credential, { productId: "dmp_codebook15", variantId: "dmv_codebook15a", quantity: 1, replacesIntentId: null });

    for (const result of START_REFUSALS) {
      // The valid shape: the refusal, as an ordinary result.
      w.db.on("startCheckout", () => [{ result, ...empty }]);
      expect(await start(), result).toEqual({ result });
      for (const column of START_CHECKOUT_DATA_COLUMNS) {
        w.db.on("startCheckout", () => [{ result, ...empty, [column]: carried[column] }]);
        expect(await rejectedField(start()), `${result}: ${column}`).toBe(column);
        w.db.on("startCheckout", () => {
          const { [column]: _removed, ...missing } = empty;
          void _removed;
          return [{ result, ...missing }];
        });
        expect(await rejectedField(start()), `${result}: ${column} missing`).toBe(column);
      }
    }
    // STARTED still requires all three, with their types.
    w.db.on("startCheckout", () => [{ result: "STARTED", ...carried }]);
    expect(await start()).toEqual({ result: "STARTED", intentId: carried.intent_id, quoteId: carried.quote_id, quoteExpiresAt: QUOTE_EXPIRES });
    for (const column of START_CHECKOUT_DATA_COLUMNS) {
      w.db.on("startCheckout", () => [{ result: "STARTED", ...carried, [column]: null }]);
      expect(await rejectedField(start()), `STARTED: ${column} NULL`).toBe(column);
    }

    // Through the application: a refusal that carries an intent is not shown as that refusal. Whether a checkout
    // exists is not known, so the answer is the uncertain-start notice, and nothing is sent again.
    const calls = w.db.sent("startCheckout").length;
    w.db.on("startCheckout", () => [{ result: "VARIANT_UNAVAILABLE", ...empty, intent_id: carried.intent_id }]);
    const { location } = await startCheckout(w, shopper);
    expect(location).toBe("/checkouts?notice=START_UNCERTAIN");
    expect(w.db.sent("startCheckout")).toHaveLength(calls + 1);
    expect(logged.join("\n")).toContain("row:intent_id");
  });

  it("issue_challenge ISSUED and REUSED: every field is required, of its type, and bound to the trusted checkout and the named key version", () => {
    const intentId = `ci_${hex32(91)}`;
    const checkout = trustedCheckout(intentId);
    const challengeId = `cf_${"a".repeat(32)}`;
    const good: Row = { challenge_id: challengeId, quote_digest: QUOTE_DIGEST, nonce_key_version: 1, nonce_digest: "e".repeat(64), summary: { ...SUMMARY }, expires_at: new Date(T0.getTime() + 5 * MINUTE) };
    const fieldOf = (row: Row, against: CheckoutRead = checkout, version = 1): string | null => {
      try {
        decodeIssuedChallenge(row, against, version);
        return null;
      } catch (error) {
        if (error instanceof UnexpectedRowError) return error.field;
        throw error;
      }
    };

    expect(decodeIssuedChallenge(good, checkout, 1)).toEqual({ challengeId, quoteDigest: QUOTE_DIGEST, nonceKeyVersion: 1, nonceDigest: "e".repeat(64), summary: SUMMARY, expiresAt: good.expires_at });

    // Each field missing, NULL, and of a wrong type or form.
    const malformed: Record<string, unknown[]> = {
      challenge_id: [undefined, null, "", "cf_short", `ci_${"a".repeat(32)}`, `cf_${"A".repeat(32)}`, 7],
      quote_digest: [undefined, null, "", "c".repeat(63), QUOTE_DIGEST.toUpperCase(), 7],
      nonce_key_version: [undefined, null, "1", 0, -1, 1.5, 32_768],
      nonce_digest: [undefined, null, "", "e".repeat(63), "E".repeat(64), 7],
      summary: [undefined, null, "{}", [], {}, { ...SUMMARY, extra: 1 }, { ...SUMMARY, quantity: "1" }, { ...SUMMARY, totalCents: "79900" }, { ...SUMMARY, merchantName: "" }, { ...SUMMARY, currency: "EUR" }, (({ variantLabel: _dropped, ...rest }) => rest)(SUMMARY)],
      expires_at: [undefined, null, "2026-10-08T12:05:00.000Z", 1_791_000_000_000, new Date(Number.NaN)],
    };
    expect(Object.keys(malformed).sort()).toEqual([...ISSUE_CHALLENGE_DATA_COLUMNS].sort());
    for (const [column, values] of Object.entries(malformed)) {
      for (const value of values) expect(fieldOf({ ...good, [column]: value }), `${column}: ${JSON.stringify(value) ?? "undefined"}`).toBe(column);
      const { [column]: _removed, ...missing } = good;
      void _removed;
      expect(fieldOf(missing), `${column} missing`).toBe(column);
    }

    // Well-formed values that are not the trusted checkout's, or not the named key version.
    expect(fieldOf({ ...good, quote_digest: "d".repeat(64) })).toBe("quote_digest");
    expect(fieldOf({ ...good, nonce_key_version: 2 })).toBe("nonce_key_version");
    expect(fieldOf(good, checkout, 2)).toBe("nonce_key_version");
    for (const change of [{ merchantName: "Another Store" }, { productTitle: "CodeBook 13" }, { variantLabel: "8 GB, 256 GB" }, { quantity: 2 }, { totalCents: 79_901 }]) {
      expect(fieldOf({ ...good, summary: { ...SUMMARY, ...change } }), JSON.stringify(change)).toBe("summary");
    }
    // The same summary against a checkout that differs in one of those values.
    for (const overrides of [{ merchant_display_name: "Another Store" }, { product_title: "CodeBook 13" }, { variant_label: "8 GB, 256 GB" }, { quantity: 2, unit_amount_cents: "39950" }]) {
      expect(fieldOf(good, trustedCheckout(intentId, overrides)), JSON.stringify(overrides)).toBe("summary");
    }

    // The challenge does not outlive its quote: at the quote's expiry is accepted, one millisecond later is not.
    expect(fieldOf({ ...good, expires_at: new Date(QUOTE_EXPIRES.getTime()) })).toBeNull();
    expect(fieldOf({ ...good, expires_at: new Date(QUOTE_EXPIRES.getTime() + 1) })).toBe("expires_at");
    // An expiry that has already passed is a valid answer: nothing here is compared with a clock.
    expect(fieldOf({ ...good, expires_at: new Date(T0.getTime() - 60 * MINUTE) })).toBeNull();
    expect(fieldOf({ ...good, expires_at: new Date(0) })).toBeNull();
  });

  it("ISSUED must be the challenge this call proposed; REUSED keeps its own id and is shown only if its nonce derives", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = `ci_${hex32(92)}`;
    w.db.checkouts.set(intentId, readRow(intentId));
    const checkout = trustedCheckout(intentId);
    const issue = () => w.services.checkout.issue(shopper.context.credential, { intentId, checkout });
    const echo = (values: readonly unknown[], overrides: Row = {}): Row[] => [
      { result: "ISSUED", challenge_id: values[3], quote_digest: QUOTE_DIGEST, nonce_key_version: values[4], nonce_digest: values[5], summary: { ...SUMMARY }, expires_at: new Date(T0.getTime() + 5 * MINUTE), ...overrides },
    ];

    // ISSUED, as sent: ready.
    w.db.on("issueChallenge", (values) => echo(values));
    expect(await issue()).toMatchObject({ outcome: "READY", result: "ISSUED" });
    // ISSUED with another id, another nonce digest, another quote digest, another key version, another summary, a
    // missing summary, or an expiry after the quote's: each is an unexpected row, not a challenge.
    const wrong: Array<[string, Row]> = [
      ["challenge_id", { challenge_id: `cf_${"b".repeat(32)}` }],
      ["nonce_digest", { nonce_digest: "1".repeat(64) }],
      ["quote_digest", { quote_digest: "d".repeat(64) }],
      ["nonce_key_version", { nonce_key_version: 2 }],
      ["summary", { summary: { ...SUMMARY, totalCents: 1 } }],
      ["summary", { summary: null }],
      ["expires_at", { expires_at: new Date(QUOTE_EXPIRES.getTime() + 1) }],
      ["expires_at", { expires_at: null }],
    ];
    for (const [field, overrides] of wrong) {
      w.db.on("issueChallenge", (values) => echo(values, overrides));
      expect(await rejectedField(issue()), `ISSUED: ${JSON.stringify(Object.keys(overrides))}`).toBe(field);
    }

    // REUSED: the existing challenge has its own id, which is not the id this call proposed.
    const existingId = `cf_${"d".repeat(32)}`;
    const existingDigest = confirmationNonceDigest(deriveConfirmationNonce(NONCE_KEY_1, { challengeId: existingId, ownerId: OWNER, quoteDigest: QUOTE_DIGEST }));
    const reused = (overrides: Row = {}): Row[] => [{ result: "REUSED", challenge_id: existingId, quote_digest: QUOTE_DIGEST, nonce_key_version: 1, nonce_digest: existingDigest, summary: { ...SUMMARY }, expires_at: new Date(T0.getTime() + 4 * MINUTE), ...overrides }];
    w.db.on("issueChallenge", () => reused());
    expect(await issue()).toEqual({ outcome: "READY", result: "REUSED", challengeId: existingId });
    expect(w.db.sent("issueChallenge").at(-1)?.[3]).not.toBe(existingId);
    // An expiry that passed while the answer travelled does not make the answer malformed.
    w.db.on("issueChallenge", () => reused({ expires_at: new Date(T0.getTime() - MINUTE) }));
    expect(await issue()).toEqual({ outcome: "READY", result: "REUSED", challengeId: existingId });
    // A well-formed digest this process cannot reproduce: not an error, and not shown.
    w.db.on("issueChallenge", () => reused({ nonce_digest: "2".repeat(64) }));
    expect(await issue()).toEqual({ outcome: "NOT_READY", reason: "REUSED_NOT_DERIVABLE" });
    // Malformed, missing or mismatched: an unexpected row.
    const wrongReuse: Array<[string, Row]> = [
      ["challenge_id", { challenge_id: null }],
      ["challenge_id", { challenge_id: "cf_short" }],
      ["quote_digest", { quote_digest: "d".repeat(64) }],
      ["nonce_key_version", { nonce_key_version: 2 }],
      ["nonce_key_version", { nonce_key_version: null }],
      ["nonce_digest", { nonce_digest: null }],
      ["summary", { summary: { ...SUMMARY, productTitle: "CodeBook 13" } }],
      ["summary", { summary: {} }],
      ["expires_at", { expires_at: new Date(QUOTE_EXPIRES.getTime() + 1) }],
      ["expires_at", { expires_at: "soon" }],
    ];
    for (const [field, overrides] of wrongReuse) {
      w.db.on("issueChallenge", () => reused(overrides));
      expect(await rejectedField(issue()), `REUSED: ${JSON.stringify(overrides)}`).toBe(field);
    }
    for (const column of ISSUE_CHALLENGE_DATA_COLUMNS) {
      w.db.on("issueChallenge", () => {
        const { [column]: _removed, ...missing } = reused()[0];
        void _removed;
        return [missing];
      });
      expect(await rejectedField(issue()), `REUSED: ${column} missing`).toBe(column);
    }

    // The trusted row must be the row of the intent asked for: otherwise nothing is sent.
    const sent = w.db.sent("issueChallenge").length;
    expect(await rejectedField(w.services.checkout.issue(shopper.context.credential, { intentId: `ci_${hex32(93)}`, checkout }))).toBe("intent_id");
    expect(w.db.sent("issueChallenge")).toHaveLength(sent);

    // Through the application: a malformed success row is not a shown challenge.
    w.db.on("issueChallenge", (values) => echo(values, { summary: { ...SUMMARY, totalCents: 1 } }));
    const reviewed = await handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId);
    expect(reviewed.headers.get("location")).toBe(`/checkout/${intentId}?error=REVIEW_NOT_READY`);
    expect(logged.join("\n")).toContain("row:summary");
  });
});

describe("PostgreSQL mode: the ACTIVE challenge that read_checkout reports is the challenge of its own quote", () => {
  const QUOTE_EXPIRES = new Date(T0.getTime() + 15 * MINUTE);
  const ID = `ci_${hex32(95)}`;
  /** A read row whose quote has an ACTIVE challenge that agrees with it. */
  const withChallenge = (overrides: Row = {}): Row =>
    readRow(ID, {
      challenge_id: `cf_${"5".repeat(32)}`,
      challenge_quote_digest: QUOTE_DIGEST,
      challenge_nonce_key_version: 1,
      challenge_nonce_digest: "e".repeat(64),
      challenge_summary: { ...SUMMARY },
      challenge_issued_at: T0,
      challenge_expires_at: new Date(T0.getTime() + 5 * MINUTE),
      challenge_usable: true,
      ...overrides,
    });
  const fieldOf = (row: Row): string | null => {
    try {
      decodeCheckoutRead(row);
      return null;
    } catch (error) {
      if (error instanceof UnexpectedRowError) return error.field;
      throw error;
    }
  };

  it("keeps a matching summary; refuses each summary value that differs, and an expiry later than the quote's; accepts an expiry at the quote's and one that has passed", () => {
    // The valid row: the summary is kept as the database stored it.
    const read = decodeCheckoutRead(withChallenge());
    if (!read.authorized || !read.checkout.challenge) throw new Error("the matching row was refused");
    expect(read.checkout.challenge.summary).toEqual(SUMMARY);
    expect(read.checkout.challenge.expiresAt).toEqual(new Date(T0.getTime() + 5 * MINUTE));
    expect(read.checkout.challengeUsable).toBe(true);

    // Each of the six values by itself, on the challenge's side.
    const differing: Row[] = [{ merchantName: "Another Store" }, { productTitle: "CodeBook 13" }, { variantLabel: "8 GB, 256 GB" }, { quantity: 2 }, { totalCents: 79_901 }, { currency: "EUR" }];
    for (const change of differing) expect(fieldOf(withChallenge({ challenge_summary: { ...SUMMARY, ...change } })), JSON.stringify(change)).toBe("challenge_summary");
    // And on the quote's side, with rows that are consistent in themselves.
    const quoteSide: Row[] = [
      { merchant_display_name: "Another Store" },
      { product_title: "CodeBook 13" },
      { variant_label: "8 GB, 256 GB" },
      { quantity: 2, unit_amount_cents: "39950" },
      { unit_amount_cents: "79901", subtotal_cents: "79901", total_cents: "79901" },
    ];
    for (const overrides of quoteSide) expect(fieldOf(withChallenge(overrides)), JSON.stringify(overrides)).toBe("challenge_summary");
    // The same quote-side rows are accepted when their challenge says the same.
    expect(fieldOf(withChallenge({ quantity: 2, unit_amount_cents: "39950", challenge_summary: { ...SUMMARY, quantity: 2 } }))).toBeNull();
    expect(fieldOf(withChallenge({ merchant_display_name: "Another Store", challenge_summary: { ...SUMMARY, merchantName: "Another Store" } }))).toBeNull();

    // The challenge does not outlive its quote. Nothing is compared with a clock.
    expect(fieldOf(withChallenge({ challenge_expires_at: new Date(QUOTE_EXPIRES.getTime()) }))).toBeNull();
    expect(fieldOf(withChallenge({ challenge_expires_at: new Date(QUOTE_EXPIRES.getTime() + 1) }))).toBe("challenge_expires_at");
    expect(fieldOf(withChallenge({ challenge_expires_at: new Date(T0.getTime() - 60 * MINUTE), challenge_usable: false }))).toBeNull();
    expect(fieldOf(withChallenge({ challenge_expires_at: new Date(1), challenge_usable: false }))).toBeNull();
    // A summary that is not a summary at all is refused as before, under the same name.
    expect(fieldOf(withChallenge({ challenge_summary: {} }))).toBe("challenge_summary");
    // A checkout with no ACTIVE challenge has nothing to compare.
    expect(fieldOf(readRow(ID))).toBeNull();
  });

  it("a read whose challenge disagrees with its quote is 'not available' on the page and an internal error in the handlers; its summary is never rendered and nothing is sent after it", async () => {
    const cases: Array<[string, Row, string]> = [
      ["a summary of another seller", { challenge_summary: { ...SUMMARY, merchantName: "Tampered Store 4711" } }, "row:challenge_summary"],
      ["a summary of another total", { challenge_summary: { ...SUMMARY, totalCents: 4711 } }, "row:challenge_summary"],
      ["an expiry after the quote's", { challenge_expires_at: new Date(QUOTE_EXPIRES.getTime() + 60 * MINUTE) }, "row:challenge_expires_at"],
    ];
    for (const [label, tampering, logLine] of cases) {
      logged = [];
      const w = world();
      const shopper = await signIn(w.services);
      const intentId = await startedIntent(w, shopper);
      // The form of the valid page, as an earlier render gave it.
      const form = await formOf(w, shopper, intentId);
      const row = w.db.checkouts.get(intentId);
      if (!row) throw new Error("no row");
      Object.assign(row, tampering);
      const before = w.db.checkoutCalls().length;

      // The page: nothing of the row, only "not available".
      const page = await buildPgCheckoutView(w.services, shopper.context, intentId);
      expect(page, label).toEqual({ kind: "UNAVAILABLE" });
      expect(JSON.stringify(page), label).not.toMatch(/Tampered|4711/);

      // The handlers that read first: an internal error, and no call after the read.
      const responses = [
        await confirm(w, shopper, intentId, form),
        await handlePgReview(post(`/checkout/${intentId}/review`, shopper, { csrfToken: shopper.csrfToken }), w.services, intentId),
        (await startCheckout(w, shopper, { replaces: intentId })).response,
      ];
      for (const response of responses) {
        expect(response.status, label).toBe(500);
        expect(await response.text(), label).not.toMatch(/Tampered|4711/);
      }
      expect(w.db.checkoutCalls().slice(before), label).toEqual(["readCheckout", "readCheckout", "readCheckout", "readCheckout"]);
      expect(logged.join("\n"), label).toContain(logLine);
      expect(logged.join("\n"), label).not.toMatch(/Tampered|4711/);
    }
  });
});

// Static markup of three components, rendered to a string on the server side of React. This shows what markup the
// components produce for given properties. It is not a rendering of a page, it runs no browser, and it says nothing
// about keyboard operation, focus or announcements.
//
// The markup is read by tag and attribute, never by the order in which the renderer writes attributes: a form is
// found by its `action`, and its `method`, its fields and its button are then asserted on that same form.
describe("PostgreSQL mode: the markup of the checkout actions, the session notices and the confirmation form", () => {
  const CSRF = "f".repeat(64);
  const ID = `ci_${hex32(80)}`;
  type Attributes = Record<string, string>;
  interface RenderedForm {
    readonly attributes: Attributes;
    readonly inputs: Attributes[];
    readonly buttons: Attributes[];
  }
  const attributesOf = (text: string): Attributes => Object.fromEntries([...text.matchAll(/([A-Za-z-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
  const openTags = (html: string, tag: string): Attributes[] => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))].map((match) => attributesOf(match[1]));
  /** Every form of the markup: its own attributes, and the inputs and buttons inside it. */
  const formsOf = (html: string): RenderedForm[] =>
    [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((match) => ({ attributes: attributesOf(match[1]), inputs: openTags(match[2], "input"), buttons: openTags(match[2], "button") }));
  const withAction = (forms: readonly RenderedForm[], action: string): RenderedForm[] => forms.filter((form) => form.attributes.action === action);
  /** The values of the hidden fields of one name in one form. */
  const hidden = (form: RenderedForm, name: string): string[] => form.inputs.filter((input) => input.type === "hidden" && input.name === name).map((input) => input.value);
  const fieldNames = (form: RenderedForm): string[] => form.inputs.map((input) => input.name).sort();
  const count = (html: string, part: string): number => html.split(part).length - 1;

  const decode = (row: Row) => {
    const read = decodeCheckoutRead(row);
    if (!read.authorized) throw new Error("not authorized");
    return read.checkout;
  };
  const actionsMarkup = (row: Row, challengeShown: boolean): string =>
    renderToStaticMarkup(createElement(CheckoutActions, { intentId: ID, actions: pgCheckoutActions(decode(row), challengeShown), csrfToken: CSRF }));
  const REVIEW = `/checkout/${ID}/review`;
  const CANCEL = `/checkout/${ID}/cancel`;
  const START = "/checkout/start";

  it("the reading of the markup does not depend on attribute order, and a wrong or missing action or method is seen as such", () => {
    const either = ['<form method="post" action="/a"><input type="hidden" name="n" value="v"/><button type="submit">Go</button></form>', '<form class="x" action="/a" method="post"><input value="v" name="n" type="hidden"/><button class="y" type="submit">Go</button></form>'];
    for (const html of either) {
      const forms = formsOf(html);
      expect(forms).toHaveLength(1);
      expect(withAction(forms, "/a")).toHaveLength(1);
      expect(forms[0].attributes.method).toBe("post");
      expect(hidden(forms[0], "n")).toEqual(["v"]);
      expect(forms[0].buttons.map((button) => button.type)).toEqual(["submit"]);
    }
    // A form that posts somewhere else is not found at the expected action; a GET form and a form with no method are not "post".
    expect(withAction(formsOf('<form action="/b" method="post"></form>'), "/a")).toEqual([]);
    expect(formsOf('<form action="/a" method="get"></form>')[0].attributes.method).toBe("get");
    expect(formsOf('<form action="/a"></form>')[0].attributes.method).toBeUndefined();
    expect(formsOf('<form method="post"></form>')[0].attributes.action).toBeUndefined();
    // A field outside a form belongs to no form.
    expect(hidden(formsOf('<input type="hidden" name="n" value="v"/><form action="/a" method="post"></form>')[0], "n")).toEqual([]);
  });

  it("CheckoutActions renders exactly the forms of the checkout's state, each a POST with the CSRF field, and never a simulation control", () => {
    const cases: Array<[string, string, { review: number; cancel: number; start: number; replaces: number }]> = [
      ["QUOTED with the challenge shown", actionsMarkup(readRow(ID), true), { review: 0, cancel: 1, start: 0, replaces: 0 }],
      ["QUOTED with no challenge shown", actionsMarkup(readRow(ID), false), { review: 1, cancel: 1, start: 0, replaces: 0 }],
      ["QUOTED, quote expired", actionsMarkup(readRow(ID, { effective_status: "QUOTE_EXPIRED" }), false), { review: 0, cancel: 1, start: 1, replaces: 1 }],
      ["QUOTED, quote stale", actionsMarkup(readRow(ID, { quote_stale: true }), false), { review: 0, cancel: 1, start: 1, replaces: 1 }],
      ["USER_CONFIRMED", actionsMarkup(readRow(ID, { stored_state: "USER_CONFIRMED", effective_status: "USER_CONFIRMED", row_version: 3 }), false), { review: 0, cancel: 1, start: 1, replaces: 1 }],
      ["CANCELED_LOCAL", actionsMarkup(readRow(ID, { stored_state: "CANCELED_LOCAL", effective_status: "CANCELED_LOCAL", row_version: 3 }), false), { review: 0, cancel: 0, start: 1, replaces: 0 }],
      ["EXPIRED", actionsMarkup(readRow(ID, { stored_state: "EXPIRED", effective_status: "EXPIRED", row_version: 3 }), false), { review: 0, cancel: 0, start: 1, replaces: 0 }],
    ];
    for (const [label, html, expected] of cases) {
      const forms = formsOf(html);
      const review = withAction(forms, REVIEW);
      const cancel = withAction(forms, CANCEL);
      const start = withAction(forms, START);
      expect({ review: review.length, cancel: cancel.length, start: start.length, replaces: forms.filter((form) => hidden(form, "replaces").length > 0).length }, label).toEqual(expected);
      // No other form: every form of the markup is one of the three, and every opening form tag was read.
      expect(forms, label).toHaveLength(expected.review + expected.cancel + expected.start);
      expect(count(html, "<form"), label).toBe(forms.length);
      for (const form of forms) {
        // The same form: a POST, the CSRF token once, and one native submit button.
        expect(form.attributes.method, `${label}: ${form.attributes.action}`).toBe("post");
        expect(hidden(form, "csrfToken"), `${label}: ${form.attributes.action}`).toEqual([CSRF]);
        expect(form.buttons.map((button) => button.type), `${label}: ${form.attributes.action}`).toEqual(["submit"]);
        expect(form.inputs.every((input) => input.type === "hidden"), `${label}: ${form.attributes.action}`).toBe(true);
      }
      // Review and cancel carry the CSRF token and nothing else.
      for (const form of [...review, ...cancel]) expect(fieldNames(form), label).toEqual(["csrfToken"]);
      // A new quote carries the item of the authorized read, and no price. Only a replacing quote names this checkout.
      for (const form of start) {
        expect({ productId: hidden(form, "productId"), variantId: hidden(form, "variantId"), quantity: hidden(form, "quantity") }, label).toEqual({ productId: ["dmp_codebook15"], variantId: ["dmv_codebook15a"], quantity: ["1"] });
        expect(hidden(form, "replaces"), label).toEqual(expected.replaces === 1 ? [ID] : []);
        expect(fieldNames(form), label).toEqual(expected.replaces === 1 ? ["csrfToken", "productId", "quantity", "replaces", "variantId"] : ["csrfToken", "productId", "quantity", "variantId"]);
      }
      expect(count(html, "<button"), label).toBe(forms.length);
      expect(html, label).not.toMatch(/Cents|price|total/i);
      expect(html, label).not.toMatch(/simulate|name="step"|onclick|javascript:/i);
    }
    // The wording of the two new-quote controls differs: only one of them replaces this checkout.
    expect(actionsMarkup(readRow(ID, { quote_stale: true }), false)).toContain("Request a new quote in place of this one");
    expect(actionsMarkup(readRow(ID, { stored_state: "CANCELED_LOCAL", effective_status: "CANCELED_LOCAL", row_version: 3 }), false)).toContain("Start another checkout for this item");

    // A superseded checkout: a link to its successor and no form at all.
    const successor = `ci_${hex32(81)}`;
    const superseded = actionsMarkup(readRow(ID, { stored_state: "SUPERSEDED", effective_status: "SUPERSEDED", row_version: 3, superseded_by_intent_id: successor }), false);
    expect(formsOf(superseded)).toEqual([]);
    expect(count(superseded, "<form")).toBe(0);
    expect(openTags(superseded, "a").map((link) => link.href)).toEqual([`/checkout/${successor}`]);
    // Nothing to offer: said in words, with no control.
    const nothing = renderToStaticMarkup(createElement(CheckoutActions, { intentId: ID, actions: { review: false, cancel: false, replace: null, startAnother: null, successorIntentId: null }, csrfToken: CSRF }));
    expect(nothing).toContain("Nothing more can be done with this checkout.");
    expect(nothing).not.toMatch(/<form|<button|<a /);
  });

  it("SessionNotice renders the two fixed notices, each with its one guarded form", () => {
    const ended = renderToStaticMarkup(createElement(SessionNotice, { kind: "ended" }));
    expect(openTags(ended, "section").map((section) => section.role)).toEqual(["alert"]);
    expect(ended).toContain("Your session can no longer be used");
    expect(ended).toContain("Nothing was started in its place.");
    expect(ended).toContain("Checkouts from the earlier session will not transfer to the new one.");
    const endedForms = formsOf(ended);
    expect(endedForms).toHaveLength(1);
    expect(count(ended, "<form")).toBe(1);
    expect(withAction(endedForms, "/session/new")).toHaveLength(1);
    expect(endedForms[0].attributes.method).toBe("post");
    // One hidden field so that the form has a body, and one submit button. No session exists, so no CSRF field.
    expect(endedForms[0].inputs.map((input) => ({ type: input.type, name: input.name, value: input.value }))).toEqual([{ type: "hidden", name: "intent", value: "new-session" }]);
    expect(endedForms[0].buttons.map((button) => button.type)).toEqual(["submit"]);
    expect(ended).toContain("Start a new session</button>");
    expect(ended).not.toContain("csrfToken");
    expect(ended).not.toContain("/session/rotate");

    const rotate = renderToStaticMarkup(createElement(SessionNotice, { kind: "rotate", csrfToken: CSRF }));
    expect(openTags(rotate, "section").map((section) => section.role)).toEqual(["status"]);
    expect(rotate).toContain("Your session is still valid. Renewing it keeps your checkouts.");
    const rotateForms = formsOf(rotate);
    expect(rotateForms).toHaveLength(1);
    expect(count(rotate, "<form")).toBe(1);
    expect(withAction(rotateForms, "/session/rotate")).toHaveLength(1);
    expect(rotateForms[0].attributes.method).toBe("post");
    expect(hidden(rotateForms[0], "csrfToken")).toEqual([CSRF]);
    expect(fieldNames(rotateForms[0])).toEqual(["csrfToken"]);
    expect(rotateForms[0].buttons.map((button) => button.type)).toEqual(["submit"]);
    expect(rotate).toContain("Refresh secure session</button>");
    expect(rotate).not.toContain("/session/new");
    for (const html of [ended, rotate]) expect(html).not.toMatch(/onclick|javascript:|<a /i);
  });

  it("ConfirmationSummary renders the PostgreSQL challenge as the confirmation form: the acknowledgement, the nonce field, and no server credential or stored digest", async () => {
    const w = world();
    const shopper = await signIn(w.services);
    const intentId = await startedIntent(w, shopper);
    const page = await buildPgCheckoutView(w.services, shopper.context, intentId);
    if (page.kind !== "OK" || !page.value.challenge) throw new Error("no challenge to render");
    const challenge = page.value.challenge;
    const html = renderToStaticMarkup(createElement(ConfirmationSummary, { challenge, csrfToken: shopper.csrfToken, action: `/checkout/${intentId}/confirm` }));

    const forms = formsOf(html);
    expect(forms).toHaveLength(1);
    expect(count(html, "<form")).toBe(1);
    expect(withAction(forms, `/checkout/${intentId}/confirm`)).toHaveLength(1);
    const form = forms[0];
    expect(form.attributes.method).toBe("post");
    // The four bound values and the CSRF token, each once, as hidden fields of that form.
    for (const [name, value] of [["confirmationId", challenge.confirmationId], ["nonce", challenge.nonce], ["quoteId", challenge.quoteId], ["quoteDigest", challenge.quoteDigest], ["csrfToken", shopper.csrfToken]]) {
      expect(hidden(form, name), name).toEqual([value]);
    }
    expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(count(html, challenge.nonce)).toBe(1);
    // The acknowledgement is a required native checkbox of the same form, and its one button submits it.
    const checkboxes = form.inputs.filter((input) => input.type === "checkbox");
    expect(checkboxes.map((input) => ({ name: input.name, value: input.value, required: "required" in input }))).toEqual([{ name: "acknowledged", value: "yes", required: true }]);
    expect(fieldNames(form)).toEqual(["acknowledged", "confirmationId", "csrfToken", "nonce", "quoteDigest", "quoteId"]);
    expect(form.buttons.map((button) => ({ type: button.type, disabled: "disabled" in button }))).toEqual([{ type: "submit", disabled: false }]);
    expect(html).toContain(">Confirm this purchase summary</button>");
    // What the shopper is asked to confirm is the summary the database stored with the challenge.
    expect(html).toContain("ShopAccess Demo Store");
    expect(html).toContain("CodeBook 15 — 16 GB, 512 GB");
    expect(html).toContain("$799.00");
    expect(openTags(html, "time").map((time) => time.datetime ?? time.dateTime)).toEqual([challenge.expiresAt]);

    // Not serialized, in the markup or in the data the page is given: the session's token digest, the stored nonce
    // digest, the owner id, a key, or the name of a database column. (The quote digest is a field of the form by
    // design, in the mock as well: the database compares it.)
    const row = w.db.checkouts.get(intentId) ?? {};
    const withheld = [shopper.context.credential.tokenDigest, String(row.challenge_nonce_digest), OWNER, SESSION_KEY.toString("base64"), NONCE_KEY_1.toString("base64"), "challenge_nonce_digest", "token_digest", "nonce_key_version"];
    expect(String(row.challenge_nonce_digest)).toMatch(/^[0-9a-f]{64}$/);
    for (const text of [html, JSON.stringify(page.value)]) for (const value of withheld) expect(text.includes(value), `holds ${withheld.indexOf(value)}`).toBe(false);

    // Without an action the same component is a preview that cannot be submitted.
    const preview = renderToStaticMarkup(createElement(ConfirmationSummary, { challenge, csrfToken: shopper.csrfToken }));
    const previewForms = formsOf(preview);
    expect(previewForms).toHaveLength(1);
    expect(previewForms[0].attributes.action).toBeUndefined();
    expect(previewForms[0].buttons.map((button) => ({ type: button.type, disabled: "disabled" in button }))).toEqual([{ type: "submit", disabled: true }]);
  });
});
