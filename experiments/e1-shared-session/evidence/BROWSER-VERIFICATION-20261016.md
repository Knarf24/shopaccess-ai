# E1 browser verification and fixes — October 16, 2026

Status: **core browser checks passed after fixes; E1 NOT accepted.** VoiceOver (screen reader) is pending, and this prototype is not production integration.

This is the published, sanitized summary. Detailed run records, the redacted header capture, server start and stop times, and checksums are in the owner's private evidence store (`e1-browser-verification-20261016-113922`, with `fix-run/` and `fix-run-2/`). They are not published. No credentials, cookies, CSRF values, bearer tokens, pairing URLs or runtime data directories are included here.

## Environment

| | |
| --- | --- |
| Base commit | `e0be4b26f75e69a746aa91d3abfabf948f48a15c` (the branch tip before these fixes) |
| Browser | Google Chrome 155.0.8059.80, macOS. Unpacked extension loaded and reloaded by the owner |
| Node | v24.21.0 (the application pin), PATH/HOME-only environment |
| Checkout | Separate worktree; `main` and the application untouched |
| Data | Synthetic messages only. No live AI, Channel3, retailer, payment, credential or deployment activity |

Who operated each surface:
- The website was driven by Claude through Claude-in-Chrome.
- The real side panel was operated by the owner. Panel results below are owner-observed.

## Run 1 at `e0be4b2`: pairing failed

- After the owner approved pairing, the website listed a grant, but the panel showed "Pairing stopped. Start again."
- Panel Refresh showed `ORIGIN_DENIED` (owner-observed).
- A one-click diagnostic listener, with credential values redacted at capture, showed the panel's `GET /api/extension/v1/conversation` arriving with **no `Origin` header** and no preflight. It carried `sec-fetch-site: none` and an `Authorization` header.
- The server refused every extension request without the extension `Origin`.
- Pairing POSTs carried `Origin` and succeeded; the first read after exchange failed.
- The Node tests had set `Origin` on every request, so they did not detect this.
- Two pairing attempts left two active grants. Re-pairing does not revoke an earlier grant.

Website-only checks in run 1:
- Shared website history, duplicate-submit protection, and two-tab stale recovery passed.
- Restart kept the website history and cleared grants.
- Focus fell to `<body>` after an error.

## Fixes (this commit)

- **Originless read, `server.mjs`:**
  - An absent `Origin` is accepted only for `GET /api/extension/v1/conversation`, with `sec-fetch-site` exactly `none`.
  - `sec-fetch-site` is an extra restriction, not authentication. The unchanged bearer check still requires a valid, unexpired, unrevoked token with `conversation:read`.
  - A wrong `Origin` is refused.
  - Every POST and PATCH still requires the extension `Origin`.
  - `Access-Control-Allow-Origin` is sent only when `Origin` matched.
