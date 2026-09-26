/**
 * purchase-receipts/sweep.js — purchase receipts → stock: Amazon "Delivered"
 * emails and SiteOne invoices.
 *
 * Gate: GATE_PURCHASE_RECEIPT_RESTOCK, read at call time (gateEnvValue) —
 * unset or any non-truthy value is the live kill switch.
 *
 * PURCHASE_RECEIPT_SINCE is a second, independent kill: an ISO-8601
 * timestamp WITH an explicit offset (`2026-09-26T05:49:45Z`), read by the
 * strict gateEnvTimestamp parser. Unset, offset-less (Railway would read it
 * as UTC), a bare date or unparseable all count as unset, and every entry
 * point does nothing. Set it to the last physical count so no purchase that
 * count already includes is replayed as a fresh restock.
 *
 * Authentication is a third, non-optional gate: from_address and subject
 * are attacker-typed text, so an email is only acted on when Gmail's
 * Authentication-Results show it authenticated as its sender's domain
 * (hasAlignedAuth — the same DKIM/SPF-alignment check auto-unsubscribe.js
 * and email-sync.js's customer bell use; see inbox-hygiene.js). A spoofed
 * receipt is refused before any purchase_receipt_lines row is written.
 *
 * Bells: a logged line rings one ("Amazon delivery logged: ...", "SiteOne
 * invoice N logged: ..."). A line held for a person — possible_duplicate,
 * size_mismatch, needs_size, no_order_number, returned, unverified, or a
 * no_items / unreadable placeholder — rings one saying why; that bell is the
 * office's to-do. unmatched lines (personal purchases, equipment) ring
 * nothing. Each bell is written on its line's own transaction
 * (receipt-processor.js), so a bell that can't be saved rolls the line back
 * and the next sweep retries it — never a silent stock change.
 *
 * Entry points:
 *   - processReceiptEmail(email): an Amazon Delivered email, called right
 *     after email-sync inserts a brand-new row (best-effort, fire-and-forget
 *     — see email-sync.js).
 *   - runPurchaseReceiptRestockSweep(): the scheduler's ~15-minute pass,
 *     scanning `emails` directly by from_address + subject (never by LLM
 *     classification, which can lag or misfire). It re-offers recent Amazon
 *     Delivered emails the hook missed (a restart mid-sync, the hook's own
 *     error swallow, a backfill), then flags Amazon shipments whose
 *     Delivered email never came (undelivered-shipments.js), then records
 *     SiteOne invoices (siteone-invoices.js; only here, since their lines
 *     come from the invoice pipeline's PDF read, after sync). It looks back
 *     at most SWEEP_LOOKBACK_MS (never before PURCHASE_RECEIPT_SINCE).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue, gateEnvTimestamp } = require('../../config/feature-gates');
const { hasAlignedAuth } = require('../email/inbox-hygiene');
const { domainFromAddress } = require('../email/spam-blocker');
const { parseAmazonDeliveredEmail, AMAZON_DELIVERY_FROM } = require('./amazon-delivery-parser');
const { processReceiptLine } = require('./receipt-processor');
const { alertUndeliveredShipments } = require('./undelivered-shipments');
const siteOne = require('./siteone-invoices');

const GATE = 'GATE_PURCHASE_RECEIPT_RESTOCK';
const SINCE_ENV = 'PURCHASE_RECEIPT_SINCE';
const INVENTORY_LINK = '/admin/inventory?tab=products';
const SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const AMAZON = { vendor: 'amazon', noun: 'Amazon delivery', label: 'Amazon delivery' };

// Line status -> summary bucket. A result with no status (already
// processed, handed to a person) lands in alreadyProcessed.
const SUMMARY_BUCKETS = {
  logged: 'logged', possible_duplicate: 'possibleDuplicate', unmatched: 'unmatched',
  size_mismatch: 'sizeMismatch', needs_size: 'needsSize', no_items: 'noItems', no_order_number: 'noOrderNumber',
  returned: 'returned', unverified: 'unverified', unreadable: 'unreadable',
};

// Why a held line wasn't added — the second sentence of its bell.
const HELD_REASONS = {
  possible_duplicate: 'A manual restock or count was logged around the same time, so check the count.',
  size_mismatch: "The listing's size or pack count doesn't match the catalog container size, so log it by hand.",
  needs_size: 'The product has no container size in the catalog, so log it by hand.',
  no_items: "The email doesn't name the item. If it's stock, log it by hand.",
  no_order_number: "The email's order number couldn't be read, so log it by hand.",
  returned: "It's a return, so take it out of stock by hand.",
  unverified: "The invoice line couldn't be checked (its numbers or unit of measure), so log it by hand.",
  unreadable: "The invoice couldn't be read. If it has stock, log it by hand.",
};

// NOTE: the bucket is `alreadyProcessed`, never `skipped` — the whole-email
// early returns use `{ skipped: '<reason>' }` as their sentinel, and an
// array is always truthy, so runPurchaseReceiptRestockSweep's
// `if (result.skipped)` would swallow every processed email.
function emptySummary() {
  const summary = { alreadyProcessed: [], errors: [] };
  for (const bucket of Object.values(SUMMARY_BUCKETS)) summary[bucket] = [];
  return summary;
}

// Counts for the scheduler's one log line.
function summarize(result) {
  const held = Object.values(SUMMARY_BUCKETS).filter((bucket) => bucket !== 'logged' && bucket !== 'unmatched')
    .reduce((sum, bucket) => sum + result[bucket].length, result.undelivered.length);
  return { logged: result.logged.length, held, errors: result.errors.length };
}

function adminNotifier(notify) {
  return notify || ((...args) => require('../notification-service').notifyAdmin(...args));
}

function displayUnit(unit) {
  return String(unit || '').replace(/_/g, ' ');
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

async function ringLoggedBell(notifyAdmin, { receipt, email, item, outcome, trx }) {
  const unit = displayUnit(outcome.receivedUnit);
  let body = `${receipt.label} logged: ${outcome.product.name} +${outcome.receivedQty} ${unit} `
    + `(${item.quantity} × ${round(outcome.receivedQty / item.quantity)} ${unit})`;
  // Read-only note: this lane never writes a restock request (see
  // receipt-processor.js's header); a person decides whether this covers it.
  // Cancel is the stock-neutral close — receiving the request would add
  // this delivery a second time.
  if (outcome.hasOpenRestockRequest) {
    body += ` A restock request for ${outcome.product.name} is still open. If this delivery covers it, cancel that request in the Intelligence Bar; marking it received would add the stock again.`;
  }
  await notifyAdmin('inventory', `${receipt.noun} logged`, body, {
    link: INVENTORY_LINK,
    bell: true,
    dedupeKey: `purchase-receipt:${outcome.lineId}`,
    trx,
    metadata: { emailId: email.id, productId: outcome.product.id, receivedQty: outcome.receivedQty, receivedUnit: outcome.receivedUnit },
  });
}

// "SiteOne invoice N: Taurus SC ×1", an itemless Amazon email's subject
// ("Delivered: 1 Lawn & Garden item"), or the receipt alone.
function heldSubject({ receipt, item, outcome }) {
  if (outcome.product) return `${receipt.label}: ${outcome.product.name}${item.quantity ? ` ×${Math.abs(item.quantity)}` : ''}`;
  if (outcome.status === 'no_items') return `${receipt.label} "${item.title.replace(/^delivered:\s*/i, '')}"`;
  return receipt.label;
}

