import { MerchantCatalogSchema, type MerchantCatalog } from "../catalog/schemas";
import { err, ok, type Result } from "../shared/result";
import type { PgQueryable } from "./client";
import { APPLICATION_STATEMENTS } from "./statements";

/**
 * The merchant catalog as the database holds it (specification 19.19, decision G2-17).
 *
 * NEVER RUN AGAINST A DATABASE. One joined statement from the reviewed catalogue, sent on every call and never
 * cached here: one statement is one snapshot, so the merchant, its products and their variants are read together.
 * The rows are put together and then checked with the same schema the fixture catalog is checked with. A row set
 * that does not pass is refused whole; there is no partial catalog and no other catalog to fall back on.
 */

export type CatalogReadError =
  | "CATALOG_EMPTY"
  | "CATALOG_ROW_INVALID"
  | "CATALOG_MERCHANTS_MIXED"
  | "CATALOG_REVISIONS_MIXED"
  | "CATALOG_ORDER_INVALID"
  | "CATALOG_INVALID";

type Row = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === "string";
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

interface AssembledVariant {
  variantId: string;
  label: string;
  unitAmountCents: number;
  currency: string;
  maxQuantityPerOrder: number;
  availability: string;
  specs: unknown;
}

interface AssembledProduct {
  productId: string;
  title: string;
  description: string;
  imagePath: string;
  variants: AssembledVariant[];
}

/**
 * Builds a catalog from the rows of the joined statement: one row per variant, ordered by product and variant.
 * Amounts are `integer` columns, so the driver hands them over as numbers; anything else is refused.
 */
export function assembleCatalog(rows: readonly unknown[]): Result<MerchantCatalog, CatalogReadError> {
  if (rows.length === 0) return err("CATALOG_EMPTY");

  let merchant: { merchantId: string; displayName: string; simulatedSandbox: boolean } | null = null;
  let revision: number | null = null;
  const products: AssembledProduct[] = [];
  const seenProducts = new Set<string>();

  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) return err("CATALOG_ROW_INVALID");
    const row = entry as Row;
    const merchantId = row.merchant_id;
    const displayName = row.merchant_display_name;
    const simulatedSandbox = row.merchant_simulated_sandbox;
    const productId = row.product_id;
    const title = row.product_title;
    const description = row.product_description;
    const imagePath = row.product_image_path;
    const productRevision = row.product_catalog_revision;
    const variantId = row.variant_id;
    const label = row.variant_label;
    const unitAmountCents = row.unit_amount_cents;
    const currency = row.currency;
    const maxQuantityPerOrder = row.max_quantity_per_order;
    const availability = row.availability;
    const variantRevision = row.variant_catalog_revision;
    if (
      !isText(merchantId) ||
      !isText(displayName) ||
      typeof simulatedSandbox !== "boolean" ||
      !isText(productId) ||
      !isText(title) ||
      !isText(description) ||
      !isText(imagePath) ||
      !isInteger(productRevision) ||
      !isText(variantId) ||
      !isText(label) ||
      !isInteger(unitAmountCents) ||
      !isText(currency) ||
      !isInteger(maxQuantityPerOrder) ||
      !isText(availability) ||
      !isInteger(variantRevision)
    ) {
      return err("CATALOG_ROW_INVALID");
    }

    if (merchant === null) merchant = { merchantId, displayName, simulatedSandbox };
    else if (merchant.merchantId !== merchantId || merchant.displayName !== displayName || merchant.simulatedSandbox !== simulatedSandbox) {
      return err("CATALOG_MERCHANTS_MIXED");
    }

    // One revision for the whole catalog: a product or a variant at another revision is not shown beside the rest.
    if (revision === null) revision = productRevision;
    if (productRevision !== revision || variantRevision !== revision) return err("CATALOG_REVISIONS_MIXED");

    let product = products.at(-1);
    if (!product || product.productId !== productId) {
      // The statement orders its rows by product, so a product's rows are together.
      if (seenProducts.has(productId)) return err("CATALOG_ORDER_INVALID");
      seenProducts.add(productId);
      product = { productId, title, description, imagePath, variants: [] };
      products.push(product);
    } else if (product.title !== title || product.description !== description || product.imagePath !== imagePath) {
      return err("CATALOG_ROW_INVALID");
    }
    product.variants.push({ variantId, label, unitAmountCents, currency, maxQuantityPerOrder, availability, specs: row.specs });
  }

  if (merchant === null || revision === null) return err("CATALOG_EMPTY");
  const parsed = MerchantCatalogSchema.safeParse({ revision, merchant, products });
  return parsed.success ? ok(parsed.data) : err("CATALOG_INVALID");
}

/** Sends the joined catalog statement once and builds the catalog from its rows. A database error is thrown. */
export async function readCatalog(db: PgQueryable): Promise<Result<MerchantCatalog, CatalogReadError>> {
  const reply = await db.query(APPLICATION_STATEMENTS.readCatalog);
  return assembleCatalog(reply.rows);
}
