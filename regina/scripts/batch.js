#!/usr/bin/env node
'use strict';
//
// regina/scripts/batch.js — handles `!batch <slug> [n=N]`.
//
// Phase R6: loader-driven. Reads regina/library/campaigns/<slug>.json and
// the referenced eligibility SQL, runs the SQL with :batch_size and :today
// bound, and hands the resulting contact_id list to the existing R5 draft-
// and-post pipeline (Voice Service fan-out → Slack post per draft →
// outreach_sends writeback → trailing summary).
//
// Args:
//   --campaign-slug <slug>          default: 'smoke' (from regina/config.json)
//   --n <int>                       override default_batch_size (1..100)
//   --slack-channel-id <channelId>  override config.slack.channel_id
//   --slack-user-id <user>          who issued the command (logged)
//   --dry-run                       don't post or write — print what would happen
//
// Healthchecks: regina-batch-run start/success/fail.

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
const HC_KEY = 'regina-batch-run';

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function todayIso(override) {
  if (override) {
    if (typeof override !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(override)) {
      throw new Error(`--today must be YYYY-MM-DD, got ${override}`);
    }
    return override;
  }
  return new Date().toISOString().slice(0, 10);
}

async function resolveContactIds(db, loaded, batchSize, isoToday) {
  // Smoke escape hatch: if the strategy file carries contact_ids and no
  // SQL path, the loader will return sqlText=null. Use the static list.
  if (!loaded.sqlText) {
    if (Array.isArray(loaded.config.contact_ids)) {
      return loaded.config.contact_ids.slice(0, batchSize);
    }
    throw new Error(`campaign ${loaded.config.slug}: no eligibility_sql_path and no contact_ids`);
  }
  const bound = loaded.bindParams({ batchSize, today: isoToday });
  // @databases/sql expects tagged templates, not raw strings. Use the
  // RawQuery escape hatch to execute the substituted SQL. The substitution
  // is safe because bindParams strictly validates batchSize (int 1..100)
  // and today (YYYY-MM-DD regex) before interpolation.
  const rows = await db.query(sql.__dangerous__rawValue(bound));
  return rows.map((r) => r.id);
}

async function postSlackMessage(channelId, message, opts = {}) {
  const result = await postToChannel(channelId, message, opts);
  if (!result.ok) {
    console.error('[regina/batch] Slack post failed:', result.error || '(no ts)', result.stderr || '');
  }
  return result;
}

