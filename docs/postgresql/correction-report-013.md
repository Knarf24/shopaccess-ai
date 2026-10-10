# ShopAccess AI — PostgreSQL Specification Correction Report 013

Status: DRAFT, NOT APPROVED. Planning and documentation only. Nothing described here has been implemented or executed.

Sources: the specification through Correction Report 012 and the complete Codex Re-Audit 010, supplied as `~/Downloads/ShopAccess_AI_Codex_Reaudit_010_Full.txt`. The source-missing hold for Re-Audit 010 is removed. Its partially resolved finding is explicitly the evidence-integrity/shared-application-role issue: the application role could call ingestion functions and assemble current claim authority. The four Re-Audit 010 follow-up findings are mapped in §1.1 below. Re-Audit 010 is the review source, not an approval of proposed changes.

`[FACT]` marks repository facts. Everything else is proposed.

---

## 1. Resolution matrix

| Finding | Defect in Report 012 | Resolution |
| --- | --- | --- |
| C-13.1 HIGH | One database role served the web tier and the payment worker. A claim token could be assembled from readable columns | Two login roles with disjoint function grants. Dispatch is split into a buyer authorization (web) and a claim (worker). Claim credentials are random secrets; only a hash is stored, in a table neither role can read |
| C-13.2 MEDIUM | Operators had INSERT and UPDATE on the registry tables and could insert a row already `APPROVED` | Operators have no table privileges. Registration, approval and withdrawal are separate functions; an insert trigger accepts only `DISCOVERED` |
| C-13.3 MEDIUM | The quote digest was computed by the application and stored unverified | The database computes the digest from the stored quote in a versioned canonical encoding and re-verifies it before issuing and before consuming a challenge |
| C-13.4 LOW | Entry points were described, but no complete event allowlist existed | A table lists every entry point with its permitted events and actors, and the internal reducer mirror refuses anything not listed |
| C-13.5 HIGH | A one-time worker claim was not bound to the exact purchase authorization snapshot | Bind each authorization and resulting operation to the consumed buyer confirmation, immutable quote digest, owner, intent, purchase group, operation type, and exact adapter contract; recheck the entire snapshot at claim |
| C-13.6 HIGH | Separate database roles alone did not establish runtime-secret isolation | Require service-scoped deployment credentials; prohibit a shared deployment/build environment from exposing both web and worker credentials; retain the local same-OS-user limitation explicitly |

### 1.1 Reconciliation against the complete Re-Audit 010

| Re-Audit 010 item | Source finding | Correction 013 disposition |
| --- | --- | --- |
| Re-Audit 009 finding 1 | Partial payment-state mutation | Addressed in Report 012: retire `update_claimed_operation`; use complete entry points and a deferred integrity trigger. |
| Re-Audit 009 finding 2 | Evidence writes, reconciliation authority, and the shared app role's ability to call ingestion | Report 012 removed direct table writes and moved classification into the database; Correction 013 separates web/worker roles and makes claims unforgeable. Remaining provider/worker truthfulness is an explicit trust boundary, not cryptographic provider verification. |
| Re-Audit 009 finding 3 | Dispatch authorization and session ownership | Report 012's database session-digest lookup and owner derivation remain. Correction 013 adds the dispatch split and exact snapshot binding in §2.3. |
| Re-Audit 009 finding 4 | Direct checkout mutation and reducer bypass | Addressed in Report 012 by revoking application DML and restricting reducer events; Correction 013 enumerates the event allowlist. |
| Re-Audit 009 finding 5 | Finality standing omitted from risk fingerprint | Addressed in Report 012 §5.1 with finality standing, contract digest, and locking. |
| Re-Audit 009 finding 6 | Fingerprint encoding was underspecified | Addressed in Report 012 §5.2 with SARF-1. |
| Re-Audit 009 finding 7 | Provider call before confirmed outer commit | Addressed in Report 012 §3.5; the worker acts only after confirmed commit, with conservative handling of uncertainty. |
| Re-Audit 010 HIGH | Shared web/worker role, reconstructible claim token, and evidence-ingestion authority | Correction 013 §2.2–§2.4 and §2.6 separate grants and replace reconstructible tokens with secret claims, while documenting the trusted-worker evidence boundary. Runtime/deployment isolation is an explicit requirement in §2.1. |
| Re-Audit 010 MEDIUM | Operator could insert an already-approved adapter contract | Correction 013 §3 restricts operator actions to functions and requires every inserted contract to begin `DISCOVERED`. |
| Re-Audit 010 MEDIUM | Quote digest stored without database verification | Correction 013 §4 defines SAQD-1, database computation, and verification before challenge issue and consumption. |
| Re-Audit 010 LOW | Entry-point event allowlist incomplete | Correction 013 §5 enumerates the permitted event/actor/state/guard mapping. |

The full source is now available, so there is no unidentified Re-Audit 010 finding. This reconciliation is still a proposed design review; it does not establish owner approval or PostgreSQL execution.

---

## 2. C-13.1: separate web and worker authority

### 2.1 Roles

| Role | Login | Runs in | Holds credentials for |
| --- | --- | --- | --- |
| `shopaccess_owner` | No | Migration runner only | — |
| `shopaccess_web` | Yes | Web server process | Itself only |
| `shopaccess_worker` | Yes | Payment worker process | Itself only |
| `shopaccess_operator` | No (group) | — | — |
| Named operator logins | Yes | Operator's own session | Member of `shopaccess_operator` |

- `shopaccess_web` and `shopaccess_worker` are not members of each other or of any other role. Neither can `SET ROLE`. Neither is a superuser, can create roles, bypasses row security, or has CREATE on the schema.
- Each runtime's configuration contains exactly one database credential. The web process is never given the worker's, and the reverse.
- For hosted deployment, web and worker must be separate services with service-scoped runtime secrets. Do not put both credentials in a shared project/environment group, shared build environment, preview environment, or common process configuration. The web build/runtime must not receive the worker credential or any path that lets web code receive claim secrets; the worker must not receive the web credential or session-key material unless a separately approved need is documented. Keep raw claim secrets in worker memory only and exclude them from browser responses, logs, traces, errors, and audit events. Verify effective environment scopes before enabling either service.
- For local development this means two processes with two separate untracked environment files. On one machine under one operating-system account, either process could read the other's file; process separation alone does not prevent that. Local mock-only work therefore trusts the developer account. If that trust is not accepted, use separate OS identities or isolated containers. This is a stated limitation, not a claim of local hostile-process isolation (D-51).

### 2.2 Function grants

**Superseded.** The grant table in this section predates the owner-scoped read functions, the finality evidence functions and `retire_finality_suite`. The authoritative function-grant matrix is specification §3.3, and the table matrix is §3.2. Nothing here grants more than those do.

EXECUTE is revoked from PUBLIC on every function. No table privilege other than the SELECT grants in §2.5 exists for either role.

| Function | `web` | `worker` | `operator` |
| --- | --- | --- | --- |
| `admit_session`, `authorize_session`, `rotate_session`, `revoke_session` | yes | — | — |
| `start_checkout`, `issue_challenge`, `consume_challenge` | yes | — | — |
| `authorize_dispatch` | yes | — | — |
| `acknowledge_risk`, `cancel_checkout`, `record_buyer_return` | yes | — | — |
| `append_web_audit` | yes | — | — |
| `claim_authorized_dispatch`, `claim_for_recovery`, `confirm_claim` | — | yes | — |
| `ingest_operation_evidence`, `ingest_quarantined_evidence` | — | yes | — |
| `ingest_approval_evidence`, `ingest_post_capture_evidence` | — | yes | — |
| `expire_checkout`, `register_contract`, `append_worker_audit` | — | yes | — |
| `approve_adapter_dispatch`, `approve_adapter_finality`, `withdraw_adapter_dispatch`, `withdraw_adapter_finality` | — | — | yes |
| Every internal helper, including `apply_checkout_event` | — | — | — |

Requirement 1 is met by the first block being absent for `web`. Requirement 2 is met by `worker` having no buyer function and no way to present a session credential to one.

### 2.3 Dispatch split

Report 012's single `dispatch_operation` is replaced by two entry points and one new table.

**`dispatch_authorizations`** (new)

| Column | Notes |
| --- | --- |
| `id` | text PK, `^da_[0-9a-f]{32}$` |
| `checkout_intent_id`, `owner_id`, `purchase_group_id` | Composite FK to the intent |
| `quote_id`, `quote_digest` | Exact immutable quote snapshot authorized by the buyer |
| `confirmation_id`, `confirmation_status` | The exact consumed challenge; status is constrained to `CONSUMED` |
| `operation_type` | `ORDER_CREATE` or `CAPTURE` |
| `adapter_id`, `adapter_contract_version`, `adapter_contract_digest` | Exact server-selected, approved contract snapshot; never supplied by the browser or AI |
| `adapter_policy_id`, `adapter_policy_version`, `environment` | Exact server-selected policy row snapshot; never caller-supplied |
| `status` | `ISSUED`, `CONSUMED`, `REFUSED`, `EXPIRED`; only `ISSUED` may change, and only to one of the others |
| `issued_at`, `expires_at`, `resolved_at` | Database time |

Composite foreign keys bind the intent/owner/group, quote/intent/owner, consumed challenge/intent/status, adapter/version/digest, and full policy ID/environment/type/version/adapter tuple. A candidate key on the authorization covers `(id, checkout_intent_id, purchase_group_id, operation_type, adapter_id, adapter_contract_version, adapter_contract_digest)`; `payment_operations` references that key. A database-owned insert function/trigger must verify the authorization's quote and digest equal the current intent quote, its challenge equals the intent's current consumed confirmation and quote digest, and its adapter snapshot equals the exact active server-policy row. It must reject client-, AI-, or worker-supplied selection. At claim, re-lock and require that same policy row is still active; do not substitute a newer policy. Snapshot columns are immutable. Partial unique index: `(checkout_intent_id, operation_type) WHERE status = 'ISSUED'`. Append and status-only-update trigger, as for challenges.

