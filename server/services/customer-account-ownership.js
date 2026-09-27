const { lockCustomerComms } = require('../utils/customer-comms-lock');

class EstimateOwnerMovedError extends Error {}

function canonicalCustomerAccountId(customer) {
  if (!customer?.id) return null;
  return String(customer.account_id || customer.id);
}

function sameCustomerAccount(left, right) {
  const leftAccount = canonicalCustomerAccountId(left);
  const rightAccount = canonicalCustomerAccountId(right);
  return !!leftAccount && leftAccount === rightAccount;
}

async function loadCustomerAccountRow(conn, customer, { forShare = false } = {}) {
  if (!customer) return null;
  if (typeof customer === 'object' && customer.id && customer.account_id !== undefined) {
    return customer;
  }
  const id = typeof customer === 'object' ? customer.id : customer;
  if (!id) return null;
  const query = conn('customers')
    .where({ id })
    .whereNull('deleted_at');
  if (forShare) query.forShare();
  return query.first('id', 'account_id');
}

async function estimateBelongsToCustomerAccount(conn, estimate, customer, { lockOwner = false } = {}) {
  if (!estimate?.customer_id || !customer) return false;
  const customerId = typeof customer === 'object' ? customer.id : customer;
  if (customerId && String(estimate.customer_id) === String(customerId)) return true;

  const [ownerRow, bookingRow] = await Promise.all([
    loadCustomerAccountRow(conn, estimate.customer_id, { forShare: lockOwner }),
    loadCustomerAccountRow(conn, customer, { forShare: lockOwner }),
  ]);
  return sameCustomerAccount(ownerRow, bookingRow);
}

async function loadEstimateOwnershipSnapshots(conn, estimateIds) {
  const ids = [...new Set((estimateIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const rows = await conn('estimates').whereIn('id', ids).select('id', 'customer_id');
  const byId = new Map(rows.map(row => [String(row.id), row]));
  return ids.map((id) => ({
    id,
    exists: byId.has(id),
    customerId: byId.get(id)?.customer_id ? String(byId.get(id).customer_id) : null,
  }));
}

function estimateOwnershipCustomerIds(snapshot, bookingCustomer) {
  const bookingCustomerId = typeof bookingCustomer === 'object' ? bookingCustomer?.id : bookingCustomer;
  return [...new Set([bookingCustomerId, snapshot?.customerId].filter(Boolean).map(String))].sort();
}

async function lockCustomerAccountRows(trx, customerIds, { forUpdate = false, columns = [] } = {}) {
  const ids = [...new Set((customerIds || []).filter(Boolean).map(String))].sort();
  if (!ids.length) return [];
  const query = trx('customers')
    .whereIn('id', ids)
    .whereNull('deleted_at')
    .orderBy('id');
  if (forUpdate) query.forUpdate();
  else query.forShare();
  const selected = columns.includes('*') ? ['*'] : [...new Set(['id', 'account_id', ...columns])];
  return query.select(...selected);
}

// Estimate-first writers share this fence with booking's customer-first
// ownership checks. The expected owner comes from an unlocked read; fence it
// before any row lock, then reject drift under the estimate lock. A caller
// must never chase a newly observed owner after this throws.
async function lockEstimateOwnerForUpdate(trx, estimate, { columns = [] } = {}) {
  const expectedOwnerId = estimate?.customer_id ? String(estimate.customer_id) : null;
  if (expectedOwnerId) await lockCustomerComms(trx, expectedOwnerId);
  const selected = [...new Set(['id', 'customer_id', ...columns])];
  const lockedEstimate = await trx('estimates')
    .where({ id: estimate?.id }).forUpdate().first(...selected);
  if (!lockedEstimate
    || String(lockedEstimate.customer_id || '') !== String(expectedOwnerId || '')) {
    throw new EstimateOwnerMovedError();
  }
  return lockedEstimate;
}

function estimateOwnershipMatchesLockedRows(snapshot, estimate, bookingCustomer, lockedCustomers) {
  if (!snapshot?.exists || !estimate) return false;
  const freshOwnerId = estimate.customer_id ? String(estimate.customer_id) : null;
  if (freshOwnerId !== snapshot.customerId) return false;
  if (!freshOwnerId) return true;
  const bookingCustomerId = typeof bookingCustomer === 'object' ? bookingCustomer?.id : bookingCustomer;
  const bookingRow = (lockedCustomers || []).find(row => String(row.id) === String(bookingCustomerId));
  const ownerRow = (lockedCustomers || []).find(row => String(row.id) === freshOwnerId);
  return sameCustomerAccount(ownerRow, bookingRow);
}

async function validateEstimateOwnershipUnderLock(trx, snapshot, bookingCustomer, options = {}) {
  if (!snapshot?.exists) return false;
  const query = trx('estimates').where({ id: snapshot.id });
  if (options.forUpdate) query.forUpdate();
  else query.forShare();
  const fields = options.columns?.length ? options.columns : ['id', 'customer_id'];
  const freshEstimate = await query.first(...fields);
  if (!freshEstimate) return false;
  if (options.lockedCustomers) {
    return estimateOwnershipMatchesLockedRows(
      snapshot,
      freshEstimate,
      bookingCustomer,
      options.lockedCustomers,
    ) ? freshEstimate : false;
  }
  const freshOwnerId = freshEstimate.customer_id ? String(freshEstimate.customer_id) : null;
  if (freshOwnerId !== snapshot.customerId) return false;
  const owned = !freshOwnerId || await estimateBelongsToCustomerAccount(
    trx, freshEstimate, bookingCustomer, { lockOwner: true },
  );
  return owned ? freshEstimate : false;
}

module.exports = {
  EstimateOwnerMovedError,
  canonicalCustomerAccountId,
  sameCustomerAccount,
  estimateBelongsToCustomerAccount,
  loadEstimateOwnershipSnapshots,
  estimateOwnershipCustomerIds,
  lockCustomerAccountRows,
  lockEstimateOwnerForUpdate,
  estimateOwnershipMatchesLockedRows,
  validateEstimateOwnershipUnderLock,
};
