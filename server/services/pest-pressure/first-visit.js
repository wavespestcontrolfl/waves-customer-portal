/**
 * First-visit detection for the technician Pest Pressure rating (owner
 * ruling 2026-09-24): a customer's first visit on a service line starts the
 * rating at 5. Shared by the picker gate (admin-dispatch
 * tech-rating-allowed) and the completion write so both agree.
 */

const { applyCustomerVisibleServiceRecordFilter } = require('./history-filter');

const FIRST_VISIT_DEFAULT_RATING = 5;

// Completed, customer-visible visits on this line. Legacy rows with no
// service_line count too — the same fallback Pest Pressure's own history
// lookup uses (orchestrate.js). A missing customer never reads as new.
async function customerHasPriorVisitOnLine(knex, { customerId, serviceLine, excludeServiceRecordId = null }) {
  if (!customerId) return true;
  const query = knex('service_records')
    .where('customer_id', customerId)
    .where('status', 'completed');
  applyCustomerVisibleServiceRecordFilter(query);
  if (serviceLine) {
    query.where(function priorServiceLine() {
      this.where('service_line', serviceLine).orWhereNull('service_line');
    });
  }
  if (excludeServiceRecordId) query.whereNot('id', excludeServiceRecordId);
  return Boolean(await query.first('id'));
}

// The rating a completion should record when the request carried none:
// the first-visit 5 unless the tech explicitly cleared it, the visit wasn't
// performed, or the rating isn't allowed for this completion/line. Callers
// pass the config gate so this module stays free of store/config imports.
async function firstVisitDefaultRating({
  knex,
  clientPestRating = null,
  clientPestRatingCleared = false,
  visitOutcome = 'completed',
  completionAllowsRating = false,
  configAllowsRating = async () => false,
  customerId = null,
  serviceLine = null,
} = {}) {
  if (clientPestRating != null) return clientPestRating;
  if (clientPestRatingCleared === true || visitOutcome !== 'completed' || !completionAllowsRating) return null;
  if (!(await configAllowsRating())) return null;
  if (await customerHasPriorVisitOnLine(knex, { customerId, serviceLine })) return null;
  return FIRST_VISIT_DEFAULT_RATING;
}

module.exports = { FIRST_VISIT_DEFAULT_RATING, customerHasPriorVisitOnLine, firstVisitDefaultRating };
