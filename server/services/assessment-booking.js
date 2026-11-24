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
const logger = require('./logger');

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

// How far before an estimate's creation a completed Waves Assessment still counts as the look for it.
const LOOK_WINDOW_DAYS = 30;

// Did this estimate's customer complete a Waves Assessment on or after LOOK_WINDOW_DAYS before the estimate was
// created? (`estimate` needs customer_id, created_at, id.) That visit was "the look" for the estimate even though the
// estimate is not linked to it, so every free-assessment offer built from the estimate (the estimate page's "Book a
// free Waves Assessment first" and its booking page, the lead-link consultation offer on the page and in the
// gone-quiet email) is withheld. The ONE rule for it: the same assessment identity as findOpenVisit
// (scopeToAssessmentBookings); only 'completed' counts (cancelled, skipped, no_show are no look). Legacy completions
// carry a NULL completed_at, so the visit's ET date stands in (estimate-conversion-guard.js). The offers are optional:
// a failed read logs a warning and answers false, so the offer stays and no page 500s. (Inside a transaction a failed
// read aborts that transaction, which fails the booking or send rather than risking a second free visit.)
async function hadCompletedAssessmentLook(conn, estimate) {
  if (!estimate?.customer_id || !estimate.created_at) return false;
  const since = new Date(new Date(estimate.created_at).getTime() - LOOK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (Number.isNaN(since.getTime())) return false;
  try {
    const row = await scopeToAssessmentBookings(
      conn('scheduled_services')
        .leftJoin('services', 'services.id', 'scheduled_services.service_id')
        .where('scheduled_services.customer_id', estimate.customer_id)
        .where('scheduled_services.status', 'completed')
        .whereRaw("COALESCE(scheduled_services.completed_at, scheduled_services.scheduled_date::timestamp AT TIME ZONE 'America/New_York') >= ?", [since]),
    ).first('scheduled_services.id');
    return Boolean(row);
  } catch (err) {
    logger.warn(`[assessment-booking] completed-assessment check skipped for estimate ${estimate.id}: ${err.code || err.name || 'error'}`);
    return false;
  }
}

module.exports = {
  hadCompletedAssessmentLook,
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
