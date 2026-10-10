import { MerchantProductCard } from "@/components/MerchantProductCard";
import { PreferencesForm } from "@/components/PreferencesForm";
import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";

export default function Home() {
  const catalog = DEMO_MERCHANT_CATALOG;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">ShopAccess AI</h1>
        <p className="text-lg">Help choosing a first laptop, with the evidence behind every suggestion.</p>
      </header>

      <section aria-labelledby="notice-heading" className="rounded-lg border-2 border-amber-600 bg-amber-50 p-4 text-amber-950">
        <h2 id="notice-heading" className="font-semibold">
          Simulated Sandbox shopping catalog
        </h2>
        <p className="text-sm">
          These laptops, prices and the seller are fictional and for demonstration only. Quotes, confirmation and payment states
          are simulated: no real payment can be taken and nothing will be shipped.
        </p>
      </section>

      <section aria-labelledby="start-heading" className="flex flex-col gap-3">
        <h2 id="start-heading" className="text-2xl font-semibold">
          Tell us what you need
        </h2>
        <PreferencesForm />
      </section>

      <section aria-labelledby="catalog-heading" className="flex flex-col gap-4">
        <h2 id="catalog-heading" className="text-2xl font-semibold">
          Demo laptops
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {catalog.products.map((product) => (
            <MerchantProductCard key={product.productId} product={product} merchantName={catalog.merchant.displayName} />
          ))}
        </div>
      </section>
    </main>
  );
}
