import { z } from "zod";
import { parseSafeExternalUrl } from "./url";

export const MERCHANT_PRODUCT_ID_PATTERN = /^dmp_[a-z0-9]{6,24}$/;
export const MERCHANT_VARIANT_ID_PATTERN = /^dmv_[a-z0-9]{6,24}$/;
export const MERCHANT_ID_PATTERN = /^dmm_[a-z0-9]{6,24}$/;
/** External discovery IDs use a prefix that can never match a merchant ID pattern. */
export const EXTERNAL_PRODUCT_ID_PATTERN = /^ext_[A-Za-z0-9_-]{1,64}$/;

export const MAX_UNIT_AMOUNT_CENTS = 2_000_000;
export const MAX_QUANTITY_LIMIT = 10;

// Plain text only: control characters are rejected. Markup is not stripped
// here; it is stored as text and rendered inert by the UI layer.
const NO_CONTROL_CHARACTERS = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

const plainText = (max: number) =>
  z.string().trim().min(1).max(max).regex(NO_CONTROL_CHARACTERS, "Control characters are not allowed");

export const CurrencySchema = z.literal("USD");
export const AmountCentsSchema = z.number().int().positive().max(MAX_UNIT_AMOUNT_CENTS);
export const AvailabilitySchema = z.enum(["IN_STOCK", "OUT_OF_STOCK", "DISCONTINUED"]);

export const LaptopSpecsSchema = z.strictObject({
  cpu: plainText(80),
  ramGb: z.number().int().positive().max(512),
  storageGb: z.number().int().positive().max(16_384),
  storageType: z.enum(["SSD", "HDD", "EMMC"]),
  screenInches: z.number().positive().max(30),
  weightKg: z.number().positive().max(10),
  operatingSystem: plainText(60),
});

const VariantFields = {
  variantId: z.string().regex(MERCHANT_VARIANT_ID_PATTERN),
  label: plainText(80),
  unitAmountCents: AmountCentsSchema,
  currency: CurrencySchema,
  maxQuantityPerOrder: z.number().int().min(1).max(MAX_QUANTITY_LIMIT),
  availability: AvailabilitySchema,
};

export const LaptopMerchantVariantSchema = z.strictObject({
  ...VariantFields,
  // Missing kind is the existing curated and PostgreSQL representation.
  kind: z.literal("laptop").optional(),
  specs: LaptopSpecsSchema,
});

export const AdapterMerchantVariantSchema = z.strictObject({
  ...VariantFields,
  kind: z.literal("charger_adapter"),
  // An identity reference only: neither specifications nor permission to purchase.
  specs: z.strictObject({ evidenceChargerId: plainText(80).regex(/^[A-Za-z0-9_-]+$/) }),
});

export const MerchantVariantSchema = z.union([LaptopMerchantVariantSchema, AdapterMerchantVariantSchema]);

export const MerchantProductSchema = z.strictObject({
  productId: z.string().regex(MERCHANT_PRODUCT_ID_PATTERN),
  title: plainText(120),
  description: plainText(600),
  /** Local, curated asset only. Remote image URLs are not accepted for the merchant catalog. */
  imagePath: z.string().regex(/^\/catalog\/[a-z0-9-]{1,64}\.svg$/),
  variants: z.array(MerchantVariantSchema).min(1).max(6),
});

export const MerchantSchema = z.strictObject({
  merchantId: z.string().regex(MERCHANT_ID_PATTERN),
  displayName: plainText(80),
  /** The demo merchant is always a simulated Sandbox seller. */
  simulatedSandbox: z.literal(true),
});

export const MerchantCatalogSchema = z
  .strictObject({
    revision: z.number().int().positive(),
    merchant: MerchantSchema,
    products: z.array(MerchantProductSchema).min(3).max(5),
  })
  .superRefine((catalog, ctx) => {
    const productIds = new Set<string>();
    const variantIds = new Set<string>();
    for (const product of catalog.products) {
      if (productIds.has(product.productId)) ctx.addIssue({ code: "custom", message: "Duplicate product ID" });
      productIds.add(product.productId);
      const kinds = new Set(product.variants.map((variant) => variant.kind ?? "laptop"));
      if (kinds.size !== 1) ctx.addIssue({ code: "custom", message: "A product cannot mix laptop and adapter variants" });
      for (const variant of product.variants) {
        if (variantIds.has(variant.variantId)) ctx.addIssue({ code: "custom", message: "Duplicate variant ID" });
        variantIds.add(variant.variantId);
      }
    }
  });

const SafeExternalUrlSchema = z.unknown().transform((value, ctx) => {
  const parsed = parseSafeExternalUrl(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: `Unsafe URL: ${parsed.error}` });
    return z.NEVER;
  }
  return parsed.value;
});

/** A record from product discovery (Channel3 or a mock). Every field is untrusted. */
export const ExternalProductSchema = z.strictObject({
  externalId: z.string().regex(EXTERNAL_PRODUCT_ID_PATTERN),
  source: z.enum(["mock_discovery", "channel3"]),
  sellerLabel: plainText(80),
  title: plainText(200),
  description: plainText(1000),
  url: SafeExternalUrlSchema,
  /** Indicative only. Never used for quotes or payment. */
  listedPrice: z.strictObject({ amountCents: AmountCentsSchema, currency: CurrencySchema }).optional(),
  retrievedAt: z.iso.datetime(),
});

export type Availability = z.infer<typeof AvailabilitySchema>;
export type LaptopSpecs = z.infer<typeof LaptopSpecsSchema>;
export type MerchantVariant = z.infer<typeof MerchantVariantSchema>;
export type MerchantProduct = z.infer<typeof MerchantProductSchema>;
export type Merchant = z.infer<typeof MerchantSchema>;
export type MerchantCatalog = z.infer<typeof MerchantCatalogSchema>;
export type ExternalProduct = z.infer<typeof ExternalProductSchema>;

export type LaptopMerchantVariant = z.infer<typeof LaptopMerchantVariantSchema>;

/** Narrow validated catalog records; unknown kinds never enter a laptop path. */
export function isLaptopVariant(variant: MerchantVariant): variant is LaptopMerchantVariant {
  return variant.kind === undefined || variant.kind === "laptop";
}

/** Laptop-only projection for listing and advisory paths. Keeps original laptop records intact. */
export function laptopProducts(catalog: MerchantCatalog): (Omit<MerchantProduct, "variants"> & { variants: LaptopMerchantVariant[] })[] {
  return catalog.products.filter((product) => product.variants.every(isLaptopVariant)).map((product) => ({
    ...product, variants: product.variants.filter(isLaptopVariant),
  }));
}
