# Prospector Library — editor's note

This directory is the **persona strategy library** that the composer (Step 3.2) reads at email-generation time. It is **not** a template store. It is **not** a fill-in-the-blank merge system. It is a per-persona substrate of (a) strategy, (b) hard constraints, and (c) ground-truth example emails. The composer reads this substrate and writes original prose every time. There are no merge fields anywhere in `library/` — no double-curly placeholder syntax, no Mustache or Handlebars idioms, no rotation through stored variants.

If you find yourself reaching for one of those patterns, stop — you are working in the old "6 subject + 4 body variants" model that Step 2.2 deliberately moved away from. Diversity is enforced by the composer reading the last N entries from `recent-sends.jsonl` and being instructed to make the new email meaningfully different.

---

## For humans (Sarah, Jason)

**Don't edit files in this directory directly.** Give Paulina feedback in `#prospector-paulina` and she'll commit the edit on your behalf, with a link back to your Slack thread in the commit message. Reasons:

- Git is the versioning story. Every edit you would have made by hand is captured as a commit by Paulina. `git log` shows exactly who said what and when. Direct edits bypass the trail.
- Paulina knows the constraints (which sections are gated by Sarah review, which paths are cross-referenced from `slack-interaction.md`, which YAML keys the compliance gate reads). Direct edits skip all of that.
- Both of you can read the files freely. The convention is **read-only by humans, write-only via Paulina-via-Slack**.

How to give feedback: post a message in `#prospector-paulina` referencing the file or example and what you'd change. Examples that work well:

- "@paulina the wedding-planner closer in example 03 is a touch pushy — please soften."
- "@paulina add a 6th wedding-planner example with a hook about Mexico-based planners."
- "@paulina drop the 'long-game decision' line in example 03 — sounds VC-y."

Paulina translates the feedback into an edit + commit + Slack reply with the commit link.

## For Paulina (the agent)

When you incorporate feedback from `#prospector-paulina`:

1. Identify the file or example to update.
2. Make the edit. Run any local checks if applicable (`jq` on JSON, the verification one-liner below).
3. Commit with a message of the form:
   ```
   voice: <persona> — <one-line summary> (slack: <permalink>)
   ```
   For shared-file edits use `library:` instead of `voice:`. For cross-cutting changes use `chore:`.
4. Push to `origin/main` (or push to a topic branch + open a PR if branch protection is enabled — check `git remote -v` and the repo settings).
5. Reply in the Slack thread with the commit link.

The first time a persona's `library_status` flips from `draft` to `sarah-reviewed`, commit that as its own commit with message `voice: <persona> — Sarah-reviewed, library_status flipped to sarah-reviewed (slack: <permalink>)`. The composer reads that field and refuses to send for `draft` personas.

---

## Integration contract for Step 3.2 (the composer)

Step 3.2 ships the composer as of 2026-05-06 — see `prospector/composer.js` and the implementation plan at `~/.claude/plans/prospector-paulina-compressed-summit.md`. The composer reads this library at every email-generation call. The contract:

