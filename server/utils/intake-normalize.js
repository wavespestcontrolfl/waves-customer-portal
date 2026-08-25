const { normalizeEmail, collapseWhitespace } = require('./contact-normalize');
const { toE164 } = require('./phone');
const { normalizeStreetLine, titleCaseWords, normalizeState, normalizeLeadAddress } = require('./address-normalizer');
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

// Strict by design — NO domain repair here. A repaired address must pass the
// call processor's ownership gate (correctedAddressOwnedByOther, fails closed)
// before it may be adopted, and that gate only sees corrections proposed by
// deriveEmailReview from the RAW value. Repairing inline would hand the
// customer/lead upserts a corrected address that could belong to a different
// customer. Invalid captures demote to email_raw below, where the (now
// missing_tld-aware) correction fires inside the gated review path.
function cleanValidEmailOrNull(value) {
  const email = cleanEmail(value);
  return EMAIL_RE.test(email) ? email : null;
}

// A syntactically-valid email whose local part reads like a URL fragment is a
// transcription artifact, not a mailbox — a caller spelling "W, C-as-in-
// Charlie, W, 63" gets transcribed as "www.cw63 at gmail.com" and the literal
// "www.cw63@gmail.com" may be a real stranger's mailbox. Transcript captures
// matching this are demoted to email_raw (below) so no write path stores them
// and no first-touch email fires. Transcript-specific by design: a TYPED
// web-form email is the user's own claim and never runs through this.
const GARBLED_TRANSCRIPT_EMAIL_RE = /^(?:www\.|https?[:.]|[^@]*\.(?:com|net|org)@)/i;
function looksGarbledTranscriptEmail(value) {
  const email = cleanEmail(value);
  return !!email && GARBLED_TRANSCRIPT_EMAIL_RE.test(email);
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

// Model-emitted quoted price: a finite positive number, or a string holding
// EXACTLY ONE numeric amount ("$350", "1,350.50"). Strings with multiple
// amounts ("50 to 60") are ranges, which the prompt requires to be null —
// naive digit-stripping would inflate them into 5060. Range plausibility
// bounds are enforced at booking time by the call-booking catalog's sanitizer.
function normalizeQuotedPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  let n;
  if (typeof value === 'number') {
    n = value;
  } else {
    const tokens = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
    if (tokens.length !== 1) return null;
    n = Number(tokens[0]);
  }
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Strict boolean for the model's quote flags: only a literal true (or "true")
// counts. Anything else — false, null, absent, junk — is false, so a garbled
// value can never keep a lead open or fire a quote-promised notification.
function normalizeStrictBoolean(value) {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

// Tri-state boolean for classification fields where "unstated" must survive
// as null (never coerced to false — a null primary-residence signal means
// "the call didn't say", not "it isn't").
function normalizeNullableBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return null;
}

// Occupancy vocabulary — pinned to the customer_properties PG enum and the
// extraction schema's occupancy enum (schema 1.9.0). Re-declared here rather
// than imported: utils must not require services.
const CALL_OCCUPANCY_TYPES = new Set([
  'owner_occupied', 'rental_investment', 'commercial', 'seasonal', 'vacant', 'unknown',
]);
function normalizeCallOccupancy(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CALL_OCCUPANCY_TYPES.has(v) ? v : null;
}

// Model-emitted additional_properties (multi-property calls): keep only entries
// with a usable street line, normalize each address component with the same
// helpers as the primary address, and cap the list — a hallucinated flood of
// entries must not fan out into customer_properties writes.
const MAX_ADDITIONAL_PROPERTIES = 5;
function normalizeAdditionalProperties(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const address_line1 = normalizeNullableStreetLine(entry.address_line1);
    if (!address_line1) continue;
    out.push({
      address_line1,
      address_line2: normalizeNullableStreetLine(entry.address_line2),
      city: cleanNullableText(entry.city),
      state: normalizeCallState(entry.state),
      zip: normalizeZip(entry.zip),
      is_rental: normalizeStrictBoolean(entry.is_rental),
      occupancy: normalizeCallOccupancy(entry.occupancy),
      is_primary_residence: normalizeNullableBoolean(entry.is_primary_residence),
      property_type: cleanNullableText(entry.property_type),
      notes: cleanNullableText(entry.notes),
    });
    if (out.length >= MAX_ADDITIONAL_PROPERTIES) break;
  }
  return out;
}

