const db = require('../models/db');
const logger = require('./logger');

// Project types that must NEVER route through the generic typed
// service-report (Specialty V1) completion flow, no matter what
// service_completion_profiles says. WDO completion is load-bearing legal
// machinery — licensee e-signature gate, signed FDACS-13645 PDF generation,
// archived filings, the combined report+invoice send — none of which V1
// completion performs. Profile rows are data: one bad WHERE clause in a
// future cutover migration could silently flip the mode and bypass every
// FDACS gate, so the exclusion is enforced in code at profile resolution
// (serializeProfile coerces the mode back) and at creation gating
// (appointmentManagedProjectTypes filters it out).
const V1_EXCLUDED_PROJECT_TYPES = new Set(['wdo_inspection']);

const DEFAULT_SERVICE_REPORT_PROFILE = {
  serviceKey: null,
  serviceName: null,
  category: null,
  billingType: null,
  completionMode: 'service_report',
  projectType: null,
  createsServiceRecord: true,
  portalVisibility: 'customer_portal',
  portalAttachPolicy: 'active_portal_customer',
  followupPolicy: 'none',
  defaultFollowupDays: null,
  active: true,
  notes: 'Fallback profile: standard service-report completion.',
  projectBacked: false,
  specialProject: false,
  requiresProject: false,
  findingsType: null,
  deliveryMode: 'auto_send',
};

function serializeProfile(row = null) {
  if (!row) return { ...DEFAULT_SERVICE_REPORT_PROFILE };
  if (row.completion_mode === 'service_report' && V1_EXCLUDED_PROJECT_TYPES.has(row.project_type)) {
    logger.warn(
      `[completion-profiles] profile ${row.service_key || row.id} claims service_report completion for excluded project type "${row.project_type}" — coercing to special_project (compliance-gated flow)`,
    );
    // The row has been flagged bad — don't half-trust it. Keep only its
    // identity (service key/name/category/billing), the project-flow pointer,
    // and active state; every BEHAVIOR field resets FAIL-CLOSED. Portal
    // policy uses the excluded types' real special-project posture (the
    // seeded wdo_inspection profile is token_only + recurring_customer —
    // "keep out of routine service-report surfaces"), NOT the registry's
    // customer_portal defaults, which would be BROADER sharing than the
    // legitimate profile this guard is protecting.
    return {
      serviceKey: row.service_key || null,
      serviceName: row.service_name_snapshot || null,
      category: row.category || null,
      billingType: row.billing_type || null,
      completionMode: 'special_project',
      projectType: row.project_type,
      findingsType: null,
      createsServiceRecord: true,
      portalVisibility: 'token_only',
      portalAttachPolicy: 'recurring_customer',
      followupPolicy: 'none',
      defaultFollowupDays: null,
      active: row.active !== false,
      notes: row.notes || null,
      projectBacked: true,
      specialProject: true,
      requiresProject: true,
      deliveryMode: 'auto_send',
    };
  }
  const completionMode = row.completion_mode || 'service_report';
  const projectBacked = completionMode === 'project_required' || completionMode === 'special_project';
  return {
    serviceKey: row.service_key || null,
    serviceName: row.service_name_snapshot || null,
    category: row.category || null,
    billingType: row.billing_type || null,
    completionMode,
    // projectType is the PROJECT-flow pointer — null for service_report
    // profiles so stale `if (profile.projectType)` client logic can never
    // route a typed completion back into the Projects flow. The same column
    // value is exposed as findingsType when the mode is service_report:
    // that's the typed-findings schema pointer for specialty completions.
    projectType: projectBacked ? (row.project_type || null) : null,
    findingsType: completionMode === 'service_report' ? (row.project_type || null) : null,
    createsServiceRecord: row.creates_service_record !== false,
    portalVisibility: row.portal_visibility || 'customer_portal',
    portalAttachPolicy: row.portal_attach_policy || 'active_portal_customer',
    followupPolicy: row.followup_policy || 'none',
    defaultFollowupDays: row.default_followup_days == null ? null : Number(row.default_followup_days),
    active: row.active !== false,
    notes: row.notes || null,
    projectBacked,
    specialProject: completionMode === 'special_project',
    requiresProject: projectBacked,
    deliveryMode: row.delivery_mode || 'auto_send',
  };
}

async function tableAvailable(knex) {
  return knex.schema.hasTable('service_completion_profiles').catch(() => false);
}

async function lookupServiceForScheduledService(scheduledService = {}, knex = db) {
  if (!scheduledService) return null;
  if (scheduledService.service_id) {
    const byId = await knex('services')
      .where({ id: scheduledService.service_id })
      .first('service_key', 'name', 'category', 'billing_type');
    if (byId) return byId;
  }

  const serviceType = String(scheduledService.service_type || scheduledService.serviceType || '').trim();
  if (!serviceType) return null;

  const exact = await knex('services')
    .whereRaw('lower(name) = lower(?)', [serviceType])
    .first('service_key', 'name', 'category', 'billing_type');
  if (exact) return exact;

  return knex('services')
    .whereRaw('lower(short_name) = lower(?)', [serviceType])
    .first('service_key', 'name', 'category', 'billing_type')
    .catch(() => null);
}

async function profileByServiceKey(serviceKey, knex = db) {
  if (!serviceKey || !(await tableAvailable(knex))) return null;
  return knex('service_completion_profiles')
    .where({ service_key: serviceKey, active: true })
    .first();
}

async function resolveCompletionProfileForScheduledService(scheduledService = {}, knex = db) {
  const service = await lookupServiceForScheduledService(scheduledService, knex);
  const profile = service?.service_key
    ? await profileByServiceKey(service.service_key, knex)
    : null;
  if (profile) return serializeProfile(profile);

  return {
    ...DEFAULT_SERVICE_REPORT_PROFILE,
    serviceKey: service?.service_key || null,
    serviceName: service?.name || scheduledService.service_type || scheduledService.serviceType || null,
    category: service?.category || null,
    billingType: service?.billing_type || null,
  };
}

async function resolveCompletionProfileForServiceId(serviceId, knex = db) {
  const scheduledService = await knex('scheduled_services')
    .where({ id: serviceId })
    .first('id', 'service_id', 'service_type');
  if (!scheduledService) return null;
  return resolveCompletionProfileForScheduledService(scheduledService, knex);
}

/**
 * Project types that are "appointment-managed": at least one ACTIVE profile
 * routes them through the typed service-report completion flow
 * (completion_mode='service_report' with a project_type pointer). Keyed to
 * live cutover state — NOT registry metadata — so Projects creation for a
 * type stays available until the moment that type actually cuts over.
 */
async function appointmentManagedProjectTypes(knex = db) {
  if (!(await tableAvailable(knex))) return new Set();
  try {
    const rows = await knex('service_completion_profiles')
      .where({ completion_mode: 'service_report', active: true })
      .whereNotNull('project_type')
      .distinct('project_type');
    return new Set(
      rows
        .map((row) => row.project_type)
        .filter(Boolean)
        // Code-enforced V1 exclusions (see V1_EXCLUDED_PROJECT_TYPES) — a
        // flipped profile row must not retire the Projects creation path for
        // a type whose completion the V1 flow cannot legally perform.
        .filter((type) => !V1_EXCLUDED_PROJECT_TYPES.has(type)),
    );
  } catch {
    return new Set();
  }
}

module.exports = {
  resolveCompletionProfileForScheduledService,
  resolveCompletionProfileForServiceId,
  serializeProfile,
  appointmentManagedProjectTypes,
  DEFAULT_SERVICE_REPORT_PROFILE,
  V1_EXCLUDED_PROJECT_TYPES,
};
