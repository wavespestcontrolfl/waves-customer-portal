/**
 * purchase-receipts/undelivered-shipments.js — Amazon shipments whose
 * "Delivered:" email never came.
 *
 * Amazon skips the Delivered email for about 1 in 6 shipments (5 of 29
 * since April; the Sep 13 Gentrol was one), and the Delivered lane can't
 * see those deliveries. Each sweep (sweep.js, after its Delivered pass)
 * looks at authenticated "Shipped:" emails up to SHIPPED_LOOKBACK_MS old. A
 * shipment belongs before or after the physical count at
 * PURCHASE_RECEIPT_SINCE by when it was DUE, not when it shipped: one due
 * before the count day is in that count; one shipped before it but due
 * after is not, and is still flagged. A shipment still unconfirmed once
 * its promised arrival day ("Arriving today" / "tomorrow" / "Wednesday" /
 * "June 16 - June 18" -> the last day, read on the ET calendar) and the day
 * after have both passed is treated as one whose email was skipped: every
 * real Delivered email came on or before its promised day. A Shipped email
 * that promises no day waits SHIPPED_GRACE_MS (3 days; the longest real
 * shipped-to-delivered gap is 56 hours).
 *
 * A shipment is settled once purchase_receipt_lines has any row for its
 * shipmentId (its Delivered email was processed — every authenticated one
 * leaves at least one row, and sweep.js runs its Delivered pass first — or it
 * was already alerted), or once an authenticated Delivered email names it
 * exactly (one received before the count, which the lane never processes,
 * still proves it arrived). Otherwise,
 * when the shipment carries at least one stocked product, its stocked items
 * are recorded as 'no_delivery_email' and ONE bell asks for a hand log, in
 * one transaction (the bell via notifyAdmin's trx option): a re-run never
 * re-rings, and a bell that can't be saved retries next sweep. Personal
 * items (unmatched) and Shipped emails with no item names ring nothing.
 *
 * Shipped and Delivered emails are joined by the Track link's shipmentId
 * (a Shipped email without one is skipped), but the id is not always the
 * same in the two emails: the 2026-10 Gentrol order's Shipped and Delivered
 * emails carried different ids, and the Delivered one had already stocked
 * the box. So, when the order has exactly ONE authenticated Shipped email,
 * its items are also settled by the order's authenticated Delivered lines
 * under other shipment ids (deliveredElsewhere): each delivered line's
 * quantity is spent at most once across the shipment's items, and only the
 * uncovered quantity rings. An order with two or more authenticated Shipped
 * emails (a split order) is ambiguous and never suppressed this way. A bell
 * already rung for a shipment that proves delivered under the same rule is
 * closed (closeDeliveredUndeliveredBells). The rows also hand the shipment
 * to a person for good: a late
 * Delivered email for it is never auto-logged (receipt-processor.js), so
 * the box can't be counted twice.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { hasAlignedAuth } = require('../email/inbox-hygiene');
const { domainFromAddress } = require('../email/spam-blocker');
const { formatETDate, etParts, etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const {
  parseAmazonShippedEmail, parseAmazonDeliveredEmail, extractText, AMAZON_SHIPPED_FROM, AMAZON_DELIVERY_FROM,
} = require('./amazon-delivery-parser');
const { matchTitleToProduct } = require('./product-matcher');
const { UNKNOWN_ORDER, lockShipment } = require('./receipt-processor');

const VENDOR = 'amazon';
const DAY_MS = 24 * 60 * 60 * 1000;
const SHIPPED_GRACE_MS = 3 * DAY_MS;
const SHIPPED_LOOKBACK_MS = 14 * DAY_MS;
// No alert can come sooner: "Arriving today" still waits out the next day.
const MIN_ALERT_AGE_MS = DAY_MS;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "June 16", "Sep 16", or a range "June 16 - June 18" / "June 16 - 18" at
// the start of the phrase; the range's end is the promised day.
const MONTH_DAY_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b(?:\s*[-–]\s*(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(\d{1,2})\b)?/;

// The ET day a Shipped email promises, as an addETDays-style carrier (noon
// UTC of that calendar date), or null when it names none. The phrase is
// read from the parser's text (body_text, else stripped HTML, where it can
// run on into the rest of the line), capped to the promise itself.
function promisedArrivalDay(text, shippedAt) {
  const phrase = (String(text || '').match(/^\s*arriving\s+(.{1,40})/im) || [])[1]?.toLowerCase();
  if (!phrase) return null;
  if (phrase.startsWith('today')) return addETDays(shippedAt, 0);
  if (phrase.startsWith('tomorrow')) return addETDays(shippedAt, 1);
  const weekday = WEEKDAYS.findIndex((name) => phrase.startsWith(name));
  // "Arriving Wednesday" sent on a Wednesday means next week ("today" otherwise).
  if (weekday >= 0) return addETDays(shippedAt, ((weekday - etParts(shippedAt).dayOfWeek + 7) % 7) || 7);
  const date = phrase.match(MONTH_DAY_RE);
  if (!date) return null;
  const [, startMonth, startDay, endMonth, endDay] = date;
  const month = MONTHS.indexOf(endMonth || startMonth);
  const day = Number(endDay || startDay);
  const { year } = etParts(shippedAt);
  const onYear = (y) => new Date(Date.UTC(y, month, day, 12));
  // Shipped late December, promised early January.
  return onYear(year) < addETDays(shippedAt, -1) ? onYear(year + 1) : onYear(year);
}

// When an unconfirmed shipment counts as one whose Delivered email was
// skipped: ET midnight once its promised day and the day after have
// passed, else SHIPPED_GRACE_MS after the Shipped email. dueBeforeCount:
// the shipment was due before the physical count at `since` (its promised
// ET day is an earlier day, or with no promise its fallback falls before
// the count), so that count already includes it.
function alertAfter(email, since) {
  const shippedAt = new Date(email.received_at);
  const promised = promisedArrivalDay(extractText(email), shippedAt);
  const fallback = new Date(shippedAt.getTime() + SHIPPED_GRACE_MS);
  const at = promised ? parseETDateTime(`${etDateString(addETDays(promised, 2))}T00:00`) : fallback;
  const dueBeforeCount = Boolean(since) && (promised ? etDateString(promised) < etDateString(since) : fallback < since);
  return { at, promised, dueBeforeCount };
}

// A LIKE pattern matching the literal text.
const likeLiteral = (text) => text.replace(/[\\%_]/g, '\\$&');

function authenticated(email) {
  return hasAlignedAuth(email.authentication_results, domainFromAddress(email.from_address));
}

async function shipmentSettled(conn, shipmentId) {
  if (await conn('purchase_receipt_lines').where({ vendor: VENDOR, shipment_key: shipmentId }).first('id')) return true;
  // The id's text narrows the candidates (it appears verbatim in every link
  // form); the parser's own shipmentId must then equal it exactly, from an
  // email that really came from Amazon.
  const id = `%${likeLiteral(shipmentId)}%`;
  const candidates = await conn('emails')
    .select('id', 'gmail_id', 'from_address', 'subject', 'body_text', 'body_html', 'authentication_results')
    .whereRaw('LOWER(from_address) = ?', [AMAZON_DELIVERY_FROM]).whereRaw('subject ILIKE ?', ['Delivered:%'])
    .where((named) => named.whereRaw('body_text LIKE ?', [id]).orWhereRaw('body_html LIKE ?', [id]));
  return candidates.some((email) => parseAmazonDeliveredEmail(email)?.shipmentId === shipmentId && authenticated(email));
}

// Delivered-email line statuses: the line exists because a Delivered email
// named the item, so the box arrived. Whether it was stocked, held (its own
// "not added" bell asks a person) or ruled equipment, someone already has it.
const DELIVERED_LINE_STATUSES = [
  'logged', 'possible_duplicate', 'unmatched', 'needs_size', 'size_mismatch',
  'agent_pending', 'agent_ignored', 'agent_equipment', 'agent_unsure',
];

const normalizeTitle = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// One item identity for both sides: the same product when both name one,
// else the same normalized title.
function sameItem(a, b) {
  if (a.productId && b.productId) return a.productId === b.productId;
  return normalizeTitle(a.title) === normalizeTitle(b.title);
}

// True when the order has exactly one authenticated Shipped email and it
// carries this shipment id. Two or more (a split order) is ambiguous.
async function soleShippedShipment(conn, orderNumber, shipmentId) {
  const like = `%${likeLiteral(orderNumber)}%`;
  const emails = await conn('emails')
    .select('id', 'gmail_id', 'from_address', 'subject', 'body_text', 'body_html', 'authentication_results')
    .whereRaw('LOWER(from_address) = ?', [AMAZON_SHIPPED_FROM]).whereRaw('subject ILIKE ?', ['Shipped:%'])
    .where((named) => named.whereRaw('body_text LIKE ?', [like]).orWhereRaw('body_html LIKE ?', [like]));
  const shipped = emails.filter((email) => authenticated(email)).map((email) => parseAmazonShippedEmail(email))
    .filter((parsed) => parsed?.orderNumber === orderNumber);
  return shipped.length === 1 && shipped[0].shipmentId === shipmentId;
}

/**
 * How much of each shipped item the order's Delivered lines under OTHER
 * shipment ids have not covered. wanted: [{ productId, title, quantity }];
 * returns the missing quantity per index, 0 when covered.
 *
 * Evidence is used only for an order with exactly one authenticated Shipped
 * email (soleShippedShipment); otherwise every item is missing in full, as
 * if no Delivered line existed. A Delivered line counts when it has a
 * Delivered-line status and came from an authenticated Delivered email; its
 * quantity is spent at most once, across all of the wanted items. An item
 * with no readable quantity needs one unit.
 */
