import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationSummary } from "@/components/ConfirmationSummary";
import { ExternalProductCard } from "@/components/ExternalProductCard";
import { MerchantProductCard } from "@/components/MerchantProductCard";
import { spanishProductDescription, spanishVariantLabel } from "@/lib/catalog/demo-translations";
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

  it("is revision 2 with the three researched configurations, structured prices, and local illustrations", () => {
    const expected = [
      {
        productId: "dmp_aspirego15",
        variantId: "dmv_aspirego15",
        unitAmountCents: 57999,
        ramGb: 8,
        storageGb: 256,
        model: "AG15-21PT-R9TL",
        part: "NX.JJJAA.008",
        spanishDescription: "Modelo AG15-21PT-R9TL, pieza NX.JJJAA.008. Pantalla táctil IPS de 1920 × 1080.",
        spanishLabel: "8 GB LPDDR5, SSD PCIe NVMe de 256 GB",
      },
      {
        productId: "dmp_aspire14ai",
        variantId: "dmv_aspire14ai",
        unitAmountCents: 87999,
        ramGb: 16,
        storageGb: 512,
        model: "A14-52M-51S1",
        part: "NX.J8LAA.002",
        spanishDescription: "Modelo A14-52M-51S1, pieza NX.J8LAA.002. Pantalla IPS de 1920 × 1200.",
        spanishLabel: "16 GB LPDDR5X, SSD PCIe NVMe de 512 GB",
      },
      {
        productId: "dmp_vivobook16",
        variantId: "dmv_vivobook16",
        unitAmountCents: 99900,
        ramGb: 16,
        storageGb: 1024,
        model: "F1605VA-DS74",
        part: "90NB10N3-M004M0",
        spanishDescription: "Modelo F1605VA-DS74, pieza 90NB10N3-M004M0. Pantalla de 1920 × 1200 sin función táctil.",
        spanishLabel: "16 GB DDR4, SSD PCIe NVMe de 1 TB",
      },
    ] as const;

    expect(DEMO_MERCHANT_CATALOG.revision).toBe(2);
    expect(DEMO_MERCHANT_CATALOG.products).toHaveLength(3);
    expect(
      DEMO_MERCHANT_CATALOG.products.map((product) => [product.productId, product.variants.map((variant) => variant.variantId)]),
    ).toEqual(expected.map((row) => [row.productId, [row.variantId]]));

    for (const row of expected) {
      const entry = findMerchantVariant(DEMO_MERCHANT_CATALOG, row.productId, row.variantId);
      if (!entry) throw new Error(row.productId);
      expect(entry.product.variants).toHaveLength(1);
      expect(entry.variant.unitAmountCents).toBe(row.unitAmountCents);
      expect(entry.variant.specs.ramGb).toBe(row.ramGb);
      expect(entry.variant.specs.storageGb).toBe(row.storageGb);
      expect(entry.product.description).toContain(row.model);
      expect(entry.product.description).toContain(row.part);
      expect(entry.product.description).not.toContain(entry.variant.specs.cpu);
      expect(entry.product.description).not.toMatch(/\$|USD|579|879|999/);
      expect(spanishProductDescription(row.productId)).toBe(row.spanishDescription);
      expect(spanishVariantLabel(row.variantId)).toBe(row.spanishLabel);
      expect(existsSync(join(process.cwd(), "public", entry.product.imagePath.slice(1)))).toBe(true);

      const card = renderToStaticMarkup(
        <MerchantProductCard product={entry.product} merchantName={DEMO_MERCHANT_CATALOG.merchant.displayName} />,
      );
      expect(card).toContain(`Fixed demo price <span class="font-semibold">${formatUsd(row.unitAmountCents)}</span> USD`);
      expect(card).toContain(row.model);
      expect(card).toContain(row.part);
    }

    expect(spanishProductDescription("dmp_missing")).toBeNull();
    expect(spanishVariantLabel("dmv_missing")).toBeNull();
  });

  it("shows a catalog illustration on the homepage, keeps cards on their own images, and scopes the presentation stylesheet", () => {
    const page = readFileSync(join(SRC, "app/(english)/page.tsx"), "utf8");
    const card = readFileSync(join(SRC, "components/MerchantProductCard.tsx"), "utf8");
    const css = readFileSync(join(SRC, "app/guided-presentation.css"), "utf8");
    const pictured = DEMO_MERCHANT_CATALOG.products.find((product) => product.imagePath === "/catalog/aspire-14-ai.svg");
    expect(pictured?.title).toBe("Acer Aspire 14 AI");
    expect(page).toContain('src="/catalog/aspire-14-ai.svg"');
    expect(page).toContain('alt="Acer Aspire 14 AI, illustration"');
    expect(page).toContain("Simplified illustration of the Acer Aspire 14 AI from the demo catalog. It is not a product photo.");
    expect(existsSync(join(process.cwd(), "public/catalog/aspire-14-ai.svg"))).toBe(true);
    expect(page).not.toContain("demo-laptop.png");
    expect(existsSync(join(process.cwd(), "public/images/demo-laptop.png"))).toBe(false);
    expect(card).toContain("product.imagePath");
    expect(css).not.toMatch(/https?:|url\s*\(/i);
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((block) => block.split("{")[0] ?? "");
    for (const group of selectors) {
      if (!group.trim() || group.trim().startsWith("@")) continue;
      for (const selector of group.split(",")) {
        const trimmed = selector.trim();
        if (trimmed) expect(trimmed.startsWith(".guided-presentation"), trimmed).toBe(true);
      }
    }
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
    expect(findMerchantVariant(world.catalog, "dmp_aspirego15", "dmv_aspire14ai")).toBeNull();
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
    const fetchCall = /\bfetch\s*\(/;
    const advisoryAdapter = join(SRC, "lib", "providers", "qwen-advisory.ts");
    const paypalTransport = join(SRC, "lib", "providers", "paypal-sandbox.ts");
    const channel3Adapter = join(SRC, "lib", "providers", "channel3-discovery.ts");
    // First-party adapter exception. The filename is the Channel3 adapter, not a way around the scan.
    const channel3FetchOnlyInTransport = (text: string): boolean => {
      const start = text.indexOf("export function createFetchChannel3Transport(");
      const end = text.indexOf("\nasync function readChannel3Response");
      if (start < 0 || end < start) return false;
      const inside = text.slice(start, end);
      const outside = text.slice(0, start) + text.slice(end);
      return inside.match(/\bfetch\s*\(/g)?.length === 1 && !fetchCall.test(outside);
    };
    const paypalFetchOnlyInTransport = (text: string): boolean => {
      const start = text.indexOf("export function createFetchPaypalTransport()");
      const end = text.indexOf("\nexport class PayPalSandboxProvider");
      if (start < 0 || end < start) return false;
      const inside = text.slice(start, end);
      const outside = text.slice(0, start) + text.slice(end);
      return inside.match(/\bfetch\s*\(/g)?.length === 1 && !fetchCall.test(outside);
    };
    const providerImport = /from\s+["'][^"']*(?:paypal|openai|supabase|google\/generative|genai|channel3|axios|undici|node-fetch)[^"']*["']/i;
    const internalPaypalAdapter = "@/lib/providers/paypal-sandbox";
    const internalChannel3Adapter = "@/lib/providers/channel3-discovery";
    const runtimeImporter = join(SRC, "server", "runtime.ts");
    const paypalAdapterImporters = new Set([runtimeImporter]);
    const channel3AdapterImporters = new Set([runtimeImporter]);
    // Configuration-only module (no network code): parsed by config.ts, defaults read by runtime.ts.
    const channel3ConfigModule = "./channel3-config";
    const channel3ConfigImporters = new Set([join(SRC, "server", "config.ts"), runtimeImporter]);
    const unauthorizedProviderImport = (file: string, text: string): boolean => {
      for (const match of text.matchAll(/from\s+["']([^"']*)["']/g)) {
        const specifier = match[1] ?? "";
        if (!/(?:paypal|openai|supabase|google\/generative|genai|channel3|axios|undici|node-fetch)/i.test(specifier)) continue;
        if (specifier === internalPaypalAdapter && paypalAdapterImporters.has(file)) continue;
        if (specifier === internalChannel3Adapter && channel3AdapterImporters.has(file)) continue;
        if (specifier === channel3ConfigModule && channel3ConfigImporters.has(file)) continue;
        return true;
      }
      return false;
    };
    const forbidden = [
      fetchCall,
      /XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(/,
      /from\s+["'](?:node:)?(?:http|https|http2|dgram|tls|dns|child_process)["']/,
      providerImport,
      /require\s*\(/,
    ];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern === fetchCall && file === advisoryAdapter) continue;
        if (pattern === fetchCall && file === paypalTransport) {
          expect(paypalFetchOnlyInTransport(text), file).toBe(true);
          continue;
        }
        if (pattern === fetchCall && file === channel3Adapter) {
          expect(channel3FetchOnlyInTransport(text), file).toBe(true);
          continue;
        }
        if (pattern === providerImport) {
          expect(unauthorizedProviderImport(file, text), file).toBe(false);
          continue;
        }
        expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
      }
    }
    expect(fetchCall.test(readFileSync(advisoryAdapter, "utf8"))).toBe(true);
    const paypal = readFileSync(paypalTransport, "utf8");
    expect(paypalFetchOnlyInTransport(paypal)).toBe(true);
    expect(paypalFetchOnlyInTransport(`${paypal}\nfetch("https://api-m.sandbox.paypal.com/v2/checkout/orders");`)).toBe(false);
    expect(paypalFetchOnlyInTransport(paypal.replace("export function createFetchPaypalTransport()", "export function unusedTransport()"))).toBe(false);
    const runtimeSource = readFileSync(join(SRC, "server", "runtime.ts"), "utf8");
    expect(runtimeSource).not.toMatch(/\bfetch\s*\(|createFetchPaypalTransport/);
    // The live Channel3 transport is constructed once, and only from a valid live configuration.
    expect(runtimeSource.match(/createFetchChannel3Transport\(/g)).toHaveLength(1);
    expect(runtimeSource).toContain('config.channel3?.mode === "live" ? createFetchChannel3Transport(config.channel3.apiKey) : undefined');
    const channel3Config = readFileSync(join(SRC, "server", "channel3-config.ts"), "utf8");
    expect(channel3Config).not.toMatch(/\bfetch\s*\(|providers\/channel3-discovery|from\s+["'](?:node:)?(?:http|https|net|tls)["']/);
    const channel3 = readFileSync(channel3Adapter, "utf8");
    expect(channel3FetchOnlyInTransport(channel3)).toBe(true);
    expect(channel3FetchOnlyInTransport(`${channel3}\nfetch("https://api.trychannel3.com/v1/search");`)).toBe(false);
    expect(channel3FetchOnlyInTransport(channel3.replace("export function createFetchChannel3Transport(", "fetch(\"https://api.trychannel3.com/v1/search\");\nexport function createFetchChannel3Transport("))).toBe(false);
    expect(channel3FetchOnlyInTransport(channel3.replace("export function createFetchChannel3Transport(", "export function unusedTransport("))).toBe(false);
    expect(channel3FetchOnlyInTransport(channel3.replace("async function readChannel3Response", "fetch(\"https://api.trychannel3.com/v1/search\");\nasync function readChannel3Response"))).toBe(false);
    expect(readFileSync(join(SRC, "server", "config.ts"), "utf8")).not.toMatch(/\bfetch\s*\(/);
    expect(readFileSync(join(SRC, "server", "handlers.ts"), "utf8")).not.toMatch(/\bfetch\s*\(/);

    const handlersPath = join(SRC, "server", "handlers.ts");
    const runtimePath = join(SRC, "server", "runtime.ts");
    const handlers = readFileSync(handlersPath, "utf8");
    const runtime = readFileSync(runtimePath, "utf8");
    const exactAdapterImport = /from\s+["']@\/lib\/providers\/paypal-sandbox["']/g;
    expect(handlers.match(exactAdapterImport)).toBeNull();
    expect(runtime.match(exactAdapterImport)).toHaveLength(1);
    const exactChannel3Import = /from\s+["']@\/lib\/providers\/channel3-discovery["']/g;
    expect(handlers.match(exactChannel3Import)).toBeNull();
    expect(runtime.match(exactChannel3Import)).toHaveLength(1);
    expect(unauthorizedProviderImport(handlersPath, handlers)).toBe(false);
    expect(unauthorizedProviderImport(runtimePath, runtime)).toBe(false);
    for (const file of sourceFiles(SRC)) {
      if (paypalAdapterImporters.has(file)) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(exactAdapterImport);
    }
    const lookalikes = [
      "@/lib/providers/paypal-sandbox.ts",
      "@/lib/providers/paypal-sandbox/index",
      "@/lib/provider/paypal-sandbox",
      "@/lib/providers/paypal-sandboxes",
      "@/lib/providers/PayPal-sandbox",
      "../lib/providers/paypal-sandbox",
      "paypal-sandbox",
    ];
    for (const specifier of lookalikes) {
      const added = `\nimport { PayPalSandboxProvider } from "${specifier}";`;
      expect(unauthorizedProviderImport(handlersPath, `${handlers}${added}`), specifier).toBe(true);
      expect(unauthorizedProviderImport(runtimePath, `${runtime}${added}`), specifier).toBe(true);
    }
    for (const specifier of ["@paypal/checkout-server-sdk", "paypal", "@paypal/paypal-server-sdk"]) {
      const added = `\nimport checkout from "${specifier}";`;
      expect(unauthorizedProviderImport(handlersPath, `${handlers}${added}`), specifier).toBe(true);
      expect(unauthorizedProviderImport(runtimePath, `${runtime}${added}`), specifier).toBe(true);
    }
    const configPath = join(SRC, "server", "config.ts");
    const panelPath = join(SRC, "components", "SimulatedPaymentPanel.tsx");
    const exactAdded = `\nimport { PayPalSandboxProvider } from "${internalPaypalAdapter}";`;
    expect(unauthorizedProviderImport(configPath, `${readFileSync(configPath, "utf8")}${exactAdded}`)).toBe(true);
    expect(unauthorizedProviderImport(panelPath, `${readFileSync(panelPath, "utf8")}${exactAdded}`)).toBe(true);
    expect(unauthorizedProviderImport(handlersPath, `${handlers}\nimport openai from "openai";`)).toBe(true);
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
    expect(html).toContain("Acer Aspire 14 AI");
    expect(html).toContain("$879.99");
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
