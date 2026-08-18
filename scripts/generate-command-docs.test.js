'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { render, replaceBlock, main } = require('./generate-command-docs');
const { SURFACES, UNSURFACED, GLOBAL_COMMANDS, TRIGGERS, commandsFor } = require('../lib/command-surfaces');
const { QUARANTINED_LIVE_WORKFLOWS } = require('../lib/quarantined-workflows');
const { listDefinitions } = require('../crm/workflows/registry');

const ROOT = path.resolve(__dirname, '..');

test('the committed documentation matches the registry', () => {
  assert.equal(main(['--check']), 0);
});

test('every surface document exists and carries exactly one generated block', () => {
  const docs = [...SURFACES.map(surface => surface.doc), 'workflow/README.md'];
  assert.equal(new Set(docs).size, docs.length, 'two surfaces must not share one document');
  for (const doc of docs) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    assert.equal(text.split('<!-- BEGIN GENERATED').length - 1, 1, `${doc} begin markers`);
    assert.equal(text.split('<!-- END GENERATED -->').length - 1, 1, `${doc} end markers`);
  }
});

test('render covers every surface plus the full catalog', () => {
  const files = render();
  assert.equal(files.length, SURFACES.length + 1);
  assert.ok(files.every(file => file.block.startsWith('<!-- BEGIN GENERATED') && file.block.endsWith('<!-- END GENERATED -->')));
});

test('every declared capability is one a registered workflow actually has', () => {
  const real = new Set(listDefinitions().map(definition => definition.capability));
  for (const surface of SURFACES) {
    for (const capability of surface.capabilities) {
      assert.ok(real.has(capability), `${surface.name} claims unknown capability ${capability}`);
    }
  }
  for (const capability of Object.keys(UNSURFACED)) {
    assert.ok(real.has(capability), `UNSURFACED names unknown capability ${capability}`);
  }
});

test('every registered workflow is documented on a surface or recorded as having none', () => {
  const covered = new Set();
  for (const surface of SURFACES) {
    for (const definition of listDefinitions()) {
      if (surface.capabilities.includes(definition.capability)) covered.add(definition.name);
    }
  }
  const orphans = listDefinitions()
    .filter(definition => !covered.has(definition.name) && !UNSURFACED[definition.capability]);
  assert.deepEqual(orphans.map(definition => definition.name), []);
});

test('a new capability with no surface and no recorded reason fails the generator', () => {
  const definitions = listDefinitions();
  const victim = definitions.find(definition => definition.capability === 'regina.send');
  const surface = SURFACES.find(entry => entry.name === 'reengager-regina');
  const restore = surface.capabilities.slice();
  surface.capabilities = [];
  try {
    assert.throws(() => render(), /belong to no surface/);
    assert.throws(() => render(), new RegExp(victim.name.replace(/\./g, '\\.')));
  } finally {
    surface.capabilities = restore;
  }
  assert.equal(main(['--check']), 0, 'the tree must be left untouched by the failure path');
});

test('replaceBlock refuses a document whose markers are missing or inverted', () => {
  assert.throws(() => replaceBlock('no markers here', 'block', 'x.md'), /missing its generated markers/);
  assert.throws(
    () => replaceBlock('<!-- END GENERATED --> then <!-- BEGIN GENERATED: x -->', 'block', 'x.md'),
    /before/,
  );
  const replaced = replaceBlock('a\n<!-- BEGIN GENERATED: x -->old<!-- END GENERATED -->\nz', 'NEW', 'x.md');
  assert.equal(replaced, 'a\nNEW\nz');
});

test('a quarantined workflow is listed but never offered as a typeable command', () => {
  const files = render();
  const social = files.find(file => file.docPath === 'campaigns/COMMANDS.md').block;
  for (const name of QUARANTINED_LIVE_WORKFLOWS) {
    assert.match(social, new RegExp(`\`${name.replace(/\./g, '\\.')}\``), `${name} should still be listed`);
  }
  assert.match(social, /\*\*quarantined\*\*/);
  assert.doesNotMatch(social, /- `!dm /);
  // and the exclusion is the quarantine, not a missing table entry
  const withoutQuarantine = commandsFor(
    listDefinitions().filter(definition => definition.name === 'meta.dm.reply'),
  );
  assert.equal(withoutQuarantine.length, 1);
  assert.equal(commandsFor(
    listDefinitions().filter(definition => definition.name === 'meta.dm.reply'),
    { exclude: QUARANTINED_LIVE_WORKFLOWS },
  ).length, 0);
});

test('every generated surface block carries the globally available commands', () => {
  for (const file of render()) {
    if (file.docPath === 'workflow/README.md') continue;
    assert.match(file.block, /\*\*Available in every controlled channel\*\*/, file.docPath);
    for (const usage of GLOBAL_COMMANDS.flatMap(command => command.usage)) {
      assert.ok(file.block.includes(`- \`${usage}\``), `${file.docPath} is missing ${usage}`);
    }
  }
});

test('the catalog block accounts for every registered workflow exactly once', () => {
  const catalog = render().find(file => file.docPath === 'workflow/README.md').block;
  const definitions = listDefinitions();
  for (const definition of definitions) {
    const rows = catalog.split('\n').filter(line => line.startsWith(`| \`${definition.name}\` |`));
    assert.equal(rows.length, 1, `${definition.name} should appear once, found ${rows.length}`);
  }
  assert.match(catalog, new RegExp(`${definitions.length} registered definitions`));
});

test('every trigger a registered workflow declares has a documented description', () => {
  const declared = new Set();
  for (const definition of listDefinitions()) {
    for (const trigger of definition.allowed_triggers || []) declared.add(trigger);
  }
  for (const trigger of declared) {
    assert.ok(TRIGGERS[trigger], `trigger ${trigger} has no entry in the command table`);
  }
});
