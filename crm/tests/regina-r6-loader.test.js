'use strict';
//
// regina-r6-loader.test.js — campaign-loader.js validation, smoke escape
// hatch, and bindParams strict gates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadCampaign, bindParams } = require('../../regina/lib/campaign-loader');

test('loadCampaign returns config + sqlText for the six R6 campaigns', () => {
  for (const slug of ['anniversary', 'referral_mining', 'winback_cancelled', 'inquiry_conversion', 'vip', 'feedback_closure']) {
    const loaded = loadCampaign(slug);
    assert.equal(loaded.config.slug, slug);
    assert.ok(loaded.config.campaign_kind, `${slug} has campaign_kind`);
    assert.ok(loaded.config.intent, `${slug} has intent`);
    assert.ok(typeof loaded.sqlText === 'string' && loaded.sqlText.length > 0, `${slug} has SQL`);
  }
});

test('loadCampaign accepts smoke.json escape hatch (contact_ids, no SQL)', () => {
  const loaded = loadCampaign('smoke');
  assert.equal(loaded.config.slug, 'smoke');
  assert.equal(loaded.sqlText, null);
  assert.ok(Array.isArray(loaded.config.contact_ids));
});

test('loadCampaign throws on missing strategy file', () => {
  assert.throws(() => loadCampaign('does_not_exist'), /strategy file not found/);
});

test('loadCampaign rejects invalid slug syntax', () => {
  assert.throws(() => loadCampaign('Has-Caps'), /slug must be lowercase/);
  assert.throws(() => loadCampaign('has spaces'), /slug must be lowercase/);
  assert.throws(() => loadCampaign('../escape'), /slug must be lowercase/);
});

// Helper: write a temp campaign file to a side-by-side dir so the loader's
// REGINA_ROOT-relative resolution still works. Easier to write directly into
// the campaigns dir under a guaranteed-unique name.
function withTempCampaign(name, json, sqlText, fn) {
  const campaignsDir = path.resolve(__dirname, '../../regina/library/campaigns');
  const jsonPath = path.join(campaignsDir, `${name}.json`);
  const sqlPath = sqlText != null ? path.join(campaignsDir, `${name}.sql`) : null;
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  if (sqlPath) fs.writeFileSync(sqlPath, sqlText);
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(jsonPath); } catch (_) {}
    if (sqlPath) { try { fs.unlinkSync(sqlPath); } catch (_) {} }
  }
}

test('loadCampaign rejects unknown campaign_kind', () => {
  withTempCampaign('r6_test_bad_kind', {
    slug: 'r6_test_bad_kind',
    name: 'r6_test',
    campaign_kind: 'reactivation_anniverasry', // typo
    intent: 'reactivation_anniversary',
    owning_agent: 'regina',
    recipient_relationship: 'past_guest_stayed',
    language: 'en',
    default_batch_size: 5,
    eligibility_sql_path: 'library/campaigns/r6_test_bad_kind.sql',
    description: 't',
    landing_page_url: 'https://example.com/',
    prompt_context: 'p',
  }, 'SELECT 1', () => {
    assert.throws(() => loadCampaign('r6_test_bad_kind'), /unknown campaign_kind/);
  });
});

test('loadCampaign rejects unknown intent (drift guard against voice-intents.js)', () => {
  withTempCampaign('r6_test_bad_intent', {
    slug: 'r6_test_bad_intent',
    name: 'r6_test',
    campaign_kind: 'reactivation_anniversary',
    intent: 'reactivation_anniversaryyyyyy', // typo
    owning_agent: 'regina',
    recipient_relationship: 'past_guest_stayed',
    language: 'en',
    default_batch_size: 5,
    eligibility_sql_path: 'library/campaigns/r6_test_bad_intent.sql',
    description: 't',
    landing_page_url: 'https://example.com/',
    prompt_context: 'p',
  }, 'SELECT 1', () => {
    assert.throws(() => loadCampaign('r6_test_bad_intent'), /unknown intent/);
  });
});

test('loadCampaign rejects missing required field', () => {
  withTempCampaign('r6_test_missing_field', {
    slug: 'r6_test_missing_field',
    name: 'r6_test',
    campaign_kind: 'reactivation_anniversary',
    // intent missing
    owning_agent: 'regina',
    recipient_relationship: 'past_guest_stayed',
    language: 'en',
    default_batch_size: 5,
    eligibility_sql_path: 'library/campaigns/r6_test_missing_field.sql',
    description: 't',
    landing_page_url: 'https://example.com/',
    prompt_context: 'p',
  }, 'SELECT 1', () => {
    assert.throws(() => loadCampaign('r6_test_missing_field'), /missing required field 'intent'/);
  });
});

