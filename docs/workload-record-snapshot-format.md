# Workload records in the snapshot store: format 10 (Release A, compatibility only)

Status: **compatibility layer only. Nothing activates it.** No environment, script or deployment sets
`SHOPACCESS_WORKLOAD_RECORDS`, and no existing owner or rehearsal store is converted.

## What this is

AI workload records (kind, source draft version, evidence state; see `src/lib/readiness/workload-record.ts`) are advisory
shopper context. In the ordinary snapshot store (format 7) they live only in memory, so a restart loses them and the
application falls back to the last eight conversation turns plus an in-memory uncertainty marker.

Format 10 is the **format-9 body**: the format-7 body plus a `workloads` array (at most one record per session, bound to
that session's current draft). It has **no charger budgets**: those stay format 8, which remains a separate test-only
format. Formats 8 and 9 stay isolated to their existing test modes (`SHOPACCESS_CHARGER_BUDGET_TEST_STORE=1` and the
`format9WorkloadTestStore` option).

## Exact behaviour

| Setting | Store file | Result |
| --- | --- | --- |
| absent (default) | format 1–7 | opens, writes **format 7**, exactly as before |
| absent | format 8, 9 | refused (`test-format-mismatch`), as before |
| absent | format 10 | refused (`format-10-requires-workload-setting`); the file is not read for use and not rewritten |
| `SHOPACCESS_WORKLOAD_RECORDS=1` | format 10 | opens, recovers, writes **format 10** |
| `SHOPACCESS_WORKLOAD_RECORDS=1` | format 1–7 | refused (`workload-setting-requires-format-10-store`); the store is **not** converted |
| `SHOPACCESS_WORKLOAD_RECORDS=1` | format 8, 9 | refused (`test-format-mismatch`) |
| the setting together with another test mode | any | refused (`conflicting-test-modes`) |

Only the exact token `1` selects the setting. A fresh format-10 store can be created only by passing
`initializeEmpty` together with the `workloadRecords` option (used by isolated tests). The store initializer
(`src/server/mock-store-init.mts`) does not read the setting, so it cannot create one.

The store's write format, the recovery gate's body shape (`bodyFormatFor`) and the file's format agree by construction:
each mode accepts exactly one family of file formats, so a file is never rewritten in a different shape than it was read.

## Activation restrictions (Release B, not part of this change)

* Existing format-7 owner and rehearsal stores must **not** be switched. Release A refuses them rather than converting them.
* Activation needs a separately approved Release B: a stopped server, a copy of the store directory and key, and a fresh
  store (or an explicitly approved one-way conversion). Legacy workload synthesis from retained conversations is also
  deferred to Release B.

## Rollback and recovery risks

* **There is no downgrade writer.** A format-10 store cannot be turned back into format 7 by this application.
* Rolling back to a release that contains this compatibility layer is safe: it reads and writes format 10 while the
  setting is on, and refuses the file with an explicit code while it is off.
* A release **older** than this one does not know format 10 and treats the file as invalid, so the store stays
  unavailable. The only way back is a copy of the store taken before activation; restoring it discards every write made
  after the copy, including permission outcomes and revision markers, exactly as the existing format notes warn. Do not
  restore a copy while payment or checkout activity is going on.
* **Checksum and the format label.** For formats 1 to 9 the checksum is the sha256 of the canonical body, byte for byte as
  before, so every existing store reads and verifies unchanged. For format 10 the checksum is the sha256 of a fixed
  domain separator (`shopaccess-snapshot-format-10` and a newline) followed by the canonical body, so the format label
  is bound to it. A format-9 snapshot relabelled 10 (or a format-10 snapshot relabelled 9) fails validation. Reading,
  writing and recovery all use the same function, and the serialization stays deterministic.
* **This is an unkeyed checksum, not authentication.** The identity field is derived from the key but is stored in the
  clear, and the checksum needs no key, so anyone who can write `store.json` can recompute both. The checksum protects
  against accidents and sloppy relabelling only. Authenticating a store would need a keyed construction (for example an
  HMAC) and is a separate decision that is not part of Release A. The body of every format is also validated for the
  format it is opened as: format 7 rejects a body that carries `workloads`, and budgets are accepted only in format 8.
* Checkouts, quotes, payment states and the audit log are not part of any snapshot and are unaffected.
