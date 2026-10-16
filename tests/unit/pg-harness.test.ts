import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_URL_VARIABLE,
  ADMISSION_CHILD_ENVIRONMENT_KEYS,
  ADMISSION_CHILD_PROGRAM,
  admissionChildEnvironment,
  AdminTargetRefusedError,
  adminUrl,
  assessDisposableCluster,
  assessProvisionedRoles,
  AUTHORIZED_PORT_VARIABLE,
  CLEANUP_FAILURES,
  connectionConfig,
  ControlSession,
  DISPOSABLE_CLUSTER_NAME,
  ExclusiveControlError,
  isRefusedEnvironmentVariable,
  parseAdminTarget,
  PERMITTED_PG_VARIABLES,
  provisionDisposableDatabase,
  SHOPACCESS_ROLES,
  UncertainOutcomeError,
  verifyEffectiveConfig,
  type AdminTarget,
  type ClusterFacts,
  type ControlClient,
  type DriverConfig,
  type MembershipFacts,
  type ProvisionDriver,
  type ProvisionPlan,
  type RoleFacts,
} from "../db/harness";

// Database-free. These tests exercise the harness's decisions and its cleanup
// against in-memory facts and a fake driver. Nothing connects to PostgreSQL:
// where the real driver is used, a client or pool is only CONSTRUCTED, which
// opens no socket, and `connect()` is never called on it.

const role = (name: string, overrides: Partial<RoleFacts> = {}): RoleFacts => ({
  name,
  isBootstrapSuperuser: false,
  superuser: false,
  createRole: false,
  createDb: false,
  replication: false,
  bypassRls: false,
  canLogin: false,
  ...overrides,
});
const BOOTSTRAP_SUPERUSER = role("postgres", { isBootstrapSuperuser: true, superuser: true, createRole: true, createDb: true, replication: true, bypassRls: true, canLogin: true });
const PREDEFINED = [role("pg_monitor"), role("pg_read_all_data"), role("pg_write_all_data"), role("pg_read_all_stats")];
const PREDEFINED_MEMBERSHIPS: MembershipFacts[] = [{ member: "pg_monitor", role: "pg_read_all_stats", admin: false, inherit: true, set: true }];

/** A cluster exactly as initdb leaves it, started with the disposable marker. */
const pristine: ClusterFacts = {
  host: "127.0.0.1",
  adminDatabase: "postgres",
  clusterName: DISPOSABLE_CLUSTER_NAME,
  serverVersionNum: 170002,
  sessionUser: "postgres",
  databases: ["postgres", "template0", "template1"],
  roles: [BOOTSTRAP_SUPERUSER, ...PREDEFINED],
  memberships: PREDEFINED_MEMBERSHIPS,
};

const OPERATOR_LOGIN = "shopaccess_t_operator_0123456789abcdef";
const DATABASE = "shopaccess_disposable_0123456789abcdef";
const OWNER_DEFINER: MembershipFacts = { member: "shopaccess_owner", role: "shopaccess_definer", admin: false, inherit: false, set: true };
const OPERATOR_MEMBERSHIP: MembershipFacts = { member: OPERATOR_LOGIN, role: "shopaccess_operator", admin: false, inherit: true, set: false };

/** The same cluster after this run's bootstrap. */
const bootstrapped: ClusterFacts = {
  ...pristine,
  databases: [...pristine.databases, DATABASE],
  roles: [...pristine.roles, ...SHOPACCESS_ROLES.map((name) => role(name))],
  memberships: [...PREDEFINED_MEMBERSHIPS, OWNER_DEFINER],
};
/** And after this run's logins were created. */
const withLogins: ClusterFacts = {
  ...bootstrapped,
  roles: bootstrapped.roles.map((candidate) => (candidate.name === "shopaccess_web" ? { ...candidate, canLogin: true } : candidate)).concat(role(OPERATOR_LOGIN, { canLogin: true })),
  memberships: [...bootstrapped.memberships, OPERATOR_MEMBERSHIP],
};

const reasonsOf = (verdict: ReturnType<typeof assessDisposableCluster>): string => (verdict.ok ? "" : verdict.reasons.join(" | "));
const replaceRole = (facts: ClusterFacts, name: string, overrides: Partial<RoleFacts>): ClusterFacts => ({
  ...facts,
  roles: facts.roles.map((candidate) => (candidate.name === name ? { ...candidate, ...overrides } : candidate)),
});

describe("disposable cluster: only a pristine, positively identified server is accepted", () => {
  it("accepts a cluster holding nothing but what initdb created", () => {
    expect(assessDisposableCluster(pristine)).toEqual({ ok: true });
    expect(assessDisposableCluster({ ...pristine, host: "localhost" })).toEqual({ ok: true });
  });

  it.each([
    ["an ordinary local server on loopback without the marker", { clusterName: "" }, /cluster_name/],
    ["a different cluster name", { clusterName: "main" }, /cluster_name/],
    ["a marker that differs only in case", { clusterName: "Shopaccess-Disposable-Test" }, /cluster_name/],
    ["a remote host that claims the marker", { host: "db.internal.example" }, /loopback/],
    ["an admin URL that names an application database", { adminDatabase: "shopaccess" }, /maintenance database/],
    ["PostgreSQL 16", { serverVersionNum: 160004 }, /PostgreSQL 17/],
    ["PostgreSQL 18", { serverVersionNum: 180000 }, /PostgreSQL 17/],
  ] as Array<[string, Partial<ClusterFacts>, RegExp]>)("incorrect cluster identity: refuses %s", (_name, change, reason) => {
    expect(reasonsOf(assessDisposableCluster({ ...pristine, ...change }))).toMatch(reason);
  });

  it("the marker and loopback together are still not enough", () => {
    const marked = { ...pristine, databases: [...pristine.databases, "atlas_production"], roles: [...pristine.roles, role("atlas_app", { canLogin: true })] };
    const verdict = assessDisposableCluster(marked);
    expect(reasonsOf(verdict)).toMatch(/another database: atlas_production/);
    expect(reasonsOf(verdict)).toMatch(/another role: atlas_app/);
  });

  it("refuses a connecting role that is not the bootstrap superuser", () => {
    const ordinary = role("frank", { canLogin: true });
    expect(reasonsOf(assessDisposableCluster({ ...pristine, sessionUser: "frank", roles: [...pristine.roles, ordinary] }))).toMatch(/not the bootstrap superuser/);
    const secondSuperuser = role("admin2", { superuser: true, canLogin: true });
    const verdict = assessDisposableCluster({ ...pristine, sessionUser: "admin2", roles: [...pristine.roles, secondSuperuser] });
    expect(reasonsOf(verdict)).toMatch(/not the bootstrap superuser/);
    expect(reasonsOf(verdict)).toMatch(/another role: postgres|unexpected superuser role: postgres/);
    expect(reasonsOf(assessDisposableCluster({ ...pristine, sessionUser: "ghost" }))).toMatch(/not the bootstrap superuser/);
  });

  it("refuses unexpected superuser roles, whatever they are called", () => {
    for (const name of ["root", "shopaccess_web", "shopaccess_t_operator_ffffffffffffffff", "shopaccess_owner"]) {
      const verdict = assessDisposableCluster({ ...pristine, roles: [...pristine.roles, role(name, { superuser: true })] });
      expect(reasonsOf(verdict), name).toMatch(new RegExp(`unexpected superuser role: ${name}`));
    }
  });

  it("refuses pre-existing roles that collide with the harness's own names: a name proves nothing", () => {
    for (const name of [...SHOPACCESS_ROLES, OPERATOR_LOGIN, "shopaccess_t_web_1"]) {
      const verdict = assessDisposableCluster({ ...pristine, roles: [...pristine.roles, role(name)] });
      expect(reasonsOf(verdict), name).toMatch(new RegExp(`pre-existing role ${name} .* not created by this run`));
    }
    // All five at once, perfectly least-privilege, are still refused: this run did not create them.
    const all = assessDisposableCluster({ ...pristine, roles: [...pristine.roles, ...SHOPACCESS_ROLES.map((name) => role(name))], memberships: [...PREDEFINED_MEMBERSHIPS, OWNER_DEFINER] });
    expect(all.ok).toBe(false);
    if (!all.ok) expect(all.reasons.length).toBeGreaterThanOrEqual(6);
  });

  it("refuses pre-existing databases that collide with the harness's own prefix", () => {
    const verdict = assessDisposableCluster({ ...pristine, databases: [...pristine.databases, "shopaccess_disposable_ffffffffffffffff"] });
    expect(reasonsOf(verdict)).toMatch(/pre-existing database shopaccess_disposable_ffffffffffffffff .* not created by this run/);
    expect(reasonsOf(assessDisposableCluster({ ...pristine, databases: [...pristine.databases, "shopaccess"] }))).toMatch(/another database: shopaccess/);
  });

  it("refuses memberships outside the predefined roles, and tampered predefined roles", () => {
    const granted = { ...pristine, memberships: [...PREDEFINED_MEMBERSHIPS, { member: "postgres", role: "pg_write_all_data", admin: false, inherit: true, set: true }] };
    expect(reasonsOf(assessDisposableCluster(granted))).toMatch(/unexpected role membership: postgres in pg_write_all_data/);
    expect(reasonsOf(assessDisposableCluster(replaceRole(pristine, "pg_monitor", { canLogin: true })))).toMatch(/predefined role pg_monitor/);
    expect(reasonsOf(assessDisposableCluster(replaceRole(pristine, "pg_read_all_data", { superuser: true })))).toMatch(/predefined role pg_read_all_data/);
  });
});

describe("provisioned roles: attributes and memberships are verified before any login is trusted", () => {
  const noLogins = { operatorLogin: null, webLoginEnabled: false };
  const logins = { operatorLogin: OPERATOR_LOGIN, webLoginEnabled: true };

  it("accepts exactly the bootstrap result, and exactly this run's logins afterwards", () => {
    expect(assessProvisionedRoles(bootstrapped, noLogins)).toEqual({ ok: true });
    expect(assessProvisionedRoles(withLogins, logins)).toEqual({ ok: true });
  });

  it.each([
    ["SUPERUSER", { superuser: true }],
    ["CREATEROLE", { createRole: true }],
    ["CREATEDB", { createDb: true }],
    ["REPLICATION", { replication: true }],
    ["BYPASSRLS", { bypassRls: true }],
  ] as Array<[string, Partial<RoleFacts>]>)("refuses a ShopAccess role with %s", (attribute, change) => {
    for (const name of SHOPACCESS_ROLES) {
      expect(reasonsOf(assessProvisionedRoles(replaceRole(bootstrapped, name, change), noLogins)), name).toMatch(new RegExp(`role ${name} has elevated attributes: .*${attribute}`));
    }
    expect(reasonsOf(assessProvisionedRoles(replaceRole(withLogins, OPERATOR_LOGIN, change), logins))).toMatch(new RegExp(`role ${OPERATOR_LOGIN} has elevated attributes`));
  });

  it("refuses a login that this run did not enable, and a missing one it did", () => {
    for (const name of SHOPACCESS_ROLES) {
      expect(reasonsOf(assessProvisionedRoles(replaceRole(bootstrapped, name, { canLogin: true }), noLogins)), name).toMatch(new RegExp(`role ${name} can log in but was not given a login`));
    }
    // After login creation only shopaccess_web and the operator login may log in: never the definer, owner, worker or the group.
    for (const name of ["shopaccess_definer", "shopaccess_owner", "shopaccess_worker", "shopaccess_operator"]) {
      expect(reasonsOf(assessProvisionedRoles(replaceRole(withLogins, name, { canLogin: true }), logins)), name).toMatch(/can log in but was not given a login/);
    }
    expect(reasonsOf(assessProvisionedRoles(replaceRole(withLogins, "shopaccess_web", { canLogin: false }), logins))).toMatch(/role shopaccess_web cannot log in/);
  });

  it("refuses membership in privileged roles outside the shopaccess naming convention", () => {
    const escalations: MembershipFacts[] = [
      { member: "shopaccess_web", role: "pg_write_all_data", admin: false, inherit: true, set: true },
      { member: "shopaccess_web", role: "pg_execute_server_program", admin: false, inherit: true, set: true },
      { member: "shopaccess_operator", role: "postgres", admin: false, inherit: true, set: true },
      { member: "shopaccess_definer", role: "pg_read_server_files", admin: false, inherit: false, set: true },
      { member: OPERATOR_LOGIN, role: "pg_monitor", admin: false, inherit: true, set: false },
      { member: "postgres", role: "shopaccess_web", admin: true, inherit: true, set: true },
    ];
    for (const membership of escalations) {
      const verdict = assessProvisionedRoles({ ...withLogins, memberships: [...withLogins.memberships, membership] }, logins);
      expect(reasonsOf(verdict)).toMatch(new RegExp(`unexpected role membership: ${membership.member} in ${membership.role}`));
    }
  });

  it("refuses escalation paths inside the naming convention too", () => {
    const paths: MembershipFacts[] = [
      { member: "shopaccess_web", role: "shopaccess_definer", admin: false, inherit: true, set: true },
      { member: "shopaccess_web", role: "shopaccess_owner", admin: false, inherit: true, set: true },
      { member: "shopaccess_operator", role: "shopaccess_owner", admin: false, inherit: true, set: true },
      { member: OPERATOR_LOGIN, role: "shopaccess_definer", admin: false, inherit: true, set: false },
      { member: "shopaccess_worker", role: "shopaccess_web", admin: false, inherit: true, set: true },
    ];
    for (const membership of paths) {
      expect(assessProvisionedRoles({ ...withLogins, memberships: [...withLogins.memberships, membership] }, logins).ok, `${membership.member}>${membership.role}`).toBe(false);
    }
    // The approved memberships with the wrong options are escalation paths as well.
    for (const [approved, change] of [
      [OWNER_DEFINER, { inherit: true }],
      [OWNER_DEFINER, { admin: true }],
      [OPERATOR_MEMBERSHIP, { set: true }],
      [OPERATOR_MEMBERSHIP, { admin: true }],
    ] as Array<[MembershipFacts, Partial<MembershipFacts>]>) {
      const memberships = withLogins.memberships.map((candidate) => (candidate === approved ? { ...candidate, ...change } : candidate));
      expect(reasonsOf(assessProvisionedRoles({ ...withLogins, memberships }, logins))).toMatch(/has unexpected options/);
    }
    const missing = { ...withLogins, memberships: withLogins.memberships.filter((candidate) => candidate !== OPERATOR_MEMBERSHIP) };
    expect(reasonsOf(assessProvisionedRoles(missing, logins))).toMatch(/is missing/);
  });

  it("refuses any role that appeared beside the ones this run created, and a missing one", () => {
    expect(reasonsOf(assessProvisionedRoles({ ...bootstrapped, roles: [...bootstrapped.roles, role("intruder")] }, noLogins))).toMatch(/another role: intruder/);
    expect(reasonsOf(assessProvisionedRoles({ ...bootstrapped, roles: [...bootstrapped.roles, role("shopaccess_admin", { superuser: true })] }, noLogins))).toMatch(/unexpected superuser role: shopaccess_admin/);
    expect(reasonsOf(assessProvisionedRoles({ ...bootstrapped, roles: [...bootstrapped.roles, role(OPERATOR_LOGIN, { canLogin: true })] }, noLogins))).toMatch(new RegExp(`another role: ${OPERATOR_LOGIN}`));
    const withoutWorker = { ...bootstrapped, roles: bootstrapped.roles.filter((candidate) => candidate.name !== "shopaccess_worker") };
    expect(reasonsOf(assessProvisionedRoles(withoutWorker, noLogins))).toMatch(/role shopaccess_worker is missing/);
  });
});