`payment_operations` gains `authorization_id text NOT NULL UNIQUE` and `adapter_contract_digest`; its composite foreign key must match the authorization's intent, group, operation type, adapter ID, version and digest. **An operation cannot exist without the exact one-time buyer authorization that it consumes.**

**`authorize_dispatch`** (web; buyer-initiated)

Arguments: session credential, intent ID and new authorization ID. The function derives `ORDER_CREATE` only from `USER_CONFIRMED`, or `CAPTURE` only from `APPROVED_VERIFIED`; the caller cannot choose or override operation type.

1. Locks: session `FOR SHARE`; variant `FOR SHARE` (order only); owner row `FOR UPDATE`; intents in ascending ID; current consumed confirmation challenge; existing authorization row if present; then the active policy row `FOR SHARE`, selected adapter contract `FOR SHARE`, and registry rows of prior captures `FOR SHARE`, in global order. Read `t` after the final blocking lock.
2. Session authority (Report 012 §3.1): live session, owner taken from the session row, intent belongs to that owner. Derive operation type from the locked checkout state as stated above.
3. Checkout state, current quote and digest, exact consumed confirmation challenge and its quote digest, and G-1 to G-3 with E-1 to E-5.
4. Select the adapter contract only from a database-enforced server policy keyed by operation type and environment; never from client/AI/worker input. The policy must identify one exact adapter ID, version and digest. Require that exact contract sealed, digest-valid and currently dispatch-approved, and snapshot policy identity/version plus contract identity. If no unique active policy exists, refuse closed. The exact policy mechanism/value remains owner decision D-53.
5. If an earlier `ISSUED` authorization exists: if still live and snapshots match, return/refuse using that same authorization without creating another; if expired or its snapshot is stale, mark it `EXPIRED`/`REFUSED` under lock before issuing a replacement. Refused: one refusal audit row. Eligible: insert the fully bound authorization as `ISSUED`, expiring a short time after `t` (*120 s, proposal*), and an audit row.

It creates no operation and returns no claim credential. The web transaction wrapper must confirm COMMIT before the authorization is visible to the worker's database polling query. The worker discovers committed `ISSUED` authorizations by polling PostgreSQL; no web-to-worker message is authority, and the authorization ID is a locator, not a secret.

**`claim_authorized_dispatch`** (worker)

1. Locks: variant (order only); owner row `FOR UPDATE`; all relevant owner intents in ascending ID; exact confirmation challenge; authorization row `FOR UPDATE`; pinned active policy row `FOR SHARE`; then its adapter contract and prior-capture registry rows, sorted. Read `t` after the final blocking lock.
2. The authorization is `ISSUED` and `t < expires_at`. Otherwise mark it `EXPIRED` and return.
3. Re-lock the pinned policy; it must remain active and match its recorded environment/version and exact adapter contract. Require exact equality of authorization owner, group, intent, operation type, current quote ID/digest, current consumed confirmation ID/status/digest, and adapter ID/version/digest. Recheck quote/catalog validity and adapter seal/approval. No snapshot may be rebound to a new quote, confirmation, operation type, policy or adapter version.
4. Re-evaluate G-1 to G-3 under the owner and intent locks. Any changed or expired snapshot refuses and resolves the authorization without inserting an operation.
5. Refused: authorization becomes `REFUSED`; refusal audit.
6. Eligible, inside a subtransaction: insert the operation as `DISPATCHING` with fencing version 1; insert its claim row (§2.4); mark the authorization `CONSUMED`; apply the dispatched event with actor `operation_worker`; transition; audit; `SET CONSTRAINTS ALL IMMEDIATE`.
7. Return the claim secret to the worker wrapper; it is not usable until outer COMMIT is confirmed.

The dispatch linearization point is the worker's confirmed outer COMMIT of this call. The provider request follows it (Report 012 §3.5, unchanged). If the claim call's commit outcome is uncertain, the worker sends nothing unless it has the returned secret and `confirm_claim` verifies that exact secret as current before the call deadline. If the secret was not received, discard any local result and let recovery perform readback; do not fetch or regenerate the secret. An unreachable database means no call and conservative recovery.

The worker cannot dispatch without an unexpired, one-time authorization created under a live buyer session and bound to the exact consumed buyer confirmation, quote digest, intent, owner, purchase group, operation type and selected adapter contract. A changed, expired, cancelled or superseded snapshot cannot be reused. The buyer's confirmation is still required because an authorization can only be issued from `USER_CONFIRMED` or `APPROVED_VERIFIED`.

Hosted deployment is a separate verification gate: web and worker must be distinct services with service-scoped credentials, not merely separate variables in a shared project/environment group. No shared build, preview, release, or process configuration may expose the worker database credential or any path that lets web code receive worker claim secrets. Raw claim secrets stay in worker memory and are excluded from responses, logs, traces, errors, and audit events. Review effective configuration after platform inheritance and before enabling the worker. No deployment configuration was inspected for this proposal; this requirement is not evidence of actual isolation (D-54).

### 2.4 Claim credentials

**`payment_operation_claims`** (new, append-only)

| Column | Notes |
| --- | --- |
| `operation_id`, `fencing_version` | Primary key |
| `claim_verifier` | bytea, 32 bytes: SHA-256 of the claim secret |
| `claim_kind` | `INITIAL`, `TAKEOVER`, `RESEND` |
| `worker_id` | Informational |
| `claimed_at` | Database time |

- **Neither `web` nor `worker` has SELECT on this table.**
- A claim secret is 32 random bytes generated inside the database from its cryptographic random source. It is returned once, as the result of the claiming function, to the caller that made the claim. It is never stored and cannot be read back.
- The raw claim secret is confined to worker memory after return; it is never included in browser/web responses, logs, traces, errors, or audit events.
- Every later worker call for that operation presents `(operation_id, claim_secret)`. The function hashes the secret and requires it to equal the verifier of the row whose `fencing_version` equals the operation's current one.
- The secret has full entropy, so a plain hash is a non-reversible verifier.
- `operation_id`, `worker_id` and `fencing_version` remain readable and are no longer a credential. Knowing them gives nothing.
- A takeover inserts a new row with a new secret. The previous holder's secret no longer matches the current row, and it has no way to obtain the new one.
- `ingest_quarantined_evidence` accepts a secret that matches an **earlier** row for that operation. That is what "genuinely issued and superseded" now means.

Which random source to use is an open decision (D-48): the built-in UUID generator, called twice, or the `pgcrypto` extension.

Atomic settlement, recovery fencing, stable provider request IDs and the disabled capture resend are unchanged.

### 2.5 Read privileges

**Superseded by Targeted Correction 014 (§10.1).** The broad grants this section first proposed gave the buyer-facing web role direct SELECT on every owner's rows (RA011-001). The proposal is now:

| Table | `web` | `worker` |
| --- | --- | --- |
| Catalog; adapter registry and dispatch policies; `database_environment` | SELECT | SELECT |
| `server_key_versions` | SELECT | None |
| `shopper_sessions`, `checkout_owners`, `confirmation_challenges`, purchase groups, acknowledgments | **None** (owner-scoped read functions only) | None |
| `checkout_intents`, `quotes`, `quote_items`, `dispatch_authorizations`, `payment_operations` | **None** (owner-scoped read functions only) | SELECT |
| Observations, refund evidence, review queue, transitions | **None** | None |
| `payment_operation_claims`, `audit_events` | None | None |

The authoritative matrix is specification §3.2, with the read functions in §3.5.

### 2.6 What remains possible if a trusted party is compromised

| Compromised | Can | Cannot |
| --- | --- | --- |
| Web process | Replay credentials of buyers whose requests it handles; issue authorizations, confirmations and acknowledgments within those buyers' own eligibility, **without those buyers' gesture** (§10.4) | Claim, settle, ingest evidence, read another owner's rows, or act for a buyer whose credential it has not seen |
| Worker process | Claim any authorized or recoverable operation; submit well-formed false evidence for operations it holds a claim on; submit false approval or post-capture evidence for operations in the matching final state | Create an operation without a buyer authorization; act as a buyer; skip validation, reconciliation or the reducer; rewrite history; read another worker's successor claim |
| Adapter or provider | Report false outcomes that the worker relays | Anything the worker cannot |
| Operator login | Approve or withdraw adapter contracts | Register contracts, alter digests or provenance, touch payment data |
| Migration credentials | Everything | — |

---

## 3. C-13.2: adapter registration and approval

- Operators have **no table privileges** on `adapter_contracts`, `adapter_contract_status_order` or `adapter_contract_finality`.
- `register_contract` (worker) inserts the contract as `DISCOVERED`, inserts its status-order rows, computes the contract digest in the database from those rows, requires it to equal the digest the worker supplied, and seals the contract. A sealed contract's metadata rows can never be added to or changed.
- An insert trigger on `adapter_contracts` rejects any row whose `dispatch_status` is not `DISCOVERED` or whose provenance columns are set. This holds for every role, including the function owner.
- `approve_adapter_dispatch(adapter, version, expected_digest)` (operator): the row exists, is `DISCOVERED` and sealed; the digest recomputed from the stored metadata equals both the stored digest and `expected_digest`; each subject either has status-order rows or is explicitly declared to have none. Only then does the status become `APPROVED`.
- `approve_adapter_finality` requires the same digest checks and inserts a `VERIFIED` finality row. `withdraw_*` move a status to `WITHDRAWN`.
- Provenance is written by trigger from `session_user` and database time, and is immutable. The functions require `session_user` to be a member of `shopaccess_operator`.
- A contract that is unknown, unsealed, `DISCOVERED` or `WITHDRAWN` cannot be used for a new operation.

---

## 4. C-13.3: authoritative quote digest

### 4.1 Encoding `SAQD-1`

Bytes, in order:

