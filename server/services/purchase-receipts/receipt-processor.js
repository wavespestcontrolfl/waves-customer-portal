/**
 * purchase-receipts/receipt-processor.js — turns one parsed Amazon delivery
 * item into a purchase_receipt_lines row, and, when it resolves cleanly, an
 * actual stock movement through the EXISTING restock/adjust paths
 * (inventory-operations.js's adjustStock / updateRestockRequest) rather than
 * raw SQL.
 *
 * Idempotency: purchase_receipt_lines has a UNIQUE (vendor, order_number,
 * line_no). Every call first checks for an existing row (cheap, covers the
 * ordinary re-run case) and then, for the 'logged' path, claims the row with
 * an insert BEFORE calling the shared restock/adjust path — that insert's
 * ON CONFLICT ... IGNORE is the at-most-once guard against a concurrent
 * second run claiming the same line. If the restock/adjust call throws
 * after the claim, the claim row is deleted so the next sweep retries the
 * line rather than leaving it silently stuck. See the module's PR report
 * for the one narrow crash window this can't close (a process kill between
 * the movement committing and this module's own follow-up update) — an
 * accepted tradeoff of reusing the shared, already-transactional adjust
 * path instead of re-implementing its locking here.
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

async function existingLine(vendor, orderNumber, lineNo, conn = db) {
  return conn('purchase_receipt_lines').where({ vendor, order_number: orderNumber, line_no: lineNo }).first();
}

/**
 * @param {{email, orderNumber, item, lineNo}} params
 * @returns one of:
 *   { skipped: true }                                             — already processed
 *   { status: 'unmatched'|'size_mismatch'|'needs_size', inserted: true }
 *   { status: 'logged', product, receivedQty, receivedUnit, movement, viaRequest }
 */
async function processReceiptLine({ email, orderNumber, item, lineNo }, conn = db) {
  const vendor = VENDOR;
  if (!orderNumber) {
    logger.warn(`[purchase-receipts] email ${email?.id} has no Order # — skipping line ${lineNo}`);
    return { skipped: true, reason: 'no_order_number' };
  }
  if (await existingLine(vendor, orderNumber, lineNo, conn)) return { skipped: true, reason: 'already_processed' };

  const classified = await classifyItem(item, conn);
  const baseRow = {
    email_id: email?.id || null, vendor, order_number: orderNumber, line_no: lineNo,
    raw_title: item.title, quantity: item.quantity, product_id: classified.productId || null,
  };

  if (classified.status !== 'logged') {
    const inserted = await conn('purchase_receipt_lines').insert({
      ...baseRow, received_qty: null, received_unit: null, status: classified.status,
    }).onConflict(['vendor', 'order_number', 'line_no']).ignore().returning('*');
    if (!inserted?.length) return { skipped: true, reason: 'already_processed' };
    return { status: classified.status, inserted: true, product: classified.product || null };
  }

  const claimed = await conn('purchase_receipt_lines').insert({
    ...baseRow, received_qty: classified.receivedQty, received_unit: classified.receivedUnit, status: 'logged',
  }).onConflict(['vendor', 'order_number', 'line_no']).ignore().returning('*');
  if (!claimed?.length) return { skipped: true, reason: 'already_processed' };
  const claim = claimed[0];

  const extraMetadata = { source: SOURCE, orderNumber, emailId: email?.id || null, rawTitle: item.title };
  try {
    const liveRequest = await findLiveRestockRequest(conn, classified.productId);
    const result = liveRequest
      ? await updateRestockRequest(liveRequest.id, {
        action: 'receive', quantity: classified.receivedQty, unit: classified.receivedUnit,
      }, { source: SOURCE, extraMetadata })
      : await adjustStock(classified.productId, {
        movementType: 'restock', quantity: classified.receivedQty, unit: classified.receivedUnit,
      }, { source: SOURCE, extraMetadata });

    await conn('purchase_receipt_lines').where({ id: claim.id }).update({
      movement_id: result.movement.id, restock_request_id: liveRequest ? liveRequest.id : null,
    });
    return {
      status: 'logged', product: classified.product, receivedQty: classified.receivedQty,
      receivedUnit: classified.receivedUnit, movement: result.movement, viaRequest: Boolean(liveRequest),
    };
  } catch (err) {
    // Roll back the claim so the next sweep retries this line instead of
    // treating a failed movement as permanently handled.
    await conn('purchase_receipt_lines').where({ id: claim.id }).del().catch((delErr) => {
      logger.error(`[purchase-receipts] could not roll back claim ${claim.id} after a failed restock: ${delErr.message}`);
    });
    throw err;
  }
}

module.exports = { classifyItem, processReceiptLine, VENDOR, SOURCE };
