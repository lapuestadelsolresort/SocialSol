'use strict';

// Guards the shape of the three LaunchAgent entry points (F-066). They are
// shell, so the regression is expressed over the committed text: the weekly
// scripts must call a real CLI verb, must not mask failures, and all three
// must report to the job watchdog.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const read = name => fs.readFileSync(path.join(SCRIPTS, name), 'utf8');

for (const name of ['weekly-followup.sh', 'weekly-summary.sh']) {
  test(`${name} runs one gateway agent turn and cannot hide its failure`, () => {
    const text = read(name);
    assert.doesNotMatch(text, /openclaw run\b/, 'openclaw has no `run` verb');
    assert.match(text, /"\$OPENCLAW" agent --agent "\$AGENT_ID" --message "\$PROMPT" --timeout "\$TIMEOUT_SECONDS" --json/);
    assert.doesNotMatch(text, /\|\|\s*log\b/, 'a masked failure exits 0 having done nothing');
    assert.match(text, /^set -euo pipefail$/m);
    assert.match(text, /jq -er '\.monitoring\.slack_account'/, 'the account is read from config, not guessed');
    assert.match(text, /--account \$SLACK_ACCOUNT --target channel:\$TRACKER_CHANNEL/, 'tracker posts name the account and channel');
    assert.match(text, /NO_REPLY/);
  });
}

for (const [name, job] of [
  ['scan-channels.sh', 'resort-paloma-scan'],
  ['weekly-followup.sh', 'resort-paloma-followup'],
  ['weekly-summary.sh', 'resort-paloma-summary'],
]) {
  test(`${name} reports ${job} to the job watchdog`, () => {
    const text = read(name);
    assert.match(text, new RegExp(`PALOMA_JOB_NAME="${job}"`));
    assert.match(text, /source "\$SCRIPT_DIR\/job-status\.sh"/);
    assert.match(text, /^paloma_job_status_trap$/m);
  });
}

test('the watchdog manifest expects all three Paloma jobs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'launchagents', 'service-manifest.json'), 'utf8'));
  for (const job of ['resort-paloma-scan', 'resort-paloma-followup', 'resort-paloma-summary']) {
    assert.ok(manifest.watchdog[job], `${job} missing from watchdog`);
    assert.ok(Number(manifest.watchdog[job].max_age_hours) > 0);
  }
  assert.equal(manifest.watchdog['resort-paloma-scan'].max_age_hours, 9);
});

test('job-status.sh records through the shared job_health helper', () => {
  const text = read('job-status.sh');
  assert.match(text, /from job_health import record/);
  assert.match(text, /paloma_job_status_on_exit/);
});
