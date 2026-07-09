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

// Secondary contact (realtor's buyer, landlord's tenant): same component
// normalization as the caller. Collapses to null when nothing identifying
// survives, so downstream consumers never see an empty shell.
function normalizeSecondaryContact(contact) {
  if (!contact || typeof contact !== 'object') return null;
  // Same transcript-garble rejection as the V1 normalizer: a URL-shaped
  // "email" ("www.cw63@gmail.com") is a mishearing, never a mailbox — it
  // must not survive into a service-contact write when V2 is the source.
  const { looksGarbledTranscriptEmail } = require('./intake-normalize');
  const validEmail = cleanValidEmail(contact.email);
  const normalized = {
    ...contact,
    name_full: cleanText(contact.name_full),
    first_name: contact.first_name ? properCaseName(contact.first_name) : null,
    last_name: contact.last_name ? properCaseName(contact.last_name) : null,
    phone_e164: normalizePhone(contact.phone_e164),
    phone_raw_spoken: cleanText(contact.phone_raw_spoken),
    email: validEmail && !looksGarbledTranscriptEmail(validEmail) ? validEmail : null,
    notes: cleanText(contact.notes),
  };
  if (!normalized.name_full && !normalized.first_name && !normalized.last_name
      && !normalized.phone_e164 && !normalized.email) return null;
  return normalized;
}

// 1.4.0 array: each entry through the single-contact normalizer (E.164
// re-validation, garbled-email rejection); empty shells drop; cap 3.
// Non-array garbage fails safe to null (persisted schema allows null).
function normalizeSecondaryContacts(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const entry of list) {
    const normalized = normalizeSecondaryContact(entry);
    if (normalized) out.push(normalized);
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeExtractionV2(extraction) {
  if (!extraction || typeof extraction !== 'object') return extraction;

  return {
    ...extraction,
    caller: normalizeCaller(extraction.caller),
    property: normalizeProperty(extraction.property),
    ...(extraction.secondary_contact !== undefined
      ? { secondary_contact: normalizeSecondaryContact(extraction.secondary_contact) }
      : {}),
    ...(extraction.secondary_contacts !== undefined
      ? { secondary_contacts: normalizeSecondaryContacts(extraction.secondary_contacts) }
      : {}),
  };
}

module.exports = {
  normalizeExtractionV2,
  normalizeCaller,
  normalizeSecondaryContact,
  normalizeSecondaryContacts,
  normalizeAddress,
  normalizePhone,
  normalizeZip,
  normalizeState,
  cleanValidEmail,
};
