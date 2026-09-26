/**
 * purchase-receipts/receipt-processor.js — turns one parsed Amazon delivery
 * item into a purchase_receipt_lines row and, when it resolves cleanly, a
 * stock movement through the EXISTING adjustStock path
 * (inventory-operations.js), never raw SQL.
 *
 * Stock only. This lane never closes, receives or otherwise writes a
 * product_restock_requests row: three audit rounds each found a new way an
 * automatic close could pick the wrong request (vendor guess, then order
 * number, then a lock race with a manual receipt), so it was removed. When
 * the product has a live (open|ordered) request, the logged bell says so
 * and a person decides.
 *
 * Title sizing is exception-based. A line auto-logs only when its title
 * carries exactly one readable size that agrees with the catalog container,
 * plus at most one recognized pack marker ("2 x 78 oz", "(Pack of 2)",
 * "2-Pack", "Case of 2", "Set of 2"). A title with no readable size logs
 * from container_size alone only on an exact product_aliases match (the
 * owner vetted that exact title); on a name-containment match it is held,
 * so a size spelled in a unit this parser doesn't know is never read as
 * "no size". Any other pack or count wording, two different sizes, or a
 * size that disagrees with the container is 'size_mismatch' — held for a
 * person (sweep.js rings a bell), never a guessed amount.
 *
 * Idempotency: purchase_receipt_lines is UNIQUE (vendor, order_number,
 * shipment_key, line_no) — shipment_key because one order can arrive as
 * several Delivered emails with the same Order #. Every line runs in ONE
 * transaction: the product-row lock and a second classification under it
 * (so a catalog edit that committed meanwhile is what counts), the claim
 * insert, the duplicate check, adjustStock (options.trx), the movement_id
 * update and the line's bell (the caller's ringBell, which writes the
 * notification on the same transaction). A failure anywhere — a bell that
 * can't be saved included — rolls it all back, and the next sweep retries
 * the line from scratch. The claim's ON CONFLICT DO NOTHING is the
 * at-most-once guard against a concurrent run.
 *
 * An email with no readable "Order #" (a template change) is keyed under
 * order_number 'unknown' by its shipment; a line that would move stock is
 * held as 'no_order_number' instead, so it surfaces for review rather than
 * vanishing.
 *
 * A shipment already handed to a person — undelivered-shipments.js recorded
 * it as 'no_delivery_email' and asked for a hand log because its Delivered
 * email never came — is never auto-logged when that email arrives late:
 * the box would be counted twice. Every writer of a shipment's lines takes
 * the same per-shipment advisory lock (lockShipment), so the alert and a
 * late Delivered email can't both act on it.
 *
 * Duplicate-receipt guard: the claim only catches the SAME email twice. If
 * staff already put the box on the shelf by hand, the line is held as
 * 'possible_duplicate' (no movement) when the product has a 'restock'
 * movement from any other source since 48h before the email's received_at,
 * or a 'correction' at or after received_at (a count taken once the box had
 * landed already includes it). A correction BEFORE received_at never holds:
 * routine morning counts precede that day's deliveries.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { matchAmazonTitleToProduct } = require('./product-matcher');
const { parsePackSize } = require('../product-costing');
const { convertInventoryQuantity } = require('../inventory-units');
const { LIVE_RESTOCK_STATUSES } = require('../procurement/live-restock-request');
const { adjustStock } = require('../inventory-operations');

const VENDOR = 'amazon';
const SOURCE = 'amazon_delivery';
const DUPLICATE_RESTOCK_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const UNKNOWN_ORDER = 'unknown';
const HANDED_TO_PERSON = Object.freeze({ skipped: true, reason: 'asked_to_log_by_hand' });
const ALREADY_PROCESSED = Object.freeze({ skipped: true, reason: 'already_processed' });

// Within 1% (min 0.01 unit) counts as agreement — the rounding slack the
// pack-size text elsewhere in this codebase already tolerates.
function sizesAgree(amount, reference) {
  return Math.abs(amount - reference) <= Math.max(0.01, Math.abs(reference) * 0.01);
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// The pack markers this lane counts, found anywhere in the title.
// parsePackSize (product-costing.js) reads a multiplier only at the very
// START of its input, because its callers pass bare pack-size text; an
// Amazon title leads with the product name. The matched marker is stripped
// before sizing, so its count is applied exactly once.
const MULTIPACK_PATTERNS = [
  /(\d+)\s*[x×]\s*(?=\d)/i, // "2 x 78 oz", "2×78 oz"
  /pack\s+of\s+(\d+)/i, // "(Pack of 2)"
  /(\d+)\s*-?\s*pack\b/i, // "2-Pack", "2 Pack"
  /case\s+of\s+(\d+)/i, // "Case of 12"
  /set\s+of\s+(\d+)/i, // "Set of 4"
];

// Pack or count wording left over once a recognized marker (if any) is
// stripped: "Twin Pack", "Pack of Two", "2 Count", "2ct", "78 oz x 2",
// "(2) jugs", a second marker. The title claims a unit count this lane
// can't read, so the line goes to a person.
const PACK_CLAIM_RE = /(?:\b|(?<=\d))(?:packs?|pks?|count|ct|qty|twin|bundle|cases?|sets?)\b|(?:^|[^a-z])[x×]\s*\d|\d\s*[x×](?![a-z])|\(\s*\d+\s*\)/i;

// Plural containers with no recognized marker ("2 Bottles", "4 tubes / 30
// g"): more than one unit, in a form this lane doesn't count.
const PLURAL_CONTAINER_RE = /(?:\b|(?<=\d))(?:bottles|jugs|tubes|bags|cans|pails|pouches|cartridges|pcs|pieces)\b/i;

// One "<number> <unit>" size claim: mixed number (1 1/2), fraction (1/2),
// decimal or integer, with the unit adjacent ("96oz"), spaced ("96 oz") or
// hyphenated ("2.5-Gallon"); an optional second word covers "fl oz". A
// number glued to a word on its left ("EC3") is part of a name, not a size.
const TITLE_SIZE_RE = /(?<![a-z\d./])(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)[\s-]*([a-z]+)\.?(?:[\s.-]*([a-z]+)\.?)?/gi;

// Title unit spellings -> inventory-units.js units.
const SIZE_UNITS = [
  [/^(?:fl ?oz|fluid ?ounces?)$/, 'fl_oz'],
  [/^(?:oz|ozs|ounces?)$/, 'oz'],
  [/^(?:gal|gals|gallons?)$/, 'gal'],
  [/^(?:qt|qts|quarts?)$/, 'qt'],
  [/^(?:pt|pts|pints?)$/, 'pt'],
  [/^(?:lbs?|pounds?)$/, 'lb'],
  [/^(?:g|grams?)$/, 'g'],
  [/^(?:kg|kilograms?)$/, 'kg'],
  [/^(?:ml|cc|millilit(?:er|re)s?)$/, 'ml'],
  [/^(?:l|ltrs?|lit(?:er|re)s?)$/, 'l'],
];

function sizeUnit(words) {
  const text = words.toLowerCase();
  return SIZE_UNITS.find(([pattern]) => pattern.test(text))?.[1] || null;
}

// "1 1/2" -> 1.5, "1/2" -> 0.5, "2.5" -> 2.5. A zero denominator yields a
// non-finite number, which convertInventoryQuantity rejects.
function parseSizeNumber(text) {
  const parts = text.trim().split(/\s+/);
  const [numerator, denominator] = parts.pop().split('/');
  const value = denominator === undefined ? Number(numerator) : Number(numerator) / Number(denominator);
  return parts.length ? Number(parts[0]) + value : value;
}

// Every size claim in `text`, converted to the container's unit and
// de-duplicated ("1 Gallon (128 fl oz)" is one size). null when a claim
// can't be converted to that unit, so it can't be checked at all.
function titleSizes(text, containerUnit) {
  const sizes = [];
  for (const [, number, first, second] of text.matchAll(TITLE_SIZE_RE)) {
    const unit = (second && sizeUnit(`${first} ${second}`)) || sizeUnit(first);
    if (!unit) continue;
    const amount = convertInventoryQuantity(parseSizeNumber(number), unit, containerUnit);
    if (amount == null) return null;
    if (!sizes.some((size) => sizesAgree(amount, size))) sizes.push(amount);
  }
  return sizes;
}

function parseMultipack(title) {
  for (const pattern of MULTIPACK_PATTERNS) {
    const match = title.match(pattern);
    if (match && Number(match[1]) > 0) return { count: Number(match[1]), rest: title.replace(pattern, ' ') };
  }
  return null;
}

// How much product one ordered item carries, in the container's unit, or
// null when the title's own size/pack wording can't be squared with the
// catalog container. aliasMatch: the title is an owner-vetted alias, the
// one case where a title with no readable size may lean on container_size.
function amountPerItem(title, container, aliasMatch) {
  const multipack = parseMultipack(title);
  const rest = multipack ? multipack.rest : title;
  if (PACK_CLAIM_RE.test(rest) || (!multipack && PLURAL_CONTAINER_RE.test(rest))) return null;
  const sizes = titleSizes(rest, container.unit);
  if (!sizes || sizes.length > 1) return null;
  const [size] = sizes;
  if (size === undefined) return aliasMatch && !multipack ? container.amount : null;
  const count = multipack ? multipack.count : 1;
  // The title's per-unit size is one catalog container: the pack multiplies containers.
  if (sizesAgree(size, container.amount)) return count * container.amount;
  // The catalog container is already the whole pack.
  return multipack && sizesAgree(size * count, container.amount) ? container.amount : null;
}

// Pure classification (match + sizing, no writes). Exported for unit tests.
async function classifyItem(item, conn = db) {
  const match = await matchAmazonTitleToProduct(item.title, conn);
  if (!match.matched) return { status: 'unmatched', productId: null };
  const { product } = match;
  const container = parsePackSize(product.container_size);
  if (!container) return { status: 'needs_size', productId: product.id, product };
  const perItem = amountPerItem(String(item.title), container, match.matchType === 'alias');
  if (perItem == null) return { status: 'size_mismatch', productId: product.id, product };
  return { status: 'logged', productId: product.id, product, receivedQty: round4(item.quantity * perItem), receivedUnit: container.unit };
}

// Insert-and-claim: the saved row, or null when a concurrent run already
// claimed this (vendor, order_number, shipment_key, line_no).
async function claimLine(conn, row) {
  const inserted = await conn('purchase_receipt_lines').insert(row)
    .onConflict(['vendor', 'order_number', 'shipment_key', 'line_no']).ignore().returning('*');
  return inserted?.length ? inserted[0] : null;
}

// Serializes every writer of one shipment's lines (a Delivered line, the
// undelivered alert) for the rest of the transaction.
function lockShipment(trx, shipmentKey) {
  return trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`purchase-receipt-shipment:${shipmentKey}`]);
}

// Classify, and for a line that would move stock, lock its product row and
// classify again under the lock: a container_size edit or a deactivation
// that committed after the first read is what counts.
async function classifyUnderLock(item, trx) {
  const first = await classifyItem(item, trx);
  if (first.status !== 'logged') return first;
  await trx('products_catalog').where({ id: first.productId }).forUpdate().first('id');
  const locked = await classifyItem(item, trx);
  // A different product matches now; its row isn't locked, so start over next sweep.
  if (locked.status === 'logged' && locked.productId !== first.productId) {
    throw new Error(`matched product changed while processing "${item.title}"; retrying next sweep`);
  }
  return locked;
}

/**
 * @param {{email, orderNumber, shipmentKey, item, lineNo, forcedStatus, ringBell}} params
 *   orderNumber: may be null (no readable Order #) — keyed as 'unknown'.
 *   shipmentKey: the parser's (shipmentId, else the email's gmail_id / id).
 *   forcedStatus: 'no_items' for the one placeholder line an itemless
 *   Delivered email gets (sweep.js) — no matching or sizing at all.
 *   ringBell(outcome, trx): writes the line's bell on its transaction.
 * @returns one of (every recorded outcome carries lineId):
 *   { skipped: true, reason }                                    — nothing written
 *     (reason 'asked_to_log_by_hand': the shipment was handed to a person)
 *   { status: 'unmatched'|'size_mismatch'|'needs_size'|'no_items'|'no_order_number', inserted: true, product }
 *   { status: 'possible_duplicate', product, receivedQty, receivedUnit }  — held, no movement
 *   { status: 'logged', product, receivedQty, receivedUnit, movement, hasOpenRestockRequest }
 */