// ---------------------------------------------------------------------------
// Provisioning: tracked resources and failure-safe cleanup, with a fake driver
// ---------------------------------------------------------------------------

type Step = keyof ProvisionDriver;

interface FakeDriverOptions {
  /** Facts returned by successive calls of readClusterFacts; the last one repeats. */
  readonly facts?: ClusterFacts[];
  /** Make these steps throw. */
  readonly fail?: Partial<Record<Step, Error>>;
  /** A lock shared between drivers, standing in for the database's advisory lock. Default: a private one. */
  readonly lock?: { holder: object | null };
  /** Answer of the n-th control check (1-based). Default: whatever the lock says. */
  readonly holds?: (check: number) => boolean;
}

function fakeDriver(options: FakeDriverOptions = {}) {
  /** Provisioning and cleanup steps, without the control calls. */
  const calls: string[] = [];
  /** Everything, control calls included, in order. */
  const timeline: string[] = [];
  const facts = options.facts ?? [pristine, bootstrapped, withLogins];
  const lock = options.lock ?? { holder: null };
  const me = {};
  let reads = 0;
  let checks = 0;
  const step = async (name: Step, detail = "") => {
    calls.push(detail ? `${name}:${detail}` : name);
    timeline.push(detail ? `${name}:${detail}` : name);
    const error = options.fail?.[name];
    if (error) throw error;
  };
  const driver: ProvisionDriver = {
    async acquireExclusiveControl() {
      timeline.push("acquireExclusiveControl");
      const error = options.fail?.acquireExclusiveControl;
      if (error) throw error;
      if (lock.holder !== null) return false;
      lock.holder = me;
      return true;
    },
    async holdsExclusiveControl() {
      timeline.push("holdsExclusiveControl");
      checks += 1;
      const error = options.fail?.holdsExclusiveControl;
      if (error) throw error;
      return options.holds ? options.holds(checks) : lock.holder === me;
    },
    async releaseExclusiveControl() {
      timeline.push("releaseExclusiveControl");
      if (lock.holder === me) lock.holder = null;
      const error = options.fail?.releaseExclusiveControl;
      if (error) throw error;
    },
    async readClusterFacts() {
      await step("readClusterFacts");
      const current = facts[Math.min(reads, facts.length - 1)];
      reads += 1;
      return current;
    },
    createDatabase: (name) => step("createDatabase", name),
    runBootstrap: (database) => step("runBootstrap", database),
    applyMigrations: (database) => step("applyMigrations", database),
    enableWebLogin: (database) => step("enableWebLogin", database),
    createOperatorLogin: (login) => step("createOperatorLogin", login),
    grantOperatorLogin: (_database, login) => step("grantOperatorLogin", login),
    closeConnections: () => step("closeConnections"),
    dropDatabase: (name) => step("dropDatabase", name),
    dropRole: (name) => step("dropRole", name),
  };
  const destructive = () => calls.filter((call) => call.startsWith("drop"));
  return { driver, calls, timeline, destructive, lock };
}

const PLAN: ProvisionPlan = { database: DATABASE, operatorLogin: OPERATOR_LOGIN, applyMigrations: true };
const DROP_ROLES_AFTER_BOOTSTRAP = [...SHOPACCESS_ROLES].reverse().map((name) => `dropRole:${name}`);
const boom = (message: string) => new Error(message);

describe("provisioning tracks what it created and removes exactly that, whatever fails", () => {
  it("on success: verifies before every privileged step, enables logins last, and cleans up only on request", async () => {
    const { driver, calls, destructive } = fakeDriver();
    const provisioned = await provisionDisposableDatabase(driver, PLAN);
    expect(calls).toEqual([
      "readClusterFacts",
      `createDatabase:${DATABASE}`,
      `runBootstrap:${DATABASE}`,
      "readClusterFacts",
      `applyMigrations:${DATABASE}`,
      `enableWebLogin:${DATABASE}`,
      `createOperatorLogin:${OPERATOR_LOGIN}`,
      `grantOperatorLogin:${OPERATOR_LOGIN}`,
      "readClusterFacts",
    ]);
    expect(destructive()).toEqual([]);

    expect(await provisioned.cleanup()).toEqual([]);
    expect(calls.slice(9)).toEqual(["closeConnections", `dropDatabase:${DATABASE}`, `dropRole:${OPERATOR_LOGIN}`, ...DROP_ROLES_AFTER_BOOTSTRAP]);
    // A second call does nothing: nothing is dropped twice.
    expect(await provisioned.cleanup()).toEqual([]);
    expect(destructive()).toHaveLength(7);
  });

  it("skips migrations when asked, and still verifies roles", async () => {
    const { driver, calls } = fakeDriver();
    await provisionDisposableDatabase(driver, { ...PLAN, applyMigrations: false });
    expect(calls).not.toContain(`applyMigrations:${DATABASE}`);
    expect(calls.filter((call) => call === "readClusterFacts")).toHaveLength(3);
  });

  it("an unverified cluster is refused before anything is created, and nothing is dropped", async () => {
    const refused: Array<[string, ClusterFacts]> = [
      ["no marker", { ...pristine, clusterName: "" }],
      ["a colliding role", { ...pristine, roles: [...pristine.roles, role("shopaccess_web")] }],
      ["a colliding database", { ...pristine, databases: [...pristine.databases, DATABASE] }],
      ["an already bootstrapped cluster from an earlier run", bootstrapped],
      ["leftover logins from an earlier run", withLogins],
    ];
    for (const [name, facts] of refused) {
      const { driver, calls, destructive } = fakeDriver({ facts: [facts] });
      await expect(provisionDisposableDatabase(driver, PLAN), name).rejects.toThrow(/Refusing to use this PostgreSQL server/);
      expect(calls, name).toEqual(["readClusterFacts", "closeConnections"]);
      // In particular the pre-existing database and roles of the same names are left alone.
      expect(destructive(), name).toEqual([]);
    }
  });

  it("refuses plans whose names are not the harness's own generated shape, before touching the driver", async () => {
    for (const plan of [
      { ...PLAN, database: "postgres" },
      { ...PLAN, database: "shopaccess_disposable_x; DROP DATABASE postgres" },
      { ...PLAN, database: "atlas_production" },
      { ...PLAN, operatorLogin: "postgres" },
      { ...PLAN, operatorLogin: "shopaccess_web" },
    ]) {
      const { driver, calls } = fakeDriver();
      await expect(provisionDisposableDatabase(driver, plan)).rejects.toThrow(/Refusing an unexpected/);
      expect(calls).toEqual([]);
    }
  });

  const FAILURES: Array<[string, Step, string[]]> = [
    ["reading the cluster facts", "readClusterFacts", []],
    ["creating the database (partial setup)", "createDatabase", []],
    ["the bootstrap", "runBootstrap", [`dropDatabase:${DATABASE}`]],
    ["a migration", "applyMigrations", [`dropDatabase:${DATABASE}`, ...DROP_ROLES_AFTER_BOOTSTRAP]],
    ["enabling the web login", "enableWebLogin", [`dropDatabase:${DATABASE}`, ...DROP_ROLES_AFTER_BOOTSTRAP]],
    ["creating the test login", "createOperatorLogin", [`dropDatabase:${DATABASE}`, ...DROP_ROLES_AFTER_BOOTSTRAP]],
    ["granting the test login", "grantOperatorLogin", [`dropDatabase:${DATABASE}`, `dropRole:${OPERATOR_LOGIN}`, ...DROP_ROLES_AFTER_BOOTSTRAP]],
  ];

  it.each(FAILURES)("failure injection: %s fails", async (_name, failingStep, expectedDrops) => {
    const original = boom(`${failingStep} failed`);
    const { driver, calls, destructive } = fakeDriver({ fail: { [failingStep]: original } });
    // The original failure is what the caller sees.
    await expect(provisionDisposableDatabase(driver, PLAN)).rejects.toBe(original);
    // Connections are always closed, and exactly the resources created before the failure are removed.
    expect(calls).toContain("closeConnections");
    expect(destructive()).toEqual(expectedDrops);
    expect(calls.indexOf("closeConnections")).toBeLessThan(calls.length - expectedDrops.length);
    // Nothing after the failing step ran.
    const order: Step[] = ["createDatabase", "runBootstrap", "applyMigrations", "enableWebLogin", "createOperatorLogin", "grantOperatorLogin"];
    for (const later of order.slice(order.indexOf(failingStep) + 1)) {
      expect(calls.some((call) => call.startsWith(`${later}:`)), later).toBe(false);
    }
    expect((original as Error & { [CLEANUP_FAILURES]?: unknown[] })[CLEANUP_FAILURES]).toBeUndefined();
  });

  it("failure injection: roles are not least-privilege after bootstrap, so no login is ever enabled", async () => {
    const tampered = replaceRole(bootstrapped, "shopaccess_web", { superuser: true });
    const { driver, calls, destructive } = fakeDriver({ facts: [pristine, tampered] });
    await expect(provisionDisposableDatabase(driver, PLAN)).rejects.toThrow(/not in their least-privilege state after bootstrap: role shopaccess_web has elevated attributes: SUPERUSER/);
    expect(calls.some((call) => /^(applyMigrations|enableWebLogin|createOperatorLogin|grantOperatorLogin)/.test(call))).toBe(false);
    expect(destructive()).toEqual([`dropDatabase:${DATABASE}`, ...DROP_ROLES_AFTER_BOOTSTRAP]);

    const member = { ...bootstrapped, memberships: [...bootstrapped.memberships, { member: "shopaccess_web", role: "pg_write_all_data", admin: false, inherit: true, set: true }] };
    const second = fakeDriver({ facts: [pristine, member] });
    await expect(provisionDisposableDatabase(second.driver, PLAN)).rejects.toThrow(/unexpected role membership: shopaccess_web in pg_write_all_data/);
    expect(second.calls.some((call) => call.startsWith("enableWebLogin"))).toBe(false);
  });

  it("failure injection: the final verification fails, and everything including the test login is removed", async () => {
    const escalated = { ...withLogins, memberships: [...withLogins.memberships, { member: OPERATOR_LOGIN, role: "shopaccess_owner", admin: false, inherit: true, set: true }] };
    const { driver, destructive } = fakeDriver({ facts: [pristine, bootstrapped, escalated] });
    await expect(provisionDisposableDatabase(driver, PLAN)).rejects.toThrow(/after login creation/);
    expect(destructive()).toEqual([`dropDatabase:${DATABASE}`, `dropRole:${OPERATOR_LOGIN}`, ...DROP_ROLES_AFTER_BOOTSTRAP]);
  });

  it("a cleanup error never hides the setup failure, and the remaining cleanup still runs", async () => {
    const original = boom("migration failed");
    const closeFailed = boom("could not close");
    const dropFailed = boom("database is in use");
    const { driver, destructive } = fakeDriver({ fail: { applyMigrations: original, closeConnections: closeFailed, dropDatabase: dropFailed } });

    const thrown = await provisionDisposableDatabase(driver, PLAN).catch((error: unknown) => error);
    expect(thrown).toBe(original);
    expect((thrown as Error).message).toBe("migration failed");
    // Every cleanup step was still attempted, in order, despite the two failures.
    expect(destructive()).toEqual([`dropDatabase:${DATABASE}`, ...DROP_ROLES_AFTER_BOOTSTRAP]);
    // The cleanup errors are attached for diagnosis, without replacing the original.
    expect((thrown as Error & { [CLEANUP_FAILURES]?: unknown[] })[CLEANUP_FAILURES]).toEqual([closeFailed, dropFailed]);
    expect(Object.keys(thrown as object)).not.toContain(String(CLEANUP_FAILURES));
  });

  it("every role drop failing still never widens what is dropped", async () => {
    const { driver, destructive } = fakeDriver({ fail: { grantOperatorLogin: boom("grant failed"), dropRole: boom("role has dependents") } });
    const thrown = await provisionDisposableDatabase(driver, PLAN).catch((error: unknown) => error);
    expect((thrown as Error).message).toBe("grant failed");
    expect(destructive()).toEqual([`dropDatabase:${DATABASE}`, `dropRole:${OPERATOR_LOGIN}`, ...DROP_ROLES_AFTER_BOOTSTRAP]);
    expect((thrown as Error & { [CLEANUP_FAILURES]?: unknown[] })[CLEANUP_FAILURES]).toHaveLength(6);
    // Only names from this run's plan and the five bootstrap roles ever appear in a drop.
    const allowed = new Set([`dropDatabase:${DATABASE}`, `dropRole:${OPERATOR_LOGIN}`, ...DROP_ROLES_AFTER_BOOTSTRAP]);
    for (const call of destructive()) expect(allowed.has(call), call).toBe(true);
  });

  it("cleanup after a successful setup reports its errors instead of throwing, and still attempts every step", async () => {
    const failing = boom("connection refused");
    const { driver, destructive } = fakeDriver();
    const provisioned = await provisionDisposableDatabase(driver, PLAN);
    driver.dropDatabase = async () => {
      throw failing;
    };
    const failures = await provisioned.cleanup();
    expect(failures).toEqual([failing]);
    expect(destructive()).toEqual([`dropRole:${OPERATOR_LOGIN}`, ...DROP_ROLES_AFTER_BOOTSTRAP]);
  });
});

