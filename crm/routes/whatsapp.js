/**
 * WhatsApp Bridge via Twilio
 *
 * Incoming: Twilio POSTs to /webhook/twilio-whatsapp on each inbound message.
 * We store it in meta_messages (platform='whatsapp'), post to #social-sol as
 * a Slack message, and store the Slack thread ts so replies in that thread
 * automatically go back to WhatsApp.
 *
 * Outbound: POST /api/whatsapp/reply { dm_id, message }
 * Sends via Twilio REST API.
 *
 * Thread bridge: POST /api/whatsapp/thread-reply { thread_ts, message }
 * Called by Sol when someone replies in a WhatsApp notification thread.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { verifyTwilioSignature } = require('../lib/webhook-auth');
const { sendVerifiedLead } = require('../lib/meta-capi');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_DIR = process.env.SOCIALSOL_SECRETS_DIR || path.join(REPO_ROOT, 'secrets');
const SECRETS_PATH = path.join(SECRETS_DIR, 'twilio.json');
const SOCIAL_SOL_CHANNEL = process.env.RESORT_SOCIAL_CHANNEL || '';
const WHATSAPP_CHANNEL = process.env.RESORT_WHATSAPP_CHANNEL || SOCIAL_SOL_CHANNEL;
const OPENCLAW = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const SLACK_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';
const DEFAULT_WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL
  || 'https://webhook.lapuestadelsolresort.com/webhook/twilio-whatsapp/webhook';
const MAX_MESSAGE_LENGTH = 4096;

function loadTwilioSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')); }
  catch { return {}; }
}

/** Post to Slack and return the message ts (for threading). */
function postToSlack(message) {
  return new Promise((resolve) => {
    if (!WHATSAPP_CHANNEL || !SLACK_ACCOUNT) {
      console.warn('[whatsapp] Slack integration is not configured');
      resolve(null);
      return;
    }
    execFile(OPENCLAW, [
      'message', 'send',
      '--channel', 'slack',
      '--account', SLACK_ACCOUNT,
      '--target', `channel:${WHATSAPP_CHANNEL}`,
      '--message', message,
      '--json',
    ], { timeout: 12000 }, (err, stdout) => {
      if (err) {
        console.warn('[whatsapp] Slack post failed:', err.message);
        resolve(null);
        return;
      }
      // Try to extract message ts from JSON output
      try {
        const parsed = JSON.parse(stdout);
        const ts = parsed.ts || parsed.message_id || parsed.messageId
          || parsed.payload?.result?.messageId
          || parsed.payload?.result?.receipt?.primaryPlatformMessageId
          || null;
        resolve(ts);
      } catch {
        // Try regex fallback
        const match = (stdout || '').match(/"(?:ts|message_id|messageId|primaryPlatformMessageId)"\s*:\s*"([^"]+)"/);
        resolve(match ? match[1] : null);
      }
    });
  });
}