async function deliveredElsewhere(conn, { orderNumber, shipmentId, wanted }) {
  const missing = wanted.map((item) => item.quantity || 1);
  if (!orderNumber || orderNumber === UNKNOWN_ORDER || !wanted.length) return missing;
  const lines = await conn('purchase_receipt_lines')
    .where({ vendor: VENDOR, order_number: orderNumber }).whereNot('shipment_key', shipmentId)
    .whereIn('status', DELIVERED_LINE_STATUSES)
    .select('email_id', 'product_id', 'raw_title', 'quantity');
  if (!lines.length) return missing;
  if (!(await soleShippedShipment(conn, orderNumber, shipmentId))) return missing;
  const emails = await conn('emails')
    .select('id', 'from_address', 'authentication_results')
    .whereIn('id', [...new Set(lines.map((line) => line.email_id).filter(Boolean))])
    .whereRaw('LOWER(from_address) = ?', [AMAZON_DELIVERY_FROM]).whereRaw('subject ILIKE ?', ['Delivered:%']);
  const proven = new Set(emails.filter((email) => authenticated(email)).map((email) => String(email.id)));
  const budget = lines.filter((line) => proven.has(String(line.email_id)))
    .map((line) => ({ productId: line.product_id, title: line.raw_title, left: Number(line.quantity) || 0 }));
  return wanted.map((item, index) => {
    for (const line of budget.filter((entry) => entry.left > 0 && sameItem(entry, item))) {
      const take = Math.min(line.left, missing[index]);
      line.left -= take;
      missing[index] -= take;
      if (!missing[index]) break;
    }
    return missing[index];
  });
}

