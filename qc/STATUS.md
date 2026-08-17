# QC status

Updated: 2026-08-17 (PDT) — session 16. **Fix session #1 (service-layer bundle) COMPLETE — with an emergent P1 discovered and largely fixed in-session.** Rows QCFS1-01…10; evidence E-FIX1-01…22. **Runtime baseline MOVED: 2983ed0 → `0af5583`** (first code deploy of the QC program; deployment record 2026-08-17T16-12-45Z, completed 11/11; prod main == runtime baseline == 0af5583 via PRs #77/#78/#79, CI verify green ×3, owner-run merges after classifier blocks, ancestry + incoming-files proofs each ff).

**Bundle delivered (F-016/F-041/F-015/D-012/F-035c/D-009/F-032):** repo service manifest (48 loaded/1 disabled/6 retired) + manifest-driven `install:launchagents` (plan/check/apply) as the single sanctioned install path; deploy runs install + convergence steps; watchdog EXPECTED + loaded-set resurrection detection from the same manifest; six legacy producers retired reboot-durably (plists removed + launchd-disabled + templates deleted) → **F-041 standing advisory RETIRED**; kapital-tests + qbo-keepalive adopted byte-faithful; paloma trio installed (D-012); media-pair symlinks replaced; NODE_BIN → stable /opt/homebrew/bin/node; daily-tests FIXED (live: exit 0, 436 tests) + media-rescan FIXED (live: exit 0) + tracker-liveness delivery-evidence semantics (live: honest capture alert; threshold tune → F-019 P3); auto-organic-ig-post cron RETIRED (enabled:false gateway+disk); #qc-scratch + housekeeper channels in policy (D-016; bizevent→business-intel, housekeeping→#housekeeper corrections applied by converge); nightly `state-backup` producer LIVE (tasks.db+policy+openclaw.json encrypted, offsited — first artifact verified; F-032a/b closed; RPO ∞→≤24h) + weekly `media-backup-verify` control LIVE (grace till 2026-09-21; owner attested offline copy, D-016); warmup accepted-loss (D-016). F-031 owner-side escrow COMPLETE (both keys off-host, D-016) — drill closure remains.