describe("exclusive control: one harness invocation per cluster, enforced by the database for the whole lifecycle", () => {
  const MUTATING = ["createDatabase", "runBootstrap", "applyMigrations", "enableWebLogin", "createOperatorLogin", "grantOperatorLogin", "dropDatabase", "dropRole"];
  const isMutating = (entry: string) => MUTATING.some((name) => entry.startsWith(name));

  it("is acquired before the cluster is even inspected, confirmed before every change, and released last", async () => {
    const { driver, timeline } = fakeDriver();
    const provisioned = await provisionDisposableDatabase(driver, PLAN);
    expect(timeline[0]).toBe("acquireExclusiveControl");
    expect(timeline[1]).toBe("readClusterFacts");
    expect(await provisioned.holdsExclusiveControl()).toBe(true);
    expect(await provisioned.cleanup()).toEqual([]);
    expect(timeline.at(-1)).toBe("releaseExclusiveControl");
    expect(timeline.filter((entry) => entry === "acquireExclusiveControl")).toHaveLength(1);
    expect(timeline.filter((entry) => entry === "releaseExclusiveControl")).toHaveLength(1);

    // Every step that changes or drops something is immediately preceded by a confirmation from the database.
    const mutating = timeline.map((entry, index) => ({ entry, index })).filter(({ entry }) => isMutating(entry));
    expect(mutating).toHaveLength(6 + 7);
    for (const { entry, index } of mutating) expect(timeline[index - 1], entry).toBe("holdsExclusiveControl");
    // Nothing is released while anything remains to be dropped.
    expect(timeline.indexOf("releaseExclusiveControl")).toBeGreaterThan(timeline.findLastIndex(isMutating));
    expect(await provisioned.holdsExclusiveControl()).toBe(false);
  });

  it("a second invocation is refused while the first holds the cluster, and does nothing at all", async () => {
    const lock = { holder: null as object | null };
    const first = fakeDriver({ lock });
    const held = await provisionDisposableDatabase(first.driver, PLAN);

    // The first run's roles and database now exist; the second must not even look, let alone touch them.
    const second = fakeDriver({ lock, facts: [withLogins] });
    const refusal = await provisionDisposableDatabase(second.driver, PLAN).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExclusiveControlError);
    expect((refusal as Error).message).toMatch(/Another harness invocation holds exclusive control/);
    expect(second.timeline).toEqual(["acquireExclusiveControl", "closeConnections"]);
    expect(second.destructive()).toEqual([]);
    // The refused run never held the lock, so it must not release the first run's.
    expect(await held.holdsExclusiveControl()).toBe(true);

    // Through the tests and until cleanup has finished, the cluster stays held.
    expect(await held.cleanup()).toEqual([]);
    const third = fakeDriver({ lock });
    expect((await provisionDisposableDatabase(third.driver, PLAN)).database).toBe(DATABASE);
  });

  it("two invocations started together cannot both pass the pristine-cluster check", async () => {
    const lock = { holder: null as object | null };
    const runs = [fakeDriver({ lock }), fakeDriver({ lock })];
    const outcomes = await Promise.allSettled(runs.map((run) => provisionDisposableDatabase(run.driver, PLAN)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const loser = runs[outcomes.findIndex((outcome) => outcome.status === "rejected")];
    expect(loser.calls).toEqual(["closeConnections"]);
    expect(loser.timeline).not.toContain("readClusterFacts");
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ExclusiveControlError);
  });

  it("fails closed when control cannot be established, and releases nothing it did not take", async () => {
    const original = boom("connection refused");
    const { driver, timeline } = fakeDriver({ fail: { acquireExclusiveControl: original } });
    await expect(provisionDisposableDatabase(driver, PLAN)).rejects.toBe(original);
    expect(timeline).toEqual(["acquireExclusiveControl", "closeConnections"]);
  });

  // Control checks during setup, in order: before createDatabase, runBootstrap, applyMigrations,
  // enableWebLogin, createOperatorLogin, grantOperatorLogin, and before hand-over to the tests.
  it.each([
    [1, "creating the database", []],
    [2, "running the bootstrap", ["createDatabase"]],
    [3, "applying migrations", ["createDatabase", "runBootstrap"]],
    [4, "enabling the web login", ["createDatabase", "runBootstrap", "applyMigrations"]],
    [5, "creating the operator login", ["createDatabase", "runBootstrap", "applyMigrations", "enableWebLogin"]],
    [6, "granting the operator login", ["createDatabase", "runBootstrap", "applyMigrations", "enableWebLogin", "createOperatorLogin"]],
    [7, "handing the database to the tests", ["createDatabase", "runBootstrap", "applyMigrations", "enableWebLogin", "createOperatorLogin", "grantOperatorLogin"]],
  ] as Array<[number, string, string[]]>)("control lost at check %i: stops before %s and drops nothing", async (lostAt, before, done) => {
    const { driver, calls, timeline, destructive } = fakeDriver({ holds: (check) => check < lostAt });
    const thrown = await provisionDisposableDatabase(driver, PLAN).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ExclusiveControlError);
    expect((thrown as Error).message).toContain(`lost before ${before}`);
    // Exactly the steps before the loss ran; nothing after it.
    expect(calls.filter(isMutating).map((call) => call.split(":")[0])).toEqual(done);
    // No destructive operation of any kind: another invocation may own those names by now.
    expect(destructive()).toEqual([]);
    expect(calls).toContain("closeConnections");
    expect(timeline.at(-1)).toBe("releaseExclusiveControl");
    // If anything had been created, the refusal to drop it is reported alongside the original error.
    const attached = (thrown as Error & { [CLEANUP_FAILURES]?: unknown[] })[CLEANUP_FAILURES];
    if (done.length === 0) expect(attached).toBeUndefined();
    else {
      expect(attached).toHaveLength(1);
      expect(attached?.[0]).toBeInstanceOf(ExclusiveControlError);
      expect(String((attached?.[0] as Error).message)).toMatch(/nothing further was dropped\. Treat the cluster as contaminated: delete and re-create it/);
    }
  });

  it("an error while asking the database counts as control lost", async () => {
    const { driver, destructive, calls } = fakeDriver({ fail: { holdsExclusiveControl: boom("connection terminated") } });
    await expect(provisionDisposableDatabase(driver, PLAN)).rejects.toBeInstanceOf(ExclusiveControlError);
    expect(calls.filter(isMutating)).toEqual([]);
    expect(destructive()).toEqual([]);
  });

  it("control lost while the tests were running: cleanup drops nothing and says so", async () => {
    let lost = false;
    const { driver, destructive, timeline } = fakeDriver({ holds: () => !lost });
    const provisioned = await provisionDisposableDatabase(driver, PLAN);
    lost = true;
    expect(await provisioned.holdsExclusiveControl()).toBe(false);
    const failures = await provisioned.cleanup();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(ExclusiveControlError);
    expect(destructive()).toEqual([]);
    expect(timeline).toContain("closeConnections");
    expect(timeline.at(-1)).toBe("releaseExclusiveControl");
  });

  it("control lost part-way through cleanup: the remaining drops are abandoned", async () => {
    let allowed = Number.POSITIVE_INFINITY;
    let seen = 0;
    const { driver, destructive } = fakeDriver({
      holds: () => {
        seen += 1;
        return seen <= allowed;
      },
    });
    const provisioned = await provisionDisposableDatabase(driver, PLAN);
    // Two more confirmations succeed (database, operator login); the third fails.
    allowed = seen + 2;
    const failures = await provisioned.cleanup();
    expect(destructive()).toEqual([`dropDatabase:${DATABASE}`, `dropRole:${OPERATOR_LOGIN}`]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(ExclusiveControlError);
  });

  it("a failure to release is reported by cleanup and never thrown or allowed to hide a setup error", async () => {
    const releaseFailed = boom("could not end the control session");
    const afterSuccess = fakeDriver({ fail: { releaseExclusiveControl: releaseFailed } });
    const provisioned = await provisionDisposableDatabase(afterSuccess.driver, PLAN);
    expect(await provisioned.cleanup()).toEqual([releaseFailed]);
    expect(afterSuccess.destructive()).toHaveLength(7);

    const original = boom("bootstrap failed");
    const afterFailure = fakeDriver({ fail: { runBootstrap: original, releaseExclusiveControl: releaseFailed } });
    const thrown = await provisionDisposableDatabase(afterFailure.driver, PLAN).catch((error: unknown) => error);
    expect(thrown).toBe(original);
    expect((thrown as Error & { [CLEANUP_FAILURES]?: unknown[] })[CLEANUP_FAILURES]).toEqual([releaseFailed]);
  });
});

describe("residual risk: CREATE DATABASE succeeded but its acknowledgment was lost", () => {
  it("the harness does not guess: the unconfirmed database is not dropped, and the next run refuses the cluster", async () => {
    // The server created the database; the client saw only a broken connection.
    const lostAcknowledgment = boom("connection terminated unexpectedly");
    const first = fakeDriver({ fail: { createDatabase: lostAcknowledgment } });
    await expect(provisionDisposableDatabase(first.driver, PLAN)).rejects.toBe(lostAcknowledgment);
    // Ownership was never established, so nothing is dropped, by name or otherwise.
    expect(first.destructive()).toEqual([]);
    expect(first.timeline.at(-1)).toBe("releaseExclusiveControl");

    // The leftover database carries the harness prefix. That proves nothing: the cluster is refused, untouched.
    const leftover: ClusterFacts = { ...pristine, databases: [...pristine.databases, DATABASE] };
    for (const plan of [PLAN, { ...PLAN, database: "shopaccess_disposable_fedcba9876543210" }]) {
      const next = fakeDriver({ facts: [leftover] });
      await expect(provisionDisposableDatabase(next.driver, plan)).rejects.toThrow(/pre-existing database shopaccess_disposable_0123456789abcdef .* not created by this run/);
      expect(next.destructive()).toEqual([]);
      expect(next.calls).toEqual(["readClusterFacts", "closeConnections"]);
    }
  });
});

// ---------------------------------------------------------------------------
// The lock-owning session: every cluster-level statement shares the session
// that holds the advisory lock. Fakes only; nothing connects to PostgreSQL.
// ---------------------------------------------------------------------------

const connectionLost = () => new Error("Connection terminated unexpectedly");
const sqlError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** A fake database session. Statements take effect on `server`; the session can be made to die. */
function fakeSession(options: { fail?: (text: string) => { error: Error; applied: boolean } | undefined } = {}) {
  const sent: string[] = [];
  const server: string[] = [];
  let alive = true;
  let locked = false;
  let ended = 0;
  const client: ControlClient = {
    async query(text: string) {
      if (!alive) throw connectionLost();
      sent.push(text);
      const failure = options.fail?.(text);
      if (failure) {
        if (failure.applied) server.push(text);
        // A connection failure takes the session, and with it the lock.
        if (!("code" in failure.error)) {
          alive = false;
          locked = false;
        }
        throw failure.error;
      }
      // The lock query also mentions current_database(), so it is recognized first.
      if (text.includes("pg_locks")) return { rows: [{ held: locked }] };
      if (text.includes("pg_try_advisory_lock")) {
        locked = true;
        return { rows: [{ taken: true }] };
      }
      if (text.includes("current_database()")) return { rows: [{ name: "postgres" }] };
      server.push(text);
      return { rows: [] };
    },
    async end() {
      ended += 1;
      alive = false;
      locked = false;
    },
  };
  return {
    client,
    sent,
    server,
    kill() {
      alive = false;
      locked = false;
    },
    get ended() {
      return ended;
    },
  };
}

const CREATE = "CREATE DATABASE shopaccess_disposable_0123456789abcdef";

