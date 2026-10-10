# Milestone 002 — Increment 1 implementation report (Gate B-W and Gate B-X)

**Current status (section 11): written under Gate B-W, then executed under Gate
B-X on a disposable PostgreSQL 17.11 cluster. Second run, 9 October 2026: seven
database test files, 41 passed, 0 failed, 0 skipped. Final independent audit:
CONDITIONAL PASS, no functional blocker. Not formally accepted by the owner.
Not wired into the application.**

Sections 1 to 10 are the record of the writing and correction stages. Each was
written before any database execution, and each says so ("never executed",
"NOT RUN", "Gate B-X not authorized"). Those statements were true when written
and are kept unchanged. Section 11 is the only section that describes execution.

**Status when sections 1 to 7 were written: written and statically checked.
Never executed against a database.**

**Independent audit verdict: FAIL.** Codex's audit of the implementation described
in sections 1 to 7 found three high-severity defects, four medium-severity
findings, one low-severity finding and a missing production statement catalogue.
The owner authorized targeted corrections. They are recorded in **section 8**,
which supersedes sections 1 to 7 wherever the two differ. Sections 1 to 7 are
kept as the record of the first implementation.

**Re-audit verdict: CONDITIONAL PASS.** The second audit left five items and one
residual risk. The final hardening pass is recorded in **section 9**, which
supersedes section 8 where the two differ. A further independent review is
required before Gate B-X is considered.

**Third audit verdict: CONDITIONAL PASS**, with no high-severity source defect
and two medium-severity issues. Their correction is recorded in **section 10**,
which supersedes section 9 where the two differ.

*As at the writing of sections 1 to 7 (superseded by section 11):*
Gate B-W (write) was authorized and is complete. Gate B-X (execute) is not
authorized: PostgreSQL was not installed or started, no SQL was executed, no
migration was applied, no database connection was made and no database
integration test was run. Nothing was committed, staged, pushed or deployed.

The design this implements is `postgresql-specification-v2.0-draft.md`, section
18. This report records what exists, what was checked, and what is not known.

## 1. What was verified, and what was not

*First implementation. Current figures are in section 8.4.*

| Check | Result |
| --- | --- |
| TypeScript type check (`tsc --noEmit`) | Pass |
| Lint (`eslint`) | Pass |
| Database-free unit tests (`npm test`) | 14 files; 343 passed; 1 skipped (MIG-01, which needs a database and targets only the archived drafts) |
| The 234 tests that existed before Gate B-W | All still pass. One line of one existing test file changed (section 4) |
| New database-free tests | 109, in three files |
| Archived drafts identical to the originals | Yes: SHA-256 recorded before the move, compared after it, and re-checked by a unit test |
| **SQL parsed or executed by PostgreSQL** | **No. Not once.** |
| **Database integration tests (`tests/db`)** | **Written, never run** |

The SQL in `db/bootstrap` and `db/migrations` has been read by a person and
checked by pattern-matching tests only. Syntax errors, privilege mistakes and
wrong behaviour in the functions are all possible and can only be found by
execution under Gate B-X. No claim is made that any database behaviour works.

## 2. Files created

### Database

| Path | Purpose |
| --- | --- |
| `db/bootstrap/0000_roles_and_schemas.sql` | Five roles without login or credentials; schemas `shopaccess` and `shopaccess_api`; PUBLIC revokes; default privileges. Run once by a database administrator; never read by the migration runner |
| `db/migrations/0001_migration_ledger.sql` | `schema_migrations`; shared reject-change trigger function |
| `db/migrations/0002_keys_owners_sessions.sql` | `session_admission_guard` and its one row; `server_key_versions`; `checkout_owners`; `shopper_sessions`; triggers, checks, indexes |
| `db/migrations/0003_merchant_catalog.sql` | `merchants`, `merchant_products`, `merchant_variants`, as the archived draft |
| `db/migrations/0004_merchant_catalog_seed.sql` | Seed rows equal to the code fixture |
| `db/migrations/0005_audit_events.sql` | `audit_events`, append-only |
| `db/migrations/0006_session_and_key_functions.sql` | One internal helper, six entry points, function-owner table privileges, EXECUTE grants, hand-over to `shopaccess_definer` |
| `db/migrations/archive/milestone-001-unexecuted/README.md` | Explains the archive and records the six checksums |

### Library (`src/lib/pg/`, imported by nothing in the application)

| Path | Purpose |
| --- | --- |
| `client.ts` | Query interface; approved timeouts; pool factory; database-only re-runs (at most 3, deadlock and lock timeout only); statement interfaces |
| `key-ring.ts` | Strict ring parsing; check value; ring-against-database reconciliation; redaction |
| `session-cookie.ts` | Strict `version.token` parse and serialize |
| `session-service.ts` | PostgreSQL session service over the four session functions |
| `migrate.ts` | Migration discovery, planning and application; never enters `archive` |

### Tests and configuration

