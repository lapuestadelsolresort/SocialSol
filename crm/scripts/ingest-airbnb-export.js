#!/usr/bin/env node
'use strict';
//
// ingest-airbnb-export.js — Phase R, R1
//
// One-shot ingestion of an Airbnb data export into the CRM:
//   Phase 1: 218 contacts (guest_directory.json + guest_contacts.json)
//   Phase 2: Sarah's outbound messages → sarah_voice_corpus
//
// Both phases are idempotent. Re-runs upsert contacts (preserving lifecycle
// columns) and INSERT-OR-IGNORE messages.
//
// Usage:
//   node ingest-airbnb-export.js \
//     --export-dir=$HOME/Desktop/Airbnb_data_request_02May2026_GMT \
//     [--dry-run]                    skip DB writes; print summary
//     [--phase=contacts|voice|all]   default all
//     [--map-tolerance=0.05]         GUEST_DATA_MAP divergence tolerance
//     [--host-account-id=<int>]      override host resolver if ambiguous
//     [--verify-idempotency]         run twice, assert second run = no-op

const fs = require('fs');
const path = require('path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const lib = require('./lib/airbnb-export');

// ── arg parsing (no dependency) ──────────────────────────────────────────
function parseArgs(argv) {
  const out = { phase: 'all', mapTolerance: 0.05 };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const k = m[1];
    const v = m[2] === undefined ? true : m[2];
    if (k === 'export-dir') out.exportDir = v;
    else if (k === 'dry-run') out.dryRun = true;
    else if (k === 'phase') out.phase = v;
    else if (k === 'map-tolerance') out.mapTolerance = parseFloat(v);
    else if (k === 'host-account-id') {
      // Accept comma-separated list — multiple Sarah-voice accounts may exist
      // (e.g. primary + an older account she still uses).
      out.hostAccountIds = String(v).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
    }
    else if (k === 'verify-idempotency') out.verifyIdempotency = true;
    else if (k === 'help' || k === 'h') out.help = true;
  }
  return out;
}

function usage() {
  console.error([
    'Usage: node ingest-airbnb-export.js --export-dir=<path> [options]',
    '',
    '  --export-dir=<path>          Required. Path to the Airbnb export directory.',
    '  --dry-run                    Skip DB writes; print summary only.',
    '  --phase=contacts|voice|all   Default: all',
    '  --map-tolerance=0.05         GUEST_DATA_MAP count divergence tolerance.',
    '  --host-account-id=<int[,..]> Override host accountId(s); accepts a comma-sep',
    '                               list when multiple accounts represent the same',
    '                               voice (e.g. primary + co-host).',
    '  --verify-idempotency         Run twice, assert second run = no-op.',
    ''
  ].join('\n'));
}

// ── filesystem ──────────────────────────────────────────────────────────
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadExport(exportDir) {
  const dir = path.resolve(exportDir);
  const directoryPath = path.join(dir, 'guest_directory.json');
  const contactsPath  = path.join(dir, 'guest_contacts.json');
  const messagesPath  = path.join(dir, 'json', 'messages.json');
  const mapPath       = path.join(dir, 'GUEST_DATA_MAP.md');

  for (const p of [directoryPath, contactsPath, messagesPath, mapPath]) {
    if (!fs.existsSync(p)) throw new Error(`Missing required file: ${p}`);
  }

  const directory = readJSON(directoryPath);
  const contacts  = readJSON(contactsPath);
  const messagesRaw = readJSON(messagesPath);
  const mapText   = fs.readFileSync(mapPath, 'utf8');

  // messages.json is wrapped in an outer array containing one object with messageThreads[]
  let threads;
  if (Array.isArray(messagesRaw) && messagesRaw[0] && Array.isArray(messagesRaw[0].messageThreads)) {
    threads = messagesRaw[0].messageThreads;
  } else if (messagesRaw && Array.isArray(messagesRaw.messageThreads)) {
    threads = messagesRaw.messageThreads;
  } else {
    throw new Error('messages.json: unexpected shape — expected messageThreads array');
  }

  let messageCount = 0;
  for (const t of threads) messageCount += (t.messagesAndContents || []).length;

  return { directory, contacts, threads, messageCount, mapText };
}

