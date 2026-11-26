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
 *   1. the invoice's printed purchase order equals the PO the Mac adapter
 *      typed into SiteOne for THAT order (order-dispatch.js poNumberFor of
 *      the request's ledger row, compared trimmed and case-insensitively). A
 *      different or missing PO closes nothing: an unrelated SiteOne invoice
 *      of the same product (a counter purchase) must never clear the guard
 *      on an order that is still out, or the sweep would order a second time;
 *   2. the product has exactly ONE live (open|ordered) request, of any
 *      source, and it is 'ordered' with source 'auto_reorder';
 *   3. its vendor_orders row is a 'placed' SiteOne order with placed_at set,
 *      not revoked, placed BEFORE the invoice email was received;
 *   4. the ledger recorded the dispatched quantity (orderedQuantityFor), and
 *      the invoice line's quantity, in the line's unit, is at least that. No
 *      fallback to requested_quantity: SiteOne rounds up to whole packages.
 * Anything else (a hand-raised request, an 'open' one, two live requests, a
 * short quantity, an order placed after the email, no PO) is left alone, and
 * the logged bell still tells a person to cancel it.
 *
 * The request becomes 'received' WITHOUT a second stock movement (the
 * receipt movement already added the stock) and its ledger bells settle the
 * way a manual receive settles them (settleRequestLedgerBells).
 *
 * Locks: the caller holds the product row lock. This takes vendor_orders,
 * then the request, FOR UPDATE NOWAIT, after the checks above passed on an
 * unlocked read. A manual receive takes vendor_orders -> request -> product,
 * the reverse of the product-first order here, so waiting would deadlock
 * against it. When the matched request is held, this THROWS: the receipt
 * line's transaction rolls back (its stock too) and the next sweep retries
 * the line, whose duplicate check then sees the manual receive's committed
 * movement. Skipping the lock instead would commit this invoice's stock
 * while the manual receive, waiting on the product row, added the same
 * delivery again.
 */
const { LIVE_RESTOCK_STATUSES } = require('../procurement/live-restock-request');
const { restockMeta } = require('../inventory-restock-queue');
const { convertInventoryQuantity } = require('../inventory-units');

const ROBOT_SOURCE = 'auto_reorder';
const ROBOT_ADAPTER = 'siteone';
// Postgres lock_not_available: what FOR UPDATE NOWAIT raises on a held row.
const LOCK_NOT_AVAILABLE = '55P03';

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

// The PO the Mac adapter typed for this order, against the invoice's printed
// one. Blank on either side never matches.
function purchaseOrderMatches(ledger, purchaseOrder) {
  const printed = typeof purchaseOrder === 'string' ? purchaseOrder.trim().toLowerCase() : '';
  if (!printed || !ledger?.id) return false;
  const { _internals } = require('../procurement/order-dispatch');
  return printed === String(_internals.poNumberFor(ledger)).trim().toLowerCase();
}

// What the order bought, in the invoice line's unit; null when the ledger
// recorded no dispatched quantity, or it cannot be converted (nothing closes
// then).
// Both sides in the ORDER's unit (where dispatch rounded the ordered quantity to four decimals): a
// 78 fl oz package ordered as 0.6094 gal converts back to 78.0032 fl oz, and would never be covered
// by a 78 fl oz line. Returns { line, ordered }, or null when either side cannot be converted.
async function quantitiesInOrderUnit(trx, request, product, lineQty, lineUnit) {
  const { orderedQuantityFor } = require('../procurement/order-dispatch');
  const ordered = await orderedQuantityFor(trx, request.id);
  const unit = request.unit || product?.inventory_unit;
  if (!(ordered > 0) || !unit || !lineUnit) return null;
  const line = convertInventoryQuantity(Number(lineQty), lineUnit, unit);
  return line == null ? null : { line, ordered };
}

const REQUEST_HELD = 'RESTOCK_REQUEST_HELD';

async function onlyLiveRequest(trx, productId) {
  const live = await trx('product_restock_requests').where({ product_id: productId })
    .whereIn('status', LIVE_RESTOCK_STATUSES).select('id', 'status', 'source');
  return live.length === 1 && isRobotOrderedRequest(live[0]) ? live[0] : null;
}

// Read the request and its ledger row; locked = vendor_orders then request,
// FOR UPDATE NOWAIT. A held row throws (see the header).
async function readRobotRequest(trx, requestId, locked) {
  try {
    const ledgerQuery = trx('vendor_orders').where({ restock_request_id: requestId });
    const requestQuery = trx('product_restock_requests').where({ id: requestId });
    const ledger = await (locked ? ledgerQuery.forUpdate().noWait() : ledgerQuery).first();
    const request = ledger ? await (locked ? requestQuery.forUpdate().noWait() : requestQuery).first() : null;
    return { ledger, request };
  } catch (err) {
    if (err?.code !== LOCK_NOT_AVAILABLE) throw err;
    // A recognizable code: the inventory agent leaves its queued line pending without spending an attempt.
    throw Object.assign(new Error(`restock request ${requestId} is held by another action; this invoice line retries on the next sweep`), { code: REQUEST_HELD });
  }
}

// Every condition, on one read of the rows; the order dispatched is what the
// line must cover.
// The unlocked pre-check stops at the PO: a line with the robot's own PO always takes the NOWAIT
// locks before its quantity is tested, so a short line also meets a manual receive that holds the
// request (and rolls back to retry) instead of committing stock the receive then adds again.
async function coveredRequest(trx, args, requestId, locked) {
  const { ledger, request } = await readRobotRequest(trx, requestId, locked);
  if (!isRobotOrderedRequest(request) || !ledgerPlacedBefore(ledger, args.email.received_at)) return null;
  if (!purchaseOrderMatches(ledger, args.purchaseOrder)) return null;
  if (!locked) return request;
  const both = await quantitiesInOrderUnit(trx, request, args.product, args.receivedQty, args.receivedUnit);
  return both && lineCoversOrder(both.line, both.ordered) ? request : null;
}

/**
 * Close the robot's own SiteOne request this logged invoice line covers.
 * Call in the line's transaction after its movement, with the product row
 * locked. Returns the closed request id, or null when nothing was closed.
 * Throws when the matched request is held by another transaction.
 */
async function closeRequestCoveredByLine(trx, args) {
  const { vendor, productId, email, orderNumber, lineNo, movementId } = args;
  if (vendor !== 'siteone' || !args.purchaseOrder) return null;
  const candidate = await onlyLiveRequest(trx, productId);
  if (!candidate || !(await coveredRequest(trx, args, candidate.id, false))) return null;
  const request = await coveredRequest(trx, args, candidate.id, true);
  if (!request) return null;

  const closed = await trx('product_restock_requests').where({ id: candidate.id, status: 'ordered' }).update({
    status: 'received', closed_at: new Date(), closed_by: null, updated_at: new Date(),
    metadata: {
      ...restockMeta(request.metadata),
      closedByReceipt: { emailId: email.id, orderNumber: orderNumber || null, lineNo, movementId: movementId || null, purchaseOrder: String(args.purchaseOrder).trim() },
    },
  });
  if (!closed) return null;
  await require('../procurement/order-dispatch').settleRequestLedgerBells(trx, candidate.id);
  return candidate.id;
}

module.exports = { closeRequestCoveredByLine, isRobotOrderedRequest, ledgerPlacedBefore, lineCoversOrder, purchaseOrderMatches, REQUEST_HELD };