- **Test-only injection:** `makeAuthority({childScopes})` and `startServer({authorityOptions})`. Defaults are unchanged, and the command line passes neither.
- **Panel message:** a completed pairing followed by a failed conversation read now says "Paired, but the conversation could not be loaded (CODE). Select Refresh conversation; do not pair again."
- **Focus, `client.mjs` `restoreFocus`, used by the panel and the website:**
  - After a request, focus that fell to `<body>` returns to the control the user was on.
  - If that control was removed (a revoked grant's button), focus goes to the next Revoke button, then to the focusable "Paired access" heading, which has an explicit `:focus` outline.
- **Skip link:** on both surfaces it now targets the focusable Conversation heading (`#heading`) instead of `<main>`, which wraps every control.
- **Repeated pairing grants:** recorded, not changed. Automatic revocation is deferred until the server can establish which grant a new pairing replaces.

## Automated checks

| Check | Result | File |
| --- | --- | --- |
| New origin tests, fixed code | pass, part of the 52 | `browser-fix-suite-green.txt` |
| Origin tests against the unfixed server and authority | 6 fail, 3 pass (the 3 cover protections that already held) | `browser-fix-origin-red.txt` |
| Revoke-focus tests against the previous fix | 2 new tests fail | `browser-fix-focus-red.txt` |
| Skip-link test against the original markup | fails (the revoke-wiring test also fails there, because the same file was reverted) | `browser-fix-skiplink-red.txt` |
| Complete prototype suite, final source | **52/52 pass**, exit 0 | `browser-fix-suite-green.txt` |
| `node --check` on the changed scripts | exit 0 | — |

The new tests cover:
- an originless read with a valid read token;
- missing or malformed bearer → 401;
- `sec-fetch-site` absent, `cross-site`, `same-site`, `same-origin` or `NONE` → 403;
- wrong `Origin` (`null`, empty, a hostile site, the website's own origin, another extension) → 403;
- originless turns, language, pairing start, status, exchange, the turns GET, a trailing slash and OPTIONS → 403, with the state unchanged;
- revoked → 401;
- expired → 401;
- missing `conversation:read` → 403 `SCOPE_DENIED`;
- `restoreFocus`, including the removed-control fallback;
- the website revoke-fallback wiring;
- the skip-link target on both surfaces.

## Browser results after the fixes

| # | Check | Result |
| --- | --- | --- |
| 2 | Pairing | PASS (owner): "Paired. Conversation access only." with the website history; the website listed exactly one grant |
| 3 | Shared history | PASS: panel P1 appeared on the website; website W2 appeared in the panel; P2 was saved once |
| 4 | EN/ES | PASS for the prototype scope (details below) |
| 5a | Duplicate submit | PASS: a double-clicked Send saved P4 once (panel and website) |
| 5b | Stale edit | PASS (details below) |
| 6 | Revocation | PASS: after the website revoked the grant, panel Refresh and Send showed `TOKEN_INVALID`; P5 was not saved and stayed in Message |
| 7 | Restart and re-pair | PASS: a SIGINT stop and restart on the same data kept the website session, history and language and cleared grants; re-pairing restored the panel history |
| 8 | Keyboard | PASS for the observed items (details below) |
| — | Screen reader | **NOT PERFORMED.** Pending |

Check 4, English/Spanish:
- Panel labels switched to Spanish (Conversación, Tú, Asistente, Mensaje).
- P3 received a Spanish mock reply.
- The trimming notice was shown, and the website reflected `es`.
- Switching back to English was reflected in the panel after Refresh.

This is not translation or Spanish-intent acceptance.

Check 5b, stale edit:
- Panel: `STALE_REVISION` was shown (the owner recorded the code, not the full sentence) and focus stayed on Send. W5 was loaded and P6 kept; the resend saved P6 once and focus returned to Message.
- Website: the same, observed by Claude with a visible focus outline on Send.

Check 8, keyboard:
- Panel tab order (owner): Skip to conversation, Pair, Refresh, Forget, Interface language, Message, Send, each with a visible outline.
- A keyboard send works on both surfaces.
- Skip link, after the fix: Enter focuses the Conversation heading with a visible outline, and Tab then reaches Message. The panel was owner-confirmed with Tab, not Shift+Tab; the website was observed by Claude.
- Website revoke focus: focus moves to the next Revoke button, or to the "Paired access" heading when none remain, with a visible outline.

## Remaining acceptance gaps

1. **VoiceOver:** owner session on the panel and website covering status and alert announcements, the stale error, revocation and the skip link.
2. The panel's stale error was recorded as its code only; the full sentence was not recorded.
3. Re-pairing leaves earlier grants active; a replacement rule is undecided.
4. Errors show raw codes rather than shopper guidance.
5. Not in E1 scope:
   - real ShopAccess session integration and demo admission;
   - device profiles, store permissions, AI, voice, discovery and purchasing;
   - Node 24.19.0 versus the 24.21.0 pin difference with the original implementer.
6. These fixes are committed locally on the E1 branch and **not pushed**. They have not been independently reviewed.

## Source checksums after the fixes

See `BROWSER-VERIFICATION-20261016-SHA256SUMS`. The original `SHA256SUMS` remains the record of `e0be4b2` and is intentionally unchanged.
