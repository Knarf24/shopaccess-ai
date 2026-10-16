import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { assembleCatalog, readCatalog } from "@/lib/pg/catalog";
import type { PgQueryResult } from "@/lib/pg/client";
import { loadKeyRings, type ConfiguredKeyRings } from "@/lib/pg/key-ring";
import {
  evaluateReadinessRows,
  expectedReadinessRow,
  probeReadiness,
  PROHIBITED_FUNCTIONS,
  PROHIBITED_TABLES,
  READABLE_TABLES,
  readinessProbeParameters,
  READINESS_SCHEMAS,
  REQUIRED_FUNCTIONS,
} from "@/lib/pg/readiness";
import { APPLICATION_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { createPgRuntime, READY_FOR_MS, RETRY_AFTER_MS, type PgPool } from "@/server/pg-runtime";
import { createTestClock } from "./helpers";

// NEVER RUN when written. Database-free: the pool here is a fake that answers the readiness probe, the key-version
// read and the catalog read from scripts. The probe statement itself has never been executed by PostgreSQL, so
// nothing here shows that it is valid SQL or that it returns what the fake returns.

// Synthetic, test-only values.
const SESSION_KEYS = `1:${Buffer.alloc(32, 51).toString("base64")}`;
const NONCE_KEYS = `1:${Buffer.alloc(32, 52).toString("base64")}`;
const ENV: Readonly<Record<string, string | undefined>> = {
  SHOPACCESS_DATABASE_URL: "postgres://shopaccess_web@db.example.test:5432/shopaccess",
  SHOPACCESS_SESSION_KEYS: SESSION_KEYS,
  SHOPACCESS_NONCE_KEYS: NONCE_KEYS,
  SHOPACCESS_TRUSTED_ORIGINS: "https://shop.example.test",
  PAYMENT_PROVIDER_MODE: "mock",
};

type Row = Record<string, unknown>;

function testRings(): ConfiguredKeyRings {
  const rings = loadKeyRings({ sessionKeys: SESSION_KEYS, nonceKeys: NONCE_KEYS });
  if (!rings.ok) throw new Error("test key rings refused");
  return rings.value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A pool that answers the three statements the runtime itself sends, and counts how often it is ended. */
class ProbePool implements PgPool {
  readonly calls: string[] = [];
  readonly parameters: Array<readonly unknown[]> = [];
  endCalls = 0;
  probeRow: Row = { ...expectedReadinessRow() };
  sessionKeyStatus = "ACTIVE";
  nonceCheckValue: string | null = null;
  /** When set, the probe statement waits for this before it answers. */
  probeGate: Promise<void> | null = null;
  /** When set, `end` waits for this before it resolves. */
  endGate: Promise<void> | null = null;
  private readonly rings = testRings();

  async query<Result = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<PgQueryResult<Result>> {
    if (text === APPLICATION_STATEMENTS.readinessProbe) {
      this.calls.push("readinessProbe");
      this.parameters.push(values);
      if (this.probeGate) await this.probeGate;
      return { rows: [this.probeRow] as Result[] };
    }
    if (text === SESSION_STATEMENTS.readKeyVersions) {
      this.calls.push(`readKeyVersions:${String(values[0])}`);
      const row =
        values[0] === "session"
          ? { purpose: "session", key_version: 1, status: this.sessionKeyStatus, check_value: this.rings.session.checkValue(1) }
          : { purpose: "confirmation_nonce", key_version: 1, status: "ACTIVE", check_value: this.nonceCheckValue ?? this.rings.confirmationNonce.checkValue(1) };
      return { rows: [row] as Result[] };
    }
    this.calls.push("other");
    throw new Error("a statement the runtime does not send itself");
  }

  end(): Promise<void> {
    this.endCalls += 1;
    return this.endGate ?? Promise.resolve();
  }

  probes(): number {
    return this.calls.filter((name) => name === "readinessProbe").length;
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("readiness probe: the expected row, and what each difference means (A24, A42)", () => {
  it("accepts exactly the expected row", () => {
    expect(evaluateReadinessRows([{ ...expectedReadinessRow() }])).toEqual({ ok: true, value: undefined });
    expect(expectedReadinessRow()).toEqual({
      session_user_name: "shopaccess_web",
      current_user_name: "shopaccess_web",
      plain_role_rows: 1,
      membership_rows: 0,
      required_functions_executable: 10,
      prohibited_functions_present: 9,
      prohibited_functions_executable: 0,
      readable_tables_readable: 4,
      readable_tables_writable: 0,
      prohibited_tables_present: 12,
      prohibited_tables_reachable: 0,
      schemas_usable: 2,
      schemas_creatable: 0,
      database_elevated: false,
    });
  });

  it("A24: names the failure of every column that differs", () => {
    const cases: Array<[string, unknown, string]> = [
      ["session_user_name", "shopaccess_owner", "ROLE_NOT_WEB"],
      ["session_user_name", "postgres", "ROLE_NOT_WEB"],
      ["current_user_name", "shopaccess_definer", "ROLE_NOT_WEB"],
      ["plain_role_rows", 0, "ROLE_ELEVATED"],
      ["membership_rows", 1, "ROLE_HAS_MEMBERSHIP"],
      ["required_functions_executable", 9, "REQUIRED_FUNCTION_NOT_EXECUTABLE"],
      ["prohibited_functions_present", 8, "PROHIBITED_FUNCTION_MISSING"],
      ["prohibited_functions_executable", 1, "PROHIBITED_FUNCTION_EXECUTABLE"],
      ["readable_tables_readable", 3, "READABLE_TABLE_NOT_READABLE"],
      ["readable_tables_writable", 1, "READABLE_TABLE_WRITABLE"],
      ["prohibited_tables_present", 11, "PROHIBITED_TABLE_MISSING"],
      ["prohibited_tables_reachable", 1, "PROHIBITED_TABLE_REACHABLE"],
      ["schemas_creatable", 1, "SCHEMA_CREATE_HELD"],
      ["database_elevated", true, "DATABASE_PRIVILEGE_ELEVATED"],
      // A count as text, or a boolean as text, is not the expected value.
      ["required_functions_executable", "10", "REQUIRED_FUNCTION_NOT_EXECUTABLE"],
      ["database_elevated", "f", "DATABASE_PRIVILEGE_ELEVATED"],
      ["membership_rows", null, "ROLE_HAS_MEMBERSHIP"],
    ];
    for (const [column, value, failure] of cases) {
      expect(evaluateReadinessRows([{ ...expectedReadinessRow(), [column]: value }]), `${column}=${String(value)}`).toEqual({ ok: false, error: failure });
    }
  });

  it("A42: USAGE missing on either schema is 'not ready'", () => {
    for (const usable of [1, 0]) {
      expect(evaluateReadinessRows([{ ...expectedReadinessRow(), schemas_usable: usable }]), String(usable)).toEqual({ ok: false, error: "SCHEMA_USAGE_MISSING" });
    }
  });

  it("refuses anything but one row with exactly the expected columns", () => {
    const row = { ...expectedReadinessRow() };
    const { membership_rows: _dropped, ...missing } = row;
    void _dropped;
    for (const rows of [[], [row, row], [null], ["row"], [missing], [{ ...row, extra: 1 }]]) {
      expect(evaluateReadinessRows(rows), JSON.stringify(rows).slice(0, 40)).toEqual({ ok: false, error: "PROBE_ROW_INVALID" });
    }
  });

  it("binds thirteen values, one per placeholder, and the lists are the ones the migrations define", () => {
    const parameters = readinessProbeParameters();
    const placeholders = new Set(APPLICATION_STATEMENTS.readinessProbe.match(/\$\d+/g));
    expect(parameters).toHaveLength(13);
    expect(placeholders.size).toBe(13);
    expect(parameters.slice(0, 5)).toEqual([[...REQUIRED_FUNCTIONS], [...PROHIBITED_FUNCTIONS], [...READABLE_TABLES], [...PROHIBITED_TABLES], [...READINESS_SCHEMAS]]);
    for (const value of parameters.slice(5)) expect(typeof value).toBe("string");
    // The probe's text names no object and holds no literal: every name above travels as a bound value.
    expect(APPLICATION_STATEMENTS.readinessProbe).not.toMatch(/'|shopaccess_web|shopaccess_api|shopaccess\./);

    const directory = join(process.cwd(), "db", "migrations");
    const sql = readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(join(directory, name), "utf8").replace(/--[^\n]*/g, ""))
      .join("\n");
    // Required: exactly the functions the migrations let the web role execute.
    const granted = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION (shopaccess_api\.[a-z_0-9]+\([^)]*\)) TO shopaccess_web;/g)].map((match) => match[1]);
    expect([...new Set(granted)].sort()).toEqual([...REQUIRED_FUNCTIONS].sort());
    // Prohibited: functions the migrations create and take from PUBLIC, none of them granted to the web role.
    const revoked = [...sql.matchAll(/REVOKE ALL ON FUNCTION (shopaccess_api\.[a-z_0-9]+\([^)]*\)) FROM PUBLIC;/g)].map((match) => match[1]);
    for (const signature of PROHIBITED_FUNCTIONS) {
      expect(revoked, signature).toContain(signature);
      expect(granted, signature).not.toContain(signature);
    }
    expect([...new Set(revoked)].filter((signature) => !granted.includes(signature)).sort()).toEqual([...PROHIBITED_FUNCTIONS].sort());
    // Readable: exactly the tables the web role is granted to read. Prohibited: tables that exist and are granted to it nowhere.
    const readable = [...sql.matchAll(/GRANT SELECT ON ([a-z_., \n]+?) TO ([a-z_, ]+);/g)]
      .filter((match) => match[2].split(",").map((role) => role.trim()).includes("shopaccess_web"))
      .flatMap((match) => match[1].split(",").map((table) => table.trim()));
    expect(readable.sort()).toEqual([...READABLE_TABLES].sort());
    const created = [...sql.matchAll(/CREATE TABLE (shopaccess\.[a-z_]+) \(/g)].map((match) => match[1]);
    for (const table of PROHIBITED_TABLES) {
      expect(created, table).toContain(table);
      expect(readable, table).not.toContain(table);
    }
    expect(created.filter((table) => !readable.includes(table)).sort()).toEqual([...PROHIBITED_TABLES].sort());
    expect([...READINESS_SCHEMAS]).toEqual(["shopaccess", "shopaccess_api"]);
  });

  it("A24: requires the configured rings to agree with the database's key versions, after the probe row", async () => {
    const rings = testRings();
    const good = new ProbePool();
    expect(await probeReadiness(good, rings)).toEqual({ ok: true, value: undefined });
    expect(good.calls).toEqual(["readinessProbe", "readKeyVersions:session", "readKeyVersions:confirmation_nonce"]);
    expect(good.parameters).toEqual([readinessProbeParameters()]);

    const noActiveSessionKey = new ProbePool();
    noActiveSessionKey.sessionKeyStatus = "VERIFY_ONLY";
    expect(await probeReadiness(noActiveSessionKey, rings)).toEqual({ ok: false, error: "SESSION_KEY_STATE" });

    const otherNonceKey = new ProbePool();
    otherNonceKey.nonceCheckValue = "0".repeat(64);
    expect(await probeReadiness(otherNonceKey, rings)).toEqual({ ok: false, error: "NONCE_KEY_STATE" });

    // A failed row ends the attempt: the key versions are not read.
    const wrongRole = new ProbePool();
    wrongRole.probeRow = { ...expectedReadinessRow(), session_user_name: "shopaccess_owner" };
    expect(await probeReadiness(wrongRole, rings)).toEqual({ ok: false, error: "ROLE_NOT_WEB" });
    expect(wrongRole.calls).toEqual(["readinessProbe"]);
  });
});

describe("PostgreSQL runtime: one pool, shared construction and probing, bounded retry (A24, A43, A44)", () => {
  it("A43: twenty concurrent first requests build one pool, send one probe and receive the same services", async () => {
    const pool = new ProbePool();
    let created = 0;
    const runtime = createPgRuntime(ENV, {
      createPool: () => {
        created += 1;
        return pool;
      },
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => runtime.services()));
    expect(created).toBe(1);
    expect(pool.probes()).toBe(1);
    expect(results[0]).not.toBeNull();
    for (const services of results) expect(services).toBe(results[0]);
    expect(pool.endCalls).toBe(0);
  });

  it("A44: after a failed probe nothing is sent for five seconds, then exactly one new attempt; a success is trusted for sixty seconds; the pool is never replaced", async () => {
    const time = createTestClock();
    const pool = new ProbePool();
    let created = 0;
    const runtime = createPgRuntime(ENV, {
      clock: time.clock,
      createPool: () => {
        created += 1;
        return pool;
      },
    });

    pool.probeRow = { ...expectedReadinessRow(), membership_rows: 1 };
    expect(await runtime.services()).toBeNull();
    expect(pool.probes()).toBe(1);
    const sentAfterFailure = pool.calls.length;

    // Inside the retry interval: "not available", and no statement of any kind.
    expect(await runtime.services()).toBeNull();
    time.advance(RETRY_AFTER_MS - 1);
    expect(await Promise.all([runtime.services(), runtime.services(), runtime.services()])).toEqual([null, null, null]);
    expect(pool.calls).toHaveLength(sentAfterFailure);

    // At the interval: one attempt, shared by the requests that arrive together.
    time.advance(1);
    expect(await Promise.all([runtime.services(), runtime.services()])).toEqual([null, null]);
    expect(pool.probes()).toBe(2);

    // The database becomes usable: the next attempt after the interval succeeds.
    pool.probeRow = { ...expectedReadinessRow() };
    expect(await runtime.services()).toBeNull();
    time.advance(RETRY_AFTER_MS);
    const ready = await runtime.services();
    expect(ready).not.toBeNull();
    expect(pool.probes()).toBe(3);

    // Trusted for sixty seconds: no statement is sent by asking again.
    const sentWhenReady = pool.calls.length;
    time.advance(READY_FOR_MS - 1);
    expect(await runtime.services()).toBe(ready);
    expect(pool.calls).toHaveLength(sentWhenReady);
    // Then checked again, once. A check that fails takes the services away.
    time.advance(1);
    pool.probeRow = { ...expectedReadinessRow(), database_elevated: true };
    expect(await runtime.services()).toBeNull();
    expect(pool.probes()).toBe(4);

    expect(created).toBe(1);
    expect(pool.endCalls).toBe(0);
    expect(RETRY_AFTER_MS).toBe(5_000);
    expect(READY_FOR_MS).toBe(60_000);
  });

  it("A24: a probe that throws, and every failing row, is 'not available': no services, and nothing but the probe was sent", async () => {
    const throwing = new ProbePool();
    throwing.probeGate = Promise.reject(new Error("permission denied for schema shopaccess_api"));
    throwing.probeGate.catch(() => undefined);
    expect(await createPgRuntime(ENV, { createPool: () => throwing }).services()).toBeNull();
    expect(throwing.calls).toEqual(["readinessProbe"]);

    for (const [column, value] of Object.entries({ session_user_name: "postgres", plain_role_rows: 0, membership_rows: 2, required_functions_executable: 0, prohibited_tables_reachable: 3, schemas_usable: 1 })) {
      const pool = new ProbePool();
      pool.probeRow = { ...expectedReadinessRow(), [column]: value };
      expect(await createPgRuntime(ENV, { createPool: () => pool }).services(), column).toBeNull();
      expect(pool.calls, column).toEqual(["readinessProbe"]);
    }
  });

  it("a configuration error is permanent for the process: no pool is ever created and nothing is sent", async () => {
    for (const missing of ["SHOPACCESS_DATABASE_URL", "SHOPACCESS_SESSION_KEYS", "SHOPACCESS_NONCE_KEYS", "SHOPACCESS_TRUSTED_ORIGINS", "PAYMENT_PROVIDER_MODE"]) {
      let created = 0;
      const runtime = createPgRuntime({ ...ENV, [missing]: undefined }, {
        createPool: () => {
          created += 1;
          return new ProbePool();
        },
      });
      expect(await runtime.services(), missing).toBeNull();
      expect(await runtime.services(), missing).toBeNull();
      expect(created, missing).toBe(0);
    }
  });
});

describe("PostgreSQL runtime: disposal is terminal and the pool is ended exactly once (A51, A52, A53)", () => {
  it("A51: disposal while construction is pending: at most one pool, ended once, never ready, and nothing sent afterwards", async () => {
    const pool = new ProbePool();
    const gate = deferred<PgPool>();
    let created = 0;
    const runtime = createPgRuntime(ENV, {
      createPool: () => {
        created += 1;
        return gate.promise;
      },
    });
    const pending = runtime.services();
    expect(created).toBe(1);
    const disposing = runtime.dispose();
    gate.resolve(pool);

    expect(await pending).toBeNull();
    await disposing;
    expect(created).toBe(1);
    expect(pool.endCalls).toBe(1);
    expect(pool.calls).toEqual([]);
    expect(await runtime.services()).toBeNull();
    expect(pool.calls).toEqual([]);
    expect(created).toBe(1);
  });

  it("A52: disposal while a probe is pending: a probe that then succeeds publishes no readiness, and the pool is ended once", async () => {
    const pool = new ProbePool();
    const gate = deferred<void>();
    pool.probeGate = gate.promise;
    const runtime = createPgRuntime(ENV, { createPool: () => pool });
    const pending = runtime.services();
    await vi.waitFor(() => expect(pool.probes()).toBe(1));

    const disposing = runtime.dispose();
    gate.resolve();
    expect(await pending).toBeNull();
    await disposing;
    expect(pool.endCalls).toBe(1);

    // Terminal: a later request is "not available" and sends nothing.
    const sent = pool.calls.length;
    expect(await runtime.services()).toBeNull();
    expect(pool.calls).toHaveLength(sent);
    expect(pool.probes()).toBe(1);
  });

  it("A53: the cleanup of a failed construction and two overlapping disposals end the pool once in all", async () => {
    const pool = new ProbePool();
    const endGate = deferred<void>();
    pool.endGate = endGate.promise;
    let created = 0;
    const runtime = createPgRuntime(ENV, {
      createPool: () => {
        created += 1;
        return pool;
      },
      buildServices: () => {
        throw new Error("construction failed after the pool was created");
      },
    });
    const pending = runtime.services();
    // The cleanup has started and is waiting for the pool to end.
    await vi.waitFor(() => expect(pool.endCalls).toBe(1));

    const first = runtime.dispose();
    const second = runtime.dispose();
    expect(second).toBe(first);
    endGate.resolve();
    await Promise.all([first, second]);
    expect(await pending).toBeNull();
    expect(pool.endCalls).toBe(1);
    expect(created).toBe(1);
    expect(await runtime.services()).toBeNull();
    expect(pool.calls).toEqual([]);
  });

  it("a failed construction without disposal ends its pool once and is not tried again; a later disposal ends nothing more", async () => {
    const pool = new ProbePool();
    let created = 0;
    const runtime = createPgRuntime(ENV, {
      createPool: () => {
        created += 1;
        return pool;
      },
      buildServices: () => {
        throw new Error("construction failed");
      },
    });
    expect(await runtime.services()).toBeNull();
    expect(await runtime.services()).toBeNull();
    expect(created).toBe(1);
    expect(pool.endCalls).toBe(1);
    await runtime.dispose();
    await runtime.dispose();
    expect(pool.endCalls).toBe(1);
  });

  it("disposal of a ready runtime ends the pool once, and of a runtime that was never used ends nothing", async () => {
    const pool = new ProbePool();
    const runtime = createPgRuntime(ENV, { createPool: () => pool });
    expect(await runtime.services()).not.toBeNull();
    await Promise.all([runtime.dispose(), runtime.dispose(), runtime.dispose()]);
    expect(pool.endCalls).toBe(1);
    expect(await runtime.services()).toBeNull();

    let created = 0;
    const unused = createPgRuntime(ENV, {
      createPool: () => {
        created += 1;
        return new ProbePool();
      },
    });
    await unused.dispose();
    expect(await unused.services()).toBeNull();
    expect(created).toBe(0);
  });
});

describe("catalog read: one joined, uncached statement, assembled and checked as a whole (A26)", () => {
  const byId = <T extends { readonly productId?: string; readonly variantId?: string }>(left: T, right: T): number =>
    String(left.productId ?? left.variantId).localeCompare(String(right.productId ?? right.variantId));
  // The fixture catalog in the order the statement returns its rows: by product id, then by variant id.
  const ordered = {
    ...DEMO_MERCHANT_CATALOG,
    products: [...DEMO_MERCHANT_CATALOG.products].sort(byId).map((product) => ({ ...product, variants: [...product.variants].sort(byId) })),
  };
  const rowsOf = (catalog: typeof ordered): Row[] =>
    catalog.products.flatMap((product) =>
      product.variants.map((variant) => ({
        merchant_id: catalog.merchant.merchantId,
        merchant_display_name: catalog.merchant.displayName,
        merchant_simulated_sandbox: catalog.merchant.simulatedSandbox,
        product_id: product.productId,
        product_title: product.title,
        product_description: product.description,
        product_image_path: product.imagePath,
        product_catalog_revision: catalog.revision,
        variant_id: variant.variantId,
        variant_label: variant.label,
        unit_amount_cents: variant.unitAmountCents,
        currency: variant.currency,
        max_quantity_per_order: variant.maxQuantityPerOrder,
        availability: variant.availability,
        specs: { ...variant.specs },
        variant_catalog_revision: catalog.revision,
      })),
    );

  it("A26: rows of the seeded catalog assemble to the fixture catalog", () => {
    expect(assembleCatalog(rowsOf(ordered))).toEqual({ ok: true, value: ordered });
  });

  it("A26: sends the one statement on every call, with no values, and keeps nothing between calls", async () => {
    const sent: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
    let rows = rowsOf(ordered);
    const db = {
      async query<Result = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Result>> {
        sent.push({ text, values });
        return { rows: rows as Result[] };
      },
    };
    const first = await readCatalog(db);
    // The price changes in the database: the next read shows it, because nothing was kept.
    rows = rowsOf(ordered).map((row, index) => (index === 0 ? { ...row, unit_amount_cents: Number(row.unit_amount_cents) + 100 } : row));
    const second = await readCatalog(db);
    expect(sent).toEqual([
      { text: APPLICATION_STATEMENTS.readCatalog, values: undefined },
      { text: APPLICATION_STATEMENTS.readCatalog, values: undefined },
    ]);
    if (!first.ok || !second.ok) throw new Error("the catalog was refused");
    expect(second.value.products[0].variants[0].unitAmountCents).toBe(first.value.products[0].variants[0].unitAmountCents + 100);
  });

  it("A26: a row set that is not one coherent catalog is refused whole", () => {
    const rows = rowsOf(ordered);
    const change = (index: number, overrides: Row): Row[] => rows.map((row, position) => (position === index ? { ...row, ...overrides } : row));
    const last = rows.length - 1;
    const cases: Array<[string, readonly unknown[], string]> = [
      ["no rows", [], "CATALOG_EMPTY"],
      ["a row that is not an object", [null], "CATALOG_ROW_INVALID"],
      ["an amount as text", change(0, { unit_amount_cents: "79900" }), "CATALOG_ROW_INVALID"],
      ["an amount that is not whole", change(0, { unit_amount_cents: 799.5 }), "CATALOG_ROW_INVALID"],
      ["a missing label", change(0, { variant_label: null }), "CATALOG_ROW_INVALID"],
      ["a second merchant", change(last, { merchant_id: "dmm_another1" }), "CATALOG_MERCHANTS_MIXED"],
      ["a variant at another revision", change(last, { variant_catalog_revision: Number(rows[last].variant_catalog_revision) + 1 }), "CATALOG_REVISIONS_MIXED"],
      ["a product at another revision", change(last, { product_catalog_revision: Number(rows[last].product_catalog_revision) + 1 }), "CATALOG_REVISIONS_MIXED"],
      ["a product whose rows are apart", [...rows, rows[0]], "CATALOG_ORDER_INVALID"],
      ["an amount above the catalog's ceiling", change(0, { unit_amount_cents: 2_000_001 }), "CATALOG_INVALID"],
      ["an amount of zero", change(0, { unit_amount_cents: 0 }), "CATALOG_INVALID"],
      ["specifications with an unknown key", change(0, { specs: { ...(rows[0].specs as Row), extra: true } }), "CATALOG_INVALID"],
      ["an availability that is not known", change(0, { availability: "BACKORDER" }), "CATALOG_INVALID"],
    ];
    for (const [label, input, error] of cases) expect(assembleCatalog(input), label).toEqual({ ok: false, error });
  });
});
