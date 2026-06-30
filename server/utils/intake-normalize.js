const { normalizeEmail, collapseWhitespace } = require('./contact-normalize');
const { toE164 } = require('./phone');
const { normalizeStreetLine, titleCaseWords, normalizeState } = require('./address-normalizer');
const { properCase } = require('./name-case');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cleanText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return '';
  return collapseWhitespace(value);
}

function cleanNullableText(value) {
  const cleaned = cleanText(value);
  return cleaned || null;
}

function normalizeNullableStreetLine(value) {
  const cleaned = cleanNullableText(value);
  return cleaned ? cleanNullableText(normalizeStreetLine(cleaned)) : null;
}

function cleanEmail(value) {
  if (typeof value !== 'string') return '';
  const email = normalizeEmail(value);
  return email || '';
}

function cleanValidEmailOrNull(value) {
  const email = cleanEmail(value);
  return EMAIL_RE.test(email) ? email : null;
}

function normalizeNanpPhone(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

function normalizePhoneForStorage(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  return normalizeNanpPhone(raw) || raw;
}

function normalizeWebsiteQuoteContact(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const { firstName, lastName, email, phone } = source;
  const phoneRaw = cleanText(phone);
  return {
    firstName: cleanText(firstName),
    lastName: cleanText(lastName),
    email: cleanEmail(email),
    phoneRaw,
    phoneE164: normalizeNanpPhone(phoneRaw),
    phoneForStorage: normalizePhoneForStorage(phoneRaw),
  };
}

function normalizeZip(value) {
  const raw = cleanText(value);
  const match = raw.match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0].slice(0, 5) : null;
}

/**
 * Clear the cached customers.line_type when a customer's primary phone is being
 * changed to a different number. line_type is a phone-specific cache (landline /
 * mobile / voip) read by the SMS landline guard (appointment-reminders
 * isLandline); if the phone changes but the cache doesn't, a stale 'landline'
 * marker would wrongly skip SMS to the new number. Mutates `updates` in place,
 * adding `line_type: null` only when the phone actually changed.
 *
 * The phone-keyed phone_line_types cache is intentionally left alone — it is
 * keyed by the number itself, so it is never stale for this customer's edit.
 *
 * @param {Object} updates - pending update object (phone already normalized)
 * @param {Object} before  - existing customer row (needs phone + line_type)
 */
function clearLineTypeOnPhoneChange(updates, before) {
  if (!updates || updates.phone === undefined || !before || !before.line_type) return;
  // Compare last-10 digits (matches isLandline's own slice(-10)), so a 10-digit
  // legacy value and its +1 E.164 form aren't seen as a change.
  const last10 = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
  if (last10(updates.phone) !== last10(before.phone)) {
    updates.line_type = null;
  }
}

function normalizeCallState(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === 'FL' || upper === 'FLORIDA') return 'FL';
  return null;
}

