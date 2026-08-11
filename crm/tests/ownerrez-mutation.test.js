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

async function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ownerrez-mutation-'));
  const db = createDB(path.join(directory, 'crm.db'));
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
