# ShopAccess AI — guide for judges

ShopAccess AI helps a first-time buyer choose a laptop in English or Spanish. It explains the evidence behind each recommendation, says plainly when it cannot verify a laptop for AI work, and requires a purchase permission before checkout.

## Open the demonstration

1. Go to **https://shopaccess-ai.onrender.com**.
2. Choose English or Español, select **Continue**, then enter the **passphrase** from the private judge notes of the submission. It is not in this repository.
   - Admission lasts 8 hours in that browser.
   - Wrong passphrases are limited for the whole service, five per 15 minutes. If you see "Too many attempts", wait 15 minutes. Correct passphrases do not count toward this limit.
3. **Sessions follow cookies.** Ordinary windows and tabs of the same browser profile share cookies, so they share one shopping session. For separate sessions, for example to compare two journeys side by side, use separate browser profiles, which have separate cookie stores. An idle session ends after 2 hours.
4. **Restarts clear shopping state.** A restart of the service clears sessions, needs drafts, purchase permissions and checkouts. Your admission cookie can stay valid until it expires, so you may not be asked for the passphrase again, but you start a new journey.

## Suggested journey (about 5 minutes)

1. **Describe your needs.** Type what you need in the conversation, or open the optional form to pick a use (for example *Schoolwork*) and a whole-dollar budget (for example *600*). Select **Send message**.
   - Typed text may be sent to the AI provider named on the page, when one is configured; the page labels which assistant answered. Dictation and read-aloud use your browser's speech services.
2. **Answer the follow-up question.** The assistant asks for anything missing. The local demo assistant recognises only a few phrases, so you may need to choose the use yourself (for example **Schoolwork** or **Programming**) in the confirmation form. Then select **Confirm my choices**. Nothing counts as your request until you confirm it.
3. **Recommendations.**
   - The demo catalog is checked against price, stock, memory, storage and weight rules. Each card shows why it is or is not eligible.
   - **AI uncertainty case.** Try: *"I want to train AI models locally on my laptop. My budget is 1200 dollars."* The assistant asks what you will use the laptop for (choose **Programming**) and then whether the models run on the laptop or in the cloud. Each card then says "AI compatibility: not verified" and explains what evidence is missing (for example VRAM), and no laptop is marked **Recommended** for that workload. Compare with *"I need a laptop for school, budget 600"* with **Schoolwork** chosen, which gets a Recommended laptop and no AI notice.
   - The live AI, when configured, has per-session, hourly and daily limits. After a limit, the labelled local assistant answers instead.
4. **External listings (optional).**
   - **Search external listings** asks Channel3 for real products within your confirmed budget.
   - The page shows a price only when Channel3 reports exactly one in-stock US-dollar offer within the budget.
   - Links are Channel3 affiliate links to the seller's website. ShopAccess cannot check them out.
   - Searches are limited per session, hour and day.
5. **Purchase permission (refusal case).**
   - Select **Review this purchase** on a card. Without a permission, checkout is refused ("You need a purchase permission for this exact item… Nothing was charged").
   - Use **Manage purchase permissions** to allow one purchase of that exact item: choose the item, a maximum quantity, a maximum total and when it ends, then **Review purchase limits** and **Save purchase permission**. You can revoke it at any time.
6. **Checkout.**
   - Select **Review this purchase** again. Review the seller, item, quantity and total, then select **Confirm purchase details**. Confirming takes no payment.
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
| AI assistant | A live model (Synthorai) when configured, within limits; otherwise a labelled local assistant. Its output is advisory: the server enforces catalog, budget and purchase rules |
| AI hardware compatibility | Never asserted without evidence: cards say "not verified" for AI workloads |
| External listings | Live Channel3 data, shown as reported; not sold by ShopAccess |
| Payment | Simulated by default; PayPal Sandbox when enabled (no real money in either) |
| Accounts and data | In memory only; nothing is kept after a restart |

## Known limitations

- Screen-reader, native-speaker and multi-browser acceptance testing is incomplete. Keyboard focus is shown with a dark outline.
- The simulated payment panel is in English, including on Spanish pages.
- Product images are illustrations, not photographs.
- Voice uses your browser's speech services, which may send audio to them. Real-microphone, pronunciation and mobile acceptance is incomplete.
- The ShopAccess side panel is an unpacked developer extension (`extension/`, load it in `chrome://extensions`). It works with the hosted service only if the service has allowed that extension's Chrome ID, which depends on where it was loaded from; otherwise run it locally as described in `extension/README.md`. After you approve a pairing code on the website it can read and continue the same conversation. It cannot confirm, check out or pay.
- The charger purchase journey is not part of the default service.
- Restarts and deploys clear shopping state (see above), including a checkout in progress.

## Run it yourself

See [README.md](../README.md), "Run the demo locally". The default local run needs no accounts, keys or network access to any provider. The project is released under the [MIT License](../LICENSE).
