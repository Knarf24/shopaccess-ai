# SDD ledger — plan: docs/superpowers/plans/2026-10-16-shared-session-e1.md
Implementation baseline: remote design branch 1b3deddb64158e3e9fea25b6aa47abd985e2f1a1. Local isolated prototype repository, not the user's Mac checkout.
Ruling: direct clone lacks authentication; use the GitHub connector for source inspection and final branch publication, and an isolated local Git repository for prototype task commits. A separately attempted partial source materialization is not a validated checkout and is not used for testing. Cost if wrong: integration requires later validation in a full checkout.
Ruling: Node available is 24.19.0, below application's pinned 24.21.0. Prototype uses built-ins only; report version and leave full application validation unclaimed. Cost if wrong: recheck under pinned Node.
Pre-flight: authority parent identities feed conversation ownership and HTTP resolution; HTTP supplies no caller-selected parent IDs. Conversation store returns serializable revision envelopes to both surfaces. Interfaces align.
Ruling: anonymous pairing creation cannot know the owning session before approval; enforce global creation limits at start and per-parent three-pending limit at approval. Cost if wrong: deployment abuse limits require further design.
Ruling: skill shell helpers are not available as local files in this remote skill package; record task starts, red/green commands and commits manually here.
Task 1: 14 authority tests pass; initial missing-module failure retained in task1-red.txt, successful output in task1-green.txt.
Task 2: complete. 23 combined tests pass, including concurrent stale writes, duplicate IDs, private-file persistence, restart reload and disk failure refusal. Evidence task2-red.txt and task2-green.txt.
Ruling: synthetic requirement parsing recognizes explicit English fixture tokens only; Spanish UI/history works, but this prototype does not claim bilingual interpretation. Cost if wrong: actual live conversational acceptance remains open.
Task 3: loopback HTTP core passes 4 tests. Initial restart test failed because its cleanup removed the data directory before closing the replacement server; reordered fixture-owned cleanup, preserving all functional assertions.
Ruling: synthetic cookie signing key is a private 0600 key file outside state.json so the same website cookie can locate its synthetic conversation after restart. Credentials still do not enter snapshots. Cost if wrong: real session integration remains separate.
Task 4: manifest and client-helper tests pass 4/4. UI files are installed assets, not browser-verified. Spanish copy is deliberately bilingual on the synthetic website; full production multilingual acceptance remains open.
Final review: independent read-only reviewer reproduced seven findings. Regraded all as important to this protocol/prototype: restored lifetime, indeterminate disk publication, save/load cap mismatch, polling/forget race, suffix routing, dictionary-key collisions, stale UI recovery.
Final: fixed lifetime restoration and cookie idle persistence; test expired idle cookie remains expired after restart RED→GREEN, plus original absolute-expiry regression.
Final: fixed post-rename error classification and poisoned writes; test post-rename sync failure is indeterminate and poisons writes RED→GREEN.
Final: fixed save/load byte-limit mismatch; snapshot byte cap before publication RED→GREEN.
Final: fixed poll/forget generation checks and late-store cleanup; both in-flight cancellation tests RED→GREEN.
Final: fixed exact mutation routes and dictionary own-property lookup; both regressions RED→GREEN.
Final: fixed stale UI state through shared recoverStale helper without auto-resubmission; helper regression RED→GREEN. Actual mounted/browser behavior remains unverified.
Ruling: shared browser recovery helper is served explicitly at /client.mjs to the synthetic website; all code remains under the allowed experiment path. Cost if wrong: adjust prototype asset mapping.
Ruling: directory fsync failure after rename cannot honestly mean no write happened; return PERSISTENCE_OUTCOME_UNKNOWN and stop further writes until restart. Cost if wrong: prototype needs manual state reconciliation; no payment exists.
Ruling: website synthetic cookie embeds signed creation/last-seen times, preserving lifetime across restart without persisting child credentials. Cost if wrong: real application authentication still requires separate integration review.
Task 5: automated checks completed, browser acceptance PARTIAL. Cloud browser cannot reach local HTTP server (ERR_CONNECTION_REFUSED). No extension install, keyboard or VoiceOver observation. Do not mark E1 accepted.
Deferred minors: none from the review (all seven were addressed); broader UI localization and mounted-browser acceptance remain explicit prototype gaps, not accepted features.
Final verification: 27 non-network unit/client checks and 13 loopback checks passed in PATH-only environments; 40 total. No application suite run and no no-TCP claim. Manual prototype server stopped; port 3764 free. Results and limitations recorded in RESULTS.md.
