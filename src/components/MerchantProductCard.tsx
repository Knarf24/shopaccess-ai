import Image from "next/image";
import { formatUsd } from "@/lib/catalog/merchant-catalog";
import type { MerchantProduct } from "@/lib/catalog/schemas";

const AVAILABILITY_LABELS = {
  IN_STOCK: "In stock (simulated)",
  OUT_OF_STOCK: "Out of stock (simulated)",
  DISCONTINUED: "Discontinued (simulated)",
} as const;

export function MerchantProductCard({ product, merchantName }: { product: MerchantProduct; merchantName: string }) {
  const headingId = `product-${product.productId}`;
  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
      <Image src={product.imagePath} alt="Illustration" width={320} height={200} unoptimized className="w-full rounded" />
      <h3 id={headingId} className="text-lg font-semibold">
        {product.title}
      </h3>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{product.description}</p>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">Sold by {merchantName}.</p>
      <ul className="flex flex-col gap-3">
        {product.variants.map((variant) => (
          <li key={variant.variantId} className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-700">
            <p className="font-medium">{variant.label}</p>
            <p>
              Fixed demo price <span className="font-semibold">{formatUsd(variant.unitAmountCents)}</span> USD ·{" "}
              {AVAILABILITY_LABELS[variant.availability]}
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-zinc-700 dark:text-zinc-300">
              <dt>Processor</dt>
              <dd>{variant.specs.cpu}</dd>
              <dt>Screen</dt>
              <dd>{variant.specs.screenInches} inches</dd>
              <dt>Weight</dt>
              <dd>{variant.specs.weightKg} kg</dd>
              <dt>System</dt>
              <dd>{variant.specs.operatingSystem}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </article>
  );
}
