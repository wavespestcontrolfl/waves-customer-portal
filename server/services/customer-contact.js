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

// Up to three on-location contacts per customer. Slot 1 keeps the original
// column names so single-beneficiary consumers (getServiceContact) are
// untouched; slots 2/3 only participate in the multi-recipient fan-outs.
const SERVICE_CONTACT_SLOTS = [
  { name: 'service_contact_name', phone: 'service_contact_phone', email: 'service_contact_email', role: 'service_contact' },
  { name: 'service_contact2_name', phone: 'service_contact2_phone', email: 'service_contact2_email', role: 'service_contact_2' },
  { name: 'service_contact3_name', phone: 'service_contact3_phone', email: 'service_contact3_email', role: 'service_contact_3' },
];

const SERVICE_CONTACT_COLUMNS = SERVICE_CONTACT_SLOTS.flatMap((slot) => [slot.name, slot.phone, slot.email]);

// Raw cleaned slot values (no primary fallback) for the fan-out helpers.
function getServiceContactSlots(customer) {
  if (!customer) return [];
  return SERVICE_CONTACT_SLOTS.map((slot) => ({
    name: clean(customer[slot.name]),
    phone: clean(customer[slot.phone]),
    email: clean(customer[slot.email]),
    role: slot.role,
  }));
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
  const primary = getPrimaryContact(customer);
  const contacts = [];

  for (const slot of getServiceContactSlots(customer)) {
    const distinct = !!slot.phone
      && !samePhone(slot.phone, primary.phone)
      && !contacts.some(c => samePhone(c.phone, slot.phone));
    if (!distinct) continue;
    contacts.push({
      phone: slot.phone,
      email: slot.email || primary.email,
      name: slot.name || primary.name,
      role: slot.role,
    });
  }

  const notifyPrimary = !contacts.length || prefs.appointment_notify_primary === true;
  if (notifyPrimary && primary.phone && !contacts.some(c => samePhone(c.phone, primary.phone))) {
    contacts.push({ ...primary, role: 'primary' });
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
  const primary = getPrimaryContact(customer);
  const recipients = [];

  for (const slot of getServiceContactSlots(customer)) {
    const distinct = !!slot.email && !sameEmail(slot.email, primary.email);
    if (!distinct) continue;
    recipients.push({
      phone: slot.phone || primary.phone,
      email: slot.email,
      name: slot.name || primary.name,
      role: slot.role,
    });
  }

  const notifyPrimary = !recipients.length || prefs.service_report_notify_primary === true;
  return uniqueByEmail([
    ...recipients,
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

// True if this customer has a distinct service contact configured (any slot).
// Used by audit tools + the admin UI to surface a "Service contact: …" chip.
function hasDistinctServiceContact(customer) {
  if (!customer) return false;
  return getServiceContactSlots(customer).some((slot) => slot.phone || slot.email);
}

// True for any service-contact role variant (service_contact,
// service_contact_2, service_contact_3) — senders use this to pick the
// `service_contact_authorized` identity trust level.
function isServiceContactRole(role) {
  return String(role || '').startsWith('service_contact');
}

module.exports = {
  SERVICE_CONTACT_COLUMNS,
  firstNameFrom,
  getPrimaryContact,
  getServiceContact,
  getServiceContactSlots,
  isServiceContactRole,
  getBillingContact,
  getAppointmentContacts,
  getInvoiceEmailRecipients,
  getReceiptEmailRecipients,
  getServiceReportEmailRecipients,
  getRecipientsForPurpose,
  hasDistinctServiceContact,
};
