'use strict';
//
// slack-format.js — builds Regina's Slack message text from a context bundle
// + Voice Service draft. Handles the long-draft split when a single message
// would exceed Slack's per-message hard limit (~40000 chars).

const DEFAULT_MAX = 38000;
const DOSSIER_TRUNCATE = 250;
const DRAFT_BODY_MARKER = '<<DRAFT_BODY>>';

function trunc(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function fmtFromTo(contact) {
  const sender = process.env.RESORT_SENDER_EMAIL || 'configured resort sender';
  if (contact.contact_provenance === 'airbnb_thread_only') {
    return `Airbnb thread (account ${contact.airbnb_account_id || '?'})`;
  }
  switch (contact.preferred_channel) {
    case 'email':         return `${sender} → ${contact.email || '(no email)'}`;
    case 'whatsapp':      return `Sarah's WhatsApp → ${contact.phone || '(no phone)'}`;
    case 'airbnb_thread': return `Airbnb thread (account ${contact.airbnb_account_id || '?'})`;
    default:              return contact.email ? `${sender} → ${contact.email}` : '(channel unknown)';
  }
}

function fmtLastContact(contact) {
  return contact.last_stay_date || '(no recorded stay)';
}

function buildHeaderBlock({ campaignKind, contact, dossier }) {
  const channelLabel = contact.preferred_channel || (contact.contact_provenance === 'airbnb_thread_only' ? 'airbnb_thread' : 'email');
  return [
    `🪶 ${campaignKind} — ${contact.name || '(no name)'} (id ${contact.id})`,
    `Channel: ${channelLabel} | ${fmtFromTo(contact)}`,
    `Last contact: ${fmtLastContact(contact)} | Decision: ${dossier.decision_timeline || '(unknown)'} | Why no book: ${dossier.why_no_book || '(unknown)'}`,
    '',
    `Dossier: ${trunc(dossier.notes_for_sarah || '(no notes)', DOSSIER_TRUNCATE)}`,
    '',
  ].join('\n');
}

function buildSubjectLine(draft) {
  // Voice Service's draft_text is a body-only blob. Subject is not modeled
  // in the v1 response. R5 punts: no subject line. R6 may extend the
  // Voice Service contract to emit a subject for email-channel campaigns.
  return '';
}

function buildFooter() {
  return '\nReply in thread: !sent | <edited text> + !sent | !skip [reason] | !defer N';
}

/**
 * Build the top-level draft message for a single contact.
 *
 * Returns { topLevel, bodyOverflow }.
 *   - topLevel: the string to post as a top-level message.
 *   - bodyOverflow: null if the whole draft fits; otherwise the threaded-reply
 *     payload `<<DRAFT_BODY>>\n<draft>` to post as a follow-up.
 */
function buildDraftMessage({
  campaignKind,
  contact,
  dossier,
  draftText,
  maxChars = DEFAULT_MAX,
}) {
  const header = buildHeaderBlock({ campaignKind, contact, dossier });
  const subject = buildSubjectLine();
  const footer = buildFooter();
  const fullSingle = `${header}${subject ? subject + '\n\n' : ''}${draftText}\n${footer}`;

  if (fullSingle.length <= maxChars) {
    return { topLevel: fullSingle, bodyOverflow: null };
  }
  const topLevel = `${header}${subject ? subject + '\n\n' : ''}(draft body in threaded reply — too long for one message)\n${footer}`;
  const bodyOverflow = `${DRAFT_BODY_MARKER}\n${draftText}`;
  return { topLevel, bodyOverflow };
}

function buildBatchSummary({ slug, count, kindBreakdown, runAt }) {
  const breakdown = Object.entries(kindBreakdown)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  return [
    `📦 Reactivation batch complete — ${count} draft${count === 1 ? '' : 's'} posted.`,
    `Run by !batch ${slug} at ${runAt}.`,
    `Campaigns: ${breakdown || '(empty)'}`,
  ].join('\n');
}

function buildEmptyAnniversaryPost(dateIso) {
  return `📅 Anniversary check — ${dateIso} — no eligible contacts today.`;
}

function buildVoiceServiceDownPost(reason) {
  return `❌ Voice Service unreachable: ${reason}. No drafts produced, no rows written.`;
}

function buildPerDraftErrorPost({ contact, error }) {
  return `⚠ Skipped ${contact.name || '(unknown)'} (id ${contact.id}): ${error}`;
}

function buildSentAck(editDistance) {
  return `✅ Logged as sent. edit_distance=${editDistance}.`;
}

function buildSkippedAck() {
  return `🛑 Skipped.`;
}

function buildDeferredAck(deferUntilIso) {
  const date = (deferUntilIso || '').slice(0, 10);
  return `⏸ Deferred until ${date}.`;
}

function buildReminderPost({ contact, draftDate, count, max }) {
  return `⏰ ${contact.name || '(unknown)'}'s draft from ${draftDate} is unactioned (${count}/${max}). Reply !sent, !skip, or !defer N.`;
}

function buildAutoReconcilePost({ contact, sentAtIso, editDistance }) {
  const date = (sentAtIso || '').slice(0, 10);
  return `🔄 Auto-reconciled: ${contact.name || '(unknown)'}'s draft was sent on ${date}, captured from Gmail. Edit distance: ${editDistance}.`;
}

function buildPossibleMatchPost({ contact, draftText, gmailBody, similarity }) {
  return [
    `🤔 Possible match for ${contact.name || '(unknown)'}'s draft (similarity ${(similarity * 100).toFixed(0)}%) — confirm or reject:`,
    '',
    '*Draft:*',
    '```',
    draftText.slice(0, 1500),
    '```',
    '*Gmail Sent:*',
    '```',
    gmailBody.slice(0, 1500),
    '```',
    '',
    'If this is the same message, reply `!sent` (with the actual text) in the draft thread, or `!skip auto_reconcile_no_match`.',
  ].join('\n');
}

function buildAutoSuppressPost({ contact, draftDate }) {
  return `🔕 Auto-suppressed: ${contact.name || '(unknown)'}'s draft from ${draftDate} unactioned 3 times. Re-enable manually if needed.`;
}

module.exports = {
  buildDraftMessage,
  buildBatchSummary,
  buildEmptyAnniversaryPost,
  buildVoiceServiceDownPost,
  buildPerDraftErrorPost,
  buildSentAck,
  buildSkippedAck,
  buildDeferredAck,
  buildReminderPost,
  buildAutoReconcilePost,
  buildPossibleMatchPost,
  buildAutoSuppressPost,
  DRAFT_BODY_MARKER,
  DEFAULT_MAX,
};
