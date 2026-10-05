// Missing-contact capture on the public estimate accept card (owner ruling
// 2026-09-27): when a customer accepts and we're missing their LAST NAME or
// EMAIL, the accept card asks for whatever's actually missing — last name
// required, email optional/skippable. Owner 2026-10-04: a missing PHONE is
// asked for too, required, on an estimate with no linked customer. This module owns the three pieces
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

// Cap by whole Unicode code points (Postgres varchar counts characters, and
// String#slice can split a surrogate pair into a corrupt half).
function capCodePoints(value, max) {
  return Array.from(String(value ?? '')).slice(0, max).join('');
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Name gaps are judged from structure, not by guessing which stored words
// are placeholders (owner ruling 2026-09-28 after codex #5102 r12: rounds
// contradicted each other — "New" is a fallback, but "New Smith" is a real
// person). Two exact exceptions remain, both artifacts THIS codebase mints:
//   - the literal 'undefined' / 'null' tokens of the old concatenation bug
//     (mirrors estimate-public.js's cleanStoredName);
//   - the 'Customer' surname the accept stamped when it had one name token.
function cleanedNameTokens(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/(?:^|\s)(?:undefined|null)(?=\s|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    // The generated 'Customer' surname suffix ("Pat Customer") is the same
    // minted artifact as the linked 'Customer' surname — not a real name.
    .filter((token, i, all) => !(i > 0 && i === all.length - 1 && token.toLowerCase() === 'customer'));
}

function nameKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// The minted artifacts again: the 'Customer' surname the accept stamped and
// the 'undefined' / 'null' concatenation tokens (codex #5102 r13).
function hasRealLastName(value) {
  const key = nameKey(value);
  return !!key && !['customer', 'undefined', 'null'].includes(key);
}

function hasRealFirstName(value) {
  return !!nameKey(value);
}

function hasEmail(value) {
  return !!(collapseWhitespace(value || '') || '');
}

// gaps.lastName: the estimate name has fewer than 2 tokens (or is exactly
// the linked profile's multi-word first name, "Mary Ann") AND the linked
// profile (if any) has no real surname.
// gaps.firstName: no name at all on the estimate — or the estimate name is
// exactly the linked profile's surname while its first name is blank — AND
// the linked profile has no first name.
// gaps.email: neither the estimate nor the linked profile has an email.
// `linkedCustomer` is the row at estimate.customer_id (null when unlinked);
// its values are read here and never returned — booleans only.
function computeContactGaps({ estimate = {}, linkedCustomer = null } = {}) {
  const tokens = cleanedNameTokens(estimate.customer_name);
  const estimateKey = nameKey(tokens.join(' '));
  const linkedFirst = linkedCustomer?.first_name;
  const linkedLast = linkedCustomer?.last_name;
  const nameIsLinkedFirstName = tokens.length > 1
    && hasRealFirstName(linkedFirst) && estimateKey === nameKey(linkedFirst);
  const nameIsLinkedLastName = tokens.length > 0
    && !hasRealFirstName(linkedFirst) && hasRealLastName(linkedLast) && estimateKey === nameKey(linkedLast);
  const lastName = (tokens.length < 2 || nameIsLinkedFirstName) && !hasRealLastName(linkedLast);
  const firstName = (tokens.length === 0 || nameIsLinkedLastName) && !hasRealFirstName(linkedFirst);
  const email = !hasEmail(estimate.customer_email) && !hasEmail(linkedCustomer?.email);
  // gaps.phone (owner 2026-10-04): the estimate has no phone AND no linked
  // customer. customers.phone is NOT NULL, so a linked profile always has
  // one; an unlinked estimate with no phone cannot become a customer, and
  // the accept refuses it (CUSTOMER_CONTACT_REQUIRED) unless the page
  // collects one.
  const phone = !estimate.customer_id && !linkedCustomer && !hasPhone(estimate.customer_phone);
  return { firstName, lastName, email, phone };
}

function hasPhone(value) {
  return String(value ?? '').replace(/\D/g, '').length >= 10;
}

// Returns { value, error } like the other sanitizers. value is E.164
// (+1XXXXXXXXXX) for a 10-digit US number (an 11-digit one with a leading 1
// is accepted), null when nothing was typed. Anything else that was typed is
// an error: a phone is the record's contact key, so a near-miss is refused,
// never stored. NANP: the area code and the exchange start with 2-9.
function sanitizeContactPhone(raw) {
  if (typeof raw !== 'string') return { value: null, error: null };
  const collapsed = collapseWhitespace(raw) || '';
  if (!collapsed) return { value: null, error: null };
  const invalid = { value: null, error: { code: 'CONTACT_PHONE_INVALID', message: 'Please enter a valid 10-digit mobile number.' } };
  if (CONTROL_CHARS_RE.test(collapsed) || collapsed.length > 32 || !/^[+\d\s().-]+$/.test(collapsed)) return invalid;
  let digits = collapsed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return invalid;
  return { value: `+1${digits}`, error: null };
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
  if (CONTROL_CHARS_RE.test(collapsed) || LONE_SURROGATE_RE.test(collapsed)) {
    return { value: null, error: { code, message: `Please enter a valid ${label}.` } };
  }
  const normalized = String(normalizeContactName(collapsed) || collapsed);
  return { value: capCodePoints(normalized, CONTACT_LAST_NAME_MAX), error: null };
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
  if (!hasRealFirstName(row?.first_name)) return false;
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

// The LINKED profile (estimate.customer_id — the office tied this estimate
// to it) with a blank first name takes the first name the page collected, through the same name fan-out an operator edit
// runs, so onboarding and later sends stop greeting "Hi New". There is no
// real first name to prove identity against, so this is never applied to a
// phone-matched or sibling profile — only the explicit link (codex #5102 r10).
async function fillLinkedCustomerFirstName(trx, customerId, firstName) {
  if (!customerId || !firstName) return { applied: false, reason: null };
  const row = await trx('customers').where({ id: customerId }).forUpdate().first('id', 'first_name', 'last_name');
  if (!row || hasRealFirstName(row.first_name)) return { applied: false, reason: 'first name already on file' };
  await trx('customers').where({ id: customerId }).update({ first_name: firstName, updated_at: new Date() });
  await require('./customer-contact-fanout').propagateCustomerNameChange({
    before: row,
    after: { ...row, first_name: firstName },
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

// Provenance of a phone the customer typed on the accept card: the typed
// number is stored beside the phone, in estimates.customer_phone_typed, by
// the same UPDATE (migration 20261004230000). The one phone matcher every
// card and accept route uses (estimate-public matchAcceptCustomerByPhone)
// reads it here: a typed phone must never resolve to an existing customer,
// not at the save and not later, when a customer with that number may have
// appeared. It is a column, not a key in estimate_data, because public
// routes rewrite that whole blob from a pre-read snapshot and would erase it.
// The mark holds only while the estimate still carries the typed number: a
// phone the office later puts on the estimate is the office's, and is
// trusted as before.
// `estimate` is a full row, or an identity snapshot that copied the column.
function last10(value) {
  return String(value ?? '').replace(/\D/g, '').slice(-10);
}
function phoneTypedByCustomer(estimate) {
  if (!estimate || !hasPhone(estimate.customer_phone)) return false;
  return hasPhone(estimate.customer_phone_typed)
    && last10(estimate.customer_phone_typed) === last10(estimate.customer_phone);
}

// No automated text goes to a typed phone before the estimate is accepted.
// The customer gave the number on the accept card for appointment reminders
// and service-day contact; an abandoned page is not consent to sales
// follow-up texts, and the capture is not the estimate's created_at consent.
// Email follow-up is unaffected. After the accept the number is the
// customer's own record and texts as any customer phone does.
function typedPhoneBlocksPreAcceptSms(estimate) {
  return phoneTypedByCustomer(estimate) && estimate.status !== 'accepted';
}

const CALL_OFFICE_REFUSAL = {
  error: 'We could not complete this booking online — please call the Waves office and we’ll finish setting up your service right away.',
  code: 'CUSTOMER_CONTACT_REQUIRED',
};

// The accept-card phone capture behind PUT /api/estimates/:token/contact-phone
// (the route owns the token, viewability and gate checks; see its comment for
// why this is a write of its own). Returns { status, body }; never throws for
// a business outcome.
//   - estimate already linked or already has a phone → 200 { saved:false,
//     alreadyOnFile:true }, nothing validated, nothing written;
//   - nothing usable typed / malformed → 400 CONTACT_PHONE_INVALID;
//   - the number belongs to ANY customer on file → nothing written,
//     onExistingCustomerPhone runs (the office bell), 409 "call the office";
//   - otherwise ONE guarded update saves it with its provenance
//     (customer_phone_typed) and advances updated_at, so a concurrent
//     whole-row writer's compare-and-swap loses instead of overwriting it.
//     The guard: still unlinked, still phone-less, plus the caller's
//     `guardUpdate(queryBuilder)` — the route's own accept-eligibility
//     predicates, so a decline, an archive, an expiry or an off-surface
//     marker that lands after the pre-read refuses the write. Zero rows →
//     { zeroRows: true }; the route re-reads to tell "gap already closed"
//     from "no longer eligible". A customer who acquires the number AFTER
//     this point is handled by the provenance, not here: the matcher parks
//     the accept for the office instead of reusing that customer.
async function saveAcceptContactPhone({ estimate, rawPhone, database, countCustomersWithPhone, onExistingCustomerPhone, guardUpdate = null }) {
  if (estimate.customer_id || hasPhone(estimate.customer_phone)) {
    return { status: 200, body: { saved: false, alreadyOnFile: true } };
  }
  const { value: typedPhone, error } = sanitizeContactPhone(rawPhone);
  if (error || !typedPhone) {
    return { status: 400, body: { error: 'Please enter a valid 10-digit mobile number.', code: 'CONTACT_PHONE_INVALID' } };
  }
  // The one predicate both outcomes are decided under: this estimate is STILL
  // unlinked, phone-less and (the caller's guard) accept-eligible.
  const stillOpen = () => database('estimates').where({ id: estimate.id }).whereNull('customer_id')
    .whereRaw("length(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g')) < 10")
    .modify((qb) => { if (guardUpdate) guardUpdate(qb); });
  const candidateCount = await countCustomersWithPhone(typedPhone);
  if (candidateCount > 0) {
    // Revalidated before the refusal: an accept, a decline, an archive or
    // another phone save that committed during the lookup must get the
    // zero-row answer, never a bell and a 409 that says the number is a
    // customer's for an estimate that is no longer open.
    if (!(await stillOpen().first('id'))) {
      return { status: 200, body: { saved: false, alreadyOnFile: true }, zeroRows: true };
    }
    if (onExistingCustomerPhone) await onExistingCustomerPhone({ typedPhone, candidateCount });
    return { status: 409, body: { ...CALL_OFFICE_REFUSAL } };
  }
  const saved = await stillOpen()
    .update({
      customer_phone: typedPhone,
      customer_phone_typed: typedPhone,
      updated_at: database.fn.now(),
    });
  return saved
    ? { status: 200, body: { saved: true } }
    : { status: 200, body: { saved: false, alreadyOnFile: true }, zeroRows: true };
}

module.exports = {
  saveAcceptContactPhone,
  phoneTypedByCustomer,
  typedPhoneBlocksPreAcceptSms,
  IDENTITY_MISMATCH,
  capCodePoints,
  hasRealLastName,
  fillLinkedCustomerFirstName,
  hasRealFirstName,
  sanitizeContactFirstName,
  hasEmail,
  cleanedNameTokens,
  CONTACT_LAST_NAME_MAX,
  CONTACT_EMAIL_MAX,
  computeContactGaps,
  sanitizeContactLastName,
  sanitizeContactEmail,
  sanitizeContactPhone,
  hasPhone,
  fillExistingCustomerLastName,
  fillExistingCustomerEmail,
};
