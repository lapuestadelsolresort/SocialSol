'use strict';
//
// thread-lookup.js — given a Slack thread_ts, find the active drafted row.
//
// Each Regina draft is posted as its own top-level message; outreach_sends
// stores the draft's ts in slack_thread_ts. Sarah's threaded replies in that
// draft's thread carry thread_ts = <draft's ts>, so the lookup is direct.

const { sql } = require('@databases/sqlite');

async function findDraftByThread(db, threadTs, { agent = 'regina' } = {}) {
  const rows = await db.query(sql`
    SELECT s.*, c.name AS contact_name, c.email AS contact_email,
           camp.owning_agent
    FROM outreach_sends s
    JOIN outreach_campaigns camp ON camp.id = s.campaign_id
    LEFT JOIN contacts c ON c.id = s.contact_id
    WHERE s.slack_thread_ts = ${threadTs}
      AND camp.owning_agent = ${agent}
    ORDER BY s.id DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

async function findDraftedByThread(db, threadTs, { agent = 'regina' } = {}) {
  const row = await findDraftByThread(db, threadTs, { agent });
  if (!row) return null;
  if (row.status !== 'drafted') return { ...row, _stale_status: row.status };
  return row;
}

module.exports = { findDraftByThread, findDraftedByThread };
