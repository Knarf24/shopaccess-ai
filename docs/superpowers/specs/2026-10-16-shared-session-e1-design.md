# Shared website/extension contract and E1 prototype design
Date: October 16, 2026. Status: proposed design for owner review, not implemented.
Role: Codex, shared-contract designer. Deliverable: this reviewed specification in the current session. Product target October 24; implementation deadline not yet approved.
Baseline: main 173156fb2d1c388e78d073c692c70ca037e7afc8. Application baseline remains 0379134.
Scope: foundation and local mock E1 only. Full product goals remain in governance.

## Intent and success
A shopper pairs the extension with their current website session, continues the same shopping conversation across surfaces, changes language explicitly, and can revoke access. Sessions must not leak across shoppers. Restart testing distinguishes intentionally lost ephemeral pairing credentials from durable shopping state. This design adds no purchasing authority.

## Existing code constraints
src/lib/session/service.ts resolves digested tokens, enforces two-hour idle and 24-hour absolute lifetimes, rotates tokens and revokes sessions.
src/lib/session/store.ts owns versioned drafts and server confirmation fields.
src/lib/session/conversation.ts retains eight lines and purchase invalidation epochs in process-local WeakMaps.
src/server/handlers.ts uses guarded form mutations. src/server/runtime.ts constructs provider/runtime dependencies and is the environment reader.
Do not extend browser CSRF exceptions to accept extension-origin requests on existing purchase routes. UI types stay outside lib/session to preserve SEC-01.

## Approaches considered
1. Recommended: explicit pairing and separate scoped extension JSON API, adapting the existing session service. More endpoint work, but clear revocation and authority.
2. Reuse website cookies from the extension. Less initial code, but origin/cookie behavior and request guards become coupled; no adopted design.
3. Independent extension session with copied conversation. Easier isolation, but violates shared authoritative state unless synchronization is added.
No storage platform migration is selected.

## E1 boundaries
The first executable prototype is isolated under experiments/e1-shared-session/ with synthetic data, a loopback-only mock server and unpacked MV3 extension. No production route or existing source changes are required for the spike.
It validates the proposed protocol; it does not by itself establish integration with the real session/snapshot implementation. A later separately reviewed implementation adapts the contract into src/.
No model, Channel3, PayPal, retailer, database or deployment calls. No automatic purchase, payment fields, bank details, cookies API, debugger or all-sites host access.

## Pairing protocol
The extension generates a 32-byte verifier, keeps it in extension session storage, and sends only its SHA-256 challenge to POST /api/extension/v1/pairings. Request body has protocolVersion:1 and challenge. Server assigns an opaque pairing ID and 32-byte exchange secret; expiry five minutes. No website session is returned.
Extension opens a fixed-origin pairing page with the public pairing ID only. The exchange secret and verifier never enter URLs, page messages or logs.
The website session owner approves the pairing using the existing same-origin cookie, admission and CSRF guard. Approval visibly states conversation read/write and language permissions, with no spending authority. Server binds the pairing to that session only.
Extension polls its pairing at most ten times, no more often than once per two seconds, authenticated by the exchange secret. Server returns only pending, approved, expired or denied.
After approval, POST /api/extension/v1/pairings/{id}/exchange requires exchange secret and original verifier. Verify challenge and consume approval atomically. Return an opaque 32-byte bearer token once. Store only a keyed token digest server-side.
A timeout after successful exchange cannot retrieve the token again: restart pairing rather than allow replay. Limit three pending pairings per session; process-wide creation and polling limits apply before costly work. In E1 approval uses a synthetic website session, clearly labelled.
Pairing expiration, replay, bad verifier and lost responses need explicit tests.

## Token authority
Token scopes are conversation:read, conversation:write and language:write only. Token expiry is the earlier of one hour from exchange or parent session absolute expiry; parent idle expiry and revocation still apply. Extension requests do not silently extend the parent's idle session; use a non-touching parent liveness check for real integration.
Bearer is held only in extension session storage, not sync or page storage, and is not exposed to content scripts. Browser restart requires pairing again while durable conversation can remain.
Same-origin website UI lists and revokes paired access using CSRF protection. Revoke is enforced on every later API operation. Parent logout/revocation invalidates all children. Define rotation behavior conservatively: revoke child tokens on session rotation; preserve shopping state if the parent survives.
Raw secrets are never logged or serialized into snapshots.

