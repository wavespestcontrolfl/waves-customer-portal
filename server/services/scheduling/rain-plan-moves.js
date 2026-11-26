/**
 * What a rain day move would do to the visit's plan, for the schedule rain record (record only; nothing here moves a visit).
 * Owner 2026-11-26: a rain-out move of a recurring visit shifts the WHOLE PLAN (setting default whole_plan); any other
 * visit moves alone. A lawn round moved 7 days or less inside its round stays one visit (lawn-rounds.js datesMoveSeries,
 * the rule the rebooker and rain-out use).
 */
const logger = require('../logger');
const { datesMoveSeries } = require('../lawn-rounds');

/** The recurrence columns datesMoveSeries reads, for the given service ids, keyed by id. A failed read gives an empty map. */
async function loadSeriesRows(conn, ids) {
  const out = new Map();
  try {
    const rows = await conn('scheduled_services').whereIn('id', ids)
      .select('id', 'is_recurring', 'scheduled_date', 'recurring_pattern', 'date_exception', 'date_exception_cadence_date');
    for (const r of rows) out.set(String(r.id), r);
  } catch (err) {
    logger.warn(`[schedule-rain-record] recurrence read failed: ${err.message}`);
  }
  return out;
}

/**
 * What a day move of this stop does to the plans it holds. A grouped stop has several services (`visit.memberIds`), each
 * with its own plan: `{ plan_moves, plan_moves_by_service? }`. plan_moves is 'whole_plan' when ANY service is recurring and
 * its move shifts the plan, else 'one_visit'; the per-service map is kept for a grouped stop. `series` is the map from
 * loadSeriesRows; a service missing from it is whole_plan (unknown is never one_visit), except the anchor, which is
 * known from the stop's own row.
 */
function planMovesOf(visit, series, toDate) {
  const ids = visit.memberIds?.length ? visit.memberIds.map(String) : [String(visit.id)];
  const byService = {};
  for (const id of ids) {
    const full = series?.get(id);
    if (!full) byService[id] = id === String(visit.id) && !visit.is_recurring ? 'one_visit' : 'whole_plan';
    else if (full.is_recurring !== true) byService[id] = 'one_visit';
    else byService[id] = datesMoveSeries(full, full.scheduled_date, toDate) ? 'whole_plan' : 'one_visit';
  }
  const plan_moves = Object.values(byService).includes('whole_plan') ? 'whole_plan' : 'one_visit';
  return ids.length > 1 ? { plan_moves, plan_moves_by_service: byService } : { plan_moves };
}

module.exports = { loadSeriesRows, planMovesOf };
