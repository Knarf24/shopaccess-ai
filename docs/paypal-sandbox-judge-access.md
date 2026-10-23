# PayPal Sandbox access for judges — owner procedure

This procedure lets judges complete a PayPal Sandbox checkout without creating PayPal accounts. Use it only if the owner decides to run the hosted service in Sandbox mode during judging. It changes nothing by itself.

## Principles

- Judges never create PayPal accounts. They use **one Sandbox personal (buyer) account** that the owner creates for judging.
- That account exists only in PayPal's Sandbox and holds only Sandbox test funds. It is not a real PayPal account and must not be any account used elsewhere.
- Its sign-in details are shared **only** in the hackathon submission's private judge notes, together with the demo passphrase. They never go in this repository, the README, the video or a public page.
- The seller is the existing Sandbox business account linked to the Sandbox REST app configured on the host.

## 1. Create the judge buyer (owner, developer.paypal.com, Sandbox)

1. **Testing Tools → Sandbox Accounts → Create account**: type **Personal**, country **United States**.
2. Note its generated email (`sb-…@personal.example.com`). Under **⋯ → View/Edit account**, set a new password used nowhere else. Leave the default Sandbox balance and the test bank and card that PayPal provides.
3. Do not reuse the owner's existing test buyer, so that judge activity is separate and the account can be reset or deleted after judging.

## 2. Check it before sharing (owner)

1. Sign in to `https://www.sandbox.paypal.com` with the new buyer and confirm the account opens, with no verification prompt.
2. Optional, while the host is already in Sandbox mode: complete one checkout with it and confirm the payment in the seller's and buyer's Sandbox Activity.

## 3. Share it privately

Add to the private judge notes:
- the hosted URL and the demo passphrase;
- "At PayPal Sandbox, sign in with: `<buyer email>` / `<buyer password>`. This is a PayPal Sandbox test account; no real money is involved.";
- the request to select **Capture the approved payment** once and not to retry if the outcome is uncertain.

## 4. Host settings (separate approval; see the hosted procedure)

Sandbox mode needs five Render variables:
- `PAYMENT_PROVIDER_MODE=sandbox`
- `PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com`
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_SANDBOX_MERCHANT_ID`

Then deploy the release commit. Reverting to the simulated checkout means setting `PAYMENT_PROVIDER_MODE=mock` and **deleting all four `PAYPAL_*` variables**. With any of them left, the service refuses to start the shop.

## 5. During judging

- Several judges may use the same buyer at once; each checkout is a separate PayPal order.
- Checkouts live in memory. A deploy or restart while a judge is on PayPal's page loses that checkout. The app then cannot finish it, and the judge starts again. Avoid deploys during judging.
- Watch the seller's Sandbox Activity for completed payments. An approved order that was never captured simply expires in Sandbox.

## 6. After judging

- Delete the judge buyer under Sandbox Accounts, or change its password.
- Optionally rotate the Sandbox REST app secret and update Render.
- If the host should return to the simulated checkout, use the revert in section 4.

## Fallback without Sandbox mode

If the host stays in the simulated checkout for judging, judges need no PayPal access at all. The submission then shows the PayPal Sandbox integration through the recorded hosted Sandbox run (app result plus seller and buyer Sandbox Activity) and the demo video.