async function ringHeldBell(notifyAdmin, { receipt, email, item, outcome, trx }) {
  await notifyAdmin('inventory', `${receipt.noun} not added`, `${heldSubject({ receipt, item, outcome })} wasn't added. ${HELD_REASONS[outcome.status]}`, {
    link: INVENTORY_LINK,
    bell: true,
    dedupeKey: `purchase-receipt:${outcome.lineId}`,
    trx,
    metadata: { emailId: email.id, productId: outcome.product?.id || null, status: outcome.status },
  });
}

// The bell for one recorded line, on that line's transaction (notifyAdmin's
// trx option): a bell that can't be saved throws, rolling the line back.
function lineBell(notifyAdmin, receipt, email, item) {
  return async (outcome, trx) => {
    if (outcome.status === 'logged') await ringLoggedBell(notifyAdmin, { receipt, email, item, outcome, trx });
    else if (HELD_REASONS[outcome.status]) await ringHeldBell(notifyAdmin, { receipt, email, item, outcome, trx });
  };
}

// One line -> one purchase_receipt_lines outcome (with its bell), filed into
// its summary bucket. A failure here is recorded and never stops the
// email's other lines; nothing of the failed line was committed, so the
// next sweep retries it.
async function recordLineOutcome({ receipt, email, orderNumber, shipmentKey, item, lineNo, forcedStatus, holdAs, notifyAdmin, summary }) {
  let outcome;
  try {
    outcome = await processReceiptLine({
      vendor: receipt.vendor, email, orderNumber, shipmentKey, item, lineNo, forcedStatus, holdAs,
      ringBell: lineBell(notifyAdmin, receipt, email, item),
    });
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

function authenticated(email) {
  return hasAlignedAuth(email.authentication_results, domainFromAddress(email.from_address));
}

/**
 * Process every item on ONE already-fetched Amazon Delivered email row. Safe
 * to call multiple times for the same email (idempotent via
 * purchase_receipt_lines).
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
  if (!authenticated(email)) {
    logger.warn(`[purchase-receipts] email ${email.id} claims to be from ${email.from_address} but failed sender authentication — refusing to process`);
    return { skipped: 'unauthenticated' };
  }

  const notifyAdmin = adminNotifier(notify);
  const summary = emptySummary();
  // An itemless "Delivered: N Lawn & Garden item(s)" email (see the parser's
  // header) gets one no_items placeholder line, titled with its subject. A
  // line with no readable Order # that would move stock is held instead.
  const lines = parsed.items.length
    ? parsed.items.map((item) => ({ item, holdAs: parsed.orderNumber ? undefined : 'no_order_number' }))
    : [{ item: { title: email.subject, quantity: 1 }, forcedStatus: 'no_items' }];
  for (const [index, line] of lines.entries()) {
    await recordLineOutcome({
      ...line, receipt: AMAZON, email, orderNumber: parsed.orderNumber, shipmentKey: parsed.shipmentKey, lineNo: index + 1, notifyAdmin, summary,
    });
  }
  return summary;
}

// The lines one SiteOne invoice email records, or null for none this pass:
// not an invoice we can key, still being read, or the other copy of an
// invoice already recorded.
async function siteOneInvoiceLines(email, now) {
  if (!siteOne.isSiteOneInvoiceEmail(email) || !authenticated(email)) return null;
  const invoice = await siteOne.readSiteOneInvoice(email, now);
  if (!invoice || invoice.pending) return null;
  // The store and billing emails carry the same invoice: the first handled
  // owns it. (A hand-off placeholder also stops this email's own later lines,
  // under the shipment lock in receipt-processor.js.)
  const otherCopy = await db('purchase_receipt_lines')
    .where({ vendor: siteOne.VENDOR, shipment_key: invoice.number }).whereNot({ email_id: email.id }).first('id');
  if (otherCopy) return null;
  if (invoice.problem === 'unreadable') {
    return { invoice, lines: [{ item: { title: email.subject, quantity: 1 }, lineNo: 1, forcedStatus: 'unreadable' }] };
  }
  // A zero line (backordered, nothing shipped) has nothing to record — on an
  // invoice that reconciles. On one that doesn't, a 0 may be the misread, so
  // every line is recorded and a stocked one still gets its bell.
  const lines = invoice.lines.filter((line) => invoice.problem || line.quantity !== 0).map(({ title, quantity, lineNo, uom }) => ({
    item: { title, quantity }, lineNo, holdAs: siteOneHold(invoice.problem, quantity, uom),
  }));
  return { invoice, lines };
}

// What a stocked SiteOne line is held as instead of moving stock, if
// anything: a return, or a line whose totals or unit (only EA — each — is a
// container count) can't be trusted.
function siteOneHold(problem, quantity, uom) {
  if (quantity < 0) return 'returned';
  return problem || uom !== 'EA' ? 'unverified' : undefined;
}

async function processSiteOneInvoices({ floor, now, notifyAdmin, totals }) {
  for (const email of await siteOne.findSiteOneInvoiceEmails(floor)) {
    let found;
    try {
      found = await siteOneInvoiceLines(email, now);
    } catch (err) {
      // One invoice that can't be read never stops the others.
      logger.error(`[purchase-receipts] SiteOne invoice email ${email.id} failed: ${err.message}`);
      totals.errors.push({ title: email.subject, message: err.message, emailId: email.id });
      continue;
    }
    if (!found) continue;
    const receipt = { vendor: siteOne.VENDOR, noun: 'SiteOne invoice', label: `SiteOne invoice ${found.invoice.number}` };
    const summary = emptySummary();
    for (const line of found.lines) {
      await recordLineOutcome({ ...line, receipt, email, orderNumber: found.invoice.number, shipmentKey: found.invoice.number, notifyAdmin, summary });
    }
    for (const [bucket, rows] of Object.entries(summary)) totals[bucket].push(...rows.map((row) => ({ ...row, emailId: email.id })));
  }
}

/**
 * The ~15-minute scheduler sweep (see the header). Idempotent: anything
 * already recorded contributes nothing new.
 */
async function runPurchaseReceiptRestockSweep({ notify } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated' };
  const since = gateEnvTimestamp(SINCE_ENV);
  if (!since) return { skipped: 'no_since' };
  const now = Date.now();
  const floor = new Date(Math.max(since.getTime(), now - SWEEP_LOOKBACK_MS));
  const notifyAdmin = adminNotifier(notify);

  const emails = await db('emails')
    .select('id', 'gmail_id', 'from_address', 'subject', 'body_text', 'body_html', 'received_at', 'authentication_results')
    .whereRaw('LOWER(from_address) = ?', [AMAZON_DELIVERY_FROM])
    .whereRaw('subject ILIKE ?', ['Delivered:%'])
    .where('received_at', '>=', floor)
    .orderBy('received_at', 'asc');

  const totals = { emailsScanned: emails.length, ...emptySummary() };
  for (const email of emails) {
    const result = await processReceiptEmail(email, { notify: notifyAdmin });
    // Only a whole-email string sentinel ('not_a_delivery_email' /
    // 'unauthenticated' / 'before_since') reaches here; a processed email's
    // summary has no `skipped` key.
    if (result.skipped) continue;
    for (const [bucket, rows] of Object.entries(result)) totals[bucket].push(...rows.map((row) => ({ ...row, emailId: email.id })));
  }
  // After the Delivered pass, so a delivery whose email did come is settled first.
  const { undelivered, errors } = await alertUndeliveredShipments({ since, now, notifyAdmin });
  totals.undelivered = undelivered;
  totals.errors.push(...errors);
  await processSiteOneInvoices({ floor, now, notifyAdmin, totals });
  return totals;
}

module.exports = { processReceiptEmail, runPurchaseReceiptRestockSweep, summarize };
