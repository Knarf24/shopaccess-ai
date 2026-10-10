# ShopAccess AI — Foundation Correction Report 003

> Correction (Re-Audit 005): this report overstates cleanup frequency. Where it
> says cleanup runs "on every request path" or "on any request", read: at the
> start of `GET /session/start` and the three mutating POST routes only, at most
> once a minute, and not on page renders. It also left a late-commit race open.
> Both are addressed in `docs/correction-report-004.md`.

Directive: Foundation Correction Directive 003, following Codex Re-Audit 004.
Date: 2026-10-08. Scope: AUD-011, AUD-012 and quote validation before intent
creation. AUD-002 and AUD-003 were not reopened. AUD-013 and AUD-014 were not
implemented.

Everything below is an in-memory, single-process, mock-only guarantee. It does
not demonstrate database-level concurrency safety or durability.

## 1. Findings corrected

| Finding | Status |
| --- | --- |
| AUD-011 concurrent session-capacity race | IMPLEMENTED, TESTED |
| AUD-012 orphaned checkout records | IMPLEMENTED, TESTED |
| Quote requests validated before intents are created | IMPLEMENTED, TESTED |

## 2. Files modified in this pass

New:

- `tests/unit/corrections-003.test.ts`
- `docs/correction-report-003.md`

Changed:

- `src/lib/session/store.ts`: `insertWithinCapacity` replaces `insert`; `deleteExpired` returns the reclaimed IDs
- `src/lib/session/service.ts`: atomic insert decides capacity; `onSessionsReclaimed` hook
- `src/lib/checkout/store.ts`: `deleteForSessions`, `hasIntent`; child writes dropped when the owning intent is gone
- `src/lib/checkout/service.ts`: `startCheckoutWithQuote`
- `src/lib/payment/operations.ts`: `deleteOrphans`, `providerRequestIds`
- `src/lib/payment/orchestrator.ts`: a checkout that disappears mid-step returns `INTENT_NOT_FOUND` instead of throwing
- `src/lib/providers/payment.ts`: `retainOnlyRequests`; call log capped at 1000 entries
- `src/lib/security/rate-limit.ts`: in-memory store drops counters for ended windows
- `src/lib/security/audit.ts`: in-memory log keeps the most recent 5000 events
- `src/lib/db/queries.ts`: capacity-insert and `RETURNING` statements (unexecuted)
- `src/server/runtime.ts`: cleanup wiring; `maintain()`
- `src/server/handlers.ts`: `maintain()` on every request path; checkout start uses `startCheckoutWithQuote`
- `tests/unit/environment.test.ts`: two call sites updated for the renamed store method and statement
- `docs/security-foundation.md`

## 3. Before and after

### AUD-011

Before: the service awaited a cleanup scan and a count, then generated a token,
then awaited the insert. Concurrent requests could all see free capacity.

After: `SessionStore.insertWithinCapacity(record, max)` checks the size and
inserts in one step with no `await` between them, and it is the only way a
session is stored. The service's earlier count is just an early exit. A request
that loses the race for the last slot gets `SESSION_CAPACITY_REACHED` and no
cookie.

- The process-wide budget is unchanged: 30 per minute, checked and incremented
  with no `await` in between, before any other work.
- A valid existing session is resolved first and never reaches allocation.
- No capacity is reserved ahead of the insert, so a failed creation holds
  nothing and there is no reservation to leak.

### AUD-012

Before: reclaiming a session removed only the session record.

After: `purgeExpired` passes the reclaimed session IDs to a runtime hook that:

1. deletes those sessions' intents, transition history, quotes, confirmation
   challenges and provider observations in one uninterrupted step;
2. removes every ledger operation whose intent no longer exists;
3. removes every mock-provider order and capture whose request ID is no longer
   in the ledger.

Steps 2 and 3 work by "owner no longer exists", so they are idempotent and
also collect anything written by a request that was still running when its
session was reclaimed. The store additionally drops a quote, challenge or
observation addressed to an intent that is gone, and the orchestrator returns
`INTENT_NOT_FOUND` in that case.

Cleanup now runs on every request path, at most once a minute, as well as on
the session-allocation path. The in-memory rate-limit counters and audit log
are bounded too. Carts have no in-memory representation, so there was nothing
to clean for them.

**This cleanup is for the local mock only.** It deletes unknown and pending
simulated outcomes along with everything else. Real payment records need a
separately designed durable retention policy.

### Quote validation before intent creation

Before: the route created a `DRAFT` intent and then tried to quote, so every
rejected request left an intent behind.

