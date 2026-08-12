/**
 * WhatsApp Bridge via Twilio
 *
 * Incoming: Twilio POSTs to /webhook/twilio-whatsapp on each inbound message.
 * We store it in meta_messages (platform='whatsapp'), post to #whatsapp as
 * a Slack message, and store the Slack thread ts so replies in that thread
 * automatically go back to WhatsApp.
 *
 * Outbound is intentionally accepted only from an explicit `!wa` command in
 * #whatsapp through the durable workflow control plane. The former direct
 * HTTP send endpoints return 410 and cannot bypass trusted Slack identity.
 */

const { verifyTwilioSignature } = require('../lib/webhook-auth');
const { enqueueOutbox, transitionEffect } = require('../lib/workflow-store');
const {
  MAX_MESSAGE_LENGTH,
  loadTwilioSecrets,
  normalizeTwilioEffectState,
  statusCallbackUrl,
} = require('../lib/twilio-whatsapp');

const SOCIAL_SOL_CHANNEL = process.env.RESORT_SOCIAL_CHANNEL || '';
const WHATSAPP_CHANNEL = process.env.RESORT_WHATSAPP_CHANNEL || SOCIAL_SOL_CHANNEL;
const DEFAULT_WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL
  || 'https://webhook.lapuestadelsolresort.com/webhook/twilio-whatsapp/webhook';

