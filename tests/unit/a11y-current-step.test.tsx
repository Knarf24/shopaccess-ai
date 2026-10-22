import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CHECKOUT_ALERT_ID,
  CHECKOUT_CONFIRM_HEADING_ID,
  CHECKOUT_NOTICE_ID,
  CHECKOUT_QUOTE_HEADING_ID,
  CHECKOUT_QUOTE_PROBLEM_ID,
  checkoutCurrentTargetId,
} from "@/app/[lang]/checkout/[intentId]/checkout-targets";
import { SHOP_ALERT_ID, SHOP_STEP_HEADING_ID, ShopListing } from "@/app/(english)/shop/shop-listing";
import { ConfirmationSummary } from "@/components/ConfirmationSummary";
import { FocusOnArrival, focusArrivalTarget } from "@/components/FocusOnArrival";
import {
  PERMISSION_RESULT_ID,
  PERMISSION_REVIEW_HEADING_ID,
  PERMISSIONS_HEADING_ID,
  PurchasePermissions,
  permissionArrivalTarget,
  type PermissionResult,
  type PermissionReview,
} from "@/components/PurchasePermissions";
import { SandboxCheckoutActions, SimulatedPaymentPanel } from "@/components/SimulatedPaymentPanel";
import type { ConfirmationChallenge } from "@/lib/confirmation/confirmation";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { sellerName } from "@/lib/i18n/seller-name";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { createRuntime } from "@/server/runtime";
import { buildShoppingView, parsePreferences } from "@/server/shopping";
import type { CheckoutView } from "@/server/views";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// M2-3 slice 3 accessibility and language corrections (owner decision, October 17): focus on arrival on the
// permissions page, skip links on /shop and the checkout, and the localized "(simulated)" seller descriptor.

const FOCUSABLE = /<(a|button|input|select|textarea)\b(?![^>]*type="hidden")[^>]*>/g;
const firstFocusable = (html: string) => html.match(FOCUSABLE)?.[0] ?? "";
const skipHref = (html: string) => html.match(/<a class="skip-link" href="#([^"]+)"/)?.[1];
/** The opening tag of the element with this id. */
const tagWithId = (html: string, id: string) => html.match(new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? "";

/** Every element in a rendered tree of plain (hook-free) components, without running effects. */
function elementsOf(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elementsOf(props.children)];
}

const choices = [{ value: "dmp_aspire14ai:dmv_aspire14ai", label: "Acer Aspire 14 AI — 16 GB", seller: "ShopAccess Demo Store (simulated)", maxQuantity: 2 }];
const empty = { item: "", quantity: "", total: "", expiry: "" };
const review: PermissionReview = {
  item: "dmp_aspire14ai:dmv_aspire14ai",
  seller: "ShopAccess Demo Store (simulated)",
  product: "Acer Aspire 14 AI",
  variant: "16 GB",
  maxQuantity: 1,
  maxTotalCents: 90000,
  total: "900",
  quantity: "1",
  expiry: "1h",
  endsAt: new Date("2026-10-17T13:00:00.000Z"),
};
const permissionsProps = (result: PermissionResult, shownReview: PermissionReview | null) => ({
  language: "en" as const,
  csrfToken: "csrf-test",
  skipLabel: "Skip to the current step",
  choices,
  permissions: [],
  result,
  review: shownReview,
  entered: empty,
});
const arrivalOf = (result: PermissionResult, shownReview: PermissionReview | null) =>
  elementsOf(PurchasePermissions(permissionsProps(result, shownReview)))
    .filter((element) => element.type === FocusOnArrival)
    .map((element) => (element.props as { targetId: string }).targetId);

