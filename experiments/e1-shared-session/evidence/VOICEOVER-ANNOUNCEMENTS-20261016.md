# E1 reply and revocation announcements: change and VoiceOver evidence (October 16, 2026)

Status: **prepared for independent review. Uncommitted. E1 not accepted.** Base `f1a2fe1412d58409fb4903319582f2ce8973b08c` (`design/shared-session-e1-20261016`).

This is the published, sanitized summary. The detailed log, scripts and checksums are in the owner's private evidence store (`e1-announcements-20261016`). No credentials, pairing IDs or URLs, cookies, CSRF values, runtime data, or non-E1 screen content are included here.

## Problem

A VoiceOver run earlier on October 16 found two gaps:
- New assistant replies were silent. `#history` is re-rendered and is not a live region.
- Successful revocation was silent; only the focus move to the "Paired access" heading was spoken.

## Change (7 files plus 1 new test file, all under `experiments/e1-shared-session/`)

- `extension/client.mjs` gains four helpers:
  - `replyAnnouncement(prev, next)`:
    - returns only the newest assistant reply whose `sequence` exceeds the previous state's last sequence, which is robust to the eight-line trim;
    - uses the saved `interfaceLanguage`;
    - is numbered by exchange ("Assistant reply 5: …" / "Respuesta del asistente 5: …");
    - returns `null` on first load, an unchanged refresh, a language-only change, or a different conversation.
  - `revocationAnnouncement(language)`: an explicit English or Spanish message.
  - `announce(region, text)`: clears, then sets after 150 ms.
  - `completionStatus(announced, generic)`: suppresses the generic "Done"/"Saved" status when a specific announcement was made.
- `web/index.html` and `extension/panel.html` each gain one visually hidden `<p id="announce" role="status" aria-live="polite" aria-atomic="true">`. Both stylesheets gain `.visually-hidden`.
- `web/site.mjs` announces replies in `render` and announces revocation after the revoke refresh.
- `extension/panel.mjs` announces replies in `render`.
- Focus restoration, stale-edit recovery and the duplicate-submit lock are unchanged.
- **Why the numbering:**
  - In the first implementation, a second reply with the identical mock text was not captured in two samples, although the DOM showed the region cleared and refilled 150 ms later.
  - Numbering makes each message distinct. Afterwards, consecutive replies were both captured.
  - The cause (VoiceOver or Chrome not repeating an identical live-region message) is inferred, not proven.

## Automated tests

- New `tests/announcement.test.mjs` (10 cases) covers:
  - first load and unchanged refresh;
  - only the latest reply, in the saved language;
  - shopper-only changes;
  - the trim;
  - a different conversation or a language-only change;
  - the revocation text in both languages;
  - clear-then-set;
  - suppression of the generic status;
  - distinct messages for identical replies;
  - one polite atomic region per surface, wired into both scripts.
- Before implementation the file failed at import, an existence red rather than a behaviour red. The numbering cases failed on behaviour before the numbering change.
- **Full prototype suite: 62/62 pass**, Node 24.21.0 with a PATH/HOME-only environment.

## VoiceOver evidence

| | |
| --- | --- |
| Platform | macOS 26.6.2, VoiceOver 10, Chrome 155. Synthetic data; local server only |
| Method | VoiceOver's own `last phrase`, read through AppleScript. AppleScript control was enabled by the owner for the session and **restored to off (owner-confirmed)** |
| Owner actions | Reloading the extension and opening the side panel only |

Evidence classes:
- **Automatic:** sampled about every 0.05 s while no VoiceOver command was issued.
- **Navigated:** after a VoiceOver move or activate command.
- Sampling sees only the latest phrase. A phrase replaced between samples can be missed, so absence from a sample does not prove that nothing was spoken.
- Setup steps (focus, form submission, API posts) used page JavaScript and are not evidence.

### Website

| Test | Class | Observed | Result |
| --- | --- | --- | --- |
| Two consecutive replies (numbered) | Automatic | "Assistant reply 4: Local mock assistant: …", then "Assistant reply 5: …" | Announced |
| Unchanged Refresh | Automatic | "Done / Listo." | **No repeated reply announcement**; the generic status was still announced |
| Reply from another client, then Refresh | Automatic | "Assistant reply 6: …" | Announced |
| Switch to Español, then send | Automatic | "Done / Listo.", then "Respuesta del asistente 7: Asistente simulado local: …" | Announced in the saved language |
| Revoke, activated with VoiceOver | Navigated, then automatic | "Revoke / Revocar … button" → "heading level 2 Paired access / Accesos vinculados" → "Acceso revocado. La extensión ya no puede leer ni cambiar esta conversación." | Explicit revocation announced after the focus move |

### Real side panel

The panel was reached entirely by VoiceOver navigation: resize handle, "ShopAccess E1 local pairing prototype", "Pin to toolbar", "Close side panel", "ShopAccess E1 web content", "link Skip to conversation", "heading level 1 ShopAccess E1", "Pair with website button".

| Test | Class | Observed | Result |
| --- | --- | --- | --- |
| Pair | Navigated | VoiceOver activated Pair; approval was made on the website test page; the panel exchanged its credential | Paired |
| Shared language | Navigated | "Vincular con el sitio button", "Actualizar conversación button" | Spanish from the saved state |
| Reply from another client, panel Refresh activated with VoiceOver | Automatic | "Respuesta del asistente 8: Asistente simulado local: mensaje guardado. Sin IA en vivo ni compras." | Announced by the panel (the website did not re-render) |
| Unchanged panel Refresh | Automatic | "Guardado." | **No repeated reply announcement**; the generic status was still announced |
| Panel Refresh after revocation | Automatic | "La solicitud falló. Actualiza o vuelve a vincular. (TOKEN_INVALID)" | Refusal announced (alert); raw code |

