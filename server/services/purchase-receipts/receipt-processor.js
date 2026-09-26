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
const { LIVE_RESTOCK_STATUSES } = require('../procurement/live-restock-request');
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

// Multipack markers, scanned ANYWHERE in the title — deliberately a SEPARATE,
// local parse, not a change to parsePackSize (product-costing.js): that
// function only ever reads a leading "N x " multiplier at the very start of
// the string, because its other callers (vendor pricing display) hand it
// just the pack-size text with the product name already stripped off. An
// Amazon item title puts the product name FIRST ("Taurus SC 2 x 78 oz",
// "Taurus SC 78 oz (Pack of 2)"), so parsePackSize's own multiplier check
// never fires there and it silently reads only the per-unit size — this is
// what under-logs a multipack delivery by the pack factor. "count" (e.g.
// "Summit Mosquito Dunk Tablets 20 count") is deliberately NOT a multipack
// marker — that is the product's own each-count sizing, not a pack of packs.
//
// A LEADING "N x SIZE" ("2 x 78 oz Taurus SC") is the one form parsePackSize
// DOES already multiply on its own (its own multiplier check is anchored to
// the very start of the string) — sizing the ORIGINAL title there would
// apply the multiplier TWICE (once inside parsePackSize, once here). The fix
// is the same for every form and every position: strip the matched marker
// text out of the title BEFORE handing it to parsePackSize, so parsePackSize
// only ever sees the bare per-unit size and parseMultipack's own count is
// applied exactly once, regardless of where the marker sat.
const MULTIPACK_PATTERNS = [
  /(\d+)\s*[x×]\s*(?=\d)/i, // "2 x 78 oz", "2×78 oz" — multiplier immediately before a size number (lookahead: leaves the size digits in place for the strip)
  /pack\s+of\s+(\d+)/i, // "(Pack of 2)", "Pack of 2"
  /(\d+)\s*-?\s*pack\b/i, // "2-Pack", "2 Pack"
  /case\s+of\s+(\d+)/i, // "Case of 12"
  /set\s+of\s+(\d+)/i, // "Set of 4"
];

// Returns { count, sanitizedTitle } for the first marker found, or null.
// sanitizedTitle is ONLY for re-parsing the per-unit size — item.title
// itself (matching, raw_title, the bell) is never touched.
function parseMultipack(title) {
  const text = String(title || '');
  for (const pattern of MULTIPACK_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    return { count: n, sanitizedTitle: text.replace(pattern, ' ') };
  }
  return null;
}

