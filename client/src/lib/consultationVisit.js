// Client mirror of server/services/assessment-booking.js isAssessmentBooking:
// a Waves Assessment (consultation) visit is the `lawn_inspection` catalog
// key, or the denormalized "Waves Assessment" name. The server re-checks on
// every outcome write (409 NOT_CONSULTATION), so this only decides whether
// the Outcome action renders.
const ASSESSMENT_SERVICE_KEY = 'lawn_inspection';
const ASSESSMENT_NAME_RE = /^waves assessment$/i;

// Visits that never happened — the server refuses an outcome on them
// (consultation-outcomes.js DEAD_CONSULTATION_STATUSES).
const DEAD_CONSULTATION_STATUSES = new Set(['no_show', 'cancelled', 'skipped', 'rescheduled']);

export function isConsultationVisit(service) {
  if (!service) return false;
  if (service.completionProfile?.serviceKey === ASSESSMENT_SERVICE_KEY) return true;
  const name = String(service.serviceType || service.service_type || '').trim();
  return ASSESSMENT_NAME_RE.test(name);
}

export function canRecordConsultationOutcome(service) {
  return isConsultationVisit(service)
    && !DEAD_CONSULTATION_STATUSES.has(String(service.status || '').toLowerCase());
}
