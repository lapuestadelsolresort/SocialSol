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
const { ENTRIES, validateMutationInput } = require('../lib/ownerrez-mutation-catalog');
const { requestOwnerRez } = require('../lib/ownerrez-api');
const { confirmDefinition, proposeDefinition } = require('../workflows/ownerrez-mutation');

async function withDb(run, { autonomousWorkflows = [] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ownerrez-mutation-'));
  const db = createDB(path.join(directory, 'crm.db'));
  const priorPolicyPath = process.env.RESORT_WORKFLOW_POLICY_PATH;
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    version: 1,
    shadow_mode: false,
    live_workflows: ['ownerrez.mutation.confirm'],
    autonomous_workflows: autonomousWorkflows,
    always_on_effects: [],
    channels: {
      'TEST-RESERVATIONS': { name: 'reservations', capabilities: ['ownerrez.write'] },
    },
    restricted_capabilities: {
      'ownerrez.write': { users: ['TEST-JASON', 'TEST-SARAH'] },
    },
    write_notifications: { user_ids: ['TEST-JASON', 'TEST-SARAH'], channel_ids: [] },
  }));
  process.env.RESORT_WORKFLOW_POLICY_PATH = policyPath;
  try {
    await db.query(sql`PRAGMA foreign_keys=ON`);
    await db.query(sql`CREATE TABLE meta_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
      platform TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT,
      message_id TEXT UNIQUE, message_text TEXT, raw_payload TEXT
    )`);
    await ensureSchemaAsync(db, sql);
    return await run(db);
  } finally {
    await db.dispose();
    if (priorPolicyPath === undefined) delete process.env.RESORT_WORKFLOW_POLICY_PATH;
    else process.env.RESORT_WORKFLOW_POLICY_PATH = priorPolicyPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function graphRequest(idempotencyKey, actorUserId, input) {
  return {
    idempotencyKey, triggerType: 'slack', triggerRef: idempotencyKey,
    channelId: 'TEST-RESERVATIONS', actorUserId, input,
  };
}

test('OwnerRez mutation catalog exposes all 34 fixed v2 writes and no arbitrary URL', () => {
  assert.equal(ENTRIES.length, 34);
  assert.throws(() => validateMutationInput({
    operationId: 'Arbitrary_Post', requestPath: 'https://example.test', reason: 'unsafe test',
  }), /unsupported/);
  assert.throws(() => validateMutationInput({
    operationId: 'Guests_Delete', pathParams: { id: 1, injected: 2 }, reason: 'remove duplicate guest',
  }), /unsupported keys/);
});

test('OwnerRez client normalizes an api_base that already ends in /v2', async () => {
  let requestedUrl;
  await requestOwnerRez({
    method: 'GET', requestPath: '/v2/users/me',
    secrets: { token: 'test-token', baseUrl: 'https://api.example.test/v2' },
    fetchImpl: async url => {
      requestedUrl = String(url);
      return { ok: true, status: 200, text: async () => '{}', headers: { get: () => 'etag' } };
    },
  });
  assert.equal(requestedUrl, 'https://api.example.test/v2/users/me');
});

test('OwnerRez patch requires proposal, exact same-user confirmation, provider acceptance, and readback', async () => {
  await withDb(async db => {
    let mutationCalls = 0;
    let current = { id: 41, first_name: 'Before', last_name: 'Guest' };
    const ownerRezRequest = async request => {
      if (request.method === 'GET') return { ok: true, status: 200, data: { ...current }, etag: 'etag-before' };
      assert.equal(request.method, 'PATCH');
      assert.equal(request.requestPath, '/v2/guests/41');
      mutationCalls += 1;
      current = { ...current, ...request.body };
      return { ok: true, status: 200, data: { ...current }, etag: null };
    };
    const proposal = await startGraph(db, proposeDefinition, graphRequest('proposal-1', 'TEST-JASON', {
      operationId: 'Guests_Patch', pathParams: { id: 41 }, body: { first_name: 'After' },
      reason: 'Correct the guest first name',
    }), { ownerRezRequest });
    assert.equal(proposal.status, 'completed', proposal.error_message);
    assert.equal(proposal.output.status, 'awaiting_explicit_confirmation');
    assert.match(proposal.output.confirmationCommand, /^!ownerrez confirm [0-9a-f-]{36} [0-9a-f]{12}$/);
    assert.equal(mutationCalls, 0, 'proposal must never mutate OwnerRez');

    const wrongActor = await startGraph(db, confirmDefinition, graphRequest('confirm-wrong-user', 'TEST-SARAH', {
      proposalId: proposal.output.proposalId,
      acceptanceHash: proposal.output.confirmationCommand.split(' ').at(-1),
    }), { ownerRezRequest });
    assert.equal(wrongActor.status, 'failed');
    assert.equal(wrongActor.error_code, 'ownerrez_confirmer_mismatch');
    assert.equal(mutationCalls, 0);

    const confirmed = await startGraph(db, confirmDefinition, graphRequest('confirm-right-user', 'TEST-JASON', {
      proposalId: proposal.output.proposalId,
      acceptanceHash: proposal.output.confirmationCommand.split(' ').at(-1),
    }), { ownerRezRequest });
    assert.equal(confirmed.status, 'completed', confirmed.error_message);
    assert.equal(confirmed.output.status, 'verified_by_readback');
    assert.ok(confirmed.output.effectId);
    assert.ok(confirmed.output.evidenceId);
    assert.equal(current.first_name, 'After');
    assert.equal(mutationCalls, 1);
    const [stored] = await db.query(sql`SELECT status, confirmed_by, readback_hash
      FROM ownerrez_mutation_proposals WHERE id=${proposal.output.proposalId}`);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.confirmed_by, 'TEST-JASON');
    assert.ok(stored.readback_hash);
  });
});

