import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { createWriteStream, statSync } from "node:fs";
import { request as sendHttpRequest } from "node:http";
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { CodedFailure, FAILURE_CATEGORIES, FAILURE_CODES, UNLISTED_STEP, boundedCount, classifyFailure, cleanupStepName, describeFailureClass, inspectFacts, trustedFailure, type FailureCategory, type FailureClass } from "./safe-diagnostics";

/**
 * Helpers of the HTTP and application-restart integration driver (specification 19.19, Increment 2.3).
 *
 * NEVER RUN against a real process, port or network. Importing this module starts nothing, opens nothing and
 * reads no environment variable.
 *
 * Two parts, kept apart:
 *  1. Lifecycle logic, written against injected dependencies (`ProcessDeps`, `Transport`): starting the application,
 *     the startup deadline, early-exit detection, shutdown with escalation, the request deadline, settlement of
 *     every request, cleanup that continues after a failure, the child environment, and the input check. The
 *     database-free unit suite exercises these with fakes.
 *  2. The real dependencies (`realProcessDeps`, `loopbackTransport`), which spawn, signal, connect and write. Only
 *     the integration driver calls them, and only after its inputs were accepted.
 *
 * Ownership. The driver owns its application child processes, its HTTP requests and its application logs. It does
 * not provision, verify, snapshot or stop a PostgreSQL cluster: that belongs to the execution gate's wrapper.
 *
 * Hostname and bind address. The application is bound to 127.0.0.1 only. Requests are sent to that address, and
 * name the approved origin, http://localhost:3170, in their Host and Origin headers: what a browser at that origin
 * sends once `localhost` has resolved to 127.0.0.1. Connecting by address avoids depending on how the machine
 * resolves `localhost`. This is a synthetic client: it stores no cookie by a browser's rules and says nothing about
 * whether a browser accepts the Secure, `__Host-` cookie from that origin.
 */

export const APPLICATION_BIND_HOST = "127.0.0.1";
export const APPLICATION_PORT = 3170;
export const APPLICATION_HOST_HEADER = `localhost:${APPLICATION_PORT}`;
export const APPLICATION_ORIGIN = `http://${APPLICATION_HOST_HEADER}`;

export const STARTUP_DEADLINE_MS = 60_000;
export const REQUEST_DEADLINE_MS = 15_000;
export const STOP_GRACE_MS = 5_000;
const STARTUP_POLL_MS = 250;
const STOP_POLL_MS = 50;
const RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Inputs: explicit authorization, and nothing opened without it
// ---------------------------------------------------------------------------

export const AUTHORIZATION_VARIABLE = "SHOPACCESS_APP_TEST_AUTHORIZATION";
/** The one accepted value. It names this driver, so an authorization for something else is not accepted. */
export const AUTHORIZATION_VALUE = "increment-2.3-http-restart";
/** Must repeat the application port, as the harness requires of the database port. */
export const AUTHORIZED_APP_PORT_VARIABLE = "SHOPACCESS_APP_TEST_AUTHORIZED_PORT";
/** An existing private directory (mode 700) outside the repository: the application logs and the cleanup result. */
export const EVIDENCE_DIRECTORY_VARIABLE = "SHOPACCESS_APP_TEST_EVIDENCE_DIR";
/** The PostgreSQL server log of the cluster the gate provisioned. Read at the end, for the secret scan only. */
export const SERVER_LOG_VARIABLE = "SHOPACCESS_APP_TEST_SERVER_LOG";

/**
 * The run-specific ownership identity: 32 lower-case hex digits, made by the execution wrapper for one run. The
 * runner is given it under this name, and so is every application the driver starts, so that each process of a run
 * carries it in its environment and can be told from any other process, whatever its pid is later reused for.
 */
export const OWNERSHIP_ID_VARIABLE = "SHOPACCESS_APP_TEST_OWNERSHIP_ID";
const OWNERSHIP_ID = /^[0-9a-f]{32}$/;

export type Environment = Readonly<Record<string, string | undefined>>;

export interface PathFacts {
  readonly exists: boolean;
  readonly directory: boolean;
  /** Permission bits only. */
  readonly mode: number;
}

export function inspectPath(path: string): PathFacts {
  try {
    const stats = statSync(path);
    return { exists: true, directory: stats.isDirectory(), mode: stats.mode & 0o777 };
  } catch {
    return { exists: false, directory: false, mode: 0 };
  }
}

export type IntegrationInputs =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "INVALID"; readonly problems: readonly string[] }
  | { readonly kind: "AUTHORIZED"; readonly evidenceDirectory: string; readonly serverLog: string; readonly ownershipId: string };

/**
 * Decides whether the driver may do anything at all. ABSENT only while the authorization variable is not set at
 * all: then every case is skipped. Once it is set, everything is required, and each problem names a variable,
 * never a value. Nothing is opened, generated or started on ABSENT or INVALID.
 */
