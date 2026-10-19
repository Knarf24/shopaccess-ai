import { Fragment, isValidElement, cloneElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { handleSessionStart } from "@/server/handlers";
import type { PgCheckoutView } from "@/server/pg-views";
import { createRuntime, type Runtime } from "@/server/runtime";
import { buildShoppingView, parsePreferences } from "@/server/shopping";
import { checkoutMessage, messageFor } from "@/server/views";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// Finding 9 (Codex r2 residual): `messageFor` must resolve only the message table's own keys. A URL error or notice
// named after an Object.prototype member gets the existing generic message, never an inherited property.
//
// The pages are rendered as Next would render them for one request. In mock mode every decision is real. The
// PostgreSQL branches run with their four pg-views reads replaced by canned values: no database is opened or contacted.
const PROTOTYPE_NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"] as const;
const GENERIC = "That action could not be completed.";
const SITE = "https://shop.example.test";
// Every name is checked before asserting, so a failure lists all five (pairs, then Object.fromEntries: an assignment
// to `record["__proto__"]` would set the prototype instead of a key). An inherited object makes React's render fail
// inside the page's Suspense boundary, which then shows only its loading fallback (no alert and no status).
const EXPECTED_ALERT = Object.fromEntries(PROTOTYPE_NAMES.map((code) => [code, [GENERIC]]));
const EXPECTED_BOTH = Object.fromEntries(PROTOTYPE_NAMES.map((code) => [code, { alert: [GENERIC], status: [GENERIC] }]));

const page = vi.hoisted(() => ({ mode: "mock" as "mock" | "postgres", runtime: null as unknown, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: page.cookie }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/server/runtime-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/runtime-access")>()),
  openApplication: async () =>
    page.mode === "mock" ? { mode: "mock", runtime: { ok: true, value: page.runtime } } : { mode: "postgres", runtime: { services: async () => ({}) } },
}));
const PG_SESSION = { presence: "PRESENT", context: { session: { csrfToken: "pg-csrf", keyStatus: "ACTIVE" }, cookie: {}, credential: {} } };
const PG_CHECKOUT: PgCheckoutView = {
  intentId: `ci_${"ab".repeat(16)}`,
  storedState: "QUOTED",
  effectiveStatus: "QUOTED",
  quoteStale: false,
  merchantName: "ShopAccess Demo Store (simulated)",
  itemTitle: "Acer Aspire Go 15 — 8 GB LPDDR5, 256 GB PCIe NVMe SSD",
  quantity: 1,
  totalCents: 57_999,
  currency: "USD",
  quoteExpiresAt: "2026-10-18T12:15:00.000Z",
  challenge: null,
  actions: { review: false, cancel: false, replace: null, startAnother: null, successorIntentId: null },
} as PgCheckoutView;
vi.mock("@/server/pg-views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/pg-views")>()),
  pgCookieHeader: async () => "pg-cookie",
  resolvePgPageSession: async () => PG_SESSION,
  buildPgShoppingView: async (_services: unknown, preferences: Parameters<typeof buildShoppingView>[1]) => ({
    kind: "OK",
    value: await buildShoppingView(page.runtime as Runtime, preferences),
  }),
  buildPgCheckoutList: async () => ({ kind: "OK", value: [] }),
  buildPgCheckoutView: async () => ({ kind: "OK", value: PG_CHECKOUT }),
}));
const { default: ShopPage } = await import("@/app/shop/page");
const { default: CheckoutsPage } = await import("@/app/checkouts/page");
const { default: CheckoutPage } = await import("@/app/checkout/[intentId]/page");

/** Resolves the async server components in a page tree (the page, its guarded content, PgShopContent…), then renders. */
async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function" && element.type.constructor.name === "AsyncFunction") {
    return resolveServer(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  if (element.props.children === undefined) return element;
  // Children go back as separate arguments, as JSX passed them, so static siblings need no keys.
  const children = element.props.children;
  const resolved = Array.isArray(children) ? await Promise.all(children.map(resolveServer)) : [await resolveServer(children)];
  return cloneElement(element, undefined, ...resolved);
}
const render = async (tree: ReactNode) => renderToStaticMarkup(<Fragment>{await resolveServer(tree)}</Fragment>);
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]);
const byRole = (html: string, role: "alert" | "status") =>
  [...html.matchAll(new RegExp(`<p\\b[^>]*role="${role}"[^>]*>([\\s\\S]*?)</p>`, "g"))].map((match) => text(match[1]));

function mockWorld() {
  const time = createTestClock("2026-10-18T12:00:00.000Z");
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock });
  page.runtime = runtime;
  return runtime;
}

beforeEach(() => {
  page.mode = "mock";
  page.runtime = null;
  page.cookie = "";
});

