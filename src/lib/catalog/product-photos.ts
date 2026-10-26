/** Presentation only: fixed local assets do not change catalog records, quote digests or prices.
 * The legacy productPhoto helper now selects original illustrations. Provenance: docs/product-photo-sources.md.
 */
export interface ProductPhoto {
  readonly path: string;
  readonly alt: { readonly en: string; readonly es: string };
}
const PHOTOS: Readonly<Record<string, ProductPhoto>> = {
  dmp_aspirego15: {
    path: "/catalog/illustrations/aspire-go-15.svg",
    alt: { en: "Laptop illustration for Acer Aspire Go 15 AG15-21PT-R9TL; actual appearance may differ", es: "Ilustración de portátil para Acer Aspire Go 15 AG15-21PT-R9TL; el aspecto real puede variar" },
  },
  dmp_aspire14ai: {
    path: "/catalog/illustrations/aspire-14-ai.svg",
    alt: { en: "Laptop illustration for Acer Aspire 14 AI A14-52M-51S1; actual appearance may differ", es: "Ilustración de portátil para Acer Aspire 14 AI A14-52M-51S1; el aspecto real puede variar" },
  },
  dmp_vivobook16: {
    path: "/catalog/illustrations/vivobook-16.svg",
    alt: { en: "Laptop illustration for ASUS Vivobook 16 F1605VA-DS74; actual appearance may differ", es: "Ilustración de portátil para ASUS Vivobook 16 F1605VA-DS74; el aspecto real puede variar" },
  },
  dmp_apple70wadapter: {
    path: "/catalog/illustrations/apple-70w-adapter.svg",
    alt: { en: "Power adapter illustration for Apple 70W USB-C Power Adapter; actual appearance may differ; cable not included", es: "Ilustración de adaptador para Apple USB-C de 70 W; el aspecto real puede variar; cable no incluido" },
  },
};
export function productPhoto(productId: string): ProductPhoto | null {
  return Object.hasOwn(PHOTOS, productId) ? PHOTOS[productId] : null;
}
