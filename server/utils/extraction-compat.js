/**
 * Compatibility adapter for v1.0.0 nested extraction ↔ old flat format.
 *
 * flatView() maps nested paths to the legacy flat keys so existing helper
 * functions (resolveSchedulableCallService, validatePhoneCallAppointmentCustomer,
 * findCustomerForCallContact, etc.) work with both schema versions during
 * the transition period.
 *
 * isV2Extraction() detects the schema version via meta.schema_version.
 */

function isV2Extraction(extraction) {
  return !!(extraction && extraction.meta && extraction.meta.schema_version);
}

function flatView(extraction) {
  if (!extraction) return {};
  if (!isV2Extraction(extraction)) return extraction;

  const caller = extraction.caller || {};
  const property = extraction.property || {};
  const addr = property.service_address || {};
  const svc = extraction.service_request || {};
  const sched = extraction.scheduling || {};
  const meta = extraction.meta || {};
  const sentiment = extraction.sentiment_and_lead || {};
  const history = extraction.customer_history || {};

  return {
    first_name: caller.first_name || null,
    last_name: caller.last_name || null,
    email: caller.email || null,
    phone: caller.phone_e164 || null,

    address_line1: addr.street_line_1 || null,
    address_line2: addr.street_line_2 || null,
    city: addr.city || null,
    state: addr.state || null,
    zip: addr.postal_code || null,

    requested_service: svc.primary_service_category || null,
    matched_service: mapServiceCategoryToLegacy(svc.primary_service_category),
    specific_service_name: svc.specific_service_name || null,
    quoted_price: typeof svc.quoted_price_usd === 'number' ? svc.quoted_price_usd : null,
    quote_requested: svc.quote_requested === true,
    quote_promised: svc.quote_promised === true,
    additional_properties: mapAdditionalPropertiesToLegacy(property.additional_properties),
    secondary_contact: mapSecondaryContactToLegacy(extraction.secondary_contact),
    secondary_contacts: mapSecondaryContactsToLegacy(extraction.secondary_contacts),

    appointment_confirmed: sched.status === 'confirmed',
    preferred_date_time: sched.confirmed_start_at || null,
    follow_up_visit_mentioned: sched.follow_up_mentioned === true,
    follow_up_date_time: sched.follow_up_start_at || null,

    is_voicemail: meta.is_voicemail || false,
    is_spam: meta.is_spam || false,

    sentiment: sentiment.sentiment || null,
    lead_quality: mapLeadQualityToLegacy(sentiment.lead_quality),
    pain_points: (sentiment.objections_raised || []).join('; ') || null,
    call_summary: meta.call_summary || null,

    _v2: extraction,
  };
}

// V2 property.additional_properties entries → the legacy flat shape the
// processor's multi-property persistence expects (same keys as the V1
// extraction's additional_properties). Entries without a street are dropped —
// there is nothing to record or dedup against without one.
function mapAdditionalPropertiesToLegacy(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((p) => p && typeof p === 'object' && String(p.street_line_1 || '').trim())
    .map((p) => ({
      address_line1: p.street_line_1,
      address_line2: p.street_line_2 || null,
      city: p.city || null,
      state: p.state || null,
      zip: p.postal_code || null,
      is_rental: p.occupancy === 'rental_investment',
      property_type: p.property_type || null,
      notes: p.notes || null,
    }));
}

// V2 secondary_contact → the legacy flat shape the processor's secondary-
// contact persistence expects (same keys as the V1 extraction's
// secondary_contact). An entry with no name, phone, or email is dropped —
// there is nothing to persist or review without one.
function mapSecondaryContactToLegacy(contact) {
  if (!contact || typeof contact !== 'object') return null;
  // A V2 contact can arrive with only name_full populated ("Joseph Haught"
  // unsplit) — derive first/last from it so the name survives the flat
  // mapping instead of producing an unnamed (or dropped) contact.
  let firstName = contact.first_name || null;
  let lastName = contact.last_name || null;
  if (!firstName && !lastName && String(contact.name_full || '').trim()) {
    const parts = String(contact.name_full).trim().split(/\s+/);
    firstName = parts[0];
    lastName = parts.slice(1).join(' ') || null;
  }
  const mapped = {
    first_name: firstName,
    last_name: lastName,
    phone: contact.phone_e164 || null,
    email: contact.email || null,
    role: contact.role || 'unknown',
    wants_notifications: contact.wants_notifications === true,
    is_billing_party: contact.is_billing_party === true,
    notes: contact.notes || null,
  };
  if (!mapped.first_name && !mapped.last_name && !mapped.phone && !mapped.email) return null;
  return mapped;
}

// 1.4.0 array — every entry through the same single-contact mapper; empty
// shells drop; hard cap 3 (the slot budget).
function mapSecondaryContactsToLegacy(list) {
  if (!Array.isArray(list)) return [];
  return list.map(mapSecondaryContactToLegacy).filter(Boolean).slice(0, 3);
}

