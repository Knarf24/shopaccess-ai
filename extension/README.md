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

   Stop any previous server first and confirm port 3000 is free. This command is memory mode: the subshell unsets `SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE` before the server starts. Do not point either name at an existing store. The format-7 store rule for this wired checkout is in the repository README.

3. Open `http://127.0.0.1:3000`, start a needs conversation, then open the side panel from the toolbar.
4. The panel's address defaults to `http://127.0.0.1:3000`. Change it under **Connection** if needed: loopback HTTP
   with a port, or an HTTPS origin, no path. Saving asks Chrome for host access to that one origin; requests also work
   by CORS without it. Every request, including the conversation read (a POST since 0.4.0), carries the extension's
   Origin. The server refuses any extension request without an allowed Origin and checks each token against the
   extension that paired it.
5. Select **Pair with website**. The panel shows a six-digit **pairing code**, and a website tab opens at
   `/extension/pair`. Type that code on the approval page and select **Allow conversation access**. The panel checks up
   to ten times within the five-minute pairing (first after 5 seconds).
   - Enter only the code from your own ShopAccess side panel. If you did not just start pairing in your own panel, or
     someone else sent you the approval page or a code, select **Deny** (Deny needs no code).
   - Five incorrect codes cancel the pairing; start again from the panel. The code expires with the pairing.
   - The code is kept only in `chrome.storage.session` while the pairing is pending, and is never sent back by the panel.
     This makes it harder for another program to obtain approval with a pairing it started, but it does not prevent every
     form of phishing: never type a code someone else gives you.

## What it stores

- `chrome.storage.local`: the app address and a random installation ID. Re-pairing the same installation replaces its
  earlier grant on the server.
- `chrome.storage.session`: the bearer and any pairing in progress. Chrome clears these when the browser closes.
- **Forget local pairing** removes only the local credential. To end server access, use **Revoke** under
  *Paired access* on the website's needs page. Logging out of demo admission revokes every grant of that session.

Never paste the exchange secret, verifier, pairing code, bearer, cookies or CSRF values into reports. The pairing ID in
the approval address is public; approval still needs the website session, admission (when on), the CSRF check and the
pairing code from the panel that started the pairing.

## Limits

- The panel shows the draft's language and does not switch it (D-M22-4).
- Messages from the panel and the website share one limit: 20 per minute per session.
- Grants end after one hour, at the session's absolute expiry, at the admission cookie's expiry when admission is on,
  when the session goes idle, or on revoke. At most three active grants per session.
- Tests: `tests/unit/extension-client.test.ts` drives `client.mjs` against the real handlers in memory. Installed-panel
  behaviour, keyboard use and screen-reader speech need a real browser check.
