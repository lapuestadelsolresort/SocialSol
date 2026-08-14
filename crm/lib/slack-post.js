'use strict';
//
// slack-post.js — canonical Slack poster wrapping the openclaw CLI.
//
// Replaces the duplicated patterns at:
//   - prospector/research/scripts/lib/slack.js  (returns {ok, stdout}, no ts parse, no threadTs)
//   - prospector/composer.js postToSlack inline (parses messageId, no threadTs)
//   - prospector/orchestrator.js postSlackThreadReply inline (uses --reply-to, parses raw)
//
// Single canonical surface for R5+ callers (Regina now; Paulina's three call
// sites can migrate later, out of R5 scope).
//
// Channel-id format is `channel:<SLACK_CHANNEL_ID>`. Pass the raw channel id;
// this library prepends the `channel:` prefix.
//
// JSON response shape (verified at prospector/composer.js:312):
//   { payload: { result: { messageId: '1741234567.123456' } } }

const { execFile } = require('child_process');

const OPENCLAW = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const DEFAULT_ACCOUNT = process.env.OPENCLAW_SLACK_ACCOUNT || '';

/**
 * Post a message to a Slack channel via the openclaw CLI.
 *
 * @param {string} channelId  Slack channel id. The library
 *                            prepends 'channel:' for the --target arg.
 * @param {string} message    Message body (Slack markdown OK).
 * @param {object} [opts]
 * @param {string} [opts.threadTs]  If set, posts as a threaded reply to this ts.
 * @param {string} [opts.account]   Slack account id; defaults to 'ig-drafts'.
 * @param {boolean} [opts.dryRun]   If true, --dry-run (no actual post).
 * @param {object} [opts.presentation] Portable message presentation (buttons, context, dividers).
 * @returns {Promise<{ok: boolean, ts: string|null, channelId: string,
 *                    raw: object|null, error: string|null,
 *                    stderr: string|null}>}
 */
function postToChannel(channelId, message, opts = {}) {
  const {
    threadTs = null, account = DEFAULT_ACCOUNT, dryRun = false, presentation = null,
  } = opts;
  if (!channelId || !account) {
    return Promise.resolve({
      ok: false,
      ts: null,
      channelId,
      raw: null,
      error: 'Slack integration is not configured',
      stderr: null,
    });
  }

  const args = [
    'message', 'send',
    '--channel', 'slack',
    '--account', account,
    '--target', `channel:${channelId}`,
    '--message', message,
    '--json',
  ];
  if (threadTs) args.push('--reply-to', String(threadTs));
  if (presentation) args.push('--presentation', JSON.stringify(presentation));
  if (dryRun) args.push('--dry-run');

  return new Promise((resolve) => {
    execFile(OPENCLAW, args, {
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          ts: null,
          channelId,
          raw: null,
          error: String(err.message || err),
          stderr: String(stderr || ''),
        });
        return;
      }
      let raw = null;
      try {
        raw = JSON.parse(String(stdout || ''));
      } catch (e) {
        resolve({
          ok: false,
          ts: null,
          channelId,
          raw: null,
          error: `parse_error: ${e.message}`,
          stderr: String(stderr || ''),
        });
        return;
      }
      const ts = (raw && raw.payload && raw.payload.result && raw.payload.result.messageId) || null;
      resolve({
        ok: !dryRun ? Boolean(ts) : true, // dry-run never returns a real ts
        ts,
        channelId,
        raw,
        error: null,
        stderr: null,
      });
    });
  });
}

module.exports = { postToChannel, OPENCLAW, DEFAULT_ACCOUNT };
