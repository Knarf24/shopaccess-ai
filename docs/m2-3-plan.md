# M2-3 plan: F07 scoped, revocable purchase permissions (website only)

Prepared October 16, 2026 (America/New_York) by Claude. Planned against `main` at `e6bb69dbac7127786425c299667a45a3930a833b` (M2-2 merged).

**Status:**
- **Approved by the owner on October 16,** with decisions D-M23-1 to D-M23-6 and the clarifications in §15.
- **Work happens on `feature/m2-3-purchase-permissions`,** created from that exact commit. `main` stays at the verified M2-2 merge.
- **One slice at a time:** each slice is authorized separately. *As written on October 16:* "Slice 1 is authorized; the rest are not yet."
- **Authorization record (updated October 18, from the recorded owner approvals; America/New_York):**
  - Plan: approved October 16, committed as `ac95a17` (17:36).
  - Slice 1: authorized October 16. Its commit was approved with three plan corrections and the live-session invariant: `bb33781` (17:48).
  - Slice 2: implementation approved October 16. Its commit was approved after the definitive-decline correction and the red-check incident record: `42e9b7e` (18:19).
  - Slice 3:
    - implementation approved October 16; mock browser verification, and fixes D1 and D2, approved October 16–17;
    - review corrections (findings 1–6, the second review, Codex r3) approved October 17–18;
    - the §10 owner-operated VoiceOver amendment and the checkout language-marker correction approved October 18;
    - the local commit approved October 18: `e2c1b05`.
  - Integration and publication, October 18: the merge with `main` at `21871db` (`a142e95`), the push to `origin`, and draft PR #4 were each separately approved. **Merging to `main` is not approved.** F07, F11 and A35 are not accepted.

**Owner decisions already given (October 16):**
- **Option A:** M2-3 is F07, scoped revocable purchase permissions. It completes M2's "revocable scoped permissions" outcome (`docs/milestone-plan.md`) and is the F07 dependency of F06 (`docs/m1-assessment.md`).
- **A permission binds:**
  - exact item;
  - exact seller;
  - maximum quantity;
  - maximum total amount;
  - explicit expiry.

  These are hard boundaries:
  - a different item or seller, a larger quantity or a higher total needs a new permission;
  - an expired or revoked permission gives no authority;
  - a lower price is allowed when every other field still matches.
- **Only the website uses permissions in M2-3.** The extension keeps exactly the M2-2 boundaries:
  - it may read and continue the conversation, and may withdraw a confirmation;
  - it may not create, approve, use, exercise or revoke a permission;
  - it may not confirm, start a checkout or pay.
- **No non-local use before October 24.** M2-3 is local and mock-only on 127.0.0.1. M2-2 finding 3 (pairing matching code) stays deferred, and the rule stands: it must be implemented before any non-local or hosted use.

## 1. Goal and user-visible capability

**Goal:** a purchase on the website can go ahead only inside a permission the shopper created explicitly and can revoke at any time. Every checkout step re-checks the permission and fails closed.

**What the shopper sees:**
- **A "Purchase permissions" page** (`/shop/permissions`, EN/ES) where the shopper:
  - creates a permission for one catalog item: the item, a maximum quantity, a maximum total and an expiry;
  - reviews active, in-use, used, expired and revoked permissions;
  - revokes any permission that is not yet used.
- **Checkout requires a matching permission.** Without one, checkout start refuses with a clear message and a link to create one.
- **Checkout shows which permission applies,** and refuses at any later step if the permission was revoked, expired or no longer matches.
- **The existing per-purchase confirmation stays.** The permission adds a boundary; it does not replace the shopper's explicit confirmation of the exact quote. No step becomes automatic.

## 2. Scope

