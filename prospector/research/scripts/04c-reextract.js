#!/usr/bin/env node
'use strict';

// 04c-reextract.js — re-extract every previously fetched page with the v2 prompt.
//
// READ-ONLY against the existing pipeline. Does NOT touch 03-extracts.jsonl
// (v1 baseline must stay intact for comparison). Writes only:
//   runs/<date>/03-extracts-v2.jsonl
//   runs/<date>/03-extract-v2.meta.json
//
// Reuses lib/extractor.js's exported `tryParseJSON` and `ratesFor` so cost
// accounting matches v1 exactly. lib/extractor.js itself is NOT modified.
//
// CLI:
//   node 04c-reextract.js [--run-date YYYY-MM-DD] [--force]
//
// Behavior:
//   - Scans runs/ for date-shaped dirs containing both 02-fetches.jsonl and
//     03-extracts.jsonl (v1). Without --run-date, sweeps every eligible one.
//   - Skips a run-date entirely if 03-extracts-v2.jsonl already exists, unless
//     --force is passed.
//   - Hard cost cap of $5.00 USD across the WHOLE sweep (not per-date). On
//     cap hit: writes a final cost_cap_hit row into the in-flight run's
//     v2 JSONL, flushes its meta sidecar, exits 4.
//   - For non-200 / low-text fetch rows, writes a passthrough record matching
//     03-extract.js's exact shape so the comparator (04d) can join 1:1.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Anthropic = require('@anthropic-ai/sdk');
const { loadConfig, loadQueries, runDir, RESEARCH_ROOT } = require('./lib/config');
const { tryParseJSON, ratesFor } = require('./lib/extractor');
const { require_env } = require('./lib/env');

const COST_CAP_USD = 5.00;
const PROMPT_VERSION = 'v2';

// ─── v2 PROMPT TEMPLATE ─────────────────────────────────────────────────────
// Verbatim from the user's clarification answer. Do not paraphrase or edit.

