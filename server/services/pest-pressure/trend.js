/**
 * Resolve a trend state from the current score, a previous score, and the
 * configured thresholds. Pure function — caller supplies thresholds, no
 * config loaded here.
 *
 * Returned states:
 *   first_marker          — no prior score
 *   improving             — delta <= improvingAtOrBelow (negative)
 *                           OR delta is negative and |delta| > stableBand
 *   stable                — |delta| <= stableBand
 *   increasing            — delta >= increasingFrom
 *                           OR delta is positive and delta > stableBand
 *   significant_increase  — delta >= significantIncreaseFrom
 *
 * Decision order matters: the explicit `improvingAtOrBelow` /
 * `increasingFrom` / `significantIncreaseFrom` thresholds win when the
 * delta is unambiguously in their band. When the delta lands in the
 * gap between `stableBand` and the next directional threshold (e.g.,
 * default config: stableBand=0.4 and increasingFrom=0.5 leaves a gap on
 * (0.4, 0.5)), it falls into improving / increasing by sign rather than
 * being silently bucketed as `stable` — which would ignore the
 * configured stable-band entirely.
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

  // Strongest signals first.
  if (delta <= thresholds.improvingAtOrBelow) {
    return { trend: 'improving', delta };
  }
  if (delta >= thresholds.significantIncreaseFrom) {
    return { trend: 'significant_increase', delta };
  }
  if (delta >= thresholds.increasingFrom) {
    return { trend: 'increasing', delta };
  }

  // Inside the stable band → stable. This is the only place `stableBand`
  // is consulted; before this fix it was never read at all, so a delta
  // of (e.g.) 0.45 with stableBand=0.2 was reported as 'stable'.
  if (Math.abs(delta) <= thresholds.stableBand) {
    return { trend: 'stable', delta };
  }

  // Gap zone: between `stableBand` and the next directional threshold.
  // Classify by sign so a moving-but-not-quite-at-threshold delta isn't
  // silently flattened into 'stable'.
  return { trend: delta < 0 ? 'improving' : 'increasing', delta };
}

module.exports = { resolveTrend, VALID_TRENDS };