**Required (M2-3):**
1. **Permission model:** schema, identifiers and lifecycle (§3).
2. **Persistence:** saved in snapshot format 4; format 3 upgraded (§4).
3. **One policy module** (`src/lib/permissions/`) used by every check (§5). It is called from the checkout service and the payment orchestrator, so no route can skip it.
4. **Website routes:**
   - page `/shop/permissions`;
   - `POST /shop/permissions/create`;
   - `POST /shop/permissions/revoke`;
   - checkout start, confirmation and payment refusals that name the permission problem.
5. **EN/ES copy, keyboard behaviour and focus handling** following the site's existing patterns (§9).
6. **Revocation on logout and reclaim,** in the same saved decision, as for extension grants.
7. **Tests and gates:** §10 and §12.

**Optional improvements (only if time allows, each separately approvable):**
- **"Create a permission for this item":** a shortcut on the shop's product cards that pre-fills the create form. It is a link only and never creates anything by itself.
- **Recent-history trimming:** permissions used or revoked more than 24 hours ago are removed from the saved file.

**Deferred (not M2-3):**
- reusable or cumulative-budget permissions (§6);
- agent or extension use of permissions (F06);
- seller-wide or category permissions;
- multi-item permissions;
- permissions in PostgreSQL mode.

**Out of scope:**
- F06 store actions;
- live payments, live PayPal, live AI or Channel3;
- deployment;
- PostgreSQL execution and migrations;
- voice and the "Hey ShopAccess" experiment, which stays a separate experiment;
- any extension purchase authority;
- M2-2 finding 3 (deferred, required before non-local use);
- the module-copy pattern in `src/server/shopping.ts` and `src/lib/providers/channel3-discovery.ts`.

## 3. Permission model and lifecycle

### 3.1 Schema (saved form)

| Field | Type and rule |
| --- | --- |
| `permissionId` | `prm_` + 32 lowercase hex, random |
| `sessionId` | the creating website session; never changes |
| `merchantId` | seller identity, exactly the catalog's `merchantId` (today `dmm_shopaccessdemo`) |
| `productId`, `variantId` | item identity; must exist in the merchant catalog at creation |
| `maxQuantity` | integer, 1 to the variant's `maxQuantityPerOrder` (catalog cap 10) |
| `maxTotalCents` | positive integer, at most **20,000,000 cents**: the existing maximum unit amount (2,000,000 cents) times the maximum quantity of 10 |
| `currency` | `"USD"`; a quote in any other currency never matches |
| `createdAt`, `expiresAt` | ISO times. `expiresAt` is always a concrete timestamp, computed once at creation: the earliest of the shopper's choice (15 minutes, 1 hour, or "until this session ends"), the session's absolute expiry and, when admission is on, the admission cookie's expiry. "Until this session ends" is stored as that earliest deadline, never as an open-ended value, so expiry is the same after a restart |
| `state` | `active`, `reserved`, `executing`, `consumed`, `revoked`, `expired` or `outcome_unknown` |
| `checkoutIntentId` | the checkout holding the permission (`reserved`, `executing`, `consumed`), and kept on `outcome_unknown` for tracing and reconciling the uncertain checkout. A `revoked` or `expired` permission keeps the checkout that held it when it ended, so that checkout reports the true reason (review finding 4, October 17); it is dropped on restart. Otherwise `null`. Only the state carries authority: `outcome_unknown`, `revoked` and `expired` never authorize anything |
| `changedAt` | time of the last state change |

**Expiry:**
- **Authority is always checked against `expiresAt`.** A permission at or past its `expiresAt` has no authority, whatever its saved state.
- **`expired` is also saved, as bookkeeping only.** The next permission decision after an `active` or `reserved` permission lapses records it as `expired`, and a restore does the same. This frees its exact seller + product + variant binding for a new permission.
- **The saved state never restores or extends authority.**

**Limits (D-M23-6):** a permission is *live* while it is `active`, `reserved` or `executing` and not expired. Live permissions are the ones that carry or are exercising authority.
- **Binding uniqueness:** at most **one live permission per session for the same exact binding** (seller `merchantId` + `productId` + `variantId`). Creating another for a binding that already has a live permission is **refused** with `PERMISSION_DUPLICATE`, and nothing changes. There is no automatic replacement: the shopper revokes the existing one first. Two authorities for one binding can never exist at once, and a checkout always matches exactly one permission.
- **Count cap:** at most **5 live permissions per session.** A sixth is refused with `PERMISSION_LIMIT`.

