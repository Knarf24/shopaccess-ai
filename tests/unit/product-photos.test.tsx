import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { productPhoto } from "@/lib/catalog/product-photos";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import { CHARGER_PRODUCT_ID } from "@/lib/catalog/charger-purchase";
import { ProductPhotoCredit } from "@/components/ProductPhotoCredit";
import { MerchantProductCard } from "@/components/MerchantProductCard";
import { ChargerPurchaseCard } from "@/components/mock-journey/ChargerPurchaseCard";
it("covers current products with self-contained labelled illustrations and no retired photos", () => {
 for (const id of [...DEMO_MERCHANT_CATALOG.products.map(p => p.productId), CHARGER_PRODUCT_ID]) {
  const photo = productPhoto(id)!;
  expect(photo).not.toBeNull(); expect(photo.path).toMatch(/^\/catalog\/illustrations\/[a-z0-9-]+\.svg$/);
  const bytes = readFileSync(join(process.cwd(), "public", photo.path));
  const svg = bytes.toString(); expect(svg).toContain("<svg"); expect(svg).not.toMatch(/<image|<script|(?:href|src)=/i);
  expect(photo.alt.en.length).toBeGreaterThan(20); expect(photo.alt.es.length).toBeGreaterThan(20);
  expect(photo.alt.en.toLowerCase()).toContain("illustration");
  expect(photo.alt.es.toLowerCase()).toContain("ilustración");
  expect(existsSync(join(process.cwd(), "public", photo.path.replace("/illustrations/", "/photos/").replace(".svg", ".webp")))).toBe(false);
 }
 expect(productPhoto("__proto__")).toBeNull(); expect(productPhoto("unlisted")).toBeNull();
});
it("uses actual local assets on the laptop cards without changing catalog records", () => {
 expect(DEMO_MERCHANT_CATALOG.revision).toBe(2);
 for (const product of DEMO_MERCHANT_CATALOG.products) {
  const html = renderToStaticMarkup(<MerchantProductCard product={product} merchantName="Demo" />);
  expect(html).toContain(productPhoto(product.productId)!.path);
  expect(html).toContain(productPhoto(product.productId)!.alt.en);
  expect(html).not.toContain('alt="Illustration"');
  expect(product.imagePath).toMatch(/\.svg$/);
 }
});
it.each(["en", "es"] as const)("uses the original adapter illustration and keeps cable/simulation notices in %s", language => {
 const html = renderToStaticMarkup(<ChargerPurchaseCard language={language} csrfToken="csrf" permitted={false} />);
 expect(html).toContain("/catalog/illustrations/apple-70w-adapter.svg");
 expect(html).toContain(productPhoto(CHARGER_PRODUCT_ID)!.alt[language]);
 expect(html).toContain(language === "en" ? "Cable sold separately" : "El cable se vende por separado");

 expect(html).toContain(language === "en" ? "Illustration" : "Ilustración");
 expect(renderToStaticMarkup(<ProductPhotoCredit productId={CHARGER_PRODUCT_ID} language={language} />)).not.toContain("<a");
});
