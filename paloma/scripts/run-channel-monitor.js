#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { heartbeatPrompt } = require('../lib/monitoring-contract');

const root = path.resolve(__dirname, '..', '..');
const configPath = path.resolve(process.env.PALOMA_CONFIG_PATH || path.join(root, 'paloma', 'config.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const monitoring = config.monitoring || {};
if (monitoring.enabled === false) throw new Error('Paloma monitoring is disabled');
const accountId = process.env.PALOMA_SLACK_ACCOUNT || monitoring.slack_account;
const agentId = process.env.PALOMA_AGENT_ID || monitoring.agent_id || 'paloma';
if (!accountId) throw new Error('Paloma monitoring.slack_account is required');
const timeoutSeconds = Number(monitoring.timeout_seconds || 300);
const message = heartbeatPrompt({
  accountId,
  databasePath: path.join(root, 'paloma', 'data', 'tasks.db'),
  lookbackMinutes: Number(monitoring.initial_lookback_minutes || 60),
});
const result = spawnSync(process.env.OPENCLAW_BIN || 'openclaw', [
  'agent', '--agent', agentId, '--message', message, '--timeout', String(timeoutSeconds), '--json',
], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