function mapServiceCategoryToLegacy(category) {
  if (!category) return null;
  const map = {
    pest_general: 'General Pest Control',
    termite: 'Termite Inspection',
    rodent: 'Rodent Control',
    mosquito: 'Mosquito Control',
    stinging_insect: null,
    lawn_care: 'Lawn Care',
    palm_injection: 'Tree & Shrub Care',
    bed_bug: 'Bed Bug Treatment',
    wdo: 'WDO Inspection',
    exclusion: 'Rodent Control',
    inspection_only: null,
    bundled_waveguard: 'General Pest Control',
    other: null,
  };
  return map[category] || null;
}

function mapLeadQualityToLegacy(quality) {
  if (!quality) return null;
  const map = {
    hot: 'hot',
    warm: 'warm',
    cold: 'cold',
    tire_kicker: 'cold',
    wrong_number: 'spam',
    spam_or_solicitation: 'spam',
    out_of_service_area: 'cold',
  };
  return map[quality] || null;
}

// The V1 extractor's parse-failure stub summary. Exported so the processor's
// stub and the adoption layer's replace-the-sentinel rule can never drift.
const EXTRACTION_INVALID_JSON_SUMMARY = 'AI extraction returned invalid JSON';

// V2 sentiment enum is a superset of the legacy one; downstream readers
// (call_log.sentiment, lead activity metadata) only know the legacy values.
const LEGACY_SENTIMENTS = new Set(['positive', 'neutral', 'negative', 'frustrated']);
function mapSentimentToLegacy(sentiment) {
  if (!sentiment) return null;
  if (LEGACY_SENTIMENTS.has(sentiment)) return sentiment;
  const map = { angry: 'frustrated', urgent_distress: 'frustrated', confused: 'neutral' };
  return map[sentiment] || null;
}

// V2 call_nature → the legacy call_type enum (new_inquiry / existing_customer_* /
// complaint / billing / spam / wrong_number / voicemail / other). Vendor pitches
// and robocalls fold into legacy 'spam' exactly as the V1 prompt defines it.
function mapCallNatureToLegacy(nature) {
  if (!nature) return null;
  const map = {
    new_lead: 'new_inquiry',
    existing_customer_service: 'existing_customer_service',
    existing_customer_scheduling: 'existing_customer_scheduling',
    billing_question: 'billing',
    vendor_or_partner: 'spam',
    job_applicant: 'other',
    spam_solicitation: 'spam',
    robocall: 'spam',
    wrong_number: 'wrong_number',
    voicemail_message: 'voicemail',
    silent_or_noise: 'voicemail',
    other: 'other',
  };
  return map[nature] || null;
}

