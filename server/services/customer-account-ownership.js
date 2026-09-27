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

async function validateEstimateOwnershipUnderLock(trx, snapshot, bookingCustomer) {
  if (!snapshot?.exists) return false;
  const freshEstimate = await trx('estimates')
    .where({ id: snapshot.id })
    .forShare()
    .first('id', 'customer_id');
  if (!freshEstimate) return false;
  const freshOwnerId = freshEstimate.customer_id ? String(freshEstimate.customer_id) : null;
  if (freshOwnerId !== snapshot.customerId) return false;
  return !freshOwnerId || estimateBelongsToCustomerAccount(
    trx,
    freshEstimate,
    bookingCustomer,
    { lockOwner: true },
  );
}

module.exports = {
  canonicalCustomerAccountId,
  sameCustomerAccount,
  estimateBelongsToCustomerAccount,
  loadEstimateOwnershipSnapshots,
  validateEstimateOwnershipUnderLock,
};
