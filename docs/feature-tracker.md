# ShopAccess AI feature and evidence tracker
Updated October 16, 2026. Target: October 24. Initial status reflects published governance and owner-supplied reports, not a fresh implementation audit.

## F03 device hand-off from the guided needs page — October 19, 2026 (uncommitted when written)

The sections below stay dated history. This entry does not accept F03 or decide D-category.

- **Source:** branch `feature/f03-device-handoff` from `main` `ed027c13cfb635d4356a687480429573a7272a29`.
- **Change:** beside the existing "Explore charger information" link, the guided needs page shows a native GET form to `/shop/chargers`. The shopper chooses one exact curated model (MacBook Air (M2, 2022) `Mac14,2` or MacBook Pro (Retina, 13-inch, Early 2015) `MacBookPro12,1`) and presses the button; the empty placeholder is selected by default. The form sends only the chosen model and the journey's language (a saved draft's language still wins over the URL) to the existing results page, which validates the model as before. Nothing is saved or remembered.
- **Boundaries:** no draft or snapshot change, no profile read, no conversation update, no extension change, no AI or product-search call, no purchase, catalogue or payment change. The needs text and any saved profile never choose or suggest a model. Unknown or prototype-named identifiers stay unidentified. Server-rendered; no client code; SEC-01 unchanged. English/Spanish labels live in the charger copy module.
- **Evidence correction (supersedes the PR #8 wording "Codex verified the capture hashes"):** Codex reviewed the saved Apple captures against the claims and reviewed the subsequent correction. It did not verify live pages or rerun tests. Earlier dated entries and private handoffs are kept as written.
- **Checks:** see the work log entry of the same date.
- **Codex source review of the hand-off (relayed through ChatGPT; separate from the browser run below):** "Identity verified and unchanged at the end. All 44 handoff checksum entries and six live-file hashes matched. No concrete defect or demonstrated commit blocker found. The form sends only device and resolved language, starts with an empty placeholder, preserves saved-draft language precedence, and is not nested inside another form. No profile inference, unrelated mutation or provider call was introduced. Tests render the actual needs and charger pages. Codex inspected source and saved evidence only; it ran no tests, browsers or services."
- **Browser observations (mock-only development server, isolated headless contexts, loopback only):** 44 checks passed in English and Spanish: nothing selected initially; an empty choice identifies no device; each curated model reaches its results; the form sends only the model and language; keyboard users reach the selector in 8 Tab presses, select by typing and submit with Enter; a saved draft's language wins over a conflicting URL language; the only state-changing request was the deliberate draft submission. After the form's native navigation the first Tab reached the charger page's skip link (recorded separately from the open client-link focus finding). Earlier attempts stopped on test-harness issues (Next.js route announcer matched as an alert; reading before navigation finished; a hydration warning caused by the screenshot tool's caret-hiding style) and are kept as evidence.
- **Status:** F03 remains unaccepted; October 24 and the full scope are unchanged.

## F03 charger information slice — October 18–19, 2026 (uncommitted when written)

The sections below stay dated history. This entry does not accept F03 or decide D-category.

- **Source:** branch `feature/f03-charger-info` from `main` `bb878525f3c9bcf2bc90d47da5b681f58d73bab4`.
- **Scope:** an information-only English/Spanish page, `/shop/chargers`. The shopper chooses MacBook Air (M2, 2022) `Mac14,2` or MacBook Pro (Retina, 13-inch, Early 2015) `MacBookPro12,1`, or types an exact model identifier. A description such as "MacBook Pro 2019" stays unidentified. The page compares Apple's 70W (A2743) and 140W (A2452) USB-C adapters, each with Apple's USB-C to MagSafe 3 Cable and a USB-C charge cable. The guided needs page links to it in the journey's language; a saved draft's language still takes precedence over the URL. Nothing is sold; no profile, extension, AI, discovery or payment use. The page applies the existing demo-admission cookie guard but resolves or creates no shopper session. PostgreSQL mode shows "not available" without requesting services.
- **Claims (three per configuration, each with its own sources):**
  - MacBook Air + 70W, either cable: Apple-listed; wattage at or above the 30W/35W adapter Apple included; fast charging listed by Apple.
  - MacBook Air + 140W, either cable: supported only through Apple's fast-charge list; on the USB-C charge-cable row the page adds that Apple names a USB-C charge cable without a power rating, so the result does not establish that every USB-C cable is suitable.
  - MacBook Pro (Early 2015), all four configurations: unknown. Apple documents its MagSafe 2 power port; the captured sources do not say whether a MagSafe 3 connector fits it, and do not address charging through a USB-C charge cable.
  - No curated configuration is unsupported. "Unsupported" requires positive evidence that a device's charging-port list is complete; that branch is tested only with labelled synthetic evidence. Wattage and fast charging are evaluated independently of basic support.
  - A shared disclaimer states that each result reflects the captured Apple sources, an unknown result is not a compatibility recommendation, and an Apple-listed configuration is not necessarily one Apple tested on that model. Adapter model numbers come from Apple test footnotes about other Mac models.
