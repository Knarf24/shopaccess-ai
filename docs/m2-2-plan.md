# M2-2 plan: integrate the browser extension with the application

## Publication reconciliation — October 17, 2026

GitHub confirms M2-2 merged through [PR #2](https://github.com/Knarf24/shopaccess-ai/pull/2) as `e6bb69dbac7127786425c299667a45a3930a833b`; it is included in inspected main `e6bb69dbac7127786425c299667a45a3930a833b`. Statements below describing the implementation as uncommitted or awaiting its original commit/PR are dated historical records, superseded for publication status by this note.

Merge status does not close the recorded acceptance limits. See the [current progress report](progress-report-2026-10-17.md) for published versus reported-local work. No application source or historical evidence is changed by this reconciliation.


Prepared October 16, 2026 (America/New_York) by Claude. Planned against `08e6e6a04f20221e19eea95f17d56e2c1c40fda2` (M2-1).

**Status update (October 16):**
- PR #1 was merged into `main` as `b86a41be7797e5f12a3aae3aff3902abda78134d`; the merge tree is identical to `08e6e6a`. No CI is configured in the repository, so no GitHub check results exist; the recorded local gate (1,253 tests) is the test evidence.
- E1 `274866d` was pushed to its experimental branch only.
- M2-2 is implemented on `feature/m2-2-extension-integration` from `b86a41b`.
- **Review target: October 19, 2026** (America/New_York). The full-project target remains October 24.

**Implementation status (October 16, 17:27–17:58Z, about 31 agent minutes, uncommitted):** slices 1–6 done against `b86a41b`.
- Source and unit evidence: suite 47 files, 1,297 tests pass; typecheck 0; lint 0 errors, 9 warnings (baseline). No-TCP recipe, database-free.
- Added beyond §3: logging out of demo admission now also marks the session's grants revoked in the same durable decision (before, they were refused by session liveness only). The panel has no install-time host permission (`optional_host_permissions`, requested for the one saved origin); requests work by CORS without it.
- **Browser check (October 16, 18:44–19:59Z, owner-assisted, mock only on 127.0.0.1):** every item in the §5 browser list was observed: pairing from the installed panel, shared history both ways, re-pair replacement, per-grant revoke then `TOKEN_INVALID`, grant and conversation surviving a server restart, and keyboard use of the approval page, Paired access and the panel. No screen-reader result is claimed.
- **Defects the browser check found, all fixed with tests (suite 48 files, 1,300 tests):**
  - **B1, an M2-1 defect found during M2-2 browser testing, not caused by M2-2:** conversation and confirmation-withdrawal state lived in module-level WeakMaps in `conversation.ts`. Under the dev server, the module can be loaded once per route bundle, so the code that builds the saved state (in the runtime, created by whichever route ran first) and the route that records a conversation line could use different module copies. The first website message could therefore fail to enter the saved state at all. In the browser check the runtime was first created by `GET /` before `/shop/needs/submit` ran, and the saved file held the draft but no conversation. Completing pairing did not erase an already-saved conversation: grant decisions build on the already-saved state. The same split applied to the confirmation-withdrawal state that blocks a checkout after a supported change (from the code path; not reproduced in a browser). Whether a production build splits modules the same way was not checked. Fix: this state now lives on the shared store object under global symbols, as needs drafts already did, which covers both conversation and confirmation-withdrawal persistence. Regression test: `tests/unit/conversation-module-copies.test.ts`.
  - **B2:** the panel received assistant lines as notice keys (`review`); it now gets the website's localized text.
  - **B3:** focus went to Send instead of the message box after sending.
  - **B4:** a refused token left the old conversation visible in the panel; it is now cleared.
  - **B5:** after a revoke, focus was not visible; the revocation result is now the "Skip to the current step" target, as for other results.
- Also noted: a pre-existing website test (`needs-conversation`, "750" assertion) can fail when a random draft ID contains "750". Not changed in M2-2.
- **Source review and correction round (October 16):** an independent review of the full diff passed with notes. Corrected before commit: the B1 record above; panel messages now share the website's 20-per-minute message limit (same limiter, policy and session); a reused `clientRequestId` with a different message is refused (`REQUEST_ID_CONFLICT`); after a refused send, focus moves to an enabled recovery control; the approval page opens in the draft's language; B3/B4 are covered by behavioural panel tests; a misplaced comment and the stale wording below.
- **Accepted carry-forward (required before any non-local use):** the approval page shows nothing the shopper can match against their own panel. A non-browser client can claim an allowed extension `Origin`, start a pairing and send the approval link; if the shopper approves, that client gets conversation read and write (never purchase). Before any non-local use, add a short matching code (or equivalent) shown in both the panel and the approval page. Not implemented in M2-2.
- **For the PR description:** label B1 as an M2-1 defect fixed while implementing and testing M2-2.
- **Revised estimate:** owner review of the corrected diff, then commit and PR. The October 19 review target holds.

## 1. Starting point

**In the application at `08e6e6a`:**
- **Sessions and state:** sessions, needs drafts, the guided conversation, confirmation invalidation, and the allocation and admission windows live in the save-first snapshot gate (`src/lib/session/durable.ts`, `snapshot-state.ts`). The gate is opened only through `openRuntime` (`src/server/runtime-access.ts`).
- **Admission:** demonstration admission is a separate signed cookie (`__Host-shopaccess_demo_admission`, 8 hours, `ADMISSION_LIFETIME_MS`) checked by `admissionRefusal` and `protectedAdmissionLocation`. It is not stored in the session.
- **Request guard:** `checkRequestProvenance` (`src/lib/session/request-guard.ts`) accepts a mutation only from a trusted website origin with `Sec-Fetch-Site: same-origin`, plus a session-bound CSRF token. **An extension request can never pass it**, by design.
- **Conversation language:** fixed per draft (`conversation.ts`: "This increment does not switch it").

**In E1** (`experiments/e1-shared-session/`, branch `design/shared-session-e1-20261016`):
- **Commits:** `f1a2fe1` and `274866d`, both pushed to the experimental branch only (never merged into `main`).
- **Prototype pieces to port:**
  - a synthetic pairing authority (`authority.mjs`): start, approve, poll status, exchange with a verifier, scoped bearer, revoke;
  - an MV3 side panel;
  - the reviewed missing-`Origin` read rule;
  - announcement helpers;
  - focus restoration.
- **Not integrated:** it uses its own server, cookie and JSON store, with no admission.

## 2. Scope

1. **Pairing with admitted application sessions.** A shopper pairs the extension from the website, and the extension receives a revocable, conversation-scoped grant tied to that session.
2. **Shared persistent conversation.** The website and the side panel read and continue the same draft and conversation. With snapshot persistence on, grants and conversation survive a restart; tokens survive only if persisted (decision D-M22-2).
3. **Grant replacement and revocation.** A defined rule for re-pairing, plus per-grant and whole-session revocation.
4. **Missing-`Origin` read policy.** The E1 rule adopted, scoped to the application's extension API only.

Out of scope:
- spending or store grants (F07 / M2-3);
- extension store-site interaction (F06);
- voice;
- live AI, Channel3 or payments;
- PostgreSQL mode, where extension routes return `mockRouteNotFound`;
- deployment.

## 3. Design

### 3.1 Extension API (new routes, `src/app/api/extension/v1/…`)

The API is separate from the website guard, and all its responses are `no-store`.

| Route | Method | Origin rule | Authentication |
| --- | --- | --- | --- |
| `pairings` | POST | Extension origin allowlist | None: public start, rate-limited (30/min/process), challenge = SHA-256(verifier) |
| `pairings/{id}/status` | POST | Allowlist | Exchange secret; at most 10 polls, at least 2 s apart |
| `pairings/{id}/exchange` | POST | Allowlist | Exchange secret + verifier; single use |
| `conversation` | GET | Allowlist, **or** the §3.4 originless rule | Bearer with `conversation:read` |
| `conversation/turns` | POST | Allowlist only | Bearer with `conversation:write`; draft `version` + `clientRequestId`; the website's per-session message limit |

- **Allowlist:** a new setting, `SHOPACCESS_EXTENSION_ORIGINS`, listing exact `chrome-extension://<32 a–p>` origins. It is parsed in `runtime.ts`, which stays the only environment reader. If it is absent, extension routes return 404, and today's application is unchanged.
- **Cookies:** extension routes ignore cookies and never set them. A request carrying a website session cookie gets no website authority.
- **CORS:** `Access-Control-Allow-Origin` is sent only for an allowlisted `Origin`. Preflight allows `GET, POST`, `authorization, content-type`.
- **Admission:** extension routes are not behind the admission cookie. The grant itself carries the admission bound (§3.2).

### 3.2 Pairing with an admitted session (website side)

- **Approval page:** `/extension/pair?pairing=<id>` is an existing-style page.
  - It requires a live session and, when admission is on, a valid admission cookie.
  - Approve or Deny is a website mutation through the existing guard: trusted origin, same-origin fetch, CSRF.
  - The pairing ID in the address bar is public. Approval still needs the session, admission and CSRF.
- **Grant lifetime:** a grant expires at the earliest of:
  - 1 hour after the exchange;
  - the session's absolute expiry;
  - when admission is on, the admission cookie's expiry, recorded at approval.

  An idle session or a revoked session makes every grant it owns refuse immediately.
- **Limits:** at most 3 approved, unexchanged pairings per session. Pairings expire after 5 minutes and are memory-only, so a restart cancels pending pairings and the panel starts again.

### 3.3 Grants, replacement and revocation (persisted)

- **Snapshot format 3:**
  - adds `grants[]`: `{ grantId, sessionId, tokenDigest (HMAC), extensionOrigin, installationId, scopes, createdAt, expiresAt, revokedAt }`;
  - strict validation;
  - format-2 files are upgraded with an empty list.

  The raw token is never stored. The digest is an HMAC keyed with the session key (`SHOPACCESS_SESSION_KEY`), with its own label.
- **Replacement rule (proposed; decision D-M22-1):**
  - the extension creates a random `installationId` once, in `chrome.storage.local`, and sends it when pairing starts;
  - **exchanging a new pairing revokes any active grant with the same session, extension origin and installation ID, in the same durable decision.** The earlier grant cannot be used again after the exchange is durable;
  - different installations (devices or profiles) keep separate grants, at most **3 active grants per session**. A fourth is refused (`GRANT_LIMIT`) until one is revoked.
- **Revocation paths, each durable before it is reported:**
  - per grant from the website's "Paired access" list, which names the installation label and creation time and uses E1's pairing-specific announcement;
  - all of a session's grants when the session is revoked (logout) or reclaimed;
  - "Forget" in the panel clears local credentials only, and says so.
- **Not persisted:** pairings in progress (memory, 5 minutes). Grants survive a restart (D-M22-2).

### 3.4 Missing-`Origin` read policy

Adopted from E1 (independently source-reviewed at `f1a2fe1`). It applies **only** to the application's extension conversation read.
- Chrome 155 sends no `Origin` on an extension page's GET to a host the extension holds permission for (E1 header capture).
- **An absent `Origin` is accepted only when all of these hold:**
  - the method is `GET`;
  - the path is exactly `/api/extension/v1/conversation`;
  - `Sec-Fetch-Site` is exactly `none`;
  - there is a valid, unexpired, unrevoked bearer with `conversation:read` whose session is live.

  `Sec-Fetch-Site` is an extra restriction, not authentication.
- **Refused:**
  - any present `Origin` outside the allowlist, including `null`, an empty value and the website's own origin;
  - every originless mutation;
  - originless access to any other path;
  - an originless OPTIONS request.
- **CORS:** no `Access-Control-Allow-Origin` header on an originless response.
- **Known limit:** a non-browser client holding a stolen read token can read that conversation. It could do so anyway by forging `Origin`. Tokens are short-lived and revocable.

### 3.5 Shared conversation

- **Panel read:** shows the same draft-scoped conversation (eight lines), the draft notice, the confirmed values and the interface language.
- **Panel send** uses the same durable path as the website follow-up:
  - claim, then interpret, then commit, saving draft, invalidation and conversation line atomically;
  - provider input comes from the saved claim;
  - stale revision gives `STALE_DRAFT`;
  - the same `clientRequestId` is idempotent.

  The website and panel share one draft revision, so either surface sees the other's change after refresh. E1's reply announcement is ported to both.
- **Not in M2-2:** language switching from the panel. Language stays fixed per draft (F09 owns switching). The panel shows the draft's language.
- **Confirmation and purchase stay on the website.** The panel has no confirm, checkout or payment action, and its grant has no such scope.

### 3.6 Extension packaging

`extension/` at the repository root is a promoted copy of the E1 panel. The service origin is set by an extension option, restricted to the app's trusted origins:
- MV3 with `sidePanel` and `storage`;
- `host_permissions` limited to the configured app origin;
- no `externally_connectable`.

E1 stays as the historical prototype.

## 4. Affected files (proposed)

- **New:**
  - `src/lib/session/grants.ts`: pairing authority and grant decisions on the gate;
  - `src/server/extension-guard.ts`: allowlist, CORS, originless rule and bearer;
  - `src/app/api/extension/v1/**/route.ts` (5 routes);
  - `src/app/extension/pair/page.tsx`;
  - `extension/*`;
  - tests: `grants`, `extension-guard`, `extension-api`, `pairing-page` and a restart test.
- **Changed:**
  - `snapshot-store.ts` (format 3);
  - `snapshot-state.ts` and `durable.ts` (grants in state, revocation on session removal);
  - `runtime.ts` (allowlist parse);
  - `config.ts`;
  - `handlers.ts` (shared follow-up path extracted for bearer callers);
  - `demo-admission.ts` (logout revokes grants);
  - the paired-access UI on `/shop/needs`;
  - `demo-copy.ts` (EN/ES);
  - the README;
  - the boundary tests (extension routes may not import the store).

  About 25 files.

## 5. Acceptance checks

**Automated, database-free, no-TCP:**
1. **Pairing needs an admitted session:**
   - without admission (when admission is on), approval redirects to admission;
   - without a session, or with a bad CSRF token, approval is refused;
   - a denied pairing yields no token.
2. **Exchange:**
   - only with the right secret and verifier, and only once;
   - not after 5 minutes or after 10 polls;
   - a polling rate above the limit is refused.
3. **Token use:**
   - reads and writes only that session's conversation;
   - refused when expired, revoked, out of scope, when the session is idle, revoked or reclaimed, and after admission expiry.
4. **Replacement and limits:**
   - re-pairing the same installation revokes the old grant atomically; the old token is refused afterwards;
   - another installation keeps its own grant;
   - a 4th active grant is refused;
   - a failed save of the exchange publishes no grant and no token.
5. **Revocation:**
   - per-grant revocation, and logout or reclaim revocation, are durable before they are reported;
   - the panel's next request is refused with `TOKEN_INVALID`.
6. **Originless rule:** the full E1 matrix ported:
   - `sec-fetch-site` absent, `cross-site`, `same-site`, `same-origin` or `NONE` → 403;
   - wrong `Origin` values → 403;
   - originless mutations and other paths → 403;
   - revoked, expired and wrong-scope tokens → 401 or 403;
   - no CORS header on originless responses.
7. **Shared conversation:**
   - a panel turn appears on the website and a website turn in the panel;
   - stale revisions are refused on both surfaces;
   - a duplicate `clientRequestId` yields one turn;
   - invalidation from a panel follow-up persists;
   - the provider starts only after a durable claim.
8. **Restart (snapshot mode):**
   - grants and the conversation survive; a revoked grant stays revoked;
   - pending pairings are dropped;
   - format-2 files upgrade to format 3.
9. **Boundaries:**
   - extension routes ignore cookies;
   - the website guard is unchanged for website routes;
   - with the allowlist absent, extension routes return 404;
   - PostgreSQL mode is unchanged.
10. The full suite, typecheck and lint pass.

**Browser (mock only, 127.0.0.1, the owner loads and reloads the unpacked extension):**
- pair from the real side panel;
- shared history in both directions;
- re-pair replacement (the old grant disappears from Paired access);
- per-grant revoke, then the panel is refused;
- restart, then the grant and conversation survive;
- keyboard checks on the approval page, the Paired access list and the panel.

**Accessibility, carried from E1 and still open (not closed by M2-2):**
- VoiceOver speech of the pairing-specific revocation wording and of announcement cancellation is unverified (only the pre-review E1 code was heard).
- Panel-originated send, and hearing its reply, are untested under VoiceOver. The keystroke permission was blocked.
- Panel stale-edit recovery and simultaneous error/reply announcements are untested under VoiceOver.
- No usability session with an experienced screen-reader user.
- Error text is still raw codes in places (`STALE_REVISION`, `TOKEN_INVALID`).
- Unattended VoiceOver automation is unsafe on the owner's desktop. The contained setup in the E1 handoff (a disposable macOS VM, or a separate user, driven over SSH) is the proposed route.

## 6. Estimate

| Work | Agent hours |
| --- | --- |
| Format 3 + grants module + gate decisions + tests | 1.5–3 |
| Extension guard + 5 API routes + originless matrix + tests | 1.5–3 |
| Shared follow-up path for bearer callers + tests | 1–2 |
| Approval page, Paired access list, revocation UI, EN/ES, announcements, keyboard | 1.5–3 |
| Extension packaging (promote E1 panel, installation ID, options) | 1–2 |
| Restart + boundary tests, full verification, docs | 1–2 |
| **Total** | **7.5–15 agent hours** |

- **Owner time:** about 1–2 hours to load and reload the extension, open the panel, approve pairings, and do the browser keyboard checks. VoiceOver verification is excluded.
- **Confidence:** medium-low. The main risks are:
  - extracting the follow-up handler for bearer callers without changing website behaviour;
  - Chrome behaviour beyond the observed originless GET;
  - extension packaging details.
- **Calibration:** M2-1's estimate was 13.5–22 hours against roughly 3 agent hours of implementation, plus review cycles. Expect review and owner checks, not implementation, to set the calendar.
- **Calendar**, assuming one manually started session of about 2–3 agent hours per day and owner availability for the browser steps: ready for review about **October 18–19**. That is within October 24 for M2-2, but the full-scope forecast for October 24 remains a likely miss.

## 7. Decisions (owner, October 16, 2026)

The owner's instruction to "update the plan with the six decisions above" and implement M2-2 is recorded as approval of
each option exactly as proposed. Any of them can be revisited before review.

1. **D-M22-1, approved:** the same installation (session + extension origin + installation ID) is replaced atomically on exchange; different installations coexist; at most 3 active grants per session.
2. **D-M22-2, approved:** grants survive a restart. Only an HMAC digest of the token is persisted; pending pairings are memory-only.
3. **D-M22-3, approved:** a grant lasts 1 hour, also bounded by the session's absolute expiry and, when admission is on, the admission cookie's expiry.
4. **D-M22-4, approved:** the panel shows the draft's language and does not switch it until F09.
5. **D-M22-5, done:** E1 `274866d` was pushed to `design/shared-session-e1-20261016` (`f1a2fe1..274866d`) and not merged into `main`.
6. **Done:** PR #1 was merged first (`b86a41b`). M2-2 builds on merged `main`.

## 8. Recorded for voice (F10), not part of M2-2: optional "Hey ShopAccess" hands-free activation

**Owner request:**
- optional hands-free activation with the phrase "Hey ShopAccess";
- local wake-word detection;
- spoken conversation;
- a visible listening state;
- a stop command.

It is **not** implemented in M2-2.

**Requirements to carry into the voice work:**
- **Opt-in and off by default.** Explicit microphone permission; a persistent visible "Listening" state with an accessible status announcement; one-press and spoken "Stop" ("Para") that ends listening immediately.
- **Local wake-word detection:** audio is not sent anywhere before the wake word.
  - After the wake word, transcription may use the browser's speech recognition. Chrome's default recognition is server-based (documented in the M1 assessment), so the experiment must establish whether on-device recognition is available, and say plainly when audio leaves the device.
- **Spoken output** must not talk over the screen reader. Typed input remains the full alternative.
- **Voice can never confirm a purchase or approve payment by itself.** It may not act on a pairing or revocation without the usual explicit control.
- **English and Spanish phrases.** False-activation and missed-activation behaviour must be measured, not assumed.

**Separate feasibility experiment (proposed, not scheduled or authorized):**

| Question | How, briefly | Size |
| --- | --- | --- |
| Can a wake word run locally in the browser or side panel? | Evaluate an on-device keyword-spotting option (for example a WebAssembly model, or Chrome's on-device speech recognition if available) on synthetic audio; record licence, model size, CPU use and offline behaviour | 2–4 h |
| Accuracy in EN/ES | Scripted synthetic recordings: true and false activations, noise, accents available locally | 1–2 h |
| Side panel constraints | Microphone permission and lifetime in an MV3 side panel vs a tab; does listening survive the panel closing (it should not) | 1 h |
| Screen-reader coexistence | Listening-state announcements and spoken replies against VoiceOver, in the contained VM setup only | 1–2 h, owner-assisted |

**Dependencies and decisions:**
- the choice of library or model (licence);
- whether any server-side recognition is acceptable after the wake word;
- the contained accessibility test environment.

**Effect on M2-2:** none. It stays in F10.
