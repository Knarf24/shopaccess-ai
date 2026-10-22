import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PermissionRefusal } from "@/components/PermissionRefusal";
import { PurchasePermissions, type ShownPermission } from "@/components/PurchasePermissions";
import { startCheckoutWithQuote } from "@/lib/checkout/service";
import { confirmPurchaseSummary, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { PERMISSION_FORM_CODES, PERMISSION_REFUSAL_CODES, permissionCopy, type PermissionRefusalCode } from "@/lib/i18n/permission-copy";
import { sandboxCorrelationId } from "@/lib/payment/adapter-config";
import { dispatchCapture, dispatchOrderCreate, recordBuyerReturn, verifyApproval } from "@/lib/payment/orchestrator";
import { centsToPaypalAmount, type PaypalTransport } from "@/lib/providers/paypal-sandbox";
import type { PurchaseRefusal } from "@/lib/permissions/gate";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import type { CommitResult, FoundationStore, PublishedBody } from "@/lib/session/snapshot-store";
import { ADMISSION_COOKIE_NAME, ADMISSION_LABEL, ADMISSION_LIFETIME_MS, issuePurposeCookie, type DemoAdmission } from "@/server/demo-admission";
import {
  handleNeedsSession,
  handlePermissionCreate,
  handlePermissionRevoke,
  handleSandboxApprove,
  handleSandboxCapture,
  handleSandboxReturn,
  handleSimulate,
} from "@/server/handlers";
import { parsePermissionForm } from "@/server/permission-form";
import { pgPermissionsUnavailable } from "@/server/respond";
import { createRuntime, type Runtime } from "@/server/runtime";
import { buildCheckoutView } from "@/server/views";
import { createTestClock, MINUTE, TEST_SESSION_KEY } from "./helpers";

// M2-3 slice 3: the purchase-permissions page, its routes, and the shopper-facing refusal and uncertainty wording.
const SITE = "https://shop.example.test";
const SANDBOX_PAYEE = "2ABCDEFGHJKLM";
const SANDBOX_ORDER = "5O190127TN364715T";
const ITEM = "dmp_aspire14ai:dmv_aspire14ai";
const OTHER_ITEM = "dmp_aspirego15:dmv_aspirego15";
const EMPTY: PublishedBody = { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [], conversations: [], selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] };

function memoryRuntime(admission?: DemoAdmission) {
  const time = createTestClock("2026-10-16T12:00:00.000Z");
  return { time, runtime: createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock, admission }) };
}

async function snapshotRuntime(sandboxTransport?: PaypalTransport) {
  let published = structuredClone(EMPTY);
  let refuseWhen: ((body: PublishedBody) => boolean) | null = null;
  const store: FoundationStore = {
    readPublished: () => ({ status: "ready", value: { format: 4, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } }),
    async commit(body: unknown): Promise<CommitResult> {
      const next = structuredClone(body) as PublishedBody;
      if (refuseWhen?.(next)) return { status: "unavailable", outcome: "definite" };
      published = next;
      return { status: "ready", value: { format: 4, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } };
    },
  };
  const time = createTestClock("2026-10-16T12:00:00.000Z");
  const opened = await recoverStateGate(store, time.clock());
  if (opened.status !== "ready") throw new Error();
  const config = { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) };
  const runtime = sandboxTransport
    ? createRuntime(
        { ...config, payment: { mode: "sandbox", apiBaseUrl: "https://api-m.sandbox.paypal.com", merchantId: SANDBOX_PAYEE, clientId: "synthetic-client", clientSecret: "synthetic-secret" } },
        { clock: time.clock, gate: opened.gate, paymentTransport: sandboxTransport },
      )
    : createRuntime(config, { clock: time.clock, gate: opened.gate });
  return { runtime, time, body: () => published, refuse: (when: ((body: PublishedBody) => boolean) | null) => (refuseWhen = when) };
}