After: `startCheckoutWithQuote` builds and validates the quote in memory first
(structure, merchant ID formats, catalog membership, availability, quantity
limits, server pricing). Only a valid quote leads to an intent, its
`QUOTE_ISSUED` transition and the stored quote. The authorization checks still
run before any of this, and the route still reads only product, variant and
quantity from the form.

## 4. New regression tests

`tests/unit/corrections-003.test.ts`: 40 tests, all passing.

| Finding | Tests | Covers |
| --- | --- | --- |
| AUD-011 | 8 | `Promise.all` with one slot left, at full capacity, and from empty; store-level atomicity; budget under parallel load; reuse at full capacity; failed creation; parallel requests at the route |
| AUD-012 | 11 | Full cleanup including unknown and pending outcomes; revoked sessions; other sessions untouched and usable; repeated and simultaneous cleanup; a step racing reclamation; cleanup alongside live checkouts; 40 expired-session cycles; request-driven cleanup; throttling; rate-limit and audit bounds |
| Quote validation | 21 | 18 invalid or external requests at the service; valid request creates exactly one of each record; invalid requests at the route; authorization and server pricing unchanged |

The capacity tests use a store with artificially slow cleanup and count, so
concurrent callers really do interleave around the decision.

Mutation check: 16 of the new controls were disabled one at a time. 15 were
caught (two only after I added a request-driven cleanup test that the check
showed was missing). The remaining one inserted an `await` before the budget
check, which does not separate the check from its increment and so is not a
defect.

## 5. Validation results

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, no warnings |
| `npm test` | 10 files; 217 passed, 1 skipped, 0 failed |
| PostgreSQL integration (MIG-01, the 1 skipped test) | **NOT RUN**: no authorized local database |
| `npm run build`, browser or live-server check | **NOT RUN** in this pass |

No dependency was installed and no external network call was made.

## 6. Remaining limitations

- Atomic capacity holds only inside one process. The PostgreSQL statement
  written for it is not race-free and has never been executed.
- A live session can still accumulate checkouts for up to its 24-hour lifetime,
  limited only by the per-session rate limits.
- A flood of session-start requests can still deny new sessions to everyone
  until the window passes.
- A mock-provider record created by a request racing cleanup survives until the
  next cleanup run (at most about a minute under traffic).
- The in-memory audit log now drops its oldest entries beyond 5000.
- AUD-013 and AUD-014 remain open by design.

## 7. Git status

Branch `main`, HEAD `1273dcc`. Nothing staged, committed or pushed. Tracked
files modified: `README.md`, `package.json`, `src/app/layout.tsx`,
`src/app/page.tsx` (all from the first milestone). Everything else is
untracked, including `AGENTS.md`, which `next dev` generated.

## 8. Deviations and judgement calls

- `SessionStore.insert` was removed in favour of `insertWithinCapacity`, so no
  code path can bypass the capacity check.
- The in-memory audit log and rate-limit store were bounded. The directive
  names "related mock records"; capping the audit log changes it from keeping
  everything to keeping the latest 5000, which the owner may prefer to revert.
- `orchestrator.ts` was touched only so a checkout reclaimed mid-step returns
  an error instead of throwing. Capture-evidence logic is unchanged.
- The older `startCheckout` and `requestQuote` functions remain for re-quoting
  an existing intent; the route no longer uses them to start a checkout.

## 9. Evidence for Codex Re-Audit 005

| File | What to verify |
| --- | --- |
| `src/lib/session/store.ts` (`insertWithinCapacity`) | No `await` between the size check and the writes; no other insert path exists |
| `src/lib/session/service.ts` (`admitNewSession`, `mint`, `establish`) | Budget check and increment are contiguous; capacity is decided by the atomic insert; reuse bypasses allocation |
| `src/server/runtime.ts` (`onSessionsReclaimed`, `maintain`) | Order and completeness of cleanup; throttling |
| `src/lib/checkout/store.ts` (`deleteForSessions`, `ownerIsLive`) | Removal is by owning session only; late child writes are dropped |
| `src/lib/payment/operations.ts` (`deleteOrphans`), `src/lib/providers/payment.ts` (`retainOnlyRequests`) | Sweeps cannot remove records of live checkouts |
| `src/lib/checkout/service.ts` (`startCheckoutWithQuote`), `src/server/handlers.ts` (`handleCheckoutStart`) | Nothing is stored before validation succeeds; authorization precedes it |
| `tests/unit/corrections-003.test.ts` | That each test proves what its title claims |
