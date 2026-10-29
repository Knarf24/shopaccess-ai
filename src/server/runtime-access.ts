import { isPersistenceUnavailable } from "@/lib/session/durable";
import { recoverStateGate, type StateGate } from "@/lib/session/snapshot-state";
import { openFoundationStoreWithKeyFile, type FoundationStore } from "@/lib/session/snapshot-store";
import { chargerBudgetTestStoreRequested, workloadRecordsRequested, createSnapshotApplication, getApplication, mockStoreSettings, type Application, type MockStoreSettings } from "./runtime";

/**
 * The one way production code reaches the process application (M2-1, docs/m2-1-plan.md §9).
 *
 * Without snapshot settings it resolves to getApplication(), unchanged. With them, one startup promise per process
 * opens the store (lock, verification), applies recovery and commits it durably, and only then builds the runtime.
 * Concurrent callers share that promise. A failed start stays unavailable for the life of the process.
 * This is the only application module that value-imports the snapshot store.
 */

export type RuntimeAccess =
  | { readonly status: "ready"; readonly application: Application }
  | { readonly status: "unavailable"; readonly code: string };

export interface RuntimeAccessDeps {
  readonly settings: () => MockStoreSettings;
  readonly memory: () => Application;
  readonly openStore: (directory: string, keyFile: string) => Promise<{ readonly status: "ready"; readonly value: FoundationStore } | { readonly status: "unavailable"; readonly code: string }>;
  readonly recover: (store: FoundationStore, now: Date) => ReturnType<typeof recoverStateGate>;
  readonly build: (gate: StateGate) => Application;
  readonly now: () => Date;
  readonly report: (line: string) => void;
}

export interface RuntimeAccessor {
  open(): Promise<RuntimeAccess>;
}

/** Builds an accessor with one startup barrier. Exported for tests; production uses openRuntime. */
export function createRuntimeAccess(deps: RuntimeAccessDeps): RuntimeAccessor {
  let barrier: Promise<RuntimeAccess> | null = null;
  const start = async (settings: Extract<MockStoreSettings, { state: "requested" }>): Promise<RuntimeAccess> => {
    const fail = (code: string): RuntimeAccess => {
      deps.report(`shopaccess: storage mode=snapshot status=unavailable code=${code}`);
      return { status: "unavailable", code };
    };
    // Checked before anything is opened, recovered or built.
    if (settings.mode === "invalid") return fail("PERSISTENCE_MODE_INVALID");
    if (settings.mode === "postgres") return fail("MOCK_STORE_UNSUPPORTED");
    if (!settings.directory || !settings.keyFile) return fail("MOCK_STORE_SETTINGS_INCOMPLETE");
    try {
      const opened = await deps.openStore(settings.directory, settings.keyFile);
      if (opened.status !== "ready") return fail(`open-${opened.code}`);
      const recovered = await deps.recover(opened.value, deps.now());
      if (recovered.status !== "ready") return fail(recovered.code);
      const application = deps.build(recovered.gate);
      deps.report(
        `shopaccess: storage mode=snapshot status=ready interruptedInterpretations=${recovered.interrupted.interpretations} interruptedRecommendations=${recovered.interrupted.recommendations} droppedSessions=${recovered.droppedSessions}`,
      );
      return { status: "ready", application };
    } catch {
      return fail("startup-error");
    }
  };
  return {
    open() {
      const settings = deps.settings();
      if (settings.state === "absent") return Promise.resolve({ status: "ready", application: deps.memory() });
      barrier ??= start(settings);
      return barrier;
    },
  };
}

/**
 * The snapshot open options this process asks for. Both are off unless their exact environment token is set, so an
 * unconfigured process opens an ordinary store: it reads formats up to 7 and writes 7, and refuses 8, 9 and 10.
 */
export function snapshotOpenOptions(): { readonly format8TestStore: boolean; readonly workloadRecords: boolean } {
  return { format8TestStore: chargerBudgetTestStoreRequested(), workloadRecords: workloadRecordsRequested() };
}

const ACCESSOR = Symbol.for("shopaccess.runtimeAccess");
type GlobalWithAccessor = typeof globalThis & { [ACCESSOR]?: RuntimeAccessor };

function processAccessor(): RuntimeAccessor {
  const holder = globalThis as GlobalWithAccessor;
  const existing = holder[ACCESSOR];
  if (existing) return existing;
  const created = createRuntimeAccess({
    settings: mockStoreSettings,
    memory: getApplication,
    openStore: (directory, keyFile) => openFoundationStoreWithKeyFile(directory, keyFile, snapshotOpenOptions()),
    recover: recoverStateGate,
    build: createSnapshotApplication,
    now: () => new Date(),
    report: (line) => console.warn(line),
  });
  Object.defineProperty(holder, ACCESSOR, { value: created, enumerable: false, writable: false, configurable: false });
  return created;
}

/** The process application. Await this before any session, draft, admission or maintenance work. */
export function openRuntime(): Promise<RuntimeAccess> {
  return processAccessor().open();
}

/** Pages: the application, or "unavailable" when snapshot storage could not be opened. */
export async function openApplication(): Promise<Application | "unavailable"> {
  const access = await openRuntime();
  return access.status === "ready" ? access.application : "unavailable";
}

/** Pages: renders `unavailable()` instead of throwing when a durable decision could not be saved. */
export async function guardPage<T>(render: () => Promise<T>, unavailable: () => T): Promise<T> {
  try {
    return await render();
  } catch (error) {
    if (isPersistenceUnavailable(error)) return unavailable();
    throw error;
  }
}
