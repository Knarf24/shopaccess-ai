# ShopAccess AI work log
All dates use America/New_York. Claude maintains this log after each work session; other contributors provide their handoff evidence. Do not log credentials, cookies or private customer data.

## October 21, 2026 — localized document language (uncommitted)

- **Source:** `feature/localized-document-language` from `df69cb4`, worktree `/Users/frankncube/ownpay/shopaccess-localized-routes`. Not committed. No existing store was opened. Store variables stayed unset. No live provider was called. The no-TCP preload recorded no connect attempt.
- **Build:** `npx next build --webpack` succeeded. Turbopack still cannot follow the symlinked `node_modules`; dependencies were not changed. Typecheck exited 0 after that build. Lint exited 0 with the same 9 warnings.
- **Tests:** the default full unit run was 1,606 passed and 1 failed. `tests/unit/pg-static.test.ts` PGT-157 exceeded 5 seconds while 71 files ran together. That file was not part of the routing change. Run alone, its 53 tests passed in 3.74 seconds. The new locale-route tests and the updated page tests passed, including an unauthorized checkout that must not reveal the other session’s purchase language.
- **Production server:** memory mode on `127.0.0.1:3221`, with a disposable admission secret created for that process. `/fr/shop/needs` and `/en-US/shop/needs` were HTTP 404, `<html id="__next_error__">`, no `lang`, and no shopping text. `/en/shop/needs` and `/es/shop/needs` documents used `lang=en` and `lang=es` with the matching visible language. A Spanish draft redirected `/en/shop/needs` to `/es/shop/needs`. A second session did not receive that draft or the Spanish purchase heading. POST `/shop/needs/submit` returned 303 to `/es/shop/needs`. POST `/checkout/start` returned 303 to the unprefixed `/checkout/{id}`, which then redirected to the stored Spanish checkout. A plain-HTTP `Origin` on an admitted POST was HTTP 403. The server was stopped afterward.
- **Browser:** the same production server showed the 404 for `/fr/shop/needs` and `/en-US/shop/needs`. Back returned from the English homepage to the Spanish admission page, and forward returned to the homepage. Unauthenticated `/shop` opened English admission. Choosing Español and submitting the language form opened `/es/demo/admission` with `lang=es`. With JavaScript disabled, `/es/shop/needs` still reached that Spanish admission heading.
- **Estimate:** 42–74 hours is the current unfinished sum. 33–61 hours is the superseded calculation. The October 16 136–239 hour partial total stays historical. F03 remains unaccepted. D-category remains open. There is no screen-reader acceptance.

## October 21, 2026 — wired-checkout launch wording (documentation only)

- **Source:** `feature/f03-charger-conversation` after merge `931ca35`. No store was opened and no server was started. Product source and tests were not changed. Product tests were not rerun.
- **Change:** the README now describes this branch's wired charger conversation. A rehearsal names its commit in writing and has no default. The October 21 tracker rule keeps the foundation history, including that the foundation build writes no charger track, and states that this branch's running checkout wires the conversation under the same memory-mode and fresh-store policy.
- **Preserved:** the October 21 foundation entry below, the October 20 slice-2 evidence, and the language and accessibility limits. Spanish raw HTML still declares English before hydration. There is no screen-reader acceptance. F03 remains unaccepted. No deployment integration was found in the inspected repository and GitHub records. Externally configured hosting is unknown.

## October 21, 2026 — format-7 local launch rule (documentation only; uncommitted when written)

- **Source:** PR #10 worktree `feature/f03-charger-clarification-state` at `a1120d6`. No store was opened, copied, decoded, hashed, or migrated. No server was started and no provider was called.
- **Change:** README, `docs/paypal-sandbox-rehearsal-runbook.md` (including the snapshot-store prerequisite), `extension/README.md`, the security-foundation launch snippet, and the feature tracker now keep existing owner and rehearsal stores reserved for their current builds. Format-7 development uses memory mode or a fresh disposable store from `src/server/mock-store-init.mts`. Every memory-mode launch unsets `SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE` inside its launch subshell. The format-7 snapshot persists shopper state; checkout and payment execution, including the audit log, remain in memory. The previous server is stopped and the intended port confirmed free. Rollback uses memory mode or a separate compatible store. An older backup is not restored over later writes. There is no format-7-to-6 downgrade.
- **Distinction:** this foundation is unwired and writes no charger track. PR #11 is the separate integration and is not started or merged here. The same store rule applies to any build that contains this format-7 reader.
- **Deployment:** no deployment integration found in the inspected repository and GitHub records. Externally configured hosting is unknown.
- **Not done:** the reader still rewrites formats 1–6 on the next successful commit, including startup recovery, if it is pointed at that file. No reviewed migration or recovery procedure exists. Neither pull request is merged. Product tests were not rerun.

