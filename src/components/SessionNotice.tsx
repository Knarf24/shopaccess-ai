const BUTTON = "rounded bg-blue-800 px-4 py-2 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

export type SessionNoticeProps = { readonly kind: "ended" } | { readonly kind: "rotate"; readonly csrfToken: string };

/**
 * PostgreSQL mode only. Two notices about the browser's session, each with one native form, so both work with the
 * keyboard alone and without JavaScript.
 *
 *  - "ended": the browser presented a session that can no longer be used. Nothing was started in its place. The
 *    button asks for a new session explicitly, and the text says what that means for earlier checkouts.
 *  - "rotate": the session is valid under an older key. The button renews it; the session and its checkouts stay.
 */
export function SessionNotice(props: SessionNoticeProps) {
  if (props.kind === "ended") {
    return (
      <section role="alert" aria-labelledby="session-ended-heading" className="flex flex-col gap-3 rounded-lg border-2 border-red-700 p-4">
        <h2 id="session-ended-heading" className="font-semibold">
          Your session can no longer be used
        </h2>
        <p className="text-sm">
          This browser presented a session that has ended or cannot be read. Nothing was started in its place. You can start a new
          session. Checkouts from the earlier session will not transfer to the new one.
        </p>
        <form method="post" action="/session/new">
          <input type="hidden" name="intent" value="new-session" />
          <button type="submit" className={BUTTON}>
            Start a new session
          </button>
        </form>
      </section>
    );
  }
  return (
    <section role="status" aria-labelledby="session-rotate-heading" className="flex flex-col gap-3 rounded-lg border-2 border-amber-600 p-4">
      <h2 id="session-rotate-heading" className="font-semibold">
        Your secure session can be renewed
      </h2>
      <p className="text-sm">
        Your session is still valid. Renewing it keeps your checkouts. Pages you opened earlier will need to be reloaded before their
        buttons work again.
      </p>
      <form method="post" action="/session/rotate">
        <input type="hidden" name="csrfToken" value={props.csrfToken} />
        <button type="submit" className={BUTTON}>
          Refresh secure session
        </button>
      </form>
    </section>
  );
}
