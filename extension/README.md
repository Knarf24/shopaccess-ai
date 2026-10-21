# ShopAccess side panel (M2-2)

An unpacked Chrome MV3 side panel that reads and continues the shopping conversation of one paired website session.
It cannot confirm a purchase, start a checkout or pay; its grant has no such scope. Promoted from the E1 prototype
(`experiments/e1-shared-session/` on `design/shared-session-e1-20261016`, `274866d`), which stays the historical record.
Mock mode only. Use synthetic data only.

## Load it locally

1. In Chrome, open `chrome://extensions`, turn on Developer mode, select **Load unpacked** and choose this `extension`
   directory. The panel also shows its own origin under **Connection**.
2. Start the demo with that exact origin allowed, bound to loopback:

   ```bash
   (
     unset SHOPACCESS_MOCK_STORE_DIR SHOPACCESS_MOCK_STORE_KEY_FILE
     SHOPACCESS_SESSION_KEY="$(openssl rand -base64 32)" \
     SHOPACCESS_TRUSTED_ORIGINS=http://127.0.0.1:3000 \
     SHOPACCESS_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID \
     PAYMENT_PROVIDER_MODE=mock \
     exec npm run dev -- --hostname 127.0.0.1 --port 3000
   )
   ```

   Stop any previous server first and confirm port 3000 is free. This command is memory mode: the subshell unsets `SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE` before the server starts. Do not point either name at an existing store. The format-7 rule for PR #10, and its separation from the PR #11 integration, is in the repository README.

3. Open `http://127.0.0.1:3000`, start a needs conversation, then open the side panel from the toolbar.
4. The panel's address defaults to `http://127.0.0.1:3000`. Change it under **Connection** if needed: loopback HTTP
   with a port, or an HTTPS origin, no path. Saving asks Chrome for host access to that one origin; requests also work
   by CORS without it.
5. Select **Pair with website**. A website tab opens at `/extension/pair`; approve conversation-only access there.
   The panel checks up to ten times within the five-minute pairing (first after 5 seconds).

## What it stores

- `chrome.storage.local`: the app address and a random installation ID. Re-pairing the same installation replaces its
  earlier grant on the server.
- `chrome.storage.session`: the bearer and any pairing in progress. Chrome clears these when the browser closes.
- **Forget local pairing** removes only the local credential. To end server access, use **Revoke** under
  *Paired access* on the website's needs page. Logging out of demo admission revokes every grant of that session.

Never paste the exchange secret, verifier, bearer, cookies or CSRF values into reports. The pairing ID in the approval
address is public; approval still needs the website session, admission (when on) and the CSRF check.

## Limits

- The panel shows the draft's language and does not switch it (D-M22-4).
- Messages from the panel and the website share one limit: 20 per minute per session.
- Grants end after one hour, at the session's absolute expiry, at the admission cookie's expiry when admission is on,
  when the session goes idle, or on revoke. At most three active grants per session.
- Tests: `tests/unit/extension-client.test.ts` drives `client.mjs` against the real handlers in memory. Installed-panel
  behaviour, keyboard use and screen-reader speech need a real browser check.
