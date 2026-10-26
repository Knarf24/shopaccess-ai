import { CHARGER_PRODUCT_ID, CHARGER_VARIANT_ID } from "@/lib/catalog/charger-purchase";
export function ChargerPurchaseCard({ language, csrfToken, permitted }: { language: "en" | "es"; csrfToken: string; permitted: boolean }) {
 const es = language === "es";
 const permissionUrl = `/${language}/shop/permissions?${new URLSearchParams({ item: `${CHARGER_PRODUCT_ID}:${CHARGER_VARIANT_ID}`, quantity: "1", total: "59.00", expiry: "15m", review: "1" })}`;
 const actionClass = "inline-block rounded-lg border border-orange-800 bg-orange-200 px-5 py-3 font-semibold text-blue-950 focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-blue-900";
 return <section aria-labelledby="charger-recommendation-title" className="rounded-xl border border-blue-200 bg-blue-50 p-6 text-blue-950">
  <h2 id="charger-recommendation-title" className="text-2xl font-semibold">{es ? "Adaptador recomendado" : "Recommended adapter"}</h2>
  <p lang="en" className="mt-3 text-lg">Apple 70W USB-C Power Adapter · A2743</p>
  <p className="mt-2 text-2xl font-semibold">$59.00 USD</p>
  <p className="mt-3">{es ? "El cable se vende por separado. Necesita un cable USB-C a MagSafe 3 o un cable de carga USB-C apropiado. El adaptador por sí solo no completa el conjunto de carga." : "Cable sold separately. You need an appropriate USB-C to MagSafe 3 or USB-C charging cable. The adapter alone is not a complete charging setup."}</p>
  <p className="mt-3">{es ? "Compra simulada: no se cobra dinero ni se envía un producto. Precio de demostración fijo del 25 de octubre de 2026; existencias simuladas. Apple no es socio de ShopAccess." : "Simulated purchase: no money is charged and no product is shipped. Fixed demo price from October 25, 2026; simulated stock. Apple is not a ShopAccess partner."}</p>
  {permitted ? <form method="post" action="/checkout/start" className="mt-5">
   <input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="lang" value={language} />
   <input type="hidden" name="productId" value={CHARGER_PRODUCT_ID} /><input type="hidden" name="variantId" value={CHARGER_VARIANT_ID} /><input type="hidden" name="quantity" value="1" />
   <button type="submit" className={actionClass}>{es ? "Revisar compra simulada" : "Review simulated purchase"}</button>
  </form> : <div className="mt-5"><p className="mb-3">{es ? "Antes de continuar, permita una compra de este adaptador con un límite de $59.00." : "Before continuing, allow one purchase of this adapter with a $59.00 limit."}</p><a className={actionClass} href={permissionUrl}>{es ? "Revisar permiso de compra" : "Review purchase permission"}</a></div>}
 </section>;
}