const PROMPT_TEMPLATE = `You are a research assistant extracting business contact information
from a web page for La Puesta del Sol, a 12-bedroom boutique beachfront resort in
Riviera Nayarit, Mexico. The resort hosts full-property buyouts: weddings (groups
~50–100), corporate/leadership retreats (groups ~20–60), and multi-generational
private bookings. Typical direct buyout revenue is $25K+ for a multi-night event.

The persona we are researching: {{PERSONA_LABEL}}

A good lead for La Puesta is a real working planner/advisor who:
  (a) actually books destination events outside their home country, AND
  (b) handles groups of roughly 20–100 guests, AND
  (c) works with clients whose budgets support a $25K+ multi-night buyout, AND
  (d) ideally has prior Mexico / Latin America / beachfront destination work.

A bad lead is a directory listing, a blog post about destination weddings, a
photographer or florist, a planner who only books local backyard events, or a
generic "wedding" page with no real person behind it.

EXTRACTION RULES (strict):

1. Extract ONLY information that appears verbatim in the page text. Do not
   infer, guess, or fabricate. If a field is not present in the text, return
   null. For every non-null field, include the exact verbatim quote in
   \`evidence\`. If you cannot quote it, you did not find it — return null.

2. If the page text includes a \`[discovered_contacts]\` section, those emails
   and phones are authoritative (extracted from mailto:/tel: links and HTML
   patterns). The verbatim evidence for these can be
   \`[discovered_contacts] block: <email>\` instead of a body quote.

3. Distinguish named contacts (real person, e.g. "Sarah Chen, Lead Planner")
   from role-based emails (e.g. info@, hello@). A discovered_contacts email
   goes into named_contacts only if you can pair it with a name from the body
   text; otherwise it goes into role_based_emails.

4. First decide \`page_type\`. This gates everything else:
     - real_planner       — an actual planning business with named staff, services, portfolio
     - directory_listing  — theknot, weddingwire, bridebook, wedding.com profile pages, etc.
     - blog_post          — editorial content about destination weddings
     - venue_site         — a resort, hotel, or villa marketing itself
     - vendor_other       — photographer, florist, DJ, officiant, planner-adjacent
     - unclear            — insufficient signal
   If page_type is anything other than \`real_planner\`, set persona_fit="none"
   and quality_score=1 regardless of other signals. Directory listings and
   blog posts are not leads.

5. Then capture buyer-fit signals. Each is a separate field, with evidence:
     - destination_work_evidence:   quotes showing they book events outside
                                    their home country. null if not present.
     - mexico_or_latam_evidence:    quotes specifically referencing Mexico,
                                    Latin America, or Caribbean destinations.
                                    null if not present.
     - group_size_signal:           quote(s) suggesting typical group size
                                    (e.g. "intimate weddings of 30–80"). null
                                    if not stated.
     - budget_signal:               quote(s) suggesting price point or budget
                                    bracket. null if not stated.
     - portfolio_recency_signal:    quote(s) showing recent activity (dated
                                    posts, "now booking 2027", recent
                                    Instagram references). null if not stated.

6. \`persona_fit\` is your judgment, anchored on the four criteria above:
     - strong   = page_type=real_planner AND destination_work_evidence present
                  AND (mexico_or_latam_evidence present OR group_size_signal
                  matches 20–100 OR budget_signal suggests $20K+ events)
     - moderate = page_type=real_planner AND destination_work_evidence present
                  but no Mexico/group/budget anchor
     - weak     = page_type=real_planner but no destination_work_evidence
     - none     = page_type ≠ real_planner, or no usable contact info

7. \`quality_score\` (1–5) reflects usable-lead-ness, weighted toward fit:
     5 = strong fit + named contact + direct (non-role-based) email
     4 = strong fit + (named contact OR direct email)
     3 = moderate fit + named contact + email of any kind
     2 = weak fit, OR strong fit with only a contact form
     1 = page_type ≠ real_planner, OR no contact info, OR fit=none
   A real_planner with weak fit caps at 2. A directory listing caps at 1
   even if it lists a phone number.

8. If page_type ≠ real_planner OR persona_fit=none, populate
   \`rejection_reason\` with one of:
     directory_listing | blog_only | wrong_vendor_type | local_only |
     no_destination_evidence | no_contact_info | duplicate_brand | other
   plus a brief free-text \`notes\` explaining.

Return ONLY a JSON object matching this schema. No prose, no markdown fences.

{
  "page_type": "real_planner" | "directory_listing" | "blog_post" | "venue_site" | "vendor_other" | "unclear",
  "company_name": string | null,
  "named_contacts": [
    {"name": string, "role": string | null, "email": string | null, "phone": string | null}
  ],
  "role_based_emails": [string],
  "general_phone": string | null,
  "location": {"city": string | null, "state_or_region": string | null, "country": string | null},
  "services_offered": [string],
  "destinations_served": [string],
  "destination_work_evidence":  string | null,
  "mexico_or_latam_evidence":   string | null,
  "group_size_signal":          string | null,
  "budget_signal":              string | null,
  "portfolio_recency_signal":   string | null,
  "persona_fit": "strong" | "moderate" | "weak" | "none",
  "quality_score": 1 | 2 | 3 | 4 | 5,
  "rejection_reason": string | null,
  "evidence": {
    "company_name": string | null,
    "named_contacts": [string],
    "emails": [string],
    "persona_fit": string | null,
    "page_type": string | null
  },
  "notes": string | null
}

Page URL: {{URL}}
Page title: {{TITLE}}

Page text:
---
{{TEXT}}
---`;

function buildPrompt({ personaLabel, url, title, text }) {
  return PROMPT_TEMPLATE
    .replace('{{PERSONA_LABEL}}', personaLabel)
    .replace('{{URL}}', url)
    .replace('{{TITLE}}', title || '')
    .replace('{{TEXT}}', text || '');
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { runDate: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-date') args.runDate = argv[++i];
    else if (a.startsWith('--run-date=')) args.runDate = a.slice('--run-date='.length);
    else if (a === '--force') args.force = true;
  }
  return args;
}

