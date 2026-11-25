/**
 * purchase-receipts/siteone-request-close.js — the ONE place the receipt lane
 * writes a product_restock_requests row (see receipt-processor.js's header).
 *
 * The auto-order robot places a SiteOne order for an automatic request and
 * leaves the request 'ordered'. When the invoice for that order is logged
 * (stock added), the request must close or it blocks every later automatic
 * request for the product. The close is deliberately narrow: it happens only
 * when the invoice line can be tied to the robot's own order without
 * guessing:
 *   1. the product has exactly ONE live (open|ordered) request, of any
 *      source, and it is 'ordered' with source 'auto_reorder';
 *   2. its vendor_orders row is a 'placed' SiteOne order with placed_at set,
 *      not revoked, placed BEFORE the invoice email was received;
 *   3. the invoice line's quantity, in the line's unit, is at least what the
 *      ledger says was ordered (orderedQuantityFor, else requested_quantity).
 * Anything else (a hand-raised request, an 'open' one, two live requests, a
 * short quantity, an order placed after the email) is left alone, and the
 * logged bell still tells a person to cancel it.
 *
 * The request becomes 'received' WITHOUT a second stock movement (the
 * receipt movement already added the stock) and its ledger bells settle the
 * way a manual receive settles them (settleRequestLedgerBells).
 *
 * Locks: the caller holds the product row lock. This takes vendor_orders,
 * then the request, FOR UPDATE SKIP LOCKED. A manual receive takes
 * vendor_orders -> request -> product, the reverse of the product-first order
 * here, so waiting would deadlock against it; a row somebody else holds is
 * simply left (the person who holds it is already handling the request).
 */
const { LIVE_RESTOCK_STATUSES } = require('../procurement/live-restock-request');
const { restockMeta } = require('../inventory-restock-queue');
const { convertInventoryQuantity } = require('../inventory-units');

const ROBOT_SOURCE = 'auto_reorder';
const ROBOT_ADAPTER = 'siteone';

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// A live request the robot itself ordered: 'ordered', raised by the
// auto-reorder sweep. A hand-raised request never matches.
function isRobotOrderedRequest(request) {
  return Boolean(request) && request.status === 'ordered' && request.source === ROBOT_SOURCE;
}

function revokedAt(evidence) {
  const parsed = typeof evidence === 'string' ? safeParse(evidence) : evidence;
  return parsed && parsed.revokedAt ? parsed.revokedAt : null;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// The ledger row is a SiteOne order the robot placed (vendor call returned),
// still standing, and dispatched before this invoice email arrived — an
// invoice older than the order cannot be for it.
function ledgerPlacedBefore(ledger, receivedAt) {
  if (!ledger || ledger.status !== 'placed' || ledger.adapter !== ROBOT_ADAPTER || !ledger.placed_at) return false;
  if (revokedAt(ledger.evidence)) return false;
  const placed = new Date(ledger.placed_at).getTime();
  const received = new Date(receivedAt).getTime();
  return Number.isFinite(placed) && Number.isFinite(received) && placed < received;
}

// The invoice line brought at least what the order bought (both in the
// same unit). A short line may be one of several, so it never closes.
function lineCoversOrder(lineQty, orderedQty) {
  const line = Number(lineQty);
  const ordered = Number(orderedQty);
  if (!(line > 0) || !(ordered > 0)) return false;
  return round4(line) >= round4(ordered);
}

// What the order bought, in the invoice line's unit; null when it cannot be
// read or converted (nothing closes then).
async function orderedQuantityInUnit(trx, request, product, lineUnit) {
  const { orderedQuantityFor } = require('../procurement/order-dispatch');
  const quantity = (await orderedQuantityFor(trx, request.id)) ?? Number(request.requested_quantity);
  const unit = request.unit || product?.inventory_unit;
  if (!(quantity > 0) || !unit || !lineUnit) return null;
  return convertInventoryQuantity(quantity, unit, lineUnit);
}

async function onlyLiveRequest(trx, productId) {
  const live = await trx('product_restock_requests').where({ product_id: productId })
    .whereIn('status', LIVE_RESTOCK_STATUSES).select('id', 'status', 'source');
  return live.length === 1 && isRobotOrderedRequest(live[0]) ? live[0] : null;
}

async function lockRobotRequest(trx, requestId) {
  // Ledger first, then the request: the manual paths' order. SKIP LOCKED so a
  // holder that now waits for the product row (ours) never deadlocks with us.
  const ledger = await trx('vendor_orders').where({ restock_request_id: requestId }).forUpdate().skipLocked().first();
  if (!ledger) return null;
  const request = await trx('product_restock_requests').where({ id: requestId }).forUpdate().skipLocked().first();
  return request ? { ledger, request } : null;
}

/**
 * Close the robot's own SiteOne request this logged invoice line covers.
 * Call in the line's transaction after its movement, with the product row
 * locked. Returns the closed request id, or null when nothing was closed.
 */
async function closeRequestCoveredByLine(trx, { vendor, productId, product, email, orderNumber, lineNo, movementId, receivedQty, receivedUnit }) {
  if (vendor !== 'siteone') return null;
  const candidate = await onlyLiveRequest(trx, productId);
  if (!candidate) return null;
  const locked = await lockRobotRequest(trx, candidate.id);
  if (!locked || !isRobotOrderedRequest(locked.request) || !ledgerPlacedBefore(locked.ledger, email.received_at)) return null;
  const ordered = await orderedQuantityInUnit(trx, locked.request, product, receivedUnit);
  if (!lineCoversOrder(receivedQty, ordered)) return null;

  const closed = await trx('product_restock_requests').where({ id: candidate.id, status: 'ordered' }).update({
    status: 'received', closed_at: new Date(), closed_by: null, updated_at: new Date(),
    metadata: { ...restockMeta(locked.request.metadata), closedByReceipt: { emailId: email.id, orderNumber: orderNumber || null, lineNo, movementId: movementId || null } },
  });
  if (!closed) return null;
  await require('../procurement/order-dispatch').settleRequestLedgerBells(trx, candidate.id);
  return candidate.id;
}

module.exports = { closeRequestCoveredByLine, isRobotOrderedRequest, ledgerPlacedBefore, lineCoversOrder };
