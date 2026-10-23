/** A stored external listing. It is not a merchant quote and it has no image. */
export interface ExternalListingView {
  readonly externalId: string;
  readonly title: string;
  /** The offer's website as Channel3 reports it. Not a verified seller identity. `null` when unknown. */
  readonly reportedDomain: string | null;
  /** Documented Channel3 availability for the offer shown, or `null` when absent or ambiguous. */
  readonly reportedAvailability: "InStock" | "OutOfStock" | null;
  readonly indicativePriceCents: number | null;
  readonly url: string | null;
  readonly retrievedAt: string;
}
