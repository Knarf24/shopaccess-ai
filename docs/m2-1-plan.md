# M2-1 plan: persist the guided conversation through the snapshot store

Prepared October 16, 2026 (America/New_York) by Claude as a planning record. **No application code was changed, and nothing was run**, apart from reading the source. The plan proposes work; it does not authorize it.

Source inspected: `main` at `6cc511c` (application source identical to `0379134`; later commits change only `docs/`).

## 1. Findings that shape the plan

1. **The running application does not use the snapshot store.**
   - `src/lib/session/snapshot-store.ts` (`openFoundationStore`, format 1) has its own tests, `tests/unit/snapshot-store.test.ts` and `mock-store-init.test.ts`.
   - Its only other user is `src/server/mock-store-init.mts`, a load/initialise check.
   - The mock runtime keeps everything in memory: `new InMemorySessionStore()` at `src/server/runtime.ts:171`, needs drafts on the store object, and conversation and selection state in the `WeakMap`s of `src/lib/session/conversation.ts`.
   - Consequence: a restart today loses the **session itself**, so persisting the conversation alone could never be recovered.
   - M2-1 therefore has to wire the snapshot store into the mock runtime for sessions, drafts and conversation together.
   - *Correction:* `docs/m1-assessment.md` and the feature-tracker F02 row describe sessions and drafts as able to "be persisted through" the snapshot store. That is true of the module, not of the running application.
2. **The history limit is eight lines, not eight exchanges.**
   - `MAX_CONVERSATION_TURNS = 8` (`conversation.ts:22`) caps `ConversationTurn` entries. Each entry is one shopper line or one assistant line.
   - `recordConversationTurn` appends a shopper line (if non-empty) and an assistant line (only if a notice exists), then keeps `turns.slice(-8)`.
   - So at most eight lines are retained: up to four exchanges, or more shopper lines when no notice was produced.
   - Assistant lines are `NeedsNotice` tokens (`malformed | missing_use | missing_budget | ambiguous | review | unavailable`), not free text.
3. **The conversation has no revision of its own.**
   - Stale-edit protection is the **needs draft `version`**: a submit carrying an old `version` is refused with `STALE_DRAFT` (`handlers.ts` ~315, 335).
   - The conversation is reset when the `draftId` changes, and `interfaceLanguage` is fixed per draft.
4. **The state that must persist** to keep confirmation and recommendation invalidation correct across a restart:

   | State | Where today | Persist? |
   | --- | --- | --- |
   | Session record (id, token digest, created, last seen, absolute expiry, revoked) | `InMemorySessionStore` | **Yes.** Already in format 1 |
   | Needs draft (version, language, shopper text, prefilled/confirmed use and budget, claims, retained recommendation, notice, `expiresAtMs`) | Draft map on the store | **Yes.** Already in format 1 (`SnapshotDraft`) |
   | Conversation (`draftId`, `interfaceLanguage`, `turns`) | `conversations` `WeakMap` | **Yes.** New in format 2 |
   | Purchase epoch per session | `purchaseEpochs` `WeakMap` | **Yes.** New |
   | Closed-selection flag per session (confirmation withdrawn) | `closedSelections` `WeakMap` | **Yes.** New. This is what keeps a withdrawn confirmation withdrawn |
   | Checkout epoch per intent | `checkoutEpochs` `WeakMap` | **No (decision).** Checkout intents and quotes stay in `InMemoryCheckoutStore`, so after a restart no intent exists to check. Revisit when checkout becomes durable (M5) |
   | Admission and allocation windows | Already in format 1 (`allocation`, `admissionLogin`) | Keep |

5. **Interpretation and recommendation claims.** A claim that is `pending` when the process stops cannot complete, because its provider call is gone. On recovery, pending claims must not resume or count as confirmed. Proposed rule: on load, `pending` becomes `failed`. The page then shows the existing "unavailable" notice, and the shopper resubmits.
6. **Expiry and isolation already exist** and must be preserved:
   - Session idle time is 2 hours (`SESSION_IDLE_TIMEOUT_MS`) and absolute lifetime 24 hours (`SESSION_ABSOLUTE_LIFETIME_MS`).
   - `deleteExpired` runs with `onSessionsReclaimed` (`service.ts:90–92`, `runtime.ts:166`).
   - Drafts carry `expiresAtMs` (`draftExpiry(session)`).
   - The snapshot parser already requires every draft's `sessionId` to exist among the sessions (`draftIdentity`).