export function readIntegrationInputs(
  env: Environment,
  options: { readonly databaseVariables: readonly string[]; readonly repositoryRoot: string; readonly inspect?: (path: string) => PathFacts },
): IntegrationInputs {
  if (env[AUTHORIZATION_VARIABLE] === undefined) return { kind: "ABSENT" };
  const inspect = options.inspect ?? inspectPath;
  const problems: string[] = [];

  if (env[AUTHORIZATION_VARIABLE] !== AUTHORIZATION_VALUE) problems.push(`${AUTHORIZATION_VARIABLE}: not the accepted value`);
  if (env[AUTHORIZED_APP_PORT_VARIABLE] !== String(APPLICATION_PORT)) problems.push(`${AUTHORIZED_APP_PORT_VARIABLE}: must repeat the application port`);
  for (const name of options.databaseVariables) {
    if (env[name] === undefined || env[name] === "") problems.push(`${name}: not set`);
  }
  const ownershipId = env[OWNERSHIP_ID_VARIABLE] ?? "";
  if (!OWNERSHIP_ID.test(ownershipId)) problems.push(`${OWNERSHIP_ID_VARIABLE}: 32 lower-case hex digits are required`);

  const outsideRepository = (path: string): boolean => path !== options.repositoryRoot && !path.startsWith(`${options.repositoryRoot}/`);
  const evidenceDirectory = env[EVIDENCE_DIRECTORY_VARIABLE] ?? "";
  if (evidenceDirectory === "" || !isAbsolute(evidenceDirectory)) {
    problems.push(`${EVIDENCE_DIRECTORY_VARIABLE}: an absolute path is required`);
  } else if (!outsideRepository(evidenceDirectory)) {
    problems.push(`${EVIDENCE_DIRECTORY_VARIABLE}: must be outside the repository`);
  } else {
    const facts = inspect(evidenceDirectory);
    if (!facts.exists || !facts.directory) problems.push(`${EVIDENCE_DIRECTORY_VARIABLE}: not an existing directory`);
    else if (facts.mode !== 0o700) problems.push(`${EVIDENCE_DIRECTORY_VARIABLE}: the directory must have mode 700`);
  }

  const serverLog = env[SERVER_LOG_VARIABLE] ?? "";
  if (serverLog === "" || !isAbsolute(serverLog)) {
    problems.push(`${SERVER_LOG_VARIABLE}: an absolute path is required`);
  } else if (!outsideRepository(serverLog)) {
    problems.push(`${SERVER_LOG_VARIABLE}: must be outside the repository`);
  } else {
    const facts = inspect(serverLog);
    if (!facts.exists || facts.directory) problems.push(`${SERVER_LOG_VARIABLE}: not an existing file`);
  }

  if (problems.length > 0) return { kind: "INVALID", problems };
  return { kind: "AUTHORIZED", evidenceDirectory, serverLog, ownershipId };
}

// ---------------------------------------------------------------------------
// The child environment: an allowlist
// ---------------------------------------------------------------------------

/** Operating-system and runtime variables the child may inherit. Nothing else is inherited. */
export const CHILD_PASSTHROUGH_VARIABLES: readonly string[] = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"];

/** The application configuration the driver constructs privately. All six are required, and no other name is accepted. */
export const APPLICATION_CONFIGURATION_VARIABLES: readonly string[] = [
  "SHOPACCESS_PERSISTENCE_MODE",
  "SHOPACCESS_DATABASE_URL",
  "SHOPACCESS_SESSION_KEYS",
  "SHOPACCESS_NONCE_KEYS",
  "SHOPACCESS_TRUSTED_ORIGINS",
  "PAYMENT_PROVIDER_MODE",
];

