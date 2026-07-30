/**
 * Prospector Paulina — Orchestrator (Step 3.3)
 *
 * Replaces send.sh. Fired every 5 minutes by a LaunchAgent (see
 * scripts/com.lapuestadelsolresort.orchestrator.plist). One invocation:
 *
 *   1. Acquire PID-aware lockfile; exit 0 if a prior tick still running.
 *   2. Honor state.json.paused → log + healthcheck OK ping + exit.
 *   3. SELECT top-N (=tick_limit) due rows where status='approved' AND
 *      scheduled_at <= now(). FIFO by scheduled_at.
 *   4. For each row (sequentially — no Resend rate-limit risk at our volume):
 *      a. Stamp send_attempted_at=now() (diagnostic).
 *      b. Detect edit_override carve-out (compliance_failures has a row with
 *         source='edit_override' for this send_id).
 *      c. Build unsubscribe artifacts (HMAC token + List-Unsubscribe headers),
 *         render HTML body with the canonical compliance footer.
 *      d. Run evaluateCompliance(). On fail:
 *           - If isEditOverride: log compliance_failures with
 *             source='send_time_override', send anyway (skip pause matrix).
 *           - Else: log with source='send_time', cancel row, apply 3.1b pause
 *             matrix. Continue to next row.
 *      e. POST to Resend.
 *           - 200: write resend_email_id, status='sent', sent_at=now();
 *                  append to library/recent-sends.jsonl;
 *                  stamp outreach_campaigns.first_send_at if NULL;
 *                  post Slack thread reply on the original draft message.
 *           - 429: leave row at approved, KEEP send_attempted_at (diagnostic);
 *                  exit early so next tick retries naturally.
 *           - Other 4xx/5xx: status='cancelled', error=<truncated message>.
 *   5. Healthcheck OK ping. Release lock. Exit 0.
 *
 * TODO(2026-05-13): delete prospector/send.sh — orchestrator has been live
 * for 1 week per spec §11.3 sunset cadence.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const dns = require('dns').promises;
const { evaluateCompliance, recordComplianceFailure } = require('./lib/compliance');
const { buildUnsubscribeArtifacts } = require('./lib/headers');
const unsubscribeLib = require('../crm/lib/unsubscribe');
const {
  DB_PATH,
  OPENCLAW_BIN: OPENCLAW,
  secretPath,
} = require('../lib/runtime-paths');

const PROSPECTOR_DIR = __dirname;
const CONFIG_PATH = path.join(PROSPECTOR_DIR, 'config.json');
const STATE_PATH = path.join(PROSPECTOR_DIR, 'state.json');
const LOCK_PATH = path.join(PROSPECTOR_DIR, 'orchestrator.lock');
const RECENT_SENDS_PATH = path.join(PROSPECTOR_DIR, 'library', 'recent-sends.jsonl');
const UNSUB_SECRET_PATH = secretPath('unsubscribe.json');
const RESEND_SECRET_PATH = secretPath('resend.json');
const HEALTHCHECKS_PATH = secretPath('healthchecks.json');

const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

function log(...args) {
  console.log('[orchestrator]', ...args);
}
function warn(...args) {
  console.warn('[orchestrator]', ...args);
}

// ─── Lockfile (concurrent-run safety) ───────────────────────────────────────
//
// LaunchAgent fires every 5 minutes. Most ticks finish in <30s, but a Resend
// latency spike can stretch one past 5m and the next tick fires while the
// prior is still running. Both ticks would pick the same approved rows from
// the SELECT — duplicate sends to a planner. PID-aware lockfile prevents that.
// Stale lock detection via process.kill(pid, 0) lets a wedged/crashed prior
// run be reclaimed instead of blocking forever.

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    let priorPid;
    try { priorPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim()); } catch { priorPid = NaN; }
    if (Number.isFinite(priorPid)) {
      try {
        process.kill(priorPid, 0); // throws ESRCH if dead, no-op if alive
        log(`prior tick still running (pid=${priorPid}), skipping`);
        // Overlap-skip is "expected, not failure" — ping success.
        pingHealthcheck('orchestrator-tick');
        process.exit(0);
      } catch (e) {
        if (e.code === 'ESRCH') {
          warn(`stale lock (pid=${priorPid} dead), taking over`);
        } else if (e.code === 'EPERM') {
          // pid alive but owned by another user — defensive: skip
          log(`prior tick pid=${priorPid} not ours (EPERM), skipping`);
          pingHealthcheck('orchestrator-tick');
          process.exit(0);
        } else {
          warn(`unexpected error checking prior pid=${priorPid}: ${e.message}; taking lock`);
        }
      }
    } else {
      warn(`malformed lock file (could not parse pid), taking over`);
    }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim());
      if (pid === process.pid) fs.unlinkSync(LOCK_PATH);
    }
  } catch { /* best effort */ }
}

