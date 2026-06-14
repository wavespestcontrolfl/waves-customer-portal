const { normalizeEmail, collapseWhitespace } = require('./contact-normalize');
const { toE164 } = require('./phone');
const { normalizeStreetLine } = require('./address-normalizer');

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

function normalizeCallState(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === 'FL' || upper === 'FLORIDA') return 'FL';
  return null;
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
    address_line1: cleanNullableText(normalizeStreetLine(source.address_line1)),
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
  };
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
};
