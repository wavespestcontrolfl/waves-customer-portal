/**
 * First-visit detection for the technician Pest Pressure rating (owner
 * ruling 2026-09-24): a customer's first visit on a service line starts the
 * rating at 5. Shared by the picker gate (admin-dispatch
 * tech-rating-allowed) and the completion write so both agree.
 */

const { applyCustomerVisibleServiceRecordFilter } = require('./history-filter');

const FIRST_VISIT_DEFAULT_RATING = 5;

// Outcomes where nothing was performed — the same set the recap flow uses
// (pest-recap.js) and the completion flow's visitPerformed/incomplete split.
// Such a visit neither gets the default nor counts as a prior visit.
const NON_PERFORMED_VISIT_OUTCOMES = Object.freeze(['inspection_only', 'customer_declined', 'incomplete']);

function isPerformedVisitOutcome(visitOutcome) {
  return !NON_PERFORMED_VISIT_OUTCOMES.includes(String(visitOutcome || 'completed'));
}

// Completed, customer-visible visits on this line. Legacy rows with no
// service_line count too — the same fallback Pest Pressure's own history
// lookup uses (orchestrate.js). A missing customer never reads as new.
async function customerHasPriorVisitOnLine(knex, { customerId, serviceLine, excludeServiceRecordId = null }) {
  if (!customerId) return true;
  const query = knex('service_records')
    .where('customer_id', customerId)
    .where('status', 'completed');
  applyCustomerVisibleServiceRecordFilter(query);
  query.whereRaw(
    `COALESCE(service_records.structured_notes->>'visitOutcome', '') NOT IN (${NON_PERFORMED_VISIT_OUTCOMES.map(() => '?').join(', ')})`,
    NON_PERFORMED_VISIT_OUTCOMES,
  );
  if (serviceLine) {
    query.where(function priorServiceLine() {
      this.where('service_line', serviceLine).orWhereNull('service_line');
    });
  }
  if (excludeServiceRecordId) query.whereNot('id', excludeServiceRecordId);
  return Boolean(await query.first('id'));
}

// The rating a completion should record. A rating the tech chose always
// wins. Otherwise — no rating, or the picker's untouched first-visit 5
// (re-checked here: another visit may have completed since the form opened)
// — it is the first-visit 5 unless the tech explicitly cleared it, nothing
// was performed, the rating isn't allowed, or this isn't the first performed
// visit. Callers pass the config gate so this module stays free of
// store/config imports.
async function firstVisitDefaultRating({
  knex,
  clientPestRating = null,
  clientPestRatingCleared = false,
  clientPestRatingPrefilled = false,
  visitOutcome = 'completed',
  completionAllowsRating = false,
  configAllowsRating = async () => false,
  customerId = null,
  serviceLine = null,
} = {}) {
  const untouchedPrefill = clientPestRatingPrefilled === true && clientPestRating === FIRST_VISIT_DEFAULT_RATING;
  if (clientPestRating != null && !untouchedPrefill) return clientPestRating;
  if (clientPestRatingCleared === true || !isPerformedVisitOutcome(visitOutcome) || !completionAllowsRating) return null;
  if (!(await configAllowsRating())) return null;
  if (await customerHasPriorVisitOnLine(knex, { customerId, serviceLine })) return null;
  return FIRST_VISIT_DEFAULT_RATING;
}

module.exports = {
  FIRST_VISIT_DEFAULT_RATING,
  NON_PERFORMED_VISIT_OUTCOMES,
  isPerformedVisitOutcome,
  customerHasPriorVisitOnLine,
  firstVisitDefaultRating,
};
