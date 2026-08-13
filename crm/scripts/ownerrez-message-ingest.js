#!/usr/bin/env node
/**
 * ownerrez-message-ingest.js — Pull OwnerRez message threads and ingest
 * Sarah's replies into the sarah_voice_corpus for voice model training.
 *
 * Walks all inquiry thread_ids, pulls messages via GET /v2/messages?threadId=X,
 * filters for co_host replies (Sarah's), and upserts them into the
 * sarah_voice_corpus table with source='ownerrez_messages'.
 *
 * The Chroma embedding step is handled separately by index-voice-corpus.js
 * (same as the original Airbnb import — it picks up rows where
 * embedding_status='pending').
 *
 * Usage:
 *   node ownerrez-message-ingest.js              # incremental (since last run)
 *   node ownerrez-message-ingest.js --full        # all threads
 *   node ownerrez-message-ingest.js --thread 123  # one thread
 *   node ownerrez-message-ingest.js --dry-run     # print only
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');
const { ensureSchemaBetterSqlite } = require('../lib/workflow-schema');
const { loadPolicy } = require('../lib/channel-policy');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const DB_PATH = path.join(REPO_ROOT, 'crm', 'data', 'crm.db');
const STATE_PATH = path.join(REPO_ROOT, 'memory', 'ownerrez-message-ingest-state.json');

const SECRETS = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'ownerrez.json'), 'utf8'));
const TOKEN = SECRETS.access_token;
const UA = 'OpenClaw LPDS/1.0';

const DRY_RUN = process.argv.includes('--dry-run');

// ─── API ─────────────────────────────────────────────────────────────────────
function apiGet(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const fullPath = `/v2/${endpoint}${qs ? '?' + qs : ''}`;
    const req = https.request({
      hostname: 'api.ownerrez.com', path: fullPath, method: 'GET',
      headers: {
        'Authorization': `bearer ${TOKEN}`,
        'User-Agent': UA,
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status_code && parsed.status_code >= 400) {
            reject(new Error(`API ${parsed.status_code}: ${parsed.messages?.join(', ')}`));
          } else { resolve(parsed); }
        } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── State ───────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { last_inquiry_since: null, processed_thread_ids: [], last_run: null }; }
}
function saveState(state) {
  state.last_run = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── DB ──────────────────────────────────────────────────────────────────────
function ensureTable(db) {
  // Check if sarah_voice_corpus exists
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sarah_voice_corpus'"
  ).get();
  if (!exists) {
    console.error('[message-ingest] sarah_voice_corpus table does not exist. Run the voice corpus setup first.');
    process.exit(1);
  }
}

function getExistingMessageIds(db) {
  const rows = db.prepare(
    "SELECT message_id FROM sarah_voice_corpus WHERE source = 'ownerrez_messages' AND message_id IS NOT NULL"
  ).all();
  return new Set(rows.map(r => r.message_id));
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  const args = process.argv.slice(2);
  const requestedMessageIndex = args.indexOf('--message-id');
  const requestedMessageId = requestedMessageIndex >= 0
    ? String(args[requestedMessageIndex + 1] || '').trim() : null;
  if (requestedMessageIndex >= 0 && !requestedMessageId) {
    throw new Error('--message-id requires an OwnerRez message id');
  }
  const strictThreadRun = args.includes('--thread');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.transaction(() => ensureSchemaBetterSqlite(db))();
  ensureTable(db);
  const sarahEmailChannel = Object.entries(loadPolicy().channels || {})
    .find(([, channel]) => channel.name === 'sarah-email')?.[0] || null;

  // Check the schema of sarah_voice_corpus so we insert correctly
  const cols = db.prepare("PRAGMA table_info(sarah_voice_corpus)").all();
  const colNames = new Set(cols.map(c => c.name));
  console.log(`[message-ingest] sarah_voice_corpus columns: ${[...colNames].join(', ')}`);

  const existingIds = getExistingMessageIds(db);
  console.log(`[message-ingest] ${existingIds.size} existing OwnerRez messages in corpus`);

  const state = loadState();
  let threadIds = [];

  if (args.includes('--thread')) {
    const idx = args.indexOf('--thread');
    threadIds = [parseInt(args[idx + 1])];
  } else {
    // Get all inquiry threads
    const since = args.includes('--full')
      ? '2020-01-01T00:00:00Z'
      : (state.last_inquiry_since || '2020-01-01T00:00:00Z');

    console.log(`[message-ingest] Fetching inquiries since ${since}`);
    const inquiries = await apiGet('inquiries', { since_utc: since });
    const items = inquiries.items || [];

    for (const inq of items) {
      if (inq.thread_ids && inq.thread_ids.length > 0) {
        threadIds.push(...inq.thread_ids);
      }
    }

    // Also get threads from bookings (some bookings have threads)
    const bookings = await apiGet('bookings', {
      property_ids: '455776,456957,456958,456959,456960,456961,456962,456963',
      since_utc: since,
      limit: '100',
    });
    // Bookings don't have thread_ids directly, but we can check via inquiries

    // Update watermark
    if (items.length > 0) {
      const newest = items.reduce((a, b) =>
        (b.created_utc || '') > (a.created_utc || '') ? b : a
      );
      state.last_inquiry_since = newest.created_utc;
    }

    // Deduplicate
    threadIds = [...new Set(threadIds)];
  }

  console.log(`[message-ingest] ${threadIds.length} threads to process`);

  const stats = {
    threads: 0, messages_total: 0, sarah_replies: 0, ingested: 0, skipped: 0,
    ledger_ingested: 0, ledger_existing: 0, thread_errors: 0,
  };
  const threadErrors = [];

  for (const tid of threadIds) {
    try {
      const result = await apiGet('messages', { threadId: String(tid) });
      const allMessages = result.items || [];
      const messages = requestedMessageId
        ? allMessages.filter(message => String(message.id) === requestedMessageId)
        : allMessages;
      if (requestedMessageId && !messages.length) {
        throw new Error(`message ${requestedMessageId} was not visible on thread ${tid}`);
      }
      const thread = result.thread || {};
      const guest = result.guest || {};
      const guestName = [guest.first_name, guest.last_name].filter(Boolean).join(' ') || 'Unknown';
      const channel = thread.channel || 'unknown';

      stats.threads++;
      stats.messages_total += messages.length;

      if (sarahEmailChannel && !DRY_RUN) {
        const contact = guest.id
          ? db.prepare('SELECT id FROM contacts WHERE ownerrez_guest_id = ? LIMIT 1').get(guest.id)
          : null;
        const lead = guest.id
          ? db.prepare(`SELECT id FROM leads WHERE ownerrez_guest_id = ?
              ORDER BY created_at DESC, id DESC LIMIT 1`).get(guest.id)
          : null;
        const metadata = JSON.stringify({
          channel,
          threadType: thread.type || null,
          inquiryId: thread.inquiry_id || null,
          bookingId: thread.booking_id || null,
          propertyId: thread.property_id || null,
          guestId: guest.id || null,
        });
        const insertLedger = db.prepare(`INSERT OR IGNORE INTO email_threads (
          contact_id, crm_lead_id, direction, subject, body_text, from_address, sender_name,
          to_address, received_at, provider, provider_message_id,
          provider_thread_id, provider_metadata_json, raw_body_text,
          processing_status, slack_channel_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ownerrez', ?, ?, ?, ?, 'pending', ?)`);
        for (const msg of messages) {
          if (msg.is_draft || !msg.id || !String(msg.body || '').trim()) continue;
          const inbound = ['guest', 'cotraveler', 'third_party_booker'].includes(msg.from_role);
          const body = String(msg.body).trim();
          const result = insertLedger.run(
            contact?.id || null,
            lead?.id || null,
            inbound ? 'inbound' : 'outbound',
            `${String(channel).replace(/^./, value => value.toUpperCase())} guest conversation`,
            body,
            inbound ? `ownerrez:${msg.from_role}:${msg.from_contact_id || guest.id || 'guest'}` : 'ownerrez:host',
            inbound ? guestName : 'Sarah / Resort team',
            inbound ? 'ownerrez:host' : `ownerrez:guest:${guest.id || 'unknown'}`,
            msg.date_utc || new Date().toISOString(),
            String(msg.id),
            String(tid),
            metadata,
            body,
            sarahEmailChannel,
          );
          if (result.changes) stats.ledger_ingested++;
          else stats.ledger_existing++;
        }
      }

      for (const msg of messages) {
        // Only ingest Sarah's replies (co_host role)
        if (msg.from_role !== 'co_host') continue;
        if (!msg.body || msg.body.trim().length < 20) continue; // skip trivial messages
        if (msg.is_draft) continue;

        stats.sarah_replies++;
        const messageId = `ownerrez_${msg.id}`;

        if (existingIds.has(messageId)) {
          stats.skipped++;
          continue;
        }

        if (DRY_RUN) {
          console.log(`[DRY] Would ingest msg ${msg.id} (${msg.body.substring(0, 60)}...)`);
          stats.ingested++;
          continue;
        }

        try {
          const body = msg.body.trim();
          const wordCount = body.split(/\s+/).length;
          db.prepare(`
            INSERT INTO sarah_voice_corpus (
              source, source_id, message_id, direction, sent_at,
              body, language, word_count, embedding_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
          `).run(
            'ownerrez_messages',
            `thread_${tid}_${channel}`,
            messageId,
            'outbound',
            msg.date_utc,
            body,
            detectLanguage(body),
            wordCount,
          );
          stats.ingested++;
          existingIds.add(messageId);
        } catch (e) {
          if (/UNIQUE constraint/i.test(e.message)) {
            stats.skipped++;
          } else {
            console.error(`[message-ingest] Insert error for msg ${msg.id}:`, e.message);
          }
        }
      }

      // Be nice to the API
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      stats.thread_errors++;
      threadErrors.push(`thread ${tid}: ${e.message}`);
      console.warn(`[message-ingest] Thread ${tid} error:`, e.message);
    }
  }

  if (!DRY_RUN) {
    saveState(state);
  }

  db.close();
  if (strictThreadRun && threadErrors.length) {
    throw new Error(`targeted OwnerRez message ingest failed: ${threadErrors.join('; ')}`);
  }
  console.log(`[message-ingest] Done:`, stats);

  if (stats.ingested > 0) {
    console.log(`[message-ingest] Run 'node crm/scripts/index-voice-corpus.js' to embed the new messages.`);
  }

  return stats;
}

/**
 * Simple language detection — Spanish vs English.
 * The voice corpus indexes by language and only embeds English ('en') messages.
 */
function detectLanguage(text) {
  const spanishIndicators = /\b(hola|gracias|por favor|buenos|buenas|está|tenemos|puede|villa|reserva|cómo|qué|usted|nosotros|también)\b/i;
  const spanishRatio = (text.match(spanishIndicators) || []).length;
  return spanishRatio >= 2 ? 'es' : 'en';
}

run().then(stats => {
  console.log(JSON.stringify(stats));
  process.exit(0);
}).catch(e => {
  console.error('[message-ingest] Fatal:', e);
  process.exit(1);
});
