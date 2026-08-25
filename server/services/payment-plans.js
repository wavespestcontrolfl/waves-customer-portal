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
  // Both updates commit ATOMICALLY (codex PR r5 P1): on a plain connection
  // they were separate autocommit statements, and a dispute reopening the
  // invoice between them made the settled-gated sequence release a no-op —
  // with the plan already 'completed', retries found nothing to flip and
  // the plan-owned stop suppressed dunning forever. A caller-supplied trx
  // is reused as-is (the cancel route's settled branch).
  const run = (trx) => completeActivePlansLocked(invoiceId, trx);
  return conn.isTransaction ? run(conn) : conn.transaction(run);
}

async function completeActivePlansLocked(invoiceId, conn) {
  const now = new Date();
  // LOCK the invoice row first (codex PR r6 P1): the EXISTS gates below are
  // non-locking reads, and under READ COMMITTED a dispute reopen could
  // commit 'overdue' between the plan flip's snapshot and the sequence
  // release's snapshot — completing the plan while leaving its sequence
  // stopped, unrepairable (no active plan left to flip). FOR UPDATE
  // serializes this whole transition against the reopen's own row write:
  // either we complete both legs from a settled invoice before the reopen
  // commits, or we see the reopened status and touch nothing.
  const invoice = await conn('invoices').where({ id: invoiceId }).forUpdate().first('status');
  if (!invoice || !['paid', 'prepaid'].includes(String(invoice.status || ''))) return 0;
  // Settlement is re-verified IN the update statement (codex PR r4 P2): a
  // delayed post-commit caller can run after a dispute reopened the invoice
  // and an admin created a REPLACEMENT plan — completing that plan (and its
  // sequence) on a now-overdue invoice would silently disarm collection.
  // The EXISTS reads the invoice's status at update time, binding the
  // transition to a currently-settled invoice.
  const settledInvoice = function settledInvoice() {
    this.select(1)
      .from('invoices')
      .whereRaw('invoices.id = ??', ['payment_plans.invoice_id'])
      .whereIn('invoices.status', ['paid', 'prepaid']);
  };
  const flipped = await conn('payment_plans')
    .where({ invoice_id: invoiceId, status: 'active' })
    .whereExists(settledInvoice)
    .update({ status: 'completed', completed_at: now, updated_at: now });
  // Release the plan-owned dunning stop too (codex PR r1 P1): the plan's
  // creation left the sequence 'stopped' with a payment_plan_created:<id>
  // stamp, and stopOnPayment deliberately skips stopped rows — without this
  // a later dispute reopen would find isDunningStopped() true forever and
  // suppress every reminder path. 'completed' mirrors stopOnPayment's
  // settled outcome (a dispute reopen re-arms from that state via the
  // existing paths). Unconditional (not gated on flipped>0) so a retry can
  // repair a partial earlier attempt; admin stops with unrelated reasons
  // keep their stamp.
  // 'paused' included: legacy plan creations parked the sequence via
  // pauseSequence(reason: 'payment_plan_created') — the stopped_reason stamp
  // survives the pause, and a stale paused row reads as ACTIVE to
  // hasActiveSequence, suppressing every reminder after a dispute reopen.
  await conn('invoice_followup_sequences')
    .where({ invoice_id: invoiceId })
    .whereIn('status', ['stopped', 'paused'])
    .where('stopped_reason', 'like', 'payment_plan_created:%')
    // Same settled gate as the plan flip above — releasing a replacement
    // plan's stop on a reopened invoice would disarm its dunning ownership.
    .whereExists(function settledInvoiceForSequence() {
      this.select(1)
        .from('invoices')
        .whereRaw('invoices.id = ??', ['invoice_followup_sequences.invoice_id'])
        .whereIn('invoices.status', ['paid', 'prepaid']);
    })
    .update({ status: 'completed', next_touch_at: null, updated_at: now });
  return flipped;
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