| Path | Purpose | Run? |
| --- | --- | --- |
| `tests/unit/pg-key-ring.test.ts` | PGT-86 parsing and reconciliation cases; check value; redaction | Yes |
| `tests/unit/pg-session-cookie.test.ts` | PGT-85; re-run rules; session service against a fake database | Yes |
| `tests/unit/pg-static.test.ts` | Archive checksums; runner discovery; static migration structure; privileges by text; approved constants; seed equality; library isolation; disposability rule | Yes |
| `vitest.db.config.mts` | Separate configuration for database tests | No |
| `tests/db/harness.ts` | Disposable-cluster verification; database, roles, bootstrap, migrations; fixtures and lock barriers; provisional statement catalogue | No |
| `tests/db/migrations.test.ts` | Inventory; PGT-50; PGT-51 | No |
| `tests/db/privileges.test.ts` | PGT-69a, 69b, 88; V-24 | No |
| `tests/db/sessions.test.ts` | PGT-01, 02, 03, 05, 06, 07, 49, 54e, 54f, 56, 87; expiry cases of 69d | No |
| `tests/db/keys.test.ts` | PGT-64, 86, 89 | No |
| `tests/db/catalog.test.ts` | PGT-84 | No |
| `tests/db/clock.test.ts` | PGT-90 | No |

### Documentation

| Path | Purpose |
| --- | --- |
| `docs/postgresql/increment-1-implementation-report.md` | This report |

## 3. Files archived

Moved, with names and bytes unchanged, from `db/migrations/` to
`db/migrations/archive/milestone-001-unexecuted/`:

| File | SHA-256 (before and after) |
| --- | --- |
| `0001_shopper_sessions.sql` | `b0eb2f4aa2da4f58d7b56f7a9123061728954f599a4df91293400ac7ae13a147` |
| `0002_merchant_catalog.sql` | `7778686f22e65e954f15082294786ebfa85fb3fbc4047aee83e4be2d126a05cb` |
| `0003_carts.sql` | `a7b925843395a638e1769205ef2ec2c5e28e9525d4d6eed90ae0862756458d56` |
| `0004_checkout_quotes_confirmations.sql` | `c84178960064d9b476b24e803e3d682209456737e9c67142f18da0822fbc2a08` |
| `0005_payment_operations.sql` | `bfcd219c909df07ee972b8bf176e34350f5b7a4841ca23c633f485ac234be33a` |
| `0006_audit_events.sql` | `a256d8e84dba37ef91ce00797842406dd50b288410cc10e0ab4d216005b9bf67` |

The runner cannot reach them: it lists only regular files directly inside the
directory it is given, does not recurse, and refuses any directory whose path
contains an `archive` segment. `tests/unit/pg-static.test.ts` checks all three
properties and the checksums.

## 4. Files modified

| Path | Change |
| --- | --- |
| `tests/unit/environment.test.ts` | One line: the migrations-directory constant (line 22) now names the archive folder. The static migration checks and MIG-01 therefore keep targeting the legacy drafts; SQL-01 is untouched |
| `docs/postgresql/postgresql-specification-v2.0-draft.md` | Header status; section 14 (numbering and archive); section 17.1 (D-3, D-21); 17.6; 17.7; 18.1; 18.5; 18.9; 18.10; new 18.11; Appendix A |
| `docs/postgresql/correction-report-013.md` | New entry, section 16 |

One build artefact also changed: `tsconfig.tsbuildinfo`, rewritten by the type
check. It is ignored by git (`.gitignore`, `*.tsbuildinfo`).

No other existing file was changed. In particular: nothing under
`src/lib/session`, `src/lib/db`, `src/server`, `src/app` or `src/components`;
not `package.json`, `package-lock.json`, `README.md`, `vitest.config.mts`,
`tsconfig.json` or `eslint.config.mjs`. No dependency was added.

## 5. Unresolved issues

1. **Nothing has been executed.** See section 1.

2. **Where the statement catalogue lives.** *Closed: see section 8, correction 9.* Milestone 001's SQL-01 test fails
   if any module under `src`, other than the legacy `src/lib/db/queries.ts`,
   contains SQL text. That test could be changed only in its path line. The
   library therefore holds no SQL: `client.ts` declares two interfaces, and the
   parameterized statements are supplied by the caller. For the tests they are
   defined in `tests/db/harness.ts`, marked provisional. Production has no
   statement catalogue yet. An owner decision is needed before Increment 2:
   a second reviewed SQL module under `src` with a one-line allowance in
   SQL-01; statement files under `db/`; or another arrangement. The rule was
   not evaded by reformatting statements.

3. **Operator check-value tool.** An operator must compute a check value from a
   key before activating it. `computeKeyCheckValue` exists in the library, but
   no command-line tool was written: it was not in the manifest, and it handles
   key material. Needed before a person can activate a key outside tests.

4. **Orphan owners.** `admit_session` creates an owner with every session.
   When the session is cleaned up the owner row stays. No owner deletion is
   approved or implemented, so the table grows with admissions.

