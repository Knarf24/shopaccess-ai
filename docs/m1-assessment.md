# ShopAccess AI — M1 implementation assessment

Prepared October 16, 2026 (America/New_York) by Claude, at the owner's request. The owner's October 24 target and the full agreed scope are unchanged. Nothing here authorizes application execution, live integration, payment, database work or deployment. Planning record only: no application code was changed, and nothing was run, called, paid, migrated or deployed to produce it.

## Basis

- **Source inspected:** `main` at `5eb1ed9af6b1c0277330465e9778dcefe6620a53`. Application source (`src/`, `tests/`, `package.json`) is byte-identical to `0379134d4ec61117fa334caa16c2b59d9308ebe4`, the October 15 publication; the five later commits change only `docs/`.
- **Method:** reading source files and searching the tree. No tests, builds, browsers or services were run for this assessment. "Source" below means present in the published code, not that it works.
- **Evidence labels used in this document:**
  - **source:** read in the published tree at the commit above.
  - **unit (historical):** the database-free suite ran on a working tree before `0379134` (October 15). The published commit itself has not been re-tested.
  - **browser / SR / live (historical):** observations recorded in the owner's private evidence store. These are **not published**, so the progress monitor cannot verify them. They are listed by directory name only.
  - **owner-reported, unverified:** stated by the owner and backed by no retained evidence.
  - **documented:** stated in official third-party documentation, and untested by this project.
  - **assumption:** an untested proposal.
- **Estimates:**
  - hours of implementation plus verification for one implementer familiar with the codebase;
  - ranges, with assumptions and confidence;
  - "not estimated" where a dependency is unknown.

  Estimates are not commitments, and the totals are not completion percentages.

## Summary

- Reusable and source-confirmed:
  - session, admission and request guards;
  - server-priced quote, explicit confirmation and checkout-intent binding;
  - payment state machine and PayPal Sandbox adapter;
  - Channel3 adapter (disabled);
  - English/Spanish copy;
  - a laptop readiness engine with evidence-quality grading.
- Missing from the source entirely:
  - browser extension;
  - device profile;
  - permission grants and revocation;
  - voice;
  - charger compatibility;
  - durable conversation;
  - mid-session language switching.
