#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const patterns = [
  ['Twilio API key secret', new RegExp('S' + 'K[0-9a-fA-F]{32}', 'g')],
  ['Meta access token', new RegExp('E' + 'AA[A-Za-z0-9_-]{60,}', 'g')],
  ['GitHub token', new RegExp('gh' + '[pousr]_[A-Za-z0-9_]{20,}', 'g')],
  ['GitHub fine-grained token', new RegExp('github_' + 'pat_[A-Za-z0-9_]{20,}', 'g')],
  ['Slack token', new RegExp('xox' + '[baprs]-[A-Za-z0-9-]{20,}', 'g')],
  ['AI provider key', new RegExp('sk-' + '(?:ant|proj)-[A-Za-z0-9_-]{12,}', 'g')],
  ['Google API key', new RegExp('AI' + 'za[0-9A-Za-z_-]{20,}', 'g')],
  ['Private key', new RegExp('BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY', 'g')],
];

try {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const findings = [];
  for (const file of output.toString('utf8').split('\0').filter(Boolean)) {
    if (file === 'scripts/check-secrets.js' || file.endsWith('package-lock.json')) continue;
    const data = fs.readFileSync(file);
    if (data.includes(0)) continue;
    const text = data.toString('utf8');
    for (const [label, pattern] of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(`${file}:${line}: ${label}`);
      }
    }
  }
  if (findings.length > 0) {
    process.stderr.write(`${findings.join('\n')}\nPotential credential material found.\n`);
    process.exit(1);
  }
  console.log('Secret pattern scan passed.');
} catch (error) {
  process.stderr.write(error.stderr || error.message);
  process.exit(error.status || 2);
}