5. **Budget on collision.** An admission refused for an identifier or digest
   collision has already consumed admission budget. The specification is silent
   on this case; it is the conservative reading.

6. **Refused operator requests are not audited.** Only the two approved success
   event types are written (specification 18.6).

7. **Bootstrap assumes a dedicated database.** It revokes all PUBLIC privileges
   on the database it runs in and on that database's `public` schema, and
   creates roles without login rights. Enabling logins and setting credentials
   is an administrator step outside the repository.

8. **Service differences from Mock.** *Changed: see section 8, correction 8.* The PostgreSQL service's `rotate` takes
   the already-resolved session as well as the cookie, because `rotate_session`
   does not return a session id; `revoke` takes the cookie. These are stated in
   the module and will matter when Increment 2 wires it in.

9. **Database test depth.** *PGT-04 and PGT-54a now have tests: see section 8, correction 6.* The integration tests cover the planned identifiers
   listed in section 2, but they were written blind. Expect to correct both
   tests and SQL at Gate B-X. PGT-04 (two processes admitting) and PGT-54a
   (touch waiting past expiry) have no dedicated test yet; PGT-54f and PGT-07
   exercise the same locking paths.

## 6. Gate B-X execution plan (not authorized)

*The acceptance rule in the paragraph after the list is superseded by section 8, correction 3: a pre-existing role or database of any name is now a refusal.*

1. Install PostgreSQL 17 locally, or obtain a PostgreSQL 17 container image.
2. Initialize a new, empty cluster in its own data directory, listening on
   loopback only, on a non-default port, started with
   `cluster_name=shopaccess-disposable-test`.
3. For the test command only, set `SHOPACCESS_PG_TEST_ADMIN_URL` to that
   cluster's superuser and its `postgres` database.
4. Run the database tests with `vitest.db.config.mts`. For each test file the
   harness verifies the cluster, creates its own `shopaccess_disposable_…`
   database, runs the bootstrap file as administrator, applies `0001` to `0006`
   as the migration role, runs the tests, and drops that database.
5. Correct what execution reveals, under whatever write authorization then
   applies, and repeat until every planned test passes.
6. Stop the cluster and delete its data directory.

The harness refuses a server unless every one of these holds: loopback host;
admin URL naming the `postgres` database; `cluster_name` exactly
`shopaccess-disposable-test`; PostgreSQL 17; superuser connection; no database
other than the built-in ones and the harness's own; no role other than the
connecting superuser, predefined roles, the five ShopAccess roles and test
logins. Loopback alone is never enough.

MIG-01 stays skipped: it reads a different variable
(`SHOPACCESS_TEST_DATABASE_URL`) and would apply only the archived drafts,
which is not authorized.

## 7. Safety statement

- Mock mode, its cookie format, its single key and its behaviour are unchanged.
- The PostgreSQL library is not wired into the running application.
- The legacy query module is untouched and unused by the new code.
- No PayPal, external AI or Channel3 integration. No payment retry or capture
  resend exists in Increment 1; it contains no payment code at all.
- No secret was generated or stored. Test keys are fixed bytes in test files.
- No commit, stage, stash, reset, clean, push or deployment.

## 8. Targeted corrections after the independent audit (Gate B-W)

**Nothing in this section was executed against a database.** No PostgreSQL was
installed or started, no connection was opened, no SQL was executed, no
migration was applied and no database integration test was run. "Closed by
static review" means the defect is removed in the source and, where a database
is not needed to show it, covered by database-free tests. It is not a claim
that PostgreSQL behaves as intended.

The audit report was not available to the implementer. The nine corrections
follow the owner's authorization, and each finding was first reproduced by
reading the source. The authorization gives the severity of the first three
only.

### 8.1 Closure matrix

