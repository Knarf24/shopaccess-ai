import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { parseSafeExternalUrl } from "@/lib/catalog/url";
import type { JourneyCopy } from "@/lib/i18n/demo-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";
import type { ExternalListingView } from "@/lib/catalog/external-listing";
import { ListingSearchForm } from "@/components/mock-journey/ListingSearchForm";

export type ListingNotice = "unavailable" | "limit" | "error" | "stale";

const NOTICE: Record<ListingNotice, keyof JourneyCopy> = {
  unavailable: "listingsUnavailable",
  limit: "listingsLimit",
  error: "listingsError",
  stale: "listingsStale",
};

/**
 * Explicit external search. The button is a native submit control.
 * This component does not fetch and does not render external images.
 * `pending` is the server snapshot. The form itself shows the shopper's
 * own submission as pending until that submission settles.
 */
export function ExternalListings({
  copy,
  language,
  csrfToken,
  draftId,
  version,
  notice,
  listings,
  pending = false,
}: {
  readonly copy: JourneyCopy;
  readonly language: JourneyLanguage;
  readonly csrfToken: string;
  readonly draftId: string;
  readonly version: number;
  readonly notice: ListingNotice | null;
  readonly listings: readonly ExternalListingView[] | null;
  /** Server-rendered status while this process is still retrieving listings. */
  readonly pending?: boolean;
}) {
  const noticeText = notice ? copy[NOTICE[notice]] : null;
  return (
    <section aria-labelledby="external-listings-heading" className="external-listings flex flex-col gap-3">
      <h2 id="external-listings-heading" className="text-2xl font-semibold">
        {copy.listingsHeading}
      </h2>
      <p>{copy.listingsIntro}</p>
      {pending ? <p role="status">{copy.listingsPending}</p> : null}
      {typeof noticeText === "string" ? <p role="alert">{noticeText}</p> : null}
      <ListingSearchForm
        label={copy.searchListings}
        pendingMessage={copy.listingsPending}
        errorMessage={copy.listingsSubmitError}
        language={language}
        csrfToken={csrfToken}
        draftId={draftId}
        version={version}
      />
      {!pending && listings !== null && listings.length === 0 && notice === null ? <p role="status">{copy.listingsEmpty}</p> : null}
      {listings !== null && listings.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {listings.map((listing) => {
            const link = listing.url ? parseSafeExternalUrl(listing.url) : null;
            const href = link?.ok ? link.value : null;
            return (
              <li key={listing.externalId} className="rounded-lg border border-zinc-400 p-4">
                <p>{language === "es" ? <span lang="en">{listing.title}</span> : listing.title}</p>
                <p>{listing.sellerLabel ?? copy.sellerUnknown}</p>
                {listing.indicativePriceCents !== null ? (
                  <p>
                    {copy.indicativePrice} {formatUsd(listing.indicativePriceCents)} USD
                  </p>
                ) : (
                  <p>{copy.priceNotRefreshed}</p>
                )}
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                    {copy.viewListing}
                  </a>
                ) : listing.indicativePriceCents !== null ? (
                  <p>{copy.noSafeLink}</p>
                ) : null}
                <p>{copy.availabilityUnverified}</p>
                <p>{copy.suitabilityUnverified}</p>
                <p>
                  {copy.retrievedLabel} <time dateTime={listing.retrievedAt}>{listing.retrievedAt}</time>
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
