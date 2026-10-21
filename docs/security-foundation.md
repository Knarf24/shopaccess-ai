# Security foundation: implementation notes

Companion to Security Foundation Specification v1.1. It records how the
mock-only foundation is built, and exactly which controls are active. Product
intent is recorded separately in `docs/product-governance.md`. That record
does not change the controls, the evidence, or the execution gates here.

## Status of controls

This table describes the default, mock mode: everything runs in one process's
memory against local mocks, nothing is backed by PostgreSQL, and the default
configuration contacts no external service. An opt-in external advisory path
is recorded in "External advisory milestone (Qwen)" below. The opt-in
PostgreSQL mode is described in the last section of this document; it has
been written and has not been run.

| Area | Status |
| --- | --- |
| Session cookie issue, lookup, idle and absolute expiry | Active on the demo routes (in-memory store) |
| Trusted-origin, Fetch Metadata and session-bound CSRF checks | Active on the mutating demo routes |
| Session ownership of intents, quotes, confirmations | Active (in-memory repository) |
| Server-priced immutable quotes, explicit single-use confirmation | Active |
| Readiness engine and guarded mock AI explanations | Active on `/shop` in the default demo |
| Opt-in external advisory (Qwen through Synthorai) | Recorded below. Not the default. Persistence and payments stayed mock |
| External listings shown separately, with no checkout action | Active on `/shop` for the local mock. The guided external search is implemented and live-disabled |
| Simulated payment lifecycle (reducer, ledger, recovery) | Active on `/checkout/[intentId]`, mock provider only |
| Form body type and size limits, per-session rate limits | Active; rate-limit store is single-process |
| Opt-in demonstration admission | Off in development and test when `SHOPACCESS_DEMO_ADMISSION` is omitted. Local checks are recorded below. The attempt counter is process-local, and restart durability is unresolved |
| Sanitized audit events | Active, in memory only (lost on restart) |
| Session rotation and revocation | Library, tested; no route calls them |
| PostgreSQL migrations `0001` to `0009` | Executed on disposable test clusters only (the runs are recorded in section 19.18 of the PostgreSQL specification); never applied to an application database |
| Opt-in PostgreSQL application mode | Written; **never run** (see the last section) |
| CSP and security headers, retention job, shared rate-limit store | Not implemented (deferred by the specification) |

## Local development without weaker cookies

Cookie attributes are the same in every environment: `__Host-` prefix,
`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`. Nothing relaxes them.

The one local adaptation is in `src/server/config.ts`: when `NODE_ENV` is
exactly `development`, a plain-HTTP loopback origin (`http://localhost:PORT`
or `http://127.0.0.1:PORT`) may be listed as a trusted origin. In any other
environment such an origin is a configuration error. Chrome and Firefox accept
`Secure` cookies on `http://localhost`; Safari does not, and the shop page says
so instead of looping. `next dev --experimental-https` is not used by itself
because that fetches a certificate tool, which this milestone does not permit.
The October 12 Safari and VoiceOver pass below used a local P-256 certificate
and key. That temporary CA trust was later removed. The certificate files were
preserved, and a subsequent `security verify-cert` returned
`CSSMERR_TP_NOT_TRUSTED`.

Required settings (there are no defaults; the flow is switched off without them):

```bash
(
  unset SHOPACCESS_MOCK_STORE_DIR SHOPACCESS_MOCK_STORE_KEY_FILE
  SHOPACCESS_SESSION_KEY="$(openssl rand -base64 32)" \
  SHOPACCESS_TRUSTED_ORIGINS=http://localhost:3000 \
  PAYMENT_PROVIDER_MODE=mock \
  exec npm run dev
)
```

This milestone command is memory mode. The subshell unsets
`SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE` before the
server starts, so an inherited value does not select a store. Follow the store
rule in the repository README: do not point it at an existing store. On this
branch the same command launches the wired charger-conversation checkout.
The key above is generated per run and never written to disk. `next start`
(production mode) rejects the loopback origin, so the demo needs an HTTPS
origin there.

## Design decisions worth reviewing

- **Two ID spaces.** Merchant IDs (`dmp_`, `dmv_`, `dmm_`) and external
  discovery IDs (`ext_`) cannot match each other's patterns, and checkout looks
  up the merchant catalog by exact ID only.
- **Channel3 transport.** `createFetchChannel3Transport` in
  `src/lib/providers/channel3-discovery.ts` is the only `fetch` call for that
  adapter. `src/server/runtime.ts` is the only application importer. Live
  activation stays off: a present discovery switch and API key do not install
  that transport. Redirects are refused. The three-action listing budget is
  per session and process-local, and it resets when the process restarts.
  The search form remains a native POST to the guarded listings route, including
  when JavaScript is off. With JavaScript, the form commits the localized pending
  status and yields so the browser can render it before that same post. The yield
  is not proof the shopper saw the status. A repeated submit is ignored until the
  submission settles. If the native post throws before navigation, the form shows
  a localized error, clears the pending state and the submit lock, and the button
  can be used again.
  External listing rows are not merchant
  quotes, readiness inputs, or payments.
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
- No Playwright tests were written or run. The original mock browser check was
  one manual pass in Chrome. The later Qwen browser cases are QW-2 through
  QW-6 below; they are manual cases, not an acceptance suite. The October 12
  Safari and VoiceOver pass is a separate manual case, also recorded below. It
  does not fully pass A35 and is not accessibility acceptance. The October 12
  local-mock Chrome comparison check is two further manual English cases,
  also recorded below. Those cases use the local mock. They are not a live
  Qwen run, a Spanish case, accessibility acceptance, PostgreSQL execution, or
  payment acceptance. The October 12 English structured-clarification browser
  case is one further manual English case, also recorded below. It uses the
  local mock. It does not establish Spanish clarification, live-Qwen behavior,
  accessibility acceptance, PostgreSQL execution, or payment acceptance. The
  October 13 presentation and bilingual-spacing checks are recorded below.
  They are separate from these October 12 cases and are not full frontend
  acceptance, accessibility acceptance, PostgreSQL execution, a live-provider
  run, or payment acceptance. The October 13 accessibility name and
  description correction is recorded below. It leaves those earlier records
  in place. Automatic VoiceOver announcements remain unresolved. Focus still
  returns to the body after submissions. The correction is not accessibility
  acceptance, and PostgreSQL A35 is not passed. The October 13 local-mock
  skip-link browser check is recorded below. It is keyboard and markup
  evidence. No VoiceOver speech was observed. It is not accessibility
  acceptance, and PostgreSQL A35 is not passed.
