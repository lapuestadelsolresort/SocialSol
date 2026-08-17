'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { computePlan, loadManifest, planHasDrift } = require('./install-launchagents');

const PREFIX = 'com.lapuestadelsolresort.';

function fixture({ services, rendered = {}, installed = {}, symlinks = {} }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-la-test-'));
  const renderedDir = path.join(base, 'generated');
  const installedDir = path.join(base, 'LaunchAgents');
  fs.mkdirSync(renderedDir, { recursive: true });
  fs.mkdirSync(installedDir, { recursive: true });
  for (const [name, content] of Object.entries(rendered)) {
    fs.writeFileSync(path.join(renderedDir, name), content);
  }
  for (const [name, content] of Object.entries(installed)) {
    fs.writeFileSync(path.join(installedDir, name), content);
  }
  for (const [name, target] of Object.entries(symlinks)) {
    const targetPath = path.join(base, `target-${name}`);
    fs.writeFileSync(targetPath, symlinks[name]);
    fs.symlinkSync(targetPath, path.join(installedDir, name));
  }
  const manifest = { version: 1, label_prefix: PREFIX, services, watchdog: {} };
  return { manifest, renderedDir, installedDir };
}

test('converged loaded service produces no actions and no drift', () => {
  const name = `${PREFIX}alpha.plist`;
  const { manifest, renderedDir, installedDir } = fixture({
    services: { alpha: { state: 'loaded' } },
    rendered: { [name]: 'same' },
    installed: { [name]: 'same' },
  });
  const plan = computePlan({
    manifest, renderedDir, installedDir,
    loadedLabels: new Set([`${PREFIX}alpha`]),
  });
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.errors, []);
  assert.equal(planHasDrift(plan), false);
});

test('content drift on a loaded service becomes install with bootout+bootstrap', () => {
  const name = `${PREFIX}alpha.plist`;
  const { manifest, renderedDir, installedDir } = fixture({
    services: { alpha: { state: 'loaded' } },
    rendered: { [name]: 'new-content' },
    installed: { [name]: 'old-content' },
  });
  const plan = computePlan({
    manifest, renderedDir, installedDir,
    loadedLabels: new Set([`${PREFIX}alpha`]),
  });
  assert.equal(plan.actions.length, 1);
  assert.deepEqual(
    { type: plan.actions[0].type, reason: plan.actions[0].reason, bootout: plan.actions[0].bootout, bootstrap: plan.actions[0].bootstrap },
    { type: 'install', reason: 'content-drift', bootout: true, bootstrap: true },
  );
  assert.equal(planHasDrift(plan), true);
});

test('symlinked definition and missing install are both drift', () => {
  const alpha = `${PREFIX}alpha.plist`;
  const beta = `${PREFIX}beta.plist`;
  const { manifest, renderedDir, installedDir } = fixture({
    services: { alpha: { state: 'loaded' }, beta: { state: 'loaded' } },
    rendered: { [alpha]: 'content', [beta]: 'content' },
    symlinks: { [alpha]: 'content' },
  });
  const plan = computePlan({
    manifest, renderedDir, installedDir,
    loadedLabels: new Set([`${PREFIX}alpha`]),
  });
  const reasons = Object.fromEntries(plan.actions.map(action => [action.name, action.reason]));
  assert.equal(reasons.alpha, 'symlink-definition');
  assert.equal(reasons.beta, 'not-installed');
});

test('installed-but-not-loaded service gets a bootstrap action', () => {
  const name = `${PREFIX}alpha.plist`;
  const { manifest, renderedDir, installedDir } = fixture({
    services: { alpha: { state: 'loaded' } },
    rendered: { [name]: 'same' },
    installed: { [name]: 'same' },
  });
  const plan = computePlan({ manifest, renderedDir, installedDir, loadedLabels: new Set() });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'bootstrap');
  assert.equal(plan.actions[0].reason, 'not-loaded');
});

