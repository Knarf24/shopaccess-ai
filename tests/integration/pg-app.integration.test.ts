import { randomBytes, randomInt } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { OPERATOR_STATEMENTS } from "@/lib/pg/statements";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { messageFor } from "@/server/views";
import { ADMIN_URL_VARIABLE, AUTHORIZED_PORT_VARIABLE, openDisposableDatabase, parseAdminTarget, type DisposableDatabase } from "../db/harness";
import {
  APPLICATION_BIND_HOST,
  APPLICATION_HOST_HEADER,
  APPLICATION_ORIGIN,
  APPLICATION_PORT,
  applicationCleanupStep,
  applicationCommand,
  childEnvironment,
  createApplicationOwner,
  createHttpClient,
  describeCleanup,
  describeStartupFailure,
  encodeForm,
  listingProbe,
  loopbackTransport,
  parseForms,
  parseSetCookie,
  readIntegrationInputs,
  readProcessIdentity,
  realProcessDeps,
  recordCleanupResult,
  runCleanup,
  startApplication,
  uniqueHandles,
  visibleText,
  type ApplicationHandle,
  type CleanupResult,
  type HttpReply,
  type ParsedForm,
  type StopResult,
} from "./app-process";
import { OWNERSHIP_FILE, ROLLING_MODULUS, SENTINEL_FILE, SentinelRegistry, atomicReplace, registerOwnership } from "./run-evidence";
import {
  CodedFailure,
  SafeAssertionError,
  requireAbsent,
  requireContains,
  requireDifferentSecret,
  requireNoFindings,
  requireNoSecretsInText,
  requireSafeEqual,
  requireSameFields,
  requireSameRows,
  requireSameSecret,
  requireThat,
  rowDifference,
  scanReply,
  withRedactedFailures,
  type DisclosureFinding,
} from "./safe-diagnostics";

/**
 * HTTP and application-restart integration driver of PostgreSQL mode (specification 19.19, Increment 2.3).
 *
 * NEVER RUN. Written under an implementation gate that authorized no database, no application start and no
 * request. Running it is a separate gate.
 *
 * Ownership.
 *  - This driver owns: its disposable database fixture (through the unchanged harness), its application child
 *    processes, its HTTP requests, and its application logs.
 *  - The execution gate's wrapper owns: provisioning the cluster and verifying its identity, the pristine catalog
 *    records taken before this driver runs and after its fixture is destroyed, the final PostgreSQL shutdown, and
 *    the retained cluster. Nothing here provisions, snapshots or stops a cluster. A pristine comparison belongs
 *    after `destroy()`, never while the fixture is present.
 *
 * One fixture, one invocation, three application processes in turn on one port:
 *   1. the main cases; 2. the same configuration again, after a stop, for restart persistence; 3. a superuser
 *   connection, for the wrong-role refusal. PostgreSQL runs throughout. The fixture is destroyed only afterwards.
 *
 * What this is not. The client is synthetic: it carries the cookie and the Origin header itself. It is not
 * evidence that a browser accepts the Secure, `__Host-` cookie, and nothing here is browser, keyboard or
 * assistive-technology evidence. The application runs in development mode (`next dev`), which is what admits the
 * plain-HTTP loopback origin; this is not evidence about a production build.
 *
 * Observations of the database use the fixed statements of `OBSERVE`, on the test owner's connection. Table
 * content is compared in full, row by row; only the names of tables and counts of rows are ever printed.
 *
 * Diagnostics. This file calls no matcher of the test runner. Session cookies, CSRF tokens, confirmation nonces,
 * digests, owner identifiers, keys, passwords and connection URLs stay in memory for requests and comparisons;
 * every comparison is made here and fails through `./safe-diagnostics`, whose messages hold fixed labels, counts,
 * names and values of a small safe grammar only. A response, a form, a Set-Cookie value or a database row is never
 * given to anything that could print it. A failure that is not an assertion is rethrown as a fixed operation
 * label, a category from a closed list and, at most, a listed code: nothing of the error's own text is forwarded.
 */

const ROOT = process.cwd();
const inputs = readIntegrationInputs(process.env, { databaseVariables: [ADMIN_URL_VARIABLE, AUTHORIZED_PORT_VARIABLE], repositoryRoot: ROOT });

/**
 * Coverage of the approved acceptance cases (specification 19.19) by this driver. A passing run establishes the
 * IMPLEMENTED rows at integration level and NOTHING about a DEFERRED row. The table is written to the evidence
 * directory with every run.
 */
const COVERAGE: ReadonlyArray<readonly [string, "IMPLEMENTED" | "PARTIAL" | "DEFERRED", string]> = [
  ["A2", "PARTIAL", "A state-changing request without an Origin is refused on every route and writes nothing. Guard order stays unit evidence."],
  ["A4", "IMPLEMENTED", "An unknown challenge id for the URL checkout: FORM_OUT_OF_DATE, no checkout, window or audit row changes."],
  ["A7", "IMPLEMENTED", "Sequential replay after confirmation: ALREADY_CONFIRMED, nothing changes. Integration level only; not browser."],
  ["A8", "DEFERRED", "A change between the read and the call needs a forced order. Not attempted."],
  ["A9", "DEFERRED", "A failing issue call needs fault injection. No production hook is added."],
  ["A13", "DEFERRED", "Needs a nonce-key state change during a flow."],
  ["A15", "PARTIAL", "Page loads change no checkout, window or audit row. The number of statements stays unit evidence."],
  ["A16", "PARTIAL", "The same challenge and nonce on a second load and after an application restart. Not a browser tab."],
  ["A17", "PARTIAL", "Unforced overlapping confirmations, with the allowed outcome set. A FORCED overlap is deferred: it needs request attribution and backend identities that are not available without a production hook."],
  ["A18", "PARTIAL", "Admission without a cookie; continuation with a valid one; unusable cookies admit nothing. Expiry rows stay unit and database-suite evidence."],
  ["A19", "DEFERRED", "Rotation under VERIFY_ONLY needs a second key configuration and a further application start."],
  ["A21", "IMPLEMENTED", "A canceled checkout offers a new checkout with no predecessor; the canceled record is unchanged."],
  ["A22", "PARTIAL", "Replacement from USER_CONFIRMED, and REPLACEMENT_NOT_ALLOWED for a canceled predecessor. Expired and stale quotes stay unit evidence."],
  ["A24", "PARTIAL", "One failing probe value: a superuser connection."],
  ["A25", "PARTIAL", "The web role passes and a superuser fails. The migration-role variant is DEFERRED: the unchanged harness offers no login for it, and none is invented."],
  ["A26", "PARTIAL", "Rendered identifiers, titles and prices equal the database's rows. One statement per render and the incoherent-row refusal stay unit evidence."],
  ["A28", "DEFERRED", "Neither the in-process limit nor the database throttle is driven to its limit."],
  ["A29", "PARTIAL", "No response body and no response header of a request this driver made holds a key, a credential, a connection detail, an owner id, a token digest or a nonce digest; a Set-Cookie header may hold the session cookie it sets and nothing else of these. NOT covered: the status line's reason phrase, trailers, and any response this driver did not request."],
  ["A30", "IMPLEMENTED", "The application logs and the PostgreSQL server log hold none of the run's secrets."],
  ["A31", "DEFERRED", "Privilege refusals on the web connection are database-suite evidence (C-E2); not repeated here."],
  ["A34", "PARTIAL", "The simulation route answers 404 and the page has no simulation form. Not browser."],
  ["A35", "DEFERRED", "Browser, keyboard and announcement evidence: outside this driver."],
  ["A36", "DEFERRED", "Mock mode in a browser: outside this driver."],
  ["A37", "IMPLEMENTED", "B's form posted to A's URL: FORM_OUT_OF_DATE, nothing changes."],
  ["A38", "IMPLEMENTED", "A matching challenge with a wrong quote id, and with a wrong quote digest: CONFIRMATION_MISMATCH, one counted call and one CONFIRMATION_REJECTED row each."],
  ["A39", "PARTIAL", "FORM_OUT_OF_DATE, ALREADY_CONFIRMED and the acknowledgement refusal with full snapshots. CHECKOUT_NOT_CONFIRMABLE is not driven."],
  ["A40", "IMPLEMENTED", "No cookie admits once; a malformed, duplicated, mock-format, unknown or unknown-version cookie admits nothing."],
  ["A41", "PARTIAL", "A valid session is never replaced; an unusable one is replaced only on request; the earlier owner's rows stay; a form of another session is refused."],
  ["A42", "DEFERRED", "Missing schema USAGE needs a privilege change that no exception authorizes. Unit evidence only; NOT dropped."],
  ["A48", "DEFERRED", "Browser."],
  ["A49", "DEFERRED", "Browser. The no-call part is A37."],
  ["A50", "DEFERRED", "Browser. The notice text and its form are observed over HTTP only."],
];

const PREFERENCES = "use=schoolwork&budget=5000";
const UNAVAILABLE_NOTICE = "The shop is not available right now.";
const COOKIE_ATTRIBUTES = ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"];

