#!/usr/bin/env node
'use strict';
//
// regina/scripts/anniversary-cron.js — daily anniversary trigger.
//
// Phase R6: loader-driven. Calls loadCampaign('anniversary') and runs the
// SQL with :batch_size and :today bound. The campaign uses one stable
// outreach_campaigns row (slug='anniversary'), shared across all daily
// fires. The SQL's NOT EXISTS clause uses created_at > date('now', '-300
// days') (annual cadence with 65-day buffer) instead of the status set
// used by other campaigns.
//
// On zero-eligible days, still posts a cadence-visibility line:
//   📅 Anniversary check — <YYYY-MM-DD> — no eligible contacts today.
//
// Args:
//   --date YYYY-MM-DD   override "today" for testing
//   --dry-run           print, don't write or post
//
// Healthchecks: regina-anniversary-cron.

const fs = require('fs');
const path = require('path');
const { sql } = require('@databases/sqlite');
const { parseArgs } = require('../lib/cli-args');
const { openDb } = require('../lib/db');
const { buildContext } = require('../lib/dossier-context');
const { callBatch, VoiceServiceError } = require('../lib/voice-service');
const { postToChannel } = require('../../crm/lib/slack-post');
const slackFmt = require('../lib/slack-format');
const hc = require('../lib/healthcheck');
const { loadCampaign } = require('../lib/campaign-loader');
const { findOrCreateCampaign, deleteCampaignIfEmpty } = require('../lib/outreach-campaign');
const { autoSend } = require('../lib/auto-send');

const REGINA_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REGINA_ROOT, 'config.json');
const HC_KEY = 'regina-anniversary-cron';
const CAMPAIGN_SLUG = 'anniversary';

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function todayIso(overrideIsoDate) {
  if (overrideIsoDate) {
    if (typeof overrideIsoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(overrideIsoDate)) {
      throw new Error(`--date must be YYYY-MM-DD; got ${overrideIsoDate}`);
    }
    return overrideIsoDate;
  }
  return new Date().toISOString().slice(0, 10);
}

async function eligibleContactIds(db, loaded, isoToday) {
  const bound = loaded.bindParams({ batchSize: loaded.config.default_batch_size, today: isoToday });
  const rows = await db.query(sql.__dangerous__rawValue(bound));
  return rows.map((r) => r.id);
}

async function postSlackMessage(channelId, message, opts = {}) {
  const r = await postToChannel(channelId, message, opts);
  if (!r.ok) {
    console.error('[regina/anniversary] Slack post failed:', r.error || '(no ts)', r.stderr || '');
  }
  return r;
}

