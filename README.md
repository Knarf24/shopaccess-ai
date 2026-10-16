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
