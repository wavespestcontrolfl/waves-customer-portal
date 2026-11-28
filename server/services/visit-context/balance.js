/**
 * Open-balance facts for schedule cards, dispatch, and tech tools: what the
 * homeowner currently owes on collectible self-pay invoices. Delegates to the
 * canonical services/open-balance.js summary so payer-billed (including live
 * post-invoice payer reassignments), statement-rolled, withdrawn packet,
 * chemical-review held, and $0-due invoices are all excluded identically.
 */
const defaultDb = require('../../models/db');
const { openBalanceSummary } = require('../open-balance');

async function openInvoiceFacts(customerId, { db = defaultDb } = {}) {
  if (!customerId) return { balance: 0, count: 0, overdue: false, complete: true };
  const summary = await openBalanceSummary(customerId, { database: db });
  if (!summary || summary.complete === false) {
    return { balance: null, count: null, overdue: false, complete: false, unavailable: true };
  }
  return {
    balance: Number(summary.total || 0),
    count: Number(summary.count || 0),
    overdue: Number(summary.overdueCount || 0) > 0,
    complete: true,
  };
}

module.exports = { openInvoiceFacts };
