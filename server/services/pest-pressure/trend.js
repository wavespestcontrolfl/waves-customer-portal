/**
 * Resolve a trend state from the current score, a previous score, and the
 * configured thresholds. Pure function — caller supplies thresholds, no
 * config loaded here.
 *
 * Returned states:
 *   first_marker          — no prior score
 *   improving             — delta <= improvingAtOrBelow (negative)
 *   stable                — delta within +/- stableBand of zero
 *   increasing            — delta >= increasingFrom
 *   significant_increase  — delta >= significantIncreaseFrom
 *
 * Thresholds are checked in this order so the most extreme bucket wins
 * if ranges abut.
 */

const VALID_TRENDS = Object.freeze([
  'first_marker',
  'improving',
  'stable',
  'increasing',
  'significant_increase',
  'insufficient_data',
]);

function roundDelta(value) {
  return Math.round(value * 10) / 10;
}

function resolveTrend(score, previousScore, thresholds) {
  if (score === null || score === undefined) {
    return { trend: 'insufficient_data', delta: null };
  }
  if (previousScore === null || previousScore === undefined) {
    return { trend: 'first_marker', delta: null };
  }
  const delta = roundDelta(Number(score) - Number(previousScore));
  if (delta <= thresholds.improvingAtOrBelow) {
    return { trend: 'improving', delta };
  }
  if (delta >= thresholds.significantIncreaseFrom) {
    return { trend: 'significant_increase', delta };
  }
  if (delta >= thresholds.increasingFrom) {
    return { trend: 'increasing', delta };
  }
  return { trend: 'stable', delta };
}

module.exports = { resolveTrend, VALID_TRENDS };
