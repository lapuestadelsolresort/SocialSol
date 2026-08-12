'use strict';

const { extractBookingFields } = require('./squarespace-commerce');
const { selectFutureOccupancy } = require('../scripts/lib/ownerrez-occupancy');

const PLATFORM_CHANNELS = new Set(['airbnb', 'vrbo']);
const BOOKING_SIGNAL = /\b(deposit|down payment|remaining|book(?:ing)?|reserv(?:e|ing)|rental|renting|buyout|stay at|night stay)\b|\bfinal\b.*\bpayment\b/i;
const FINAL_PAYMENT_SIGNAL = /\b(final|remaining|second and final|paid in full)\b/i;
const NON_REVENUE_LISTING_SITES = new Set(['owner block-off']);

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function normalizeWords(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function comparableName(guestName, title) {
  const guest = normalizeWords(guestName).filter(token => token.length >= 4);
  const record = normalizeWords(title).filter(token => token.length >= 4);
  return guest.some(left => record.some(right => left === right
    || (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left)))));
}

function propertyKeys(value) {
  const source = String(value || '').toLowerCase();
  const keys = [];
  if (/puesta del sol|full resort|whole resort|resort buyout|buyout/.test(source)) keys.push('resort');
  if (/casa mirador/.test(source)) keys.push('casa_mirador');
  if (/villa (?:crab|cangrejo)|villa 4/.test(source)) keys.push('villa_crab');
  if (/villa (?:dolphin|delfin)|villa 5/.test(source)) keys.push('villa_dolphin');
  if (/villa (?:seahorse|caballito)|villa 3/.test(source)) keys.push('villa_seahorse');
  if (/villa (?:whale|ballena)|villa 2/.test(source)) keys.push('villa_whale');
  if (/villa (?:pearl|perla)|villa 1/.test(source)) keys.push('villa_pearl');
  if (/villa (?:turtle|tortuga)|villa 6/.test(source)) keys.push('villa_turtle');
  return [...new Set(keys)];
}

function titlesForOrder(db, orderId) {
  return db.prepare(`SELECT title, department
    FROM squarespace_order_items WHERE order_id=? ORDER BY line_item_id`).all(orderId);
}

function paymentFacts(db, orderId) {
  const payments = db.prepare(`SELECT
      COALESCE(SUM(CAST(amount_value AS REAL)),0) AS gross,
      COALESCE(SUM(CAST(net_amount_value AS REAL)),0) AS provider_net
    FROM squarespace_payments WHERE order_id=?`).get(orderId);
  const fees = db.prepare(`SELECT
      COALESCE(SUM(CAST(amount_value AS REAL)),0) AS gross,
      COALESCE(SUM(CAST(refunded_amount_value AS REAL)),0) AS refunded
    FROM squarespace_processing_fees WHERE order_id=?`).get(orderId);
  const refunds = db.prepare(`SELECT COALESCE(SUM(CAST(amount_value AS REAL)),0) AS gross
    FROM squarespace_refunds WHERE order_id=?`).get(orderId);
  const collectedGross = roundMoney(number(payments.gross) - number(refunds.gross));
  const actualFees = roundMoney(number(fees.gross) - number(fees.refunded));
  return {
    collected_gross: collectedGross,
    actual_fees: actualFees,
    collected_net: roundMoney(collectedGross - actualFees),
    refunds: roundMoney(refunds.gross),
  };
}

