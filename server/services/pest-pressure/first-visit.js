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

// The history a first visit is judged against, as a filter on a
// service_records query aliased `alias`: completed, customer-visible,
// performed visits on the given line — legacy rows with no service_line
// count too, the same fallback Pest Pressure's own history lookup uses
// (orchestrate.js). `serviceLine` is a value; `serviceLineColumn` correlates
// with an outer row's line instead. One definition, shared by
// customerHasPriorVisitOnLine and the email-division activity averages'
// reconstruction of pre-flag defaults (owner ruling 2026-09-29).
function applyPerformedVisitHistoryFilter(query, { alias = 'service_records', serviceLine = null, serviceLineColumn = null } = {}) {
  query.where(`${alias}.status`, 'completed');
  applyCustomerVisibleServiceRecordFilter(query, { alias });
  query.whereRaw(
    `COALESCE(${alias}.structured_notes->>'visitOutcome', '') NOT IN (${NON_PERFORMED_VISIT_OUTCOMES.map(() => '?').join(', ')})`,
    NON_PERFORMED_VISIT_OUTCOMES,
  );
  if (serviceLine || serviceLineColumn) {
    query.where(function priorServiceLine() {
      if (serviceLineColumn) this.whereColumn(`${alias}.service_line`, serviceLineColumn);
      else this.where(`${alias}.service_line`, serviceLine);
      this.orWhereNull(`${alias}.service_line`);
    });
  }
  return query;
}

// A missing customer never reads as new.
async function customerHasPriorVisitOnLine(knex, { customerId, serviceLine, excludeServiceRecordId = null }) {
  if (!customerId) return true;
  const query = knex('service_records').where('customer_id', customerId);
  applyPerformedVisitHistoryFilter(query, { serviceLine });
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

// Serialized re-check for a completion that is about to record the
// first-visit default: inside the completion transaction, take a
// customer/service-line advisory lock (held to commit) and re-read history,
// so two first visits completing at the same instant can't both default —
// the second waits for the first to commit and then sees its record.
async function confirmFirstVisitUnderLock(trx, { customerId, serviceLine }) {
  if (!customerId) return false;
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', [
    'pest-first-visit',
    `${customerId}:${serviceLine || ''}`,
  ]);
  return !(await customerHasPriorVisitOnLine(trx, { customerId, serviceLine }));
}

module.exports = {
  applyPerformedVisitHistoryFilter,
  FIRST_VISIT_DEFAULT_RATING,
  NON_PERFORMED_VISIT_OUTCOMES,
  isPerformedVisitOutcome,
  customerHasPriorVisitOnLine,
  confirmFirstVisitUnderLock,
  firstVisitDefaultRating,
};
