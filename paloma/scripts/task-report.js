#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { buildTaskReport, loadUsers } = require('../lib/task-report');

const root = path.resolve(__dirname, '..', '..');

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function usage() {
  return `Usage:
  node paloma/scripts/task-report.js --user-id <SLACK_USER_ID> [--status active]
  node paloma/scripts/task-report.js --assignee <alias-or-exact-name> [--status completed]
  node paloma/scripts/task-report.js --all [--status all]

Status: active (default), open, in_progress, completed, cancelled, or all.`;
}

function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const databasePath = path.resolve(option(args, '--database') || path.join(root, 'paloma', 'data', 'tasks.db'));
  const configPath = path.resolve(option(args, '--config') || path.join(root, 'paloma', 'config.json'));
  if (!fs.existsSync(databasePath)) throw new Error(`Paloma task database was not found at ${databasePath}`);
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const report = buildTaskReport(database, {
      userId: option(args, '--user-id'),
      assignee: option(args, '--assignee'),
      all: args.includes('--all'),
      status: option(args, '--status'),
      limit: option(args, '--limit'),
      users: loadUsers(configPath),
    });
    process.stdout.write(`${report.text}\n`);
  } finally {
    database.close();
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`[paloma-task-report] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, option, usage };
