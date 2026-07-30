'use strict';
//
// dossier-context.js — assemble the per-contact context Regina passes to
// Voice Service and renders into the Slack draft message.
//
// Joins:
//   contacts (id, name, email, phone, preferred_channel, contact_provenance,
//             relationship_type, last_stay_date, do_not_contact, language=NULL)
//   guest_dossiers (one row per airbnb_thread_id; contact_ids JSON array)
//
// Group bookings: a single dossier may cover multiple contact_ids. We resolve
// by SELECT * FROM guest_dossiers WHERE EXISTS (
//   SELECT 1 FROM json_each(contact_ids) WHERE value = <contact_id>
// ).

const { sql } = require('@databases/sqlite');

// Provenance hard rule: airbnb_thread_only contacts can NEVER receive direct
// email — Regina forces send_method='manual_airbnb_thread' regardless of the
// contact's preferred_channel.
function resolveSendMethod(contact) {
  if (contact.contact_provenance === 'airbnb_thread_only') {
    return 'manual_airbnb_thread';
  }
  switch (contact.preferred_channel) {
    case 'email':         return 'manual_email';
    case 'whatsapp':      return 'manual_whatsapp';
    case 'airbnb_thread': return 'manual_airbnb_thread';
    default:              return 'manual_email'; // safest fallback for rows missing the column
  }
}

// Skip reasons (returned, not raised) so the caller can log + display them.
const SKIP_REASONS = {
  DO_NOT_CONTACT: 'contact.do_not_contact = 1',
  DOSSIER_LANGUAGE_ES: 'dossier.language = es',
  DOSSIER_DEFERRED_SPANISH: 'dossier.extraction_status = deferred_spanish',
  DOSSIER_NOT_EXTRACTED: 'dossier.extraction_status != extracted',
  DOSSIER_MISSING: 'no dossier row found for contact',
};

async function loadContact(db, contactId) {
  const rows = await db.query(sql`
    SELECT id, name, email, phone, preferred_channel, contact_provenance,
           relationship_type, last_stay_date, do_not_contact,
           airbnb_thread_id, airbnb_account_id
    FROM contacts
    WHERE id = ${contactId}
  `);
  return rows[0] || null;
}

async function loadDossierForContact(db, contactId) {
  // contact_ids is JSON; use json_each to filter. Returns the first matching row.
  const rows = await db.query(sql`
    SELECT d.*
    FROM guest_dossiers d
    WHERE EXISTS (
      SELECT 1 FROM json_each(d.contact_ids) je
      WHERE je.value = ${contactId}
    )
    LIMIT 1
  `);
  return rows[0] || null;
}

/**
 * Build the per-contact context bundle.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   skip_reason?: string,
 *   contact?: object,
 *   dossier?: object,
 *   send_method?: string,
 *   message_context?: string,
 *   recipient_relationship?: string
 * }>}
 */
async function buildContext(db, contactId, campaignConfig) {
  const contact = await loadContact(db, contactId);
  if (!contact) return { ok: false, skip_reason: 'contact_not_found' };

  if (contact.do_not_contact === 1 || contact.do_not_contact === true) {
    return { ok: false, contact, skip_reason: SKIP_REASONS.DO_NOT_CONTACT };
  }

  const dossier = await loadDossierForContact(db, contactId);
  if (!dossier) {
    return { ok: false, contact, skip_reason: SKIP_REASONS.DOSSIER_MISSING };
  }
  if (dossier.extraction_status === 'deferred_spanish') {
    return { ok: false, contact, dossier, skip_reason: SKIP_REASONS.DOSSIER_DEFERRED_SPANISH };
  }
  if (dossier.extraction_status !== 'extracted') {
    return { ok: false, contact, dossier, skip_reason: SKIP_REASONS.DOSSIER_NOT_EXTRACTED };
  }
  if (dossier.language === 'es') {
    return { ok: false, contact, dossier, skip_reason: SKIP_REASONS.DOSSIER_LANGUAGE_ES };
  }

  // Build the message_context the Voice Service uses for retrieval +
  // generation. It's a free-text blob describing the situation, not the
  // draft itself. Voice Service queries Chroma against this string and
  // generates a Sarah-voiced response.
  const parts = [];
  if (campaignConfig.prompt_context) parts.push(campaignConfig.prompt_context.trim());
  parts.push(`Contact: ${contact.name || '(unknown name)'}.`);
  if (contact.relationship_type) parts.push(`Relationship: ${contact.relationship_type}.`);
  if (dossier.trip_purpose) parts.push(`Trip purpose: ${dossier.trip_purpose}.`);
  if (dossier.decision_timeline) parts.push(`Decision timeline: ${dossier.decision_timeline}.`);
  if (dossier.why_no_book && dossier.why_no_book !== 'not_applicable') {
    parts.push(`Why didn't book: ${dossier.why_no_book}.`);
  }
  if (dossier.dates_targeted) parts.push(`Dates considered: ${dossier.dates_targeted}.`);
  if (dossier.group_dynamics) parts.push(`Group: ${dossier.group_dynamics}.`);
  if (dossier.geographic_hints) parts.push(`From: ${dossier.geographic_hints}.`);
  if (dossier.notes_for_sarah) parts.push(`Sarah's note: ${dossier.notes_for_sarah}`);

  const message_context = parts.join(' ');

  return {
    ok: true,
    contact,
    dossier,
    send_method: resolveSendMethod(contact),
    message_context,
    recipient_relationship: campaignConfig.recipient_relationship || contact.relationship_type || null,
  };
}

module.exports = {
  buildContext,
  loadContact,
  loadDossierForContact,
  resolveSendMethod,
  SKIP_REASONS,
};
