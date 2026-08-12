'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { startGraph } = require('../lib/workflow-engine');
const store = require('../lib/workflow-store');
const { getDefinition, listDefinitions } = require('../workflows/registry');
const { CONFIRMED_OPERATIONS } = require('../workflows/marketing');

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-workflows-'));
  const db = createDB(path.join(directory, 'crm.db'));
  const previousPolicy = process.env.RESORT_WORKFLOW_POLICY_PATH;
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1,
    shadow_mode: false,
    live_workflows: [],
    autonomous_workflows: [],
    always_on_effects: [],
    channels: {
      'C-SOCIAL': {
        name: 'social-sol',
        capabilities: ['marketing.read', 'marketing.write'],
      },
    },
    restricted_capabilities: { 'marketing.write': { users: ['U-JASON'] } },
    write_notifications: { user_ids: ['U-JASON'], channel_ids: [] },
  }));
  process.env.RESORT_WORKFLOW_POLICY_PATH = policyPath;
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
    await db.query(sql`CREATE TABLE meta_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
      platform TEXT NOT NULL, sender_id TEXT NOT NULL, message_id TEXT UNIQUE
    )`);
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    if (previousPolicy === undefined) delete process.env.RESORT_WORKFLOW_POLICY_PATH;
    else process.env.RESORT_WORKFLOW_POLICY_PATH = previousPolicy;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function phase(command) {
  return command.args[1];
}

function jsonResult(value) {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
}

function request(idempotencyKey, input, actorUserId = 'U-JASON') {
  return {
    idempotencyKey,
    triggerType: 'model_tool',
    triggerRef: idempotencyKey,
    channelId: 'C-SOCIAL',
    actorUserId,
    input,
  };
}

test('registry exposes the fixed paid-media workflows and no arbitrary Meta method', () => {
  const names = new Set(listDefinitions().map(row => row.name));
  for (const expected of [
    'marketing.snapshot.read', 'marketing.report.daily', 'marketing.change.propose',
    'marketing.change.confirm', 'meta.campaign.autonomous', 'meta.audience.sync',
  ]) assert.equal(names.has(expected), true, expected);
  assert.equal(names.has('meta.graph.request'), false);
  assert.equal(CONFIRMED_OPERATIONS.has('campaign_pause'), true);
});

test('marketing snapshot stores the exact source payload as expiring evidence', async () => {
  await withDb(async db => {
    const snapshot = {
      generated_at: new Date().toISOString(),
      window: { start: '2026-08-09', end: '2026-08-11' },
      campaigns: [],
      authorized_actions: [],
      tracking_health: { healthy: true },
      totals: { spend: 0, sessions: 0, wa_taps: 0, verified_wa_leads: 0 },
    };
    const run = await startGraph(db, getDefinition('marketing.snapshot.read'), request(
      'marketing-snapshot-1', { start: '2026-08-09', end: '2026-08-11' },
    ), { runCommand: async () => jsonResult(snapshot) });
    assert.equal(run.status, 'completed');
    assert.equal(run.output.tracking_health.healthy, true);
    assert.ok(run.output._evidence.id);
    const [evidence] = await db.query(sql`SELECT * FROM workflow_evidence WHERE id=${run.output._evidence.id}`);
    assert.equal(evidence.source, 'marketing.live_snapshot');
    assert.ok(new Date(evidence.expires_at).getTime() > Date.now());
    assert.deepEqual(JSON.parse(evidence.payload_json), snapshot);
  });
});

