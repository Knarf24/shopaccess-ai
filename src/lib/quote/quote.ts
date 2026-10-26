import { isDemoCharger } from "../catalog/charger-purchase";
import { z } from "zod";
import { findMerchantVariant } from "../catalog/merchant-catalog";
import {
  isLaptopVariant,
  MAX_QUANTITY_LIMIT,
  MERCHANT_ID_PATTERN,
  MERCHANT_PRODUCT_ID_PATTERN,
  MERCHANT_VARIANT_ID_PATTERN,
  type MerchantCatalog,
} from "../catalog/schemas";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/crypto";
import { ID_PATTERNS, type IdGenerator } from "../shared/ids";
import { err, ok, type Result } from "../shared/result";

export const QUOTE_TTL_MS = 15 * 60 * 1000;

/** Zero tax and shipping are assumptions of the Sandbox demonstration, not real-world amounts. */
export const SANDBOX_ASSUMPTIONS = {
  tax: "SANDBOX_DEMO_ZERO_TAX_ASSUMPTION",
  shipping: "SANDBOX_DEMO_ZERO_SHIPPING_NO_FULFILLMENT",
  discount: "SANDBOX_DEMO_NO_DISCOUNTS",
} as const;

const cents = z.number().int().nonnegative().refine(Number.isSafeInteger);

/**
 * The only fields a client may supply. The object is strict, so any attempt to
 * send a price, total, currency or merchant is rejected outright.
 */
export const QuoteRequestSchema = z.strictObject({
  productId: z.string().regex(MERCHANT_PRODUCT_ID_PATTERN),
  variantId: z.string().regex(MERCHANT_VARIANT_ID_PATTERN),
  quantity: z.number().int().min(1).max(MAX_QUANTITY_LIMIT),
});

