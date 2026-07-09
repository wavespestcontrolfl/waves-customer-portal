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

module.exports = {
  isV2Extraction,
  flatView,
  mapSecondaryContactsToLegacy,
  mapServiceCategoryToLegacy,
  mapLeadQualityToLegacy,
  mapAdditionalPropertiesToLegacy,
  mapSecondaryContactToLegacy,
};