// Strict tri-state for the model's is_lead flag: a real boolean, the strings
// "true"/"false", else null (absent/unparseable). null means "model didn't say"
// so the downstream content gate falls back to legacy behavior rather than
// treating a missing flag as a non-lead.
function normalizeIsLead(value) {
  if (value === true || value === false) return value;
  const raw = cleanText(value).toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

const CALL_TYPES = new Set([
  'new_inquiry',
  'existing_customer_scheduling',
  'existing_customer_service',
  'complaint',
  'billing',
  'spam',
  'wrong_number',
  'voicemail',
  'other',
]);

function normalizeCallType(value) {
  const raw = cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
  return CALL_TYPES.has(raw) ? raw : null;
}

function normalizeE164Phone(value) {
  const phoneCandidate = cleanText(value);
  if (!phoneCandidate) return null;
  const genericPhone = phoneCandidate.startsWith('+') ? toE164(phoneCandidate) : null;
  return normalizeNanpPhone(phoneCandidate) ||
    (/^\+\d{8,15}$/.test(genericPhone || '') ? genericPhone : null);
}

function normalizeCallPhone(extractedPhone, callerPhone) {
  return normalizeE164Phone(extractedPhone) || normalizeE164Phone(callerPhone);
}

function normalizeCallExtraction(extracted = {}, { callerPhone = null } = {}) {
  const source = extracted && typeof extracted === 'object' && !Array.isArray(extracted)
    ? extracted
    : {};
  const normalizedPhone = normalizeCallPhone(source.phone, callerPhone);

  return {
    ...source,
    first_name: cleanNullableText(source.first_name),
    last_name: cleanNullableText(source.last_name),
    email: cleanValidEmailOrNull(source.email),
    phone: normalizedPhone || null,
    address_line1: normalizeNullableStreetLine(source.address_line1),
    city: cleanNullableText(source.city),
    state: normalizeCallState(source.state),
    zip: normalizeZip(source.zip),
    requested_service: cleanNullableText(source.requested_service),
    preferred_date_time: cleanNullableText(source.preferred_date_time),
    sentiment: cleanNullableText(source.sentiment),
    pain_points: cleanNullableText(source.pain_points),
    call_summary: cleanNullableText(source.call_summary),
    lead_quality: cleanNullableText(source.lead_quality),
    matched_service: cleanNullableText(source.matched_service),
    is_lead: normalizeIsLead(source.is_lead),
    call_type: normalizeCallType(source.call_type),
  };
}

// --- Canonical contact-field normalization ---------------------------------
// One place that decides how a customer/lead contact field is stored, so every
// ingestion path (admin create, quick-add, Intelligence Bar, public quote, lead
// webhook, call triage, booking, estimates, proposals, SMS) produces the same
// format. Each per-field helper PRESERVES the value the call site chose when the
// input is empty/null — it only reformats real content, never coerces null<->''
// (so a path that intentionally inserts null for a column keeps inserting null).

function normalizeContactName(value) {
  const cleaned = cleanText(value);
  return cleaned ? properCase(cleaned) : value;
}

function normalizeContactEmail(value) {
  const cleaned = cleanEmail(value);
  return cleaned ? cleaned : value;
}

function normalizeContactPhone(value) {
  const cleaned = cleanText(value);
  return cleaned ? normalizePhoneForStorage(cleaned) : value;
}

function normalizeContactStreet(value) {
  const cleaned = cleanText(value);
  return cleaned ? normalizeStreetLine(cleaned) : value;
}

function normalizeContactCity(value) {
  const cleaned = cleanText(value);
  return cleaned ? titleCaseWords(cleaned) : value;
}

function normalizeContactStateField(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return value;
  return normalizeState(cleaned) || cleaned.toUpperCase().slice(0, 2);
}

function normalizeContactZip(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return value;
  return normalizeZip(cleaned) || value;
}

const CONTACT_FIELD_NORMALIZERS = {
  first_name: normalizeContactName,
  last_name: normalizeContactName,
  email: normalizeContactEmail,
  phone: normalizeContactPhone,
  address_line1: normalizeContactStreet,
  address_line2: normalizeContactStreet,
  city: normalizeContactCity,
  state: normalizeContactStateField,
  zip: normalizeContactZip,
};

// Return a NEW object holding only the recognized contact keys that were present
// in `fields`, each normalized. Keys the caller didn't supply are not invented.
function normalizeContactRecord(fields = {}) {
  const src = fields && typeof fields === 'object' ? fields : {};
  const out = {};
  for (const key of Object.keys(CONTACT_FIELD_NORMALIZERS)) {
    if (Object.prototype.hasOwnProperty.call(src, key) && src[key] !== undefined) {
      out[key] = CONTACT_FIELD_NORMALIZERS[key](src[key]);
    }
  }
  return out;
}

// Convenience for insert/update call sites: pass the full row object and get it
// back with its contact fields normalized and every other field untouched.
function applyContactNormalization(fields = {}) {
  return { ...fields, ...normalizeContactRecord(fields) };
}

module.exports = {
  EMAIL_RE,
  cleanText,
  cleanNullableText,
  cleanEmail,
  cleanValidEmailOrNull,
  normalizeNanpPhone,
  normalizePhoneForStorage,
  normalizeWebsiteQuoteContact,
  normalizeCallExtraction,
  normalizeContactRecord,
  applyContactNormalization,
  clearLineTypeOnPhoneChange,
  CONTACT_FIELD_NORMALIZERS,
  normalizeContactName,
  normalizeContactEmail,
  normalizeContactPhone,
  normalizeContactStreet,
  normalizeContactCity,
  normalizeContactStateField,
  normalizeContactZip,
};