async function shopper(runtime: Runtime, extraCookie = "") {
  const response = await handleNeedsSession(new Request(`${SITE}/session/needs`, extraCookie ? { headers: { cookie: extraCookie } } : {}), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { cookie: [`${SESSION_COOKIE_NAME}=${token}`, extraCookie].filter(Boolean).join("; "), sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

type Buyer = Awaited<ReturnType<typeof shopper>>;
const post = (path: string, fields: Record<string, string>, buyer: Pick<Buyer, "cookie">, headers: Record<string, string> = {}) =>
  new Request(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie, ...headers }, body: new URLSearchParams(fields).toString() });
const create = (runtime: Runtime, buyer: Buyer, fields: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  handlePermissionCreate(post("/shop/permissions/create", { csrfToken: buyer.csrfToken, lang: "en", item: ITEM, quantity: "1", total: "900", expiry: "1h", ...fields }, buyer, headers), runtime);
const revoke = (runtime: Runtime, buyer: Buyer, permissionId: string, lang = "en") =>
  handlePermissionRevoke(post("/shop/permissions/revoke", { csrfToken: buyer.csrfToken, lang, permissionId }, buyer), runtime);
const location = (response: Response) => new URL(response.headers.get("location") ?? "/", SITE);
const listOf = (runtime: Runtime, buyer: Buyer) => runtime.permissions.list(buyer.sessionId, runtime.clock());

describe("create route", () => {
  it("creates exactly the reviewed authorization, saved before the redirect reports it", async () => {
    const world = await snapshotRuntime();
    const buyer = await shopper(world.runtime);
    const response = await create(world.runtime, buyer, { total: "879.99" });
    expect(response.status).toBe(303);
    const back = location(response);
    expect(back.pathname).toBe("/en/shop/permissions");
    expect(back.hash).toBe("");
    const [made] = listOf(world.runtime, buyer);
    // Browser finding (slice 3): no permission identifier in the address bar or on the page.
    expect(back.searchParams.get("result")).toBe("created");
    expect(back.toString()).not.toContain(made.label);
    expect(back.toString()).not.toContain(made.permissionId);
    expect(made).toMatchObject({ merchantId: world.runtime.catalog.merchant.merchantId, productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", maxQuantity: 1, maxTotalCents: 87_999, state: "active" });
    expect(world.body().permissions.map((p) => p.permissionId)).toEqual([made.permissionId]);
  });

  it("every expiry choice stores a concrete end within the session", async () => {
    const { runtime } = memoryRuntime();
    const ends: Record<string, number> = {};
    for (const [expiry, item] of [["15m", ITEM], ["1h", OTHER_ITEM], ["session", "dmp_vivobook16:dmv_vivobook16"]] as const) {
      const buyer = await shopper(runtime);
      await create(runtime, buyer, { expiry, item });
      ends[expiry] = listOf(runtime, buyer)[0].expiresAt.getTime() - runtime.clock().getTime();
    }
    expect(ends).toEqual({ "15m": 15 * MINUTE, "1h": 60 * MINUTE, session: 24 * 60 * MINUTE });
  });

  it("refuses an item, quantity, total or expiry outside the catalog and limits, creating nothing", async () => {
    const { runtime, time } = memoryRuntime();
    const buyer = await shopper(runtime);
    const cases: Array<[Record<string, string>, string]> = [
      [{ item: "dmp_notreal123:dmv_notreal123" }, "ITEM_INVALID"],
      [{ item: "dmp_aspire14ai:dmv_aspirego15" }, "ITEM_INVALID"],
      [{ item: "dmm_shopaccessdemo:dmp_aspire14ai" }, "ITEM_INVALID"],
      [{ quantity: "0" }, "QUANTITY_INVALID"],
      [{ quantity: "3" }, "QUANTITY_INVALID"],
      [{ quantity: "1.5" }, "QUANTITY_INVALID"],
      [{ total: "0" }, "TOTAL_INVALID"],
      [{ total: "-5" }, "TOTAL_INVALID"],
      [{ total: "12.345" }, "TOTAL_INVALID"],
      [{ total: "abc" }, "TOTAL_INVALID"],
      [{ total: "200000.01" }, "TOTAL_INVALID"],
      [{ expiry: "forever" }, "EXPIRY_INVALID"],
      [{ expiry: "__proto__" }, "EXPIRY_INVALID"],
    ];
    for (const [fields, code] of cases) {
      time.advance(MINUTE); // stay under the per-minute rate limit, which is tested separately
      const back = location(await create(runtime, buyer, fields));
      expect(back.searchParams.get("error"), JSON.stringify(fields)).toBe(code);
    }
    expect(listOf(runtime, buyer)).toEqual([]);
    // The seller is never taken from the form: an extra merchant field is ignored, the catalog's seller is used.
    await create(runtime, buyer, { merchantId: "dmm_attacker01" });
    expect(listOf(runtime, buyer)[0].merchantId).toBe(runtime.catalog.merchant.merchantId);
  });

  it("refuses a duplicate for the same exact binding and a sixth live permission", async () => {
    const { runtime } = memoryRuntime();
    const buyer = await shopper(runtime);
    await create(runtime, buyer);
    expect(location(await create(runtime, buyer, { total: "1000" })).searchParams.get("error")).toBe("PERMISSION_DUPLICATE");
    // The demo catalog has three items; four more live permissions for other bindings are seeded directly.
    await runtime.durable.decidePermissions((list) => ({
      value: null,
      permissions: [
        ...list,
        ...[1, 2, 3, 4].map((n) => ({ ...list[0], permissionId: `prm_${String(n).repeat(32)}`, productId: `dmp_synthetic${n}`, variantId: `dmv_synthetic${n}` })),
      ],
    }));
    expect(location(await create(runtime, buyer, { item: OTHER_ITEM })).searchParams.get("error")).toBe("PERMISSION_LIMIT");
  });

  it("requires the website session, trusted origin, CSRF and admission; an extension credential carries no authority", async () => {
    const { runtime } = memoryRuntime();
    const buyer = await shopper(runtime);
    const refusals = [
      await create(runtime, { ...buyer, csrfToken: "wrong" }),
      await create(runtime, buyer, {}, { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }),
      await create(runtime, { ...buyer, cookie: "" }),
      await handlePermissionCreate(
        new Request(`${SITE}/shop/permissions/create`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: `chrome-extension://${"a".repeat(32)}`, authorization: `Bearer ${"b".repeat(64)}` },
          body: new URLSearchParams({ lang: "en", item: ITEM, quantity: "1", total: "900", expiry: "1h" }).toString(),
        }),
        runtime,
      ),
    ];
    for (const response of refusals) expect(response.status).toBe(403);
    expect(listOf(runtime, buyer)).toEqual([]);

    const key = randomBytes(32);
    const admission: DemoAdmission = { mode: "on", key, passphrase: "a synthetic passphrase for tests", attempts: { windowStartedAt: null, count: 0 } };
    const admitted = memoryRuntime(admission);
    const cookie = `${ADMISSION_COOKIE_NAME}=${issuePurposeCookie(key, admitted.time.clock().getTime(), ADMISSION_LIFETIME_MS, ADMISSION_LABEL).value}`;
    const guest = await shopper(admitted.runtime, cookie);
    const withoutAdmission = await create(admitted.runtime, { ...guest, cookie: guest.cookie.split("; ")[0] });
    expect(withoutAdmission.status).toBe(303);
    expect(location(withoutAdmission).pathname).toBe("/en/demo/admission");
    expect(listOf(admitted.runtime, guest)).toEqual([]);
  });

  it("is rate limited per session like other confirmation-level mutations", async () => {
    const { runtime } = memoryRuntime();
    const buyer = await shopper(runtime);
    for (let i = 0; i < 10; i++) expect((await create(runtime, buyer, { total: "0" })).status).toBe(303);
    expect((await create(runtime, buyer)).status).toBe(429);
    expect(listOf(runtime, buyer)).toEqual([]);
  });
});

describe("revoke route", () => {
  it("revokes active and reserved permissions; a reserved checkout then fails closed", async () => {
    const { runtime } = memoryRuntime();
    const buyer = await shopper(runtime);
    await create(runtime, buyer);
    await create(runtime, buyer, { item: OTHER_ITEM });
    const [first, second] = listOf(runtime, buyer);
    const started = await startCheckoutWithQuote(runtime.checkout, buyer.sessionId, { productId: "dmp_aspirego15", variantId: "dmv_aspirego15", quantity: 1 });
    if (!started.ok) throw new Error(started.error);
    expect(listOf(runtime, buyer).find((p) => p.permissionId === second.permissionId)?.state).toBe("reserved");

    for (const permission of [first, second]) {
      const back = location(await revoke(runtime, buyer, permission.permissionId));
      expect(back.searchParams.get("result")).toBe("revoked");
      expect(back.toString()).not.toContain(permission.label);
    }
    expect(await prepareConfirmation(runtime.checkout, buyer.sessionId, started.value.quote.quoteId)).toEqual({ ok: false, error: "PERMISSION_REVOKED" });
  });

  it("D2: a checkout reloaded after its permission was revoked shows the revoked refusal with its link, not the generic message", async () => {
    const { runtime } = memoryRuntime();
    const buyer = await shopper(runtime);
    await create(runtime, buyer, { item: OTHER_ITEM, total: "1000" });
    const started = await startCheckoutWithQuote(runtime.checkout, buyer.sessionId, { productId: "dmp_aspirego15", variantId: "dmv_aspirego15", quantity: 1 });
    if (!started.ok) throw new Error(started.error);
    const [held] = listOf(runtime, buyer);
    expect(held.state).toBe("reserved");
    await revoke(runtime, buyer, held.permissionId);

    const token = buyer.cookie.split(";")[0].split("=")[1];
    const session = await runtime.sessions.resolve(token);
    if (!session.ok) throw new Error("session");
    const view = await buildCheckoutView(runtime, session.value, started.value.intent.id);
    // Fails closed exactly as before: no confirmation can be offered, and the checkout stays at its quote.
    expect(view?.state).toBe("QUOTED");
    expect(view?.challenge).toBeNull();
    expect(view?.challengeProblem).toBeNull();

    // The view reports it as the current permission refusal, not as a generic problem; only Cancel is offered. The
    // rendered page (alerts, link, skip target, URL codes) is covered in checkout-page-render.test.tsx.
    expect(view?.permissionRefusal).toBe("PERMISSION_REVOKED");
    expect(view?.steps).toEqual(["cancel"]);
    for (const language of ["en", "es"] as const) {
      const html = renderToStaticMarkup(<PermissionRefusal language={language} code={view!.permissionRefusal!} />);
      expect(html).toContain(permissionCopy(language).refusals.PERMISSION_REVOKED);
      expect(html).toContain(`href="/${language}/shop/permissions">${permissionCopy(language).managePermissions}</a>`);
    }
  });

  it("refuses to revoke a permission completing a payment, or one that is used, revoked, ended or under review", async () => {
    const { runtime, time } = memoryRuntime();
    const buyer = await shopper(runtime);
    await create(runtime, buyer);
    const [permission] = listOf(runtime, buyer);
    const setState = (state: "executing" | "consumed" | "outcome_unknown" | "revoked") =>
      runtime.durable.decidePermissions((list) => ({ value: null, permissions: list.map((p) => ({ ...p, state, checkoutIntentId: state === "revoked" ? null : `ci_${"9".repeat(32)}` })) }));
    await setState("executing");
    expect(location(await revoke(runtime, buyer, permission.permissionId)).searchParams.get("error")).toBe("REVOKE_IN_PROGRESS");
    expect(listOf(runtime, buyer)[0].state).toBe("executing");
    for (const state of ["consumed", "outcome_unknown", "revoked"] as const) {
      await setState(state);
      expect(location(await revoke(runtime, buyer, permission.permissionId)).searchParams.get("error"), state).toBe("REVOKE_NOT_AVAILABLE");
      expect(listOf(runtime, buyer)[0].state).toBe(state);
    }
    const other = await shopper(runtime);
    await create(runtime, other);
    time.advance(61 * MINUTE);
    const [lapsed] = listOf(runtime, other);
    expect(location(await revoke(runtime, other, lapsed.permissionId)).searchParams.get("error")).toBe("REVOKE_NOT_AVAILABLE");
  });

  it("another session's permission cannot be revoked or seen", async () => {
    const { runtime } = memoryRuntime();
    const owner = await shopper(runtime);
    const stranger = await shopper(runtime);
    await create(runtime, owner);
    const [permission] = listOf(runtime, owner);
    expect(listOf(runtime, stranger)).toEqual([]);
    expect(location(await revoke(runtime, stranger, permission.permissionId)).searchParams.get("error")).toBe("REVOKE_NOT_AVAILABLE");
    expect(listOf(runtime, owner)[0].state).toBe("active");
  });
});

describe("PostgreSQL mode", () => {
  it("purchase permissions answer an explicit 503, not a 404", async () => {
    const response = await pgPermissionsUnavailable();
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toBe("Purchase permissions are unavailable in PostgreSQL mode.");
  });
});

const shown = (state: ShownPermission["state"], revocable: boolean, n: number): ShownPermission => ({
  permissionId: `prm_${String(n).repeat(32)}`,
  product: "Acer Aspire 14 AI",
  variant: "16 GB LPDDR5X, 512 GB PCIe NVMe SSD",
  seller: "ShopAccess Demo Store (simulated)",
  maxQuantity: 1,
  maxTotalCents: 90_000,
  expiresAt: new Date("2026-10-16T13:00:00.000Z"),
  state,
  revocable,
});
const choices = [{ value: ITEM, label: "Acer Aspire 14 AI — 16 GB", seller: "ShopAccess Demo Store (simulated)", maxQuantity: 2 }];
const page = (props: Partial<Parameters<typeof PurchasePermissions>[0]> = {}) =>
  renderToStaticMarkup(
    <PurchasePermissions language="en" csrfToken="csrf-test" skipLabel="Skip to the current step" choices={choices} permissions={[]} result={null} review={null} entered={{ item: "", quantity: "", total: "", expiry: "" }} {...props} />,
  );

describe("permissions page", () => {
  it("labels every control, renders in English and Spanish, and never moves focus by itself", () => {
    for (const language of ["en", "es"] as const) {
      const html = page({ language });
      const copy = permissionCopy(language);
      for (const id of ["permission-item", "permission-quantity", "permission-total", "permission-expiry-15m", "permission-expiry-1h", "permission-expiry-session"]) {
        expect(html, id).toContain(`for="${id}"`);
        expect(html, id).toContain(`id="${id}"`);
      }
      expect(html).toContain(`<legend>${copy.expiryLegend}</legend>`);
      expect(html).toContain(copy.pageTitle);
      expect(html).toContain(`lang="${language}"`);
      expect(html).not.toMatch(/autofocus|disabled|tabindex="[1-9]/i);
      // The skip link is the first focusable element and targets the heading when there is nothing newer.
      expect(html.indexOf('class="skip-link"')).toBeLessThan(html.indexOf("<select"));
      expect(html).toContain('href="#permissions-heading"');
    }
    expect(page({ language: "es" })).toContain("Permisos de compra");
  });

  it("shows no permission identifier in visible text or accessible names (browser finding, slice 3)", () => {
    // The browser showed "Permission 95f6ff19 created" and "Revoke permission 95f6ff19". The earlier assertion only
    // looked for the "prm_" prefix, so the bare eight-character label passed. Check the whole identifier space instead.
    const ids = [`prm_${"95f6ff19".padEnd(32, "a")}`, `prm_${"0123abcd".padEnd(32, "b")}`];
    const permissions = ids.map((permissionId, n) => ({ ...shown(n ? "reserved" : "active", true, n + 1), permissionId }));
    for (const language of ["en", "es"] as const) {
      for (const result of [{ kind: "created" } as const, { kind: "revoked" } as const]) {
        const html = page({ language, result, permissions });
        const visible = html.replace(/<[^>]+>/g, " ");
        const accessibleNames = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]).join(" ");
        for (const text of [visible, accessibleNames]) {
          expect(text).not.toMatch(/\b[0-9a-f]{8}\b/);
          expect(text).not.toMatch(/prm_/);
        }
        expect(visible).toContain(result.kind === "created" ? permissionCopy(language).created : permissionCopy(language).revoked);
        // The identifier exists only as the hidden form value the server needs.
        for (const id of ids) expect(html.match(new RegExp(id, "g"))).toEqual([`${id}`]);
      }
    }
  });

  it("links a field error to its field and makes the result the skip target", () => {
    const html = page({ result: { kind: "error", code: "TOTAL_INVALID", field: "total" }, entered: { item: ITEM, quantity: "1", total: "12.345", expiry: "1h" } });
    expect(html).toContain('href="#permission-result"');
    expect(html).toMatch(/id="permission-result" tabindex="-1" role="alert"/);
    expect(html).toMatch(/id="permission-total"[^>]*aria-describedby="permission-total-hint permission-total-error"/);
    expect(html).toMatch(/id="permission-total"[^>]*aria-invalid="true"/);
    expect(html).toContain('id="permission-total-error"');
    expect(html).toContain('value="12.345"');
  });

  it("shows the exact authorization before creation, and creation is a separate CSRF-protected POST", () => {
    const html = page({
      review: { item: ITEM, seller: "ShopAccess Demo Store (simulated)", product: "Acer Aspire 14 AI", variant: "16 GB LPDDR5X", maxQuantity: 2, maxTotalCents: 179_998, total: "1799.98", quantity: "2", expiry: "session", endsAt: new Date("2026-10-17T12:00:00.000Z") },
    });
    for (const text of ["ShopAccess Demo Store (simulated)", "Acer Aspire 14 AI", "16 GB LPDDR5X", "$1799.98", "USD", "2026-10-17 12:00 UTC"]) expect(html, text).toContain(text);
    expect(html).toContain('action="/shop/permissions/create"');
    expect(html).toContain('name="csrfToken" value="csrf-test"');
    expect(html).toMatch(/<form [^>]*action="\/en\/shop\/permissions" method="get">/);
    expect(html).toContain('href="#permission-review-heading"');
  });

  it("offers Revoke only where it is meaningful and explains the other states", () => {
    const html = page({
      permissions: [shown("active", true, 1), shown("reserved", true, 2), shown("executing", false, 3), shown("consumed", false, 4), shown("revoked", false, 5), shown("expired", false, 6), shown("outcome_unknown", false, 7)],
    });
    expect(html.match(/action="\/shop\/permissions\/revoke"/g)).toHaveLength(2);
    // Only the active (0) and reserved (1) entries have a button, each described by its own item name.
    expect(html.match(/<button type="submit" aria-describedby="permission-item-name-(\d)">Revoke permission<\/button>/g)).toEqual([
      '<button type="submit" aria-describedby="permission-item-name-0">Revoke permission</button>',
      '<button type="submit" aria-describedby="permission-item-name-1">Revoke permission</button>',
    ]);
    expect(html).toContain('id="permission-item-name-0"');
    const copy = permissionCopy("en");
    for (const state of ["active", "reserved", "executing", "consumed", "revoked", "expired", "outcome_unknown"] as const) expect(html).toContain(copy.states[state]);
    expect(html).toContain(copy.stateHelp.outcome_unknown!);
    // Visible text carries no identifiers or internal state names (the Revoke form's hidden value is not shown).
    const visible = html.replace(/<[^>]+>/g, " ");
    expect(visible).not.toMatch(/prm_|outcome_unknown|executing\b/);
  });

  // Finding 8 (permissions part): English catalog names on the Spanish page are marked English where the markup allows.
  // A native <option> holds plain text only and mixes the English name with the Spanish seller label, so it is not marked.
  it("Spanish page: English product and variant names in the review and the list are marked English; options stay plain text", () => {
    const review = { item: ITEM, seller: "ShopAccess Demo Store (simulada)", product: "Acer Aspire 14 AI", variant: "16 GB LPDDR5X", maxQuantity: 2, maxTotalCents: 179_998, total: "1799.98", quantity: "2", expiry: "session", endsAt: new Date("2026-10-17T12:00:00.000Z") };
    const spanish = page({ language: "es", review, permissions: [shown("active", true, 1)] });
    expect(spanish).toContain('<dd><span lang="en">Acer Aspire 14 AI</span></dd>');
    expect(spanish).toContain('<dd><span lang="en">16 GB LPDDR5X</span></dd>');
    expect(spanish).toContain('<strong><span lang="en">Acer Aspire 14 AI</span> — <span lang="en">16 GB LPDDR5X, 512 GB PCIe NVMe SSD</span></strong>');
    const options = [...spanish.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)];
    expect(options.length).toBeGreaterThan(0);
    for (const [, attributes, content] of options) {
      expect(content).not.toMatch(/</);
      expect(attributes).not.toMatch(/\slang=/);
    }
    // The English page is unchanged: no per-name markers.
    const english = page({ language: "en", review, permissions: [shown("active", true, 1)] });
    expect(english).not.toContain('<span lang="en">');
    expect(english).toContain("<dd>Acer Aspire 14 AI</dd>");
  });
});

