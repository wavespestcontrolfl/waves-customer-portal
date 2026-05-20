/**
 * Re-service / callback impact extractor.
 *
 * Counts completed callback visits for this customer within the review
 * window, excluding the current service report itself. Spec mapping:
 *
 *   0 callbacks    → 0
 *   1 callback     → 3   (one confirmed pest-related re-service)
 *   2 callbacks    → 4
 *   3+ callbacks   → 5
 *
 * "Minor re-service" (spec value 2) is reserved for a future enhancement
 * that classifies callbacks by severity. For Phase 1, every completed
 * pest-related callback in the window counts as a confirmed re-service.
 *
 * Excluded statuses (per spec):
 *   - cancelled
 *   - rescheduled (administrative reschedules don't represent pressure)
 *   - pending / confirmed (not yet performed)
 *
 * "Non-pest-related" exclusion: Waves tags callbacks via is_callback on
 * scheduled_services and service_records. The default scope is pest. A
 * caller that wants to count only a specific service_line passes it in
 * via `serviceLine`.
 */

const EXCLUDED_REASONS = new Set([
  'administrative_reschedule',
  'no_show',
  'cancelled',
]);

function mapCountToRating(count) {
  if (count <= 0) return 0;
  if (count === 1) return 3;
  if (count === 2) return 4;
  return 5;
}

async function extractReServiceImpact({ knex, customerId, serviceRecordId, reviewPeriodStart, reviewPeriodEnd, serviceLine = null }) {
  if (!knex || !customerId || !reviewPeriodStart || !reviewPeriodEnd) {
    throw new TypeError('extractReServiceImpact: knex, customerId, reviewPeriodStart, reviewPeriodEnd are required');
  }

  const query = knex('service_records')
    .where('customer_id', customerId)
    .where('status', 'completed')
    .where('is_callback', true)
    .whereBetween('service_date', [reviewPeriodStart, reviewPeriodEnd]);

  if (serviceRecordId) {
    query.whereNot('id', serviceRecordId);
  }
  if (serviceLine) {
    query.where('service_line', serviceLine);
  }

  const rows = await query.select('id', 'service_date', 'service_type', 'cancellation_reason');

  const qualifying = rows.filter((r) => {
    const reason = (r.cancellation_reason || '').toLowerCase();
    return !EXCLUDED_REASONS.has(reason);
  });

  const value = mapCountToRating(qualifying.length);

  return {
    value,
    present: true,
    source: 'callback_history',
    count: qualifying.length,
    rawCount: rows.length,
  };
}

module.exports = {
  extractReServiceImpact,
  mapCountToRating,
  EXCLUDED_REASONS,
};
