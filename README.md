# ShopAccess AI

Mock-only security foundation for an inclusive laptop-shopping assistant. The
catalog, seller, prices and payment states are simulated. No payment provider,
product API, AI API or database is contacted.

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

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

See `docs/security-foundation.md` for what is and is not active, and
`docs/implementation-report.md` for test evidence.
