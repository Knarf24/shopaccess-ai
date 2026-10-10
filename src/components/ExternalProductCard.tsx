import { formatUsd } from "@/lib/catalog/merchant-catalog";
import type { ExternalProduct } from "@/lib/catalog/schemas";
import { parseSafeExternalUrl } from "@/lib/catalog/url";

/**
 * Renders an untrusted discovery result. All text goes through React text
 * nodes (never dangerouslySetInnerHTML), and the link is re-validated at render
 * time so an unsafe URL can never reach an href.
 */
export function ExternalProductCard({ product }: { product: ExternalProduct }) {
  const link = parseSafeExternalUrl(product.url);
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h3 className="text-lg font-semibold">{product.title}</h3>
      <p className="text-sm">
        Listed by an external seller: <span className="font-medium">{product.sellerLabel}</span>. ShopAccess AI is not the seller
        and cannot check out this item.
      </p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{product.description}</p>
      {product.listedPrice ? (
        <p className="text-sm">Listed price (unverified): {formatUsd(product.listedPrice.amountCents)} USD</p>
      ) : null}
      {link.ok ? (
        <a href={link.value} target="_blank" rel="noopener noreferrer nofollow" className="text-sm font-medium underline">
          View on the external seller&apos;s site (opens in a new tab)
        </a>
      ) : (
        <p className="text-sm">No safe link is available for this listing.</p>
      )}
    </article>
  );
}
