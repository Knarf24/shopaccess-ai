# ShopAccess AI — Foundation Correction Report 002

Directive: Foundation Correction Directive 002. Date: 2026-10-08.
Scope: the three blockers from Independent Foundation Security Audit 003, as
summarised in the directive. The audit document itself was not supplied.

Everything below is an in-memory, mock-only guarantee. It does not resolve any
future PostgreSQL or deployment blocker.

## 1. Findings corrected

| Finding | Priority | Status |
| --- | --- | --- |
| AUD-003 capture evidence verification | High | IMPLEMENTED, TESTED |
| AUD-001 session allocation and cleanup | Medium | IMPLEMENTED, TESTED |
| AUD-002 confirmation challenge lifecycle | Medium | IMPLEMENTED, TESTED |

## 2. Files modified in this pass

New:

- `src/lib/payment/capture-evidence.ts`
- `tests/unit/corrections.test.ts`
- `docs/correction-report-002.md`

Changed:

- `src/lib/payment/orchestrator.ts`: `settleCaptureEvidence` replaces the old capture settlement; audit dependency; aftermath validation
- `src/lib/payment/state-machine.ts`: event `CAPTURE_EVIDENCE_MISMATCH`
- `src/lib/payment/operations.ts`: operation state `CONFLICT`
- `src/lib/providers/payment.ts`: captures carry `currency` and `merchantId`; mock can report corrupted evidence
- `src/lib/checkout/store.ts`: observation conflict fields; one confirmation record per quote
- `src/lib/confirmation/confirmation.ts`: replacement issuance; `CONFIRMATION_SUPERSEDED`
- `src/lib/session/store.ts`, `src/lib/session/service.ts`: allocation policy, cleanup, digest index
- `src/lib/db/queries.ts`: session cleanup and count statements (unexecuted)
- `src/lib/security/errors.ts`: public code `UNAVAILABLE` (503)
- `src/server/handlers.ts`, `src/server/runtime.ts`, `src/server/views.ts`
- `db/migrations/0004_checkout_quotes_confirmations.sql`, `0005_payment_operations.sql` (unexecuted)
- `tests/unit/helpers.ts`, `sessions.test.ts`, `state-machine.test.ts`, `quote-confirmation.test.ts`
- `docs/security-foundation.md`, `docs/implementation-report.md` (pointer note only)

## 3. Before and after

### AUD-003

Before: a capture the provider reported as `COMPLETED` moved the checkout to
`CAPTURED_VERIFIED` without comparing it with the quote or the recorded order.

After: `validateCaptureEvidence` is the single judge, called only from
`settleCaptureEvidence`, which handles both immediate responses and
reconciliation readbacks. It requires:

- every field present and well formed, with a recognised status;
- request ID equal to the operation's stable request ID;
- order ID equal to the checkout's recorded provider order;
- amount equal to the immutable quote total;
- currency and merchant equal to the quote's;
- capture ID unchanged if one was already recorded;
- refunded amount not above the captured amount.

On failure the checkout moves to `MANUAL_REVIEW` through the guarded
`CAPTURE_EVIDENCE_MISMATCH` transition (provider actors only, citing the
observation). The operation becomes `CONFLICT`, which no worker can claim, so
nothing is retried or resent. The conflicting observation is stored with the
reason and the reported status, amount and currency, and a sanitized
`CAPTURE_EVIDENCE_REJECTED` audit event is written. Mismatched evidence that
reports `PENDING` or `DECLINED` is rejected the same way. Settlement requires the
operation lease and happens once; repeated or concurrent attempts are no-ops.

### AUD-001

Before: every request without a valid cookie created a session, with no limit
and no cleanup.

After: creating a new session must pass, in order, a process-wide budget (30
per minute) checked on an in-memory counter, then cleanup of expired, idle and
revoked sessions, then a cap of 500 live sessions. Only then is a token
generated, hashed and stored. The route answers 429 or 503 with `Retry-After`
and sets no cookie. A valid existing session is reused without spending budget.
Fixation resistance and digest-only storage are unchanged.

No trustworthy client identity exists in the local runtime and forwarded-IP
headers are never read, so the limits are process-wide. **These are
single-process mock protections, not distributed rate limiting.**

### AUD-002

Before: each checkout page view inserted another unconsumed challenge.

After: the store holds exactly one challenge record per quote. Reusing an
existing challenge would require keeping the raw nonce, so each issuance
installs a replacement and atomically discards the previous one. A submission
from an older page gets `CONFIRMATION_SUPERSEDED`, shown as: "This summary was
opened again in another tab or refreshed, so the copy you submitted is out of
date. Nothing was confirmed. Review the summary below and confirm again."
Unused expired challenges are reclaimed at issuance. A consumed challenge is
kept and cannot be replaced, so replay is still rejected. Lookups are scoped by
session, so another session can neither submit nor replace a challenge.