/** Set by the helper itself. Development mode is what admits the plain-HTTP loopback origin; telemetry is off. */
export const CHILD_FIXED_VARIABLES: Readonly<Record<string, string>> = Object.freeze({ NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" });

/**
 * Builds the whole environment of an application child. The parent contributes the passthrough names only; every
 * database, payment, AI or other setting of the parent is left behind, whatever it is called. An error names
 * variables, never values.
 */
export function childEnvironment(parent: Environment, application: Readonly<Record<string, string>>, ownershipId?: string): Record<string, string> {
  if (ownershipId !== undefined && !OWNERSHIP_ID.test(ownershipId)) throw new TypeError(`Not an ownership identity: ${OWNERSHIP_ID_VARIABLE}`);
  const given = Object.keys(application).sort();
  const unexpected = given.filter((name) => !APPLICATION_CONFIGURATION_VARIABLES.includes(name));
  if (unexpected.length > 0) throw new TypeError(`Not an application configuration variable: ${unexpected.join(", ")}`);
  const missing = APPLICATION_CONFIGURATION_VARIABLES.filter((name) => typeof application[name] !== "string" || application[name] === "");
  if (missing.length > 0) throw new TypeError(`Application configuration is incomplete: ${missing.join(", ")}`);

  const environment: Record<string, string> = {};
  for (const name of CHILD_PASSTHROUGH_VARIABLES) {
    const value = parent[name];
    if (typeof value === "string" && value !== "") environment[name] = value;
  }
  for (const name of APPLICATION_CONFIGURATION_VARIABLES) environment[name] = application[name];
  for (const [name, value] of Object.entries(CHILD_FIXED_VARIABLES)) environment[name] = value;
  // The one further name: the run's ownership identity, when the caller has one. It is not a secret.
  if (ownershipId !== undefined) environment[OWNERSHIP_ID_VARIABLE] = ownershipId;
  return environment;
}

/** The installed framework's own entry script, run by this Node executable. No package runner, nothing downloaded. */
export function applicationCommand(repositoryRoot: string, nodeExecutable: string): { readonly command: string; readonly args: readonly string[] } {
  return {
    command: nodeExecutable,
    args: [`${repositoryRoot}/node_modules/next/dist/bin/next`, "dev", "--hostname", APPLICATION_BIND_HOST, "--port", String(APPLICATION_PORT)],
  };
}

// ---------------------------------------------------------------------------
// The application process
// ---------------------------------------------------------------------------

export interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** True when the process could not be started at all. */
  readonly spawnError: boolean;
}

export interface OwnedChild {
  /** Undefined when the process could not be started. The child leads its own process group. */
  readonly pid: number | undefined;
  onOutput(listener: (chunk: Buffer) => void): void;
  /** Called once: when the process exits, or when it could not be started. */
  onExit(listener: (exit: ChildExit) => void): void;
}

export interface LogSink {
  write(chunk: Buffer): void;
  /** Called for every failure to open or write. */
  onFailure(listener: () => void): void;
  /** The failures so far, as short codes. Never file content. */
  failures(): readonly string[];
  close(): Promise<void>;
}

export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type StopSignal = "SIGTERM" | "SIGKILL";

export interface ProcessDeps {
  spawn(spec: SpawnSpec): OwnedChild;
  /** Signals the child's whole process group, so that a process the child started is signalled too. */
  signalGroup(pid: number, signal: StopSignal): void;
  /** Whether any process of the child's group still exists. */
  groupAlive(pid: number): boolean;
  portInUse(host: string, port: number): Promise<boolean>;
  /** One readiness attempt. It must create nothing: no session and no checkout. */
  probe(signal: AbortSignal): Promise<boolean>;
  openLog(path: string): LogSink;
}

export type StartupFailure = "STARTUP_CANCELLED" | "PORT_IN_USE" | "SPAWN_FAILED" | "EXITED_EARLY" | "STARTUP_DEADLINE" | "LOG_CAPTURE_FAILED" | "REGISTRATION_FAILED";
const STARTUP_FAILURES: readonly StartupFailure[] = ["STARTUP_CANCELLED", "PORT_IN_USE", "SPAWN_FAILED", "EXITED_EARLY", "STARTUP_DEADLINE", "LOG_CAPTURE_FAILED", "REGISTRATION_FAILED"];

export interface StopResult {
  /** True only when no process of the group remains, the port is free and the log closed without a failure. */
  readonly stopped: boolean;
  readonly signals: readonly StopSignal[];
  readonly exit: ChildExit | null;
  readonly processRemaining: boolean;
  readonly portFree: boolean;
  readonly logFailures: readonly string[];
  readonly problems: readonly string[];
}

/**
 * Why the application did not start. When a process had been started, `stop` is the result of the shutdown that
 * followed. The error carries no handle: a process that was spawned is retained in its `ApplicationOwner`, from
 * before anything could fail, and stays there whatever this error says.
 */
export class StartupError extends Error {
  readonly code: StartupFailure;
  readonly stop: StopResult | null;
  constructor(code: StartupFailure, stop: StopResult | null) {
    super(`The application did not start: ${code}${stop && !stop.stopped ? "; AND ITS STOP WAS NOT CLEAN (see the stop result)" : ""}`);
    this.name = "StartupError";
    this.code = code;
    this.stop = stop;
    STARTUP_STOPS.set(this, stop);
    STARTUP_CODES.set(this, code);
  }
}

/** The shutdown result of each startup failure made here, by identity. Read back without touching the error object. */
const STARTUP_STOPS = new WeakMap<object, StopResult | null>();
/** The startup code of each failure made here, by identity. Only this module's own fixed words can be in it. */
const STARTUP_CODES = new WeakMap<object, StartupFailure>();

/**
 * A failed start, for the runner: fixed words, the listed startup code, and whether the shutdown that followed was
 * clean, as booleans. Never throws, whatever it is given.
 */
export function describeStartupFailure(error: unknown): string {
  const known = typeof error === "object" && error !== null && STARTUP_STOPS.has(error);
  // A failure this module made is named by the code recorded when it was made, which is one of its own fixed words.
  const code = known ? STARTUP_CODES.get(error as object) : undefined;
  const failure = code !== undefined && STARTUP_FAILURES.includes(code) ? `category=STARTUP code=${code}` : describeFailureClass(classifyFailure(error));
  const stop = known ? (STARTUP_STOPS.get(error as object) ?? null) : null;
  let shutdown = "no process had been started";
  if (stop !== null) {
    shutdown = stop.stopped
      ? "the process that was started has been stopped"
      : `THE SHUTDOWN AFTER THE FAILURE WAS NOT CLEAN (processRemaining=${stop.processRemaining === true} portFree=${stop.portFree === true}); the process stays owned and final cleanup will try once more`;
  }
  return `application start failed [${failure}]; ${shutdown}`;
}

export interface ApplicationHandle {
  readonly pid: number | undefined;
  /** The exit, once the process has exited. */
  exit(): ChildExit | null;
  /** Failures of log capture so far. A case checks this; an empty list is required. */
  logFailures(): readonly string[];
  /**
   * Stops the process group: SIGTERM, then SIGKILL after five seconds; ten seconds at most. Never throws.
   * A clean stop is final: asking again returns the same result and signals nothing. A stop that was NOT clean is
   * not remembered as the answer: asking again makes another bounded attempt on the same group. Calls made while
   * an attempt is running share that attempt.
   */
  stop(): Promise<StopResult>;
  /** Every attempt made so far, in order, with its outcome. */
  stopAttempts(): readonly StopResult[];
}

/**
 * Holds every application that was spawned under it, from the moment of the spawn. The handles are retained by
 * `startApplication` itself, in a list only this module can reach: retention needs no callback, cannot be skipped
 * and cannot throw. Final cleanup reads the handles back with `owned()` and stops each one.
 */
export interface ApplicationOwner {
  /** A copy of the retained handles, in the order they were spawned. */
  owned(): readonly ApplicationHandle[];
}

const RETAINED = new WeakMap<ApplicationOwner, ApplicationHandle[]>();

export function createApplicationOwner(): ApplicationOwner {
  const retained: ApplicationHandle[] = [];
  const owner: ApplicationOwner = Object.freeze({ owned: () => [...retained] });
  RETAINED.set(owner, retained);
  return owner;
}

const PROCESS_OWNER = createApplicationOwner();
/** The process-wide owner's own list. It always exists, so there is always somewhere to retain a handle. */
const PROCESS_RETAINED: ApplicationHandle[] = RETAINED.get(PROCESS_OWNER) ?? [];

/** The owner of every application started without an owner of its own, or with something that is not one. */
export function processApplicationOwner(): ApplicationOwner {
  return PROCESS_OWNER;
}

/** The handles of several lists as one list without repeats, by identity, in first-seen order. */
export function uniqueHandles(...lists: ReadonlyArray<readonly ApplicationHandle[]>): ApplicationHandle[] {
  return [...new Set(lists.flat())];
}

export interface StartOptions {
  readonly signal?: AbortSignal;
  /**
   * Where the spawned application is retained. Made by `createApplicationOwner`. When it is absent, or is not such
   * an owner, the process-wide owner is used: a spawned application is always retained somewhere retrievable.
   */
  readonly owner?: ApplicationOwner;
  /**
   * Registers the spawned process in the run's private ownership record: pid, process group, start identity and
   * the run's ownership identity. Called once, synchronously, after the handle has been retained and before
   * `onSpawned` and before any startup work is awaited. It must throw when the record could not be made or
   * written. Then the handle stays retained, the start is abandoned as REGISTRATION_FAILED and the process is
   * stopped; nothing of what was thrown is kept. A start without it registers nothing.
   */
  readonly register?: (handle: ApplicationHandle) => void;
  /**
   * Called once, synchronously, after the handle has been retained and before any startup work is awaited: a
   * convenience for the caller's own bookkeeping. Ownership does not depend on it. If it throws, the handle is
   * already retained, startup is abandoned and the process is stopped; nothing of what it threw is kept.
   */
  readonly onSpawned?: (handle: ApplicationHandle) => void;
}

export interface StartSpec extends SpawnSpec {
  readonly host: string;
  readonly port: number;
  readonly logPath: string;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

/** The result of `work`, or false once `signal` aborts. A rejection is false. `work` is never left unhandled. */
function settledOrAborted(work: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const aborted = () => resolve(false);
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value === true);
      },
      () => {
        signal.removeEventListener("abort", aborted);
        resolve(false);
      },
    );
  });
}