async function processReceiptLine({ email, orderNumber, shipmentKey, item, lineNo, forcedStatus, ringBell = async () => {} }, conn = db) {
  if (!shipmentKey) {
    logger.warn(`[purchase-receipts] email ${email.id} line ${lineNo}: no shipment key, skipped`);
    return { skipped: true, reason: 'no_shipment_key' };
  }
  const key = { vendor: VENDOR, order_number: orderNumber || UNKNOWN_ORDER, shipment_key: shipmentKey, line_no: lineNo };
  if (await conn('purchase_receipt_lines').where(key).first('id')) return { ...ALREADY_PROCESSED };

  return conn.transaction(async (trx) => {
    await lockShipment(trx, shipmentKey);
    if (await trx('purchase_receipt_lines').where({ vendor: VENDOR, shipment_key: shipmentKey, status: 'no_delivery_email' }).first('id')) {
      return { ...HANDED_TO_PERSON };
    }
    let classified = forcedStatus ? { status: forcedStatus, productId: null, product: null } : await classifyUnderLock(item, trx);
    if (!orderNumber && classified.status === 'logged') {
      classified = { status: 'no_order_number', productId: classified.productId, product: classified.product };
    }
    const claim = await claimLine(trx, {
      ...key, email_id: email.id, raw_title: item.title, quantity: item.quantity, product_id: classified.productId,
      received_qty: classified.receivedQty ?? null, received_unit: classified.receivedUnit ?? null, status: classified.status,
    });
    if (!claim) return { ...ALREADY_PROCESSED };
    const outcome = classified.status === 'logged'
      ? await performLoggedMovement(trx, { claim, classified, orderNumber, email, item })
      : { status: classified.status, inserted: true, product: classified.product || null };
    await ringBell({ ...outcome, lineId: claim.id }, trx);
    return { ...outcome, lineId: claim.id };
  });
}

