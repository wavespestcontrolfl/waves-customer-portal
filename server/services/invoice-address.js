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

const ZIP_RE = /^\d{5}(-\d{4})?$/;
const STATE_RE = /^[A-Z]{2}$/;
const ADDRESS_LIMITS = { address_line1: 200, city: 100 };

function addressError(message) {
  return Object.assign(new Error(message), { status: 400, statusCode: 400, isOperational: true, code: 'invalid_address' });
}

/**
 * Staff correction input → a complete snapshot, or a 400. The unit rides in
 * the street line: the receipt page and PDFs print address_line1 only, so a
 * separate line 2 would be saved but never shown. line 2 is cleared so the
 * email Property row (which does print it) cannot keep a stale unit.
 */
function normalizeInvoiceAddressInput(input = {}) {
  const text = (field) => String(input[field] ?? '').trim().replace(/\s+/g, ' ');
  const address = {
    address_line1: text('address_line1'),
    address_line2: null,
    city: text('city'),
    state: text('state').toUpperCase(),
    zip: text('zip'),
  };
  if (!address.address_line1 || !address.city || !address.state || !address.zip) {
    throw addressError('Street, city, state and ZIP are all required.');
  }
  for (const [field, max] of Object.entries(ADDRESS_LIMITS)) {
    if (address[field] && address[field].length > max) throw addressError(`${field.replace(/_/g, ' ')} is too long.`);
  }
  if (!STATE_RE.test(address.state)) throw addressError('State must be a two-letter code (e.g. FL).');
  if (!ZIP_RE.test(address.zip)) throw addressError('ZIP must be 5 digits (or ZIP+4).');
  return address;
}

async function loadDisplayedInvoiceAddress(conn, invoice) {
  const customer = await conn('customers').where({ id: invoice.customer_id }).first(...ADDRESS_FIELDS);
  return invoiceAddressSnapshot(invoiceCustomerAddress(invoice, customer || {}));
}

/** The address an invoice's documents (receipt page, PDF, emails) display. */
async function getInvoiceDisplayedAddress(conn, invoiceId) {
  const invoice = await conn('invoices').where({ id: invoiceId }).first('id', 'customer_id', 'customer_address_snapshot');
  if (!invoice) return null;
  return loadDisplayedInvoiceAddress(conn, invoice);
}

/** The snapshot when staff corrected it (correctInvoiceAddress), else null. */
function correctedInvoiceAddress(invoice) {
  const snapshot = invoice?.customer_address_snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return snapshot.corrected_at ? snapshot : null;
}

/**
 * Staff correction of the address printed on ONE invoice and its receipt.
 * Rewrites only customer_address_snapshot — presentation data. Amounts,
 * status, the customer profile, saved properties and payer bill-to stay
 * untouched, and nothing is sent. Returns { before, after } for the audit.
 */
async function correctInvoiceAddress(trx, invoiceId, input) {
  // corrected_at marks a staff correction: it outranks the linked visit's
  // address in billing emails (billing-email-details invoicePropertyAddress).
  const after = { ...normalizeInvoiceAddressInput(input), corrected_at: new Date().toISOString() };
  const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate()
    .first('id', 'customer_id', 'customer_address_snapshot');
  if (!invoice) return null;
  const before = await loadDisplayedInvoiceAddress(trx, invoice);
  await trx('invoices').where({ id: invoiceId }).update({ customer_address_snapshot: after, updated_at: trx.fn.now() });
  return { invoice, before, after };
}

/**
 * correctInvoiceAddress plus its critical before/after audit row in ONE
 * transaction — the single writer behind PUT /api/admin/invoices/:id/receipt-address
 * and the Intelligence Bar's correct_invoice_address, so a correction can
 * never land without its audit row. `conn` is the knex handle; `actor` is
 * { actorId, ip, userAgent, via? } (via marks a non-route surface). Resolves
 * the correction, or null for an unknown invoice.
 */
async function correctInvoiceAddressAudited(conn, invoiceId, input, { actorId = null, ip = null, userAgent = null, via = null } = {}) {
  const { recordAuditEvent } = require('./audit-log');
  return conn.transaction(async (trx) => {
    const corrected = await correctInvoiceAddress(trx, invoiceId, input);
    if (!corrected) return null;
    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: actorId,
      action: 'invoice.address.correct',
      resource_type: 'invoice',
      resource_id: corrected.invoice.id,
      metadata: { customerId: corrected.invoice.customer_id, before: corrected.before, after: corrected.after, ...(via ? { via } : {}) },
      ip_address: ip,
      user_agent: userAgent,
      critical: true,
      trx,
    });
    return corrected;
  });
}

module.exports = {
  invoiceAddressSnapshot, invoiceCustomerAddress, freezeCustomerInvoiceAddresses,
  normalizeInvoiceAddressInput, getInvoiceDisplayedAddress, correctInvoiceAddress, correctInvoiceAddressAudited, correctedInvoiceAddress,
};
