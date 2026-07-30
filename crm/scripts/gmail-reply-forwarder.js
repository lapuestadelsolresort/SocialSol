#!/usr/bin/env node
'use strict';
//
// crm/scripts/gmail-reply-forwarder.js — poll Sarah's Gmail inbox and POST
// new replies to /webhook/resend-reply.
//
// Runs every 5 minutes from com.lapuestadelsolresort.gmail-reply-forwarder.
// Looks back SINCE_MINUTES via Gmail (gmail.readonly, service-account DWD,
// no read-state mutation). Dedupes on Gmail internal message ID via the
// processed_gmail_replies table (migration 013).
//
// Matching strategy:
//   1. Primary: from-address lookup in contacts table.
//   2. Fallback (unmatched sender): strip 'Re:' from subject, find the
//      outreach_send with that subject, inherit the original contact's
//      company/context, upsert a new contact for the replier, mark the
//      send replied, and post a Slack confirmation.
//
// Flags:
//   --dry-run   List inbox candidates, no POST, no DB writes.

const path = require('path');
const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { searchInboxSince } = require('../lib/gmail-client');
const { postToChannel } = require('../../prospector/research/scripts/lib/slack');

const ALERT_CHANNEL = process.env.PROSPECTOR_SLACK_CHANNEL || '';

const SINCE_MINUTES = 60;
const WEBHOOK_URL = process.env.RESEND_REPLY_WEBHOOK_URL || 'http://127.0.0.1:3456/webhook/resend-reply';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'crm', 'data', 'crm.db');

const DRY_RUN = process.argv.includes('--dry-run');

function openDb() {
  return createDB(DB_PATH);
}

async function loadKnownContactEmails(db) {
  const rows = await db.query(sql`
    SELECT LOWER(email) AS email FROM contacts WHERE email IS NOT NULL
  `);
  return new Set(rows.map((r) => r.email).filter(Boolean));
}

async function alreadyProcessed(db, messageId) {
  const rows = await db.query(sql`
    SELECT 1 FROM processed_gmail_replies WHERE message_id = ${messageId} LIMIT 1
  `);
  return rows.length > 0;
}

async function recordProcessed(db, { messageId, sendId, matched }) {
  const now = new Date().toISOString();
  await db.query(sql`
    INSERT INTO processed_gmail_replies (message_id, forwarded_at, send_id, matched)
    VALUES (${messageId}, ${now}, ${sendId}, ${matched ? 1 : 0})
  `);
}

async function postReply(fromAddress, text) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromAddress, text }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = null;
  }
  return { status: res.status, body };
}