## 2. Design

- **Format 2 snapshot.** Extend `PublishedBody` with:
  - `conversations[]`: `{ sessionId, draftId, interfaceLanguage, turns[≤8] }`, where each turn is `{ role, text ∈ NeedsNotice | shopper text ≤ 2000 }`;
  - `selections[]`: `{ sessionId, epoch, closed }`.

  Strict parsing stays:
  - exact keys and no duplicate keys;
  - every `sessionId` must exist;
  - at most one conversation and one selection per session;
  - the `draftId` must match that session's draft;
  - existing size and count caps, with conversation lines counted inside the 8 MiB limit.

  Format 1 files read as format 2 with empty `conversations` and `selections`. The format number goes up, and unknown formats are refused.
- **Persistent mock store.** Add one write-through adapter, a `SnapshotBackedState` module:
  - It loads the published body at startup into the same in-memory structures the runtime uses now.
  - Every mutation runs `commit(nextBody)` through the store's serialized queue, and it is acknowledged only after `commit` returns `ready`.
  - On `unavailable`, the runtime enters a **fail-closed** mode: mutating requests return the existing unavailable responses, and nothing is reported as saved.

  This mirrors E1's `PERSISTENCE_OUTCOME_UNKNOWN` ruling.
- **Conversation module.** Replace the `WeakMap`s with functions over that state. The signatures stay the same, but their callers must `await` the commit:
  - `readConversation`, `recordConversationTurn`;
  - `invalidatePurchaseSelections`, `reopenPurchaseSelections`, `purchaseSelectionsOpen`.

  `noteCheckoutSelection` and `checkoutSelectionCurrent` remain process-local, by the decision in §1.4.
- **Expiry.** `onSessionsReclaimed` also removes that session's draft, conversation and selection, in the same commit. Recovery also drops anything belonging to an expired or revoked session.
- **Runtime configuration.**
  - Two new environment settings: `SHOPACCESS_MOCK_STORE_DIR` (a private 0700 directory) and `SHOPACCESS_MOCK_STORE_KEY_FILE`.
  - When either is absent, the runtime keeps today's in-memory behaviour and says so in diagnostics. This prevents accidental persistence.
  - PostgreSQL mode is untouched.
- **No change** to the request guards, CSRF, the admission gate, quotes, confirmation, payment, Channel3 or AI.

## 3. Affected files (proposed)

| File | Change |
| --- | --- |
| `src/lib/session/snapshot-store.ts` | Format 2 body, parsing and validation for `conversations` and `selections`; format-1 read compatibility; pending→failed recovery normalisation |
| `src/lib/session/conversation.ts` | Move conversation and selection state from `WeakMap`s to the persisted state; keep the checkout epoch process-local |
| `src/lib/session/snapshot-state.ts` (new) | Write-through adapter: load, mutate, commit, fail-closed |
| `src/lib/session/store.ts` | A session store implementation backed by the adapter (same `SessionStore` interface); draft-map persistence hooks |
| `src/server/runtime.ts` | Open the store when the directory and key are configured; wire `onSessionsReclaimed` cleanup; expose the fail-closed status |
| `src/server/handlers.ts` | `await` the now-asynchronous conversation and selection writes (`rememberNeedsTurn`, `invalidatePurchaseSelections`, `reopenPurchaseSelections`); map store unavailability to the existing unavailable responses |
| `src/server/shopping.ts` | `readConversation` caller (line 526): read from the persisted state |
| `src/server/config.ts` | Read and validate the two new settings |
| `src/server/mock-store-init.mts` | Initialise the format 2 store |
| `tests/unit/snapshot-store.test.ts` | Format 2 parsing, caps, cross-references, format-1 compatibility |
| `tests/unit/conversation-persistence.test.ts` (new) | Acceptance tests in §4 |
| `tests/unit/needs-conversation.test.tsx`, `needs-flow.test.tsx` | Adjust for the asynchronous writes; no behaviour change |
| `README.md` or `docs/` | Local persistence setup, and that data is synthetic and private |