1. ASCII `SAQD`, then version byte `0x01`.
2. Field count as a 2-byte big-endian integer: 19.
3. Nineteen fields. Each is one type byte, a 4-byte big-endian length, then the value. Type `0x01` is ASCII text. Type `0x02` is an 8-byte big-endian two's-complement integer (length 8).

| # | Field | Type |
| --- | --- | --- |
| 1 | quote ID | text |
| 2 | owner ID | text |
| 3 | checkout intent ID | text |
| 4 | purchase group ID | text |
| 5 | merchant ID | text |
| 6 | product ID | text |
| 7 | variant ID | text |
| 8 | catalog revision | integer |
| 9 | quantity | integer |
| 10 | unit amount, cents | integer |
| 11 | subtotal, cents | integer |
| 12 | discount, cents | integer |
| 13 | tax, cents | integer |
| 14 | shipping, cents | integer |
| 15 | total, cents | integer |
| 16 | currency | text |
| 17 | assumptions code | text |
| 18 | created at, microseconds since the Unix epoch, UTC | integer |
| 19 | expires at, same unit | integer |

The digest is SHA-256 over exactly those bytes, as 64 lowercase hex characters. `quotes` gains `digest_version text NOT NULL CHECK (digest_version = 'SAQD-1')`.

### 4.2 Where it is computed and verified

- `start_checkout` prices the quote from the catalog rows it has locked, sets both timestamps from `t`, computes the digest and stores it. The application supplies no digest and no amounts.
- `issue_challenge` recomputes the digest from the stored quote and quote item and requires it to equal `quotes.digest` before binding it into the challenge.
- `consume_challenge` recomputes it again and requires equality with `quotes.digest`, with the challenge's `quote_digest`, and with the digest the buyer submitted.
- Any mismatch: nothing is confirmed, no state changes, one audit row, result `QUOTE_DIGEST_MISMATCH`.

Because the database now sets quote timestamps, the earlier clock-skew tolerance for application-supplied quote times is no longer needed.

The approved foundation computes the digest as SHA-256 of canonical JSON that includes the session ID `[FACT: src/lib/quote/quote.ts]`. Whether mock mode adopts `SAQD-1` is an open decision (D-49).

### 4.3 Test vectors

Computed with a scratch script outside the repository. They have not been checked against a PostgreSQL implementation, because none exists.

Common values unless stated: owner `own_` + 32 × `2`; intent `ci_` + 32 × `3`; group `pur_` + 32 × `4`; merchant `dmm_shopaccessdemo`; product `dmp_codebook15`; variant `dmv_codebook15a`; catalog revision 1; discount, tax, shipping 0; currency `USD`; assumptions `SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1`; created `2026-10-08T12:00:00Z` (1791460800000000); expires `2026-10-08T12:15:00Z` (1791461700000000).

| Vector | Differences | Encoded length | SHA-256 |
| --- | --- | --- | --- |
| V1 | quote `qt_` + 32 × `1`; quantity 1; unit, subtotal, total 79900 | 411 bytes | `cbb8289475d0e6784dae938e4038a5fd54dbb423d350adf3f4fbebf7b4cde944` |
| V2 | quote `qt_` + 32 × `a`; quantity 2; subtotal and total 159800 | 411 bytes | `1763b05d5e4118f0d7dfac99e0f57c61e80eddbe02f52166e1c79fbddfe4b39c` |
| V3 | As V1 with unit, subtotal and total 79901 | 411 bytes | `1eebb6d9507c3efdb5e094cad29230150dca6c834c7d20a5f8022d20be13d693` |

V1 begins with the bytes `53 41 51 44 01 00 13 01 00 00 00 23 71 74 5f 31 …`.

---

## 5. C-13.4: reducer event allowlist

**`entry_point_event_allowlist`** (new): `(entry_point, event_type, actor)` is the primary key; loaded by migration; no role but the owner can change it. `apply_checkout_event` takes the entry-point name as a constant from its caller and refuses any event without a matching row, in addition to checking `checkout_transition_rules`. `checkout_transitions` gains an `entry_point` column recording it.

"Rule" below means the reducer's own guard for that event `[FACT: src/lib/payment/state-machine.ts]`. Every event that changes state writes the checkout row (state, full context, version), one transition row and one audit row. Evidence writes are listed where required.

| Entry point | Role | Event | Actor | Source states | Extra guard in the entry point | Result | Evidence written |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `start_checkout` | web | `QUOTE_ISSUED` | `server` | new intent; or `DRAFT`, `QUOTED` on re-quote | Session authority; variant priced under lock | `QUOTED`; quote pointer set, confirmation pointer cleared | — |
| `start_checkout` | web | `SUPERSEDED` | `server` | The seven stoppable states, on the replaced intent | Same owner and purchase group | `SUPERSEDED` | — |
| `consume_challenge` | web | `SHOPPER_CONFIRMED` | `shopper` | `QUOTED` | Session authority; challenge `ACTIVE` and unexpired; nonce and digests match | `USER_CONFIRMED`; confirmation pointer set | — |
| `authorize_dispatch`, `claim_authorized_dispatch` | web, worker | `QUOTE_INVALIDATED` | `server` | `USER_CONFIRMED` | Quote expired or variant changed at `t` | `DRAFT`; pointers cleared | — |
| `claim_authorized_dispatch` | worker | `ORDER_CREATE_DISPATCHED` | `operation_worker` | `USER_CONFIRMED` | Authorization `ISSUED`; adapter approved; G-1 to G-3 | `ORDER_CREATE_IN_FLIGHT`; order operation pointer set | — |
| `claim_authorized_dispatch` | worker | `CAPTURE_DISPATCHED` | `operation_worker` | `APPROVED_VERIFIED` | Same | `CAPTURE_IN_FLIGHT`; capture pointer set; `capture_dispatched` true | — |
| `record_buyer_return` | web | `BUYER_RETURNED` | `browser_redirect` | `AWAITING_APPROVAL`, `DECLINED_RETRYABLE` | Session authority | `APPROVAL_CHECK_PENDING` | — |
| `cancel_checkout` | web | `SHOPPER_CANCELED` | `shopper` | The seven stoppable states | Session authority | `CANCELED_LOCAL` | — |
| `expire_checkout` | worker | `EXPIRED` | `timer` | `DRAFT`, `QUOTED`, `USER_CONFIRMED` | `t` at or after the quote's expiry; for `DRAFT`, a fixed age (*24 h, proposal*) | `EXPIRED` | — |
| `ingest_operation_evidence` | worker | `ORDER_CREATED` | `provider_response` or `provider_readback` | `ORDER_CREATE_IN_FLIGHT`; or `ORDER_CREATE_UNKNOWN`, `RECONCILIATION_REQUIRED` | Current claim; evidence valid; reconciliation IDENTICAL or COMPATIBLE | `AWAITING_APPROVAL`; provider order ID set | Authoritative observation |
| same | worker | `ORDER_CREATE_REJECTED` | `provider_response` | `ORDER_CREATE_IN_FLIGHT` | Current claim | `FAILED_TERMINAL` | Authoritative observation |
| same | worker | `ORDER_CREATE_OUTCOME_UNKNOWN` | `operation_worker` or `reconciler` | `ORDER_CREATE_IN_FLIGHT` | Current claim; no response, or takeover | `ORDER_CREATE_UNKNOWN` | None (nothing observed) |
| same | worker | `ORDER_CREATE_REDISPATCHED` | `operation_worker` | `ORDER_CREATE_UNKNOWN`, `RECONCILIATION_REQUIRED` | Current claim; resend conditions 1 to 6 | `ORDER_CREATE_IN_FLIGHT` | Authoritative "not found" observation |
| same | worker | `ORDER_DETAILS_MISMATCH` | `provider_response` or `provider_readback` | `ORDER_CREATE_IN_FLIGHT`, `ORDER_CREATE_UNKNOWN`, `RECONCILIATION_REQUIRED` | Current claim; evidence invalid or reconciliation not compatible | `MANUAL_REVIEW` | Conflicting observation; review entries |
| same | worker | `CAPTURE_COMPLETED` | `provider_response` or `provider_readback` | `CAPTURE_IN_FLIGHT`; `CAPTURE_UNKNOWN`, `RECONCILIATION_REQUIRED`, `CAPTURE_PENDING_PROVIDER` | Current claim; evidence valid; reconciliation compatible | `CAPTURED_VERIFIED`; capture ID set | Authoritative observation |
| same | worker | `CAPTURE_PENDING` | same | `CAPTURE_IN_FLIGHT`, `CAPTURE_UNKNOWN`, `RECONCILIATION_REQUIRED` | Same | `CAPTURE_PENDING_PROVIDER` | Authoritative observation |
| same | worker | `CAPTURE_DECLINED` | same | `CAPTURE_IN_FLIGHT`, `CAPTURE_UNKNOWN`, `RECONCILIATION_REQUIRED`, `CAPTURE_PENDING_PROVIDER` | Same | `DECLINED_RETRYABLE`; capture pointer cleared | Authoritative observation |
| same | worker | `CAPTURE_OUTCOME_UNKNOWN` | `operation_worker` or `reconciler` | `CAPTURE_IN_FLIGHT` | Current claim | `CAPTURE_UNKNOWN` | None |
| same | worker | `CAPTURE_EVIDENCE_MISMATCH` | `provider_response` or `provider_readback` | The three capture-phase states and `RECONCILIATION_REQUIRED` | Current claim; evidence invalid or reconciliation not compatible | `MANUAL_REVIEW` | Conflicting observation; review entries |
| same | worker | `READBACK_INCONCLUSIVE` | `reconciler` | `ORDER_CREATE_UNKNOWN`, `CAPTURE_UNKNOWN` | Current claim; provider unavailable; under the escalation age | `RECONCILIATION_REQUIRED` | None |
| same | worker | `ESCALATED_TO_MANUAL_REVIEW` | `reconciler` | The two unknown states, `RECONCILIATION_REQUIRED`, `CAPTURE_PENDING_PROVIDER` | Current claim; over the escalation age, or resend prohibited, or a pending capture no longer found | `MANUAL_REVIEW` | Observation where one exists; review entry where required |
| `ingest_approval_evidence` | worker | `APPROVAL_VERIFIED` | `provider_readback` | `AWAITING_APPROVAL`, `APPROVAL_CHECK_PENDING` | Order operation `SUCCEEDED`; evidence names the recorded order and matches the quote | `APPROVED_VERIFIED` | Authoritative observation |
| same | worker | `APPROVAL_NOT_FOUND` | `provider_readback` | `APPROVAL_CHECK_PENDING` | Same; order not yet approved | `AWAITING_APPROVAL` | Authoritative observation |
| same | worker | `ORDER_DETAILS_MISMATCH` | `provider_readback` | `AWAITING_APPROVAL`, `APPROVAL_CHECK_PENDING`, `APPROVED_VERIFIED` | Details do not match, or the order is missing | `MANUAL_REVIEW` | Conflicting observation; review entry |
| same | worker | `EXPIRED` | `provider_readback` | Same three | Provider reports the order expired | `EXPIRED` | Authoritative observation |
| `ingest_post_capture_evidence` | worker | `REFUND_OBSERVED` | `provider_readback` or `provider_observation` | `CAPTURED_VERIFIED`, `PARTIALLY_REFUNDED_OBSERVED` | Capture operation `SUCCEEDED`; new refund rows | `PARTIALLY_REFUNDED_OBSERVED` or `REFUNDED_OBSERVED` | Authoritative observation; refund rows |
| same | worker | `REVERSAL_OR_DISPUTE_OBSERVED` | same | The first three paid states | Same | `REVERSED_OR_DISPUTED_OBSERVED` | Authoritative observation |