- Retention (30 days), reconciliation targets (15 and 60 minutes) and rate
  limit values are proposals, not operating guarantees.
- Tests against the mock payment provider say nothing about real PayPal behaviour.

## External advisory milestone (Qwen)

Labels QW-1 through QW-6 are for this milestone only. They are not the
PostgreSQL specification identifiers T-13 and U-15.

Every browser run below used the in-memory mock. The demo launcher set
`PAYMENT_PROVIDER_MODE` to `mock` and did not set `SHOPACCESS_PERSISTENCE_MODE`.
QW-2 through QW-5 each reserved exactly one exclusive slot file,
`budget-slots/slot-1`, 28 bytes, mode `0600`, whose JSON has only the key
`reservedAt`. Those directories do not contain `slot-2`. QW-6 reserved both
`slot-1` and `slot-2` in its own directory; each file is the same size, mode,
and shape. The server logs do not retain the advisory card text, so these
entries do not state which products the page painted except where a browser
observation is reported separately below.

| Label | What it records | What it does not prove |
| --- | --- | --- |
| QW-1 | Standalone live check, separate from every browser run. `qwen-live-check-20261012/outcome.json`: outcome `OK`, 3933 ms, one validated reference, 354 prompt tokens, 113 completion tokens, 467 total tokens. | No shop page, no budget slot, no suitability filter, no payment. |
| QW-2 | First browser case, `qwen-shop-demo-budget-wiring-20261012`. `GET /shop?use=schoolwork&budget=500&started=1` returned 200 in 5.2s. No advisory diagnostic line. One slot. Shutdown `STOPPED`: SIGTERM sent, SIGKILL not needed, no residual process, `unexpectedPaths` empty. `git-before.txt` and `git-after.txt` are byte-identical, SHA-256 `e1b78e4863fd4e116f9ea061c78cfb62e34b73e6285642b33045dd5992d22cfb`. | The missing suggestion has no recorded cause. This build did not yet write advisory diagnostics. |
| QW-3 | Timeout browser case, `qwen-shop-demo-diagnostics-20261012`. The shop request returned 200 in 5.3s, and the log records `shopaccess: advisory stage=transport code=DEADLINE elapsedMs=5004`. One slot. The first shutdown was `STOPPED` with `unexpectedPaths` empty. The two snapshots are byte-identical, SHA-256 `c1c21a9538700c303e0072ab163ed717e68992a9c5af127bbe0e04402e316f1d`. | A later retry shutdown in the same directory lists six unexpected paths from the subsequent deadline edit. That retry is not this browser result. The deadline in this build was 5000 ms. |
| QW-4 | Unsuitable-recommendation browser case, `qwen-shop-demo-15s-retry-20261012`, after the deadline was 15000 ms. The shop request returned 200 in 6.2s with no advisory failure line. One slot. Shutdown `STOPPED`, `unexpectedPaths` empty. Snapshots byte-identical, SHA-256 `a292a780b14acb18a64efd1eb4b65009129b46fb5fcd8b59a95164e075749323`. The reported browser observation: StudyBook at $449 met schoolwork readiness and the $500 budget, and the advisory block also named CodeBook at $799, CampusBook at $649, and ValueBook at $229. | The log does not retain that rendered text. An earlier directory, `qwen-shop-demo-15s-20261012`, has an empty `budget-slots` directory and no `server.log`; it reserved no request and is not a browser result. |
| QW-5 | Suitability browser case, `qwen-shop-demo-suitability-20261012`. `GET /session/start?use=schoolwork&budget=500` returned 303. `GET /shop?use=schoolwork&budget=500&started=1` returned 200 in 5.1s. The log has no advisory failure line. One slot. Shutdown `STOPPED`: SIGTERM sent, SIGKILL not needed, inspection ready, no residual process, `afterPersistence` written, baseline present, `unexpectedPaths` empty, durable ownership false. Snapshots byte-identical, SHA-256 `ded5921c8da5276c21dff4e68f22f163c1946eb11f5ca0b73e9ac38fd6c1e02e`. | One Schoolwork/$500 browser case. It is not acceptance of the advisory path, the shop, persistence, or payments. Persistence and payments were mock. |
| QW-6 | Spanish guided-shopping case, `qwen-guided-spanish-prompt-demo-20261012`. Log: `GET /session/needs?lang=es` returned 303 in 210ms; `GET /shop/needs?started=1&lang=es` returned 200 in 185ms; `POST /shop/needs/submit` returned 303 in 2.3s; `GET /shop/needs?lang=es` returned 200 in 78ms with no notice or error query; `POST /shop/needs/confirm` returned 303 in 49ms; `GET /shop/needs?lang=es` returned 200 in 4.4s. No advisory failure diagnostic. The 2.3s submit is the interpretation and the 4.4s GET is the recommendation. Two slots. Shutdown `STOPPED`: SIGTERM sent, SIGKILL not needed, no residual process, inspection ready, `afterPersistence` written, baseline present, `unexpectedPaths` empty. Snapshots byte-identical, SHA-256 `1b8e64a081ad82339ec5551b38db6ed5400cf499e6aa14d7bef66d7d2c6e35a8`. `shutdown.json` records `durableOwnership` false because cleanup hardcodes that field before the finish report is printed. The ownership file is a valid full record, and the terminal finish report sets `durableOwnership` true because that file exists. | One successful mock case. The log does not retain prefilled needs, the product, the price, or the explanation text. It is not general model reliability, accessibility acceptance, PostgreSQL execution, or payment acceptance. It does not replace QW-2, QW-3, QW-4, or QW-5, or the earlier failed Spanish runs in `qwen-guided-spanish-demo-20261012` and `qwen-guided-spanish-retry-20261012`. Persistence and payments were mock. |

