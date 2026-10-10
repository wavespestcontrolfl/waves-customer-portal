/**
 * Shared per-customer advisory lock for estimate creation.
 *
 * One key namespace, `customer-estimates:<customer id>`, serializes every
 * writer that INSERTs an estimate for a known customer against the reader that
 * must not miss it: a booking that checks "is there an open estimate for this
 * service?" (the Intelligence Bar's start_program, inside the Schedule
 * booking transaction). Under READ COMMITTED a plain SELECT cannot see an
 * estimate another transaction has inserted but not committed, and row locks
 * cannot fence a row that does not exist yet.
 *
 * Same scheme as customer-comms-lock.js (pg_advisory_xact_lock over
 * hashtextextended of a namespaced string, transaction-scoped):
 *   - Callers MUST hold an open transaction; use `withCustomerEstimateLock`
 *     when the site has none of its own.
 *   - Re-acquisition inside one transaction is a no-op.
 *   - LOCK ORDER: this lock is a leaf. Take it immediately before the
 *     estimates INSERT (insert sites) or right before the open-estimate read
 *     (the booking), after the transaction's other locks, and take no other
 *     lock after it in the same transaction.
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

async function withCustomerEstimateLock(db, customerId, fn) {
  return db.transaction(async (trx) => {
    await lockCustomerEstimates(trx, customerId);
    return fn(trx);
  });
}

module.exports = { lockCustomerEstimates, withCustomerEstimateLock };