**Emergent P1 (F-051): gateway exact-command interception outage since ~08-15** — every `^!`-anchored Slack command (`!wa`, `!email confirm`, `!receipt confirm`, `!meta confirm`, `!review resolve`) silently dead (fail-closed) while keyword handlers survived. Found via five failed attempts to resolve the first-ever channel-less manual review (itself created by the deploy npm-ci race, F-053). Fixed in-session: channel-id prefix normalization (PR #78) + metadata-wrap command parsing (PR #79) + review channels made plugin-bound (renderer + policy, D-017). **Still open:** (iii) agent-turn event coalescing can swallow commands typed while the channel's agent is mid-run — live exact-command verification pending (QC-8 opener); F-052 notice fallback for channel-less runs. Review resolved owner-directed via the server endpoint (D-017, E-FIX1-19); paulina.daily unpaused (16:16 tick completed). Collateral PASS: the controlled-channel tool guard held under live adversarial pressure — every agent tool attempt denied across 3 sessions (QCFS1-07); Sol's hazardous improvisations recorded (F-054).

Authorizations session 16: BUSINESS (release path) + OUTAGE (launchctl bootout/bootstrap; operator Jason; window now; rollback/abort criteria stated in-session pre-action) scoped to fix session #1 — owner extended scope in-session to the F-051 fixes (D-017). All merges owner-run (classifier); everything else agent-run.

## Phase ledger — QC-0…QC-7 COMPLETE + fix session #1 COMPLETE (runtime baseline 0af5583; prod main 0af5583)

## ⚠️ Standing advisory (until F-039 fixed)

**Do not re-post pre-August (June/July) Kapital statement CSVs to the accounting Slack channel.** The live pipeline stages and processes automatically and would create ~60 duplicate standalone fee Purchases (~9.50 USD for July; June similar). August-onward statements are fine (new format, full dedup).

## ⚠️ Standing advisory (until F-051(iii) dispositioned)

**Exact Slack commands (`!wa`, `!email confirm`, `!review resolve`, `!receipt confirm`, `!meta confirm`) can be silently swallowed if typed while the channel's agent (Sol) is mid-reply** — the gateway coalesces them into the next message's history and no interception fires. Until verified fixed: type commands top-level, unmentioned, in a quiet moment; if the bot doesn't acknowledge within ~30s, the command did NOT execute — check before retyping mutation commands.

## Blockers

None for the next sessions. Open D-rows: D-004 (blackout windows — load-bearing at QC-6c/QC-10), D-007 (accounting validator), D-010 (CI scope confirm).

Open P1s: F-001 (invariant-first fix session), F-014, **F-051 (fixes deployed 0af5583; live exact-command verify + coalescing disposition remain)**. Open P2s: F-013 (gated on F-031 drill), F-023 (residual dispositions), F-025, F-006, F-029, F-033, F-035 (remainder: cron-layer manifest rows, paloma-monitor ratification, error alerting), F-036, F-039, F-040, F-045, F-044, F-047, **F-052 (notice fallback + Slack-path verify)**. Open P3s: F-024, F-026, F-021, F-027, F-028, F-030, F-034, F-037, F-038, F-042, F-043, F-019 (threshold tune + QC-6c browser leg), F-046, F-048, F-049, F-050, F-032(c) residual, **F-053 (npm-ci race), F-054 (agent guidance hazards), F-055 (policy drift check)**. CLOSED this session: **F-016, F-041, F-015 (verified-fixed at 0af5583)**; **F-032 resolved** ((a)(b)(e) live, (d) accepted-risk); F-031 owner-side escrow complete (drill remains); F-035(c) executed; F-017 substantially resolved via daily-tests rewrite.

## Next

**(1) Sarah/OwnerRez arming fix session** (owner-agreed sequencing): Sarah auto-send both providers + OwnerRez mutation autopilot per D-001 grants — config/release path, fix-before-audit so QC-8/QC-9 audit final config. Requires BUSINESS. Start-of-session: confirm F-051 quiet-channel command behavior if any interim Slack commands were attempted.

**Then:** (2) F-001 session (creative/landing-review invariant + regression + F-045 briefs, then Meta autonomous-activation arming). (3) F-014 rebuild + **P2/P3 batch** (now incl. F-052 notice fallback, F-053 npm-ci race, F-054 overlay hardening, F-055 policy drift check, F-019 threshold, F-047, F-048/49/50, F-032(c), F-042/43/46, F-039). (4) **QC-6c CANARY** (browser funnel leg + test-phone WhatsApp leg per D-009; D-004 first). (5) **F-031 drill slot**: owner escrow actions are DONE (D-016) — the D-006-window escrow-retrieval drill (+ optional archive re-encrypt) can now be scheduled any weekday 10:00–16:00 PT; at latest inside QC-10. F-013 stays gated on it. (6) **QC-8** — OPEN with the F-051 live verification: the `!wa` fixture battery doubles as the exact-command interception proof (quiet channel, per the standing advisory); then Sarah email, Meta DM quarantine re-verify, Sarah Coach. (7) **QC-9** (OwnerRez + Paloma — trio now installed and schedulable). Definition-of-Done #3 note: F-051 must reach verified-fixed (or accepted-risk with the advisory) before baseline stamps; F-031 drill likewise.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ 0af5583 (runtime baseline 0af5583; newest deploy record 2026-08-17T16-12-45Z completed). Then `cd ~/qc-worktree`, read qc/STATUS.md + D-001 arming rows (Sarah replies, OwnerRez mutations) + FINDINGS F-051/F-052, and begin the Sarah/OwnerRez arming fix session with BUSINESS authorization stated on the Authorizations line. The qc branch rides ahead (boundary-record + queue addendum + session-16 commit) for the next boundary PR.
