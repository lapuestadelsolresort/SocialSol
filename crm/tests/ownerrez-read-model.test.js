'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerrezOccupancyRead } = require('../workflows/read-models');

test('OwnerRez read model returns the titled primary entry ahead of a later typed booking', async () => {
  const commands = [];
  const records = [
    {
      id: 101, type: 'block', is_block: true, status: 'active',
      arrival: '2026-09-03', departure: '2026-09-07',
      title: 'Sherry bachelor and bachelorette party',
      property: { name: 'Puesta del Sol Resort' },
    },
    {
      id: 102, type: 'linked_availability', is_block: true, status: 'active',
      arrival: '2026-09-03', departure: '2026-09-07',
      property: { name: 'Villa Crab | Villa 4' },
    },
    {
      id: 103, type: 'booking', is_block: false, status: 'active',
      arrival: '2026-12-03', departure: '2026-12-07',
      guest_id: 20, guest_name: 'Eric Candelario', adults: 10, children: 1,
      property: { name: 'Villa Crab | Villa 4' },
    },
  ];

  const output = await ownerrezOccupancyRead.steps[0].run({
    db: null,
    run: { id: 'run-ownerrez-read' },
    input: { start: '2026-08-12', end: '2026-12-10' },
    services: {
      async runCommand(command) {
        commands.push(command);
        return { stdout: JSON.stringify(records) };
      },
    },
    store: {
      async createEvidence() {
        return { id: 'evidence-ownerrez', observedAt: '2026-08-12T12:00:00.000Z', payloadHash: 'payload-hash' };
      },
    },
    stepKey: 'read_authority',
  });

  assert.deepEqual(commands[0].args.slice(-5), [
    '--start', '2026-08-12', '--end', '2026-12-10', '--enriched-json',
  ]);
  assert.equal(output.authority, 'OwnerRez');
  assert.equal(output.primaryCalendarEntryCount, 2);
  assert.equal(output.nextCalendarEntry.id, 101);
  assert.equal(output.nextCalendarEntry.title, 'Sherry bachelor and bachelorette party');
  assert.equal(output.nextCalendarEntry.calendar_entry_kind, 'manual_calendar_entry');
  assert.equal(output.primaryCalendarEntries[1].display_name, 'Eric Candelario');
  assert.equal(output.primaryCalendarEntries[1].calendar_entry_kind, 'typed_booking');
  assert.match(output.calendarSemantics.manualBlockRule, /does not prove owner use/);
});