describe("refusal and uncertainty wording", () => {
  it("covers every gate refusal in English and Spanish, with no internal keys, and links to purchase permissions", () => {
    // Compile-time: every code the gate can return has copy.
    const all: Record<PurchaseRefusal, true> = {
      PERMISSION_REQUIRED: true,
      PERMISSION_MISMATCH: true,
      PERMISSION_QUANTITY_EXCEEDED: true,
      PERMISSION_TOTAL_EXCEEDED: true,
      PERMISSION_EXPIRED: true,
      PERMISSION_REVOKED: true,
      PERMISSION_IN_USE: true,
      PERMISSION_UNAVAILABLE: true,
      CONFIRMATION_REQUIRED: true,
    };
    expect(Object.keys(all).sort()).toEqual([...PERMISSION_REFUSAL_CODES].sort());
    for (const language of ["en", "es"] as const) {
      const copy = permissionCopy(language);
      const texts = PERMISSION_REFUSAL_CODES.map((code) => copy.refusals[code as PermissionRefusalCode]);
      expect(new Set(texts).size).toBe(texts.length);
      for (const text of [...texts, ...PERMISSION_FORM_CODES.map((code) => copy.formErrors[code]), copy.captureRecordUnsaved, copy.outcomeUnderReview]) {
        expect(text.length).toBeGreaterThan(20);
        expect(text).not.toMatch(/[A-Z]+_[A-Z]+|prm_|ci_/);
      }
      const html = renderToStaticMarkup(<PermissionRefusal language={language} code="CONFIRMATION_REQUIRED" />).replaceAll("&#x27;", "'");
      expect(html).toContain(copy.refusals.CONFIRMATION_REQUIRED);
      expect(html).toContain(`href="/${language}/shop/permissions"`);
      const review = renderToStaticMarkup(<PermissionRefusal language={language} code="PERMISSION_UNAVAILABLE" underReview />);
      expect(review).toContain(copy.outcomeUnderReview);
      expect(review).not.toContain("/shop/permissions");
    }
    expect(permissionCopy("es").refusals.PERMISSION_TOTAL_EXCEEDED).toContain("total");
  });

  it("never tells the shopper a possibly-made payment failed or to try again", () => {
    for (const language of ["en", "es"] as const) {
      const { captureRecordUnsaved, outcomeUnderReview } = permissionCopy(language);
      for (const text of [captureRecordUnsaved, outcomeUnderReview]) {
        expect(text).not.toMatch(/fail|try again|inténtelo|falló/i);
        expect(text).toMatch(language === "en" ? /Do not pay again/ : /No vuelva a pagar/);
      }
    }
  });
});

