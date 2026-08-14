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

function fileHash(file) {
  const source = path.resolve(String(file.localPath || ''));
  if (!source || !fs.statSync(source).isFile()) throw new Error('downloaded Slack CSV is unavailable');
  return file.sha256 || sha256(fs.readFileSync(source));
}

function findCsvByHash(hash, directory) {
  if (!directory || !fs.existsSync(directory)) return null;
  const match = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
    .map(entry => path.join(directory, entry.name))
    .find(candidate => sha256(fs.readFileSync(candidate)) === hash);
  return match || null;
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
    return {
      path: destination, sha256: sourceHash, staged: false,
      alreadyCaptured: true, alreadyProcessed: false,
    };
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
  return {
    path: destination, sha256: sourceHash, staged: true,
    alreadyCaptured: false, alreadyProcessed: false,
  };
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
  const processedDirectory = path.resolve(options.processedDirectory || path.join(inboxDirectory, 'processed'));
  fs.mkdirSync(inboxDirectory, { recursive: true, mode: 0o700 });
  const results = csvFiles.map(file => {
    const hash = fileHash(file);
    const processed = findCsvByHash(hash, processedDirectory);
    if (processed) {
      return {
        path: processed, sha256: hash, staged: false,
        alreadyCaptured: false, alreadyProcessed: true,
      };
    }
    const captured = findCsvByHash(hash, inboxDirectory);
    if (captured) {
      return {
        path: captured, sha256: hash, staged: false,
        alreadyCaptured: true, alreadyProcessed: false,
      };
    }
    return stageFile(file, path.join(inboxDirectory, stableInboxName(messageId, file)));
  });
  return {
    channelId,
    messageId,
    files: results.map(result => ({
      name: path.basename(result.path),
      path: result.path,
      sha256: result.sha256,
      staged: result.staged,
      alreadyCaptured: result.alreadyCaptured,
      alreadyProcessed: result.alreadyProcessed,
    })),
  };
}

module.exports = {
  DEFAULT_ACCOUNTING_INBOX,
  fileHash,
  findCsvByHash,
  isCsvFile,
  stableInboxName,
  stageSlackAccountingStatement,
};
