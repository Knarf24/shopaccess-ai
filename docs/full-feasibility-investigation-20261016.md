# Full feasibility investigation — ShopAccess AI
Date: October 16, 2026, America/New_York.
Role: Codex, read-only feasibility investigator.
Assignment: extend the external-store investigation across E1–E5 and the revised product's dependencies.
Delivery: this research session; proposed October 16 18:00 deadline was not treated as owner-approved. Product target remains October 24.
Status: documentation research and selected source inspection completed; runtime feasibility remains open.

## Method and limits
Read the published M1 assessment and previous external-store report. Read current qwen-advisory.ts, snapshot-store.ts and config.ts through GitHub. Consulted primary vendor documentation listed below. No local Mac files or private evidence were available. No application tests, browser prototypes, credentials, product API calls, model calls, store creation, payments, database execution, deployments or installs occurred. Read-only public documentation retrieval is distinct from product integration calls. This is not an exhaustive correctness/security audit of the repository.

## Findings by workstream
| Workstream | Established | Remaining proof |
| --- | --- | --- |
| E1 extension and pairing | Chrome MV3 side panels and extension-origin network requests are supported; host permission is needed. Extension service workers can terminate. | Actual installation, pairing, session continuity, stale-write conflict, expiry and revocation |
| Shared state | Existing snapshot code has authenticated snapshot handling, writer locking, temp-file publication and rename/fsync paths. | Conversation/profile/grant schema integration, restart, isolation, deletion and durability tests |
| E2 server Shopify | Native completion requires a granted Token-tier purchasing permission; ordinary token issuance is insufficient. | Our eligibility, compatible payment handler and development-store order |
| E2 browser Shopify | WebMCP exposes current-checkout tools including completion after buyer confirmation. Browser keys/authentication and supported checkout constraints apply. | Extension tool invocation, registered-agent access, test payment and confirmed order outcome |
| Shopify plus PayPal | Shopify Payments test mode explicitly excludes PayPal Wallet. Third-party test support varies by gateway. | PayPal Sandbox availability in the proposed Shopify environment; no equivalence with Bogus/test cards |
| Amazon consumer | Ordinary personal-account ordering route and retail terms remain unverified. | Authorized integration route and terms |
| Amazon Business | Separate Ordering API exists: placeOrder, orderDetails, OAuth, price expectations and safeguards. Documentation estimates 4–6 weeks onboarding. | Account eligibility, approval and test access; not personal-account support |
| E3 live assistant | Qwen supports function calling; existing provider sends model requests but does not establish a full shopping tool executor. Model ID is configuration, not a verified chosen model. | EN/ES correctness, grounded responses, cost/latency and policy checks |
| E4 voice | Chrome documents on-device recognition availability queries and language-resource installation. | Actual language/device/side-panel support, permissions, transcription quality and VoiceOver coexistence |
| Compatibility | Apple distinguishes model-specific adapters/cables and USB PD charging requirements. | Curated product evidence, cable capabilities and deterministic device-specific outcomes |
| Discovery | Channel3 UCP explicitly supplies catalog operations, not cart/order checkout. | Current key/balance, application live response and matching product facts |
| Repeat payment | PayPal documents wallet setup approval and payment-token flows; reference transactions require approval/configuration. | Our sandbox entitlement, initial buyer approval, permitted subsequent charge and revocation |
| Accessibility | W3C guidance covers programmatically exposed status and logical focus order. | Actual keyboard/VoiceOver acceptance on both surfaces |
| E5 submission | Official rules retrieved in the preceding investigation. Public licensed repo, working build, central PayPal Sandbox and AI, actual-function video under 3 minutes. | License decision, judge setup verification and final submission |

## Corrections to earlier assumptions
Amazon is not a single API category. Its seller Orders API is for seller order data; Amazon Business Ordering API can place purchases for business customers. No ordinary consumer purchasing API was established here. Business onboarding duration is vendor guidance, not an estimate of our coding time.

Do not treat a failed retail terms lookup as permission, a legal conclusion, or evidence that every form of Amazon integration is impossible. No Amazon actions were attempted.

Shopify server MCP and browser WebMCP are separate candidates. Browser tooling does not automatically grant server completion permission. Browser checkout documentation requires buyer confirmation and permits interactive payment steps; it does not establish unattended purchases.

Existing access/session tokens are not PayPal vaulted payment tokens. A previous captured order does not establish a saved wallet, billing agreement or merchant-initiated charging permission. A ShopAccess spending grant also does not confer provider authorization or allow one merchant to charge another retailer's order.

