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

// Sentinel for "we could not READ the preferences", as distinct from "there is
// no preference row". Callers wrap their notification_prefs lookup in
// `.catch(() => PREFS_UNAVAILABLE)`; the notify-primary resolvers then fail
// CLOSED rather than treating an unreadable row as the default.
//
// Why this matters (codex #2992 P1): under the old opt-IN default a failed
// lookup produced `{}` and excluded the account holder, so an error could only
// drop a message. Under opt-OUT semantics the same `{}` would ADD the holder —
// silently overriding a stored `false` and texting someone who opted out. For
// every other field the sentinel behaves exactly like the `{}` these callers
// already passed (all reads undefined), so nothing else changes behavior.
const PREFS_UNAVAILABLE = Object.freeze({ __prefsUnavailable: true });

function prefsUnavailable(prefs) {
  return prefs === PREFS_UNAVAILABLE || prefs?.__prefsUnavailable === true;
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
// `role` is the SLOT's label (drives sender semantics); `roleCol` is the
// column holding the PERSON's relationship to the service (home_buyer,
// tenant, ...) as extracted from the call — recorded for role-aware
// recipient selection later, no current sender reads it.
const SERVICE_CONTACT_SLOTS = [
  { name: 'service_contact_name', phone: 'service_contact_phone', email: 'service_contact_email', role: 'service_contact', roleCol: 'service_contact_role' },
  { name: 'service_contact2_name', phone: 'service_contact2_phone', email: 'service_contact2_email', role: 'service_contact_2', roleCol: 'service_contact2_role' },
  { name: 'service_contact3_name', phone: 'service_contact3_phone', email: 'service_contact3_email', role: 'service_contact_3', roleCol: 'service_contact3_role' },
];

const SERVICE_CONTACT_COLUMNS = SERVICE_CONTACT_SLOTS.flatMap((slot) => [slot.name, slot.phone, slot.email, slot.roleCol]);

// Raw cleaned slot values (no primary fallback) for the fan-out helpers.
function getServiceContactSlots(customer) {
  if (!customer) return [];
  return SERVICE_CONTACT_SLOTS.map((slot) => ({
    name: clean(customer[slot.name]),
    phone: clean(customer[slot.phone]),
    email: clean(customer[slot.email]),
    role: slot.role,
    contactRole: clean(customer[slot.roleCol]) || null,
  }));
}

// SMS to a service contact requires the row-level consent artifact
// (#2948). Shared by every phone-resolving path in this module. Kill
// switch: DISABLE_CONTACT_CONSENT_GATE=1.
function serviceContactsConsented(customer = {}) {
  return !!customer.service_contacts_consent_at
    || process.env.DISABLE_CONTACT_CONSENT_GATE === '1';
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

// SMS-channel resolver for the single review/ask recipient: the slot-1
// service contact WHEN the row carries the consent artifact, else the
// primary account holder as a coherent identity (phone AND name together —
// never the primary's phone addressed with the contact's name). Email
// callers keep getServiceContact, which stays ungated.
function getServiceContactSmsRecipient(customer) {
  if (!customer) return { phone: '', email: '', name: '', role: 'service_contact' };
  const svcPhone = clean(customer.service_contact_phone);
  if (svcPhone && !serviceContactsConsented(customer)) {
    return { ...getPrimaryContact(customer), role: 'primary' };
  }
  return getServiceContact(customer);
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

function getAppointmentContacts(customer, prefs = {}, { skipConsentGate = false } = {}) {
  if (!customer) return [];
  const primary = getPrimaryContact(customer);
  const contacts = [];

  // Consent gate (#2948 follow-up, owner-authorized 2026-07-23): service
  // contacts are texting targets, so they only fan out when the customer
  // row carries a consent artifact (portal attestation or the grandfather
  // backfill — every row with contacts has one as of 20260723000003).
  // Rows without a stamp fall back to texting the primary account holder
  // only. Kill switch: DISABLE_CONTACT_CONSENT_GATE=1 restores the old
  // ungated fanout. The artifact attests to TEXTS specifically, so the
  // email resolver passes skipConsentGate — without it, an unstamped row
  // rerouted email to the primary against appointment_notify_primary=false
  // AND double-delivered via the slot sweep (main regression 2026-07-23).
  if (skipConsentGate || serviceContactsConsented(customer)) {
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
  }

  // Opt-OUT, not opt-in: the account holder is always a legitimate recipient of
  // their own appointment info (own number, own consent validated at send time),
  // so only an EXPLICIT false removes them. Default-on because the opt-in
  // default failed silently — naming a spouse switched off the old
  // `!contacts.length` safety net and the holder stopped getting texts with no
  // signal to them or the owner (5 accounts hit this by 2026-07-24).
  //
  // That safety net is deliberately GONE rather than OR'd in (codex #2992 P1):
  // `!contacts.length || …` overrode an explicit `false`, so unchecking the
  // toggle did nothing for an account with no distinct consented contact — the
  // UI promised an opt-out the send path ignored. Under opt-out semantics the
  // net is redundant anyway: an absent preference already resolves to true.
  //
  // Safe for the legacy `false` rows only because 20260725000002 backfills them
  // BEFORE this code serves traffic — Railway runs migrations pre-deploy and a
  // failed migration blocks the deploy, so this cannot go live without it.
  const notifyPrimary = !prefsUnavailable(prefs) && prefs.appointment_notify_primary !== false;
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

  // Opt-OUT, same as getAppointmentContacts — including dropping the old
  // `!recipients.length` net so an explicit false is actually honored, and
  // failing closed when the preferences could not be read. The opt-in default
  // failed the same silent way here: adding a contact EMAIL switched the net
  // off. This path is MORE exposed than the appointment one because it is not
  // behind the consent artifact, so an unstamped row dropped the holder too
  // (3 accounts were live in that state on 2026-07-24).
  const notifyPrimary = !prefsUnavailable(prefs) && prefs.service_report_notify_primary !== false;
  // Billing-recipient copy is only meaningful when a billing_email is set —
  // without one the billing contact IS the primary, which the notify-primary
  // toggle already covers.
  const notifyBilling = prefs.service_report_notify_billing === true && !!clean(prefs.billing_email);
  return uniqueByEmail([
    ...recipients,
    notifyPrimary ? primary : null,
    notifyBilling ? getBillingContact(customer, prefs) : null,
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
  PREFS_UNAVAILABLE,
  prefsUnavailable,
  SERVICE_CONTACT_SLOTS,
  SERVICE_CONTACT_COLUMNS,
  firstNameFrom,
  getPrimaryContact,
  getServiceContact,
  getServiceContactSmsRecipient,
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