describe("a capture that went through but could not be recorded", () => {
  async function capturedButUnsaved(lang: "en" | "es") {
    const world = await snapshotRuntime();
    const { runtime } = world;
    const buyer = await shopper(runtime);
    await create(runtime, buyer);
    const started = await startCheckoutWithQuote(runtime.checkout, buyer.sessionId, { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: 1 }, lang);
    if (!started.ok) throw new Error(started.error);
    const challenge = await prepareConfirmation(runtime.checkout, buyer.sessionId, started.value.quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
    await confirmPurchaseSummary(runtime.checkout, buyer.sessionId, { confirmationId, nonce, quoteId, quoteDigest });
    const intentId = started.value.intent.id;
    await dispatchOrderCreate(runtime.payment, intentId);
    runtime.provider.simulateBuyerApproval((await runtime.store.findIntent(intentId))!.snapshot.context.providerOrderId!);
    await recordBuyerReturn(runtime.payment, buyer.sessionId, intentId);
    await verifyApproval(runtime.payment, intentId);
    // Every save that would record the capture result is refused.
    world.refuse((body) => body.permissions.some((p) => p.state === "consumed"));
    const response = await handleSimulate(post(`/checkout/${intentId}/simulate`, { step: "capture", csrfToken: buyer.csrfToken }, buyer), runtime, intentId);
    return { world, runtime, response, intentId, resubmit: buyer };
  }

  it("answers 503 with 'may already have gone through, do not pay again' in the checkout's language, and stays fail-closed", async () => {
    for (const lang of ["en", "es"] as const) {
      const { world, runtime, response, intentId, resubmit } = await capturedButUnsaved(lang);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      // A full page for the form post, not raw JSON: language, title, heading, the message as an alert.
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html).toMatch(new RegExp(`^<!doctype html><html lang="${lang}">`));
      expect(html).toMatch(/<title>[^<]+<\/title>/);
      expect(html).toMatch(/<h1\b[^>]*>[^<]+<\/h1>/);
      expect(html).toContain(`<p role="alert">${permissionCopy(lang).captureRecordUnsaved}</p>`);
      // The non-sensitive reference, on the page and in the audit record, so the two can be matched.
      const reference = html.match(/<code>([^<]+)<\/code>/)?.[1];
      expect(reference).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(runtime.audit.list().find((event) => event.checkoutIntentId === intentId)?.detail.requestId).toBe(reference);
      // Nothing on it can pay, retry or resubmit: no form, no button, no script, and no link back into the checkout.
      expect(html).not.toMatch(/<form|<button|<script|\/checkout\//);
      // Audited (the audit log is separate from the blocked state store), without the session token or CSRF value.
      const events = runtime.audit.list().filter((event) => event.checkoutIntentId === intentId);
      expect(events.map((event) => [event.eventType, event.detail.step ?? null, event.detail.result])).toEqual([["SIMULATION_STEP", "capture", "CAPTURE_RECORD_UNSAVED"]]);
      expect(runtime.provider.captureCount()).toBe(1);
      // The saved permission stays executing (it becomes outcome unknown on restart); the store is blocked.
      expect(world.body().permissions.map((p) => p.state)).toEqual(["executing"]);
      expect(runtime.durable.available()).toBe(false);
      // Resubmitting the same capture form (a reload or a second click) sends nothing more to the provider.
      const again = await handleSimulate(post(`/checkout/${intentId}/simulate`, { step: "capture", csrfToken: resubmit.csrfToken }, resubmit), runtime, intentId).then(
        (answer) => answer.status,
        (thrown: unknown) => (thrown as Error).name,
      );
      // The blocked store refuses it before anything runs (the route wrapper answers 503 "unavailable").
      expect(again).toBe("PersistenceUnavailableError");
      expect(runtime.provider.captureCount()).toBe(1);
    }
  });

  it("a save failure before any capture keeps the generic answer: nothing was charged", async () => {
    const world = await snapshotRuntime();
    const { runtime } = world;
    const buyer = await shopper(runtime);
    await create(runtime, buyer);
    const started = await startCheckoutWithQuote(runtime.checkout, buyer.sessionId, { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: 1 });
    if (!started.ok) throw new Error(started.error);
    const challenge = await prepareConfirmation(runtime.checkout, buyer.sessionId, started.value.quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
    await confirmPurchaseSummary(runtime.checkout, buyer.sessionId, { confirmationId, nonce, quoteId, quoteDigest });
    const intentId = started.value.intent.id;
    await dispatchOrderCreate(runtime.payment, intentId);
    runtime.provider.simulateBuyerApproval((await runtime.store.findIntent(intentId))!.snapshot.context.providerOrderId!);
    await recordBuyerReturn(runtime.payment, buyer.sessionId, intentId);
    await verifyApproval(runtime.payment, intentId);
    world.refuse((body) => body.permissions.some((p) => p.state === "executing"));
    await expect(dispatchCapture(runtime.payment, intentId)).rejects.toThrow(/could not be saved/);
    expect(runtime.provider.captureCount()).toBe(0);
  });
});

describe("sandbox capture that went through but could not be recorded (second review finding 3)", () => {
  /** In-memory runtime on a refusing snapshot store, with a mocked PayPal transport: synthetic replies, no PayPal call. */
  async function sandboxCapturedButUnsaved(lang: "en" | "es", auditFails = false) {
    const replies: Array<{ status: number; body: string }> = [];
    const sent: string[] = [];
    const transport: PaypalTransport = async (request) => {
      if (request.url.endsWith("/token")) return { status: 200, body: JSON.stringify({ access_token: "synthetic-token", expires_in: 3200 }) };
      sent.push(request.url);
      const next = replies.shift();
      if (!next) throw new Error(`unexpected PayPal call ${request.url}`);
      return next;
    };
    const world = await snapshotRuntime(transport);
    const { runtime } = world;
    const buyer = await shopper(runtime);
    await create(runtime, buyer);
    const started = await startCheckoutWithQuote(runtime.checkout, buyer.sessionId, { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: 1 }, lang);
    if (!started.ok) throw new Error(started.error);
    const { quote, intent } = started.value;
    const challenge = await prepareConfirmation(runtime.checkout, buyer.sessionId, quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const { confirmationId, nonce, quoteDigest } = challenge.value;
    await confirmPurchaseSummary(runtime.checkout, buyer.sessionId, { confirmationId, nonce, quoteId: quote.quoteId, quoteDigest });
    const order = (status: string) =>
      JSON.stringify({
        id: SANDBOX_ORDER,
        status,
        purchase_units: [{ custom_id: sandboxCorrelationId(quote.quoteId), payee: { merchant_id: SANDBOX_PAYEE }, amount: { currency_code: "USD", value: centsToPaypalAmount(quote.totalCents) } }],
        links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${SANDBOX_ORDER}` }],
      });
    replies.push({ status: 201, body: order("CREATED") });
    await handleSandboxApprove(post(`/checkout/${intent.id}/approve`, { csrfToken: buyer.csrfToken }, buyer), runtime, intent.id);
    replies.push({ status: 200, body: order("APPROVED") });
    await handleSandboxReturn(new Request(`${SITE}/checkout/${intent.id}/return?token=${SANDBOX_ORDER}`, { headers: { cookie: buyer.cookie } }), runtime, intent.id);
    expect((await runtime.store.findIntent(intent.id))?.snapshot.state).toBe("APPROVED_VERIFIED");

    world.refuse((body) => body.permissions.some((p) => p.state === "consumed"));
    if (auditFails) vi.spyOn(runtime.audit, "append").mockRejectedValue(new Error("synthetic audit failure"));
    replies.push({
      status: 201,
      body: JSON.stringify({
        id: "8AA12345BC678901C",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: centsToPaypalAmount(quote.totalCents) },
        custom_id: sandboxCorrelationId(quote.quoteId),
        payee: { merchant_id: SANDBOX_PAYEE },
        supplementary_data: { related_ids: { order_id: SANDBOX_ORDER } },
      }),
    });
    const response = await handleSandboxCapture(post(`/checkout/${intent.id}/capture`, { csrfToken: buyer.csrfToken }, buyer), runtime, intent.id);
    const captures = () => sent.filter((url) => url.endsWith("/capture")).length;
    return { world, runtime, buyer, intentId: intent.id, response, captures };
  }

  it("answers with the accessible do-not-pay-again page, audits it with the same reference, and sends no second capture", async () => {
    for (const lang of ["en", "es"] as const) {
      const { world, runtime, buyer, intentId, response, captures } = await sandboxCapturedButUnsaved(lang);
      const copy = permissionCopy(lang);
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toMatch(new RegExp(`^<!doctype html><html lang="${lang}">`));
      expect(html).toContain(`<title>${copy.captureRecordUnsavedTitle}</title>`);
      expect(html).toContain(`<h1>${copy.captureRecordUnsavedTitle}</h1>`);
      expect(html).toContain(`<p role="alert">${copy.captureRecordUnsaved}</p>`);
      const reference = html.match(new RegExp(`<p>${copy.referenceLabel}: <code>([^<]+)</code></p>`))?.[1];
      expect(reference).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      // Nothing interactive, and no claim that nothing was charged.
      expect(html).not.toMatch(/<form|<button|<a\b|<script|\/checkout\//);
      expect(html).not.toMatch(/Nothing was charged|Nothing more was charged|No se cobró nada/);
      const events = runtime.audit.list().filter((event) => event.checkoutIntentId === intentId && event.eventType === "SANDBOX_CAPTURE");
      expect(events.map((event) => [event.detail.result, event.detail.requestId])).toEqual([["CAPTURE_RECORD_UNSAVED", reference]]);
      expect(captures()).toBe(1);
      expect(world.body().permissions.map((p) => p.state)).toEqual(["executing"]);
      // A second capture (reload or second click) is refused by the blocked store, with no further adapter call.
      const again = await handleSandboxCapture(post(`/checkout/${intentId}/capture`, { csrfToken: buyer.csrfToken }, buyer), runtime, intentId).then(
        (answer) => answer.status,
        (thrown: unknown) => (thrown as Error).name,
      );
      expect(again).toBe("PersistenceUnavailableError");
      expect(captures()).toBe(1);
    }
  });

  it("an audit failure does not change the page or allow a retry", async () => {
    const { runtime, buyer, intentId, response, captures } = await sandboxCapturedButUnsaved("en", true);
    expect(runtime.audit.append).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain(`<p role="alert">${permissionCopy("en").captureRecordUnsaved}</p>`);
    expect(html).toMatch(/<code>[A-Za-z0-9_-]{1,64}<\/code>/);
    expect(html).not.toMatch(/<form|<button|<a\b|<script/);
    await expect(handleSandboxCapture(post(`/checkout/${intentId}/capture`, { csrfToken: buyer.csrfToken }, buyer), runtime, intentId)).rejects.toThrow();
    expect(captures()).toBe(1);
  });
});

describe("form parsing", () => {
  it("takes the seller from the catalog and accepts only exact item pairs", () => {
    const { runtime } = memoryRuntime();
    expect(parsePermissionForm({ item: ITEM, quantity: "2", total: "1759.98", expiry: "session" }, runtime.catalog)).toEqual({
      ok: true,
      value: { merchantId: runtime.catalog.merchant.merchantId, productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", maxQuantity: 2, maxTotalCents: 175_998, expiry: "session" },
    });
    expect(parsePermissionForm({ item: `${ITEM}:extra`, quantity: "1", total: "1", expiry: "1h" }, runtime.catalog)).toMatchObject({ ok: false, field: "item" });
    // The form layer itself refuses pairs that are not in the catalog (the model checks again).
    for (const item of ["dmp_notreal123:dmv_notreal123", "dmp_aspire14ai:dmv_aspirego15"]) {
      expect(parsePermissionForm({ item, quantity: "1", total: "1", expiry: "1h" }, runtime.catalog), item).toEqual({ ok: false, code: "ITEM_INVALID", field: "item" });
    }
  });
});