## Architecture implications (proposals, not implementation)
Reuse existing quote, confirmation and payment verification. Keep the model's requested action separate from deterministic authorization/execution.
- Extension communicates with a fixed backend origin through extension-owned code. Do not expose arbitrary URL fetching through page messages.
- Use explicit one-time pairing, narrowly scoped credentials and server-side revocation. Do not assume existing same-origin cookies/CSRF routes are an extension API.
- Keep transient credentials out of content-script-readable storage. Choose persistent versus session-only credential storage deliberately; neither removes the need for revocation and expiry.
- Persist authoritative shopping state on the backend; do not rely on a service-worker global surviving. Use versions to reject outdated requirements or offers.
- Maintain distinct account-access and purchase permissions. Recheck item, variant, seller, quantity, final total including shipping/tax, currency, expiry and current grant immediately before execution.
- Tool output and page text are untrusted facts. Tool annotations are signals; they do not replace policy checks.
- Implement original-language facts separately from translated explanations. A language switch must not mutate totals or create a new spending grant.

File snapshots can be evaluated without reopening PostgreSQL immediately. This is a proposed path for one controlled instance, not a production scale recommendation. Multi-instance hosting, durable volume availability, encryption key lifecycle and backup/restore remain deployment questions. No storage choice has been imposed.

## Compatibility rules that need care
Apple says USB-C charging requires a USB PD source, with appropriate safety compliance; its recommendation favors at least the model's recommended wattage for best experience. Lower wattage is not automatically physically incompatible. Separate connector/protocol compatibility, charging performance and fast-charge eligibility. A 2019 MacBook Pro is insufficient identification: Apple's reference distinguishes 13-inch 61W, 15-inch 87W and 16-inch 96W adapters. Ask for screen size/exact model and cable information. Do not assert safety certification from a listing title. Retain unknown when specifications conflict.

## Model and sponsor options
Qwen is a documented candidate aligned with the existing provider. Tool calls are instructions returned to our application; the model does not execute them itself. Strict JSON support is model-specific and schema validity does not establish factual correctness. Select a concrete model/region/endpoint only after checking account availability. No additional application provider was selected.

Channel3 also documents a hosted conversational product with follow-up and offer-comparison behavior. It is an option to assess, not an adopted replacement: it does not establish compatibility guarantees, bilingual acceptance, delegated permissions or payment completion. Its public pricing lists one credit per conversation turn plus search usage, so it should not be layered onto another live model without an explicit cost decision.

Channel3 pricing currently lists search at one credit and product reads free; additional credits at USD 0.007 each, with a general monthly allowance. This is not the owner's verified account balance or sponsor entitlement. Product-detail refresh guidance supports keeping indicative search data separate from refreshed offers. The retrieved Checkout page contained navigation but no substantive integration instructions; its title does not establish a checkout API.

Postman can contribute reusable API examples and mock responses. Proposed collections: pairing/session contracts, grant refusal cases, compatibility inputs, discovery mapping and sandbox order verification. Use sanitized synthetic fixtures. Hosted Postman mocks are network services and would not qualify as the existing no-TCP unit tests. No Postman workspace, collection, mock server or secret was opened or changed.

## Bounded experiment proposals — none run or activated
Budgets below are proposed maxima, not permissions or vendor billing guarantees. Any changed budget requires an owner decision.

### E1 local pairing
Role: extension/session implementer (agent unassigned). Proposed allocation: 2–3 hours after contracts are agreed.
Create an isolated local prototype with synthetic data and mock checkout. Open one unpacked extension; pair once; continue a conversation between site/panel; reject a stale update; restart the server; revoke and try again.
Pass: state and language persist as designed, a second session is isolated, revoked/expired credentials cannot access it, and no payment/provider request occurs.
Stop: unexpected external traffic, missing ownership isolation or changes outside prototype scope.
Prerequisites: local service/browser permission and explicit source-edit scope.

### E2 store checkout
Role: store integration investigator (unassigned). Initial route investigation allocation: 2–3 hours; full completion remains unestimated.
First confirm access and test-provider setup. Inspect eligible WebMCP tools or server purchasing entitlement; do not assume either from an account login.
Proposed first live stage, separately authorized: at most 10 read-only merchant discovery/state requests, no cart/order/payment. Record tool schemas and browser version.
If prerequisites pass, propose a second authorized stage: one synthetic test item, at most one cart/checkout and one completion attempt, fixed test total agreed beforehand, no fulfillment, verified test gateway only. After timeout or ambiguous completion, read order state; never blindly retry.
Pass for complete scope: authorized agent execution produces a verified merchant order with exact item/total. Handover alone stays partial. PayPal Sandbox requires its own proved supported path and capture evidence.
Stop before any real charge, production endpoint, unexpected login/challenge, unknown payment environment or missing permission. No store creation authorized.

