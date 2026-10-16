import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import {
  authorityOf,
  beginExecution,
  decideCreate,
  isLive,
  MAX_LIVE_PERMISSIONS_PER_SESSION,
  release,
  reserve,
  resolveExpiry,
  restorePermissions,
  settleExecution,
} from "@/lib/permissions/model";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { bodyFromState, recoverStateGate, restoreState, type PersistedPermission } from "@/lib/session/snapshot-state";
import type { CommitResult, FoundationStore, PublishedBody } from "@/lib/session/snapshot-store";
import { extensionConversationView } from "@/server/extension-handlers";
import { handleNeedsSession } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// M2-3 slice 1: the F07 permission model, lifecycle rules, persistence and boundaries (docs/m2-3-plan.md §3–4, §8).
const SITE = "https://shop.example.test";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const T0 = new Date("2026-10-16T12:00:00.000Z");
const MIN = 60_000;
const S1 = `ses_${"1".repeat(32)}`;
const S2 = `ses_${"2".repeat(32)}`;
const SELLER = DEMO_MERCHANT_CATALOG.merchant.merchantId;
const ITEM = { merchantId: SELLER, productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai" };
const OTHER = { merchantId: SELLER, productId: "dmp_vivobook16", variantId: "dmv_vivobook16" };
const CI = (n: number) => `ci_${n.toString(16).padStart(32, "0")}`;

let counter = 0;
const context = (patch: Partial<Parameters<typeof decideCreate>[2]> = {}) => ({
  catalog: DEMO_MERCHANT_CATALOG,
  now: T0,
  sessionExpiresAtMs: T0.getTime() + 24 * 60 * MIN,
  admissionExpiresAtMs: null,
  random: () => (++counter).toString(16).padStart(32, "0"),
  ...patch,
});
const input = (patch: Record<string, unknown> = {}) => ({ sessionId: S1, ...ITEM, maxQuantity: 1, maxTotalCents: 90_000, expiry: "1h", ...patch });

function created(existing: readonly PersistedPermission[] = [], patch: Record<string, unknown> = {}, ctx = context()) {
  const decided = decideCreate(existing, input(patch), ctx);
  if (!decided.ok) throw new Error(decided.code);
  return decided;
}

describe("creating a permission", () => {
  it("binds exact seller, product and variant, maximum quantity and total, USD, and a concrete expiry", () => {
    const { permission } = created();
    expect(permission).toMatchObject({ ...ITEM, sessionId: S1, maxQuantity: 1, maxTotalCents: 90_000, currency: "USD", state: "active", checkoutIntentId: null });
    expect(permission.permissionId).toMatch(/^prm_[0-9a-f]{32}$/);
    expect(permission.expiresAt.getTime()).toBe(T0.getTime() + 60 * MIN);
    expect(permission.expiresAt).toBeInstanceOf(Date);
  });

  it("refuses anything outside the catalog or the bounds, without changing the list", () => {
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ merchantId: "dmm_othershop1" }, "NOT_IN_CATALOG"],
      [{ productId: "dmp_notreal123" }, "NOT_IN_CATALOG"],
      [{ variantId: "dmv_vivobook16" }, "NOT_IN_CATALOG"],
      [{ maxQuantity: 0 }, "QUANTITY_INVALID"],
      [{ maxQuantity: 3 }, "QUANTITY_INVALID"],
      [{ maxQuantity: 1.5 }, "QUANTITY_INVALID"],
      [{ maxQuantity: "1" }, "QUANTITY_INVALID"],
      [{ maxTotalCents: 0 }, "TOTAL_INVALID"],
      [{ maxTotalCents: 20_000_001 }, "TOTAL_INVALID"],
      [{ maxTotalCents: Number.MAX_SAFE_INTEGER + 1 }, "TOTAL_INVALID"],
      [{ expiry: "forever" }, "BAD_REQUEST"],
      [{ expiry: "__proto__" }, "BAD_REQUEST"],
      [{ expiry: "toString" }, "BAD_REQUEST"],
      [{ expiry: "constructor" }, "BAD_REQUEST"],
      [{ productId: 7 }, "BAD_REQUEST"],
    ];
    for (const [patch, code] of refusals) {
      const decided = decideCreate([], input(patch), context());
      expect(decided, JSON.stringify(patch)).toEqual({ ok: false, code });
    }
    expect(decideCreate([], input(), context({ sessionExpiresAtMs: null }))).toEqual({ ok: false, code: "SESSION_INVALID" });
    expect(decideCreate([], input(), context({ sessionExpiresAtMs: T0.getTime() }))).toEqual({ ok: false, code: "SESSION_INVALID" });
  });

  it("'until this session ends' is stored as the earliest concrete deadline, and no choice exceeds the session or admission cap", () => {
    const session = T0.getTime() + 5 * 60 * MIN;
    const admission = T0.getTime() + 40 * MIN;
    expect(resolveExpiry("session", T0.getTime(), session, null)).toBe(session);
    expect(resolveExpiry("session", T0.getTime(), session, admission)).toBe(admission);
    expect(resolveExpiry("1h", T0.getTime(), session, admission)).toBe(admission);
    expect(resolveExpiry("15m", T0.getTime(), session, admission)).toBe(T0.getTime() + 15 * MIN);
    expect(resolveExpiry("session", T0.getTime(), T0.getTime() + 48 * 60 * MIN, null)).toBe(T0.getTime() + 24 * 60 * MIN);
    for (const choice of ["15m", "1h", "session"] as const) {
      for (const sessionEnd of [T0.getTime() + 10 * MIN, T0.getTime() + 2 * 60 * MIN, T0.getTime() + 24 * 60 * MIN]) {
        for (const admissionEnd of [null, T0.getTime() + 5 * MIN, T0.getTime() + 90 * MIN]) {
          const { permission } = created([], { expiry: choice }, context({ sessionExpiresAtMs: sessionEnd, admissionExpiresAtMs: admissionEnd }));
          expect(permission.expiresAt.getTime()).toBeLessThanOrEqual(sessionEnd);
          if (admissionEnd !== null) expect(permission.expiresAt.getTime()).toBeLessThanOrEqual(admissionEnd);
          expect(Number.isFinite(permission.expiresAt.getTime())).toBe(true);
        }
      }
    }
  });

  it("allows one live permission per exact seller + product + variant binding; a duplicate is refused, not replaced", () => {
    const first = created();
    const duplicate = decideCreate(first.permissions, input({ maxTotalCents: 120_000 }), context());
    expect(duplicate).toEqual({ ok: false, code: "PERMISSION_DUPLICATE" });
    // A different variant is a different binding; the same binding in another session is independent.
    expect(decideCreate(first.permissions, input(OTHER), context()).ok).toBe(true);
    expect(decideCreate(first.permissions, input({ sessionId: S2 }), context()).ok).toBe(true);
    // A reserved or executing permission still occupies its binding.
    for (const state of ["reserved", "executing"] as const) {
      const busy = first.permissions.map((p) => ({ ...p, state, checkoutIntentId: CI(1) }));
      expect(decideCreate(busy, input(), context())).toEqual({ ok: false, code: "PERMISSION_DUPLICATE" });
    }
    // Once final (consumed, revoked, outcome unknown) or lapsed, the binding is free again.
    for (const state of ["consumed", "revoked", "outcome_unknown"] as const) {
      const done = first.permissions.map((p) => ({ ...p, state, checkoutIntentId: state === "revoked" ? null : CI(1) }));
      expect(decideCreate(done, input(), context()).ok, state).toBe(true);
    }
    const later = decideCreate(first.permissions, input(), context({ now: new Date(T0.getTime() + 61 * MIN) }));
    expect(later.ok).toBe(true);
    if (later.ok) expect(later.permissions.find((p) => p.permissionId === first.permission.permissionId)?.state).toBe("expired");
  });

  it("caps live permissions at five per session", () => {
    // The demo catalog has three variants; a synthetic copy with six gives six distinct bindings.
    const base = DEMO_MERCHANT_CATALOG.products[0];
    const catalog = {
      ...DEMO_MERCHANT_CATALOG,
      products: [1, 2, 3, 4, 5, 6].map((n) => ({
        ...base,
        productId: `dmp_synthetic${n}`,
        variants: base.variants.map((variant) => ({ ...variant, variantId: `dmv_synthetic${n}` })),
      })),
    };
    const bindings = catalog.products.map((product) => ({ merchantId: SELLER, productId: product.productId, variantId: product.variants[0].variantId }));
    expect(bindings).toHaveLength(MAX_LIVE_PERMISSIONS_PER_SESSION + 1);
    let list: PersistedPermission[] = [];
    for (const binding of bindings.slice(0, 5)) list = created(list, binding, context({ catalog })).permissions;
    expect(decideCreate(list, input(bindings[5]), context({ catalog }))).toEqual({ ok: false, code: "PERMISSION_LIMIT" });
    // Another session is not affected; a final permission does not count.
    expect(decideCreate(list, input({ ...bindings[5], sessionId: S2 }), context({ catalog })).ok).toBe(true);
    const oneRevoked = list.map((p, i) => (i === 0 ? { ...p, state: "revoked" as const } : p));
    expect(decideCreate(oneRevoked, input(bindings[5]), context({ catalog })).ok).toBe(true);
  });
});