async function stockedItems(items, conn) {
  const stocked = [];
  for (const [index, item] of items.entries()) {
    const match = await matchTitleToProduct(item.title, conn);
    if (match.matched) stocked.push({ item, lineNo: index + 1, product: match.product });
  }
  return stocked;
}

// The ONE evaluation of a Shipped email's whole item list, used by the alert
// pass and the closer alike: its stocked items and, for each, the quantity
// no Delivered line has covered (deliveredElsewhere's single-shipment gate
// and shared budget run over ALL of them together).
async function evaluateShipment(conn, parsed) {
  const stocked = await stockedItems(parsed.items, conn);
  const missing = stocked.length
    ? await deliveredElsewhere(conn, {
      orderNumber: parsed.orderNumber, shipmentId: parsed.shipmentId,
      wanted: stocked.map(({ item, product }) => ({ productId: product.id, title: item.title, quantity: item.quantity })),
    })
    : [];
  return { stocked, missing };
}

async function ringUndeliveredBell(notifyAdmin, { email, parsed, stocked, promised, trx }) {
  const what = stocked.map(({ item, product, remaining }) => {
    const quantity = remaining || item.quantity;
    return quantity ? `${product.name} ×${quantity}` : product.name;
  }).join(', ');
  const due = promised ? ` (due ${formatETDate(promised)})` : '';
  const body = `Amazon shipped ${what} on ${formatETDate(new Date(email.received_at))}${due} but never sent a delivery confirmation, `
    + "so it wasn't added. If it arrived, log it by hand.";
  await notifyAdmin('inventory', 'Amazon delivery not confirmed', body, {
    link: '/admin/inventory?tab=products',
    bell: true,
    dedupeKey: `purchase-receipt-undelivered:${parsed.shipmentId}`,
    trx,
    metadata: { emailId: email.id, shipmentId: parsed.shipmentId, productIds: stocked.map(({ product }) => product.id) },
  });
}

