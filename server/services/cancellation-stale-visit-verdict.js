'use strict';

/**
 * Owner 2026-10-30 (#7129): a visit stuck "on site" from an EARLIER day (a
 * tech never closed it out) must not downgrade the customer's cancellation
 * confirmation. The processor still flags it (`in_progress_visit:<id>`), and
 * the office review bell, the open ticket and the open case still stand, so
 * the office closes the visit out. But the plan itself has stopped, so the
 * customer hears "your plan is cancelled", not "a team member will confirm".
 *
 * True only when the run wound the plan down (churned, or the scoped families
 * pulled) AND every error in `errors` is such a stale-visit flag. An empty
 * list is false: a clean run is the caller's own verdict. A visit live TODAY,
 * or any other error, stays false.
 *
 * Shared by the admin Cancel plan path (services/admin-cancellation.js) and
 * the portal self-cancel (routes/requests.js) so the two can never drift.
 *
 * @param {object} result  processCancellationRequest's result
 * @param {string[]} [errors]  the caller's full error list (the admin path
 *   adds its own steps' errors); defaults to the processor's errors
 */
function onlyStaleVisitErrorsLeft(result, errors = result && result.errors) {
  if (!result || !(result.churned || result.scopedWoundDown)) return false;
  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) return false;
  const staleIds = Array.isArray(result.staleInProgressVisitIds) ? result.staleInProgressVisitIds : [];
  const stale = new Set(staleIds.map((id) => `in_progress_visit:${id}`));
  return list.every((e) => stale.has(e));
}

module.exports = { onlyStaleVisitErrorsLeft };
