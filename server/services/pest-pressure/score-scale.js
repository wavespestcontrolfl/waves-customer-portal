/**
 * Which scale a stored Pest Pressure reading was recorded on.
 *
 * #4741 (merged 2026-09-24) made the technician's 0-5 tap the score exactly
 * (tap 3 -> 3.0); before, the tap was blended with zeros (tap 3 -> 0.9). No
 * past score was recalculated, so stored scores sit on two scales that must
 * never be compared (a June 0.9 next to a September 3.0 is the same rating,
 * not "pressure increased"). Used by the report trend/chart
 * (service-report/pressure-trend.js) and by the gauge's previous-score lookup
 * (store.js loadPreviousScore).
 *
 * Per-record marker: pest_pressure_scores.component_scores carries the
 * technicianActivityRating component (scoreSource 'technician_rating').
 * TECH_RATING_CUTOVER_AT is the fallback only when the marker cannot be read
 * (no score row, or a failed lookup): 2026-09-24 00:00 America/New_York
 * (EDT, UTC-4).
 */

const { scoreSourceFromComponents } = require('./calculate');

const SCALE_TECHNICIAN_RATING = 'technician_rating';
const SCALE_BLENDED = 'blended';
const TECH_RATING_CUTOVER_AT = Date.parse('2026-09-24T04:00:00Z');

function scaleFromComponentScores(componentScores) {
  return scoreSourceFromComponents(componentScores) === 'technician_rating'
    ? SCALE_TECHNICIAN_RATING
    : SCALE_BLENDED;
}

// `at` is the visit instant (Date/ISO string/ms) for the cutover fallback.
function scaleFromCutoverDate(at) {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(ms) && ms >= TECH_RATING_CUTOVER_AT
    ? SCALE_TECHNICIAN_RATING
    : SCALE_BLENDED;
}

// Marker when the score row's components are readable, cutover date otherwise.
function classifyScoreScale({ componentScores, at }) {
  if (componentScores !== null && componentScores !== undefined) {
    return scaleFromComponentScores(componentScores);
  }
  return scaleFromCutoverDate(at);
}

// The instant a visit row is dated for the cutover fallback: a real timestamp
// when there is one, else the date-only service_date anchored at noon UTC (so
// a 2026-09-24 visit is never rolled back across midnight).
function visitInstant(row) {
  for (const value of [row?.started_at, row?.ended_at]) {
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  const date = row?.service_date;
  const ymd = date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : /^\d{4}-\d{2}-\d{2}/.exec(String(date || ''))?.[0];
  if (ymd) return new Date(`${ymd}T12:00:00Z`);
  return row?.created_at || null;
}

// Which scale each visit's stored score was recorded on, from the score row's
// provenance. Best-effort: a failed lookup leaves the map empty and callers
// fall back to the cutover date (scaleForVisit).
async function loadScaleMap(knex, serviceRecordIds) {
  const scales = new Map();
  const ids = [...new Set((serviceRecordIds || []).filter(Boolean).map(String))];
  if (!ids.length) return scales;
  const scoreRows = await knex('pest_pressure_scores')
    .whereIn('service_record_id', ids)
    .select('service_record_id', 'component_scores')
    .catch(() => []);
  for (const row of Array.isArray(scoreRows) ? scoreRows : []) {
    scales.set(String(row.service_record_id), scaleFromComponentScores(row.component_scores));
  }
  return scales;
}

function scaleForVisit(scaleMap, row) {
  const known = scaleMap?.get(String(row?.id));
  return known || scaleFromCutoverDate(visitInstant(row));
}

module.exports = {
  visitInstant,
  loadScaleMap,
  scaleForVisit,
  SCALE_TECHNICIAN_RATING,
  SCALE_BLENDED,
  TECH_RATING_CUTOVER_AT,
  scaleFromComponentScores,
  scaleFromCutoverDate,
  classifyScoreScale,
};