/** Fixed observation statements, test owner only. No value is ever placed in their text. */
const OBSERVE = {
  catalog:
    "SELECT p.id AS product_id, p.title, v.id AS variant_id, v.label, v.unit_amount_cents, v.availability FROM shopaccess.merchant_products p JOIN shopaccess.merchant_variants v ON v.product_id = p.id ORDER BY p.id, v.id",
  // Every row of the eight tables a checkout call may change, as text, in a fixed order.
  tables:
    "SELECT (SELECT coalesce(array_agg(t::text ORDER BY t::text), '{}') FROM shopaccess.purchase_groups t) AS purchase_groups, " +
    "(SELECT coalesce(array_agg(t::text ORDER BY t::text), '{}') FROM shopaccess.checkout_intents t) AS checkout_intents, " +
    "(SELECT coalesce(array_agg(t::text ORDER BY t::text), '{}') FROM shopaccess.quotes t) AS quotes, " +
    "(SELECT coalesce(array_agg(t::text ORDER BY t::text), '{}') FROM shopaccess.quote_items t) AS quote_items, " +
    "(SELECT coalesce(array_agg(t::text ORDER BY t::text), '{}') FROM shopaccess.confirmation_challenges t) AS confirmation_challenges, " +
    "(SELECT coalesce(array_agg(t::text ORDER BY t::text), '{}') FROM shopaccess.checkout_transitions t) AS checkout_transitions, " +
    "(SELECT coalesce(array_agg(t::text ORDER BY t::text), '{}') FROM shopaccess.owner_request_windows t) AS owner_request_windows, " +
    "(SELECT coalesce(array_agg(t::text ORDER BY t::text), '{}') FROM shopaccess.audit_events t) AS audit_events",
  // What identifies a session. Its activity (last_seen_at, row_version) is deliberately left out: a page load or a
  // guarded request may record activity, and nothing else of a session may change.
  sessions:
    "SELECT id, owner_id, key_version::integer AS key_version, token_digest, created_at::text AS created_at, absolute_expires_at::text AS absolute_expires_at, coalesce(revoked_at::text, '') AS revoked_at FROM shopaccess.shopper_sessions ORDER BY id",
  owners: "SELECT count(*)::integer AS n FROM shopaccess.checkout_owners",
  intent: "SELECT state, row_version, owner_id, superseded_by_intent_id, confirmation_id FROM shopaccess.checkout_intents WHERE id = $1",
  challenges: "SELECT id, status FROM shopaccess.confirmation_challenges WHERE checkout_intent_id = $1 ORDER BY issued_at, id",
  nonceDigests: "SELECT nonce_digest FROM shopaccess.confirmation_challenges",
  ownerAudits: "SELECT event_type, count(*)::integer AS n FROM shopaccess.audit_events WHERE owner_id = $1 GROUP BY event_type ORDER BY event_type",
  window: "SELECT window_calls::integer AS calls, window_started_at::text AS started_at FROM shopaccess.owner_request_windows WHERE owner_id = $1",
  backends:
    "SELECT usename::text AS role, count(*)::integer AS backends, (count(*) FILTER (WHERE host(client_addr) IS DISTINCT FROM '127.0.0.1' AND host(client_addr) IS DISTINCT FROM '::1'))::integer AS not_loopback " +
    "FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND backend_type = 'client backend' GROUP BY usename ORDER BY usename",
} as const;

const CHECKOUT_TABLES = ["purchase_groups", "checkout_intents", "quotes", "quote_items", "confirmation_challenges", "checkout_transitions", "owner_request_windows", "audit_events"] as const;
type Tables = Record<(typeof CHECKOUT_TABLES)[number], string[]>;
type Effects = Record<string, { added: number; removed: number }>;

/** The fixed words a disclosure finding may report. */
type SecretCategory = "private key" | "password" | "connection URL" | "session cookie" | "owner id" | "token digest" | "nonce digest" | "confirmation nonce" | "quote digest" | "CSRF token";
/** What must appear in no response body and in no response header other than Set-Cookie. */
const RESPONSE_CATEGORIES: readonly SecretCategory[] = ["private key", "password", "connection URL", "session cookie", "owner id", "token digest", "nonce digest"];
/** What a Set-Cookie header may rightly hold. Every other response category is looked for there too. */
const ALLOWED_IN_SET_COOKIE: readonly SecretCategory[] = ["session cookie"];

interface Shopper {
  /** `name=value`, as a Cookie header carries it. Private to this process. */
  readonly cookie: string;
  readonly sessionId: string;
  readonly ownerId: string;
}

interface CatalogRow {
  readonly product_id: string;
  readonly title: string;
  readonly variant_id: string;
  readonly label: string;
  readonly unit_amount_cents: number;
  readonly availability: string;
}

interface WindowRow {
  readonly calls: number;
  readonly started_at: string;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const count = (values: readonly unknown[] | undefined): number => (values ?? []).length;
/** The value of a header that must occur exactly once. A failure reports how many there were, never a value. */
const sole = (values: readonly string[] | undefined, label: string): string => {
  requireSafeEqual(count(values), 1, `${label}: number of header values`);
  return (values ?? [""])[0];
};

describe("integration inputs", () => {
  // Reached only when the authorization variable is set and something else is missing or wrong. Nothing is opened.
  it.skipIf(inputs.kind !== "INVALID")("an authorization that is set and incomplete fails, naming variables only", () => {
    // Each problem is a variable name and fixed words, by construction; a unit control holds that to be so.
    const problems = inputs.kind === "INVALID" ? inputs.problems : [];
    requireThat(problems.length === 0, `The integration inputs are incomplete: ${problems.join("; ")}`);
  });
});

describe.skipIf(inputs.kind !== "AUTHORIZED")("PostgreSQL mode over HTTP, on a disposable database, across an application restart", () => {
  const evidenceDirectory = inputs.kind === "AUTHORIZED" ? inputs.evidenceDirectory : "";
  const serverLog = inputs.kind === "AUTHORIZED" ? inputs.serverLog : "";
  /** The run's ownership identity, made by the wrapper. Every application started here carries it in its environment. */
  const ownershipId = inputs.kind === "AUTHORIZED" ? inputs.ownershipId : "0".repeat(32);

  let db: DisposableDatabase | null = null;
  const transport = loopbackTransport(APPLICATION_BIND_HOST, APPLICATION_PORT, APPLICATION_HOST_HEADER);
  const client = createHttpClient(transport);
  const deps = realProcessDeps(listingProbe(transport));
  /** Retains every application this driver spawns, from the spawn, whatever happens to its startup or to the list below. */
  const owner = createApplicationOwner();
  /** The applications in the order they were spawned: for log names and case bookkeeping. Cleanup does not rely on it. */
  const applications: ApplicationHandle[] = [];
  const logFiles: string[] = [];
  let application: ApplicationHandle | null = null;
  let configuration: Record<string, string> = {};
  let adminUser = "";

  /** Every sensitive value of the run, by category. Kept in memory for the scans and for redaction; never printed. */
  const secrets: Array<{ readonly category: SecretCategory; readonly value: string }> = [];
  /** Every response received, for the scan at the end: body and headers. */
  const replies: HttpReply[] = [];
  let overlapPath: "LOCAL_REPLAY" | "DATABASE_REPLAY" | null = null;

  let catalog: CatalogRow[] = [];
  let main: Shopper;
  let other: Shopper;
  let checkoutA = "";
  let formA: ParsedForm;
  let checkoutB = "";
  let canceled = "";
  let latest = "";

  /**
   * The run's sentinel evidence: for each sensitive value its category, its length in UTF-8 bytes and salted
   * hashes of it, never the value. Replaced atomically on every new value, so the record on disk is always whole;
   * closed with a completeness marker before the fixture is destroyed. The wrapper searches the evidence with it.
   */
  const sentinels = new SentinelRegistry({
    ownershipId,
    salt: randomBytes(32),
    base: randomInt(256, ROLLING_MODULUS),
    persist: (text) => atomicReplace({ write: (path, data) => writeFileSync(path, data, { mode: 0o600 }), rename: renameSync }, join(evidenceDirectory, SENTINEL_FILE), text),
  });
  /**
   * Registers a sensitive value: in the sentinel evidence on disk first, then in memory. Called before the value
   * is used for anything else. A value that cannot be registered stops the case; neither it nor the reason is shown.
   */
  const secret = (category: SecretCategory, value: string): void => {
    if (value === "" || secrets.some((known) => known.category === category && known.value === value)) return;
    try {
      sentinels.register(category, value);
    } catch {
      throw new SafeAssertionError(`sentinel evidence: a value of category "${category}" could not be registered`);
    }
    secrets.push({ category, value });
  };
  /** A case or a hook, under a fixed operation label. An unexpected failure is rethrown as that label and a failure class only. */
  const guarded = (operation: string, work: () => Promise<void>) => (): Promise<void> => withRedactedFailures(operation, work);
  const database = (): DisposableDatabase => {
    if (!db) throw new CodedFailure("FIXTURE_NOT_OPEN");
    return db;
  };

  // ---- HTTP ---------------------------------------------------------------

  /**
   * Takes in a response. First of all, before any case reads, parses or compares it, every sensitive value it
   * carries is registered: the session cookie it sets, and the CSRF token, confirmation nonce and quote digest of
   * every form in it.
   */
  const record = (reply: HttpReply): HttpReply => {
    for (const header of reply.headers["set-cookie"] ?? []) {
      const cookie = parseSetCookie(header);
      if (cookie !== null && cookie.name === SESSION_COOKIE_NAME) secret("session cookie", cookie.value);
    }
    for (const form of parseForms(reply.body)) {
      secret("CSRF token", form.hidden.csrfToken ?? "");
      secret("confirmation nonce", form.hidden.nonce ?? "");
      secret("quote digest", form.hidden.quoteDigest ?? "");
    }
    replies.push(reply);
    return reply;
  };
  const get = async (path: string, shopper?: { cookie: string }): Promise<HttpReply> =>
    record(await client.request({ method: "GET", path, headers: shopper ? { cookie: shopper.cookie } : {} }));
  /** A form post as a browser at the approved origin sends it. `origin: null` leaves the Origin header out. */
  const postSpec = (path: string, fields: Record<string, string>, shopper: { cookie: string } | null, origin: string | null = APPLICATION_ORIGIN) => ({
    method: "POST" as const,
    path,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin === null ? {} : { origin, "sec-fetch-site": "same-origin" }),
      ...(shopper ? { cookie: shopper.cookie } : {}),
    },
    body: encodeForm(fields),
  });
  const post = async (path: string, fields: Record<string, string>, shopper: { cookie: string } | null, origin: string | null = APPLICATION_ORIGIN): Promise<HttpReply> =>
    record(await client.request(postSpec(path, fields, shopper, origin)));

