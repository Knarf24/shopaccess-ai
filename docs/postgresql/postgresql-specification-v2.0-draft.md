# ShopAccess AI — PostgreSQL Persistence & Recovery Specification v2.0

**DRAFT — ARCHITECTURAL POLICIES RECORDED AS OWNER-APPROVED (§17.1) — INCREMENT 1 WRITTEN UNDER GATE B-W (§18.11) — INDEPENDENT AUDIT VERDICT FAIL, TARGETED CORRECTIONS WRITTEN AND NOT EXECUTED (§18.12) — RE-AUDIT VERDICT CONDITIONAL PASS, FINAL HARDENING WRITTEN AND NOT EXECUTED (§18.13) — THIRD AUDIT VERDICT CONDITIONAL PASS, TWO-ISSUE CLOSURE WRITTEN AND NOT EXECUTED (§18.14) — INCREMENT 1 EXECUTED UNDER GATE B-X ON A DISPOSABLE POSTGRESQL 17.11 CLUSTER: SECOND RUN 41 PASSED, 0 FAILED, 0 SKIPPED (§18.15) — INCREMENT 1 FORMALLY ACCEPTED BY THE PROJECT OWNER — INCREMENT 2.1 DOCUMENTATION INDEPENDENTLY REVIEWED; DESIGN-ONLY, NOT IMPLEMENTED OR DATABASE-TESTED — INCREMENT 2 GATE A REMAINS OPEN — NO OTHER DATABASE EXECUTION AUTHORIZED — INCREMENT 2 GATE A CONTRACT RECORDED (§19): INCREMENT 2.1 APPROVED FOR DESIGN ONLY — EVERY OTHER LATER INCREMENT NOT APPROVED IN DETAIL — NO IMPLEMENTATION OF ANY LATER INCREMENT AUTHORIZED**

| | |
| --- | --- |
| Status | Consolidated draft for independent review |
| Consolidates | Specification v1.1, v1.2, v1.3 and Correction Reports 007 to 013, with Targeted Corrections 014 (RA011-001 to RA011-004) and 015 (AR012-001 to AR012-004) applied in place |
| Normative text | Sections 1 to 19 of this document only. For Increment 1, §18 governs where an earlier section differs. For Increment 2, §19 governs where an earlier section differs |
| Non-normative | Appendices A and B, and every earlier document listed in Appendix B |
| Verification | **Increment 1 only: executed.** Its bootstrap file, six migrations and seven database test files ran on a disposable PostgreSQL 17.11 cluster under Gate B-X; the record, its evidence and its limits are in §18.15. **Everything else: none executed.** For every later increment, each statement about constraints, locking, atomicity and privileges is design reasoning, and no SQL, migration or database test has been run. Sections written before the Gate B-X runs, including §18.11 to §18.14, say that nothing had been executed; that was true when they were written and they are kept as written |

Reading conventions:

- **[APPROVED-M1]**: behaviour of the accepted Milestone 001 mock foundation, verifiable in the repository.
- **[PROPOSED]**: PostgreSQL behaviour proposed for Milestone 002. Everything not tagged is proposed.
- **OPEN (D-n)**: written before the owner's decision record of Groups 1 to 10 was applied. Where it still appears in §1 to §16 it now means only that the **exact value, schema detail or signature** beside it is unapproved. The status of the decision itself is the one in §17.1, which governs.
- **PROPOSED — OWNER APPROVAL REQUIRED**: an exact technical choice the owner has not approved, even where the policy behind it is approved.
- **HOLD**: something this document cannot settle from the available sources. See §17.3.
- *(proposal)* after a number: an unapproved value.
- `t`: the **decision timestamp** of a transaction (§13.2).

---

## 1. Scope, milestones and security invariants

### 1.1 Milestones

| Milestone | Content | Status |
| --- | --- | --- |
| 001 | Mock-only foundation: in-memory stores, pure payment reducer, mock adapters, demo flow | Accepted and closed |
| 002 | PostgreSQL persistence and recovery, as specified here, against the mock adapter only | **Increment 1 only** (sessions, keys, catalog, audit table): written under Gate B-W and executed under Gate B-X on a disposable cluster (§18.11 to §18.15); formally accepted by the project owner, and the accepted baseline remains unchanged; not wired into the application. **Increment 2.1:** an independently reviewed, design-only specification (§19); not implemented and not database-tested; Increment 2 Gate A remains open. **Every later increment: not authorized.** Planning and review only |
| Later gates | Real PayPal, external AI, Channel3, public deployment | Not authorized; requirements in §16 |

### 1.2 Scope of this document

In scope: the durable schema, database roles, trusted entry points, transaction protocols, evidence handling, recovery, and the tests that would verify them.

Out of scope: user interface, the mock adapters' internals, any real provider, hosting, and the resolution of manual-review items (D-12).

No assumption from any other project's payment provider, database platform or hosting is carried into this document.

### 1.3 Relationship to the approved foundation

- The TypeScript reducer **[APPROVED-M1: `src/lib/payment/state-machine.ts`]** remains the reference definition of legal checkout transitions. Its 22 checkout states and 26 event types are unchanged.
- The nine operation states **[APPROVED-M1: `src/lib/payment/operations.ts`]** are unchanged as a set. PostgreSQL mode never writes `PENDING` or `READBACK_CLEARED`.
- Mock mode continues to run on the in-memory stores. It implements none of the database controls in this document. Known behavioural differences are listed in §17.2.

### 1.4 Security invariants

| # | Invariant |
| --- | --- |
| I-1 | Live sessions never exceed 500, and new sessions never exceed 30 per window, across all server instances |
| I-2 | An expired or revoked credential, or one under a key version that is not accepted, never authorizes anything |
| I-3 | No checkout record is created for a credential that is not live at the creating transaction's `t` |
| I-4 | Checkout data belongs to a durable owner, never to a credential row |
| I-5 | Session cleanup never deletes an intent, quote, challenge, authorization, operation, observation, transition, review entry or audit row |
| I-6 | Quotes are immutable, priced only from the merchant catalog inside the database, and bound by a database-computed digest |
| I-7 | At most one `ACTIVE` and at most one `CONSUMED` challenge per quote; challenge status never moves backward; an intent's confirmation pointer names only a `CONSUMED` challenge of that intent |
| I-8 | One order-create operation per intent; at most one capture operation per **purchase group** that is not `DECLINED` or `REJECTED` |
| I-9 | A logical operation keeps one provider request ID and one pinned adapter contract for its whole life |
| I-10 | (a) An operation row changes only through a claim acquisition, a recovery takeover, or a call presenting the current claim secret; a final operation never changes. (b) Checkout transitions derived from provider evidence fall into three classes with distinct authority (§8.6). (c) A superseded claim changes nothing; it may only submit evidence for quarantine |
| I-11 | An expired lease means "outcome unknown", never "failed" |
| I-12 | Observation, operation outcome, checkout state, context, version, transition, review entries and audit commit together or not at all. An operation outcome is never committed without the checkout change it implies. Operation and checkout states satisfy the coherence table (§7.4) |
| I-13 | Every state change has exactly one transition row, with consecutive versions |
| I-14 | A provider-sourced transition cites an observation of the same intent that is not quarantined |
| I-15 | Evidence and audit rows are append-only, typed and bounded |
| I-16 | No dispatch occurs in a purchase group that is paid or blocked, nor in any group while another of the owner's groups is blocked without a current risk acknowledgment (§6) |
| I-17 | No application role can write any table. Every change goes through a complete trusted entry point (§8) |
| I-18 | An operation exists only if a buyer authorization, issued under a live session, was consumed by a worker claim |
| I-19 | An adapter contract can be used for dispatch only after explicit operator approval of a sealed, digest-verified contract; retry after a decline requires operator-approved finality for the pinned contract version and outcome, and that approval can exist only with reviewed, passing conformance evidence bound to the same contract digest and outcome (§7.7) |
| I-20 | A provider request is sent only after the outer COMMIT of its claim is confirmed |
| I-21 | The web role has no direct read access to owner-scoped or payment-sensitive tables. It reads them only through functions that derive the owner from a live session credential and return that owner's rows (§3.5) |

---

## 2. Database schema

All tables live in schema `shopaccess`. Identifiers are `text` with a regex CHECK. Runtime IDs are a prefix, an underscore and 32 lowercase hex characters **[APPROVED-M1: `src/lib/shared/ids.ts`]**. All timestamps are `timestamptz` and are set from database time by the entry point that writes them.

Unless stated, foreign keys take no `ON DELETE` action (deletion of a referenced row is refused), and no foreign key in this schema cascades. Every unique constraint that is the target of a foreign key is `NOT DEFERRABLE`.

**Identifier prefixes**

| Prefix | Entity | Origin |
| --- | --- | --- |
| `ses`, `ci`, `qt`, `cf`, `op`, `rq`, `ev`, `ob` | session, intent, quote, challenge, operation, provider request, event, observation | [APPROVED-M1] |
| `dmm`, `dmp`, `dmv` (6 to 24 lowercase alphanumerics) | merchant, product, variant | [APPROVED-M1] |
| `own`, `pur`, `da` | owner, purchase group, dispatch authorization | [PROPOSED], OPEN (D-5, D-35) |
| `wk` | worker identity, informational | [PROPOSED] |

### 2.1 `schema_migrations`

`version text PK`, `checksum text NOT NULL`, `applied_at timestamptz NOT NULL`. Integrity checks (owner-approved, Gate A): `version` has a fixed migration-version format (four digits, an underscore, a lowercase name) and `checksum` is 64 lowercase hexadecimal characters. Exact patterns are in §18.2.

### 2.2 `session_admission_guard`

| Column | Type and rule |
| --- | --- |
| `id` | smallint PK, CHECK `id = 1` |
| `window_started_at` | timestamptz NOT NULL |
| `window_admissions` | integer NOT NULL, ≥ 0 |
| `updated_at` | timestamptz NOT NULL |

Seeded with its single row by migration. A trigger rejects DELETE and TRUNCATE. If the row is missing, admission is refused and never recreates it.

### 2.3 `server_key_versions`

Status and check values only; never key material.

| Column | Type and rule |
| --- | --- |
| `purpose` | text, `session` or `confirmation_nonce`; PK with `key_version` |
| `key_version` | smallint > 0 |
| `status` | `ACTIVE`, `VERIFY_ONLY`, `REVOKED` |
| `check_value` | text, 64 hex: HMAC of a fixed public label under that key |
| `activated_at`, `revoked_at` | timestamptz; `revoked_at` set exactly when `REVOKED` |

- Partial unique index: one `ACTIVE` row per purpose.
- Insert trigger: a new version is numerically higher than every existing one for its purpose.
- Update trigger: status moves only `ACTIVE` to `VERIFY_ONLY` or `REVOKED`, or `VERIFY_ONLY` to `REVOKED`.
- **Accepted** means `ACTIVE` or `VERIFY_ONLY`.
- Integrity checks (owner-approved, Gate A): `check_value` is 64 lowercase hexadecimal characters; `revoked_at` is non-NULL exactly when `status` is `REVOKED`.
- Check-value construction, staged keys and emergency revocation: §18.5. A staged key has no row here until it is activated.

### 2.4 `checkout_owners`

`id text PK` (`own_…`), `created_at timestamptz NOT NULL`. Holds no credential material.

**Owner ID generation (owner-approved, Gate A).** The ID is generated inside PostgreSQL by `admit_session`: `own_` followed by the 32 lowercase hexadecimal characters of PostgreSQL 17's core `gen_random_uuid()` with its hyphens removed. No extension is needed for this. The ID is an opaque identifier, not an authentication credential. No caller supplies an owner ID, and the Increment 1 session service does not expose it.

### 2.5 `shopper_sessions`

| Column | Type and rule |
| --- | --- |
| `id` | text PK (`ses_…`) |
| `owner_id` | text NOT NULL, FK to `checkout_owners` |
| `key_purpose` | text NOT NULL DEFAULT `'session'`, CHECK equals `'session'` |
| `key_version` | smallint NOT NULL; FK `(key_purpose, key_version)` to `server_key_versions` |
| `token_digest` | text NOT NULL UNIQUE, 64 hex: keyed digest of the session token |
| `created_at`, `last_seen_at`, `absolute_expires_at` | timestamptz NOT NULL; `absolute_expires_at` within 24 hours of `created_at` |
| `revoked_at` | timestamptz, nullable |
| `row_version` | integer NOT NULL DEFAULT 1; CHECK > 0. Every accepted update sets it to the old value plus exactly one (below) |

Nothing references this table.

- Insert trigger: the key version is `ACTIVE`.
- Update trigger accepts exactly three shapes and nothing else:

| Shape | May change | Conditions |
| --- | --- | --- |
| Touch | `last_seen_at` | Not revoked; new value not earlier than old, less than old plus the idle timeout (2 hours **[APPROVED-M1]**), and less than `absolute_expires_at` |
| Revoke | `revoked_at`, NULL to a value | — |
| Rotate | `token_digest` (must differ), `key_version`, `last_seen_at` | Touch conditions; new version not lower than old; new version `ACTIVE` |

**Row version (owner-approved, Gate A).** The update trigger requires `row_version` to equal the old value plus one in each of the three shapes, and rejects any other change to it.

| Action | Row written | `row_version` |
| --- | --- | --- |
| Insert | Yes | 1 |
| Authorization within the touch threshold (read-only) | No | Unchanged |
| Touch (authorization past the threshold) | Yes | Plus one |
| Rotation | Yes | Plus one |
| Revocation of a live session | Yes | Plus one |
| Bulk revocation through key revocation | Yes, each affected session | Plus one each |
| Repeated revocation of an already revoked session | No | Unchanged |
| Any refused operation; any rolled-back transaction | No | Unchanged |

The idle timeout (2 hours, owner-approved for the local MVP) appears as a constant in this trigger and must equal the application constant; a schema test checks it (D-24).

Indexes: `(absolute_expires_at)`, `(last_seen_at)`, `(owner_id)`.

### 2.6 Catalog: `merchants`, `merchant_products`, `merchant_variants`

As drafted in `db/migrations/0002_merchant_catalog.sql` **[APPROVED-M1 draft, never executed]**, unchanged:

- `merchants (id PK, display_name, is_simulated_sandbox CHECK true)`
- `merchant_products (id PK, merchant_id FK, title, description, image_path, catalog_revision)`
- `merchant_variants (id PK, product_id FK, label, unit_amount_cents 1..2,000,000, currency = 'USD', max_quantity_per_order 1..10, availability, specs jsonb, catalog_revision, UNIQUE (id, product_id))`

The merchant-controlled catalog is the only authority for purchasable products (D-10, approved). Carts are deferred (D-9) and are **not** part of this schema.

**Catalog integrity (owner-approved, Gate A).** The monetary type stays `integer` with the existing range of 1 to 2,000,000 cents; quantity 1 to 10; currency `USD`. `catalog_revision` keeps its existing constraint, positive only. **The current fixture revision is not written into any CHECK constraint.** No new restriction is added on descriptions, the `specs` JSON or product revisions beyond those in the legacy draft. That the seeded rows equal the code fixture is verified by a planned test (PGT-84), not by the schema.

### 2.7 `purchase_groups`

`id text PK` (`pur_…`), `owner_id text NOT NULL` FK to `checkout_owners`, `created_at`. Unique `(id, owner_id)`. Immutable: a trigger rejects every UPDATE and DELETE. No status column; a group's condition is always derived (§6.2).

### 2.8 `purchase_group_risk_acknowledgments`

Append-only.

| Column | Rule |
| --- | --- |
| `group_id`, `acknowledged_group_id`, `risk_fingerprint` | PK; fingerprint is 64 hex; the two group IDs differ |
| `owner_id` | FKs `(group_id, owner_id)` and `(acknowledged_group_id, owner_id)` to `purchase_groups (id, owner_id)` |
| `acknowledged_at` | timestamptz NOT NULL, informational |

### 2.9 `checkout_intents`

| Column | Type and rule |
| --- | --- |
| `id` | text PK (`ci_…`) |
| `owner_id` | text NOT NULL, FK to `checkout_owners` |
| `purchase_group_id` | text NOT NULL; FK `(purchase_group_id, owner_id)` to `purchase_groups (id, owner_id)` |
| `replaces_intent_id` | text, nullable; FK `(replaces_intent_id, purchase_group_id)` to `checkout_intents (id, purchase_group_id)` |
| `created_by_session_id` | text, nullable, no FK; informational |
| `provider` | text NOT NULL, CHECK `IN ('mock')` |
| `state` | text NOT NULL DEFAULT `'DRAFT'`; the 22 states |
| `row_version` | integer NOT NULL DEFAULT 1: the state version |
| `current_quote_id` | text, nullable |
| `confirmation_id`, `confirmation_status` | text, nullable |
| `order_create_operation_id`, `order_create_operation_type` | text, nullable, **paired**: both NULL or both set. When set, the type is `ORDER_CREATE`, the only value its CHECK permits. Together with `id` they are the referencing columns of F-6T |
| `capture_operation_id`, `capture_operation_type` | text, nullable, **paired**: both NULL or both set. When set, the type is `CAPTURE`, the only value its CHECK permits. Together with `id` they are the referencing columns of F-7T |
| `capture_dispatched` | boolean NOT NULL DEFAULT false |
| `provider_order_id`, `provider_capture_id` | text, nullable |
| `superseded_by_intent_id` | text, nullable |
| `created_at`, `updated_at` | timestamptz NOT NULL. `created_at` is database time at insert, immutable, and is the **original draft-creation timestamp** from which draft expiry is measured (§8.10) |

Unique: `(id, owner_id)`; `(id, purchase_group_id)`; `(provider, provider_order_id)`; `(provider, provider_capture_id)`; `(id, replaces_intent_id)`; `(id, superseded_by_intent_id)`. Each is a declared, non-deferrable unique constraint (§19.2).

Checks:

```sql
CHECK (
  (confirmation_id IS NULL AND confirmation_status IS NULL)
  OR
  (confirmation_id IS NOT NULL
   AND confirmation_status IS NOT NULL
   AND confirmation_status = 'CONSUMED')
)
```

**Typed operation pointers (D-28; column registration, pairing and discriminators are owner-approved; exact data types and constraint wording remain subject to exact-schema approval).**

| Pointer | Type column | Required discriminator | Pairing rule |
| --- | --- | --- | --- |
| `order_create_operation_id` | `order_create_operation_type` | `ORDER_CREATE` | `(order_create_operation_id IS NULL) = (order_create_operation_type IS NULL)` |
| `capture_operation_id` | `capture_operation_type` | `CAPTURE` | `(capture_operation_id IS NULL) = (capture_operation_type IS NULL)` |

- The pairing rule matters because a composite key is not checked when any referencing column is NULL: without it, a pointer set with a NULL type would escape F-6T or F-7T.
- Every writer sets and clears a pointer and its type together: the dispatch events set both, and `CAPTURE_DECLINED` clears both capture columns (§10.2).
- With the discriminator fixed per column and the key referencing `payment_operations (id, checkout_intent_id, operation_type)`, the order pointer can name only an `ORDER_CREATE` operation of this intent and the capture pointer only a `CAPTURE` operation of this intent.

Foreign keys added after the tables they reference exist. F-4 and R-B are `DEFERRABLE INITIALLY DEFERRED` and are the only deferrable keys in the schema. F-5 is not deferrable (§19.3). **F-6T and F-7T are not deferrable** (proposed definition; exact constraint wording PROPOSED — OWNER APPROVAL REQUIRED): in every transaction that sets an operation pointer the operation row is inserted first (§8.2), and clearing a pointer removes no row, so no transaction ordering needs deferral. They are added in a later migration step only because `payment_operations` is created after `checkout_intents`.

| Key | Columns | References |
| --- | --- | --- |
| F-4 | `(current_quote_id, id)` | `quotes (id, checkout_intent_id)` |
| F-5 | `(confirmation_id, id, confirmation_status)` | `confirmation_challenges (id, checkout_intent_id, status)` |
| F-6T (replaces F-6) | `(order_create_operation_id, id, order_create_operation_type)` | `payment_operations (id, checkout_intent_id, operation_type)` |
| F-7T (replaces F-7) | `(capture_operation_id, id, capture_operation_type)` | `payment_operations (id, checkout_intent_id, operation_type)` |

Not deferrable: F-2 `(superseded_by_intent_id, owner_id)` to `checkout_intents (id, owner_id)`.

Immutability and the one-time successor pointer are defined in §19.3.

State-dependent CHECKs are permitted only for implications that a generated test shows hold for every reducer-reachable snapshot (PGT-47). Candidates: `DRAFT` has no quote or confirmation pointer; `QUOTED` has a quote pointer and no confirmation pointer; `capture_dispatched` implies a capture pointer; capture-phase and paid states imply `capture_dispatched`; `DECLINED_RETRYABLE` implies not `capture_dispatched`; states from `AWAITING_APPROVAL` through paid imply a provider order ID. None is adopted until proven.

Indexes: `(owner_id)`, `(purchase_group_id)`, `(state, updated_at)`.

### 2.10 `quotes` and `quote_items`

**`quotes`**

| Column | Type and rule |
| --- | --- |
| `id` | text PK (`qt_…`) |
| `owner_id`, `checkout_intent_id` | text NOT NULL; F-1 `(checkout_intent_id, owner_id)` to `checkout_intents (id, owner_id)` |
| `merchant_id` | text NOT NULL, FK to `merchants` |
| `catalog_revision` | integer > 0 |
| `subtotal_cents`, `total_cents` | bigint > 0 |
| `discount_cents`, `tax_cents`, `shipping_cents` | bigint, CHECK each `= 0` |
| `currency` | text, CHECK `= 'USD'` |
| `assumptions_code` | text NOT NULL, CHECK equals the single defined constant *(proposal)* |
| `created_at`, `expires_at` | timestamptz; CHECK `expires_at = created_at + interval '15 minutes'`. Owner-approved for PostgreSQL mode (G2-12). The Mock's equal value is a separate, earlier approval |
| `digest` | text NOT NULL UNIQUE, 64 hex |
| `digest_version` | text NOT NULL, CHECK `= 'SAQD-1'` |

CHECK `total_cents = subtotal_cents - discount_cents + tax_cents + shipping_cents`. Unique: `(id, owner_id)`, `(id, checkout_intent_id)`, `(id, checkout_intent_id, owner_id)`.

**`quote_items`**: `quote_id` FK, `line_number` CHECK `= 1`, `product_id`, `variant_id`, `quantity` 1..10, `unit_amount_cents` > 0, `line_subtotal_cents` CHECK `= unit_amount_cents * quantity`; PK `(quote_id, line_number)`; F-14 `(variant_id, product_id)` to `merchant_variants (id, product_id)`.

Both tables are immutable: triggers reject UPDATE, DELETE and TRUNCATE. Index: `quotes (expires_at)`.

### 2.11 `confirmation_challenges`

One row per issued challenge.

| Column | Type and rule |
| --- | --- |
| `id` | text PK (`cf_…`) |
| `owner_id`, `checkout_intent_id`, `quote_id` | text NOT NULL; F-3 `(quote_id, checkout_intent_id, owner_id)` to `quotes (id, checkout_intent_id, owner_id)` |
| `quote_digest` | text, 64 hex |
| `nonce_digest` | text NOT NULL UNIQUE, 64 hex: SHA-256 of the nonce. The nonce is never stored |
| `nonce_key_purpose` | text NOT NULL DEFAULT `'confirmation_nonce'`, CHECK equals it |
| `nonce_key_version` | smallint NOT NULL; FK with purpose to `server_key_versions` |
| `summary` | jsonb NOT NULL, ≤ 1024 bytes: the six fields shown to the buyer |
| `status` | `ACTIVE`, `CONSUMED`, `SUPERSEDED`, `EXPIRED` |
| `issued_at`, `expires_at` | timestamptz NOT NULL; `expires_at > issued_at` |
| `consumed_at`, `superseded_at`, `expired_marked_at` | timestamptz, nullable; each non-NULL exactly when its status applies; `consumed_at >= issued_at` and `< expires_at` |

Unique: `(id, checkout_intent_id)`; `(id, checkout_intent_id, status)`. Partial unique: `(quote_id) WHERE status = 'ACTIVE'`; `(quote_id) WHERE status = 'CONSUMED'`. Index: `(expires_at) WHERE status = 'ACTIVE'`.

Triggers:

- Insert: status must be `ACTIVE` with all terminal timestamps NULL.
- Update: only from `ACTIVE` to one terminal status, setting exactly the matching timestamp, with every other column unchanged.
- Delete: only rows in `SUPERSEDED` or `EXPIRED`. TRUNCATE rejected.

### 2.12 `dispatch_authorizations`

| Column | Type and rule |
| --- | --- |
| `id` | text PK (`da_…`) |
| `checkout_intent_id`, `owner_id`, `purchase_group_id` | text NOT NULL; FK `(checkout_intent_id, owner_id)` to `checkout_intents (id, owner_id)` |
| `quote_id`, `quote_digest` | text NOT NULL; immutable snapshot of the exact quote authorized |
| `confirmation_id`, `confirmation_status` | text NOT NULL; status CHECK equals `CONSUMED`; exact challenge consumed for that quote |
| `operation_type` | `ORDER_CREATE` or `CAPTURE` |
| `adapter_id`, `adapter_contract_version`, `adapter_contract_digest` | NOT NULL; exact server-selected contract snapshot, never client/AI-selected |
| `adapter_policy_id`, `adapter_policy_version`, `environment` | NOT NULL; exact active policy snapshot selecting the contract |
| `status` | `ISSUED`, `CONSUMED`, `REFUSED`, `EXPIRED` |
| `issued_at`, `expires_at` | timestamptz NOT NULL |
| `resolved_at` | timestamptz, non-NULL exactly when status is not `ISSUED` |

Composite FKs bind quote/intent/owner, challenge/intent/`CONSUMED`, adapter/version/digest, exact policy ID/version/environment/type/adapter binding, and intent/group/owner. A candidate key covers `(id, checkout_intent_id, purchase_group_id, operation_type, adapter_id, adapter_contract_version, adapter_contract_digest)`. A database-owned insert function/trigger verifies the challenge quote digest equals the authorization quote digest and both match the current intent pointers, and verifies the adapter snapshot against the unique active server policy for operation type and environment. No client, AI, or worker input selects these values. Missing or ambiguous policy fails closed. Binding fields are immutable; only an `ISSUED` status can transition once to a terminal status. Partial unique: `(checkout_intent_id, operation_type) WHERE status = 'ISSUED'`. No delete. Before issuing a replacement, the function locks and expires any stale `ISSUED` row; an unexpired matching authorization is reused or refused, never duplicated. The exact policy owner and activation-function privileges remain OPEN (D-53).

### 2.13 `payment_operations`

| Column | Type and rule |
| --- | --- |
| `id` | text PK (`op_…`) |
| `checkout_intent_id`, `purchase_group_id` | text NOT NULL; FK `(checkout_intent_id, purchase_group_id)` to `checkout_intents (id, purchase_group_id)` |
| `authorization_id` | text NOT NULL UNIQUE; composite FK to the exact dispatch-authorization snapshot below |
| `operation_type` | `ORDER_CREATE` or `CAPTURE` |
| `sequence` | integer ≥ 1 |
| `provider` | text NOT NULL, CHECK `IN ('mock')` |
| `adapter_id`, `adapter_contract_version`, `adapter_contract_digest` | text, integer > 0, 64-hex digest; NOT NULL; composite FK to `adapter_contracts` |
| `provider_request_id` | text NOT NULL (`rq_…`) |
| `payload_digest` | text NOT NULL, 64 hex, computed by the database |
| `state` | the nine operation states |
| `lease_owner`, `lease_expires_at` | text (`wk_…`), timestamptz; both NULL or both set |
| `fencing_version` | integer NOT NULL DEFAULT 0 |
| `attempt_count` | integer NOT NULL DEFAULT 0 |
| `provider_reference` | text, nullable |
| `provider_call_deadline_at` | timestamptz, nullable |
| `next_recovery_at`, `parked_at`, `parked_reason` | timestamptz, timestamptz, text (closed list) |
| `last_readback_at` | timestamptz, nullable |
| `quarantine_reconciled_seq` | integer, nullable |
| `row_version` | integer NOT NULL DEFAULT 1 |
| `created_at`, `updated_at` | timestamptz NOT NULL |

Unique: `(checkout_intent_id, operation_type, sequence)`; `(provider, provider_request_id)`; `(id, checkout_intent_id)`; `(id, checkout_intent_id, operation_type)`; partial `(provider, operation_type, provider_reference) WHERE provider_reference IS NOT NULL`.

The operation's authorization FK must match its intent, purchase group, operation type, adapter ID, adapter version and adapter digest. The insert trigger and `claim_authorized_dispatch` also require that the authorization's quote and consumed-confirmation snapshot still equals the current intent state. An authorization cannot be rebound to a later quote, confirmation, operation type or adapter version.

Partial unique indexes:

- `(checkout_intent_id) WHERE operation_type = 'ORDER_CREATE'`
- `(purchase_group_id) WHERE operation_type = 'CAPTURE' AND state NOT IN ('DECLINED', 'REJECTED')`

Scheduling CHECKs:

| State | `next_recovery_at` | `parked_at` |
| --- | --- | --- |
| `PENDING` | NULL | NULL |
| `DISPATCHING` | NOT NULL | NULL |
| `UNKNOWN`, `READBACK_CLEARED`, `PENDING_PROVIDER` | Exactly one of the two is NOT NULL | |
| `SUCCEEDED`, `DECLINED`, `REJECTED` | NULL | NULL |
| `CONFLICT` | NULL | NOT NULL |

Other CHECKs: `parked_reason` set exactly when `parked_at` is; `DISPATCHING` implies a lease owner, a non-NULL call deadline and `lease_expires_at >= provider_call_deadline_at`; any state other than `PENDING` implies `fencing_version >= 1`; `attempt_count >= 1` implies a call deadline.

Triggers:

- Identity columns are immutable: intent, group, authorization, type, sequence, provider, adapter ID and version, request ID, payload digest.
- Once `state` is `SUCCEEDED`, `DECLINED`, `REJECTED` or `CONFLICT`, the row never changes.
- Insert: the pinned contract has `dispatch_status = 'APPROVED'`; and for a `CAPTURE`, no review-queue entry exists for any intent of the same purchase group.
- **Deferred constraint trigger (CT-1):** at commit, an operation in `SUCCEEDED`, `DECLINED`, `REJECTED` or `PENDING_PROVIDER` must have an `AUTHORITATIVE` observation for itself and a transition citing an observation of that operation. It does not apply to `DISPATCHING`, `UNKNOWN` or `CONFLICT`.

Recovery index: `(next_recovery_at) WHERE parked_at IS NULL AND state IN ('DISPATCHING', 'UNKNOWN', 'READBACK_CLEARED', 'PENDING_PROVIDER')`.

### 2.14 `payment_operation_claims`

Append-only. **No application role can read it.**

| Column | Rule |
| --- | --- |
| `operation_id`, `fencing_version` | PK; FK to `payment_operations` |
| `claim_verifier` | bytea, 32 bytes: SHA-256 of the claim secret |
| `claim_kind` | `INITIAL`, `TAKEOVER`, `RESEND` |
| `worker_id` | text, informational |
| `claimed_at` | timestamptz NOT NULL |

**Random source (D-48, approved as an architectural choice).** The secret is 32 cryptographically secure random bytes produced inside PostgreSQL 17 by the `pgcrypto` function `gen_random_bytes`, called only from one internal helper that is granted to no role. The extension is not installed by this document; where it is created, and the helper's name and schema qualification, are PROPOSED — OWNER APPROVAL REQUIRED.

The 32-byte random secret is returned exactly once by a successful claim function, never stored in raw form, and held only in worker memory. It is not returned to the web/browser and must be excluded from logs, traces, errors and audit events. Later worker calls provide the secret; database functions compare its hash only with the current fencing-version verifier (except superseded-claim evidence quarantine, §8.9). A stale worker cannot read or derive a successor's secret.

### 2.15 `payment_provider_observations`

Append-only (UPDATE, DELETE, TRUNCATE rejected).

| Column | Type and rule |
| --- | --- |
| `id` | text PK (`ob_…`) |
| `checkout_intent_id` | text NOT NULL, FK |
| `operation_id` | text **NOT NULL**; F-8 `(operation_id, checkout_intent_id)` to `payment_operations (id, checkout_intent_id)`. Proposed resolution of D-52, pending owner approval. A composite foreign key is not checked when any of its columns is NULL, so a nullable `operation_id` would let an observation exist with no operation and escape F-8 and F-12 |
| `observation_seq` | integer NOT NULL; unique with `checkout_intent_id` |
| `provider` | text NOT NULL |
| `source` | `provider_response`, `provider_readback`, `provider_observation` |
| `subject` | `ORDER`, `CAPTURE` |
| `observed_status` | closed list: `CREATED`, `APPROVED`, `COMPLETED`, `PENDING`, `DECLINED`, `REJECTED`, `NOT_FOUND`, `MISSING`, `UNRECOGNIZED` |
| `reason_code` | text, nullable, `^[A-Z0-9_.:-]{1,64}$` |
| `conflict` | text, nullable, closed list, ≤ 64 |
| `provider_order_id`, `provider_capture_id` | text, nullable, ≤ 128 |
| `reported_amount_cents`, `reported_currency` | bigint, text ≤ 8; stored whenever the evidence carries them |
| `reported_cumulative_refunded_cents`, `reported_refund_count`, `refund_facts_digest` | bigint, integer, text 64 hex; nullable |
| `reversed_or_disputed` | boolean, nullable |
| `evidence_role` | `AUTHORITATIVE`, `CONFLICTING`, `QUARANTINED` |
| `citable` | boolean NOT NULL, CHECK `citable = (evidence_role <> 'QUARANTINED')` |
| `reconciliation_outcome` | `NONE`, `IDENTICAL`, `COMPATIBLE`, `UNPROVABLE`, `CONTRADICTORY`, `DIFFERENT_OBJECT`; computed by the database |
| `operation_fencing_version` | integer, nullable |
| `fingerprint` | text NOT NULL, 64 hex |
| `observed_at` | timestamptz NOT NULL |

Unique: `(id, checkout_intent_id)`; `(id, checkout_intent_id, citable)`; `(id, checkout_intent_id, operation_id, subject)`. Index: `(operation_id, observation_seq DESC)`.

**Compatibility of NOT NULL with every writer.** Each ingestion function resolves and locks an operation before it writes an observation: operation evidence and quarantined evidence name the claimed operation (§8.5, §8.9); approval evidence names the intent's order operation (§8.7); post-capture evidence names the `SUCCEEDED` capture operation (§8.8). A "not found" readback is an observation *about* the operation that was read back. Evidence that names no known operation of the intent is refused with an audit row and no observation is stored. No workflow in this document needs an observation without an operation.

### 2.16 `payment_refund_evidence`

Append-only. One row per distinct refund fact.

| Column | Type and rule |
| --- | --- |
| `checkout_intent_id`, `refund_seq` | PK; `refund_seq` ≥ 1 |
| `capture_operation_id`, `capture_operation_type` | text, **both NOT NULL**; type DEFAULT and CHECK `'CAPTURE'`; F-13 `(capture_operation_id, checkout_intent_id, capture_operation_type)` to `payment_operations (id, checkout_intent_id, operation_type)` |
| `observation_id`, `observation_subject` | text, **both NOT NULL**; subject DEFAULT and CHECK `'CAPTURE'`; F-12 `(observation_id, checkout_intent_id, capture_operation_id, observation_subject)` to observations `(id, checkout_intent_id, operation_id, subject)` |
| `provider` | text NOT NULL |
| `identity_basis` | `PROVIDER_REFUND_ID` or `CUMULATIVE_DELTA` |
| `provider_refund_id` | text, nullable, ≤ 128; non-NULL exactly when the basis is `PROVIDER_REFUND_ID` |
| `refund_amount_cents`, `cumulative_after_cents`, `capture_amount_cents` | bigint > 0; `refund_amount_cents <= cumulative_after_cents <= capture_amount_cents` |
| `currency` | text NOT NULL |
| `recorded_at` | timestamptz NOT NULL |

Partial unique `(provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL`; unique `(checkout_intent_id, cumulative_after_cents)`. Insert trigger: `refund_seq` is the previous maximum plus one; `cumulative_after_cents` is the previous total plus this amount; basis, currency and capture amount equal those of earlier rows.

The four provenance columns are NOT NULL for two reasons. A CHECK such as `capture_operation_type = 'CAPTURE'` passes when the column is NULL, and F-12 and F-13 are not checked when any component is NULL. Without NOT NULL a refund row could be stored citing no capture operation or no observation. F-12, F-13 and both CHECKs are kept unchanged. Refund rows are written only by `ingest_post_capture_evidence`, which holds the `SUCCEEDED` capture operation and inserts the observation before the refund rows in the same transaction (§8.8, §9.9), so all four values always exist.

### 2.17 `evidence_review_queue`

Append-only. `observation_id text PK`; `checkout_intent_id`; F-11 `(observation_id, checkout_intent_id)` to observations `(id, checkout_intent_id)`; `reason` (closed list, §9.8); `opened_at`. It records that a person must look. It changes no financial state, and nothing in this document closes an entry (D-12).

### 2.18 `checkout_transitions`

Append-only.

| Column | Type and rule |
| --- | --- |
| `checkout_intent_id`, `to_version` | PK |
| `from_version` | integer; CHECK `to_version = from_version + 1` |
| `event_id` | text NOT NULL UNIQUE |
| `event_type` | the 26 event types |
| `actor` | the 9 actors |
| `entry_point` | text NOT NULL |
| `from_state`, `to_state` | the 22 states |
| `observation_id`, `observation_citable` | text, boolean; F-9 `(observation_id, checkout_intent_id, observation_citable)` to observations `(id, checkout_intent_id, citable)` |
| `operation_id` | text, nullable; cited through **F-10T** (below). Presence is fixed by the actor CHECK below |
| `operation_type` | text, nullable; `ORDER_CREATE` or `CAPTURE`; the discriminator of F-10T. NULL exactly when `operation_id` is NULL |
| `occurred_at`, `recorded_at` | timestamptz NOT NULL |

```sql
CHECK (
  (observation_id IS NULL AND observation_citable IS NULL)
  OR
  (observation_id IS NOT NULL
   AND observation_citable IS NOT NULL
   AND observation_citable IS TRUE)
)
```

The CHECK above constrains the observation columns only. It says nothing about `operation_id`.

**Operation citation (AR012-003).** A separate table CHECK fixes when `operation_id` is present:

```sql
CHECK (
  (actor IN ('shopper', 'server', 'timer', 'browser_redirect')) = (operation_id IS NULL)
)
```

Events raised by `operation_worker`, `reconciler` and the three provider actors always concern one payment operation and must cite it; events raised by the other four actors never do. The CHECK is evaluated on every insert for every role, has no NULL escape (`actor` is NOT NULL and `IS NULL` is never unknown). When `operation_id` is present, F-10T is fully checked because `checkout_intent_id` is NOT NULL and `operation_type` is required by the pair CHECK below. The event-by-event list is in §10.3.

**Typed citation (D-28; extension to transitions approved as policy; the definitions here are PROPOSED — OWNER APPROVAL REQUIRED).**

- CHECK `(operation_id IS NULL) = (operation_type IS NULL)`.
- **F-10T is the authoritative operation-citation key and replaces F-10.** The untyped key F-10 `(operation_id, checkout_intent_id)` is retired and is not declared. F-10T is `(operation_id, checkout_intent_id, operation_type)` referencing `payment_operations (id, checkout_intent_id, operation_type)`, a declared UNIQUE constraint of §2.13 and the same candidate key F-13 uses. The discriminator `payment_operations.operation_type` is NOT NULL and immutable, so a transition can cite an operation only with that operation's true type, and only an operation of the same intent.
- Non-null behaviour: the three referencing columns are either all present or `operation_id` and `operation_type` are both NULL (`checkout_intent_id` is always present). The pair CHECK above closes the case where a NULL type would cause the key not to be checked.
- CHECK by event type: the order events of §10.3 (`ORDER_CREATE_DISPATCHED`, `ORDER_CREATED`, `ORDER_CREATE_REJECTED`, `ORDER_CREATE_OUTCOME_UNKNOWN`, `ORDER_CREATE_REDISPATCHED`, `ORDER_DETAILS_MISMATCH`, `APPROVAL_VERIFIED`, `APPROVAL_NOT_FOUND`, and `EXPIRED` when an operation is cited) require `ORDER_CREATE`; the capture events (`CAPTURE_DISPATCHED`, `CAPTURE_COMPLETED`, `CAPTURE_PENDING`, `CAPTURE_DECLINED`, `CAPTURE_OUTCOME_UNKNOWN`, `CAPTURE_EVIDENCE_MISMATCH`, `CAPTURE_REDISPATCHED`, `REFUND_OBSERVED`, `REVERSAL_OR_DISPUTE_OBSERVED`) require `CAPTURE`; `READBACK_INCONCLUSIVE` and `ESCALATED_TO_MANUAL_REVIEW` accept either.

CHECK: an actor of `provider_response`, `provider_readback` or `provider_observation` requires `observation_id`. Partial unique: `(checkout_intent_id, event_type, observation_id) WHERE observation_id IS NOT NULL`.

### 2.19 `checkout_transition_rules` and `entry_point_event_allowlist`

Reference data loaded by migration; writable only by the owner.

- `checkout_transition_rules (from_state, event_type, actor, to_state, guard_code)`, PK `(from_state, event_type, actor)`. Generated from the TypeScript transition table.
- `entry_point_event_allowlist (entry_point, event_type, actor)`, all three the PK. Content: §10.2.

### 2.20 Adapter registry

**`database_environment`** (proposed): one owner-seeded row with fixed singleton key `1` identifies this database's environment; immutable to runtime roles, with a CHECK over approved environment names, a seed row, and a trigger rejecting deletion so exactly one row exists. Application roles may read but not change it. Do not derive it from an app-settable GUC or request field.

**`adapter_dispatch_policies`** (proposed detail for D-53): immutable rows bind `(id, environment, operation_type, policy_version)` to `(adapter_id, contract_version, contract_digest)`, with `created_by`, `created_at`, nullable `retired_by` and `retired_at`; declare a composite candidate key over the complete binding. A partial unique index permits at most one unretired row per `(environment, operation_type)`. A composite FK requires the exact registered contract and environment FK targets `database_environment`. Only an owner-controlled policy function may append a new version and retire the previous row in one transaction; runtime roles have SELECT only. It appends a sanitized audit event in the same transaction. The selector reads and locks the single unretired row `FOR SHARE`, then locks the referenced contract `FOR SHARE`; missing environment, policy or contract fails closed. The policy row and exact contract identity are copied into the dispatch authorization with a composite FK to the complete policy binding. At claim time the worker re-locks that exact policy row and refuses if it has been retired; it never substitutes a newer policy. The policy function locks policy rows in `(environment, operation_type)` order before contract rows. D-53 remains OPEN for owner approval of this mechanism and designation of who may invoke the owner-controlled function.

**`adapter_contracts`**

| Column | Rule |
| --- | --- |
| `adapter_id`, `contract_version` | PK |
| `contract_digest` | text, 64 hex; computed by the database at registration; immutable |
| `sealed` | boolean NOT NULL; once true, never false |
| `order_status_order_declared`, `capture_status_order_declared` | boolean NOT NULL |
| `replay_idempotent_order_create` | boolean NOT NULL: whether resending an order-create under the same request ID is declared idempotent |
| `discovered_at` | timestamptz NOT NULL |
| `dispatch_status` | `DISCOVERED`, `APPROVED`, `WITHDRAWN` |
| `dispatch_approved_by`, `dispatch_approved_at`, `dispatch_withdrawn_by`, `dispatch_withdrawn_at` | provenance |

Non-deferrable candidate key: `(adapter_id, contract_version, contract_digest)` for authorization and operation snapshot FKs.

**`adapter_contract_status_order`**: `(adapter_id, contract_version, subject, from_status, to_status)`, all the PK; FK to the contract. A row with `from_status = 'NOT_FOUND'` declares "not found" as a starting point. Insert only while the contract is unsealed; never updated or deleted.

**`adapter_contract_finality`**

| Column | Rule |
| --- | --- |
| `adapter_id`, `contract_version`, `outcome_status`, `reason_class` | PK; FK to the contract |
| `contract_digest` | text NOT NULL, 64 hex; with adapter and version, FK to the contract's candidate key |
| `evidence_id`, `evidence_result`, `evidence_review` | text, **all NOT NULL**; `evidence_result` DEFAULT and CHECK `'PASS'`; `evidence_review` DEFAULT and CHECK `'ACCEPTED'`. F-25 `(evidence_id, adapter_id, contract_version, contract_digest, outcome_status, reason_class, evidence_result)` to `adapter_finality_evidence`. F-26 `(evidence_id, evidence_review)` to `adapter_finality_evidence_reviews (evidence_id, verdict)` |
| `suite_id`, `suite_version`, `result_digest` | text NOT NULL; copied by the approval function from the evidence row; immutable |
| `standing` | `VERIFIED`, `WITHDRAWN` |
| `approved_by`, `approved_at`, `withdrawn_by`, `withdrawn_at` | provenance |
| `withdrawn_reason` | `OPERATOR` or `SUITE_RETIRED`; non-NULL exactly when `WITHDRAWN` |

A finality row cannot be inserted without a matching evidence row and an accepting review, for every role including the table owner, because the two foreign keys and NOT NULL columns are part of the table. Governance is in §7.7.

**`adapter_finality_suites`** (proposed; OPEN D-56). Reference data written only by an owner-approved migration. Operators have SELECT only. **The web and worker roles have no direct SELECT** on this table or on the evidence and review tables; §3.2 governs. The dispatch functions read them under their own definer privileges.

| Column | Rule |
| --- | --- |
| `suite_id`, `suite_version` | PK; NOT NULL |
| `suite_digest` | text NOT NULL, 64 hex: SHA-256 of the suite's canonical case list (case identifiers and what each asserts) |
| `adapter_id`, `outcome_status`, `reason_class` | NOT NULL; the one outcome this suite version can support |
| `required_case_count` | integer > 0 |
| `retired_at` | timestamptz, nullable; set once, only by `retire_finality_suite` (§7.7) |

Declared constraint **U-S1**: `UNIQUE (suite_id, suite_version, suite_digest, adapter_id, outcome_status, reason_class)`. It is the referenced key of F-27 (AR012-002). A foreign key must reference a column set covered by a PRIMARY KEY or UNIQUE constraint; the primary key alone covers only two of these six columns, so the earlier draft's reference was invalid. U-S1 contains the whole primary key, so it admits exactly the rows the primary key admits and restricts nothing further. A trigger makes every column except `retired_at` immutable, so the key a row was referenced by cannot change.

Deferred constraint trigger **CT-2** on this table and on `adapter_contract_finality`: at commit, no `VERIFIED` finality row may cite a suite whose `retired_at` is set. It applies to every role, including the table owner.

**This draft seeds no suite rows.** Until an owner-approved migration adds one, no evidence can be recorded and no finality can be approved.

**`adapter_finality_evidence`** (proposed). Append-only and immutable (UPDATE, DELETE, TRUNCATE rejected).

| Column | Rule |
| --- | --- |
| `id` | text PK (`fe_…`) |
| `adapter_id`, `contract_version`, `contract_digest` | NOT NULL; FK to the contract's candidate key. Binds the evidence to one exact contract |
| `outcome_status`, `reason_class` | NOT NULL; the tested outcome |
| `suite_id`, `suite_version`, `suite_digest` | NOT NULL; **F-27** `(suite_id, suite_version, suite_digest, adapter_id, outcome_status, reason_class)` to `adapter_finality_suites` constraint U-S1. Suite ID and version identify the suite row; the other four columns must then equal that row's values, so evidence cannot record a different digest, or cite a suite written for another adapter or outcome |
| `cases_total`, `cases_passed`, `cases_failed`, `cases_skipped`, `cases_errored` | integer NOT NULL, ≥ 0 |
| `result` | `PASS` or `FAIL`; CHECK: `PASS` exactly when failed, skipped and errored are all 0 and `cases_passed = cases_total`; insert trigger additionally requires `cases_total` to equal the suite's `required_case_count` for `PASS` |
| `result_digest` | text NOT NULL, 64 hex: SHA-256 of the canonical result record (§7.7) |
| `result_location` | text NOT NULL, ≤ 256; where the immutable result record is kept. Not interpreted by the database |
| `recorded_by`, `recorded_at` | set by trigger from `session_user` and database time |

Unique: `(id, adapter_id, contract_version, contract_digest, outcome_status, reason_class, result)` as the target of F-25.

**`adapter_finality_evidence_reviews`** (proposed). Append-only. `evidence_id` PK and FK; `verdict` (`ACCEPTED`, `REJECTED`); `reviewed_result_digest` NOT NULL, required by trigger to equal the evidence row's `result_digest`; `reviewed_by`, `reviewed_at` set by trigger. Trigger: `reviewed_by` differs from the evidence row's `recorded_by`. Unique `(evidence_id, verdict)` as the target of F-26. One review per evidence row; a rejected result is superseded only by recording new evidence.

Triggers on both status-bearing tables:

- `adapter_contracts` insert: `dispatch_status` must be `DISCOVERED` and all provenance NULL, for every role.
- Legal changes: `DISCOVERED` to `APPROVED`; `DISCOVERED` or `APPROVED` to `WITHDRAWN`; `VERIFIED` to `WITHDRAWN`. Nothing moves back.
- Provenance columns are set by trigger from `session_user` and database time, ignoring supplied values, and are immutable once set.
- CHECKs tie each status to the presence of its provenance columns.

### 2.21 `audit_events`

Append-only (UPDATE, DELETE, TRUNCATE rejected). No foreign keys, by design.

| Column | Rule |
| --- | --- |
| `id` | bigint identity PK |
| `event_id` | text NOT NULL UNIQUE, ≤ 64 |
| `event_type` | text, `^[A-Z][A-Z0-9_]{2,63}$`, from a closed list per writer |
| `occurred_at`, `recorded_at` | timestamptz NOT NULL |
| `actor` | text, `^[a-z_]{2,32}$` |
| `session_id`, `owner_id`, `checkout_intent_id`, `operation_id` | text, nullable |
| `detail` | jsonb object, ≤ 8192 bytes |

Indexes: `(occurred_at)`, `(checkout_intent_id, occurred_at)`.

In Increment 1 this table is written only by the two operator key-management functions, with exactly two event types, `KEY_VERSION_ACTIVATED` and `KEY_VERSION_REVOKED` (§18.6). `append_web_audit` is deferred until an approved web-originated event exists that no entry point owns (G2-09). It is not created in Increment 2. No audit obligation is waived (§19.10).

### 2.22 Composite foreign-key register

| # | Referencing | Referenced candidate key | Guarantees |
| --- | --- | --- | --- |
| F-1 | `quotes (checkout_intent_id, owner_id)` | `checkout_intents (id, owner_id)` | Quote and intent share an owner |
| F-2 | `checkout_intents (superseded_by_intent_id, owner_id)` | `checkout_intents (id, owner_id)` | Supersession stays within one owner |
| F-3 | `confirmation_challenges (quote_id, checkout_intent_id, owner_id)` | `quotes (id, checkout_intent_id, owner_id)` | Challenge, quote, intent and owner agree |
| F-4, F-5 | Intent quote and confirmation pointers (§2.9) | As listed | A pointer names a row of the same intent; F-5 also requires `CONSUMED`. The operation pointers are F-6T and F-7T, below |
| F-8 | observations `(operation_id, checkout_intent_id)` | `payment_operations (id, checkout_intent_id)` | Observation and operation share an intent |
| F-9 | transitions `(observation_id, checkout_intent_id, observation_citable)` | observations `(id, checkout_intent_id, citable)` | Cited evidence is of the same intent and not quarantined |
| F-10T (replaces F-10) | transitions `(operation_id, checkout_intent_id, operation_type)` | `payment_operations (id, checkout_intent_id, operation_type)` | Cited operation is of the same intent **and of the cited type**. F-10, the untyped two-column form, is retired and not declared |
| F-6T, F-7T (replace F-6, F-7) | `checkout_intents (order_create_operation_id, id, order_create_operation_type)` and `(capture_operation_id, id, capture_operation_type)`; the type columns are registered in §2.9, paired with their pointers | `payment_operations (id, checkout_intent_id, operation_type)` | The order pointer names an `ORDER_CREATE` operation of this intent and the capture pointer a `CAPTURE` operation of this intent. Not deferrable |
| F-11 | review queue `(observation_id, checkout_intent_id)` | observations `(id, checkout_intent_id)` | Review entries point at evidence of that intent |
| F-12, F-13 | Refund evidence (§2.16) | As listed | The refund cites a capture observation of the same capture operation |
| F-14 | `quote_items (variant_id, product_id)` | `merchant_variants (id, product_id)` | Variant belongs to the product |
| F-15 | `checkout_intents (purchase_group_id, owner_id)` | `purchase_groups (id, owner_id)` | Group and intent share an owner |
| F-16 | `checkout_intents (replaces_intent_id, purchase_group_id)` | `checkout_intents (id, purchase_group_id)` | A replacement is in its predecessor's group |
| F-17 | `payment_operations (checkout_intent_id, purchase_group_id)` | `checkout_intents (id, purchase_group_id)` | Operation carries its intent's group |
| F-18 | acknowledgments, two keys with `owner_id` | `purchase_groups (id, owner_id)` | Both groups belong to one owner |
| F-19a | `dispatch_authorizations (checkout_intent_id, owner_id)` | `checkout_intents (id, owner_id)` | Authorization and intent share an owner |
| F-19b | `dispatch_authorizations (checkout_intent_id, purchase_group_id)` | `checkout_intents (id, purchase_group_id)` | Authorization and intent share a purchase group |
| F-20 | `dispatch_authorizations (quote_id, checkout_intent_id, owner_id)` | `quotes (id, checkout_intent_id, owner_id)` | Authorization names the same owner's quote for that intent |
| F-21 | `dispatch_authorizations (confirmation_id, checkout_intent_id, confirmation_status)` | `confirmation_challenges (id, checkout_intent_id, status)` | Authorization binds to that intent's consumed challenge |
| F-22 | `dispatch_authorizations (adapter_id, adapter_contract_version, adapter_contract_digest)` | `adapter_contracts (adapter_id, contract_version, contract_digest)` | Authorization pins an exact registered contract |
| F-23 | `payment_operations (authorization_id, checkout_intent_id, purchase_group_id, operation_type, adapter_id, adapter_contract_version, adapter_contract_digest)` | Matching candidate key on `dispatch_authorizations` | Operation consumes the exact authorization snapshot |
| F-24 | `dispatch_authorizations (adapter_policy_id, environment, operation_type, adapter_policy_version, adapter_id, adapter_contract_version, adapter_contract_digest)` | `adapter_dispatch_policies` matching candidate key | Authorization pins the exact policy row and selected contract |
| F-25 | `adapter_contract_finality (evidence_id, adapter_id, contract_version, contract_digest, outcome_status, reason_class, evidence_result)` | `adapter_finality_evidence` matching candidate key | Finality cites passing evidence for the same contract digest and outcome |
| F-26 | `adapter_contract_finality (evidence_id, evidence_review)` | `adapter_finality_evidence_reviews (evidence_id, verdict)` | Finality cites evidence that a second person accepted |
| F-27 | `adapter_finality_evidence (suite_id, suite_version, suite_digest, adapter_id, outcome_status, reason_class)` | `adapter_finality_suites` U-S1, same columns | Evidence cites an existing suite version with that exact digest, written for that adapter and outcome |

**Referenced keys.** Every referenced column set in this register is a declared PRIMARY KEY or UNIQUE constraint on the referenced table, with the same columns in the same order. PGT-78l audits this from the catalog.

**Nullable components.** PostgreSQL does not check a composite foreign key when any referencing column is NULL. **Requirement:** every referencing column of F-1, F-3, F-8, F-11 to F-15 and F-17 to F-27 is declared NOT NULL. Where a column table in §2 does not say so (for example `owner_id` in §2.8), this paragraph governs. The only keys with a nullable column are the ones where NULL means "no reference yet": the intent pointers F-4, F-5, F-6T and F-7T and the supersession and replacement links F-2 and F-16 (nullable identifier, NOT NULL companion columns, guarded by the CHECKs of §2.9), and the transition citations. F-9's observation columns are guarded by the observation pair CHECK and the provider-actor CHECK of §2.18. F-10T's `operation_id` and `operation_type` are guarded by the separate actor CHECK and the operation pair CHECK of §2.18, which require both for every operation-bearing actor; the observation pair CHECK does not protect them. For F-6T and F-7T the pointer and its type column are NULL together or set together. For those, the NULL case is the absence of a citation, never a citation of an unchecked row. PGT-55 tests each case by direct SQL.

**Typed operation references (D-28: approved as policy for intent pointers and for transition citations; exact definitions PROPOSED — OWNER APPROVAL REQUIRED).** **Authoritative keys:** F-10T for transition citations and F-6T, F-7T for the intent's order and capture pointers. They replace F-10, F-6 and F-7, which are retired; wherever an earlier passage or historical report says F-10, F-6 or F-7 for an operation reference, read the typed key. F-6 and F-7 in the §2.9 table are superseded by F-6T and F-7T; F-4 and F-5 are unchanged. Each pointer gains a type column that is NULL exactly when the pointer is NULL and otherwise CHECKed to `ORDER_CREATE` (order pointer) or `CAPTURE` (capture pointer). All three keys reference the one declared candidate key `payment_operations (id, checkout_intent_id, operation_type)`. Ownership and provenance keys are untouched: F-8 and F-11 to F-13 for evidence, F-9 for observation citations, F-17 for the operation's purchase group. The two type columns are registered in §2.9 with their pairing rule and discriminators (owner-approved). F-6T and F-7T are proposed as non-deferrable, for the reason given in §2.9. Exact data types, DEFAULT and CHECK wording and the constraint definitions themselves remain subject to exact-schema approval: PROPOSED — OWNER APPROVAL REQUIRED. V-10 and V-25 remain as verification queries that must return no rows; they are no longer the only control.

Not enforced by key, and checked by a verification query instead: that a quote item's product belongs to the quote's merchant (V-11).

---

## 3. Roles, privileges and trust boundaries

### 3.1 Roles

| Role | Login | Used by | Notes |
| --- | --- | --- | --- |
| `shopaccess_owner` | No | Migration runner only (the migration role; never used at runtime) | Owns both schemas, every table, trigger and trigger function, and maintenance functions that are granted to nobody. **It does not own the trusted entry-point functions** |
| `shopaccess_definer` | No | Nobody; cannot log in and no runtime role can switch to it | Owns the trusted entry-point functions and their internal helpers in schema `shopaccess_api`. Holds only the table privileges those functions need (§18.4). Owns no table |
| `shopaccess_web` | Yes | Web server process | Buyer-facing entry points |
| `shopaccess_worker` | Yes | Payment worker process | Claims, evidence ingestion, recovery |
| `shopaccess_operator` | No (group) | — | Adapter and key approvals |
| One named login per operator | Yes | That person | Member of `shopaccess_operator`; its name is what provenance records |

`shopaccess_web` and `shopaccess_worker`: not superuser; cannot create roles; do not bypass row security; are members of no role and cannot `SET ROLE`; own nothing; have no CREATE on either schema; have no right to create temporary objects (owner-approved, Gate A).

**Schemas (owner-approved, Gate A).** `shopaccess` holds the tables. `shopaccess_api` holds the trusted entry-point functions. Earlier wording in this document that made the migration role the owner, and therefore the execution identity, of every trusted function is superseded: a `SECURITY DEFINER` entry point runs as `shopaccess_definer`, which has far less authority than the migration role. Details and the setup sequence are in §18.4.

Each runtime's configuration holds exactly one database credential, its own. For hosted deployment, web and worker are separate services with service-scoped runtime secrets. Do not place both credentials in a shared project/environment group, common build environment, preview environment or process configuration. Verify effective secret scopes before enabling either service; neither browser bundles nor the web build/runtime may contain the worker DB credential or any access path that lets web code receive claim secrets. Raw claim secrets remain in worker memory and are excluded from logs, traces, errors and audit events. On a single development machine under one operating-system account the two credential files are mutually readable; that is a stated local limitation, not process isolation (OPEN D-51). If that local trust is unacceptable, use separate OS identities or isolated containers. No hosted deployment configuration has been inspected; this is a deployment gate, not verified isolation (D-54).

### 3.2 Table privileges

**No application or operator role has INSERT, UPDATE, DELETE or TRUNCATE on any table.**

Direct SELECT, by table (RA011-001; OPEN D-55). "None" means no table-level and no column-level grant.

| Table | Class | `web` | `worker` | `operator` |
| --- | --- | --- | --- | --- |
| `merchants`, `merchant_products`, `merchant_variants` | Public catalog | Yes | Yes | None |
| `database_environment`, `adapter_contracts`, `adapter_contract_status_order`, `adapter_contract_finality`, `adapter_dispatch_policies` | Deployment reference | Yes | Yes | Yes |
| `adapter_finality_suites`, `adapter_finality_evidence`, `adapter_finality_evidence_reviews` | Deployment reference | None | None | Yes |
| `server_key_versions` | Key status, no key material | Yes | None | Yes |
| `checkout_transition_rules`, `entry_point_event_allowlist` | Reference | None | None | None |
| `session_admission_guard` | Global counter | None | None | None |
| `checkout_owners`, `shopper_sessions` | Owner-scoped | **None** | None | None |
| `purchase_groups`, `purchase_group_risk_acknowledgments` | Owner-scoped | **None** | None | None |
| `confirmation_challenges` | Owner-scoped, consent | **None** | None | None |
| `checkout_intents`, `quotes`, `quote_items` | Owner-scoped | **None** | Yes | None |
| `dispatch_authorizations`, `payment_operations` | Payment | **None** | Yes | None |
| `payment_provider_observations`, `payment_refund_evidence`, `evidence_review_queue`, `checkout_transitions` | Payment evidence | **None** | None | None |
| `payment_operation_claims` | Claim credentials | None | None | None |
| `audit_events`, `schema_migrations` | Internal | None | None | Yes (`audit_events` only) |

**Web.** The web process serves every buyer, so a direct SELECT on an owner-scoped table would let any query path in it read every buyer's rows. It has none. It reads those tables only through the functions of §3.5.

**Worker.** The worker is not buyer-facing and already acts on any authorized operation. It keeps direct SELECT only on what its two jobs require: finding committed `ISSUED` authorizations and recoverable operations (`dispatch_authorizations`, `payment_operations`), and building the provider request for an operation it has claimed (`checkout_intents`, `quotes`, `quote_items`, catalog, registry). It loses SELECT on owners, purchase groups, acknowledgments, observations, refund evidence, the review queue, transitions and key versions; the database, not the worker, reads those when it validates and reconciles. The worker can still see every owner's intents and quotes. That is a stated residual (§3.4), not a buyer-reachable path. Returning the request fields from the claim functions and removing these grants as well is a possible later tightening and is not proposed here.

**No reader of the review queue exists** among the runtime and operator roles. Who may read it belongs to the review workflow (D-12).

**How the absence of access is established** (each item is checked by the catalog audit PGT-69a and exercised by PGT-77):

- **PUBLIC.** All privileges on the schema and on every table, sequence and function are revoked from PUBLIC. Default privileges for the owner are set, before any object is created, so new tables, sequences and functions carry no PUBLIC or runtime grant.
- **Inherited privileges.** `shopaccess_web` and `shopaccess_worker` are members of no role and no role is a member of them. They have no `SET ROLE` target.
- **Column privileges.** A column-level grant survives the absence of a table-level one. No column grants exist on any table marked None; the audit reads column privileges as well as table privileges.
- **Views.** The schema contains no view, materialized view or foreign table. A view runs with its owner's privileges by default and would reopen the tables. Adding one requires a specification change; none is granted to a runtime role.
- **Sequences.** Runtime roles have no privilege on any sequence, so sequence values disclose nothing about other owners' activity.
- **Row-level security** is not the control. Definer functions owned by the table owner are not subject to it, and the design does not depend on it.
- **Schema.** USAGE granted to the three non-owner roles; CREATE to none.

### 3.3 Function privileges

- Before any function is created, default privileges for the owner are set so EXECUTE on new functions is not granted to PUBLIC. Each function also has an explicit revoke from PUBLIC.
- Every granted function is `SECURITY DEFINER`, owned by `shopaccess_definer`, in schema `shopaccess_api`, with the fixed search path `pg_catalog, pg_temp` (temporary schema last), schema-qualified references, no dynamic SQL, and pattern checks on every identifier argument.
- Internal helpers are granted to nobody.

| Function | `web` | `worker` | `operator` |
| --- | --- | --- | --- |
| `admit_session`, `authorize_session`, `rotate_session`, `revoke_session` | ✓ | | |
| `start_checkout`, `issue_challenge`, `consume_challenge` | ✓ | | |
| `authorize_dispatch`, `acknowledge_risk`, `cancel_checkout`, `record_buyer_return` | ✓ | | |
| `read_checkout`, `list_owner_checkouts`, `list_blocked_purchases` (§3.5) | ✓ | | |
| `append_web_audit` (**deferred until an approved web-originated event exists that no entry point owns (G2-09); not created in Increment 1 or in Increment 2; no audit obligation is waived (§19.10)**) | ✓ | | |
| `claim_authorized_dispatch`, `claim_for_recovery`, `confirm_claim` | | ✓ | |
| `ingest_operation_evidence`, `ingest_quarantined_evidence`, `ingest_approval_evidence`, `ingest_post_capture_evidence` | | ✓ | |
| `expire_checkout`, `register_contract`, `append_worker_audit` | | ✓ | |
| `approve_adapter_dispatch`, `approve_adapter_finality`, `withdraw_adapter_dispatch`, `withdraw_adapter_finality` | | | ✓ |
| `record_finality_evidence`, `review_finality_evidence` (§7.7) | | | ✓ |
| `activate_key_version`, `revoke_key_version` | | | ✓ (OPEN D-27) |
| `retire_finality_suite` (§7.7) | | | |
| `apply_checkout_event`, `group_risk_fingerprint`, the claim-secret random helper (§2.14), and all other helpers | | | |

`retire_finality_suite` has **no EXECUTE grant** to web, worker, operator or PUBLIC. It is run only by the migration credential on the owner's instruction. It is a maintenance function, not a trusted entry point, and stays owned by the migration role.

This matrix covers every increment. **Increment 1 creates only six of these functions** (the four session functions and the two key functions) and gives the worker no grant of any kind; see §18.3 and §18.4.

The two audit functions accept only event types from their caller's own closed list and reject payment event types.

### 3.4 Trust boundaries

| Party | Trusted to | Not trusted to |
| --- | --- | --- |
| Provider or mock adapter | Report truthfully what happened | — |
| Web process | Terminate buyer requests; compute session digests and confirmation nonces with server keys; **collect a genuine buyer confirmation and submit it only when the buyer gave it** (see "Consent boundary" below) | Name an owner; read another owner's rows; claim, settle or ingest evidence |
| Worker process | Relay the adapter's raw fields unchanged; call the provider only after a confirmed commit; keep its claim secrets | Decide evidence roles, conflicts, reconciliation, state changes or eligibility; act as a buyer |
| PostgreSQL | Validate evidence against stored facts; classify and reconcile it; enforce authority, state rules, history and eligibility | Know whether evidence is genuine |
| Operators | Approve and withdraw adapter contracts and key versions | Touch payment data |
| Migration credentials | Everything | — |

**Protected against:** any application code path, bug or alternative routine that would skip validation, misclassify evidence, change state without evidence, act without authority, or rewrite history.

**Not protected against:**

| If compromised | It can |
| --- | --- |
| Web process | Replay credentials of buyers whose requests it handles, and act within those buyers' own eligibility, **including confirming a purchase and authorizing its dispatch without the buyer's gesture**; read those buyers' own rows through §3.5 |
| Worker process | Claim authorized or recoverable operations and submit well-formed false evidence for them; submit false approval or post-capture evidence for operations in the matching final state; read every owner's intents, quotes, authorizations and operations |
| Adapter or provider | Report false outcomes |
| Migration credentials | Bypass every control |

PostgreSQL cannot prove that a provider response is authentic. No mechanism for that is specified in this milestone (§16).

**Consent boundary (RA011-004; OPEN D-57).**

- The web process is the only party that sees the buyer's confirmation gesture. The database is told that a confirmation happened; it does not witness one.
- The confirmation nonce (§5.3) is derived by the web process from a server key the web process holds. A correct nonce proves that the caller holds that key and a live session credential and names a current challenge. **It is not independent proof that a person pressed a button.**
- A compromised web process, or a defect in it, can therefore produce a valid `consume_challenge` followed by `authorize_dispatch` for any buyer whose session credential passes through it, with no gesture from that buyer. The worker then dispatches, because every database check is satisfied.
- Separating the web and worker roles does not remove this. It stops the web process from claiming, settling and forging evidence, and it limits the damage to buyers whose credentials the web process sees and to purchases those buyers are themselves eligible to make (quote, amount, purchase-group and adapter rules still apply). It does not make the web process's statement of consent verifiable.
- Stronger protection needs a **separately trusted confirmation authority**: a component outside the web process whose approval the database or the worker can verify and the web process cannot forge. Examples are a buyer-held signing key verified in the database, or the payment provider's own hosted approval step treated as the consent of record. None is specified, and no provider behaviour is assumed.
- This is an owner security-boundary decision, not a defect this document can engineer away. D-57 asks the owner to either accept web-process trust for consent in this milestone, with the limitation stated, or require a confirmation authority before any real-money gate. It is listed with the blockers in §17.5.

### 3.5 Owner-scoped read functions (web)

Proposed for RA011-001 (OPEN D-55). These are the only way the web role reads owner-scoped or payment-sensitive data.

| Function | Arguments | Returns |
| --- | --- | --- |
| `read_checkout` | session credential; intent ID | For an intent of the session's owner: buyer-visible intent fields and state; its current quote and items; the quote's `ACTIVE` challenge (ID, expiry, key version, bound quote digest, `nonce_digest`); status and type of the operations its pointers name; refund total; the session's own owner ID; database time |
| `list_owner_checkouts` | session credential | The owner's intents: ID, purchase group, state, created time. Bounded by the limits of §6.6 |
| `list_blocked_purchases` | session credential | The owner's blocked purchase groups with each one's current risk fingerprint (§11), for the page of §6.5 |

Rules for all three:

1. **Owner from the session only.** Arguments are `(key_version, token_digest)` and, for `read_checkout`, an intent ID used as a locator. The function finds the session by the credential pair, requires it to be live at database time, and takes `owner_id` from the session row. There is no owner, session-ID or purchase-group parameter. An owner ID supplied by a caller is never accepted as authorization, here or anywhere (§4.4).
2. **Filter by that owner in the query.** Every row returned is selected with `owner_id` equal to the derived owner, directly or through an owner-carrying composite key (F-1, F-3, F-15, F-17).
3. **One result for every failure.** A missing, unknown, revoked, expired or foreign session, and an intent ID that does not exist or belongs to another owner, all return the same empty "not authorized" result. No message, error code or row count distinguishes "exists but is not yours" from "does not exist". Errors are caught and mapped to that result; no constraint name, identifier or row value from another owner appears in any message.
4. **Fixed column list.** Each function returns named columns from an explicit list. Never returned: `token_digest`, another session's identifiers, claim hashes, worker IDs, fencing versions, adapter payload digests, raw provider reason text, review-queue contents, audit rows.
5. **Definer hygiene.** `SECURITY DEFINER`, owned by `shopaccess_definer`, in schema `shopaccess_api`, fixed search path `pg_catalog, pg_temp`, schema-qualified references, no dynamic SQL, pattern checks on identifier arguments, EXECUTE revoked from PUBLIC and granted to `shopaccess_web` only.
6. **Read-only and advisory.** They take no row locks and write nothing, including no audit row. Nothing is decided from their results: every mutating entry point re-derives the owner and re-checks under locks. Each read function is written in SQL as a single `SELECT`, declared `STABLE`, and calls no function that reads a table (§19.11). `list_blocked_purchases` is deferred.

`nonce_digest` of the owner's own active challenge is returned so the web process can decide whether to reuse the challenge (§5.4). It is a hash of a value the web process can already derive for that owner, and it is never returned for another owner's challenge.

**Indirect disclosure considered.**

| Channel | Treatment |
| --- | --- |
| Mutating entry points given a foreign intent, quote, challenge or group | Already one generic "not authorized" result (§4.4). Refusal reasons such as `PURCHASE_ALREADY_PAID` are returned only after the target is proved to belong to the session's owner |
| `admit_session` capacity refusals | Reveal aggregate load only; no per-owner fact |
| Identifier guessing | Identifiers are random; a guessed foreign ID is indistinguishable from a nonexistent one (rule 3) |
| Unique-constraint errors on caller-supplied new IDs | A collision with another owner's row returns the generic busy/refused result, not the constraint error |
| Response timing | Not equalized. A timing difference between "foreign" and "nonexistent" is a residual, accepted because identifiers are unguessable |
| Catalog, registry, environment, key-version status | Not owner data; readable by design |


---

## 4. Session ownership and authorization

### 4.1 Model

- A session is an expiring credential. An owner is the durable identity that checkout data belongs to.
- `admit_session` always creates a **new** owner with the new session. Nothing attaches a session to an existing owner.
- Rotation keeps the session and its owner and replaces the credential.
- A session can be deleted at any time; nothing references it.
- A buyer whose session ends gets a new owner. Their earlier checkouts are unreachable to them. There is no receipt recovery (unchanged from the foundation specification).

### 4.2 Session keys

- Keys are held only in server-side configuration, outside the repository: a small ring of versions, one `ACTIVE`, the rest `VERIFY_ONLY`. Never in the database, logs or client output.
- `server_key_versions` records which versions exist and their status. It is the single accepted-key policy used by both authorization and capacity counting.
- **The database-designated `ACTIVE` version decides admission eligibility** (owner-approved, Gate A). It need not be the highest version configured: a higher configured version with no row is a staged key and is unused. A web process admits sessions only if the `ACTIVE` version is present in its ring and its check value matches; otherwise it refuses. This supersedes the earlier wording about a "configured active version". The worker holds no key ring.
- The same lifecycle applies to the confirmation-nonce key under its own purpose (OPEN D-16).
- Ring behaviour, check values, staged rotation and emergency revocation are owner-approved and specified in §18.5. The two environment-variable names and the entry syntax remain PROPOSED — OWNER APPROVAL REQUIRED (D-21). Activation and revocation are restricted to the operator role (D-27).

| Event | Effect |
| --- | --- |
| Restart, or several processes, with the same ring | Sessions continue |
| New version activated | Existing sessions continue under their version until they expire or rotate; new sessions use the active version |
| Rotation of a session | New token under the active key; `key_version` changes in the same statement as the digest |
| Version revoked | Its sessions are marked revoked in the same transaction, are not live, do not count toward capacity, and are removed by cleanup |

### 4.3 Liveness

A session is **live at `t`** iff: `revoked_at IS NULL`; `t < absolute_expires_at`; `t < last_seen_at + 2 hours`; and its key version is accepted. The row values are those read under the session lock.

### 4.4 How buyer identity reaches the database

Every buyer-initiated entry point takes `(key_version, token_digest)`, the keyed digest the web process computes from the cookie token. In PostgreSQL mode the key version comes from the `version.token` session cookie (§18.7), as a routing hint only. The function:

1. finds the session by that pair and locks it `FOR SHARE`;
2. takes its remaining locks and reads `t`;
3. requires the session to be live at `t`;
4. takes `owner_id` from the session row;
5. requires its target (intent, quote, challenge, purchase group) to belong to that owner.

No function accepts an owner ID as authority, and none reads a transaction setting or role name to learn who the buyer is. The web role cannot read `shopper_sessions` at all (§3.2), so a digest can only be produced from a real cookie token. The same derivation governs reads (§3.5).

Refusal for a missing, unknown, revoked, expired or foreign session is one generic "not authorized" result; at most one refusal audit row is written.

### 4.5 Session entry points

**`admit_session`** (web)

1. Lock the guard row `FOR UPDATE`. Read `t`.
2. If the window has elapsed, reset it. If `window_admissions >= 30`: refuse; the budget is not consumed by this refusal.
3. Increment `window_admissions`.
4. Delete sessions that are revoked, expired, idle or under a non-accepted key version, skipping locked rows.
5. Count **every remaining session row**, with no liveness or time filter. If 500 or more: refuse. A row that step 4 skipped because another transaction holds it may be made live again by that transaction (a touch or a rotation), so it is never treated as expired (§18.12, correction 1). The number of live sessions can then never exceed the number of rows, and the number of rows never exceeds 500. **This refusal has consumed the budget** (D-4; the limits of 500 and 30 are owner-approved for the local MVP; matches **[APPROVED-M1: `src/lib/session/service.ts`]**).
6. Generate the owner ID in the database (§2.4), then insert the new owner and the new session with `created_at = last_seen_at = t`. The caller supplies the session ID, key version and token digest, never an owner ID.

**`authorize_session`** (web): lock the session `FOR NO KEY UPDATE`; read `t`; if not live, write nothing and refuse; if live and `t - last_seen_at` exceeds the touch threshold (60 seconds, owner-approved for the local MVP, D-7), set `last_seen_at = t`.

**`rotate_session`** (web): lock the active key-version row `FOR SHARE`, then the session `FOR NO KEY UPDATE`; read `t`; require live; replace digest and key version, guarded by the old values; return the ID of the row that was rotated (§18.12, correction 8).

**`revoke_session`** (web): lock the session; read `t`; set `revoked_at = t` if not already set.

A mutation is authorized by its own transaction's decision at `t`, not by an earlier `authorize_session`.

---

## 5. Quotes and confirmation challenges

### 5.1 Quote digest `SAQD-1`

Bytes: ASCII `SAQD`; version byte `0x01`; a 2-byte big-endian field count (19); then 19 fields, each one type byte, a 4-byte big-endian length and the value. Type `0x01` is ASCII text; type `0x02` is an 8-byte big-endian two's-complement integer.

Field order: quote ID; owner ID; intent ID; purchase group ID; merchant ID; product ID; variant ID; catalog revision; quantity; unit amount; subtotal; discount; tax; shipping; total; currency; assumptions code; created-at and expires-at as microseconds since the Unix epoch, UTC.

The digest is SHA-256 over those bytes, in lowercase hex. It is computed by the database. Test vectors are in §15 (PGT-73).

### 5.2 `start_checkout` (web)

Arguments: session credential; product, variant and quantity; optionally `replaces_intent_id`. Group, intent, quote and event IDs are generated in the database (§19.12). **No amount, currency, merchant or digest is accepted.**

1. Locks: session `FOR SHARE`; owner row `FOR UPDATE`; for a replacement or re-quote, the existing intent `FOR UPDATE`. Read `t`. No catalog row is locked explicitly. Catalog data is read in one statement after the last lock (§19.4). The complete Increment 2 sequence is in §19.7.
2. Session authority (§4.4).
3. Variant exists, is in stock, quantity within its limit; subtotal a safe integer.
4. Purchase group: the replaced intent's group, or a new group. A new group is refused when the owner already has 10 active or unresolved groups (§6.6). Increment 2 has no in-place re-quote and no stored `DRAFT` state (§19.7). A re-quote of an existing `DRAFT` is refused when `t` is at or after its `created_at` plus 24 hours (§8.10), whatever state the row still shows.
5. Read merchant, product and variant with one joined, single-statement catalog query, issued after the required checkout locks. Build the quote from the values that query returned: amounts, merchant, catalog revision, display snapshot, `created_at = t`, `expires_at = t + 15 minutes`, `SAQD-1` digest. No `SELECT … FOR SHARE` and no other explicit catalog row lock is taken. The only catalog locks are the implicit key-share locks of the foreign-key checks when the quote and its item are inserted; they do not block a reprice (§19.4, PGT-118).
6. Insert group (if new), intent at version 2 in `QUOTED`, quote, quote item, the `QUOTE_ISSUED` transition and an audit row. For a replacement whose predecessor is in a stoppable state, apply `SUPERSEDED` to it.

Failure: any error rolls back everything. Not idempotent by design; a repeated request creates another checkout.

### 5.3 Confirmation nonce

The nonce is computed by the web process, never stored:

`nonce = HMAC-SHA-256(nonce key, label ‖ challenge ID ‖ owner ID ‖ quote digest)`

The database stores `SHA-256(nonce)` and the key version. The nonce stays unguessable without the server key, is bound to one challenge, owner and quote, and is single-use because consumption is recorded on the row.

What the nonce does not prove: that the buyer made the confirming gesture. The web process holds the key and can derive the nonce itself. See the consent boundary in §3.4 (OPEN D-57).

### 5.4 Showing a challenge (read path)

The web process calls `read_checkout` (§3.5) with the session credential and the intent ID. It receives, for the session's own owner only, the intent, quote, the quote's `ACTIVE` challenge and the database time. No locks are taken and the web role reads no table directly. It reuses the challenge if: the intent is `QUOTED` and points at the quote; the challenge is bound to the quote's digest; more than the renewal margin remains (*60 s, proposal*, OPEN D-6); and the nonce re-derived with the current key hashes to `nonce_digest`. Nothing is written. Otherwise it calls `issue_challenge`.

Refreshing, navigating and opening a second tab therefore show the same challenge. Whichever tab submits first consumes it.

**[APPROVED-M1]** behaves differently: the mock replaces the challenge on every view. See §17.2.

### 5.5 `issue_challenge` (web)

1. Locks: session `FOR SHARE`; intent `FOR UPDATE`; the quote's `ACTIVE` challenge `FOR UPDATE` if any. Read `t`. No catalog row is locked explicitly. Catalog data is read in one statement after the last lock (§19.4).
2. Session authority. State `QUOTED`, pointer names this quote, `t < quotes.expires_at`, variant unchanged.
3. Recompute the `SAQD-1` digest from the stored quote and item; require it to equal `quotes.digest`. Otherwise refuse `QUOTE_DIGEST_MISMATCH`.
4. If a `CONSUMED` challenge exists for the quote: refuse.
5. If the existing `ACTIVE` row is in fact reusable: return it, write nothing.
6. Otherwise mark it `EXPIRED` (past expiry at `t`) or `SUPERSEDED`.
7. If the quote already has more than the structural ceiling of challenges (*8, proposal*, OPEN D-6): refuse.
8. Insert the new `ACTIVE` row: `issued_at = t`, `expires_at` the earlier of `t + 5 minutes` and the quote's expiry.

### 5.6 `consume_challenge` (web)

Arguments: session credential; challenge ID; nonce; quote ID; quote digest.

1. Locks: session `FOR SHARE`; intent `FOR UPDATE`; the submitted challenge `FOR UPDATE`. Read `t`. No catalog row is locked explicitly. Catalog data is read in one statement after the last lock (§19.4).
2. Decide, first match:

| Condition | Result |
| --- | --- |
| Session not authorized | Not authorized |
| No such challenge for this owner | `CONFIRMATION_NOT_FOUND` |
| The quote has a different `CONSUMED` challenge | `CONFIRMATION_ALREADY_USED` |
| Status `SUPERSEDED` | `CONFIRMATION_SUPERSEDED` |
| Status `CONSUMED` | `CONFIRMATION_ALREADY_USED` |
| SHA-256 of the nonce differs from `nonce_digest`, or the submitted quote ID or digest differs | `CONFIRMATION_MISMATCH` |
| Status `EXPIRED`, or `ACTIVE` with `t >= expires_at` | Mark `EXPIRED`; `CONFIRMATION_EXPIRED` |
| Recomputed `SAQD-1` digest differs from `quotes.digest` or from the challenge's `quote_digest` | `QUOTE_DIGEST_MISMATCH` |
| Quote expired or variant changed | `QUOTE_EXPIRED` or `QUOTE_STALE_CATALOG` |
| Intent not `QUOTED` with this quote | `INTENT_NOT_AWAITING_CONFIRMATION` |

3. Otherwise: challenge to `CONSUMED` with `consumed_at = t`; apply `SHOPPER_CONFIRMED`; transition; audit.

Concurrent submissions are serialized by the intent lock; the second sees `CONSUMED`. A replay writes nothing.

---

## 6. Purchase groups and cross-intent duplicate-payment prevention

### 6.1 Identity

- A purchase group is one buyer-authorized purchase. It is created with the first intent of that purchase and never changes owner or membership rules.
- An intent created with `replaces_intent_id` joins that intent's group. An intent created without it starts a new group.
- A group is never inferred from product, price or cart contents.
- Expiry, cancellation and supersession are intent events and do not change the group.

### 6.2 Derived condition

Two independent facts per group, computed only under the locks of §8.3:

| Fact | True when |
| --- | --- |
| **paid** | A capture operation of the group is `SUCCEEDED`. Permanent |
| **blocked** | Any of: a capture operation not `SUCCEEDED`, `DECLINED` or `REJECTED`; a review-queue entry on a member intent; a `CONFLICTING` capture observation; E-4 failing; a `DECLINED` or `REJECTED` capture without verified finality (E-5) |

Presentation, first match:

| Condition | paid | blocked | Shown to the buyer |
| --- | --- | --- | --- |
| Paid, evidence under review | yes | yes | "Paid. Additional payment evidence is under review." |
| Paid | yes | no | "Paid." |
| Unresolved | no | yes | "Payment outcome not yet known." |
| Final, not paid | no | no, with a capture | "Not charged. You can try again." |
| None | no | no | Nothing |

A paid purchase is never shown or recorded as unpaid.

### 6.3 Capture eligibility E-1 to E-5

Over every capture operation of the group:

| # | Condition | Enforced |
| --- | --- | --- |
| E-1 | Every capture operation is `DECLINED` or `REJECTED` | Partial unique index, and function |
| E-2 | No review-queue entry on any member intent | Insert trigger, and function |
| E-3 | No `CONFLICTING` capture observation | Function |
| E-4 | No `QUARANTINED` observation of a prior capture has `observation_seq` above that operation's `quarantine_reconciled_seq` together with a `reconciliation_outcome` other than `IDENTICAL` or `COMPATIBLE` | Function |
| E-5 | Each prior capture's **pinned** adapter contract has **effective** finality for that operation's recorded outcome and reason class: a `VERIFIED` row whose cited suite is not retired, read while holding the contract row lock | Function; CT-2 |

For E-5: an operation state of `DECLINED` or `REJECTED` is not evidence that the provider will never complete that capture. Missing, withdrawn or non-matching finality fails. The absence of adverse evidence does not satisfy it. A `VERIFIED` row can exist only with reviewed, passing conformance evidence for the pinned contract digest and that outcome (§7.7). **No such row exists in this draft for any adapter, so retry after a decline or rejection is refused everywhere** with `PRIOR_CAPTURE_FINALITY_UNVERIFIED`.

### 6.4 Dispatch rules G-1 to G-3

Applied to order-create and capture dispatch alike.

| # | Rule | Refusal reason |
| --- | --- | --- |
| G-1 | This group is not paid | `PURCHASE_ALREADY_PAID`; or `PURCHASE_PAID_EVIDENCE_DISPUTED` if also blocked |
| G-2 | This group is not blocked | `PRIOR_PAYMENT_OUTCOME_UNRESOLVED`; or `PRIOR_CAPTURE_FINALITY_UNVERIFIED` when only E-5 fails |
| G-3 | For every **other** group of the owner that is blocked now, an acknowledgment row exists for this group, that group and that group's current risk fingerprint (§11) | `OTHER_PURCHASE_UNRESOLVED` |

### 6.5 Re-entry in the same session

- Pages show the owner's blocked purchases, obtained through `list_blocked_purchases` (§3.5), with two explicit choices: resume, or declare a separate purchase.
- Resume opens the existing intent or creates a replacement in the same group; its dispatch is refused by G-2 until the earlier payment is resolved.
- A fresh checkout can be created and quoted in a new group, but its dispatch is refused by G-3. Opening a new checkout does not get round the block.
- Declaring a separate purchase is `acknowledge_risk` (§11.4), once per blocked purchase shown.

Whether acknowledgment is permitted at all is OPEN (D-33).

### 6.6 Limits

- **Anonymous cross-session duplicates are not prevented.** A new session is a new owner with no link to an earlier one. This design does not claim otherwise.
- A buyer's "separate purchase" declaration cannot be verified. It is a deliberate, recorded act.
- With manual-review resolution deferred (D-12), a blocked group stays blocked.

**Bounds (D-38: owner-approved for the local MVP: the capacity semantics, the limit of 10 active or unresolved purchase groups per shopper, and the conservative classification below. The intents-per-group value of 10 is owner-approved separately, G2-14).**

This is a limit on purchases that are open or unresolved at one time. **It is not a lifetime purchase limit**: a shopper may complete any number of purchases, provided no more than 10 are active or unresolved when a new one is started.

| Bound | Proposed value | Counted |
| --- | --- | --- |
| Active or unresolved purchase groups per shopper (owner) | **10 — owner-approved, local MVP** | Only the owner's **active or unresolved** groups, as classified below |
| Intents per purchase group | **10 — owner-approved, local MVP (G2-14)** | Every intent of the group, in any state |

**Which groups consume capacity.** A group is counted unless it is **fully resolved**. A group is fully resolved only when every one of these holds, using existing states and facts only; no payment state is added:

| # | Condition for "fully resolved" | Existing source |
| --- | --- | --- |
| C-1 | No dispatch authorization of a member intent is `ISSUED` | §2.12 |
| C-2 | No operation of a member intent, of either type, is non-final (`PENDING`, `DISPATCHING`, `UNKNOWN`, `READBACK_CLEARED`, `PENDING_PROVIDER`), parked, or `CONFLICT` | §7.2, §7.3 |
| C-3 | The group is not **blocked** (§6.2). That covers a review-queue entry, a `CONFLICTING` capture observation, unreconciled quarantined evidence (E-4), and a `DECLINED` or `REJECTED` capture without effective finality (E-5) | §6.2, §6.3 |
| C-4 | Every member intent is in a resolved state from the table below | The 22 reducer states **[APPROVED-M1]** |

| Intent state | Class | Why |
| --- | --- | --- |
| `SUPERSEDED`, `CANCELED_LOCAL`, `EXPIRED`, `FAILED_TERMINAL` | Resolved, unpaid | Terminal; the reducer permits no capture from them |
| `CAPTURED_VERIFIED` | Resolved, paid | Paid and complete, with no refund, reversal or dispute observed |
| `REFUNDED_OBSERVED` | Resolved, paid then fully refunded | The ledger total equals the captured amount; nothing remains to refund |
| `DRAFT`, `QUOTED`, `USER_CONFIRMED`, `ORDER_CREATE_IN_FLIGHT`, `ORDER_CREATE_UNKNOWN`, `AWAITING_APPROVAL`, `APPROVAL_CHECK_PENDING`, `APPROVED_VERIFIED`, `CAPTURE_IN_FLIGHT`, `CAPTURE_UNKNOWN`, `CAPTURE_PENDING_PROVIDER`, `DECLINED_RETRYABLE`, `RECONCILIATION_REQUIRED` | **Unresolved** | A live checkout, an authorization, or an uncertain or pending payment outcome |
| `MANUAL_REVIEW` | **Unresolved** | A review obligation with no resolution path (D-12) |
| `PARTIALLY_REFUNDED_OBSERVED` | **Unresolved** | The state model cannot say that a partial refund is the last one |
| `REVERSED_OR_DISPUTED_OBSERVED` | **Unresolved** | The state model has no state for a concluded reversal or dispute |

- **A capture alone does not resolve a group.** A group containing a `CAPTURED_VERIFIED` intent is still counted if any of C-1 to C-3 fails, or if another member intent is unresolved. A paid group that is also blocked ("Paid, evidence under review", §6.2) is counted.
- **Resolution is not permanent.** A resolved group becomes unresolved again when later evidence arrives (a partial refund, a reversal or dispute, a review entry). It then counts again. No record is rewritten to keep it resolved.
- **No group is declared resolved to free capacity.** Classification is read from the stored states and facts only. No function, operator action or cleanup marks a group resolved, and nothing reclassifies one because the limit has been reached.
- **Conservative where the model cannot tell (owner-approved classification).** Incomplete refunds, reversals, disputes, uncertain payment outcomes and manual-review obligations stay unresolved until a verified resolution is recorded. The existing state model has no state or fact for a concluded reversal or dispute, a final partial refund, or a resolved review entry, so today such groups never become resolved. This document does not invent one, and no automatic dispute or review resolution is specified (D-12). With review resolution deferred (D-12), such groups, blocked groups and `MANUAL_REVIEW` groups consume capacity indefinitely; an owner who accumulates the limit of them can create no further group. That is the fail-closed consequence of the approved policy and is stated, not worked around.
- **History is retained.** Resolved groups and all their intents, operations, evidence, transitions and audit rows stay in place and stay readable. They are removed only by a separately approved retention policy (D-11; none is approved, and history deletion is not designed).

**At capacity.** `start_checkout` refuses to create a new group when the owner's active count has reached the limit, and refuses a further intent in a group at its intent limit. It writes one refusal audit row. Nothing is deleted, overwritten, superseded, merged, recycled or reclassified to make room, and no record is altered to appear resolved. The buyer can still view, resume or cancel what exists. Creating an intent inside an existing group is governed by the intent bound only. The refusal code's name is a signature detail and is unapproved.

**Race safety.** The count is taken inside `start_checkout` after it holds the owner row `FOR UPDATE` (§13.6), which every group-creating call for that owner must take. Concurrent creations are therefore serialized: each counts after the previous one has committed or rolled back, and creation can never take the owner past the limit. The classification is read at that moment from committed rows. Evidence ingestion does not take the owner lock, so late evidence can make a resolved group unresolved and the number of unresolved groups **can exceed 10 without any creation**. When that happens every existing record stays intact and correctly classified, nothing is deleted, recycled, overwritten or relabelled to bring the number down, and new group creation stays refused for as long as the count is at or above 10. The bound limits creation, not the arrival of evidence. Whether the count is computed by query at each creation or held as a maintained counter is an exact-schema choice (PROPOSED — OWNER APPROVAL REQUIRED); a counter would have to be updated by every writer that can change C-1 to C-4.
---

## 7. Payment operations and adapter-contract pinning

### 7.1 Identity

- A logical operation is `(checkout_intent_id, operation_type, sequence)`.
- Its provider request ID is generated once at insert and never changes.
- A new capture after a provider-confirmed decline is the next sequence with a new request ID **[APPROVED-M1 rule]**.
- Its `adapter_id` and `adapter_contract_version` are set at insert from the claiming worker's adapter and never change.

### 7.2 Operation states in PostgreSQL mode

| State | Written when | Recovery |
| --- | --- | --- |
| `PENDING` | Never | Reported by V-8 if present |
| `DISPATCHING` | Claimed; a provider request may be in progress | After lease expiry: takeover, becomes `UNKNOWN` |
| `UNKNOWN` | No response, or takeover of a crashed claim | Readback when due |
| `READBACK_CLEARED` | Never (the resend decision is one transaction) | Treated as `UNKNOWN` if present |
| `PENDING_PROVIDER` | Provider accepted the capture, not yet final | Readback on backoff |
| `SUCCEEDED`, `DECLINED`, `REJECTED` | Provider-confirmed outcome | None; immutable |
| `CONFLICT` | Evidence contradicted the quote, order, recorded outcome or other evidence | None; parked |

### 7.3 Scheduling

| Write | Sets |
| --- | --- |
| Claim for dispatch; resend | `lease_expires_at = t + lease`; `next_recovery_at = lease_expires_at`; `provider_call_deadline_at = t + call timeout` |
| Recovery takeover | Lease and `next_recovery_at` as above. **`provider_call_deadline_at` unchanged** |
| Settlement to `PENDING_PROVIDER`; harmless duplicate; readback unavailable | Lease cleared; `next_recovery_at = t + backoff` |
| No response | Lease cleared; `next_recovery_at = t` |
| Settlement to a final state | Lease cleared; both scheduling columns NULL |
| Review, incoherence, escalation, resend prohibited | Lease cleared; `next_recovery_at = NULL`; `parked_at = t`; `parked_reason` set |

The CHECKs in §2.13 make it impossible to commit a non-parked recoverable operation with no schedule.

Lease length, call timeout, safety margin, backoff and escalation age are OPEN (D-20, D-26). The lease must exceed the call timeout.

### 7.4 Coherence table

For the operation an intent currently points to:

| Operation | Checkout states it may be committed with |
| --- | --- |
| Order-create `DISPATCHING` | `ORDER_CREATE_IN_FLIGHT` |
| Order-create `UNKNOWN`, not parked | `ORDER_CREATE_IN_FLIGHT` (only between a takeover and the next ingestion), `ORDER_CREATE_UNKNOWN`, `RECONCILIATION_REQUIRED` |
| Order-create `UNKNOWN`, parked | `MANUAL_REVIEW` |
| Order-create `SUCCEEDED` | Every state except `DRAFT`, `QUOTED`, `USER_CONFIRMED`, `ORDER_CREATE_IN_FLIGHT`, `ORDER_CREATE_UNKNOWN`, `FAILED_TERMINAL` |
| Order-create `REJECTED` | `FAILED_TERMINAL` |
| Capture `DISPATCHING` | `CAPTURE_IN_FLIGHT` |
| Capture `UNKNOWN`, not parked | `CAPTURE_IN_FLIGHT` (same window), `CAPTURE_UNKNOWN`, `RECONCILIATION_REQUIRED` |
| Capture `UNKNOWN` or `PENDING_PROVIDER`, parked | `MANUAL_REVIEW` |
| Capture `PENDING_PROVIDER`, not parked | `CAPTURE_PENDING_PROVIDER` |
| Capture `SUCCEEDED` | `CAPTURED_VERIFIED` and the three observed-refund states |
| Capture `DECLINED` or `REJECTED` | Not pointed to; the reducer clears the pointer |
| Any `CONFLICT` | `MANUAL_REVIEW`; or a terminal or paid state only with a `SETTLEMENT_INCOHERENT` review entry for that operation |

Enforced by the entry points and checked by V-5.

### 7.5 Adapter contracts

A contract declares, per adapter and version:

1. **Identity:** which fields identify a provider object.
2. **Immutable fields** of an object.
3. **Status order:** allowed status steps, never backward; whether "not found" is the start. May be declared absent for a subject.
4. **Ordering evidence:** provider timestamps are never used to order evidence.
5. **Finality:** which non-success outcomes are final (§7.6).
6. **Replay:** whether resending an order-create under the same request ID is idempotent.

Lifecycle:

| Step | By | Effect |
| --- | --- | --- |
| Registration | Worker, `register_contract` | Row inserted `DISCOVERED`; status-order rows inserted; digest computed by the database from the stored metadata and required to equal the worker's; contract sealed. Confers nothing |
| Dispatch approval | Operator, `approve_adapter_dispatch(adapter, version, expected_digest)` | Requires: exists, sealed, `DISCOVERED`; recomputed digest equals stored and expected; each subject has status-order rows or is declared to have none. Then `APPROVED` |
| Finality evidence | Operators, `record_finality_evidence` then `review_finality_evidence` | Appends an immutable result record bound to contract digest, outcome and suite version; a different operator accepts or rejects it (§7.7). Confers nothing by itself |
| Finality approval | Operator, `approve_adapter_finality` | Same digest checks, plus every evidence check of §7.7; inserts a `VERIFIED` row for one outcome and reason class. Refused when any check fails |
| Withdrawal | Operator, `withdraw_*` | Status to `WITHDRAWN`. See the dependency note below |

**Dependency between dispatch standing, dispatch policy and finality.** It runs one way only.

- Finality approval depends on the contract: A-1 (§7.7) refuses it when the contract's dispatch status is `WITHDRAWN`. It does not require the contract to be dispatch-approved or to be named by any dispatch policy row.
- Dispatch approval and dispatch policy never depend on finality. A contract can be approved and selected by policy with no finality row; that is the state of every contract in this draft.
- Withdrawing dispatch approval, or retiring a policy row, does not change existing finality rows. It blocks *new* finality approvals for that contract.
- Withdrawing finality, or retiring a suite, does not change dispatch approval or policy. It removes retry eligibility only.

- A worker settles or recovers only operations whose pinned contract it carries with a digest equal to the registered one. Recovery selection filters on that. An operation no running worker supports stays scheduled and untouched.
- Withdrawing dispatch approval stops new operations under that contract. It does not stop recovery of operations already in flight (OPEN D-42).
- Builds must keep the definition of every contract version still referenced by a non-final operation or needed for E-4 and E-5.

### 7.6 Terminal-decline finality

For a capture request under request ID `R`, an outcome is final non-success only if the provider guarantees: the request captured no funds; the same request, if processed again under `R`, yields the same outcome and never a capture; and any capture object it created never becomes successful.

| Adapter outcome | Standing in this draft |
| --- | --- |
| Mock: capture object `DECLINED` | **Unverified. Retry disabled.** Reading the mock's source (`src/lib/providers/payment.ts`) suggests it could meet all three. That is a hypothesis to test, not conformance proof, and it supports no approval. It can become `VERIFIED` only through §7.7, after a suite exists, evidence is recorded and accepted, and the owner approves D-30 |
| Mock: `REJECTED` (injected, or order missing or not approved) | **Not provided.** The mock keeps no record of a rejected request ID, so a later arrival of the same request could capture. Retry after a rejection is refused until the mock is changed (OPEN D-31) |
| Any real provider | **Unverified.** No retry is authorized. No finality guarantee of PayPal or any other provider is assumed |

### 7.7 Finality governance (fail-closed)

Proposed for RA011-002 (OPEN D-56; D-30 stays OPEN). Retry after a decline is disabled by default and stays disabled until every step below has happened for the exact pinned contract and outcome.

**Chain required before a `VERIFIED` row can exist:**

1. **A suite version exists.** An owner-approved migration seeds an `adapter_finality_suites` row for that adapter and outcome. None is seeded by this draft.
2. **The suite was executed** against the adapter build whose contract digest equals the registered digest. Reading source code, reasoning about it, or a provider's documentation is not an execution.
3. **The result is recorded.** `record_finality_evidence` appends one immutable `adapter_finality_evidence` row. It requires: the contract exists, is sealed, and its recomputed digest equals the stored and supplied digests; the suite row exists, is not retired, and is for that adapter and outcome; the supplied suite digest equals the suite row's.
4. **A second person reviews it.** `review_finality_evidence(evidence, verdict, expected_result_digest)` appends the review. The reviewer's login differs from the recorder's, and the supplied digest equals the stored one.
5. **The owner has approved D-30** for that adapter and outcome. This is an instruction outside the database; the migration of step 1 is how it takes effect.
6. **An operator approves.** `approve_adapter_finality(adapter, version, expected_contract_digest, outcome, reason_class, evidence_id, expected_result_digest)`.

**`approve_adapter_finality` refuses unless all of these hold**, checked under the contract row lock `FOR UPDATE`:

| # | Check |
| --- | --- |
| A-1 | Contract exists, is sealed, is not `WITHDRAWN`, and its recomputed digest equals the stored and expected digests |
| A-2 | The evidence row exists and its adapter, contract version, **contract digest**, outcome and reason class equal the approval's |
| A-3 | Evidence `result` is `PASS` |
| A-4 | Evidence `result_digest` equals the expected digest supplied by the approver |
| A-5 | The evidence's suite row, locked `FOR SHARE` after the contract row, is not retired, and its digest equals the digest stored in the evidence |
| A-6 | A review exists with verdict `ACCEPTED` |
| A-7 | The approver's login differs from the recorder's |
| A-8 | No finality row already exists for that contract and outcome (a `WITHDRAWN` row is never revived; a new contract version is required) |

A-2, A-3 and A-6 are also enforced by F-25, F-26 and NOT NULL, so a direct insert that skips the function fails as well. Each refusal writes one audit row naming the failed check.

**What counts as a passing result.** `PASS` means all of:

- every case of the cited suite version ran: none skipped, none errored, none failed, and the count equals the suite's `required_case_count`;
- the suite version contains, for the outcome under test, at least one executed case for each guarantee of §7.6: no funds captured; the same request ID processed again after the outcome yields the same outcome and never a capture, including a late and a duplicated arrival; a capture object created by the request never becomes successful afterwards;
- the run was against the adapter whose registered contract digest is the one cited.

**Result digest.** SHA-256 over the canonical result record: adapter ID, contract version, contract digest, outcome, reason class, suite ID, suite version, suite digest, the five case counts, and the ordered list of `(case identifier, verdict)`. The record itself is kept at `result_location`.

**Approval authority.** The approver is a named operator login; `approved_by` records it. Recorder, reviewer and approver are named logins, with the recorder different from both others. Whether the reviewer and approver must also differ, and which people hold these duties, is for the owner (D-56).

**Withdrawal.** `withdraw_adapter_finality` is unchanged and immediate; it records `withdrawn_reason = 'OPERATOR'`. Finality is bound to one contract digest, so a changed adapter contract is a new version with no finality.

**Suite retirement (AR012-001).** Retiring a suite and invalidating the finality that rests on it are one transaction. They cannot be done separately.

`retire_finality_suite(suite_id, suite_version)` is owned by `shopaccess_owner`, granted to no runtime or operator role, and run by the migration credential on the owner's instruction. In one transaction it:

1. locks `FOR UPDATE` every `adapter_contracts` row of the suite's adapter, in ascending contract version;
2. locks the suite row `FOR UPDATE`;
3. locks `FOR UPDATE`, in key order, every `VERIFIED` finality row whose evidence cites that suite version;
4. sets `retired_at`;
5. moves each of those finality rows to `WITHDRAWN` with `withdrawn_reason = 'SUITE_RETIRED'`;
6. writes one audit row naming the suite and the finality rows withdrawn.

Three mechanisms make stale finality unusable:

| Mechanism | Effect |
| --- | --- |
| Atomic retirement | After the commit no `VERIFIED` row cites the retired suite |
| CT-2 | Any transaction that would commit a `VERIFIED` row citing a retired suite fails, including a direct `UPDATE` of `retired_at` by the table owner that skips the function |
| E-5 reads effective finality | `authorize_dispatch` and `claim_authorized_dispatch` require `VERIFIED` **and** an unretired suite, read under the contract row lock they already hold. This is redundant with the two rows above by design |

**Races.** Every finality-dependent decision is taken while holding `FOR SHARE` the contract row of each prior capture (§8.1, §8.2, §11.4). Retirement needs those same rows `FOR UPDATE`.

| Race | Outcome |
| --- | --- |
| Retirement against `authorize_dispatch` | One waits for the other. Authorization first: it commits an authorization, and the later claim re-evaluates E-5 and refuses. Retirement first: authorization sees `WITHDRAWN` and refuses |
| Retirement against `claim_authorized_dispatch` | One waits. Retirement first: the claim refuses `PRIOR_CAPTURE_FINALITY_UNVERIFIED`, the authorization becomes `REFUSED`, no operation exists and nothing is sent. Claim first: see the residual below |
| Retirement against `approve_adapter_finality` | Approval holds the contract row `FOR UPDATE`, so one waits. Retirement first: A-5 refuses. Approval first: retirement then withdraws the new row in step 5 |
| Retirement against `acknowledge_risk` | Acknowledgment holds registry rows `FOR SHARE`. Retirement first: the submitted fingerprint is stale and is refused. Acknowledgment first: the stored acknowledgment no longer matches after retirement (below) |
| Retirement against recovery | Recovery takes no finality-dependent decision: it reads back and settles an operation that already exists, and capture resend is disabled. It is unaffected and never blocked |

**In-flight residual: UNRESOLVED AND NOT APPROVED.** A capture retry whose claim committed before retirement is already an operation; as specified, its provider request could be sent after retirement commits. The owner's approval of D-42 covers dispatch-policy withdrawal and in-flight recovery; it explicitly does **not** cover this case, and this document does not treat it as accepted.

- It cannot occur in the approved scope: with no suite row there is no `VERIFIED` finality, so no retry is ever authorized or claimed.
- It must be resolved by an owner decision before any retry is enabled (with D-30). Candidate treatments, none approved: a pre-send eligibility check for retry captures; a hold between claim and send; or accepting the residual.
- Retries remain disabled.

**Fingerprints and acknowledgments.** Retirement changes the effective standing of each affected finality row from `VERIFIED` to `WITHDRAWN`. Effective standing is part of the risk fingerprint (§11.1), so the fingerprint of every purchase group with a capture pinned to an affected contract and outcome changes in the same commit. Acknowledgments are keyed by fingerprint and G-3 requires one for the *current* fingerprint, so every earlier acknowledgment of such a group stops satisfying G-3 at that commit, with no row rewritten. The group itself becomes blocked again by E-5. Standing still moves only forward (§11.3).

**Fail-closed.** Retirement can only remove retry eligibility. Nothing restores a withdrawn row (A-8); a new suite version, new evidence, a new review and a new approval on a new contract version are required.

**Contract-version consequence.** The finality key is `(adapter_id, contract_version, outcome_status, reason_class)` and a `WITHDRAWN` row is never revived. So after a suite is retired, finality for the same adapter and outcome can be approved again only under a **new contract version**, even when the adapter's behaviour and metadata have not changed. This is deliberate in the present design: it is the conservative reading and keeps every approval tied to one never-reused row. Whether re-verification of an unchanged contract should be possible is deferred with retry enablement. Nothing here enables a retry or a finality approval. Verification query V-23 must return no rows.

**What this does not establish.** The database cannot observe a test run. An evidence row is a signed-for statement by named people, bound by digest to a record kept elsewhere. The control makes approval without such a statement impossible and makes every approval traceable to a specific result; it does not make a false statement impossible. That rests on the operators and on D-56.

---

## 8. Trusted entry points and transaction protocols

Every entry point is a database function that performs all of its writes or none. It never commits; its caller's transaction does (§12.1). Any unhandled error propagates and the caller must roll back. Within one call, throttle counters, audit rows, checkout rows and challenge status changes commit or roll back together (§19.5).

Sections 4.5, 5.2, 5.5 and 5.6 specify the session, checkout and challenge entry points. This section specifies the rest.

### 8.1 `authorize_dispatch` (web; buyer-initiated)

DEFERRED. The explicit variant lock here must be reconciled with §19.4 before the dispatch increment.

Arguments: session credential; intent ID; new authorization ID. It accepts no amount, quote digest, confirmation ID, operation type, adapter ID, adapter version or provider identity from the buyer, AI or browser. Derive `ORDER_CREATE` only from locked state `USER_CONFIRMED`, and `CAPTURE` only from locked state `APPROVED_VERIFIED`; otherwise refuse.

1. Locks: session `FOR SHARE`; variant `FOR SHARE` (order only, after the unlocked preliminary read of §13.4); owner row `FOR UPDATE`; intents (§13.3); current consumed confirmation challenge; any existing authorization row; active server-policy row `FOR SHARE`; selected adapter contract and prior-capture registry rows `FOR SHARE`, all in global order. Read `t` after the final blocking lock.
2. Session authority.
3. State is `USER_CONFIRMED` (order) or `APPROVED_VERIFIED` with a provider order ID (capture). Require the current quote/digest and exact consumed confirmation challenge, whose quote/digest must match. For an order, the quote is unexpired and the variant unchanged; if not, apply `QUOTE_INVALIDATED` and stop.
4. Resolve the unique active server policy keyed by environment and operation type; no client/AI/worker adapter selector is accepted. Require the exact contract sealed, digest-valid and dispatch-approved; snapshot policy ID/version and adapter ID/version/digest. Missing or ambiguous policy fails closed. D-53 remains open for owner selection of policy ownership and activation semantics.
5. G-1 to G-3.
6. Inspect the already-locked `ISSUED` authorization for the intent/type. Reuse or refuse an unexpired authorization only if its full snapshot matches. Expire/refuse expired or stale authorizations before replacement.
7. Refused: one audit row `DISPATCH_REFUSED_UNRESOLVED` naming the failed rules.
8. Eligible: insert the immutable snapshot authorization as `ISSUED` with `expires_at = t + lifetime` (*120 s, proposal*, OPEN D-47), and an audit row.

Creates no operation. Returns no claim secret. The web transaction wrapper confirms COMMIT before the authorization is visible to the worker. The worker discovers committed `ISSUED` authorizations by polling PostgreSQL; no web-to-worker message carries authority, and the authorization ID is only a locator, not a bearer secret.

### 8.2 `claim_authorized_dispatch` (worker)

DEFERRED. The explicit variant lock here must be reconciled with §19.4 before the dispatch increment.

Arguments: authorization ID; new operation ID, request ID, event IDs; worker ID. The worker cannot select an adapter or submit a contract version/digest for the operation.

**Phase A, locks:** variant `FOR SHARE` (order only); owner row `FOR UPDATE`; all relevant owner intents in ascending ID; exact consumed challenge `FOR SHARE`; authorization row `FOR UPDATE`; pinned adapter-policy row `FOR SHARE`; then adapter-contract and prior-capture contract/finality rows `FOR SHARE`, sorted. Read `t` after the final blocking lock. This follows §13.3's child-row and registry order.

**Phase B, checks (reads only):**

1. Authorization is `ISSUED` and `t < expires_at`. Otherwise mark it `EXPIRED` and return.
2. Require authorization owner/group/intent/type, quote ID/digest, consumed challenge ID/status/digest, and adapter ID/version/digest to equal the current locked rows and intent pointers. No snapshot may be rebound.
3. Re-lock the exact policy row; it must still be unretired and match the stored policy version, environment, operation type and adapter contract. For an order, quote is unexpired and variant unchanged. The snapshotted adapter remains sealed, dispatch-approved and digest-valid. If the policy was retired, refuse; never substitute the current policy.
4. G-1 to G-3, evaluated again. This evaluation is the authoritative one.

**Phase C, outcome:**

5. Refused: authorization to `REFUSED`; one refusal audit row.
6. Eligible: inside a subtransaction (a block with an exception handler):
   - insert the operation: `DISPATCHING`, fencing version 1, lease, call deadline, scheduling, purchase group, pinned adapter and version, database-computed payload digest;
   - insert its claim row with the hash of a new random secret;
   - authorization to `CONSUMED`;
   - apply `ORDER_CREATE_DISPATCHED` or `CAPTURE_DISPATCHED` with actor `operation_worker`; transition; audit;
   - `SET CONSTRAINTS ALL IMMEDIATE`.
7. If the subtransaction raises a unique, foreign-key, check or restriction violation: its effects are undone and the outer transaction remains usable. Write one audit row `DISPATCH_REFUSED_CONSTRAINT`, mark the authorization `REFUSED`, and return a refusal. This is a safety net; it indicates a defect.
8. On success return the claim secret.

Deadlocks and lock timeouts are not caught; the transaction rolls back and may be retried. If the claim commit outcome is uncertain and the secret was not received, send nothing and let recovery read back; never retrieve or regenerate that claim secret. If a secret was received, the continuation must first acquire the process-local one-shot dispatch guard for this operation and fencing version (§12.1a), synchronously and before any further asynchronous step; only the continuation that acquires it may go on, and `confirm_claim` must then verify that exact secret as current before the deadline before any request. A continuation that does not acquire the guard sends nothing.

### 8.3 Which intents a dispatch locks

After the owner row `FOR UPDATE`: this intent, and every intent of the owner that has a payment operation, `FOR UPDATE` in ascending ID. Every dispatch/authorization/claim for that owner takes the same owner lock; this serializes first operations even when two different intents in the same purchase group have no operation yet. All writers of observations, review entries and operation outcomes hold their intent's lock, and an intent gains its first operation only under the owner row, so the facts read for G-1 to G-3 cannot change while these locks are held. Recovery takeover touches only non-final operations, which already fail E-1.

### 8.4 `claim_for_recovery` (worker)

Locks operations only. Selects operations in the four recoverable states with `parked_at IS NULL`, `next_recovery_at <= now`, no live lease, and a pinned contract the caller supports, `FOR UPDATE SKIP LOCKED`, small batch. After locking, reads `t` and re-checks. For each: `DISPATCHING` becomes `UNKNOWN`, others keep their state; new lease and schedule; fencing version plus one; a new claim row of kind `TAKEOVER`. Returns each operation with its new secret.

Skip-locked distributes work only. Nothing is decided from that read.

### 8.5 `ingest_operation_evidence` (worker)

Arguments: operation ID; claim secret; kind (`RESPONSE`, `READBACK_FOUND`, `NOT_FOUND`, `NO_RESPONSE`, `UNAVAILABLE`); raw evidence fields; the worker's adapter ID, version and digest; new IDs. **No role, conflict or reconciliation value is accepted.**

1. Read the operation's intent (immutable, unlocked). For an order-create that may be resent, lock the variant `FOR SHARE`. Lock the intent `FOR UPDATE`, then the operation `FOR UPDATE`. Read `t`.
2. Claim check: SHA-256 of the secret equals the verifier of the claim row at the operation's current fencing version; state is `DISPATCHING`, `UNKNOWN` or `PENDING_PROVIDER`. Otherwise nothing is written here.
3. Contract check: adapter ID and version equal the pinned ones; digest equals the registered one.
4. If the checkout is still in flight after a takeover, first apply the outcome-unknown event with actor `reconciler`.
5. Validate and reconcile (§9), then write exactly what the disposition requires:

| Kind and finding | Disposition | Writes |
| --- | --- | --- |
| Object evidence, valid, reconciliation compatible, reducer accepts | APPLY | Observation `AUTHORITATIVE`; operation outcome; when the outcome is final, `quarantine_reconciled_seq`; checkout; transition; audit |
| Evidence restates what is recorded (§9.6) | NO-CHANGE | Lease released, rescheduled, `last_readback_at`. No observation, state or transition |
| Evidence invalid, or reconciliation not compatible, and the reducer can move to `MANUAL_REVIEW` | REVIEW | Observation `CONFLICTING`; operation `CONFLICT`, parked; checkout `MANUAL_REVIEW`; transition; review entries; audit |
| Reducer rejects, not a harmless duplicate, no legal move | INCOHERENT | Observation `CONFLICTING`; operation `CONFLICT`, parked; review entry `SETTLEMENT_INCOHERENT`; audit. Checkout unchanged |
| `NO_RESPONSE` | — | Operation `UNKNOWN`, scheduled now; checkout to the matching unknown state; transition; audit. No observation |
| `NOT_FOUND`, operation was `UNKNOWN`, resend permitted (§12.4) | — | Observation `AUTHORITATIVE`; operation `DISPATCHING`, attempt and fencing plus one, new claim row of kind `RESEND`; checkout redispatched citing the observation; transition; audit. Returns a new secret |
| `NOT_FOUND`, resend prohibited | — | Observation `AUTHORITATIVE`; operation stays `UNKNOWN`, parked; `ESCALATED_TO_MANUAL_REVIEW` citing the observation; review entries; audit |
| `NOT_FOUND`, operation was `PENDING_PROVIDER` | REVIEW | As REVIEW, through `ESCALATED_TO_MANUAL_REVIEW` |
| `UNAVAILABLE` | — | Lease released; rescheduled by backoff; `READBACK_INCONCLUSIVE` where the reducer allows, or escalation and parking past the escalation age. No observation |

An operation becomes `SUCCEEDED`, `DECLINED`, `REJECTED` or `PENDING_PROVIDER` only under APPLY. CT-1 (§2.13) refuses any commit that leaves such an operation without its evidence and history.

### 8.6 Evidence classes and their authority (I-10b)

| Class | Events | Authority | Operation rows |
| --- | --- | --- | --- |
| 1 Operation outcome | The order-create and capture outcome events, redispatch, outcome-unknown, mismatch while settling, inconclusive, escalation during recovery | Intent lock and current claim secret (`ingest_operation_evidence`) | Updated |
| 2 Approval readback | `APPROVAL_VERIFIED`, `APPROVAL_NOT_FOUND`, `ORDER_DETAILS_MISMATCH`, `EXPIRED` from the three approval states | Intent lock; the order-create operation is `SUCCEEDED`; evidence names the recorded order (`ingest_approval_evidence`) | Not modified |
| 3 Post-capture | `REFUND_OBSERVED`, `REVERSAL_OR_DISPUTE_OBSERVED` | Intent lock; the capture operation is `SUCCEEDED`; evidence passes capture validation (`ingest_post_capture_evidence`) | Not modified |

### 8.7 `ingest_approval_evidence` (worker)

Lock the intent `FOR UPDATE`; read `t`; require the order-create operation `SUCCEEDED`; validate and reconcile.

| Evidence | Disposition |
| --- | --- |
| Approved, details match | APPLY `APPROVAL_VERIFIED` |
| Not yet approved, state `APPROVAL_CHECK_PENDING` | APPLY `APPROVAL_NOT_FOUND` |
| Not yet approved, state `AWAITING_APPROVAL` | NO-CHANGE |
| Details do not match, or order not found | REVIEW through `ORDER_DETAILS_MISMATCH` (reason `ORDER_MISSING` when not found). The operation is final and is not changed |
| Provider reports the order expired | APPLY `EXPIRED` |
| Provider unavailable | NO-CHANGE; nothing observed |

### 8.8 `ingest_post_capture_evidence` (worker)

Lock the intent `FOR UPDATE`; read `t`; require the capture operation `SUCCEEDED`; validate; plan refund rows (§9.9).

| Plan | Writes |
| --- | --- |
| New refund rows, checkout `CAPTURED_VERIFIED` or `PARTIALLY_REFUNDED_OBSERVED` | Observation; refund rows; `REFUND_OBSERVED` (full if the new total equals the captured amount); transition; audit |
| New refund rows, checkout `REFUNDED_OBSERVED` or `REVERSED_OR_DISPUTED_OBSERVED` | Observation; refund rows; review entry `REFUND_AFTER_FINAL_STATE`; audit. No transition |
| Reversal or dispute newly reported | Observation; `REVERSAL_OR_DISPUTE_OBSERVED`; transition; audit |
| Nothing new | NO-CHANGE |
| Fails validation, or refund plan conflicts | Observation `CONFLICTING`; review entry `POST_CAPTURE_CONFLICT`; audit. **No state change** |

The reducer has no transition from a paid state to an unpaid or review state, and none is added. Contradictory evidence after capture stays visible through the review queue.

### 8.9 `ingest_quarantined_evidence` (worker)

For evidence held by a worker whose claim was superseded.

1. Lock the intent `FOR UPDATE`. The operation is read, never locked or changed. Read `t`.
2. The presented secret must match a claim row for the operation with a fencing version **lower** than the current one. Otherwise nothing is stored.
3. Attribution: parseable, recognised status, request ID equal to the operation's. Otherwise invalid: nothing stored but an audit row.
4. **Deduplicate first:** if any observation of the operation has the same fingerprint, stop.
5. Refuse past the per-operation quarantine cap (*20, proposal*, OPEN D-13).
6. Validate and reconcile against every existing observation of the operation and subject. Store the observation as `QUARANTINED` with the database-computed outcome.
7. Open a review entry when required (§9.7). Audit.

It never changes an operation, a checkout, a version or a transition.

### 8.10 `acknowledge_risk`, `cancel_checkout`, `record_buyer_return`, `expire_checkout`, `confirm_claim`

- `acknowledge_risk`: §11.4.
- `cancel_checkout` (web): session authority; intent `FOR UPDATE`; apply `SHOPPER_CANCELED`. The reducer refuses it once a capture may have been dispatched **[APPROVED-M1]**.
- `record_buyer_return` (web): session authority; intent `FOR UPDATE`; apply `BUYER_RETURNED`. A redirect proves nothing; it only requests a check.
- `expire_checkout` (worker): intent `FOR UPDATE`; read `t`; from `QUOTED` or `USER_CONFIRMED` when `t` is at or after the quote's expiry, or from `DRAFT` when `t` is at or after the draft's expiry boundary; apply `EXPIRED` with actor `timer` (D-50; pre-payment states only).
  - **Draft expiry (owner-approved policy for the local MVP): 24 hours from original draft creation.**
  - **Starting point.** The intent's `created_at` (§2.9): database time at insert, immutable. The clock is **not reset** when an intent returns to `DRAFT` through `QUOTE_INVALIDATED`, or by any other event. An intent that returns to `DRAFT` after its boundary is expired at once.
  - **Boundary rule (strict).** `boundary = created_at + 24 hours`. The draft is live only while `t < boundary`. At `t = boundary` and after, it is expired.
  - **Time source.** `t` is the decision timestamp of §13.2: database `clock_timestamp()` read after the last blocking lock, here the intent lock. No application clock, request field or session setting takes part.
  - **Refusal before the worker runs (owner-approved).** When `t >= boundary`, `start_checkout` refuses to re-quote or otherwise advance that draft, even though the stored state still reads `DRAFT` because `expire_checkout` has not yet run. It changes no state and creates no quote or challenge. Applying `EXPIRED` remains the worker's event (§10.2); the web role raises no expiry event.
  - **After expiry.** An expired draft cannot be re-quoted, confirmed or moved into checkout by any entry point; the reducer has no transition out of `EXPIRED` **[APPROVED-M1]**.
  - **Nothing else is touched.** A `DRAFT` intent has no payment operation. The draft rule never applies to an intent in any other state, however old, and it deletes or alters no intent, operation, evidence, review entry, transition or audit row. An expired draft stays stored. Unresolved obligations elsewhere in its purchase group are unaffected and the group's standing follows §6.6.
  - **Concurrency.** `expire_checkout` and `start_checkout` both lock the intent `FOR UPDATE` and read `t` afterwards, so they are serialized and each decides on the committed state it then sees. Before the boundary a re-quote wins or loses the lock but is permitted either way. At or after the boundary the re-quote is refused in either order, and the draft ends `EXPIRED` with exactly one transition.
  - **Still subject to exact-schema approval:** the column definition of `created_at`, how the 24-hour value is held, and the name of the refusal result.
- `confirm_claim` (worker, read-only): given an operation ID and claim secret, reports whether that claim is current, the operation is `DISPATCHING`, and `t` is before the call deadline.

---

## 9. Evidence validation, reconciliation, quarantine and refund observation

All of this runs inside the database. The worker supplies raw evidence fields only.

### 9.1 Never stored

Provider credentials, access tokens, raw request or response bodies, payer personal data, session tokens, confirmation nonces, claim secrets, CSRF tokens, shopper free text.

### 9.2 Validation order

1. **Attribution:** parseable; recognised status; request ID equal to the operation's stable request ID.
2. **Shape:** the mandatory fields for the subject and status (§9.3).
3. **Internal consistency:** for example, refunded amount not above captured amount.
4. **Match:** order ID equals the recorded provider order; amount, currency and merchant equal the immutable quote's; capture ID unchanged if one is recorded.

The result of steps 2 to 4 is the `conflict` value, NULL when all pass.

| Failure | From the current claimant | From a superseded claim |
| --- | --- | --- |
| Step 1 | Nothing stored; audit only | Nothing stored; audit only |
| Steps 2 to 4 | REVIEW: observation `CONFLICTING` | Stored `QUARANTINED` with the conflict value |

Provider-supplied text is sanitized before insert: reason codes are upper-cased, restricted to `A-Z 0-9 _ . : -` and cut to 64 characters; unrecognised statuses become `UNRECOGNIZED`.

### 9.3 Mandatory fields and object presence

| Kind | Statuses | Mandatory |
| --- | --- | --- |
| **Object-bearing** order | `CREATED`, `APPROVED`, `COMPLETED` | Order ID, amount, currency |
| **Object-bearing** capture | `COMPLETED`, `PENDING`, `DECLINED` | Capture ID, order ID, amount, currency |
| **Object-absent** | `NOT_FOUND`, `REJECTED` | None beyond attribution |

- An observation is classified by its status, never by whether an identifier is present.
- A mandatory field that is missing makes the observation **incomplete** (`conflict = EVIDENCE_INCOMPLETE`). Missing is never treated as equal to anything.
- A field that is not applicable for a status compares equal to another not-applicable value.

### 9.4 Reconciliation, stage 1: relation between two observations

Same operation and subject. First match wins.

| # | Relation | When |
| --- | --- | --- |
| 1 | INCOMPLETE | Either observation is incomplete |
| 2 | SAME_FACTS | Both object-absent with the same status |
| 3 | ORDERED (not found before `REJECTED`) | Both object-absent, one of each, and the contract declares "not found" as a start. Otherwise UNORDERED |
| 4 | ORDERED (not found before the object's status) | Exactly one is not found, the other object-bearing, and the contract declares "not found" as a start. Otherwise UNORDERED |
| 5 | BRANCH_CONFLICT | Exactly one is `REJECTED` and the other is object-bearing |
| 6 | DIFFERENT_OBJECT | Both object-bearing; identifiers differ |
| 7 | SAME_FACTS | Both object-bearing; same object; all material fields equal |
| 8 | IMMUTABLE_CONFLICT | Same object; an immutable field or the validation result differs |
| 9 | ORDERED (x before y) | Same object; immutable fields equal; `y`'s status strictly ahead of `x`'s in the contract's order |
| 10 | BRANCH_CONFLICT | Same object; statuses differ; neither is ahead |
| 11 | UNORDERED | Statuses differ and the contract declares no status order |

Material fields: provider, operation, object identifiers, status, amount, currency, validation result. `reason_code` is not material. Provider timestamps are never used.

A "not found" reports only that no object was shown at that reading. It never establishes that an object observed elsewhere did not exist, and never produces DIFFERENT_OBJECT.

### 9.5 Reconciliation, stage 2: outcome by role

"Non-quarantined" means `AUTHORITATIVE` or `CONFLICTING`.

| Relation | Non-quarantined `a` with quarantined `q` | Quarantined with quarantined |
| --- | --- | --- |
| SAME_FACTS | IDENTICAL | IDENTICAL |
| ORDERED, `q` before `a` | COMPATIBLE | — |
| ORDERED, `a` before `q` | UNPROVABLE | — |
| ORDERED, either direction | — | COMPATIBLE |
| BRANCH_CONFLICT, IMMUTABLE_CONFLICT | CONTRADICTORY | CONTRADICTORY |
| DIFFERENT_OBJECT | DIFFERENT_OBJECT | DIFFERENT_OBJECT |
| UNORDERED, INCOMPLETE | UNPROVABLE | UNPROVABLE |

Worst-outcome order: DIFFERENT_OBJECT, CONTRADICTORY, UNPROVABLE, COMPATIBLE, IDENTICAL.

### 9.6 Settlement planning

Before any write in `ingest_operation_evidence`, the claimant's evidence is reconciled with every `QUARANTINED` observation of the operation. The intent lock is held, so the set cannot change.

- Worst outcome IDENTICAL or COMPATIBLE, or no quarantined evidence: normal planning.
- Otherwise: REVIEW, whatever the evidence alone would imply.

**Evidence that requires a transition**

| Evidence (valid) | Checkout state | Event |
| --- | --- | --- |
| Order created, details match | In flight, unknown, or reconciliation required (order phase) | `ORDER_CREATED` |
| Order created, details differ | Same | REVIEW: `ORDER_DETAILS_MISMATCH`; operation `CONFLICT`, not `SUCCEEDED` |
| Explicit rejection of order creation | In flight | `ORDER_CREATE_REJECTED` |
| Capture completed | Any capture-phase state, or reconciliation required | `CAPTURE_COMPLETED` |
| Capture pending | In flight, unknown, reconciliation required | `CAPTURE_PENDING` |
| Capture declined or explicitly rejected | Any capture-phase state, or reconciliation required | `CAPTURE_DECLINED` |
| Capture evidence fails validation, any status | Any capture-phase state | REVIEW: `CAPTURE_EVIDENCE_MISMATCH` |

**Harmless duplicates (the complete list):** capture still pending with the same facts while `CAPTURE_PENDING_PROVIDER`; order still not approved while `AWAITING_APPROVAL`; no new refund or dispute in a paid state. Anything else the reducer rejects is REVIEW or INCOHERENT, never ignored.

### 9.7 Quarantined evidence and when a review entry is required

On arrival, the evidence is reconciled with every existing observation of the operation and subject.

| Worst outcome | Operation scheduled | Operation final or parked |
| --- | --- | --- |
| None, IDENTICAL, COMPATIBLE | Not required | Not required |
| UNPROVABLE | Not required: the next settlement must reconcile it and cannot apply past it | **Required** |
| CONTRADICTORY, DIFFERENT_OBJECT | **Required** | **Required** |

By time of arrival:

| Arrives | Result |
| --- | --- |
| Before the claimant settles | Quarantined. The settlement finds it; if not compatible, one commit writes the REVIEW set |
| After a non-final settlement | Quarantined; entry if required now. The next authorized settlement reconciles it |
| After the operation is final | Quarantined with the required entry. Operation, checkout, version and transitions unchanged |
| After the checkout is paid or terminal | Same. A paid state is never downgraded |

In every case the superseded claim changes no operation or checkout.

### 9.8 Review and parking reasons

| Reason | Meaning | Written by |
| --- | --- | --- |
| `RESEND_PROHIBITED` | Evidence not in doubt; policy forbids resending (resend conditions 1 to 5) | Operation ingestion |
| `EVIDENCE_ORDER_UNPROVABLE` | Outcome UNPROVABLE | Operation ingestion; quarantine |
| `QUARANTINED_EVIDENCE_CONTRADICTS` | Outcome CONTRADICTORY, found while settling | Operation ingestion |
| `STALE_EVIDENCE_CONTRADICTS_OUTCOME` | Outcome CONTRADICTORY, found when stale evidence arrives | Quarantine |
| `DUPLICATE_PROVIDER_OBJECT_SUSPECTED` | Outcome DIFFERENT_OBJECT | Either |
| `SETTLEMENT_INCOHERENT` | INCOHERENT disposition | Operation ingestion |
| `POST_CAPTURE_CONFLICT` | Evidence after capture fails validation or refund planning | Post-capture ingestion |
| `REFUND_AFTER_FINAL_STATE` | New refund evidence where the reducer has no transition | Post-capture ingestion |
| `REFUND_IDENTITY_UNAVAILABLE` | Refund evidence with neither identifier nor total | Post-capture ingestion |
| `ORDER_MISSING` (conflict value) | Approval readback found no order | Approval ingestion |

No dispatch rule reads these strings. Eligibility is computed from states, evidence roles, outcomes and the existence of any entry.

### 9.9 Refund evidence

Performed in `ingest_post_capture_evidence`. `R` is the total already recorded; `A` the captured amount. The plan is computed in full before any write.

**Refund extent is derived by the database.** The reducer's `REFUND_OBSERVED` event carries an `extent` of `PARTIAL` or `FULL` **[APPROVED-M1]**. In PostgreSQL mode no caller supplies it. The ingestion function has no extent argument; after planning the ledger rows it sets `FULL` exactly when the resulting ledger total equals `A`, and `PARTIAL` otherwise, and passes that to the reducer mirror. A worker payload cannot assert a full or partial refund, and evidence without a usable amount adds nothing to the verified total (D-23).

- **Evidence lists refunds with identifiers:** each identifier not yet recorded becomes a row. An identifier already recorded with a different amount is a conflict. A reported total that does not equal the resulting sum is a conflict.
- **Only a cumulative total `C`:** `C = R`, nothing new; `C > R`, one row of `C − R` with basis `CUMULATIVE_DELTA`; `C < R`, conflict. Two equal refunds seen in separate readbacks are two rows. If both occur between two readbacks they appear as one row of the combined amount: amounts are right, the count is unknown.
- **Neither identifier nor total:** no row; observation stored; review entry `REFUND_IDENTITY_UNAVAILABLE` (OPEN D-23).
- **Always a conflict:** a total above `A`; more than the maximum refund entries in one piece of evidence (*50, proposal*, OPEN D-25); a change of identity basis.

`refund_facts_digest` is SHA-256 of the canonical array of `(provider_refund_id, refund_amount_cents, currency)` sorted by identifier, amount, currency; NULL when no identifiers are available.

What a real provider supplies is not assumed (§16).

### 9.10 Observation fingerprint and deduplication

Fingerprint: SHA-256 of the canonical encoding of provider, source, subject, operation ID, both provider IDs, status, reason code, conflict, reported amount, currency, cumulative refunded amount, refund count, refund-facts digest, reversal flag. No timestamps, role or fencing version.

| Path | Rule |
| --- | --- |
| Operation, approval and post-capture ingestion | Compare with the **newest** observation for the same operation, subject and source. Same fingerprint: reuse it. Different: insert with the next `observation_seq` |
| Quarantine | Compare with **any** observation of the operation. Same fingerprint: store nothing, before any other comparison |

Comparing authoritative evidence only with the newest row means a provider that returns to an earlier status is recorded, not hidden.

### 9.11 Audit

Sanitizer rules **[APPROVED-M1: `src/lib/security/audit.ts`]** are kept and applied in the database: at most 24 detail keys, scalar values only, strings cut to 256 characters, sensitive key names and token-like values redacted, 8192-byte cap. Audit rows for state changes are written in the same transaction as the change. Event types are a closed list per writer.

---

## 10. State-machine transition rules and TypeScript parity

### 10.1 Reducer mirror

- `checkout_transition_rules` is generated from the TypeScript transition table and loaded by migration.
- The internal function `apply_checkout_event(entry_point, …)`:
  1. requires a row in `entry_point_event_allowlist` for the entry point, event and actor;
  2. requires a row in `checkout_transition_rules` for the current state, event and actor;
  3. evaluates the rule's guard;
  4. computes the next context exactly as the reducer does;
  5. updates the checkout (state, all context columns, `row_version + 1`) guarded by the expected version;
  6. inserts the transition row, recording the entry point.
- No application or operator role can execute it.
- The intent is always locked first, so the version guard cannot fail through concurrency. Zero rows updated is an invariant violation: roll back and alert, do not retry.

### 10.2 Entry-point event allowlist

Every event that changes state writes the checkout row, one transition row and one audit row. "Stoppable" means `DRAFT`, `QUOTED`, `USER_CONFIRMED`, `AWAITING_APPROVAL`, `APPROVAL_CHECK_PENDING`, `APPROVED_VERIFIED`, `DECLINED_RETRYABLE` **[APPROVED-M1]**.

| Entry point | Role | Event | Actor | Source states | Entry-point guard | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `start_checkout` | web | `QUOTE_ISSUED` | `server` | new (Increment 2); `DRAFT`, `QUOTED` in a later increment | Session authority; variant priced from one catalog snapshot (§19.4) | `QUOTED`; quote pointer set; confirmation pointer cleared |
| `start_checkout` | web | `SUPERSEDED` | `server` | Stoppable, on the replaced intent | Same owner and group | `SUPERSEDED` |
| `consume_challenge` | web | `SHOPPER_CONFIRMED` | `shopper` | `QUOTED` | §5.6 | `USER_CONFIRMED`; confirmation pointer set |
| `authorize_dispatch`, `claim_authorized_dispatch` | web, worker | `QUOTE_INVALIDATED` | `server` | `USER_CONFIRMED` | Quote expired or variant changed at `t` | `DRAFT`; pointers cleared |
| `claim_authorized_dispatch` | worker | `ORDER_CREATE_DISPATCHED` | `operation_worker` | `USER_CONFIRMED` | §8.2 | `ORDER_CREATE_IN_FLIGHT`; order pointer set |
| `claim_authorized_dispatch` | worker | `CAPTURE_DISPATCHED` | `operation_worker` | `APPROVED_VERIFIED` | §8.2 | `CAPTURE_IN_FLIGHT`; capture pointer set; `capture_dispatched` |
| `record_buyer_return` | web | `BUYER_RETURNED` | `browser_redirect` | `AWAITING_APPROVAL`, `DECLINED_RETRYABLE` | Session authority | `APPROVAL_CHECK_PENDING` |
| `cancel_checkout` | web | `SHOPPER_CANCELED` | `shopper` | Stoppable | Session authority | `CANCELED_LOCAL` |
| `expire_checkout` | worker | `EXPIRED` | `timer` | `DRAFT`, `QUOTED`, `USER_CONFIRMED` | §8.10 | `EXPIRED` |
| `ingest_operation_evidence` | worker | `ORDER_CREATED` | `provider_response`, `provider_readback` | `ORDER_CREATE_IN_FLIGHT`; `ORDER_CREATE_UNKNOWN`, `RECONCILIATION_REQUIRED` | Claim; valid; compatible | `AWAITING_APPROVAL`; provider order ID set |
| same | worker | `ORDER_CREATE_REJECTED` | `provider_response` | `ORDER_CREATE_IN_FLIGHT` | Claim | `FAILED_TERMINAL` |
| same | worker | `ORDER_CREATE_OUTCOME_UNKNOWN` | `operation_worker`, `reconciler` | `ORDER_CREATE_IN_FLIGHT` | Claim; no response or takeover | `ORDER_CREATE_UNKNOWN` |
| same | worker | `ORDER_CREATE_REDISPATCHED` | `operation_worker` | `ORDER_CREATE_UNKNOWN`, `RECONCILIATION_REQUIRED` | Claim; resend conditions | `ORDER_CREATE_IN_FLIGHT` |
| same | worker | `ORDER_DETAILS_MISMATCH` | `provider_response`, `provider_readback` | `ORDER_CREATE_IN_FLIGHT`, `ORDER_CREATE_UNKNOWN`, `RECONCILIATION_REQUIRED` | Claim; invalid or not compatible | `MANUAL_REVIEW` |
| same | worker | `CAPTURE_COMPLETED` | same | `CAPTURE_IN_FLIGHT`, `CAPTURE_UNKNOWN`, `RECONCILIATION_REQUIRED`, `CAPTURE_PENDING_PROVIDER` | Claim; valid; compatible | `CAPTURED_VERIFIED`; capture ID set |
| same | worker | `CAPTURE_PENDING` | same | `CAPTURE_IN_FLIGHT`, `CAPTURE_UNKNOWN`, `RECONCILIATION_REQUIRED` | Same | `CAPTURE_PENDING_PROVIDER` |
| same | worker | `CAPTURE_DECLINED` | same | The four above | Same | `DECLINED_RETRYABLE`; capture pointer cleared |
| same | worker | `CAPTURE_OUTCOME_UNKNOWN` | `operation_worker`, `reconciler` | `CAPTURE_IN_FLIGHT` | Claim | `CAPTURE_UNKNOWN` |
| same | worker | `CAPTURE_EVIDENCE_MISMATCH` | `provider_response`, `provider_readback` | Capture-phase states; `RECONCILIATION_REQUIRED` | Claim; invalid or not compatible | `MANUAL_REVIEW` |
| same | worker | `READBACK_INCONCLUSIVE` | `reconciler` | `ORDER_CREATE_UNKNOWN`, `CAPTURE_UNKNOWN` | Claim; unavailable; under escalation age | `RECONCILIATION_REQUIRED` |
| same | worker | `ESCALATED_TO_MANUAL_REVIEW` | `reconciler` | The two unknown states, `RECONCILIATION_REQUIRED`, `CAPTURE_PENDING_PROVIDER` | Claim; over escalation age, resend prohibited, or pending capture not found | `MANUAL_REVIEW` |
| `ingest_approval_evidence` | worker | `APPROVAL_VERIFIED` | `provider_readback` | `AWAITING_APPROVAL`, `APPROVAL_CHECK_PENDING` | §8.7 | `APPROVED_VERIFIED` |
| same | worker | `APPROVAL_NOT_FOUND` | `provider_readback` | `APPROVAL_CHECK_PENDING` | §8.7 | `AWAITING_APPROVAL` |
| same | worker | `ORDER_DETAILS_MISMATCH` | `provider_readback` | `AWAITING_APPROVAL`, `APPROVAL_CHECK_PENDING`, `APPROVED_VERIFIED` | §8.7 | `MANUAL_REVIEW` |
| same | worker | `EXPIRED` | `provider_readback` | Same three | §8.7 | `EXPIRED` |
| `ingest_post_capture_evidence` | worker | `REFUND_OBSERVED` | `provider_readback`, `provider_observation` | `CAPTURED_VERIFIED`, `PARTIALLY_REFUNDED_OBSERVED` | §8.8 | Partially or fully refunded |
| same | worker | `REVERSAL_OR_DISPUTE_OBSERVED` | same | First three paid states | §8.8 | `REVERSED_OR_DISPUTED_OBSERVED` |

Raise no event: the four session functions, `issue_challenge`, `acknowledge_risk`, `claim_for_recovery`, `confirm_claim`, `ingest_quarantined_evidence`, `register_contract`, the audit functions, the operator functions.

`CAPTURE_REDISPATCHED` exists in the reducer and has **no** allowlist row: automatic capture resend is disabled.

**Reducer rule with no PostgreSQL entry point.** The reducer accepts `ESCALATED_TO_MANUAL_REVIEW` by `reconciler` from five states, including `APPROVAL_CHECK_PENDING` **[APPROVED-M1: `src/lib/payment/state-machine.ts`]**. `checkout_transition_rules` mirrors all five for parity. The allowlist above pairs the event only with `ingest_operation_evidence`, which acts on a claimed non-final operation, so in PostgreSQL mode it is raised from the two unknown states, `RECONCILIATION_REQUIRED` and `CAPTURE_PENDING_PROVIDER`; nothing raises it from `APPROVAL_CHECK_PENDING`. No behaviour is added or removed by this note, the reducer is unchanged, and Mock mode is unaffected. A checkout waiting on approval in PostgreSQL mode leaves that state through `ingest_approval_evidence` or expiry only.

### 10.3 Citation rules

| Transition actor | `observation_id` | `operation_id` |
| --- | --- | --- |
| The three provider actors | Required; same intent; not quarantined | **Required** |
| `operation_worker` | Required for redispatch (the readback that found nothing) | **Required** |
| `reconciler` | Optional; if present, citable | **Required** |
| `shopper`, `server`, `timer`, `browser_redirect` | NULL | **NULL** |

The `operation_id` column of this table is enforced by the actor CHECK of §2.18. By event:

| Operation reference | Events | Which operation |
| --- | --- | --- |
| Required | `ORDER_CREATE_DISPATCHED`, `ORDER_CREATED`, `ORDER_CREATE_REJECTED`, `ORDER_CREATE_OUTCOME_UNKNOWN`, `ORDER_CREATE_REDISPATCHED` | The order-create operation |
| Required | `APPROVAL_VERIFIED`, `APPROVAL_NOT_FOUND`, `EXPIRED` raised by `provider_readback` | The intent's order-create operation, whose order was read back |
| Required | `ORDER_DETAILS_MISMATCH` | The order-create operation (either ingestion path) |
| Required | `CAPTURE_DISPATCHED`, `CAPTURE_COMPLETED`, `CAPTURE_PENDING`, `CAPTURE_DECLINED`, `CAPTURE_OUTCOME_UNKNOWN`, `CAPTURE_EVIDENCE_MISMATCH` | The capture operation |
| Required | `READBACK_INCONCLUSIVE`, `ESCALATED_TO_MANUAL_REVIEW` | The claimed operation being recovered |
| Required | `REFUND_OBSERVED`, `REVERSAL_OR_DISPUTE_OBSERVED` | The `SUCCEEDED` capture operation |
| Required | `CAPTURE_REDISPATCHED` | No entry point raises it (§10.2). If one ever did, the CHECK would require the capture operation |
| Must be NULL | `QUOTE_ISSUED`, `SUPERSEDED`, `SHOPPER_CONFIRMED`, `QUOTE_INVALIDATED`, `BUYER_RETURNED`, `SHOPPER_CANCELED`, `EXPIRED` raised by `timer` | None; no payment operation is involved |

`EXPIRED` is the one event type on both sides, which is why the rule is keyed on the actor and not on the event type alone. The 26 event types are all listed. That the cited operation has the *type* shown in the third column is enforced in the table by F-10T, the authoritative typed replacement for F-10, together with the event-type CHECK of §2.18 (D-28; exact definitions unapproved), as well as by the entry-point functions and V-25.

### 10.4 Version rules

- An intent is created at version 1 in `DRAFT`; created already quoted, it is stored at version 2 with one transition row.
- Every accepted event raises the version by exactly one and writes exactly one transition row.
- Nothing else changes `row_version`.

### 10.5 Parity with the TypeScript reducer

| Check | Compares |
| --- | --- |
| Rule parity | The generated rule table with the reducer, for every state, event type and actor |
| Result parity | For every reachable snapshot and event: next state, version and all seven context fields |
| Flow parity | For each end-to-end scenario run in mock mode and PostgreSQL mode: the sequence of transition records and audit event types |
| Allowlist parity | What each entry point can raise equals §10.2 |

Parity is a planned test. It has not been run, and the two implementations do not yet both exist.

---

## 11. Buyer risk acknowledgments and canonical fingerprints

### 11.1 Fingerprint content

For acknowledged group `G`, five collections in this order:

| # | Collection | Fields, in order | Sort key |
| --- | --- | --- | --- |
| 1 | Member intents with a payment operation | intent ID; `row_version` | intent ID |
| 2 | Capture operations | operation ID; outcome class; `provider_reference`; `parked_reason`; `quarantine_reconciled_seq` | operation ID |
| 3 | Observations of those operations | observation ID; `evidence_role`; observation fingerprint; `reconciliation_outcome` | observation ID |
| 4 | Review entries of member intents | observation ID; reason | observation ID |
| 5 | Finality, one row per capture operation | operation ID; `adapter_id`; `contract_version`; `contract_digest`; recorded outcome status; reason class; effective standing | operation ID |

- **Outcome class:** `IN_PROGRESS` for `DISPATCHING`, `UNKNOWN`, `READBACK_CLEARED`, `PENDING` when not parked; `PENDING_PROVIDER`; `PARKED`; `SUCCEEDED`; `DECLINED`; `REJECTED`; `CONFLICT`.
- **Effective standing:** `NONE` (no finality row for that contract version, status and reason class), `VERIFIED`, or `WITHDRAWN`.
- No timestamp is included.

### 11.2 Encoding `SARF-1`

| Element | Bytes |
| --- | --- |
| Header | ASCII `SARF`, then version byte `0x01` |
| Field | 1 type byte, 4-byte big-endian length, value |
| `0x00` NULL | Length 0 |
| `0x01` text | ASCII bytes. Every text field here is constrained to ASCII; the function rejects any other byte |
| `0x02` integer | Length 8, big-endian two's complement |
| `0x03` digest | Length 32, raw bytes |
| Row | `0x10`, 2-byte field count, then the fields in fixed order |
| Collection | `0x20`, 1-byte collection number, 4-byte row count, rows sorted by sort key in byte order |
| Document | Header; the group ID as a field; collections 1 to 5 |

The fingerprint is SHA-256 over those bytes, as 64 hex characters. It is computed only by the internal database function.

Every element is self-delimiting and order is fixed, so the bytes parse in exactly one way: equal bytes imply equal content. NULL and empty text differ by type byte. Beyond that the guarantee is SHA-256's collision resistance.

### 11.3 Properties

- **Stable under the locks.** Everything in the fingerprint changes only under an intent lock or a registry lock held by the reader, except recovery takeover, which changes only lease, fencing, scheduling and states inside the `IN_PROGRESS` class, none of which is included.
- **Any material change invalidates.** A new observation, review entry, transition, outcome class or finality standing changes it.
- **Never returns to an earlier value.** Evidence tables are append-only, `row_version` only increases, and standing moves only `NONE`, `VERIFIED`, `WITHDRAWN`. Suite retirement is one of the ways a row becomes `WITHDRAWN` (§7.7); it changes the fingerprint and so invalidates earlier acknowledgments.

Required sequence: decline with unverified finality (standing `NONE`); buyer acknowledges; operator approves (`VERIFIED`); operator withdraws (`WITHDRAWN`). The stored acknowledgment has the `NONE` fingerprint and does not match the `WITHDRAWN` one, so it does not authorize a separate purchase.

### 11.4 `acknowledge_risk` (web)

Arguments: session credential; this group; the acknowledged group; the fingerprint the buyer's page displayed.

1. Locks: session `FOR SHARE`; owner row `FOR UPDATE`; every intent of the owner with a payment operation, ascending; registry rows of the relevant captures `FOR SHARE` (§13.5). Read `t`.
2. Session authority; both groups belong to the owner.
3. The acknowledged group is blocked now. Otherwise refuse `NOTHING_TO_ACKNOWLEDGE`.
4. Compute its fingerprint; require it to equal the submitted one. Otherwise refuse `ACKNOWLEDGMENT_STALE`.
5. Insert the acknowledgment and an audit row.

---

## 12. Recovery, fencing and provider-call commit boundaries

### 12.1 Commit boundary (I-20)

A database function never commits. For a dispatch:

1. The worker's transaction wrapper calls `claim_authorized_dispatch` and receives a refusal or a claim secret.
2. The wrapper issues COMMIT and waits.
3. **COMMIT confirmed, claim granted:** the worker may send the provider request, with the stable request ID, before the call deadline, **only as the holder of the one-shot dispatch guard (§12.1a)**.
4. **COMMIT returns an error:** nothing was committed. No request. The claim may be retried.
5. **COMMIT outcome uncertain:** no request. On a new connection the worker calls `confirm_claim`:
   - operation not found: the commit did not happen; retry;
   - **the single exception (D-46).** All of these must hold: the caller is the same live process that received the claim secret from the claim call and still holds it in memory; that process has not restarted and has sent nothing for this attempt; `confirm_claim`, given that exact secret, reports the claim is the operation's current claim; the operation is `DISPATCHING`; and the provider-call deadline has not passed. Then the commit is known to have happened and the continuation that holds the one-shot dispatch guard (§12.1a), acquired before `confirm_claim` was called, may send **at most one** provider request, the first and only one of this attempt;
   - anything else, or the database unreachable: do nothing; recovery handles it.
6. A worker that restarted cannot know whether it sent a request. It never uses step 5.
7. In every other case the rule is fail-closed: no secret received, secret lost, claim superseded, state not `DISPATCHING`, deadline passed, `confirm_claim` unreachable or ambiguous. The worker sends nothing, never retrieves or regenerates a secret, and leaves the operation to recovery, which reads back and, for a capture, parks it for manual review rather than resending.

The same rule applies to every entry point: a caller acts on a returned result only after its commit is confirmed. No provider request is ever made inside a transaction.

### 12.1a One-shot dispatch guard (D-46; approved as architectural policy)

Steps 3 and 5 are two paths to the same provider request. Inside one live worker process both can become runnable for the same claim: for example the COMMIT reply is treated as lost, a continuation starts `confirm_claim`, and the delayed reply then arrives. Without a guard each could send. The rule:

1. **One guard, shared.** The worker process holds a single in-memory one-shot guard. Every path in that process that can lead to a provider request goes through it: the confirmed-commit path (step 3), the uncertain-commit path (step 5), and the order-create resend path (§12.3 step 4). There is no second mechanism and no path around it.
2. **Identity.** A guard entry is keyed by the operation ID and the fencing version of the claim (the claim generation). A claim secret belongs to exactly one such pair.
3. **Acquired first, synchronously.** A continuation acquires the entry by one synchronous test-and-set, with no suspension point between the test and the set, **before** it starts anything asynchronous on the way to the provider: before `confirm_claim`, before any other database call made after the claim returned, before any timer or wait, and before the provider call itself.
4. **One winner.** Only the continuation whose test-and-set succeeded may continue toward the provider request. It still has to satisfy step 3 or every condition of step 5.
5. **Losers fail closed.** A continuation that finds the entry already taken sends nothing, calls no provider method, does not wait for or take over the winner's work, and leaves the operation to the winner or to recovery.
6. **Never reset, never evicted.** An entry is consumed for the life of the process. A consumed **capture** entry is never evicted, expired or garbage-collected while that worker process is alive (owner-approved). It is not released, cleared or re-armed after a timeout, an exception, a cancellation, an abort at the deadline, an uncertain commit, a negative or failed `confirm_claim`, or an ambiguous or missing provider result. If the winner sends nothing, nothing is sent under that claim generation; recovery handles the operation.
7. **Captures.** For a capture operation an entry may be acquired only under a claim of kind `INITIAL`. A `TAKEOVER` claim is used for readback and settlement and never for a request, and no `RESEND` claim exists for a capture (§10.2, §12.4 condition 1). So at most one capture request is ever sent for an operation, by any process.
8. **Order-create.** The approved bounded order-create resend is unchanged. Each permitted resend is a new claim of kind `RESEND` with a higher fencing version, granted only by the database under conditions 1 to 6 of §12.4 and the attempt limit. It therefore has its own guard entry and is itself limited to one request. The guard does not add attempts and does not remove them.
9. **Restart.** The guard and the claim secrets exist only in the memory of the process that received them. A restarted worker has neither, cannot reconstruct either, and never uses step 5 (step 6 above). Its only route to an operation is recovery, which for a capture reads back and never sends.
10. **Not a substitute.** The guard closes one gap: two continuations in one process. It does not replace database fencing and single-use hashed claim secrets (between processes), the coherence and state rules, the provider-call deadline, or the adapter's stable request ID and declared replay behaviour. All of those still apply. Capture resend and retry after a declined or rejected capture remain disabled.

**What this rests on, stated as assumptions and not as proof.**

- The guard is worker code. The database cannot see or enforce it. It is established only by tests against the mock adapter (PGT-82), like the deadline rule (PGT-66).
- **Worker execution model (owner-approved for the local MVP):** the worker is a single-threaded event loop. One thread of execution reaches the provider; claim secrets and guard entries are never shared with another thread or process. On that model a test-and-set with no suspension point between test and set is atomic. A worker built any other way is outside the approved policy and would need a new owner decision.
- Consumed capture entries are never evicted while the process lives (rule 6). Whether consumed order-create entries are ever evicted, and the guard's data structure, remain implementation choices: PROPOSED — OWNER APPROVAL REQUIRED. The safe default is that no entry is evicted.
- Between processes the protection is the database's: one claim secret is returned once, to one caller.

### 12.2 Claims and fencing

- A claim is acquired by `claim_authorized_dispatch` (initial), by `claim_for_recovery` (takeover), or renewed by a permitted resend. Each increments the fencing version and inserts a claim row with a new secret.
- Every other change to an operation requires the current secret.
- Lease expiry does not invalidate a claim; only a takeover does.
- A superseded secret changes nothing. It is accepted only by `ingest_quarantined_evidence`.
- Each observation written under a claim records that claim's fencing version.

### 12.3 Recovery pass

1. `claim_for_recovery` (§8.4); commit.
2. Outside any transaction: read back at the provider by stable request ID.
3. `ingest_operation_evidence` with the result; commit.
4. For a permitted order-create resend: after the commit, send the request again with the **same** request ID, then ingest its result.

Recovery keeps no schedule in memory. A restarted or different worker finds work only through the table. A recovery pass is invoked by tests directly, or by the separately started worker process, a single-threaded event loop (§12.1a), in a loop at the poll interval (*5 s, proposal*, OPEN D-22; starting script OPEN D-29). It is never started by the web server and never run inside a request's transaction.

### 12.4 Resend conditions

A resend after "not found" is permitted only if all hold at `t`, under lock:

1. the operation is an order-create (**automatic capture resend is disabled**);
2. the pinned contract declares order-create replay idempotent;
3. `t >= provider_call_deadline_at + safety margin`;
4. `attempt_count` is below the maximum (*3, proposal*, OPEN D-18);
5. the quote is unexpired and the variant unchanged;
6. the operation has no observation of any role, other than "not found", for the subject.

Failing 6 parks the operation with `EVIDENCE_ORDER_UNPROVABLE`; failing any of 1 to 5 with `RESEND_PROHIBITED`. Either way the checkout goes to `MANUAL_REVIEW` in the same commit. The reducer has no path from an unknown state back to an unpaid one, and none is added.

The worker must not start a provider call after its attempt's deadline and must abort one in progress at the deadline. The database cannot enforce that; it is tested against the mock adapter (PGT-66).

### 12.5 A late response to the original request

| What happens | Handling |
| --- | --- |
| Original applied before the readback | Readback finds it; no resend |
| Resend and original both arrive; replay idempotent | One provider object; the late response is identical or compatible evidence |
| Late response names a different object | Quarantined; `DUPLICATE_PROVIDER_OBJECT_SUSPECTED`; settlement, if still to come, is REVIEW |
| Late response reports a different outcome for the same object | Quarantined; reconciled per §9.5 to §9.7 |

### 12.6 Restart scenarios

| # | Crash point | Left behind | Recovery | Result |
| --- | --- | --- | --- | --- |
| R-1 | Inside a claim, before commit | Nothing | None | Retry |
| R-2 | After the claim commits, before the provider request | `DISPATCHING` with a lease | Takeover; readback finds nothing | Order: resend if permitted. Capture: `MANUAL_REVIEW`, parked |
| R-3 | After the provider applied the request, before ingestion | As R-2 | Readback finds it; settle | Settled once |
| R-4 | Inside ingestion | As R-2 (rolled back) | As R-3 | Nothing partial |
| R-5 | After a takeover, before its ingestion | `UNKNOWN` with a lease; checkout still in flight | Lease expires; taken over again | Allowed transient pair; resolved |
| R-6 | After a resend commits, before the resend request | `DISPATCHING`, attempt 2 | As R-2 | Same request ID throughout |
| R-7 | A worker stalls past its lease; another takes over; the first returns | Second holds the claim | First is refused; its evidence may be quarantined | Second's readback settles |
| R-8 | Capture pending across a restart | `PENDING_PROVIDER` | Polled on backoff | Completed, declined or escalated; never assumed |
| R-9 | Provider unavailable past the escalation age | Unknown | Escalated; parked | `MANUAL_REVIEW`; record preserved |
| R-10 | Inside `consume_challenge` | Challenge `ACTIVE`; checkout `QUOTED` | None | Buyer can confirm again |
| R-11 | Inside `admit_session` | Nothing, including no budget change | None | Next attempt counted afresh |
| R-12 | After `authorize_dispatch` commits, before any worker claim | Authorization `ISSUED` | Worker claims it, or it expires | No operation exists until claimed |

---

## 13. Lock ordering and concurrency requirements

### 13.1 Isolation

`READ COMMITTED`, explicit row locks, bounded retries. Every connection sets `lock_timeout`, `statement_timeout` and `idle_in_transaction_session_timeout` (D-8; all four values owner-approved for the local MVP):

| Setting | Proposed | Meaning |
| --- | --- | --- |
| `lock_timeout` | 2 seconds | Longest wait for a lock |
| `statement_timeout` | 5 seconds | Longest single statement |
| `idle_in_transaction_session_timeout` | 10 seconds | Longest a transaction may sit idle |
| Database transaction re-runs | Maximum 3 | After an eligible deadlock or lock-timeout failure: roll back, then re-run the whole database transaction with jitter, re-reading everything. A re-run never causes an additional payment-provider call |

These are database settings only. A re-run repeats database work that was rolled back; it never repeats a provider request. **None of them authorizes a payment-capture retry or resend.**

### 13.2 Decision timestamp

1. A transaction acquires all of its row locks first, in the global order.
2. It then reads `clock_timestamp()` as a separate statement. That is `t`.
3. Every expiry, liveness and eligibility decision uses `t` and the row values returned by the locking reads.
4. Timestamps the transaction writes are `t` or derived from it.
5. If a further blocking lock is taken later, `t` is read again and the decisions repeated.
6. A function that takes locks in two groups reads the time after each group and repeats its liveness checks (§19.6, §19.7).

`now()` and `CURRENT_TIMESTAMP` are not used for decisions.

### 13.3 Global lock order

1. `session_admission_guard`
2. `server_key_versions` row
3. `shopper_sessions` row
4. `merchant_variants` row (share): later-increment dispatch functions only, pending the reconciliation noted in §8.1 and §8.2. (Increment 2 functions: not taken.) Catalog rows are locked only implicitly, in key-share mode, by foreign-key checks at quote and item insert. This is the last rank (§19.4).
5. `checkout_owners` row
6. `checkout_intents` rows, ascending ID
7. per-intent child rows: confirmation challenge, dispatch authorization
8. adapter registry rows: policy rows sorted by `(environment, operation_type)`, contract rows sorted by `(adapter_id, version)`, then suite rows sorted by `(suite_id, suite_version)`, then finality rows sorted
9. `payment_operations` row
10. insert-only rows

### 13.4 Variant lookup before the intent lock

For an existing checkout the variant is known only through the intent's quote. Protocol: an unlocked preliminary read of the intent's quote pointer and that quote's item; lock in order; after locking the intent, require the quote pointer to be unchanged; otherwise roll back and restart, at most three times. Quotes are immutable, so a given quote always yields the same variant. Not used by Increment 2 functions.

### 13.5 Registry locking

- Readers lock `FOR SHARE` the policy row, then contract row, then any existing finality rows, in that order; authorization/claim also locks prior-capture registry rows sorted by identity.
- Policy writers lock policy rows in `(environment, operation_type)` order before the referenced contract row; they append/retire policy rows and audit in one transaction.
- An operator inserting or withdrawing a finality row first locks its contract row `FOR UPDATE`. A finality row that does not exist yet cannot be locked, so the contract row stands in for it.
- Registry transactions lock registry rows only and follow policy → contract → finality order whenever more than one class is touched.
- `record_finality_evidence`, `review_finality_evidence` and `approve_adapter_finality` lock the contract row `FOR UPDATE` first; evidence and review rows are insert-only and are written under that lock. Approval then locks the suite row `FOR SHARE`.
- `retire_finality_suite` locks every contract row of the suite's adapter `FOR UPDATE` in version order, then the suite row `FOR UPDATE`, then the affected finality rows. Order is always policy → contract → suite → finality.
- Dispatch, claim and acknowledgment do not lock suite rows. They hold the contract row `FOR SHARE`, and a suite's `retired_at` and any finality standing change only under that contract row `FOR UPDATE`, so what they read is stable.

### 13.6 Locks per entry point

| Entry point | Locks, in order |
| --- | --- |
| `admit_session` | Guard `FOR UPDATE`; key-version row (share); dead sessions without waiting (delete, skip locked). It never waits for a session row. Capacity then counts every remaining row (§4.5) |
| `authorize_session`, `revoke_session` | Session |
| `rotate_session` | Key-version row (share); session |
| Key activation, revocation | Guard; key rows; sessions of that version |
| `start_checkout` | See §19.7 |
| `issue_challenge`, `consume_challenge` | Increment 2.2: PROPOSED, not fixed in this specification (§19.16). Session (share); intent; challenge. No explicit catalog lock (§19.4); no key-version lock after the session lock (§19.6) |
| `authorize_dispatch` | Session (share); variant (share, order); owner `FOR UPDATE`; intents; challenge; authorization; policy row (share); contract and finality rows (share) |
| `claim_authorized_dispatch` | Variant (share, order); owner `FOR UPDATE`; intents; challenge; authorization; policy row (share); contract and finality rows (share); then the insert |
| `acknowledge_risk` | Session (share); owner; intents; registry rows (share) |
| `claim_for_recovery` | Operations only (skip locked) |
| `ingest_operation_evidence` | Variant (share, order resend only); intent; operation |
| `ingest_quarantined_evidence`, `ingest_approval_evidence`, `ingest_post_capture_evidence` | Intent |
| `cancel_checkout` | See §19.7 |
| `record_buyer_return` | Session (share); intent |
| `expire_checkout` | Intent |
| Operator adapter functions, including finality evidence and review | Registry rows (contract row first; approval then suite row, share) |
| `retire_finality_suite` (owner) | Contract rows of the adapter `FOR UPDATE`; suite row; finality rows |
| `read_checkout`, `list_owner_checkouts`, `list_blocked_purchases` | None |

### 13.7 Deadlock analysis

| Potential cycle | Why it should not form |
| --- | --- |
| Dispatch or ingestion (intent then operation) against recovery takeover | Takeover locks operations only, waits for nothing, and commits first |
| Two ingestions for one intent | Both take the intent first |
| Dispatch against a single-intent transaction | Single-intent transactions never wait for the owner row or a second intent |
| Two intents in one transaction | Always ascending ID |
| Session cleanup against checkout or confirmation | Cleanup runs under the guard and skips locked sessions |
| Admission against a session touch or rotation | Admission never waits for a session row and never counts a locked row as expired, so there is neither a wait cycle nor an undercount (§18.12, correction 1) |
| Share-to-exclusive upgrade on a session | Forbidden: a transaction holding a session in share mode never updates it |
| Registry changes against dispatch or acknowledgment | Registry writers use policy → contract → finality order; readers use the same order, and registry writers do not acquire owner, intent or operation locks |
| Foreign-key and deferred-key checks | Parents are already locked by the same transaction or never updated |

This is analysis by inspection. It is not established until the concurrency tests run on a real database. *For the Increment 1 entry points only, the planned concurrency tests have since run and passed once on PostgreSQL 17.11 (§18.15). Every other row remains analysis.*

---

## 14. Migration and rollback strategy

**Facts (as first written, before Gate B-W).** Six migration drafts exist in `db/migrations/` **[APPROVED-M1, never executed]**. No migration has been applied to any database. There is no runner and no tracking table. *Since then: those six drafts were archived unexecuted; six new Increment 1 migrations, a runner and the ledger table were written under Gate B-W; and the new migrations were applied, only to disposable test databases, under Gate B-X (§18.15). No migration has been applied to any other database.*

**Increment 1 scope and file numbering (owner-approved).** Increment 1 creates nine physical tables and six trusted entry-point functions (§18.1). Migration files are numbered **contiguously within the sequence actually written**, so files are always applied in filename order and a later increment never has to insert a file before one already applied. Increment 1 is therefore files `0001` to `0006`; later increments continue from `0007`. The step table below still describes the *content and ordering* of the complete design, but **its step numbers are no longer file numbers**. The mapping for Increment 1 is:

| File (`db/migrations/`) | Content | Step-table rows it draws on |
| --- | --- | --- |
| `db/bootstrap/0000_roles_and_schemas.sql` (not a numbered migration; run once by a database administrator) | Five roles; schemas `shopaccess` and `shopaccess_api`; PUBLIC revokes; default privileges | Bootstrap |
| `0001_migration_ledger.sql` | `schema_migrations`; shared reject-change trigger function | 0001 |
| `0002_keys_owners_sessions.sql` | `session_admission_guard` and its row; `server_key_versions`; `checkout_owners`; `shopper_sessions`; triggers and indexes | 0002 |
| `0003_merchant_catalog.sql` | Three catalog tables | 0003 |
| `0004_merchant_catalog_seed.sql` | Seed rows equal to the code fixture | 0011 (reference data), catalog part |
| `0005_audit_events.sql` | `audit_events` | 0008 |
| `0006_session_and_key_functions.sql` | One internal helper; six entry points; function-owner table privileges; EXECUTE grants; hand-over to `shopaccess_definer` | 0010, session and key part |

The `pgcrypto` extension is not part of Increment 1: owner IDs use core `gen_random_uuid()`. It is added by the increment that introduces worker claim secrets.

Increment 2 continues at `0007`. Planned split: schema, then functions (2.1); challenge functions (2.2). File names are fixed when written. No Increment 2 migration file exists.

**Strategy (D-3: approved with restrictions).** The six unexecuted drafts are to be replaced by one coherent PostgreSQL 17 sequence, preserving history. The owner has approved, as an architectural direction, that the six legacy drafts are **archived before any later replacement**. They were uncommitted, so version control did not hold them. **Archived under Gate B-W** to `db/migrations/archive/milestone-001-unexecuted/`, with original filenames and byte-for-byte contents; SHA-256 checksums were recorded before the move, verified identical afterwards, written into that folder's README and re-checked by a unit test. The migration runner reads only files directly inside `db/migrations/`, refuses any path containing an `archive` segment, and never executes the archived drafts. After the independent audit this was hardened (§18.12, correction 4): paths are resolved with realpath, symlinks are refused, and only an explicit six-file inventory pinned by SHA-256 is accepted. The step table below is a proposal; exact contents remain unapproved.

| Step | Contents | Why here |
| --- | --- | --- |
| Bootstrap (run once by a database administrator, outside numbered migrations) | Roles; schema; the `pgcrypto` extension for the claim-secret helper (D-48; not installed by this document); revoke of PUBLIC privileges; default privileges so new functions are not executable by PUBLIC | Needs role-creation rights the migration role should not hold |
| 0001 | `schema_migrations`; shared trigger functions. (`database_environment` is **not** an Increment 1 table: it is created in the increment that introduces adapter policies, before any policy row) | Deployment identity exists before dispatch policy rows; functions exist before triggers use them |
| 0002 | `checkout_owners`; `server_key_versions`; `shopper_sessions`; `session_admission_guard` with its seed row | Owners and key versions precede sessions |
| 0003 | Catalog tables | Unchanged from the draft |
| 0004 | `purchase_groups`; `checkout_intents` with its two operation-type columns and their pairing and discriminator CHECKs, but without its pointer keys F-4, F-5, F-6T and F-7T; `quotes`; `quote_items`; `confirmation_challenges`; `dispatch_authorizations` without its adapter/policy FKs; `purchase_group_risk_acknowledgments` | Each follows its base-table references; adapter FKs are deferred until 0009 |
| 0005 | `adapter_contracts` with its candidate key; `adapter_contract_status_order`; `adapter_finality_suites` with its primary key and U-S1 (no rows); `adapter_finality_evidence` with F-27 and its own unique key; `adapter_finality_evidence_reviews` with its unique key; `adapter_contract_finality` with F-25 and F-26; CT-2; `adapter_dispatch_policies` | Each referenced unique constraint is declared in the same statement as its table, before any table that references it. Suites, evidence and reviews precede the finality table; policies follow contracts; operation and authorization FKs are added later |
| 0006 | `payment_operations`; `payment_operation_claims`; `payment_provider_observations`; `payment_refund_evidence`; `evidence_review_queue`; then the operation insert trigger that reads the review queue | Observations after operations; the trigger after the table it reads |
| 0007 | `checkout_transition_rules`; `entry_point_event_allowlist`; `checkout_transitions` with F-10T (never the untyped F-10) | Transitions reference observations and operations |
| 0008 | `audit_events` | No dependencies |
| 0009 | F-4 and F-5 as deferrable keys; F-6T and F-7T as non-deferrable keys; F-22, F-24 and related adapter/policy FKs; state CHECKs that passed PGT-47; constraint trigger CT-1 | Every referenced key now exists |
| 0010 | Internal helpers; entry-point functions; `retire_finality_suite` (granted to nobody); owner-scoped read functions; grants exactly as §3.2 and §3.3, with no web SELECT on owner-scoped or payment tables | Tables exist |
| 0011 | Reference data: transition rules and allowlist, generated from the reducer | Functions and tables exist |

Every composite FK in §2.22 is added only after its referenced candidate key exists. In particular, F-22/F-24 cannot be declared inline in 0004 because the adapter and policy tables are not created until 0005; they are added in 0009. The intent/quote/challenge/operation pointer cycle is broken by adding pointer keys last and deferring them.

**Runner.** A small script on the existing `pg` dependency: applies files in name order, one transaction each, records version and checksum, refuses to continue if an applied file's checksum changed. No new dependency. Each migration's BEGIN, advisory lock, statements, ledger row and COMMIT or ROLLBACK run on **one pinned connection**, acquired through an explicit contract and released in every case (§18.12, correction 2). The runner applies only the approved inventory in `src/lib/pg/migrate.ts`; changing a migration file requires changing its recorded checksum in the same reviewed change.

**Catalog seed.** A separate idempotent step loads the code fixture and checks the tables equal it (OPEN D-10).

**Session keys.** The migration creates `server_key_versions` empty; the first key version is registered by an operator action (OPEN D-27).

**Rollback.** There are no down migrations. Locally, the schema is dropped and rebuilt. A reversal procedure is required before any shared database and is not designed here.

**Retention (D-11: retention controls approved as policy; every duration and every mechanism below is PROPOSED — OWNER APPROVAL REQUIRED).** No retention mechanism exists for immutable and append-only tables. **Deletion of payment history is not designed and not authorized.** Nothing in this table is approved for execution:

| Category | Proposal | Deleted by |
| --- | --- | --- |
| Session credentials | Until expiry or revocation | `admit_session` cleanup |
| Owners | While any checkout row exists | Owner cleanup, only with no dependents |
| Unconsumed, non-active challenges | *24 hours after the quote expires, proposal* | Challenge purge. A proposal only; not approved for execution |
| Abandoned drafts; verified payment history; evidence; audit | **Not deleted.** An earlier 30-day Sandbox figure is **excluded**: it is not approved and is not part of the first implementation | No mechanism is designed or authorized |
| Unresolved, parked or conflicting operations; review entries | Indefinitely | Never automatically |

Session, owner and challenge cleanup can remove no operation, observation, transition, review entry or audit row.

---

## 15. Deterministic PostgreSQL tests and verification queries

**None of these tests has been run, except the Increment 1 tests.** Those ran under Gate B-X and passed in the second run (§18.15): PGT-01 to PGT-07, 49, 50, 51, 54a, 54e, 54f, 56, 64, 69a, 69b, 84, 86 to 90, the session expiry cases of 69d, and V-24. They are enabled by `SHOPACCESS_PG_TEST_ADMIN_URL`, not by the switch named below. Every other test in this section is a plan. They require a disposable local PostgreSQL of the selected version (OPEN D-1, D-2), enabled by the existing switch **[APPROVED-M1: `tests/unit/environment.test.ts`]**.

Method: one connection per actor and role; interleavings forced by named pause points and by waiting until the server reports a transaction blocked on a lock; no sleeps; crashes simulated by destroying a connection; expiry reached with backdated rows or by polling the database clock (OPEN D-19). Every test ends by running the verification queries. Results are reported separately from in-memory results, and a skipped test is reported as not run.

Kinds: **S** structural (privilege, constraint, trigger); **P** procedural (logic in a trusted function); **T** depends on a trusted actor.

Test identifiers are those of the source documents, so Appendix A can refer to them. Retired identifiers are listed at the end.

### 15.1 Sessions and ownership

| ID | Scenario | Expected | Kind |
| --- | --- | --- | --- |
| PGT-01 | 50 parallel admissions, one slot left | Exactly one session | P |
| PGT-02 | 80 parallel admissions, empty | Exactly 30 | P |
| PGT-03 | Refusals at capacity, then on budget | First kind consumes budget; second does not | P |
| PGT-04 | Two processes admitting | Same limits | P |
| PGT-05 | Crash inside admission | No session; no budget change | S |
| PGT-06 | Touch on a live, then an expired, session | `last_seen_at = t`; then nothing written | P |
| PGT-07 | Checkout holding the session; revoke attempted | Revoke waits, then applies | P |
| PGT-08 | Revoked or expired session starts a checkout | Not authorized; no rows | P |
| PGT-09 | Session deleted after checkout committed | Checkout, quote and owner remain | S |
| PGT-10 | Cleanup with unknown, pending and parked operations present | No payment row removed | S |
| PGT-54a, e | Touch waits on a lock past expiry; direct update moving `last_seen_at` an idle period ahead or clearing `revoked_at` | Refused; rejected by trigger | P, S |
| PGT-54f | Admission waits on the guard while the window ends and a session expires | Decides with its own `t` | P |
| PGT-56 | Guard row missing; second guard row; truncate | Admission refused; writes rejected | S |
| PGT-64 | Restart with the same ring; differing key under one version; rotation; revocation; rotation racing revocation | Sessions survive; mismatching process refuses; old sessions valid; revoked sessions refused, uncounted and cleaned; no unrevoked session under a revoked version | P, S |
| PGT-84 | Seeded catalog rows compared with the code fixture, field by field, including every row's `catalog_revision`; a later fixture revision loaded into a fresh database | Equal. No CHECK constraint names a revision number; a different positive revision loads without a schema change | S |
| PGT-85 | PostgreSQL-mode cookie parsing: valid `version.token`; missing dot; two dots; empty version; leading zero; sign; whitespace; non-digit; version 0 or above 32767; malformed token; a Mock-format cookie; the cookie twice | Only the first parses. Every other form is treated as no session, with no database call and no fallback to another version | T |
| PGT-86 | Key ring and versions: staged higher version configured with no row; `ACTIVE` key absent from the ring; check-value mismatch; identical key bytes in both purpose rings; cookie naming a revoked, unknown or staged version; verification-only version authorizing an existing session; activation; emergency revocation of the `ACTIVE` version, then activation of a replacement | Staged key unused. Missing or mismatched `ACTIVE` key: startup refused, no admission. Reused key bytes: startup refused. Revoked, unknown or staged version: not authorized, no other version tried. After emergency revocation: `KEY_NOT_ACTIVE` for admission and rotation and that version's sessions revoked, until the replacement is activated | P, T |
| PGT-87 | `row_version` across insert, read-only authorization, touch, rotation, live revocation, repeated revocation, bulk revocation, a refused action and a rolled-back transaction; direct update leaving it unchanged, or adding two | Exactly the table of §2.5; the two direct updates are rejected | P, S |
| PGT-88 | Catalog audit of Increment 1: schemas and their owners; owner of each of the six functions; their search path; EXECUTE grants; the function owner's table privileges; CREATE and temporary-object privileges; role memberships; every grant held by the worker | Exactly §18.4. Functions owned by `shopaccess_definer`; no CREATE on `shopaccess_api` for it after migration; no runtime role is a member of any role; the worker has none | S |
| PGT-89 | Operator key functions and audit: successful activation and revocation; every refusal; a repeated revocation; a transaction rolled back after the function returned | One audit row of the matching type per successful change, in the same commit; no row for a refusal, a repeat or a rollback; no row contains key bytes, a check value or a token | P |
| PGT-90 | Test-clock safety: signatures of the six functions; session settings changed by the caller before each call; a runtime role calling an internal liveness or expiry helper; exact-boundary calls to the helpers by the test owner | No function has a time parameter; settings have no effect on the decision time; helper call refused for runtime roles; helpers return live just before, and expired exactly at and after, each boundary | S, P |
| PGT-69c, d, e | Another session's intent; revoked, idle and absolute expiry; dispatch authorization waiting past expiry; read of `token_digest` | Not authorized; no rows; column unreadable | P, S |

### 15.2 Quotes and confirmation

| ID | Scenario | Expected | Kind |
| --- | --- | --- | --- |
| PGT-12 | Variant repriced around quote creation | Quote built from one catalog snapshot: all values from before the reprice or all from after it, never a mixture. The reprice is not blocked (PGT-117, PGT-118) | P |
| PGT-13 | Update or delete of a quote or item | Rejected | S |
| PGT-14 | 200 page views | One challenge row; same nonce | P |
| PGT-15 | Two tabs submit | One success; other "already used" | P |
| PGT-16 | Views across the renewal margin | New row only near expiry; within the ceiling | P |
| PGT-17 | Nonce key version changed | Old challenge superseded; old nonce refused | P |
| PGT-18 | 20 parallel consumptions | One success | P |
| PGT-19 | Issue racing consume | Never two active; never two consumed | S, P |
| PGT-20 | Backdated challenge consumed | Marked expired; refused | P |
| PGT-54c, g | Consume, and issue, waiting past challenge, session or quote expiry | Refused; no new row | P |
| PGT-57 | Illegal status changes; insert with terminal status; binding column change; delete of `ACTIVE` or `CONSUMED`; pointer pairs `(NULL, 'CONSUMED')` and `(non-NULL, NULL)`; pointer at a non-consumed or foreign challenge; purge | All rejected; purge removes only superseded and expired rows and leaves the pointer intact | S |
| PGT-73a | Vectors V1 to V3 encoded in the database and in TypeScript | V1 `cbb8289475d0e6784dae938e4038a5fd54dbb423d350adf3f4fbebf7b4cde944`; V2 `1763b05d5e4118f0d7dfac99e0f57c61e80eddbe02f52166e1c79fbddfe4b39c`; V3 `1eebb6d9507c3efdb5e094cad29230150dca6c834c7d20a5f8022d20be13d693` | P |
| PGT-73b, c, d | Stored digest altered before issue; before consume; buyer submits a different digest | `QUOTE_DIGEST_MISMATCH` or `CONFIRMATION_MISMATCH`; nothing confirmed | P |
| PGT-73e | `start_checkout` given an amount or digest | No such parameter | S |

Vector inputs: owner `own_` + 32 × `2`; intent `ci_` + 32 × `3`; group `pur_` + 32 × `4`; merchant `dmm_shopaccessdemo`; product `dmp_codebook15`; variant `dmv_codebook15a`; revision 1; discount, tax, shipping 0; `USD`; assumptions `SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1`; created 1791460800000000; expires 1791461700000000. V1: quote `qt_` + 32 × `1`, quantity 1, amounts 79900. V2: quote `qt_` + 32 × `a`, quantity 2, subtotal and total 159800. V3: as V1 with amounts 79901. Each encodes to 411 bytes. The vectors were computed by a scratch script and have not been checked against a database.

### 15.3 Dispatch, roles and claims

| ID | Scenario | Expected | Kind |
| --- | --- | --- | --- |
| PGT-22 | Two workers claim one authorization | One operation, one claim row, one provider call | S, P |
| PGT-23 | Provider call observed while a transaction is open | Never | P |
| PGT-67m | Blocked group; replacement authorizes or claims | Refused; no operation; one refusal audit | P |
| PGT-67n | Constraint conflict forced inside the claim subtransaction | Subtransaction undone; one `DISPATCH_REFUSED_CONSTRAINT` audit; no operation | P |
| PGT-67o | Deadlock during locking | Full rollback; retry succeeds | P |
| PGT-69a | Catalog audit of privileges, grants, PUBLIC, definer settings, role attributes | Exactly §3 | S |
| PGT-69b | web and worker attempt direct INSERT, UPDATE, DELETE on every table | Insufficient privilege | S |
| PGT-69f | web or worker calls an internal helper | Insufficient privilege | S |
| PGT-69j | Final operation without evidence (owner role, scratch schema) | Commit fails on CT-1 | S |
| PGT-69k | Audit function given a payment event type | Rejected | P |
| PGT-71a, b, c | web calls worker functions; worker calls buyer functions or reads sessions; either tries `SET ROLE` or reads claims | Insufficient privilege | S |
| PGT-71e, f | Claim with no, expired or foreign authorization; operation insert without authorization | No operation; rejected | P, S |
| PGT-71g | Takeover, then the first worker ingests with its secret | Refused; accepted only for quarantine | P |
| PGT-71h | Secret assembled from readable operation ID, worker ID and fencing version; random secret; another operation's secret | Refused | P |
| PGT-71i | Superseded worker tries to obtain the successor secret | Impossible | S |
| PGT-71j | Full legitimate flow | One consumed authorization, one operation, one claim row, one call | P |
| PGT-76a | Buyer/web attempts to supply or alter owner, quote, digest, consumed challenge, operation type or adapter snapshot | Function has no such selector inputs; stored authorization is derived from locked authoritative rows; mismatch refused | S, P |
| PGT-76b | Replay one authorization for a second operation, another intent/type, or after quote/confirmation change, cancellation or expiry | At most one operation; stale/replayed request refused before provider call with refusal audit | P |
| PGT-76c | Two workers claim the same authorization; concurrent captures for distinct intents in one purchase group | Unique authorization consumption and owner/group serialization prevent duplicate operation dispatch | P |
| PGT-76d | Policy retirement or adapter withdrawal races authorization and worker claim | Policy/registry locking determines order; a retired pinned policy or withdrawn contract is refused, never replaced silently | P |
| PGT-76e | Shared/inherited deployment configuration exposes worker DB credential or an access path for web code to receive worker claim secrets | Deployment acceptance check detects and rejects shared scope; services remain disabled | T |
| PGT-76f | Worker claim secret intentionally injected into application logs, traces, errors, audit and web responses | Secret absent in all sinks and browser-facing output | P, T |
| PGT-76g | Worker is stopped after authorization commit and restarted; separately, authorization transaction rolls back | Committed authorization is discoverable and claimed once after restart; rolled-back authorization is never claimable; no provider call before confirmed claim commit | P |
| PGT-76h | Web/worker attempts to alter deployment environment through a request argument, GUC or direct table write | No request selector; GUC has no authority; table write denied; policy lookup uses the immutable database environment | S, P |
| PGT-77a | As `shopaccess_web`, direct `SELECT` (whole row, single column, `count(*)`, `EXISTS`, join, subquery, `COPY ... TO`) on each table marked None for web in §3.2 | Insufficient privilege for every table and form | S |
| PGT-77b | Two owners A and B with checkouts. Web role, holding only A's credential, calls each read function with B's intent ID | Generic not-authorized result, byte-identical to the result for a nonexistent ID; no B value in the result or error text | P |
| PGT-77c | Web role calls each read function with A's credential and A's intent | A's rows only; exactly the columns of §3.5; no `token_digest`, claim hash or worker field | P |
| PGT-77d | Read functions called with an unknown, revoked, expired or wrong-key-version credential | Generic not-authorized result; nothing written | P |
| PGT-77e | Signature audit of every web-granted function | None has an owner-ID, session-ID or purchase-group selector that is used as authority; every owner-scoped query filters on the session-derived owner | S |
| PGT-77f | Catalog audit: table and column privileges, PUBLIC, default privileges, role membership, views, materialized views, foreign tables, sequence privileges | Exactly §3.2; no view exists; no column grant on a table marked None | S |
| PGT-77g | Web role creates a temporary table or function named like a schema object, then calls each definer function; also sets `search_path` first | Function behaviour unchanged; schema objects are used | S |
| PGT-77h | Mutating entry points called with A's credential and B's intent, quote, challenge or group; caller-supplied new ID colliding with one of B's | Generic not-authorized or busy result; no refusal reason, constraint name or value derived from B | P |
| PGT-77i | As `shopaccess_worker`, direct `SELECT` on each table marked None for worker; worker calls a web read function | Insufficient privilege | S |
| PGT-77j | Full buyer flow (view checkout, reuse challenge in a second tab, see blocked purchases, acknowledge) with web SELECT revoked | Succeeds using §3.5 functions only | P |
| PGT-79 | Web role, holding a live session credential and the nonce key, consumes a challenge and authorizes dispatch with no browser request | **Succeeds.** Asserted limitation of the consent boundary (§3.4, D-57) | — |
| PGT-70a | Connection destroyed after the claim returns, before COMMIT | No operation; 0 calls | S |
| PGT-70b | COMMIT succeeds; client loses the reply | `confirm_claim` positive; 1 call | P |
| PGT-70c | COMMIT did not happen; client sees a lost connection | `confirm_claim` not found; retry | P |
| PGT-70d, e | As b with the database unreachable, or after the call deadline | 0 calls; recovery parks a capture in `MANUAL_REVIEW` | P |
| PGT-70f | COMMIT returns an error | No operation; 0 calls | S |
| PGT-66 | Mock holds a call past the deadline; call requested after the deadline | Worker aborts; sends nothing | T |
| PGT-82a | One worker process, one claim (same operation, same fencing version). Barriers hold the COMMIT reply so that the uncertain-commit continuation and the confirmed-commit continuation both become runnable for it | Exactly one acquires the guard; the mock adapter records at most one request; the other invokes no provider method and reports a fail-closed result | T, P |
| PGT-82b | As 82a for an order-create operation and again for a capture operation; then with the winner's `confirm_claim` negative, timed out, or throwing; and with the winner aborted at the deadline or cancelled | Capture: 0 or 1 request, never 2. Order-create: at most 1 per claim generation. When the winner sends nothing, 0 requests; the guard is not released and no continuation sends afterwards | T, P |
| PGT-82c | After the guard is consumed, a later continuation for the same operation and fencing version tries each dispatch path, including after an ambiguous provider result, a timeout, an exception and a cancellation, and after a long idle period | Refused; 0 further requests. The consumed capture entry is still present for as long as the process lives | T |
| PGT-82d | Guard acquisition traced against asynchronous steps in the single-threaded worker | Acquisition precedes `confirm_claim`, every post-claim database call, every timer and the provider call on every path; no suspension point between test and set; every provider-dispatch path goes through the same guard | T |
| PGT-82e | Worker process killed after the claim commits (before and after the request), then restarted | New process holds no guard entry and no secret; never uses the uncertain-commit path; capture: recovery reads back, sends nothing, parks for manual review when not found; no `CAPTURE_REDISPATCHED` | P |
| PGT-82f | Stale claims: a capture under a `TAKEOVER` claim attempts to acquire the guard and send; a worker whose claim has been superseded by another worker acquires its own (old-generation) entry and proceeds | `TAKEOVER`: refused, 0 requests. Superseded claim: `confirm_claim` reports the claim is not current, 0 requests, entry stays consumed. Database fencing decides between workers; the guard does not | T, P |
| PGT-82g | Order-create resend permitted by §12.4: the `RESEND` claim's continuations race as in 82a | A new guard entry for the new fencing version; at most one request for it, same request ID; attempt limit still enforced by the database | T, P |
| TA-16a to d | Evidence committed before, during and after a dispatch; guard with the review entry removed | Before and during: refused. After: dispatch stands, evidence quarantined. Still refused by E-4 | P |

### 15.4 Evidence, settlement and reconciliation

| ID | Scenario | Expected | Kind |
| --- | --- | --- | --- |
| PGT-24 | Each APPLY case | Full set of rows in one commit | P |
| PGT-25 | Each harmless duplicate | No observation, state or version change | P |
| PGT-26, 27 | Order, and capture, evidence mismatch on response and on readback | `CONFLICT`; `MANUAL_REVIEW`; review entry | P |
| PGT-28 | Forced incoherent rejection | Operation parked; review entry; no provider outcome on the operation | P |
| PGT-30, 31 | Superseded claim with well-formed, then unattributable, evidence | Quarantined; then nothing stored | P |
| PGT-33 | Quarantine past the cap | Refused | P |
| PGT-34 | Change to a final operation | Rejected | S |
| PGT-35 | Contradictory evidence after verified capture | State and operation unchanged; conflicting observation; review entry | P |
| PGT-36 | Identical readbacks; then a status regression | One row; then a new row | P |
| PGT-37 | Overlong and hostile provider codes | Stored sanitized | P |
| PGT-45 a to j | Same-object quarantined ahead, before and after settlement; compatible progression; immutable-field conflict; different branch after final; contradiction after capture; different object before and after; no declared order | REVIEW with the matching reason where settlement is still to come; quarantine with a review entry where the operation is final; APPLY for compatible | P |
| PGT-45 k, k-2 to k-7 | Object, rejection or incomplete evidence against "not found"; matching "not found"; late evidence after a resend | Resend prohibited with `EVIDENCE_ORDER_UNPROVABLE` except k-2 (permitted) and k-4, k-5 (APPLY) | P |
| PGT-45 k-6a to d | Different order ID arriving before settlement; after non-final settlement with and without recorded object; after final settlement | REVIEW only when an authorized settlement follows; after final: quarantine and entry, nothing else | P |
| PGT-45 p to w | Two compatible, two contradictory quarantined; identical repeat; missing amount, currency, identity; unattributable; concurrent quarantine and settlement | Per §9.5 to §9.7 | P |
| PGT-58, 59 | Approval and post-capture transitions with the operation final; attempted when it is not | Applied without touching the operation; refused | P |
| PGT-61 | Totals 100 then 200; one jump to 200; same identifier twice; two identifiers equal amounts; amounts swapped; total decreases; total above captured; neither identifier nor total | Two rows; one; one; two; conflict; conflict; conflict; review and no row | P |
| PGT-62 | Failure injected before each write of each multi-record entry point | Nothing of that transaction persists | S |
| PGT-69g, h | Ingestion with no, guessed or superseded secret; evidence with wrong amount, order or missing field | Nothing changes; conflict computed by the database | P |
| PGT-69i | Well-formed false `COMPLETED` evidence under a valid claim | **Accepted.** Recorded as the stated limitation | T |
| PGT-75a to e | Pending then completed; no response; unavailable below and above the escalation age; explicit order rejection; permitted order resend | CT-1 satisfied at every commit; no observation for no-response or unavailable; resend issues a new secret | P, S |

### 15.5 Recovery

| ID | Scenario | Expected | Kind |
| --- | --- | --- | --- |
| PGT-38 to 41 | Restart scenarios R-1 to R-9 | As §12.6 | P |
| PGT-42 | Lease expiry alone | Unknown, never failed | P |
| PGT-43, 44 | Takeover racing ingestion; two recovery workers | No deadlock; each operation claimed once | P |
| PGT-52, 53 | Claim commits, worker destroyed, recovery runs; attempt to store a recoverable operation with no schedule | Found by recovery; rejected by CHECK | P, S |
| PGT-54d | Claim waits past the quote's expiry | `QUOTE_INVALIDATED`; no operation; 0 calls | P |
| PGT-60 | Superseded secret after a resend; latest secret | Refused; accepted | P |
| PGT-63 | Each resend condition failing; capture by default | Observation, parked operation, `MANUAL_REVIEW`, transition, review entry, audit; 0 calls | P |
| PGT-65 | Quote pointer changes between preliminary read and lock | Transaction restarts | P |

### 15.6 Purchase groups, acknowledgments and adapters

| ID | Scenario | Expected | Kind |
| --- | --- | --- | --- |
| PGT-67a | Replacement after a successful capture | `PURCHASE_ALREADY_PAID` | P |
| PGT-67b | Two replacements claim together | One live capture | S |
| PGT-67c, d | Replacement while a capture is unknown; late success after an unverified decline | Refused before any call | P |
| PGT-67e | Final decline, then replacement: (i) schema as migrated, no finality; (ii) after the complete evidence chain of PGT-78k is built in the test database for the pinned contract and that outcome | (i) Refused `PRIOR_CAPTURE_FINALITY_UNVERIFIED`. (ii) Permitted | P |
| PGT-67f, g, h | Fresh checkout while another purchase is blocked; acknowledged; a further purchase becomes blocked | Refused; permitted; refused again | P |
| PGT-67i, j | Crash and restart; evidence racing a sibling's dispatch | Index holds; dispatch blocks then is refused | S, P |
| PGT-67k | Structural negatives for groups, replacements, acknowledgments | Rejected | S |
| PGT-67l | Same purchase from a second anonymous session | **Permitted.** Asserted limitation | — |
| PGT-67s to x | Acknowledgment racing settlement, quarantine, resolution, renewed uncertainty, dispatch, takeover | Stale acknowledgment refused; takeover does not change the fingerprint | P |
| PGT-67y | Paid group with contradictory stale evidence | Paid and blocked; no downgrade; further dispatch refused | P |
| PGT-67z, aa | Unverified, acknowledged, approved, withdrawn; approval held during acknowledgment | Old acknowledgment refused; acknowledgment waits on the contract row | P |
| PGT-67bb | Encoding edge cases | Different bytes; fixed sample gives a fixed digest | P |
| RF-A to RF-F | Verified decline; no guarantee; unverified or ambiguous; verified and unknown rejection; late success without guarantee; concurrent retry and quarantine | Retry only with pinned verified finality. Every case states its setup. "Verified" cases (RF-A, the verified half of RF-D) first build the complete chain of PGT-78k: test suite row, executed-result record, `PASS` evidence, second-person `ACCEPTED` review, approval. RF-B, RF-C, RF-E and the unknown half of RF-D run with no finality row. RF-F runs with the chain built and a quarantined observation arriving during the retry. None relies on a pre-seeded finality row, and each verified case is repeated after `retire_finality_suite` to show the retry is then refused | P |
| PGT-68a, b | Operation pinned to a version with, or without, finality while workers run another version | Pinned version governs | P |
| PGT-68c, d | Digest mismatch; mixed-version workers | Worker does not act; right worker settles | P |
| PGT-68e to g, j to l | Withdrawal of finality or contract, alone and racing a claim | Refused afterwards; withdrawal waits for an in-progress claim | P |
| PGT-72a, b | Operator inserts or updates registry rows directly; owner inserts an `APPROVED` row | Insufficient privilege; rejected by trigger | S |
| PGT-72c, d | Approval of unknown, unsealed, wrong-digest or incomplete contracts | Refused | P |
| PGT-72e, f, g | Registration with a status; provenance and monotonic status; claim under an unapproved contract | Impossible; immutable; refused | S, P |
| PGT-78a | `approve_adapter_finality` with no evidence ID, an unknown one, or evidence with `result = 'FAIL'` | Refused; no finality row; one audit row naming the check | P |
| PGT-78b | Evidence for another adapter, another contract version, the same version with a different contract digest, another outcome or another reason class | Refused (A-2) | P |
| PGT-78c | Evidence not reviewed; reviewed `REJECTED`; review attempted by the recorder; approval attempted by the recorder | Refused (A-6, A-7; review trigger) | P |
| PGT-78d | Expected result digest or expected contract digest differs from the stored one; suite digest in the evidence differs from the suite row; suite retired | Refused (A-1, A-4, A-5) | P |
| PGT-78e | `PASS` evidence recorded with a skipped, errored or failed case, with passed ≠ total, or with a total different from the suite's required count | Rejected at insert | S |
| PGT-78f | Direct `INSERT` of a `VERIFIED` finality row, as operator and as table owner, with NULL, missing, failing or unreviewed evidence columns | Insufficient privilege; NOT NULL, F-25 or F-26 violation | S |
| PGT-78g | `UPDATE`, `DELETE` on evidence, review and suite rows; operator `INSERT` into `adapter_finality_suites` | Rejected | S |
| PGT-78h | Schema as migrated, with no suite row: record evidence; approve finality; then a replacement capture after a mock `DECLINED` and after a mock `REJECTED` | Evidence and approval refused; both retries refused `PRIOR_CAPTURE_FINALITY_UNVERIFIED` before any provider call | P |
| PGT-78i | Finality approved for contract version 1; operation pinned to version 2 of the same adapter declines; retry | Refused; version 1's evidence does not carry over | P |
| PGT-78j | Finality withdrawn after approval; withdrawn row re-approved with the same or new evidence | Retry refused; re-approval refused (A-8) | P |
| PGT-78k | Complete valid chain in a test database (seeded test suite row, recorded `PASS`, second-person `ACCEPTED`, approval) | One `VERIFIED` row carrying evidence ID, suite version and result digest; retry after that exact outcome permitted | P |
| PGT-78l | Catalog audit: every foreign key in §2.22, including F-25 to F-27, references a declared PRIMARY KEY or UNIQUE constraint with identical columns and order. Direct SQL: evidence citing an existing suite ID and version with a different digest, another adapter, another outcome or another reason class; evidence citing an unknown suite; a second suite row repeating a primary key | Audit passes; each insert fails on F-27 or the primary key | S |
| PGT-78m | Chain of PGT-78k; a capture declines; `retire_finality_suite`; then replacement authorization and claim | Finality row `WITHDRAWN` with reason `SUITE_RETIRED` in the retirement's commit; both refused `PRIOR_CAPTURE_FINALITY_UNVERIFIED`; no operation; no provider call; one retirement audit row | P |
| PGT-78n | As table owner, `UPDATE` a suite's `retired_at` directly while a `VERIFIED` row cites it; insert a `VERIFIED` row citing an already retired suite | Commit fails on CT-2; insert refused | S |
| PGT-78o | Retirement concurrent with dispatch, both orders forced with a barrier: (i) retirement holds the contract row, then `authorize_dispatch` and `claim_authorized_dispatch` start; (ii) each of those holds its share lock, then retirement starts; (iii) authorization commits, retirement commits, then the claim runs | (i) Both wait, then refuse. (ii) Retirement waits; the claim's operation exists and is the unresolved, unapproved residual of §7.7; every later attempt refuses. (iii) Claim refuses; authorization `REFUSED`; no operation; 0 provider calls. No deadlock in any order | P |
| PGT-78p | Group blocked on another group; acknowledgment stored while finality is `VERIFIED`; retirement; then dispatch. Separately, `acknowledge_risk` racing retirement | Fingerprint differs after retirement; stored acknowledgment no longer satisfies G-3; dispatch refused `OTHER_PURCHASE_UNRESOLVED`; racing acknowledgment either precedes and is invalidated or follows and is refused `ACKNOWLEDGMENT_STALE` | P |
| PGT-78q | `approve_adapter_finality` racing retirement, both orders; approval, re-approval or new evidence against a retired suite | Never a committed `VERIFIED` row citing a retired suite; all later attempts refused | P |
| PGT-78r | Retirement while an operation under the affected contract is `UNKNOWN` and recovery runs | Recovery not blocked; readback and settlement proceed; no capture resend | P |

### 15.7 Structure and state machine

| ID | Scenario | Expected | Kind |
| --- | --- | --- | --- |
| PGT-47 | Every reducer-reachable snapshot against each proposed state CHECK | Zero violations, or the CHECK is dropped | P |
| PGT-48, 49 | Opposite-order locking; lock timeout | Deadlock detected and retried; generic busy result | P |
| PGT-50 | Update, delete, truncate on every append-only or immutable table | Rejected | S |
| PGT-51 | Migrations applied twice; one file altered | No-op; refused | S |
| PGT-55 | Every cross-owner, cross-intent, wrong-operation and quarantined-citation reference in §2.22; transition pairs `(NULL, TRUE)` and `(non-NULL, NULL)` | Rejected | S |
| PGT-55a | Direct SQL as table owner: observation with `operation_id` NULL and a valid intent | NOT NULL violation | S |
| PGT-55b | Direct SQL: refund row with `capture_operation_id` NULL; separately with `capture_operation_type` NULL | NOT NULL violation each | S |
| PGT-55c | Direct SQL: refund row with `observation_id` NULL; separately with `observation_subject` NULL | NOT NULL violation each | S |
| PGT-55d | Direct SQL with all components non-NULL: refund citing an order-create operation; an `ORDER` observation; an observation of another capture operation; an observation of another intent | CHECK, F-12 or F-13 violation | S |
| PGT-55e | Catalog audit of every referencing column in §2.22 | NOT NULL everywhere except the columns listed as nullable by design in §2.22 | S |
| PGT-55f | Legitimate flows: order response, capture response, not-found readback, quarantined stale-claim evidence, approval evidence, first and second partial refund, totals-only refund | Every observation has an operation; every refund row has all four provenance values; all inserts succeed | P |
| PGT-55g | Evidence naming no known operation of the intent | Refused with an audit row; no observation stored | P |
| PGT-55h | Direct SQL as table owner: a transition for each operation-requiring event of §10.3 (one per event type, with its legitimate actor) and `operation_id` NULL, observation columns valid | CHECK violation for every one | S |
| PGT-55i | Direct SQL: a transition by `shopper`, `server`, `timer` or `browser_redirect` with a non-NULL `operation_id`; `EXPIRED` by `provider_readback` with NULL; `EXPIRED` by `timer` with an operation | CHECK violation each | S |
| PGT-55j | Direct SQL: operation-bearing transition citing an operation of another intent, or an unknown operation, with a syntactically valid `operation_type` | F-10T violation | S |
| PGT-55l | Catalog: F-10T, F-6T and F-7T exist and reference the declared unique key `payment_operations (id, checkout_intent_id, operation_type)`; no untyped F-10, F-6 or F-7 is declared. Direct SQL: a transition citing a real operation with the wrong `operation_type`; an order event citing the capture operation and a capture event citing the order operation; `operation_id` set with `operation_type` NULL and the reverse; an intent order pointer naming a capture operation and a capture pointer naming an order operation; an intent pointer set with its type column NULL, and a type column set with its pointer NULL, for each pointer; a type column holding the other discriminator. Catalog: both type columns exist on `checkout_intents`, and F-6T and F-7T are not deferrable | Violation of F-10T, the event-type CHECK, the pair CHECK or the typed pointer key | S |
| PGT-81a | Owner with exactly 10 active or unresolved groups starts a checkout in a new group; with 9, starts one; a group at the intent limit gets a replacement | Refused at 10 with one audit row and no group or intent created; permitted at 9; replacement refused | P |
| PGT-81b | Owner with more than 10 fully resolved groups (cancelled, expired, superseded, failed, captured with no refund, fully refunded) and fewer than 10 unresolved, starts a new group | Permitted. Resolved history is not counted, is still stored and readable, and is not a lifetime limit | P |
| PGT-81c | One at a time, a group is made unresolved by: an `ISSUED` authorization; an operation `UNKNOWN`, `PENDING_PROVIDER` or parked; a review entry; a `CONFLICTING` capture observation; a declined capture (no finality); `MANUAL_REVIEW`; a partial refund; a reversal or dispute; a captured intent beside an unresolved sibling; a captured group with evidence under review. Then: owner at 10 unresolved, and late evidence makes an eleventh, previously resolved, group unresolved | Each is counted, and none becomes resolved by any action available in this design. With 11 unresolved every record is intact and unchanged in class, and a new group is still refused; it stays refused until the count is below 10 | P |
| PGT-81d | Owner with 9 active groups; two and then many concurrent `start_checkout` calls for new groups, forced to overlap with a barrier | Exactly one creation succeeds; the rest wait on the owner row and are refused; creation never takes the count past 10; no deadlock | P |
| PGT-81e | Row counts and content digests of the owner's groups, intents, operations, observations, refund ledger, review entries, transitions and audit rows taken before and after every refusal and every permitted creation in 81a to 81d | Unchanged apart from the new rows of a permitted creation and the refusal audit rows; no state, pointer, evidence role or classification altered; nothing deleted, recycled or overwritten | P |
| PGT-55k | Legitimate flows end to end: quote, confirm, invalidate, buyer return, cancel, timer expiry, supersession; and every operation-bearing event raised through its entry point | Operation-free events stored with NULL; every other transition cites the operation named in §10.3; all inserts succeed | P |
| PGT-80a | Reducer parity: `REFUND_OBSERVED` from `CAPTURED_VERIFIED` and from `PARTIALLY_REFUNDED_OBSERVED`, partial and full; from `REFUNDED_OBSERVED` | Rule table equals the reducer: accepted from the first two with the reducer's target states, rejected from the third. No rule exists that the reducer lacks | P |
| PGT-80b | Two distinct partial refunds, then the same evidence again, then a refund completing the total | One ledger row and one `REFUND_OBSERVED` transition per new refund fact; the repeat is NO-CHANGE; the last moves to `REFUNDED_OBSERVED`; every transition is one the reducer accepts | P |
| PGT-80c | Mock-mode comparison for the same sequence (existing Milestone 001 behaviour, read from code, not re-run here) | Documented difference only: the mock orchestrator raises no event for a second partial refund; PostgreSQL mode raises a reducer-accepted `REFUND_OBSERVED` | — |
| PGT-83a | Draft with `created_at` backdated so that `t` is just before `created_at` plus 24 hours; `expire_checkout`, then a re-quote | Not expired; stays `DRAFT`; re-quote succeeds | P |
| PGT-83b | Draft with `t` exactly equal to `created_at` plus 24 hours | Expired: `EXPIRED` by `timer`, one transition with NULL operation and NULL operation type, one audit row | P |
| PGT-83c | Draft just after the boundary. Separately, an intent created more than 24 hours ago, quoted and confirmed in time, then returned to `DRAFT` by `QUOTE_INVALIDATED` | Both expired. The clock is not reset by the return to `DRAFT`: the returned draft is measured from its original `created_at`, cannot be re-quoted, and is expired by the worker | P |
| PGT-83d | At and past the boundary, before the worker has run and with the stored state still `DRAFT`: `start_checkout` re-quote of that intent. Then after `EXPIRED`: re-quote, confirm, cancel | Refused each time; no state change by the web role; no quote or challenge created; `created_at` unchanged | P |
| PGT-83e | Intents older than the age in every non-`DRAFT` state, including with operations `UNKNOWN`, parked, `SUCCEEDED`, a refund ledger and review entries; a group with an expired draft beside an unresolved sibling | Draft rule expires none of them; row counts and content of operations, observations, ledger, review entries, transitions and audit unchanged; the group is still counted under §6.6 | P |
| PGT-83f | `expire_checkout` and a re-quote of the same draft, both orders forced with a barrier on the intent lock: once just before the boundary, once at it | Before the boundary: the re-quote is permitted in either order and expiry does nothing. At the boundary: the re-quote is refused in either order and the draft ends `EXPIRED`. One transition; consecutive versions; no deadlock | P |
| PGT-69l, 74f | Rule, result, flow and allowlist parity with the reducer | Equal | P |
| PGT-74a to e | Allowlist content; helper not executable; unpaired entry point and event; approval or post-capture ingestion with a non-final operation; no path to `CAPTURE_REDISPATCHED` | Exactly §10.2; refused | S, P |

Retired identifiers: PGT-11 (folded into PGT-55 and PGT-69c), PGT-21 (superseded by the nonce derivation), PGT-29 (superseded by PGT-71g), PGT-32 (covered by PGT-45), PGT-46 (replaced by PGT-63), V-16 as a query (replaced by TA-16).

### 15.8 Verification queries

Each must return no rows.

| Check | Looks for |
| --- | --- |
| V-1 | Intents whose `row_version` is not one plus their number of transitions |
| V-2 | Gaps or duplicates in `to_version` |
| V-3 | Broken chains of `from_state` and `to_state`, or a last `to_state` differing from the intent's state |
| V-4 | A provider-actor transition with no observation, a quarantined one, or one of another intent |
| V-5 | A pointed-to operation and checkout not allowed by §7.4 |
| V-6 | More than one `ACTIVE` or `CONSUMED` challenge per quote; a confirmation pointer at a non-consumed challenge |
| V-7 | A checkout in `USER_CONFIRMED` or later whose confirmation pointer does not name a consumed challenge |
| V-8 | Operations in `PENDING` or `READBACK_CLEARED` |
| V-9 | Recoverable, non-parked operations with no schedule |
| V-10 | Order pointer not at an `ORDER_CREATE` operation, or capture pointer not at a `CAPTURE` |
| V-11 | Quote item whose product belongs to another merchant |
| V-12 | Refund ledger gaps, bad totals, a refund whose capture is not `SUCCEEDED`, or a checkout whose refund state disagrees with its ledger |
| V-13 | An unrevoked session under a revoked key version |
| V-14 | A claimed operation with fencing version 0, or `DISPATCHING` with no call deadline |
| V-15 | A quarantined observation that requires a review entry (§9.7) and has none. Needs the contract's status order; run by test code |
| V-18 | A group with a `SUCCEEDED` capture not derived as paid |
| V-19 | An acknowledgment whose fingerprint was not current at insert. Test-time assertion only |
| V-20 | A settled operation without an authoritative observation and citing transition |
| V-21 | An operation whose authorization is not `CONSUMED`, or a `CONSUMED` authorization without exactly one operation |
| V-22 | An operation at fencing version `n` without claim rows 1 to `n` |
| V-23 | A `VERIFIED` finality row whose cited evidence is not `PASS`, is for another contract digest or outcome, has no `ACCEPTED` review, or cites a retired suite |
| V-24 | A runtime-role table or column SELECT grant, a PUBLIC grant, a view, or a role membership not listed in §3 |
| V-25 | A transition whose `operation_id` presence disagrees with its actor, whose `operation_type` differs from the cited operation's, or whose cited operation is not of the type §10.3 names for that event. Backstop to F-10T. V-10 is the corresponding backstop to F-6T and F-7T, and also lists any intent pointer whose type column is NULL or mismatched |

V-16 and V-17 are not used. V-16 was retired in favour of TA-16. A recoverable operation under a withdrawn contract is permitted (§7.5), so it is reported for monitoring and is not a failing check.

---

## 16. Deferred real-PayPal and other gates

Nothing in this section is authorized. Each item must be settled before the corresponding gate opens.

| Gate | Required first |
| --- | --- |
| PayPal Sandbox | A migration widening the `provider` CHECKs. A PayPal adapter contract with its own status order, replay declaration and finality clause, each established from the provider's documented behaviour and conformance-tested; **no PayPal replay, lookup or finality behaviour is assumed here**. A way to authenticate provider responses or notifications that the worker cannot forge, so "authenticated evidence" gains a cryptographic meaning. Mapping of real provider fields onto the evidence allowlist, including refund identifiers and totals. Webhook design. Funding-method decisions. Operator approval of dispatch and finality for that contract |
| External AI | Model selection; spend limits; existing output guards re-verified against a real model |
| Channel3 | Account terms and quotas; external-catalog separation re-verified |
| Public deployment | Managed PostgreSQL and its version; role and credential provisioning with real separation of the two runtimes; backups; the privileged retention procedure; a migration reversal procedure; a shared rate-limit store; a scheduler for recovery; headers and content-security-policy review; monitoring for parked operations, review entries and operations no worker supports |
| Manual review | A resolution workflow for `MANUAL_REVIEW`, parked operations and review entries (D-12) |

Automatic capture resend stays disabled at every gate until explicitly decided otherwise.

---

## 17. Owner decisions, differences, holds and limitations

### 17.1 Owner-decision register

Reconciled with the owner's decision record for Groups 1 to 10. The status column records what the owner approved and nothing more. A policy approval does not approve a number, a schema definition or a function signature: "Exact schema and function signatures: PROPOSED — OWNER APPROVAL REQUIRED" applies to every row. No implementation is authorized by any row.

Status meanings: **APPROVED — architectural policy**; **APPROVED — with restrictions** (the restriction is in the last column); **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** (the value shown is a proposal); **DEFERRED / DISABLED**; **DEPLOYMENT GATE**; **HISTORICAL SOURCE HOLD**.

| # | Decision | Status | Owner record, restriction, and what remains |
| --- | --- | --- | --- |
| D-1 | PostgreSQL major version | **APPROVED — architectural policy** | PostgreSQL 17 |
| D-2 | Disposable local PostgreSQL for tests | **APPROVED — with restrictions** | Isolated, disposable local test database approved as an architectural choice. No setup, migration execution or testing is authorized |
| D-3 | Replace drafts 0001 to 0006, or add to them | **APPROVED — with restrictions** | Replace the six unexecuted drafts with a coherent PostgreSQL 17 sequence, preserving history. Owner-approved and done under Gate B-W: the six drafts are archived, unchanged, at `db/migrations/archive/milestone-001-unexecuted/` (§14); Increment 1 uses contiguous files `0001` to `0006`. The one legacy-bound test change is recorded in §18.9. Archive location and timing: PROPOSED — OWNER APPROVAL REQUIRED |
| D-4 | Capacity refusals consume the admission budget | **APPROVED — architectural policy and value, local MVP** | Safe capacity refusals approved; a capacity refusal consumes the admission budget. **Owner-approved values: maximum 500 live sessions; 30 admissions per minute** |
| D-5 | `own_` prefix; owner ID in the quote digest | **APPROVED — with restrictions** | Durable, server-generated opaque ownership and database-computed quote integrity, subject to exact specification verification. Proposed: `own_` prefix; owner ID in the quote digest |
| D-6 | Challenge renewal margin and ceiling | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Bounded challenge renewal approved. Proposed: 60 s margin; ceiling 8 |
| D-7 | Touch threshold | **APPROVED — architectural policy and value, local MVP** | **Owner-approved value: 60 seconds** |
| D-8 | Timeouts and retry count | **APPROVED — architectural policy and value, local MVP** | Bounded timeouts and safe backoff approved, without payment-capture resend. **Owner-approved values: `lock_timeout` 2 seconds; `statement_timeout` 5 seconds; `idle_in_transaction_session_timeout` 10 seconds; at most 3 database-only transaction re-runs** (§13.1). A re-run never triggers an additional payment-provider call |
| D-9 | Carts | **APPROVED — architectural policy** | Multi-item carts deferred; one merchant-authorized product per initial purchase |
| D-10 | Catalog authority | **APPROVED — architectural policy** | The merchant-controlled catalog is the only authority for purchasable products. Existing monetary type and ranges retained; no fixture revision in any CHECK; fixture equality by planned test PGT-84 (§2.6) |
| D-11 | Retention durations and mechanism | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Retention controls approved. No duration is approved. History deletion is not designed or authorized; the 30-day Sandbox figure is excluded (§14) |
| D-12 | Resolution of manual review, parked operations, review entries | **APPROVED — with restrictions** | Fail-closed manual-review parking only. Automated resolution is not approved; a resolution workflow is undesigned |
| D-13 | Quarantine cap per operation | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Quarantine capacity approved. Proposed: 20 per operation |
| D-14 | Supply Specification v1.0 and full audit texts | **HISTORICAL SOURCE HOLD** | Not part of the owner's approvals. Complete Re-Audit 010 is supplied; Specification v1.0, original Re-Audits 005–008 and AUD-014 remain unavailable; Re-Audits 011 and 012 are not retained locally (§17.3) |
| D-15 | Mock mode adopts challenge reuse | **APPROVED — with restrictions** | **Existing Mock mode challenge behaviour is preserved.** Challenge reuse applies in PostgreSQL mode only. The earlier recommendation that Mock mode adopt reuse is withdrawn |
| D-16 | Dedicated confirmation-nonce key | **APPROVED — architectural policy** | Dedicated confirmation-nonce key, separate from other credentials. PostgreSQL mode; Mock mode unchanged |
| D-17 | Automatic capture resend | CLOSED — **DEFERRED / DISABLED** | Automatic capture resend is disabled. This closure is not permission for any resend |
| D-18 | Maximum attempts per operation | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Attempt limits approved. Proposed: 3 order-create attempts; a capture is never resent |
| D-19 | Test time control | **APPROVED — architectural policy** | **Owner-approved mechanism (Gate A):** backdated fixture rows in a disposable test database; internal liveness and expiry helpers with an explicit time parameter; production entry points always use database time; no caller-controlled clock and no overriding session setting; test-owner access absent from runtime environments (§18.8) |
| D-20 | Backoff schedule and escalation age | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Recovery backoff and escalation approved. Proposed: 30 s, 1 min, 2 min, then 5 min; escalation at 60 min |
| D-21 | Key-ring variable names and format | **APPROVED — architectural policy and configuration, local MVP** | Owner-approved: `SHOPACCESS_SESSION_KEYS` and `SHOPACCESS_NONCE_KEYS`; strictly parsed, comma-separated `version:base64key` entries; at least 32 decoded key bytes per entry. Also approved (Gate A): separate purposes; active, verification-only, revoked and staged keys; the database `ACTIVE` version decides admission; HMAC-SHA-256 check value; no reuse of key bytes across the two rings; fail-closed on a missing or mismatched active key; emergency revocation; Mock single key unchanged (§18.5) |
| D-22 | Recovery poll interval | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Recovery polling approved. Proposed: 5 s |
| D-23 | Refund evidence with neither identifier nor total | **APPROVED — architectural policy** | Incomplete refund evidence is preserved without increasing the verified refund total: review entry, no state change (§9.9) |
| D-24 | Idle timeout duplicated in the session trigger | **APPROVED — architectural policy and value, local MVP** | Authoritative idle-expiry calculation approved. **Owner-approved values: idle timeout 2 hours; absolute lifetime 24 hours.** The trigger constant equals the application constant, with a schema test |
| D-25 | Maximum refund entries per piece of evidence | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Refund-evidence ingestion limits approved. Proposed: 50 entries per piece of evidence |
| D-26 | Lease, provider-call timeout and safety margin | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Lease, call-deadline and safety-margin constraints approved. Proposed: 30 s, 10 s, 5 s |
| D-27 | Who runs key activation and revocation | **APPROVED — architectural policy** | Restricted key activation and revocation authority. Proposed holder: the operator role |
| D-28 | Operation-type helper columns for the intent's pointers | **APPROVED — architectural policy** | Typed, database-enforced operation references, for the intent's pointers **and for transition citations** (§2.18, §2.22). Owner-approved: F-10T replaces F-10; F-6T and F-7T replace F-6 and F-7; the columns `order_create_operation_type` and `capture_operation_type` are registered in §2.9 with paired nullability and fixed discriminators; non-deferrable keys preferred. Exact schema and function signatures: PROPOSED — OWNER APPROVAL REQUIRED |
| D-29 | Package script to start the worker | **APPROVED — architectural policy** | Separately started worker with its own credentials. Owner-approved for the local MVP: the worker is a single-threaded event loop (§12.1a). Script name decided at implementation |
| D-30 | Approve the mock's `DECLINED` finality | **DEFERRED / DISABLED** | Retry after a decline is disabled. No finality approval. Enablement needs a new owner decision, accepted evidence under §7.7, and resolution of the §7.7 in-flight residual |
| D-31 | Mock records rejected request IDs | **DEFERRED / DISABLED** | Retry after a rejection is disabled. The mock is not changed |
| D-32 | Purchase groups | **APPROVED — architectural policy** | Durable purchase groups, without automatic combining of authorizations |
| D-33 | Permit "separate purchase" acknowledgment | **APPROVED — architectural policy** | Explicit acknowledgment for separate purchases and charges |
| D-34 | Every dispatch for an owner serialized on the owner row | **APPROVED — architectural policy** | Conservative same-shopper dispatch serialization on the owner row |
| D-35 | `pur_` and `da_` prefixes | **APPROVED — architectural policy** | Consistent non-sensitive identifier prefixes. Proposed: `pur_`, `da_` and the others used in §2 |
| D-36 | Registry tables and operator functions | **APPROVED — architectural policy** | Versioned registries with restricted administrative functions |
| D-37 | What "resume" offers | **APPROVED — architectural policy** | Safe checkout resume without automatic capture |
| D-38 | Limit on active or unresolved purchase groups per shopper; intents per group | **APPROVED — architectural policy and value, local MVP** (group limit; intents per group, G2-14) | **Owner-approved: 10 active or unresolved purchase groups per shopper.** Not a lifetime purchase limit. Approved with it: only active or unresolved groups count; fully resolved history does not count and is retained subject to separately approved retention rules; the conservative classification of §6.6; no group is declared resolved to free capacity; refusal at capacity; creation serialized on the owner row; late evidence may take the count above 10 with records intact and creation still refused; nothing deleted, recycled, overwritten or misclassified. **Also owner-approved (G2-14): 10 intents per purchase group.** Counting by query is approved for design (§19.9) |
| D-39 | Role model | **APPROVED — architectural policy** | Least-privilege roles; runtime and administrative authority separate. Owner-approved (Gate A): schemas `shopaccess` and `shopaccess_api`; non-login function owner `shopaccess_definer`; explicit EXECUTE grants; no runtime table writes; no runtime use of migration credentials; no worker grant in Increment 1; no temporary-object creation for runtime roles (§18.4). Grants for later increments remain unapproved in detail |
| D-40, D-43 | Payment logic implemented in database functions as the trusted boundary | **APPROVED — architectural policy** | Narrowly scoped trusted database functions for ownership, transitions, dispatch and evidence, with restricted grants and a secure execution context. Exact schema and function signatures: PROPOSED — OWNER APPROVAL REQUIRED |
| D-41 | Any transition changes the risk fingerprint | **APPROVED — architectural policy** | Acknowledgments are invalidated after checkout-critical risk changes |
| D-42 | Dispatch-approval withdrawal does not stop in-flight recovery | **APPROVED — with restrictions** | Safe policy withdrawal and in-flight recovery approved. **Not approved:** the in-flight retry residual of finality-suite retirement (§7.7), which is unresolved |
| D-44 | Separate web and worker roles | **APPROVED — architectural policy** | Separate web and worker database roles, without inherited privileges |
| D-45 | Secret claim credentials | **APPROVED — architectural policy** | Unpredictable, single-use worker claim credentials; hash-only durable storage; fencing |
| D-46 | Uncertain commit with an unreachable database sends a capture to manual review | **APPROVED — with restrictions** | Fail-closed on uncertain database commits, with only the narrow same-worker claim-verification exception of §12.1 step 5. Owner-approved: the atomic, synchronous, process-local one-shot dispatch guard of §12.1a, shared by every dispatch path; a consumed capture guard is never evicted while the process lives; a restart never reconstructs permission to send. Database claim fencing stays authoritative across processes |
| D-47 | Dispatch authorization lifetime | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Bounded dispatch-authorization lifetime approved. Proposed: 120 s |
| D-48 | Random source for claim secrets | **APPROVED — architectural policy** | PostgreSQL 17 `pgcrypto`, 32 cryptographically secure random bytes, through a restricted helper (§2.14). The extension is not installed and no SQL is run by this document. Helper name and extension schema: PROPOSED — OWNER APPROVAL REQUIRED |
| D-49 | Mock mode adopts `SAQD-1` | **APPROVED — with restrictions** | Database-authoritative `SAQD-1` in **PostgreSQL mode only. Existing Mock mode behaviour is unchanged.** The earlier recommendation that Mock mode adopt `SAQD-1` is withdrawn |
| D-50 | Scope of `expire_checkout` | **APPROVED — architectural policy** | Consistent expiry enforcement without falsifying payment outcomes: `expire_checkout` acts on pre-payment states only |
| D-51 | Two local processes with separate credential files | **APPROVED — architectural policy** | Separate local web and worker credentials. Local isolation is not proof of hosted isolation |
| D-52 | Make `payment_provider_observations.operation_id` NOT NULL, and the four refund provenance columns NOT NULL | **APPROVED — architectural policy** | Non-null evidence provenance references with database-enforced integrity (§2.15, §2.16) |
| D-53 | Server-controlled adapter selection and exact dispatch-authorization snapshot | **POLICY APPROVED — exact configuration PROPOSED, OWNER APPROVAL REQUIRED** | Owner-controlled, versioned adapter policies; explicit activation authority; fail-closed. Unapproved: environment names, the operation-type-to-contract mapping, and who holds activation authority. No policy is created or activated by this document |
| D-54 | Hosted secret scoping for web and worker runtimes | **DEPLOYMENT GATE** | Hosted credential isolation is mandatory before hosted deployment. Not a blocker for isolated local testing |
| D-55 | No direct web SELECT on owner-scoped and payment tables; owner-scoped read functions (§3.2, §3.5) | **APPROVED — architectural policy** | No direct web SELECT on owner-scoped or payment-sensitive tables; authenticated owner-scoped read functions (§3.2, §3.5) |
| D-56 | Finality governance: suite, evidence and review tables; who records, reviews and approves; whether reviewer and approver must differ; who may instruct `retire_finality_suite` (§7.7) | **APPROVED — with restrictions** | Schema only: suites, evidence, reviews and retirement. No finality approval, no reviewer staffing decision, no evidence or suite seeding, no retry enablement |
| D-57 | Consent trust boundary: accept that the web process is trusted to report genuine buyer confirmation, or require a separately trusted confirmation authority (§3.4) | **APPROVED — with restrictions** | The web process is accepted as the trusted buyer-consent collection boundary **for the local MVP only**. A nonce is not independent proof of a human gesture. A payment-capable consent authority, or a further owner decision, is required before any payment integration |

### 17.2 Differences from approved foundation behaviour

These are the ten differences from accepted Milestone 001 behaviour. The owner has approved all ten **for PostgreSQL mode only** (decision record, Group 6). **Milestone 001 Mock mode is unchanged by every row**: no Mock code path, default or test is altered, and Mock mode does not adopt any PostgreSQL-mode behaviour (D-15, D-49). The approval is of the architectural difference; exact schema definitions, limits and function signatures for each remain PROPOSED — OWNER APPROVAL REQUIRED.

| # | Subject | Milestone 001 | Proposed PostgreSQL behavior | Classification |
| --- | --- | --- | --- | --- |
| 1 | Ownership key | Session ID | Durable owner ID | APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |
| 2 | Quote digest | Canonical JSON including session ID | Database-computed `SAQD-1` | APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |
| 3 | Repeated confirmation views | Replace challenge; older tab must refresh | Reuse challenge; first tab to submit wins | APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |
| 4 | Confirmation nonce | Random per issue | Derived from a server key | APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |
| 5 | Dispatch | One call in the request | Buyer authorization, then worker claim | APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |
| 6 | Retry after explicit capture rejection | Allowed | Verified-finality requirement; refused until pinned finality is verified. **Retries remain disabled** (D-30, D-31) | APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |
| 7 | Refund ledger and later partial refunds | The reducer **already accepts** `REFUND_OBSERVED` from both `CAPTURED_VERIFIED` and `PARTIALLY_REFUNDED_OBSERVED` (`src/lib/payment/state-machine.ts`, post-capture rule). That is existing approved behaviour and is not changed. The mock orchestrator raises a partial-refund event only from `CAPTURED_VERIFIED` (`src/lib/payment/orchestrator.ts`), so a second partial refund is observed but raises no event. Refunds are tracked as one cumulative amount; there is no ledger | (a) A refund ledger with one row per distinct refund fact, de-duplicated by identifier or cumulative delta (§2.16, §9.9). (b) `ingest_post_capture_evidence` raises the existing `REFUND_OBSERVED` event for each **new** refund fact, including from `PARTIALLY_REFUNDED_OBSERVED`. (c) New refund facts after `REFUNDED_OBSERVED` or a reversal open a review entry with no transition. No reducer rule is added or changed | Reducer transition: **EXISTING APPROVED BEHAVIOUR, unchanged; not a new behaviour.** Items (a) to (c): APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |
| 8 | Order found with mismatched details | Operation `SUCCEEDED` | Operation `CONFLICT` | APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |
| 9 | Session cleanup | Deletes the session's checkout records | Deletes credentials only; durable checkout records survive, subject to retention (D-11, durations unapproved) | APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |
| 10 | Evidence, purchase groups, acknowledgments, adapter registry and roles | Not present | New persistent controls and workflows | APPROVED FOR POSTGRESQL MODE ONLY — Mock mode unchanged; exact schema unapproved |

### 17.3 Holds

| Item | Why it is held |
| --- | --- |
| Re-Audit 010 | Complete source now supplied at `~/Downloads/ShopAccess_AI_Codex_Reaudit_010_Full.txt`; the partially resolved finding is the evidence-integrity/shared-app-role authority issue. Correction 013 addresses it as a proposal in §1.1 and §2; this draft traces it in Appendix A. **No source-missing hold remains for Re-Audit 010.** |
| **SOURCE_MISSING: HOLD** — Codex Re-Audits 005 to 008 | Available only as owner-relayed summaries. Traceability for them is to the summaries, not to the audits |
| **SOURCE_MISSING: HOLD** — Specification v1.0 | Never supplied. Only Codex's review of it was seen |
| **SOURCE_MISSING: HOLD** — AUD-014 | Referred to as a future requirement; its text was never supplied |
| **ARTIFACT_NOT_RETAINED** — Codex Re-Audit 011 | The audit exists and its four findings were supplied: they reached this document's author in the conversation, as stated in Targeted Correction Directive 014. The findings were therefore available and were addressed. What is missing is a locally accessible copy: no Re-Audit 011 file is in the repository or beside the other audit packets, so Appendix A cites the directive, and the author did not compare the corrections against the full report text. This is a record-keeping gap, not a missing source. It closes when the report is saved where the earlier audits are |
| **ARTIFACT_NOT_RETAINED** — Codex Re-Audit 012 | Same position. AR012-001 to AR012-004 reached the author as stated in Targeted Correction Directive 015. No Re-Audit 012 file was found locally and the full report text was not inspected by the author |
| **RESOLVED** — D-44 and D-45 | Correction 013 once called these closed before any owner approval existed, and was corrected to OPEN. The owner has since approved both as architectural policy (§17.1). |
| **RESOLVED** — §17.2 differences | All ten are approved by the owner for PostgreSQL mode only. Mock mode is not to be changed. |

No Re-Audit 010 source-missing hold remains. Other holds above remain because their original documents were not supplied for this reconciliation. The ten differences are decided by the owner's record, not by this draft, and only for PostgreSQL mode.

### 17.4 Known limitations

1. **Nothing has been executed.** Design review is not verification.
2. A compromised worker or adapter can submit well-formed false evidence (§3.4).
3. A compromised web process can replay credentials of buyers it serves, and can confirm and authorize purchases for them without their gesture. The confirmation nonce does not prove a human action (§3.4, D-57).
4. Anonymous cross-session duplicate purchases are not prevented.
5. A "separate purchase" declaration cannot be verified.
6. Blocked groups, parked operations and review entries have no resolution path (D-12).
7. Conditions E-3 to E-5, G-2 in part and G-3 are enforced by function logic, not constraints, and are checked only by tests.
8. A large amount of payment logic exists twice, in TypeScript and in database functions; parity tests are the only guard against drift.
9. Totals-only refund evidence cannot count refunds that occur between two readbacks.
10. An operation whose pinned contract no running worker carries is left untouched and needs monitoring that does not exist.
11. No retention mechanism exists for immutable and append-only tables.
12. Local development cannot fully separate the two runtimes' credentials.
13. Mock mode implements none of the database controls.
14. Migration and operator credentials are a trust boundary outside the schema.
15. No hosted deployment configuration was inspected; service-scoped credential isolation is a deployment requirement, not a verified property.
16. Finality evidence is an attestation by named operators bound to a result record held outside the database. The database cannot verify that a test ran (§7.7).
17. The worker can read every owner's intents, quotes, authorizations and operations (§3.2). Read functions do not equalize response timing (§3.5).
18. Retry after a declined or rejected capture is unavailable for every adapter, including the mock, until D-30 and D-56 are decided and evidence exists.
19. **Unresolved and not approved:** as specified, suite retirement cannot recall a capture retry whose claim already committed (§7.7). Unreachable while retries are disabled; must be decided before any retry is enabled.
20. Typed operation references for intent pointers and transition citations are approved as policy (D-28); the key and CHECK definitions in §2.18 and §2.22 are proposals awaiting approval.
21. The consent boundary of §3.4 is accepted for the local MVP only (D-57). It is not accepted for payment integration.
23. Refused operator key requests write no audit row: only the two success event types are approved (§18.6).
24. Three existing tests and the legacy query module depend on the six legacy migration drafts; they cannot stay byte-for-byte unchanged once the sequence is replaced (§18.9).
22. In PostgreSQL mode no entry point escalates a checkout from `APPROVAL_CHECK_PENDING` to manual review, although the reducer permits it (§10.2).

### 17.5 Decision consolidation for owner review

**Status note.** This section was written before the owner's decisions. It is kept as the record of alternatives and consequences that the owner reviewed. Its statuses are superseded: the owner has since decided Groups 1 to 10, and **§17.1 governs** the status of every decision and §17.2 the ten differences (approved for PostgreSQL mode only; Mock mode unchanged). Where a row below says "recommended", read it as the option considered, not as a pending request, except where §17.6 lists it as still open. Two rows are overtaken outright: D-30 and D-31 are disabled, not gates awaiting approval; and part D's suggestion that Mock mode might adopt PostgreSQL behaviour (D-15, D-49) is withdrawn. "Blocks" means the initial PostgreSQL implementation cannot be written correctly without the decision. "Deferrable" means implementation can start with the safe default shown and the decision can be taken later.

**A. Blockers for initial implementation**

| ID | Recommended | Alternatives | Security consequence | Delivery consequence | Blocks | Deferrable |
| --- | --- | --- | --- | --- | --- | --- |
| D-44 | Separate `web` and `worker` roles | One application role | One role lets a buyer-facing defect claim, settle and forge evidence | Two processes, two credentials, a polling worker | Yes | No |
| D-45 | Secret, hashed claim credentials | Claim token built from readable fields | Readable tokens let a superseded worker or the web role forge a claim | One more table; a random source (D-48) | Yes | No |
| D-53 | Database policy selects the exact adapter contract; authorization stores the full snapshot | Adapter chosen by web or worker code | A caller-chosen adapter can route a payment to an unapproved contract | Policy table and owner-controlled activation function; owner must name who activates | Yes | No |
| D-55 | No direct web SELECT on owner-scoped or payment tables; three read functions | Keep broad SELECT and rely on application filtering; row-level security | Broad SELECT exposes every buyer's rows to any web query path | Three more functions; every page read goes through them | Yes | No |
| D-57 | Accept web-process consent trust for the mock-only milestone, stated as a limitation; decide a confirmation authority before real money | Require a confirmation authority now; accept the risk permanently | Compromised web process can confirm for buyers it serves; the nonce is not proof of a gesture | Accepting costs nothing now. A confirmation authority is a new design and its own milestone | Yes (the boundary must be chosen before the consent path is built) | The stronger mechanism is deferrable to the real-money gate; the choice is not |
| D-52 | NOT NULL on `operation_id` and the four refund provenance columns | Leave nullable and rely on function logic | Nullable components bypass F-8, F-12, F-13 and the type CHECKs | None found; every workflow supplies the values | Yes (append-only tables; cheap now, costly later) | No |
| D-48 | Built-in cryptographic random source if the chosen version has one; otherwise `pgcrypto` | Application-generated secret passed in | A weak or caller-supplied source weakens claim credentials | Depends on D-1; `pgcrypto` is an extension to authorize | Yes, with D-1 | No |
| D-1, D-2, D-3, D-5 | As §17.1 | As §17.1 | Unverifiable design without a database (D-2) | Nothing can be tested until decided | Yes | No |

**B. Gates that do not block initial implementation**

| ID | Recommended | Alternatives | Security consequence | Delivery consequence | Blocks | Deferrable |
| --- | --- | --- | --- | --- | --- | --- |
| D-30 | Do not approve now; approve only with accepted evidence under §7.7 | Approve on source inspection (not recommended) | Approving without proof permits a retry that could become a second capture | Until approved, a buyer whose capture was declined cannot retry in the same purchase group | No | Yes; default is retry disabled |
| D-56 | Adopt suite, evidence and review tables; recorder distinct from reviewer and approver | Also require reviewer ≠ approver; a single approver with evidence only | Fewer distinct people means weaker assurance that the evidence is real | Needs at least two operator logins; a conformance suite must be written | Tables: yes (schema shape). Staffing choice: no | Staffing choice deferrable until the first approval is wanted |
| D-54 | Separate service-scoped secrets, effective-scope inspection | Shared environment group (not recommended) | Shared scope gives web the worker credential and defeats D-44 | Deployment configuration work and an acceptance check | No (local work can proceed) | Yes, until hosted deployment; it blocks that gate |
| D-31 | Mock records rejected request IDs | Leave as is | Without it a rejected request could later capture | Small mock change, Milestone 001 code | No | Yes; default is no retry after rejection |

**C. The ten differences from the approved foundation (§17.2)**

Each is now approved by the owner for PostgreSQL mode only (§17.2). The column "Blocks" refers to the PostgreSQL behaviour. Mock mode is not changed to match in any row.

| # | Subject | Recommended | Alternative | Security consequence | Delivery consequence | Blocks | Related |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Ownership key | Durable owner ID | Session ID | Session-keyed ownership loses checkouts at expiry or binds payment to a credential | New table and prefix | Yes | D-5 |
| 2 | Quote digest | Database-computed `SAQD-1` | Application digest | An application digest is not verified by the database | Second encoding to keep in parity | Yes | D-49 |
| 3 | Repeated confirmation views | Reuse the challenge | Replace per view | Replacement invalidates other tabs; no security gain | Read function and renewal margin | Yes | D-6, D-15 |
| 4 | Confirmation nonce | Derived from a server key | Random, stored | Derived nonce needs no stored secret; neither proves a gesture (D-57) | A nonce key and its rotation | Yes | D-16, D-57 |
| 5 | Dispatch | Buyer authorization, then worker claim | One call in the request | Single-step dispatch needs one role with both authorities | Worker process and polling delay | Yes | D-44, D-47, D-53 |
| 6 | Retry after explicit capture rejection | Refused until pinned finality is verified | Allow as the mock does | Allowing it risks a second capture | Buyers cannot retry until D-30/D-31 | Yes (the refusal is the default) | D-30, D-31, D-56 |
| 7 | Refund ledger and later partial refunds. The reducer transition from `PARTIALLY_REFUNDED_OBSERVED` already exists and is not a proposal | Add the ledger; raise the existing `REFUND_OBSERVED` for each new refund fact; review entry for refunds after a final refund state | Keep one cumulative amount and raise nothing for later partial refunds, as the mock orchestrator does | Without the ledger, later and repeated refunds cannot be told apart or seen in history | Ledger table, its trigger and planning logic | Yes (ledger and ingestion behaviour only) | D-23, D-25 |
| 8 | Order found with mismatched details | Operation `CONFLICT` | `SUCCEEDED` | `SUCCEEDED` would accept an order that does not match the quote | Review entries with no resolution path (D-12) | Yes | D-12 |
| 9 | Session cleanup | Delete credentials only | Delete the session's checkout records | Deleting records destroys payment history | Retention is undecided (D-11) | Yes | D-11 |
| 10 | Evidence, purchase groups, acknowledgments, registry, roles | Adopt | Omit | Omitting removes the duplicate-payment and authority controls | Most of the schema | Yes | D-32, D-33, D-36, D-39, D-40/D-43 |

**D. Optional configuration (safe defaults exist; none blocks)**

D-4, D-6, D-7, D-8, D-9, D-10, D-11, D-13, D-15, D-16, D-18 to D-29, D-33 to D-35, D-37, D-38, D-41, D-42, D-46, D-47, D-49 to D-51. D-12 stays deferred. D-17 stays closed: automatic capture resend is disabled. D-14 and the source holds of §17.3 are unchanged.

### 17.6 Remaining owner-approval register

What is still undecided after the owner's record for Groups 1 to 10. Nothing here is approved, and nothing in Groups 1 to 10 is asked again. For the Increment 2.1 objects, the schema, function signatures and grants are approved for design in §19 (G2-02, G2-07); the rows below stand for every later increment.

**1. Blocks final schema approval**

| Item | Open question |
| --- | --- |
| Exact schema | Every table, column, key, CHECK and trigger definition in §2, including the typed references of D-28 and the finality schema of D-56 |
| Function signatures | Names, arguments, results and refusal codes of every function in §3.3 and §3.5 |
| Grants in detail | The matrices of §3.2 and §3.3 as written, within the approved role policy |
| Values held in the schema | D-6 ceiling; D-13; D-25. (Session admission limits, the idle timeout, the intents-per-group limit (G2-14), the quote lifetime (G2-12) and the owner call limit (G2-34) are approved) |
| D-38 implementation | None remaining for Increment 2: counting by query is approved for design (§19.9). (The limit of 10 and the classification are approved) |
| Typed keys | Exact data types, DEFAULT and CHECK wording and constraint definitions for F-10T, F-6T and F-7T. (Columns, pairing, discriminators and the non-deferrable preference are approved) |
| Draft expiry | Exact column definition of `created_at`, how the value is held, and the refusal's name. (24 hours from original creation, the strict boundary and the pre-worker refusal are approved) |
| One-shot guard | Guard data structure; eviction of consumed order-create entries. (Single-threaded worker and non-evictable capture entries are approved) |
| D-53 | Environment names; operation-type-to-contract mapping; who holds activation authority |
| D-21 | Nothing further: names and entry syntax are approved (§18.5) |
| D-48 details | Helper name and the schema `pgcrypto` is created in |

**2. Blocks migration-writing authorization**

| Item | Open question |
| --- | --- |
| Final schema approval | Group 1 above |
| D-3 | Nothing further for Increment 1: archived under Gate B-W (§14) |
| Code-writing authorization | Granted for Increment 1 only (Gate B-W) and exercised (§18.11). Not granted for any later increment |
| Statement catalogue location | Where the PostgreSQL library's parameterized statements live in production (§18.11). Needed before Increment 2 wires the library into the application |

**3. Blocks local database execution**

| Item | Open question |
| --- | --- |
| Execution authorization | Installing, starting or connecting to a local PostgreSQL 17, enabling `pgcrypto`, applying migrations, running tests: none authorized |
| Runtime values | Every value in §17.7 not held in the schema |
| D-19 | Nothing further: the mechanism is approved (§18.8) |
| D-11 | Challenge-cleanup duration, if cleanup is to run |

**4. Blocks payment integration**

| Item | Open question |
| --- | --- |
| D-57 | A payment-capable consent authority, or a further owner decision, beyond the local-MVP limitation |
| D-30, D-31 | Any retry enablement |
| D-56 | Finality approval, reviewer staffing, suite and evidence seeding |
| §7.7 residual | In-flight retry after suite retirement; unresolved and unapproved |
| D-12 | A manual-review resolution workflow |
| §16 | Provider-evidence authentication and every PayPal item. No provider behaviour is assumed |

**5. Blocks hosted deployment**

| Item | Open question |
| --- | --- |
| D-54 | Service-scoped credential isolation, verified |
| D-11 | Retention durations and a designed, authorized history-deletion mechanism |
| §16 | Managed database, backups, migration reversal procedure, monitoring |

**Not blocking:** the historical source holds of §17.3 and D-14; the contract-version consequence of suite retirement (§7.7), deferred with retry enablement.

### 17.7 Configuration approval schedule

**Owner-approved values (local MVP).** These fourteen are no longer proposals: the nine Increment 1 settings approved at Gate A, the purchase-group limit, the draft expiry, and the three Increment 2 values (G2-12, G2-14, G2-34). How each is held in the schema remains subject to exact-schema approval.

| Decision | Setting | Approved value | Rule | Test |
| --- | --- | --- | --- | --- |
| D-4, §4.5 | Maximum live sessions | **500** | Counted by the liveness rule under the guard lock | PGT-01, 03 |
| D-4, §4.5 | Admissions per minute | **30** | A capacity refusal consumes the budget; a rate refusal does not | PGT-02, 03 |
| D-24, §2.5 | Session idle timeout | **2 hours** | Trigger constant equals the application constant | PGT-06, 54a |
| D-24, §2.5 | Absolute session lifetime | **24 hours** | From `created_at`; immutable | PGT-06, 69d |
| D-7, §4.5 | Session touch threshold | **60 seconds** | Limits session-row writes | PGT-06, 87 |
| D-8, §13.1 | `lock_timeout` | **2 seconds** | Below `statement_timeout` | PGT-49 |
| D-8, §13.1 | `statement_timeout` | **5 seconds** | Above `lock_timeout`; below the idle limit | PGT-49 |
| D-8, §13.1 | `idle_in_transaction_session_timeout` | **10 seconds** | No provider call is made inside a transaction | PGT-23 |
| D-8, §13.1 | Database-only transaction re-runs | **Maximum 3** | Never causes an additional payment-provider call | PGT-48, 67o |
| D-38, §6.6 | Active or unresolved purchase groups per shopper | **10** | Not a lifetime limit; resolved history not counted; refuse new groups at capacity; delete, overwrite and recycle nothing | PGT-81a to e |
| §8.10 | Draft expiry | **24 hours from original `created_at`** | Live only while `t < created_at + 24 hours`; clock never reset; `start_checkout` refuses an expired draft before the worker runs; `DRAFT` only | PGT-83a to f |
| G2-12, §19.8 | Quote lifetime | **15 minutes** | `expires_at = created_at + 15 minutes`; never extended. A PostgreSQL-mode approval, separate from the Mock's equal value | PGT-119 |
| G2-14, §19.9 | Intents per purchase group | **10** | Every intent of the group counts; refuse at capacity; delete nothing | PGT-122 |
| G2-34, §19.7 | Mutating calls per owner | **30 per 60 seconds** | Fixed window; one counter per owner, shared by all mutating functions | PGT-124 to 128 |

**Every value in the table below is PROPOSED — OWNER APPROVAL REQUIRED.** The policies behind them are approved (§17.1); none of these numbers is. None authorizes a payment-capture retry or resend. Where no test identifier is given, a specific test must be named before the value is approved.

| Decision | Setting | Proposed value | Controls | Constraint | Test |
| --- | --- | --- | --- | --- | --- |
| D-26, §7.3 | Worker lease | 30 seconds | How long a worker owns an operation | Above call timeout plus safety margin | §15.5 |
| D-26, §7.3 | Provider-call timeout | 10 seconds | Deadline after which the worker must not send | Below the lease | PGT-66 |
| D-26, §12.4 | Safety margin | 5 seconds | Wait after the deadline before an order-create resend | Order-create only | §15.5 |
| D-18, §12.4 | Attempts per operation | 3 | Order-create attempts under one request ID | A capture is sent at most once | §15.5 |
| D-20, §7.3 | Recovery backoff | 30 s, 1 min, 2 min, then 5 min | Spacing of readback polls | — | §15.5 |
| D-20 | Escalation age | 60 minutes | When an unresolved operation is parked for review | Above the longest backoff | §15.5 |
| D-22, §12.3 | Recovery poll interval | 5 seconds | How often the worker looks for work | Far below the authorization lifetime | PGT-76g |
| D-47, §8.1 | Dispatch-authorization lifetime | 120 seconds | Window in which a worker may claim | Above the poll interval; the claim re-checks quote expiry | PGT-76b |
| D-6, §5.4 | Challenge renewal margin | 60 seconds | Minimum remaining life for reuse | Below the confirmation lifetime | §15.2 |
| D-6, §5.5 | Challenges per quote | 8 | Structural ceiling on renewals | — | §15.2 |
| D-13, §8.9 | Quarantine cap per operation | 20 | Bounds stale-evidence storage | — | §15.4 |
| D-25, §9.9 | Refund entries per evidence | 50 | Bounds one ingestion | — | §15.4 |
| D-11, §14 | Challenge cleanup | 24 hours after quote expiry | Removal of dead challenges | Never a consumed challenge. Proposal only; not approved for execution | §15.2 |
| §5 | Confirmation lifetime | 5 minutes capped at quote expiry | Challenge expiry | Mock-mode value; unapproved for PostgreSQL mode (G2-13, PROPOSED) | §15.2 |

**Excluded:** the 30-day Sandbox payment-history deletion. It is not approved, not designed, and not part of any proposed scope (§14).

**Still open, no approved value:** D-53 environment names, mapping and activation authority. Every value remaining in the table above belongs to Increment 2 or 3 and is unapproved.

---

## 18. Increment 1 — Gate A contract (owner-approved design; implementation recorded in §18.11 to §18.14, execution in §18.15)

**Status.** The owner approved these Increment 1 design decisions at Gate A. This section records them. **Gate B-W (writing) was authorized for Increment 1 and has been carried out; the record is §18.11. Gate B-X (execution) was not authorized when §18.11 to §18.14 were written. It was later authorized by the owner, twice, each time for one run on a disposable cluster, and carried out; the record is §18.15.** Outside those two runs there has been no PostgreSQL installation or start, no SQL execution, no migration run, no database connection and no database integration test. Where an earlier section differs for an Increment 1 object, this section governs. Items still marked PROPOSED — OWNER APPROVAL REQUIRED are not approved.

### 18.1 Scope

**Nine physical tables**

| # | Table | Defined in | Migration file (§14) |
| --- | --- | --- | --- |
| 1 | `schema_migrations` | §2.1 | `0001_migration_ledger.sql` |
| 2 | `session_admission_guard` | §2.2 | `0002_keys_owners_sessions.sql` |
| 3 | `server_key_versions` | §2.3 | `0002_keys_owners_sessions.sql` |
| 4 | `checkout_owners` | §2.4 | `0002_keys_owners_sessions.sql` |
| 5 | `shopper_sessions` | §2.5 | `0002_keys_owners_sessions.sql` |
| 6 | `merchants` | §2.6 | `0003`; rows in `0004` |
| 7 | `merchant_products` | §2.6 | `0003`; rows in `0004` |
| 8 | `merchant_variants` | §2.6 | `0003`; rows in `0004` |
| 9 | `audit_events` | §2.21 | `0005_audit_events.sql` |

`database_environment` and every other table belong to later increments.

**Six trusted entry-point functions:** `admit_session`, `authorize_session`, `rotate_session`, `revoke_session`, `activate_key_version`, `revoke_key_version`. `append_web_audit` is **not** in Increment 1.

**Not in Increment 1:** checkout, quotes, challenges, purchase groups, any payment table or function, the worker's behaviour, the `pgcrypto` extension, adapter policies, the finality schema. No payment-provider operation belongs to Increment 1.

### 18.2 Schema integrity rules added at Gate A

| Table | Rule |
| --- | --- |
| `schema_migrations` | `version` matches four digits, an underscore and a lowercase name of letters, digits and underscores; `checksum` is 64 lowercase hexadecimal characters |
| `server_key_versions` | `check_value` is 64 lowercase hexadecimal characters; `revoked_at` is set exactly when `status` is `REVOKED` |
| `checkout_owners` | `id` matches `own_` plus 32 lowercase hexadecimal characters; generated in the database (§2.4) |
| `shopper_sessions` | `row_version` rises by exactly one per accepted update (§2.5) |
| Catalog tables | Unchanged from the legacy draft. No fixture revision in a CHECK; no new restriction on descriptions, `specs` or revisions (§2.6) |
| `audit_events` | As §2.21, including `owner_id` |

Exact data types follow §2. The complete column-by-column definitions were reviewed at Gate A; the wording of each constraint is fixed when the migrations are written under Gate B.

### 18.3 Function contracts

Common rules:

- Schema `shopaccess_api`; owner `shopaccess_definer`; `SECURITY DEFINER`; fixed search path `pg_catalog, pg_temp`; every object reference schema-qualified; no dynamic SQL; EXECUTE revoked from PUBLIC.
- All six need `SECURITY DEFINER`: the web role has no privilege on sessions, owners or the guard, and the operator has no write privilege on key versions or audit. Trigger functions and internal helpers do not use it; helpers are executable only by the function owner.
- Each returns exactly one row. `result` is `text`. An expected refusal is a result code, never an error. Errors are raised only for defects, deadlocks and lock timeouts; the caller may then re-run the whole database transaction at most 3 times.
- The decision time is the database clock read after the last blocking lock (§13.2). No function has a time parameter. No function commits.

| Function | Role | Parameters | Return columns |
| --- | --- | --- | --- |
| `admit_session` | web | `session_id text`, `key_version smallint`, `token_digest text` | `result text`, `absolute_expires_at timestamptz`, `idle_expires_at timestamptz` |
| `authorize_session` | web | `key_version smallint`, `token_digest text` | `result text`, `session_id text`, `absolute_expires_at timestamptz`, `idle_expires_at timestamptz`, `key_status text` |
| `rotate_session` | web | `key_version smallint`, `token_digest text`, `new_key_version smallint`, `new_token_digest text` | `result text`, `session_id text`, `absolute_expires_at timestamptz`, `idle_expires_at timestamptz` (`session_id` added by §18.12, correction 8) |
| `revoke_session` | web | `key_version smallint`, `token_digest text` | `result text` |
| `activate_key_version` | operator | `purpose text`, `key_version smallint`, `check_value text` | `result text`, `previous_active_version smallint` |
| `revoke_key_version` | operator | `purpose text`, `key_version smallint` | `result text`, `sessions_revoked integer`, `was_active boolean` |

| Function | Locks, in order | Result codes | Tests |
| --- | --- | --- | --- |
| `admit_session` | Guard row for update; key-version row shared; then removal of dead sessions, skipping locked rows; then a count of every remaining row (§4.5) | `ADMITTED`; `RATE_LIMITED` (budget not consumed); `AT_CAPACITY` (budget consumed); `KEY_NOT_ACTIVE`; `REFUSED` (identifier or digest collision) | PGT-01 to 05, 54f, 56 |
| `authorize_session` | Session row | `AUTHORIZED`; `NOT_AUTHORIZED` (one code for unknown, revoked, idle, expired, or non-accepted key). Writes nothing on refusal | PGT-06, 54a, 69d, 87; capacity/touch race |
| `rotate_session` | Active key row shared; then session row | `ROTATED`; `NOT_AUTHORIZED`; `KEY_NOT_ACTIVE` | PGT-64, 86, 87 |
| `revoke_session` | Session row | `DONE` in every case, so the call is not an oracle | PGT-07, 87 |
| `activate_key_version` | Guard row; key rows of the purpose | `ACTIVATED`; `VERSION_NOT_HIGHER`; `BAD_CHECK_VALUE`; `BAD_PURPOSE` | PGT-64, 86, 89 |
| `revoke_key_version` | Guard row; key row; sessions of that version | `REVOKED`; `ALREADY_REVOKED`; `UNKNOWN_VERSION`; `BAD_PURPOSE` | PGT-64, 86, 89 |

Behaviour:

- `admit_session` generates the owner ID in the database and returns neither it nor the session ID.
- `rotate_session` returns the ID of the session row it rotated. The PostgreSQL session service uses that ID and never one taken from a caller-supplied object.
- `authorize_session` returns the session ID because the existing session type and audit calls use it. `key_status` is `ACTIVE` or `VERIFY_ONLY`.
- `activate_key_version` inserts the new version as `ACTIVE` and moves the previous active version, if any, to `VERIFY_ONLY` in the same transaction.
- `revoke_key_version` may revoke the `ACTIVE` version (emergency revocation). It marks that version's sessions revoked in the same transaction.
- Compared with the Mock session service: PostgreSQL mode reports one generic rejection where Mock reports specific reasons; revocation takes the presented credential, not a session ID; cleanup happens inside admission. A **separate PostgreSQL session service** sits beside the existing one. Mock code and behaviour are unchanged, and PostgreSQL mode is opt-in.

### 18.4 Roles, schemas and grants

| Role | Login | `shopaccess` (tables) | `shopaccess_api` (functions) |
| --- | --- | --- | --- |
| `shopaccess_owner` (migration) | Migration time only | Owner | Owner of the schema, not of the entry-point functions |
| `shopaccess_definer` | Never | USAGE; the table privileges below | USAGE; CREATE only while a migration creates functions |
| `shopaccess_web` | Yes | USAGE; SELECT on the three catalog tables and `server_key_versions` | USAGE; EXECUTE on the four session functions |
| `shopaccess_operator` (group; one named login each) | Named logins | USAGE; SELECT on `server_key_versions` and `audit_events` | USAGE; EXECUTE on the two key functions |
| `shopaccess_worker` | Yes | **None** | **None** |
| PUBLIC | — | None | None |

Function owner's table privileges in Increment 1:

| Table | Privileges |
| --- | --- |
| `session_admission_guard` | SELECT, UPDATE |
| `server_key_versions` | SELECT, INSERT, UPDATE |
| `checkout_owners` | SELECT, INSERT |
| `shopper_sessions` | SELECT, INSERT, UPDATE, DELETE |
| `audit_events` | INSERT |
| Catalog tables | None in Increment 1. SELECT from Increment 2 (§19.13) |
| `schema_migrations` | None |

Rules:

- No runtime role has INSERT, UPDATE, DELETE or TRUNCATE on any table.
- Migration credentials are never present in a runtime configuration.
- The worker has no schema, table or function grant in Increment 1. Its catalog access is decided in the increment that implements worker behaviour.
- Runtime roles are members of no role, have no CREATE anywhere and cannot create temporary objects.
- The function owner has no TRUNCATE, no DDL right and owns no table.

**Migration-time setup sequence** (described, not executable):

1. A database administrator creates the roles. The only membership is that the migration role may switch to the function owner; no runtime role is a member of anything. The bootstrap file refuses to run if any of the five roles or either schema already exists: an existing role is never adopted (§18.13, correction 1).
2. All privileges on the database and both schemas are revoked from PUBLIC, including the right to create temporary objects.
3. Both schemas are created, owned by the migration role. Default privileges are set so that new tables and functions carry no PUBLIC grant.
4. Tables are created in `shopaccess`. The function owner is given USAGE on that schema and exactly the table privileges above.
5. The function owner is given CREATE on `shopaccess_api`; the six functions and their helpers are created with the function owner as owner; EXECUTE is revoked from PUBLIC and granted per the table above.
6. CREATE on `shopaccess_api` is revoked from the function owner again, so that at runtime it can create nothing.
7. A catalog audit (PGT-88) confirms the result before any runtime role is used.

### 18.5 Key ring (D-21)

**Check value (owner-approved).**

| Element | Value |
| --- | --- |
| Algorithm | HMAC-SHA-256 |
| Key | The configured key bytes of that version |
| Message | UTF-8 bytes of `shopaccess.keycheck.v1`, then one zero byte, then the UTF-8 purpose name |
| Purposes | `session`, `confirmation_nonce` |
| Stored form | The 32-byte digest as 64 lowercase hexadecimal characters |

This is the existing keyed-digest construction **[APPROVED-M1: `src/lib/shared/crypto.ts`]** under a new label, distinct from the two labels already in use.

**Rules (owner-approved).**

- No raw key material is stored in PostgreSQL. Key material is never logged, returned or audited. Errors name the purpose and version only.
- Identical key bytes must not appear in both purpose rings; startup refuses.
- States: `ACTIVE`, `VERIFY_ONLY`, `REVOKED` in the database; **staged** means configured in the ring with no database row.
- The database-designated `ACTIVE` version decides admission eligibility. It need not be the highest configured version.
- Startup in PostgreSQL mode: the `ACTIVE` version must be in the ring with a matching check value, otherwise the process refuses to start in that mode. Any configured version whose check value does not match its row: refuse. A `REVOKED` version's key is ignored. A version with no row is staged and unused.
- Normal rotation: add the new version to the ring and restart (nothing changes); an operator activates it; processes use the new active version from their next read; later the old version is revoked and then removed from the ring.
- A process holding a stale idea of the active version gets `KEY_NOT_ACTIVE` from `admit_session` or `rotate_session`, re-reads once, and otherwise refuses.
- Emergency revocation: an operator revokes the `ACTIVE` version. Its sessions are revoked in the same transaction and no admission or rotation succeeds until a higher version is activated.
- Activation and revocation are operator-only. The check value is computed by the operator from the key outside the database and is not secret.
- Mock mode keeps its existing single key and behaviour unchanged.

**Configuration (owner-approved).** The rings are read from `SHOPACCESS_SESSION_KEYS` and `SHOPACCESS_NONCE_KEYS`, by the web process only. Each is a comma-separated list of `version:base64key` entries, strictly parsed: a version from 1 to 32767 written in decimal with no sign and no leading zero; standard, canonical, padded base64; at least 32 decoded key bytes per entry. Whitespace, an empty entry, a duplicate version, a malformed version, a non-canonical encoding or a short key is an error, and any error means no ring: there is no default and no partial ring. Errors name the variable and the version, never the key.

### 18.6 Audit events in Increment 1

- The `audit_events` table exists. **`append_web_audit` is deferred until an approved web-originated event exists that no entry point owns (G2-09). It is not created in Increment 2. No audit obligation is waived (§19.10)**; no web audit function exists in Increment 1, with or without an allowlist. The existing web checkout audit events (`QUOTE_ISSUED`, `CONFIRMATION_ACCEPTED`, `CONFIRMATION_REJECTED`, `SIMULATION_STEP` **[APPROVED-M1: `src/server/handlers.ts`]**) and `CAPTURE_EVIDENCE_REJECTED` **[APPROVED-M1: `src/lib/payment/orchestrator.ts`]** are outside Increment 1. The four session functions write no audit row, as the existing application writes no session audit event.
- Exactly two event types are written, each inside its operator function and in the same transaction as the change:

| Event type | Written when | Detail |
| --- | --- | --- |
| `KEY_VERSION_ACTIVATED` | `activate_key_version` returns `ACTIVATED` | Purpose; version; previous active version; operator login name |
| `KEY_VERSION_REVOKED` | `revoke_key_version` returns `REVOKED` | Purpose; version; whether it was active; number of sessions revoked; operator login name |

- **Refusals and repeats write nothing.** `VERSION_NOT_HIGHER`, `BAD_CHECK_VALUE`, `BAD_PURPOSE`, `UNKNOWN_VERSION` and `ALREADY_REVOKED` produce no audit row, so a failed or repeated request can never appear as a success. A rolled-back transaction leaves no row. The consequence, that refused operator attempts are not audited, is a stated limitation (§17.4).
- The event identifier is generated in the database. Actor is `operator`. Session, owner, intent and operation columns are NULL.
- No audit row contains key bytes, a check value, a token, a token digest or any other credential material.

### 18.7 PostgreSQL-mode session cookie

Cookie name and attributes are unchanged **[APPROVED-M1: `src/lib/session/cookie.ts`]**. In PostgreSQL mode only, the value is `version.token`.

| Part | Rule |
| --- | --- |
| Whole value | Exactly one dot, separating two non-empty parts; no whitespace; the cookie present exactly once in the header |
| `version` | Decimal digits only, first digit 1 to 9, at most five digits, value 1 to 32767. No sign, no leading zero |
| `token` | The existing 43-character base64url token pattern |

Handling:

1. Any value that does not match exactly, including a Mock-format value with no dot, is treated as no session. No database call is made.
2. The version is a non-secret routing hint. It selects which configured key to use; it proves nothing.
3. If the version is not in the ring, is staged, or is `REVOKED`: no session. No other version is tried.
4. Otherwise the token digest is computed under that version's key and `authorize_session(version, digest)` is called once. `NOT_AUTHORIZED` means no session. There is never a second attempt under another version.
5. Authority comes only from the database's session record and its liveness rule.
6. A session under a `VERIFY_ONLY` version is accepted and may be rotated to the `ACTIVE` version; the new cookie then carries the new version.
7. The CSRF token is derived with the same version's key.

This lets staged rotation and verification-only keys work with one database call per request. The Mock cookie format (token only) is unchanged.

### 18.8 Deterministic test clock (D-19)

- A disposable test database may contain fixture rows inserted already backdated. Existing rows are not rewritten: `created_at` is immutable and the session update trigger permits only its three shapes.
- Internal liveness and expiry helpers take the row values and an explicit time. Tests call them directly to check exact boundaries. They are executable only by the function owner and, in the test database, by the test owner.
- Every production entry point passes the authoritative database clock. No web, worker or operator function accepts a caller-controlled time, and no session setting can change the decision time.
- Test-owner access does not exist in runtime environments.
- Lock-ordering and wait-past-expiry cases use lock barriers and polling of the database clock, without sleeps.
- Tests cover each exact boundary (just before, exactly at, just after) and the relevant lock orders (PGT-06, 54a, 54f, 83, 90).

### 18.9 Legacy drafts, legacy query module and existing tests

Under Gate B-W the owner authorized archiving the six legacy drafts, writing the replacement migrations, and one narrowly specified change to a legacy-bound test. The legacy query module is preserved untouched, and running database tests remains unauthorized. What was done is recorded after the table.

| Item | Location | Dependency |
| --- | --- | --- |
| Static migration checks | `tests/unit/environment.test.ts`, the "migration files" group | Read the six files in `db/migrations` |
| MIG-01 | Same file | Applies the six drafts and uses the legacy query strings; currently skipped without a test database |
| SQL-01 | Same file | Exercises the legacy query module |
| Legacy query module | `src/lib/db/queries.ts` | A never-executed session store and queries that write tables directly, which the approved model forbids |

- These tests **cannot remain byte-for-byte unchanged** once the migration sequence is replaced or the drafts are archived. The statement elsewhere that the existing suite passes "unchanged" means its Mock behaviour and coverage are preserved, not that these files are untouched.
- Their intended coverage is kept: parameterized queries only, static migration hygiene, and migration constraints applied to a real local database. Each needs a controlled update, reviewed and authorized at Gate B.
- The legacy query module stays isolated: the proposed PostgreSQL runtime does not import or call it until it is separately reviewed and authorized.

**Done under Gate B-W.**

- The six drafts were moved, unchanged, to `db/migrations/archive/milestone-001-unexecuted/`.
- `tests/unit/environment.test.ts` was changed in exactly one line: its migrations-directory constant now names the archive folder. With that, the static migration checks keep verifying the legacy drafts, MIG-01 still targets them together with the legacy query strings and is still skipped, and SQL-01 needed no change. Their coverage of the legacy material is therefore preserved exactly.
- MIG-01 reads `SHOPACCESS_TEST_DATABASE_URL`; the new database tests read `SHOPACCESS_PG_TEST_ADMIN_URL`. Configuring the new tests never causes the archived drafts to be executed.
- Coverage of the new sequence comes from new test files, not from rewriting the legacy tests (§18.11).
- `src/lib/db/queries.ts` was not edited and nothing under `src/lib/pg` imports it.

### 18.10 Gate status

| Gate | Status |
| --- | --- |
| Gate A (design) | Approved |
| Gate B-W (write code, migrations, tests and documentation for Increment 1; archive the legacy drafts; run typecheck, lint and database-free unit tests) | **Authorized and carried out** (§18.11) |
| Gate B-W targeted corrections after the independent audit (verdict FAIL): limited to the files named in the owner's correction authorization | **Authorized and carried out** (§18.12) |
| Gate B-W final hardening after the re-audit (verdict CONDITIONAL PASS): five corrections in named files | **Authorized and carried out** (§18.13). A further independent review is required before Gate B-X is considered |
| Gate B-W two-issue closure after the third audit (verdict CONDITIONAL PASS): four test files and documentation | **Authorized and carried out** (§18.14). A final focused independent verification is recommended before Gate B-X is considered |
| Gate B-X, first execution: one run of the seven database test files on a new disposable PostgreSQL 17 cluster | **Authorized and carried out** (§18.15): 38 passed, 3 failed, all three from test defects |
| Test-only remediation of PGT-04 and PGT-50 in two test files | **Authorized and carried out** (§18.15) |
| Gate B-X, second execution: one run on a second new disposable cluster | **Authorized and carried out** (§18.15): 41 passed, 0 failed, 0 skipped |
| Any further database execution, including a third run | **Not authorized** |
| Formal owner acceptance of Increment 1 | **Given by the project owner**, after the evidence of §18.15 was recorded. The accepted baseline is unchanged |
| Wiring the PostgreSQL library into the running application | Not authorized; deferred to Increment 2, which is itself not authorized |

### 18.11 Gate B-W implementation record

**Read with §18.12.** An independent audit of what this section describes returned **FAIL**. This section is kept as the record of the first implementation; where §18.12 differs, §18.12 governs. In particular the file list, the disposable-database rule and the statement-catalogue issue below are superseded.

**Nothing in this section has been executed against a database.** Every SQL file was written without being parsed or run by PostgreSQL, and every database integration test was written without being run. Design review and static tests are not verification.

**Owner decisions applied at Gate B-W.** Key-ring variable names and entry syntax (§18.5); archive destination (§14); Increment 1 delivered as an independently testable library, **not wired into the running application**; contiguous migration files `0001` to `0006` (§14); `SHOPACCESS_PG_TEST_ADMIN_URL` for the disposable-database test harness; legacy query module and Mock behaviour preserved.

**What exists.**

| Area | Files |
| --- | --- |
| Bootstrap | `db/bootstrap/0000_roles_and_schemas.sql` |
| Migrations | `db/migrations/0001` to `0006` (§14) |
| Archive | `db/migrations/archive/milestone-001-unexecuted/` with the six drafts and a README holding their checksums |
| Library, under `src/lib/pg/` | `client.ts` (approved timeouts; at most 3 database-only re-runs), `key-ring.ts`, `session-cookie.ts`, `session-service.ts`, `migrate.ts` |
| Database tests (never run) | `vitest.db.config.mts`; `tests/db/harness.ts`; `tests/db/migrations.test.ts`, `privileges.test.ts`, `sessions.test.ts`, `keys.test.ts`, `catalog.test.ts`, `clock.test.ts` |
| Database-free tests (run) | `tests/unit/pg-session-cookie.test.ts`, `pg-key-ring.test.ts`, `pg-static.test.ts` |

**Not wired in.** Nothing in `src/server`, `src/app` or any other existing module imports `src/lib/pg`; a unit test asserts this. The application runs on the in-memory Mock exactly as before. `npm test` loads no database test: those have their own configuration file.

**Disposable-database rule for the harness (superseded by §18.12, correction 3).** Loopback is necessary and never sufficient. The harness uses a server only if all of these hold: loopback host; the admin URL names the `postgres` maintenance database; the server was started with `cluster_name` set to `shopaccess-disposable-test`; it is PostgreSQL 17; the connecting role is a superuser; the cluster contains no database other than the built-in ones and databases the harness itself created; and no role other than the connecting superuser, predefined roles, the five ShopAccess roles and test logins. It then creates and uses only its own `shopaccess_disposable_…` database and drops only that.

**Open issue: where the statement catalogue lives (closed by §18.12, correction 9).** Milestone 001's SQL-01 test requires that no module under `src` other than the legacy query module contains SQL text, and that test may not be changed beyond its one-line path edit. The library therefore contains no SQL text: it receives its parameterized statements through two small interfaces, and the statements themselves are defined, provisionally, in `tests/db/harness.ts`. This satisfies the rule honestly but leaves production without a statement catalogue. Before Increment 2 wires the library in, the owner must choose one of: a second reviewed SQL module under `src` with a matching one-line allowance in SQL-01; statement files under `db/`; or another arrangement. Nothing was done to evade the test.

**Other things to know before Gate B-X.**

- The SQL has never been parsed. Syntax or semantic errors are to be expected and are found only by execution.
- `admit_session` leaves an owner row behind when its session is later cleaned up; no owner deletion is approved or implemented.
- A refused admission caused by an identifier collision has consumed admission budget.
- Refused operator key requests write no audit row (§18.6).
- The bootstrap file revokes all PUBLIC privileges on the database it is run in and on that database's `public` schema; it assumes a database dedicated to ShopAccess.
- The bootstrap creates roles without login rights or credentials. Enabling logins is an administrator step outside the repository; the test harness does it with credentials generated per run.

**Gate B-X plan (not authorized).**

1. Install PostgreSQL 17 locally, or obtain a PostgreSQL 17 container image.
2. Initialize a new, empty cluster in its own data directory, listening on loopback only on a non-default port, started with `cluster_name=shopaccess-disposable-test`.
3. Set `SHOPACCESS_PG_TEST_ADMIN_URL` to that cluster's superuser and its `postgres` database, for the test command only.
4. Run the database tests with the separate configuration (`vitest.db.config.mts`). The harness verifies the cluster, creates a disposable database per test file, runs the bootstrap file as administrator, applies `0001` to `0006` as the migration role, runs the tests and drops the database.
5. Fix whatever execution reveals, under whatever write authorization then applies, and repeat.
6. Stop the cluster and delete its data directory.

MIG-01 stays skipped throughout: it uses a different variable and targets only the archived drafts.

### 18.12 Gate B-W targeted corrections after the independent audit

**Audit verdict: FAIL.** Codex's independent audit of the Increment 1 implementation reported three high-severity defects, four medium-severity findings, one low-severity finding and a missing production statement catalogue. The owner authorized a targeted correction phase limited to named files. Gate A was not reopened, the running application was not changed, and **Gate B-X remains unauthorized**.

**Nothing in this section has been executed against a database.** No PostgreSQL was installed or started, no connection was made, no SQL was executed, no migration was applied and no database integration test was run. "Closed by static review" below means the defect is removed in the source and covered by database-free tests where that is possible. It does not mean PostgreSQL behaviour was verified.

The audit report itself was not available when the corrections were written; the nine corrections follow the owner's authorization, which lists each finding. Severities for corrections 4 to 8 are therefore not individually recorded here.

| # | Finding | Severity | Correction | Status |
| --- | --- | --- | --- | --- |
| 1 | Capacity race: a locked, near-expired session was skipped by cleanup, not counted as live, then refreshed by its touch, exceeding 500 | High | Capacity counts every remaining session row | Closed by static review; behaviour needs execution |
| 2 | The migration runner accepted any object with a query method, so one migration's statements could use different connections | High | One pinned connection through an explicit acquisition contract | Closed by static review; real transaction behaviour needs execution |
| 3 | The test harness trusted pre-existing `shopaccess_*` roles and databases by name | High | Pristine-cluster rule; role attributes and memberships verified before any login | Closed by static review; needs execution |
| 4 | Migration discovery did not resolve symlinks and detected transaction control by a line pattern | See note above | Realpath; approved inventory pinned by checksum; statement-level scan | Closed by static review |
| 5 | A failed harness setup leaked the database, connections and test logins | See note above | Tracked resources; cleanup on every failure path | Closed by static review; needs execution |
| 6 | PGT-04 and PGT-54a had no test | See note above | Tests written, including a two-process test | Partially closed: written, never run |
| 7 | The key ring kept and returned mutable caller buffers; no enforced pair validation | See note above | Copies in and out; one validation boundary for both rings | Closed by static review |
| 8 | Rotation returned the session ID of a caller-supplied object | See note above | Rotation bound to the issued session and its cookie; ID returned by the database | Closed by static review; SQL change needs execution |
| 9 | No production statement catalogue | — | `src/lib/pg/statements.ts`; SQL-01 allows exactly that file | Closed by static review |

**Correction 1 — session capacity.**

- Lock order for the Increment 1 functions is fixed and written at the top of migration `0006`: (1) the guard row, (2) key-version rows, (3) session rows. `admit_session` takes 1 `FOR UPDATE` and 2 `FOR SHARE`, and touches 3 only without waiting. `authorize_session` and `revoke_session` take 3. `rotate_session` takes 2 then 3. `activate_key_version` takes 1 then 2. `revoke_key_version` takes 1, 2, 3. No function takes them in another order.
- The guard row serializes admissions, and only admission inserts or deletes session rows. After deleting the rows that are dead and that it could lock, `admit_session` counts **every remaining row** against 500. `SKIP LOCKED` is still used for the delete, where it can only leave an extra row in place; it is no longer followed by a liveness-filtered count, so it cannot cause an undercount.
- The count does not depend on the time and nothing after the decision time waits for a lock, so the decision time does not need to be read again. `authorize_session` already reads its decision time after its lock wait.
- A lock wait beyond `lock_timeout` raises an error that no function catches: the admission fails and nothing is admitted.
- Effect on availability: a dead session that another transaction happens to hold occupies a slot until that transaction ends. The limits of 500 live sessions and 30 admissions per minute, and the 2-hour and 24-hour expiry rules, are unchanged.

**Correction 2 — migration transaction affinity.**

- `src/lib/pg/client.ts` defines a connection source (`connect()` returning a client with `release()`), `withPinnedConnection`, and a `PinnedConnection` class. The class is nominal and can be constructed only by `withPinnedConnection`, which refuses at run time any source that does not hand out a releasable client: a query-only object, and a bare client whose `connect()` returns nothing, are both refused before any work.
- `applyMigrations(source, directory)` acquires one connection, sends every statement of the run on it, and releases it in a `finally`. After any thrown error, or when a ROLLBACK cannot be confirmed, the connection is destroyed rather than reused.
- A ledger row is written only inside the transaction that applied the file. A version is reported as applied only after its COMMIT returned. Discovery runs first: a refused directory acquires no connection.

**Correction 3 — disposable-database role safety.** The rule in §18.11 is replaced by this one.

- A server is used only if it is **pristine**: loopback host; admin URL naming `postgres`; `cluster_name` exactly `shopaccess-disposable-test`; PostgreSQL 17; the connecting role is the bootstrap superuser; no database other than the three built-in ones; no role other than the connecting role and predefined `pg_` roles with their original attributes; no role membership except between predefined roles. A pre-existing role or database is refused **whatever its name**, including the harness's own naming patterns. Neither the marker nor loopback nor a name is treated as proof.
- After the bootstrap file runs, and again after logins are created, the harness verifies every ShopAccess role: no SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS; LOGIN only where this run enabled it; exactly the approved memberships with the approved options; no other role present. No role receives a login or a password before this passes.
- The harness changes credentials only on roles it created in the same invocation and verified. It drops only the database and roles it recorded as created, by exact name, and uses no `IF EXISTS`.
- A killed run can leave resources behind. The next run then refuses the cluster. The remedy is to delete and re-create the disposable cluster.

**Correction 4 — migration discovery.**

- The directory is resolved with realpath and must be a `db/migrations` directory. Any path with an `archive` segment, before or after resolution, is refused; so are symlinked files, a symlinked or non-directory `archive`, and every entry that is not an inventory file.
- `APPROVED_MIGRATIONS` in `src/lib/pg/migrate.ts` lists the six files with their SHA-256. A missing file, an extra file, a second file with an existing number, or a file whose bytes differ is refused. Because the bytes are pinned, no reformatting or comment trick can add a statement to an approved file. Changing a migration requires changing its recorded checksum in the same reviewed change; `0006` was changed by corrections 1 and 8 and its checksum was recorded then.
- As a second check, each file is scanned statement by statement, with comments, literals and dollar-quoted bodies separated, for transaction control at top level and for COMMIT or ROLLBACK inside function and DO bodies. A file that cannot be analysed is refused.
- The ledger checksum, ordering and idempotency rules are unchanged.

**Correction 5 — harness cleanup.** Provisioning records each resource only after the step that creates it has returned. On any failure it closes connections, drops exactly the recorded resources, attempts every cleanup step even if one fails, and rethrows the original error; cleanup errors are attached to it and never replace it. `destroy()` uses the same routine and reports an incomplete cleanup as an error.

**Correction 6 — concurrency tests (written, never run).**

- PGT-04: `tests/db/admission-processes.test.ts` starts two separate operating-system processes, each with its own connections, released together by a start barrier. Expected totals do not depend on the interleaving.
- PGT-54a: a touch waits on a held session row across the idle-expiry boundary and must be refused, writing nothing.
- Capacity/touch race: the interleaving of correction 1, with both outcomes (touch commits; touch rolls back).
- Barriers and database-clock polling only; no fixed sleeps. Each test asserts that its precondition held (the touch was decided or waiting before the expiry), so a slow machine fails the test instead of silently testing something else.

**Correction 7 — key ring.** A ring copies key bytes at construction, into memory outside the shared buffer pool, and validates version range and key length. It never returns its own buffer: `keyFor` returns a copy and `useKey` lends a copy that is zeroed afterwards. Comparison of key bytes across rings is constant-time. `loadKeyRings` parses both configured rings and refuses identical key bytes across the two purposes; the session service accepts only the validated pair it returns. `ACTIVE`, `VERIFY_ONLY`, `REVOKED` and staged behaviour (§18.5) are unchanged. Nothing is wired into the application.

**Correction 8 — rotation identity.** `rotate_session` now returns `session_id`. The session service rotates only a session object that the same service instance returned, together with the cookie that object was resolved from; any other pairing is `NOT_AUTHORIZED` and sends nothing to the database. The returned session carries the ID the database reported. Rotation remains one atomic statement. Mock session behaviour is unchanged.

**Correction 9 — statement catalogue.** `src/lib/pg/statements.ts` holds every statement the library sends, as frozen string literals with numbered placeholders and schema-qualified names. The library and the database tests import the same definitions; the harness defines none. SQL-01 in `tests/unit/environment.test.ts` skips exactly two files: the legacy query module and this catalogue. There is no exception for the `src/lib/pg` directory, and SQL-01's other assertions are unchanged. This closes the open issue of §18.11.

**Files.**

| Area | Files |
| --- | --- |
| Created | `src/lib/pg/statements.ts`; `tests/unit/pg-migrate.test.ts`; `tests/unit/pg-harness.test.ts`; `tests/db/admission-processes.test.ts` |
| Modified, library | `src/lib/pg/client.ts`, `key-ring.ts`, `session-service.ts`, `migrate.ts` |
| Modified, SQL | `db/migrations/0006_session_and_key_functions.sql` |
| Modified, tests | `tests/db/harness.ts`, `sessions.test.ts`, `migrations.test.ts`, `keys.test.ts`, `clock.test.ts`, `privileges.test.ts`; `tests/unit/pg-key-ring.test.ts`, `pg-session-cookie.test.ts`, `pg-static.test.ts`; `tests/unit/environment.test.ts` (SQL-01 skip list only) |
| Not changed | The six archived drafts and their README; the bootstrap file; migrations `0001` to `0005`; `src/lib/pg/session-cookie.ts`; the legacy query module; every Mock module; both test configurations |

**Remaining limitations.**

- No SQL has been parsed or executed. Every statement about locking, transactions, privileges and cleanup is unverified.
- The bootstrap file still creates roles only when absent and does not check the attributes of a role that already exists. The harness no longer relies on that, but an administrator running the bootstrap in a cluster that already has such roles is not protected by it. Not changed here: no finding required it. **Corrected by §18.13, correction 1.**
- The strict directory rule refuses any unexpected entry in `db/migrations`, including operating-system metadata files.
- A harness run that is killed leaves its database and roles behind; the cluster must then be re-created.
- Items 3 to 7 of the earlier list (§18.11, "Other things to know") still apply.

**Gate B-X prerequisites (not authorized).** As §18.11, with these changes: the cluster must be freshly initialized and otherwise empty, and the harness must connect as its bootstrap superuser; the two-process test needs about 60 connections, within the default limit of 100; and a second independent audit of these corrections is recommended before execution.

### 18.13 Gate B-W final hardening after the re-audit

**Re-audit verdict: CONDITIONAL PASS.** Codex's second independent audit left five items and one residual risk to review. The owner authorized a final hardening pass limited to named files. **Gate B-X remains unauthorized, and a further independent review is required before the owner considers it.**

**Nothing in this section has been executed against a database.** No PostgreSQL was installed or started, no connection was made, no SQL was executed, no migration was applied and no database integration test was run. The re-audit document was not available when these corrections were written; they follow the owner's authorization.

| # | Finding | Correction | Status |
| --- | --- | --- | --- |
| 1 | The bootstrap file created roles only when absent, so it silently adopted an existing role whatever its privileges | Refuse if any of the five roles or either schema exists; one transaction; verify before commit | Closed by static review; needs execution |
| 2 | Two harness invocations could both pass the pristine-cluster check and then interfere | Database-enforced exclusive control held from before preflight until after cleanup | Closed by static review; real concurrency needs execution |
| 3 | SQL-01 matched one line at a time, so multiline SQL outside the allowed files was not detected | Pattern spans lines within one source statement; allowlist is two exact paths | Closed |
| 4 | A key ring's purpose was read-only in the type system only | Private field; frozen instances, prototypes and classes; no subclasses | Closed |
| 5 | `withPinnedConnection` abandoned a client that could be released but could not query | Released for destruction before the refusal | Closed |

**Correction 1 — bootstrap.**

- The file is one transaction (`BEGIN` … `COMMIT`). After any error PostgreSQL rejects every later statement until the transaction ends, so a client that continues after an error still changes nothing.
- Its first statement after `BEGIN` reads the role and schema catalogs and raises an error if any of `shopaccess_owner`, `shopaccess_definer`, `shopaccess_web`, `shopaccess_worker`, `shopaccess_operator`, or either schema, exists. It runs before any role, schema, privilege or credential statement.
- The five roles are then created unconditionally by five static statements, each `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`. If a role appeared after the preflight, creation fails and the transaction rolls back.
- Before `COMMIT` the file checks that all five exist, that none has an elevated attribute or a login, and that the only membership touching them is the migration role's non-inheriting, non-admin membership in the function owner. Otherwise it raises and rolls back.
- The five-role design, grants, schemas and default privileges are unchanged.
- **Consequence to note:** roles are cluster-wide, so the bootstrap can succeed once per cluster. A second ShopAccess database in a cluster that already has these roles is refused. That is the approved pristine-cluster setup; supporting a second database would need a separate, reviewed procedure.

**Correction 2 — exclusive control of the test cluster.**

- Before it inspects the cluster, the harness opens a dedicated connection to the `postgres` database and takes a session-level advisory lock with a fixed key, without waiting. Advisory locks are scoped to one database, and every invocation must use `postgres` (the harness checks), so PostgreSQL allows one holder in the whole cluster, across processes. A second invocation is refused outright; it does not queue.
- The lock is held through preflight, provisioning, the tests and cleanup, and released last by ending that connection. If the process dies, the server ends the session and releases the lock.
- Before every step that changes or drops anything, the harness asks the server, on that same session, whether it holds the lock. If the answer is no, or cannot be obtained, setup stops and **cleanup drops nothing**, because another invocation may by then own roles of the same names. The lost control is reported and the cluster must be re-created.
- An invocation that never acquired the lock never releases it.
- This coordinates harness invocations with each other. It does not stop some other client from changing the cluster; the pristine-cluster and role checks (§18.12, correction 3) remain the defence there.

**Correction 3 — SQL-01.** The scanner now looks for a statement keyword followed by `FROM`, `SET` or `VALUES` with anything between them, line breaks included, up to the next semicolon of the source. Template literals, concatenated strings and joined arrays spread over lines are detected. SQL text is allowed in exactly two files, matched by full path: `src/lib/db/queries.ts` and `src/lib/pg/statements.ts`. No directory and no file-name suffix is exempt. The test also asserts that those two are the only files under `src` containing SQL. Other SQL-01 assertions are unchanged. As before, only upper-case keywords are matched. **Superseded by §18.14, correction 2: letter case is now ignored.**

**Correction 4 — key-ring purpose.** The purpose is held in a private field with a getter. Ring instances, the validated pair, both prototypes and both classes are frozen, and neither class can be subclassed. Pair validation and key-state resolution read the private field, so an object that merely reports a purpose is refused. Buffer copying, constant-time comparison, cross-purpose refusal and redaction are unchanged.

**Correction 5 — malformed connection.** If a source hands back an object with `release` but no `query`, `withPinnedConnection` releases it with the destroy flag, then refuses with the same error as before. An error thrown by that release does not replace the refusal. An object with neither operation cannot be released and is refused as before.

**Residual risk reviewed: `CREATE DATABASE` succeeds but its acknowledgment is lost.** The harness records a database only after the creating call returns, so in this case it records nothing and drops nothing; it does not search for or guess a database by name. The database remains, the next run finds a cluster that is not pristine and refuses it, and the cluster must be newly initialized. This is unchanged by design. A unit test now fixes the behaviour. No safety defect was found that would justify a redesign.

**Files.** Modified: `db/bootstrap/0000_roles_and_schemas.sql`; `tests/db/harness.ts`; `src/lib/pg/key-ring.ts`; `src/lib/pg/client.ts`; `tests/unit/environment.test.ts` (SQL-01 only); `tests/unit/pg-static.test.ts`, `pg-key-ring.test.ts`, `pg-migrate.test.ts`, `pg-harness.test.ts`; the three documentation files. Not changed: migrations `0001` to `0006` and their approved inventory; the archived drafts; `statements.ts`, `session-service.ts`, `session-cookie.ts`, `migrate.ts`; the legacy query module; all Mock and application code.

**Remaining limitations.**

- No SQL has been parsed or executed. The bootstrap's new blocks, the advisory-lock statements and the lock query are all unverified.
- Between a control confirmation and the statement that follows it there is a short interval. If control were lost exactly then, the statement would still be sent. The consequence is bounded: a competing invocation would find a cluster that is not pristine and refuse it. **Closed for every cluster-level statement by §18.14, correction 1; it remains only for work inside the test database.**
- Losing control, a killed run, or a lost `CREATE DATABASE` acknowledgment each leave resources behind and require a newly initialized cluster.
- SQL-01 matches upper-case keywords only. SQL written in lower case would not be detected, in one line or several. This was true before and is unchanged. **Corrected by §18.14, correction 2.**
- Items listed in §18.11 and §18.12 as depending on execution still do.

### 18.14 Gate B-W two-issue closure after the third audit

**Third audit verdict: CONDITIONAL PASS.** No high-severity source defect remained. Two medium-severity issues were to be corrected before the owner considers Gate B-X. The owner approved the two-issue scope and, for the first issue, chose to move every applicable cluster-level statement onto the lock-owning session. **Gate B-X remains unauthorized.**

**Nothing in this section has been executed against a database.** No PostgreSQL was installed or started, no connection was made, no SQL was executed, no migration was applied and no database integration test was run. The audit document was not available when the corrections were written; they follow the owner's authorization.

| # | Finding | Correction | Status |
| --- | --- | --- | --- |
| 1 | The advisory lock was held on one connection while `CREATE DATABASE` and other cluster-level statements ran on others, leaving a gap between the ownership check and the statement | Every cluster-level statement is sent on the session that holds the lock | Closed by static review; needs execution |
| 2 | SQL-01 matched upper-case keywords only | Letter case is ignored | Closed |

**Correction 1 — one session for the lock and for cluster-level statements.**

- The harness opens exactly one connection to the `postgres` database: the session that takes the advisory lock. That session is taken before the cluster is inspected and ended only after cleanup, as before (§18.13, correction 2).
- These statements are now sent only on that session: `CREATE DATABASE`; `DROP DATABASE`; `CREATE ROLE` for the operator login; `ALTER ROLE` enabling the web login; `DROP ROLE`; the grant of the operator group membership; the grant of `CONNECT` on the test database to the operator login. The catalog reads behind the pristine-cluster and role checks also use it.
- Each is sent as a single statement in its own message. The session never opens a transaction, so `CREATE DATABASE` and `DROP DATABASE` are never inside one. The session refuses anything that is not exactly one such statement.
- Because the lock and the statements share a session, a statement cannot be sent by a party that has lost the lock: if the session is gone, there is nothing to send it on. Once the session is known or suspected to be lost, it sends nothing further.
- **Uncertain outcomes.** If the connection fails while a statement is in flight, the statement may or may not have taken effect. The harness does not assume it was cancelled, does not retry and does not attempt cleanup: it drops nothing, not even resources it created with certainty earlier, and reports the cluster as contaminated. A lost `CREATE DATABASE` acknowledgment is this case. Only an error reported by the server for the statement, on a session that survived, is treated as a definite failure, after which normal tracked cleanup proceeds.
- The same applies during cleanup: an uncertain outcome of one drop ends cleanup.
- The pristine-cluster rule, the role attribute and membership checks, tracked resources, the refusal to drop by name, and the single-invocation rule are unchanged.
- **What still uses other connections, by necessity.** The bootstrap file, the migrations and the tests must run inside the test database, which the lock-owning session is not connected to. Before the bootstrap and before the migrations the harness still confirms the lock with the server, but the lock could be lost in the instant after a confirmation and that work would continue. The exposure is limited: that work changes only the harness's own database, plus the five roles the bootstrap creates; a competing invocation would find a cluster that is not pristine and refuse it; and every later cluster-level step, including all cleanup, needs the lost session and so cannot run.

**Correction 2 — SQL-01 letter case.** The pattern is now case-insensitive, and the two words of `INSERT INTO` and `DELETE FROM` may be separated by any white space, including a line break. Upper-case, lower-case and mixed-case SQL is detected on one line or several, in strings, template literals, concatenations and joined arrays. The allowlist is unchanged: exactly `src/lib/db/queries.ts` and `src/lib/pg/statements.ts`, by full path. Against the current `src` tree the rule flags those two files and no other. The rule is deliberately broad: a comment or ordinary code that happens to read like SQL would fail the test and must be reworded; the rule is not to be narrowed for it.

**Files.** Modified: `tests/db/harness.ts`; `tests/unit/pg-harness.test.ts`; `tests/unit/environment.test.ts` (SQL-01 group only); `tests/unit/pg-static.test.ts`; the three documentation files. Nothing else.

**Remaining limitations.**

- No SQL has been parsed or executed. In particular it is unverified that each cluster-level statement behaves as intended when issued from the `postgres` database, and that the driver reports connection failures in the way the uncertain-outcome rule expects.
- Lock loss in the instant after a confirmation, during the bootstrap or the migrations (above).
- An uncertain outcome, a lost lock or a killed run each leave resources behind. The cluster is then contaminated and must be newly initialized.
- SQL-01 detects SQL by its keywords in source text. SQL assembled so that no statement keyword and no `FROM`, `SET` or `VALUES` appears in the source at all would not be detected by any rule of this kind.

### 18.15 Gate B-X execution record and evidence for acceptance

**This section records what was executed. It is not itself owner acceptance of Increment 1 and authorizes nothing; the owner formally accepted Increment 1 afterwards (§18.10).** Sections 18.11 to 18.14 were written before any execution and are kept as written.

**Sequence of events.**

| # | Event | Outcome |
| --- | --- | --- |
| 1 | Final independent Codex audit before execution | CONDITIONAL PASS; no source-level blocker to a first isolated run |
| 2 | Owner authorizes Gate B-X, one run | — |
| 3 | First execution, 9 October 2026 | 41 tests: **38 passed, 3 failed**, 0 skipped |
| 4 | Diagnosis | All three failures were defects in the tests, not in the database objects (below) |
| 5 | Owner authorizes a two-file, test-only remediation | `tests/db/admission-processes.test.ts`, `tests/db/migrations.test.ts`; no SQL, migration or library change |
| 6 | Independent Codex audit of the corrected test source | PASS |
| 7 | Owner authorizes a second Gate B-X execution, one run, on a newly initialized cluster | — |
| 8 | Second execution, 9 October 2026 | 41 tests: **41 passed, 0 failed, 0 skipped** |
| 9 | Final independent Codex acceptance audit | CONDITIONAL PASS: no functional Increment 1 acceptance blocker; pending documentation consistency |

**Environment, both runs.** PostgreSQL 17.11, built from the official source (published SHA-256 verified) into a private directory outside the repository; nothing installed system-wide and no service registered. Each run used its own newly initialized cluster: its own data directory and its own generated superuser credential, `cluster_name` `shopaccess-disposable-test`, loopback TCP only, password authentication only, Unix sockets disabled. No other PostgreSQL server existed on the machine. Everything the database did was done by the approved harness through `vitest.db.config.mts`; no SQL was issued by hand and neither the bootstrap file nor any migration was run separately.

| | First run | Second run |
| --- | --- | --- |
| Address | `127.0.0.1:54517` | `127.0.0.1:54527` |
| System identifier | `7694686172024518578` | `7694699675150923610` |
| Result | 38 passed, 3 failed | 41 passed, 0 failed, 0 skipped |
| End state | Server shut down normally | Server shut down normally |

The first cluster was not reused, started or changed for the second run.

**First execution: the three failures.**

- **PGT-04, two tests, timed out after 60 seconds.** Each child process printed its report but did not exit, because its standard input was left open, and the test waited for the child to close. The admission counts were therefore never checked in that run.
- **PGT-50, one test, expected the wrong SQLSTATE.** `TRUNCATE shopaccess.server_key_versions` was refused with `0A000` (PostgreSQL will not truncate a table that a foreign key references) where the test expected `23001` from the table's trigger. The truncate was still refused. The test stopped there, so its later statements were not evaluated in that run.

The other 38 tests passed. No uncertain database outcome and no cleanup failure occurred.

**Test-only remediation.**

- PGT-04: the parent closes the child's input when it sends the start signal; the child releases its input once signalled; a deadline shorter than the test timeout reports how far a child got. Two independent processes, the start barrier and every admission assertion are unchanged.
- PGT-50: expected codes are stated per statement; every statement is attempted before anything is asserted; `TRUNCATE … CASCADE` and multi-table `TRUNCATE` cases were added; and the test compares a row count and row digest of every protected table before and after.

No assertion was weakened. No SQL, migration, library or application file was changed.

**Second execution: results.**

| File | Passed | Failed |
| --- | --- | --- |
| `sessions.test.ts` | 16 | 0 |
| `privileges.test.ts` | 6 | 0 |
| `keys.test.ts` | 6 | 0 |
| `migrations.test.ts` | 5 | 0 |
| `clock.test.ts` | 4 | 0 |
| `admission-processes.test.ts` | 2 | 0 |
| `catalog.test.ts` | 2 | 0 |
| **Total** | **41** | **0** |

- **Bootstrap and migrations.** The harness provisioned a fresh database for each of the seven files; in each the bootstrap file ran, the role checks passed and migrations `0001` to `0006` applied. This is established by the suite passing, not by separate inspection: the migrations test found nine tables, six entry points and one helper, and six ledger rows carrying the pinned checksums; re-applying was a no-op; an altered file was refused.
- **PGT-04.** Both cross-process tests passed. Forty admissions from two processes into an empty table: 30 admitted, 10 rate-limited. With 499 sessions present: one admitted, 29 at capacity, 10 rate-limited, 500 rows. Both children exited normally.
- **PGT-50.** All 15 refusal statements were refused with the expected SQLSTATE, and the protected-data comparison passed: row counts and digests of the six protected tables were identical before and after.

| # | Statement | SQLSTATE | Refused by |
| --- | --- | --- | --- |
| 1 | `UPDATE schema_migrations` | `23001` | Trigger |
| 2 | `DELETE FROM schema_migrations` | `23001` | Trigger |
| 3 | `TRUNCATE schema_migrations` | `23001` | Trigger |
| 4 | `DELETE FROM session_admission_guard` | `23001` | Trigger |
| 5 | `TRUNCATE session_admission_guard` | `23001` | Trigger |
| 6 | `TRUNCATE server_key_versions` | `0A000` | Foreign key |
| 7 | `TRUNCATE checkout_owners` | `0A000` | Foreign key |
| 8 | `TRUNCATE shopper_sessions` | `23001` | Trigger |
| 9 | `TRUNCATE audit_events` | `23001` | Trigger |
| 10 | `TRUNCATE server_key_versions CASCADE` | `23001` | Trigger |
| 11 | `TRUNCATE checkout_owners CASCADE` | `23001` | Trigger |
| 12 | `TRUNCATE shopper_sessions CASCADE` | `23001` | Trigger |
| 13 | `TRUNCATE server_key_versions, shopper_sessions` | `23001` | Trigger |
| 14 | `TRUNCATE checkout_owners, shopper_sessions` | `23001` | Trigger |
| 15 | `TRUNCATE` naming all six protected tables | `23001` | Trigger |

- **Server log.** 119 errors, each an intended refusal provoked by a test: 90 permission denied (`42501`), 21 trigger refusals (`23001`), 5 check-constraint violations (`23514`), 2 foreign-key truncate refusals (`0A000`), 1 lock timeout (`55P03`). No FATAL, PANIC or deadlock, and no other SQLSTATE.
- **Cleanup.** No uncertain outcome, lost lock or cleanup error. Each file's provisioning required a pristine cluster, so each passing file shows that the previous file's database and roles had been removed. Afterwards the data directory held only the three built-in databases. The cluster is not contaminated.
- **Shutdown.** The server was stopped normally.

**Who established what.** The two sources are kept apart on purpose.

| Fact | Independently reported by the final Codex acceptance audit | Rests on the implementer's execution report, with the passing tests and preserved logs as support |
| --- | --- | --- |
| Seven approved database test files; 41 passed, 0 failed, 0 skipped | Yes | Yes |
| PGT-04 and PGT-50 passing | Yes, from execution results and source inspection | Yes |
| PostgreSQL 17.11 listening on `127.0.0.1:54527` and shutting down normally | Yes | Yes |
| Six active migration checksums match the approved inventory | Yes | Yes |
| No functional Increment 1 acceptance blocker | Yes (Codex's conclusion) | — |
| The 15 individual SQLSTATEs of PGT-50 | No | Yes, read from the server log |
| Attribution of each of the 119 server-log errors to a test | No | Yes, by error class |
| Cluster preflight steps (new data directory, new credential, unused port, single loopback listener) | No | Yes |
| Cleanup observations, and that the cluster is not contaminated | No | Yes |
| The first cluster untouched during the second run | No | Yes, by checksum of its files before and after |
| First execution results (38 passed, 3 failed) and their causes | Not stated in the audit summary available here | Yes; that report was given to the owner in conversation and was not stored in the repository. The preserved first-run logs are the supporting evidence |

Limits Codex stated for its own audit: it did not attribute every server-log error to a specific test assertion; it did not query the database after shutdown; and it could not independently establish a complete history of shell commands or Git changes. The role list after the final test file was likewise not observed directly by anyone, since that needs SQL; the final cleanup reported no error.

**Limitations that remain.**

- The suite passed **once, on one local machine**. The concurrency tests passed once each and have not been repeated to look for rare interleavings.
- PostgreSQL is **not wired into the running application**, which still runs on the in-memory Mock. That is Increment 2, which is not authorized.
- No real PayPal, external AI, Channel3 or hosted deployment was tested or contacted.
- Backup and restore, and production operations generally, are outside Increment 1 and untested.
- The architectural and operational limitations accepted earlier remain in force (§17.4, and the lists in §18.11 to §18.14): among them no operator tool for check values, owner rows that outlive their sessions, admission budget consumed by an identifier collision, unaudited operator refusals, a bootstrap that succeeds once per cluster, and the SQL-01 rule's breadth.
- Both disposable clusters, their server logs, both run logs and the credential files are **preserved outside the repository** pending a separate owner decision. Nothing was deleted.

**Known documentation inconsistencies outside this document.** The closure that added this section was limited to four files. Comments elsewhere still say the code was never run:

| Where | Statement | Kind |
| --- | --- | --- |
| `db/migrations/0001` to `0006` | "NEVER EXECUTED: written under Gate B-W" | Misleading as current status. **Left deliberately and permanently:** editing a migration, even a comment, changes its pinned checksum (§18.12, correction 4). All six were executed in both runs |
| `db/bootstrap/0000_roles_and_schemas.sql` | "NEVER EXECUTED … No statement in this file has been run" | Misleading as current status. Executed in both runs in its present form |
| `tests/db/harness.ts`, `sessions.test.ts` (two places), `keys.test.ts`, `privileges.test.ts`, `clock.test.ts`, `catalog.test.ts` | "NEVER RUN (Gate B-X not authorized)" | Misleading as current status. All ran and passed in the second run |
| `src/lib/pg/client.ts`, `migrate.ts`, `statements.ts` | "has never been run against a database" / "NEVER EXECUTED" | Misleading as current status. Each was exercised by the database tests |
| `docs/postgresql/correction-report-013.md`, §16 to §19 | "not executed", "never run" | **Historical and accurate:** each entry is dated to a stage before Gate B-X. That report has no entry for the executions; this section and the implementation report hold that record |

These are comments only. They do not affect behaviour and do not by themselves block acceptance; correcting the non-migration ones needs a separate authorization.

---

## 19. Increment 2 — Gate A contract (design approved for 2.1; not implemented; not executed)

**Status.** The owner approved the Increment 2.1 design at Gate A and authorized recording it in this document. That authorization covers documentation only. Nothing in this section has been implemented or executed: no Increment 2 migration, function, trigger, test or application code exists, and no SQL has been run for it. Gate A remains open. Where an earlier section differs for an Increment 2 object, this section governs. Increments 2.2 and 2.3 are not approved contracts (§19.16). The decision register is §19.17.

### 19.1 Scope and status
- Increment 2 ends at `USER_CONFIRMED`. It contains no dispatch, worker, provider call, capture, refund, finality or payment recovery.
- **2.1:** all seven tables; `start_checkout`, `cancel_checkout`, `read_checkout`, `list_owner_checkouts`.
- **2.2:** `issue_challenge`, `consume_challenge`.
- **2.3:** opt-in application mode.
- The bootstrap file and migrations `0001` to `0006` are unchanged. Mock mode is unchanged.
- Sub-increment 2.1 is *APPROVED (design)*. Sub-increments 2.2 and 2.3 are outside this contract (§19.16).

### 19.2 Schema inventory and constraints

**Seven tables**, all in schema `shopaccess`, all created in 2.1:

| # | Table | Purpose | Mutability |
| --- | --- | --- | --- |
| 1 | `purchase_groups` | One buyer-authorized purchase | Insert-only |
| 2 | `checkout_intents` | One checkout attempt | Insert; restricted update |
| 3 | `quotes` | Server-priced quote | Insert-only |
| 4 | `quote_items` | The quoted line and its display snapshot | Insert-only |
| 5 | `confirmation_challenges` | Consent challenge (used from 2.2) | Insert; status may leave `ACTIVE` once |
| 6 | `checkout_transitions` | State-change history | Insert-only |
| 7 | `owner_request_windows` | Per-owner request counter | Insert; update |

Every constraint and trigger is explicitly named. No table accepts truncate. No role is granted DELETE.

**`purchase_groups`**
- **Columns:** `id` (`pur_` + 32 hex, database-generated), `owner_id`, `created_at`.
- **Constraints:** primary key `(id)`; unique `(id, owner_id)`; key to `checkout_owners`.
- Update and delete are rejected.

**`checkout_intents`**
- **Columns:** `id` (`ci_` + 32 hex), `owner_id`, `purchase_group_id`, `replaces_intent_id` (nullable), `superseded_by_intent_id` (nullable), `created_by_session_id` (informational, no key), `state`, `row_version`, `current_quote_id`, `confirmation_id`, `confirmation_status`, `created_at`, `updated_at`.
- **Unique candidate keys, all non-deferrable:**

| Name | Columns |
| --- | --- |
| `checkout_intents_pkey` | `(id)` |
| `checkout_intents_id_owner_key` | `(id, owner_id)` |
| `checkout_intents_id_group_key` | `(id, purchase_group_id)` |
| `checkout_intents_id_replaces_key` | `(id, replaces_intent_id)` |
| `checkout_intents_id_superseded_by_key` | `(id, superseded_by_intent_id)` |

- **Partial unique indexes:** `checkout_intents_one_successor_idx` on `(replaces_intent_id)` where not NULL; `checkout_intents_one_root_idx` on `(purchase_group_id)` where `replaces_intent_id` is NULL.
- **Foreign keys:**

| Name | Columns → target | Checked |
| --- | --- | --- |
| `checkout_intents_group_owner_fkey` | `(purchase_group_id, owner_id)` → `purchase_groups (id, owner_id)` | Immediately |
| `checkout_intents_predecessor_group_fkey` | `(replaces_intent_id, purchase_group_id)` → `(id, purchase_group_id)` | Immediately |
| `checkout_intents_successor_owner_fkey` (F-2) | `(superseded_by_intent_id, owner_id)` → `(id, owner_id)` | Immediately |
| `checkout_intents_successor_reciprocal_fkey` (R-A) | `(superseded_by_intent_id, id)` → `(id, replaces_intent_id)` | Immediately |
| `checkout_intents_predecessor_reciprocal_fkey` (R-B) | `(replaces_intent_id, id)` → `(id, superseded_by_intent_id)` | Deferred |
| `checkout_intents_current_quote_fkey` (F-4) | `(current_quote_id, id)` → `quotes (id, checkout_intent_id)` | Deferred |
| `checkout_intents_confirmation_fkey` (F-5) | `(confirmation_id, id, confirmation_status)` → `confirmation_challenges (id, checkout_intent_id, status)` | Immediately |

- **Checks:**
  - state is one of `QUOTED`, `USER_CONFIRMED`, `SUPERSEDED`, `CANCELED_LOCAL`, `EXPIRED`;
  - `QUOTED` has a quote pointer and no confirmation;
  - `USER_CONFIRMED` has both;
  - confirmation pointer and status are both NULL, or both set with status `CONSUMED`;
  - state is `SUPERSEDED` exactly when a successor pointer is set;
  - neither pointer equals the row's own ID;
  - `row_version` is at least 2.
- A key is not checked while any of its own columns is NULL. A referenced row whose pointer is NULL matches nothing.

**`quotes`** (columns as §2.10)
- **Unique:** `(id, owner_id)`, `(id, checkout_intent_id)`, `(id, checkout_intent_id, owner_id)`, `(digest)`.
- **Keys:** F-1 to the intent's `(id, owner_id)`; to `merchants`.
- **Checks:** total equals subtotal; discount, tax and shipping are zero; currency `USD`; `digest_version = 'SAQD-1'`; `expires_at = created_at + 15 minutes`.

**`quote_items`** (columns as §2.10, plus the snapshot)
- Primary key `(quote_id, line_number)`, line number 1.
- Quantity 1 to 10; line subtotal equals unit amount times quantity.
- F-14 to the variant's `(id, product_id)`.
- **Immutable snapshot columns:** `merchant_display_name`, `product_title`, `variant_label`, `descriptive_terms_digest` (64 hex, over product description and variant specifications).

**`confirmation_challenges`:** as §2.11, unchanged.

**`checkout_transitions`**
- **Columns:** `checkout_intent_id`, `to_version`, `from_version`, `event_id`, `event_type`, `actor`, `entry_point`, `from_state`, `to_state`, `occurred_at`, `recorded_at`.
- Primary key `(checkout_intent_id, to_version)`; unique `(event_id)`; `to_version = from_version + 1`.
- `event_type` is one of `QUOTE_ISSUED`, `SHOPPER_CONFIRMED`, `SHOPPER_CANCELED`, `SUPERSEDED`.
- `actor` is `shopper` or `server`.
- `from_state` may also be `DRAFT`, only for the first transition.

**`owner_request_windows`**
- **Columns:** `owner_id` (primary key, key to `checkout_owners`), `window_started_at`, `window_calls`, `window_throttled`, `total_throttled`, `updated_at`.
- Counters are non-negative. Delete is rejected.

**Creation order:** tables 1 to 6 as listed; then the self-referencing and forward keys on `checkout_intents`; then the partial indexes; then triggers; then table 7.

### 19.3 Replacement chain

**Triggers on `checkout_intents`**
- **Insert:** state `QUOTED`; `row_version` 2; successor pointer NULL; a named predecessor must already exist.
- **Update:**
  - `id`, `owner_id`, `purchase_group_id`, `created_at` and `replaces_intent_id` never change. For `replaces_intent_id` the comparison includes NULL: a root never acquires a predecessor.
  - `superseded_by_intent_id` may change once, from NULL to a value, only in the update that sets the state to `SUPERSEDED`.
  - A row in `SUPERSEDED`, `CANCELED_LOCAL` or `EXPIRED` accepts no update.
  - `row_version` rises by exactly one.
- **Deferred history check:** the intent's transitions run from version 2 to `row_version` without a gap; the first is `DRAFT → QUOTED` from version 1; the last ends in the stored state.

**Why no cycle can exist.** A predecessor link is fixed at insertion, and the predecessor must already exist. Every link therefore points from a later row to an earlier one.
- In one statement or transaction, the first row of any ring names a row that does not exist yet and is rejected.
- Two concurrent transactions cannot each see the other's uncommitted row.
- No update can add or change a link.
- R-A forces the successor pointer to name the one actual successor.

With one root per group and at most one successor per intent, each group is a single chain.

**Order inside `start_checkout` when replacing:**
1. Insert the successor (R-B and F-4 pending).
2. Insert its quote, item and transition.
3. Update the predecessor to `SUPERSEDED` with its pointer (R-A holds at once), and insert its transition.
4. Insert both audit rows.
5. Force R-B, F-4 and the history check before returning.

| Guarantee | Enforced by |
| --- | --- |
| Pointers agree both ways; one successor; one root; same group and owner; `SUPERSEDED` exactly when replaced | Constraints |
| No cycle; no rewriting of ancestry | Triggers |
| Eligible predecessor; one winner; group intent limit | The sole authorized function and its locks |
| Nothing against migration credentials with triggers disabled | Accepted limitation (§17.4, item 14) |

### 19.4 Lock hierarchy and catalog

| Rank | Lock |
| --- | --- |
| 1 | Session admission guard row (Increment 1 functions only) |
| 2 | Key-version rows |
| 3 | Session row |
| 5 | Owner row, for update |
| 5a | Owner throttle row, only while rank 5 is held |
| 6 | Intent row |
| 7 | Challenge row |
| 8 | Catalog rows, implicit key-share at quote and item insert |

- Every function takes a subset in ascending order. Increment 1 functions take nothing above rank 3.
- **No explicit catalog lock.** Merchant, product and variant are read in one joined statement after the last lock. The quote stores what that statement returned.
- **Implicit lock.** The foreign-key checks on quote and item inserts take a key-share lock on the merchant and variant rows. It blocks only deletion of the row or a change to its key.
- **Catalog writers** lock catalog rows only. After taking a catalog lock that conflicts with key-share mode, a writer must not acquire a lock of rank 1 to 7. Changes to price, label, description or availability do not conflict.
- A quote insert that meets a committed deletion fails with an error and writes nothing.

### 19.5 Transactions and errors
- No entry point commits. Counters, audit rows, checkout rows and challenge status changes of one call commit or roll back together.
- The application sends each mutating call as one statement in its own transaction and never wraps one.
- The application acts on a result only after the database confirms the statement.
- On an unknown outcome it reads state back; `start_checkout` is never blindly retried.
- Re-runs only after deadlock or lock timeout, at most three (D-8).
- Every Increment 2 function refuses a transaction that is not `READ COMMITTED`.
- A refusal is a normal result and commits its permitted side effects. An error rolls back everything.
- A collision of a database-generated ID is an error; no handler exists for it.

### 19.6 Session credential revalidation

After the session row is locked it is found again by its exact credential. At each clock reading the function requires:

| Element | Requirement |
| --- | --- |
| Session ID | Same row as the unlocked lookup found |
| Owner | Same owner as the unlocked lookup found |
| Token digest | Equals the presented digest |
| Key purpose and version | Purpose `session`; version equals the presented one |
| Revocation | Not revoked |
| Idle expiry | Before last-seen plus 2 hours |
| Absolute expiry | Before the absolute expiry (24 hours) |
| Session key status | `ACTIVE` or `VERIFY_ONLY` |

Any failure returns `NOT_AUTHORIZED`, identical for every cause.

**Session key status (normative).**
- The share lock on the session row does not lock any key-version row.
- The session key's status is read by an ordinary, non-locking read.
- No key-version row may be locked after the session row. The only key-row lock in a checkout call is the nonce key, before the session lock (2.2).
- `ACTIVE` and `VERIFY_ONLY` are both valid, as in the accepted liveness rule. Activation of a newer key during a call may move the session's key to `VERIFY_ONLY`; the call remains authorized.

**Key revocation against a checkout call (normative).** The accepted `revoke_key_version` locks that key version's session rows before it changes the key's status.

| Case | Interleaving | Outcome |
| --- | --- | --- |
| A | The checkout call locks the session row first | The revocation waits for the session row. The checkout call may complete while the credential is still valid. The revocation completes afterward |
| B1 | The revocation commits before the checkout call starts | `NOT_AUTHORIZED`; no side effects |
| B2 | The revocation locks the session row first and commits while the checkout call waits | The checkout call then reads the revoked session. `NOT_AUTHORIZED`; no side effects |

This describes accepted Increment 1 behaviour and changes nothing in migrations `0001` to `0006`.

### 19.7 Function contracts for 2.1

All functions: schema `shopaccess_api`; owner `shopaccess_definer`; definer-rights; fixed search path; no dynamic SQL; first two parameters `(p_key_version smallint, p_token_digest text)`. The owner is derived from the live session only.

**Step 0, no lock taken**

| Sub-step | Check | Failure |
| --- | --- | --- |
| 0a | Credential format: key version present and positive; digest is 64 lowercase hex | `NOT_AUTHORIZED` |
| 0b | Unlocked session lookup; the row exists and appears live | `NOT_AUTHORIZED` |
| 0c | Argument format | `REQUEST_INVALID` |

**`REQUEST_INVALID` causes, complete list for 2.1**

| Function | Argument | Rule |
| --- | --- | --- |
| `start_checkout` | `p_product_id` | `dmp_` + 6–24 lowercase letters or digits |
| | `p_variant_id` | `dmv_` + 6–24 lowercase letters or digits |
| | `p_quantity` | Present; integer 1 to 10 |
| | `p_replaces_intent_id` | NULL, or `ci_` + 32 hex |
| `cancel_checkout` | `p_intent_id` | `ci_` + 32 hex |

- `REQUEST_INVALID` is returned before any lock and before throttle admission.
- It performs no data change, including when the owner is over the limit.
- A caller without a session that appears live receives `NOT_AUTHORIZED` instead.
- It depends only on the arguments.

**Sequence** (step 1 applies only to the 2.2 challenge functions)

| Step | Action | Possible exit |
| --- | --- | --- |
| 1 | Nonce key row (share), when applicable | — |
| 2 | Session row (share), found again by the exact credential | — |
| 3 | Owner row (update) | — |
| 4 | Throttle row: if one exists for the owner, lock it with a locking read (`SELECT … FOR UPDATE`); if none exists, there is nothing to lock. First clock reading. Credential revalidation (§19.6) | `NOT_AUTHORIZED` |
| 4a | Work out the current window and whether this call is over the limit. Nothing is written | — |
| 4b | If over the limit: apply the `RATE_LIMITED` policy and return | `RATE_LIMITED` |
| 5 | Lock the requested resource, selected by its ID and the caller's owner together | — |
| 6 | Second clock reading. Final credential revalidation (§19.6). Resource ownership: the row of step 5 was found | `NOT_AUTHORIZED` |
| 7 | Admission: increment the admitted-call counter | — |
| 8 | Business rules and writes | Success or a business refusal |

- Owner and throttle locks are held until the call ends.
- For `start_checkout` with no predecessor there is no step 5 lock; step 6 still performs the final credential revalidation.

**Throttle row handling**
- Locking the throttle row is a non-data-changing read. It is not an instruction to change any counter, window time or other stored value.
- When no row exists, the owner row lock held from step 3 serializes callers for that owner and prevents concurrent creation.
- A missing row is created only at step 7, by an admitted call.
- An existing row is updated only at step 7 (admitted) or step 4b (`RATE_LIMITED`).
- A caller can be over the limit only after earlier admitted calls, so the row exists whenever step 4b writes.
- A `NOT_AUTHORIZED` exit satisfies the invariant of §19.10, even when a new window would otherwise have started.

**Throttle policy (G2-34)**
- 30 mutating calls per owner per 60 seconds; one counter per owner, shared by all mutating functions.
- A window starts at the first admitted or throttled call at or after the previous window's start plus 60 seconds; that instant belongs to the new window.
- **Over the limit (4b):** `window_throttled` and `total_throttled` each rise by one, on every such call. One `OWNER_RATE_LIMITED` audit row is written when `window_throttled` goes from 0 to 1. The result is `RATE_LIMITED`.
- **Admitted (7):** `window_calls` rises by one. A business refusal at step 8 stays counted.
- If the counter or the audit row cannot be written, the call raises an error.

**Precedence of outcomes for the 2.1 functions:** credential `NOT_AUTHORIZED` → `REQUEST_INVALID` → `RATE_LIMITED` → resource or final-credential `NOT_AUTHORIZED` → business result.

**Missing and foreign checkout intents (Increment 2.1).** This rule applies to the 2.1 operations that name an existing checkout intent: `start_checkout` when a predecessor ID is supplied, and `cancel_checkout`. Step 5 selects by the intent ID and the caller's owner. A missing ID and another owner's ID both select no row; nothing is locked and another owner's row is never touched. Both exit at step 6 with `NOT_AUTHORIZED`. Over the limit, both receive `RATE_LIMITED` at step 4b. The handling of a missing or foreign resource by the Increment 2.2 functions is not specified in this section (§19.16).

**`start_checkout`**
- **Parameters:** `p_product_id text`, `p_variant_id text`, `p_quantity integer`, `p_replaces_intent_id text` (nullable).
- **Returns:** `result`, `intent_id`, `quote_id`, `quote_expires_at`.

| Result | When |
| --- | --- |
| `STARTED` | A new checkout, or a replacement (§19.3) |
| `NOT_AUTHORIZED` | §19.6 fails; or the predecessor is missing or belongs to another owner |
| `RATE_LIMITED`, `REQUEST_INVALID` | As above |
| `PRODUCT_NOT_IN_MERCHANT_CATALOG`, `VARIANT_UNAVAILABLE`, `QUANTITY_EXCEEDS_LIMIT`, `AMOUNT_OUT_OF_RANGE` | Catalog checks on the snapshot |
| `AT_PURCHASE_CAPACITY` | A new group is needed and the owner has 10 active or unresolved groups |
| `GROUP_INTENT_LIMIT` | The group already has 10 intents |
| `REPLACEMENT_NOT_ALLOWED` | The predecessor's stored state is not `QUOTED` or `USER_CONFIRMED`, or it already has a successor |

- A new intent is stored directly as `QUOTED` at version 2 with one transition `DRAFT → QUOTED`. `DRAFT` is never stored. There is no in-place re-quote.
- Replacement eligibility is decided on the stored state only. A predecessor stored as `QUOTED` or `USER_CONFIRMED` is eligible even if its quote has expired. There is no expiry-based replacement refusal.
- The successor receives a newly calculated quote from the current catalog. It is stored as `QUOTED` with no confirmation and requires a fresh buyer confirmation.
- The call is not idempotent.

**`cancel_checkout`**
- **Parameter:** `p_intent_id text`. **Returns:** `result`.
- **Results:** `CANCELED`; `NOT_AUTHORIZED` (including a missing or foreign intent); `RATE_LIMITED`; `REQUEST_INVALID`; `NOT_CANCELABLE` (terminal stored state).
- On success: state `CANCELED_LOCAL`, one transition, one audit row.

### 19.8 Quotes, `SAQD-1`, expiry and material change
- **`SAQD-1`** as §5.1: 19 fields, computed in the database, owner taken from the session.
- **Timestamps.** `created_at` is the second clock reading; `expires_at` is exactly 15 minutes later.
- **Usable** only while the decision time is before `expires_at`. Never extended.
- **Expiry is derived.** It does not change the stored intent state: an intent whose quote has expired is still stored as `QUOTED` or `USER_CONFIRMED`. No Increment 2 entry point raises `EXPIRED`; read functions report an effective status.
- **An expired quote authorizes nothing.** It cannot be confirmed and must not support any future payment authorization. The way forward is replacement.
- **Material change:** unit amount, currency, availability, quantity limit below the quoted quantity; merchant ID, the variant's product, merchant display name, product title, variant label; product description, variant specifications. An image path, or a revision number alone, is cosmetic.
- A material change makes the quote stale. In 2.1 `read_checkout` reports it. In 2.2 the challenge functions refuse it.
- Any future payment-capable authorization must re-validate and, on a material change, require a new quote and renewed buyer confirmation.

### 19.9 Capacity
Two separate limits, counted by query under the owner lock:
- At most **10 active or unresolved purchase groups per owner** (D-38). Not a lifetime limit. In Increment 2 a group is unresolved while any of its intents is stored as `QUOTED` or `USER_CONFIRMED`, whether or not its quote has expired.
- At most **10 intents per purchase group** (G2-14), counting every intent of the group.

Nothing is deleted, recycled or reclassified to make room. There is no lifetime cap.

### 19.10 Audit and side effects

**Invariant for `NOT_AUTHORIZED`.** When a request returns `NOT_AUTHORIZED`, the throttle row remains absent or every declared business-column value remains unchanged. No data-changing INSERT, UPDATE or DELETE is performed, and no audit, checkout or transition record is created. PostgreSQL internal tuple-lock metadata is not part of this invariant. `SELECT … FOR UPDATE` is a permitted non-data-changing locking read.

The same invariant applies to `REQUEST_INVALID`.

**Audit events.** Each row is written by the deciding entry point, in the same transaction, with a database-generated ID. No row contains a nonce, token, digest of either, or key material.

| Event | Written |
| --- | --- |
| `QUOTE_ISSUED` | Every successful `start_checkout` |
| `CHECKOUT_SUPERSEDED` | Every supersession |
| `CHECKOUT_REFUSED_AT_CAPACITY` | Every `AT_PURCHASE_CAPACITY` and `GROUP_INTENT_LIMIT` refusal; no quota |
| `CHECKOUT_CANCELED` | Every successful `cancel_checkout` |
| `OWNER_RATE_LIMITED` | First throttled call of a window |

**Permitted changes by outcome (2.1)**

| Outcome | Permitted data changes |
| --- | --- |
| `NOT_AUTHORIZED` (any step) | None |
| `REQUEST_INVALID` | None |
| `RATE_LIMITED` | `window_throttled`, `total_throttled`, `updated_at`; one audit row if first in the window |
| Success | Admitted-call counter; business rows; audit rows |
| Capacity refusals | Admitted-call counter; one audit row |
| Catalog refusals, `REPLACEMENT_NOT_ALLOWED`, `NOT_CANCELABLE` | Admitted-call counter |
| Error | None; everything rolls back |

### 19.11 Read functions
- Written in SQL; the body is exactly one `SELECT`; declared `STABLE`.
- No helper that reads a table may be called. `session_is_live` is permitted: it is immutable and reads nothing.
- Under `READ COMMITTED` one statement sees one snapshot, and every mutating call is one transaction. A result therefore never mixes two versions.
- Time is the statement's start time, returned as database time.
- They perform no data change and take no lock.
- **`read_checkout(p_key_version, p_token_digest, p_intent_id)`** always returns one row: `OK` or `NOT_AUTHORIZED`. With `OK` it returns:
  - the owner ID;
  - the intent: ID, group, stored state, version, effective status, predecessor and successor IDs;
  - the quote, with its immutable amounts, snapshot labels, digest and times;
  - a stale indicator;
  - from 2.2, the active challenge and whether it is usable;
  - database time.

  With `NOT_AUTHORIZED` every other column is NULL.
- **`list_owner_checkouts(p_key_version, p_token_digest)`** returns at most 100 rows, and none when not authorized.

### 19.12 Identifiers and reducer parity
- Group, intent, quote, transition-event and audit-event IDs are generated in the database. The challenge ID (2.2) is the only caller-supplied ID.
- The four permitted state changes are coded in one internal helper. It must match the TypeScript reducer on accepted (state, event, actor) combinations, the quote-match guard, pointer changes, version increment and transition record fields.

### 19.13 Privileges

| Role | Increment 2 |
| --- | --- |
| `shopaccess_web` | EXECUTE on the Increment 2 functions. No new table privilege |
| `shopaccess_definer` | SELECT on the three catalog tables; UPDATE on `checkout_owners` for locking only (its trigger rejects every update); SELECT, INSERT on `purchase_groups`, `quotes`, `quote_items`, `checkout_transitions`; SELECT, INSERT, UPDATE on `checkout_intents`, `confirmation_challenges`, `owner_request_windows` |
| `shopaccess_worker`, `shopaccess_operator`, PUBLIC | Nothing new |

### 19.14 Boundaries
- **Financial.** No payment table, state, event or function exists. The state and event checks reject payment values. The worker role has no grant.
- **Advisory.** No function accepts an assessment, budget or AI text; none enters a digest, summary or audit row.
- **Recovery (G2-29).** A checkout is reachable only through its live session. No recovery is promised. A recovery design is mandatory before payment-capable work.
- **Storage (G2-35).** Cumulative storage is unbounded and accepted for a finite local demonstration only. A lifecycle and capacity policy is mandatory before shared or public deployment.
- **Throttle scope.** The limit is per owner. Under accepted Increment 1 behaviour a newly admitted anonymous session receives a new owner and therefore a new counter. The limit is not a per-person, per-device or per-address abuse control.
- **Uncounted calls.** Calls ending in `NOT_AUTHORIZED` or `REQUEST_INVALID` are not counted by the database throttle. They change nothing.
- **Evidence.** Nothing in §19 has been executed. To be confirmed at first execution:
  - UPDATE privilege required for row locks;
  - key-share locks from foreign-key checks;
  - composite self-referencing keys onto unique constraints with a nullable column;
  - forcing deferred keys inside a function;
  - a row trigger rejecting a ring inserted in one statement;
  - statement snapshots after lock waits;
  - a stable single-query function returning one snapshot;
  - the isolation check.

### 19.15 Acceptance-test manifest, Increment 2.1 — ALL NOT EXECUTED

**Fixtures.** Where a test needs a stored state that no 2.1 function can produce, it uses a privileged fixture in the disposable test database: rows written directly by the test owner in one transaction. A fixture must satisfy every constraint, key and trigger of §19.2 and §19.3, and the existing audit table's constraints. No trigger is disabled and no constraint relaxed.

"No side effects" below means the invariant of §19.10. PGT-116 is not assigned.

| ID | Test | Expected |
| --- | --- | --- |
| PGT-101 | Inventory after migration | Seven new tables; the 2.1 functions; ledger rows and checksums match the inventory |
| PGT-102 | Privileges | Exactly the grants of §19.13; no DELETE; worker has nothing |
| PGT-103 | Catalog privilege, as function owner | SELECT succeeds; row lock, UPDATE, INSERT, DELETE refused |
| PGT-104 | Owner-row lock | Lock succeeds; every UPDATE on `checkout_owners` rejected by its trigger |
| PGT-105 | State and event checks | Payment states, payment events, other actors, and `DRAFT` as a stored state rejected |
| PGT-106 | Candidate keys | The five unique constraints exist and are not deferrable |
| PGT-107 | Reciprocity, direct writes | Successor without a marked predecessor → rejected at commit; pointer to a root, unrelated or missing intent → rejected at once; a correct pair commits |
| PGT-108 | Ancestry | Root's predecessor changed from NULL → rejected; predecessor changed to a descendant → rejected; two-row, three-row and fully reciprocal rings in one statement → rejected |
| PGT-109 | Concurrent ring attempt | At least one transaction rejected; no ring exists |
| PGT-110 | Successor pointer | Set without state change; changed; cleared; any update to a terminal row → each rejected |
| PGT-111 | New checkout, atomic | Exactly one group, intent, quote, item, transition, audit row; version 2; `QUOTED` |
| PGT-112 | Replacement, atomic | Exactly the rows of §19.3; a forced history violation leaves nothing |
| PGT-113 | Two concurrent replacements | One `STARTED`, one `REPLACEMENT_NOT_ALLOWED`; one successor; pointers agree |
| PGT-114 | Predecessor stored as `CANCELED_LOCAL`; separately, stored as `SUPERSEDED` | Each `REPLACEMENT_NOT_ALLOWED`; admitted-call counter rises by one; no other change |
| PGT-115 | Replace racing cancel | Both orders; the second is refused |
| PGT-73a, 73e | `SAQD-1` vectors; no amount or digest parameter | Three digests match in database and TypeScript |
| PGT-12 (reworded), PGT-117 | Reprice committed while `start_checkout` waits; reprice uncommitted | New price and revision together; old values with no blocking; never a mixture |
| PGT-118 | Catalog writer | Reprice neither waits nor blocks; variant deletion → error, nothing written |
| PGT-119 | Quote lifetime | `expires_at` exactly 15 minutes after `created_at`; other values rejected; effective status just before, at and after expiry; stored state unchanged by expiry |
| PGT-13 | Quote and item immutability | Update and delete rejected |
| PGT-120 | Material change reported | One case per material field → stale; image path or revision alone → not stale; snapshot labels unchanged after a rename |
| PGT-81a, b, d, e; PGT-121 | Group capacity; expired quotes still count | Refused at 10, permitted at 9; history not counted; concurrent starts never exceed 10 |
| PGT-122 | Intents per group | Tenth permitted, eleventh `GROUP_INTENT_LIMIT`; independent of the group limit |
| PGT-123 | Capacity refusal audit | N refusals → N audit rows, distinct IDs |
| PGT-124 | Throttle limit and boundary, from a missing row and from an existing row | 30 admitted, 31st `RATE_LIMITED`; a call at the boundary instant starts a new window; boundary burst of 60 admitted; `NOT_AUTHORIZED` calls in between consume none of the 30 |
| PGT-125 | Over-limit evidence, from a missing row and from an existing row | 100 over-limit calls → `total_throttled` 100, one audit row; next window → one more on its first over-limit call |
| PGT-126 | Throttle concurrency | Parallel calls → exactly 30 admitted |
| PGT-127 | Throttle scope. (a) A second live session for the same owner, inserted as a fixture. (b) A different owner. (c) Rotation after 20 admitted calls. (d) A newly admitted session | (a) Both credentials draw on one counter, 30 in total. (b) Independent counter. (c) Counter stays at 20. (d) New owner and new counter, as accepted Increment 1 behaviour |
| PGT-128 | Throttle fail-closed | Counter or audit write made to fail in a rolled-back test transaction → error, nothing written |
| PGT-129 | `REQUEST_INVALID`, each argument | Every rule of §19.7 violated in turn → `REQUEST_INVALID`; no side effects |
| PGT-130 | `REQUEST_INVALID`, placement | Returns while the owner row is held by the test owner; over the limit still `REQUEST_INVALID`; with an unknown, expired or revoked session → `NOT_AUTHORIZED` |
| PGT-131 | Well-formed missing intent ID and well-formed foreign intent ID, under the limit and over it | Under: both `NOT_AUTHORIZED`, no side effects, the foreign row never locked. Over: both `RATE_LIMITED` with identical counter changes |
| PGT-132 | Credential revalidation: each element of §19.6 varied. Key revocation cases A, B1, B2 of §19.6, and activation during a call. The same cases for session revocation and rotation | A: revocation waits on the session row; checkout completes successfully; revocation completes afterward; a later call is `NOT_AUTHORIZED`. B1 and B2: `NOT_AUTHORIZED`, no side effects. Activation: call succeeds. In case A the waiting backend is identified by the method of PGT-143 |
| PGT-133 | Transactions | A rolled-back call leaves no counter change or audit row; other isolation levels refused; static check that no entry point is wrapped |
| PGT-134 | Declared column values and row counts of all seven tables and the audit table, before and after every outcome, from both a row-absent and a row-present throttle state | Exactly the permitted changes of §19.10 |
| PGT-135 | Read function form | Static: SQL language, `STABLE`, one statement, no table-reading or volatile call |
| PGT-136 | Read coherence | Barrier: an uncommitted change is invisible, then visible whole. Stress: no mixed state. Control: a two-statement reader in the test database does show a mixed state |
| PGT-08, 09, 69c | Ownership | Expired or revoked session creates nothing; checkout survives session deletion; another owner's intent is unreachable |
| PGT-137 | Cancel | Success from `QUOTED`, and from a `USER_CONFIRMED` fixture; `NOT_CANCELABLE` from terminal states; one transition, one audit row |
| PGT-138 | Reducer parity | Database helper and reducer agree on every in-scope and out-of-scope case |
| PGT-139 | Generated IDs | Duplicate intent, quote, transition and audit IDs rejected by their constraints; static check that no 2.1 function handles a unique violation |
| PGT-140 | `list_owner_checkouts` | Own rows only; at most 100; empty when not authorized |
| PGT-141 | Regression | Every Increment 1 database test and the whole Mock suite still pass |
| PGT-142 | Replacement of a predecessor whose quote has expired: stored `QUOTED`; separately, stored `USER_CONFIRMED` (fixtures below) | Each `STARTED`. Successor: `QUOTED`, no confirmation, a new quote from the current catalog. Predecessor: `SUPERSEDED`; its quote row unchanged. Audit: the fixture's synthetic rows are unchanged, and exactly two rows are added, `QUOTE_ISSUED` for the successor and `CHECKOUT_SUPERSEDED` |
| PGT-143 | Session expiry while waiting on the intent lock (below) | `NOT_AUTHORIZED`, no side effects |
| PGT-144 | Missing throttle row. (a) An owner's first call exits `NOT_AUTHORIZED`. (b) The owner's first admitted call. (c) Two first calls for the same owner in parallel | (a) No row exists afterward. (b) One row, call count 1. (c) One row, call count 2, no error |
| PGT-145 | Existing throttle row. (a) `NOT_AUTHORIZED` within the window. (b) `NOT_AUTHORIZED` after the window has elapsed. (c) An admitted call after the window has elapsed. (d) A `RATE_LIMITED` call | (a), (b) Every declared column value unchanged, including window start and update time. (c) New window start, call count 1, window throttled count 0. (d) Only the two throttled counters and the update time change |

**PGT-142 fixtures.** Both predecessors are backdated fixtures: group, intent, quote, item and first transition inserted with past timestamps, the quote digest computed with the same internal helper `start_checkout` uses. Each fixture also inserts a synthetic `QUOTE_ISSUED` audit row for the intent, timed at the fixture's quote creation.

The `USER_CONFIRMED` fixture continues, in the same transaction:
1. A `confirmation_nonce` key version is made `ACTIVE` through the accepted operator function.
2. A challenge is inserted as `ACTIVE` for the quote, with times inside the quote's lifetime.
3. The challenge is updated to `CONSUMED`, with a consumption time between its issue and expiry.
4. The intent is updated to `USER_CONFIRMED`, version 3, with its confirmation pointer.
5. A transition `QUOTED → USER_CONFIRMED`, version 2 → 3, event `SHOPPER_CONFIRMED`, actor `shopper`, is inserted, timed at the consumption time.
6. **A synthetic `CONFIRMATION_ACCEPTED` audit row is inserted** (below).
7. At commit, the deferred quote key and the history check must pass.

**The synthetic `CONFIRMATION_ACCEPTED` row:**

| Audit column | Value |
| --- | --- |
| `event_id` | Generated in the database, in the same form the audit functions use |
| `event_type` | `CONFIRMATION_ACCEPTED` |
| `actor` | `shopper` |
| `occurred_at`, `recorded_at` | The challenge's consumption time, equal to the synthetic transition's time |
| `owner_id`, `checkout_intent_id` | The fixture's owner and intent |
| `session_id` | The fixture session's ID, or NULL if the fixture has none |
| `operation_id` | NULL |
| `detail` | An object holding only the synthetic transition's event ID, the challenge ID and the quote ID |

- It satisfies the existing audit table's constraints: event-type and actor formats, detail as an object within the size limit, unique event ID.
- It contains no nonce, token, nonce digest, token digest or key material.
- It is inserted by the test owner; the append-only triggers permit inserts and are not disabled.
- It exists only in the disposable test database.

**Fixture assertions, before the replacement call:**
- exactly one `QUOTE_ISSUED` row for the fixture intent;
- for the `USER_CONFIRMED` fixture, exactly one `CONFIRMATION_ACCEPTED` row, whose intent, owner, time and detail IDs match the challenge and the transition;
- no row's detail contains a 43-character nonce or a 64-hex digest.

`issue_challenge` and `consume_challenge` are neither implemented nor called, and their execution is not simulated: the fixture writes stored state directly.

**Stated limits:**
- The test shows replacement given a valid stored state, not that the 2.2 functions produce one.
- The audit rows of the fixture are synthetic; they show the fixture is internally consistent, not that any function writes them.
- The fixture relies on the intent update trigger checking structure and not the calling function.

**PGT-143 procedure.**
1. The blocker transaction records its backend ID and its transaction ID.
2. The blocker locks exactly the known target `checkout_intents` row.
3. The checkout request names that same intent.
4. The server reports the checkout backend's blocking backends as exactly the blocker.
5. The checkout backend has an ungranted transaction-ID lock request against the blocker's transaction ID.
6. The blocker performs no other row-locking operation.
7. The database clock is confirmed to be before the session's expiry while the checkout call is blocked.

Then the database clock is polled until it has passed the expiry, the blocker is released, and the result is verified.

- No fixed-duration sleep is used.
- A generic "waiting on a lock" check alone is insufficient.
- No tuple-level lock visibility is relied on.
- The test is run from a row-absent and from a row-present throttle state.

**Acceptance evidence for 2.1:** static suite passing; one isolated run on a newly initialized disposable PostgreSQL 17 cluster; preserved logs; independent audit.

### 19.16 Increment 2.2 and 2.3 — outside this contract; deferred gates

**Status.** This subsection records a boundary, not a contract. Increments 2.2 and 2.3 are **not approved** as requirements of this specification. Their proposed function behaviour, condition order, challenge lock sequence, result codes and tests are held in the Gate A design documents and are deliberately not recorded here. Sections 5.3 to 5.6 remain earlier proposed text.

**What Increment 2.1 already fixes for the later sub-increments (approved):**

- 2.1 creates the `confirmation_challenges` table with the constraints of §2.11. No 2.1 function inserts or updates a challenge.
- The parameter and return lists below are part of approved G2-07. The behaviour of the two functions is not approved.

| Function | Parameters after the credential | Returns |
| --- | --- | --- |
| `issue_challenge` | Intent ID, challenge ID, nonce key version, nonce digest | `result`, `challenge_id`, `quote_digest`, `nonce_key_version`, `nonce_digest`, `summary`, `expires_at` |
| `consume_challenge` | Challenge ID, nonce, quote ID, quote digest | `result`, `intent_id` |

- **Malformed against stale.** A malformed argument is `REQUEST_INVALID`, returned before any lock and before throttle admission, with no side effects (G2-39). A well-formed submission against a stale, expired or already-resolved confirmation is a business refusal, decided by the 2.2 functions. The 2.2 argument formats and those refusals are PROPOSED.
- **Audited refusals (G2-38).** Every `CONFIRMATION_MISMATCH`, `QUOTE_DIGEST_MISMATCH` and `CONFIRMATION_KEY_REVOKED` result writes one `CONFIRMATION_REJECTED` audit row. The conditions that produce those results are PROPOSED.
- The owner throttle counter is shared by every mutating function (§19.7, G2-34).
- No key-version row is locked after the session row (§19.6), and no catalog row is locked explicitly (§19.4).

**Increment 2.2 decisions**

| ID | Subject | Status |
| --- | --- | --- |
| G2-10 | Nonce derivation: HMAC-SHA-256 under the nonce key over label `shopaccess.confirmation.v1`, challenge ID, owner ID, quote digest; base64url output | PROPOSED |
| G2-13 | Challenge lifetime 5 minutes, capped at quote expiry; reuse if more than 60 seconds remain; at most 8 per quote | PROPOSED |
| G2-21 | Operator procedure to activate the nonce key | PROPOSED |
| G2-24a | In `consume_challenge`, a terminal challenge status (`CONSUMED`, `SUPERSEDED`) is evaluated before the revoked-key check; neither terminal result is audited | APPROVED (design, Increment 2.2 only); not applied in this specification |
| G2-24b | In `issue_challenge`, a missing or foreign intent follows the checkout-intent rule of §19.7 | APPROVED (design, Increment 2.2 only); not applied in this specification |
| G2-24 (remainder) | Challenge lock sequence, ownership check, throttle ordering, key status rules and the rest of the condition order | PROPOSED |
| G2-41 | A challenge may stay `ACTIVE` in storage after its intent is canceled, superseded or expired, and is then unusable | PROPOSED |

**Increment 2.3 decisions — all PROPOSED**

| ID | Proposal |
| --- | --- |
| G2-16 | Configuration names; refuse to start if anything is missing |
| G2-17 | Catalog read from the database, uncached |
| G2-18 | The checkout page changes nothing on load. A "Review again" button posts a guarded request for a valid challenge, which is reused or newly issued according to the challenge policy |
| G2-19 | In-process request limits remain a first line only |
| G2-20 | Browser download for automated browser and keyboard tests |

**Deferred gates**

| Gate | Required first |
| --- | --- |
| Payment-capable work | Recovery design (G2-33); consent authority (D-57); adapter policy (D-53); worker values (D-47, D-26, D-18, D-20, D-22); provider evidence authentication and §16; reconciliation of the dispatch lock order with §19.4 |
| Shared or public deployment | Lifecycle and capacity policy (G2-35, D-11); hosted secret isolation (D-54); shared rate limiting; monitoring; backups |

### 19.17 Increment 2 decision register

*APPROVED* means approved by the owner. *APPROVED (design)* means approved for design purposes only. Neither authorizes implementation or execution. *PROPOSED* means not approved.

| ID | Decision | Status |
| --- | --- | --- |
| D-38 | 10 active or unresolved purchase groups per owner | APPROVED |
| G2-06 | Capacity classification (A) | APPROVED |
| G2-09 | Narrow deferral of `append_web_audit` | APPROVED |
| G2-12 | Quote lifetime 15 minutes | APPROVED |
| G2-14 | 10 intents per purchase group | APPROVED |
| G2-29 | Recovery deferred for the local non-payment MVP; mandatory before payment work | APPROVED |
| G2-34 | 30 mutating calls per owner per 60 seconds | APPROVED |
| G2-35 | Unbounded storage for a finite local demonstration only | APPROVED |
| G2-36 | Identity and description changes are material | APPROVED |
| G2-37 | Generated-ID collisions are errors | APPROVED |
| G2-38 | Audit the three confirmation-integrity refusals | APPROVED |
| G2-01 | Scope ends at `USER_CONFIRMED` | APPROVED (design) |
| G2-02 | Seven tables and their constraints | APPROVED (design) |
| G2-03 | F-4 and R-B deferred; F-5 and R-A immediate | APPROVED (design) |
| G2-04, G2-23 | Catalog snapshot; SELECT-only catalog privilege | APPROVED (design) |
| G2-05, G2-28 | Owner-row lock in every mutating function | APPROVED (design) |
| G2-07, G2-31, G2-40 | Function signatures; single read function; stable single query | APPROVED (design) |
| G2-08 | Refusal side effects | APPROVED (design) |
| G2-11 | One transition helper with parity tests | APPROVED (design) |
| G2-15 | Edits to inventory-hard-coded tests, under the write gate | APPROVED (design) |
| G2-25 | Replacement rules | APPROVED (design) |
| G2-26 | Database-generated IDs | APPROVED (design) |
| G2-30 | `READ COMMITTED` required | APPROVED (design) |
| G2-39 | Malformed requests rejected before throttle admission, no side effects | APPROVED (design) |
| — | Capacity counted by query; list limit 100 | APPROVED (design) |
| G2-24a, G2-24b | Two Increment 2.2 design choices (§19.16) | APPROVED (design, Increment 2.2 only); not applied |
| G2-10, 13, 21, 41; G2-24 remainder | Increment 2.2 | PROPOSED |
| G2-16, 17, 18, 19, 20 | Increment 2.3 | PROPOSED |
| G2-22 | Git preservation | PROPOSED, independent |
| G2-33 | Recovery design | DEFERRED |
| G2-27, G2-32 | Refusal quota; lifetime intent cap | WITHDRAWN |

---

## Appendix A — Findings-to-requirements traceability (non-normative)

Identifiers that recur across audits are prefixed with the audit they came from. "Summary" means the finding was seen only as an owner-relayed summary.

| Finding | Source | Subject | Resolved in |
| --- | --- | --- | --- |
| PG-001 | v1.0 review | Session admission and lifecycle concurrency | §2.2, §4.5, §13 |
| PG-002 | v1.0 review | Credential expiry versus ownership | §2.4, §2.5, §4.1 |
| PG-003 | v1.0 review | Atomic settlement and history | §8.5, §2.18, §10 |
| PG-004 | v1.0 review | Challenge lifecycle | §2.11, §5.4 to §5.6 |
| PG-005 | v1.0 review | Recovery-worker fencing | §2.14, §12.2 |
| PG-006 | v1.0 review | Reconcile migration drafts | §2, §14 |
| PG-007 | v1.0 review | Evidence and audit bounds | §9 |
| AR-001 | Review 002 | Committed dispatch invisible to recovery | §2.13 scheduling CHECKs, §7.3 |
| AR-002 | Review 002 | Expiry after lock waits | §13.2, §2.5 trigger |
| AR-003 | Review 002 | Composite key targets | §2.22 |
| AR-004 | Review 002 | I-10 versus non-claimant transitions | §1.4 I-10, §8.6 |
| AR-005 | Review 002 | Challenge status regression | §2.11 triggers |
| AR-006 | Review 002 | Distinct partial refunds | §2.16, §9.9 |
| AR-007 | Review 002 | Session-key durability | §2.3, §4.2 |
| E-1 | v1.1 erratum | Coherence table | §7.4 |
| E-2 | v1.1 erratum | Resend safety | §12.4, §12.5 |
| E-3 | v1.1 erratum | Variant lock order | §13.4 |
| E-4 | v1.1 erratum | Review transition without evidence | §8.7 |
| E-5 | v1.1 erratum | Fencing across recovery steps | §12.2 |
| RA003 C-01 | Re-Audit 003 | Key rotation and capacity | §2.3, §2.5, §4.2 |
| RA003 C-02 | Re-Audit 003 | Claim acquisition | §12.2 |
| RA003 C-03 | Re-Audit 003 | Verifiable resend | §2.13 `provider_call_deadline_at`, §12.4 |
| RA003 C-04 | Re-Audit 003 | Refund fingerprint | §9.9, §9.10 |
| RA003 C-05 | Re-Audit 003 | Refund and capture integrity | §2.16, F-12, F-13 |
| RA003 C-06 | Re-Audit 003 | Challenge purge safety | §2.9 CHECK, F-5 |
| RA003 C-07 | Re-Audit 003 | Clarifications | §2 (non-deferrable keys), §12.3 |
| AR-008 | Re-Audit 004 | Contradictory quarantined evidence | §9.4 to §9.7 |
| AR-009 | Re-Audit 004 | Confirmation pointer NULL bypass | §2.9 CHECK |
| RA005 F1 | Re-Audit 005 (summary) | Unsafe capture redispatch | §6.3, §6.4 |
| RA005 F2 | Re-Audit 005 (summary) | Transition observation NULL bypass | §2.18 CHECK |
| RA005 F3 | Re-Audit 005 (summary) | Role-aware reconciliation | §9.3 to §9.5 |
| RA005 F4 | Re-Audit 005 (summary) | Reason consistency | §9.8 |
| RA005 A, B | Consistency addendum | "Not found" precedence; V-16 | §9.4; TA-16 in §15.3 |
| RA005 final note | Final consistency note | Late evidence by arrival time | §9.7 |
| RA006 | Re-Audit 006 (summary) | Terminal-decline finality | §6.3 E-5, §7.6 |
| RA007 C-01 / D-32 | Re-Audit 007 (summary) | Cross-intent duplicate payment | §6 |
| RA007 C-02 | Re-Audit 007 (summary) | Adapter-contract binding | §7.1, §7.5 |
| RA008 C-01 | Re-Audit 008 (summary) | Refusal ordering | §8.2 |
| RA008 C-02 | Re-Audit 008 (summary) | Direct-insert bypass | §3 |
| RA008 C-03 | Re-Audit 008 (summary) | Acknowledgment bound to risk | §11 |
| RA008 C-04 | Re-Audit 008 (summary) | Paid versus disputed | §6.2 |
| RA008 C-05 | Re-Audit 008 (summary) | Withdrawal race | §13.5, §8.2 |
| RA008 C-06 | Re-Audit 008 (summary) | Explicit dispatch approval | §7.5 |
| RA009 1 | Re-Audit 009 (verbatim) | Partial operation updater | §8.5, CT-1 |
| RA009 2 | Re-Audit 009 | Forged evidence | §3.2, §9 |
| RA009 3 | Re-Audit 009 | Dispatch session authority | §4.4, §8.1 |
| RA009 4 | Re-Audit 009 | Direct checkout mutation | §3.2, §10.1 |
| RA009 5 | Re-Audit 009 | Finality in the fingerprint | §11.1 |
| RA009 6 | Re-Audit 009 | Fingerprint serialization | §11.2 |
| RA009 7 | Re-Audit 009 | Commit boundary | §12.1 |
| RA010 C-13.1 | Complete Codex Re-Audit 010 (`~/Downloads/ShopAccess_AI_Codex_Reaudit_010_Full.txt`) | Shared web/worker role, reconstructible claim, and ingestion authority | §3, §2.12, §2.14, §8.1, §8.2 |
| RA010 C-13.2 | Complete Codex Re-Audit 010 (same source) | Operator inserts already-approved contract | §2.20, §7.5 |
| RA010 C-13.3 | Complete Codex Re-Audit 010 (same source) | Quote digest not database-verified | §5.1, §5.2, §5.5, §5.6 |
| RA010 C-13.4 | Complete Codex Re-Audit 010 (same source) | Incomplete entry-point event allowlist | §10.2 |
| RA010 partially resolved finding | Complete Codex Re-Audit 010 (same source) | Evidence integrity and shared application role's authority to call ingestion functions | §3, §8.5–§8.9, §9; proposed role boundary and evidence trust limitation |
| RA011-001 | Re-Audit 011 (findings as stated in Directive 014; report not retained locally, §17.3) | Cross-owner database reads by the web role | §1.4 I-21, §3.2, §3.3, §3.5, §4.4, §5.4, §6.5; tests PGT-77a to j, V-24 |
| RA011-002 | Re-Audit 011 (same) | Finality approval without conformance evidence | §1.4 I-19, §2.20, F-25, F-26, §6.3, §7.5 to §7.7, D-30, D-56; tests PGT-78a to k, RF-A to RF-F, V-23 |
| RA011-003 | Re-Audit 011 (same) | Nullable composite-key components | §2.15, §2.16, §2.22 note, D-52; tests PGT-55a to g |
| RA011-004 | Re-Audit 011 (same) | Web-process consent trust boundary | §3.4 consent boundary, §5.3, §17.4 item 3, D-57; PGT-79 (asserted limitation) |
| AR012-001 | Re-Audit 012 (as stated in Directive 015; report not retained locally) | Suite retirement leaves approved finality usable | §2.20 (CT-2, `withdrawn_reason`), §6.3 E-5, §7.7, §11.3, §13.3, §13.5, §13.6; tests PGT-78m to r, RF-A to RF-F, V-23 |
| AR012-002 | Re-Audit 012 (same) | Evidence-to-suite foreign key without a referenced key | §2.20 U-S1, §2.22 F-27, §14 step 0005; test PGT-78l |
| AR012-003 | Re-Audit 012 (same) | Nullable F-10 operation citation | §2.18 actor CHECK, §2.22 note, §10.3; tests PGT-55h to k, V-25. F-10 has since been replaced by F-10T (M-2) |
| AR012-004 | Re-Audit 012 (same) | Refund transition misdescribed as new behaviour | §17.2 row 7, §17.5 C row 7; tests PGT-80a to c |
| Owner record, Groups 1–10 | Owner decision record, supplied in the conversation | Decision statuses; ten differences approved for PostgreSQL mode only | §17.1, §17.2, §17.5 status note, §17.6, §17.7 |
| M-1 | Codex documentation audit (conditional pass), as stated in the owner's correction instruction | Purchase-group capacity semantics | §6.6, §17.1 D-38, §17.7; tests PGT-81a to e |
| M-2 | Same | F-10 and F-10T ambiguity | §2.18, §2.22, §10.3, §14 steps 0007 and 0009; tests PGT-55j, PGT-55l, V-25 |
| M-3 | Same | Concurrent continuations under the D-46 exception | §8.2, §12.1, §12.1a; tests PGT-82a to g |
| Draft expiry | Same | Draft-expiry boundary had no test | §8.10, §17.7; tests PGT-83a to f |
| Owner approvals after targeted verification | Owner instruction following Codex's verification of M-1 to M-3 and draft expiry | 10 active groups; conservative classification; F-6T and F-7T type columns; single-threaded worker and non-evictable capture guard; draft expiry 24 hours from creation with pre-worker refusal | §2.9, §2.22, §5.2, §6.6, §8.10, §12.1a, §12.3, §14, §17.1, §17.6, §17.7; tests PGT-55l, PGT-81a to e, PGT-82c, d, f, PGT-83a to f, V-25 |
| Gate A, Increment 1 | Owner's final Gate A approval | Owner ID generation; session row version; check value and key ring; schemas and function owner; integrity checks; PostgreSQL-mode cookie; test clock; operator audit events; six functions; nine tables; nine approved values | §2.1, §2.3 to §2.6, §2.21, §3.1, §3.3, §3.5, §4.2, §4.4, §4.5, §13.1, §14, §15.1 (PGT-84 to 90), §17.1, §17.4, §17.6, §17.7, §18 |
| Gate B-W, Increment 1 | Owner's Gate B-W authorization | Key-ring configuration approved; drafts archived; contiguous numbering; library not wired; test-harness variable; implementation written and never executed | §14, §17.1 (D-3, D-21), §17.6, §17.7, §18.1, §18.5, §18.9 to §18.11 |
| Independent audit of Increment 1 (verdict FAIL) | Owner's targeted-correction authorization | Nine corrections written under Gate B-W; none executed | §18.12 |
| Re-audit of Increment 1 (verdict CONDITIONAL PASS) | Owner's final-hardening authorization | Five corrections written under Gate B-W; none executed | §18.13 |
| Third audit of Increment 1 (verdict CONDITIONAL PASS) | Owner's two-issue authorization | Lock-owning session for cluster-level statements; case-insensitive SQL-01; none executed | §18.14 |
| Gate B-X executions and final acceptance audit (verdict CONDITIONAL PASS) | Owner's two Gate B-X authorizations, the test-only remediation authorization and the documentation-closure authorization | First run 38 passed, 3 failed (test defects); second run 41 passed, 0 failed, 0 skipped; formally accepted by the project owner afterwards | §18.15 |
| B-1 to B-13 | Owner Decision Reconciliation package | Thirteen inconsistencies | §2.20, §3.3, §6.6, §7.5, §7.7, §14, §10.2, §12.1, §9.9, §17.1 (D-15, D-49), §2.18, §2.22, §10.3; report §12 |
| AUD-013 | Foundation audit (summary) | Contradictory evidence after capture stays visible | §8.8, §2.17 |
| AUD-014 | Foundation audit | Unknown | **HOLD (§17.3)** |

Milestone 001 findings AUD-001 to AUD-003, AUD-011 and AUD-012 concern the in-memory foundation and are closed there; they are recorded in `docs/correction-report-002.md` to `004.md`.

---

## Appendix B — Supersession register (non-normative)

**Not superseded.** These remain the record of Milestone 001:

| Document | Standing |
| --- | --- |
| Security Foundation Specification v1.1 (owner) | Governs Milestone 001 |
| `docs/implementation-report.md`, `docs/correction-report-002.md`, `003.md`, `004.md`, `docs/security-foundation.md` | Milestone 001 records |
| `db/migrations/0001` to `0006` | Unexecuted drafts; untouched; to be replaced only if D-3 is approved |

**Superseded as normative text by this document.** Historical only:

| Document | Form |
| --- | --- |
| PostgreSQL Persistence & Recovery Specification v1.0 | Never seen by the author of this document |
| PostgreSQL Schema Reconciliation Report 001 | Chat response |
| Specification v1.1, first complete draft | Chat response |
| Specification v1.1 Complete Revised Draft, Parts 1 to 3, with errata E-1 to E-5 | Chat responses |
| Specification v1.2, Correction Report 005, Parts 1 and 2 | Chat responses |
| Specification v1.3, Correction Report 006 | Chat response |
| Correction Report 007 | Chat response |
| Correction Report 008, its Consistency Addendum and Final Consistency Note | Chat responses |
| Correction Reports 009, 010, 011, 012 | Chat responses |
| Correction Report 013 | `docs/postgresql/correction-report-013.md`; kept as the record of the latest changes |

**Retired design elements.** These appear in earlier documents and are not part of v2.0:

| Element | Replaced by |
| --- | --- |
| Session ID as the ownership key | Owner ID |
| `confirmations` with one replaceable row per quote; a challenge per page view; a cap of 20 | `confirmation_challenges` with reuse |
| Application-supplied timestamps with a skew tolerance | Database time |
| `refund_extent`; `refund_ids_digest` | Refund ledger; `refund_facts_digest` |
| `next_recovery_at IS NULL` meaning parked | `parked_at` |
| Claim token of operation ID, fencing version and worker ID | Secret claim credentials |
| `update_claimed_operation`; `dispatch_operation`; a single application role | Complete entry points; authorization and claim; web and worker roles |
| Application INSERT on evidence tables and UPDATE on checkouts | No application write privileges |
| `reconciliation_outcome` supplied by the application | Computed by the database |
| In-code list of adapters with approved finality; `server_key_checks` as optional | `adapter_contract_finality`; `server_key_versions` |
| Operator INSERT and UPDATE on registry tables; self-registration conferring dispatch | Operator functions; `DISCOVERED` only |
| Per-intent capture guard; reason-specific guard; permanent pair acknowledgment | Purchase-group rules; fingerprint-bound acknowledgment |
| V-16 as a retrospective query | TA-16 |
| Per-intent partial unique index on live captures | Per-purchase-group index |
| Quote digest computed by the application | `SAQD-1` computed by the database |

---

*End of PostgreSQL Specification v2.0 — DRAFT, NOT APPROVED.*
