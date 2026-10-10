# ShopAccess AI — Foundation Implementation Report 001

> Superseded in part by `docs/correction-report-002.md`, which corrects the
> capture-evidence, session-allocation and confirmation-challenge limitations
> listed below. This report is kept as written for the audit trail.

Directive: Claude Code Implementation Directive 001. Specification: Security
Foundation Specification v1.1. Date: 2026-10-08.

Status words: IMPLEMENTED (code exists), TESTED (automated test passes), NOT
TESTED, DEFERRED, BLOCKED.

## 1. Summary

The mock-only foundation and a working local demonstration are in place:
requirements and budget, deterministic readiness assessments, a server-priced
immutable quote, explicit single-use confirmation, and a simulated payment
lifecycle with unknown, pending, declined and refund-observed outcomes. All
state is in process memory and every provider is a local mock.

**BLOCKED / not available:** "Codex Security Architecture Review 002" and the
"accepted H1 risk decision" named in the directive were not supplied. The work
follows Specification v1.1 as written; whether every Review 002 correction is
applied could not be checked, and no decision named H1 was touched knowingly.

## 2. Files changed

Starting point: branch `main` at `1273dcc`, clean working tree. Nothing deleted.

Modified: `package.json` (scripts `typecheck`, `test`), `README.md`,
`src/app/layout.tsx`, `src/app/page.tsx`.

Added:

- `vitest.config.mts`
- `src/lib/shared/`: `result.ts`, `clock.ts`, `crypto.ts`, `canonical-json.ts`, `ids.ts`
- `src/lib/session/`: `token.ts`, `cookie.ts`, `store.ts`, `service.ts`, `request-guard.ts`
- `src/lib/catalog/`: `schemas.ts`, `url.ts`, `merchant-catalog.ts`
- `src/lib/readiness/engine.ts`, `src/lib/quote/quote.ts`, `src/lib/confirmation/confirmation.ts`
- `src/lib/checkout/`: `store.ts`, `service.ts`
- `src/lib/payment/`: `state-machine.ts`, `operations.ts`, `orchestrator.ts`, `adapter-config.ts`
- `src/lib/providers/`: `ai.ts`, `discovery.ts`, `payment.ts`
- `src/lib/security/`: `audit.ts`, `errors.ts`, `limits.ts`, `rate-limit.ts`
- `src/lib/db/queries.ts`
- `src/server/`: `config.ts`, `runtime.ts`, `handlers.ts`, `respond.ts`, `shopping.ts`, `simulation.ts`, `views.ts`
- `src/app/session/start/route.ts`, `src/app/checkout/start/route.ts`,
  `src/app/checkout/[intentId]/confirm/route.ts`, `src/app/checkout/[intentId]/simulate/route.ts`
- `src/app/shop/page.tsx`, `src/app/checkout/[intentId]/page.tsx`
- `src/components/`: `PreferencesForm`, `MerchantProductCard`, `ExternalProductCard`,
  `ReadinessPanel`, `ConfirmationSummary`, `SimulatedPaymentPanel`, `ConfigNotice`
- `db/migrations/0001` to `0006`
- `public/catalog/`: four local SVG illustrations
- `tests/unit/`: eight test files and `helpers.ts`
- `docs/security-foundation.md`, `docs/implementation-report.md`
- `AGENTS.md`: **not written by me.** `next dev` generates it automatically and re-creates it if removed.

## 3. Architecture mapping

| Spec | Component | Status |
| --- | --- | --- |
| §4 sessions, CSRF, origin, Fetch Metadata | `src/lib/session/*`, `src/server/handlers.ts` (`guardMutation`) | IMPLEMENTED, TESTED (in-memory store) |
| §4 rotation, revocation | `session/service.ts` | IMPLEMENTED, TESTED; no route uses them |
| §5–6 catalogs, validation, URL safety | `src/lib/catalog/*`, `providers/discovery.ts`, `ExternalProductCard` | IMPLEMENTED, TESTED |
| §7 readiness | `readiness/engine.ts`, `providers/ai.ts`, `ReadinessPanel` | IMPLEMENTED, TESTED |
| §8 quotes | `quote/quote.ts`, `checkout/service.ts` | IMPLEMENTED, TESTED |
| §9 confirmation | `confirmation/confirmation.ts`, `ConfirmationSummary` | IMPLEMENTED, TESTED |
| §10 payment states | `payment/state-machine.ts` | IMPLEMENTED, TESTED |
| §11 PostgreSQL model | `db/migrations/*`, `db/queries.ts` | IMPLEMENTED, **NOT TESTED against a database** |
| §12 mock providers | `src/lib/providers/*` | IMPLEMENTED, TESTED |
| §13 ledger and recovery | `payment/operations.ts`, `payment/orchestrator.ts` | IMPLEMENTED, TESTED (in-memory ledger) |
| §14 audit, errors, limits, rate limit | `src/lib/security/*` | IMPLEMENTED, TESTED; rate-limit store single-process |
| §14 CSP and headers, retention, backups | none | DEFERRED |
| Directive Phase D demo flow | `src/server/*`, `src/app/*` | IMPLEMENTED, TESTED at handler level; one manual browser pass |

## 4. Test evidence

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, no warnings |
| `npm test` | 8 files; 118 passed, 1 skipped, 0 failed |
| `npm run build` | Pass |
| PostgreSQL tests (MIG-01, DB-level concurrency) | **NOT RUN**: no local test database is configured |
| Playwright | **NOT RUN**: no Playwright tests were written |

