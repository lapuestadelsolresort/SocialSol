#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const { DB_PATH } = require('../../lib/runtime-paths');
const {
  buildPerformanceReport,
  formatPerformanceReport,
} = require('../lib/performance-report');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const db = createDB(DB_PATH);
  try {
    const report = await buildPerformanceReport(db, sql, config);
    const output = process.argv.includes('--json')
      ? JSON.stringify(report, null, 2)
      : formatPerformanceReport(report);
    process.stdout.write(`${output}\n`);
  } finally {
    await db.dispose();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[performance-status] FATAL: ${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = { main };