async function run() {
  const args = parseArgs(process.argv);
  const dryRun = Boolean(args['dry-run']);
  hc.start(HC_KEY);

  let cfg, loaded;
  try {
    cfg = loadConfig();
    const slug = args['campaign-slug'] || cfg.batch.default_campaign_slug || 'smoke';
    loaded = loadCampaign(slug);
  } catch (e) {
    console.error('[regina/batch] config error:', e.message);
    hc.fail(HC_KEY, `config: ${e.message}`);
    process.exit(2);
  }

  const campaign = loaded.config;

  const channelId = args['slack-channel-id'] || cfg.slack.channel_id;
  if (!channelId || channelId.startsWith('PLACEHOLDER')) {
    const msg = 'slack channel_id not configured; set regina/config.json slack.channel_id';
    console.error('[regina/batch]', msg);
    hc.fail(HC_KEY, msg);
    process.exit(2);
  }

  // Resolve effective batch size + today.
  let batchSize, isoToday;
  try {
    const nOverride = args.n != null ? Number(args.n) : null;
    if (nOverride != null) {
      if (!Number.isInteger(nOverride) || nOverride < 1 || nOverride > 100) {
        throw new Error(`--n must be int 1..100, got ${args.n}`);
      }
      batchSize = nOverride;
    } else if (Number.isInteger(campaign.default_batch_size)) {
      batchSize = campaign.default_batch_size;
    } else if (Array.isArray(campaign.contact_ids)) {
      // Smoke escape hatch — size the slice by the array length.
      batchSize = campaign.contact_ids.length;
    } else {
      throw new Error(`campaign ${campaign.slug}: no default_batch_size and no contact_ids`);
    }
    isoToday = todayIso(args.today);
  } catch (e) {
    console.error('[regina/batch]', e.message);
    hc.fail(HC_KEY, e.message);
    process.exit(2);
  }

  const db = openDb();
  let campaignId = null;
  try {
    // 1. Resolve eligible contact_ids via SQL (or smoke escape hatch).
    let contactIds;
    try {
      contactIds = await resolveContactIds(db, loaded, batchSize, isoToday);
    } catch (e) {
      const msg = `eligibility query failed: ${e.message}`;
      console.error('[regina/batch]', msg);
      await postSlackMessage(channelId, `❌ !batch ${campaign.slug} — ${msg}`);
      hc.fail(HC_KEY, msg);
      process.exit(1);
    }

    if (contactIds.length === 0) {
      // Empty-day path: no campaign row created, no DB writes, single
      // top-level post for cadence visibility.
      const msg = `📭 !batch ${campaign.slug} — 0 eligible contacts on ${isoToday}.`;
      console.log('[regina/batch]', msg);
      if (!dryRun) await postSlackMessage(channelId, msg);
      hc.success(HC_KEY);
      return;
    }

    // 2. Build per-contact contexts; track skips.
    const contexts = [];
    const skipped = [];
    for (const contactId of contactIds) {
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
      // All eligible contacts were filtered at draft time. Post a
      // skip-only roll-up; do not create a campaign row.
      const lines = skipped.map((s) => `  - id ${s.contactId}: ${s.reason}`);
      const msg = `❌ !batch ${campaign.slug} — ${contactIds.length} eligible contact${contactIds.length === 1 ? '' : 's'} all skipped at draft time:\n${lines.join('\n')}`;
      console.warn('[regina/batch]', msg);
      if (!dryRun) await postSlackMessage(channelId, msg);
      hc.success(HC_KEY);
      return;
    }

    // 3. NOW create the campaign row (so empty-day / all-skipped paths
    //    don't leave orphan rows behind).
    if (!dryRun) {
      campaignId = await findOrCreateCampaign(db, campaign, { createdBy: 'regina:r6_batch' });
    }

    // 4. Build Voice Service payloads.
    const payloads = contexts.map(({ contactId, ctx }) => ({
      intent: campaign.intent,
      message_context: ctx.message_context,
      agent_id: 'regina',
      language: campaign.language || 'en',
      recipient_relationship: ctx.recipient_relationship,
      contact_id: contactId,
      draft_length: campaign.draft_length || cfg.batch.draft_length,
    }));

    if (dryRun) {
      console.log('[regina/batch] DRY RUN — would call Voice Service for', payloads.length, 'contacts:');
      payloads.forEach((p, i) => {
        console.log(`  ${i + 1}. contact ${p.contact_id}: ${(p.message_context || '').slice(0, 100)}...`);
      });
      hc.success(HC_KEY);
      return;
    }

    // 5. Call Voice Service (concurrency=3).
    const results = await callBatch(payloads, {
      url: cfg.voice_service.url,
      timeoutMs: cfg.voice_service.timeout_ms,
      concurrency: cfg.voice_service.concurrency || 3,
    });

    // 6. Abort gate: if every result is a service-unavailable failure,
    //    fail the whole batch and roll back the campaign row.
    const successCount = results.filter((r) => r.ok).length;
    const allFailed = successCount === 0;
    const firstError = results.find((r) => !r.ok);
    if (allFailed && firstError && firstError.error instanceof VoiceServiceError && firstError.error.status === 503) {
      const reason = `${firstError.error.service || 'unknown'} — ${firstError.error.detail || firstError.error.message}`;
      console.error('[regina/batch] Voice Service unavailable, aborting:', reason);
      await postSlackMessage(channelId, slackFmt.buildVoiceServiceDownPost(reason));
      await deleteCampaignIfEmpty(db, campaignId);
      hc.fail(HC_KEY, reason);
      process.exit(1);
    }

    // 7. For each result: insert outreach_sends, then auto-send (email) or
    //    post draft for manual handling (airbnb/whatsapp).
    const postedKinds = {};
    let postedCount = 0;
    let sentCount = 0;
    let manualCount = 0;
    let failedCount = 0;
    for (let i = 0; i < results.length; i++) {
      const { contactId, ctx } = contexts[i];
      const r = results[i];
      if (!r.ok) {
        const errMsg = r.error && r.error.message ? r.error.message : String(r.error);
        console.error(`[regina/batch] Voice Service failed for contact ${contactId}: ${errMsg}`);
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

      if (isAutoSend && ctx.contact.email) {
        // ── Auto-send path ──────────────────────────────────────────
        const sendResult = await autoSend(db, {
          sendId,
          contact: ctx.contact,
          dossier: ctx.dossier,
          draftText: draft.draft_text,
          campaignConfig: campaign,
          campaignId,
          channelId,
          dryRun,
        });

        if (sendResult.ok && !sendResult.dry_run) {
          // Post sent confirmation to Slack
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
            if (bodyOverflow) {
              await postSlackMessage(channelId, bodyOverflow, { threadTs: topResult.ts });
            }
            await db.query(sql`
              UPDATE outreach_sends
              SET slack_thread_ts = ${topResult.ts}, slack_channel_id = ${channelId}, posted_at = ${new Date().toISOString()}
              WHERE id = ${sendId}
            `);
          }
          sentCount++;
        } else if (sendResult.ok && sendResult.dry_run) {
          sentCount++;
        } else {
          // Auto-send failed — post failure notice
          await postSlackMessage(channelId, slackFmt.buildAutoSendFailedMessage({
            contact: ctx.contact,
            reason: sendResult.reason,
            detail: sendResult.detail || sendResult.error || sendResult.reason,
          }));
          failedCount++;
        }
      } else {
        // ── Manual path (airbnb thread, whatsapp, no email) ─────────
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
          if (bodyOverflow) {
            await postSlackMessage(channelId, bodyOverflow, { threadTs: topResult.ts });
          }
          await db.query(sql`
            UPDATE outreach_sends
            SET slack_thread_ts = ${topResult.ts}, slack_channel_id = ${channelId}, posted_at = ${new Date().toISOString()}
            WHERE id = ${sendId}
          `);
        }
        manualCount++;
      }

      postedCount++;
      postedKinds[campaign.campaign_kind] = (postedKinds[campaign.campaign_kind] || 0) + 1;
    }

    // Skipped notifications — single roll-up.
    if (skipped.length > 0) {
      const lines = skipped.map((s) => `  - id ${s.contactId} (${s.contact?.name || '?'}): ${s.reason}`);
      await postSlackMessage(channelId, `ℹ Skipped ${skipped.length} contact${skipped.length === 1 ? '' : 's'} at draft time:\n${lines.join('\n')}`);
    }

    // 8. Summary.
    if (postedCount > 0) {
      const summaryParts = [`📦 Reactivation batch complete — ${postedCount} contact${postedCount === 1 ? '' : 's'} processed.`];
      if (sentCount > 0) summaryParts.push(`✅ ${sentCount} auto-sent via Resend`);
      if (manualCount > 0) summaryParts.push(`📩 ${manualCount} posted for manual send`);
      if (failedCount > 0) summaryParts.push(`⚠ ${failedCount} auto-send failed`);
      summaryParts.push(`Run by !batch ${campaign.slug} at ${new Date().toISOString()}.`);
      await postSlackMessage(channelId, summaryParts.join('\n'));
    } else {
      await postSlackMessage(channelId, `📦 Batch ${campaign.slug} produced 0 drafts (all candidates skipped or failed).`);
      await deleteCampaignIfEmpty(db, campaignId);
    }

    hc.success(HC_KEY);
  } catch (e) {
    console.error('[regina/batch] unexpected error:', e);
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
    console.error('[regina/batch] fatal:', e);
    process.exit(1);
  });
}

module.exports = { run, resolveContactIds };
