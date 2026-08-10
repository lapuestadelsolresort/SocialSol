'use strict';

const DEFAULT_DEPARTMENTS = {
  housekeeping: ['housekeeping', 'cleaning', 'linen', 'laundry', 'maid'],
  food_beverage: ['meal', 'breakfast', 'lunch', 'dinner', 'catering', 'beverage', 'chef', 'food', 'all inclusive'],
  guest_activity: ['tour', 'excursion', 'activity', 'massage', 'transportation', 'surf', 'lesson', 'camp'],
};

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function text(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function moneyValue(value) {
  return value && value.value !== undefined && value.value !== null ? String(value.value) : null;
}

function moneyCurrency(value) {
  return text(value?.currency);
}

function normalizeEmail(value) {
  return text(value)?.toLowerCase() || null;
}

function normalizePhone(value) {
  const raw = text(value);
  if (!raw) return null;
  const plus = raw.startsWith('+') ? '+' : '';
  const digits = raw.replace(/\D/g, '');
  return digits ? `${plus}${digits}` : null;
}

function contactMarketing(primaryEmail) {
  const setting = primaryEmail?.acceptsMarketing;
  if (typeof setting === 'boolean') return { accepted: setting ? 1 : 0, joinedOn: null, leftOn: null };
  if (setting && typeof setting === 'object') {
    return {
      accepted: setting.acceptsMarketing === true ? 1 : setting.acceptsMarketing === false ? 0 : null,
      joinedOn: text(setting.joinedOn),
      leftOn: text(setting.leftOn),
    };
  }
  return { accepted: null, joinedOn: null, leftOn: null };
}

function orderIdentity(order, customer = null) {
  const address = order.billingAddress || order.shippingAddress || {};
  const contactAddress = customer?.defaultShippingAddress?.address || {};
  const firstName = text(customer?.firstName) || text(address.firstName) || text(contactAddress.firstName);
  const lastName = text(customer?.lastName) || text(address.lastName) || text(contactAddress.lastName);
  return {
    firstName,
    lastName,
    name: [firstName, lastName].filter(Boolean).join(' ') || text(order.customerEmail) || 'Squarespace guest',
    email: normalizeEmail(customer?.primaryEmail?.email || order.customerEmail),
    phone: normalizePhone(
      contactAddress.phoneNumber || address.phone || address.phoneNumber || order.shippingAddress?.phone
    ),
    address: address || contactAddress,
  };
}

function formatAddress(address) {
  if (!address) return null;
  return [
    address.address1 || address.line1,
    address.address2 || address.line2,
    address.city,
    address.state || address.region,
    address.postalCode,
    address.countryCode,
  ].map(text).filter(Boolean).join(', ') || null;
}

function formEntries(order) {
  const entries = [];
  for (const item of order.formSubmission || []) {
    entries.push([text(item.label)?.toLowerCase() || '', text(item.value)]);
  }
  for (const line of order.lineItems || []) {
    const customizations = line.customizations || line.variantOptions || [];
    if (Array.isArray(customizations)) {
      for (const item of customizations) {
        entries.push([
          text(item.label || item.name || item.optionName)?.toLowerCase() || '',
          text(item.value || item.optionValue),
        ]);
      }
    } else if (customizations && typeof customizations === 'object') {
      for (const [label, value] of Object.entries(customizations)) entries.push([label.toLowerCase(), text(value)]);
    }
  }
  return entries.filter(([, value]) => value);
}

function parseDate(value) {
  if (!value) return null;
  const iso = String(value).match(/\b(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function fourDigitYear(value) {
  const year = Number(value);
  return year < 100 ? 2000 + year : year;
}

function isoDate(year, month, day) {
  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate : null;
}

function extractTitleDates(order) {
  const source = (order.lineItems || [])
    .map(item => item.title || item.productName || '')
    .filter(Boolean)
    .join(' | ');
  if (!source) return { startDate: null, endDate: null };

  const numeric = [...source.matchAll(/\b(0?[1-9]|1[0-2])[./-]([0-2]?\d|3[01])[./-](\d{2}|20\d{2})\b/g)]
    .map(match => isoDate(fourDigitYear(match[3]), Number(match[1]), Number(match[2])))
    .filter(Boolean);
  if (numeric.length) return { startDate: numeric[0], endDate: numeric[1] || null };

  const month = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const suffix = '(?:st|nd|rd|th)?';
  const crossMonth = new RegExp(`${month}\\s+(\\d{1,2})${suffix}\\s*(?:to|through|[-–—])\\s*${month}\\s+(\\d{1,2})${suffix}\\s*,?\\s*(20\\d{2})`, 'i');
  let match = source.match(crossMonth);
  if (match) {
    const year = Number(match[5]);
    const startMonth = MONTHS[match[1].toLowerCase()];
    const endMonth = MONTHS[match[3].toLowerCase()];
    return {
      startDate: isoDate(endMonth < startMonth ? year - 1 : year, startMonth, Number(match[2])),
      endDate: isoDate(year, endMonth, Number(match[4])),
    };
  }

  const sameMonth = new RegExp(`${month}\\s+(\\d{1,2})${suffix}\\s*(?:to|through|[-–—])\\s*(\\d{1,2})${suffix}\\s*,?\\s*(20\\d{2})`, 'i');
  match = source.match(sameMonth);
  if (match) {
    const monthNumber = MONTHS[match[1].toLowerCase()];
    return {
      startDate: isoDate(Number(match[4]), monthNumber, Number(match[2])),
      endDate: isoDate(Number(match[4]), monthNumber, Number(match[3])),
    };
  }

  const complete = new RegExp(`${month}\\s+(\\d{1,2})${suffix}\\s*,?\\s*(20\\d{2})`, 'gi');
  const named = [...source.matchAll(complete)].map(item =>
    isoDate(Number(item[3]), MONTHS[item[1].toLowerCase()], Number(item[2]))
  ).filter(Boolean);
  return { startDate: named[0] || null, endDate: named[1] || null };
}

function extractBookingFields(order) {
  const result = { startDate: null, endDate: null, guestCount: null, propertyHint: null };
  for (const [label, value] of formEntries(order)) {
    if (!result.startDate && /(check.?in|arrival|start date)/i.test(label)) result.startDate = parseDate(value);
    else if (!result.endDate && /(check.?out|departure|end date)/i.test(label)) result.endDate = parseDate(value);
    else if (!result.guestCount && /(guest|party|people|occupant)/i.test(label)) {
      const count = Number(String(value).match(/\d+/)?.[0]);
      if (Number.isInteger(count) && count > 0 && count < 100) result.guestCount = count;
    } else if (!result.propertyHint && /(property|villa|room|accommodation)/i.test(label)) {
      result.propertyHint = value;
    }
  }
  const titleDates = extractTitleDates(order);
  result.startDate ||= titleDates.startDate;
  result.endDate ||= titleDates.endDate;
  return result;
}

function classifyLineItem(item, config = {}) {
  const title = `${item.title || item.productName || ''} ${item.sku || ''}`.toLowerCase();
  const departments = config.item_departments || DEFAULT_DEPARTMENTS;
  for (const [department, patterns] of Object.entries(departments)) {
    if ((patterns || []).some(pattern => title.includes(String(pattern).toLowerCase()))) return department;
  }
  return 'direct_booking';
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function insertDynamic(db, table, columns, values) {
  const names = Object.keys(values).filter(name => columns.has(name) && values[name] !== undefined);
  const placeholders = names.map(() => '?').join(', ');
  return db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`)
    .run(...names.map(name => values[name]));
}

function updateMissingContactFields(db, columns, contact, values, booked) {
  const assignments = [];
  const params = [];
  const fillable = ['first_name', 'last_name', 'email', 'phone', 'address', 'listing_channel', 'last_stay_date'];
  for (const name of fillable) {
    if (columns.has(name) && values[name]) {
      assignments.push(`${name}=COALESCE(${name}, ?)`);
      params.push(values[name]);
    }
  }
  if (booked && columns.has('status') && !['booked', 'converted'].includes(contact.status)) {
    assignments.push("status='booked'");
  }
  if (columns.has('updated_at')) assignments.push("updated_at=datetime('now')");
  if (!assignments.length) return;
  params.push(contact.id);
  db.prepare(`UPDATE contacts SET ${assignments.join(', ')} WHERE id=?`).run(...params);
}

function ensureCrmContact(db, { customer = null, order = null } = {}) {
  if (!tableExists(db, 'contacts')) throw new Error('CRM contacts table is missing');
  const columns = tableColumns(db, 'contacts');
  const identity = orderIdentity(order || {}, customer);
  const customerId = text(customer?.id || order?.customerId);
  let existing = customerId
    ? db.prepare(`SELECT c.* FROM contacts c
        JOIN squarespace_customers sc ON sc.contact_id=c.id
        WHERE sc.squarespace_customer_id=?`).get(customerId)
    : null;
  if (!existing && identity.email && columns.has('email')) {
    existing = db.prepare('SELECT * FROM contacts WHERE LOWER(TRIM(email))=? ORDER BY id LIMIT 1')
      .get(identity.email);
  }
  if (!existing && !identity.email && identity.phone && columns.has('phone')) {
    existing = db.prepare('SELECT * FROM contacts WHERE phone=? ORDER BY id LIMIT 1').get(identity.phone);
  }

  const booking = order ? extractBookingFields(order) : {};
  const values = {
    first_name: identity.firstName,
    last_name: identity.lastName,
    name: identity.name,
    email: identity.email,
    phone: identity.phone,
    address: formatAddress(identity.address),
    email_status: identity.email ? 'unknown' : null,
    dedup_key: identity.email || `squarespace_${customerId || text(order?.id)}`,
    source: 'squarespace',
    context_source: 'squarespace_commerce',
    status: order ? 'booked' : 'new',
    notes: order ? `Squarespace direct booking order ${order.orderNumber || order.id}` : 'Squarespace customer',
    relationship_type: order ? 'past_guest' : 'customer',
    contact_provenance: 'squarespace_commerce',
    addressable: identity.email || identity.phone ? 1 : 0,
    listing_channel: 'My Website',
    last_stay_date: booking.endDate || booking.startDate || null,
  };

  if (existing) {
    updateMissingContactFields(db, columns, existing, values, Boolean(order));
    return db.prepare('SELECT * FROM contacts WHERE id=?').get(existing.id);
  }
  const inserted = insertDynamic(db, 'contacts', columns, values);
  return db.prepare('SELECT * FROM contacts WHERE id=?').get(inserted.lastInsertRowid);
}

function customerValues(customer, contactId = null, summary = null) {
  const identity = orderIdentity({}, customer);
  const marketing = contactMarketing(customer?.primaryEmail);
  const analytics = summary?.transactionsSummary || {};
  return {
    id: text(customer?.id),
    contactId,
    email: identity.email,
    firstName: identity.firstName,
    lastName: identity.lastName,
    phone: identity.phone,
    marketing,
    locale: text(customer?.locale),
    address: customer?.defaultShippingAddress || null,
    createdOn: text(customer?.createdOn),
    analytics,
    currency: moneyCurrency(analytics.totalOrderAmount) || moneyCurrency(analytics.totalRefundAmount),
  };
}

function upsertCustomer(db, customer, summary = null) {
  const values = customerValues(customer, null, summary);
  if (!values.id) throw new Error('Squarespace customer is missing id');
  const contact = ensureCrmContact(db, { customer });
  db.prepare(`
    INSERT INTO squarespace_customers (
      squarespace_customer_id, contact_id, email, first_name, last_name, phone,
      accepts_marketing, marketing_joined_on, marketing_left_on, locale,
      address_json, created_on, first_order_on, last_order_on, order_count,
      total_order_value, total_refund_value, currency, raw_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(squarespace_customer_id) DO UPDATE SET
      contact_id=COALESCE(excluded.contact_id, squarespace_customers.contact_id),
      email=COALESCE(excluded.email, squarespace_customers.email),
      first_name=COALESCE(excluded.first_name, squarespace_customers.first_name),
      last_name=COALESCE(excluded.last_name, squarespace_customers.last_name),
      phone=COALESCE(excluded.phone, squarespace_customers.phone),
      accepts_marketing=COALESCE(excluded.accepts_marketing, squarespace_customers.accepts_marketing),
      marketing_joined_on=COALESCE(excluded.marketing_joined_on, squarespace_customers.marketing_joined_on),
      marketing_left_on=COALESCE(excluded.marketing_left_on, squarespace_customers.marketing_left_on),
      locale=COALESCE(excluded.locale, squarespace_customers.locale),
      address_json=COALESCE(excluded.address_json, squarespace_customers.address_json),
      created_on=COALESCE(excluded.created_on, squarespace_customers.created_on),
      first_order_on=COALESCE(excluded.first_order_on, squarespace_customers.first_order_on),
      last_order_on=COALESCE(excluded.last_order_on, squarespace_customers.last_order_on),
      order_count=COALESCE(excluded.order_count, squarespace_customers.order_count),
      total_order_value=COALESCE(excluded.total_order_value, squarespace_customers.total_order_value),
      total_refund_value=COALESCE(excluded.total_refund_value, squarespace_customers.total_refund_value),
      currency=COALESCE(excluded.currency, squarespace_customers.currency),
      raw_json=excluded.raw_json,
      synced_at=datetime('now')
  `).run(
    values.id, contact.id, values.email, values.firstName, values.lastName, values.phone,
    values.marketing.accepted, values.marketing.joinedOn, values.marketing.leftOn, values.locale,
    JSON.stringify(values.address), values.createdOn,
    text(values.analytics.firstOrderSubmittedOn), text(values.analytics.lastOrderSubmittedOn),
    Number.isInteger(values.analytics.orderCount) ? values.analytics.orderCount : null,
    moneyValue(values.analytics.totalOrderAmount), moneyValue(values.analytics.totalRefundAmount),
    values.currency, JSON.stringify(customer)
  );
  return contact;
}

function ensureCustomerStub(db, order, contact) {
  const customerId = text(order.customerId);
  if (!customerId) return;
  const identity = orderIdentity(order);
  db.prepare(`
    INSERT INTO squarespace_customers (
      squarespace_customer_id, contact_id, email, first_name, last_name, phone, raw_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(squarespace_customer_id) DO UPDATE SET
      contact_id=COALESCE(excluded.contact_id, squarespace_customers.contact_id),
      email=COALESCE(excluded.email, squarespace_customers.email),
      first_name=COALESCE(excluded.first_name, squarespace_customers.first_name),
      last_name=COALESCE(excluded.last_name, squarespace_customers.last_name),
      phone=COALESCE(excluded.phone, squarespace_customers.phone),
      synced_at=datetime('now')
  `).run(customerId, contact.id, identity.email, identity.firstName, identity.lastName, identity.phone, '{}');
}

function enqueue(db, eventKey, audience, eventType, orderId, payload) {
  db.prepare(`INSERT OR IGNORE INTO squarespace_notification_outbox
    (event_key, audience, event_type, order_id, payload_json)
    VALUES (?, ?, ?, ?, ?)`)
    .run(eventKey, audience, eventType, orderId, JSON.stringify(payload));
}

function linkOwnerRez(db, order, contact, config = {}, ownerrezBooking = null) {
  const manualId = config.manual_ownerrez_links?.[order.id];
  const candidateId = manualId || contact.ownerrez_booking_id || null;
  let status = 'unmatched';
  let method = null;
  let confidence = null;
  const booking = extractBookingFields(order);
  if (manualId) {
    status = 'matched'; method = 'manual_config'; confidence = 1;
  } else if (candidateId && ownerrezBooking) {
    const hasDateEvidence = Boolean(booking.startDate || booking.endDate);
    const dateMatch = hasDateEvidence
      && (!booking.startDate || booking.startDate === ownerrezBooking.arrival)
      && (!booking.endDate || booking.endDate === ownerrezBooking.departure);
    status = dateMatch ? 'matched' : 'review';
    method = dateMatch ? 'contact_and_dates'
      : hasDateEvidence ? 'contact_date_conflict' : 'contact_without_dates';
    confidence = dateMatch ? 0.99 : hasDateEvidence ? 0.25 : 0.4;
  } else if (candidateId) {
    status = 'candidate'; method = 'contact_ownerrez_booking_id'; confidence = 0.7;
  }
  db.prepare(`
    INSERT INTO squarespace_order_ownerrez_links
      (order_id, ownerrez_booking_id, contact_id, status, match_method, confidence, matched_at)
    VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ?='matched' THEN datetime('now') ELSE NULL END)
    ON CONFLICT(order_id) DO UPDATE SET
      ownerrez_booking_id=COALESCE(excluded.ownerrez_booking_id, squarespace_order_ownerrez_links.ownerrez_booking_id),
      contact_id=excluded.contact_id,
      status=excluded.status,
      match_method=excluded.match_method,
      confidence=excluded.confidence,
      matched_at=CASE WHEN excluded.status='matched'
                      THEN COALESCE(squarespace_order_ownerrez_links.matched_at, excluded.matched_at)
                      ELSE NULL END
  `).run(order.id, candidateId, contact.id, status, method, confidence, status);
  return { ownerrezBookingId: candidateId, status, method, confidence };
}

function upsertOrder(db, order, {
  customer = null,
  config = {},
  ownerrezBooking = null,
  notify = true,
} = {}) {
  if (!order?.id || !order.createdOn || !order.modifiedOn) throw new Error('Squarespace order is missing id/timestamps');
  const previous = db.prepare('SELECT payment_state, fulfillment_status, modified_on FROM squarespace_orders WHERE order_id=?')
    .get(order.id);
  const contact = ensureCrmContact(db, { customer, order });
  ensureCustomerStub(db, order, contact);
  const identity = orderIdentity(order, customer);
  const booking = extractBookingFields(order);
  const currency = moneyCurrency(order.grandTotal) || moneyCurrency(order.subtotal);
  db.prepare(`
    INSERT INTO squarespace_orders (
      order_id, order_number, squarespace_customer_id, contact_id, customer_email,
      customer_name, customer_phone, booking_source, channel, channel_name,
      created_on, modified_on, fulfillment_status, payment_state, currency,
      subtotal_value, discount_total_value, shipping_total_value, tax_total_value,
      grand_total_value, service_start_date, service_end_date, guest_count,
      property_hint, form_submission_json, raw_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'direct', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET
      order_number=excluded.order_number,
      squarespace_customer_id=COALESCE(excluded.squarespace_customer_id, squarespace_orders.squarespace_customer_id),
      contact_id=excluded.contact_id,
      customer_email=COALESCE(excluded.customer_email, squarespace_orders.customer_email),
      customer_name=COALESCE(excluded.customer_name, squarespace_orders.customer_name),
      customer_phone=COALESCE(excluded.customer_phone, squarespace_orders.customer_phone),
      channel=excluded.channel, channel_name=excluded.channel_name,
      modified_on=excluded.modified_on, fulfillment_status=excluded.fulfillment_status,
      payment_state=excluded.payment_state, currency=excluded.currency,
      subtotal_value=excluded.subtotal_value, discount_total_value=excluded.discount_total_value,
      shipping_total_value=excluded.shipping_total_value, tax_total_value=excluded.tax_total_value,
      grand_total_value=excluded.grand_total_value,
      service_start_date=COALESCE(excluded.service_start_date, squarespace_orders.service_start_date),
      service_end_date=COALESCE(excluded.service_end_date, squarespace_orders.service_end_date),
      guest_count=COALESCE(excluded.guest_count, squarespace_orders.guest_count),
      property_hint=COALESCE(excluded.property_hint, squarespace_orders.property_hint),
      form_submission_json=excluded.form_submission_json, raw_json=excluded.raw_json,
      synced_at=datetime('now')
  `).run(
    order.id, text(order.orderNumber), text(order.customerId), contact.id, identity.email,
    identity.name, identity.phone, text(order.channel), text(order.channelName),
    order.createdOn, order.modifiedOn, text(order.fulfillmentStatus), text(order.paymentState), currency,
    moneyValue(order.subtotal), moneyValue(order.discountTotal), moneyValue(order.shippingTotal),
    moneyValue(order.taxTotal), moneyValue(order.grandTotal), booking.startDate, booking.endDate,
    booking.guestCount, booking.propertyHint, JSON.stringify(order.formSubmission || []), JSON.stringify(order)
  );

  db.prepare('DELETE FROM squarespace_order_items WHERE order_id=?').run(order.id);
  const insertItem = db.prepare(`INSERT INTO squarespace_order_items (
    order_id, line_item_id, product_id, variant_id, sku, title, line_item_type,
    department, quantity, currency, unit_price_value, line_total_value,
    customizations_json, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const departments = new Set();
  (order.lineItems || []).forEach((item, index) => {
    const department = classifyLineItem(item, config);
    departments.add(department);
    const unitPrice = item.unitPricePaid || item.unitPrice || item.nonSaleUnitPrice;
    const total = item.lineItemTotal || item.total || item.totalValue;
    const calculatedTotal = total || (unitPrice && Number.isFinite(Number(item.quantity))
      ? { value: Number(unitPrice.value) * Number(item.quantity), currency: unitPrice.currency }
      : null);
    insertItem.run(
      order.id, text(item.id) || `${order.id}:${index}`, text(item.productId), text(item.variantId),
      text(item.sku), text(item.title || item.productName), text(item.lineItemType), department,
      Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : null,
      moneyCurrency(calculatedTotal) || moneyCurrency(unitPrice) || currency,
      moneyValue(unitPrice), moneyValue(calculatedTotal),
      JSON.stringify(item.customizations || item.variantOptions || []), JSON.stringify(item)
    );
  });
  const link = linkOwnerRez(db, order, contact, config, ownerrezBooking);

  const changed = !previous || previous.payment_state !== order.paymentState
    || previous.fulfillment_status !== order.fulfillmentStatus || previous.modified_on !== order.modifiedOn;
  if (changed && notify) {
    const eventType = previous ? 'order_updated' : 'order_created';
    const payload = {
      order_id: order.id,
      order_number: order.orderNumber || null,
      guest: identity.name,
      email: identity.email,
      start_date: booking.startDate,
      end_date: booking.endDate,
      guest_count: booking.guestCount,
      payment_state: order.paymentState || null,
      fulfillment_status: order.fulfillmentStatus || null,
      grand_total: moneyValue(order.grandTotal),
      currency,
      ownerrez_booking_id: link.ownerrezBookingId,
      ownerrez_match_status: link.status,
      departments: [...departments],
    };
    const baseKey = `${order.id}:${order.modifiedOn}:${eventType}`;
    enqueue(db, `${baseKey}:business-intel`, 'business-intel', eventType, order.id, payload);
    enqueue(db, `${baseKey}:accounting`, 'accounting', eventType, order.id, payload);
    if (['PAID', 'PARTIALLY_PAID'].includes(order.paymentState)) {
      enqueue(db, `${baseKey}:reservations`, 'reservations', eventType, order.id, payload);
    }
    if (departments.has('housekeeping')) {
      enqueue(db, `${baseKey}:housekeeping`, 'housekeeping', eventType, order.id, payload);
    }
  }
  return { contact, link, departments: [...departments], changed };
}

function upsertTransactionDocument(db, document) {
  if (!document?.id || !document.modifiedOn) throw new Error('Squarespace transaction document is missing id/modifiedOn');
  const orderId = text(document.salesOrderId);
  const currency = moneyCurrency(document.total) || moneyCurrency(document.totalNetPayment);
  db.prepare(`
    INSERT INTO squarespace_transaction_documents (
      document_id, order_id, customer_email, created_on, modified_on, currency,
      total_sales_value, total_net_sales_value, total_payment_value,
      total_net_payment_value, total_tax_value, voided, gateway_error, raw_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(document_id) DO UPDATE SET
      order_id=excluded.order_id, customer_email=excluded.customer_email,
      created_on=excluded.created_on, modified_on=excluded.modified_on, currency=excluded.currency,
      total_sales_value=excluded.total_sales_value,
      total_net_sales_value=excluded.total_net_sales_value,
      total_payment_value=excluded.total_payment_value,
      total_net_payment_value=excluded.total_net_payment_value,
      total_tax_value=excluded.total_tax_value, voided=excluded.voided,
      gateway_error=excluded.gateway_error, raw_json=excluded.raw_json, synced_at=datetime('now')
  `).run(
    document.id, orderId, normalizeEmail(document.customerEmail), text(document.createdOn), document.modifiedOn,
    currency, moneyValue(document.totalSales), moneyValue(document.totalNetSales),
    moneyValue(document.total), moneyValue(document.totalNetPayment), moneyValue(document.totalTaxes),
    document.voided ? 1 : 0, text(document.paymentGatewayError), JSON.stringify(document)
  );

  db.prepare('DELETE FROM squarespace_payments WHERE document_id=?').run(document.id);
  const insertPayment = db.prepare(`INSERT INTO squarespace_payments (
    payment_id, document_id, order_id, provider, paid_on, currency, amount_value,
    net_amount_value, refunded_amount_value, external_transaction_id,
    credit_card_type, raw_json, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
  const insertFee = db.prepare(`INSERT INTO squarespace_processing_fees (
    fee_id, payment_id, order_id, currency, amount_value, net_amount_value,
    refunded_amount_value, raw_json, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
  const insertRefund = db.prepare(`INSERT INTO squarespace_refunds (
    refund_id, payment_id, order_id, refunded_on, currency, amount_value,
    external_transaction_id, raw_json, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

  for (const payment of document.payments || []) {
    const paymentId = text(payment.id);
    if (!paymentId) continue;
    insertPayment.run(
      paymentId, document.id, orderId, text(payment.provider), text(payment.paidOn),
      moneyCurrency(payment.amount) || currency, moneyValue(payment.amount), moneyValue(payment.netAmount),
      moneyValue(payment.refundedAmount), text(payment.externalTransactionId), text(payment.creditCardType),
      JSON.stringify(payment)
    );
    for (const fee of payment.processingFees || []) {
      if (!fee.id) continue;
      insertFee.run(
        fee.id, paymentId, orderId, moneyCurrency(fee.amount) || currency,
        moneyValue(fee.amount), moneyValue(fee.netAmount), moneyValue(fee.refundedAmount), JSON.stringify(fee)
      );
    }
    for (const refund of payment.refunds || []) {
      if (!refund.id) continue;
      insertRefund.run(
        refund.id, paymentId, orderId, text(refund.refundedOn), moneyCurrency(refund.amount) || currency,
        moneyValue(refund.amount), text(refund.externalTransactionId), JSON.stringify(refund)
      );
    }
  }
}

function applyTransactionSummaries(db, wrappers) {
  const update = db.prepare(`UPDATE squarespace_customers SET
    first_order_on=?, last_order_on=?, order_count=?, total_order_value=?,
    total_refund_value=?, currency=?, synced_at=datetime('now')
    WHERE squarespace_customer_id=?`);
  for (const wrapper of wrappers || []) {
    const summary = wrapper.transactionsSummary || {};
    update.run(
      text(summary.firstOrderSubmittedOn), text(summary.lastOrderSubmittedOn),
      Number.isInteger(summary.orderCount) ? summary.orderCount : null,
      moneyValue(summary.totalOrderAmount), moneyValue(summary.totalRefundAmount),
      moneyCurrency(summary.totalOrderAmount) || moneyCurrency(summary.totalRefundAmount),
      wrapper.contactId
    );
  }
}

module.exports = {
  DEFAULT_DEPARTMENTS,
  applyTransactionSummaries,
  classifyLineItem,
  ensureCrmContact,
  extractBookingFields,
  extractTitleDates,
  moneyCurrency,
  moneyValue,
  normalizeEmail,
  normalizePhone,
  orderIdentity,
  upsertCustomer,
  upsertOrder,
  upsertTransactionDocument,
};
