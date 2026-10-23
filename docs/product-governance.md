# ShopAccess AI — product intent

| | |
| --- | --- |
| Date | October 12, 2026 |
| Standing | Authoritative record of product intent, confirmed by the project owner on this date |
| Does not record | Implementation status, except in the status section below, or permission to execute |

This document says what ShopAccess AI is for. It authorizes planning of that product. It does not authorize a live model call, a payment, a deployment, or a database change. Those keep the gates already recorded in `docs/security-foundation.md` and `docs/postgresql/postgresql-specification-v2.0-draft.md`.

Historical evidence stays where it was written. A later product decision does not rewrite an earlier failure, an earlier limit, or an earlier authorization into a broader approval.

## Owner-confirmed direction

ShopAccess AI combines three functions:

1. **Financial inclusion:** understandable costs, budget protection, and payment guidance.
2. **Product recommendations:** needs-based selection, evidence-backed comparisons, and trade-offs.
3. **Conversational shopping assistance:** clarification, navigation guidance, and help reviewing a purchase.

Accessibility and multilingual assistance support this integrated experience. They are not a fourth product that replaces the three functions.

The PostgreSQL specification's bounded engineering scope does not replace this direction. Security Foundation Specification v1.1 remains the authority for the accepted Milestone 001 mock, and its text is not in this repository. This document does not reopen that milestone and does not supply the missing specification.

## A. Understanding needs

The shopper can state needs in natural language. The assistant asks useful follow-up questions and presents a summary of the requirements. The shopper confirms that summary before it is treated as the request.

Specification explanations are in plain language. The assistant never silently alters the budget and never invents a requirement the shopper did not confirm.

## B. Accessible navigation

A shopper can complete the journey with a screen reader and with a keyboard alone: labeled controls, predictable focus, announced statuses and errors, accessible product comparisons, and an accessible final purchase review.

Voice is an optional additional input. It is not a requirement for a blind shopper.

One October 12 Safari and VoiceOver manual pass is recorded in `docs/security-foundation.md`. It reached purchase review and did not confirm a purchase. Keyboard operation of the whole flow, with alerts and status announced, remains an unmet browser acceptance case in the PostgreSQL specification (A35). Automatic status announcements, error coverage, and broader assistive-technology testing remain unverified.

An October 13 accessibility name and description correction is recorded in `docs/security-foundation.md`. The owner report, the retained source reviews and validation, and the Claude browser recheck stay separate there. Automatic VoiceOver announcements remain unresolved. Focus still returns to the body after submissions. A35 remains unmet. The correction is not accessibility acceptance.

An October 13 local-mock skip-link browser check is recorded in `docs/security-foundation.md`. It is English keyboard and markup evidence from headless Chrome. No VoiceOver speech was observed. A35 remains unmet. The check is not accessibility acceptance.

An October 13 demo-admission implementation and its local checks are recorded in `docs/security-foundation.md`. Source review and unit/typecheck results stay separate from the development-mode browser checks. No VoiceOver speech was observed. A35 remains unmet. Those checks are not accessibility acceptance.

An October 13 local production-mode verification is recorded in `docs/security-foundation.md`. It is separate from the development-mode admission checks. No VoiceOver speech was observed. A35 remains unmet. It is not accessibility acceptance, payment acceptance, PostgreSQL execution, or deployment authorization.

## C. Multilingual shopping guidance

The shopper chooses an interface language. Guidance can translate and explain product information, variants, shipping and return terms, and checkout steps that were supplied to the shop.

Original text stays available. Authoritative amounts, currencies, quantities, and identifiers stay the server's values and are not replaced by a translation. Missing or ambiguous terms are flagged, not guessed into a price or a promise.

The first planned demonstration is a bilingual demo merchant catalog. That starting point is confirmed as product scope for planning. It is not built by this document, and it is not permission to call a translation service. Navigation of arbitrary external stores is a separate proposed scope. It is not an implemented capability.

## D. Recommendation authority