Entry points that raise **no** reducer event: all four session functions, `issue_challenge`, `acknowledge_risk`, `claim_for_recovery`, `confirm_claim`, `ingest_quarantined_evidence`, `register_contract`, both audit functions, and all operator functions.

`CAPTURE_REDISPATCHED` is in the reducer `[FACT]` and is on **no** allowlist row, because automatic capture resend is disabled.

---

## 6. Regression tests (planned, none executed)

PostgreSQL tests, multi-connection, with barriers; no sleeps. Kinds: **S** structural, **P** procedural inside a trusted function, **T** depends on a trusted actor.

### PGT-71: role separation and claims

| Case | Actor | Attempt | Expected | Kind |
| --- | --- | --- | --- | --- |
| a | web | `claim_for_recovery`, `claim_authorized_dispatch`, each `ingest_*`, `confirm_claim`, `expire_checkout` | Insufficient privilege | S |
| b | worker | Each buyer function; `SELECT` on `shopper_sessions` and `confirmation_challenges` | Insufficient privilege | S |
| c | web, worker | `SET ROLE` to the other; `SELECT` on `payment_operation_claims` | Refused | S |
| d | test, owner | Catalog audit of role attributes, memberships, grants and PUBLIC EXECUTE | Exactly §2.1, §2.2, §2.5 | S |
| e | worker | `claim_authorized_dispatch` with no authorization; with an expired one; with one for another intent | No operation; authorization `EXPIRED` where applicable; refusal audit; 0 provider calls | P |
| f | worker | Operation insert attempted without an authorization (scratch schema, owner role) | Rejected by NOT NULL and foreign key | S |
| g | worker A, worker B | A claims; lease expires; B takes over; A calls `ingest_operation_evidence` with its secret | Rejected as not the current claim; nothing changes. A's well-formed evidence is accepted only by `ingest_quarantined_evidence` | P |
| h | worker | `ingest_operation_evidence` with a secret built from the readable operation ID, worker ID and fencing version; with a random secret; with another operation's valid secret | Rejected; nothing changes | P |
| i | worker A | After takeover, any attempt to read or derive B's secret | No function returns it; table unreadable | S |
| j | web then worker | Full legitimate flow: authorize, claim, confirmed commit, provider call, settle | One authorization `CONSUMED`; one operation; one claim row; 1 provider call | P |
| k | web | Attempt authorization with forged quote, confirmation, owner, intent, operation type or adapter fields | No such caller-controlled fields; database derives and binds all values, or refuses | S, P |
| l | worker | Replay authorization, use it for another operation type/quote/confirmation/adapter, or claim after quote change, cancellation or expiry | Refused before operation insertion and provider call; one refusal audit | P |
| m | Two workers | Concurrent claims for one authorization and concurrent distinct intents in one purchase group | At most one operation for the authorization; purchase-group guard serializes and prevents duplicate capture | P |
| n | Adapter operator | Withdraw the selected contract between authorization and claim | Claim serializes with registry update and refuses if withdrawal wins; no operation/call | P |
| o | Deployment configuration review | Shared inherited environment exposes worker DB credential or an access path for web code to receive worker claim secrets | Gate fails; services remain disabled until effective scopes are separate | T |
| p | Worker restart / web transaction | Authorization commit followed by worker stop; separately, authorization transaction rollback | Committed authorization is discovered and claimed once after restart; rolled-back authorization is invisible; no provider call before confirmed worker-claim commit | P |

### PGT-72: adapter approval

| Case | Actor | Attempt | Expected | Kind |
| --- | --- | --- | --- | --- |
| a | operator | Direct `INSERT` of an `APPROVED` contract; direct `UPDATE` of `dispatch_status`; direct insert of a finality row | Insufficient privilege | S |
| b | owner, scratch schema | Insert of a contract row with `dispatch_status = 'APPROVED'` | Rejected by trigger | S |
| c | operator | `approve_adapter_dispatch` for an unknown contract; an unsealed one; with a wrong `expected_digest`; where stored metadata no longer hashes to the stored digest (scratch schema) | Refused each time; status unchanged | P |
| d | operator | Approval of a contract with a subject that has neither status-order rows nor an explicit "none" declaration | Refused | P |
| e | worker | `register_contract` supplying status `APPROVED`, or adding metadata to a sealed contract | Not possible: no such parameter; trigger rejects | S |
| f | operator | Approve, then withdraw | Provenance holds the operator's login and database time; cannot be altered; status cannot move back | S |
| g | worker | Claim under a contract that is unknown, `DISCOVERED` or `WITHDRAWN` | Refused `ADAPTER_NOT_APPROVED`; authorization `REFUSED`; no operation | P |

### PGT-73: quote digest

| Case | Attempt | Expected | Kind |
| --- | --- | --- | --- |
| a | Encode vectors V1 to V3 in the database and in TypeScript | Bytes and digests equal §4.3 | P |
| b | Stored digest altered in a scratch schema (quote triggers disabled by the owner); then `issue_challenge` | Refused `QUOTE_DIGEST_MISMATCH`; no challenge | P |
| c | Challenge issued; stored digest altered; then `consume_challenge` | Refused; checkout stays `QUOTED`; challenge stays `ACTIVE`; one audit row | P |
| d | Buyer submits a digest different from the stored one | Refused `CONFIRMATION_MISMATCH`; no state change | P |
| e | `start_checkout` called with any amount or digest argument | Not possible: no such parameters | S |

### PGT-74: event allowlist

| Case | Attempt | Expected | Kind |
| --- | --- | --- | --- |
| a | For every entry point and every one of the 26 event types, compare what the entry point can raise with the allowlist | Exactly the rows in §5 | P |
| b | web or worker calls `apply_checkout_event` | Insufficient privilege | S |
| c | Owner-role call of `apply_checkout_event` naming an entry point and an event not paired in the allowlist | Refused | P |
| d | `ingest_approval_evidence` while the order operation is not `SUCCEEDED`; `ingest_post_capture_evidence` while the capture is not `SUCCEEDED` | Refused; nothing written | P |
| e | Any path that would raise `CAPTURE_REDISPATCHED` | None exists; allowlist has no row | S |
| f | Rule, result and flow parity against the TypeScript reducer | Equal | P |

### PGT-75: legitimate non-final paths

| Case | Scenario | Expected | Kind |
| --- | --- | --- | --- |
| a | Capture reported pending, polled three times, then completed | `PENDING_PROVIDER` with one authoritative observation; no extra observations while unchanged; then `SUCCEEDED`, `CAPTURED_VERIFIED`. The deferred constraint trigger is satisfied at every commit | P, S |
| b | Provider call times out (no response) | Operation `UNKNOWN`, scheduled; checkout unknown; **no observation**; commit succeeds, because the trigger does not apply to `UNKNOWN` | P, S |
| c | Provider unavailable on readback, below and above the escalation age | Below: `RECONCILIATION_REQUIRED`, operation still `UNKNOWN`, rescheduled. Above: `MANUAL_REVIEW`, operation parked. No observation in either | P |
| d | Order creation explicitly rejected | Operation `REJECTED` with an authoritative observation and citing transition; `FAILED_TERMINAL` | P, S |
| e | Order resend permitted after "not found" | New claim row of kind `RESEND` with a new secret; same request ID; old secret rejected | P |

---

## 7. Consistency with earlier corrections

| Area | Effect |
| --- | --- |
| G-1 to G-3, E-1 to E-5 | Evaluated at authorization and again, authoritatively, at claim |
| Commit boundary (Report 012 §3.5) | Applies to the worker's claim. `confirm_claim` takes the claim secret |
| Deferred constraint trigger | Unchanged: applies to `SUCCEEDED`, `DECLINED`, `REJECTED`, `PENDING_PROVIDER` only. `UNKNOWN`, `DISPATCHING` and `CONFLICT` are outside it (PGT-75) |
| Coherence table | Unchanged. `PENDING` is still never written in PostgreSQL mode; the authorization row carries the "authorized, not yet claimed" condition |
| Risk fingerprint | Unchanged. Authorizations are not part of it |
| Lock order | The authorization row is locked at the same level as a confirmation challenge |
| Reducer | Unchanged. `ORDER_CREATE_DISPATCHED` and `CAPTURE_DISPATCHED` are now raised by the worker, which is the actor the reducer already names |
| Purchase groups, adapter pinning, reconciliation, "not found" precedence | Unchanged |

