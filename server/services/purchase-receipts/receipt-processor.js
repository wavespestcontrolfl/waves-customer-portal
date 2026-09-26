/**
 * purchase-receipts/receipt-processor.js — turns one parsed Amazon delivery
 * item into a purchase_receipt_lines row, and, when it resolves cleanly, an
 * actual stock movement through the EXISTING restock/adjust paths
 * (inventory-operations.js's adjustStock / updateRestockRequest) rather than
 * raw SQL.
 *
 * Idempotency: purchase_receipt_lines has a UNIQUE (vendor, order_number,
 * shipment_key, line_no) — shipment_key because ONE order can arrive as
 * several separate Delivered emails (split shipments), each with the SAME
 * order_number: keying on (vendor, order_number, line_no) alone would make
 * the second shipment's line collide with, and be dropped as a duplicate
 * of, the first (see the migration's header and sweep.js/parser for where
 * shipmentKey comes from). Every call first checks for an existing row
 * (cheap, covers the ordinary re-run case, but not itself the guard) and
 * then, for the 'logged' path, runs the claim insert, the restock/adjust
 * write (via adjustStock/updateRestockRequest's options.trx — the SAME
 * transaction, not a nested one of their own) and the claim's movement_id
 * update all inside ONE db.transaction (performLoggedMovement). A failure
 * anywhere in that transaction rolls back everything, including the claim
 * insert — the next sweep simply sees no row and retries the line cleanly,
 * no manual delete-on-failure compensation needed. The claim insert's own
 * ON CONFLICT ... IGNORE (inside the transaction) is the at-most-once guard
 * against a concurrent second run claiming the same line; it returning no
 * row is a normal "already claimed" outcome, not a failure.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { matchAmazonTitleToProduct } = require('./product-matcher');
const { parsePackSize } = require('../product-costing');
const { convertInventoryQuantity } = require('../inventory-units');
const { findLiveRestockRequest } = require('../procurement/live-restock-request');
const { adjustStock, updateRestockRequest } = require('../inventory-operations');

const VENDOR = 'amazon';
const SOURCE = 'amazon_delivery';
// A converted title size within 1% of the container size (min 0.01 unit)
// counts as agreement — the same rounding slack the label/rate-render side
// of this codebase already tolerates for pack-size text.
function sizesAgree(convertedAmount, containerAmount) {
  const tolerance = Math.max(0.01, Math.abs(containerAmount) * 0.01);
  return Math.abs(convertedAmount - containerAmount) <= tolerance;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// Pure classification: match + parse + compare, no DB writes. Exported for
// direct unit testing of the size/mismatch rules without touching the DB.
async function classifyItem(item, conn = db) {
  const match = await matchAmazonTitleToProduct(item.title, conn);
  if (!match.matched) return { status: 'unmatched', productId: null };

  const product = match.product;
  const containerParsed = parsePackSize(product.container_size);
  if (!containerParsed) return { status: 'needs_size', productId: product.id, product };

  const titleParsed = parsePackSize(item.title);
  if (titleParsed) {
    const converted = convertInventoryQuantity(titleParsed.amount, titleParsed.unit, containerParsed.unit);
    if (converted == null || !sizesAgree(converted, containerParsed.amount)) {
      return { status: 'size_mismatch', productId: product.id, product };
    }
  }

  const receivedQty = round4(item.quantity * containerParsed.amount);
  const receivedUnit = containerParsed.unit;
  return { status: 'logged', productId: product.id, product, receivedQty, receivedUnit };
}

async function existingLine(vendor, orderNumber, shipmentKey, lineNo, conn = db) {
  return conn('purchase_receipt_lines').where({ vendor, order_number: orderNumber, shipment_key: shipmentKey, line_no: lineNo }).first();
}

const ON_CONFLICT_KEYS = ['vendor', 'order_number', 'shipment_key', 'line_no'];

// Insert-and-claim, shared by every terminal (non-'logged'-in-progress) row
// shape below: returns the saved row, or null when a concurrent run already
// claimed this exact (vendor, order_number, shipment_key, line_no).
async function claimLine(conn, row) {
  const inserted = await conn('purchase_receipt_lines').insert(row).onConflict(ON_CONFLICT_KEYS).ignore().returning('*');
  return inserted?.length ? inserted[0] : null;
}

/**
 * @param {{email, orderNumber, shipmentKey, item, lineNo, forcedStatus}} params
 *   forcedStatus: set to 'no_items' for the one placeholder row an itemless
 *   Delivered email gets (see sweep.js) — skips matching/classification
 *   entirely; `item` is then just `{ title: <subject>, quantity: 1 }`.
 * @returns one of:
 *   { skipped: true }                                             — already processed
 *   { status: 'unmatched'|'size_mismatch'|'needs_size'|'no_items', inserted: true }
 *   { status: 'logged', product, receivedQty, receivedUnit, movement, viaRequest }
 */
