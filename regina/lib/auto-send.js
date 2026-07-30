'use strict';
//
// auto-send.js — Regina auto-send pipeline.
//
// Takes a drafted outreach_sends row + contact + campaign, verifies the email,
// runs the compliance gate, generates a subject line, renders HTML, and sends
// via Resend. Same pipeline as Paulina's orchestrator.js, adapted for Regina's
// reactivation context.
//
// Reuses Paulina's proven libs:
//   - prospector/lib/compliance.js  (7-item gate)
//   - prospector/lib/headers.js     (unsubscribe artifacts)
//   - crm/lib/unsubscribe.js        (HMAC token generation)
//
// Only sends to contacts whose send_method is 'resend'. Airbnb-thread-only
// and WhatsApp contacts are skipped (posted to Slack for manual handling).

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { sql } = require('@databases/sqlite');

const { evaluateCompliance, recordComplianceFailure } = require('../../prospector/lib/compliance');
const { buildUnsubscribeArtifacts } = require('../../prospector/lib/headers');
const unsubscribeLib = require('../../crm/lib/unsubscribe');
const { ROOT, secretPath } = require('../../lib/runtime-paths');

const RESEND_SECRET_PATH = secretPath('resend.json');
const UNSUB_SECRET_PATH = secretPath('unsubscribe.json');
const ZB_SECRET_PATH = secretPath('zerobounce.json');
const PROSPECTOR_CONFIG_PATH = path.join(ROOT, 'prospector', 'config.json');

function log(...args) { console.log('[regina/auto-send]', ...args); }
function warn(...args) { console.warn('[regina/auto-send]', ...args); }

function loadResendKey() {
  return JSON.parse(fs.readFileSync(RESEND_SECRET_PATH, 'utf8')).api_key;
}

function loadUnsubSecret() {
  return JSON.parse(fs.readFileSync(UNSUB_SECRET_PATH, 'utf8')).secret;
}

function loadProspectorConfig() {
  return JSON.parse(fs.readFileSync(PROSPECTOR_CONFIG_PATH, 'utf8'));
}

// ─── Subject line generation ────────────────────────────────────────────────
//
// Voice Service returns body-only. Generate a short, personal subject line
// from the draft body + contact context. Uses Anthropic (same as Voice Service).

async function generateSubject(draftText, contact, dossier, campaignConfig) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fallback: simple subject from campaign kind
    return fallbackSubject(contact, campaignConfig);
  }

  const prompt = `You are writing a subject line for a personal email from Sarah at La Puesta del Sol Resort in Mexico. The email is a past-guest reactivation message.

Recipient: ${contact.name || 'Guest'}
Campaign type: ${campaignConfig.campaign_kind || 'reactivation'}
${dossier.trip_purpose ? `Trip purpose: ${dossier.trip_purpose}` : ''}
${dossier.notes_for_sarah ? `Context: ${dossier.notes_for_sarah.slice(0, 200)}` : ''}

Email body:
${draftText.slice(0, 500)}

Write ONE subject line. Rules:
- Max 60 characters
- Personal, warm, conversational — like a friend checking in
- No ALL CAPS, no exclamation marks, no clickbait
- Reference something specific about their trip or interest if possible
- No quotation marks around the subject

Subject line:`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.REGINA_SUBJECT_MODEL || 'claude-sonnet-4-6',
        max_tokens: 80,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      warn(`subject generation API error: ${resp.status}`);
      return fallbackSubject(contact, campaignConfig);
    }

    const data = await resp.json();
    const subject = (data.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '');
    if (subject && subject.length <= 80) return subject;
    return fallbackSubject(contact, campaignConfig);
  } catch (e) {
    warn(`subject generation failed: ${e.message}`);
    return fallbackSubject(contact, campaignConfig);
  }
}

function fallbackSubject(contact, campaignConfig) {
  const name = contact.name ? contact.name.split(/\s+/)[0] : '';
  const kind = campaignConfig.campaign_kind || 'reactivation';
  if (name) return `${name}, thinking of you`;
  return 'Thinking of you from La Puesta';
}

// ─── Email verification (copied from Paulina orchestrator) ──────────────────

const RISKY_PREFIXES = new Set([
  'info', 'contact', 'hello', 'admin', 'support', 'team', 'sales',
  'office', 'help', 'service', 'general', 'mail', 'enquiries',
  'enquiry', 'reception', 'booking', 'bookings', 'reservations',
  'noreply', 'no-reply', 'postmaster', 'webmaster',
]);

