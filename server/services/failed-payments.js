'use strict';
// ONE definition of "standalone failed attempts that are still owed" — extracted from routes/billing-v2.js
// (GET /api/billing/balance, the canonical balance) so the customer portal balance and the SMS grounding balance
// (context-aggregator) can never disagree about what a failed payment row means (Codex round-35 P1: the aggregator used
// to sum failures only from its 5-row display slice, so an older unsuperseded failure behind five newer paid rows
// read as zero owed).
//
// A failed row counts toward the balance when it is: status 'failed', not superseded by a retry that collected, not
// payer-owned, not a NEVER-ATTEMPTED lock-contention deferral (armed, no PI, retry_count 0), and not linked to a
// non-draft invoice (that invoice already carries the debt — double-count guard). A failure linked to a still-DRAFT
// invoice keeps counting (the invoice sum only covers sent / viewed / overdue).
const db = require('../models/db');
const { isNeverAttemptedHoldDeferral } = require('./collections/collection-hold');

const metadataInvoiceId = (p) => {
  try {
    const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
    return m && m.invoice_id != null ? String(m.invoice_id) : null;
  } catch {
    return null;
  }
};

// Never-attempted LOCK-contention deferral (Codex #4682 r3/r4): the monthly cron writes a 'failed' row with next_retry_at armed when
// another collector held the billing lock (metadata.deferred_reason = 'lock_contention', no PI, retry_count 0).
const isNeverAttemptedLockDeferral = (p) => {
  if (p.stripe_payment_intent_id || Number(p.retry_count || 0) > 0 || p.next_retry_at == null) return false;
  try {
    const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
    return !!(m && m.deferred_reason === 'lock_contention');
  } catch {
    return false;
  }
};

// collection_hold (B10) deferrals ride the same shared predicate every failed-payment consumer uses.
const isNeverAttemptedDeferral = (p) => isNeverAttemptedHoldDeferral(p) || isNeverAttemptedLockDeferral(p);

// EVERY unsuperseded failed row of the customer (not a display window) plus the set of NON-DRAFT invoices they link to.
// Throws when the failed-row read fails (callers decide: the route 500s, the aggregator marks billing unavailable).
// `statuses` = the row statuses that count as still-owed attempts. Default ['failed'] is the route's canonical rule
// (/api/billing/balance, unchanged); the context aggregator passes main's ['failed', 'pending', 'overdue'] so the shared
// balance semantics (admin overdue flag, voice / email context, "$X overdue" summary) stay exactly as on main — but over the
// COMPLETE ledger, not the 5-row display window (Codex round-35 P1).
async function loadFailedPaymentFacts(customerId, dbh = db, { statuses = ['failed'] } = {}) {
  // the default (route) query keeps its exact original shape
  const base = dbh('payments');
  const scoped = statuses.length === 1 && statuses[0] === 'failed'
    ? base.where({ customer_id: customerId, status: 'failed' })
    : base.where({ customer_id: customerId }).whereIn('status', statuses);
  const rows = await scoped
    .whereNull('superseded_by_payment_id')
    .select('id', 'amount', 'metadata', 'stripe_payment_intent_id', 'retry_count', 'next_retry_at');
  const failedInvoiceIds = [...new Set(rows.map(metadataInvoiceId).filter(Boolean))];
  const balanceCarryingInvoiceIds = new Set(
    failedInvoiceIds.length
      ? (await dbh('invoices')
          .whereIn('id', failedInvoiceIds)
          .whereNot({ status: 'draft' })
          .select('id')
          .catch(() => [])).map((r) => String(r.id))
      : [],
  );
  return { rows, failedInvoiceIds, balanceCarryingInvoiceIds };
}

// `isPayerPayment(row)` — the caller's payer-ownership predicate.
function standaloneFailedTotal({ rows, balanceCarryingInvoiceIds }, isPayerPayment = () => false) {
  return rows
    .filter((p) => !isPayerPayment(p))
    .filter((p) => !isNeverAttemptedDeferral(p))
    .filter((p) => {
      const invId = metadataInvoiceId(p);
      return !invId || !balanceCarryingInvoiceIds.has(invId);
    })
    .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
}

module.exports = { loadFailedPaymentFacts, standaloneFailedTotal, isNeverAttemptedDeferral, metadataInvoiceId };