process.on('exit', releaseLock);
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('uncaughtException', (e) => {
  console.error('[orchestrator] uncaughtException:', e);
  releaseLock();
  process.exit(1);
});

// ─── Healthchecks (fail-soft) ───────────────────────────────────────────────

function pingHealthcheck(checkName, suffix = '') {
  let url;
  try {
    const cfg = JSON.parse(fs.readFileSync(HEALTHCHECKS_PATH, 'utf8'));
    const baseUrl = cfg.base_url;
    const id = cfg.checks?.[checkName];
    if (!baseUrl || !id) {
      warn(`healthcheck '${checkName}' not configured in ${HEALTHCHECKS_PATH}, skipping ping`);
      return;
    }
    url = `${baseUrl}/${id}${suffix}`;
  } catch (e) {
    warn(`healthcheck config read failed: ${e.message}`);
    return;
  }
  // Synchronous request — node exits before async fetch completes.
  // 5s timeout, errors swallowed (don't fail the tick on hc-ping flakiness).
  try {
    execFileSync('curl', ['-fsS', '--max-time', '5', url], { stdio: 'ignore' });
  } catch { /* ping failure is non-fatal */ }
}

// ─── State + secrets ────────────────────────────────────────────────────────

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { paused: false }; }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadResendKey() {
  return JSON.parse(fs.readFileSync(RESEND_SECRET_PATH, 'utf8')).api_key;
}

function loadUnsubSecret() {
  return JSON.parse(fs.readFileSync(UNSUB_SECRET_PATH, 'utf8')).secret;
}

// ─── HTML body render (verbatim semantic copy of send.sh:118-127) ───────────

