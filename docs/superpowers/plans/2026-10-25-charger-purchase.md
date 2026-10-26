# Connected charger purchase implementation plan

Goal: complete the approved isolated mock charger purchase journey from confirmed device and budget to a simulated result.
Architecture: install a revision-3 catalog only in the explicitly enabled mock format-8 test runtime. Bind adapter quotes to the current charger draft and revision; recheck the binding through the existing purchase gate before confirmation, order creation and capture. Existing laptop and ordinary store behavior stays unchanged.
Spec: owner-approved October 25 conversation: A2743 only, Mac14,2 only, fixed USD59 dated October25, cable sold separately, explicit permission and mock payment.

- [x] Add failing policy tests: wrong device, missing/unconfirmed/insufficient budget, wrong owner, stale draft/revision, wrong item, quantity, and catalog rollback.
- [x] Implement fixed demo catalog and pure eligibility rules; no external requests or new dependencies.
- [x] Wire quote metadata, permission choices and the purchase gate; no adapter accepted without the current binding.
- [x] Add one EN/ES recommendation card with permission and review links, cable and simulation disclosure.
- [x] Exercise mock purchase and post-edit refusals, run relevant regression checks and full validation; report environment failures separately.
- [x] Package exact candidate and evidence for review. Do not commit, push, merge or deploy.

Review focus: alternate device; forged IDs/prices; edits during checkout; rollback to catalog2; restarting with ended permissions. Existing stores are never migrated or restored to an earlier copy.

Validation limit: 9 unchanged child-process tests cannot start /usr/local/bin/node here. Browser/VoiceOver acceptance remains open; see packaged results.