describe("lock-owning session: holding the lock and being able to send a statement are one fact", () => {
  it("sends each cluster-level statement on the session that took the lock, one statement at a time", async () => {
    const fake = fakeSession();
    const session = new ControlSession(fake.client);
    expect(await session.tryLock()).toBe(true);
    expect(await session.holdsLock()).toBe(true);
    const statements = [
      CREATE,
      "ALTER ROLE shopaccess_web LOGIN PASSWORD 'abc'",
      `CREATE ROLE ${OPERATOR_LOGIN} LOGIN NOSUPERUSER`,
      `GRANT shopaccess_operator TO ${OPERATOR_LOGIN} WITH INHERIT TRUE, SET FALSE`,
      `GRANT CONNECT ON DATABASE ${DATABASE} TO ${OPERATOR_LOGIN}`,
      `DROP DATABASE ${DATABASE} WITH (FORCE)`,
      `DROP ROLE ${OPERATOR_LOGIN}`,
    ];
    for (const statement of statements) await session.run(statement);
    // Exactly these, exactly as given, each as its own message, on the one client.
    expect(fake.server).toEqual(statements);
    // The session never opens a transaction, so CREATE DATABASE and DROP DATABASE are never inside one.
    expect(fake.sent.some((text) => /\b(?:BEGIN|START TRANSACTION|COMMIT|ROLLBACK)\b/i.test(text))).toBe(false);
  });

  it("refuses anything that is not a single cluster-level statement, so nothing can be wrapped in a transaction", async () => {
    const fake = fakeSession();
    const session = new ControlSession(fake.client);
    await session.tryLock();
    const before = fake.sent.length;
    for (const statement of [
      `BEGIN; ${CREATE}; COMMIT`,
      `${CREATE};`,
      `${CREATE}; DROP DATABASE postgres`,
      "BEGIN",
      "COMMIT",
      "SELECT 1",
      "DROP TABLE shopaccess.shopper_sessions",
      "create database lower_case",
      ` ${CREATE}`,
      "",
    ]) {
      await expect(session.run(statement), statement).rejects.toThrow(/single cluster-level statement/);
    }
    expect(fake.sent).toHaveLength(before);
    expect(session.usable).toBe(true);
  });

  it("lock loss immediately before database creation: the statement is never sent", async () => {
    const fake = fakeSession();
    const session = new ControlSession(fake.client);
    await session.tryLock();
    // The connection reports an error (as the driver's event listener would relay) just before the statement.
    session.markBroken();
    const refusal = await session.run(CREATE).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExclusiveControlError);
    expect(refusal).not.toBeInstanceOf(UncertainOutcomeError);
    expect((refusal as Error).message).toMatch(/was not sent/);
    expect(fake.server).toEqual([]);
    expect(await session.holdsLock()).toBe(false);
  });

  it("the former check-to-create interleaving cannot create a database: the check passes, the session dies, nothing is created", async () => {
    const fake = fakeSession();
    const session = new ControlSession(fake.client);
    await session.tryLock();
    // 1. The ownership check passes.
    expect(await session.holdsLock()).toBe(true);
    // 2. The lock-owning session dies; the server releases the lock. Nobody has told the harness.
    fake.kill();
    // 3. The old harness now created the database on ANOTHER connection. Here the statement needs the dead session.
    const outcome = await session.run(CREATE).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(UncertainOutcomeError);
    expect(fake.server).toEqual([]);
    // Having met the failure, the session sends nothing further and reports no lock.
    await expect(session.run(`DROP DATABASE ${DATABASE} WITH (FORCE)`)).rejects.toThrow(/was not sent/);
    expect(await session.holdsLock()).toBe(false);
    expect(fake.sent.filter((text) => /DATABASE /.test(text))).toEqual([]);
  });

  it("connection failure during CREATE DATABASE, and a lost acknowledgment, are both an unknown outcome", async () => {
    for (const applied of [false, true]) {
      const fake = fakeSession({ fail: (text) => (text === CREATE ? { error: connectionLost(), applied } : undefined) });
      const session = new ControlSession(fake.client);
      await session.tryLock();
      const outcome = await session.run(CREATE).catch((error: unknown) => error);
      // The same error whether or not the server created the database: the harness cannot tell and does not pretend to.
      expect(outcome, String(applied)).toBeInstanceOf(UncertainOutcomeError);
      expect((outcome as Error).message).toMatch(/outcome is unknown\. Treat the cluster as contaminated/);
      expect((outcome as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
      expect(fake.server).toEqual(applied ? [CREATE] : []);
      // No retry, no follow-up statement, no speculative drop.
      expect(session.usable).toBe(false);
      await expect(session.run(`DROP DATABASE ${DATABASE} WITH (FORCE)`)).rejects.toThrow(/was not sent/);
      expect(fake.sent.filter((text) => text.startsWith("DROP"))).toEqual([]);
    }
  });

  it.each([
    ["no SQLSTATE at all", connectionLost()],
    ["a socket error code", sqlError("ECONNRESET", "read ECONNRESET")],
    ["connection_failure", sqlError("08006", "connection failure")],
    ["admin_shutdown", sqlError("57P01", "terminating connection due to administrator command")],
    ["crash_shutdown", sqlError("57P02", "terminating connection because of crash of another server process")],
  ])("treats %s as an unknown outcome", async (_name, error) => {
    const fake = fakeSession({ fail: (text) => (text === CREATE ? { error, applied: false } : undefined) });
    const session = new ControlSession(fake.client);
    await session.tryLock();
    await expect(session.run(CREATE)).rejects.toBeInstanceOf(UncertainOutcomeError);
    expect(session.usable).toBe(false);
  });

  it("a definite SQL error from a surviving session is not an unknown outcome, and the session stays usable", async () => {
    const duplicate = sqlError("42P04", "database already exists");
    const fake = fakeSession({ fail: (text) => (text === CREATE ? { error: duplicate, applied: false } : undefined) });
    const session = new ControlSession(fake.client);
    await session.tryLock();
    await expect(session.run(CREATE)).rejects.toBe(duplicate);
    expect(session.usable).toBe(true);
    expect(await session.holdsLock()).toBe(true);
    await session.run(`DROP ROLE ${OPERATOR_LOGIN}`);

    // But if the connection also reported an error meanwhile, the SQLSTATE is not trusted.
    const second = fakeSession({ fail: (text) => (text === CREATE ? { error: duplicate, applied: false } : undefined) });
    const doubtful = new ControlSession(second.client);
    await doubtful.tryLock();
    const pending = doubtful.run(CREATE);
    doubtful.markBroken();
    await expect(pending).rejects.toBeInstanceOf(UncertainOutcomeError);
  });

  it("any doubt about the lock is 'not held', and ending the session is safe to repeat", async () => {
    const failing = fakeSession({ fail: (text) => (text.includes("pg_locks") ? { error: connectionLost(), applied: false } : undefined) });
    const session = new ControlSession(failing.client);
    await session.tryLock();
    expect(await session.holdsLock()).toBe(false);
    expect(session.usable).toBe(false);
    await session.end();
    await session.end();
    expect(failing.ended).toBe(1);
    expect(await session.holdsLock()).toBe(false);

    // The lock is taken only in the maintenance database.
    const elsewhere: ControlClient = { query: async () => ({ rows: [{ name: "shopaccess" }] }), end: async () => undefined };
    await expect(new ControlSession(elsewhere).tryLock()).rejects.toThrow(/must name the postgres database/);
  });
});

describe("provisioning on a lock-owning session: no speculative cleanup after an unknown outcome", () => {
  const CLUSTER_STEPS: Step[] = ["createDatabase", "enableWebLogin", "createOperatorLogin", "grantOperatorLogin"];

  /**
   * A fake driver whose cluster-level steps share one session with the lock,
   * as the real driver's do. `dieDuring` kills that session while the named
   * step is in flight; `applied` says whether the server carried it out first.
   */
  function sessionDriver(options: { dieDuring?: Step; applied?: boolean; dieBefore?: Step; lyingControlCheck?: boolean } = {}) {
    const calls: string[] = [];
    const server = new Set<string>();
    let alive = true;
    let reads = 0;
    const facts = [pristine, bootstrapped, withLogins];
    const onSession = async (name: Step, resource: string, effect: () => void) => {
      if (options.dieBefore === name) alive = false;
      if (!alive) throw new ExclusiveControlError("The lock-owning session is no longer usable; the statement was not sent");
      calls.push(`${name}:${resource}`);
      if (options.dieDuring === name) {
        if (options.applied) effect();
        alive = false;
        throw new UncertainOutcomeError("outcome unknown", { cause: connectionLost() });
      }
      effect();
    };
    const driver: ProvisionDriver = {
      acquireExclusiveControl: async () => true,
      // A control check that wrongly keeps saying yes must not be able to re-enable cleanup.
      holdsExclusiveControl: async () => (options.lyingControlCheck ? true : alive),
      releaseExclusiveControl: async () => {
        calls.push("releaseExclusiveControl");
      },
      async readClusterFacts() {
        if (!alive) throw new ExclusiveControlError("The lock-owning session is no longer usable");
        const current = facts[Math.min(reads, facts.length - 1)];
        reads += 1;
        return current;
      },
      createDatabase: (name) => onSession("createDatabase", name, () => server.add(`database:${name}`)),
      enableWebLogin: () => onSession("enableWebLogin", "shopaccess_web", () => server.add("login:shopaccess_web")),
      createOperatorLogin: (login) => onSession("createOperatorLogin", login, () => server.add(`role:${login}`)),
      grantOperatorLogin: (_database, login) => onSession("grantOperatorLogin", login, () => server.add(`membership:${login}`)),
      dropDatabase: (name) => onSession("dropDatabase", name, () => server.delete(`database:${name}`)),
      dropRole: (name) => onSession("dropRole", name, () => server.delete(`role:${name}`)),
      // Inside the test database, on other connections.
      async runBootstrap() {
        calls.push("runBootstrap");
        for (const name of SHOPACCESS_ROLES) server.add(`role:${name}`);
      },
      async applyMigrations() {
        calls.push("applyMigrations");
      },
      async closeConnections() {
        calls.push("closeConnections");
      },
    };
    const drops = () => calls.filter((call) => call.startsWith("drop"));
    return { driver, calls, server, drops };
  }

  it.each(CLUSTER_STEPS.flatMap((step) => [[step, false], [step, true]] as Array<[Step, boolean]>))(
    "connection failure during %s (applied on the server: %s): nothing is assumed and nothing is dropped",
    async (step, applied) => {
      const { driver, calls, server, drops } = sessionDriver({ dieDuring: step, applied });
      const thrown = await provisionDisposableDatabase(driver, PLAN).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(UncertainOutcomeError);
      // No drop of any kind: not of the uncertain resource, and not of the ones created with certainty before it.
      expect(drops()).toEqual([]);
      // Whatever the server holds is left exactly as it is, to be discarded with the cluster.
      if (step === "createDatabase") expect([...server]).toEqual(applied ? [`database:${DATABASE}`] : []);
      else expect(server.has(`database:${DATABASE}`)).toBe(true);
      // Own connections are still closed and the lock session is still ended.
      expect(calls).toContain("closeConnections");
      expect(calls.at(-1)).toBe("releaseExclusiveControl");
      // Nothing ran after the failed step.
      for (const later of CLUSTER_STEPS.slice(CLUSTER_STEPS.indexOf(step) + 1)) {
        expect(calls.some((call) => call.startsWith(`${later}:`)), later).toBe(false);
      }
    },
  );

  it("lost CREATE DATABASE acknowledgment: the database exists, is not recorded as this run's, and is not dropped", async () => {
    const { driver, server, drops, calls } = sessionDriver({ dieDuring: "createDatabase", applied: true });
    const thrown = await provisionDisposableDatabase(driver, PLAN).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(UncertainOutcomeError);
    expect(server.has(`database:${DATABASE}`)).toBe(true);
    expect(drops()).toEqual([]);
    expect(calls).not.toContain("runBootstrap");
    // Nothing was recorded as created, so cleanup had nothing it could even consider dropping.
    expect((thrown as Error & { [CLEANUP_FAILURES]?: unknown[] })[CLEANUP_FAILURES]).toBeUndefined();
  });

  it("after an unknown outcome cleanup stays off even if a control check wrongly reports the lock as held", async () => {
    const { driver, drops, server } = sessionDriver({ dieDuring: "createOperatorLogin", applied: true, lyingControlCheck: true });
    const thrown = await provisionDisposableDatabase(driver, PLAN).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(UncertainOutcomeError);
    expect(drops()).toEqual([]);
    expect(server.has(`role:${OPERATOR_LOGIN}`)).toBe(true);
    // The refusal to clean up is reported with the original error, naming the cluster as contaminated.
    const attached = (thrown as Error & { [CLEANUP_FAILURES]?: unknown[] })[CLEANUP_FAILURES];
    expect(attached).toHaveLength(1);
    expect(String((attached?.[0] as Error).message)).toMatch(/Treat the cluster as contaminated/);
  });

  it("session lost just before a cluster-level step: the step is not sent and nothing created earlier is dropped", async () => {
    for (const step of CLUSTER_STEPS) {
      const { driver, calls, drops } = sessionDriver({ dieBefore: step, lyingControlCheck: true });
      const thrown = await provisionDisposableDatabase(driver, PLAN).catch((error: unknown) => error);
      expect(thrown, step).toBeInstanceOf(ExclusiveControlError);
      expect(calls.some((call) => call.startsWith(`${step}:`)), step).toBe(false);
      // The drops would need the same dead session: none is sent.
      expect(drops(), step).toEqual([]);
    }
  });

  it("an unknown outcome during cleanup ends cleanup: no further drop is attempted", async () => {
    const { driver, drops, server } = sessionDriver({ dieDuring: "dropDatabase", applied: false, lyingControlCheck: true });
    const provisioned = await provisionDisposableDatabase(driver, PLAN);
    const failures = await provisioned.cleanup();
    expect(drops()).toEqual([`dropDatabase:${DATABASE}`]);
    expect(failures[0]).toBeInstanceOf(UncertainOutcomeError);
    // The roles are left alone rather than dropped on a guess about the database.
    for (const name of SHOPACCESS_ROLES) expect(server.has(`role:${name}`)).toBe(true);
    expect(await provisioned.holdsExclusiveControl()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection target. Added by the connection-target remediation.
// ---------------------------------------------------------------------------

/** Built from parts, so that neither token appears literally in any file under tests/. */
const CONNECTION_STRING_KEY = ["connection", "String"].join("");
const LEGACY_DATABASE_VARIABLE = ["SHOPACCESS", "TEST", "DATABASE", "URL"].join("_");

const PORT = "54599";
/** Placed in the credentials of every URL below. It must never come back out in a result or an error. */
const MARKER = "zzMARKERzz";
const GOOD_V4 = `postgres://postgres:${MARKER}.pw-OK_1~@127.0.0.1:${PORT}/postgres`;
const GOOD_V6 = `postgresql://postgres:${MARKER}.pw-OK_1~@[::1]:${PORT}/postgres`;
const withHost = (host: string) => `postgres://postgres:${MARKER}@${host}:${PORT}/postgres`;
const withSuffix = (suffix: string) => `postgres://postgres:${MARKER}@127.0.0.1:${PORT}/postgres${suffix}`;

const targetEnv = (url: string | undefined, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ...(url === undefined ? {} : { [ADMIN_URL_VARIABLE]: url }),
  [AUTHORIZED_PORT_VARIABLE]: PORT,
  ...extra,
});
const codeOf = (env: Record<string, string | undefined>): string => {
  const result = parseAdminTarget(env);
  // The result is the whole of what a refusal exposes: it must not carry the input.
  if (!result.ok) expect(JSON.stringify(result)).not.toContain(MARKER);
  return result.ok ? "ACCEPTED" : result.code;
};

/** Sets or removes variables on the real process environment for the duration of `work`, then restores them. */
function withEnvironment<T>(overrides: Record<string, string | undefined>, work: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const refusalCode = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof AdminTargetRefusedError) {
      expect(error.message).toBe(`Refusing the PostgreSQL test connection target: ${error.code}`);
      return error.code;
    }
    throw error;
  }
  return "NOT_REFUSED";
};

const UNSAFE_URLS: ReadonlyArray<readonly [string, string, string]> = [
  // An alternate host, by the query parameter the driver lets override the URL's host.
  ["a host parameter naming a remote host", withSuffix("?host=db.example.com"), "ADMIN_URL_MALFORMED"],
  ["a host parameter naming another address", withSuffix("?host=10.0.0.5"), "ADMIN_URL_MALFORMED"],
  ["a hostaddr parameter", withSuffix("?hostaddr=10.0.0.5"), "ADMIN_URL_MALFORMED"],
  // Unix sockets, in each form the driver understands.
  ["a host parameter naming a socket directory", withSuffix("?host=/tmp"), "ADMIN_URL_MALFORMED"],
  ["a percent-encoded socket directory as host", withHost("%2Ftmp"), "ADMIN_URL_MALFORMED"],
  ["the socket scheme", `socket:/tmp/${MARKER}?db=postgres`, "ADMIN_URL_MALFORMED"],
  ["a bare socket path", `/tmp/${MARKER} postgres`, "ADMIN_URL_MALFORMED"],
  // Other overrides the driver would honour.
  ["a port parameter", withSuffix("?port=5432"), "ADMIN_URL_MALFORMED"],
  ["a user parameter", withSuffix("?user=other"), "ADMIN_URL_MALFORMED"],
  ["a password parameter", withSuffix("?password=other"), "ADMIN_URL_MALFORMED"],
  ["an options parameter", withSuffix("?options=-c%20role%3Dpostgres"), "ADMIN_URL_MALFORMED"],
  ["an sslmode parameter", withSuffix("?sslmode=require"), "ADMIN_URL_MALFORMED"],
  ["an sslrootcert parameter", withSuffix("?sslrootcert=/etc/hosts"), "ADMIN_URL_MALFORMED"],
  ["the libpq compatibility parameter", withSuffix("?uselibpqcompat=true"), "ADMIN_URL_MALFORMED"],
  // Anything at all after the path.
  ["a harmless-looking parameter", withSuffix("?application_name=x"), "ADMIN_URL_MALFORMED"],
  ["an empty query", withSuffix("?"), "ADMIN_URL_MALFORMED"],
  ["a fragment", withSuffix("#x"), "ADMIN_URL_MALFORMED"],
  ["a trailing slash", withSuffix("/"), "ADMIN_URL_MALFORMED"],
  ["a longer path", withSuffix("/x"), "ADMIN_URL_MALFORMED"],
  // Hosts that are not a loopback literal, or not the one accepted spelling of it.
  ["a remote name", withHost("db.example.com"), "ADMIN_URL_MALFORMED"],
  ["the name localhost", withHost("localhost"), "ADMIN_URL_MALFORMED"],
  ["a short spelling of the IPv4 loopback", withHost("127.1"), "ADMIN_URL_MALFORMED"],
  ["a hexadecimal spelling of the IPv4 loopback", withHost("0x7f.0.0.1"), "ADMIN_URL_MALFORMED"],
  ["a remote name that starts with the loopback address", withHost("127.0.0.1.example.com"), "ADMIN_URL_MALFORMED"],
  ["another address in the loopback block", withHost("127.0.0.2"), "ADMIN_URL_MALFORMED"],
  ["the wildcard address", withHost("0.0.0.0"), "ADMIN_URL_MALFORMED"],
  ["the expanded IPv6 loopback", withHost("[0:0:0:0:0:0:0:1]"), "ADMIN_URL_MALFORMED"],
  ["a zero-padded IPv6 loopback", withHost("[::0001]"), "ADMIN_URL_MALFORMED"],
  ["the IPv4-mapped IPv6 loopback", withHost("[::ffff:127.0.0.1]"), "ADMIN_URL_MALFORMED"],
  ["an IPv6 loopback with a zone", withHost("[::1%25lo0]"), "ADMIN_URL_MALFORMED"],
  ["an IPv6 loopback without brackets", withHost("::1"), "ADMIN_URL_MALFORMED"],
  ["an IPv6 loopback in double brackets", withHost("[[::1]]"), "ADMIN_URL_MALFORMED"],
  ["the IPv6 wildcard", withHost("[::]"), "ADMIN_URL_MALFORMED"],
  // Empty components, each of which would send the driver to an environment variable or a default.
  ["no host", `postgres://postgres:${MARKER}@:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["no port", `postgres://postgres:${MARKER}@127.0.0.1/postgres`, "ADMIN_URL_MALFORMED"],
  ["no user", `postgres://:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["no password", `postgres://${MARKER.toLowerCase()}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["an empty password", `postgres://${MARKER.toLowerCase()}:@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["no credentials at all", `postgres://127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["no database", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}/`, "ADMIN_URL_MALFORMED"],
  ["no path", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}`, "ADMIN_URL_MALFORMED"],
  // Another database or scheme.
  ["another database", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}/template1`, "ADMIN_URL_MALFORMED"],
  ["an http URL", `http://postgres:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a mysql URL", `mysql://postgres:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["an upper-case scheme", `POSTGRES://postgres:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a scheme without the slashes", `postgres:postgres:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  // Tricks with the user-information part.
  ["a second @ before the host", `postgres://postgres:${MARKER}@evil.example@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a second @ after the host", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}@evil.example/postgres`, "ADMIN_URL_MALFORMED"],
  ["a colon in the password", `postgres://postgres:${MARKER}:x@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["an upper-case user", `postgres://Postgres:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  // Encoding and whitespace, which the platform parser and the driver treat differently.
  ["a percent-encoded character in the password", `postgres://postgres:${MARKER}%41@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a percent-encoded character in the path", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}/post%67res`, "ADMIN_URL_MALFORMED"],
  ["a space inside", `postgres://postgres:${MARKER} @127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a leading space", ` ${GOOD_V4}`, "ADMIN_URL_MALFORMED"],
  ["a trailing space", `${GOOD_V4} `, "ADMIN_URL_MALFORMED"],
  ["a trailing newline", `${GOOD_V4}\n`, "ADMIN_URL_MALFORMED"],
  ["a tab inside", `postgres://postgres:${MARKER}@127.0.0.1:\t${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a backslash", `postgres:\\\\postgres:${MARKER}@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a control character", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}/postgres\u0000`, "ADMIN_URL_MALFORMED"],
  // Line terminators of every kind, at either end and inside. None may be accepted, whatever an end anchor would do.
  ["a trailing carriage return", `${GOOD_V4}\r`, "ADMIN_URL_MALFORMED"],
  ["a trailing CRLF", `${GOOD_V4}\r\n`, "ADMIN_URL_MALFORMED"],
  ["two trailing newlines", `${GOOD_V4}\n\n`, "ADMIN_URL_MALFORMED"],
  ["a leading newline", `\n${GOOD_V4}`, "ADMIN_URL_MALFORMED"],
  ["a leading CRLF", `\r\n${GOOD_V4}`, "ADMIN_URL_MALFORMED"],
  ["a newline inside", `postgres://postgres:${MARKER}@127.0.0.1:${PORT}\n/postgres`, "ADMIN_URL_MALFORMED"],
  ["a second, valid URL on a following line", `${GOOD_V4}\n${GOOD_V4}`, "ADMIN_URL_MALFORMED"],
  ["a trailing Unicode line separator", `${GOOD_V4}\u2028`, "ADMIN_URL_MALFORMED"],
  ["a trailing Unicode paragraph separator", `${GOOD_V4}\u2029`, "ADMIN_URL_MALFORMED"],
  ["a trailing next-line character", `${GOOD_V4}\u0085`, "ADMIN_URL_MALFORMED"],
  ["a trailing vertical tab", `${GOOD_V4}\v`, "ADMIN_URL_MALFORMED"],
  ["a trailing form feed", `${GOOD_V4}\f`, "ADMIN_URL_MALFORMED"],
  ["a trailing no-break space", `${GOOD_V4}\u00a0`, "ADMIN_URL_MALFORMED"],
  ["a trailing zero-width space", `${GOOD_V4}\u200b`, "ADMIN_URL_MALFORMED"],
  ["a byte-order mark in front", `\ufeff${GOOD_V4}`, "ADMIN_URL_MALFORMED"],
  ["a character outside ASCII in the password", `postgres://postgres:${MARKER}\u00e9@127.0.0.1:${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a delete character", `${GOOD_V4}\u007f`, "ADMIN_URL_MALFORMED"],
  // Ports.
  ["port zero", `postgres://postgres:${MARKER}@127.0.0.1:0/postgres`, "ADMIN_URL_MALFORMED"],
  ["a privileged port", `postgres://postgres:${MARKER}@127.0.0.1:80/postgres`, "ADMIN_URL_MALFORMED"],
  ["a port with a leading zero", `postgres://postgres:${MARKER}@127.0.0.1:0${PORT}/postgres`, "ADMIN_URL_MALFORMED"],
  ["a port that is not a number", `postgres://postgres:${MARKER}@127.0.0.1:port/postgres`, "ADMIN_URL_MALFORMED"],
  ["a port with six digits", `postgres://postgres:${MARKER}@127.0.0.1:545990/postgres`, "ADMIN_URL_MALFORMED"],
  ["a port above the range", `postgres://postgres:${MARKER}@127.0.0.1:65536/postgres`, "AUTHORIZED_PORT_MISMATCH"],
  ["the default PostgreSQL port", `postgres://postgres:${MARKER}@127.0.0.1:5432/postgres`, "AUTHORIZED_PORT_MISMATCH"],
  ["a port other than the authorized one", `postgres://postgres:${MARKER}@127.0.0.1:54600/postgres`, "AUTHORIZED_PORT_MISMATCH"],
];

/** The authorized port with a line terminator or another unprintable character at either end or inside. */
const UNPRINTABLE_PORTS = [
  "54599\r",
  "54599\r\n",
  "54599\n\n",
  "\n54599",
  "\r\n54599",
  "545\n99",
  "54599\n54599",
  "54599\u2028",
  "54599\u2029",
  "54599\u0085",
  "54599\v",
  "54599\f",
  "54599\t",
  "54599\u0000",
  "54599\u00a0",
  "54599\u200b",
  "\ufeff54599",
  "54599\u007f",
  // Digits that are not ASCII digits.
  "\uff15\uff14\uff15\uff19\uff19",
  "\u0665\u0664\u0665\u0669\u0669",
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
  "PGSSLCERT",
  "PGSSLKEY",
  "PGSSLROOTCERT",
  "PGREPLICATION",
  "PGBINARY",
  "PGCLIENT_ENCODING",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGPASSFILE",
  "PGPASS_NO_DEESCAPE",
  "PGDATA",
  "PGTZ",
  // Not a real variable today: a name the driver could start computing tomorrow.
  "PGSOMETHING_NEW_9",
  "PG",
  "NODE_PG_FORCE_NATIVE",
];

describe("connection target: the admin URL is validated before anything is constructed", () => {
  it("accepts exactly the two loopback literals, and reports the IPv6 loopback in the driver's form", () => {
    const v4 = parseAdminTarget(targetEnv(GOOD_V4));
    expect(v4).toEqual({ ok: true, target: { host: "127.0.0.1", port: 54599, user: "postgres", password: `${MARKER}.pw-OK_1~`, database: "postgres" } });
    const v6 = parseAdminTarget(targetEnv(GOOD_V6));
    // `[::1]` in the URL; `::1`, without brackets, is what the driver reports and what it is compared with.
    expect(v6).toEqual({ ok: true, target: { host: "::1", port: 54599, user: "postgres", password: `${MARKER}.pw-OK_1~`, database: "postgres" } });
    if (v4.ok) expect(Object.isFrozen(v4.target)).toBe(true);
  });

  it("the platform parser reads a bracketed IPv6 loopback with its brackets, the driver without: both reduce to one form", () => {
    expect(new URL(GOOD_V6).hostname).toBe("[::1]");
    const parsed = parseAdminTarget(targetEnv(GOOD_V6));
    if (!parsed.ok) throw new Error("expected the IPv6 loopback to be accepted");
    const config = connectionConfig(parsed.target, { database: "postgres", user: parsed.target.user, password: parsed.target.password });
    const client = new Client(config);
    expect(client.host).toBe("::1");
    expect(() => verifyEffectiveConfig(client, config)).not.toThrow();
  });

  it.each(UNSAFE_URLS)("refuses %s", (_name, url, code) => {
    expect(codeOf(targetEnv(url))).toBe(code);
  });

  it("distinguishes a variable that is not set from one set to an empty or blank string", () => {
    expect(codeOf(targetEnv(undefined))).toBe("ADMIN_URL_NOT_SET");
    expect(codeOf(targetEnv(""))).toBe("ADMIN_URL_EMPTY");
    expect(codeOf(targetEnv(" "))).toBe("ADMIN_URL_EMPTY");
    expect(codeOf(targetEnv("\t\n"))).toBe("ADMIN_URL_EMPTY");
  });

  it("requires the separately authorized port, in one strict form, never 5432 and never below 1024", () => {
    expect(codeOf({ [ADMIN_URL_VARIABLE]: GOOD_V4 })).toBe("AUTHORIZED_PORT_MISSING");
    for (const value of ["", " ", "abc", "0", "80", "1023", "65536", "99999", "054599", "5432", " 54599", "54599 ", "+54599", "-54599", "54599.0", "5.4e4", "0xD547", "54599\n", ...UNPRINTABLE_PORTS]) {
      expect(codeOf(targetEnv(GOOD_V4, { [AUTHORIZED_PORT_VARIABLE]: value })), JSON.stringify(value)).toBe("AUTHORIZED_PORT_INVALID");
    }
    // 5432 is refused even when the URL agrees with it.
    expect(codeOf(targetEnv(`postgres://postgres:${MARKER}@127.0.0.1:5432/postgres`, { [AUTHORIZED_PORT_VARIABLE]: "5432" }))).toBe("AUTHORIZED_PORT_INVALID");
    // The URL must repeat the authorized port: the port is never taken from the URL alone.
    expect(codeOf(targetEnv(GOOD_V4, { [AUTHORIZED_PORT_VARIABLE]: "54600" }))).toBe("AUTHORIZED_PORT_MISMATCH");
    // Both ends of the range.
    for (const port of ["1024", "65535"]) {
      expect(codeOf(targetEnv(`postgres://postgres:${MARKER}@127.0.0.1:${port}/postgres`, { [AUTHORIZED_PORT_VARIABLE]: port })), port).toBe("ACCEPTED");
    }
  });

  it("an unprintable character in the authorized port is invalid syntax, never a mismatch, whatever the URL says", () => {
    const otherPort = `postgres://postgres:${MARKER}@127.0.0.1:54600/postgres`;
    for (const value of ["54599\n", ...UNPRINTABLE_PORTS]) {
      // Against a URL that repeats the same digits, and against one that names another port: the same classification.
      expect(codeOf(targetEnv(GOOD_V4, { [AUTHORIZED_PORT_VARIABLE]: value })), JSON.stringify(value)).toBe("AUTHORIZED_PORT_INVALID");
      expect(codeOf(targetEnv(otherPort, { [AUTHORIZED_PORT_VARIABLE]: value })), JSON.stringify(value)).toBe("AUTHORIZED_PORT_INVALID");
    }
    // A mismatch is reported only when both values are well-formed and differ.
    expect(codeOf(targetEnv(otherPort))).toBe("AUTHORIZED_PORT_MISMATCH");
    // A well-formed port with a URL that carries a terminator is a malformed URL, not a port problem.
    for (const terminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      expect(codeOf(targetEnv(`${GOOD_V4}${terminator}`)), JSON.stringify(terminator)).toBe("ADMIN_URL_MALFORMED");
      expect(codeOf(targetEnv(`${otherPort}${terminator}`)), JSON.stringify(terminator)).toBe("ADMIN_URL_MALFORMED");
    }
    // The order of the checks is unchanged: a refused variable is still reported before either value is read.
    expect(codeOf(targetEnv(`${GOOD_V4}\n`, { [AUTHORIZED_PORT_VARIABLE]: "54599\n", PGHOST: "x" }))).toBe("ENVIRONMENT_VARIABLE_REFUSED");
    // And the invalid port before the malformed URL.
    expect(codeOf(targetEnv(`${GOOD_V4}\n`, { [AUTHORIZED_PORT_VARIABLE]: "54599\n" }))).toBe("AUTHORIZED_PORT_INVALID");
  });

  it("rejects line terminators by an explicit rule, on the whole input, with patterns that have no multiline flag", () => {
    const harness = readFileSync(join(process.cwd(), "tests", "db", "harness.ts"), "utf8");
    // The two patterns, exactly as reviewed: anchored at both ends and without flags.
    expect(harness).toContain("const PORT_TEXT = /^[1-9][0-9]{3,4}$/;");
    expect(harness).toMatch(/const ADMIN_URL_GRAMMAR =\n {2}\/\^\(postgres\|postgresql\):[^\n]*\\\/postgres\$\/;\n/);
    // Both raw inputs pass the explicit character rule and the whole-input rule before they are accepted.
    expect(harness).toContain('if (!isPrintableAscii(portText) || !matchWhole(PORT_TEXT, portText) || !isAuthorizablePort(Number(portText))) return refuse("AUTHORIZED_PORT_INVALID");');
    expect(harness).toContain("const match = isPrintableAscii(raw) ? matchWhole(ADMIN_URL_GRAMMAR, raw) : null;");
    expect(harness).toMatch(/if \(code < 0x21 \|\| code > 0x7e\) return false;/);
    expect(harness).toMatch(/return match !== null && match\.index === 0 && match\[0\]\.length === text\.length \? match : null;/);
    // Neither pattern is used anywhere else, so nothing accepts these inputs by another route.
    expect([...harness.matchAll(/\bPORT_TEXT\b/g)]).toHaveLength(2);
    // (The grammar: its declaration, its one use, and one mention in a comment.)
    expect([...harness.matchAll(/\bADMIN_URL_GRAMMAR\b/g)]).toHaveLength(3);
  });

  it.each(REFUSED_VARIABLES)("refuses to run while %s is set, even to an empty string", (name) => {
    expect(isRefusedEnvironmentVariable(name)).toBe(true);
    expect(codeOf(targetEnv(GOOD_V4, { [name]: "anything" }))).toBe("ENVIRONMENT_VARIABLE_REFUSED");
    expect(codeOf(targetEnv(GOOD_V4, { [name]: "" }))).toBe("ENVIRONMENT_VARIABLE_REFUSED");
    // A name that is present but undefined is not set.
    expect(codeOf(targetEnv(GOOD_V4, { [name]: undefined }))).toBe("ACCEPTED");
  });

  it("permits only the two harmless PostgreSQL variables, and names that are not PostgreSQL variables", () => {
    expect([...PERMITTED_PG_VARIABLES].sort()).toEqual(["PGAPPNAME", "PGCONNECT_TIMEOUT"]);
    for (const name of ["PGAPPNAME", "PGCONNECT_TIMEOUT", "USER", "USERNAME", "HOME", "PATH", "pghost", "MY_PGHOST", "NODE_ENV"]) {
      expect(isRefusedEnvironmentVariable(name), name).toBe(false);
      expect(codeOf(targetEnv(GOOD_V4, { [name]: "x" })), name).toBe("ACCEPTED");
    }
  });

  describe("when the platform parser fails or disagrees", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("drops the parser's error, which carries its input, and returns a fixed code", () => {
      vi.stubGlobal(
        "URL",
        class {
          constructor(input: string) {
            throw Object.assign(new TypeError(`Invalid URL: ${input}`), { input });
          }
        },
      );
      expect(codeOf(targetEnv(GOOD_V4))).toBe("ADMIN_URL_PARSER_DISAGREES");
    });

    it.each([
      ["hostname", { hostname: "db.example.com" }],
      ["port", { port: "5432" }],
      ["user", { username: "other" }],
      ["password", { password: "other" }],
      ["path", { pathname: "/template1" }],
      ["query", { search: "?host=db.example.com" }],
      ["fragment", { hash: "#x" }],
      ["scheme", { protocol: "http:" }],
    ])("refuses when the parser reads a different %s than the grammar", (_name, change) => {
      const Real = URL;
      vi.stubGlobal(
        "URL",
        class {
          constructor(input: string) {
            const real = new Real(input);
            Object.assign(this, {
              protocol: real.protocol,
              username: real.username,
              password: real.password,
              hostname: real.hostname,
              port: real.port,
              pathname: real.pathname,
              search: real.search,
              hash: real.hash,
              ...change,
            });
          }
        },
      );
      expect(codeOf(targetEnv(GOOD_V4))).toBe("ADMIN_URL_PARSER_DISAGREES");
    });
  });
});

describe("skip semantics: only a variable that is not set at all may skip the database suites", () => {
  const cleared = { [ADMIN_URL_VARIABLE]: undefined, [AUTHORIZED_PORT_VARIABLE]: undefined };

  it("returns undefined, so the suites skip, only when the variable is absent", () => {
    expect(withEnvironment(cleared, () => adminUrl())).toBeUndefined();
  });

  it("throws, so the suites fail, for an empty, blank, malformed or incompletely configured value", () => {
    expect(withEnvironment({ ...cleared, [ADMIN_URL_VARIABLE]: "" }, () => refusalCode(adminUrl))).toBe("ADMIN_URL_EMPTY");
    expect(withEnvironment({ ...cleared, [ADMIN_URL_VARIABLE]: "   " }, () => refusalCode(adminUrl))).toBe("ADMIN_URL_EMPTY");
    expect(withEnvironment({ ...cleared, [ADMIN_URL_VARIABLE]: GOOD_V4 }, () => refusalCode(adminUrl))).toBe("AUTHORIZED_PORT_MISSING");
    expect(withEnvironment({ [ADMIN_URL_VARIABLE]: withSuffix("?host=db.example.com"), [AUTHORIZED_PORT_VARIABLE]: PORT }, () => refusalCode(adminUrl))).toBe(
      "ADMIN_URL_MALFORMED",
    );
    expect(withEnvironment({ [ADMIN_URL_VARIABLE]: GOOD_V4, [AUTHORIZED_PORT_VARIABLE]: "5432" }, () => refusalCode(adminUrl))).toBe("AUTHORIZED_PORT_INVALID");
    expect(withEnvironment({ [ADMIN_URL_VARIABLE]: GOOD_V4, [AUTHORIZED_PORT_VARIABLE]: PORT, PGHOST: "db.example.com" }, () => refusalCode(adminUrl))).toBe(
      "ENVIRONMENT_VARIABLE_REFUSED",
    );
  });

  it("returns the value when the configuration is valid", () => {
    expect(withEnvironment({ [ADMIN_URL_VARIABLE]: GOOD_V4, [AUTHORIZED_PORT_VARIABLE]: PORT }, () => adminUrl())).toBe(GOOD_V4);
  });

  it("every database test file decides whether to skip through adminUrl() and nothing else", () => {
    const directory = join(process.cwd(), "tests", "db");
    const files = readdirSync(directory).filter((name) => name.endsWith(".test.ts"));
    expect(files).toHaveLength(12);
    for (const name of files) {
      const text = readFileSync(join(directory, name), "utf8");
      expect([...text.matchAll(/describe\.skipIf\(([^)]*\)?)\)/g)].map((match) => match[1]), name).toEqual(["!adminUrl()"]);
      expect(text, name).not.toMatch(/process\.env\[|describe\.skip\(|it\.skip\(/);
    }
  });
});

const TARGET: AdminTarget = { host: "127.0.0.1", port: 54599, user: "postgres", password: "admin-secret_1", database: "postgres" };
const STARTUP = "-c lock_timeout=2000 -c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000";
/** The six configurations the harness builds, in the order it builds them. */
const HARNESS_CONFIGS: ReadonlyArray<readonly [string, DriverConfig]> = [
  ["the lock-owning control session", connectionConfig(TARGET, { database: "postgres", user: TARGET.user, password: TARGET.password })],
  ["the bootstrap client", connectionConfig(TARGET, { database: DATABASE, user: TARGET.user, password: TARGET.password })],
  ["the migration pool", connectionConfig(TARGET, { database: DATABASE, user: TARGET.user, password: TARGET.password, options: "-c role=shopaccess_owner" })],
  ["the web pool and connectWeb", connectionConfig(TARGET, { database: DATABASE, user: "shopaccess_web", password: "a".repeat(48), options: STARTUP })],
  ["the operator pool", connectionConfig(TARGET, { database: DATABASE, user: OPERATOR_LOGIN, password: "b".repeat(48), options: STARTUP })],
  ["an IPv6 loopback target", connectionConfig({ ...TARGET, host: "::1" }, { database: DATABASE, user: "shopaccess_web", password: "a".repeat(48), options: STARTUP })],
];

/** What a faithful driver would report for a configuration. */
const faithful = (config: DriverConfig, change: Record<string, unknown> = {}): Record<string, unknown> => {
  const effective: Record<string, unknown> = {
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
    ...change,
  };
  return { host: effective.host, port: effective.port, user: effective.user, database: effective.database, ssl: effective.ssl, connectionParameters: effective };
};

const MISMATCHES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["host", { host: "10.0.0.5" }],
  ["host by name", { host: "localhost" }],
  ["port", { port: 5432 }],
  ["port as text", { port: "54599" }],
  ["database", { database: "template1" }],
  ["user", { user: "postgres_other" }],
  ["password", { password: "other" }],
  ["startup options", { options: "-c role=postgres" }],
  ["TLS switched on", { ssl: true }],
  ["TLS settings", { ssl: { rejectUnauthorized: false } }],
  ["a Unix socket", { isDomainSocket: true }],
  ["replication mode", { replication: "database" }],
  ["binary mode", { binary: true }],
];

describe("driver configuration: discrete fields, verified on the driver's own effective values", () => {
  it("builds exactly the discrete fields, frozen, with TLS off and no URL", () => {
    for (const [name, config] of HARNESS_CONFIGS) {
      expect(Object.keys(config).sort(), name).toEqual(config.options === undefined ? ["database", "host", "password", "port", "ssl", "user"] : ["database", "host", "options", "password", "port", "ssl", "user"]);
      expect(Object.isFrozen(config), name).toBe(true);
      expect(config.ssl, name).toBe(false);
      expect(config, name).not.toHaveProperty(CONNECTION_STRING_KEY);
    }
  });

  it("refuses a field that does not have its fixed form", () => {
    const identity = { database: DATABASE, user: "shopaccess_web", password: "a".repeat(48), options: STARTUP };
    const refused: Array<() => unknown> = [
      () => connectionConfig({ ...TARGET, host: "localhost" as "127.0.0.1" }, identity),
      () => connectionConfig({ ...TARGET, host: "/tmp" as "127.0.0.1" }, identity),
      () => connectionConfig({ ...TARGET, port: 5432 }, identity),
      () => connectionConfig({ ...TARGET, port: 80 }, identity),
      () => connectionConfig({ ...TARGET, port: 54599.5 }, identity),
      () => connectionConfig(TARGET, { ...identity, database: "post gres" }),
      () => connectionConfig(TARGET, { ...identity, database: "" }),
      () => connectionConfig(TARGET, { ...identity, user: "Web" }),
      () => connectionConfig(TARGET, { ...identity, user: "web;drop" }),
      () => connectionConfig(TARGET, { ...identity, password: "" }),
      () => connectionConfig(TARGET, { ...identity, password: "has space" }),
      () => connectionConfig(TARGET, { ...identity, password: "has@at" }),
      () => connectionConfig(TARGET, { ...identity, options: "" }),
      () => connectionConfig(TARGET, { ...identity, options: "-c role=postgres; x" }),
      () => connectionConfig(TARGET, { ...identity, options: "--cluster=x" }),
      // A line terminator in any field. These fields are generated by the harness; the patterns refuse them all the same.
      () => connectionConfig(TARGET, { ...identity, database: `${DATABASE}\n` }),
      () => connectionConfig(TARGET, { ...identity, user: "shopaccess_web\r\n" }),
      () => connectionConfig(TARGET, { ...identity, password: `${"a".repeat(48)}\n` }),
      () => connectionConfig(TARGET, { ...identity, password: `${"a".repeat(48)}\u2028` }),
      () => connectionConfig(TARGET, { ...identity, options: `${STARTUP}\n` }),
      () => connectionConfig(TARGET, { ...identity, options: `${STARTUP}\r` }),
      () => connectionConfig({ ...TARGET, host: "127.0.0.1\n" as "127.0.0.1" }, identity),
    ];
    for (const attempt of refused) expect(refusalCode(attempt)).toBe("CONNECTION_FIELD_REFUSED");
  });

  it.each(HARNESS_CONFIGS)("the installed driver's effective configuration for %s is exactly what the harness asked for", (_name, config) => {
    // Constructed only. Nothing here connects.
    const client = new Client(config);
    expect(() => verifyEffectiveConfig(client, config)).not.toThrow();
    expect({ host: client.host, port: client.port, user: client.user, database: client.database, ssl: client.ssl }).toEqual({
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      ssl: false,
    });
    const effective = (client as unknown as { connectionParameters: Record<string, unknown> }).connectionParameters;
    expect(effective.options).toBe(config.options);
    expect(effective.isDomainSocket).toBe(false);
    expect(effective.password).toBe(config.password);

    // A pool hands its clients the options it was given: the probe the harness verifies sees the same fields.
    const options = Object.freeze({ ...config, max: 2 });
    expect(() => verifyEffectiveConfig(new Client(options), config)).not.toThrow();
    const pool = new Pool(options);
    expect((pool as unknown as { options: Record<string, unknown> }).options).toMatchObject({ ...config });
    expect(pool.totalCount).toBe(0);
  });

  it.each(MISMATCHES)("refuses a client whose effective %s differs, for every harness configuration", (_name, change) => {
    for (const [name, config] of HARNESS_CONFIGS) {
      expect(() => verifyEffectiveConfig(faithful(config), config), name).not.toThrow();
      expect(refusalCode(() => verifyEffectiveConfig(faithful(config, change), config)), name).toBe("DRIVER_TARGET_MISMATCH");
    }
  });

  it("refuses anything that is not a client it can read", () => {
    const config = HARNESS_CONFIGS[0][1];
    for (const value of [null, undefined, "client", 7, {}, { host: config.host }, { ...faithful(config), connectionParameters: null }]) {
      expect(refusalCode(() => verifyEffectiveConfig(value, config))).toBe("DRIVER_TARGET_MISMATCH");
    }
  });

  it("what this closes: given a URL, the installed driver lets its parameters override host, port, user, options and transport", () => {
    // Constructed only, never connected. This is the behaviour the harness no longer depends on.
    const overridden = new Client({ [CONNECTION_STRING_KEY]: `${GOOD_V4}?host=db.example.com&port=6000&user=other&options=-c%20role%3Dpostgres`, options: STARTUP });
    expect({ host: overridden.host, port: overridden.port, user: overridden.user }).toEqual({ host: "db.example.com", port: 6000, user: "other" });
    expect((overridden as unknown as { connectionParameters: { options: unknown } }).connectionParameters.options).toBe("-c role=postgres");
    const socket = new Client({ [CONNECTION_STRING_KEY]: `${GOOD_V4}?host=/tmp` });
    expect((socket as unknown as { connectionParameters: { isDomainSocket: unknown } }).connectionParameters.isDomainSocket).toBe(true);
    // Each of them would have been refused before a client existed, and would fail verification if it had not been.
    const config = HARNESS_CONFIGS[0][1];
    expect(refusalCode(() => verifyEffectiveConfig(overridden, config))).toBe("DRIVER_TARGET_MISMATCH");
    expect(refusalCode(() => verifyEffectiveConfig(socket, config))).toBe("DRIVER_TARGET_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Environment variables the driver reads
// ---------------------------------------------------------------------------

/** Names read only on a path the harness never takes, because every configuration names its user and its password. */
const CONTROLLED_VARIABLES = ["USER", "USERNAME", "HOME", "APPDATA"];
const classify = (name: string): "rejected" | "permitted" | "controlled" | "UNCLASSIFIED" =>
  isRefusedEnvironmentVariable(name) ? "rejected" : PERMITTED_PG_VARIABLES.includes(name) ? "permitted" : CONTROLLED_VARIABLES.includes(name) ? "controlled" : "UNCLASSIFIED";

/** Runs `work` with the process environment replaced by a recorder that answers "not set" to everything. */
function recordEnvironmentReads(work: () => void): string[] {
  const reads = new Set<string>();
  const original = process.env;
  process.env = new Proxy({} as NodeJS.ProcessEnv, {
    get(_target, key) {
      if (typeof key === "string") reads.add(key);
      return undefined;
    },
    has(_target, key) {
      if (typeof key === "string") reads.add(key);
      return false;
    },
  });
  try {
    work();
  } finally {
    process.env = original;
  }
  return [...reads].sort();
}

const NODE_MODULES = join(process.cwd(), "node_modules");

/** The driver and everything it depends on, found from the installed package files. */
function driverPackages(): string[] {
  const seen = new Set<string>();
  const queue = ["pg"];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const manifest = JSON.parse(readFileSync(join(NODE_MODULES, name, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    queue.push(...Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).filter((dependency) => dependency !== "pg-native"));
  }
  return [...seen].sort();
}

function scriptsUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : scriptsUnder(path);
    return /\.(?:js|cjs|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("environment variables: every name the installed driver can read is classified", () => {
  it("at run time, constructing clients and pools reads only classified names, including the names the driver computes", () => {
    const web = HARNESS_CONFIGS[3][1];
    const control = HARNESS_CONFIGS[0][1];
    // The worst case first: an empty configuration falls back to the environment for everything.
    const fallback = recordEnvironmentReads(() => {
      new Client({});
      new Pool({});
    });
    // The driver builds these names as 'PG' + key: no fixed list in its source names them.
    for (const computed of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGOPTIONS", "PGBINARY", "PGCLIENT_ENCODING", "PGREPLICATION"]) {
      expect(fallback, computed).toContain(computed);
    }
    for (const name of fallback) expect(classify(name), name).not.toBe("UNCLASSIFIED");

    // A harness configuration leaves the driver nothing to look up for the target or the session.
    const configured = recordEnvironmentReads(() => {
      new Client(web);
      new Client(Object.freeze({ ...web, max: 12 }));
      new Pool(Object.freeze({ ...web, max: 12 }));
    });
    for (const name of configured) expect(classify(name), name).not.toBe("UNCLASSIFIED");
    for (const name of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGOPTIONS", "PGSSLMODE"]) expect(configured, name).not.toContain(name);

    // The control and bootstrap configurations pass no startup options: there the driver does consult PGOPTIONS, which is why it is refused.
    const withoutOptions = recordEnvironmentReads(() => {
      new Client(control);
    });
    expect(withoutOptions).toContain("PGOPTIONS");
    expect(classify("PGOPTIONS")).toBe("rejected");
    for (const name of withoutOptions) expect(classify(name), name).not.toBe("UNCLASSIFIED");
  });

  it("statically, every environment access in the driver and its dependencies is a reviewed one", () => {
    const packages = driverPackages();
    expect(packages).toEqual([
      "pg",
      "pg-cloudflare",
      "pg-connection-string",
      "pg-int8",
      "pg-pool",
      "pg-protocol",
      "pg-types",
      "pgpass",
      "postgres-array",
      "postgres-bytea",
      "postgres-date",
      "postgres-interval",
      "split2",
      "xtend",
    ]);
    const accesses = packages.flatMap((name) =>
      scriptsUnder(join(NODE_MODULES, name)).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]*\])?/g)].map((match) => `${file.slice(NODE_MODULES.length + 1)} | ${match[0]}`),
      ),
    );
    // A new access of either kind, literal or computed, fails here until it has been reviewed and classified.
    expect(accesses.sort()).toEqual(
      [
        // Computed: 'PG' + the upper-cased key of each val() call. The keys are enumerated in the next test.
        "pg/lib/connection-parameters.js | process.env['PG' + key.toUpperCase()]",
        // Computed: the name passed as val()'s third argument. Also enumerated in the next test.
        "pg/lib/connection-parameters.js | process.env[envVar]",
        "pg/lib/connection-parameters.js | process.env.PGSSLMODE",
        "pg/lib/connection-parameters.js | process.env.PGCONNECT_TIMEOUT",
        "pg/lib/index.js | process.env.NODE_PG_FORCE_NATIVE",
        "pg/lib/defaults.js | process.env.USERNAME",
        "pg/lib/defaults.js | process.env.USER",
        // The password-file reader, reached only when a client has no password. Its names are enumerated below.
        "pgpass/lib/helper.js | process.env",
        "pgpass/lib/helper.js | process.env",
        "pgpass/lib/helper.js | process.env",
      ].sort(),
    );
    for (const access of accesses) {
      const literal = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(access);
      if (literal) expect(classify(literal[1]), access).not.toBe("UNCLASSIFIED");
    }
  });

  it("the names behind the computed lookups are exactly the reviewed ones, and each is classified", () => {
    const source = readFileSync(join(NODE_MODULES, "pg", "lib", "connection-parameters.js"), "utf8");
    // val(key, config) reads 'PG' + KEY; val(key, config, 'NAME') reads NAME; val(key, config, false) reads nothing.
    expect(source).toMatch(/envVar = process\.env\['PG' \+ key\.toUpperCase\(\)\]/);
    expect(source).toMatch(/\} else if \(envVar === false\) \{/);
    const calls = [...source.matchAll(/\bval\('([a-z_]+)', config(?:, ([^)]+))?\)/g)];
    // Every use of val() has this shape: none passes a key or a name that this test cannot read.
    expect([...source.matchAll(/\bval\(/g)]).toHaveLength(calls.length);
    const names = calls
      .map(([, key, explicit]) => (explicit === undefined ? `PG${key.toUpperCase()}` : explicit === "false" ? null : /^'([A-Z_]+)'$/.exec(explicit)?.[1] ?? `UNREADABLE:${explicit}`))
      .filter((name): name is string => name !== null);
    expect([...new Set(names)].sort()).toEqual(
      ["PGAPPNAME", "PGBINARY", "PGCLIENT_ENCODING", "PGDATABASE", "PGHOST", "PGOPTIONS", "PGPASSWORD", "PGPORT", "PGREPLICATION", "PGSSLNEGOTIATION", "PGUSER"].sort(),
    );
    for (const name of names) expect(classify(name), name).not.toBe("UNCLASSIFIED");
    expect(names.filter((name) => classify(name) === "permitted")).toEqual(["PGAPPNAME"]);

    const passwordFile = readFileSync(join(NODE_MODULES, "pgpass", "lib", "helper.js"), "utf8");
    const passwordFileNames = [...passwordFile.matchAll(/(?:\benv\.|process\.env, ')([A-Z_]+)/g)].map((match) => match[1]);
    expect([...new Set(passwordFileNames)].sort()).toEqual(["APPDATA", "HOME", "PGPASSFILE", "PGPASSWORD", "PGPASS_NO_DEESCAPE"]);
    for (const name of passwordFileNames) expect(classify(name), name).not.toBe("UNCLASSIFIED");
  });

  it("classifies the default user name on every platform as controlled, and the two labels as permitted", () => {
    expect(classify("USER")).toBe("controlled");
    expect(classify("USERNAME")).toBe("controlled");
    expect(classify("PGAPPNAME")).toBe("permitted");
    expect(classify("PGCONNECT_TIMEOUT")).toBe("permitted");
    expect(classify("NODE_PG_FORCE_NATIVE")).toBe("rejected");
    // Controlled means: never reached, because every configuration names its user and password.
    for (const [, config] of HARNESS_CONFIGS) {
      expect(config.user).not.toBe("");
      expect(config.password).not.toBe("");
    }
    // The connect timeout the JavaScript client uses comes from its configuration, not from the variable.
    expect(readFileSync(join(NODE_MODULES, "pg", "lib", "client.js"), "utf8")).toMatch(/this\._connectionTimeoutMillis = c\.connectionTimeoutMillis \|\| 0/);
  });
});

// ---------------------------------------------------------------------------
// The PGT-04 child process
// ---------------------------------------------------------------------------

interface ChildRun {
  readonly stdout: string;
  readonly stderr: string;
  /** `process.exitCode` as the program left it. */
  readonly exitCode: unknown;
  /** The argument of `process.exit`, if the program called it. */
  readonly exited: number | null;
}

class ChildExit extends Error {}

/** Runs the child's program text in this process, against a given `pg` module and environment. No process is started. */
async function runChildProgram(env: NodeJS.ProcessEnv, pgModule: unknown): Promise<ChildRun> {
  const out: string[] = [];
  const err: string[] = [];
  let exited: number | null = null;
  const fakeProcess = {
    env,
    pid: 4242,
    exitCode: undefined as unknown,
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    stdin: { once: (_event: string, listener: (chunk: string) => void) => queueMicrotask(() => listener("go\n")), destroy: () => undefined },
    exit(code: number): never {
      exited = code;
      throw new ChildExit();
    },
  };
  const fakeRequire = (name: string): unknown => {
    if (name === "pg") return pgModule;
    if (name === "node:crypto") return { randomBytes };
    throw new Error(`the child program required an unexpected module: ${name}`);
  };
  // The program is one expression, so it can be returned and awaited.
  // Runs the reviewed program text against stubs. No process is started.
  const program = new Function("require", "process", `return ${ADMISSION_CHILD_PROGRAM.trim()}`) as (r: typeof fakeRequire, p: typeof fakeProcess) => Promise<void>;
  try {
    await program(fakeRequire, fakeProcess);
  } catch (error) {
    if (!(error instanceof ChildExit)) throw error;
  }
  return { stdout: out.join(""), stderr: err.join(""), exitCode: fakeProcess.exitCode, exited };
}

/** A recording stand-in for the driver's client. `change` makes it report something other than it was given. */
function childDriver(change: Record<string, unknown> = {}) {
  const log = { configs: [] as Record<string, unknown>[], connects: 0, queries: [] as string[], ends: 0 };
  class StubClient {
    host: unknown;
    port: unknown;
    user: unknown;
    database: unknown;
    ssl: unknown;
    connectionParameters: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      log.configs.push(config);
      const reported = faithful(config as unknown as DriverConfig, change);
      this.host = reported.host;
      this.port = reported.port;
      this.user = reported.user;
      this.database = reported.database;
      this.ssl = reported.ssl;
      this.connectionParameters = reported.connectionParameters as Record<string, unknown>;
    }
    async connect() {
      log.connects += 1;
    }
    async query(text: string) {
      log.queries.push(text);
      return { rows: [{ result: "ADMITTED" }] };
    }
    async end() {
      log.ends += 1;
    }
  }
  return { module: { Client: StubClient }, log };
}

const CHILD_STATEMENT = "SELECT result FROM shopaccess_api.admit_session($1, $2, $3)";
const WEB_CONFIG = HARNESS_CONFIGS[3][1];
const childEnvironment = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: Record<string, string | undefined> = { ...admissionChildEnvironment(WEB_CONFIG, CHILD_STATEMENT, 3, "/usr/bin:/bin"), ...overrides };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  return env as NodeJS.ProcessEnv;
};

describe("PGT-04 child process: its connection is verified in the child itself, before it connects", () => {
  it("its environment is exactly the allowlisted keys, built from a verified configuration, with no PostgreSQL variable and no URL", () => {
    const env = admissionChildEnvironment(WEB_CONFIG, CHILD_STATEMENT, 20, "/usr/bin:/bin");
    expect(Object.keys(env).sort()).toEqual([...ADMISSION_CHILD_ENVIRONMENT_KEYS].sort());
    expect(Object.keys(env).filter((name) => isRefusedEnvironmentVariable(name) || name.startsWith("PG"))).toEqual([]);
    expect(env).toMatchObject({
      NODE_ENV: "test",
      PATH: "/usr/bin:/bin",
      ADMISSION_HOST: "127.0.0.1",
      ADMISSION_PORT: "54599",
      ADMISSION_USER: "shopaccess_web",
      ADMISSION_DATABASE: DATABASE,
      ADMISSION_OPTIONS: STARTUP,
      ADMISSION_STATEMENT: CHILD_STATEMENT,
      ADMISSION_COUNT: "20",
    });
    for (const value of Object.values(env)) expect(value).not.toMatch(/^postgres(?:ql)?:\/\//);
  });

  it("refuses to build an environment from a configuration that is not in its fixed form", () => {
    const refused: Array<() => unknown> = [
      () => admissionChildEnvironment({ ...WEB_CONFIG, host: "localhost" as "127.0.0.1" }, CHILD_STATEMENT, 20, ""),
      () => admissionChildEnvironment({ ...WEB_CONFIG, port: 5432 }, CHILD_STATEMENT, 20, ""),
      () => admissionChildEnvironment({ ...WEB_CONFIG, user: "Web" }, CHILD_STATEMENT, 20, ""),
      () => admissionChildEnvironment({ ...WEB_CONFIG, password: "has space" }, CHILD_STATEMENT, 20, ""),
      () => admissionChildEnvironment({ ...WEB_CONFIG, database: "a b" }, CHILD_STATEMENT, 20, ""),
      () => admissionChildEnvironment({ ...WEB_CONFIG, options: undefined }, CHILD_STATEMENT, 20, ""),
      () => admissionChildEnvironment({ ...WEB_CONFIG, options: "--x" }, CHILD_STATEMENT, 20, ""),
      () => admissionChildEnvironment(WEB_CONFIG, CHILD_STATEMENT, 0, ""),
      () => admissionChildEnvironment(WEB_CONFIG, CHILD_STATEMENT, 1.5, ""),
    ];
    for (const attempt of refused) expect(refusalCode(attempt)).toBe("CONNECTION_FIELD_REFUSED");
  });

  it("the program gives the driver discrete fields only, verifies every client, then connects, admits and reports", async () => {
    const { module, log } = childDriver();
    const run = await runChildProgram(childEnvironment(), module);
    expect(log.configs).toHaveLength(3);
    for (const config of log.configs) {
      expect(config).toEqual({ host: "127.0.0.1", port: 54599, user: "shopaccess_web", password: "a".repeat(48), database: DATABASE, options: STARTUP, ssl: false });
    }
    expect(log.connects).toBe(3);
    expect(log.queries).toEqual([CHILD_STATEMENT, CHILD_STATEMENT, CHILD_STATEMENT]);
    expect(log.ends).toBe(3);
    expect(run.exitCode).toBe(0);
    expect(run.exited).toBeNull();
    expect(run.stderr).toBe("");
    const [ready, report] = run.stdout.trim().split("\n");
    expect(ready).toBe("ready");
    expect(JSON.parse(report)).toEqual({ pid: 4242, results: ["ADMITTED", "ADMITTED", "ADMITTED"] });
    expect(run.stdout + run.stderr).not.toContain("a".repeat(48));
  });

  it.each(MISMATCHES)("a child whose driver reports a different %s refuses with a fixed code and never connects", async (_name, change) => {
    const { module, log } = childDriver(change);
    const run = await runChildProgram(childEnvironment(), module);
    expect(run.stderr).toBe("child refused: DRIVER_TARGET_MISMATCH\n");
    expect(run.stdout).toBe("");
    expect(run.exitCode).toBe(2);
    expect(log.connects).toBe(0);
    expect(log.queries).toEqual([]);
  });

  it.each([
    ["PGHOST", "db.example.com"],
    ["PGPORT", "5432"],
    ["PGOPTIONS", "-c role=postgres"],
    ["PGAPPNAME", "x"],
    ["PGSOMETHING_NEW_9", "x"],
    ["NODE_PG_FORCE_NATIVE", "1"],
  ])("a child that finds %s in its environment refuses before constructing anything", async (name, value) => {
    const { module, log } = childDriver();
    const run = await runChildProgram(childEnvironment({ [name]: value }), module);
    expect(run.stderr).toBe("child refused: ENVIRONMENT_VARIABLE_REFUSED\n");
    expect(run.exitCode).toBe(2);
    expect(log.configs).toEqual([]);
    expect(log.connects).toBe(0);
  });

  it.each([
    ["a host name", { ADMISSION_HOST: "localhost" }],
    ["a remote host", { ADMISSION_HOST: "db.example.com" }],
    ["a socket directory", { ADMISSION_HOST: "/tmp" }],
    ["no host", { ADMISSION_HOST: undefined }],
    ["the default port", { ADMISSION_PORT: "5432" }],
    ["a privileged port", { ADMISSION_PORT: "80" }],
    ["a port that is not a number", { ADMISSION_PORT: "54599x" }],
    ["no port", { ADMISSION_PORT: undefined }],
    ["no user", { ADMISSION_USER: undefined }],
    ["no password", { ADMISSION_PASSWORD: undefined }],
    ["no database", { ADMISSION_DATABASE: undefined }],
    ["no startup options", { ADMISSION_OPTIONS: undefined }],
    ["unexpected startup options", { ADMISSION_OPTIONS: "-c role=postgres; x" }],
    ["no count", { ADMISSION_COUNT: undefined }],
    ["a count of zero", { ADMISSION_COUNT: "0" }],
    // Line terminators. The child's own patterns refuse them; no further guard is needed there.
    ["a host with a trailing newline", { ADMISSION_HOST: "127.0.0.1\n" }],
    ["a port with a trailing newline", { ADMISSION_PORT: "54599\n" }],
    ["a port with a trailing CRLF", { ADMISSION_PORT: "54599\r\n" }],
    ["a port with a trailing line separator", { ADMISSION_PORT: "54599\u2028" }],
    ["a user with a trailing carriage return", { ADMISSION_USER: "shopaccess_web\r" }],
    ["a database with a trailing newline", { ADMISSION_DATABASE: `${DATABASE}\n` }],
    ["a password with a trailing newline", { ADMISSION_PASSWORD: `${"a".repeat(48)}\n` }],
    ["startup options with a trailing newline", { ADMISSION_OPTIONS: `${STARTUP}\n` }],
    ["a count with a trailing newline", { ADMISSION_COUNT: "3\n" }],
  ])("a child given %s refuses before constructing anything", async (_name, overrides) => {
    const { module, log } = childDriver();
    const run = await runChildProgram(childEnvironment(overrides), module);
    expect(run.stderr).toBe("child refused: CONNECTION_FIELD_REFUSED\n");
    expect(run.exitCode).toBe(2);
    expect(log.configs).toEqual([]);
    expect(log.connects).toBe(0);
  });

  it("the child's own check accepts the installed driver's effective configuration, and nothing is connected until all clients passed it", async () => {
    let connects = 0;
    let constructed = 0;
    // The real client class, with only `connect` replaced: no socket is ever opened.
    class NeverConnects extends Client {
      constructor(config: ConstructorParameters<typeof Client>[0]) {
        super(config);
        constructed += 1;
      }
    }
    (NeverConnects.prototype as unknown as { connect: () => Promise<never> }).connect = () => {
      // All three clients exist, verified against the real driver, before the first connect is attempted.
      expect(constructed).toBe(3);
      connects += 1;
      return Promise.reject(Object.assign(new Error("not connecting in a unit test"), { code: "STUBBED" }));
    };
    const run = await runChildProgram(childEnvironment(), { Client: NeverConnects });
    expect(connects).toBe(1);
    expect(run.stderr).toBe("child failed: STUBBED\n");
    expect(run.exited).toBe(1);
    expect(run.stdout).toBe("");
  });

  it("the program text contains no URL handling, and the test file starts it only through the harness", () => {
    expect(ADMISSION_CHILD_PROGRAM).not.toContain(CONNECTION_STRING_KEY);
    expect(ADMISSION_CHILD_PROGRAM).not.toMatch(/ADMISSION_URL|postgres:\/\/|new URL/);
    expect([...ADMISSION_CHILD_PROGRAM.matchAll(/new Client\(/g)]).toHaveLength(1);
    // Verification precedes the first connect in the text, and nothing connects inside the constructing loop.
    expect(ADMISSION_CHILD_PROGRAM.indexOf('refuse("DRIVER_TARGET_MISMATCH")')).toBeLessThan(ADMISSION_CHILD_PROGRAM.indexOf("client.connect()"));
    expect([...ADMISSION_CHILD_PROGRAM.matchAll(/\.connect\(\)/g)]).toHaveLength(1);

    const test = readFileSync(join(process.cwd(), "tests", "db", "admission-processes.test.ts"), "utf8");
    expect(test).toMatch(/spawn\(process\.execPath, \["-e", ADMISSION_CHILD_PROGRAM\], \{\s+cwd: ROOT,\s+\/\/[^\n]*\n\s+env: admissionChildEnvironment\(db\.webConnection, SESSION_STATEMENTS\.admitSession, ADMISSIONS_PER_PROCESS, process\.env\.PATH \?\? ""\),/);
    expect([...test.matchAll(/spawn\(/g)]).toHaveLength(1);
    expect(test).not.toMatch(/new Client\(|ADMISSION_URL|require\("pg"\)/);
  });
});

describe("no test opens a database connection outside the harness", () => {
  const filesUnderTests = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnderTests(join(directory, entry.name)) : [join(directory, entry.name)]));
  const tests = filesUnderTests(join(process.cwd(), "tests"));

  it("no file under tests/ passes the driver a URL", () => {
    expect(tests.length).toBeGreaterThan(20);
    for (const file of tests) expect(readFileSync(file, "utf8"), file).not.toContain(CONNECTION_STRING_KEY);
  });

  it("the legacy MIG-01 database path is gone: its variable is read nowhere, and the unit suite constructs no client for a database", () => {
    const sources = [...tests, ...scriptsUnderSource(join(process.cwd(), "src"))];
    for (const file of sources) expect(readFileSync(file, "utf8"), file).not.toContain(LEGACY_DATABASE_VARIABLE);

    const environment = readFileSync(join(process.cwd(), "tests", "unit", "environment.test.ts"), "utf8");
    expect(environment).not.toMatch(/from "pg"|import\("pg"\)|new Client\(|new Pool\(|\.connect\(|skipIf|MIG-01/);
    // Its database-free static checks of the archived drafts remain.
    expect(environment).toMatch(/describe\("migration files \(static checks only - these do not execute SQL\)"/);
    expect(environment).toMatch(/const MIGRATIONS_DIR = join\(ROOT, "db", "migrations", "archive", "milestone-001-unexecuted"\);/);

    // Outside the harness, only this file and the stub-first file touch the driver, and neither connects.
    const unit = join(process.cwd(), "tests", "unit");
    const importers = readdirSync(unit).filter((name) => /from "pg"|import\("pg"\)|vi\.mock\("pg"/.test(readFileSync(join(unit, name), "utf8")));
    expect(importers.sort()).toEqual(["pg-admin-target.test.ts", "pg-harness.test.ts"]);
  });
});

function scriptsUnderSource(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? scriptsUnderSource(join(directory, entry.name)) : [join(directory, entry.name)]));
}

describe("harness source: cluster-level statements have exactly one route", () => {
  const source = readFileSync(join(process.cwd(), "tests", "db", "harness.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("opens exactly one connection to the maintenance database: the lock-owning session", () => {
    const control = /const client = verifiedClient\(connectionConfig\(target, \{ database: CONTROL_DATABASE, user: target\.user, password: target\.password \}\)\);\s+const session = new ControlSession\(client\);/;
    expect(code).toMatch(control);
    // No other configuration names the maintenance database.
    expect([...code.matchAll(/database: CONTROL_DATABASE/g)]).toHaveLength(1);
    expect(code).not.toMatch(/withCluster/);
  });

  it("constructs clients and pools only inside the two verifying helpers, from discrete fields, never from a URL", () => {
    // In the harness itself: one client in each helper (the pool helper's is an unconnected probe). The third is inside
    // the child program's text, which verifies its own clients (tested above).
    expect([...code.matchAll(/new Client\(/g)]).toHaveLength(3);
    expect(code).toMatch(/function verifiedClient\(config: DriverConfig\): Client \{\s+const client = new Client\(config\);\s+verifyEffectiveConfig\(client, config\);\s+return client;\s+\}/);
    expect(code).toMatch(/function verifiedPool\(config: DriverConfig, max: number\): Pool \{\s+const options = Object\.freeze\(\{ \.\.\.config, max \}\);\s+verifyEffectiveConfig\(new Client\(options\), config\);\s+return new Pool\(options\);\s+\}/);
    expect([...code.matchAll(/new Pool\(/g)]).toHaveLength(1);

    // Every connection goes through a helper, and every configuration comes from the validated target.
    const sites = [...code.matchAll(/verified(?:Client|Pool)\(\s*(connectionConfig\(target, \{[^}]*\}\)|[A-Za-z]+)/g)].map((match) => match[1].replace(/\s+/g, " "));
    expect(sites.sort()).toEqual(
      [
        "config",
        "config",
        "connectionConfig(target, { database: CONTROL_DATABASE, user: target.user, password: target.password })",
        "connectionConfig(target, { database, user: target.user, password: target.password })",
        // The second test-owner connection: the same target and credentials, in the test database, no startup option.
        "connectionConfig(target, { database: plan.database, user: target.user, password: target.password })",
        'connectionConfig(target, { database: plan.database, user: target.user, password: target.password, options: "-c role=shopaccess_owner" })',
        "webConnection",
        "webConnection",
        "connectionConfig(target, { database: plan.database, user: plan.operatorLogin, password: operatorPassword, options: connectionStartupOptions() })",
      ].sort(),
    );
    // The target is validated before anything else in the entry point, and nothing parses a URL for the driver.
    expect(code).toMatch(/export async function openDisposableDatabase\([^)]*\): Promise<DisposableDatabase> \{\s+const parsed = parseAdminTarget\(process\.env\);/);
    expect(code).not.toContain(CONNECTION_STRING_KEY);
    expect(code).not.toMatch(/urlFor|new URL\(base|\.toString\(\)\s*;\s*\/\/ url/);
  });

  it("sends every cluster-level statement through the lock-owning session and nowhere else", () => {
    const statements = [...code.matchAll(/`((?:CREATE DATABASE|DROP DATABASE|CREATE ROLE|ALTER ROLE|DROP ROLE|GRANT) [^`]*)`/g)];
    expect(statements.map((match) => match[1].split(" ").slice(0, 2).join(" ")).sort()).toEqual(
      ["ALTER ROLE", "CREATE DATABASE", "CREATE ROLE", "DROP DATABASE", "DROP ROLE", "GRANT CONNECT", "GRANT shopaccess_operator"].sort(),
    );
    for (const match of statements) {
      const before = code.slice(Math.max(0, match.index - 60), match.index);
      expect(before, match[1]).toMatch(/lockSession\(\)\.run\(\s*$/);
    }
    // The administrator connection inside the test database sends none of them.
    expect(code).not.toMatch(/requireAdmin\(\)\.query\(/);
    // The session never opens a transaction.
    expect(code).not.toMatch(/["'`](?:BEGIN|START TRANSACTION)\b/);
    // No drop is conditional or pattern-based: only exact names recorded by this run.
    expect(code).not.toMatch(/IF EXISTS|DROP OWNED|LIKE '/);
  });
});