function renderHtmlBody(plainBody, physicalAddress, unsubUrl) {
  const bodyBr = plainBody.replace(/\n/g, '<br>\n');
  // Keep wording identical to send.sh — same compliance footer Sarah/Jason
  // reviewed for 3.1b. Apostrophes and em-dash preserved.
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

// ─── Slack thread reply ─────────────────────────────────────────────────────

function postSlackThreadReply(channelId, threadTs, message) {
  if (!channelId || !threadTs) return Promise.resolve({ ok: false, reason: 'no_thread' });
  const account = process.env.OPENCLAW_SLACK_ACCOUNT;
  if (!account) return Promise.resolve({ ok: false, reason: 'slack_account_not_configured' });
  return new Promise((resolve) => {
    execFile(OPENCLAW, [
      'message', 'send',
      '--channel', 'slack',
      '--account', account,
      '--target', channelId,
      '--message', message,
      '--reply-to', threadTs,
      '--json',
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      try { resolve({ ok: true, raw: JSON.parse(stdout) }); }
      catch { resolve({ ok: false, error: 'parse_error' }); }
    });
  });
}

// ─── recent-sends.jsonl writeback ───────────────────────────────────────────

function appendRecentSend(send, contact) {
  const composerInputs = send.composer_inputs ? JSON.parse(send.composer_inputs) : {};
  const persona = composerInputs.persona_id || null;
  const opener = (send.body_full || '').split(/[.!?]\s/)[0].trim().slice(0, 240);
  const line = JSON.stringify({
    sent_at: new Date().toISOString(),
    persona,
    contact_id: String(send.contact_id),
    subject: send.subject,
    opener_first_sentence: opener,
    hook_angle: send.hook_angle || null,
    outreach_send_id: String(send.id),
  }) + '\n';
  fs.appendFileSync(RECENT_SENDS_PATH, line);
}

// ─── Email verification ─────────────────────────────────────────────────────

// Generic/role-based prefixes that are almost always unmonitored catch-alls.
// Sending to these drives bounces and damages sender reputation.
const ZB_SECRET_PATH = secretPath('zerobounce.json');

function loadZBKey() {
  try { return JSON.parse(fs.readFileSync(ZB_SECRET_PATH, 'utf8')).api_key; } catch (_) { return null; }
}

const RISKY_PREFIXES = new Set([
  'hello', 'info', 'contact', 'team', 'hi', 'mail', 'admin', 'support',
  'sales', 'marketing', 'office', 'enquiries', 'enquiry', 'inquiries',
  'inquiry', 'general', 'webmaster', 'postmaster', 'noreply', 'no-reply',
  'careers', 'jobs', 'billing', 'accounts', 'hr', 'press', 'media',
]);

async function verifyEmail(email) {
  if (!email || !email.includes('@')) return { ok: false, reason: 'invalid_format' };
  const [prefix, domain] = email.toLowerCase().split('@');

  // 1. Risky generic prefix check (free, instant)
  if (RISKY_PREFIXES.has(prefix)) {
    return { ok: false, reason: 'risky_prefix', detail: `"${prefix}@" is a generic catch-all inbox` };
  }

  // 2. MX record check (free, confirms domain can receive email)
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx || mx.length === 0) return { ok: false, reason: 'no_mx', detail: `No MX records for ${domain}` };
  } catch (e) {
    return { ok: false, reason: 'mx_lookup_failed', detail: e.message };
  }

  // 3. ZeroBounce SMTP verification (1 credit — confirms mailbox exists)
  const zbKey = loadZBKey();
  if (zbKey) {
    try {
      const zbRes = await fetch(
        `https://api.zerobounce.net/v2/validate?api_key=${zbKey}&email=${encodeURIComponent(email)}&ip_address=`
      );
      const zb = await zbRes.json();
      log(`  zerobounce: ${email} → status=${zb.status} sub_status=${zb.sub_status || ''}`);
      const BLOCK_STATUSES = new Set(['invalid', 'spamtrap', 'abuse', 'do_not_mail']);
      if (BLOCK_STATUSES.has(zb.status)) {
        return {
          ok: false,
          reason: `zerobounce_${zb.status}`,
          detail: `ZeroBounce: ${zb.status}${zb.sub_status ? ` (${zb.sub_status})` : ''}`,
        };
      }
      if (zb.status === 'catch-all') {
        // Catch-all domains accept everything — log but allow; risky_prefix already blocked obvious ones
        log(`  zerobounce: ${email} is catch-all — allowing but flagging`);
        return { ok: true, catchAll: true };
      }
    } catch (e) {
      // ZeroBounce network failure — don't block the send, log and continue
      warn(`  zerobounce lookup failed for ${email} (non-fatal): ${e.message}`);
    }
  } else {
    warn('  zerobounce key not found — skipping SMTP check');
  }

  return { ok: true };
}

// ─── Per-row send pipeline ──────────────────────────────────────────────────

