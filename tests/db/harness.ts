import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { connectionSourceFromPool, connectionStartupOptions } from "@/lib/pg/client";
import { validateKeyRings, KeyRing, type ConfiguredKeyRings } from "@/lib/pg/key-ring";
import { applyMigrations } from "@/lib/pg/migrate";

/**
 * Harness for the PostgreSQL integration tests of Increment 1.
 *
 * NEVER RUN. Written under Gate B-W; running it needs the separate Gate B-X
 * authorization. Importing this module opens no connection.
 *
 * Safety model. No name proves anything: not a loopback address, not the
 * cluster marker, not a `shopaccess_` prefix. The harness therefore
 *  1. uses a server only if it is PRISTINE: the bootstrap superuser, the
 *     predefined `pg_` roles and the three built-in databases, and nothing
 *     else. A pre-existing role or database of any name, including the
 *     harness's own naming patterns, is a refusal;
 *  2. creates every other resource itself and records each one at the moment
 *     its creation is confirmed;
 *  3. verifies the attributes and memberships of the roles the bootstrap file
 *     created BEFORE any of them is given a login or a password;
 *  4. drops, on success or failure, exactly the resources it recorded and
 *     never anything else;
 *  5. holds EXCLUSIVE CONTROL of the cluster for its whole life: preflight,
 *     provisioning, the tests and cleanup. Control is a session-level advisory
 *     lock taken on a dedicated connection to the `postgres` database, which
 *     every harness invocation must use, so PostgreSQL itself lets only one
 *     invocation hold it, in any process. It is taken without waiting: a
 *     second invocation is refused, it does not queue. The server releases it
 *     when that connection ends, however the process dies. Before every step
 *     that changes or drops anything the harness asks the server whether it
 *     still holds control; if not, it stops and drops nothing;
 *  6. sends every CLUSTER-LEVEL statement (create or drop a database; create,
 *     alter or drop a role; grant a membership or a database privilege) on
 *     that same lock-owning session, one statement at a time and never inside
 *     a transaction. There is no second connection that could go on creating
 *     or dropping after the lock is gone: if the session is lost, the
 *     statement cannot be sent. Only work that must run INSIDE the test
 *     database (the bootstrap file, the migrations, the tests) uses other
 *     connections; for those the confirmation of rule 5 is the safeguard, and
 *     a loss of control in the instant after a confirmation is not excluded;
 *  7. never assumes the outcome of a statement whose connection failed. Such a
 *     statement may or may not have taken effect. The harness then attempts no
 *     cleanup at all and reports the cluster as contaminated.
 * Before any of that, and before any client or pool is even constructed, the
 * connection target itself is validated (see "Connection target" below): the
 * admin URL must have one strict form, name a loopback address literally and
 * repeat the separately authorized port; the driver is then given discrete
 * fields, never a URL, and its own effective configuration is compared with
 * those fields before `connect()` is called. This keeps the harness from
 * reaching the wrong address by mistake. It does NOT authenticate whatever is
 * listening on the authorized port: any local process can bind it, and rules 1
 * to 7 rest on answers given by that same listener.
 *
 * A run that is killed can leave resources behind. So can a run whose CREATE
 * DATABASE succeeded on the server while its acknowledgment was lost: that
 * database is never recorded as created, so it is never dropped; the harness
 * does not guess which database might be its own. The next run then refuses
 * the cluster (rule 1). The remedy is to delete and re-create the disposable
 * cluster, never to clean it up by name.
 *
 * The runtime statements the tests send are imported from the reviewed
 * catalogue `src/lib/pg/statements.ts`. This file defines none.
 */

export const ADMIN_URL_VARIABLE = "SHOPACCESS_PG_TEST_ADMIN_URL";
/** The one port the owner authorized for this run. The admin URL must repeat it; it is never taken from the URL alone. */
export const AUTHORIZED_PORT_VARIABLE = "SHOPACCESS_PG_TEST_AUTHORIZED_PORT";

/** The server must have been started with exactly this `cluster_name`. */
export const DISPOSABLE_CLUSTER_NAME = "shopaccess-disposable-test";
/** Every database the harness creates. */
export const DISPOSABLE_DATABASE_PREFIX = "shopaccess_disposable_";
/** Login roles the harness creates for named operators. */
export const TEST_LOGIN_ROLE_PREFIX = "shopaccess_t_";

export const ROOT = process.cwd();
export const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
export const BOOTSTRAP_FILE = join(ROOT, "db", "bootstrap", "0000_roles_and_schemas.sql");

// ---------------------------------------------------------------------------
// Connection target (pure; unit-tested without a database)
// ---------------------------------------------------------------------------

/** Fixed refusal codes. A refusal never carries the URL, a credential or any other input. */
export type AdminTargetRefusal =
  | "ADMIN_URL_NOT_SET"
  | "ADMIN_URL_EMPTY"
  | "ADMIN_URL_MALFORMED"
  | "ADMIN_URL_PARSER_DISAGREES"
  | "AUTHORIZED_PORT_MISSING"
  | "AUTHORIZED_PORT_INVALID"
  | "AUTHORIZED_PORT_MISMATCH"
  | "ENVIRONMENT_VARIABLE_REFUSED"
  | "CONNECTION_FIELD_REFUSED"
  | "DRIVER_TARGET_MISMATCH";

