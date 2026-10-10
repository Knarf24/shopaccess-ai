# ShopAccess AI — Foundation Correction Report 004

Directive: Foundation Correction Directive 004, following Codex Re-Audit 005.
Date: 2026-10-08. Scope: AUD-012, late checkout-intent insertion after session
reclamation, plus the documentation correction on cleanup frequency. No other
finding was reopened. AUD-013 and AUD-014 were not implemented.

Everything below is a single-process, in-memory, mock-only guarantee.

## 1. Root cause

`startCheckoutWithQuote` trusted the session authorization done at the start of
the request. Between that authorization and the insert there were several
`await` points (rate limiting, then three separate store calls: insert intent,
apply transition, insert quote). If the session was revoked or expired and then
reclaimed during any of them, the request resumed and inserted an intent under
a session ID that no longer existed.

Cleanup removes checkout records by owning session ID, and it had already run
for that session, so the late intent and its quote were never found again. The
three separate writes also meant a partial checkout could be left behind.

## 2. Files changed in this pass

New:

- `tests/unit/corrections-004.test.ts`
- `docs/correction-report-004.md`

Changed:

- `src/lib/session/store.ts`: synchronous `isLive`
- `src/lib/checkout/store.ts`: `commitCheckoutStart` replaces `insertIntent`; types `CheckoutStartCommit`, `SessionLivenessCheck`
- `src/lib/checkout/service.ts`: `CheckoutDeps.sessionIsLive`; `startCheckoutWithQuote` and `startCheckout` commit through the new method
- `src/server/runtime.ts`: builds the liveness check from the session store and clock
- `src/server/handlers.ts`: `SESSION_NOT_ACTIVE` becomes the generic 403
- `tests/unit/helpers.ts`: test world supplies the liveness check
- `docs/security-foundation.md`, `docs/correction-report-003.md` (correction note only)

## 3. Atomic coordination design

There is no lock. The design relies on one fact about the single-process mock:
code with no `await` in it runs to completion before anything else can run.

**The commit.** `commitCheckoutStart(commit, sessionIsLive)` is the only way an
intent is created; `insertIntent` no longer exists. In order, with no `await`:

1. validate the inputs (duplicate IDs, quote belongs to this intent and session);
2. call `sessionIsLive(intent.sessionId)`;
3. if false, return false having written nothing;
4. otherwise write the intent, its transition history and its quote.

**The liveness decision.** `InMemorySessionStore.isLive` is a plain synchronous
function. It returns true only if the session is stored now, is not revoked,
and is inside both its idle and absolute lifetimes. A reclaimed session is
simply absent.

**Reclamation.** Removing expired sessions (`deleteExpired`) and removing a
session's checkout records (`deleteForSessions`) are each uninterrupted too.

**Why this closes the race.** Relative to the commit, session removal happens
either entirely before or entirely after:

| Order | Result |
| --- | --- |
| Session removed, then commit | Liveness check fails; nothing is written |
| Session removed, commit, then checkout cleanup | Same: the session is already absent at the commit |
| Commit, then session removed and checkout cleanup | Records exist under the session ID and are deleted by owner |
| Session expired or revoked but not yet removed, then commit | Liveness check fails on expiry or revocation |

There is no ordering in which the check passes and the session is gone before
the write, because nothing can run between them.

**Other requirements.**

- Quote validation and pricing still happen first, in memory. The intent,
  transition and quote are all prepared before the commit, so the commit is
  all-or-nothing and there are no partial writes.
- No lock means no deadlock. The liveness check only reads, so cleanup cannot
  be re-entered through it.
- The intent's own `sessionId` is what gets checked, so one session's liveness
  cannot be used for another's records.
- Session capacity and the allocation budget were not touched.
- A stale request gets the same generic 403 body as an unauthenticated one,
  with no hint of the reason.

This is not a database transaction. A PostgreSQL implementation would need its
own mechanism, which is out of scope here.

## 4. Deterministic concurrency-test evidence

`tests/unit/corrections-004.test.ts`: 17 tests, all passing. No sleeps are
used. A wrapper around the checkout store stops each commit at an explicit
barrier placed immediately before the real atomic commit, signals that it has
been reached, and waits to be released. By then the request has already passed
authorization, rate limiting and quote validation.