function buildRouter(getDb, overrides = {}) {
  const express = require('express');
  const router = express.Router();
  const { sql } = require('@databases/sqlite');
  const getSecrets = overrides.loadTwilioSecrets || loadTwilioSecrets;

  function monotonicStatus(current, next) {
    const rank = new Map([
      ['accepted_by_provider', 0], ['queued', 1], ['sent', 2], ['delivered', 3], ['read', 4],
    ]);
    if (!current) return next;
    if (current === 'failed' || current === 'read') return current;
    if (next === 'failed') return ['delivered', 'read'].includes(current) ? current : 'failed';
    return (rank.get(next) ?? 0) >= (rank.get(current) ?? 0) ? next : current;
  }

  // ─── Twilio Webhook (incoming WhatsApp messages) ─────────────────────────
  router.post('/webhook', express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }), async (req, res) => {
    const secrets = getSecrets();
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

    console.log(`[whatsapp] Incoming from ${senderName} (${senderPhone}): ${(text || '[media]').slice(0, 80)}`);

    const db = getDb();
    if (!db) return res.status(503).type('text/xml').send('<Response></Response>');

    try {
      // Deduplicate
      if (messageSid) {
        const [{ n }] = await db.query(sql`SELECT COUNT(*) n FROM meta_messages WHERE message_id = ${messageSid}`);
        if (n > 0) return res.status(200).type('text/xml').send('<Response></Response>');
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
        INSERT OR IGNORE INTO meta_messages (
          platform, sender_id, sender_name, message_id, message_text, received_at,
          raw_payload, direction, delivery_status, provider_status_updated_at,
          processing_status
        ) VALUES (
          'whatsapp', ${senderPhone}, ${senderName}, ${messageSid}, ${fullText}, ${now},
          ${JSON.stringify(safePayload)}, 'inbound', 'delivered', ${now}, 'pending'
        )
      `);

      const rows = await db.query(sql`
        SELECT id FROM meta_messages
        WHERE message_id = ${messageSid || ''}
           OR (sender_id = ${senderPhone} AND received_at = ${now})
        ORDER BY id DESC LIMIT 1
      `);
      const dmRowId = rows[0]?.id || null;

      // Make the staff notification durable before acknowledging Twilio. A
      // crash after the 200 can no longer hide an inbound guest message.
      const preview = fullText.length > 300 ? fullText.slice(0, 300) + '…' : fullText;
      const slackMsg = `📱 *WhatsApp from ${senderName}* (${senderPhone}) [wa-${dmRowId}]:\n${preview}\n_To send a WhatsApp reply, respond in this thread with_ \`!wa your message\`_. Plain Slack replies are not sent._`;
      await enqueueOutbox(db, {
        topic: 'slack.notification',
        idempotencyKey: `whatsapp:inbound:${messageSid || dmRowId}:slack`,
        payload: { channelId: WHATSAPP_CHANNEL, message: slackMsg, metaMessageId: dmRowId },
      });

      // Acknowledge only after the inbound message, Slack notification intent,
      // and pending CRM-enrichment state are durable. The workflow worker turns
      // the pending row into an idempotent whatsapp.inbound.process run.
      res.status(200).type('text/xml').send('<Response></Response>');
      console.log(`[whatsapp] Durable Slack notification and CRM processing queued for wa-${dmRowId}`);
    } catch (err) {
      console.error('[whatsapp] Processing error:', err);
      if (!res.headersSent) res.status(500).type('text/xml').send('<Response></Response>');
    }
  });

  // ─── Twilio delivery/read status callback ─────────────────────────────────
  router.post('/status', express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 100 }), async (req, res) => {
    const secrets = getSecrets();
    const body = req.body || {};
    const callbackUrl = statusCallbackUrl(secrets);
    if (!secrets.auth_token || !secrets.account_sid) {
      return res.status(503).type('text/xml').send('<Response></Response>');
    }
    if (
      body.AccountSid !== secrets.account_sid
      || !verifyTwilioSignature(callbackUrl, body, secrets.auth_token, req.headers['x-twilio-signature'])
    ) {
      console.warn('[whatsapp/status] Rejected invalid Twilio signature');
      return res.status(403).type('text/xml').send('<Response></Response>');
    }

    const messageSid = String(body.MessageSid || body.SmsSid || '').slice(0, 80);
    const providerStatus = String(body.MessageStatus || body.SmsStatus || '').toLowerCase();
    if (!messageSid || !providerStatus) {
      return res.status(400).type('text/xml').send('<Response></Response>');
    }
    const db = getDb();
    if (!db) return res.status(503).type('text/xml').send('<Response></Response>');

    try {
      const status = normalizeTwilioEffectState(providerStatus);
      const transition = await transitionEffect(db, {
        provider: 'twilio',
        providerRef: messageSid,
        status,
        providerStatus,
        response: {
          sid: messageSid,
          status: providerStatus,
          errorCode: body.ErrorCode || null,
        },
        errorCode: status === 'failed' ? (body.ErrorCode || 'twilio_delivery_failed') : null,
        errorMessage: status === 'failed' ? (body.ErrorMessage || providerStatus) : null,
      });
      const now = new Date().toISOString();
      const [currentMessage] = await db.query(sql`SELECT delivery_status FROM meta_messages
        WHERE platform='whatsapp' AND message_id=${messageSid} LIMIT 1`);
      const mirrorStatus = monotonicStatus(currentMessage?.delivery_status, status);
      const mirrorChanged = Boolean(currentMessage) && mirrorStatus !== currentMessage.delivery_status;
      await db.query(sql`UPDATE meta_messages SET
          delivery_status=${mirrorStatus},
          provider_status_updated_at=CASE WHEN ${mirrorChanged ? 1 : 0}=1 THEN ${now} ELSE provider_status_updated_at END,
          delivered_at=CASE WHEN ${mirrorStatus} IN ('delivered','read') THEN COALESCE(delivered_at, ${now}) ELSE delivered_at END,
          read_at=CASE WHEN ${mirrorStatus}='read' THEN COALESCE(read_at, ${now}) ELSE read_at END,
          failed_at=CASE WHEN ${mirrorStatus}='failed' THEN COALESCE(failed_at, ${now}) ELSE failed_at END
        WHERE platform='whatsapp' AND message_id=${messageSid}`);

      const [messageRow] = await db.query(sql`SELECT id, sender_name, slack_thread_ts, workflow_run_id
        FROM meta_messages WHERE platform='whatsapp' AND message_id=${messageSid} LIMIT 1`);
      const [inboundRow] = messageRow?.slack_thread_ts ? await db.query(sql`
        SELECT sender_name FROM meta_messages
        WHERE platform='whatsapp' AND slack_thread_ts=${messageRow.slack_thread_ts} AND sender_id!='outbound'
        ORDER BY id DESC LIMIT 1
      `) : [];
      if (transition.changed || (!transition.found && mirrorChanged)) {
        const target = transition.effect?.target_json ? JSON.parse(transition.effect.target_json) : {};
        const threadTs = target.slackThreadTs || messageRow?.slack_thread_ts || null;
        const recipient = target.senderName || inboundRow?.sender_name || messageRow?.sender_name || 'guest';
        const notification = mirrorStatus === 'delivered'
          ? `✅ WhatsApp to *${recipient}* was delivered. (Twilio-confirmed)`
          : mirrorStatus === 'read'
            ? `👁️ WhatsApp to *${recipient}* was read. (Twilio-confirmed)`
            : mirrorStatus === 'failed'
              ? `❌ WhatsApp to *${recipient}* failed: ${body.ErrorCode || providerStatus}.`
              : null;
        if (notification && threadTs) {
          await enqueueOutbox(db, {
            runId: transition.effect?.run_id || messageRow?.workflow_run_id || null,
            topic: 'slack.notification',
            idempotencyKey: `whatsapp:status:${messageSid}:${mirrorStatus}:slack`,
            payload: { channelId: WHATSAPP_CHANNEL, threadTs, message: notification },
          });
        }
      }
      res.status(200).type('text/xml').send('<Response></Response>');
    } catch (error) {
      console.error('[whatsapp/status] Processing error:', error.message);
      if (!res.headersSent) res.status(500).type('text/xml').send('<Response></Response>');
    }
  });

  router.post('/thread-reply', express.json(), (_req, res) => res.status(410).json({
    error: 'direct WhatsApp sends are disabled; use an explicit !wa command in #whatsapp',
    code: 'whatsapp_slack_only',
  }));

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

  router.post('/reply', express.json(), (_req, res) => res.status(410).json({
    error: 'direct WhatsApp sends are disabled; use an explicit !wa command in #whatsapp',
    code: 'whatsapp_slack_only',
  }));

  // Deterministic status lookup. This endpoint never infers delivery from the
  // original send response; it reports only persisted provider callbacks.
  router.get('/message-status/:sid', async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    const sid = String(req.params.sid || '').slice(0, 80);
    const [row] = await db.query(sql`SELECT m.message_id, m.sender_name,
        COALESCE(e.status, m.delivery_status) AS delivery_status,
        m.provider_status_updated_at,
        COALESCE(e.delivered_at, m.delivered_at) AS delivered_at,
        COALESCE(e.read_at, m.read_at) AS read_at,
        COALESCE(e.failed_at, m.failed_at) AS failed_at,
        m.workflow_run_id, m.workflow_effect_id
      FROM meta_messages m LEFT JOIN workflow_effects e ON e.id=m.workflow_effect_id
      WHERE m.platform='whatsapp' AND m.message_id=${sid} LIMIT 1`);
    if (!row) return res.status(404).json({ error: 'WhatsApp message not found' });
    const status = row.delivery_status || 'accepted_by_provider';
    return res.json({
      message_sid: row.message_id,
      recipient: row.sender_name,
      status,
      delivered: Boolean(row.delivered_at || row.read_at),
      read: Boolean(row.read_at),
      failed: Boolean(row.failed_at),
      status_updated_at: row.provider_status_updated_at,
      delivered_at: row.delivered_at,
      read_at: row.read_at,
      failed_at: row.failed_at,
      workflow_run_id: row.workflow_run_id,
      workflow_effect_id: row.workflow_effect_id,
    });
  });

  return router;
}

module.exports = { buildRouter };