## 4. New regression tests

`tests/unit/corrections.test.ts`: 59 tests, all passing.

| Finding | Tests | Covers |
| --- | --- | --- |
| AUD-003 | 42 | Correct capture; 17 kinds of wrong or missing evidence, each on immediate response and on reconciliation; pending capture later mismatched; changed capture ID; repeated and concurrent settlement; reducer reachability |
| AUD-001 | 9 | Repeated requests; capacity exhaustion; cleanup (explicit and on allocation); reuse; isolation and fixation; recovery after the interval; route behaviour with spoofed forwarded-IP headers |
| AUD-002 | 8 | Repeated views; two tabs (service and route); concurrent issuance; invalidation and binding; expiry cleanup; success; replay; cross-session |

Three existing tests were changed because they encoded the old behaviour: one
state-machine assertion (rejected evidence may now send a pending capture to
manual review), one confirmation assertion (an unknown quote ID now returns
`CONFIRMATION_NOT_FOUND`), and one session test for the new `establish` return type.

Mutation check: eleven of the new controls were disabled one at a time. Ten
were caught at once. One (cleanup on the allocation path) survived, which
exposed a missing test; that test was added and now catches it.

## 5. Validation results

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, no warnings |
| `npm test` | 9 files; 177 passed, 1 skipped, 0 failed |
| `npm run build` | **NOT RUN** in this pass, to avoid another Google Fonts download |
| PostgreSQL integration (MIG-01) | **NOT RUN** (the 1 skipped test): no authorized local database |
| Browser or live-server check | **NOT RUN** in this pass |

## 6. Remaining limitations

- A flood of session-start requests can deny new sessions to everyone until
  the window passes. Existing sessions keep working.
- Cleanup removes session records only. Intents, quotes and consumed
  confirmations of reclaimed sessions stay in memory until restart.
- The migration and SQL edits are unexecuted. One-challenge-per-quote and the
  `CONFLICT` state are enforced in memory only; nothing here shows database-level
  concurrency safety.
- `MANUAL_REVIEW` still has no outbound transitions.
- After a capture is verified, later evidence that no longer matches is
  recorded as a conflicting observation but does not change state.
- The changed pages were not rebuilt or re-checked in a browser.

## 7. Git status

Branch `main`, HEAD `1273dcc`. Nothing staged, committed or pushed. No
unexpected changes were present at the start of this pass. Tracked files
modified: `README.md`, `package.json`, `src/app/layout.tsx`, `src/app/page.tsx`
(all from the earlier milestone). Everything else is untracked, including
`AGENTS.md`, which `next dev` generated.

## 8. Deviations from the directive

- The production build was not run (permitted by the directive).
- Audit 003 itself and the H1 decision were not available; the directive's
  text was used as the scope and nothing identified as H1 was changed.
- Challenges are replaced, not reused, for the reason given in section 3.
- Two unexecuted migration files and the mock provider were edited so that the
  schema and the mock model match the corrected behaviour.
- The currency and merchant checks rely on fields added to the mock's capture
  model in this pass.

## 9. Evidence for Codex re-review

| File | What to verify |
| --- | --- |
| `src/lib/payment/capture-evidence.ts` | The checks are complete and nothing else judges capture evidence |
| `src/lib/payment/orchestrator.ts` (`settleCaptureEvidence`, `sendCapture`, `reconcileOperation`, `observeCaptureAftermath`) | Every path from provider capture data goes through the validator; settlement requires the lease; no retry after `CONFLICT` |
| `src/lib/payment/state-machine.ts` | `CAPTURE_EVIDENCE_MISMATCH` rules; `CAPTURED_VERIFIED` reachable only via `CAPTURE_COMPLETED` |
| `src/lib/payment/operations.ts` | `CONFLICT` cannot be claimed for dispatch or recovery |
| `src/lib/session/service.ts` (`admitNewSession`, `establish`), `src/lib/session/store.ts` | Order of checks; no caller-controlled input; cleanup correctness |
| `src/server/handlers.ts` (`handleSessionStart`) | No cookie on refusal; no forwarded-header use |
| `src/lib/checkout/store.ts`, `src/lib/confirmation/confirmation.ts` | One record per quote; atomic replacement; consumed record immutable; session scoping |
| `tests/unit/corrections.test.ts` | That each test proves what its title claims |
