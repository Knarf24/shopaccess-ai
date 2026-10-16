import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PinnedConnection, withPinnedConnection, type PgAcquiredClient, type PgConnectionSource } from "@/lib/pg/client";
import {
  APPROVED_MIGRATIONS,
  applyMigrations,
  discoverMigrations,
  findTransactionControl,
  listMigrations,
  planMigrations,
  type AppliedMigration,
  type ApprovedMigration,
  type MigrationFile,
} from "@/lib/pg/migrate";
import { MIGRATION_STATEMENTS as S } from "@/lib/pg/statements";

// Database-free. The "connections" here are in-memory fakes; nothing connects to PostgreSQL or executes SQL.

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
const ARCHIVE_DIR = join(MIGRATIONS_DIR, "archive", "milestone-001-unexecuted");
const VERSIONS = APPROVED_MIGRATIONS.map((entry) => entry.version);

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

// ---------------------------------------------------------------------------
// A fake connection source that records which connection carried each statement
// ---------------------------------------------------------------------------

interface Sent {
  readonly connection: number;
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface FakeOptions {
  /** Rows already in the ledger, or null when the ledger table does not exist yet. */
  readonly ledger?: AppliedMigration[] | null;
  /** Return an error to make that statement fail. */
  readonly failOn?: (text: string, values: readonly unknown[] | undefined) => Error | undefined;
}

function fakeDatabase(options: FakeOptions = {}) {
  const sent: Sent[] = [];
  const releases: Array<{ connection: number; destroy: boolean | undefined }> = [];
  // Committed state, shared by every connection, as in a real database.
  let ledger: AppliedMigration[] | null = options.ledger === undefined ? null : options.ledger === null ? null : [...options.ledger];
  let connects = 0;

  const source: PgConnectionSource = {
    async connect(): Promise<PgAcquiredClient> {
      connects += 1;
      const connection = connects;
      // Transaction state belongs to ONE connection: a BEGIN on one is invisible to another.
      let inTransaction = false;
      let pending: AppliedMigration[] = [];
      let createdLedger = false;
      return {
        async query<Row>(text: string, values?: readonly unknown[]) {
          sent.push({ connection, text, values });
          const failure = options.failOn?.(text, values);
          if (failure) throw failure;
          if (text === S.begin) {
            inTransaction = true;
            pending = [];
            createdLedger = false;
          } else if (text === S.commit) {
            if (inTransaction) {
              if (createdLedger && ledger === null) ledger = [];
              if (pending.length > 0) ledger = [...(ledger ?? []), ...pending];
            }
            inTransaction = false;
          } else if (text === S.rollback) {
            inTransaction = false;
            pending = [];
            createdLedger = false;
          } else if (text === S.ledgerExists) {
            return { rows: [{ present: ledger !== null || createdLedger }] as Row[] };
          } else if (text === S.readLedger) {
            return { rows: [...(ledger ?? []), ...pending] as Row[] };
          } else if (text === S.recordMigration) {
            if (!inTransaction) throw new Error("ledger row written outside a transaction on this connection");
            pending.push({ version: String(values?.[0]), checksum: String(values?.[1]) });
          } else if (text !== S.lockMigrations) {
            // A migration file. The first one creates the ledger table.
            if (!inTransaction) throw new Error("migration run outside a transaction on this connection");
            createdLedger = true;
          }
          return { rows: [] as Row[] };
        },
        release(destroy?: boolean) {
          releases.push({ connection, destroy });
        },
      };
    },
  };
  return {
    source,
    sent,
    releases,
    get connects() {
      return connects;
    },
    get ledger() {
      return ledger;
    },
  };
}

const failure = (message: string) => Object.assign(new Error(message), { code: "XX000" });
const migrationSql = (version: string) => readFileSync(join(MIGRATIONS_DIR, `${version}.sql`), "utf8");
const approvedLedger = (count: number): AppliedMigration[] =>
  APPROVED_MIGRATIONS.slice(0, count).map((entry) => ({ version: entry.version, checksum: entry.sha256 }));

describe("migration runner: every statement of a run travels on one pinned connection", () => {
  it("applies the nine approved migrations on a single connection and releases it once", async () => {
    const db = fakeDatabase();
    const result = await applyMigrations(db.source, MIGRATIONS_DIR);
    expect(result).toEqual({ ok: true, value: VERSIONS });

    expect(db.connects).toBe(1);
    expect(new Set(db.sent.map((statement) => statement.connection))).toEqual(new Set([1]));
    expect(db.releases).toEqual([{ connection: 1, destroy: false }]);
    expect(db.ledger).toEqual(approvedLedger(9));

    // Per migration, in order and with nothing in between: BEGIN, lock, ledger check, (ledger read), file, ledger row, COMMIT.
    const texts = db.sent.map((statement) => statement.text);
    let cursor = 0;
    for (const [index, version] of VERSIONS.entries()) {
      const expected = [S.begin, S.lockMigrations, S.ledgerExists, ...(index === 0 ? [] : [S.readLedger]), migrationSql(version), S.recordMigration, S.commit];
      expect(texts.slice(cursor, cursor + expected.length), version).toEqual(expected);
      cursor += expected.length;
    }
    // The final pass finds nothing pending and commits an empty transaction.
    expect(texts.slice(cursor)).toEqual([S.begin, S.lockMigrations, S.ledgerExists, S.readLedger, S.commit]);

    // Each ledger row carries the file's version and checksum as bound values, never in the statement text.
    const recorded = db.sent.filter((statement) => statement.text === S.recordMigration).map((statement) => statement.values);
    expect(recorded).toEqual(APPROVED_MIGRATIONS.map((entry) => [entry.version, entry.sha256]));
  });

  it("is a no-op on an up-to-date database, and resumes after the last applied migration", async () => {
    const current = fakeDatabase({ ledger: approvedLedger(9) });
    expect(await applyMigrations(current.source, MIGRATIONS_DIR)).toEqual({ ok: true, value: [] });
    expect(current.sent.map((statement) => statement.text)).toEqual([S.begin, S.lockMigrations, S.ledgerExists, S.readLedger, S.commit]);
    expect(current.releases).toEqual([{ connection: 1, destroy: false }]);

    const partial = fakeDatabase({ ledger: approvedLedger(4) });
    expect(await applyMigrations(partial.source, MIGRATIONS_DIR)).toEqual({ ok: true, value: VERSIONS.slice(4) });
    expect(partial.connects).toBe(1);
  });

  it("a failing migration is rolled back on the same connection and never recorded", async () => {
    const boom = failure("syntax error in 0003");
    const db = fakeDatabase({ failOn: (text) => (text === migrationSql(VERSIONS[2]) ? boom : undefined) });
    await expect(applyMigrations(db.source, MIGRATIONS_DIR)).rejects.toBe(boom);

    expect(db.connects).toBe(1);
    expect(new Set(db.sent.map((statement) => statement.connection)).size).toBe(1);
    expect(db.sent.at(-1)?.text).toBe(S.rollback);
    expect(db.sent.filter((statement) => statement.text === S.recordMigration).map((statement) => statement.values?.[0])).toEqual(VERSIONS.slice(0, 2));
    expect(db.ledger).toEqual(approvedLedger(2));
    // Released exactly once, and destroyed: its transaction state is not trusted after a failure.
    expect(db.releases).toEqual([{ connection: 1, destroy: true }]);
  });

  it("a failure while writing the ledger row, or at COMMIT, leaves that migration unrecorded and unreported", async () => {
    for (const failingStatement of [S.recordMigration, S.commit]) {
      const boom = failure(`failed at ${failingStatement}`);
      let seen = 0;
      const db = fakeDatabase({
        ledger: approvedLedger(1),
        failOn: (text) => {
          if (text !== failingStatement) return undefined;
          seen += 1;
          return seen === 1 ? boom : undefined;
        },
      });
      await expect(applyMigrations(db.source, MIGRATIONS_DIR)).rejects.toBe(boom);
      expect(db.ledger, failingStatement).toEqual(approvedLedger(1));
      expect(db.sent.at(-1)?.text).toBe(S.rollback);
      expect(db.releases).toEqual([{ connection: 1, destroy: true }]);
    }
  });

  it("keeps the original error when the ROLLBACK also fails, and destroys the connection", async () => {
    const boom = failure("migration failed");
    const db = fakeDatabase({
      failOn: (text) => (text === migrationSql(VERSIONS[0]) ? boom : text === S.rollback ? failure("connection lost") : undefined),
    });
    await expect(applyMigrations(db.source, MIGRATIONS_DIR)).rejects.toBe(boom);
    expect(db.ledger).toBeNull();
    expect(db.releases).toEqual([{ connection: 1, destroy: true }]);
  });

  it("refuses an altered or unknown applied migration: rolls back, applies nothing, releases cleanly", async () => {
    const altered = approvedLedger(3).map((row, index) => (index === 1 ? { ...row, checksum: "0".repeat(64) } : row));
    const db = fakeDatabase({ ledger: altered });
    expect(await applyMigrations(db.source, MIGRATIONS_DIR)).toEqual({ ok: false, error: { code: "CHECKSUM_MISMATCH", version: VERSIONS[1] } });
    expect(db.sent.map((statement) => statement.text)).toEqual([S.begin, S.lockMigrations, S.ledgerExists, S.readLedger, S.rollback]);
    expect(db.ledger).toEqual(altered);
    expect(db.releases).toEqual([{ connection: 1, destroy: false }]);

    const unknown = fakeDatabase({ ledger: [...approvedLedger(6), { version: "0007_later", checksum: "a".repeat(64) }] });
    expect(await applyMigrations(unknown.source, MIGRATIONS_DIR)).toEqual({ ok: false, error: { code: "APPLIED_MIGRATION_MISSING", version: "0007_later" } });
  });

  it("acquires no connection at all when the directory is refused", async () => {
    const db = fakeDatabase();
    expect(await applyMigrations(db.source, ARCHIVE_DIR)).toMatchObject({ ok: false, error: { code: "ARCHIVE_DIRECTORY_REFUSED" } });
    expect(await applyMigrations(db.source, join(ROOT, "db", "bootstrap"))).toMatchObject({ ok: false, error: { code: "DIRECTORY_NOT_APPROVED" } });
    expect(db.connects).toBe(0);
    expect(db.sent).toEqual([]);
  });

  it("accepts no inventory or statement argument: only the approved files and the catalogue can be used", () => {
    expect(applyMigrations.length).toBe(2);
  });
});

describe("pinned connections: a query-only object can never stand in for a transaction-bound connection", () => {
  const queryOnly = { query: async () => ({ rows: [] }) };

  it("refuses a pool-style object that has query() but hands out no pinned client", async () => {
    // @ts-expect-error a query-only object is not a connection source
    await expect(applyMigrations(queryOnly, MIGRATIONS_DIR)).rejects.toThrow(TypeError);
    // @ts-expect-error a query-only object is not a connection source
    await expect(withPinnedConnection(queryOnly, async () => "never")).rejects.toThrow(/pinned connection/);
  });

  it("refuses a source whose connect() does not return a releasable client", async () => {
    let worked = false;
    const work = async () => {
      worked = true;
    };
    // A bare `pg` Client: connect() resolves to nothing, and the object itself has query().
    const bareClient = { connect: async () => undefined, query: queryOnly.query };
    // connect() hands back something that can query but cannot be released.
    const unreleasable = { connect: async () => queryOnly };
    for (const source of [bareClient, unreleasable, null, undefined, "postgres://example"]) {
      await expect(withPinnedConnection(source as never, work)).rejects.toThrow(TypeError);
    }
    expect(worked).toBe(false);
  });

  it("a malformed client that can be released but cannot query is released for destruction, not abandoned", async () => {
    for (const query of [undefined, null, "not a function", 42]) {
      const released: Array<boolean | undefined> = [];
      let worked = false;
      const source = { connect: async () => ({ query, release: (destroy?: boolean) => void released.push(destroy) }) };
      await expect(
        withPinnedConnection(source as never, async () => {
          worked = true;
        }),
      ).rejects.toThrow(TypeError);
      // Given back exactly once, flagged so the adapter destroys it rather than reusing it; no work ran.
      expect(released, String(query)).toEqual([true]);
      expect(worked).toBe(false);
    }

    // The runner fails closed in the same way and sends nothing.
    const released: Array<boolean | undefined> = [];
    const malformed = { connect: async () => ({ release: (destroy?: boolean) => void released.push(destroy) }) };
    await expect(applyMigrations(malformed as never, MIGRATIONS_DIR)).rejects.toThrow(/usable, releasable client/);
    expect(released).toEqual([true]);

    // A release that itself throws does not replace the refusal.
    const throwing = {
      connect: async () => ({
        release: () => {
          throw new Error("release failed");
        },
      }),
    };
    await expect(withPinnedConnection(throwing as never, async () => "never")).rejects.toThrow(TypeError);

    // Nothing to release: still refused, and nothing is called on the object.
    const touched: string[] = [];
    const inert = new Proxy({}, { get: (_target, key) => (touched.push(String(key)), undefined) });
    await expect(withPinnedConnection({ connect: async () => inert } as never, async () => "never")).rejects.toThrow(TypeError);
    // "then" is the promise machinery inspecting the resolved value, not the code under test.
    expect(touched.filter((key) => key !== "query" && key !== "release" && key !== "then")).toEqual([]);
  });

  it("cannot be constructed directly, and is unusable after release", async () => {
    const db = fakeDatabase();
    const client = await db.source.connect();
    expect(() => new PinnedConnection(Symbol("forged"), client)).toThrow(TypeError);

    let escaped: PinnedConnection | null = null;
    await withPinnedConnection(db.source, async (connection) => {
      escaped = connection;
      expect(() => connection.close(Symbol("forged"))).toThrow(TypeError);
      await connection.query(S.begin);
    });
    await expect(escaped!.query(S.commit)).rejects.toThrow(/already been released/);
    // The statement after release never reached a connection.
    expect(db.sent.map((statement) => statement.text)).toEqual([S.begin]);
  });

  it("releases exactly once in every case: reusable on success, destroyed on failure or discard", async () => {
    const success = fakeDatabase();
    expect(await withPinnedConnection(success.source, async () => 42)).toBe(42);
    expect(success.releases).toEqual([{ connection: 1, destroy: false }]);

    const failed = fakeDatabase();
    const boom = new Error("work failed");
    await expect(
      withPinnedConnection(failed.source, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(failed.releases).toEqual([{ connection: 1, destroy: true }]);

    const discarded = fakeDatabase();
    await withPinnedConnection(discarded.source, async (connection) => connection.discard());
    expect(discarded.releases).toEqual([{ connection: 1, destroy: true }]);
  });

  it("the fake itself proves the point: split across two connections, a ledger row has no transaction", async () => {
    // What the old runner allowed: BEGIN on one connection, the ledger row on another.
    const db = fakeDatabase();
    const first = await db.source.connect();
    const second = await db.source.connect();
    await first.query(S.begin);
    await expect(second.query(S.recordMigration, ["0001_x", "a".repeat(64)])).rejects.toThrow(/outside a transaction/);
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("migration discovery is restricted to the approved inventory in a canonical db/migrations directory", () => {
  const created: string[] = [];
  /** A temporary tree. Returns its root; migrations go under <root>/db/migrations unless a file path says otherwise. */
  const tree = (files: Record<string, string | Buffer>): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "shopaccess-migrate-")));
    created.push(root);
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return root;
  };
  const inventoryOf = (files: Record<string, string>): ApprovedMigration[] =>
    Object.entries(files).map(([name, content]) => ({ version: name.replace(/\.sql$/, ""), sha256: sha256(content) }));
  /** A valid two-file directory plus extra entries, checked against the inventory of the two files. */
  const withExtras = (extras: Record<string, string>) => {
    const good = { "0001_first.sql": "CREATE TABLE a (id integer);", "0002_second.sql": "CREATE TABLE b (id integer);" };
    const root = tree({ ...Object.fromEntries(Object.entries({ ...good, ...extras }).map(([name, content]) => [join("db", "migrations", name), content])) });
    return { dir: join(root, "db", "migrations"), inventory: inventoryOf(good), root };
  };
  const copyOfRealMigrations = (): string => {
    const root = tree({});
    const dir = join(root, "db", "migrations");
    mkdirSync(dir, { recursive: true });
    for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
      if (entry.isFile()) cpSync(join(MIGRATIONS_DIR, entry.name), join(dir, entry.name));
    }
    return dir;
  };
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts exactly the inventory, in inventory order, with canonical paths and checksums", () => {
    const { dir, inventory } = withExtras({});
    const found = discoverMigrations(dir, inventory);
    if (!found.ok) throw new Error(`expected migrations: ${JSON.stringify(found.error)}`);
    expect(found.value.map((file) => file.version)).toEqual(["0001_first", "0002_second"]);
    for (const file of found.value) {
      expect(file.path).toBe(realpathSync(file.path));
      expect(file.checksum).toBe(sha256(readFileSync(file.path)));
    }
    // A real `archive` subdirectory is tolerated and never opened, whatever it holds.
    const withArchive = withExtras({ "archive/0003_never.sql": "BEGIN; DROP TABLE a; COMMIT;" });
    expect(discoverMigrations(withArchive.dir, withArchive.inventory).ok).toBe(true);
  });

  it("the real directory lists the nine approved files, and an unchanged copy of it is equivalent", () => {
    const real = listMigrations(MIGRATIONS_DIR);
    const copy = listMigrations(copyOfRealMigrations());
    if (!real.ok || !copy.ok) throw new Error("expected both to list");
    expect(real.value.map((file) => file.version)).toEqual(VERSIONS);
    expect(copy.value.map(({ version, checksum }) => ({ version, checksum }))).toEqual(real.value.map(({ version, checksum }) => ({ version, checksum })));
  });

  it("refuses direct archive paths", () => {
    for (const dir of [ARCHIVE_DIR, join(MIGRATIONS_DIR, "archive"), join(MIGRATIONS_DIR, "archive", "milestone-001-unexecuted", ".."), `${MIGRATIONS_DIR}/./archive/`]) {
      expect(listMigrations(dir), dir).toMatchObject({ ok: false, error: { code: "ARCHIVE_DIRECTORY_REFUSED" } });
    }
    // Even a directory that would otherwise qualify.
    const root = tree({ "archive/db/migrations/0001_first.sql": "SELECT 1;" });
    expect(discoverMigrations(join(root, "archive", "db", "migrations"), inventoryOf({ "0001_first.sql": "SELECT 1;" }))).toMatchObject({
      ok: false,
      error: { code: "ARCHIVE_DIRECTORY_REFUSED" },
    });
  });

  it("refuses symlink aliases that lead to archived migrations", () => {
    // 1. An innocent-looking db/migrations path that is a symlink to the real archive.
    const root = tree({});
    mkdirSync(join(root, "db"));
    symlinkSync(ARCHIVE_DIR, join(root, "db", "migrations"), "dir");
    expect(join(root, "db", "migrations")).not.toContain("archive");
    expect(listMigrations(join(root, "db", "migrations"))).toMatchObject({ ok: false, error: { code: "ARCHIVE_DIRECTORY_REFUSED" } });

    // 2. The alias is higher up the path.
    const stored = tree({ "archive/db/migrations/0001_first.sql": "SELECT 1;" });
    symlinkSync(join(stored, "archive"), join(stored, "current"), "dir");
    expect(discoverMigrations(join(stored, "current", "db", "migrations"), inventoryOf({ "0001_first.sql": "SELECT 1;" }))).toMatchObject({
      ok: false,
      error: { code: "ARCHIVE_DIRECTORY_REFUSED" },
    });

    // 3. A file inside a legitimate directory that is a symlink to an archived draft.
    const linked = tree({ "db/migrations/0002_second.sql": "SELECT 2;" });
    const draft = join(ARCHIVE_DIR, "0001_shopper_sessions.sql");
    symlinkSync(draft, join(linked, "db", "migrations", "0001_first.sql"), "file");
    const inventory = [{ version: "0001_first", sha256: sha256(readFileSync(draft)) }, { version: "0002_second", sha256: sha256("SELECT 2;") }];
    expect(discoverMigrations(join(linked, "db", "migrations"), inventory)).toEqual({ ok: false, error: { code: "NOT_A_REGULAR_FILE", name: "0001_first.sql" } });

    // 4. `archive` itself must be a real directory, not a link or a file.
    const fakeArchive = withExtras({});
    symlinkSync(ARCHIVE_DIR, join(fakeArchive.dir, "archive"), "dir");
    expect(discoverMigrations(fakeArchive.dir, fakeArchive.inventory)).toEqual({ ok: false, error: { code: "UNEXPECTED_ENTRY", name: "archive" } });
    const fileArchive = withExtras({ archive: "not a directory" });
    expect(discoverMigrations(fileArchive.dir, fileArchive.inventory)).toEqual({ ok: false, error: { code: "UNEXPECTED_ENTRY", name: "archive" } });
  });

  it("refuses a directory that is not a db/migrations directory, or does not exist", () => {
    const root = tree({ "db/other/0001_first.sql": "SELECT 1;", "migrations/0001_first.sql": "SELECT 1;" });
    const inventory = inventoryOf({ "0001_first.sql": "SELECT 1;" });
    expect(discoverMigrations(join(root, "db", "other"), inventory)).toMatchObject({ ok: false, error: { code: "DIRECTORY_NOT_APPROVED" } });
    expect(discoverMigrations(join(root, "migrations"), inventory)).toMatchObject({ ok: false, error: { code: "DIRECTORY_NOT_APPROVED" } });
    expect(discoverMigrations(join(root, "db", "migrations"), inventory)).toMatchObject({ ok: false, error: { code: "DIRECTORY_NOT_FOUND" } });
    expect(listMigrations(join(ROOT, "db", "bootstrap"))).toMatchObject({ ok: false, error: { code: "DIRECTORY_NOT_APPROVED" } });
  });

  it.each([
    ["an extra migration beyond the inventory", { "0003_third.sql": "SELECT 3;" }, "0003_third.sql"],
    ["a second file with an existing number", { "0001_other.sql": "SELECT 1;" }, "0001_other.sql"],
    ["a .sql file with a non-migration name", { "notes.sql": "SELECT 2;" }, "notes.sql"],
    ["a file that is not SQL", { "README.md": "notes" }, "README.md"],
    ["a hidden file", { ".hidden.sql": "SELECT 1;" }, ".hidden.sql"],
    ["a subdirectory other than archive", { "old/0003_ignored.sql": "SELECT 3;" }, "old"],
  ])("refuses %s", (_name, extras, name) => {
    const { dir, inventory } = withExtras(extras);
    expect(discoverMigrations(dir, inventory)).toEqual({ ok: false, error: { code: "UNEXPECTED_ENTRY", name } });
  });

  it("refuses a missing version and an inventory with duplicate, missing or misnumbered versions", () => {
    const { dir, inventory } = withExtras({});
    const third = { version: "0003_third", sha256: sha256("SELECT 3;") };
    expect(discoverMigrations(dir, [...inventory, third])).toEqual({ ok: false, error: { code: "MIGRATION_MISSING", version: "0003_third" } });

    const invalid: ApprovedMigration[][] = [
      [],
      [inventory[1]],
      [inventory[0], { ...inventory[1], version: "0003_second" }],
      [inventory[0], { ...inventory[1], version: "0001_second" }],
      [inventory[0], inventory[0]],
      [inventory[0], { ...inventory[1], version: "0002_Second" }],
      [inventory[0], { ...inventory[1], version: "0002_second.sql" }],
      [inventory[0], { ...inventory[1], sha256: "XYZ" }],
      [{ ...inventory[0], version: "../0001_first" }, inventory[1]],
    ];
    for (const candidate of invalid) {
      expect(discoverMigrations(dir, candidate), JSON.stringify(candidate)).toMatchObject({ ok: false, error: { code: "INVENTORY_INVALID" } });
    }
  });

  it("refuses any change to an approved file's bytes", () => {
    const dir = copyOfRealMigrations();
    expect(listMigrations(dir).ok).toBe(true);
    appendFileSync(join(dir, "0003_merchant_catalog.sql"), " ");
    expect(listMigrations(dir)).toEqual({ ok: false, error: { code: "CHECKSUM_NOT_APPROVED", version: "0003_merchant_catalog" } });

    // An archived draft placed under an approved name is not the approved file.
    const swapped = copyOfRealMigrations();
    cpSync(join(ARCHIVE_DIR, "0001_shopper_sessions.sql"), join(swapped, "0001_migration_ledger.sql"));
    expect(listMigrations(swapped)).toEqual({ ok: false, error: { code: "CHECKSUM_NOT_APPROVED", version: "0001_migration_ledger" } });

    // The pin alone stops transaction control added to an approved file, whatever its formatting.
    const tampered = copyOfRealMigrations();
    appendFileSync(join(tampered, "0006_session_and_key_functions.sql"), "\n/* harmless */ COMMIT\n;\n");
    expect(listMigrations(tampered)).toEqual({ ok: false, error: { code: "CHECKSUM_NOT_APPROVED", version: "0006_session_and_key_functions" } });
  });

  const EVASIONS: Array<[string, string]> = [
    ["a plain BEGIN", "BEGIN;\nSELECT 1;\nCOMMIT;"],
    ["a block comment before the keyword", "/* setup */ BEGIN;"],
    ["the semicolon on another line", "SELECT 1;\nCOMMIT\n\n   ;"],
    ["a keyword split from its qualifier by a newline", "START\n   TRANSACTION;"],
    ["lower case with extra spacing", "  begin   transaction ;"],
    ["a comment between keyword and semicolon", "ROLLBACK /* undo */ ;"],
    ["a line comment before the keyword", "-- finish\nCOMMIT;"],
    ["a nested block comment before the keyword", "/* outer /* inner */ still a comment */ COMMIT;"],
    ["a statement after a string literal", "SELECT 'x'; COMMIT;"],
    ["a tab-indented keyword after another statement", "SELECT 1;\tEND;"],
    ["ABORT", "ABORT;"],
    ["a savepoint", "SAVEPOINT s; SELECT 1; RELEASE s;"],
    ["a prepared transaction", "PREPARE\tTRANSACTION 'x';"],
    ["COMMIT inside a DO block", "DO $$ BEGIN COMMIT; END $$;"],
    ["ROLLBACK inside a tagged DO block", "DO $body$\nBEGIN\n  /* quiet */ ROLLBACK;\nEND\n$body$;"],
    ["no trailing semicolon", "SELECT 1; COMMIT"],
  ];

  it.each(EVASIONS)("transaction control is found despite formatting: %s", (_name, sql) => {
    expect(findTransactionControl(sql)).toBe("FOUND");
    // And through discovery, with the checksum pin satisfied, so only the scan stands in the way.
    const files = { "0001_first.sql": sql };
    const root = tree({ [join("db", "migrations", "0001_first.sql")]: sql });
    expect(discoverMigrations(join(root, "db", "migrations"), inventoryOf(files))).toEqual({
      ok: false,
      error: { code: "TRANSACTION_CONTROL_IN_FILE", version: "0001_first" },
    });
  });

  it("does not mistake comments, literals or function bodies for transaction control", () => {
    for (const sql of [
      "SELECT 'BEGIN; COMMIT;';",
      "-- BEGIN;\nSELECT 1;",
      "/* COMMIT; */ SELECT 1;",
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END; $$;",
      "CREATE TABLE t (id integer); -- ROLLBACK;",
      "SELECT E'it\\'s; COMMIT;';",
      'SELECT "commit" FROM t;',
      "COMMENT ON TABLE t IS 'begin';",
    ]) {
      expect(findTransactionControl(sql), sql).toBe("NONE");
    }
    for (const version of VERSIONS) expect(findTransactionControl(migrationSql(version)), version).toBe("NONE");
  });

  it("refuses a file it cannot analyse rather than guessing", () => {
    for (const sql of ["SELECT 'unterminated", "/* never closed\nCOMMIT;", "DO $$ BEGIN COMMIT;", 'SELECT "unterminated']) {
      expect(findTransactionControl(sql), sql).toBe("NOT_ANALYSABLE");
      const root = tree({ [join("db", "migrations", "0001_first.sql")]: sql });
      expect(discoverMigrations(join(root, "db", "migrations"), inventoryOf({ "0001_first.sql": sql }))).toEqual({
        ok: false,
        error: { code: "MIGRATION_NOT_ANALYSABLE", version: "0001_first" },
      });
    }
  });
});

