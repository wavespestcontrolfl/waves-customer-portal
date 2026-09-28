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
 *     prices the service its primary keyword (else its title) names;
 *   - the keys come from the table below only — the writer model never
 *     chooses them, and a model-emitted price_range never reaches the
 *     published frontmatter (the autonomous normalizer whitelists fields);
 *   - every key is checked against the feed's own current key set, and a key
 *     the feed does not publish — or publishes only behind a purchase gate,
 *     which a frozen key would outlive — is dropped. No valid key → no
 *     price_range: fail closed to "no card", never to a broken hub build.
 * The post body stays free of dollar figures (HARDCODED_PRICE is unchanged);
 * the card's numbers come from the feed at Astro build time.
 */
const { computePublicPricingRanges, PURCHASE_GATED_ROWS } = require('../pricing-engine/public-ranges');
const logger = require('../logger');

// The card prices ONLY the service the post names. The primary keyword is
// the target intent and is matched on its own; the title is consulted only
// when the keyword names no service (never the two joined — a title aside
// must not outrank the keyword). There is no category fallback: a German-roach
// guide filed under pest-control must not show general pest plans. A post
// that names no row here gets no card. Commercial work is custom-quoted and
// the feed is residential list price, so a commercial topic gets none.
const COMMERCIAL = /\b(?:commercial|business(?:es)?|restaurants?|offices?|warehouses?)\b/;

const TERMITE = /\btermites?\b/;
const RODENT = /\b(?:rodents?|rats?|mice|mouse)\b/;
const GERMAN_ROACH = /\bgerman (?:cock)?roach(?:es)?\b/;
const MOSQUITO = /\bmosquito(?:e?s)?\b/;
const LAWN = /\b(?:lawns?|turf|grass)\b/;
const GENERAL_PEST = /\b(?:pest control|exterminat\w*)\b/;
const ONE_TIME = /\b(?:one[- ]?time|single[- ](?:visit|treatment|service)|one[- ]off)\b/;
const RECURRING = /\b(?:program|plans?|recurring|quarterly|monthly|bi-?monthly|seasonal|annual|yearly|subscriptions?|contracts?)\b/;

// A rule matches when ALL its patterns match one field. Every row the feed
// publishes on its own (a variant) is matched before ANY family rule, so a
// post naming "rodent exclusion" or "termite trenching" gets only that row —
// a family's full row set is the fallback for a post naming just the family.
// keys: [] marks a named service the feed has no honest row for (no card).
const RODENT_FAMILY = ['rodent_bait_program', 'rodent_trapping', 'rodent_exclusion'];
const VARIANT_RULES = [
  { match: [/\b(?:wdo|wood[- ]destroying)\b/], keys: ['wdo_inspection'] },
  // A standalone termite inspection is not the real-estate WDO report.
  { match: [TERMITE, /\binspections?\b/], keys: [] },
  // No rule for a purchase-gated row (termite_bond, termite_station_rental —
  // public-ranges PURCHASE_GATED_ROWS): the key would be frozen into the post
  // and outlive a gate flip. A bond or rental guide falls through to the
  // termite family's stable rows.
  { match: [TERMITE, /\bfoam\b/, RECURRING], keys: ['recurring_foam'] },
  { match: [TERMITE, /\bfoam\b/], keys: ['foam_drill'] },
  { match: [/\bpre[- ]?(?:slab|construction)\b/], keys: ['pre_slab_termiticide'] },
  { match: [/\b(?:bora[- ]?care|borates?)\b/], keys: ['bora_care'] },
  { match: [TERMITE, /\b(?:trench\w*|liquid|barriers?|soil treatments?)\b/], keys: ['termite_trenching'] },
  { match: [TERMITE, /\bmonitoring\b/], keys: ['termite_bait_monitoring'] },
  { match: [TERMITE, /\bbait/, /\binstall\w*/], keys: ['termite_bait_install'] },
  { match: [TERMITE, /\b(?:bait\w*|stations?)\b/], keys: ['termite_bait_install', 'termite_bait_monitoring'] },
  { match: [RODENT, /\binspections?\b/], keys: ['rodent_inspection'] },
  { match: [RODENT, /\b(?:guarantees?|warrant(?:y|ies))\b/], keys: ['rodent_guarantee'] },
  { match: [/\b(?:trap[- ]only|(?:rodent|rat) monitoring|rodent retainer)\b/], keys: ['trap_only_retainer'] },
  { match: [/\b(?:wire mesh|hardware cloth)\b/], keys: ['rodent_wire_mesh'] },
  { match: [/\b(?:bird ?box(?:es)?|roof[- ]entry)\b/], keys: ['rodent_bird_boxes'] },
  { match: [RODENT, /\b(?:sanitation|clean-?up|droppings|decontaminat\w*)\b/], keys: ['rodent_sanitation'] },
  { match: [RODENT, /\b(?:exclusion|proofing|seal\w*|entry points?)\b/], keys: ['rodent_exclusion'] },
  { match: [RODENT, /\btrap\w*/], keys: ['rodent_trapping'] },
  { match: [RODENT, /\bbait\w*/], keys: ['rodent_bait_program'] },
  { match: [GERMAN_ROACH, /\bclean-?outs?\b/], keys: ['german_roach_cleanout'] },
  { match: [GERMAN_ROACH, /\b(?:initial|3[- ]visit|three[- ]visit)\b/], keys: ['german_roach_initial'] },
  { match: [MOSQUITO, ONE_TIME], keys: ['one_time_mosquito'] },
  { match: [MOSQUITO, RECURRING], keys: ['mosquito_program'] },
  { match: [/\b(?:chinch bugs?|sod webworms?|armyworms?|grubs?|lawn (?:pests?|insects?))\b/], keys: ['lawn_pest_knockdown'] },
  { match: [/\bdethatch\w*/], keys: ['dethatching'] },
  { match: [/\b(?:plugging|(?:sod|grass|lawn) plugs?)\b/], keys: ['lawn_plugging'] },
  { match: [/\btop[- ]?dressing\b/], keys: ['top_dressing'] },
  { match: [LAWN, ONE_TIME], keys: ['one_time_lawn'] },
  { match: [LAWN, RECURRING], keys: ['lawn_care_program'] },
  // Palm / roof rats are rodents — classified before the palm-care rule.
  { match: [/\b(?:palm|roof) rats?\b/], keys: RODENT_FAMILY },
  { match: [/\bpalms?\b/, /\b(?:inject\w*|nutrition\w*|nutrients?|fertiliz\w*|health\w*|treatments?|care)\b/], keys: ['palm_injection'] },
];

