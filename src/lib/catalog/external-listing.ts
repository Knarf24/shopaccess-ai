/** A stored external listing. It is not a merchant quote and it has no image. */
export interface ExternalListingView {
  readonly externalId: string;
  readonly title: string;
  readonly sellerLabel: string | null;
  readonly indicativePriceCents: number | null;
  readonly url: string | null;
  readonly retrievedAt: string;
}
