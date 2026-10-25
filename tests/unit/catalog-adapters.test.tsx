import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MerchantProductCard } from "@/components/MerchantProductCard";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { MerchantCatalogSchema, type MerchantCatalog } from "@/lib/catalog/schemas";
import { createMockAdvisoryAi, suggestProductsSafely, type AdvisoryAiProvider, type EligibleAdvisoryProduct } from "@/lib/providers/ai";
import { evidenceFromMerchantVariant } from "@/lib/readiness/engine";
import { parsePermissionForm } from "@/server/permission-form";
import { createQuote, verifyQuote } from "@/lib/quote/quote";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { buildPgShoppingView } from "@/server/pg-views";
import type { PgServices } from "@/server/pg-runtime";
import { createRuntime } from "@/server/runtime";
import { buildShoppingView, recommendConfirmedNeeds, parsePreferences } from "@/server/shopping";
import { TEST_SESSION_KEY, createWorld, newSession, quotedIntent } from "./helpers";

// Synthetic catalog identity only. No manufacturer claim or real accessory is curated.
const adapter = {
  productId: "dmp_testadapter", title: "Synthetic adapter", description: "Synthetic catalog isolation fixture",
  imagePath: "/catalog/test-adapter.svg",
  variants: [{
    kind: "charger_adapter", variantId: "dmv_testadapter", label: "Synthetic adapter",
    unitAmountCents: 1000, currency: "USD", maxQuantityPerOrder: 1, availability: "IN_STOCK",
    specs: { evidenceChargerId: "synthetic-adapter" },
  }],
};
const mixed = () => ({ ...structuredClone(DEMO_MERCHANT_CATALOG), products: [...structuredClone(DEMO_MERCHANT_CATALOG.products), structuredClone(adapter)] });
const unchecked = () => mixed() as unknown as MerchantCatalog;
const now = new Date("2026-10-25T12:00:00Z");
const prefs = parsePreferences("schoolwork", "600")!;