Owner report and browser screenshots for QW-6, separate from the log: the owner
left the structured controls empty before submitting the Spanish sentence.
Screenshots showed Schoolwork and $500 prefilled, then explicit needs
confirmation, then StudyBook 14 at $449 with supplied Spanish explanations
beside the English originals. Chrome's translation popup appeared, and the
owner did not activate translation.

## October 12 Safari and VoiceOver manual pass

One manual pass on October 12, 2026. The assistant was the local mock,
persistence was in memory, and payments stayed mock. This is not a Qwen case.
It does not replace QW-1 through QW-6, or the earlier failed Spanish runs in
`qwen-guided-spanish-demo-20261012` and `qwen-guided-spanish-retry-20261012`.

Owner report, separate from the screenshots and terminal output: the owner
completed the Spanish guided journey by keyboard with VoiceOver active.
VoiceOver read the product, quantity, and $449 total. The owner reached
purchase review and did not confirm the purchase or use payment controls. The
owner activated needs submission more than once.

Observed screenshots and terminal output, separate from that report: Safari's
HTTP session failure was followed by a working HTTPS session. Structured
Schoolwork and $500 input led to StudyBook 14 at $449. A duplicate submission
produced `STALE_DRAFT`, and the preserved draft was subsequently confirmed.
`POST /checkout/start` redirected to purchase review, which returned 200.
VoiceOver captions showed Spanish guidance. The owner's recording also included
an ISO timestamp. PID 23310 was verified as this project's Next server, then
sent SIGTERM. The subsequent check for a listener on port 3000 returned no
output.

Scope: one manual pass through purchase review. It is not full accessibility
acceptance or WCAG certification. It does not fully pass A35. Automatic status
announcements, error coverage, and broader assistive-technology testing remain
unverified. The temporary P-256 CA trust was removed afterward. The
certificate files were preserved, and a subsequent `security verify-cert`
returned `CSSMERR_TP_NOT_TRUSTED`.

## October 12 local-mock Chrome comparison check

Two manual English browser cases on October 12, 2026. Chrome used plain HTTP
at `127.0.0.1`. The assistant was the local mock, persistence was in memory,
and payments stayed mock. This check is separate from QW-1 through QW-6 and
from the October 12 Safari and VoiceOver pass above. It does not replace
those records, or the earlier failed Spanish runs in
`qwen-guided-spanish-demo-20261012` and
`qwen-guided-spanish-retry-20261012`.

Screenshot observations, separate from the terminal output:

- Schoolwork at $500: StudyBook at $449 was eligible. Both CodeBooks were
  excluded for price. ValueBook showed memory and storage failures. CampusBook
  showed price and stock failures.
- Programming at $1100: StudyBook at $449 was eligible with caveats. CodeBook
  at $799 and CodeBook at $1,099 were eligible, with distinct variant-specific
  purchase buttons. ValueBook and CampusBook were excluded and had no purchase
  controls.
- The limitation statement and the "Why this?" explanations were visible.

Terminal evidence is the supplied output from that check. No server log for
this check was retained:

- Two needs submission and confirmation sequences completed.
- No checkout request appears in the supplied output.
- Control-C returned the shell prompt. The subsequent check for a listener on
  port 3000 returned no output.
- An image-loading performance warning appeared.

Scope: two manual English browser cases with the local mock. They are not a
live Qwen run, a Spanish case, accessibility acceptance, PostgreSQL execution,
or payment acceptance. The check stopped before checkout.

## October 12 English structured-clarification browser case

One manual English browser case on October 12, 2026. Chrome used plain HTTP
at `127.0.0.1`. The assistant was the local mock, persistence was in memory,
and payments stayed mock. This case is separate from QW-1 through QW-6, the
October 12 Safari and VoiceOver pass, and the October 12 local-mock Chrome
comparison check above. It does not replace those records, or the earlier
failed Spanish runs in `qwen-guided-spanish-demo-20261012` and
`qwen-guided-spanish-retry-20261012`.

Screenshot observations, separate from the supplied terminal output:

- The first input was "I need a laptop for school." Both structured controls
  were empty.
- The response retained Schoolwork, asked for the missing budget, and
  displayed the original sentence as read-only text. The textarea,
  confirmation, comparison, and purchase controls were absent.
- Entering structured budget 500 opened an editable review showing Schoolwork
  and 500. Products remained absent.
- After explicit confirmation, StudyBook 14 appeared at $449.00 with the
  limitation statement and the "Why this?" factors.
- Both CodeBook variants were excluded for price. ValueBook was excluded for
  memory and storage. CampusBook was excluded for price and stock. Excluded
  rows had no purchase buttons.

Terminal evidence is the supplied output from that case. No server log for
this browser case was retained. The supplied status codes do not establish
how many provider calls ran:

- English session establishment returned 303, and the following needs page
  returned 200.
- Two `POST /shop/needs/submit` requests each returned 303, and each was
  followed by a needs page that returned 200.
- One `POST /shop/needs/confirm` returned 303, and the following needs page
  returned 200.
- No checkout request appears in the supplied output.
- An image-loading performance warning appeared.
- Control-C returned the shell prompt. The subsequent `lsof` check showed no
  listener on port 3000.

Scope: one manual English Chrome case with the local mock, in-memory
persistence, and mock payments. It stopped before checkout. It does not
establish Spanish clarification, live-Qwen behavior, accessibility acceptance,
PostgreSQL execution, or payment acceptance. The earlier unit and typecheck
evidence remains a separate record.

## October 13 presentation and bilingual-spacing checks

October 13, 2026. The assistant was the local mock, persistence was in memory,
and payments stayed mock. These checks are separate from QW-1 through QW-6,
the October 12 Safari and VoiceOver pass, the October 12 local-mock Chrome
comparison check, and the October 12 English structured-clarification case.
They do not replace those records or the earlier failed Spanish runs in
`qwen-guided-spanish-demo-20261012` and
`qwen-guided-spanish-retry-20261012`.

Owner screenshots, separate from both inspection browsers:

- English desktop presentation of the guided comparison.
- Spanish desktop presentation of the guided comparison.
- Spanish purchase review at 390px and at 320px.
- Spanish results at 320px.
- A visible gold keyboard-focus outline.
- The owner opened purchase review in English and in Spanish. The screenshots
  showed the acknowledgment unchecked and the checkout state QUOTED. They do
  not establish that either journey stopped before checkout, and they do not
  establish payment acceptance.

