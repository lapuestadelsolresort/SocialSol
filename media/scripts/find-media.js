#!/usr/bin/env node
'use strict';
//
// find-media.js — operator CLI for terminal inspection of the media library.
//
// NOT the agent UX. Sol, Paulina, and Regina call GET /api/media/search
// directly from their reasoning loop (same pattern as Voice Service); the
// raw JSON is already LLM-shaped. This wrapper exists for humans who want
// to browse the library from a terminal before posting, or to debug what
// the agents are seeing.
//
// Calls localhost:3456/api/media/search and pretty-prints the top results
// (asset_id, synopsis, score, proxy/thumb URLs) to stdout.
//
// Usage:
//   node find-media.js "intimate sunset over the villa" \
//     [--persona=wedding_planner_outreach] [--kind=video] [--limit=3]
//     [--min-duration-ms=3000] [--max-duration-ms=60000]
//     [--setting=ceremony_arch] [--mood=golden_hour]
//     [--base-url=http://localhost:3456]

function parseArgs(argv) {
  const out = { limit: 3, baseUrl: 'http://localhost:3456' };
  const positional = [];
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) {
      const k = m[1].replace(/-/g, '_');
      out[k] = m[2] === undefined ? true : m[2];
    } else {
      positional.push(a);
    }
  }
  out.q = positional.join(' ');
  return out;
}

function buildUrl(base, params) {
  const u = new URL(base + '/api/media/search');
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || k === 'base_url') continue;
    u.searchParams.set(k.replace(/_/g, '-').replace('q', 'q'), String(v));
  }
  return u.toString();
}

function fmtSeconds(ms) {
  if (!ms) return '–';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m${r.toFixed(0).padStart(2, '0')}s`;
}

async function main() {
  const a = parseArgs(process.argv);
  if (!a.q) {
    console.error('Usage: find-media.js "<query>" [--persona=...] [--kind=...] [--limit=N]');
    process.exit(2);
  }
  const params = {
    q: a.q,
    persona: a.persona,
    kind: a.kind,
    limit: a.limit,
    min_duration_ms: a.min_duration_ms,
    max_duration_ms: a.max_duration_ms,
    setting: a.setting,
    mood: a.mood,
  };
  const url = new URL(a.baseUrl + '/api/media/search');
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    console.error(`search failed: HTTP ${res.status}: ${body}`);
    process.exit(1);
  }
  const results = await res.json();

  if (!results.length) {
    console.log(`No matches for: "${a.q}"`);
    return;
  }
  const personaTag = a.persona ? ` (persona=${a.persona})` : '';
  console.log(`Top ${results.length} match(es) for "${a.q}"${personaTag}:\n`);
  for (const r of results) {
    const dur = r.kind === 'photo' ? `${r.width}x${r.height}` : fmtSeconds(r.duration_ms);
    console.log(`#${r.asset_id} [${r.kind}/${r.source_role}] ${r.filename} — ${dur} — score=${r.score}`);
    console.log(`  ${r.synopsis || '(no synopsis)'}`);
    if (r.proxy_url) console.log(`  proxy: ${a.baseUrl}${r.proxy_url}`);
    if (r.thumb_url) console.log(`  thumb: ${a.baseUrl}${r.thumb_url}`);
    console.log('');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
}