| # | Severity | Root cause | Corrective change | Tests | What still depends on execution | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Capacity race | High | `admit_session` deleted dead sessions with `SKIP LOCKED`, then counted only rows that looked live. A locked, near-expired row was neither deleted nor counted, and its pending touch then made it live | Count every remaining row. Lock order written into `0006` | `pg-static` (structure of the function). Never run: two capacity/touch tests | Whether the SQL parses and behaves as designed under real locking | CLOSED BY STATIC REVIEW |
| 2 Transaction affinity | High | `applyMigrations` accepted any object with `query()`; a pool satisfies that and may use a different connection per call | `withPinnedConnection` and a nominal `PinnedConnection`; the runner takes a connection source; release in `finally`; destroy after failure | `pg-migrate`: one connection per run, release once, failure and rollback-failure cases, query-only objects refused | Real transaction and advisory-lock behaviour | CLOSED BY STATIC REVIEW |
| 3 Role safety | High | Harness accepted roles and databases matching its own names, and set a password on `shopaccess_web` unchecked | Pristine cluster required; attributes and memberships verified after bootstrap and after login creation; credentials only on roles this run created | `pg-harness`: superusers, elevated attributes, privileged memberships, name collisions, wrong cluster identity | The catalog queries that gather the facts; real cleanup | CLOSED BY STATIC REVIEW |
| 4 Discovery | Not stated | `resolve()` without realpath; line-pattern transaction-control check | Realpath; `db/migrations` only; six-file inventory pinned by SHA-256; strict entries; statement-level scan | `pg-migrate`: archive paths, symlink aliases, unexpected files, duplicate and missing versions, 16 evasion forms, checksum changes | None | CLOSED BY STATIC REVIEW |
| 5 Harness cleanup | Not stated | Setup steps after `CREATE DATABASE` were not guarded; the web login outlived the run | Resources recorded when created; cleanup on every failure; original error rethrown | `pg-harness`: failure at each step, failed verification, failing cleanup | Real `DROP DATABASE` and `DROP ROLE` | CLOSED BY STATIC REVIEW |
| 6 Missing tests | Not stated | Not written | PGT-04 with two operating-system processes; PGT-54a; capacity/touch race | The tests themselves | Everything: none has run | PARTIALLY CLOSED |
| 7 Key ring | Not stated | Ring stored the caller's buffers and returned its own; cross-purpose check was optional | Private copies in and out; validated constructor; `loadKeyRings`; the service accepts only the validated pair | `pg-key-ring`: mutation of supplied, returned and lent buffers; cross-purpose reuse | None | CLOSED BY STATIC REVIEW |
| 8 Rotation identity | Not stated | The result used `session.id` from the caller's object; `rotate_session` returned no ID | Service binds each session object to its credential; mismatches refused before the database; `rotate_session` returns `session_id` | `pg-session-cookie`: A with B's cookie, forged and foreign objects, replay, database ID used. Never run: one database test | The changed function | CLOSED BY STATIC REVIEW |
| 9 Statement catalogue | — | SQL-01 forbade SQL under `src`, so statements lived in the test harness | `src/lib/pg/statements.ts`; SQL-01 skips exactly that file | `pg-static`: literals only, placeholders, schema names, columns match `0006`, no second copy | Whether each statement is accepted by PostgreSQL | CLOSED BY STATIC REVIEW |

### 8.2 Design notes a reviewer should check

- **Capacity.** Admissions are serial under the guard row, and only admission
  inserts or deletes session rows, so the row count seen by an admission is
  exact. Counting all rows is conservative: a dead session held by another
  transaction keeps its slot until that transaction ends. Nothing waits for a
  session row, so no new deadlock or lock-timeout path was introduced.
- **Inventory pin.** `APPROVED_MIGRATIONS` in `src/lib/pg/migrate.ts` holds the
  SHA-256 of each file. Any edit to a migration, including the fixes Gate B-X
  will need, must update that entry in the same change, or discovery refuses
  with `CHECKSUM_NOT_APPROVED`.
- **`rotate_session` contract.** One return column was added (`session_id`).
  Specification 18.3 is updated.
- **Session service signature.** It now takes `rings` (from `loadKeyRings`)
  instead of `ring` and `statements`. `rotate(session, cookie)` keeps its
  shape; the session must be one the service returned.
- **Strict directory.** Any unexpected entry in `db/migrations`, including a
  `.DS_Store` file, makes discovery fail with `UNEXPECTED_ENTRY`.
- **Web login in tests.** The harness still enables login on `shopaccess_web`
  itself, so tests run as the real runtime role. It does so only after creating
  and verifying that role in the same run, and drops the role afterwards.

### 8.3 Files

Created:

- `src/lib/pg/statements.ts`
- `tests/unit/pg-migrate.test.ts`
- `tests/unit/pg-harness.test.ts`
- `tests/db/admission-processes.test.ts`

Modified:

- `db/migrations/0006_session_and_key_functions.sql`
- `src/lib/pg/client.ts`, `key-ring.ts`, `session-service.ts`, `migrate.ts`
- `tests/db/harness.ts`, `sessions.test.ts`, `migrations.test.ts`,
  `keys.test.ts`, `clock.test.ts`, `privileges.test.ts`
- `tests/unit/pg-key-ring.test.ts`, `pg-session-cookie.test.ts`,
  `pg-static.test.ts`
- `tests/unit/environment.test.ts`: the SQL-01 skip condition only
- The three files in `docs/postgresql/`

Not changed: the six archived drafts and their README (checksums compared
before and after); `db/bootstrap/0000_roles_and_schemas.sql`; migrations `0001`
to `0005`; `src/lib/pg/session-cookie.ts`; `tests/db/catalog.test.ts`;
`src/lib/db/queries.ts`; everything under `src/lib/session`, `src/server`,
`src/app` and `src/components`; `package.json`; both vitest configurations.
`tsconfig.tsbuildinfo`, a git-ignored build file, was rewritten by the type check.

### 8.4 Verification

