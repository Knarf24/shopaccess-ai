# E1 local shared-session prototype

Synthetic website plus unpacked Chrome MV3 side panel. It is separate from the ShopAccess application and cannot shop or pay. No dependencies need installation. Tested with Node 24.19.0; application pin 24.21.0 has not been exercised here.

## Start on your computer

1. Check out the feature branch in a separate checkout/worktree; preserve unrelated work. Do not merge this prototype into the application as accepted functionality.
2. In Chrome, open `chrome://extensions`, enable Developer mode, select Load unpacked, and choose this folder's `extension` directory. Copy its extension ID.
3. From the repository root run the following, replacing YOUR_EXTENSION_ID with that exact ID:

```sh
mkdir -m 700 /tmp/shopaccess-e1-data
node experiments/e1-shared-session/server.mjs 3764 /tmp/shopaccess-e1-data chrome-extension://YOUR_EXTENSION_ID
```

Use a new private data directory if that name already exists. Port 3764 must be free. For the side panel, keep port 3764; tests alone use random ports. No .env file is read. The standalone server does not import application runtime or any provider. Do not supply real credentials or personal information. Use an empty environment if your operating procedure requires one.

4. Open `http://127.0.0.1:3764`. Use synthetic messages such as `schoolwork budget 900`. Pin/click the extension icon to open its panel, then select Pair with website.
5. Review the conversation-only permission on the website and approve. Polling occurs every ten seconds, at most ten polls. If it expires, start again. Pairing itself expires after five minutes. The panel shows its extension origin for comparison with the server argument.

Do not post the exchange secret, verifier, bearer, website cookie or CSRF value in reports. The pairing ID in the approval URL is public; approval still requires the synthetic website session and CSRF check. This is not the real demo-admission flow.

## Browser acceptance still required

- Send a turn on each surface; refresh the other surface and see the same history.
- Change EN/ES; the side panel localizes its controls and mock reply. The website uses bilingual fixture labels. This is not production translation acceptance or Spanish intent interpretation.
- Concurrent edits must show a stale-revision error, refresh current state and preserve unsent text. No automatic retry.
- Repeated submit while pending must send one command.
- Revoke access from the website and verify the panel is refused. Forget local pairing clears local credentials; it does not substitute for server revocation.
- Stop with Ctrl+C, restart using the same data directory and port, then re-pair. Website history survives; child tokens do not. Browser restart also clears extension session-storage credentials.
- Test keyboard focus, status visibility and screen-reader announcements in the real panel. No such acceptance was recorded here.

The browser available to the implementer could not reach its loopback server (ERR_CONNECTION_REFUSED). That is an environment boundary; do not treat the Node tests as an installed-extension demonstration.

## Checks

```sh
node --test experiments/e1-shared-session/tests/authority.test.mjs experiments/e1-shared-session/tests/conversation.test.mjs experiments/e1-shared-session/tests/persistence.test.mjs experiments/e1-shared-session/tests/extension.test.mjs
node --test experiments/e1-shared-session/tests/server.test.mjs experiments/e1-shared-session/tests/review-regressions.test.mjs
```

The second command opens loopback sockets and is not a no-TCP run. The first uses built-ins, temporary files and injected callbacks; the manifest/client checks do not install Chrome. The complete prototype suite is `node --test experiments/e1-shared-session/tests/*.test.mjs`.

## Failure and storage boundaries

Conversation state is synthetic JSON in a private directory, file mode 0600. This is not the real authenticated/encrypted snapshot store. The private cookie signing key is separate. Website cookie timestamps bind original absolute lifetime and idle limit across restart. These credentials are not spending grants.

If publication may have occurred but directory synchronization fails, the server returns PERSISTENCE_OUTCOME_UNKNOWN and refuses subsequent commands until restart. Do not resubmit automatically. Reload after restart to inspect the actual synthetic state. Snapshots above 8 MiB are refused before publication.

Only one server may use a data directory. A crashed process may leave server.lock; verify that the original owned process is gone before removing only that stale lock. Never delete a lock for a live server. Ctrl+C removes the owned lock after closing the server. A startup port conflict fails rather than switching ports.

## Not implemented by E1

Real ShopAccess session integration, real device profiles, store permissions, AI tool loop, voice, discovery, purchasing and payment. The requirement extractor recognizes only explicit English fixture tokens. There is no purchase confirmation endpoint and no demonstration of withdrawing a previously confirmed real purchase. The existing application, payment safeguards and historical records are untouched.
