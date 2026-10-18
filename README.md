# ShopAccess AI

Mock-only security foundation for an inclusive laptop-shopping assistant. The
catalog, seller, prices and payment states are simulated. The default local
demo contacts no payment provider, product API, or AI API, and by default no
database either: the application runs on in-memory stores unless PostgreSQL
mode is chosen explicitly (see below).

A separate opt-in advisory path has contacted Qwen through Synthorai. The
record is in `docs/security-foundation.md`, under "External advisory milestone
(Qwen)". Those runs kept persistence and payments on the in-memory mock. That
record includes QW-6, one successful Spanish guided-needs browser case. These
runs are not acceptance of the shop, the advisory path, or payments.

Product intent is recorded in `docs/product-governance.md` (October 12, 2026).
That record authorizes planning. It does not authorize a live call, a payment,
a deployment, or a database change, and it does not replace the evidence above.

## Run the demo locally

```bash
SHOPACCESS_SESSION_KEY="$(openssl rand -base64 32)" \
SHOPACCESS_TRUSTED_ORIGINS=http://localhost:3000 \
PAYMENT_PROVIDER_MODE=mock \
npm run dev
```

Open http://localhost:3000 in Chrome or Firefox. All three settings are
required; without them the shopping flow is switched off. State is held in
memory and is lost when the server stops.

### Optional: keep shopper state across a restart (local mock only)

Sessions, needs drafts, the guided conversation (language and the last eight
lines), confirmation withdrawal, and the session-allocation and admission
windows can be kept in one local snapshot file. Checkouts, quotes, payments
and the audit log stay in memory: a checkout started before a restart does not
resume. Use synthetic data only.

```bash
# One private key file and one new store directory, outside the repository.
umask 077
openssl rand -out /path/to/private/shopaccess-store.key 32
node --experimental-strip-types --import ./scripts/mock-store-load-hook.mjs \
  src/server/mock-store-init.mts --directory /path/to/private/shopaccess-store \
  --key-file /path/to/private/shopaccess-store.key

# Then add both settings to the command above.
SHOPACCESS_MOCK_STORE_DIR=/path/to/private/shopaccess-store \
SHOPACCESS_MOCK_STORE_KEY_FILE=/path/to/private/shopaccess-store.key \
...  npm run dev
```

With neither setting the demo is in memory, as before. With only one, or with
a directory or key file that is not private (0700 directory, 0600 key file
owned by you), or with `SHOPACCESS_PERSISTENCE_MODE=postgres`, the server
refuses to start the shop rather than falling back to memory. If a save fails,
the shop stops accepting changes and shows "not available" until it is
restarted. A request that was interrupted by a restart is never sent again: an
interpretation shows the existing "could not be interpreted" notice, and
suggestions show as not available, with how to ask again. Logs name the
storage mode and a code, never a path or key.

### Optional: the ShopAccess side panel (local mock only)

`SHOPACCESS_EXTENSION_ORIGINS` lists the exact extension origins allowed to use
`/api/extension/v1` (comma-separated `chrome-extension://<32 letters a–p>`).
Absent, every extension route is "not found"; a malformed value switches the
shop off (`EXTENSION_ORIGINS_INVALID`). The panel can read and continue the
conversation of the session that approved it, never confirm, check out or pay.
Grants are kept in the snapshot file as a keyed digest only. See
`extension/README.md`.

### Optional: PayPal Sandbox mode (owner-authorized runs only)

The checkout can use PayPal Sandbox instead of the simulated payment panel.
This contacts PayPal Sandbox, so it needs the project owner's separate
authorization. The procedure, budget, evidence and stop conditions are in
`docs/paypal-sandbox-rehearsal-runbook.md`. On October 18, 2026 one supervised
rehearsal on this source (`401556a`) ended with the app reporting a verified
USD 579.99 capture; the results and their limits are in section 13 of that
runbook. That is not acceptance of F07, F08, F11 or A35.

