#!/usr/bin/env node
'use strict';

require('../../lib/runtime-paths');
const createDBModule = require('@databases/sqlite');
const createDB = createDBModule.default || createDBModule;
const { sql } = require('@databases/sqlite');
const { DB_PATH } = require('../../lib/runtime-paths');
const { classifyReply } = require('../lib/email-conversations');
const { ensureSchemaAsync } = require('../lib/workflow-schema');

async function auditClassifications(db) {
  const rows = await db.query(sql`SELECT id, outreach_send_id, body_text,
      raw_body_text, sentiment, classification_source
    FROM email_threads
    WHERE direction='inbound'
      AND classification_source='email_conversation_classifier'
      AND raw_body_text IS NOT NULL
    ORDER BY id`);
  return rows.map(row => {
    const next = classifyReply(row.raw_body_text);
    return {
      id: row.id,
      outreachSendId: row.outreach_send_id,
      previous: row.sentiment,
      next: next.quality,
      reason: next.reason,
      normalizedText: next.normalizedText,
      bodyChanged: String(row.body_text || '') !== next.normalizedText,
      classificationChanged: row.sentiment !== next.quality,
    };
  }).filter(row => row.bodyChanged || row.classificationChanged);
}

async function main(args = process.argv.slice(2), deps = {}) {
  const apply = args.includes('--apply');
  if (apply && !args.includes('--confirm-production')) {
    throw new Error('refusing classification repair without --confirm-production');
  }
  const db = deps.db || createDB(DB_PATH);
  const ownsDb = !deps.db;
  try {
    await ensureSchemaAsync(db, sql);
    const changes = await auditClassifications(db);
    if (apply) {
      await db.tx(async tx => {
        for (const change of changes) {
          if (change.classificationChanged) {
            await tx.query(sql`UPDATE email_threads SET body_text=${change.normalizedText},
              processing_status='pending', processing_error=NULL, processed_at=NULL,
              workflow_run_id=NULL, updated_at=datetime('now') WHERE id=${change.id}`);
          } else {
            await tx.query(sql`UPDATE email_threads SET body_text=${change.normalizedText},
              updated_at=datetime('now') WHERE id=${change.id}`);
          }
        }
      });
    }
    return {
      ok: true,
      mode: apply ? 'apply' : 'dry-run',
      normalized: changes.filter(row => row.bodyChanged).length,
      requeued: changes.filter(row => row.classificationChanged).length,
      changes: changes.map(({ normalizedText, ...row }) => row),
    };
  } finally {
    if (ownsDb) await db.dispose();
  }
}

if (require.main === module) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`[reconcile-email-classifications] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { auditClassifications, main };
