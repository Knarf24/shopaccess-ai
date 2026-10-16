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

## M2-1 update (October 16, 2026, uncommitted branch)

F02 conversation persistence:
- Source on `feature/m2-1-snapshot-persistence`: sessions, drafts, conversation (language, eight lines), confirmation-invalidation state, and the allocation and admission windows persist through the save-first snapshot gate when `SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE` are set.
- Evidence: unit and behavioural tests, 41 files and 1,243 passed. Private mock-only browser restart check passed.
- Not accepted until reviewed and committed. Device profile (the rest of F02) is not started. See `docs/m2-1-plan.md` §9–10.

