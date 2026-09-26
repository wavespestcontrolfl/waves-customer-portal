/**
 * purchase-receipts/undelivered-shipments.js — Amazon shipments whose
 * "Delivered:" email never came.
 *
 * Amazon skips the Delivered email for about 1 in 6 shipments (5 of 29
 * since April; the Sep 13 Gentrol was one), and the Delivered lane can't
 * see those deliveries. Each sweep (sweep.js, after its Delivered pass)
 * looks at authenticated "Shipped:" emails between SHIPPED_GRACE_MS and
 * SHIPPED_LOOKBACK_MS old (never before PURCHASE_RECEIPT_SINCE). The
 * longest real shipped-to-delivered gap is 56 hours, so a shipment still
 * unconfirmed after 3 days is treated as one whose email was skipped.
 *
 * A shipment is settled once purchase_receipt_lines has any row for its
 * shipmentId: its Delivered email was processed (every authenticated one
 * leaves at least one row), or it was already alerted. The lookback keeps
 * every such Delivered email inside the Delivered pass's own 7-day window,
 * so a delivery that did get its email is always settled first. Otherwise,
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
const { formatETDate } = require('../../utils/datetime-et');
const { parseAmazonShippedEmail, AMAZON_SHIPPED_FROM } = require('./amazon-delivery-parser');
const { matchAmazonTitleToProduct } = require('./product-matcher');
const { VENDOR, UNKNOWN_ORDER, lockShipment } = require('./receipt-processor');

const DAY_MS = 24 * 60 * 60 * 1000;
const SHIPPED_GRACE_MS = 3 * DAY_MS;
const SHIPPED_LOOKBACK_MS = 7 * DAY_MS;

function shipmentSettled(conn, shipmentId) {
  return conn('purchase_receipt_lines').where({ vendor: VENDOR, shipment_key: shipmentId }).first('id');
}

async function stockedItems(items, conn) {
  const stocked = [];
  for (const [index, item] of items.entries()) {
    const match = await matchAmazonTitleToProduct(item.title, conn);
    if (match.matched) stocked.push({ item, lineNo: index + 1, product: match.product });
  }
  return stocked;
}

async function ringUndeliveredBell(notifyAdmin, { email, parsed, stocked, trx }) {
  const what = stocked.map(({ item, product }) => `${product.name} ×${item.quantity}`).join(', ');
  const body = `Amazon shipped ${what} on ${formatETDate(new Date(email.received_at))} but never sent a delivery confirmation, `
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
// to alert (not one we can check, already settled, or no stocked item).
async function alertIfUndelivered(email, notifyAdmin, conn) {
  const parsed = parseAmazonShippedEmail(email);
  if (!parsed?.shipmentId || !parsed.items.length) return null;
  if (!hasAlignedAuth(email.authentication_results, domainFromAddress(email.from_address))) return null;
  if (await shipmentSettled(conn, parsed.shipmentId)) return null;
  const stocked = await stockedItems(parsed.items, conn);
  if (!stocked.length) return null;
  return conn.transaction(async (trx) => {
    await lockShipment(trx, parsed.shipmentId);
    // A Delivered email for it may have been processed since the check above.
    if (await shipmentSettled(trx, parsed.shipmentId)) return null;
    await trx('purchase_receipt_lines').insert(stocked.map(({ item, lineNo, product }) => ({
      vendor: VENDOR, order_number: parsed.orderNumber || UNKNOWN_ORDER, shipment_key: parsed.shipmentId, line_no: lineNo,
      email_id: email.id, raw_title: item.title, quantity: item.quantity, product_id: product.id, status: 'no_delivery_email',
    })));
    await ringUndeliveredBell(notifyAdmin, { email, parsed, stocked, trx });
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
    .where('received_at', '>=', new Date(Math.max(since.getTime(), now - SHIPPED_LOOKBACK_MS)))
    .where('received_at', '<=', new Date(now - SHIPPED_GRACE_MS))
    .orderBy('received_at', 'asc');
  const result = { undelivered: [], errors: [] };
  for (const email of emails) {
    try {
      const alerted = await alertIfUndelivered(email, notifyAdmin, conn);
      if (alerted) result.undelivered.push({ ...alerted, emailId: email.id });
    } catch (err) {
      logger.error(`[purchase-receipts] undelivered check for email ${email.id} failed: ${err.message}`);
      result.errors.push({ title: email.subject, message: err.message, emailId: email.id });
    }
  }
  return result;
}

module.exports = { alertUndeliveredShipments, SHIPPED_GRACE_MS };
