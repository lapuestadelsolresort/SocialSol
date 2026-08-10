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
  fetchFullOccupancy,
  humanizeType,
  isBlock,
  reservationDisplayName,
  selectFullOccupancy,
  validateDate,
};
