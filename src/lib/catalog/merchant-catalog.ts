import { MerchantCatalogSchema, type MerchantCatalog, type MerchantProduct, type MerchantVariant } from "./schemas";

/**
 * Manually curated demonstration catalog. Revision 2 replaces the fictional
 * placeholders with three researched configurations. Amounts are the October 15,
 * 2026 reference prices, stored as fixed demo prices. The Aspire Go amount is
 * that day's sale price. The regular price from the same research is recorded
 * in the catalog note. These are not a guaranteed current offer, and the units
 * were not inspected. Inventory is simulated. Acer, ASUS, Newegg, and their
 * sellers are not ShopAccess partners. Product text keeps the model and part
 * number. Prices, partnership, and fulfillment are rendered from the shop
 * notices and the structured amounts.
 * Bump `revision` whenever any record changes.
 *
 * The Increment 1 SQL seed remains the checksum-pinned revision 1 placeholder
 * catalog. This fixture is what the in-memory shop sells.
 */
const DEMO_CATALOG_SOURCE = {
  revision: 2,
  merchant: {
    merchantId: "dmm_shopaccessdemo",
    displayName: "ShopAccess Demo Store (simulated)",
    simulatedSandbox: true,
  },
  products: [
    {
      productId: "dmp_aspirego15",
      title: "Acer Aspire Go 15",
      description: "Model AG15-21PT-R9TL, part NX.JJJAA.008. 1920 × 1080 IPS touchscreen.",
      imagePath: "/catalog/aspire-go-15.svg",
      variants: [
        {
          variantId: "dmv_aspirego15",
          label: "8 GB LPDDR5, 256 GB PCIe NVMe SSD",
          unitAmountCents: 57999,
          currency: "USD",
          maxQuantityPerOrder: 2,
          availability: "IN_STOCK",
          specs: {
            cpu: "AMD Ryzen 3 30, 4 cores",
            ramGb: 8,
            storageGb: 256,
            storageType: "SSD",
            screenInches: 15.6,
            weightKg: 1.73,
            operatingSystem: "Windows 11 Home",
          },
        },
      ],
    },
    {
      productId: "dmp_aspire14ai",
      title: "Acer Aspire 14 AI",
      description: "Model A14-52M-51S1, part NX.J8LAA.002. 1920 × 1200 IPS display.",
      imagePath: "/catalog/aspire-14-ai.svg",
      variants: [
        {
          variantId: "dmv_aspire14ai",
          label: "16 GB LPDDR5X, 512 GB PCIe NVMe SSD",
          unitAmountCents: 87999,
          currency: "USD",
          maxQuantityPerOrder: 2,
          availability: "IN_STOCK",
          specs: {
            cpu: "Intel Core Ultra 5 226V, 8 cores",
            ramGb: 16,
            storageGb: 512,
            storageType: "SSD",
            screenInches: 14,
            weightKg: 1.4,
            operatingSystem: "Windows 11 Home",
          },
        },
      ],
    },
    {
      productId: "dmp_vivobook16",
      title: "ASUS Vivobook 16",
      description: "Model F1605VA-DS74, part 90NB10N3-M004M0. 1920 × 1200 non-touch display.",
      imagePath: "/catalog/vivobook-16.svg",
      variants: [
        {
          variantId: "dmv_vivobook16",
          label: "16 GB DDR4, 1 TB PCIe NVMe SSD",
          unitAmountCents: 99900,
          currency: "USD",
          maxQuantityPerOrder: 2,
          availability: "IN_STOCK",
          specs: {
            cpu: "Intel Core i7-13700H, 14 cores",
            ramGb: 16,
            storageGb: 1024,
            storageType: "SSD",
            screenInches: 16,
            weightKg: 1.88,
            operatingSystem: "Windows 11 Home",
          },
        },
      ],
    },
  ],
};

export const DEMO_MERCHANT_CATALOG: MerchantCatalog = MerchantCatalogSchema.parse(DEMO_CATALOG_SOURCE);

export interface MerchantCatalogEntry {
  readonly product: MerchantProduct;
  readonly variant: MerchantVariant;
}

/**
 * Exact-match lookup by internal IDs. There is deliberately no fuzzy matching
 * and no path from an external discovery record to a merchant record.
 */
export function findMerchantVariant(
  catalog: MerchantCatalog,
  productId: string,
  variantId: string,
): MerchantCatalogEntry | null {
  const product = catalog.products.find((candidate) => candidate.productId === productId);
  const variant = product?.variants.find((candidate) => candidate.variantId === variantId);
  return product && variant ? { product, variant } : null;
}

export function formatUsd(amountCents: number): string {
  const dollars = Math.trunc(amountCents / 100);
  const cents = Math.abs(amountCents % 100);
  return `$${dollars.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}
