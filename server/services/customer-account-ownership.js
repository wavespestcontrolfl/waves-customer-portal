function sameCustomerAccount(left, right) {
  if (!left?.id || !right?.id) return false;
  if (String(left.id) === String(right.id)) return true;

  const leftAccount = left.account_id ? String(left.account_id) : null;
  const rightAccount = right.account_id ? String(right.account_id) : null;
  return Boolean(
    (leftAccount && rightAccount && leftAccount === rightAccount)
    || (leftAccount && leftAccount === String(right.id))
    || (rightAccount && rightAccount === String(left.id)),
  );
}

async function loadCustomerAccountRow(conn, customer) {
  if (!customer) return null;
  if (typeof customer === 'object' && customer.id && customer.account_id !== undefined) {
    return customer;
  }
  const id = typeof customer === 'object' ? customer.id : customer;
  if (!id) return null;
  return conn('customers')
    .where({ id })
    .whereNull('deleted_at')
    .first('id', 'account_id');
}

async function estimateBelongsToCustomerAccount(conn, estimate, customer) {
  if (!estimate?.customer_id || !customer) return false;
  const customerId = typeof customer === 'object' ? customer.id : customer;
  if (customerId && String(estimate.customer_id) === String(customerId)) return true;

  const [ownerRow, bookingRow] = await Promise.all([
    loadCustomerAccountRow(conn, estimate.customer_id),
    loadCustomerAccountRow(conn, customer),
  ]);
  return sameCustomerAccount(ownerRow, bookingRow);
}

module.exports = {
  sameCustomerAccount,
  estimateBelongsToCustomerAccount,
};