// Web quote-funnel additional properties — the visitor-typed "also cover my
// other property" boxes on the marketing-site lead/quote forms. Same stored
// contract as the call-extraction entries above: every surviving entry is
// canonicalized by the SAME normalizeAdditionalProperties so web- and
// call-captured properties can never drift apart. This wrapper owns only the
// web-side input concerns: bare-string entries, snake/camel key aliases, a
// Places place_id (additive; call entries carry null), dedupe (including
// against the primary service address), prose and unit-conflict rejection,
// per-component length bounds, and a tighter cap for the public payload.
// Capture-only: these NEVER enter the pricing pipeline — each one is
// follow-up-quoted manually as its own estimate.
const MAX_WEB_ADDITIONAL_PROPERTIES = 3;
const MAX_WEB_ADDITIONAL_PROPERTY_INPUTS = 20;
const MAX_WEB_ADDITIONAL_PROPERTY_LENGTH = 300;
function normalizeWebAdditionalProperties(body = {}, primaryFullAddress = '') {
  const rawList = [];
  const push = (value) => {
    if (value != null && value !== '' && rawList.length < MAX_WEB_ADDITIONAL_PROPERTY_INPUTS) rawList.push(value);
  };
  const listInput = body.additional_properties ?? body.additionalProperties;
  if (Array.isArray(listInput)) listInput.forEach(push);
  else push(listInput);
  push(body.second_property ?? body.secondProperty);

  const seen = new Set();
  const primaryKey = collapseWhitespace(String(primaryFullAddress || '')).toLowerCase();
  if (primaryKey) seen.add(primaryKey);

  const out = [];
  // Every accepted component is length-bounded, not just the raw string — a
  // public payload must not smuggle unbounded values into JSONB, owner SMS
  // alerts, or LLM prompts through the structured fields.
  const clip = (value) => (value == null ? value : String(value).slice(0, MAX_WEB_ADDITIONAL_PROPERTY_LENGTH));
  for (const entry of rawList) {
    let normalized = null;
    if (typeof entry === 'string') {
      normalized = normalizeLeadAddress({ raw: entry.slice(0, MAX_WEB_ADDITIONAL_PROPERTY_LENGTH) });
    } else if (typeof entry === 'object' && !Array.isArray(entry)) {
      normalized = normalizeLeadAddress({
        raw: String(entry.formatted || entry.address || '').slice(0, MAX_WEB_ADDITIONAL_PROPERTY_LENGTH),
        line1: clip(entry.line1 || entry.address_line1 || entry.addressLine1),
        line2: clip(entry.line2 || entry.address_line2 || entry.addressLine2 || entry.unit),
        city: clip(entry.city),
        state: clip(entry.state),
        zip: clip(entry.zip),
        placeId: clip(entry.place_id || entry.placeId || entry.google_place_id),
      });
    }
    // A street line needs at least a digit and a letter to be a follow-up-able
    // address — bare prose ("the one next door") is dropped, not stored. A
    // unit conflict (inline unit disagrees with the dedicated field) is
    // ambiguous — fail closed on the entry, same rule as the primary-address
    // routes, rather than store a wrong door.
    if (!normalized?.fullAddress || normalized.unitConflict || !/\d/.test(normalized.line1) || !/[A-Za-z]/.test(normalized.line1)) continue;
    const key = normalized.fullAddress.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Single-authority stored shape: run the entry through the shared
    // canonicalizer above, then attach the web-only place_id.
    const [canonical] = normalizeAdditionalProperties([{
      address_line1: normalized.line1,
      address_line2: normalized.line2 || null,
      city: normalized.city || null,
      state: normalized.state || null,
      zip: normalized.zip || null,
    }]);
    if (!canonical) continue;
    out.push({ ...canonical, place_id: normalized.placeId ? clip(normalized.placeId) : null });
    if (out.length >= MAX_WEB_ADDITIONAL_PROPERTIES) break;
  }
  return out;
}

// Model-emitted secondary_contact (a SECOND person named as a party to the
// service — a realtor's home buyer, a landlord's tenant, a spouse): normalize
// each component with the same helpers as the caller's own fields, allowlist
// the role, and drop the object entirely when nothing identifying survives —
// a hallucinated empty shell must not fan out into service-contact writes.
const SECONDARY_CONTACT_ROLES = new Set([
  'home_buyer', 'home_seller', 'tenant', 'landlord', 'lender', 'spouse_partner',
  'family_member', 'real_estate_agent', 'property_manager', 'other', 'unknown',
]);
function normalizeSecondaryContact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const validEmail = cleanValidEmailOrNull(value.email);
  const usableEmail = validEmail && !looksGarbledTranscriptEmail(validEmail) ? validEmail : null;
  const role = cleanText(value.role).toLowerCase().replace(/[\s-]+/g, '_');
  const contact = {
    first_name: cleanNullableText(value.first_name),
    last_name: cleanNullableText(value.last_name),
    phone: normalizeE164Phone(value.phone),
    email: usableEmail,
    role: SECONDARY_CONTACT_ROLES.has(role) ? role : 'unknown',
    wants_notifications: normalizeStrictBoolean(value.wants_notifications),
    is_billing_party: normalizeStrictBoolean(value.is_billing_party),
    notes: cleanNullableText(value.notes),
  };
  if (!contact.first_name && !contact.last_name && !contact.phone && !contact.email) return null;
  return contact;
}