The server enforces catalog identity, suitability, stock, and budget. The model may select and rank candidates that already passed those rules, and it may explain facts the server has verified. Prose that is not supported by those facts must not bypass the rules. A result that matches nothing says so. It does not invent a suitable product and it does not cross the budget.

## E. Purchase control

The shopper reviews the purchase and confirms it explicitly. The amount that can be paid is the server-calculated quote. The model cannot authorize a purchase and cannot declare a payment successful unless provider evidence has been verified. A return to the browser is not that evidence.

Showing a product discovered from outside the merchant catalog does not authorize ShopAccess to sell another merchant's product. The merchant catalog remains the only authority for a purchasable item.

## F. Demonstration outcomes

These are the observable acceptance scenarios. None of them is accepted by the existence of this document.

| Scenario | Accepted only when |
| --- | --- |
| A novice shopper clarifies needs and selects a suitable product | The shopper's confirmed summary is visible, the selection meets that summary and the budget, and the shopper makes the selection |
| A keyboard and screen-reader shopper completes the journey without sighted assistance | The journey in section B is completed with assistive technology, including comparison and final review |
| A shopper understands a supplied foreign-language listing in their chosen language | The chosen language is the interface language, the original text remains, and amounts, currencies, quantities, and identifiers are unchanged |
| A no-match case stays honest | No recommended product exceeds the budget, and no suitable product is invented |
| A PayPal sandbox journey reports success | A later, separate authorization allows that sandbox execution, and success is reported only from verified provider evidence |

A polished end-to-end demonstration and a presentation are goals. No prize and no judging score is guaranteed.

## Current status (October 12, 2026)

This section is status, not a new authorization.

Verified inside mock persistence and mock payment mode:

