import { productPhoto } from "@/lib/catalog/product-photos";
import { ProductPhotoCredit } from "../ProductPhotoCredit";
import Image from "next/image";
import { CHARGER_PRODUCT_ID, CHARGER_VARIANT_ID } from "@/lib/catalog/charger-purchase";
export function ChargerPurchaseCard({ language, csrfToken, permitted }: { language: "en" | "es"; csrfToken: string; permitted: boolean }) {
 const es = language === "es";
 const photo = productPhoto(CHARGER_PRODUCT_ID)!;
 const permissionUrl = `/${language}/shop/permissions?${new URLSearchParams({ item: `${CHARGER_PRODUCT_ID}:${CHARGER_VARIANT_ID}`, quantity: "1", total: "59.00", expiry: "15m", review: "1" })}`;
 const actionClass = "charger-rec-primary";
 return <section aria-labelledby="charger-recommendation-title" className="charger-rec-card">
  <figure className="charger-rec-illustration"><Image src={photo.path} alt={photo.alt[language]} width={1000} height={1000} unoptimized /><figcaption><ProductPhotoCredit productId={CHARGER_PRODUCT_ID} language={language} /></figcaption></figure>
  <div className="charger-rec-product">
  <p className="recommendation-badge">{es ? "Recomendado" : "Recommended"}</p>
  <h2 id="charger-recommendation-title" lang="en">Apple 70W USB-C Power Adapter</h2>
  <p className="charger-rec-model">A2743 · MXN53AM/A</p>
  <p className="mt-2 text-2xl font-semibold">$59.00 USD</p>
  <p className="mt-3">{es ? "El cable se vende por separado. Necesita un cable USB-C a MagSafe 3 o un cable de carga USB-C apropiado. El adaptador por sí solo no completa el conjunto de carga." : "Cable sold separately. You need an appropriate USB-C to MagSafe 3 or USB-C charging cable. The adapter alone is not a complete charging setup."}</p>
  {permitted ? <form method="post" action="/checkout/start" className="mt-5">
   <input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="lang" value={language} />
   <input type="hidden" name="productId" value={CHARGER_PRODUCT_ID} /><input type="hidden" name="variantId" value={CHARGER_VARIANT_ID} /><input type="hidden" name="quantity" value="1" />
   <button type="submit" className={actionClass}>{es ? "Revisar compra" : "Review purchase"}</button>
  </form> : <div className="mt-5"><p className="mb-3">{es ? "Antes de continuar, permita una compra de este adaptador con un límite de $59.00." : "Before continuing, allow one purchase of this adapter with a $59.00 limit."}</p><a className={actionClass} href={permissionUrl}>{es ? "Revisar permiso de compra" : "Review purchase permission"}</a></div>}
 </div>
 </section>;
}