- **Evidence:** eight public Apple pages were saved privately with recorded hashes (outside Git); the page cites each source with its access date.
- **Codex reviews (source and saved evidence; Codex did not rerun tests):** the first source review found no rule defect. A raw-source review found that "no USB-C" had been inferred from absence; corrected (the 2015 USB-C rows became unknown). A finding that the shared note implied every row was Apple-listed was resolved by the neutral disclaimer. Codex verified the capture hashes; hash matching alone does not establish that the sources support the claims. The final focused delta (cable qualification and control-border correction), as relayed through ChatGPT: "All identity checks passed. The cable disclosure is correctly scoped in both languages and invents no rating. Control styling preserves native semantics, labels, submission and focus behavior. Rules, evidence mappings and the needs link are unchanged. No concrete defect or demonstrated commit blocker was found. Codex inspected source and saved evidence only; it ran no tests. Accessibility limitations and F03 acceptance remain open."
- **Control-border correction:** a browser inspection measured the model-identifier field at 1:1 boundary contrast (no border, transparent fill), failing WCAG 2.2 SC 1.4.11. The selector and field now use the same component classes as the preferences form: border 4.50:1 against the page and 4.83:1 against the white fill.
- **Implementer-run checks (Claude, network-blocked runner):** regressions shown failing before each change. The last full suite, 62 files and 1,501 passed, ran before the disclaimer, cable-note and control-styling changes. The final focused checks for those changes passed (charger page, rule, link and SEC-01 tests: 4 files, 62 passed; typecheck exit 0; lint 0 errors with 9 warnings in untouched files). Two earlier superseded outputs (a first red run and a first page run) were deleted during reruns and remain unavailable.
- **Browser observations (mock-only, development server with the webpack bundler, isolated headless contexts, loopback only):** direct loads in English and Spanish passed 100 checks (device selection, claims, disclaimer, cable note, source destinations, layout, saved-draft precedence); after the styling change, 80 checks passed for control boundaries, keyboard focus, selection and submission at 1280px and 390px.
- **Open:** after the client-side navigation from the needs-page link, keyboard focus was reproduced going to the Next.js development overlay rather than the skip link (production behaviour and screen-reader effects unverified); the global amber focus outline measures 1.82:1 against the page background; the native selector truncates the long 2015 model name at 390px; the Spanish comparison table scrolls 2px inside its container at 390px. No screen-reader or native-speaker acceptance, no purchasing, no profile integration. D-category remains open; F03 remains unaccepted. October 24 and the full scope are unchanged.

## Finding 9: message lookup limited to own keys — October 18, 2026 (uncommitted when written)

The sections below stay dated history; the earlier "Finding 9 (tracked, not fixed)" note is superseded by this entry.

