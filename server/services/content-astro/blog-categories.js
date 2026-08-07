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

module.exports = { POST_CATEGORIES };
