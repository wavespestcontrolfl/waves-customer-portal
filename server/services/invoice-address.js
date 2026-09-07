/** Invoice document addresses are historical presentation data. Recipient
 * contact details and payment/bill-to authority continue using live records.
 */
const ADDRESS_FIELDS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];

function invoiceAddressSnapshot(customer) {
  return Object.fromEntries(ADDRESS_FIELDS.map(field => [field, customer?.[field] ?? null]));
}

function invoiceCustomerAddress(invoice, customer) {
  if (!customer || !invoice?.customer_address_snapshot) return customer;
  const snapshot = invoice.customer_address_snapshot;
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) return customer;
  return { ...customer, ...Object.fromEntries(ADDRESS_FIELDS.filter(field => Object.hasOwn(snapshot, field)).map(field => [field, snapshot[field]])) };
}

async function freezeCustomerInvoiceAddresses(trx, customer) {
  // Billing can hold invoice -> customer while primary changes hold customer
  // -> invoice. Refuse contention instead of waiting and forming a lock cycle.
  try {
    await trx('invoices').where({ customer_id: customer.id }).whereNull('customer_address_snapshot')
      .orderBy('id').forUpdate().noWait().select('id');
  } catch (err) {
    if (err.code !== '55P03') throw err;
    throw Object.assign(new Error('Billing records are being updated. Try the primary-property change again after that operation finishes.'), {
      status: 409, statusCode: 409, isOperational: true, code: 'property_busy',
    });
  }
  return trx('invoices').where({ customer_id: customer.id }).whereNull('customer_address_snapshot')
    .update({ customer_address_snapshot: invoiceAddressSnapshot(customer) });
}

module.exports = { invoiceAddressSnapshot, invoiceCustomerAddress, freezeCustomerInvoiceAddresses };
