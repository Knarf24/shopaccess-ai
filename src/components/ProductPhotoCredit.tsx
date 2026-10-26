import { productPhoto } from "@/lib/catalog/product-photos";
/** Legacy component name retained for callers; all mapped images are original illustrations. */
export function ProductPhotoCredit({ productId, language = "en" }: { productId: string; language?: "en" | "es" }) {
  return productPhoto(productId) ? <span className="text-xs">{language === "es" ? "Ilustración · El aspecto real puede variar" : "Illustration · Actual appearance may differ"}</span> : null;
}
