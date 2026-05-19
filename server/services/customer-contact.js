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
 *   getBillingContact(customer, prefs)  -> { phone, email, name }
 *     → returns the billing recipient when notification_prefs.billing_email is
 *       set, else falls back to the primary (payer) contact.
 *
 *   getRecipientsForPurpose(customer, prefs, purpose, channel)
 *     → central resolver for operational vs billing recipient choices.
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

function cleanEmail(v) {
  return clean(v).toLowerCase();
}

function sameEmail(a, b) {
  const ea = cleanEmail(a);
  const eb = cleanEmail(b);
  return !!ea && !!eb && ea === eb;
}

function firstNameFrom(value) {
  return clean(value).split(/\s+/)[0] || '';
}

function getPrimaryContact(customer) {
  if (!customer) return { phone: '', email: '', name: '', role: 'primary' };
  return {
    phone: clean(customer.phone),
    email: clean(customer.email),
    name: clean(customer.first_name) || firstNameFrom(customer.company_name) || '',
    role: 'primary',
  };
}

function getServiceContact(customer) {
  if (!customer) return { phone: '', email: '', name: '', role: 'service_contact' };
  const svcPhone = clean(customer.service_contact_phone);
  const svcEmail = clean(customer.service_contact_email);
  const svcName = clean(customer.service_contact_name);
  const primary = getPrimaryContact(customer);
  return {
    phone: svcPhone || primary.phone,
    email: svcEmail || primary.email,
    name: svcName || primary.name,
    role: 'service_contact',
  };
}

function getBillingContact(customer, prefs = {}) {
  if (!customer) return { phone: '', email: '', name: '', role: 'billing_contact' };
  const primary = getPrimaryContact(customer);
  const billingEmail = clean(prefs.billing_email);
  const billingName = billingEmail ? clean(prefs.billing_contact_name) : '';
  const hasDistinctBillingEmail = !!billingEmail && !sameEmail(billingEmail, primary.email);
  return {
    phone: primary.phone,
    email: billingEmail || primary.email,
    name: billingName || primary.name,
    role: hasDistinctBillingEmail ? 'billing_contact' : 'primary',
  };
}

function samePhone(a, b) {
  const da = clean(a).replace(/\D/g, '').slice(-10);
  const db = clean(b).replace(/\D/g, '').slice(-10);
  return !!da && !!db && da === db;
}

function getAppointmentContacts(customer, prefs = {}) {
  if (!customer) return [];
  const service = getServiceContact(customer);
  const billing = getPrimaryContact(customer);
  const servicePhone = clean(customer.service_contact_phone);
  const hasDistinctServicePhone = !!servicePhone && !samePhone(servicePhone, billing.phone);
  const notifyPrimary = !hasDistinctServicePhone || prefs.appointment_notify_primary === true;
  const contacts = [];

  if (hasDistinctServicePhone) {
    contacts.push({ ...service, role: 'service_contact' });
  }

  if (notifyPrimary && billing.phone && !contacts.some(c => samePhone(c.phone, billing.phone))) {
    contacts.push({ ...billing, role: 'primary' });
  }

  return contacts;
}

function uniqueByEmail(contacts = []) {
  const seen = new Set();
  return contacts.filter((contact) => {
    const email = cleanEmail(contact.email);
    if (!email || seen.has(email)) return false;
    seen.add(email);
    return true;
  });
}

function getInvoiceEmailRecipients(customer, prefs = {}) {
  const billing = getBillingContact(customer, prefs);
  return uniqueByEmail([billing]);
}

function getReceiptEmailRecipients(customer, prefs = {}) {
  return getInvoiceEmailRecipients(customer, prefs);
}

function getServiceReportEmailRecipients(customer, prefs = {}) {
  if (!customer) return [];
  const service = getServiceContact(customer);
  const primary = getPrimaryContact(customer);
  const hasDistinctServiceEmail = !!clean(customer.service_contact_email)
    && !sameEmail(customer.service_contact_email, primary.email);
  const notifyPrimary = !hasDistinctServiceEmail || prefs.service_report_notify_primary === true;
  return uniqueByEmail([
    hasDistinctServiceEmail ? service : null,
    notifyPrimary ? primary : null,
  ].filter(Boolean));
}

function getRecipientsForPurpose(customer, prefs = {}, purpose, channel = 'sms') {
  const normalizedPurpose = String(purpose || '').trim();
  const normalizedChannel = String(channel || '').trim();
  if (normalizedChannel === 'email') {
    if (normalizedPurpose === 'invoice') return getInvoiceEmailRecipients(customer, prefs);
    if (normalizedPurpose === 'receipt') return getReceiptEmailRecipients(customer, prefs);
    if (normalizedPurpose === 'service_report') return getServiceReportEmailRecipients(customer, prefs);
  }
  if (['appointment', 'appointment_reminder', 'tech_en_route'].includes(normalizedPurpose)) {
    return getAppointmentContacts(customer, prefs);
  }
  if (normalizedPurpose === 'billing' || normalizedPurpose === 'payment_link') {
    return [getBillingContact(customer, prefs)].filter((contact) => clean(contact.phone));
  }
  return [getPrimaryContact(customer)].filter((contact) => clean(contact.phone) || clean(contact.email));
}

// True if this customer has a distinct service contact configured. Used by
// audit tools + the admin UI to surface a "Service contact: …" chip.
function hasDistinctServiceContact(customer) {
  if (!customer) return false;
  return !!(clean(customer.service_contact_phone) || clean(customer.service_contact_email));
}

module.exports = {
  getPrimaryContact,
  getServiceContact,
  getBillingContact,
  getAppointmentContacts,
  getInvoiceEmailRecipients,
  getReceiptEmailRecipients,
  getServiceReportEmailRecipients,
  getRecipientsForPurpose,
  hasDistinctServiceContact,
};
