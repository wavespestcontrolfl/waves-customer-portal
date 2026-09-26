/**
 * purchase-receipts/sweep.js — the Amazon "Delivered" → auto-restock lane.
 *
 * Gate: GATE_PURCHASE_RECEIPT_RESTOCK, read at call time (gateEnvValue) —
 * unset or any non-truthy value is the live kill switch.
 *
 * PURCHASE_RECEIPT_SINCE (env, ISO timestamp) is a second, independent
 * kill: with it unset, both entry points below do nothing at all, even with
 * the gate on — this is what stops a first activation from replaying every
 * Amazon delivery ever synced (which a physical shelf count already
 * accounts for) as a fresh restock the moment the gate flips.
 *
 * Two entry points sharing one path:
 *   - processReceiptEmail(email): called right after email-sync inserts a
 *     brand-new row (best-effort, fire-and-forget — see email-sync.js).
 *   - runPurchaseReceiptRestockSweep(): the scheduler's ~15-minute safety
 *     net, scanning `emails` directly by from_address + subject (never by
 *     LLM classification, which can lag or misfire) for anything the
 *     per-email hook missed (a process restart mid-sync, the hook's own
 *     error swallow, a backfill).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const {
  parseAmazonDeliveredEmail, parseAmazonOrderSiblingItems,
  AMAZON_DELIVERY_FROM, AMAZON_ORDERED_FROM, AMAZON_SHIPPED_FROM,
} = require('./amazon-delivery-parser');
const { processReceiptLine } = require('./receipt-processor');

const GATE = 'GATE_PURCHASE_RECEIPT_RESTOCK';
// How many recent Ordered:/Shipped: candidates to check for the same Order #
// before giving up on an itemless Delivered email — small and bounded; this
// is an occasional fallback, not the common path.
const SIBLING_LOOKUP_LIMIT = 5;

function sinceBoundary() {
  const raw = process.env.PURCHASE_RECEIPT_SINCE;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function displayUnit(unit) {
  return String(unit || '').replace(/_/g, ' ');
}

async function ringLoggedBell(notifyAdmin, { email, item, outcome }) {
  if (!notifyAdmin) return;
  try {
    const perItemAmount = round(outcome.receivedQty / item.quantity);
    const body = `Amazon delivery logged: ${outcome.product.name} +${outcome.receivedQty} ${displayUnit(outcome.receivedUnit)} `
      + `(${item.quantity} × ${perItemAmount} ${displayUnit(outcome.receivedUnit)})`;
    await notifyAdmin('inventory', 'Amazon delivery logged', body, {
      link: '/admin/inventory?tab=products',
      bell: true,
      dedupeKey: `amazon-delivery:${email?.id}:${item.title}`,
      metadata: { emailId: email?.id || null, productId: outcome.product.id, receivedQty: outcome.receivedQty, receivedUnit: outcome.receivedUnit },
    });
  } catch (err) {
    logger.warn(`[purchase-receipts] bell failed for ${email?.id}: ${err.message}`);
  }
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

// Some Delivered emails ("Delivered: 1 Lawn & Garden item") carry an Order #
// and a Track link but no `* title` blocks at all. Their item titles/
// quantities, when recoverable, live on a SIBLING Ordered:/Shipped: email
// for the SAME order — checked here, but NEVER processed as its own
// delivery (no stock is ever logged from an Ordered/Shipped email itself).
// Bounded, recent-first; the first sibling that actually parses wins.
async function findSiblingItems(orderNumber) {
  if (!orderNumber) return [];
  let candidates;
  try {
    candidates = await db('emails')
      .whereRaw('LOWER(from_address) IN (?, ?)', [AMAZON_ORDERED_FROM, AMAZON_SHIPPED_FROM])
      .where((b) => b.whereILike('body_text', `%${orderNumber}%`).orWhereILike('body_html', `%${orderNumber}%`))
      .orderBy('received_at', 'desc')
      .limit(SIBLING_LOOKUP_LIMIT);
  } catch (err) {
    logger.warn(`[purchase-receipts] sibling email lookup failed for order ${orderNumber}: ${err.message}`);
    return [];
  }
  for (const candidate of candidates) {
    const items = parseAmazonOrderSiblingItems(candidate, orderNumber);
    if (items.length) return items;
  }
  return [];
}

// The ONE placeholder row for an itemless Delivered email (see the parser's
// header) whose sibling lookup also came up empty. Pulled out of
// processReceiptEmail purely to keep that function's own branching flat.
async function recordNoItemsPlaceholder({ email, orderNumber, shipmentKey, summary }) {
  const placeholderTitle = email.subject || `Amazon delivery, order ${orderNumber || 'unknown'}`;
  try {
    const outcome = await processReceiptLine({
      email, orderNumber, shipmentKey, item: { title: placeholderTitle, quantity: 1 }, lineNo: 1, forcedStatus: 'no_items',
    });
    if (outcome.status === 'no_items') summary.noItems.push({ title: placeholderTitle, orderNumber: orderNumber || null });
    else summary.alreadyProcessed.push({ title: placeholderTitle, reason: outcome.reason || null });
  } catch (err) {
    logger.error(`[purchase-receipts] no_items placeholder failed for email ${email.id}: ${err.message}`);
    summary.errors.push({ title: placeholderTitle, message: err.message });
  }
}

// One real item -> one purchase_receipt_lines outcome, filed into the right
// summary bucket. Pulled out of processReceiptEmail for the same reason as
// recordNoItemsPlaceholder above.
async function recordItemOutcome({ email, orderNumber, shipmentKey, item, lineNo, notifyAdmin, summary }) {
  try {
    const outcome = await processReceiptLine({ email, orderNumber, shipmentKey, item, lineNo });
    if (outcome.status === 'logged') {
      summary.logged.push({ title: item.title, receivedQty: outcome.receivedQty, receivedUnit: outcome.receivedUnit, productId: outcome.product.id });
      await ringLoggedBell(notifyAdmin, { email, item, outcome });
    } else if (outcome.status === 'unmatched') summary.unmatched.push({ title: item.title });
    else if (outcome.status === 'size_mismatch') summary.sizeMismatch.push({ title: item.title });
    else if (outcome.status === 'needs_size') summary.needsSize.push({ title: item.title });
    else summary.alreadyProcessed.push({ title: item.title, reason: outcome.reason || null });
  } catch (err) {
    logger.error(`[purchase-receipts] item "${item.title}" on email ${email.id} failed: ${err.message}`);
    summary.errors.push({ title: item.title, message: err.message });
  }
}

/**
 * Process every item on ONE already-fetched email row. Safe to call
 * multiple times for the same email (idempotent via purchase_receipt_lines).
 */
