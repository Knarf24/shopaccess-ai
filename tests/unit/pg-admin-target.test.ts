import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Database-free, and unable to be anything else: in this file the `pg` module
// IS the recording stub below. `vi.mock` is hoisted above every import, and the
// harness is never imported statically: each test loads it with a dynamic
// import after the module registry was reset, so the harness under test can
// only ever have been given the stub. Nothing here can open a socket.
//
// Three separate claims are tested, each with its own assertion:
//   A. a grammar, port or environment refusal constructs NO client and NO pool;
//   B. a driver-configuration mismatch is refused with NO connect() call;
//   C. no part of a refused URL appears in any error or in any output.

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => {
  const role = (rolname: string, overrides: Row = {}): Row => ({
    rolname,
    is_bootstrap: false,
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolbypassrls: false,
    rolcanlogin: false,
    ...overrides,
  });
  const SHOPACCESS = ["shopaccess_owner", "shopaccess_definer", "shopaccess_web", "shopaccess_worker", "shopaccess_operator"];

  const state = {
    clients: [] as StubClient[],
    pools: [] as StubPool[],
    /** Makes the client constructed at this position report something other than it was given. */
    mismatch: null as { at: number; change: Row } | null,
    /** Makes connect() fail on the client constructed at this position. */
    failConnectAt: null as number | null,
    databases: [] as string[],
    roles: [] as Row[],
    memberships: [] as Row[],
    ledger: [] as Row[],
    /** The first two words of every statement the fake server was sent. Never more: some statements carry a password. */
    statements: [] as string[],
  };

  function reset(): void {
    state.clients = [];
    state.pools = [];
    state.mismatch = null;
    state.failConnectAt = null;
    state.databases = ["postgres", "template0", "template1"];
    state.roles = [
      role("postgres", { is_bootstrap: true, rolsuper: true, rolcreaterole: true, rolcreatedb: true, rolreplication: true, rolbypassrls: true, rolcanlogin: true }),
      role("pg_monitor"),
      role("pg_read_all_stats"),
    ];
    state.memberships = [{ member: "pg_monitor", granted: "pg_read_all_stats", admin_option: false, inherit_option: true, set_option: true }];
    state.ledger = [];
    state.statements = [];
  }

  /** A pristine PostgreSQL 17 cluster with the disposable marker, as far as the harness asks. Holds no data and runs no SQL. */
  function answer(text: string, values?: readonly unknown[]): { rows: Row[] } {
    state.statements.push(text.trim().split(/\s+/).slice(0, 2).join(" "));
    const rows = (list: Row[]) => ({ rows: list });
    let match: RegExpExecArray | null;
    // Checked first: the bootstrap file is long and mentions catalogs that the harness's own short queries also name.
    if (text.includes("CREATE ROLE shopaccess_owner NOLOGIN")) {
      // The bootstrap file. Its text is not interpreted: only its effect on the role list is imitated.
      for (const name of SHOPACCESS) state.roles.push(role(name));
      state.memberships.push({ member: "shopaccess_owner", granted: "shopaccess_definer", admin_option: false, inherit_option: false, set_option: true });
      return rows([]);
    }
    if (text.includes("current_database()::text AS name")) return rows([{ name: "postgres" }]);
    if (text.includes("pg_try_advisory_lock")) return rows([{ taken: true }]);
    if (text.includes("pg_catalog.pg_locks")) return rows([{ held: true }]);
    if (text === "SHOW cluster_name") return rows([{ cluster_name: "shopaccess-disposable-test" }]);
    if (text === "SHOW server_version_num") return rows([{ server_version_num: "170011" }]);
    if (text.includes("session_user::text")) return rows([{ session_user: "postgres" }]);
    if (text.includes("pg_catalog.pg_auth_members")) return rows(state.memberships.map((row) => ({ ...row })));
    if (text.startsWith("SELECT datname")) return rows(state.databases.map((datname) => ({ datname })));
    if (text.startsWith("SELECT rolname")) return rows(state.roles.map((row) => ({ ...row })));
    if ((match = /^CREATE DATABASE (\w+)$/.exec(text))) {
      state.databases.push(match[1]);
      return rows([]);
    }
    if (/^ALTER ROLE shopaccess_web LOGIN /.test(text)) {
      for (const row of state.roles) if (row.rolname === "shopaccess_web") row.rolcanlogin = true;
      return rows([]);
    }
    if ((match = /^CREATE ROLE (\w+) LOGIN /.exec(text))) {
      state.roles.push(role(match[1], { rolcanlogin: true }));
      return rows([]);
    }
    if ((match = /^GRANT shopaccess_operator TO (\w+) /.exec(text))) {
      state.memberships.push({ member: match[1], granted: "shopaccess_operator", admin_option: false, inherit_option: true, set_option: false });
      return rows([]);
    }
    if ((match = /^DROP DATABASE (\w+) /.exec(text))) {
      const name = match[1];
      state.databases = state.databases.filter((candidate) => candidate !== name);
      return rows([]);
    }
    if ((match = /^DROP ROLE (\w+)$/.exec(text))) {
      const name = match[1];
      state.roles = state.roles.filter((row) => row.rolname !== name);
      state.memberships = state.memberships.filter((row) => row.member !== name && row.granted !== name);
      return rows([]);
    }
    if (text.includes("to_regclass('shopaccess.schema_migrations')")) return rows([{ present: state.ledger.length > 0 }]);
    if (text === "SELECT version, checksum FROM shopaccess.schema_migrations") return rows(state.ledger.map((row) => ({ ...row })));
    if (text.startsWith("INSERT INTO shopaccess.schema_migrations")) {
      state.ledger.push({ version: values?.[0], checksum: values?.[1] });
      return rows([]);
    }
    return rows([]);
  }

  class StubClient {
    readonly config: Row;
    readonly index: number;
    connectCalls = 0;
    endCalls = 0;
    host: unknown;
    port: unknown;
    user: unknown;
    database: unknown;
    ssl: unknown;
    connectionParameters: Row;

    constructor(config: Row) {
      this.config = config;
      this.index = state.clients.length;
      state.clients.push(this);
      // A faithful driver, given discrete fields, uses exactly those fields.
      const effective: Row = {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        options: config.options,
        ssl: config.ssl,
        isDomainSocket: false,
        replication: undefined,
        binary: false,
      };
      if (state.mismatch && state.mismatch.at === this.index) Object.assign(effective, state.mismatch.change);
      this.host = effective.host;
      this.port = effective.port;
      this.user = effective.user;
      this.database = effective.database;
      this.ssl = effective.ssl;
      this.connectionParameters = effective;
    }

    on(): this {
      return this;
    }
    async connect(): Promise<void> {
      this.connectCalls += 1;
      if (state.failConnectAt === this.index) throw new Error("the stub client could not connect");
    }
    async query(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> {
      if (this.connectCalls === 0) throw new Error("the stub client was sent a statement without having been connected");
      return answer(text, values);
    }
    async end(): Promise<void> {
      this.endCalls += 1;
    }
  }

  class StubPool {
    readonly options: Row;
    connectCalls = 0;
    ended = false;

    constructor(options: Row) {
      this.options = options;
      state.pools.push(this);
    }
    async connect(): Promise<{ query: (text: string, values?: readonly unknown[]) => Promise<{ rows: Row[] }>; release: () => void }> {
      this.connectCalls += 1;
      return { query: async (text, values) => answer(text, values), release: () => undefined };
    }
    async query(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> {
      return answer(text, values);
    }
    async end(): Promise<void> {
      this.ended = true;
    }
  }

  return { state, reset, StubClient, StubPool, SHOPACCESS };
});

// Installed before anything imports the harness: see the note at the top of the file.
vi.mock("pg", () => ({
  Client: fake.StubClient,
  Pool: fake.StubPool,
  default: { Client: fake.StubClient, Pool: fake.StubPool },
}));

const ADMIN_URL = "SHOPACCESS_PG_TEST_ADMIN_URL";
const AUTHORIZED_PORT = "SHOPACCESS_PG_TEST_AUTHORIZED_PORT";
/** Built from parts, so that the token itself appears in no file under tests/. */
const CONNECTION_STRING_KEY = ["connection", "String"].join("");

const PORT = "54599";
/** In the user, password and host of every unsafe URL. It must never come back out. */
const MARKER = "zzmarkerzz";
const GOOD = `postgres://postgres:${MARKER}.pw-OK_1~@127.0.0.1:${PORT}/postgres`;
const GOOD_PASSWORD = `${MARKER}.pw-OK_1~`;
const suffixed = (suffix: string) => `postgres://postgres:${MARKER}@127.0.0.1:${PORT}/postgres${suffix}`;
const hosted = (host: string) => `postgres://postgres:${MARKER}@${host}:${PORT}/postgres`;

const savedEnvironment = new Map<string, string | undefined>();
function setEnvironment(overrides: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(overrides)) {
    if (!savedEnvironment.has(name)) savedEnvironment.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Loads a fresh copy of the harness. It is only ever loaded here, after the stub is in place. */
async function loadHarness() {
  vi.resetModules();
  return import("../db/harness");
}

/** Everything written to the console or the standard streams while `work` runs. */
async function capturingOutput<T>(work: () => Promise<T>): Promise<{ value: T; output: string }> {
  const written: string[] = [];
  const record = (...parts: unknown[]) => {
    written.push(parts.map((part) => (typeof part === "string" ? part : inspect(part, { depth: 6 }))).join(" "));
  };
  const spies = [
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "info").mockImplementation(record),
    vi.spyOn(console, "warn").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
    vi.spyOn(console, "debug").mockImplementation(record),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      record(String(chunk));
      return true;
    }),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      record(String(chunk));
      return true;
    }),
  ];
  try {
    return { value: await work(), output: written.join("\n") };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** Every place an error could carry its input: its text, its stack, its cause, its own and hidden properties, its JSON form. */
function surfacesOf(error: unknown): string {
  const parts = [String(error), inspect(error, { depth: 8, showHidden: true, getters: true })];
  if (typeof error === "object" && error !== null) {
    parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error)));
    for (const key of Reflect.ownKeys(error)) parts.push(String(key), inspect((error as Record<PropertyKey, unknown>)[key], { depth: 8, showHidden: true }));
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) parts.push(surfacesOf(cause));
  }
  return parts.join("\n");
}