describe("migration planning (PGT-51, database-free part)", () => {
  const file = (version: string, checksum: string): MigrationFile => ({ version, checksum, path: `/x/${version}.sql`, sql: "" });
  const files = [file("0001_a", "c1"), file("0002_b", "c2"), file("0003_c", "c3")];

  it("plans only what is pending, and nothing when up to date", () => {
    expect(planMigrations(files, [])).toEqual({ ok: true, value: files });
    expect(planMigrations(files, [{ version: "0001_a", checksum: "c1" }])).toEqual({ ok: true, value: files.slice(1) });
    expect(planMigrations(files, files.map(({ version, checksum }) => ({ version, checksum })))).toEqual({ ok: true, value: [] });
  });

  it("refuses an altered, unknown or out-of-order applied migration", () => {
    expect(planMigrations(files, [{ version: "0001_a", checksum: "changed" }])).toEqual({ ok: false, error: { code: "CHECKSUM_MISMATCH", version: "0001_a" } });
    expect(planMigrations(files, [{ version: "0009_gone", checksum: "c9" }])).toEqual({ ok: false, error: { code: "APPLIED_MIGRATION_MISSING", version: "0009_gone" } });
    expect(planMigrations(files, [{ version: "0002_b", checksum: "c2" }])).toEqual({ ok: false, error: { code: "APPLIED_OUT_OF_ORDER", version: "0002_b" } });
  });
});
