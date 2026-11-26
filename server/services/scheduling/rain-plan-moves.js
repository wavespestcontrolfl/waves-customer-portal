/**
 * What a rain day move would do to the visit's plan, for the schedule rain record (record only; nothing here moves a visit).
 * Owner 2026-11-26: a rain-out move of a recurring visit shifts the WHOLE PLAN (setting default whole_plan); any other
 * visit moves alone. A lawn round moved 7 days or less inside its round stays one visit (lawn-rounds.js datesMoveSeries,
 * the rule the rebooker and rain-out use).
 */
const logger = require('../logger');
const { datesMoveSeries } = require('../lawn-rounds');

/** The recurrence columns datesMoveSeries reads, for the given visit ids, keyed by id. A failed read gives an empty map. */
async function loadSeriesRows(conn, ids) {
  const out = new Map();
  try {
    const rows = await conn('scheduled_services').whereIn('id', ids)
      .select('id', 'scheduled_date', 'recurring_pattern', 'date_exception', 'date_exception_cadence_date');
    for (const r of rows) out.set(String(r.id), r);
  } catch (err) {
    logger.warn(`[schedule-rain-record] recurrence read failed: ${err.message}`);
  }
  return out;
}

/** 'whole_plan' | 'one_visit'. `series`: the map from loadSeriesRows; a recurring visit missing from it is whole_plan. */
function planMovesOf(visit, series, toDate) {
  if (!visit.is_recurring) return 'one_visit';
  const full = series?.get(String(visit.id));
  return full && !datesMoveSeries(full, full.scheduled_date, toDate) ? 'one_visit' : 'whole_plan';
}

module.exports = { loadSeriesRows, planMovesOf };