// ── V2-PRIMARY adoption (owner promotion 2026-07-23) ──
// When the V2 extraction is VALID, its values drive the pipeline's canonical
// writes (customer / lead / scheduling inputs) instead of only gating them.
// Before this, a V1 parse failure produced a null-name stub and the whole
// downstream chain (customer → lead → appointment → confirmation SMS)
// silently no-oped even when V2 had captured everything (2026-07-23 incident:
// a booked 8 AM recurring-service call produced no record at all).
//
// The merged object keeps the legacy FLAT shape — legacy keys only, the
// nested V2 object never leaks into canonical ai_extraction (shadow-mode
// reader contract). `etWallClock` is injected by the processor
// (v2IsoToEtWallClock) so this module stays dependency-free.
//
// Adoption tiers, deliberately asymmetric:
//   • v2-wins — service address, scheduling verdict (+ demotion of a V1
//     'confirmed' the V2 leg affirmatively rejects), quoted price. The
//     enforce gate already treats V2 as authoritative for these.
//   • identity — V2 fills an empty V1 name; on a CONFLICT the V2 name wins
//     only at caller.name_confidence ≥ 0.9 (the V2 prompt decodes
//     spelled-out names; below that, V1 wins unmerged — same anti-chimera
//     rule as resolveCallSecondaryContact).
//   • OR flags — is_spam / is_voicemail / quote flags: a true from either
//     leg wins; a V2 false never un-flags V1 (fail-safe direction).
//   • fill-gap — narrative + contact channels (summary, sentiment, lead
//     quality, service labels, call_type/is_lead, email, spoken phone): V1
//     keeps its value when present. email only fills the gap so the
//     dictation/arbiter/ownership lanes downstream keep final say; phone
//     adopts only a SPOKEN callback number, never a caller-ID echo.
//     matched_service is fill-gap ON PURPOSE — the deterministic
//     recurring-intent backstop (owner rule) already ran on the V1 value,
//     and the enforce path re-adopts + re-asserts it for approved bookings.
function adoptV2PrimaryFields(extracted = {}, v2Extraction = null, { etWallClock } = {}) {
  const adoptedFields = [];
  if (!isV2Extraction(v2Extraction)) return { merged: extracted, adoptedFields };

  const flat = flatView(v2Extraction);
  const merged = { ...extracted };
  const caller = v2Extraction.caller || {};
  const sched = v2Extraction.scheduling || {};
  const toWallClock = typeof etWallClock === 'function'
    ? etWallClock
    : (v) => {
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:[+-]\d{2}:?\d{2})?$/.exec(String(v || '').trim());
      return m ? m[1] : null;
    };

  const has = (v) => !(v === null || v === undefined || (typeof v === 'string' && !v.trim()));
  // A V1 parse-failure stub carries the sentinel summary AND a fabricated
  // 'cold' lead_quality — both are placeholders, not judgments, so the stub's
  // lead_quality is treated as absent for the fill-gap tier below.
  const v1IsStub = merged.call_summary === EXTRACTION_INVALID_JSON_SUMMARY;
  const adopt = (key, value) => {
    if (merged[key] !== value) adoptedFields.push(key);
    merged[key] = value;
  };
  const winner = (key, v2Value) => { if (has(v2Value) && merged[key] !== v2Value) adopt(key, v2Value); };
  const filler = (key, v2Value) => { if (!has(merged[key]) && has(v2Value)) adopt(key, v2Value); };

  // Identity — fill-gap, or v2-wins on conflict only at high name confidence.
  const v1HasName = has(merged.first_name) || has(merged.last_name);
  const v2HasName = has(flat.first_name) || has(flat.last_name);
  const nameConfident = typeof caller.name_confidence === 'number' && caller.name_confidence >= 0.9;
  if (v2HasName && (!v1HasName || nameConfident)) {
    winner('first_name', flat.first_name);
    winner('last_name', flat.last_name);
  }

  // Service address — v2-wins (the AV / enforce lanes downstream validate and
  // may further normalize exactly these fields).
  winner('address_line1', flat.address_line1);
  winner('address_line2', flat.address_line2);
  winner('city', flat.city);
  winner('state', flat.state);
  winner('zip', flat.zip);

  // Scheduling verdict — v2-wins in BOTH directions. Only a confirmed status
  // WITH a parseable ET wall clock books; an affirmative non-confirmed V2
  // status (none/requested/offered/canceled/reschedule_requested) demotes a
  // V1 'confirmed' so a reschedule or a vague ask can't auto-book. An
  // 'ambiguous' status leaves the V1 verdict alone.
  if (sched.status === 'confirmed') {
    const wallClock = toWallClock(sched.confirmed_start_at);
    if (wallClock) {
      if (merged.appointment_confirmed !== true) adopt('appointment_confirmed', true);
      if (merged.preferred_date_time !== wallClock) adopt('preferred_date_time', wallClock);
    }
  } else if (has(sched.status) && sched.status !== 'ambiguous' && merged.appointment_confirmed === true) {
    adopt('appointment_confirmed', false);
    if (merged.preferred_date_time !== null) adopt('preferred_date_time', null);
  }
  if (flat.follow_up_visit_mentioned === true && merged.follow_up_visit_mentioned !== true) {
    adopt('follow_up_visit_mentioned', true);
    const followUp = toWallClock(flat.follow_up_date_time);
    if (followUp && merged.follow_up_date_time !== followUp) adopt('follow_up_date_time', followUp);
  }

  winner('quoted_price', typeof flat.quoted_price === 'number' ? flat.quoted_price : null);

  // OR flags — true from either leg wins.
  if (flat.is_spam === true && merged.is_spam !== true) adopt('is_spam', true);
  if (flat.is_voicemail === true && merged.is_voicemail !== true) adopt('is_voicemail', true);
  if (flat.quote_requested === true && merged.quote_requested !== true) adopt('quote_requested', true);
  if (flat.quote_promised === true && merged.quote_promised !== true) adopt('quote_promised', true);

  // Fill-gap tier.
  filler('email', caller.email);
  if (caller.phone_source === 'spoken' || caller.phone_source === 'both') {
    filler('phone', caller.phone_e164);
  }
  filler('matched_service', flat.specific_service_name || flat.matched_service);
  filler('requested_service', flat.specific_service_name || flat.matched_service);
  filler('specific_service_name', flat.specific_service_name);
  if ((!has(merged.call_summary) || merged.call_summary === EXTRACTION_INVALID_JSON_SUMMARY) && has(flat.call_summary)) {
    adopt('call_summary', flat.call_summary);
  }
  filler('sentiment', mapSentimentToLegacy((v2Extraction.sentiment_and_lead || {}).sentiment));
  if ((v1IsStub || !has(merged.lead_quality)) && has(flat.lead_quality) && merged.lead_quality !== flat.lead_quality) {
    adopt('lead_quality', flat.lead_quality);
  }
  filler('pain_points', flat.pain_points);
  filler('call_type', mapCallNatureToLegacy(v2Extraction.call_nature));
  if ((merged.is_lead === null || merged.is_lead === undefined) && has(v2Extraction.call_nature)) {
    adopt('is_lead', v2Extraction.call_nature === 'new_lead');
  }

  return { merged, adoptedFields };
}

module.exports = {
  isV2Extraction,
  flatView,
  mapSecondaryContactsToLegacy,
  mapServiceCategoryToLegacy,
  mapLeadQualityToLegacy,
  mapAdditionalPropertiesToLegacy,
  mapSecondaryContactToLegacy,
  mapSentimentToLegacy,
  mapCallNatureToLegacy,
  adoptV2PrimaryFields,
  EXTRACTION_INVALID_JSON_SUMMARY,
};
