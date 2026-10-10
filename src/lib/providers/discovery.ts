import { ExternalProductSchema, type ExternalProduct } from "../catalog/schemas";

export interface DiscoveryResult {
  readonly products: readonly ExternalProduct[];
  /** Number of provider records dropped because they failed validation. */
  readonly rejectedCount: number;
}

export interface ProductDiscoveryProvider {
  search(query: string): Promise<DiscoveryResult>;
}

/** Validates untrusted discovery records, dropping any that fail. */
export function validateExternalRecords(records: readonly unknown[]): DiscoveryResult {
  const products: ExternalProduct[] = [];
  let rejectedCount = 0;
  for (const record of records) {
    const parsed = ExternalProductSchema.safeParse(record);
    if (parsed.success) products.push(parsed.data);
    else rejectedCount += 1;
  }
  return { products, rejectedCount };
}

export const MOCK_DISCOVERY_RECORDS: readonly unknown[] = [
  {
    externalId: "ext_mock-aurora-13",
    source: "mock_discovery",
    sellerLabel: "Example Electronics (external seller)",
    title: "Aurora 13 Ultralight",
    description: "13-inch ultralight laptop listed by an external seller. Details are unverified.",
    url: "https://shop.example.com/laptops/aurora-13",
    listedPrice: { amountCents: 59900, currency: "USD" },
    retrievedAt: "2026-10-01T12:00:00.000Z",
  },
  {
    externalId: "ext_mock-granite-15",
    source: "mock_discovery",
    sellerLabel: "Sample Computers (external seller)",
    title: "Granite 15 Workstation",
    description: "15-inch laptop listed by an external seller. Details are unverified.",
    url: "https://store.example.org/granite-15",
    retrievedAt: "2026-10-01T12:00:00.000Z",
  },
];

/**
 * Deterministic local mock. It performs no network access: results are
 * filtered from the in-memory records it was constructed with.
 */
export function createMockDiscoveryProvider(
  records: readonly unknown[] = MOCK_DISCOVERY_RECORDS,
): ProductDiscoveryProvider {
  return {
    async search(query) {
      const validated = validateExternalRecords(records);
      const needle = query.trim().toLowerCase();
      const products = needle
        ? validated.products.filter((product) => `${product.title} ${product.description}`.toLowerCase().includes(needle))
        : validated.products;
      return { products, rejectedCount: validated.rejectedCount };
    },
  };
}
