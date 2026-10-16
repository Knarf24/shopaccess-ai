# E1 implementation result — October 16, 2026

Status: implemented isolated prototype, automated checks passed; E1 browser acceptance PARTIAL, not accepted as production integration.

Source: experiment directory only, based on approved design/plan in design/shared-session-e1-20261016 at 1b3deddb64158e3e9fea25b6aa47abd985e2f1a1. No src/, application dependencies, database, merchant assets or payment modules changed. No main merge.

## Validation

- Node v24.19.0, built-ins only. Application's pinned v24.21.0 not verified.
- Final unit/client/manifest group: 27 passed, exit 0.
- Final HTTP/review-regression group: 13 passed, exit 0. Real loopback sockets used.
- Complete prototype suite: 40 passed. Every final command, exit and environment-name list is in validation.json; corresponding stdout/stderr retained.
- Final groups started with only PATH inherited; no provider credentials or database settings passed. No no-TCP preload was used; this is not a claim of complete network isolation.
- Syntax checks of server.mjs, extension/panel.mjs and web/site.mjs exited 0.
- First missing-module and review regression failures retained. Final reviewer independently ran the original 31 tests and reproduced seven findings; fixes and nine regression cases followed.
- Full application Vitest, lint, typecheck and build were not run: this isolated prototype has no app dependencies installed and cannot validate the complete application tree.

## Review

One independent read-only whole-prototype review. Findings and resolution are in LEDGER.md. No critical finding reported. All seven identified protocol/behavior issues were fixed with new regression checks. No second independent review was run. Client helper tests do not establish mounted browser behavior.

## Browser limitation

The available cloud browser attempted http://127.0.0.1:3764 and returned ERR_CONNECTION_REFUSED. The loopback server was reachable by the integration tests in the execution environment, but not by that browser. No unpacked extension was installed, no screenshot shows a working panel, and no keyboard/VoiceOver or browser pending/focus acceptance is claimed. README contains local install and acceptance steps.

## Cleanup

The owned manual prototype server was interrupted and exited 130. A process lookup found no remaining matching prototype server; a socket bind verified port 3764 was free. Tests close their own listeners and remove their own temporary directories. The synthetic manual-run directory remained private outside the repository; no signing key, cookie, bearer or profile data is included in this record.

## Remaining acceptance

Actual Chrome pairing and cross-surface use, language UI behavior, pending/focus, revocation from the panel, restart/re-pair and screen-reader checks remain open. Real ShopAccess session integration, expanded AI, profiles, voice and shopping are separate later work. Eight-line history and English fixture-token extraction are intentionally visible limitations.