## Shopping data contract
Response envelope: protocolVersion, conversationId, revision, requirementsRevision, interfaceLanguage ('en'|'es'), turns, requirements and confirmedRequirementsRevision.
Each retained line has server ID, role ('shopper'|'assistant'), text and sequence number. Preserve the existing eight-line cap for E1; expose truncation honestly. Do not promise unlimited history.
Requirements contain only supported fields. The E1 mock uses laptop use and whole-dollar budget; device/profile/charger fields belong to later schema increments. Unknown fields are rejected.
GET /api/extension/v1/conversation resolves ownership from bearer, never a caller session ID.
POST /api/extension/v1/conversation/turns takes expectedRevision, clientRequestId and text (max 2,000 characters).
PATCH /api/extension/v1/conversation/language takes expectedRevision, clientRequestId and language.
Atomic compare-and-set increments revision; stale writes return 409 with current revision and require re-read. Same request ID and same body returns the recorded result; same ID with different body returns conflict. Serialize commands per session.
Changing requirements advances requirementsRevision and clears confirmation/recommendation and purchase selections. Changing language alone changes interface rendering and revision; it does not change prices, requirementsRevision or spending authority. No new extension endpoint confirms requirements or enters checkout.
Mock replies are labelled deterministic fixtures, never live AI.

## Transport and origin contract
Prototype server binds only 127.0.0.1 on an explicitly chosen free port. Extension permissions include sidePanel, storage and only that exact loopback host pattern; host patterns cannot restrict port, so code fixes the allowed port too.
Requests originate from extension-owned code. API accepts JSON only, enforces body caps, rejects redirects, validates bearer and scopes independently of CORS, and returns no-store responses.
Allowlist the observed unpacked extension origin in prototype configuration. Website-origin approval endpoints require existing CSRF/Origin/admission checks; extension bearer requests cannot call them. Unknown/null origins refuse.
No wildcard credentialed CORS, arbitrary URL relay or externally_connectable messaging. No merchant page script in E1.
Production requires HTTPS and review of deployment origin/pairing enrollment; local HTTP is a labelled prototype boundary.

## Durability and integration plan boundary
E1 mock writes synthetic conversation state through atomic local file replacement for restart tests. Pending pairings, child tokens and deduplication receipts are deliberately ephemeral: restart invalidates credentials and requires fresh pairing. A failed persistence write must not acknowledge a turn.
This is not a replacement for the authenticated snapshot store. Real integration must extend its versioned payload, preserve old snapshots, validate schema and retention, and persist selection invalidation with requirements atomically. In-flight commands never survive restart as success. PostgreSQL, real profiles and payment grants are outside E1.

## User experience and acceptance
Website and side panel expose the same synthetic turn history and explicit EN/ES switch. Use labelled controls, visible pending/error state and stable focus after submission. Speech is not added in E1.
Automated checks: parent ownership, pairing expiry/denial, verifier mismatch, atomic exchange, replay refusal, scope refusal, stale revision, duplicate request, requirements invalidation, language-only preservation, revocation, parent expiry, body cap and disk-write failure.
Real browser checks: install extension, open panel via user gesture, pair, submit on each surface, switch language, duplicate click, revoke, restart and re-pair into restored state. Record browser version and exactly what was observed.
Do not claim real-browser, screen-reader or production integration acceptance from Node tests.
E1 passes its feasibility question only when actual panel/website continuity is observed and the refusal cases pass. A backend-only prototype is partial.

## Implementation ownership and review
Proposed owner for the E1 prototype: Codex. Allowed paths: experiments/e1-shared-session/** and its evidence/design documentation on an isolated branch. No src/, package lock, SQL, merchant assets or payment edits. No dependencies installed without need and explicit scope review.
First implementation plan must list files, commands, test cases and time allocation; current 2–3-hour figure is the previous research estimate, not a guaranteed or approved deadline.
Deliver branch/commit, tests actually run, browser evidence or explicit blocker, cleanup and limitations. Do not merge into main as accepted production functionality.
