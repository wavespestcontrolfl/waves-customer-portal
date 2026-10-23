/**
 * The ONE classifier of what an invoice may not be voided for: money received or in flight (by_owner_rule), and effects only
 * the Invoices page can unwind (needs_invoices_page). The Intelligence Bar void_invoice tool and the bar's cancel-with-effects
 * path (the card at proposal, and the pinned void under the invoice row lock) both call it, so a rule added here reaches every
 * invoice the bar voids. Extracted unchanged from intelligence-bar/void-invoice-tools.js; each function takes the connection to
 * read on (the shared db, or a transaction holding the invoice row lock) and defaults to the shared db, so void_invoice behaves
 * exactly as before. Reads only; never writes.
 *
 * moneyRefusal(invoice, conn, { skip }): skip lists reasons a caller deliberately handles itself (the cancel path restores a
 * deposit credit, so it skips 'deposit_collected'). Every function returns a refusal object
 * ({ error, code, reason, invoice_id }) or null.
 */
const db = require('../models/db');
const logger = require('./logger');

const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const ownerRule = (error, reason, invoiceId) => refusal(`${error} Refunds and card charges stay on the Invoices page by the owner's rule.`, 'by_owner_rule', { reason, invoice_id: invoiceId });
const toPage = (error, reason, invoiceId) => refusal(`${error} The bar can't void this invoice from here yet. Nothing was changed.`, 'needs_invoices_page', { reason, invoice_id: invoiceId });

// Statuses that read as collected or moving money (the screen shows no Void button for them either).
const MONEY_STATUSES = new Set(['paid', 'processing', 'refunded', 'partially_refunded', 'partial', 'disputed']);
const INVOICE_LINK_KEYS = ['invoice_id', 'dispute_invoice_id', 'waves_invoice_id'];