/**
 * Starts the application and waits until it answers, for at most 60 seconds.
 *
 * Refuses before spawning when the port is already in use. Once a process is spawned, its handle is retained in
 * the owner at once, and then given to `onSpawned`. A failure of any kind after that (the process exits, the deadline passes, the caller
 * cancels, the log cannot be written) makes one bounded attempt to stop the process group and then throws a
 * `StartupError` with the result of that attempt. If the attempt did not stop it, the handle the owner retains
 * can try again.
 */
export async function startApplication(deps: ProcessDeps, spec: StartSpec, options: StartOptions = {}): Promise<ApplicationHandle> {
  if (options.signal?.aborted) throw new StartupError("STARTUP_CANCELLED", null);
  if (await deps.portInUse(spec.host, spec.port)) throw new StartupError("PORT_IN_USE", null);

  const log = deps.openLog(spec.logPath);
  let child: OwnedChild;
  try {
    child = deps.spawn({ command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env });
  } catch {
    await log.close().catch(() => undefined);
    throw new StartupError("SPAWN_FAILED", null);
  }

  let exit: ChildExit | null = null;
  const startup = new AbortController();

  child.onOutput((chunk) => log.write(chunk));
  child.onExit((seen) => {
    exit = seen;
    startup.abort(seen.spawnError ? "SPAWN_FAILED" : "EXITED_EARLY");
  });
  log.onFailure(() => startup.abort("LOG_CAPTURE_FAILED"));

  // Only this process group is ever signalled or examined. Nothing is done to whatever else may hold the port.
  const pid = child.pid;
  const attempts: StopResult[] = [];
  let running: Promise<StopResult> | null = null;
  let final: StopResult | null = null;
  let logClosed = false;

  const stopAttempt = async (): Promise<StopResult> => {
    const problems: string[] = [];
    /** No process of the group remains. A group that cannot be examined is treated as still there. */
    const gone = (): boolean => {
      if (pid === undefined) return true;
      try {
        return !deps.groupAlive(pid);
      } catch {
        if (!problems.includes("GROUP_CHECK_FAILED")) problems.push("GROUP_CHECK_FAILED");
        return false;
      }
    };
    const waitUntilGone = async (ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      while (!gone()) {
        if (Date.now() >= until) return false;
        await delay(STOP_POLL_MS);
      }
      return true;
    };
    const signals: StopSignal[] = [];
    const send = (signal: StopSignal): void => {
      if (pid === undefined) return;
      try {
        deps.signalGroup(pid, signal);
        signals.push(signal);
      } catch {
        problems.push(`SIGNAL_FAILED:${signal}`);
      }
    };
    // The group is examined, not the child alone: a process the child started may outlive it.
    if (!gone()) {
      send("SIGTERM");
      if (!(await waitUntilGone(STOP_GRACE_MS))) {
        send("SIGKILL");
        await waitUntilGone(STOP_GRACE_MS);
      }
    }
    const processRemaining = !gone();

    if (!logClosed) {
      try {
        await log.close();
        logClosed = true;
      } catch {
        problems.push("LOG_CLOSE_FAILED");
      }
    }
    const logFailures = [...log.failures()];

    let portFree = false;
    try {
      portFree = !(await deps.portInUse(spec.host, spec.port));
    } catch {
      problems.push("PORT_CHECK_FAILED");
    }
    const result: StopResult = {
      stopped: !processRemaining && portFree && logFailures.length === 0 && problems.length === 0,
      signals,
      exit,
      processRemaining,
      portFree,
      logFailures,
      problems,
    };
    attempts.push(result);
    return result;
  };

  const handle: ApplicationHandle = {
    pid,
    exit: () => exit,
    logFailures: () => log.failures(),
    stop() {
      // A clean stop is the answer for good. Anything else is never cached: the next call tries again.
      if (final !== null) return Promise.resolve(final);
      if (running === null) {
        const attempt: Promise<StopResult> = stopAttempt().then((result) => {
          if (result.stopped) final = result;
          if (running === attempt) running = null;
          return result;
        });
        running = attempt;
      }
      return running;
    },
    stopAttempts: () => [...attempts],
  };

  // Ownership begins here: after the spawn, before the caller's callback and before the first awaited step of
  // startup. The list is this module's own; adding to it involves no code of the caller.
  const retained = (options.owner === undefined ? undefined : RETAINED.get(options.owner)) ?? PROCESS_RETAINED;
  retained.push(handle);

  // Registration, required to succeed when it is asked for. It comes after retention, so a failure here loses
  // nothing: the handle is owned, and it is stopped below.
  let registrationFailed = false;
  if (options.register !== undefined) {
    try {
      options.register(handle);
    } catch {
      registrationFailed = true;
    }
  }

  let ownerRefused = false;
  try {
    options.onSpawned?.(handle);
  } catch {
    ownerRefused = true;
  }

  const deadline = setTimeout(() => startup.abort("STARTUP_DEADLINE"), STARTUP_DEADLINE_MS);
  const cancelled = () => startup.abort("STARTUP_CANCELLED");
  options.signal?.addEventListener("abort", cancelled, { once: true });
  try {
    if (pid === undefined) startup.abort("SPAWN_FAILED");
    if (registrationFailed) startup.abort("REGISTRATION_FAILED");
    // The caller's callback failed. The handle is retained all the same; the start is abandoned.
    if (ownerRefused) startup.abort("STARTUP_CANCELLED");
    if (log.failures().length > 0) startup.abort("LOG_CAPTURE_FAILED");
    while (!startup.signal.aborted) {
      const ready = await settledOrAborted(deps.probe(startup.signal), startup.signal);
      if (ready && !startup.signal.aborted) return handle;
      await delay(STARTUP_POLL_MS, startup.signal);
    }
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancelled);
  }

  const reason = startup.signal.reason as StartupFailure;
  throw new StartupError(reason, await handle.stop());
}

