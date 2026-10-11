/**
 * Per-customer fence on the SET of saved payment methods.
 *
 * A row lock (FOR UPDATE) fences the methods that exist; it cannot fence a method
 * that is INSERTED. StripeService.savePaymentMethod, the only writer that inserts a
 * payment_methods row, commits its insert without the customer row lock, so a
 * transaction that reads the tender (the Intelligence Bar billing type edit) can
 * miss a method saved just before its commit.
 *
 * Both sides take this one transaction-scoped advisory key, hashed the way the
 * repo's other advisory locks are (namespace text, id text):
 *   - the inserter takes it BLOCKING (lockCustomerPaymentMethods) around its insert,
 *     so it serializes behind a reader that holds the key;
 *   - the reader takes it NON-BLOCKING (tryLockCustomerPaymentMethods) while it holds
 *     the customer row. The insert's foreign key needs the customer row, so a
 *     blocking reader and a waiting inserter could deadlock; a try-lock refuses the
 *     edit instead of waiting.
 */
const PAYMENT_METHODS_LOCK_NS = 'payment-methods';

async function lockCustomerPaymentMethods(trx, customerId) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [PAYMENT_METHODS_LOCK_NS, String(customerId)]);
}

async function tryLockCustomerPaymentMethods(trx, customerId) {
  const res = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked', [PAYMENT_METHODS_LOCK_NS, String(customerId)]);
  const row = res && res.rows ? res.rows[0] : (Array.isArray(res) ? res[0] : res);
  return !!(row && row.locked);
}

module.exports = { PAYMENT_METHODS_LOCK_NS, lockCustomerPaymentMethods, tryLockCustomerPaymentMethods };
