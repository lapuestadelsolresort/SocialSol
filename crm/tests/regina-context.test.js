'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestDb, seedContactAndDossier, sql } = require('./fixtures/regina-test-db');
const {
  buildContext,
  resolveSendMethod,
  SKIP_REASONS,
} = require('../../regina/lib/dossier-context');

const CAMPAIGN = {
  campaign_kind: 'ad_hoc',
  intent: 'ad_hoc',
  recipient_relationship: 'past_guest_inquired',
  prompt_context: 'reach back out warmly',
};

test('resolveSendMethod: airbnb_thread_only forces manual_airbnb_thread (provenance hard rule)', () => {
  assert.equal(
    resolveSendMethod({ contact_provenance: 'airbnb_thread_only', preferred_channel: 'email' }),
    'manual_airbnb_thread'
  );
  assert.equal(
    resolveSendMethod({ contact_provenance: 'airbnb_thread_only', preferred_channel: 'whatsapp' }),
    'manual_airbnb_thread'
  );
});

test('resolveSendMethod: voluntary_share routes per preferred_channel', () => {
  assert.equal(resolveSendMethod({ contact_provenance: 'voluntary_share_message', preferred_channel: 'email' }), 'manual_email');
  assert.equal(resolveSendMethod({ contact_provenance: 'voluntary_share_message', preferred_channel: 'whatsapp' }), 'manual_whatsapp');
  assert.equal(resolveSendMethod({ contact_provenance: 'voluntary_share_message', preferred_channel: 'airbnb_thread' }), 'manual_airbnb_thread');
});

test('buildContext: happy path returns ok=true with message_context', async () => {
  const db = await buildTestDb();
  const { contact } = await seedContactAndDossier(db);
  const ctx = await buildContext(db, contact.id, CAMPAIGN);
  assert.equal(ctx.ok, true);
  assert.equal(ctx.contact.id, contact.id);
  assert.ok(ctx.message_context.length > 0);
  assert.match(ctx.message_context, /Patricia Test/);
  assert.match(ctx.message_context, /actively_deciding/);
  assert.match(ctx.message_context, /Why didn't book: price/);
  assert.equal(ctx.send_method, 'manual_email');
  await db.dispose();
});

test('buildContext: do_not_contact=1 → ok=false with skip reason', async () => {
  const db = await buildTestDb();
  const { contact } = await seedContactAndDossier(db, {
    contact: { id: 200, do_not_contact: 1 },
  });
  const ctx = await buildContext(db, contact.id, CAMPAIGN);
  assert.equal(ctx.ok, false);
  assert.equal(ctx.skip_reason, SKIP_REASONS.DO_NOT_CONTACT);
  await db.dispose();
});

test('buildContext: dossier language=es → skipped', async () => {
  const db = await buildTestDb();
  const { contact } = await seedContactAndDossier(db, {
    contact: { id: 300, airbnb_thread_id: '999000222' },
    dossier: { airbnb_thread_id: '999000222', contact_ids: '[300]', language: 'es' },
  });
  const ctx = await buildContext(db, contact.id, CAMPAIGN);
  assert.equal(ctx.ok, false);
  assert.equal(ctx.skip_reason, SKIP_REASONS.DOSSIER_LANGUAGE_ES);
  await db.dispose();
});

test('buildContext: dossier extraction_status=deferred_spanish → skipped', async () => {
  const db = await buildTestDb();
  const { contact } = await seedContactAndDossier(db, {
    contact: { id: 400, airbnb_thread_id: '999000333' },
    dossier: { airbnb_thread_id: '999000333', contact_ids: '[400]', extraction_status: 'deferred_spanish' },
  });
  const ctx = await buildContext(db, contact.id, CAMPAIGN);
  assert.equal(ctx.ok, false);
  assert.equal(ctx.skip_reason, SKIP_REASONS.DOSSIER_DEFERRED_SPANISH);
  await db.dispose();
});

test('buildContext: dossier extraction_status=extraction_failed → skipped', async () => {
  const db = await buildTestDb();
  const { contact } = await seedContactAndDossier(db, {
    contact: { id: 500, airbnb_thread_id: '999000444' },
    dossier: { airbnb_thread_id: '999000444', contact_ids: '[500]', extraction_status: 'extraction_failed' },
  });
  const ctx = await buildContext(db, contact.id, CAMPAIGN);
  assert.equal(ctx.ok, false);
  assert.equal(ctx.skip_reason, SKIP_REASONS.DOSSIER_NOT_EXTRACTED);
  await db.dispose();
});

test('buildContext: airbnb_thread_only contact → manual_airbnb_thread regardless of preferred_channel', async () => {
  const db = await buildTestDb();
  const { contact } = await seedContactAndDossier(db, {
    contact: { id: 600, airbnb_thread_id: '999000555', contact_provenance: 'airbnb_thread_only', preferred_channel: 'email' },
    dossier: { airbnb_thread_id: '999000555', contact_ids: '[600]' },
  });
  const ctx = await buildContext(db, contact.id, CAMPAIGN);
  assert.equal(ctx.ok, true);
  assert.equal(ctx.send_method, 'manual_airbnb_thread');
  await db.dispose();
});

test('buildContext: dossier missing → skipped', async () => {
  const db = await buildTestDb();
  await db.query(sql`
    INSERT INTO contacts (id, name, email, do_not_contact, relationship_type)
    VALUES (${700}, ${'Lone Contact'}, ${'lone@example.com'}, ${0}, ${'past_guest_inquired'})
  `);
  const ctx = await buildContext(db, 700, CAMPAIGN);
  assert.equal(ctx.ok, false);
  assert.equal(ctx.skip_reason, SKIP_REASONS.DOSSIER_MISSING);
  await db.dispose();
});

test('buildContext: group dossier (multi-contact_ids JSON) resolves correctly', async () => {
  const db = await buildTestDb();
  // Seed two contacts on the same Airbnb thread
  await db.query(sql`
    INSERT INTO contacts (id, name, email, do_not_contact, relationship_type, airbnb_thread_id)
    VALUES (${801}, ${'Co-host A'}, ${'a@x.com'}, ${0}, ${'past_guest_stayed'}, ${'999G1'})
  `);
  await db.query(sql`
    INSERT INTO contacts (id, name, email, do_not_contact, relationship_type, airbnb_thread_id)
    VALUES (${802}, ${'Co-host B'}, ${'b@x.com'}, ${0}, ${'past_guest_stayed'}, ${'999G1'})
  `);
  await db.query(sql`
    INSERT INTO guest_dossiers (airbnb_thread_id, contact_ids, language, extraction_status, extraction_model, notes_for_sarah)
    VALUES (${'999G1'}, ${'[801, 802]'}, ${'en'}, ${'extracted'}, ${'claude'}, ${'group note'})
  `);
  const ctx1 = await buildContext(db, 801, CAMPAIGN);
  const ctx2 = await buildContext(db, 802, CAMPAIGN);
  assert.equal(ctx1.ok, true);
  assert.equal(ctx2.ok, true);
  assert.equal(ctx1.dossier.airbnb_thread_id, '999G1');
  assert.equal(ctx2.dossier.airbnb_thread_id, '999G1');
  await db.dispose();
});
