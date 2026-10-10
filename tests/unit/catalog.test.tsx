import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationSummary } from "@/components/ConfirmationSummary";
import { ExternalProductCard } from "@/components/ExternalProductCard";
import { DEMO_MERCHANT_CATALOG, findMerchantVariant, formatUsd } from "@/lib/catalog/merchant-catalog";
import { ExternalProductSchema, MerchantCatalogSchema, MerchantVariantSchema, type ExternalProduct } from "@/lib/catalog/schemas";
import { parseSafeExternalUrl } from "@/lib/catalog/url";
import { requestQuote, startCheckout } from "@/lib/checkout/service";
import { confirmPurchaseSummary, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { dispatchOrderCreate } from "@/lib/payment/orchestrator";
import { createMockDiscoveryProvider, MOCK_DISCOVERY_RECORDS, validateExternalRecords } from "@/lib/providers/discovery";
import { verifyQuote } from "@/lib/quote/quote";
import { confirmedIntent, createWorld, newSession, quotedIntent, stateOf } from "./helpers";

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

afterEach(() => vi.restoreAllMocks());

describe("demo merchant catalog", () => {
  it("is a valid, curated catalog of 3-5 laptops from one simulated Sandbox merchant", () => {
    expect(MerchantCatalogSchema.safeParse(DEMO_MERCHANT_CATALOG).success).toBe(true);
    expect(DEMO_MERCHANT_CATALOG.products.length).toBeGreaterThanOrEqual(3);
    expect(DEMO_MERCHANT_CATALOG.products.length).toBeLessThanOrEqual(5);
    expect(DEMO_MERCHANT_CATALOG.merchant.simulatedSandbox).toBe(true);
    for (const product of DEMO_MERCHANT_CATALOG.products) expect(product.imagePath).toMatch(/^\/catalog\//);
  });

  it("rejects invalid variants: bad IDs, non-integer or non-positive amounts, wrong currency, bad quantities", () => {
    const valid = DEMO_MERCHANT_CATALOG.products[0].variants[0];
    const invalid = [
      { variantId: "ext_mock-aurora-13" },
      { variantId: "DMV_UPPER" },
      { unitAmountCents: 449.5 },
      { unitAmountCents: 0 },
      { unitAmountCents: -100 },
      { currency: "EUR" },
      { maxQuantityPerOrder: 0 },
      { maxQuantityPerOrder: 11 },
      { availability: "MAYBE" },
      { unexpectedField: true },
    ];
    for (const change of invalid) expect(MerchantVariantSchema.safeParse({ ...valid, ...change }).success, JSON.stringify(change)).toBe(false);
  });

  it("formats integer cents without floating point", () => {
    expect(formatUsd(79900)).toBe("$799.00");
    expect(formatUsd(109905)).toBe("$1,099.05");
  });
});

describe("CAT-01: external discovery IDs are rejected in merchant checkout", () => {
  it("rejects external IDs, and never resolves them by fuzzy match", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const intent = await startCheckout(world.checkout, session.id);

    for (const request of [
      { productId: "ext_mock-aurora-13", variantId: "dmv_codebook15a", quantity: 1 },
      { productId: "dmp_codebook15", variantId: "ext_mock-aurora-13", quantity: 1 },
      { productId: "ext_mock-aurora-13", variantId: "ext_mock-aurora-13", quantity: 1 },
    ]) {
      expect(await requestQuote(world.checkout, session.id, intent.id, request)).toEqual({ ok: false, error: "REQUEST_INVALID" });
    }
    // Well-formed but unknown merchant IDs, and near-miss IDs, are not matched to anything.
    expect(await requestQuote(world.checkout, session.id, intent.id, { productId: "dmp_codebook1", variantId: "dmv_codebook15a", quantity: 1 })).toEqual({
      ok: false,
      error: "PRODUCT_NOT_IN_MERCHANT_CATALOG",
    });
    expect(findMerchantVariant(world.catalog, "dmp_studybook14", "dmv_codebook15a")).toBeNull();
    expect(await stateOf(world, intent.id)).toBe("DRAFT");
  });

  it("keeps the two ID spaces disjoint", async () => {
    const discovered = await createMockDiscoveryProvider().search("");
    expect(discovered.products.length).toBeGreaterThan(0);
    for (const product of discovered.products) {
      expect(product.externalId.startsWith("ext_")).toBe(true);
      expect(findMerchantVariant(DEMO_MERCHANT_CATALOG, product.externalId, product.externalId)).toBeNull();
    }
  });
});

describe("CAT-02: quotes are invalidated after material variant changes", () => {
  it.each([
    ["price change", (world: ReturnType<typeof createWorld>) => (world.catalog.products[1].variants[0].unitAmountCents += 100)],
    ["availability change", (world: ReturnType<typeof createWorld>) => (world.catalog.products[1].variants[0].availability = "OUT_OF_STOCK")],
    ["variant removed", (world: ReturnType<typeof createWorld>) => world.catalog.products[1].variants.shift()],
    ["merchant change", (world: ReturnType<typeof createWorld>) => (world.catalog.merchant.merchantId = "dmm_someoneelse")],
  ])("%s", async (_name, change) => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { quote } = await quotedIntent(world, session.id);
    const context = { sessionId: session.id, catalog: world.catalog, now: world.time.clock() };
    expect(verifyQuote(quote, context).ok).toBe(true);
    change(world);
    expect(verifyQuote(quote, context)).toEqual({ ok: false, error: "QUOTE_STALE_CATALOG" });
    expect(await prepareConfirmation(world.checkout, session.id, quote.quoteId)).toEqual({ ok: false, error: "QUOTE_STALE_CATALOG" });
  });

  it("blocks confirmation and order dispatch on a stale quote and requires a new quote", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { quote } = await quotedIntent(world, session.id);
    const challenge = await prepareConfirmation(world.checkout, session.id, quote.quoteId);
    if (!challenge.ok) throw new Error("setup");
    world.catalog.products[1].variants[0].unitAmountCents += 5000;
    const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
    expect(await confirmPurchaseSummary(world.checkout, session.id, { confirmationId, nonce, quoteId, quoteDigest })).toEqual({
      ok: false,
      error: "QUOTE_STALE_CATALOG",
    });

    const second = createWorld();
    const owner = await newSession(second);
    const confirmed = await confirmedIntent(second, owner.session.id);
    second.catalog.products[1].variants[0].unitAmountCents += 5000;
    expect(await dispatchOrderCreate(second.payment(), confirmed.intentId)).toEqual({ ok: false, error: "QUOTE_NO_LONGER_VALID" });
    expect(await stateOf(second, confirmed.intentId)).toBe("DRAFT");
    expect(second.provider.calls).toEqual([]);
  });
});

