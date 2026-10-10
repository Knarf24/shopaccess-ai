# Archived Milestone 001 migration drafts (never executed)

These six files are the PostgreSQL migration drafts written during Milestone 001.
They were never applied to any database. They are kept, byte for byte, as the
historical record; `docs/implementation-report.md` and the Milestone 001
correction reports refer to them by their original path, `db/migrations/`.

They are **not** part of the Milestone 002 migration sequence:

- The migration runner (`src/lib/pg/migrate.ts`) reads only the files directly
  inside `db/migrations/` and never looks in this folder.
- `tests/unit/environment.test.ts` still runs its static checks against these
  files, and its MIG-01 test (skipped unless explicitly configured) still
  targets them together with the legacy query module `src/lib/db/queries.ts`.

Do not edit, rename or execute these files.

## SHA-256 checksums recorded before archiving

Recorded on 2026-10-09, before the files were moved here, and verified
identical afterwards. `tests/unit/pg-static.test.ts` re-checks them.

```
b0eb2f4aa2da4f58d7b56f7a9123061728954f599a4df91293400ac7ae13a147  0001_shopper_sessions.sql
7778686f22e65e954f15082294786ebfa85fb3fbc4047aee83e4be2d126a05cb  0002_merchant_catalog.sql
a7b925843395a638e1769205ef2ec2c5e28e9525d4d6eed90ae0862756458d56  0003_carts.sql
c84178960064d9b476b24e803e3d682209456737e9c67142f18da0822fbc2a08  0004_checkout_quotes_confirmations.sql
bfcd219c909df07ee972b8bf176e34350f5b7a4841ca23c633f485ac234be33a  0005_payment_operations.sql
a256d8e84dba37ef91ce00797842406dd50b288410cc10e0ab4d216005b9bf67  0006_audit_events.sql
```
