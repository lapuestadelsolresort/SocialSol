'use strict';

const DEFAULT_PROPERTY_IDS = '455776,456957,456958,456959,456960,456961,456962,456963';

function validateDate(date, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error(`${label} must be a date in YYYY-MM-DD format`);
  }

  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label} is not a valid calendar date`);
  }
}

/**
 * Select every active OwnerRez reservation or block that touches the window.
 * guest_id and type are deliberately not eligibility criteria: availability
 * must include manual reservations, owner blocks, quote holds, and linked
 * availability records as well as conventional guest bookings.
 */
function selectFullOccupancy(bookings, { start, end }) {
  validateDate(start, 'start');
  validateDate(end, 'end');
  if (end < start) throw new Error('end must be on or after start');

  return (bookings || [])
    .filter(booking =>
      booking?.status === 'active' &&
      typeof booking.arrival === 'string' &&
      typeof booking.departure === 'string' &&
      booking.departure >= start &&
      booking.arrival <= end
    )
    .sort((left, right) =>
      left.arrival.localeCompare(right.arrival) ||
      left.departure.localeCompare(right.departure) ||
      String(left.id || '').localeCompare(String(right.id || ''))
    );
}

/**
 * Download the complete booking/block list and then select the active window.
 * Do not add since_utc here: this is the source for occupancy and availability,
 * not an incremental CRM/contact query.
 */
async function fetchFullOccupancy(apiGet, {
  start,
  end,
  propertyIds = DEFAULT_PROPERTY_IDS,
  pageSize = 100,
  pageDelayMs = 300,
} = {}) {
  if (typeof apiGet !== 'function') throw new Error('apiGet must be a function');
  validateDate(start, 'start');
  validateDate(end, 'end');
  if (end < start) throw new Error('end must be on or after start');

  const allBookings = [];
  let offset = 0;

  while (true) {
    const result = await apiGet('bookings', {
      property_ids: propertyIds,
      limit: String(pageSize),
      offset: String(offset),
    });
    const items = result.items || [];
    allBookings.push(...items);

    if (items.length < pageSize) break;
    offset += pageSize;
    if (pageDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  return selectFullOccupancy(allBookings, { start, end });
}

/**
 * Resolve booking guest names from OwnerRez itself. A failed individual guest
 * lookup remains explicitly unresolved; callers must not fill the gap from CRM
 * contacts or model memory.
 */
async function fetchGuestNames(apiGet, bookings, { delayMs = 150 } = {}) {
  if (typeof apiGet !== 'function') throw new Error('apiGet must be a function');
  const guestIds = [...new Set((bookings || [])
    .map(booking => booking?.guest_id)
    .filter(Boolean)
    .map(String))];
  const names = {};

  for (const guestId of guestIds) {
    try {
      const guest = await apiGet(`guests/${guestId}`);
      names[guestId] = [guest?.first_name, guest?.last_name].filter(Boolean).join(' ') || null;
    } catch {
      names[guestId] = null;
    }
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  return names;
}

function attachGuestNames(bookings, guestNames = {}) {
  return (bookings || []).map(booking => {
    if (!booking?.guest_id) return booking;
    const guestName = guestNames[String(booking.guest_id)] || null;
    return {
      ...booking,
      guest_name: guestName,
      guest_name_source: guestName ? 'ownerrez.guests' : 'unavailable',
    };
  });
}

/**
 * Download the complete OwnerRez booking/block inventory without applying a
 * date or contact filter. Financial outlooks need to see unpriced bookings and
 * guestless holds as exceptions instead of silently dropping them.
 */
async function fetchAllBookings(apiGet, {
  propertyIds = DEFAULT_PROPERTY_IDS,
  pageSize = 100,
  pageDelayMs = 300,
} = {}) {
  if (typeof apiGet !== 'function') throw new Error('apiGet must be a function');
  const allBookings = [];
  let offset = 0;

  while (true) {
    const result = await apiGet('bookings', {
      property_ids: propertyIds,
      limit: String(pageSize),
      offset: String(offset),
    });
    const items = result.items || [];
    allBookings.push(...items);
    if (items.length < pageSize) break;
    offset += pageSize;
    if (pageDelayMs > 0) await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }

  return allBookings;
}

function selectFutureOccupancy(bookings, { asOf, through = null }) {
  validateDate(asOf, 'asOf');
  if (through) {
    validateDate(through, 'through');
    if (through < asOf) throw new Error('through must be on or after asOf');
  }
  return (bookings || [])
    .filter(booking => booking?.status === 'active'
      && typeof booking.arrival === 'string'
      && typeof booking.departure === 'string'
      && booking.departure >= asOf
      && (!through || booking.arrival <= through))
    .sort((left, right) => left.arrival.localeCompare(right.arrival)
      || left.departure.localeCompare(right.departure)
      || String(left.id || '').localeCompare(String(right.id || '')));
}

/**
 * OwnerRez uses linked_availability records as derived copies of another
 * calendar entry. Exclude those copies when answering "what is next", but do
 * not exclude type=block: the resort also uses titled manual blocks for guest
 * stays and events, so type=block alone does not prove owner use.
 */
function selectPrimaryCalendarEntries(bookings, { asOf }) {
  validateDate(asOf, 'asOf');
  return (bookings || [])
    .filter(booking => booking?.status === 'active'
      && typeof booking.arrival === 'string'
      && booking.arrival >= asOf
      && booking.type !== 'linked_availability')
    .sort((left, right) => left.arrival.localeCompare(right.arrival)
      || String(left.departure || '').localeCompare(String(right.departure || ''))
      || String(left.id || '').localeCompare(String(right.id || '')));
}

function isBlock(booking) {
  if (typeof booking?.is_block === 'boolean') return booking.is_block;
  return Boolean(booking?.type && booking.type !== 'booking');
}

function humanizeType(type) {
  return String(type || 'block').replace(/_/g, ' ');
}

function reservationDisplayName(booking, guestNames = {}) {
  const guestId = booking?.guest_id;
  const resolvedGuest = guestId ? guestNames[String(guestId)] || guestNames[guestId] : null;
  if (resolvedGuest) return resolvedGuest;

  const embeddedGuest = [booking?.guest?.first_name, booking?.guest?.last_name]
    .filter(Boolean)
    .join(' ');

  return booking?.title ||
    booking?.name ||
    booking?.guest_name ||
    embeddedGuest ||
    (isBlock(booking)
      ? `Block (${humanizeType(booking?.type)})`
      : `Reservation ${booking?.form_key || booking?.id || ''}`.trim());
}

module.exports = {
  DEFAULT_PROPERTY_IDS,
  attachGuestNames,
  fetchAllBookings,
  fetchFullOccupancy,
  fetchGuestNames,
  humanizeType,
  isBlock,
  reservationDisplayName,
  selectFullOccupancy,
  selectFutureOccupancy,
  selectPrimaryCalendarEntries,
  validateDate,
};
