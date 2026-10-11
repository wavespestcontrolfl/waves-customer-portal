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
 *   - A null customer id locks nothing; a reopen site whose estimate may have no customer_id uses
 *     lockCustomerEstimatesForEstimate, which also locks the prospective owner.
 */

async function lockCustomerEstimates(trx, customerId) {
  if (!customerId) return;
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
    [`customer-estimates:${customerId}`],
  );
}

/**
 * Lock for a REOPEN site, where the estimate may have no customer_id yet (or one that differs from the
 * customer the accept would land on). Locks the estimate's own customer AND the prospective owner the
 * accept resolves to (resolveProspectiveAcceptCustomer: the estimate group's owner, then the phone match),
 * so an unarchive or revival of a phone-matched row cannot race the booking's open-estimate check.
 * The resolver runs on a copy with customer_id cleared so it reports the prospective owner even for a
 * linked row. Both ids are locked in sorted order (one order everywhere); a failed lookup logs and locks
 * what is known. Same leaf rule as lockCustomerEstimates: take it after the row and other locks.
 */
async function lockCustomerEstimatesForEstimate(trx, estimate) {
  const ids = new Set();
  if (estimate?.customer_id) ids.add(String(estimate.customer_id));
  try {
    const { resolveProspectiveAcceptCustomer } = require('../services/recurring-card-on-file');
    const { customerId } = await resolveProspectiveAcceptCustomer({ ...estimate, customer_id: null }, trx, { authoritative: true });
    if (customerId) ids.add(String(customerId));
  } catch (err) {
    require('../services/logger').warn(`[customer-estimate-lock] prospective owner lookup failed: ${err.message}`);
  }
  for (const id of [...ids].sort()) await lockCustomerEstimates(trx, id);
}

module.exports = { lockCustomerEstimates, lockCustomerEstimatesForEstimate };
