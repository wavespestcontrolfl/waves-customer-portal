/**
 * Open-balance reads (owner ruling 2026-08-08, Donovan case): everything a
 * customer still owes across their OTHER open invoices, for the
 * previous-balance surfaces (invoice email note, pay-page list) and the
 * completion balance sweep.
 *
 * Selection deliberately mirrors the portal "Pay now" query in
 * billing-v2.js GET /balance (the existing open-invoice authority):
 *   - status sent/viewed/overdue — bills the customer has actually been
 *     DELIVERED. Drafts are excluded on purpose: a draft was never presented,
 *     so it is neither shown as "previous balance" nor auto-charged.
 *   - payer_id NULL / payer_statement_id NULL in SQL, then a LIVE payer
 *     re-resolution per row (pre-push P0): a payer assigned after the
 *     invoice was minted can live only on scheduled_services (or as the
 *     customer's default payer) while the reused invoice row stays
 *     payer-null — the completion rails re-resolve for exactly this reason.
 *     A payer-billed row is the third party's debt, never the homeowner's
 *     balance; a failed resolve DROPS the row (fail closed, same direction
 *     as previsit-balance-reminder).
 *   - positive remainder (total − credit_applied), computed in SQL with the
 *     same GREATEST expression as the balance sum, oldest first.
 *
 * Invoices are NEVER merged, voided, or re-totalled here — each row keeps
 * its own service date, amount, and dunning age (that per-invoice age is
 * what keeps the oldest debt escalating — owner ruling #2).
 */

const db = require('../models/db');
const logger = require('./logger');
const { invoiceAmountDue } = require('./invoice-helpers');

// Safety valve, not display pagination: high enough that every real
// customer's full balance fits (prod max open invoices per customer is
// single digits), low enough to bound the per-row payer resolves against
// pathological data. Hitting it is logged so an understated total is never
// silent (pre-push P1).
const MAX_OPEN_INVOICES = 200;

/**
 * The customer's open self-pay invoices, oldest first, excluding
 * `excludeInvoiceId` (the invoice currently being viewed/emailed/charged).
 * Every returned row has been live-payer-verified as self-pay. Callers
 * whitelist what they expose — in particular, sibling invoice TOKENS must
 * never ride a public by-token payload (pre-push P0: one leaked invoice
 * link must not fan out into bearer credentials for the account's other
 * invoices).
 */
async function openBalanceInvoices(customerId, { excludeInvoiceId = null, database = db } = {}) {
  if (!customerId) return [];
  const query = database('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .whereRaw('GREATEST(total - COALESCE(credit_applied, 0), 0) > 0')
    .orderBy('created_at', 'asc')
    .limit(MAX_OPEN_INVOICES)
    .select(
      'id', 'invoice_number', 'status', 'service_type', 'service_date',
      'due_date', 'created_at', 'subtotal', 'discount_amount', 'total',
      'credit_applied', 'scheduled_service_id', 'stripe_payment_intent_id',
    );
  if (excludeInvoiceId) query.whereNot('id', excludeInvoiceId);
  const rows = await query;
  if (rows.length >= MAX_OPEN_INVOICES) {
    logger.warn(`[open-balance] customer ${customerId} hit the ${MAX_OPEN_INVOICES}-invoice bound — balance surfaces may understate`);
  }

  const PayerService = require('./payer');
  const selfPay = [];
  for (const row of rows) {
    // invoiceAmountDue is cents-authoritative — re-filter in JS so a row the
    // SQL GREATEST admitted on float representation can't surface as $0.00.
    if (!(invoiceAmountDue(row) > 0)) continue;
    // Live payer re-resolution (pre-push P0). resolveForInvoice is the same
    // authority the completion charge rails consult: per-visit payer when
    // the invoice carries one, the customer's DEFAULT payer either way. A
    // resolve outage fails toward DROP — a payer's bill must never be shown
    // to (or collected from) the homeowner.
    try {
      const resolved = await PayerService.resolveForInvoice({
        customerId: String(customerId),
        ...(row.scheduled_service_id ? { scheduledServiceId: String(row.scheduled_service_id) } : {}),
        throwOnError: true,
      });
      if (resolved?.payerId) continue;
    } catch (err) {
      logger.warn(`[open-balance] payer resolve failed for invoice ${row.invoice_number} — dropping from balance (fail closed): ${err.message}`);
      continue;
    }
    selfPay.push(row);
  }
  return selfPay;
}

/**
 * { total, count, moreCount, invoices } for the previous-balance surfaces.
 * `total`/`count` cover the FULL self-pay open set; `invoices` is capped at
 * `displayLimit` for rendering, with `moreCount` carrying the remainder so a
 * capped list is never presented as complete (pre-push P1). `total` is the
 * cents-safe sum of per-invoice remainders — a pure sum, never
 * re-discounted or re-taxed (each invoice's own math already happened at
 * mint).
 */
async function openBalanceSummary(customerId, { displayLimit = 5, ...opts } = {}) {
  const invoices = await openBalanceInvoices(customerId, opts);
  const totalCents = invoices.reduce(
    (sum, inv) => sum + Math.round(invoiceAmountDue(inv) * 100),
    0,
  );
  return {
    total: totalCents / 100,
    count: invoices.length,
    moreCount: Math.max(0, invoices.length - displayLimit),
    invoices: invoices.slice(0, displayLimit),
  };
}

module.exports = { openBalanceInvoices, openBalanceSummary, MAX_OPEN_INVOICES };
