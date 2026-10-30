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

**Judges:** the hosted demonstration, the suggested journey and what is live or simulated are in
[`docs/judges.md`](docs/judges.md). The project is released under the [MIT License](LICENSE).

## MVP status and limitations

What works in this build (covered by the automated tests; the website journey below was also driven end to end over
HTTP on a production build):

- **Conversational shopping.** The shopper describes a need in the guided conversation (typed, or dictated through the
  browser's speech services). The assistant asks follow-up questions, shows its understanding, and nothing counts until
  the shopper confirms it. English and Spanish, with an explicit language switch.
- **Recommendations from a fixed demo catalog** (three laptops). Budget, memory, storage and weight are checked by the
  server; a card says why a laptop is or is not eligible.
- **AI uncertainty is disclosed, never guessed.** When a request involves AI work, the assistant asks whether the
  models run on the laptop or in the cloud. Every card then states "AI compatibility: not verified" unless the catalog
  has the evidence, and a laptop that has not been verified for that workload is not marked Recommended.
- **Purchase permissions.** Checkout is refused (nothing is charged) until the shopper creates a permission for that
  exact item, limited by quantity, total and expiry. A permission can be revoked.
- **Server-priced checkout.** The total is calculated by the server and confirmed explicitly. The default payment step
  is a local simulation that ends in a verified simulated result. A PayPal Sandbox mode exists for owner-authorized
  runs only.
- **Chrome side panel** (`extension/`, unpacked, Manifest V3). After the shopper approves a pairing code on the
  website, the panel can read and continue the same conversation. It cannot confirm, check out or pay.

Limits you should know about:

- Catalog, sellers, prices, stock and payments are simulated. Nothing is shipped and no real money moves.
- By default everything is held in memory and a restart clears it. A local snapshot file store is optional (below).
  Snapshot format 10 and the offline conversion tool (`src/server/mock-store-migrate.mts`) are inactive unless an
  operator runs them by hand; nothing activates them on its own.
- The AI is a local assistant unless a live provider is configured. Its output is advisory. The server enforces
  catalog identity, suitability, budget and every purchase rule.
- Voice input and read-aloud use the browser's speech services, which may send audio to them. Real-microphone,
  screen-reader and native-speaker acceptance is not complete.
- The side panel is a developer extension. Against a hosted service it works only if that service allows the panel's
  Chrome extension ID (`SHOPACCESS_EXTENSION_ORIGINS`), and an unpacked extension's ID depends on where it was loaded
  from. See `extension/README.md`.
- The charger purchase journey exists only in a test-only runtime (`docs/charger-purchase-test-store.md`).
- PostgreSQL mode is opt-in and does not include the guided journey, purchase permissions or payment simulation (see
  below).

Product intent is recorded in `docs/product-governance.md` (October 12, 2026).
That record authorizes planning. It does not authorize a live call, a payment,
a deployment, or a database change, and it does not replace the evidence above.

## Run the demo locally

This build runs the guided needs journey, including the charger conversation
(task choice, model selection, confirmation and Change as server-rendered
controls bound to the draft revision), purchase permissions, the side-panel
API and the AI-workload safeguards. The format-7 reader can still load
formats 1–6. The next successful commit, including startup recovery, rewrites
that file as format 7. The default snapshot format stays 7. Any build that
contains this format-7 reader follows the store rule below.

Existing owner and rehearsal stores remain untouched and reserved for their
current builds. Format-7 development uses memory mode, as in the command
below, or a fresh disposable store initialized by `src/server/mock-store-init.mts`.
Never point the new build at an existing store. Stop the previous server
before starting another build, and confirm the intended port is free. For
this command, `lsof -nP -iTCP:3000 -sTCP:LISTEN` prints nothing. Rolling the
code back must use memory mode or a separate store compatible with that older
build. Never restore an older backup over a store containing later writes. No
supported format-7-to-6 downgrade is implemented. Any future migration or
recovery of existing data requires a separate reviewed procedure.

```bash
(
  unset SHOPACCESS_MOCK_STORE_DIR SHOPACCESS_MOCK_STORE_KEY_FILE
  SHOPACCESS_SESSION_KEY="$(openssl rand -base64 32)" \
  SHOPACCESS_TRUSTED_ORIGINS=http://localhost:3000 \
  PAYMENT_PROVIDER_MODE=mock \
  exec npm run dev
)
```

Open http://localhost:3000 in Chrome or Firefox. All three settings are
required; without them the shopping flow is switched off. State is held in
memory and is lost when the server stops. The subshell unsets
`SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE` before the
server starts, so an inherited value does not select a store.

### Optional: keep shopper state across a restart (local mock only)

A format-7 snapshot persists shopper state: the session-allocation and
admission windows, sessions, needs drafts, the guided conversation (language
and the last eight lines), confirmation-selection markers, extension grants,
purchase permissions, device profiles, profile-revision markers, and
charger-track records. A charger-track record is written when the shopper uses
the charger conversation. A purchase permission may store the
checkout id that ended it. That id is not the checkout. Checkouts, quotes,
payment states, payment operations, and the audit log remain in memory, so a
checkout started before a restart does not resume. Use synthetic data only.
Snapshot format 10 (durable AI workload records) is opt-in and is not activated by default: it is read only with the
exact setting `SHOPACCESS_WORKLOAD_RECORDS=1` against a store that is already format 10. The only way to convert an
older store is the explicit offline tool, which needs a stopped server, a verified backup and the original key kept
separately. No real store is converted automatically. See
[docs/workload-record-snapshot-format.md](docs/workload-record-snapshot-format.md).
The directory must be new. The initializer below is the supported way to
create it. Do not pass an existing owner or rehearsal store as `--directory`
or as `SHOPACCESS_MOCK_STORE_DIR`.

```bash
# One private key file and one new store directory, outside the repository.
# Stop the previous server and confirm the intended port is free first.
umask 077
openssl rand -out /path/to/private/shopaccess-store.key 32
node --experimental-strip-types --import ./scripts/mock-store-load-hook.mjs \
  src/server/mock-store-init.mts --directory /path/to/private/shopaccess-store \
  --key-file /path/to/private/shopaccess-store.key

# Then start with only that new directory and its new key.
(
  unset SHOPACCESS_MOCK_STORE_DIR SHOPACCESS_MOCK_STORE_KEY_FILE
  export SHOPACCESS_MOCK_STORE_DIR=/path/to/private/shopaccess-store
  export SHOPACCESS_MOCK_STORE_KEY_FILE=/path/to/private/shopaccess-store.key
  SHOPACCESS_SESSION_KEY="$(openssl rand -base64 32)" \
  SHOPACCESS_TRUSTED_ORIGINS=http://localhost:3000 \
  PAYMENT_PROVIDER_MODE=mock \
  exec npm run dev
)
```

The server uses memory when both store variables are absent from its
environment. The memory-mode command under "Run the demo locally" unsets both
names in its subshell. The command in this section unsets them and then
exports only the new directory and its new key. With only one of those names
set, or with a directory or key file that is not private (0700 directory,
0600 key file owned by you), or with `SHOPACCESS_PERSISTENCE_MODE=postgres`,
the server refuses to start the shop rather than falling back to memory. If a save fails,
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

Stop the previous server and confirm port 3000 is free. This command is memory
mode: after the private file is read, the subshell unsets
`SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE`. A disposable
snapshot store, when one is used, comes only from the initializer above, and
those two names are then set to that new directory and its new key.

```bash
(
  set -a; . /path/to/private/paypal-sandbox.env; set +a
  unset SHOPACCESS_MOCK_STORE_DIR SHOPACCESS_MOCK_STORE_KEY_FILE
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
  assistant). Leave `CHANNEL3_DISCOVERY` and `CHANNEL3_API_KEY` unset (external
  listings answer "turned off"); setting both enables live Channel3 requests.
- **Storage:** Sandbox mode uses the memory-mode subshell above, or a fresh
  disposable snapshot store created for that run with the initializer above.
  The format-7 file persists the shopper state listed in the snapshot section.
  Checkouts, quotes, payment states, payment operations, and the audit log
  remain in memory. Do not point Sandbox mode at an existing owner or
  rehearsal store. PostgreSQL mode refuses Sandbox mode.
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
The application mode has **not been run**: the application has never been
started against a database in it. Its SQL (the bootstrap file and migrations
for Increments 1, 2.1 and 2.2) has run only on disposable test clusters. See
`docs/postgresql/postgresql-specification-v2.0-draft.md`, section 19.19 for the
contract and section 19.18 for what exists and what has run. This mode has no
guided needs journey, purchase permissions, device profiles or extension API.

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

Run them from a clean checkout. A `.env*` file in the working directory makes
the environment-security tests fail by design.

See `docs/security-foundation.md` for what is and is not active, and
`docs/implementation-report.md` for test evidence.
