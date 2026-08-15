# Evidence index — evidence ID → SHA-256 of raw artifact + one-line redacted summary

Raw artifacts live in `~/qc-evidence/<CHECK-ID>/` (dir 700, files 600). Never committed.

| Evidence ID | SHA-256 | Summary |
|---|---|---|
| E-QC0-01 | 91a09e37d9f2172bc2eb653f3abe8ad6c8d9b02b8fdad9507fc70263e0683d5b | `QC0-01/start-ritual.txt` — git status of outer repo (dirty) + SocialSol repo (clean, main @ d1a119e) |
| E-QC0-02 | fbc48a7afa5b27eea62b493fec3c531f5997ed5b68351ed84e8fe3e20e77a3ed | `QC0-02/sha-agreement.txt` — local HEAD == origin/main, remote URL |
| E-QC0-03 | 781e89107700d14bf8dc87c086051dbc9c585f1bb7eb869406920052037debc4 | `QC0-03/ci-verify.txt` — gh run list: CI success on main @ d1a119e |
| E-QC0-04 | 95ee66c48c71056c4ae909c5399b41bbd8c3e8cc311a25e4381c486654210a36 | `QC0-04/deployment-record.txt` — latest deployment record summary (completed @ d1a119e) |
| E-QC0-04b | a018f2d009a994746da516bd205b1bd9012e333339c5332d0ab2e8ca5be5d994 | `QC0-04/latest-deployment-record.json` — full record copy (mode 600) |
| E-QC0-05 | 39acc75b144d8e863035861c4508fd6e4cb76c44c491be34faca0a77b475f8f4 | `QC0-05/loaded-services.txt` — launchctl list + process source paths |
| E-QC0-06 | 5a1471e54457eafcc0425816e23331442b535d58eede1714a86a60b8257c1340 | `QC0-06/policy-fingerprint.txt` — policy.json sha256/mode/mtime (no contents) |
| E-QC0-07 | 41f021d94746bc5615e4995d5f7ccecb607f2afb6d69ab9d5cf86083a9c41da1 | `QC0-07/db-identity.txt` — plist env grep + lsof open DB files for crm/worker |
| E-QC0-08a | 4284a9ff72daafbb8d5568829caefe85bc2f1224153c77f8e18bc940d9b938a0 | `QC0-08/tables.txt` — live DB table list (RO) |
| E-QC0-08b | 03386feabf16846f957908eaeb5e5a44d861cbe445c6dbb4d778f7e024f80887 | `QC0-08/columns.txt` — column names for sweep tables |
| E-QC0-08c | 71a850281b56836c2abc6bb0ecc0f8b0b25d13388c97547dbe1c2be94e1309cd | `QC0-08/stalled-runs.txt` — run status aggregates; 0 non-terminal |
| E-QC0-09 | 2b175abb0f8b88682f3a44a1e83eff211deede04c90dd682afe23c72cc5aa994 | `QC0-09/outbox.txt` — failed-run recency + outbox aggregates; 0 dead |
| E-QC0-10 | 16491af8e9d8795dadbc261427eecbc097be4210ea633be34684034e56746cba | `QC0-11/effects-reviews.txt` — effect status aggregates, deadline check, qbo.write trace |
| E-QC0-11 | 6a993f7fa671c733248f1bd662c17cb645f590c02c6a44389a630cc24872e15e | `QC0-11/manual-review-effects.txt` — manual_review/failed effects ↔ resolved review rows |
| E-QC0-12 | d796c54eb69343c993ae30d01bb91147f5ead24bf31f887ca1864f6f9d3e02dd | `QC0-12/meta-spend.txt` — budget_ledger empty; registry active=7; Meta effects 30d; 0 change requests |
| E-QC0-13 | fc1dce480cccd4a08fc3c9e61b279c7e16b241bf11399c421429b75a6a1236aa | `QC0-13/outreach-due.txt` — outreach status aggregates; 0 due-now |
| E-QC0-14 | dd619f252b1605ce8635fef20133e66ed110f427381f2c6403268c7a6799d163 | `QC0-14/qbo-failures.txt` — quickbooks effects 14d all verified; 0 failed lifetime; reconciliations matched |
| E-QC0-15 | 78ac91aecf7f7631218c78b7b2e6dd6093c805d4872642bfea5956a9da0861a6 | `QC0-15/repo-conventions.txt` — CI workflow, npm scripts, secret scanner, repo layout |
