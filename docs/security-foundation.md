# Security foundation: implementation notes

Companion to Security Foundation Specification v1.1. It records how the
mock-only foundation is built, and exactly which controls are active.

## Status of controls

Everything runs in one process's memory against local mocks. Nothing here is
backed by PostgreSQL, and nothing contacts an external service.

| Area | Status |
| --- | --- |
| Session cookie issue, lookup, idle and absolute expiry | Active on the demo routes (in-memory store) |
| Trusted-origin, Fetch Metadata and session-bound CSRF checks | Active on all three mutating routes |
| Session ownership of intents, quotes, confirmations | Active (in-memory repository) |
| Server-priced immutable quotes, explicit single-use confirmation | Active |
| Readiness engine and guarded mock AI explanations | Active on `/shop` |
| External listings shown separately, with no checkout action | Active on `/shop` |
| Simulated payment lifecycle (reducer, ledger, recovery) | Active on `/checkout/[intentId]`, mock provider only |
| Form body type and size limits, per-session rate limits | Active; rate-limit store is single-process |
| Sanitized audit events | Active, in memory only (lost on restart) |
| Session rotation and revocation | Library, tested; no route calls them |
| PostgreSQL migrations and queries | Written; **never executed** |
| CSP and security headers, retention job, shared rate-limit store | Not implemented (deferred by the specification) |

## Local development without weaker cookies

Cookie attributes are the same in every environment: `__Host-` prefix,
`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`. Nothing relaxes them.

The one local adaptation is in `src/server/config.ts`: when `NODE_ENV` is
exactly `development`, a plain-HTTP loopback origin (`http://localhost:PORT`
or `http://127.0.0.1:PORT`) may be listed as a trusted origin. In any other
environment such an origin is a configuration error. Chrome and Firefox accept
`Secure` cookies on `http://localhost`; Safari does not, and the shop page says
so instead of looping. `next dev --experimental-https` is not used because it
fetches a certificate tool, which this milestone does not permit.

Required settings (there are no defaults; the flow is switched off without them):

```bash
SHOPACCESS_SESSION_KEY="$(openssl rand -base64 32)" \
SHOPACCESS_TRUSTED_ORIGINS=http://localhost:3000 \
PAYMENT_PROVIDER_MODE=mock \
npm run dev
```

The key above is generated per run and never written to disk. `next start`
(production mode) rejects the loopback origin, so the demo needs an HTTPS
origin there.

## Design decisions worth reviewing

- **Two ID spaces.** Merchant IDs (`dmp_`, `dmv_`, `dmm_`) and external
  discovery IDs (`ext_`) cannot match each other's patterns, and checkout looks
  up the merchant catalog by exact ID only.
- **Readiness.** `FAIL` on a required factor gives `NOT_RECOMMENDED` even if
  another factor lacks evidence; otherwise any required gap gives
  `INSUFFICIENT_EVIDENCE`. Facts supported only by an external listing cap a
  factor at a caveat. Thresholds live in `USE_REQUIREMENTS` and are versioned
  with the engine.
- **Quote invalidation.** A quote is stale when the quoted variant's price,
  currency, availability, quantity limit or merchant has changed. A catalog
  revision bump that does not touch the quoted variant does not invalidate it.
- **Quotable versus ready.** A quote can be requested for any in-stock demo
  variant. The readiness label neither grants nor blocks it, and AI output
  plays no part.
- **Session start.** `GET /session/start` issues the cookie and redirects to a
  fixed local path. Creating a NEW session is subject to a process-wide budget
  (30 per minute) and a cap on live sessions (500). The capacity check and the
  insert are one atomic store operation, so concurrent requests cannot exceed
  the cap. See "Mock cleanup: when it actually runs" below for reclamation. Reusing a valid session costs
  nothing. Forwarded-IP headers are caller-controlled and are never consulted,
  so the limits cannot tell callers apart: a flood can deny NEW sessions to
  everyone until the window passes. These are single-process protections for
  the local mock, not distributed rate limiting, and the app must not be
  exposed publicly on the strength of them.
- **Confirmation challenge.** There is exactly one challenge record per quote.
  Only a digest of the nonce is stored, so an existing challenge cannot be
  shown again; each view of a checkout awaiting confirmation issues a
  replacement and atomically discards the previous one. A page rendered earlier
  (another tab, or before a refresh) is told to refresh when it submits.
  Challenges that expire unused are reclaimed; a consumed one is kept and can
  never be replaced.
