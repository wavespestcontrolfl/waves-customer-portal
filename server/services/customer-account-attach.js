/**
 * The ONE place that creates a brand-new customer_accounts row for an
 * existing (unattached) customer profile and points that profile at it.
 * Codex #4737 r9 P1: admin-customers.js's attachMatchedCustomerToAccount and
 * inspection-public.js's attachLinkedProfileToOwnAccount had drifted into
 * two copies of this exact write — extracted here so both call one
 * implementation. Callers own their own guards (account_id-already-set
 * short circuit, comms-lock fencing, fresh re-reads, etc.) — this function
 * only performs the write, unconditionally, against whatever row it is
 * given. Accepts a knex handle or a transaction.
 */
async function attachCustomerToNewAccount(trx, customer) {
  const accountId = customer.id;
  await trx('customer_accounts')
    .insert({
      id: accountId,
      first_name: customer.first_name,
      last_name: customer.last_name,
      phone: customer.phone || null,
      email: customer.email ? String(customer.email).trim().toLowerCase() : null,
      company_name: customer.company_name || null,
      created_at: customer.created_at || new Date(),
      updated_at: new Date(),
    })
    .onConflict('id')
    .ignore();

  await trx('customers')
    .where({ id: customer.id })
    .update({
      account_id: accountId,
      is_primary_profile: customer.is_primary_profile === false ? false : true,
      profile_label: customer.profile_label || 'Primary',
      updated_at: new Date(),
    });

  return accountId;
}

module.exports = { attachCustomerToNewAccount };