| Check | Result |
| --- | --- |
| Type check | Pass |
| Lint | Pass |
| Database-free unit tests | 16 files; 425 passed; 1 skipped (MIG-01) |
| The 234 tests that predate Increment 1 | All pass |
| PostgreSQL-specific unit tests | 191: `pg-key-ring` 41, `pg-session-cookie` 42, `pg-static` 22, `pg-migrate` 46, `pg-harness` 40 |
| Archived drafts | Checksums identical before and after |
| **Database integration tests (`tests/db`, seven files)** | **NOT RUN** |
| **SQL parsed or executed by PostgreSQL** | **No** |

### 8.5 Remaining limitations

1. Nothing has been executed. Expect syntax and behaviour errors at Gate B-X,
   in the SQL and in the database tests.
2. *Corrected: see section 9, correction 1.* The bootstrap file creates roles only when absent and does not check an
   existing role's attributes. The harness no longer depends on this. An
   administrator running it in a cluster that already holds such roles is not
   protected. No finding covered it, so it was not changed.
3. A harness run that is killed leaves its database and roles behind. The next
   run refuses the cluster, which must then be deleted and re-created.
4. The concurrency tests depend on steps completing within a few seconds of a
   fixture's expiry. Each asserts its precondition and fails if the machine was
   too slow, rather than passing without testing the interleaving.
5. Items 3 to 7 of section 5 still apply: no operator check-value tool, orphan
   owner rows, budget consumed on collision, unaudited operator refusals, and a
   bootstrap that assumes a dedicated database.

### 8.6 Gate B-X readiness (not authorized)

Blockers: Gate B-X authorization itself. A second independent audit of these
corrections is recommended first, because three were high severity and the
capacity rule and harness were redesigned rather than patched.

Setup, changed from section 6:

1. A **freshly initialized** PostgreSQL 17 cluster in its own data directory,
   loopback only, non-default port, started with
   `cluster_name=shopaccess-disposable-test`, containing nothing else.
2. `SHOPACCESS_PG_TEST_ADMIN_URL` naming that cluster's **bootstrap superuser**
   and its `postgres` database, set for the test command only.
3. Run the seven database test files with `vitest.db.config.mts`. Each file
   provisions and removes its own database and roles.
4. Expect to edit SQL and tests, which needs write authorization as well, and
   to update the inventory checksum with every migration edit.
5. Stop the cluster and delete its data directory.

Expected tests: migrations and ledger (PGT-50, 51); privileges (PGT-69a, 69b,
88, V-24); sessions (PGT-01 to 03, 05 to 07, 49, 54a, 54e, 54f, 56, 87, the
capacity/touch race, rotation identity); two-process admission (PGT-04); keys
(PGT-64, 86, 89); catalog (PGT-84); clock (PGT-90). MIG-01 stays skipped.

## 9. Final hardening after the re-audit (Gate B-W)

**Nothing in this section was executed against a database.** The re-audit
document was not available to the implementer; the items follow the owner's
authorization.

### 9.1 Closure matrix

| # | Root cause | Corrective change | Tests | What still depends on execution | Status |
| --- | --- | --- | --- | --- | --- |
| 1 Bootstrap role safety | Roles were created only if absent, so an existing role of the same name was adopted with whatever it could do | One transaction; first statement refuses existing roles or schemas; unconditional creation; attribute and membership check before commit | `pg-static`: order, transaction, no conditional creation, verification content | Whether the three blocks parse and behave | CLOSED BY STATIC REVIEW |
| 2 Concurrent harness runs | The pristine check and provisioning were not atomic across processes | Session advisory lock on a dedicated `postgres` connection, taken first without waiting, confirmed before every change and drop, released last | `pg-harness`: order, refusal of a second run, simultaneous start, loss at each of seven points, loss during tests and during cleanup, release failure | The lock statements and real contention | CLOSED BY STATIC REVIEW |
| 3 SQL-01 multiline | The pattern could not cross a line break | Pattern spans lines up to the source's next semicolon; allowlist of two exact paths | SQL-01: seven multiline forms, non-SQL code, ten refused look-alike paths | None | CLOSED |
| 4 Ring purpose | `readonly` is enforced by the compiler only | Private field with getter; frozen instances, prototypes and classes; subclasses refused; validation reads the private field | `pg-key-ring`: assignment, redefinition, prototype change, proxies, subclasses, impostors | None | CLOSED |
| 5 Malformed client | The refusal threw before releasing | Release with the destroy flag, then refuse | `pg-migrate`: four malformed shapes, throwing release, nothing to release | None | CLOSED |
| Residual: lost `CREATE DATABASE` acknowledgment | The server created the database; the client never learned it | None by design: the database is not recorded, not dropped and not guessed at | `pg-harness` | — | REVIEWED, ACCEPTED LIMITATION |

### 9.2 Files

Modified: `db/bootstrap/0000_roles_and_schemas.sql`; `tests/db/harness.ts`;
`src/lib/pg/key-ring.ts`; `src/lib/pg/client.ts`;
`tests/unit/environment.test.ts` (SQL-01 group only);
`tests/unit/pg-static.test.ts`, `pg-key-ring.test.ts`, `pg-migrate.test.ts`,
`pg-harness.test.ts`; the three files in `docs/postgresql/`. Created: none.

