/**
 * Canonical recurring-lineage test (pay-v2.js): a series "booster" visit
 * deliberately carries is_recurring=false with recurring_parent_id set — a
 * bare is_recurring check admits it as one-time. Extracted from
 * estimate-card-holds.js (r3 P1) so other callers (visit-prep.js) share the
 * exact same predicate instead of re-deriving it.
 */
function isRecurringLineageVisit(v) {
  return !!(v && (v.is_recurring === true || v.recurring_parent_id || v.recurring_pattern));
}

module.exports = { isRecurringLineageVisit };