## October 20, 2026 — F03 charger conversation, slice 2 (Codex implementation; uncommitted)

- **Baseline:** branch `feature/f03-charger-conversation`, base `a1120d6db84689b53653089d172c8d27ae4dceb7`; worktree was clean before this task. The separate `main` checkout was not changed. PR #10 remains an unmerged draft.
- **Scope:** wire charger intent and track to the existing needs draft/conversation lifecycle; website task/model/confirm/change/stop controls; shared website/extension text routing; bilingual lines; existing charger comparison after website confirmation; serialized recommendation gating and pending-laptop-result handling. No new extension structured fields/scopes; no payment, permission, profile or SEC-01 changes intended.
- **Regressions first:** initial charger-request handler tests and a charger follow-up test failed before routing was added; the website-control test failed before the control handler existed; the task-choice text regression failed before the state transition was corrected. Test outputs, including red runs, are retained under fresh `/private/tmp/shopaccess-charger-conversation-*` labels and copied to the frozen handoff.
- **Verification (Codex implementer-run, network-blocked runner):** final focused follow-up/page/extension/handler regressions: 4 files, 49 passed (r23); full unit suite: 68 files, 1,583 passed (r24); final-tree typecheck: exit 0 (r28; earlier successful r25 also covered the functional changes); lint: 0 errors, 9 existing warnings (r27). Red runs are retained, including the initial charger-routing failures, missing website handler, task-choice transition, and explicit-cleared-fields regression. The full suite initially exposed a missing mock-route inventory entry (r19); the test inventory was corrected and r24 passed. `git diff --check` passes. All project checks used the existing no-TCP preload. The initial non-escalated typecheck could not write `tsconfig.tsbuildinfo`; the authorized guarded rerun passed. Logs are copied into the frozen handoff. These are implementer results, not independent verification.
- **Status/limits:** Codex is the implementer, not the independent reviewer. Format-7 merge/rollout and rollback remain gated, and no owner/rehearsal store was opened or migrated. F03 remains unaccepted; screen-reader, native-speaker and browser acceptance are not claimed. October 24 and the full scope are unchanged.

## October 19, 2026 — F03 charger clarification, slice 1 (state, transitions, proposed format 7; uncommitted when written)

