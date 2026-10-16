import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPLICATION_BIND_HOST,
  APPLICATION_CONFIGURATION_VARIABLES,
  APPLICATION_ORIGIN,
  APPLICATION_PORT,
  AUTHORIZATION_VALUE,
  AUTHORIZATION_VARIABLE,
  AUTHORIZED_APP_PORT_VARIABLE,
  CHILD_PASSTHROUGH_VARIABLES,
  EVIDENCE_DIRECTORY_VARIABLE,
  OWNERSHIP_ID_VARIABLE,
  REQUEST_DEADLINE_MS,
  RequestError,
  SERVER_LOG_VARIABLE,
  STARTUP_DEADLINE_MS,
  STOP_GRACE_MS,
  StartupError,
  applicationCleanupStep,
  applicationCommand,
  attributesOf,
  childEnvironment,
  createApplicationOwner,
  createHttpClient,
  describeCleanup,
  describeStartupFailure,
  diffRows,
  parseForms,
  parseSetCookie,
  processApplicationOwner,
  projectCleanupResult,
  readIntegrationInputs,
  recordCleanupResult,
  runCleanup,
  secretsFoundIn,
  serializeCleanupResult,
  startApplication,
  uniqueHandles,
  visibleText,
  type ApplicationHandle,
  type ChildExit,
  type HttpReply,
  type PathFacts,
  type ProcessDeps,
  type StartSpec,
  type StopSignal,
  type Transport,
} from "../integration/app-process";
import {
  CLEANUP_BOOLEAN_FACTS,
  CLEANUP_COUNT_FACTS,
  CLEANUP_STEP_NAMES,
  CodedFailure,
  FAILURE_CATEGORIES,
  FAILURE_CODES,
  SafeAssertionError,
  UNLISTED_STEP,
  classifyFailure,
  cleanupStepName,
  describeFailureClass,
  describeFindings,
  differingFields,
  inspectFacts,
  isSafeAssertion,
  redactedFailure,
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
  safeFacts,
  safeLabel,
  safeText,
  scanReply,
  scanText,
  trustedFailure,
  withRedactedFailures,
  type SecretEntry,
} from "../integration/safe-diagnostics";
import {
  OWNERSHIP_FORMAT,
  ROLLING_MODULUS,
  SENTINEL_CATEGORIES,
  SENTINEL_FORMAT,
  SentinelRegistry,
  atomicReplace,
  classifyIdentityRead,
  classifyPath,
  compareListings,
  concludeRun,
  createRunDirectory,
  createSafeLogger,
  evidenceFromValues,
  finalize,
  matchRegistered,
  ownershipRecord,
  qualifyOwnership,
  readOwnership,
  readSentinelEvidence,
  registerOwnership,
  registrationSequence,
  runBoundedSteps,
  scanBytes,
  scanStreams,
  serializeSentinelEvidence,
  signalDecision,
  utf8Bytes,
  withAdditionalValues,
  type ChunkReader,
  type OwnershipFacts,
  type SentinelEvidence,
  type StreamInput,
} from "../integration/run-evidence";

/**
 * Database-free controls of the integration driver's helpers (specification 19.19, Increment 2.3).
 *
 * Everything here runs against fakes and fake timers. No process is started, no port is opened or examined, no
 * request is sent and no file is written. The integration driver itself is never imported.
 */

const ROOT = process.cwd();

const SPEC: StartSpec = {
  command: "/fake/node",
  args: ["/fake/next", "dev"],
  cwd: "/fake",
  env: { PATH: "/usr/bin" },
  host: APPLICATION_BIND_HOST,
  port: APPLICATION_PORT,
  logPath: "/fake/app.log",
};

interface FakeOptions {
  /** What each readiness attempt answers. Default: ready at once. */
  readonly probe?: (signal: AbortSignal, attempt: number) => Promise<boolean>;
  readonly dies?: readonly StopSignal[];
  readonly portBusyBeforeStart?: boolean;
  readonly portStaysBusy?: boolean;
  readonly spawnThrows?: boolean;
  readonly noPid?: boolean;
}

/** A process, a port and a log that exist only in memory. */
function fake(options: FakeOptions = {}) {
  const state = {
    /** The signals the group dies of. A test may change it between attempts. */
    dies: [...(options.dies ?? ["SIGTERM", "SIGKILL"])] as StopSignal[],
    spawned: 0,
    probes: 0,
    probeSignals: [] as AbortSignal[],
    signals: [] as StopSignal[],
    groupAlive: false,
    childExited: false,
    logOpened: 0,
    logClosed: 0,
    written: [] as string[],
    logFailures: [] as string[],
    portChecks: 0,
  };
  let exitListener: ((exit: ChildExit) => void) | null = null;
  let outputListener: ((chunk: Buffer) => void) | null = null;
  const failureListeners: Array<() => void> = [];

  const deps: ProcessDeps = {
    spawn() {
      if (options.spawnThrows) throw new Error("spawn refused");
      state.spawned += 1;
      state.groupAlive = !options.noPid;
      return {
        pid: options.noPid ? undefined : 4242,
        onOutput: (listener) => void (outputListener = listener),
        onExit: (listener) => void (exitListener = listener),
      };
    },
    signalGroup(pid, signal) {
      expect(pid).toBe(4242);
      state.signals.push(signal);
      if (state.dies.includes(signal)) {
        state.groupAlive = false;
        if (!state.childExited) {
          state.childExited = true;
          exitListener?.({ code: null, signal, spawnError: false });
        }
      }
    },
    groupAlive: () => state.groupAlive,
    async portInUse(host, port) {
      expect([host, port]).toEqual([APPLICATION_BIND_HOST, APPLICATION_PORT]);
      state.portChecks += 1;
      if (state.spawned === 0) return options.portBusyBeforeStart === true;
      return state.groupAlive || options.portStaysBusy === true;
    },
    probe(signal) {
      state.probes += 1;
      state.probeSignals.push(signal);
      return options.probe ? options.probe(signal, state.probes) : Promise.resolve(true);
    },
    openLog() {
      state.logOpened += 1;
      return {
        write: (chunk) => void state.written.push(chunk.toString("utf8")),
        onFailure: (listener) => void failureListeners.push(listener),
        failures: () => state.logFailures,
        async close() {
          state.logClosed += 1;
        },
      };
    },
  };

  return {
    deps,
    state,
    /** The child exits by itself. `leavingDescendant` keeps another process of its group alive. */
    exit(code: number, leavingDescendant = false) {
      state.childExited = true;
      state.groupAlive = leavingDescendant;
      exitListener?.({ code, signal: null, spawnError: false });
    },
    output: (text: string) => outputListener?.(Buffer.from(text)),
    failLog(code: string) {
      state.logFailures.push(code);
      for (const listener of failureListeners) listener();
    },
  };
}

const never = (): Promise<boolean> => new Promise(() => undefined);

