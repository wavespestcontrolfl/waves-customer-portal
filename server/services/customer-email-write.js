/**
 * The operator email write for ONE customer — the Customer 360 edit's email
 * sequence (routes/admin-customers.js PUT /:id) as a callable, so a second
 * operator surface (the triage read-back confirm, PR #4802) delegates to it
 * instead of re-deriving the invariants one Codex round at a time.
 *
 * What the Customer 360 edit does for `customers.email`, in order, and what
 * this does in the same order inside the CALLER's transaction:
 *   1. customers row FOR UPDATE, and `before` is read from the LOCKED row;
 *   2. the shared per-address advisory key (utils/customer-comms-lock.js
 *      lockAssignedCustomerEmails — the key the merge undo, the bounce
 *      recovery's correctedAddressOwnedByOther recheck and the first-touch
 *      release gate all take), AFTER the row lock (row → key is the global
 *      order) and held to commit, through the fanout;
 *   3. the cross-account refusal (findCrossAccountEmailConflict — the same
 *      predicate the Customer 360 route's findCrossAccountContactConflict
 *      uses for its email arm, now decided UNDER the key so it cannot go
 *      stale before the write);
 *   4. the diff-gated `customers.email` write;
 *   5. propagateCustomerEmailChange in the same transaction (snapshots,
 *      newsletter tokens, hold ledger, review cards), whose unrollbackable
 *      sends come back as `emailSync` for the caller to run AFTER commit —
 *      exactly as the Customer 360 route does.
 *
 * Operator semantics, not intake semantics: a same-account sibling profile
 * sharing the address is supported (customers.email is deliberately
 * non-unique); only another ACCOUNT holding it refuses. The automated
 * intake writers keep their own drop-the-email guard
 * (customer-email-fanout.js applyCustomerUpdatesWithEmailClaimGuard).
 *
 * Returns one of:
 *   { outcome: 'customer_not_found' }
 *   { outcome: 'email_in_use', conflict: { id, account_id } }
 *   { outcome: 'unchanged', before, emailSync: null }
 *   { outcome: 'changed', before, emailSync }
 * Refusals are decided before any write, so a caller may roll back or
 * continue on them.
 */
const { cleanValidEmailOrNull } = require('../utils/intake-normalize');

function emailKeyOf(value) {
  return String(value ?? '').trim().toLowerCase();
}

// The Customer 360 email-conflict predicate (routes/admin-customers.js
// findCrossAccountContactConflict delegates its email arm here): another
// live customer on a DIFFERENT account already holds the address.
async function findCrossAccountEmailConflict(conn, { customerId, accountId, email }) {
  const key = emailKeyOf(email);
  if (!key) return null;
  const normalizedAccountId = accountId ? String(accountId) : null;
  const rows = await conn('customers')
    .whereNull('deleted_at')
    .whereNot({ id: customerId })
    .whereRaw('LOWER(email) = ?', [key])
    .select('id', 'account_id', 'first_name', 'last_name', 'email');
  return rows.find((row) => String(row.account_id || row.id) !== normalizedAccountId) || null;
}

async function applyOperatorCustomerEmail(trx, { customerId, email, source = 'operator edit' }) {
  if (!trx || !trx.isTransaction) {
    // The row lock and the advisory key are transaction-scoped: outside a
    // transaction both release immediately and the ownership check is
    // advisory at best. Never silently degrade.
    throw new Error('applyOperatorCustomerEmail requires a transaction');
  }
  const newEmail = cleanValidEmailOrNull(email);
  if (!newEmail) throw new Error('applyOperatorCustomerEmail requires a valid email');
  const before = await trx('customers').where({ id: customerId }).forUpdate().first();
  if (!before) return { outcome: 'customer_not_found' };
  await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, { email: newEmail });
  const conflict = await findCrossAccountEmailConflict(trx, {
    customerId, accountId: before.account_id || before.id, email: newEmail,
  });
  if (conflict) return { outcome: 'email_in_use', conflict: { id: conflict.id, account_id: conflict.account_id || null } };
  if (emailKeyOf(before.email) === emailKeyOf(newEmail)) return { outcome: 'unchanged', before, emailSync: null };
  await trx('customers').where({ id: customerId }).update({ email: newEmail, updated_at: new Date() });
  const emailSync = await require('./customer-email-fanout').propagateCustomerEmailChange(
    { before, after: { ...before, email: newEmail }, source }, trx,
  );
  return { outcome: 'changed', before, emailSync };
}

module.exports = { applyOperatorCustomerEmail, findCrossAccountEmailConflict };