### 3.2 Lifecycle

| Step | Who and where | Effect |
| --- | --- | --- |
| **Create** | Shopper, `POST /shop/permissions/create` (website guard: admission, trusted origin, same-origin Fetch Metadata, CSRF, rate limit) | Validates against the catalog and the limits; saves `active` before the page reports it |
| **Inspect** | Shopper, `/shop/permissions`; the checkout page | Read only |
| **Reserve** | Checkout start | Binds the one matching `active` permission to the new checkout (`reserved`), in the same saved decision that admits the checkout; refuses if none matches |
| **Check** | Confirmation (prepare and submit); order creation | Re-checks state, expiry, session, binding and every bound field against the current quote |
| **Execute** | Immediately before capture is sent (the point of no return) | Moves to `executing`, saved before the provider is called |
| **Consume** | Capture outcome `CAPTURED_VERIFIED` | `consumed`; never usable again |
| **Release** | The checkout ends before capture was ever prepared (cancelled, expired, superseded, failed before capture, or gone after a restart while still `reserved`). In these cases it is known that no capture was sent | Back to `active` if not expired, so the shopper can try again. Never from `executing` |
| **Unknown** | Capture outcome unknown or under reconciliation, or a restart while `executing` | `outcome_unknown`: no authority, never released automatically (fail closed) |
| **Revoke** | Shopper, `POST /shop/permissions/revoke`; logout; session reclaim | `revoked` from `active` or `reserved`. A `reserved` checkout is then refused at its next step. `executing` cannot be revoked: the page says the purchase is already being completed |
| **Expire** | Time | No authority. Checks refuse; the page shows "expired" |

## 4. Persistence: snapshot format 4

- **Body:** gains `permissions: SavedPermission[]`.
- **Format upgrades:** format-3 files are read and upgraded with an empty list. Formats 2 and 1 keep their existing upgrade path. The next commit writes format 4.
- **Strict validation** on read. Any failure means the file is refused and the shop fails closed, as today. Checks:
  - exact keys and patterns;
  - known session;
  - unique IDs;
  - `expiresAt > createdAt`;
  - lifetime at most 24 hours;
  - the per-session and per-item limits for `active` and `reserved`;
  - a `checkoutIntentId` present exactly for `reserved`, `executing` and `consumed`.
- **Restore after a restart:**
  - checkouts are memory-only (M2-1), so every `reserved` becomes `active`;
  - every `executing` becomes `outcome_unknown`;
  - `consumed`, `revoked` and `outcome_unknown` are kept for the history list until trimmed;
  - expired permissions stay listed as expired with no authority.
- **Writing:** every permission change goes through the existing save-first gate (`durable.decide`). It is saved before it is reported, and a refused save blocks the gate (503 or page notice), as in M2-1.
- **State location:** permission state lives on the shared store object (the B1 rule from M2-2), never in module-level maps.
- **Rollback note:** M2-2 code cannot read a format-4 file and will refuse it (fail closed). See §11.

## 5. Where the policy checks run

**Slice 2 invariant (from slice 1):**
- In memory mode, logout does not rewrite permission records.
- A dead session's permissions have no authority.
- **Every slice 2 authorization check must independently require a live session.**

There is one function, `checkPermission(state, { sessionId, quote, checkoutIntentId, phase, now })`, which returns `ok` or a refusal code. Every caller uses it. "Matches" means all of the following:
- the same session;
- `merchantId`, `productId` and `variantId` equal to the quote's;
- the quote's `quantity` at most `maxQuantity`;
- the quote's `totalCents` at most `maxTotalCents`;
- the quote's `currency` equal to the permission's;
- the current time before `expiresAt`;
- the state allowed for the phase;
- `checkoutIntentId` equal to this checkout's (after reservation).

