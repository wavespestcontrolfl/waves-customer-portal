'use strict';
// Authoritative payment history for ABSENCE claims ("your payment isn't
// showing") — Codex round-10/11 P1 (PR #5331). context-aggregator's
// billing.recentPayments is a 3-row DISPLAY window, so a real 4th payment would
// be falsely denied. This is a separate bounded read of ALL of one customer's
// OWN payments (any status), loaded LAZILY — only when a reply actually makes an
// absence claim — at draft time (ensureAbsenceHistory in the drafter) and at
// send time (the recheck seams), the same source both times.
//
// Payer-billed rows are excluded IN SQL, before the limit (a payment against a
// payer-billed invoice is the PAYER's even though it sits under the homeowner's
// customer_id — same rule as the aggregator), so `complete` is exact:
// complete = ownRows <= cap.
const db = require('../models/db');
const logger = require('./logger');
const { containsAbsencePhrase } = require('./payment-receipt-vocabulary');

const PAYMENT_HISTORY_CAP = 200;

// { rows, complete } or null when the read failed (unknown => callers fail closed).
async function loadPaymentHistory(customerId, dbh = db) {
  if (!customerId) return null;
  try {
    const rows = await dbh('payments')
      .where({ 'payments.customer_id': customerId })
      .whereNot('payments.status', 'upcoming')
      .whereRaw(
        "COALESCE(payments.metadata->>'invoice_id', '') NOT IN (SELECT id::text FROM invoices WHERE customer_id = ? AND payer_id IS NOT NULL)",
        [customerId],
      )
      .orderBy('payments.payment_date', 'desc')
      .limit(PAYMENT_HISTORY_CAP + 1);
    return { rows: rows.slice(0, PAYMENT_HISTORY_CAP), complete: rows.length <= PAYMENT_HISTORY_CAP };
  } catch (err) {
    logger.warn(`[payment-history] read failed for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// Attach billing.paymentHistory to `context` iff `replyText` makes an absence
// claim and the display window may be hiding history. Mutates and returns the
// context; idempotent (an existing value, including null, is kept).
async function ensureAbsenceHistory(context, replyText, dbh = db) {
  const billing = context?.billing;
  if (!billing || typeof billing !== 'object' || billing.paymentHistory !== undefined) return context;
  if (!billing.recentPaymentsTruncated || !containsAbsencePhrase(replyText)) return context;
  billing.paymentHistory = await loadPaymentHistory(context.customer?.id, dbh);
  return context;
}

module.exports = { loadPaymentHistory, ensureAbsenceHistory, PAYMENT_HISTORY_CAP };
