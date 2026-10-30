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

## Legacy-draft marker (`legacyDrafts`, optional, format 10 only)

A format-7 store keeps no workload records, so a restored draft whose history is full (eight retained turns) may have
lost the turn that stated an AI workload. Format 7 therefore treats such drafts conservatively ("potential" AI). A plain
conversion to `workloads: []` would silently drop that protection, and marking every recordless draft would change
native format-10 behaviour. The distinction is persisted instead:

* `legacyDrafts` is an **optional** key of the format-10 body: a list of `{ sessionId, draftId }`, at most one per
  session, each naming that session's current draft in the same body. Anything else (extra keys, a draft that is not the
  session's draft, an unknown session, duplicates, more entries than sessions, a non-array) makes the file invalid.
  Formats 1 to 9 reject the key.
* It is written **only** by an explicit format-7-to-10 conversion (`convertBodyToWorkloadBody`), for drafts that survive
  at conversion time and have a full retained conversation. A native format-10 store never gets the key, and an absent key
  means "no legacy information", never an inferred one. An empty list is kept and written back as an empty list.
* The checksum is unchanged: the format-10 checksum already covers the whole canonical body.
* Effect: a listed draft is restored as unrecovered, so a full history keeps the "potential" AI label. A
  `general_programming` record does not clear it (it says nothing about forgotten turns). An AI-kind record states the
  workload outright and supersedes the effect, but the marker stays. The marker disappears only with its draft: a replaced
  or expired draft, or an ended session, drops it at restore and at the next write.
* The label rule never changes eligibility, ranking or purchase authorization.
* **Compatibility:** a program that has the format-10 compatibility layer but not this key treats a file carrying it as
  invalid and stays unavailable (exact body keys). Restoring a pre-conversion copy is the only way back; see above.

## Offline conversion tool (format 1 to 7 to format 10)

`src/server/mock-store-migrate.mts` converts a mock snapshot store to format 10. It is run by hand, never at startup, and
nothing in the application imports it. It is the only conversion path; the application itself never converts a store.

```
node --experimental-strip-types --import scripts/mock-store-load-hook.mjs src/server/mock-store-migrate.mts \
  --source-directory D --key-file K --backup-directory B (--dry-run | --convert)
```

All three paths and exactly one mode are required. Stop the application first: the tool takes the store's exclusive writer
lock, so a running application or a second conversion is refused. Formats 8, 9 and 10 are refused without any change, and a
missing store is never created.

* **`--dry-run`** validates the source and the paths and reports the source format and how many `legacyDrafts` markers a
  conversion would write. It creates and writes nothing, also when a path is invalid.
* **`--convert`** copies `store.json` byte for byte into the new directory `B` (it must not exist; it is created with mode
  0700 and the file 0600; its canonical location must not be inside the source or contain it, so symlinked ancestors and
  `..` spellings are resolved first). It then verifies the copy by opening it through the store (valid snapshot, same key
  identity, same format and body, correct modes) and by comparing the bytes. That verification leaves a `writer.lock`
  beside the copy, so **the backup holds `store.json` and `writer.lock`**. Only after that does it write the converted body
  through the store's one validated atomic commit, then reopens the result in workload mode and compares it.

### Backup and rollback

* **The encryption key is not copied.** Keep the original key file separately; a backup is unreadable without it, and the
  converted store keeps the same key and identity.
* **Conversion is one-way.** The tool never restores a backup by itself, never sets `SHOPACCESS_WORKLOAD_RECORDS` and never
  retries. Format 10 is still only opened when that setting is on.
* **Restoring a backup is manual and offline**, with the application stopped: put the backup's `store.json` (mode 0600) back
  in the store directory. It **discards every write made after the backup was taken**, including purchase-permission
  outcomes and revision markers. Do not restore while checkout activity is going on.
* A release or program that does not know the optional `legacyDrafts` key rejects a converted file and stays unavailable;
  restoring the backup is then the only way back.
* If backup verification fails, the backup directory is **left in place for inspection** and the source is untouched. The next
  conversion attempt refuses that path (`backup-exists`) until it is removed or another path is given.

### Outcomes

One line on stdout (codes, formats and counts only; no key bytes and no shopper data), ending in what happened to the source:

| Exit | Status | `source=` | Meaning |
| --- | --- | --- | --- |
| 0 | `dry-run`, `converted` | `unchanged`, `converted` | success |
| 1 | `refused`, `failed` | `unchanged` | stopped before the source commit; the source is byte-identical |
| 2 | (usage line on stderr) | | bad command; nothing was read |
| 3 | `indeterminate` | `unknown` | the rename may or may not be durable (for example the directory fsync failed). **Investigate the store and the backup before any retry.** |
| 4 | `unverified` | `unknown` | the commit was reported but the result could not be verified, or the source changed unexpectedly |

After exit 3 or 4 nothing is restored automatically. Unexpected errors are reported in the same classes (never thrown).
