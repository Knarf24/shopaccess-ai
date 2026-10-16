/** Shown when shopper state could not be opened or saved. No business data, no redirect, no cookie. */
export function StoreUnavailable() {
  return (
    <p role="alert" className="rounded border-2 border-red-700 p-3">
      The shop is not available right now. Please try again later.
    </p>
  );
}
