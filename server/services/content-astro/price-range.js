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
 *     already enforces that type's required components), and the card
 *     prices the service its keyword/title names (table below);
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

// The card prices ONLY the service the post names — its primary keyword or
// title — so there is no category fallback (a German-roach guide filed under
// pest-control must not show general pest plans). Rows run most specific
// first: a product the feed prices on its own row (an inspection, a German
// roach cleanout, dethatching) wins over its service family's plan rows. A
// post that names no row here gets no card. Commercial work is custom-quoted
// and the feed is residential list price, so a commercial topic gets none.
const COMMERCIAL = /\b(?:commercial|business(?:es)?|restaurants?|offices?|warehouses?)\b/;
const SERVICE_PRICE_KEYS = [
  { pattern: /\b(?:wdo|wood[- ]destroying)\b/, keys: ['wdo_inspection'] },
  // A standalone termite inspection is its own service (not the real-estate
  // WDO report) and the feed has no row for it — no card, never bait prices.
  { pattern: /\btermite inspections?\b/, keys: [] },
  { pattern: /\btermite bonds?\b/, keys: ['termite_bond'] },
  { pattern: /\bpre[- ]?(?:slab|construction)\b/, keys: ['pre_slab_termiticide'] },
  { pattern: /\b(?:bora[- ]?care|borates?)\b/, keys: ['bora_care'] },
  { pattern: /\btermites?\b/, keys: ['termite_bait_install', 'termite_bait_monitoring', 'termite_trenching'] },
  { pattern: /\b(?:rodents?|rats?|mice|mouse) inspections?\b/, keys: ['rodent_inspection'] },
  { pattern: /\b(?:rodents?|rats?|mice|mouse) (?:sanitation|clean-?up|droppings)\b/, keys: ['rodent_sanitation'] },
  { pattern: /\b(?:rodents?|rats?|mice|mouse)\b/, keys: ['rodent_bait_program', 'rodent_trapping', 'rodent_exclusion'] },
  { pattern: /\bgerman (?:cock)?roach(?:es)?\b/, keys: ['german_roach_cleanout', 'german_roach_initial'] },
  { pattern: /\b(?:cock)?roach(?:es)?\b/, keys: ['cockroach_treatment'] },
  { pattern: /\bbed ?bugs?\b/, keys: ['bed_bug_treatment'] },
  { pattern: /\bfleas?\b/, keys: ['flea_elimination'] },
  { pattern: /\b(?:wasps?|hornets?|yellow ?jackets?)\b/, keys: ['wasp_hornet_removal'] },
  { pattern: /\bmosquito(?:e?s)?\b/, keys: ['mosquito_program', 'one_time_mosquito'] },
  { pattern: /\b(?:chinch bugs?|sod webworms?|armyworms?|lawn pests?)\b/, keys: ['lawn_pest_knockdown'] },
  { pattern: /\bdethatch\w*/, keys: ['dethatching'] },
  { pattern: /\b(?:plugging|sod plugs?)\b/, keys: ['lawn_plugging'] },
  { pattern: /\btop[- ]?dressing\b/, keys: ['top_dressing'] },
  { pattern: /\b(?:lawns?|turf)\b/, keys: ['lawn_care_program', 'one_time_lawn'] },
  { pattern: /\bpalms?\b/, keys: ['palm_injection'] },
  { pattern: /\b(?:trees?|shrubs?)\b/, keys: ['tree_shrub_care'] },
  { pattern: /\b(?:pest control|exterminat\w*)\b/, keys: ['general_pest_quarterly', 'one_time_pest'] },
];

function mappedKeys(frontmatter) {
  const text = [frontmatter.primary_keyword, frontmatter.title].map((v) => String(v || '')).join(' ').toLowerCase();
  if (COMMERCIAL.test(text)) return [];
  return SERVICE_PRICE_KEYS.find(({ pattern }) => pattern.test(text))?.keys || [];
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

module.exports = { costGuidePriceRange, SERVICE_PRICE_KEYS };
