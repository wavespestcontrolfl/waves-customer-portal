/**
 * What a rain day move would do to the visit's plan, and the visit spans old records lack, for the schedule rain record
 * (record only; nothing here moves or writes a visit). Owner 2026-11-26: a rain-out move of a recurring visit shifts the
 * WHOLE PLAN (setting default whole_plan); any other visit moves alone. A lawn round moved 7 days or less inside its round
 * stays one visit (lawn-rounds.js datesMoveSeries, the rule the rebooker and rain-out use).
 */
const { datesMoveSeries } = require('../lawn-rounds');
const { dateOnlyString } = require('../../utils/date-only');

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * The recurrence columns datesMoveSeries reads, for the given service ids, keyed by id. A failed read THROWS, marked
 * `planning`: a plan scope is never guessed, so the run stops and nothing freezes (the retry decides again), the way an
 * unreadable closure list does.
 */
async function loadSeriesRows(conn, ids) {
  try {
    const rows = await conn('scheduled_services').whereIn('id', ids)
      .select('id', 'is_recurring', 'scheduled_date', 'recurring_pattern', 'date_exception', 'date_exception_cadence_date');
    return new Map(rows.map((r) => [String(r.id), r]));
  } catch (err) {
    err.planning = true;
    throw err;
  }
}

/**
 * What a day move of this stop does to the plans it holds. A grouped stop has several services (`visit.memberIds`), each
 * with its own plan: `{ plan_moves, plan_moves_by_service? }`. Per service: 'whole_plan' (recurring, and the move shifts
 * the plan), 'one_visit', or 'unknown' (no recurrence row for it). plan_moves is 'whole_plan' when any service is,
 * else 'unknown' when any is, else 'one_visit'. `series` is the map from loadSeriesRows.
 */
function planMovesOf(visit, series, toDate) {
  const ids = visit.memberIds?.length ? visit.memberIds.map(String) : [String(visit.id)];
  const byService = {};
  for (const id of ids) {
    const full = series?.get(id);
    if (!full) byService[id] = 'unknown';
    else if (full.is_recurring !== true) byService[id] = 'one_visit';
    else byService[id] = datesMoveSeries(full, full.scheduled_date, toDate) ? 'whole_plan' : 'one_visit';
  }
  const values = Object.values(byService);
  let plan_moves = 'one_visit';
  if (values.includes('whole_plan')) plan_moves = 'whole_plan';
  else if (values.includes('unknown')) plan_moves = 'unknown';
  return ids.length > 1 ? { plan_moves, plan_moves_by_service: byService } : { plan_moves };
}

/**
 * The stored span of visits an old record kept without one: id -> { date, start, end }, in ET minutes. `end` is the
 * visit's window_end, else its start plus estimated_duration_minutes, else null (the span is unknown). A failed read
 * throws: the score is retried, never graded on a guess.
 */
async function loadVisitSpans(conn, ids) {
  const rows = await conn('scheduled_services').whereIn('id', ids)
    .select('id', 'scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes');
  return new Map(rows.map((r) => {
    const start = toMin(r.window_start);
    const windowEnd = toMin(r.window_end);
    const minutes = Number(r.estimated_duration_minutes);
    let end = null;
    if (start != null && windowEnd != null && windowEnd > start) end = windowEnd;
    else if (start != null && Number.isFinite(minutes) && minutes > 0) end = start + minutes;
    return [String(r.id), { date: String(dateOnlyString(r.scheduled_date) || ''), start, end }];
  }));
}

module.exports = { loadSeriesRows, planMovesOf, loadVisitSpans };