/** Thrown when the connection target is refused. Its message is the fixed code and nothing else. */
export class AdminTargetRefusedError extends Error {
  readonly code: AdminTargetRefusal;
  constructor(code: AdminTargetRefusal) {
    super(`Refusing the PostgreSQL test connection target: ${code}`);
    this.name = "AdminTargetRefusedError";
    this.code = code;
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** The validated admin target. `host` is in the driver's form: no brackets around the IPv6 loopback. */
export interface AdminTarget {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: "postgres";
}

export type AdminTargetResult = { readonly ok: true; readonly target: AdminTarget } | { readonly ok: false; readonly code: AdminTargetRefusal };

/**
 * PostgreSQL variables that may stay set. Every other `PG…` name is refused,
 * because the driver computes names (`'PG' + key`) and a fixed list of refused
 * names could not keep up with it.
 *  - PGAPPNAME: a label in `pg_stat_activity`; nothing reads it.
 *  - PGCONNECT_TIMEOUT: stored by the driver but used only by the native
 *    binding, which is refused (NODE_PG_FORCE_NATIVE).
 * USER and USERNAME (the driver's default user name) need no refusal: every
 * configuration names its user.
 */
export const PERMITTED_PG_VARIABLES: readonly string[] = ["PGAPPNAME", "PGCONNECT_TIMEOUT"];
const PG_VARIABLE_NAME = /^PG[A-Z0-9_]*$/;

/** True for a variable that must not be set while the harness runs. */
export function isRefusedEnvironmentVariable(name: string): boolean {
  return name === "NODE_PG_FORCE_NATIVE" || (PG_VARIABLE_NAME.test(name) && !PERMITTED_PG_VARIABLES.includes(name));
}

const DEFAULT_POSTGRESQL_PORT = 5432;
/** Four or five digits, no sign, no leading zero, no whitespace. */
const PORT_TEXT = /^[1-9][0-9]{3,4}$/;
/**
 * The only accepted admin URL. Literal loopback address, explicit port, the
 * `postgres` database, URL-safe credentials. There is no query string, no
 * fragment, no percent-encoding and no empty component, so no driver parameter
 * and no environment fallback can redirect or reconfigure the connection.
 */
const ADMIN_URL_GRAMMAR =
  /^(postgres|postgresql):\/\/([a-z_][a-z0-9_]{0,62}):([A-Za-z0-9._~-]{1,128})@(127\.0\.0\.1|\[::1\]):([1-9][0-9]{3,4})\/postgres$/;
const ROLE_OR_DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const URL_SAFE_PASSWORD = /^[A-Za-z0-9._~-]{1,128}$/;
const STARTUP_OPTIONS = /^-c [a-z_]+=[a-z0-9_]+(?: -c [a-z_]+=[a-z0-9_]+)*$/;

/**
 * True when every character is printable ASCII, 0x21 to 0x7E: no space, no tab,
 * no line terminator of any kind (LF, CR, CRLF, U+0085, U+2028, U+2029), no
 * other control character and nothing outside ASCII. Checked on the raw admin
 * URL and the raw authorized port before either pattern is consulted, so that
 * rejecting a trailing terminator does not rest on how `$` behaves.
 */
function isPrintableAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/** The pattern's match, but only if it spans the WHOLE input: every character from the first to the last. */
function matchWhole(pattern: RegExp, text: string): RegExpExecArray | null {
  const match = pattern.exec(text);
  return match !== null && match.index === 0 && match[0].length === text.length ? match : null;
}

function isAuthorizablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== DEFAULT_POSTGRESQL_PORT;
}

/** `[::1]` as a URL writes it becomes `::1` as the driver reports it. Exactly one enclosing bracket pair is removed. */
function canonicalHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Validates the admin target from the environment, without constructing or
 * connecting anything. Every condition must hold:
 *
 *  1. the admin URL is set and not blank;
 *  2. no refused PostgreSQL variable is set (see PERMITTED_PG_VARIABLES);
 *  3. the authorized port is set, decimal, from 1024 to 65535 and not 5432,
 *     and consists of printable ASCII only;
 *  4. the URL consists of printable ASCII only and matches ADMIN_URL_GRAMMAR
 *     over its whole length, character for character;
 *  5. the URL's port equals the authorized port;
 *  6. the platform URL parser reads the same scheme, user, password, host,
 *     port and path from it, with no query and no fragment.
 *
 * A matching port is not proof of what is listening on it.
 */
export function parseAdminTarget(env: Environment): AdminTargetResult {
  const refuse = (code: AdminTargetRefusal): AdminTargetResult => ({ ok: false, code });
  const raw = env[ADMIN_URL_VARIABLE];
  if (raw === undefined) return refuse("ADMIN_URL_NOT_SET");
  if (raw.trim() === "") return refuse("ADMIN_URL_EMPTY");

  for (const name of Object.keys(env)) {
    if (env[name] !== undefined && isRefusedEnvironmentVariable(name)) return refuse("ENVIRONMENT_VARIABLE_REFUSED");
  }

  const portText = env[AUTHORIZED_PORT_VARIABLE];
  if (portText === undefined) return refuse("AUTHORIZED_PORT_MISSING");
  if (!isPrintableAscii(portText) || !matchWhole(PORT_TEXT, portText) || !isAuthorizablePort(Number(portText))) return refuse("AUTHORIZED_PORT_INVALID");
  const port = Number(portText);

  const match = isPrintableAscii(raw) ? matchWhole(ADMIN_URL_GRAMMAR, raw) : null;
  if (!match) return refuse("ADMIN_URL_MALFORMED");
  const [, scheme, user, password, urlHost, urlPort] = match;
  if (urlPort !== portText) return refuse("AUTHORIZED_PORT_MISMATCH");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The parser's own error carries its input. It is dropped, not rethrown or attached.
    return refuse("ADMIN_URL_PARSER_DISAGREES");
  }
  const agrees =
    url.protocol === `${scheme}:` &&
    url.username === user &&
    url.password === password &&
    url.hostname === urlHost &&
    url.port === urlPort &&
    url.pathname === "/postgres" &&
    url.search === "" &&
    url.hash === "";
  if (!agrees) return refuse("ADMIN_URL_PARSER_DISAGREES");

  const host = canonicalHost(urlHost);
  if (host !== "127.0.0.1" && host !== "::1") return refuse("ADMIN_URL_MALFORMED");
  return { ok: true, target: Object.freeze({ host, port, user, password, database: "postgres" as const }) };
}

/**
 * What a client or pool is given: discrete fields only. The driver never
 * parses a connection URL, so there is nothing for it to reinterpret. TLS is
 * off: every connection is to a loopback address.
 */
export interface DriverConfig {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: false;
  readonly options?: string;
}

export interface ConnectionIdentity {
  readonly database: string;
  readonly user: string;
  readonly password: string;
  /** Startup options, as `-c name=value` pairs. */
  readonly options?: string;
}

/** Builds one driver configuration from the validated target. Every field is checked again against a fixed pattern. */
export function connectionConfig(target: AdminTarget, identity: ConnectionIdentity): DriverConfig {
  const acceptable =
    (target.host === "127.0.0.1" || target.host === "::1") &&
    isAuthorizablePort(target.port) &&
    ROLE_OR_DATABASE_NAME.test(identity.database) &&
    ROLE_OR_DATABASE_NAME.test(identity.user) &&
    URL_SAFE_PASSWORD.test(identity.password) &&
    (identity.options === undefined || STARTUP_OPTIONS.test(identity.options));
  if (!acceptable) throw new AdminTargetRefusedError("CONNECTION_FIELD_REFUSED");
  return Object.freeze({
    host: target.host,
    port: target.port,
    user: identity.user,
    password: identity.password,
    database: identity.database,
    ssl: false as const,
    ...(identity.options === undefined ? {} : { options: identity.options }),
  });
}

/**
 * Compares what the driver will actually use with what the harness asked for.
 * `client` is a constructed, UNCONNECTED client. Anything that differs or is
 * missing is a refusal: the client is then never connected. This is what
 * notices a driver that reads a field, an environment variable or a default in
 * a way this file did not expect.
 */
export function verifyEffectiveConfig(client: unknown, expected: DriverConfig): void {
  const refused = new AdminTargetRefusedError("DRIVER_TARGET_MISMATCH");
  if (typeof client !== "object" || client === null) throw refused;
  const seen = client as Record<string, unknown>;
  const parameters = seen.connectionParameters;
  if (typeof parameters !== "object" || parameters === null) throw refused;
  const effective = parameters as Record<string, unknown>;
  const agrees =
    seen.host === expected.host &&
    seen.port === expected.port &&
    seen.user === expected.user &&
    seen.database === expected.database &&
    seen.ssl === false &&
    effective.host === expected.host &&
    effective.port === expected.port &&
    effective.user === expected.user &&
    effective.password === expected.password &&
    effective.database === expected.database &&
    effective.options === expected.options &&
    effective.ssl === false &&
    effective.isDomainSocket === false &&
    !effective.replication &&
    !effective.binary;
  if (!agrees) throw refused;
}

/** A client whose effective configuration was verified. It has not been connected. */
function verifiedClient(config: DriverConfig): Client {
  const client = new Client(config);
  verifyEffectiveConfig(client, config);
  return client;
}

/**
 * A pool whose configuration was verified first, on an unconnected client
 * built from the very options object the pool is then given. That probe is
 * never connected. On a mismatch no pool is constructed.
 */
function verifiedPool(config: DriverConfig, max: number): Pool {
  const options = Object.freeze({ ...config, max });
  verifyEffectiveConfig(new Client(options), config);
  return new Pool(options);
}