Cursor inspection browser, separate from the owner screenshots and from the
Claude inspection:

- One Spanish local-mock comparison, Schoolwork at $500, at 1280px and at
  320px.
- Each English assessment reason and its Spanish translation appeared on
  separate lines. The measured gap was 4px on Suggestions, the eligible
  StudyBook card, and the excluded cards.
- The page did not scroll horizontally at either width. At 320px the longer
  reasons wrapped inside the cards.
- That browser did not complete a fresh English session. This measurement is
  not an English-only check.

Claude inspection, separate from the owner screenshots and from the Cursor
inspection:

- A fresh English local-mock session in headless Chrome.
- The viewport was verified at 320px. No horizontal overflow was detected.
  Assessment reasons were English only.
- The CodeBook 32 GB capture was measured but not visually reviewed.

The owner reported that the local server was shut down. An empty listener
check for this October 13 run was not independently verified from retained
output.

Retained database-free validation is not browser evidence:

- Presentation correction, directory
  `guided-presentation-correction-validation-20261013`: 29 files, 1,114 tests,
  unit exit 0, then non-incremental typecheck exit 0.
- Bilingual assessment-line change, directory
  `bilingual-assessment-lines-validation-20261013`: 29 files, 1,114 tests,
  unit exit 0, then non-incremental typecheck exit 0.

A saved browser profile used for local inspection stays private and is not
part of this repository. This record does not include cookie values or profile
contents.

Scope: October 13 presentation and bilingual-spacing observations. They are
not full frontend acceptance, accessibility acceptance, PostgreSQL execution,
live-provider behavior, or payment acceptance.

## October 13 accessibility name and description correction

October 13, 2026. The assistant was the local mock, persistence was in memory,
and payments stayed mock. This correction is separate from QW-1 through QW-6,
the October 12 Safari and VoiceOver pass, the October 12 local-mock Chrome
comparison check, the October 12 English structured-clarification case, and
the October 13 presentation and bilingual-spacing checks. It leaves those
records in place, including the earlier failed Spanish runs in
`qwen-guided-spanish-demo-20261012` and
`qwen-guided-spanish-retry-20261012`.

Owner report, separate from the retained reviews and from the browser recheck:
VoiceOver read page sections. The missing-budget question was not heard
automatically after navigation. The owner reported that the local server was
shut down. An empty listener check for this run was not independently verified
from retained output.

Retained source reviews and validation, separate from the owner report and
from the browser recheck: the final run passed 29 files and 1,117 tests, then
typecheck. That run is directory `a11y-notice-target-validation-20261013`:
unit exit 0, then non-incremental typecheck exit 0.

Claude browser recheck, separate from the owner report and from the retained
validation. Directory
`/Users/frankncube/shopaccess-backups/a11y-recheck-20261013-141045`. Chrome's
computed accessibility tree confirmed the purchase button name `Review this
purchase for StudyBook 14, 8 GB memory, 256 GB SSD`. It confirmed the
conditional read-only explanation: that explanation was absent on the
missing-budget page, where no shopper sentence was present. Budget
descriptions contained the rendered question, the hint, and the validation
alert as applicable. The missing-budget field was described by the question
and the hint. After the invalid clarification, the budget field was described
by the validation alert, the question, and the hint. On the editable needs
review, the budget field was described by the hint. The session ended on the
recommendations page. No checkout was started. Screenshots were captured and
were not visually reviewed. After the submissions in this recheck, focus was
on the body.

A saved browser profile and any cookies from this recheck stay private and
are not part of this record.

Scope: one October 13 local-mock name and description correction. Automatic
VoiceOver announcements remain unresolved. Focus still returns to the body
after submissions. This record is not accessibility acceptance, and PostgreSQL
A35 is not passed.

## October 13 local-mock skip-link browser check

October 13, 2026. A fresh English session. The assistant was the local mock,
persistence was in memory, and payments stayed mock. This check is separate
from QW-1 through QW-6, the October 12 Safari and VoiceOver pass, the
October 12 local-mock Chrome comparison check, the October 12 English
structured-clarification case, the October 13 presentation and
bilingual-spacing checks, and the October 13 accessibility name and
description correction. It leaves those records in place, including the
earlier failed Spanish runs in `qwen-guided-spanish-demo-20261012` and
`qwen-guided-spanish-retry-20261012`.

The retained harness describes a separate headless Chrome and sends keyboard
events only. The shopper-text field stayed empty. The measured viewport was
1280 by 813. Directory
`/Users/frankncube/shopaccess-backups/a11y-skiplink-20261013-153602`.

Measured focus and accessibility tree, separate from the screenshots. The
journey ran from the first ask, to the missing-budget question, to the invalid
empty clarification, to an editable Schoolwork and 500 review, and then to
explicitly confirmed results. On each load, focus was on the body. Tab then
revealed "Skip to the current step" as the first application control. Enter
focused one selected target, and that target occurred once. Only that target
had `tabindex="-1"`.

- First ask: the heading "Guided shopping". The next Tab reached the
  shopper-text field.
- Missing budget: the notice "What is your budget in whole US dollars?". The
  next Tab reached the use choice.
- Invalid clarification: the alert "That choice is not a valid use or
  whole-dollar budget. The saved draft was not changed." The next Tab reached
  the use choice.
- Review: the notice "Check the use and budget, change anything that is
  wrong, then confirm." The next Tab reached the review use choice. The
  review values were Schoolwork and 500, and both controls were editable.
- Results: the Suggestions heading. The next Tab focused the button "Review
  this purchase for StudyBook 14, 8 GB memory, 256 GB SSD" and did not
  activate it. The page stayed on the needs results.

Budget description references resolved to visible elements, each occurring
once. The first-ask budget field referenced the hint. The missing-budget
field referenced the question and the hint. After the invalid clarification,
the budget field referenced the validation alert, the question, and the hint.
The review budget field referenced the hint.

A review with no rendered notice, and a skip target of `#review-heading`, was
not observed in this browser run. Source and unit coverage of that target
remains a separate record.

Retained server log, separate from the supplied report that no purchase or
payment control was activated. The log shows English session establishment,
three needs submissions, the clarification-invalid page, one needs
confirmation, and the following needs page. No checkout request and no
payment request appear in that log.