async function readJSONL(p) {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_) {}
  }
  return rows;
}

function isRunDateDir(name) {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

function listEligibleRunDates(specific) {
  const runsRoot = path.join(RESEARCH_ROOT, 'runs');
  if (!fs.existsSync(runsRoot)) return [];
  const all = specific
    ? [specific]
    : fs.readdirSync(runsRoot).filter(isRunDateDir).sort();
  const out = [];
  for (const d of all) {
    const dir = path.join(runsRoot, d);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const fetches = path.join(dir, '02-fetches.jsonl');
    const extracts = path.join(dir, '03-extracts.jsonl');
    if (fs.existsSync(fetches) && fs.existsSync(extracts)) out.push(d);
  }
  return out;
}

function personasIn(rows) {
  const set = new Set();
  for (const r of rows) if (r && r.persona) set.add(r.persona);
  return Array.from(set).sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const queries = loadQueries();
  const research = cfg.research;
  const model = research.model;
  const minTextChars = research.min_text_chars || 800;
  const rates = ratesFor(model);

  const dates = listEligibleRunDates(args.runDate);
  if (dates.length === 0) {
    console.error('[04c-reextract] No eligible run-date directories found ' +
                  '(need both 02-fetches.jsonl and 03-extracts.jsonl). Exiting.');
    process.exit(2);
  }
  console.error(`[04c-reextract] Eligible run-dates: ${dates.join(', ')}`);
  console.error(`[04c-reextract] Model: ${model} | Cost cap: $${COST_CAP_USD.toFixed(2)} (whole sweep)`);

  const apiKey = require_env('ANTHROPIC_API_KEY');
  const client = new Anthropic({ apiKey });

  let totalRunningCost = 0;
  let costCapReached = false;

  for (const runDate of dates) {
    if (costCapReached) {
      console.error(`[04c-reextract] Cost cap hit earlier — skipping remaining run-date ${runDate}.`);
      continue;
    }

    const dir = runDir(runDate);
    const fetchesPath = path.join(dir, '02-fetches.jsonl');
    const outPath = path.join(dir, '03-extracts-v2.jsonl');
    const metaPath = path.join(dir, '03-extract-v2.meta.json');

    if (fs.existsSync(outPath) && !args.force) {
      console.error(`[04c-reextract] ${runDate}: 03-extracts-v2.jsonl exists, skipping (use --force to re-run).`);
      continue;
    }

    const fetches = await readJSONL(fetchesPath);
    const personas = personasIn(fetches);
    console.error(`[04c-reextract] ${runDate}: ${fetches.length} fetch rows, personas=${JSON.stringify(personas)}`);

    const startMs = Date.now();
    let pagesTotal = fetches.length;
    let callsAttempted = 0;
    let ok = 0;
    let parseErrors = 0;
    let apiErrors = 0;
    let lowText = 0;
    let nonOkFetches = 0;
    let runInputTokens = 0;
    let runOutputTokens = 0;
    let runCost = 0;
    let runCostCapHit = false;

    const out = fs.createWriteStream(outPath, { flags: 'w' });

    for (const r of fetches) {
      if (r.status !== 200) {
        out.write(JSON.stringify({
          url: r.url, persona: r.persona, extract_status: 'fetch_failed',
          fetch_status: r.status, fetch_error: r.error,
          extracted_at: new Date().toISOString(),
        }) + '\n');
        nonOkFetches++;
        continue;
      }
      if (!r.text || r.text_length < minTextChars) {
        out.write(JSON.stringify({
          url: r.url, persona: r.persona, extract_status: 'low_text',
          text_length: r.text_length, threshold: minTextChars,
          extracted_at: new Date().toISOString(),
        }) + '\n');
        lowText++;
        continue;
      }

      // Cost-cap check BEFORE every billable call.
      if (totalRunningCost >= COST_CAP_USD) {
        console.error(`[04c-reextract] COST CAP HIT mid-run ${runDate}: ` +
                      `$${totalRunningCost.toFixed(4)} ≥ $${COST_CAP_USD.toFixed(2)}. ` +
                      `Aborting after writing cost_cap_hit marker.`);
        out.write(JSON.stringify({
          url: r.url, persona: r.persona, extract_status: 'cost_cap_hit',
          running_cost_usd: totalRunningCost,
          extracted_at: new Date().toISOString(),
        }) + '\n');
        runCostCapHit = true;
        costCapReached = true;
        break;
      }

      const personaCfg = queries.personas[r.persona];
      const personaLabel = personaCfg ? personaCfg.label : r.persona;
      const prompt = buildPrompt({
        personaLabel,
        url: r.url,
        title: r.title,
        text: r.text,
      });

      callsAttempted++;
      let resp;
      try {
        resp = await client.messages.create({
          model,
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        });
      } catch (e) {
        apiErrors++;
        out.write(JSON.stringify({
          url: r.url, persona: r.persona, extract_status: 'api_error',
          error: String(e.message || e),
          cost_usd: 0,
          model,
          extracted_at: new Date().toISOString(),
        }) + '\n');
        continue;
      }

      const inTok = (resp.usage && resp.usage.input_tokens) || 0;
      const outTok = (resp.usage && resp.usage.output_tokens) || 0;
      const callCost = (inTok / 1_000_000) * rates.input + (outTok / 1_000_000) * rates.output;
      runInputTokens += inTok;
      runOutputTokens += outTok;
      runCost += callCost;
      totalRunningCost += callCost;

      const textBlock = (resp.content || []).find(b => b.type === 'text');
      const raw = textBlock ? textBlock.text : '';
      const parsed = tryParseJSON(raw);

      if (!parsed) {
        parseErrors++;
        out.write(JSON.stringify({
          url: r.url, persona: r.persona, extract_status: 'parse_error',
          raw,
          cost_usd: Number(callCost.toFixed(6)),
          model,
          extracted_at: new Date().toISOString(),
        }) + '\n');
        continue;
      }

      ok++;
      out.write(JSON.stringify({
        url: r.url, persona: r.persona,
        extract_status: 'ok',
        extracted: parsed,
        evidence: parsed.evidence || {},
        quality_score: parsed.quality_score || null,
        cost_usd: Number(callCost.toFixed(6)),
        model,
        extracted_at: new Date().toISOString(),
      }) + '\n');

      if (callsAttempted % 10 === 0) {
        console.error(`[04c-reextract] ${runDate}: ${callsAttempted} calls, ` +
                      `run cost $${runCost.toFixed(4)} | sweep total $${totalRunningCost.toFixed(4)}`);
      }
    }

    out.end();
    await new Promise(res => out.on('close', res));

    const meta = {
      run_date: runDate,
      personas_present: personas,
      pages_total: pagesTotal,
      calls_attempted: callsAttempted,
      ok,
      parse_errors: parseErrors,
      api_errors: apiErrors,
      low_text: lowText,
      non_ok_fetches: nonOkFetches,
      cost_cap_hit: runCostCapHit,
      input_tokens: runInputTokens,
      output_tokens: runOutputTokens,
      cost_usd: Number(runCost.toFixed(6)),
      duration_ms: Date.now() - startMs,
      model,
      prompt_version: PROMPT_VERSION,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    console.error(`[04c-reextract] ${runDate}: DONE pages=${pagesTotal} calls=${callsAttempted} ` +
                  `ok=${ok} parse_err=${parseErrors} api_err=${apiErrors} low_text=${lowText} ` +
                  `non_ok=${nonOkFetches} cost=$${runCost.toFixed(4)} cap_hit=${runCostCapHit}`);
  }

  console.error(`[04c-reextract] SWEEP DONE | total cost $${totalRunningCost.toFixed(4)}`);
  if (costCapReached) {
    console.error(`[04c-reextract] EXIT 4: cost cap reached during sweep.`);
    process.exit(4);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main, buildPrompt, PROMPT_TEMPLATE };
