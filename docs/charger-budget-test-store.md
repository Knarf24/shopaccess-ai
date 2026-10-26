# Charger budget: fresh test stores only

This slice adds a separate adapter budget to a confirmed charger model in the guided conversation. A proposal is not confirmed. Confirmation requires a second website form submission, the session and CSRF checks, the current draft, and the current charger-track revision. Editing the amount clears confirmation. Changing the device or leaving the charger task removes the budget. Text that repeats the same confirmed model preserves it. No laptop budget is copied or changed.

Amounts are whole US dollars, 10–99999, stored as integer cents. The adapter alone is not a complete setup; the cable is separate. Confirmation records the budget only. It creates no quote, permission, checkout or payment. Adapter purchasing remains refused by the existing catalog-slice quote guards.

## Test-store selection and compatibility

The exact environment token `SHOPACCESS_CHARGER_BUDGET_TEST_STORE=1` selects the new test mode. It must be set both when initializing a new disposable snapshot store and when running that store. Existing mock-store directory and key-file settings are still required for the snapshot runtime. The ordinary memory runtime never enables budget controls.

The initializer uses the existing `--directory` and `--key-file` arguments. Use only a new disposable directory and key. Do not point this command at an owner or rehearsal store. The initializer refuses an existing store.json. The runtime in test mode refuses any file whose format is not 8, without rewriting it. It does not migrate formats 1–7. Ordinary mode continues writing format 7 and refuses format 8. An older binary also refuses format 8. Do not work around refusal by changing a format number or restoring an older backup.

Format 8 adds an optional budget object to the current charger track. It contains proposedCents and confirmedCents; a non-null confirmation must equal the proposal. Budget fields are allowed only with a confirmed device. Unknown keys and invalid amounts are refused. A saved budget and the shared revision survive restart. The current permissions, grants, session and draft formats remain unchanged.

## Recovery and rollback

No downgrade writer, store migration, backup restore or authority reset is included. Existing permission recovery is unchanged: reserved may become active; executing becomes outcome_unknown. Consumed, revoked and expired never become active because of this slice. Tests exercise those ended outcomes alongside a saved charger budget in format 8.

To stop testing, stop the test runtime and discard its disposable store. Keep all owner/rehearsal stores unchanged. A future production migration and any catalog rollback need a separate reviewed design that preserves later permission outcomes and keeps adapter permissions and quotes inactive if their catalog entry disappears. Restoring an older store file is not an approved rollback.

## Validation limits

Automated controls and handler tests are not browser or VoiceOver acceptance. The fresh-store browser check must verify both languages, explicit proposal then confirmation, stale forms after model/budget changes, restart recovery, and that no purchase is offered. This slice does not enable the hosted extension, change Render settings or deploy anything.

## October 25 follow-on candidate

The connected charger-purchase candidate adds purchasing only to the isolated mock format-8 runtime. The earlier slice description above is retained as history. See [Connected charger purchase](charger-purchase-test-store.md) for eligibility, permission and capture rules. This does not authorize existing-store migration or hosted use.
