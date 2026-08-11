'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchAllBookings,
  fetchFullOccupancy,
  isBlock,
  reservationDisplayName,
  selectFullOccupancy,
  selectFutureOccupancy,
} = require('../scripts/lib/ownerrez-occupancy');

const window = { start: '2026-08-10', end: '2026-09-07' };

test('full occupancy includes guestless reservations and every active block type', () => {
  const bookings = [
    { id: 1, guest_id: 10, type: 'booking', status: 'active', arrival: '2026-08-12', departure: '2026-08-15' },
    { id: 2, type: 'booking', title: 'Manual direct deal', status: 'active', arrival: '2026-08-16', departure: '2026-08-18' },
    { id: 3, type: 'block', title: 'Raffle', is_block: true, status: 'active', arrival: '2026-08-20', departure: '2026-08-22' },
    { id: 4, type: 'linked_availability', is_block: true, status: 'active', arrival: '2026-08-23', departure: '2026-08-25' },
    { id: 5, guest_id: 11, type: 'booking', status: 'canceled', arrival: '2026-08-12', departure: '2026-08-15' },
    { id: 6, type: 'block', status: 'active', arrival: '2026-10-01', departure: '2026-10-03' },
  ];

  assert.deepEqual(selectFullOccupancy(bookings, window).map(booking => booking.id), [1, 2, 3, 4]);
});

test('full occupancy paginates without applying a since_utc, guest_id, or type filter', async () => {
  const calls = [];
  const pages = [
    [
      { id: 1, type: 'booking', status: 'active', arrival: '2026-08-12', departure: '2026-08-15' },
      { id: 2, type: 'block', status: 'active', arrival: '2026-08-16', departure: '2026-08-18' },
    ],
    [
      { id: 3, type: 'linked_availability', status: 'active', arrival: '2026-08-20', departure: '2026-08-22' },
    ],
  ];
  const apiGet = async (endpoint, params) => {
    calls.push({ endpoint, params });
    return { items: pages.shift() };
  };

  const result = await fetchFullOccupancy(apiGet, {
    ...window,
    propertyIds: '1,2',
    pageSize: 2,
    pageDelayMs: 0,
  });

  assert.deepEqual(result.map(booking => booking.id), [1, 2, 3]);
  assert.deepEqual(calls, [
    { endpoint: 'bookings', params: { property_ids: '1,2', limit: '2', offset: '0' } },
    { endpoint: 'bookings', params: { property_ids: '1,2', limit: '2', offset: '2' } },
  ]);
  assert.equal('since_utc' in calls[0].params, false);
});

test('display labels prefer a resolved guest or local title and identify anonymous blocks', () => {
  assert.equal(
    reservationDisplayName({ guest_id: 10, title: 'Fallback' }, { '10': 'Guest Example' }),
    'Guest Example'
  );
  assert.equal(reservationDisplayName({ title: 'Manual hold' }), 'Manual hold');
  assert.equal(
    reservationDisplayName({ type: 'linked_availability', is_block: true }),
    'Block (linked availability)'
  );
  assert.equal(isBlock({ type: 'booking', is_block: false }), false);
  assert.equal(isBlock({ type: 'owner', is_block: true }), true);
  assert.equal(isBlock({ type: 'owner', is_block: false }), false);
});

test('full occupancy rejects invalid or reversed windows', () => {
  assert.throws(
    () => selectFullOccupancy([], { start: '2026-02-30', end: '2026-03-01' }),
    /valid calendar date/
  );
  assert.throws(
    () => selectFullOccupancy([], { start: '2026-09-01', end: '2026-08-01' }),
    /end must be on or after start/
  );
});

test('future inventory includes active unpriced bookings and blocks but excludes linked history', async () => {
  const pages = [
    [
      { id: 1, type: 'booking', status: 'active', arrival: '2027-01-01', departure: '2027-01-04' },
      { id: 2, type: 'block', status: 'active', arrival: '2026-09-01', departure: '2026-09-02' },
    ],
    [{ id: 3, type: 'booking', status: 'canceled', arrival: '2027-02-01', departure: '2027-02-02' }],
  ];
  const calls = [];
  const apiGet = async (endpoint, params) => {
    calls.push({ endpoint, params });
    return { items: pages.shift() };
  };
  const all = await fetchAllBookings(apiGet, { propertyIds: '1', pageSize: 2, pageDelayMs: 0 });
  assert.deepEqual(all.map(item => item.id), [1, 2, 3]);
  assert.deepEqual(selectFutureOccupancy(all, { asOf: '2026-08-10' }).map(item => item.id), [2, 1]);
  assert.equal(calls.some(call => Object.hasOwn(call.params, 'since_utc')), false);
});
