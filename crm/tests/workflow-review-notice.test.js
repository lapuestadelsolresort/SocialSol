'use strict';

//
// Tests for two durable-boundary gaps found in QC fix sessions.
//
// F-052 — a channel-less run (a scheduled graph) that opens an ambiguous
// manual review posted no Slack notice when the policy resolved no
// write_notifications channel, and left no trace of the missing notice. The
// review sat unseen until someone went looking. The notice fallback itself
// works; what was missing was any record when it could not resolve.
//
// F-056 — social.publish_due started its child social.content.publish graphs
// without a policy snapshot. Under worker policy enforcement, a child with a
// null creation snapshot has every external step denied
// (external_effect_not_authorized_at_creation), so the first genuinely due
// piece of content would silently fail to publish.
//

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');

const { startGraph } = require('../lib/workflow-engine');
const { policySnapshot } = require('../lib/workflow-execution-policy');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { definition: publishDueDefinition } = require('../workflows/social-publish-due');

const CHANNEL = 'CREVIEW1';

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-review-test-'));
  const db = createDB(path.join(directory, 'crm.db'));
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function policyWith({ notificationChannels = [], live = [] } = {}) {
  return {
    version: 1,
    channels: { [CHANNEL]: { name: 'business-intel', capabilities: ['*'] } },
    live_workflows: live,
    autonomous_workflows: [],
    write_notifications: { channel_ids: notificationChannels, user_ids: [] },
  };
}

// A scheduled-shaped graph: no channel, one step that comes back ambiguous.
const ambiguousDefinition = {
  name: 'test.ambiguous',
  version: 1,
  capability: 'social.publish',
  mutates: true,
  autonomous: true,
  validate() {},
  steps: [
    {
      key: 'call_provider', effectClass: 'external_idempotent', maxAttempts: 1,
      async run() {
        const error = new Error('provider timed out after the request was sent');
        error.code = 'ambiguous_external_result';
        throw error;
      },
    },
  ],
};

async function runAmbiguous(db, policy) {
  const services = { enforcePolicy: true, policyProvider: () => policy };
  await startGraph(db, ambiguousDefinition, {
    idempotencyKey: `test:ambiguous:${policy.write_notifications.channel_ids.join('-') || 'none'}`,
    triggerType: 'schedule',
    channelId: null, // the scheduled-graph shape that made F-052 invisible
    input: {},
    policySnapshot: policySnapshot(policy, ambiguousDefinition),
  }, services).catch(() => {});
  const [review] = await db.query(sql`SELECT id, review_channel_id FROM workflow_manual_reviews`);
  const outbox = await db.query(sql`SELECT payload_json FROM workflow_outbox`);
  const events = await db.query(sql`SELECT event_type, payload_json FROM workflow_events WHERE event_type='manual_review_unnotified'`);
  return { review, outbox, events };
}

test('a channel-less run notifies the configured write_notifications channel', async () => {
  await withDb(async db => {
    const { review, outbox, events } = await runAmbiguous(db, policyWith({ notificationChannels: [CHANNEL], live: ['test.ambiguous'] }));
    assert.ok(review, 'a manual review was opened');
    assert.equal(review.review_channel_id, CHANNEL);
    assert.equal(outbox.length, 1, 'the review notice was queued');
    assert.match(outbox[0].payload_json, new RegExp(CHANNEL));
    assert.equal(events.length, 0, 'nothing was recorded as unnotified');
  });
});

test('when no channel resolves, the unsent notice is recorded instead of dropped', async () => {
  await withDb(async db => {
    const { review, outbox, events } = await runAmbiguous(db, policyWith({ notificationChannels: [], live: ['test.ambiguous'] }));
    assert.ok(review, 'the review is still opened — the run does not proceed silently');
    assert.equal(review.review_channel_id, null);
    assert.equal(outbox.length, 0, 'there is no channel to post to');
    assert.equal(events.length, 1, 'the missing notice is durable and attributable');
    const payload = JSON.parse(events[0].payload_json);
    assert.equal(payload.reason, 'no_review_channel_resolved');
    assert.equal(payload.reviewId, review.id);
  });
});

test('a write_notifications channel absent from policy.channels does not resolve', async () => {
  await withDb(async db => {
    const policy = policyWith({ notificationChannels: ['CNOTINPOLICY'], live: ['test.ambiguous'] });
    const { outbox, events } = await runAmbiguous(db, policy);
    assert.equal(outbox.length, 0);
    assert.equal(events.length, 1, 'an unbound channel id is not a usable destination');
  });
});

test('social.publish_due gives each child run a creation policy snapshot', async () => {
  await withDb(async db => {
    await db.query(sql`INSERT INTO social_content (id, platform, caption, status, scheduled_for, version)
      VALUES ('11111111-2222-4333-8444-555555555555', 'instagram', 'test post', 'approved', datetime('now'), 1)`);

    const policy = policyWith({ notificationChannels: [CHANNEL], live: ['social.publish_due'] });
    await startGraph(db, publishDueDefinition, {
      idempotencyKey: 'test:publish-due:1',
      triggerType: 'schedule',
      channelId: null,
      input: {},
      policySnapshot: policySnapshot(policy, publishDueDefinition),
    }, { enforcePolicy: true, policyProvider: () => policy }).catch(() => {});

    const [child] = await db.query(sql`SELECT workflow_name, policy_snapshot_hash, policy_snapshot_json
      FROM workflow_runs WHERE workflow_name='social.content.publish'`);
    assert.ok(child, 'the child publish run was created');
    assert.notEqual(child.policy_snapshot_hash, null, 'without a snapshot every external step is denied at creation');
    const snapshot = JSON.parse(child.policy_snapshot_json);
    assert.equal(typeof snapshot.workflowLive, 'boolean');
    assert.ok('allowedAtCreation' in snapshot || 'effects' in snapshot || Object.keys(snapshot).length > 0);
  });
});
