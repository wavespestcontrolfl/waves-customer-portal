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

// Match the destination columns: customers.last_name and
// customer_accounts.last_name are varchar(50); both email columns are
// varchar(150). A longer value would pass here and then fail the insert.
const CONTACT_LAST_NAME_MAX = 50;
const CONTACT_EMAIL_MAX = 150;

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// Mirrors estimate-public.js's cleanStoredName: strips the legacy
// "undefined"/"null" concatenation artifacts before counting name tokens,
// so a row poisoned by that old bug doesn't read as having a real last name.
// System fallbacks stored when no name was captured (call-derived drafts
// stamp 'Unknown caller'; accept/service-request default 'New Customer').
// Two tokens, but no real name — they must read as missing, not complete.
const PLACEHOLDER_NAMES = new Set(['unknown caller', 'new customer']);

function cleanedNameTokens(value) {
  const raw = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (PLACEHOLDER_NAMES.has(raw.toLowerCase())) return [];
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

// Guarded fills for an EXISTING customer row — self-contained (the gap
// check runs on the row-locked value with the SAME normalized predicates
// computeContactGaps uses: whitespace-only is blank, 'Customer' matches
// case-insensitively), so a field the page asked for is never silently
// dropped, and a real value is never overwritten.
async function fillExistingCustomerLastName(trx, customerId, lastName) {
  if (!customerId || !lastName) return;
  const row = await trx('customers').where({ id: customerId }).forUpdate().first('last_name');
  if (!row || hasRealLastName(row.last_name)) return;
  await trx('customers').where({ id: customerId }).update({ last_name: lastName });
}

// Email goes through the shared email-claim guard (customer row lock, then
// the 'customer-email:' advisory lock, then the undone-merge holder
// recheck) in a savepoint — the same serialization every other automated
// blank-email backfill takes, so a racing merge undo cannot leave this
// customer holding an address it just restored to the merged-away row.
async function fillExistingCustomerEmail(trx, customerId, email) {
  if (!customerId || !email) return null;
  const { backfillCustomerEmailInTrx } = require('./customer-email-fanout');
  return backfillCustomerEmailInTrx(trx, { customerId, email, source: 'estimate-accept-contact' });
}

module.exports = {
  hasEmail,
  cleanedNameTokens,
  CONTACT_LAST_NAME_MAX,
  CONTACT_EMAIL_MAX,
  computeContactGaps,
  sanitizeContactLastName,
  sanitizeContactEmail,
  fillExistingCustomerLastName,
  fillExistingCustomerEmail,
};
