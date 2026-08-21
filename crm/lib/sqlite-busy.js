'use strict';

// SQLite write-lock contention on the shared CRM database (F-054 / F-064).
//
// The CRM server, the workflow worker, the scheduled graph children and a few
// Python jobs all write one SQLite file. node-sqlite3 waits only 1000 ms for
// the write lock before surfacing SQLITE_BUSY, so a long sibling transaction
// turns into a failed step. Two things are true about the writes this module
// guards: the transaction rolled back (SQLite never half-applies it), and the
// statement is a local projection or bookkeeping write with no provider
// effect. Repeating it is therefore safe. Provider calls are never routed
// through here — a SQLITE_BUSY around an external effect still fails closed.

const DEFAULT_BUSY_TIMEOUT_MS = 15_000;
const BUSY_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE',
]);

/**
 * Busy timeout handed to every long-lived or scheduled connection. SQLite
 * itself then waits this long for the lock before the driver raises BUSY.
 */
function busyTimeoutMs(env = process.env) {
  const value = Number(env.SQLITE_BUSY_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_BUSY_TIMEOUT_MS;
}

/** Options for `@databases/sqlite` connect(): `createDB(path, connectionOptions())`. */
function connectionOptions(env = process.env) {
  return { busyTimeout: busyTimeoutMs(env) };
}

/** Options for `better-sqlite3`: `new Database(path, betterSqliteOptions())`. */
function betterSqliteOptions(extra = {}, env = process.env) {
  return { ...extra, timeout: busyTimeoutMs(env) };
}

function isSqliteBusy(error) {
  if (!error) return false;
  if (BUSY_CODES.has(String(error.code || ''))) return true;
  return /\bSQLITE_(?:BUSY|LOCKED)\b|database is locked/i.test(String(error.message || ''));
}

/**
 * Exponential backoff with jitter, in milliseconds, for the Nth retry
 * (attempt numbers start at 1 for the first failed attempt).
 */
function busyRetryDelayMs(attempt, { baseMs = 250, maxMs = 4_000, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, Number(attempt) - 1)));
  const jitter = Math.floor(random() * Math.min(1_000, exponential));
  return exponential + jitter;
}

/**
 * Run `operation` again while it fails with SQLITE_BUSY/SQLITE_LOCKED, up to
 * `attempts` total attempts. Any other error — and the final busy error —
 * propagates unchanged, with `busyAttempts` stamped on a busy error so the
 * ledger shows how hard the write tried.
 */
async function withBusyRetry(operation, {
  attempts = 5,
  baseMs = 250,
  maxMs = 4_000,
  random = Math.random,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRetry = null,
  label = 'sqlite write',
} = {}) {
  if (typeof operation !== 'function') throw new TypeError('withBusyRetry requires an operation function');
  const total = Math.max(1, Math.floor(Number(attempts) || 1));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const busy = isSqliteBusy(error);
      if (!busy || attempt >= total) {
        if (busy && error && typeof error === 'object') error.busyAttempts = attempt;
        throw error;
      }
      const delayMs = busyRetryDelayMs(attempt, { baseMs, maxMs, random });
      if (typeof onRetry === 'function') onRetry({ attempt, delayMs, error, label });
      await sleep(delayMs);
    }
  }
}

module.exports = {
  DEFAULT_BUSY_TIMEOUT_MS,
  betterSqliteOptions,
  busyRetryDelayMs,
  busyTimeoutMs,
  connectionOptions,
  isSqliteBusy,
  withBusyRetry,
};