| Phase | Location | Allowed state | Action on success |
| --- | --- | --- | --- |
| Start | `startCheckoutWithQuote` (checkout service), after the quote is priced and before the checkout is admitted | `active` | reserve (saved) |
| Confirm (prepare and submit) | `prepareConfirmation`, `confirmPurchaseSummary` | `reserved` for this checkout | none |
| Order create | payment orchestrator `prepareOrderCreate` (used by the mock simulation and the sandbox approve route) | `reserved` for this checkout | none |
| Capture | payment orchestrator `prepareCapture` (every mock and sandbox capture path) | `reserved` for this checkout | `executing` (saved) before the provider call |
| Capture outcome | where `CAPTURED_VERIFIED`, unknown or reconciliation states are recorded | `executing` | `consumed` or `outcome_unknown` (saved) |
| Capture resend during reconciliation | payment orchestrator `reconcileOperation`, which can resend the same capture without `prepareCapture` | `executing` or `outcome_unknown` for this checkout | none. A resend is the same, already-authorized operation; any other state refuses the resend. Reading the outcome back is always allowed |

**Refusal codes** (public, translated):
- `PERMISSION_REQUIRED`;
- `PERMISSION_MISMATCH` (item, seller, quantity, total or currency);
- `PERMISSION_EXPIRED`;
- `PERMISSION_REVOKED`;
- `PERMISSION_IN_USE` (bound to another checkout);
- `PERMISSION_UNAVAILABLE` (`outcome_unknown`, `consumed`, or a save failure).

A refusal never changes the permission, except at Start, where no reservation is made.

**Missing or malformed data fails closed:**
- missing permission state, a malformed record or a failed read means no authority;
- a checkout without a bound permission cannot confirm, create an order or capture.

## 6. Single use or reusable

**Recommendation: single use** (decision D-M23-3). A permission covers one checkout and is consumed when that checkout's capture is verified.

**Threats considered:**
- **Repeated spending:** a reusable permission "up to $600" lets each purchase stay under $600 while the total grows without limit. Preventing that needs a cumulative budget, which is more state and more failure modes. Single use caps exposure at one purchase.
- **Replay and double submit:** reservation binds the permission to one checkout. A second checkout, or a duplicate submit from another tab, gets `PERMISSION_IN_USE`. Capture moves to `executing` in one serialized decision, so two concurrent captures cannot both proceed.
- **Stale authority:** single use plus expiry bounds how long a forgotten permission stays dangerous.
- **Cost:** for repeat purchases the shopper creates a new permission each time. This matches M5's planned "repeat-order revalidation".

Reusable permissions with a cumulative budget are recorded as deferred.

**Definitive decline (slice 2, owner-approved):**
- A capture the provider definitively declines or rejects returns the permission from `executing` to `reserved` for the **same** checkout, never to `active`.
- **That checkout's earlier confirmation is spent.** The payment state machine lets the buyer approve again (`DECLINED_RETRYABLE` → `APPROVED_VERIFIED`) without a new shopper confirmation. So `prepareCapture` passes "declined before" to the gate, which refuses any further capture on that checkout with `CONFIRMATION_REQUIRED`.
- **A fresh confirmation means a new checkout.** The shopper cancels, which releases the permission under the existing release rule, then starts a new checkout and confirms again.
- Regression test: `tests/unit/purchase-gate.test.ts`, "after a definitive decline the old confirmation is spent".

**Tracked for slice 3 (no change in slice 2):**
- **Unavailable after a successful capture:** if the save after a verified capture fails, the system correctly fails closed (the permission stays `executing`, then becomes `outcome_unknown` on restart), but the shopper may see "unavailable" although the capture succeeded. Slice 3 wording should say the payment may have gone through and point to the checkout's status.
- **Reconciliation after the session has ended:** no resend is allowed. The checkout stays unknown and goes to manual review (fail closed), by design.

## 7. Amounts and price changes

