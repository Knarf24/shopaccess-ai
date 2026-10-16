# ShopAccess AI — PostgreSQL Persistence & Recovery Specification v2.0

**DRAFT — ARCHITECTURAL POLICIES RECORDED AS OWNER-APPROVED (§17.1) — INCREMENT 1 WRITTEN UNDER GATE B-W (§18.11) — INDEPENDENT AUDIT VERDICT FAIL, TARGETED CORRECTIONS WRITTEN AND NOT EXECUTED (§18.12) — RE-AUDIT VERDICT CONDITIONAL PASS, FINAL HARDENING WRITTEN AND NOT EXECUTED (§18.13) — THIRD AUDIT VERDICT CONDITIONAL PASS, TWO-ISSUE CLOSURE WRITTEN AND NOT EXECUTED (§18.14) — INCREMENT 1 EXECUTED UNDER GATE B-X ON A DISPOSABLE POSTGRESQL 17.11 CLUSTER: SECOND RUN 41 PASSED, 0 FAILED, 0 SKIPPED (§18.15) — INCREMENT 1 FORMALLY ACCEPTED BY THE PROJECT OWNER — INCREMENT 2.1 DOCUMENTATION INDEPENDENTLY REVIEWED; DESIGN-ONLY, NOT IMPLEMENTED OR DATABASE-TESTED — INCREMENT 2 GATE A CLOSED BY THE PROJECT OWNER AS A DESIGN-ONLY ARCHITECTURE REVIEW MILESTONE (§19) — NO OTHER DATABASE EXECUTION AUTHORIZED — INCREMENT 2 GATE A CONTRACT RECORDED (§19): INCREMENT 2.1 APPROVED FOR DESIGN ONLY — INCREMENT 2.1 EXACT-SCHEMA CONTRACT APPROVED FOR DESIGN, CONDITIONAL ON LATER POSTGRESQL 17 EXECUTION EVIDENCE; NOT IMPLEMENTED, NOT EXECUTED — EVERY OTHER LATER INCREMENT NOT APPROVED IN DETAIL — NO IMPLEMENTATION OF ANY LATER INCREMENT AUTHORIZED**

| | |
| --- | --- |
| Status | Consolidated draft for independent review |
| Consolidates | Specification v1.1, v1.2, v1.3 and Correction Reports 007 to 013, with Targeted Corrections 014 (RA011-001 to RA011-004) and 015 (AR012-001 to AR012-004) applied in place |
| Normative text | Sections 1 to 19 of this document only. For Increment 1, §18 governs where an earlier section differs. For Increment 2, §19 governs where an earlier section differs |
| Non-normative | Appendices A and B, and every earlier document listed in Appendix B |
| Verification | **Increment 1 only: executed.** Its bootstrap file, six migrations and seven database test files ran on a disposable PostgreSQL 17.11 cluster under Gate B-X; the record, its evidence and its limits are in §18.15. **Increments 2.1 and 2.2: executed on disposable test clusters only.** Migrations `0007`, `0008` and `0009` and their database tests ran in six disposable-cluster runs (A3-E1, A3-E2, B-E1, B-E2, C-E1, C-E2); three of the six failed one or more tests and are kept as failed runs, and the last of each pair passed. **Increment 2.3, the opt-in application mode: written and never run**, with or without a database. §19.18 records exactly what was written and what ran, and no owner acceptance of Increment 2.1, 2.2 or 2.3 is recorded. **Everything else: none executed.** For every later increment, each statement about constraints, locking, atomicity and privileges is design reasoning, and no SQL, migration or database test has been run. Sections written before the Gate B-X runs, including §18.11 to §18.14, say that nothing had been executed; that was true when they were written and they are kept as written |

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
| 002 | PostgreSQL persistence and recovery, as specified here, against the mock adapter only | **Increment 1 only** (sessions, keys, catalog, audit table): written under Gate B-W and executed under Gate B-X on a disposable cluster (§18.11 to §18.15); formally accepted by the project owner, and the accepted baseline remains unchanged; not wired into the application. **Increment 2.1:** an independently reviewed, design-only specification (§19); not implemented and not database-tested. The project owner closed Increment 2 Gate A as a design-only architecture review milestone; the closure authorizes no implementation, migration-writing, database execution or deployment. **Every later increment: not authorized.** Planning and review only |
| Later gates | Real PayPal, external AI, Channel3, public deployment | Not authorized; requirements in §16 |

### 1.2 Scope of this document

In scope: the durable schema, database roles, trusted entry points, transaction protocols, evidence handling, recovery, and the tests that would verify them.

Out of scope: user interface, the mock adapters' internals, any real provider, hosting, and the resolution of manual-review items (D-12).

No assumption from any other project's payment provider, database platform or hosting is carried into this document.

Product intent is recorded in `docs/product-governance.md` (October 12, 2026). The bounded engineering scope of this specification does not replace that wider intent. The cross-reference authorizes no live call, payment execution, deployment, database change, or change to a gate in §1.1 or §16.

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

**Increment 2.1 (§19.2, §19.3).** The table created in Increment 2.1 has only the thirteen columns, the five stored states and the constraints of §19.2 and §19.3. The table below is the full-milestone design. `provider`, the operation pointers and their type columns, `capture_dispatched`, the provider IDs, the `DRAFT` default and version 1 are not created in Increment 2.1; a later increment would add them by migration.

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
| `catalog_revision` | integer > 0. In Increment 2.1 this is the **variant's** `catalog_revision` from the catalog snapshot (A-7) |
| `subtotal_cents`, `total_cents` | bigint > 0; in Increment 2.1 at most 20,000,000 (A-4) |
| `discount_cents`, `tax_cents`, `shipping_cents` | bigint, CHECK each `= 0` |
| `currency` | text, CHECK `= 'USD'` |
| `assumptions_code` | text NOT NULL, CHECK `= 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1'` (A-6): the value the vectors of §15.2 already use |
| `created_at`, `expires_at` | timestamptz; CHECK `expires_at = created_at + interval '15 minutes'`. Owner-approved for PostgreSQL mode (G2-12). The Mock's equal value is a separate, earlier approval |
| `digest` | text NOT NULL UNIQUE, 64 hex |
| `digest_version` | text NOT NULL, CHECK `= 'SAQD-1'` |

CHECK `total_cents = subtotal_cents - discount_cents + tax_cents + shipping_cents`. Unique: `(id, owner_id)`, `(id, checkout_intent_id)`, `(id, checkout_intent_id, owner_id)`. In Increment 2.1 also `(checkout_intent_id)`: one quote per intent (A-11).

**`quote_items`**: `quote_id` FK, `line_number` CHECK `= 1`, `product_id`, `variant_id`, `quantity` 1..10, `unit_amount_cents` > 0, `line_subtotal_cents` CHECK `= unit_amount_cents * quantity`; PK `(quote_id, line_number)`; F-14 `(variant_id, product_id)` to `merchant_variants (id, product_id)`. In Increment 2.1 the amount columns are `bigint`, `unit_amount_cents` is at most 2,000,000, and every committed quote has exactly one item, whose `line_subtotal_cents` equals the quote's `subtotal_cents` (§19.3).

Both tables are immutable: triggers reject UPDATE, DELETE and TRUNCATE. Index: `quotes (expires_at)`.

### 2.11 `confirmation_challenges`

One row per issued challenge.

| Column | Type and rule |
| --- | --- |
| `id` | text PK (`cf_…`): `cf_` + 32 lowercase hex, supplied by the caller (G2-07, A-5) |
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
- Delete: **rejected for every row, in every status, in Increment 2.1** (A-8). TRUNCATE rejected. No purge exists. An earlier draft permitted deleting `SUPERSEDED` and `EXPIRED` rows; any such purge would need a later migration and a separate owner decision (D-11).

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

