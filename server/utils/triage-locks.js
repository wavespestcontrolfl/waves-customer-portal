/**
 * Shared per-call advisory lock for triage_items writers.
 *
 * Any writer that transitions a call's triage cards AND recomputes the
 * call_log.review_status aggregate must take this transaction-scoped lock
 * FIRST (before touching any card row). Two writers on the same call then
 * fully serialize — no row-lock acquisition-order deadlocks between the
 * nightly sweep's ordered pre-lock and the admin verdict's bulk UPDATE, and
 * no interleaved counts that strand review_status 'open' on a fully-terminal
 * call. Writers on different calls never contend.
 *
 * Same pg_advisory_xact_lock(hashtext, hashtext) idiom as the
 * call-recording-schedule lock in call-recording-processor.js. The lock
 * releases automatically at transaction commit/rollback — callers MUST hold
 * an open transaction.
 */

const LOCK_NAMESPACE = 'triage-call-review';

async function lockTriageCall(trx, callLogId) {
  if (!callLogId) return;
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    [LOCK_NAMESPACE, String(callLogId)],
  );
}

/**
 * Customer-scoped companion for writers whose DECISION spans several of a
 * customer's cards at once — today the unit-number resolver, which may only
 * resolve when exactly one same-building ask exists, so its candidate SELECT
 * and its UPDATE must see the same set. Two such writers on one customer
 * fully serialize; per-call writers are unaffected.
 *
 * GLOBAL LOCK ORDER: this customer lock is acquired FIRST, before any
 * lockTriageCall and before any row lock. Nothing else takes it, so it
 * cannot participate in a cycle with the existing per-call ordering.
 */
const CUSTOMER_LOCK_NAMESPACE = 'triage-customer-review';

async function lockTriageCustomer(trx, customerId) {
  if (!customerId) return;
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    [CUSTOMER_LOCK_NAMESPACE, String(customerId)],
  );
}

module.exports = { lockTriageCall, lockTriageCustomer, LOCK_NAMESPACE, CUSTOMER_LOCK_NAMESPACE };
