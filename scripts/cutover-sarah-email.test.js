'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { main } = require('./cutover-sarah-email');

test('Sarah email cutover fails provider preflight before production mutations', async () => {
  const calls = [];
  await assert.rejects(main(['--confirm-production', '--channel-id', 'CSARAH123'], {
    run: (program, args) => {
      calls.push([program, ...args]);
      if (calls.length === 2) throw new Error('OwnerRez messaging denied');
      return { stdout: '{}' };
    },
    configure: () => assert.fail('policy must not change'),
    installLaunchAgent: () => assert.fail('LaunchAgent must not install'),
    retireLaunchAgent: () => assert.fail('LaunchAgent must not retire'),
    slackProbe: () => assert.fail('socket probe must follow provider preflights'),
  }), /messaging denied/);
  assert.match(calls[0].join(' '), /verify-gmail-send-scope/);
  assert.match(calls[1].join(' '), /verify-ownerrez-messaging-scope/);
});

test('Sarah email cutover installs the unified poller, retires the scanner, and verifies Slack', async () => {
  const calls = [];
  const installs = [];
  const retires = [];
  const result = await main(['--confirm-production', '--channel-id', 'CSARAH123'], {
    run: (program, args) => {
      calls.push([program, ...args]);
      if (args[0] === 'message') return { stdout: JSON.stringify({ payload: { result: { messageId: '100.1' } } }) };
      return { stdout: '{}' };
    },
    configure: args => ({ mode: 'production', args }),
    installLaunchAgent: name => { installs.push(name); return { label: name.replace('.plist', '') }; },
    retireLaunchAgent: name => { retires.push(name); return { label: name.replace('.plist', ''), retired: true }; },
    slackProbe: () => ({ accountId: 'ig-drafts', connected: true, probeOk: true }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(installs, ['com.lapuestadelsolresort.gmail-reply-forwarder.plist']);
  assert.deepEqual(retires, ['com.lapuestadelsolresort.inbound-email-scanner.plist']);
  assert.ok(calls.some(call => call.join(' ').includes('ai.openclaw.gateway')));
  assert.equal(result.welcomeTs, '100.1');
});
