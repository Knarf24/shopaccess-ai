# PayPal Sandbox rehearsal runbook

Prepared October 18, 2026 against merged `main` `401556aabfb52191917ff8bd92d90a0d1e72dd35`. This runbook authorizes nothing. A rehearsal needs the owner's separate, written authorization naming the source, the time window and the budget in section 6.

**Run status (October 18, 2026):** run twice on this source. Attempt 1 ended at the PayPal approval step when its window expired; attempt 2 (supervised) ended with the app reporting a verified capture. See section 13. Sections 1–12 are kept as written before the runs, except where a dated note says otherwise.

Product boundaries are unchanged: F07, F08, F11 and A35 are not accepted, and the October 24 target and the full scope stay as recorded.

## 1. What the source does (verified by reading it)

| Concern | Behaviour at `401556a` | Where |
| --- | --- | --- |
| Mode selection | `PAYMENT_PROVIDER_MODE=sandbox` with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE_URL` exactly `https://api-m.sandbox.paypal.com` and a 13-character `PAYPAL_SANDBOX_MERCHANT_ID`. `live` and `production` are refused. Any other base URL is refused. | `src/lib/payment/adapter-config.ts:32-53`, `src/server/config.ts:100-108` |
| Mock mode with provider settings | Refused (`MOCK_MODE_WITH_PROVIDER_SETTINGS`) when any `PAYPAL_*` variable is set, so the same shell must not be reused for a mock run. | `adapter-config.ts:39-41` |
| PostgreSQL | Refuses anything but mock. The rehearsal uses the in-memory application. | `adapter-config.ts:56-59`, `src/server/pg-runtime.ts:95-96` |
| AI | Local assistant when `SHOPACCESS_AI_MODEL_ID`, `SHOPACCESS_AI_ENDPOINT` and `SHOPACCESS_AI_API_KEY` are all unset. | `src/server/config.ts` (`parseAdvisoryConfig`) |
| Channel3 | Disabled in source: `CHANNEL3_LIVE_ACTIVATION = false`; no setting turns it on. | `src/lib/providers/channel3-discovery.ts:13` |
| Server-side PayPal calls | `POST /v1/oauth2/token`; `POST /v2/checkout/orders`; `GET /v2/checkout/orders/{id}`; `POST /v2/checkout/orders/{id}/capture`, all on the configured base URL, each with a 10-second timeout. Order and capture POSTs carry a stable `PayPal-Request-Id`. **Automatic resend:** if PayPal answers an order or capture POST (or an order GET) with HTTP 401, the adapter discards its access token, requests a new one and sends the **same request once more**: same URL, body and `PayPal-Request-Id`, with a new bearer token. A second 401, a 5xx or a timeout is "no response" and is not resent. A 5xx or timeout on the first send is not resent either. Any capture answer other than 200 or 201, including a 4xx refusal, is treated as an unknown outcome. Tokens are cached until 60 seconds before they expire. | `src/lib/providers/paypal-sandbox.ts:26, 176-188, 301, 325, 374-398, 400-429, 450-466, 513, 561-580` |
| Order contents | `intent: "CAPTURE"`, amount in USD from the server's quote, `payee.merchant_id` = the configured merchant, `custom_id` = `dmm_shopaccessdemo:<quoteId>`, `shipping_preference: NO_SHIPPING`, `user_action: CONTINUE`. `return_url` is `<origin>/checkout/<intentId>/return` and `cancel_url` is `<origin>/checkout/<intentId>/paypal-cancel`, where `<origin>` is the browser's `Origin` header and only if it is a trusted origin. | `paypal-sandbox.ts:255-284`, `src/server/handlers.ts:665-668, 693-696` |
| Browser approval page | Followed only if the order's `payer-action` (or `approve`) link is exactly `https://www.sandbox.paypal.com/checkoutnow?token=<orderId>`; anything else is refused. | `paypal-sandbox.ts:99-127` |
| Order creation | Only by the shopper's **Continue to PayPal Sandbox** button (POST `/checkout/:id/approve`, CSRF and origin guarded), only from `USER_CONFIRMED` with no permission refusal. One press makes one logical order. | `handlers.ts:685-705`, `src/components/SimulatedPaymentPanel.tsx` |
| Buyer return | GET `/checkout/:id/return` records the return and reads the order back from PayPal. **It never captures.** A `token` that does not match the saved order ID is refused. | `handlers.ts:707-730` |
| Capture | Only by the shopper's **Capture the approved payment** button (POST `/checkout/:id/capture`), only from `APPROVED_VERIFIED` with no permission refusal. The permission is saved as `executing` before the capture is sent. Success is shown only from verified evidence (`CAPTURED_VERIFIED`: matching order, amount, currency, payee and correlation ID). Nothing captures automatically. | `handlers.ts:811-831`, `src/lib/payment/orchestrator.ts:429-449` |
| Resend or reconcile | Not reachable in Sandbox mode: the simulation and reconcile route answers "not found". | `handlers.ts:638-639` |
| Cancel | Buyer cancel on PayPal returns to the read-only cancel-return page, whose wording and Cancel form follow the saved state. The checkout's own Cancel works only before any capture may have been sent. | `handlers.ts:787-846` |
| Checkout state | Checkouts, quotes, payment states, operations and the audit log are **in memory only** (`InMemoryCheckoutStore`, `InMemoryOperationLedger`, `InMemoryAuditLog`). A format-7 snapshot persists shopper state: session-allocation and admission windows, sessions, needs drafts, conversations, confirmation-selection markers, extension grants, purchase permissions, device profiles, profile-revision markers, and charger-track records. A permission may store the checkout id that ended it; that id is not the checkout. This unwired foundation writes no charger track. | `src/server/runtime.ts`, `PublishedBody` in `src/lib/session/snapshot-store.ts`, README |