// ---------------------------------------------------------------------------
// HTTP: a deadline, cancellation and settlement for every request
// ---------------------------------------------------------------------------

export interface HttpRequestSpec {
  readonly method: "GET" | "POST";
  /** Path and query. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpReply {
  readonly status: number;
  /** Lower-case names. A header sent more than once keeps every value. */
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: string;
}

/** Sends one request. It must reject, or resolve, once `signal` aborts; the client does not depend on that. */
export type Transport = (spec: HttpRequestSpec, signal: AbortSignal) => Promise<HttpReply>;

export type RequestFailure = "REQUEST_DEADLINE" | "REQUEST_ABORTED" | "REQUEST_FAILED";

export type Settled =
  | { readonly ok: true; readonly reply: HttpReply }
  | { readonly ok: false; readonly code: RequestFailure; readonly request: string };

export class RequestError extends Error {
  readonly code: RequestFailure;
  constructor(code: RequestFailure, request: string) {
    super(`${code}: ${request}`);
    this.name = "RequestError";
    this.code = code;
  }
}

export interface HttpClient {
  /**
   * Sends a request once. The returned promise NEVER rejects: its handlers exist from the moment the request is
   * submitted, so no outcome can be left unhandled, whatever the caller does next. Nothing is sent a second time.
   */
  submit(spec: HttpRequestSpec): Promise<Settled>;
  /** `submit`, for a caller that wants a failure thrown. */
  request(spec: HttpRequestSpec): Promise<HttpReply>;
  outstanding(): number;
  /** Aborts every request that has not settled and waits until each has. Returns how many were aborted. */
  abortOutstanding(): Promise<number>;
}

const DEADLINE = Symbol("request deadline");

