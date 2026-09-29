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
 * Customer-submitted ratings stay blended after the cutover, so BOTH scales
 * exist after it: comparability is per-row provenance, never a date. The
 * cutover (2026-09-24 00:00 America/New_York, EDT UTC-4) only proves that a
 * reading with no score row is blended when it predates it; after it such a
 * reading is 'unknown' and fails closed.
 */

const { scoreSourceFromComponents } = require('./calculate');

const SCALE_TECHNICIAN_RATING = 'technician_rating';
const SCALE_BLENDED = 'blended';
// Provenance could not be established (a post-cutover reading with no readable
// score row, or a failed lookup). Comparable to nothing, not even another
// unknown: callers must make no up/down claim from it.
const SCALE_UNKNOWN = 'unknown';
const TECH_RATING_CUTOVER_AT = Date.parse('2026-09-24T04:00:00Z');
const TECH_RATING_CUTOVER_DATE = '2026-09-24'; // the same day, as a calendar date (ET)

function scaleFromComponentScores(componentScores) {
  return scoreSourceFromComponents(componentScores) === 'technician_rating'
    ? SCALE_TECHNICIAN_RATING
    : SCALE_BLENDED;
}

// Fallback ONLY when a reading has no readable score row. Before the cutover
// direct scoring did not exist, so every such reading is blended. After it,
// customer-submitted ratings are still blended while technician taps are
// direct, so a post-cutover reading without provenance is unknown - never
// guessed from its date. `at` is the visit instant (Date/ISO string/ms).
function scaleWithoutProvenance(at) {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(ms) && ms < TECH_RATING_CUTOVER_AT ? SCALE_BLENDED : SCALE_UNKNOWN;
}

// The one comparability rule: same known scale. Two unknowns are not comparable.
function isComparable(a, b) {
  return Boolean(a) && a === b && a !== SCALE_UNKNOWN;
}

// Marker when the score row's components are readable, else the fallback above.
function classifyScoreScale({ componentScores, at }) {
  if (componentScores !== null && componentScores !== undefined) {
    return scaleFromComponentScores(componentScores);
  }
  return scaleWithoutProvenance(at);
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
// provenance. A failed lookup leaves the map empty, which FAILS CLOSED: pre-
// cutover visits are still blended by date, post-cutover ones are unknown
// (scaleForVisit), so an outage never turns into an up/down claim.
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
  return known || scaleWithoutProvenance(visitInstant(row));
}

module.exports = {
  visitInstant,
  loadScaleMap,
  scaleForVisit,
  SCALE_TECHNICIAN_RATING,
  SCALE_BLENDED,
  SCALE_UNKNOWN,
  TECH_RATING_CUTOVER_AT,
  TECH_RATING_CUTOVER_DATE,
  scaleFromComponentScores,
  scaleWithoutProvenance,
  isComparable,
  classifyScoreScale,
};