// A movement already on the ledger that may be this same box: a restock
// from any other source since 48h before the email, or a count/correction
// at or after it (see the header).
function findPossibleDuplicateMovement(trx, productId, receivedAt) {
  const received = new Date(receivedAt);
  return trx('product_inventory_movements')
    .where({ product_id: productId })
    .where((either) => either
      .where((restock) => restock
        .where('movement_type', 'restock')
        .whereRaw("(metadata ->> 'source') IS DISTINCT FROM ?", [SOURCE])
        .where('created_at', '>=', new Date(received.getTime() - DUPLICATE_RESTOCK_LOOKBACK_MS)))
      .orWhere((correction) => correction
        .where('movement_type', 'correction')
        .where('created_at', '>=', received)))
    .first('id');
}

// The claimed 'logged' line's write, on the claim's own transaction. The
// product row is already locked (classifyUnderLock), so no manual
// adjustment commits between the duplicate check and the movement;
// adjustStock locks the same row again, which Postgres treats as a no-op.
async function performLoggedMovement(trx, { claim, classified, orderNumber, email, item }) {
  const { product, receivedQty, receivedUnit } = classified;
  if (await findPossibleDuplicateMovement(trx, classified.productId, email.received_at)) {
    await trx('purchase_receipt_lines').where({ id: claim.id }).update({ status: 'possible_duplicate' });
    return { status: 'possible_duplicate', product, receivedQty, receivedUnit };
  }

  const result = await adjustStock(classified.productId, { movementType: 'restock', quantity: receivedQty, unit: receivedUnit },
    { source: SOURCE, extraMetadata: { orderNumber, emailId: email.id, rawTitle: item.title }, trx });
  await trx('purchase_receipt_lines').where({ id: claim.id }).update({ movement_id: result.movement.id });
  // Read-only: the bell mentions a live request; this lane never writes one.
  const liveRequest = await trx('product_restock_requests')
    .where({ product_id: classified.productId }).whereIn('status', LIVE_RESTOCK_STATUSES).first('id');
  return { status: 'logged', product, receivedQty, receivedUnit, movement: result.movement, hasOpenRestockRequest: Boolean(liveRequest) };
}

module.exports = { classifyItem, processReceiptLine, lockShipment, VENDOR, SOURCE, UNKNOWN_ORDER };