describe("messageFor: only the message table's own keys", () => {
  it("returns the generic message for Object.prototype names and unknown codes", () => {
    expect(Object.fromEntries(PROTOTYPE_NAMES.map((code) => [code, messageFor(code)]))).toEqual(Object.fromEntries(PROTOTYPE_NAMES.map((code) => [code, GENERIC])));
    expect(messageFor("NOT_A_REAL_CODE")).toBe(GENERIC);
  });

  it("keeps recognized messages and the empty case unchanged", () => {
    expect(messageFor("CONFIRMED")).toBe("Your confirmation of this purchase summary was recorded. No payment has been taken.");
    expect(messageFor("QUOTE_STALE_CATALOG")).toBe("The item changed since this quote was made. Go back and request a new quote.");
    expect(messageFor("START_UNCERTAIN")).toMatch(/^We could not tell whether your checkout was created\./);
    expect(messageFor(undefined)).toBeNull();
    expect(messageFor("")).toBeNull();
  });

  it("checkoutMessage is unchanged: generic for prototype names, own keys in both languages", () => {
    for (const code of PROTOTYPE_NAMES) {
      expect(checkoutMessage(code, "en"), code).toEqual({ text: GENERIC, lang: "en" });
      expect(checkoutMessage(code, "es"), code).toEqual({ text: "No se pudo completar esa acción.", lang: "es" });
    }
    expect(checkoutMessage("CONFIRMED", "en")).toEqual({ text: messageFor("CONFIRMED"), lang: "en" });
    expect(checkoutMessage("STEP_NOT_AVAILABLE", "es")).toEqual({ text: messageFor("STEP_NOT_AVAILABLE"), lang: "en" });
  });
});

describe("pages that show URL codes through messageFor", () => {
  it("/shop in mock mode: each prototype-named error shows the generic alert", async () => {
    const runtime = mockWorld();
    const started = await handleSessionStart(new Request(`${SITE}/session/start?use=schoolwork&budget=600`), runtime);
    page.cookie = `${SESSION_COOKIE_NAME}=${started.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]}`;
    // Positive control first: the harness renders a recognized message.
    const known = await render(ShopPage({ searchParams: Promise.resolve({ use: "schoolwork", budget: "600", error: "VARIANT_UNAVAILABLE" }) }));
    expect(byRole(known, "alert")).toEqual(["That laptop is not available."]);
    const seen: Array<[string, string[]]> = [];
    for (const code of PROTOTYPE_NAMES) {
      seen.push([code, byRole(await render(ShopPage({ searchParams: Promise.resolve({ use: "schoolwork", budget: "600", error: code }) })), "alert")]);
    }
    expect(Object.fromEntries(seen)).toEqual(EXPECTED_ALERT);
  });

  it("/shop in PostgreSQL mode (pg-views reads canned; no database): each prototype-named error shows the generic alert", async () => {
    mockWorld();
    page.mode = "postgres";
    expect(parsePreferences("schoolwork", "600")).not.toBeNull();
    const known = await render(ShopPage({ searchParams: Promise.resolve({ use: "schoolwork", budget: "600", error: "VARIANT_UNAVAILABLE" }) }));
    expect(byRole(known, "alert")).toEqual(["That laptop is not available."]);
    const seen: Array<[string, string[]]> = [];
    for (const code of PROTOTYPE_NAMES) {
      seen.push([code, byRole(await render(ShopPage({ searchParams: Promise.resolve({ use: "schoolwork", budget: "600", error: code }) })), "alert")]);
    }
    expect(Object.fromEntries(seen)).toEqual(EXPECTED_ALERT);
  });

  it("/checkouts (PostgreSQL only; pg-views reads canned): prototype-named error and notice show the generic text", async () => {
    page.mode = "postgres";
    const known = await render(CheckoutsPage({ searchParams: Promise.resolve({ error: "START_UNCERTAIN", notice: "CANCELED" }) }));
    expect(byRole(known, "alert")[0]).toMatch(/^We could not tell whether your checkout was created\./);
    expect(byRole(known, "status")).toEqual(["This checkout was canceled."]);
    const seen: Array<[string, { alert: string[]; status: string[] }]> = [];
    for (const code of PROTOTYPE_NAMES) {
      const html = await render(CheckoutsPage({ searchParams: Promise.resolve({ error: code, notice: code }) }));
      seen.push([code, { alert: byRole(html, "alert"), status: byRole(html, "status") }]);
    }
    expect(Object.fromEntries(seen)).toEqual(EXPECTED_BOTH);
  });

  it("PostgreSQL checkout (pg-views reads canned): prototype-named error and notice show the generic text", async () => {
    page.mode = "postgres";
    const known = await render(CheckoutPage({ params: Promise.resolve({ intentId: PG_CHECKOUT.intentId }), searchParams: Promise.resolve({ notice: "CONFIRMED", error: "CANCELED" }) }));
    expect(byRole(known, "status")).toEqual(["Your confirmation of this purchase summary was recorded. No payment has been taken."]);
    expect(byRole(known, "alert")).toEqual(["This checkout was canceled."]);
    const seen: Array<[string, { alert: string[]; status: string[] }]> = [];
    for (const code of PROTOTYPE_NAMES) {
      const html = await render(CheckoutPage({ params: Promise.resolve({ intentId: PG_CHECKOUT.intentId }), searchParams: Promise.resolve({ error: code, notice: code }) }));
      seen.push([code, { alert: byRole(html, "alert"), status: byRole(html, "status") }]);
    }
    expect(Object.fromEntries(seen)).toEqual(EXPECTED_BOTH);
  });
});