Shutdown evidence in the same directory: the server log ends after that
results page. The pid file records a process id and does not record a later
listener check. The Chrome log records an updater shutdown, which is not a
check that port 3000 had no listener. An empty listener check is not
independently supported by these retained files.

Screenshot observations, from inspected frames, separate from the
measurements:

- With the skip link focused on the first ask, the link was visible at the
  top with a gold outline. The shopper text and the budget field were empty.
- After Enter on the invalid clarification, the gold outline was on the
  validation sentence. Schoolwork was selected and the budget field was empty.
- After Enter on the review, the gold outline was on the review instruction.
  Schoolwork and 500 were shown, and the confirm button was not outlined.
- After the following Tab on the results, the gold outline was on the
  StudyBook 14 purchase-review button. The price shown was $449.00. The page
  was still the recommendations page.

A saved browser profile and any cookies from this check stay private and are
not part of this record. No VoiceOver speech was observed.

Scope: one English local-mock keyboard and markup check. It is not full
frontend acceptance or accessibility acceptance, and PostgreSQL A35 is not
passed. Spanish, mobile, and live-provider behavior were not tested here.

## October 13 demo-admission implementation and local checks

October 13, 2026. This record is separate from QW-1 through QW-6, the October 12
Safari and VoiceOver pass, the October 12 local-mock Chrome comparison check,
the October 12 English structured-clarification case, the October 13
presentation and bilingual-spacing checks, the October 13 accessibility name
and description correction, and the October 13 local-mock skip-link browser
check. It leaves those records in place, including the earlier failed Spanish
runs in `qwen-guided-spanish-demo-20261012` and
`qwen-guided-spanish-retry-20261012`. It does not change the session-start
limit above: that limit is still single-process, Forwarded-IP is still never
consulted, and the app must still not be exposed publicly on the strength of
these protections.

The homepage remains readable without admission. Attempt counters remain
process-local. Restart durability is unresolved. This record is not production
readiness, shared rate limiting, VoiceOver speech, accessibility acceptance,
or deployment authorization. PostgreSQL A35 is not passed.

### Source behavior

`SHOPACCESS_DEMO_ADMISSION` omitted, with `NODE_ENV` exactly `development` or
exactly `test`, leaves the gate off. The current local flow stays available.
Exact `on` requires a separate admission key and a passphrase; the key must
not be the session key. Production, an unset `NODE_ENV`, and every other
setting fail closed. `SHOPACCESS_DEMO_ADMISSION=on` together with PostgreSQL
persistence is unsupported and fails closed before a PostgreSQL runtime is
built. When the admission setting is absent, PostgreSQL behavior is unchanged.
`getApplication` is the path that applies this resolution. A direct
`createRuntime` call without an admission override defaults to off for
existing handler tests; that default is not the production path. No production
process was started for this record.

When the gate is on, five counted passphrase verifications are allowed in a
15-minute window on that runtime. The sixth is refused even if the passphrase
matches. A matching passphrase and logout do not reset the counter. The window
lives on one runtime. The source states that it is lost when that process
stops. No retained check restarted the process, so restart durability is
unresolved.

Cookie names are `__Host-shopaccess_demo_csrf` and
`__Host-shopaccess_demo_admission`. Attributes are `Path=/`, `HttpOnly`,
`Secure`, `SameSite=Lax`, and no `Domain`. The two purposes use different HMAC
labels. This record does not include cookie values, secret values, or
browser-profile contents.

`GET /` stays public. With the gate on, protected session, needs, and checkout
routes are checked before session, draft, or checkout work. A wrong passphrase
is described by `demo-passphrase-refusal` and is `aria-invalid="true"`. A
rate-limit retry is described by `demo-admission-retry` and is not marked
invalid. A quiet login and the CSRF bootstrap screen do not reference either
id.

### Source review and retained unit and typecheck results

These runs are source evidence. They are not the browser checks below.

- `demo-admission-implementation-20261013`. Database-free unit suite exit 1:
  1 failed and 1,130 passed, 30 files. The failure was the wrapped
  `createRuntime` declaration in `tests/unit/pg-app-config.test.ts`. Typecheck
  was not run. The directory has no invocation record.
- `demo-admission-correction-20261013`. The declaration was restored to one
  line. The existing assertion was not changed. Unit suite exit 0: 30 files,
  1,131 tests. Non-incremental typecheck exit 2:
  `tests/unit/demo-admission.test.ts(72,22)` TS2540, assigning `NODE_ENV`.
  The directory has no invocation record.
- `demo-admission-env-stub-20261013`. `NODE_ENV` is stubbed and restored with
  the installed Vitest mechanism. Unit suite exit 0: 30 files, 1,131 tests.
  Non-incremental typecheck exit 0, with empty stdout and stderr. The
  directory has no invocation record.
- `demo-admission-presentation-20261013`,
  `demo-admission-retry-description-20261013`, and
  `demo-admission-field-presentation-20261013`. Each retains an isolated
  no-TCP unit command and a following non-incremental typecheck. Each unit
  suite exit 0: 30 files, 1,132 tests. Each typecheck exit 0, with empty
  stdout and stderr. Unit stderr in these runs is the existing advisory
  diagnostics.

### Development-mode admission, login, and logout

Directory `demo-admission-20261013-180448`. One development server,
`NODE_ENV=development`, `SHOPACCESS_DEMO_ADMISSION=on`, mock payments, and no
persistence-mode, database, PayPal, or advisory-budget setting. Secrets were
generated in the controller's memory and were not written into the record.
The browser was a separate headless Chrome. This check is separate from the
unit and typecheck results above.

Browser results, separate from the server log:

- The homepage at `/` showed the guided-shopping language choice, the needs
  form, and the demo catalog, including StudyBook 14 at $449.00. There was no
  passphrase field. Screenshot `a1-home-unadmitted.png` was inspected.
- `/session/start`, `/session/needs?lang=en`, and `/shop/needs?lang=en` each
  landed on `/demo/admission?lang=en`, with the heading "Enter the
  demonstration" and no cookie names. The retained HTTP record for
  `/session/needs?lang=es` names the location `/demo/admission?lang=es`.