const QuoteBodySchema = z.strictObject({
  quoteId: z.string().regex(ID_PATTERNS.quote),
  sessionId: z.string().regex(ID_PATTERNS.session),
  checkoutIntentId: z.string().regex(ID_PATTERNS.checkoutIntent),
  merchantId: z.string().regex(MERCHANT_ID_PATTERN),
  productId: z.string().regex(MERCHANT_PRODUCT_ID_PATTERN),
  variantId: z.string().regex(MERCHANT_VARIANT_ID_PATTERN),
  catalogRevision: z.number().int().positive(),
  quantity: z.number().int().min(1).max(MAX_QUANTITY_LIMIT),
  unitAmountCents: cents.positive(),
  subtotalCents: cents,
  discountCents: z.literal(0),
  taxCents: z.literal(0),
  shippingCents: z.literal(0),
  totalCents: cents.positive(),
  currency: z.literal("USD"),
  assumptions: z.strictObject({
    tax: z.literal(SANDBOX_ASSUMPTIONS.tax),
    shipping: z.literal(SANDBOX_ASSUMPTIONS.shipping),
    discount: z.literal(SANDBOX_ASSUMPTIONS.discount),
  }),
  chargerDraftId: z.string().min(1).max(80).optional(),
  chargerRevision: z.number().int().positive().optional(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const QuoteSchema = QuoteBodySchema.extend({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).superRefine((quote, ctx) => {
  if (quote.subtotalCents !== quote.unitAmountCents * quote.quantity) {
    ctx.addIssue({ code: "custom", message: "Subtotal does not equal unit amount times quantity" });
  }
  if (quote.totalCents !== quote.subtotalCents - quote.discountCents + quote.taxCents + quote.shippingCents) {
    ctx.addIssue({ code: "custom", message: "Total does not equal subtotal - discount + tax + shipping" });
  }
  if (Date.parse(quote.expiresAt) - Date.parse(quote.createdAt) !== QUOTE_TTL_MS) {
    ctx.addIssue({ code: "custom", message: "Quote lifetime is not the fixed TTL" });
  }
});

export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;
export type Quote = Readonly<z.infer<typeof QuoteSchema>>;

export function computeQuoteDigest(body: Omit<Quote, "digest">): string {
  return sha256Hex(canonicalJson(body));
}

export type QuoteRejection =
  | "REQUEST_INVALID"
  | "PRODUCT_NOT_IN_MERCHANT_CATALOG"
  | "VARIANT_UNAVAILABLE"
  | "QUANTITY_EXCEEDS_LIMIT"
  | "AMOUNT_OUT_OF_RANGE";

export interface CreateQuoteInput {
  readonly sessionId: string;
  readonly checkoutIntentId: string;
  /** Untrusted client input. */
  readonly request: unknown;
  readonly catalog: MerchantCatalog;
  readonly now: Date;
  readonly ids: IdGenerator;
  readonly chargerBinding?: { readonly chargerDraftId: string; readonly chargerRevision: number };
}

/** Builds an immutable quote entirely from server-side catalog data. */
export function createQuote(input: CreateQuoteInput): Result<Quote, QuoteRejection> {
  const request = QuoteRequestSchema.safeParse(input.request);
  if (!request.success) return err("REQUEST_INVALID");

  const entry = findMerchantVariant(input.catalog, request.data.productId, request.data.variantId);
  // Adapter representation is groundwork only; no accessory purchase policy exists yet.
  if (!entry || (!isLaptopVariant(entry.variant) && !(isDemoCharger(input.catalog, request.data.productId, request.data.variantId) && input.chargerBinding))) return err("PRODUCT_NOT_IN_MERCHANT_CATALOG");
  if (entry.variant.availability !== "IN_STOCK") return err("VARIANT_UNAVAILABLE");
  if (request.data.quantity > entry.variant.maxQuantityPerOrder) return err("QUANTITY_EXCEEDS_LIMIT");

  const subtotalCents = entry.variant.unitAmountCents * request.data.quantity;
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents <= 0) return err("AMOUNT_OUT_OF_RANGE");

  const body: Omit<Quote, "digest"> = {
    ...(!isLaptopVariant(entry.variant) ? input.chargerBinding : {}),
    quoteId: input.ids("quote"),
    sessionId: input.sessionId,
    checkoutIntentId: input.checkoutIntentId,
    merchantId: input.catalog.merchant.merchantId,
    productId: entry.product.productId,
    variantId: entry.variant.variantId,
    catalogRevision: input.catalog.revision,
    quantity: request.data.quantity,
    unitAmountCents: entry.variant.unitAmountCents,
    subtotalCents,
    discountCents: 0,
    taxCents: 0,
    shippingCents: 0,
    totalCents: subtotalCents,
    currency: entry.variant.currency,
    assumptions: { ...SANDBOX_ASSUMPTIONS },
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + QUOTE_TTL_MS).toISOString(),
  };
  const quote = { ...body, digest: computeQuoteDigest(body) };
  Object.freeze(quote.assumptions);
  return ok(Object.freeze(quote));
}

export type QuoteVerificationFailure =
  | "QUOTE_MALFORMED"
  | "QUOTE_DIGEST_MISMATCH"
  | "QUOTE_NOT_OWNED"
  | "QUOTE_EXPIRED"
  | "QUOTE_STALE_CATALOG";

export interface VerifyQuoteContext {
  readonly sessionId: string;
  readonly catalog: MerchantCatalog;
  readonly now: Date;
}

/**
 * Re-checks a stored quote before it is relied on. Fails closed on tampering,
 * wrong owner, expiry, or any material change to the variant since quoting.
 */
export function verifyQuote(candidate: unknown, context: VerifyQuoteContext): Result<Quote, QuoteVerificationFailure> {
  const parsed = QuoteSchema.safeParse(candidate);
  if (!parsed.success) return err("QUOTE_MALFORMED");
  const { digest, ...body } = parsed.data;
  if (computeQuoteDigest(body) !== digest) return err("QUOTE_DIGEST_MISMATCH");
  if (body.sessionId !== context.sessionId) return err("QUOTE_NOT_OWNED");
  if (context.now.getTime() >= Date.parse(body.expiresAt)) return err("QUOTE_EXPIRED");

  const entry = findMerchantVariant(context.catalog, body.productId, body.variantId);
  const unchanged =
    entry !== null &&
    (isLaptopVariant(entry.variant) || (isDemoCharger(context.catalog, body.productId, body.variantId) && body.chargerDraftId !== undefined && body.chargerRevision !== undefined)) &&
    context.catalog.merchant.merchantId === body.merchantId &&
    entry.variant.unitAmountCents === body.unitAmountCents &&
    entry.variant.currency === body.currency &&
    entry.variant.availability === "IN_STOCK" &&
    entry.variant.maxQuantityPerOrder >= body.quantity;
  if (!unchanged) return err("QUOTE_STALE_CATALOG");

  return ok(Object.freeze(parsed.data));
}