- **Source:** branch `fix/finding-9-message-lookup` from `main` `5dbd4d66ced5189505680276bca3d5d2ad3e6475`.
- **Change:** `messageFor` (`src/server/views.ts`) now resolves only the message table's own keys. A URL `error` or `notice` named after an `Object.prototype` member (`__proto__`, `constructor`, `toString`, `hasOwnProperty`, `valueOf`) gets the existing generic message, "That action could not be completed." Recognized messages and `checkoutMessage` are unchanged.
- **Affected callers covered by regressions:** `/shop` in mock mode (real in-memory runtime) and PostgreSQL mode, `/checkouts` and the PostgreSQL checkout. In the three PostgreSQL paths the `pg-views` reads were mocked: the PostgreSQL `/shop` view delegates to the in-memory shopping-view builder, and the other reads (cookie, session, checkout list, checkout view) return fixed test values. None connects to PostgreSQL.
- **Before the fix:** the helper returned `Object.prototype` or native functions; on the pages `__proto__` made the content fail to render (only the loading fallback showed) and the other names rendered an empty alert.
- **Implementer-run checks (Claude, network-blocked runner):** new regressions shown failing first (5 failed | 2 passed); after the fix, focused 94 passed, full unit suite 59 files and 1,470 passed, typecheck 0, lint 0 errors (9 existing warnings). No browser, service, database or provider run.
- **Codex review (source and saved evidence; tests not rerun):** finding 9 resolved, no demonstrated commit blocker. Database behaviour remains unverified.
- **No acceptance change:** F07, F08, F11 and A35 remain unaccepted; the October 24 target and full scope are unchanged.

## Optional device profile — October 18, 2026 (uncommitted when written)

The sections below stay dated history. This entry does not rewrite them.

- **Source:** `feature/device-profile` `8059280bfb33558000477ef7cc2545b092109839`, parent and current `main` `e3c582967adb4897b144c2c4c7436eb137ffa035`. Pushed to `origin`. Not merged into `main`.
- **Scope:** one optional brand and one optional model on the live website session. Each field has its own consent. Withdrawing consent discards that field's posted text and its saved value. The profile belongs to the authenticated session. Recommendations and the extension do not read it.
- **Format 6:** a revision marker stores the session id and the last issued version, with no brand and no model. The next profile is that version plus one. Logout, expiry, and recovery of a dead session drop the marker.
- **Format 5:** a format-5 file stores no deleted-profile history. Upgrading it adds an empty marker list and does not reconstruct a deletion. Protection for a form issued before that upgrade remains limited.
- **Rollback:** there is no downgrade writer. A reader that accepts only an older format rejects a format-6 file. Restoring an earlier `store.json` discards every snapshot write made after that copy, including purchase-permission outcomes and revision markers. Do not restore that copy while payment or checkout continues. No real-store migration is authorized.
- **Attribution:** Cursor implemented the feature and the revision-marker correction. Codex's source-only reviews identified the r1 defect, a recreated profile reusing version 1, and assessed r2. The r2 review found no demonstrated defect in r2-era deletion and recreation. The later r3 additions were tests only.
- **r2 checks, recorded before r3 and not rerun:** unit suite 58 files and 1,456 tests passed; typecheck exited 0; lint exited 0 with nine warnings.
- **r3 checks:** the focused device-profile file's 25 tests passed. The full suite, typecheck, and lint were not rerun.
- **Outstanding:** no browser check and no screen-reader check have occurred. F02 remains unaccepted. October 24 and the full scope are unchanged.

## Spanish checkout cleanup (finding 8, checkout part) — October 18, 2026 (uncommitted when written)

- **Scope:** the mock and Sandbox checkout page (heading, quote lines, notices and errors, start link), the PayPal cancel-return page and the Spanish permissions page's product-name `lang` markers follow the language saved on the checkout, never the URL. English wording is unchanged. The simulated payment panel stays English. Not F09 (explicit language switching) and not external-site multilingual assistance.
- **Codex r1 review** found two defects; both were corrected in r2:
  1. `checkoutMessage` resolved inherited property names (`__proto__`, `constructor`, `toString`) in English; it now recognises only its own keys in both languages.
  2. A provider-proven capture decline had no explanation and the handler's URL code described missing approval; the Sandbox section now explains the decline from the saved `DECLINED_RETRYABLE` state.
- **Codex r2 review:** both corrections resolved; no demonstrated commit blocker. Codex inspected source and saved evidence; it did not rerun tests. Its optional decline-wording refinement is not adopted for this commit.
- **Implementer-run checks (Claude, network-blocked runner):** red-checked new regressions; full suite 56 files, 1,437 passed; typecheck 0; lint 0 errors (9 warnings in untouched files). One mock-only browser check of the Spanish checkout and permissions page (r1 code; r2 not browser-checked). No Sandbox run.
- **Language evidence:** Spanish wording has source-review support only; no native-speaker review and no VoiceOver pronunciation check. Native `<option>` item choices on the Spanish permissions page are not language-marked (mixed English name and Spanish seller label).
- **Finding 9 (tracked, not fixed):** `messageFor` (`src/server/views.ts`) looks up `MESSAGES[code]` without an own-key check, so a URL `error` or `notice` of `__proto__`, `constructor` or `toString` resolves an inherited property instead of a message (Codex r2). Affected callers: `/shop` in mock mode (`src/app/shop/page.tsx:133`) and PostgreSQL mode (`:68`); `/checkouts` (PostgreSQL, `src/app/checkouts/page.tsx:47-48`); the PostgreSQL checkout branch (`src/app/checkout/[intentId]/page.tsx:121-122`). The mock and Sandbox checkout no longer use it for URL codes.
- **No acceptance change:** F07, F08, F11 and A35 remain unaccepted; the October 24 target and full scope are unchanged.