async function verifyEmail(email) {
  const [prefix, domain] = email.split('@');
  if (!prefix || !domain) return { ok: false, reason: 'invalid_email', detail: 'missing @ or domain' };

  // 1. Risky prefix
  if (RISKY_PREFIXES.has(prefix.toLowerCase())) {
    return { ok: false, reason: 'risky_prefix', detail: `"${prefix}@" is a generic catch-all inbox` };
  }

  // 2. MX record check
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) {
      return { ok: false, reason: 'no_mx', detail: `${domain} has no MX records` };
    }
  } catch (e) {
    return { ok: false, reason: 'mx_lookup_failed', detail: `${domain}: ${e.code || e.message}` };
  }

  // 3. ZeroBounce (optional)
  try {
    const zbKey = JSON.parse(fs.readFileSync(ZB_SECRET_PATH, 'utf8')).api_key;
    if (zbKey) {
      const zbResp = await fetch(
        `https://api.zerobounce.net/v2/validate?api_key=${zbKey}&email=${encodeURIComponent(email)}&ip_address=`
      );
      const zb = await zbResp.json();
      log(`  zerobounce: ${email} → status=${zb.status} sub_status=${zb.sub_status || ''}`);
      if (['invalid', 'spamtrap', 'abuse', 'do_not_mail'].includes(zb.status)) {
        return { ok: false, reason: `zerobounce_${zb.status}`, detail: `${zb.status}: ${zb.sub_status || ''}` };
      }
    }
  } catch (e) {
    warn(`  zerobounce lookup failed for ${email} (non-fatal): ${e.message}`);
  }

  return { ok: true };
}

// ─── HTML body rendering ────────────────────────────────────────────────────

function renderHtmlBody(plainBody, physicalAddress, unsubUrl) {
  const bodyBr = plainBody.replace(/\n/g, '<br>\n');
  return [
    '<div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">',
    bodyBr,
    '<br>',
    '<hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">',
    '<p style="font-size: 11px; color: #999;">',
    `${physicalAddress}<br>`,
    `Reply 'unsubscribe' to unsubscribe@outreach.lapuestadelsolresort.com or <a href="${unsubUrl}">click here to unsubscribe</a> &mdash; I'll remove you immediately.`,
    '</p>',
    '</div>',
    '',
  ].join('\n');
}

// ─── Main send pipeline ────────────────────────────────────────────────────

/**
 * Auto-send a Regina draft via Resend.
 *
 * @param {object} db - @databases/sqlite handle
 * @param {object} params
 * @param {number} params.sendId - outreach_sends.id
 * @param {object} params.contact - contact row
 * @param {object} params.dossier - guest_dossiers row
 * @param {string} params.draftText - Voice Service draft body
 * @param {object} params.campaignConfig - campaign JSON from library
 * @param {number} params.campaignId - outreach_campaigns.id
 * @param {boolean} [params.dryRun=false]
 * @returns {Promise<{ok: boolean, reason?: string, resend_id?: string, subject?: string}>}
 */