async function processReceiptLine({ email, orderNumber, shipmentKey, item, lineNo, forcedStatus }, conn = db) {
  const vendor = VENDOR;
  if (!orderNumber) {
    logger.warn(`[purchase-receipts] email ${email?.id} has no Order # — skipping line ${lineNo}`);
    return { skipped: true, reason: 'no_order_number' };
  }
  // Falls back the same way the parser does: an email with no discoverable
  // shipmentId still gets its own claim rather than colliding with another
  // shipment on the same order.
  const resolvedShipmentKey = shipmentKey || email?.gmail_id || email?.id || null;
  if (!resolvedShipmentKey) {
    logger.warn(`[purchase-receipts] email ${email?.id} has no shipment key at all — skipping line ${lineNo}`);
    return { skipped: true, reason: 'no_shipment_key' };
  }
  if (await existingLine(vendor, orderNumber, resolvedShipmentKey, lineNo, conn)) return { skipped: true, reason: 'already_processed' };

  if (forcedStatus) {
    const saved = await claimLine(conn, {
      email_id: email?.id || null, vendor, order_number: orderNumber, shipment_key: resolvedShipmentKey, line_no: lineNo,
      raw_title: item.title, quantity: item.quantity, product_id: null, received_qty: null, received_unit: null, status: forcedStatus,
    });
    if (!saved) return { skipped: true, reason: 'already_processed' };
    return { status: forcedStatus, inserted: true, product: null };
  }

  const classified = await classifyItem(item, conn);
  const baseRow = {
    email_id: email?.id || null, vendor, order_number: orderNumber, shipment_key: resolvedShipmentKey, line_no: lineNo,
    raw_title: item.title, quantity: item.quantity, product_id: classified.productId || null,
  };

  if (classified.status !== 'logged') {
    const saved = await claimLine(conn, { ...baseRow, received_qty: null, received_unit: null, status: classified.status });
    if (!saved) return { skipped: true, reason: 'already_processed' };
    return { status: classified.status, inserted: true, product: classified.product || null };
  }

  // Claim + movement + claim-update all inside ONE transaction: a throw
  // anywhere (the claim insert racing a concurrent claimant aside — that's
  // a normal no-row outcome, not a throw) rolls back the whole thing, so
  // there is never a claim row left behind with no movement to show for it.
  return conn.transaction(async (trx) => {
    const claim = await claimLine(trx, { ...baseRow, received_qty: classified.receivedQty, received_unit: classified.receivedUnit, status: 'logged' });
    if (!claim) return { skipped: true, reason: 'already_processed' };
    return performLoggedMovement(trx, { claim, classified, orderNumber, email, item });
  });
}

// The actual restock write for an already-claimed 'logged' line, through the
// shared adjustStock / updateRestockRequest path — on the SAME transaction
// (options.trx) the claim was inserted on, so a failure here rolls back the
// claim too. Split out of processReceiptLine purely to keep that function's
// own branching flat.
async function performLoggedMovement(trx, { claim, classified, orderNumber, email, item }) {
  const extraMetadata = { source: SOURCE, orderNumber, emailId: email?.id || null, rawTitle: item.title };
  const liveRequest = await findLiveRestockRequest(trx, classified.productId);
  const result = liveRequest
    ? await updateRestockRequest(liveRequest.id, {
      action: 'receive', quantity: classified.receivedQty, unit: classified.receivedUnit,
    }, { source: SOURCE, extraMetadata, trx })
    : await adjustStock(classified.productId, {
      movementType: 'restock', quantity: classified.receivedQty, unit: classified.receivedUnit,
    }, { source: SOURCE, extraMetadata, trx });

  await trx('purchase_receipt_lines').where({ id: claim.id }).update({
    movement_id: result.movement.id, restock_request_id: liveRequest ? liveRequest.id : null,
  });
  return {
    status: 'logged', product: classified.product, receivedQty: classified.receivedQty,
    receivedUnit: classified.receivedUnit, movement: result.movement, viaRequest: Boolean(liveRequest),
  };
}

module.exports = { classifyItem, processReceiptLine, VENDOR, SOURCE };
