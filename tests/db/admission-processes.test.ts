import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectionStartupOptions } from "@/lib/pg/client";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { adminUrl, openDisposableDatabase, resetAdmissionWindow, ROOT, TEST_KEY_V1, type DisposableDatabase } from "./harness";

/**
 * PGT-04: admission from two INDEPENDENT operating-system processes.
 *
 * Corrected after the first Gate B-X run, in which both tests timed out: each
 * child printed its report but never exited, because its standard input was
 * still open and kept its event loop alive, while the test waited for the
 * child to close. Now the parent closes the child's input when it sends the
 * start signal, the child releases its input once it has reported, and a
 * deadline turns any remaining hang into an error that says how far the child
 * got. This corrected version ran in the second Gate B-X run (9 October 2026,
 * PostgreSQL 17.11): both tests passed.
 *
 * Each child is a separate `node` process with its own connections; nothing is
 * shared with this process or with the other child except the database. This
 * is deliberately not Promise.all inside one process.
 *
 * Synchronization is a start barrier, not a sleep: each child opens all of its
 * connections, reports "ready", and sends nothing until it is told "go". Both
 * are released together. The expected totals do not depend on how the two
 * processes then interleave, so the outcome is deterministic.
 *
 * The child's program is passed on the command line; the statement it sends is
 * the catalogue's `admitSession`, and the connection string travels in the
 * child's environment, never in its arguments.
 */
const CHILD_PROGRAM = `
const { Client } = require("pg");
const { randomBytes } = require("node:crypto");
(async () => {
  const clients = [];
  for (let i = 0; i < Number(process.env.ADMISSION_COUNT); i += 1) {
    const client = new Client({ connectionString: process.env.ADMISSION_URL, options: process.env.ADMISSION_OPTIONS });
    await client.connect();
    clients.push(client);
  }
  process.stdout.write("ready\\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  // Nothing more is read. An open stdin would keep this process alive after its work is done.
  process.stdin.destroy();
  const results = await Promise.all(clients.map(async (client) => {
    try {
      const values = ["ses_" + randomBytes(16).toString("hex"), 1, randomBytes(32).toString("hex")];
      return (await client.query(process.env.ADMISSION_STATEMENT, values)).rows[0].result;
    } catch (error) {
      return "ERROR:" + (error && error.code ? error.code : "UNKNOWN");
    }
  }));
  await Promise.all(clients.map((client) => client.end()));
  // The exit code is set and the process ends by itself once the report has been flushed.
  process.exitCode = 0;
  process.stdout.write(JSON.stringify({ pid: process.pid, results }) + "\\n");
})().catch((error) => {
  // An error code only: never a message that could carry the connection string.
  process.stderr.write("child failed: " + (error && error.code ? error.code : "UNKNOWN") + "\\n");
  process.exit(1);
});
`;

const ADMISSIONS_PER_PROCESS = 20;
/** A child that has not exited by then is killed and reported. Shorter than the test timeout, so the reason is visible. */
const CHILD_DEADLINE_MS = 40_000;

interface ChildReport {
  readonly pid: number;
  readonly results: readonly string[];
}

interface Admitter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly report: Promise<ChildReport>;
}