describe("synthetic adapter catalog groundwork", () => {
  it("represents an adapter without fictitious laptop specifications", () => {
    expect(MerchantCatalogSchema.safeParse(mixed()).success).toBe(true);
  });
  it("rejects unknown kinds, missing evidence identities and mixed laptop/adapter products", () => {
    for (const change of [
      (v: typeof adapter.variants[number]) => { v.kind = "unknown"; },
      (v: typeof adapter.variants[number]) => { v.specs.evidenceChargerId = ""; },
    ]) {
      const c = mixed(); change(c.products[3].variants[0] as typeof adapter.variants[number]);
      expect(MerchantCatalogSchema.safeParse(c).success).toBe(false);
    }
    const c = mixed();
    c.products[0].variants.push(adapter.variants[0] as never);
    c.products.pop(); // Keep IDs unique: isolate the mixed-kind guard.
    expect(MerchantCatalogSchema.safeParse(c).success).toBe(false);
  });
  it("does not derive laptop readiness evidence for an adapter", () => {
    expect(evidenceFromMerchantVariant(adapter.variants[0] as never, 2, now)).toEqual([]);
  });
  it("does not render a laptop card for an adapter", () => {
    expect(renderToStaticMarkup(<MerchantProductCard product={adapter as never} merchantName="Synthetic merchant" />)).toBe("");
  });
  it("accepts explicit laptop kinds without changing existing specs", () => {
    const c = structuredClone(DEMO_MERCHANT_CATALOG);
    c.products[0].variants[0].kind = "laptop";
    expect(MerchantCatalogSchema.safeParse(c).success).toBe(true);
  });
  it("rejects adapter facts without an adapter discriminator or alongside laptop specs", () => {
    const c = mixed();
    delete (c.products[3].variants[0] as { kind?: string }).kind;
    expect(MerchantCatalogSchema.safeParse(c).success).toBe(false);
    const hybrid = mixed();
    Object.assign(hybrid.products[3].variants[0].specs, DEMO_MERCHANT_CATALOG.products[0].variants[0].specs);
    expect(MerchantCatalogSchema.safeParse(hybrid).success).toBe(false);
  });
  it("refuses adapter permission forms before purchasing is implemented", () => {
    expect(parsePermissionForm({ item: "dmp_testadapter:dmv_testadapter", quantity: "1", total: "10.00", expiry: "15m" }, unchecked())).toMatchObject({ ok: false, code: "ITEM_INVALID" });
  });
  it("keeps legacy and guided laptop results identical in mixed evidence", async () => {
    const base = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins(["https://shop.example.test"]) }, { clock: () => now });
    const withAdapter = { ...base, catalog: unchecked() };
    const baseline = await buildShoppingView(base, prefs, "synthetic-session");
    const actual = await buildShoppingView(withAdapter, prefs, "synthetic-session");
    expect(actual).toEqual(baseline);
    expect(actual.variants).toHaveLength(3);
    expect(await recommendConfirmedNeeds(withAdapter, prefs)).toEqual(await recommendConfirmedNeeds(base, prefs));
  });
  it("omits adapter input and rejects adapter references even when returned by a provider", async () => {
    let sent: unknown;
    const provider: AdvisoryAiProvider = {
      ...createMockAdvisoryAi(),
      async suggestProducts(request) {
        sent = request;
        return { message: "Synthetic response", references: [{ productId: adapter.productId, variantId: adapter.variants[0].variantId }] };
      },
    };
    const result = await suggestProductsSafely(provider, unchecked(), "Schoolwork");
    expect(JSON.stringify(sent)).not.toContain("testadapter");
    expect(result).toEqual({ ok: false, error: "INVENTED_REFERENCE" });
  });
  it("filters adapters from a supplied suitability payload before calling the provider", async () => {
    let sent: unknown;
    const laptop = DEMO_MERCHANT_CATALOG.products[0];
    const eligible: EligibleAdvisoryProduct = {
      productId: laptop.productId, variantId: laptop.variants[0].variantId,
      title: laptop.title, description: laptop.description,
      unitAmountCents: 57999, currency: "USD", availability: "IN_STOCK",
      ramGb: 8, storageGb: 256, weightKg: 1.73, assessmentStatus: "READY", assessmentFactors: [],
    };
    const forgedAdapter = { ...eligible, productId: adapter.productId, variantId: adapter.variants[0].variantId };
    const provider: AdvisoryAiProvider = {
      ...createMockAdvisoryAi(),
      async suggestProducts(request) {
        sent = request;
        return { message: "Synthetic response", references: [{ productId: eligible.productId, variantId: eligible.variantId }] };
      },
    };
    const result = await suggestProductsSafely(provider, unchecked(), "Schoolwork", undefined, {
      intendedUse: "schoolwork", budgetCents: 60000, products: [eligible, forgedAdapter],
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("testadapter");
    expect(sent).toMatchObject({ untrustedData: { products: [eligible] } });
  });
  it("excludes adapters from PostgreSQL-mode presentation without contacting a database", async () => {
    // A catalog service double only; no PostgreSQL client is constructed or called.
    const services = (catalog: MerchantCatalog) => ({
      catalog: async () => ({ ok: true, value: catalog }), clock: () => now,
      ai: createMockAdvisoryAi(), discovery: createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins(["https://shop.example.test"]) }).discovery,
    }) as unknown as PgServices;
    const base = await buildPgShoppingView(services(DEMO_MERCHANT_CATALOG), prefs);
    const actual = await buildPgShoppingView(services(unchecked()), prefs);
    expect(base.kind).toBe("OK");
    expect(actual).toEqual(base);
    expect(JSON.stringify(actual)).not.toContain("testadapter");
  });
  it("cannot create an adapter quote before purchase eligibility is implemented", () => {
    expect(createQuote({
      catalog: unchecked(), now, sessionId: "synthetic", checkoutIntentId: "synthetic",
      ids: createWorld().ids,
      request: { productId: adapter.productId, variantId: adapter.variants[0].variantId, quantity: 1 },
    })).toEqual({ ok: false, error: "PRODUCT_NOT_IN_MERCHANT_CATALOG" });
  });
  it("refuses an old laptop quote if that identity becomes an adapter at the same catalog revision", async () => {
    const world = createWorld(); const session = await newSession(world);
    const { quote } = await quotedIntent(world, session.session.id);
    const c = structuredClone(DEMO_MERCHANT_CATALOG);
    const product = c.products.find(p => p.productId === quote.productId)!;
    product.variants = [{ ...adapter.variants[0], variantId: quote.variantId, unitAmountCents: quote.unitAmountCents, maxQuantityPerOrder: 2 }] as never;
    expect(verifyQuote(quote, { catalog: c, sessionId: session.session.id, now: world.time.clock() })).toEqual({ ok: false, error: "QUOTE_STALE_CATALOG" });
  });
});