- **Baseline:** `main` `37f6b30c7a811d538d0b92e1b4d88d9156991a1e` (PR #9 merged); new worktree on `feature/f03-charger-clarification-state`.
- **Scope:** new `src/lib/compatibility/charger-intent.ts` and `src/lib/session/charger-clarification.ts`; snapshot format 7 in `snapshot-store.ts`, `snapshot-state.ts` and `durable.ts`. Not wired into handlers, pages or the extension; no provider path.
- **Format 7 compatibility:** startup recovery writes format 7; readers limited to format 6 or older reject it. No owner or rehearsal store was opened or migrated; merge, rollout and rollback remain gated.
- **Regressions first:** red import-level run, then export-only stubs (32 failed, 6 passed), then green. Fifteen existing test files received fixture keys and "written as format 7" expectations only.
- **Corrections:** c1 (self-review): NFC before cue matching; charger lines accepted from the format that introduced them; direct coverage of draft replacement and of charger lines without a track. c2: memory-mode changes remove a deleted or replaced draft's charger track and keep a valid track for the new draft; startup recovery of a format-6 store tested. c3: `DurableHost.change` callbacks are synchronous by type.
- **Checks (Claude, network-blocked runner):**
  - c2 (latest full run): full suite 66 files, 1,562 passed; focused 16 files, 243 passed; typecheck 0; lint 0 errors (9 existing warnings).
  - c3 (type-only, full suite not rerun): typecheck first exited 2 with six unused `@ts-expect-error` directives (the red check), then 0; a scratch compile showed each of the six cases rejected; focused 9 files, 138 passed; lint first reported one `no-explicit-any` error in the new test, then 0 errors (9 existing warnings).
  - No connection attempt was logged.
- **Codex reviews (source and saved evidence only; Codex ran no checks; texts relayed through the owner):** the review of the handoff and c1 named an invalid manifest self-entry and led to c2; the c2 review found the memory-mode cleanup resolved and identified the synchronous-callback contract gap separately; c3 verdict: that finding is resolved, with no concrete c3 blocker.
- **Evidence:** the first private manifest's self-entry (empty-file hash) cannot verify and is kept as written; later manifests exclude checksum files. All frozen handoffs and outputs are kept.
- **Not done:** slice 2; browser, screen-reader and native-speaker checks. F03 unaccepted; D-category open.

## October 19, 2026 — F03 device hand-off from the guided needs page (uncommitted when written)

- **Baseline:** `main` `ed027c13cfb635d4356a687480429573a7272a29` (PR #8 merged); new worktree on `feature/f03-device-handoff`.
- **Change:** a native GET hand-off form on the guided needs page (new server component), with English/Spanish labels in the charger copy module; the existing charger link stays. It sends only the chosen exact model and the journey language to the existing charger page; nothing is saved.
- **Regressions first:** a new test file covering the form's markup in both languages (only curated options, empty placeholder selected, hidden language), saved-draft language precedence, no pre-selection from needs text, a saved profile or a URL device, the charger page reached with the form's query, empty choice and unknown/prototype-named identifiers, no change to draft, conversation, profile, permission, grant or extension view, no provider call, and a source guard. Red: 5 failed (form absent), 3 passed (existing charger-page behaviour the hand-off relies on).
- **Checks (Claude, network-blocked runner):** focused 8 files, 117 passed (hand-off, charger, needs-flow, current-step, SEC-01 and extension tests); full suite 63 files, 1,517 passed; typecheck exit 0 after a test-typing correction (the first typecheck exited 2 on the new test file; that output is kept); lint 0 errors (9 warnings in untouched files).
- **Evidence correction:** Codex reviewed the saved Apple captures against the claims and reviewed the subsequent correction; it did not verify live pages or rerun tests. This replaces the "capture hashes verified" wording of the October 18–19 entries for future reference; those entries stay as written.
- **Codex source review (relayed through ChatGPT; source and saved evidence only, no tests, browsers or services):** identity verified and unchanged; all 44 handoff checksum entries and six live-file hashes matched; no concrete defect or demonstrated commit blocker; the form sends only device and resolved language, starts with an empty placeholder, preserves saved-draft language precedence and is not nested inside another form; no profile inference, unrelated mutation or provider call introduced; tests render the actual needs and charger pages. This review preceded, and is separate from, the browser run below.
- **Browser observations (mock-only, isolated headless contexts, loopback only):** 44 checks passed (EN/ES: empty initial selection, empty choice unidentified, both models reach their results, only model and language sent, keyboard reach/select/submit, saved-draft language precedence, no state-changing request besides the deliberate draft submission; first Tab after the native navigation reached the skip link). Three earlier attempts stopped on test-harness issues (route-announcer alert match, navigation timing, a screenshot-induced hydration warning); all kept.
- **Not done:** screen-reader or native-speaker acceptance. F03 unaccepted.

## October 18–19, 2026 — F03 charger information slice (uncommitted when written)

- **Baseline:** `main` `bb878525f3c9bcf2bc90d47da5b681f58d73bab4`; new worktree on `feature/f03-charger-info`.
- **Curation first:** eight public Apple pages saved privately with hashes; every cited excerpt matched in the saved copies. The 70W store page, first reported from a ChatGPT retrieval, was captured independently.
- **Implementation:** evidence registry and rules (`src/lib/compatibility/`), the `/shop/chargers` page and component, English/Spanish copy, and a needs-page link. Regressions were written before each change and shown failing.
- **Corrections after review:** Codex's raw-source finding (absence of "USB-C" had been treated as "no USB-C") → the 2015 USB-C rows are unknown and "unsupported" needs positive completeness evidence; Codex's disclaimer finding → neutral disclaimer (resolved); owner-requested cable qualification on the MacBook Air + 140W + USB-C charge-cable row; control-border correction after a measured 1:1 boundary on the identifier field.
- **Codex final-delta review (relayed through ChatGPT; source and saved evidence only, no tests run):** identity checks passed; the cable disclosure is correctly scoped in both languages and invents no rating; the control styling preserves native semantics, labels, submission and focus behaviour; rules, evidence mappings and the needs link are unchanged; no concrete defect or demonstrated commit blocker. Accessibility limitations and F03 acceptance remain open.
- **Session boundary:** the charger page applies the existing demo-admission cookie guard but resolves or creates no shopper session.
- **Checks:** last full suite 62 files and 1,501 passed (before the disclaimer, cable-note and styling changes); final focused checks 4 files and 62 passed, typecheck 0, lint 0 errors (9 warnings in untouched files). Browser: 100 direct-load checks and 80 control checks passed (mock-only, development server, isolated contexts). Two superseded outputs were deleted during earlier reruns and remain unavailable.
- **Open:** development-overlay focus after client-side navigation (production and screen-reader effects unverified); global focus-outline contrast 1.82:1; mobile selector truncation; 2px Spanish table scroll at 390px. No screen-reader, native-speaker or product acceptance; no purchasing or profile integration. F03 unaccepted.

## October 18, 2026 — finding 9: message lookup limited to own keys (uncommitted when written)

- **Baseline:** `main` `5dbd4d66ced5189505680276bca3d5d2ad3e6475` (PR #6 merged), new worktree on `fix/finding-9-message-lookup`; `node_modules` linked to the existing install (no install).
- **Regressions first** (`tests/unit/message-lookup.test.tsx`): the helper and four page paths, each with a recognized-message control. Red: 5 failed | 2 passed — the helper returned `Object.prototype` and native functions; `__proto__` stopped page content rendering; the other names gave empty alerts with React's "Functions are not valid as a React child".
- **Fix:** own-key lookup in `messageFor`, generic fallback unchanged.
- **Final (network-blocked runner):** focused 5 files, 94 passed; full suite 59 files, 1,470 passed; lint 0 errors (9 existing warnings). Typecheck first failed in the untouched `src/app/layout.tsx` (`LayoutProps` missing) because the new worktree had no generated Next route types; after `next typegen` (offline, same network block, ignored files only) typecheck exit 0.
- **Test description correction:** in the PostgreSQL page tests the PostgreSQL `/shop` view mock delegates to the in-memory shopping-view builder; the cookie, session, checkout-list and checkout-view reads return fixed test values. None connects to PostgreSQL.
- **Codex review (source and saved evidence; tests not rerun):** finding 9 resolved, no demonstrated commit blocker. Database behaviour remains unverified.
- **Not run:** browsers, services, databases, providers. Acceptance unchanged.

## October 18, 2026 — optional device profile (documentation uncommitted when written)

- **Source:** `feature/device-profile` `8059280bfb33558000477ef7cc2545b092109839`, parent and current `main` `e3c582967adb4897b144c2c4c7436eb137ffa035`. Pushed to `origin` without force. Not merged into `main`.
- **Implementation (Cursor):** one optional brand and one optional model on the live website session. Each field has its own consent, and withdrawing consent discards that field. Format 6 keeps a revision marker of session id and version, with no brand or model, so a retained form cannot match a profile created after deletion. Logout, expiry, and recovery of a dead session drop the marker. Recommendations and the extension do not read the profile.
- **Codex, source only:** r1 identified that deletion and recreation reused version 1. r2 assessed the marker correction and found no demonstrated defect in r2-era deletion and recreation. A format-5 file stores no deleted-profile history, so protection for a form issued before the upgrade remains limited.
- **r2 checks, recorded before r3 and not rerun:** 58 files and 1,456 tests passed; typecheck exited 0; lint exited 0 with nine warnings.
- **r3:** tests only. Focused `tests/unit/device-profile.test.ts`, 25 tests passed. The full suite, typecheck, and lint were not rerun.
- **Rollback:** a reader that accepts only an older format rejects a format-6 file. Restoring an earlier `store.json` loses subsequent writes, including permission outcomes. No real-store migration is authorized.
- **Outstanding:** no browser check and no screen-reader check have occurred. F02 remains unaccepted. October 24 and the full scope are unchanged.

## October 18, 2026 — Spanish checkout cleanup and Codex reviews r1–r2 (uncommitted when written)

- **Base:** `d277b27e5c60d382bed80731d4c3398b4d3211e5`. Owner-approved implementation of finding 8's checkout part; see the feature tracker entry of the same date for scope.
- **Implementer-run (Claude), r1:** new regressions red before the change (10 failed | 53 passed); after it, focused 63 passed, full suite 56 files and 1,433 passed, typecheck 0, lint 0 errors. Mock-only browser check (server run 11): Spanish permissions review and list markers, Spanish checkout heading, notice, quote, total and start link; simulated panel English; `&lang=en` changed nothing.
- **Codex r1 (source review):** two findings — inherited property names in `checkoutMessage`'s English branch; no decline explanation after a provider-proven capture decline.
- **Implementer-run (Claude), r2:** new regressions red against r1 (4 failed | 21 passed: English prototype codes threw "Objects are not valid as a React child"; decline explanation missing in English and Spanish; unit lookup returned an object). After the fix: focused 67 passed, full suite 56 files and 1,437 passed, typecheck 0, lint 0 errors. No browser or Sandbox run for r2.
- **Codex r2 (source and saved evidence; tests not rerun):** both corrections resolved, no demonstrated commit blocker. Optional decline-wording refinement not adopted. Residual tracked as finding 9 (`messageFor` inherited properties in `/shop` mock and PostgreSQL, `/checkouts` and the PostgreSQL checkout).
- **Language evidence limits:** Spanish wording is source-reviewed only (no native-speaker or VoiceOver pronunciation acceptance). Native `<option>` choices are not language-marked.
- **Private records:** frozen patches and evidence in the r1 and r2 handoffs outside Git, both unchanged after review. F07, F08, F11 and A35 remain unaccepted.

## October 18, 2026 — PayPal Sandbox rehearsal on `401556a` (owner-authorized; documentation only)

- **Source check (each attempt):** HEAD `f6140065e7ae6b54bd59c2cc127dbd089d861b6d`, application tree `1f2b49e1bb26e13ce475069f78d0369ae9acf75b`, equal to `main` `401556a`; only the README and the runbook differed (uncommitted documentation). Store backed up first; no `.env` in the repository; port 3000 free.
- **Attempt 1, 10:30–11:30 window (incomplete, history):** permission, quote and confirmation; one order-creation press at 10:33:45; the browser reached the PayPal Sandbox sign-in page. No return or capture request reached the app. The window expired; the owner stopped the run at about 13:48 and the server, which had run past the cutoff, was stopped at 13:48:59 with no payment action logged or reported after 10:33:45. PayPal's state of that order was not queried and is unknown.
- **Attempt 2, supervised, 13:51:46–14:21:46 (app-reported success):**
  - Automatic shutdown at the cutoff, with a five-minute warning, was tested on a dummy process and armed before any PayPal call.
  - Observed: fresh permission (Acer Aspire Go 15, 8 GB / 256 GB, quantity 1, up to USD 579.99, one hour), fresh quote and checkout, confirmation; one order-creation press (13:53:51); owner signed in and approved on PayPal Sandbox after checking USD 579.99 (owner-reported); one return request; one capture press (14:05:11).
  - App-reported: "PayPal Sandbox confirmed approval of this order. No payment has been captured.", then "The payment was captured and the capture evidence was checked."; permission "Used".
  - Not observed: actual outbound PayPal request counts or 401 resends (ceilings are source-derived). Not corroborated: PayPal dashboard and capture ID.
  - Server stopped by hand at 14:05:41, 16 minutes before the cutoff; watchdog exited; port 3000 free; tab closed.
- **Also recorded:** PayPal's sign-in page showed "Something went wrong. Try again later." before sign-in in attempt 2 (cause unknown); two read-only permissions-page loads not made by the automation appeared in each attempt's log.
- **Evidence:** private, outside Git (logs, result screenshot, checksums). No credential value appears in any log. No source change, install, commit, push or deployment. F07, F08, F11 and A35 remain unaccepted.

## October 18, 2026 — current status, and integration of published main (documentation only)

- **Published:** `main` at `21871db078790e97cf10d8b62b35214bada768eb` (documentation PR #3 on top of `e6bb69d`). It includes M2-1 (PR #1) and M2-2 (PR #2).
- **M2-3 / F07:** committed on `feature/m2-3-purchase-permissions`: plan `ac95a17`, slice 1 `bb33781`, slice 2 `42e9b7e`, slice 3 `e2c1b05ee16198f43a3009bc94c41aa45fdeb11d`, and merge `a142e959b743eff95b1899dd4dedbe8ea205351f`, by which **`main` (`21871db`) was merged into the feature branch** (documentation only). The branch is **pushed** to `origin` and is open as **draft PR #4** (https://github.com/Knarf24/shopaccess-ai/pull/4): base `main` `21871db`, head `a142e95`. **M2-3 is not merged into `main`**, so the monitor, which reads `main` only, does not see it. GitHub reports no checks, because no CI is configured; that means unverified, not passing.
- **Since the October 17 report:**
  - **Automated mock browser recheck R1–R8 (Claude in Chrome):** R1–R7 passed. R8 partly passed: permission recovery and the not-found page passed, but the HTTP status was 200, not 404. Browser-profile isolation was incomplete.
  - **Owner-operated VoiceOver on the owner's Mac (plan §10 amended):** limited English observations; validation-error speech inconclusive; other speech unverified.
  - **Checkout language-marker correction (r5):** Codex's focused review found no concrete defect and no demonstrated commit blocker, with source-inspection and test-coverage qualifications.
  - **Implementer-run gate:** 55 files, 1,413 passed; typecheck 0; lint 0 errors.
- **Still open:**
  - finding 7 (proposal) and finding 8 (tracked);
  - per-item VoiceOver speech;
  - M2-2 finding 3 before any non-local use;
  - F07, F11 and A35 acceptance.
- **Unchanged:** the October 24 target and the full scope. The likely-miss forecast is unresolved.

**Integration.** A non-rebasing merge of `main` at `21871db` (PR #3) into the local branch. Git merged it with no conflicts. The October 18 status entries were added; the October 17 and older entries remain dated history. Relative to `e2c1b05`, only documentation changes. Not committed or pushed until the owner approves. *(Later on October 18, each step was separately owner-approved: committed as merge `a142e959b743eff95b1899dd4dedbe8ea205351f`, pushed without force to `origin/feature/m2-3-purchase-permissions`, and opened as draft PR #4. `main` was merged into the feature branch; M2-3 is not merged into `main`.)*

**Correction to the slice 3 commit message** (the commit is not amended):
- "The reviewers did not rerun the tests" is accurate only for Codex.
- The two Claude subagent reviews ran network-blocked checks:
  - the first ran 5 related test files (101 passed), typecheck and lint;
  - the second ran 119 related tests, the full suite (1,401 passed), typecheck and lint, on the states they reviewed.
- The message also omits Codex's r3 review, which found the two SEC-01 findings that r4 fixed.

## October 17, 2026 — published/local progress reconciliation

Goal: make current progress visible to the existing read-only monitor without publishing unfinished M2-3 source.

Source inspected through GitHub: main `e6bb69dbac7127786425c299667a45a3930a833b`. PR #1 and PR #2 are confirmed merged. Earlier M2-1/M2-2 entries below remain the historical pre-merge records; this entry corrects their current publication status.

Changes: added the [dated progress report](progress-report-2026-10-17.md), marker `SHOPACCESS-PROGRESS-20261017-R4`; linked it from the tracker and milestone plan; added publication-status notes to the M2 plans and monitor verification instructions. Application source is unchanged.

Evidence: direct read-only GitHub metadata for the published state; owner-supplied Claude and Codex reports for private M2-3 r4. Reported local HEAD is `42e9b7e9b51db179bd10d5a0822a946a1b48d4a9`; source is uncommitted and unpublished. Codex reports no confirmed blocker remaining from the two prior SEC-01 findings, subject to the documented parser/unresolved-path limitations. Saved 1,410-test/typecheck/lint results are implementer-generated, not independently rerun by the publishing session.

Checks: documentation, links, changed paths and GitHub diff inspection only. No application tests, builds, browsers, services, databases, payments or live-provider calls were run by this publishing session.

Monitoring: the owner's 20:04 EDT Cursor report inspected main e6bb69d and reached the owner's Slack. That does not establish access to unpublished work or ingestion of this new record. Existing schedule/settings were not inspected or changed.

Remaining: latest-correction browser recheck, separate VM screen-reader verification, owner commit/integration decision; finding 7 proposed and finding 8 tracked. October 24 and the expanded scope are unchanged. No acceptance status changes.

Next: review/merge the documentation-only PR through the approved workflow, then run the existing monitor once and verify the publication commit, marker and Slack receipt. This entry does not itself authorize merge, a monitor run, source execution or a stage change.


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

## October 16, 2026 — M2-1 snapshot persistence (implementation — uncommitted when written; since committed as 08e6e6a and merged to main as b86a41b (PR #1))
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

## October 16, 2026 — M2-1 review corrections (uncommitted when written; since committed as 08e6e6a and merged to main as b86a41b (PR #1))
Date/time: about 16:40–17:05Z.
Goal and agreed session limit: two review findings, affected tests and affected browser checks.
Source branch / starting commit: feature/m2-1-snapshot-persistence (uncommitted on 6cc511c).
Changes and resulting commit: pending versus completed interpretation recovery (store.ts claimFollowUp marker, snapshot-state.ts rule); invalid persistence mode fails closed before storage (runtime.ts settings mode, runtime-access.ts). No commit.
Checks actually run and outcomes: red check, 4 new tests failed on the reversed source; affected 42/42; suite 41 files, 1,250 passed; typecheck 0; lint 0 errors, 9 warnings. Browser checks on 127.0.0.1: a completed interpretation survives a restart; an invalid mode shows the unavailable page and route 503 with the store untouched.
Evidence references and evidence type: private m2-1-persistence-20261016/CORRECTION-RECORD-20261016.md (unit, browser). Not published.
Unmet acceptance criteria / blockers: review and commit pending. The earlier all-interface dev-server launch is recorded in the private browser record.
Next action: owner review.
Owner decision needed, if any: approve the commit.

## October 16, 2026 — M2-1 review correction 2 (uncommitted when written; since committed as 08e6e6a and merged to main as b86a41b (PR #1))
Date/time: about 16:55–17:10Z.
Goal and agreed session limit: completed interpretation, then confirmation, then restart must not be treated as interrupted.
Source branch / starting commit: feature/m2-1-snapshot-persistence (uncommitted on 6cc511c).
Changes and resulting commit: explicit persisted interpretationPending flag (store.ts, snapshot-state.ts recovery, snapshot-store.ts format-2 validation and format-1 upgrade); correction 1's claimFollowUp notice marker reverted. No commit.
Checks actually run and outcomes: red check, 4 new tests failed under the previous rule; suite 41 files, 1,253 passed; typecheck 0; lint 0 errors, 9 warnings. Browser: interpretation, confirmation and restart on 127.0.0.1 kept the confirmed, completed state with 0 interrupted.
Evidence references and evidence type: private m2-1-persistence-20261016/CORRECTION-RECORD-2-20261016.md (unit, browser). Not published.
Unmet acceptance criteria / blockers: review and commit pending.
Next action: owner review.
Owner decision needed, if any: approve the commit.

## October 16, 2026 — M2-3 F07 purchase permissions (in progress when written; slices since committed as `bb33781`, `42e9b7e` and `e2c1b05`; draft PR #4)
Goal: website-only, single-use purchase permissions enforced on the mock checkout (`docs/m2-3-plan.md`); local and mock only.
Source branch / starting commit: feature/m2-3-purchase-permissions from main e6bb69d. Plan ac95a17; slice 1 bb33781 (model, snapshot format 4).
Changes and resulting commit: slice 2 enforces permissions at checkout start (reserve), confirmation, order creation and capture (`executing` saved before any capture), records consumed or outcome unknown, limits reconciliation to the same operation, and fails PostgreSQL checkout closed. After owner review: a definitive decline spends the checkout's confirmation (`CONFIRMATION_REQUIRED`).
Checks actually run and outcomes: suite, typecheck and lint after slice 2; red checks for every enforcement point (see below).
Red-check incident (slice 2): the first red-check run was invalid. Its backup and restore commands failed (an unquoted shell variable), so the deliberate breakages accumulated in the source. Those results were discarded and are not evidence. The source was restored by applying each edit's exact inverse, every enforcement line was checked, and the full suite passed. A known-good tar snapshot was then taken, and every red check was repeated with restoration from that snapshot after each one. All were caught by failing tests; the final working tree was byte-identical to the snapshot, and the full suite passed again.
Evidence references and evidence type: private m2-3-permissions-20261016/PROGRESS.md and run outputs (source, unit). Not published.
Unmet acceptance criteria / blockers: slice 3 (permissions page, refusal copy, EN/ES), mock browser check, security review.
Next action: slice 2 commit, then slice 3 on approval.
Owner decision needed, if any: approve slice 3.

## October 16, 2026 — M2-2 extension integration (implementation — uncommitted when written; since committed as cb09a94 and merged to main as e6bb69d, PR #2)
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

## October 16–17, 2026 — M2-3 slice 3, browser check and corrections (uncommitted when written; since committed as `e2c1b05`, pushed, draft PR #4)
Date/time (UTC, recorded): slice 3 22:23–22:35Z Oct 16. Owner-assisted browser check: server run 1 from 22:37Z Oct 16 to 18:40Z Oct 17, then run 2 to 21:17Z. These spans include idle periods; active time was not recorded. Accessibility, language and D2 corrections: evidence runs 21:24–22:20Z Oct 17. Automated browser recheck 22:22–22:25Z.
Goal and agreed session limit: slice 3 and its mock browser verification; then owner-directed accessibility and language corrections and the D2 fix. No Slice 4, no voice work.
Source branch / starting commit: feature/m2-3-purchase-permissions at 42e9b7e (base e6bb69d). Not pushed.
Changes and resulting commit: permissions page and routes, EN/ES refusal copy, capture-unsaved wording. D1: the permission label was visible; replaced with plain text. Focus moves on the permissions page. Skip links on /shop and the checkout. Spanish "(simulada)" seller descriptor. D2: a reloaded checkout shows the permission refusal instead of the generic message. One security-test allowlist entry (FocusOnArrival, React import only) needs owner review. No commit.
Checks actually run and outcomes: current tree 54 files, 1,390 passed; typecheck 0; lint 0 errors, 9 warnings; red checks caught for every fix. Owner browser scenarios 1–8 passed after retries. The retries were caused by expiry and timing limits, not defects. Two defects, D1 and D2, were found and fixed. Automated browser recheck passed. Screen reader not performed.
Evidence references and evidence type: private m2-3-permissions-20261016/PROGRESS.md and run outputs (source, unit, manual browser, automated browser), kept separate. Not published.
Source reviews and corrections (October 17, owner-approved): two read-only reviews by separate Claude subagents. The first found six issues: the SEC-01 exception, contradictory or missing checkout refusals, a misleading reason after re-permission, "nothing was charged" from a URL code, and the unsaved-capture answer. The second found residual SEC-01 bypasses, missing sandbox Cancel, an untested sandbox unsaved-capture path and an unknown-order message gap. Each condition was reproduced before fixing, except where it is noted as a fixture-only path; each fix has a red-checked test. Current: 55 files, 1,406 passed; typecheck 0; lint 0 errors, 9 warnings. An independent Codex review of the frozen state is pending.
Codex independent review of the r3 handoff (October 17): two SEC-01 findings. Both were reproduced through the repository's own collector and checker on a temporary source tree before fixing. The collector now includes `.mts` and `.cts`. Imports are read with the TypeScript parser and resolved through the `@/` alias, relative paths and explicit suffixes, and computed `import()`/`require()` specifiers are refused. Current: 55 files, 1,410 passed; typecheck 0; lint 0 errors, 9 warnings. Codex's focused, read-only re-review of r4 found both SEC-01 findings resolved and no new concrete defect. Its qualification: parser diagnostics are not checked, and unresolved literal paths are not refused. It did not rerun tests. SEC-01 implementation stops here unless new evidence shows a concrete defect.
Automated browser recheck R1–R8 (October 18 01:35–01:48Z, Claude in Chrome, owner-authorised, mock only on 127.0.0.1, real timers): R1–R7 passed. R8 partly passed: permissions recovered exactly as expected and the not-found page rendered, but the HTTP status was 200, not the 404 the procedure expected. That is consistent with documented Next.js streaming behaviour, not confirmed for each request. The session was not isolated: the shared Chrome profile let the owner's open tabs send two unrelated GET requests, and every POST in the logs belongs to the automation. Recorded separately from owner observations; screenshots are in private evidence. Server stopped, port free.
Screen-reader evidence audit and owner-operated VoiceOver (October 18, §10 amended by the owner):
- No earlier speech evidence covered M2-3 screens.
- The owner reported a general positive impression only. The validation-error speech check was inconclusive, because the session had ended.
- Follow-on automated browser checks, with no speech inferred:
  - the Spanish checkout refusal works by keyboard, but the checkout page sets no `lang`, so the Spanish text inherits `lang="en"` (pre-existing at page level, not fixed);
  - both `/shop` keyboard gaps are closed;
  - the focus re-fire on reload is confirmed;
  - the slow-load focus jump is inconclusive.
- Per-item speech remains unverified.
Owner-reported VoiceOver speech (supplied October 18, 04:26–04:32Z): English arrival ("Skip to the current step", "Purchase permissions") and the Item, Quantity, Total, Expiry and Review controls, with caption support for Item and Total. The validation-error speech check is still inconclusive.
Checkout language-marker correction (owner-approved, October 18):
- the page is marked with its resolved language, and the English-only parts of a Spanish checkout are marked English;
- 3 page-render tests added; 6 red checks caught;
- suite 55 files, 1,413 passed; typecheck 0; lint 0 errors, 9 warnings;
- a mock-only browser check (markup only, no pronunciation inferred) confirmed the Spanish and English markers.
Handoff r5 prepared for Codex. Codex's focused review of r5 found no concrete defect and no demonstrated commit blocker, with its source-inspection and test-coverage qualifications.
Codex slices 1–2 review corrections (owner-approved, October 18; working tree, uncommitted):
- finding 1: the sandbox cancel-return page derived "No payment has been captured" and its Cancel form from nothing. It now classifies the saved payment state, capture context and capture operations, offers Cancel only where the state machine allows it, and links back to the checkout. The classifier adds no payment or permission mutation. Correction to the first handoff, which called the remaining housekeeping unrelated to payments and permissions: the existing `runtime.maintain()` cleanup of revoked and expired sessions can remove those sessions' permissions (snapshot mode) and local mock checkout data, and session resolution updates session activity;
- finding 2: a permission creation queued behind a logout whose save was still pending could be created for the revoked session. Creation now rechecks session liveness and reads the session expiry inside its serialized decision;
- 10 regression tests (implementer-run): written first, 4 failing as intended before the fixes; 7 finding-1 and the full finding-2 reversal caught; a negative control (logout released before creation) fails the interleaving assertion. Removing only one of the two finding-2 parts is not caught, because the other still refuses (defence in depth);
- suite 55 files, 1,423 passed; typecheck 0; lint 0 errors, 9 warnings. Focused handoff prepared for Codex;
- Codex's focused review (owner-reported, October 18): it inspected the source and the saved evidence and did not rerun tests. Both findings are resolved, with no demonstrated blocker. F07, F11 and A35 acceptance is unchanged.
Unmet acceptance criteria / blockers: the remaining VoiceOver speech items (unverified); owner approval to commit and push.
Estimate and assumptions: see the reconciliation forecast reported to the owner on October 17 (proposed, not approved).
Next action: owner source review, then the slice 3 commit on approval.
Owner decision needed, if any: yes. Approve the commit, the SEC-01 allowlist entry, and the open governance decisions.
