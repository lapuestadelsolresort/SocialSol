# RO investigation — email auto-send state + OwnerRez mutation map

Session 17b, 2026-08-17 (PDT). Action class: RO + FIXTURE citations only. Owner
mid-session instruction: document current state, do NOT change production, do
NOT arm. Raw outputs: `~/qc-evidence/FIX2/ro-investigation-outputs.txt`
(E-FIX2-03). All code cited at deployed content `1dd627ed` (runtime configs read
from the production checkout; PR-#80-changed files read from the merged-content
worktree; unchanged files from the qc worktree — byte-identical at both SHAs).

**State at reading:** production clean `main` @ `1dd627ed` (deploy record
2026-08-17T17-58-54-930Z, completed 11/11, CI verify success). Runtime
`workflow/policy.json` sha `aa71f387…`, mtime Aug 17 08:29 — **untouched all
session; the arming policy change was never applied** (classifier-blocked, then
owner superseded with this RO instruction; the staged candidate file was
deleted). `autonomous_workflows` contains **neither** `email.reply.confirm`
**nor** `ownerrez.mutation.confirm`.

---

## A. Email auto-send — current state vs intended

| Surface | Intended (owner, 2026-08-17) | Current state | Verdict |
|---|---|---|---|
| Paulina cold outreach | auto-send ENABLED | ENABLED — `paulina.daily` in `live_workflows` AND `autonomous_workflows`; `prospector/state.json` `paused:false` | **MATCH** |
| Regina reactivation | auto-send ENABLED | ENABLED — `regina.daily` in both lists; `regina/config.json` `auto_send.enabled=true`, `send_method=resend` (mode 600) | **MATCH** |
| Sarah guest replies | DRAFT-AND-APPROVE, no auto-send path either provider | Human confirm required for every send: `email.reply.propose/confirm` live, **neither in `autonomous_workflows`** | **MATCH behaviorally** — one dormant, policy-gated dispatch path exists in code (deployed this morning pre-instruction, PR #80); it is provably inert. Disposition → D-019/F-057 |

### Config keys + the code that reads them

- **Paulina** — policy rows above are read by the worker per step
  (`workflowIsLive`/`stepExecutionDecision`; policy fresh each step).
  Module gates: `prospector/composer.js:363` refuses to compose unless
  `contact.email_status === 'verified'` (and `:576` bakes `email_status='verified'`
  into selection SQL); `prospector/orchestrator.js:486` honors
  `state.json.paused`; orchestrator re-verifies at send time (`:341-352`).
  Known open item on this surface: F-047 (P2, edit-override send-time carve-out;
  owner-confirmed P2, queued in the P2/P3 batch).
- **Regina** — `regina/scripts/anniversary-cron.js:112` and
  `regina/scripts/batch.js:161` read `cfg.auto_send?.enabled === true`;
  `regina/lib/dossier-context.js:18` carries the provenance hard rule
  (`airbnb_thread_only` can never become a direct email; WhatsApp-channel
  contacts resolve to `manual_whatsapp` drafts). Config comment matches D-001.
- **Sarah** — end-to-end send path (both providers), at `1dd627ed`:
  1. Inbound lands in `email_threads`; `email.message.observe` (autonomous,
     read/local-only) posts it to Slack with reply instructions. No send.
  2. `!email reply <text>` (human, #sarah-email or #prospector-paulina) →
     `email.reply.propose` — `allowedTriggers: ['slack_email_reply_command']`
     only (`crm/workflows/email-reply.js:329`); persists an immutable,
     non-expiring proposal. **Sends nothing.**
  3. `!email confirm <id> <hash>` (same human who proposed, same channel,
     non-expiring per D-011) → `email.reply.confirm` — same-user check,
     channel binding, acceptance hash, ONE durable effect
     (`proposalId:provider:send`), provider send, **Gmail Sent-label or
     OwnerRez message readback required**, projection, notice.

### Sarah no-bypass sweep (each checked, none can auto-send)

- **Dormant dispatch step (the one latent path, named):**
  `email.reply.propose` step `dispatch_confirmation` (`email-reply.js:418`) calls
  `crm/lib/auto-confirm-dispatch.js`, which runs `authorizationDecision` with
  `origin:'system'` (`:26-31`) — it starts the confirm graph **only if
  `email.reply.confirm` ∈ `autonomous_workflows`**. Live policy: absent →
  denial `autonomous_workflow_denied` → output stays
  `awaiting_explicit_confirmation`. FIXTURE-proven this morning ("un-armed
  policies keep the explicit confirmation contract": zero provider calls).
  Arming would require exactly the policy edit that was **not** applied.
- **Agent (Sol) cannot send:** the `resort_workflow` tool enum excludes every
  `email.reply.*` workflow, and `COMMAND_ONLY_WORKFLOWS` (plugin `:63-76`)
  makes the tool throw `workflow_command_required` for them (`:859`).
- **Server/system entrypoints:** `/execute` with system origin gets entrypoint
  `'system'` → trigger-forbidden for both propose and confirm (FIXTURE:
  trigger-gating test). Worker system ingress starts only
  `email.message.observe` (`workflow-worker.js queueEmailEvents`).
- **Sarah Coach:** `guest.reply.draft` (`local-records.js:442`) calls the voice
  service and reads back the drafts log — **no provider send call exists** in
  its graph.
- **Function-level sweep:** the only non-test callers of
  `sendGmailReply`/`sendOwnerRezMessage` are the confirm graph and the worker's
  service injection.
- **History:** 4 reply proposals ever — 3 gmail `completed` (human-confirmed),
  1 gmail `pending` (inert until a human confirms), 0 ownerrez.

---

## B. OwnerRez mutation map

### Shared pipeline — identical for all 34 operations

Every operation flows through ONE path; per-operation variance is only
method/path/readback (table below):

1. **Propose** — `ownerrez.mutation.propose` via the agent tool
   `resort_workflow` (entrypoint `model_tool`), reservations channel;
   slack-origin authorization requires channel capability `ownerrez.write` +
   actor in `restricted_capabilities['ownerrez.write'].users` (2-user
   allowlist). Preflight GET snapshot (before-hash + ETag) → immutable proposal
   row, **15-min expiry**, acceptance hash. Writes nothing to OwnerRez.
2. **Confirm** — `!ownerrez confirm <id> <hash>` in reservations
   (`allowedTriggers: ['slack_ownerrez_command', 'auto_confirm_dispatch']`):
   pending + not-expired + **same-user** + hash match + **fresh-precondition
   re-read** (before-hash/ETag must be unchanged, `ownerrez-mutation.js
   assertPrecondition`) → **execute-once** effect
   (`proposalId:ownerrez:execute-once`, `crashRecovery:'manual'`, engine treats
   `external_non_idempotent` lease loss as manual review — never auto-replayed)
   → **operation-specific readback** → proposal `completed` → notice to
   reservations + `write_notifications` mentions.
3. **Dormant auto-dispatch** — same PR-#80 step as Sarah's; gated on
   `ownerrez.mutation.confirm` ∈ `autonomous_workflows`; **currently absent →
   inert** (FIXTURE-proven both armed and un-armed).

**No escape hatch:** catalog header (`ownerrez-mutation-catalog.js:3-5`): "the
operation id is the capability boundary; callers cannot supply a method or
URL"; unknown operationId rejected (`:105`), unknown params rejected (`:88`),
paths resolved only from the operation's template (`:126`). Repo-wide, the only
write-capable callers of the OwnerRez client are the mutation graph (above) and
`sendOwnerRezMessage` (POST `/v2/messages`) inside the human-confirmed
`email.reply.confirm` — both gated; worker holds an injection reference only;
the messaging-scope verify script is GET-only. Fixed-catalog + no-arbitrary-URL
is also enforced by test ("catalog exposes all 34 fixed v2 writes and no
arbitrary URL").

**Usage history: ZERO proposals ever — this surface is production-unfired.**
All behavior below is code-traced + FIXTURE-verified; QC-9 is its first live
audit.

**Arming granularity (decision-shaping fact):** `autonomous_workflows` arms a
whole WORKFLOW. Arming `ownerrez.mutation.confirm` would put **all 34
operations** on autopilot at once. A per-operation autopilot matrix (the goal
stated for this map) needs a small extension — e.g. an
`autonomous_operations` allowlist checked against `operationId` inside the
dispatch step — which does not exist today.

### Operation table

Shared columns (identical for every row): **Defined** —
`crm/lib/ownerrez-mutation-catalog.js:29-86`. **Trigger/path** — agent tool
propose → human `!ownerrez confirm` (auto-dispatch dormant). **Actor** —
2-user `ownerrez.write` allowlist, reservations channel. **Gate** — proposal +
preflight snapshot / same-user confirm / 15-min expiry / fresh precondition /
execute-once / readback per row. **Ambiguous →** durable manual review (path
below). **Stuck-review alert** — yes, two paths (below).

| # | Operation | Method | Path | Readback mode |
|---|---|---|---|---|
| 1 | Bookings_Post | POST | /v2/bookings | created_entity |
| 2 | Bookings_Patch | PATCH | /v2/bookings/{id} | same_entity |
| 3 | Discounts_Post | POST | /v2/discounts | created_entity |
| 4 | Discounts_Patch | PATCH | /v2/discounts/{id} | same_entity |
| 5 | Discounts_Delete | DELETE | /v2/discounts/{id} | deleted_entity |
| 6 | FieldDefinitions_Post | POST | /v2/fielddefinitions | created_entity |
| 7 | FieldDefinitions_Patch | PATCH | /v2/fielddefinitions/{id} | same_entity |
| 8 | FieldDefinitions_Delete | DELETE | /v2/fielddefinitions/{id} | deleted_entity |
| 9 | Fields_Post | POST | /v2/fields | created_entity |
| 10 | Fields_Patch | PATCH | /v2/fields/{id} | same_entity |
| 11 | Fields_Delete | DELETE | /v2/fields/{id} | deleted_entity |
| 12 | Fields_ByDefinition | DELETE | /v2/fields/bydefinition | field_definition_absent |
| 13 | Guests_Post | POST | /v2/guests | created_entity |
| 14 | Guests_Patch | PATCH | /v2/guests/{id} | same_entity |
| 15 | Guests_Delete | DELETE | /v2/guests/{id} | deleted_entity |
| 16 | Guests_DeleteAddress | DELETE | /v2/guests/{id}/addresses/{address_id} | guest_child_absent |
| 17 | Guests_DeleteEmailAddress | DELETE | /v2/guests/{id}/emailaddresses/{email_address_id} | guest_child_absent |
| 18 | Guests_DeletePhone | DELETE | /v2/guests/{id}/phones/{phone_id} | guest_child_absent |
| 19 | Messages_Post | POST | /v2/messages | created_entity |
| 20 | Quotes_Post | POST | /v2/quotes | created_entity |
| 21 | Quotes_Patch | PATCH | /v2/quotes/{id} | same_entity |
| 22 | Quotes_Delete | DELETE | /v2/quotes/{id} | deleted_entity |
| 23 | SpotRates_Patch | PATCH | /v2/spotrates | response_collection |
| 24 | Surcharges_Post | POST | /v2/surcharges | created_entity |
| 25 | Surcharges_Patch | PATCH | /v2/surcharges/{id} | same_entity |
| 26 | Surcharges_Delete | DELETE | /v2/surcharges/{id} | deleted_entity |
| 27 | TagDefinitions_Post | POST | /v2/tagdefinitions | created_entity |
| 28 | TagDefinitions_Patch | PATCH | /v2/tagdefinitions/{id} | same_entity |
| 29 | TagDefinitions_Delete | DELETE | /v2/tagdefinitions/{id} | deleted_entity |
| 30 | Tags_Post | POST | /v2/tags | created_entity |
| 31 | Tags_Delete | DELETE | /v2/tags/{id} | deleted_entity |
| 32 | Tags_ByName | DELETE | /v2/tags/byname | tag_name_absent |
| 33 | WebhookSubscriptions_Post | POST | /v2/webhooksubscriptions | created_entity |
| 34 | WebhookSubscriptions_Delete | DELETE | /v2/webhooksubscriptions/{id} | deleted_entity |

DELETE rows (5, 8, 11, 12, 15–18, 22, 26, 29, 31, 32, 34) are flagged
`destructive: true` in the catalog — a ready-made axis for the per-operation
autopilot decision.

### Ambiguous / uncertain result → manual review

- `execute_once` catch (`ownerrez-mutation.js`): HTTP ≥500 or no status
  (timeout/socket) → proposal status `ambiguous`, error
  `ambiguous_external_result`, `retryable:false` — **never auto-retried**
  (FIXTURE: exactly one provider call). Engine (`workflow-engine.js:140-167`)
  then creates the durable review AND enqueues a Slack notice with the exact
  `!review resolve <id> sent|not-sent|abandon` instructions.
- **Channel-bound?** Yes. `reviewChannelId` prefers `run.channel_id`, and every
  `ownerrez.mutation.confirm` run carries the reservations-channel context
  (Slack command or tool; a channel-less system trigger is impossible —
  `'system'` is trigger-forbidden). **F-052's channel-less-run gap does not
  apply to this surface.** Post-D-017, `write_notifications.channel_ids` (2
  channels) are plugin-bound as additional permitted resolution venues.
- **Resolution:** `!review resolve …` intercepts in ANY policy channel
  (`controlledChannelIds = Object.keys(policy.channels)`, renderer `:254`), with
  the F-051 (i)+(ii) fixes (prefix strip + metadata unwrap) deployed; the server
  (`routes/workflows.js:140-151`) enforces resolver ∈
  `write_notifications.user_ids` (2 users) and channel ∈ {run channel, review
  channel, write_notifications channels}. Same atomic path + audit event as
  D-017's terminal fallback. Live Slack-path resolution verify remains F-051/
  F-052 closure work (QC-8 opener); F-051(iii) coalescing advisory still binds.

### Alerts (the F-052 question, answered per outcome)

- **(i) Succeeded:** immediate — synchronous Slack reply to the actor AND the
  in-graph `notify_humans` outbox notice to reservations with
  `write_notifications` user mentions.
- **(ii) Failed:** immediate synchronous reply ("Not changed …"); the failed run
  also increments `failed_24h` (`workflow_health.py:225` — counts ALL failed
  runs, not just scheduled graphs) → hard-failure → **edge-triggered Slack
  incident alert within ≤300s** (`notify_incident_once`, launchd job
  `com.lapuestadelsolresort.workflow-health`, StartInterval 300, verified live
  QC6-06).
- **(iii) Sitting unresolved in review:** Jason finds out without looking, via
  two independent paths — the creation-time notice in reservations (engine
  outbox) and `open_manual_reviews` (`workflow_health.py:210`) tripping the
  same ≤300s incident alert. Additionally every further
  `ownerrez.mutation.confirm` run is 409-blocked (`workflow_manual_review_open`,
  store-level) until resolution — the surface fails closed. Caveat (existing
  F-033-family behavior): the incident alert is edge-triggered once per
  incident window; while one incident is active, an additional concurrent issue
  does not re-alert until the first clears.

---

## Dispositions queued from this investigation

- **D-019 (OPEN, owner):** per-operation OwnerRez autopilot matrix (the 34 rows
  above; `destructive` flag is a natural axis) + whether Sarah's dormant
  dispatch step stays (as the arming mechanism for whatever is granted) or is
  reverted via the release path + whether the superseded D-018 email canary
  stays cancelled. Note: per-operation arming needs the small
  `autonomous_operations` extension — currently arming is per-workflow only.
- **F-057 (P3):** deployed dormant auto-confirm capability exceeds the
  owner's superseding draft-and-approve intent for Sarah — inert, policy-gated,
  regression-tested; disposition rides D-019.
- **F-056 (P3):** `social.publish_due` starts child `social.content.publish`
  graphs without a `policySnapshot` — under worker policy enforcement the
  child's external steps would be blocked as
  `external_effect_not_authorized_at_creation` (fail-closed latent defect;
  production-unfired — social_content has 0 rows ever). Found while designing
  the dispatch step (which passes a snapshot for exactly this reason).
