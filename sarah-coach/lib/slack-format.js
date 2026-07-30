'use strict';
//
// slack-format.js — Slack message builders for sarah-coach.
//
// Pure functions returning strings. Code-fences the draft body so Sarah
// can triple-click select. If the inbound came from a screenshot, an
// OCR preamble quotes the extracted text first so Sarah can confirm it
// matches the image before she copies the draft.

function buildDraftMessage({ inboundText, draftText, isFromImage }) {
  const lines = ['🪶 Draft for inbound message'];
  if (isFromImage) {
    lines.push('');
    lines.push('Read this from your screenshot:');
    // Slack quote block: prefix every non-empty line with `> `.
    const quoted = String(inboundText || '')
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    lines.push(quoted);
  }
  lines.push('');
  // Triple-backtick fenced block — Slack renders as monospace with
  // triple-click select-all behavior.
  lines.push('```');
  lines.push(draftText);
  lines.push('```');
  lines.push('');
  lines.push('Reply `!sent` if you sent as-is, or paste your edit + `!edit` to log it.');
  return lines.join('\n');
}

function buildVoiceServiceDownPost(reason) {
  return `❌ Voice Service unreachable: ${reason}. Try again in a minute, or check \`openclaw doctor\`.`;
}

function buildCouldntReadWarning() {
  return '⚠️ I couldn\'t read anything in that message — try pasting the inbound text directly or uploading a clearer screenshot.';
}

function buildGenericDraftFailure() {
  return '⚠️ Couldn\'t generate a draft — see #ops.';
}

function buildNotAuthorized() {
  return '❌ Not authorized.';
}

function buildSentAck() {
  return '✅ Logged.';
}

function buildEditAck(editDistance) {
  return `✅ Logged (${editDistance} chars edited).`;
}

function buildNoDraftFoundForThread() {
  return '⚠️ Couldn\'t find the draft for this thread.';
}

module.exports = {
  buildDraftMessage,
  buildVoiceServiceDownPost,
  buildCouldntReadWarning,
  buildGenericDraftFailure,
  buildNotAuthorized,
  buildSentAck,
  buildEditAck,
  buildNoDraftFoundForThread,
};