- Live Qwen catalog selection, recorded as QW-1 in `docs/security-foundation.md`: one standalone request, separate from the browser runs.
- One suitable Schoolwork/$500 browser case, recorded as QW-5. The owner confirms that case as a suitable selection. The retained server log shows the shop request and a clean shutdown. It does not retain the advisory card text.
- One Spanish guided-shopping case, recorded as QW-6. The owner reports leaving the structured controls empty before the Spanish sentence. Screenshots showed Schoolwork and $500 prefilled, explicit needs confirmation, and StudyBook 14 at $449 with supplied Spanish explanations beside the English originals. The log shows one interpretation submission, one recommendation, two reserved slots, no advisory failure diagnostic, and a shutdown with no residual process and identical snapshots. The log does not retain those displayed values. `shutdown.json` hardcodes `durableOwnership` false; the valid ownership record and the terminal report establish full ownership. This is one successful mock case, not general model reliability, accessibility acceptance, PostgreSQL execution, or payment acceptance.
- One October 12 Safari and VoiceOver manual pass, recorded in `docs/security-foundation.md`. The owner report is separate from the observed screenshots and terminal output. Local mock assistant, in-memory persistence, and mock payments, through purchase review. It does not fully pass A35 and is not accessibility acceptance or WCAG certification. The temporary P-256 CA trust was removed afterward; the certificate files were preserved, and a subsequent `security verify-cert` returned `CSSMERR_TP_NOT_TRUSTED`.
- Two October 12 local-mock Chrome comparison cases, recorded in `docs/security-foundation.md`. Screenshot observations are separate from the supplied terminal output. English only, with the local mock assistant, in-memory persistence, and mock payments. Schoolwork at $500 and Programming at $1100 were each submitted and confirmed. No checkout request appears in the supplied output, and no server log for this check was retained. These cases are not a live Qwen run, a Spanish case, accessibility acceptance, PostgreSQL execution, or payment acceptance.
- One October 12 English structured-clarification browser case, recorded in `docs/security-foundation.md`. Screenshot observations are separate from the supplied terminal output. The local mock assistant, in-memory persistence, and mock payments. The first input was "I need a laptop for school." with both structured controls empty. Schoolwork was retained and the missing budget was requested before an editable review of Schoolwork and 500. Explicit confirmation then showed StudyBook 14 at $449.00 and the excluded rows without purchase buttons. The supplied output has no checkout request. Its status codes do not establish how many provider calls ran, and no server log for this browser case was retained. The earlier unit and typecheck evidence remains separate. This case does not establish Spanish clarification, live-Qwen behavior, accessibility acceptance, PostgreSQL execution, or payment acceptance.
- October 13 presentation and bilingual-spacing checks, recorded in `docs/security-foundation.md`. Owner screenshots are separate from the Cursor inspection and from the Claude inspection. The owner opened purchase review in English and in Spanish; those screenshots showed an unchecked acknowledgment and QUOTED state and do not establish that the journeys stopped before checkout. The Cursor browser measured Spanish comparison lines at 1280px and 320px, with a 4px gap and no horizontal overflow, and did not complete a fresh English session. The Claude headless Chrome check used a fresh English local-mock session at a verified 320px viewport, with English-only reasons and no detected overflow; the CodeBook 32 GB capture was measured but not visually reviewed. The owner reported shutdown; an empty listener check was not independently verified. The retained unit and typecheck records stay separate from the browser evidence. These checks are not full frontend acceptance, accessibility acceptance, PostgreSQL execution, live-provider behavior, or payment acceptance. A saved local browser profile stays private and out of this repository.
- October 13 accessibility name and description correction, recorded in `docs/security-foundation.md`. The owner report, the retained source reviews and validation, and the Claude browser recheck are separate sources. VoiceOver read page sections, and the missing-budget question was not heard automatically after navigation. The final validation passed 29 files and 1,117 tests, then typecheck. Chrome's computed tree confirmed the purchase-button name, the conditional read-only explanation, and budget descriptions containing the rendered question, hint, and validation alert as applicable. The recheck ended on recommendations with no checkout started. Screenshots were captured and were not visually reviewed. The owner reported shutdown; an empty listener check was not independently verified. Automatic VoiceOver announcements remain unresolved. Focus still returns to the body after submissions. This correction is not accessibility acceptance, and PostgreSQL A35 is not passed. A saved browser profile and cookies stay private and out of this repository.
- October 13 demo-admission implementation and local checks, recorded in `docs/security-foundation.md`. Source review and retained unit/typecheck results are separate from the browser checks. The first unit run failed and typecheck was not run. A later typecheck failed on a read-only `NODE_ENV` assignment, and the following source runs passed: 30 files, with 1,131 tests and then 1,132 tests, then non-incremental typecheck exit 0. Development-mode browser checks, with mock payments and in-memory persistence, covered admission, login, and logout. The attempt-limit check described a wrong passphrase by the rendered refusal and described a rate-limit retry by its own alert; that retry was not marked invalid. The latest English and Spanish presentation check, at 1280px and 320px, measured the teal password border at 8.56:1 against the white field fill and 8.48:1 against the paper panel, a 30px weight-600 heading, and 12px between the language choices and their submit button. A wrong passphrase was `aria-invalid="true"` and was described by the rendered refusal. The homepage remains readable without admission. Attempt counters remain process-local, and restart durability is unresolved. The amber focus ring measured 1.93:1, and the refusal text is styled like body text. Both remain open. No VoiceOver speech was observed. This is not production readiness, shared rate limiting, accessibility acceptance, or deployment authorization, and PostgreSQL A35 is not passed. A saved browser profile and cookie values stay private and out of this repository.
- October 13 local production-mode verification, recorded in `docs/security-foundation.md`. Directory timestamps are UTC. The failed build under the unit-test no-TCP guard remains in place. A later production build exited 0 with the corrected build-IPC guard loaded alone; that Node hook is not complete network isolation. With admission omitted, `next start` refused protected routes before admission work: the browser showed the closed screen, including the Spanish sentence, and no passphrase field. A certificate-only probe found an empty certificate table before `Network.enable` and accepted the preserved 127.0.0.1 certificate afterward on Chrome 155.0.8059.40. One English HTTPS journey on `127.0.0.1` admitted the browser, confirmed editable Schoolwork and 500, showed StudyBook 14 results, retained the three named cookies, and logged out. The completed journey's proxy log contains no checkout request. Measured records, inspected screenshots, and this documentation pass stay separate. The TLS and browser helpers are outside the repository and are not deployment components. The certificate match is key-specific; normal browser trust was not verified. Restart durability and shared rate limiting remain unresolved. Spanish shopping and checkout were not exercised. This is not public deployment, payment acceptance, PostgreSQL execution, or accessibility acceptance, and PostgreSQL A35 is not passed. A saved browser profile and cookie values stay private and out of this repository.
- October 13 local-mock skip-link browser check, recorded in `docs/security-foundation.md`. Measured focus and the accessibility tree are separate from the inspected screenshots, and both are separate from the retained server log. A fresh English local-mock session, in-memory persistence, and mock payments. Separate headless Chrome, keyboard events only, shopper text empty, measured viewport 1280 by 813. The path was first ask, missing budget, invalid empty clarification, an editable Schoolwork and 500 review, and explicitly confirmed results. Tab revealed the skip link as the first application control at each stage. Enter focused the unique selected target: the first-ask heading, the missing-budget notice, the validation alert, the review notice, and the Suggestions heading. Only that target had `tabindex="-1"`. The next Tab reached the expected control. On the results it focused the purchase-review button and did not activate it. Budget description references resolved to visible, unique elements. A no-notice review targeting `#review-heading` was not browser-observed; its source and unit coverage remains separate. The retained server log shows no checkout request and no payment request. The supplied report that no purchase or payment control was activated is separate from that log. The server log ends after the results page; an empty listener check is not independently supported by the retained pid file or Chrome log. No VoiceOver speech was observed. This is not full frontend acceptance or accessibility acceptance, and PostgreSQL A35 is not passed. Spanish, mobile, and live-provider behavior were not tested. A saved browser profile and cookies stay private and out of this repository.

