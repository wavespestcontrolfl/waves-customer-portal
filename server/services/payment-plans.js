/**
 * Payment-plan lifecycle helpers.
 *
 * payment_plans rows are created by POST /admin/invoices/:id/payment-plan and
 * an `active` row gates invoice edits, credit reversal and auto-credit. Nothing
 * charges installments yet, so the ONLY ways a plan leaves `active` are:
 *   - the invoice settles (any paid/prepaid path) → `completed`
 *   - an admin cancels it (POST .../payment-plan/cancel) → `cancelled`
 */
const db = require('../models/db');
const logger = require('./logger');

/**
 * Mark every ACTIVE plan on this invoice `completed`. Idempotent (WHERE
 * status='active'); safe to call from inside a transaction (pass `conn`) or
 * post-commit. Returns the number of rows flipped.
 */
async function completeActivePlansForInvoice(invoiceId, conn = db) {
  if (!invoiceId) return 0;
  const now = new Date();
  return conn('payment_plans')
    .where({ invoice_id: invoiceId, status: 'active' })
    .update({ status: 'completed', completed_at: now, updated_at: now });
}

/** Best-effort post-commit variant for paths that already committed the paid flip. */
async function completeActivePlansForPaidInvoice(invoiceId, context = 'payment') {
  try {
    const n = await completeActivePlansForInvoice(invoiceId);
    if (n > 0) logger.info(`[payment-plans] completed ${n} plan(s) for invoice ${invoiceId} (${context})`);
    return n;
  } catch (err) {
    logger.warn(`[payment-plans] auto-complete failed for invoice ${invoiceId} (${context}): ${err.message}`);
    return 0;
  }
}

module.exports = { completeActivePlansForInvoice, completeActivePlansForPaidInvoice };
