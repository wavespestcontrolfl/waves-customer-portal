/**
 * Resolve a 0–5 score to a label row from the configured label scheme.
 *
 * Label ranges are validated upstream by validateConfig() to cover [0, 5]
 * with no gaps or overlaps. If a score arrives outside any range (config
 * drift, programming error), fall back to the closest band rather than
 * crashing the report render.
 */

function resolveLabel(score, labels) {
  if (score === null || score === undefined || !Array.isArray(labels) || labels.length === 0) {
    return null;
  }
  const sorted = labels.slice().sort((a, b) => a.min - b.min);
  for (const row of sorted) {
    if (score >= row.min && score <= row.max) {
      return { key: row.key, name: row.name, description: row.description };
    }
  }
  // Nearest band — a score in the sliver between two bands (e.g. 0.45
  // between 0.4 and 0.5) lands next to its neighbours, never at the top.
  let row = sorted[0];
  let best = Infinity;
  for (const candidate of sorted) {
    const distance = score < candidate.min ? candidate.min - score : score - candidate.max;
    if (distance < best) {
      best = distance;
      row = candidate;
    }
  }
  return { key: row.key, name: row.name, description: row.description };
}

// Lower-case label names for the integer ratings 0..5 against a label set
// (active config), e.g. ['none', 'very low', …, 'high'] — what AI copy
// prompts call each rating so they match the gauge. Missing labels fall back
// to the caller-supplied default names.
const DEFAULT_ACTIVITY_SCALE = Object.freeze(['none', 'very low', 'low', 'moderate', 'elevated', 'high']);

function activityScaleNames(labels) {
  return [0, 1, 2, 3, 4, 5].map((n) => {
    const name = resolveLabel(n, labels)?.name;
    return typeof name === 'string' && name.trim() ? name.trim().toLowerCase() : DEFAULT_ACTIVITY_SCALE[n];
  });
}

module.exports = { resolveLabel, activityScaleNames, DEFAULT_ACTIVITY_SCALE };
