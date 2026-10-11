/**
 * Shared per-customer advisory lock for estimate creation and reopening.
 *
 * One key namespace, `customer-estimates:<customer id>`, serializes every
 * writer that INSERTs or REOPENS an estimate for a known customer against the
 * reader that must not miss it: a booking that checks "does this customer have
 * ANY open estimate?" (the Intelligence Bar's start_program, inside the
 * Schedule booking transaction). Under READ COMMITTED a plain SELECT cannot
 * see an estimate another transaction has inserted but not committed, and row
 * locks cannot fence a row that does not exist yet.
 *
 * The check is "any open estimate", not "an open estimate for this service
 * family", so a pure REVISION of an already-open estimate (reprice, service
 * opt-in/out, triage rewrite) cannot change the answer and takes no lock here.
 * Only a writer that makes an estimate open for a customer (insert, unarchive,
 * extend, revive) does.
 *
 * Same scheme as customer-comms-lock.js (pg_advisory_xact_lock over
 * hashtextextended of a namespaced string, transaction-scoped):
 *   - Callers MUST hold an open transaction.
 *   - Re-acquisition inside one transaction is a no-op.
 *   - LOCK ORDER: this lock is a leaf. Take the estimate ROW lock first (when the
 *     site updates an existing row), then this lock immediately before the write
 *     (or, for the booking, right before the open-estimate read), after the
 *     transaction's other locks, and take no other lock after it.
 *   - A null customer id locks nothing (an estimate with no customer cannot be
 *     the open estimate of a customer's booking).
 */

async function lockCustomerEstimates(trx, customerId) {
  if (!customerId) return;
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
    [`customer-estimates:${customerId}`],
  );
}

module.exports = { lockCustomerEstimates };