Not changed (checksums compared before and after): migrations `0001` to `0006`;
`src/lib/pg/migrate.ts` and its approved inventory; `statements.ts`;
`session-service.ts`; `session-cookie.ts`; the six archived drafts and their
README. Also untouched: the legacy query module, all Mock and application code,
`package.json`, both vitest configurations, every database test file other than
the harness.

### 9.3 Verification

| Check | Result |
| --- | --- |
| Type check | Pass |
| Lint | Pass |
| Database-free unit tests | 16 files; 447 passed; 1 skipped (MIG-01) |
| PostgreSQL-specific unit tests | 211: `pg-harness` 56, `pg-key-ring` 43, `pg-migrate` 47, `pg-session-cookie` 42, `pg-static` 23 |
| Other unit tests | 236: the 234 that predate Increment 1, plus two new SQL-01 tests |
| **Database integration tests (`tests/db`, seven files)** | **NOT RUN** |
| **SQL parsed or executed by PostgreSQL** | **No** |

### 9.4 Remaining limitations

1. Nothing has been executed, including the new bootstrap blocks and the
   advisory-lock statements.
2. The bootstrap now succeeds once per cluster. A second ShopAccess database in
   the same cluster is refused.
3. Exclusive control coordinates harness runs with each other only. Between a
   confirmation and the next statement there is a short unprotected interval;
   a competing run would then meet a cluster that is not pristine and refuse.
4. Lost control, a killed run or a lost `CREATE DATABASE` acknowledgment leave
   resources behind. The cluster must then be newly initialized.
5. SQL-01 matches upper-case keywords only, as before.
6. Section 8.5 items 1 and 3 to 5 still apply.

### 9.5 Gate B-X readiness (not authorized)

Not ready until a further independent review of this pass. Setup is as section
8.6, with one addition: only one test command may use the cluster at a time; a
second is refused by the lock.

## 10. Two-issue closure after the third audit (Gate B-W)

**Nothing in this section was executed against a database.** The audit document
was not available to the implementer; the two items follow the owner's
authorization, including the owner's choice to move every applicable
cluster-level statement onto the lock-owning session.

### 10.1 Corrections

**1. Lock and cluster-level statements on one session** (`tests/db/harness.ts`).

- Root cause: the advisory lock was held on one connection, while `CREATE
  DATABASE`, the drops and the login statements were sent on others. If the
  lock-owning connection failed after an ownership check, those statements
  could still be sent.
- Change: a `ControlSession` wraps the one connection to the `postgres`
  database. It takes the lock, answers the ownership check, performs the
  catalog reads, and is the only route for `CREATE DATABASE`, `DROP DATABASE`,
  `CREATE ROLE`, `ALTER ROLE`, `DROP ROLE` and the two grants. It sends one
  statement per message, never opens a transaction, and refuses anything else.
  The separate short-lived connections are gone.
- Uncertain outcomes: a connection failure while a statement is in flight
  raises `UncertainOutcomeError`. Provisioning then marks the cluster
  contaminated and drops nothing, whatever a later control check reports. A
  definite SQL error from a surviving session is still an ordinary failure
  with tracked cleanup.
- Unchanged: lock held from before preflight to after cleanup; pristine-cluster
  and role checks; resources recorded only when confirmed; no drop by name.
- Not moved, by necessity and by the owner's instruction: the bootstrap file
  and the migrations, which run inside the test database.

**2. SQL-01 letter case** (`tests/unit/environment.test.ts`,
`tests/unit/pg-static.test.ts`). The pattern is case-insensitive and allows any
white space inside `INSERT INTO` and `DELETE FROM`. Multiline detection and the
exact two-file allowlist are unchanged. A read-only trial against all of `src`
before the change, and the test itself afterwards, flag exactly the two allowed
files.

### 10.2 What the new tests establish, and what they do not

| Tests | Establish | Do not establish |
| --- | --- | --- |
| `ControlSession` against a fake client (12) | Statements go to the lock-holding client only; one statement per message; no transaction; nothing is sent once the session is lost; the old check-then-create interleaving sends no `CREATE DATABASE`; connection failure and lost acknowledgment both give an unknown outcome; a definite SQL error does not | That PostgreSQL or the `pg` driver reports failures as the fake does; that the lock statements work |
| Provisioning against a session-sharing fake driver (12) | After an unknown outcome at any cluster-level step, applied or not, nothing is dropped; a lost `CREATE DATABASE` acknowledgment leaves the database undropped; a wrong "lock held" answer cannot re-enable cleanup; an unknown outcome during cleanup ends it | Real cleanup |
| Harness source checks (2) | One connection to the maintenance database; each cluster-level statement appears only as an argument to the lock-owning session; no conditional or pattern-based drop | Behaviour |
| SQL-01 (1 new, 1 extended) and `pg-static` | 21 lower-, upper- and mixed-case forms, single-line, multiline, template-literal, concatenated and joined, are refused in four unauthorized files and allowed only in the two exact files | Detection of SQL that contains none of the keywords in source text |

