#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const roots = ['crm', 'prospector', 'regina', 'sarah-coach', 'scripts', 'openclaw-plugins', 'evals'];
const ignored = new Set(['node_modules', 'dist', 'cache', 'runs']);
const failures = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', fullPath], {
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        failures.push(`${path.relative(root, fullPath)}\n${result.stderr.trim()}`);
      }
    }
  }
}

for (const directory of roots) {
  walk(path.join(root, directory));
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n\n')}\n`);
  process.exit(1);
}

console.log('JavaScript syntax checks passed.');
