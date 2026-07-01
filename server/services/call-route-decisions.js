const db = require('../models/db');
const logger = require('./logger');

const DECISION_VERSION = 'legacy-call-v1';
const DECISION_MODE = 'shadow';

let routeDecisionsTableAvailable = null;

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== null && item !== undefined && item !== '')
  );
}

function jsonb(value) {
  return JSON.stringify(value ?? null);
}

function addReason(list, reason) {
  if (!reason) return;
  const value = String(reason).trim();
  if (value && !list.includes(value)) list.push(value);
}

function routeDecisionModeRank(row = {}) {
  if (row.mode === 'enforce') return 0;
  if (row.mode === 'shadow') return 1;
  return 2;
}

function routeDecisionVersionRank(row = {}) {
  const version = String(row.decision_version || '');
  if (version.startsWith('v2-')) return 0;
  if (version === DECISION_VERSION) return 1;
  return 2;
}

function routeDecisionCreatedAtMs(row = {}) {
  const value = row.created_at ? new Date(row.created_at).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

function compareRouteDecisionsForFeedback(a, b) {
  return routeDecisionModeRank(a) - routeDecisionModeRank(b) ||
    routeDecisionVersionRank(a) - routeDecisionVersionRank(b) ||
    routeDecisionCreatedAtMs(b) - routeDecisionCreatedAtMs(a);
}

function preferredRouteDecisionForFeedback(rows = []) {
  return [...rows].filter(Boolean).sort(compareRouteDecisionsForFeedback)[0] || null;
}

function fieldWritePlanFromExtraction(extracted = {}) {
  const fields = [
    'first_name',
    'last_name',
    'email',
    'phone',
    'address_line1',
    'city',
    'state',
    'zip',
    'requested_service',
    'matched_service',
  ];

  return fields
    .filter((field) => extracted[field] !== null && extracted[field] !== undefined && extracted[field] !== '')
    .map((field) => ({
      field,
      extracted_value: extracted[field],
      source: 'legacy_gemini_v1',
      status: 'observed_only',
    }));
}

function buildLegacyShadowRouteDecision({
  call,
  extracted = {},
  customerId = null,
  leadId = null,
  finalStatus = null,
  appointmentResult = null,
  serviceResolution = null,
  hasSpecificTime = false,
  createdCustomerFromCall = false,
} = {}) {
  const blockedReasons = [];
  const allowedReasons = ['codex_shadow_route_decision', 'legacy_v1_extraction_processed'];

  if (extracted.is_spam) addReason(blockedReasons, 'spam');
  if (extracted.is_voicemail) addReason(blockedReasons, 'voicemail');
  if (customerId) addReason(allowedReasons, 'customer_linked');
  if (createdCustomerFromCall) addReason(allowedReasons, 'customer_created');
  if (leadId) addReason(allowedReasons, 'lead_linked');

  const appointmentDiscussed = !!(extracted.appointment_confirmed || extracted.preferred_date_time || appointmentResult);
  const scheduledServiceId = appointmentResult?.scheduledServiceId || null;
  const scheduleReused = !!appointmentResult?.scheduleReused;
  const scheduleCreated = !!scheduledServiceId && !scheduleReused;
  const scheduleAccepted = !!scheduledServiceId;

  if (extracted.appointment_confirmed) addReason(allowedReasons, 'appointment_confirmed_extracted');
  if (hasSpecificTime) addReason(allowedReasons, 'specific_time_extracted');
  if (serviceResolution?.ok) addReason(allowedReasons, 'schedulable_service_resolved');

  if (extracted.appointment_confirmed) {
    if (!extracted.preferred_date_time) addReason(blockedReasons, 'missing_preferred_datetime');
    if (!hasSpecificTime) addReason(blockedReasons, 'time_not_specific');
    if (!customerId) addReason(blockedReasons, 'missing_customer');
    if (serviceResolution && !serviceResolution.ok) {
      addReason(blockedReasons, serviceResolution.reason || 'service_not_schedulable');
    }
    if (appointmentResult?.skippedReason) addReason(blockedReasons, appointmentResult.skippedReason);
    if (appointmentResult?.scheduleError) addReason(blockedReasons, 'schedule_error');
    if (appointmentResult?.error) addReason(blockedReasons, 'appointment_error');
    if (Array.isArray(appointmentResult?.missingFields)) {
      for (const field of appointmentResult.missingFields) addReason(blockedReasons, `missing_${field}`);
    }
  }

  // A customer-less recovery lead is still a real canonical write — only flag
  // "no customer match" when we also created no lead, so lead-only recovery
  // isn't recorded as a dropped call.
  if (!customerId && !leadId && !extracted.is_spam && !extracted.is_voicemail) {
    addReason(blockedReasons, 'no_customer_match');
  }
  if (leadId && !customerId) addReason(allowedReasons, 'lead_created_without_customer');

  let validatorRecommendation = 'needs_review';
  if (scheduleAccepted) {
    validatorRecommendation = 'auto_create_appointment';
  } else if (!blockedReasons.length && customerId) {
    validatorRecommendation = 'upsert_customer_only';
  } else if (!blockedReasons.length && leadId) {
    validatorRecommendation = 'create_lead';
  } else if (!appointmentDiscussed && !blockedReasons.length) {
    validatorRecommendation = 'upsert_customer_only';
  }

  let finalActionTaken = 'no_op';
  if (scheduleCreated) finalActionTaken = 'auto_create_appointment';
  else if (scheduleReused) finalActionTaken = 'reuse_existing_appointment';
  else if (appointmentDiscussed && blockedReasons.length) finalActionTaken = 'needs_review';
  else if (createdCustomerFromCall) finalActionTaken = 'create_customer';
  else if (customerId) finalActionTaken = 'upsert_customer_only';
  else if (leadId) finalActionTaken = 'create_lead';
  else if (extracted.is_spam) finalActionTaken = 'no_op_spam';
  else if (extracted.is_voicemail) finalActionTaken = 'no_op_voicemail';

  const appointmentWritePlan = appointmentDiscussed
    ? compactObject({
        appointment_confirmed: !!extracted.appointment_confirmed,
        preferred_date_time: extracted.preferred_date_time || null,
        has_specific_time: !!hasSpecificTime,
        service: serviceResolution?.service || appointmentResult?.service || extracted.matched_service || extracted.requested_service || null,
        service_resolution: serviceResolution || null,
        result: appointmentResult || null,
        legacy_inline_sms_sent: !!appointmentResult?.smsSent,
      })
    : null;

  return {
    call_log_id: call?.id || null,
    source_call_group_id: call?.twilio_call_sid || null,
    decision_version: DECISION_VERSION,
    mode: DECISION_MODE,
    validator_recommendation: validatorRecommendation,
    final_action_taken: finalActionTaken,
    blocked_reasons: blockedReasons,
    allowed_reasons: allowedReasons,
    field_write_plan: fieldWritePlanFromExtraction(extracted),
    appointment_write_plan: appointmentWritePlan,
    estimate_write_plan: null,
    created_customer_id: createdCustomerFromCall ? customerId : null,
    created_estimate_id: null,
    created_scheduled_service_id: scheduledServiceId,
    sms_enqueued: false,
    ai_validation_model: 'codex_legacy_rules',
    ai_validation_prompt_version: null,
    ai_validation_schema_version: null,
    enrichment_version: null,
    metadata: compactObject({
      finalStatus,
      leadId,
    }),
  };
}

async function hasRouteDecisionsTable() {
  if (routeDecisionsTableAvailable !== null) return routeDecisionsTableAvailable;
  routeDecisionsTableAvailable = await db.schema.hasTable('route_decisions').catch(() => false);
  return routeDecisionsTableAvailable;
}

async function writeLegacyShadowRouteDecision(input = {}) {
  const decision = buildLegacyShadowRouteDecision(input);
  if (!decision.call_log_id) return null;

  if (!(await hasRouteDecisionsTable())) {
    logger.warn('[call-route] route_decisions table missing; shadow decision skipped');
    return null;
  }

  const payload = {
    ...decision,
    blocked_reasons: jsonb(decision.blocked_reasons),
    allowed_reasons: jsonb(decision.allowed_reasons),
    field_write_plan: jsonb(decision.field_write_plan),
    appointment_write_plan: jsonb(decision.appointment_write_plan),
    estimate_write_plan: jsonb(decision.estimate_write_plan),
  };
  delete payload.metadata;

  try {
    const rows = await db('route_decisions')
      .insert(payload)
      .onConflict(['call_log_id', 'decision_version', 'mode'])
      .ignore()
      .returning(['id']);
    return rows?.[0] || null;
  } catch (err) {
    logger.warn(`[call-route] shadow decision skipped for call ${decision.call_log_id}: ${err.message}`);
    return null;
  }
}

module.exports = {
  DECISION_MODE,
  DECISION_VERSION,
  buildLegacyShadowRouteDecision,
  compareRouteDecisionsForFeedback,
  preferredRouteDecisionForFeedback,
  writeLegacyShadowRouteDecision,
  _test: {
    fieldWritePlanFromExtraction,
  },
};