  /** No Set-Cookie header at all. Reports the number of headers, never one. */
  const expectNoCookie = (reply: HttpReply, label: string): void => requireSafeEqual(count(reply.headers["set-cookie"]), 0, `${label}: Set-Cookie headers sent`);
  /** 303 to exactly `location`, a local path this driver built. */
  const expectRedirect = (reply: HttpReply, location: string, label: string): void => {
    requireSafeEqual(reply.status, 303, `${label}: status`);
    requireSafeEqual(sole(reply.headers.location, `${label}: Location`), location, `${label}: location`);
  };
  /** The fixed JSON refusal with this status and public code, and no cookie. The body is parsed here and never shown. */
  const expectRefusal = (reply: HttpReply, status: number, code: string, label: string): void => {
    let seen = "NOT_JSON";
    try {
      const parsed = (JSON.parse(reply.body) as { error?: { code?: unknown } } | null)?.error?.code;
      seen = typeof parsed === "string" ? parsed : "NO_CODE";
    } catch {
      seen = "NOT_JSON";
    }
    requireSafeEqual({ status: reply.status, code: seen }, { status, code }, label);
    expectNoCookie(reply, label);
  };
  /**
   * The one session cookie a response sets: its name and its security attributes, unchanged. Returns the value for
   * later requests. The header is read here; neither it nor the value is given to anything that prints.
   */
  const sessionCookieOf = (reply: HttpReply, label: string): string => {
    const cookie = parseSetCookie(sole(reply.headers["set-cookie"], `${label}: Set-Cookie`));
    requireThat(cookie !== null && cookie.name === SESSION_COOKIE_NAME, `${label}: the cookie set is the session cookie, by name`);
    requireSafeEqual((cookie?.attributes ?? []).filter((attribute) => !attribute.startsWith("Max-Age=")), COOKIE_ATTRIBUTES, `${label}: cookie attributes other than Max-Age`);
    const value = cookie?.value ?? "";
    secret("session cookie", value);
    return value;
  };

  // ---- Database observations ---------------------------------------------

