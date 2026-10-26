# Connected charger purchase — isolated mock demo

October 25, 2026. Builds on PR29 (confirmed charger budget). This candidate is not a deployment or a migration.

Only an explicitly enabled fresh format-8 snapshot runtime with mock payment installs catalog revision3. Ordinary memory, ordinary snapshot and PayPal Sandbox retain catalog2 and cannot sell the adapter. No environment variable or hosted setting is changed by this patch.

The offer is Apple 70W USB-C Power Adapter, A2743, SKU MXN53AM/A, fixed demo price USD59.00 from the saved Apple US capture dated October25, 2026. Stock, merchant, tax, shipping and payment are simulated; nothing is shipped or charged. Apple is not a partner. The adapter is separate from its cable and alone is not a complete charging setup. The existing sourced comparison supplies the compatibility explanation; the only purchasable device pairing is the confirmed MacBook Air M2 identifier Mac14,2. A2452 and unknown pairings remain information only.

A confirmed, current charger budget must cover the exact total. A separate website permission allows one exact adapter purchase, bounded by amount and expiry. Budget confirmation creates no permission. The shopper reviews the permission, creates it, returns to the needs page and selects Review simulated purchase. Existing summary confirmation, order, simulated buyer approval and capture steps remain in force.

Quotes carry a server-issued charger draft ID and revision, covered by their digest. The purchase gate rechecks the current live draft, device and confirmed budget at reservation, summary confirmation, order creation and the durable capture decision. Editing and then reconfirming a budget does not revive an older checkout. Session, CSRF, revocation, expiry, quantity and permission consumption checks remain in force.

The saved transition to executing is the existing irreversible capture boundary. A later edit cannot cancel a purchase already underway. The page warns about executing or unknown outcomes. Capture outcome recording and recovery remain unchanged: consumed/revoked/expired permissions do not reactivate; reserved can become active on restart and executing becomes outcome_unknown. Checkout intents themselves remain process memory and are lost on restart. Returning to catalog2 removes the adapter, so adapter quotes and permissions cannot authorize a new purchase. Restoring an earlier snapshot is not an approved rollback.

The new card supplies English and Spanish copy, a labelled section and a single main action. Compatibility evidence is behind a native details control when the card is shown. This is an incremental layout change, not approval of a complete visual redesign. Browser, VoiceOver and native Spanish acceptance for this candidate remain unverified.

## Browser observation and presentation correction (October 25)

The owner completed an English Chrome walkthrough of the r1 candidate on a guarded local development server: model identification, model confirmation, USD59 budget confirmation, A2743 recommendation, explicit one-unit USD59 permission, quote review and confirmation, simulated order and buyer approval, CAPTURED_VERIFIED, then permission Used without a revoke button. Screenshots are preserved separately. The Terminal screenshot shows Server stopped. Server/network logs from the owner's Mac have not been inspected here; no zero-outbound claim is made for that browser run.

The r2 correction stops budget-only controls from recording comparison messages, collapses adjacent duplicate charger-shown notices in existing rendered histories without changing saved records, and hides the secondary charger model selector while the main charger conversation is active. Primary model selection/change controls remain. The refund simulation already caps the amount at the remaining captured balance; its misleading fixed USD100 label is replaced with an accurate description. The r1 browser walkthrough predates these corrections. R2 has automated render/handler coverage and source review; a complete r2 browser, VoiceOver, mobile or Spanish acceptance is not claimed.
