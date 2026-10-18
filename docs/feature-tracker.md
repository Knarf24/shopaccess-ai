# ShopAccess AI feature and evidence tracker
Updated October 16, 2026. Target: October 24. Initial status reflects published governance and owner-supplied reports, not a fresh implementation audit.

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
| uncommitted slice 3 | 53 files, 1,373 → 1,374 (D1) | slice gate, D1 fix |
| uncommitted | 54 files, 1,389 → 1,390 (D2) | accessibility corrections, D2 fix |
| uncommitted | 55 files, 1,401 | review findings 1–6 fixed |
| uncommitted | 55 files, 1,406 | second-review corrections (SEC-01 pin, sandbox cancel and unsaved-capture page, unknown-order refusal) |
| uncommitted | 55 files, 1,410 | Codex review: SEC-01 collector covers `.mts`/`.cts`; parser-based import policy refuses computed specifiers |
| uncommitted, current | 55 files, 1,413 | checkout language-marker correction (r5) |

Typecheck 0 and lint 0 errors with the same 9 pre-existing warnings at every row. Runs are the implementer's no-network recipe; no separate party has rerun them.

**F07 (M2-3), not accepted.** Evidence for the current uncommitted tree:
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