function parseLines(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// A payments row that moved no money: failed (with its PaymentIntent, so the outcome is known), canceled. A failed row with no
// PaymentIntent may hide a charge whose outcome is unknown, so it counts as money.
const PAYMENT_MOVED_NO_MONEY_SQL = "(LOWER(COALESCE(payments.status, '')) IN ('failed', 'canceled', 'cancelled') "
  + "AND NOT (LOWER(COALESCE(payments.status, '')) = 'failed' AND payments.stripe_payment_intent_id IS NULL))";

// Any payments row tied to this invoice by the portal's own linkage (metadata invoice keys, the invoice's PaymentIntent or
// charge id, the manual-payment description) that did or may have moved money. A row naming a different invoice is that
// invoice's. One existence query with the status filter in SQL and no limit: a pile of failed attempts cannot hide a later
// disputed or refunded payment.
function disqualifyingPayment(invoice, conn = db) {
  const id = String(invoice.id);
  return conn('payments')
    .where(function linkedToInvoice() {
      for (const key of INVOICE_LINK_KEYS) this.orWhereRaw(`payments.metadata::jsonb ->> '${key}' = ?`, [id]);
      if (invoice.stripe_payment_intent_id) this.orWhereRaw('payments.stripe_payment_intent_id = ?', [String(invoice.stripe_payment_intent_id)]);
      if (invoice.stripe_charge_id) this.orWhereRaw('payments.stripe_charge_id = ?', [String(invoice.stripe_charge_id)]);
      if (/^[A-Za-z0-9-]+$/.test(String(invoice.invoice_number || ''))) this.orWhereRaw('payments.description LIKE ?', [`Invoice ${invoice.invoice_number} — %`]);
    })
    // A row that names ANOTHER invoice explicitly (a combined payment's sibling share) is that invoice's.
    .whereRaw(`(${INVOICE_LINK_KEYS.map((key) => `NULLIF(payments.metadata::jsonb ->> '${key}', '') IS NULL`).join(' AND ')} OR ${INVOICE_LINK_KEYS.map((key) => `payments.metadata::jsonb ->> '${key}' = ?`).join(' OR ')})`, INVOICE_LINK_KEYS.map(() => id))
    .whereRaw(`NOT ${PAYMENT_MOVED_NO_MONEY_SQL}`)
    .first('payments.id', 'payments.status');
}

// Money received or in flight, from the invoice row and its database links: the by_owner_rule refusals.
async function moneyRefusal(invoice, conn = db, { skip = [] } = {}) {
  const at = invoice.id;
  const status = String(invoice.status || '').toLowerCase();
  if (MONEY_STATUSES.has(status)) {
    return ownerRule(`Invoice ${invoice.invoice_number} is ${status}, so money has been received or is moving. A void would hide it.`, `status_${status}`, at);
  }
  if (status === 'prepaid') {
    return ownerRule(`Invoice ${invoice.invoice_number} is prepaid (covered by credit or a payment). The Invoices page hides Void for it, so reverse the prepayment there.`, 'status_prepaid', at);
  }
  if (invoice.payment_recorded_at) return ownerRule(`A payment is already recorded on invoice ${invoice.invoice_number}.`, 'payment_recorded', at);
  if (invoice.stripe_charge_id) return ownerRule(`Invoice ${invoice.invoice_number} has a card charge on file.`, 'charge_on_file', at);
  if (invoice.paid_at && status !== 'prepaid') return ownerRule(`Invoice ${invoice.invoice_number} carries a paid date.`, 'paid_date', at);
  const moved = await disqualifyingPayment(invoice, conn);
  if (moved) return ownerRule(`A payment (${moved.status}) is on file for invoice ${invoice.invoice_number}.`, 'payment_on_file', at);
  const depositLine = parseLines(invoice.line_items).find((li) => li?.category === 'deposit_credit');
  if (depositLine && !skip.includes('deposit_collected')) return ownerRule(`Invoice ${invoice.invoice_number} applies a deposit the customer already paid.`, 'deposit_collected', at);
  if (invoice.payer_statement_id) {
    const stmt = await conn('payer_statements').where({ id: invoice.payer_statement_id }).first('status');
    if (stmt && stmt.status !== 'open') return ownerRule(`Invoice ${invoice.invoice_number} is on a finalized payer statement.`, 'finalized_statement', at);
  }
  const plan = await conn('payment_plans').where({ invoice_id: invoice.id }).whereNot('status', 'cancelled').first('id', 'status');
  if (plan) return ownerRule(`Invoice ${invoice.invoice_number} has a payment plan (${plan.status}).`, 'payment_plan', at);
  return chargeReconciliationRefusal(invoice, conn);
}

// An unresolved saved-card attempt or orphan charge (a worker can die after submitting a charge to Stripe, leaving the invoice
// 'sent' with no PaymentIntent or payments row). Read-only, on the given connection.
async function chargeReconciliationRefusal(invoice, conn) {
  const at = invoice.id;
  try {
    await require('./stripe').assertNoInvoiceChargeReconciliationPending(invoice.id, conn, { readOnly: true });
  } catch (err) {
    if (err?.reconciliationRequired || /^STRIPE_/.test(String(err?.code || ''))) {
      return ownerRule(`Invoice ${invoice.invoice_number} has a saved-card charge in progress or unresolved.`, 'charge_in_progress', at);
    }
    return refusal('The bar could not check for a card charge in progress, so nothing was offered. Nothing was changed. Try again in a moment.', 'unverified', { invoice_id: at });
  }
  return null;
}

// Invoices whose void also unwinds a plan, a month of dues, a setup obligation or a queued text: the Invoices page.
async function pageOnlyRefusal(invoice, conn = db) {
  const at = invoice.id;
  try {
    if (parseLines(invoice.line_items).some((li) => li && li.membership_dues_month)) {
      return toPage(`Invoice ${invoice.invoice_number} is a membership-dues invoice: voiding it releases a month of coverage.`, 'membership_dues', at);
    }
    if (parseLines(invoice.line_items).some((li) => /^Bait Station Setup — one-time setup fee$/.test(String(li?.description || '').trim()))) {
      return toPage(`Invoice ${invoice.invoice_number} bills a bait-station setup fee: voiding it puts that obligation back on the service.`, 'setup_fee', at);
    }
    if (await conn('setup_fee_claims').where({ invoice_id: invoice.id }).first('id')) {
      return toPage(`Invoice ${invoice.invoice_number} has a setup-fee claim.`, 'setup_fee', at);
    }
    if (invoice.annual_prepay_covered_term_id) {
      return toPage(`Invoice ${invoice.invoice_number} is covered by an annual plan.`, 'annual_plan_covered', at);
    }
    if (await conn('annual_prepay_terms').where({ prepay_invoice_id: invoice.id }).first('id')
      || await require('./invoice-prepay').resolveInvoiceTermId(invoice, conn, { strict: true })) {
      return toPage(`Invoice ${invoice.invoice_number} belongs to an annual plan.`, 'annual_plan', at);
    }
    if (invoice.stripe_payment_intent_id) {
      const shared = await conn('invoices').where({ stripe_payment_intent_id: invoice.stripe_payment_intent_id }).whereNot('id', invoice.id).first('id');
      if (shared) return toPage(`Invoice ${invoice.invoice_number} shares a combined payment session with other invoices.`, 'combined_payment', at);
    }
    if (await require('./invoice').queuedPayLinkText(invoice.id, { adoptsQueuedInvoiceSend: false })) {
      return toPage(`A pay-link text is queued for invoice ${invoice.invoice_number}.`, 'queued_text', at);
    }
  } catch (err) {
    logger.warn(`[intelligence-bar:void-invoice] link check failed (${err.code || err.name || 'error'})`);
    return refusal('The bar could not check what else this invoice is tied to, so nothing was offered. Nothing was changed. Try again in a moment.', 'unverified', { invoice_id: at });
  }
  return null;
}

// Every refusal, in void_invoice's order (money first, then the page-only effects), or null when the invoice may be voided.
async function invoiceVoidRefusal(invoice, conn = db, opts = {}) {
  return (await moneyRefusal(invoice, conn, opts)) || pageOnlyRefusal(invoice, conn);
}

module.exports = { refusal, ownerRule, toPage, parseLines, disqualifyingPayment, moneyRefusal, pageOnlyRefusal, invoiceVoidRefusal };