- **Capture evidence.** `validateCaptureEvidence` in
  `src/lib/payment/capture-evidence.ts` is the only judge of capture evidence,
  for immediate responses and readbacks alike. Order, request ID, amount,
  currency, merchant and capture ID must match the authorized quote and
  recorded order, and every field must be present and well formed. Otherwise
  the checkout goes to `MANUAL_REVIEW`, the operation is marked `CONFLICT` (never
  retried), the conflicting observation is kept and an audit event is written.
- **Simulation controls.** The shopper's own buttons stand in for the future
  operation worker and for the provider's behaviour. They act only on a
  checkout the session owns and only on the in-memory mock.
- **Rotation.** Rotating a session invalidates the old token immediately and
  keeps the original absolute expiry. A request racing the rotation with the
  old token is rejected.
- **Cancellation.** Refused once a capture may have been dispatched, and also
  while an order-create outcome is unresolved.
- **Decline.** After a provider-confirmed decline, the next capture is a new
  logical operation (sequence 2) with a new request ID. Transport retries of
  one operation always reuse its request ID.
- **Unknown outcomes.** A lost response or a thrown provider error becomes
  `*_UNKNOWN`. A resend is only possible after a readback that found nothing,
  and the reducer requires the readback observation ID on the resend event.
- **Terminal failure.** `FAILED_TERMINAL` has exactly one inbound transition:
  an explicit provider rejection of order creation, received in response.

## Mock cleanup: when it actually runs

There is no timer or background job. Cleanup happens only as a side effect of
certain requests.

**Request-driven maintenance.** `runtime.maintain()` is called at the start of:

- `GET /session/start`
- `POST /checkout/start`
- `POST /checkout/[intentId]/confirm`
- `POST /checkout/[intentId]/simulate`

For the three POST routes it runs before the body is read and before
authorization, so a rejected mutation still triggers it. It is **not** called
when pages are rendered (`/`, `/shop`, `/checkout/[intentId]`), and not when
the runtime is unconfigured.

**Throttled cleanup.** `maintain()` does real work at most once per 60 seconds
per process; other calls inside that window return immediately. Separately, a
new-session attempt that passes the allocation budget always runs a cleanup
before its capacity decision; that path is not throttled.

**Consequence.** If none of those requests arrive, nothing is reclaimed.
Expired sessions and their records then stay in memory, unreachable, until the
next qualifying request or a restart.

**Deferred cleanup after a racing mock operation.** A checkout START can no
longer be committed for a dead session (see below). A payment step already in
progress when its session is reclaimed can still write a ledger operation or a
mock-provider record after the cleanup pass. Those are removed by the next
cleanup run, whenever that happens, because the sweeps work by "owner no
longer exists".

**Production retention.** Not implemented. Real payment records, above all
unknown and pending outcomes, must never be deleted by session cleanup and need
a separately designed durable retention policy.

## Checkout commit and session liveness

No checkout intent is stored for a session that has expired, been revoked or
been reclaimed. `CheckoutRepository.commitCheckoutStart` is the only way an
intent is created. In one step with no `await`, it asks a synchronous liveness
check about the owning session and, only if that passes, writes the intent,
its first transition and its quote. Session removal and checkout removal are
each uninterrupted steps too, so reclamation is either wholly before the
commit (the check fails, nothing is written) or wholly after it (the records
are deleted by owner). A request authorized earlier whose session has since
died gets the generic 403. This relies on single-threaded execution in one
process; it is not a database transaction and does not carry over to PostgreSQL.

## Known limitations

- The in-memory repository's `transaction()` marks boundaries only; it has no
  rollback. A PostgreSQL implementation of `CheckoutRepository` and
  `OperationLedger` does not exist yet (only the session store and a few
  statements do).
- **Mock-only cleanup.** When an expired, idle or revoked session is reclaimed,
  every checkout record it owned is deleted with it, including unknown and
  pending simulated outcomes. This is acceptable only because nothing here is
  real.
- A live session can still accumulate checkouts for up to its 24-hour lifetime,
  limited only by the per-session rate limits.
- The in-memory audit log keeps the most recent 5000 events and drops older ones.
- The session capacity guarantee is atomic only inside one process. The
  PostgreSQL statement written for it is not race-free and is unexecuted.
- `MANUAL_REVIEW` has no outbound transitions; resolving it is out of scope.
- Carts have a schema but no application code.
- Page-level responses for a missing session or another session's checkout are
  streamed, so the HTTP status is 200 with a redirect or not-found body.
- No Playwright tests were written or run. The browser check was one manual
  pass in Chrome.
- Retention (30 days), reconciliation targets (15 and 60 minutes) and rate
  limit values are proposals, not operating guarantees.
- Tests against the mock payment provider say nothing about real PayPal behaviour.
