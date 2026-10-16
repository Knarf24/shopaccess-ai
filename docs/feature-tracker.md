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

## Updating a row
Record implementation state, evidence type, exact source commit, dated test/run reference, remaining gap, dependency and next action. Use unknown when evidence is missing. Distinguish source inspection, automated tests, browser observation, screen-reader acceptance and live-provider verification. Never upgrade a historical result to acceptance of a newer source tree.

No feature is accepted solely because code exists, tests pass, or a concept video illustrates it. Shopper approval and provider verification remain authoritative for purchases. An external listing cannot be charged through the demo merchant checkout.
