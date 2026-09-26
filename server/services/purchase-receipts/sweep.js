/**
 * purchase-receipts/sweep.js — the Amazon "Delivered" → auto-restock lane.
 *
 * Gate: GATE_PURCHASE_RECEIPT_RESTOCK, read at call time (gateEnvValue) —
 * unset or any non-truthy value is the live kill switch.
 *
 * PURCHASE_RECEIPT_SINCE is a second, independent kill: an ISO-8601
 * timestamp WITH an explicit offset (`2026-09-26T05:49:45Z`), read by the
 * strict gateEnvTimestamp parser. Unset, offset-less (Railway would read it
 * as UTC), a bare date or unparseable all count as unset, and both entry
 * points do nothing. Set it to the last physical count so no delivery that
 * count already includes is replayed as a fresh restock.
 *
 * Authentication is a third, non-optional gate: from_address and subject
 * are attacker-typed text, so a Delivered email is only acted on when
 * Gmail's Authentication-Results show it authenticated as amazon.com
 * (hasAlignedAuth — the same DKIM/SPF-alignment check auto-unsubscribe.js
 * and email-sync.js's customer bell use; see inbox-hygiene.js). A spoofed
 * "delivery" is refused before any purchase_receipt_lines row is written.
 *
 * Bells: a logged line rings one ("Amazon delivery logged: ..."). A line
 * held for a person — possible_duplicate, size_mismatch, needs_size,
 * no_order_number, or an itemless email's no_items placeholder — rings one
 * saying why; that bell is the office's to-do. unmatched lines (personal
 * purchases, mostly) ring nothing. Each bell is written on its line's own
 * transaction (receipt-processor.js), so a bell that can't be saved rolls
 * the line back and the next sweep retries it — never a silent stock change.
 *
 * Two entry points sharing one path:
 *   - processReceiptEmail(email): called right after email-sync inserts a
 *     brand-new row (best-effort, fire-and-forget — see email-sync.js).
 *   - runPurchaseReceiptRestockSweep(): the scheduler's ~15-minute safety
 *     net, scanning `emails` directly by from_address + subject (never by
 *     LLM classification, which can lag or misfire) for anything the
 *     per-email hook missed (a process restart mid-sync, the hook's own
 *     error swallow, a backfill). It looks back at most SWEEP_LOOKBACK_MS
 *     (never before PURCHASE_RECEIPT_SINCE), so its work stays bounded.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue, gateEnvTimestamp } = require('../../config/feature-gates');
const { hasAlignedAuth } = require('../email/inbox-hygiene');
const { domainFromAddress } = require('../email/spam-blocker');
const { parseAmazonDeliveredEmail, AMAZON_DELIVERY_FROM } = require('./amazon-delivery-parser');
const { processReceiptLine } = require('./receipt-processor');

const GATE = 'GATE_PURCHASE_RECEIPT_RESTOCK';
const SINCE_ENV = 'PURCHASE_RECEIPT_SINCE';
const INVENTORY_LINK = '/admin/inventory?tab=products';
const SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Line status -> summary bucket. A result with no status (already
// processed, no order number) lands in alreadyProcessed.
const SUMMARY_BUCKETS = {
  logged: 'logged', possible_duplicate: 'possibleDuplicate', unmatched: 'unmatched',
  size_mismatch: 'sizeMismatch', needs_size: 'needsSize', no_items: 'noItems', no_order_number: 'noOrderNumber',
};

// Why a held line wasn't added — the second sentence of its bell.
const HELD_REASONS = {
  possible_duplicate: 'A manual restock or count was logged around the same time, so check the count.',
  size_mismatch: "The listing's size or pack count doesn't match the catalog container size, so log it by hand.",
  needs_size: 'The product has no container size in the catalog, so log it by hand.',
  no_items: "The email doesn't name the item. If it's stock, log it by hand.",
  no_order_number: "The email's order number couldn't be read, so log it by hand.",
};

// NOTE: the bucket is `alreadyProcessed`, never `skipped` — the whole-email
// early returns use `{ skipped: '<reason>' }` as their sentinel, and an
// array is always truthy, so runPurchaseReceiptRestockSweep's
// `if (result.skipped)` would swallow every processed email.
function emptySummary() {
  return { logged: [], possibleDuplicate: [], unmatched: [], sizeMismatch: [], needsSize: [], noItems: [], noOrderNumber: [], alreadyProcessed: [], errors: [] };
}

function displayUnit(unit) {
  return String(unit || '').replace(/_/g, ' ');
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

async function ringLoggedBell(notifyAdmin, { email, item, outcome, trx }) {
  const unit = displayUnit(outcome.receivedUnit);
  let body = `Amazon delivery logged: ${outcome.product.name} +${outcome.receivedQty} ${unit} `
    + `(${item.quantity} × ${round(outcome.receivedQty / item.quantity)} ${unit})`;
  // Read-only note: this lane never writes a restock request (see
  // receipt-processor.js's header); a person decides whether this covers it.
  // Cancel is the stock-neutral close — receiving the request would add
  // this delivery a second time.
  if (outcome.hasOpenRestockRequest) {
    body += ` A restock request for ${outcome.product.name} is still open. If this delivery covers it, cancel that request in the Intelligence Bar; marking it received would add the stock again.`;
  }
  await notifyAdmin('inventory', 'Amazon delivery logged', body, {
    link: INVENTORY_LINK,
    bell: true,
    dedupeKey: `purchase-receipt:${outcome.lineId}`,
    trx,
    metadata: { emailId: email.id, productId: outcome.product.id, receivedQty: outcome.receivedQty, receivedUnit: outcome.receivedUnit },
  });
}

async function ringHeldBell(notifyAdmin, { email, item, outcome, trx }) {
  // An itemless email's placeholder title is its subject ("Delivered: 1 Lawn & Garden item").
  const what = outcome.product ? `${outcome.product.name} ×${item.quantity}` : `"${item.title.replace(/^delivered:\s*/i, '')}"`;
  await notifyAdmin('inventory', 'Amazon delivery not added', `Amazon delivery of ${what} wasn't added. ${HELD_REASONS[outcome.status]}`, {
    link: INVENTORY_LINK,
    bell: true,
    dedupeKey: `purchase-receipt:${outcome.lineId}`,
    trx,
    metadata: { emailId: email.id, productId: outcome.product?.id || null, status: outcome.status },
  });
}

