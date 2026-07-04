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
  mapServiceCategoryToLegacy,
  mapLeadQualityToLegacy,
};
