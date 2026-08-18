# QC status

Updated: 2026-08-18 (PDT) — session 23 (**QC-8a: WhatsApp `!wa` send-gate
invariant battery + Meta inbound-webhook probes**). RO/FIXTURE session, no
release-path work, runtime baseline UNCHANGED at `b7f2690`, policy sha `0dd75080`
(fingerprint `match` + `agreement: ok`, verified at start ritual).

**Delivered:** (1) the D-001 WhatsApp invariant proven by attempted violation —
14 fixture cases, all refused with zero Twilio calls / zero queued runs, at the
deployed SHA (QC8-01); (2) durable-ledger sweep — the human-`!wa` invariant
holds across every send in system history (1 send ever, actor+channel bound;
0 `whatsapp.send` effects outside `whatsapp.reply`) (QC8-02); (3) **QC2B-10
CLOSED** — Meta inbound-webhook mounted-route auth probes all pass (GET
handshake, POST HMAC, fail-closed) against the real server on loopback:3999
(QC8-03); (4) F-051 ledger corroboration recorded honestly (QC8-04).

**⚠️ SELF-DISCLOSED INCIDENT (QC8-INC-01):** a broad `pkill -f "crm/server.js"`
during fixture teardown SIGTERM'd BOTH production servers on this host (SocialSol
crm 3456 + goldroute co-tenant 3458) — an unauthorized OUTAGE-class action in an
RO/FIXTURE session. launchd KeepAlive auto-recovered both within ~1-3s (lstart
06:32:33 PDT). Containment verified clean: CRM+goldroute DB `integrity_check` ok,
0 workflow runs stuck, workflow-worker untouched (pattern didn't match its
filename → no in-flight workflow disrupted), 0 durable impact, no send/mutation.
Corrective rule now standing (see method notes). Owner disclosure below.

**F-024 was closed by NOT doing what the finding said** (plan §2 — reality wins,
owner-ratified in the D-025 addendum). The recorded fix — remove
`email.message.observe` from `autonomous_workflows` — would have halted all
inbound email processing: the worker system-queues one observe run per inbound
email and that policy entry is its only authorization; the worker log still
carries the historical `email-ingress subsystem failed: autonomous_workflow_denied`
fossil from when the grant was once missing. What landed instead: the definition
declares `autonomous: true`, and a policy↔registry agreement invariant now
refuses UNACCOUNTED grants — a grant is accounted iff the definition declares
autonomy or accepts `auto_confirm_dispatch` (so the D-019 arming procedure works
unchanged) — enforced at every system-origin authorization site, refused at
`policy-fingerprint record`, reported exit-1 by `check`, and visible in
`release:check` as `policyFingerprint.agreement`. The negative probe was proven
to fail (isolated violating copy → exit 1 naming the workflow) with the real
policy untouched. **No runtime policy edit happened; policy sha remains
`0dd75080` (D-020 armed state), fingerprint `match` + `agreement: ok`.**

**`!help` is now grouped (F-062, D-024 Option A):** "Workflows you can ask for in
this channel" vs "Workflows that run on their own (webhooks, schedules, armed
policy)" plus the explanatory capability line. Verified at the deployed SHA
against live policy through the deployed renderer: same 19 social-channel rows,
live-marked set == `live_workflows` exactly in both directions (13) — the
QCF058-03 assertion holds across the regrouping.

**The rest of the batch:** QBO callback validates realm/code shape before the
token exchange and escapes its render (F-027); `npm audit --omit=dev` is 0
vulnerabilities at the deployed SHA (F-026); CRM backup retention is date-based
so deploy bursts can't evict days of depth (F-034c); real bank statements live
in `accounting/statements/` with export-dated names (F-038); the dead FX
spot-rate path is gone from code, README, and runtime config (F-037); secrets
modes are 26/26 at 600 and the served tracker.js.bak is untracked (F-028); the
0-byte stray DB is gone (F-030); the 1.8 GB legacy `workspace-resort` tree is
archived (1.01 GB tar.gz, mode 600, sha ea03a87d…) and deleted (F-021). F-034(b)
remote-Drive duplicates/retention is the batch's one accepted-risk row (owner).

