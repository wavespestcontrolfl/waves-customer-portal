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

module.exports = {
  SCALE_TECHNICIAN_RATING,
  SCALE_BLENDED,
  TECH_RATING_CUTOVER_AT,
  scaleFromComponentScores,
  scaleFromCutoverDate,
  classifyScoreScale,
};