async function run() {
  const args = parseArgs(process.argv);
  const dryRun = Boolean(args['dry-run']);
  hc.start(HC_KEY);

  let cfg, loaded, isoDate;
  try {
    cfg = loadConfig();
    loaded = loadCampaign(CAMPAIGN_SLUG);
    isoDate = todayIso(typeof args.date === 'string' ? args.date : null);
  } catch (e) {
    console.error('[regina/anniversary]', e.message);
    hc.fail(HC_KEY, e.message);
    process.exit(2);
  }

  const campaign = loaded.config;
  const channelId = args['slack-channel-id'] || cfg.slack.channel_id;
  if (!channelId || channelId.startsWith('PLACEHOLDER')) {
    const msg = 'slack channel_id not configured';
    console.error('[regina/anniversary]', msg);
    hc.fail(HC_KEY, msg);
    process.exit(2);
  }

  const db = openDb();
  let campaignId = null;
  try {
    const ids = await eligibleContactIds(db, loaded, isoDate);

    if (ids.length === 0) {
      const msg = slackFmt.buildEmptyAnniversaryPost(isoDate);
      console.log('[regina/anniversary]', msg);
      if (!dryRun) await postSlackMessage(channelId, msg);
      hc.success(HC_KEY);
      return;
    }

    const contexts = [];
    const skipped = [];
    for (const contactId of ids) {
      const ctx = await buildContext(db, contactId, campaign, {
        autoSendEnabled: cfg.auto_send?.enabled === true,
      });
      if (!ctx.ok) {
        skipped.push({ contactId, reason: ctx.skip_reason, contact: ctx.contact });
        continue;
      }
      contexts.push({ contactId, ctx });
    }

    if (contexts.length === 0) {
      const msg = `📅 Anniversary check — ${isoDate} — ${ids.length} candidate${ids.length === 1 ? '' : 's'} matched the date but all were skipped:\n` +
                  skipped.map((s) => `  - id ${s.contactId}: ${s.reason}`).join('\n');
      console.log('[regina/anniversary]', msg);
      if (!dryRun) await postSlackMessage(channelId, msg);
      hc.success(HC_KEY);
      return;
    }

    if (dryRun) {
      console.log(`[regina/anniversary] DRY RUN — would draft for ${contexts.length} contacts on ${isoDate}`);
      contexts.forEach((c) => console.log(`  - id ${c.contactId}: ${c.ctx.contact.name}`));
      hc.success(HC_KEY);
      return;
    }

    // NOW create the stable-slug campaign row (idempotent across daily
    // fires; the helper short-circuits if slug='anniversary' already
    // exists).
    campaignId = await findOrCreateCampaign(db, campaign, { createdBy: 'regina:r6_anniversary_cron' });

    const payloads = contexts.map(({ contactId, ctx }) => ({
      intent: campaign.intent,
      message_context: ctx.message_context,
      agent_id: 'regina',
      language: campaign.language || 'en',
      recipient_relationship: ctx.recipient_relationship,
      contact_id: contactId,
      draft_length: campaign.draft_length || cfg.batch.draft_length,
    }));

    const results = await callBatch(payloads, {
      url: cfg.voice_service.url,
      timeoutMs: cfg.voice_service.timeout_ms,
      concurrency: cfg.voice_service.concurrency || 3,
    });

    const successCount = results.filter((r) => r.ok).length;
    const firstError = results.find((r) => !r.ok);
    if (successCount === 0 && firstError && firstError.error instanceof VoiceServiceError && firstError.error.status === 503) {
      const reason = `${firstError.error.service || 'unknown'} — ${firstError.error.detail || firstError.error.message}`;
      console.error('[regina/anniversary] Voice Service unavailable, aborting:', reason);
      await postSlackMessage(channelId, slackFmt.buildVoiceServiceDownPost(reason));
      // Don't delete the stable anniversary row — it was likely already
      // present from a prior fire. deleteCampaignIfEmpty is a no-op if
      // any sends reference it.
      await deleteCampaignIfEmpty(db, campaignId);
      hc.fail(HC_KEY, reason);
      process.exit(1);
    }

    let postedCount = 0;
    let sentCount = 0;
    let manualCount = 0;
    let failedCount = 0;
    let ambiguousCount = 0;
    const postedKinds = {};
    for (let i = 0; i < results.length; i++) {
      const { contactId, ctx } = contexts[i];
      const r = results[i];
      if (!r.ok) {
        const errMsg = r.error && r.error.message ? r.error.message : String(r.error);
        await postSlackMessage(channelId, slackFmt.buildPerDraftErrorPost({ contact: ctx.contact, error: errMsg }));
        continue;
      }
      const draft = r.result;
      const isAutoSend = ctx.send_method === 'resend';

      await db.query(sql`
        INSERT INTO outreach_sends
          (contact_id, campaign_id, sequence_step, subject, body_full, body_preview,
           status, send_method, draft_text, voice_drafts_log_id, created_at)
        VALUES
          (${contactId}, ${campaignId}, ${1}, ${''},
           ${draft.draft_text}, ${(draft.draft_text || '').slice(0, 200)},
           ${isAutoSend ? 'approved' : 'drafted'}, ${ctx.send_method}, ${draft.draft_text},
           ${draft.voice_drafts_log_id}, ${new Date().toISOString()})
      `);
      const [{ id: sendId }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
      const workflowRunId = typeof process.env.WORKFLOW_RUN_ID === 'string'
        ? process.env.WORKFLOW_RUN_ID.trim() : '';
      if (workflowRunId) {
        await db.query(sql`UPDATE outreach_sends SET workflow_run_id=${workflowRunId} WHERE id=${sendId}`);
      }

      if (isAutoSend && ctx.contact.email) {
        const sendResult = await autoSend(db, {
          sendId,
          contact: ctx.contact,
          dossier: ctx.dossier,
          draftText: draft.draft_text,
          campaignConfig: campaign,
          campaignId,
          channelId,
        });
        if (sendResult.ok) {
          const { topLevel, bodyOverflow } = slackFmt.buildAutoSentMessage({
            campaignKind: campaign.campaign_kind,
            contact: ctx.contact,
            dossier: ctx.dossier,
            draftText: draft.draft_text,
            subject: sendResult.subject,
            resendId: sendResult.resend_id,
            maxChars: cfg.batch.max_message_chars,
          });
          const topResult = await postSlackMessage(channelId, topLevel);
          if (topResult.ok && topResult.ts) {
            if (bodyOverflow) await postSlackMessage(channelId, bodyOverflow, { threadTs: topResult.ts });
            await db.query(sql`
              UPDATE outreach_sends SET slack_thread_ts=${topResult.ts}, slack_channel_id=${channelId}, posted_at=${new Date().toISOString()} WHERE id=${sendId}
            `);
          }
          sentCount++;
        } else {
          await postSlackMessage(channelId, slackFmt.buildAutoSendFailedMessage({
            contact: ctx.contact, reason: sendResult.reason, detail: sendResult.detail || sendResult.reason,
          }));
          failedCount++;
          if (sendResult.ambiguous) ambiguousCount++;
        }
      } else {
        const { topLevel, bodyOverflow } = slackFmt.buildManualDraftMessage({
          campaignKind: campaign.campaign_kind,
          contact: ctx.contact,
          dossier: ctx.dossier,
          draftText: draft.draft_text,
          sendMethod: ctx.send_method,
          maxChars: cfg.batch.max_message_chars,
        });
        const topResult = await postSlackMessage(channelId, topLevel);
        if (topResult.ok && topResult.ts) {
          if (bodyOverflow) await postSlackMessage(channelId, bodyOverflow, { threadTs: topResult.ts });
          await db.query(sql`
            UPDATE outreach_sends SET slack_thread_ts=${topResult.ts}, slack_channel_id=${channelId}, posted_at=${new Date().toISOString()} WHERE id=${sendId}
          `);
        }
        manualCount++;
      }
      postedCount++;
      postedKinds[campaign.campaign_kind] = (postedKinds[campaign.campaign_kind] || 0) + 1;
    }

    if (skipped.length > 0) {
      const lines = skipped.map((s) => `  - id ${s.contactId} (${s.contact?.name || '?'}): ${s.reason}`);
      await postSlackMessage(channelId, `ℹ Anniversary skipped ${skipped.length}:\n${lines.join('\n')}`);
    }

    if (postedCount > 0) {
      const summaryParts = [`📅 Anniversary ${isoDate} — ${postedCount} contact${postedCount === 1 ? '' : 's'} processed.`];
      if (sentCount > 0) summaryParts.push(`✅ ${sentCount} auto-sent via Resend`);
      if (manualCount > 0) summaryParts.push(`📩 ${manualCount} posted for manual send`);
      if (failedCount > 0) summaryParts.push(`⚠ ${failedCount} auto-send failed`);
      await postSlackMessage(channelId, summaryParts.join('\n'));
    } else {
      await postSlackMessage(channelId, `📅 Anniversary check — ${isoDate} — 0 drafts produced.`);
      // No-op if any prior anniversary sends reference this row.
      await deleteCampaignIfEmpty(db, campaignId);
    }

    if (ambiguousCount > 0) {
      throw new Error(`${ambiguousCount} Resend request(s) have ambiguous provider acceptance and require review`);
    }
    hc.success(HC_KEY);
  } catch (e) {
    console.error('[regina/anniversary] unexpected error:', e);
    if (campaignId != null) {
      try { await deleteCampaignIfEmpty(db, campaignId); } catch (_) { /* non-fatal */ }
    }
    hc.fail(HC_KEY, e.message || String(e));
    process.exit(1);
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('[regina/anniversary] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run, eligibleContactIds, todayIso };
