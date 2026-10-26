# ShopAccess AI — guide for judges

ShopAccess AI helps a first-time buyer choose a laptop in English or Spanish. It explains the evidence behind each suggestion and requires a purchase permission before checkout.

## Open the demonstration

1. Go to **https://shopaccess-ai.onrender.com**.
2. Choose English or Español, select **Continue**, then enter the **passphrase** from the private judge notes of the submission. It is not in this repository.
   - Admission lasts 8 hours in that browser.
   - Wrong passphrases are limited for the whole service, five per 15 minutes. If you see "Too many attempts", wait 15 minutes. Correct passphrases do not count toward this limit.
3. **Sessions follow cookies.** Ordinary windows and tabs of the same browser profile share cookies, so they share one shopping session. For separate sessions, for example to compare two journeys side by side, use separate browser profiles, which have separate cookie stores. An idle session ends after 2 hours.
4. **Restarts clear shopping state.** A restart of the service clears sessions, needs drafts, purchase permissions and checkouts. Your admission cookie can stay valid until it expires, so you may not be asked for the passphrase again, but you start a new journey.

## Suggested journey (about 5 minutes)

1. **Describe your needs.** Type what you need, or pick a use (for example *Schoolwork*) and a whole-dollar budget (for example *600*). Select **Submit what I need**.
   - Typed text is sent to the AI provider shown on the page (Synthorai). The use and budget controls send nothing typed.
2. **Review the understood need.** Correct the use or budget if needed, then select **Confirm this use and budget**.
3. **Suggestions.**
   - The demo catalog is checked against price, stock, memory, storage and weight rules. Each card shows why it is or is not eligible.
   - A label states whether the suggestion came from the configured AI model or from the local demo assistant.
   - The live AI has per-session, hourly and daily limits. After a limit, the labelled local assistant answers instead.
4. **External listings (optional).**
   - **Search external listings** asks Channel3 for real products within your confirmed budget.
   - The page shows a price only when Channel3 reports exactly one in-stock US-dollar offer within the budget.
   - Links are Channel3 affiliate links to the seller's website. ShopAccess cannot check them out.
   - Searches are limited per session, hour and day.
5. **Purchase permission.**
   - Select **Review this purchase**. Without a permission, checkout is refused, and the page says nothing was charged.
   - Use **Manage purchase permissions** to allow one purchase of that exact item, up to a quantity and total, for a set time.
6. **Checkout.**
   - Review the seller, item, quantity and total, then confirm the summary. Confirming takes no payment.
   - The payment step depends on the mode stated on the checkout page:
     - **Simulated checkout** (the default): a local simulation of order, approval and capture. PayPal is not contacted and no money moves.
     - **PayPal Sandbox checkout**, when enabled for judging: **Continue to PayPal Sandbox** opens PayPal's Sandbox. Sign in with the Sandbox buyer from the private judge notes, approve, then select **Capture the approved payment** once. Sandbox money is not real.
   - In PayPal Sandbox mode, the result page reports a capture only after the app has checked PayPal's capture against the order, amount, currency, seller and reference.
   - In the simulated checkout, order, approval and capture are local simulation steps; no PayPal evidence exists or is checked.

Spanish: choose **Español** and **Show this language** on the admission page before continuing. Product names stay in English and are marked as English for screen readers.

## What is real and what is simulated

| Part | Status |
|---|---|
| Demo store, prices, stock, shipping | Simulated: fixed demo prices, no physical delivery |
| AI suggestions | Live model through Synthorai, within limits; otherwise a labelled local assistant |
| External listings | Live Channel3 data, shown as reported; not sold by ShopAccess |
| Payment | Simulated by default; PayPal Sandbox when enabled (no real money in either) |
| Accounts and data | In memory only; nothing is kept after a restart |

## Known limitations

- Screen-reader, native-speaker and multi-browser acceptance testing is incomplete. Keyboard focus is shown with a dark outline.
- The simulated payment panel is in English, including on Spanish pages.
- Product images are illustrations, not photographs.
- The browser extension and side panel are not enabled on the hosted service.

## Run it yourself

See [README.md](../README.md), "Run the demo locally". The default local run needs no accounts, keys or network access to any provider. The project is released under the [MIT License](../LICENSE).

## Local frontend continuation note

The current uncommitted local candidate uses real product imagery with source credits, a stronger blue visual style and dark-red warnings. Public reuse clearance for the imagery remains unresolved; this note does not change the hosted version described above. The local extension0.5.0 is chat-first and can reconnect to an existing valid grant; pairing still requires website approval and its six-digit matching code. It reads and continues only the paired ShopAccess conversation. It does not inspect arbitrary websites or confirm/check out/pay. No hosted extension origin or provider setting is enabled by this source update.
