import { MerchantCatalogSchema, type MerchantCatalog, type MerchantProduct, type MerchantVariant } from "./schemas";

/**
 * Manually curated demonstration catalog. Products, prices and the merchant
 * are fictional and exist only for the simulated Sandbox shopping experience.
 * Bump `revision` whenever any record changes.
 */
const DEMO_CATALOG_SOURCE = {
  revision: 1,
  merchant: {
    merchantId: "dmm_shopaccessdemo",
    displayName: "ShopAccess Demo Store (simulated)",
    simulatedSandbox: true,
  },
  products: [
    {
      productId: "dmp_studybook14",
      title: "StudyBook 14",
      description: "A light 14-inch laptop for notes, documents, browsing and video calls.",
      imagePath: "/catalog/studybook-14.svg",
      variants: [
        {
          variantId: "dmv_studybook14a",
          label: "8 GB memory, 256 GB SSD",
          unitAmountCents: 44900,
          currency: "USD",
          maxQuantityPerOrder: 2,
          availability: "IN_STOCK",
          specs: {
            cpu: "4-core mobile processor",
            ramGb: 8,
            storageGb: 256,
            storageType: "SSD",
            screenInches: 14,
            weightKg: 1.4,
            operatingSystem: "Windows 11 Home",
          },
        },
      ],
    },
    {
      productId: "dmp_codebook15",
      title: "CodeBook 15",
      description: "A 15-inch laptop with extra memory and storage for programming coursework.",
      imagePath: "/catalog/codebook-15.svg",
      variants: [
        {
          variantId: "dmv_codebook15a",
          label: "16 GB memory, 512 GB SSD",
          unitAmountCents: 79900,
          currency: "USD",
          maxQuantityPerOrder: 2,
          availability: "IN_STOCK",
          specs: {
            cpu: "8-core mobile processor",
            ramGb: 16,
            storageGb: 512,
            storageType: "SSD",
            screenInches: 15.6,
            weightKg: 1.8,
            operatingSystem: "Windows 11 Home",
          },
        },
        {
          variantId: "dmv_codebook15b",
          label: "32 GB memory, 1 TB SSD",
          unitAmountCents: 109900,
          currency: "USD",
          maxQuantityPerOrder: 1,
          availability: "IN_STOCK",
          specs: {
            cpu: "8-core mobile processor",
            ramGb: 32,
            storageGb: 1024,
            storageType: "SSD",
            screenInches: 15.6,
            weightKg: 1.8,
            operatingSystem: "Windows 11 Home",
          },
        },
      ],
    },
    {
      productId: "dmp_valuebook11",
      title: "ValueBook 11",
      description: "A compact, low-cost laptop for web browsing and light document work.",
      imagePath: "/catalog/valuebook-11.svg",
      variants: [
        {
          variantId: "dmv_valuebook11a",
          label: "4 GB memory, 64 GB eMMC",
          unitAmountCents: 22900,
          currency: "USD",
          maxQuantityPerOrder: 2,
          availability: "IN_STOCK",
          specs: {
            cpu: "2-core entry processor",
            ramGb: 4,
            storageGb: 64,
            storageType: "EMMC",
            screenInches: 11.6,
            weightKg: 1.1,
            operatingSystem: "ChromeOS",
          },
        },
      ],
    },
    {
      productId: "dmp_campusbook16",
      title: "CampusBook 16",
      description: "A large-screen laptop for schoolwork and multitasking at a desk.",
      imagePath: "/catalog/campusbook-16.svg",
      variants: [
        {
          variantId: "dmv_campusbook16a",
          label: "16 GB memory, 512 GB SSD",
          unitAmountCents: 64900,
          currency: "USD",
          maxQuantityPerOrder: 2,
          availability: "OUT_OF_STOCK",
          specs: {
            cpu: "6-core mobile processor",
            ramGb: 16,
            storageGb: 512,
            storageType: "SSD",
            screenInches: 16,
            weightKg: 2.2,
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