test('OwnerRez confirmation rejects a changed ETag before the mutation boundary', async () => {
  await withDb(async db => {
    let etag = 'etag-1';
    let mutationCalls = 0;
    const ownerRezRequest = async request => {
      if (request.method === 'GET') return { ok: true, status: 200, data: { id: 7, notes: 'same' }, etag };
      mutationCalls += 1;
      return { ok: true, status: 200, data: { id: 7, notes: 'new' } };
    };
    const proposal = await startGraph(db, proposeDefinition, graphRequest('proposal-etag', 'TEST-JASON', {
      operationId: 'Bookings_Patch', pathParams: { id: 7 }, body: { notes: 'new' }, reason: 'Update reservation notes',
    }), { ownerRezRequest });
    etag = 'etag-2';
    const confirmed = await startGraph(db, confirmDefinition, graphRequest('confirm-etag', 'TEST-JASON', {
      proposalId: proposal.output.proposalId,
      acceptanceHash: proposal.output.confirmationCommand.split(' ').at(-1),
    }), { ownerRezRequest });
    assert.equal(confirmed.status, 'failed');
    assert.equal(confirmed.error_code, 'ownerrez_precondition_changed');
    assert.equal(mutationCalls, 0);
  });
});

test('policy-armed OwnerRez proposals execute immediately with every confirm gate intact', async () => {
  await withDb(async db => {
    let mutationCalls = 0;
    let reads = 0;
    let current = { id: 41, first_name: 'Before', last_name: 'Guest' };
    const ownerRezRequest = async request => {
      if (request.method === 'GET') {
        reads += 1;
        return { ok: true, status: 200, data: { ...current }, etag: 'etag-stable' };
      }
      assert.equal(request.method, 'PATCH');
      mutationCalls += 1;
      current = { ...current, ...request.body };
      return { ok: true, status: 200, data: { ...current }, etag: null };
    };
    const proposal = await startGraph(db, proposeDefinition, graphRequest('proposal-armed', 'TEST-JASON', {
      operationId: 'Guests_Patch', pathParams: { id: 41 }, body: { first_name: 'After' },
      reason: 'Correct the guest first name',
    }), { ownerRezRequest });
    assert.equal(proposal.status, 'completed', proposal.error_message);
    assert.equal(proposal.output.status, 'auto_confirmed_executed');
    assert.equal(proposal.output.confirmationCommand, undefined);
    assert.equal(mutationCalls, 1);
    assert.ok(reads >= 3, 'proposal preflight, confirm precondition, and readback all query the provider');
    assert.ok(proposal.output.autoConfirm.confirmRunId);
    assert.ok(proposal.output.autoConfirm.effectId);
    assert.ok(proposal.output.autoConfirm.evidenceId);

    const [child] = await db.query(sql`SELECT trigger_type, trigger_ref, actor_user_id, status
      FROM workflow_runs WHERE id=${proposal.output.autoConfirm.confirmRunId}`);
    assert.equal(child.trigger_type, 'auto_confirm_dispatch');
    assert.equal(child.trigger_ref, proposal.id);
    assert.equal(child.actor_user_id, 'TEST-JASON');
    assert.equal(child.status, 'completed');

    const [stored] = await db.query(sql`SELECT status, confirmed_by, readback_hash
      FROM ownerrez_mutation_proposals WHERE id=${proposal.output.proposalId}`);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.confirmed_by, 'TEST-JASON');
    assert.ok(stored.readback_hash);
    assert.equal(current.first_name, 'After');
  }, { autonomousWorkflows: ['ownerrez.mutation.confirm'] });
});