## 8. New owner decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D-47 | Lifetime of a dispatch authorization | 120 s |
| D-48 | Random source for claim secrets | Built-in generator if the selected version provides one; otherwise `pgcrypto` |
| D-49 | Adopt `SAQD-1` in mock mode as well | Yes, so both modes produce the same digest |
| D-50 | Scope of `expire_checkout` | As §5: pre-payment states only |
| D-51 | Accept two local processes with separate credential files | Yes; state the single-machine limitation |
| D-53 | Server-controlled adapter policy selecting an exact contract per operation type/environment | Require one database-enforced selection; fail closed on missing or ambiguous policy. Owner must approve policy ownership and activation semantics. |
| D-54 | Hosted web/worker credential isolation | Separate service-scoped secrets and effective-scope review; deployment gate, not established by this document |

D-44 (role split) and D-45 (secret claims) are technically specified as proposed controls, but remain OPEN pending explicit owner approval. D-53 and D-54 also remain OPEN as listed above. No design report closes an owner decision.

**Superseded in status by §12.** The owner has since recorded decisions for Groups 1 to 10; specification §17.1 governs. The recommendation above that Mock mode adopt `SAQD-1` (D-49) is withdrawn: Mock mode is unchanged.

## 9. Statement

Nothing was implemented, executed or tested. The tests in §6 and §10 are plans. The quote test vectors were computed by a scratch script, not by a database.

## 10. Targeted Correction 014 addendum (Re-Audit 011)

**Documentation only. Nothing approved, implemented, executed or tested.** The four Re-Audit 011 findings were supplied in the conversation, as stated in Targeted Correction Directive 014, and are addressed below. The report was not retained as a locally accessible file, so the corrections were not compared against its full text (specification §17.3). Section references are to `postgresql-specification-v2.0-draft.md`.

### 10.1 RA011-001 (HIGH): cross-owner database reads

- The web role's direct SELECT is removed from every owner-scoped and payment-sensitive table (§3.2). It keeps SELECT on the catalog, adapter registry, dispatch policies, environment row and key-version status only.
- Three read functions replace it: `read_checkout`, `list_owner_checkouts`, `list_blocked_purchases` (§3.5). Each takes the session credential `(key_version, token_digest)`, derives the owner from the live session row, filters on that owner, and returns one generic result for unknown, foreign and unauthorized targets. No function takes an owner ID as authority.
- §3.2 states how the absence of access is established: PUBLIC revokes and default privileges, no role membership, no column grants, no views or materialized views, no sequence privileges, row-level security not relied on. §3.5 covers definer settings, search path, error text, identifier guessing and timing.
- Worker SELECT is cut to authorizations, operations, intents, quotes, quote items, catalog and registry: what discovery and request construction need. The worker can still read every owner's intents and quotes; that is stated as a residual.
- New invariant I-21. §4.4, §5.4 and §6.5 updated to use the read functions.

### 10.2 RA011-002 (HIGH): unsupported finality approval