// The bell for one recorded line, on that line's transaction (notifyAdmin's
// trx option): a bell that can't be saved throws, rolling the line back.
function lineBell(notifyAdmin, email, item) {
  return async (outcome, trx) => {
    if (outcome.status === 'logged') await ringLoggedBell(notifyAdmin, { email, item, outcome, trx });
    else if (HELD_REASONS[outcome.status]) await ringHeldBell(notifyAdmin, { email, item, outcome, trx });
  };
}

// One line -> one purchase_receipt_lines outcome (with its bell), filed into
// its summary bucket. A failure here is recorded and never stops the
// email's other lines; nothing of the failed line was committed, so the
// next sweep retries it.
async function recordLineOutcome({ email, orderNumber, shipmentKey, item, lineNo, forcedStatus, notifyAdmin, summary }) {
  let outcome;
  try {
    outcome = await processReceiptLine({ email, orderNumber, shipmentKey, item, lineNo, forcedStatus, ringBell: lineBell(notifyAdmin, email, item) });
  } catch (err) {
    logger.error(`[purchase-receipts] item "${item.title}" on email ${email.id} failed: ${err.message}`);
    summary.errors.push({ title: item.title, message: err.message });
    return;
  }
  const bucket = SUMMARY_BUCKETS[outcome.status];
  if (!bucket) {
    summary.alreadyProcessed.push({ title: item.title, reason: outcome.reason || null });
    return;
  }
  summary[bucket].push({ title: item.title, productId: outcome.product?.id || null, receivedQty: outcome.receivedQty ?? null, receivedUnit: outcome.receivedUnit ?? null });
}

/**
 * Process every item on ONE already-fetched email row. Safe to call
 * multiple times for the same email (idempotent via purchase_receipt_lines).
 */
async function processReceiptEmail(email, { notify } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated' };
  const since = gateEnvTimestamp(SINCE_ENV);
  if (!since) return { skipped: 'no_since' };
  // A missing or unreadable received_at fails this comparison too.
  if (!(new Date(email.received_at) >= since)) return { skipped: 'before_since' };

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
  const summary = emptySummary();
  // An itemless "Delivered: N Lawn & Garden item(s)" email (see the parser's
  // header) gets one no_items placeholder line, titled with its subject.
  const lines = parsed.items.length
    ? parsed.items.map((item) => ({ item }))
    : [{ item: { title: email.subject, quantity: 1 }, forcedStatus: 'no_items' }];
  for (const [index, line] of lines.entries()) {
    await recordLineOutcome({
      ...line, email, orderNumber: parsed.orderNumber, shipmentKey: parsed.shipmentKey, lineNo: index + 1, notifyAdmin, summary,
    });
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
  const since = gateEnvTimestamp(SINCE_ENV);
  if (!since) return { skipped: 'no_since' };

  const emails = await db('emails')
    .select('id', 'gmail_id', 'from_address', 'subject', 'body_text', 'body_html', 'received_at', 'authentication_results')
    .whereRaw('LOWER(from_address) = ?', [AMAZON_DELIVERY_FROM])
    .whereRaw('subject ILIKE ?', ['Delivered:%'])
    .where('received_at', '>=', new Date(Math.max(since.getTime(), Date.now() - SWEEP_LOOKBACK_MS)))
    .orderBy('received_at', 'asc');

  const totals = { emailsScanned: emails.length, ...emptySummary() };
  for (const email of emails) {
    const result = await processReceiptEmail(email, { notify });
    // Only a whole-email string sentinel ('not_a_delivery_email' /
    // 'unauthenticated' / 'before_since') reaches here; a processed email's
    // summary has no `skipped` key.
    if (result.skipped) continue;
    for (const [bucket, rows] of Object.entries(result)) totals[bucket].push(...rows.map((row) => ({ ...row, emailId: email.id })));
  }
  return totals;
}

module.exports = { processReceiptEmail, runPurchaseReceiptRestockSweep };