Still recorded, and not replaced by those suitable cases:

- QW-3, the earlier timeout (`DEADLINE`, 5004 ms).
- QW-4, the earlier unsuitable recommendation, in which the advisory block also named products outside the budget or the readiness result.
- QW-2, the first browser case, whose missing suggestion has no recorded cause.
- The earlier failed Spanish guided runs, `qwen-guided-spanish-demo-20261012` and `qwen-guided-spanish-retry-20261012`. QW-6 does not replace them.

Pending:

- Broader assistive-technology testing. The October 12 Safari and VoiceOver pass is one manual journey through purchase review. Automatic status announcements, error coverage, and other assistive technologies remain unverified, and A35 is not fully passed. The October 13 accessibility name and description correction leaves that pass in place. Automatic VoiceOver announcements remain unresolved. Focus still returns to the body after submissions. The correction does not pass A35 and is not accessibility acceptance. The October 13 local-mock skip-link browser check is keyboard and markup evidence. No VoiceOver speech was observed in that check. It does not pass A35 and is not accessibility acceptance. QW-6 is one Spanish guided case in Chrome. It does not accept conversational clarification, guided navigation, or multilingual assistance in general. Chrome offered page translation during that case; the owner did not activate it.
- PayPal sandbox application integration. The sandbox acceptance scenario above does not open that gate.
- PostgreSQL application execution. Disposable-cluster evidence stays the specification's record. This document does not widen it and does not claim the application has been run against PostgreSQL.
- Demonstration admission. The October 13 development-mode record does not make that gate production-ready. The later local production-mode verification does not either. Attempt counters remain process-local, and restart durability is unresolved. Shared rate limiting is unresolved. The homepage remains readable without admission. Neither record establishes VoiceOver speech, accessibility acceptance, payment acceptance, PostgreSQL execution, or deployment authorization.

## What remains gated

Planning against this document is allowed. The following stay under their existing records:

- Live model calls and any further external-AI request.
- Payment execution, including PayPal sandbox and any production payment. Production payments stay forbidden.
- Deployment.
- Database changes, migration application, and application execution against PostgreSQL.

Milestone 001's payment and confirmation boundaries remain in force, including server-priced quotes, explicit confirmation, and the rule that mock payment tests say nothing about real PayPal. Increment gates in the PostgreSQL specification are unchanged: a later gate that was not authorized remains not authorized.