export function createHttpClient(transport: Transport, deadlineMs: number = REQUEST_DEADLINE_MS): HttpClient {
  const pending = new Map<AbortController, Promise<Settled>>();

  const submit = (spec: HttpRequestSpec): Promise<Settled> => {
    const controller = new AbortController();
    // Method and path without the query: enough to name the request, and never a form value.
    const request = `${spec.method} ${spec.path.split("?")[0]}`;
    const settled = new Promise<Settled>((resolve) => {
      const finish = (value: Settled): void => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", aborted);
        resolve(value);
      };
      const aborted = (): void => finish({ ok: false, code: controller.signal.reason === DEADLINE ? "REQUEST_DEADLINE" : "REQUEST_ABORTED", request });
      controller.signal.addEventListener("abort", aborted, { once: true });
      const timer = setTimeout(() => controller.abort(DEADLINE), deadlineMs);
      let sent: Promise<HttpReply>;
      try {
        sent = transport(spec, controller.signal);
      } catch {
        finish({ ok: false, code: "REQUEST_FAILED", request });
        return;
      }
      // Both handlers are attached here, at submission. A reply or an error that arrives after the request was
      // aborted is received and discarded: the request has already settled as aborted.
      sent.then(
        (reply) => finish({ ok: true, reply }),
        () => finish({ ok: false, code: "REQUEST_FAILED", request }),
      );
    });
    pending.set(controller, settled);
    void settled.then(() => pending.delete(controller));
    return settled;
  };

  return {
    submit,
    async request(spec) {
      const settled = await submit(spec);
      if (!settled.ok) throw new RequestError(settled.code, settled.request);
      return settled.reply;
    },
    outstanding: () => pending.size,
    async abortOutstanding() {
      const entries = [...pending.entries()];
      for (const [controller] of entries) controller.abort();
      await Promise.all(entries.map(([, settled]) => settled));
      return entries.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup that continues after a failure
// ---------------------------------------------------------------------------

export interface CleanupStep {
  /** One of the listed step names. Any other name is recorded as the placeholder. */
  readonly name: string;
  /** May return listed facts to record with a success. */
  run(): Promise<void | Readonly<Record<string, number | boolean>>> | void | Readonly<Record<string, number | boolean>>;
}

/**
 * What is recorded of one step. Of a failure: its category, a code when it is exactly a listed one, and how many
 * errors an aggregate held. Never the error's name, message, stack or cause, the errors inside an aggregate, or
 * any other property.
 */
export interface CleanupStepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly category: FailureCategory | null;
  readonly code: string | null;
  readonly errors: number;
  /** Listed facts only: those a step returned, or those the driver recorded when it raised a `CodedFailure`. */
  readonly facts: Readonly<Record<string, number | boolean>>;
  /** How many facts were offered and not kept. */
  readonly droppedFacts: number;
}

export interface CleanupResult {
  /** True only when every step succeeded and the result could be read in full. */
  readonly complete: boolean;
  /** True when a result handed to the serializer could not be examined. Always false from `runCleanup`. */
  readonly unreadable: boolean;
  readonly steps: readonly CleanupStepResult[];
}

const UNKNOWN_CLASS: FailureClass = { category: "UNKNOWN", code: null, members: 0 };

/**
 * Runs every step, in order, whatever the earlier ones did. Never throws.
 *
 * What a step throws is not trusted. It is classified by a function that cannot throw, and facts are taken only
 * from the private record the driver made when it raised the failure itself: the thrown value's prototype, getters
 * and properties are not consulted for them. Should even that go wrong, the step is recorded as UNKNOWN with no
 * facts, and the next step runs.
 */
export async function runCleanup(steps: readonly CleanupStep[]): Promise<CleanupResult> {
  const results: CleanupStepResult[] = [];
  for (const step of steps) {
    let name = UNLISTED_STEP;
    try {
      name = cleanupStepName(step.name);
      const returned = inspectFacts(await step.run());
      results.push({ name, ok: true, category: null, code: null, errors: 0, facts: returned.facts, droppedFacts: returned.dropped });
    } catch (error) {
      let failure = UNKNOWN_CLASS;
      let facts: Readonly<Record<string, number | boolean>> = {};
      let droppedFacts = 0;
      try {
        failure = classifyFailure(error);
        const raised = trustedFailure(error);
        if (raised !== null) {
          facts = { ...raised.facts };
          droppedFacts = raised.dropped;
        }
      } catch {
        failure = UNKNOWN_CLASS;
        facts = {};
        droppedFacts = 0;
      }
      results.push({ name, ok: false, category: failure.category, code: failure.code, errors: failure.members, facts, droppedFacts });
    }
  }
  return { complete: results.every((result) => result.ok), unreadable: false, steps: results };
}

const UNREADABLE_STEP: CleanupStepResult = { name: UNLISTED_STEP, ok: false, category: "CLEANUP", code: "CLEANUP_RESULT_UNREADABLE", errors: 0, facts: {}, droppedFacts: 0 };
const MAX_SERIALIZED_STEPS = 16;

/** An own, plain data property, or undefined when there is none. An accessor is refused without being called. */
function ownData(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new TypeError("accessor");
  return descriptor.value;
}

/**
 * Any value as a cleanup result of the fixed shape, built again from nothing but the exact lists: listed step
 * names or the placeholder, booleans, listed categories and codes, bounded counts and listed facts. Only own,
 * plain data properties are read; a getter is never called. Never throws: a step that cannot be examined becomes
 * the fixed unreadable step, and a result that cannot be examined at all becomes the fixed unreadable result.
 * Either way `complete` is false.
 */
export function projectCleanupResult(result: unknown): CleanupResult {
  try {
    if (typeof result !== "object" || result === null) return { complete: false, unreadable: true, steps: [] };
    const list = ownData(result, "steps");
    if (!Array.isArray(list)) return { complete: false, unreadable: true, steps: [] };
    const length = boundedCount(ownData(list, "length"), -1);
    let unreadable = length < 0 || length > MAX_SERIALIZED_STEPS;
    const steps: CleanupStepResult[] = [];
    for (let index = 0; index < Math.min(Math.max(length, 0), MAX_SERIALIZED_STEPS); index += 1) {
      try {
        const step = ownData(list, String(index));
        if (typeof step !== "object" || step === null) throw new TypeError("not a step");
        const ok = ownData(step, "ok") === true;
        const category = ownData(step, "category");
        const code = ownData(step, "code");
        const facts = inspectFacts(ownData(step, "facts"));
        steps.push({
          name: cleanupStepName(ownData(step, "name")),
          ok,
          category: ok ? null : (FAILURE_CATEGORIES.find((listed) => listed === category) ?? "UNKNOWN"),
          code: !ok && typeof code === "string" && FAILURE_CODES.has(code) ? code : null,
          errors: boundedCount(ownData(step, "errors")),
          facts: facts.facts,
          droppedFacts: boundedCount(boundedCount(ownData(step, "droppedFacts")) + facts.dropped),
        });
      } catch {
        unreadable = true;
        steps.push(UNREADABLE_STEP);
      }
    }
    return { complete: !unreadable && steps.every((step) => step.ok), unreadable, steps };
  } catch {
    return { complete: false, unreadable: true, steps: [] };
  }
}

/** The text of `cleanup-result.json`: the projection above, and nothing else. Never throws. */
export function serializeCleanupResult(result: unknown): string {
  return `${JSON.stringify(projectCleanupResult(result), null, 2)}\n`;
}

export interface CleanupRecord {
  readonly written: boolean;
  /** Why the result could not be written, by class; null when it was. */
  readonly failure: FailureClass | null;
}

/** Hands the serialized result to `write`. Never throws: a writer that fails is reported by class. */
export function recordCleanupResult(result: unknown, write: (text: string) => void): CleanupRecord {
  try {
    write(serializeCleanupResult(result));
    return { written: true, failure: null };
  } catch (error) {
    return { written: false, failure: classifyFailure(error) };
  }
}

/**
 * One line for the runner: the listed names of the failed steps, each with its class; how many steps report a
 * process that remains; whether the result could be read; and whether its file was written. Never throws.
 */
export function describeCleanup(result: unknown, record: CleanupRecord): string {
  const safe = projectCleanupResult(result);
  const failed = safe.steps.filter((step) => !step.ok).map((step) => `${step.name} [${describeFailureClass({ category: step.category ?? "UNKNOWN", code: step.code, members: step.errors })}]`);
  const remaining = safe.steps.filter((step) => step.facts.processRemaining === true || step.code === "PROCESS_REMAINING").length;
  const writer = record.written === true ? "written" : `NOT WRITTEN [${describeFailureClass(record.failure ?? UNKNOWN_CLASS)}]`;
  return `Failed steps: ${failed.length === 0 ? "none" : failed.join("; ")}. Steps reporting a process that remains: ${remaining}.${safe.unreadable ? " THE RESULT COULD NOT BE READ IN FULL." : ""} Result file: ${writer}.`;
}

/**
 * The cleanup step that stops one owned application: one more bounded attempt on its own process group, unless it
 * was already stopped cleanly. Every attempt made on the handle, at startup, in a case or here, is counted in the
 * facts. A process that remains is the failure PROCESS_REMAINING; any other unclean stop is APPLICATION_NOT_STOPPED.
 */
export function applicationCleanupStep(handle: ApplicationHandle, name: string): CleanupStep {
  return {
    name,
    run: async () => {
      const processRemainedAfterEarlierAttempt = handle.stopAttempts().some((attempt) => attempt.processRemaining);
      const result = await handle.stop();
      const attempts = handle.stopAttempts();
      const facts = {
        stopped: result.stopped,
        processRemaining: result.processRemaining,
        portFree: result.portFree,
        processRemainedAfterEarlierAttempt,
        signalsSent: attempts.reduce((total, attempt) => total + attempt.signals.length, 0),
        logFailures: result.logFailures.length,
        problems: result.problems.length,
        stopAttempts: attempts.length,
        failedStopAttempts: attempts.filter((attempt) => !attempt.stopped).length,
      };
      if (result.processRemaining) throw new CodedFailure("PROCESS_REMAINING", facts);
      if (!result.stopped) throw new CodedFailure("APPLICATION_NOT_STOPPED", facts);
      return facts;
    },
  };
}

// ---------------------------------------------------------------------------
// Reading responses
// ---------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-z]+));/g, (whole, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return name !== undefined && name in ENTITIES ? ENTITIES[name] : whole;
  });
}

