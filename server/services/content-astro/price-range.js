/**
 * price-range.js — the deterministic `price_range` frontmatter for cost-guide
 * blog posts.
 *
 * Owner decision D1 (2026-09-27): cost guides show the "Typical Price Range"
 * card. Owner 2026-09-28: cost guides must carry it out of the autonomous
 * pipeline with no manual step. The Astro hub build renders the card from
 * `price_range` service keys against the portal's public pricing feed
 * (GET /api/public/pricing-ranges, pricing-engine/public-ranges.js), and the
 * Astro build FAILS on a key it does not know. So:
 *   - a post is a cost guide when its post_type is "cost" (the writer's
 *     binding post-type rubric: "cost" = pricing-focused; the Astro schema
 *     already enforces that type's required components);
 *   - the keys come from the table below only — the writer model never
 *     chooses them, and a model-emitted price_range never reaches the
 *     published frontmatter (the autonomous normalizer whitelists fields);
 *   - every key is checked against the feed's own current key set, and a key
 *     the feed does not publish is dropped. No valid key → no price_range:
 *     fail closed to "no card", never to a broken hub build.
 * The post body stays free of dollar figures (HARDCODED_PRICE is unchanged);
 * the card's numbers come from the feed at Astro build time.
 */
const { computePublicPricingRanges } = require('../pricing-engine/public-ranges');
const logger = require('../logger');

const TERMITE = ['termite_bait_install', 'termite_bait_monitoring', 'termite_trenching'];
const MOSQUITO = ['mosquito_program', 'one_time_mosquito'];
const LAWN = ['lawn_care_program', 'one_time_lawn'];
const TREE_SHRUB = ['tree_shrub_care'];
const GENERAL_PEST = ['general_pest_quarterly', 'one_time_pest'];

// Ordered most-specific first: a "termite" or "rodent" cost guide is filed
// under pest-control, so the post's own keyword/title decides before the
// category does. Only the primary keyword and title are read.
const SERVICE_PRICE_KEYS = [
  { pattern: /\b(?:termites?|wdo)\b/, keys: TERMITE },
  { pattern: /\bbed ?bugs?\b/, keys: ['bed_bug_treatment'] },
  { pattern: /\bfleas?\b/, keys: ['flea_elimination'] },
  { pattern: /\b(?:wasps?|hornets?|yellow ?jackets?)\b/, keys: ['wasp_hornet_removal'] },
  { pattern: /\b(?:rodents?|rats?|mice|mouse)\b/, keys: ['rodent_bait_program', 'rodent_trapping', 'rodent_exclusion'] },
  { pattern: /\bmosquito(?:e?s)?\b/, keys: MOSQUITO },
  { pattern: /\b(?:lawns?|turf)\b/, keys: LAWN },
  { pattern: /\b(?:trees?|shrubs?)\b/, keys: TREE_SHRUB },
  { pattern: /\b(?:pests?|exterminat\w*)\b/, keys: GENERAL_PEST },
];

// Fallback when neither the keyword nor the title names a service.
const CATEGORY_PRICE_KEYS = {
  termite: TERMITE,
  mosquito: MOSQUITO,
  'lawn-care': LAWN,
  'tree-shrub': TREE_SHRUB,
  'pest-control': GENERAL_PEST,
};

function mappedKeys(frontmatter) {
  for (const field of [frontmatter.primary_keyword, frontmatter.title]) {
    const text = String(field || '').toLowerCase();
    if (!text) continue;
    const rule = SERVICE_PRICE_KEYS.find(({ pattern }) => pattern.test(text));
    if (rule) return rule.keys;
  }
  return CATEGORY_PRICE_KEYS[String(frontmatter.category || '').trim()] || [];
}

function publishedPriceKeys() {
  try {
    return new Set((computePublicPricingRanges().services || []).map((row) => row.key));
  } catch (err) {
    logger.warn(`[price-range] public pricing feed unavailable — cost guide ships without a price card: ${err.message}`);
    return new Set();
  }
}

// → the price_range list for a cost guide, or null (not a cost guide, no
// mapped service, or no mapped key the feed publishes).
function costGuidePriceRange(frontmatter = {}, { knownKeys } = {}) {
  if (String(frontmatter.post_type || '').trim() !== 'cost') return null;
  const keys = mappedKeys(frontmatter);
  if (!keys.length) return null;
  const known = knownKeys || publishedPriceKeys();
  const valid = keys.filter((key) => known.has(key));
  const dropped = keys.filter((key) => !known.has(key));
  if (dropped.length) {
    logger.warn(`[price-range] dropped price_range keys the public pricing feed does not publish: ${dropped.join(', ')}`);
  }
  return valid.length ? valid : null;
}

module.exports = { costGuidePriceRange, SERVICE_PRICE_KEYS, CATEGORY_PRICE_KEYS };
