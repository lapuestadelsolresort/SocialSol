#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.env.SOCIALSOL_ROOT || path.join(__dirname, '..'));
const nodeBin = path.resolve(process.env.NODE_BIN || process.execPath);
const pythonBin = path.resolve(process.env.PYTHON_BIN || '/opt/homebrew/bin/python3');
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

for (const templateName of templates) {
  const sourcePath = path.join(templatesDir, templateName);
  const outputName = path.basename(templateName, '.template');
  const outputPath = path.join(outputDir, outputName);
  const rendered = fs.readFileSync(sourcePath, 'utf8')
    .replaceAll('__SOCIALSOL_ROOT__', root)
    .replaceAll('__NODE_BIN__', nodeBin)
    .replaceAll('__PYTHON_BIN__', pythonBin);
  fs.writeFileSync(outputPath, rendered);
  console.log(path.relative(root, outputPath));
}