### Log integrity

- The live session display showed some panel entries twice.
- The log file was checked: every test's entries are unique (total = unique for all seven tests). The doubling was display-only: the background sampler printed each line, and a follow-up search printed the log lines again.
- There is therefore **no evidence of repeated speech**. Whether VoiceOver repeated a phrase between samples is **uncertain**.

### Incident

During one step, VoiceOver navigated the owner's Terminal instead of Chrome.
- Those reads were deleted from the private log, and no VoiceOver action was performed there.
- Subsequent steps confirmed the VoiceOver location before navigating.

## Explicitly untested

1. A message sent from the panel, and the panel's announcement of its own reply. VoiceOver scripting cannot type, and keystroke automation needs a macOS permission that was not requested.
2. Panel stale-edit recovery under VoiceOver.
3. Speech when an error alert and a reply announcement occur at the same time, on either surface.
4. Real VoiceOver use by a person.

## Other open gaps

- Error messages are raw codes ("STALE_REVISION", "TOKEN_INVALID").
- Reply announcements repeat the full mock text.
- Re-pairing leaves earlier grants active (recorded in `BROWSER-VERIFICATION-20261016.md`).
- No full accessibility claim is made, and E1 is not accepted.

## Reviewer checklist

- `git diff f1a2fe1 -- experiments/e1-shared-session/`, plus the new `tests/announcement.test.mjs`.
- `node --test experiments/e1-shared-session/tests/*.test.mjs` should report 62/62.
- Confirm that announcements cannot fire on an unchanged refresh or on first load (`replyAnnouncement`).
- Confirm that focus, stale recovery and duplicate-submit behaviour are unchanged in `site.mjs` and `panel.mjs`.

## Which code the VoiceOver evidence tested

The VoiceOver session (13:45–14:03Z) did **not** test the code committed with this summary.
- **Tested source:** base `f1a2fe1412d58409fb4903319582f2ce8973b08c` plus the first, uncommitted announcement change, including reply numbering.
- **Fingerprint:** the change is preserved privately as `announcements.diff` (sha256 `5866da040b5b7157f3bf14b5b378f99da7cd02d43fd442279cedfea2ee9abb9a`, saved at session end).
- **What that version did:** it used a non-cancellable `announce()` and the generic revocation wording ("Access revoked." / "Acceso revocado.").
- **Earlier samples:** A1, A2 and A2b ran on an intermediate state before the numbering edit. That state was not saved separately; its only difference was unnumbered reply text.
- **Committed code:** adds pairing-specific revocation wording and cancellable announcements (see the addendum). It has automated tests only and **no VoiceOver verification**.

## Addendum: review fixes (October 16, after the VoiceOver session; not VoiceOver-verified)

The sections above are unchanged and describe the code as tested under VoiceOver. Two review findings were then fixed. **No new VoiceOver session was run**, so the VoiceOver evidence above covers the earlier generic revocation wording and the earlier uncancellable announcement.

### Finding 1: revocation wording did not identify the pairing

`revocationAnnouncement(language, {label, remaining})` now names the revoked pairing by the eight-character label its Revoke button shows, and states what remains:
- English: "Access revoked for pairing abcd1234. That pairing can no longer read or change this conversation." followed by "No paired access remains." / "1 other pairing remains active." / "N other pairings remain active."
- Spanish: "Acceso revocado para el vínculo abcd1234. Ese vínculo ya no puede leer ni cambiar esta conversación." followed by "No queda ningún vínculo activo." / "Queda 1 otro vínculo activo." / "Quedan N otros vínculos activos."
- A label that is not eight hex characters is not echoed.
- The website passes the clicked grant's label and the post-refresh grant count (`refresh()` now returns the list).

### Finding 2: delayed announcements could cross transitions

- `announce()` is replaced by `createAnnouncer(region)`, which keeps one pending callback. A newer message cancels the older one, and `clear()` cancels it and empties the region.
- The panel clears on **Forget**, on **Pair** (re-pair), and when a render brings a **different conversation** (`conversationReplaced`).
- The website clears on conversation replacement.
- A second revocation or reply before the delay elapses supersedes the first.

### Tests

New `tests/announcement-transitions.test.mjs` (7 behavioural cases) runs the real `panel.mjs` and `site.mjs` under a minimal fake DOM (`tests/fake-dom.mjs`) with stubbed fetch and chrome storage:
- Panel: Forget, re-pair, and conversation replacement each cancel a pending reply; a newer reply supersedes a pending one.
- Website: with three active grants, revoking the middle one names it and reports "2 other pairings remain active", without naming the others. Revoking the last grant in Spanish says none remain. A second revocation before the first announcement fires replaces it.

Results:
- Before the fix: 6 of 7 failed, all on behaviour assertions. Examples: "Assistant reply 2: late reply" appeared after Forget; the generic "Access revoked." wording.
- "Newer reply supersedes a pending one" already passed before the fix, because the race window is narrower than the sampling. It does not prove the fix. The deterministic unit test "announcer cancels the outdated callback" covers that path.
- After the fix: 7/7, and stable over three repeat runs.
- Unit tests updated: announcer clear-then-set, cancellation on a newer message and on clear (fake scheduler), `conversationReplaced`, and revocation wording in both languages with 0, 1 and N remaining.
- **Full prototype suite: 71/71 pass.**
- One interim failure was a defect in the test's fake timer (fired callbacks were not removed). The test was corrected; the code was not.

### Still untested

- VoiceOver speech of the new revocation wording and of cancellation.
- Panel-originated send.
- Panel stale recovery under VoiceOver.
- Simultaneous error and reply announcements.
- Real VoiceOver use by a person.
