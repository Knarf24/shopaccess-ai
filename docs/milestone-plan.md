# ShopAccess AI milestone plan
Updated October 16, 2026. Owner decision: Frank Ncube. Dates use America/New_York.

## Current evidence note — October 19, 2026 (F03 charger information slice)

This note is later than the October 18 notes below, which remain dated history.

An information-only F03 slice exists on `feature/f03-charger-info` (from `main` `bb878525f3c9bcf2bc90d47da5b681f58d73bab4`): an English/Spanish charger page for two exact Mac models and two Apple adapters with two cables each, linked from the guided needs page. MacBook Air (M2, 2022) results are Apple-listed or on Apple's fast-charge list; every MacBook Pro (Early 2015) result is unknown; no curated configuration is unsupported. It covers the milestone journey's compatibility explanation and comparison only in part: no purchase, no conversational integration (F01), no profile use. See the feature tracker entry of the same date for evidence, reviews and open items. D-category, F03 acceptance, October 24 and the full scope are unchanged.

## Current evidence note — October 18, 2026 (device profile)

This note is later than the October 18 note below. That note and the October 17 note remain dated history.

The optional device profile is committed on `feature/device-profile` as `8059280bfb33558000477ef7cc2545b092109839` and pushed. It is not merged into `main`. Current `main` is `e3c582967adb4897b144c2c4c7436eb137ffa035`. Cursor implemented the session-owned brand and model and the format-6 revision-marker correction. Codex's source-only reviews identified the r1 version-reuse defect and assessed r2. The r2 review found no demonstrated defect in r2-era deletion and recreation. A format-5 file stores no deleted-profile history, so protection for a form issued before the upgrade remains limited. The later r3 additions were tests only.

r2 checks, recorded before r3 and not rerun: 58 files and 1,456 tests passed, typecheck exited 0, and lint exited 0 with nine warnings. r3: the focused device-profile file's 25 tests passed, and the full suite was not rerun. No browser check and no screen-reader check have occurred. F02 remains unaccepted.

A reader that accepts only an older format rejects a format-6 file. Restoring an earlier store copy loses every later snapshot write, including purchase-permission outcomes. No real-store migration is authorized. Recommendations and the extension do not use the profile. October 24, the scope, and the forecast are unchanged.

## Current evidence note — October 18, 2026

M2-3/F07 is committed on `feature/m2-3-purchase-permissions`: slice 3 is `e2c1b05`, and in merge `a142e95` `main` (`21871db`) was merged into the feature branch. The branch is pushed and open as draft PR #4. M2-3 is not merged into `main`, and published `main` is still `21871db`. The browser recheck and owner-operated VoiceOver results, with their limits, are in the feature tracker's October 18 status. October 24 remains the owner target. No scope, date or acceptance changes, and the forecast has not been recalculated. The October 17 note below is dated history.

## Current evidence note — October 17, 2026

Read the [dated progress report](progress-report-2026-10-17.md), marker `SHOPACCESS-PROGRESS-20261017-R4`, alongside the historical plan below. M2-1 and M2-2 are merged in published main; M2-3/F07 r4 is reported locally and remains uncommitted/unpublished, with the latest browser recheck and VM screen-reader verification pending.

October 24 remains the owner target. No intermediate date, scope reduction or acceptance is approved by this note. The October 16 estimates and likely-miss forecast below have not been recalculated against the reported r4 work. A current remaining-work assessment is needed; unaccepted does not mean unstarted.


## Delivery targets
ShopAccess AI completion target: October 24, 2026, replacing Sunday October 18. No cutoff hour has been set. Wild Link begins October 24 and continues through November 12, including submission preparation. Confirm the event's exact submission cutoff before submission day. These are owner-selected targets, not validated effort estimates.

## Scope and sequence
Retain existing useful implementation and historical records. Do not remove features to fit a forecast without an owner decision.