  const tables = async (): Promise<Tables> => (await database().admin.query(OBSERVE.tables)).rows[0] as Tables;
  /** What differs between two full-content snapshots: table names and row counts only. An update is one row removed and one added. */
  const effects = (before: Tables, after: Tables, ignore: readonly string[] = []): Effects => {
    const changed: Effects = {};
    for (const table of CHECKOUT_TABLES) {
      if (ignore.includes(table)) continue;
      const { removed, added } = rowDifference(before[table], after[table]);
      if (removed > 0 || added > 0) changed[table] = { added, removed };
    }
    return changed;
  };
  /** Exactly these effects, by table. Compared on full row content; a failure shows table names and counts. */
  const expectEffects = (before: Tables, after: Tables, expected: Effects, label: string, ignore: readonly string[] = []): void =>
    requireSafeEqual(effects(before, after, ignore), expected, `${label}: rows changed, by table`);
  const sessionRows = async (): Promise<Array<{ id: string; owner_id: string; token_digest: string; identity: string }>> => {
    const rows = (await database().admin.query(OBSERVE.sessions)).rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      owner_id: String(row.owner_id),
      token_digest: String(row.token_digest),
      identity: [row.id, row.owner_id, row.key_version, row.token_digest, row.created_at, row.absolute_expires_at, row.revoked_at].join("|"),
    }));
    // Registered as soon as they are read, before any comparison uses them.
    for (const row of rows) {
      secret("owner id", row.owner_id);
      secret("token digest", row.token_digest);
    }
    return rows;
  };
  /** Sessions added, and sessions removed or changed in identity, since an earlier reading. Full identity compared; counts reported. */
  const expectSessionChanges = async (before: ReadonlyArray<{ identity: string }>, added: number, label: string): Promise<void> =>
    requireSafeEqual(rowDifference(before.map((row) => row.identity), (await sessionRows()).map((row) => row.identity)), { removed: 0, added }, `${label}: session rows`);
  const ownerCount = async (): Promise<number> => (await database().admin.query(OBSERVE.owners)).rows[0].n as number;
  /** One checkout row, kept in memory. It holds an owner id: it is compared here and never shown. */
  const intentRow = async (intentId: string): Promise<Record<string, unknown>> => (await database().admin.query(OBSERVE.intent, [intentId])).rows[0] ?? {};
  const challengesOf = async (intentId: string): Promise<Array<{ id: string; status: string }>> => (await database().admin.query(OBSERVE.challenges, [intentId])).rows;
  /** The checkout's challenges: these statuses in order, and, when given, this id for the only one. */
  const expectChallenges = async (intentId: string, statuses: readonly string[], label: string, onlyId?: string): Promise<void> => {
    const rows = await challengesOf(intentId);
    requireSafeEqual(rows.map((row) => row.status), statuses, `${label}: challenge statuses`);
    if (onlyId !== undefined) requireThat(rows.length === 1 && rows[0].id === onlyId, `${label}: the only challenge is the one the form named`);
  };
  const auditsOf = async (ownerId: string): Promise<Record<string, number>> =>
    Object.fromEntries((await database().admin.query(OBSERVE.ownerAudits, [ownerId])).rows.map((row: { event_type: string; n: number }) => [row.event_type, row.n]));
  const windowOf = async (ownerId: string): Promise<WindowRow | null> => (await database().admin.query(OBSERVE.window, [ownerId])).rows[0] ?? null;
  const backends = async (): Promise<Record<string, { backends: number; not_loopback: number }>> =>
    Object.fromEntries(
      (await database().admin.query(OBSERVE.backends)).rows.map((row: { role: string; backends: number; not_loopback: number }) => [row.role, { backends: row.backends, not_loopback: row.not_loopback }]),
    );

  /**
   * The database counted exactly `calls` calls of this owner between two readings of its request window. When the
   * 60-second window began again in between, the earlier count is gone and only a bound can be stated: between
   * one and `calls` in the new window. That weaker form is a limit of this oracle, and it is reported as such.
   */
  const expectCountedCalls = (before: WindowRow | null, after: WindowRow | null, calls: number, label: string): void => {
    if (calls === 0) {
      requireThat((before === null) === (after === null), `${label}: no counted call, yet a request-window row appeared or went`);
      requireSafeEqual({ calls: after?.calls ?? 0, sameWindow: (after?.started_at ?? "") === (before?.started_at ?? "") }, { calls: before?.calls ?? 0, sameWindow: true }, `${label}: no counted call`);
      return;
    }
    requireThat(after !== null, `${label}: a counted call leaves a request-window row`);
    if (after === null) return;
    if (before === null) requireSafeEqual(after.calls, calls, `${label}: counted calls in the first window`);
    else if (before.started_at === after.started_at) requireSafeEqual(after.calls - before.calls, calls, `${label}: counted calls`);
    else requireThat(after.calls >= 1 && after.calls <= calls, `${label}: the request window began again; between 1 and ${calls} calls expected in the new one, observed ${after.calls}`);
  };

  // ---- Application processes ---------------------------------------------

  const start = async (label: string, environment: Record<string, string>): Promise<ApplicationHandle> => {
    const logPath = join(evidenceDirectory, `app-${applications.length + 1}-${label}.log`);
    const command = applicationCommand(ROOT, process.execPath);
    try {
      const handle = await startApplication(
        deps,
        {
          command: command.command,
          args: command.args,
          cwd: ROOT,
          env: childEnvironment(process.env, environment, ownershipId),
          host: APPLICATION_BIND_HOST,
          port: APPLICATION_PORT,
          logPath,
        },
        {
          // The helper retains the handle in `owner` itself, before this callback and before startup can fail.
          // Final cleanup stops every handle the owner holds, including one whose startup failed and whose first
          // shutdown did not work. The callback below is bookkeeping only.
          owner,
          // Registration at the spawn, before any startup work: pid, process group, start time and the run's
          // ownership identity, appended to the private ownership record. If the identity cannot be read or the
          // line cannot be written this throws; the helper then abandons the start as REGISTRATION_FAILED and
          // stops the process, which the owner above already retains.
          register: (spawned) => {
            const identity = readProcessIdentity(spawned.pid ?? -1);
            registerOwnership((line) => appendFileSync(join(evidenceDirectory, OWNERSHIP_FILE), line, { mode: 0o600 }), {
              ownershipId,
              index: owner.owned().length,
              pid: identity?.pid,
              pgid: identity?.pgid,
              startIdentity: identity?.startIdentity,
            });
          },
          onSpawned: (spawned) => {
            applications.push(spawned);
            logFiles.push(logPath);
          },
        },
      );
      application = handle;
      return handle;
    } catch (error) {
      // The startup code and the state of the shutdown that followed, as fixed words and booleans. This is not a
      // second start: nothing is started again, and final cleanup only stops what is owned.
      throw new SafeAssertionError(describeStartupFailure(error));
    }
  };
  /** Stops the running application and requires a complete stop: no process of its group, a free port, an intact log. */
  const stopApplication = async (): Promise<StopResult> => {
    if (!application) throw new CodedFailure("APPLICATION_NOT_RUNNING");
    const result = await application.stop();
    application = null;
    requireSafeEqual(
      { stopped: result.stopped, processRemaining: result.processRemaining, portFree: result.portFree, logFailures: result.logFailures.length, problems: result.problems.length },
      { stopped: true, processRemaining: false, portFree: true, logFailures: 0, problems: 0 },
      "THE APPLICATION WAS NOT STOPPED CLEANLY",
    );
    return result;
  };
  const databaseUrl = (user: string, password: string): string => {
    const web = database().webConnection;
    const host = web.host === "::1" ? "[::1]" : web.host;
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${web.port}/${web.database}`;
  };

  // ---- Shopper steps ------------------------------------------------------

  /** GET /session/start with no cookie. Expected: 303 to the shop, one new session row and one new owner, one cookie with the unchanged attributes. */
  const admit = async (): Promise<Shopper> => {
    const before = await sessionRows();
    const reply = await get(`/session/start?${PREFERENCES}`);
    expectRedirect(reply, `/shop?${PREFERENCES}&started=1`, "admission");
    const value = sessionCookieOf(reply, "admission");
    requireThat(/^1\.[A-Za-z0-9_-]{43}$/.test(value), "admission: the cookie value is key version 1, a dot and a 43-character token");
    const after = await sessionRows();
    const added = after.filter((row) => !before.some((earlier) => earlier.id === row.id));
    requireSafeEqual(added.length, 1, "admission: sessions admitted");
    requireThat(!before.some((earlier) => earlier.owner_id === added[0].owner_id), "admission: the new session has a new owner");
    secret("owner id", added[0].owner_id);
    secret("token digest", added[0].token_digest);
    return { cookie: `${SESSION_COOKIE_NAME}=${value}`, sessionId: added[0].id, ownerId: added[0].owner_id };
  };
  const shopForms = async (shopper: Shopper): Promise<{ text: string; starts: ParsedForm[] }> => {
    const reply = await get(`/shop?${PREFERENCES}&started=1`, shopper);
    requireSafeEqual(reply.status, 200, "the shop page: status");
    const starts = parseForms(reply.body).filter((form) => form.action === "/checkout/start" && form.method === "post");
    for (const form of starts) secret("CSRF token", form.hidden.csrfToken ?? "");
    requireThat(starts.length > 0, "the shop page offers at least one start form");
    return { text: visibleText(reply.body), starts };
  };
  /** POST /checkout/start. Expected: 303 to the new checkout's page with no error: the checkout exists and its first challenge was issued. */
  const startCheckout = async (shopper: Shopper, fields: Record<string, string>): Promise<string> => {
    const reply = await post("/checkout/start", fields, shopper);
    requireSafeEqual(reply.status, 303, "start: status");
    const match = /^\/checkout\/(ci_[0-9a-f]{32})$/.exec(sole(reply.headers.location, "start: Location"));
    requireThat(match !== null, "start: the location is the new checkout's page, with nothing to report");
    return match ? match[1] : "";
  };
  const checkoutPage = async (shopper: Shopper, intentId: string, query = ""): Promise<{ text: string; forms: ParsedForm[]; confirm: ParsedForm | undefined; html: string }> => {
    const reply = await get(`/checkout/${intentId}${query}`, shopper);
    requireSafeEqual(reply.status, 200, "the checkout page: status");
    const forms = parseForms(reply.body);
    for (const form of forms) secret("CSRF token", form.hidden.csrfToken ?? "");
    const confirm = forms.find((form) => form.action === `/checkout/${intentId}/confirm`);
    if (confirm) {
      secret("confirmation nonce", confirm.hidden.nonce ?? "");
      secret("quote digest", confirm.hidden.quoteDigest ?? "");
    }
    return { text: visibleText(reply.body), forms, confirm, html: reply.body };
  };
  /** The confirmation form of a page: present, with exactly its five hidden fields and its one checkbox. Field names only are shown. */
  const requireConfirm = (page: { confirm: ParsedForm | undefined }, label: string): ParsedForm => {
    requireThat(page.confirm !== undefined, `${label}: the page shows the confirmation form`);
    const form = page.confirm as ParsedForm;
    requireSafeEqual(Object.keys(form.hidden).sort(), ["confirmationId", "csrfToken", "nonce", "quoteDigest", "quoteId"], `${label}: hidden field names`);
    requireSafeEqual(form.controls, ["acknowledged"], `${label}: other controls`);
    return form;
  };
  const acknowledged = (form: ParsedForm, changes: Record<string, string> = {}): Record<string, string> => ({ ...form.hidden, acknowledged: "yes", ...changes });
  /** A checkout row: this state, and this owner. The row is compared here; only the state is shown. */
  const expectIntent = async (intentId: string, state: string, ownerId: string, label: string): Promise<Record<string, unknown>> => {
    const row = await intentRow(intentId);
    requireSafeEqual(row.state, state, `${label}: stored state`);
    requireThat(row.owner_id === ownerId, `${label}: the checkout belongs to the expected owner`);
    return row;
  };

  // ---- Fixture ------------------------------------------------------------

  beforeAll(
    guarded("fixture setup", async () => {
      // The sentinel record exists, empty and marked incomplete, before the first sensitive value is touched.
      try {
        sentinels.open();
      } catch {
        throw new SafeAssertionError("sentinel evidence could not be opened");
      }
      const target = parseAdminTarget(process.env);
      // The harness's refusal codes are fixed words; an unlisted one is reported as the fallback.
      if (!target.ok) throw new CodedFailure(target.code);
      adminUser = target.target.user;
      secret("password", target.target.password);
      secret("connection URL", process.env[ADMIN_URL_VARIABLE] ?? "");

      db = await openDisposableDatabase();
      const web = db.webConnection;
      secret("password", web.password);

      // Keys of this run only. Generated here, registered through the operator entry point, never written anywhere.
      const sessionKey = randomBytes(32);
      const nonceKey = randomBytes(32);
      for (const [purpose, key] of [["session", sessionKey], ["confirmation_nonce", nonceKey]] as const) {
        secret("private key", key.toString("base64"));
        secret("private key", key.toString("hex"));
        const activated = (await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, [purpose, 1, computeKeyCheckValue(key, purpose)])).rows[0] ?? {};
        requireSafeEqual({ result: activated.result, previous: activated.previous_active_version }, { result: "ACTIVATED", previous: null }, "key activation");
      }

      configuration = {
        SHOPACCESS_PERSISTENCE_MODE: "postgres",
        SHOPACCESS_DATABASE_URL: databaseUrl(web.user, web.password),
        SHOPACCESS_SESSION_KEYS: `1:${sessionKey.toString("base64")}`,
        SHOPACCESS_NONCE_KEYS: `1:${nonceKey.toString("base64")}`,
        SHOPACCESS_TRUSTED_ORIGINS: APPLICATION_ORIGIN,
        PAYMENT_PROVIDER_MODE: "mock",
      };
      secret("connection URL", configuration.SHOPACCESS_DATABASE_URL);

      catalog = (await db.admin.query(OBSERVE.catalog)).rows;
      requireThat(catalog.length > 0, "the migrations seeded a catalog");

      await start("main", configuration);
    }),
  );

  afterAll(async () => {
    // Every step is attempted, whatever the others do. A failure here is reported in addition to, never instead
    // of, a failed case. Nothing is removed by hand: a fixture the harness could not remove stays as it is, and
    // the wrapper still records the cluster's catalogs and stops PostgreSQL.
    // The completeness marker, before the fixture is destroyed: nothing more will be registered. A record that
    // could not be completed stays marked incomplete, and that is reported below.
    let sentinelsComplete = true;
    try {
      sentinels.complete();
    } catch {
      sentinelsComplete = false;
    }
    const cleanup: CleanupResult = await runCleanup([
      {
        name: "abort and settle outstanding requests",
        run: async () => {
          const aborted = await client.abortOutstanding();
          if (client.outstanding() !== 0) throw new CodedFailure("REQUESTS_OUTSTANDING", { aborted, outstanding: client.outstanding() });
          return { aborted };
        },
      },
      // Every application that was ever spawned, whether or not it finished starting: what the owner retained,
      // together with the driver's own list, each handle once. One more bounded attempt each on its own process
      // group; a process that remains is the failure PROCESS_REMAINING.
      ...uniqueHandles(owner.owned(), applications).map((handle, index) => applicationCleanupStep(handle, `stop application ${index + 1} and close its log`)),
      {
        name: "destroy the disposable database fixture (harness cleanup)",
        run: async () => {
          if (db) await db.destroy();
        },
      },
    ]);
    // The result is written from its fixed shape. A writer that fails is reported by class, and stays visible.
    const record = recordCleanupResult(cleanup, (text) => writeFileSync(join(evidenceDirectory, "cleanup-result.json"), text, { flag: "wx", mode: 0o600 }));
    requireThat(
      cleanup.complete && record.written && sentinelsComplete,
      `CLEANUP INCOMPLETE. ${describeCleanup(cleanup, record)} Sentinel evidence complete: ${sentinelsComplete} (${sentinels.count()} values). The wrapper must still record the cluster and stop PostgreSQL.`,
    );
  });

  // ---- Cases, in order. Each depends on the ones before it. ----------------

  it(
    "a state-changing request without an Origin is refused on every route and writes nothing",
    guarded("no Origin", async () => {
      // Expected: 403 FORBIDDEN, no cookie. Permitted database effect: none at all, in any table.
      const nowhere = `ci_${"0".repeat(32)}`;
      const before = { tables: await tables(), sessions: await sessionRows(), owners: await ownerCount() };
      for (const path of ["/session/new", "/session/rotate", "/checkout/start", `/checkout/${nowhere}/confirm`, `/checkout/${nowhere}/review`, `/checkout/${nowhere}/cancel`, `/checkout/${nowhere}/simulate`]) {
        expectRefusal(await post(path, { intent: "none" }, null, null), 403, "FORBIDDEN", `no Origin, ${path}`);
      }
      expectEffects(before.tables, await tables(), {}, "no Origin");
      await expectSessionChanges(before.sessions, 0, "no Origin");
      requireSafeEqual(await ownerCount(), before.owners, "no Origin: owners");
    }),
  );

  it(
    "readiness: the pages are served from the disposable database, by the web role, with no unavailable notice",
    guarded("readiness", async () => {
      // Expected: 200; the catalog the database holds; never the unavailable notice. A 200 alone is not accepted.
      const home = await get("/");
      requireSafeEqual(home.status, 200, "the start page: status");
      const homeText = visibleText(home.body);
      requireAbsent(homeText, UNAVAILABLE_NOTICE, "the start page: the unavailable notice");
      const titles = [...new Set(catalog.map((row) => row.title))];
      titles.forEach((title, index) => requireContains(homeText, title, `the start page: title of database product ${index + 1} of ${titles.length}`));

      main = await admit();
      const shop = await shopForms(main);
      requireAbsent(shop.text, UNAVAILABLE_NOTICE, "the shop page: the unavailable notice");
      // Identifiers: the start forms name exactly the variants the database calls IN_STOCK. Compared in full;
      // the counts are shown.
      const quotable = catalog.filter((row) => row.availability === "IN_STOCK").map((row) => `${row.product_id}/${row.variant_id}`).sort();
      const offered = shop.starts.map((form) => `${form.hidden.productId}/${form.hidden.variantId}`).sort();
      requireThat(quotable.length > 0, "the database's catalog has a variant in stock");
      requireSafeEqual(rowDifference(quotable, offered), { removed: 0, added: 0 }, `the shop page: start forms against the ${quotable.length} variants in stock (missing, unexpected)`);
      // Titles and prices: every variant of the database, as the page words them.
      catalog.forEach((row, index) => {
        requireContains(shop.text, `${row.title} — ${row.label}`, `the shop page: title and label of database variant ${index + 1} of ${catalog.length}`);
        requireContains(shop.text, `${formatUsd(row.unit_amount_cents)} USD`, `the shop page: price of database variant ${index + 1} of ${catalog.length}`);
      });

      // The connection: this driver never uses the harness's own web pool, so every backend of the web role is the
      // application's. At least one, at most the pool's five, all from loopback; and no role but the three expected.
      const seen = await backends();
      requireSafeEqual(Object.keys(seen).filter((role) => ![adminUser, database().operatorLogin, "shopaccess_web"].includes(role)).length, 0, "connections: roles other than the three expected");
      const webBackends = seen.shopaccess_web?.backends ?? 0;
      requireThat(webBackends >= 1 && webBackends <= 5, `connections: between 1 and 5 backends of the web role expected, observed ${webBackends}`);
      requireSafeEqual(seen.shopaccess_web?.not_loopback, 0, "connections: web-role backends not from loopback");
    }),
  );

  it(
    "session admission: a valid cookie continues unchanged, and an unusable cookie admits nothing",
    guarded("session admission", async () => {
      const before = { tables: await tables(), sessions: await sessionRows(), owners: await ownerCount() };

      // A valid cookie. Expected: 303 to the shop, no new cookie. Permitted effect: that session's activity only.
      const again = await get(`/session/start?${PREFERENCES}`, main);
      expectRedirect(again, `/shop?${PREFERENCES}&started=1`, "a valid cookie");
      expectNoCookie(again, "a valid cookie");

      // Unusable cookies. Expected: 303 to the session-ended notice, no cookie sent. Permitted effect: none.
      const valid = main.cookie.slice(SESSION_COOKIE_NAME.length + 1);
      const unusable: Array<readonly [string, string]> = [
        ["malformed", `${SESSION_COOKIE_NAME}=not-a-session`],
        ["mock format", `${SESSION_COOKIE_NAME}=${randomBytes(32).toString("base64url")}`], // a token with no version
        ["duplicated", `${SESSION_COOKIE_NAME}=${valid}; ${SESSION_COOKIE_NAME}=${valid}`],
        ["unknown to the database", `${SESSION_COOKIE_NAME}=1.${randomBytes(32).toString("base64url")}`],
        ["unconfigured key version", `${SESSION_COOKIE_NAME}=7.${randomBytes(32).toString("base64url")}`],
      ];
      for (const [kind, cookie] of unusable) {
        const reply = await get(`/session/start?${PREFERENCES}`, { cookie });
        expectRedirect(reply, "/?session=ended", `an unusable cookie (${kind})`);
        expectNoCookie(reply, `an unusable cookie (${kind})`);
      }
      const notice = await get("/?session=ended", { cookie: unusable[0][1] });
      requireContains(visibleText(notice.body), "Your session can no longer be used", "the session-ended notice: its heading");
      requireSafeEqual(parseForms(notice.body).filter((form) => form.action === "/session/new" && form.method === "post").length, 1, "the session-ended notice: forms posting to /session/new");

      await expectSessionChanges(before.sessions, 0, "session admission");
      requireSafeEqual(await ownerCount(), before.owners, "session admission: owners");
      expectEffects(before.tables, await tables(), {}, "session admission");
    }),
  );

  it(
    "explicit replacement: only an unusable session is replaced, only on request, and nothing transfers",
    guarded("explicit replacement", async () => {
      const before = { tables: await tables(), sessions: await sessionRows(), owners: await ownerCount() };
      const stale = { cookie: `${SESSION_COOKIE_NAME}=1.${randomBytes(32).toString("base64url")}` };

      // A valid session asks. Expected: 303 to the start, no cookie. Permitted effect: its own activity only.
      const kept = await post("/session/new", { intent: "new-session" }, main);
      expectRedirect(kept, "/", "a valid session asks for a new one");
      expectNoCookie(kept, "a valid session asks for a new one");
      // An untrusted origin. Expected: 403. Permitted effect: none.
      expectRefusal(await post("/session/new", { intent: "new-session" }, stale, "https://untrusted.invalid"), 403, "FORBIDDEN", "a new session from an untrusted origin");
      await expectSessionChanges(before.sessions, 0, "before the replacement");

      // An unusable session asks. Expected: 303 to the start with one new cookie. Permitted effect: one new session
      // and one new owner. The earlier session is not ended and is not changed.
      const replaced = await post("/session/new", { intent: "new-session" }, stale);
      expectRedirect(replaced, "/", "an unusable session asks for a new one");
      const fresh = { cookie: `${SESSION_COOKIE_NAME}=${sessionCookieOf(replaced, "an unusable session asks for a new one")}` };
      await expectSessionChanges(before.sessions, 1, "the replacement");
      requireSafeEqual(await ownerCount(), before.owners + 1, "the replacement: owners");
      for (const row of await sessionRows()) {
        secret("owner id", row.owner_id);
        secret("token digest", row.token_digest);
      }

      // A form of the earlier session, sent with the new session's cookie. Expected: 403. Permitted effect: none.
      const shop = await shopForms(main);
      expectRefusal(await post("/checkout/start", shop.starts[0].hidden, fresh), 403, "FORBIDDEN", "a form of another session");
      expectEffects(before.tables, await tables(), {}, "explicit replacement");
    }),
  );

  it(
    "start and read: the checkout is in the database for this owner, and loading its page changes nothing",
    guarded("start and read", async () => {
      const shop = await shopForms(main);
      checkoutA = await startCheckout(main, shop.starts[0].hidden);

      // Created over HTTP, found in the database: QUOTED, owned by this session's owner, one ACTIVE challenge.
      const row = await expectIntent(checkoutA, "QUOTED", main.ownerId, "the new checkout");
      requireThat(row.superseded_by_intent_id === null, "the new checkout: it has no successor");
      await expectChallenges(checkoutA, ["ACTIVE"], "the new checkout");

      // Two loads, as two tabs would make. Expected: 200 and the same challenge and nonce both times.
      // Permitted effect: the session's activity. No checkout, window or audit row.
      const before = { tables: await tables(), sessions: await sessionRows() };
      formA = requireConfirm(await checkoutPage(main, checkoutA), "first load");
      const second = requireConfirm(await checkoutPage(main, checkoutA), "second load");
      await expectChallenges(checkoutA, ["ACTIVE"], "after two loads", formA.hidden.confirmationId);
      requireSameFields(second.hidden, formA.hidden, "second load: the confirmation form's hidden fields against the first load's");
      const list = await get("/checkouts", main);
      requireSafeEqual(list.status, 200, "the checkout list: status");
      requireContains(list.body, `href="/checkout/${checkoutA}"`, "the checkout list: a link to the new checkout");
      expectEffects(before.tables, await tables(), {}, "page loads");
      await expectSessionChanges(before.sessions, 0, "page loads");
    }),
  );

  it(
    "owner isolation: another owner can neither see nor change the checkout, even with its true form values",
    guarded("owner isolation", async () => {
      other = await admit();
      const otherForms = await shopForms(other);
      const csrfToken = otherForms.starts[0].hidden.csrfToken;
      const before = await tables();

      // The page. Expected: none of the checkout's values and no form for it.
      const page = await get(`/checkout/${checkoutA}`, other);
      requireAbsent(page.body, formA.hidden.confirmationId, "another owner's view: the challenge id");
      requireAbsent(page.body, formA.hidden.nonce, "another owner's view: the nonce");
      requireAbsent(page.body, formA.hidden.quoteDigest, "another owner's view: the quote digest");
      requireSafeEqual(parseForms(page.body).filter((form) => form.action.startsWith(`/checkout/${checkoutA}/`)).length, 0, "another owner's view: forms for the checkout");

      // The routes. Expected: 404 NOT_FOUND each, as for a checkout that does not exist.
      expectRefusal(await post(`/checkout/${checkoutA}/confirm`, acknowledged(formA, { csrfToken }), other), 404, "NOT_FOUND", "another owner confirms");
      expectRefusal(await post(`/checkout/${checkoutA}/review`, { csrfToken }, other), 404, "NOT_FOUND", "another owner reviews");
      expectRefusal(await post(`/checkout/${checkoutA}/cancel`, { csrfToken }, other), 404, "NOT_FOUND", "another owner cancels");

      // Permitted effect: rows of the OTHER owner's request window and audit trail, which its own refused calls may
      // touch. No checkout row of anyone, and no row of the first owner.
      const after = await tables();
      expectEffects(before, after, {}, "owner isolation", ["owner_request_windows", "audit_events"]);
      for (const table of ["owner_request_windows", "audit_events"] as const) {
        const earlier = new Set(before[table]);
        const later = new Set(after[table]);
        const touched = [...before[table].filter((row) => !later.has(row)), ...after[table].filter((row) => !earlier.has(row))];
        requireSafeEqual(touched.filter((row) => !row.includes(other.ownerId) || row.includes(main.ownerId)).length, 0, `owner isolation: ${table} rows changed that are not the other owner's`);
      }
      await expectIntent(checkoutA, "QUOTED", main.ownerId, "owner isolation");
      await expectChallenges(checkoutA, ["ACTIVE"], "owner isolation", formA.hidden.confirmationId);
    }),
  );

  it(
    "a matching challenge with wrong quote fields: the database's CONFIRMATION_MISMATCH, counted and audited",
    guarded("mismatch", async () => {
      const shopper = await admit();
      const intentId = await startCheckout(shopper, (await shopForms(shopper)).starts[0].hidden);
      const form = requireConfirm(await checkoutPage(shopper, intentId), "mismatch");
      const intentBefore = await intentRow(intentId);

      // Each: expected 303 to the checkout with CONFIRMATION_MISMATCH. Permitted effects: exactly one new
      // CONFIRMATION_REJECTED audit row and one counted call. The challenge stays ACTIVE; the checkout is unchanged.
      let rejected = (await auditsOf(shopper.ownerId)).CONFIRMATION_REJECTED ?? 0;
      const wrongFields: Array<Record<string, string>> = [{ quoteId: `qt_${hex(16)}` }, { quoteDigest: hex(32) }];
      for (const wrong of wrongFields) {
        const label = `mismatch (wrong ${Object.keys(wrong).join(", ")})`;
        const before = { tables: await tables(), window: await windowOf(shopper.ownerId) };
        expectRedirect(await post(`/checkout/${intentId}/confirm`, acknowledged(form, wrong), shopper), `/checkout/${intentId}?error=CONFIRMATION_MISMATCH`, label);
        expectEffects(before.tables, await tables(), { audit_events: { added: 1, removed: 0 } }, label, ["owner_request_windows"]);
        expectCountedCalls(before.window, await windowOf(shopper.ownerId), 1, label);
        rejected += 1;
        const audits = await auditsOf(shopper.ownerId);
        requireSafeEqual({ rejected: audits.CONFIRMATION_REJECTED ?? 0, accepted: audits.CONFIRMATION_ACCEPTED ?? 0 }, { rejected, accepted: 0 }, `${label}: confirmation audit rows of the owner`);
      }
      requireSameFields(await intentRow(intentId), intentBefore, "mismatch: the checkout row against the row before");
      await expectChallenges(intentId, ["ACTIVE"], "mismatch", form.hidden.confirmationId);

      const shown = await checkoutPage(shopper, intentId, "?error=CONFIRMATION_MISMATCH");
      requireContains(shown.text, messageFor("CONFIRMATION_MISMATCH") ?? "", "mismatch: the public message on the page");
      requireSameSecret(requireConfirm(shown, "mismatch, page afterwards").hidden.confirmationId, form.hidden.confirmationId, "mismatch: the challenge shown afterwards against the one before");
    }),
  );

  it(
    "local outcomes: a cross-checkout, unknown, unacknowledged or malformed submission consumes nothing",
    guarded("local outcomes", async () => {
      const shop = await shopForms(main);
      checkoutB = await startCheckout(main, shop.starts[shop.starts.length - 1].hidden);
      const formB = requireConfirm(await checkoutPage(main, checkoutB), "checkout B");
      requireDifferentSecret(formB.hidden.confirmationId, formA.hidden.confirmationId, "checkout B's challenge against checkout A's");

      // Permitted effect of all four: the session's activity. No checkout row, no counted call, no audit row.
      const before = { tables: await tables(), window: await windowOf(main.ownerId), sessions: await sessionRows() };
      // B's form to A's URL. Expected: 303, FORM_OUT_OF_DATE on A.
      expectRedirect(await post(`/checkout/${checkoutA}/confirm`, acknowledged(formB), main), `/checkout/${checkoutA}?error=FORM_OUT_OF_DATE`, "B's form to A's URL");
      // A challenge id that does not exist, with A's other values. Expected: the same.
      expectRedirect(await post(`/checkout/${checkoutA}/confirm`, acknowledged(formA, { confirmationId: `cf_${hex(16)}` }), main), `/checkout/${checkoutA}?error=FORM_OUT_OF_DATE`, "an unknown challenge id");
      // A's own form without the acknowledgement. Expected: 303, ACKNOWLEDGEMENT_REQUIRED.
      expectRedirect(await post(`/checkout/${checkoutA}/confirm`, formA.hidden, main), `/checkout/${checkoutA}?error=ACKNOWLEDGEMENT_REQUIRED`, "no acknowledgement");
      // A nonce of the wrong shape. Expected: 400 BAD_REQUEST, before any checkout call.
      expectRefusal(await post(`/checkout/${checkoutA}/confirm`, acknowledged(formA, { nonce: "short" }), main), 400, "BAD_REQUEST", "a malformed nonce");

      expectEffects(before.tables, await tables(), {}, "local outcomes");
      expectCountedCalls(before.window, await windowOf(main.ownerId), 0, "local outcomes");
      await expectSessionChanges(before.sessions, 0, "local outcomes");
      await expectChallenges(checkoutA, ["ACTIVE"], "local outcomes, checkout A", formA.hidden.confirmationId);
      await expectChallenges(checkoutB, ["ACTIVE"], "local outcomes, checkout B", formB.hidden.confirmationId);
      const shown = await checkoutPage(main, checkoutA, "?error=FORM_OUT_OF_DATE");
      requireContains(shown.text, messageFor("FORM_OUT_OF_DATE") ?? "", "local outcomes: the public message on the page");
    }),
  );

  /** The effects of one accepted confirmation, and no others. The request window is checked apart. */
  const ONE_CONFIRMATION: Effects = {
    checkout_intents: { added: 1, removed: 1 },
    confirmation_challenges: { added: 1, removed: 1 },
    checkout_transitions: { added: 1, removed: 0 },
    audit_events: { added: 1, removed: 0 },
  };

  it(
    "confirmation, then the same form again: CONFIRMED once, then ALREADY_CONFIRMED with nothing changed",
    guarded("confirmation and replay", async () => {
      const intentBefore = await intentRow(checkoutA);
      const before = { tables: await tables(), window: await windowOf(main.ownerId) };

      // Expected: 303 with the CONFIRMED notice. Permitted effects, and no others: the checkout row and the challenge
      // row updated, one transition, one CONFIRMATION_ACCEPTED audit row, one counted call.
      expectRedirect(await post(`/checkout/${checkoutA}/confirm`, acknowledged(formA), main), `/checkout/${checkoutA}?notice=CONFIRMED`, "confirmation");
      const confirmed = { tables: await tables(), window: await windowOf(main.ownerId) };
      expectEffects(before.tables, confirmed.tables, ONE_CONFIRMATION, "confirmation", ["owner_request_windows"]);
      expectCountedCalls(before.window, confirmed.window, 1, "confirmation");
      const row = await expectIntent(checkoutA, "USER_CONFIRMED", main.ownerId, "confirmation");
      requireSafeEqual(Number(row.row_version) - Number(intentBefore.row_version), 1, "confirmation: row version increase");
      requireThat(row.confirmation_id === formA.hidden.confirmationId, "confirmation: the checkout names the consumed challenge");
      await expectChallenges(checkoutA, ["CONSUMED"], "confirmation", formA.hidden.confirmationId);
      requireSafeEqual((await auditsOf(main.ownerId)).CONFIRMATION_ACCEPTED ?? 0, 1, "confirmation: accepted audit rows of the owner");

      // The replay, sent after the first answer was received. Expected: 303 with the ALREADY_CONFIRMED notice, decided
      // from the read: no consume call. Permitted effect: the session's activity only.
      expectRedirect(await post(`/checkout/${checkoutA}/confirm`, acknowledged(formA), main), `/checkout/${checkoutA}?notice=ALREADY_CONFIRMED`, "replay");
      expectEffects(confirmed.tables, await tables(), {}, "replay");
      expectCountedCalls(confirmed.window, await windowOf(main.ownerId), 0, "replay");

      const shown = await checkoutPage(main, checkoutA, "?notice=ALREADY_CONFIRMED");
      requireThat(shown.confirm === undefined, "replay: the page no longer shows a confirmation form");
      requireContains(shown.text, "Confirmed by you", "replay: the status wording on the page");
      requireContains(shown.text, messageFor("ALREADY_CONFIRMED") ?? "", "replay: the public message on the page");
    }),
  );

  it(
    "replacement and cancellation: a confirmed checkout is replaced, a canceled one is not, and its record stays",
    guarded("replacement and cancellation", async () => {
      // Replacement from USER_CONFIRMED. Expected: 303 to a new checkout. Permitted effects: the predecessor becomes
      // SUPERSEDED and names its successor; the successor is QUOTED.
      const confirmedPage = await checkoutPage(main, checkoutA);
      const replace = confirmedPage.forms.find((form) => form.action === "/checkout/start" && form.hidden.replaces === checkoutA);
      requireThat(replace !== undefined, "a confirmed checkout offers a replacing quote");
      const successor = await startCheckout(main, (replace as ParsedForm).hidden);
      requireThat(successor !== checkoutA, "the replacing checkout is a new checkout");
      const predecessor = await expectIntent(checkoutA, "SUPERSEDED", main.ownerId, "the replaced checkout");
      requireThat(predecessor.superseded_by_intent_id === successor, "the replaced checkout names its successor");
      await expectIntent(successor, "QUOTED", main.ownerId, "the replacing checkout");

      // Cancellation. Expected: 303 with the CANCELED notice; the checkout is CANCELED_LOCAL.
      const successorPage = await checkoutPage(main, successor);
      const cancel = successorPage.forms.find((form) => form.action === `/checkout/${successor}/cancel`);
      requireThat(cancel !== undefined, "a quoted checkout offers cancellation");
      expectRedirect(await post(`/checkout/${successor}/cancel`, (cancel as ParsedForm).hidden, main), `/checkout/${successor}?notice=CANCELED`, "cancellation");
      await expectIntent(successor, "CANCELED_LOCAL", main.ownerId, "the canceled checkout");
      canceled = successor;

      // A canceled checkout offers a new checkout with NO predecessor. Expected: 303 to a new checkout. Permitted
      // effect on the canceled checkout: none; its row is identical afterwards.
      const canceledPage = await checkoutPage(main, canceled);
      const another = canceledPage.forms.filter((form) => form.action === "/checkout/start");
      requireSafeEqual(another.length, 1, "a canceled checkout: forms that start a checkout");
      requireThat(!("replaces" in another[0].hidden), "a canceled checkout: its start form names no predecessor");
      const rowsOfCanceled = async (): Promise<string[]> => (await tables()).checkout_intents.filter((row) => row.includes(canceled));
      const canceledBefore = await rowsOfCanceled();
      latest = await startCheckout(main, another[0].hidden);
      requireSameRows(canceledBefore, await rowsOfCanceled(), "the canceled checkout's row after another checkout was started");
      await expectIntent(latest, "QUOTED", main.ownerId, "the checkout started after a cancellation");

      // A canceled checkout named as a predecessor. Expected: 303 back to it with REPLACEMENT_NOT_ALLOWED, decided
      // from the read. Permitted effect: none.
      const before = { tables: await tables(), window: await windowOf(main.ownerId) };
      expectRedirect(await post("/checkout/start", { ...another[0].hidden, replaces: canceled }, main), `/checkout/${canceled}?error=REPLACEMENT_NOT_ALLOWED`, "a canceled predecessor");
      expectEffects(before.tables, await tables(), {}, "a canceled predecessor");
      expectCountedCalls(before.window, await windowOf(main.ownerId), 0, "a canceled predecessor");
    }),
  );

  it(
    "the simulation route does not exist in PostgreSQL mode",
    guarded("simulation", async () => {
      // Expected: 404 NOT_FOUND for an authorized request, and no simulation form on the page. Permitted effect: none.
      const page = await checkoutPage(main, latest);
      requireSafeEqual(page.forms.filter((form) => form.action.endsWith("/simulate")).length, 0, "simulation: forms posting to a simulate route");
      const csrfToken = requireConfirm(page, "simulation").hidden.csrfToken;
      const before = await tables();
      expectRefusal(await post(`/checkout/${latest}/simulate`, { csrfToken, step: "approve" }, main), 404, "NOT_FOUND", "simulation");
      expectEffects(before, await tables(), {}, "simulation");
    }),
  );

  it(
    "two overlapping confirmations, not forced into an order: one confirms, the other is an allowed replay",
    guarded("overlapping confirmations", async () => {
      // NOT a forced overlap. Nothing here decides which request the database sees first, or whether the second one
      // reaches consume_challenge at all; both orders are allowed, and the path taken is observed and recorded.
      const shopper = await admit();
      const intentId = await startCheckout(shopper, (await shopForms(shopper)).starts[0].hidden);
      const form = requireConfirm(await checkoutPage(shopper, intentId), "overlap");
      const before = { tables: await tables(), window: await windowOf(shopper.ownerId) };

      // Both are submitted before either is awaited. `submit` attaches its handlers at once and never rejects.
      const first = client.submit(postSpec(`/checkout/${intentId}/confirm`, acknowledged(form), shopper));
      const second = client.submit(postSpec(`/checkout/${intentId}/confirm`, acknowledged(form), shopper));
      const settled = await Promise.all([first, second]);
      requireSafeEqual(settled.map((outcome) => (outcome.ok ? "REPLY" : outcome.code)), ["REPLY", "REPLY"], "overlap: how the two requests settled");
      const received = settled.flatMap((outcome) => (outcome.ok ? [record(outcome.reply)] : []));
      requireSafeEqual(received.map((reply) => reply.status), [303, 303], "overlap: statuses");
      const locations = received.map((reply, index) => sole(reply.headers.location, `overlap: Location of request ${index + 1}`));

      const page = `/checkout/${intentId}`;
      // Exactly one successful confirmation.
      requireSafeEqual(locations.filter((location) => location === `${page}?notice=CONFIRMED`).length, 1, "overlap: requests answered CONFIRMED");
      const replay = locations.find((location) => location !== `${page}?notice=CONFIRMED`) ?? "";
      // The other: decided locally from its read, or by the database in consume_challenge.
      const local = replay === `${page}?notice=ALREADY_CONFIRMED`;
      const byDatabase = replay === `${page}?error=CONFIRMATION_ALREADY_USED`;
      requireThat(local || byDatabase, "overlap: the other request is ALREADY_CONFIRMED (local) or CONFIRMATION_ALREADY_USED (database); it was neither");
      overlapPath = local ? "LOCAL_REPLAY" : "DATABASE_REPLAY";

      // Permitted effects, the same on both paths: one confirmation's worth of rows. Exactly one accepted audit row
      // and one transition. The database replay adds a counted call and nothing else.
      const after = { tables: await tables(), window: await windowOf(shopper.ownerId) };
      expectEffects(before.tables, after.tables, ONE_CONFIRMATION, `overlap (${overlapPath})`, ["owner_request_windows"]);
      const audits = await auditsOf(shopper.ownerId);
      requireSafeEqual({ accepted: audits.CONFIRMATION_ACCEPTED ?? 0, rejected: audits.CONFIRMATION_REJECTED ?? 0 }, { accepted: 1, rejected: 0 }, `overlap (${overlapPath}): confirmation audit rows of the owner`);
      expectCountedCalls(before.window, after.window, local ? 1 : 2, `overlap (${overlapPath})`);
      await expectIntent(intentId, "USER_CONFIRMED", shopper.ownerId, "overlap");
      await expectChallenges(intentId, ["CONSUMED"], "overlap", form.hidden.confirmationId);
    }),
  );

  it(
    "restart: the session, the checkout, the challenge and its nonce survive a stop and a start of the application",
    guarded("restart", async () => {
      const shopper = await admit();
      const intentId = await startCheckout(shopper, (await shopForms(shopper)).starts[0].hidden);
      const form = requireConfirm(await checkoutPage(shopper, intentId), "before the restart");
      const before = { tables: await tables(), sessions: await sessionRows(), owners: await ownerCount() };

      // Only the application stops. PostgreSQL keeps running: the observations below are made while it is down.
      await stopApplication();
      let webBackends = -1;
      for (let attempt = 0; attempt < 50 && webBackends !== 0; attempt += 1) {
        webBackends = (await backends()).shopaccess_web?.backends ?? 0;
        if (webBackends !== 0) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      requireSafeEqual(webBackends, 0, "while the application is stopped: backends of the web role");
      expectEffects(before.tables, await tables(), {}, "while the application is stopped");

      // The same database and the same private keys. Nothing of the first process is carried over but the cookie.
      await start("restart", configuration);
      const again = requireConfirm(await checkoutPage(shopper, intentId), "after the restart");
      const { csrfToken: tokenBefore, ...challengeBefore } = form.hidden;
      const { csrfToken: tokenAfter, ...challengeAfter } = again.hidden;
      // The same challenge id, quote id, quote digest and derived nonce. A failure names the fields that differ.
      requireSameFields(challengeAfter, challengeBefore, "after the restart: the challenge's hidden fields against those before");
      requireSafeEqual(tokenAfter.length, tokenBefore.length, "after the restart: length of the CSRF token");
      const list = await get("/checkouts", shopper);
      requireContains(list.body, `href="/checkout/${intentId}"`, "after the restart: the checkout list links to the checkout");

      // Nothing was created in place of what existed: no session, no owner, no checkout, no challenge, no audit row.
      expectEffects(before.tables, await tables(), {}, "after the restart, before confirming");
      await expectSessionChanges(before.sessions, 0, "after the restart");
      requireSafeEqual(await ownerCount(), before.owners, "after the restart: owners");
      requireThat(((await backends()).shopaccess_web?.backends ?? 0) >= 1, "after the restart: the web role is connected again");

      // And it is still usable. Expected: 303 with the CONFIRMED notice, with the effects of one confirmation.
      const window = await windowOf(shopper.ownerId);
      expectRedirect(await post(`/checkout/${intentId}/confirm`, acknowledged(again), shopper), `/checkout/${intentId}?notice=CONFIRMED`, "confirmation after the restart");
      expectEffects(before.tables, await tables(), ONE_CONFIRMATION, "confirmation after the restart", ["owner_request_windows"]);
      expectCountedCalls(window, await windowOf(shopper.ownerId), 1, "confirmation after the restart");
      await expectChallenges(intentId, ["CONSUMED"], "confirmation after the restart", form.hidden.confirmationId);
      await expectSessionChanges(before.sessions, 0, "confirmation after the restart");
    }),
  );

  it(
    "wrong role: connected as a superuser, the application serves nothing and changes nothing",
    guarded("wrong role", async () => {
      // The administrator credentials are the ones the harness was given for this disposable cluster. No role is
      // created or altered. The migration-role variant is deferred: the harness offers no login for that role.
      await stopApplication();
      const target = parseAdminTarget(process.env);
      if (!target.ok) throw new CodedFailure(target.code);
      const elevated = { ...configuration, SHOPACCESS_DATABASE_URL: databaseUrl(target.target.user, target.target.password) };
      secret("connection URL", elevated.SHOPACCESS_DATABASE_URL);
      const before = { tables: await tables(), sessions: await sessionRows(), owners: await ownerCount() };
      await start("wrong-role", elevated);

      // The page. Expected: the unavailable notice and no catalog. Never the fixture catalog, never the mock.
      const home = await get("/");
      const text = visibleText(home.body);
      requireContains(text, UNAVAILABLE_NOTICE, "wrong role: the unavailable notice on the start page");
      const titles = [...new Set(catalog.map((row) => row.title))];
      titles.forEach((title, index) => requireAbsent(text, title, `wrong role: title of database product ${index + 1} of ${titles.length} on the start page`));
      // The routes. Expected: 503 UNAVAILABLE, no cookie; for a guarded request too, with a session that is valid.
      expectRefusal(await get(`/session/start?${PREFERENCES}`), 503, "UNAVAILABLE", "wrong role: admission");
      expectRefusal(
        await post("/checkout/start", { csrfToken: formA.hidden.csrfToken, productId: catalog[0].product_id, variantId: catalog[0].variant_id, quantity: "1" }, main),
        503,
        "UNAVAILABLE",
        "wrong role: a guarded start",
      );
      expectRefusal(await post("/session/new", { intent: "new-session" }, null), 503, "UNAVAILABLE", "wrong role: a new session");

      // Permitted effect: none. No session, no owner, no checkout row, and no connection as the web role.
      expectEffects(before.tables, await tables(), {}, "wrong role");
      await expectSessionChanges(before.sessions, 0, "wrong role");
      requireSafeEqual(await ownerCount(), before.owners, "wrong role: owners");
      requireSafeEqual((await backends()).shopaccess_web?.backends ?? 0, 0, "wrong role: backends of the web role");
      await stopApplication();
    }),
  );

  it(
    "no secret of the run is in a response body, a response header, an application log or the PostgreSQL server log",
    guarded("disclosure scan", async () => {
      for (const row of await sessionRows()) {
        secret("owner id", row.owner_id);
        secret("token digest", row.token_digest);
      }
      for (const row of (await database().admin.query(OBSERVE.nonceDigests)).rows as Array<{ nonce_digest: string }>) secret("nonce digest", row.nonce_digest);

      // Responses: every body, every header other than Set-Cookie, and Set-Cookie apart, where the session cookie
      // it sets is expected and nothing else is. A failure reports the surface, the header's name, the category
      // and the number of matches. Not checked: the reason phrase of the status line, and trailers.
      const inResponses = secrets.filter((entry) => RESPONSE_CATEGORIES.includes(entry.category));
      const findings: DisclosureFinding[] = replies.flatMap((reply) => scanReply(reply, inResponses, ALLOWED_IN_SET_COOKIE));
      requireThat(replies.length > 0, "the disclosure scan has responses to examine");
      requireNoFindings(findings, `secrets in ${replies.length} responses`);

      // Logs: every category, including the values a form rightly carries.
      requireSafeEqual(logFiles.length, 3, "application logs written");
      logFiles.forEach((file, index) => requireNoSecretsInText(readFileSync(file, "utf8"), secrets, `secrets in application log ${index + 1}`));
      requireNoSecretsInText(readFileSync(serverLog, "utf8"), secrets, "secrets in the PostgreSQL server log");
      applications.forEach((handle, index) => requireSafeEqual(handle.logFailures().length, 0, `log capture failures of application ${index + 1}`));
    }),
  );

  it(
    "records what this run covers and what it leaves deferred",
    guarded("summary", async () => {
      const summary = {
        driver: "tests/integration/pg-app.integration.test.ts",
        overlappingConfirmationPath: overlapPath,
        forcedOverlap: "DEFERRED",
        applicationLogs: logFiles.map((file) => file.slice(evidenceDirectory.length + 1)),
        coverage: COVERAGE.map(([acceptanceCase, status, note]) => ({ case: acceptanceCase, status, note })),
      };
      writeFileSync(join(evidenceDirectory, "driver-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      requireThat(COVERAGE.some(([, status]) => status === "DEFERRED"), "the coverage table names deferred cases");
    }),
  );
});