## PayPal Sandbox rehearsal — October 18, 2026 (evening)

Adds to the October 18 status below; that status predates the merge of PR #4 into `main` as `401556aabfb52191917ff8bd92d90a0d1e72dd35`.

- **Source:** `main` `401556a`, run from the feature worktree at `f614006` (identical application tree). Procedure: `docs/paypal-sandbox-rehearsal-runbook.md`; results in its section 13.
- **Attempt 1 (10:30–11:30 EDT window): incomplete, history.** One order creation reached the PayPal Sandbox sign-in page; no return or capture reached the app. The server ran past the cutoff (no payment action logged or reported). PayPal's final state of that order is unknown.
- **Attempt 2 (supervised, 13:51:46–14:21:46 EDT):**
  - *Observed:* fresh permission, quote and checkout; one order-creation press, one return request, one capture press.
  - *App-reported:* approval verified, then "The payment was captured and the capture evidence was checked." for USD 579.99; the permission then showed "Used".
  - *Source-derived only:* PayPal request ceilings (token, order, order read, capture, plus at most one 401 resend each). Actual outbound counts were not observed.
  - *Not corroborated:* no PayPal dashboard read; capture ID not recorded.
  - *Shutdown:* automatic cutoff shutdown armed beforehand; server stopped by hand 16 minutes before the cutoff; port 3000 free.
- **F08 effect:** first current-source Sandbox approval and app-verified capture through the F07 permission gate. Still open for F08: decline, cancel and unknown-outcome paths against Sandbox, PayPal-side corroboration, duplicate prevention and repeat-order revalidation. **No acceptance change:** F07, F08, F11 and A35 remain unaccepted.

## Current status — October 18, 2026

This supersedes the publication-status labels in the October 17 reconciliations below. Those reconciliations and all older entries remain dated history. Updated October 18, after the push and the draft PR.

