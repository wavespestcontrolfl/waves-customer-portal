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
 * Authentication is a THIRD, non-optional gate, checked for every candidate
 * before anything is processed: from_address and subject are attacker-typed
 * text, so a Delivered email is only ever acted on when Gmail's own
 * Authentication-Results header shows it actually authenticated as
 * amazon.com (hasAlignedAuth, the same DKIM/SPF-alignment check
 * auto-unsubscribe.js and email-sync.js's customer bell already gate
 * spoofable sender action on — see inbox-hygiene.js). A spoofed or
 * unauthenticated "delivery" is refused before any purchase_receipt_lines
 * row is written and before any stock ever moves.
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
const { hasAlignedAuth } = require('../email/inbox-hygiene');
const { domainFromAddress } = require('../email/spam-blocker');
const { parseAmazonDeliveredEmail, AMAZON_DELIVERY_FROM } = require('./amazon-delivery-parser');
const { processReceiptLine } = require('./receipt-processor');

const GATE = 'GATE_PURCHASE_RECEIPT_RESTOCK';

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

// The ONE placeholder row for an itemless Delivered email (see the parser's
// header). Pulled out of processReceiptEmail purely to keep that function's
// own branching flat.
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

  // From/subject are spoofable; only an aligned SPF/DKIM pass for
  // amazon.com earns any inventory write. Fail closed — checked before any
  // purchase_receipt_lines row is written, not just before the movement.
  if (!hasAlignedAuth(email.authentication_results, domainFromAddress(email.from_address))) {
    logger.warn(`[purchase-receipts] email ${email.id} claims to be from ${email.from_address} but failed sender authentication — refusing to process`);
    return { skipped: 'unauthenticated' };
  }

  const notifyAdmin = notify || ((...args) => require('../notification-service').notifyAdmin(...args));
  // NOTE: this bucket is named `alreadyProcessed`, never `skipped` — the
  // whole-function early returns above use `{ skipped: '<reason>' }` (a
  // string) as their sentinel, and an array is always truthy, so reusing
  // the name here would make runPurchaseReceiptRestockSweep's `if
  // (result.skipped) continue;` swallow every successfully processed email.
  const summary = { logged: [], unmatched: [], sizeMismatch: [], needsSize: [], noItems: [], alreadyProcessed: [], errors: [] };

  const items = parsed.items;
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
    // ('before_since' / 'not_a_delivery_email' / 'unauthenticated' —
    // 'gated'/'no_since' can't reach this loop, both gates were already
    // checked above); a successfully processed email's summary object has
    // no `skipped` key.
    if (result.skipped) continue;
    for (const key of ['logged', 'unmatched', 'sizeMismatch', 'needsSize', 'noItems', 'alreadyProcessed', 'errors']) {
      if (Array.isArray(result[key])) totals[key].push(...result[key].map((row) => ({ ...row, emailId: email.id })));
    }
  }
  return totals;
}

module.exports = { processReceiptEmail, runPurchaseReceiptRestockSweep };
