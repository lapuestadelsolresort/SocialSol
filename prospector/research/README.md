# Prospector research pipeline

Brave Search → fetch → Claude extract → CRM dedup → bulk-import. Produces persona-tagged contact rows in the CRM `contacts` table for the composer (Step 3.2) to read later.

## Architectural rule

> **Research can auto-import because composing requires approval.** The approval gate lives where the irreversible action does — in Step 3.2's compose-and-send. If 3.2 ever ships with auto-send, research has to gain a gate.

DB writes here are reversible (see "Reverting a run" below). Real-inbox sends are not. Don't move the gate.

## Run the pipeline

```bash
cd "$SOCIALSOL_ROOT/prospector/research"
npm install   # first time only

# One persona, full pipeline (search → fetch → extract → dedup → import)
node scripts/run-research.js --persona wedding_planner

# All four personas (~16 queries; well within Brave free-tier rate limits)
node scripts/run-research.js --persona all

# Dry run — does everything except the bulk-import POST and the Slack post
node scripts/run-research.js --persona wedding_planner --dry-run
```

Output lands in `runs/<YYYY-MM-DD>/`:
- `01-searches.jsonl` — Brave SERP results, post-filter
- `02-fetches.jsonl` — readability-extracted page text
- `03-extracts.jsonl` — Claude structured-JSON extraction with evidence quotes
- `04-deduped.jsonl` — survivors with `dedup_status` ∈ {new, existing_email, existing_domain, suppressed}, capped at 50
- `candidates.csv` — all rows for human review
- `report.md` — Slack-style summary, top candidates, costs, revert SQL
- `summary.jsonl` — one-line cron-shape rollup
- `meta.json` — run config, status, cost
- `import-errors.jsonl` — empty on a clean run; one row per bulk-import failure

## Reverting a run

If a persona run produced junk and you want it out of the CRM:

```bash
sqlite3 "$DB_PATH" \
  "DELETE FROM contacts WHERE source='brave_search' AND source_query='<YYYY-MM-DD>_<persona>'"
```

The `source_query` is the run's revert key. Each report.md prints the exact SQL line for that run.

## Configuration

All tunables live under the `research` block in `../config.json`:

| Key | Purpose |
|---|---|
| `model` | Claude model ID for extraction (default `claude-sonnet-4-6`) |
| `cost_cap_usd` | Per-run runaway guard (default 5.00) |
| `row_cap_per_run` | Hard ceiling on candidates after dedup (default 50) |
| `min_text_chars` | Skip extraction if page text is shorter than this (default 800) |
| `fetch_concurrency` | Parallel page fetches (default 3) |
| `fetch_timeout_ms` | Per-fetch timeout (default 30000) |
| `fetch_cache_ttl_days` | Reuse cached HTML up to this age (default 7) |
| `brave_request_interval_ms` | Sleep between Brave calls; free tier is 1 req/s (default 1100) |
| `exclude_domains` | Hostnames to drop from SERP results client-side |
| `exclude_extensions` | URL suffixes to drop |
| `max_results_per_query` | Brave `count` parameter (default 10) |
| `user_agent` | Sent on every fetch |

Personas and their queries live in `queries.json`. Adding a new persona = editing JSON.

## Slack visibility

Every run posts one message to `#prospector-paulina` via `openclaw send slack`. Format:

```
🔬 Research run <date> — <persona>
Searched: N queries → N SERP results → N fetched
Extracted: N pages → N ok, N parse errors, N below threshold
After dedup: N new, N existing, N suppressed
Imported: N | Errors: N
Cost: $0.NN

Top candidates: ...
Full report: research/runs/<date>/report.md

To revert: sqlite3 ... "DELETE FROM contacts WHERE source='brave_search' AND source_query='<date>_<persona>'"
```

If `Errors > 0`, a `⚠️` line points to `import-errors.jsonl`. The error count is always shown — visibility, not surprise.

## Slack commands (deferred)

`!run-research`, `!revert-research`, `!show-research`, `!approve-research`, `!reject-research` are **not yet wired**. They will be added in Step 3.2 alongside the draft-review dispatcher. For now: invoke the pipeline from the terminal, revert with the SQL above.

## Troubleshooting

- **Brave 401/403** — `BRAVE_API_KEY` in the configured `.env` is invalid. Replace it from the Brave dashboard.
- **Stage 3 cost-cap hit** — a stage aborted because running Claude cost crossed `cost_cap_usd`. `meta.json.cost_cap_hit` will be `true`. Lower the row count, raise the cap, or investigate why so many pages got past the `min_text_chars` filter.
- **Stage 5 partial-failure** — `import-errors.jsonl` will have one row per failed bulk-import row. Common cause: missing or invalid `context_source` enum value. Fix the mapping in `lib/importer.js`.
- **`existing_domain` flag** — multiple staff members at the same planner firm should yield multiple rows in `contacts`. `existing_domain` is a reviewer hint, not a hard drop.
