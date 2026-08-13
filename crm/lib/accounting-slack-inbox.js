'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../../lib/runtime-paths');
const { fetchSlackReceiptSource, safeSegment, sha256 } = require('./slack-receipt-source');

const DEFAULT_ACCOUNTING_INBOX = path.join(ROOT, 'accounting', 'inbox');

function isCsvFile(file = {}) {
  return String(file.name || '').toLowerCase().endsWith('.csv')
    || /^(?:text|application)\/csv(?:$|;)/i.test(String(file.mimetype || ''));
}

function stableInboxName(messageId, file) {
  const original = path.parse(String(file.name || 'statement.csv'));
  const base = safeSegment(original.name, 'statement');
  return `slack-${safeSegment(messageId, 'message')}-${safeSegment(file.id, 'file')}-${base}.csv`;
}

function stageFile(file, destination) {
  const source = path.resolve(String(file.localPath || ''));
  if (!source || !fs.statSync(source).isFile()) throw new Error('downloaded Slack CSV is unavailable');
  const sourceBuffer = fs.readFileSync(source);
  const sourceHash = file.sha256 || sha256(sourceBuffer);

  if (fs.existsSync(destination)) {
    const existingHash = sha256(fs.readFileSync(destination));
    if (existingHash !== sourceHash) {
      const error = new Error(`accounting inbox collision for ${path.basename(destination)}`);
      error.code = 'accounting_inbox_collision';
      throw error;
    }
    return { path: destination, sha256: sourceHash, staged: false };
  }

  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, sourceBuffer, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  fs.chmodSync(destination, 0o600);
  return { path: destination, sha256: sourceHash, staged: true };
}

async function stageSlackAccountingStatement({ channelId, messageId, threadTs = null }, options = {}) {
  const fetchSource = options.fetchSource || fetchSlackReceiptSource;
  const source = await fetchSource({ channelId, messageId, threadTs }, options.sourceOptions || {});
  const csvFiles = (source.files || []).filter(isCsvFile);
  if (!csvFiles.length) {
    const error = new Error('Slack accounting message contains no CSV attachment');
    error.code = 'accounting_csv_missing';
    throw error;
  }

  const inboxDirectory = path.resolve(options.inboxDirectory || DEFAULT_ACCOUNTING_INBOX);
  fs.mkdirSync(inboxDirectory, { recursive: true, mode: 0o700 });
  const results = csvFiles.map(file => stageFile(
    file,
    path.join(inboxDirectory, stableInboxName(messageId, file)),
  ));
  return {
    channelId,
    messageId,
    files: results.map(result => ({
      name: path.basename(result.path),
      path: result.path,
      sha256: result.sha256,
      staged: result.staged,
    })),
  };
}

module.exports = {
  DEFAULT_ACCOUNTING_INBOX,
  isCsvFile,
  stableInboxName,
  stageSlackAccountingStatement,
};
