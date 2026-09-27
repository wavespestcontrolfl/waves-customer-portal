// Missing-contact capture on the public estimate accept card (owner ruling
// 2026-09-27): when a customer accepts and we're missing their LAST NAME or
// EMAIL, the accept card asks for whatever's actually missing — last name
// required, email optional/skippable. This module owns the three pieces
// shared between the /:token/data payload (contactGaps) and the accept
// route (sanitize + apply): gap detection, input sanitization/validation,
// and the guarded "fill an existing customer's blank field" writes.
//
// contactGaps is BOOLEANS ONLY — the linked customer's actual name/email
// must never leave the server through this payload.
const { collapseWhitespace } = require('../utils/contact-normalize');
const { EMAIL_RE } = require('../utils/intake-normalize');

const CONTACT_LAST_NAME_MAX = 80;
const CONTACT_EMAIL_MAX = 254;

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// Mirrors estimate-public.js's cleanStoredName: strips the legacy
// "undefined"/"null" concatenation artifacts before counting name tokens,
// so a row poisoned by that old bug doesn't read as having a real last name.
function cleanedNameTokens(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/(?:^|\s)(?:undefined|null)(?=\s|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// The 'Customer' placeholder is what splitName/estimate-accept stamp when
// the estimate carried only one name token — never a real surname, so it
// must count as a gap, not a filled field.
function hasRealLastName(value) {
  const cleaned = collapseWhitespace(value || '') || '';
  return !!cleaned && cleaned.toLowerCase() !== 'customer';
}

function hasEmail(value) {
  return !!(collapseWhitespace(value || '') || '');
}

// gaps.lastName: the estimate's own customer_name has fewer than 2 tokens
// AND (no linked customer, or the linked customer has no real last name).
// gaps.email: the estimate carries no customer_email AND (no linked
// customer, or the linked customer has no email on file).
// `linkedCustomer` is the row at estimate.customer_id (or null/undefined
// when unlinked) — only its last_name/email are read, and never returned.
function computeContactGaps({ estimate = {}, linkedCustomer = null } = {}) {
  const lastName = cleanedNameTokens(estimate.customer_name).length < 2
    && !hasRealLastName(linkedCustomer?.last_name);
  const email = !hasEmail(estimate.customer_email) && !hasEmail(linkedCustomer?.email);
  return { lastName, email };
}

// Returns { value, error }. value is null when nothing usable was supplied
// (absent, non-string, or blank after trim) — the caller decides whether
// that's fine (both fields are server-optional; the client enforces last
// name as required). error is only ever set for a genuinely malformed
// non-empty value, never for "nothing typed".
function sanitizeContactLastName(raw) {
  if (typeof raw !== 'string') return { value: null, error: null };
  const collapsed = collapseWhitespace(raw) || '';
  if (!collapsed) return { value: null, error: null };
  if (CONTROL_CHARS_RE.test(collapsed)) {
    return { value: null, error: { code: 'CONTACT_LAST_NAME_INVALID', message: 'Please enter a valid last name.' } };
  }
  return { value: collapsed.slice(0, CONTACT_LAST_NAME_MAX), error: null };
}

function sanitizeContactEmail(raw) {
  if (typeof raw !== 'string') return { value: null, error: null };
  const collapsed = collapseWhitespace(raw) || '';
  if (!collapsed) return { value: null, error: null };
  if (CONTROL_CHARS_RE.test(collapsed) || collapsed.length > CONTACT_EMAIL_MAX) {
    return { value: null, error: { code: 'CONTACT_EMAIL_INVALID', message: 'Please enter a valid email address.' } };
  }
  const normalized = collapsed.toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return { value: null, error: { code: 'CONTACT_EMAIL_INVALID', message: 'Please enter a valid email address.' } };
  }
  return { value: normalized, error: null };
}

// Guarded fills for an EXISTING customer row — self-contained (the WHERE
// clause is the gap check), so these are safe to call whenever a sanitized
// value exists, whether or not the caller already computed contactGaps.
// Never overwrites a real value.
async function fillExistingCustomerLastName(trx, customerId, lastName) {
  if (!customerId || !lastName) return;
  await trx('customers').where({ id: customerId })
    .where((q) => q.whereNull('last_name').orWhere('last_name', '').orWhere('last_name', 'Customer'))
    .update({ last_name: lastName });
}

async function fillExistingCustomerEmail(trx, customerId, email) {
  if (!customerId || !email) return;
  await trx('customers').where({ id: customerId })
    .where((q) => q.whereNull('email').orWhere('email', ''))
    .update({ email });
}

module.exports = {
  CONTACT_LAST_NAME_MAX,
  CONTACT_EMAIL_MAX,
  computeContactGaps,
  sanitizeContactLastName,
  sanitizeContactEmail,
  fillExistingCustomerLastName,
  fillExistingCustomerEmail,
};