/** The keys of the PGT-04 child's environment. Exactly these: nothing is inherited. */
export const ADMISSION_CHILD_ENVIRONMENT_KEYS: readonly string[] = [
  "NODE_ENV",
  "PATH",
  "ADMISSION_HOST",
  "ADMISSION_PORT",
  "ADMISSION_USER",
  "ADMISSION_PASSWORD",
  "ADMISSION_DATABASE",
  "ADMISSION_OPTIONS",
  "ADMISSION_STATEMENT",
  "ADMISSION_COUNT",
];

/**
 * The complete environment of a PGT-04 child process. It is built from a
 * verified driver configuration and carries discrete fields, never a URL. The
 * credential travels here, never in the child's arguments. Never log it.
 */
export function admissionChildEnvironment(connection: DriverConfig, statement: string, count: number, path: string): NodeJS.ProcessEnv {
  const acceptable =
    (connection.host === "127.0.0.1" || connection.host === "::1") &&
    isAuthorizablePort(connection.port) &&
    ROLE_OR_DATABASE_NAME.test(connection.database) &&
    ROLE_OR_DATABASE_NAME.test(connection.user) &&
    URL_SAFE_PASSWORD.test(connection.password) &&
    connection.options !== undefined &&
    STARTUP_OPTIONS.test(connection.options) &&
    Number.isInteger(count) &&
    count >= 1 &&
    count <= 100;
  if (!acceptable || connection.options === undefined) throw new AdminTargetRefusedError("CONNECTION_FIELD_REFUSED");
  return {
    NODE_ENV: "test",
    PATH: path,
    ADMISSION_HOST: connection.host,
    ADMISSION_PORT: String(connection.port),
    ADMISSION_USER: connection.user,
    ADMISSION_PASSWORD: connection.password,
    ADMISSION_DATABASE: connection.database,
    ADMISSION_OPTIONS: connection.options,
    ADMISSION_STATEMENT: statement,
    ADMISSION_COUNT: String(count),
  };
}

/**
 * The program of a PGT-04 child process, passed to `node -e`. One expression,
 * so that a unit test can run it against a stub driver and wait for it.
 *
 * The child validates its own connection. It refuses a PostgreSQL variable in
 * its environment, a host that is not a loopback literal and a port that could
 * not have been authorized; it gives the driver discrete fields; and it
 * compares every client's effective configuration with those fields BEFORE
 * any client connects. On a refusal it prints a fixed code, connects nothing
 * and ends with a non-zero exit code.
 *
 * It prints only "ready", its report, and error or refusal codes: never a
 * message that could carry the credential.
 */
export const ADMISSION_CHILD_PROGRAM = `
(async () => {
  const { Client } = require("pg");
  const { randomBytes } = require("node:crypto");
  const env = process.env;
  const refuse = (code) => {
    process.stderr.write("child refused: " + code + "\\n");
    process.exitCode = 2;
  };
  for (const name of Object.keys(env)) {
    if (name === "NODE_PG_FORCE_NATIVE" || /^PG[A-Z0-9_]*$/.test(name)) return refuse("ENVIRONMENT_VARIABLE_REFUSED");
  }
  const host = env.ADMISSION_HOST;
  const port = Number(env.ADMISSION_PORT);
  const user = env.ADMISSION_USER;
  const password = env.ADMISSION_PASSWORD;
  const database = env.ADMISSION_DATABASE;
  const options = env.ADMISSION_OPTIONS;
  const count = Number(env.ADMISSION_COUNT);
  const text = (value, pattern) => typeof value === "string" && pattern.test(value);
  const acceptable =
    (host === "127.0.0.1" || host === "::1") &&
    text(env.ADMISSION_PORT, /^[1-9][0-9]{3,4}$/) && port >= 1024 && port <= 65535 && port !== 5432 &&
    text(user, /^[a-z_][a-z0-9_]{0,62}$/) &&
    text(database, /^[a-z_][a-z0-9_]{0,62}$/) &&
    text(password, /^[A-Za-z0-9._~-]{1,128}$/) &&
    text(options, /^-c [a-z_]+=[a-z0-9_]+(?: -c [a-z_]+=[a-z0-9_]+)*$/) &&
    text(env.ADMISSION_STATEMENT, /^SELECT /) &&
    text(env.ADMISSION_COUNT, /^[1-9][0-9]{0,2}$/) && count <= 100;
  if (!acceptable) return refuse("CONNECTION_FIELD_REFUSED");
  const clients = [];
  for (let i = 0; i < count; i += 1) {
    const client = new Client({ host, port, user, password, database, options, ssl: false });
    const effective = client.connectionParameters;
    const agrees =
      client.host === host && client.port === port && client.user === user && client.database === database && client.ssl === false &&
      effective && effective.host === host && effective.port === port && effective.user === user && effective.password === password &&
      effective.database === database && effective.options === options && effective.ssl === false && effective.isDomainSocket === false &&
      !effective.replication && !effective.binary;
    if (!agrees) return refuse("DRIVER_TARGET_MISMATCH");
    clients.push(client);
  }
  // Every client was verified above; only now does anything connect.
  for (const client of clients) await client.connect();
  process.stdout.write("ready\\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  // Nothing more is read. An open stdin would keep this process alive after its work is done.
  process.stdin.destroy();
  const results = await Promise.all(clients.map(async (client) => {
    try {
      const values = ["ses_" + randomBytes(16).toString("hex"), 1, randomBytes(32).toString("hex")];
      return (await client.query(env.ADMISSION_STATEMENT, values)).rows[0].result;
    } catch (error) {
      return "ERROR:" + (error && error.code ? error.code : "UNKNOWN");
    }
  }));
  await Promise.all(clients.map((client) => client.end()));
  // The exit code is set and the process ends by itself once the report has been flushed.
  process.exitCode = 0;
  process.stdout.write(JSON.stringify({ pid: process.pid, results }) + "\\n");
})().catch((error) => {
  // An error code only: never a message that could carry the credential.
  process.stderr.write("child failed: " + (error && error.code ? error.code : "UNKNOWN") + "\\n");
  process.exit(1);
})
`;

// ---------------------------------------------------------------------------
// Facts and assessments (pure; unit-tested without a database)
// ---------------------------------------------------------------------------

export interface RoleFacts {
  readonly name: string;
  /** True only for the role initdb created (oid 10). */
  readonly isBootstrapSuperuser: boolean;
  readonly superuser: boolean;
  readonly createRole: boolean;
  readonly createDb: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly canLogin: boolean;
}

export interface MembershipFacts {
  /** The role that received the membership. */
  readonly member: string;
  /** The role it is a member of. */
  readonly role: string;
  readonly admin: boolean;
  readonly inherit: boolean;
  readonly set: boolean;
}

export interface ClusterFacts {
  /** Host from the admin URL. */
  readonly host: string;
  /** Database named in the admin URL. */
  readonly adminDatabase: string;
  /** `SHOW cluster_name`. */
  readonly clusterName: string;
  /** `SHOW server_version_num`, e.g. 170002. */
  readonly serverVersionNum: number;
  /** The connecting role's name. */
  readonly sessionUser: string;
  /** Every database in the cluster. */
  readonly databases: readonly string[];
  /** Every role in the cluster, with its attributes. */
  readonly roles: readonly RoleFacts[];
  /** Every role membership in the cluster. */
  readonly memberships: readonly MembershipFacts[];
}

