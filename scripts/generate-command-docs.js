#!/usr/bin/env node
'use strict';

// Emits the machine-truth block inside every operator command reference.
//
// Source of truth is `crm/workflows/registry.js` — repo code, never runtime
// state. `check:stack` runs this generator in CI and again inside the deploy
// with RESORT_WORKFLOW_POLICY_PATH pointed at a file that does not exist
// (scripts/production-release.js), so anything derived from the runtime policy
// could not be reproduced byte-identically. What is armed *right now* is a
// runtime question and is answered by Slack `!help`, not by these documents.
//
// Adding a workflow to the registry therefore forces a docs change: the
// generator fails when a definition belongs to no surface and carries no
// recorded reason for having no operator surface.

const fs = require('node:fs');
const path = require('node:path');
const { listDefinitions } = require('../crm/workflows/registry');
const { QUARANTINED_LIVE_WORKFLOWS } = require('../lib/quarantined-workflows');
const { SURFACES, UNSURFACED, GLOBAL_COMMANDS, triggerInfo, commandsFor } = require('../lib/command-surfaces');

const ROOT = path.resolve(__dirname, '..');
const BEGIN = '<!-- BEGIN GENERATED';
const END = '<!-- END GENERATED -->';
const REGEN = 'regenerate with `npm run docs:commands`';

function isQuarantined(definition) {
  return QUARANTINED_LIVE_WORKFLOWS.includes(definition.name);
}

function effectsCell(definition) {
  if (isQuarantined(definition)) return '**quarantined**';
  const parts = [definition.mutates ? 'mutates' : 'read-only'];
  if (definition.autonomous) parts.push('autonomous');
  return parts.join(' · ');
}

function howCell(definition) {
  const triggers = Array.isArray(definition.allowed_triggers) && definition.allowed_triggers.length
    ? definition.allowed_triggers
    : ['*'];
  return triggers.map(trigger => triggerInfo(trigger).label).join(' or ');
}

function commandLines(definitions) {
  const commands = commandsFor(definitions, { exclude: QUARANTINED_LIVE_WORKFLOWS });
  if (!commands.length) return [];
  const lines = ['', '**Exact Slack commands on this surface**', ''];
  for (const info of commands) {
    for (const usage of info.usage) lines.push(`- \`${usage}\``);
    lines.push('');
    lines.push(`  ${info.detail[0].toUpperCase()}${info.detail.slice(1)}.`);
    lines.push('');
  }
  lines.pop();
  return lines;
}

function globalCommandLines() {
  const lines = ['', '**Available in every controlled channel**', ''];
  for (const info of GLOBAL_COMMANDS) {
    for (const usage of info.usage) lines.push(`- \`${usage}\``);
    lines.push('');
    lines.push(`  ${info.detail[0].toUpperCase()}${info.detail.slice(1)}.`);
    lines.push('');
  }
  lines.pop();
  return lines;
}

function surfaceBlock(surface, definitions) {
  const rows = definitions
    .filter(definition => surface.capabilities.includes(definition.capability))
    .sort((left, right) => left.name.localeCompare(right.name));
  const lines = [
    `${BEGIN}: durable workflows on the ${surface.name} surface — ${REGEN} -->`,
    '',
    `### Durable workflows — ${surface.title}`,
    '',
    'Generated from the workflow registry. Whether a mutating workflow executes for',
    'real or is shadowed is runtime state, not repo state: ask `!help` in the channel.',
    '',
    '| Workflow | Capability | Effects | How it runs |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(`| \`${row.name}\` | \`${row.capability}\` | ${effectsCell(row)} | ${howCell(row)} |`);
  }
  if (rows.some(isQuarantined)) {
    lines.push('');
    lines.push('A **quarantined** workflow stays registered but is barred from');
    lines.push('`live_workflows` by a machine-enforced guard, so its command is refused.');
    lines.push('Re-arming one means removing it from `QUARANTINED_LIVE_WORKFLOWS` through');
    lines.push('the release path — an owner-visible change, never a runtime toggle.');
  }
  lines.push(...commandLines(rows));
  lines.push(...globalCommandLines());
  lines.push('');
  lines.push(END);
  return { text: lines.join('\n'), names: rows.map(row => row.name) };
}

function catalogBlock(definitions, surfaceNamesByWorkflow) {
  const lines = [
    `${BEGIN}: full workflow catalog — ${REGEN} -->`,
    '',
    '### Full workflow catalog',
    '',
    `${definitions.length} registered definitions. "Surface" is the operator command`,
    'reference that documents the workflow; a workflow with no surface has no',
    'operator entry point and the reason is stated.',
    '',
    '| Workflow | Capability | Effects | Surface |',
    '| --- | --- | --- | --- |',
  ];
  for (const definition of [...definitions].sort((left, right) => left.name.localeCompare(right.name))) {
    const surfaces = surfaceNamesByWorkflow.get(definition.name) || [];
    const cell = surfaces.length
      ? surfaces.join(', ')
      : `_none — ${UNSURFACED[definition.capability]}_`;
    lines.push(`| \`${definition.name}\` | \`${definition.capability}\` | ${effectsCell(definition)} | ${cell} |`);
  }
  lines.push('');
  lines.push(END);
  return lines.join('\n');
}

function replaceBlock(existing, block, docPath) {
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`${docPath} is missing its generated markers; add ${BEGIN}: ... --> and ${END}`);
  }
  if (end < start) throw new Error(`${docPath} has ${END} before ${BEGIN}`);
  return `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
}

function render() {
  const definitions = listDefinitions();
  const surfaceNamesByWorkflow = new Map();
  const files = [];
  for (const surface of SURFACES) {
    const { text, names } = surfaceBlock(surface, definitions);
    for (const name of names) {
      if (!surfaceNamesByWorkflow.has(name)) surfaceNamesByWorkflow.set(name, []);
      surfaceNamesByWorkflow.get(name).push(surface.name);
    }
    files.push({ docPath: surface.doc, block: text });
  }
  const uncovered = definitions.filter(definition => !surfaceNamesByWorkflow.has(definition.name));
  const unexplained = uncovered.filter(definition => !UNSURFACED[definition.capability]);
  if (unexplained.length) {
    throw new Error(
      `these workflows belong to no surface and no capability reason is recorded: ${
        unexplained.map(definition => `${definition.name} (${definition.capability})`).join(', ')
      } — add the capability to a SURFACES entry or record why it has no operator surface in UNSURFACED`,
    );
  }
  files.push({ docPath: 'workflow/README.md', block: catalogBlock(definitions, surfaceNamesByWorkflow) });
  return files;
}

function main(argv) {
  const check = argv.includes('--check');
  const drifted = [];
  for (const { docPath, block } of render()) {
    const absolute = path.join(ROOT, docPath);
    const existing = fs.readFileSync(absolute, 'utf8');
    const next = replaceBlock(existing, block, docPath);
    if (next === existing) continue;
    if (check) drifted.push(docPath);
    else fs.writeFileSync(absolute, next);
  }
  if (check && drifted.length) {
    process.stderr.write(
      `generated command documentation is stale in: ${drifted.join(', ')}\n`
      + 'run `npm run docs:commands` and commit the result\n',
    );
    return 1;
  }
  process.stdout.write(check
    ? 'command documentation matches the workflow registry\n'
    : 'command documentation regenerated\n');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { render, replaceBlock, main };