**One honest wobble, recorded in QCP3-04:** the F-038 renames briefly made the
production checkout dirty (`accounting/*.csv` doesn't cover subdirs) and
`release:check` refused to proceed — the control worked as designed; the
one-line `.gitignore` entry rode PR #90 before the deploy.

## Phase ledger — QC-0…QC-7 COMPLETE + fix sessions #1/#2(17)/#3(F-001)/#4(F-014)/#5(P2/P3 batch)/#6(F-058)/#7(P3 hygiene batch) COMPLETE + **QC-8a IN PROGRESS** (WhatsApp send-gate battery + Meta webhook probes done; Sarah Email / Meta DM re-verify / Sarah Coach / F-051(iii) + F-052 live-path = QC-8b) (runtime baseline b7f2690; prod main b7f2690; policy sha 0dd75080 ARMED: marketing campaign_activate per-op only — unchanged this session, fingerprint `match` + agreement `ok`)

## ⚠️ Standing advisory (until F-051(iii) dispositioned)

**Exact Slack commands (`!wa`, `!email confirm`, `!review resolve`, `!receipt
confirm`, `!meta confirm`, `!ownerrez confirm`) can be silently swallowed if
typed while the channel's agent (Sol) is mid-reply** — the gateway coalesces
them into the next message's history and no interception fires. Until verified
fixed: type commands top-level, unmentioned, in a quiet moment; if the bot
doesn't acknowledge within ~30s, the command did NOT execute — check before
retyping mutation commands. (The interception path itself is proven working:
owner-typed `!help` claimed and replied at 15a41d6, QCF058-05. The remaining
risk is (iii) coalescing only. Ledger corroboration deferred to QC-8.)

## Owner follow-ups

**⚠️ DISCLOSURE — new this session (QC-8a):**

0. **I briefly restarted your production CRM server (and the goldroute co-tenant)
   by mistake.** During QC fixture cleanup I used a too-broad process-kill
   (`pkill -f "crm/server.js"`) that matched both live servers on the host, not
   just my throwaway test server. Both were down for ~1-3 seconds at 06:32:33
   PDT and launchd automatically brought them back. I verified afterward: both
   databases pass integrity checks, no in-flight work was lost (the workflow
   worker was never touched), and nothing was sent or written. Net effect: a
   couple-second blip that inbound providers retry through. It was not an
   authorized action for a read-only session; I've recorded it in full
   (QC8-INC-01) and adopted a standing rule to only ever kill test servers by
   their exact process id. Nothing is needed from you — flagging it because you
   should know any time production is touched.

**New earlier (P3 batch):**

1. **F-024 ended up needing no action from you** — the "remove the grant" step
   you approved became void once the trace showed the grant powers inbound
   email; you ratified the corrected fix in-session (D-025 addendum). The
   invariant now guards the policy: a hand-added autonomy grant for a workflow
   the registry doesn't account for makes `policy-fingerprint check` (and
   `release:check`) go red and is refused at every system-origin authorization
   site.
2. **The pre-scrub git bundle survives at mode 600** (your call). Delete
   `~/.openclaw/SocialSol/backups/git-pre-scrub-20260811.bundle` whenever you
   decide pre-scrub history no longer needs to exist.
3. **`workspace-resort` is gone; its archive is**
   `~/.openclaw/backups/workspace-resort-archive-20260817.tar.gz` (1.01 GB,
   mode 600). Restore = untar; delete the archive whenever you're done with it.
4. **Remote Drive backup duplicates/retention: accepted as-is** (your call,
   recorded in F-034). Revisit only if the folder ever matters for quota.
5. **Bank statements now live in `accounting/statements/`** with export-dated
   names (`kapital-2026-06.csv`, …, `kapital-2026-08-export-0813.csv`). Drop
   future exports there with the same convention; the dir is gitignored.

**Still open from earlier sessions (unchanged):**

1. **Weekly accounting control is legitimately red until F-061 is worked** (1
   never-ingested receipt, 4 possible duplicate bookings; allowlist procedure in
   accounting/README.md). Next fire: Monday 2026-08-24 08:00 PT.
