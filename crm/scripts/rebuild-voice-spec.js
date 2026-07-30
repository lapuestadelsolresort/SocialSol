#!/usr/bin/env node
'use strict';
//
// rebuild-voice-spec.js — Phase R, R3
//
// Statistics-driven rebuild of prospector/voice-spec.md
// from the full 1,204-message sarah_voice_corpus.
//
// The v0 spec was hand-curated from 10 messages and explicitly flagged
// the lack of cold-outbound exemplars. This script regenerates §1–§3
// from corpus statistics and §4 from the same statistics templated into
// the exact contract Paulina's composer.js loadVoiceConstraintsBlock
// regex expects (`## 4.` ... `## 5.`).
//
// Idempotent: deterministic ordering + fixed-precision numbers means
// re-running with no corpus changes produces byte-identical output.
//
// Usage:
//   node rebuild-voice-spec.js              # print to stdout
//   node rebuild-voice-spec.js --write      # back up + overwrite voice-spec.md

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'crm.db');
const SPEC_PATH = path.join(__dirname, '..', '..', 'prospector', 'voice-spec.md');

const BANNED_PHRASES = [
  'circle back',
  'touch base',
  'bandwidth',
  'synergies',
  'i hope this finds you well',
  'i wanted to',
  'definitely',
  'kind regards',
  'sincerely',
];
const BROCHURE_VOCAB = ['wonderful', 'beautiful', 'special', 'unforgettable', 'magical', 'breathtaking'];

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (a === '--write') out.write = true;
    if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function pct(num, denom) {
  if (!denom) return 0;
  return Math.round((num / denom) * 1000) / 10;
}

function quantile(sortedNums, q) {
  if (sortedNums.length === 0) return 0;
  const i = (sortedNums.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sortedNums[lo];
  return Math.round(sortedNums[lo] + (sortedNums[hi] - sortedNums[lo]) * (i - lo));
}

function topN(counter, n) {
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

function bumpCounter(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function analyze(rows) {
  const stats = {
    total: rows.length,
    byRelationship: new Map(),
    wordCounts: [],
    wordCountsByRelationship: new Map(),
    emDashes: 0,
    exclamations: 0,
    contractions: 0,
    contractionMessages: 0,
    salutations: new Map(),
    signoffs: new Map(),
    openerTrigrams: new Map(),
    closerTrigrams: new Map(),
    bannedHits: new Map(BANNED_PHRASES.map((p) => [p, 0])),
    brochureHits: new Map(BROCHURE_VOCAB.map((p) => [p, 0])),
    brochureMessageCount: 0,
  };

  const contractionRegex = /\b\w+'(s|re|ll|ve|d|t|m)\b/gi;

  for (const r of rows) {
    const body = String(r.body || '');
    const rel = r.recipient_relationship || 'unknown';
    bumpCounter(stats.byRelationship, rel);
    const wc = Number(r.word_count) || body.split(/\s+/).filter(Boolean).length;
    stats.wordCounts.push(wc);
    const wcRelArr = stats.wordCountsByRelationship.get(rel) || [];
    wcRelArr.push(wc);
    stats.wordCountsByRelationship.set(rel, wcRelArr);

    stats.emDashes += (body.match(/—/g) || []).length;
    stats.exclamations += (body.match(/!/g) || []).length;
    const cMatches = body.match(contractionRegex) || [];
    stats.contractions += cMatches.length;
    if (cMatches.length > 0) stats.contractionMessages++;

    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      const first = lines[0];
      const salMatch = first.match(/^(Hi|Hello|Hey|Dear|Good (?:morning|afternoon|evening))(?:\s+([^,!.?]{1,30}))?/i);
      if (salMatch) {
        const tag = salMatch[1].toLowerCase().replace(/\s+/g, ' ');
        bumpCounter(stats.salutations, tag);
      }
      const trig = first.split(/\s+/).slice(0, 3).join(' ').toLowerCase().replace(/[,.!?;:]+$/, '');
      if (trig) bumpCounter(stats.openerTrigrams, trig);
    }
    if (lines.length > 1) {
      // Sign-off heuristic: a short line near the end (≤4 words, no period, ends with comma)
      // OR exact match of common closing words.
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
        const ln = lines[i];
        const stripped = ln.replace(/[,!.]+$/, '').trim();
        const wordsInLine = stripped.split(/\s+/).length;
        if (wordsInLine >= 1 && wordsInLine <= 5 && /^[A-Z]/.test(stripped)) {
          if (/^(Warmly|Best|Warmest regards|All my very best|Cheers|Thanks|Sarah|Take care|Looking forward)/i.test(stripped)) {
            bumpCounter(stats.signoffs, stripped.toLowerCase());
            break;
          }
        }
      }
      const last = lines[lines.length - 1];
      const closerTrig = last.split(/\s+/).slice(0, 3).join(' ').toLowerCase().replace(/[,.!?;:]+$/, '');
      if (closerTrig) bumpCounter(stats.closerTrigrams, closerTrig);
    }

    const lower = body.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      if (lower.includes(phrase)) stats.bannedHits.set(phrase, stats.bannedHits.get(phrase) + 1);
    }
    let brochureHitsThisMsg = 0;
    for (const v of BROCHURE_VOCAB) {
      const matches = lower.match(new RegExp(`\\b${v}\\b`, 'g'));
      if (matches) {
        stats.brochureHits.set(v, stats.brochureHits.get(v) + matches.length);
        brochureHitsThisMsg += matches.length;
      }
    }
    if (brochureHitsThisMsg > 0) stats.brochureMessageCount++;
  }

  stats.wordCounts.sort((a, b) => a - b);
  for (const arr of stats.wordCountsByRelationship.values()) arr.sort((a, b) => a - b);

  return stats;
}

