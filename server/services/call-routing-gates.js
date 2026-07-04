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
    processing_error: 'service_unknown',
    name_email_mismatch: 'name_review',
    voicemail: 'service_unknown',
    // Shadow address/identity bridge reasons (deriveCallReviewBridge).
    missing_last_name: 'name_review',
    rental_or_tenant_occupied: 'customer_field_conflict',
    second_service_address: 'address_review',
    address_recovered: 'address_review',
  };

  const synopsis = extraction?.meta?.call_summary || null;

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