// One Shipped email -> the alerted shipment, or null when there is nothing
// to alert (not due yet, not one we can check, already settled, or no
// stocked item).
async function alertIfUndelivered(email, { notifyAdmin, now, since }, conn) {
  const { at, promised, dueBeforeCount } = alertAfter(email, since);
  if (dueBeforeCount || now < at.getTime()) return null;
  const parsed = parseAmazonShippedEmail(email);
  if (!parsed?.shipmentId || !parsed.items.length) return null;
  if (!authenticated(email)) return null;
  if (await shipmentSettled(conn, parsed.shipmentId)) return null;
  const stocked = await stockedItems(parsed.items, conn);
  if (!stocked.length) return null;
  return conn.transaction(async (trx) => {
    await lockShipment(trx, VENDOR, parsed.shipmentId);
    // A Delivered email for it may have been processed since the check above.
    if (await shipmentSettled(trx, parsed.shipmentId)) return null;
    // Its Delivered email may carry another shipment id: items that email
    // already covers are not undelivered.
    const { missing } = await evaluateShipment(trx, parsed);
    const owed = stocked.map((row, index) => ({ ...row, missing: missing[index], remaining: row.item.quantity ? missing[index] : undefined }))
      .filter((row) => row.missing > 0);
    if (!owed.length) return null;
    await trx('purchase_receipt_lines').insert(owed.map(({ item, lineNo, product }) => ({
      vendor: VENDOR, order_number: parsed.orderNumber || UNKNOWN_ORDER, shipment_key: parsed.shipmentId, line_no: lineNo,
      email_id: email.id, raw_title: item.title, quantity: item.quantity ?? 0, product_id: product.id, status: 'no_delivery_email',
    })));
    await ringUndeliveredBell(notifyAdmin, { email, parsed, stocked: owed, promised, trx });
    return { shipmentId: parsed.shipmentId, orderNumber: parsed.orderNumber, titles: owed.map(({ item }) => item.title) };
  });
}

/**
 * @param {{since: Date, now?: number, notifyAdmin: Function}} params
 * @returns {{undelivered: object[], errors: object[]}}
 */
async function alertUndeliveredShipments({ since, now = Date.now(), notifyAdmin }, conn = db) {
  const emails = await conn('emails')
    .select('id', 'gmail_id', 'from_address', 'subject', 'body_text', 'body_html', 'received_at', 'authentication_results')
    .whereRaw('LOWER(from_address) = ?', [AMAZON_SHIPPED_FROM])
    .whereRaw('subject ILIKE ?', ['Shipped:%'])
    .where('received_at', '>=', new Date(now - SHIPPED_LOOKBACK_MS))
    .where('received_at', '<=', new Date(now - MIN_ALERT_AGE_MS))
    .orderBy('received_at', 'asc');
  const result = { undelivered: [], errors: [] };
  for (const email of emails) {
    try {
      const alerted = await alertIfUndelivered(email, { notifyAdmin, now, since }, conn);
      if (alerted) result.undelivered.push({ ...alerted, emailId: email.id });
    } catch (err) {
      logger.error(`[purchase-receipts] undelivered check for email ${email.id} failed: ${err.message}`);
      result.errors.push({ title: email.subject, message: err.message, emailId: email.id });
    }
  }
  return result;
}

const UNDELIVERED_CLOSER = 'purchase-receipts';

/**
 * Closes "Amazon delivery not confirmed" bells whose shipment turned out to
 * be delivered. It re-reads the bell's Shipped email and runs the alert
 * pass's own evaluation (evaluateShipment) over the whole item list; the
 * bell closes only when nothing is missing. A bell with any item still
 * missing stays open. Failure is the caller's to log.
 */
async function closeDeliveredUndeliveredBells(conn = db) {
  const { openToCloser, doneColumns } = require('../notification-service')._private;
  const open = await conn('notifications')
    .where({ recipient_type: 'admin' }).whereNull('done_at')
    .whereRaw("metadata->>'dedupeKey' LIKE ?", ['purchase-receipt-undelivered:%'])
    .select('id', conn.raw("metadata->>'shipmentId' AS shipment_id"));
  const closable = [];
  for (const bell of open) {
    if (!bell.shipment_id) continue;
    const held = await conn('purchase_receipt_lines')
      .where({ vendor: VENDOR, shipment_key: bell.shipment_id, status: 'no_delivery_email' })
      .first('email_id');
    if (!held?.email_id) continue;
    // Judge the WHOLE shipment from its own Shipped email, exactly as the alert pass does.
    const email = await conn('emails')
      .select('id', 'gmail_id', 'from_address', 'subject', 'body_text', 'body_html').where({ id: held.email_id }).first();
    const parsed = email && parseAmazonShippedEmail(email);
    if (parsed?.shipmentId !== bell.shipment_id) continue;
    const { stocked, missing } = await evaluateShipment(conn, parsed);
    if (!stocked.length) continue;
    if (missing.every((left) => left <= 0)) closable.push(bell.id);
  }
  if (!closable.length) return 0;
  await openToCloser(conn('notifications').where({ recipient_type: 'admin' }).whereIn('id', closable), UNDELIVERED_CLOSER)
    .update(doneColumns({
      by: UNDELIVERED_CLOSER, resolution: 'The delivery email arrived under another shipment id; the items are accounted for', keepExisting: true, conn,
    }));
  return closable.length;
}

module.exports = { alertUndeliveredShipments, alertAfter, deliveredElsewhere, evaluateShipment, closeDeliveredUndeliveredBells };