function depositFraction(title) {
  if (!/\b(deposit|down payment|reserve|reserving)\b/i.test(title || '')) return null;
  const match = String(title).match(/\b(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const fraction = Number(match[1]) / 100;
  return fraction > 0 && fraction < 1 ? fraction : null;
}

function loadFutureDirectOrders(db, { asOf, through = null }) {
  const orders = db.prepare(`SELECT * FROM squarespace_orders
    WHERE payment_state IN ('PAID','PARTIALLY_PAID') ORDER BY created_on, order_number`).all();
  const future = [];
  const undated = [];

  for (const order of orders) {
    const items = titlesForOrder(db, order.order_id);
    const bookingItems = items.filter(item => item.department === 'direct_booking');
    const title = bookingItems.map(item => item.title).filter(Boolean).join(' | ');
    if (!bookingItems.length || !BOOKING_SIGNAL.test(title)) continue;

    const raw = safeJson(order.raw_json, {});
    const extracted = extractBookingFields(raw);
    const startDate = order.service_start_date || extracted.startDate;
    const endDate = order.service_end_date || extracted.endDate;
    const property = order.property_hint || extracted.propertyHint || 'Property not identified';
    const facts = paymentFacts(db, order.order_id);
    const row = {
      order_id: order.order_id,
      order_number: order.order_number,
      guest: order.customer_name || order.customer_email || 'Squarespace guest',
      start_date: startDate,
      end_date: endDate,
      property,
      title,
      currency: order.currency || 'USD',
      created_on: order.created_on,
      deposit_fraction: depositFraction(title),
      final_payment: FINAL_PAYMENT_SIGNAL.test(title),
      ...facts,
    };
    if (!startDate) {
      if (String(order.created_on || '').slice(0, 10) >= asOf) undated.push(row);
      continue;
    }
    const lastServiceDate = endDate || startDate;
    if (lastServiceDate < asOf || (through && startDate > through)) continue;
    future.push(row);
  }
  return { future, undated };
}

function groupDirectOrders(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = [normalizeWords(row.guest).join(' '), row.start_date, row.end_date || '',
      propertyKeys(row.property).sort().join(',') || normalizeWords(row.property).join('_')].join('|');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  return [...grouped.values()].map(orders => {
    const collectedGross = roundMoney(orders.reduce((sum, order) => sum + order.collected_gross, 0));
    const actualFees = roundMoney(orders.reduce((sum, order) => sum + order.actual_fees, 0));
    const depositEstimates = orders
      .filter(order => order.deposit_fraction)
      .map(order => order.collected_gross / order.deposit_fraction);
    const expectedGross = roundMoney(Math.max(collectedGross, ...depositEstimates, 0));
    const balanceGross = roundMoney(Math.max(0, expectedGross - collectedGross));
    const feeRate = collectedGross > 0 ? actualFees / collectedGross : 0;
    const estimatedFutureFees = roundMoney(balanceGross * feeRate);
    const hasDepositEvidence = depositEstimates.length > 0;
    const hasFinalPayment = orders.some(order => order.final_payment);
    return {
      guest: orders[0].guest,
      start_date: orders[0].start_date,
      end_date: orders[0].end_date,
      property: orders[0].property,
      property_keys: propertyKeys(orders[0].property),
      currency: orders[0].currency,
      order_ids: orders.map(order => order.order_id),
      order_numbers: orders.map(order => order.order_number),
      expected_gross: expectedGross,
      expected_value_basis: hasDepositEvidence
        ? (balanceGross === 0 && hasFinalPayment ? 'confirmed_by_deposit_and_final_payments' : 'inferred_from_deposit_label')
        : 'collected_orders_only',
      collected_gross: collectedGross,
      actual_fees: actualFees,
      collected_net: roundMoney(collectedGross - actualFees),
      balance_gross: balanceGross,
      balance_due_date: null,
      estimated_future_fees: estimatedFutureFees,
      estimated_future_net: roundMoney(balanceGross - estimatedFutureFees),
      expected_net_value: roundMoney(expectedGross - actualFees - estimatedFutureFees),
      payment_status: balanceGross > 0 ? 'balance_inferred_not_invoiced' : 'fully_collected',
      source_titles: orders.map(order => order.title),
    };
  }).sort((left, right) => left.start_date.localeCompare(right.start_date)
    || left.guest.localeCompare(right.guest));
}

function reconcileDirectGroups(groups, futureOccupancy) {
  const available = futureOccupancy.filter(record => record.type !== 'linked_availability');
  const associatedRecordIds = new Set();
  for (const group of groups) {
    const dateCandidates = available.filter(record => record.arrival === group.start_date
      && (!group.end_date || record.departure === group.end_date));
    const expectedProperties = group.property_keys.length ? group.property_keys : [null];
    const selected = [];
    const datePropertyOnly = [];

    for (const expectedProperty of expectedProperties) {
      const propertyCandidates = dateCandidates.filter(record => !expectedProperty
        || propertyKeys(record.property?.name).includes(expectedProperty));
      const named = propertyCandidates.find(record => comparableName(group.guest, record.title));
      if (named) selected.push(named);
      else if (propertyCandidates[0]) datePropertyOnly.push(propertyCandidates[0]);
    }

    const complete = selected.length === expectedProperties.length;
    const candidateRecords = [...new Map([...selected, ...datePropertyOnly].map(record => [record.id, record])).values()];
    candidateRecords.forEach(record => associatedRecordIds.add(record.id));
    group.ownerrez_reconciliation = {
      status: complete ? 'matched' : candidateRecords.length ? 'review' : 'missing',
      match_method: complete ? 'exact_dates_property_and_name'
        : candidateRecords.length ? 'exact_dates_property_only' : 'no_exact_ownerrez_record',
      confidence: complete ? 0.99 : candidateRecords.length ? 0.45 : 0,
      primary_booking_id: selected[0]?.id || datePropertyOnly[0]?.id || null,
      related_booking_ids: candidateRecords.map(record => record.id),
      ownerrez_titles: candidateRecords.map(record => record.title || null),
    };
  }
  return associatedRecordIds;
}

function guestName(record, guestNames) {
  return guestNames[String(record.guest_id)] || guestNames[record.guest_id]
    || record.guest_name || record.title || `OwnerRez guest ${record.guest_id}`;
}

function buildPlatformBookings(futureOccupancy, guestNames = {}) {
  const priced = [];
  const unpriced = [];
  for (const record of futureOccupancy) {
    if (record.type !== 'booking' || !record.guest_id) continue;
    const channel = String(record.listing_site || '').toLowerCase();
    if (!PLATFORM_CHANNELS.has(channel)) continue;
    const gross = optionalNumber(record.total_amount);
    if (gross === null) {
      unpriced.push(record);
      continue;
    }
    const hostFees = number(record.total_host_fees);
    const totalPaid = optionalNumber(record.total_paid);
    priced.push({
      ownerrez_booking_id: record.id,
      guest: guestName(record, guestNames),
      channel: record.listing_site,
      start_date: record.arrival,
      end_date: record.departure,
      property: record.property?.name || `Property ${record.property_id || 'unknown'}`,
      currency: record.currency_code || 'USD',
      gross: roundMoney(gross),
      host_fees: roundMoney(hostFees),
      anticipated_net_payout: roundMoney(gross - hostFees),
      guest_paid: totalPaid === null ? null : roundMoney(totalPaid),
      guest_payment_status: totalPaid !== null && totalPaid >= gross ? 'guest_paid' : 'guest_payment_incomplete_or_unknown',
      kapital_deposit_status: 'not_verified',
      payout_date: null,
    });
  }
  return { priced, unpriced };
}

function summarizeUnresolvedOwnerRez(futureOccupancy, guestNames, associatedRecordIds, platformUnpriced) {
  const platformUnpricedIds = new Set(platformUnpriced.map(record => record.id));
  const unpricedBookings = futureOccupancy
    .filter(record => record.type === 'booking' && record.guest_id
      && !associatedRecordIds.has(record.id)
      && (!PLATFORM_CHANNELS.has(String(record.listing_site || '').toLowerCase())
        || platformUnpricedIds.has(record.id)))
    .map(record => ({
      ownerrez_booking_id: record.id,
      guest: guestName(record, guestNames),
      start_date: record.arrival,
      end_date: record.departure,
      property: record.property?.name || `Property ${record.property_id || 'unknown'}`,
      listing_site: record.listing_site || null,
      reason: 'active_ownerrez_booking_without_priced_cash_flow',
    }));

  const systemSentinels = futureOccupancy.filter(record => {
    const year = Number(String(record.arrival || '').slice(0, 4));
    return Number.isInteger(year) && year >= 2090;
  });
  const sentinelIds = new Set(systemSentinels.map(record => record.id));
  const blocks = futureOccupancy
    .filter(record => record.type === 'block' && !associatedRecordIds.has(record.id)
      && !sentinelIds.has(record.id))
    .map(record => ({
      ownerrez_booking_id: record.id,
      title: record.title || 'Untitled OwnerRez block',
      start_date: record.arrival,
      end_date: record.departure,
      property: record.property?.name || `Property ${record.property_id || 'unknown'}`,
      listing_site: record.listing_site || null,
      classification: NON_REVENUE_LISTING_SITES.has(String(record.listing_site || '').toLowerCase())
        ? 'probable_non_revenue_hold' : 'unpriced_or_unreconciled_block',
    }));
  return {
    unpricedBookings,
    blocks,
    systemSentinels: systemSentinels.map(record => ({
      ownerrez_booking_id: record.id,
      title: record.title || 'Untitled OwnerRez block',
      start_date: record.arrival,
      end_date: record.departure,
      reason: 'far_future_calendar_sentinel_excluded_from_financial_outlook',
    })),
  };
}

function sum(rows, field) {
  return roundMoney(rows.reduce((total, row) => total + number(row[field]), 0));
}

function platformStayMonthTiming(bookings) {
  const grouped = new Map();
  for (const booking of bookings) {
    const month = String(booking.start_date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    grouped.set(month, roundMoney(number(grouped.get(month)) + booking.anticipated_net_payout));
  }
  return [...grouped.entries()].map(([stay_month, anticipated_net_payout]) => ({
    stay_month,
    anticipated_net_payout,
    timing_basis: 'stay_month_proxy_not_payout_date',
  }));
}

function dataFreshness(db) {
  const rows = db.prepare(`SELECT stream, last_success_at, last_error
    FROM squarespace_sync_state ORDER BY stream`).all();
  return Object.fromEntries(rows.map(row => [row.stream, {
    last_success_at: row.last_success_at,
    last_error: row.last_error || null,
  }]));
}

function buildOwnerCashFlow(db, {
  ownerrezBookings,
  guestNames = {},
  asOf,
  through = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const futureOccupancy = selectFutureOccupancy(ownerrezBookings, { asOf, through });
  const directSource = loadFutureDirectOrders(db, { asOf, through });
  const direct = groupDirectOrders(directSource.future);
  const associatedRecordIds = reconcileDirectGroups(direct, futureOccupancy);
  const platform = buildPlatformBookings(futureOccupancy, guestNames);
  const unresolved = summarizeUnresolvedOwnerRez(
    futureOccupancy, guestNames, associatedRecordIds, platform.unpriced
  );

  const directTotals = {
    commitment_count: direct.length,
    expected_gross: sum(direct, 'expected_gross'),
    collected_gross: sum(direct, 'collected_gross'),
    actual_processing_fees: sum(direct, 'actual_fees'),
    collected_net: sum(direct, 'collected_net'),
    inferred_balance_gross: sum(direct, 'balance_gross'),
    estimated_future_processing_fees: sum(direct, 'estimated_future_fees'),
    estimated_future_net: sum(direct, 'estimated_future_net'),
    estimated_eventual_net: sum(direct, 'expected_net_value'),
    reconciled: direct.filter(group => group.ownerrez_reconciliation.status === 'matched').length,
    review: direct.filter(group => group.ownerrez_reconciliation.status === 'review').length,
    missing: direct.filter(group => group.ownerrez_reconciliation.status === 'missing').length,
  };
  const platformTotals = {
    priced_booking_count: platform.priced.length,
    gross: sum(platform.priced, 'gross'),
    host_fees: sum(platform.priced, 'host_fees'),
    anticipated_net_payout: sum(platform.priced, 'anticipated_net_payout'),
    kapital_confirmed_deposits: null,
  };
  const combined = {
    priced_future_stay_value: roundMoney(directTotals.expected_gross + platformTotals.gross),
    already_collected_direct_gross: directTotals.collected_gross,
    already_collected_direct_net: directTotals.collected_net,
    expected_future_receipts_before_future_direct_fees: roundMoney(
      directTotals.inferred_balance_gross + platformTotals.anticipated_net_payout
    ),
    estimated_future_receipts_net: roundMoney(
      directTotals.estimated_future_net + platformTotals.anticipated_net_payout
    ),
    estimated_eventual_net_value: roundMoney(
      directTotals.estimated_eventual_net + platformTotals.anticipated_net_payout
    ),
  };

  return {
    report_type: 'owner_future_cash_flow',
    as_of: asOf,
    through,
    generated_at: generatedAt,
    definitions: {
      priced_future_stay_value: 'Value of priced future stays, including direct cash already collected; not future cash alone.',
      collected: 'Squarespace card charges imported into the CRM; not a current bank balance.',
      direct_balance: 'Inferred from deposit percentages in Squarespace product titles; not an open Squarespace invoice.',
      platform_payout: 'OwnerRez gross less host fees; not Kapital-confirmed until a bank deposit is reconciled.',
      timing: 'Stay dates are not payment due dates or payout dates. Unknown dates remain unknown.',
      ownerrez_block: 'A block is an occupancy/calendar record. It is not automatically a confirmed booking, revenue commitment, or amount owed.',
    },
    freshness: { squarespace: dataFreshness(db), ownerrez: 'live_api' },
    direct: { totals: directTotals, commitments: direct, undated_orders: directSource.undated },
    platform: { totals: platformTotals, bookings: platform.priced },
    unresolved: {
      active_unpriced_bookings: unresolved.unpricedBookings,
      unpriced_or_unreconciled_blocks: unresolved.blocks,
      undated_squarespace_orders: directSource.undated,
      ignored_system_sentinels: unresolved.systemSentinels,
    },
    timing: {
      unscheduled_direct_balance_net: directTotals.estimated_future_net,
      unscheduled_direct_reason: 'Squarespace does not record due dates for inferred balances.',
      platform_by_stay_month: platformStayMonthTiming(platform.priced),
      platform_timing_warning: 'Stay month is a planning proxy, not an OwnerRez payout date or Kapital-confirmed deposit date.',
    },
    combined,
  };
}

function applyHighConfidenceReconciliation(db, report) {
  let matchedOrders = 0;
  let reviewOrders = 0;
  const update = db.prepare(`UPDATE squarespace_order_ownerrez_links SET
    ownerrez_booking_id=?, status=?, match_method=?, confidence=?,
    matched_at=CASE WHEN ?='matched' THEN COALESCE(matched_at, datetime('now')) ELSE NULL END,
    reviewed_at=datetime('now'), notes=? WHERE order_id=?`);
  const transaction = db.transaction(() => {
    for (const group of report.direct.commitments) {
      const reconciliation = group.ownerrez_reconciliation;
      if (!['matched', 'review'].includes(reconciliation.status)) continue;
      for (const orderId of group.order_ids) {
        update.run(
          reconciliation.primary_booking_id,
          reconciliation.status,
          `owner_cash_flow_${reconciliation.match_method}`,
          reconciliation.confidence,
          reconciliation.status,
          `Owner cash-flow reconciliation; related OwnerRez ids: ${reconciliation.related_booking_ids.join(',')}`,
          orderId
        );
        if (reconciliation.status === 'matched') matchedOrders += 1;
        else reviewOrders += 1;
      }
    }
  });
  transaction();
  return { matched_orders: matchedOrders, review_orders: reviewOrders };
}

function money(value, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(number(value));
}

function dateRange(start, end) {
  return end && end !== start ? `${start} → ${end}` : start;
}

function formatOwnerCashFlow(report) {
  const direct = report.direct.totals;
  const platform = report.platform.totals;
  const combined = report.combined;
  const lines = [
    `*Owner cash-flow outlook — as of ${report.as_of}*`,
    '_OwnerRez is the stay source; Squarespace is the direct-payment source; Kapital is required to confirm platform deposits._',
    '',
    '*Executive summary*',
    `• Priced future-stay value: ${money(combined.priced_future_stay_value)} (includes cash already collected)`,
    `• Direct cash charged: ${money(direct.collected_gross)} gross / ${money(direct.collected_net)} net after ${money(direct.actual_processing_fees)} actual fees`,
    `• Expected future receipts: ${money(combined.estimated_future_receipts_net)} net estimate — ${money(direct.estimated_future_net)} direct balances + ${money(platform.anticipated_net_payout)} anticipated platform payouts`,
    `• Estimated eventual net value: ${money(combined.estimated_eventual_net_value)}`,
    `• Reconciliation: ${direct.reconciled}/${direct.commitment_count} direct commitments matched to OwnerRez; ${direct.review} review; ${direct.missing} missing`,
    '',
    '*Timing view*',
    `• Direct balances: ${money(report.timing.unscheduled_direct_balance_net)} net estimate, unscheduled because no due dates are recorded`,
    ...report.timing.platform_by_stay_month.map(row =>
      `• ${row.stay_month}: ${money(row.anticipated_net_payout)} anticipated platform payout (stay-month proxy)`
    ),
    '',
    `*Direct commitments — ${direct.commitment_count}*`,
  ];

  for (const commitment of report.direct.commitments) {
    const balance = commitment.balance_gross > 0
      ? `${money(commitment.balance_gross)} inferred balance; due date not recorded`
      : 'fully collected';
    lines.push(`• ${commitment.guest} — ${dateRange(commitment.start_date, commitment.end_date)}, ${commitment.property}: `
      + `${money(commitment.expected_gross)} expected; ${money(commitment.collected_gross)} charged; ${balance}; `
      + `OwnerRez ${commitment.ownerrez_reconciliation.status}`);
  }

  lines.push('', `*Platform bookings — ${platform.priced_booking_count}*`);
  for (const booking of report.platform.bookings) {
    lines.push(`• ${booking.guest} (${booking.channel}) — ${dateRange(booking.start_date, booking.end_date)}, ${booking.property}: `
      + `${money(booking.gross)} gross − ${money(booking.host_fees)} host fees = `
      + `${money(booking.anticipated_net_payout)} anticipated payout; Kapital not verified`);
  }

  const unpriced = report.unresolved.active_unpriced_bookings;
  const blocks = report.unresolved.unpriced_or_unreconciled_blocks;
  const undated = report.unresolved.undated_squarespace_orders;
  if (unpriced.length || blocks.length || undated.length || direct.review || direct.missing) {
    lines.push('', '*Exceptions that prevent a complete cash forecast*');
    lines.push(`_${unpriced.length} active unpriced booking(s); ${blocks.length} OwnerRez block/hold record(s). `
      + 'Blocks are not automatically confirmed bookings or revenue._');
    for (const booking of unpriced) {
      lines.push(`• Active unpriced OwnerRez booking: ${booking.guest} — ${dateRange(booking.start_date, booking.end_date)}, ${booking.property}`);
    }
    for (const block of blocks) {
      lines.push(`• ${block.classification === 'probable_non_revenue_hold' ? 'Probable non-revenue hold' : 'Unpriced OwnerRez block'}: `
        + `${block.title} — ${dateRange(block.start_date, block.end_date)}, ${block.property}`);
    }
    for (const order of undated) {
      lines.push(`• Undated Squarespace booking order ${order.order_number}: ${order.guest}, ${money(order.collected_gross)} charged`);
    }
  }

  lines.push('', '_Important: direct balances are inferred, not open Squarespace invoices. Stay dates are not payment or payout dates. “Collected” is not the current bank balance._');
  return lines.join('\n');
}

module.exports = {
  applyHighConfidenceReconciliation,
  buildOwnerCashFlow,
  buildPlatformBookings,
  comparableName,
  depositFraction,
  formatOwnerCashFlow,
  groupDirectOrders,
  loadFutureDirectOrders,
  propertyKeys,
  reconcileDirectGroups,
  roundMoney,
};