- Continue issued the CSRF cookie and then showed the passphrase field. A
  wrong passphrase stayed on the admission page with "The passphrase was not
  accepted." A later correct passphrase landed on `/?lang=en`.
- Logout landed on `/demo/admission?lang=en` and showed the continue step,
  "The next step asks for the passphrase."
- A second admission reached the guided results for Schoolwork and 500,
  including the StudyBook 14 purchase-review button. Logout again returned to
  the continue step. After that logout, `/shop/needs?lang=en` and
  `/session/needs?lang=en` landed on the admission page, and no cookie names
  remained.
- Spanish bootstrap, login, and a wrong passphrase were shown. The refusal was
  "La frase de acceso no fue aceptada." The language wrapper was `es`.

The retained server log shows admission, session, and needs requests. It does
not show a checkout request or a payment request. Final listener checks
recorded no listener on port 3000 or port 9333. The owner's Chrome process
was still present. No VoiceOver speech was observed. Screenshots other than
the homepage named above were not inspected for this section.

### Refusal descriptions and the attempt limit

Directory `admission-presentation-20261013-191349`. One development server
served both languages. The same development, mock-payment, and in-memory
conditions were used. Only a wrong passphrase was typed. This check is
separate from the login and logout check above and from the latest
presentation check below.

Measured association, separate from screenshots. Those screenshots were not
inspected for this section.

- A wrong passphrase in English and in Spanish was described by
  `demo-passphrase-refusal`, and that id occurred once. The accessible
  description was the rendered sentence. There were no dangling references
  and no duplicate ids. The `aria-invalid` attribute was absent. The
  accessibility invalid state was false.
- English submissions 1 through 5 landed on `notice=rejected` with "The
  passphrase was not accepted."
- English submission 6 landed on `notice=retry`. The field was described by
  `demo-admission-retry`, once. The rendered sentence was "Too many attempts.
  Please wait and try again." The accessible description matched it. The
  `aria-invalid` attribute was absent, and the accessibility invalid state
  was false.
- A following Spanish submission landed on `notice=retry` with "Demasiados
  intentos. Espere y vuelva a intentarlo." It used the same retry id, once.
  The accessibility invalid state was false.
- Quiet English and Spanish login screens afterward had no alerts, no
  description reference, and no dangling references.
- `/session/needs` landed on `/demo/admission?lang=en`. The only cookie name
  present was `__Host-shopaccess_demo_csrf`.

At 320px and at 1280px in that run, horizontal overflow was false. The heading
was measured at 16px with weight 400. The unfocused password border was
`rgb(191, 207, 202)`, about 1.60:1 against the paper panel and 1.62:1 against
the white field fill. Those measurements belong to this earlier run. The
focused outline was a 3px solid `rgb(239, 173, 77)` ring. Its contrast was
not measured in this run.

The server exited 0. Final listener checks recorded no listener on port 3000
or port 9333. No VoiceOver speech was observed.

### Latest English and Spanish presentation checks

Directory `admission-correction-20261013-192347`. Development mode, admission
on, mock payments, and in-memory persistence, as in the startup record. One
server served both languages. Only a wrong passphrase was typed, once in
English and once in Spanish. This run did not repeat the five-attempt limit.
Measured viewports were 1280 by 900 and 320 by 640. Horizontal overflow was
false at both widths, in both languages. These measurements are separate from
the inspected screenshots.

Measured on the quiet login and on the wrong-passphrase screen, in English
and Spanish, at both widths:

- The heading was 30px, weight 600, line-height 36px, color `rgb(23, 52, 55)`,
  contrast 12.37 against the page background `rgb(248, 247, 242)`. It fit the
  viewport. At 320px its box was two lines high. At 1280px it was one line.
- The language panel was a column with a 12px gap. The gap from the language
  choices to their submit button was 12px.
- The unfocused password border was `rgb(15, 85, 86)` on every side. Contrast
  was 8.56:1 against the white field fill and 8.48:1 against the paper panel
  `rgb(255, 254, 250)`.
- Quiet login had no `aria-invalid` attribute, no `aria-describedby`
  attribute, and no alerts. The accessibility invalid state was false and the
  description was empty.
- After the wrong passphrase, `aria-invalid` was `true`. `aria-describedby`
  was `demo-passphrase-refusal`, and that id occurred once. The accessible
  description equalled the rendered alert: "The passphrase was not accepted."
  in English and "La frase de acceso no fue aceptada." in Spanish.

Keyboard focus reached the language radio, the language submit button, the
passphrase field, and the admission submit button. The focus outline was
`solid 3px rgb(239, 173, 77)` with a 3px offset. Its measured contrast against
the adjacent surface was 1.93:1. That low-contrast amber focus ring remains
an open observation. The outline fit the viewport.

Screenshots inspected from this directory:

- `en-2-login-1280.png` and `en-2-login-320.png`. Cream page, teal buttons,
  empty passphrase field with a teal border, and a visible gap between the
  language choices and "Show this language". At 320px the heading "Enter the
  demonstration" wraps to two lines. The field is empty and no refusal is
  shown.
- `en-5-focus-field-1280.png`. The empty passphrase field has an amber outline
  around the teal border.
- `en-7-rejected-1280.png` and `en-7-rejected-320.png`. The sentence "The
  passphrase was not accepted." is the same size and weight as the
  "Passphrase" label. It is not given the heading's larger treatment. The
  field is empty.
- `es-2-login-1280.png` and `es-2-login-320.png`. The heading is "Entrar a la
  demostración". Español is selected. The label is "Frase de acceso". The
  language button is "Mostrar este idioma". At 320px the heading wraps to two
  lines. The field is empty and no refusal is shown.
- `es-7-rejected-1280.png` and `es-7-rejected-320.png`. "La frase de acceso no
  fue aceptada." matches the label's body size and weight, not the heading.
  The field is empty.

Other frames in that directory were not inspected. The refusal text, styled
like body text, remains an open observation. The server exited 0. Final
listener checks recorded no listener on port 3000 or port 9333. No VoiceOver
speech was observed.

A saved browser profile from each of these checks stays private and is not
part of this record.

## October 13 local production-mode verification