- §7.6 no longer treats inspection of the mock's source as meeting the finality guarantees. Every adapter outcome, including the mock's `DECLINED`, is **unverified** and retry after a decline is disabled.
- §7.7 adds fail-closed governance. New tables in §2.20: `adapter_finality_suites` (owner-migrated; **no rows seeded**), `adapter_finality_evidence` (immutable, bound to adapter, contract version, contract digest, outcome, reason class, suite version, suite digest and result digest), `adapter_finality_evidence_reviews` (a second person's verdict).
- The evidence-to-suite key and suite retirement were corrected again in §11.1 and §11.2.
- `approve_adapter_finality` requires checks A-1 to A-8 and stores the evidence ID, suite version and result digest on the finality row. F-25, F-26 and NOT NULL make a `VERIFIED` row without passing, accepted evidence impossible for every role.
- A passing result is defined: every required case executed, none skipped, errored or failed, covering each guarantee of §7.6, against the adapter with the cited contract digest.
- D-30 stays OPEN and its recommendation is now "do not approve now". New D-56 covers the governance tables and separation of duties. No PayPal finality guarantee is assumed.
- Stated limit: the database cannot observe a test run; the evidence row is an attestation by named operators.

### 10.3 RA011-003 (MEDIUM): nullable composite-key bypass

- `payment_provider_observations.operation_id` is NOT NULL (§2.15).
- `payment_refund_evidence.capture_operation_id`, `capture_operation_type`, `observation_id` and `observation_subject` are NOT NULL (§2.16). F-8, F-12, F-13 and the two type CHECKs are unchanged.
- §2.22 adds the general requirement and lists the keys that are nullable by design with the CHECK that guards each.
- Compatibility: every ingestion path resolves an operation before writing an observation, and refund rows are written only after the observation in the same transaction. Evidence naming no known operation is refused and not stored.
- D-52 is recorded as **proposed resolution pending owner approval**, not as approved.

### 10.4 RA011-004 (MEDIUM): web-process consent trust boundary

Added to §3.4, §5.3 and §17.4:

- the web process is trusted to collect and submit a genuine buyer confirmation;
- the nonce proves possession of the server key and a session credential, not a human gesture;
- a compromised web process can confirm and authorize for buyers whose credentials it sees;
- role separation limits the damage and does not remove this;
- stronger protection needs a separately trusted confirmation authority, which is not specified.

New D-57 puts the choice to the owner. PGT-79 asserts the limitation.

### 10.5 Planned regression tests (none executed)

| Finding | Tests |
| --- | --- |
| RA011-001 | PGT-77a (direct reads denied, all forms), 77b (foreign intent through read functions), 77c (own rows, fixed columns), 77d (bad credential), 77e (no owner selector), 77f (catalog audit incl. views, columns, PUBLIC), 77g (search-path shadowing), 77h (mutating entry points leak nothing), 77i (worker reads), 77j (full buyer flow); V-24 |
| RA011-002 | PGT-78a to 78j (negative approval, binding, review, digest, direct insert, immutability, default-disabled retry, version isolation, withdrawal), 78k (valid chain); RF-A to RF-F reworded; V-23 |
| RA011-003 | PGT-55a to 55d (direct SQL per nullable component and wrong-reference), 55e (catalog audit), 55f (legitimate flows), 55g (evidence with no operation) |
| RA011-004 | PGT-79 (asserted limitation) |

### 10.6 Traceability

| Finding | Corrected sections | Tests |
| --- | --- | --- |
| RA011-001 | §1.4 I-21, §3.2, §3.3, §3.5, §4.4, §5.4, §6.5, §14 step 0010 | PGT-77a–j, V-24 |
| RA011-002 | §1.4 I-19, §2.20, §2.22 F-25/F-26, §6.3, §7.5, §7.6, §7.7, §13.5, §14 step 0005 | PGT-78a–k, RF-A–F, V-23 |
| RA011-003 | §2.15, §2.16, §2.22 | PGT-55a–g |
| RA011-004 | §3.4, §5.3, §17.4 item 3, D-57 | PGT-79 |

### 10.7 Consistency check

| Area | Result |
| --- | --- |
| Two-step dispatch | Unchanged. `authorize_dispatch` and `claim_authorized_dispatch` read under their own definer privileges; neither depended on web SELECT |
| Role grants and worker recovery | Worker keeps SELECT on authorizations and operations, which polling and `claim_for_recovery` need. Function grants unchanged apart from the three web read functions and two operator evidence functions |
| Secret claims and fencing | Unchanged. `payment_operation_claims` remains unreadable; read functions return no claim or fencing field |
| Adapter approval and withdrawal | Dispatch approval unchanged. Finality approval gains evidence checks; withdrawal unchanged; a withdrawn finality row is not revived |
| Purchase-group locking | Unchanged. Read functions take no locks. Evidence functions lock the contract row first, inside the existing registry order |
| Capture retry and finality | E-5 text unchanged; it can now be satisfied only through §7.7. Automatic capture resend stays disabled (D-17) |
| Observation and refund evidence | NOT NULL added; keys, CHECKs, ledger trigger and ingestion order unchanged |
| Migration order | Step 0005 creates suites, evidence and reviews before the finality table; step 0010 creates the read functions and the narrowed grants |
| Tests | New identifiers PGT-77, PGT-78, PGT-79, PGT-55a–g, V-23, V-24. No existing identifier reused or retired |

### 10.8 Owner decisions touched

D-30 (recommendation changed, still OPEN), D-52 (proposed resolution, still OPEN), new D-55, D-56, D-57 (all OPEN). The consolidated table is specification §17.5. No decision is approved by this addendum.

## 11. Targeted Correction 015 addendum (Re-Audit 012)

**Documentation only. Nothing approved, implemented, executed or tested.** The four findings reached the author as stated in Targeted Correction Directive 015. No Re-Audit 012 file was found locally and its full text was not inspected. Section references are to `postgresql-specification-v2.0-draft.md`.

### 11.1 AR012-001 (HIGH): finality suite retirement

- Retirement is now one transaction, `retire_finality_suite` (§7.7): it locks the adapter's contract rows `FOR UPDATE`, then the suite row, sets `retired_at`, and moves every `VERIFIED` finality row citing that suite to `WITHDRAWN` with reason `SUITE_RETIRED`.
- Deferred constraint trigger CT-2 (§2.20) fails any commit that would leave a `VERIFIED` row citing a retired suite, including a direct update by the table owner.
- E-5 (§6.3) now requires *effective* finality: `VERIFIED` and an unretired suite, read under the contract row lock that authorization and claim already hold.
- Races with authorization, claim, approval, acknowledgment and recovery are tabulated in §7.7. Lock order is policy → contract → suite → finality (§13.3, §13.5).
- Retirement changes effective standing, which is in the risk fingerprint, so earlier acknowledgments stop satisfying G-3 in the same commit.
- Residual stated: a retry whose claim committed before retirement cannot be recalled, as with withdrawal.
- No retry is enabled and no suite, evidence or finality row is seeded.

### 11.2 AR012-002 (MEDIUM): invalid composite foreign key

`adapter_finality_suites` now declares `UNIQUE (suite_id, suite_version, suite_digest, adapter_id, outcome_status, reason_class)` (U-S1), and the evidence key F-27 references it. U-S1 contains the primary key, so it restricts nothing beyond it; it exists so the six-column reference is valid. Suite ID and version select the row and the remaining four columns must match it, which keeps the digest, adapter and outcome binding. Those columns are immutable. Migration step 0005 declares each referenced key with its table.

### 11.3 AR012-003 (MEDIUM): nullable F-10 operation citation

- New table CHECK on `checkout_transitions` (§2.18): `operation_id` is NULL exactly when the actor is `shopper`, `server`, `timer` or `browser_redirect`.
- §10.3 lists all 26 event types as operation-requiring or operation-free. `EXPIRED` is both, depending on actor, which is why the rule is keyed on the actor.
- The earlier statement that the observation pair CHECK guarded F-10 was wrong and is removed (§2.22).
- Operation-free events are preserved. Operation *type* is checked by functions and V-25, not by a key; listed as limitation 20.

### 11.4 AR012-004 (MEDIUM): refund foundation parity

Read from the code: `src/lib/payment/state-machine.ts` accepts `REFUND_OBSERVED` from `CAPTURED_VERIFIED` and `PARTIALLY_REFUNDED_OBSERVED`. The earlier tables said Milestone 001 had "no transition" for a second partial refund; that described the mock orchestrator (`src/lib/payment/orchestrator.ts`, which raises a partial-refund event only from `CAPTURED_VERIFIED`), not the reducer. Specification §17.2 row 7 and §17.5 C row 7 now say:

- the reducer transition is existing approved behaviour, unchanged, and is not a proposal;
- what PostgreSQL mode adds is the refund ledger, raising the existing event for each new refund fact, and a review entry for refund facts after a final refund state. Those remain proposed changes needing owner decision.

No reducer rule is added. No code was modified.

### 11.5 Planned tests (none executed)

| Finding | Tests |
| --- | --- |
| AR012-001 | PGT-78m (retirement after approval), 78n (CT-2), 78o (retirement concurrent with authorization and claim, three orders), 78p (fingerprint and acknowledgments), 78q (approval race), 78r (recovery); RF-A to RF-F repeated after retirement; V-23 |
| AR012-002 | PGT-78l (catalog audit of referenced keys; F-27 negatives) |
| AR012-003 | PGT-55h (each operation-requiring event with NULL), 55i (operation-free actor with an operation; `EXPIRED` both ways), 55j (wrong or unknown operation), 55k (legitimate flows); V-25 |
| AR012-004 | PGT-80a (rule parity), 80b (ledger sequence), 80c (documented mock difference) |
| Setup | PGT-67e and RF-A to RF-F now state their evidence setup and reference the chain of PGT-78k |

### 11.6 Owner decisions

No new decision number. D-56 now also covers who may instruct suite retirement. No decision was approved by that addendum. The shortlist it pointed to has been replaced by the register in specification §17.6 (see §12).

## 12. Owner-decision reconciliation and correction pass (documentation only)

**No implementation is authorized. Nothing was implemented, executed, installed, archived or tested.** This pass applies the owner's decision record for Groups 1 to 10 and closes findings B-1 to B-13 of the Owner Decision Reconciliation package. Section references are to `postgresql-specification-v2.0-draft.md`.

### 12.1 Decision statuses

Specification §17.1 now records, for every decision, one of: approved architectural policy; approved with restrictions; policy approved with exact configuration pending; deferred or disabled; deployment gate; historical source hold. No decision is shown as fully closed where a number, schema definition or function signature is still unapproved. §17.2 records all ten foundation differences as approved for PostgreSQL mode only, with Mock mode unchanged. §17.5 is kept as the record of alternatives, with a status note. §17.6 is replaced by the remaining-approval register and §17.7 holds the configuration schedule.

### 12.2 Newly recorded architectural approvals

| Approval | Recorded in | Not done |
| --- | --- | --- |
| The six uncommitted legacy migration drafts are archived before later replacement | §14, §17.1 D-3 | Nothing archived, moved, edited or deleted |
| D-28 typed enforcement also applies to transition citations | §2.18, §2.22, §10.3, §17.1 D-28 | Exact definitions remain unapproved |
| D-48 uses PostgreSQL 17 `pgcrypto`, 32 secure random bytes, through a restricted helper | §2.14, §3.3, §14, §17.1 D-48 | Extension not installed; no SQL run |

### 12.3 Contradiction closure

| # | Finding | Status | Resolved in |
| --- | --- | --- | --- |
| B-1 | Finality-suite SELECT stated two ways | Corrected: web and worker have none; §3.2 governs | §2.20 |
| B-2 | `retire_finality_suite` missing from the grant matrix | Corrected: listed with no grant | §3.3 |
| B-3 | Outdated function-grant table | Marked superseded | This report §2.2 |
| B-4 | D-38 limits had no normative text | Clarified: bounds and fail-closed behaviour; values unapproved | §6.6, §17.7; PGT-81 |
| B-5 | "Approvals are independent" against A-1 | Clarified: one-way dependency | §7.5 |
| B-6 | Suite retirement forces a new contract version | Documented; deferred with retry enablement | §7.7 |
| B-7 | Retention pointed at an undesigned deletion path | Corrected: history deletion not designed or authorized; 30-day figure excluded; challenge cleanup a proposal | §14, §17.1 D-11, §17.7 |
| B-8 | Reducer escalation from `APPROVAL_CHECK_PENDING` has no entry point | Clarified; no behaviour added | §10.2, §17.4 item 22 |
| B-9 | Uncertain-commit exception | Rule preserved; exception stated exactly; otherwise fail closed | §12.1 steps 5 and 7 |
| B-10 | Refund extent source | Clarified: derived by the database from the ledger | §9.9 |
| B-11 | Suite-retirement in-flight retry residual | Marked unresolved and unapproved; retries stay disabled | §7.7, §17.4 item 19, §17.1 D-42 |
| B-12 | D-15 and D-49 recommended changing Mock mode | Corrected: PostgreSQL mode only; Mock unchanged | §17.1, §17.2 |
| B-13 | Operation type checked by query only | Corrected as policy: typed keys for pointers and transition citations; definitions unapproved | §2.18, §2.22, §10.3; PGT-55l |

No correction widens a privilege, adds an authorization path, enables a retry or changes Mock mode.

### 12.4 Statement

Planned tests PGT-55l and PGT-81 were added and not executed. Every numerical value remains unapproved. Exact schema, function signatures, detailed grants, D-21, D-53 mapping and authority, D-19, manual-review resolution, finality approval and staffing, and a payment-capable consent authority remain open and are listed in specification §17.6.

## 13. Targeted correction: M-1, M-2, M-3 and draft expiry (documentation only)

**No implementation is authorized. Nothing was implemented, executed, installed, archived or tested.** These four findings come from Codex's documentation audit (conditional pass) and reached the author as stated in the owner's correction instruction; the audit report itself was not inspected. Section references are to `postgresql-specification-v2.0-draft.md`.

| Finding | Owner approval scope | Correction | Sections | Planned tests |
| --- | --- | --- | --- | --- |
| M-1 | D-38 capacity semantics approved as architectural policy. The limit of 10 is not approved | Capacity counts only active or unresolved groups. A group is fully resolved only when it has no `ISSUED` authorization, no non-final, parked or `CONFLICT` operation, is not blocked, and every intent is in a resolved state. Resolved history is retained and not counted. Exhaustion refuses new groups and deletes or alters nothing. Counting is under the owner row lock | §6.6, §17.1 D-38, §17.7 | PGT-81a to e (replaces PGT-81) |
| M-2 | F-10T is the authoritative replacement for F-10 | F-10 retired and removed from the register; F-10T listed with its referencing columns, the declared candidate key `payment_operations (id, checkout_intent_id, operation_type)`, the discriminator and the both-or-neither NULL rule. Intent pointers listed as F-6T and F-7T. Stale F-10 references corrected | §2.18, §2.22, §10.3, §14 (0007, 0009), §15.7, §15.8 | PGT-55j, PGT-55l, V-25 revised |
| M-3 | Atomic one-shot provider-dispatch guard approved as architectural policy | One process-local guard keyed by operation and fencing version, acquired synchronously before any asynchronous step, shared by every dispatch path, never reset. Captures only under an `INITIAL` claim. Bounded order-create resend unchanged: each `RESEND` claim is a new generation | §8.2, §12.1 steps 3 and 5, new §12.1a | PGT-82a to g |
| Draft expiry | Value not approved: **PROPOSED — OWNER APPROVAL REQUIRED: 24 hours** | Boundary rule stated with the document's existing convention: live while `t < boundary`, expired at `t >= boundary`. Applies to `DRAFT` only | §8.10, §17.7 | PGT-83a to f |

Earlier references in this report to F-10 (§11.3) and to PGT-81 (§12.3) are historical; read F-10T and PGT-81a to e.

**Remaining exact-schema and configuration approvals** (specification §17.6):

- the D-38 limits, the resolved/unresolved classification table, and query versus maintained counter;
- column names and definitions for F-10T, F-6T and F-7T, and whether F-6T and F-7T are deferrable;
- the worker threading model, guard data structure and eviction;
- the 24-hour draft age and the column that carries the draft-since time; the name of the refusal for re-quoting an expired draft.

**Cannot be closed by documentation:**

- **M-1.** The state model has no state for a concluded dispute or reversal, or for a final partial refund. Those groups are classed unresolved and consume capacity indefinitely while review resolution is deferred (D-12). No state was invented.
- **M-1.** The bound limits creation. Evidence arriving for a resolved group can raise the active count above the limit without any creation.
- **M-3.** The guard is worker code that the database cannot enforce. It rests on one thread of execution per worker process and is established only by PGT-82 against the mock adapter.

Capture resend and retry after a declined or rejected capture remain disabled. Mock mode is unchanged.

## 14. Owner approvals incorporated after targeted verification (documentation only)

**No implementation is authorized. Nothing was implemented, executed, installed, archived or tested.** Codex's verification report was not inspected by the author; its findings and the owner's decisions are taken from the owner's instruction. Section references are to `postgresql-specification-v2.0-draft.md`.

**Owner decisions incorporated**

| Decision | Recorded as | Sections |
| --- | --- | --- |
| D-38: 10 active or unresolved purchase groups per shopper, local MVP; not a lifetime limit | Approved value and policy | §5.2, §6.6, §17.1, §17.7 |
| Conservative unresolved-group classification | Approved | §6.6 |
| F-6T and F-7T type columns, paired nullability, fixed discriminators | Approved policy; columns registered | §2.9, §2.22, §14, §17.1 D-28 |
| Single-threaded worker event loop; atomic synchronous process-local one-shot guard; consumed capture guard never evicted | Approved architectural policy | §12.1a, §12.3, §17.1 D-29 and D-46 |
| Draft expiry: 24 hours from original creation; strict boundary; `start_checkout` refuses before the worker runs | Approved policy | §2.9, §5.2, §8.10, §17.7 |

**Schema-register correction.** F-6T and F-7T referenced `order_create_operation_type` and `capture_operation_type`, which were missing from the §2.9 column register. Both are now registered, each paired with its pointer (both NULL or both set) and fixed to `ORDER_CREATE` and `CAPTURE` respectively. F-6T and F-7T are proposed as non-deferrable: the operation row is always inserted before the pointer is set, so no transaction needs deferral. F-4 and F-5 stay deferrable. F-10T is unchanged.

**Correction to §13 of this report.** §13 proposed measuring draft expiry from the time an intent last entered `DRAFT`. The owner decided otherwise: the clock starts at original creation and is never reset. §8.10 and PGT-83c now say so. The field is the existing immutable `created_at`.

**Planned tests updated (none executed)**

- PGT-81a to e: limit stated as 10; refusal at 10 and success at 9; resolved history above 10 not counted; late evidence taking the count to 11 with records intact and creation still refused.
- PGT-55l and V-25: pointer and type-column pairing; wrong discriminator; catalog check that both columns exist and the keys are not deferrable; V-10 named as the backstop for the pointers.
- PGT-82c, d, f: no reuse after timeout, exception or cancellation, and no eviction; single-threaded acquisition ordering; stale and superseded claims.
- PGT-83a to f: measured from `created_at`; exact boundary; no reset on return to `DRAFT`; refusal before the worker runs; both lock orders on each side of the boundary.

**Remaining exact-schema choices**

- Exact data types, DEFAULT and CHECK wording and constraint definitions for the typed keys.
- Capacity count by query or maintained counter; the intents-per-group value (proposed 10, unapproved).
- How the 24-hour value is held; the name of the expired-draft refusal.
- Guard data structure; eviction of consumed order-create entries.
- Everything else in specification §17.6 and the proposed table of §17.7.

**Safety limitations still unresolved**

- The state model has no state or fact for a concluded dispute or reversal, a final partial refund, or a resolved review entry. Such groups stay unresolved and consume capacity indefinitely; no resolution workflow is specified (D-12).
- Late evidence can take a shopper above 10 unresolved groups. Records stay intact and creation stays refused.
- The one-shot guard is worker code that the database cannot enforce; it is established only by PGT-82 against the mock adapter.
- The in-flight retry residual after finality-suite retirement remains unresolved and unapproved. Capture resend and retry after a declined or rejected capture remain disabled. Mock mode is unchanged.

## 15. Final Gate A reconciliation — Increment 1 (documentation only)

**The owner approved the final Increment 1 Gate A design decisions. Gate B is not authorized. Nothing was implemented, executed, installed, archived or tested, and no secret was generated.** Section references are to `postgresql-specification-v2.0-draft.md`. Earlier entries in this report are unchanged; where they describe proposals, those were proposals at the time.

### 15.1 Decisions reconciled

| Decision | Recorded in |
| --- | --- |
| Owner ID generated in PostgreSQL from `gen_random_uuid()`: `own_` plus 32 lowercase hex; opaque, not a credential; not supplied by the caller; not exposed by the Increment 1 session service; no extension needed | §2.4, §4.5, §18.2, §18.3 |
| Session `row_version`: starts at 1; plus exactly one per accepted update; unchanged for read-only authorization, refusals, repeated revocation and rollbacks | §2.5, §18.2 |
| Check value: HMAC-SHA-256 over `shopaccess.keycheck.v1`, a zero byte and the purpose name; 64 lowercase hex; no key material in the database, logs, responses or audit; no key bytes shared between the two rings | §2.3, §18.5 |
| Staged keys; the database `ACTIVE` version decides admission; fail-closed on a missing or mismatched active key; operator activation; emergency revocation; Mock single key unchanged | §4.2, §18.5 |
| Schemas `shopaccess` and `shopaccess_api`; non-login function owner `shopaccess_definer`; explicit EXECUTE grants; no runtime table writes; no runtime migration credentials; no worker grant in Increment 1; no temporary objects for runtime roles; fixed search path `pg_catalog, pg_temp` | §3.1, §3.3, §3.5, §18.4 |
| Integrity checks for check-value format, revoked status against `revoked_at`, migration version and checksum formats, and row-version transitions | §2.1, §2.3, §2.5, §18.2 |
| Catalog: existing monetary type and ranges kept; no fixture revision in a CHECK; no new restrictions; fixture equality by planned test | §2.6, §18.2 |
| PostgreSQL-mode cookie `version.token`, strictly parsed; version is a routing hint; no fallback; Mock cookie unchanged | §4.4, §18.7 |
| Test clock: backdated fixtures; internal helpers with an explicit time; production entry points on database time only; no caller clock; no test-owner access at runtime | §18.8, §17.1 D-19 |
| `append_web_audit` deferred to Increment 2; operator events `KEY_VERSION_ACTIVATED` and `KEY_VERSION_REVOKED` written atomically; refusals and repeats write nothing | §2.21, §3.3, §18.6 |
| Six trusted entry-point functions with typed parameters, return columns, result codes, locks and tests | §18.3 |
| Nine physical tables | §18.1 |
| Approved values: 500 live sessions; 30 admissions per minute; 2-hour idle timeout; 24-hour absolute lifetime; 60-second touch threshold; 2 s lock timeout; 5 s statement timeout; 10 s idle-in-transaction timeout; at most 3 database-only re-runs | §4.5, §13.1, §17.1, §17.7 |

The limit of 10 active or unresolved purchase groups and the 24-hour draft expiry from original creation are retained. No Increment 2 or Increment 3 value was marked approved.

### 15.2 Corrections to earlier text

- **Function owner.** Specification §3.1, §3.3 and §3.5, and §2.1 of this report, named the migration role as owner of every function. Superseded: entry points are owned by `shopaccess_definer`. Maintenance functions granted to nobody stay with the migration role.
- **Search path.** `pg_catalog, shopaccess, pg_temp` is replaced by `pg_catalog, pg_temp` with schema-qualified references.
- **Active key.** "Configured active version" is replaced by the database-designated `ACTIVE` version.
- **Web audit function.** This report's §2.2 and the specification's function matrix list `append_web_audit` as a web function. It is not created in Increment 1.
- **Tenth table.** Migration step 0001 listed `database_environment`. It is not an Increment 1 table and moves to the increment that introduces adapter policies.
- **Catalog.** An earlier Gate A proposal to require each row's revision to equal the fixture's revision in the schema is not adopted; equality is a test.
- **Role name.** Gate A packages called the migration role `shopaccess_migrator`. The specification's existing name, `shopaccess_owner`, is kept; they are the same role.

### 15.3 Planned tests added (none executed)

PGT-84 (catalog fixture equality), PGT-85 (cookie parsing), PGT-86 (key ring, staged and emergency behaviour), PGT-87 (row version), PGT-88 (Increment 1 privilege audit), PGT-89 (operator audit events), PGT-90 (test-clock safety).

### 15.4 Legacy drafts and tests

Not authorized and not done: archiving the six drafts; editing `src/lib/db/queries.ts`; editing MIG-01, SQL-01 or the static migration checks in `tests/unit/environment.test.ts`. Those tests cannot remain byte-for-byte unchanged once the sequence is replaced; their coverage is to be preserved through controlled updates under Gate B. The legacy query module stays isolated from the proposed PostgreSQL runtime (§18.9).

### 15.5 Remaining for Gate B

1. Archive destination and authorization.
2. Exact implementation file scope.
3. Permission to write code and migrations.
4. Permission to update the legacy-bound tests; a decision on the legacy query module.
5. Separate permission for local PostgreSQL 17 setup, migrations and test execution.
6. The two key-ring environment-variable names and the entry syntax, which remain proposals.

### 15.6 Files

Inspected read-only: the two authorized documents; `src/lib/session/service.ts`, `store.ts`, `token.ts`, `cookie.ts`; `src/lib/shared/ids.ts`, `crypto.ts`; `src/lib/security/audit.ts`; `src/server/handlers.ts`, `config.ts`; `src/lib/payment/orchestrator.ts`, `state-machine.ts`; `src/lib/catalog/schemas.ts`, `merchant-catalog.ts`; `src/lib/db/queries.ts`; `db/migrations/0001` to `0006`; `tests/unit/environment.test.ts`.

Edited: `docs/postgresql/postgresql-specification-v2.0-draft.md` and this report. No other file.

No implementation, SQL, database operation, test run, dependency or extension installation, Git change, commit or deployment occurred.

## 16. Gate B-W — Increment 1 written, not executed

**The owner authorized Gate B-W only. Gate B-X is not authorized: PostgreSQL was not installed or started, no SQL was executed, no migration was applied, no database connection was made and no database integration test was run.** Section references are to `postgresql-specification-v2.0-draft.md`.

### 16.1 Owner decisions applied

| Decision | Recorded in |
| --- | --- |
| `SHOPACCESS_SESSION_KEYS` and `SHOPACCESS_NONCE_KEYS`; strictly parsed comma-separated `version:base64key`; at least 32 decoded key bytes | §18.5, §17.1 D-21 |
| Six legacy drafts archived at `db/migrations/archive/milestone-001-unexecuted/`, same names, same bytes | §14, §18.9 |
| Increment 1 is an independently testable library, not wired into the application until Increment 2 | §18.10, §18.11 |
| Contiguous migration files `0001` to `0006`; step numbers in §14 are no longer file numbers | §14, §18.1 |
| `SHOPACCESS_PG_TEST_ADMIN_URL` for the disposable-database harness | §18.11 |
| Legacy query module and Mock behaviour preserved | §18.9, §18.11 |

### 16.2 Corrections to earlier text

- Specification §14 numbered the full design 0001 to 0011, with audit at 0008 and functions at 0010. Those are step labels. Files are numbered contiguously per increment; the mapping is tabled in §14.
- §18.5 listed the variable names and entry syntax as proposals. They are approved.
- §18.9 and §18.10 said archiving and writing were unauthorized. Both were authorized under Gate B-W and done; execution remains unauthorized.
- §15 of this report listed the key-ring names as remaining for Gate B. Closed.

### 16.3 Open issue recorded

The library under `src/lib/pg` contains no SQL text, because Milestone 001's SQL-01 test forbids it in any `src` module other than the legacy query module and that test could not be changed. Statements are passed in through interfaces and are defined provisionally in `tests/db/harness.ts`. The production location of the statement catalogue is an owner decision needed before Increment 2 (§18.11, §17.6).

### 16.4 Files

The full list, the static test results and the Gate B-X plan are in `docs/postgresql/increment-1-implementation-report.md`.

## 17. Gate B-W targeted corrections after the independent audit

**Codex's independent audit of the Increment 1 implementation returned FAIL**: three high-severity defects, four medium-severity findings, one low-severity finding and a missing production statement catalogue. The owner authorized targeted corrections in named files only. **Gate B-X remains unauthorized: PostgreSQL was not installed or started, no connection was made, no SQL was executed, no migration was applied and no database integration test was run.** Section references are to `postgresql-specification-v2.0-draft.md`.

The audit report was not available when the corrections were written. The findings below are as listed in the owner's authorization, each reproduced by reading the source.

### 17.1 Findings and corrections

| # | Finding | Correction | Files | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| 1 (high) | Admission skipped a locked, near-expired session, did not count it, and its touch then made it live: more than 500 live sessions | Capacity counts every remaining row; lock order documented | `db/migrations/0006` | Static: `pg-static`. Database (never run): two capacity/touch tests in `tests/db/sessions.test.ts` | Closed by static review; needs execution |
| 2 (high) | Migration statements could travel on different connections | Pinned connection through an explicit contract; release in `finally` | `src/lib/pg/client.ts`, `migrate.ts` | `pg-migrate` (fake connections) | Closed by static review; needs execution |
| 3 (high) | Harness trusted roles and databases by name | Pristine-cluster rule; role attributes and memberships verified before logins | `tests/db/harness.ts` | `pg-harness` | Closed by static review; needs execution |
| 4 | Discovery followed symlinks; line-based transaction-control check | Realpath; six-file inventory pinned by SHA-256; statement-level scan | `src/lib/pg/migrate.ts` | `pg-migrate`, `pg-static` | Closed by static review |
| 5 | Failed setup leaked resources | Tracked resources; cleanup on every path; original error kept | `tests/db/harness.ts` | `pg-harness` (failure injection) | Closed by static review; needs execution |
| 6 | PGT-04 and PGT-54a missing | Written, with a real two-process test | `tests/db/admission-processes.test.ts`, `sessions.test.ts` | Themselves (never run) | Partially closed |
| 7 | Key ring kept and exposed mutable buffers | Copies in and out; `loadKeyRings` boundary | `src/lib/pg/key-ring.ts`, `session-service.ts` | `pg-key-ring`, `pg-session-cookie` | Closed by static review |
| 8 | Rotation trusted a caller-supplied session object | Bound rotation; ID returned by `rotate_session` | `db/migrations/0006`, `src/lib/pg/session-service.ts`, `statements.ts` | `pg-session-cookie`, `pg-static`; database test (never run) | Closed by static review; needs execution |
| 9 | No production statement catalogue | `src/lib/pg/statements.ts`; SQL-01 allows exactly that file | `statements.ts`, `tests/unit/environment.test.ts` | `pg-static`, SQL-01 | Closed by static review |

Details are in §18.12.

### 17.2 Corrections to earlier text

- §4.5 step 5 said admission counts live sessions by the liveness predicate. It now counts every remaining row.
- §13.6 and §18.3 described `admit_session` as locking the guard and skipping locked sessions. Both now also state the key-version lock and the count.
- §18.3 gave three return columns for `rotate_session`. It returns four: `session_id` was added.
- §14 described the runner without a connection contract or inventory. Both are now stated.
- §18.11's disposable-database rule accepted the five ShopAccess roles, test logins and harness-prefixed databases if already present. That is withdrawn: any pre-existing role or database is a refusal.
- §16.3 of this report recorded the statement-catalogue location as open. Closed by owner decision.
- `increment-1-implementation-report.md` said PGT-04 and PGT-54a had no dedicated test and that the library holds no SQL. Both are superseded by its section 8.

### 17.3 Contract change to note

`rotate_session` gained a return column. This follows the owner's correction 8, which allowed returning the authoritative session ID from the database. No parameter, result code or lock changed.

### 17.4 Not changed

The bootstrap file; migrations `0001` to `0005`; the six archived drafts and their README; the legacy query module; Mock behaviour; both test configurations. No dependency was added.

### 17.5 Verification

Type check and lint pass. Database-free unit tests: 16 files, 425 passed, 1 skipped (MIG-01). The 234 tests that predate Increment 1 all pass. **Database tests: not run.**

## 18. Gate B-W final hardening after the re-audit

**Codex's second independent audit returned CONDITIONAL PASS.** The owner authorized a final hardening pass limited to named files. **Gate B-X remains unauthorized: PostgreSQL was not installed or started, no connection was made, no SQL was executed, no migration was applied and no database integration test was run.** A further independent review is required before Gate B-X is considered. The re-audit document was not available to the implementer; the items below are as listed in the owner's authorization. Details are in specification §18.13.

### 18.1 Findings and corrections

| # | Finding | Correction | Files | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Bootstrap adopted existing roles | Refuse first; one transaction; verify before commit | `db/bootstrap/0000_roles_and_schemas.sql` | `pg-static` (structure only) | Closed by static review; needs execution |
| 2 | Two harness invocations could interleave | Cluster-wide advisory lock for the whole lifecycle; no drops once control is lost | `tests/db/harness.ts` | `pg-harness` (fake lock) | Closed by static review; needs execution |
| 3 | SQL-01 missed multiline SQL | Multiline pattern; two exact paths | `tests/unit/environment.test.ts`, `pg-static.test.ts` | SQL-01, `pg-static` | Closed |
| 4 | Ring purpose mutable at run time | Private field; frozen; no subclasses | `src/lib/pg/key-ring.ts` | `pg-key-ring` | Closed |
| 5 | Malformed client abandoned | Released for destruction, then refused | `src/lib/pg/client.ts` | `pg-migrate` | Closed |
| Residual | Lost `CREATE DATABASE` acknowledgment | No change: nothing unconfirmed is dropped; next run refuses the cluster | — | `pg-harness` | Reviewed; accepted limitation |

### 18.2 Corrections to earlier text

- §17.4 of this report and specification §18.12 said the bootstrap file was unchanged and did not check existing roles. It now refuses them.
- Specification §18.4 step 1 now states that refusal.
- `increment-1-implementation-report.md` section 8.5 item 2 is superseded by its section 9.
- SQL-01's allowlist was one path suffix and one exact path. It is now two exact paths.

### 18.3 Consequence to note

The bootstrap can now succeed once per cluster. A second ShopAccess database in the same cluster is refused. This matches the approved pristine-cluster setup.

### 18.4 Verification

Type check and lint pass. Database-free unit tests: 16 files, 447 passed, 1 skipped (MIG-01). **Database tests: not run.**

## 19. Gate B-W two-issue closure after the third audit

**Codex's third independent audit returned CONDITIONAL PASS** with no high-severity source defect and two medium-severity issues. The owner approved the two-issue scope and chose, for the first, to move all applicable cluster-level statements onto the lock-owning session. **Gate B-X remains unauthorized: PostgreSQL was not installed or started, no connection was made, no SQL was executed, no migration was applied and no database integration test was run.** The audit document was not available to the implementer. Details are in specification §18.14.

### 19.1 Findings and corrections

| # | Finding | Correction | Files | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| 1 (medium) | Lock on one connection, `CREATE DATABASE` and other cluster-level statements on others | All cluster-level statements on the lock-owning session, one per message, never in a transaction; uncertain outcomes stop all cleanup | `tests/db/harness.ts` | `pg-harness` | Closed by static review; needs execution |
| 2 (medium) | SQL-01 upper-case only | Case-insensitive pattern; same two-file allowlist | `tests/unit/environment.test.ts`, `pg-static.test.ts` | SQL-01, `pg-static` | Closed |

### 19.2 Corrections to earlier text

- Specification §18.13 said only upper-case keywords are matched, and listed that as a remaining limitation. Both are superseded.
- Specification §18.13 described a short interval between a control confirmation and the next statement. For cluster-level statements it no longer exists; for work inside the test database it remains.
- `increment-1-implementation-report.md` section 9.4 items 3 and 5 are superseded by its section 10.

### 19.3 Verification

Type check and lint pass. Database-free unit tests: 16 files, 474 passed, 1 skipped (MIG-01). **Database tests: not run.**