/** Send a WhatsApp message via Twilio. */
async function sendWhatsApp(toPhone, message) {
  const secrets = loadTwilioSecrets();
  if (!secrets.account_sid || !secrets.api_key_sid || !secrets.api_key_secret) {
    throw new Error('Twilio credentials not configured');
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${secrets.account_sid}/Messages.json`;
  const authHeader = 'Basic ' + Buffer.from(`${secrets.api_key_sid}:${secrets.api_key_secret}`).toString('base64');

  const formBody = new URLSearchParams({
    From: `whatsapp:${secrets.whatsapp_number}`,
    To: `whatsapp:${toPhone}`,
    Body: message,
  });

  const resp = await fetch(twilioUrl, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody.toString(),
    signal: AbortSignal.timeout(12000),
  });

  const result = await resp.json().catch(() => ({}));
  if (!resp.ok || result.code || (result.status && result.status >= 400)) {
    throw new Error(result.message || 'Twilio send failed');
  }
  return result;
}

function buildRouter(getDb) {
  const express = require('express');
  const router = express.Router();
  const { sql } = require('@databases/sqlite');

  // ─── Twilio Webhook (incoming WhatsApp messages) ─────────────────────────
  router.post('/webhook', express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }), async (req, res) => {
    const secrets = loadTwilioSecrets();
    const body = req.body || {};
    const webhookUrl = secrets.twilio_webhook_url || DEFAULT_WEBHOOK_URL;
    if (!secrets.auth_token || !secrets.account_sid) {
      console.error('[whatsapp] Twilio webhook verification unavailable');
      return res.status(503).type('text/xml').send('<Response></Response>');
    }
    if (
      body.AccountSid !== secrets.account_sid ||
      !verifyTwilioSignature(webhookUrl, body, secrets.auth_token, req.headers['x-twilio-signature'])
    ) {
      console.warn('[whatsapp] Rejected invalid Twilio webhook signature');
      return res.status(403).type('text/xml').send('<Response></Response>');
    }

    const from = body.From || '';
    const text = String(body.Body || '').slice(0, MAX_MESSAGE_LENGTH);
    const messageSid = body.MessageSid || body.SmsSid || null;
    const numMedia = Math.min(Math.max(parseInt(body.NumMedia, 10) || 0, 0), 10);
    const profileName = body.ProfileName ? String(body.ProfileName).slice(0, 200) : null;

    const senderPhone = from.replace('whatsapp:', '');
    const senderName = profileName || senderPhone;

    if (!/^whatsapp:\+\d{7,15}$/.test(from) || (!text && numMedia === 0)) {
      return res.status(400).type('text/xml').send('<Response></Response>');
    }

    res.status(200).type('text/xml').send('<Response></Response>');

    console.log(`[whatsapp] Incoming from ${senderName} (${senderPhone}): ${(text || '[media]').slice(0, 80)}`);

    const db = getDb();
    if (!db) return;

    try {
      // Deduplicate
      if (messageSid) {
        const [{ n }] = await db.query(sql`SELECT COUNT(*) n FROM meta_messages WHERE message_id = ${messageSid}`);
        if (n > 0) return;
      }

      const now = new Date().toISOString();
      const mediaNote = numMedia > 0 ? ` [+${numMedia} media]` : '';
      const fullText = text + mediaNote;

      const mediaUrls = [];
      for (let i = 0; i < numMedia; i++) {
        const url = body[`MediaUrl${i}`];
        if (url) mediaUrls.push(url);
      }

      const safePayload = {
        MessageSid: messageSid,
        AccountSid: body.AccountSid,
        From: from,
        To: body.To || null,
        ProfileName: profileName,
        NumMedia: numMedia,
        _mediaUrls: mediaUrls,
      };
      await db.query(sql`
        INSERT OR IGNORE INTO meta_messages (platform, sender_id, sender_name, message_id, message_text, received_at, raw_payload)
        VALUES ('whatsapp', ${senderPhone}, ${senderName}, ${messageSid}, ${fullText}, ${now}, ${JSON.stringify(safePayload)})
      `);

      const rows = await db.query(sql`
        SELECT id FROM meta_messages
        WHERE message_id = ${messageSid || ''}
           OR (sender_id = ${senderPhone} AND received_at = ${now})
        ORDER BY id DESC LIMIT 1
      `);
      const dmRowId = rows[0]?.id || null;

      // ─── Auto-create CRM lead on first contact ────────────────────────────
      let leadCreated = false;
      let verifiedLead = null;
      if (senderPhone && senderPhone !== '+10005551234') {
        try {
          const refMatch = text.match(/\bLPDS-([A-Z0-9]{12,24})\b/i);
          const whatsappRef = refMatch ? refMatch[1].toUpperCase() : null;
          let [session] = whatsappRef ? await db.query(sql`
            SELECT id, page_slug, utm_source, utm_medium, utm_campaign, utm_content
            FROM page_sessions WHERE whatsapp_ref = ${whatsappRef} LIMIT 1
          `) : [];
          let attrMethod = session ? 'ref' : 'unattributed';

          // ── Session-ID prefix fallback (ref is first 16 hex of UUID) ──
          if (!session && whatsappRef && whatsappRef.length >= 16) {
            const hex = whatsappRef.toLowerCase();
            // Reconstruct UUID prefix: xxxxxxxx-xxxx-xxxx (8-4-4)
            const uuidPrefix = hex.length >= 16
              ? `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}%`
              : null;
            if (uuidPrefix) {
              const [idSession] = await db.query(sql`
                SELECT id, page_slug, utm_source, utm_medium, utm_campaign, utm_content
                FROM page_sessions WHERE id LIKE ${uuidPrefix} ORDER BY created_at DESC LIMIT 1
              `);
              if (idSession) {
                session = idSession;
                attrMethod = 'session-id-prefix';
              }
            }
          }

          // Never guess attribution from a global time window. Without an
          // exact LPDS reference this inbound message remains unattributed.
          console.log(`[whatsapp] Attribution for ${senderPhone}: method=${attrMethod} session=${session?.id || 'none'}`);

          const source = session
            ? (String(session.utm_source || '').toLowerCase() === 'meta' ? 'meta_ad' : 'whatsapp')
            : 'whatsapp';
          const utmSource = session?.utm_source || 'whatsapp';
          const utmMedium = session?.utm_medium || 'direct';
          const utmCampaign = session?.utm_campaign || null;
          const campaignName = utmCampaign || session?.page_slug || null;

          const [{ n: beforeCount }] = await db.query(sql`
            SELECT COUNT(*) n FROM leads WHERE phone = ${senderPhone}
          `);
          await db.query(sql`
            INSERT INTO leads (
              name, phone, source, campaign_name, status, inquiry_message, notes,
              utm_source, utm_medium, utm_campaign
            )
            SELECT
              ${senderName}, ${senderPhone}, ${source}, ${campaignName}, 'new',
              ${fullText.slice(0, 500)}, ${'Auto-created from WhatsApp message on ' + now},
              ${utmSource}, ${utmMedium}, ${utmCampaign}
            WHERE NOT EXISTS (SELECT 1 FROM leads WHERE phone = ${senderPhone})
          `);
          leadCreated = beforeCount === 0;
          const [lead] = await db.query(sql`
            SELECT id FROM leads WHERE phone = ${senderPhone} ORDER BY id DESC LIMIT 1
          `);

          if (leadCreated) {
            console.log(`[whatsapp] Auto-created CRM lead for ${senderName} (${senderPhone})`);
            verifiedLead = {
              eventId: `twilio-${messageSid || dmRowId}`,
              eventTime: now,
              phone: senderPhone,
              campaign: campaignName,
              utmCampaign,
              pageSlug: session?.page_slug || null,
            };
          }
          if (session && lead) {
            await db.query(sql`
              UPDATE page_sessions
              SET lead_id = ${lead.id}, converted = 1, last_seen = datetime('now')
              WHERE id = ${session.id}
            `);
            await db.query(sql`
              INSERT INTO attribution_events (
                session_id, lead_id, event_type, channel, campaign,
                utm_source, utm_medium, utm_campaign, meta
              ) VALUES (
                ${session.id}, ${lead.id}, 'whatsapp_lead', 'whatsapp',
                ${utmCampaign || session.page_slug || null},
                ${session.utm_source || null}, ${session.utm_medium || null},
                ${session.utm_campaign || null},
                ${JSON.stringify({ whatsapp_ref: whatsappRef, attribution_method: attrMethod, message_id: messageSid })}
              )
            `);
          }
        } catch (leadErr) {
          console.warn('[whatsapp] Lead auto-creation failed:', leadErr.message);
        }
      }

      // A real first inbound conversation is the conversion. Send server-side
      // after durable CRM storage; failures are audited and never lose the lead.
      if (verifiedLead) {
        try {
          await sendVerifiedLead({ db, sql, ...verifiedLead });
          console.log(`[whatsapp] Meta CAPI Lead delivered (${verifiedLead.eventId})`);
        } catch (capiErr) {
          console.warn('[whatsapp] Meta CAPI delivery failed:', capiErr.message);
        }
      }

      // Post to #social-sol
      const leadTag = leadCreated ? ' 🆕 *New lead*' : '';
      const preview = fullText.length > 300 ? fullText.slice(0, 300) + '…' : fullText;
      const slackMsg = `📱 *WhatsApp from ${senderName}* (${senderPhone}) [wa-${dmRowId}]:${leadTag}\n${preview}\n_Reply in this thread to respond via WhatsApp — use_ \`!wa ${dmRowId} your message\` _or just reply in the thread_`;

      const slackTs = await postToSlack(slackMsg);

      // Store the Slack thread ts so thread replies map back
      if (slackTs && dmRowId) {
        await db.query(sql`UPDATE meta_messages SET slack_thread_ts = ${slackTs} WHERE id = ${dmRowId}`);
        console.log(`[whatsapp] Stored slack_thread_ts=${slackTs} for wa-${dmRowId}`);
      }
    } catch (err) {
      console.error('[whatsapp] Processing error:', err);
    }
  });

  // ─── Thread reply bridge ─────────────────────────────────────────────────
  // POST /api/whatsapp/thread-reply { thread_ts, message, user_name }
  // Called by Sol when someone replies in a WhatsApp notification thread.
  router.post('/thread-reply', express.json(), async (req, res) => {
    const { thread_ts, message, user_name } = req.body || {};
    const threadTs = typeof thread_ts === 'string' ? thread_ts.trim().slice(0, 64) : '';
    const replyText = typeof message === 'string' ? message.trim() : '';
    const userName = typeof user_name === 'string' ? user_name.trim().slice(0, 120) : 'Staff';
    if (!threadTs || !replyText) return res.status(400).json({ error: 'thread_ts and message required' });
    if (replyText.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: 'message too long' });

    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB not ready' });

    try {
      // Find the WhatsApp conversation by slack thread ts
      const rows = await db.query(sql`
        SELECT id, sender_id, sender_name FROM meta_messages
        WHERE platform = 'whatsapp' AND slack_thread_ts = ${threadTs}
        ORDER BY id DESC LIMIT 1
      `);
      if (!rows.length) return res.status(404).json({ error: 'No WhatsApp conversation found for this thread' });

      const dm = rows[0];
      const result = await sendWhatsApp(dm.sender_id, replyText);

      // Log outbound
      const now = new Date().toISOString();
      await db.query(sql`
        INSERT INTO meta_messages (platform, sender_id, sender_name, message_text, received_at, slack_thread_ts, raw_payload)
        VALUES ('whatsapp', 'outbound', ${userName}, ${replyText}, ${now}, ${threadTs}, ${JSON.stringify({ reply_to: dm.id, twilio_sid: result.sid })})
      `);

      console.log(`[whatsapp/thread] ${userName} → ${dm.sender_name} (${dm.sender_id}): ${replyText.slice(0, 80)}`);
      res.json({ ok: true, to: dm.sender_name, phone: dm.sender_id, message_sid: result.sid });
    } catch (err) {
      console.error('[whatsapp/thread-reply] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Thread lookup (is this Slack thread a WhatsApp conversation?) ────
  // GET /api/whatsapp/thread-lookup?thread_ts=...
  // Returns { is_whatsapp: true/false, sender_name, sender_phone, wa_id } so
  // Sol can quickly decide whether to auto-forward a thread reply.
  router.get('/thread-lookup', async (req, res) => {
    const threadTs = typeof req.query.thread_ts === 'string' ? req.query.thread_ts.trim().slice(0, 64) : '';
    if (!threadTs) return res.json({ is_whatsapp: false });

    const db = getDb();
    if (!db) return res.json({ is_whatsapp: false });

    try {
      const rows = await db.query(sql`
        SELECT id, sender_id, sender_name FROM meta_messages
        WHERE platform = 'whatsapp' AND slack_thread_ts = ${threadTs} AND sender_id != 'outbound'
        ORDER BY id DESC LIMIT 1
      `);
      if (!rows.length) return res.json({ is_whatsapp: false });
      const dm = rows[0];
      res.json({ is_whatsapp: true, sender_name: dm.sender_name, sender_phone: dm.sender_id, wa_id: dm.id });
    } catch {
      res.json({ is_whatsapp: false });
    }
  });

  // ─── Direct reply API (legacy/fallback) ────────────────────────────────
  router.post('/reply', express.json(), async (req, res) => {
    const { dm_id, message } = req.body || {};
    const dmId = Number.parseInt(dm_id, 10);
    const replyText = typeof message === 'string' ? message.trim() : '';
    if (!Number.isSafeInteger(dmId) || dmId <= 0 || !replyText) {
      return res.status(400).json({ error: 'valid dm_id and message required' });
    }
    if (replyText.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: 'message too long' });

    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB not ready' });

    try {
      const rows = await db.query(sql`SELECT * FROM meta_messages WHERE id = ${dmId} AND platform = 'whatsapp' AND sender_id != 'outbound' LIMIT 1`);
      if (!rows.length) return res.status(404).json({ error: `No inbound WhatsApp message found with id ${dmId}` });
      const dm = rows[0];

      const result = await sendWhatsApp(dm.sender_id, replyText);

      const now = new Date().toISOString();
      await db.query(sql`
        INSERT INTO meta_messages (platform, sender_id, sender_name, message_text, received_at, raw_payload)
        VALUES ('whatsapp', 'outbound', 'Sol (outbound)', ${replyText}, ${now}, ${JSON.stringify({ reply_to_dm_id: dmId, twilio_sid: result.sid })})
      `);

      console.log(`[whatsapp/reply] Sent to ${dm.sender_name} (${dm.sender_id}): ${replyText.slice(0, 80)}`);
      res.json({ ok: true, to: dm.sender_name, phone: dm.sender_id, message_sid: result.sid });
    } catch (err) {
      console.error('[whatsapp/reply] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter };
