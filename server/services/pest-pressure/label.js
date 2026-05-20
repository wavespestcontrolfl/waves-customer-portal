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
  if (score < sorted[0].min) {
    const row = sorted[0];
    return { key: row.key, name: row.name, description: row.description };
  }
  const row = sorted[sorted.length - 1];
  return { key: row.key, name: row.name, description: row.description };
}

module.exports = { resolveLabel };
