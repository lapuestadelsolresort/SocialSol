#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');
const { DB_PATH } = require('../../lib/runtime-paths');
const { requestOwnerRez } = require('../lib/ownerrez-api');

function latestThreadId(databasePath = DB_PATH) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT payload FROM ownerrez_events
      WHERE event_type LIKE 'thread_message%' ORDER BY id DESC LIMIT 100`).all();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload);
        const id = Number.parseInt(payload.entity?.thread?.id || payload.entity?.thread_id, 10);
        if (Number.isSafeInteger(id) && id > 0) return id;
      } catch {}
    }
    return null;
  } finally {
    db.close();
  }
}

async function main({ databasePath = DB_PATH, request = requestOwnerRez } = {}) {
  const threadId = latestThreadId(databasePath);
  if (!threadId) throw new Error('no OwnerRez message thread is available for the read-only messaging preflight');
  const response = await request({
    method: 'GET', requestPath: '/v2/messages',
    query: { threadId, include_drafts: false },
  });
  if (!response.ok || !Array.isArray(response.data?.items)
      || String(response.data?.thread?.id || '') !== String(threadId)) {
    throw new Error('OwnerRez messaging preflight did not return the requested thread');
  }
  return { ok: true, ownerRezMessagingAuthorized: true, threadId, messageCount: response.data.items.length };
}

if (require.main === module) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`[verify-ownerrez-messaging-scope] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { latestThreadId, main };
