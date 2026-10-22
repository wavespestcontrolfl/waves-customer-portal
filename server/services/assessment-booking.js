/**
 * Waves Assessment identity — the ONE predicate every booking path consults
 * before treating a booking as a closed sale.
 *
 * Owner ruling 2026-09-08: an assessment is NOT a win. It is the internal-only
 * catch-all consultation booked when the concrete service is still unknown
 * (the owner walks the property, then prices a quote). Booking one must not
 * convert the lead to `won`, must not promote the customer row into a
 * customer stage, and must not stamp member_since — the deal closes when the
 * quote is accepted or a paid service books, exactly as every other path
 * already does. Paid inspections (WDO) are real sales and are NOT covered.
 *
 * The catalog row is service_key 'lawn_inspection' (renamed "Waves
 * Assessment" by migration 20260619000002); bookings denormalize the name into
 * scheduled_services.service_type, and legacy rows can carry the name without
 * the FK — match either. Shared with the estimator's booking pre-draft hook so
 * "what is an assessment" can never drift between the two.
 */

const db = require('../models/db');

const ASSESSMENT_DISPLAY_NAME = 'Waves Assessment';
const ASSESSMENT_NAME_RE = /^waves assessment$/i;
const ASSESSMENT_SERVICE_KEY = 'lawn_inspection';

function isAssessmentServiceType(serviceType) {
  return ASSESSMENT_NAME_RE.test(String(serviceType || '').trim());
}

function isAssessmentServiceRow(serviceRow) {
  if (!serviceRow) return false;
  return serviceRow.service_key === ASSESSMENT_SERVICE_KEY
    || isAssessmentServiceType(serviceRow.name);
}

function scopeToAssessmentBookings(query, bookingAlias = 'scheduled_services', serviceAlias = 'services') {
  return query.where(function assessmentIdentity() {
    this.whereRaw('LOWER(TRIM(??)) = ?', [`${bookingAlias}.service_type`, ASSESSMENT_DISPLAY_NAME.toLowerCase()])
      .orWhere(`${serviceAlias}.service_key`, ASSESSMENT_SERVICE_KEY)
      .orWhereRaw('LOWER(TRIM(??)) = ?', [`${serviceAlias}.name`, ASSESSMENT_DISPLAY_NAME.toLowerCase()]);
  });
}

// A scheduled_services row, pure (no db read). CATALOG IDENTITY WINS: callers
// that load the row with a left join to `services` pass it as
// catalog_service_key / catalog_service_name, and when either is present the
// verdict comes from the catalog alone (lawn_inspection or the exact "Waves
// Assessment" name). A visit an admin repointed to a paid service keeps its
// stale service_type snapshot, and must stay adoptable. The denormalized
// service_type decides only for rows with no catalog identity (unlinked
// legacy rows). Used by estimate adoption: an assessment is a free
// consultation, never an estimate's first paid application, even though its
// lawn_inspection key classifies into the lawn family.
function isAssessmentVisit(row) {
  if (!row) return false;
  if (row.catalog_service_key || row.catalog_service_name) {
    return row.catalog_service_key === ASSESSMENT_SERVICE_KEY
      || isAssessmentServiceType(row.catalog_service_name);
  }
  return isAssessmentServiceType(row.service_type);
}

// SQL twin of isAssessmentVisit (catalog wins), for a query that left-joins
// `services`: keeps every row that is NOT an assessment visit. NULL-safe, so
// rows with no catalog link survive.
function excludeAssessmentBookings(query, bookingAlias = 'scheduled_services', serviceAlias = 'services') {
  return query.whereRaw(
    `NOT (CASE WHEN ?? IS NOT NULL
      THEN (COALESCE(??, '') = ? OR LOWER(TRIM(COALESCE(??, ''))) = ?)
      ELSE LOWER(TRIM(COALESCE(??, ''))) = ? END)`,
    [
      `${serviceAlias}.id`,
      `${serviceAlias}.service_key`, ASSESSMENT_SERVICE_KEY,
      `${serviceAlias}.name`, ASSESSMENT_DISPLAY_NAME.toLowerCase(),
      `${bookingAlias}.service_type`, ASSESSMENT_DISPLAY_NAME.toLowerCase(),
    ],
  );
}

// Drops assessment visits from loaded scheduled_services rows (no catalog
// join on the caller's read), by the same catalog-wins rule as
// isAssessmentVisit: ONE batched lookup of the rows' services; a row whose
// service resolves is judged by the catalog only, any other row by its
// service_type.
async function withoutAssessmentVisits(rows, database = db) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(list.map((row) => row?.service_id).filter(Boolean))];
  const catalogById = new Map();
  if (ids.length > 0) {
    const services = await database('services').whereIn('id', ids).select('id', 'service_key', 'name');
    for (const service of services || []) catalogById.set(String(service.id), service);
  }
  return list.filter((row) => {
    const service = row?.service_id ? catalogById.get(String(row.service_id)) : null;
    return !isAssessmentVisit({
      service_type: row?.service_type,
      catalog_service_key: service?.service_key || null,
      catalog_service_name: service?.name || null,
    });
  });
}

// A scheduled_services-shaped row: the denormalized name first, then the
// catalog FK when the name alone doesn't say.
async function isAssessmentBooking(booking, database = db) {
  if (!booking) return false;
  if (isAssessmentServiceType(booking.service_type)) return true;
  if (!booking.service_id) return false;
  const serviceRow = await database('services').where({ id: booking.service_id }).first();
  return isAssessmentServiceRow(serviceRow);
}

module.exports = {
  ASSESSMENT_DISPLAY_NAME,
  ASSESSMENT_NAME_RE,
  ASSESSMENT_SERVICE_KEY,
  isAssessmentServiceType,
  isAssessmentServiceRow,
  isAssessmentVisit,
  withoutAssessmentVisits,
  excludeAssessmentBookings,
  scopeToAssessmentBookings,
  isAssessmentBooking,
};
