'use strict';

const path = require('node:path');

const SOUL_BLOCK_START = '<!-- PALOMA_ALL_CHANNEL_MONITORING:START -->';
const SOUL_BLOCK_END = '<!-- PALOMA_ALL_CHANNEL_MONITORING:END -->';

function requiredString(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function slackChannelId(value) {
  const normalized = String(value || '').replace(/^channel:/, '').trim();
  if (!/^[CG][A-Z0-9]{8,}$/.test(normalized)) return '';
  return normalized;
}

function joinedChannels(groups) {
  if (!Array.isArray(groups)) throw new Error('Slack group directory must be an array');
  const channels = [];
  for (const group of groups) {
    const raw = group?.raw || {};
    const id = slackChannelId(group?.id || raw.id);
    const isMember = raw.is_member ?? group?.is_member ?? false;
    const isArchived = raw.is_archived ?? group?.is_archived ?? group?.archived ?? false;
    if (!id || !isMember || isArchived) continue;
    channels.push({ id, name: String(group?.name || raw.name || id) });
  }
  return [...new Map(channels.map(channel => [channel.id, channel])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function monitoredChannelConfig(currentChannels, groups) {
  const next = structuredClone(currentChannels || {});
  const joined = joinedChannels(groups);
  for (const channel of joined) {
    next[channel.id] = {
      ...(next[channel.id] || {}),
      enabled: true,
      requireMention: false,
    };
  }
  return { channels: next, joined };
}

function monitorPrompt({ accountId, databasePath, trackerChannelId, lookbackMinutes = 60 }) {
  const account = requiredString(accountId, 'Paloma Slack account id');
  const database = path.resolve(requiredString(databasePath, 'Paloma task database path'));
  const tracker = slackChannelId(trackerChannelId);
  if (!tracker) throw new Error('Paloma tracker Slack channel id is invalid');
  const lookback = Number(lookbackMinutes);
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > 1440) {
    throw new Error('Paloma monitoring lookback must be an integer from 1 to 1440 minutes');
  }
  return `PALOMA_ALL_CHANNEL_MONITOR

This is Paloma's periodic reconciliation backstop. Real-time Slack events are the primary path; this scan must catch any event that was dropped, skipped, or misclassified.

1. Discover scope dynamically. Run:
   openclaw directory groups list --channel slack --account ${account} --json --limit 500
   Scan every non-archived channel where raw.is_member (or is_member) is true. Never rely on a static channel list and never skip a joined channel because it is unfamiliar or not named in SOUL.md.
2. Run openclaw directory self --channel slack --account ${account} --json and ignore messages authored by Paloma herself or by other bots. Ignore Slack system subtypes such as channel renames.
3. Use ${database} and its existing tasks, task_updates, and scan_state schema. For a channel with no scan_state row, begin ${lookback} minutes before the scan start so the initial run reconciles recent work without backfilling the full channel history.
4. Read every message newer than that channel's checkpoint with openclaw message read --channel slack --account ${account} --target channel:<CHANNEL_ID> --after <SLACK_TS> --limit 100 --json. Process messages oldest first. If payload.hasMore is true, page until every message after the checkpoint has been inspected.
5. Treat every human-authored message in every joined channel as a classification candidate. A genuine task includes a report of work needed, a request to fix/clean/buy/check/do something, or one person assigning or asking another person to act. A direct @mention followed by an imperative request is a task candidate even when Paloma is not mentioned. This rule applies in villa, housekeeper, maintenance, general, tracker, and any future joined channels.
6. Before inserting, check tasks.source_ts for exact idempotency. For each new task, use the database's exact current column names, preserve the original Spanish, add an English translation, record source_channel/source_ts/thread_ts and reporter, assign the explicitly mentioned staff member when present, and use open status unless the message itself proves completion. Post exactly one brief bilingual acknowledgment in the original Slack thread. Do not acknowledge duplicates.
7. Also reconcile human thread replies that clearly change an existing task's status, recording task_updates. Do not turn greetings, thanks, ordinary discussion, or acknowledgments into tasks, and do not post on non-task chatter.
8. Advance a channel's scan_state.last_scanned_ts to the greatest fully inspected Slack timestamp only after all messages through that timestamp were processed successfully. Upsert updated_at=datetime('now'). On any read, database, or Slack-write failure, leave the affected checkpoint unchanged so the next scan retries safely.
9. When every joined channel was inspected successfully, finish with exactly NO_REPLY. On a partial failure, send exactly one concise alert to channel:${tracker} with openclaw message send --channel slack --account ${account} --target channel:${tracker} --message <FAILURE_SUMMARY>, naming the failing channel and operation, then finish with exactly NO_REPLY. Never claim a clean scan after a partial failure.`;
}

function durationMilliseconds(value) {
  const match = String(value || '').trim().match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error('Paloma monitor interval must use ms, s, m, or h');
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Number(match[1]) * multipliers[match[2]];
}

function monitorCronConfig({
  accountId, databasePath, trackerChannelId, every = '10m', timeoutSeconds = 300, lookbackMinutes = 60,
}) {
  const interval = requiredString(every, 'Paloma monitor interval');
  const timeout = Number(timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 1800) {
    throw new Error('Paloma monitor timeout must be an integer from 30 to 1800 seconds');
  }
  const tracker = slackChannelId(trackerChannelId);
  if (!tracker) throw new Error('Paloma tracker Slack channel id is invalid');
  return {
    name: 'paloma-all-channel-monitor',
    description: 'Reconcile tasks from every active Slack channel joined by Paloma',
    every: interval,
    everyMs: durationMilliseconds(interval),
    sessionTarget: 'isolated',
    message: monitorPrompt({ accountId, databasePath, trackerChannelId: tracker, lookbackMinutes }),
    timeoutSeconds: timeout,
    delivery: {
      mode: 'none',
      channel: 'slack',
      to: `channel:${tracker}`,
      accountId: requiredString(accountId, 'Paloma Slack account id'),
    },
    failureAlert: {
      after: 1,
      channel: 'slack',
      to: `channel:${tracker}`,
      cooldownMs: 600_000,
      includeSkipped: false,
      mode: 'announce',
      accountId: requiredString(accountId, 'Paloma Slack account id'),
    },
  };
}

function cronMatches(job, expected, agentId) {
  return Boolean(job
    && job.agentId === agentId
    && job.name === expected.name
    && job.description === expected.description
    && job.enabled === true
    && job.schedule?.kind === 'every'
    && job.schedule.everyMs === expected.everyMs
    && job.sessionTarget === expected.sessionTarget
    && job.payload?.kind === 'agentTurn'
    && job.payload.message === expected.message
    && job.payload.timeoutSeconds === expected.timeoutSeconds
    && job.delivery?.mode === expected.delivery.mode
    && job.delivery.channel === expected.delivery.channel
    && job.delivery.to === expected.delivery.to
    && job.delivery.accountId === expected.delivery.accountId
    && job.failureAlert?.after === expected.failureAlert.after
    && job.failureAlert.channel === expected.failureAlert.channel
    && job.failureAlert.to === expected.failureAlert.to
    && job.failureAlert.cooldownMs === expected.failureAlert.cooldownMs
    && job.failureAlert.includeSkipped === expected.failureAlert.includeSkipped
    && job.failureAlert.mode === expected.failureAlert.mode
    && job.failureAlert.accountId === expected.failureAlert.accountId);
}

function soulMonitoringBlock({ accountId, databasePath }) {
  const account = requiredString(accountId, 'Paloma Slack account id');
  const database = path.resolve(requiredString(databasePath, 'Paloma task database path'));
  return `${SOUL_BLOCK_START}
## Always-on Slack task monitoring

- Slack account: \`${account}\`. Task database: \`${database}\`.
- Every inbound human message in every Slack channel Paloma has joined must be evaluated immediately, whether or not Paloma is mentioned. Unmentioned does not mean optional or invisible.
- Scope follows live Slack membership. Villa, housekeeping, maintenance, general, tracker, and future joined channels all use the same detection rules.
- A manager or teammate directly assigning work to another person is a task. In particular, an @mention of a staff member followed by an action request must be logged even when Paloma is not addressed.
- For a new task, check \`tasks.source_ts\` first, insert using the database's exact current schema, and post one brief bilingual acknowledgment in the source thread. Prefer the explicitly mentioned assignee; do not silently substitute a channel-default assignee.
- Reconcile clear status replies against the existing task and record the update. Ignore casual chatter and return only \`NO_REPLY\` when the message truly contains no new task or task-status change.
- Never say that Paloma only sees messages during active sessions or when pinged. Real-time unmentioned events are enabled, and the periodic all-membership scan is the recovery path.
${SOUL_BLOCK_END}`;
}

function mergeSoulMonitoringBlock(current, block) {
  const text = String(current || '').replace(/\s+$/, '');
  const start = text.indexOf(SOUL_BLOCK_START);
  const end = text.indexOf(SOUL_BLOCK_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error('Paloma SOUL.md contains a malformed managed monitoring block');
  }
  if (start === -1) return `${text}\n\n${block}\n`;
  const suffix = text.slice(end + SOUL_BLOCK_END.length).replace(/^\s+/, '');
  const prefix = text.slice(0, start).replace(/\s+$/, '');
  return `${prefix}\n\n${block}${suffix ? `\n\n${suffix}` : ''}\n`;
}

module.exports = {
  SOUL_BLOCK_END,
  SOUL_BLOCK_START,
  cronMatches,
  durationMilliseconds,
  joinedChannels,
  mergeSoulMonitoringBlock,
  monitorCronConfig,
  monitorPrompt,
  monitoredChannelConfig,
  slackChannelId,
  soulMonitoringBlock,
};
