const db = require('../models/db');

const APPLICATION_CATEGORIES = new Set([
  'pest_control',
  'lawn_care',
  'mosquito',
  'termite',
  'tree_shrub',
]);

const INSPECTION_RE = /inspection|assessment|wdo|letter/i;
const APPLICATION_RE = /pest|roach|ant|flea|bed|mosquito|termite|lawn|weed|fertili|tree|shrub|palm|fire ant|treatment|application/i;
const PHOTO_RE = /termite|wdo|rodent|palm|tree|shrub|inspection|assessment/i;
const INFERRED_SOURCES = new Set(['default', 'inferred_v1', 'fallback_inference']);

function bool(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value == null) return fallback;
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
}

function inferApplicationLog({ category, serviceType }) {
  const haystack = `${category || ''} ${serviceType || ''}`;
  if (INSPECTION_RE.test(haystack) && !/treatment|application|bond/i.test(haystack)) return false;
  return APPLICATION_CATEGORIES.has(String(category || '').toLowerCase()) || APPLICATION_RE.test(haystack);
}

function inferPhotoCount({ category, serviceType }) {
  return PHOTO_RE.test(`${category || ''} ${serviceType || ''}`) ? 2 : 0;
}

function inferCloseoutDefaults(row = {}, serviceType = null) {
  const category = row.category || null;
  const label = row.name || serviceType || 'Service';
  const applicationLog = inferApplicationLog({ category, serviceType: label });
  return {
    requires_service_report: true,
    requires_application_log: applicationLog,
    required_photo_count: inferPhotoCount({ category, serviceType: label }),
    requires_customer_signature: false,
    requires_customer_notice: applicationLog,
    closeout_requirements_source: 'inferred_v1',
  };
}

function shouldInferRequirements(row = {}) {
  if (!row.id) return true;
  const source = String(row.closeout_requirements_source || '').trim();
  return !source || INFERRED_SOURCES.has(source);
}

function normalizeRequirements(row = {}, serviceType = null) {
  const category = row.category || null;
  const label = row.name || serviceType || 'Service';
  const shouldInfer = shouldInferRequirements(row);
  const inferred = shouldInfer ? inferCloseoutDefaults(row, label) : null;
  const applicationLog = shouldInfer
    ? inferred.requires_application_log
    : bool(row.requires_application_log, false);
  const photoCount = shouldInfer
    ? Number(inferred.required_photo_count || 0)
    : Number(row.required_photo_count || 0);

  return {
    serviceId: row.id || null,
    serviceName: label,
    category,
    requiresServiceReport: shouldInfer
      ? inferred.requires_service_report
      : bool(row.requires_service_report, true),
    requiresApplicationLog: applicationLog,
    requiredPhotoCount: Number.isFinite(photoCount) ? Math.max(0, photoCount) : 0,
    requiresCustomerSignature: shouldInfer
      ? inferred.requires_customer_signature
      : bool(row.requires_customer_signature, false),
    requiresCustomerNotice: shouldInfer
      ? inferred.requires_customer_notice
      : bool(row.requires_customer_notice, applicationLog),
    requiresLicense: bool(row.requires_license, false),
    licenseCategory: row.license_category || null,
    source: row.id ? (row.closeout_requirements_source || 'inferred_v1') : 'fallback_inference',
  };
}

async function resolveCloseoutRequirementsForJobs(jobs = []) {
  const serviceIds = [...new Set(jobs.map((job) => job.service_id).filter(Boolean))];
  const serviceNames = [...new Set(jobs
    .filter((job) => !job.service_id && job.service_type)
    .map((job) => String(job.service_type).trim())
    .filter(Boolean))];

  const byId = new Map();
  const byName = new Map();
  if (serviceIds.length || serviceNames.length) {
    const q = db('services').select(
      'id',
      'name',
      'category',
      'requires_service_report',
      'requires_application_log',
      'required_photo_count',
      'requires_customer_signature',
      'requires_customer_notice',
      'requires_license',
      'license_category',
      'closeout_requirements_source',
    );
    q.where((qb) => {
      if (serviceIds.length) qb.whereIn('id', serviceIds);
      if (serviceNames.length) {
        if (serviceIds.length) qb.orWhereIn('name', serviceNames);
        else qb.whereIn('name', serviceNames);
      }
    });
    const rows = await q.catch(() => []);
    for (const row of rows) {
      byId.set(row.id, row);
      byName.set(String(row.name || '').trim().toLowerCase(), row);
    }
  }

  const result = new Map();
  for (const job of jobs) {
    const serviceType = job.service_type || job.metadata?.serviceType || null;
    const catalogRow = byId.get(job.service_id) || byName.get(String(serviceType || '').trim().toLowerCase());
    result.set(job.id || job.sourceRecordId, normalizeRequirements(catalogRow || {}, serviceType));
  }
  return result;
}

module.exports = {
  inferCloseoutDefaults,
  normalizeRequirements,
  resolveCloseoutRequirementsForJobs,
};