## Catalog change (October 15, 2026)

This note records a catalog replacement. It does not rewrite the historical cases above. Those cases used the revision 1 placeholder laptops, including StudyBook 14 at $449.00, and they remain the record of what was observed then.

The in-memory shop catalog is now revision 2. It has three researched configurations, one each. Research date: October 15, 2026. The hardware was not independently inspected. The reference prices are stored as fixed demo prices, not guaranteed current offers.

- Acer Aspire Go 15, https://store.acer.com/en-us/aspire-go-15-laptop-ag15-21pt-r9tl. The reference was a $579.99 sale price. The regular price on that page was $599.99. The shop stores the sale price, USD 579.99, as the fixed demo price.
- Acer Aspire 14 AI, https://store.acer.com/en-us/aspire-14-ai-laptop-a14-52m-51s1. The fixed demo price is USD 879.99.
- ASUS Vivobook 16, https://www.newegg.com/p/N82E16834236434. The reference listing was DemProductSales through Newegg. The fixed demo price is USD 999.00.

Inventory in the shop is simulated. Acer, ASUS, Newegg, and their sellers are not ShopAccess partners. Checkout remains a PayPal sandbox demonstration with no physical fulfillment. Pictures are original illustrations. Readiness thresholds are unchanged.

Channel3 discovery is implemented and offline-tested. The live transport is installed only when `CHANNEL3_DISCOVERY=on` and a valid `CHANNEL3_API_KEY` are configured; no deployment configures them, and it is not a live-verified integration. Search actions are limited before any request (3 per session, 10 per UTC hour, 30 per UTC day by default; process-local, reset on restart). Listings follow the documented Channel3 schema; absent or ambiguous price, link, website or availability stays unknown, the website is shown as reported by Channel3 rather than as a verified seller, and listings carry a disclosure. External listings have no purchase form and `ext_` IDs cannot start checkout.

Channel3 search and product detail were explored through Postman. The returned fields conflicted and required checking before any catalog use. The account, the redeemed sponsor credits, and that Postman exploration are owner-reported. They are not a verified current balance and they are not credential approval. That exploration did not authorize a live API call from this application or a claim that Channel3 supplied these three rows.

The suggestion panel now labels each stored suggestion and each other eligible laptop. The source sentence names the provider that produced the stored result. A local or fallback result is not labeled as the configured model.

The Increment 1 SQL seed, `db/migrations/0004_merchant_catalog_seed.sql`, was not rewritten. Its own header still says it was never executed under Gate B-W. It was later applied on disposable Increment 1 clusters, and its bytes stay checksum-pinned. The application fixture is no longer equal to that seed.

## Expanded owner direction and tracking (October 16, 2026)

The owner has expanded the planned product to a conversational shopping website and browser extension, persistent shopping state and optional device profiles, compatibility explanations and comparisons, supported external-store assistance, scoped revocable delegated purchasing and repeat-order checks, voice input/output, English/Spanish with explicit switching, and independent keyboard/screen-reader operation. This is planned scope, not a claim of implementation or external-retailer support. Account access is not spending authorization. Store capability and permitted checkout mechanisms require investigation. Existing merchant quote/payment boundaries remain in force; external listings do not become purchasable through the demo merchant.

October 24, 2026 replaces the Sunday October 18 completion target. No cutoff hour is set. Wild Link starts October 24 and continues through November 12. See [milestone plan](milestone-plan.md), [feature tracker](feature-tracker.md) and [work log](work-log.md). These targets do not establish validated engineering estimates. Retain the full scope unless the owner changes it; report forecasted misses explicitly.

Coding sessions are manually started. Scheduled read-only monitoring remains desired, with instructions in [progress monitor instructions](progress-monitor-instructions.md). Claude maintains the tracking documents after each session. This documentation update does not configure Cursor, send Slack messages or authorize live execution. Prior status sections and historical evidence remain unchanged; their dates and limitations still apply.