function normalizeCallExtraction(extracted = {}, { callerPhone = null } = {}) {
  const source = extracted && typeof extracted === 'object' && !Array.isArray(extracted)
    ? extracted
    : {};
  const normalizedPhone = normalizeCallPhone(source.phone, callerPhone);
  const validEmail = cleanValidEmailOrNull(source.email);
  // Regex-valid but URL-shaped ("www.cw63@gmail.com") = transcription garble;
  // demote to email_raw with the rest of the rejects.
  const usableEmail = validEmail && !looksGarbledTranscriptEmail(validEmail) ? validEmail : null;

  return {
    ...source,
    first_name: cleanNullableText(source.first_name),
    last_name: cleanNullableText(source.last_name),
    email: usableEmail,
    // The raw model email survives normalization when the regex (or the
    // transcript-garble guard) rejects it — the call-review bridge needs it to
    // flag email_invalid (and to attempt a missing-dot domain fix) for
    // read-back on the callback; `email` stays the only value any write path
    // stores.
    email_raw: usableEmail ? null : (cleanNullableText(source.email) || null),
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
    specific_service_name: cleanNullableText(source.specific_service_name),
    quoted_price: normalizeQuotedPrice(source.quoted_price),
    follow_up_visit_mentioned: source.follow_up_visit_mentioned === true,
    follow_up_date_time: cleanNullableText(source.follow_up_date_time),
    is_lead: normalizeIsLead(source.is_lead),
    call_type: normalizeCallType(source.call_type),
    additional_properties: normalizeAdditionalProperties(source.additional_properties),
    service_address_occupancy: normalizeCallOccupancy(source.service_address_occupancy),
    service_address_is_primary_residence: normalizeNullableBoolean(source.service_address_is_primary_residence),
    quote_requested: normalizeStrictBoolean(source.quote_requested),
    quote_promised: normalizeStrictBoolean(source.quote_promised),
    secondary_contact: normalizeSecondaryContact(source.secondary_contact),
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

// Canonical whole-address normalization — the Customer-360 admin edit path's
// address shape (moved here from routes/admin-customers so non-route writers
// like the contact-correction lane share the SAME parser instead of
// normalizing fields independently): normalizeLeadAddress parses the group
// as one address (unit canonicalization "4b" → "Unit 4B", inline-unit vs
// line2 conflict detection), then each part takes the contact normalizer.
// State defaults to FL when absent — consumers correcting a partial field
// set must only adopt the keys they supplied.
function normalizeAdminAddressInput({ address, addressLine1, addressLine2, city, state, zip } = {}) {
  const { normalizeLeadAddress } = require('./address-normalizer');
  // Numeric scalars survive (codex #3413 r24): the route-local helper this
  // replaced used String(value).trim(), so admin JSON like zip: 34201
  // normalized fine — the stricter cleanText empties non-strings, which
  // would silently null a valid ZIP. Coerce numbers only; objects/arrays
  // still fail closed.
  const text = (v) => cleanText(typeof v === 'number' ? String(v) : v);
  const normalized = normalizeLeadAddress({
    line1: text(addressLine1 || address),
    line2: text(addressLine2),
    city: text(city),
    state: text(state),
    zip: text(zip),
  });
  const cleanedState = cleanText(normalized.state).toUpperCase();
  return {
    addressLine1: normalizeContactStreet(normalized.line1),
    addressLine2: normalized.line2 || null,
    city: normalizeContactCity(normalized.city),
    state: cleanedState ? cleanedState.slice(0, 2) : 'FL',
    zip: normalizeContactZip(normalized.zip),
    unitConflict: normalized.unitConflict,
  };
}

module.exports = {
  normalizeWebAdditionalProperties,
  EMAIL_RE,
  cleanText,
  cleanNullableText,
  cleanEmail,
  cleanValidEmailOrNull,
  looksGarbledTranscriptEmail,
  normalizeNanpPhone,
  normalizePhoneForStorage,
  normalizeWebsiteQuoteContact,
  normalizeCallExtraction,
  normalizeAdditionalProperties,
  normalizeSecondaryContact,
  normalizeContactRecord,
  applyContactNormalization,
  normalizeAdminAddressInput,
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