## 4. Acceptance (automated, database-free, under the existing no-TCP recipe)

1. **Restart recovery.** After a session is created, a draft confirmed and three exchanges recorded, a new runtime on the same directory restores:
   - the session (the same cookie works);
   - the draft (`version`, confirmed values, retained recommendation);
   - the conversation (its turns, in order, still capped at 8 lines);
   - the interface language;
   - the selection state.
2. **History limit.** Ten recorded lines persist as the last eight; a `draftId` change starts a new conversation.
3. **Expired sessions.** Sessions past idle, past absolute lifetime, and revoked are not restored, and neither are their drafts, conversations or selections. Reclamation removes them in the same commit. An expired draft returns `DRAFT_EXPIRED`.
4. **Cross-session refusal.**
   - Session B cannot read or write session A's draft or conversation, before or after restart.
   - A snapshot whose conversation or selection names an unknown session, or a `draftId` not owned by that session, is refused at load.
5. **Stale writes.** A submit with an old draft `version` returns `STALE_DRAFT`, before and after restart, and does not change the stored conversation.
6. **Supported requirement change invalidates confirmation.**
   - Confirm use and budget, then submit a supported change (for example a new budget).
   - Confirmation is withdrawn (`closed`, epoch incremented) and persisted.
   - After restart, checkout start is still refused until a new explicit confirmation.
   - An unsupported change (malformed, unavailable or ambiguous) does not withdraw it.
7. **Pending claims.** A `pending` interpretation or recommendation claim is restored as `failed`, never as completed or confirmed.
8. **Fail-closed.** An injected commit failure (`temporaryWrite` or `directoryFsync` hooks) leaves the published state unchanged. The request returns the unavailable response, and later mutations are refused until restart.
9. **No regressions.** Full database-free suite, `tsc --noEmit`, and ESLint, run with the no-TCP guard.

Browser check, after the automated tests, with the owner's agreement: send two messages, restart the local process with the same directory, reload, and see the same conversation and language; this also needs the keyboard check that each UI increment requires.

## 5. Effort estimate (implementation plus verification; one implementer familiar with the code)

| Work | Hours |
| --- | --- |
| Format 2, parsing, compatibility, pending normalisation, tests | 3–4 |
| Write-through adapter and fail-closed behaviour, tests | 3–5 |
| Conversation and selection module refactor; `await` the callers in handlers and shopping | 2–3 |
| Runtime and config wiring, expiry cleanup | 2–3 |
| Acceptance tests §4.1–4.8 | 2–4 |
| Full suite, typecheck, lint, no-TCP; fixes | 1–2 |
| Browser restart and keyboard check (owner present) | 0.5–1 |
| **Total** | **13.5–22 h** (about 2–3 working days) |

- **Confidence:** medium-low. The main uncertainty is how far making these calls asynchronous ripples through handler tests, and Next.js module-instance behaviour: the store must be opened once per process, while Next.js may load server modules more than once.
- **Assumptions:** the snapshot store stays the demo's persistence (decision D-state). The checkout store and audit log stay in memory. No PostgreSQL execution.
- **Comparison:** this is larger than a "60–90 minute task". Proposed bounded slices:
  1. format 2 and tests;
  2. the adapter and fail-closed behaviour;
  3. the conversation refactor;
  4. runtime wiring;
  5. acceptance tests;
  6. full verification.

  Each slice is reported separately.

## 6. Out of scope, recorded for later

- **M2-2: pairing and the replacement policy.** E1 showed that re-pairing leaves earlier grants active. Decide whether a new pairing from the same extension origin replaces the earlier grant, how "same extension instance" is established, and whether the website lists and revokes per-device grants. This is **not** a dependency of M2-1.
- Durable checkout, quotes, payment, audit and checkout epochs (M5).
- Device profile (the rest of F02).
- Any PostgreSQL execution.

## 7. Impact on the October 24 target

