/**
 * Customer contact routing.
 *
 * Small helper so every service that targets a "beneficiary" (the person
 * who experiences the service and should review it) picks the right phone
 * / email without each caller reimplementing the fallback logic.
 *
 *   getServiceContact(customer)  -> { phone, email, name }
 *     → returns service_contact_* when set, else falls back to the primary
 *       phone / email / first_name. Empty strings are treated as absent.
 *
 *   getBillingContact(customer)  -> { phone, email, name }
 *     → always returns the primary (payer) contact. Exported for symmetry;
 *       callers can use it to make the split explicit at the call site.
 *
 * Rules:
 *   - Fields are independent: a customer can have only a service phone but
 *     no service email, or vice-versa. Each field falls back to primary
 *     individually.
 *   - A whitespace-only value is treated as absent.
 */

function clean(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s;
}

function getServiceContact(customer) {
  if (!customer) return { phone: '', email: '', name: '' };
  const svcPhone = clean(customer.service_contact_phone);
  const svcEmail = clean(customer.service_contact_email);
  const svcName = clean(customer.service_contact_name);
  return {
    phone: svcPhone || clean(customer.phone),
    email: svcEmail || clean(customer.email),
    name: svcName || clean(customer.first_name) || '',
  };
}

function getBillingContact(customer) {
  if (!customer) return { phone: '', email: '', name: '' };
  return {
    phone: clean(customer.phone),
    email: clean(customer.email),
    name: clean(customer.first_name) || '',
  };
}

// True if this customer has a distinct service contact configured. Used by
// audit tools + the admin UI to surface a "Service contact: …" chip.
function hasDistinctServiceContact(customer) {
  if (!customer) return false;
  return !!(clean(customer.service_contact_phone) || clean(customer.service_contact_email));
}

module.exports = {
  getServiceContact,
  getBillingContact,
  hasDistinctServiceContact,
};