test('activation proposal is immutable, same-user confirmed, executed once, and read back', async () => {
  await withDb(async db => {
    const preflight = {
      operation: 'campaign_activate', provider: 'meta', targetRef: 'cmp-1',
      campaignId: 'cmp-1', briefId: 'brief-one', briefHash: 'brief-hash',
      before: { campaign: { id: 'cmp-1', status: 'PAUSED' } },
      target: { status: 'ACTIVE' }, preflightHash: 'preflight-hash',
    };
    let executes = 0;
    const services = {
      runCommand: async command => {
        if (phase(command) === 'preflight') return jsonResult(preflight);
        if (phase(command) === 'execute') {
          executes += 1;
          return jsonResult({ accepted: true, providerRef: 'cmp-1' });
        }
        if (phase(command) === 'readback') {
          return jsonResult({ verified: true, providerRef: 'cmp-1', readback: { status: 'ACTIVE' } });
        }
        throw new Error(`unexpected phase ${phase(command)}`);
      },
    };
    const proposal = await startGraph(db, getDefinition('marketing.change.propose'), request(
      'marketing-proposal-1', {
        operation: 'campaign_activate', briefId: 'brief-one', reason: 'Activate the reviewed replacement campaign',
      },
    ), services);
    assert.equal(proposal.status, 'completed');
    assert.match(proposal.output.confirmationCommand, /^!meta confirm [0-9a-f-]{36} [0-9a-f]{12}$/);
    const parts = proposal.output.confirmationCommand.split(' ');
    const confirmed = await startGraph(db, getDefinition('marketing.change.confirm'), {
      ...request('marketing-confirm-1', { proposalId: parts[2], acceptanceHash: parts[3] }),
      triggerType: 'slack_meta_campaign_confirm_command',
    }, services);
    assert.equal(confirmed.status, 'completed', confirmed.error_message);
    assert.equal(confirmed.output.status, 'verified_by_readback');
    assert.equal(executes, 1);
    assert.equal(confirmed.effects[0].status, 'verified_by_readback');
    const [row] = await db.query(sql`SELECT * FROM marketing_change_requests WHERE id=${parts[2]}`);
    assert.equal(row.status, 'completed');
    assert.equal(row.confirmed_by, 'U-JASON');
    assert.ok(row.readback_evidence_id);

    const replay = await startGraph(db, getDefinition('marketing.change.confirm'), {
      ...request('marketing-confirm-1', { proposalId: parts[2], acceptanceHash: parts[3] }),
      triggerType: 'slack_meta_campaign_confirm_command',
    }, services);
    assert.equal(replay.id, confirmed.id);
    assert.equal(executes, 1);
  });
});

test('confirmation cannot be supplied by a different Slack user', async () => {
  await withDb(async db => {
    const preflight = {
      operation: 'landing_reweight', provider: 'crm', targetRef: 'variant-a',
      before: { slug: 'variant-a', traffic_weight: 50 }, target: { traffic_weight: 30 },
      preflightHash: 'landing-hash',
    };
    const services = { runCommand: async () => jsonResult(preflight) };
    const proposal = await startGraph(db, getDefinition('marketing.change.propose'), request(
      'landing-proposal-1', {
        operation: 'landing_reweight', slug: 'variant-a', trafficWeight: 30,
        reason: 'Move traffic away from the losing variant',
      },
    ), services);
    const parts = proposal.output.confirmationCommand.split(' ');
    const confirmation = await startGraph(db, getDefinition('marketing.change.confirm'), {
      ...request('landing-confirm-wrong-user', {
        proposalId: parts[2], acceptanceHash: parts[3],
      }, 'U-SARAH'),
      triggerType: 'slack_meta_campaign_confirm_command',
    }, services);
    assert.equal(confirmation.status, 'failed');
    assert.equal(confirmation.error_code, 'marketing_confirmer_mismatch');
  });
});

test('autonomous budget decrease requires exact fresh evidence and is limited to one per campaign per day', async () => {
  await withDb(async db => {
    const source = await store.createEvidence(db, {
      source: 'marketing.live_snapshot',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload: {
        tracking_health: { healthy: true },
        autonomy: { ready: true, window_days: 3, minimum_window_days: 3 },
        authorized_actions: [{
          action: 'budget_decrease', campaignId: 'cmp-2', briefId: 'brief-two',
          currentDailyBudgetUsd: 10, targetDailyBudgetUsd: 8,
          reason: 'guardrail threshold met',
        }],
      },
    });
    const preflight = {
      operation: 'campaign_budget', provider: 'meta', targetRef: 'cmp-2',
      campaignId: 'cmp-2', briefId: 'brief-two', briefHash: 'brief-two-hash',
      before: { daily_budget_usd: 10 }, target: { dailyBudgetUsd: 8 },
      preflightHash: 'budget-hash',
    };
    let executes = 0;
    const services = {
      runCommand: async command => {
        if (phase(command) === 'preflight') return jsonResult(preflight);
        if (phase(command) === 'execute') {
          executes += 1;
          return jsonResult({ accepted: true, providerRef: 'cmp-2' });
        }
        return jsonResult({ verified: true, providerRef: 'cmp-2', readback: { daily_budget_usd: 8 } });
      },
    };
    const input = {
      operation: 'campaign_budget', briefId: 'brief-two', dailyBudgetUsd: 8,
      reason: 'Apply the exact snapshot-authorized reduction', evidenceId: source.id,
    };
    const first = await startGraph(db, getDefinition('meta.campaign.autonomous'), request(
      'autonomous-budget-1', input,
    ), services);
    assert.equal(first.status, 'completed', first.error_message);
    assert.equal(first.output.authorityTier, 'autonomous');
    assert.equal(executes, 1);

    const second = await startGraph(db, getDefinition('meta.campaign.autonomous'), request(
      'autonomous-budget-2', input,
    ), services);
    assert.equal(second.status, 'failed');
    assert.match(second.error_message, /last 24 hours/);
    assert.equal(executes, 1);
  });
});