export type Assessment = { ok: true } | { ok: false; reasons: string[] };

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]"];
const BUILT_IN_DATABASES: readonly string[] = ["postgres", "template0", "template1"];
export const SHOPACCESS_ROLES: readonly string[] = [
  "shopaccess_owner",
  "shopaccess_definer",
  "shopaccess_web",
  "shopaccess_worker",
  "shopaccess_operator",
];

const isPredefined = (name: string) => name.startsWith("pg_");
const elevated = (role: RoleFacts): string[] =>
  [
    role.superuser ? "SUPERUSER" : "",
    role.createRole ? "CREATEROLE" : "",
    role.createDb ? "CREATEDB" : "",
    role.replication ? "REPLICATION" : "",
    role.bypassRls ? "BYPASSRLS" : "",
  ].filter((attribute) => attribute !== "");

function assessIdentity(facts: ClusterFacts, reasons: string[]): void {
  if (!LOOPBACK_HOSTS.includes(facts.host)) reasons.push("host is not loopback");
  if (facts.adminDatabase !== "postgres") reasons.push("admin URL must name the postgres maintenance database");
  if (facts.clusterName !== DISPOSABLE_CLUSTER_NAME) reasons.push(`cluster_name is not ${DISPOSABLE_CLUSTER_NAME}`);
  if (Math.floor(facts.serverVersionNum / 10_000) !== 17) reasons.push("server is not PostgreSQL 17");
  const self = facts.roles.find((role) => role.name === facts.sessionUser);
  if (!self || !self.superuser || !self.isBootstrapSuperuser) {
    reasons.push("connecting role is not the bootstrap superuser of the cluster");
  }
}

/** Predefined roles must be what initdb made them: no login, no elevated attribute. */
function assessPredefinedRoles(facts: ClusterFacts, reasons: string[]): void {
  for (const role of facts.roles.filter((candidate) => isPredefined(candidate.name))) {
    if (role.canLogin || role.isBootstrapSuperuser || elevated(role).length > 0) {
      reasons.push(`predefined role ${role.name} has unexpected attributes`);
    }
  }
}

/**
 * Decides whether a server may be used at all. Every condition must hold:
 *
 *  1. the host is loopback (necessary, never sufficient);
 *  2. the admin URL names the `postgres` maintenance database;
 *  3. the server was started with `cluster_name` set to DISPOSABLE_CLUSTER_NAME
 *     (necessary, never sufficient);
 *  4. the server is PostgreSQL 17;
 *  5. the connecting role is the bootstrap superuser;
 *  6. there is NO database other than the three built-in ones;
 *  7. there is NO role other than the connecting role and predefined `pg_`
 *     roles, and those have their initdb attributes;
 *  8. there is NO role membership except between predefined roles.
 *
 * Conditions 6 to 8 make no exception for names the harness itself uses. A
 * `shopaccess_web` role or a `shopaccess_disposable_…` database that already
 * exists was not created by this invocation, so nothing is known about it.
 */
export function assessDisposableCluster(facts: ClusterFacts): Assessment {
  const reasons: string[] = [];
  assessIdentity(facts, reasons);
  assessPredefinedRoles(facts, reasons);

  for (const name of facts.databases) {
    if (BUILT_IN_DATABASES.includes(name)) continue;
    reasons.push(
      name.startsWith(DISPOSABLE_DATABASE_PREFIX)
        ? `pre-existing database ${name} uses the harness prefix but was not created by this run`
        : `cluster contains another database: ${name}`,
    );
  }

  for (const role of facts.roles) {
    if (role.name === facts.sessionUser || isPredefined(role.name)) continue;
    if (role.superuser) reasons.push(`unexpected superuser role: ${role.name}`);
    else if (SHOPACCESS_ROLES.includes(role.name) || role.name.startsWith(TEST_LOGIN_ROLE_PREFIX)) {
      reasons.push(`pre-existing role ${role.name} uses a ShopAccess name but was not created by this run`);
    } else reasons.push(`cluster contains another role: ${role.name}`);
  }

  for (const membership of facts.memberships) {
    if (isPredefined(membership.member) && isPredefined(membership.role)) continue;
    reasons.push(`unexpected role membership: ${membership.member} in ${membership.role}`);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface ExpectedLogins {
  /** The named operator login this run created, if it has been created yet. */
  readonly operatorLogin: string | null;
  /** Whether this run has enabled login on `shopaccess_web`. */
  readonly webLoginEnabled: boolean;
}

/**
 * Checks the cluster after this run's bootstrap, and again after its logins
 * were created. The roles must be exactly the bootstrap superuser, predefined
 * roles, the five ShopAccess roles and this run's operator login, with:
 *  - no SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS on any of them;
 *  - LOGIN only where this run enabled it;
 *  - exactly the approved memberships, with the approved options, and no
 *    membership of any of them in a predefined or other privileged role.
 * Until this passes, no role is given a login or a password.
 */
export function assessProvisionedRoles(facts: ClusterFacts, expected: ExpectedLogins): Assessment {
  const reasons: string[] = [];
  assessIdentity(facts, reasons);
  assessPredefinedRoles(facts, reasons);

  const ours = [...SHOPACCESS_ROLES, ...(expected.operatorLogin ? [expected.operatorLogin] : [])];
  const loginAllowed = new Set<string>([
    ...(expected.webLoginEnabled ? ["shopaccess_web"] : []),
    ...(expected.operatorLogin ? [expected.operatorLogin] : []),
  ]);

  for (const name of ours) {
    const role = facts.roles.find((candidate) => candidate.name === name);
    if (!role) {
      reasons.push(`role ${name} is missing`);
      continue;
    }
    if (role.isBootstrapSuperuser) reasons.push(`role ${name} is the bootstrap superuser`);
    const attributes = elevated(role);
    if (attributes.length > 0) reasons.push(`role ${name} has elevated attributes: ${attributes.join(", ")}`);
    if (role.canLogin !== loginAllowed.has(name)) {
      reasons.push(role.canLogin ? `role ${name} can log in but was not given a login by this run` : `role ${name} cannot log in`);
    }
  }
  for (const role of facts.roles) {
    if (role.name === facts.sessionUser || isPredefined(role.name) || ours.includes(role.name)) continue;
    reasons.push(role.superuser ? `unexpected superuser role: ${role.name}` : `cluster contains another role: ${role.name}`);
  }

  const approved = new Map<string, { admin: boolean; inherit: boolean; set: boolean }>([
    ["shopaccess_owner>shopaccess_definer", { admin: false, inherit: false, set: true }],
  ]);
  if (expected.operatorLogin) {
    approved.set(`${expected.operatorLogin}>shopaccess_operator`, { admin: false, inherit: true, set: false });
  }
  const seen = new Set<string>();
  for (const membership of facts.memberships) {
    if (isPredefined(membership.member) && isPredefined(membership.role)) continue;
    const key = `${membership.member}>${membership.role}`;
    const options = approved.get(key);
    if (!options) {
      reasons.push(`unexpected role membership: ${membership.member} in ${membership.role}`);
    } else if (membership.admin !== options.admin || membership.inherit !== options.inherit || membership.set !== options.set) {
      reasons.push(`role membership ${key} has unexpected options`);
    }
    seen.add(key);
  }
  for (const key of approved.keys()) if (!seen.has(key)) reasons.push(`role membership ${key} is missing`);

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Provisioning with tracked resources and failure-safe cleanup
// (pure orchestration over a driver; unit-tested with a fake driver)
// ---------------------------------------------------------------------------

/** The steps provisioning needs. The real driver below talks to PostgreSQL; unit tests use a fake. */
export interface ProvisionDriver {
  /**
   * Tries, without waiting, to take cluster-wide exclusive control. Resolves
   * false when another invocation holds it. Must be enforced by the database.
   */
  acquireExclusiveControl(): Promise<boolean>;
  /** Asks the database whether this invocation still holds control. False or a thrown error both mean it does not. */
  holdsExclusiveControl(): Promise<boolean>;
  /** Gives control back. Called last, after cleanup, on success and on failure. */
  releaseExclusiveControl(): Promise<void>;
  readClusterFacts(): Promise<ClusterFacts>;
  /** Creates one database. Must be atomic: it either exists afterwards or the call throws. */
  createDatabase(name: string): Promise<void>;
  /** Runs the bootstrap file in that database. Must be atomic. */
  runBootstrap(database: string): Promise<void>;
  applyMigrations(database: string): Promise<void>;
  enableWebLogin(database: string): Promise<void>;
  /** Creates the operator login role and nothing else. Must be atomic. */
  createOperatorLogin(login: string): Promise<void>;
  grantOperatorLogin(database: string, login: string): Promise<void>;
  /** Closes every connection the driver opened. */
  closeConnections(): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  dropRole(name: string): Promise<void>;
}

export interface ProvisionPlan {
  readonly database: string;
  readonly operatorLogin: string;
  readonly applyMigrations: boolean;
}

export interface ProvisionedResources {
  readonly database: string;
  readonly operatorLogin: string;
  /** Asks the database whether this invocation still holds exclusive control of the cluster. */
  holdsExclusiveControl(): Promise<boolean>;
  /** Removes everything this run created, then releases control. Returns the errors met, if any; never throws. */
  cleanup(): Promise<unknown[]>;
}

const DATABASE_NAME = new RegExp(`^${DISPOSABLE_DATABASE_PREFIX}[0-9a-f]{16}$`);
const OPERATOR_LOGIN_NAME = new RegExp(`^${TEST_LOGIN_ROLE_PREFIX}operator_[0-9a-f]{16}$`);

/** Attached to the original setup error when cleanup after it was incomplete. */
export const CLEANUP_FAILURES = Symbol.for("shopaccess.test.cleanupFailures");

/** Thrown when another invocation holds the cluster, or when this one finds it no longer does. */
export class ExclusiveControlError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExclusiveControlError";
  }
}

/**
 * Thrown when the lock-owning session failed while a statement was in flight.
 * The statement may or may not have taken effect, and the lock is gone with
 * the session. Nothing may be assumed and nothing may be cleaned up.
 */
export class UncertainOutcomeError extends ExclusiveControlError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UncertainOutcomeError";
  }
}

