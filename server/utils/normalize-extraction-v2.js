const { toE164 } = require('./phone');
const { normalizeEmail, properCaseName, collapseWhitespace } = require('./contact-normalize');
const { normalizeStreetLine } = require('./address-normalizer');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const s = collapseWhitespace(String(value));
  return s || null;
}

function cleanValidEmail(value) {
  if (!value) return null;
  const normalized = normalizeEmail(value);
  return normalized && EMAIL_RE.test(normalized) ? normalized : null;
}

function normalizePhone(value) {
  if (!value) return null;
  const e164 = toE164(value);
  return e164 && /^\+\d{8,15}$/.test(e164) ? e164 : null;
}

function normalizeZip(value) {
  if (!value) return null;
  const match = String(value).match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0].slice(0, 5) : null;
}

function normalizeState(value) {
  if (!value) return null;
  const upper = String(value).trim().toUpperCase();
  if (upper === 'FL' || upper === 'FLORIDA') return 'FL';
  return null;
}

function normalizeCaller(caller) {
  if (!caller) return caller;
  return {
    ...caller,
    name_full: cleanText(caller.name_full),
    first_name: caller.first_name ? properCaseName(caller.first_name) : null,
    last_name: caller.last_name ? properCaseName(caller.last_name) : null,
    organization_name: cleanText(caller.organization_name),
    phone_e164: normalizePhone(caller.phone_e164),
    phone_raw_spoken: cleanText(caller.phone_raw_spoken),
    email: cleanValidEmail(caller.email),
  };
}

function normalizeAddress(addr) {
  if (!addr) return addr;
  return {
    ...addr,
    raw_text: cleanText(addr.raw_text),
    street_line_1: cleanText(normalizeStreetLine(addr.street_line_1)),
    street_line_2: cleanText(addr.street_line_2),
    city: addr.city ? properCaseName(addr.city) : null,
    state: normalizeState(addr.state),
    postal_code: normalizeZip(addr.postal_code),
    county: cleanText(addr.county),
    subdivision_or_community: cleanText(addr.subdivision_or_community),
  };
}

function normalizeProperty(property) {
  if (!property) return property;
  return {
    ...property,
    service_address: normalizeAddress(property.service_address),
    access_notes: cleanText(property.access_notes),
  };
}

function normalizeExtractionV2(extraction) {
  if (!extraction || typeof extraction !== 'object') return extraction;

  return {
    ...extraction,
    caller: normalizeCaller(extraction.caller),
    property: normalizeProperty(extraction.property),
  };
}

module.exports = {
  normalizeExtractionV2,
  normalizeCaller,
  normalizeAddress,
  normalizePhone,
  normalizeZip,
  normalizeState,
  cleanValidEmail,
};