### E3 bilingual tools
Role: conversation implementer (unassigned). Proposed allocation: 2–3 hours once executor fixtures exist.
Offline cases: missing device, correction, no-match, comparison, malicious listing instruction and unauthorized purchase, each in English/Spanish.
Proposed live pilot: maximum 12 model requests total including tool-result follow-ups; fixed token limits and no automatic retries; synthetic facts only, no product/payment calls.
Pass: correct supported tool/arguments, unsupported actions refused by executor, factual claims grounded, language retained/switched deliberately. Record every failure, latency and token usage. This pilot is not general reliability acceptance.
Prerequisite: exact model, key approval and dollar cap before any live request.

### E4 voice
Role: extension/accessibility implementer (unassigned). Proposed allocation: 1 hour once panel exists.
Inspect capability and language availability, request microphone only after user action; test English/Spanish editable transcripts, cancellation, denial and typed fallback. No silent switch from on-device to remote processing; request consent for audio transmission and downloads.
Pass: actual microphone behavior in the panel and website, no duplicate turn submission, usable keyboard controls and optional speech that can be stopped. VoiceOver acceptance is separate.
Prerequisites: real target browser/device and microphone permission. Not possible to certify from documentation.

### Discovery and PayPal follow-ons
Channel3 pilot proposal: one search and no more than five sequential detail reads under existing budgets, after account/cost approval; no redirect purchase or cart. Confirm returned product identity and refreshed offer provenance.
PayPal pilot: prepare a separate procedure on the integrated source, with one agreed sandbox intent and amount, explicit approval, capture verification, duplicate prevention and clean cleanup. Do not reclassify attempt nine.
Vaulting requires a distinct entitlement/setup experiment; do not bundle saving a payment method into a basic capture test.

## Schedule and next handoff
October 24 remains the owner's target. No measured experiment has reduced the partial 144–250-hour estimate, and provider approvals remain unestimated. Amazon Business's published onboarding duration is a dependency risk that more coding agents cannot remove.

Next manual coding task should establish the shared contract and E1 prototype while E2 access is resolved; this is a sequencing recommendation, not a new assignment. Every later prompt must name role, owned files, deliverable, acceptance criteria, dependencies, allowed actions and approved deadline. Specific internal dates and coding agents remain owner decisions. Do not mark full investigation as experimental acceptance.

## Primary sources checked October 16
- Chrome side panel: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Cross-origin requests: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- Service worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Message validation: https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- Extension storage: https://developer.chrome.com/docs/extensions/reference/api/storage
- WebMCP security: https://developer.chrome.com/docs/ai/webmcp/secure-tools
- On-device speech: https://developer.chrome.com/blog/new-in-chrome-139/
- Shopify auth: https://shopify.dev/docs/agents/profiles/auth-and-rate-limiting
- Shopify browser checkout: https://shopify.dev/docs/agents/carts-and-checkout/checkout-webmcp
- Shopify tests: https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments
- Third-party tests: https://help.shopify.com/en/manual/checkout-settings/test-orders/payments-test-mode
- Amazon Business: https://docs.business.amazon.com/docs/ordering-api
- Qwen tools: https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling
- Qwen structured output: https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output
- Apple adapters: https://support.apple.com/en-us/109509
- Channel3 UCP: https://docs.trychannel3.com/ucp/quickstart
- Channel3 pricing: https://docs.trychannel3.com/pricing
- Channel3 refresh: https://docs.trychannel3.com/guides/caching
- Channel3 conversation: https://docs.trychannel3.com/conversations
- Channel3 checkout (no substantive body retrieved): https://docs.trychannel3.com/checkout
- PayPal wallet setup: https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal
- PayPal vault setup: https://developer.paypal.com/api/save-with-purchase/save-payment-methods/
- Postman mocks: https://learning.postman.com/docs/design-apis/mock-apis/set-up-mock-servers/
- Postman Vault: https://learning.postman.com/docs/use/postman-vault/postman-vault-secrets/
- W3C status: https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- W3C focus: https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html
- Rules (read in preceding investigation): https://paypalaihackathon.devpost.com/rules