/** The attributes of one start tag, by name, whatever their order. */
export function attributesOf(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/**
 * The text a reader would be given: scripts, styles and comments removed, tags removed, entities decoded, white
 * space collapsed. Removing scripts matters: the framework repeats page content inside them.
 */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export interface ParsedForm {
  readonly action: string;
  readonly method: string;
  /** The hidden inputs, by name. */
  readonly hidden: Readonly<Record<string, string>>;
  /** The names of the other named inputs. */
  readonly controls: readonly string[];
}

/** Every form of a page outside its scripts, read by tag and attribute, never by attribute order. */
export function parseForms(html: string): ParsedForm[] {
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  const forms: ParsedForm[] = [];
  for (const match of markup.matchAll(/(<form\b[^>]*>)([\s\S]*?)<\/form>/gi)) {
    const form = attributesOf(match[1]);
    const hidden: Record<string, string> = {};
    const controls: string[] = [];
    for (const input of match[2].matchAll(/<input\b[^>]*>/gi)) {
      const attributes = attributesOf(input[0]);
      if (attributes.name === undefined) continue;
      if (attributes.type === "hidden") hidden[attributes.name] = attributes.value ?? "";
      else controls.push(attributes.name);
    }
    forms.push({ action: form.action ?? "", method: (form.method ?? "get").toLowerCase(), hidden, controls });
  }
  return forms;
}

export function encodeForm(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

export interface ParsedSetCookie {
  readonly name: string;
  readonly value: string;
  /** The attributes as sent, trimmed, in order. */
  readonly attributes: readonly string[];
}

export function parseSetCookie(header: string): ParsedSetCookie | null {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  return { name: pair.slice(0, separator), value: pair.slice(separator + 1), attributes };
}

/** The labels of the secrets that occur in `text`. Labels only: a value is never returned or printed. */
export function secretsFoundIn(text: string, secrets: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [label, value] of secrets) {
    if (value !== "" && text.includes(value)) found.push(label);
  }
  return found.sort();
}

/** The rows only one of two full-content snapshots of a table holds. The rows are for comparison, never for output. */
export function diffRows(before: readonly string[], after: readonly string[]): { readonly removed: string[]; readonly added: string[] } {
  const earlier = new Map<string, number>();
  for (const row of before) earlier.set(row, (earlier.get(row) ?? 0) + 1);
  const added: string[] = [];
  for (const row of after) {
    const count = earlier.get(row) ?? 0;
    if (count > 0) earlier.set(row, count - 1);
    else added.push(row);
  }
  const removed: string[] = [];
  for (const [row, count] of earlier) for (let index = 0; index < count; index += 1) removed.push(row);
  return { removed, added };
}

// ---------------------------------------------------------------------------
// The real dependencies. Called by the integration driver only.
// ---------------------------------------------------------------------------

/** Requests to the bound address, naming the approved origin's host. One connection per request, closed after it. */
export function loopbackTransport(host: string, port: number, hostHeader: string): Transport {
  return (spec, signal) =>
    new Promise<HttpReply>((resolve, reject) => {
      const headers: Record<string, string> = { ...spec.headers, host: hostHeader, connection: "close" };
      if (spec.body !== undefined) headers["content-length"] = String(Buffer.byteLength(spec.body));
      const request = sendHttpRequest({ host, port, method: spec.method, path: spec.path, headers, agent: false, signal }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > RESPONSE_LIMIT_BYTES) {
            request.destroy(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const seen: Record<string, readonly string[]> = {};
          for (const [name, values] of Object.entries(response.headersDistinct)) seen[name.toLowerCase()] = values ?? [];
          resolve({ status: response.statusCode ?? 0, headers: seen, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      request.on("error", reject);
      request.end(spec.body);
    });
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}

/** Whether something accepts connections on the port. Anything other than a refusal counts as in use. */
function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1_000, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(errorCode(error) !== "ECONNREFUSED"));
  });
}

/** A private log file, created new (never appended to, never replacing one), mode 600. */
function openLog(path: string): LogSink {
  const failures: string[] = [];
  const listeners: Array<() => void> = [];
  const fail = (error: unknown): void => {
    // A listed code, or the fixed fallback: never whatever text the error carries as its code.
    failures.push(classifyFailure(error).code ?? "UNKNOWN");
    for (const listener of listeners) listener();
  };
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  stream.on("error", fail);
  let closed: Promise<void> | null = null;
  return {
    write(chunk) {
      if (closed) {
        fail({ code: "WRITE_AFTER_CLOSE" });
        return;
      }
      stream.write(chunk, (error) => {
        if (error) fail(error);
      });
    },
    onFailure: (listener) => void listeners.push(listener),
    failures: () => failures,
    close() {
      if (!closed) {
        closed = new Promise<void>((resolve) => {
          if (stream.destroyed) resolve();
          else stream.end(() => resolve());
          stream.once("error", () => resolve());
        });
      }
      return closed;
    },
  };
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly pgid: number;
  /** The start time as `ps` prints it. With the pid it names one process. */
  readonly startIdentity: string;
}

/**
 * The process group and the start time of a live process, read from the process table, or null when it could not
 * be read. A real, synchronous call to /bin/ps with a fixed argument list; it reads no command text.
 */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  // The whole environment of the command: these two names and nothing inherited. Typed as plain strings and
  // handed over as the spawn above hands over its environment.
  const environment: Record<string, string> = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
  try {
    const seen = spawnSync("/bin/ps", ["-o", "pgid=,lstart=", "-p", String(pid)], { env: environment as NodeJS.ProcessEnv, encoding: "utf8", timeout: 5_000 });
    if (seen.status !== 0 || typeof seen.stdout !== "string") return null;
    const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(seen.stdout.split("\n")[0] ?? "");
    return match ? { pid, pgid: Number(match[1]), startIdentity: match[2] } : null;
  } catch {
    return null;
  }
}