| Test | Sequence forced |
| --- | --- |
| The audited interleaving (route) | Authorize; hold before commit; revoke; reclaim to completion; release. Result: 403, zero records of every kind, also after another cleanup; no `QUOTE_ISSUED` audit entry |
| Same, by idle timeout (service) | Hold; advance clock; reclaim; release. Rejected, nothing stored |
| Expires immediately before commit (idle and absolute) | Hold; advance clock; no reclamation; release. Rejected, nothing stored |
| Revoked immediately before commit | Hold; revoke; no reclamation; release. 403, nothing stored |
| Commit just inside the lifetime | Hold; advance 14 minutes; release. Succeeds |
| Commit before reclamation | Hold; release; then revoke and reclaim. Records created, then all removed |
| Two requests and one reclamation | Request 1 commits; reclaim; request 2 released. 303 then 403; nothing left |
| Two requests released with reclamation in flight | Both rejected; nothing left |
| Another shopper | Stale request rejected; the other shopper's existing records byte-identical and their new checkout succeeds |
| Store commit | All-or-nothing; liveness asked once about the intent's own session; no other intent-insertion method exists |
| Source check | No `await` in the commit, in either removal step, or in `isLive`; the liveness call precedes the first write |
| DRAFT helper | `startCheckout` obeys the same rule |
| Invalid quotes | Never reach the commit; nothing stored |
| Authorization | An unauthorized request never reaches the commit |
| Session capacity and budget | 60 parallel requests yield exactly 30 sessions |
| Normal flow | Confirmation replay rejected; mismatched capture evidence goes to `MANUAL_REVIEW` |

Mutation check: six controls were disabled one at a time and all were caught.
Inserting an `await` between the liveness check and the write is caught only by
the source check, not by a behavioural test: in these tests nothing happens to
be scheduled in that one-tick gap.

## 5. Validation results

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, no warnings |
| `npm test` | 11 files; 234 passed, 1 skipped, 0 failed |
| PostgreSQL integration (MIG-01, the 1 skipped test) | **NOT RUN**: no authorized local database |
| `npm run build`, browser or live-server check | **NOT RUN** in this pass |

No dependency was installed and no network call was made.

## 6. Regression assessment

- All 217 previously passing tests still pass unchanged, including the
  AUD-002, AUD-003, AUD-011 and quote-validation suites.
- No existing test was edited. Only the shared test world gained the liveness check.
- `orchestrator.ts`, `capture-evidence.ts`, `confirmation.ts` and the session
  service were not modified.
- Behaviour change visible to callers: checkout start can now return 403 for a
  session that died mid-request, where it previously returned a redirect.

## 7. Remaining limitations

- The guarantee depends on single-threaded execution in one process. It does
  not apply to PostgreSQL or to more than one server instance.
- Only checkout START is guarded by the atomic liveness commit. A payment step
  already running when its session is reclaimed can still write a ledger
  operation or a mock-provider record afterwards; the next cleanup run removes it.
- Cleanup has no timer. It runs at the start of `GET /session/start` and the
  three mutating POST routes, at most once a minute, and on new-session
  allocation. It does not run on page renders. With no such requests, expired
  data stays in memory, unreachable, until one arrives or the process restarts.
- A session that is expired but not yet reclaimed can still have records added
  under its existing intents by a request already in flight; they are removed
  with the session.
- Production retention is not implemented.

## 8. Git status

Branch `main`, HEAD `1273dcc`. Nothing staged, committed or pushed. No
unexpected changes at the start of this pass. Tracked files modified:
`README.md`, `package.json`, `src/app/layout.tsx`, `src/app/page.tsx` (all from
the first milestone). Everything else is untracked, including `AGENTS.md`,
which `next dev` generated.

## 9. Evidence for Codex Re-Audit 006

| File | What to verify |
| --- | --- |
| `src/lib/checkout/store.ts` (`commitCheckoutStart`) | No `await`; liveness call before the first write; validation before any write; no other way to create an intent |
| `src/lib/session/store.ts` (`isLive`, `deleteExpired`) | `isLive` is synchronous and covers absent, revoked, idle-expired and absolute-expired; `deleteExpired` is uninterrupted |
| `src/lib/checkout/store.ts` (`deleteForSessions`) | Uninterrupted; removes by owning session |
| `src/lib/checkout/service.ts` (`startCheckoutWithQuote`, `startCheckout`) | Everything is prepared before the single commit; the result of the commit is honoured |
| `src/server/runtime.ts` | The liveness check reads the same session store that reclamation deletes from, with the same clock and idle timeout |
| `src/server/handlers.ts` (`handleCheckoutStart`) | Stale requests get the generic 403; no audit entry is written for them |
| `tests/unit/corrections-004.test.ts` | The barrier really sits immediately before the real commit; each test proves what its title claims |
| `docs/security-foundation.md` ("Mock cleanup: when it actually runs") | The stated triggers match the two `maintain()` call sites and `admitNewSession` |
