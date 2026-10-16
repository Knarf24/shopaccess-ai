/**
 * Spanish presentation for the demo catalog. The English merchant catalog remains the
 * source of prices and identifiers. A missing entry is reported, not invented.
 */
const PRODUCT_TEXT: Record<string, { readonly description: string }> = {
  dmp_aspirego15: {
    description: "Modelo AG15-21PT-R9TL, pieza NX.JJJAA.008. Pantalla táctil IPS de 1920 × 1080.",
  },
  dmp_aspire14ai: {
    description: "Modelo A14-52M-51S1, pieza NX.J8LAA.002. Pantalla IPS de 1920 × 1200.",
  },
  dmp_vivobook16: {
    description: "Modelo F1605VA-DS74, pieza 90NB10N3-M004M0. Pantalla de 1920 × 1200 sin función táctil.",
  },
};

const VARIANT_TEXT: Record<string, { readonly label: string }> = {
  dmv_aspirego15: { label: "8 GB LPDDR5, SSD PCIe NVMe de 256 GB" },
  dmv_aspire14ai: { label: "16 GB LPDDR5X, SSD PCIe NVMe de 512 GB" },
  dmv_vivobook16: { label: "16 GB DDR4, SSD PCIe NVMe de 1 TB" },
};

export function spanishProductDescription(productId: string): string | null {
  return PRODUCT_TEXT[productId]?.description ?? null;
}

export function spanishVariantLabel(variantId: string): string | null {
  return VARIANT_TEXT[variantId]?.label ?? null;
}
