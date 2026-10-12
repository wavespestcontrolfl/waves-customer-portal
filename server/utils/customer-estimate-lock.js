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
 *   - Every call takes the customer row FOR KEY SHARE first (see lockCustomersThenEstimates), so no caller orders
 *     the advisory lock ahead of the customer row.
 *   - Re-acquisition inside one transaction is a no-op.
 *   - LOCK ORDER: this lock is a leaf. Take the estimate ROW lock first (when the
 *     site updates an existing row), then this lock immediately before the write
 *     (or, for the booking, right before the open-estimate read), after the
 *     transaction's other locks, and take no other lock after it.
 *   - A null customer id locks nothing; a reopen site whose estimate may have no customer_id uses
 *     lockCustomerEstimatesForEstimate, which also locks the prospective owner.
 */

// The customer ROW first (FOR KEY SHARE), then the advisory lock. An INSERT of an estimate row for a customer takes a
// FOR KEY SHARE lock on that customer anyway (the foreign key); the booking holds the customer row FOR UPDATE and then
// asks for this advisory lock. A writer that took the advisory lock first and met the foreign key second would wait on
// the booking while the booking waits on it. Taking the row share first makes every writer queue behind the booking
// before it holds anything. Rows are locked in sorted order, then the advisory locks in the same order.
async function lockCustomersThenEstimates(trx, customerIds) {
  const ids = [...new Set(customerIds.filter(Boolean).map(String))].sort();
  for (const id of ids) await trx('customers').where({ id }).forKeyShare().first('id');
  for (const id of ids) {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
      [`customer-estimates:${id}`],
    );
  }
}

async function lockCustomerEstimates(trx, customerId) {
  if (!customerId) return;
  await lockCustomersThenEstimates(trx, [customerId]);
}

/**
 * Lock for a REOPEN site, where the estimate may have no customer_id yet (or one that differs from the
 * customer the accept would land on). Locks the estimate's own customer AND the prospective owner the
 * accept resolves to (resolveProspectiveAcceptCustomer: the estimate group's owner, then the phone match),
 * so an unarchive or revival of a phone-matched row cannot race the booking's open-estimate check.
 * The resolver runs on a copy with customer_id cleared so it reports the prospective owner even for a
 * linked row. Both ids are locked in sorted order (one order everywhere); a failed lookup locks the linked
 * customer when there is one and throws (503) when the estimate is ownerless. Same leaf rule as lockCustomerEstimates: take it after the row and other locks.
 */
async function estimateOwnerIds(trx, estimate) {
  const ids = new Set();
  if (estimate?.customer_id) ids.add(String(estimate.customer_id));
  // A failed owner lookup (a throw or lookupFailed) cannot fence an estimate that already has an owner any less than the
  // known link does: lock the linked customer and carry on. Only an OWNERLESS estimate fails closed (503), because then
  // nothing is known to lock and the prospective owner's booking check would go unfenced.
  const unverified = (cause) => Object.assign(new Error(`Could not verify the estimate owner${cause ? ` (${cause})` : ''}.`), { code: 'ESTIMATE_OWNER_UNVERIFIED', statusCode: 503 });
  try {
    const { resolveProspectiveAcceptCustomer } = require('../services/recurring-card-on-file');
    const { customerId, lookupFailed } = await resolveProspectiveAcceptCustomer({ ...estimate, customer_id: null }, trx, { authoritative: true });
    if (lookupFailed) throw new Error('owner lookup failed');
    if (customerId) ids.add(String(customerId));
  } catch (err) {
    if (!ids.size) throw unverified(err.message);
    require('../services/logger').warn(`[customer-estimate-lock] prospective owner lookup failed; locking the linked customer only: ${err.message}`);
  }
  return [...ids];
}

async function lockCustomerEstimatesForEstimate(trx, estimate) {
  await lockCustomersThenEstimates(trx, await estimateOwnerIds(trx, estimate));
}

/**
 * Customer rows only (FOR KEY SHARE), for a caller that is about to take an `estimates` row FOR UPDATE. The merge locks
 * customer rows first and repoints estimates second, so a caller that held the estimate row and then asked for the
 * customer row could deadlock with it. Call this BEFORE the estimate FOR UPDATE (on an unlocked read or the caller's
 * snapshot), re-check customer_id on the locked estimate (refuse on change), and take the advisory lock afterwards with
 * lockCustomerEstimatesForEstimate, which finds the rows already held.
 */
async function lockCustomerRowsForEstimate(trx, estimate) {
  const ids = [...new Set((await estimateOwnerIds(trx, estimate)).map(String))].sort();
  for (const id of ids) await trx('customers').where({ id }).forKeyShare().first('id');
}

/**
 * Lock for an UNLINKED estimate insert that carries only contact data (an engine draft for a call, where the phone may be
 * shared and the profile match ambiguous). The open-estimate reader counts an unlinked row as a customer's when the
 * accept's phone match lands on that customer, so every customer the phone or email could match is locked, together with
 * a known customerId and the prospective owner the accept resolves to. An ownerless contact whose owner lookup fails
 * throws (503): nothing is known to lock, and the insert must not go unfenced. The candidate reads run on the caller's
 * transaction and their failures propagate. Same leaf rule as lockCustomerEstimates: take it right before the insert.
 */
async function contactCandidateIds(trx, { phone, email }) {
  const ids = [];
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length >= 7) {
    const rows = await trx('customers').whereNull('deleted_at')
      .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`]).select('id');
    ids.push(...rows.map((r) => r.id));
  }
  const mail = String(email || '').trim().toLowerCase();
  if (mail) {
    const rows = await trx('customers').whereNull('deleted_at').whereRaw('lower(email) = ?', [mail]).select('id');
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

async function lockCustomerEstimatesForContact(trx, { customerId = null, phone = null, email = null } = {}) {
  const ids = [customerId, ...(await contactCandidateIds(trx, { phone, email }))].filter(Boolean).map(String);
  if (phone) {
    const { resolveProspectiveAcceptCustomer } = require('../services/recurring-card-on-file');
    const { customerId: ownerId, lookupFailed } = await resolveProspectiveAcceptCustomer({ customer_phone: phone }, trx, { authoritative: true });
    if (ownerId) ids.push(String(ownerId));
    if (lookupFailed && !ids.length) {
      throw Object.assign(new Error('Could not verify the estimate owner, so the draft was not created.'), { code: 'ESTIMATE_OWNER_UNVERIFIED', statusCode: 503 });
    }
  }
  await lockCustomersThenEstimates(trx, ids);
}

module.exports = { lockCustomerEstimates, lockCustomerEstimatesForEstimate, lockCustomerRowsForEstimate, lockCustomerEstimatesForContact };
