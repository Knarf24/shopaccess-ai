# ShopAccess AI work log
All dates use America/New_York. Claude maintains this log after each work session; other contributors provide their handoff evidence. Do not log credentials, cookies or private customer data.

## October 16, 2026 — owner-directed planning update
- Owner selected October 24 for ShopAccess AI completion, replacing Sunday October 18. Wild Link work begins October 24 and continues through November 12.
- Full expanded scope remains planned: conversational website, extension, persistent state/profiles, compatibility, external-store assistance, scoped delegated purchasing, voice, English/Spanish and accessible operation.
- Reuse existing implementation; preserve historical evidence and existing live execution gates.
- Coding remains manually started. Scheduled read-only monitoring remains desired. No coding assignments or internal milestone time estimates are established.
- Published governance was read through GitHub. The milestone plan and work log were absent at their expected paths on the default branch.
- Tracking documents and monitor instructions are being added. This entry does not claim application changes, new tests, a live call, Cursor configuration or Slack delivery.
- Next: Claude reconciles any local unpublished planning records, inspects the current implementation against the feature tracker, records feasibility findings and estimates, and keeps these published documents current.

## October 16, 2026 — M1 implementation assessment (documentation only)
Date/time: October 16, from about 06:14 (start of preservation). End time not recorded.
Goal and agreed session limit: M1 assessment of F01–F12; planning documents only.
Source branch / starting commit: local `main` at `0379134`, with unpublished planning documents. Fast-forwarded to `5eb1ed9af6b1c0277330465e9778dcefe6620a53` after preservation.
Local unpublished work reconciled:
- The October 15–16 local drafts (an October 18 plan with tasks T1–T23, a local work log, and a governance status addition) were preserved before synchronizing. They are in `git stash` ("local-unpublished-planning-docs-20261016") and in a checksummed private backup, `local-docs-preservation-20261016-061418`.
- The owner's October 24 direction supersedes their October 18 schedule. Their historical findings are carried into [M1 assessment](m1-assessment.md) with evidence labels.
- The drafts were not published, because they cite private evidence paths at length.

Changes and resulting commit: added `docs/m1-assessment.md`; added the M1 status section to `docs/feature-tracker.md`; added proposed internal dates to `docs/milestone-plan.md`; added this entry. Committed together with this entry (commit hash in `git log`; a commit cannot contain its own hash).
Checks actually run and outcomes:
- Source reading and search only.
- Official documentation was read for Shopify, Chrome and PayPal. Amazon's Conditions of Use page returned 503.
- No tests, builds, services, live calls, payments or database work.

