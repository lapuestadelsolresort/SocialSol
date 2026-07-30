'use strict';

const connect = require('@databases/sqlite');
const { sql } = require('@databases/sqlite');
const { CRM_DB } = require('./config');

const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
]);

function lower(s) { return (s || '').toLowerCase().trim(); }

function domainOf(email) {
  const e = lower(email);
  const at = e.indexOf('@');
  if (at < 0) return '';
  return e.slice(at + 1);
}

async function openReadOnly() {
  // @databases/sqlite returns a Promise-style API; opens the db with WAL-aware reads.
  return connect(CRM_DB);
}

async function classifyCandidate(db, email) {
  const e = lower(email);
  if (!e) return { dedup_status: 'invalid', personal_email: false };

  const matches = await db.query(sql`
    SELECT id, email FROM contacts WHERE LOWER(email) = ${e} LIMIT 1
  `);
  if (matches.length > 0) {
    return {
      dedup_status: 'existing_email',
      personal_email: PERSONAL_DOMAINS.has(domainOf(e)),
      matched_contact_id: matches[0].id,
    };
  }

  const supps = await db.query(sql`
    SELECT email, reason FROM suppressions WHERE LOWER(email) = ${e} LIMIT 1
  `);
  if (supps.length > 0) {
    return {
      dedup_status: 'suppressed',
      personal_email: PERSONAL_DOMAINS.has(domainOf(e)),
      suppression_reason: supps[0].reason,
    };
  }

  const dom = domainOf(e);
  if (dom && !PERSONAL_DOMAINS.has(dom)) {
    const domainMatches = await db.query(sql`
      SELECT id, email FROM contacts WHERE LOWER(email) LIKE ${'%@' + dom} LIMIT 5
    `);
    if (domainMatches.length > 0) {
      return {
        dedup_status: 'existing_domain',
        personal_email: false,
        matched_contact_ids: domainMatches.map(r => r.id),
        matched_emails: domainMatches.map(r => r.email),
      };
    }
  }

  return {
    dedup_status: 'new',
    personal_email: PERSONAL_DOMAINS.has(domainOf(e)),
  };
}

const PERSONA_FIT_RANK = { strong: 3, moderate: 2, weak: 1, none: 0 };

function sortAndCap(rows, cap) {
  const sorted = [...rows].sort((a, b) => {
    const qs = (b.quality_score || 0) - (a.quality_score || 0);
    if (qs !== 0) return qs;
    const fb = PERSONA_FIT_RANK[b.persona_fit || 'none'] || 0;
    const fa = PERSONA_FIT_RANK[a.persona_fit || 'none'] || 0;
    return fb - fa;
  });
  return sorted.slice(0, cap);
}

module.exports = { openReadOnly, classifyCandidate, sortAndCap, domainOf, PERSONAL_DOMAINS };