### 10.3 Files

Modified: `tests/db/harness.ts`; `tests/unit/pg-harness.test.ts`;
`tests/unit/environment.test.ts` (SQL-01 group only);
`tests/unit/pg-static.test.ts`; the three files in `docs/postgresql/`.
Created: none.

Not changed. Checksums compared before and after: migrations `0001` to `0006`;
`migrate.ts`, `statements.ts`, `session-service.ts`, `session-cookie.ts`; the
six archived drafts and their README. Confirmed by listing every file modified
during the pass: nothing else under `src`, `db` or `tests` changed, so
`client.ts`, `key-ring.ts`, the bootstrap file, the other database test files
and the other unit test files are as they were. The only other file written is
`tsconfig.tsbuildinfo`, a git-ignored build file rewritten by the type check.
The legacy query module, all Mock and application code, `package.json` and both
vitest configurations are untouched.

### 10.4 Verification

| Check | Result |
| --- | --- |
| Type check | Pass |
| Lint | Pass |
| Database-free unit tests | 16 files; 474 passed; 1 skipped (MIG-01) |
| PostgreSQL-specific unit tests | 237: `pg-harness` 82, `pg-key-ring` 43, `pg-migrate` 47, `pg-session-cookie` 42, `pg-static` 23 |
| Other unit tests | 237: the 234 that predate Increment 1, plus three SQL-01 tests |
| **Database integration tests (`tests/db`, seven files)** | **NOT RUN** |
| **SQL parsed or executed by PostgreSQL** | **No** |

### 10.5 Remaining execution-dependent risks

1. Nothing has been executed. Unverified in particular: each cluster-level
   statement issued from the `postgres` database; the advisory-lock statements;
   how the `pg` driver surfaces a connection failure during a statement.
2. Lock loss in the instant after a confirmation, while the bootstrap file or
   the migrations run on their own connections. That work touches only the
   harness's database and the five bootstrap roles; every later cluster-level
   step and all cleanup need the lost session and cannot run.
3. An unknown outcome, a lost lock or a killed run leave resources behind. The
   cluster is contaminated and must be newly initialized.
4. The SQL-01 rule is broad by design. A comment or code that reads like SQL
   will fail it and must be reworded.
5. Sections 8.5 and 9.4 otherwise still apply.

### 10.6 Gate B-X readiness (not authorized)

A final focused independent verification of this section is recommended first.
Setup is as sections 8.6 and 9.5.

## 11. Gate B-X execution record

**This section records execution. It is not owner acceptance of Increment 1 and
authorizes nothing further.** The same record is in specification §18.15.

### 11.1 Sequence

| # | Event | Outcome |
| --- | --- | --- |
| 1 | Final Codex audit before execution | CONDITIONAL PASS; no source-level blocker to a first isolated run |
| 2 | First Gate B-X execution, 9 October 2026 | 38 passed, 3 failed, 0 skipped |
| 3 | Owner-authorized test-only remediation, two files | PGT-04 and PGT-50 corrected; nothing else changed |
| 4 | Independent Codex audit of the corrected test source | PASS |
| 5 | Second Gate B-X execution, 9 October 2026 | 41 passed, 0 failed, 0 skipped |
| 6 | Final Codex acceptance audit | CONDITIONAL PASS: no functional Increment 1 blocker; pending documentation consistency |

Each execution was one run, separately authorized by the owner, on its own
newly initialized disposable cluster.

### 11.2 Environment

PostgreSQL 17.11, built from the official source (published SHA-256 verified)
into `/Users/frankncube/shopaccess-gate-bx/pg17`. Nothing was installed
system-wide; no service was registered; no other PostgreSQL server existed on
the machine. Docker and Homebrew were considered and not used.

| | First run | Second run |
| --- | --- | --- |
| Data directory (under `/Users/frankncube/shopaccess-gate-bx/`) | `data` | `data-run2-20261009-120436` |
| Address | `127.0.0.1:54517` | `127.0.0.1:54527` |
| System identifier | `7694686172024518578` | `7694699675150923610` |
| Cluster name | `shopaccess-disposable-test` | `shopaccess-disposable-test` |
| Access | Loopback TCP, password only, no Unix socket | The same, with a new credential |
| Command | `npx vitest run --config vitest.db.config.mts --reporter=verbose`, with `SHOPACCESS_PG_TEST_ADMIN_URL` set for that command only | The same |
| Result | 38 passed, 3 failed | 41 passed, 0 failed, 0 skipped |
| Afterwards | Server stopped normally | Server stopped normally |

Before each run, without issuing SQL: version, data directory, port and listen
address were confirmed; the data directory was confirmed new; no concurrent
harness was running; the six migration files matched the pinned checksums; and
the suite was confirmed to be exactly the seven approved files. All database
work was done by the harness. No SQL was issued by hand.