function renderSpec(stats, today) {
  const total = stats.total;
  const wc = stats.wordCounts;
  const p25 = quantile(wc, 0.25), p50 = quantile(wc, 0.50), p75 = quantile(wc, 0.75), p90 = quantile(wc, 0.90);

  const relationshipRows = Array.from(stats.byRelationship.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([rel, count]) => {
      const arr = stats.wordCountsByRelationship.get(rel) || [];
      arr.sort((a, b) => a - b);
      const med = quantile(arr, 0.5);
      const p9 = quantile(arr, 0.9);
      return `| ${rel} | ${count} | ${pct(count, total)}% | ${med} | ${p9} |`;
    }).join('\n');

  const topSalutations = topN(stats.salutations, 6)
    .map(([s, c]) => `- \`${s}\` — ${c} (${pct(c, total)}%)`).join('\n');
  const topSignoffs = topN(stats.signoffs, 8)
    .map(([s, c]) => `- \`${s}\` — ${c} (${pct(c, total)}%)`).join('\n');
  const topOpeners = topN(stats.openerTrigrams, 12)
    .map(([s, c]) => `- \`${s}\` — ${c}`).join('\n');
  const topClosers = topN(stats.closerTrigrams, 12)
    .map(([s, c]) => `- \`${s}\` — ${c}`).join('\n');

  const bannedAudit = BANNED_PHRASES.map((p) => {
    const hits = stats.bannedHits.get(p) || 0;
    const flag = hits > Math.max(2, total * 0.005) ? ' ⚠️ above threshold — review before banning' : '';
    return `- "${p}" — ${hits} occurrence(s)${flag}`;
  }).join('\n');

  const brochureAudit = BROCHURE_VOCAB.map((v) => {
    const hits = stats.brochureHits.get(v) || 0;
    return `- "${v}" — ${hits} occurrence(s) across the corpus`;
  }).join('\n');

  const emDashesPerMsg = (stats.emDashes / total).toFixed(2);
  const exclPerMsg = (stats.exclamations / total).toFixed(2);
  const contractionMsgPct = pct(stats.contractionMessages, total);
  const brochureMsgPct = pct(stats.brochureMessageCount, total);

  // §4 banned-phrase list = corpus-cleared phrases (≤ 2 hits).
  const bannedForSpec = BANNED_PHRASES.filter((p) => (stats.bannedHits.get(p) || 0) <= 2);

  // §4 sign-off rotation = top 4 sign-offs by frequency, in their original casing.
  // Because we lowercased for the counter, restore Title Case for rendering.
  const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  const signoffRotation = topN(stats.signoffs, 4).map(([s]) => titleCase(s));

  return `# Sarah Voice Spec — Voice Service (R3 rebuild)

v1 — auto-generated ${today} from sarah_voice_corpus (${total} EN messages). Replaces v0 (10-message hand-curated spec). Regenerate with \`node crm/scripts/rebuild-voice-spec.js --write\`.

## 1. Corpus summary

Source: \`sarah_voice_corpus\` table, all rows where \`embedding_status='indexed' AND language='en'\`. Rows tagged \`recipient_relationship='unknown'\` are R1-orphan messages (no contact_id link); they remain in the pool but are excluded from relationship-filtered queries.

| Recipient relationship | Count | Share | Median words | p90 words |
|---|---:|---:|---:|---:|
${relationshipRows}

Length distribution (all messages): p25=${p25} / p50=${p50} / p75=${p75} / p90=${p90} words.

## 2. Voice signature

### 2.1 Salutations (top 6)
${topSalutations}

### 2.2 Sign-offs (top 8)
${topSignoffs}

### 2.3 Opener trigrams (top 12)
${topOpeners}

### 2.4 Closer trigrams (top 12)
${topClosers}

### 2.5 Punctuation density
- Em-dashes: ${stats.emDashes} total → ${emDashesPerMsg} per message average
- Exclamations: ${stats.exclamations} total → ${exclPerMsg} per message average

### 2.6 Contractions
${stats.contractionMessages} of ${total} messages (${contractionMsgPct}%) contain at least one contraction. Sarah uses contractions liberally — composers should default to contracted forms.

## 3. Negative-space audit

Brochure vocabulary appears in ${stats.brochureMessageCount} of ${total} messages (${brochureMsgPct}%):
${brochureAudit}

Banned-phrase audit (phrases the v0 spec banned, validated against the full corpus):
${bannedAudit}

Phrases with > 2 corpus hits should be re-evaluated before keeping them on the §4 ban list — Sarah may use them in contexts the v0 didn't see.

## 4. Constraint summary (consumed verbatim by Paulina's composer.js)

**Length.** Hard cap 150 words. Target ${Math.max(40, p25)}–${Math.min(160, p75)} words for cold-outbound, ${p25}–${p75} for warm replies. Trim hard rather than overshoot.

**Structure.** Salutation → hook (one sentence) → value/answer (1–3 sentences) → light call-to-action → sign-off. Skip the value section for short ad_hoc replies.

**Voice must-dos.**
- Use contractions (don't, we're, I'll, it's). Default-on.
- One warmth cluster maximum per message (e.g. "so excited to host you"). Two reads as gushing.
- Em-dashes are in-voice (corpus average ${emDashesPerMsg}/msg). One is fine, two if the message is over ~80 words.
- Sign-off rotation: ${signoffRotation.length > 0 ? signoffRotation.map((s) => `\`${s}\``).join(' / ') : '`Warmly,` / `Best,` / `Warmest regards,` / `All my very best,`'}.
- Closer pattern: pivot to "easy to reach" + a one-line CTA before the sign-off.