// Pure classification: match + parse + compare, no DB writes. Exported for
// direct unit testing of the size/mismatch rules without touching the DB.
async function classifyItem(item, conn = db) {
  const match = await matchAmazonTitleToProduct(item.title, conn);
  if (!match.matched) return { status: 'unmatched', productId: null };

  const product = match.product;
  const containerParsed = parsePackSize(product.container_size);
  if (!containerParsed) return { status: 'needs_size', productId: product.id, product };

  const multipack = parseMultipack(item.title);
  if (multipack) {
    // Sized from the SANITIZED title (marker stripped) so a leading "N x "
    // — which parsePackSize would otherwise already have multiplied on its
    // own — is never multiplied a second time here. A multipack marker with
    // no parseable per-unit size is never assumed — straight to
    // size_mismatch, same as any other unresolvable size claim.
    const titleParsed = parsePackSize(multipack.sanitizedTitle);
    const perUnitConverted = titleParsed ? convertInventoryQuantity(titleParsed.amount, titleParsed.unit, containerParsed.unit) : null;
    if (perUnitConverted == null) return { status: 'size_mismatch', productId: product.id, product };

    let perItemAmount;
    if (sizesAgree(perUnitConverted, containerParsed.amount)) {
      // The title's per-unit size IS the catalog container size: the pack
      // multiplies the container count, not its size.
      perItemAmount = multipack.count * containerParsed.amount;
    } else if (sizesAgree(perUnitConverted * multipack.count, containerParsed.amount)) {
      // The catalog container already represents the WHOLE pack (e.g. a
      // case-sized catalog row) — the pack math is already baked in.
      perItemAmount = containerParsed.amount;
    } else {
      return { status: 'size_mismatch', productId: product.id, product };
    }
    return { status: 'logged', productId: product.id, product, receivedQty: round4(item.quantity * perItemAmount), receivedUnit: containerParsed.unit };
  }

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
 *   { status: 'logged', product, receivedQty, receivedUnit, movement, viaRequest, leftoverRequest }
 *   leftoverRequest (non-null only when viaRequest is false and exactly one
 *   OTHER live request exists): { vendor, status } — a request this delivery
 *   did NOT qualify to close, for the bell to name explicitly.
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

function normalizeOrderNumber(value) {
  return String(value || '').trim().toLowerCase();
}

// True only when this 'ordered' request's OWN linked vendor order (vendor_orders,
// UNIQUE on restock_request_id — see its migration header, "one row per
// automatic order attempt") carries the SAME external_order_number as the
// order this email delivered. Order identity, not a vendor guess: two
// different vendors can both be "Amazon" in casual text, and a request's
// plain `vendor` column is never authoritative for which physical order it
// tracks. No linked vendor order, no recorded number, or a different number
// -> false (this delivery must not close a DIFFERENT order placed with
// Amazon, e.g. a prior restock still in transit).
async function orderedRequestMatchesDelivery(conn, request, normalizedOrderNumber) {
  if (!normalizedOrderNumber) return false;
  const vendorOrder = await conn('vendor_orders').where({ restock_request_id: request.id }).first('external_order_number');
  return Boolean(vendorOrder?.external_order_number) && normalizeOrderNumber(vendorOrder.external_order_number) === normalizedOrderNumber;
}

/**
 * Which live (open/ordered) restock request, if any, THIS delivery should
 * mark received — never just the oldest one (the earlier behavior, and
 * wrong: a delivery must not close an unrelated order).
 *   - 'open' (a need, no order placed with anyone yet) qualifies whatever
 *     vendor it names — the need is real regardless of who fills it.
 *   - 'ordered' qualifies ONLY when its OWN linked vendor order's
 *     external_order_number matches the order THIS email delivered —
 *     order identity, never a vendor-name guess (see
 *     orderedRequestMatchesDelivery above).
 * Exactly one qualifying request -> receive it. Zero or 2+ (ambiguous) ->
 * receive none, adjust stock directly; when exactly one OTHER live request
 * is left dangling in that case, it is returned as `leftover` so the bell
 * can name it instead of silently leaving it open with no explanation.
 */
async function selectRestockRequestOutcome(trx, productId, orderNumber) {
  const liveRequests = await trx('product_restock_requests').where({ product_id: productId }).whereIn('status', LIVE_RESTOCK_STATUSES);
  if (!liveRequests.length) return { toReceive: null, leftover: null };
  const normalizedOrderNumber = normalizeOrderNumber(orderNumber);
  const qualifiesFlags = await Promise.all(liveRequests.map((r) => (
    r.status === 'open' ? Promise.resolve(true) : orderedRequestMatchesDelivery(trx, r, normalizedOrderNumber)
  )));
  const qualifying = liveRequests.filter((_, i) => qualifiesFlags[i]);
  if (qualifying.length === 1) return { toReceive: qualifying[0], leftover: null };
  const nonQualifying = liveRequests.filter((_, i) => !qualifiesFlags[i]);
  // Only named when it is the SOLE live request and unambiguous — two or
  // more leftover requests get no specific call-out (nothing to disambiguate).
  const leftover = liveRequests.length === 1 && nonQualifying.length === 1 ? nonQualifying[0] : null;
  return { toReceive: null, leftover };
}

// The actual restock write for an already-claimed 'logged' line, through the
// shared adjustStock / updateRestockRequest path — on the SAME transaction
// (options.trx) the claim was inserted on, so a failure here rolls back the
// claim too. Split out of processReceiptLine purely to keep that function's
// own branching flat.
async function performLoggedMovement(trx, { claim, classified, orderNumber, email, item }) {
  const extraMetadata = { source: SOURCE, orderNumber, emailId: email?.id || null, rawTitle: item.title };
  const { toReceive: liveRequest, leftover } = await selectRestockRequestOutcome(trx, classified.productId, orderNumber);
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
    leftoverRequest: leftover ? { vendor: leftover.vendor || null, status: leftover.status } : null,
  };
}

module.exports = { classifyItem, processReceiptLine, VENDOR, SOURCE };
