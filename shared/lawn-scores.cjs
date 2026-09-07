'use strict';

function lawnScoreValue(value) {
  // A not-scored category arrives from the DB as NULL (JS null) or '' — guard
  // before Number(), because Number(null) and Number('') are both 0, which would
  // make a missing category masquerade as a real score of 0 (dragging the
  // overall down and fabricating before/after deltas).
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

// Consolidated Stress/Damage for the customer view. New rows store it directly;
// pre-stress_damage rows fall back to the worst of the two legacy signals
// (fungus_control, thatch_level) so historical reports still render a value.
function resolveStressDamage(row = {}) {
  const explicit = lawnScoreValue(row.stress_damage);
  if (explicit != null) return explicit;
  const fungus = lawnScoreValue(row.fungus_control);
  const thatch = lawnScoreValue(row.thatch_level);
  if (fungus == null && thatch == null) return null;
  return Math.min(fungus ?? 100, thatch ?? 100);
}

function calculateLawnOverallScore(row = {}) {
  const explicit = lawnScoreValue(row.overall_score);
  // Trust a stored overall only when it was computed under the four-category
  // model (rows that have stress_damage). Legacy rows keep an overall from the
  // old five-signal weighting, so recompute them to match the four displayed
  // bars (Density/Weed/Color/Stress) instead of hidden fungus/thatch weights.
  // lawnScoreValue (not a raw null-check): a legacy '' stress_damage is
  // "not scored" and must recompute too.
  if (explicit != null && lawnScoreValue(row.stress_damage) != null) return explicit;
  // Weighted average of the four displayed categories, null-aware: a category
  // that wasn't scored is excluded and the weights are renormalized over the
  // ones present, so a missing category doesn't count as 0 and drag the overall
  // down. When all four are present this is the plain 30/25/25/20 average.
  const components = [
    [lawnScoreValue(row.turf_density), 0.30],
    [lawnScoreValue(row.weed_suppression), 0.25],
    [lawnScoreValue(row.color_health), 0.25],
    [resolveStressDamage(row), 0.20],
  ].filter(([value]) => value != null);
  if (!components.length) return null;
  const totalWeight = components.reduce((sum, [, weight]) => sum + weight, 0);
  const weighted = components.reduce((sum, [value, weight]) => sum + (value * weight), 0);
  return Math.round(weighted / totalWeight);
}

module.exports = { lawnScoreValue, resolveStressDamage, calculateLawnOverallScore };