const [STEP_REQUESTS, STEP_APP_1, STEP_APP_2, STEP_APP_3, STEP_FIXTURE] = CLEANUP_STEP_NAMES;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("starting the application", () => {
  it("waits for a readiness attempt to succeed, captures output, and sends no signal", async () => {
    const app = fake({ probe: async (_signal, attempt) => attempt >= 3 });
    const starting = startApplication(app.deps, SPEC);
    await vi.advanceTimersByTimeAsync(1_000);
    const handle = await starting;

    app.output("ready on 3170\n");
    expect(app.state).toMatchObject({ spawned: 1, probes: 3, signals: [], logOpened: 1, logClosed: 0, written: ["ready on 3170\n"] });
    expect(handle.pid).toBe(4242);
    expect(handle.exit()).toBeNull();
    expect(handle.logFailures()).toEqual([]);
  });

  it("refuses a port that is already in use, before anything is spawned or opened", async () => {
    const app = fake({ portBusyBeforeStart: true });
    const error = await startApplication(app.deps, SPEC).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartupError);
    expect(error).toMatchObject({ code: "PORT_IN_USE", stop: null });
    expect(app.state).toMatchObject({ spawned: 0, logOpened: 0, probes: 0, signals: [] });
  });

  it("does nothing at all when it is cancelled before it begins", async () => {
    const app = fake();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(startApplication(app.deps, SPEC, { signal: cancelled.signal })).rejects.toMatchObject({ code: "STARTUP_CANCELLED", stop: null });
    expect(app.state).toMatchObject({ spawned: 0, logOpened: 0, portChecks: 0 });
  });

  it("reports a process that exits during startup, and closes its log", async () => {
    const app = fake({ probe: never });
    const outcome = startApplication(app.deps, SPEC).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(500);
    app.exit(1);
    await vi.advanceTimersByTimeAsync(0);
    const error = (await outcome) as StartupError;

    expect(error).toBeInstanceOf(StartupError);
    expect(error.code).toBe("EXITED_EARLY");
    // Nothing was left to signal: the group was already gone.
    expect(error.stop).toMatchObject({ stopped: true, signals: [], processRemaining: false, portFree: true, exit: { code: 1, signal: null, spawnError: false } });
    expect(app.state.logClosed).toBe(1);
    expect(app.state.probeSignals[0].aborted).toBe(true);
  });

  it("stops at the 60-second deadline: the pending attempt is aborted and the process group is stopped", async () => {
    const app = fake({ probe: never });
    const outcome = startApplication(app.deps, SPEC).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(STARTUP_DEADLINE_MS - 1);
    expect(app.state.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const error = (await outcome) as StartupError;

    expect(error.code).toBe("STARTUP_DEADLINE");
    expect(app.state.probeSignals.every((signal) => signal.aborted)).toBe(true);
    expect(app.state.signals).toEqual(["SIGTERM"]);
    expect(error.stop).toMatchObject({ stopped: true, processRemaining: false, portFree: true });
    expect(error.message).toBe("The application did not start: STARTUP_DEADLINE");
  });

  it("keeps trying while attempts fail or throw, and still ends at the deadline", async () => {
    const app = fake({ probe: async (_signal, attempt) => (attempt % 2 === 0 ? Promise.reject(new Error("refused")) : false) });
    const outcome = startApplication(app.deps, SPEC).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(STARTUP_DEADLINE_MS);
    expect(((await outcome) as StartupError).code).toBe("STARTUP_DEADLINE");
    expect(app.state.probes).toBeGreaterThan(100);
    expect(app.state.spawned).toBe(1);
  });

  it("can be cancelled while it waits, and then stops what it started", async () => {
    const app = fake({ probe: never });
    const cancel = new AbortController();
    const outcome = startApplication(app.deps, SPEC, { signal: cancel.signal }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(2_000);
    cancel.abort();
    await vi.advanceTimersByTimeAsync(0);
    const error = (await outcome) as StartupError;
    expect(error.code).toBe("STARTUP_CANCELLED");
    expect(app.state.signals).toEqual(["SIGTERM"]);
    expect(error.stop?.stopped).toBe(true);
  });

  it("a process that could not be spawned is a failure, with the log closed and nothing signalled", async () => {
    const thrown = fake({ spawnThrows: true });
    await expect(startApplication(thrown.deps, SPEC)).rejects.toMatchObject({ code: "SPAWN_FAILED", stop: null });
    expect(thrown.state).toMatchObject({ logOpened: 1, logClosed: 1, probes: 0 });

    const noPid = fake({ noPid: true });
    const error = (await startApplication(noPid.deps, SPEC).catch((caught: unknown) => caught)) as StartupError;
    expect(error.code).toBe("SPAWN_FAILED");
    expect(noPid.state).toMatchObject({ signals: [], probes: 0, logClosed: 1 });
  });

  it("a log that cannot be written fails startup, and the failure is carried in the result", async () => {
    const app = fake({ probe: never });
    const outcome = startApplication(app.deps, SPEC).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(300);
    app.failLog("ENOSPC");
    await vi.advanceTimersByTimeAsync(0);
    const error = (await outcome) as StartupError;
    expect(error.code).toBe("LOG_CAPTURE_FAILED");
    expect(error.stop).toMatchObject({ stopped: false, logFailures: ["ENOSPC"], processRemaining: false });
    expect(error.message).toContain("ITS STOP WAS NOT CLEAN");
  });
});

describe("stopping the application", () => {
  it("is idempotent: one SIGTERM, one result, however often it is asked", async () => {
    const app = fake();
    const handle = await startApplication(app.deps, SPEC);
    const first = handle.stop();
    const second = handle.stop();
    expect(second).toBe(first);
    const result = await first;
    expect(await handle.stop()).toBe(result);
    expect(result).toEqual({ stopped: true, signals: ["SIGTERM"], exit: { code: null, signal: "SIGTERM", spawnError: false }, processRemaining: false, portFree: true, logFailures: [], problems: [] });
    expect(app.state).toMatchObject({ signals: ["SIGTERM"], logClosed: 1 });
  });

  it("escalates to SIGKILL only after five seconds", async () => {
    const app = fake({ dies: ["SIGKILL"] });
    const handle = await startApplication(app.deps, SPEC);
    const stopping = handle.stop();
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 100);
    expect(app.state.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(app.state.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await stopping).toMatchObject({ stopped: true, signals: ["SIGTERM", "SIGKILL"], processRemaining: false });
  });

  it("says so when the process survives both signals, and still closes the log and checks the port", async () => {
    const app = fake({ dies: [] });
    const handle = await startApplication(app.deps, SPEC);
    const checksBefore = app.state.portChecks;
    const stopping = handle.stop();
    await vi.advanceTimersByTimeAsync(2 * STOP_GRACE_MS + 200);
    expect(await stopping).toMatchObject({ stopped: false, signals: ["SIGTERM", "SIGKILL"], processRemaining: true, portFree: false, exit: null });
    expect(app.state.logClosed).toBe(1);
    expect(app.state.portChecks).toBe(checksBefore + 1);
  });

  it("signals the group when the child has exited and a process it started has not", async () => {
    const app = fake();
    const handle = await startApplication(app.deps, SPEC);
    app.exit(0, true);
    expect(handle.exit()).toEqual({ code: 0, signal: null, spawnError: false });
    expect(await handle.stop()).toMatchObject({ stopped: true, signals: ["SIGTERM"], processRemaining: false });
  });

  it("does not signal a group that is already gone", async () => {
    const app = fake();
    const handle = await startApplication(app.deps, SPEC);
    app.exit(0);
    expect(await handle.stop()).toMatchObject({ stopped: true, signals: [] });
  });

  it("is not a clean stop while the port is still in use, or after a log failure", async () => {
    const busy = fake({ portStaysBusy: true });
    expect(await (await startApplication(busy.deps, SPEC)).stop()).toMatchObject({ stopped: false, processRemaining: false, portFree: false });

    const lossy = fake();
    const handle = await startApplication(lossy.deps, SPEC);
    lossy.failLog("EIO");
    expect(handle.logFailures()).toEqual(["EIO"]);
    expect(await handle.stop()).toMatchObject({ stopped: false, processRemaining: false, portFree: true, logFailures: ["EIO"] });
  });

  it("records a signal that could not be sent and a group that could not be examined", async () => {
    const app = fake();
    const handle = await startApplication(app.deps, SPEC);
    app.deps.signalGroup = () => {
      throw new Error("EPERM");
    };
    const stopping = handle.stop();
    await vi.advanceTimersByTimeAsync(2 * STOP_GRACE_MS + 200);
    expect(await stopping).toMatchObject({ stopped: false, signals: [], processRemaining: true, problems: ["SIGNAL_FAILED:SIGTERM", "SIGNAL_FAILED:SIGKILL"] });

    const blind = fake();
    const second = await startApplication(blind.deps, SPEC);
    blind.deps.groupAlive = () => {
      throw new Error("unexpected");
    };
    const blindStop = second.stop();
    await vi.advanceTimersByTimeAsync(2 * STOP_GRACE_MS + 200);
    expect(await blindStop).toMatchObject({ stopped: false, processRemaining: true, problems: ["GROUP_CHECK_FAILED"] });
  });
});

describe("HTTP requests", () => {
  const reply: HttpReply = { status: 200, headers: {}, body: "ok" };
  const obedient: Transport = (_spec, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const deaf: Transport = () => new Promise(() => undefined);

  it("returns the reply and sends each request exactly once", async () => {
    const transport = vi.fn<Transport>(async () => reply);
    const client = createHttpClient(transport);
    expect(await client.request({ method: "GET", path: "/" })).toBe(reply);
    expect(await client.submit({ method: "POST", path: "/checkout/start", body: "a=1" })).toEqual({ ok: true, reply });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(client.outstanding()).toBe(0);
  });

  it("aborts a request at the 15-second deadline and settles it, whether or not the transport honours the abort", async () => {
    for (const transport of [obedient, deaf]) {
      const signals: AbortSignal[] = [];
      const client = createHttpClient((spec, signal) => {
        signals.push(signal);
        return transport(spec, signal);
      });
      const settled = client.submit({ method: "POST", path: "/checkout/ci_1/confirm?x=secret", body: "nonce=value" });
      expect(client.outstanding()).toBe(1);
      await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS - 1);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // The description names the method and the path only: no query and no form value.
      expect(await settled).toEqual({ ok: false, code: "REQUEST_DEADLINE", request: "POST /checkout/ci_1/confirm" });
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(true);
      expect(client.outstanding()).toBe(0);
    }
  });

  it("never rejects from submit: a failing or throwing transport is a settled failure, sent once", async () => {
    const failing = vi.fn<Transport>(async () => {
      throw new Error("ECONNRESET with detail");
    });
    const throwing = vi.fn<Transport>(() => {
      throw new Error("synchronous");
    });
    for (const transport of [failing, throwing]) {
      const client = createHttpClient(transport);
      expect(await client.submit({ method: "GET", path: "/shop?use=x" })).toEqual({ ok: false, code: "REQUEST_FAILED", request: "GET /shop" });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(client.outstanding()).toBe(0);
    }
    const client = createHttpClient(failing);
    const error = await client.request({ method: "GET", path: "/" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: "REQUEST_FAILED", message: "REQUEST_FAILED: GET /" });
  });

  it("a request abandoned by its caller still settles, and a late transport error is received, not left unhandled", async () => {
    let rejectLate: (error: Error) => void = () => undefined;
    const client = createHttpClient(() => new Promise((_resolve, reject) => void (rejectLate = reject)));
    // Submitted and never awaited by this caller.
    void client.submit({ method: "POST", path: "/checkout/start" });
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
    expect(client.outstanding()).toBe(0);
    rejectLate(new Error("arrived after the deadline"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("abortOutstanding aborts and settles every pending request", async () => {
    const client = createHttpClient(deaf);
    const first = client.submit({ method: "POST", path: "/a" });
    const second = client.submit({ method: "POST", path: "/b" });
    expect(client.outstanding()).toBe(2);
    expect(await client.abortOutstanding()).toBe(2);
    expect(await Promise.all([first, second])).toEqual([
      { ok: false, code: "REQUEST_ABORTED", request: "POST /a" },
      { ok: false, code: "REQUEST_ABORTED", request: "POST /b" },
    ]);
    expect(client.outstanding()).toBe(0);
    expect(await client.abortOutstanding()).toBe(0);
  });
});

describe("cleanup", () => {
  it("runs every step in order, whatever the earlier ones did, and records each failure by class", async () => {
    const order: string[] = [];
    const result = await runCleanup([
      {
        name: STEP_REQUESTS,
        run: () => {
          order.push("requests");
          return { aborted: 2 };
        },
      },
      {
        name: STEP_APP_1,
        run: () => {
          order.push("application");
          throw new Error("stop failed, password hunter2 in message");
        },
      },
      {
        name: STEP_APP_2,
        run: async () => {
          order.push("log");
          throw new AggregateError([Object.assign(new Error("first"), { code: "E1" }), new TypeError("second")], "two things");
        },
      },
      {
        name: STEP_APP_3,
        run: async () => {
          order.push("stop");
          throw new CodedFailure("APPLICATION_NOT_STOPPED", { stopped: false, signalsSent: 2, note: "hunter2" } as unknown as Record<string, number>);
        },
      },
      { name: STEP_FIXTURE, run: async () => void order.push("fixture") },
    ]);
    expect(order).toEqual(["requests", "application", "log", "stop", "fixture"]);
    expect({ complete: result.complete, unreadable: result.unreadable }).toEqual({ complete: false, unreadable: false });
    expect(result.steps).toEqual([
      { name: STEP_REQUESTS, ok: true, category: null, code: null, errors: 0, facts: { aborted: 2 }, droppedFacts: 0 },
      { name: STEP_APP_1, ok: false, category: "UNKNOWN", code: null, errors: 0, facts: {}, droppedFacts: 0 },
      { name: STEP_APP_2, ok: false, category: "AGGREGATE", code: null, errors: 2, facts: {}, droppedFacts: 0 },
      { name: STEP_APP_3, ok: false, category: "CLEANUP", code: "APPLICATION_NOT_STOPPED", errors: 0, facts: { stopped: false, signalsSent: 2 }, droppedFacts: 1 },
      { name: STEP_FIXTURE, ok: true, category: null, code: null, errors: 0, facts: {}, droppedFacts: 0 },
    ]);
    // No name, message or member of any exception: only the fixed shape.
    expect(/hunter2|stop failed|two things|first|second|E1|TypeError/.test(JSON.stringify(result))).toBe(false);
  });

  it("is complete only when every step succeeded, and never throws", async () => {
    expect(await runCleanup([{ name: STEP_FIXTURE, run: () => undefined }])).toEqual({
      complete: true,
      unreadable: false,
      steps: [{ name: STEP_FIXTURE, ok: true, category: null, code: null, errors: 0, facts: {}, droppedFacts: 0 }],
    });
    expect(await runCleanup([])).toEqual({ complete: true, unreadable: false, steps: [] });
    const thrown = await runCleanup([
      {
        name: "a step that is not listed",
        run: () => {
          throw "a string";
        },
      },
    ]);
    expect(thrown).toEqual({ complete: false, unreadable: false, steps: [{ name: UNLISTED_STEP, ok: false, category: "UNKNOWN", code: null, errors: 0, facts: {}, droppedFacts: 0 }] });
  });
});

describe("the child environment", () => {
  const application = Object.fromEntries(APPLICATION_CONFIGURATION_VARIABLES.map((name) => [name, `value-of-${name}`]));
  const parent = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/someone",
    TMPDIR: "/tmp/x",
    LANG: "en_US.UTF-8",
    // None of these may reach the child.
    NODE_OPTIONS: "--require=/somewhere/preload.cjs",
    NODE_ENV: "production",
    DATABASE_URL: "postgres://elsewhere",
    PGPASSWORD: "pg-secret",
    PGHOST: "db.example",
    SHOPACCESS_PG_TEST_ADMIN_URL: "postgres://admin",
    SHOPACCESS_SESSION_KEYS: "1:parent-key",
    SHOPACCESS_SESSION_KEY: "mock-key",
    PAYPAL_CLIENT_SECRET: "paypal-secret",
    PAYMENT_PROVIDER_MODE: "paypal",
    OPENAI_API_KEY: "sk-openai",
    ANTHROPIC_API_KEY: "sk-anthropic",
    DASHSCOPE_API_KEY: "sk-qwen",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    NEXT_TELEMETRY_DISABLED: "0",
    [AUTHORIZATION_VARIABLE]: AUTHORIZATION_VALUE,
  };

  it("is exactly the passthrough names present, the six configuration values and the two fixed values", () => {
    const environment = childEnvironment(parent, application);
    expect(Object.keys(environment).sort()).toEqual([...["PATH", "HOME", "TMPDIR", "LANG"], ...APPLICATION_CONFIGURATION_VARIABLES, "NODE_ENV", "NEXT_TELEMETRY_DISABLED"].sort());
    expect(environment).toMatchObject({ PATH: "/usr/bin:/bin", NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", ...application });
    for (const name of Object.keys(environment)) {
      expect([...CHILD_PASSTHROUGH_VARIABLES, ...APPLICATION_CONFIGURATION_VARIABLES, "NODE_ENV", "NEXT_TELEMETRY_DISABLED"]).toContain(name);
    }
  });

  it("leaves every unrelated setting of the parent behind, including a parent value of a configuration name", () => {
    const serialized = JSON.stringify(childEnvironment(parent, application));
    for (const value of ["pg-secret", "db.example", "postgres://elsewhere", "postgres://admin", "parent-key", "mock-key", "paypal-secret", "paypal\"", "sk-openai", "sk-anthropic", "sk-qwen", "aws-secret", "preload.cjs", "production"]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).not.toContain(AUTHORIZATION_VARIABLE);
  });

  it("refuses an unknown or missing configuration name, naming it and never a value", () => {
    const extra = () => childEnvironment(parent, { ...application, OPENAI_API_KEY: "sk-must-not-pass" });
    expect(extra).toThrow("Not an application configuration variable: OPENAI_API_KEY");
    const { SHOPACCESS_DATABASE_URL: _left, ...partial } = application;
    expect(() => childEnvironment(parent, partial)).toThrow("Application configuration is incomplete: SHOPACCESS_DATABASE_URL");
    expect(() => childEnvironment(parent, { ...application, SHOPACCESS_NONCE_KEYS: "" })).toThrow("Application configuration is incomplete: SHOPACCESS_NONCE_KEYS");
    for (const attempt of [extra, () => childEnvironment(parent, partial)]) {
      try {
        attempt();
      } catch (error) {
        expect(String(error)).not.toMatch(/sk-must-not-pass|value-of-/);
      }
    }
  });

  it("the command is the installed framework's own script, run by the given Node, bound to loopback on the fixed port", () => {
    expect(applicationCommand("/repo", "/usr/local/bin/node")).toEqual({
      command: "/usr/local/bin/node",
      args: ["/repo/node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3170"],
    });
    expect(APPLICATION_ORIGIN).toBe("http://localhost:3170");
  });
});

describe("integration inputs", () => {
  const databaseVariables = ["DB_TARGET", "DB_PORT"];
  const facts: Record<string, PathFacts> = {
    "/private/evidence": { exists: true, directory: true, mode: 0o700 },
    "/private/open": { exists: true, directory: true, mode: 0o755 },
    "/private/server.log": { exists: true, directory: false, mode: 0o600 },
  };
  const inspect = (path: string): PathFacts => facts[path] ?? { exists: false, directory: false, mode: 0 };
  const complete = {
    [AUTHORIZATION_VARIABLE]: AUTHORIZATION_VALUE,
    [AUTHORIZED_APP_PORT_VARIABLE]: "3170",
    [EVIDENCE_DIRECTORY_VARIABLE]: "/private/evidence",
    [SERVER_LOG_VARIABLE]: "/private/server.log",
    [OWNERSHIP_ID_VARIABLE]: "0123456789abcdef0123456789abcdef",
    DB_TARGET: "postgres://user:not-to-be-echoed@127.0.0.1:54537/postgres",
    DB_PORT: "54537",
  };
  const read = (env: Record<string, string | undefined>) => readIntegrationInputs(env, { databaseVariables, repositoryRoot: "/repo", inspect });

  it("is ABSENT, and inspects nothing, while the authorization variable is not set at all", () => {
    const inspected = vi.fn(inspect);
    const { [AUTHORIZATION_VARIABLE]: _unset, ...withoutAuthorization } = complete;
    expect(readIntegrationInputs(withoutAuthorization, { databaseVariables, repositoryRoot: "/repo", inspect: inspected })).toEqual({ kind: "ABSENT" });
    expect(readIntegrationInputs({}, { databaseVariables, repositoryRoot: "/repo", inspect: inspected })).toEqual({ kind: "ABSENT" });
    expect(inspected).not.toHaveBeenCalled();
  });

  it("is AUTHORIZED only when everything is present and exact", () => {
    expect(read(complete)).toEqual({ kind: "AUTHORIZED", evidenceDirectory: "/private/evidence", serverLog: "/private/server.log", ownershipId: "0123456789abcdef0123456789abcdef" });
  });

  it("once set, anything missing or wrong is INVALID: never skipped, and described by variable name only", () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ ...complete, [AUTHORIZATION_VARIABLE]: "" }, AUTHORIZATION_VARIABLE],
      [{ ...complete, [AUTHORIZATION_VARIABLE]: "yes" }, AUTHORIZATION_VARIABLE],
      [{ ...complete, [AUTHORIZED_APP_PORT_VARIABLE]: "3000" }, AUTHORIZED_APP_PORT_VARIABLE],
      [{ ...complete, DB_TARGET: undefined }, "DB_TARGET"],
      [{ ...complete, [OWNERSHIP_ID_VARIABLE]: undefined }, OWNERSHIP_ID_VARIABLE],
      [{ ...complete, [OWNERSHIP_ID_VARIABLE]: "0123456789ABCDEF0123456789ABCDEF" }, OWNERSHIP_ID_VARIABLE],
      [{ ...complete, [OWNERSHIP_ID_VARIABLE]: "0123456789abcdef" }, OWNERSHIP_ID_VARIABLE],
      [{ ...complete, DB_PORT: "" }, "DB_PORT"],
      [{ ...complete, [EVIDENCE_DIRECTORY_VARIABLE]: "relative/dir" }, EVIDENCE_DIRECTORY_VARIABLE],
      [{ ...complete, [EVIDENCE_DIRECTORY_VARIABLE]: "/repo/evidence" }, EVIDENCE_DIRECTORY_VARIABLE],
      [{ ...complete, [EVIDENCE_DIRECTORY_VARIABLE]: "/private/missing" }, EVIDENCE_DIRECTORY_VARIABLE],
      [{ ...complete, [EVIDENCE_DIRECTORY_VARIABLE]: "/private/open" }, EVIDENCE_DIRECTORY_VARIABLE],
      [{ ...complete, [EVIDENCE_DIRECTORY_VARIABLE]: "/private/server.log" }, EVIDENCE_DIRECTORY_VARIABLE],
      [{ ...complete, [SERVER_LOG_VARIABLE]: undefined }, SERVER_LOG_VARIABLE],
      [{ ...complete, [SERVER_LOG_VARIABLE]: "/private/evidence" }, SERVER_LOG_VARIABLE],
      [{ ...complete, [SERVER_LOG_VARIABLE]: "/repo/server.log" }, SERVER_LOG_VARIABLE],
    ];
    for (const [env, variable] of cases) {
      const result = read(env);
      expect(result.kind, variable).toBe("INVALID");
      if (result.kind !== "INVALID") continue;
      expect(result.problems, variable).toHaveLength(1);
      expect(result.problems[0].startsWith(`${variable}: `), variable).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/not-to-be-echoed|relative\/dir|\/private\/|\/repo\//);
    }
    const everything = read({ [AUTHORIZATION_VARIABLE]: "no" });
    expect(everything.kind === "INVALID" ? everything.problems.length : 0).toBe(7);
  });
});

describe("reading responses", () => {
  const page = [
    '<html><body><p role="alert">Stale &amp; out of date</p>',
    "<h3>Laptop A<!-- --> — <!-- -->16 GB</h3><p>$1,299.00<!-- --> USD</p>",
    '<form action="/checkout/start" method="post"><input type="hidden" name="csrfToken" value="t&quot;1"/><input value="dmp_abc123" name="productId" type="hidden"/>',
    '<input type="checkbox" name="acknowledged" value="yes" required=""/><button type="submit">Go</button></form>',
    '<div hidden id="S:0"><form method="POST" action="/checkout/ci_1/cancel"><input name="csrfToken" type="hidden" value="t2"></form></div>',
    '<script>self.__next_f.push([1,"The shop is not available right now. <form action=\\"/in/script\\"></form>"])</script>',
    "<style>.x{content:'hidden text'}</style></body></html>",
  ].join("\n");

  it("reads forms by tag and attribute, in any attribute order, outside scripts", () => {
    expect(parseForms(page)).toEqual([
      { action: "/checkout/start", method: "post", hidden: { csrfToken: 't"1', productId: "dmp_abc123" }, controls: ["acknowledged"] },
      { action: "/checkout/ci_1/cancel", method: "post", hidden: { csrfToken: "t2" }, controls: [] },
    ]);
    expect(attributesOf('<input value="a" name=\'b\' required>')).toEqual({ value: "a", name: "b", required: "" });
  });

  it("gives the text a reader is given: no script, style, comment or tag", () => {
    const text = visibleText(page);
    expect(text).toContain("Stale & out of date");
    expect(text).toContain("Laptop A — 16 GB");
    expect(text).toContain("$1,299.00 USD");
    expect(text).not.toContain("The shop is not available right now.");
    expect(text).not.toContain("hidden text");
  });

  it("parses a Set-Cookie header into its name, value and attributes", () => {
    expect(parseSetCookie("__Host-s=1.abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60")).toEqual({
      name: "__Host-s",
      value: "1.abc",
      attributes: ["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=60"],
    });
    expect(parseSetCookie("no-pair; Path=/")).toBeNull();
  });

  it("compares full row content and reports secrets by label only", () => {
    expect(diffRows(["a", "b", "b"], ["b", "c", "b"])).toEqual({ removed: ["a"], added: ["c"] });
    expect(diffRows(["a", "a"], ["a"])).toEqual({ removed: ["a"], added: [] });
    expect(diffRows([], [])).toEqual({ removed: [], added: [] });
    const secrets = new Map([
      ["web password", "s3cr3t-value"],
      ["session key", "QUJDRA=="],
      ["empty", ""],
    ]);
    expect(secretsFoundIn("log line with QUJDRA== inside", secrets)).toEqual(["session key"]);
    expect(secretsFoundIn("nothing here", secrets)).toEqual([]);
    expect(JSON.stringify(secretsFoundIn("s3cr3t-value QUJDRA==", secrets))).not.toMatch(/s3cr3t|QUJD/);
  });
});

describe("separation: the unit suite cannot load or run the integration driver", () => {
  const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");
  // Built from parts, so that this file does not itself look like a file that imports the driver.
  const DRIVER_IMPORT = new RegExp(["from ", '"p', 'g"'].join(""));

  it("the three configurations select disjoint files", () => {
    expect(read("vitest.config.mts")).toContain('include: ["tests/unit/**/*.test.{ts,tsx}"]');
    expect(read("vitest.db.config.mts")).toContain('include: ["tests/db/**/*.test.ts"]');
    const integration = read("vitest.integration.config.mts");
    expect(integration).toContain('include: ["tests/integration/*.integration.test.ts"]');
    expect(integration).toContain("fileParallelism: false");
    expect(integration).not.toMatch(/tests\/unit|tests\/db/);
  });

  it("the helper module loads no database driver, no harness and no test runner, and reads no environment", () => {
    const helper = read("tests", "integration", "app-process.ts");
    expect(helper).not.toMatch(DRIVER_IMPORT);
    expect(helper).not.toMatch(/db\/harness|from "vitest"|from "@\/|process\.env|\bnpx\b/);
    const imports = [...helper.matchAll(/^import [^\n]* from "([^"]+)";$/gm)].map((match) => match[1]);
    // Its one local import is the pure diagnostics module.
    expect(imports).toEqual(["node:child_process", "node:fs", "node:http", "node:net", "node:path", "./safe-diagnostics"]);
  });

  it("this file imports the three helper modules only, never the driver", () => {
    const self = read("tests", "unit", "pg-app-process.test.ts");
    expect(self).not.toMatch(/^import [^\n]*integration\.test/m);
    expect([...self.matchAll(/^} from "\.\.\/integration\/([^"]+)";$/gm)].map((match) => match[1])).toEqual(["app-process", "safe-diagnostics", "run-evidence"]);
  });

  it("the driver calls no matcher of the runner, and the diagnostics module is pure", () => {
    const driver = read("tests", "integration", "pg-app.integration.test.ts");
    // No matcher at all: nothing in the driver can hand a value to the runner's diff.
    expect(/\bexpect\s*[.(]/.test(driver)).toBe(false);
    expect(driver).toContain('import { afterAll, beforeAll, describe, it } from "vitest";');
    expect(driver).toContain('} from "./safe-diagnostics";');
    // Every case and the setup hook go through the wrapper that redacts unexpected failures.
    const cases = [...driver.matchAll(/^  it\(\n    "[^\n]*",\n    guarded\(/gm)].length;
    expect(cases).toBe([...driver.matchAll(/^  it\(/gm)].length);
    expect(cases).toBe(16);
    expect(driver).toContain('beforeAll(\n    guarded("fixture setup", async () => {');
    // A response, a form or a header list is never serialized into a message.
    expect(/JSON\.stringify\((?:reply|form|page|row|rows|headers|cookie|secrets|configuration)\b/.test(driver)).toBe(false);

    const diagnostics = read("tests", "integration", "safe-diagnostics.ts");
    expect([...diagnostics.matchAll(/^import [^\n]* from "([^"]+)";$/gm)].map((match) => match[1])).toEqual(["node:util"]);
    expect(diagnostics).not.toMatch(DRIVER_IMPORT);
    expect(/process\.|node:fs|node:net|node:http|node:child_process|from "vitest"|console\./.test(diagnostics)).toBe(false);
  });

  it("the driver skips without its authorization, never retries a request, and leaves cluster work to the wrapper", () => {
    const driver = read("tests", "integration", "pg-app.integration.test.ts");
    expect(driver).toContain('describe.skipIf(inputs.kind !== "AUTHORIZED")');
    expect(driver).toContain('it.skipIf(inputs.kind !== "INVALID")');
    // One fixture and one cleanup; nothing provisions or stops a cluster, and nothing is removed by hand.
    expect([...driver.matchAll(/openDisposableDatabase\(\)/g)]).toHaveLength(1);
    expect([...driver.matchAll(/\.destroy\(\)/g)]).toHaveLength(1);
    expect(driver).not.toMatch(/initdb|pg_ctl|DROP |CREATE |ALTER |GRANT |REVOKE |TRUNCATE |DELETE FROM|UPDATE shopaccess|INSERT INTO/);
    expect(driver).not.toMatch(/\bretry\b|\bretries\b|for \(let attempt[^)]*\)\s*\{[^}]*post\(/);
    // The harness's own web pool is never used: every web-role backend observed is the application's.
    expect(driver).not.toMatch(/\.web\.query|connectWeb\(/);
  });
});

/**
 * Disclosure controls. Every value below is a synthetic sentinel, never a credential. A failing comparison is
 * provoked, everything a runner could print of it is captured, and the checks made on that text are booleans: an
 * outer assertion that fails here prints `true` or `false`, never the captured text.
 */
describe("diagnostics that cannot print a sensitive value", () => {
  const ACTUAL = "SENTINEL-ACTUAL-zQ4vN8rT2mK6pW1xY9bD3fH7jL5sG0cA";
  const EXPECTED = "SENTINEL-EXPECTED-uE2oI6aR9tP3nM7kV1wX5yB8dF4hJ0lS";
  const OTHER = "SENTINEL-OTHER-gC5qZ1eU8iO2aT6rP9nM3kW7vX4yB0dF";

  /** Everything of a thrown failure that a runner shows: name, message, stack, own properties, cause. Null when nothing was thrown. */
  const failureOf = (work: () => void): string | null => {
    try {
      work();
    } catch (error) {
      const failure = error as Error & { cause?: unknown; actual?: unknown; expected?: unknown };
      return [failure.name, failure.message, failure.stack ?? "", JSON.stringify(Object.entries(failure)), String(failure.cause ?? ""), String(failure.actual ?? ""), String(failure.expected ?? "")].join("\n");
    }
    return null;
  };
  const failed = (text: string | null): boolean => text !== null;
  const says = (text: string | null, part: string): boolean => text !== null && text.includes(part);
  const leaks = (text: string | null): boolean => says(text, ACTUAL) || says(text, EXPECTED) || says(text, OTHER);

  it("a fixed label is the whole of a boolean failure", () => {
    const text = failureOf(() => requireThat(false, "the page shows the confirmation form"));
    expect(failed(text)).toBe(true);
    expect(says(text, "SafeAssertionError")).toBe(true);
    expect(says(text, "the page shows the confirmation form")).toBe(true);
    expect(failed(failureOf(() => requireThat(true, "unused")))).toBe(false);
  });

  it("comparing two sensitive values fails with its context and neither value, and passes when they match", () => {
    const differ = failureOf(() => requireSameSecret(ACTUAL, EXPECTED, "the nonce after the restart"));
    expect(failed(differ)).toBe(true);
    expect(says(differ, "the nonce after the restart: the two values differ")).toBe(true);
    expect(leaks(differ)).toBe(false);
    expect(failed(failureOf(() => requireSameSecret(ACTUAL, ACTUAL, "same")))).toBe(false);

    const same = failureOf(() => requireDifferentSecret(ACTUAL, ACTUAL, "the two challenges"));
    expect(failed(same)).toBe(true);
    expect(says(same, "the two challenges: the two values are the same")).toBe(true);
    expect(leaks(same)).toBe(false);
    expect(failed(failureOf(() => requireDifferentSecret(ACTUAL, EXPECTED, "different")))).toBe(false);
  });

  it("comparing two forms names the fields that differ and prints no field value", () => {
    const before = { confirmationId: "cf_same", nonce: EXPECTED, quoteDigest: OTHER, quoteId: "qt_same" };
    const after = { confirmationId: "cf_same", nonce: ACTUAL, quoteDigest: OTHER, csrfToken: ACTUAL };
    expect(differingFields(after, before)).toEqual(["csrfToken", "nonce", "quoteId"]);
    const text = failureOf(() => requireSameFields(after, before, "the challenge's hidden fields after the restart"));
    expect(failed(text)).toBe(true);
    expect(says(text, "the challenge's hidden fields after the restart: 3 field(s) differ")).toBe(true);
    expect(says(text, '"nonce"') && says(text, '"csrfToken"') && says(text, '"quoteId"')).toBe(true);
    expect(says(text, '"quoteDigest"') || says(text, '"confirmationId"')).toBe(false);
    expect(leaks(text) || says(text, "cf_same") || says(text, "qt_same")).toBe(false);
    expect(failed(failureOf(() => requireSameFields({ ...before }, before, "equal")))).toBe(false);
  });

  it("full row content is compared, not row counts, and no row is printed", () => {
    const before = [`own_1|${EXPECTED}|QUOTED`, "own_2|unchanged|QUOTED", "own_2|unchanged|QUOTED"];
    const changed = [`own_1|${ACTUAL}|QUOTED`, "own_2|unchanged|QUOTED", "own_2|unchanged|QUOTED"];
    // The same number of rows, one of them different: a count alone would not see it.
    expect(rowDifference(before, changed)).toEqual({ removed: 1, added: 1 });
    const text = failureOf(() => requireSameRows(before, changed, "the canceled checkout's row"));
    expect(failed(text)).toBe(true);
    expect(says(text, "the canceled checkout's row: 1 row(s) no longer present and 1 row(s) new or changed")).toBe(true);
    expect(leaks(text) || says(text, "own_1") || says(text, "unchanged")).toBe(false);

    expect(failed(failureOf(() => requireSameRows(before, [...before].reverse(), "same rows, another order")))).toBe(false);
    // A duplicate row that is lost is a difference.
    expect(rowDifference(before, before.slice(0, 2))).toEqual({ removed: 1, added: 0 });
    expect(rowDifference([], [OTHER])).toEqual({ removed: 0, added: 1 });
    expect(failed(failureOf(() => requireSameRows(before, before.slice(0, 2), "a lost duplicate")))).toBe(true);
  });

  it("presence and absence in a response are reported without the response or the value sought", () => {
    const body = `<form><input name="nonce" value="${ACTUAL}"/></form> page text ${OTHER}`;
    const found = failureOf(() => requireAbsent(body, ACTUAL, "another owner's view: the nonce"));
    expect(failed(found)).toBe(true);
    expect(says(found, "another owner's view: the nonce: found")).toBe(true);
    expect(leaks(found) || says(found, "<form>")).toBe(false);

    const missing = failureOf(() => requireContains(body, EXPECTED, "the checkout list: a link to the checkout"));
    expect(failed(missing)).toBe(true);
    expect(says(missing, "the checkout list: a link to the checkout: not found")).toBe(true);
    expect(leaks(missing) || says(missing, "page text")).toBe(false);

    expect(failed(failureOf(() => requireContains(body, ACTUAL, "present")))).toBe(false);
    expect(failed(failureOf(() => requireAbsent(body, EXPECTED, "absent")))).toBe(false);
    // An empty expectation is a failure, not a match of everything.
    expect(failed(failureOf(() => requireContains(body, "", "an empty expectation")))).toBe(true);
  });

  it("safe values are shown, and a sensitive value that reaches a safe comparison is withheld", () => {
    const status = failureOf(() => requireSafeEqual({ status: 200, code: "NO_CODE" }, { status: 403, code: "FORBIDDEN" }, "no Origin, /checkout/start"));
    expect(failed(status)).toBe(true);
    expect(says(status, 'no Origin, /checkout/start: expected {status: 403, code: "FORBIDDEN"}, observed {status: 200, code: "NO_CODE"}')).toBe(true);

    const effects = failureOf(() => requireSafeEqual({ audit_events: { added: 2, removed: 0 } }, {}, "replay: rows changed, by table"));
    expect(says(effects, "expected {}, observed {audit_events: {added: 2, removed: 0}}")).toBe(true);

    // The safeguard behind the rule: a secret passed here by mistake still fails, and is not printed.
    const mistaken = failureOf(() => requireSafeEqual({ status: 303, location: `/checkout/x?token=${ACTUAL}` }, { status: 303, location: EXPECTED }, "a location"));
    expect(failed(mistaken)).toBe(true);
    expect(says(mistaken, "a location: expected {status: 303, location: [withheld]}, observed {status: 303, location: [withheld]}")).toBe(true);
    expect(leaks(mistaken)).toBe(false);

    expect(failed(failureOf(() => requireSafeEqual({ a: [1, "QUOTED"] }, { a: [1, "QUOTED"] }, "equal")))).toBe(false);
    expect(failed(failureOf(() => requireSafeEqual(1, "1", "types differ")))).toBe(true);
  });

  it("only codes, names, cookie attributes and local paths are ever shown", () => {
    const id = `ci_${"0123456789abcdef".repeat(2)}`;
    const shown: Array<[unknown, string]> = [
      [303, "303"],
      [true, "true"],
      [null, "null"],
      [undefined, "undefined"],
      ["QUOTED", '"QUOTED"'],
      ["audit_events", '"audit_events"'],
      ["SameSite=Lax", '"SameSite=Lax"'],
      ["Path=/", '"Path=/"'],
      ["/?session=ended", '"/?session=ended"'],
      ["/shop?use=schoolwork&budget=5000&started=1", '"/shop?use=schoolwork&budget=5000&started=1"'],
      [`/checkout/${id}?error=CONFIRMATION_ALREADY_USED`, '"/checkout/<ci>?error=CONFIRMATION_ALREADY_USED"'],
      [`/checkout/${id}/confirm`, '"/checkout/<ci>/confirm"'],
      [[200, "NOT_FOUND"], '[200, "NOT_FOUND"]'],
    ];
    expect(shown.filter(([value, text]) => safeText(value) !== text).length).toBe(0);

    const withheld: unknown[] = [
      ACTUAL,
      `1.${"aB3_".repeat(10)}xyz`, // a session cookie value
      `__Host-shopaccess_session=1.${"aB3_".repeat(10)}xyz`,
      "0123456789abcdef".repeat(4), // a digest
      "0123456789abcdef".repeat(2), // 32 hex digits
      `own_${"0123456789abcdef".repeat(2)}`, // an identifier alone
      "q83vEjRWeJASNFZ4kKvN7wEjRWeJq83vEjRWeJASNFY=", // a base64 key
      "postgres://user:pass@127.0.0.1:54537/shopaccess_disposable_x",
      `/checkout/${id}?nonce=${"aB3_".repeat(10)}xyz`, // a path that carries a token
      "/checkout/../etc",
      "two words",
      "x".repeat(200),
      Symbol("not printable"),
    ];
    expect(withheld.filter((value) => safeText(value) !== "[withheld]").length).toBe(0);
    expect(safeText({ state: "QUOTED", owner: `own_${"0123456789abcdef".repeat(2)}`, "odd key!": 1 })).toBe('{state: "QUOTED", owner: [withheld], [withheld]: 1}');
  });

  it("a response is scanned in its body and its headers, with Set-Cookie apart, and a finding holds no value", () => {
    const secrets: SecretEntry[] = [
      { category: "password", value: ACTUAL },
      { category: "owner id", value: EXPECTED },
      { category: "session cookie", value: OTHER },
    ];
    const reply = {
      body: `error: ${ACTUAL} and again ${ACTUAL}`,
      headers: {
        location: [`/checkout/x?o=${EXPECTED}`],
        "x-debug": ["harmless", `owner ${EXPECTED}`, `cookie ${OTHER}`],
        "set-cookie": [`__Host-s=${OTHER}; Path=/; Secure`, `leak=${ACTUAL}; Path=/`],
        "odd name!": [ACTUAL],
      },
    };
    const findings = scanReply(reply, secrets, ["session cookie"]);
    // Categories, header names and counts only: safe to compare as they are.
    expect(findings).toEqual([
      { surface: "body", header: null, category: "password", matches: 2 },
      { surface: "header", header: "location", category: "owner id", matches: 1 },
      { surface: "header", header: "x-debug", category: "owner id", matches: 1 },
      { surface: "header", header: "x-debug", category: "session cookie", matches: 1 },
      { surface: "set-cookie", header: "set-cookie", category: "password", matches: 1 },
      { surface: "header", header: "[withheld]", category: "password", matches: 1 },
    ]);
    const text = failureOf(() => requireNoFindings(findings, "secrets in 1 responses"));
    expect(failed(text)).toBe(true);
    expect(says(text, "secrets in 1 responses: ")).toBe(true);
    expect(says(text, "body: password x2") && says(text, "header x-debug: session cookie x1") && says(text, "set-cookie set-cookie: password x1")).toBe(true);
    expect(leaks(text) || says(text, "harmless") || says(text, "odd name")).toBe(false);
    expect(leaks(describeFindings(findings))).toBe(false);

    // The session cookie a response sets is expected in Set-Cookie, and only there.
    const clean = { body: "nothing", headers: { "set-cookie": [`__Host-s=${OTHER}; Path=/`], location: ["/"] } };
    expect(scanReply(clean, secrets, ["session cookie"])).toEqual([]);
    expect(scanReply(clean, secrets, []).map((finding) => finding.surface)).toEqual(["set-cookie"]);
    expect(failed(failureOf(() => requireNoFindings([], "clean")))).toBe(false);
    expect(describeFindings([{ surface: "body", header: null, category: `bad ${ACTUAL}`, matches: 1 }])).toBe("body: [withheld] x1");
  });

  it("a log is scanned by category and count, and a finding holds no value", () => {
    const secrets: SecretEntry[] = [
      { category: "confirmation nonce", value: ACTUAL },
      { category: "private key", value: EXPECTED },
      { category: "private key", value: OTHER },
      { category: "password", value: "" },
    ];
    const log = `line one ${ACTUAL}\nline two ${EXPECTED} ${OTHER} ${EXPECTED}\n`;
    expect(scanText(log, secrets)).toEqual([
      { category: "confirmation nonce", matches: 1 },
      { category: "private key", matches: 3 },
    ]);
    const text = failureOf(() => requireNoSecretsInText(log, secrets, "secrets in application log 2"));
    expect(failed(text)).toBe(true);
    expect(says(text, "secrets in application log 2: confirmation nonce x1; private key x3")).toBe(true);
    expect(leaks(text) || says(text, "line one")).toBe(false);
    expect(failed(failureOf(() => requireNoSecretsInText("an ordinary line\n", secrets, "clean log")))).toBe(false);
  });

  const UNKNOWN_MESSAGE = (operation: string): string => `${operation}: unexpected failure [category=UNKNOWN code=NONE] (error text withheld)`;
  /** A redacted failure as a runner would show it, and whether it carries anything but its own name. */
  const shown = (error: unknown, operation: string): { text: string | null; bare: boolean; message: string } => {
    const safe = redactedFailure(error, operation);
    const text = failureOf(() => {
      throw safe;
    });
    const bare = safe instanceof SafeAssertionError && Object.keys(safe).join(",") === "name" && !("cause" in safe) && !("errors" in safe) && !("code" in safe);
    return { text, bare, message: safe.message };
  };

  it("an unexpected failure is a label and a class: no message, name, code, cause or property of the error is forwarded", () => {
    // 1. A secret that was never registered anywhere and is not hex, in the message.
    const unregistered = shown(new Error(`boom near ${ACTUAL}`), "fixture setup");
    expect(unregistered.message === UNKNOWN_MESSAGE("fixture setup")).toBe(true);
    expect(leaks(unregistered.text) || says(unregistered.text, "boom")).toBe(false);
    expect(unregistered.bare).toBe(true);

    // 2. A spoofed name and a spoofed code. A name is never read, and a code must be a listed string exactly.
    const spoofed = shown(Object.assign(new Error("m"), { name: `TypeError ${ACTUAL}`, code: `ECONNREFUSED ${EXPECTED}` }), "a case");
    expect(spoofed.message === UNKNOWN_MESSAGE("a case")).toBe(true);
    expect(leaks(spoofed.text) || !spoofed.bare).toBe(false);
    const named = shown(Object.assign(new Error("m"), { name: "TypeError" }), "a case");
    expect(named.message === UNKNOWN_MESSAGE("a case")).toBe(true);

    // 3. A recognized code with a secret in the message: the code is reported, the message is not.
    const recognized = shown(Object.assign(new Error(`connect failed for ${ACTUAL}`), { code: "ECONNREFUSED" }), "readiness");
    expect(recognized.message === "readiness: unexpected failure [category=NETWORK code=ECONNREFUSED] (error text withheld)").toBe(true);
    expect(leaks(recognized.text) || says(recognized.text, "connect failed") || !recognized.bare).toBe(false);

    // 4. Codes that are not listed, however much they look like one, are the fixed fallback.
    const unlisted: unknown[] = ["E_CUSTOM", "econnrefused", "ECONNREFUSED ", " ECONNREFUSED", "42P01", "ECONNREFUSED\n", `EIO${ACTUAL}`, 42, null, { toString: () => "EIO" }, ["EIO"]];
    expect(unlisted.filter((code) => redactedFailure(Object.assign(new Error(ACTUAL), { code }), "c").message !== UNKNOWN_MESSAGE("c")).length).toBe(0);

    // 5. An aggregate that holds several unregistered secrets: its size, and nothing it holds.
    const aggregate = shown(new AggregateError([new Error(ACTUAL), Object.assign(new Error(EXPECTED), { code: "ECONNRESET" }), OTHER], `several failures ${OTHER}`), "cleanup");
    expect(aggregate.message === "cleanup: unexpected failure [category=AGGREGATE code=NONE errors=3] (error text withheld)").toBe(true);
    expect(leaks(aggregate.text) || says(aggregate.text, "several failures") || says(aggregate.text, "ECONNRESET") || !aggregate.bare).toBe(false);

    // 6. A cause and custom properties.
    const withCause = shown(Object.assign(new Error("outer", { cause: new Error(ACTUAL) }), { detail: EXPECTED, response: { body: OTHER, headers: { cookie: ACTUAL } } }), "restart");
    expect(withCause.message === UNKNOWN_MESSAGE("restart")).toBe(true);
    expect(leaks(withCause.text) || says(withCause.text, "outer") || !withCause.bare).toBe(false);

    // Built-in error types are a category; their text, which can quote input, is still not forwarded.
    let parseError: unknown = null;
    try {
      JSON.parse(`{"nonce": ${ACTUAL}`);
    } catch (error) {
      parseError = error;
    }
    const parsed = shown(parseError, "a response");
    expect(parsed.message === "a response: unexpected failure [category=PROGRAMMING code=NONE] (error text withheld)").toBe(true);
    expect(leaks(parsed.text)).toBe(false);

    // Values that are not errors, and an error whose properties cannot be read.
    const hostile = { get code(): string { throw new Error(ACTUAL); } };
    expect([ACTUAL, null, undefined, 7, { message: ACTUAL }, hostile].filter((value) => redactedFailure(value, "c").message !== UNKNOWN_MESSAGE("c")).length).toBe(0);

    // A failure this module made is passed through unchanged.
    const assertion = new SafeAssertionError("a label");
    expect(redactedFailure(assertion, "elsewhere") === assertion).toBe(true);

    // The label is the caller's fixed text. A label that could be a value is replaced, not printed.
    const mislabelled = shown(new Error("x"), `case ${ACTUAL}`);
    expect(mislabelled.message === UNKNOWN_MESSAGE("unlabelled operation")).toBe(true);
    expect(leaks(mislabelled.text)).toBe(false);
    expect([`case ${ACTUAL}`, "0123456789abcdef", "line\nbreak", "", "x".repeat(81), "semi;colon", 7, null].filter((label) => safeLabel(label) !== "unlabelled operation").length).toBe(0);
    expect(["fixture setup", "stop application 2 and close its log", "destroy the disposable database fixture (harness cleanup)", "no Origin"].filter((label) => safeLabel(label) !== label).length).toBe(0);
  });

  it("the wrapper rethrows by class and returns a result untouched", async () => {
    const rejected = await withRedactedFailures("a case", async () => {
      throw new Error(`parse failure near ${EXPECTED}`);
    }).catch((caught: unknown) => caught);
    expect(rejected instanceof SafeAssertionError).toBe(true);
    expect((rejected as Error).message === UNKNOWN_MESSAGE("a case")).toBe(true);
    expect(leaks(failureOf(() => {
      throw rejected;
    }))).toBe(false);
    const coded = await withRedactedFailures("fixture setup", async () => {
      throw new CodedFailure("ADMIN_URL_MALFORMED");
    }).catch((caught: unknown) => caught);
    expect((coded as Error).message === "fixture setup: unexpected failure [category=DATABASE_TARGET code=ADMIN_URL_MALFORMED] (error text withheld)").toBe(true);
    expect(await withRedactedFailures("a case", async () => 7)).toBe(7);
  });

  it("the categories and the codes are closed lists, matched exactly", () => {
    expect(FAILURE_CATEGORIES).toEqual(["ASSERTION", "REQUEST", "STARTUP", "CLEANUP", "DATABASE_TARGET", "NETWORK", "FILESYSTEM", "DATABASE", "PROGRAMMING", "AGGREGATE", "UNKNOWN"]);
    expect(FAILURE_CODES.size).toBe(49);
    const byCategory: Record<string, number> = {};
    for (const category of FAILURE_CODES.values()) byCategory[category] = (byCategory[category] ?? 0) + 1;
    expect(byCategory).toEqual({ REQUEST: 3, STARTUP: 6, CLEANUP: 6, DATABASE_TARGET: 10, NETWORK: 5, FILESYSTEM: 9, DATABASE: 10 });
    // Every listed code is reported with its category, on any object that carries it.
    expect([...FAILURE_CODES.entries()].filter(([code, category]) => {
      const seen = classifyFailure(Object.assign(new Error(ACTUAL), { code }));
      return seen.category !== category || seen.code !== code || seen.members !== 0;
    }).length).toBe(0);
    expect(classifyFailure(new TypeError(ACTUAL))).toEqual({ category: "PROGRAMMING", code: null, members: 0 });
    expect(classifyFailure(new SafeAssertionError("x"))).toEqual({ category: "ASSERTION", code: null, members: 0 });
    // A class that did not come from the classifier is still written from the lists only.
    expect(describeFailureClass({ category: ACTUAL as never, code: EXPECTED, members: 2.5 })).toBe("category=UNKNOWN code=NONE");
    expect(describeFailureClass({ category: "NETWORK", code: "ECONNRESET", members: 0 })).toBe("category=NETWORK code=ECONNRESET");

    // A coded failure keeps a listed code and numeric or boolean facts, and nothing else.
    const coded = new CodedFailure("REQUESTS_OUTSTANDING", { outstanding: 2, note: ACTUAL, nested: { value: EXPECTED } } as unknown as Record<string, number>);
    expect({ message: coded.message, code: coded.code, facts: coded.facts }).toEqual({ message: "REQUESTS_OUTSTANDING", code: "REQUESTS_OUTSTANDING", facts: { outstanding: 2 } });
    const unlisted = new CodedFailure(`CODE ${ACTUAL}`);
    expect(unlisted.message === "unlisted code" && unlisted.code === "UNLISTED").toBe(true);
    expect(classifyFailure(unlisted)).toEqual({ category: "UNKNOWN", code: null, members: 0 });
    // A raised failure is recognized by identity, with the facts recorded when it was raised.
    expect(trustedFailure(coded)).toEqual({ code: "REQUESTS_OUTSTANDING", facts: { outstanding: 2 }, dropped: 2 });
    expect(trustedFailure(unlisted)).toEqual({ code: null, facts: {}, dropped: 0 });
    expect(trustedFailure(new Error("x")) === null && trustedFailure(ACTUAL) === null && trustedFailure(null) === null).toBe(true);
    expect(safeFacts(ACTUAL)).toEqual({});
  });

  const SHORT_NAME = "Zx9Qw";
  const SHORT_KEY = "kT7mP";
  const leaksShort = (text: string | null): boolean => leaks(text) || says(text, SHORT_NAME) || says(text, SHORT_KEY);
  /** One step result as safe text: a listed name or the placeholder, listed words, counts and listed facts. */
  const line = (step: { name: string; ok: boolean; category: string | null; code: string | null; errors: number; facts: object; droppedFacts: number }): string =>
    `${step.name}|${step.ok}|${step.category}|${step.code}|${step.errors}|${JSON.stringify(step.facts)}|${step.droppedFacts}`;

  /** Steps that fail in every way an exception can carry text, with a step after them that must still run. */
  const hostileCleanup = async () => {
    const ran: string[] = [];
    const step = (name: string, error: unknown) => ({
      name,
      run: async () => {
        ran.push("failing");
        throw error;
      },
    });
    const result = await runCleanup([
      step(STEP_REQUESTS, new Error(`could not stop; url ${ACTUAL}`)),
      step(STEP_APP_1, Object.assign(new Error("m"), { name: `Error ${ACTUAL}`, code: `EIO ${EXPECTED}` })),
      step(STEP_APP_2, Object.assign(new Error(`write failed ${ACTUAL}`), { code: "ENOSPC" })),
      step(STEP_APP_3, new AggregateError([new Error(ACTUAL), new Error(EXPECTED), new Error(OTHER)], `incomplete ${ACTUAL}`)),
      step(STEP_FIXTURE, Object.assign(new Error("outer", { cause: new Error(EXPECTED) }), { detail: OTHER, rows: [ACTUAL] })),
      step(STEP_APP_1, new CodedFailure(`CODE ${ACTUAL}`, { stopped: false, leak: EXPECTED } as unknown as Record<string, number>)),
      step(`name ${OTHER}`, new Error("x")),
      step(SHORT_NAME, new Error("x")),
      {
        name: STEP_FIXTURE,
        run: async () => {
          ran.push("last");
        },
      },
    ]);
    return { ran, result };
  };

  it("cleanup continues after such failures, and neither its result nor its JSON holds any error text", async () => {
    const { ran, result } = await hostileCleanup();
    expect(ran.length).toBe(9);
    expect(ran[8] === "last").toBe(true);
    expect(result.complete).toBe(false);
    // Each failed step apart, by class. These lines are listed names, listed categories and codes, and counts.
    expect(result.steps.map(line)).toEqual([
      `${STEP_REQUESTS}|false|UNKNOWN|null|0|{}|0`,
      `${STEP_APP_1}|false|UNKNOWN|null|0|{}|0`,
      `${STEP_APP_2}|false|FILESYSTEM|ENOSPC|0|{}|0`,
      `${STEP_APP_3}|false|AGGREGATE|null|3|{}|0`,
      `${STEP_FIXTURE}|false|UNKNOWN|null|0|{}|0`,
      `${STEP_APP_1}|false|UNKNOWN|null|0|{"stopped":false}|1`,
      `${UNLISTED_STEP}|false|UNKNOWN|null|0|{}|0`,
      `${UNLISTED_STEP}|false|UNKNOWN|null|0|{}|0`,
      `${STEP_FIXTURE}|true|null|null|0|{}|0`,
    ]);
    const serialized = serializeCleanupResult(result);
    expect(leaksShort(JSON.stringify(result)) || leaksShort(serialized)).toBe(false);
    expect(/could not stop|write failed|incomplete|outer|stack|message|cause/.test(serialized)).toBe(false);
    // Exactly the fixed shape, for every step.
    const parsed = JSON.parse(serialized) as { complete: boolean; steps: Array<Record<string, unknown>> };
    expect(parsed.complete).toBe(false);
    expect(parsed.steps.filter((step) => Object.keys(step).join(",") !== "name,ok,category,code,errors,facts,droppedFacts").length).toBe(0);
    expect(Object.keys(parsed).join(",")).toBe("complete,unreadable,steps");
    // What runCleanup returns is already the projection: serializing changes nothing.
    expect(projectCleanupResult(result)).toEqual(result);
  });

  it("a thrown value that is hostile to inspection is UNKNOWN with no facts, and the steps after it still run", async () => {
    const trap = (): never => {
      throw new Error(`trap ${ACTUAL}`);
    };
    // Looking at its prototype, reading any property or listing its keys throws.
    const hostile = new Proxy({}, { getPrototypeOf: trap, get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    // Looks like a failure the driver raised, and was not: its facts are a getter that throws.
    const forged = Object.create(CodedFailure.prototype, {
      code: { value: "APPLICATION_NOT_STOPPED", enumerable: true },
      facts: {
        enumerable: true,
        get: () => {
          throw new Error(`facts ${EXPECTED}`);
        },
      },
    }) as unknown;

    const ran: string[] = [];
    const result = await runCleanup([
      {
        name: STEP_APP_1,
        run: async () => {
          ran.push("a");
          throw hostile;
        },
      },
      {
        name: STEP_APP_2,
        run: async () => {
          ran.push("b");
          throw forged;
        },
      },
      {
        name: STEP_FIXTURE,
        run: async () => {
          ran.push("c");
        },
      },
    ]);
    expect(ran.join("")).toBe("abc");
    // The forged object's own code is a listed word, so it may be named; its facts were never read.
    expect(result.steps.map(line)).toEqual([`${STEP_APP_1}|false|UNKNOWN|null|0|{}|0`, `${STEP_APP_2}|false|CLEANUP|APPLICATION_NOT_STOPPED|0|{}|0`, `${STEP_FIXTURE}|true|null|null|0|{}|0`]);
    const serialized = serializeCleanupResult(result);
    expect(leaks(JSON.stringify(result)) || leaks(serialized) || says(serialized, "trap") || says(serialized, "facts ")).toBe(false);

    // Neither is recognized as something this code made, and asking does not run their traps.
    expect(isSafeAssertion(hostile) || isSafeAssertion(forged) || trustedFailure(hostile) !== null || trustedFailure(forged) !== null).toBe(false);
    expect(classifyFailure(hostile)).toEqual({ category: "UNKNOWN", code: null, members: 0 });

    // The runner-facing paths do not throw either, and carry nothing of the trap.
    const redacted = redactedFailure(hostile, "cleanup");
    expect(redacted.message === UNKNOWN_MESSAGE("cleanup")).toBe(true);
    const rejected = await withRedactedFailures("a case", async () => {
      throw hostile;
    }).catch((caught: unknown) => caught);
    expect(isSafeAssertion(rejected) && (rejected as Error).message === UNKNOWN_MESSAGE("a case")).toBe(true);
    expect(describeStartupFailure(hostile)).toBe("application start failed [category=UNKNOWN code=NONE]; no process had been started");
    expect(leaks(failureOf(() => {
      throw redacted;
    })) || leaks(failureOf(() => {
      throw rejected;
    }))).toBe(false);
    const written = recordCleanupResult(hostile, () => undefined);
    expect(written).toEqual({ written: true, failure: null });
  });

  it("a forged cleanup result is written from the exact lists only, and an unreadable one as a fixed failure", () => {
    const trap = (): never => {
      throw new Error(`trap ${ACTUAL}`);
    };
    const forged = {
      complete: true,
      unreadable: false,
      [SHORT_KEY]: 1,
      steps: [
        // A short sensitive word as the step name and as fact keys; an unknown category and code.
        { name: SHORT_NAME, ok: false, category: SHORT_NAME, code: SHORT_KEY, errors: 2, facts: { [SHORT_KEY]: 1, [SHORT_NAME]: true, stopped: "yes", aborted: 1e9, portFree: true, stopAttempts: 2 }, droppedFacts: 1, [SHORT_KEY]: SHORT_NAME },
        // A success cannot carry a category or a code.
        { name: STEP_APP_1, ok: true, category: "NETWORK", code: "ECONNRESET", errors: -1, facts: null },
        // A getter, a proxy, and a getter inside the facts.
        {
          get name(): string {
            throw new Error(ACTUAL);
          },
          ok: true,
        },
        new Proxy({}, { getOwnPropertyDescriptor: trap, get: trap }),
        {
          name: STEP_FIXTURE,
          ok: false,
          category: "CLEANUP",
          code: "PROCESS_REMAINING",
          errors: 0,
          facts: {
            get processRemaining(): boolean {
              throw new Error(EXPECTED);
            },
          },
        },
      ],
    };
    const written = serializeCleanupResult(forged);
    expect(leaksShort(written) || says(written, "trap") || says(written, "ECONNRESET") || says(written, "NETWORK")).toBe(false);
    const unreadableStep = { name: UNLISTED_STEP, ok: false, category: "CLEANUP", code: "CLEANUP_RESULT_UNREADABLE", errors: 0, facts: {}, droppedFacts: 0 };
    expect(JSON.parse(written)).toEqual({
      complete: false,
      unreadable: true,
      steps: [
        { name: UNLISTED_STEP, ok: false, category: "UNKNOWN", code: null, errors: 2, facts: { portFree: true, stopAttempts: 2 }, droppedFacts: 5 },
        { name: STEP_APP_1, ok: true, category: null, code: null, errors: 0, facts: {}, droppedFacts: 0 },
        unreadableStep,
        unreadableStep,
        { name: STEP_FIXTURE, ok: false, category: "CLEANUP", code: "PROCESS_REMAINING", errors: 0, facts: {}, droppedFacts: 0 },
      ],
    });
    const described = describeCleanup(forged, { written: true, failure: null });
    expect(leaksShort(described)).toBe(false);
    expect(described.includes("THE RESULT COULD NOT BE READ IN FULL.") && described.includes("Steps reporting a process that remains: 1.") && described.includes(`${STEP_FIXTURE} [category=CLEANUP code=PROCESS_REMAINING]`)).toBe(true);

    // A result that cannot be examined at all is one fixed text, whatever it was.
    const unreadable = '{\n  "complete": false,\n  "unreadable": true,\n  "steps": []\n}\n';
    const whole: unknown[] = [
      new Proxy({}, { getOwnPropertyDescriptor: trap, get: trap, ownKeys: trap }),
      { steps: new Proxy([], { getOwnPropertyDescriptor: trap, get: trap }) },
      {
        get steps(): never {
          throw new Error(ACTUAL);
        },
      },
      { steps: SHORT_NAME },
      {},
      null,
      undefined,
      SHORT_NAME,
      7,
    ];
    expect(whole.filter((value) => serializeCleanupResult(value) !== unreadable).length).toBe(0);
    // More steps than the lifecycle has: the first sixteen, and marked unreadable.
    const many = projectCleanupResult({ steps: Array.from({ length: 17 }, () => ({ name: STEP_FIXTURE, ok: true })) });
    expect({ complete: many.complete, unreadable: many.unreadable, steps: many.steps.length }).toEqual({ complete: false, unreadable: true, steps: 16 });

    // The lists themselves, and the two functions that apply them.
    expect(CLEANUP_STEP_NAMES).toEqual([
      "abort and settle outstanding requests",
      "stop application 1 and close its log",
      "stop application 2 and close its log",
      "stop application 3 and close its log",
      "destroy the disposable database fixture (harness cleanup)",
    ]);
    expect(CLEANUP_BOOLEAN_FACTS).toEqual(["stopped", "processRemaining", "portFree", "processRemainedAfterEarlierAttempt"]);
    expect(CLEANUP_COUNT_FACTS).toEqual(["aborted", "outstanding", "signalsSent", "logFailures", "problems", "stopAttempts", "failedStopAttempts"]);
    expect(CLEANUP_STEP_NAMES.filter((name) => cleanupStepName(name) !== name).length).toBe(0);
    expect([SHORT_NAME, `${STEP_APP_1} `, "stop application 4 and close its log", "", 7, null, undefined, { toString: () => STEP_APP_1 }].filter((name) => cleanupStepName(name) !== UNLISTED_STEP).length).toBe(0);
    expect(inspectFacts({ stopped: true, aborted: 3, portFree: 1, problems: true, signalsSent: -1, logFailures: 1.5, outstanding: 1_000_001, [SHORT_KEY]: 1, text: ACTUAL })).toEqual({ facts: { stopped: true, aborted: 3 }, dropped: 7 });
    expect(inspectFacts(new Proxy({}, { getOwnPropertyDescriptor: trap }))).toEqual({ facts: {}, dropped: 0 });
  });

  it("a writer of the cleanup result that fails is reported by class, stays visible, and prints nothing of its error", async () => {
    const { result } = await hostileCleanup();

    const texts: string[] = [];
    const stored = recordCleanupResult(result, (text) => void texts.push(text));
    expect(stored).toEqual({ written: true, failure: null });
    expect(texts.length === 1 && texts[0] === serializeCleanupResult(result)).toBe(true);

    const exists = recordCleanupResult(result, () => {
      throw Object.assign(new Error(`EEXIST: file already exists, open '/private/${ACTUAL}/cleanup-result.json'`), { code: "EEXIST", path: `/private/${ACTUAL}` });
    });
    expect(exists).toEqual({ written: false, failure: { category: "FILESYSTEM", code: "EEXIST", members: 0 } });
    const unknown = recordCleanupResult(result, () => {
      throw new Error(`disk on fire ${EXPECTED}`);
    });
    expect(unknown).toEqual({ written: false, failure: { category: "UNKNOWN", code: null, members: 0 } });
    expect(leaks(JSON.stringify(exists)) || leaks(JSON.stringify(unknown))).toBe(false);

    // What the driver puts in its one visible line.
    const visible = describeCleanup(result, exists);
    expect(visible.endsWith("Result file: NOT WRITTEN [category=FILESYSTEM code=EEXIST].")).toBe(true);
    expect(visible.includes(`${STEP_APP_2} [category=FILESYSTEM code=ENOSPC]`) && visible.includes(`${STEP_APP_3} [category=AGGREGATE code=NONE errors=3]`) && visible.includes(`${STEP_REQUESTS} [category=UNKNOWN code=NONE]`)).toBe(true);
    expect(leaksShort(visible) || leaksShort(describeCleanup(result, unknown))).toBe(false);
    expect(describeCleanup(result, unknown).endsWith("Result file: NOT WRITTEN [category=UNKNOWN code=NONE].")).toBe(true);

    const clean = await runCleanup([{ name: STEP_REQUESTS, run: () => ({ aborted: 0 }) }]);
    expect(describeCleanup(clean, recordCleanupResult(clean, () => undefined))).toBe("Failed steps: none. Steps reporting a process that remains: 0. Result file: written.");
  });

  /**
   * A start that fails at the deadline with a process that survives SIGTERM and SIGKILL. The handle is taken by the
   * owner when the process is spawned; nothing here is a real process, port or request.
   */
  const failedStart = async () => {
    const owned: ApplicationHandle[] = [];
    let ownedAtFirstAttempt = -1;
    const app = fake({
      dies: [],
      probe: (_signal, attempt) => {
        if (attempt === 1) ownedAtFirstAttempt = owned.length;
        return never();
      },
    });
    const outcome = startApplication(app.deps, SPEC, { onSpawned: (handle) => void owned.push(handle) }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(STARTUP_DEADLINE_MS + 2 * STOP_GRACE_MS + 200);
    const error = (await outcome) as StartupError;
    return { app, owned, error, ownedAtFirstAttempt: () => ownedAtFirstAttempt };
  };
  const lastStep = (ran: string[]) => ({
    name: STEP_FIXTURE,
    run: async () => {
      ran.push("fixture");
    },
  });

  it("a process spawned by a start that fails is owned from the spawn; final cleanup tries again and can stop it", async () => {
    const { app, owned, error, ownedAtFirstAttempt } = await failedStart();
    // Owned before the first readiness attempt, so before anything about startup could fail.
    expect({ owned: owned.length, atFirstAttempt: ownedAtFirstAttempt() }).toEqual({ owned: 1, atFirstAttempt: 1 });
    // The startup code is kept, and the first shutdown is reported as it went. The error carries no handle.
    expect(error instanceof StartupError && error.code === "STARTUP_DEADLINE").toBe(true);
    expect(Object.keys(error).sort()).toEqual(["code", "name", "stop"]);
    expect(error.stop).toMatchObject({ stopped: false, processRemaining: true, portFree: false, signals: ["SIGTERM", "SIGKILL"] });
    expect(describeStartupFailure(error)).toBe(
      "application start failed [category=STARTUP code=STARTUP_DEADLINE]; THE SHUTDOWN AFTER THE FAILURE WAS NOT CLEAN (processRemaining=true portFree=false); the process stays owned and final cleanup will try once more",
    );
    expect(redactedFailure(error, "fixture setup").message).toBe("fixture setup: unexpected failure [category=STARTUP code=STARTUP_DEADLINE] (error text withheld)");
    expect(owned[0].stopAttempts().length).toBe(1);

    // Final cleanup: the unsuccessful stop was not kept as the answer. This time SIGKILL works.
    app.state.dies = ["SIGKILL"];
    const ran: string[] = [];
    const cleaning = runCleanup([applicationCleanupStep(owned[0], STEP_APP_1), lastStep(ran)]);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 200);
    const result = await cleaning;
    expect(app.state.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
    expect(result).toEqual({
      complete: true,
      unreadable: false,
      steps: [
        {
          name: STEP_APP_1,
          ok: true,
          category: null,
          code: null,
          errors: 0,
          // Both attempts are in the record: two made, one of them unsuccessful, four signals in all.
          facts: { stopped: true, processRemaining: false, portFree: true, processRemainedAfterEarlierAttempt: true, signalsSent: 4, logFailures: 0, problems: 0, stopAttempts: 2, failedStopAttempts: 1 },
          droppedFacts: 0,
        },
        { name: STEP_FIXTURE, ok: true, category: null, code: null, errors: 0, facts: {}, droppedFacts: 0 },
      ],
    });
    expect(ran).toEqual(["fixture"]);
    expect(owned[0].stopAttempts().map((attempt) => `${attempt.stopped}:${attempt.processRemaining}:${attempt.signals.join("+")}`)).toEqual(["false:true:SIGTERM+SIGKILL", "true:false:SIGTERM+SIGKILL"]);
    expect(describeCleanup(result, { written: true, failure: null })).toBe("Failed steps: none. Steps reporting a process that remains: 0. Result file: written.");

    // A clean stop is final: asking again signals nothing, makes no further attempt and closes the log no second time.
    const again = await owned[0].stop();
    expect({ stopped: again.stopped, attempts: owned[0].stopAttempts().length, signals: app.state.signals.length, logClosed: app.state.logClosed }).toEqual({ stopped: true, attempts: 2, signals: 4, logClosed: 1 });
  });

  it("a process that survives final cleanup too is an explicit cleanup failure, and only its own group was signalled", async () => {
    const { app, owned, error } = await failedStart();
    expect(error.stop?.processRemaining).toBe(true);

    const ran: string[] = [];
    const cleaning = runCleanup([applicationCleanupStep(owned[0], STEP_APP_1), lastStep(ran)]);
    await vi.advanceTimersByTimeAsync(2 * STOP_GRACE_MS + 200);
    const result = await cleaning;
    // The later step still ran, and the result cannot be read as complete.
    expect(ran).toEqual(["fixture"]);
    expect(result.complete).toBe(false);
    expect(result.steps[0]).toEqual({
      name: STEP_APP_1,
      ok: false,
      category: "CLEANUP",
      code: "PROCESS_REMAINING",
      errors: 0,
      facts: { stopped: false, processRemaining: true, portFree: false, processRemainedAfterEarlierAttempt: true, signalsSent: 4, logFailures: 0, problems: 0, stopAttempts: 2, failedStopAttempts: 2 },
      droppedFacts: 0,
    });
    const parsed = JSON.parse(serializeCleanupResult(result)) as { complete: boolean; steps: Array<{ code: string | null; facts: Record<string, unknown> }> };
    expect({ complete: parsed.complete, code: parsed.steps[0].code, remaining: parsed.steps[0].facts.processRemaining }).toEqual({ complete: false, code: "PROCESS_REMAINING", remaining: true });
    expect(describeCleanup(result, { written: true, failure: null })).toBe(`Failed steps: ${STEP_APP_1} [category=CLEANUP code=PROCESS_REMAINING]. Steps reporting a process that remains: 1. Result file: written.`);

    // Still not cached: a further call is a further bounded attempt.
    const further = owned[0].stop();
    await vi.advanceTimersByTimeAsync(2 * STOP_GRACE_MS + 200);
    expect((await further).processRemaining).toBe(true);
    expect({ attempts: owned[0].stopAttempts().length, signals: app.state.signals.length }).toEqual({ attempts: 3, signals: 6 });

    // A port that stays in use after the owned group is gone is reported, and nothing is signalled on its account.
    const busy = fake({ portStaysBusy: true });
    const handle = await startApplication(busy.deps, SPEC);
    const first = await handle.stop();
    const second = await handle.stop();
    expect({ first: `${first.stopped}:${first.processRemaining}:${first.portFree}`, second: `${second.stopped}:${second.processRemaining}:${second.portFree}`, attempts: handle.stopAttempts().length, signals: busy.state.signals }).toEqual({
      first: "false:false:false",
      second: "false:false:false",
      attempts: 2,
      signals: ["SIGTERM"],
    });
    const portResult = await runCleanup([applicationCleanupStep(handle, STEP_APP_2)]);
    expect(line(portResult.steps[0])).toBe(`${STEP_APP_2}|false|CLEANUP|APPLICATION_NOT_STOPPED|0|${JSON.stringify(portResult.steps[0].facts)}|0`);
    expect({ remaining: portResult.steps[0].facts.processRemaining, attempts: portResult.steps[0].facts.stopAttempts, signalsSent: portResult.steps[0].facts.signalsSent }).toEqual({ remaining: false, attempts: 3, signalsSent: 1 });
  });

  /**
   * A start whose registration callback throws before it keeps the handle, with a process that survives SIGTERM and
   * SIGKILL. The caller's own list stays empty; only the owner holds the handle.
   */
  const refusedRegistration = async () => {
    const owner = createApplicationOwner();
    const callerList: ApplicationHandle[] = [];
    const app = fake({ dies: [], probe: never });
    const outcome = startApplication(app.deps, SPEC, {
      owner,
      onSpawned: (handle) => {
        if (handle.pid !== undefined) throw Object.assign(new Error(`cannot register ${ACTUAL}`), { detail: EXPECTED, code: `REG ${OTHER}` });
        callerList.push(handle);
      },
    }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(2 * STOP_GRACE_MS + 200);
    const error = (await outcome) as StartupError;
    return { app, owner, callerList, error };
  };

  it("a registration callback that throws does not lose the process: the owner holds it, and final cleanup stops it", async () => {
    const { app, owner, callerList, error } = await refusedRegistration();
    // The start was abandoned without a readiness attempt, and its one shutdown attempt did not work.
    expect(error instanceof StartupError && error.code === "STARTUP_CANCELLED").toBe(true);
    expect({ spawned: app.state.spawned, probes: app.state.probes, callerList: callerList.length, retained: owner.owned().length }).toEqual({ spawned: 1, probes: 0, callerList: 0, retained: 1 });
    expect(error.stop).toMatchObject({ stopped: false, processRemaining: true, signals: ["SIGTERM", "SIGKILL"] });
    // Nothing of what the callback threw is anywhere a runner or a file could show it.
    const startupLine = describeStartupFailure(error);
    expect(startupLine).toBe(
      "application start failed [category=STARTUP code=STARTUP_CANCELLED]; THE SHUTDOWN AFTER THE FAILURE WAS NOT CLEAN (processRemaining=true portFree=false); the process stays owned and final cleanup will try once more",
    );
    expect(leaks(failureOf(() => {
      throw error;
    })) || leaks(JSON.stringify(error.stop)) || leaks(redactedFailure(error, "fixture setup").message) || says(startupLine, "cannot register")).toBe(false);
    expect(Object.keys(error).sort()).toEqual(["code", "name", "stop"]);

    // Final cleanup takes its handles from the owner, not from the list the callback failed to fill.
    const handles = uniqueHandles(owner.owned(), callerList);
    expect(handles.length).toBe(1);
    app.state.dies = ["SIGKILL"];
    const ran: string[] = [];
    const cleaning = runCleanup([...handles.map((handle, index) => applicationCleanupStep(handle, CLEANUP_STEP_NAMES[index + 1])), lastStep(ran)]);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 200);
    const result = await cleaning;
    expect(result).toEqual({
      complete: true,
      unreadable: false,
      steps: [
        {
          name: STEP_APP_1,
          ok: true,
          category: null,
          code: null,
          errors: 0,
          facts: { stopped: true, processRemaining: false, portFree: true, processRemainedAfterEarlierAttempt: true, signalsSent: 4, logFailures: 0, problems: 0, stopAttempts: 2, failedStopAttempts: 1 },
          droppedFacts: 0,
        },
        { name: STEP_FIXTURE, ok: true, category: null, code: null, errors: 0, facts: {}, droppedFacts: 0 },
      ],
    });
    expect(app.state.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
    expect(leaks(serializeCleanupResult(result)) || says(serializeCleanupResult(result), "cannot register")).toBe(false);
  });

  it("when that process survives final cleanup as well, cleanup is incomplete and says PROCESS_REMAINING", async () => {
    const { app, owner, callerList, error } = await refusedRegistration();
    expect(error.stop?.processRemaining === true && callerList.length === 0).toBe(true);

    const ran: string[] = [];
    const cleaning = runCleanup([...uniqueHandles(owner.owned(), callerList).map((handle, index) => applicationCleanupStep(handle, CLEANUP_STEP_NAMES[index + 1])), lastStep(ran)]);
    await vi.advanceTimersByTimeAsync(2 * STOP_GRACE_MS + 200);
    const result = await cleaning;
    expect(ran).toEqual(["fixture"]);
    expect({ complete: result.complete, steps: result.steps.length }).toEqual({ complete: false, steps: 2 });
    expect(result.steps[0]).toEqual({
      name: STEP_APP_1,
      ok: false,
      category: "CLEANUP",
      code: "PROCESS_REMAINING",
      errors: 0,
      facts: { stopped: false, processRemaining: true, portFree: false, processRemainedAfterEarlierAttempt: true, signalsSent: 4, logFailures: 0, problems: 0, stopAttempts: 2, failedStopAttempts: 2 },
      droppedFacts: 0,
    });
    const serialized = serializeCleanupResult(result);
    expect((JSON.parse(serialized) as { complete: boolean }).complete).toBe(false);
    expect(describeCleanup(result, { written: true, failure: null })).toBe(`Failed steps: ${STEP_APP_1} [category=CLEANUP code=PROCESS_REMAINING]. Steps reporting a process that remains: 1. Result file: written.`);
    expect(leaks(serialized) || says(serialized, "cannot register") || says(serialized, "REG ")).toBe(false);
    expect(app.state.signals.length).toBe(4);
  });

  it("without a callback the process is still retained, and a handle held twice is stopped once", async () => {
    // No onSpawned at all, and a start that fails with a process that survives: the owner has the handle.
    const owner = createApplicationOwner();
    const surviving = fake({ dies: [], probe: never });
    const outcome = startApplication(surviving.deps, SPEC, { owner }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(STARTUP_DEADLINE_MS + 2 * STOP_GRACE_MS + 200);
    const error = (await outcome) as StartupError;
    expect({ code: error.code, remaining: error.stop?.processRemaining, retained: owner.owned().length, attempts: owner.owned()[0]?.stopAttempts().length }).toEqual({ code: "STARTUP_DEADLINE", remaining: true, retained: 1, attempts: 1 });

    // No options at all, and something that is not an owner: the process-wide owner retains the handle.
    const plain = await startApplication(fake().deps, SPEC);
    const forgedOwner = { owned: () => [] };
    const misdirected = await startApplication(fake().deps, SPEC, { owner: forgedOwner });
    const processWide = processApplicationOwner().owned();
    expect({ plain: processWide.includes(plain), misdirected: processWide.includes(misdirected), ownOwnerUntouched: owner.owned().length }).toEqual({ plain: true, misdirected: true, ownOwnerUntouched: 1 });
    // The list handed out is a copy: changing it changes nothing that is retained.
    (owner.owned() as ApplicationHandle[]).length = 0;
    expect(owner.owned().length).toBe(1);

    // Retained by the owner and by the caller's own list: one handle, one step, one stop attempt.
    const both = createApplicationOwner();
    const callerList: ApplicationHandle[] = [];
    const app = fake();
    const handle = await startApplication(app.deps, SPEC, { owner: both, onSpawned: (spawned) => void callerList.push(spawned) });
    expect({ owner: both.owned().length, caller: callerList.length, same: both.owned()[0] === handle && callerList[0] === handle }).toEqual({ owner: 1, caller: 1, same: true });
    const handles = uniqueHandles(both.owned(), callerList, both.owned());
    expect(handles.length).toBe(1);
    const result = await runCleanup(handles.map((owned, index) => applicationCleanupStep(owned, CLEANUP_STEP_NAMES[index + 1])));
    expect({ steps: result.steps.length, complete: result.complete, attempts: handle.stopAttempts().length, signals: app.state.signals }).toEqual({ steps: 1, complete: true, attempts: 1, signals: ["SIGTERM"] });
    // Even two steps for one handle signal it once: a clean stop is final.
    const twice = await runCleanup([applicationCleanupStep(handle, STEP_APP_1), applicationCleanupStep(handle, STEP_APP_2)]);
    expect({ complete: twice.complete, attempts: handle.stopAttempts().length, signals: app.state.signals.length }).toEqual({ complete: true, attempts: 1, signals: 1 });
  });

  it("the inputs check and the request errors the driver prints hold names and codes only", async () => {
    const inputs = readIntegrationInputs(
      { [AUTHORIZATION_VARIABLE]: AUTHORIZATION_VALUE, [AUTHORIZED_APP_PORT_VARIABLE]: "3170", DB_TARGET: `postgres://u:${ACTUAL}@127.0.0.1:1/x`, [EVIDENCE_DIRECTORY_VARIABLE]: `/private/${EXPECTED}`, [SERVER_LOG_VARIABLE]: `/private/${OTHER}` },
      { databaseVariables: ["DB_TARGET", "DB_PORT"], repositoryRoot: "/repo", inspect: () => ({ exists: false, directory: false, mode: 0 }) },
    );
    expect(inputs.kind).toBe("INVALID");
    expect(leaks(JSON.stringify(inputs))).toBe(false);

    const client = createHttpClient(async () => {
      throw new Error(`socket error with ${ACTUAL}`);
    });
    const settled = await client.submit({ method: "POST", path: `/checkout/start?t=${EXPECTED}`, body: `nonce=${OTHER}`, headers: { cookie: ACTUAL } });
    expect(settled.ok).toBe(false);
    expect(leaks(JSON.stringify(settled))).toBe(false);
    const thrown = await client.request({ method: "GET", path: `/x?t=${EXPECTED}`, headers: { cookie: ACTUAL } }).catch((caught: unknown) => caught);
    expect(leaks(failureOf(() => {
      throw thrown;
    }))).toBe(false);
    // Through the wrapper, a request failure is its listed code.
    expect(redactedFailure(thrown, "a request").message === "a request: unexpected failure [category=REQUEST code=REQUEST_FAILED] (error text withheld)").toBe(true);
  });
});

/**
 * Controls of the two driver interfaces (ownership registration, sentinel evidence) and of the wrapper's
 * qualification logic. Fakes and in-memory "files" only: no process, listener, request, database or real file.
 * Sentinel values are synthetic. Outer assertions on anything that could hold one are booleans.
 */
describe("run evidence: ownership registration, sentinel evidence and wrapper qualification", () => {
  const RUN = "0123456789abcdef0123456789abcdef";
  const OTHER_RUN = "fedcba9876543210fedcba9876543210";
  const SECRET_A = "SENTINEL-A-zQ4vN8rT2mK6pW1xY9bD3fH7jL5sG0cA";
  const SECRET_B = "SENTINEL-B-uE2oI6aR9tP3nM7kV1wX5yB8dF4hJ0lS";
  const NON_ASCII = "pässwörd-€-🔑-0123";
  const NON_ASCII_BYTES = Buffer.byteLength(NON_ASCII, "utf8");
  const says = (text: string | null, part: string): boolean => text !== null && text.includes(part);

  /** Files that exist only in a Map, with every call recorded. `failOn` makes one kind of call throw. */
  const memory = (failOn: { write?: () => boolean; rename?: () => boolean } = {}) => {
    const files = new Map<string, string>();
    const calls: string[] = [];
    return {
      files,
      calls,
      write(path: string, text: string) {
        calls.push(`write ${path}`);
        if (failOn.write?.()) throw Object.assign(new Error(`disk full near ${SECRET_A}`), { code: "ENOSPC" });
        files.set(path, text);
      },
      rename(from: string, to: string) {
        calls.push(`rename ${from} ${to}`);
        if (failOn.rename?.()) throw new Error(`rename refused near ${SECRET_A}`);
        const text = files.get(from);
        if (text === undefined) throw new Error("no such file");
        files.delete(from);
        files.set(to, text);
      },
    };
  };
  const registryOn = (disk: ReturnType<typeof memory>, ownershipId = RUN) =>
    new SentinelRegistry({ ownershipId, salt: Uint8Array.from({ length: 32 }, (_unused, index) => index + 1), base: 1_000_003, persist: (text) => atomicReplace(disk, "/evidence/sentinel-evidence.json", text) });
  const evidenceOf = (values: ReadonlyArray<readonly [string, string]>): SentinelEvidence => {
    const disk = memory();
    const registry = registryOn(disk);
    registry.open();
    for (const [category, value] of values) registry.register(category, value);
    registry.complete();
    const read = readSentinelEvidence(disk.files.get("/evidence/sentinel-evidence.json") ?? null, RUN);
    if (!read.ok) throw new Error("fixture evidence not readable");
    return read.evidence;
  };
  const forever = { deadline: Number.MAX_SAFE_INTEGER, now: () => 0 };
  const bytesOf = (text: string): Uint8Array => utf8Bytes(text);

  it("an application is registered at the spawn, before any readiness attempt, with its process identity and the run's identity", async () => {
    const lines: string[] = [];
    const owner = createApplicationOwner();
    let probesAtRegistration = -1;
    let retainedAtRegistration = -1;
    const app = fake();
    const handle = await startApplication(app.deps, SPEC, {
      owner,
      register: (spawned) => {
        probesAtRegistration = app.state.probes;
        retainedAtRegistration = owner.owned().length;
        registerOwnership((line) => void lines.push(line), { ownershipId: RUN, index: owner.owned().length, pid: spawned.pid, pgid: spawned.pid, startIdentity: "Mon Oct 12 03:45:30 2026" });
      },
    });
    expect({ probesAtRegistration, retainedAtRegistration, lines: lines.length, signals: app.state.signals.length }).toEqual({ probesAtRegistration: 0, retainedAtRegistration: 1, lines: 1, signals: 0 });
    expect(JSON.parse(lines[0])).toEqual({ format: OWNERSHIP_FORMAT, ownershipId: RUN, index: 1, pid: 4242, pgid: 4242, startIdentity: "Mon Oct 12 03:45:30 2026" });
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(readOwnership(lines.join(""), RUN)).toEqual({ ok: true, records: [{ format: OWNERSHIP_FORMAT, ownershipId: RUN, index: 1, pid: 4242, pgid: 4242, startIdentity: "Mon Oct 12 03:45:30 2026" }] });
    expect(owner.owned()[0] === handle).toBe(true);
  });

  it("a registration that cannot be written fails the start before readiness, with the process still owned and stopped", async () => {
    const attempts: Array<() => void> = [
      // The private record cannot be appended to.
      () => registerOwnership(() => {
        throw Object.assign(new Error(`append failed near ${SECRET_A}`), { code: "EACCES" });
      }, { ownershipId: RUN, index: 1, pid: 4242, pgid: 4242, startIdentity: "Mon Oct 12 03:45:30 2026" }),
      // The process identity could not be read: nothing valid to register.
      () => registerOwnership(() => undefined, { ownershipId: RUN, index: 1, pid: undefined, pgid: undefined, startIdentity: undefined }),
    ];
    for (const attempt of attempts) {
      const owner = createApplicationOwner();
      const app = fake({ probe: never });
      let onSpawnedCalled = false;
      const error = (await startApplication(app.deps, SPEC, { owner, register: attempt, onSpawned: () => void (onSpawnedCalled = true) }).catch((caught: unknown) => caught)) as StartupError;
      expect(error instanceof StartupError && error.code === "REGISTRATION_FAILED").toBe(true);
      // Retained internally all the same, stopped by the reviewed path, and never probed.
      expect({ retained: owner.owned().length, probes: app.state.probes, signals: app.state.signals, stopped: error.stop?.stopped, onSpawnedCalled }).toEqual({ retained: 1, probes: 0, signals: ["SIGTERM"], stopped: true, onSpawnedCalled: true });
      const line = describeStartupFailure(error);
      expect(line).toBe("application start failed [category=STARTUP code=REGISTRATION_FAILED]; the process that was started has been stopped");
      expect(says(line, SECRET_A) || says(JSON.stringify(Object.entries(error)), SECRET_A) || says(error.message, "append failed")).toBe(false);
      expect(error.message).toBe("The application did not start: REGISTRATION_FAILED");
    }
    // A record is all or nothing: every field in its range, or no record.
    const valid = { ownershipId: RUN, index: 1, pid: 4242, pgid: 4242, startIdentity: "Mon Oct 12 03:45:30 2026" };
    const invalid: Array<Record<string, unknown>> = [{ ownershipId: "RUN" }, { index: 0 }, { index: 1.5 }, { pid: 1 }, { pid: "4242" }, { pgid: -1 }, { startIdentity: "" }, { startIdentity: `x; rm -rf ${SECRET_A}` }, { startIdentity: 7 }];
    expect(invalid.filter((change) => ownershipRecord({ ...valid, ...change }) !== null).length).toBe(0);
    expect(ownershipRecord(valid) !== null).toBe(true);
  });

  it("ownership records are read back strictly: unreadable, malformed, of another run or duplicated is refused", () => {
    const record = (index: number, ownershipId = RUN): string => `${JSON.stringify(ownershipRecord({ ownershipId, index, pid: 4000 + index, pgid: 4000 + index, startIdentity: "Mon Oct 12 03:45:30 2026" }))}\n`;
    expect(readOwnership("", RUN)).toEqual({ ok: true, records: [] });
    const three = readOwnership(record(1) + record(2) + record(3), RUN);
    expect(three.ok && three.records.map((entry) => entry.pid).join(",") === "4001,4002,4003").toBe(true);
    const refused: Array<[string | null, string]> = [
      [null, "UNREADABLE"],
      ["not json\n", "MALFORMED"],
      [`${record(1)}{"format":"${OWNERSHIP_FORMAT}"}\n`, "MALFORMED"],
      [record(1).replace(OWNERSHIP_FORMAT, "shopaccess-ie1-ownership/2"), "MALFORMED"],
      [record(1).replace('"pid":4001', '"pid":4001,"command":"x"'), "MALFORMED"],
      [record(1).replace('"pid":4001', '"pid":"4001"'), "MALFORMED"],
      [record(1, OTHER_RUN), "OWNERSHIP_MISMATCH"],
      [record(1) + record(1), "DUPLICATE_INDEX"],
    ];
    expect(refused.filter(([text, reason]) => {
      const read = readOwnership(text, RUN);
      return read.ok || read.reason !== reason;
    }).length).toBe(0);
  });

  it("sentinel evidence is replaced atomically on every value, holds no value, and is closed with a completeness marker", () => {
    const disk = memory();
    const registry = registryOn(disk);
    const target = "/evidence/sentinel-evidence.json";
    // Nothing can be registered before the record exists.
    expect((() => {
      try {
        registry.register("password", SECRET_A);
        return false;
      } catch {
        return true;
      }
    })()).toBe(true);
    registry.open();
    expect(disk.calls).toEqual([`write ${target}.tmp`, `rename ${target}.tmp ${target}`]);
    expect(readSentinelEvidence(disk.files.get(target) ?? null, RUN)).toEqual({ ok: false, reason: "INCOMPLETE" });

    expect(registry.register("password", SECRET_A)).toBe(true);
    expect(registry.register("session cookie", SECRET_B)).toBe(true);
    // The same value again is not a new entry and writes nothing.
    const callsBefore = disk.calls.length;
    expect(registry.register("password", SECRET_A)).toBe(false);
    expect({ count: registry.count(), newCalls: disk.calls.length - callsBefore, temporaryLeft: disk.files.has(`${target}.tmp`) }).toEqual({ count: 2, newCalls: 0, temporaryLeft: false });
    // Every write went to the temporary file and was then renamed over the target.
    expect(disk.calls.filter((call, index) => (index % 2 === 0 ? call !== `write ${target}.tmp` : call !== `rename ${target}.tmp ${target}`)).length).toBe(0);

    const stored = disk.files.get(target) ?? "";
    expect(says(stored, SECRET_A) || says(stored, SECRET_B)).toBe(false);
    const parsed = JSON.parse(stored) as { format: string; encoding: string; complete: boolean; count: number; entries: Array<Record<string, unknown>> };
    expect({ format: parsed.format, encoding: parsed.encoding, complete: parsed.complete, count: parsed.count }).toEqual({ format: SENTINEL_FORMAT, encoding: "utf-8", complete: false, count: 2 });
    expect(parsed.entries.map((entry) => `${entry.category}:${entry.byteLength}:${Object.keys(entry).sort().join(",")}`)).toEqual([`password:${SECRET_A.length}:byteLength,category,digest,rolling`, `session cookie:${SECRET_B.length}:byteLength,category,digest,rolling`]);

    // Refused without being registered: an unlisted category, and lengths out of range.
    const refusals = [() => registry.register("api key", SECRET_A), () => registry.register("password", "short"), () => registry.register("password", "x".repeat(4097))];
    expect(refusals.filter((attempt) => {
      try {
        attempt();
        return true;
      } catch {
        return false;
      }
    }).length).toBe(0);
    expect(registry.count()).toBe(2);

    registry.complete();
    const read = readSentinelEvidence(disk.files.get(target) ?? null, RUN);
    expect(read.ok && read.evidence.complete && read.evidence.entries.length === 2 && registry.isComplete()).toBe(true);
    // Closed: nothing more can be registered.
    expect((() => {
      try {
        registry.register("password", `${SECRET_A}-later`);
        return false;
      } catch {
        return true;
      }
    })()).toBe(true);
    expect(SENTINEL_CATEGORIES).toEqual(["private key", "password", "connection URL", "session cookie", "owner id", "token digest", "nonce digest", "confirmation nonce", "quote digest", "CSRF token"]);
  });

  it("a sentinel write that fails registers nothing and leaves the record whole; missing or malformed records are refused", () => {
    const target = "/evidence/sentinel-evidence.json";
    let failing = false;
    const disk = memory({ rename: () => failing, write: () => false });
    const registry = registryOn(disk);
    registry.open();
    registry.register("password", SECRET_A);
    const before = disk.files.get(target);

    failing = true;
    const failure = failureOfThrow(() => registry.register("session cookie", SECRET_B));
    expect(failure.threw).toBe(true);
    // Not counted, and the record on disk is exactly what it was: the old content, whole.
    expect({ count: registry.count(), unchanged: disk.files.get(target) === before }).toEqual({ count: 1, unchanged: true });
    const completion = failureOfThrow(() => registry.complete());
    expect({ threw: completion.threw, complete: registry.isComplete() }).toEqual({ threw: true, complete: false });
    expect(readSentinelEvidence(disk.files.get(target) ?? null, RUN)).toEqual({ ok: false, reason: "INCOMPLETE" });

    // The write works again: the value that failed can now be registered, and the record completed.
    failing = false;
    expect(registry.register("session cookie", SECRET_B)).toBe(true);
    registry.complete();
    const good = disk.files.get(target) ?? "";
    expect(readSentinelEvidence(good, RUN).ok).toBe(true);

    const change = (edit: (record: Record<string, unknown>) => void): string => {
      const record = JSON.parse(good) as Record<string, unknown>;
      edit(record);
      return JSON.stringify(record);
    };
    const entries = (record: Record<string, unknown>) => record.entries as Array<Record<string, unknown>>;
    const refused: Array<[string | null, string]> = [
      [null, "UNREADABLE"],
      ["", "NOT_JSON"],
      [good.slice(0, good.length - 20), "NOT_JSON"],
      ["[]", "MALFORMED"],
      [change((record) => void (record.extra = 1)), "MALFORMED"],
      [change((record) => void delete record.salt), "MALFORMED"],
      [change((record) => void (record.format = "shopaccess-ie1-sentinels/2")), "WRONG_FORMAT"],
      [change((record) => void (record.encoding = "utf-16")), "WRONG_FORMAT"],
      [change((record) => void (record.salt = "00")), "MALFORMED"],
      [change((record) => void (record.base = 1)), "MALFORMED"],
      [change((record) => void (record.count = 3)), "MALFORMED"],
      [change((record) => void (record.complete = "true")), "MALFORMED"],
      [change((record) => void (entries(record)[0].category = "api key")), "MALFORMED"],
      [change((record) => void (entries(record)[0].byteLength = 4)), "MALFORMED"],
      [change((record) => void (entries(record)[0].rolling = ROLLING_MODULUS)), "MALFORMED"],
      [change((record) => void (entries(record)[0].digest = "xyz")), "MALFORMED"],
      [change((record) => void (entries(record)[0].value = SECRET_A)), "MALFORMED"],
      [change((record) => void (record.ownershipId = OTHER_RUN)), "OWNERSHIP_MISMATCH"],
      [change((record) => void (record.complete = false)), "INCOMPLETE"],
    ];
    expect(refused.filter(([text, reason]) => {
      const read = readSentinelEvidence(text, RUN);
      return read.ok || read.reason !== reason;
    }).length).toBe(0);
  });

  it("lengths are UTF-8 byte lengths, and scanning finds exact registered bytes and nothing else", () => {
    // More bytes than characters: a length counted in characters would be wrong for this value.
    expect({ bytes: bytesOf(NON_ASCII).length === NON_ASCII_BYTES, longerThanCharacters: NON_ASCII_BYTES > NON_ASCII.length }).toEqual({ bytes: true, longerThanCharacters: true });
    const evidence = evidenceOf([
      ["password", NON_ASCII],
      ["session cookie", SECRET_A],
      ["CSRF token", SECRET_B],
    ]);
    expect(evidence.entries.map((entry) => entry.byteLength)).toEqual([NON_ASCII_BYTES, SECRET_A.length, SECRET_B.length]);

    const haystack = bytesOf(`start ${SECRET_A} middle ${NON_ASCII} again ${SECRET_A}${SECRET_A} tail ${NON_ASCII}`);
    expect(scanBytes(evidence, haystack, forever)).toEqual({
      complete: true,
      findings: [
        { category: "password", matches: 2 },
        { category: "session cookie", matches: 3 },
      ],
    });
    // At the very start and the very end of the input, and when the input is exactly the value.
    expect(scanBytes(evidence, bytesOf(`${SECRET_B} x ${SECRET_B}`), forever).findings).toEqual([{ category: "CSRF token", matches: 2 }]);
    expect(scanBytes(evidence, bytesOf(SECRET_B), forever).findings).toEqual([{ category: "CSRF token", matches: 1 }]);

    // Not found: other encodings and transformed forms of a registered value, a value never registered, a
    // truncated value, and an input shorter than every value.
    const notFound: Uint8Array[] = [
      Uint8Array.from(Buffer.from(NON_ASCII, "latin1")),
      Uint8Array.from(Buffer.from(NON_ASCII, "utf16le")),
      bytesOf(encodeURIComponent(NON_ASCII)),
      bytesOf(JSON.stringify(NON_ASCII).replace("ä", "\\u00e4")),
      bytesOf(Buffer.from(SECRET_A).toString("base64")),
      bytesOf(SECRET_A.toLowerCase()),
      bytesOf(SECRET_A.slice(0, SECRET_A.length - 1)),
      bytesOf(`${SECRET_A.slice(0, 20)}\n${SECRET_A.slice(20)}`),
      bytesOf("SENTINEL-C-never-registered-anywhere-000000"),
      bytesOf("tiny"),
      new Uint8Array(0),
    ];
    expect(notFound.filter((input) => scanBytes(evidence, input, forever).findings.length > 0).length).toBe(0);
    // An empty record scans as complete and clean.
    expect(scanBytes(evidenceOf([]), haystack, forever)).toEqual({ complete: true, findings: [] });

    // A scan that runs out of time is not a complete scan, whatever it had found.
    let ticks = 0;
    const expiring = { deadline: 1, now: () => (ticks += 1) };
    expect(scanBytes(evidence, haystack, expiring).complete).toBe(false);
    // The record on disk never holds the values it describes.
    expect(says(serializeSentinelEvidence(evidence), NON_ASCII) || says(serializeSentinelEvidence(evidence), SECRET_A)).toBe(false);
  });

  /** An input served from memory a piece at a time, with every open, read and close counted. */
  const stream = (name: string, content: Uint8Array, options: { chunk?: number; sizeBefore?: number | null; sizeAfter?: number | null; failOpen?: boolean; failReadAt?: number; failClose?: boolean; endless?: boolean; ignoreMax?: boolean } = {}) => {
    const seen = { opens: 0, reads: 0, closes: 0, served: 0, requests: [] as number[] };
    const input: StreamInput = {
      name,
      sizeBefore: options.sizeBefore === undefined ? content.length : options.sizeBefore,
      sizeAfter: () => (options.sizeAfter === undefined ? content.length : options.sizeAfter),
      open(): ChunkReader {
        seen.opens += 1;
        if (options.failOpen) throw new Error(`cannot open near ${SECRET_B}`);
        let offset = 0;
        return {
          read(maxBytes: number) {
            seen.reads += 1;
            seen.requests.push(maxBytes);
            if (options.failReadAt !== undefined && seen.reads >= options.failReadAt) throw new Error(`read error near ${SECRET_B}`);
            // An honest reader takes at most what it was asked for. `ignoreMax` makes a dishonest one.
            const want = options.ignoreMax ? (options.chunk ?? 64) : Math.min(options.chunk ?? 64, maxBytes);
            if (options.endless) {
              seen.served += want;
              return new Uint8Array(want).fill(120);
            }
            if (offset >= content.length) return null;
            const piece = content.subarray(offset, offset + want);
            offset += piece.length;
            seen.served += piece.length;
            return piece;
          },
          close() {
            seen.closes += 1;
            if (options.failClose) throw new Error("close failed");
          },
        };
      },
    };
    return { input, seen };
  };
  const roomy = { maxFileBytes: 100_000, maxTotalBytes: 1_000_000, budget: forever };
  const summary = (report: ReturnType<typeof scanStreams>) => ({ complete: report.complete, clean: report.clean, files: report.files.map((file) => `${file.name}:${file.status}:${file.findings.map((finding) => `${finding.category}x${finding.matches}`).join("+")}`) });

  it("the streaming scan finds a value lying across pieces exactly once, at every split, including inside a UTF-8 character", () => {
    const evidence = evidenceOf([
      ["password", NON_ASCII],
      ["session cookie", SECRET_A],
    ]);
    const text = `head ${SECRET_A} mid ${NON_ASCII} ${SECRET_A}${SECRET_A} tail ${NON_ASCII}`;
    const whole = bytesOf(text);
    const expected = scanBytes(evidence, whole, forever).findings;
    expect(expected).toEqual([
      { category: "password", matches: 2 },
      { category: "session cookie", matches: 3 },
    ]);
    // Every piece size from one byte up: so every value is cut at every position, and every multi-byte character
    // of the non-ASCII value is cut inside itself. The result must be the same as for the whole, each time.
    const wrong: number[] = [];
    for (let chunk = 1; chunk <= whole.length + 1; chunk += 1) {
      const { input, seen } = stream("evidence.log", whole, { chunk });
      const report = scanStreams(evidence, [input], roomy);
      const same = report.complete && report.files.length === 1 && report.files[0].status === "SCANNED" && report.files[0].bytes === whole.length && JSON.stringify(report.files[0].findings) === JSON.stringify(expected) && seen.closes === 1;
      if (!same) wrong.push(chunk);
    }
    expect(wrong).toEqual([]);
    // The bytes of the non-ASCII value really are cut inside a character at some of those sizes.
    const utf8 = bytesOf(NON_ASCII);
    expect(Array.from(utf8).some((byte) => (byte & 0xc0) === 0x80)).toBe(true);
    // A value never registered, and an empty input, find nothing and are complete and clean.
    expect(summary(scanStreams(evidence, [stream("a.log", bytesOf("nothing registered here")).input, stream("empty.log", new Uint8Array(0)).input], roomy))).toEqual({ complete: true, clean: true, files: ["a.log:SCANNED:", "empty.log:SCANNED:"] });
    // No inputs at all is complete and clean; it is the caller that decides which inputs are required.
    expect(summary(scanStreams(evidence, [], roomy))).toEqual({ complete: true, clean: true, files: [] });
  });

  it("limits are enforced on bytes actually read: a file that grew, or lied about its size, is stopped and is not clean", () => {
    const evidence = evidenceOf([["password", SECRET_A]]);
    const limits = { maxFileBytes: 1_000, maxTotalBytes: 1_500, budget: forever };

    // Said to be 10 bytes; it never ends. Reading stops AT the limit: the last read is asked for only what is left
    // of it, and once nothing is left no read is made. Not one byte beyond the limit is taken from the file.
    const endless = stream("grew.log", new Uint8Array(0), { endless: true, sizeBefore: 10, sizeAfter: 10 });
    const grown = scanStreams(evidence, [endless.input], limits);
    expect(summary(grown)).toEqual({ complete: false, clean: false, files: ["grew.log:OVERSIZED:"] });
    // Each read is asked for exactly what is still left of the limit: 1,000, then 936, ... and at last 40.
    expect({ served: endless.seen.served, firstRequest: endless.seen.requests[0], lastRequest: endless.seen.requests[endless.seen.requests.length - 1], eachWasWhatWasLeft: endless.seen.requests.every((request, index) => request === 1_000 - 64 * index), closed: endless.seen.closes }).toEqual({ served: 1_000, firstRequest: 1_000, lastRequest: 40, eachWasWhatWasLeft: true, closed: 1 });

    // Read to its end, and its size before or after is not what was read: it changed while it was read.
    const leak = bytesOf(`a line with ${SECRET_A} in it`);
    const changed = [
      stream("appended.log", leak, { sizeAfter: leak.length + 5 }),
      stream("truncated.log", leak, { sizeBefore: leak.length + 5 }),
      stream("unknown-before.log", leak, { sizeBefore: null }),
      stream("unknown-after.log", leak, { sizeAfter: null }),
    ];
    // What was read is still searched, and what was found is still reported: but the scan is not complete.
    expect(summary(scanStreams(evidence, changed.map((entry) => entry.input), { ...limits, maxFileBytes: 10_000, maxTotalBytes: 100_000 }))).toEqual({
      complete: false,
      clean: false,
      files: ["appended.log:CHANGED_DURING_READ:passwordx1", "truncated.log:CHANGED_DURING_READ:passwordx1", "unknown-before.log:UNREADABLE:passwordx1", "unknown-after.log:UNREADABLE:passwordx1"],
    });
    expect(changed.every((entry) => entry.seen.opens === 1 && entry.seen.closes === 1)).toBe(true);

    // The total across inputs, counted as it is read: the second input passes it and nothing after it is read.
    const first = stream("first.log", new Uint8Array(900).fill(121));
    const second = stream("second.log", new Uint8Array(900).fill(122));
    const third = stream("third.log", new Uint8Array(10).fill(123));
    expect(summary(scanStreams(evidence, [first.input, second.input, third.input], limits))).toEqual({ complete: false, clean: false, files: ["first.log:SCANNED:", "second.log:TOTAL_SIZE_EXCEEDED:", "third.log:NOT_REACHED:"] });
    // The second input was read up to what was left of the total, and not beyond.
    expect({ secondClosed: second.seen.closes, secondServed: second.seen.served, thirdOpened: third.seen.opens }).toEqual({ secondClosed: 1, secondServed: 600, thirdOpened: 0 });
  });

  it("every read is capped before it is made: no limit is passed by a byte, and at zero budget nothing is read", () => {
    const evidence = evidenceOf([["password", SECRET_A]]);
    const capped = { maxFileBytes: 100, maxTotalBytes: 1_000, chunkBytes: 32, budget: forever };
    const filler = (length: number): Uint8Array => new Uint8Array(length).fill(120);
    const one = (entry: ReturnType<typeof stream>, limits: Parameters<typeof scanStreams>[2] = capped) => summary(scanStreams(evidence, [entry.input], limits));

    // A file of exactly the limit, with a registered value in its last bytes. Four reads, each asked for no more
    // than what was left; then nothing is left and NO fifth read is made. That it ended there is taken from its
    // size, before and after. The value, which lies across the pieces, is found once.
    const exactBytes = filler(100);
    exactBytes.set(bytesOf(SECRET_A), 100 - SECRET_A.length);
    const exact = stream("exact.log", exactBytes);
    expect(one(exact)).toEqual({ complete: true, clean: false, files: ["exact.log:SCANNED:passwordx1"] });
    expect({ requests: exact.seen.requests, reads: exact.seen.reads, served: exact.seen.served, closes: exact.seen.closes }).toEqual({ requests: [32, 32, 32, 4], reads: 4, served: 100, closes: 1 });

    // One byte short of the limit ends by an ordinary end of input: the last read is asked for the one byte left.
    const under = stream("under.log", filler(99));
    expect(one(under)).toEqual({ complete: true, clean: true, files: ["under.log:SCANNED:"] });
    expect(under.seen.requests).toEqual([32, 32, 32, 4, 1]);

    // Larger than the limit, growing without end, or lying about its size: exactly the limit is read, never an
    // extra piece, and the result is incomplete. Likewise when its size cannot be examined at the limit: that it
    // ended there is not established, so it is not claimed.
    const over = [
      stream("larger.log", filler(150)),
      stream("growing.log", new Uint8Array(0), { endless: true, sizeBefore: 100, sizeAfter: 5_000 }),
      stream("lied.log", new Uint8Array(0), { endless: true, sizeBefore: 10, sizeAfter: 10 }),
      stream("unknown-after.log", filler(100), { sizeAfter: null }),
      stream("unknown-before.log", filler(100), { sizeBefore: null }),
    ];
    expect(over.map((entry) => one(entry).files[0])).toEqual(["larger.log:OVERSIZED:", "growing.log:OVERSIZED:", "lied.log:OVERSIZED:", "unknown-after.log:OVERSIZED:", "unknown-before.log:OVERSIZED:"]);
    expect(over.map((entry) => `${entry.seen.served}:${entry.seen.requests.join("+")}:${entry.seen.closes}`)).toEqual(Array.from({ length: 5 }, () => "100:32+32+32+4:1"));

    // The limit on all inputs together is enforced the same way, across inputs.
    const total = { ...capped, maxTotalBytes: 150 };
    const first = stream("first.log", filler(100));
    const second = stream("second.log", filler(100));
    const third = stream("third.log", filler(10));
    expect(summary(scanStreams(evidence, [first.input, second.input, third.input], total))).toEqual({ complete: false, clean: false, files: ["first.log:SCANNED:", "second.log:TOTAL_SIZE_EXCEEDED:", "third.log:NOT_REACHED:"] });
    expect({ second: second.seen.requests, secondServed: second.seen.served, thirdOpened: third.seen.opens, readInAll: first.seen.served + second.seen.served + third.seen.served }).toEqual({ second: [32, 18], secondServed: 50, thirdOpened: 0, readInAll: 150 });
    // Inputs that end exactly as the total runs out are complete; an empty one after them needs no read at all;
    // a non-empty one after them is over the total, and is not read.
    const fits = stream("fits.log", filler(50));
    const empty = stream("empty.log", filler(0));
    const late = stream("late.log", filler(5));
    expect(summary(scanStreams(evidence, [stream("a.log", filler(100)).input, fits.input, empty.input], total))).toEqual({ complete: true, clean: true, files: ["a.log:SCANNED:", "fits.log:SCANNED:", "empty.log:SCANNED:"] });
    expect({ fits: fits.seen.requests, emptyReads: empty.seen.reads, emptyClosed: empty.seen.closes }).toEqual({ fits: [32, 18], emptyReads: 0, emptyClosed: 1 });
    expect(summary(scanStreams(evidence, [stream("a.log", filler(100)).input, stream("b.log", filler(50)).input, late.input], total)).files[2]).toBe("late.log:TOTAL_SIZE_EXCEEDED:");
    expect({ lateReads: late.seen.reads, lateClosed: late.seen.closes }).toEqual({ lateReads: 0, lateClosed: 1 });

    // No budget at all: no read of any length is ever asked for.
    const nothingForFile = stream("x.log", filler(5));
    const nothingForTotal = stream("y.log", filler(5));
    const nothingNeeded = stream("z.log", filler(0));
    expect(one(nothingForFile, { ...capped, maxFileBytes: 0 }).files[0]).toBe("x.log:OVERSIZED:");
    expect(one(nothingForTotal, { ...capped, maxTotalBytes: 0 }).files[0]).toBe("y.log:TOTAL_SIZE_EXCEEDED:");
    expect(one(nothingNeeded, { ...capped, maxFileBytes: 0, maxTotalBytes: 0 })).toEqual({ complete: true, clean: true, files: ["z.log:SCANNED:"] });
    expect([nothingForFile, nothingForTotal, nothingNeeded].map((entry) => `${entry.seen.reads}:${entry.seen.requests.length}:${entry.seen.closes}`)).toEqual(["0:0:1", "0:0:1", "0:0:1"]);

    // A reader that returns more than it was asked for: never complete, and what it returned is not searched.
    const rudeBytes = filler(64);
    rudeBytes.set(bytesOf(SECRET_A), 0);
    const rude = stream("rude.log", rudeBytes, { ignoreMax: true });
    expect(one(rude)).toEqual({ complete: false, clean: false, files: ["rude.log:READER_OVERRAN_REQUEST:"] });
    expect({ requests: rude.seen.requests, closes: rude.seen.closes }).toEqual({ requests: [32], closes: 1 });

    // The piece size is a cap like the others; with very small pieces a value across many of them is found once
    // each time it occurs, and every reader is closed. A piece size that is not a positive whole number is not used.
    const text = bytesOf(`one ${SECRET_A} two ${SECRET_A} end`);
    const small = stream("small.log", text);
    expect(one(small, { maxFileBytes: 100_000, maxTotalBytes: 1_000_000, chunkBytes: 5, budget: forever })).toEqual({ complete: true, clean: false, files: ["small.log:SCANNED:passwordx2"] });
    expect({ largestRequest: Math.max(...small.seen.requests), served: small.seen.served, closes: small.seen.closes }).toEqual({ largestRequest: 5, served: text.length, closes: 1 });
    const defaults = [0, 1.5, -3].map((chunkBytes) => {
      const entry = stream("d.log", text);
      scanStreams(evidence, [entry.input], { maxFileBytes: 100_000, maxTotalBytes: 1_000_000, chunkBytes, budget: forever });
      return entry.seen.requests[0];
    });
    expect(defaults).toEqual([100_000, 100_000, 100_000]);
    // In every scan above, no read was asked for more than was left, and none for less than one byte.
    const everyRequest = [exact, under, ...over, first, second, fits, small, rude].flatMap((entry) => entry.seen.requests);
    expect({ smallest: Math.min(...everyRequest), wholeNumbers: everyRequest.every((request) => Number.isSafeInteger(request)) }).toEqual({ smallest: 1, wholeNumbers: true });
  });

  it("a read failure, a deadline and a cancellation stop the scan, close the reader, and never read as clean", () => {
    const evidence = evidenceOf([["password", SECRET_A]]);
    const content = bytesOf("x".repeat(500));

    const unopened = stream("unopened.log", content, { failOpen: true });
    const broken = stream("broken.log", content, { failReadAt: 3 });
    const sticky = stream("sticky.log", content, { failClose: true });
    const fine = stream("fine.log", content);
    const failures = scanStreams(evidence, [unopened.input, broken.input, sticky.input, fine.input], roomy);
    expect(summary(failures)).toEqual({ complete: false, clean: false, files: ["unopened.log:UNREADABLE:", "broken.log:UNREADABLE:", "sticky.log:CLOSE_FAILED:", "fine.log:SCANNED:"] });
    // Every reader that was opened was closed, exactly once, whatever happened to it.
    expect({ unopened: unopened.seen.closes, broken: broken.seen.closes, sticky: sticky.seen.closes, fine: fine.seen.closes }).toEqual({ unopened: 0, broken: 1, sticky: 1, fine: 1 });
    expect(says(JSON.stringify(failures), SECRET_B) || says(JSON.stringify(failures), "read error")).toBe(false);

    // One deadline for the whole scan: it passes while the first input is being read.
    let ticks = 0;
    const slow = stream("slow.log", content, { chunk: 50 });
    const later = stream("later.log", content);
    const timed = scanStreams(evidence, [slow.input, later.input], { ...roomy, budget: { deadline: 5, now: () => (ticks += 1) } });
    expect(summary(timed)).toEqual({ complete: false, clean: false, files: ["slow.log:TIME_BUDGET_EXCEEDED:", "later.log:NOT_REACHED:"] });
    expect({ stoppedEarly: slow.seen.served < content.length, closed: slow.seen.closes, laterOpened: later.seen.opens }).toEqual({ stoppedEarly: true, closed: 1, laterOpened: 0 });

    // Cancellation is asked before every read.
    let reads = 0;
    const cancellable = stream("cancellable.log", content, { chunk: 50 });
    const cancelled = scanStreams(evidence, [cancellable.input, stream("after.log", content).input], { ...roomy, cancelled: () => (reads += 1) > 3 });
    expect(summary(cancelled)).toEqual({ complete: false, clean: false, files: ["cancellable.log:CANCELLED:", "after.log:NOT_REACHED:"] });
    expect({ closed: cancellable.seen.closes, stoppedEarly: cancellable.seen.served < content.length }).toEqual({ closed: 1, stoppedEarly: true });
    // A cancellation check that itself fails stops the scan: it is not taken as permission to go on.
    const failingCheck = scanStreams(evidence, [stream("a.log", content).input], {
      ...roomy,
      cancelled: () => {
        throw new Error("signal state unreadable");
      },
    });
    expect(summary(failingCheck)).toEqual({ complete: false, clean: false, files: ["a.log:CANCELLED:"] });
  });

  it("the wrapper's own secrets are searched by the same scanner, in the same pass as the driver's sentinels", () => {
    const WRAPPER_PASSWORD = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const WRAPPER_URL = `postgres://a3e_admin:${WRAPPER_PASSWORD}@127.0.0.1:54537/postgres`;
    const driver = evidenceOf([["session cookie", SECRET_A]]);
    const both = withAdditionalValues(driver, [
      { category: "password", value: WRAPPER_PASSWORD },
      { category: "connection URL", value: WRAPPER_URL },
      // Already registered by the driver: not counted twice.
      { category: "session cookie", value: SECRET_A },
    ]);
    expect(both !== null && both.entries.length === 3 && both.base === driver.base && both.ownershipId === driver.ownershipId).toBe(true);
    if (both === null) return;
    expect(says(serializeSentinelEvidence(both), WRAPPER_PASSWORD) || says(serializeSentinelEvidence(both), "a3e_admin")).toBe(false);

    const report = scanStreams(
      both,
      [stream("integration-run.log", bytesOf(`cookie ${SECRET_A}\nurl ${WRAPPER_URL}\n`), { chunk: 7 }).input, stream("server.log", bytesOf(`password ${WRAPPER_PASSWORD} again ${WRAPPER_PASSWORD}`), { chunk: 5 }).input, stream("clean.log", bytesOf("nothing")).input],
      roomy,
    );
    // The URL holds the password: both are found there, each under its own category. Categories and counts only.
    expect(summary(report)).toEqual({ complete: true, clean: false, files: ["integration-run.log:SCANNED:connection URLx1+passwordx1+session cookiex1", "server.log:SCANNED:passwordx2", "clean.log:SCANNED:".replace("SCANNED:", "SCANNED:")] });
    expect(says(JSON.stringify(report), WRAPPER_PASSWORD) || says(JSON.stringify(report), SECRET_A)).toBe(false);

    // A value the scanner cannot take is a refusal, not a silent omission; and there is evidence without a driver.
    expect(withAdditionalValues(driver, [{ category: "api key", value: WRAPPER_PASSWORD }])).toBe(null);
    expect(withAdditionalValues(driver, [{ category: "password", value: "short" }])).toBe(null);
    const alone = evidenceFromValues({ ownershipId: RUN, salt: new Uint8Array(32).fill(7), base: 1_000_003, values: [{ category: "password", value: WRAPPER_PASSWORD }] });
    expect(alone !== null && summary(scanStreams(alone, [stream("x.log", bytesOf(WRAPPER_PASSWORD)).input], roomy)).files[0] === "x.log:SCANNED:passwordx1").toBe(true);
    expect(evidenceFromValues({ ownershipId: "RUN", salt: new Uint8Array(32), base: 1_000_003, values: [] })).toBe(null);
  });

  it("a directory this call created is this run's even when its mode is wrong; a collision is never touched", () => {
    const calls: string[] = [];
    const files = (options: { mkdirError?: string; modes?: number[]; chmodFails?: boolean }) => {
      const modes = [...(options.modes ?? [0o700])];
      return {
        mkdir(path: string, wanted: number) {
          calls.push(`mkdir ${path} ${wanted.toString(8)}`);
          if (options.mkdirError !== undefined) throw Object.assign(new Error(`cannot create near ${SECRET_A}`), { code: options.mkdirError });
        },
        mode(path: string) {
          calls.push(`mode ${path}`);
          return modes.length > 1 ? (modes.shift() as number) : modes[0];
        },
        chmod(path: string, wanted: number) {
          calls.push(`chmod ${path} ${wanted.toString(8)}`);
          if (options.chmodFails) throw new Error("not permitted");
        },
      };
    };
    // A collision: not created, no path handed back, and one call only: no look inside, no mode change, no write.
    expect(createRunDirectory(files({ mkdirError: "EEXIST" }), "/runs/run-ie1-1")).toEqual({ created: false, reason: "ALREADY_EXISTS" });
    expect(calls).toEqual(["mkdir /runs/run-ie1-1 700"]);
    calls.length = 0;
    expect(createRunDirectory(files({ mkdirError: "EACCES" }), "/runs/run-ie1-2")).toEqual({ created: false, reason: "NOT_CREATED" });
    expect(calls).toEqual(["mkdir /runs/run-ie1-2 700"]);

    // Created with the right mode: usable, nothing corrected.
    calls.length = 0;
    expect(createRunDirectory(files({}), "/runs/run-ie1-3")).toEqual({ created: true, path: "/runs/run-ie1-3", usable: true, modeCorrected: false });
    expect(calls).toEqual(["mkdir /runs/run-ie1-3 700", "mode /runs/run-ie1-3"]);

    // Created with a wrong mode: it IS this run's, so its path comes back. One correction on the new, empty
    // directory; usable only if the mode then reads 700.
    calls.length = 0;
    expect(createRunDirectory(files({ modes: [0o755, 0o700] }), "/runs/run-ie1-4")).toEqual({ created: true, path: "/runs/run-ie1-4", usable: true, modeCorrected: true });
    expect(calls).toEqual(["mkdir /runs/run-ie1-4 700", "mode /runs/run-ie1-4", "chmod /runs/run-ie1-4 700", "mode /runs/run-ie1-4"]);
    // The correction did not hold, or could not be made: created, with its path, and NOT usable.
    expect(createRunDirectory(files({ modes: [0o755, 0o755] }), "/runs/run-ie1-5")).toEqual({ created: true, path: "/runs/run-ie1-5", usable: false, reason: "WRONG_MODE" });
    expect(createRunDirectory(files({ modes: [0o755, 0o755], chmodFails: true }), "/runs/run-ie1-6")).toEqual({ created: true, path: "/runs/run-ie1-6", usable: false, reason: "WRONG_MODE" });
    // The two cases are never confused: a collision has no path, a wrong-mode creation always has one.
    const collision = createRunDirectory(files({ mkdirError: "EEXIST" }), "/runs/x");
    const wrongMode = createRunDirectory(files({ modes: [0o755, 0o755] }), "/runs/y");
    expect({ collisionHasPath: "path" in collision, wrongModeHasPath: "path" in wrongMode, wrongModeCreated: wrongMode.created }).toEqual({ collisionHasPath: false, wrongModeHasPath: true, wrongModeCreated: true });
  });

  it("a signal is decided from readable, agreeing evidence only: unreadable identity is never permission", () => {
    const marker = ` SHOPACCESS_APP_TEST_OWNERSHIP_ID=${RUN}`;
    // Reading a process's environment: carried, not carried, exited, or not readable. The last two are different.
    expect([
      classifyIdentityRead({ commandSucceeded: true, output: `node next dev${marker} PATH=/usr/bin`, stillPresent: true, marker }),
      classifyIdentityRead({ commandSucceeded: true, output: "node something-else PATH=/usr/bin", stillPresent: true, marker }),
      classifyIdentityRead({ commandSucceeded: false, output: "", stillPresent: false, marker }),
      classifyIdentityRead({ commandSucceeded: false, output: "", stillPresent: true, marker }),
      classifyIdentityRead({ commandSucceeded: false, output: "", stillPresent: null, marker }),
      classifyIdentityRead({ commandSucceeded: true, output: "   \n", stillPresent: true, marker }),
      classifyIdentityRead({ commandSucceeded: true, output: "node x", stillPresent: true, marker: "" }),
    ]).toEqual(["CARRIES", "DOES_NOT_CARRY", "EXITED", "UNREADABLE", "UNREADABLE", "UNREADABLE", "DOES_NOT_CARRY"]);

    const decide = (snapshotReadable: boolean, presentWithSameStart: boolean, identity: Parameters<typeof signalDecision>[0]["identity"], identityRequired = true) => signalDecision({ snapshotReadable, presentWithSameStart, identity, identityRequired });
    // The one way to a signal: the table was read, the pid is the recorded process, and it carries the identity.
    expect(decide(true, true, "CARRIES")).toBe("SIGNAL");
    // Unreadable evidence, of either kind, refuses. It is not treated as an exit and not as a match.
    expect([decide(false, true, "CARRIES"), decide(false, false, "CARRIES"), decide(true, true, "UNREADABLE")]).toEqual(["REFUSE_UNREADABLE", "REFUSE_UNREADABLE", "REFUSE_UNREADABLE"]);
    // Gone, or the pid now belongs to another start: nothing to signal.
    expect([decide(true, false, "CARRIES"), decide(true, false, "UNREADABLE"), decide(true, true, "EXITED")]).toEqual(["SKIP_EXITED", "SKIP_EXITED", "SKIP_EXITED"]);
    // The recorded process, readable, without the run's identity: contradictory, so not signalled.
    expect(decide(true, true, "DOES_NOT_CARRY")).toBe("SKIP_NOT_OURS");
    // A run with no ownership identity at all decides on the process table alone.
    expect([decide(true, true, "UNREADABLE", false), decide(false, true, "UNREADABLE", false), decide(true, false, "UNREADABLE", false)]).toEqual(["SIGNAL", "REFUSE_UNREADABLE", "SKIP_EXITED"]);
    // Across every combination, a signal is never allowed without a readable table, the same start and the identity.
    const identities = ["CARRIES", "DOES_NOT_CARRY", "EXITED", "UNREADABLE"] as const;
    const allowed = [true, false].flatMap((readable) => [true, false].flatMap((same) => identities.filter((identity) => decide(readable, same, identity) === "SIGNAL").map((identity) => `${readable}:${same}:${identity}`)));
    expect(allowed).toEqual(["true:true:CARRIES"]);

    // A registered application against the process table now.
    const registered = { pgid: 4242, startIdentity: "Mon Oct 12 03:45:30 2026" };
    expect([
      matchRegistered(registered, { pgid: 4242, lstart: "Mon Oct 12 03:45:30 2026" }),
      matchRegistered(registered, { pgid: 9999, lstart: "Mon Oct 12 03:45:30 2026" }),
      matchRegistered(registered, { pgid: 4242, lstart: "Mon Oct 12 03:59:59 2026" }),
      matchRegistered(registered, undefined),
    ]).toEqual(["MATCH", "PGID_MISMATCH", "GONE", "GONE"]);

    // Registration indices are the start sequence: 1, 2, 3, in that order.
    const sequence = (...indices: number[]) => {
      const result = registrationSequence(indices.map((index) => ({ index })));
      return `${result.valid}:${result.count}:${result.reason}`;
    };
    expect([sequence(), sequence(1), sequence(1, 2, 3), sequence(1, 3), sequence(2), sequence(1, 1), sequence(2, 1), sequence(0, 1), sequence(1, 2, 2), sequence(1, 2, 4), sequence(1.5)]).toEqual([
      "true:0:OK",
      "true:1:OK",
      "true:3:OK",
      "false:2:MISSING_INDEX",
      "false:1:MISSING_INDEX",
      "false:2:DUPLICATE_INDEX",
      "false:2:OUT_OF_ORDER",
      "false:2:UNEXPECTED_INDEX",
      "false:3:DUPLICATE_INDEX",
      "false:3:MISSING_INDEX",
      "false:1:UNEXPECTED_INDEX",
    ]);
  });

  it("ownership evidence qualifies only when every part of it was readable, written and consistent", () => {
    const record = (index: number) => ownershipRecord({ ownershipId: RUN, index, pid: 4000 + index, pgid: 4000 + index, startIdentity: "Mon Oct 12 03:45:30 2026" });
    const records = (...indices: number[]) => ({ ok: true as const, records: indices.map((index) => record(index)).filter((entry) => entry !== null) });
    const good: OwnershipFacts = {
      boundaryProcessIdentity: "READABLE",
      sweepReadable: true,
      identityChecks: { confirmed: 4, notOurs: 0, exited: 2, unreadable: 0 },
      failedSnapshots: 0,
      failedRecordWrites: 0,
      registration: records(1, 2, 3),
      pgidMismatches: 0,
      expectedApplications: 3,
    };
    expect(qualifyOwnership(good)).toEqual({ ok: true, reasons: [], registered: 3, sequenceValid: true });
    // Processes that had simply exited before a signal are not a failure. Each of these is.
    const failing: Array<[Partial<OwnershipFacts>, string]> = [
      [{ boundaryProcessIdentity: "NOT_READABLE" }, "PROCESS_IDENTITY_NOT_VERIFIED_AT_THE_BOUNDARY"],
      [{ boundaryProcessIdentity: "NOT_RUN" }, "PROCESS_IDENTITY_NOT_VERIFIED_AT_THE_BOUNDARY"],
      [{ sweepReadable: false }, "IDENTITY_SWEEP_UNREADABLE"],
      [{ identityChecks: { confirmed: 4, notOurs: 0, exited: 0, unreadable: 1 } }, "IDENTITY_UNREADABLE_BEFORE_A_SIGNAL"],
      [{ identityChecks: { confirmed: 4, notOurs: 1, exited: 0, unreadable: 0 } }, "RECORDED_PROCESS_WITHOUT_THE_RUN_IDENTITY"],
      [{ failedSnapshots: 1 }, "PROCESS_SNAPSHOT_FAILED"],
      [{ failedRecordWrites: 1 }, "OWNERSHIP_RECORD_NOT_WRITTEN"],
      [{ pgidMismatches: 1 }, "REGISTERED_PROCESS_GROUP_DIFFERS"],
      [{ registration: { ok: false, reason: "UNREADABLE" } }, "REGISTRATION_UNREADABLE"],
      [{ registration: { ok: false, reason: "DUPLICATE_INDEX" } }, "REGISTRATION_DUPLICATE_INDEX"],
      [{ registration: records(1, 3, 2) }, "REGISTRATION_SEQUENCE_OUT_OF_ORDER"],
      [{ registration: records(1, 2, 3, 4) }, "MORE_REGISTRATIONS_THAN_EXPECTED"],
    ];
    expect(failing.filter(([change, reason]) => {
      const result = qualifyOwnership({ ...good, ...change });
      return result.ok || result.reasons.length !== 1 || result.reasons[0] !== reason;
    }).map(([, reason]) => reason)).toEqual([]);
    // A missing index is both a broken sequence and fewer registrations than a complete run.
    expect(qualifyOwnership({ ...good, registration: records(1, 3) })).toEqual({ ok: false, reasons: ["REGISTRATION_SEQUENCE_MISSING_INDEX", "FEWER_REGISTRATIONS_THAN_A_COMPLETE_RUN"], registered: 2, sequenceValid: false });
    // A run that stopped after its first start: one valid registration, described as that, not required to have
    // three, and not a complete run. A run that never spawned anything has none, validly.
    expect(qualifyOwnership({ ...good, registration: records(1) })).toEqual({ ok: false, reasons: ["FEWER_REGISTRATIONS_THAN_A_COMPLETE_RUN"], registered: 1, sequenceValid: true });
    expect(qualifyOwnership({ ...good, registration: records(), expectedApplications: 0 })).toEqual({ ok: true, reasons: [], registered: 0, sequenceValid: true });
    // Several failures are all named.
    expect(qualifyOwnership({ ...good, sweepReadable: false, failedSnapshots: 2, pgidMismatches: 1 }).reasons).toEqual(["IDENTITY_SWEEP_UNREADABLE", "PROCESS_SNAPSHOT_FAILED", "REGISTERED_PROCESS_GROUP_DIFFERS"]);
  });

  it("a final outcome line that cannot be written cannot leave a pass, and nothing required is written after the verdict's inputs are fixed", () => {
    const order: string[] = [];
    const run = (options: { failLog?: boolean; failFinish?: boolean; scan?: { complete: boolean; clean: boolean } | "throws"; evidenceSoFar?: boolean; failResult?: boolean }) => {
      order.length = 0;
      let seenByResult: unknown = null;
      const logger = createSafeLogger(
        (text) => {
          order.push(`log ${text.split("\n").length - 1}`);
          if (options.failLog) throw new Error(`log volume gone near ${SECRET_A}`);
        },
        () => undefined,
        () => {
          order.push("log closed");
          if (options.failFinish) throw new Error("flush failed");
        },
      );
      const conclusion = concludeRun({
        outcomes: { boundary: true, suite: true, cleanup: true },
        evidenceSoFar: options.evidenceSoFar ?? true,
        logger,
        finalLines: ["=== OUTCOMES", "boundary ok; suite ok; cleanup ok"],
        scan: () => {
          order.push("scan");
          if (options.scan === "throws") throw new Error("scan broke");
          return options.scan ?? { complete: true, clean: true };
        },
        writers: {
          result(conclusionSoFar) {
            order.push("result");
            seenByResult = conclusionSoFar;
            if (options.failResult) throw new Error("cannot write result");
          },
          manifest() {
            order.push("manifest");
          },
        },
      });
      // After the conclusion the log is closed: a later line is not written, and is counted.
      logger.log("too late");
      return { conclusion, seenByResult, lateFailures: logger.failures() };
    };

    const good = run({});
    expect(good.conclusion).toEqual({ boundary: true, suite: true, cleanup: true, evidence: true, resultPersisted: true, manifestPersisted: true, passed: true, logFailures: 0, scanComplete: true, scanClean: true });
    // The order: final lines, close, scan, result, manifest. Nothing is logged after the close.
    expect(order).toEqual(["log 2", "log closed", "scan", "result", "manifest"]);
    expect(good.lateFailures).toBe(1);
    // The result file is written with the final values, the log count and the scan among them.
    expect(good.seenByResult).toEqual({ boundary: true, suite: true, cleanup: true, evidence: true, logFailures: 0, scanComplete: true, scanClean: true });

    // The final outcome lines could not be written: not a pass, although everything else held and both files were written.
    const lostLines = run({ failLog: true });
    expect({ passed: lostLines.conclusion.passed, evidence: lostLines.conclusion.evidence, logFailures: lostLines.conclusion.logFailures, files: lostLines.conclusion.resultPersisted && lostLines.conclusion.manifestPersisted }).toEqual({ passed: false, evidence: false, logFailures: 1, files: true });
    expect(lostLines.seenByResult).toMatchObject({ evidence: false, logFailures: 1 });
    // The log could not be flushed and closed: the same.
    expect(run({ failFinish: true }).conclusion).toMatchObject({ passed: false, evidence: false, logFailures: 1 });
    // The scan was incomplete, found something, or failed: not a pass.
    expect([run({ scan: { complete: false, clean: false } }), run({ scan: { complete: true, clean: false } }), run({ scan: "throws" })].map((entry) => `${entry.conclusion.passed}:${entry.conclusion.scanComplete}:${entry.conclusion.scanClean}`)).toEqual(["false:false:false", "false:true:false", "false:false:false"]);
    // An incomplete scan is never clean, whatever it claims.
    expect(run({ scan: { complete: false, clean: true } }).conclusion).toMatchObject({ passed: false, evidence: false });
    // Evidence that already failed before the end stays failed; and a result that cannot be written is not a pass.
    expect(run({ evidenceSoFar: false }).conclusion).toMatchObject({ passed: false, evidence: false, logFailures: 0 });
    expect(run({ failResult: true }).conclusion).toMatchObject({ passed: false, evidence: true, resultPersisted: false, manifestPersisted: true });
  });

  it("cleanup continues through a logger that fails, a step that throws and a step that never settles", async () => {
    const written: string[] = [];
    let logWorks = false;
    const logger = createSafeLogger((text) => {
      if (!logWorks) throw new Error(`log volume gone near ${SECRET_A}`);
      written.push(text);
    });
    const ran: string[] = [];
    const step = (name: string, run: () => Promise<{ ok: boolean; note: string }>) => ({
      name,
      timeoutMs: 1_000,
      run: () => {
        ran.push(name);
        return run();
      },
    });
    const running = runBoundedSteps(
      [
        step("terminate owned processes", async () => ({ ok: true, note: "none alive" })),
        step("inspect the driver result", async () => {
          throw new Error(`unreadable ${SECRET_B}`);
        }),
        step("record the post-run catalog", () => new Promise(() => undefined)),
        step("stop PostgreSQL", async () => ({ ok: false, note: "not positively identified" })),
        step("confirm the stopped state", async () => ({ ok: true, note: "stopped" })),
      ],
      logger,
      { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const outcomes = await running;
    // Every step ran, in order, although no log line could be written and two steps did not finish.
    expect(ran).toEqual(["terminate owned processes", "inspect the driver result", "record the post-run catalog", "stop PostgreSQL", "confirm the stopped state"]);
    expect(outcomes.map((outcome) => `${outcome.state}:${outcome.ok}`)).toEqual(["DONE:true", "THREW:false", "TIMED_OUT:false", "FAILED:false", "DONE:true"]);
    // The logging failures are counted apart, and nothing was thrown by the logger.
    expect({ failures: logger.failures(), written: written.length }).toEqual({ failures: 5, written: 0 });
    expect(says(JSON.stringify(outcomes), SECRET_A) || says(JSON.stringify(outcomes), SECRET_B) || says(JSON.stringify(outcomes), "unreadable")).toBe(false);

    logWorks = true;
    logger.log("one", "two");
    expect({ failures: logger.failures(), written }).toEqual({ failures: 5, written: ["one\ntwo\n"] });
    // An echo that throws does not count as a lost record and does not escape.
    const echoing = createSafeLogger(() => undefined, () => {
      throw new Error("terminal gone");
    });
    echoing.log("line");
    expect(echoing.failures()).toBe(0);
  });

  it("a run passes only when all four outcomes hold and both the result and the manifest were written", () => {
    const all = { boundary: true, suite: true, cleanup: true, evidence: true };
    const order: string[] = [];
    const writers = (failing: string | null) => ({
      result() {
        order.push("result");
        if (failing === "result") throw new Error(`cannot write result near ${SECRET_A}`);
      },
      manifest() {
        order.push("manifest");
        if (failing === "manifest") throw new Error("cannot write manifest");
      },
    });
    expect(finalize(all, writers(null))).toEqual({ ...all, resultPersisted: true, manifestPersisted: true, passed: true });
    // The result first, then the manifest that lists it.
    expect(order).toEqual(["result", "manifest"]);
    // A result that could not be persisted is not a pass; the manifest is still attempted.
    order.length = 0;
    expect(finalize(all, writers("result"))).toEqual({ ...all, resultPersisted: false, manifestPersisted: true, passed: false });
    expect(order).toEqual(["result", "manifest"]);
    expect(finalize(all, writers("manifest"))).toEqual({ ...all, resultPersisted: true, manifestPersisted: false, passed: false });
    // Each outcome is necessary, and each stays visible apart from the others.
    for (const name of ["boundary", "suite", "cleanup", "evidence"] as const) {
      const verdict = finalize({ ...all, [name]: false }, writers(null));
      expect({ passed: verdict.passed, own: verdict[name], others: (["boundary", "suite", "cleanup", "evidence"] as const).filter((other) => other !== name).every((other) => verdict[other]) }).toEqual({ passed: false, own: false, others: true });
    }
    expect(finalize({ ...all, evidence: "yes" as unknown as boolean }, writers(null)).passed).toBe(false);
  });

  it("an addition, removal or change of any path outside the permitted generated areas is detected, ignored or not", () => {
    expect(
      ["next-env.d.ts", ".next/dev/types/routes.d.ts", ".next/cache/x", "node_modules/.vite/vitest/results.json", ".env", ".env.local", "config/.env.production", "certs/dev.pem", "node_modules/next/package.json", "node_modules/.vitest/x", "tsconfig.tsbuildinfo", "AGENTS.md", "src/app/layout.tsx", ".nextish/x", "next-env.d.ts.bak"].map(
        (path) => `${path}=${classifyPath(path)}`,
      ),
    ).toEqual([
      "next-env.d.ts=PERMITTED_GENERATED",
      ".next/dev/types/routes.d.ts=PERMITTED_GENERATED",
      ".next/cache/x=PERMITTED_GENERATED",
      "node_modules/.vite/vitest/results.json=PERMITTED_GENERATED",
      ".env=CREDENTIAL_LIKE",
      ".env.local=CREDENTIAL_LIKE",
      "config/.env.production=CREDENTIAL_LIKE",
      "certs/dev.pem=CREDENTIAL_LIKE",
      "node_modules/next/package.json=DEPENDENCY",
      "node_modules/.vitest/x=DEPENDENCY",
      "tsconfig.tsbuildinfo=ORDINARY",
      "AGENTS.md=ORDINARY",
      "src/app/layout.tsx=ORDINARY",
      ".nextish/x=ORDINARY",
      "next-env.d.ts.bak=ORDINARY",
    ]);

    const before = new Map([
      ["AGENTS.md", "hash-a"],
      ["tsconfig.json", "hash-b"],
      ["tsconfig.tsbuildinfo", "hash-c"],
      ["node_modules/next/package.json", "120:1"],
      [".env.local", "64:1"],
      ["next-env.d.ts", "hash-d"],
      [".next/types/routes.d.ts", "hash-e"],
    ]);
    const after = new Map([
      // Permitted: generated areas change, appear and disappear freely.
      ["next-env.d.ts", "hash-d2"],
      [".next/dev/server/chunk.js", "hash-new"],
      ["node_modules/.vite/vitest/results.json", "hash-new"],
      // Not permitted, although every one of these is ignored by git or looks harmless.
      ["tsconfig.json", "hash-b2"],
      ["tsconfig.tsbuildinfo", "hash-c2"],
      ["node_modules/next/package.json", "121:2"],
      ["node_modules/evil/index.js", "10:3"],
      [".env.local", "65:2"],
      [".env.production", "12:3"],
      ["scratch/ignored-output.log", "hash-f"],
    ]);
    expect(compareListings(before, after)).toEqual({
      added: [".env.production", "node_modules/evil/index.js", "scratch/ignored-output.log"],
      removed: ["AGENTS.md"],
      changed: [".env.local", "node_modules/next/package.json", "tsconfig.json", "tsconfig.tsbuildinfo"],
    });
    expect(compareListings(before, new Map(before))).toEqual({ added: [], removed: [], changed: [] });
  });

  it("the ownership identity reaches every application, and the helper stays loadable by plain Node", () => {
    const application = Object.fromEntries(APPLICATION_CONFIGURATION_VARIABLES.map((name) => [name, `value-of-${name}`]));
    const parent = { PATH: "/usr/bin", [OWNERSHIP_ID_VARIABLE]: OTHER_RUN, OPENAI_API_KEY: "sk-not-inherited" };
    const withIdentity = childEnvironment(parent, application, RUN);
    // The identity given, never one inherited from the parent; and nothing else is added.
    expect(withIdentity[OWNERSHIP_ID_VARIABLE]).toBe(RUN);
    expect(Object.keys(withIdentity).sort()).toEqual(["PATH", ...APPLICATION_CONFIGURATION_VARIABLES, "NODE_ENV", "NEXT_TELEMETRY_DISABLED", OWNERSHIP_ID_VARIABLE].sort());
    expect(OWNERSHIP_ID_VARIABLE in childEnvironment(parent, application)).toBe(false);
    expect(() => childEnvironment(parent, application, "not-an-identity")).toThrow(`Not an ownership identity: ${OWNERSHIP_ID_VARIABLE}`);

    // The wrapper loads this very file with plain Node, which removes types and does nothing else: so the file
    // may import nothing local and may use no syntax that needs compiling.
    const helper = readFileSync(join(ROOT, "tests", "integration", "run-evidence.ts"), "utf8");
    expect([...helper.matchAll(/^import [^\n]* from "([^"]+)";$/gm)].map((match) => match[1])).toEqual(["node:crypto"]);
    expect(/^\s*(?:export\s+)?(?:const\s+)?enum\s|^\s*(?:export\s+)?namespace\s|^\s*import\s+\w+\s*=|constructor\([^)]*\b(?:public|private|protected|readonly)\s/m.test(helper)).toBe(false);
    expect(/process\.|node:fs|node:net|node:http|node:child_process|from "vitest"|console\./.test(helper)).toBe(false);
  });
});

/** Runs something that should throw; says whether it did, and nothing about what was thrown. */
function failureOfThrow(work: () => void): { threw: boolean } {
  try {
    work();
    return { threw: false };
  } catch {
    return { threw: true };
  }
}