/**
 * Provisions one disposable database, tracking what this invocation created.
 *
 * Exclusive control comes first and goes last. It is acquired before the
 * cluster is even inspected, so two invocations can never both see a pristine
 * cluster; it is confirmed with the database before every step that changes
 * anything and before every drop; and it is released only after cleanup. If it
 * cannot be acquired nothing is done. If it is found lost, the harness stops:
 * setup is abandoned and cleanup drops NOTHING, because another invocation may
 * by then own roles of the same names.
 *
 * A resource is recorded only after the step that creates it has returned, so
 * the cleanup list never contains anything that existed beforehand or whose
 * creation is unconfirmed. If any step fails, everything recorded so far is
 * removed and the ORIGINAL error is rethrown; cleanup errors never replace it.
 * Cleanup attempts every step even if an earlier cleanup step failed.
 */
export async function provisionDisposableDatabase(driver: ProvisionDriver, plan: ProvisionPlan): Promise<ProvisionedResources> {
  if (!DATABASE_NAME.test(plan.database)) throw new Error("Refusing an unexpected disposable database name");
  if (!OPERATOR_LOGIN_NAME.test(plan.operatorLogin)) throw new Error("Refusing an unexpected operator login name");

  let controlAcquired = false;
  // Set when a statement's outcome is unknown. From then on nothing is dropped, whatever a control check says.
  let contaminated = false;
  let createdDatabase: string | null = null;
  const createdRoles: string[] = [];
  let cleaned = false;

  /** True only when the database confirms control right now. An error while asking counts as lost. */
  const confirmControl = async (): Promise<boolean> => {
    if (!controlAcquired || contaminated) return false;
    try {
      return (await driver.holdsExclusiveControl()) === true;
    } catch {
      return false;
    }
  };
  const requireControl = async (before: string): Promise<void> => {
    if (!(await confirmControl())) {
      throw new ExclusiveControlError(`Exclusive control of the test cluster was lost before ${before}; stopping`);
    }
  };

  async function cleanup(): Promise<unknown[]> {
    if (cleaned) return [];
    cleaned = true;
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<void>) => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    };
    // Closing this run's own connections destroys nothing and is always safe.
    await attempt(() => driver.closeConnections());

    // Only what this invocation created, nothing identified by name alone, and
    // each drop only while the database confirms this invocation is in control.
    let controlLost = false;
    const drop = async (what: string, step: () => Promise<void>) => {
      if (controlLost) return;
      if (!(await confirmControl())) {
        controlLost = true;
        failures.push(
          new ExclusiveControlError(
            `Exclusive control of the test cluster was lost before dropping ${what}; nothing further was dropped. Treat the cluster as contaminated: delete and re-create it`,
          ),
        );
        return;
      }
      try {
        await step();
      } catch (error) {
        failures.push(error);
        // A drop whose outcome is unknown ends cleanup: no further statement is attempted.
        if (error instanceof UncertainOutcomeError) {
          contaminated = true;
          controlLost = true;
        }
      }
    };
    if (createdDatabase !== null) {
      const name = createdDatabase;
      await drop(`database ${name}`, () => driver.dropDatabase(name));
    }
    for (const role of [...createdRoles].reverse()) await drop(`role ${role}`, () => driver.dropRole(role));

    // Last of all, and only if it was ever taken.
    if (controlAcquired) await attempt(() => driver.releaseExclusiveControl());
    return failures;
  }

  const requireOk = (verdict: Assessment, what: string) => {
    if (!verdict.ok) throw new Error(`${what}: ${verdict.reasons.join("; ")}`);
  };

  try {
    // Before anything else, including looking at the cluster.
    if (!(await driver.acquireExclusiveControl())) {
      throw new ExclusiveControlError("Another harness invocation holds exclusive control of this test cluster; refusing to run beside it");
    }
    controlAcquired = true;

    // Nothing has been created yet: a refusal here drops nothing.
    requireOk(assessDisposableCluster(await driver.readClusterFacts()), "Refusing to use this PostgreSQL server");

    await requireControl("creating the database");
    await driver.createDatabase(plan.database);
    createdDatabase = plan.database;

    await requireControl("running the bootstrap");
    await driver.runBootstrap(plan.database);
    // The cluster held none of these roles a moment ago and the bootstrap succeeded: they are this run's.
    createdRoles.push(...SHOPACCESS_ROLES);
    requireOk(
      assessProvisionedRoles(await driver.readClusterFacts(), { operatorLogin: null, webLoginEnabled: false }),
      "Roles are not in their least-privilege state after bootstrap",
    );

    if (plan.applyMigrations) {
      await requireControl("applying migrations");
      await driver.applyMigrations(plan.database);
    }

    // Logins come last, and only for roles whose state was verified above.
    await requireControl("enabling the web login");
    await driver.enableWebLogin(plan.database);
    await requireControl("creating the operator login");
    await driver.createOperatorLogin(plan.operatorLogin);
    createdRoles.push(plan.operatorLogin);
    await requireControl("granting the operator login");
    await driver.grantOperatorLogin(plan.database, plan.operatorLogin);
    requireOk(
      assessProvisionedRoles(await driver.readClusterFacts(), { operatorLogin: plan.operatorLogin, webLoginEnabled: true }),
      "Roles are not in their least-privilege state after login creation",
    );
    await requireControl("handing the database to the tests");
  } catch (error) {
    // The step may or may not have taken effect: no speculative cleanup follows.
    if (error instanceof UncertainOutcomeError) contaminated = true;
    const failures = await cleanup();
    if (failures.length > 0 && typeof error === "object" && error !== null) {
      Object.defineProperty(error, CLEANUP_FAILURES, { value: failures, enumerable: false });
    }
    throw error;
  }

  return { database: plan.database, operatorLogin: plan.operatorLogin, holdsExclusiveControl: confirmControl, cleanup };
}

