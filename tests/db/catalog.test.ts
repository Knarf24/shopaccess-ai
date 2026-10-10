import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { adminUrl, openDisposableDatabase, type DisposableDatabase } from "./harness";

// NEVER RUN (Gate B-X not authorized).
describe.skipIf(!adminUrl())("PGT-84: seeded catalog rows equal the code fixture", () => {
  let db: DisposableDatabase;
  beforeAll(async () => {
    db = await openDisposableDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("matches the fixture field by field, read as the web role", async () => {
    const catalog = DEMO_MERCHANT_CATALOG;
    const merchants = await db.web.query("SELECT id, display_name, is_simulated_sandbox FROM shopaccess.merchants");
    expect(merchants.rows).toEqual([
      { id: catalog.merchant.merchantId, display_name: catalog.merchant.displayName, is_simulated_sandbox: true },
    ]);

    const products = await db.web.query(
      "SELECT id, merchant_id, title, description, image_path, catalog_revision FROM shopaccess.merchant_products ORDER BY id",
    );
    expect(products.rows).toEqual(
      [...catalog.products]
        .sort((left, right) => (left.productId < right.productId ? -1 : 1))
        .map((product) => ({
          id: product.productId,
          merchant_id: catalog.merchant.merchantId,
          title: product.title,
          description: product.description,
          image_path: product.imagePath,
          catalog_revision: catalog.revision,
        })),
    );

    const variants = await db.web.query(
      "SELECT id, product_id, label, unit_amount_cents, currency, max_quantity_per_order, availability, specs, catalog_revision FROM shopaccess.merchant_variants ORDER BY id",
    );
    const expected = catalog.products
      .flatMap((product) =>
        product.variants.map((variant) => ({
          id: variant.variantId,
          product_id: product.productId,
          label: variant.label,
          unit_amount_cents: variant.unitAmountCents,
          currency: variant.currency,
          max_quantity_per_order: variant.maxQuantityPerOrder,
          availability: variant.availability,
          specs: variant.specs,
          catalog_revision: catalog.revision,
        })),
      )
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    expect(variants.rows).toEqual(expected);
  });

  it("no CHECK constraint names a revision number, and another positive revision is accepted", async () => {
    const checks = await db.admin.query(
      `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_catalog.pg_constraint c
         JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'shopaccess' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%catalog_revision%'`,
    );
    for (const row of checks.rows) expect(String(row.definition)).toMatch(/catalog_revision > 0/);

    await db.admin.query("BEGIN");
    try {
      await db.admin.query("UPDATE shopaccess.merchant_products SET catalog_revision = 2");
      await db.admin.query("UPDATE shopaccess.merchant_variants SET catalog_revision = 7");
    } finally {
      await db.admin.query("ROLLBACK");
    }
  });
});
