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
const { EMAIL_RE, normalizeContactName } = require('../utils/intake-normalize');

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
    .filter(Boolean)
    // A trailing 'Customer' is the accept placeholder surname appended to a
    // single real name ("Pat Customer") — not a surname (codex #5102 r4 P2).
    .filter((token, i, all) => !(i > 0 && i === all.length - 1 && token.toLowerCase() === 'customer'));
}

// The 'Customer' placeholder is what splitName/estimate-accept stamp when
// the estimate carried only one name token — never a real surname, so it
// must count as a gap, not a filled field.
function hasRealLastName(value) {
  const cleaned = collapseWhitespace(value || '') || '';
  // 'undefined' / 'null' are the legacy concatenation artifacts
  // cleanedNameTokens strips from the estimate name — same verdict here.
  return !!cleaned && !['customer', 'undefined', 'null'].includes(cleaned.toLowerCase());
}

// A usable first name on the linked profile: present and not one of the
// system placeholders the accept/intake paths mint ('New', 'Unknown',
// 'Customer').
function hasRealFirstName(value) {
  const cleaned = collapseWhitespace(value || '') || '';
  return !!cleaned && !['new', 'unknown', 'customer'].includes(cleaned.toLowerCase());
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
// gaps.firstName: no usable first name anywhere (the estimate carries only
// a placeholder like 'Unknown caller', or nothing) — asked only then, so the
// accept never mints a placeholder first name (codex #5102 r6).
function computeContactGaps({ estimate = {}, linkedCustomer = null } = {}) {
  const tokens = cleanedNameTokens(estimate.customer_name);
  const lastName = tokens.length < 2
    && !hasRealLastName(linkedCustomer?.last_name);
  const firstName = tokens.length === 0 && !hasRealFirstName(linkedCustomer?.first_name);
  const email = !hasEmail(estimate.customer_email) && !hasEmail(linkedCustomer?.email);
  return { firstName, lastName, email };
}

// Returns { value, error }. value is null when nothing usable was supplied
// (absent, non-string, or blank after trim) — the caller decides whether
// that's fine (both fields are server-optional; the client enforces last
// name as required). error is only ever set for a genuinely malformed
// non-empty value, never for "nothing typed".
// Names go through the repo-wide contact normalizer (properCase) BEFORE the
// length cap, so the estimate, the proposal, the customer row and every
// fan-out copy carry one spelling (codex #5102 r6).
function sanitizeContactNamePart(raw, code, label) {
  if (typeof raw !== 'string') return { value: null, error: null };
  const collapsed = collapseWhitespace(raw) || '';
  if (!collapsed) return { value: null, error: null };
  if (CONTROL_CHARS_RE.test(collapsed)) {
    return { value: null, error: { code, message: `Please enter a valid ${label}.` } };
  }
  const normalized = String(normalizeContactName(collapsed) || collapsed);
  return { value: normalized.slice(0, CONTACT_LAST_NAME_MAX), error: null };
}

function sanitizeContactLastName(raw) {
  return sanitizeContactNamePart(raw, 'CONTACT_LAST_NAME_INVALID', 'last name');
}

// customers.first_name is varchar(50), same cap as the surname.
function sanitizeContactFirstName(raw) {
  return sanitizeContactNamePart(raw, 'CONTACT_FIRST_NAME_INVALID', 'first name');
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

// Fills for an EXISTING customer row (the linked, grouped-sibling or
// phone-matched profile the accept lands on). Three rules, each the same
// mechanism an operator edit uses (codex #5102 r5):
//   - IDENTITY: only when the profile's whole first name opens the
//     estimate's own name — an estimate addressed to someone else under this account
//     (a tenant under the landlord's record) keeps its values on the
//     estimate and never renames or re-addresses the account holder.
//   - VERSION: every fill stamps customers.updated_at, the optimistic-lock
//     version operator confirmations compare against.
//   - FAN-OUT: a surname fill runs propagateCustomerNameChange in this
//     transaction, so open leads / estimates / enrollments / contracts
//     holding the old placeholder follow it.
// The gap check runs on the row-locked value with the SAME predicates
// computeContactGaps uses, so a field the page asked for is never silently
// dropped, and a real value is never overwritten.
const IDENTITY_MISMATCH = 'estimate contact is not this profile';

function firstNameKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// The profile's WHOLE first name ("Mary Ann") must open the estimate's
// cleaned name ("Mary Ann Smith") on a token boundary (codex #5102 r7).
function identityMatches(row, expectedName) {
  const name = firstNameKey(expectedName);
  const first = firstNameKey(row?.first_name);
  return !!name && !!first && (name === first || name.startsWith(`${first} `));
}

async function fillExistingCustomerLastName(trx, customerId, lastName, { expectedName } = {}) {
  if (!customerId || !lastName) return { applied: false, reason: null };
  const row = await trx('customers').where({ id: customerId }).forUpdate().first('id', 'first_name', 'last_name');
  if (!row || hasRealLastName(row.last_name)) return { applied: false, reason: 'last name already on file' };
  if (!identityMatches(row, expectedName)) return { applied: false, reason: IDENTITY_MISMATCH };
  await trx('customers').where({ id: customerId }).update({ last_name: lastName, updated_at: new Date() });
  await require('./customer-contact-fanout').propagateCustomerNameChange({
    before: row,
    after: { ...row, last_name: lastName },
  }, trx);
  return { applied: true, reason: null };
}

// Email goes through the shared email-claim guard (customer row lock, then
// the 'customer-email:' advisory lock, then the undone-merge holder
// recheck) in a savepoint — the same serialization every other automated
// blank-email backfill takes. A blank → address backfill has no old copies
// to retarget (the call-capture backfill likewise skips the email fan-out).
async function fillExistingCustomerEmail(trx, customerId, email, { expectedName } = {}) {
  if (!customerId || !email) return null;
  const row = await trx('customers').where({ id: customerId }).first('id', 'first_name');
  if (!row) return { emailApplied: false, emailDroppedReason: 'customer row gone' };
  if (!identityMatches(row, expectedName)) return { emailApplied: false, emailDroppedReason: IDENTITY_MISMATCH };
  const { backfillCustomerEmailInTrx } = require('./customer-email-fanout');
  return backfillCustomerEmailInTrx(trx, { customerId, email, source: 'estimate-accept-contact' });
}

module.exports = {
  IDENTITY_MISMATCH,
  hasRealFirstName,
  sanitizeContactFirstName,
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
