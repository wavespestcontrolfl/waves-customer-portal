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
const { isNeverAttemptedHoldDeferral, excludeNeverAttemptedHoldDeferrals } = require('./collections/collection-hold');
const { paymentMetadataValueSql } = require('./payer-linkage');

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const LOCK_DEFERRAL_REASON = 'lock_contention';
const isNeverAttemptedLockDeferral = (p) => {
  if (!p || p.stripe_payment_intent_id) return false;
  // armed (never retried), or already COLLECTED: the retry sweep inserts its OWN paid row and leaves this placeholder failed,
  // disarmed and superseded by that row - still never a payment (same lifecycle as the collection_hold placeholder).
  const armed = Number(p.retry_count || 0) === 0 && p.next_retry_at != null;
  const collected = p.superseded_by_payment_id != null && String(p.superseded_by_payment_id) !== String(p.id);
  if (!armed && !collected) return false;
  try {
    const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
    return !!(m && m.deferred_reason === LOCK_DEFERRAL_REASON);
  } catch {
    return false;
  }
};

// collection_hold (B10) deferrals ride the same shared predicate every failed-payment consumer uses.
const isNeverAttemptedDeferral = (p) => isNeverAttemptedHoldDeferral(p) || isNeverAttemptedLockDeferral(p);

// SQL twin of isNeverAttemptedDeferral for query builders: ONE exclusion of EVERY never-attempted placeholder kind (dispute-hold AND
// lock-contention) for the payment-history readers (SMS grounding window + authoritative history), applied BEFORE any cap so a
// placeholder can neither use up a window slot nor ground "your payment failed" (Codex round-38 P1). A new placeholder kind is added
// HERE and in the in-memory predicate above, nowhere else.
function excludeNeverAttemptedDeferrals(query, alias = 'payments') {
  excludeNeverAttemptedHoldDeferrals(query, alias);
  return query.whereRaw(
    `NOT (COALESCE(${paymentMetadataValueSql(alias, 'deferred_reason')}, '') = ? AND ${alias}.stripe_payment_intent_id IS NULL AND ((COALESCE(${alias}.retry_count, 0) = 0 AND ${alias}.next_retry_at IS NOT NULL) OR (${alias}.superseded_by_payment_id IS NOT NULL AND ${alias}.superseded_by_payment_id <> ${alias}.id)))`,
    [LOCK_DEFERRAL_REASON],
  );
}

// EVERY unsuperseded failed row of the customer (not a display window) plus the set of NON-DRAFT invoices they link to.
// Throws when the failed-row read fails (callers decide: the route 500s, the aggregator marks billing unavailable).
// `statuses` = the row statuses that count as still-owed attempts. Default ['failed'] is the route's canonical rule
// (/api/billing/balance, unchanged); the context aggregator passes main's ['failed', 'pending', 'overdue'] so the shared
// balance semantics (admin overdue flag, voice / email context, "$X overdue" summary) stay exactly as on main — but over the
// COMPLETE ledger, not the 5-row display window (Codex round-35 P1).
// `strict` (the SMS grounding caller) = payer-aware and fail-closed: direct payer-owned rows (payments.payer_id) are filtered in
// SQL and every column the shared payer-linkage predicate reads (payer_id, stripe_charge_id, description, PI, metadata) is
// selected so `isPayerLinked` can exclude AP rows. A failed invoice lookup in strict mode propagates to the aggregator.
// The portal also reads the ownership columns and tolerates malformed historical invoice references.
async function loadFailedPaymentFacts(customerId, dbh = db, { statuses = ['failed'], strict = false } = {}) {
  const base = dbh('payments');
  let scoped = statuses.length === 1 && statuses[0] === 'failed'
    ? base.where({ customer_id: customerId, status: 'failed' })
    : base.where({ customer_id: customerId }).whereIn('status', statuses);
  scoped = scoped.whereNull('superseded_by_payment_id');
  if (strict) scoped = scoped.whereNull('payer_id');
  const rows = await scoped.select('id', 'amount', 'metadata', 'stripe_payment_intent_id', 'stripe_charge_id',
    'description', 'payer_id', 'retry_count', 'next_retry_at');
  const failedInvoiceIds = [...new Set(rows.map(metadataInvoiceId).filter(Boolean))];
  // invoices.id is UUID. Historical metadata is not: keep malformed legacy
  // references out of the PostgreSQL lookup so one bad value cannot abort
  // deduplication for every valid invoice on the account.
  if (strict && failedInvoiceIds.some((id) => !UUID_SHAPE.test(id))) {
    throw new Error('A failed payment has an unresolved invoice reference');
  }
  const validFailedInvoiceIds = [...new Set(failedInvoiceIds
    .filter((id) => UUID_SHAPE.test(id))
    .map((id) => id.toLowerCase()))];
  let carrying = [];
  let invoiceLookupFailed = false;
  if (validFailedInvoiceIds.length) {
    const lookup = (connection) => connection('invoices')
      .whereIn('id', validFailedInvoiceIds)
      .whereNot({ status: 'draft' })
      .select('id');
    try {
      if (!strict && dbh?.isTransaction === true && typeof dbh.transaction === 'function') {
        // The portal balance runs in a read-only PostgreSQL snapshot. A bare
        // caught statement error poisons that transaction (25P02), so contain
        // this explicitly recoverable status lookup in Knex's nested-transaction
        // SAVEPOINT before continuing with upcoming/open-invoice reads.
        carrying = await dbh.transaction((savepoint) => lookup(savepoint));
      } else {
        carrying = await lookup(dbh);
      }
    } catch (err) {
      if (strict) throw err;
      invoiceLookupFailed = true;
      carrying = [];
    }
  }
  const balanceCarryingInvoiceIds = new Set(carrying.map((r) => String(r.id).toLowerCase()));
  // When the lookup itself fails, a valid linked attempt may already be
  // represented by its invoice. Withhold that unresolved amount instead of
  // treating the lookup failure as proof that it is standalone debt.
  const unresolvedInvoiceIds = invoiceLookupFailed
    ? new Set(validFailedInvoiceIds)
    : new Set();
  return { rows, failedInvoiceIds, balanceCarryingInvoiceIds, unresolvedInvoiceIds, invoiceLookupFailed };
}

// `isPayerPayment(row)` — the caller's payer-ownership predicate.
function standaloneFailedRows({ rows, balanceCarryingInvoiceIds, unresolvedInvoiceIds = new Set() }, isPayerPayment = () => false) {
  return rows
    .filter((p) => !isPayerPayment(p))
    .filter((p) => !isNeverAttemptedDeferral(p))
    .filter((p) => {
      const invId = metadataInvoiceId(p);
      if (!invId) return true;
      const canonicalId = invId.toLowerCase();
      return !balanceCarryingInvoiceIds.has(canonicalId) && !unresolvedInvoiceIds.has(canonicalId);
    });
}

function standaloneFailedTotal(facts, isPayerPayment = () => false) {
  return standaloneFailedRows(facts, isPayerPayment)
    .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
}

module.exports = {
  UUID_SHAPE,
  loadFailedPaymentFacts,
  standaloneFailedRows,
  standaloneFailedTotal,
  isNeverAttemptedDeferral,
  excludeNeverAttemptedDeferrals,
  metadataInvoiceId,
};
