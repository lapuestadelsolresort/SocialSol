'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sql } = require('@databases/sqlite');
const { ROOT } = require('../../lib/runtime-paths');
const { nodeCommand } = require('../lib/workflow-command');
const { notificationTargets, lastJsonValue } = require('./durable-job');

const CONFIG_PATH = path.join(ROOT, 'prospector', 'config.json');
const STATE_PATH = path.join(ROOT, 'prospector', 'state.json');
const TIME_ZONE = 'America/Los_Angeles';
const PERSONAS = ['wedding_planner', 'houston_wedding_planner'];

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function localDay(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    weekdayIndex,
    isWeekend: weekdayIndex === 0 || weekdayIndex === 6,
  };
}

function validate(input = {}) {
  const allowed = new Set(['dryRun', 'skipAnalysis', 'skipResearch']);
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Error(`unknown Paulina preparation input: ${key}`);
    if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
  }
}

function stopReason(state) {
  if (state.preflight?.skipped) return state.preflight.reason;
  if (state.capacity?.batchSize === 0) return 'capacity_already_committed';
  return null;
}

function verifiedEffectResponse(effect) {
  if (effect?.status !== 'verified_by_readback') return null;
  return readJsonValue(effect.response_json)?.summary || null;
}

function readJsonValue(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function runVerifiedCommand(context, {
  provider,
  operation,
  request,
  command,
  readback,
}) {
  const { db, run, services, store, stepKey } = context;
  let effect;
  try {
    effect = await store.createEffect(db, {
      runId: run.id,
      stepKey,
      effectType: 'external_mutation',
      provider,
      operation,
      idempotencyKey: `${run.id}:${stepKey}:${provider}:${operation}`,
      request,
      target: { campaign: context.state.preflight?.campaignSlug || null },
      verificationMode: 'readback_required',
    });
  } catch (error) {
    error.retryable = true;
    throw error;
  }

  const replay = verifiedEffectResponse(effect);
  if (replay) return { effectId: effect.id, replayed: true, summary: replay };
  if (effect.status !== 'requested') {
    const error = new Error(`Paulina preparation effect is not replayable from ${effect.status}`);
    error.code = 'workflow_effect_not_replayable';
    error.requiresManualReview = true;
    throw error;
  }
  if (typeof services.runCommand !== 'function') {
    const error = new Error('workflow command service is unavailable');
    error.retryable = true;
    throw error;
  }

  let result;
  try {
    result = await services.runCommand(command);
  } catch (error) {
    error.code = 'ambiguous_external_result';
    error.retryable = false;
    throw error;
  }
  const providerRef = `job:${run.id}:${stepKey}`;
  try {
    await store.transitionEffect(db, {
      effectId: effect.id,
      providerRef,
      status: 'accepted_by_provider',
      providerStatus: 'process_exit_0',
      response: {
        exitCode: result.exitCode,
        stdoutHash: store.sha256(result.stdout),
        stderrHash: store.sha256(result.stderr),
      },
    });
    const summary = await readback(result);
    if (!summary || summary.ok !== true) {
      throw new Error(`${operation} did not produce a verified readback`);
    }
    const evidence = await store.createEvidence(db, {
      runId: run.id,
      stepKey,
      source: `${provider}.readback`,
      sourceRef: providerRef,
      payload: summary,
    });
    await store.transitionEffect(db, {
      effectId: effect.id,
      providerRef,
      status: 'verified_by_readback',
      providerStatus: 'workflow_readback_verified',
      response: { summary, evidenceId: evidence.id, evidencePayloadHash: evidence.payloadHash },
    });
    return { effectId: effect.id, providerRef, replayed: false, summary, evidenceId: evidence.id };
  } catch (error) {
    error.code = error.code || 'readback_not_verified';
    error.retryable = false;
    error.requiresManualReview = true;
    throw error;
  }
}

const definition = {
  name: 'paulina.prepare_daily',
  version: 1,
  capability: 'paulina.prepare',
  mutates: true,
  autonomous: true,
  allowedTriggers: ['system'],
  serializeMutations: true,
  crashRecovery: 'manual',
  notificationChannelName: 'prospector-paulina',
  validate,
  steps: [
    {
      key: 'preflight',
      effectClass: 'read',
      maxAttempts: 3,
      async run({ input, services }) {
        const config = services.paulinaConfig || readJson(CONFIG_PATH, {});
        const state = services.paulinaState || readJson(STATE_PATH, {});
        const day = localDay(services.now ? new Date(services.now) : new Date());
        const paused = state.paused === true;
        const reason = day.isWeekend
          ? 'weekend'
          : (paused ? `paused:${state.pause_reason || 'unspecified'}` : null);
        return {
          localDate: day.date,
          weekday: day.weekday,
          weekdayIndex: day.weekdayIndex,
          campaignSlug: process.env.PAULINA_CAMPAIGN_SLUG
            || config.reporting?.active_campaign_slug
            || 'planner_partner_program_v1',
          queueBufferDays: Math.max(1, Number(config.email_verification?.queue_buffer_days || 2)),
          maxVerify: Math.max(0, Number(config.email_verification?.max_per_daily_run || 25)),
          dryRun: input.dryRun === true,
          skipped: Boolean(reason),
          reason,
        };
      },
    },
    {
      key: 'analyze_engagement',
      effectClass: 'external_non_idempotent',
      maxAttempts: 2,
      async run(context) {
        const { input, run, state } = context;
        if (state.preflight.skipped || input.skipAnalysis === true) {
          return { skipped: true, reason: state.preflight.reason || 'operator_skip' };
        }
        const args = ['--no-slack', '--json', '--workflow-run-id', run.id];
        if (state.preflight.dryRun) args.push('--dry-run');
        return runVerifiedCommand(context, {
          provider: 'anthropic',
          operation: 'engagement_analysis',
          request: { campaignSlug: state.preflight.campaignSlug, dryRun: state.preflight.dryRun },
          command: nodeCommand('prospector/scripts/engagement-analysis.js', args, {
            timeoutMs: 10 * 60_000,
            env: { WORKFLOW_RUN_ID: run.id },
          }),
          readback: async result => lastJsonValue(result.stdout),
        });
      },
    },
    {
      key: 'capacity',
      effectClass: 'external_read',
      maxAttempts: 3,
      async run({ state, services }) {
        if (state.preflight.skipped) return { skipped: true, reason: state.preflight.reason, batchSize: 0 };
        const result = await services.runCommand(nodeCommand(
          'prospector/scripts/daily-capacity.js',
          [state.preflight.campaignSlug],
        ));
        const parsed = lastJsonValue(result.stdout);
        if (!parsed?.ok || !Number.isInteger(parsed.batch_size)) {
          const error = new Error('Paulina capacity readback was unavailable');
          error.retryable = true;
          throw error;
        }
        return {
          batchSize: parsed.batch_size,
          dailyTarget: parsed.daily_target,
          weeklyCap: parsed.weekly_cap,
          campaignWeek: parsed.campaign_week,
        };
      },
    },
    {
      key: 'research',
      effectClass: 'external_non_idempotent',
      maxAttempts: 2,
      async run(context) {
        const { input, run, state } = context;
        const stopped = state.preflight.skipped ? state.preflight.reason : null;
        if (stopped || input.skipResearch === true) {
          return { skipped: true, reason: stopped || 'operator_skip' };
        }
        const persona = PERSONAS[(state.preflight.weekdayIndex - 1) % PERSONAS.length];
        const runDate = `${state.preflight.localDate}-wf-${run.id.slice(0, 8)}`;
        const args = ['--persona', persona, '--run-date', runDate, '--json'];
        if (state.preflight.dryRun) args.push('--dry-run');
        return runVerifiedCommand(context, {
          provider: 'brave+anthropic+crm',
          operation: 'planner_research',
          request: { persona, runDate, dryRun: state.preflight.dryRun },
          command: nodeCommand('prospector/research/scripts/run-research.js', args, {
            timeoutMs: 45 * 60_000,
            env: { WORKFLOW_RUN_ID: run.id, PAULINA_WORKFLOW_NO_SLACK: '1' },
          }),
          readback: async result => lastJsonValue(result.stdout),
        });
      },
    },
    {
      key: 'attach_contacts',
      effectClass: 'local_write',
      maxAttempts: 3,
      async run({ db, run, state }) {
        const stopped = state.preflight.skipped ? state.preflight.reason : null;
        if (stopped) return { skipped: true, reason: stopped, attached: 0 };
        const [campaign] = await db.query(sql`SELECT id FROM outreach_campaigns
          WHERE slug=${state.preflight.campaignSlug} AND status='active' LIMIT 1`);
        if (!campaign) throw new Error(`active Paulina campaign not found: ${state.preflight.campaignSlug}`);
        const candidates = await db.query(sql`SELECT c.id
          FROM contacts c
          WHERE c.email IS NOT NULL AND trim(c.email) <> ''
            AND COALESCE(c.do_not_contact, 0) = 0
            AND COALESCE(c.status, 'new') NOT IN ('replied', 'converted', 'dead')
            AND (
              c.source_query LIKE '%_wedding_planner'
              OR c.source_query LIKE '%_houston_wedding_planner'
              OR EXISTS (
                SELECT 1 FROM campaign_contacts old_cc
                JOIN outreach_campaigns old_oc ON old_oc.id=old_cc.campaign_id
                WHERE old_cc.contact_id=c.id AND old_oc.slug='planner_outreach_v1'
              )
            )
            AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE lower(s.email)=lower(c.email))
            AND NOT EXISTS (SELECT 1 FROM campaign_contacts cc
              WHERE cc.campaign_id=${campaign.id} AND cc.contact_id=c.id)`);
        if (state.preflight.dryRun || !candidates.length) {
          return { attached: 0, wouldAttach: candidates.length, dryRun: state.preflight.dryRun };
        }
        const attached = await db.query(sql`INSERT OR IGNORE INTO campaign_contacts
          (campaign_id, contact_id, attached_by)
          SELECT ${campaign.id}, c.id, ${`workflow:${run.id}`}
          FROM contacts c
          WHERE c.id IN (${sql.join(candidates.map(row => sql`${row.id}`), sql`, `)})
          RETURNING contact_id`);
        return { attached: attached.length, wouldAttach: candidates.length, dryRun: false };
      },
    },
    {
      key: 'verify_queue',
      effectClass: 'external_non_idempotent',
      maxAttempts: 2,
      async run(context) {
        const { run, state } = context;
        const stopped = stopReason(state);
        if (stopped) return { skipped: true, reason: stopped };
        const target = state.capacity.batchSize * state.preflight.queueBufferDays;
        const args = [
          state.preflight.campaignSlug,
          '--target-valid', String(target),
          '--max', String(state.preflight.maxVerify),
        ];
        if (state.preflight.dryRun) args.push('--dry-run');
        return runVerifiedCommand(context, {
          provider: 'zerobounce',
          operation: 'queue_verification',
          request: { target, maxChecks: state.preflight.maxVerify, dryRun: state.preflight.dryRun },
          command: nodeCommand('prospector/scripts/preverify-queue.js', args, {
            timeoutMs: 20 * 60_000,
            env: { WORKFLOW_RUN_ID: run.id },
          }),
          readback: async result => {
            const parsed = lastJsonValue(result.stdout);
            if (parsed?.provider_unavailable) {
              const error = new Error('email verifier was unavailable; preparation failed closed');
              error.code = 'verifier_unavailable';
              throw error;
            }
            return parsed;
          },
        });
      },
    },
    {
      key: 'compose',
      effectClass: 'external_non_idempotent',
      maxAttempts: 2,
      async run(context) {
        const { db, run, state } = context;
        const stopped = stopReason(state);
        if (stopped) return { skipped: true, reason: stopped };
        const args = [state.preflight.campaignSlug, String(state.capacity.batchSize)];
        if (state.preflight.dryRun) args.push('--dry-run');
        return runVerifiedCommand(context, {
          provider: 'anthropic+crm',
          operation: 'compose_drafts',
          request: { batchSize: state.capacity.batchSize, dryRun: state.preflight.dryRun },
          command: nodeCommand('prospector/composer.js', ['compose-batch', ...args], {
            timeoutMs: 30 * 60_000,
            env: { WORKFLOW_RUN_ID: run.id },
          }),
          readback: async result => {
            const parsed = lastJsonValue(result.stdout);
            if (!parsed?.ok) return parsed;
            if (!state.preflight.dryRun) {
              const [row] = await db.query(sql`SELECT COUNT(*) AS count FROM outreach_sends
                WHERE workflow_run_id=${run.id}`);
              const attributed = Number(row?.count || 0);
              const expected = Number(parsed.already_composed || 0) + parsed.composed.length;
              if (attributed !== expected) {
                throw new Error(`workflow-attributed drafts ${attributed} did not match command output ${expected}`);
              }
              parsed.attributed_drafts = attributed;
            }
            return parsed;
          },
        });
      },
    },
    {
      key: 'notify_humans',
      effectClass: 'internal_notification',
      maxAttempts: 2,
      async run({ db, run, state, store }) {
        if (state.preflight.skipped || state.preflight.dryRun) {
          return { queued: 0, reason: state.preflight.reason || 'dry_run' };
        }
        const targets = notificationTargets(run, definition);
        if (!targets.channels.length) return { queued: 0, reason: 'no notification channel configured' };
        const analysis = state.analyze_engagement?.summary;
        const research = state.research?.summary;
        const verified = state.verify_queue?.summary;
        const composed = state.compose?.summary;
        const hypothesis = analysis?.hypothesis;
        const message = state.capacity.batchSize === 0
          ? `Paulina preparation verified: research imported ${Number(research?.inserted || 0)}, attached ${Number(state.attach_contacts?.attached || 0)}, and no new drafts were needed because today's capacity was already committed. Workflow ${run.id}.`
          : `Paulina preparation verified: research imported ${Number(research?.inserted || 0)}, attached ${Number(state.attach_contacts?.attached || 0)}, verifier checked ${Number(verified?.checked || 0)} with ${Number(verified?.verified_available_after ?? verified?.verified_available_before ?? 0)} ready, and composed ${Number(composed?.composed?.length || 0)} new drafts (${Number(composed?.failed?.length || 0)} failures). The canonical ${Number(analysis?.recent?.window_days || 14)}-day report records ${Number(analysis?.recent?.production_sent || 0)} production sends and ${Number(analysis?.recent?.external_replies || 0)} external replies.${hypothesis ? ` Hypothesis: ${hypothesis.hypothesis} Test: ${hypothesis.test} Win condition: ${hypothesis.success_metric}` : ''} Workflow ${run.id}.`;
        for (const channelId of targets.channels) {
          await store.enqueueOutbox(db, {
            runId: run.id,
            topic: 'slack.notification',
            idempotencyKey: `${run.id}:paulina-prepare-summary:${channelId}`,
            payload: { channelId, message },
          });
        }
        return { queued: targets.channels.length, channels: targets.channels };
      },
    },
  ],
  output({ state }) {
    return {
      status: state.preflight.skipped ? 'skipped' : 'verified_by_readback',
      reason: state.preflight.reason || null,
      campaignSlug: state.preflight.campaignSlug,
      localDate: state.preflight.localDate,
      batchSize: state.capacity?.batchSize || 0,
      research: state.research?.summary || null,
      attached: state.attach_contacts?.attached || 0,
      verification: state.verify_queue?.summary || null,
      composition: state.compose?.summary || null,
      notification: state.notify_humans,
    };
  },
};

module.exports = { definition, localDay, runVerifiedCommand, validate };
