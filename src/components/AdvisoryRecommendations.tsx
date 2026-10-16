import { formatUsd } from "@/lib/catalog/merchant-catalog";
import type { AdvisoryRecommendation } from "@/server/shopping";

/** Catalog-priced suggestions. This block has no quote, checkout, or payment control. */
export function AdvisoryRecommendations({
  message,
  recommendations,
}: {
  message: string | null;
  recommendations: readonly AdvisoryRecommendation[];
}) {
  return (
    <section aria-labelledby="advisory-heading" className="flex flex-col gap-3 rounded border border-zinc-400 p-4">
      <h2 id="advisory-heading" className="text-lg font-semibold">
        Advisory suggestions
      </h2>
      <p className="text-sm">These suggestions are advisory only. Prices are the demo catalog prices.</p>
      {message ? <p className="text-sm">{message}</p> : <p className="text-sm">No suggestion is available.</p>}
      {recommendations.length === 0 ? (
        message ? null : <p className="text-sm">No catalog item could be shown.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {recommendations.map((item) => (
            <li key={`${item.productId}:${item.variantId}`}>
              <p className="font-medium">{item.title}</p>
              <p>{item.label}</p>
              <p>
                {formatUsd(item.unitAmountCents)} {item.currency}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