describe("URL-01: unsafe external URLs are rejected and never fetched by the server", () => {
  it("accepts only plain https URLs to public hostnames", () => {
    expect(parseSafeExternalUrl("https://shop.example.com/laptops/aurora-13?ref=1")).toEqual({
      ok: true,
      value: "https://shop.example.com/laptops/aurora-13?ref=1",
    });
    const unsafe = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "http://shop.example.com/",
      "//shop.example.com/x",
      "/relative/path",
      "https://user:pass@shop.example.com/",
      "https://localhost/admin",
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/",
      "https://2130706433/",
      "https://intranet/",
      "https://db.internal/",
      "https://shop.example.com/\nSet-Cookie: x",
      " https://shop.example.com/",
      "https://shop.example.com\\@evil.example/",
      "",
      `https://shop.example.com/${"a".repeat(2100)}`,
      null,
      42,
    ];
    for (const url of unsafe) expect(parseSafeExternalUrl(url).ok, String(url)).toBe(false);
  });

  it("drops discovery records with unsafe URLs or extra fields", () => {
    const [good] = MOCK_DISCOVERY_RECORDS as Record<string, unknown>[];
    const result = validateExternalRecords([
      good,
      { ...good, externalId: "ext_bad-1", url: "javascript:alert(1)" },
      { ...good, externalId: "ext_bad-2", url: "http://shop.example.com/" },
      { ...good, externalId: "dmp_codebook15" },
      { ...good, externalId: "ext_bad-3", merchantVariantId: "dmv_codebook15a" },
    ]);
    expect(result.products).toHaveLength(1);
    expect(result.rejectedCount).toBe(4);
  });

  it("performs no network access while discovering or validating products", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network access is not allowed");
    });
    const result = await createMockDiscoveryProvider().search("laptop");
    expect(result.products.length).toBeGreaterThan(0);
    for (const product of result.products) renderToStaticMarkup(<ExternalProductCard product={product} />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("has no network-capable code or provider SDK imports anywhere in src/", () => {
    const forbidden = [
      /\bfetch\s*\(/,
      /XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(/,
      /from\s+["'](?:node:)?(?:http|https|http2|dgram|tls|dns|child_process)["']/,
      /from\s+["'][^"']*(?:paypal|openai|supabase|google\/generative|genai|channel3|axios|undici|node-fetch)[^"']*["']/i,
      /require\s*\(/,
    ];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
    }
  });
});

describe("XSS-01: malicious product content renders inert", () => {
  const malicious = {
    externalId: "ext_evil-1",
    source: "mock_discovery",
    sellerLabel: `"><img src=x onerror=alert(1)>`,
    title: `<script>alert("xss")</script>`,
    description: `<a href="javascript:alert(1)" onclick="steal()">click</a><iframe src="https://evil.example"></iframe>`,
    url: "https://shop.example.com/item?q=%22%3E%3Cscript%3E",
    retrievedAt: "2026-10-01T12:00:00.000Z",
  };

  it("escapes markup in every untrusted field", () => {
    const product = ExternalProductSchema.parse(malicious);
    const html = renderToStaticMarkup(<ExternalProductCard product={product} />);
    // The payload text survives only as escaped text: no live tags, event-handler attributes or script URLs.
    expect(html).not.toMatch(/<script|<img|<iframe|<[^>]*\son\w+\s*=|href="\s*javascript:/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain("ShopAccess AI is not the seller");
  });

  it("never emits an unsafe href even if an unvalidated record reaches the component", () => {
    const bypassed = { ...ExternalProductSchema.parse(malicious), url: "javascript:alert(document.cookie)" } as ExternalProduct;
    const html = renderToStaticMarkup(<ExternalProductCard product={bypassed} />);
    expect(html).not.toMatch(/<[^>]*\shref=/i);
    expect(html).not.toContain("<a ");
    expect(html).toContain("No safe link is available");
  });

  it("uses no raw HTML injection APIs in src/", () => {
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(/dangerouslySetInnerHTML|innerHTML|document\.write|\beval\s*\(|new Function\s*\(/.test(text), file).toBe(false);
    }
  });
});

describe("confirmation summary UI", () => {
  it("renders the exact bound summary with native, keyboard-operable controls and the PayPal explanation", async () => {
    const world = createWorld();
    const { session } = await newSession(world);
    const { quote } = await quotedIntent(world, session.id);
    const challenge = await prepareConfirmation(world.checkout, session.id, quote.quoteId);
    if (!challenge.ok) throw new Error("setup");
    const html = renderToStaticMarkup(<ConfirmationSummary challenge={challenge.value} csrfToken={session.csrfToken} action="/checkout/confirm" />);

    expect(html).toContain("ShopAccess Demo Store (simulated)");
    expect(html).toContain("CodeBook 15");
    expect(html).toContain("$799.00");
    expect(html).toMatch(/<button type="submit"[^>]*aria-describedby="confirm-explanation"/);
    expect(html).toMatch(/<input type="checkbox"[^>]*required=""/);
    expect(html).toContain("approving the payment in PayPal is the step that would authorize payment");
    expect(html).toContain(`name="quoteDigest" value="${quote.digest}"`);
    expect(html).not.toMatch(/tabindex="-1"|role="button"|onclick/i);
    // No PayPal link, script or redirect target is rendered.
    expect(html).not.toMatch(/paypal\.com|<script/i);

    const preview = renderToStaticMarkup(<ConfirmationSummary challenge={challenge.value} csrfToken={session.csrfToken} />);
    expect(preview).toMatch(/<button type="submit" disabled=""/);
  });
});