describe("permissions page: focus on arrival", () => {
  const results: PermissionResult[] = [{ kind: "created" }, { kind: "revoked" }, { kind: "error", code: "TOTAL_INVALID", field: "total" }, { kind: "error", code: "REVOKE_NOT_AVAILABLE", field: null }];

  it("moves focus to the result after Create, Revoke or an error, and to the review heading after Review", () => {
    for (const result of results) {
      expect(permissionArrivalTarget(result, null)).toBe(PERMISSION_RESULT_ID);
      expect(arrivalOf(result, null)).toEqual([PERMISSION_RESULT_ID]);
    }
    expect(permissionArrivalTarget(null, review)).toBe(PERMISSION_REVIEW_HEADING_ID);
    expect(arrivalOf(null, review)).toEqual([PERMISSION_REVIEW_HEADING_ID]);
  });

  it("leaves focus alone on a plain visit", () => {
    expect(permissionArrivalTarget(null, null)).toBeNull();
    expect(arrivalOf(null, null)).toEqual([]);
  });

  it("targets an element that is rendered, programmatically focusable and the skip target, before the next controls", () => {
    for (const [result, shownReview, id] of [
      [{ kind: "created" }, null, PERMISSION_RESULT_ID],
      [{ kind: "error", code: "TOTAL_INVALID", field: "total" }, null, PERMISSION_RESULT_ID],
      [null, review, PERMISSION_REVIEW_HEADING_ID],
    ] as const) {
      const html = renderToStaticMarkup(<PurchasePermissions {...permissionsProps(result, shownReview)} />);
      expect(tagWithId(html, id)).toContain('tabindex="-1"');
      expect(skipHref(html)).toBe(id);
      // Tab continues from the target into the form below it, not back to the top of the page.
      expect(html.indexOf(`id="${id}"`)).toBeLessThan(html.search(/<(select|button)\b/));
    }
    expect(skipHref(renderToStaticMarkup(<PurchasePermissions {...permissionsProps(null, null)} />))).toBe(PERMISSIONS_HEADING_ID);
  });

  it("focuses the target when it exists and does nothing otherwise", () => {
    const focused: string[] = [];
    const doc = { getElementById: (id: string) => (id === PERMISSION_RESULT_ID ? ({ focus: () => focused.push(id) } as unknown as HTMLElement) : null) };
    expect(focusArrivalTarget(doc, PERMISSION_RESULT_ID)).toBe(true);
    expect(focusArrivalTarget(doc, "missing")).toBe(false);
    expect(focused).toEqual([PERMISSION_RESULT_ID]);
  });

  it("gives skip-link and arrival targets a visible outline however focus arrived", () => {
    const presentation = readFileSync("src/app/guided-presentation.css", "utf8");
    expect(presentation).toMatch(/\.guided-presentation \[tabindex="-1"\]:focus\s*\{\s*outline:\s*3px solid var\(--gp-focus\)/);
    const globals = readFileSync("src/app/globals.css", "utf8");
    expect(globals).toMatch(/:where\(\[tabindex="-1"\]\):focus\s*\{\s*outline:\s*3px solid currentColor/);
    expect(globals).toMatch(/:where\(\.skip-link\):not\(:focus\)\s*\{[^}]*clip-path: inset\(50%\)/);
    expect(globals).not.toMatch(/skip-link[^{]*\{[^}]*display:\s*none/);
  });
});

describe("/shop skip link", () => {
  const preferences = parsePreferences("programming", "1000");
  if (!preferences) throw new Error("preferences");
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins(["https://shop.example.test"]) }, { clock: createTestClock().clock });
  const render = async (props: { error?: string | null; refusal?: "PERMISSION_REQUIRED" | null; sessionNotice?: ReactNode }) =>
    renderToStaticMarkup(
      <ShopListing view={await buildShoppingView(runtime, preferences)} preferences={preferences} csrfToken="csrf-test" error={props.error ?? null} refusal={props.refusal ?? null} sessionNotice={props.sessionNotice} />,
    );

  it("is the first focusable element and targets the demo-store list when nothing is refused", async () => {
    const html = await render({});
    expect(firstFocusable(html)).toBe(`<a class="skip-link" href="#${SHOP_STEP_HEADING_ID}">`);
    expect(html).toContain(`>${journeyCopy("en").skipToCurrentStep}</a>`);
    expect(tagWithId(html, SHOP_STEP_HEADING_ID)).toMatch(/^<h2\b[^>]*tabindex="-1"/);
    expect(html).toContain(`aria-labelledby="${SHOP_STEP_HEADING_ID}"`);
  });

  it("targets the permission refusal, kept below the heading and above the use and budget form", async () => {
    const html = await render({ refusal: "PERMISSION_REQUIRED" });
    expect(skipHref(html)).toBe(SHOP_ALERT_ID);
    const refusal = tagWithId(html, SHOP_ALERT_ID);
    expect(refusal).toMatch(/^<p\b[^>]*tabindex="-1"[^>]*role="alert"/);
    expect(html.match(new RegExp(`id="${SHOP_ALERT_ID}"`, "g"))).toHaveLength(1);
    expect(html).toContain('href="/en/shop/permissions"');
    expect(html.indexOf(`id="${SHOP_ALERT_ID}"`)).toBeLessThan(html.indexOf("<form"));
  });

  it("targets an ordinary error the same way", async () => {
    const html = await render({ error: "That quote could not be started." });
    expect(skipHref(html)).toBe(SHOP_ALERT_ID);
    expect(tagWithId(html, SHOP_ALERT_ID)).toMatch(/tabindex="-1"[^>]*role="alert"/);
  });

  it("stays first when a session notice is shown", async () => {
    const html = await render({ sessionNotice: <form method="post" action="/session/rotate"><button type="submit">Rotate</button></form> });
    expect(firstFocusable(html)).toContain('class="skip-link"');
    expect(html.indexOf('class="skip-link"')).toBeLessThan(html.indexOf("Rotate"));
  });
});

describe("checkout skip link", () => {
  const base = { alert: false, notice: false, confirmation: false, quoteProblem: false, quoteStep: false, paymentHeadingId: "sim-heading" };

  it("targets the refusal or error, then a notice, then the current step", () => {
    expect(checkoutCurrentTargetId({ ...base, alert: true, notice: true, confirmation: true })).toBe(CHECKOUT_ALERT_ID);
    expect(checkoutCurrentTargetId({ ...base, notice: true, confirmation: true })).toBe(CHECKOUT_NOTICE_ID);
    expect(checkoutCurrentTargetId({ ...base, confirmation: true })).toBe(CHECKOUT_CONFIRM_HEADING_ID);
    expect(checkoutCurrentTargetId({ ...base, quoteProblem: true, quoteStep: true })).toBe(CHECKOUT_QUOTE_PROBLEM_ID);
    expect(checkoutCurrentTargetId({ ...base, quoteStep: true })).toBe(CHECKOUT_QUOTE_HEADING_ID);
    expect(checkoutCurrentTargetId(base)).toBe("sim-heading");
    expect(checkoutCurrentTargetId({ ...base, paymentHeadingId: "sandbox-heading" })).toBe("sandbox-heading");
    expect(checkoutCurrentTargetId({ ...base, paymentHeadingId: null })).toBe(CHECKOUT_QUOTE_HEADING_ID);
  });

  it("renders every step target as a programmatically focusable element", () => {
    const challenge: ConfirmationChallenge = {
      confirmationId: "cnf_test",
      nonce: "nonce",
      quoteId: "qt_test",
      quoteDigest: "0".repeat(64),
      expiresAt: "2026-10-17T12:05:00.000Z",
      summary: { merchantName: "ShopAccess Demo Store (simulated)", productTitle: "Acer Aspire Go 15", variantLabel: "8 GB", quantity: 1, currency: "USD", totalCents: 57999 },
    };
    for (const language of [undefined, "es"] as const) {
      // Focusable only while it is the skip target, so the confirmation form otherwise keeps no tabindex at all.
      const target = renderToStaticMarkup(<ConfirmationSummary challenge={challenge} csrfToken="csrf-test" action="/checkout/x/confirm" language={language} headingTabIndex={-1} />);
      expect(tagWithId(target, CHECKOUT_CONFIRM_HEADING_ID)).toMatch(/^<h2\b[^>]*tabindex="-1"/);
      const plain = renderToStaticMarkup(<ConfirmationSummary challenge={challenge} csrfToken="csrf-test" action="/checkout/x/confirm" language={language} />);
      expect(plain).not.toContain("tabindex");
    }
    const view = { intentId: "ci_test", state: "USER_CONFIRMED", steps: [], transitions: [], observations: [], operations: [] } as unknown as CheckoutView;
    expect(tagWithId(renderToStaticMarkup(<SimulatedPaymentPanel view={view} csrfToken="csrf-test" />), "sim-heading")).toContain('tabindex="-1"');
    expect(tagWithId(renderToStaticMarkup(<SandboxCheckoutActions view={view} csrfToken="csrf-test" copy={journeyCopy("en").sandboxCheckout} />), "sandbox-heading")).toContain(
      'tabindex="-1"',
    );
  });

  it("puts the skip link first in both modes and gives the page's own targets tabIndex -1", () => {
    const page = readFileSync("src/app/[lang]/checkout/[intentId]/page.tsx", "utf8");
    const mock = page.slice(page.indexOf("async function CheckoutContentUnguarded"));
    expect(mock.indexOf("<SkipToCurrentStep")).toBeGreaterThan(-1);
    expect(mock.indexOf("<SkipToCurrentStep")).toBeLessThan(mock.indexOf("<h1"));
    // The PostgreSQL view's main render (its earlier "not available" returns have nothing to skip to).
    const pg = page.slice(page.indexOf("async function PgCheckoutContent"), page.indexOf("async function CheckoutContentUnguarded"));
    const pgMain = pg.slice(pg.indexOf("const skipTarget"));
    expect(pgMain.indexOf("<SkipToCurrentStep")).toBeGreaterThan(-1);
    expect(pgMain.indexOf("<SkipToCurrentStep")).toBeLessThan(pgMain.search(/<(p|ConfirmationSummary|SessionNotice|CheckoutActions)\b/));
    for (const id of ["CHECKOUT_ALERT_ID", "CHECKOUT_NOTICE_ID", "CHECKOUT_QUOTE_PROBLEM_ID", "CHECKOUT_QUOTE_HEADING_ID"]) {
      const uses = page.match(new RegExp(`<(p|h2) id=\\{(?:[^}?]*\\? undefined : )?${id}\\}[^>]*>`, "g")) ?? [];
      expect(uses.length, id).toBeGreaterThanOrEqual(2);
      for (const use of uses) expect(use, id).toContain("tabIndex={-1}");
    }
    expect(page).toMatch(/<PermissionRefusal[^>]*id=\{CHECKOUT_ALERT_ID\}/);
    expect(page.match(/headingTabIndex=\{skipTarget === CHECKOUT_CONFIRM_HEADING_ID \? -1 : undefined\}/g)).toHaveLength(2);
  });
});

describe("seller name language", () => {
  const catalogName = DEMO_MERCHANT_CATALOG.merchant.displayName;

  it("keeps the proper name and localizes only the simulated descriptor", () => {
    expect(catalogName).toBe("ShopAccess Demo Store (simulated)");
    expect(sellerName(catalogName, "en")).toBe(catalogName);
    expect(sellerName(catalogName, undefined)).toBe(catalogName);
    expect(sellerName(catalogName, "es")).toBe("ShopAccess Demo Store (simulada)");
    expect(sellerName("Other Seller", "es")).toBe("Other Seller");
  });

  it("shows the Spanish descriptor in the Spanish confirmation and leaves English unchanged", () => {
    const challenge = {
      confirmationId: "cnf_test",
      nonce: "nonce",
      quoteId: "qt_test",
      quoteDigest: "0".repeat(64),
      expiresAt: "2026-10-17T12:05:00.000Z",
      summary: { merchantName: catalogName, productTitle: "Acer Aspire Go 15", variantLabel: "8 GB", quantity: 1, currency: "USD" as const, totalCents: 57999 },
    };
    const spanish = renderToStaticMarkup(<ConfirmationSummary challenge={challenge} csrfToken="csrf-test" language="es" />);
    expect(spanish).toContain("ShopAccess Demo Store (simulada)");
    expect(spanish).not.toContain("(simulated)");
    const english = renderToStaticMarkup(<ConfirmationSummary challenge={challenge} csrfToken="csrf-test" />);
    expect(english).toContain("ShopAccess Demo Store (simulated)");
  });

  it("is used for every seller the permissions page shows", () => {
    const page = readFileSync("src/app/[lang]/shop/permissions/page.tsx", "utf8");
    expect(page.match(/seller: sellerName\(catalog\.merchant\.displayName, language\)/g)).toHaveLength(3);
    expect(page).not.toMatch(/seller: catalog\.merchant\.displayName/);
  });
});