Field order: quote ID; owner ID; intent ID; purchase group ID; merchant ID; product ID; variant ID; catalog revision (the variant's, A-7); quantity; unit amount; subtotal; discount; tax; shipping; total; currency; assumptions code (`SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1`, A-6); created-at and expires-at as microseconds since the Unix epoch, UTC.

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

**Amended for Increment 2.3 (decision D1, §19.19; approved by the owner).** The last sentence of the first paragraph above, "Otherwise it calls `issue_challenge`", no longer describes the read path. In the application mode of §19.19 the read path sends `read_checkout` and nothing that writes a checkout row: a page load never issues a challenge. A challenge is asked for only by a guarded POST: once inside `POST /checkout/start`, after `start_checkout` has answered `STARTED`, and afterwards by the shopper's "Review again" (`POST /checkout/[intentId]/review`). The reuse conditions above are unchanged and are decided by the database: `read_checkout` reports whether the ACTIVE challenge is usable, and `issue_challenge` reuses it or issues another by its own policy. The web process additionally shows a challenge only when the nonce it derives again hashes to the stored digest. Refreshing, navigating and opening a second tab still show the same challenge.

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

Increment 2 continues at `0007`. Planned split: schema, then functions (2.1); challenge functions (2.2). File names are fixed when written. The 2.1 schema file is `0007_checkout_schema.sql`. The 2.1 functions file is `0008_checkout_functions.sql`: one file carries the internal helpers, the four entry points and every grant of §19.13. Which of these files has been written, and which has been executed, is recorded in §19.18 and nowhere else. For 2.1 the schema file is default-deny: it contains no GRANT. Neither 2.1 file runs a top-level INSERT, UPDATE or DELETE on the seven tables; statement text inside a `CREATE FUNCTION` body is not migration-time DML (§17.4, item 25). The function owner's table grants and the web role's EXECUTE grants belong to the functions file (§19.13). The 2.2 confirmation functions file is `0009_confirmation_functions.sql`, one file (decision 12, §19.17). It creates no table. It adds `issue_challenge` and `consume_challenge`, puts a 41-column `read_checkout` in the place of the 33-column one of `0008`, and carries the two table grants and three EXECUTE grants of §19.13. It is the only migration that contains a `DROP` or a role command, and it contains exactly three such statements, adjacent and in this order: `SET ROLE shopaccess_definer;`, `DROP FUNCTION shopaccess_api.read_checkout(smallint, text, text);`, `SET ROLE shopaccess_owner;` (§19.16).

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
| PGT-57 | Illegal status changes; insert with terminal status; binding column change; delete of a row in any status; pointer pairs `(NULL, 'CONSUMED')` and `(non-NULL, NULL)`; pointer at a non-consumed or foreign challenge | All rejected. No purge exists in Increment 2.1 (A-8). In Increment 2.1 the structural cases are PGT-149 and PGT-150 (§19.15) | S |
| PGT-73a | Vectors V1 to V3 encoded in the database and in TypeScript | V1 `cbb8289475d0e6784dae938e4038a5fd54dbb423d350adf3f4fbebf7b4cde944`; V2 `1763b05d5e4118f0d7dfac99e0f57c61e80eddbe02f52166e1c79fbddfe4b39c`; V3 `1eebb6d9507c3efdb5e094cad29230150dca6c834c7d20a5f8022d20be13d693` | P |
| PGT-73b, c, d | Stored digest altered before issue; before consume; buyer submits a different digest | `QUOTE_DIGEST_MISMATCH` or `CONFIRMATION_MISMATCH`; nothing confirmed | P |
| PGT-73e | `start_checkout` given an amount or digest | No such parameter | S |

Vector inputs: owner `own_` + 32 × `2`; intent `ci_` + 32 × `3`; group `pur_` + 32 × `4`; merchant `dmm_shopaccessdemo`; product `dmp_codebook15`; variant `dmv_codebook15a`; revision 1; discount, tax, shipping 0; `USD`; assumptions `SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1`; created 1791460800000000; expires 1791461700000000. V1: quote `qt_` + 32 × `1`, quantity 1, amounts 79900. V2: quote `qt_` + 32 × `a`, quantity 2, subtotal and total 159800. V3: as V1 with amounts 79901. Each encodes to 411 bytes. The vectors were computed by a scratch script and have not been checked against a database.

**Expansion of the vector inputs above (B-9).** The block below writes out, field by field, the inputs stated in the paragraph above. It adds no new vector and changes no digest. Three things in it are not stated word for word above and are reconstructions: (1) "amounts 79900" in V1 is read as unit amount, subtotal and total each 79900; (2) V2's unit amount is 79900, which the paragraph does not state and which follows from quantity 2 and subtotal 159800; (3) "amounts 79901" in V3 is read as unit amount, subtotal and total each 79901. The two timestamps are the stated microsecond values written as UTC times. If an implementation does not reproduce a digest of PGT-73a from these inputs, the implementation or this expansion is wrong; the expected digests are not changed to fit it.

```text
Common to V1, V2 and V3 (stated above)
  field  2  owner ID           own_22222222222222222222222222222222
  field  3  intent ID          ci_33333333333333333333333333333333
  field  4  purchase group ID  pur_44444444444444444444444444444444
  field  5  merchant ID        dmm_shopaccessdemo
  field  6  product ID         dmp_codebook15
  field  7  variant ID         dmv_codebook15a
  field  8  catalog revision   1
  field 12  discount           0
  field 13  tax                0
  field 14  shipping           0
  field 16  currency           USD
  field 17  assumptions code   SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1
  field 18  created at         1791460800000000   (2026-10-08T12:00:00.000000Z)
  field 19  expires at         1791461700000000   (2026-10-08T12:15:00.000000Z)

V1
  field  1  quote ID           qt_11111111111111111111111111111111    (stated)
  field  9  quantity           1                                       (stated)
  field 10  unit amount        79900                                   (reconstructed from "amounts")
  field 11  subtotal           79900                                   (reconstructed from "amounts")
  field 15  total              79900                                   (reconstructed from "amounts")
  expected  cbb8289475d0e6784dae938e4038a5fd54dbb423d350adf3f4fbebf7b4cde944

V2
  field  1  quote ID           qt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa    (stated)
  field  9  quantity           2                                       (stated)
  field 10  unit amount        79900                                   (reconstructed; not stated for V2)
  field 11  subtotal           159800                                  (stated)
  field 15  total              159800                                  (stated)
  expected  1763b05d5e4118f0d7dfac99e0f57c61e80eddbe02f52166e1c79fbddfe4b39c

V3
  field  1  quote ID           qt_11111111111111111111111111111111    (stated: as V1)
  field  9  quantity           1                                       (stated: as V1)
  field 10  unit amount        79901                                   (reconstructed from "amounts")
  field 11  subtotal           79901                                   (reconstructed from "amounts")
  field 15  total              79901                                   (reconstructed from "amounts")
  expected  1eebb6d9507c3efdb5e094cad29230150dca6c834c7d20a5f8022d20be13d693

Encoding (§5.1): ASCII "SAQD", 0x01, 0x0013, then the 19 fields in order.
  Text fields (type 0x01) have byte lengths 35, 36, 35, 36, 18, 14, 15 for
  fields 1 to 7, 3 for field 16 and 37 for field 17.
  Integer fields (type 0x02) have length 8, big-endian two's complement.
```

**`SADT-1` targets (B-7): proposed outside a database, and since computed by PostgreSQL.** `SADT-1` is defined in §19.2. The two targets below were computed outside a database and were recorded here, before any execution, as proposed targets. Run B-E2 (§19.18) then executed PGT-120 on PostgreSQL 17.11: `descriptive_terms_digest` computed both in the database and both equalled the targets below, for the inputs written here. The same run executed the database side of PGT-73a: `quote_digest_saqd1` gave the three `SAQD-1` digests above. The separate qualification about those three vectors stands: some of their amount inputs are reconstructions of the wording above, as the expansion (B-9) records. A mismatch is not resolved by editing a target or the implementation to agree: it is investigated and reported, with what PostgreSQL returned, before anything is changed.

```text
D1  description (74 bytes)
      A 15-inch laptop with extra memory and storage for programming coursework.
    specifications text (164 bytes): the text PostgreSQL 17 is PREDICTED to print
    for the seeded specifications of dmv_codebook15a, on one line:
      {"cpu": "8-core mobile processor", "ramGb": 16, "weightKg": 1.8, "storageGb": 512, "storageType": "SSD", "screenInches": 15.6, "operatingSystem": "Windows 11 Home"}
    encoded length 255 bytes
    target  69cf467b84e343c9678a70122b7d3dd50bd61117dfff28e08ac175300957c47e

D2  description (22 bytes): Café laptop – 15″      (U+00E9, U+2013, U+2033)
    specifications text (14 bytes): {"note": "é"}
    encoded length 53 bytes
    target  6bad0dfbbca9c34e18f8a72f28f22cdd9f4ed70a088cdfe4e4872b55f655b685
```

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

Nothing in this section is authorized. An offline Channel3 adapter does not open any gate in this section. Each item must be settled before the corresponding gate opens.

| Gate | Required first |
| --- | --- |
| PayPal Sandbox | A migration widening the `provider` CHECKs. A PayPal adapter contract with its own status order, replay declaration and finality clause, each established from the provider's documented behaviour and conformance-tested; **no PayPal replay, lookup or finality behaviour is assumed here**. A way to authenticate provider responses or notifications that the worker cannot forge, so "authenticated evidence" gains a cryptographic meaning. Mapping of real provider fields onto the evidence allowlist, including refund identifiers and totals. Webhook design. Funding-method decisions. Operator approval of dispatch and finality for that contract |
| External AI | Model selection; spend limits; existing output guards re-verified against a real model |
| Channel3 | Account terms and quotas; a verified credit balance; credential approval separate from the offline adapter; external-catalog separation re-verified; live activation stays disabled until this gate is separately authorized |
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
25. **Privileged writers that bypass the Increment 2.1 functions (policy P1 to P7; approved for design).** Only a superuser, or the migration credential acting as `shopaccess_owner` (which may also switch to `shopaccess_definer`), can write the seven tables without going through `start_checkout` or `cancel_checkout`. Constraints and triggers apply to such a writer unless it disables them; nothing the functions enforce applies to it: credential checks, throttle and capacity, predecessor eligibility, audit writing and the lock discipline.
    - **P1.** No runtime path exists: besides the two functions, the only writers are a database administrator and the migration credential.
    - **P2.** Migrations run no top-level INSERT, UPDATE or DELETE on the seven tables: no such statement executes when a migration is applied. Statement text inside a `CREATE FUNCTION` body is not migration-time DML and is not prohibited (static test PGT-156, §19.15).
    - **P3.** Direct writes are permitted only as test fixtures in a disposable database, one transaction per fixture.
    - **P4.** No fixture or test disables or replaces a production trigger, relaxes or drops a constraint, or changes the replication role (static test PGT-157, §19.15). **One exception, for PGT-112(c) only:** a test may create a test-only trigger of its own inside a transaction that is always rolled back, in a disposable PostgreSQL acceptance database whose tests run serially. The trigger is a `BEFORE INSERT` row trigger that returns NULL. It is never committed, never created by a migration, and never created in a production, staging or any other non-disposable database. It leaves every production trigger and every constraint in place and enabled. **Second exception, for PGT-128 only (B-8).** A test may revoke one privilege from `shopaccess_definer` inside a transaction that is always rolled back and never committed, in a disposable PostgreSQL acceptance database whose tests run serially. Exactly six cases exist (K1, K2, K3, A1, A2, A3; §19.15), and each sends exactly one of these four statements: `REVOKE INSERT ON shopaccess.owner_request_windows FROM shopaccess_definer` (K1); `REVOKE UPDATE (window_calls) ON shopaccess.owner_request_windows FROM shopaccess_definer` (K2); `REVOKE UPDATE (total_throttled) ON shopaccess.owner_request_windows FROM shopaccess_definer` (K3); `REVOKE INSERT ON shopaccess.audit_events FROM shopaccess_definer` (A1, A2, A3). **No test sends any other privilege statement:** no GRANT, no other REVOKE, no ALTER DEFAULT PRIVILEGES, no ALTER ROLE, no change of ownership, no REASSIGN OWNED or DROP OWNED. This exception is about what a test may send. It does not restrict a migration: the functions migration carries the grants, revocations and hand-over of §19.13, as migration 0006 does for Increment 1. PGT-157 stays fail-closed outside the two exceptions.
    - **P4, Increment 2.2 (decision 14).** The two exceptions are used again for the confirmation functions, in these cases and no others. Reusing the statement text of an exception does not by itself permit a new case: each case is listed here. No new statement text is admitted. All of them are in `tests/db/confirmation-functions.test.ts`, on the test owner's first connection, inside a transaction that begins before the `try` and is rolled back in its `finally`; none is in `tests/db/confirmation-concurrency.test.ts`.
        - **Case S3 (first exception).** Two of the three PGT-112(c) statements: the test-only function that returns NULL and its `BEFORE INSERT` row trigger on `checkout_transitions`. The trigger on `quote_items` is not used. One correct `consume_challenge` is called inside the transaction. Expected: the call raises SQLSTATE `23514` with constraint `checkout_intents_history_check`; after the rollback no test-only object is left and nothing of the call survives.
        - **Cases A4 to A8 (second exception).** One of the four PGT-128 statements: `REVOKE INSERT ON shopaccess.audit_events FROM shopaccess_definer`. None of the three request-window revocations is used. One call is made inside the transaction: A4, `consume_challenge` with a wrong nonce; A5, `consume_challenge` on a quote whose stored digest is wrong; A6, `consume_challenge` under an ended nonce key; A7, `issue_challenge` on a quote whose stored digest is wrong; A8, a correct `consume_challenge`. Expected in each: the call raises `42501` for the insert into `audit_events`; the next statement is refused with `25P02`; after the rollback the privilege is back and nothing of the call survives, the admitted-call counter included.
    - **P5.** Fixtures are written serially and committed before any function call or other fixture touches the same owner or intent.
    - **P6.** A fixture that changes an existing row first locks the owner row, then the intent row, as the functions do.
    - **P7.** Fixtures write their own synthetic audit rows where §19.15 requires them; nothing writes them automatically.
    - **Limitation.** The design intends that a single privileged transaction which violates a constraint or a deferred check does not commit. **Nothing is guaranteed when two bypass writers act at once, or when a bypass writer races a function call:** the deferred checks of §19.3 take no lock. Making them lock the intent row is not part of Increment 2.1.

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

What is still undecided after the owner's record for Groups 1 to 10. Nothing here is approved, and nothing in Groups 1 to 10 is asked again. For the Increment 2.1 objects, the schema, function signatures and grants are approved for design in §19 (G2-02, G2-07); the rows below stand for every later increment. The Increment 2.1 exact-schema contract (A-1 to A-13) is approved for design, conditional on later PostgreSQL 17 execution evidence (§19.17). Final SQL approval, migration-writing and execution remain unauthorized.

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
- **Increment 2.1 (design only; not implemented).** The same mechanism extends to the owner throttle. An internal, pure throttle-window classification helper takes the existing window's values and an explicit decision time (§19.7), so that PGT-124 can check the window boundary exactly in a disposable test database. It writes no table and performs no checkout operation. No runtime entry point accepts a caller-controlled time because of it: the production functions pass it only their own database clock reading.

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

## 19. Increment 2 — Gate A contract (design approved for 2.1; files written and behaviour executed are recorded in §19.18)

**Status.** The owner approved the Increment 2.1 design at Gate A and authorized recording it in this document. That authorization covers documentation only. Nothing in this section has been implemented or executed: no Increment 2 migration, function, trigger, test or application code exists, and no SQL has been run for it. **Gate A is closed as a design-only architecture review milestone.** The owner closed it with §19.1 to §19.15 as the approved architecture baseline, subject to every recorded exclusion and unresolved decision. The closure authorizes no final SQL or schema approval, no migration-writing, no implementation of Increment 2.1, 2.2 or 2.3, no PostgreSQL connection, SQL execution or database test, no payment execution or recovery, and no commit, push or deployment. The owner then approved the **Increment 2.1 exact-schema contract** at design level (decisions A-1 to A-13 with their final corrections, §19.17). It is recorded in §19.2, §19.3, §19.7, §19.13 and §19.15. That approval is **conditional on later PostgreSQL 17 execution evidence** (§19.15) and likewise authorizes nothing to be written or run. Where an earlier section differs for an Increment 2 object, this section governs. Increments 2.2 and 2.3 are not approved contracts (§19.16). The decision register is §19.17.

**Reading this section after the Gate A paragraph above was written.** The paragraph above is kept as the record of what was true at Gate A. Since then some Increment 2.1 files have been written and some have been executed. Three things are kept apart throughout §19: what the owner approved as design; which files have actually been written; and which behaviour PostgreSQL has actually executed. §19.18 is the only place that states the second and the third. A sentence elsewhere in §19 that says "not implemented", "not executed" or "has not been written" describes the time it was written and is superseded by §19.18 where the two differ.

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

Every constraint and trigger has an explicit name in the migration. A name is part of this contract only where `SET CONSTRAINTS` needs it or a test refers to it by name: the unique keys, foreign keys and partial unique indexes of `checkout_intents` named below, and the triggers and deferred constraints named in §19.3. Every other name is chosen when the SQL is written, unless separately specified. No table accepts truncate. No role is granted DELETE.

**Exact-schema contract (A-1 to A-13; approved for design, conditional on later PostgreSQL 17 execution evidence).** States, events, actors and entry points are `text` columns with CHECK lists, as in Increment 1. `checkout_intents` and `checkout_transitions` have exactly the columns listed here: no `provider`, operation, observation or capture column exists in Increment 2.1, and no column has a default that implies a state. Group, intent, quote and event IDs are generated in the database from core `gen_random_uuid()`. Nothing in this subsection has been written as SQL or executed.

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
  - `row_version` is at least 2;
  - `current_quote_id` is NOT NULL: it is set at insert and never changes (§19.3);
  - `updated_at` is not before `created_at`.
- **`EXPIRED` is a reserved stored state in Increment 2.1.** It stays in the CHECK list, and no insert, update or transition can produce it (§19.3). Quote expiry remains derived (§19.8).
- A key is not checked while any of its own columns is NULL. A referenced row whose pointer is NULL matches nothing.

**`quotes`** (columns as §2.10)
- **Unique:** `(id, owner_id)`, `(id, checkout_intent_id)`, `(id, checkout_intent_id, owner_id)`, `(digest)`, and `(checkout_intent_id)`: one quote per intent (A-11).
- **Keys:** F-1 to the intent's `(id, owner_id)`; to `merchants`.
- **Checks:** total equals subtotal; discount, tax and shipping are zero; currency `USD`; `digest_version = 'SAQD-1'`; `expires_at = created_at + 15 minutes`. The cents columns are `bigint`; subtotal and total are from 1 to 20,000,000 (A-4); `assumptions_code = 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1'` (A-6); `catalog_revision` is the variant's (A-7).

**`quote_items`** (columns as §2.10, plus the snapshot)
- Primary key `(quote_id, line_number)`, line number 1.
- Quantity 1 to 10; line subtotal equals unit amount times quantity. Amounts are `bigint`; the unit amount is from 1 to 2,000,000.
- F-14 to the variant's `(id, product_id)`.
- **Immutable snapshot columns:** `merchant_display_name`, `product_title`, `variant_label`, `descriptive_terms_digest` (64 hex, over product description and variant specifications).
- **`descriptive_terms_digest` is `SADT-1` (B-7; approved for design).** It is computed in the database only, by the internal helper of §19.7a. Bytes: ASCII `SADT` (4 bytes); version byte `0x01`; a 2-byte big-endian field count, 2; then two fields, each one type byte `0x03`, a 4-byte big-endian **byte** length and the value in UTF-8. Field 1 is the product description. Field 2 is the variant specifications as PostgreSQL prints them (`jsonb::text`). The digest is SHA-256 over those bytes, in lowercase hex. Nothing is trimmed, case-folded or Unicode-normalized. The database encoding must be UTF8. No constraint enforces that a stored value equals `SADT-1` of the catalog at the time of the quote; that is a function-level responsibility (§19.3). Targets for testing, none of them PostgreSQL-verified, are in §15.2.

**`confirmation_challenges`:** as §2.11. The ID is `cf_` + 32 lowercase hex and is supplied by the caller (A-5); it is never authority, and ownership comes only from `owner_id`. Every DELETE and every TRUNCATE is rejected, in every status (A-8).

**`checkout_transitions`**
- **Columns:** `checkout_intent_id`, `to_version`, `from_version`, `event_id`, `event_type`, `actor`, `entry_point`, `from_state`, `to_state`, `occurred_at`, `recorded_at`.
- Primary key `(checkout_intent_id, to_version)`; unique `(event_id)`; `to_version = from_version + 1`.
- `event_type` is one of `QUOTE_ISSUED`, `SHOPPER_CONFIRMED`, `SHOPPER_CANCELED`, `SUPERSEDED`.
- `actor` is `shopper` or `server`.
- `from_state` may also be `DRAFT`, only for the first transition.
- Foreign key `checkout_intent_id` → `checkout_intents (id)`, immediate and not deferrable. In every flow the intent row exists before any of its transitions is inserted (§19.3).
- `recorded_at` is not before `occurred_at`. That table rule is unchanged. The 2.1 functions write the two equal (§19.7, timestamp contract); a fixture may still write them apart.
- `entry_point` is one of `start_checkout`, `cancel_checkout`, `consume_challenge`.
- **Legal combinations (A-10).** One CHECK permits exactly these six:

| # | Event | Actor | From → to | Entry point | Versions |
| --- | --- | --- | --- | --- | --- |
| T1 | `QUOTE_ISSUED` | `server` | `DRAFT` → `QUOTED` | `start_checkout` | 1 → 2 |
| T2 | `SHOPPER_CONFIRMED` | `shopper` | `QUOTED` → `USER_CONFIRMED` | `consume_challenge` | n → n+1, n ≥ 2 |
| T3 | `SHOPPER_CANCELED` | `shopper` | `QUOTED` → `CANCELED_LOCAL` | `cancel_checkout` | n → n+1, n ≥ 2 |
| T4 | `SHOPPER_CANCELED` | `shopper` | `USER_CONFIRMED` → `CANCELED_LOCAL` | `cancel_checkout` | n → n+1, n ≥ 2 |
| T5 | `SUPERSEDED` | `server` | `QUOTED` → `SUPERSEDED` | `start_checkout` | n → n+1, n ≥ 2 |
| T6 | `SUPERSEDED` | `server` | `USER_CONFIRMED` → `SUPERSEDED` | `start_checkout` | n → n+1, n ≥ 2 |

- `DRAFT` appears only in T1, and `from_version = 1` only in T1. No row has a `to_state` of `DRAFT` or `EXPIRED`.
- T2 is written by `consume_challenge` from Increment 2.2. In Increment 2.1 only the privileged fixture of §19.15 writes it.

**`owner_request_windows`**

| Column | Type and rule (A-13) |
| --- | --- |
| `owner_id` | `text`, primary key, key to `checkout_owners`; immutable |
| `window_started_at` | `timestamptz` NOT NULL |
| `window_calls` | `integer`, 0 to 30. Only an admitted call starts a window (§19.7), so a row written by the functions always holds at least 1 |
| `window_throttled` | `bigint`, at least 0 |
| `total_throttled` | `bigint`, at least `window_throttled` |
| `updated_at` | `timestamptz`, not before `window_started_at` |

- An update that changes `owner_id` is rejected. DELETE and TRUNCATE are rejected.
- There is no write-shape trigger: no approved invariant needs one.

**Creation order:** tables 1 to 6 as listed; then the self-referencing and forward keys on `checkout_intents`; then the partial indexes; then triggers; then table 7.

### 19.3 Replacement chain

**Triggers on `checkout_intents`**
- **Insert:** state `QUOTED`; `row_version` 2; successor pointer and confirmation columns NULL; `current_quote_id` set. `replaces_intent_id` is either NULL (an initial intent, the root of its group) or the ID of a row that already exists when the trigger runs (a replacement).
- **Update:**
  - `id`, `owner_id`, `purchase_group_id`, `created_at` and `replaces_intent_id` never change. For `replaces_intent_id` the comparison includes NULL: a root never acquires a predecessor.
  - `superseded_by_intent_id` may change once, from NULL to a value, only in the update that sets the state to `SUPERSEDED`.
  - A row in `SUPERSEDED`, `CANCELED_LOCAL` or `EXPIRED` accepts no update.
  - `row_version` rises by exactly one.
  - `current_quote_id` never changes.
  - **Legal edges (A-9).** Only `QUOTED` → `USER_CONFIRMED`; `QUOTED` or `USER_CONFIRMED` → `SUPERSEDED`; `QUOTED` or `USER_CONFIRMED` → `CANCELED_LOCAL`.
  - **Confirmation pointer.** `confirmation_id` and `confirmation_status` change once, from NULL to set, only in the update that sets the state to `USER_CONFIRMED`. In every other update they are unchanged.
  - **Consumed matching challenge.** In the update to `USER_CONFIRMED`, the named challenge must have status `CONSUMED` and the same `checkout_intent_id`, `owner_id` and `quote_id` as the intent's ID, owner and current quote. F-5 enforces the status and the intent at once; the trigger checks all four. A consumed challenge can never change or be deleted, so the pointer stays valid.
- These rules are enforced by the trigger `checkout_intents_guard`, before insert or update, for every role.
- The trigger does not judge whether a predecessor is eligible; the function does. A successor inserted against a terminal predecessor cannot commit, because that predecessor cannot be updated and R-B then fails.

**Deferred checks (A-12).** Four constraint triggers, all deferrable and initially deferred, per row, and the two deferred keys of §19.2. The two history triggers call `shopaccess.checkout_history_check()`.

| Name | Fires after | Validates |
| --- | --- | --- |
| `checkout_intents_history_check` | INSERT or UPDATE on `checkout_intents` | H1 to H4 for that intent |
| `checkout_transitions_history_check` | INSERT on `checkout_transitions` | H1 to H4 for that row's intent |
| `quotes_item_check` | INSERT on `quotes` | Q1 and Q2 for that quote |
| `quote_items_quote_check` | INSERT on `quote_items` | Q1 and Q2 for that item's quote |
| `checkout_intents_predecessor_reciprocal_fkey` (R-B) | — | As §19.2 |
| `checkout_intents_current_quote_fkey` (F-4) | — | As §19.2 |

Update, delete and truncate on quotes, items and transitions are rejected at once by their append-only triggers, so inserts are the only writes left to cover.

| # | Invariant, for an intent at `row_version` = v |
| --- | --- |
| H1 | Exactly v − 1 transition rows, with `to_version` 2 through v |
| H2 | The row at `to_version` 2 is T1 (§19.2) |
| H3 | Each later row's `from_state` and `from_version` equal the previous row's `to_state` and `to_version` |
| H4 | The last row's `to_state` equals the stored state |

| # | Invariant, for a committed quote |
| --- | --- |
| Q1 | Exactly one `quote_items` row exists, with `line_number` 1 |
| Q2 | Its `line_subtotal_cents` equals the quote's `subtotal_cents` |

- **Forcing is mandatory.** Before returning a result that wrote checkout rows, `start_checkout` and `cancel_checkout` set the six deferred constraints to immediate and then back to deferred. The functions contain no second, duplicate validator. Each deferred check raises with the name of its constraint, so that a caller can tell which one failed. That the forcing fires inside a function call is an unverified assumption (§19.15). PGT-112(c) is the test designed to establish it, for both `start_checkout` and `cancel_checkout`; it has not been executed.
- **Rollback.** Any violation raises an error. Each mutating call is one statement in its own transaction (§19.5), so the error undoes everything from that call, including its throttle and audit writes. A fixture's violation surfaces at its commit.
- **Locks.** The deferred checks only read and take no lock, so nothing is acquired after the last rank of §19.4. The foreign keys take key-share locks only on rows the same transaction already holds or created.
- **Concurrency.** Every function that writes an intent holds the owner-row lock for the whole call, and locks an existing intent before changing it; a new intent's rows are invisible to others until commit. Writers that bypass the functions are outside this guarantee (§17.4, item 25).
- **Privileges.** The trigger functions are in schema `shopaccess`, owned by `shopaccess_owner`, run with the invoker's rights and a fixed search path, and are executable by no role by grant (§19.13).
- **Left to the functions, enforced by no constraint:** that a stored digest equals `SAQD-1` of the stored fields; that a purchase group has at least one intent; that audit rows exist for each event; eligibility, capacity and throttle semantics.

**Why no cycle can exist.** A predecessor link is fixed at insertion, and the predecessor must already exist. Every link therefore points from a later row to an earlier one.
- In one statement or transaction, the first row of any ring names a row that does not exist yet and is rejected.
- Two concurrent transactions cannot each see the other's uncommitted row.
- No update can add or change a link.
- R-A forces the successor pointer to name the one actual successor.

With one root per group and at most one successor per intent, each group is a single chain.

**Required write sequence in `start_checkout`:**
1. Generate the IDs: group (new checkout only), intent, quote, events. The quote ID exists before the intent is inserted.
2. Insert the purchase group (new checkout only).
3. Insert the intent with `current_quote_id` set. Pending: F-4, the intent history check, and R-B for a replacement.
4. Insert the quote. Its key to the intent (F-1) is immediate, so the intent must come first. Pending: its item check.
5. Insert the quote item. Pending: its quote check.
6. Insert the T1 transition. Pending: the transition history check.
7. Replacement only: update the predecessor to `SUPERSEDED` with its pointer (R-A holds at once), then insert its T5 or T6 transition.
8. Insert the audit rows.
9. Force the six deferred constraints, then restore them.

A privileged fixture follows the same order within one transaction.

| Guarantee | Enforced by |
| --- | --- |
| Pointers agree both ways; one successor; one root; same group and owner; `SUPERSEDED` exactly when replaced | Constraints |
| One quote per intent; one item per quote with an equal subtotal; complete history H1 to H4 | Constraints and deferred checks |
| No cycle; no rewriting of ancestry; legal edges only; a consumed matching challenge | Triggers |
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
- Every Increment 2 function refuses a transaction whose isolation level is not exactly `read committed` (mechanism B-5; approved for design). The refusal is an error with SQLSTATE `0A000` and a fixed message, raised by the internal helper `require_read_committed` (§19.7a). `read uncommitted` is refused as well.
  - The mutating functions call the helper as their first statement, before step 0. A caller without a valid credential receives the same error. Nothing is locked or written.
  - The read functions end their single SELECT with the helper as the LIMIT expression: `LIMIT require_read_committed(1)` in `read_checkout` and `LIMIT require_read_committed(100)` in `list_owner_checkouts`.
  - That a LIMIT expression is evaluated when no row qualifies is a design intention, not an established fact (§19.15, unverified assumption 11). If the execution of PGT-133 shows otherwise, implementation stops and the conflict between this rule and §19.11 is an owner decision. No fallback is approved in advance.
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
- **Conversion failures are errors, not results (B-6).** A value that cannot be converted to a parameter's SQL type (non-numeric text, a fraction, a value outside `integer` or `smallint` range) is rejected by PostgreSQL before the function body runs. It takes no lock, writes nothing and is not counted. The application binds only integers it has already validated.
- **No session touch.** The 2.1 functions never update a session row. Refreshing the idle timeout remains with `authorize_session`.

**Sequence** (step 1 applies only to the 2.2 challenge functions)

| Step | Action | Possible exit |
| --- | --- | --- |
| 1 | Nonce key row (share), when applicable | — |
| 2 | Session row (share), found again by the exact credential. If no row is found, or the row's ID or owner differs from the row of step 0b, the call returns at once: no further lock is taken and nothing is written (B-6) | `NOT_AUTHORIZED` |
| 3 | Owner row (update) | — |
| 4 | Throttle row: if one exists for the owner, lock it with a locking read (`SELECT … FOR UPDATE`); if none exists, there is nothing to lock. First clock reading: the **throttle-gate reading**. Credential revalidation (§19.6) | `NOT_AUTHORIZED` |
| 4a | From the step 4 reading, work out which window this call belongs to and whether it is over the limit. Nothing is written | — |
| 4b | If over the limit: apply the `RATE_LIMITED` policy and return | `RATE_LIMITED` |
| 5 | Lock the requested resource, selected by its ID and the caller's owner together | — |
| 6 | Second clock reading. Final credential revalidation (§19.6). Resource ownership: the row of step 5 was found. This reading does not change the throttle window assigned at step 4 | `NOT_AUTHORIZED` |
| 7 | Admission: increment the admitted-call counter, in the window assigned at step 4 | — |
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
- A window starts at the first **admitted** call at or after the previous window's start plus 60 seconds; that instant belongs to the new window. A call can be throttled only inside a window that already holds 30 admitted calls, so a throttled call never starts a window.
- **Over the limit (4b):** `window_throttled` and `total_throttled` each rise by one, on every such call. One `OWNER_RATE_LIMITED` audit row is written when `window_throttled` goes from 0 to 1. The result is `RATE_LIMITED`.
- **Admitted (7):** `window_calls` rises by one. A business refusal at step 8 stays counted.
- **Throttle clock (owner decision).** The step 4 reading is the authoritative time for the throttle. It decides which fixed window the call belongs to, whether the call is over the limit, and the value of any new `window_started_at`. The step 6 reading never reassigns the window.
- **Starting a window.** A call that finds no row, or whose step 4 reading is at or after the stored window's start plus 60 seconds, belongs to a new window. When it is admitted at step 7, `window_started_at` is its step 4 reading, `window_calls` is 1 and `window_throttled` is 0.
- **A call that crosses the boundary while waiting.** If the step 4 reading is before the boundary and the call then waits at step 5 until after it, the call stays in the window assigned at step 4. Admitted at step 7, it raises that window's `window_calls` by one and leaves `window_started_at` unchanged. It was counted against that window's limit at step 4, so the limit of 30 is not exceeded. A new window starts only with a later call whose own step 4 reading is at or after the boundary. If the waiting call instead exits `NOT_AUTHORIZED` at step 6, nothing is written (§19.10).
- **Window classification helper (`owner_window_decision`; signature in §19.7a).** Step 4a is computed by one internal, pure helper. It is given the existing window's values, or their absence, and an explicit decision time, and it answers which window the call belongs to and whether the call is over the limit of 30 per 60 seconds.
  - It reads no table, writes no table and performs no checkout operation. Its answer depends only on its arguments.
  - In production the only decision time ever passed to it is the calling function's own step 4 reading. No function granted to a runtime role has a time parameter, and no session setting changes the decision time (§18.8).
  - It is an internal helper: EXECUTE is granted to no role, and `shopaccess_web`, `shopaccess_operator`, `shopaccess_worker` and PUBLIC cannot call it (§19.13). It is used by the function owner inside the two mutating functions.
  - In a disposable test database the test owner may call it directly with explicit values and times. That access comes from being that database's administrator, not from a grant, and does not exist in runtime environments.
  - It does not change the policy above: the step 4 reading stays authoritative, and a call that crosses the boundary while waiting stays in the window assigned at step 4.
- Quote times and credential revalidation still use their own readings (§19.6, §19.8).
- **Timestamp contract (B-4; approved for design; amends the sentence this bullet replaces, which left `updated_at` to the functions migration).** `t4` is the step 4 reading and `t6` the step 6 reading. Holding the owner lock serializes the calls of one owner. **It does not make the clock monotonic:** `t6` may be earlier than `t4`, and either may be earlier than a time already stored.
  - **Classification, from `t4`.** No row: a new window. A row with `t4 − window_started_at ≥ 60 seconds`: a new window. Otherwise, including `t4 < window_started_at`, the stored window. A call is over the limit only in a stored window with `window_calls ≥ 30`.

  | Value written | Rule |
  | --- | --- |
  | `window_started_at` | New window: `t4`. Stored window: unchanged |
  | `owner_request_windows.updated_at`, first insertion of the row | `t4` |
  | `owner_request_windows.updated_at`, every write to an existing row: a new-window reset, an admitted call in the stored window, a `RATE_LIMITED` call | `GREATEST(stored updated_at, t4)` |
  | `OWNER_RATE_LIMITED` audit row | `occurred_at = recorded_at = t4` |
  | Quote | `created_at = t6`; `expires_at = t6 + 15 minutes` |
  | New purchase group, new intent | `created_at = t6`; the intent's `updated_at = t6` |
  | Updated intent (cancel, supersession) | `updated_at = GREATEST(stored updated_at, t6)` |
  | Transition | `occurred_at = recorded_at = t6` |
  | Every other audit row | `occurred_at = recorded_at = t6` |

  - **Consequences.** A window row's `updated_at` never decreases. `updated_at ≥ window_started_at` and the intent's `updated_at ≥ created_at` hold whatever the clock does: a new window starts at `t4`, and `GREATEST(stored updated_at, t4)` is not before it. `window_started_at` only moves forward. A backward step of the clock lengthens the current window and never admits more than 30 calls in one stored window. No ordering is promised between the times of successive transition or audit rows.
  - **Forward time is unchanged.** With a clock that does not step backward, every value above equals the reading named, as before; PGT-145 (a) to (d) are unchanged.
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
- **Order of business results at step 8 (B-2; approved for design).** First match. Every row is reached after admission at step 7, so the admitted-call counter has risen by one.

  | Order | Condition | Result | Audit row |
  | --- | --- | --- | --- |
  | 1 | Replacement only: `checkout_transition` does not accept `SUPERSEDED` for the predecessor (its stored state is not `QUOTED` or `USER_CONFIRMED`), or the predecessor already has a successor | `REPLACEMENT_NOT_ALLOWED` | None |
  | 2a | The catalog snapshot finds no row for this product and variant together | `PRODUCT_NOT_IN_MERCHANT_CATALOG` | None |
  | 2b | Availability is not `IN_STOCK` | `VARIANT_UNAVAILABLE` | None |
  | 2c | Quantity above the variant's limit | `QUANTITY_EXCEEDS_LIMIT` | None |
  | 2d | Subtotal outside 1 to 20,000,000 | `AMOUNT_OUT_OF_RANGE` | None |
  | 3a | Replacement: the group already has 10 intents | `GROUP_INTENT_LIMIT` | One `CHECKOUT_REFUSED_AT_CAPACITY` |
  | 3b | New checkout: the owner has 10 active or unresolved groups | `AT_PURCHASE_CAPACITY` | One `CHECKOUT_REFUSED_AT_CAPACITY` |
  | 4 | Otherwise: the write sequence of §19.3 | `STARTED` | `QUOTE_ISSUED`; and `CHECKOUT_SUPERSEDED` for a replacement |

  - **Overlapping conditions.** At capacity, and the product is missing, unavailable or over its quantity limit: the catalog result, and no audit row. An ineligible predecessor in a full group, or together with an invalid product: `REPLACEMENT_NOT_ALLOWED`, and no audit row. Rows 3a and 3b never both apply: a replacement creates no group. A `CHECKOUT_REFUSED_AT_CAPACITY` row therefore always records a request that was otherwise purchasable. This order follows §5.2, which lists the variant checks (step 3) before the purchase group (step 4).
  - `AMOUNT_OUT_OF_RANGE` cannot be produced by catalog rows that satisfy the constraints of migration `0003`: the largest unit amount times the largest quantity equals the limit. It is kept as a defensive result and is covered by reading, not by a data test.
  - The 2.1 functions contain no exception handler and no row-count check after their own inserts.

**`cancel_checkout`**
- **Parameter:** `p_intent_id text`. **Returns:** `result`.
- **Results:** `CANCELED`; `NOT_AUTHORIZED` (including a missing or foreign intent); `RATE_LIMITED`; `REQUEST_INVALID`; `NOT_CANCELABLE` (terminal stored state).
- On success: state `CANCELED_LOCAL`, one transition, one audit row.
- **Step 8.** `checkout_transition` accepts `SHOPPER_CANCELED` (stored `QUOTED` or `USER_CONFIRMED`): `CANCELED`. Otherwise `NOT_CANCELABLE`, with no audit row. An expired quote does not prevent cancelling. Cancelling a `USER_CONFIRMED` intent leaves its confirmation pointer exactly as it is.

### 19.7a Internal helpers (B-10; approved for design)

Six helpers. Common properties: schema `shopaccess_api`; owner `shopaccess_definer`; `SECURITY INVOKER`; `SET search_path = pg_catalog, pg_temp`; no table is read or written; EXECUTE is revoked from PUBLIC and granted to no role. In a disposable test database the test owner may call them as that database's administrator; that access is not a grant and does not exist at runtime.

```text
1. require_read_committed(p_value integer) RETURNS integer
   PL/pgSQL, STABLE. Returns p_value when
   current_setting('transaction_isolation') = 'read committed';
   otherwise raises SQLSTATE 0A000 with a fixed message.

2. owner_window_decision(
     p_window_started_at timestamptz,   -- NULL: no row
     p_window_calls      integer,       -- NULL: no row
     p_t                 timestamptz)
   RETURNS TABLE (starts_new_window boolean, over_limit boolean)
   SQL, IMMUTABLE. Always one row. The classification of the timestamp
   contract (§19.7), using only timestamptz subtraction and interval
   comparison.

3. checkout_transition(
     p_from_state                       text,
     p_from_version                     integer,
     p_event_type                       text,
     p_actor                            text,
     p_entry_point                      text,
     p_current_quote_id                 text,
     p_current_confirmation_id          text,
     p_current_superseded_by_intent_id  text,
     p_event_quote_id                   text,
     p_event_confirmation_id            text,
     p_event_successor_intent_id        text)
   RETURNS TABLE (
     accepted                boolean,
     to_state                text,
     to_version              integer,
     quote_id                text,
     confirmation_id         text,
     superseded_by_intent_id text)
   SQL, IMMUTABLE. Always one row.

4. quote_digest_saqd1(
     p_quote_id text, p_owner_id text, p_intent_id text,
     p_purchase_group_id text, p_merchant_id text, p_product_id text,
     p_variant_id text,
     p_catalog_revision bigint, p_quantity bigint, p_unit_amount_cents bigint,
     p_subtotal_cents bigint, p_discount_cents bigint, p_tax_cents bigint,
     p_shipping_cents bigint, p_total_cents bigint,
     p_currency text, p_assumptions_code text,
     p_created_at timestamptz, p_expires_at timestamptz)
   RETURNS text
   SQL, STABLE. SAQD-1 of §5.1 over exactly these 19 fields, in this order.

5. descriptive_terms_digest(p_description text, p_specs jsonb) RETURNS text
   SQL, STABLE. SADT-1 of §19.2.

6. quote_material_change(
     p_q_unit_amount_cents bigint, p_q_currency text, p_q_quantity integer,
     p_q_merchant_id text, p_q_product_id text,
     p_q_merchant_display_name text, p_q_product_title text,
     p_q_variant_label text, p_q_descriptive_terms_digest text,
     p_c_unit_amount_cents bigint, p_c_currency text, p_c_availability text,
     p_c_max_quantity_per_order integer, p_c_merchant_id text,
     p_c_product_id text, p_c_merchant_display_name text,
     p_c_product_title text, p_c_variant_label text,
     p_c_description text, p_c_specs jsonb)
   RETURNS boolean
   SQL, STABLE. The p_q_ values are the stored snapshot; the p_c_ values are
   the catalog as the calling statement sees it.
```

**`checkout_transition` is the whole predicate, not a state lookup.** `accepted` is true exactly for T1 to T6 of §19.2, each with its event, actor, from state, entry point and version rule (`p_from_version = 1` only for T1; otherwise at least 2), and with the pointer rules below. It receives the pointers the intent holds now and returns the pointers it holds afterwards; **an event that does not change a pointer returns the value it was given.**

| | Further conditions | `quote_id` | `confirmation_id` | `superseded_by_intent_id` |
| --- | --- | --- | --- | --- |
| T1 | The three current pointers are NULL; `p_event_quote_id` present | `p_event_quote_id` | NULL | NULL |
| T2 | `p_event_quote_id = p_current_quote_id` (the quote-match guard); `p_current_confirmation_id` NULL; `p_event_confirmation_id` present; no successor | unchanged | `p_event_confirmation_id` | unchanged (NULL) |
| T3, T4 | No successor | unchanged | **unchanged**: NULL from `QUOTED`, the consumed challenge's ID from `USER_CONFIRMED` | unchanged (NULL) |
| T5, T6 | No successor yet; `p_event_successor_intent_id` present | unchanged | **unchanged**, as for T3 and T4 | `p_event_successor_intent_id` |

- `to_version = p_from_version + 1`. When `accepted` is false every other column is NULL.
- Cancellation and supersession never clear a confirmation pointer. The reducer leaves its context unchanged on `SHOPPER_CANCELED` and `SUPERSEDED`, and the intent guard of §19.3 rejects any change to the pointer outside the change to `USER_CONFIRMED`.
- The helper does not re-check the table's own pairing of state and confirmation pointer (§19.2); it preserves what it is given.
- The mutating functions take the new state, the new version and the pointer values from this row and contain no second copy of the rules.

**`quote_material_change`** is true when a current identity value is NULL (a missing merchant, product or variant row) or any material fact of §19.8 differs: unit amount; currency; availability other than `IN_STOCK`; a quantity limit below the quoted quantity; merchant ID; the variant's product; merchant display name; product title; variant label; or `SADT-1` of the current description and specifications differing from the stored digest. Image path and either `catalog_revision` are not compared.

**Volatility.** Helpers 4 to 6 are declared `STABLE` only because built-in functions they use are labelled stable. Their results must not depend on session settings (PGT-73a, PGT-120).

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

| Event | Written | Actor | `checkout_intent_id` | `detail` keys, exactly these (B-3) |
| --- | --- | --- | --- | --- |
| `QUOTE_ISSUED` | Every successful `start_checkout` | `server` | The new intent | `transitionEventId`, `quoteId`, `purchaseGroupId`, `productId`, `variantId`, `quantity`, `totalCents` |
| `CHECKOUT_SUPERSEDED` | Every supersession | `server` | The predecessor | `transitionEventId`, `supersededByIntentId` |
| `CHECKOUT_REFUSED_AT_CAPACITY` | Every `AT_PURCHASE_CAPACITY` and `GROUP_INTENT_LIMIT` refusal; no quota | `server` | The predecessor for `GROUP_INTENT_LIMIT`; NULL for `AT_PURCHASE_CAPACITY` | `reason`, `limit`; and `purchaseGroupId` for `GROUP_INTENT_LIMIT` |
| `CHECKOUT_CANCELED` | Every successful `cancel_checkout` | `shopper` | The intent | `transitionEventId`, `fromState` |
| `OWNER_RATE_LIMITED` | First throttled call of a window | `server` | NULL | `limit`, `windowSeconds`, `windowStartedAt` (UTC text with microseconds) |

- **Every row:** `event_id` is `ev_` and 32 hex from `gen_random_uuid()`; `owner_id` is the owner derived from the session; `session_id` is the ID of the session row locked at step 2; `operation_id` is NULL; `occurred_at` and `recorded_at` as the timestamp contract of §19.7. Detail keys are camelCase, as in the audit rows of migration `0006`.
- **Never in any detail:** a token, a nonce, a key version, any digest (including the quote digest and `descriptive_terms_digest`), catalog free text, or a rejected argument.
- **Write order on a throttled call:** the counters first, then the audit row.
- **No row** is written for `NOT_AUTHORIZED`, `REQUEST_INVALID`, `REPLACEMENT_NOT_ALLOWED`, `NOT_CANCELABLE` or a catalog refusal.

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

**Increment 2.2: the confirmation events (decision 17).** Both are written by the deciding function, in the same transaction, like every row above.

| Column | `CONFIRMATION_ACCEPTED` | `CONFIRMATION_REJECTED` |
| --- | --- | --- |
| `event_id` | `ev_` and 32 hex from `gen_random_uuid()` | The same |
| `actor` | `shopper` | `shopper` |
| `owner_id` | The owner derived from the session | The same |
| `session_id` | The session row locked at step 2 | The same |
| `checkout_intent_id` | The challenge's intent | `consume_challenge`: the intent of the locked challenge. `issue_challenge`: the intent of the call |
| `operation_id` | NULL | NULL |
| `occurred_at`, `recorded_at` | Both the step 6 reading | Both the step 6 reading |
| `detail` keys, exactly these | `transitionEventId`, `challengeId`, `quoteId` | `result`, `challengeId` |
| `detail` values | The event ID of the inserted transition; the ID of the locked challenge; the challenge's quote ID | The result code; `consume_challenge`: the ID of the locked challenge; `issue_challenge`: JSON null |

- **One `CONFIRMATION_ACCEPTED` row:** `CONFIRMED`, and no other result.
- **One `CONFIRMATION_REJECTED` row, on every occurrence, with no quota (G2-38):** `CONFIRMATION_KEY_REVOKED`, `CONFIRMATION_MISMATCH` and `QUOTE_DIGEST_MISMATCH` from `consume_challenge`; `QUOTE_DIGEST_MISMATCH` from `issue_challenge`.
- **The issue-side rejection names no challenge.** No challenge row exists for it. Its `challengeId` is JSON null, and the challenge ID the caller sent is written nowhere.
- **No audit row:** every other result of `issue_challenge` (`ISSUED`, `REUSED`, `REFUSED`, `CHALLENGE_LIMIT_REACHED`, `NONCE_KEY_NOT_ACTIVE`, `CONFIRMATION_ALREADY_USED`, `INTENT_NOT_AWAITING_CONFIRMATION`, `QUOTE_EXPIRED`, `QUOTE_STALE_CATALOG`); `CONFIRMATION_NOT_FOUND`, `CONFIRMATION_SUPERSEDED`, `CONFIRMATION_ALREADY_USED`, `CONFIRMATION_EXPIRED`, `QUOTE_EXPIRED`, `QUOTE_STALE_CATALOG` and `INTENT_NOT_AWAITING_CONFIRMATION` from `consume_challenge`; `NOT_AUTHORIZED` and `REQUEST_INVALID`. "Issuing a challenge writes no audit row" therefore has exactly one exception, the issue-side `QUOTE_DIGEST_MISMATCH`.
- **`OWNER_RATE_LIMITED`** is unchanged: one row for the first throttled call of a window, timed at the step 4 reading, for all four mutating functions.
- **Never in any detail:** a token, a nonce, key material, a key version, or any digest.

**Permitted changes by outcome (2.2)**

| Outcome | Permitted data changes |
| --- | --- |
| `NOT_AUTHORIZED`, `REQUEST_INVALID`, `CONFIRMATION_NOT_FOUND` | None. Not counted |
| `RATE_LIMITED` | As 2.1 |
| `CONFIRMATION_KEY_REVOKED`, `CONFIRMATION_MISMATCH`, `QUOTE_DIGEST_MISMATCH` | Admitted-call counter; one audit row |
| `CONFIRMATION_EXPIRED` | Admitted-call counter; the challenge from `ACTIVE` to `EXPIRED` |
| `ISSUED` | Admitted-call counter; at most one challenge from `ACTIVE` to `EXPIRED` or `SUPERSEDED`; one new challenge |
| `REFUSED` | Admitted-call counter, and nothing else: no challenge row is created or changed |
| `CONFIRMED` | Admitted-call counter; the challenge to `CONSUMED`; the intent to `USER_CONFIRMED` with its pointer; one transition; one audit row |
| Every other refusal | Admitted-call counter |
| Error | None; everything rolls back |

### 19.11 Read functions
- Written in SQL; the body is exactly one `SELECT`; declared `STABLE`.
- No helper that reads a table may be called. Exactly four functions may be called: `session_is_live`, `require_read_committed`, `descriptive_terms_digest` and `quote_material_change`. None of them reads a table.
- Under `READ COMMITTED` one statement sees one snapshot, and every mutating call is one transaction. A result therefore never mixes two versions.
- Time is the statement's start time, returned as database time.
- They perform no data change and take no lock.
- **`read_checkout(p_key_version smallint, p_token_digest text, p_intent_id text)`** always returns exactly one row (B-1; approved for design):

  ```text
  result                   text         'OK' or 'NOT_AUTHORIZED'
  owner_id                 text
  intent_id                text
  purchase_group_id        text
  stored_state             text
  row_version              integer
  effective_status         text
  replaces_intent_id       text         NULL for a root
  superseded_by_intent_id  text         NULL unless superseded
  intent_created_at        timestamptz
  intent_updated_at        timestamptz
  quote_id                 text
  merchant_id              text
  merchant_display_name    text
  product_id               text
  product_title            text
  variant_id               text
  variant_label            text
  quantity                 integer
  unit_amount_cents        bigint
  subtotal_cents           bigint
  discount_cents           bigint
  tax_cents                bigint
  shipping_cents           bigint
  total_cents              bigint
  currency                 text
  assumptions_code         text
  catalog_revision         integer
  quote_digest             text
  quote_created_at         timestamptz
  quote_expires_at         timestamptz
  quote_stale              boolean
  database_time            timestamptz  the statement's start time
  ```

  - With `OK` every column is non-NULL except the two noted.
  - With `NOT_AUTHORIZED` every other column, including `database_time`, is NULL. It is returned for a credential that fails §19.6 at the statement's start time, and for an intent ID that is NULL, malformed, missing or another owner's. These cases are indistinguishable. There is no `REQUEST_INVALID`.
  - Never returned: the token digest, a session ID, `descriptive_terms_digest`, the intent's confirmation pointer, a challenge that is not `ACTIVE`.
  - **Increment 2.2 (migration `0009`, decision 10): the function is replaced by one that returns 41 columns.** The 33 columns above are unchanged in name, type and order, and eight follow them:

    ```text
    challenge_id                 text         the quote's ACTIVE challenge; NULL when it has none
    challenge_quote_digest       text         the digest the challenge is bound to
    challenge_nonce_key_version  smallint
    challenge_nonce_digest       text
    challenge_summary            jsonb
    challenge_issued_at          timestamptz
    challenge_expires_at         timestamptz
    challenge_usable             boolean
    ```

    - The challenge shown is the row of `confirmation_challenges` with the intent's current quote, the same intent, the same owner and status `ACTIVE`. There is at most one. A challenge in any other status is never shown.
    - With `OK` and an `ACTIVE` challenge, columns 34 to 40 are non-NULL. With `OK` and no `ACTIVE` challenge, they are NULL and `challenge_usable` is false. With `NOT_AUTHORIZED`, all eight are NULL, like every other column.
    - `challenge_usable` is true exactly when all of these hold at the statement's start time: there is an `ACTIVE` challenge; the intent is stored `QUOTED`; the time is before `quote_expires_at`; the time is before `challenge_expires_at`; `challenge_quote_digest` equals `quote_digest`; `quote_stale` is false; the status of the challenge's nonce key is `ACTIVE` or `VERIFY_ONLY`. It does not compute `SAQD-1` again and does not apply the 60-second reuse margin; `issue_challenge` and `consume_challenge` decide those.
    - The function is still written in SQL, `STABLE`, one `SELECT` that ends `LIMIT require_read_committed(1)`, calls only the four permitted functions, takes no lock and changes nothing. There is no separate reader for confirmations.
    - A function's result type cannot be changed in place, so migration `0009` removes the 33-column function and creates the 41-column one (§19.16).
- **`list_owner_checkouts(p_key_version smallint, p_token_digest text)`** returns zero to 100 rows, and none when not authorized:

  ```text
  intent_id          text
  purchase_group_id  text
  stored_state       text
  effective_status   text
  intent_created_at  timestamptz
  quote_expires_at   timestamptz
  ```

  - Every column is non-NULL. Order: `intent_created_at` descending, then `intent_id` descending. There is no truncation indicator: an owner with more than 100 intents sees the newest 100.
- **`effective_status`** (both functions) is `QUOTE_EXPIRED` when `stored_state` is `QUOTED` or `USER_CONFIRMED` and the statement's start time is at or after `quote_expires_at`. Otherwise it equals `stored_state`. It never changes anything stored. `QUOTE_EXPIRED` is not a stored state; the reserved stored state `EXPIRED` (§19.2) is reported as itself if it is ever stored.
- **`quote_stale`** is the result of `quote_material_change` (§19.7a) over the stored snapshot and the catalog as the statement sees it. It is independent of expiry and is reported for every stored state.
- **Timestamp names.** A time of the intent is prefixed `intent_`, a time of the quote `quote_`, in both functions.

### 19.12 Identifiers and reducer parity
- Group, intent, quote, transition-event and audit-event IDs are generated in the database. The challenge ID (2.2) is the only caller-supplied ID.
- The permitted state changes, T1 to T6 of §19.2, are coded in one internal helper, `checkout_transition` (§19.7a). From the stored state and version, the event, the actor, the entry point and the pointers the intent holds, it decides whether the change is accepted and returns the new state, the new version and the pointers afterwards.
- It must agree with the TypeScript reducer on the accepted (state, event, actor) combinations, the quote-match guard, the pointer changes (including that cancellation and supersession leave the confirmation pointer as it is) and the version increment. Its output supplies every transition record field except the event ID and the times. The entry point has no counterpart in the reducer; it is checked against the table of §19.2.
- **Reducer-accepted combinations that Increment 2.1 excludes,** each refused by the helper and listed one by one in PGT-138: `QUOTE_ISSUED` from `QUOTED` (no in-place re-quote); `QUOTE_INVALIDATED`; `SHOPPER_CANCELED`, `SUPERSEDED` and `EXPIRED` from `DRAFT` (`DRAFT` is never stored); `EXPIRED` from `QUOTED` or `USER_CONFIRMED` (no Increment 2 entry point raises it).

### 19.13 Privileges

| Role | Increment 2 |
| --- | --- |
| `shopaccess_web` | EXECUTE on the Increment 2 functions; in Increment 2.1 these are `start_checkout`, `cancel_checkout`, `read_checkout` and `list_owner_checkouts`, and nothing else. No new table privilege: every direct statement by the web role on any of the seven tables is refused |
| `shopaccess_definer` | SELECT on the three catalog tables; UPDATE on `checkout_owners` for locking only (its trigger rejects every update); SELECT, INSERT on `purchase_groups`, `quotes`, `quote_items`, `checkout_transitions`; SELECT, INSERT, UPDATE on `checkout_intents`; **SELECT only** on `confirmation_challenges` in Increment 2.1 (INSERT and UPDATE are an Increment 2.2 decision); on `owner_request_windows`, SELECT, INSERT, and UPDATE on the five non-key columns only (A-13) |
| `shopaccess_worker`, `shopaccess_operator`, PUBLIC | Nothing new |
| `shopaccess_web`, Increment 2.2 (migration `0009`) | EXECUTE on `issue_challenge`, on `consume_challenge` and on the recreated `read_checkout`, and nothing else. Still no table privilege |
| `shopaccess_definer`, Increment 2.2 (migration `0009`) | INSERT on `confirmation_challenges`; UPDATE there on the four columns `status`, `consumed_at`, `superseded_at` and `expired_marked_at` only. No table-level UPDATE, no DELETE, no TRUNCATE. It already holds SELECT there, and SELECT, INSERT and UPDATE on `server_key_versions`, which the lock on a nonce key row needs |

- **The schema migration is default-deny.** It contains no GRANT. After it alone, only the table owner can reach the new tables.
- **The functions migration carries every grant above.** Each SELECT is granted together with the matching write privilege, in that one file, so no trigger ever runs for the function owner without the SELECT it needs.
- **Trigger functions** are created by the schema migration, revoked from PUBLIC and granted to no role. When they run inside a call they use the function owner's table privileges: the intent guard reads `checkout_intents` and `confirmation_challenges`; the history check reads `checkout_intents` and `checkout_transitions`; the quote checks read `quotes` and `quote_items`.
- **Internal helpers** are granted to nobody. The six helpers of §19.7a are `SECURITY INVOKER`; the four entry points are `SECURITY DEFINER`.
- **Already held from migration `0006` and sufficient:** SELECT and UPDATE on `shopper_sessions` (the session lock), SELECT on `server_key_versions`, INSERT on `audit_events`.

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

### 19.15 Acceptance-test manifest, Increment 2.1 (which tests have been written and which executed: §19.18)

**Fixtures.** Where a test needs a stored state that no 2.1 function can produce, it uses a privileged fixture in the disposable test database: rows written directly by the test owner in one transaction. A fixture must satisfy every constraint, key and trigger of §19.2 and §19.3, and the existing audit table's constraints. No trigger is disabled and no constraint relaxed. Fixtures follow the bypass-writer policy P1 to P7 (§17.4, item 25) and the write sequence of §19.3.

**Test connections.** In a disposable test database the harness gives a test: the test owner (a superuser) on two connections to that same database, `admin` and `secondAdmin`; a pool as `shopaccess_web`; and a pool as a named operator login. The second test-owner connection uses the same validated loopback target and the same administrator credentials as the first, is verified in the same way before it connects, and is closed with the others, after any transaction left open on it has been rolled back. It exists so that a test can hold a transaction open as the test owner and act as the test owner on an independent connection at the same time (PGT-118). It is a test facility only: it is not a role, it grants nothing, and no runtime role gains any privilege on the catalog or on any table through it.

"No side effects" below means the invariant of §19.10. PGT-116 is not assigned.

| ID | Test | Expected |
| --- | --- | --- |
| PGT-101 | Inventory after migration | Seven new tables; the 2.1 functions; the named triggers and deferred constraints of §19.3; the one-quote-per-intent key; ledger rows and checksums match the inventory |
| PGT-102 | Privileges | Exactly the grants of §19.13, including the column-level UPDATE on `owner_request_windows` and SELECT only on `confirmation_challenges`; no DELETE; worker has nothing |
| PGT-103 | Catalog privilege, as function owner | SELECT succeeds; row lock, UPDATE, INSERT, DELETE refused |
| PGT-104 | Owner-row lock | Lock succeeds; every UPDATE on `checkout_owners` rejected by its trigger |
| PGT-105 | State and event checks | Payment states, payment events, other actors, and `DRAFT` as a stored state rejected |
| PGT-106 | Candidate keys | The five unique constraints exist and are not deferrable |
| PGT-107 | Reciprocity, direct writes | Successor without a marked predecessor → rejected at commit; pointer to a root, unrelated or missing intent → rejected at once; a correct pair commits |
| PGT-108 | Ancestry | Root's predecessor changed from NULL → rejected; predecessor changed to a descendant → rejected; two-row, three-row and fully reciprocal rings in one statement → rejected |
| PGT-109 | Ring attempts by privileged direct writes, made serially: one committed transaction after another tries to close a two-row and a three-row ring | Every attempt rejected; no ring exists. Nothing is claimed or tested for concurrent bypass writers (§17.4, item 25). Concurrency through the functions is PGT-113 |
| PGT-110 | Successor pointer | Set without state change; changed; cleared; any update to a terminal row → each rejected |
| PGT-111 | New checkout, atomic | Exactly one group, intent, quote, item, transition, audit row; version 2; `QUOTED` |
| PGT-112 | Replacement, atomic. (a) Through `start_checkout`. (b) Direct invalid fixtures by the test owner, one for each of the six deferred constraints of §19.3. (c) A deferred check failing inside a real function call, under the P4 exception (§17.4, item 25). In one transaction that is always rolled back, the test owner creates a test-only `BEFORE INSERT` row trigger that returns NULL, then calls the function: S1, on `quote_items`, then `start_checkout`; S2, on `checkout_transitions`, then `start_checkout`; C1, on `checkout_transitions`, then `cancel_checkout` of a `QUOTED` intent | (a) Exactly the rows of §19.3. (b) Each violating transaction is rejected and leaves nothing. (c) The trigger suppresses the child row, so that row's own row-level AFTER triggers, including its deferred constraint trigger, do not fire for it. The deferred validation that fails is the one queued by the parent row: the quote's insert in S1; the intent's insert in S2; the intent's update in C1. It is forced inside the call. **The function call itself must raise, with the expected constraint name:** `quotes_item_check` in S1; `checkout_intents_history_check` in S2 and C1. A call that returns `STARTED` or `CANCELED` fails the test, even if a later COMMIT would fail. As a control, the same invalid state made by direct writes without forcing raises only at COMMIT. After the rollback the test trigger no longer exists and every table is unchanged. Trigger-name order matters only among triggers of the same event and timing; nothing is claimed about the test trigger's order relative to AFTER or deferred constraint triggers |
| PGT-113 | Two concurrent replacements | One `STARTED`, one `REPLACEMENT_NOT_ALLOWED`; one successor; pointers agree |
| PGT-114 | Predecessor stored as `CANCELED_LOCAL`; separately, stored as `SUPERSEDED` | Each `REPLACEMENT_NOT_ALLOWED`; admitted-call counter rises by one; no other change |
| PGT-115 | Replace racing cancel | Both orders; the second is refused |
| PGT-73a, 73e | `SAQD-1` vectors; no amount or digest parameter | Three digests match in database and TypeScript The inputs are those of §15.2 with its expansion, on both sides; the database side calls `quote_digest_saqd1` as the test owner. The expected digests are the ones stated in §15.2 and are never changed to fit an implementation. The helper returns the same digest under different `TimeZone` and `DateStyle` settings |
| PGT-12 (reworded), PGT-117 | Reprice committed while `start_checkout` waits; reprice uncommitted | New price and revision together; old values with no blocking; never a mixture |
| PGT-118 | Catalog writer | Reprice neither waits nor blocks; variant deletion → error, nothing written The reprice is tested directly on `merchant_variants`: a checkout of the variant is held open and uncommitted on one test-owner connection, so the key-share lock of its item's foreign-key check stays held; the lock is shown to be held by that transaction (a `FOR UPDATE` request for the variant row from the second test-owner connection waits for exactly that backend and is not granted); the update of price and revision on the second connection then completes and commits before the holder is released |
| PGT-119 | Quote lifetime | `expires_at` exactly 15 minutes after `created_at`; other values rejected; effective status just before, at and after expiry; stored state unchanged by expiry The exact instant of expiry cannot be produced by a test, because no function takes a time (§18.8). The evidence for it is in two parts: PGT-135 establishes on the source of both read functions that the comparison is "at or after" (the statement's start time `>=` the quote's `expires_at`); and one quote is read as `QUOTED` while the server still reports its expiry ahead and as `QUOTE_EXPIRED` once the server reports it reached |
| PGT-13 | Quote and item immutability | Update and delete rejected |
| PGT-120 | Material change reported | One case per material field → stale; image path or revision alone → not stale; snapshot labels unchanged after a rename `descriptive_terms_digest` is computed in the database for D1 and D2 of §15.2 and compared with the proposed targets; a mismatch is investigated and reported, not edited away (§15.2). A specifications object rewritten with its keys in another order is not stale. `quote_material_change`, called by the test owner, reports a different currency and a different product for the variant as stale: the catalog's own constraints prevent producing those two by data |
| PGT-81a, b, d, e; PGT-121 | Group capacity; expired quotes still count | Refused at 10, permitted at 9; history not counted; concurrent starts never exceed 10 |
| PGT-122 | Intents per group | Tenth permitted, eleventh `GROUP_INTENT_LIMIT`; independent of the group limit |
| PGT-123 | Capacity refusal audit: `AT_PURCHASE_CAPACITY`, and separately `GROUP_INTENT_LIMIT` | For each: N refusals → exactly N new audit rows, every one with event type `CHECKOUT_REFUSED_AT_CAPACITY`, the caller's owner ID and a distinct event ID; no other new audit row; none for any other owner |
| PGT-124 | Throttle limit and boundary, from a missing row and from an existing row. (a) The limit. (b) The exact boundary, with the approved test clock (§18.8): the internal, pure window-classification helper of §19.7 called by the test owner with explicit existing-window values and explicit decision times; and function calls against backdated rows. A runtime role attempts to call the helper. (c) A call that crosses the boundary while waiting: its step 4 reading is confirmed to be before the boundary while it is blocked on the intent lock by the method of PGT-143; the database clock is polled past the boundary; the blocker is released | (a) 30 admitted, 31st `RATE_LIMITED`; boundary burst of 60 admitted; `NOT_AUTHORIZED` calls in between consume none of the 30. (b) Just before the boundary: the stored window; exactly at it and just after: a new window. A call at the boundary instant starts a new window. The helper writes nothing, and its call by a runtime role is refused. (c) The call is counted in the window assigned at step 4: `window_started_at` unchanged, `window_calls` one higher. The next call starts a new window whose start is its own step 4 reading. No fixed-duration sleep is used (b) also: `owner_window_decision` called with a decision time earlier than the window start answers "stored window" |
| PGT-125 | Over-limit evidence, from a missing row and from an existing row | 100 over-limit calls → `total_throttled` 100 and exactly one new audit row, with event type `OWNER_RATE_LIMITED` and the caller's owner ID; next window → exactly one more, on its first over-limit call; none for any other owner |
| PGT-126 | Throttle concurrency | Parallel calls → exactly 30 admitted |
| PGT-127 | Throttle scope. (a) A second live session for the same owner, inserted as a fixture. (b) A different owner. (c) Rotation after 20 admitted calls. (d) A newly admitted session | (a) Both credentials draw on one counter, 30 in total. (b) Independent counter. (c) Counter stays at 20. (d) New owner and new counter, as accepted Increment 1 behaviour |
| PGT-128 | Throttle and audit fail-closed (B-8). Six independent cases under the second exception of P4 (§17.4, item 25), each with one revocation from `shopaccess_definer` in a transaction that is always rolled back. K1: no throttle row, a call that will be admitted; INSERT on `owner_request_windows` revoked. K2: a row under the limit; UPDATE of `window_calls` revoked. K3: a row at the limit; UPDATE of `total_throttled` revoked. A1: a row at the limit with `window_throttled` 0; INSERT on `audit_events` revoked, so the counters are written first and the audit insert then fails. A2: an owner at group capacity; INSERT on `audit_events` revoked. A3: an ordinary new checkout; INSERT on `audit_events` revoked | For each case: the function call itself raises a privilege error and returns no row; the transaction is aborted; after ROLLBACK the privilege is present again and every row of the seven tables, the audit table and the throttle row is as before. If the call does not raise, the test issues ROLLBACK and fails. No other privilege statement is sent by any test |
| PGT-129 | `REQUEST_INVALID`, each argument | Every rule of §19.7 violated in turn → `REQUEST_INVALID`; no side effects |
| PGT-130 | `REQUEST_INVALID`, placement | Returns while the owner row is held by the test owner; over the limit still `REQUEST_INVALID`; with an unknown, expired or revoked session → `NOT_AUTHORIZED` |
| PGT-131 | Well-formed missing intent ID and well-formed foreign intent ID, under the limit and over it | Under: both `NOT_AUTHORIZED`, no side effects, the foreign row never locked. Over: both `RATE_LIMITED` with identical counter changes |
| PGT-132 | Credential revalidation: each element of §19.6 varied. Key revocation cases A, B1, B2 of §19.6, and activation during a call. The same cases for session revocation and rotation | A: revocation waits on the session row; checkout completes successfully; revocation completes afterward; a later call is `NOT_AUTHORIZED`. B1 and B2: `NOT_AUTHORIZED`, no side effects. Activation: call succeeds. In case A the waiting backend is identified by the method of PGT-143 |
| PGT-133 | Transactions and isolation (B-5). (a) A rolled-back call. (b) At `REPEATABLE READ`, `SERIALIZABLE` and `READ UNCOMMITTED`: each read function in three situations (authorized with rows; authorized with none, which for `read_checkout` is a well-formed ID of no intent; unauthorized), and each mutating function with and without a valid credential. (c) The same three read situations at `READ COMMITTED`. (d) Static: no entry point is wrapped | (a) No counter change and no audit row. (b) Every call raises SQLSTATE `0A000`; every table is unchanged. (c) `read_checkout`: one `OK` row; one `NOT_AUTHORIZED` row; one `NOT_AUTHORIZED` row. `list_owner_checkouts`: the owner's rows; no rows; no rows. (d) Holds. If a read case of (b) does not raise, implementation stops (§19.5) |
| PGT-134 | Declared column values and row counts of all seven tables and the audit table, before and after every outcome, from both a row-absent and a row-present throttle state | Exactly the permitted changes of §19.10. Audit rows are compared by count, event type and owner: one `CHECKOUT_REFUSED_AT_CAPACITY` for each `AT_PURCHASE_CAPACITY` and for each `GROUP_INTENT_LIMIT`; one `OWNER_RATE_LIMITED` for the first `RATE_LIMITED` of a window and none for later ones in it; none for `NOT_AUTHORIZED` or `REQUEST_INVALID`, which change nothing |
| PGT-135 | Read function form | Static: SQL language, `STABLE`, one statement that is a single SELECT ending in the LIMIT guard of §19.5; the only functions called are the four listed in §19.11 The same reading establishes the exact-equality case of PGT-119: in both read functions the effective status is `QUOTE_EXPIRED` when `statement_timestamp() >= ` the quote's `expires_at`, with no other comparison |
| PGT-136 | Read coherence | Barrier: an uncommitted change is invisible, then visible whole. Stress: no mixed state. Control: a two-statement reader in the test database does show a mixed state |
| PGT-08, 09, 69c | Ownership | Expired or revoked session creates nothing; checkout survives session deletion; another owner's intent is unreachable |
| PGT-137 | Cancel | Success from `QUOTED`, and from a `USER_CONFIRMED` fixture; `NOT_CANCELABLE` from the terminal states `CANCELED_LOCAL` and `SUPERSEDED` (a stored `EXPIRED` cannot be constructed in Increment 2.1); one transition, one audit row |
| PGT-138 | Reducer parity | `checkout_transition` and the reducer agree on every accepted combination, the quote-match guard, the pointer changes and the version increment; cancellation and supersession return the confirmation pointer they were given; entry point and version rules match T1 to T6; every combination outside T1 to T6 is not accepted; the exclusions listed in §19.12 are the only reducer-accepted cases refused |
| PGT-139 | Generated IDs | Duplicate intent, quote, transition and audit IDs rejected by their constraints; static check that no 2.1 function handles a unique violation |
| PGT-140 | `list_owner_checkouts` | Own rows only; at most 100; empty when not authorized |
| PGT-141 | Regression | Every Increment 1 database test and the whole Mock suite still pass |
| PGT-142 | Replacement of a predecessor whose quote has expired: stored `QUOTED`; separately, stored `USER_CONFIRMED` (fixtures below) | Each `STARTED`. Successor: `QUOTED`, no confirmation, a new quote from the current catalog. Predecessor: `SUPERSEDED`; its quote row unchanged. Audit: the fixture's synthetic rows are unchanged, and exactly two rows are added, `QUOTE_ISSUED` for the successor and `CHECKOUT_SUPERSEDED` |
| PGT-143 | Session expiry while waiting on the intent lock (below) | `NOT_AUTHORIZED`, no side effects |
| PGT-144 | Missing throttle row. (a) An owner's first call exits `NOT_AUTHORIZED`. (b) The owner's first admitted call. (c) Two first calls for the same owner in parallel | (a) No row exists afterward. (b) One row, call count 1. (c) One row, call count 2, no error |
| PGT-145 | Existing throttle row. Forward time: (a) `NOT_AUTHORIZED` within the window. (b) `NOT_AUTHORIZED` after the window has elapsed. (c) An admitted call after the window has elapsed. (d) A `RATE_LIMITED` call. Backward clock (B-4), by fixtures whose stored times are later than the database clock, because no function takes a time: (e) window start and `updated_at` in the future, under the limit; an admitted call. (f) The same at the limit; a `RATE_LIMITED` call. (g) Window start more than 60 seconds in the past and `updated_at` in the future; an admitted call. (h) An intent whose `created_at` and `updated_at` are in the future; `cancel_checkout` | (a), (b) Every declared column value unchanged, including window start and update time. (c) New window start, call count 1, window throttled count 0. (d) Only the two throttled counters and the update time change. (e) `window_calls` one higher; `window_started_at` and `updated_at` unchanged. (f) Only the two throttled counters change; `updated_at` unchanged. (g) A new window: `window_started_at` is the call's step 4 reading, `window_calls` 1, `window_throttled` 0; `updated_at` unchanged, because the stored value is the greater. (h) `CANCELED`; `updated_at` unchanged; the transition's two times are equal |
| PGT-146 | Quote and item, direct writes: a quote with no item; with a mismatched subtotal; with a second item | Each rejected, at commit or at once; a correct pair commits (Q1, Q2) |
| PGT-147 | History, direct writes by the test owner, made serially. (a) An orphan transition that names an intent which does not exist. (b) For an existing intent: missing T1; a version gap; a state discontinuity; a final-state mismatch; an extra transition | (a) Rejected at statement time by the immediate transition-to-intent foreign key. (b) Each rejected by the deferred history validation (H1 to H4) at the applicable constraint-check point: at COMMIT for a fixture that does not force the constraints, or at the statement that sets them to immediate. Nothing is claimed for concurrent bypass writers (§17.4, item 25) |
| PGT-148 | Every illegal edge, and every transition outside T1 to T6, including a wrong actor, entry point or version | Each rejected |
| PGT-149 | Confirmation pointer, direct writes: the challenge is not consumed; belongs to another intent; belongs to another owner; the pointer is changed or cleared after being set | Each rejected |
| PGT-150 | Challenge table, direct writes: illegal status changes; insert with a terminal status; a binding column changed; DELETE in each of the four statuses; TRUNCATE | Each rejected |
| PGT-151 | A second quote for one intent | Rejected |
| PGT-152 | Throttle table: bounds; a change of `owner_id`, by privilege as the function owner and by trigger as the test owner; DELETE; TRUNCATE | Each rejected |
| PGT-153 | Product and variant `catalog_revision` differ | The stored revision and the digest follow the variant (A-7) |
| PGT-154 | Static: the schema migration file | Contains no GRANT |
| PGT-155 | `EXPIRED`: inserted as a stored state; reached by update; named as a transition target | Each rejected |
| PGT-156 | Static: the Increment 2.1 migration files (P2) | No top-level INSERT, UPDATE or DELETE on the seven tables, that is, none executed when the file is applied. Statement text inside a `CREATE FUNCTION` body is not examined by this test |
| PGT-157 | Static: the Increment 2.1 database test files (P4) | No disabled or replaced production trigger, no relaxed or dropped constraint, no changed replication role. A trigger is created only in the PGT-112(c) test, only as a `BEFORE INSERT` row trigger returning NULL, and only inside a transaction that the test always rolls back and never commits The only privilege statements a 2.1 database test file may send are the four statements of the second exception of P4, each only inside the one function of the file that begins a transaction, always rolls it back and never commits. Negative controls, each refused by the reading: a GRANT; a REVOKE naming another table, column, privilege or role; one of the four statements outside that function; ALTER DEFAULT PRIVILEGES; ALTER ROLE; a change of ownership |
| PGT-158 | Privileged TRUNCATE of each of the seven tables, as the table owner and as the test owner: plain, with CASCADE, and naming several tables at once | Every statement is refused, and every table's row count and content are unchanged. Which mechanism refuses a statement, PostgreSQL's foreign-key rule or the table's trigger, and with which SQLSTATE, is recorded from the run for each statement and is not assumed beforehand |

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
- The fixture's synthetic `SHOPPER_CONFIRMED` transition names the entry point `consume_challenge`, as the rule of §19.2 requires, although that function does not exist in Increment 2.1 and did not run.

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

PGT-146 to PGT-158 were added with the exact-schema contract and its audit corrections; their numbering follows the manifest. When they were added, like every test in this manifest, none had been written or executed. Which tests have since been written, and which executed, is recorded in §19.18.

**Unverified PostgreSQL assumptions.** The exact-schema contract is approved on condition that the run above establishes each of these. Each is believed from documentation or from the Increment 1 design; none has been executed for Increment 2.1.
1. `SET CONSTRAINTS` can name a constraint trigger as well as a foreign key.
2. Setting constraints to immediate inside a function fires the checks queued earlier in that call, and setting them back to deferred suppresses nothing at commit.
3. A row-level before-insert trigger sees rows inserted earlier in the same statement.
4. A locking read of a `checkout_owners` row does not fire its update-rejecting trigger and needs only UPDATE privilege.
5. A trigger fires for a role that holds no EXECUTE on its function, and runs with that role's table privileges.
6. A column-level UPDATE grant is enough for the functions' updates and refuses a change to `owner_id`.
7. Every TRUNCATE of the seven tables is refused, by PostgreSQL's foreign-key rule or by the table's trigger. Which of the two answers first, and with which SQLSTATE, is not assumed: it is recorded from the run (PGT-158). For Increment 1 the foreign-key rule answered first for referenced tables (§18.15).
8. Microseconds since the epoch are derived exactly from `timestamptz`, and core `sha256` yields the vectors of §15.2.
9. An anchored pattern in a CHECK matches the whole value and rejects a trailing line terminator.
10. The role under which a deferred trigger runs when it fires at commit is not relied on: the functions force every pending check before returning.
11. A LIMIT expression is evaluated, and so raises, whether or not any row qualifies, including in a SQL-language function that is not inlined (§19.5).
12. A revocation made by the test owner inside a transaction is seen by a function called later in that transaction, disappears on rollback, and a single-column revocation leaves the locking read of the throttle row working (PGT-128).
13. `jsonb::text` prints the seeded specifications as §15.2 predicts, and the database encoding is UTF8.
14. `quote_digest_saqd1`, `descriptive_terms_digest` and `quote_material_change` return the same result under any `TimeZone` and `DateStyle`.
15. `statement_timestamp()` inside a `STABLE` SQL function is the start time of the calling statement.
16. A superuser's REVOKE of a privilege that `shopaccess_owner` granted removes that grant.

Rollback on every violation, and the concurrency properties of §19.3, are likewise design intentions until that run.

**Acceptance-test manifest, Increment 2.2 (decisions 1 to 17, §19.17).** Which of these tests have been written and which executed is recorded in §19.18 and nowhere else. F is `tests/db/confirmation-functions.test.ts`; C is `tests/db/confirmation-concurrency.test.ts`; U is `tests/unit/pg-confirmation-nonce.test.ts`; S is `tests/unit/pg-static.test.ts`. Unless a row says otherwise, a case runs on a live `QUOTED` intent with an `ACTIVE`, unexpired challenge. Every case asserts the result, the returned columns, the owner's request window, the challenge rows, the intent and its transitions, and the audit rows.

| ID | Case | Expected | File |
| --- | --- | --- | --- |
| PGT-223 | `read_checkout`: (a) an `ACTIVE`, usable challenge; (b) no challenge; (c) `ACTIVE` and not usable, for each of: past its expiry, quote expired, bound to another digest, intent canceled, material change, nonce key ended; (d) only challenges that have ended | 41 columns. (a) columns 34 to 40 are the stored row's, usable. (b), (d) NULL, not usable. (c) shown, not usable. A `VERIFY_ONLY` key is still usable | F |
| PGT-224 | `read_checkout`: failed credential; missing, foreign, malformed, no intent | One `NOT_AUTHORIZED` row; the 40 other columns NULL | F |
| PGT-225 | Static: the recreated reader | One SELECT, `STABLE`, the guard as LIMIT, only the permitted calls; the 33 columns of `0008` unchanged, then the eight | S |
| PGT-210 | First issue | `ISSUED`; one `ACTIVE` row bound to intent, owner, quote and stored digest; six-field summary from the stored quote; expiry rule; counter +1; no audit | F |
| PGT-14 | 25 issue calls and 200 reads inside the reuse window | One row; every later issue `REUSED`, returning the first; reads change nothing. (The owner throttle of 30 calls a minute makes 200 issue calls impossible) | F |
| PGT-16 | An `ACTIVE` challenge with 120 seconds left; with 30 seconds left; expired 30 seconds ago | `REUSED`; `ISSUED` with the old row `SUPERSEDED`; `ISSUED` with the old row `EXPIRED`. The comparison at exactly 60 seconds is static evidence only (PGT-227): no time seam exists | F, S |
| PGT-17 | A newer nonce key is activated; then issue under it | The older challenge `SUPERSEDED`; its nonce later `CONFIRMATION_SUPERSEDED` | F |
| PGT-211 | A quote with eight challenge rows in any status | `CHALLENGE_LIMIT_REACHED`; all eight unchanged, the `ACTIVE` one included; with seven, `ISSUED` | F |
| PGT-212 | Issue naming a `VERIFY_ONLY`, an ended, and a non-existent key version | `NONCE_KEY_NOT_ACTIVE`; no row; counter +1 | F |
| PGT-213 | Issue for an intent that is canceled, superseded, confirmed; a quote with a consumed challenge; an expired quote; a material change | The matching refusal; no row; counter +1 | F |
| PGT-73b, PGT-73b-r | A quote whose stored digest is wrong; issue five times | `QUOTE_DIGEST_MISMATCH` each time; five `CONFIRMATION_REJECTED` rows with `challengeId` null; no challenge; none of the five submitted IDs in any audit row | F |
| PGT-209 | Issue for a missing and for a foreign intent, under and over the limit | `NOT_AUTHORIZED`, nothing written; `RATE_LIMITED` over. The foreign intent is never locked: the call returns while another connection holds it | F, C |
| PGT-214, PGT-220 | Each malformed argument of both functions, under and over the limit | `REQUEST_INVALID`; nothing written | F |
| PGT-215 | (a) A challenge ID that already exists, on another quote of the same owner and on another owner's quote. (b) A new ID with a nonce digest that exists. (c) An ID that another owner's uncommitted call has inserted: the caller's insert waits for it; then that call is committed, and in a control undone | (a) `REFUSED`, counter only. (b) An error, `23505` on `confirmation_challenges_nonce_digest_key`; nothing survives. (c) `REFUSED`, counter only, the caller's previous `ACTIVE` challenge exactly as it was; in the control, `ISSUED` | F, C |
| PGT-216, PGT-217 | A correct submission; then five replays | `CONFIRMED`: challenge `CONSUMED`, intent `USER_CONFIRMED` version 3 with its pointer, one T2 transition, one `CONFIRMATION_ACCEPTED` with exactly three keys, one time for all of them. Replays: `CONFIRMATION_ALREADY_USED`, counter only | F |
| PGT-201a, b, c | Wrong nonce; wrong quote ID; wrong quote digest | `CONFIRMATION_MISMATCH`; one rejection; challenge still `ACTIVE` | F |
| PGT-202a, b | The stored quote digest is wrong; the challenge is bound to another digest | `QUOTE_DIGEST_MISMATCH`; one rejection | F |
| PGT-203a, b, c | Nonce key ended, correct values; ended, wrong nonce; `VERIFY_ONLY` | `CONFIRMATION_KEY_REVOKED` twice, audited; `CONFIRMED` | F |
| PGT-205 | 201a, 202a, 203a five times each | Five rejections each; no quota | F |
| PGT-206a to e | A `CONSUMED` challenge under an ended key; a `SUPERSEDED` one; both with a wrong nonce; an `ACTIVE` control; (a) five times | (a) `CONFIRMATION_ALREADY_USED`, 0 audits, +1. (b) `CONFIRMATION_SUPERSEDED`, 0, +1. (c) the same two. (d) `CONFIRMATION_KEY_REVOKED`, 1, +1. (e) 0 audits, +5 | F |
| PGT-207R | **A new requirement (decision 11); the historical PGT-207 was not recovered.** A missing and a foreign challenge ID, each under and over the limit: four cases | `CONFIRMATION_NOT_FOUND` in all four; counters unchanged; no audit. The foreign challenge, its intent and its nonce key are never locked: the calls return while another connection holds all three | F, C |
| PGT-208 | A challenge the holder has inserted and not committed; the call waits for its owner row; then another connection takes the challenge's nonce key row `FOR NO KEY UPDATE`; then the holder commits | `CONFIRMATION_NOT_FOUND`, returned while the key row is still held: a late `FOR SHARE` on it would conflict and end as a lock timeout. Nothing written | C |
| PGT-20 | A challenge that expired 30 seconds ago, stored `ACTIVE` | `CONFIRMATION_EXPIRED`; marked `EXPIRED`; no audit | F |
| PGT-218 | (a) A material change committed before the call; an expired quote; (b) a material change committed while issue or consume waits | `QUOTE_STALE_CATALOG`; `QUOTE_EXPIRED`; counter only | F, C |
| PGT-221 | G2-41: six submissions against a canceled intent and again against a superseded one, the challenge still `ACTIVE` | Correct: `INTENT_NOT_AWAITING_CONFIRMATION`. Wrong nonce, wrong quote ID or digest: `CONFIRMATION_MISMATCH`, audited. Malformed: `REQUEST_INVALID`. After expiry: `CONFIRMATION_EXPIRED`, marked. Foreign or missing ID: `CONFIRMATION_NOT_FOUND`. Never a transition, a pointer or an accepted row | F |
| PGT-222 | Eighteen overlaps of two conditions, a to r (§19.16) | The earlier row decides, in each | F |
| PGT-204 | Cases A4 to A8 (§17.4, P4) | Each raises `42501` with the message of the denied insert into `audit_events`, inside the function under test; then `25P02`; nothing survives | F |
| PGT-112(c), case S3 | (§17.4, P4) | `23514`, `checkout_intents_history_check`; nothing survives | F |
| PGT-133 | Every isolation level but `read committed`, for both functions and the reader, authorized or not | `0A000`; nothing changes | F |
| PGT-134 | Every outcome of both functions, from an owner without a request-window row and from one with a row | Exactly the changes of §19.10; snapshots of the seven tables, `audit_events` and `shopper_sessions` | F |
| PGT-226 | The ledger row and pin of `0009`; the three functions; the web role's direct statements on `confirmation_challenges` | Applied; owned by `shopaccess_definer`; executable by the web role alone; every direct statement refused. The column grants are asserted in `tests/db/privileges.test.ts` | F |
| PGT-227 | Static: migration `0009` | The three statements of §14 and nothing wider; exactly one exception handler, with its controls; the reviewed order of results; the audit rows; the strict 60-second comparison | S |
| PGT-228 | The four frozen nonce vectors N1 to N4 | The TypeScript module reproduces message, HMAC, nonce and digest; the database's SHA-256 of each nonce is the frozen digest | U, F |
| PGT-229 | A flow made with fixed sentinel values | None of them, and nothing that looks like a nonce or a digest, is in any audit detail. The same values are looked for in the retained output of a run, by the execution gate | F |
| PGT-15 | Two submissions of one challenge, forced into an order | `CONFIRMED`, then `CONFIRMATION_ALREADY_USED` | C |
| PGT-18 | Twenty submissions at once | One `CONFIRMED`, nineteen `CONFIRMATION_ALREADY_USED`, one transition, no error | C |
| PGT-19 | Issue against consume, forced: consume first; issue first with a reusable challenge; issue first with a challenge under an older key | `CONFIRMED`, `INTENT_NOT_AWAITING_CONFIRMATION`; `REUSED`, `CONFIRMED`; `ISSUED`, `CONFIRMATION_SUPERSEDED`. Never two `ACTIVE`, never two `CONSUMED` | C |
| PGT-54c | A confirmation that waits past its challenge's expiry | `CONFIRMATION_EXPIRED`; `ACTIVE` to `EXPIRED`; counter +1 | C |
| PGT-54g | An issue that waits past its quote's expiry | `QUOTE_EXPIRED`; no new row; the existing `ACTIVE` challenge not marked; counter +1 | C |
| PGT-143 (2.2) | Issue, and consume, waiting on the intent until the session has expired, from an absent and from a present window row | `NOT_AUTHORIZED`; not one row of any table changes | C |
| PGT-230 | Confirm against cancel, both forced orders | Confirm first: `CONFIRMED`, `CANCELED`; `CANCELED_LOCAL` at version 4, pointer preserved, challenge `CONSUMED`. Cancel first: `CANCELED`, `INTENT_NOT_AWAITING_CONFIRMATION`; version 3, no pointer, challenge `ACTIVE` | C |
| PGT-231 | Confirm against replace, both forced orders | Confirm first: `CONFIRMED`, `STARTED`; predecessor `SUPERSEDED` at version 4, pointer preserved. Replace first: `STARTED`, `INTENT_NOT_AWAITING_CONFIRMATION`; predecessor at version 3, challenge `ACTIVE` | C |
| PGT-232 | A nonce-key revocation against consume: after the call (A), before it (B1), holding the key row (B2); and against issue, the same three | A: the call completes, then the revocation, which waited for the call alone. B1, B2 for consume: `CONFIRMATION_KEY_REVOKED`, audited. B1, B2 for issue: `NONCE_KEY_NOT_ACTIVE`. `VERIFY_ONLY` against `ACTIVE` is PGT-17, PGT-203c and PGT-212 | C |
| PGT-233 | A session rotation or revocation holding the session row while issue or consume waits; and one sent after the call holds the row | `NOT_AUTHORIZED`, nothing written but the session change itself; the later change waits for the call alone, and the call completes | C |
| PGT-234 | An issue that crosses the window boundary while it waits; forty calls at once, ten of each mutating function, for one owner | Counted in the window of its step 4 reading. Exactly 30 admitted and 10 `RATE_LIMITED`; final counters 30, 10, 10; one `OWNER_RATE_LIMITED` row; nothing else changes | C |

- **Existing tests.** The 119 tests of Increment 1 and 2.1 stay. Those that count migrations, functions or the function owner's privilege on `confirmation_challenges`, and those that read a `read_checkout` row, are updated for migration `0009` (§19.18). PGT-137 and PGT-142 keep their direct-write fixtures and each gains a variant whose predecessor was confirmed through the two functions; that variant's quote is not expired, and full PGT-142 is not claimed.
- **Deadline-crossing cases (PGT-143 for 2.2, PGT-54c, PGT-54g, the boundary case of PGT-234).** A one-second database deadline is used, and the function under test is submitted only when the server reports at least half a second remaining. Retries are permitted only while establishing the pre-call timing condition, before submitting the function under test, at most five times, and the test fails visibly if the condition cannot be established. Once the function is invoked, that invocation is never retried. Any subsequent barrier failure, lock timeout, unexpected result or function error fails the test and remains visible. The holder is released, every submitted request is settled, and the test clients are closed through the reviewed cleanup path.
- **Not covered:** PGT-79 (confirm and authorize dispatch), deferred with dispatch.
- **Limits of what these tests can show.** The exact 60-second and exact-expiry instants are static evidence, with runtime cases on either side. Future-dated fixtures test the timestamp floors; they do not prove behaviour under a real backward clock step. The database holds no nonce key, so it cannot check a derivation: only the SHA-256 step is checked on both sides. PGT-204 injects only the failure of the audit insert. Only the primary-key name of the three constraints of decision 8 can be produced at run time; the other two have static coverage only. Where the operator pool sends a statement that must wait, that waiter is identified by what the server reports (its login and what blocks it), not by a backend recorded beforehand.
- **To be confirmed at first execution, and not assumed:** that `shopaccess_owner` may `SET ROLE shopaccess_definer` and that the function's owner may drop it; which constraint name an insert-time collision of a challenge ID reports; that a bare `RAISE` in the handler raises the original error again, with its constraint name; the constraint named in case S3; the message and context of the denied insert in cases A4 to A8.

### 19.16 Increment 2.2 contract; Increment 2.3 — outside this contract; deferred gates

**Status.** Increment 2.2 is the contract of this subsection, of the Increment 2.2 parts of §19.10, §19.11 and §19.13, and of the manifest at the end of §19.15. The owner approved decisions 1 to 17 (§19.17) and authorized its source implementation. That authorization is not an acceptance: what has been written and what has been executed is recorded in §19.18. Increment 2.3 is **not approved**. Sections 5.3 to 5.6 remain earlier proposed text; where they differ from this subsection, this subsection governs.

**Entry points.** Both are in schema `shopaccess_api`, owned by `shopaccess_definer`, definer-rights, PL/pgSQL, with a fixed search path and no dynamic SQL. Their first statement is the isolation guard of §19.5. Their first two parameters are `(p_key_version smallint, p_token_digest text)`; the owner is derived from the live session only. No new helper is created: the helpers of §19.7a and `session_is_live` are used.

| Function | Parameters after the credential | Returns, always exactly one row |
| --- | --- | --- |
| `issue_challenge` | `p_intent_id text`, `p_challenge_id text`, `p_nonce_key_version smallint`, `p_nonce_digest text` | `result text`, `challenge_id text`, `quote_digest text`, `nonce_key_version smallint`, `nonce_digest text`, `summary jsonb`, `expires_at timestamptz`. The six after `result` are non-NULL for `ISSUED` and `REUSED`, and NULL for every other result |
| `consume_challenge` | `p_challenge_id text`, `p_nonce text`, `p_quote_id text`, `p_quote_digest text` | `result text`, `intent_id text`. `intent_id` is non-NULL for `CONFIRMED` only |

**`REQUEST_INVALID`** (before any lock and before admission; no side effects, also when the owner is over the limit; a caller without a session that appears live receives `NOT_AUTHORIZED` instead). Intent ID: `ci_` and 32 lowercase hex. Challenge ID: `cf_` and 32 lowercase hex. Quote ID: `qt_` and 32 lowercase hex. Nonce key version: present and positive. Nonce digest and quote digest: 64 lowercase hex. Nonce: 42 characters of the base64url alphabet followed by one of `A E I M Q U Y c g k o s w 0 4 8`.

**Nonce (decision 1).** The nonce is computed by the web process and never reaches the database except as the argument of `consume_challenge`:

```text
nonce = base64url_unpadded(
  HMAC-SHA-256(
    key_for_version,
    ASCII("shopaccess.confirmation.v1")
    || 0x00 || ASCII(challenge_id)
    || 0x00 || ASCII(owner_id)
    || 0x00 || ASCII(quote_digest)))
```

- The message is 164 bytes: 26 for the label, 35 for the challenge ID, 36 for the owner ID, 64 for the quote digest, and three zero bytes. The output is 32 bytes; the nonce is its canonical base64url encoding without padding, 43 ASCII characters.
- The three fields are validated before they are keyed, by the same formats as above (`own_` and 32 lowercase hex for the owner), so no field can hold a zero byte. The key is at least 32 bytes.
- 32 bytes leave four significant bits in the last character, so only the sixteen characters listed above can stand last. A nonce is canonical when it decodes to 32 bytes and encodes back to the same text; the format check of `consume_challenge` is the same rule.
- The database stores the lowercase hex SHA-256 of the 43 ASCII characters of the nonce, and the version of the key. The nonce is stored, returned and audited nowhere.
- Issue uses the `ACTIVE` version of the nonce key. On `REUSED` the caller derives the nonce from the returned challenge ID, the returned quote digest and the returned key version, not from the values it sent.
- `src/lib/pg/confirmation-nonce.ts` holds the derivation. It takes the key as bytes, reads no environment variable, loads no key material, holds no statement text and is imported by nothing in the application.
- **Frozen vectors N1 to N4.** Owner `own_` and 32 × `2`. N1: key bytes `00` to `1f`, challenge `cf_` and 32 × `5`, quote digest the V1 digest of §15.2. N2: as N1 with key bytes `20` to `3f`. N3: as N1 with challenge `cf_` and 32 × `6`. N4: as N1 with the V3 digest of §15.2.

  | Vector | HMAC-SHA-256 | Nonce | Nonce digest |
  | --- | --- | --- | --- |
  | N1 | `b3a603c80e7656243140e3eaf3dc2a84096a48b25e23ec4b92b90b90c5afe2e9` | `s6YDyA52ViQxQOPq89wqhAlqSLJeI-xLkrkLkMWv4uk` | `2fffb9607e72006eba685e7ddac819d13bec2c94a5c1182610e2db0d80577d6f` |
  | N2 | `ec88ab5c88bb74e32b198c00bffdc8d2aaf95ef73d1146f4f9b0fcffc99460ce` | `7IirXIi7dOMrGYwAv_3I0qr5Xvc9EUb0-bD8_8mUYM4` | `143c49a989609bee83eeecc39619f5134a5005d01043aa8b3b366f21f87eb3c0` |
  | N3 | `0a82c05ca0cccb9eb16ba9d34189b26f064a9c7b1369a1e0a00e4bf38de7038d` | `CoLAXKDMy56xa6nTQYmybwZKnHsTaaHgoA5L843nA40` | `ec6af46bc975178a0317ffcf6c7c3aa7fb9cd138a058f21c62dac5ea104fa412` |
  | N4 | `805620934d8d699f9e6f66d520754b0b4e120db2e6f3a3fe5a4d20eb665ccdcb` | `gFYgk02NaZ-eb2bVIHVLC04SDbLm86P-Wk0g62Zczcs` | `f81b260f570657ef3ca1815da045acc92c47e05ab193ce7aa321dc727e953b0f` |

  They were calculated with standard-library HMAC, SHA-256 and base64 functions, and calculated a second time independently; every message, HMAC, nonce and digest agreed before they were frozen. They verify the vectors. They are not evidence that the module or a PostgreSQL run works.
- What a nonce does not prove: that a person made a gesture (§3.4, D-57). The database holds no nonce key, so it cannot check at issue that a submitted digest was derived correctly; a wrong one gives a challenge that cannot be consumed and takes one of the eight rows.

**Sequence and locks (decision 3; ranks of §19.4).** Nonce key row, session row, owner row, request-window row, intent, challenge. No key row is locked after the session row, and no catalog row is locked.

| Step | `issue_challenge` | `consume_challenge` |
| --- | --- | --- |
| 0a to 0c | Credential format; unlocked session lookup; argument format | The same |
| 0d | — | Unlocked lookup of the challenge by its ID and the caller's owner together |
| 1 | The nonce key row the caller named, `FOR SHARE`, if it exists | The key row of the challenge found at 0d, `FOR SHARE`; no lock if 0d found nothing |
| 2 | Session row `FOR SHARE`, found again by the exact credential | The same |
| 3 | Owner row `FOR UPDATE` | The same |
| 4 | Request-window row, if any, by a locking read; first clock reading; credential revalidation (§19.6) | The same |
| 4-own | — | If 0d found nothing: `CONFIRMATION_NOT_FOUND`. Before the throttle decision; not counted; nothing written |
| 4a, 4b | Throttle decision; `RATE_LIMITED` | The same |
| 5 | The intent by its ID and the caller's owner, `FOR UPDATE`; then the challenge rows of its current quote, `FOR UPDATE`, in ID order | The challenge's intent, `FOR UPDATE`; then the submitted challenge, `FOR UPDATE` |
| 6 | Second clock reading; final credential revalidation; the intent was found, otherwise `NOT_AUTHORIZED` | The same; the challenge was found |
| 7 | Admission, in the window assigned at step 4 | The same |
| 8 | Rules and writes | The same |

- What step 0d finds, or does not find, governs the rest of the call. A challenge that becomes visible after it is still `CONFIRMATION_NOT_FOUND`, and no key row is locked late (PGT-208).
- The status of the nonce key is read from the row locked at step 1. Issue requires `ACTIVE`. Consume accepts `ACTIVE` and `VERIFY_ONLY`; anything else is `CONFIRMATION_KEY_REVOKED`.
- Staleness is one call of `quote_material_change` in one statement after the last lock.
- A missing and a foreign intent, in `issue_challenge`, both select nothing at step 5: `NOT_AUTHORIZED` under the limit, `RATE_LIMITED` over it (G2-24b). Another owner's intent is never locked.
- The operator activates a nonce key version with the accepted `activate_key_version('confirmation_nonce', …)` (decision 13). No runtime role gains a privilege for it.

**`issue_challenge`, step 8, first match (decisions 2, 7 and 8).**

| # | Condition | Result | Beyond the admitted-call counter |
| --- | --- | --- | --- |
| 1 | The intent is not stored `QUOTED` | `INTENT_NOT_AWAITING_CONFIRMATION` | Nothing |
| 2 | The step 6 reading is at or after the quote's expiry | `QUOTE_EXPIRED` | Nothing |
| 3 | A material change of the catalog | `QUOTE_STALE_CATALOG` | Nothing |
| 4 | The `SAQD-1` digest of the stored quote, computed again, is not the stored digest | `QUOTE_DIGEST_MISMATCH` | One `CONFIRMATION_REJECTED` row, `challengeId` null |
| 5 | The key version the caller named does not exist or is not `ACTIVE` | `NONCE_KEY_NOT_ACTIVE` | Nothing |
| 6 | The quote already has a `CONSUMED` challenge | `CONFIRMATION_ALREADY_USED` | Nothing |
| 7 | The quote's `ACTIVE` challenge is bound to the stored digest, is under the key version the caller named, and has strictly more than 60 seconds left | `REUSED`, returning that challenge | Nothing |
| 8 | The quote already has eight challenge rows, in whatever status | `CHALLENGE_LIMIT_REACHED` | Nothing: no challenge row is changed |
| 9 | A challenge with the ID the caller sent already exists | `REFUSED` | Nothing |
| 10 | Otherwise | `ISSUED` | The previous `ACTIVE` challenge, if any, becomes `EXPIRED` (the reading is at or after its expiry) or `SUPERSEDED`; one new `ACTIVE` challenge |

- The new challenge has the caller's ID, nonce digest and key version; the stored quote digest; `issued_at` at the step 6 reading; `expires_at` the earlier of that reading plus 5 minutes and the quote's expiry.
- Its `summary` is built by the database from the stored quote and its item, with exactly the six fields `merchantName`, `productTitle`, `variantLabel`, `quantity`, `currency` and `totalCents`. The caller cannot supply it.
- **`REFUSED` means a collision of the caller-supplied challenge ID, and nothing else.** It keeps the admitted-call counter and creates and changes no challenge row and no audit row, on both of its paths: the lookup of rule 9, and the handler below.
- **The one exception handler of migration `0009` (decision 8).** The admission of step 7 stands before it. One block holds exactly two statements: the update that ends the previous `ACTIVE` challenge, and the insert of the new one. Its handler catches `unique_violation` and nothing else. It reads the schema, the table and the constraint of the violation, and answers `REFUSED` only when they are `shopaccess`, `confirmation_challenges`, and one of `confirmation_challenges_pkey`, `confirmation_challenges_id_intent_key` and `confirmation_challenges_id_intent_status_key`. These are the three unique constraints of the table that contain `id`; a violation of any of them can only mean that a row with that ID already exists. Every other error, a collision of the nonce digest included, is raised again and undoes the whole call, admission included. The block's sub-transaction undoes both statements, so on this path too the previous challenge is exactly as it was. This amends the retained Gate A wording that the handler "wraps only that insert". `consume_challenge` and `read_checkout` have no handler; the rule of §19.5 for database-generated IDs is unchanged.
- `issue_challenge` writes nothing that a deferred check watches, and forces none.

**`consume_challenge`, first match (decision 4).** Row 1 is decided at step 4-own. Rows 2 to 12 are decided at step 8, after admission, and are counted.

| # | Condition | Result | Audit | Other writes |
| --- | --- | --- | --- | --- |
| 1 | No such challenge for this owner | `CONFIRMATION_NOT_FOUND` | None | None; not counted |
| 2 | The submitted challenge is `SUPERSEDED` | `CONFIRMATION_SUPERSEDED` | None | Counter |
| 3 | The submitted challenge is `CONSUMED` | `CONFIRMATION_ALREADY_USED` | None | Counter |
| 4 | The challenge's nonce key is neither `ACTIVE` nor `VERIFY_ONLY` | `CONFIRMATION_KEY_REVOKED` | One rejection | Counter |
| 5 | Another challenge of the same quote is `CONSUMED` | `CONFIRMATION_ALREADY_USED` | None | Counter |
| 6 | The SHA-256 of the nonce is not the stored nonce digest, or the submitted quote ID or quote digest is not the challenge's | `CONFIRMATION_MISMATCH` | One rejection | Counter |
| 7 | The challenge is stored `EXPIRED`, or is `ACTIVE` and the step 6 reading is at or after its expiry | `CONFIRMATION_EXPIRED` | None | Counter; an `ACTIVE` challenge becomes `EXPIRED` |
| 8 | The `SAQD-1` digest of the stored quote, computed again, is not the stored digest, or the stored digest is not the one the challenge is bound to | `QUOTE_DIGEST_MISMATCH` | One rejection | Counter |
| 9 | The step 6 reading is at or after the quote's expiry | `QUOTE_EXPIRED` | None | Counter |
| 10 | A material change of the catalog | `QUOTE_STALE_CATALOG` | None | Counter |
| 11 | The intent is not stored `QUOTED` with this quote | `INTENT_NOT_AWAITING_CONFIRMATION` | None | Counter |
| 12 | Otherwise | `CONFIRMED`, with the intent ID | One acceptance | Below |

- Rows 2 and 3 before row 4, and unaudited, are G2-24a. The rest of the order is decision 4; row 5 after row 4 changes the Gate A order, in which it stood before the status rows.
- A challenge issued by `issue_challenge` never expires after its quote, so row 9 is reached only by a fixture whose challenge outlives its quote; the schema permits such a fixture.
- **Atomic success (row 12).** In this order, in the one transaction of the call: the challenge becomes `CONSUMED`; `checkout_transition` is asked for T2 with the stored state and pointers and the challenge ID, and its refusal is an error; the intent becomes `USER_CONFIRMED` with its confirmation pointer and status; one transition row is inserted; one `CONFIRMATION_ACCEPTED` row is inserted; the six deferred constraints of §19.3 are set immediate and then deferred, as the 2.1 functions do. The challenge comes before the intent because the pointer's foreign key is not deferrable. Any error undoes all of it. A replay meets row 3 and writes only the counter.
- **Eighteen overlaps for PGT-222.** (a) `CONSUMED` with a wrong nonce: row 3. (b) `SUPERSEDED` with a wrong nonce: row 2. (c) `SUPERSEDED`, and another challenge consumed: row 2. (d) `ACTIVE` under an ended key with a wrong nonce: row 4. (e) Stored `EXPIRED` under an ended key: row 4, audited every time (decision 9). (f) The same with another challenge consumed: row 4. (g) Stored `EXPIRED`, another consumed, key valid: row 5. (h) `ACTIVE` beside a consumed one, a direct fixture the functions never produce: row 5. (i) A wrong nonce past expiry: row 6, the challenge not marked. (j) A wrong nonce and a wrong stored digest: row 6. (k) Past expiry and a wrong stored digest: row 7. (l) A wrong stored digest and a material change: row 8. (m) A material change and a canceled intent: row 10. (n) An expired quote under a challenge that outlives it: row 9. (o) A wrong nonce from a caller whose window holds 30 admitted calls and no throttled one: `RATE_LIMITED` at step 4b, with `window_throttled` and `total_throttled` raised by one, one `OWNER_RATE_LIMITED` row and no rejection. (p) Stored `EXPIRED`, another consumed, and a wrong nonce: row 5. (q) A wrong stored digest and an expired quote: row 8. (r) An expired quote and a material change: row 9. Not constructible: a challenge that is both `CONSUMED` and `SUPERSEDED`; two `CONSUMED` challenges of one quote; an intent that is `USER_CONFIRMED` without a consumed challenge.

**Time (decision 6).** Expiry and reuse are decided on the step 6 reading as it is: the quote's expiry, the challenge's expiry and the 60-second reuse test. No floor is applied to a decision. `issued_at`, `superseded_at` and `expired_marked_at` are that reading. `consumed_at` is the later of that reading and the challenge's `issued_at`, and is written only after the expiry decision has passed. The step 4 reading decides the request window. The floors of §19.7 on the two `updated_at` columns are unchanged.

**A challenge left `ACTIVE` (decision 5, G2-41).** A challenge may stay `ACTIVE` in storage after its intent is canceled or superseded, or after its quote has expired. It is then unusable: a correct submission meets row 7, row 9 or row 11, and `read_checkout` reports it not usable.

**Replacing `read_checkout` (decision 12).** `CREATE OR REPLACE` cannot change a result type. Migration `0009` therefore begins with exactly these three statements, adjacent and in this order, and contains no other `DROP` and no other role command:

```sql
SET ROLE shopaccess_definer;
DROP FUNCTION shopaccess_api.read_checkout(smallint, text, text);
SET ROLE shopaccess_owner;
```

- The function belongs to `shopaccess_definer`, which `shopaccess_owner` may become through its existing membership; no membership is added. The migration role is named again explicitly; `RESET ROLE` is not used, because what it restores depends on how the session was opened.
- There is no `CASCADE` and no `IF EXISTS`. If the function is missing, or if anything depends on it, the statement fails and the runner's transaction undoes the whole migration.
- The file then creates the 41-column function of §19.11, revokes all on the three functions from PUBLIC, grants EXECUTE on them to `shopaccess_web`, grants the two table privileges of §19.13, and hands the three functions to `shopaccess_definer` with CREATE on the schema granted before the first change of owner and revoked after the last.

**Mock mode is unchanged.** The in-memory confirmation of Milestone 001 (`src/lib/confirmation/confirmation.ts`) is not altered and adopts none of this. Nothing in the running application calls the functions above.

**Increment 2.2 decisions.** The register is in §19.17.

**Increment 2.3 decisions — proposed here; their status now is in §19.17 and §19.19**

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
| Gate A | Closed by the owner as a design-only architecture review milestone; architecture baseline §19.1 to §19.15, subject to every recorded exclusion and unresolved decision | CLOSED (design only); authorizes no implementation, migration-writing or execution |
| A-1 to A-13 | Increment 2.1 exact-schema contract (§19.2, §19.3, §19.7, §19.13, §19.15), with its final corrections: the initial and replacement insert rules; `current_quote_id` NOT NULL with the write sequence; the transition-to-intent key; the bypass-writer policy P1 to P7; SELECT only on `confirmation_challenges`; mandatory forcing with no duplicate validator; function-level responsibility for digest, audit, eligibility, capacity and throttling; `recorded_at` not before `occurred_at`; the named constraints and triggers; PGT-146 to PGT-158 | APPROVED (design), conditional on later PostgreSQL 17 execution evidence; not implemented |
| Throttle clock | The step 4 reading is authoritative for the fixed-window classification and for any new `window_started_at`; the step 6 reading does not reassign the window (§19.7) | APPROVED (design); not implemented |
| G2-24a, G2-24b | Two Increment 2.2 design choices (§19.16) | APPROVED (design); applied in §19.16; status of files and execution in §19.18 |
| B-1 | Read signatures: 33 columns of `read_checkout`, 6 of `list_owner_checkouts`; `stored_state`, `effective_status`, `quote_stale`; `intent_` and `quote_` time prefixes; `QUOTE_EXPIRED` (§19.11) | APPROVED (design); status of files and execution in §19.18 |
| B-2 | Business-result order: eligibility, then catalog, then capacity (§19.7) | APPROVED (design); §19.18 |
| B-3 | Audit actors, columns and exact camelCase detail keys (§19.10) | APPROVED (design); §19.18 |
| B-4 | Timestamp contract, including `GREATEST` on both `updated_at` columns for an existing row (§19.7) | APPROVED (design); §19.18 |
| B-5 | Isolation guard: `0A000`; `read uncommitted` refused; LIMIT placement in the read functions; stop if execution disproves it (§19.5) | APPROVED (design); §19.18 |
| B-6 | Step 2 `NOT_AUTHORIZED` exit; conversion failures are errors; no session touch (§19.7) | APPROVED (design); §19.18 |
| B-7 | `SADT-1` (§19.2); D1 and D2 as proposed targets, not PostgreSQL-verified (§15.2) | APPROVED (design); targets unverified |
| B-8 | Second exception of P4: the four revocation statements of the six PGT-128 cases, and nothing wider (§17.4, item 25) | APPROVED (design); §19.18 |
| B-9 | Expansion of the `SAQD-1` vector inputs (§15.2) | APPROVED (design); digests unchanged |
| B-10 | Six internal helpers with their signatures, volatility and `SECURITY INVOKER`; `checkout_transition` as the full predicate that preserves unchanged pointers (§19.7a) | APPROVED (design); §19.18 |
| B-11 | Functions migration file name `0008_checkout_functions.sql`, one file (§14) | APPROVED (design); §19.18 |
| 2.2-1 | Nonce protocol and the frozen vectors N1 to N4 (G2-10; §19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-2 | Challenge lifetime 5 minutes capped at quote expiry; reuse only with strictly more than 60 seconds left; at most 8 rows per quote in any status (G2-13, D-6; §19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-3 | Sequence: steps 0d and 4-own; `CONFIRMATION_NOT_FOUND` before the throttle decision and not counted; key status rules (G2-24 remainder; §19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-4 | The order of the twelve rows of `consume_challenge`, with "another consumed challenge" after the key check (§19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-5 | A challenge may stay `ACTIVE` after its intent is canceled or superseded, and is then unusable (G2-41; §19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-6 | `consumed_at` floored at `issued_at`, applied only after eligibility is decided on the reading as it is (§19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-7 | Result codes `REUSED`, `CHALLENGE_LIMIT_REACHED`, `NONCE_KEY_NOT_ACTIVE`, `REFUSED` (§19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-8 | `REFUSED` is counter-only in every case: the lookup, and one handler filtered to the three ID-based constraints, with admission outside it. Amends the retained "handler wraps only that insert" wording (§19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-9 | A stored `EXPIRED` challenge under an ended key returns `CONFIRMATION_KEY_REVOKED`, audited each time (§19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-10 | `read_checkout` is replaced by a 41-column function; the names of columns 34 to 41; no separate reader (§19.11) | APPROVED; implementation authorized; §19.18 |
| 2.2-11 | PGT-207R is a new requirement. The historical PGT-207 was not recovered and is not claimed (§19.15) | APPROVED; implementation authorized; §19.18 |
| 2.2-12 | The one `DROP FUNCTION` and the two role commands of migration `0009`, with their static controls (§14, §19.16) | APPROVED; implementation authorized; §19.18 |
| 2.2-13 | The existing `activate_key_version` is the operator procedure for the nonce key (G2-21) | APPROVED as documentation |
| 2.2-14 | P4 extended to cases S3 and A4 to A8, with no new statement text (§17.4, item 25) | APPROVED; implementation authorized; §19.18 |
| 2.2-15 | The exact 60-second threshold is static evidence, with wide runtime cases on either side and no time seam (§19.15) | APPROVED; implementation authorized; §19.18 |
| 2.2-16 | Confirmation followed by cancellation returns `CANCELED`, with the confirmation pointer preserved, as migration `0008` already does (§19.15, PGT-230) | CONFIRMED |
| 2.2-17 | The audit rows of the confirmation events, with both times at the step 6 reading (§19.10) | APPROVED; implementation authorized; §19.18 |
| G2-16, 17, 18, 19 | Increment 2.3: configuration names; uncached catalog read; no challenge on a page load; in-process limits as a first line only | APPROVED as specified in §19.19; source implementation authorized; §19.18. G2-16 is approved as request-time fail-closed readiness (D8), not as a refusal to start the process |
| G2-20 | Browser download for automated browser and keyboard tests | DEFERRED with the application and database environment (D14, §19.19) |
| D1 to D14 (§19.19) | Increment 2.3 application-wiring decisions | D1 to D8 and D10 to D13 APPROVED; D9 resolved from the constraints of migration `0007`; D14 DEFERRED |
| G2-22 | Git preservation | PROPOSED, independent |
| G2-33 | Recovery design | DEFERRED |
| G2-27, G2-32 | Refusal quota; lifetime intent cap | WITHDRAWN |

### 19.18 Increment 2.1, 2.2 and 2.3 status record: approved design, files written, behaviour executed

This subsection is the only place in §19 that says what exists and what has run. It keeps three things apart. **Approved design** is an owner decision about what is to be built. **Written** means a file exists in the repository; it says nothing about whether the file is correct. **Executed** means PostgreSQL 17 ran it in a disposable test cluster and the result was recorded. Nothing below is an acceptance of Increment 2.1 or of Increment 2.2. No owner acceptance of either, in whole or in part, is recorded in this document.

**Schema stage (migration `0007`)**

| Item | Approved design | Written | Executed |
| --- | --- | --- | --- |
| `db/migrations/0007_checkout_schema.sql` | A-1 to A-13 (§19.17) | Yes; pinned in the runner inventory, SHA-256 `a20f362b83b6f06805a42a04d8b33875e1420b7ea21bb042166921f9450a2668` | Applied to disposable test databases only, in the two runs below |
| `tests/db/checkout-schema.test.ts` (schema part of §19.15) | §19.15 | Yes | Run A3-E1: 31 of 31 passed. Run A3-E2: 31 of 31 passed |
| Static tests PGT-154, PGT-156, PGT-157 for the schema stage | §19.15 | Yes | Database-free; passed in the unit suite as it stood before migration `0008` was written |

**The two database runs of the schema stage.** Both ran the complete database suite as it then was: eight test files, 72 tests, migrations `0001` to `0007`. The two later runs, which included migration `0008`, are recorded under the functions stage below.

| Run | Date | Cluster | Result | What it is evidence for |
| --- | --- | --- | --- | --- |
| A3-E1 | 10 October 2026 | A newly initialized disposable PostgreSQL 17.11 cluster | **71 passed, 1 failed, 0 skipped.** The failure was PGT-50 in `tests/db/migrations.test.ts`: three multi-table TRUNCATE statements were refused by PostgreSQL's foreign-key rule (`0A000`) where the test expected the table trigger (`23001`), because migration `0007` added tables that reference `checkout_owners` and `server_key_versions`. No statement succeeded. The test's expectation was outdated; the schema was not at fault | A historical failed run. It is kept as it happened and is not rewritten |
| A3-E2 | 11 October 2026 | A second, newly initialized disposable PostgreSQL 17.11 cluster | **72 passed, 0 failed, 0 skipped**, after the PGT-50 expectations were corrected in the test file only | The schema of migration `0007` and the Increment 1 regression, as tested by those eight files, and nothing more |

- Recorded from A3-E2 for PGT-158: 44 TRUNCATE attempts, all refused at the statement; 28 by the table's reject-change trigger (`23001`) and 16 by PostgreSQL's foreign-key rule (`0A000`), the same for the table owner and for the test owner.
- Established by those runs, among the unverified assumptions of §19.15: that `SET CONSTRAINTS` accepts the name of a constraint trigger (assumption 1), and which mechanism refuses each TRUNCATE (assumption 7). Assumption 2, forcing inside a function, was **not** established: no function existed.
- **Limit of the A3-E2 evidence.** The checksum of the test runner's cache file before and after the run was recorded in the session report and not in the retained acceptance log; the cache path was confirmed by its directory name, not by tracing the runner's resolver; the cache content was not inspected. This does not affect what the 72 tests showed, and no further run was made to resolve it.
- Neither run included migration `0008`, a function test, or any test written or changed after it.

**Functions stage (migration `0008`, Group B)**

| Item | Approved design | Written | Executed |
| --- | --- | --- | --- |
| The function contract: §19.5, §19.7, §19.7a, §19.10 to §19.13, §15.2 expansion, P4 second exception | B-1 to B-11 (§19.17), approved by the owner for design | Recorded in this document | Not applicable |
| `db/migrations/0008_checkout_functions.sql`: six helpers, four entry points, the grants of §19.13 | B-1 to B-11 | Yes; pinned in the runner inventory, SHA-256 `4bbc00c378c664e452c3677b708bd9a8ac431b9469a4fb989b1ce90b2b4cf0b4`, unchanged since before run B-E1 | Applied to disposable test databases only, in runs B-E1 and B-E2 below |
| `CHECKOUT_STATEMENTS` in `src/lib/pg/statements.ts`; `src/lib/pg/saqd.ts` (verification-only `SAQD-1` encoder) | §19.11; §5.1 | Yes. Neither is imported by the running application | Database-free. The unit suite passed with them, 18 files and 847 tests, before run B-E1. `CHECKOUT_STATEMENTS` has since been changed for Increment 2.2 (below) |
| `tests/db/checkout-functions.test.ts`, `tests/db/checkout-concurrency.test.ts` | §19.15 | Yes | Run B-E1: 30 of 30, and 14 of 17. Run B-E2, after the concurrency file's observation method was corrected: 30 of 30, and 17 of 17. Both files have since been changed for Increment 2.2 (below) and have not been run since |
| `tests/unit/pg-saqd.test.ts`; the additions to `tests/unit/pg-static.test.ts` (PGT-73e, PGT-135, the static parts of PGT-133 and PGT-139, the reducer side of PGT-138, PGT-156 and PGT-157 for the new files) | §19.15 | Yes | Database-free. Passed in the unit suite before run B-E1; `tests/unit/pg-static.test.ts` alone passed again, 40 of 40, on the sources of run B-E2 |
| Changes to existing tests for the eighth migration: inventory counts, the function list, the function owner's privileges, the PGT-157 file list | — | Yes | Run in B-E1 and B-E2, where the eight regression files passed, 72 of 72, in both |
| PGT-112(c): a deferred check failing inside a real function call (cases S1, S2, C1) | §19.15 and the first exception of P4 | Yes, in `tests/db/checkout-functions.test.ts`. The static test PGT-157 admits exactly its three fixture statements (one trigger function that returns NULL, and a `BEFORE INSERT` row trigger on `quote_items` or on `checkout_transitions`), only inside the one test function that begins a transaction on one client and always rolls it back | Executed and passed in B-E1 and B-E2 |
| `SADT-1` targets D1 and D2 (§15.2) | B-7 | In the specification and the function test | Computed by PostgreSQL 17.11 in B-E1 and B-E2, and equal to the targets, for the recorded inputs. The three `SAQD-1` vectors likewise; some of their amount inputs are reconstructions (§15.2, B-9) |
| Application mode: the running application | Increment 2.3 (§19.19) | See the application stage below | No |

**The two database runs of the functions stage.** Both ran the complete database suite as it then was: ten test files, 119 tests, migrations `0001` to `0008`. Each used its own newly initialized disposable PostgreSQL 17.11 cluster, loopback only, with no Unix socket, and ran the suite exactly once.

| Run | Date | Result | What it is evidence for |
| --- | --- | --- | --- |
| B-E1 | 11 October 2026 | **116 passed, 3 failed, 0 skipped**, and two unhandled rejections. The three failures were in `tests/db/checkout-concurrency.test.ts`: PGT-113, PGT-115, and the nine-groups case of PGT-81d. In the first two, the test observed lock waits through the holder's own connection inside its transaction, where the picture of `pg_stat_activity` taken first is kept, so a second waiter was never seen and one checkout call ran into its lock timeout. In the third, the test required every waiter to name the row's holder as its blocker; PostgreSQL named an earlier waiter. The tests' method was at fault; no defect of migration `0008` was shown, and none was ruled out for those three cases by this run. Retained: `run-be1-20261011-111925`, `acceptance.log` SHA-256 `1b82f1d22e5a11ee72ce444f558ff6d4b8981094876a39ca6f2cf1e5dcdf893d` | A historical failed run. It is kept as it happened and is not rewritten |
| B-E2 | 11 October 2026 | **119 passed, 0 failed, 0 skipped**, with no unhandled rejection, after the concurrency test file alone was corrected: each waiting call on a web client of its own, an observer outside any transaction, and a checked lock queue. Two lock timeouts were logged, both expected controls: the lock probe of PGT-118 and the lock-timeout control of PGT-49. Retained: `run-be2-20261011-121410`, `acceptance.log` SHA-256 `dfd327ba35d09358de4a485e95951b9e66aa2593a1692c58807e8b7d5c227ed9`, `server.log` SHA-256 `a2580e54013c27f9698767c014318777308f357e89f5c76ce5a4f2ec1f125c97` | Migrations `0001` to `0008` and the ten test files as they were in that run, and nothing more. An execution result, independently reviewed. It is not an owner acceptance |

- In both runs the catalogs recorded after the run equalled those recorded before it, and the server was stopped.
- Both runs are of the sources as they were then. Migration `0009` and every file changed for it (below) are later than both.

**Confirmation stage (migration `0009`, Increment 2.2)**

| Item | Approved design | Written | Executed |
| --- | --- | --- | --- |
| The contract: §19.16, the Increment 2.2 parts of §19.10, §19.11 and §19.13, the manifest at the end of §19.15, P4 for cases S3 and A4 to A8 | Decisions 2.2-1 to 2.2-17 (§19.17), approved by the owner, who authorized the source implementation | Recorded in this document | Not applicable |
| `db/migrations/0009_confirmation_functions.sql`: `issue_challenge`, `consume_challenge`, the 41-column `read_checkout` in the place of the 33-column one, two table grants and three EXECUTE grants | The same | Yes; pinned in the runner inventory, SHA-256 `931c9cc7b97000017ef900050b6e94f31c58d28db039b995b0247ce858a1241d`, unchanged since before run C-E1 | Applied to disposable test databases only, in runs C-E1 and C-E2 below |
| `src/lib/pg/confirmation-nonce.ts` (the nonce derivation; unchanged, and since Increment 2.3 used by `src/lib/pg/checkout-service.ts`, with its form check used by the confirm handler); `issueChallenge`, `consumeChallenge` and the 41-column `readCheckout` in `src/lib/pg/statements.ts` | §19.16; §19.11 | Yes | Database-free. The unit suite passed with them, 19 files and 859 tests, before run C-E1 and again before run C-E2. The same three statement texts, which the static suite compares with the database tests' own copies, were sent to PostgreSQL by the database tests of C-E1 and C-E2 |
| `tests/unit/pg-confirmation-nonce.test.ts`: the frozen vectors N1 to N4 | §19.16 | Yes | Database-free. Passed, 5 of 5, in the unit suite before run C-E1 and before run C-E2. The database side of the same vectors (PGT-228) passed in C-E1 and C-E2 |
| `tests/db/confirmation-functions.test.ts`, `tests/db/confirmation-concurrency.test.ts` | §19.15 | Yes. The first was extended before run C-E1 so that the PGT-134 matrix covers every result of both functions, with `RATE_LIMITED` on a full window and its row-absent combination recorded as not applicable | Run C-E1: 27 of 27, and 15 of 15. Run C-E2: 27 of 27, and 15 of 15 |
| Changes to existing tests for the ninth migration: inventory counts and the static checks of `0009` in `tests/unit/pg-static.test.ts` and `tests/unit/pg-migrate.test.ts`; the function list and ledger in `tests/db/migrations.test.ts`; the function owner's privileges on `confirmation_challenges` in `tests/db/privileges.test.ts`; the reader's 41 columns, the function list, the privilege and two accepted-confirmation variants in `tests/db/checkout-functions.test.ts`; the copy of the reader's statement in `tests/db/checkout-concurrency.test.ts` | — | Yes | Run in C-E1 and C-E2. In C-E1 two tests of `tests/db/migrations.test.ts` failed on a ledger count that still said eight; the two expectations were corrected to nine, in the test file only, and all twelve files passed in C-E2. `tests/unit/pg-static.test.ts` has since been changed for Increment 2.3; its unit runs are recorded under the application stage below |
| Application mode: the running application | Increment 2.3 (§19.19) | See the application stage below | No |

**The two database runs of the confirmation stage.** Both ran the complete database suite as it then was: twelve test files, 162 tests, migrations `0001` to `0009`. Each used its own newly initialized disposable PostgreSQL 17.11 cluster, loopback only, with no Unix socket, and ran the suite exactly once.

| Run | Date | Result | What it is evidence for |
| --- | --- | --- | --- |
| C-E1 | 11 October 2026 | **160 passed, 2 failed, 0 skipped**, with no unhandled error. The two failures were PGT-51 and PGT-50 in `tests/db/migrations.test.ts`: each expected eight ledger rows where migration `0009` makes nine. The test expectations were stale; no defect of migration `0009` was shown. PGT-50 stopped before its refusal checks. Before the suite, two identity queries written by the operator failed through the operator's own errors and a third succeeded; both failures are in the retained logs. Retained: `run-ce1-20261011-181733`, `acceptance.log` SHA-256 `92b177e70228d5016e8707ebdeb24c59eaab212698ec97787b1275d53d8e3587`, `server.log` SHA-256 `12fd90aa7d64eefda502047a5ad13260d6a6c7217ea99c20bb3adfd78f54e790` | A historical failed run. It is kept as it happened and is not rewritten |
| C-E2 | 11 October 2026 | **162 passed, 0 failed, 0 skipped**, with no unhandled error, after the two ledger expectations alone were corrected. PGT-51 passed its final ledger assertion and PGT-50 reached and passed its refusal and preservation checks. Two lock timeouts were logged, both expected controls: the lock probe of PGT-118 and the lock-timeout control of PGT-49. The fixed values of PGT-229 occur in neither retained log. Retained: `run-ce2-20261011-182654`, `acceptance.log` SHA-256 `a214369246af7fd512ab4c2a83f15442e926d91fd23e8497b539badf34daf741`, `server.log` SHA-256 `9ef9d527322c26ea3cc5685b143b7c3243417030a0d69bebf4b8dcc6eecaca9f` | Migrations `0001` to `0009` and the twelve test files as they were in that run, and nothing more. An execution result. The owner's instruction for Increment 2.3 states that an independent review of the retained evidence returned a pass; that review is not reproduced here. It is not an owner acceptance |

- In both runs the catalogs recorded after the run equalled those recorded before it, and the server was stopped.
- Sources of C-E2: `db/migrations/0009_confirmation_functions.sql` as pinned above; `tests/db/confirmation-functions.test.ts` SHA-256 `8fd2bdc3f2d54aeb34ce42b359dc7fc04433569e5e41e7e2fc7a3e1fc892a2cd`; `tests/db/confirmation-concurrency.test.ts` SHA-256 `9f30f782d5228bddc9e47d20132323a889dad707ebc950884952bb55a1cd5f8e`; `tests/db/migrations.test.ts` SHA-256 `3d47904790caf668b51dff0ac339678150f354cabbb98f6778d47dac582f3f3c`.
- Both runs are of the sources as they were then. Every file written or changed for Increment 2.3 (below) is later than both. No database test file has been changed since C-E2.

**Application stage (Increment 2.3, §19.19)**

| Item | Approved design | Written | Executed |
| --- | --- | --- | --- |
| The contract: §19.19, and the amendment of §5.4 | D1 to D8 and D10 to D13 approved by the owner, who authorized the specification amendment and the source implementation; D9 resolved from source; D14 deferred | Recorded in this document | Not applicable |
| `APPLICATION_STATEMENTS` in `src/lib/pg/statements.ts`: the joined catalog read and the readiness probe. The four earlier groups are unchanged | §19.19 | Yes | **No. Neither statement has been parsed or executed by PostgreSQL.** That the probe is valid SQL, and that it returns the expected row for the web role, is not established |
| `src/lib/pg/checkout-service.ts`, `src/lib/pg/catalog.ts`, `src/lib/pg/readiness.ts`; `credentialOf` added to `src/lib/pg/session-service.ts` | §19.19 | Yes | Exercised by unit tests against fakes of the database only (the unit runs below). **Never run against PostgreSQL** |
| `src/server/pg-runtime.ts`, `pg-request-guard.ts`, `pg-handlers.ts`, `pg-views.ts`; the mode choice in `src/server/config.ts`, `runtime.ts` and `respond.ts`; new messages in `src/server/views.ts` | §19.19 | Yes | The handlers, the guard, the view builders and the runtime are exercised by unit tests against fakes (the unit runs below). **The application has never been started in PostgreSQL mode, and no PostgreSQL-mode request has been served** |
| Routes and pages: `src/app/session/{start,new,rotate}/route.ts`; `src/app/checkout/start/route.ts`; `src/app/checkout/[intentId]/{confirm,review,cancel,simulate}/route.ts`; `src/app/page.tsx`, `src/app/shop/page.tsx`, `src/app/checkout/[intentId]/page.tsx`, `src/app/checkouts/page.tsx`; `src/components/CheckoutActions.tsx`, `src/components/SessionNotice.tsx` | §19.19 | Yes | **Not built.** Type-checked as ordinary TypeScript in T-2 (the type checks below); the framework's own validation of the new routes and pages is pending, because the generated route types predate them. No page has been rendered. Three components (`CheckoutActions`, `SessionNotice`, `ConfirmationSummary`) are rendered to static markup by unit tests; that is not a rendering of a page and not browser or keyboard evidence. The start page, which was built ahead of time, is now rendered per request in both modes, so that a page built for one mode is never served in the other |
| `tests/unit/pg-app-config.test.ts`, `pg-app-guard.test.ts`, `pg-app-flow.test.ts`, `pg-app-readiness.test.ts`: the unit level of the acceptance map of §19.19 | §19.19 | Yes | Run; see the unit runs below. They use fakes of the database; a fake returning a value is not evidence that PostgreSQL returns it |
| Changes to `tests/unit/pg-static.test.ts`: eleven library modules; the import boundary of the four PostgreSQL server modules in place of "imported by nothing"; the fifth statement group, its arities and the three system-catalog sources the probe may name | §19.19 | Yes | Run; see the unit runs below. After the first run three of its assertions were corrected and its narrow rule on mutating checkout calls was added and then strengthened |
| The integration and browser cases of §19.19 (levels I and B) | §19.19 | Not written as executable tests. They are recorded as pending | **No.** They need an application with a newly created disposable database, and browser tooling; both are a separate gate (D14). No retained test cluster is to be used as an application database |

**The unit runs of the application stage.** Each ran the complete unit configuration (`tests/unit`), database-free, with the verbose reporter. None connects to PostgreSQL, starts the application or runs a browser. They are six separate records and are not merged.

| Run | Date | Result | Capture |
| --- | --- | --- | --- |
| U-1 | 11 October 2026 | **Failed.** Three failures were observed, all in assertions about source text: one in `tests/unit/pg-harness.test.ts` (the static-test file had come to contain the text that scan looks for) and two in `tests/unit/pg-static.test.ts` (a remaining "nothing sends a checkout statement" rule, and placeholders compared as text where the readiness probe has thirteen). No failure was observed in the four new test files or in the mock's tests | **Incomplete.** The output was cut by the operator's own display limit and was not retained. The count of 947 tests in 23 files is reconstructed from the per-file lines that were shown. The exit status was not retained |
| U-2 | 11 October 2026 | **Reported passed: 950 of 950 in 23 files, exit status 0 observed by the reviewer who ran it.** It followed a correction of `tests/unit/pg-static.test.ts` alone, made by the independent reviewer under an instruction the owner had intended for the implementer: the driver-import pattern, a rule on references to the checkout catalogue and on wrapping of mutating calls in place of the obsolete rule, and numeric comparison of placeholders. The implementer did not observe this run | **Incomplete.** The verbose output was truncated by the tool that ran it and no complete transcript exists. Whether a no-connection guard was in place, and whether it reported anything in the omitted output, is not known |
| U-3 | 11 October 2026 | **Failed: 955 passed, 3 failed, of 958 in 23 files; exit status 1.** It followed changes to `src/lib/pg/checkout-service.ts` (refusal rows must carry nothing), `src/server/pg-handlers.ts` (the start quantity held to 1 to 10) and two test files. The three failures were the three new component-markup tests of `tests/unit/pg-app-flow.test.ts`: each expected a form's attributes in the order of the source, and the renderer writes them in another order. The tests were at fault; each stopped at its first assertion, so their later assertions did not run. No guard line and no unhandled error | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-unit-20261011-211221/unit-run.log`, SHA-256 `f50a25122fcd03b7bed3204b9e39180b1c82905a1dd22f93624d80bcf3f7ee57`: all of standard output and standard error, and the exit status |
| U-4 | 11 October 2026 | **Passed: 959 of 959 in 23 files; exit status 0.** It followed a correction of the component-markup tests alone: a form is found by its action, and its method, fields and button are asserted on that same form, whatever the order of attributes; one control test of that reading was added, which is why the count is 959. All four markup tests ran to their end. No guard line and no unhandled error | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-unit-20261011-211755/unit-run.log`, SHA-256 `4ea3e05efec1c17874ec06c306c1c66723ea9ab84bf9f9cd4e45a06cde41c697`: all of standard output and standard error, and the exit status |
| U-5 | 11 October 2026 | **Passed: 965 of 965 in 23 files; exit status 0.** It followed three corrections of how answers are read, with their controls: every refusal of `start_checkout` must have its three other columns NULL; the `ISSUED` and `REUSED` rows of `issue_challenge` are read completely and held against the checkout of the handler's own authorized read (stored quote digest, the key version the call named, the checkout's summary, and an expiry no later than the quote's, with no comparison against the process clock); and every refusal of `admit_session`, `authorize_session` and `rotate_session` must have its other columns NULL. One fixture of `tests/unit/pg-session-cookie.test.ts`, a refusal row that left out its two NULL columns, was completed. No guard line and no unhandled error | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-unit-20261011-213057/unit-run.log`, SHA-256 `443ba7dc553012eda80c3770248a144fd8bf51b1ab5f5444cc87918aabe500ba`: all of standard output and standard error, and the exit status |
| U-6 | 11 October 2026 | **Passed: 967 of 967 in 23 files; exit status 0.** It followed one correction of how `read_checkout` is read, with its controls: the ACTIVE challenge reported beside a quote must be the challenge of that quote, with the same six summary values and an expiry no later than the quote's, by the same rule as for the `ISSUED` and `REUSED` rows and with no comparison against the process clock. A row in which they disagree is an unexpected row: the page shows "not available", the handlers that read first answer the generic 500, and nothing is sent after that read. No guard line and no unhandled error | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-unit-20261011-213754/unit-run.log`, SHA-256 `386e1ff7d3377b01d755ea248a762cc155b22110001cee9e4615066ac2a981c6`: all of standard output and standard error, and the exit status |

- Sources of U-6: `src/lib/pg/checkout-service.ts` SHA-256 `d2a03e996c1c64716012c3d9f62070ef9b3e7c6767220caf2ade4a5107a37d78`; `tests/unit/pg-app-flow.test.ts` SHA-256 `fdb7dbbf74b2d482f719d55e3dfcad5192f32e7d3093acd19671a53fa3624701`; every other file as for U-5. The files as they were for U-6 were not parsed or checked outside the suite beforehand.
- Sources of U-5: `src/lib/pg/checkout-service.ts` SHA-256 `dbdfe35b5f4c8dc8f3b664ea038e0a6ef5bba026c38f889cf8eaeb72ea0b4462`; `src/server/pg-handlers.ts` SHA-256 `2fa85eaaa008b2ee830e8324b6c4fec110ed48097d2f31a0b59a3d792db098be`; `src/lib/pg/session-service.ts` SHA-256 `5d2c600032a476af38e149d7b939bf69760a4619feab5036f7473d7c349dede7`; `tests/unit/pg-app-flow.test.ts` SHA-256 `6d501f7900927ebf4e929b4fb3269beea9c678ba8b2b8b33ad2162dbc1b9970d`; `tests/unit/pg-app-guard.test.ts` SHA-256 `8b47a9b2ed4a94258c5a84581cd6c9cf2ac1e1e7e7458e3631d7f6309bbf4c5a`; `tests/unit/pg-session-cookie.test.ts` SHA-256 `4430643e667615f950344d65eab0e480c992cbed3eeab3aa33612fc2bfd540f9`; `tests/unit/pg-static.test.ts` unchanged since U-4. The files as they were for U-5 were not parsed or checked outside the suite beforehand.
- Sources of U-4: `src/lib/pg/checkout-service.ts` SHA-256 `b8efa4f197ce7d4753dbc5ae8a948b3efbde996e3eadeee8490aa942ff5f5014`; `src/server/pg-handlers.ts` SHA-256 `447a594784b363b730dc1611b63e3156e4caebeac73d158e61d4928b6727606d`; `tests/unit/pg-static.test.ts` SHA-256 `0ea19ebe41f9286ac7e20255dae67b6af8ca3260b7e9381b4bdf9adb0f89514e`; `tests/unit/pg-app-flow.test.ts` SHA-256 `13500d70f0463e94b8f0bd5798a9710945ef16f9e83ff0364c38ebb0154621c7`. Every other file of Increment 2.3 is as it was when first written.
- The guard used in U-1, U-3, U-4, U-5 and U-6 reports attempts to open a TCP connection and nothing else. It does not cover Unix sockets, and a run without a guard line is not proof that no connection could have been made another way.
- Before U-1, and again before U-3, the implementer parsed the new and changed files for syntax only, with no type information. That was not a type check. Before U-3 the implementer also rendered the framework's link component once in plain Node and evaluated the new static rule on the service file, both outside the suite; neither was repeated before U-4.
- The three findings that were open after U-4 (refusal rows of `start_checkout`; the unchecked columns of `ISSUED` and `REUSED`; the refusal rows of the three session entry points) were corrected before U-5.
- The question that was open after U-5 about the ACTIVE challenge of `read_checkout` (its summary and expiry against the quote's own columns) was corrected before U-6.
- Open questions kept for independent assessment, not changed, and regarded as optional hardening: `authorize_session` treats a result that is neither `AUTHORIZED` nor `NOT_AUTHORIZED` as "not authorized" without checking the row, where the other two session calls refuse an unknown result; the row `revoke_session` returns is not read; the success rows of the session entry points are checked field by field but not for the relation between their two expiries, which this document does not require.
- Not rendered by any test: the four pages as a whole, the "not available" notice that is written inside them, and the absence of the simulation panel on the PostgreSQL checkout page, which remains a check of the source text.

**The type checks of the application stage.** Each ran the installed compiler, TypeScript 5.9.3, once over the whole project as `tsconfig.json` includes it (application sources, unit tests and database tests), with the command `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`. Neither wrote a file in the repository; `tsconfig.tsbuildinfo` was unchanged by both. They are two separate records.

| Check | Date | Result | Capture |
| --- | --- | --- | --- |
| T-1 | 11 October 2026 | **Failed: exit status 2, one diagnostic.** `TS2345` at `tests/unit/pg-app-flow.test.ts(500,60)`: the array of malformed start fixtures, written as a literal, had an element type that is not assignable to the helper's `Record<string, string>` parameter. A typing error in a test of Increment 2.3; no production source was named | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-types-20261011-214051/typecheck.log`, SHA-256 `b467149cd5554c9ca1ec4552b965f50a2662b50ac59d85c61ffa918e5d9ad998`: the command, all of standard output and standard error, and the exit status |
| T-2 | 11 October 2026 | **Passed: exit status 0, no diagnostics.** The only correction was to give that fixture array, unchanged in its values and order, the explicit type `Array<Record<string, string>>`. No production source changed | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-types-20261011-214927/typecheck.log`, SHA-256 `ef70150a01775c5cd58a4d778ef7095838c2fde3342586e3f8df52d6f2439fe2`: the command, all of standard output and standard error, and the exit status |

- Source of T-2: `tests/unit/pg-app-flow.test.ts` SHA-256 `2d742514eece1cde0a01f8aaf2f2502161221c91143f2c0b524a20c3959ded39`; every other file as for U-6.
- **U-6 ran against the earlier version of that test file** (SHA-256 `fdb7dbbf74b2d482f719d55e3dfcad5192f32e7d3093acd19671a53fa3624701`), before the annotation. The annotation changes a type and no value; the unit suite has not been run with it.
- **The generated framework types predate the Increment 2.3 routes.** They were present, dated 11 October 2026 14:05, and were not regenerated. The new route and page files were checked as ordinary TypeScript and produced no diagnostic, but the framework's own validation of route and page modules did not cover `/session/new`, `/session/rotate`, `/checkout/[intentId]/review`, `/checkout/[intentId]/cancel` or `/checkouts`. That was the state at T-1 and T-2, and neither of them is changed by what follows; the gap was closed afterwards by R-1 below.
- No baseline type check exists from before Increment 2.3, so T-2 says nothing about when any earlier state of the project type-checked.

**Route-type generation and the type check that followed it (R-1).** A separate record, made after T-2 on 11 October 2026, with no source or test changed since T-2. Both commands ran once, with the database, application, payment and AI-provider variables removed, framework telemetry disabled, and the no-TCP preload loaded; it recorded no connection attempt in either.

| Step | Command | Result | Capture |
| --- | --- | --- | --- |
| R-1a | `./node_modules/.bin/next typegen` (Next.js 16.4.0) | **Exit status 0.** "Types generated successfully". It wrote the ignored, untracked files under `.next/types/` and rewrote the ignored, untracked `next-env.d.ts`, which now imports `./.next/types/routes.d.ts`. `tsconfig.json`, `tsconfig.tsbuildinfo` and every tracked file were unchanged | `/Users/frankncube/shopaccess-backups/increment-2-3-routes-20261011-215929/typegen.log`, SHA-256 `e6706ab065c38a67e4ff159708458948bcd72a3b332489a67c6131b78286037d`, 733 bytes, 11 lines: the command, all output and the exit status |
| R-1b | `./node_modules/.bin/tsc --noEmit --incremental false --pretty false` (TypeScript 5.9.3) | **Exit status 0, no diagnostics.** `tsconfig.tsbuildinfo` unchanged | `/Users/frankncube/shopaccess-backups/increment-2-3-routes-20261011-215929/typecheck.log`, SHA-256 `1af563a643b8f50bc1b07546bf77326fe3958734bb8fdcdc0a986f8742b1bd58`, 1,336 bytes, 15 lines: the command, all output and the exit status |

- Generated validator: `.next/types/validator.ts`, SHA-256 `882222655a7ff643a7b81beb4de0c1318aabebb82239689bde2edac91ad975a5`; route declarations: `.next/types/routes.d.ts`, SHA-256 `b3c733f1d20153c07ce7c90c6652b68b7076590213aebfeedff1d54dadf4629d`. Both are generated, ignored files and are not part of the repository.
- Coverage, checked before R-1b and recorded in `/Users/frankncube/shopaccess-backups/increment-2-3-routes-20261011-215929/coverage.txt` (SHA-256 `7af17bcaade42002679b2e190ed70861b86e2f42a9873ca4b57510def612cc98`): the validator references thirteen modules, which are exactly the thirteen layout, page and route files under `src/app/`. They include `/session/new`, `/session/rotate`, `/checkout/[intentId]/review`, `/checkout/[intentId]/cancel` and `/checkouts`, with the eight routes and pages that existed before.
- Compiler inclusion: `tsconfig.json` includes `.next/types/**/*.ts`, which is where the validator was written, and `next-env.d.ts`, which imports the new route declarations. The directory generated and the directory compiled are the same. The older `.next/dev/types/` files of 14:05 are also still matched by `tsconfig.json`; they were not touched, cover only the earlier routes, and produced no diagnostic.
- **Established by R-1:** current framework-specific type validation of the route and page modules of Increment 2.3, that is, that each module's exports have the shapes the framework's generated validator requires. **Not established by R-1:** a build, anything at run time, application integration, browser behaviour, or any acceptance. The unit suite was not run as part of R-1.

**The HTTP and application-restart integration driver (written; never run; type-checked in T-4 to T-8 and T-10, after failing T-3 and T-9; helpers unit-tested in U-7 to U-12).** A separate record of 11 October 2026. No database, application, port or request was used in writing or checking it.

| File | Responsibility | State |
| --- | --- | --- |
| `vitest.integration.config.mts` | Selects only `tests/integration/*.integration.test.ts`; apart from the unit and database configurations | Written |
| `tests/integration/app-process.ts` | Helpers against injected dependencies: the input check, the child-environment allowlist, startup (60-second deadline, early exit, cancellation), requests (15-second deadline, abort, settlement of every request, nothing sent twice), shutdown of the process group (SIGTERM, then SIGKILL after five seconds, port and group checked), cleanup that continues after a failure, response reading. The real spawn, signal, socket and log dependencies are in the same file and are called by the driver only | Written |
| `tests/integration/pg-app.integration.test.ts` | The driver: one fixture through the unchanged harness, three application processes in turn on 127.0.0.1:3170 with the origin `http://localhost:3170`, fixed observation statements, full-content table comparison | Written; failed T-3, type-checked in T-4 to T-8; changed for the two interfaces, which failed T-9 and type-check since T-10; **never run** |
| `tests/unit/pg-app-process.test.ts` | 80 database-free controls of the process helpers, the diagnostics and the run evidence, with fakes and fake timers | 38 passed in U-7; 50 in U-8; 54 in U-9; 58 in U-10; 61 in U-11; all 73 passed in U-12; 78 of 79 in U-13, one failed; all 79 passed in U-14; all 80 passed in U-15 |
| `tests/integration/safe-diagnostics.ts` | Pure comparison, scan and failure helpers that cannot print a sensitive value. No database, network, process or file access | Written; type-checked in T-5, T-6 and T-7; unit-tested in U-8, U-9 and U-10 |
| `src/app/layout.tsx` | The two Google fonts are no longer loaded; the two font custom properties that `globals.css` reads are set on the same element to system-font stacks. No other file changed | Written; SHA-256 `413c0a0a124b6064448f67845f2ea3fedc00de87e89ff34d8900b91534fc8d8e` |

- **Ownership.** The driver owns its disposable database fixture, its application child processes, its requests and its application logs. The execution gate's wrapper owns provisioning and verifying the cluster, the pristine catalog records before the driver and after the fixture is destroyed, the PostgreSQL shutdown and the retained cluster. The driver provisions nothing and removes nothing by hand.
- **Inputs.** Without `SHOPACCESS_APP_TEST_AUTHORIZATION` every case is skipped and nothing is opened. With it, `SHOPACCESS_APP_TEST_AUTHORIZED_PORT`, `SHOPACCESS_APP_TEST_EVIDENCE_DIR`, `SHOPACCESS_APP_TEST_SERVER_LOG` and the harness's two variables are all required, and anything missing fails before anything is opened.
- **Cases written (level I only; none has run):** refusal of a request without an Origin on every state-changing route; readiness with the rendered identifiers, titles and prices compared with the database's rows, the absence of the unavailable notice, and the web role's loopback connections; admission, unusable cookies and explicit replacement (A18 in part, A40, A41 in part); owner isolation; start, read and repeated page loads (A15, A16 in part); a matching challenge with a wrong quote id and with a wrong quote digest (A38); cross-checkout, unknown, unacknowledged and malformed submissions (A4, A37, A39 in part); confirmation and sequential replay (A7); replacement, cancellation and a new checkout with no predecessor (A21, A22 in part); the simulation refusal (A34 in part); two overlapping confirmations **not forced into an order**, with the allowed outcome set (A17 in part); restart persistence (A16); the wrong-role refusal with a superuser connection (A24, A25 in part); and the secret scan of response bodies and headers, application logs and the server log (A29 in part, A30).
- **Deferred, and not implied by any future run of this driver:** a forced overlap of two confirmations (it needs request attribution and backend identities that are not available without a production hook); A8; A9; A13; A19; A28; A31 at this level; the migration-role variant of A25 (the unchanged harness offers no login for that role); **A42, schema USAGE, which stays unit evidence only and is not dropped**; `CHECKOUT_NOT_CONFIRMABLE` of A39; and everything at level B: A35, A36, A48, A49, A50, browser acceptance of the Secure `__Host-` cookie, and any announcement by assistive technology. The driver's client is synthetic and runs the application in development mode; it is evidence neither about a browser nor about a production build.
- **Network.** Removing the font import removes that fetch only. The installed development server still contains a version check addressed to `registry.npmjs.org`, and it writes the agent-rules block of `AGENTS.md` when it detects a coding agent in its environment. No enforceable boundary for loopback-only traffic exists yet: the existing no-TCP preload refuses loopback PostgreSQL too, and nothing shows that a Node preload governs the bundler's native networking. This is open for the execution gate.

| Check | Date | Result | Capture |
| --- | --- | --- | --- |
| T-3 | 11 October 2026 | **Failed: exit status 2, one diagnostic.** `TS2345` at `tests/integration/pg-app.integration.test.ts(646,85)`: the two wrong-field variants of the mismatch case, written as an array literal, have a union element type whose absent property is `undefined`, which is not assignable to the helper's `Record<string, string>` parameter. A typing error in the new driver; no production source was named, and no other file produced a diagnostic. Not repaired and not rerun | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-222701/typecheck.log`, SHA-256 `ee2c3f37e0daff8b1d0d1cc050bf1cbf844503988cbf416478e882e787a7dc81`: the command, all output and the exit status |
| T-4 | 11 October 2026 | **Passed: exit status 0, no diagnostics.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the only correction: in the mismatch case the two wrong-field fixtures, unchanged in value and order, are held in a local constant typed `Array<Record<string, string>>` and the loop iterates over it. No cast, no production change. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-223053/typecheck.log`, SHA-256 `c9d68150153470e8b6801eb67514345d12a7fc1c263d5810233c537f11768de9`: the command, all output and the exit status |
| U-7 | 11 October 2026 | **Passed: 1,005 of 1,005 tests in 24 files; exit status 0;** no failure, no skip, no unhandled error, no connection attempt recorded. `./node_modules/.bin/vitest run --config vitest.config.mts tests/unit --reporter=verbose`, once, after T-4, under the no-TCP preload with the integration, database, application, payment and AI-provider variables removed. The inventory is the 967 tests of U-6 and the 38 controls of `tests/unit/pg-app-process.test.ts`, all 38 of which passed | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-223053/unit-run.log`, SHA-256 `1afefc10f008f8bae7859192985428cda1128330418d9d430db8465c7e9516a0`: the command, all output and the exit status |
| T-5 | 11 October 2026 | **Passed: exit status 0, no diagnostics.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the disclosure correction described below. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-230301/typecheck.log`, SHA-256 `1b7d3bbcc5e55b18683dc9e7da2d0aff84e51ff60534bed48bbe95a3258c1589`: the command, all output and the exit status |
| U-8 | 11 October 2026 | **Passed: 1,017 of 1,017 tests in 24 files; exit status 0;** no failure, no skip, no unhandled error, no connection attempt recorded. `./node_modules/.bin/vitest run --config vitest.config.mts tests/unit --reporter=verbose`, once, after T-5, under the no-TCP preload with the integration, database, application, payment and AI-provider variables removed. The inventory is the 967 tests of U-6 and the 50 controls of `tests/unit/pg-app-process.test.ts` (38 of U-7 and 12 added), all 50 of which passed. No sentinel value of the disclosure controls occurs in the captured output | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-230301/unit-run.log`, SHA-256 `d701edc04d1c6285d8ec83376b7eed5af81404dc933d4587ddfb7f4e2336b598`: the command, all output and the exit status |
| T-6 | 11 October 2026 | **Passed: exit status 0, no diagnostics.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the unexpected-error correction described below. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-231937/typecheck.log`, SHA-256 `b1f438a9051c1ea49357a7f0c12697d6c6c89a52cb1aed6189c7443da9d312fa`: the command, all output and the exit status |
| U-9 | 11 October 2026 | **Passed: 1,021 of 1,021 tests in 24 files; exit status 0;** no failure, no skip, no unhandled error, no connection attempt recorded. `./node_modules/.bin/vitest run --config vitest.config.mts tests/unit --reporter=verbose`, once, after T-6, under the no-TCP preload with the integration, database, application, payment and AI-provider variables removed. The inventory is the 967 tests of U-6 and the 54 controls of `tests/unit/pg-app-process.test.ts`, all 54 of which passed. No sentinel value of the disclosure controls occurs in the captured output | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-231937/unit-run.log`, SHA-256 `39d083d5144d28a5a24c906b12b5a44ff5f9d2d4b5aea6d0f25d4087052f0c74`: the command, all output and the exit status |
| T-7 | 11 October 2026 | **Passed: exit status 0, no diagnostics.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the ownership, inspection and allowlist correction described below. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-233604/typecheck.log`, SHA-256 `28af43495ba86e05d84264e9d2fef7bc602cfea3365d07f020440703165e6c8b`: the command, all output and the exit status |
| U-10 | 11 October 2026 | **Passed: 1,025 of 1,025 tests in 24 files; exit status 0;** no failure, no skip, no unhandled error, no connection attempt recorded. `./node_modules/.bin/vitest run --config vitest.config.mts tests/unit --reporter=verbose`, once, after T-7, under the no-TCP preload with the integration, database, application, payment and AI-provider variables removed. The inventory is the 967 tests of U-6 and the 58 controls of `tests/unit/pg-app-process.test.ts`, all 58 of which passed. No sentinel value of the controls occurs in the captured output | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-233604/unit-run.log`, SHA-256 `7c906305bf74b42475da507208cb81ad42bec2c2ed8ddb499be487d503925137`: the command, all output and the exit status |
| T-8 | 11 October 2026 | **Passed: exit status 0, no diagnostics.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the ownership-fallback correction described below. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-234446/typecheck.log`, SHA-256 `b8a19cfe0d84b4fbbcf31adaa698701036e5e4b463b09049178cfac67bf7999e`: the command, all output and the exit status |
| U-11 | 11 October 2026 | **Passed: 1,028 of 1,028 tests in 24 files; exit status 0;** no failure, no skip, no unhandled error, no connection attempt recorded. `./node_modules/.bin/vitest run --config vitest.config.mts tests/unit --reporter=verbose`, once, after T-8, under the no-TCP preload with the integration, database, application, payment and AI-provider variables removed. The inventory is the 967 tests of U-6 and the 61 controls of `tests/unit/pg-app-process.test.ts`, all 61 of which passed. No sentinel value of the controls occurs in the captured output | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-234446/unit-run.log`, SHA-256 `ce4478c266641ec88f03fc418c3309296a9d7cf40182e3409aeb7423f0cc7e36`: the command, all output and the exit status |
| T-9 | 12 October 2026 | **Failed: exit status 2, one diagnostic.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the two driver interfaces described below were written. `TS2352` at `tests/integration/app-process.ts(1088,90)`: in the new `readProcessIdentity`, the environment object given to the process-table command is cast to `NodeJS.ProcessEnv`, which in this project requires `NODE_ENV`; the compiler refuses the direct cast. A typing error in new test-support code; no production source was named, and no other file produced a diagnostic. Not repaired and not rerun. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-010330/typecheck.log`, SHA-256 `469b58677f59589588202c8b40c40502d38f5c0ee482e3cc25633b62bb01e203`: the command, all output and the exit status |
| T-10 | 12 October 2026 | **Passed: exit status 0, no diagnostics.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the only correction: in `readProcessIdentity` the environment of the process-table command is a local `Record<string, string>` holding the same two names, `PATH` and `LC_ALL`, handed over with the single cast the existing spawn code uses for its own environment. No `NODE_ENV` was added, and no double cast, `any` or suppression. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-011656/typecheck.log`, SHA-256 `663e97c8b600f7c2911bdc8aced1d7ced46dfe90ec877490884d9baaea2bd0cc`: the command, all output and the exit status |
| U-12 | 12 October 2026 | **Passed: 1,040 of 1,040 tests in 24 files; exit status 0;** no failure, no skip, no unhandled error, no connection attempt recorded. `./node_modules/.bin/vitest run --config vitest.config.mts tests/unit --reporter=verbose`, once, after T-10, under the no-TCP preload with the integration, database, application, payment and AI-provider variables removed. The inventory is the 967 tests of U-6 and the 73 controls of `tests/unit/pg-app-process.test.ts`, all 73 of which passed, the 12 for the two driver interfaces and the wrapper's qualification rules among them. No sentinel value of the controls occurs in the captured output | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-011656/unit-run.log`, SHA-256 `e4d317a5c9175e9e136dd57f19ddc0fc00f48cf1f5ce0876f2716855517c9efa`: the command, all output and the exit status |
| T-11 | 12 October 2026 | **Passed: exit status 0, no diagnostics.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the corrections to `tests/integration/run-evidence.ts` described below. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-013644/typecheck.log`, SHA-256 `a3d4e51564c47df9e0ee6e9dac595e1ac77ac4e48476cda832e63cf2ddef7625`: the command, all output and the exit status |
| U-13 | 12 October 2026 | **Failed: 1,045 passed, 1 failed, 0 skipped, of 1,046 in 24 files; exit status 1.** `./node_modules/.bin/vitest run --config vitest.config.mts tests/unit --reporter=verbose`, once, after T-11, under the no-TCP preload; no connection attempt recorded. The failure is in `tests/unit/pg-app-process.test.ts`, "the wrapper's own secrets are searched by the same scanner, in the same pass as the driver's sentinels": two expected lines of the new control were written without the status word (`integration-run.log:connection URLx1+passwordx1+session cookiex1`, `server.log:passwordx2`), where the scanner reported `integration-run.log:SCANNED:connection URLx1+passwordx1+session cookiex1` and `server.log:SCANNED:passwordx2`. The categories and counts the scanner found are the ones the control intended; the expectation is wrong, not the scanner. The diagnostic holds categories and counts only. Not repaired and not rerun. The other 78 controls of that file passed, the other new ones among them | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-013644/unit-run.log`, SHA-256 `b363faec5d8e8753132f66e609b137e56fef08156c7cf72081e809e58fd296a3`: the command, all output and the exit status |
| T-12 | 12 October 2026 | **Passed: exit status 0, no diagnostics.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the only correction: in the control that failed in U-13 the two expected lines were given the status word the summary helper emits (`integration-run.log:SCANNED:connection URLx1+passwordx1+session cookiex1`, `server.log:SCANNED:passwordx2`). No scanner code, fixture value, category, count or other assertion changed. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-024312/typecheck.log`, SHA-256 `3fd07184e3a59a4fe6679575f816a7a04cf901ebfc524efb84c80178059018bc`: the command, all output and the exit status |
| U-14 | 12 October 2026 | **Passed: 1,046 of 1,046 tests in 24 files; exit status 0;** no failure, no skip, no unhandled error, no connection attempt recorded. `./node_modules/.bin/vitest run --config vitest.config.mts tests/unit --reporter=verbose`, once, after T-12, under the no-TCP preload with the integration, database, application, payment and AI-provider variables removed. The inventory is the 967 tests of U-6 and the 79 controls of `tests/unit/pg-app-process.test.ts`, all 79 of which passed. No sentinel value of the controls occurs in the captured output | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-024312/unit-run.log`, SHA-256 `b2377687dfc3bc3206ab7a47910e76acb6ab65742cbd2b4cc8648b7aee43ef97`: the command, all output and the exit status |
| T-13 | 12 October 2026 | **Passed: exit status 0, no diagnostics.** `./node_modules/.bin/tsc --noEmit --incremental false --pretty false`, once, after the scanner read-cap correction described below. `tsconfig.tsbuildinfo` unchanged; no connection attempt recorded | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-025236/typecheck.log`, SHA-256 `872c956e7987276fc0e851fc60ea60d5f86a670672ffff46e3dea3e306cabeca`: the command, all output and the exit status |
| U-15 | 12 October 2026 | **Passed: 1,047 of 1,047 tests in 24 files; exit status 0;** no failure, no skip, no unhandled error, no connection attempt recorded. `./node_modules/.bin/vitest run --config vitest.config.mts tests/unit --reporter=verbose`, once, after T-13, under the no-TCP preload with the integration, database, application, payment and AI-provider variables removed. The inventory is the 967 tests of U-6 and the 80 controls of `tests/unit/pg-app-process.test.ts`, all 80 of which passed. No sentinel value of the controls occurs in the captured output | **Complete.** `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-025236/unit-run.log`, SHA-256 `1699aa9f385e0c0a1c9925e1c0148d6f56ff399c16141c765f1f5b8ab08a76c7`: the command, all output and the exit status |

- **The unit run that was to follow T-3 was not performed**, because T-3 failed; T-3 stays a failed record. T-4 and U-7 are separate, later records.
- Sources of T-4 and U-7: `tests/integration/pg-app.integration.test.ts` SHA-256 `ddae177f41d8a1fc408dd346174e15e82544a4295e5752b77f2533e3f2e25b88`; every other file as listed for T-3 below, with `src/app/layout.tsx` as above. U-7 is the first unit run with the type annotation of T-2 and with the changed layout; no unit test renders the layout.
- **The disclosure correction between U-7 and T-5.** As first written, the driver handed sensitive values to the runner's matchers, which print the actual and expected values of a failed comparison: Set-Cookie values, the hidden fields of the confirmation form (CSRF token, nonce, quote digest), database rows that hold an owner identifier, and whole response texts. The driver now calls no matcher at all. It keeps those values in memory, compares them itself, and fails through the new pure module `tests/integration/safe-diagnostics.ts`, whose messages hold a fixed label, counts, booleans, the names of fields, tables, headers and categories, and a value only when it belongs to a small grammar of codes, names, cookie attributes and local paths. Full-content comparisons were kept as full-content comparisons; they report counts. Every case and the setup hook rethrow an unexpected failure without the original error (as first corrected, with the known secrets removed from its message; since T-6, with none of its text at all). Disclosure is prevented where the message is made; nothing relies on scanning or redacting the output afterwards. The cases, their expected outcomes, their permitted database effects and the deferred coverage are unchanged.
- **A29, extended and still partial.** The response scan now covers every response body, every response header other than Set-Cookie, and Set-Cookie apart from them, where the session cookie being set is expected and no other category is. A finding reports the surface, the header's name, the category and the number of matches, never a value. Not covered, and not claimed: the reason phrase of the status line, trailers, and any response the driver did not itself request.
- Sources of T-5 and U-8: `tests/integration/pg-app.integration.test.ts` SHA-256 `f8a0f4d19424a677135000ffa553cd29a50dde15248457c3bac5067b1094e24f`; `tests/integration/safe-diagnostics.ts` (new) `99a6a966f1719f8c2002db8bb3a323821afe698a649ac3c69110006b4744045a`; `tests/unit/pg-app-process.test.ts` `ae45fba972c90ace47ce193538c145a8f5ad630355a20a3775c8fbdaa6bf43f1`; `tests/integration/app-process.ts`, `vitest.integration.config.mts` and `src/app/layout.tsx` unchanged. State before the checks: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-230301/state-before.txt`.
- **What U-8 covers of the correction:** the diagnostics module, with synthetic sentinel values: a failing comparison still fails, keeps its context and prints neither value; matching values pass; a changed row among an unchanged number of rows is detected; a secret in a body, in an ordinary header or in a Set-Cookie header where it does not belong is found and reported without its value; and, read from the source, that the driver calls no matcher and wraps every case. It is not evidence that the driver's own failure paths were exercised: **the driver has still never run.** The correction awaits independent review.
- **The unexpected-error correction between U-8 and T-6.** Two places still forwarded text that an error brings with it. `redactedFailure` appended the error's name, code and message after removing the secrets known at that moment; and `describeError`, used by `runCleanup` and written to `cleanup-result.json`, did the same for each failed cleanup step and for every error inside an aggregate. A secret that had not been registered when the failure happened would have passed through both, and a pattern for the shape of a code or a name is not a list. Both are replaced. An unexpected failure is now reported as a fixed operation label from the caller's source, one category of a closed list (`ASSERTION`, `REQUEST`, `STARTUP`, `CLEANUP`, `DATABASE_TARGET`, `NETWORK`, `FILESYSTEM`, `DATABASE`, `PROGRAMMING`, `AGGREGATE`, `UNKNOWN`), and a code only when the error's own `code` is exactly one of 47 listed strings (the driver's request, startup and cleanup codes, the harness's ten target refusals, five socket codes, nine file codes and ten SQLSTATE values); anything else is `UNKNOWN` with no code. No name, message, stack or cause is read or copied, nothing inside an aggregate is kept but their number, and the result does not depend on any secret having been registered; the known-secret redaction is gone because nothing arbitrary is forwarded. `describeError` no longer exists. `runCleanup` still attempts every step and records each failed step apart, as its fixed name, a success flag, a listed category and code, the number of errors of an aggregate, and numeric or boolean facts; `cleanup-result.json` is written field by field from that shape, and a writer that fails is reported by class in the hook's one visible line. The failure codes of log capture pass through the same list. In the driver, the operation labels are passed as fixed text, the cleanup result is written through the new serializer, and four `throw new Error` statements became coded failures so that their meaning survives the boundary; the cases, their assertions, snapshot semantics, deadlines, process ownership and cleanup order are unchanged.
- Sources of T-6 and U-9: `tests/integration/safe-diagnostics.ts` SHA-256 `c3e8cacbd4b0a4746f2c9ad4e94f3542f2b496152bf7a039aad743d9afa35435`; `tests/integration/app-process.ts` `7193c3fe0a3246c869bd012555778006fc9f9ca3e9471c1d709c66a4afe3f900`; `tests/integration/pg-app.integration.test.ts` `938c0c852814c5f4f76910fde8fe331cc34f0d6f2b4b161fab92b3cc39f9a47e`; `tests/unit/pg-app-process.test.ts` `c1b6e77e7951bdbff22f5ef423e96fc09939b58fe5c56869dcacf762ed064caf`; `vitest.integration.config.mts` and `src/app/layout.tsx` unchanged. State before the checks: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-231937/state-before.txt`.
- **What U-9 covers of this correction:** with synthetic sentinels, an unregistered non-hex secret in a message, a spoofed name and code, a recognized code with a secret-bearing message, unlisted codes, an aggregate holding several secrets, a cause and custom properties, a label that could be a value, the cleanup result as an object and as JSON, cleanup continuing after such failures, and a failing writer of the cleanup result. It remains a test of the helpers: **the driver has still never run**, and this correction too awaits independent review. Integration execution, an enforceable network restriction, the cluster wrapper, detection of unexpected writes to tracked files, the deferred cases and every browser behaviour are as pending as before.
- **The ownership, inspection and allowlist correction between U-9 and T-7**, for three findings of independent review.
  - *Ownership of a process whose startup fails.* The driver used to record an application handle only after startup had succeeded, so a process spawned by a start that then failed, and that survived the one shutdown attempt made at that moment, belonged to nothing. `startApplication` now hands the handle to the caller through `onSpawned`, synchronously, immediately after the spawn and before any startup step is awaited; the driver puts it in the list that final cleanup stops (as of T-7; since T-8 the helper retains the handle itself first, see below). A startup failure keeps its listed startup code and is reported with the state of the shutdown that followed, as booleans; the error carries no handle. `stop()` no longer remembers an unclean result as its answer: a clean stop is final and repeatable without a signal, and after anything else the next call is another bounded attempt (SIGTERM, then SIGKILL after five seconds) on the same process group and on nothing else; a port that stays in use causes no signal. Every attempt is kept on the handle and counted in the cleanup facts. A process that remains after final cleanup is the cleanup failure `PROCESS_REMAINING`: the step fails, `cleanup-result.json` says `complete: false`, and the hook's line counts it. This is a further stop attempt only; nothing is started or sent again.
  - *Inspection of what a cleanup step throws.* `runCleanup` no longer applies `instanceof` to, or reads facts from, a thrown value. A failure the driver raised on purpose is recognized by identity in a private registry, with the facts recorded when it was raised; anything else is classified inside a guard, and an examination that itself throws yields `UNKNOWN` and no facts. A prototype trap, a getter or a forged look-alike cannot throw out of the catch path or stop the later steps, and nothing of such an error is forwarded.
  - *Exact lists for cleanup.* The pattern checks for step names and fact keys are replaced by lists. Step names: `abort and settle outstanding requests`; `stop application 1 and close its log`, likewise `2` and `3`; `destroy the disposable database fixture (harness cleanup)`; any other name is written as `unlisted step`. Boolean facts: `stopped`, `processRemaining`, `portFree`, `processRemainedAfterEarlierAttempt`. Count facts, whole numbers from 0 to 1,000,000: `aborted`, `outstanding`, `signalsSent`, `logFailures`, `problems`, `stopAttempts`, `failedStopAttempts`. A fact under any other key, or of the wrong type or range, is dropped and counted in `droppedFacts`. The serializer rebuilds the result from own, plain data properties only and calls no getter; a step it cannot examine becomes a fixed step with the code `CLEANUP_RESULT_UNREADABLE`, a result it cannot examine at all becomes one fixed text, and either makes `complete` false. The listed codes are now 49, with `PROCESS_REMAINING` and `CLEANUP_RESULT_UNREADABLE` added. The operation labels of the cases are still checked by a pattern guard and not by a list; they are fixed text in the driver's source.
  - The integration cases, their outcome and snapshot assertions, the deadlines and the cleanup order are unchanged.
- Sources of T-7 and U-10: `tests/integration/safe-diagnostics.ts` SHA-256 `9e0ad68b2da06b7db11428abcb82dc527a6ee2de1a8c37d974fd4f7b7c6ac85f`; `tests/integration/app-process.ts` `94d3b9035f2712e735527dab581fa72a77cf9775b5487fceeeb57cd05b77d9ed`; `tests/integration/pg-app.integration.test.ts` `9712c44e59b268df06b13d387bb512d14f2e6829a24cefbbb3b98b47925b4597`; `tests/unit/pg-app-process.test.ts` `e2976cf0414684afbb41f8a022cf76ec1e209bba95ef7330ccc99b6dce7eb3af`; `vitest.integration.config.mts` and `src/app/layout.tsx` unchanged. State before the checks: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-233604/state-before.txt`.
- **What U-10 covers of this correction:** with fakes and synthetic sentinels only, a start that fails with a process that survives its first shutdown, registered before the first readiness attempt; a final cleanup that stops it, and one that does not and is recorded as `PROCESS_REMAINING`, both attempts counted; a thrown proxy whose traps throw and a forged look-alike with a throwing getter, with the later steps still run; and forged or unreadable cleanup results. **The driver has still never run**, no real process was started, and this correction awaits independent review before any integration execution. An enforceable network restriction, the cluster wrapper, detection of unexpected writes to tracked files, the deferred cases and every browser behaviour remain open.
- **The ownership-fallback correction between U-10 and T-8.** After T-7 a spawned application was owned only if the caller's `onSpawned` callback kept its handle: with no callback, or with a callback that threw before keeping it, a process that survived the shutdown attempt of a failed start belonged to nothing, although the startup message said it stayed owned. Retention is now done by `startApplication` itself, in an `ApplicationOwner`: a list that only the helper module can reach, to which the handle is added immediately after the spawn, before the callback is called and before any startup step is awaited. Adding to it runs no code of the caller. An owner is made with `createApplicationOwner`; a start that is given no owner, or something that is not one, retains its handle in a process-wide owner, so a spawned application is always retrievable. The callback remains as bookkeeping for the caller; if it throws, the handle is already retained, the start is abandoned with the listed code `STARTUP_CANCELLED`, one bounded shutdown is attempted, and nothing of what was thrown is kept. The driver creates one owner, and its final cleanup stops every handle of the owner together with its own list, each handle once by identity, through the same bounded stop path as before; a process that remains is still the failure `PROCESS_REMAINING`, with `complete: false`. Handles appear in no error and in no serialized evidence. `tests/integration/safe-diagnostics.ts` is unchanged, so no code was added for a failed callback. The integration cases, their assertions and the deferred coverage are unchanged.
- Sources of T-8 and U-11: `tests/integration/app-process.ts` SHA-256 `8a9f076980f7bae801432dbdcbac3089799c9a1e877457d978d92b191a22d45b`; `tests/integration/pg-app.integration.test.ts` `b8c7cb6b5a16629f45cae35d18f6dbbcc4a8ba6ba1e65af7fd194ce60a449470`; `tests/unit/pg-app-process.test.ts` `71425811d9642890006a34e62b6c1617ffe20993a9d69f98e9962b06563b5981`; `tests/integration/safe-diagnostics.ts` `9e0ad68b2da06b7db11428abcb82dc527a6ee2de1a8c37d974fd4f7b7c6ac85f`, as for T-7. State before the checks: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-234446/state-before.txt`.
- **What U-11 covers of this correction:** with fakes only, a callback that throws before keeping the handle, with a process that survives the first shutdown; cleanup that takes the handle from the owner and stops it, and cleanup in which it survives and is recorded as `PROCESS_REMAINING`; a start with no callback, with no options and with a forged owner, each leaving the handle retrievable; one handle held by the owner and by the caller's list, stopped once; and the absence of the callback's error text from the startup line, the error and the cleanup JSON. **The driver has still never run**, and the next independent review is of this fallback and its controls. An enforceable network restriction, the cluster wrapper, detection of unexpected writes to tracked files, the deferred cases and every browser behaviour remain open.
- **The two driver interfaces written after U-11 (ownership registration and sentinel evidence).** As first written they did not type-check (T-9), and the unit run that was to follow T-9 was not performed; after one typing correction they type-check (T-10) and their 12 controls pass with the rest (U-12).
  - *Ownership registration.* `startApplication` takes a `register` function, called synchronously after the handle has been retained internally and before `onSpawned` and any awaited startup step. The driver's implementation reads the process group and the start time of the new process from the process table (`readProcessIdentity`) and appends one line to the private file `application-ownership.jsonl` in its evidence directory: format `shopaccess-ie1-ownership/1`, the run's ownership identity, an index from 1, the pid, the process-group id and the start identity. If the identity cannot be read or the line cannot be written, the start is abandoned as `REGISTRATION_FAILED`, the process, which is already retained, is stopped by the bounded path, and nothing of the error is kept. The run's ownership identity is a new required input, `SHOPACCESS_APP_TEST_OWNERSHIP_ID` (32 lower-case hex digits, made by the wrapper), which the driver also places in the environment of every application it starts.
  - *Sentinel evidence.* `tests/integration/run-evidence.ts` (new, pure, no local imports) defines `sentinel-evidence.json`, format `shopaccess-ie1-sentinels/1`, encoding `utf-8`: a per-run salt and base, a completeness flag, and for each sensitive value its category (the ten categories of the driver, exactly), its length in UTF-8 bytes, a keyed rolling hash and the SHA-256 of the salt followed by the value's bytes. No value is written. The file is replaced atomically (temporary file, then rename) each time a new value is registered; the driver registers a value before using it: fixture credentials and keys when they are made, the session cookie, CSRF token, confirmation nonce and quote digest of every response as the response is taken in and before any case reads it, and owner ids and digests as they are read from the database. A completeness marker is written before the fixture is destroyed. A reader refuses a record that is missing, unreadable, malformed, of another run or not complete. Scanning finds exact occurrences of the registered byte strings only, within limits on file size, total size and time; an input that cannot be read, is too large or was not reached makes the scan incomplete, never clean. It does not find a transformed form of a value (URL-encoded, escaped, re-encoded, split or truncated) or a value that was never registered.
  - The same file holds the rules the execution wrapper applies, so that they are covered by unit controls rather than only by the wrapper: exclusive creation of the run directory, logging that cannot break cleanup, bounded cleanup steps, the verdict (which requires the result file and the evidence manifest to have been written), and the comparison of worktree listings that includes ignored paths. These have not been run either.
  - Files at T-9: `tests/integration/run-evidence.ts` (new) SHA-256 `ea32a1e5402e3b7ef5606b6785e99aab6e2befbac8fb53151d671b1a30eac656`; `tests/integration/app-process.ts` `524b35fbe1994aaa053633b8caa38dc32f583a18c24c0de0036421e08267361b`; `tests/integration/pg-app.integration.test.ts` `1e1ba980cb253d838286946a7cd773e5e188f16cbfde34c29d30044021e696cf`; `tests/unit/pg-app-process.test.ts` `26c2a34f3aaed22b74c8bc374de3e5725334ae090f33f5e2dc76cf8c1fb4b614`; `tests/integration/safe-diagnostics.ts` unchanged. State before the check: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-010330/state-before.txt`.
  - The integration cases and their assertions are unchanged. **The driver has still never run.** Nothing here establishes that the network boundary is enforced or that the wrapper behaves as written: the wrapper, its profile and its probes exist as unexecuted preparation outside the repository. Network enforcement, the cluster wrapper, the deferred cases and every browser behaviour remain open.
- Sources of T-10 and U-12: `tests/integration/app-process.ts` SHA-256 `9b3cb1b6927fe3ce5513559dbfb8e402209bbce04a5cfa8ae11ce38033d73129`; `tests/integration/run-evidence.ts`, `tests/integration/pg-app.integration.test.ts`, `tests/unit/pg-app-process.test.ts` and `tests/integration/safe-diagnostics.ts` as at T-9. State before the checks: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-011656/state-before.txt`. T-9 stays a failed record.
- **What U-12 covers, and what it does not.** With fakes and in-memory files only, it exercises the registration hook, the ownership and sentinel formats and their strict readers, atomic replacement, the bounded exact-byte scan, exclusive creation of the run directory, logging that cannot break cleanup, bounded steps, the verdict, and the comparison of listings. It started no process, opened no listener and read no real process table. It is not evidence that the network boundary is enforced, that Node loads the evidence helper by removing its types, that a process's identity can be read on this system, or that the wrapper behaves as written; and it does not close the interval between an identity check and a signal, in which a pid can be reused. Independent review of the ownership interface, of sentinel registration, completeness and the scanner, and of the limits of write detection is still outstanding. **The driver has still never run.**
- **Corrections to the shared evidence helper after U-12, for four findings of a package review (T-11 passed; U-13 failed by one wrong expectation in a new control).** Only `tests/integration/run-evidence.ts` and the unit test file changed; the driver, the process helper and every integration case are as at U-12.
  - *Ownership fails closed.* New shared rules: a signal is decided from a process table that was read, a pid that is still the recorded process, and an environment that was read and carries the run's identity; unreadable evidence refuses the signal and is counted, and an exited process is told apart from an unreadable one. A registered process found in another process group than was registered is not adopted. Registration indices must be 1, 2, 3 in order. Ownership evidence qualifies only with process identity verified at the boundary, a readable identity sweep, no unreadable check before a signal, no failed snapshot or record write, a valid registration sequence of the expected length, and no process-group mismatch. A run that started fewer applications is described as that and is not required to have registrations it never made. **The interval between the last check and the signal remains: a pid can be reused in it. These rules do not close it.**
  - *One bounded scanner.* `scanStreams` reads each input a piece at a time and searches as it reads, for the driver's sentinels and the wrapper's own secrets alike (the latter are added under the same salt). Limits on one input and on all inputs are counted in bytes actually read; there is one deadline and a cancellation; a value lying across two pieces is found once; every opened reader is closed. An input that could not be opened or read, passed a limit, changed size while it was read, would not close, or was not reached makes the scan incomplete, and incomplete is never clean. The whole-file scan (`scanInputs`) is removed. The scan still finds exact registered UTF-8 byte strings only.
  - *A created directory with a wrong mode.* `createRunDirectory` returns the path whenever this call created the directory. A wrong mode is corrected once on the new, empty directory; if it still is not 700 the directory is returned as created and not usable. A collision returns no path and is not touched.
  - *Final logging.* `concludeRun` fixes the order: final outcome lines, then the log is flushed and closed and the count of lines not written is final, then the scan, then the evidence outcome, then the result file, then the manifest. A final line that could not be written, or a log that could not be closed, cannot leave a pass. Nothing is logged after the close.
  - Files at T-11 and U-13: `tests/integration/run-evidence.ts` SHA-256 `cefbd3708cff97ef731a3e8a7e123ac4818aaf1980087e11ef2741523d41a85a`; `tests/unit/pg-app-process.test.ts` `519f202f49f22196941d28cfda9440f1e77b430aace69acfdcfa9a72466e74c5` (79 controls); `tests/integration/app-process.ts`, `tests/integration/pg-app.integration.test.ts` and `tests/integration/safe-diagnostics.ts` as at U-12. State before the checks: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-013644/state-before.txt`.
  - At U-13 the unit suite did not pass; after one correction to that control's expectation it passes (U-14). Nothing here is evidence about the execution wrapper, the sandbox profile or the probes, which exist as unexecuted preparation outside the repository; **the driver has still never run.**
- Sources of T-12 and U-14: `tests/unit/pg-app-process.test.ts` SHA-256 `310100c8c63584f3d809758a2c6c6e4789f213466c46a07b42a8ebd008c98e98`; `tests/integration/run-evidence.ts` `cefbd3708cff97ef731a3e8a7e123ac4818aaf1980087e11ef2741523d41a85a`, as at T-11; every other file as at U-12. State before the checks: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-024312/state-before.txt`. U-13 stays a failed record.
- **What U-14 covers, and what it does not.** It exercises the shared rules of the four package corrections with fakes and in-memory inputs only: the signal decision, the registration sequence and ownership qualification; the streaming scan at every piece boundary, its limits, failures, deadline, cancellation and reader closure; the wrapper's secrets through the same scanner; a newly created directory with a wrong mode against a collision; and the final logging order. It ran no wrapper, no probe and no real process. It does not close the interval between an identity check and a signal, in which a pid can be reused; it does not show that the sandbox, the process table or the kernel log behave on this system as the package assumes, or that Node loads the helper by removing its types; and write detection keeps its stated limits. The four corrections in the package itself await independent review. **The driver has still never run.**
- **The scanner read-cap correction between U-14 and T-13.** As corrected for U-13 the scanner counted its limits in bytes read, but it noticed a limit only after the read that passed it: up to one whole piece beyond the limit could be taken from an input. Now the cap of each read is settled before the read is made: the smallest of what is left of the input's limit, what is left of the limit on all inputs, and the piece size (`chunkBytes`, 1 MiB when not given). `ChunkReader.read` takes that maximum and must not take more from the input; a reader that returns more is reported as `READER_OVERRAN_REQUEST`, and what it returned is not searched. When nothing is left, no read is made. Whether an input ended exactly at a limit is not found by reading on: it is complete only if its size before and after both equal the bytes read, and otherwise it is over the limit (larger, grown, or of unknown size), which is an incomplete result. The deadline, cancellation, reader closure, matching across pieces, UTF-8 byte handling and category-and-count output are unchanged, as are the ownership, directory and final-logging rules.
- Sources of T-13 and U-15: `tests/integration/run-evidence.ts` SHA-256 `8978138d6ba4ea6a2a089266f8418e1f6c0e5303cbb56ab4b1692561737afc24`; `tests/unit/pg-app-process.test.ts` `787a503ce9023c51dfe7a606f6edb2244049bd9ca623aabc9bb27b7667584c94` (80 controls: one added, and the earlier overshoot control now requires that exactly the limit is read); every other file as at U-12. State before the checks: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261012-025236/state-before.txt`.
- **What U-15 covers, and what it does not.** With in-memory readers only: that no read is asked for more than is left of either limit or of the piece size; that a file of exactly the limit completes in as many reads as it needs and no more; that larger, growing and size-lying files are read to the limit and not beyond; that at zero budget no read is made; and that matching across pieces and reader closure still hold. It does not run the package's real file reader, which exists as unexecuted preparation outside the repository. The interval between an identity check and a signal, the behaviour of the sandbox, the process table and the kernel log on this system, Node's loading of the helper, and the limits of write detection are as unresolved as before. **The driver has still never run.**
- **What U-7 covers of the driver:** the helpers, against fakes and fake timers. It started no process, opened no port, sent no request and opened no database. **The integration driver itself has never been run**, and U-7 says nothing about any case in it. Still pending: the driver's execution; an enforceable restriction of external network traffic, including the bundler's native networking; every browser behaviour; and owner acceptance.
- Files at T-3: `vitest.integration.config.mts` `58d6c42ba7959004bd8041b82e3a1af94bad5ad6f0e616b341089691a5c69e2c`; `tests/integration/app-process.ts` `1747136e259884bc280735593aa6bb89c6e43e09420b3671f93708c59811ba07`; `tests/integration/pg-app.integration.test.ts` `66b4d5dcbb9ca3270725e564f56e0ab496ec30cd9e1993eeded775dde478968b`; `tests/unit/pg-app-process.test.ts` `4757fb7b6f986ac027f5d92c224ee43c57551f5237c6af88a2b2fec536af6255`. State before the check: `/Users/frankncube/shopaccess-backups/increment-2-3-driver-20261011-222701/state-before.txt`.
- R-1 covered the project as it was before these files. The route and page modules are unchanged apart from `src/app/layout.tsx`, whose only diagnostic-free evidence is T-3 itself.

**What is not established by anything above.** For Increment 2.3: that it builds; that the integration driver runs, or that any of its cases holds; that the network boundary is enforced; that the execution wrapper behaves as written; anything about its routes and pages beyond the type-level validation of R-1; that the readiness probe or the catalog statement is valid SQL; that the application starts, serves a request or survives a restart in PostgreSQL mode; anything a browser or a keyboard would show; and every case of §19.19 at level I or B. A unit test against a fake establishes what the application does with the fake's answers, and nothing about PostgreSQL. Mock mode's unit tests passed in U-4, U-5 and U-6; Mock mode has not been run in a browser with these changes. For Increment 2.2: full PGT-142, whose accepted-confirmation variant has an unexpired quote; the historical PGT-207; PGT-79; and any payment behaviour. For Increments 2.1 and 2.2, B-E2 and C-E2 are execution evidence and an owner decision is still outstanding: **no owner acceptance of Group B, of Increment 2.2 or of Increment 2.3 is recorded in this document.** A failed run is kept as a failed run and is never merged into a later one.

### 19.19 Increment 2.3 contract: opt-in application mode

**Status.** The owner approved the decisions below and authorized this amendment and the source implementation. That authorization covers writing source and database-free tests only. Nothing in this subsection has been run: §19.18 is the only place that says what exists and what has run. Migrations `0001` to `0009`, the bootstrap file, the test harness and `src/lib/pg/client.ts` are not changed by Increment 2.3.

**Scope.** Increment 2.3 connects the existing interface to the entry points of Increments 1, 2.1 and 2.2. It ends at `USER_CONFIRMED`. It adds no dispatch, worker, provider call, capture, refund or payment recovery, and it adds no database object.

**Decision register**

| # | Decision | Status |
| --- | --- | --- |
| D1 | A page load never issues a challenge. Issuance happens only in guarded POSTs: `POST /checkout/start` and "Review again". §5.4 is amended accordingly | APPROVED |
| D2 | `credentialOf` is added to the session service; the token digest still originates only there | APPROVED |
| D3 | When the submitted challenge is the ACTIVE challenge of the checkout in the URL, `consume_challenge` receives the submitted, well-formed quote id and quote digest unchanged, so that the database decides every mismatch and writes its rejection audit row (G2-38 is preserved) | APPROVED |
| D4 | Stale forms and replays that do not name the URL checkout's ACTIVE challenge get an outcome of the application's own, with no consume call: they are neither counted nor audited by the database | APPROVED |
| D5 | No checkout call is re-run by the application, for any reason. This is stricter than the approved maximum of three database-only re-runs (D-8), which the session calls keep | APPROVED |
| D6 | Replacement follows the database's eligibility: only a stored `QUOTED` or `USER_CONFIRMED` checkout is named as a predecessor. A canceled checkout offers a new checkout with no predecessor | APPROVED |
| D7 | The owner's checkouts are listed on a separate page, `/checkouts`, as best-effort recovery | APPROVED |
| D8 | Readiness is request-time and fail-closed, with one runtime and one pool per process and terminal disposal. It is not a refusal to start the process, and there is no end-to-end deadline for connection establishment or pool acquisition | APPROVED |
| D9 | Amount bounds when reading `read_checkout` | RESOLVED from the table constraints of migration `0007`; not an owner choice |
| D10 | A session is admitted without the shopper asking only when the request carries no session cookie at all. Any presented cookie that cannot be used needs the explicit `POST /session/new` | APPROVED |
| D11 | A session is rotated only by `POST /session/rotate`. §18.7 item 6 ("may be rotated") is thereby made explicit and shopper-initiated | APPROVED |
| D12 | The simulated payment lifecycle is hidden and refused in PostgreSQL mode | APPROVED |
| D13 | The catalog is one joined, uncached statement (G2-17); the in-process limits are a first line only and the database's throttle decides (G2-19) | APPROVED |
| D14 | Browser tooling (G2-20) and the set-up of an application database | DEFERRED to a later gate |

**Mode and configuration (G2-16, D8)**

- `SHOPACCESS_PERSISTENCE_MODE` not set at all: the in-memory mock, built by the same code as before, with the same settings and the same token-only cookie. Exactly `postgres`: PostgreSQL mode. Any other value, an empty one included: nothing is served.
- PostgreSQL mode requires, with no default: `SHOPACCESS_DATABASE_URL` (a `postgres:` or `postgresql:` URL with a host and a user), `SHOPACCESS_SESSION_KEYS`, `SHOPACCESS_NONCE_KEYS`, `SHOPACCESS_TRUSTED_ORIGINS`, and `PAYMENT_PROVIDER_MODE=mock`. The mock's single-key setting is not read.
- `src/server/runtime.ts` remains the only reader of the process environment.
- PostgreSQL mode never falls back to the mock: not when configuration is missing, not when the database is unreachable, not for a single page. The mode is read when a request is served, never when a page is built.

**Readiness and the pool (D8)**

- One runtime and one pool for the process. Configuration is parsed on first use; an error is permanent for the process and no pool is created. Concurrent first requests share one construction. The pool is created at most once and is never replaced; creating it opens no connection.
- Before anything is served, one fixed statement of the catalogue is sent and its one row must be exactly: session user and current user both `shopaccess_web`; that role is not a superuser and has none of create-role, create-database, replication and bypass-RLS; it is a member of no role; it may execute each of the ten entry points by exact signature; the two operator functions and the seven internal helpers exist and it may execute none; it may read the three catalog tables and `server_key_versions` and write none of the four; the other twelve tables exist and it holds no privilege on any of them or on a column of them; it has USAGE on both schemas and CREATE on neither; and it has neither CREATE nor TEMPORARY on the database. The probe's text names no object: the lists are bound values.
- Then the key-version rows of both purposes must agree with the configured rings (§18.5): an ACTIVE version exists and is configured, and every configured version the database accepts has the configured key's check value.
- One attempt at a time, shared by the requests that arrive together. A success is trusted for 60 seconds. After a failure no new attempt starts for 5 seconds, and requests in that interval are answered without a statement being sent.
- While not ready: route handlers answer the generic 503, and every page, the start page included, shows a fixed "not available" notice and nothing else. No business data is shown and the fixture catalog is never shown in its place.
- Disposal is terminal. The runtime is marked disposed before anything is awaited; a construction or a probe that completes afterwards publishes nothing; the pool is ended exactly once, through one shared close, however disposal and the cleanup of a failed construction overlap; afterwards every request is "not available".
- **Limitation.** The approved `statement_timeout` bounds server-side SQL execution after the statement starts. The current pool configuration does not establish an end-to-end deadline for connection establishment or pool acquisition. No such deadline is added in Increment 2.3, and no call is raced against a timer and abandoned. Later validation must record this and must not report an end-to-end deadline.
- **Limitation.** The web role cannot read the migration ledger. The application cannot verify the checksums of the applied migrations and does not claim to. It applies no migration, runs no bootstrap file and calls no operator function.

**Request authorization**

- PostgreSQL mode has its own guard. It never reads the mock's cookie format and never calls the mock's session service.
- Order for a state-changing request: the form body and its size limit; trusted origin and Fetch Metadata; the cookie, which must be exactly `version.token` (§18.7); one `authorize_session` call under that version only; the CSRF token bound to that session; the in-process limit. Every authorization failure is the same generic 403. There is no second attempt under another version, another cookie format or the mock.
- The authorized request carries a server-only context: the session, the presented cookie, and the credential (key version and token digest) that the checkout entry points take as their first two values. The credential is obtained from the session service (`credentialOf`) and is never serialised, logged, returned or handed to a component.

**Sessions (D10, D11)**

| Request | Presented cookie | Behaviour |
| --- | --- | --- |
| `GET /session/start` | None | A session is admitted and the `version.token` cookie is set. This is the only admission without an explicit request |
| `GET /session/start` | Present, and malformed, duplicated, in the mock's format, or refused by the database | No admission and no `Set-Cookie`. Redirect to `/?session=ended`, which explains, says that earlier checkouts will not transfer, and offers one button |
| `GET /session/start` | Authorized, under an ACTIVE or a VERIFY_ONLY key | Unchanged. Nothing is rotated on a GET |
| `POST /session/new` | Unusable | Guarded by trusted origin and Fetch Metadata only: there is no session, so there is no CSRF token. A session is admitted, and only then is one `Set-Cookie` sent, which replaces the presented value. On a refusal no cookie is sent. The earlier session is not revoked |
| `POST /session/new` | Authorized | No admission; a valid owner is never replaced |
| `POST /session/rotate` | Authorized | Full guard. Under the ACTIVE key: no database call. Under a VERIFY_ONLY key: `rotate_session`; the session and its owner are unchanged, the cookie and the CSRF token are new, and a form rendered earlier is refused until it is loaded again |

- Whether a cookie is present is decided by counting the cookie pairs of that exact name, apart from parsing: the parser's "no usable credential" is never read as "absent".
- `authorize_session` may record the session's activity on a GET, as Increment 1 defines. That is the only write a GET can cause. No GET creates, changes or ends a checkout, a quote, a challenge or a session credential.

**Routes of PostgreSQL mode**

| Route | Fields read | Success | Notes |
| --- | --- | --- | --- |
| `GET /session/start` | query `use`, `budget` | 303 to `/shop?…&started=1` or `/` | Above |
| `POST /session/new` | none | 303 to `/` | Above |
| `POST /session/rotate` | `csrfToken` | 303 to `/` | Above |
| `POST /checkout/start` | `csrfToken`, `productId`, `variantId`, `quantity`, optional `replaces`, `use`, `budget` | 303 to `/checkout/{id}` | Below. Any price in the form is ignored |
| `GET /checkout/[intentId]` | query `error`, `notice` | The page | `authorize_session` and `read_checkout` only. Another owner's checkout is "not found" |
| `POST /checkout/[intentId]/review` | `csrfToken` | 303 to the page | One request for a challenge |
| `POST /checkout/[intentId]/confirm` | `csrfToken`, `acknowledged`, `confirmationId`, `nonce`, `quoteId`, `quoteDigest` | 303 to the page with `notice=CONFIRMED` | Below |
| `POST /checkout/[intentId]/cancel` | `csrfToken` | 303 to the page with `notice=CANCELED` | One `cancel_checkout` call |
| `GET /checkouts` | query `error`, `notice` | The owner's checkouts, at most 100 | `list_owner_checkouts`. "Not found" in the mock |
| `POST /checkout/[intentId]/simulate` | — | — | Always the generic 404 after the guard (D12) |
| `GET /`, `GET /shop` | as before; `session=ended` on `/` | The database's catalog | One joined statement per render |

Every refusal body is the existing generic public error: a code, a fixed message and a request id. No response, redirect, header or log line carries a digest, an owner id, a key version, a connection detail or a database message; the log names an unexpected row by its field and a database error by its five-character code. Results that are not listed for an entry point are an unexpected row, never passed on.

**Starting a checkout and its first challenge (D1, D5)**

- `start_checkout`, `read_checkout` and `issue_challenge` are three separate calls, each committed by itself. Each is sent once.
- **Known success, then a failure.** Once `start_checkout` has answered `STARTED`, the checkout exists and its id is known. Whatever fails afterwards leads to `/checkout/{id}?error=REVIEW_NOT_READY`, where the page offers "Review again". `start_checkout` is never repeated to recover a challenge.
- **Uncertain start.** If the start call fails without a usable row (a lost connection, a timeout, a lost answer, an unexpected row), whether the checkout was committed is not known. Nothing is sent again. The shopper is sent to `/checkouts` with a notice that says so. The list is best-effort: a checkout found there can be opened; an empty list is not presented as proof that the start failed.
- **Inputs of a request for a challenge:** a challenge id generated by the server; the owner id and the stored quote digest of an authorized `read_checkout` row; the nonce key version the database calls ACTIVE, which is always a configured version; that version's key, lent by the ring and cleared after use. The nonce is derived as §19.16 fixes it, and only its digest is sent.
- `ISSUED`: the returned id, quote digest, key version and nonce digest must be those sent.
- `REUSED`: the nonce is derived again from the returned challenge id and quote digest and the read's owner id, under the returned key version if it is configured, and its digest must equal the returned digest. Otherwise the existing challenge cannot be shown by this process (`REVIEW_NOT_READY`).
- `NONCE_KEY_NOT_ACTIVE`: the key versions are read once more. Only if that reading names a different, configured ACTIVE version is one more call made, with a new id. A reading cannot supply key bytes that are not configured. Never more than two calls; each call the database admits is counted there.
- `REFUSED`, and any failure without a result: no further call.

**Confirmation is bound to the checkout in the URL (D3, D4)**

Malformed fields are refused before any checkout call. The checkout in the URL is then read; a checkout of another owner is "not found". The acknowledgement is required. Then:

- **The submitted challenge id is the ACTIVE challenge the read showed for this checkout:** `consume_challenge` is called with that id and the submitted nonce, quote id and quote digest as they were sent. The database's result is final. `CONFIRMED` must name the checkout in the URL; if it names another, the answer is the generic 500 and nothing is redirected. `CONFIRMATION_SUPERSEDED`, `CONFIRMATION_ALREADY_USED` and `CONFIRMATION_NOT_FOUND` can then follow only from a change between the read and the call, and are shown as the database reported them.
- **Otherwise no consume call is made**, and the answer is one of three outcomes of the application's own, none of which is a result of `consume_challenge`:

| Read shows | Outcome | Text |
| --- | --- | --- |
| Another ACTIVE challenge, or none while stored `QUOTED` | `FORM_OUT_OF_DATE` | "This form could not be processed. Reload to see the current checkout status." |
| No ACTIVE challenge, stored `USER_CONFIRMED` | `ALREADY_CONFIRMED` | "This checkout was shown as confirmed when this form arrived. Reload to see the current checkout status." |
| No ACTIVE challenge, any other stored state | `CHECKOUT_NOT_CONFIRMABLE` | "This checkout was not awaiting confirmation when this form arrived. Reload to see the current checkout status." |

These texts describe what the read showed at that moment. They make no claim about what has or has not happened since, because the read may be stale. `read_checkout` exposes no confirmation pointer, so the application cannot tell whether a replayed form's challenge was the one consumed, and does not say.

**Replacement and starting another (D6)**

| Stored state | Offered |
| --- | --- |
| `QUOTED`, challenge shown | The confirmation form; cancel |
| `QUOTED`, quote live and unchanged, no challenge shown | Review again; cancel |
| `QUOTED`, quote expired or stale | A new quote that replaces this checkout; cancel |
| `USER_CONFIRMED` | Cancel; a new quote that replaces this checkout |
| `CANCELED_LOCAL`, `EXPIRED` | A new checkout for the same item, with no predecessor. The record stays as it is |
| `SUPERSEDED` | A link to the checkout that replaced it |

A canceled or superseded checkout is never sent as a predecessor: the page does not offer it, and the handler refuses it after its own read. The database decides again under its locks; `REPLACEMENT_NOT_ALLOWED` leads back to the predecessor's page.

**Amounts (D9)**

The six amount columns of `read_checkout` are `bigint` and arrive as text. Only text is accepted. `unit_amount_cents`: `^[1-9][0-9]{0,6}$`, 1 to 2,000,000. `subtotal_cents` and `total_cents`: `^[1-9][0-9]{0,7}$`, 1 to 20,000,000. `discount_cents`, `tax_cents`, `shipping_cents`: exactly the text `0`. `quantity`: an integer from 1 to 10. Then: subtotal equals unit times quantity, and total equals subtotal. Order: type and text form, then range, then arithmetic. A row that fails is refused whole: nothing of it is rendered, a page shows "not available", a handler answers the generic 500, no mutating call follows from it, and the log names the field and never the value. Catalog amounts are `integer` columns and are held to 1 to 2,000,000 by the catalog schema.

**Shared modules and the mock.** `src/server/config.ts` gains the mode parser and leaves the mock's parser as it was. `src/server/runtime.ts` chooses the runtime and leaves `createRuntime` as it was. The routes that both modes share call the mock's handler exactly as before. `src/server/views.ts` gains message entries that the mock never produces. The mock's handlers, stores, services, guard and cookie are not edited. One rendering change reaches the mock: the start page is rendered per request, with the same content, so that the mode is read when a request is served.

**Acceptance map.** Level U is a unit test with a fake of the database; I needs the application with a newly created disposable database; B needs a browser. Every U case is written and **not run**. Every I and B case is **pending a separately authorized environment** (D14) and is not established by a unit test. A10 and A27 are withdrawn: A45 and A46 replace A10, and A47 replaces A27.

| ID | Assertion | Level | Unit test file |
| --- | --- | --- | --- |
| A1 | A cookie that is not exactly `version.token`, or names an unusable version, is no session; never another version or format | U | `pg-app-guard` |
| A2 | Guard order; every authorization failure is the same refusal | U | `pg-app-guard` |
| A3 | The request context carries the service's own binding; a look-alike session object has no credential | U | `pg-app-guard` |
| A4 | A submitted challenge that is not the URL checkout's ACTIVE challenge sends no consume call and gets a local outcome | U, I | `pg-app-flow` |
| A5 | A matching challenge reaches `consume_challenge` with the submitted nonce, quote id and digest unchanged | U | `pg-app-flow` |
| A6 | `CONFIRMED` naming another checkout is a 500 and no redirect | U | `pg-app-flow` |
| A7 | A replay after confirmation: `ALREADY_CONFIRMED`; this request sends no consume call | U, I, B | `pg-app-flow` |
| A8 | A change after the read is decided by the database; every `consume_challenge` result has its outcome | U, I | `pg-app-flow` |
| A9 | `STARTED`, then issue fails: that checkout with `REVIEW_NOT_READY`; one start call; Review again recovers | U, I, B | `pg-app-flow` |
| A11 | What start and issue send; the nonce is never a value of a call | U | `pg-app-flow` |
| A12 | `REUSED` is shown only when the derived digest matches | U | `pg-app-flow` |
| A13 | `NONCE_KEY_NOT_ACTIVE`: one new reading, at most one more call, only for a different configured version | U, I | `pg-app-flow` |
| A14 | A refused id, a timeout and a lost connection: exactly one call each; no re-run helper in the checkout path | U | `pg-app-flow`, `pg-app-config` |
| A15 | A page load sends `authorize_session` and `read_checkout` only | U, I | `pg-app-flow`, `pg-app-config` |
| A16 | After a restart with the same keys, and in a second tab, the same challenge and nonce from the read alone | U, I, B | `pg-app-flow` |
| A17 | Two tabs: the first submission confirms; the second gets the already-confirmed outcome | I, B | — |
| A18 | `GET /session/start`: the rows of the sessions table above | U, I | `pg-app-guard` |
| A19 | `POST /session/rotate`: nothing under ACTIVE; under VERIFY_ONLY the same session and owner with a new cookie | U, I | `pg-app-guard` |
| A20 | No GET rotates, admits for a presented cookie, or mutates a checkout | U | `pg-app-guard`, `pg-app-config` |
| A21 | A canceled checkout: "Start another" with no predecessor; the canceled record unchanged | U, I | `pg-app-flow` |
| A22 | Replacement from `QUOTED` (expired and stale included) and `USER_CONFIRMED`; `REPLACEMENT_NOT_ALLOWED` | U, I | `pg-app-flow` |
| A23 | Mode and configuration: unset is the mock; `postgres` with anything missing serves nothing; no mock store in PostgreSQL mode | U | `pg-app-config` |
| A24 | Every failing probe value, and key disagreement, is "not available" | U, I | `pg-app-readiness`, `pg-app-config` |
| A25 | The probe passes for the real web role and fails for the migration role and for a superuser | I | — |
| A26 | The catalog: one statement per render; equals the seeded fixture; an incoherent row set is refused | U, I | `pg-app-readiness`, `pg-app-flow` |
| A28 | Database `RATE_LIMITED` is 429; capacity results have their messages; the in-process limit applies first | U, I | `pg-app-flow` |
| A29 | No response or log line holds a digest, an owner id, a key, a connection detail or a database message | U, I | `pg-app-flow` |
| A30 | Server logs of an integration run hold none of the test secrets | I | — |
| A31 | The application's connection cannot read a checkout table, write the catalog or call an operator function | I | — |
| A32 | Import, statement, environment and reachability boundaries | U | `pg-static`, `pg-app-config` |
| A33 | Mock regression: the existing unit suite passes, apart from the two "not wired in" assertions that A32 replaces | U | The existing suite |
| A34 | The simulation route is 404 and the panel is absent | U, B | `pg-app-flow`, `pg-app-config` |
| A35 | The whole flow is operable by keyboard alone, with alerts and status announced | B | — |
| A36 | Mock mode in a browser behaves as before | B | — |
| A37 | Two checkouts of one owner: B's form posted to A's URL consumes nothing and changes neither | U, I | `pg-app-flow` |
| A38 | A matching challenge with wrong well-formed quote fields: the database's `CONFIRMATION_MISMATCH`, one counted call, one `CONFIRMATION_REJECTED` row | I (U asserts the values sent) | `pg-app-flow` |
| A39 | Each local outcome: no consume call; checkout, window and audit rows unchanged apart from the session's activity | U (no call), I (snapshot) | `pg-app-flow` |
| A40 | `GET /session/start` with no cookie admits once; with a malformed, duplicated or mock-format cookie it admits nothing | U, I | `pg-app-guard` |
| A41 | `POST /session/new`: replaces only on admission; never a valid session; the old form is refused afterwards; the earlier owner's checkouts do not transfer | U, I | `pg-app-guard` |
| A42 | USAGE missing on either schema is "not ready" | U, I | `pg-app-readiness` |
| A43 | Twenty concurrent first requests: one pool, one probe, one result | U | `pg-app-readiness` |
| A44 | After a failed probe: no statement for 5 seconds, then one attempt; the pool is never replaced | U | `pg-app-readiness` |
| A45 | A start whose answer is lost after the commit: one call; the committed checkout is in the list | U | `pg-app-flow` |
| A46 | A start whose outcome is unknown and whose checkout does not exist: the notice and an empty list; the text does not say it failed | U | `pg-app-flow` |
| A47 | Amount decoding by field: valid boundaries, each range failure, each zero-only field, malformed text and driver types, quantity, arithmetic; a refused row leads nowhere | U | `pg-app-flow` |
| A48 | A tab left open across a rotation is refused until reloaded; the owner's checkouts are retained | B | — |
| A49 | B's form submitted to A's URL shows the out-of-date text; this request consumes nothing and changes neither checkout | B (no-call part: A37) | — |
| A50 | The session-ended notice, its warning, and the explicit new session by keyboard; an old page's form is refused afterwards | B | — |
| A51 | Disposal while construction is pending: at most one pool, ended once, never ready | U | `pg-app-readiness` |
| A52 | Disposal while a probe is pending: no readiness published; the pool ended once | U | `pg-app-readiness` |
| A53 | Cleanup of a failed construction overlapping two disposals: one end in all | U | `pg-app-readiness` |

- No integration fault injector exists and none is proposed: the commit-then-fail and fail-without-commit cases (A45, A46) are unit cases only.
- The integration cases need a way to apply the bootstrap file and the migrations to an application database. No command provides one today; it belongs to the later gate (D14).

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

*End of PostgreSQL Specification v2.0 — DRAFT. Increment 1 formally accepted by the project owner. Increment 2 Gate A closed as a design-only milestone. Increment 2.1 exact-schema DESIGN contract conditionally approved (§19), subject to later PostgreSQL 17 execution evidence. NOT APPROVED: migration SQL, implementation, PostgreSQL execution for Increment 2, and every later increment.*
