#!/usr/bin/env node
'use strict';

require('../../lib/runtime-paths');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { DB_PATH } = require('../../lib/runtime-paths');
const { ensureSchemaAsync } = require('../lib/workflow-schema');
const { reconcileWhatsAppStatuses } = require('../lib/whatsapp-status-reconciliation');

async function main(args = process.argv.slice(2), deps = {}) {
  const apply = args.includes('--apply');
  if (apply && !args.includes('--confirm-production')) {
    throw new Error('refusing WhatsApp status backfill without --confirm-production');
  }
  const db = deps.db || createDB(DB_PATH);
  const ownsDb = !deps.db;
  try {
    if (apply) await ensureSchemaAsync(db, sql);
    return await reconcileWhatsAppStatuses(db, {
      apply,
      concurrency: deps.concurrency || 5,
      readStatus: deps.readStatus,
    });
  } finally {
    if (ownsDb) await db.dispose();
  }
}

if (require.main === module) {
  main().then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }).catch(error => {
    console.error(`[reconcile-whatsapp-statuses] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
