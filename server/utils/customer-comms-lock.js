/**
 * Shared per-customer advisory lock for comms-affecting writers.
 *
 * ONE key namespace — `customer-comms:<customer id>` — serializes every
 * writer whose commit changes WHO receives a customer's comms against the
 * probes that must not miss it:
 *
 *   - every `scheduled_services` INSERT (appointment/service-report comms
 *     resolve their recipients LIVE from the customer row at send time, so
 *     a new visit silently depends on the row's service_contact* slots);
 *   - the template-run executor's `email_template_automation_runs` insert
 *     (recipient_id is a STRING customer id with no FK — row locks cannot
 *     fence it);
 *   - the merge-undo's identity/service-contact/email probes in
 *     customer-dedupe.js revertMerge (an absence probe under READ COMMITTED
 *     cannot see a concurrent uncommitted INSERT — the phantom this lock
 *     exists to close);
 *   - booking's capture-intent lane (booking.js), which already used the
 *     resolve → lock → re-resolve idiom.
 *
 * LOCK ORDER CONTRACT (deadlock safety):
 *   1. Take this lock BEFORE locking or updating the same customer's
 *      `customers` row in the same transaction, and as early as the
 *      customer id is known. revertMerge takes it as the FIRST lock of its
 *      transaction; a creator that acquired the customers row first and
 *      then waited here would deadlock against an undo holding this lock
 *      and waiting on that row.
 *   2. `pg_advisory_xact_lock` is transaction-scoped — callers MUST hold an
 *      open transaction, or the lock releases at the end of the acquiring
 *      statement and fences nothing. Use `withCustomerCommsLock` when the
 *      calling site has no transaction of its own.
 *   3. Re-acquisition within one transaction is a no-op (advisory locks are
 *      reentrant per session), so helpers may take it defensively.
 *
 * KEY DERIVATION is centralized HERE and nowhere else:
 *   pg_advisory_xact_lock(hashtextextended('customer-comms:' || <id>, 0))
 */

// pg_advisory_xact_lock BLOCKS with no deadline of its own, and one of its
// callers is the call-processing pass — which awaits enrollment while holding
// a processing claim whose heartbeat keeps beating. An unbounded wait there
// wedges the call exactly as an unbounded provider call did (codex #3677 P1).
// SET LOCAL scopes this to the calling transaction, so a contended lock now
// raises instead of hanging, and every caller already handles a failed
// transaction. Contention on a per-customer comms key is momentary; ten
// seconds is generous for it and finite for everything else.
const LOCK_WAIT_TIMEOUT = '10s';

async function lockCustomerComms(trx, customerId) {
  if (!customerId) return;
  // SET LOCAL lasts to the END of the transaction, not to the next
  // statement, so setting it bare would hand this timeout to every later
  // write in a booking, scheduling or estimate transaction and would widen a
  // stricter one a caller had already chosen (codex #3677 P1). Read the
  // value in force, bound only the acquisition, put it back either way.
  const previous = await trx.raw('SHOW lock_timeout')
    .then((res) => res?.rows?.[0]?.lock_timeout)
    .catch(() => null);
  await trx.raw(`SET LOCAL lock_timeout = '${LOCK_WAIT_TIMEOUT}'`);
  try {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
      [`customer-comms:${customerId}`],
    );
  } finally {
    // Restoring inside finally matters: on a lock timeout the caller's catch
    // may still run more statements in this transaction.
    if (previous) await trx.raw('SET LOCAL lock_timeout = ?', [previous]).catch(() => {});
    else await trx.raw('RESET lock_timeout').catch(() => {});
  }
}

/**
 * Non-blocking variant for writers that ALREADY hold row locks the
 * merge-undo takes after this key (invoices, customers, journaled visits) —
 * e.g. annual-prepay activation, which holds invoice/term rows before it
 * seeds visits. Blocking there would deadlock (writer holds rows, waits on
 * comms; undo holds comms, wants rows). Returns true when acquired; on
 * false the caller proceeds UNFENCED and logs — the residual is an undo of
 * this exact customer mid-transaction at that instant, and the losing
 * interleavings degrade comms routing, never money (same degrade posture as
 * occupancy's tryAcquireOccupancyLock).
 */
async function tryLockCustomerComms(trx, customerId) {
  if (!customerId) return true;
  const res = await trx.raw(
    'SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked',
    [`customer-comms:${customerId}`],
  );
  const row = res && res.rows ? res.rows[0] : (Array.isArray(res) ? res[0] : null);
  return !!(row && (row.locked === true || row.locked === 't'));
}

/**
 * Open a transaction on `db`, take the customer-comms lock, and run `fn(trx)`
 * inside it — for insert sites that have no transaction of their own. The
 * lock releases with the commit/rollback.
 */
async function withCustomerCommsLock(db, customerId, fn) {
  return db.transaction(async (trx) => {
    await lockCustomerComms(trx, customerId);
    return fn(trx);
  });
}

module.exports = { lockCustomerComms, tryLockCustomerComms, withCustomerCommsLock };