async function run() {
  if (DRY_RUN) console.log('[gmail-reply-forwarder] DRY-RUN — no POSTs, no DB writes');

  let messages;
  try {
    messages = await searchInboxSince(SINCE_MINUTES);
  } catch (e) {
    console.error('[gmail-reply-forwarder] Gmail search failed:', e.message);
    process.exit(1);
  }

  console.log(`[gmail-reply-forwarder] inbox messages found in last ${SINCE_MINUTES}m: ${messages.length}`);

  // Only process emails that are actual replies (have In-Reply-To header).
  // This prevents Sarah's unrelated inbox mail (newsletters, vendor emails, etc.)
  // from being logged as unmatched noise. We only care about responses to our
  // cold outreach from outreach.lapuestadelsol.com.
  const replies = messages.filter((m) => !!m.inReplyTo);
  console.log(`[gmail-reply-forwarder] reply candidates (have In-Reply-To): ${replies.length}`);

  if (DRY_RUN) {
    for (const m of replies) {
      console.log(`  - id=${m.id} from=${m.from && m.from.address} subject=${(m.subject || '').slice(0, 80)} inReplyTo=${(m.inReplyTo || '').slice(0, 60)}`);
    }
    console.log(`[gmail-reply-forwarder] scanned=${messages.length} reply_candidates=${replies.length} (dry-run, no DB / webhook)`);
    return;
  }

  const db = openDb();
  let forwarded = 0;
  let matched = 0;
  let skipped = 0;

  try {
    const knownEmails = await loadKnownContactEmails(db);

    for (const m of replies) {
      try {
        if (await alreadyProcessed(db, m.id)) {
          skipped++;
          continue;
        }

        const fromAddr = (m.from && m.from.address || '').toLowerCase();
        if (!fromAddr || !knownEmails.has(fromAddr)) {
          // --- Fallback: try to resolve via subject → outreach_send → original contact ---
          const resolved = await resolveUnmatchedReply(db, m);
          if (resolved) {
            await recordProcessed(db, { messageId: m.id, sendId: resolved.sendId, matched: true });
            matched++;
            forwarded++;
          } else {
            await recordProcessed(db, { messageId: m.id, sendId: null, matched: false });
            // Truly unresolvable — post alert so nothing is silently lost
            const displayName = (m.from && m.from.name) ? `${m.from.name} <${m.from.address}>` : (m.from && m.from.address || 'unknown');
            const snippet = (m.text || '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
            const alertMsg = `:warning: *Unresolvable reply in Sarah's inbox* — couldn't match to any outreach\n*From:* ${displayName}\n*Subject:* ${m.subject || '(no subject)'}\n*Preview:* ${snippet || '(empty)'}\n_Manual review needed._`;
            postToChannel(ALERT_CHANNEL, alertMsg).catch((e) =>
              console.error('[gmail-reply-forwarder] slack alert failed:', e.message)
            );
            skipped++;
          }
          continue;
        }

        const { status, body } = await postReply(m.from.address, m.text || '');
        const sendId = body && typeof body.send_id === 'number' ? body.send_id : null;
        const wasMatched = !!(body && body.matched);

        await recordProcessed(db, { messageId: m.id, sendId, matched: wasMatched });
        forwarded++;
        if (wasMatched) matched++;

        console.log(
          `[gmail-reply-forwarder] forwarded id=${m.id} from=${fromAddr} ` +
          `http=${status} matched=${wasMatched} send_id=${sendId}`
        );
      } catch (e) {
        console.error(`[gmail-reply-forwarder] message ${m.id} failed:`, e.message);
      }
    }
  } finally {
    await db.dispose();
  }

  console.log(
    `[gmail-reply-forwarder] scanned=${messages.length} reply_candidates=${replies.length} forwarded=${forwarded} ` +
    `matched=${matched} skipped=${skipped}`
  );
}

// ---------------------------------------------------------------------------
// resolveUnmatchedReply — fallback for replies from unknown senders.
// Strips 'Re:' from subject, finds the matching outreach_send, inherits
// original contact's company/context, upserts new contact as primary,
// marks the send replied, and posts a Slack confirmation.
// ---------------------------------------------------------------------------
async function resolveUnmatchedReply(db, m) {
  const rawSubject = (m.subject || '').trim();
  // Strip one or more 'Re:' / 'RE:' prefixes
  const baseSubject = rawSubject.replace(/^(re:\s*)+/i, '').trim();
  if (!baseSubject) return null;

  // Find most-recent outreach_send whose subject matches (after stripping Re:)
  const sendRows = await db.query(sql`
    SELECT os.id AS send_id, os.subject, os.contact_id,
           c.name AS orig_name, c.email AS orig_email,
           c.company, c.title, c.geography, c.source, c.context_source,
           c.specialties, c.website
    FROM outreach_sends os
    JOIN contacts c ON c.id = os.contact_id
    WHERE LOWER(TRIM(os.subject)) = LOWER(${baseSubject})
       OR LOWER(TRIM(os.subject)) = LOWER(${rawSubject})
    ORDER BY os.sent_at DESC
    LIMIT 1
  `);

  if (!sendRows.length) {
    console.log(`[gmail-reply-forwarder] subject-match miss for: "${baseSubject}"`);
    return null;
  }

  const send = sendRows[0];
  const fromAddr = (m.from && m.from.address || '').toLowerCase();
  const fromName = (m.from && m.from.name) || fromAddr.split('@')[0];
  const now = new Date().toISOString();

  if (DRY_RUN) {
    console.log(`[gmail-reply-forwarder] DRY-RUN resolveUnmatched: would upsert contact ${fromName} <${fromAddr}> linked to send #${send.send_id} (orig: ${send.orig_name})`);
    return { sendId: send.send_id };
  }

  // Upsert new contact — inherit company/context from original
  const dedup = fromAddr || fromName.toLowerCase();
  const existing = await db.query(sql`SELECT id FROM contacts WHERE dedup_key = LOWER(${dedup}) LIMIT 1`);

  let newContactId;
  if (existing.length) {
    newContactId = existing[0].id;
    await db.query(sql`
      UPDATE contacts SET
        name = ${fromName},
        email = ${m.from.address},
        company = COALESCE(NULLIF(company, ''), ${send.company}),
        status = 'replied',
        reply_status = 'positive',
        updated_at = ${now}
      WHERE id = ${newContactId}
    `);
  } else {
    // Parse first/last name best-effort
    const parts = fromName.trim().split(/\s+/);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';

    const result = await db.query(sql`
      INSERT INTO contacts
        (name, first_name, last_name, email, dedup_key, company, title,
         geography, specialties, website, source, context_source,
         status, reply_status, notes, created_at, updated_at)
      VALUES
        (${fromName}, ${firstName}, ${lastName}, ${m.from.address}, LOWER(${dedup}),
         ${send.company || ''}, ${send.title || ''},
         ${send.geography || ''}, ${send.specialties || ''}, ${send.website || ''},
         ${send.source || 'inbound_reply'}, ${send.context_source || 'inbound_reply'},
         'replied', 'positive',
         ${`Auto-created from unmatched reply to send #${send.send_id} (original contact: ${send.orig_name} <${send.orig_email}>). Now primary contact for ${send.company || 'this account'}.`},
         ${now}, ${now})
    `);
    newContactId = result[0] && result[0].id;
  }

  // Mark original contact as replied too (so account isn't orphaned)
  await db.query(sql`
    UPDATE contacts SET status = 'replied', updated_at = ${now}
    WHERE id = ${send.contact_id} AND status != 'replied'
  `);

  // Mark the send as replied
  await db.query(sql`
    UPDATE outreach_sends SET
      reply_detected_at = ${now},
      status = 'replied'
    WHERE id = ${send.send_id}
  `);

  // Post confirmation to Slack
  const snippet = (m.text || '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
  const msg =
    `:white_check_mark: *New reply auto-linked* — ${fromName} <${m.from.address}>\n` +
    `*Company:* ${send.company || '(unknown)'}\n` +
    `*Re:* ${baseSubject}\n` +
    `*Preview:* ${snippet || '(empty)'}\n` +
    `_Contact created/updated in CRM. Now primary contact for ${send.company || 'this account'}. Original send #${send.send_id} marked replied._`;
  postToChannel(ALERT_CHANNEL, msg).catch((e) =>
    console.error('[gmail-reply-forwarder] slack notify failed:', e.message)
  );

  console.log(
    `[gmail-reply-forwarder] auto-resolved unmatched reply: ${fromAddr} → send #${send.send_id} (${send.orig_name}), new contact id=${newContactId}`
  );
  return { sendId: send.send_id };
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[gmail-reply-forwarder] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run };