async function processReceiptEmail(email, { notify } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated' };
  const since = sinceBoundary();
  if (!since) return { skipped: 'no_since' };
  if (!email?.received_at || new Date(email.received_at) < since) return { skipped: 'before_since' };

  const parsed = parseAmazonDeliveredEmail(email);
  if (!parsed) return { skipped: 'not_a_delivery_email' };

  const notifyAdmin = notify || ((...args) => require('../notification-service').notifyAdmin(...args));
  // NOTE: this bucket is named `alreadyProcessed`, never `skipped` — the
  // whole-function early returns above use `{ skipped: '<reason>' }` (a
  // string) as their sentinel, and an array is always truthy, so reusing
  // the name here would make runPurchaseReceiptRestockSweep's `if
  // (result.skipped) continue;` swallow every successfully processed email.
  const summary = { logged: [], unmatched: [], sizeMismatch: [], needsSize: [], noItems: [], alreadyProcessed: [], errors: [] };

  let items = parsed.items;
  if (!items.length && parsed.orderNumber) items = await findSiblingItems(parsed.orderNumber);

  if (!items.length) {
    await recordNoItemsPlaceholder({ email, orderNumber: parsed.orderNumber, shipmentKey: parsed.shipmentKey, summary });
    return summary;
  }

  let lineNo = 0;
  for (const item of items) {
    lineNo += 1;
    await recordItemOutcome({ email, orderNumber: parsed.orderNumber, shipmentKey: parsed.shipmentKey, item, lineNo, notifyAdmin, summary });
  }
  return summary;
}

/**
 * The ~15-minute scheduler sweep: scans `emails` directly (from_address +
 * subject only — never classification) for Amazon delivered rows received
 * since PURCHASE_RECEIPT_SINCE and runs every item through the same path as
 * the per-email hook. Idempotent: an email the hook already fully handled
 * contributes nothing new (every line already has a purchase_receipt_lines
 * row).
 */
async function runPurchaseReceiptRestockSweep({ notify } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated' };
  const since = sinceBoundary();
  if (!since) return { skipped: 'no_since' };

  const emails = await db('emails')
    .whereRaw('LOWER(from_address) = ?', [AMAZON_DELIVERY_FROM])
    .whereRaw('subject ILIKE ?', ['Delivered:%'])
    .where('received_at', '>=', since)
    .orderBy('received_at', 'asc');

  const totals = { emailsScanned: emails.length, logged: [], unmatched: [], sizeMismatch: [], needsSize: [], noItems: [], alreadyProcessed: [], errors: [] };
  for (const email of emails) {
    const result = await processReceiptEmail(email, { notify });
    // `result.skipped` here is only ever the whole-function string sentinel
    // ('before_since' / 'not_a_delivery_email' — 'gated'/'no_since' can't
    // reach this loop, both gates were already checked above); a
    // successfully processed email's summary object has no `skipped` key.
    if (result.skipped) continue;
    for (const key of ['logged', 'unmatched', 'sizeMismatch', 'needsSize', 'noItems', 'alreadyProcessed', 'errors']) {
      if (Array.isArray(result[key])) totals[key].push(...result[key].map((row) => ({ ...row, emailId: email.id })));
    }
  }
  return totals;
}

module.exports = { processReceiptEmail, runPurchaseReceiptRestockSweep, findSiblingItems };