- **Published:** `main` at `21871db078790e97cf10d8b62b35214bada768eb` (documentation PR #3 on top of `e6bb69d`). It includes M2-1 (PR #1) and M2-2 (PR #2).
- **M2-3 / F07:** committed on `feature/m2-3-purchase-permissions`: plan `ac95a17`, slice 1 `bb33781`, slice 2 `42e9b7e`, slice 3 `e2c1b05ee16198f43a3009bc94c41aa45fdeb11d`, and merge `a142e959b743eff95b1899dd4dedbe8ea205351f`, by which **`main` (`21871db`) was merged into the feature branch** (documentation only). The branch is **pushed** to `origin` and is open as **draft PR #4** (https://github.com/Knarf24/shopaccess-ai/pull/4): base `main` `21871db`, head `a142e95`. **M2-3 is not merged into `main`**, so the monitor, which reads `main` only, does not see it. GitHub reports no checks, because no CI is configured; that means unverified, not passing.
- **Since the October 17 report:**
  - **Automated mock browser recheck R1–R8 (Claude in Chrome):** R1–R7 passed. R8 partly passed: permission recovery and the not-found page passed, but the HTTP status was 200, not 404. Browser-profile isolation was incomplete.
  - **Owner-operated VoiceOver on the owner's Mac (plan §10 amended):** limited English observations; validation-error speech inconclusive; other speech unverified.
  - **Checkout language-marker correction (r5):** Codex's focused review found no concrete defect and no demonstrated commit blocker, with source-inspection and test-coverage qualifications.
  - **Implementer-run gate:** 55 files, 1,413 passed; typecheck 0; lint 0 errors.
  - **Codex review of slices 1–2 (frozen baseline `a142e95`):** two findings, both corrected in the working tree (owner-approved, uncommitted): the sandbox cancel-return page now follows the saved payment state (finding 1), and permission creation rechecks the session inside its serialized decision (finding 2). Implementer-run gate after the fixes: 55 files, 1,423 passed; typecheck 0; lint 0 errors. Codex's focused review of the fixes (source and saved evidence; it did not rerun tests) found both findings resolved, with no demonstrated blocker. Acceptance is unchanged.
- **Still open:**
  - finding 7 (proposal) and finding 8 (tracked);
  - per-item VoiceOver speech;
  - M2-2 finding 3 before any non-local use;
  - F07, F11 and A35 acceptance.
- **Unchanged:** the October 24 target and the full scope. The likely-miss forecast is unresolved.

## Current reconciliation — October 17, 2026

*Historical since October 18: superseded for status by the October 18 status above. Its text is kept as published in PR #3.*

Read the [dated progress report](progress-report-2026-10-17.md) before interpreting the historical tables below. Marker: `SHOPACCESS-PROGRESS-20261017-R4`.

- GitHub confirms M2-1 merged in PR #1 and M2-2 in PR #2, now in main at `e6bb69dbac7127786425c299667a45a3930a833b`. Their earlier “uncommitted” labels below describe pre-merge records.
- F02 persistence and F05 continuity have published implementation; optional device profiles and full acceptance remain open.
- F07/M2-3 corrections and Codex's r4 source re-review are owner-reported from an unpublished local worktree. The report records source identity, test provenance and limitations. The monitor cannot inspect that private source from main.
- The latest correction browser recheck and VM screen-reader verification remain pending. No feature is accepted by this reconciliation.
- The existing Cursor-to-Slack report for e6bb69d was supplied by the owner. Ingestion of this new progress report is not verified until a subsequent monitor run identifies its publication commit and marker.

The dated report supersedes publication-status labels only. Preserve all historical results, failures and scope limits below.


| ID | Requirement | Initial state / gap | Acceptance evidence needed |
| --- | --- | --- | --- |
| F01 | Conversational clarification through selection and purchase review | Initial 8-turn use/budget correction increment reported; full shopping dialogue open | Multi-turn browser journey with corrections and tool results |
| F02 | Durable shared shopping state and optional device profile | Process-local conversation reported; durable profile not established | Restart/resume, ownership isolation, deletion tests |
| F03 | Product compatibility and explanatory comparison | Laptop readiness exists; charger compatibility not established | Device-specific positive, incompatible and unknown cases |
| F04 | Current external discovery | Channel3 adapter offline-tested; production transport disabled | Separately authorized live response and browser display evidence |
| F05 | Browser extension and website continuity | Not established | Installed extension, secure pairing and shared-session journey |
| F06 | Supported-store navigation and shopping actions | Proposed; store capabilities unproven | Terms/API investigation and successful supported-store experiment |
| F07 | Scoped revocable delegated-purchase permissions | Expanded permission model not established | Limit, expiry, revocation, changed-item and changed-price refusal |
| F08 | Verified payment and repeat purchasing | Sandbox capture reported historically; attempt nine overall exit 6; expanded journey open | Current integrated authorized sandbox journey; duplicate prevention and repeat-order revalidation |
| F09 | English/Spanish with explicit switching | Partial translations; language persistence defect reported; switching absent in initial increment | Current bilingual browser journey preserving authoritative values |
| F10 | Voice input and output | Not established | Correct transcription/recovery and usable spoken guidance |
| F11 | Keyboard and screen-reader independence | Partial historical checks; announcements/focus and A35 unresolved | Actual assistive-technology comparison and final-review journey |
| F12 | Submission and reproducibility | Source published; revised product not accepted | Setup, license/rule review, working-product video and submission checks |

## M1 assessment status (October 16, 2026)

Source inspected: `main` at `5eb1ed9af6b1c0277330465e9778dcefe6620a53`. The application source there is identical to `0379134d4ec61117fa334caa16c2b59d9308ebe4`. This was a source reading only; no tests or browsers were run. Full detail, evidence references and sources: [M1 assessment](m1-assessment.md).

Evidence labels:
- **source:** read in the published tree.
- **unit-hist:** suite run on an October 15 tree before `0379134`; not re-run on the published commit.
- **private:** the owner's local evidence store. Not published, so the monitor cannot verify it.
- **owner-reported:** unverified; no retained evidence.
- **documented:** official third-party documentation; untested here.

None of F01–F12 is accepted.

| ID | Source state at `5eb1ed9` | Evidence and limits | Estimate (impl + verify), confidence |
| --- | --- | --- | --- |
| F01 | Partial: 8-turn conversation held in process memory; extracts laptop use and budget only; replies are fixed notices (`src/lib/session/conversation.ts`, `src/lib/providers/ai.ts`) | unit-hist and private `guided-conversation-20261015-210229` (45/45); multi-turn browser observation: none | 20–34 h, low |
| F02 | Partial: session and draft snapshot store; conversation excluded; no device profile (`src/lib/session/snapshot-store.ts`) | unit-hist only; PostgreSQL never executed by the application | 11–19 h, medium-low |
| F03 | Laptop readiness only; evidence-quality grading reusable; no charger schema or rules (`src/lib/readiness/engine.ts`, `src/lib/catalog/schemas.ts`) | unit-hist for laptops | 11–18 h, medium |
| F04 | Channel3 adapter, `CHANNEL3_LIVE_ACTIVATION = false`, laptop queries (`src/lib/providers/channel3-discovery.ts`) | unit-hist; private manual browser check: disabled message seen, pending inconclusive. **Postman exploration: owner-reported, unverified**, outside the application | 5–9 h, low; live portion gated |
| F05 | Absent: no manifest or `chrome.*` code | documented: side panel needs Chrome 114+ and MV3; `open()` needs Chrome 116+ and a user action | 18–30 h, low |
| F06 | Absent; demo merchant schema allows only the simulated Sandbox merchant. Goal unchanged: agent-completed purchase within scoped authorization; a handover is not completion | documented, untested: Shopify Checkout MCP `complete_checkout` "when eligible" (**eligibility unresolved**, trust-tier page not read; merchant stays merchant of record); `checkoutUrl` / `continue_url` handover. Amazon: no consumer ordering API; terms restrict robots (**official page unavailable**, 503) | 11–21 h covers mechanics up to the handover only; agent completion, Amazon and any second store not estimated, so no complete F06 estimate |
| F07 | Per-purchase quote, confirmation and intent binding only; no grants, limits, expiry or revoke | unit-hist for quote and confirmation | 10–18 h, medium-low |
| F08 | Payment state machine and PayPal Sandbox adapter present; no repeat-order revalidation | private: attempt nine `CAPTURED_VERIFIED`, **overall exit 6, acceptance NOT MET**; correction 28 offline 145/145, not executed; all on trees before `0379134` | 10–20 h, medium; saved-payment repeat charging not estimated (limited release) |
| F09 | EN/ES copy; language fixed per draft; no switching; `<html lang="en">` | Spanish-content defect: private owner-operated record. Untested hypothesis: `src/app/shop/needs/page.tsx:123` prefers the draft's language | 10–19 h, medium-low |
| F10 | Absent | documented: Chrome recognition sends audio to a server by default | 6–11 h, medium |
| F11 | Partial: skip link, status/alert roles; no focus management after a conversation turn | private: October 12 VoiceOver pass on the earlier flow; A35 unmet; automatic announcements unresolved | 13–20 h incl. 3–4 h owner VoiceOver, medium-low |
| F12 | Private repository; README setup; no LICENSE | event rules unverified (official page 403 to Claude) | 11–20 h, medium |

Partial total: 136–239 h, plus 8–11 h of M1 experiments. Unestimated work is excluded, so this is not a complete delivery forecast. Internal dates in the milestone plan are proposed, not owner-approved. Nothing here authorizes application execution or live integration. The October 24 forecast is a likely miss; see [M1 assessment](m1-assessment.md#forecast-against-october-24).

## Updating a row
Record implementation state, evidence type, exact source commit, dated test/run reference, remaining gap, dependency and next action. Use unknown when evidence is missing. Distinguish source inspection, automated tests, browser observation, screen-reader acceptance and live-provider verification. Never upgrade a historical result to acceptance of a newer source tree.

No feature is accepted solely because code exists, tests pass, or a concept video illustrates it. Shopper approval and provider verification remain authoritative for purchases. An external listing cannot be charged through the demo merchant checkout.

## October 16 feasibility research supplement
See [full investigation](full-feasibility-investigation-20261016.md) and [external-store matrix](external-store-feasibility-20261016.md). These refine F02–F10 prerequisites; no F-row is accepted by them. Amazon Business ordering is a distinct candidate with onboarding dependencies, not proof of ordinary personal Amazon support. Shopify's test gateway does not establish PayPal Sandbox. Bounded E1–E4 proposals are documented and not run. Model, storage and store choices remain proposals. E5 official rules were read; judge setup and final compliance remain open.

## M2-1 update (October 16, 2026; merged to main as b86a41b, PR #1)

F02 conversation persistence:
- Source on `feature/m2-1-snapshot-persistence`: sessions, drafts, conversation (language, eight lines), confirmation-invalidation state, and the allocation and admission windows persist through the save-first snapshot gate when `SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE` are set.
- Evidence: unit and behavioural tests, 41 files and 1,243 passed. Private mock-only browser restart check passed.
- Committed as `08e6e6a` and merged as `b86a41b` (PR #1); the suite rerun on `b86a41b` gave 41 files, 1,253 passed (the count after review correction 2). F02 is not accepted: the device profile (the rest of F02) is not started. See `docs/m2-1-plan.md` §9–10.

## Voice addendum (October 16, 2026)

F10 now also records the owner's optional "Hey ShopAccess" hands-free activation: local wake-word detection, spoken conversation, a visible listening state and a stop command. It is planned as a separate feasibility experiment (`docs/m2-2-plan.md` §8). It is not part of M2-2 and not implemented; there is no estimate beyond the experiment's 5–9 hours.

F05 (October 16): M2-2 integrates pairing, a shared conversation and per-grant revocation into the application, committed as `cb09a94` and merged to main as `e6bb69d` (PR #2). Unit evidence: 1,300 tests after the browser-check fixes; 1,306 at the commit after the review corrections, and 1,306 again when rerun on merged `e6bb69d`. An owner-assisted mock browser check on 127.0.0.1 covered pairing, shared history, revoke, restart and keyboard. An independent source review passed with notes; its corrections were approved and merged. B1, a conversation-persistence defect from M2-1, was found in that browser check and fixed. Before any non-local use, pairing needs a matching code (accepted carry-forward). Screen-reader acceptance is open. F05 is not accepted.

## Reconciliation (October 17, 2026)

**Historical record.** "Uncommitted", "not pushed" and "current" in this section describe the worktree before slice 3 was committed (`e2c1b05`, October 18). For the current state, see the October 18 status at the top.

Written in the M2-3 worktree; unpublished until the owner approves a commit. The monitor reads `main` only and cannot see this branch, its uncommitted work or the private evidence.

**Merged `main` at `e6bb69d`** (M2-2 merge, PR #2; its tree is identical to `cb09a94`). It contains M2-1 (`08e6e6a`, merged as `b86a41b`, PR #1) and M2-2 (`cb09a94`). No CI is configured, so no check results exist on GitHub.

**Local M2-3** on `feature/m2-3-purchase-permissions`, based on `e6bb69d`. Committed but **not pushed**: plan `ac95a17`, slice 1 `bb33781`, slice 2 `42e9b7e`. **Uncommitted:** slice 3 (permissions page, routes, refusal copy), the browser-check fixes D1 and D2, the accessibility and language corrections, and these documents.

Suite counts belong to different revisions, not conflicting results:

| Revision | Suite (database-free) | Run |
| --- | --- | --- |
| M2-1 working tree, before review | 41 files, 1,243 | implementation gate |
| `08e6e6a` / `b86a41b` | 41 files, 1,253 | after review correction 2; rerun on `b86a41b` |
| M2-2 working tree after browser fixes | 48 files, 1,300 | fix gate |
| `cb09a94` / `e6bb69d` | 49 files, 1,306 | after review corrections; rerun on merged `e6bb69d` |
| `bb33781` (slice 1) | 51 files, 1,325 | slice gate |
| `42e9b7e` (slice 2) | 52 files, 1,354 | slice gate |
| uncommitted slice 3 (historical) | 53 files, 1,373 → 1,374 (D1) | slice gate, D1 fix |
| uncommitted (historical) | 54 files, 1,389 → 1,390 (D2) | accessibility corrections, D2 fix |
| uncommitted (historical) | 55 files, 1,401 | review findings 1–6 fixed |
| uncommitted (historical) | 55 files, 1,406 | second-review corrections (SEC-01 pin, sandbox cancel and unsaved-capture page, unknown-order refusal) |
| uncommitted (historical) | 55 files, 1,410 | Codex review: SEC-01 collector covers `.mts`/`.cts`; parser-based import policy refuses computed specifiers |
| uncommitted then (historical); the same tree was committed as `e2c1b05` | 55 files, 1,413 | checkout language-marker correction (r5) |

Typecheck 0 and lint 0 errors with the same 9 pre-existing warnings at every row. Runs are the implementer's no-network recipe; no separate party has rerun them.

**F07 (M2-3), not accepted.** Evidence for the slice 3 tree (uncommitted when written; committed as `e2c1b05`):
- source and unit: the counts above, with red checks for each enforcement point and each fix (private evidence);
- manual browser (owner, mock only, 127.0.0.1): scenarios 1–8 with retries, the Spanish and keyboard recheck, and the revocation focus checks;
- automated browser (Claude in Chrome, October 17 22:22–22:25Z): revoke before confirm, the refusal and its link, QUOTED and unconfirmed, focus targets and outlines, and D2 after a reload. It predates the review corrections, which have unit and page-render evidence only;
- source reviews: two read-only reviews by separate Claude subagents (not independent of the implementer's model), and an independent Codex review of the r3 handoff, which found two SEC-01 gaps (the repository collector omitted `.mts`/`.cts`; computed specifiers and some suffixes evaded the import restriction). All were fixed with red-checked tests. Codex's focused, read-only re-review of the r4 handoff (October 17) found both SEC-01 findings resolved and no new concrete defect, with a stated qualification: parser diagnostics are not checked, and unresolved literal paths are not refused. That review read the source and the saved outputs; it did not rerun tests and does not grant commit or product acceptance;
- automated browser recheck of the review corrections (Claude in Chrome, owner-authorised, mock only, October 18 01:35–01:48Z), scenarios R1–R8. R1–R7 passed: the successful checkout, the refusal after confirmation, the spent confirmation after a decline, the old checkout keeping its revoked reason, a single current refusal, URL codes ignored after capture, and "(simulada)" in the Spanish summary. R8 partly passed: permission recovery and the rendered not-found page passed, but the expected HTTP 404 did not; the old checkouts returned HTTP 200. That is consistent with the installed Next.js streaming guidance (`notFound()` under `<Suspense>`; pre-existing on main) but not confirmed for each request. The browser session was not isolated: it shared the owner's Chrome profile, and the owner's open tabs sent two unrelated GET requests. The server logs account for every POST as the automation's. Optional cases are deferred;
- screen reader, kept separate from the markup and browser evidence:
  - **Observed (limited):** an owner-operated VoiceOver check on the owner's Mac, under the amended §10. The owner reported speech for the English permissions-page arrival ("Skip to the current step", "Purchase permissions") and for the Item, Quantity, Total, Expiry and Review controls, with caption support for Item and Total.
  - **Inconclusive:** speech for the validation error, interrupted by an ended session.
  - **Unverified:** all other speech. That is the Spanish voice; the created and revoked results; the list and the Revoke description; checkout refusals in English and Spanish; and the skip-link targets on `/shop` and the checkout. Also unverified: the reload and slow-load focus speech. None of this is F11 or A35 acceptance;
- the checkout language-marker correction (r5) was reviewed by Codex: no concrete defect and no demonstrated commit blocker, with its stated qualifications (based on source inspection, and the limits of the test coverage). A mock browser check confirmed the language markers; VoiceOver pronunciation is not inferred;
- not performed in a browser (unit evidence only): the sandbox Cancel form; the "payment may already have gone through" warning, which has both simulated and sandbox implementations, both unit-tested, but needs a deliberate save failure to appear (browser coverage unverified); and the test-only unknown-order state. Also not performed: PostgreSQL F07 (fails closed by design), live providers and live payment (sandbox paths are tested only with a mocked PayPal transport), the optional quantity-tampering browser check, the Spanish needs-page refusal, and slow-load focus behaviour (not reproducible with the available tools).

Acceptance status is unchanged: none of F01–F12 is accepted. M1 is open; M2 and M4 are not accepted.