- Every F-row still needs acceptance evidence; none is accepted.
- **Estimated total (partial):** 136–239 hours across the estimated parts of F01–F12, plus 8–11 hours of M1 experiments (144–250 hours). It excludes unestimated work, notably agent-completed external checkout, so it is **not a complete delivery forecast**. This is higher than the 110–190 hours in the earlier verbal review because verification is now counted per feature and mid-session language switching is included.
- **Forecast:** October 24 is likely to be missed (see [Forecast](#forecast-against-october-24)).

## F01–F12

### F01 Conversational clarification through selection and purchase review

- **Exists (source):**
  - `src/lib/session/conversation.ts`: at most 8 turns (`MAX_CONVERSATION_TURNS`), held in process memory (a `WeakMap`). Not written into a session snapshot. `interfaceLanguage` is fixed per draft.
  - Corrections withdraw purchase selections through `invalidatePurchaseSelections`.
  - `src/components/mock-journey/NeedsConversation.tsx`, `src/app/shop/needs/*`.
  - `src/lib/providers/ai.ts` and `qwen-advisory.ts`: interpretation extracts only intended use (three laptop uses) and a whole-dollar budget.
  - Assistant turns are fixed notice tokens (`src/lib/i18n/needs-notice.ts`), not generated answers.
- **Missing:**
  - one-question-at-a-time planning beyond use and budget;
  - device and other requirements;
  - grounded answers to specification, comparison and navigation questions;
  - honest no-match;
  - preferences captured but not enforced, labelled as such;
  - guidance through purchase review;
  - tool calling.
- **Depends on:** F02 (state), F03 (facts to ground answers), D-AI (live model or mock in the demo).
- **Evidence:**
  - unit (historical) `guided-conversation-20261015-210229`, focused 45/45; no browser observation of a multi-turn conversation;
  - live Qwen cases QW-1 to QW-6 (October 12) covered the earlier laptop advisory only, and QW-2, QW-3, QW-4 failed.
- **Acceptance still needed:**
  - charger request journey in a browser, in both languages, with at least one correction, one specification question, one comparison and one no-match;
  - every factual statement traceable to tool or catalogue evidence.
- **Estimate:** 20–34 h (impl 16–28, verify 4–6). Confidence low. Assumes a tool-calling loop over deterministic tools, a mock model for the unit tests, and live-model use only if separately authorized.

### F02 Durable shared shopping state and optional device profile

- **Exists (source):**
  - Session records and needs drafts can be persisted through `src/lib/session/snapshot-store.ts` (file snapshot, locked, 24 h lifetime) or the PostgreSQL services in `src/lib/pg/*`.
  - PostgreSQL application execution has never been run (governance, Pending).
  - The conversation itself is explicitly excluded from snapshots.
- **Missing:**
  - durable conversation state;
  - a device profile with per-field consent, view, edit and delete;
  - ownership isolation tests across the website and extension;
  - a session API the extension can call.
- **Depends on:** the API contract (M2); F05 for cross-surface use; the D-store decision (snapshot vs PostgreSQL for the demo).
- **Evidence:** unit (historical) snapshot-store and session tests; nothing for profiles.
- **Acceptance still needed:**
  - restart and resume keeps the conversation and profile;
  - a second session cannot read the first's;
  - delete removes the profile;
  - consent off means the profile is not used.
- **Estimate:** 11–19 h (impl 8–14, verify 3–5). Confidence medium-low. Assumes extending the file snapshot rather than first executing PostgreSQL. Using PostgreSQL would need separate authorization and is not estimated.

### F03 Product compatibility and explanatory comparison

- **Exists (source):**
  - `src/lib/readiness/engine.ts`: laptop-only factors (affordability, availability, memory, storage, portability) with evidence quality VERIFIED, SHOPPER_STATED, UNVERIFIED, STALE, CONTRADICTORY or MISSING. That grading is reusable.
  - `src/lib/catalog/schemas.ts`: `LaptopSpecsSchema` is a fixed laptop schema; the catalogue is laptops only.
- **Missing:**
  - a charger and cable category schema;
  - curated device facts (connector, original adapter wattage);
  - compatibility rules returning compatible, incompatible or unknown, with a question;
  - comparison output;
  - charger catalogue rows.
- **Depends on:** curated device evidence (Apple's adapter guidance is documented, see Sources); F01 to present the results.
- **Evidence:** unit (historical) for laptop readiness only.
- **Acceptance still needed:** device-specific compatible, incompatible and unknown cases, each with the evidence it relied on, and a comparison of 2–3 shortlisted items.
- **Estimate:** 11–18 h (impl 8–14, verify 3–4). Confidence medium.

### F04 Current external discovery

- **Exists (source):** `src/lib/providers/channel3-discovery.ts`:
  - `CHANNEL3_LIVE_ACTIVATION = false`;
  - limits: 3 actions per session, 1 search, 5 detail calls, 8 s deadline, 2 s timeout, 256 KB response cap;
  - queries are mapped to laptop uses;
  - listing state lives in process memory;
  - `ExternalListingView` has no image and is not a merchant quote.
- **Missing:**
  - category-aware queries;
  - mapping listing text to compatibility facts, with conflicts flagged;
  - any live verification.
- **Depends on:** separate owner authorization for a live call (credentials and spending); D-discovery.
- **Evidence:**
  - unit (historical) `channel3-offline-20261015-165528`, `channel3-pending-render-20261015-175245`;
  - browser (historical, owner-operated) showed the disabled-search message, and pending was not observed (inconclusive);
  - **owner-reported, unverified:** a Postman exploration outside the application returned conflicting fields. It has no retained evidence and is not an application integration.
- **Documented:** the Channel3 search API returns offers with buy URLs, and its UCP endpoint is catalogue-only (Sources).
- **Acceptance still needed:** an authorized live response and its browser display, with conflicting facts shown as unverified.
- **Estimate:** 5–9 h (impl 3–6, verify 2–3). Confidence low. The live portion is gated.

### F05 Browser extension and website continuity

- **Exists (source):** nothing. There is no manifest, extension directory, pairing route or `chrome.*` usage.
- **Missing:**
  - a Manifest V3 extension with a side panel;
  - one-time pairing to a scoped, revocable token;
  - the shared conversation view;
  - per-site runtime host permission;
  - install instructions for judges.
- **Depends on:** M2 API contract, F02, F07.
- **Documented:**
  - the side panel needs the `sidePanel` permission, Chrome 114+ and Manifest V3;
  - `sidePanel.open()` needs Chrome 116+ and a user action;
  - panels can be enabled per tab or site;
  - host access can be optional and granted at runtime;
  - publishing to the Chrome Web Store requires single purpose, Limited Use and a privacy policy.
- **Assumption:** judges can load an unpacked extension. This is unconfirmed against the event rules.
- **Acceptance still needed:**
  - installed extension pairs;
  - the same session continues between the website and the panel;
  - revoking the pairing stops access;
  - works by keyboard and screen reader in the panel.
- **Estimate:** 18–30 h (impl 14–24, verify 4–6). Confidence low.

### F06 Supported-store navigation and shopping actions

- **Exists (source):** nothing for external stores. The merchant schema allows only the simulated Sandbox merchant (`simulatedSandbox: literal(true)`), and external listings cannot enter the demo checkout.
- **Intended goal (owner scope, unchanged):** the agent completes the external purchase within the shopper's explicit, scoped authorization, through the retailer's authorized checkout, and verifies the outcome. A handover to the retailer's checkout page is **not** completion of this goal.
- **All external-store findings below are documentation-based and untested by this project.**
- **Documented (Shopify, official):**
  - Storefront API `cartCreate` returns a `checkoutUrl` that "redirects customers through Shopify's web checkout"; the buyer completes checkout there.
  - Shopify's agent documentation describes catalogue, Cart and Checkout MCP servers (UCP).
    - Checkout requires authentication or a signed request, and access "scale[s] with how your agent identifies itself".
    - Direct `complete_checkout` is available "when eligible". **Eligibility is unresolved:** the trust-tier criteria are on Shopify's auth and rate-limiting page, which was not read, and whether a development store and an unreviewed agent qualify is unknown. This is the documented candidate route to agent completion.
    - Non-terminal states return a `continue_url` that "hands the buyer off to the merchant's storefront".
    - "The merchant always remains the merchant of record."
  - Development stores can take test payments only through the Bogus gateway or a provider in test mode, so PayPal Sandbox payment on a Shopify development store is not documented.
- **Documented (Amazon):**
  - No consumer cart or ordering API was found.
  - PA-API 5 is being retired in favour of the Creators API (catalogue and affiliate data).
  - The retail Conditions of Use exclude "robots, or similar data gathering and extraction tools". The official page returned 503 on October 16 and the wording came from search snippets, so it must be re-read before relying on it.
  - Amazon v. Perplexity is ongoing.
- **Assumption (proposed, untested):**
  - Test on one owner-controlled, labelled Shopify development store.
  - Pursue agent completion through Checkout MCP `complete_checkout` if eligibility is established.
  - Until then, the reachable mechanics are reading product facts, preparing the cart, prefilling only approved fields, and the documented `continue_url` / `checkoutUrl` handover, with test payment through the Bogus gateway.
  - If only the handover is achieved, it is reported as **partial**: the agent-completion criterion stays unmet.
- **Unavailable sources:** Amazon's Conditions of Use (503 on October 16); Shopify's trust-tier criteria (not yet read).
- **Missing:** everything: store adapter, content script, form filling, agent checkout completion, handover fallback, and outcome verification.
- **Depends on:**
  - D-store (owner Shopify account and store);
  - F05, F07;
  - experiment E2.
- **Acceptance still needed:**
  - terms and API review recorded;
  - on the supported store, within a scoped grant: cart prepared, approved fields filled, **checkout completed by the agent**, and the outcome verified from the store's order record;
  - refusal when the grant, item or price does not match.
- **Estimate:** 11–21 h covers only the Shopify development store mechanics up to the handover (impl 8–16, verify 3–5). Confidence low. **Not estimated:** agent checkout completion through Checkout MCP (eligibility unknown), Amazon actions, and any second store. **F06 therefore has no complete estimate.**

### F07 Scoped revocable delegated-purchase permissions

- **Exists (source):**
  - per-purchase controls only: server quote (`src/lib/quote/quote.ts`), explicit confirmation (`src/lib/confirmation/confirmation.ts`), checkout-intent binding (`src/lib/checkout/*`);
  - corrections withdraw confirmation;
  - session rotation and revocation (`src/lib/session/service.ts`).
- **Missing:**
  - a grant model (scope, item, seller, quantity, amount limit, expiry);
  - separate account-access and spending grants;
  - a permissions page with revoke;
  - policy checks before each tool;
  - refusal when the item or price changes.
- **Depends on:** M2 contract; F05 and F06 consume it.
- **Evidence:** unit (historical) for quote and confirmation only.
- **Acceptance still needed:** limit, expiry, revocation, changed-item refusal and changed-price refusal; account access never implies spending.
- **Estimate:** 10–18 h (impl 8–14, verify 2–4). Confidence medium-low.

### F08 Verified payment and repeat purchasing

- **Exists (source):**
  - `src/lib/payment/state-machine.ts`, `orchestrator.ts`, `capture-evidence.ts`, `operations.ts`;
  - `src/lib/providers/paypal-sandbox.ts`;
  - idempotency handling is present in payment and provider code (`operations.ts`, `paypal-sandbox.ts`).
- **Missing:**
  - an integrated journey on the new catalogue;
  - repeat-order revalidation (price, availability, compatibility);
  - delegated or saved-payment repeat purchasing.
- **Evidence:**
  - live (historical, private) attempts 1–8 exited non-zero.
  - Attempt nine (October 15, 14:45–14:48 UTC) recorded `CAPTURED_VERIFIED` with journey status 0, but **overall exit 6** (Chrome cleanup signal failure); acceptance NOT MET. Directories: `paypal-sandbox-journey-9-tool-record-20261015-144541`, `paypal-sandbox-live-20261015-144549`.
  - Correction 28 passed offline controls 145/145 and was not executed live; it does not change attempt nine.
  - All of these ran on trees before `0379134`.
- **Documented:** PayPal Vault with the Orders API is limited release, and wallet vaulting needs billing-agreement approval. PayPal Agent Ready and Store Sync require access approval.
- **Acceptance still needed:**
  - a current, separately authorized Sandbox journey on the integrated product;
  - duplicate prevention;
  - repeat-order revalidation.
- **Estimate:** 10–20 h for the integrated journey plus repeat-order revalidation (impl 8–16, verify 2–4). Confidence medium. **Not estimated:** saved-payment or delegated repeat charging (limited release, approval unknown).

### F09 English/Spanish with explicit switching

- **Exists (source):**
  - `src/lib/i18n/*` (`demo-copy.ts`, `language.ts`, `assessment-reasons.ts`, `needs-notice.ts`);
  - the language is chosen at entry, and the conversation language is fixed per draft (no switching);
  - `src/app/layout.tsx` sets `<html lang="en">`, and the journey wraps content in `lang={language}`.
- **Defect:**
  - **Reported (owner-operated, private record `ui-browser-check-manual-20261015-233357`):** choosing Spanish gave `lang=es` with English content. Undiagnosed.
  - **Hypothesis (from reading source, untested):** `src/app/shop/needs/page.tsx:123` prefers an existing draft's language over the `lang` query value, so a draft started in English would keep English.
- **Missing:**
  - explicit switching mid-session;
  - Spanish for every new F01–F07 and F10 screen and the extension;
  - original listing text kept visible.
- **Acceptance still needed:** a bilingual browser journey with switching, in which amounts, currency and identifiers are unchanged.
- **Estimate:** 10–19 h (impl 8–16, verify 2–3). Confidence medium-low. This grows with every new screen.

### F10 Voice input and output

- **Exists (source):** nothing (no `SpeechRecognition` or `speechSynthesis`).
- **Documented:**
  - Chrome's Web Speech recognition sends audio to a server by default, and on-device recognition is being introduced;
  - Safari exposes a prefixed API;
  - Firefox support is behind a flag.
- **Missing:**
  - push-to-talk with an editable transcript;
  - optional spoken output that does not talk over the screen reader;
  - handling of microphone denial;
  - voice can never confirm a purchase alone.
- **Acceptance still needed:** correct transcription with recovery in both languages, a typed fallback, and coexistence with VoiceOver.
- **Estimate:** 6–11 h (impl 4–8, verify 2–3). Confidence medium. Assumes the browser API only, with no paid speech service.

### F11 Keyboard and screen-reader independence

- **Exists (source):**
  - skip link and accessible names (October 13 work);
  - `role="status"` and `role="alert"` on advisory, listing and payment states;
  - focus restoration only in `ListingSearchForm.tsx:68`;
  - no focus management in `NeedsConversation.tsx`.
- **Evidence:**
  - SR (historical, October 12) Safari and VoiceOver pass on the earlier flow;
  - automatic VoiceOver announcements unresolved;
  - A35 unmet;
  - browser (historical) recovery run, where focus went to the body after submission.
- **Missing:**
  - focus moved to the new turn or answer;
  - announcements for every new answer;
  - side-panel accessibility;
  - accessible permission controls.
- **Acceptance still needed:** an owner VoiceOver journey across the website and panel to final review, recorded separately from markup checks.
- **Estimate:** 13–20 h (impl 10–16, plus 3–4 h of owner VoiceOver time). Confidence medium-low.

### F12 Submission and reproducibility

- **Exists:**
  - private GitHub repository `Knarf24/shopaccess-ai`;
  - README with `npm run dev`, typecheck, lint and build;
  - **no LICENSE file** (source).
- **Unverified:** the event rules. The October 12 record says central PayPal, an AI tool, a functional build for judges, a public licensed repository and a video under 3 minutes, with a deadline of November 12, 2026 at 12:00 PST. The official rules page returned 403 to Claude.
- **Missing:**
  - a licence (owner decision);
  - judge access (public repository, deployment or local setup);
  - extension install steps;
  - a video showing the actual product;
  - a submission checklist.
- **Acceptance still needed:** setup verified on a clean machine, rules re-read, and a video showing only the working product, with its boundaries stated.
- **Estimate:** 11–20 h (setup and licence 3–6, video 6–10, submission 2–4). Confidence medium.

## Totals

| | Low h | High h |
| --- | --- | --- |
| M1 experiments E1–E5 (below) | 8 | 11 |
| F01–F12 | 136 | 239 |
| **Total** | **144** | **250** |

Not estimated, and excluded from these totals: agent checkout completion through Checkout MCP, Amazon actions, any second store, saved-payment or delegated repeat charging, PostgreSQL execution and deployment. The totals are therefore a partial lower bound, not a complete delivery forecast.

## M1 experiments (proposed, not authorized)

| # | Question | Size | Needs |
| --- | --- | --- | --- |
| E1 | Can an unpacked side panel pair with the local server and share one session? | 2–3 h | Local only |
| E2 | Shopify development store: establish Checkout MCP `complete_checkout` eligibility and try agent completion with the Bogus gateway; also cart, prefill and the handover fallback | 2–3 h | Owner Shopify account and store |
| E3 | Does a model reliably call tools in English and Spanish within the time limit? | 2–3 h | Live model authorization, or mock-only design |
| E4 | Does voice work in the side panel (microphone prompt)? | 1 h | Local only |
| E5 | Re-read the official event rules (extensions, judge access, licence, deadline) | 0.5 h | Owner (403 to Claude) |

## Critical path and proposed internal dates

Dependencies: M1 (E1, E2, E5) leads to the M2 API contract, durable state and grants (F02, F07). That unblocks F01 conversation and F05 extension, which can partly run in parallel. F06 store actions need F05 and F07. Then come integrated F08 payment, F09–F11 acceptance, and F12 video and submission.

Critical-path estimate: about 77–126 h, made up of:
- M1: 8–11 h;
- F02 and F07 core: 14–24 h;
- F01: 20–34 h;
- F06: 11–21 h;
- integration, screen reader and submission: 24–36 h.

This assumes F03, F04, F05, F09 and F10 run in parallel with it.

**Proposed internal dates (PROPOSED, not owner-approved; compressed to fit the owner's October 24 target):**

| Milestone | Proposed finish | Entry condition |
| --- | --- | --- |
| M1 Product contract and feasibility | Sat Oct 17 | This assessment, E1–E5 authorized and run, owner decisions recorded |
| M2 Shared foundation | Mon Oct 19 | M1 |
| M3 Conversational shopping | Wed Oct 21 | M2 |
| M4 Discovery and extension | Wed Oct 21 | M2; live discovery only if authorized |
| M5 Authorized purchasing | Thu Oct 22 | M2, M4; Sandbox run only if authorized |
| M6 Inclusive acceptance | Fri Oct 23 | M3–M5; owner VoiceOver session |
| M7 Integrated submission | Sat Oct 24 | M6; owner records video |

These dates assume at least two implementers working in parallel after M2, at least 16 productive hours per day of combined capacity (about 10 h/day on the critical path), the low end of every estimate, and no failed experiment. None of these assumptions is established: owner hours and agent assignments are not recorded.

## Forecast against October 24

**Forecasted miss, likely.** This forecast uses only the estimated work. The unestimated items, including agent checkout completion, can only add to it.
- From Oct 16 to Oct 24 there are 9 calendar days.
- Midpoint total: about 197 h. Midpoint critical path: about 100 h.
- The critical path is sequential, so one implementer works it at about 10 h/day. Starting Oct 16, it ends around Oct 23 at the low estimate (77 h), Oct 26 at the midpoint (100 h) and Oct 28 at the high estimate (126 h).
- Total work at 12 h/day of combined capacity takes about 12 days at the low estimate (144 h, ending about Oct 28) and 16 days at the midpoint (197 h). Finishing all of it by Oct 24 needs about 16 h/day of combined capacity at the low estimate.

At risk on October 24 if nothing changes:
- F05/F06 acceptance (extension and supported store);
- F08 repeat-order revalidation and the current Sandbox journey;
- F10 voice;
- F11 final VoiceOver acceptance;
- F12 video.

The options are for the owner; none has been applied:
- (a) add parallel capacity after M2;
- (b) keep the date and accept named criteria as unmet at October 24;
- (c) move the ShopAccess date, which affects Wild Link's start;
- (d) change scope.

This record does not remove features or change the deadline.

## Unresolved owner decisions

1. **D-store:** create a labelled Shopify development store for E2 and F06, or name another supported store.
2. **D-boundary:** agent-completed external purchasing remains the goal. Decide how to proceed if Checkout MCP eligibility is not established in E2: seek eligibility or another authorized route, or accept a handover as a recorded partial result for October 24. No substitution has been made.
3. **D-AI:** live model in the product and video, or the mock (live calls need authorization).
4. **D-discovery:** authorize a bounded live Channel3 verification, or keep it disabled and use curated data.
5. **D-payment:** authorize a current Sandbox journey on the integrated product, and when.
6. **D-state:** extend the file snapshot (assumed) or authorize PostgreSQL execution.
7. **D-category:** chargers only, or chargers and laptops.
8. **D-amazon:** exclude, or link out only.
9. **D-submit:** licence, judge-access method, and re-reading the official rules (E5).
10. **Capacity:** owner hours per day and agent coding assignments.
11. **Forecast response:** option (a)–(d) above.

## Sources

- Shopify: [Agents overview](https://shopify.dev/docs/agents) · [Checkout MCP](https://shopify.dev/docs/agents/checkout) · [Agent authentication](https://shopify.dev/docs/agents/get-started/authentication) · [Manage a cart (Storefront API)](https://shopify.dev/docs/storefronts/headless/building-with-the-storefront-api/cart/manage) · [Development store payment testing changes](https://shopify.dev/changelog/changes-to-order-and-payment-testing-on-newly-created-development-stores)
- Chrome: [sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) · [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) · [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies/policies) · [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use/)
- Amazon: [Conditions of Use](https://www.amazon.com/gp/help/customer/display.html?nodeId=GLSBYFE9MGKKQXXM) (returned 503 on October 16; wording from search snippets) · [PA-API 5 documentation](https://webservices.amazon.com/paapi5/documentation/) · [Creators API: PA-API 5 deprecation](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation) · [Northeast Times: appeals court sides with Perplexity](https://northeasttimes.com/2026/08/06/appeals-court-sides-with-perplexity-ai-in-amazon-shopping-dispute/) (secondary)
- PayPal: [Agentic commerce services](https://developer.paypal.com/agentic-commerce-services/about) · [Store Sync](https://developer.paypal.com/store-sync/overview) · [Save payment methods (Orders v2)](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/save-payment-methods/) · [Vault with Orders API (limited release)](https://developer.paypal.com/limited-release/vault-payment-methods/orders-api/)
- Channel3: [Search guide](https://docs.trychannel3.com/guides/search) · [UCP quickstart](https://docs.trychannel3.com/ucp/quickstart)
- Speech: [Chromium Intent to Ship: on-device Web Speech](https://groups.google.com/a/chromium.org/g/blink-dev/c/VNOok2dbmHM/m/TQpe9shjCgAJ)
- Apple: [Use a power adapter with your Mac](https://support.apple.com/en-asia/109509)
- Event rules: [Devpost rules](https://paypalaihackathon.devpost.com/rules) (403 to Claude; unverified)
