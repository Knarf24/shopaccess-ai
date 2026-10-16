import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { adminUrl, openDisposableDatabase, type DisposableDatabase } from "./harness";

// The disposable Increment 1 clusters applied this seed. The application fixture is now revision 2.
// This test, when a database run is separately authorized, checks the applied seed, not that fixture.
describe.skipIf(!adminUrl())("PGT-84: seeded catalog rows remain the Increment 1 placeholder catalog", () => {
  let db: DisposableDatabase;
  beforeAll(async () => {
    db = await openDisposableDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("matches the Increment 1 seed, which is not the revision 2 application fixture", async () => {
    const merchants = await db.web.query("SELECT id, display_name, is_simulated_sandbox FROM shopaccess.merchants");
    expect(merchants.rows).toEqual([
      { id: "dmm_shopaccessdemo", display_name: "ShopAccess Demo Store (simulated)", is_simulated_sandbox: true },
    ]);

    const products = await db.web.query(
      "SELECT id, title, image_path, catalog_revision FROM shopaccess.merchant_products ORDER BY id",
    );
    expect(products.rows).toEqual([
      { id: "dmp_campusbook16", title: "CampusBook 16", image_path: "/catalog/campusbook-16.svg", catalog_revision: 1 },
      { id: "dmp_codebook15", title: "CodeBook 15", image_path: "/catalog/codebook-15.svg", catalog_revision: 1 },
      { id: "dmp_studybook14", title: "StudyBook 14", image_path: "/catalog/studybook-14.svg", catalog_revision: 1 },
      { id: "dmp_valuebook11", title: "ValueBook 11", image_path: "/catalog/valuebook-11.svg", catalog_revision: 1 },
    ]);

    const variants = await db.web.query(
      "SELECT id, product_id, unit_amount_cents, availability, catalog_revision FROM shopaccess.merchant_variants ORDER BY id",
    );
    expect(variants.rows).toEqual([
      { id: "dmv_campusbook16a", product_id: "dmp_campusbook16", unit_amount_cents: 64900, availability: "OUT_OF_STOCK", catalog_revision: 1 },
      { id: "dmv_codebook15a", product_id: "dmp_codebook15", unit_amount_cents: 79900, availability: "IN_STOCK", catalog_revision: 1 },
      { id: "dmv_codebook15b", product_id: "dmp_codebook15", unit_amount_cents: 109900, availability: "IN_STOCK", catalog_revision: 1 },
      { id: "dmv_studybook14a", product_id: "dmp_studybook14", unit_amount_cents: 44900, availability: "IN_STOCK", catalog_revision: 1 },
      { id: "dmv_valuebook11a", product_id: "dmp_valuebook11", unit_amount_cents: 22900, availability: "IN_STOCK", catalog_revision: 1 },
    ]);
    expect(DEMO_MERCHANT_CATALOG.revision).toBe(2);
    expect(DEMO_MERCHANT_CATALOG.products.map((product) => product.productId)).not.toEqual(products.rows.map((row) => row.id));
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