async function processSend(db, config, send, contact, campaign) {
  const sendId = send.id;
  const contactEmail = contact.email;
  const contactId = contact.id;
  const campaignId = campaign.id;
  const campaignName = campaign.slug || campaign.name;

  log(`#${sendId} → ${contactEmail} (campaign ${campaignName})`);

  // a. Stamp send_attempted_at on every gate-attempt for diagnostic visibility.
  const attemptedAt = new Date().toISOString();
  await db.query(sql`UPDATE outreach_sends SET send_attempted_at = ${attemptedAt} WHERE id = ${sendId}`);

  // b. Edit-override carve-out detection.
  const overrides = await db.query(sql`
    SELECT 1 FROM compliance_failures WHERE outreach_send_id = ${sendId} AND source = 'edit_override' LIMIT 1
  `);
  const isEditOverride = overrides.length > 0;
  if (isEditOverride) log(`  #${sendId} has edit_override marker — gate failures will be advisory`);

  // c. Build unsubscribe artifacts + render body.
  unsubscribeLib.setSecret(loadUnsubSecret());
  const artifacts = buildUnsubscribeArtifacts(contactId, campaignName);
  const htmlBody = renderHtmlBody(send.body_full, config.physical_address, artifacts.url);

  // d. Run gate.
  const gateInput = {
    email: contactEmail,
    contactId,
    campaignId,
    campaignName,
    subject: send.subject,
    body: htmlBody,
    headers: {
      'List-Unsubscribe': artifacts.headers['List-Unsubscribe'],
      'List-Unsubscribe-Post': artifacts.headers['List-Unsubscribe-Post'],
    },
    whyContactingPresent: true,
  };
  const gate = await evaluateCompliance(db, config, gateInput);
  log(`  gate: pass=${gate.pass} pause=${gate.pauseCampaign} failures=[${gate.failures.join(',')}]`);

  if (!gate.pass) {
    if (isEditOverride) {
      // Carve-out: log with source='send_time_override', send anyway, skip pause matrix.
      await recordComplianceFailure(db, config, {
        contactId, outreachSendId: sendId, contactEmail, campaignName,
        source: 'send_time_override',
      }, { ...gate, pauseCampaign: false }); // override pauseCampaign to false — carve-out
      log(`  #${sendId} edit-override carve-out applied: gate fails advisory only, sending anyway`);
    } else {
      // Normal-path: full pause matrix, cancel row.
      await recordComplianceFailure(db, config, {
        contactId, outreachSendId: sendId, contactEmail, campaignName,
        source: 'send_time',
      }, gate);
      const errorTag = gate.failures.join(',');
      await db.query(sql`
        UPDATE outreach_sends
        SET status='cancelled', cancelled_at=datetime('now'), error=${'compliance_send_time:' + errorTag}
        WHERE id=${sendId}
      `);
      return { ok: false, reason: 'gate_failed', failures: gate.failures };
    }
  }

  // e. Email verification — MX check + risky-prefix heuristic.
  const verification = await verifyEmail(contactEmail);
  if (!verification.ok) {
    const reason = `email_verification_failed:${verification.reason}`;
    const detail = verification.detail || verification.reason;
    warn(`  #${sendId} email verification blocked send to ${contactEmail}: ${detail}`);
    await db.query(sql`
      UPDATE outreach_sends
      SET status='cancelled', cancelled_at=datetime('now'), error=${reason}
      WHERE id=${sendId}
    `);
    await db.query(sql`
      UPDATE contacts
      SET email_status='risky', updated_at=datetime('now')
      WHERE id=${contactId} AND email_status != 'bounced'
    `);
    // Notify Slack
    const slackMsg = `:no_entry: *Email verification blocked send* — ${contactEmail}\n*Reason:* ${detail}\nSend #${sendId} cancelled. Contact marked \`risky\`. Fix the address to re-queue.`;
    postSlackThreadReply(send.slack_channel_id || config.slack.draft_review_channel_id, send.slack_message_ts, slackMsg)
      .catch(() => {});
    return { ok: false, reason };
  }
  log(`  #${sendId} email verified ok: ${contactEmail}`);

  // f. Send via Resend.
  if (DRY_RUN) {
    log(`  #${sendId} DRY RUN — would POST to Resend`);
    return { ok: true, dry_run: true };
  }

  const apiKey = loadResendKey();
  const fromName = config.sender_from_name;
  const fromEmail = config.sender_from_email;
  const replyTo = config.sender_reply_to;
  // Plain-text version alongside HTML — spam filters penalise HTML-only emails.
  // Strip the injected unsubscribe footer HTML and render clean plain text.
  const plainText = send.body_full +
    `\n\n---\nTo unsubscribe: ${artifacts.url}\n${config.physical_address}`;

  const payload = {
    from: `${fromName} <${fromEmail}>`,
    to: [contactEmail],
    subject: send.subject,
    html: htmlBody,
    text: plainText,
    reply_to: replyTo,
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
      UPDATE outreach_sends SET status='cancelled', cancelled_at=datetime('now'),
                                  error=${'resend_network_error:' + e.message.slice(0, 200)}
      WHERE id=${sendId}
    `);
    return { ok: false, reason: 'resend_network_error' };
  }

  const responseBody = await resp.json().catch(() => ({}));

  // 429: retry on next tick. Leave row at approved. KEEP send_attempted_at —
  // the SELECT keys on scheduled_at, not send_attempted_at, so retry isn't
  // gated by the timestamp; preserving it gives diagnostic clarity for
  // "when did we last try".
  if (resp.status === 429) {
    warn(`  #${sendId} Resend 429 rate-limit — leaving row at approved, will retry next tick`);
    return { ok: false, reason: 'resend_rate_limit', retry: true };
  }

  if (!resp.ok || !responseBody.id) {
    const errMsg = (responseBody.message || responseBody.error || `http_${resp.status}`).toString().slice(0, 200);
    warn(`  #${sendId} Resend error: ${errMsg}`);
    await db.query(sql`
      UPDATE outreach_sends SET status='cancelled', cancelled_at=datetime('now'),
                                  error=${'resend_error:' + errMsg}
      WHERE id=${sendId}
    `);
    return { ok: false, reason: 'resend_error', error: errMsg };
  }

  // 200: success path.
  const sentAt = new Date().toISOString();
  await db.query(sql`
    UPDATE outreach_sends
    SET status='sent', sent_at=${sentAt}, resend_email_id=${responseBody.id}
    WHERE id=${sendId}
  `);
  log(`  ✅ #${sendId} sent — Resend ID: ${responseBody.id}`);

  // Stamp first_send_at if NULL (idempotent).
  await db.query(sql`
    UPDATE outreach_campaigns SET first_send_at = datetime('now')
    WHERE id = ${campaignId} AND first_send_at IS NULL
  `);

  // Bump contact lifecycle (mirror send.sh:243).
  await db.query(sql`
    UPDATE contacts SET status='contacted', last_contacted_at=datetime('now'), updated_at=datetime('now')
    WHERE id = ${contactId}
  `);

  // recent-sends.jsonl writeback (per library/README.md schema).
  try {
    appendRecentSend(send, contact);
  } catch (e) {
    warn(`  #${sendId} recent-sends append failed (non-fatal): ${e.message}`);
  }

  // Slack thread reply.
  try {
    await postSlackThreadReply(
      send.slack_channel_id,
      send.slack_message_ts,
      `📤 Sent to ${contactEmail} (resend_id: ${responseBody.id})`
    );
  } catch (e) {
    warn(`  #${sendId} Slack thread reply failed (non-fatal): ${e.message}`);
  }

  return { ok: true, resend_id: responseBody.id };
}

