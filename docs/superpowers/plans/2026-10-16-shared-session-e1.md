# Shared session E1 implementation plan

> For agentic workers: use superpowers:executing-plans for execution in this session, or superpowers:subagent-driven-development only if the owner selects delegation. Steps use checkboxes.

Goal: establish local website/extension pairing, synthetic conversation continuity and revocation without changing production behavior.
Architecture: isolated loopback mock server and unpacked MV3 side panel, with scoped opaque credentials and versioned synthetic state. All provider/payment authority stays absent.
Tech stack: Node built-ins, node:test, plain extension HTML/CSS/JavaScript; no new dependencies.
Spec: docs/superpowers/specs/2026-10-16-shared-session-e1-design.md
Role: Codex, proposed E1 implementer. Delivery target: October 24 product target; E1 implementation cutoff not yet approved. Record measured work rather than claim a guaranteed duration.
Branch: design/shared-session-e1-20261016, based on main 173156fb.
Status: plan for owner review; no prototype implementation yet.

## Global constraints
- Allowed code paths: experiments/e1-shared-session/** only. Documentation may be added on this branch.
- No src/, dependency, lockfile, SQL, images or payment changes.
- Synthetic local sessions only; mock assistant clearly labelled.
- Bind to 127.0.0.1; choose and record a free port; fail on conflict.
- 32-byte pairing verifier, exchange secret and bearer; SHA-256 verifier challenge; keyed token digest server-side.
- Pairing expires after five minutes; at most three pending per session.
- Poll at most ten times, at least two seconds apart.
- Child credential expires after one hour or parent absolute expiry, whichever is earlier; parent idle limit two hours and absolute limit 24 hours.
- Child requests do not refresh parent idle lifetime; revocation and rotation invalidate children.
- Eight retained conversation lines; 2,000-character input cap.
- Store tokens only in extension session storage; no page messages or secret URL parameters.
- No product API, live AI, credentials, payments, store interaction or deployment.
- Browser restart loses extension credentials; restart server invalidates pending pairings, tokens and receipts. Re-pair to durable synthetic conversation.
- No prototype passing result establishes production integration, voice or screen-reader acceptance.

## Files
All paths below are relative to experiments/e1-shared-session/.
- contract.mjs: validated request/envelope constructors and fixed error categories.
- authority.mjs: synthetic parent sessions, pairing and scoped credentials; injected clock/randomness.
- conversation.mjs: serialized optimistic writes and request deduplication.
- persistence.mjs: validated synthetic JSON load and atomic durable save.
- server.mjs: loopback HTTP adapter, guards and routes; exports a start function for tests.
- web/index.html, web/site.mjs, web/styles.css: synthetic website, explicit pairing approval, conversation and revocation.
- extension/manifest.json, background.mjs, panel.html, panel.mjs, styles.css: user-gesture side panel and fixed backend requests.
- tests/authority.test.mjs, conversation.test.mjs, persistence.test.mjs, server.test.mjs: separate non-network unit checks and loopback integration checks.
- README.md: launch, unpacked install, limits, manual acceptance and cleanup.
- evidence/RESULTS.md: actual source revision, commands, results and gaps; no secrets.

## Shared interfaces
makeAuthority({now, randomBytes, digestKey}) returns createParent(), pairingStart({challenge}), pairingApprove({pairingId,parentId}), pairingStatus({pairingId,exchangeSecret}), pairingExchange({pairingId,exchangeSecret,verifier}), resolve({bearer,scope}), revokeChild({parentId,childId}), revokeParent(parentId), rotateParent(parentId).
Commands return {ok:true,value} or {ok:false,code}; never throw externally visible secret-bearing errors.
makeConversationStore({load,save}) returns read(parentId) and command({parentId,expectedRevision,clientRequestId,kind,payload}); kind is turn or language.
startServer({port,dataDirectory,extensionOrigin}) returns {origin,close}; no implicit startup on import.
HTTP command bodies and responses follow spec protocolVersion 1. Expected revision and request ID are mandatory. Ownership always comes from resolved authority.

## Review focus
1. A pairing popup opened by the wrong shopper must not silently attach credentials: display explicit approval and refuse approval reassignment.
2. Retrying exchange after a lost response cannot issue another credential: consume once and require re-pairing.
3. Two surfaces sending at once must not lose a turn: serialize and reject stale versions.
4. Failed disk publication must not appear successful: keep last committed state and refuse acknowledgment.
5. A page pretending to be the extension must not gain access: origin checks, secrets, scopes and no message-based arbitrary fetch.

## Task 1: authority and pairing
Files: contract.mjs, authority.mjs, tests/authority.test.mjs.
Consumes injected clock/randomness; produces makeAuthority interface above.
- [ ] Write tests for pending/approve/exchange, mismatched verifier, replay, expiry at exactly five minutes, second owner approval, three-pending cap, polling interval/count, scopes, parent idle/absolute expiry, child expiry, revocation and rotation.
- [ ] Assertions include exchange twice -> one success; now == expiry -> refusal; wrong parent cannot revoke; child read does not extend parent lastSeenAt.
- [ ] Run node --test experiments/e1-shared-session/tests/authority.test.mjs; verify expected missing-module failure.
- [ ] Implement fixed validation and atomic synchronous authority transitions, with no I/O/provider imports.
- [ ] Rerun and record passing output; inspect returned errors for secret leakage.
- [ ] Commit only this task's explicit paths.

## Task 2: versioned state and persistence
Files: conversation.mjs, persistence.mjs, tests/conversation.test.mjs, tests/persistence.test.mjs.
Consumes authority parent identity. Produces store.read/command and load/save.
- [ ] Write assertions: concurrent revision 0 commands -> one succeeds and one conflicts; duplicate ID/body -> same result; same ID/different body -> conflict; ninth line trims oldest and flags truncation.
- [ ] Assert language switch increments revision without requirementsRevision; supported requirement correction clears confirmedRequirementsRevision and selection state.
- [ ] Inject save failure and assert both response failure and old state retained. Persist/reload and assert same synthetic history, no credentials. Reject corrupt/unknown-version data.
- [ ] Run node --test experiments/e1-shared-session/tests/conversation.test.mjs experiments/e1-shared-session/tests/persistence.test.mjs and verify expected initial failure.
- [ ] Implement bounded synthetic schema, per-parent serialization and deduplication. Restrict IDs to server-generated values; save before acknowledgment; temp file fsync/rename plus directory sync where supported. If durability cannot be guaranteed, report it rather than suppress errors.
- [ ] Rerun tests; commit explicit task paths.

## Task 3: loopback HTTP and synthetic website
Files: server.mjs, web/**, tests/server.test.mjs.
Consumes tasks 1–2; produces startServer and website.
- [ ] Write loopback tests for JSON/content/body limits (16 KiB wire cap), unknown/null origin, wrong method, missing bearer, scope mismatch, stale revision, guarded synthetic approval/revoke and rate refusal.
- [ ] Assert every response is no-store; no credential in location/HTML/logs; page-origin calls cannot exchange without secrets. Synthetic website CSRF approval token never grants extension bearer scopes.
- [ ] Run server test separately; it requires loopback sockets and must not be described as no-TCP.
- [ ] Implement exact pairing/read/turn/language routes from spec, fixed error responses, five-second request-body deadline, process-wide creation cap 30/minute, polling rate limits and safe close.
- [ ] Website visibly labels synthetic mock mode and renders explicit pairing scopes, history, language switch and revoke. Use focusable headings and status/error regions.
- [ ] Rerun server tests. Commit explicit task paths.

## Task 4: unpacked extension
Files: extension/** and README.md.
Consumes fixed origin and API. Produces installable MV3 side panel.
- [ ] Manifest uses sidePanel and storage; only exact loopback host pattern, with fixed port enforced in code; no all_urls, cookies, debugger or external messaging.
- [ ] Panel creates verifier/challenge and starts pairing; approval opens on fixed website origin with public pairing ID only. Poll with spec limits, exchange once, store child token in session storage.
- [ ] Render read/turn/language/revoke results with textContent, not injected HTML. Disable duplicate submits, retain editable text on failure, handle stale revision with re-read.
- [ ] Restore view on panel reopen from server state. Clear credentials on expiry/revocation; restart requires re-pair.
- [ ] Record static validation of manifest/paths and reject forbidden permissions or provider URLs. Unit/static checks cannot establish actual Chrome behavior.
- [ ] Commit extension and README explicit paths.

## Task 5: acceptance and handoff
Files: evidence/RESULTS.md, README.md; documentation status as applicable.
- [ ] Run unit checks, then separately run loopback integration checks; record exact Node version and exits.
- [ ] Launch mock server with empty starting environment and isolated synthetic directory. Record owned PID and port, without exposing pairing credentials.
- [ ] On a capable user-approved browser, load unpacked extension, open via gesture, approve pairing, send on both surfaces, switch EN/ES, duplicate-submit, revoke and try denied access.
- [ ] Restart server, verify credentials refuse and re-pair restores saved conversation. Browser restart should discard session-storage tokens.
- [ ] Keyboard-check panel and website. Record actual VoiceOver observation only if performed; no inferred announcements.
- [ ] Stop owned server/browser processes and verify port release. Never stop unrelated processes.
- [ ] If browser installation/control is unavailable here, report automated/backend results as partial and provide exact manual steps; leave E1 browser acceptance open.
- [ ] Review diff against allowed paths, secret scan, update evidence with limitations. No main merge or acceptance claim without review.

## Execution handoff
The owner approved the design on October 16. Implementation awaits review of this plan and choice of execution method.
Recommendation: implement directly in this session with manually started checkpoints, preserving credit control. Delegated implementation is optional, not assumed.
A fresh reviewer should inspect the resulting branch before integration. No review agent is launched by this plan.
