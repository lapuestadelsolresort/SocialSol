#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.env.SOCIALSOL_ROOT || path.join(__dirname, '..'));
const nodeBin = path.resolve(process.env.NODE_BIN || process.execPath);
const pythonBin = path.resolve(process.env.PYTHON_BIN || '/opt/homebrew/bin/python3');
const runtimeValues = {
  '__RESORT_SOCIAL_CHANNEL__': process.env.RESORT_SOCIAL_CHANNEL || '',
  '__PROSPECTOR_SLACK_CHANNEL__': process.env.PROSPECTOR_SLACK_CHANNEL || '',
  '__OPENCLAW_SLACK_ACCOUNT__': process.env.OPENCLAW_SLACK_ACCOUNT || '',
  '__GMAIL_IMPERSONATE_USER__': process.env.GMAIL_IMPERSONATE_USER || '',
};
const outputIndex = process.argv.indexOf('--output');
const outputDir = outputIndex >= 0
  ? path.resolve(process.argv[outputIndex + 1])
  : path.join(root, 'deploy', 'launchagents', 'generated');

if (outputIndex >= 0 && !process.argv[outputIndex + 1]) {
  throw new Error('--output requires a directory');
}

const templatesDir = path.join(root, 'deploy', 'launchagents', 'templates');
const templates = fs.readdirSync(templatesDir)
  .filter((name) => name.endsWith('.plist.template'))
  .sort();

fs.mkdirSync(outputDir, { recursive: true });

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

for (const templateName of templates) {
  const sourcePath = path.join(templatesDir, templateName);
  const outputName = path.basename(templateName, '.template');
  const outputPath = path.join(outputDir, outputName);
  let rendered = fs.readFileSync(sourcePath, 'utf8')
    .replaceAll('__SOCIALSOL_ROOT__', root)
    .replaceAll('__NODE_BIN__', nodeBin)
    .replaceAll('__PYTHON_BIN__', pythonBin);
  for (const [placeholder, value] of Object.entries(runtimeValues)) {
    rendered = rendered.replaceAll(placeholder, xmlEscape(value));
  }
  fs.writeFileSync(outputPath, rendered);
  console.log(path.relative(root, outputPath));
}
