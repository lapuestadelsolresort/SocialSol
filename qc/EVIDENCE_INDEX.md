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
| E-QC1-T1 | e962054f159ee9ce74b57812e39de3777ce2d5313358314fa8c17170f021759c | `QC1-T1/registry.txt` — workflows dir listing, registry structure, 53-name count |
| E-QC1-T2 | 780e2bcaa6d71a786fcfa65d795880acd76489de75d2307eabbaf32f0d3fc859 | `QC1-T2/migrations.txt` — migrations 001–020 + schema-builder files |
| E-QC1-T3 | 01d4fbf031dadd84095491fec398814e24aef19fc414ac46c56a07b19e9a1f19 | `QC1-T3/db-path-contract.txt` — DB_PATH/CRM_DB_PATH code lines, plist env keys, inode agreement |
| E-QC1-T4 | 15f8c833c24424efeecdbcacd5f12838b1c6434d089e14d538ad68d5ea5b5df9 | `QC1-T4/failing-jobs.txt` — launchctl print last-exit for 3 failing jobs + watchdog; watchdog EXPECTED set |
| E-QC1-T5 | d9a02d34472496ee9fda8b6563da107c388a576fae98d7dac4e69f0a485f4c99 | `QC1-T5/paulina-gate.txt` — email_status gate hits; realness_score zero hits |
| E-QC1-T7a | 27dc9c84c2fcb10434cea665c09f971bbc47d5b92b375105c9f74fbd1fcef522 | `QC1-T7/meta-dm.txt` — `!dm` handler + Meta DM adapter grep results |
| E-QC1-T7b | e1b0d19e777c76eb2b5d97c2a475d169afe5d7d226887957d6ff34fd6d9531f3 | `QC1-T7/dm-activity.txt` — 0 meta.dm runs; meta effects; meta_messages aggregates |
| E-QC1-T7c | 6a3e93a54a13d3188df6db8028f1c0eb7e64057ae04bf3cd23042017b1f83789 | `QC1-T7/dm-send-provenance.txt` — outbound rows all whatsapp; cutover commit 4cad390; Graph v21.0 endpoint |
| E-QC1-T7d | 702fcfaa74a952447dcfc6750a3b1a21493c0d4abde17afc0f95d8cc6bfe99e7 | `QC1-T7/policy-shadow-state.txt` — policy.json shadow_mode true + live_workflows incl. meta.dm.reply (33 entries) |
| E-QC1-T7e | fef9ba7b5b333a91997364a089d306f41fb93b60a3c2b300d02583a26b17b15f | `QC1-T7/loaded-gateway-config.txt` — loaded openclaw.json plugin config matches policy; gateway/config freshness |
| E-F020-01 | 316d2d369f4172635565a253cdc57b1099805501b76248bdc668132e0259c5b4 | `F020-FIX/check-stack-worktree.log` — full check:stack in fix worktree @ ac06896, exit 0, 591 passes |
| E-F020-02 | 8913213d02b831c99cb66125c214f65d78bd59e336d14d6bf47d73d4d5e83d4d | `F020-FIX/release-check.log` — release:check exit 0 at merged main |
| E-F020-03 | b0e4f56de6b1f263328ccd14e52027f0ea698e65c31ba0ea6f7cc9efddf45cfe | `F020-FIX/release-deploy.log` — release:deploy exit 0, record 2026-08-15T21-39-17Z @ 2983ed0, 9/9 steps completed |
| E-F020-04 | 95138587c535b170d78386ff4c3924fee8df63e7769d429d5187c0755e5c04e9 | `F020-FIX/policy.json.pre-quarantine` — pre-change runtime policy copy (hash equals QC0-06 fingerprint) |
| E-F020-05 | 901fa4e51fbc3f5d62c31863872e7c8d9285210fd6ec1213590f8c0a4f662fb2 | `F020-FIX/validate-armed-refusal.log` — validate:openclaw-shadow exit 1 on still-armed patch: "refusing quarantined live workflow(s): meta.dm.reply (F-020)" |
| E-F020-06 | 059b499338234fef27355e805415a4ce4af85b2238e87bfab10b2df9fb0615f7 | `F020-FIX/validate-quarantined-pass.log` — validate exit 0 on quarantined patch (plugins inspect + doctor clean) |
| E-F020-07 | 85d39182b524f52841972949de0746ec5c55ad53365ff3e8a1891ad961cb1324 | `F020-FIX/apply-shadow.log` — apply exit 0; openclaw.json written with backup config-backups/openclaw.pre-socialsol-shadow.2026-08-15T21-41-55Z |
