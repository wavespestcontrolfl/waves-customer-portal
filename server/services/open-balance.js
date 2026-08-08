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
 *   - payer_id NULL — a payer-billed invoice is the third party's debt, never
 *     the homeowner's balance (and never chargeable to the homeowner's card).
 *   - payer_statement_id NULL — statement-accrued invoices are collected via
 *     the consolidated statement only (their /pay tokens 404 by design).
 *   - positive remainder (total − credit_applied), computed in SQL with the
 *     same GREATEST expression as the balance sum, oldest first.
 *
 * Invoices are NEVER merged, voided, or re-totalled here — each row keeps its
 * own service date, amount, token, and dunning age (that per-invoice age is
 * what keeps the oldest debt escalating — owner ruling #2).
 */

const db = require('../models/db');
const { invoiceAmountDue } = require('./invoice-helpers');

/**
 * The customer's open self-pay invoices, oldest first, excluding
 * `excludeInvoiceId` (the invoice currently being viewed/emailed/charged).
 * Returns full-enough rows for both display and the sweep; callers whitelist
 * what they expose.
 */
async function openBalanceInvoices(customerId, { excludeInvoiceId = null, database = db, limit = 20 } = {}) {
  if (!customerId) return [];
  const query = database('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .whereRaw('GREATEST(total - COALESCE(credit_applied, 0), 0) > 0')
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select(
      'id', 'token', 'invoice_number', 'status', 'service_type', 'service_date',
      'due_date', 'created_at', 'subtotal', 'discount_amount', 'total',
      'credit_applied', 'scheduled_service_id', 'stripe_payment_intent_id',
    );
  if (excludeInvoiceId) query.whereNot('id', excludeInvoiceId);
  const rows = await query;
  // invoiceAmountDue is cents-authoritative — re-filter in JS so a row the SQL
  // GREATEST admitted on float representation can't surface as a $0.00 line.
  return rows.filter((row) => invoiceAmountDue(row) > 0);
}

/**
 * { total, count, invoices } for the previous-balance surfaces. `total` is the
 * cents-safe sum of per-invoice remainders — a pure sum, never re-discounted
 * or re-taxed (each invoice's own math already happened at mint).
 */
async function openBalanceSummary(customerId, opts = {}) {
  const invoices = await openBalanceInvoices(customerId, opts);
  const totalCents = invoices.reduce(
    (sum, inv) => sum + Math.round(invoiceAmountDue(inv) * 100),
    0,
  );
  return { total: totalCents / 100, count: invoices.length, invoices };
}

module.exports = { openBalanceInvoices, openBalanceSummary };
