import Link from "next/link";
import type { PgCheckoutActions, PgQuoteRequest } from "@/server/pg-views";

const BUTTON = "rounded bg-blue-800 px-4 py-2 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
const QUIET_BUTTON = "rounded border border-zinc-600 px-4 py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

function QuoteFields({ item, csrfToken }: { item: PgQuoteRequest; csrfToken: string }) {
  return (
    <>
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="productId" value={item.productId} />
      <input type="hidden" name="variantId" value={item.variantId} />
      <input type="hidden" name="quantity" value={item.quantity} />
    </>
  );
}

/**
 * PostgreSQL mode only. The actions of one checkout, each a native form posting to a guarded route, so every one is
 * operable by keyboard and works without JavaScript. Which actions appear is decided on the server from the
 * checkout's stored state; the database decides again when a form is sent.
 */
export function CheckoutActions({ intentId, actions, csrfToken }: { intentId: string; actions: PgCheckoutActions; csrfToken: string }) {
  const nothing = !actions.review && !actions.cancel && !actions.replace && !actions.startAnother && !actions.successorIntentId;
  return (
    <section aria-labelledby="actions-heading" className="flex flex-col gap-3 rounded-lg border border-zinc-400 p-4">
      <h2 id="actions-heading" className="text-xl font-semibold">
        What you can do
      </h2>
      {actions.review ? (
        <form method="post" action={`/checkout/${intentId}/review`}>
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <button type="submit" className={BUTTON}>
            Review again
          </button>
        </form>
      ) : null}
      {actions.replace ? (
        <form method="post" action="/checkout/start">
          <QuoteFields item={actions.replace} csrfToken={csrfToken} />
          <input type="hidden" name="replaces" value={intentId} />
          <button type="submit" className={BUTTON}>
            Request a new quote in place of this one
          </button>
        </form>
      ) : null}
      {actions.startAnother ? (
        <form method="post" action="/checkout/start">
          <QuoteFields item={actions.startAnother} csrfToken={csrfToken} />
          <button type="submit" className={BUTTON}>
            Start another checkout for this item
          </button>
        </form>
      ) : null}
      {actions.cancel ? (
        <form method="post" action={`/checkout/${intentId}/cancel`}>
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <button type="submit" className={QUIET_BUTTON}>
            Cancel this checkout
          </button>
        </form>
      ) : null}
      {actions.successorIntentId ? (
        <p>
          <Link href={`/checkout/${actions.successorIntentId}`} prefetch={false} className="underline">
            Open the checkout that replaced this one
          </Link>
        </p>
      ) : null}
      {nothing ? <p className="text-sm">Nothing more can be done with this checkout.</p> : null}
    </section>
  );
}