- All 28 specification IDs except MIG-01 have passing tests; the ID is in each test title.
- MIG-01 is skipped unless `SHOPACCESS_TEST_DATABASE_URL` points at a local
  database. The migrations have never been applied and the MIG-01 test body has
  never run. Migration constraints were reviewed structurally only (static text checks).
- Mutation spot check: seven controls were broken one at a time and the suite
  failed each time. Each change was reverted.
- Live check (`next dev`, loopback, ephemeral key): the full flow was driven with
  `curl`, and once by hand in Chrome through quote, confirmation and the first
  simulation step. A cross-site POST returned 403.
- During the Chrome check the shop page once re-requested itself continuously
  in dev mode after I had edited files between server runs. It did not
  reproduce after a clean restart, and I did not find the cause.

## 5. Security evidence

- **Session isolation.** Unknown cookies are never adopted (SES-01). Another
  session's intent, quote and confirmation are indistinguishable from missing
  ones at the repository, service and route levels (SES-02, `demo-flow` tests).
  Every mutating route rejects cross-origin, missing-origin, wrong-CSRF and
  sessionless requests with the same generic 403.
- **Quote authority.** The quote request schema is strict; the route reads only
  product, variant and quantity. Tampered quotes fail the schema or digest
  (QTE-01, QTE-02). Variant changes invalidate quotes at confirmation and at
  dispatch (CAT-02).
- **Readiness determinism.** Same input, same output; versioned rule set;
  missing, stale, future-dated and contradictory evidence handled conservatively
  (RDY-01, RDY-02). AI output cannot change the status and has no action channel
  (AI-01 to AI-03).
- **Operation identity.** One row per intent, type and sequence; retries reuse
  the operation and request ID; a resend needs a readback that found nothing
  (ORD-01, ORD-02, CAP-01, CAP-02, REC-01, REC-03).
- **Payment-state guards.** The invariant tests enumerate every state, event
  type and actor. `FAILED_TERMINAL` has one inbound transition; redirects only
  reach `APPROVAL_CHECK_PENDING`; paid states never return to unpaid.

These are in-memory guarantees. They do not show that concurrency is safe at
the database level, and they say nothing about real PayPal behaviour.

## 6. Known limitations

- No PostgreSQL implementation of the checkout repository or operation ledger;
  the in-memory `transaction()` has no rollback.
- The provider's capture amount is not re-compared with the quote at capture.
- `MANUAL_REVIEW` has no outbound transitions. Carts are schema only.
- Session rotation and revocation are not exposed by any route.
- Anonymous session creation is not rate limited; in-memory state grows until restart.
- Page-level "no session" and "not your checkout" responses are streamed with HTTP 200.
- Retention, reconciliation targets and rate-limit values are proposals only.
- Not verified in Safari, with a screen reader, or by an accessibility tool.

## 7. Scope compliance

- Packages: none installed, upgraded or removed; `package-lock.json` unchanged.
- Credentials: none added. The local session key was generated per run and never written to disk.
- External APIs: none called. `npm run build` downloads the Geist fonts from
  Google Fonts because the starter layout already used `next/font/google`.
- Databases: none connected. Deployments: none. Commits: none.
- `package.json` gained `test` and `typecheck` scripts. They are not install
  hooks, but the specification prohibits unapproved lifecycle scripts, so this needs the owner's approval.

## 8. Remaining risks for independent review

1. The file layout is my choice; the specification's "authorized files" list was not provided.
2. Review 002 and the H1 decision were not available (see section 1).
3. `GET /session/start` creates state on a GET and each checkout page view
   issues a new confirmation nonce.
4. The simulation route lets a shopper drive worker and provider behaviour for
   their own checkout. That is intended for the demo and must not survive into a real adapter.
5. The SQL and migrations are unexecuted.
6. Design decisions beyond the specification's wording are listed in `docs/security-foundation.md`.

## 9. Git status

Branch `main`, HEAD `1273dcc`. Uncommitted: 4 modified files and the added
files listed in section 2. Nothing staged, committed or pushed.

## 10. Codex handoff

| File | Property to verify independently |
| --- | --- |
| `src/lib/session/service.ts`, `token.ts`, `cookie.ts` | Token entropy, digest-only storage, expiry, fixation resistance, cookie attributes |
| `src/lib/session/request-guard.ts`, `src/server/config.ts` | Origin and Fetch Metadata logic; that the loopback-HTTP allowance cannot be enabled outside development |
| `src/server/handlers.ts` | Every mutation passes `guardMutation`; ownership checks; redirect targets are fixed; no secret reaches audit or responses |
| `src/lib/quote/quote.ts`, `src/lib/confirmation/confirmation.ts` | Server authority, digest binding, expiry, replay and concurrency handling |
| `src/lib/payment/state-machine.ts` | The transition table against the eight mandatory invariants |
| `src/lib/payment/operations.ts`, `orchestrator.ts` | Claim rules, lease handling, readback-before-resend, no provider call inside a transaction |
| `src/lib/providers/ai.ts`, `src/lib/readiness/engine.ts` | No path from AI output to commerce state; conservative evidence handling |
| `src/lib/catalog/url.ts`, `src/components/ExternalProductCard.tsx` | URL filtering and inert rendering |
| `db/migrations/*`, `src/lib/db/queries.ts` | Constraints, uniqueness, append-only triggers, parameterization; these have never run |
| `tests/unit/*` | Whether each test really proves what its title claims |
