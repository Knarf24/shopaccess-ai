import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import { ConfirmationSummary } from "@/components/ConfirmationSummary";
import { SimulatedPaymentPanel } from "@/components/SimulatedPaymentPanel";
import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { getRuntime } from "@/server/runtime";
import { buildCheckoutView, messageFor, resolvePageSession } from "@/server/views";

interface PageProps {
  params: Promise<{ intentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function CheckoutContent({ params, searchParams }: PageProps) {
  // Everything below depends on the request and the current time, so it is rendered per request.
  await connection();
  const [{ intentId }, query] = await Promise.all([params, searchParams]);
  const runtime = getRuntime();
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;

  const session = await resolvePageSession(runtime.value);
  if (!session) redirect("/");
  // A checkout owned by another session is indistinguishable from one that does not exist.
  const view = await buildCheckoutView(runtime.value, session, intentId);
  if (!view) notFound();

  const error = messageFor(typeof query.error === "string" ? query.error : undefined);
  const notice = messageFor(typeof query.notice === "string" ? query.notice : undefined);

  return (
    <>
      {error ? <p role="alert" className="rounded border-2 border-red-700 p-3">{error}</p> : null}
      {notice ? <p role="status" className="rounded border-2 border-green-800 p-3">{notice}</p> : null}

      {view.challenge ? (
        <ConfirmationSummary challenge={view.challenge} csrfToken={session.csrfToken} action={`/checkout/${view.intentId}/confirm`} />
      ) : view.quote ? (
        <section aria-labelledby="quote-heading" className="rounded-lg border border-zinc-400 p-4">
          <h2 id="quote-heading" className="text-xl font-semibold">
            Quote
          </h2>
          <p>
            {view.itemTitle ?? "Item no longer in the demo catalog"}, quantity {view.quote.quantity}, sold by {view.merchantName}.
          </p>
          <p>
            Total {formatUsd(view.quote.totalCents)} {view.quote.currency}. Tax and shipping are $0.00 as an assumption of this Sandbox
            demonstration; nothing is shipped.
          </p>
          {view.challengeProblem ? <p role="alert">{messageFor(view.challengeProblem)}</p> : null}
        </section>
      ) : null}

      <SimulatedPaymentPanel view={view} csrfToken={session.csrfToken} />
      <p>
        <Link href="/" prefetch={false} className="underline">
          Back to the start
        </Link>
      </p>
    </>
  );
}

export default function CheckoutPage(props: PageProps) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <h1 className="text-3xl font-semibold">Demo checkout</h1>
      <Suspense fallback={<p>Loading checkout…</p>}>
        <CheckoutContent {...props} />
      </Suspense>
    </main>
  );
}
