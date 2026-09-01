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

function parseJsonObject(value) {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Freeze a resolved requirements verdict at completion time. The snapshot
// reuses the normalizeRequirements shape verbatim (writer/reader symmetry)
// plus provenance: `source` is closeout_requirements_source at freeze time,
// and serviceName/category are captured because inference keys off them —
// a later catalog RENAME moves verdicts just like a requirement edit would.
function buildCloseoutRequirementsSnapshot(requirements, { now = new Date() } = {}) {
  if (!requirements || typeof requirements.requiresServiceReport !== 'boolean') return null;
  return {
    v: 1,
    frozenAt: now.toISOString(),
    serviceId: requirements.serviceId || null,
    serviceName: requirements.serviceName || null,
    category: requirements.category || null,
    source: requirements.source || 'fallback_inference',
    requiresServiceReport: requirements.requiresServiceReport === true,
    requiresApplicationLog: requirements.requiresApplicationLog === true,
    requiredPhotoCount: Number.isFinite(Number(requirements.requiredPhotoCount))
      ? Math.max(0, Number(requirements.requiredPhotoCount))
      : 0,
    requiresCustomerSignature: requirements.requiresCustomerSignature === true,
    requiresCustomerNotice: requirements.requiresCustomerNotice === true,
    requiresLicense: requirements.requiresLicense === true,
    licenseCategory: requirements.licenseCategory || null,
  };
}

// Frozen-first reader (typed-followup-obligation.js frozenVerdict shape): a
// well-typed structured_notes.closeoutRequirements wins over the live
// catalog; absent or malformed returns null and the caller falls back live.
// A frozen source of 'fallback_inference'/'inferred_v1' IS honored — "frozen
// as inferred" is what the tooling showed at completion, distinct from "not
// frozen".
const FROZEN_BOOLEAN_FIELDS = Object.freeze([
  'requiresServiceReport',
  'requiresApplicationLog',
  'requiresCustomerSignature',
  'requiresCustomerNotice',
  'requiresLicense',
]);

function frozenCloseoutRequirements(structuredNotes) {
  const snap = parseJsonObject(structuredNotes).closeoutRequirements;
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return null;
  // STRICT validation (pre-push codex P1): every field must be present and
  // well-typed, or the snapshot is not frozen and the live catalog decides.
  // A permissive reader that defaults a missing flag to false would let a
  // partial/corrupt snapshot SUPPRESS required closeout work.
  if (snap.v !== 1) return null;
  for (const field of FROZEN_BOOLEAN_FIELDS) {
    if (typeof snap[field] !== 'boolean') return null;
  }
  if (typeof snap.requiredPhotoCount !== 'number'
    || !Number.isFinite(snap.requiredPhotoCount)
    || snap.requiredPhotoCount < 0) return null;
  if (typeof snap.source !== 'string' || !snap.source) return null;
  return {
    serviceId: snap.serviceId || null,
    serviceName: snap.serviceName || null,
    category: snap.category || null,
    requiresServiceReport: snap.requiresServiceReport,
    requiresApplicationLog: snap.requiresApplicationLog,
    requiredPhotoCount: snap.requiredPhotoCount,
    requiresCustomerSignature: snap.requiresCustomerSignature,
    requiresCustomerNotice: snap.requiresCustomerNotice,
    requiresLicense: snap.requiresLicense,
    licenseCategory: snap.licenseCategory || null,
    source: snap.source,
    frozen: true,
    frozenAt: snap.frozenAt || null,
  };
}

// Write-side probe for the three service_records writers. SAVEPOINT-wrapped
// (waves-db §5b): the strict lookup runs on the caller's trx, so a failure
// must roll back only this statement, never abort the completion
// transaction. Lookup failure ⇒ null ⇒ freeze NOTHING (provenanceUnknown
// precedent, completion-tier-snapshot.js) — a reader must be able to tell
// "not frozen" from "frozen as inferred". A MISSING catalog row does not
// throw: it freezes the fallback_inference verdict, which is what the
// operator's tooling showed at completion time.
async function resolveCloseoutRequirementsSnapshotForCompletion({
  trx = db,
  serviceId,
  catalogServiceId = null,
  serviceType = null,
  now = new Date(),
} = {}) {
  if (!serviceId) return null;
  try {
    const requirements = await trx.transaction(async (sp) => {
      const map = await resolveCloseoutRequirementsForJobs(
        [{ id: serviceId, service_id: catalogServiceId, service_type: serviceType }],
        { knex: sp, strict: true },
      );
      return map.get(serviceId) || null;
    });
    return buildCloseoutRequirementsSnapshot(requirements, { now });
  } catch {
    return null;
  }
}

// `knex` lets a caller inside a transaction / test harness supply its own
// handle; `strict` makes a catalog lookup failure PROPAGATE instead of
// degrading every job to fallback inference — a status reader must be able
// to tell "catalog unavailable" from "no catalog row" (closeout-status.js).
// `frozenByJobId` (Map jobId → structured_notes value or pre-parsed object):
// jobs with a valid frozen snapshot resolve from it and never touch the
// catalog; only unfrozen jobs enter the whereIn.
async function resolveCloseoutRequirementsForJobs(jobs = [], { knex = db, strict = false, frozenByJobId = null } = {}) {
  const result = new Map();
  const liveJobs = [];
  for (const job of jobs) {
    const jobKey = job.id || job.sourceRecordId;
    const frozen = frozenByJobId ? frozenCloseoutRequirements(frozenByJobId.get(jobKey)) : null;
    if (frozen) result.set(jobKey, frozen);
    else liveJobs.push(job);
  }

  const serviceIds = [...new Set(liveJobs.map((job) => job.service_id).filter(Boolean))];
  const serviceNames = [...new Set(liveJobs
    .filter((job) => !job.service_id && job.service_type)
    .map((job) => String(job.service_type).trim())
    .filter(Boolean))];

  const byId = new Map();
  const byName = new Map();
  if (serviceIds.length || serviceNames.length) {
    const q = knex('services').select(
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
    const rows = strict ? await q : await q.catch(() => []);
    for (const row of rows) {
      byId.set(row.id, row);
      byName.set(String(row.name || '').trim().toLowerCase(), row);
    }
  }

  for (const job of liveJobs) {
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
  buildCloseoutRequirementsSnapshot,
  frozenCloseoutRequirements,
  resolveCloseoutRequirementsSnapshotForCompletion,
};
