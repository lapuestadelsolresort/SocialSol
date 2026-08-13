'use strict';

const { sql } = require('@databases/sqlite');
const { normalizeEmail } = require('./email-conversations');

const IGNORE_DOMAINS = new Set([
  'lapuestadelsolresort.com',
  'lapuestadelsol.com',
  'airbnb.com',
  'booking.com',
  'google.com',
  'googlemail.com',
  'vrbo.com',
  'expedia.com',
  'tripadvisor.com',
  'facebook.com',
  'facebookmail.com',
  'instagram.com',
  'meta.com',
]);

const IGNORE_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'notifications', 'notification', 'alerts',
  'support', 'info', 'newsletter', 'marketing',
]);

function shouldCreateInquiry(address) {
  const email = normalizeEmail(address);
  const [local, domain] = email.split('@');
  if (!local || !domain || IGNORE_DOMAINS.has(domain) || IGNORE_LOCAL_PARTS.has(local)) return false;
  return !/^(?:no[-_.]?reply|mailer[-_.]?daemon|bounce)/i.test(local);
}

function senderName(event, email) {
  return String(event.sender_name || '').trim()
    || email.split('@')[0]
    || 'Unknown';
}

function providerMetadata(event) {
  try {
    const parsed = JSON.parse(event.provider_metadata_json || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function projectDirectGmailInbound(db, event) {
  if (event.provider !== 'gmail' || event.direction !== 'inbound' || event.outreach_send_id) {
    return { inquiry: false, reason: 'not_direct_gmail_inbound' };
  }
  const email = normalizeEmail(event.from_address);
  if ((providerMetadata(event).labelIds || []).includes('SPAM')) {
    return { inquiry: false, reason: 'gmail_spam', contactId: event.contact_id || null, leadId: event.crm_lead_id || null };
  }
  if (!shouldCreateInquiry(email)) {
    return { inquiry: false, reason: 'visibility_only', contactId: event.contact_id || null, leadId: event.crm_lead_id || null };
  }

  let [contact] = await db.query(sql`SELECT * FROM contacts WHERE LOWER(email)=${email} LIMIT 1`);
  let contactCreated = false;
  if (!contact) {
    const name = senderName(event, email);
    await db.query(sql`INSERT OR IGNORE INTO contacts (
      name, email, email_status, dedup_key, source, context_source, status,
      relationship_type, contact_provenance, preferred_channel, addressable, notes
    ) VALUES (
      ${name}, ${email}, 'unknown', ${email}, 'gmail_inbound',
      'gmail_direct_inquiry', 'inquiry', 'inbound_inquiry',
      'voluntary_share_message', 'email', 1,
      ${`First observed in Sarah email event #${event.id}`}
    )`);
    [contact] = await db.query(sql`SELECT * FROM contacts WHERE LOWER(email)=${email} LIMIT 1`);
    contactCreated = Boolean(contact);
  }

  let [lead] = await db.query(sql`SELECT * FROM leads WHERE LOWER(email)=${email}
    ORDER BY created_at DESC, id DESC LIMIT 1`);
  let leadCreated = false;
  if (!lead) {
    const name = senderName(event, email);
    const [created] = await db.query(sql`INSERT INTO leads (
      name, email, source, status, inquiry_message, notes
    ) VALUES (
      ${name}, ${email}, 'email_inbound', 'new',
      ${String(event.body_text || '').slice(0, 500)},
      ${`Auto-created from Sarah email event #${event.id}`}
    ) RETURNING *`);
    lead = created;
    leadCreated = true;
  }

  await db.query(sql`UPDATE email_threads SET contact_id=${contact?.id || null},
    crm_lead_id=${lead?.id || null}, updated_at=datetime('now') WHERE id=${event.id}`);
  return {
    inquiry: true,
    reason: 'external_sender',
    contactId: contact?.id || null,
    leadId: lead?.id || null,
    contactCreated,
    leadCreated,
  };
}

module.exports = {
  IGNORE_DOMAINS,
  IGNORE_LOCAL_PARTS,
  projectDirectGmailInbound,
  providerMetadata,
  shouldCreateInquiry,
};