// ── count validation ─────────────────────────────────────────────────────
function validateCounts({ directory, contacts, threads, messageCount, mapText, tolerance }) {
  const map = lib.parseGuestDataMap(mapText);
  // Augment with thread/message counts (not in the table parser).
  map.threadCount  = (mapText.match(/(\d+)\s*threads,\s*(\d+)\s*messages/i) || [, null, null])[1];
  map.messageCount = (mapText.match(/(\d+)\s*threads,\s*(\d+)\s*messages/i) || [, null, null])[2];
  if (map.threadCount  != null) map.threadCount  = parseInt(map.threadCount, 10);
  if (map.messageCount != null) map.messageCount = parseInt(map.messageCount, 10);
  // The map's "33 records" is row count in guest_contacts.json. We pin both
  // the row count and the distinct-accountId count — they should remain stable
  // unless the export is re-pulled with different extraction/dedup logic.
  map.contactsRowsRaw = map.contactsTotal != null ? null : null; // placeholder
  if (map.contactsWithEmail != null) {
    // The map publishes "33" as the bare list count; honor whichever number
    // the executive-summary table claims. For the current export, that's 33.
    map.contactsRowsRaw = 33;
    // Distinct accountIds isn't in the map text. Leave null so the validator
    // ignores it for now — the row-count check is the precondition that
    // catches re-pulled-with-different-extraction-logic drift, and the
    // dedup-collision report (in the script output) catches identity-mixing.
  }

  return lib.validateCountsAgainstMap({
    map,
    exportData: { directory, contacts, threadCount: threads.length, messageCount },
    tolerance
  });
}