describe("authority", () => {
  const base = () => created().permission;

  it("only an unexpired active, reserved or executing permission of the same session carries authority", () => {
    const p = base();
    expect(authorityOf(p, S1, T0)).toEqual({ ok: true });
    expect(authorityOf(p, S2, T0)).toEqual({ ok: false, reason: "PERMISSION_WRONG_SESSION" });
    expect(authorityOf(p, S1, p.expiresAt)).toEqual({ ok: false, reason: "PERMISSION_EXPIRED" });
    expect(authorityOf({ ...p, state: "revoked" }, S1, T0)).toEqual({ ok: false, reason: "PERMISSION_REVOKED" });
    expect(authorityOf({ ...p, state: "expired" }, S1, T0)).toEqual({ ok: false, reason: "PERMISSION_EXPIRED" });
    expect(authorityOf({ ...p, state: "consumed", checkoutIntentId: CI(1) }, S1, T0)).toEqual({ ok: false, reason: "PERMISSION_UNAVAILABLE" });
    expect(authorityOf({ ...p, state: "outcome_unknown", checkoutIntentId: CI(1) }, S1, T0)).toEqual({ ok: false, reason: "PERMISSION_UNAVAILABLE" });
    expect(isLive({ ...p, state: "outcome_unknown", checkoutIntentId: CI(1) }, T0)).toBe(false);
  });

  it("is single use: reserved for one checkout, executed once, consumed only by a verified capture", () => {
    const p = base();
    const reserved = reserve(p, S1, CI(1), T0);
    if (!reserved.ok) throw new Error(reserved.reason);
    expect(reserve(reserved.permission, S1, CI(2), T0)).toEqual({ ok: false, reason: "PERMISSION_IN_USE" });
    expect(reserve(reserved.permission, S2, CI(2), T0)).toEqual({ ok: false, reason: "PERMISSION_WRONG_SESSION" });
    expect(beginExecution(reserved.permission, S1, CI(2), T0)).toEqual({ ok: false, reason: "PERMISSION_IN_USE" });
    const executing = beginExecution(reserved.permission, S1, CI(1), T0);
    if (!executing.ok) throw new Error(executing.reason);
    expect(beginExecution(executing.permission, S1, CI(1), T0)).toEqual({ ok: false, reason: "PERMISSION_STATE" });
    expect(release(executing.permission, CI(1), T0)).toEqual({ ok: false, reason: "PERMISSION_STATE" });
    const consumed = settleExecution(executing.permission, CI(1), "captured", T0);
    expect(consumed.ok && consumed.permission.state).toBe("consumed");
    if (consumed.ok) expect(authorityOf(consumed.permission, S1, T0).ok).toBe(false);
    const unknown = settleExecution(executing.permission, CI(1), "unknown", T0);
    expect(unknown.ok && unknown.permission.state).toBe("outcome_unknown");
  });

  it("a reservation is released to active only before execution, and to expired once lapsed", () => {
    const reserved = reserve(base(), S1, CI(1), T0);
    if (!reserved.ok) throw new Error();
    const released = release(reserved.permission, CI(1), T0);
    expect(released.ok && released.permission).toMatchObject({ state: "active", checkoutIntentId: null });
    expect(release(reserved.permission, CI(2), T0).ok).toBe(false);
    const lapsed = release(reserved.permission, CI(1), reserved.permission.expiresAt);
    expect(lapsed.ok && lapsed.permission.state).toBe("expired");
  });
});

