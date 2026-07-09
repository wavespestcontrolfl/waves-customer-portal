const crypto = require('crypto');

function computeAppointmentIdempotencyKey({
  callLogId,
  schedulingStatus,
  confirmedStartAt,
  primaryServiceCategory,
  addressHash,
}) {
  const parts = [
    'call-pipeline-v2',
    callLogId || 'unknown',
    schedulingStatus || 'unknown',
    confirmedStartAt || 'no-confirmed-start',
    primaryServiceCategory || 'unknown-service',
    addressHash || 'unknown-address',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 64);
}

function computeAddressHash(serviceAddress) {
  if (!serviceAddress) return null;
  const parts = [
    (serviceAddress.street_line_1 || '').toLowerCase().trim(),
    (serviceAddress.city || '').toLowerCase().trim(),
    (serviceAddress.postal_code || '').trim(),
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function checkTcpaConsent(extraction) {
  if (!extraction || !extraction.consent) {
    return { canSms: false, canEmail: true, reason: 'no_consent_data' };
  }

  const consent = extraction.consent;

  if (consent.do_not_contact_request === true) {
    return { canSms: false, canEmail: false, reason: 'do_not_contact_requested' };
  }

  if (consent.sms_consent_given === true) {
    return { canSms: true, canEmail: true, reason: 'sms_consent_given' };
  }

  return { canSms: false, canEmail: true, reason: 'sms_consent_not_given' };
}

function buildRouteDecision({
  callLogId,
  extraction,
  finalTriageFlags,
  routingResult,
  action,
  mode = 'enforce',
}) {
  const scheduling = extraction?.scheduling || {};
  const confidence = extraction?.confidence || {};

  return {
    call_log_id: callLogId,
    decision_version: 'v2-1.0.0',
    mode,
    validator_recommendation: routingResult?.allowed
      ? (scheduling.status === 'confirmed' ? 'auto_create_appointment' : 'upsert_customer_only')
      : 'needs_review',
    final_action_taken: action,
    blocked_reasons: JSON.stringify(finalTriageFlags.length > 0 ? finalTriageFlags : (routingResult?.reason ? [routingResult.reason] : [])),
    allowed_reasons: JSON.stringify(routingResult?.allowed ? ['all_gates_passed'] : []),
    ai_validation_model: extraction?.meta?.extraction_model || null,
    ai_validation_prompt_version: extraction?.meta?.extraction_prompt_version || null,
    ai_validation_schema_version: extraction?.meta?.schema_version || null,
    created_at: new Date(),
  };
}

function buildTriageItem({
  callLogId,
  flag,
  extraction,
  severity = 'blocking',
  // Flag-specific evidence merged into the payload (e.g. the as-heard vs
  // recovered street + candidate list for address flags) so the Needs Review
  // card can show WHAT to confirm, not just that something needs confirming.
  extraPayload = null,
}) {
  const flagToCategoryMap = {
    out_of_service_area: 'out_of_service_area',
    missing_service_address: 'address_review',
    low_confidence_address: 'address_review',
    address_unverified: 'address_review',
    address_validation_unavailable: 'address_review',
    ambiguous_scheduling: 'time_ambiguous',
    reschedule_or_cancel: 'time_ambiguous',
    // Gate-rejection reason strings double as flags on the Needs Review row —
    // unmapped they filed under service_unknown, so a caller who said
    // "Tuesday, first slot" was buried with billing questions instead of
    // showing up as a booking that needs a time.
    not_confirmed: 'time_ambiguous',
    confirmed_without_start_time: 'time_ambiguous',
    cancellation_request: 'time_ambiguous',
    after_hours_emergency: 'time_ambiguous',
    existing_appointment_coordination: 'time_ambiguous',
    auto_booking_skipped_after_approval: 'time_ambiguous',
    existing_appointment_same_date: 'time_ambiguous',
    auto_booking_previously_cancelled: 'time_ambiguous',
    multi_property_call: 'address_review',
    caller_not_authorized: 'customer_field_conflict',
    hoa_common_area_requires_approval: 'customer_field_conflict',
    commercial_requires_quote: 'customer_field_conflict',
    prior_complaint_unresolved: 'customer_field_conflict',
    sms_consent_missing: 'customer_field_conflict',
    low_extraction_confidence: 'service_unknown',
    spam_or_wrong_number: 'service_unknown',
    caller_phone_missing: 'customer_field_conflict',
    do_not_contact_requested: 'customer_field_conflict',
    lead_creation_failed: 'customer_field_conflict',
    name_email_mismatch: 'name_review',
    voicemail: 'service_unknown',
    // Shadow address/identity bridge reasons (deriveCallReviewBridge).
    missing_last_name: 'name_review',
    rental_or_tenant_occupied: 'customer_field_conflict',
    second_service_address: 'address_review',
    address_recovered: 'address_review',
    address_readback: 'address_review',
    secondary_contact_captured: 'customer_field_conflict',
    secondary_contact_is_existing_customer: 'customer_field_conflict',
    shared_phone_ambiguous: 'customer_field_conflict',
    unassigned_auto_booking: 'time_ambiguous',
  };

  const synopsis = extraction?.meta?.call_summary || null;

  // secondary_contact_captured items are only useful if the row carries the
  // contact to confirm. Several sites insert this flag (the enforce-mode
  // deterministic-flags loop first, the processor's payload-rich insert
  // second) and the open-row unique index makes the FIRST insert win — so
  // attach the extraction's own secondary_contact here, where every insert
  // site flows through, instead of relying on the caller to pass it.
  const flagPayload = (flag === 'secondary_contact_captured' && extraction?.secondary_contact)
    ? {
      secondary_contact: extraction.secondary_contact,
      // Full multi-party list (1.4.0) so the card shows EVERY named party.
      ...(Array.isArray(extraction?.secondary_contacts) && extraction.secondary_contacts.length > 1
        ? { secondary_contacts: extraction.secondary_contacts }
        : {}),
      // 4th+ parties exist beyond the array — cue the office to re-listen.
      ...(extraction?.other_parties_mentioned === true ? { other_parties_mentioned: true } : {}),
    }
    : {};

  // Multi-property cards previously carried no addresses — the one surface
  // built to tell the office "there's a second property" required transcript
  // archaeology to learn WHICH property.
  if (flag === 'multi_property_call' && Array.isArray(extraction?.property?.additional_properties) && extraction.property.additional_properties.length) {
    flagPayload.additional_properties = extraction.property.additional_properties;
  }

  // Scheduling-shaped cards carry the model's captured window fields so the
  // office can book "Tuesday, first slot" from the card instead of re-listening
  // — these fields were extracted all along but had zero readers.
  const SCHEDULING_PAYLOAD_FLAGS = new Set([
    'not_confirmed', 'confirmed_without_start_time', 'ambiguous_scheduling',
    'reschedule_or_cancel', 'cancellation_request',
    'existing_appointment_coordination', 'auto_booking_skipped_after_approval',
  ]);
  if (SCHEDULING_PAYLOAD_FLAGS.has(flag) && extraction?.scheduling) {
    const s = extraction.scheduling;
    flagPayload.scheduling_window = {
      status: s.status ?? null,
      confirmed_start_at: s.confirmed_start_at ?? null,
      requested_date_range_start: s.requested_date_range_start ?? null,
      requested_date_range_end: s.requested_date_range_end ?? null,
      preferred_time_of_day: s.preferred_time_of_day ?? null,
      callback_window_start: s.callback_window_start ?? null,
      callback_window_end: s.callback_window_end ?? null,
      scheduling_notes_raw: s.scheduling_notes_raw ?? null,
    };
  }

  return {
    call_log_id: callLogId,
    category: flagToCategoryMap[flag] || 'service_unknown',
    severity,
    reason_code: flag,
    status: 'open',
    summary: synopsis,
    payload: JSON.stringify({
      flag,
      confidence: extraction?.confidence?.overall,
      scheduling_status: extraction?.scheduling?.status,
      ...flagPayload,
      ...(extraPayload && typeof extraPayload === 'object' ? extraPayload : {}),
    }),
    created_at: new Date(),
    updated_at: new Date(),
  };
}

module.exports = {
  computeAppointmentIdempotencyKey,
  computeAddressHash,
  checkTcpaConsent,
  buildRouteDecision,
  buildTriageItem,
};