async function autoSend(db, params) {
  const {
    sendId, contact, dossier, draftText, campaignConfig, campaignId,
    dryRun = false,
  } = params;

  const contactEmail = contact.email;
  const contactId = contact.id;
  const campaignName = campaignConfig.slug || campaignConfig.name || 'regina_reactivation';

  log(`#${sendId} → ${contactEmail} (campaign ${campaignName})`);

  // 1. Generate subject line
  const subject = await generateSubject(draftText, contact, dossier, campaignConfig);
  log(`  subject: "${subject}"`);

  // Update the send row with the subject
  await db.query(sql`UPDATE outreach_sends SET subject = ${subject} WHERE id = ${sendId}`);

  // 2. Email verification
  const verification = await verifyEmail(contactEmail);
  if (!verification.ok) {
    const reason = `email_verification_failed:${verification.reason}`;
    warn(`  #${sendId} email verification blocked: ${verification.detail}`);
    await db.query(sql`
      UPDATE outreach_sends SET status='cancelled', cancelled_at=datetime('now'), error=${reason} WHERE id=${sendId}
    `);
    await db.query(sql`
      UPDATE contacts SET email_status='risky', updated_at=datetime('now') WHERE id=${contactId} AND email_status != 'bounced'
    `);
    return { ok: false, reason, detail: verification.detail };
  }
  log(`  email verified: ${contactEmail}`);

  // 3. Build unsubscribe artifacts + render HTML
  unsubscribeLib.setSecret(loadUnsubSecret());
  const artifacts = buildUnsubscribeArtifacts(contactId, campaignName);
  const pConfig = loadProspectorConfig();
  const htmlBody = renderHtmlBody(draftText, pConfig.physical_address, artifacts.url);
  const plainText = draftText + `\n\n---\nTo unsubscribe: ${artifacts.url}\n${pConfig.physical_address}`;

  // 4. Compliance gate
  const gateInput = {
    email: contactEmail,
    contactId,
    campaignId,
    campaignName,
    subject,
    body: htmlBody,
    headers: {
      'List-Unsubscribe': artifacts.headers['List-Unsubscribe'],
      'List-Unsubscribe-Post': artifacts.headers['List-Unsubscribe-Post'],
    },
    requiresWhyContactingDisclosure: false,
  };

  const gate = await evaluateCompliance(db, pConfig, gateInput);
  const failureCodes = gate.failures.map((failure) => (
    typeof failure === 'string'
      ? failure
      : failure.failed_check || failure.code || 'unknown_failure'
  ));
  log(`  gate: pass=${gate.pass} failures=[${failureCodes.join(',')}]`);

  if (!gate.pass) {
    await recordComplianceFailure(db, pConfig, {
      contactId, outreachSendId: sendId, contactEmail, campaignName,
      source: 'send_time',
    }, { ...gate, pauseCampaign: false }); // Don't pause Regina on gate fail — just skip this contact
    const errorTag = failureCodes.join(',');
    await db.query(sql`
      UPDATE outreach_sends SET status='cancelled', cancelled_at=datetime('now'), error=${'compliance_gate:' + errorTag} WHERE id=${sendId}
    `);
    return { ok: false, reason: 'gate_failed', failures: gate.failures };
  }

  // 5. Dry run escape
  if (dryRun) {
    log(`  #${sendId} DRY RUN — would send via Resend`);
    return { ok: true, dry_run: true, subject };
  }

  // 6. Send via Resend
  const apiKey = loadResendKey();
  const payload = {
    from: `${pConfig.sender_from_name} <${pConfig.sender_from_email}>`,
    to: [contactEmail],
    subject,
    html: htmlBody,
    text: plainText,
    reply_to: pConfig.sender_reply_to,
    tags: [{ name: 'outreach_send_id', value: String(sendId) }],
    headers: {
      'List-Unsubscribe': artifacts.headers['List-Unsubscribe'],
      'List-Unsubscribe-Post': artifacts.headers['List-Unsubscribe-Post'],
    },
  };

  let resp;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    warn(`  #${sendId} Resend network error: ${e.message}`);
    await db.query(sql`
      UPDATE outreach_sends SET status='cancelled', cancelled_at=datetime('now'), error=${'resend_network_error:' + e.message.slice(0, 200)} WHERE id=${sendId}
    `);
    return { ok: false, reason: 'resend_network_error' };
  }

  const responseBody = await resp.json().catch(() => ({}));

  if (resp.status === 429) {
    warn(`  #${sendId} Resend 429 — cancelling this attempt so a later batch can retry safely`);
    await db.query(sql`
      UPDATE outreach_sends
      SET status='cancelled', cancelled_at=datetime('now'), error='resend_rate_limit'
      WHERE id=${sendId}
    `);
    return { ok: false, reason: 'resend_rate_limit', retry: true };
  }

  if (!resp.ok || !responseBody.id) {
    const errMsg = (responseBody.message || responseBody.error || `http_${resp.status}`).toString().slice(0, 200);
    warn(`  #${sendId} Resend error: ${errMsg}`);
    await db.query(sql`
      UPDATE outreach_sends SET status='cancelled', cancelled_at=datetime('now'), error=${'resend_error:' + errMsg} WHERE id=${sendId}
    `);
    return { ok: false, reason: 'resend_error', error: errMsg };
  }

  // 7. Success — update DB
  const sentAt = new Date().toISOString();
  await db.query(sql`
    UPDATE outreach_sends
    SET status='sent', sent_at=${sentAt}, resend_email_id=${responseBody.id}, send_method='resend'
    WHERE id=${sendId}
  `);
  log(`  ✅ #${sendId} sent — Resend ID: ${responseBody.id}`);

  // Stamp first_send_at if NULL
  await db.query(sql`
    UPDATE outreach_campaigns SET first_send_at = datetime('now')
    WHERE id = ${campaignId} AND first_send_at IS NULL
  `);

  // Bump contact lifecycle
  await db.query(sql`
    UPDATE contacts SET status='contacted', last_contacted_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ${contactId}
  `);

  // Update voice_drafts_log outcome
  const sendRow = await db.query(sql`SELECT voice_drafts_log_id FROM outreach_sends WHERE id=${sendId}`);
  if (sendRow[0]?.voice_drafts_log_id) {
    await db.query(sql`
      UPDATE voice_drafts_log SET outcome='sent_as_is', sent_text=${draftText}, edit_distance=0
      WHERE id=${sendRow[0].voice_drafts_log_id}
    `);
  }

  return { ok: true, resend_id: responseBody.id, subject };
}

module.exports = { autoSend, generateSubject, verifyEmail, renderHtmlBody };
