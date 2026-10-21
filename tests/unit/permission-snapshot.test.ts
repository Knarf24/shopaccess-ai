import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/lib/shared/canonical-json";
import { openFoundationStore } from "../../src/lib/session/snapshot-store";

// M2-3 slice 1: snapshot format 4 (F07 purchase permissions). Real files in private temporary directories, as in
// snapshot-store.test.ts. A refused file is never served: the store opens unavailable (fail closed).
const KEY = Buffer.from("permission-fixture-key");
const CREATED = "2026-10-16T12:00:00.000Z";
const LATER = "2026-10-16T12:30:00.000Z";
const ENDS = "2026-10-16T13:00:00.000Z";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const session = (n: number) => ({
  id: `ses_${n.toString(16).padStart(32, "0")}`,
  tokenDigest: (n + 8).toString(16).padStart(64, "0"),
  createdAt: CREATED,
  lastSeenAt: CREATED,
  absoluteExpiresAt: "2026-10-17T12:00:00.000Z",
  revokedAt: null,
});
const S1 = session(1).id;
const S2 = session(2).id;

function permission(n: number, patch: Record<string, unknown> = {}) {
  return {
    permissionId: `prm_${n.toString(16).padStart(32, "0")}`,
    sessionId: S1,
    merchantId: "dmm_shopaccessdemo",
    productId: "dmp_aspire14ai",
    variantId: "dmv_aspire14ai",
    maxQuantity: 1,
    maxTotalCents: 60_000,
    currency: "USD",
    createdAt: CREATED,
    expiresAt: ENDS,
    state: "active",
    checkoutIntentId: null,
    changedAt: CREATED,
    ...patch,
  };
}

function body(permissions: unknown[] | undefined, extra: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    allocation: { windowStartedAt: null, count: 0 },
    admissionLogin: { windowStartedAt: null, count: 0 },
    sessions: [session(1), session(2)],
    drafts: [],
    conversations: [],
    selections: [],
    grants: [],
    ...extra,
  };
  if (permissions !== undefined) base.permissions = permissions;
  return base;
}

const identityFor = (key: Buffer) => createHash("sha256").update(Buffer.concat([Buffer.from("shopaccess.mock-store.v1"), Buffer.from([0]), key])).digest("hex");
const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const file = (format: number, value: unknown) => Buffer.from(JSON.stringify({ format, identity: identityFor(KEY), sha256: checksum(value), body: value }));

async function open(bytes: Buffer) {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-perm-"));
  fs.chmodSync(directory, 0o700);
  directories.push(directory);
  fs.writeFileSync(join(directory, "store.json"), bytes, { mode: 0o600 });
  fs.chmodSync(join(directory, "store.json"), 0o600);
  return { directory, opened: await openFoundationStore(directory, KEY) };
}

function without(value: Record<string, unknown>, key: string) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

const ch = (n: number) => `ci_${n.toString(16).padStart(32, "0")}`;