describe("restart", () => {
  const p = (state: PersistedPermission["state"], patch: Partial<PersistedPermission> = {}): PersistedPermission => ({
    ...created([], {}, context()).permission,
    state,
    checkoutIntentId: state === "active" || state === "revoked" || state === "expired" ? null : CI(1),
    ...patch,
  });

  it("reserved returns to active, executing becomes outcome unknown, final states stay, lapsed authority becomes expired", () => {
    const now = new Date(T0.getTime() + 10 * MIN);
    const restored = restorePermissions(
      [p("active"), p("reserved"), p("executing"), p("consumed"), p("revoked"), p("expired"), p("outcome_unknown")],
      now,
    ).map((r) => [r.state, r.checkoutIntentId]);
    expect(restored).toEqual([
      ["active", null],
      ["active", null],
      ["outcome_unknown", CI(1)],
      ["consumed", CI(1)],
      ["revoked", null],
      ["expired", null],
      ["outcome_unknown", CI(1)],
    ]);
    const late = new Date(T0.getTime() + 2 * 60 * MIN);
    expect(restorePermissions([p("active"), p("reserved"), p("executing")], late).map((r) => r.state)).toEqual(["expired", "expired", "outcome_unknown"]);
  });

  it("through the saved body: only live sessions keep permissions, and the restored list obeys the rules above", () => {
    const sessionRecord = (id: string) => ({ id, tokenDigest: id.slice(4).padEnd(64, "0"), createdAt: T0, lastSeenAt: T0, absoluteExpiresAt: new Date(T0.getTime() + 24 * 60 * MIN), revokedAt: null });
    const state = {
      sessions: [sessionRecord(S1), { ...sessionRecord(S2), revokedAt: T0 }],
      drafts: new Map(),
      conversations: new Map(),
      selections: new Map(),
      windows: { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 } },
      grants: [],
      permissions: [p("reserved"), p("executing", { productId: OTHER.productId, variantId: OTHER.variantId, permissionId: `prm_${"e".repeat(32)}` }), p("active", { sessionId: S2, permissionId: `prm_${"f".repeat(32)}` })],
    };
    const body = bodyFromState(state);
    expect(body.permissions).toHaveLength(3);
    const restored = restoreState(body, new Date(T0.getTime() + MIN)).state.permissions;
    expect(restored.map((r) => [r.sessionId, r.state])).toEqual([
      [S1, "active"],
      [S1, "outcome_unknown"],
    ]);
  });
});