- M2-1 alone is estimated at 13.5–22 hours, against the M1 assessment's F02 total of 11–19 hours. That F02 total also included the profile, and it assumed the snapshot store was already in use.
- Because the runtime wiring is new work, F02 and the M2 critical path grow by roughly 4–8 hours.
- With the M1 forecast already showing a likely miss (critical path about 77–126 hours), the miss becomes **more likely**, unless capacity is added or the owner changes the scope or date.
- No date or scope is changed here.

## 8. Decisions needed before coding

1. **D-state:** confirm the snapshot store, not PostgreSQL, for the demo.
2. Accept the **pending→failed** recovery rule (§1.5).
3. Accept that **checkout epochs stay process-local** until checkout is durable (§1.4).
4. Accept **fail-closed** behaviour on a commit failure, and persistence being **opt-in** through the two environment settings.
5. Authorize the six bounded slices and the owner-present browser check.

## 9. Reconciled design (owner-approved direction, October 16, 2026)

The owner chose **option A**. M2-1 follows the save-first design of the October 14 Option B implementation contract (`option-b-implementation-contract-20261014-3`, sha256 `d9b01a2e…af746`) and extends it with the format-2 conversation and selection state. That contract is used as a **design reference**: its approval history is ambiguous, because its header says "proposed … for independent review" while the snapshot-foundation plan calls it approved. The decisions below are recorded as the **current owner-approved direction** and do not depend on that history. They **replace** the memory-first adapter described in §2 and built in slice 2.

1. **Save-first decisions.**
   - Every session, draft, conversation, selection, allocation or admission decision runs at the head of one writer queue, against the published state at that moment. That is the recheck: a result computed before waiting is never used.
   - A change becomes a private candidate. **Published memory changes only after the commit returns `ready`**, which happens after the directory flush.
   - Readers never see a candidate.
2. **Claims before provider calls.**
   - `beginInterpretation` and `claimRecommendation` return a claim only after the claim snapshot is durable.
   - The interpreter or recommendation provider starts only after that result.
   - `claimRecommendation` hands the provider the confirmed use and budget taken from the queued, durable draft, never an earlier copy.
   - Applying a provider result is another queued decision. It rechecks the draft id and version, and it publishes only after the save is durable.
3. **Failures.**
   - A **definite** refusal (nothing renamed) discards the candidate. Published state is unchanged.
   - An **indeterminate** refusal (renamed, flush failed) discards the candidate and faults the store terminally.
   - In **both** cases the application enters a blocked state for the rest of the process. Route handlers return the existing public `UNAVAILABLE` (HTTP 503, `no-store`, no `Set-Cookie`). Pages render "The shop is not available right now. Please try again later."
   - No success redirect follows a refused save, and no provider call starts after one.
4. **Windows.** The session-allocation window (30 per minute, 500 live) and the admission-login window (5 per 15 minutes) are persisted and restored. Each increment is durable before the session is minted or the passphrase is checked.
5. **Interrupted requests** (restart recovery, applied once by the startup barrier and written durably before the runtime is built):
   - **interpretation:** the claim is released and `notice` becomes the existing **`unavailable`**;
   - **recommendation:** the claim becomes **`failed`**, with a null recommendation and the confirmation kept;
   - nothing is replayed, and no slot file is written.

   *Retry wording:* the existing `unavailable` notice already asks the shopper to choose or reword. For a `failed` recommendation, the panel's copy gains a retry sentence telling the shopper to change the use or budget, or start again, to request suggestions. That is the only existing explicit retry path, and it involves no automatic call.

   The slice-2 `interrupted` notice and the confirmation-withdrawal rule are **dropped**.
6. **Confirmation invalidation.**
   - The per-session selection state (epoch, closed) is part of the snapshot. A supported requirement change commits the draft change and the selection close in **one** snapshot.
   - A withdrawn confirmation stays withdrawn after restart. Explicit re-confirmation reopens it, again as one snapshot.
   - Checkout epochs per intent stay in memory. Pre-restart checkout intents are memory-only and absent after restart, so they cannot resume or become confirmable, and a test asserts that.