| Milestone | Required outcome | Current planning status |
| --- | --- | --- |
| M1 Product contract and feasibility | Requirements mapped; external-store capabilities, terms and checkout mechanisms investigated; estimates and dependencies recorded | Open; this documentation update supplies tracking, not technical feasibility |
| M2 Shared shopping foundation | Website/extension API contracts; durable conversation, device profile, language and selected offers; revocable scoped permissions | Not accepted |
| M3 Conversational shopping | Follow-up questions, supported corrections, compatibility explanations, comparison and honest no-match | Initial conversation reported; expanded journey not accepted |
| M4 Discovery and extension | Verified discovery details; browser side panel; secure pairing; supported-store interaction and session continuity | Channel3 offline implementation exists; live disabled; extension not accepted |
| M5 Authorized purchasing | Item/seller/quantity/amount-bound authorization; supported merchant checkout; verified result; repeat-order revalidation | Existing sandbox safeguards reusable; expanded journey not accepted |
| M6 Inclusive acceptance | English/Spanish, voice, keyboard and screen-reader journeys with focus and status handling | Partial source and historical observations; acceptance open |
| M7 Integrated submission | Working end-to-end journey, failure cases, reproducible setup and actual-product demonstration video | Open |

M1 precedes final scheduling of M2–M7. Accessibility develops alongside each implementation milestone. All required milestones target October 24; internal dates and effort estimates are not yet established. Report this scheduling gap rather than inventing them.

## Proposed internal dates (M1 assessment, October 16)

These dates are PROPOSED, not owner-approved. They come from the estimates and dependencies in [M1 assessment](m1-assessment.md). The October 24 target and the scope are unchanged.

| Milestone | Proposed finish | Depends on | Estimate (h) |
| --- | --- | --- | --- |
| M1 | Sat Oct 17 | E1–E5 authorized and run; owner decisions | 8–11 |
| M2 | Mon Oct 19 | M1 | F02 11–19, F07 10–18 |
| M3 | Wed Oct 21 | M2 | F01 20–34, F03 11–18 |
| M4 | Wed Oct 21 | M2; live discovery only if authorized | F04 5–9, F05 18–30 |
| M5 | Thu Oct 22 | M2, M4; Sandbox run only if authorized; Checkout MCP eligibility (E2) | F06 11–21 (up to the handover only; agent completion not estimated), F08 10–20 |
| M6 | Fri Oct 23 (accessibility alongside each milestone) | M3–M5; owner VoiceOver session | F09 10–19, F10 6–11, F11 13–20 |
| M7 | Sat Oct 24 | M6; owner records the video | F12 11–20 |

These dates assume:
- at least two implementers in parallel after M2;
- at least 16 productive hours per day of combined capacity;
- the low end of every estimate;
- no failed experiment.

None of these is established.

**Forecasted miss: likely.** The estimates exclude unestimated work, notably agent-completed external checkout (the goal is unchanged), so the forecast is a lower bound, not a complete delivery forecast. Nothing here authorizes application execution or live integration.
- The critical path (M1, then F02/F07, F01, F06, then integration and submission) is about 77–126 h.
- At about 10 h/day it ends around Oct 23 at the low estimate, Oct 26 at the midpoint, and Oct 28 at the high estimate.
- Unmet criteria at risk on October 24:
  - F05/F06 extension and supported-store acceptance;
  - F08 current Sandbox journey and repeat-order revalidation;
  - F10 voice;
  - F11 final VoiceOver acceptance;
  - F12 video.

Owner options (none applied):
- add capacity;
- keep the date and accept the named gaps;
- move the date, which affects Wild Link;
- change scope.

## Acceptance journey
A shopper asks for a backup MacBook charger. The assistant clarifies the device and budget, checks compatibility, explains a shortlist, accepts corrections, and continues through a supported purchasing path under scoped user permission. Website and extension share state. Verify in English and Spanish, keyboard and screen reader, plus voice. An external retailer integration requires evidence; a controlled demo does not prove Amazon support.

## Control and reporting
Coding sessions are manually started. Scheduled read-only progress monitoring remains desired; no unattended coding is authorized by this plan. Claude maintains documentation after each work session. Agent coding ownership is not assigned yet. Record estimates as ranges with assumptions, confidence and dependencies. Do not infer elapsed work from commit timestamps or calculate completion percentages from test counts.

A forecasted miss must identify the unmet acceptance criteria and options for the owner. Dates, scope and gates cannot be changed silently. Payment, live-provider, database and deployment execution retain their existing authorization requirements.