// ---------------------------------------------------------------------------
// The real driver and the public entry point
// ---------------------------------------------------------------------------

/**
 * The admin URL, or undefined when the variable is NOT SET AT ALL. Only then
 * may a test file skip (and say so). A variable that is set, even to an empty
 * or blank string, is a request to run: it is validated here, and an empty,
 * malformed or otherwise refused configuration throws, so the file fails
 * instead of being reported as skipped.
 */
export function adminUrl(): string | undefined {
  const raw = process.env[ADMIN_URL_VARIABLE];
  if (raw === undefined) return undefined;
  const parsed = parseAdminTarget(process.env);
  if (!parsed.ok) throw new AdminTargetRefusedError(parsed.code);
  return raw;
}

function randomIdentifierSuffix(): string {
  return randomBytes(8).toString("hex");
}

/** Identifiers below cannot be bound as parameters, so each is checked against a fixed pattern first. */
function identifier(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error("Refusing an unsafe SQL identifier");
  return name;
}

function hexSecret(value: string): string {
  if (!/^[0-9a-f]{48}$/.test(value)) throw new Error("Refusing an unexpected generated credential");
  return value;
}

/**
 * The advisory-lock key of harness control, as two 32-bit integers. Fixed, so
 * every invocation on a cluster contends for the same lock. Advisory locks are
 * scoped to one database; `CONTROL_DATABASE` is the one every invocation uses.
 */
const CONTROL_LOCK_KEYS: readonly [number, number] = [1936224353, 1751217011];
const CONTROL_DATABASE = "postgres";

/** What the control session needs from a database client. A `pg` Client satisfies it. */
export interface ControlClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows of catalog queries, as `pg` types them
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
}

/** SQLSTATE classes after which the session itself is gone or going: connection exception, operator intervention. */
const SESSION_LOST_SQLSTATE = /^(?:08|57P)/;

/**
 * True only when the SERVER reported the error for the statement and the
 * session survived: a five-character SQLSTATE outside the session-lost
 * classes. Then the statement definitely did not take effect. Anything else
 * (no SQLSTATE, a socket error, a termination) leaves the outcome unknown.
 */
function isDefiniteStatementError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !SESSION_LOST_SQLSTATE.test(code);
}

const SINGLE_CLUSTER_STATEMENT = /^(?:CREATE DATABASE|DROP DATABASE|CREATE ROLE|ALTER ROLE|DROP ROLE|GRANT) [^;]+$/;

/**
 * The one session that holds the cluster-wide advisory lock, and the only
 * path by which the harness changes anything at cluster level.
 *
 * Because the lock and the statements share a session, holding the lock and
 * being able to send a statement are the same fact: there is no moment at
 * which a statement can be sent by a party that has lost the lock.
 *
 *  - `run` accepts exactly one cluster-level statement and sends it by itself,
 *    never inside a transaction (this session never opens one), which is what
 *    CREATE DATABASE and DROP DATABASE require.
 *  - Once the session is known or suspected to be lost, `run` sends nothing.
 *  - If the session fails while a statement is in flight, the outcome is
 *    unknown: `run` throws UncertainOutcomeError and the session is finished.
 *    A definite SQL error from a surviving session is rethrown unchanged.
 */
export class ControlSession {
  readonly #client: ControlClient;
  #broken = false;
  #ended = false;

  constructor(client: ControlClient) {
    this.#client = client;
  }

  /** Called when the connection reports an error at any time. The lock is gone with the session. */
  markBroken(): void {
    this.#broken = true;
  }

  get usable(): boolean {
    return !this.#broken && !this.#ended;
  }

  /** Tries to take the control lock, without waiting. */
  async tryLock(): Promise<boolean> {
    const where = await this.read("SELECT pg_catalog.current_database()::text AS name");
    // The lock is only cluster-wide if every invocation takes it in the same database.
    if (where[0]?.name !== CONTROL_DATABASE) throw new Error(`The admin URL must name the ${CONTROL_DATABASE} database`);
    const taken = await this.read("SELECT pg_catalog.pg_try_advisory_lock($1::integer, $2::integer) AS taken", [...CONTROL_LOCK_KEYS]);
    return taken[0]?.taken === true;
  }

  /** Asks the server, on this very session, whether it holds the control lock. Never throws: any doubt is `false`. */
  async holdsLock(): Promise<boolean> {
    if (!this.usable) return false;
    try {
      const held = await this.read(
        `SELECT pg_catalog.count(*) = 1 AS held
           FROM pg_catalog.pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ExclusiveLock'
            AND l.pid = pg_catalog.pg_backend_pid()
            AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
            AND l.classid = $1::integer::oid AND l.objid = $2::integer::oid AND l.objsubid = 2`,
        [...CONTROL_LOCK_KEYS],
      );
      return held[0]?.held === true && this.usable;
    } catch {
      return false;
    }
  }

  /** A read-only catalog query on this session. A failed session is recorded as broken. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows of catalog queries, as `pg` types them
  async read(text: string, values?: unknown[]): Promise<any[]> {
    if (!this.usable) throw new ExclusiveControlError("The lock-owning session is no longer usable");
    try {
      return (await this.#client.query(text, values)).rows;
    } catch (error) {
      if (!isDefiniteStatementError(error)) this.#broken = true;
      throw error;
    }
  }

  /** Sends one cluster-level statement on the lock-owning session. See the class comment. */
  async run(statement: string): Promise<void> {
    if (!SINGLE_CLUSTER_STATEMENT.test(statement)) {
      throw new Error("Refusing anything but a single cluster-level statement on the lock-owning session");
    }
    if (!this.usable) {
      throw new ExclusiveControlError("The lock-owning session is no longer usable; the statement was not sent");
    }
    try {
      await this.#client.query(statement);
    } catch (error) {
      if (isDefiniteStatementError(error) && !this.#broken) throw error;
      this.#broken = true;
      throw new UncertainOutcomeError(
        "The lock-owning session failed while a cluster-level statement was in flight. Its outcome is unknown. Treat the cluster as contaminated: delete and re-create it",
        { cause: error },
      );
    }
  }

  /** Ends the session, which releases the lock on the server whatever state the session is in. */
  async end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    await this.#client.end();
  }
}