You need a PayPal developer account with a Sandbox REST app (client ID and
secret), the Sandbox business account's 13-character PayPal Merchant ID and a
Sandbox personal (buyer) account. Keep the values in a private file outside the
repository (never a `.env*` file inside it), and never print them:

```bash
PAYMENT_PROVIDER_MODE=sandbox
PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com
PAYPAL_CLIENT_ID=<sandbox app client ID>
PAYPAL_CLIENT_SECRET=<sandbox app secret>
PAYPAL_SANDBOX_MERCHANT_ID=<13-character sandbox business merchant ID>
```

```bash
(
  set -a; . /path/to/private/paypal-sandbox.env; set +a
  SHOPACCESS_SESSION_KEY="$(openssl rand -base64 32)" \
  SHOPACCESS_TRUSTED_ORIGINS=http://127.0.0.1:3000 \
  exec npm run dev -- -H 127.0.0.1 -p 3000
)
```

Open http://127.0.0.1:3000.
- **Payment settings:** any other base URL, a `live` or `production` mode, or a
  missing or malformed setting switches the shop off. With
  `PAYMENT_PROVIDER_MODE=mock`, any `PAYPAL_*` setting is refused.
- **Other providers:** leave the `SHOPACCESS_AI_*` settings unset (local
  assistant). Channel3 stays disabled in source.
- **Storage:** Sandbox mode works with or without the local snapshot store,
  which keeps only sessions and permissions. PostgreSQL mode refuses it.
- **Payment steps:**
  - The shopper creates the order with **Continue to PayPal Sandbox**, then
    approves on `https://www.sandbox.paypal.com`.
  - Returning to the checkout only checks the approval; nothing is captured
    automatically.
  - The shopper captures with **Capture the approved payment**. Success is
    shown only after the capture evidence (order, amount, currency, payee and
    correlation ID) has been checked.
- **Restarts:** checkouts and payment records are held in memory, so the server
  must keep running for the whole journey.
- **Return address:** in the October 18 rehearsal, PayPal Sandbox returned the
  browser to the plain-HTTP `http://127.0.0.1:3000/checkout/<id>/return`
  address with the session intact. That is one observation in one Chrome
  profile, not a guarantee.

## PostgreSQL mode (opt-in; written, never run)

The application can be pointed at PostgreSQL instead of its in-memory stores.
This mode has been written and has **not been run**: it has not been compiled,
its tests have not been executed, and the application has never been started in
it. See `docs/postgresql/postgresql-specification-v2.0-draft.md`, section 19.19
for the contract and section 19.18 for what exists and what has run.

It is chosen only by setting `SHOPACCESS_PERSISTENCE_MODE=postgres`. With that
variable not set at all the application is the mock above, unchanged. Any other
value serves nothing. PostgreSQL mode never falls back to the mock.

PostgreSQL mode requires all of these and has no defaults:

| Setting | Meaning |
| --- | --- |
| `SHOPACCESS_DATABASE_URL` | Connection of the web role, `shopaccess_web`, and of no other role |
| `SHOPACCESS_SESSION_KEYS` | Session key ring, `version:base64key` entries separated by commas |
| `SHOPACCESS_NONCE_KEYS` | Confirmation nonce key ring, in the same form, sharing no key with the session ring |
| `SHOPACCESS_TRUSTED_ORIGINS` | As for the mock |
| `PAYMENT_PROVIDER_MODE` | Must be `mock`; no payment is taken in either mode |

What it does not do:

- It applies no migration and creates no database. The bootstrap file and the
  migrations must already have been applied by someone else, and an operator
  must have activated a session key and a nonce key. No command for that is
  provided here, and a retained test cluster is not an application database.
- It has no payment simulation. A checkout ends when the shopper confirms it.
- It does not start if the database is not ready: every page shows a "not
  available" notice and every route answers 503 until a readiness check of the
  connected role passes. The check is made when a request arrives, not when
  the process starts.
- It sets no end-to-end deadline for connecting to the database. The approved
  statement timeout bounds a statement once it has started, and nothing more.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

See `docs/security-foundation.md` for what is and is not active, and
`docs/implementation-report.md` for test evidence.