### 11.3 First execution

Thirty-eight tests passed. Three failed, each from a defect in the test:

- **PGT-04 (two tests): timed out at 60 seconds.** Each child process printed
  its report but did not exit, because its standard input stayed open, and the
  test waited for it to close. The admission counts were not checked.
- **PGT-50 (one test): wrong expected SQLSTATE.** `TRUNCATE
  shopaccess.server_key_versions` was refused with `0A000`, PostgreSQL's
  refusal to truncate a table referenced by a foreign key, where the test
  expected the trigger's `23001`. The later statements of that test were not
  reached.

No uncertain outcome and no cleanup failure occurred. This run's report was
given to the owner in conversation and was not stored in the repository; the
preserved first-run logs are the supporting evidence.

### 11.4 Remediation (tests only)

- `tests/db/admission-processes.test.ts`: the parent closes the child's input
  with the start signal; the child releases its input; a 40-second deadline
  reports how far a child got. Independent processes, the barrier and all
  admission assertions unchanged.
- `tests/db/migrations.test.ts`: per-statement expected codes; all statements
  attempted before any assertion; `CASCADE` and multi-table `TRUNCATE` cases
  added; row counts and digests of the protected tables compared before and
  after.

No assertion weakened. No SQL, migration, library or application change.

### 11.5 Second execution

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

- **Bootstrap and migrations `0001` to `0006`:** run by the harness in each of
  seven fresh databases; verified by the passing suite (nine tables, six entry
  points and one helper, six ledger rows with the pinned checksums, idempotent
  re-application, altered file refused).
- **PGT-04:** both cross-process tests passed. Empty table: 30 admitted, 10
  rate-limited. One slot left: one admitted, 29 at capacity, 10 rate-limited.
  Both children exited normally.
- **PGT-50:** all 15 refusals met their expected SQLSTATE (thirteen `23001`
  from triggers; two `0A000` from the foreign-key rule, for the plain truncate
  of `server_key_versions` and of `checkout_owners`). The six `CASCADE` and
  multi-table cases were all stopped by the triggers. Protected data unchanged
  by count and digest. The per-statement table is in specification §18.15.
- **Server log:** 119 errors, all intended refusals (`42501` 90, `23001` 21,
  `23514` 5, `0A000` 2, `55P03` 1). No FATAL, PANIC, deadlock or other code.
- **Cleanup:** no uncertain outcome, lost lock or cleanup error; only the three
  built-in databases remained; the cluster is not contaminated.

### 11.6 Evidence attribution

Reported independently by the final Codex acceptance audit: seven files, 41
passed, 0 failed, 0 skipped; PGT-04 and PGT-50 passing, from execution results
and source inspection; PostgreSQL 17.11 on `127.0.0.1:54527` shutting down
normally; six migration checksums matching the inventory; no functional
acceptance blocker.

Resting on this implementer's execution report, supported by the passing tests
and the preserved logs, and **not** independently verified by Codex: the 15
individual SQLSTATEs; the classification of the 119 server-log errors; the
preflight steps; the cleanup observations; that the first cluster was untouched
during the second run; and the first run's results and causes.

Limits Codex stated for itself: it did not attribute every server-log error to
a test assertion, did not query the database after shutdown, and could not
establish a complete history of shell commands or Git changes. Nobody observed
the role list after the final test file, which needs SQL; the cleanup reported
no error.

### 11.7 Limitations that remain

1. The suite passed once, on one local machine. Concurrency tests were not
   repeated.
2. PostgreSQL is not wired into the running application.
3. No real PayPal, external AI, Channel3 or hosted deployment was tested.
4. Backup, restore and production operations are outside Increment 1.
5. Earlier accepted limitations stand: sections 5, 8.5, 9.4 and 10.5, except
   where those sections say only that nothing had been executed.
6. Both disposable clusters, both server logs, both run logs and both
   credential files are preserved in `/Users/frankncube/shopaccess-gate-bx`
   pending a separate owner decision.

### 11.8 Known documentation inconsistencies

The closure that added this section covered four files: the specification,
this report, and one comment each in `tests/db/admission-processes.test.ts` and
`tests/db/migrations.test.ts`. Elsewhere, comments still say the code was never
run:

- **Misleading as current status, left permanently:** the header comments of
  migrations `0001` to `0006`. Editing them would change the pinned checksums.
- **Misleading as current status, correctable under a later authorization:**
  `db/bootstrap/0000_roles_and_schemas.sql`; `tests/db/harness.ts`,
  `sessions.test.ts` (two places), `keys.test.ts`, `privileges.test.ts`,
  `clock.test.ts`, `catalog.test.ts`; `src/lib/pg/client.ts`, `migrate.ts`,
  `statements.ts`.
- **Historical and accurate:** `correction-report-013.md` sections 16 to 19,
  and sections 1 to 10 of this report. Each describes a stage before Gate B-X.

None affects behaviour.