October 13, 2026. Directory timestamps in the retained evidence are UTC, so
some of those names fall on October 14. This record is separate from the
October 13 development-mode admission checks above, from QW-1 through QW-6,
and from the earlier browser checks. It leaves the failed production build
`production-build-20261013-193456` in place: that run exited 1 under the
unit-test no-TCP guard, with 21 blocked `127.0.0.1` connects and no
non-loopback target. It does not change the session-start limit above.
Restart durability and shared rate limiting remain unresolved. This is not
public deployment, payment acceptance, PostgreSQL execution, VoiceOver
speech, or accessibility acceptance. PostgreSQL A35 is not passed.

The TLS proxy, certificate check, journey driver, and build-IPC guard used
here live under private backup directories. They are outside this repository
and are not deployment components. Saved browser profiles and cookie values
are not part of this record. This documentation pass did not re-run the
checks.

### Successful production build, and the build guard's limits

Directory `production-build-ipc-guard-20261013-195816`. One `next build`,
`NODE_ENV=production`, mock payments, and a placeholder trusted origin.
`SHOPACCESS_DEMO_ADMISSION` was omitted. The corrected build-IPC guard was
loaded alone. Its SHA-256 was
`0e84a5c72971f32963c6820c8312e6af5a2e74aac5c026499ceb1d0aa2f394cb`. The
unit-test no-TCP guard was not loaded. The session key was passed on standard
input and is not in the retained files.

Measured result, separate from any screenshot. There is no screenshot in this
directory. Exit status 0. Next.js 16.4.0 compiled, finished TypeScript, and
generated 18 static pages. `.next` afterward had a `BUILD_ID` and 24 entries.
No `next build` process and no port 3000 listener remained.

The guard log contains one line:
`category=allowed-build-ipc pid=61264 port=57236`. The observer, which is
also outside the repository, saw that listener as `127.0.0.1:57236` on the
build process, pid 61207. The connecting process was its child and its
arguments were the Turbopack pool entry plus that port. Other sampled
children included `tsc` and eleven page-data workers. They did not add guard
lines.

This Node hook is not complete network isolation. It does not see native
code, and Unix-socket connects still pass through. The parent-listener check
can go stale before `connect`. The build was not repeated.

### Production refusal with admission omitted

Directory `production-closed-20261013-201013`. The build was not rerun. One
`next start` on `127.0.0.1:3000`, `NODE_ENV=production`, mock payments, and
the same placeholder origin. `SHOPACCESS_DEMO_ADMISSION` was omitted. The
unit-test no-TCP guard was loaded. Its SHA-256 was
`43dc13456a44573e8444aac8fc179844153073cd42297322cf8531da75af83d3`. The
build-IPC guard was not used. Node fetch and a separate headless Chrome did
not load the guard. Fetch did not follow redirects and sent no cookies.

Measured HTTP results, separate from the browser and from screenshots. No
response set a cookie name.

- `GET /` and `GET /?lang=es` were 200.
- `GET /session/start`, `GET /session/needs?lang=en`, and
  `GET /session/needs?lang=es` were 303 to `/demo/admission?lang=en` or
  `/demo/admission?lang=es`.
- `GET /shop`, `GET /shop/needs` in English and Spanish, `GET /checkouts`,
  `GET /checkout/probe-not-a-real-intent`, and the admission URLs, including
  `notice=rejected`, were 200 with no `Location`.
- Empty POSTs to needs submit, needs confirm, checkout start, checkout
  confirm, checkout simulate, admission submit, and admission logout were
  303 to `/demo/admission?lang=en`. That held with no `Origin`, with the
  placeholder origin, and with `Origin: http://127.0.0.1:3000`.
- Empty POSTs to checkout review, checkout cancel, session rotate, and
  session new were 404.

Measured browser landings, separate from those status codes and from the
screenshots. The homepage stayed on `/`, showed the catalog, and had no
password field and no cookie name. `/session/start`,
`/session/needs?lang=en`, `/shop`, `/shop/needs?lang=en`, and
`/checkout/probe-not-a-real-intent` landed on
`/demo/admission?lang=en`. The alert was "This demonstration is not
available." There was no password field. `/session/needs?lang=es` and
`/demo/admission?lang=es` used "Entrar a la demostración" and "Esta
demostración no está disponible." `notice=rejected` and `notice=retry` still
showed the closed sentence, not a passphrase form. `/checkouts` stayed on
`/checkouts`. Its title was "404: This page could not be found." and its
heading was "404". No cookie name was present on these pages.

Screenshot observations, from frames inspected for this documentation pass,
separate from the measurements:

- `b2-session-start.png`. The closed English screen. The sentence "This
  demonstration is not available." is shown. There is no passphrase field.
- `b9-admission-es.png`. The heading is "Entrar a la demostración". Español
  is selected. The sentence is "Esta demostración no está disponible." There
  is no passphrase field.

Other frames in that directory were not inspected. The guard recorded no TCP
connect attempt. Shutdown found no listener on port 3000 or 9333. The owner's
Chrome process was still present. No VoiceOver speech was observed.

### Certificate-only probe

Directory `local-https-certificate-probe-20261014-015326`. This probe served
a certificate page. It did not run the ShopAccess application. Chrome was
155.0.8059.40. Node was v24.21.0.

Measured readings, separate from screenshots. This directory has no
screenshot, and none was inspected.

- Before `Network.enable`, the page was `https://127.0.0.1:3443/`, a secure
  context, with the heading "Certificate probe page". The certificate table
  was empty. The verdict was `CERT_TABLE_EMPTY` and was not accepted.
- `Network.enable` succeeded. A fresh navigation then presented one
  certificate. The verdict was `CERT_ACCEPTED`. The preserved CA fingerprint
  matched, the leaf fingerprint matched the preserved server certificate, the
  leaf was signed by that CA, the name was IP 127.0.0.1, it was within
  validity, and it was not a CA.
- A further navigation produced the same accepted verdict.
- A separate Node TLS check was authorized, used TLSv1.3, and the served leaf
  matched.

Acceptance here means that certificate matched the preserved key material on
this Chrome build. It does not show that a normal browser trust store accepts
the certificate. The probe helpers are outside the repository and are not
deployment components. Shutdown was clean. Ports 3443 and 9333 were empty.

### One English production-mode HTTPS journey

