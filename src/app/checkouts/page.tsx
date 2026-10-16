import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import { SessionNotice } from "@/components/SessionNotice";
import { buildPgCheckoutList, PG_STATUS_LABELS, pgCookieHeader, resolvePgPageSession } from "@/server/pg-views";
import { getApplication } from "@/server/runtime";
import { messageFor } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function NotAvailable() {
  return (
    <p role="alert" className="rounded border-2 border-red-700 p-3">
      The shop is not available right now. Please try again later.
    </p>
  );
}

/**
 * PostgreSQL mode only: the checkouts of this browser's session. A way back to a checkout after a restart, a closed
 * tab or an uncertain start. It is best-effort: a checkout that is listed can be opened; a checkout that is not
 * listed has not thereby been shown not to exist. Loading this page starts, changes and ends nothing.
 */
async function CheckoutsContent({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const application = getApplication();
  // The mock has no such list.
  if (application.mode === "mock") notFound();
  if (application.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;

  const query = await searchParams;
  const services = await application.runtime.services();
  if (!services) return <NotAvailable />;

  const session = await resolvePgPageSession(services, await pgCookieHeader());
  if (session === "UNAVAILABLE") return <NotAvailable />;
  if (!session.context) redirect(session.presence === "PRESENT" ? "/?session=ended" : "/");

  const list = await buildPgCheckoutList(services, session.context);
  if (list.kind !== "OK") return <NotAvailable />;

  const notice = messageFor(typeof query.notice === "string" ? query.notice : undefined);
  const error = messageFor(typeof query.error === "string" ? query.error : undefined);
  return (
    <>
      {error ? <p role="alert" className="rounded border-2 border-red-700 p-3">{error}</p> : null}
      {notice ? <p role="status" className="rounded border-2 border-amber-600 p-3">{notice}</p> : null}
      {session.context.session.keyStatus === "VERIFY_ONLY" ? <SessionNotice kind="rotate" csrfToken={session.context.session.csrfToken} /> : null}
      {list.value.length === 0 ? (
        <p>No checkouts are listed for this session.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.value.map((item) => (
            <li key={item.intentId} className="rounded-lg border border-zinc-400 p-4">
              <Link href={`/checkout/${item.intentId}`} prefetch={false} className="font-medium underline">
                Checkout started <time dateTime={item.createdAt}>{item.createdAt}</time>
              </Link>
              <p className="text-sm">
                {PG_STATUS_LABELS[item.effectiveStatus]}. Quote valid until <time dateTime={item.quoteExpiresAt}>{item.quoteExpiresAt}</time>.
              </p>
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link href="/" prefetch={false} className="underline">
          Back to the start
        </Link>
      </p>
    </>
  );
}

export default function CheckoutsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <h1 className="text-3xl font-semibold">Your checkouts</h1>
      <Suspense fallback={<p>Loading your checkouts…</p>}>
        <CheckoutsContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