1. **Composer is invoked** with `(persona_id, contact_id, campaign_id)`.
2. **Composer loads the persona file** from `library/personas/<persona_id>.md`. If `library_status: draft`, the composer refuses and surfaces the block to Slack: `❌ Cannot compose — persona <persona_id> is library_status: draft. Sarah review required first.`
3. **Composer loads all examples** from `library/examples/<persona_id>/` where `library_status: sarah-reviewed` is set on the persona file. While the persona is `draft`, examples are read for grounding context but composition is blocked at step 2 above.
4. **Composer loads shared constraints**: `library/shared/constraints.json`, `library/shared/cta-variants.md`, `library/shared/compliance-elements.md`, `library/shared/banned-phrases.md`.
5. **Composer loads the last N entries** from `library/recent-sends.jsonl` where N comes from `constraints.json` `diversity.recent_sends_window` (currently 25).
6. **Composer loads contact enrichment data** from the CRM (`outreach_contacts` row + any joined enrichment tables).
7. **Composer prompts the LLM** with: voice-spec.md §4 constraint header + persona strategy + examples + shared constraints + recent-sends + enrichment, and asks for a JSON object `{subject, body, hook_angle}`.
8. **Compliance gate (Step 3.1) validates** the output against `constraints.json` (length, subject shape, required elements, max_links) + `banned-phrases.md` substring check + `compliance-elements.md` element checks.
9. **If pass:** the composer posts a draft to `#prospector-paulina` per `slack-interaction.md` §5.1 with approve/edit/reject buttons.
10. **On approve + send:** the orchestrator (`prospector/orchestrator.js`, Step 3.3) writes a new line to `recent-sends.jsonl` with the schema documented in §"recent-sends.jsonl schema" below. (Replaces `send.sh` as of 2026-05-06; see the deprecation notice in `send.sh`'s header for the sunset cadence.)

### `recent-sends.jsonl` schema

Each line is one JSON object. Keys:

| Key | Type | Notes |
|---|---|---|
| `sent_at` | ISO 8601 UTC string | when the send completed |
| `persona` | string | matches `persona_id` in `library/personas/` |
| `contact_id` | string | CRM contact-row id |
| `subject` | string | the actual subject line that went out |
| `opener_first_sentence` | string | the first sentence of the body (used by composer for diversity check) |
| `hook_angle` | string | matches one of the persona file's hook angles |
| `outreach_send_id` | string | CRM send-row id |

Example line:

```json
{"sent_at":"2026-05-21T14:32:11Z","persona":"wedding-planner","contact_id":"ct_abc123","subject":"Puesta del Sol — for a CA destination buyout","opener_first_sentence":"Your Sausalito-to-Pescadero portfolio came up...","hook_angle":"shared-region","outreach_send_id":"os_xyz789"}
```

The composer at generation time reads the last `recent_sends_window` entries (25 currently) and tells the LLM "make the new email meaningfully different from these recent sends, particularly in opener phrasing and hook angle." `constraints.json` `diversity.max_opener_token_overlap` (currently 0.4) is the threshold the compliance gate enforces on opener-token Jaccard overlap with the last N opener_first_sentences.

**Rotation TODO (Step 3.x):** `recent-sends.jsonl` will grow without bound. Strategy is gzip + quarterly roll: at quarter boundaries, gzip the existing file to `recent-sends-YYYYQN.jsonl.gz` and start a fresh empty `recent-sends.jsonl`. Composer reads only the live file. Historical files stay around for analytics / drift detection.

---

## Sarah feedback loop (the operator-facing flow)

How a comment in Slack becomes a library change, end to end:

1. **Sarah comments** on a draft in `#prospector-paulina`: "this opener is too pushy."
2. **Paulina reads the feedback** in-thread, identifies the right file to edit (a persona file, a shared file, or a specific example), and makes the edit.
3. **Paulina commits** with a message of the form:
   ```
   voice: wedding-planner — soften opener guidance (slack: <permalink-to-Sarah's-thread>)
   ```
4. **Paulina pushes** to `origin/main`. (If branch protection requires a PR, Paulina opens the PR and posts the PR link in the Slack thread instead of a commit link.)
5. **Paulina replies in the Slack thread** with the commit (or PR) link.

**For paths that change the persona's `library_status`:** Sarah's approval is the gate. When she signs off on a persona's example set, Paulina flips `library_status: draft` → `library_status: sarah-reviewed` in the persona file's front matter and commits that as its own commit.

---

## How to verify (acceptance check one-liner)

```bash
# template-syntax canary — must return empty
grep -rE '\{\{|\}\}' prospector/library/

# constraints.json valid JSON
jq . prospector/library/shared/constraints.json >/dev/null

# recent-sends.jsonl exists, may be empty
test -f prospector/library/recent-sends.jsonl
```

If the canary returns lines, the strategy library has drifted into template territory — fix immediately. The whole point of Step 2.2 is that there are no merge fields here.

---

## What this is NOT

- **Not a template store.** No subject-line variants, no body variants, no merge fields. The word "template" appears only in this README to explain what this is not. The lone exception is structural-shape scaffolding for new persona files (see `library/personas/_template.md` if/when one is added) — that's a blueprint for new persona-file authoring, not an email-content template.
- **Not a fill-in-the-blank system.** No placeholder syntax of any kind. Examples are voice anchors; the composer writes fresh prose every time.
- **Not human-edited.** Humans give feedback in Slack. Paulina commits.
- **Not multi-language.** English only.
- **Not a substitute for `voice-spec.md`.** Voice is the source of truth for tone; this library is the source of truth for per-persona strategy and ground-truth examples. They overlap on intent but live in separate files.

---

## Related files

- `prospector/voice-spec.md` — Sarah's voice, persona-agnostic. The composer reads §4 (constraint summary) at the top of every prompt.
- `prospector/config.json` — sender identity, physical address, opt-out target, Slack channel. Source of truth for compliance values.
- `prospector/slack-interaction.md` — Slack-side spec for `!new-campaign`, `!provision-landing`, draft-review buttons, reply notifications. Step 3.2 implements; this library is consumed by that flow.
- `prospector/COMMANDS.md` — existing live commands (`!add-contact`, `!dnc`, `!pause`, `!resume`).
