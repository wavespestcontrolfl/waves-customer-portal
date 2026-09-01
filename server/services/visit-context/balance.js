/**
 * Feed-grade open-balance facts: what the homeowner currently owes on
 * collectible invoices. Extracted verbatim from the day-schedule feed
 * (admin-schedule.js) so the schedule feeds, dispatch, and the Intelligence
 * Bar all answer "what does this customer owe?" identically.
 *
 * TWO TIERS, ON PURPOSE: this is the display-grade SQL answer. For
 * comms-grade balance math (live payer re-resolution per invoice before a
 * customer-facing money statement), use services/open-balance.js — do not
 * merge the two; they answer different questions.
 */
const defaultDb = require('../../models/db');
const { OPEN_INVOICE_STATUSES } = require('./statuses');

async function openInvoiceFacts(customerId, { db = defaultDb } = {}) {
  const inv = await db('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', OPEN_INVOICE_STATUSES)
    // Payer-billed invoices are the third party's AR — never the
    // homeowner's balance (Codex r1).
    .whereNull('payer_id')
    .first(
      db.raw('COALESCE(SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)), 0)::float as balance'),
      db.raw('COUNT(*)::int as count'),
      db.raw("COALESCE(BOOL_OR(status = 'overdue'), false) as overdue"),
    );
  return {
    balance: Number(inv?.balance || 0),
    count: Number(inv?.count || 0),
    overdue: !!inv?.overdue,
  };
}

module.exports = { openInvoiceFacts };
