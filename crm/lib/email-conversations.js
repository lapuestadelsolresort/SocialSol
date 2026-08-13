'use strict';

const { sql } = require('@databases/sqlite');

const NEGATIVE_PATTERNS = [
  ['unsubscribe', /\bunsubscribe\b/i],
  ['not_interested', /\bnot\s+interested\b/i],
  ['retiring', /\bretir(?:e|ed|ing)\b/i],
  ['remove_me', /\bremove\s+me\b/i],
  ['stop_emailing', /\bstop\s+(?:emailing|contacting)\s+me\b/i],
  ['wrong_person', /\bwrong\s+person\b/i],
  ['no_thanks', /\bno\s+thanks\b/i],
  ['do_not_contact', /\bdo\s+not\s+contact\b/i],
];

const HOT_PATTERNS = [
  ['excited', /\b(?:we(?:'|’)re|we\s+are|i(?:'|’)m|i\s+am)\s+excited\b|\bexcited\s+about\b/i],
  ['exactly_what_we_want', /\bexactly\s+what\s+(?:we|i)\s+want\b/i],
  ['more_information', /\bmore\s+information\b/i],
  ['rates', /\brates?\b/i],
  ['fees', /\bfees?\b/i],
  ['pricing', /\bpricing\b|\bprice\s+(?:list|details|sheet)\b/i],
  ['availability', /\bavailab(?:le|ility|le\s+dates?)\b/i],
  ['interested', /\binterested\b/i],
  ['tell_me_more', /\btell\s+me\s+more\b/i],
  ['send_details', /\bsend\s+(?:me\s+)?(?:details|information|pricing|rates)\b/i],
  ['quote', /\bquote\b/i],
  ['call', /\b(?:let'?s|can\s+we|could\s+we)\s+(?:chat|talk|schedule\s+a\s+call)\b/i],
  ['sounds_good', /\bsounds\s+(?:great|good|interesting)\b/i],
  ['would_love', /\bwould\s+love\s+to\b/i],
  ['affirmative', /^\s*(?:yes|absolutely|definitely|please do|let(?:'|’)s do it)[.!\s]*$/i],
];

function normalizeEmail(value) {
  const text = String(value || '').trim();
  const angle = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const candidate = angle ? angle[1] : text;
  const match = candidate.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : '';
}

function normalizeMessageId(value) {
  return String(value || '')
    .trim()
    .replace(/^<|>$/g, '')
    .trim()
    .toLowerCase();
}

function referenceIds(value) {
  const text = String(value || '');
  const bracketed = [...text.matchAll(/<([^>]+)>/g)].map(match => normalizeMessageId(match[1]));
  if (bracketed.length) return [...new Set(bracketed.filter(Boolean))];
  return [...new Set(text.split(/\s+/).map(normalizeMessageId).filter(Boolean))];
}

function baseSubject(value) {
  return String(value || '')
    .replace(/^\s*((?:re|fw|fwd|aw|sv)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

function stripQuotedHistory(value) {
  let text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    // Some senders expose an HTML fallback as one collapsed text line. Decode
    // the small entity set needed to recover reply separators and readable
    // addresses before looking for quoted-history boundaries.
    .replace(/(?:&nbsp;|&#160;|&#x0*a0;)/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/(?:&#39;|&apos;)/gi, "'")
    .replace(/&amp;/gi, '&')
    .trim();
  if (!text) return '';

  const markers = [
    /(?:^|\s)On\s+(?:(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b)[\s\S]{1,500}?\bwrote:\s*/i,
    /(?:^|\s)El\s+(?:(?:lun|mar|mi[eé]|jue|vie|s[aá]b|dom)\b)[\s\S]{1,500}?\bescribi[oó]:\s*/i,
    /(?:^|\s)Le\s+(?:(?:lun|mar|mer|jeu|ven|sam|dim)\b)[\s\S]{1,500}?\ba écrit\s*:\s*/i,
    /(?:^|\s)Am\s+(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4})[\s\S]{1,500}?\bschrieb[\s\S]{1,160}?:\s*/i,
    /\n-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i,
    /\nFrom:\s*[^\n]+\n(?:Sent|Date):\s*/i,
    /\n_{5,}\s*\n/i,
  ];
  let cut = text.length;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index < cut) cut = match.index;
  }

  const lines = text.slice(0, cut).split('\n');
  const firstQuote = lines.findIndex((line, index) => index > 0 && /^\s*>/.test(line));
  if (firstQuote >= 0) lines.splice(firstQuote);
  text = lines.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function classifyReply(value) {
  const normalizedText = stripQuotedHistory(value);
  for (const [reason, pattern] of NEGATIVE_PATTERNS) {
    if (pattern.test(normalizedText)) {
      return { quality: 'not_interested', reason, confidence: 1, normalizedText };
    }
  }
  for (const [reason, pattern] of HOT_PATTERNS) {
    if (pattern.test(normalizedText)) {
      return { quality: 'hot', reason, confidence: 0.95, normalizedText };
    }
  }
  return { quality: 'ambiguous', reason: 'no_deterministic_signal', confidence: 0.5, normalizedText };
}

async function lookupSendById(db, sendId) {
  const id = Number.parseInt(sendId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [row] = await db.query(sql`
    SELECT os.*, c.name AS contact_name, c.email AS contact_email,
      oc.slug AS campaign_slug, oc.name AS campaign_name
    FROM outreach_sends os
    JOIN contacts c ON c.id=os.contact_id
    LEFT JOIN outreach_campaigns oc ON oc.id=os.campaign_id
    WHERE os.id=${id}
    LIMIT 1
  `);
  return row || null;
}

async function resolveOutreachSend(db, message = {}) {
  if (message.outreachSendId) {
    const direct = await lookupSendById(db, message.outreachSendId);
    if (direct) return direct;
  }

  const ids = [...new Set([
    normalizeMessageId(message.inReplyTo),
    ...referenceIds(message.references),
  ].filter(Boolean))];
  if (ids.length) {
    const placeholders = ids.map(value => `'${value.replaceAll("'", "''")}'`).join(',');
    const rows = await db.query(sql.__dangerous__rawValue(`
      SELECT os.*, c.name AS contact_name, c.email AS contact_email,
        oc.slug AS campaign_slug, oc.name AS campaign_name
      FROM email_threads et
      JOIN outreach_sends os ON os.id=et.outreach_send_id
      JOIN contacts c ON c.id=os.contact_id
      LEFT JOIN outreach_campaigns oc ON oc.id=os.campaign_id
      WHERE LOWER(TRIM(et.rfc_message_id, '<>')) IN (${placeholders})
      ORDER BY COALESCE(et.received_at, et.created_at) DESC LIMIT 1
    `));
    if (rows[0]) return rows[0];
  }

  if (message.providerThreadId) {
    const [threadMatch] = await db.query(sql`
      SELECT os.*, c.name AS contact_name, c.email AS contact_email,
        oc.slug AS campaign_slug, oc.name AS campaign_name
      FROM email_threads et
      JOIN outreach_sends os ON os.id=et.outreach_send_id
      JOIN contacts c ON c.id=os.contact_id
      LEFT JOIN outreach_campaigns oc ON oc.id=os.campaign_id
      WHERE et.provider='gmail' AND et.provider_thread_id=${String(message.providerThreadId)}
      ORDER BY COALESCE(et.received_at, et.created_at) DESC LIMIT 1
    `);
    if (threadMatch) return threadMatch;
  }

  const direction = message.direction === 'outbound' ? 'outbound' : 'inbound';
  const address = normalizeEmail(direction === 'inbound' ? message.from : message.to);
  if (!address) return null;
  const subject = baseSubject(message.subject);
  const rows = await db.query(sql`
    SELECT os.*, c.name AS contact_name, c.email AS contact_email,
      oc.slug AS campaign_slug, oc.name AS campaign_name
    FROM outreach_sends os
    JOIN contacts c ON c.id=os.contact_id
    LEFT JOIN outreach_campaigns oc ON oc.id=os.campaign_id
    WHERE LOWER(c.email)=${address}
      AND os.sent_at IS NOT NULL
      AND os.status NOT IN ('cancelled','bounced','complained')
    ORDER BY os.sent_at DESC
    LIMIT 25
  `);
  if (!rows.length) return null;
  if (subject) {
    const exact = rows.find(row => baseSubject(row.subject) === subject);
    if (exact) return exact;
    return null;
  }
  return rows[0];
}

async function resolveConversationEvent(db, message = {}) {
  const provider = String(message.provider || 'gmail').trim().toLowerCase();
  if (message.providerThreadId) {
    const [threadMatch] = await db.query(sql`SELECT * FROM email_threads
      WHERE provider=${provider} AND provider_thread_id=${String(message.providerThreadId)}
      ORDER BY COALESCE(received_at, created_at) DESC, id DESC LIMIT 1`);
    if (threadMatch) return threadMatch;
  }
  const ids = [...new Set([
    normalizeMessageId(message.inReplyTo),
    ...referenceIds(message.references),
  ].filter(Boolean))];
  if (!ids.length) return null;
  const placeholders = ids.map(value => `'${value.replaceAll("'", "''")}'`).join(',');
  const rows = await db.query(sql.__dangerous__rawValue(`
    SELECT * FROM email_threads
    WHERE provider='${provider.replaceAll("'", "''")}'
      AND LOWER(TRIM(rfc_message_id, '<>')) IN (${placeholders})
    ORDER BY COALESCE(received_at, created_at) DESC, id DESC LIMIT 1
  `));
  return rows[0] || null;
}

async function ingestEmailEvent(db, message = {}) {
  const provider = String(message.provider || 'gmail').trim().toLowerCase();
  const providerMessageId = String(message.providerMessageId || message.id || '').trim();
  if (!providerMessageId) throw new Error('providerMessageId is required');
  const existing = await db.query(sql`SELECT * FROM email_threads
    WHERE provider=${provider} AND provider_message_id=${providerMessageId} LIMIT 1`);
  if (existing[0]) return { created: false, event: existing[0], send: await lookupSendById(db, existing[0].outreach_send_id) };

  const [send, conversation] = await Promise.all([
    resolveOutreachSend(db, message),
    resolveConversationEvent(db, message),
  ]);
  const direction = message.direction === 'outbound' ? 'outbound' : 'inbound';
  const rawText = String(message.text || message.body || '');
  const bodyText = stripQuotedHistory(rawText);
  const receivedAt = message.internalDate || message.receivedAt || message.sentAt || new Date().toISOString();
  const contactId = send?.contact_id || message.contactId || conversation?.contact_id || null;
  const leadId = message.crmLeadId || conversation?.crm_lead_id || null;
  const slackChannelId = send?.slack_channel_id || message.slackChannelId
    || conversation?.slack_channel_id || null;
  const slackThreadTs = send?.slack_message_ts || message.slackThreadTs
    || conversation?.slack_thread_ts || conversation?.slack_message_ts || null;
  const providerMetadata = message.providerMetadata
    ? JSON.stringify(message.providerMetadata) : conversation?.provider_metadata_json || null;
  const result = await db.query(sql`INSERT INTO email_threads (
      contact_id, crm_lead_id, outreach_send_id, direction, subject, body_text, body_html,
      from_address, sender_name, to_address, received_at, provider, provider_message_id,
      provider_thread_id, provider_metadata_json, rfc_message_id, in_reply_to, references_header,
      raw_body_text, processing_status, slack_channel_id, slack_thread_ts
    ) VALUES (
      ${contactId}, ${leadId}, ${send?.id || message.outreachSendId || conversation?.outreach_send_id || null}, ${direction},
      ${String(message.subject || send?.subject || '').slice(0, 1000)}, ${bodyText},
      ${message.html ? String(message.html) : null},
      ${normalizeEmail(message.from) || String(message.from || '').slice(0, 500)},
      ${String(message.senderName || '').slice(0, 500) || null},
      ${normalizeEmail(message.to) || String(message.to || '').slice(0, 500)},
      ${receivedAt}, ${provider}, ${providerMessageId},
      ${message.providerThreadId ? String(message.providerThreadId) : null},
      ${providerMetadata},
      ${message.rfcMessageId ? String(message.rfcMessageId) : null},
      ${message.inReplyTo ? String(message.inReplyTo) : null},
      ${message.references ? String(message.references) : null}, ${rawText},
      'pending', ${slackChannelId}, ${slackThreadTs}
    ) RETURNING *`);
  return { created: true, event: result[0], send, conversation };
}

module.exports = {
  HOT_PATTERNS,
  NEGATIVE_PATTERNS,
  baseSubject,
  classifyReply,
  ingestEmailEvent,
  lookupSendById,
  normalizeEmail,
  normalizeMessageId,
  referenceIds,
  resolveOutreachSend,
  resolveConversationEvent,
  stripQuotedHistory,
};