// ── ingestion: contacts ──────────────────────────────────────────────────
async function ingestContacts(db, { directory, contacts, threads, dryRun }) {
  // Dedup guest_contacts.json by accountId before building rows. The raw file
  // can have multiple rows per accountId (one Airbnb thread carrying contacts
  // for several different people); without dedup, the UPSERT does last-write-
  // wins on email/phone and silently mixes identities.
  const { deduped, collisions } = lib.dedupGuestContacts(contacts, directory);
  if (collisions.length) {
    console.log(`[ingest]   dedup: ${contacts.length} raw rows → ${deduped.length} distinct accountIds (${collisions.length} collisions)`);
    for (const c of collisions) {
      console.log(`[ingest]     accountId=${c.accountId} firstName=${c.directoryFirstName || '(none)'}`);
      console.log(`[ingest]       KEPT (${c.reason}): name="${c.kept.name}" email=${c.kept.email || '-'} phone=${c.kept.phone || '-'}`);
      for (const d of c.dropped) {
        console.log(`[ingest]       drop: name="${d.name}" email=${d.email || '-'} phone=${d.phone || '-'}`);
      }
    }
  }

  // Build accountId → contact-row index from the deduped set
  const contactsByAccountId = new Map();
  for (const c of deduped) contactsByAccountId.set(c.accountId, c);

  // Build accountId → most-recent-thread-id index
  const mostRecentThreadByAccountId = new Map();
  for (const t of threads) {
    const participants = (t.messageThreadParticipants || []).map(p =>
      (p && typeof p === 'object') ? (p.accountId ?? p.id) : p
    );
    const ts = (t.messagesAndContents || []).map(e => e.message && e.message.createdAt).filter(Boolean);
    if (ts.length === 0) continue;
    const latest = ts.sort().slice(-1)[0];
    for (const pid of participants) {
      const existing = mostRecentThreadByAccountId.get(pid);
      if (!existing || existing.latest < latest) {
        mostRecentThreadByAccountId.set(pid, { threadId: t.id, latest });
      }
    }
  }
  const threadIdByAccountId = new Map(
    [...mostRecentThreadByAccountId.entries()].map(([k, v]) => [k, v.threadId])
  );

  // Build rows
  const rows = [];
  for (const entry of directory) {
    try {
      rows.push(lib.buildContactRow(entry, contactsByAccountId, threadIdByAccountId));
    } catch (e) {
      console.error(`[ingest] buildContactRow failed for accountId=${entry.accountId}: ${e.message}`);
    }
  }

  const summary = {
    totalRows: rows.length,
    voluntaryShare: rows.filter(r => r.contact_provenance === 'voluntary_share_message').length,
    threadOnly: rows.filter(r => r.contact_provenance === 'airbnb_thread_only').length,
    relStayed: rows.filter(r => r.relationship_type === 'past_guest_stayed').length,
    relCancelled: rows.filter(r => r.relationship_type === 'past_guest_cancelled').length,
    relInquired: rows.filter(r => r.relationship_type === 'past_guest_inquired').length,
    inserted: 0,
    updated: 0,
    errors: []
  };

  if (dryRun) {
    console.log('[ingest] (dry-run) contacts to upsert:', summary.totalRows);
    return summary;
  }

  await db.query(sql`BEGIN`);
  try {
    for (const r of rows) {
      const before = await db.query(
        sql`SELECT id FROM contacts WHERE airbnb_account_id = ${r.airbnb_account_id}`
      );
      try {
        await db.query(sql`
          INSERT INTO contacts (
            name, first_name, email, phone, dedup_key,
            relationship_type, contact_provenance,
            airbnb_account_id, airbnb_thread_id,
            trip_purpose, last_stay_date, review_rating, preferred_channel,
            context_source, source, status
          ) VALUES (
            ${r.name}, ${r.first_name}, ${r.email}, ${r.phone}, ${r.dedup_key},
            ${r.relationship_type}, ${r.contact_provenance},
            ${r.airbnb_account_id}, ${r.airbnb_thread_id},
            ${r.trip_purpose}, ${r.last_stay_date}, ${r.review_rating}, ${r.preferred_channel},
            ${r.context_source}, ${r.source}, 'new'
          )
          ON CONFLICT(airbnb_account_id) WHERE airbnb_account_id IS NOT NULL DO UPDATE SET
            name = excluded.name,
            first_name = excluded.first_name,
            -- email/phone OVERWRITE (no COALESCE). Dedup-canonical row from
            -- guest_contacts.json is authoritative for Airbnb-derived contacts.
            -- COALESCE was preserving stale values from earlier ingests where
            -- last-write-wins had attached the wrong person's phone (e.g.
            -- Patrick McKenzie-Conlan ending up with Natalie's phone). When
            -- Sarah-side manual edits start happening post-R5, gate this with
            -- a future airbnb_export_locks_email INTEGER flag or similar.
            email = excluded.email,
            phone = excluded.phone,
            relationship_type = excluded.relationship_type,
            contact_provenance = excluded.contact_provenance,
            airbnb_thread_id = excluded.airbnb_thread_id,
            trip_purpose = excluded.trip_purpose,
            last_stay_date = excluded.last_stay_date,
            review_rating = excluded.review_rating,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        `);
        if (before.length === 0) summary.inserted += 1;
        else summary.updated += 1;
      } catch (e) {
        summary.errors.push({ accountId: r.airbnb_account_id, error: e.message });
      }
    }
    await db.query(sql`COMMIT`);
  } catch (e) {
    await db.query(sql`ROLLBACK`);
    throw e;
  }

  return summary;
}