test('autonomous budget mutation rejects short evidence windows and live budget drift', async () => {
  await withDb(async db => {
    const action = {
      action: 'budget_decrease', campaignId: 'cmp-drift', briefId: 'brief-drift',
      currentDailyBudgetUsd: 10, targetDailyBudgetUsd: 8,
      reason: 'guardrail threshold met',
    };
    const short = await store.createEvidence(db, {
      source: 'marketing.live_snapshot',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload: {
        tracking_health: { healthy: true },
        autonomy: { ready: false, window_days: 1, minimum_window_days: 3 },
        authorized_actions: [action],
      },
    });
    const input = {
      operation: 'campaign_budget', briefId: 'brief-drift', dailyBudgetUsd: 8,
      reason: 'Apply the exact snapshot-authorized reduction', evidenceId: short.id,
    };
    let commands = 0;
    const shortRun = await startGraph(db, getDefinition('meta.campaign.autonomous'), request(
      'autonomous-short-window', input,
    ), { runCommand: async () => { commands += 1; throw new Error('must not preflight'); } });
    assert.equal(shortRun.status, 'failed');
    assert.match(shortRun.error_message, /three completed days/);
    assert.equal(commands, 0);

    const fresh = await store.createEvidence(db, {
      source: 'marketing.live_snapshot',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload: {
        tracking_health: { healthy: true },
        autonomy: { ready: true, window_days: 3, minimum_window_days: 3 },
        authorized_actions: [action],
      },
    });
    const driftRun = await startGraph(db, getDefinition('meta.campaign.autonomous'), request(
      'autonomous-budget-drift', { ...input, evidenceId: fresh.id },
    ), {
      runCommand: async command => {
        commands += 1;
        assert.equal(phase(command), 'preflight');
        return jsonResult({
          operation: 'campaign_budget', provider: 'meta', targetRef: 'cmp-drift',
          campaignId: 'cmp-drift', briefId: 'brief-drift', briefHash: 'brief-hash',
          before: { daily_budget_usd: 12 }, target: { dailyBudgetUsd: 8 },
          preflightHash: 'drift-hash',
        });
      },
    });
    assert.equal(driftRun.status, 'failed');
    assert.match(driftRun.error_message, /budget changed after the snapshot/);
    assert.equal(commands, 1);
  });
});

test('ambiguous Meta execution opens manual review and never replays the provider boundary', async () => {
  await withDb(async db => {
    const preflight = {
      operation: 'campaign_activate', provider: 'meta', targetRef: 'cmp-3',
      campaignId: 'cmp-3', briefId: 'brief-three', briefHash: 'brief-hash',
      before: { campaign: { id: 'cmp-3', status: 'PAUSED' } },
      target: { status: 'ACTIVE' }, preflightHash: 'activation-hash',
    };
    let executeCalls = 0;
    const proposeServices = { runCommand: async () => jsonResult(preflight) };
    const proposal = await startGraph(db, getDefinition('marketing.change.propose'), request(
      'ambiguous-proposal', {
        operation: 'campaign_activate', briefId: 'brief-three', reason: 'Activate after final campaign review',
      },
    ), proposeServices);
    const parts = proposal.output.confirmationCommand.split(' ');
    const services = {
      runCommand: async command => {
        if (phase(command) === 'preflight') return jsonResult(preflight);
        if (phase(command) === 'execute') {
          executeCalls += 1;
          throw new Error('socket closed after request dispatch');
        }
        throw new Error('readback must not run after ambiguous dispatch');
      },
    };
    const run = await startGraph(db, getDefinition('marketing.change.confirm'), {
      ...request('ambiguous-confirm', { proposalId: parts[2], acceptanceHash: parts[3] }),
      triggerType: 'slack_meta_campaign_confirm_command',
    }, services);
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'ambiguous_external_result');
    assert.equal(run.manualReviews.length, 1);
    assert.equal(run.effects[0].status, 'manual_review');
    assert.equal(executeCalls, 1);
  });
});