// Runtime-level: the permission authority on the save-first gate, logout, and the extension boundary.
const EMPTY: PublishedBody = { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [], conversations: [], selections: [], grants: [], permissions: [] };

async function snapshotRuntime() {
  let published = structuredClone(EMPTY);
  const store: FoundationStore = {
    readPublished: () => ({ status: "ready", value: { format: 4, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } }),
    async commit(body: unknown): Promise<CommitResult> {
      published = structuredClone(body) as PublishedBody;
      return { status: "ready", value: { format: 4, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } };
    },
  };
  const time = createTestClock("2026-10-16T12:00:00.000Z");
  const boot = async () => {
    const opened = await recoverStateGate(store, time.clock());
    if (opened.status !== "ready") throw new Error("recovery");
    return createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins: new Set([EXT]) }, { clock: time.clock, gate: opened.gate });
  };
  return { boot, time, published: () => published };
}

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id };
}

const create = (runtime: Runtime, sessionId: string, binding = ITEM, expiry = "1h") =>
  runtime.permissions.create({ sessionId, ...binding, maxQuantity: 1, maxTotalCents: 90_000, expiry, admissionExpiresAtMs: null }, runtime.clock());

describe("permission authority on the save-first gate", () => {
  it("a created permission is saved before it is reported and survives a restart; sessions cannot see or revoke each other's", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const a = await shopper(runtime);
    const b = await shopper(runtime);
    const made = await create(runtime, a.sessionId);
    if (!made.ok) throw new Error(made.code);
    expect(world.published().permissions.map((p) => p.permissionId)).toEqual([made.value.permissionId]);
    expect(runtime.permissions.list(b.sessionId, runtime.clock())).toEqual([]);
    expect(await runtime.permissions.revoke(b.sessionId, made.value.permissionId, runtime.clock())).toBe("unknown");
    expect(world.published().permissions[0].state).toBe("active");

    world.time.advance(MIN);
    const after = await world.boot();
    expect(after.permissions.list(a.sessionId, after.clock()).map((v) => [v.permissionId, v.state, v.live])).toEqual([[made.value.permissionId, "active", true]]);
    expect(await after.permissions.revoke(a.sessionId, made.value.permissionId, after.clock())).toBe("revoked");
    expect(world.published().permissions[0].state).toBe("revoked");
    expect(after.permissions.list(a.sessionId, after.clock())[0].live).toBe(false);
  });

  it("logout revokes the session's active and reserved permissions in the same saved decision; executing is kept", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const a = await shopper(runtime);
    const other = await shopper(runtime);
    const one = await create(runtime, a.sessionId);
    const two = await create(runtime, a.sessionId, OTHER);
    const theirs = await create(runtime, other.sessionId);
    if (!one.ok || !two.ok || !theirs.ok) throw new Error();
    // Mark the second as executing directly on the gate, as slice 2's capture path will.
    await runtime.durable.decidePermissions((list) => ({ value: null, permissions: list.map((p) => (p.permissionId === two.value.permissionId ? { ...p, state: "executing" as const, checkoutIntentId: CI(9) } : p)) }));
    await runtime.sessions.revoke(a.sessionId);
    const states = Object.fromEntries(world.published().permissions.map((p) => [p.permissionId, p.state]));
    expect(states).toEqual({ [one.value.permissionId]: "revoked", [two.value.permissionId]: "executing", [theirs.value.permissionId]: "active" });
    expect(world.published().sessions.find((s) => s.id === a.sessionId)?.revokedAt).not.toBeNull();
  });

  it("refuses creation for a session that is not live", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const a = await shopper(runtime);
    await runtime.sessions.revoke(a.sessionId);
    expect(await create(runtime, a.sessionId)).toEqual({ ok: false, code: "SESSION_INVALID" });
    expect(world.published().permissions).toEqual([]);
  });
});