// ─── Main loop ──────────────────────────────────────────────────────────────

async function main() {
  acquireLock();
  pingHealthcheck('orchestrator-tick', '/start');

  // Pause check.
  const state = readState();
  if (state.paused) {
    log(`paused (paused_by=${state.paused_by || 'unknown'}), skipping due rows`);
    pingHealthcheck('orchestrator-tick');
    return { processed: 0, paused: true };
  }

  const config = loadConfig();
  const tickLimit = config.orchestrator?.tick_limit ?? 5;

  const db = createDB(DB_PATH);
  let processed = 0, sent = 0, failed = 0;
  try {
    // Fetch due rows (with joined contact + campaign data — single SELECT is cheaper).
    const dueRows = await db.query(sql`
      SELECT os.*,
             c.email AS _contact_email, c.id AS _contact_id, c.name AS _contact_name,
             oc.id AS _campaign_id, oc.slug AS _campaign_slug, oc.name AS _campaign_name
      FROM outreach_sends os
      JOIN contacts c ON c.id = os.contact_id
      LEFT JOIN outreach_campaigns oc ON oc.id = os.campaign_id
      WHERE os.status = 'approved'
        AND os.scheduled_at IS NOT NULL
        AND datetime(os.scheduled_at) <= datetime('now')
      ORDER BY os.scheduled_at ASC
      LIMIT ${tickLimit}
    `);

    log(`paused=false, due_rows=${dueRows.length}`);
    if (dueRows.length === 0) {
      pingHealthcheck('orchestrator-tick');
      return { processed: 0 };
    }

    for (const row of dueRows) {
      const contact = { id: row._contact_id, email: row._contact_email, name: row._contact_name };
      const campaign = { id: row._campaign_id, slug: row._campaign_slug, name: row._campaign_name };
      processed++;
      try {
        const r = await processSend(db, config, row, contact, campaign);
        if (r.ok) sent++; else failed++;
        if (r.retry) {
          log(`  exiting tick early to let next tick retry rate-limited row`);
          break;
        }
      } catch (e) {
        failed++;
        warn(`  #${row.id} unhandled error: ${e.message}`);
      }
    }

    log(`tick complete: processed=${processed} sent=${sent} failed=${failed}`);
    pingHealthcheck('orchestrator-tick');
    return { processed, sent, failed };
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  main()
    .then((r) => { log(`exit ok: ${JSON.stringify(r)}`); process.exit(0); })
    .catch((e) => {
      console.error('[orchestrator] FATAL:', e);
      pingHealthcheck('orchestrator-tick', '/fail');
      process.exit(1);
    });
}

module.exports = { main, acquireLock, releaseLock };
