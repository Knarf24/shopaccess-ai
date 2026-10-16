# External-store feasibility investigation
Date: October 16, 2026 (America/New_York). Researcher: Codex. Owner target: October 24; no new task cutoff approved.
Method: read published docs/m1-assessment.md and official public documentation. No application, store, credentials, product API, payment, database, or experiment was executed. This supplements the assessment and preserves it unchanged.

## Capability matrix
| Route | Documentation establishes | Not established for ShopAccess |
| --- | --- | --- |
| Shopify server Checkout MCP | Purchase completion requires a Token-tier credential granted purchase permission; signed/anonymous tiers cannot complete. Buyer IP is required for Token-tier calls. | Permission granted to this project, payment-handler compatibility, development-store completion and PayPal Sandbox |
| Shopify browser Checkout WebMCP | Browser checkout tools can complete after buyer confirmation. Requires eligible checkout and browser support; verified-bot setup involves registered keys. No new card details through the tool; other payment methods involve buyer interaction. | This extension's ability to invoke it, store/tool availability, test gateway compatibility and PayPal approval behavior |
| Shopify development store | Test gateway or provider test mode; no real transactions. Store stays password protected. | A functioning Checkout MCP/WebMCP test purchase or specific PayPal Sandbox support |
| PayPal Store Sync WebMCP | PayPal describes discovery/cart/checkout initiation, followed by buyer sign-in, funding review and approval; availability limited to Store Sync merchants | This project's enablement and a completely unattended buying route |
| Amazon | Retail conditions page could not be retrieved in this investigation | Consumer ordering API, permitted automation route and account integration. Do not infer an ordering API exists, or a universal legal prohibition, from the failed lookup |
| Existing ShopAccess sandbox checkout | Previously reported internal merchant integration remains reusable | Independent external-store purchasing. The internal merchant must not charge for a third-party retailer's goods |

Sources S1–S5 below support the documentation rows. Every route remains untested by this investigation. No retailer selection or reduced acceptance boundary is imposed.

## Findings and implications
1. Reading Shopify's auth criteria resolves the documentation question: having any token is insufficient; purchase permission must be granted. Project eligibility remains unknown. The official developer forum response dated August 6 says there was no public self-service application then (S6); this is dated guidance, not proof no later access route exists.
2. Browser WebMCP is a separate candidate worth evaluating for the intended extension. It does not establish arbitrary-site support or unattended buying, and buyer confirmation/payment challenges must remain available. It is an addition to E2's research scope, not an authorization to execute it.
3. PayPal's documented Store Sync experience retains buyer payment approval. Saved-payment delegated charging remains a separate unresolved capability. Shopper permission alone cannot supply a provider capability.
4. A Shopify test-gateway success would not prove PayPal Sandbox integration. Keep external merchant order verification and PayPal capture evidence distinct.
5. The M1 hours remain a partial estimate. These documentation findings supply no measured implementation duration and do not close F06.

## E1–E5 disposition
| Experiment | Result of this investigation | Next dependency |
| --- | --- | --- |
| E1 local extension pairing | Not run | Define pairing API, scopes, revocation and local test procedure |
| E2 Shopify completion | Documentation refined; no store/call/order | Choose candidate route, confirm available permissions/tools and test-provider support before authorizing a bounded experiment |
| E3 bilingual model tools | Not run | Model choice and bounded credential/request authorization |
| E4 voice in side panel | Not run | Side-panel prototype, browser and microphone test procedure |
| E5 event rules | Official page successfully read; documentation portion completed | Check actual deliverables against rules; no submission or agreement accepted |

## Verified event requirements
Rules S7: deadline November 12, 2026, noon PST (3 p.m. EST). Central PayPal Sandbox plus an AI tool is required. Judges need a functioning build; complete setup instructions can replace public hosting. Repository must be public with an open-source license. Video must show working behavior, be public on YouTube and under three minutes. Multiple entries must be substantially different. Third-party integrations require authorized use. No explicit extension-store publication requirement was identified; installability must still be demonstrated. This is a rules summary, not confirmation the project satisfies them.

## Next bounded task
Role: external-store integration feasibility investigator.
Task: draft E2's browser-WebMCP and server-MCP alternatives, with prerequisite access, supported test payment method, order-result verification, hard stop conditions and maximum requests.
Deliverable: an executable experiment proposal with no unapproved live steps, preserving agent-completed purchasing as the goal.
Dependency: no store or credentials are assumed available. No execution authorized here.
Deadline: propose the next manual session; do not invent an approved internal date. Overall owner target remains October 24.

## Sources read October 16
- S1 Shopify auth and rate limiting: https://shopify.dev/docs/agents/profiles/auth-and-rate-limiting
- S2 Shopify Checkout WebMCP: https://shopify.dev/docs/agents/carts-and-checkout/checkout-webmcp
- S3 Shopify development stores: https://shopify.dev/docs/apps/build/stores/development-stores
- S4 PayPal WebMCP announcement, September 16: https://developer.paypal.com/community/blog/WebMCP_PayPal_Agent_Ready/
- S5 Shopify carts and checkout: https://shopify.dev/docs/agents/carts-and-checkout
- S6 Shopify developer community, dated August 6: https://community.shopify.dev/t/how-can-a-token-tier-ucp-client-obtain-permission-to-call-complete-checkout/36590/2
- S7 Official event rules: https://paypalaihackathon.devpost.com/rules
- Unavailable: Amazon retail conditions https://www.amazon.com/gp/help/customer/display.html?nodeId=GLSBYFE9MGKKQXXM ; retrieval returned an internal error. An unavailable old Shopify payment-testing changelog was replaced by the current development-store guide for the general test-only claim.
