import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessDisposableCluster,
  assessProvisionedRoles,
  CLEANUP_FAILURES,
  ControlSession,
  DISPOSABLE_CLUSTER_NAME,
  ExclusiveControlError,
  provisionDisposableDatabase,
  SHOPACCESS_ROLES,
  UncertainOutcomeError,
  type ClusterFacts,
  type ControlClient,
  type MembershipFacts,
  type ProvisionDriver,
  type ProvisionPlan,
  type RoleFacts,
} from "../db/harness";

// Database-free. These tests exercise the harness's decisions and its cleanup
// against in-memory facts and a fake driver. Nothing connects to PostgreSQL.

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

describe("harness source: cluster-level statements have exactly one route", () => {
  const source = readFileSync(join(process.cwd(), "tests", "db", "harness.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("opens exactly one connection to the maintenance database: the lock-owning session", () => {
    expect([...code.matchAll(/new Client\(\{ connectionString: raw \}\)/g)]).toHaveLength(1);
    expect(code).toMatch(/const client = new Client\(\{ connectionString: raw \}\);\s+const session = new ControlSession\(client\);/);
    expect(code).not.toMatch(/withCluster|new Pool\(\{ connectionString: raw/);
    // Every other connection names the test database or a test login.
    const targets = [...code.matchAll(/new (?:Client|Pool)\(\{\s*connectionString: (urlFor\([^)]*\)|[A-Za-z]+)/g)].map((match) => match[1]);
    expect(targets.sort()).toEqual(
      ["raw", "urlFor(base, database)", "urlFor(base, plan.database)", "webConnectionString", "webConnectionString", "urlFor(base, plan.database, plan.operatorLogin, operatorPassword)"].sort(),
    );
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
