#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { monitorInvocation } = require('../lib/monitoring-contract');

const root = path.resolve(__dirname, '..', '..');
const configPath = path.resolve(process.env.PALOMA_CONFIG_PATH || path.join(root, 'paloma', 'config.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
// One contract builds the turn: account, agent, timeout, tracker channel and
// prompt all come from paloma/config.json (F-066: the tracker channel was
// never passed here, so the prompt builder threw on every scheduled run).
const invocation = monitorInvocation({ config, env: process.env, root });
const result = spawnSync(process.env.OPENCLAW_BIN || 'openclaw', invocation.args, {
  encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