async function rejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const totalConnects = () => fake.state.clients.reduce((sum, client) => sum + client.connectCalls, 0) + fake.state.pools.reduce((sum, pool) => sum + pool.connectCalls, 0);
const serverIsPristine = () => {
  expect(fake.state.databases).toEqual(["postgres", "template0", "template1"]);
  expect(fake.state.roles.map((row) => row.rolname)).toEqual(["postgres", "pg_monitor", "pg_read_all_stats"]);
  expect(fake.state.memberships).toHaveLength(1);
};

beforeEach(() => {
  fake.reset();
  // A known starting point: neither variable set, whatever the shell that started the tests had.
  setEnvironment({ [ADMIN_URL]: undefined, [AUTHORIZED_PORT]: undefined });
});
afterEach(() => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvironment.clear();
  vi.restoreAllMocks();
});

describe("the stub is the driver, and it was installed before the harness was loaded", () => {
  it("this file never imports the harness statically, and registers the stub above its only dynamic import", () => {
    const self = readFileSync(join(process.cwd(), "tests", "unit", "pg-admin-target.test.ts"), "utf8");
    expect(self).not.toMatch(/^import [^\n]*db\/harness/m);
    expect(self.indexOf('vi.mock("pg"')).toBeGreaterThan(0);
    expect(self.indexOf('vi.mock("pg"')).toBeLessThan(self.indexOf('import("../db/harness")'));
    expect([...self.matchAll(/import\("\.\.\/db\/harness"\)/g)]).toHaveLength(2);
  });

  it("the driver module the harness receives is the stub", async () => {
    const driver = await import("pg");
    expect(driver.Client).toBe(fake.StubClient);
    expect(driver.Pool).toBe(fake.StubPool);
  });

  it("positive control: with a valid target the stub records every construction and every connect, so a count of zero below means something", async () => {
    setEnvironment({ [ADMIN_URL]: GOOD, [AUTHORIZED_PORT]: PORT });
    const harness = await loadHarness();
    const db = await harness.openDisposableDatabase();

    // Control session, bootstrap client, one unconnected probe for each of the three pools, then the second
    // test-owner connection.
    expect(fake.state.clients).toHaveLength(6);
    expect(fake.state.pools).toHaveLength(3);
    expect(fake.state.clients.map((client) => client.connectCalls)).toEqual([1, 1, 0, 0, 0, 1]);
    expect(fake.state.clients.map((client) => client.config.database)).toEqual(["postgres", db.name, db.name, db.name, db.name, db.name]);
    expect(fake.state.clients.map((client) => client.config.user)).toEqual(["postgres", "postgres", "postgres", "shopaccess_web", db.operatorLogin, "postgres"]);
    // The second test-owner connection: the administrator's own credentials and the test database, exactly as the
    // first one (the bootstrap client), with no startup option of its own; and it is what the database object hands out.
    expect(fake.state.clients[5].config).toEqual(fake.state.clients[1].config);
    expect(fake.state.clients[5].config).not.toHaveProperty("options");
    expect(db.secondAdmin).toBe(fake.state.clients[5]);
    expect(db.admin).toBe(fake.state.clients[1]);
    expect(db.secondAdmin).not.toBe(db.admin);
    expect(fake.state.clients[5].endCalls).toBe(0);
    expect(fake.state.pools.map((pool) => [pool.options.user, pool.options.max])).toEqual([
      ["postgres", 1],
      ["shopaccess_web", 12],
      [db.operatorLogin, 2],
    ]);
    // The migration pool was used, and its one startup option is the migration role.
    expect(fake.state.pools[0].connectCalls).toBe(1);
    expect(fake.state.pools[0].options.options).toBe("-c role=shopaccess_owner");
    expect(fake.state.ledger).toHaveLength(9);

    // Every configuration: the validated loopback literal, the authorized port, no TLS, discrete fields, no URL.
    for (const config of [...fake.state.clients.map((client) => client.config), ...fake.state.pools.map((pool) => pool.options)]) {
      expect(config).toMatchObject({ host: "127.0.0.1", port: 54599, ssl: false });
      expect(Object.keys(config).filter((key) => !["host", "port", "user", "password", "database", "ssl", "options", "max"].includes(key))).toEqual([]);
      expect(config).not.toHaveProperty(CONNECTION_STRING_KEY);
    }
    // A pool is given the very fields its probe was verified with.
    for (const [probe, pool] of [
      [2, 0],
      [3, 1],
      [4, 2],
    ]) {
      expect(fake.state.clients[probe].config).toBe(fake.state.pools[pool].options);
    }
    expect(db.webConnection).toEqual({ host: "127.0.0.1", port: 54599, user: "shopaccess_web", password: expect.stringMatching(/^[0-9a-f]{48}$/), database: db.name, ssl: false, options: expect.stringMatching(/^-c lock_timeout=/) });

    const extra = await db.connectWeb();
    expect(fake.state.clients).toHaveLength(7);
    expect(fake.state.clients[6].config).toBe(db.webConnection);
    expect(fake.state.clients[6].connectCalls).toBe(1);
    await extra.end();

    expect(fake.state.statements).not.toContain("ROLLBACK");
    await db.destroy();
    serverIsPristine();
    // Cleanup closes the second test-owner connection with the others: a transaction a test may have left open on
    // it is rolled back first, then the connection is ended, exactly once.
    expect(fake.state.statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(1);
    expect(fake.state.statements.indexOf("ROLLBACK")).toBeLessThan(fake.state.statements.indexOf("DROP DATABASE"));
    expect(fake.state.clients[5].endCalls).toBe(1);
    expect(fake.state.clients[1].endCalls).toBe(1);
    expect(fake.state.pools.map((pool) => pool.ended)).toEqual([true, true, true]);
    expect(fake.state.statements.filter((statement) => statement.startsWith("DROP"))).toEqual(["DROP DATABASE", ...Array.from({ length: 6 }, () => "DROP ROLE")]);
  });
});

const UNSAFE_URLS: ReadonlyArray<readonly [string, string, string]> = [
  ["an empty value", "", "ADMIN_URL_EMPTY"],
  ["a blank value", "   ", "ADMIN_URL_EMPTY"],
  ["a host parameter naming a remote host", suffixed("?host=db.example.com"), "ADMIN_URL_MALFORMED"],
  ["a host parameter naming another address", suffixed("?host=10.0.0.5"), "ADMIN_URL_MALFORMED"],
  ["a hostaddr parameter", suffixed("?hostaddr=10.0.0.5"), "ADMIN_URL_MALFORMED"],
  ["a host parameter naming a socket directory", suffixed("?host=/tmp"), "ADMIN_URL_MALFORMED"],
  ["a percent-encoded socket directory as host", hosted("%2Ftmp"), "ADMIN_URL_MALFORMED"],
  ["the socket scheme", `socket:/tmp/${MARKER}?db=postgres`, "ADMIN_URL_MALFORMED"],
  ["a bare socket path", `/tmp/${MARKER} postgres`, "ADMIN_URL_MALFORMED"],
  ["a port parameter", suffixed("?port=5432"), "ADMIN_URL_MALFORMED"],
  ["a user parameter", suffixed("?user=other"), "ADMIN_URL_MALFORMED"],
  ["a password parameter", suffixed("?password=other"), "ADMIN_URL_MALFORMED"],
  ["an options parameter", suffixed("?options=-c%20role%3Dpostgres"), "ADMIN_URL_MALFORMED"],
  ["an sslmode parameter", suffixed("?sslmode=require"), "ADMIN_URL_MALFORMED"],
  ["an sslrootcert parameter", suffixed("?sslrootcert=/etc/hosts"), "ADMIN_URL_MALFORMED"],
  ["a harmless-looking parameter", suffixed("?application_name=x"), "ADMIN_URL_MALFORMED"],
  ["an empty query", suffixed("?"), "ADMIN_URL_MALFORMED"],
  ["a fragment", suffixed("#x"), "ADMIN_URL_MALFORMED"],
  ["a remote name", hosted(`${MARKER}.example.com`), "ADMIN_URL_MALFORMED"],
  ["the name localhost", hosted("localhost"), "ADMIN_URL_MALFORMED"],
  ["a short spelling of the IPv4 loopback", hosted("127.1"), "ADMIN_URL_MALFORMED"],
  ["a remote name that starts with the loopback address", hosted("127.0.0.1.example.com"), "ADMIN_URL_MALFORMED"],
  ["the expanded IPv6 loopback", hosted("[0:0:0:0:0:0:0:1]"), "ADMIN_URL_MALFORMED"],
  ["the IPv4-mapped IPv6 loopback", hosted("[::ffff:127.0.0.1]"), "ADMIN_URL_MALFORMED"],
  ["an IPv6 loopback without brackets", hosted("::1"), "ADMIN_URL_MALFORMED"],
  ["no host", `postgres://postgres:${MARKER}@:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["no port", `postgres://postgres:${MARKER}@127.0.0.1/postgres`, "ADMIN_URL_MALFORMED"],
  ["no user", `postgres://:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["no password", `postgres://${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["no database", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}/`, "ADMIN_URL_MALFORMED"],
  ["another database", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}/template1`, "ADMIN_URL_MALFORMED"],
  ["an http URL", `http://postgres:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a second @ before the host", `postgres://postgres:${MARKER}@evil.example@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a second @ after the host", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}@evil.example/postgres`, "ADMIN_URL_MALFORMED"],
  ["a percent-encoded character", `postgres://postgres:${MARKER}%41@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a trailing newline", `${GOOD}\n`, "ADMIN_URL_MALFORMED"],
  ["a trailing carriage return", `${GOOD}\r`, "ADMIN_URL_MALFORMED"],
  ["a trailing CRLF", `${GOOD}\r\n`, "ADMIN_URL_MALFORMED"],
  ["a leading newline", `\n${GOOD}`, "ADMIN_URL_MALFORMED"],
  ["a newline inside", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}\n/postgres`, "ADMIN_URL_MALFORMED"],
  ["a second, valid URL on a following line", `${GOOD}\n${GOOD}`, "ADMIN_URL_MALFORMED"],
  ["a trailing Unicode line separator", `${GOOD}\u2028`, "ADMIN_URL_MALFORMED"],
  ["a trailing Unicode paragraph separator", `${GOOD}\u2029`, "ADMIN_URL_MALFORMED"],
  ["a trailing next-line character", `${GOOD}\u0085`, "ADMIN_URL_MALFORMED"],
  ["a trailing no-break space", `${GOOD}\u00a0`, "ADMIN_URL_MALFORMED"],
  ["a leading space", ` ${GOOD}`, "ADMIN_URL_MALFORMED"],
  ["a backslash", `postgres:\\\\postgres:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["text that no URL parser accepts", `${MARKER} is not a URL`, "ADMIN_URL_MALFORMED"],
  ["a port with a leading zero", `postgres://postgres:${MARKER}@127.0.0.1:0${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["the default PostgreSQL port", `postgres://postgres:${MARKER}@127.0.0.1:5432/postgres`, "AUTHORIZED_PORT_MISMATCH"],
  ["a port other than the authorized one", `postgres://postgres:${MARKER}@127.0.0.1:54600/postgres`, "AUTHORIZED_PORT_MISMATCH"],
];

const UNSAFE_PORTS: ReadonlyArray<readonly [string, string | undefined, string]> = [
  ["missing", undefined, "AUTHORIZED_PORT_MISSING"],
  ["empty", "", "AUTHORIZED_PORT_INVALID"],
  ["not a number", "port", "AUTHORIZED_PORT_INVALID"],
  ["the default PostgreSQL port", "5432", "AUTHORIZED_PORT_INVALID"],
  ["privileged", "80", "AUTHORIZED_PORT_INVALID"],
  ["above the range", "65536", "AUTHORIZED_PORT_INVALID"],
  ["written with a leading zero", `0${PORT}`, "AUTHORIZED_PORT_INVALID"],
  ["written with a space", `${PORT} `, "AUTHORIZED_PORT_INVALID"],
  ["written with a trailing newline", `${PORT}\n`, "AUTHORIZED_PORT_INVALID"],
  ["written with a trailing carriage return", `${PORT}\r`, "AUTHORIZED_PORT_INVALID"],
  ["written with a trailing CRLF", `${PORT}\r\n`, "AUTHORIZED_PORT_INVALID"],
  ["written with a leading newline", `\n${PORT}`, "AUTHORIZED_PORT_INVALID"],
  ["written with a trailing Unicode line separator", `${PORT}\u2028`, "AUTHORIZED_PORT_INVALID"],
  ["written with a trailing Unicode paragraph separator", `${PORT}\u2029`, "AUTHORIZED_PORT_INVALID"],
  ["written with digits that are not ASCII", "\uff15\uff14\uff15\uff19\uff19", "AUTHORIZED_PORT_INVALID"],
  ["different from the URL's", "54600", "AUTHORIZED_PORT_MISMATCH"],
];

const REFUSED_VARIABLES = [
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGOPTIONS",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
  "PGREPLICATION",
  "PGBINARY",
  "PGCLIENT_ENCODING",
  "PGSERVICE",
  "PGPASSFILE",
  "PGDATA",
  "PGSOMETHING_NEW_9",
  "NODE_PG_FORCE_NATIVE",
];

/** Asserts claims A and C for one refused configuration. */
async function expectRefusedBeforeAnyConstruction(code: string, afterLoading: () => void = () => undefined): Promise<void> {
  const harness = await loadHarness();
  afterLoading();
  const { value: error, output } = await capturingOutput(() => rejection(() => harness.openDisposableDatabase()));

  expect(error).toBeInstanceOf(harness.AdminTargetRefusedError);
  expect((error as { code: string }).code).toBe(code);
  expect((error as Error).message).toBe(`Refusing the PostgreSQL test connection target: ${code}`);
  // A. Nothing was constructed, so nothing could have connected.
  expect(fake.state.clients).toHaveLength(0);
  expect(fake.state.pools).toHaveLength(0);
  expect(fake.state.statements).toEqual([]);
  // C. Nothing of the input came back out.
  expect(surfacesOf(error).toLowerCase()).not.toContain(MARKER);
  expect(output.toLowerCase()).not.toContain(MARKER);
  expect((error as { cause?: unknown }).cause).toBeUndefined();

  // The same configuration fails collection of a database test file: it is never a skip.
  const collected = await capturingOutput(() => rejection(async () => harness.adminUrl()));
  expect(collected.value).toBeInstanceOf(harness.AdminTargetRefusedError);
  expect((collected.value as { code: string }).code).toBe(code);
  expect(surfacesOf(collected.value).toLowerCase()).not.toContain(MARKER);
  expect(collected.output.toLowerCase()).not.toContain(MARKER);
  expect(fake.state.clients).toHaveLength(0);
  expect(fake.state.pools).toHaveLength(0);
}

describe("A and C: a refused URL, port or environment constructs no client and no pool, and leaks nothing", () => {
  it.each(UNSAFE_URLS)("admin URL with %s", async (_name, url, code) => {
    setEnvironment({ [ADMIN_URL]: url, [AUTHORIZED_PORT]: PORT });
    await expectRefusedBeforeAnyConstruction(code);
  });

  it.each(UNSAFE_PORTS)("authorized port %s", async (_name, port, code) => {
    setEnvironment({ [ADMIN_URL]: GOOD, [AUTHORIZED_PORT]: port });
    await expectRefusedBeforeAnyConstruction(code);
  });

  it.each(REFUSED_VARIABLES)("with %s set in the environment", async (name) => {
    setEnvironment({ [ADMIN_URL]: GOOD, [AUTHORIZED_PORT]: PORT, [name]: `${MARKER}.example.com` });
    await expectRefusedBeforeAnyConstruction("ENVIRONMENT_VARIABLE_REFUSED");
  });

  it("when the platform URL parser throws, its error, which carries the URL, is dropped", async () => {
    setEnvironment({ [ADMIN_URL]: GOOD, [AUTHORIZED_PORT]: PORT });
    try {
      // Replaced only once the harness is loaded: loading modules needs the real parser.
      await expectRefusedBeforeAnyConstruction("ADMIN_URL_PARSER_DISAGREES", () => {
        vi.stubGlobal(
          "URL",
          class {
            constructor(input: string) {
              throw Object.assign(new TypeError(`Invalid URL: ${input}`), { input });
            }
          },
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a variable that is not set at all is the only case that is not a refusal: adminUrl() is undefined and the suites skip", async () => {
    const harness = await loadHarness();
    expect(harness.adminUrl()).toBeUndefined();
    const error = await rejection(() => harness.openDisposableDatabase());
    expect(error).not.toBeInstanceOf(harness.AdminTargetRefusedError);
    expect((error as Error).message).toBe("SHOPACCESS_PG_TEST_ADMIN_URL is not set");
    expect(fake.state.clients).toHaveLength(0);
    expect(fake.state.pools).toHaveLength(0);
  });
});

const MISMATCHES: ReadonlyArray<readonly [string, Row]> = [
  ["host", { host: "10.0.0.5" }],
  ["port", { port: 5432 }],
  ["database", { database: "template1" }],
  ["user", { user: "postgres_other" }],
  ["password", { password: "other" }],
  ["startup options", { options: "-c role=postgres" }],
  ["TLS", { ssl: true }],
  ["transport (a Unix socket)", { isDomainSocket: true }],
];

/** Where in a full provisioning each configuration is constructed, and how many pools exist by then. */
const SITES: ReadonlyArray<readonly [string, number, number]> = [
  ["the lock-owning control session", 0, 0],
  ["the bootstrap client", 1, 0],
  ["the migration pool", 2, 0],
  ["the web pool", 3, 1],
  ["the operator pool", 4, 2],
  ["the second test-owner connection", 5, 3],
];

describe("B and C: a driver-configuration mismatch is refused with no connect() call, at every connection the harness makes", () => {
  for (const [site, at, poolsBefore] of SITES) {
    it.each(MISMATCHES)(`${site}: a different effective %s`, async (_name, change) => {
      setEnvironment({ [ADMIN_URL]: GOOD, [AUTHORIZED_PORT]: PORT });
      fake.state.mismatch = { at, change };
      const harness = await loadHarness();
      const { value: error, output } = await capturingOutput(() => rejection(() => harness.openDisposableDatabase()));

      expect(error).toBeInstanceOf(harness.AdminTargetRefusedError);
      expect((error as { code: string }).code).toBe("DRIVER_TARGET_MISMATCH");
      // B. The mismatched client was constructed, and connect() was never called on it.
      expect(fake.state.clients).toHaveLength(at + 1);
      expect(fake.state.clients[at].connectCalls).toBe(0);
      // No pool was constructed from the refused configuration, so no pool could connect with it either.
      expect(fake.state.pools).toHaveLength(poolsBefore);
      if (at === 0) expect(totalConnects()).toBe(0);
      // Whatever the run had already created was removed again: a refusal leaves nothing behind.
      serverIsPristine();
      // C. Neither the admin credential nor anything else of the target is in the error or the output.
      expect(surfacesOf(error).toLowerCase()).not.toContain(MARKER);
      expect(surfacesOf(error)).not.toContain(GOOD_PASSWORD);
      expect(output.toLowerCase()).not.toContain(MARKER);
    });
  }

  it("the second test-owner connection: when it cannot connect, it is ended, nothing is handed out, and everything the run created is removed", async () => {
    setEnvironment({ [ADMIN_URL]: GOOD, [AUTHORIZED_PORT]: PORT });
    fake.state.failConnectAt = 5;
    const harness = await loadHarness();
    const { value: error, output } = await capturingOutput(() => rejection(() => harness.openDisposableDatabase()));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("the stub client could not connect");
    // It was constructed from a verified configuration and connect() was tried once; having failed, it was ended.
    expect(fake.state.clients).toHaveLength(6);
    expect(fake.state.clients[5].connectCalls).toBe(1);
    expect(fake.state.clients[5].endCalls).toBe(1);
    // It was never registered, so cleanup sent it nothing: no statement went to a connection that never opened.
    expect(fake.state.statements).not.toContain("ROLLBACK");
    // The other connections were closed and the database and roles removed: the failure leaves nothing behind.
    expect(fake.state.clients[1].endCalls).toBe(1);
    expect(fake.state.pools.map((pool) => pool.ended)).toEqual([true, true, true]);
    serverIsPristine();
    expect(surfacesOf(error).toLowerCase()).not.toContain(MARKER);
    expect(surfacesOf(error)).not.toContain(GOOD_PASSWORD);
    expect(output.toLowerCase()).not.toContain(MARKER);
  });

  it.each(MISMATCHES)("connectWeb: a different effective %s", async (_name, change) => {
    setEnvironment({ [ADMIN_URL]: GOOD, [AUTHORIZED_PORT]: PORT });
    const harness = await loadHarness();
    const db = await harness.openDisposableDatabase();
    const connectsBefore = totalConnects();
    fake.state.mismatch = { at: 6, change };

    const error = await rejection(() => db.connectWeb());
    expect(error).toBeInstanceOf(harness.AdminTargetRefusedError);
    expect((error as { code: string }).code).toBe("DRIVER_TARGET_MISMATCH");
    expect(fake.state.clients).toHaveLength(7);
    expect(fake.state.clients[6].connectCalls).toBe(0);
    expect(totalConnects()).toBe(connectsBefore);
    expect(surfacesOf(error).toLowerCase()).not.toContain(MARKER);

    await db.destroy();
    serverIsPristine();
  });
});