async function readClusterFacts(session: ControlSession, target: AdminTarget): Promise<ClusterFacts> {
  const one = async <T>(text: string): Promise<T> => (await session.read(text))[0] as T;
  const name = await one<{ cluster_name: string }>("SHOW cluster_name");
  const version = await one<{ server_version_num: string }>("SHOW server_version_num");
  const who = await one<{ session_user: string }>("SELECT session_user::text AS session_user");
  const databases = (await session.read("SELECT datname FROM pg_catalog.pg_database")).map((row) => String(row.datname));
  const roles = (
    await session.read(
      "SELECT rolname, oid = 10 AS is_bootstrap, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin FROM pg_catalog.pg_roles",
    )
  ).map(
    (row): RoleFacts => ({
      name: String(row.rolname),
      isBootstrapSuperuser: row.is_bootstrap === true,
      superuser: row.rolsuper === true,
      createRole: row.rolcreaterole === true,
      createDb: row.rolcreatedb === true,
      replication: row.rolreplication === true,
      bypassRls: row.rolbypassrls === true,
      canLogin: row.rolcanlogin === true,
    }),
  );
  const memberships = (
    await session.read(
      `SELECT m.rolname AS member, g.rolname AS granted, a.admin_option, a.inherit_option, a.set_option
         FROM pg_catalog.pg_auth_members a
         JOIN pg_catalog.pg_roles m ON m.oid = a.member
         JOIN pg_catalog.pg_roles g ON g.oid = a.roleid`,
    )
  ).map(
    (row): MembershipFacts => ({
      member: String(row.member),
      role: String(row.granted),
      admin: row.admin_option === true,
      inherit: row.inherit_option === true,
      set: row.set_option === true,
    }),
  );
  return {
    host: target.host,
    adminDatabase: target.database,
    clusterName: name.cluster_name,
    serverVersionNum: Number(version.server_version_num),
    sessionUser: who.session_user,
    databases,
    roles,
    memberships,
  };
}

export interface DisposableDatabase {
  readonly name: string;
  /** Superuser connection inside the disposable database. This is the "test owner". It does not exist at runtime. */
  readonly admin: Client;
  /**
   * A second connection of the same test owner to the same disposable database: same verified target, same
   * credentials, no startup options. It exists so that a test can hold a transaction open on `admin` and act as the
   * test owner on an independent connection at the same time. It is opened once, after provisioning, and is closed
   * with every other connection of this database: any transaction left open on it is rolled back first.
   */
  readonly secondAdmin: Client;
  /** Pool logged in as `shopaccess_web`, with the approved timeouts. */
  readonly web: Pool;
  /**
   * Verified connection fields of `shopaccess_web`, for tests that start separate processes
   * (see `admissionChildEnvironment`). Discrete fields, never a URL. Never log it.
   */
  readonly webConnection: DriverConfig;
  /** Pool logged in as a named operator login that is a member of `shopaccess_operator`. */
  readonly operator: Pool;
  readonly operatorLogin: string;
  /** Opens one more client as `shopaccess_web`. The caller ends it; a forgotten one is ended when the database is dropped. */
  connectWeb(): Promise<Client>;
  /** Asks the database whether this run still holds exclusive control of the cluster. */
  holdsExclusiveControl(): Promise<boolean>;
  /** Applies the approved migrations again, as the migration role, from the given directory. */
  migrate(directory: string): ReturnType<typeof applyMigrations>;
  /** Removes everything this run created and closes every connection. Throws if anything could not be removed. */
  destroy(): Promise<void>;
}

/**
 * Creates a fresh database in a pristine, positively verified disposable
 * cluster, runs the bootstrap file as the administrator, verifies the roles,
 * applies migrations 0001 to 0006 as the migration role, and only then enables
 * test logins. Throws, having removed whatever it created, if any step fails.
 */