/**
 * The real process dependencies. The child leads a new process group, so that the group, and with it whatever
 * the child starts, can be signalled and examined as one.
 */
export function realProcessDeps(probe: (signal: AbortSignal) => Promise<boolean>): ProcessDeps {
  return {
    spawn(spec) {
      const child = spawnProcess(spec.command, [...spec.args], { cwd: spec.cwd, env: { ...spec.env } as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      return {
        pid: child.pid,
        onOutput(listener) {
          child.stdout?.on("data", listener);
          child.stderr?.on("data", listener);
        },
        onExit(listener) {
          let told = false;
          const once = (exit: ChildExit): void => {
            if (told) return;
            told = true;
            listener(exit);
          };
          child.once("exit", (code, signal) => once({ code, signal, spawnError: false }));
          child.once("error", () => once({ code: null, signal: null, spawnError: true }));
        },
      };
    },
    signalGroup(pid, signal) {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        // Nothing left to signal is not a failure.
        if (errorCode(error) !== "ESRCH") throw error;
      }
    },
    groupAlive(pid) {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        if (errorCode(error) === "ESRCH") return false;
        // A group that exists and may not be signalled still exists.
        if (errorCode(error) === "EPERM") return true;
        throw error;
      }
    },
    portInUse,
    probe,
    openLog,
  };
}

/**
 * The startup probe: one GET of the checkout list with no cookie. Without a session that page admits none, starts
 * no checkout and changes nothing; any HTTP answer at all means the application is serving.
 */
export function listingProbe(transport: Transport): (signal: AbortSignal) => Promise<boolean> {
  return async (signal) => {
    const reply = await transport({ method: "GET", path: "/checkouts" }, signal);
    return reply.status > 0;
  };
}