describe("snapshot format 4: purchase permissions", () => {
  it("a format-3 file upgrades deterministically: served with an empty permission list, unchanged on disk, written back as format 4", async () => {
    const bytes = file(3, body(undefined));
    const first = await open(bytes);
    const second = await open(bytes);
    for (const { opened } of [first, second]) {
      expect(opened.status).toBe("ready");
      if (opened.status !== "ready") return;
      const read = opened.value.readPublished();
      expect(read.status === "ready" && read.value.format).toBe(3);
      expect(read.status === "ready" && canonicalJson(read.value.body)).toBe(canonicalJson({ ...body(undefined), permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] }));
    }
    expect(fs.readFileSync(join(first.directory, "store.json")).equals(bytes)).toBe(true);
    if (first.opened.status !== "ready") return;
    const read = first.opened.value.readPublished();
    if (read.status !== "ready") return;
    const committed = await first.opened.value.commit(read.value.body);
    expect(committed.status).toBe("ready");
    expect(JSON.parse(fs.readFileSync(join(first.directory, "store.json"), "utf8")).format).toBe(7);
  });

  it("a format-4 file with permissions in every state is accepted exactly as written", async () => {
    const permissions = [
      permission(1),
      permission(2, { productId: "dmp_pixelbook9x", variantId: "dmv_pixelbook9x", state: "reserved", checkoutIntentId: ch(1), changedAt: LATER }),
      permission(3, { productId: "dmp_zenbook14z", variantId: "dmv_zenbook14z", state: "executing", checkoutIntentId: ch(2), changedAt: LATER }),
      permission(4, { state: "consumed", checkoutIntentId: ch(3), changedAt: LATER }),
      permission(5, { state: "revoked", changedAt: LATER }),
      permission(6, { state: "expired", changedAt: ENDS }),
      permission(7, { state: "outcome_unknown", checkoutIntentId: ch(4), changedAt: LATER }),
      permission(8, { sessionId: S2 }),
      // Review finding 4: a revoked or expired permission may keep the checkout that held it when it ended.
      permission(9, { state: "revoked", checkoutIntentId: ch(5), changedAt: LATER }),
      permission(10, { state: "expired", checkoutIntentId: ch(6), changedAt: ENDS }),
    ];
    const { opened } = await open(file(4, body(permissions)));
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    const read = opened.value.readPublished();
    expect(read.status === "ready" && canonicalJson(read.value.body.permissions)).toBe(canonicalJson(permissions));
  });

  it("refuses corrupted or over-limit permission data instead of serving it", async () => {
    const live = (n: number) => permission(n, { productId: `dmp_product${n}x`, variantId: `dmv_variant${n}x` });
    const cases: Array<[string, unknown[] | undefined, Record<string, unknown>?]> = [
      ["missing permissions key in format 4", undefined],
      ["permissions not an array", {} as unknown as unknown[]],
      ["bad permission id", [permission(1, { permissionId: "prm_xyz" })]],
      ["duplicate permission id", [permission(1), permission(1, { productId: "dmp_pixelbook9x", variantId: "dmv_pixelbook9x" })]],
      ["unknown session", [permission(1, { sessionId: `ses_${"f".repeat(32)}` })]],
      ["bad seller", [permission(1, { merchantId: "shop" })]],
      ["bad product", [permission(1, { productId: "laptop" })]],
      ["quantity zero", [permission(1, { maxQuantity: 0 })]],
      ["quantity above cap", [permission(1, { maxQuantity: 11 })]],
      ["total zero", [permission(1, { maxTotalCents: 0 })]],
      ["total not an integer", [permission(1, { maxTotalCents: 10.5 })]],
      ["total above cap", [permission(1, { maxTotalCents: 20_000_001 })]],
      ["currency EUR", [permission(1, { currency: "EUR" })]],
      ["unknown state", [permission(1, { state: "approved" })]],
      ["expiry not after creation", [permission(1, { expiresAt: CREATED })]],
      ["lifetime above 24 hours", [permission(1, { expiresAt: "2026-10-17T12:00:00.001Z" })]],
      ["changed before created", [permission(1, { changedAt: "2026-10-16T11:59:59.999Z" })]],
      ["reserved without a checkout", [permission(1, { state: "reserved" })]],
      ["executing without a checkout", [permission(1, { state: "executing" })]],
      ["active holding a checkout", [permission(1, { checkoutIntentId: ch(1) })]],
      ["bad checkout id", [permission(1, { state: "reserved", checkoutIntentId: "ci_1" })]],
      ["revoked with a bad checkout id", [permission(1, { state: "revoked", checkoutIntentId: "ci_1", changedAt: LATER })]],
      ["expired with a non-string checkout id", [permission(1, { state: "expired", checkoutIntentId: 7, changedAt: ENDS })]],
      ["extra key", [{ ...permission(1), scopes: ["purchase"] }]],
      ["missing key", [without(permission(1), "changedAt")]],
      ["two live permissions for one exact binding", [permission(1), permission(2, { state: "reserved", checkoutIntentId: ch(1) })]],
      ["six live permissions in one session", [1, 2, 3, 4, 5, 6].map(live)],
    ];
    for (const [name, permissions] of cases) {
      const { opened } = await open(file(4, body(permissions)));
      expect(opened.status, name).toBe("unavailable");
    }
  });

  it("allows a new live permission for a binding whose earlier one is final, and the same binding in another session", async () => {
    const permissions = [
      permission(1, { state: "consumed", checkoutIntentId: ch(1), changedAt: LATER }),
      permission(2, { state: "revoked", changedAt: LATER }),
      permission(3, { state: "expired", changedAt: ENDS }),
      permission(4, { state: "outcome_unknown", checkoutIntentId: ch(2), changedAt: LATER }),
      permission(5),
      permission(6, { sessionId: S2 }),
    ];
    const { opened } = await open(file(4, body(permissions)));
    expect(opened.status).toBe("ready");
  });

  it("five live permissions in one session are accepted", async () => {
    const permissions = [1, 2, 3, 4, 5].map((n) => permission(n, { productId: `dmp_product${n}x`, variantId: `dmv_variant${n}x` }));
    const { opened } = await open(file(4, body(permissions)));
    expect(opened.status).toBe("ready");
  });
});

