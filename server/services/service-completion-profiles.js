const db = require('../models/db');

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
  // try/catch, not just .catch(): if knex.schema itself is unavailable the
  // property access throws before a promise exists, and the rejection would
  // escape appointmentManagedProjectTypes' fail-open contract (500ing every
  // project create instead of degrading to "no types managed").
  try {
    return await knex.schema.hasTable('service_completion_profiles');
  } catch {
    return false;
  }
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
    return new Set(rows.map((row) => row.project_type).filter(Boolean));
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
};
