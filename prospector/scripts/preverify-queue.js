#!/usr/bin/env node
'use strict';

/**
 * Verify queued campaign recipients before composition.
 *
 * stdout is one JSON object for automation. Operational detail goes to stderr
 * so callers can parse stdout without scraping log lines.
 */

const fs = require('node:fs');
const path = require('node:path');
const createDB = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const { DB_PATH, secretPath } = require('../../lib/runtime-paths');
const { isRoleBasedEmail, verifyEmail } = require('../lib/email-verification');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const ZB_SECRET_PATH = secretPath('zerobounce.json');

function log(message) {
  process.stderr.write(`[preverify-queue] ${message}\n`);
}

function loadJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function parseArgs(argv) {
  const options = {
    campaignSlug: argv[0] || null,
    targetValid: null,
    maxChecks: null,
    dryRun: false,
  };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--target-valid') options.targetValid = Number(argv[++i]);
    else if (argv[i] === '--max') options.maxChecks = Number(argv[++i]);
    else if (argv[i] === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!options.campaignSlug) {
    throw new Error('Usage: preverify-queue.js <campaign_slug> [--target-valid N] [--max N] [--dry-run]');
  }
  return options;
}

async function preverifyQueue(options, dependencies = {}) {
  const config = dependencies.config || loadJson(CONFIG_PATH, {});
  const policy = config.email_verification || {};
  const targetValid = Number.isFinite(options.targetValid)
    ? Math.max(0, options.targetValid)
    : Math.max(0, Number(policy.queue_target_verified ?? 20));
  const maxChecks = Number.isFinite(options.maxChecks)
    ? Math.max(0, options.maxChecks)
    : Math.max(0, Number(policy.max_per_daily_run ?? 25));
  const apiKey = dependencies.apiKey ?? loadJson(ZB_SECRET_PATH, {})?.api_key ?? null;
  const db = dependencies.db || createDB(DB_PATH);
  const ownsDb = !dependencies.db;

  try {
    const [campaign] = await db.query(sql`
      SELECT id, slug, status, COALESCE(allow_role_emails, 0) AS allow_role_emails
      FROM outreach_campaigns WHERE slug = ${options.campaignSlug} LIMIT 1
    `);
    if (!campaign || campaign.status !== 'active') {
      return {
        ok: false,
        reason: campaign ? 'campaign_not_active' : 'campaign_not_found',
        campaign_slug: options.campaignSlug,
      };
    }

    const eligibleRows = await db.query(sql`
      SELECT c.id, c.email, COALESCE(c.email_status, 'unknown') AS email_status,
             cc.attached_at, cc.id AS campaign_contact_id
      FROM campaign_contacts cc
      JOIN contacts c ON c.id = cc.contact_id
      WHERE cc.campaign_id = ${campaign.id}
        AND c.email IS NOT NULL AND trim(c.email) != ''
        AND COALESCE(c.do_not_contact, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM suppressions s WHERE lower(s.email) = lower(c.email)
        )
        AND NOT EXISTS (
          SELECT 1 FROM outreach_sends os
          WHERE os.contact_id = cc.contact_id
            AND os.campaign_id = cc.campaign_id
            AND os.status != 'cancelled'
        )
      ORDER BY cc.attached_at ASC, cc.id ASC
    `);

    const verifiedAvailable = eligibleRows.filter((row) => row.email_status === 'verified').length;
    const needed = Math.max(0, targetValid - verifiedAvailable);
    const candidates = eligibleRows
      .filter((row) => !new Set(['verified', 'invalid', 'bounced', 'risky']).has(row.email_status))
      .sort((a, b) => {
        const roleDelta = Number(isRoleBasedEmail(a.email)) - Number(isRoleBasedEmail(b.email));
        return roleDelta || String(a.attached_at).localeCompare(String(b.attached_at)) || a.campaign_contact_id - b.campaign_contact_id;
      })
      .slice(0, maxChecks);

    if (options.dryRun || needed === 0 || maxChecks === 0) {
      return {
        ok: true,
        dry_run: Boolean(options.dryRun),
        campaign_slug: campaign.slug,
        target_valid: targetValid,
        verified_available_before: verifiedAvailable,
        needed,
        candidates_available: candidates.length,
        checked: 0,
        verified: 0,
        risky: 0,
        invalid: 0,
        unknown: 0,
      };
    }

    const summary = {
      ok: true,
      dry_run: false,
      campaign_slug: campaign.slug,
      target_valid: targetValid,
      verified_available_before: verifiedAvailable,
      needed,
      candidates_available: candidates.length,
      checked: 0,
      verified: 0,
      risky: 0,
      invalid: 0,
      unknown: 0,
      reasons: {},
    };

    for (const contact of candidates) {
      if (summary.verified >= needed) break;
      const result = await verifyEmail(contact.email, {
        apiKey,
        allowRoleEmails:
          policy.allow_role_emails === true && Boolean(campaign.allow_role_emails),
        allowCatchAll: policy.allow_catch_all === true,
        failClosed: policy.fail_closed !== false,
        resolveMx: dependencies.resolveMx,
        fetchImpl: dependencies.fetchImpl,
        logger: log,
      });
      // A provider-wide outage is different from an address-level unknown:
      // stop the run without poisoning the remaining queue. Address-level
      // unknown/MX failures become risky so the next daily run does not spend
      // another credit retrying the same greylisted mailbox indefinitely.
      if (!result.ok && new Set(['verifier_unavailable', 'verifier_error']).has(result.reason)) {
        summary.provider_unavailable = true;
        summary.reasons[result.reason] = (summary.reasons[result.reason] || 0) + 1;
        break;
      }
      const emailStatus = result.ok
        ? 'verified'
        : (result.emailStatus === 'unknown' ? 'risky' : (result.emailStatus || 'risky'));
      await db.query(sql`
        UPDATE contacts
        SET email_status = ${emailStatus}, updated_at = datetime('now')
        WHERE id = ${contact.id} AND lower(email) = lower(${contact.email})
      `);
      summary.checked++;
      summary[emailStatus] = (summary[emailStatus] || 0) + 1;
      if (!result.ok) {
        summary.reasons[result.reason] = (summary.reasons[result.reason] || 0) + 1;
      }
    }

    summary.verified_available_after = verifiedAvailable + summary.verified;
    summary.target_met = summary.verified_available_after >= targetValid;
    return summary;
  } finally {
    if (ownsDb) await db.dispose();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await preverifyQueue(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[preverify-queue] FATAL: ${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, preverifyQueue };
