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
  ASSESSMENT_NAME_RE,
  ASSESSMENT_SERVICE_KEY,
  isAssessmentServiceType,
  isAssessmentServiceRow,
  isAssessmentBooking,
};
