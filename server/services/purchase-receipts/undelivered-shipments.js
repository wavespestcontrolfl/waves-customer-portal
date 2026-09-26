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
 * was already alerted), or once any Delivered email names it (one received
 * before the count, which the lane never processes, still proves it
 * arrived). Otherwise,
 * when the shipment carries at least one stocked product, its stocked items
 * are recorded as 'no_delivery_email' and ONE bell asks for a hand log, in
 * one transaction (the bell via notifyAdmin's trx option): a re-run never
 * re-rings, and a bell that can't be saved retries next sweep. Personal
 * items (unmatched) and Shipped emails with no item names ring nothing.
 *
 * Shipped and Delivered emails are joined by the Track link's shipmentId
 * only (every real pair carries it); a Shipped email without one is
 * skipped. The rows also hand the shipment to a person for good: a late
 * Delivered email for it is never auto-logged (receipt-processor.js), so
 * the box can't be counted twice.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { hasAlignedAuth } = require('../email/inbox-hygiene');
const { domainFromAddress } = require('../email/spam-blocker');
const { formatETDate, etParts, etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { parseAmazonShippedEmail, extractText, AMAZON_SHIPPED_FROM, AMAZON_DELIVERY_FROM } = require('./amazon-delivery-parser');
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

async function shipmentSettled(conn, shipmentId) {
  if (await conn('purchase_receipt_lines').where({ vendor: VENDOR, shipment_key: shipmentId }).first('id')) return true;
  const id = likeLiteral(shipmentId);
  const delivered = await conn('emails').whereRaw('LOWER(from_address) = ?', [AMAZON_DELIVERY_FROM]).whereRaw('subject ILIKE ?', ['Delivered:%'])
    .where((named) => named.whereRaw('body_text LIKE ?', [`%shipmentId=${id}%`]).orWhereRaw('body_html LIKE ?', [`%shipmentId\\%3D${id}%`]))
    .first('id');
  return Boolean(delivered);
}

async function stockedItems(items, conn) {
  const stocked = [];
  for (const [index, item] of items.entries()) {
    const match = await matchTitleToProduct(item.title, conn);
    if (match.matched) stocked.push({ item, lineNo: index + 1, product: match.product });
  }
  return stocked;
}

async function ringUndeliveredBell(notifyAdmin, { email, parsed, stocked, promised, trx }) {
  const what = stocked.map(({ item, product }) => (item.quantity ? `${product.name} ×${item.quantity}` : product.name)).join(', ');
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
  if (!hasAlignedAuth(email.authentication_results, domainFromAddress(email.from_address))) return null;
  if (await shipmentSettled(conn, parsed.shipmentId)) return null;
  const stocked = await stockedItems(parsed.items, conn);
  if (!stocked.length) return null;
  return conn.transaction(async (trx) => {
    await lockShipment(trx, VENDOR, parsed.shipmentId);
    // A Delivered email for it may have been processed since the check above.
    if (await shipmentSettled(trx, parsed.shipmentId)) return null;
    await trx('purchase_receipt_lines').insert(stocked.map(({ item, lineNo, product }) => ({
      vendor: VENDOR, order_number: parsed.orderNumber || UNKNOWN_ORDER, shipment_key: parsed.shipmentId, line_no: lineNo,
      email_id: email.id, raw_title: item.title, quantity: item.quantity ?? 0, product_id: product.id, status: 'no_delivery_email',
    })));
    await ringUndeliveredBell(notifyAdmin, { email, parsed, stocked, promised, trx });
    return { shipmentId: parsed.shipmentId, orderNumber: parsed.orderNumber, titles: stocked.map(({ item }) => item.title) };
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

module.exports = { alertUndeliveredShipments, alertAfter };
