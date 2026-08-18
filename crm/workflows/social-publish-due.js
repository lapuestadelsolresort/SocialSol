'use strict';

const { sql } = require('@databases/sqlite');
const { startGraph } = require('../lib/workflow-engine');
const { loadPolicy } = require('../lib/channel-policy');
const { policySnapshot } = require('../lib/workflow-execution-policy');
const { definition: publishDefinition } = require('./social-publish');

const definition = {
  name: 'social.publish_due',
  version: 2,
  capability: 'social.publish',
  mutates: true,
  autonomous: true,
  validate() {},
  steps: [
    {
      key: 'load_due', effectClass: 'read', maxAttempts: 1,
      async run({ db }) {
        const rows = await db.query(sql`SELECT id, version, scheduled_for FROM social_content
          WHERE status='approved' AND scheduled_for IS NOT NULL
            AND julianday(scheduled_for) <= julianday('now','+30 minutes')
          ORDER BY scheduled_for, id LIMIT 10`);
        return { content: rows };
      },
    },
    {
      key: 'publish_each', effectClass: 'external_idempotent', maxAttempts: 3,
      async run({ db, run, state, services }) {
        const results = [];
        // Each child run needs its own creation-time policy snapshot: the
        // worker's stepExecutionDecision reads `allowedAtCreation` from it, so
        // a child started without one has every external step denied as
        // external_effect_not_authorized_at_creation (F-056). Prefer the
        // caller's policy provider — same idiom as auto-confirm dispatch — so
        // the child sees exactly the policy this run is executing under.
        const policy = typeof services?.policyProvider === 'function'
          ? services.policyProvider()
          : loadPolicy({ fresh: true });
        const childSnapshot = policySnapshot(policy, publishDefinition);
        for (const content of state.load_due.content) {
          const publishNow = new Date(content.scheduled_for).getTime() <= Date.now() + 2 * 60_000;
          const child = await startGraph(db, publishDefinition, {
            idempotencyKey: `social:content:${content.id}:version:${content.version}:publish`,
            triggerType: 'workflow',
            triggerRef: run.id,
            channelId: run.channel_id,
            actorUserId: run.actor_user_id,
            input: publishNow
              ? { contentId: content.id, publishNow: true }
              : { contentId: content.id, scheduledFor: content.scheduled_for },
            policySnapshot: childSnapshot,
          }, services);
          if (child.status !== 'completed') {
            const error = new Error(`social publish child ${child.id} is ${child.status}`);
            error.retryable = child.status === 'retry' || child.status === 'running';
            throw error;
          }
          results.push({ contentId: content.id, runId: child.id, effectId: child.output.effectId, evidenceId: child.output.evidenceId, publishNow });
        }
        return { results };
      },
    },
    {
      key: 'verify_batch', effectClass: 'local_write', maxAttempts: 1,
      async run({ db, run, state, store, stepKey }) {
        const ids = state.publish_each.results.map(result => result.contentId);
        const rows = [];
        for (const id of ids) {
          const [row] = await db.query(sql`SELECT id, status, postiz_post_id, scheduled_for
            FROM social_content WHERE id=${id}`);
          if (row) rows.push(row);
        }
        rows.sort((left, right) => String(left.id).localeCompare(String(right.id)));
        if (rows.some(row => !['scheduled', 'publishing'].includes(row.status) || !row.postiz_post_id)) {
          throw new Error('one or more social posts failed local provider-readback reconciliation');
        }
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'sqlite.social_content+postiz.readback',
          payload: { rows, childRuns: state.publish_each.results },
        });
        return { scheduled: rows.length, evidenceId: evidence.id, childRuns: state.publish_each.results };
      },
    },
  ],
  output({ state }) { return { ...state.verify_batch, status: 'verified_by_readback' }; },
};

module.exports = { definition };