test('loadCampaign rejects when both contact_ids and eligibility_sql_path are present', () => {
  withTempCampaign('r6_test_both', {
    slug: 'r6_test_both',
    name: 'r6_test',
    campaign_kind: 'ad_hoc',
    intent: 'ad_hoc',
    owning_agent: 'regina',
    recipient_relationship: 'past_guest_stayed',
    language: 'en',
    default_batch_size: 5,
    eligibility_sql_path: 'library/campaigns/r6_test_both.sql',
    contact_ids: [1, 2],
    description: 't',
    landing_page_url: 'https://example.com/',
    prompt_context: 'p',
  }, 'SELECT 1', () => {
    assert.throws(() => loadCampaign('r6_test_both'), /must specify exactly one/);
  });
});

test('loadCampaign rejects non-en language', () => {
  withTempCampaign('r6_test_es', {
    slug: 'r6_test_es',
    name: 'r6_test',
    campaign_kind: 'ad_hoc',
    intent: 'ad_hoc',
    owning_agent: 'regina',
    recipient_relationship: 'past_guest_stayed',
    language: 'es',
    default_batch_size: 5,
    eligibility_sql_path: 'library/campaigns/r6_test_es.sql',
    description: 't',
    landing_page_url: 'https://example.com/',
    prompt_context: 'p',
  }, 'SELECT 1', () => {
    assert.throws(() => loadCampaign('r6_test_es'), /only language='en'/);
  });
});

// ── bindParams strict gates ──────────────────────────────────────────────

test('bindParams substitutes :batch_size and :today', () => {
  const out = bindParams("SELECT 1 WHERE d = :today LIMIT :batch_size", { batchSize: 5, today: '2026-05-07' });
  assert.equal(out, "SELECT 1 WHERE d = '2026-05-07' LIMIT 5");
});

test('bindParams rejects non-integer batchSize', () => {
  assert.throws(() => bindParams('SELECT 1', { batchSize: 5.5, today: '2026-05-07' }), /batchSize must be int/);
  assert.throws(() => bindParams('SELECT 1', { batchSize: 'five', today: '2026-05-07' }), /batchSize must be int/);
  assert.throws(() => bindParams('SELECT 1', { batchSize: -1, today: '2026-05-07' }), /batchSize must be int/);
  assert.throws(() => bindParams('SELECT 1', { batchSize: 999, today: '2026-05-07' }), /batchSize must be int/);
});

test('bindParams rejects malformed today (operator-input injection guard)', () => {
  assert.throws(() => bindParams('SELECT 1', { batchSize: 5, today: "2026-05-07'; DROP TABLE contacts;--" }), /today must be YYYY-MM-DD/);
  assert.throws(() => bindParams('SELECT 1', { batchSize: 5, today: '2026-5-7' }), /today must be YYYY-MM-DD/);
  assert.throws(() => bindParams('SELECT 1', { batchSize: 5, today: 'not-a-date' }), /today must be YYYY-MM-DD/);
  assert.throws(() => bindParams('SELECT 1', { batchSize: 5, today: null }), /today must be YYYY-MM-DD/);
  assert.throws(() => bindParams('SELECT 1', { batchSize: 5, today: 20260507 }), /today must be YYYY-MM-DD/);
});

test('bindParams replaces multiple occurrences of each param', () => {
  const out = bindParams(':batch_size :batch_size :today :today', { batchSize: 3, today: '2026-01-01' });
  assert.equal(out, "3 3 '2026-01-01' '2026-01-01'");
});

test('bindParams treats :batch_size_extra as a different identifier (word-boundary)', () => {
  // Word boundary means :batch_size and :batch_size_extra are different.
  const out = bindParams(':batch_size :batch_size_extra', { batchSize: 5, today: '2026-05-07' });
  // :batch_size_extra should NOT be substituted (no \b after _extra suffix).
  // The :batch_size prefix DOES match because the next char is _ which is
  // a word char... actually \b doesn't fire between :batch_size and _extra.
  // So :batch_size_extra stays untouched.
  assert.match(out, /^5 :batch_size_extra$/);
});