2. **Campaign approvals**: record per-brief approvals to make anything
   auto-activatable (`automation/campaign_approval.py … record --apply`);
   planner receipt still needs its re-record; F-059 disposition (retarget
   targeting, weddings declared-status) still pending.
3. **Policy fingerprint discipline**: after any hand edit of
   `workflow/policy.json`, finish with
   `node scripts/policy-fingerprint.js record --note "<why>"`. `record` now
   also refuses grants the registry doesn't account for.
4. **Un-arm marketing activation anytime**: restore
   `~/qc-evidence/F001-FIX/policy-pre-arming-20260817T201341Z.json` over
   `workflow/policy.json` (atomic mode-600), then re-record the fingerprint.

## Blockers

None. Open D-rows: D-004 (blackout windows — load-bearing at QC-6c/QC-10),
D-007 (accounting validator), D-010 (CI scope confirm).

Open P1s: **F-051 only** ((iii) coalescing disposition + live mutation-path
corroboration remain — QC-8b; QC8-04 refined the corroboration status this
session). QC-8a's WhatsApp send-gate leg surfaced NO new finding — the D-001
invariant holds by attempted violation and across all durable history.
Open P2s: F-013 (gated on F-031 drill), F-023, F-025, F-006, F-029, F-033,
F-035 (remainder), F-036 (three writers remain), F-040, F-044, F-052
(**engine half closed; live Slack-path verification rides QC-8b**), F-059,
F-061.
Open P3s: F-019 (**threshold closed; browser page-JS leg is QC-6c CANARY**)
— and nothing else.
Closed this session: **QC2B-10** (Meta inbound-webhook mounted-route probes —
was OPEN owner-assigned-to-QC-8; now PASS, QC8-03).
Housekeeping: `~/fix-worktree` carries `fix/p3-statements-gitignore` (merged,
removable); 1 pending gmail email_reply_proposal exists (inert); the goldroute
`crm/server.js` (port 3458) remains out-of-scope (but shares this host — see the
QC8-INC-01 lesson on process-kill blast radius).

## Next

**(1) QC-8b — Sarah Email, Meta DM quarantine re-verify, Sarah Coach, +
F-051(iii)/F-052 live legs.** QC-8a closed the WhatsApp send-gate invariant
battery (QC8-01/02), the Meta inbound-webhook probes (QC8-03, QC2B-10 CLOSED),
and the F-051 ledger-corroboration status (QC8-04). Remaining QC-8 legs:
  - **Sarah Email** — audit the standing DRAFT-AND-APPROVE config per D-019
    (whole `email.reply` surface, both providers; auto-send mechanism is dormant
    + policy-gated, must stay so): one Slack root per provider conversation,
    conservative CRM inquiry logic, immutable proposal + same-user confirm,
    execute-once, Gmail-Sent/OwnerRez readback, retry-without-second-send, mailbox
    reads never mark read. FIXTURE-class.
  - **Meta DM quarantine re-verify** — `!help` renders `meta.dm.reply` as
    quarantined/refused; re-verify the surface at the deployed SHA (F-020 residual).
  - **Sarah Coach** — suggestion-only; voice-corpus retrieval works; prove NO
    send path exists; outcome/edit capture correct.
  - **F-051(iii)** — OWNER decision needed (document operator "quiet-moment"
    guidance vs upstream gateway fix); plus a LIVE mutation-class exact-command
    success (`!wa`/`!email confirm`/`!receipt confirm`/`!review resolve`) to
    corroborate interception in the durable ledger — none exists post-fix yet
    (QC8-04). Needs a quiet-channel live command (owner-typed) or an approved canary.
  - **F-052** — live Slack-path manual-review resolution verification (engine
    half already closed).

**Then:** (2) QC-6c CANARY (D-004 first — still unanswered and load-bearing).
(3) F-031 drill slot (D-006 window; F-013 gated on it). (4) **QC-9** (OwnerRez +
Paloma) — the RO map is the audit target; all 34 mutations confirmation-gated
per D-019.

Definition-of-Done #3 note: F-051 remains the only open P1. The F-031 drill must
still run before baseline stamps.

**Exact next command** (start ritual, §8):