const FAMILY_RULES = [
  { match: [TERMITE], keys: ['termite_bait_install', 'termite_bait_monitoring', 'termite_trenching'] },
  { match: [RODENT], keys: RODENT_FAMILY },
  { match: [GERMAN_ROACH], keys: ['german_roach_cleanout', 'german_roach_initial'] },
  { match: [/\b(?:(?:cock)?roach(?:es)?|palmetto bugs?)\b/], keys: ['cockroach_treatment'] },
  { match: [/\bbed ?bugs?\b/], keys: ['bed_bug_treatment'] },
  { match: [/\bfleas?\b/], keys: ['flea_elimination'] },
  { match: [/\b(?:wasps?|hornets?|yellow ?jackets?)\b/], keys: ['wasp_hornet_removal'] },
  { match: [MOSQUITO], keys: ['mosquito_program', 'one_time_mosquito'] },
  { match: [LAWN], keys: ['lawn_care_program', 'one_time_lawn'] },
  // Tree & shrub is a care program — a removal or trimming guide gets no card.
  { match: [/\b(?:trees?|shrubs?)\b/, /\b(?:care|fertiliz\w*|treatments?|programs?|plans?|spray\w*|insects?|diseases?|health\w*|nutrition\w*)\b/], keys: ['tree_shrub_care'] },
  // General pest is the catch-all, so its one-time / plan variants run only
  // after every named service's family: "one-time rat exterminator" is a
  // rodent guide, not a general pest one.
  { match: [GENERAL_PEST, ONE_TIME], keys: ['one_time_pest'] },
  { match: [GENERAL_PEST, RECURRING], keys: ['general_pest_quarterly'] },
  { match: [GENERAL_PEST], keys: ['general_pest_quarterly', 'one_time_pest'] },
];

const SERVICE_PRICE_KEYS = [...VARIANT_RULES, ...FAMILY_RULES];

function keysForText(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return null;
  return SERVICE_PRICE_KEYS.find(({ match }) => match.every((re) => re.test(text)))?.keys || null;
}

function mappedKeys(frontmatter) {
  if ([frontmatter.primary_keyword, frontmatter.title].some((v) => COMMERCIAL.test(String(v || '').toLowerCase()))) return [];
  return keysForText(frontmatter.primary_keyword) || keysForText(frontmatter.title) || [];
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
  const usable = (key) => known.has(key) && !PURCHASE_GATED_ROWS[key];
  const valid = keys.filter(usable);
  const dropped = keys.filter((key) => !usable(key));
  if (dropped.length) {
    logger.warn(`[price-range] dropped price_range keys the public pricing feed does not publish (or publishes only behind a purchase gate): ${dropped.join(', ')}`);
  }
  return valid.length ? valid : null;
}

// The ONE place a publish lane sets the card, called by every lane that
// writes a blog post (scheduled/admin publishAstro, autonomous
// publishOrUpdatePage, refresh) once it has read the live post. A
// price_range the live post already carries — owner-set, or an explicit []
// clearing it — is kept verbatim; otherwise a cost guide gets the mapped
// keys. Mutates and returns `frontmatter`.
function applyCostGuidePriceRange(frontmatter, liveFrontmatter = null) {
  const live = liveFrontmatter?.price_range;
  if (live != null) {
    frontmatter.price_range = live;
    return frontmatter;
  }
  delete frontmatter.price_range;
  const mapped = costGuidePriceRange(frontmatter);
  if (mapped) frontmatter.price_range = mapped;
  return frontmatter;
}

module.exports = { costGuidePriceRange, applyCostGuidePriceRange, SERVICE_PRICE_KEYS };