describe("extension boundary", () => {
  it("no extension grant reaches purchase permissions: no scope, no route, no data", async () => {
    const world = await snapshotRuntime();
    const runtime = await world.boot();
    const a = await shopper(runtime);
    const made = await create(runtime, a.sessionId);
    if (!made.ok) throw new Error();
    // The extension's read model carries no permission data.
    expect(JSON.stringify(extensionConversationView(runtime, a.sessionId))).not.toMatch(/prm_|permission/i);
    // A grant can only ever be resolved for its conversation scopes.
    expect(runtime.pairing.resolve("0".repeat(64), "purchase:execute" as never, EXT, runtime.clock())).toEqual({ ok: false, code: "TOKEN_INVALID" });
    // No extension route or handler refers to the permission authority.
    const root = join(__dirname, "..", "..");
    const files = ["src/server/extension-handlers.ts", "src/server/extension-guard.ts", "src/app/api/extension/v1/conversation/route.ts", "src/app/api/extension/v1/conversation/turns/route.ts", "src/app/api/extension/v1/pairings/route.ts", "src/app/api/extension/v1/pairings/[pairingId]/status/route.ts", "src/app/api/extension/v1/pairings/[pairingId]/exchange/route.ts"];
    for (const file of files) expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(/\.permissions\b|lib\/permissions/);
    // Grant scopes on disk are conversation-only; a purchase scope is refused when the snapshot is read (see grants validation).
    expect(readFileSync(join(root, "src/lib/session/snapshot-store.ts"), "utf8")).toMatch(/const GRANT_SCOPES = new Set\(\["conversation:read", "conversation:write"\]\);/);
  });
});