export async function openDisposableDatabase(options: { applyMigrations?: boolean } = {}): Promise<DisposableDatabase> {
  // Before anything is constructed: the target is validated from the environment, and a refusal ends here.
  const parsed = parseAdminTarget(process.env);
  if (!parsed.ok) {
    if (parsed.code === "ADMIN_URL_NOT_SET") throw new Error(`${ADMIN_URL_VARIABLE} is not set`);
    throw new AdminTargetRefusedError(parsed.code);
  }
  const target = parsed.target;

  // Hex only: safe to place in statements that cannot take parameters.
  const webPassword = randomBytes(24).toString("hex");
  const operatorPassword = randomBytes(24).toString("hex");
  const plan: ProvisionPlan = {
    database: `${DISPOSABLE_DATABASE_PREFIX}${randomIdentifierSuffix()}`,
    operatorLogin: `${TEST_LOGIN_ROLE_PREFIX}operator_${randomIdentifierSuffix()}`,
    applyMigrations: options.applyMigrations !== false,
  };

  // The administrator connection INSIDE the test database: bootstrap file and test fixtures only.
  let admin: Client | null = null;
  // The second test-owner connection inside the test database. Opened after provisioning; closed with the others.
  let secondAdmin: Client | null = null;
  const pools: Pool[] = [];
  // The session that holds the control lock. Every cluster-level statement goes through it.
  let control: ControlSession | null = null;

  /** The lock-owning session, or a refusal. There is no other route to a cluster-level statement. */
  const lockSession = (): ControlSession => {
    if (!control) throw new ExclusiveControlError("Exclusive control has not been acquired; no cluster-level statement is sent");
    return control;
  };
  const requireAdmin = (): Client => {
    if (!admin) throw new Error("The disposable database has no administrator connection yet");
    return admin;
  };
  /** Runs the approved migrations on a one-connection pool whose connections act as the migration role. */
  const migrate = async (directory: string) => {
    const pool = verifiedPool(
      connectionConfig(target, { database: plan.database, user: target.user, password: target.password, options: "-c role=shopaccess_owner" }),
      1,
    );
    try {
      return await applyMigrations(connectionSourceFromPool(pool), directory);
    } finally {
      await pool.end();
    }
  };

  const driver: ProvisionDriver = {
    async acquireExclusiveControl() {
      // The only connection this harness ever opens to the maintenance database.
      // Its effective configuration is verified on this very object before it connects.
      const client = verifiedClient(connectionConfig(target, { database: CONTROL_DATABASE, user: target.user, password: target.password }));
      const session = new ControlSession(client);
      // A dropped connection has dropped the lock with it. Record that instead of crashing on an unhandled event.
      client.on("error", () => session.markBroken());
      await client.connect();
      try {
        if (!(await session.tryLock())) {
          await session.end();
          return false;
        }
      } catch (error) {
        await session.end().catch(() => undefined);
        throw error;
      }
      control = session;
      return true;
    },
    holdsExclusiveControl: async () => (control ? control.holdsLock() : false),
    async releaseExclusiveControl() {
      const session = control;
      control = null;
      if (session) await session.end();
    },
    readClusterFacts: () => readClusterFacts(lockSession(), target),

    // Cluster-level statements: all on the lock-owning session, one at a time, never in a transaction.
    createDatabase: (name) => lockSession().run(`CREATE DATABASE ${identifier(name)}`),
    // Reached only after this run created shopaccess_web and verified its attributes and memberships.
    enableWebLogin: () => lockSession().run(`ALTER ROLE shopaccess_web LOGIN PASSWORD '${hexSecret(webPassword)}'`),
    createOperatorLogin: (login) =>
      lockSession().run(
        `CREATE ROLE ${identifier(login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD '${hexSecret(operatorPassword)}'`,
      ),
    async grantOperatorLogin(database, login) {
      await lockSession().run(`GRANT shopaccess_operator TO ${identifier(login)} WITH INHERIT TRUE, SET FALSE`);
      await lockSession().run(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(login)}`);
    },
    // FORCE ends any connection a failed test left open. Neither statement uses IF EXISTS:
    // the harness drops only what it created, and a missing resource is reported.
    dropDatabase: (name) => lockSession().run(`DROP DATABASE ${identifier(name)} WITH (FORCE)`),
    dropRole: (name) => lockSession().run(`DROP ROLE ${identifier(name)}`),

    // Database-specific work: these must run inside the test database, so they cannot use the lock-owning session.
    async runBootstrap(database) {
      const client = verifiedClient(connectionConfig(target, { database, user: target.user, password: target.password }));
      await client.connect();
      admin = client;
      // One message. The file is a single explicit transaction.
      await client.query(readFileSync(BOOTSTRAP_FILE, "utf8"));
    },
    async applyMigrations() {
      const applied = await migrate(MIGRATIONS_DIR);
      if (!applied.ok) throw new Error(`Migrations refused: ${JSON.stringify(applied.error)}`);
    },
    async closeConnections() {
      const closing: Array<Promise<unknown>> = pools.map((pool) => pool.end());
      if (admin) closing.push(admin.end());
      if (secondAdmin) {
        // A test may have failed with a transaction open on it. Roll that back, whatever state it is in, and then
        // end the connection; a connection that can no longer answer is ended all the same.
        const second = secondAdmin;
        closing.push(
          second
            .query("ROLLBACK")
            .catch(() => undefined)
            .then(() => second.end()),
        );
      }
      pools.length = 0;
      admin = null;
      secondAdmin = null;
      const failed = (await Promise.allSettled(closing)).find((result) => result.status === "rejected");
      if (failed && failed.status === "rejected") throw failed.reason;
    },
  };

  const provisioned = await provisionDisposableDatabase(driver, plan);

  let webConnection: DriverConfig;
  let web: Pool;
  let operator: Pool;
  let second: Client;
  try {
    webConnection = connectionConfig(target, {
      database: plan.database,
      user: "shopaccess_web",
      password: webPassword,
      options: connectionStartupOptions(),
    });
    web = verifiedPool(webConnection, 12);
    pools.push(web);
    operator = verifiedPool(
      connectionConfig(target, { database: plan.database, user: plan.operatorLogin, password: operatorPassword, options: connectionStartupOptions() }),
      2,
    );
    pools.push(operator);
    // The second test-owner connection: the validated target and the administrator's credentials again, in the test
    // database, verified on the client object before it connects. Registered for cleanup only once it is connected;
    // if connecting fails, it is ended here and the failure takes the path below, which removes everything.
    second = verifiedClient(connectionConfig(target, { database: plan.database, user: target.user, password: target.password }));
    try {
      await second.connect();
    } catch (connectError) {
      await second.end().catch(() => undefined);
      throw connectError;
    }
    secondAdmin = second;
  } catch (error) {
    // The database and roles exist by now. A refused configuration must not leave them behind.
    const failures = await provisioned.cleanup();
    if (failures.length > 0 && typeof error === "object" && error !== null) {
      Object.defineProperty(error, CLEANUP_FAILURES, { value: failures, enumerable: false });
    }
    throw error;
  }

  return {
    name: plan.database,
    admin: requireAdmin(),
    secondAdmin: second,
    web,
    webConnection,
    operator,
    operatorLogin: plan.operatorLogin,
    async connectWeb() {
      const client = verifiedClient(webConnection);
      await client.connect();
      return client;
    },
    holdsExclusiveControl: provisioned.holdsExclusiveControl,
    migrate,
    async destroy() {
      const failures = await provisioned.cleanup();
      if (failures.length > 0) {
        throw new AggregateError(failures, "Cleanup of the disposable database was incomplete; delete and re-create the test cluster");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures and barriers
// ---------------------------------------------------------------------------

export const TEST_KEY_V1 = Buffer.alloc(32, 0x11);
export const TEST_KEY_V2 = Buffer.alloc(32, 0x22);
export const TEST_KEY_V3 = Buffer.alloc(32, 0x33);
/** Fixed nonce-purpose key for tests. Distinct from every session test key. */
export const TEST_NONCE_KEY = Buffer.alloc(32, 0x99);

/** Validated rings for a session service under test: the given session keys and the fixed nonce key. */
export function testKeyRings(sessionKeys: ReadonlyArray<readonly [number, Buffer]>): ConfiguredKeyRings {
  const rings = validateKeyRings(new KeyRing("session", new Map(sessionKeys)), new KeyRing("confirmation_nonce", new Map([[1, TEST_NONCE_KEY]])));
  if (!rings.ok) throw new Error(`Test key rings refused: ${rings.error.code}`);
  return rings.value;
}

export function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Reopens the admission window with a full budget. Test owner only. */
export async function resetAdmissionWindow(admin: Client): Promise<void> {
  await admin.query(
    "UPDATE shopaccess.session_admission_guard SET window_started_at = clock_timestamp() - interval '2 minutes', window_admissions = 0, updated_at = clock_timestamp() WHERE id = 1",
  );
}

export interface BackdatedSession {
  readonly id: string;
  readonly tokenDigest: string;
}

/**
 * Inserts an already-backdated session directly, as the test owner. Existing
 * rows are never rewritten to change their age: `created_at` is immutable and
 * the update trigger allows only its three shapes.
 * `createdAgo` and `lastSeenAgo` are PostgreSQL interval texts such as "3 hours".
 */
export async function insertBackdatedSession(
  admin: Client,
  keyVersion: number,
  createdAgo: string,
  lastSeenAgo: string,
): Promise<BackdatedSession> {
  const id = `ses_${hex(16)}`;
  const ownerId = `own_${hex(16)}`;
  const tokenDigest = hex(32);
  await admin.query(
    "INSERT INTO shopaccess.checkout_owners (id, created_at) VALUES ($1, clock_timestamp() - $2::interval)",
    [ownerId, createdAgo],
  );
  await admin.query(
    `INSERT INTO shopaccess.shopper_sessions
       (id, owner_id, key_version, token_digest, created_at, last_seen_at, absolute_expires_at)
     SELECT $1, $2, $3, $4, t.now - $5::interval, t.now - $6::interval, t.now - $5::interval + interval '24 hours'
       FROM (SELECT clock_timestamp() AS now) t`,
    [id, ownerId, keyVersion, tokenDigest, createdAgo, lastSeenAgo],
  );
  return { id, tokenDigest };
}

export async function backendPid(client: Client): Promise<number> {
  return Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
}

/**
 * Waits, by polling the server and without sleeping blindly, until the given
 * backend is blocked on a lock. Used to force an interleaving deterministically.
 */
export async function waitUntilBlocked(admin: Client, pid: number, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { rows } = await admin.query(
      "SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
      [pid],
    );
    if (rows.length === 1) return;
    await admin.query("SELECT pg_sleep(0.005)");
  }
  throw new Error(`Backend ${pid} never blocked on a lock`);
}

/** Polls the database clock until it has passed the given instant. */
export async function waitForDatabaseClock(admin: Client, instant: Date): Promise<void> {
  for (;;) {
    const { rows } = await admin.query("SELECT clock_timestamp() >= $1::timestamptz AS passed", [instant.toISOString()]);
    if (rows[0].passed === true) return;
    await admin.query("SELECT pg_sleep(0.01)");
  }
}

/** Expects a statement to fail with the given SQLSTATE. */
export async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
  }
}

export const INSUFFICIENT_PRIVILEGE = "42501";
export const RESTRICT_VIOLATION = "23001";
export const LOCK_NOT_AVAILABLE = "55P03";