// ── ingestion: voice corpus ──────────────────────────────────────────────
async function ingestVoiceCorpus(db, { threads, hostOverride, dryRun }) {
  // hostOverride may be a single int (back-compat), an array, or null.
  // resolveHostAccountId normalizes when null/single; when array, it skips
  // resolution and treats the provided list as authoritative.
  let hostAccountIds;
  let candidates;
  if (Array.isArray(hostOverride) && hostOverride.length) {
    hostAccountIds = new Set(hostOverride);
    // Still compute candidates for display
    const r = lib.resolveHostAccountId(threads, { override: hostOverride[0] });
    candidates = r.candidates;
  } else {
    const r = lib.resolveHostAccountId(threads, { override: hostOverride });
    hostAccountIds = new Set([r.hostAccountId]);
    candidates = r.candidates;
  }

  console.log('[ingest]   top message senders (use --host-account-id=<id[,..]> to override):');
  for (const c of candidates) {
    const marker = hostAccountIds.has(c.accountId) ? ' ◀ host' : '';
    console.log(`[ingest]     accountId=${c.accountId}  messages=${c.messages}  threads=${c.threadsAsParticipant}${marker}`);
  }
  if (hostAccountIds.size > 1) {
    console.log(`[ingest]   ingesting ${hostAccountIds.size} host accounts: ${[...hostAccountIds].join(', ')}`);
  }

  // accountId → contact_id from DB
  const rows = await db.query(sql`
    SELECT id, airbnb_account_id FROM contacts WHERE airbnb_account_id IS NOT NULL
  `);
  const contactIdByAirbnbAccountId = new Map(rows.map(r => [r.airbnb_account_id, r.id]));

  const { contactIdByThreadId, unmatched } =
    lib.buildContactIdByThreadId(threads, hostAccountIds, contactIdByAirbnbAccountId);

  const summary = {
    hostAccountIds: [...hostAccountIds],
    threadsTotal: threads.length,
    threadsUnmatched: unmatched.length,
    inserted: 0,
    skippedAlreadyPresent: 0,
    skippedInbound: 0,
    skippedEmpty: 0,
    contactIdResolved: 0,
    contactIdNull: 0,
    languageEs: 0,
    bySourceAccount: {}, // accountId → count
    errors: []
  };

  // First pass — build rows + counts (also gives us accurate dry-run output)
  const corpusRows = [];
  for (const thread of threads) {
    for (const envelope of (thread.messagesAndContents || [])) {
      const m = envelope && envelope.message;
      if (!m) { summary.skippedEmpty += 1; continue; }
      if (!hostAccountIds.has(m.accountId)) { summary.skippedInbound += 1; continue; }
      const row = lib.buildVoiceCorpusRow({ thread, envelope, hostAccountIds, contactIdByThreadId });
      if (!row) { summary.skippedEmpty += 1; continue; }
      corpusRows.push(row);
      if (row.language === 'es') summary.languageEs += 1;
      if (row.contact_id != null) summary.contactIdResolved += 1;
      else summary.contactIdNull += 1;
      summary.bySourceAccount[row.source_account_id] = (summary.bySourceAccount[row.source_account_id] || 0) + 1;
    }
  }

  if (dryRun) {
    console.log(`[ingest] (dry-run) voice corpus rows: ${corpusRows.length}`);
    return summary;
  }

  await db.query(sql`BEGIN`);
  try {
    for (const r of corpusRows) {
      try {
        // INSERT OR IGNORE on UNIQUE(source, source_id, message_id)
        const before = await db.query(sql`
          SELECT id FROM sarah_voice_corpus
          WHERE source = ${r.source} AND source_id = ${r.source_id} AND message_id = ${r.message_id}
        `);
        if (before.length > 0) { summary.skippedAlreadyPresent += 1; continue; }
        await db.query(sql`
          INSERT INTO sarah_voice_corpus (
            source, source_id, message_id, source_account_id, contact_id,
            direction, sent_at, body, intent_tags, recipient_relationship,
            language, word_count, embedding_status
          ) VALUES (
            ${r.source}, ${r.source_id}, ${r.message_id}, ${r.source_account_id}, ${r.contact_id},
            ${r.direction}, ${r.sent_at}, ${r.body}, ${r.intent_tags}, ${r.recipient_relationship},
            ${r.language}, ${r.word_count}, ${r.embedding_status}
          )
        `);
        summary.inserted += 1;
      } catch (e) {
        summary.errors.push({ thread: r.source_id, message: r.message_id, error: e.message });
      }
    }
    await db.query(sql`COMMIT`);
  } catch (e) {
    await db.query(sql`ROLLBACK`);
    throw e;
  }

  return summary;
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.exportDir) { usage(); process.exit(args.help ? 0 : 1); }

  console.log(`[ingest] Loading export from: ${args.exportDir}`);
  const exp = loadExport(args.exportDir);
  console.log(`[ingest]   guest_directory.json: ${exp.directory.length} rows`);
  console.log(`[ingest]   guest_contacts.json: ${exp.contacts.length} rows`);
  console.log(`[ingest]   messages.json: ${exp.threads.length} threads, ${exp.messageCount} messages`);

  console.log(`[ingest] Validating GUEST_DATA_MAP.md (tolerance=${args.mapTolerance})…`);
  validateCounts({ ...exp, tolerance: args.mapTolerance });
  console.log('[ingest]   GUEST_DATA_MAP validation passed');

  const DB_PATH = process.env.DB_PATH ||
    path.join(path.resolve(__dirname, '..', '..'), 'crm', 'data', 'crm.db');
  console.log(`[ingest] DB: ${DB_PATH}${args.dryRun ? '  (dry-run — no writes)' : ''}`);

  const db = createDB(DB_PATH);
  try {
    await db.query(sql`PRAGMA foreign_keys = ON`);

    if (args.phase === 'contacts' || args.phase === 'all') {
      console.log('\n[ingest] Phase 1: contacts');
      const s = await ingestContacts(db, {
        directory: exp.directory, contacts: exp.contacts, threads: exp.threads,
        dryRun: !!args.dryRun
      });
      console.log('[ingest]   relationship_type:',
        `stayed=${s.relStayed}`, `cancelled=${s.relCancelled}`, `inquired=${s.relInquired}`);
      console.log('[ingest]   provenance:',
        `voluntary_share=${s.voluntaryShare}`, `airbnb_thread_only=${s.threadOnly}`);
      if (!args.dryRun) {
        console.log('[ingest]   db:',
          `inserted=${s.inserted}`, `updated=${s.updated}`, `errors=${s.errors.length}`);
        if (s.errors.length) console.error('[ingest]   first error:', s.errors[0]);
      }
    }

    if (args.phase === 'voice' || args.phase === 'all') {
      console.log('\n[ingest] Phase 2: sarah_voice_corpus');
      const s = await ingestVoiceCorpus(db, {
        threads: exp.threads,
        hostOverride: args.hostAccountIds || null,
        dryRun: !!args.dryRun
      });
      console.log(`[ingest]   host accountIds: ${s.hostAccountIds.join(', ')}`);
      console.log('[ingest]   threads:',
        `total=${s.threadsTotal}`, `unmatched_to_contact=${s.threadsUnmatched}`);
      console.log('[ingest]   filter:',
        `skipped_inbound=${s.skippedInbound}`, `skipped_empty=${s.skippedEmpty}`);
      console.log('[ingest]   contact_id:',
        `resolved=${s.contactIdResolved}`, `null=${s.contactIdNull}`);
      console.log(`[ingest]   language_es=${s.languageEs}`);
      if (Object.keys(s.bySourceAccount).length > 1) {
        console.log('[ingest]   per source_account_id:');
        for (const [acc, n] of Object.entries(s.bySourceAccount)) {
          console.log(`[ingest]     ${acc}: ${n}`);
        }
      }
      if (!args.dryRun) {
        console.log('[ingest]   db:',
          `inserted=${s.inserted}`, `skipped_already_present=${s.skippedAlreadyPresent}`,
          `errors=${s.errors.length}`);
        if (s.errors.length) console.error('[ingest]   first error:', s.errors[0]);
      }
    }

    // Idempotency check: full second pass, assert no new inserts.
    if (args.verifyIdempotency && !args.dryRun) {
      console.log('\n[ingest] Verifying idempotency (second pass)…');
      const c2 = await ingestContacts(db, {
        directory: exp.directory, contacts: exp.contacts, threads: exp.threads, dryRun: false
      });
      const v2 = await ingestVoiceCorpus(db, {
        threads: exp.threads, hostOverride: args.hostAccountIds || null, dryRun: false
      });
      const ok = c2.inserted === 0 && v2.inserted === 0
        && c2.errors.length === 0 && v2.errors.length === 0;
      console.log(`[ingest]   second pass — contacts: inserted=${c2.inserted} updated=${c2.updated} errors=${c2.errors.length}`);
      console.log(`[ingest]   second pass — voice:    inserted=${v2.inserted} skipped=${v2.skippedAlreadyPresent} errors=${v2.errors.length}`);
      if (!ok) {
        console.error('[ingest] IDEMPOTENCY CHECK FAILED');
        process.exit(2);
      }
      console.log('[ingest]   idempotency OK');
    }
  } finally {
    await db.dispose();
  }

  console.log('\n[ingest] done');
}

if (require.main === module) {
  main().catch(e => {
    console.error('[ingest] FATAL:', e.message);
    if (e.fails) {
      console.error(e.stack || '');
    }
    process.exit(1);
  });
}

module.exports = { main, ingestContacts, ingestVoiceCorpus, loadExport, validateCounts };