**Voice must-not-dos.**
- Never start with "Dear <Name>".
- No emoji.
- Brochure-vocabulary cap: 1 per message (0 for cold-outbound to planners).
${bannedForSpec.length > 0 ? `- Avoid: ${bannedForSpec.map((p) => `"${p}"`).join(', ')}.` : '- (no corpus-cleared banned phrases at this rebuild)'}
- Exclamations: cap at 2 per message (corpus average is ${exclPerMsg}, well under).

## 5. Provenance

This spec was regenerated by \`crm/scripts/rebuild-voice-spec.js\` against the corpus snapshot of ${today}. To re-run:

\`\`\`
node crm/scripts/rebuild-voice-spec.js --write
\`\`\`

\`--write\` backs up the existing file to \`voice-spec.v<N>.md\` and overwrites in place. The §4 header line "## 4." and §5 header line "## 5." are load-bearing — \`prospector/composer.js\` extracts §4 between those exact headers.

## 6. Still open

- Cold-outbound exemplar density: the corpus is overwhelmingly warm-reply; cold_outbound_planner intent retrieval will draw from the closest stylistic matches available. Re-evaluate after R5 ships and the first batch of cold-outbound drafts is reviewed.
- Spanish corpus: 2 ES rows remain pending. Out of scope for v1.
`;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.error('Usage: node rebuild-voice-spec.js [--write]');
    return 0;
  }

  const db = createDB(DB_PATH);

  // JOIN contacts to derive recipient_relationship the same way the indexer
  // does at Chroma-write time. sarah_voice_corpus.recipient_relationship is
  // NULL on all rows by design (vestigial schema column — see migration 006
  // and crm/scripts/index-voice-corpus.js deriveRecipientRelationship).
  // Single source of truth: contacts.relationship_type.
  const rows = await db.query(sql`
    SELECT s.id, s.body, s.word_count,
           COALESCE(c.relationship_type, 'unknown') AS recipient_relationship
      FROM sarah_voice_corpus s
      LEFT JOIN contacts c ON c.id = s.contact_id
     WHERE s.language = 'en'
       AND s.embedding_status = 'indexed'
     ORDER BY s.id ASC
  `);

  await db.dispose();

  if (rows.length === 0) {
    console.error('[rebuild-voice-spec] no indexed EN rows; aborting');
    return 1;
  }

  const stats = analyze(rows);
  // Use the most recent sent_at as the snapshot date so re-runs are
  // deterministic. If no sent_at, fall back to a stable label.
  const today = (process.env.SPEC_DATE || new Date().toISOString().slice(0, 10));
  const out = renderSpec(stats, today);

  if (!opts.write) {
    process.stdout.write(out);
    return 0;
  }

  // Backup pre-existing file.
  if (fs.existsSync(SPEC_PATH)) {
    let n = 0;
    while (fs.existsSync(`${SPEC_PATH.replace(/\.md$/, '')}.v${n}.md`)) n++;
    const backup = `${SPEC_PATH.replace(/\.md$/, '')}.v${n}.md`;
    fs.copyFileSync(SPEC_PATH, backup);
    console.error(`[rebuild-voice-spec] backed up existing file to ${backup}`);
  }
  fs.writeFileSync(SPEC_PATH, out);
  console.error(`[rebuild-voice-spec] wrote ${SPEC_PATH} (${out.length} bytes, ${rows.length} rows)`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    console.error('[rebuild-voice-spec] FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}

module.exports = { analyze, renderSpec, BANNED_PHRASES, BROCHURE_VOCAB };