## 2. Hosts

- **Server to PayPal (API):** `https://api-m.sandbox.paypal.com` only. This is the documented Sandbox base for the REST APIs and the token endpoint ([PayPal REST APIs](https://developer.paypal.com/api/rest/), [Orders API standard use case](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard)).
- **Browser to PayPal (approval):** `https://www.sandbox.paypal.com/checkoutnow?token=…`. This matches PayPal's sample `payer-action` link ([Orders API standard use case](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard)).
- **Owner setup only:** `https://developer.paypal.com` (dashboard, Apps & Credentials, Sandbox Accounts) and `https://www.sandbox.paypal.com` (Sandbox account sign-in).
- **Unresolved:**
  - PayPal's sign-in and approval pages may load assets or redirect through other PayPal hosts. Record every host shown in the address bar, and stop on any host that is not a PayPal Sandbox page.
  - No outbound allowlist is enforced by this source or by the runbook. Server egress is limited only by the code paths above.
  - *October 18 note:* in both attempts the browser's address bar after order creation showed `https://www.sandbox.paypal.com/pay?token=…` (PayPal's own onward redirect from the accepted `checkoutnow` link). No non-Sandbox host was seen in the automation tab's address bar. Server egress was not observed.

## 3. Local return and cancel URLs

The return and cancel URLs will be `http://127.0.0.1:3000/checkout/<id>/return` and `…/paypal-cancel`.
- PayPal's Orders documentation reviewed on October 18 does not say whether an `http` loopback `return_url` is accepted. Its examples use public HTTPS addresses. **This is unresolved.**
  - *October 18 note:* in attempt 2 (section 13), PayPal Sandbox created the order with this `http` loopback return URL and returned the browser to it, with the session cookie sent. One observation, one Chrome profile.
- If PayPal refuses to create the order, the checkout returns with "PayPal Sandbox did not confirm approval. No payment was captured." No capture can have been sent at that point. Stop there.
- Don't introduce a tunnel or a public binding. Changing the origin needs a separate decision.
- **History, not evidence for this source:** attempt nine (October 15, an older tree) ran the app over HTTPS on `https://127.0.0.1:3443`, behind a local TLS proxy with a private CA. There the browser returned from `www.sandbox.paypal.com/checkoutnow` to `https://127.0.0.1:3443/checkout/<id>/return`. That suggests PayPal Sandbox accepted an HTTPS loopback return then. A **plain-HTTP** loopback return had never been observed before October 18 (see the note above and section 13).
- **Session cookie.** It is `__Host-shopaccess_session`, with `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=…` (`src/lib/session/cookie.ts:8-16`). The checkout page, return and capture all need it.
  - **Observed:** in owner-operated and automated Chrome runs on `http://127.0.0.1:3000` (server runs 1–8, October 16–18), the cookie was set and sent on same-site requests. Sessions survived page loads, 303 redirects and CSRF-checked POSTs (for example run 7: permission create, checkout start, confirm, revoke, all on one session). So Chrome accepts this `Secure` cookie over plain HTTP on `127.0.0.1`.
  - **Not observed:** sending the cookie on a navigation that starts on another site and lands on `127.0.0.1`, which is the PayPal return. No run has done that.
  - **Expected, not established:** `SameSite=Lax` allows the cookie on a top-level cross-site GET navigation. Chrome's handling of this loopback address in that case, and any browser privacy setting or bounce-tracking protection, are unverified.
  - **Local cross-site preflight (section 12), October 18, run 10:** link, meta refresh and GET form from `http://localhost:3001` to `http://127.0.0.1:3000` all kept the same session. That covers local navigations only. PayPal's own return is still to be observed in the rehearsal.
  - **Original note:** run the mock-only cross-site cookie preflight in section 12. If the cookie is not sent, the return shows the start page instead of the checkout, and Sandbox authorization should not be requested until that is resolved. The cookie's security attributes stay as they are.

## 4. Prerequisites (owner)

1. **Authorization in writing:** names this source, one time window and the budget in section 6.
2. **PayPal developer account** at developer.paypal.com, using Sandbox only:
   - A **Sandbox REST app**. Apps & Credentials, Sandbox, gives its client ID and secret.
   - A **Sandbox business account** (the seller). Its **PayPal Merchant ID** is 13 characters, from Sandbox account details or, signed in to sandbox.paypal.com, Settings → Business information. The REST app must belong to this account, because the source rejects a capture whose payee differs.
   - A **Sandbox personal account** (the buyer), from Testing Tools → Sandbox Accounts ([Sandbox accounts](https://developer.paypal.com/api/rest/sandbox/accounts)).
   - No real cards, live credentials or personal PayPal accounts.
3. **A private credential file outside the repository and outside every worktree**, owner-only (`chmod 600`), never committed and never printed. The owner creates it in an editor and fills it in. Claude does not read, display or copy it. Placeholders only:

   ```bash
   PAYMENT_PROVIDER_MODE=sandbox
   PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com
   PAYPAL_CLIENT_ID=<sandbox app client ID>
   PAYPAL_CLIENT_SECRET=<sandbox app secret>
   PAYPAL_SANDBOX_MERCHANT_ID=<13-character sandbox business merchant ID>
   ```

   Don't put a `.env*` file in the repository: `next dev` loads those automatically.

   **Existing three-line file (October 14 tooling).** A private file from the earlier Sandbox attempts holds:
   - line 1: the merchant ID;
   - line 2: the client ID;
   - line 3: the client secret.

   It has no variable names, so it isn't sourced. Section 5 shows how to read it into the three variables without displaying the values. Don't copy or recreate it.
4. **Source identity:** the worktree is clean and contains no `.env*` file. The October 18 runs used a tree equal to `401556a` (`git rev-parse 'HEAD^{tree}' '401556aabfb52191917ff8bd92d90a0d1e72dd35^{tree}'`); that check stays the record of those runs. A new rehearsal names its own commit. For this foundation that commit is `a1120d6` on `feature/f03-charger-clarification-state` unless the owner names another one in writing.
5. **Previous server stopped, and port 3000 free:** stop any server already running this or another build. Then `lsof -nP -iTCP:3000 -sTCP:LISTEN` prints nothing. A different intended port is confirmed free the same way before that build starts.
6. **Mode settings:** these stay unset: `SHOPACCESS_AI_*`, `SHOPACCESS_ADVISORY_BUDGET_*`, `SHOPACCESS_PERSISTENCE_MODE`, `SHOPACCESS_DATABASE_URL`, `SHOPACCESS_DEMO_ADMISSION`, `SHOPACCESS_EXTENSION_ORIGINS`.
7. **Snapshot store:** leave every existing owner and rehearsal store untouched, including the store used on October 18. Those copies stay reserved for the builds that wrote them. This rehearsal uses memory mode, or a fresh disposable store initialized by `src/server/mock-store-init.mts` with a new key file, both outside the repository (the README initializer). Memory mode unsets `SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE` inside the launch subshell. A fresh store is selected only by setting those two names, after that unset, to the new directory and its new key. Do not point either name at an existing store, and do not take a working copy of one. The format-7 file persists the shopper state in the checkout-state row above. Checkouts, quotes, payment states, payment operations, and the audit log remain in memory. The October 18 words "snapshot store backed up first" in section 13 describe that earlier source. They are not the procedure for this format-7 build. Rolling the code back uses memory mode or a separate store compatible with that older build. Never restore an older backup over a store containing later writes. No supported format-7-to-6 downgrade is implemented. Any future migration or recovery of existing data requires a separate reviewed procedure.

   This runbook's source for a new rehearsal is the unwired PR #10 foundation unless the owner names another commit. PR #11 is the separate charger-conversation integration. It is not started or merged by this step, and it follows the same store rule because it contains this format-7 reader.

## 5. Start (owner runs it; values are never echoed)

Stop the previous server and confirm port 3000 is free before either command (section 4, step 5). Both commands are memory mode. After the credentials are read, each subshell unsets `SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE`, so an inherited value does not select a store. To keep shopper state across a restart, initialize a new disposable store with the README initializer and, after that unset, export only that new directory and its new key. Do not reuse an older directory.

```bash
cd /path/to/worktree
(
  set -a; . /path/to/private/paypal-sandbox.env; set +a
  unset SHOPACCESS_MOCK_STORE_DIR SHOPACCESS_MOCK_STORE_KEY_FILE
  SHOPACCESS_SESSION_KEY="$(openssl rand -base64 32)" \
  SHOPACCESS_TRUSTED_ORIGINS=http://127.0.0.1:3000 \
  NEXT_TELEMETRY_DISABLED=1 \
  exec npm run dev -- -H 127.0.0.1 -p 3000 2>&1 | tee /path/to/private/sandbox-rehearsal-server.log
)
```

Variant for the existing three-line file (no values displayed):

```bash
cd /path/to/worktree
(
  { IFS= read -r PAYPAL_SANDBOX_MERCHANT_ID; IFS= read -r PAYPAL_CLIENT_ID; IFS= read -r PAYPAL_CLIENT_SECRET; } < /path/to/private/values
  export PAYPAL_SANDBOX_MERCHANT_ID PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET
  export PAYMENT_PROVIDER_MODE=sandbox PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com
  unset SHOPACCESS_MOCK_STORE_DIR SHOPACCESS_MOCK_STORE_KEY_FILE
  SHOPACCESS_SESSION_KEY="$(openssl rand -base64 32)" \
  SHOPACCESS_TRUSTED_ORIGINS=http://127.0.0.1:3000 \
  NEXT_TELEMETRY_DISABLED=1 \
  exec npm run dev -- -H 127.0.0.1 -p 3000 2>&1 | tee /path/to/private/sandbox-rehearsal-server.log
)
```

- The subshell keeps the credentials out of the owner's interactive shell.
- Don't run commands that print the environment, such as `env`, `printenv` or `ps eww`, while it runs.
- `npm run dev` runs `next dev`, which sets `NODE_ENV=development`. The plain-HTTP loopback origin is accepted only in that case.
- **Mode check without values:** open `http://127.0.0.1:3000` and start a session. A confirmed checkout must show the heading "PayPal Sandbox checkout" and the button "Continue to PayPal Sandbox". A shop that is switched off, or the simulated payment panel, means the configuration wasn't accepted. Stop and change nothing in the code.

## 6. Proposed budget (owner approves before the run)

- **One quote:** one demo catalog laptop, quantity 1, USD, the amount the server shows on the confirmation summary. Record it before approval. The payee is the configured Sandbox merchant.
- **At most two order creations** (two presses of "Continue to PayPal Sandbox"). The second is allowed only after the first ended definitively without approval: buyer cancel, an expired quote, or PayPal refusing to create the order.
- **At most one capture press** ("Capture the approved payment"). The owner never presses it a second time and never starts a second capture by any other route. The source's automatic 401 resend remains possible within that one press; see the HTTP budget below.

**HTTP-request budget for owner approval.** These are maxima from the source; normally each press sends one request plus at most one token request.

| Shopper action | Token POSTs | PayPal requests | Same `PayPal-Request-Id` on the resend |
| --- | --- | --- | --- |
| Continue to PayPal Sandbox (per press, at most 2 presses) | ≤ 2 | ≤ 2 `POST /v2/checkout/orders` (second only after a 401) | yes; same body |
| Return from PayPal (per return) | ≤ 2 | ≤ 2 `GET /v2/checkout/orders/{id}` (second only after a 401) | GET, no request ID |
| Capture the approved payment (1 press) | ≤ 2 | ≤ 2 `POST /v2/checkout/orders/{id}/capture` (second only after a 401) | yes; same body `{}` |
| Cancel-return page, checkout page loads | 0 | 0 | — |

Total ceiling with two order presses, two returns and one capture press: 10 token POSTs and 10 PayPal API requests, of which at most 2 are capture POSTs, both carrying one capture `PayPal-Request-Id`. PayPal documents that a POST resent with the same `PayPal-Request-Id` returns the latest status of the earlier request rather than repeating it ([Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)). That page gives no Orders-specific retention period, so treat this as documented behaviour, not verified here.

**Proposed limits in application terms (not approved):**
- at most **two order-creation presses**: POSTs to `/checkout/:id/approve` that reach PayPal;
- at most **two return-handler requests** that reach PayPal: GETs to `/checkout/:id/return` while the order is still awaiting approval;
- **at most one capture press**: a POST to `/checkout/:id/capture`, allowing only the source's automatic 401 resend with the same `PayPal-Request-Id`.

**Reloads and repeated redirects**, from the handlers' own preconditions (`handlers.ts:685-831`, `orchestrator.ts:264-268, 309-314`):
- **Order creation.** "Continue to PayPal Sandbox" contacts PayPal only from `USER_CONFIRMED`. After an order exists, a resubmitted or repeated approve POST, for example the browser's "resubmit form?" prompt, is refused locally with no PayPal request. Count every approve POST in the server log anyway; a refused one costs no PayPal request.
- **Return.** Every GET to `/return` records the return, but reads the order from PayPal only while it is awaiting approval (`AWAITING_APPROVAL` or `APPROVAL_CHECK_PENDING`). Once approval is verified, reloading `/return` or going back to it makes no PayPal request. Each return that does read PayPal counts toward the two.
- **Capture.** Capture contacts PayPal only from `APPROVED_VERIFIED`. The state changes before the request is sent, so a second POST, whether a double click, a reload of the POST or a resubmission, is refused locally. The owner presses at most once and never again.
- **Page loads.** Every successful action ends with a redirect to an ordinary GET page, so reloading the checkout page, the cancel-return page or the result page sends nothing to PayPal.

**Stop when any of these happens:**
- the server log shows a third approve POST, or a third `/return` request while the order may still be awaiting approval;
- any second capture POST;
- the browser bounces between PayPal and the app more than once for one approval (a redirect loop);
- the app redirects to `/` (session lost);
- a page asks to resubmit a form on any payment step: answer "Cancel", not "Continue".

The server log records only browser requests to the app, not outbound PayPal requests. The count of PayPal requests is therefore not observable from this source without code changes; the owner can compare the PayPal Sandbox dashboard afterwards.

## 7. Operations (owner in Chrome; one step at a time)

1. Start a fresh session on `http://127.0.0.1:3000`, give needs, and get a recommendation.
2. Create a purchase permission for that exact item at `/shop/permissions`. Purchases need one (F07).
3. Start the checkout, review it and confirm the summary. The state is `USER_CONFIRMED`. Note the amount.
4. Press **Continue to PayPal Sandbox** once. This is order creation 1. The browser should go to `https://www.sandbox.paypal.com/checkoutnow?token=…`.
5. Sign in as the **Sandbox buyer** on PayPal's page. Owner only: credentials go into PayPal's page, never into chat. Approve and continue.
6. The browser returns to `http://127.0.0.1:3000/checkout/<id>/return` and then the checkout page. It should say "PayPal Sandbox confirmed approval of this order. No payment has been captured." The return does not capture.
7. Press **Capture the approved payment** at most once. Inside that press, the source may resend the same capture request once after a 401, with the same `PayPal-Request-Id`. There is no other capture request.
8. The result page should show "The payment was captured and the capture evidence was checked." (`notice=CAPTURED`).
9. Shut down as in section 9.

Don't restart the server, reload the store or change settings between steps 3 and 8. Checkout state is in memory only, so a restart loses the checkout and any record of an order or capture already sent.

Proceed promptly:
- a quote lasts 15 minutes from checkout start (`src/lib/quote/quote.ts:15`);
- a prepared confirmation must be submitted within 5 minutes (`src/lib/confirmation/confirmation.ts:11`);
- the purchase permission must still be live at capture, so choose "In 1 hour";
- an idle session ends after 2 hours.

## 8. Evidence (credential-free)

Record, in a private evidence folder outside Git:
- **Source identity:** commit, tree hash and clean status; start and stop times in UTC.
- **Server log:** request lines only. The log contains no tokens or secrets from this source, but it does contain PayPal order IDs in return URLs, so keep it private.
- **Screenshots:**
  - confirmation summary with the amount;
  - the PayPal approval page with its address bar host;
  - the return page;
  - the capture result page.

  No PayPal sign-in fields.
- **Every host** seen in the address bar.
- **PayPal Sandbox dashboard,** owner-observed and reported:
  - the order and capture status;
  - amount and currency;
  - payee (business account);
  - the `custom_id` (`dmm_shopaccessdemo:<quoteId>`), if the dashboard shows it.
- **Anything not captured,** stated as "not captured".

There's no credential-free export of the in-memory payment ledger or audit log in this source. Page text and the server log are the application-side evidence. No code is added for this run.

## 9. Shutdown

1. Stop the server with Ctrl-C in its terminal. Confirm `lsof -nP -iTCP:3000 -sTCP:LISTEN` prints nothing and no `next dev` process remains. Stopping the server does not authorize restoring a store backup, or pointing the next build at a store this process used.
2. Close the test tab.
3. Leave the credential file in place, private. Rotate or delete the Sandbox app secret afterwards if the owner wishes.
4. Record the end time and the outcome: completed, stopped (with the condition), or uncertain.
5. *Added October 18 after attempt 1 ran past its cutoff:* arm an automatic local shutdown before any PayPal call. A watchdog bound to the server's process group warns five minutes before the cutoff (log and desktop notification) and stops the process group at the cutoff (TERM, then KILL after 10 s), then reports any remaining listener on port 3000. It makes no network request and exits on its own if the server was already stopped. Test it once on a dummy process group first. If it cannot be armed, don't make PayPal calls. The script is kept with the private run evidence, not in Git.

## 10. Stop conditions (stop, record, and don't retry without new approval)

- **Startup:** not in Sandbox mode, or any credential value printed anywhere.
- **Destination:**
  - any non-Sandbox PayPal host;
  - any `api-m.paypal.com` or other live-mode indication;
  - any request to an AI or Channel3 provider.
- **Content:** an amount, currency, payee or correlation mismatch on the approval page or the result.
- **Uncertain capture.** Any result after the capture press other than "The payment was captured and the capture evidence was checked." Examples:
  - "The payment outcome is unknown. Nothing here confirms that a payment was captured.";
  - "We could not confirm whether the payment went through, and it cannot be retried from here…";
  - the "Payment status not confirmed" page with a Reference;
  - no message at all.

  Then:
  - make **no new capture attempt** and no blind retry;
  - don't restart the server while the outcome is open;
  - record the reference ID shown and the time;
  - leave the session as it is, then stop the server only after recording.

  Reconciliation of that order is a separate, separately authorized step: a dashboard read by the owner, or a later reconcile run.
- **Order creation unknown** (the checkout shows "The payment outcome is unknown…" before any approval): no second order. Its outcome is recorded for separate reconciliation. A definitive refusal ("PayPal Sandbox did not confirm approval…") allows the second order only within the budget.
- **Session:** expiry, an unexpected page, or a refusal not described here.
- **Budget:** two order presses, two PayPal-reaching returns, or the capture press already used. Any outcome of the capture press other than verified success, including a 4xx answer that the source treats as unknown, ends the run with no further capture.

## 11. Related records

- Accessibility: in the owner-operated VoiceOver run 8 (October 18), the Spanish permission-creation announcement was **owner-reported but uncorroborated**: that run's server log has no create request. It isn't counted as verified, and this runbook does not change that record.
- Historical Sandbox attempt nine (October 15, older tree): `CAPTURED_VERIFIED`, overall exit 6, acceptance not met. It isn't evidence for this source.

## 12. Mock-only cross-site cookie preflight (approved October 18; completed in run 10)

**Result, October 18, server run 10 (13:12:55–13:13:52Z), mock only.** A second origin, `http://localhost:3001`, served the static test pages, bound to 127.0.0.1 only and approved by the owner. Each case started there and landed on the app's review page:
- (a) link: **pass**;
- (b) meta refresh: **pass**;
- (c) GET form: **pass**.

Each landing page had `document.referrer` `http://localhost:3001/`, showed the session-only create form, and carried the same session as the same-site baseline: the CSRF hash prefix matched, with no cookie or token values read.
- **Session:** it was not fresh; an existing valid one was used.
- **Interference:** none.
- **Scope:** these local navigations only, not PayPal's return.

**Earlier attempt (run 9)**

**Result of the attempt, October 18, server run 9 (13:08:24–13:09:37Z), mock only:**
- The browser automation tool refuses `file://` addresses, so the local-file link, meta-refresh and GET-form cases were **not run**. Nothing about cross-site cookie sending was established.
- A same-site baseline on `http://127.0.0.1:3000` did show a session-bearing review page.
- **Next options, needing the owner's decision:**
  - (1) the owner opens the local file and clicks each case by hand, while the landing pages are checked;
  - (2) a separately approved second local origin, `http://localhost:3001`, which is a different site from `127.0.0.1`, serving the same static pages, bound to 127.0.0.1 only.

**Original proposal, unchanged:**

Purpose: to check, before any Sandbox authorization, that Chrome sends the session cookie on a navigation that starts on another site and lands on `http://127.0.0.1:3000`, as PayPal's return does. It uses no PayPal, no credentials, no tunnel and no public binding.

Setup:
- The existing mock recipe: `PAYMENT_PROVIDER_MODE=mock`, 127.0.0.1:3000, no provider keys.
- The owner's normal Chrome profile, with its current privacy settings recorded. The rehearsal will use the same profile.

Steps:
1. Start a fresh session; open `/shop/permissions?lang=en`. It shows the form, which needs a session.
2. Open a local file, for example `file:///…/xsite-preflight.html`, kept outside the repository. A `file:` page is a different site from `http://127.0.0.1:3000`. It contains:
   - (a) a plain link to `http://127.0.0.1:3000/shop/permissions?lang=en`;
   - (b) a page that redirects there with `<meta http-equiv="refresh">`;
   - (c) a GET form whose action is that address.
3. For each of (a)–(c), record whether the landing page shows the permission form (cookie sent) or "Open the shop first" (cookie not sent). Optionally, record in DevTools → Network whether the request carried the `__Host-shopaccess_session` cookie, without copying its value.
4. Stop the server, confirm port 3000 is free, and delete nothing but the local file.

Interpretation:
- Pass if all three keep the session. This is evidence for a cross-site top-level GET from a `file:` page, not proof for PayPal's own redirect, which is checked again at step 6 of the rehearsal.
- If any variant loses the session, record it and stop. No cookie change or tunnel is made without a separate decision.

## 13. Results, October 18, 2026

Both attempts ran on source `401556a` (worktree `f614006`, identical application tree `1f2b49e1bb26e13ce475069f78d0369ae9acf75b`; only this runbook and the README differed, uncommitted). Setup each time: Sandbox mode on `http://127.0.0.1:3000`, local assistant (no AI keys), Channel3 disabled, snapshot store backed up first, no database, no tunnel, credentials read from the private file and absent from the server logs. Detailed records, logs and checksums are private evidence outside Git; account identifiers, order and payer IDs are not reproduced here.

*October 21 note:* "snapshot store backed up first" records the October 18 source. A format-7 build does not copy or reopen that store. Section 4, step 7 is the current rule.

**Attempt 1 (window 10:30–11:30 EDT) — incomplete, kept as history.**
- Observed: one order-creation press (10:33:45 EDT); the server redirected the browser to the PayPal Sandbox sign-in page. No return request and no capture request reached the app.
- The window expired without approval being returned. The server kept running past the 11:30 cutoff, until 13:48:59 EDT, with no payment action logged or reported in that time. This led to the automatic shutdown in section 9, step 5.
- PayPal's final state of that order is unknown; it was not queried and was not reused.

**Attempt 2 (supervised; window 13:51:46–14:21:46 EDT) — app-reported success.**
- *Observed actions* (server request log and automation): a fresh permission (Acer Aspire Go 15, 8 GB / 256 GB, quantity 1, maximum USD 579.99, one hour), a fresh quote and checkout, and the confirmation; then exactly **one order-creation press** (13:53:51 EDT), **one return request** (after the owner signed in and approved on PayPal Sandbox; owner-reported approval, owner checked USD 579.99), and **one capture press** (14:05:11 EDT). No retry, reconcile or cancel request.
- *App-reported results:* after the return, "PayPal Sandbox confirmed approval of this order. No payment has been captured."; after the capture, "The payment was captured and the capture evidence was checked." (the app's `CAPTURED_VERIFIED`, which requires matching order, amount USD 579.99, currency, payee and correlation ID). The permission then showed "Used".
- *Source-derived ceilings, not observed counts:* by the source in section 1, the three requests account for at most token + create order, token + order read, and token + capture POST, plus at most one automatic resend each after an HTTP 401. Actual outbound requests to PayPal, and whether any 401 resend happened, were not observed or logged.
- *Not corroborated:* the PayPal Sandbox dashboard was not read and the capture ID was not recorded. The app's payment records were in memory and ended with the server.
- *Other observations:* PayPal's sign-in page showed "Something went wrong. Try again later." before the owner signed in (cause unknown); two read-only permissions-page loads, not from the automation, appeared in the log (origin unknown).
- *Shutdown:* the automatic-shutdown watchdog was tested on a dummy process group and armed before any PayPal call. The server was stopped by hand at 14:05:41 EDT, 16 minutes before the cutoff; the watchdog then exited; port 3000 was free.

**Limits that remain.** One supervised run, one Chrome profile, one buyer account, on the local plain-HTTP loopback. It does not show repeatability, PayPal-side records, behaviour on other browsers or hosted origins, or any outcome other than success (decline, buyer cancel, unknown capture). F07, F08, F11 and A35 remain unaccepted; M2-2 finding 3 is still required before any non-local use.
