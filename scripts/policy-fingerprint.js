#!/usr/bin/env node
'use strict';

//
// policy-fingerprint.js — make out-of-band edits of the runtime workflow
// policy detectable (F-055).
//
// `workflow/policy.json` is gitignored runtime state, so the serving
// checkout's dirty-tree check cannot see it change. A hand edit — the
// documented arming path, or someone troubleshooting at 07:05 — leaves no
// trace beyond the file's own mtime, and nothing compares the running policy
// against the last one anybody meant to install.
//
// This records a fingerprint (sha256 + size + mtime) after a sanctioned
// install and compares it later. It never reads or writes policy CONTENT
// anywhere outside the policy file itself: the record holds a hash, not the
// policy.
//
// Usage:
//   node scripts/policy-fingerprint.js record [--note "<why>"]
//   node scripts/policy-fingerprint.js check [--json]
//   node scripts/policy-fingerprint.js show
//
// `record` is the final step of the sanctioned edit path (backup → validate →
// atomic mode-600 install → record). `check` exits 1 on drift and is run by
// release:check; workflow_health reports the same condition as
// runtime_policy_unrecorded.
//

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('../lib/runtime-paths');
const { validatePolicy } = require('../crm/lib/channel-policy');

const DEFAULT_POLICY_PATH = path.join(ROOT, 'workflow', 'policy.json');
const DEFAULT_RECORD_PATH = path.join(ROOT, 'runtime', 'state', 'policy-fingerprint.json');

function policyPath() {
  return path.resolve(process.env.RESORT_WORKFLOW_POLICY_PATH || DEFAULT_POLICY_PATH);
}

function recordPath() {
  return path.resolve(process.env.RESORT_POLICY_FINGERPRINT_PATH || DEFAULT_RECORD_PATH);
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

/** sha256 + size + mtime of the policy file. Content never leaves this function. */
function fingerprint(file = policyPath()) {
  const raw = fs.readFileSync(file);
  const stat = fs.statSync(file);
  return {
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    bytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
  };
}

function readRecord(file = recordPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`policy fingerprint record is unreadable: ${error.message}`);
  }
}

function writeRecord(entry, file = recordPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

/**
 * Policy↔registry autonomy agreement (F-024), computed lazily so importing
 * this module never drags the workflow registry (and with it the CRM stack)
 * into processes that only need the hash comparison.
 *
 * @returns {{status: 'ok'|'violations'|'unavailable', violations: string[], error?: string}}
 */
function agreementSummary(policy) {
  try {
    // eslint-disable-next-line global-require
    const { policyRegistryAgreementViolations } = require('../crm/lib/policy-registry-agreement');
    // eslint-disable-next-line global-require
    const { listDefinitions } = require('../crm/workflows/registry');
    const violations = policyRegistryAgreementViolations(policy, listDefinitions());
    return { status: violations.length ? 'violations' : 'ok', violations };
  } catch (error) {
    return { status: 'unavailable', violations: [], error: String(error.message).slice(0, 300) };
  }
}

function recordFingerprint({ note = null, file = policyPath(), target = recordPath() } = {}) {
  // Refuse to bless a policy the loader would reject — a fingerprint of an
  // invalid file would make the next check pass on something that cannot run.
  // The same bar applies to autonomy grants the registry does not account
  // for: a recorded fingerprint is the statement that somebody meant to
  // install exactly this policy, and an unaccounted grant is never that.
  const parsed = validatePolicy(JSON.parse(fs.readFileSync(file, 'utf8')));
  const agreement = agreementSummary(parsed);
  if (agreement.status !== 'ok') {
    const detail = agreement.status === 'violations'
      ? agreement.violations.join('; ')
      : `agreement check unavailable: ${agreement.error}`;
    throw new Error(`refusing to record a fingerprint — ${detail}`);
  }
  const entry = {
    ...fingerprint(file),
    policy_path: file,
    recorded_at: new Date().toISOString(),
    note,
  };
  writeRecord(entry, target);
  return entry;
}

/**
 * @returns {{status: 'match'|'drift'|'unrecorded'|'missing_policy', current: object|null, recorded: object|null}}
 */
function checkFingerprint({ file = policyPath(), target = recordPath() } = {}) {
  let current = null;
  try {
    current = fingerprint(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { status: 'missing_policy', current: null, recorded: readRecord(target) };
  }
  let agreement;
  try {
    agreement = agreementSummary(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    agreement = { status: 'unavailable', violations: [], error: String(error.message).slice(0, 300) };
  }
  const recorded = readRecord(target);
  if (!recorded) return { status: 'unrecorded', current, recorded: null, agreement };
  return {
    status: recorded.sha256 === current.sha256 ? 'match' : 'drift',
    current,
    recorded,
    agreement,
  };
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'record') {
    const entry = recordFingerprint({ note: option(args, '--note') });
    console.log(JSON.stringify({ ok: true, action: 'record', ...entry }, null, 2));
    return 0;
  }
  if (command === 'check' || command === 'show') {
    const result = checkFingerprint();
    const violations = result.agreement?.status === 'violations' ? result.agreement.violations : [];
    const payload = {
      ok: result.status === 'match' && !violations.length,
      action: command,
      status: result.status,
      agreement: result.agreement?.status || 'unavailable',
      agreement_violations: violations,
      current_sha256: result.current?.sha256 || null,
      recorded_sha256: result.recorded?.sha256 || null,
      recorded_at: result.recorded?.recorded_at || null,
      note: result.recorded?.note || null,
    };
    console.log(JSON.stringify(payload, null, 2));
    if (command === 'show') return 0;
    if (violations.length) {
      for (const violation of violations) {
        console.error(`policy-fingerprint: ${violation}`);
      }
      return 1;
    }
    if (result.status === 'match') return 0;
    if (result.status === 'unrecorded') {
      console.error('policy-fingerprint: no fingerprint recorded — run `node scripts/policy-fingerprint.js record` after confirming the installed policy is the intended one');
    } else if (result.status === 'drift') {
      console.error('policy-fingerprint: workflow/policy.json differs from the last recorded install — reconcile the edit, then re-record');
    } else {
      console.error('policy-fingerprint: workflow/policy.json is missing');
    }
    return 1;
  }
  console.error('usage: policy-fingerprint.js record [--note "<why>"] | check | show');
  return 2;
}

module.exports = { fingerprint, recordFingerprint, checkFingerprint, readRecord, writeRecord };

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`policy-fingerprint: ${error.message}`);
    process.exit(1);
  }
}
