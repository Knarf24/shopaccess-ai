/** Shopper-facing notice for a needs draft. It carries no session, payment, or provider data. */
export type NeedsNotice = "malformed" | "missing_use" | "missing_budget" | "ambiguous" | "review" | "unavailable";
