/**
 * blog-categories.js — the canonical blog post category set.
 *
 * These are the ONLY category values the publisher preserves verbatim;
 * normalizeAutonomousCategory rewrites anything else to an inferred
 * fallback. Split into a dependency-free module on purpose: the autonomous
 * runner's operator slug repair validates pinned routes against this same
 * set (a pin category outside it would be rewritten at publish time and
 * change the route), and that check must not drag in the publisher's full
 * module graph.
 */
const POST_CATEGORIES = new Set(['pest-control', 'lawn-care', 'termite', 'mosquito', 'tree-shrub', 'seasonal']);

// The LEAF (final path segment) of a slug, path, or absolute URL — the unit
// the publisher's canonical guard compares. Lives here (not in the
// publisher) because the runner's slug repair gates canonical rewrites on
// the same comparison and must not maintain a second definition.
function slugLeafOf(value) {
  return String(value || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .pop() || '';
}

module.exports = { POST_CATEGORIES, slugLeafOf };
