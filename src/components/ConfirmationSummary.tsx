import { formatUsd } from "@/lib/catalog/merchant-catalog";
import type { ConfirmationChallenge } from "@/lib/confirmation/confirmation";

export interface ConfirmationSummaryProps {
  readonly challenge: ConfirmationChallenge;
  readonly csrfToken: string;
  /** Where the form posts. Omit to render the summary as a non-submittable preview. */
  readonly action?: string;
}

/**
 * The explicit confirmation step. Native form controls only, so it is fully
 * operable by keyboard and announced correctly by assistive technology.
 * Submitting records the shopper's confirmation of this exact summary; it does
 * not contact PayPal.
 */
export function ConfirmationSummary({ challenge, csrfToken, action }: ConfirmationSummaryProps) {
  const { summary } = challenge;
  return (
    <form method="post" action={action} aria-labelledby="confirm-heading" className="flex max-w-xl flex-col gap-4 rounded-lg border border-zinc-400 p-5">
      <h2 id="confirm-heading" className="text-xl font-semibold">
        Review and confirm this purchase summary
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="font-medium">Seller</dt>
        <dd>{summary.merchantName}</dd>
        <dt className="font-medium">Item</dt>
        <dd>
          {summary.productTitle} — {summary.variantLabel}
        </dd>
        <dt className="font-medium">Quantity</dt>
        <dd>{summary.quantity}</dd>
        <dt className="font-medium">Tax and shipping</dt>
        <dd>$0.00 (assumed for this Sandbox demonstration; nothing is shipped)</dd>
        <dt className="font-medium">Total</dt>
        <dd className="font-semibold">
          {formatUsd(summary.totalCents)} {summary.currency}
        </dd>
      </dl>
      <p id="confirm-explanation" className="text-sm">
        Confirming does not take payment. It records that you agree to this exact summary. If PayPal checkout is added later,
        approving the payment in PayPal is the step that would authorize payment. This summary expires at{" "}
        <time dateTime={challenge.expiresAt}>{challenge.expiresAt}</time>; after that, or if anything changes, you will be asked to
        review a new summary.
      </p>
      <input type="hidden" name="confirmationId" value={challenge.confirmationId} />
      <input type="hidden" name="nonce" value={challenge.nonce} />
      <input type="hidden" name="quoteId" value={challenge.quoteId} />
      <input type="hidden" name="quoteDigest" value={challenge.quoteDigest} />
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="acknowledged" value="yes" required className="mt-1" />
        <span>I have reviewed the seller, item, quantity and total above.</span>
      </label>
      <button
        type="submit"
        disabled={!action}
        aria-describedby="confirm-explanation"
        className="rounded bg-blue-800 px-4 py-2 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:bg-zinc-500"
      >
        Confirm this purchase summary
      </button>
    </form>
  );
}
