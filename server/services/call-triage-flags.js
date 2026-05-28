const SERVICE_AREA_COUNTIES = new Set(['Manatee', 'Sarasota', 'Charlotte', 'DeSoto']);

// A reachable number, not a withheld-caller-ID placeholder. Twilio delivers
// blocked/unavailable caller ID as text ("anonymous", "unknown", "restricted",
// "unavailable") rather than a dialable E.164, so "truthy" is not enough — we
// require at least 10 digits before treating an ANI as a real callback number.
function isDialablePhone(value) {
  if (!value) return false;
  return String(value).replace(/\D/g, '').length >= 10;
}

// Normalized lookup: lowercase, " county" suffix stripped, whitespace collapsed.
const SERVICE_AREA_COUNTIES_NORMALIZED = new Set(
  [...SERVICE_AREA_COUNTIES].map((c) => normalizeCounty(c))
);

function normalizeCounty(value) {
  if (!value) return null;
  return String(value)
    .toLowerCase()
    .replace(/\s+county\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function isInServiceAreaCounty(county) {
  const normalized = normalizeCounty(county);
  return normalized !== null && SERVICE_AREA_COUNTIES_NORMALIZED.has(normalized);
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_ADDRESS_CONFIDENCE_THRESHOLD = 0.6;

function computeDeterministicTriageFlags(extraction, opts = {}) {
  if (!extraction || !extraction.meta) return [];

  const flags = [];
  const caller = extraction.caller || {};
  const property = extraction.property || {};
  const addr = property.service_address || {};
  const consent = extraction.consent || {};
  const scheduling = extraction.scheduling || {};
  const confidence = extraction.confidence || {};
  const sentiment = extraction.sentiment_and_lead || {};
  const history = extraction.customer_history || {};
  const overallThreshold = opts.confidenceThreshold || DEFAULT_CONFIDENCE_THRESHOLD;
  const addressThreshold = opts.addressConfidenceThreshold || DEFAULT_ADDRESS_CONFIDENCE_THRESHOLD;

  if (extraction.meta.is_voicemail) flags.push('voicemail');
  if (extraction.meta.is_spam) flags.push('spam_or_wrong_number');

  // Address flags. When Google Address Validation produced a decisive verdict
  // (opts.addressValidation), it is authoritative for both address validity and
  // service area — it supersedes the model's confidence guess and county string.
  // Otherwise (validation disabled, no address to check, or the API errored) we
  // fall back to the model/confidence signals.
  const av = opts.addressValidation || null;
  const avStatus = av?.status || null;
  const avDecisive = avStatus && avStatus !== 'not_attempted' && avStatus !== 'api_unavailable';

  if (avDecisive) {
    if (avStatus === 'out_of_service_area') {
      flags.push('out_of_service_area');
    } else if (avStatus === 'confirm_needed' || avStatus === 'missing_component' || avStatus === 'ambiguous') {
      flags.push('address_unverified');
    }
    // validated_accept / corrected → clean, no address flag (the whole point:
    // a corrected bad zip clears triage instead of holding the call).
  } else {
    if (!addr.street_line_1 && !addr.city && !addr.postal_code) {
      flags.push('missing_service_address');
    }
    if (typeof confidence.service_address === 'number' && confidence.service_address < addressThreshold) {
      flags.push('low_confidence_address');
    }
    if (addr.county && !isInServiceAreaCounty(addr.county)) {
      flags.push('out_of_service_area');
    }
    // Validation was attempted with a real address but the API was unreachable.
    // Don't silently auto-route an address we couldn't verify — hold for review.
    if (avStatus === 'api_unavailable') {
      flags.push('address_validation_unavailable');
    }
  }

  if (scheduling.status === 'ambiguous') {
    flags.push('ambiguous_scheduling');
  }

  if (scheduling.status === 'reschedule_requested' || scheduling.status === 'canceled') {
    flags.push('reschedule_or_cancel');
  }

  if (consent.do_not_contact_request === true) {
    flags.push('do_not_contact_requested');
  }

  // caller.phone_e164 is the SPOKEN callback number — usually null because the
  // caller doesn't re-state their number. We almost always have the Twilio ANI
  // (passed as opts.contactPhone), so only flag when there's genuinely no way to
  // reach them. The ANI must be a DIALABLE number — a withheld caller ID arrives
  // as "anonymous"/"unknown" text, which must NOT count as reachable (else we'd
  // auto-route a customer we can't call or text back). Without the ANI threaded
  // in, this fired on nearly every inbound call and sent everything to triage.
  if (!caller.phone_e164 && !isDialablePhone(opts.contactPhone)) {
    flags.push('caller_phone_missing');
  }

  if (sentiment.lead_quality === 'spam_or_solicitation' || sentiment.lead_quality === 'wrong_number') {
    if (!flags.includes('spam_or_wrong_number')) flags.push('spam_or_wrong_number');
  }

  if (sentiment.lead_quality === 'out_of_service_area') {
    if (!flags.includes('out_of_service_area')) flags.push('out_of_service_area');
  }

  if (property.hoa_common_area_service === true) {
    flags.push('hoa_common_area_requires_approval');
  }

  if (history.prior_complaint_mentioned === true) {
    flags.push('prior_complaint_unresolved');
  }

  if (typeof confidence.overall === 'number' && confidence.overall < overallThreshold) {
    flags.push('low_extraction_confidence');
  }

  if (caller.on_site_authorization === false && caller.relationship_to_property !== 'owner') {
    flags.push('caller_not_authorized');
  }

  if (property.property_type === 'commercial' || property.hoa_common_area_service === true) {
    if (!flags.includes('hoa_common_area_requires_approval')) {
      flags.push('commercial_requires_quote');
    }
  }

  return flags;
}

const SMS_ONLY_FLAGS = new Set([
  'no_sms_consent_captured',
  'sms_consent_missing',
]);

// Flags that mean "this is not a customer we should write to canonical tables."
// When any of these fire, skip customer upsert + lead creation entirely — the
// call is recorded in call_log + triage_items for audit, but does not pollute
// the customers/leads pipeline. Soft blocks (not_confirmed, ambiguous, hoa,
// caller_not_authorized, etc.) are still real prospects and DO create a
// customer/lead; they only block the appointment auto-creation.
const CANONICAL_WRITE_BLOCKING_FLAGS = new Set([
  'spam_or_wrong_number',
  'out_of_service_area',
  'do_not_contact_requested',
]);

function hasCanonicalWriteBlock(flags) {
  return (flags || []).some((f) => CANONICAL_WRITE_BLOCKING_FLAGS.has(f));
}

function mergeTriageFlags(modelFlags, deterministicFlags) {
  return [...new Set([...(modelFlags || []), ...(deterministicFlags || [])])];
}

function canAutoRoute(extraction, opts = {}) {
  if (!extraction) return { allowed: false, reason: 'no_extraction' };

  const modelFlags = extraction.triage_flags || [];
  const deterministicFlags = computeDeterministicTriageFlags(extraction, opts);
  const finalFlags = mergeTriageFlags(modelFlags, deterministicFlags);
  const appointmentBlockingFlags = finalFlags.filter(f => !SMS_ONLY_FLAGS.has(f));

  if (appointmentBlockingFlags.length > 0) {
    return { allowed: false, reason: 'triage_flags', flags: finalFlags, appointmentBlockingFlags };
  }

  const confidence = extraction.confidence || {};
  const threshold = opts.confidenceThreshold || DEFAULT_CONFIDENCE_THRESHOLD;

  if (typeof confidence.overall !== 'number' || confidence.overall < threshold) {
    return { allowed: false, reason: 'low_confidence', overall: confidence.overall };
  }

  const scheduling = extraction.scheduling || {};
  if (scheduling.status !== 'confirmed') {
    return { allowed: false, reason: 'not_confirmed', schedulingStatus: scheduling.status };
  }

  if (!scheduling.confirmed_start_at) {
    return { allowed: false, reason: 'confirmed_without_start_time', schedulingStatus: scheduling.status };
  }

  if (extraction.consent?.do_not_contact_request === true) {
    return { allowed: false, reason: 'do_not_contact' };
  }

  return { allowed: true, flags: finalFlags };
}

module.exports = {
  computeDeterministicTriageFlags,
  mergeTriageFlags,
  canAutoRoute,
  SMS_ONLY_FLAGS,
  CANONICAL_WRITE_BLOCKING_FLAGS,
  hasCanonicalWriteBlock,
  SERVICE_AREA_COUNTIES,
  normalizeCounty,
  isInServiceAreaCounty,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_ADDRESS_CONFIDENCE_THRESHOLD,
};