Directory `local-https-production-20261014-020008`. The application was
`next start` on `127.0.0.1:3000`. A loopback TLS proxy listened on
`https://127.0.0.1:3443` and forwarded only to that application. Admission
was configured on for this process. Payments stayed mock. The proxy, the
certificate check, and the journey driver are outside the repository and are
not deployment components. The journey was English only. Spanish shopping and
checkout were not exercised.

Measured certificate and HTTP checks, separate from the journey record and
from screenshots. The certificate step ran with `Network.enable` before
navigation. It accepted one certificate, subject `CN=127.0.0.1`, issuer
`CN=ShopAccess loopback CA`, valid from October 12 to November 11, 2026 GMT,
with the same six checks as the probe. Node TLS was authorized, TLSv1.3, and
the served leaf matched. A request to `/` with `Host: example.invalid`
returned 421. Unadmitted fetches, redirects not followed, were: `/` 200,
`/session/start` 303 to admission, `/session/needs?lang=en` 303 to admission,
`/shop/needs?lang=en` 200 with no `Location`, and `/demo/admission?lang=en`
200. None set a cookie name. This key-specific check does not verify normal
browser trust.

Measured journey, separate from the proxy log and from screenshots. Before
admission, `/session/start`, `/session/needs?lang=en`, and
`/shop/needs?lang=en` landed on `/demo/admission?lang=en` with no cookie
name. Continue then showed an empty passphrase field. `aria-invalid` was
absent. The page script saw no cookie. A correct passphrase landed on
`/?lang=en`. Guided shopping used an empty shopper-text field, Schoolwork,
and 500. The review showed Schoolwork and 500, and both controls were
editable. The budget was cleared and typed again as 500, then confirmed. The
results page stayed on `/shop/needs?lang=en`. It included StudyBook 14 and
the button "Review this purchase for StudyBook 14, 8 GB memory, 256 GB SSD",
which points at `/checkout/start`. That button was not reported as activated.

Cookie names, not values. After confirmation the names present were
`__Host-shopaccess_demo_admission`, `__Host-shopaccess_demo_csrf`, and
`__Host-shopaccess_session`. The home page and a return to guided shopping
still carried those names, and the shop page was still the guided shop. The
admission page offered "Leave the demonstration" and had no password field.
Logout landed on the continue screen, "The next step asks for the
passphrase." No cookie name remained. `/shop/needs?lang=en` and
`/session/needs?lang=en` then landed on admission again.

Measured proxy log, separate from the journey record. It shows the needs
submit and the needs confirmation. It contains no `/checkout` request. One
early line is `category=tls-client-error code=ECONNRESET`. The shutdown
record says the proxy denied no connect, the application guard recorded no
TCP connect attempt, ports 3000, 3443, and 9333 were empty, and the
repository was unchanged. The application process was stopped and exited
143. The retained shutdown calls that shutdown clean. No VoiceOver speech
was observed.

Screenshot observations, from frames inspected for this documentation pass,
separate from the measurements:

- `h2-login.png`. English is selected. The passphrase field is empty and has
  a visible border. The button is "Enter".
- `h4b-review.png`. Step "Review the understood need" is current. Schoolwork
  and 500 are shown. The text says the values are editable. The confirm
  button is visible.
- `h4c-results.png`. Suggestions names StudyBook 14 at $449.00 and Ready.
  The purchase-review button is visible. The other laptops are under "Not
  eligible under these checks". The page is still the recommendations page.
- `h6-after-logout.png`. The continue screen is shown. There is no
  passphrase field.

`h1-home.png` and `h4a-first-ask.png` were not inspected. No independent
re-run of this evidence was done for this documentation pass.

## Opt-in PostgreSQL mode (Increment 2.3): written, never run

The contract is section 19.19 of
`docs/postgresql/postgresql-specification-v2.0-draft.md`; section 19.18 of the
same document is the only record of what exists and what has run. Nothing
below has been executed: not the source, not its unit tests, and not the two
new statements, which PostgreSQL has never parsed.

Chosen only by `SHOPACCESS_PERSISTENCE_MODE=postgres`. With the variable not
set the application is the mock described above, built by the same code as
before, with the same cookie. PostgreSQL mode never falls back to the mock.

| Control | How PostgreSQL mode keeps it |
| --- | --- |
| Session cookie | Same name and attributes; the value is `version.token`. A cookie in any other form is no session and is never tried another way |
| Trusted-origin, Fetch Metadata and CSRF checks | A separate guard with the same three checks in the same order; the CSRF token is bound to the session the database authorized |
| New sessions | Admitted without asking only when no session cookie is presented at all. A presented cookie that cannot be used is left in place and the shopper is offered an explicit new session, with the warning that earlier checkouts do not transfer |
| Session rotation | Only by an explicit guarded POST. No GET rotates |
| Credentials | The token digest stays on the server: it is passed to the database functions and to nothing else |
| Database role | The application connects as `shopaccess_web` only, and checks that before it serves anything: identity, no elevated attribute, no role membership, exactly the expected function and table privileges |
| Statements | Only fixed statements from the reviewed catalogue, with bound values. The application applies no migration and calls no operator function |
| Confirmation | Bound to the checkout in the URL before anything is consumed; the database decides every mismatch and writes its own audit rows |
| Challenges | Never issued by loading a page. The same challenge is shown after a restart and in a second tab, re-derived from the database's values |
| Retries | No checkout call is ever sent twice by the application. An outcome that is not known is reported as not known |
| Errors | Generic refusals only. No database message, digest, owner id or key version reaches a response; logs name a field or a five-character code |
| Rate limits | The in-process limits remain a first line; the database's own throttle decides |
| Payment simulation | Not available: hidden and refused |

Known limits, stated plainly:

- There is no end-to-end deadline for connecting to the database or for
  taking a connection from the pool. The approved statement timeout bounds a
  statement once it has started.
- The application cannot verify which migrations were applied: the web role
  cannot read the migration ledger.
- A replayed or stale confirmation form that does not name the checkout's
  current challenge is answered by the application without a database call,
  so the database neither counts nor audits it.
- Integration and browser behaviour, including keyboard operation, is
  untested: it needs an application with its own newly created database and
  browser tooling, which are a later, separately authorized step.