describe.skipIf(!adminUrl())("PGT-04: two independent processes admit under the same limits", () => {
  let db: DisposableDatabase;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    db = await openDisposableDatabase();
    await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 1, computeKeyCheckValue(TEST_KEY_V1, "session")]);
  });
  afterAll(async () => {
    for (const child of children) child.kill();
    await db?.destroy();
  });
  beforeEach(async () => {
    await db.admin.query("DELETE FROM shopaccess.shopper_sessions");
    await resetAdmissionWindow(db.admin);
  });

  function startAdmitter(): Admitter {
    const child = spawn(process.execPath, ["-e", CHILD_PROGRAM], {
      cwd: ROOT,
      // A minimal environment: the child inherits nothing else from the test process.
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        ADMISSION_URL: db.webConnectionString,
        ADMISSION_OPTIONS: connectionStartupOptions(),
        ADMISSION_STATEMENT: SESSION_STATEMENTS.admitSession,
        ADMISSION_COUNT: String(ADMISSIONS_PER_PROCESS),
      },
      stdio: "pipe",
    });
    children.push(child);
    let output = "";
    let errors = "";
    let announceReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      announceReady = resolve;
    });
    const reportLine = () => output.split("\n").find((candidate) => candidate.startsWith("{"));
    /** How far the child got. Contains no connection string: the child prints only "ready", its report and error codes. */
    const progress = () =>
      `ready=${output.includes("ready\n")}, reported=${reportLine() !== undefined}, stderr=${JSON.stringify(errors.trim().slice(0, 300))}`;
    const report = new Promise<ChildReport>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill();
        reject(new Error(`admission process did not exit within ${CHILD_DEADLINE_MS} ms (${progress()})`));
      }, CHILD_DEADLINE_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("ready\n")) announceReady();
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        errors += chunk;
      });
      // Writing the start signal to a child that has already died must not become an unhandled error.
      child.stdin.on("error", () => undefined);
      child.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(deadline);
        const line = reportLine();
        if (code !== 0 || !line) reject(new Error(`admission process ended with code ${code}, signal ${signal} (${progress()})`));
        else resolve(JSON.parse(line) as ChildReport);
      });
    });
    return { child, ready, report };
  }

  async function admitFromTwoProcesses(): Promise<string[]> {
    const admitters = [startAdmitter(), startAdmitter()];
    // Barrier: both processes hold all their connections open and have sent nothing.
    await Promise.race([Promise.all(admitters.map((admitter) => admitter.ready)), Promise.all(admitters.map((admitter) => admitter.report))]);
    // Release both together. Ending the stream sends the signal and closes the child's input, so the child can exit.
    for (const admitter of admitters) admitter.child.stdin.end("go\n");
    const reports = await Promise.all(admitters.map((admitter) => admitter.report));

    // Two real processes, neither of them this one.
    expect(new Set([process.pid, ...reports.map((report) => report.pid)]).size).toBe(3);
    for (const report of reports) expect(report.results).toHaveLength(ADMISSIONS_PER_PROCESS);
    return reports.flatMap((report) => [...report.results]);
  }

  const count = async (where = "") => Number((await db.admin.query(`SELECT count(*) AS n FROM shopaccess.shopper_sessions ${where}`)).rows[0].n);
  const budget = async () =>
    Number((await db.admin.query("SELECT window_admissions FROM shopaccess.session_admission_guard WHERE id = 1")).rows[0].window_admissions);

  it("40 admissions from two processes into an empty table admit exactly 30 in total", async () => {
    const results = await admitFromTwoProcesses();
    expect(results.filter((result) => result === "ADMITTED")).toHaveLength(30);
    expect(results.filter((result) => result === "RATE_LIMITED")).toHaveLength(10);
    expect(await count()).toBe(30);
    expect(await budget()).toBe(30);
  });

  it("with one slot left, 40 admissions from two processes create exactly one session in total", async () => {
    await db.admin.query(
      `INSERT INTO shopaccess.checkout_owners (id, created_at)
       SELECT 'own_' || lpad(to_hex(g), 32, '0'), clock_timestamp() FROM generate_series(1, 499) g
       ON CONFLICT (id) DO NOTHING`,
    );
    await db.admin.query(
      `INSERT INTO shopaccess.shopper_sessions (id, owner_id, key_version, token_digest, created_at, last_seen_at, absolute_expires_at)
       SELECT 'ses_' || lpad(to_hex(g), 32, '0'), 'own_' || lpad(to_hex(g), 32, '0'), 1, lpad(to_hex(g), 64, '0'), t.now, t.now, t.now + interval '24 hours'
         FROM generate_series(1, 499) g, (SELECT clock_timestamp() AS now) t`,
    );
    await resetAdmissionWindow(db.admin);

    const results = await admitFromTwoProcesses();
    expect(results.filter((result) => result === "ADMITTED")).toHaveLength(1);
    // One admission and 29 capacity refusals use the whole budget of 30; the remaining 10 are rate refusals.
    expect(results.filter((result) => result === "AT_CAPACITY")).toHaveLength(29);
    expect(results.filter((result) => result === "RATE_LIMITED")).toHaveLength(10);
    expect(await count()).toBe(500);
    expect(await budget()).toBe(30);
  });
});