7. **Configuration mapping.**
   - The contract's single `SHOPACCESS_MOCK_STORE` meant "a value is present: open the local store; absent: in-memory". The approved settings are `SHOPACCESS_MOCK_STORE_DIR` and `SHOPACCESS_MOCK_STORE_KEY_FILE`.
     - **Neither set:** today's in-memory runtime, unchanged.
     - **Either set:** store mode is requested (the contract's "present").
     - **Both must be valid:** a private 0700 directory containing an initialised `store.json`, and a 0600 key file owned by this user.
     - **Otherwise:** startup **fails closed** (unavailable for the life of the process). It never silently falls back to memory.
   - No technical conflict requires a single variable. The key file gives the store identity key a source the contract left unspecified.
   - PostgreSQL mode with either setting fails closed without calling `createPgRuntime`.
   - Diagnostics may name the storage mode (`memory` or `snapshot`) and a failure code, never a path, key or secret.
8. **Boundary.**
   - Only `src/server/runtime-access.ts` (`openRuntime`, with the startup barrier) may value-import `snapshot-store`. `src/server/mock-store-init.mts` (the operator initializer) is unchanged.
   - `src/lib/session/snapshot-state.ts` may use `import type` only.
   - `src/app`, `src/server/runtime.ts`, `respond.ts`, `handlers.ts` and `shopping.ts` may not import `snapshot-store` or `fs-ext`.
   - `runtime.ts` stays the only `process.env` reader.
   - A test asserts this exact boundary.

## 10. Implementation status (October 16, 2026)

Branch `feature/m2-1-snapshot-persistence` (from `6cc511c`). Uncommitted, pending review.
- **Slices 1–5 implemented** as reconciled in §9:
  - format 2;
  - the save-first gate and recovery;
  - durable runtime integration (`durable.ts`, `runtime-access.ts`, handlers, shopping, six pages, `respond.ts` 503 mapping);
  - retry wording for failed suggestions (EN/ES);
  - README setup;
  - `serverExternalPackages: ["fs-ext"]`.
- **Automated checks:** database-free suite 41 files and 1,243 tests passed; typecheck 0; lint 0 errors, 9 pre-existing warnings. Recorded no-TCP recipe; private evidence in `m2-1-persistence-20261016`.
- **Acceptance cases covered by tests:**
  1. restart recovery (real-store validation);
  2. eight-line cap;
  3. expired sessions not restored;
  4. cross-session refusal;
  5. stale writes before and after restart;
  6. supported change withdraws and persists; unsupported change keeps; re-confirmation after restart reopens;
  7. interrupted interpretation is restored as `unavailable` and a recommendation as `failed`, with no provider call;
  8. definite/indeterminate refusals return 503, start no provider and block;
  9. full suite, typecheck, lint.

  Also tested:
  - runtime start-up concurrency and failure;
  - allocation and admission windows saved before use;
  - pre-restart checkout intents absent after recovery.
- **Mock-only browser restart check: passed.** The same session, Spanish draft, conversation and confirmed suggestion survived a server restart. The suggestion-source sentence is process-local by design and is not restored.
- **Not done:** no commit or push; no VoiceOver; no PostgreSQL execution.

### Review corrections (October 16, 2026)
1. **Recovery distinguishes pending from completed interpretation claims.** A claim is pending only when `interpretationClaimVersion === version` and `notice === null`. `claimFollowUp` now writes that marker; completed claims keep their duplicate protection across restarts.
2. **An invalid `SHOPACCESS_PERSISTENCE_MODE` fails closed** (`PERSISTENCE_MODE_INVALID`) before any snapshot open, recovery write or runtime construction.

Tests and a red check were added. The suite now has 1,250 passing tests. The affected browser checks were repeated, bound to 127.0.0.1, and passed. The first restart check's server had listened on all interfaces; the private evidence records this.
3. **Review correction 2.** Pending interpretation work is now an explicit persisted flag, `interpretationPending`. It is independent of the notice, which confirmation clears, and of confirmed values, which a pending follow-up keeps. A completed interpretation or follow-up that was then confirmed survives a restart unchanged, with its duplicate protection. Format-2 snapshots require the flag; format-1 files derive it once on upgrade. The suite now has 1,253 passing tests. The confirm-then-restart browser check on 127.0.0.1 passed.