test('stray .disabled twin of a loaded service is removed', () => {
  const name = `${PREFIX}alpha.plist`;
  const { manifest, renderedDir, installedDir } = fixture({
    services: { alpha: { state: 'loaded' } },
    rendered: { [name]: 'same' },
    installed: { [name]: 'same', [`${name}.disabled`]: 'remnant' },
  });
  const plan = computePlan({
    manifest, renderedDir, installedDir,
    loadedLabels: new Set([`${PREFIX}alpha`]),
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, 'remove-stray-disabled');
});

test('retired service: loaded+installed drives bootout, removal of both variants, disable', () => {
  const name = `${PREFIX}legacy.plist`;
  const { manifest, renderedDir, installedDir } = fixture({
    services: { legacy: { state: 'retired' } },
    installed: { [name]: 'live schedule', [`${name}.disabled`]: 'old remnant' },
  });
  const plan = computePlan({
    manifest, renderedDir, installedDir,
    loadedLabels: new Set([`${PREFIX}legacy`]),
  });
  assert.deepEqual(plan.actions.map(action => action.type).sort(),
    ['bootout', 'disable', 'remove-file', 'remove-file']);
  assert.equal(planHasDrift(plan), true);
});

test('fully retired service is convergent: disable-only plans are not drift', () => {
  const { manifest, renderedDir, installedDir } = fixture({
    services: { legacy: { state: 'retired' } },
  });
  const plan = computePlan({ manifest, renderedDir, installedDir, loadedLabels: new Set() });
  assert.deepEqual(plan.actions.map(action => action.type), ['disable']);
  assert.equal(planHasDrift(plan), false);
});

test('disabled service: active plist or loaded state is drift, .disabled remnant is coherent', () => {
  const name = `${PREFIX}insights.plist`;
  const { manifest, renderedDir, installedDir } = fixture({
    services: { insights: { state: 'disabled' } },
    installed: { [name]: 'active', [`${name}.disabled`]: 'coherent remnant' },
  });
  const plan = computePlan({
    manifest, renderedDir, installedDir,
    loadedLabels: new Set([`${PREFIX}insights`]),
  });
  assert.deepEqual(plan.actions.map(action => action.type).sort(), ['bootout', 'remove-file']);

  fs.unlinkSync(path.join(installedDir, name));
  const clean = computePlan({ manifest, renderedDir, installedDir, loadedLabels: new Set() });
  assert.deepEqual(clean.actions, []);
  assert.equal(planHasDrift(clean), false);
});

test('unmanaged installed files and unmanaged loaded labels are reported, never deleted', () => {
  const { manifest, renderedDir, installedDir } = fixture({
    services: { alpha: { state: 'loaded' } },
    rendered: { [`${PREFIX}alpha.plist`]: 'same' },
    installed: {
      [`${PREFIX}alpha.plist`]: 'same',
      [`${PREFIX}mystery.plist`]: 'who installed this',
    },
  });
  const plan = computePlan({
    manifest, renderedDir, installedDir,
    loadedLabels: new Set([`${PREFIX}alpha`, `${PREFIX}ghost`]),
  });
  assert.deepEqual(plan.strays, [`${PREFIX}mystery.plist`]);
  assert.deepEqual(plan.strayLoaded, [`${PREFIX}ghost`]);
  assert.equal(plan.actions.length, 0);
  assert.equal(planHasDrift(plan), true);
});

test('loaded service without a rendered plist is a plan error', () => {
  const { manifest, renderedDir, installedDir } = fixture({
    services: { alpha: { state: 'loaded' } },
  });
  const plan = computePlan({ manifest, renderedDir, installedDir, loadedLabels: new Set() });
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].problem, 'rendered-plist-missing');
  assert.equal(planHasDrift(plan), true);
});

test('the committed service manifest parses and covers the retired legacy set', () => {
  const manifest = loadManifest();
  const states = Object.fromEntries(
    Object.entries(manifest.services).map(([name, entry]) => [name, entry.state]),
  );
  for (const legacy of ['gtku', 'orchestrator', 'ownerrez-sync', 'prospector-daily', 'regina-anniversary', 'squarespace-sync']) {
    assert.equal(states[legacy], 'retired', `${legacy} must be retired`);
  }
  assert.equal(states['meta-insights'], 'disabled');
  for (const adopted of ['kapital-tests', 'qbo-keepalive', 'paloma-followup', 'paloma-scan', 'paloma-summary', 'state-backup', 'media-backup-verify']) {
    assert.equal(states[adopted], 'loaded', `${adopted} must be loaded`);
  }
  // every loaded service must have a committed template
  const templatesDir = path.join(__dirname, '..', 'deploy', 'launchagents', 'templates');
  for (const [name, entry] of Object.entries(manifest.services)) {
    const template = path.join(templatesDir, `${manifest.label_prefix}${name}.plist.template`);
    if (entry.state === 'loaded') {
      assert.equal(fs.existsSync(template), true, `template missing for loaded service ${name}`);
    } else if (entry.state === 'retired') {
      assert.equal(fs.existsSync(template), false, `retired service ${name} must not keep a template`);
    }
  }
  // watchdog thresholds parse as positive hours
  for (const [slug, entry] of Object.entries(manifest.watchdog)) {
    assert.ok(entry.max_age_hours > 0, `${slug} needs a positive max_age_hours`);
  }
});