```
git -C ~/.openclaw/SocialSol status
```

Expected: clean `main` @ b7f2690 (runtime baseline b7f2690cef37; newest deploy
record 2026-08-18T04-30-14-757Z completed 11/11; policy sha 0dd75080 ARMED
marketing-activate-only per D-020 — unchanged, standing state;
`node scripts/policy-fingerprint.js check` should print `match` with
`agreement: ok`). Then `cd ~/qc-worktree`, read qc/STATUS.md, and open QC-8b
with the plan §9 QC-8 section. Sarah Email / Sarah Coach / Meta DM re-verify are
FIXTURE/RO; state the Authorizations line for anything beyond RO/FIXTURE — the
F-051(iii) live command and F-052 live-path both need a live Slack action (owner
authorization + a quiet-channel plan), and any production webhook negative test
needs its own approved zero-side-effect plan (plan §7/QC-2).

**⚠️ Standing QC-executor rule (QC8-INC-01, this session):** never terminate
processes with a broad `pkill -f "<substring>"`. On this host `crm/server.js`
is a substring of BOTH production servers' command lines. Kill FIXTURE servers
ONLY by exact recorded PID (`echo $! > pidfile` at launch → `kill "$(cat
pidfile)"`), and give fixture processes a marker that cannot collide with
production (e.g. a unique `--title`/env tag, or bind an obviously-non-prod port
and match on that). When a fixture server lingers, look up its exact PID by port
(`lsof -nP -iTCP:<port>`), never by a shared script name.

Method notes worth keeping (session 23):

- **A broad `pkill -f` is an OUTAGE weapon.** The fixture teardown pattern
  `crm/server.js` matched both production servers (SocialSol + goldroute
  co-tenant, F-023). launchd KeepAlive is why it was a 1-3s blip and not a
  page-out — the compensating control did its job — but the plan is explicit
  (§1) that OUTAGE actions need authorization I did not have. Recorded honestly
  (QC8-INC-01), not buried. The habit that would have prevented it: kill by PID,
  never by shared name.
- **The send-gate story is a defense-in-depth stack, and each layer refuses on
  its own.** The `!wa` battery proves it: parser anchor (`^!wa`), channel-scoped
  `whatsapp.send` capability, restricted-actor identity, `allowedTriggers`
  command-only, `COMMAND_ONLY_WORKFLOWS` model-tool refusal, shadow gate, and
  the F-024 agreement invariant on the system-origin path — a spoof has to beat
  all of them, and the fixture cases show each one saying no independently.
- **The durable ledger tells the truth about what "verified live" means.** F-051
  looked one disposition from closed, but the ledger showed the met live
  positive was `!help` — a read that never creates a run — so a real
  mutation-class command still has zero post-fix corroboration. "A green Slack
  reply is not evidence" (plan §7) cuts here too: `!help` replying proves the
  claim path fires for reads, not that a guest-affecting command was intercepted.

Prior method notes (session 22):

- **A finding can be exactly backwards.** F-024 called the grant "latent, no
  effect today"; the trace showed it load-bearing for all inbound email, and
  the worker log still holds the outage fossil from when it was missing. The
  fix inverted (declare + validate instead of remove) with owner ratification
  before any change. Fourth consecutive session where reading current code
  changed a finding's disposition — the habit is load-bearing.
- **Put the invariant where the grant is exercised, not where the process
  boots.** A boot-refusing validator would crash-loop every workflow over one
  bad grant; the per-site guard denies exactly the unaccounted grant, the
  fingerprint gate refuses to bless it, and release:check surfaces it — same
  invariant, three honest enforcement points, no new blast radius.
- **The registry already had an autonomy vocabulary** — `autonomous: true` and
  the `auto_confirm_dispatch` trigger. The invariant reused it instead of
  inventing a parallel declaration, which is why the D-019 arming procedure
  needs no change and the docs regenerated with one honest new cell.
- **`release:check` refusing the dirty checkout mid-session was the system
  passing a test nobody scheduled.** The F-038 renames tripped it; the fix was
  one ignore line through its own PR, and the refusal is recorded as evidence
  the guard works (QCP3-04), not as an embarrassment to bury.