Evidence references and evidence type: source at `5eb1ed9`, documented (see the assessment's Sources). Historical evidence is labelled private or owner-reported.
Unmet acceptance criteria / blockers: all of F01–F12 are unaccepted. E1–E5 are not authorized. The Spanish defect is undiagnosed (an untested hypothesis is recorded).
Estimate and assumptions: partial estimate of 136–239 h for F01–F12, plus 8–11 h for M1 experiments. Excludes unestimated work, notably agent-completed external checkout (still the goal), so it is not a complete delivery forecast. Forecasted miss of October 24: likely. Internal dates are proposed, not owner-approved. No application execution or live integration is authorized.
Next action: owner decisions (assessment list 1–11), then authorization of the E1–E5 experiments.
Owner decision needed, if any: yes. See [M1 assessment](m1-assessment.md#unresolved-owner-decisions).

## October 16, 2026 — M2-1 snapshot persistence (implementation, uncommitted)
Date/time: about 14:50–16:40Z (10:50–12:40 EDT), several sessions, including a usage-limit pause.
Goal and agreed session limit: approved M2-1 slices 1–5 and a mock-only browser restart check.
Source branch / starting commit: feature/m2-1-snapshot-persistence from 6cc511c. Not committed.
Changes and resulting commit:
- format-2 snapshot;
- save-first gate and recovery;
- durable runtime integration (durable.ts, runtime-access.ts, respond.ts, handlers.ts, shopping.ts, six pages);
- retry wording;
- README;
- next.config serverExternalPackages.

No commit yet.
Checks actually run and outcomes: database-free suite 41 files, 1,243 passed; typecheck 0; lint 0 errors, 9 warnings (pre-existing). Mock-only browser restart check passed.
Evidence references and evidence type: private m2-1-persistence-20261016 (unit, browser). Not published.
Unmet acceptance criteria / blockers: review and commit pending. The Security Foundation Specification v1.1 is still not found; the owner-approved direction in m2-1-plan.md §9 governs the runtime boundary.
Estimate and assumptions (or not estimated): M2-1 implementation complete; review is the remaining owner time.
Next action: owner review of the diff and evidence; then commit and push on approval.
Owner decision needed, if any: approve the commit.

## October 16, 2026 — M2-1 review corrections (uncommitted)
Date/time: about 16:40–17:05Z.
Goal and agreed session limit: two review findings, affected tests and affected browser checks.
Source branch / starting commit: feature/m2-1-snapshot-persistence (uncommitted on 6cc511c).
Changes and resulting commit: pending versus completed interpretation recovery (store.ts claimFollowUp marker, snapshot-state.ts rule); invalid persistence mode fails closed before storage (runtime.ts settings mode, runtime-access.ts). No commit.
Checks actually run and outcomes: red check, 4 new tests failed on the reversed source; affected 42/42; suite 41 files, 1,250 passed; typecheck 0; lint 0 errors, 9 warnings. Browser checks on 127.0.0.1: a completed interpretation survives a restart; an invalid mode shows the unavailable page and route 503 with the store untouched.
Evidence references and evidence type: private m2-1-persistence-20261016/CORRECTION-RECORD-20261016.md (unit, browser). Not published.
Unmet acceptance criteria / blockers: review and commit pending. The earlier all-interface dev-server launch is recorded in the private browser record.
Next action: owner review.
Owner decision needed, if any: approve the commit.

## October 16, 2026 — M2-1 review correction 2 (uncommitted)
Date/time: about 16:55–17:10Z.
Goal and agreed session limit: completed interpretation, then confirmation, then restart must not be treated as interrupted.
Source branch / starting commit: feature/m2-1-snapshot-persistence (uncommitted on 6cc511c).
Changes and resulting commit: explicit persisted interpretationPending flag (store.ts, snapshot-state.ts recovery, snapshot-store.ts format-2 validation and format-1 upgrade); correction 1's claimFollowUp notice marker reverted. No commit.
Checks actually run and outcomes: red check, 4 new tests failed under the previous rule; suite 41 files, 1,253 passed; typecheck 0; lint 0 errors, 9 warnings. Browser: interpretation, confirmation and restart on 127.0.0.1 kept the confirmed, completed state with 0 interrupted.
Evidence references and evidence type: private m2-1-persistence-20261016/CORRECTION-RECORD-2-20261016.md (unit, browser). Not published.
Unmet acceptance criteria / blockers: review and commit pending.
Next action: owner review.
Owner decision needed, if any: approve the commit.

## October 16, 2026 — M2-3 F07 purchase permissions (in progress)
Goal: website-only, single-use purchase permissions enforced on the mock checkout (`docs/m2-3-plan.md`); local and mock only.
Source branch / starting commit: feature/m2-3-purchase-permissions from main e6bb69d. Plan ac95a17; slice 1 bb33781 (model, snapshot format 4).
Changes and resulting commit: slice 2 enforces permissions at checkout start (reserve), confirmation, order creation and capture (`executing` saved before any capture), records consumed or outcome unknown, limits reconciliation to the same operation, and fails PostgreSQL checkout closed. After owner review: a definitive decline spends the checkout's confirmation (`CONFIRMATION_REQUIRED`).
Checks actually run and outcomes: suite, typecheck and lint after slice 2; red checks for every enforcement point (see below).
Red-check incident (slice 2): the first red-check run was invalid. Its backup and restore commands failed (an unquoted shell variable), so the deliberate breakages accumulated in the source. Those results were discarded and are not evidence. The source was restored by applying each edit's exact inverse, every enforcement line was checked, and the full suite passed. A known-good tar snapshot was then taken, and every red check was repeated with restoration from that snapshot after each one. All were caught by failing tests; the final working tree was byte-identical to the snapshot, and the full suite passed again.
Evidence references and evidence type: private m2-3-permissions-20261016/PROGRESS.md and run outputs (source, unit). Not published.
Unmet acceptance criteria / blockers: slice 3 (permissions page, refusal copy, EN/ES), mock browser check, security review.
Next action: slice 2 commit, then slice 3 on approval.
Owner decision needed, if any: approve slice 3.

## October 16, 2026 — M2-2 extension integration (implementation, uncommitted)
Goal: implement `docs/m2-2-plan.md` in bounded slices; mock only; review target October 19.
Source branch / starting commit: feature/m2-2-extension-integration from main b86a41b (PR #1 merge; no CI configured, no check results exist).
Changes and resulting commit: format 3 snapshot grants (digest only); pairing authority; `/api/extension/v1` (5 routes, allowlist, originless read rule); shared follow-up path for website and panel; approval page, decide and revoke routes, Paired access list (EN/ES, pairing-specific revocation message); logout revokes grants durably; `extension/` side panel promoted from E1. No commit.
Checks actually run and outcomes: per-slice gates; final suite 47 files, 1,297 passed; typecheck 0; lint 0 errors, 9 warnings. Elapsed per slice in the private progress log (about 31 minutes in all).
Evidence references and evidence type: private m2-2-extension-20261016/PROGRESS.md and run outputs (source, unit). Not published.
Browser check (owner-assisted, 127.0.0.1, mock only, 18:44–19:59Z): all plan §5 browser items observed. It found five defects, all fixed with tests: B1, an M2-1 defect (conversation and confirmation-withdrawal state could miss the saved state when routes used different module copies under the dev server; pairing did not erase saved state), B2 raw notice key in the panel, B3 focus after Send, B4 old history kept after a refused token, B5 focus after revoke. Final suite 48 files, 1,300 passed; typecheck 0; lint 0 errors, 9 warnings. Server stopped, port free.
Source review and correction round: independent review passed with notes. Corrected: the B1 record; panel messages share the website's 20-per-minute message limit; a reused request ID with a different message is refused; focus after a refused send; approval page language; behavioural panel tests for B3/B4; a misplaced comment; stale plan wording. Finding 3 (no matching code on the approval page) is an accepted carry-forward, required before any non-local use.
Unmet acceptance criteria / blockers: owner review of the corrections; screen-reader items stay open as listed in the plan §5.
Estimate and assumptions: October 19 holds.
Next action: owner review, then commit and PR without merge.
Owner decision needed, if any: approve commit and PR.

## Session entry template
Date/time:
Goal and agreed session limit:
Source branch / starting commit:
Changes and resulting commit:
Checks actually run and outcomes:
Evidence references and evidence type:
Unmet acceptance criteria / blockers:
Estimate and assumptions (or not estimated):
Next action:
Owner decision needed, if any:

No new commits does not prove no local work occurred. If local work is reported but unavailable to the monitor, record that visibility limitation.

## October 16 — Codex read-only external-store investigation
Official rules and Shopify auth/WebMCP documentation read. See [capability matrix and sources](external-store-feasibility-20261016.md). Shopify project eligibility remains unknown; browser WebMCP is a separate candidate requiring investigation. PayPal Store Sync documentation retains buyer payment approval. E5 rules-reading portion completed; E1–E4 not run. Amazon retail terms could not be retrieved. No product API calls, credentials, payments, services, database work or application changes. Estimates and internal milestone dates unchanged. Next: bounded E2 proposal with prerequisites and stop conditions; no live execution authorized.

## October 16 — full read-only feasibility investigation
Codex investigated E1–E5 dependencies and recorded [full findings and bounded proposals](full-feasibility-investigation-20261016.md). New findings: Amazon Business Ordering API exists but is distinct from personal shopping and documents 4–6 weeks onboarding; Shopify Payments test mode excludes PayPal Wallet; Chrome supports extension WebMCP and on-device speech building blocks, with actual integration untested. Existing Qwen provider, snapshot storage and config source read. Channel3 conversation offering and pricing documented, not adopted. E1–E4 and all live provider/payment experiments remain unexecuted. No coding assignments, internal dates, storage/provider decisions, credentials or source behavior changed. Source-read and primary documentation evidence only; historical acceptance unchanged.

## October 16 — E1 isolated implementation, browser acceptance open
Role: Codex implementer; owner approved design and plan. Prototype published only on branch design/shared-session-e1-20261016, commit e0be4b26f75e69a746aa91d3abfabf948f48a15c. Forty new files under experiments/e1-shared-session/; application source/payment/SQL/dependencies unchanged. Evidence: [results](https://github.com/Knarf24/shopaccess-ai/blob/e0be4b26f75e69a746aa91d3abfabf948f48a15c/experiments/e1-shared-session/evidence/RESULTS.md), [review ledger](https://github.com/Knarf24/shopaccess-ai/blob/e0be4b26f75e69a746aa91d3abfabf948f48a15c/experiments/e1-shared-session/evidence/LEDGER.md). Final PATH-only verification: 27 unit/client checks and 13 loopback checks, all exit 0, Node 24.19.0. No application suite/build, pinned-Node validation, installed-extension browser observation or screen-reader acceptance. Cloud browser failed loopback reachability. One independent review produced seven addressed findings; fixes covered by regression tests. Owned server stopped and port 3764 free. No credentials/live provider/payment calls. E1 is partial, not accepted. Next: local unpacked Chrome acceptance using the branch README, then separately reviewed application integration. Product target October 24 unchanged; no unattended coding scheduled.