**The amount limit applies to the final payable total** (the quote's `totalCents`: subtotal minus discount plus tax and shipping), not the item subtotal (decision D-M23-4).
- It is what the shopper pays, and it stays correct when tax or shipping stop being zero.
- Today they are zero in the demo (`SANDBOX_ASSUMPTIONS`), so the two values are equal.
- Currency must match exactly (USD).

**Price changes:**

| Situation | Result |
| --- | --- |
| Price lower than when the permission was created | Allowed if the new total is at or below the maximum and everything else matches |
| Price higher, new total still at or below the maximum | **Proposed: allowed** (decision D-M23-2). The maximum is the shopper's stated consent, and the existing per-purchase confirmation still shows the exact current total before anything happens |
| New total above the maximum | `PERMISSION_MISMATCH`; a new permission is needed |
| Price changes after confirmation | Already refused by the existing quote and catalog-revision checks; unchanged |

## 8. Concurrency, restart and isolation

- **Concurrency:** every reserve, execute, consume, release and revoke is a compare-and-set inside the single-writer gate (`gate.decide`). Memory mode runs the same decision synchronously. Tested races:
  - two checkout starts for one permission;
  - revoke against capture;
  - two captures for one checkout;
  - logout against capture.
- **Restart:** see §4. A restart never leaves a usable `reserved` bound to a checkout that no longer exists, and never turns `executing` back into authority.
- **Session isolation:**
  - permissions belong to one session; another session can neither see, use nor revoke them;
  - logout revokes every non-final permission of the session in the same saved decision as the session revocation;
  - session reclaim removes them with the session;
  - session rotation keeps the same session ID, so permissions follow it.
- **Extension isolation:**
  - extension routes expose no permission data and accept no permission action;
  - website permission routes ignore `Authorization` headers and need the website cookie, CSRF and same-origin checks;
  - tests assert both directions;
  - the extension's conversation view stays as in M2-2.

## 9. Website copy and accessibility

**EN/ES copy** goes in a new `src/lib/i18n/permission-copy.ts`, Spanish written with the same care as `extension-copy.ts`. Key strings:
- page title: "Purchase permissions" / "Permisos de compra";
- field labels: item, maximum quantity, maximum total (USD), ends;
- explanation: the permission allows one purchase of this item within these limits; you still confirm each purchase;
- each refusal code above;
- each state name;
- "Revoke permission" / "Revocar permiso", described by the item's name;
- the creation and revocation results as plain sentences.

Superseded during the browser check (defect D1, October 17): no permission label or identifier is shown, in text, button names or URLs. Amounts use the existing USD formatter.

**Accessibility (site patterns):**
- every field has a visible `<label>`; errors are listed in an alert and linked from the field with `aria-describedby`;
- results of create, revoke and refusals are the "Skip to the current step" target, as for B5 in M2-2;
- **focus on arrival (owner decision, October 17, after the browser check):** after Review, focus moves to the review heading; after Create, Revoke or a form error, to the result message. This deliberately departs from the site's "no automatic focus" pattern, on this page only. It needs one small client component (`FocusOnArrival`, React import only), added to the SEC-01 client-code allowlist with that restriction. Targets have `tabIndex={-1}` and a visible outline however focus arrived. Whether a screen reader announces the target on arrival is unverified until the VM check;
- **skip links on `/shop` and the checkout (same decision):** "Skip to the current step" is the first focusable element. It targets a refusal or error when one is shown; otherwise `/shop` targets the demo-store list, and the checkout targets a notice, then the confirmation summary, a quote problem, the quote, or the payment section. Both modes (mock and PostgreSQL) get it. The confirmation heading takes `tabIndex={-1}` only while it is the target, as in the needs review;
- **SEC-01 exception, tightened after review finding 1 and the second review:** `FocusOnArrival.tsx` must match its reviewed SHA-256, stored separately in `tests/unit/sec01-pins.ts` (any change needs a reviewed update of that value), and may contain only an allowlisted vocabulary (the directive, one import of React's `useEffect`, `getElementById`, `focus`), read in one pass so a `"//"` string cannot hide code. Every script file under `src`, `.mts` and `.cts` included, is collected (the same collector feeds the repository assertion) and scanned for a client directive anywhere in its prologue (exactly two allowed). Module references are read with the TypeScript parser (an existing dependency) and resolved as the project resolves them (`@/` alias, relative paths, with or without an explicit supported suffix): only `PurchasePermissions` may import `FocusOnArrival`, and only the permissions page may import `PurchasePermissions`; a barrel or re-export is itself an importer. Any `import()` or `require()` whose specifier is not a literal is refused anywhere in `src` (none exists today). This is a source policy: a refusal does not depend on whether a bundler would include the module. Not covered: module loading that is not an import or require call (for example `new Function`, or a URL passed to a worker); the pin and vocabulary checks guard the excepted module itself. Negative controls, on a temporary source tree through the same collector and checker, cover each bypass the reviews demonstrated (Codex review findings 1–2);
- **seller descriptor (same decision):** the seller's proper name is kept; the catalog's "(simulated)" is shown as "(simulada)" on Spanish pages (permissions page and Spanish confirmation summary). Display only: the catalog and saved confirmation summaries are unchanged. English pages, including the English-only parts of a Spanish checkout, are unchanged;
- the list is a real list, each Revoke a button with the permission's label in its name;
- visible focus, logical tab order, no keyboard traps;
- amounts and dates in text, not only visually;
- `lang` is set per page language.

**Checkout messages and actions after the slice 3 source review (owner-approved findings 2–6, October 17):**
- The checkout page derives its F07 refusal from saved state (`buildCheckoutView`'s `permissionRefusal`), never from the URL: from preparing the confirmation while `QUOTED`, and afterwards from the gate's read-only `display` check (the gate ignores the phase) in the confirmed, pre-capture states including an unknown order (and `CONFIRMATION_REQUIRED` once a capture was declined). While a refusal applies, no payment step is offered: simulation keeps Cancel and Reconcile (which only reads back; a resend stays gated), and sandbox shows its existing protected Cancel form while cancelling is valid.
- The current refusal replaces any message carried in the URL, so the page never also says "review the summary below" with no summary.
- A permission code in the URL is shown only once a capture's outcome is unproven, and then as manual review; otherwise it is ignored, so "nothing was charged" is never inferred from the URL.
- "Payment may already have gone through" is a full, accessible HTML page with no form, button, link or script, with the same non-sensitive reference the earlier JSON carried (also in the audit record), and is audited best effort in both simulation and sandbox (the in-memory audit log is separate from the blocked state store; a failure to audit never changes the page). A resubmission is refused by the blocked store before anything runs.
- Not changed: expiry rules, save-first ordering, every gate check and the payment state machine.

**Checkout language of parts (owner-approved correction, October 18):** a check found the mock checkout page had no `lang` at all, so Spanish checkout content (the refusal, skip link and progress steps) inherited `<html lang="en">`. This gap predates M2-3. The page is now marked with the checkout's resolved interface language (none recorded means English). On a Spanish checkout, the parts that are English whatever the language are marked English: the page heading, the quote lines, generic `messageFor` notices and errors, the simulated-payment panel and "Back to the start". The localised sandbox errors stay unmarked and inherit Spanish. Copy, values, permission authority, payment behaviour and the language-selection rules are unchanged; mixed-language copy stays tracked under finding 8.

**Proposal, not implemented (review finding 7):** give revoke its own per-session rate-limit bucket (for example `permission_revoke`, 20 per minute per session, same guard), so checkout confirmation and permission creation cannot exhaust it; keep create in the shared `confirmation` bucket. Abuse protection stays: revoke is still per-session limited, CSRF- and origin-guarded, and changes only the caller's own permissions.

**Tracked, not changed (review finding 8):** focus can move again on a reload or bookmark of a result address, and after the shopper has started tabbing if hydration is slow (needs the VM check and keyboard observation); English product names on the Spanish permissions page lack `lang="en"`; Spanish checkouts still show some English `messageFor` errors (pre-existing).

## 10. Testing and validation

**Automated** (database-free, network blocked, no live providers, existing no-TCP recipe): full suite, typecheck and lint, plus focused tests for:
- **schema and format 4:** upgrade from 3; strict refusal of malformed, duplicate and over-limit records;
- **lifecycle:**
  - create validation (catalog, quantity, total, expiry caps);
  - reserve, release, execute, consume, revoke;
  - `outcome_unknown`;
  - expiry at each phase;
- **matching:**
  - each bound field mismatched individually;
  - a lower price allowed;
  - a higher price within or above the maximum (per D-M23-2);
  - currency mismatch;
- **enforcement at every phase,** including the sandbox approve and capture paths, so no route can skip the check;
- **concurrency races** in §8, using the snapshot gate with a controllable store;
- **restart:** reserved becomes active, executing becomes outcome_unknown, consumed and revoked stay, expired has no authority;
- **isolation:**
  - another session;
  - logout and reclaim;
  - an extension bearer gets nothing from permission routes, and extension responses carry no permission data;
- **route inventory and mode dispatch:** the new routes are mock only and "not found" in PostgreSQL mode;
- **red checks:** each enforcement point removed in turn must make a test fail.

**Manual, mock-only browser check on 127.0.0.1 (owner-assisted, about 1 hour), for what automation cannot show:**
1. Create a permission with the keyboard only; check labels, the error alert on a bad total, and the result message.
2. Check out the permitted item within limits through confirmation and the simulated capture. The permission shows as used.
3. Check out a different item, and the same item with a quantity above the maximum. Both are refused with readable messages and a link to create a permission.
4. Revoke a reserved permission from another tab, then continue the checkout; it is refused.
5. Restart the server with a reserved permission; it is active again and the old checkout is gone.
6. Spanish: repeat step 1 with `lang=es`.
7. Visible focus and tab order on the permissions page and the checkout refusal.

**Screen readers:** not run on the owner's normal desktop. Any VoiceOver check uses the disposable-VM setup from the E1 handoff, and results are claimed only if observed.

**Amendment (owner-approved, October 18):** an owner-operated, manual VoiceOver check may run on the owner's normal Mac. The owner operates VoiceOver and the browser; Claude gives one step at a time, manages the existing mock-only server on 127.0.0.1, and records the observations. It does **not** permit automated desktop navigation, VoiceOver AppleScript control, new macOS Accessibility or Automation permission grants, software installation, or VM or account provisioning. Spoken observations are recorded separately from DOM, browser and unit evidence. They don't grant F11 or A35 acceptance.

## 11. Failure and rollback

- **Runtime failure:** a refused save blocks the gate, and the shop shows "not available" (M2-1 behaviour). No checkout step continues without its saved permission change.
- **Config:** none new. Permissions are always enforced in mock mode, and the code has no off switch (decision D-M23-1).
- **Rollback:**
  - revert the M2-3 merge commit;
  - M2-2 code refuses format-4 files (fail closed), so a rollback also needs a new private store directory, initialised as in the README;
  - all mock state is synthetic, so losing it is acceptable;
  - no database or migration is involved.
- **PostgreSQL mode:** never executed, and no PostgreSQL implementation or migration is authorized. Its checkout path has no F07 enforcement. **Rule (confirmed by the owner):** there is no silent fallback to an unprotected checkout. In slice 2, every checkout route in PostgreSQL mode fails closed with "not available" until equivalent enforcement exists there. This covers start, confirm, approve, return, capture and cancel.

## 12. Gates

1. **Owner approval of this plan** and decisions D-M23-1 to D-M23-6.
2. **Per slice:** suite, typecheck and lint; the elapsed time recorded.
3. **Browser check** (§10), owner-assisted.
4. **Pre-commit security review:** an independent read-only review of the full diff against this plan. It covers:
   - every enforcement point;
   - fail-closed paths;
   - state-machine transitions;
   - concurrency;
   - restart;
   - session and extension isolation;
   - logging (no CSRF values, tokens or secrets);
   - EN/ES;
   - accessibility.

   Findings are corrected or explicitly accepted by the owner before commit.
5. **Pre-merge PR verification:**
   - the exact head SHA and the base;
   - no added commits;
   - mergeable, with no CI (none configured);
   - finding 3 still recorded as deferred;
   - after merge, suite, typecheck and lint on `main`.

## 13. Slices and estimate

| Slice | Work | Agent hours |
| --- | --- | --- |
| 1 | Permission model, format 4 and upgrade, gate decisions, restore rules, unit tests | 3–5 |
| 2 | Policy module; enforcement in the checkout service, confirmation and orchestrator; refusal codes; race and restart tests | 4–6 |
| 3 | Permissions page, create and revoke routes, checkout refusal UI, EN/ES, accessibility, route inventory | 3–5 |
| 4 | Isolation and extension-boundary tests, logout and reclaim, docs (README, tracker, work log) | 1.5–3 |
| 5 | Browser-check support and fixes; security review and corrections | 1.5–3 |
| **Total** | | **13–22 agent hours**, plus about 1–2 owner hours |

- **Confidence:** medium.
- **Main risks:**
  - threading the permission through the orchestrator's capture states without changing payment behaviour;
  - the existing payment state machine has many states, so release and unknown rules must be exhaustive.
- **Schedule:** M2's proposed internal date (October 19) likely slips by about a day. The October 24 target is unchanged, and the M1 forecast already showed it at risk.

## 14. What stays untouched from M2-2

- extension authority, routes, scopes, pairing, grants, expiry, revocation, token hashing and the shared message limit;
- the B1 shared-store fix;
- the conversation and confirmation-withdrawal behaviour;
- the website request guard;
- the existing quote, confirmation and payment rules (F07 adds checks; it relaxes none);
- the deferred finding 3 rule.

## 15. Owner decisions (approved October 16)

- **D-M23-1, approved:** every mock checkout requires a matching live permission. There is no bypass or off switch, and missing or invalid authority fails closed.
- **D-M23-2, approved:** a price increase is allowed only when:
  - the seller, product and variant match exactly;
  - the quantity is within the permission;
  - the currency matches;
  - the final payable total stays at or below the maximum;
  - the permission is otherwise valid;
  - the shopper still confirms the exact current total in the existing confirmation step.

  A total above the maximum needs a new permission.
- **D-M23-3, approved:** single use.
  - One permission is reserved for one checkout, so another tab or a duplicate request cannot exercise it.
  - It is consumed only after a verified capture.
  - A reservation returns to `active` only when the checkout ended before capture was prepared, so it is known safe.
  - Once the system cannot prove whether capture happened, the permission becomes `outcome_unknown`, never `active`.
- **D-M23-4, approved:** the maximum applies to the final payable total, including any tax, shipping, fees or other charges. The currency must match exactly; M2-3 is USD-only.
- **D-M23-5, approved with clarification:** the choices are 15 minutes, 1 hour and "until this session ends". Every permission stores a concrete absolute expiry, computed at creation as described in §3.1.
- **D-M23-6, approved with clarification:**
  - uniqueness is per exact binding (seller + product + variant), not a broader "item";
  - at most 5 live permissions per session;
  - a duplicate for the same binding is refused, not replaced (§3.1).
- **PostgreSQL, confirmed:** fails closed for checkout until F07 enforcement exists there (§11).
- **Boundaries unchanged:**
  - the extension stays conversation-only, with no new privileged API and no way to create, inspect, exercise, reserve, consume or revoke permissions;
  - explicit purchase confirmation stays;
  - F06, live AI, providers and payments, and voice stay out of scope;
  - M2-2 finding 3 stays deferred and is required before any non-local use.
