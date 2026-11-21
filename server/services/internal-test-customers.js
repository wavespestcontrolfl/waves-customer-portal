// Internal / test customer names (lowercased "first last") excluded from
// business metrics so the owner's test accounts never inflate the numbers.
// Single source of truth shared by the IB dashboard tools (excludeInternal*),
// the MRR breakdown, and the MRR snapshot — so the headline tile, the live
// trend, and the stored monthly snapshots all measure the SAME population.
// Empty list ⇒ every exclusion is a no-op.
const INTERNAL_TEST_CUSTOMERS = ['adam martinez'];

// Internal / demo customer IDs suppressed from ADMIN NOTIFICATIONS (the bell)
// — not from data or metrics. The App Store review demo account generates
// real bounce alerts and junk service-request bells on every review cycle.
const INTERNAL_TEST_CUSTOMER_IDS = [
  '3274944a-f509-413c-9dee-a8b0cdb16493', // App Review demo (appreview+demo@wavespestcontrol.com)
];

function isInternalTestCustomerId(id) {
  return !!id && INTERNAL_TEST_CUSTOMER_IDS.includes(String(id));
}

// Demo-account EMAILS, for alert paths that never see a customer id (e.g. the
// blocked-operational-send alert only has the recipient address in hand).
const INTERNAL_TEST_EMAILS = ['appreview+demo@wavespestcontrol.com'];

function isInternalTestEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return !!normalized && INTERNAL_TEST_EMAILS.includes(normalized);
}

// The owner's own cell (ADAM_PHONE): every test call, text and lead from it is
// test traffic. Read from configuration only; unset = no phone check.
function ownerPhoneLast10() {
  const digits = String(process.env.ADAM_PHONE || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// True when a contact is one of the owner's own test records, so it never
// reaches an ad platform (conversions, hashed contact lists). Any one signal is
// enough: a listed customer id, a listed name, a listed email, the owner's cell,
// or a "Shakedown Test" name. Every field is optional.
function isInternalTestContact({ customerId, firstName, lastName, email, phone } = {}) {
  if (isInternalTestCustomerId(customerId)) return true;
  const fullName = [firstName, lastName].map((p) => String(p || '').trim()).filter(Boolean).join(' ')
    .replace(/\s+/g, ' ').toLowerCase();
  if (fullName && (INTERNAL_TEST_CUSTOMERS.includes(fullName) || fullName.startsWith('shakedown test'))) return true;
  if (isInternalTestEmail(email)) return true;
  const phoneDigits = String(phone || '').replace(/\D/g, '').slice(-10);
  return phoneDigits.length === 10 && phoneDigits === ownerPhoneLast10();
}

module.exports = {
  INTERNAL_TEST_CUSTOMERS,
  INTERNAL_TEST_CUSTOMER_IDS,
  INTERNAL_TEST_EMAILS,
  isInternalTestCustomerId,
  isInternalTestEmail,
  isInternalTestContact,
};