test('policy-armed ambiguous OwnerRez results still stop for durable manual review', async () => {
  await withDb(async db => {
    let mutationCalls = 0;
    const ownerRezRequest = async request => {
      if (request.method === 'GET') return { ok: true, status: 200, data: { id: 9, notes: 'old' }, etag: 'stable' };
      mutationCalls += 1;
      throw Object.assign(new Error('socket closed after write'), { code: 'ECONNRESET' });
    };
    const proposal = await startGraph(db, proposeDefinition, graphRequest('proposal-armed-ambiguous', 'TEST-JASON', {
      operationId: 'Bookings_Patch', pathParams: { id: 9 }, body: { notes: 'new' }, reason: 'Update reservation notes',
    }), { ownerRezRequest });
    assert.equal(proposal.status, 'completed', proposal.error_message);
    assert.equal(proposal.output.status, 'auto_confirm_failed');
    assert.equal(proposal.output.autoConfirm.error.code, 'ambiguous_external_result');
    assert.equal(mutationCalls, 1);
    const [stored] = await db.query(sql`SELECT status FROM ownerrez_mutation_proposals
      WHERE id=${proposal.output.proposalId}`);
    assert.equal(stored.status, 'ambiguous');
    const [review] = await db.query(sql`SELECT status, reason_code FROM workflow_manual_reviews
      WHERE run_id=${proposal.output.autoConfirm.confirmRunId}`);
    assert.equal(review.status, 'open');
    assert.equal(review.reason_code, 'ambiguous_external_result');
  }, { autonomousWorkflows: ['ownerrez.mutation.confirm'] });
});

test('ambiguous OwnerRez network results are never automatically retried', async () => {
  await withDb(async db => {
    let mutationCalls = 0;
    const ownerRezRequest = async request => {
      if (request.method === 'GET') return { ok: true, status: 200, data: { id: 9, notes: 'old' }, etag: 'stable' };
      mutationCalls += 1;
      throw Object.assign(new Error('socket closed after write'), { code: 'ECONNRESET' });
    };
    const proposal = await startGraph(db, proposeDefinition, graphRequest('proposal-ambiguous', 'TEST-JASON', {
      operationId: 'Bookings_Patch', pathParams: { id: 9 }, body: { notes: 'new' }, reason: 'Update reservation notes',
    }), { ownerRezRequest });
    const confirmed = await startGraph(db, confirmDefinition, graphRequest('confirm-ambiguous', 'TEST-JASON', {
      proposalId: proposal.output.proposalId,
      acceptanceHash: proposal.output.confirmationCommand.split(' ').at(-1),
    }), { ownerRezRequest });
    assert.equal(confirmed.status, 'failed');
    assert.equal(confirmed.error_code, 'ambiguous_external_result');
    assert.equal(confirmed.steps.find(step => step.step_key === 'execute_once').attempts, 1);
    assert.equal(mutationCalls, 1);
    const [stored] = await db.query(sql`SELECT status FROM ownerrez_mutation_proposals WHERE id=${proposal.output.proposalId}`);
    assert.equal(stored.status, 'ambiguous');
  });
});
